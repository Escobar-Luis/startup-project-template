import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openHighFindings } from "../scripts/check-review.mjs";
import { LIMIT_BYTES, checkSize } from "../scripts/db-size.mjs";
import { scan } from "../scripts/check-bundle.mjs";
import { findOrCreateProject, neonClient, promptHash, splitSql, withRole } from "../scripts/provision-neon.mjs";

// Fixture URLs are split so the gitleaks postgres rule does not flag fake credentials.
const PG = "postgresql" + "://";

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
  it("counts only open high and critical findings", () => {
    const md = [
      "# Code review: abc123",
      "- [ ] high: SQL built from visitor input",
      "- [x] high: fixed already",
      "- [ ] **critical**: key in client bundle",
      "- [ ] medium: naming",
      "* [ ] High: capitalised still counts",
      "Text mentioning high risk is not a finding",
    ].join("\n");
    expect(openHighFindings(md)).toEqual([
      "- [ ] high: SQL built from visitor input",
      "- [ ] **critical**: key in client bundle",
      "* [ ] High: capitalised still counts",
    ]);
    expect(openHighFindings("- [x] high: done\n- [ ] low: later")).toEqual([]);
  });
});

describe("bundle check", () => {
  it("flags DATABASE_URL and postgres:// in built files", () => {
    const dir = mkdtempSync(join(tmpdir(), "bundle-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "a.js"), `const u="${"postgres" + "://"}u:p@h/db"`);
    writeFileSync(join(dir, "index.html"), "<div>ok</div>");
    expect(scan(dir)).toEqual([`${join(dir, "assets", "a.js")}: postgres://`]);
  });
});

describe("Neon provisioning helpers", () => {
  it("splits SQL files into statements and drops comment lines", () => {
    expect(splitSql("-- c\nCREATE TABLE a (x int);\nALTER TABLE a ENABLE ROW LEVEL SECURITY;\n")).toEqual([
      "CREATE TABLE a (x int)",
      "ALTER TABLE a ENABLE ROW LEVEL SECURITY",
    ]);
  });

  it("builds the app connection string from the owner's", () => {
    const app = withRole(`${PG}neondb_owner:ownerpw@ep-x.us-east-2.aws.neon.tech/neondb?sslmode=require`, "app", "abc123");
    expect(app).toBe(`${PG}app:abc123@ep-x.us-east-2.aws.neon.tech/neondb?sslmode=require`);
  });

  it("hashes prompts the same regardless of case and spacing", () => {
    expect(promptHash("  Hello   World ")).toBe(promptHash("hello world"));
  });

  it("reuses a project with the same name, else creates one; retries 423", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "GET") return new Response(JSON.stringify({ projects: [{ id: "p-old", name: "other" }] }), { status: 200 });
      if (fetch.mock.calls.filter((c) => (c[1] as RequestInit).method === "POST").length === 1) return new Response("locked", { status: 423 });
      return new Response(JSON.stringify({ project: { id: "p-new", name: JSON.parse(String(init.body)).project.name } }), { status: 201 });
    });
    const call = neonClient("key", fetch as unknown as typeof globalThis.fetch, async () => undefined);
    const r = await findOrCreateProject(call, { name: "acme-ai-demo", orgId: "org-1", region: "aws-us-east-2" });
    expect(r).toEqual({ project: { id: "p-new", name: "acme-ai-demo" }, created: true });
    expect(String(fetch.mock.calls[0][0])).toContain("search=acme-ai-demo");
    expect(String(fetch.mock.calls[0][0])).toContain("org_id=org-1");
    const body = JSON.parse(String((fetch.mock.calls.at(-1)![1] as RequestInit).body));
    expect(body.project).toMatchObject({ name: "acme-ai-demo", org_id: "org-1", region_id: "aws-us-east-2" });

    const reuse = vi.fn(async () => new Response(JSON.stringify({ projects: [{ id: "p-1", name: "acme-ai-demo" }] }), { status: 200 }));
    const r2 = await findOrCreateProject(neonClient("key", reuse as unknown as typeof globalThis.fetch), { name: "acme-ai-demo" });
    expect(r2).toEqual({ project: { id: "p-1", name: "acme-ai-demo" }, created: false });
  });
});
