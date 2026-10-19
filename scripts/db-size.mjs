#!/usr/bin/env node
// Deploy gate: fail when this Project's database is over its 200 MB share (AD-6; 20 GB account / 100 projects).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { neon } from "@neondatabase/serverless";

export const LIMIT_BYTES = 200 * 1024 * 1024;

export function checkSize(bytes, limit = LIMIT_BYTES) {
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  if (bytes > limit) return { ok: false, message: `database is ${mb(bytes)} MB, over the ${mb(limit)} MB cap` };
  return { ok: true, message: `database is ${mb(bytes)} MB, under the ${mb(limit)} MB cap` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.env.NEON_OWNER_URL_FILE;
  const url = process.env.NEON_OWNER_URL ?? (file ? readFileSync(file, "utf8").trim() : "");
  if (!url) {
    console.error("::error::db-size needs NEON_OWNER_URL or NEON_OWNER_URL_FILE");
    process.exit(1);
  }
  const sql = neon(url);
  const rows = await sql`select pg_database_size(current_database())::bigint as bytes`;
  const result = checkSize(Number(rows[0].bytes));
  if (!result.ok) {
    console.error(`::error::${result.message}`);
    process.exit(1);
  }
  console.log(`db-size: ${result.message}`);
}
