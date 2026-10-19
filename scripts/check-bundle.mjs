#!/usr/bin/env node
// Fails the build if a server secret name, a Postgres URL or a secret value prefix reached the client bundle (AD-6).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FORBIDDEN = [
  "DATABASE_URL",
  "postgres://",
  "postgresql://",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "VISITOR_PEPPER",
  "gsk_", // Groq key prefix
  "sk-or-v1-", // OpenRouter key prefix
  "sk-ant-", // Anthropic key and OAuth token prefix
];

export function scan(dir) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const text = readFileSync(p, "latin1");
        for (const f of FORBIDDEN) if (text.includes(f)) hits.push(`${p}: ${f}`);
      }
    }
  };
  walk(dir);
  return hits;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? "dist";
  const hits = scan(dir);
  if (hits.length) {
    console.error(`Client bundle leaks server-only strings:\n${hits.join("\n")}`);
    process.exit(1);
  }
  console.log(`check-bundle: ${dir} clean`);
}
