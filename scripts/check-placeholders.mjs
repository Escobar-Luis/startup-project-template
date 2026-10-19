#!/usr/bin/env node
// Deploy gate: template placeholders must not ship. Run from the repo root.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Returns the reasons the repo still holds template placeholders; empty means ok. */
export function placeholderProblems(read = (p) => readFileSync(p, "utf8")) {
  const problems = [];
  try {
    const project = JSON.parse(read("project.json"));
    if (project?.startup?.name === "Example Startup") problems.push('project.json still names "Example Startup"');
  } catch (e) {
    problems.push(`project.json unreadable: ${e.message}`);
  }
  try {
    const runs = JSON.parse(read("demo/runs.json"));
    if (!Array.isArray(runs) || runs.length < 3) problems.push("demo/runs.json needs at least 3 recorded runs");
    if (Array.isArray(runs) && runs.some((r) => r?.model === "template-placeholder")) {
      problems.push('demo/runs.json still has a "template-placeholder" run');
    }
  } catch (e) {
    problems.push(`demo/runs.json unreadable: ${e.message}`);
  }
  try {
    if (read("README.md").includes("Replace with")) problems.push('README.md still says "Replace with"');
  } catch (e) {
    problems.push(`README.md unreadable: ${e.message}`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = placeholderProblems();
  if (problems.length) {
    console.error(`::error::template placeholders would ship:\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log("check-placeholders: none left");
}
