import type { Store } from "./db";
import type { Env } from "./env";

/** Per-visitor limit through the Workers Rate Limiting binding (AD-7 step 1).
 *  No binding, or a binding call that throws, means allowed: the daily counter still caps spend.
 *  The 2026-10-20 smoke test showed it does not enforce on Workers Free; neonVisitorAllowed is the real guard. */
export async function visitorAllowed(env: Env, visitorKey: string): Promise<boolean> {
  if (!env.VISITOR_LIMIT) return true;
  try {
    const { success } = await env.VISITOR_LIMIT.limit({ key: visitorKey });
    return success;
  } catch {
    return true;
  }
}

export const DEFAULT_VISITOR_LIMIT_PER_MIN = 20;
/** Share of calls that also prune visitor_hits windows older than an hour. */
export const PRUNE_RATE = 0.01;

export function visitorLimitPerMin(env: Env): number {
  const n = Number.parseInt(env.VISITOR_LIMIT_PER_MIN ?? "", 10);
  return Number.isFinite(n) ? n : DEFAULT_VISITOR_LIMIT_PER_MIN;
}

export interface NeonLimitOptions {
  /** Test seam for the prune draw (default Math.random). */
  random?: () => number;
  /** The Worker's ctx.waitUntil: the prune runs after the response. Without it the prune is awaited. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** Per-visitor limit in the Project's own Neon database (AD-7 fallback, story 3.7 AC6): one guarded upsert
 *  per call on visitor_hits, 1-minute windows. No database, or a database error, means allowed (fail open,
 *  like the binding): the daily counter still caps spend, and it fails closed. */
export async function neonVisitorAllowed(env: Env, store: Store | null, visitorKey: string, opts: NeonLimitOptions = {}): Promise<boolean> {
  if (!store) return true;
  if ((opts.random ?? Math.random)() < PRUNE_RATE) {
    const pruning = store.pruneVisitorHits().catch(() => 0);
    if (opts.waitUntil) opts.waitUntil(pruning);
    else await pruning;
  }
  return store.hitVisitor(visitorKey, visitorLimitPerMin(env)).catch(() => true);
}

// Without VISITOR_PEPPER (local runs) each isolate uses a random pepper: keys stay unlinkable to IPs.
let isolatePepper: string | undefined;

/** HMAC-SHA256 of the visitor IP with the Project's VISITOR_PEPPER secret. The raw IP is never stored,
 *  and without the pepper the key cannot be reversed by hashing the IPv4 space. */
export async function visitorKey(request: Request, pepper?: string): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "anonymous";
  const secret = pepper || (isolatePepper ??= crypto.randomUUID());
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip));
  return [...new Uint8Array(mac)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}
