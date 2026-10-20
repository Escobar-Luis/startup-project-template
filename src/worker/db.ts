import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";
import { demoCache } from "../../db/schema";
import type { Env } from "./env";

export interface DemoRow {
  input: string;
  output: string;
  model: string;
}

/** What llm() and the routes need from the database. Tests pass a fake. */
export interface Store {
  /** Atomically counts one live call for `day`. Returns false when the day is already at `cap`. */
  reserveCall(day: string, cap: number): Promise<boolean>;
  /** Atomically counts one call for `visitor` in the current 1-minute window (database clock).
   *  Returns false when the window is already at `limit`. */
  hitVisitor(visitor: string, limit: number): Promise<boolean>;
  /** Deletes visitor_hits windows older than an hour. Returns the number of rows removed. */
  pruneVisitorHits(): Promise<number>;
  demoRows(): Promise<DemoRow[]>;
  saveSubmission(visitor: string, input: string, output: string, source: string): Promise<void>;
  ping(): Promise<boolean>;
}

/** Neon over HTTP. DATABASE_URL is a Worker secret and never reaches client code (AD-6). */
export function neonStore(env: Env): Store | null {
  if (!env.DATABASE_URL) return null;
  const client: NeonQueryFunction<false, false> = neon(env.DATABASE_URL);
  const db = drizzle(client);
  return {
    async reserveCall(day, cap) {
      if (cap <= 0) return false;
      const rows = await client.query(
        `INSERT INTO llm_usage (day, calls) VALUES ($1, 1)
         ON CONFLICT (day) DO UPDATE SET calls = llm_usage.calls + 1
         WHERE llm_usage.calls < $2
         RETURNING calls`,
        [day, cap],
      );
      return rows.length > 0;
    },
    async hitVisitor(visitor, limit) {
      if (limit <= 0) return false;
      // RLS (db/rls.sql) checks app.visitor, so set it in the same transaction as the guarded upsert.
      const [, rows] = await client.transaction([
        client`SELECT set_config('app.visitor', ${visitor}, true)`,
        client`INSERT INTO visitor_hits (visitor, window_start, hits) VALUES (${visitor}, date_trunc('minute', now()), 1)
         ON CONFLICT (visitor, window_start) DO UPDATE SET hits = visitor_hits.hits + 1
         WHERE visitor_hits.hits < ${limit}
         RETURNING hits`,
      ]);
      return (rows as unknown[]).length > 0;
    },
    async pruneVisitorHits() {
      const rows = await client.query(
        `DELETE FROM visitor_hits WHERE window_start < now() - interval '1 hour' RETURNING 1`,
      );
      return rows.length;
    },
    async demoRows() {
      return db
        .select({ input: demoCache.input, output: demoCache.output, model: demoCache.model })
        .from(demoCache)
        .orderBy(demoCache.recordedAt);
    },
    async saveSubmission(visitor, input, output, source) {
      // RLS (db/rls.sql) checks app.visitor, so set it in the same transaction as the insert.
      await client.transaction([
        client`SELECT set_config('app.visitor', ${visitor}, true)`,
        client`INSERT INTO submissions (visitor, input, output, source) VALUES (${visitor}, ${input}, ${output}, ${source})`,
      ]);
    },
    async ping() {
      await db.execute(sql`select 1`);
      return true;
    },
  };
}
