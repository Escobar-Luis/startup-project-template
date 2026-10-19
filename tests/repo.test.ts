import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";
import { footerText, type ProjectInfo } from "../src/web/project";

const read = (p: string) => readFileSync(p, "utf8");

describe("ship.yml (AD-5)", () => {
  const yml = read(".github/workflows/ship.yml");
  const job = (name: string, next?: string) => yml.slice(yml.indexOf(`\n  ${name}:`), next ? yml.indexOf(`\n  ${next}:`) : undefined);
  const build = job("build", "publish");
  const publish = job("publish", "render-clip");
  const deploy = job("deploy");
  const inOrder = (text: string, marks: string[]) => {
    const at = marks.map((m) => text.indexOf(m));
    expect(at.every((i) => i > 0), JSON.stringify(marks.filter((_, i) => at[i] <= 0))).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  };

  it("triggers only on workflow_dispatch and pushes to main, never pull_request_target", () => {
    expect(yml).toMatch(/^on:\n  workflow_dispatch:/m);
    expect(yml).toMatch(/^  push:\n    branches: \[main\]/m);
    expect(yml).not.toMatch(/^\s*pull_request_target:/m);
    expect(yml).not.toMatch(/^\s*pull_request:/m);
    expect(yml).toContain("github.actor == github.repository_owner");
  });

  it("build job: env build, read-only token, claude-code-action with OAuth token and max turns, no push", () => {
    expect(build).toContain("environment: build");
    expect(build).toContain("timeout-minutes: ${{ fromJSON(inputs.timeout_minutes || '60') }}");
    expect(build).toMatch(/permissions:\n      contents: read/);
    expect(build).not.toContain("contents: write");
    expect(build).toContain("uses: anthropics/claude-code-action@v1");
    expect(build).toContain("claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
    expect(build).toContain("--max-turns ${{ inputs.max_turns }}");
    expect(build).not.toMatch(/CLOUDFLARE|NEON_API_KEY|GROQ_API_KEY|OPENROUTER_API_KEY/);
    expect(build).not.toContain('git push "https');
    expect(build).toContain("persist-credentials: false");
  });

  it("no secrets: build fails first with a clear missing CLAUDE_CODE_OAUTH_TOKEN message; non-main dispatch refused", () => {
    const steps = build.slice(build.indexOf("steps:"));
    const first = steps.slice(0, steps.indexOf("- name: Refuse dispatch"));
    expect(first).toContain('if [ -z "$TOKEN" ]');
    expect(first).toContain("::error::missing CLAUDE_CODE_OAUTH_TOKEN");
    expect(first).toContain("exit 1");
    expect(build).toContain("github.event_name == 'workflow_dispatch' && github.ref != 'refs/heads/main'");
    inOrder(build, ["Refuse dispatch", "uses: actions/checkout", "anthropics/claude-code-action"]);
  });

  it("publish job: protected paths, rebase, tests, gitleaks, then push", () => {
    expect(publish).toContain("needs: build");
    expect(publish).toContain("contents: write");
    expect(yml).toContain('PROTECTED_PATHS: ".gitleaks.toml .gitleaksignore scripts/ .github/ .claude/skills/project-explainer/ tests/explainer.test.ts"');
    inOrder(publish, ["git diff --name-only \"$START\" \"$AGENT\" -- $PROTECTED_PATHS", "git rebase origin/main", "npm test", "\"$GITLEAKS\" git", 'git push "https']);
  });

  it("deploy job: gates before any change, secrets in the same version as the deploy, db:true smoke check, Pages", () => {
    expect(deploy).toContain("needs: [publish, render-clip]");
    expect(deploy).toContain("needs.publish.result == 'success'");
    expect(deploy).toContain("environment: deploy");
    inOrder(deploy, [
      "scripts/check-review.mjs review/code-review.md",
      "scripts/check-placeholders.mjs",
      "Pages not enabled: the build step (story 3.9) enables it with \\`gh api\\` from the Mac",
      "provision-neon.mjs connect",
      "scripts/db-size.mjs",
      "provision-neon.mjs apply",
      "\"$GITLEAKS\" dir --config .gitleaks.toml --redact --exit-code 1 dist",
      "namespace_id",
      "--secrets-file",
      "jq -e '.db == true'",
      "git init -q -b gh-pages",
    ]);
    expect(deploy).toContain('wranglerVersion: "4.151.2"');
    expect(deploy).not.toContain("wrangler secret put");
    expect(deploy).not.toContain("|| true\n");
    expect(deploy).toContain('if [ -z "$LIVE_URL" ]; then echo "::error::wrangler reported no deployment URL"; exit 1; fi');
  });
});

describe("explainer and clip in ship.yml (AD-13, story 3.8)", () => {
  const yml = read(".github/workflows/ship.yml");
  const job = (name: string, next?: string) => yml.slice(yml.indexOf(`\n  ${name}:`), next ? yml.indexOf(`\n  ${next}:`) : undefined);
  const build = job("build", "publish");
  const clip = job("render-clip", "deploy");
  const deploy = job("deploy");

  it("build runs the project-explainer skill after the build agent, then records its tokens", () => {
    const agent = build.indexOf("- name: Build agent");
    const explainer = build.indexOf("- name: Explainer agent (project-explainer skill)");
    const usage = build.indexOf("scripts/explainer-usage.mjs");
    const bundle = build.indexOf("- name: Bundle the agent's commits");
    expect(agent).toBeGreaterThan(0);
    expect(explainer).toBeGreaterThan(agent);
    expect(usage).toBeGreaterThan(explainer);
    expect(bundle).toBeGreaterThan(usage);
    expect(build.slice(explainer, usage)).toContain(".claude/skills/project-explainer/SKILL.md");
    expect(build.slice(explainer, usage)).toContain('--disallowedTools "Bash(git push:*)"');
    expect(build).toContain("review/explainer-usage.json");
  });

  it("render-clip is best effort: after publish, continue-on-error, no secrets, skips with a reason", () => {
    expect(clip).toContain("needs: publish");
    expect(clip).toContain("continue-on-error: true");
    expect(clip).not.toMatch(/secrets\.|environment:/);
    expect(clip).toMatch(/HYPERFRAMES_VERSION: "\d+\.\d+\.\d+"/);
    expect(clip).toContain('echo "clip: skipped ($1)" | tee -a "$GITHUB_STEP_SUMMARY"');
    expect(clip).toContain("exit 0");
    expect(clip).toContain("node scripts/build-clip.mjs");
    expect(clip).toContain("--workers 1");
  });

  it("deploy never needs the clip, and ships it when it exists", () => {
    expect(deploy).toContain("!cancelled() && needs.publish.result == 'success'");
    expect(deploy).toContain("if: needs.render-clip.outputs.rendered == 'true'");
    const take = deploy.indexOf("Take the how-it-works clip");
    expect(take).toBeGreaterThan(0);
    expect(take).toBeLessThan(deploy.indexOf("- run: npm run build"));
    expect(deploy).toContain("for f in public/explainer.html public/how-it-works.mp4");
  });

  it("an explainer failure keeps the build agent's work, and only the explainer's files survive it", () => {
    const step = build.slice(build.indexOf("- name: Explainer agent"), build.indexOf("- name: Keep only the explainer's files"));
    expect(step).toContain("continue-on-error: true");
    const keep = build.slice(build.indexOf("- name: Keep only the explainer's files"), build.indexOf("- name: Record the explainer's tokens"));
    expect(keep).toContain('git reset -q --soft "$PRE"');
    expect(keep).toContain("git add -A -- public/explainer.json public/explainer.html review/");
    expect(keep).toContain("git clean -fdq");
    expect(build.indexOf("- name: Commit anything the agent left uncommitted")).toBeLessThan(build.indexOf("- name: Explainer agent"));
    for (const name of ["Record the explainer's tokens", "Bundle the agent's commits", "Keep only the explainer's files"]) {
      const at = build.indexOf(`- name: ${name}`);
      expect(build.slice(at, build.indexOf("\n      - ", at + 1)), name).toMatch(/if: always\(\)/);
    }
    expect(build).toContain("set repo in project.json to https://github.com/{0}");
  });

  it("render-clip skips the template repo and a Project still holding the sample", () => {
    expect(clip).toContain("if: github.event.repository.is_template != true");
    expect(clip).toContain('skip "public/explainer.json is still the template\'s sample"');
  });

  it("the publish gate protects the explainer shell and its tests", () => {
    expect(yml).toContain('PROTECTED_PATHS: ".gitleaks.toml .gitleaksignore scripts/ .github/ .claude/skills/project-explainer/ tests/explainer.test.ts"');
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

  it("tables the build agent adds are reachable by the app role", () => {
    expect(rls).toContain("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO app");
    expect(rls).toContain("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO app");
    expect(read("AGENTS.md")).toContain("ENABLE` and `FORCE ROW LEVEL SECURITY");
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
