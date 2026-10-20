// Drizzle schema. db/init.sql creates the same tables; tests/repo.test.ts keeps them in step.
import { integer, pgTable, primaryKey, serial, text, timestamp, date } from "drizzle-orm/pg-core";

// Recorded example runs (AD-7 demo mode). Seeded from demo/runs.json at deploy.
export const demoCache = pgTable("demo_cache", {
  promptHash: text("prompt_hash").primaryKey(),
  input: text("input").notNull(),
  output: text("output").notNull(),
  model: text("model").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-Project daily LLM call counter (AD-7 step 2).
export const llmUsage = pgTable("llm_usage", {
  day: date("day").primaryKey(),
  calls: integer("calls").notNull().default(0),
});

// Visitor input. Row-level security is on (db/rls.sql): a visitor sees only their own rows.
export const submissions = pgTable("submissions", {
  id: serial("id").primaryKey(),
  visitor: text("visitor").notNull(),
  input: text("input").notNull(),
  output: text("output"),
  source: text("source"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-visitor calls per 1-minute window (AD-7 step 1 fallback): keyed by the HMAC visitor key, never the IP.
// Row-level security is on (db/rls.sql); windows older than an hour are pruned opportunistically.
export const visitorHits = pgTable(
  "visitor_hits",
  {
    visitor: text("visitor").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    hits: integer("hits").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.visitor, t.windowStart] })],
);
