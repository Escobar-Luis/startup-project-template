#!/usr/bin/env node
// Deploy gate (AD-9 check 2): review/code-review.md must review this build, and have no open high finding.
//   node scripts/check-review.mjs review/code-review.md <build sha>
// Rules (AGENTS.md):
//   1. The first line is "# Code review: <sha>". That sha must be the build sha, or an ancestor of it
//      whose diff to the build sha touches only review/ (the review commit itself) and the explainer the
//      build job writes after the review (public/explainer.json and public/explainer.html, story 3.8).
//   2. At least one checklist line ("- [ ]" / "- [x]", any list marker: - * + or 1.).
//   3. No unchecked item that mentions high or critical, and no unchecked item under a High/Critical heading.
// A missing file fails too: no review, no deploy.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CHECKLIST = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s*(.*)$/;
const SEVERE = /\b(high|critical)\b/i;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

/** Problems with the review text itself (format, findings). Returns a list of reasons; empty means ok. */
export function reviewProblems(markdown) {
  const lines = markdown.split("\n");
  const problems = [];
  if (!/^# Code review: [0-9a-f]{7,40}\s*$/.test(lines[0] ?? "")) {
    problems.push('first line must be "# Code review: <sha>"');
  }
  let checklist = 0;
  let underSevereHeading = false;
  for (const line of lines.slice(1)) {
    const h = line.match(HEADING);
    if (h) {
      underSevereHeading = SEVERE.test(h[1]);
      continue;
    }
    const m = line.match(CHECKLIST);
    if (!m) continue;
    checklist++;
    if (m[1] === " " && (SEVERE.test(m[2]) || underSevereHeading)) problems.push(`open high finding: ${line.trim()}`);
  }
  if (checklist === 0) problems.push("no checklist lines: write one finding per line, or '- [x] none: no findings'");
  return problems;
}

export function reviewedSha(markdown) {
  return (markdown.split("\n")[0] ?? "").match(/^# Code review: ([0-9a-f]{7,40})/)?.[1];
}

// Written after the review by the build job's explainer step: documentation, not code.
export const AFTER_REVIEW = ["public/explainer.json", "public/explainer.html"];

/** True when `reviewed` is the build sha, or an ancestor whose changes up to it touch only review/ and the explainer. */
export function coversBuild(reviewed, buildSha, git = (args) => execFileSync("git", args, { encoding: "utf8" })) {
  if (buildSha.startsWith(reviewed) || reviewed.startsWith(buildSha)) return true;
  try {
    git(["merge-base", "--is-ancestor", reviewed, buildSha]);
  } catch {
    return false;
  }
  const changed = git(["diff", "--name-only", reviewed, buildSha]).split("\n").filter(Boolean);
  return changed.every((f) => f.startsWith("review/") || AFTER_REVIEW.includes(f));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path = "review/code-review.md", buildSha] = process.argv.slice(2);
  const fail = (msg) => {
    console.error(`::error::${msg}`);
    process.exit(1);
  };
  if (!buildSha) fail("usage: check-review.mjs <review file> <build sha>");
  if (!existsSync(path)) fail(`${path} is missing. The build agent writes it (AGENTS.md); deploy refuses without a review.`);
  const text = readFileSync(path, "utf8");
  const problems = reviewProblems(text);
  if (problems.length) fail(`${path}:\n${problems.join("\n")}`);
  const reviewed = reviewedSha(text);
  if (!coversBuild(reviewed, buildSha)) fail(`${path} reviews ${reviewed}, not the build ${buildSha} (code changed after the review)`);
  console.log(`check-review: ${path} reviews ${buildSha.slice(0, 12)} with no open high findings`);
}
