#!/usr/bin/env node
// Creates (or finds) this Project's own Neon project, applies db/init.sql and db/rls.sql,
// creates the app role (NOBYPASSRLS, not the owner), seeds demo_cache from demo/runs.json,
// and writes the owner and app connection strings to files for the next deploy steps (AD-6).
// Idempotent: a re-run finds the project by name and rotates the app role's password.
//
// env: NEON_API_KEY (required), NEON_PROJECT_NAME (default: repo name), NEON_ORG_ID, NEON_REGION,
//      NEON_DATABASE (neondb), NEON_OWNER_ROLE (neondb_owner), OUT_DIR (default: RUNNER_TEMP or .)
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://console.neon.tech/api/v2";
export const APP_ROLE = "app";

export function splitSql(text) {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function promptHash(input) {
  return createHash("sha256").update(input.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex");
}

export function withRole(uri, role, password) {
  const u = new URL(uri);
  u.username = role;
  u.password = password;
  return u.toString();
}

export function neonClient(apiKey, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  return async function call(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      // 423: the project is busy with a previous operation; Neon asks callers to retry.
      if ((res.status === 423 || res.status === 429) && attempt < 10) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`Neon API ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : {};
    }
  };
}

/** @param {(method: string, path: string, body?: unknown) => Promise<any>} call
 *  @param {{ name: string, orgId?: string, region?: string }} opts */
export async function findOrCreateProject(call, { name, orgId, region }) {
  const q = new URLSearchParams({ search: name, limit: "100" });
  if (orgId) q.set("org_id", orgId);
  const found = (await call("GET", `/projects?${q}`)).projects?.find((p) => p.name === name);
  if (found) return { project: found, created: false };
  const project = { name, pg_version: 17, region_id: region };
  if (orgId) project.org_id = orgId;
  const res = await call("POST", "/projects", { project });
  return { project: res.project, created: true };
}

export async function ownerUri(call, projectId, database, role) {
  const q = new URLSearchParams({ database_name: database, role_name: role });
  return (await call("GET", `/projects/${projectId}/connection_uri?${q}`)).uri;
}

async function main() {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) {
    console.error("::error::missing NEON_API_KEY in GitHub Environment 'deploy'");
    process.exit(1);
  }
  const name = process.env.NEON_PROJECT_NAME || (process.env.GITHUB_REPOSITORY ?? "").split("/").pop();
  if (!name) throw new Error("set NEON_PROJECT_NAME");
  const database = process.env.NEON_DATABASE || "neondb";
  const ownerRole = process.env.NEON_OWNER_ROLE || "neondb_owner";
  const outDir = process.env.OUT_DIR || process.env.RUNNER_TEMP || ".";

  const call = neonClient(apiKey);
  const { project, created } = await findOrCreateProject(call, {
    name,
    orgId: process.env.NEON_ORG_ID,
    region: process.env.NEON_REGION || "aws-us-east-2",
  });
  console.log(`neon: project ${project.id} (${created ? "created" : "reused"}) for ${name}`);

  const owner = await ownerUri(call, project.id, database, ownerRole);
  const password = randomBytes(24).toString("hex");
  const app = withRole(owner, APP_ROLE, password);
  // Mask before anything could print them.
  for (const secret of [owner, app, password, new URL(owner).password]) console.log(`::add-mask::${secret}`);

  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(owner);
  for (const stmt of splitSql(readFileSync("db/init.sql", "utf8"))) await sql.query(stmt);

  const exists = await sql.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [APP_ROLE]);
  // Role DDL cannot take bind parameters; the password is hex only, so the literal is safe.
  const verb = exists.length ? "ALTER" : "CREATE";
  await sql.query(`${verb} ROLE ${APP_ROLE} WITH LOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
  await sql.query(`GRANT CONNECT ON DATABASE ${database} TO ${APP_ROLE}`);
  await sql.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  for (const stmt of splitSql(readFileSync("db/rls.sql", "utf8"))) await sql.query(stmt);

  const runs = JSON.parse(readFileSync("demo/runs.json", "utf8"));
  for (const run of runs) {
    await sql.query(
      `INSERT INTO demo_cache (prompt_hash, input, output, model, recorded_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (prompt_hash) DO UPDATE SET input = EXCLUDED.input, output = EXCLUDED.output,
         model = EXCLUDED.model, recorded_at = EXCLUDED.recorded_at`,
      [promptHash(run.input), run.input, run.output, run.model, run.recorded_at ?? new Date().toISOString()],
    );
  }
  console.log(`neon: schema, RLS and ${runs.length} demo run(s) applied; app role ready`);

  for (const [file, value] of [["neon-owner-url", owner], ["neon-app-url", app]]) {
    const path = join(outDir, file);
    writeFileSync(path, value);
    chmodSync(path, 0o600);
  }
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `project_id=${project.id}\n`, { flag: "a" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
