import type { Env } from "./env";

/** Per-visitor limit through the Workers Rate Limiting binding (AD-7 step 1).
 *  No binding (local tests, or a plan without it) means allowed; the daily counter still caps spend. */
export async function visitorAllowed(env: Env, visitorKey: string): Promise<boolean> {
  if (!env.VISITOR_LIMIT) return true;
  const { success } = await env.VISITOR_LIMIT.limit({ key: visitorKey });
  return success;
}

/** A stable, non-reversible visitor key. The raw IP is never stored. */
export async function visitorKey(request: Request): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "anonymous";
  const bytes = new TextEncoder().encode(`visitor:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}
