#!/usr/bin/env node
// This Project's own Neon database (AD-6), in two phases so the size gate runs before anything changes:
//
//   node scripts/provision-neon.mjs connect   find (or create) the Neon project by name; write the owner URL
//   node scripts/provision-neon.mjs apply     apply db/init.sql and db/rls.sql, make sure the app role exists,
//                                             seed demo_cache from demo/runs.json; write the app URL only when
//                                             the app password was set (role created, or ROTATE_APP_PASSWORD=1)
//
// The app role is created by SQL (roles made through the Neon API join neon_superuser) with NOBYPASSRLS.
// Its password is set only when the role is created, or when the Worker has no DATABASE_URL yet
// (ROTATE_APP_PASSWORD=1), so a later failing step never strands the live Worker with a dead password.
//
// env: NEON_API_KEY (connect), NEON_PROJECT_NAME (default: repo name), NEON_ORG_ID, NEON_REGION,
//      NEON_DATABASE (neondb), NEON_OWNER_ROLE (neondb_owner), OUT_DIR (default: RUNNER_TEMP or .),
//      ROTATE_APP_PASSWORD (apply)
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const API = "https://console.neon.tech/api/v2";
export const APP_ROLE = "app";

export function promptHash(input) {
  return createHash("sha256").update(input.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex");
}

export function withRole(uri, role, password) {
  const u = new URL(uri);
  u.username = role;
  u.password = password;
  return u.toString();
}

/** demo/runs.json must be an array of {input, output, model} strings (recorded_at optional). */
export function validateRuns(runs) {
  if (!Array.isArray(runs)) throw new Error("demo/runs.json must be a JSON array");
  runs.forEach((r, i) => {
    for (const k of ["input", "output", "model"]) {
      if (!r || typeof r[k] !== "string" || !r[k].trim()) throw new Error(`demo/runs.json[${i}].${k} must be a non-empty string`);
    }
    if (r.recorded_at !== undefined && typeof r.recorded_at !== "string") {
      throw new Error(`demo/runs.json[${i}].recorded_at must be a string`);
    }
  });
  return runs;
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
  let cursor;
  const seen = new Set();
  for (;;) {
    const q = new URLSearchParams({ search: name, limit: "100" });
    if (orgId) q.set("org_id", orgId);
    if (cursor) q.set("cursor", cursor);
    const page = await call("GET", `/projects?${q}`);
    const found = page.projects?.find((p) => p.name === name);
    if (found) return { project: found, created: false };
    cursor = page.pagination?.cursor;
    if (!page.projects?.length || !cursor || seen.has(cursor)) break;
    seen.add(cursor);
  }
  const project = { name, pg_version: 17, region_id: region };
  if (orgId) project.org_id = orgId;
  const res = await call("POST", "/projects", { project });
  return { project: res.project, created: true };
}

export async function ownerUri(call, projectId, database, role) {
  const q = new URLSearchParams({ database_name: database, role_name: role });
  return (await call("GET", `/projects/${projectId}/connection_uri?${q}`)).uri;
}

function writeSecretFile(path, value) {
  writeFileSync(path, value);
  chmodSync(path, 0o600);
}

async function connect(outDir) {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) throw new Error("missing NEON_API_KEY in GitHub Environment 'deploy'");
  const name = process.env.NEON_PROJECT_NAME || (process.env.GITHUB_REPOSITORY ?? "").split("/").pop();
  if (!name) throw new Error("set NEON_PROJECT_NAME");
  const call = neonClient(apiKey);
  const { project, created } = await findOrCreateProject(call, {
    name,
    orgId: process.env.NEON_ORG_ID || undefined,
    region: process.env.NEON_REGION || "aws-us-east-2",
  });
  console.log(`neon: project ${project.id} (${created ? "created" : "reused"}) for ${name}`);
  const owner = await ownerUri(call, project.id, process.env.NEON_DATABASE || "neondb", process.env.NEON_OWNER_ROLE || "neondb_owner");
  console.log(`::add-mask::${owner}`);
  console.log(`::add-mask::${new URL(owner).password}`);
  writeSecretFile(join(outDir, "neon-owner-url"), owner);
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `project_id=${project.id}\n`, { flag: "a" });
}

/** Applies schema, RLS, the app role and demo runs. `query(text, params?)` runs on one owner connection;
 *  each SQL file goes in as one multi-statement query (no splitting, so $$ bodies and comments are safe). */
/** @param {(text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>} query
 *  @param {{ database: string, rotate: boolean, readText?: (p: string) => string, newPassword?: string }} opts */
export async function applyDatabase(query, { database, rotate, readText = (p) => readFileSync(p, "utf8"), newPassword }) {
  const runs = validateRuns(JSON.parse(readText("demo/runs.json")));
  await query(readText("db/init.sql"));

  const exists = (await query("SELECT 1 FROM pg_roles WHERE rolname = $1", [APP_ROLE])).rows.length > 0;
  let password = null;
  if (!exists || rotate) {
    password = newPassword ?? randomBytes(24).toString("hex");
    // Role DDL cannot take bind parameters; the password is hex only, so the literal is safe.
    const verb = exists ? "ALTER" : "CREATE";
    await query(`${verb} ROLE ${APP_ROLE} WITH LOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
  }
  await query(`GRANT CONNECT ON DATABASE ${database} TO ${APP_ROLE}; GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await query(readText("db/rls.sql"));

  const hashes = runs.map((r) => promptHash(r.input));
  await query("DELETE FROM demo_cache WHERE NOT (prompt_hash = ANY($1::text[]))", [hashes]);
  for (const [i, run] of runs.entries()) {
    await query(
      `INSERT INTO demo_cache (prompt_hash, input, output, model, recorded_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (prompt_hash) DO UPDATE SET input = EXCLUDED.input, output = EXCLUDED.output,
         model = EXCLUDED.model, recorded_at = EXCLUDED.recorded_at`,
      [hashes[i], run.input, run.output, run.model, run.recorded_at ?? new Date().toISOString()],
    );
  }
  return { created: !exists, password, runs: runs.length };
}

async function apply(outDir) {
  const ownerFile = join(outDir, "neon-owner-url");
  if (!existsSync(ownerFile)) throw new Error("run 'provision-neon.mjs connect' first");
  const owner = readFileSync(ownerFile, "utf8").trim();
  const { Pool, neonConfig } = await import("@neondatabase/serverless");
  if (globalThis.WebSocket) neonConfig.webSocketConstructor = globalThis.WebSocket;
  const pool = new Pool({ connectionString: owner });
  const client = await pool.connect();
  try {
    const result = await applyDatabase((text, params) => client.query(text, params), {
      database: process.env.NEON_DATABASE || "neondb",
      rotate: process.env.ROTATE_APP_PASSWORD === "1",
    });
    if (result.password) {
      const app = withRole(owner, APP_ROLE, result.password);
      console.log(`::add-mask::${result.password}`);
      console.log(`::add-mask::${app}`);
      writeSecretFile(join(outDir, "neon-app-url"), app);
    }
    console.log(
      `neon: schema, RLS and ${result.runs} demo run(s) applied; app role ${result.created ? "created" : result.password ? "password rotated" : "kept"}`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const phase = process.argv[2];
  const outDir = process.env.OUT_DIR || process.env.RUNNER_TEMP || ".";
  const run = phase === "connect" ? connect : phase === "apply" ? apply : null;
  if (!run) {
    console.error("usage: provision-neon.mjs connect|apply");
    process.exit(2);
  }
  run(outDir).catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
