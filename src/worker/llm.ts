import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createGroq } from "@ai-sdk/groq";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import recordedRuns from "../../demo/runs.json";
import type { DemoRow, Store } from "./db";
import type { Env } from "./env";
import { neonVisitorAllowed, visitorAllowed } from "./ratelimit";
import { sendGenerations, type Generation } from "./trace";

export const DEMO_BANNER = "Live AI quota reached, showing a recorded run";

export const MODELS = {
  "workers-ai": "@cf/google/gemma-4-26b-a4b-it",
  groq: "openai/gpt-oss-120b",
  openrouter: "openrouter/free",
} as const;

export type LiveSource = keyof typeof MODELS;
export type Source = LiveSource | "demo";

export interface Provider {
  name: LiveSource;
  model: string;
  /** False when the binding or key is missing: the provider is skipped silently. */
  available: boolean;
  generate(prompt: string, system?: string): Promise<string>;
}

export interface Attempt {
  provider: LiveSource;
  error: string;
}

export type LlmResult =
  | { kind: "limited" }
  | {
      kind: "answer";
      text: string;
      source: Source;
      model: string;
      banner?: string;
      /** For demo answers: the recorded example input that was served. */
      example?: string;
      attempts: Attempt[];
    };

export interface LlmContext {
  env: Env;
  store: Store | null;
  visitor: string;
  providers?: Provider[];
  system?: string;
  now?: Date;
  /** Fallback recorded runs when demo_cache cannot be read (default: bundled demo/runs.json). */
  demoRuns?: DemoRow[];
  /** Test seam for HTTP providers (Groq, OpenRouter) and the Langfuse export. */
  fetch?: typeof globalThis.fetch;
  /** The Worker's ctx.waitUntil: the Langfuse export and the visitor_hits prune run after the response.
   *  Without it llm() awaits them. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Test seam for the 1% visitor_hits prune draw (default Math.random). */
  random?: () => number;
}

const MAX_OUTPUT_TOKENS = 800;

/** The free provider chain in AD-7 order. A missing key or binding leaves that provider unavailable. */
export function defaultProviders(env: Env, fetchImpl?: typeof globalThis.fetch): Provider[] {
  const run = async (model: Parameters<typeof generateText>[0]["model"], prompt: string, system?: string) => {
    const result = await generateText({ model, prompt, system, maxRetries: 0, maxOutputTokens: MAX_OUTPUT_TOKENS });
    if (!result.text.trim()) throw new Error("empty answer");
    return result.text;
  };
  return [
    {
      name: "workers-ai",
      model: MODELS["workers-ai"],
      available: Boolean(env.AI),
      generate: (prompt, system) => {
        const workersai = createWorkersAI({
          binding: env.AI as Ai,
          ...(env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : {}),
        });
        return run(workersai(MODELS["workers-ai"]), prompt, system);
      },
    },
    {
      name: "groq",
      model: MODELS.groq,
      available: Boolean(env.GROQ_API_KEY),
      generate: (prompt, system) => {
        const groq = createGroq({ apiKey: env.GROQ_API_KEY, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
        return run(groq(MODELS.groq), prompt, system);
      },
    },
    {
      name: "openrouter",
      model: MODELS.openrouter,
      available: Boolean(env.OPENROUTER_API_KEY),
      generate: (prompt, system) => {
        const openrouter = createOpenRouter({
          apiKey: env.OPENROUTER_API_KEY,
          ...(fetchImpl ? { fetch: fetchImpl } : {}),
        });
        return run(openrouter(MODELS.openrouter), prompt, system);
      },
    },
  ];
}

export function dailyCap(env: Env): number {
  const n = Number.parseInt(env.DAILY_LLM_CAP ?? "", 10);
  return Number.isFinite(n) ? n : 200;
}

/**
 * Every LLM call in a Project goes through here (AD-7):
 * 1. per-visitor rate limit: the Workers Rate Limiting binding, then the Neon visitor_hits limiter
 *    (the binding did not enforce on Workers Free, 2026-10-20; both fail open),
 * 2. per-Project daily counter in Neon (fails closed),
 * 3. Workers AI, 4. Groq, 5. OpenRouter, 6. demo mode from demo_cache.
 * It never bills: with no card on any vendor, a limit can only error, and errors fall through.
 */
export async function llm(prompt: string, ctx: LlmContext): Promise<LlmResult> {
  if (!(await visitorAllowed(ctx.env, ctx.visitor))) return { kind: "limited" };
  if (!(await neonVisitorAllowed(ctx.env, ctx.store, ctx.visitor, { random: ctx.random, waitUntil: ctx.waitUntil }))) {
    return { kind: "limited" };
  }

  const attempts: Attempt[] = [];
  const day = (ctx.now ?? new Date()).toISOString().slice(0, 10);
  // No database, or a database error, fails closed to demo mode: the counter is what keeps spend at $0.
  const reserved = ctx.store ? await ctx.store.reserveCall(day, dailyCap(ctx.env)).catch(() => false) : false;
  if (!reserved) return demoAnswer(prompt, ctx.store, attempts, ctx.demoRuns);

  const providers = ctx.providers ?? defaultProviders(ctx.env, ctx.fetch);
  const generations: Generation[] = [];
  for (const provider of providers) {
    if (!provider.available) continue;
    const startedAt = new Date();
    try {
      const text = await provider.generate(prompt, ctx.system);
      generations.push({ provider: provider.name, model: provider.model, ok: true, input: prompt, output: text, startedAt, endedAt: new Date() });
      await trace(ctx, generations);
      return { kind: "answer", text, source: provider.name, model: provider.model, attempts };
    } catch (error) {
      const message = describeError(error);
      attempts.push({ provider: provider.name, error: message });
      generations.push({ provider: provider.name, model: provider.model, ok: false, error: message, input: prompt, startedAt, endedAt: new Date() });
    }
  }
  await trace(ctx, generations);
  return demoAnswer(prompt, ctx.store, attempts, ctx.demoRuns);
}

/** One Langfuse generation per attempt (story 3.17); a no-op without Langfuse keys, never throws. */
async function trace(ctx: LlmContext, generations: Generation[]): Promise<void> {
  if (generations.length === 0) return;
  const sending = sendGenerations(ctx.env, generations, ctx.fetch).catch(() => false);
  if (ctx.waitUntil) ctx.waitUntil(sending);
  else await sending;
}

export async function loadDemoRows(store: Store | null, bundled: DemoRow[] = recordedRuns as DemoRow[]): Promise<DemoRow[]> {
  const rows = store ? await store.demoRows().catch(() => [] as DemoRow[]) : [];
  return rows.length > 0 ? rows : bundled;
}

export const NO_RUNS_TEXT = "No recorded runs yet";

async function demoAnswer(prompt: string, store: Store | null, attempts: Attempt[], bundled?: DemoRow[]): Promise<LlmResult> {
  const rows = await loadDemoRows(store, bundled);
  if (rows.length === 0) {
    return { kind: "answer", text: NO_RUNS_TEXT, source: "demo", model: "none", banner: DEMO_BANNER, attempts };
  }
  const row = closestRow(prompt, rows);
  return {
    kind: "answer",
    text: row.output,
    source: "demo",
    model: row.model,
    banner: DEMO_BANNER,
    example: row.input,
    attempts,
  };
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Exact match first, then the most word overlap (Jaccard). Ties keep the earlier row. */
export function closestRow(prompt: string, rows: DemoRow[]): DemoRow {
  if (rows.length === 0) throw new Error("no recorded runs: demo/runs.json is empty");
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const exact = rows.find((r) => norm(r.input) === norm(prompt));
  if (exact) return exact;
  const want = tokens(prompt);
  let best = rows[0];
  let bestScore = -1;
  for (const row of rows) {
    const have = tokens(row.input);
    const shared = [...want].filter((t) => have.has(t)).length;
    const union = new Set([...want, ...have]).size || 1;
    const score = shared / union;
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}

function describeError(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { statusCode?: number; status?: number; message?: string };
    const status = e.statusCode ?? e.status;
    const message = (e.message ?? String(error)).slice(0, 200);
    return status ? `${status} ${message}` : message;
  }
  return String(error).slice(0, 200);
}
