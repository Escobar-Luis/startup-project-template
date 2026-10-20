import type { Env } from "./env";

/**
 * Langfuse generations for llm() (ai-engineering-journey story 3.17, AD-14).
 *
 * One trace per llm() call, one generation per provider attempt, tagged `project:<repo>`. Sent as OTLP/HTTP JSON
 * to `{host}/api/public/otel/v1/traces` with `x-langfuse-ingestion-version: 4`
 * (https://langfuse.com/integrations/native/opentelemetry). Plain fetch keeps it small on Workers; the older
 * `/api/public/ingestion` batch endpoint is deprecated and sunset on Langfuse Cloud on 2026-11-16
 * (https://langfuse.com/docs/api-and-data-platform/features/public-api), so it is not used.
 *
 * No LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY: a no-op that makes no request. Every request has a 5 s timeout
 * and one retry; a failure is swallowed, so tracing never changes an answer.
 */

export const LANGFUSE_DEFAULT_HOST = "https://cloud.langfuse.com";
export const TRACE_TIMEOUT_MS = 5000;
const TEXT_MAX = 2000;

export interface Generation {
  provider: string;
  model: string;
  ok: boolean;
  error?: string;
  input: string;
  output?: string;
  startedAt: Date;
  endedAt: Date;
}

export function tracingEnabled(env: Env): boolean {
  return Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
}

export function projectTag(env: Env): string {
  return `project:${env.PROJECT_REPO || "unknown"}`;
}

function hex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type AttrValue = string | number | boolean | string[];

function attr(key: string, value: AttrValue) {
  if (Array.isArray(value)) return { key, value: { arrayValue: { values: value.map((v) => ({ stringValue: v })) } } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") return { key, value: { intValue: String(Math.trunc(value)) } };
  return { key, value: { stringValue: value } };
}

const nanos = (d: Date) => `${BigInt(d.getTime()) * 1_000_000n}`;

/** ExportTraceServiceRequest (OTLP JSON): one trace, one generation span per attempt. */
export function otlpGenerations(env: Env, gens: Generation[], traceId = hex(16)) {
  const tag = projectTag(env);
  const spans = gens.map((g) => ({
    traceId,
    spanId: hex(8),
    name: `llm:${g.provider}`,
    kind: 3, // CLIENT
    startTimeUnixNano: nanos(g.startedAt),
    endTimeUnixNano: nanos(g.endedAt),
    status: g.ok ? { code: 1 } : { code: 2, message: (g.error ?? "error").slice(0, 200) },
    attributes: [
      attr("langfuse.trace.name", tag),
      attr("langfuse.trace.tags", [tag]),
      attr("langfuse.session.id", tag),
      attr("langfuse.observation.type", "generation"),
      attr("langfuse.observation.model.name", g.model),
      attr("langfuse.observation.input", g.input.slice(0, TEXT_MAX)),
      ...(g.output !== undefined ? [attr("langfuse.observation.output", g.output.slice(0, TEXT_MAX))] : []),
      ...(g.ok ? [] : [attr("langfuse.observation.level", "ERROR"), attr("langfuse.observation.status_message", (g.error ?? "").slice(0, 200))]),
      attr("langfuse.observation.metadata.provider", g.provider),
      attr("langfuse.environment", "production"),
      ...(env.GIT_SHA ? [attr("langfuse.release", env.GIT_SHA)] : []),
    ],
  }));
  return {
    resourceSpans: [
      {
        resource: { attributes: [attr("service.name", tag)] },
        scopeSpans: [{ scope: { name: "src/worker/trace.ts" }, spans }],
      },
    ],
  };
}

/** Send the attempts of one llm() call. Never throws; resolves false when nothing was accepted. */
export async function sendGenerations(env: Env, gens: Generation[], fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<boolean> {
  if (!tracingEnabled(env) || gens.length === 0) return false;
  const host = (env.LANGFUSE_HOST || LANGFUSE_DEFAULT_HOST).replace(/\/+$/, "");
  const init: RequestInit = {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`)}`,
      "content-type": "application/json",
      "x-langfuse-ingestion-version": "4",
    },
    body: JSON.stringify(otlpGenerations(env, gens)),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(`${host}/api/public/otel/v1/traces`, { ...init, signal: AbortSignal.timeout(TRACE_TIMEOUT_MS) });
      if (res.ok) return true;
      if (res.status !== 429 && res.status < 500) return false; // a 4xx will not get better on retry
    } catch {
      // network error or timeout: one retry
    }
  }
  return false;
}
