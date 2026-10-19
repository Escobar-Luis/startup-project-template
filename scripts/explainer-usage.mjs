#!/usr/bin/env node
// Records the explainer run's tokens (story 3.8) from claude-code-action's execution file.
//   node scripts/explainer-usage.mjs <execution_file> <out json> [sha]
// Writes nothing and exits 0 when the action reported no usage, so a missing number never fails a build.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const KEYS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];

/** The usage record from the execution log (a JSON array of SDK messages), or null when it has none. */
export function usageFrom(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const result = [...list].reverse().find((m) => m && m.type === "result" && m.usage && typeof m.usage === "object");
  if (!result) return null;
  const tokens = Object.fromEntries(KEYS.filter((k) => Number.isFinite(result.usage[k])).map((k) => [k, result.usage[k]]));
  if (!Object.keys(tokens).length) return null;
  const record = { ...tokens, total_tokens: Object.values(tokens).reduce((a, b) => a + b, 0) };
  if (Number.isFinite(result.num_turns)) record.num_turns = result.num_turns;
  if (Number.isFinite(result.total_cost_usd)) record.total_cost_usd = result.total_cost_usd;
  if (Number.isFinite(result.duration_ms)) record.duration_ms = result.duration_ms;
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, out = "review/explainer-usage.json", sha = ""] = process.argv.slice(2);
  let messages = null;
  try {
    if (file && existsSync(file)) messages = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.log(`explainer-usage: unreadable execution file (${e.message}); nothing recorded`);
  }
  const usage = usageFrom(messages);
  if (!usage) {
    console.log("explainer-usage: the action reported no token usage; nothing recorded");
    process.exit(0);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ sha, recorded_at: new Date().toISOString(), ...usage }, null, 2) + "\n");
  console.log(`explainer-usage: ${usage.total_tokens} tokens -> ${out}`);
}
