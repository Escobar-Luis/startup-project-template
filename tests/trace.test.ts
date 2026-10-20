import { describe, expect, it, vi } from "vitest";
import { llm } from "../src/worker/llm";
import { otlpGenerations, sendGenerations } from "../src/worker/trace";
import { env, fakeAI, fakeFetch, fakeStore } from "./fakes";

const NOW = new Date("2026-10-19T12:00:00Z");
const KEYS = { LANGFUSE_PUBLIC_KEY: "pk-lf-test", LANGFUSE_SECRET_KEY: "sk-lf-test", LANGFUSE_HOST: "https://lf.example.test", PROJECT_REPO: "Escobar-Luis/acme-ai-triage" };

/** Groq/OpenRouter from fakeFetch; Langfuse answers `langfuse` (a status per call, the last one repeats). */
function withLangfuse(plan: Parameters<typeof fakeFetch>[0], langfuse: number[] = [200]) {
  const providers = fakeFetch(plan);
  const statuses = [...langfuse];
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("lf.example.test")) {
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
      return new Response("{}", { status });
    }
    return providers(input, init);
  });
}

const langfuseCalls = (fetch: ReturnType<typeof withLangfuse>) => fetch.mock.calls.filter((c) => String(c[0]).includes("lf.example.test"));

describe("llm() Langfuse generations (story 3.17)", () => {
  it("no keys: no Langfuse request", async () => {
    const fetch = withLangfuse({ groq: "ok" });
    const r = await llm("hello", { env: env({ AI: fakeAI("429"), GROQ_API_KEY: "g" }), store: fakeStore(), visitor: "v", now: NOW, fetch });
    expect(r).toMatchObject({ source: "groq" });
    expect(langfuseCalls(fetch)).toHaveLength(0);
  });

  it("keys: one OTLP export with a generation per attempt, tagged project:<repo>", async () => {
    const fetch = withLangfuse({ groq: "ok" });
    const r = await llm("hello", { env: env({ AI: fakeAI("429"), GROQ_API_KEY: "g", ...KEYS }), store: fakeStore(), visitor: "v", now: NOW, fetch });
    expect(r).toMatchObject({ source: "groq", text: "live answer from groq" });
    const calls = langfuseCalls(fetch);
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toBe("https://lf.example.test/api/public/otel/v1/traces");
    const headers = calls[0][1]!.headers as Record<string, string>;
    expect(headers["x-langfuse-ingestion-version"]).toBe("4");
    expect(headers.authorization).toBe(`Basic ${btoa("pk-lf-test:sk-lf-test")}`);
    const spans = JSON.parse(String(calls[0][1]!.body)).resourceSpans[0].scopeSpans[0].spans;
    expect(spans.map((s: { name: string }) => s.name)).toEqual(["llm:workers-ai", "llm:groq"]);
    expect(new Set(spans.map((s: { traceId: string }) => s.traceId)).size).toBe(1);
    const attrs = (s: { attributes: { key: string; value: Record<string, unknown> }[] }) =>
      Object.fromEntries(s.attributes.map((a) => [a.key, a.value]));
    expect(attrs(spans[1])["langfuse.trace.tags"]).toEqual({ arrayValue: { values: [{ stringValue: "project:Escobar-Luis/acme-ai-triage" }] } });
    expect(attrs(spans[1])["langfuse.observation.type"]).toEqual({ stringValue: "generation" });
    expect(attrs(spans[1])["langfuse.observation.model.name"]).toEqual({ stringValue: "openai/gpt-oss-120b" });
    expect(attrs(spans[0])["langfuse.observation.level"]).toEqual({ stringValue: "ERROR" });
    expect(JSON.stringify(spans)).not.toContain("sk-lf-test");
  });

  it("Langfuse down: one retry, and the answer is unchanged", async () => {
    const fetch = withLangfuse({ groq: "ok" }, [500]);
    const r = await llm("hello", { env: env({ GROQ_API_KEY: "g", ...KEYS }), store: fakeStore(), visitor: "v", now: NOW, fetch });
    expect(r).toMatchObject({ source: "groq" });
    expect(langfuseCalls(fetch)).toHaveLength(2);
  });

  it("a 4xx is not retried; a thrown fetch is swallowed", async () => {
    const gens = [{ provider: "groq", model: "m", ok: true, input: "i", output: "o", startedAt: NOW, endedAt: NOW }];
    const four = vi.fn(async () => new Response("{}", { status: 401 }));
    expect(await sendGenerations(env(KEYS), gens, four)).toBe(false);
    expect(four).toHaveBeenCalledTimes(1);
    const boom = vi.fn(async () => {
      throw new Error("network");
    });
    expect(await sendGenerations(env(KEYS), gens, boom)).toBe(false);
    expect(boom).toHaveBeenCalledTimes(2);
  });

  it("with waitUntil the export runs after the answer", async () => {
    const fetch = withLangfuse({ groq: "ok" });
    const waitUntil = vi.fn();
    await llm("hello", { env: env({ GROQ_API_KEY: "g", ...KEYS }), store: fakeStore(), visitor: "v", now: NOW, fetch, waitUntil });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];
    expect(langfuseCalls(fetch)).toHaveLength(1);
  });

  it("demo mode at the daily cap makes no generation", async () => {
    const fetch = withLangfuse({ groq: "ok" });
    await llm("hello", { env: env({ DAILY_LLM_CAP: "0", GROQ_API_KEY: "g", ...KEYS }), store: fakeStore(), visitor: "v", now: NOW, fetch });
    expect(langfuseCalls(fetch)).toHaveLength(0);
  });

  it("OTLP ids are hex of the right length and long texts are cut", () => {
    const body = otlpGenerations(env(KEYS), [{ provider: "groq", model: "m", ok: true, input: "x".repeat(5000), output: "y", startedAt: NOW, endedAt: NOW }]);
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.startTimeUnixNano).toBe(`${NOW.getTime()}000000`);
    const input = span.attributes.find((a) => a.key === "langfuse.observation.input")!.value as { stringValue: string };
    expect(input.stringValue).toHaveLength(2000);
  });
});
