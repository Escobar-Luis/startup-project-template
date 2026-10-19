#!/usr/bin/env node
// Deploy gate: template placeholders must not ship. Run from the repo root.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The template's own sample explainer (public/explainer.json in the template repo): its title, and a hash of its
// node ids and tour order, so a Project that only deleted "template_sample" is still refused.
export const SAMPLE_TITLE = "startup-project-template";
export const SAMPLE_FINGERPRINT = "988f0c9697d45dbea30b538d83d9e7031b45fe977e5eccd3e3c4b4cae16b6b3f";

/** sha256 of the node ids and the tour's node order. */
export function explainerFingerprint(data) {
  const nodes = Array.isArray(data?.nodes) ? data.nodes.map((n) => n?.id) : [];
  const tour = Array.isArray(data?.tour) ? data.tour.map((s) => s?.node) : [];
  return createHash("sha256").update(JSON.stringify({ nodes, tour })).digest("hex");
}
import { pathToFileURL } from "node:url";

/** Returns the reasons the repo still holds template placeholders; empty means ok. */
export function placeholderProblems(read = (p) => readFileSync(p, "utf8")) {
  const problems = [];
  try {
    const project = JSON.parse(read("project.json"));
    if (project?.startup?.name === "Example Startup") problems.push('project.json still names "Example Startup"');
    if (/\/startup-project-template\/?$/.test(project?.repo ?? "")) problems.push("project.json repo still points at the template");
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
  try {
    const explainer = read("public/explainer.json");
    const data = explainer === undefined ? undefined : JSON.parse(explainer);
    if (
      data &&
      (data.template_sample === true || data.title === SAMPLE_TITLE || explainerFingerprint(data) === SAMPLE_FINGERPRINT)
    ) {
      problems.push("public/explainer.json is still the template's sample; run the project-explainer skill");
    }
  } catch {
    // Missing or invalid: scripts/build-explainer.mjs fails the build with the reason.
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
