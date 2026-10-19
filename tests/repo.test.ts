import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";
import { footerText, type ProjectInfo } from "../src/web/project";

const read = (p: string) => readFileSync(p, "utf8");

describe("ship.yml (AD-5)", () => {
  const yml = read(".github/workflows/ship.yml");

  it("triggers only on workflow_dispatch and pushes to main, never pull_request_target", () => {
    expect(yml).toMatch(/^on:\n  workflow_dispatch:/m);
    expect(yml).toMatch(/^  push:\n    branches: \[main\]/m);
    expect(yml).not.toMatch(/^\s*pull_request_target:/m);
    expect(yml).not.toMatch(/^\s*pull_request:/m);
    expect(yml).toContain("github.actor == github.repository_owner");
  });

  it("build job: env build, claude-code-action with OAuth token and max turns, timeout, gitleaks before push", () => {
    const build = yml.slice(yml.indexOf("\n  build:"), yml.indexOf("\n  deploy:"));
    expect(build).toContain("environment: build");
    expect(build).toContain("timeout-minutes: ${{ fromJSON(inputs.timeout_minutes || '60') }}");
    expect(build).toContain("uses: anthropics/claude-code-action@v1");
    expect(build).toContain("claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
    expect(build).toContain("--max-turns ${{ inputs.max_turns }}");
    expect(build).not.toMatch(/CLOUDFLARE|NEON_API_KEY|GROQ_API_KEY|OPENROUTER_API_KEY/);
    expect(build.indexOf("gitleaks git")).toBeGreaterThan(0);
    expect(build.indexOf("gitleaks git")).toBeLessThan(build.indexOf("git push \"https"));
    expect(build).toContain("persist-credentials: false");
  });

  it("no secrets: build fails first with a clear missing CLAUDE_CODE_OAUTH_TOKEN message", () => {
    const build = yml.slice(yml.indexOf("\n  build:"), yml.indexOf("\n  deploy:"));
    const steps = build.slice(build.indexOf("steps:"));
    const first = steps.slice(0, steps.indexOf("- uses: actions/checkout"));
    expect(first).toContain('if [ -z "$TOKEN" ]');
    expect(first).toContain("::error::missing CLAUDE_CODE_OAUTH_TOKEN");
    expect(first).toContain("exit 1");
  });

  it("deploy job: needs build, env deploy, review and size gates before wrangler, then Pages", () => {
    const deploy = yml.slice(yml.indexOf("\n  deploy:"));
    expect(deploy).toContain("needs: build");
    expect(deploy).toContain("environment: deploy");
    const order = [
      "scripts/check-review.mjs",
      "scripts/provision-neon.mjs",
      "scripts/db-size.mjs",
      "uses: cloudflare/wrangler-action@v4",
      "wrangler secret put DATABASE_URL",
      "deployed.json",
      "git init -q -b gh-pages",
    ].map((s) => deploy.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(deploy).toContain('wranglerVersion: "4.151.2"');
  });
});

describe("database (AD-6)", () => {
  const init = read("db/init.sql");
  const rls = read("db/rls.sql");

  it("db/schema.ts and db/init.sql define the same tables and columns", () => {
    for (const table of Object.values(schema)) {
      const cfg = getTableConfig(table);
      const block = init.slice(init.indexOf(`CREATE TABLE IF NOT EXISTS ${cfg.name} (`));
      const body = block.slice(0, block.indexOf(");"));
      expect(body, cfg.name).not.toBe("");
      for (const col of cfg.columns) expect(body, `${cfg.name}.${col.name}`).toMatch(new RegExp(`\\n  ${col.name} `));
    }
  });

  it("row-level security is on for the visitor-input table, and the app role cannot bypass it", () => {
    expect(rls).toContain("ALTER TABLE submissions ENABLE ROW LEVEL SECURITY");
    expect(rls).toContain("ALTER TABLE submissions FORCE ROW LEVEL SECURITY");
    expect(rls).toMatch(/CREATE POLICY submissions_select_own ON submissions FOR SELECT TO app\s+USING \(visitor = current_setting\('app.visitor', true\)\)/);
    expect(read("scripts/provision-neon.mjs")).toContain("NOBYPASSRLS");
  });
});

describe("brand and project.json (FR-6, AD-4)", () => {
  const project = JSON.parse(read("project.json")) as ProjectInfo;

  it("project.json has the Startup name, colors and problem", () => {
    expect(project.startup.name).toBeTruthy();
    expect(project.problem).toBeTruthy();
    for (const k of ["primary", "accent", "background", "text"] as const) expect(project.colors[k]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("footer names the company from project.json", () => {
    expect(footerText(project)).toBe(`independent demo by Luis Escobar, not affiliated with ${project.startup.name}`);
    expect(footerText({ ...project, startup: { name: "Acme AI", domain: "acme.ai" } })).toBe(
      "independent demo by Luis Escobar, not affiliated with Acme AI",
    );
    expect(read("pages/index.html")).toContain("independent demo by Luis Escobar, not affiliated with ");
  });

  it("ships no logos or brand images", () => {
    const images: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        if (["node_modules", ".git", "dist", ".wrangler"].includes(n)) continue;
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(png|jpe?g|gif|svg|webp|ico|avif)$/i.test(n)) images.push(p);
      }
    };
    walk(".");
    expect(images).toEqual([]);
  });

  it("the web app never imports Worker code", () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    for (const f of walk("src/web")) expect(read(f), f).not.toMatch(/from ["'][^"']*worker/);
  });
});

describe("stack pins (AD-17)", () => {
  it("package.json pins the spine's exact versions", () => {
    const pkg = JSON.parse(read("package.json"));
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(all).toMatchObject({
      wrangler: "4.151.2",
      vite: "8.3.4",
      react: "19.3.1",
      hono: "4.13.13",
      tailwindcss: "4.3.3",
      shadcn: "4.22.1",
      "@neondatabase/serverless": "1.2.0",
      "drizzle-orm": "0.45.4",
      ai: "7.0.145",
      "workers-ai-provider": "4.0.0",
      "ai-gateway-provider": "4.0.1",
      zod: "4.6.7",
      promptfoo: "0.124.1",
      "@langfuse/tracing": "5.14.0",
    });
    for (const [name, v] of Object.entries(all)) expect(v, name).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies.promptfoo).toBe("0.124.1");
  });
});
