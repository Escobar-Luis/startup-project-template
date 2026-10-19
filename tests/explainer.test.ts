import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import {
  MERMAID_URL,
  NODES_MAX,
  NODES_MIN,
  TOUR_MAX,
  SHELL,
  SLOTS,
  explainerProblems,
  explainerWarnings,
  fileUrl,
  isFile,
  mermaidSource,
  renderExplainer,
} from "../scripts/build-explainer.mjs";
import { clipPlan, layoutNodes, renderClip, stopSeconds } from "../scripts/build-clip.mjs";
import { usageFrom } from "../scripts/explainer-usage.mjs";
import { coversBuild } from "../scripts/check-review.mjs";
import { SAMPLE_FINGERPRINT, explainerFingerprint, placeholderProblems } from "../scripts/check-placeholders.mjs";

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
function cli(data: unknown, files: string[] = ["src/web.ts", "src/api.ts", "src/llm.ts", "src/db.ts", "src/pages.ts"], project?: string) {
  const dir = mkdtempSync(join(tmpdir(), "explainer "));
  mkdirSync(join(dir, "public"), { recursive: true });
  mkdirSync(join(dir, ".claude/skills/project-explainer"), { recursive: true });
  cpSync(SHELL, join(dir, SHELL));
  for (const f of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "");
  }
  writeFileSync(join(dir, "public/explainer.json"), JSON.stringify(data));
  if (project !== undefined) writeFileSync(join(dir, "project.json"), project);
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
    expect(r.html).toContain(`await import("${MERMAID_URL}")`);
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

  it("names files that do not exist, and paths outside the repo; a name containing .. is fine", () => {
    const d = valid();
    d.nodes[0].files = ["../etc/passwd", "src/../x.ts", "/abs.ts", "src/missing.ts", "src/a..b.ts"];
    expect(explainerProblems(d, (f: string) => f !== "src/missing.ts")).toEqual([
      'node web: file "../etc/passwd" must be a repo-relative path',
      'node web: file "src/../x.ts" must be a repo-relative path',
      'node web: file "/abs.ts" must be a repo-relative path',
      "node web: file src/missing.ts does not exist",
    ]);
  });

  it("a directory is not a file", () => {
    expect(isFile("package.json")).toBe(true);
    expect(isFile("scripts")).toBe(false);
    expect(isFile("nope.txt")).toBe(false);
  });

  it("caps nodes at 3-12 and the tour at 12 stops, and warns on long tour titles", () => {
    const two = { ...valid(), nodes: valid().nodes.slice(0, 2), edges: [], tour: [{ node: "web", title: "t", say: "s" }] };
    expect(explainerProblems(two)).toContain("nodes: 2, need 3 to 12");
    const many = valid();
    many.nodes = Array.from({ length: 13 }, (_, i) => node(`n${i}`));
    many.edges = [];
    many.tour = Array.from({ length: 13 }, () => ({ node: "n0", title: "t", say: "s" }));
    const p = explainerProblems(many);
    expect(p).toContain("nodes: 13, need 3 to 12");
    expect(p).toContain("tour has 13 stops, at most 12");
    const long = valid();
    long.tour[1].title = "one two three four five six seven eight nine";
    expect(explainerWarnings(long)).toEqual(["tour[1].title has 9 words; keep it to 8 or fewer"]);
    expect(explainerWarnings(valid())).toEqual([]);
  });

  it("an invalid project.json fails with a named message, not a stack trace", () => {
    const r = cli(valid(), undefined, "{not json");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^build-explainer: project\.json is not valid JSON: /);
    expect(r.stderr).not.toContain("    at ");
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
    expect(fileUrl("https://github.com/o/r.git", "src/a.ts")).toBe("https://github.com/o/r/blob/HEAD/src/a.ts");
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

  it("is valid, within the build's limits (3-12 nodes, 1-12 tour stops), with files that exist", () => {
    expect(explainerProblems(data, (f: string) => existsSync(f))).toEqual([]);
    expect(data.nodes.length).toBeGreaterThanOrEqual(NODES_MIN);
    expect(data.nodes.length).toBeLessThanOrEqual(NODES_MAX);
    expect(data.tour.length).toBeGreaterThanOrEqual(1);
    expect(data.tour.length).toBeLessThanOrEqual(TOUR_MAX);
  });

  it("the committed public/explainer.html matches its data", () => {
    expect(
      readFileSync("public/explainer.html", "utf8") === renderExplainer(data, shell, project),
      "public/explainer.html is out of date: run npm run build to regenerate public/explainer.html",
    ).toBe(true);
  });

  it("the deploy refuses the template's sample, even with the flag deleted", () => {
    const files: Record<string, string> = {
      "project.json": JSON.stringify({ startup: { name: "Acme" }, repo: "https://github.com/o/acme-demo" }),
      "demo/runs.json": JSON.stringify([1, 2, 3].map((i) => ({ input: `${i}`, output: `${i}`, model: "m" }))),
      "README.md": "",
    };
    const refuse = ["public/explainer.json is still the template's sample; run the project-explainer skill"];
    const sample = { title: "startup-project-template", nodes: [{ id: "visitor" }], tour: [] };
    const check = (d: object) => placeholderProblems((p: string) => (p === "public/explainer.json" ? JSON.stringify(d) : files[p]));
    expect(check({ ...valid(), template_sample: true })).toEqual(refuse);
    expect(check(sample)).toEqual(refuse);
    // Same node ids and tour as the template's sample, new title and no flag.
    const ids = ["visitor", "worker", "llm", "db", "pages", "ship", "explainer"];
    const tour = ["pages", "visitor", "worker", "llm", "db", "ship", "explainer"];
    const copy = { title: "Acme demo", nodes: ids.map((id) => ({ id })), tour: tour.map((n) => ({ node: n })) };
    expect(explainerFingerprint(copy)).toBe(SAMPLE_FINGERPRINT);
    expect(check(copy)).toEqual(refuse);
    expect(check(valid())).toEqual([]);
    files["project.json"] = JSON.stringify({ startup: { name: "Acme" }, repo: "https://github.com/Escobar-Luis/startup-project-template" });
    expect(check(valid())).toEqual(["project.json repo still points at the template"]);
  });

  // Only the template repo holds the sample; a Project's own explainer has neither the flag nor its fingerprint.
  it.runIf(/\/startup-project-template\/?$/.test(project.repo ?? ""))("the template's sample is flagged and fingerprinted", () => {
    expect(data.template_sample).toBe(true);
    expect(explainerFingerprint(data)).toBe(SAMPLE_FINGERPRINT);
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
  it("takes usage from the last result message, with cache reads and writes kept apart (no blended total)", () => {
    const log = [
      { type: "system" },
      { type: "result", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, num_turns: 7, total_cost_usd: 0.12 },
    ];
    expect(usageFrom(log)).toEqual({ fresh_input_tokens: 10, output_tokens: 5, cache_read_tokens: 100, num_turns: 7, total_cost_usd: 0.12 });
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

  it("keeps the timing contract: every clip timed, on a track, inside the root duration; timelines initialised", () => {
    const d = valid();
    d.tour.push({ node: "web", title: "Back to the page.", say: "Again." });
    const html = renderClip(d, {});
    const root = Number(html.match(/data-composition-id="main"[^>]*data-duration="([\d.]+)"/)![1]);
    const clips = [...html.matchAll(/<[a-z]+ [^>]*class="[^"]*\bclip\b[^"]*"[^>]*>/g)].map((m) => m[0]);
    expect(clips.length).toBeGreaterThan(1);
    for (const tag of clips) {
      const start = Number(tag.match(/data-start="([\d.]+)"/)?.[1]);
      const dur = Number(tag.match(/data-duration="([\d.]+)"/)?.[1]);
      expect(tag).toMatch(/data-track-index="\d+"/);
      expect(Number.isFinite(start) && Number.isFinite(dur), tag).toBe(true);
      expect(start + dur, tag).toBeLessThanOrEqual(root + 1e-6);
    }
    expect(html).toContain("window.__timelines = window.__timelines || {};");
    // "web" is on the tour twice but enters once.
    expect(html.match(/tl\.fromTo\("#n0", \{ scale: 0\.6/g)).toHaveLength(1);
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

describe("the explainer page in a browser (happy-dom)", () => {
  function page(data = valid()) {
    const html = renderExplainer(data, shell, {});
    const classic = html.match(/<script>\n([\s\S]*?)<\/script>/)![1];
    const window = new Window({ url: "https://example.test/explainer.html" });
    // Without scripts first: the no-JS page.
    window.document.write(html.replace(/<script>[\s\S]*?<\/script>/, "").replace(/<script type="module">[\s\S]*?<\/script>/, ""));
    const doc = window.document;
    const visible = () => [...doc.querySelectorAll(".panel")].filter((p) => !(p as unknown as { hidden: boolean }).hidden).map((p) => p.getAttribute("data-node"));
    const button = (id: string) => doc.getElementById(id) as unknown as { disabled: boolean; click(): void };
    return { window, doc, visible, button, run: () => window.eval(classic) };
  }

  it("without JS every panel shows and the Back/Next nav is hidden", async () => {
    const { window, doc, visible } = page();
    expect(visible()).toEqual(["web", "api", "llm", "db", "pages"]);
    expect(doc.documentElement.classList.contains("js")).toBe(false);
    expect(shell).toMatch(/\.nav \{ display: none;/);
    expect(shell).toMatch(/\.js \.nav \{ display: flex; \}/);
    await window.happyDOM.close();
  });

  it("with JS: one panel at a time, steps and Next/Back move it, the ends disable", async () => {
    const { window, doc, visible, button, run } = page();
    run();
    expect(doc.documentElement.classList.contains("js")).toBe(true);
    expect(visible()).toEqual(["pages"]);
    expect(button("prev").disabled).toBe(true);
    expect(button("next").disabled).toBe(false);
    button("next").click();
    expect(visible()).toEqual(["web"]);
    expect(button("prev").disabled).toBe(false);
    (doc.querySelectorAll(".step button")[4] as unknown as { click(): void }).click();
    expect(visible()).toEqual(["db"]);
    expect(doc.querySelectorAll(".step.on")).toHaveLength(1);
    expect(button("next").disabled).toBe(true);
    button("prev").click();
    expect(visible()).toEqual(["llm"]);
    await window.happyDOM.close();
  });

  it("a node outside the tour gets a button, and every node does when Mermaid cannot load", async () => {
    const d = valid();
    d.nodes.push(node("cache"));
    const { window, doc, visible, run } = page(d);
    run();
    const list = () => [...doc.querySelectorAll("#nodelist button")].map((b) => b.getAttribute("data-node"));
    expect(list()).toEqual(["cache"]);
    (doc.querySelector('#nodelist button[data-node="cache"]') as unknown as { click(): void }).click();
    expect(visible()).toEqual(["cache"]);
    (window as unknown as { explainerListAll(): void }).explainerListAll();
    expect(list()).toEqual(["web", "api", "llm", "db", "pages", "cache"]);
    await window.happyDOM.close();
  });
});
