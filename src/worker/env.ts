export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  AI?: Ai;
  ASSETS?: Fetcher;
  VISITOR_LIMIT?: RateLimiter;
  DATABASE_URL?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  AI_GATEWAY_ID?: string;
  /** Per-Project secret for HMAC visitor keys; the deploy job generates it once. */
  VISITOR_PEPPER?: string;
  DAILY_LLM_CAP?: string;
  /** Per-visitor LLM calls per minute, enforced in Neon (visitor_hits); default 20. */
  VISITOR_LIMIT_PER_MIN?: string;
  GIT_SHA?: string;
  /** owner/repo, set by the deploy job (`--var PROJECT_REPO`): Langfuse tags each LLM call `project:<repo>`. */
  PROJECT_REPO?: string;
  /** Optional: with both keys, llm() sends one Langfuse generation per provider attempt (src/worker/trace.ts). */
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_HOST?: string;
}
