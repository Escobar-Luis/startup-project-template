import { describe, expect, it } from "vitest";
import { DEMO_BANNER, closestRow, defaultProviders, llm } from "../src/worker/llm";
import { DEMO_ROWS, allowAll, denyAll, env, fakeAI, fakeFetch, fakeStore } from "./fakes";

const NOW = new Date("2026-10-19T12:00:00Z");
const DAY = "2026-10-19";

describe("llm() chain (AD-7)", () => {
  it("Workers AI answers: source workers-ai and the counter goes up by one", async () => {
    const store = fakeStore();
    const AI = fakeAI("ok");
    const fetch = fakeFetch({});
    const r = await llm("hello", { env: env({ AI, VISITOR_LIMIT: allowAll, GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o" }), store, visitor: "v", now: NOW, fetch });
    expect(r).toMatchObject({ kind: "answer", source: "workers-ai", text: "live answer from workers ai", model: "@cf/google/gemma-4-26b-a4b-it" });
    expect(store.usage.get(DAY)).toBe(1);
    expect(AI.run).toHaveBeenCalledTimes(1);
    expect(AI.run.mock.calls[0][0]).toBe("@cf/google/gemma-4-26b-a4b-it");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Workers AI 429: Groq is tried next", async () => {
    const fetch = fakeFetch({ groq: "ok" });
    const r = await llm("hello", { env: env({ AI: fakeAI("429"), GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o" }), store: fakeStore(), visitor: "v", now: NOW, fetch });
    expect(r).toMatchObject({ kind: "answer", source: "groq", text: "live answer from groq", model: "openai/gpt-oss-120b" });
    expect(String(fetch.mock.calls[0][0])).toContain("api.groq.com");
    if (r.kind === "answer") expect(r.attempts.map((a) => a.provider)).toEqual(["workers-ai"]);
  });

  it("Groq 429: OpenRouter openrouter/free is tried next", async () => {
    const fetch = fakeFetch({ groq: "429", openrouter: "ok" });
    const r = await llm("hello", { env: env({ AI: fakeAI("429"), GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o" }), store: fakeStore(), visitor: "v", now: NOW, fetch });
    expect(r).toMatchObject({ source: "openrouter", text: "live answer from openrouter" });
    const body = JSON.parse(String(fetch.mock.calls.at(-1)![1]!.body));
    expect(body.model).toBe("openrouter/free");
  });

  it("all providers 429: closest demo_cache row, source demo, banner set", async () => {
    const fetch = fakeFetch({ groq: "429", openrouter: "429" });
    const r = await llm("please draft a customer reply about shipping", {
      env: env({ AI: fakeAI("429"), GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o" }),
      store: fakeStore(),
      visitor: "v",
      now: NOW,
      fetch,
    });
    expect(r).toMatchObject({ kind: "answer", source: "demo", banner: DEMO_BANNER, text: "Recorded: shipping reply" });
    expect(DEMO_BANNER).toBe("Live AI quota reached, showing a recorded run");
    if (r.kind === "answer") {
      expect(r.attempts.map((a) => a.provider)).toEqual(["workers-ai", "groq", "openrouter"]);
      expect(r.attempts.every((a) => a.error.includes("429") || a.error.includes("rate limit") || a.error.includes("3036"))).toBe(true);
    }
  });

  it("daily counter at cap: demo mode without calling any provider", async () => {
    const AI = fakeAI("ok");
    const fetch = fakeFetch({ groq: "ok", openrouter: "ok" });
    const store = fakeStore({ calls: 5 });
    const r = await llm("hello", { env: env({ AI, DAILY_LLM_CAP: "5", GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o" }), store, visitor: "v", now: NOW, fetch });
    expect(r).toMatchObject({ source: "demo", banner: DEMO_BANNER });
    expect(AI.run).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(store.usage.get(DAY)).toBe(5);
  });

  it("visitor over the rate limit: limited, nothing else runs", async () => {
    const AI = fakeAI("ok");
    const store = fakeStore();
    const r = await llm("hello", { env: env({ AI, VISITOR_LIMIT: denyAll }), store, visitor: "v", now: NOW });
    expect(r).toEqual({ kind: "limited" });
    expect(AI.run).not.toHaveBeenCalled();
    expect(store.usage.size).toBe(0);
  });

  it("missing GROQ_API_KEY: Groq is skipped silently", async () => {
    const fetch = fakeFetch({ groq: "ok", openrouter: "ok" });
    const r = await llm("hello", { env: env({ AI: fakeAI("429"), OPENROUTER_API_KEY: "o" }), store: fakeStore(), visitor: "v", now: NOW, fetch });
    expect(r).toMatchObject({ source: "openrouter" });
    expect(fetch.mock.calls.some((c) => String(c[0]).includes("groq.com"))).toBe(false);
    if (r.kind === "answer") expect(r.attempts.map((a) => a.provider)).toEqual(["workers-ai"]);
  });

  it("no keys and no AI binding: all skipped, demo mode", async () => {
    const r = await llm("hello", { env: env(), store: fakeStore(), visitor: "v", now: NOW });
    expect(r).toMatchObject({ source: "demo", banner: DEMO_BANNER });
    if (r.kind === "answer") expect(r.attempts).toEqual([]);
  });

  it("no database: fails closed to the bundled demo/runs.json", async () => {
    const AI = fakeAI("ok");
    const r = await llm("hello", { env: env({ AI }), store: null, visitor: "v", now: NOW });
    expect(r).toMatchObject({ source: "demo", banner: DEMO_BANNER });
    expect(AI.run).not.toHaveBeenCalled();
  });

  it("provider order is Workers AI, Groq, OpenRouter", () => {
    expect(defaultProviders(env()).map((p) => [p.name, p.model])).toEqual([
      ["workers-ai", "@cf/google/gemma-4-26b-a4b-it"],
      ["groq", "openai/gpt-oss-120b"],
      ["openrouter", "openrouter/free"],
    ]);
  });
});

describe("closestRow", () => {
  it("prefers an exact match, then the most word overlap", () => {
    expect(closestRow("classify this lead by company size", DEMO_ROWS).output).toBe("Recorded: lead class");
    expect(closestRow("late refund ticket", DEMO_ROWS).output).toBe("Recorded: refund summary");
    expect(closestRow("zzz", DEMO_ROWS).output).toBe("Recorded: refund summary");
  });
});

