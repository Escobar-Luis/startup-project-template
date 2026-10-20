import { vi } from "vitest";
import type { DemoRow, Store } from "../src/worker/db";
import type { Env } from "../src/worker/env";

export const DEMO_ROWS: DemoRow[] = [
  { input: "Summarize this support ticket about a late refund", output: "Recorded: refund summary", model: "@cf/google/gemma-4-26b-a4b-it" },
  { input: "Draft a reply to a customer asking about shipping times", output: "Recorded: shipping reply", model: "openai/gpt-oss-120b" },
  { input: "Classify this lead by company size", output: "Recorded: lead class", model: "@cf/google/gemma-4-26b-a4b-it" },
];

export function fakeStore(opts: { calls?: number; rows?: DemoRow[]; dbUp?: boolean; hitsDown?: boolean } = {}) {
  const usage = new Map<string, number>();
  /** visitor -> hits in the current window (the fake has one window). */
  const hits = new Map<string, number>();
  let prunes = 0;
  const saved: { visitor: string; input: string; source: string }[] = [];
  let preset = opts.calls;
  const store: Store & { usage: Map<string, number>; saved: typeof saved; hits: Map<string, number>; prunes: () => number } = {
    usage,
    saved,
    hits,
    prunes: () => prunes,
    async hitVisitor(visitor, limit) {
      if (opts.dbUp === false || opts.hitsDown) throw new Error("db down");
      const n = hits.get(visitor) ?? 0;
      if (limit <= 0 || n >= limit) return false;
      hits.set(visitor, n + 1);
      return true;
    },
    async pruneVisitorHits() {
      if (opts.dbUp === false || opts.hitsDown) throw new Error("db down");
      prunes++;
      return 0;
    },
    async reserveCall(day, cap) {
      if (preset !== undefined) {
        usage.set(day, preset);
        preset = undefined;
      }
      const n = usage.get(day) ?? 0;
      if (cap <= 0 || n >= cap) return false;
      usage.set(day, n + 1);
      return true;
    },
    async demoRows() {
      if (opts.dbUp === false) throw new Error("db down");
      return opts.rows ?? DEMO_ROWS;
    },
    async saveSubmission(visitor, input, _output, source) {
      saved.push({ visitor, input, source });
    },
    async ping() {
      if (opts.dbUp === false) throw new Error("db down");
      return true;
    },
  };
  return store;
}

/** A Workers AI binding whose run() answers or throws like the real binding on quota errors. */
export function fakeAI(behavior: "ok" | "429", text = "live answer from workers ai") {
  const run = vi.fn(async (..._args: unknown[]) => {
    if (behavior === "429") {
      const err = new Error("3036: Account limited: you have used up your daily free allocation of 10,000 neurons");
      (err as Error & { status: number }).status = 429;
      throw err;
    }
    return {
      response: text,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    };
  });
  return { run } as unknown as Ai & { run: typeof run };
}

export type FetchPlan = Record<"groq" | "openrouter", "ok" | "429">;

/** fetch for Groq and OpenRouter: OpenAI-style chat completions, or a 429. */
export function fakeFetch(plan: Partial<FetchPlan>) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const who = url.includes("groq.com") ? "groq" : url.includes("openrouter.ai") ? "openrouter" : "other";
    const mode = who === "other" ? "429" : (plan[who] ?? "429");
    if (mode === "429") {
      return new Response(JSON.stringify({ error: { message: "rate limit reached", type: "rate_limit" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "30" },
      });
    }
    return new Response(
      JSON.stringify({
        id: "cmpl-1",
        object: "chat.completion",
        created: 1792447934,
        model: who === "groq" ? "openai/gpt-oss-120b" : "openrouter/free",
        choices: [{ index: 0, message: { role: "assistant", content: `live answer from ${who}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

export function env(overrides: Partial<Env> = {}): Env {
  return { DAILY_LLM_CAP: "200", GIT_SHA: "abc1234", ...overrides };
}

export const allowAll = { limit: vi.fn(async () => ({ success: true })) };
export const denyAll = { limit: vi.fn(async () => ({ success: false })) };
