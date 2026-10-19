import { Hono } from "hono";
import { z } from "zod";
import { neonStore, type Store } from "./db";
import type { Env } from "./env";
import { llm, loadDemoRows, type Provider } from "./llm";
import { visitorKey } from "./ratelimit";

export interface AppDeps {
  store?: (env: Env) => Store | null;
  providers?: (env: Env) => Provider[] | undefined;
}

const askBody = z.object({ prompt: z.string().trim().min(1).max(2000) });

const HEALTH_DB_TIMEOUT_MS = 3000;
// Cache the database status per isolate so polling /health does not keep Neon awake.
export const HEALTH_CACHE_MS = 30_000;

export function createApp(deps: AppDeps = {}) {
  const getStore = deps.store ?? neonStore;
  const app = new Hono<{ Bindings: Env }>();
  let healthCache: { db: boolean; at: number } | undefined;

  const dbStatus = async (env: Env): Promise<boolean> => {
    if (healthCache && Date.now() - healthCache.at < HEALTH_CACHE_MS) return healthCache.db;
    const store = getStore(env);
    let db = false;
    if (store) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), HEALTH_DB_TIMEOUT_MS);
      });
      db = await Promise.race([store.ping().catch(() => false), timeout]);
      clearTimeout(timer);
    }
    healthCache = { db, at: Date.now() };
    return db;
  };

  const health = async (c: { env: Env; json: (body: unknown, status?: number, headers?: Record<string, string>) => Response }) => {
    const db = await dbStatus(c.env);
    // Always 200, so the Pages front and the Quality Gate can read why it is not ok.
    return c.json({ ok: db, db, sha: c.env.GIT_SHA ?? "dev" }, 200, {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    });
  };
  app.get("/health", (c) => health(c));
  app.get("/api/health", (c) => health(c));

  app.post("/api/ask", async (c) => {
    const parsed = askBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "send {prompt: string} of 1-2000 characters" }, 400);
    const store = getStore(c.env);
    const visitor = await visitorKey(c.req.raw, c.env.VISITOR_PEPPER);
    const result = await llm(parsed.data.prompt, {
      env: c.env,
      store,
      visitor,
      providers: deps.providers?.(c.env),
    });
    if (result.kind === "limited") return c.json({ error: "slow down" }, 429);
    if (store) {
      const save = store.saveSubmission(visitor, parsed.data.prompt, result.text, result.source).catch(() => undefined);
      try {
        c.executionCtx.waitUntil(save);
      } catch {
        await save; // no execution context outside the Workers runtime (tests)
      }
    }
    const { attempts: _attempts, kind: _kind, ...answer } = result;
    return c.json(answer);
  });

  app.get("/api/examples", async (c) => {
    const rows = await loadDemoRows(getStore(c.env));
    return c.json({ examples: rows.map((r) => r.input) });
  });

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  return app;
}

export default createApp();
