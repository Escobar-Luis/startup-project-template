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
  GIT_SHA?: string;
}
