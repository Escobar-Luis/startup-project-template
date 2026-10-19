import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MERMAID_URL, SHELL, SLOTS, explainerProblems, fileUrl, mermaidSource, renderExplainer } from "../scripts/build-explainer.mjs";
import { clipPlan, layoutNodes, renderClip, stopSeconds } from "../scripts/build-clip.mjs";
import { usageFrom } from "../scripts/explainer-usage.mjs";
import { coversBuild } from "../scripts/check-review.mjs";
import { placeholderProblems } from "../scripts/check-placeholders.mjs";

const ROOT = resolve(".");
const shell = readFileSync(SHELL, "utf8");
const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: `${id} label`,
  does: `${id} does`,
  why: `${id} why`,
  files: [`src/${id}.ts`],
  ...extra,
});
// The matrix's valid case: 5 nodes, 4 edges, 5 tour steps.
const valid = () => ({
  title: "Demo",
  summary: "A demo.",
  nodes: ["web", "api", "llm", "db", "pages"].map((id) => node(id)),
  edges: [
    { from: "web", to: "api", label: "POST /api/ask" },
    { from: "api", to: "llm" },
    { from: "llm", to: "db" },
    { from: "pages", to: "api" },
  ],
  tour: ["pages", "web", "api", "llm", "db"].map((n, i) => ({ node: n, title: `Step ${i + 1}.`, say: `Say ${i + 1}.` })),
});

/** Runs the CLI in a temp repo holding the shell, the data and the files it names. */
function cli(data: unknown, files: string[] = ["src/web.ts", "src/api.ts", "src/llm.ts", "src/db.ts", "src/pages.ts"]) {
  const dir = mkdtempSync(join(tmpdir(), "explainer "));
  mkdirSync(join(dir, "public"), { recursive: true });
  mkdirSync(join(dir, ".claude/skills/project-explainer"), { recursive: true });
  cpSync(SHELL, join(dir, SHELL));
  for (const f of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "");
  }
  writeFileSync(join(dir, "public/explainer.json"), JSON.stringify(data));
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/build-explainer.mjs")], { cwd: dir, encoding: "utf8" });
  const out = join(dir, "public/explainer.html");
  return { ...r, html: existsSync(out) ? readFileSync(out, "utf8") : "" };
}

describe("build-explainer (I/O matrix)", () => {
  it("valid data: the Mermaid graph, 5 panels and a numbered 5-step tour", () => {
    const r = cli(valid());
    expect(r.status, r.stderr).toBe(0);
    expect(r.html).toContain('<pre class="mermaid">flowchart TD');
    expect(r.html.match(/<section class="panel"/g)).toHaveLength(5);
    expect(r.html.match(/<li class="step"/g)).toHaveLength(5);
    expect(r.html).toContain('<span class="num">5</span>');
    // Tour order is the talk-track order.
    const order = [...r.html.matchAll(/<li class="step" data-node="([a-z]+)" data-step="(\d)"/g)].map((m) => `${m[2]}:${m[1]}`);
    expect(order).toEqual(["1:pages", "2:web", "3:api", "4:llm", "5:db"]);
    // Self-contained: no fetch and no local asset; the only external load is the pinned Mermaid.
    expect(r.html).not.toMatch(/fetch\(|<link |src="(?!https)/);
    expect(r.html).toContain(`import mermaid from "${MERMAID_URL}"`);
    expect(r.html).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("edge to an unknown node: exits 1 naming it", () => {
    const d = valid();
    d.edges.push({ from: "api", to: "ghost" });
    const r = cli(d);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("edges[4] names unknown node: ghost");
  });

  it("tour step naming an unknown node: exits 1", () => {
    const d = valid();
    d.tour.push({ node: "ghost", title: "t", say: "s" });
    const r = cli(d);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("tour[5] names unknown node: ghost");
  });

  it("node with no files: exits 1", () => {
    const d = valid();
    d.nodes[3].files = [];
    const r = cli(d);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("node db has no files");
  });

  it("empty tour: exits 1", () => {
    const r = cli({ ...valid(), tour: [] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("tour is empty");
  });

  it("HTML injection: panel, tour and title text is escaped", () => {
    const d = valid();
    d.title = "</title><script>alert(1)</script>";
    d.nodes[0].does = "<script>alert('x')</script>";
    d.nodes[0].label = 'a"]; click n0 call evil() %%';
    d.tour[0].say = "<img src=x onerror=alert(1)>";
    const r = cli(d);
    expect(r.status, r.stderr).toBe(0);
    expect(r.html).not.toContain("<script>alert");
    expect(r.html).not.toContain("<img src=x");
    expect(r.html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    // The only <script> elements are the shell's own three.
    expect(r.html.match(/<script/g)).toHaveLength(3);
    // A label cannot end its Mermaid node early.
    expect(mermaidSource(d)).toContain('n0["a#34;#93;; click n0 call evil#40;#41; #37;#37;"]');
  });

  it("names files that do not exist, and paths outside the repo", () => {
    const d = valid();
    d.nodes[0].files = ["../etc/passwd", "/abs.ts", "src/missing.ts"];
    expect(explainerProblems(d, (f: string) => f !== "src/missing.ts")).toEqual([
      'node web: file "../etc/passwd" must be a repo-relative path',
      'node web: file "/abs.ts" must be a repo-relative path',
      "node web: file src/missing.ts does not exist",
    ]);
  });

  it("refuses duplicate ids, unsafe ids and missing text", () => {
    const d = valid();
    d.nodes.push(node("web"), node("Bad Id"));
    delete (d.nodes[1] as Record<string, unknown>).why;
    const p = explainerProblems(d);
    expect(p).toContain("duplicate node id: web");
    expect(p.some((x: string) => x.startsWith("nodes[6].id must match"))).toBe(true);
    expect(p).toContain("node api: why is required");
  });

  it("links files to GitHub only when project.json names a GitHub repo", () => {
    expect(fileUrl("https://github.com/o/r", "src/a b.ts")).toBe("https://github.com/o/r/blob/HEAD/src/a%20b.ts");
    expect(fileUrl("", "src/a.ts")).toBeNull();
    expect(fileUrl("javascript:alert(1)//github.com/o/r", "x")).toBeNull();
    const html = renderExplainer(valid(), shell, { repo: "https://github.com/o/r" });
    expect(html).toContain('<a href="https://github.com/o/r/blob/HEAD/src/web.ts" target="_blank" rel="noopener"><code>src/web.ts</code></a>');
    expect(renderExplainer(valid(), shell, {})).not.toContain("<a href=");
  });

  it("fails when the shell lost a slot", () => {
    expect(() => renderExplainer(valid(), shell.replace("{{TOUR}}", ""), {})).toThrow("missing slot(s): TOUR");
    for (const s of SLOTS) expect(shell).toContain(`{{${s}}}`);
  });

  it("pins Mermaid to an exact version", () => {
    expect(MERMAID_URL).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+\//);
  });
});

describe("the template's own explainer", () => {
  const data = JSON.parse(readFileSync("public/explainer.json", "utf8"));
  const project = JSON.parse(readFileSync("project.json", "utf8"));

  it("is valid, with 5+ nodes, files that exist and a tour", () => {
    expect(explainerProblems(data, (f: string) => existsSync(f))).toEqual([]);
    expect(data.nodes.length).toBeGreaterThanOrEqual(5);
    expect(data.tour.length).toBeGreaterThanOrEqual(5);
  });

  it("the committed public/explainer.html matches its data (run npm run explainer)", () => {
    expect(readFileSync("public/explainer.html", "utf8")).toBe(renderExplainer(data, shell, project));
  });

  it("is marked as the template's sample, which the deploy refuses", () => {
    expect(data.template_sample).toBe(true);
    const files: Record<string, string> = {
      "project.json": JSON.stringify({ startup: { name: "Acme" }, repo: "https://github.com/o/acme-demo" }),
      "demo/runs.json": JSON.stringify([1, 2, 3].map((i) => ({ input: `${i}`, output: `${i}`, model: "m" }))),
      "README.md": "",
      "public/explainer.json": JSON.stringify(data),
    };
    expect(placeholderProblems((p: string) => files[p])).toEqual(["public/explainer.json is still the template's sample; run the project-explainer skill"]);
    files["public/explainer.json"] = JSON.stringify({ ...data, template_sample: undefined });
    expect(placeholderProblems((p: string) => files[p])).toEqual([]);
    files["project.json"] = JSON.stringify({ startup: { name: "Acme" }, repo: "https://github.com/Escobar-Luis/startup-project-template" });
    expect(placeholderProblems((p: string) => files[p])).toEqual(["project.json repo still points at the template"]);
  });
});

describe("review gate and the explainer step", () => {
  const git = (diff: string) => (args: string[]) => (args[0] === "diff" ? diff : "");
  it("the explainer written after the review still counts as reviewed; code does not", () => {
    expect(coversBuild("1111111", "abc1234def", git("public/explainer.json\npublic/explainer.html\nreview/explainer-usage.json\n"))).toBe(true);
    expect(coversBuild("1111111", "abc1234def", git("public/explainer.json\nsrc/worker/index.ts\n"))).toBe(false);
    expect(coversBuild("1111111", "abc1234def", git("public/other.html\n"))).toBe(false);
  });
});

describe("explainer token record", () => {
  it("takes usage from the last result message", () => {
    const log = [
      { type: "system" },
      { type: "result", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, num_turns: 7, total_cost_usd: 0.12 },
    ];
    expect(usageFrom(log)).toEqual({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, total_tokens: 115, num_turns: 7, total_cost_usd: 0.12 });
  });
  it("records nothing when the action reports no usage", () => {
    expect(usageFrom([{ type: "result" }])).toBeNull();
    expect(usageFrom(null)).toBeNull();
  });
});

describe("how-it-works clip composition", () => {
  it("keeps the clip near 30 s and follows the tour in order", () => {
    expect(stopSeconds(5)).toBe(3.5);
    expect(stopSeconds(12)).toBe(2);
    const plan = clipPlan(valid());
    expect(plan.duration).toBeLessThanOrEqual(32);
    expect(plan.beats.filter((b: { kind: string }) => b.kind === "stop").map((b: { caption: string }) => b.caption)).toEqual([
      "1 · Step 1.",
      "2 · Step 2.",
      "3 · Step 3.",
      "4 · Step 4.",
      "5 · Step 5.",
    ]);
  });

  it("places every node without two cards on one spot", () => {
    const pos = layoutNodes(valid());
    const spots = Object.values(pos).map((p: { x: number; y: number }) => `${p.x},${p.y}`);
    expect(Object.keys(pos)).toHaveLength(5);
    expect(new Set(spots).size).toBe(5);
  });

  it("uses only the explainer's facts, escaped, with one paused timeline and the root duration", () => {
    const d = valid();
    d.nodes[0].label = "<script>x</script>";
    const html = renderClip(d, { repo: "https://github.com/o/r" });
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain(`data-duration="${clipPlan(d).duration}"`);
    expect(html).toContain('window.__timelines["main"] = tl;');
    expect(html).toContain("github.com/o/r");
    expect(html).not.toMatch(/Math\.random|Date\.now|fetch\(/);
  });
});
