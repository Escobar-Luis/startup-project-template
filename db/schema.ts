// Drizzle schema. db/init.sql creates the same tables; tests/schema.test.ts keeps them in step.
import { integer, pgTable, serial, text, timestamp, date } from "drizzle-orm/pg-core";

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
