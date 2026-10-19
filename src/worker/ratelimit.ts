import type { Env } from "./env";

/** Per-visitor limit through the Workers Rate Limiting binding (AD-7 step 1).
 *  No binding, or a binding call that throws, means allowed: the daily counter still caps spend. */
export async function visitorAllowed(env: Env, visitorKey: string): Promise<boolean> {
  if (!env.VISITOR_LIMIT) return true;
  try {
    const { success } = await env.VISITOR_LIMIT.limit({ key: visitorKey });
    return success;
  } catch {
    return true;
  }
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
