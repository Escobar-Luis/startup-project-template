#!/usr/bin/env node
// Builds the architecture explainer (AD-13): validates public/explainer.json (written by the
// project-explainer skill) and inlines it into the fixed shell, making one self-contained page.
//   node scripts/build-explainer.mjs [data json] [out html]
// Defaults: public/explainer.json -> public/explainer.html (Vite copies public/ into dist/).
// Exits 1 naming the problem: an edge or tour step naming an unknown node, a node with no files,
// an empty tour, a file that does not exist, or a shell missing a slot.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SHELL = ".claude/skills/project-explainer/explainer.template.html";
// Pinned: a new Mermaid is a deliberate change here, never a floating tag.
export const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.esm.min.mjs";
export const SLOTS = ["TITLE", "SUMMARY", "ACCENT", "MERMAID_URL", "MERMAID", "PANELS", "TOUR", "DATA"];

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const NODES_MIN = 3;
export const NODES_MAX = 12;
export const TOUR_MAX = 12;
const TITLE_WORDS = 8;

/** True when `path` is a regular file (a directory does not count). */
export const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const isText = (v) => typeof v === "string" && v.trim() !== "";

/**
 * Every reason the explainer data is unusable; empty means ok. `exists(path)` checks node files.
 * @param {any} data
 * @param {(path: string) => boolean} [exists]
 * @returns {string[]}
 */
export function explainerProblems(data, exists = (path) => Boolean(path)) {
  const p = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) return ["explainer.json must be a JSON object"];
  if (!isText(data.title)) p.push("title is required");
  if (!isText(data.summary)) p.push("summary is required (one plain sentence)");

  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  if (!Array.isArray(data.nodes) || nodes.length === 0) p.push("nodes must be a non-empty list");
  else if (nodes.length < NODES_MIN || nodes.length > NODES_MAX) p.push(`nodes: ${nodes.length}, need ${NODES_MIN} to ${NODES_MAX}`);
  const ids = new Set();
  nodes.forEach((n, i) => {
    const at = `nodes[${i}]`;
    if (!n || typeof n !== "object") return p.push(`${at} must be an object`);
    if (typeof n.id !== "string" || !ID.test(n.id)) p.push(`${at}.id must match ${ID}`);
    else if (ids.has(n.id)) p.push(`duplicate node id: ${n.id}`);
    else ids.add(n.id);
    const name = typeof n.id === "string" ? n.id : at;
    for (const k of ["label", "does", "why"]) if (!isText(n[k])) p.push(`node ${name}: ${k} is required`);
    if (!Array.isArray(n.files) || n.files.length === 0) {
      p.push(`node ${name} has no files`);
      return;
    }
    for (const f of n.files) {
      if (typeof f !== "string" || !f || f.startsWith("/") || f.split("/").includes("..") || f.includes("://") || f.includes("\\")) {
        p.push(`node ${name}: file ${JSON.stringify(f)} must be a repo-relative path`);
      } else if (!exists(f)) p.push(`node ${name}: file ${f} does not exist`);
    }
  });

  const edges = Array.isArray(data.edges) ? data.edges : [];
  if (data.edges !== undefined && !Array.isArray(data.edges)) p.push("edges must be a list");
  edges.forEach((e, i) => {
    for (const k of ["from", "to"]) {
      if (!e || typeof e[k] !== "string") p.push(`edges[${i}].${k} is required`);
      else if (!ids.has(e[k])) p.push(`edges[${i}] names unknown node: ${e[k]}`);
    }
    if (e && e.label !== undefined && typeof e.label !== "string") p.push(`edges[${i}].label must be text`);
  });

  if (!Array.isArray(data.tour) || data.tour.length === 0) p.push("tour is empty: list the stops in talk-track order");
  else if (data.tour.length > TOUR_MAX) p.push(`tour has ${data.tour.length} stops, at most ${TOUR_MAX}`);
  (Array.isArray(data.tour) ? data.tour : []).forEach((s, i) => {
    if (!s || typeof s.node !== "string") return p.push(`tour[${i}].node is required`);
    if (!ids.has(s.node)) p.push(`tour[${i}] names unknown node: ${s.node}`);
    if (!isText(s.title)) p.push(`tour[${i}].title is required (a short plain caption)`);
    if (!isText(s.say)) p.push(`tour[${i}].say is required (the talk-track line)`);
  });
  return p;
}

/** Non-fatal advice: tour titles become ~6-word clip captions. */
export function explainerWarnings(data) {
  return (Array.isArray(data?.tour) ? data.tour : [])
    .map((s, i) => [i, typeof s?.title === "string" ? s.title.trim().split(/\s+/).length : 0])
    .filter(([, n]) => n > TITLE_WORDS)
    .map(([i, n]) => `tour[${i}].title has ${n} words; keep it to ${TITLE_WORDS} or fewer`);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Mermaid label text: its own entity codes, so no quote, bracket or pipe can end the label early.
const mermaidText = (s) =>
  String(s).replace(/[#%"<>|[\]{}()]/g, (c) => `#${c.charCodeAt(0)};`).replace(/\s+/g, " ").trim();

/** Mermaid flowchart source. Node ids become n0, n1, ... so no data id can collide with Mermaid syntax. */
export function mermaidSource(data) {
  const key = new Map(data.nodes.map((n, i) => [n.id, `n${i}`]));
  const lines = ["flowchart TD"];
  for (const n of data.nodes) lines.push(`  ${key.get(n.id)}["${mermaidText(n.label)}"]`);
  for (const e of data.edges ?? []) {
    const label = isText(e.label) ? `|"${mermaidText(e.label)}"|` : "";
    lines.push(`  ${key.get(e.from)} -->${label} ${key.get(e.to)}`);
  }
  return lines.join("\n");
}

/** A GitHub URL for a repo-relative path, or null when project.json has no GitHub repo. */
export function fileUrl(repo, path) {
  if (typeof repo !== "string" || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(repo)) return null;
  return `${repo.replace(/\/$/, "").replace(/\.git$/, "")}/blob/HEAD/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function panelHtml(n, stops, repo) {
  const files = n.files
    .map((f) => {
      const url = fileUrl(repo, f);
      const code = `<code>${escapeHtml(f)}</code>`;
      return `<li>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${code}</a>` : code}</li>`;
    })
    .join("");
  const badge = stops.length ? `<span class="stop">Tour ${stops.join(", ")}</span>` : "";
  return [
    `<section class="panel" id="panel-${n.id}" data-node="${n.id}" aria-labelledby="h-${n.id}">`,
    `<h3 id="h-${n.id}">${escapeHtml(n.label)} ${badge}</h3>`,
    `<h4>What it does</h4><p>${escapeHtml(n.does)}</p>`,
    `<h4>Files</h4><ul class="files">${files}</ul>`,
    `<h4>Why it is built this way</h4><p>${escapeHtml(n.why)}</p>`,
    `</section>`,
  ].join("\n");
}

/** The finished page: the shell with every slot filled. Throws when the shell is missing a slot. */
export function renderExplainer(data, shell, project = {}) {
  const missing = SLOTS.filter((s) => !shell.includes(`{{${s}}}`));
  if (missing.length) throw new Error(`explainer shell is missing slot(s): ${missing.join(", ")}`);
  const stopsOf = (id) => data.tour.map((s, i) => (s.node === id ? i + 1 : 0)).filter(Boolean);
  const label = new Map(data.nodes.map((n) => [n.id, n.label]));
  const tour = data.tour
    .map(
      (s, i) =>
        `<li class="step" data-node="${s.node}" data-step="${i + 1}"><button type="button">` +
        `<span class="num">${i + 1}</span><span class="t"><strong>${escapeHtml(s.title)}</strong>` +
        `<span class="where">${escapeHtml(label.get(s.node))}</span><span class="say">${escapeHtml(s.say)}</span></span></button></li>`,
    )
    .join("\n");
  const nodeKeys = Object.fromEntries(data.nodes.map((n, i) => [`n${i}`, n.id]));
  // JSON inside <script>: escape "<" so no string in the data can close the script element.
  const labels = Object.fromEntries(data.nodes.map((n) => [n.id, n.label]));
  const json = JSON.stringify({ nodes: nodeKeys, labels, tour: data.tour.map((s) => s.node) }).replace(/</g, "\\u003c");
  const accent = /^#[0-9a-f]{6}$/i.test(project?.colors?.primary ?? "") ? project.colors.primary : "#1d4ed8";
  const fill = {
    TITLE: escapeHtml(data.title),
    SUMMARY: escapeHtml(data.summary),
    ACCENT: accent,
    MERMAID_URL: MERMAID_URL,
    MERMAID: escapeHtml(mermaidSource(data)),
    PANELS: data.nodes.map((n) => panelHtml(n, stopsOf(n.id), project?.repo)).join("\n"),
    TOUR: tour,
    DATA: json,
  };
  // One pass, so text inserted for one slot is never scanned for another slot's marker.
  return shell.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in fill ? fill[k] : m));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [src = "public/explainer.json", out = "public/explainer.html"] = process.argv.slice(2);
  const fail = (msg) => {
    console.error(`build-explainer: ${msg}`);
    process.exit(1);
  };
  if (!existsSync(src)) fail(`${src} is missing; the project-explainer skill writes it (AGENTS.md)`);
  let data;
  try {
    data = JSON.parse(readFileSync(src, "utf8"));
  } catch (e) {
    fail(`${src} is not valid JSON: ${e.message}`);
  }
  const problems = explainerProblems(data, isFile);
  if (problems.length) fail(`${src}:\n  ${problems.join("\n  ")}`);
  for (const w of explainerWarnings(data)) console.warn(`build-explainer: warning: ${w}`);
  let project = {};
  if (existsSync("project.json")) {
    try {
      project = JSON.parse(readFileSync("project.json", "utf8"));
    } catch (e) {
      fail(`project.json is not valid JSON: ${e.message}`);
    }
  }
  let html;
  try {
    html = renderExplainer(data, readFileSync(SHELL, "utf8"), project);
  } catch (e) {
    fail(e.message);
  }
  writeFileSync(out, html);
  console.log(`build-explainer: ${out} (${data.nodes.length} nodes, ${data.tour.length} tour steps)`);
}
