import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/worker/index";
import { visitorKey } from "../src/worker/ratelimit";
import { allowAll, denyAll, env, fakeAI, fakeStore } from "./fakes";

function post(app: ReturnType<typeof createApp>, e: ReturnType<typeof env>, body: unknown) {
  return app.request(
    "/api/ask",
    { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" } },
    e,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("visitor keys", () => {
  const req = (ip: string) => new Request("https://x/", { headers: { "cf-connecting-ip": ip } });

  it("are an HMAC with the pepper, not a plain SHA-256 of the IP", async () => {
    const k = await visitorKey(req("203.0.113.7"), "pepper-a");
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(k).toBe(await visitorKey(req("203.0.113.7"), "pepper-a"));
    expect(k).not.toBe(await visitorKey(req("203.0.113.7"), "pepper-b"));
    for (const plain of ["203.0.113.7", "visitor:203.0.113.7"]) {
      expect(createHash("sha256").update(plain).digest("hex")).not.toContain(k);
    }
  });

  it("differ per IP, and stay stable within an isolate without a pepper", async () => {
    expect(await visitorKey(req("203.0.113.7"))).toBe(await visitorKey(req("203.0.113.7")));
    expect(await visitorKey(req("203.0.113.7"), "p")).not.toBe(await visitorKey(req("203.0.113.8"), "p"));
  });
});

describe("routes", () => {
  it("visitor over the rate limit: HTTP 429 {error: 'slow down'}", async () => {
    const app = createApp({ store: () => fakeStore() });
    const res = await post(app, env({ AI: fakeAI("ok"), VISITOR_LIMIT: denyAll }), { prompt: "hi" });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "slow down" });
  });

  it("POST /api/ask answers live and saves the visitor's submission under a hashed key", async () => {
    const store = fakeStore();
    const app = createApp({ store: () => store });
    const res = await post(app, env({ AI: fakeAI("ok"), VISITOR_LIMIT: allowAll }), { prompt: "hi" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ source: "workers-ai", text: "live answer from workers ai" });
    expect(body).not.toHaveProperty("attempts");
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0].visitor).toMatch(/^[0-9a-f]{32}$/);
    expect(store.saved[0].visitor).not.toContain("203.0.113.7");
  });

  it("POST /api/ask rejects a bad body", async () => {
    const app = createApp({ store: () => fakeStore() });
    const res = await post(app, env(), { nope: 1 });
    expect(res.status).toBe(400);
  });

  it("demo answers carry the banner", async () => {
    const app = createApp({ store: () => fakeStore({ calls: 1 }) });
    const res = await post(app, env({ AI: fakeAI("ok"), DAILY_LLM_CAP: "1" }), { prompt: "shipping reply" });
    expect(await res.json()).toMatchObject({ source: "demo", banner: "Live AI quota reached, showing a recorded run" });
  });

  it("GET /health with the database up: {ok: true, db: true, sha} 200", async () => {
    const app = createApp({ store: () => fakeStore() });
    const res = await app.request("/health", {}, env());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: true, sha: "abc1234" });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("GET /health caches the database status for 30 s per isolate", async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const ping = vi.spyOn(store, "ping");
    const app = createApp({ store: () => store });
    await app.request("/health", {}, env());
    await app.request("/health", {}, env());
    expect(ping).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    await app.request("/health", {}, env());
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("GET /health whose ping never settles answers db false after 3 s", async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    store.ping = () => new Promise<boolean>(() => {});
    const app = createApp({ store: () => store });
    const pending = app.request("/health", {}, env());
    await vi.advanceTimersByTimeAsync(3000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, db: false, sha: "abc1234" });
  });

  it("GET /health with the database down: still 200, ok false", async () => {
    const app = createApp({ store: () => fakeStore({ dbUp: false }) });
    const res = await app.request("/health", {}, env());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, db: false, sha: "abc1234" });
  });

  it("GET /health with no DATABASE_URL at all: 200, ok false", async () => {
    const app = createApp();
    const res = await app.request("/api/health", {}, env());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, db: false });
  });

  it("GET /api/examples lists recorded inputs, falling back to demo/runs.json", async () => {
    const res = await createApp({ store: () => null }).request("/api/examples", {}, env());
    const body = (await res.json()) as { examples: string[] };
    expect(Array.isArray(body.examples)).toBe(true);
    expect(body.examples.length).toBeGreaterThan(0);
  });

  it("unknown /api route is a JSON 404", async () => {
    const res = await createApp().request("/api/nope", {}, env());
    expect(res.status).toBe(404);
  });
});
