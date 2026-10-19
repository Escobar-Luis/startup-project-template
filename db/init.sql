-- Tables. Applied by scripts/provision-neon.mjs as the owner role; idempotent.
CREATE TABLE IF NOT EXISTS demo_cache (
  prompt_hash text PRIMARY KEY,
  input text NOT NULL,
  output text NOT NULL,
  model text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS llm_usage (
  day date PRIMARY KEY,
  calls integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS submissions (
  id serial PRIMARY KEY,
  visitor text NOT NULL,
  input text NOT NULL,
  output text,
  source text,
  created_at timestamptz NOT NULL DEFAULT now()
);
