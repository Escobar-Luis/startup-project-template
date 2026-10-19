#!/usr/bin/env node
// Fails the build if a server secret name or a Postgres URL reached the client bundle (AD-6).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = ["DATABASE_URL", "postgres://", "postgresql://", "GROQ_API_KEY", "OPENROUTER_API_KEY"];

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? "dist";
  const hits = scan(dir);
  if (hits.length) {
    console.error(`Client bundle leaks server-only strings:\n${hits.join("\n")}`);
    process.exit(1);
  }
  console.log(`check-bundle: ${dir} clean`);
}
