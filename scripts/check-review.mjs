#!/usr/bin/env node
// Deploy gate: fail on any open high finding in review/code-review.md (AD-9 check 2).
// Convention (AGENTS.md): one finding per checklist line, severity first:
//   - [ ] high: <finding>      open
//   - [x] high: <finding>      fixed
// "critical" counts as high. A missing review file fails too: no review, no deploy.
import { existsSync, readFileSync } from "node:fs";

const FINDING = /^\s*[-*]\s*\[( |x|X)\]\s*\**\s*(critical|high)\b/i;

export function openHighFindings(markdown) {
  return markdown
    .split("\n")
    .filter((line) => {
      const m = line.match(FINDING);
      return m && m[1] === " ";
    })
    .map((line) => line.trim());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] ?? "review/code-review.md";
  if (!existsSync(path)) {
    console.error(`::error::${path} is missing. The build agent writes it (AGENTS.md); deploy refuses without a review.`);
    process.exit(1);
  }
  const open = openHighFindings(readFileSync(path, "utf8"));
  if (open.length) {
    console.error(`::error::${open.length} open high finding(s) in ${path}:\n${open.join("\n")}`);
    process.exit(1);
  }
  console.log(`check-review: no open high findings in ${path}`);
}
