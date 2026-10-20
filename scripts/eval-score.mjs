// Post the promptfoo pass rate to Langfuse as one score (ai-engineering-journey story 3.17, AD-14).
//
//   node scripts/eval-score.mjs <promptfoo output.json>
//
// Reads promptfoo's `--output` JSON (results.stats: successes, failures, errors), prints the pass rate,
// and with LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY posts score `promptfoo` (0-1, NUMERIC) on the session
// `project:<PROJECT_REPO>`, the same tag llm() puts on every generation. `POST {host}/api/public/scores`
// takes a JSON array and answers 202 (all accepted) or 207 (partial, never retried):
// https://cloud.langfuse.com/generated/api/openapi.yml (checked 2026-10-20).
// No keys: prints the rate only, no request. Exit 0 always: the eval informs, the Quality Gate decides.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULT_HOST = "https://cloud.langfuse.com";
const TIMEOUT_MS = 5000;

export function passRate(output) {
  const s = output?.results?.stats;
  if (!s || typeof s.successes !== "number") return null;
  const total = s.successes + (s.failures ?? 0) + (s.errors ?? 0);
  return total > 0 ? { rate: s.successes / total, successes: s.successes, failures: s.failures ?? 0, errors: s.errors ?? 0, total } : null;
}

export function scoreBody(result, env) {
  const repo = env.PROJECT_REPO || "unknown";
  const sha = env.SHA || "";
  return [
    {
      id: `promptfoo:${repo}:${sha || "nosha"}`,
      sessionId: `project:${repo}`,
      name: "promptfoo",
      value: result.rate,
      dataType: "NUMERIC",
      comment: `${result.successes}/${result.total} passed at ${sha.slice(0, 12) || "unknown sha"}`,
      metadata: { sha, successes: result.successes, failures: result.failures, errors: result.errors },
    },
  ];
}

export async function postScore(result, env, fetchImpl = globalThis.fetch) {
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return "no Langfuse keys: score not posted";
  const host = (env.LANGFUSE_HOST || DEFAULT_HOST).replace(/\/+$/, "");
  const init = {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(scoreBody(result, env)),
  };
  let last = "no attempt";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(`${host}/api/public/scores`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return `score posted (HTTP ${res.status})`;
      last = `HTTP ${res.status}`;
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      last = e?.name ?? "error";
    }
  }
  return `score not posted: ${last}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let output = null;
  try {
    output = JSON.parse(readFileSync(process.argv[2], "utf8"));
  } catch (e) {
    console.log(`::warning::no promptfoo output to score (${e.code ?? e.name})`);
  }
  const result = passRate(output);
  if (!result) {
    if (output) console.log("::warning::promptfoo output has no stats; nothing to score");
  } else {
    console.log(`promptfoo: ${result.successes}/${result.total} passed (${(result.rate * 100).toFixed(0)}%)`);
    console.log(await postScore(result, process.env));
  }
}
