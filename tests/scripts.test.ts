import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { coversBuild, reviewProblems } from "../scripts/check-review.mjs";
import { LIMIT_BYTES, checkSize } from "../scripts/db-size.mjs";
import { scan } from "../scripts/check-bundle.mjs";
import { placeholderProblems } from "../scripts/check-placeholders.mjs";
import { applyDatabase, findOrCreateProject, neonClient, promptHash, validateRuns, withRole } from "../scripts/provision-neon.mjs";

// Fixture URLs are split so the gitleaks postgres rule does not flag fake credentials.
const PG = "postgresql" + "://";
const ROOT = resolve(".");
const node = (script: string, args: string[], cwd: string) =>
  spawnSync(process.execPath, [join(ROOT, "scripts", script), ...args], { cwd, encoding: "utf8" });
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `${prefix} `)); // a space in the path, on purpose

const RUNS = [
  { input: "a", output: "A", model: "m" },
  { input: "b", output: "B", model: "m" },
  { input: "c", output: "C", model: "m" },
];

describe("db-size gate", () => {
  it("big DB: over 200 MB fails with the size", () => {
    const r = checkSize(231 * 1024 * 1024);
    expect(r.ok).toBe(false);
    expect(r.message).toBe("database is 231.0 MB, over the 200.0 MB cap");
  });
  it("under the cap passes", () => {
    expect(checkSize(LIMIT_BYTES).ok).toBe(true);
    expect(checkSize(8 * 1024 * 1024).ok).toBe(true);
  });
});

describe("review gate", () => {
  const HEAD = "# Code review: abc1234";

  it("finds open high or critical items in any list style or under a High heading", () => {
    const md = [
      HEAD,
      "- [ ] high: SQL built from visitor input",
      "- [x] high: fixed already",
      "* [ ] **critical**: key in client bundle",
      "1. [ ] severity high, numbered list",
      "+ [ ] medium: naming",
      "## High",
      "- [ ] no severity word, but under the High heading",
      "## Low",
      "- [ ] fine",
    ].join("\n");
    expect(reviewProblems(md)).toEqual([
      "open high finding: - [ ] high: SQL built from visitor input",
      "open high finding: * [ ] **critical**: key in client bundle",
      "open high finding: 1. [ ] severity high, numbered list",
      "open high finding: - [ ] no severity word, but under the High heading",
    ]);
  });

  it("needs the sha header and at least one checklist line", () => {
    expect(reviewProblems("- [x] none")).toContain('first line must be "# Code review: <sha>"');
    expect(reviewProblems(`${HEAD}\n\nLooks fine.`)[0]).toMatch(/no checklist lines/);
    expect(reviewProblems(`${HEAD}\n- [x] none: no findings`)).toEqual([]);
  });

  it("covers the build when it is the build sha, or an ancestor changed only under review/", () => {
    const git = (diff: string, ancestor = true) => (args: string[]) => {
      if (args[0] === "merge-base" && !ancestor) throw new Error("not ancestor");
      return args[0] === "diff" ? diff : "";
    };
    expect(coversBuild("abc1234", "abc1234def", git(""))).toBe(true);
    expect(coversBuild("1111111", "abc1234def", git("review/code-review.md\n"))).toBe(true);
    expect(coversBuild("1111111", "abc1234def", git("review/code-review.md\nsrc/worker/llm.ts\n"))).toBe(false);
    expect(coversBuild("1111111", "abc1234def", git("", false))).toBe(false);
  });
});

describe("gate CLIs", () => {
  function repoWithReview() {
    const dir = tmp("review");
    const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    g("init", "-q");
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    writeFileSync(join(dir, "app.ts"), "1");
    g("add", "-A");
    g("commit", "-qm", "code");
    const reviewed = g("rev-parse", "HEAD");
    mkdirSync(join(dir, "review"));
    return { dir, g, reviewed };
  }

  it("check-review: missing file fails", () => {
    const { dir, reviewed } = repoWithReview();
    const r = node("check-review.mjs", ["review/code-review.md", reviewed], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is missing");
  });

  it("check-review: open high fails", () => {
    const { dir, reviewed } = repoWithReview();
    writeFileSync(join(dir, "review/code-review.md"), `# Code review: ${reviewed}\n- [ ] high: bad\n`);
    const r = node("check-review.mjs", ["review/code-review.md", reviewed], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("open high finding");
  });

  it("check-review: a review of an older commit fails once code changed after it", () => {
    const { dir, g, reviewed } = repoWithReview();
    writeFileSync(join(dir, "review/code-review.md"), `# Code review: ${reviewed.slice(0, 7)}\n- [x] none: no findings\n`);
    writeFileSync(join(dir, "app.ts"), "2");
    g("add", "-A");
    g("commit", "-qm", "more code");
    const r = node("check-review.mjs", ["review/code-review.md", g("rev-parse", "HEAD")], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("code changed after the review");
  });

  it("check-review: a clean review committed after the reviewed code passes", () => {
    const { dir, g, reviewed } = repoWithReview();
    writeFileSync(join(dir, "review/code-review.md"), `# Code review: ${reviewed.slice(0, 7)}\n- [x] high: fixed\n- [ ] low: later\n`);
    g("add", "-A");
    g("commit", "-qm", "review");
    const r = node("check-review.mjs", ["review/code-review.md", g("rev-parse", "HEAD")], dir);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("check-bundle: a dirty dir fails, from a path with spaces", () => {
    const dir = tmp("bundle");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "a.js"), `const u="${"postgres" + "://"}u:p@h/db"; const k="${"gsk" + "_"}abc"`);
    writeFileSync(join(dir, "index.html"), "<div>ok</div>");
    expect(scan(dir)).toEqual([`${join(dir, "assets", "a.js")}: postgres://`, `${join(dir, "assets", "a.js")}: gsk_`]);
    const r = node("check-bundle.mjs", [dir], ROOT);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("leaks server-only strings");
  });

  it("check-placeholders: the template fails, a filled-in Project passes", () => {
    const r = node("check-placeholders.mjs", [], ROOT);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('"Example Startup"');
    expect(r.stderr).toContain("at least 3 recorded runs");
    expect(r.stderr).toContain("template-placeholder");
    expect(r.stderr).toContain("Replace with");

    const dir = tmp("placeholders");
    mkdirSync(join(dir, "demo"));
    writeFileSync(join(dir, "project.json"), JSON.stringify({ startup: { name: "Acme AI" } }));
    writeFileSync(join(dir, "demo/runs.json"), JSON.stringify(RUNS));
    writeFileSync(join(dir, "README.md"), "# Acme\n");
    const ok = node("check-placeholders.mjs", [], dir);
    expect(ok.stderr).toBe("");
    expect(ok.status).toBe(0);
    expect(placeholderProblems((p: string) => (({ "project.json": "{}", "demo/runs.json": "[]", "README.md": "" }) as Record<string, string>)[p])).toEqual([
      "demo/runs.json needs at least 3 recorded runs",
    ]);
  });
});

describe("Neon provisioning", () => {
  it("builds the app connection string from the owner's", () => {
    const app = withRole(`${PG}neondb_owner:ownerpw@ep-x.us-east-2.aws.neon.tech/neondb?sslmode=require`, "app", "abc123");
    expect(app).toBe(`${PG}app:abc123@ep-x.us-east-2.aws.neon.tech/neondb?sslmode=require`);
  });

  it("hashes prompts the same regardless of case and spacing", () => {
    expect(promptHash("  Hello   World ")).toBe(promptHash("hello world"));
  });

  it("validates demo/runs.json shape", () => {
    expect(validateRuns(RUNS)).toBe(RUNS);
    expect(() => validateRuns({})).toThrow("must be a JSON array");
    expect(() => validateRuns([{ input: "a", output: 3, model: "m" }])).toThrow("demo/runs.json[0].output");
    expect(() => validateRuns([{ input: "a", output: "b" }])).toThrow("demo/runs.json[0].model");
  });

  function fakeDb(roleExists: boolean) {
    const calls: [string, unknown[] | undefined][] = [];
    const query = vi.fn(async (text: string, params?: unknown[]) => {
      calls.push([text, params]);
      return { rows: text.startsWith("SELECT 1 FROM pg_roles") && roleExists ? [{}] : [] };
    });
    const files: Record<string, string> = {
      "demo/runs.json": JSON.stringify(RUNS),
      "db/init.sql": "CREATE TABLE a (x int); -- trailing comment\nDO $$ BEGIN PERFORM 1; END $$;",
      "db/rls.sql": "GRANT SELECT ON a TO app;",
    };
    return { query, calls, readText: (p: string) => files[p] };
  }

  it("runs each SQL file whole, creates the role with a password, prunes and seeds demo_cache", async () => {
    const db = fakeDb(false);
    const r = await applyDatabase(db.query, { database: "neondb", rotate: false, readText: db.readText, newPassword: "beef" });
    expect(r).toEqual({ created: true, password: "beef", runs: 3 });
    const texts = db.calls.map((c) => c[0]);
    expect(texts[0]).toBe("CREATE TABLE a (x int); -- trailing comment\nDO $$ BEGIN PERFORM 1; END $$;");
    expect(texts).toContain("CREATE ROLE app WITH LOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'beef'");
    expect(texts).toContain("GRANT SELECT ON a TO app;");
    const prune = db.calls.find((c) => c[0].startsWith("DELETE FROM demo_cache"))!;
    expect(prune[1]).toEqual([RUNS.map((x) => promptHash(x.input))]);
    expect(texts.filter((t) => t.startsWith("INSERT INTO demo_cache"))).toHaveLength(3);
  });

  it("keeps an existing role's password unless asked to rotate", async () => {
    const kept = fakeDb(true);
    expect(await applyDatabase(kept.query, { database: "neondb", rotate: false, readText: kept.readText })).toMatchObject({ created: false, password: null });
    expect(kept.calls.some((c) => /ROLE app/.test(c[0]))).toBe(false);

    const rotated = fakeDb(true);
    const r = await applyDatabase(rotated.query, { database: "neondb", rotate: true, readText: rotated.readText, newPassword: "cafe" });
    expect(r).toMatchObject({ created: false, password: "cafe" });
    expect(rotated.calls.map((c) => c[0])).toContain("ALTER ROLE app WITH LOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'cafe'");
  });

  it("refuses bad demo runs before touching the database", async () => {
    const db = fakeDb(false);
    await expect(
      applyDatabase(db.query, { database: "neondb", rotate: false, readText: (p: string) => (p === "demo/runs.json" ? "[{}]" : "") }),
    ).rejects.toThrow("demo/runs.json[0].input");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("reuses a project found on a later page; creates one when absent; retries 423", async () => {
    const pages = vi.fn(async (url: string) => {
      const cursor = new URL(url).searchParams.get("cursor");
      if (!cursor) return new Response(JSON.stringify({ projects: [{ id: "p-1", name: "other" }], pagination: { cursor: "c1" } }), { status: 200 });
      return new Response(JSON.stringify({ projects: [{ id: "p-2", name: "acme-ai-demo" }], pagination: { cursor: "c2" } }), { status: 200 });
    });
    const found = await findOrCreateProject(neonClient("key", pages as unknown as typeof globalThis.fetch), { name: "acme-ai-demo" });
    expect(found).toEqual({ project: { id: "p-2", name: "acme-ai-demo" }, created: false });
    expect(String(pages.mock.calls[1][0])).toContain("cursor=c1");

    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "GET") {
        const more = !new URL(url).searchParams.get("cursor");
        return new Response(JSON.stringify({ projects: more ? [{ id: "p-old", name: "other" }] : [], pagination: { cursor: "c1" } }), { status: 200 });
      }
      if (fetch.mock.calls.filter((c) => (c[1] as RequestInit).method === "POST").length === 1) return new Response("locked", { status: 423 });
      return new Response(JSON.stringify({ project: { id: "p-new", name: JSON.parse(String(init.body)).project.name } }), { status: 201 });
    });
    const call = neonClient("key", fetch as unknown as typeof globalThis.fetch, async () => undefined);
    const r = await findOrCreateProject(call, { name: "acme-ai-demo", orgId: "org-1", region: "aws-us-east-2" });
    expect(r).toEqual({ project: { id: "p-new", name: "acme-ai-demo" }, created: true });
    expect(String(fetch.mock.calls[0][0])).toContain("org_id=org-1");
    const body = JSON.parse(String((fetch.mock.calls.at(-1)![1] as RequestInit).body));
    expect(body.project).toMatchObject({ name: "acme-ai-demo", org_id: "org-1", region_id: "aws-us-east-2" });
  });
});
