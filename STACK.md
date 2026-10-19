# Stack

Every Project starts on this stack (AD-4, AD-17). Each layer names its pinned version and the dated
source that chose it. `tools/stack_check.py` diffs these pins and the free-tier pages weekly and only
flags changes; a full research run re-checks the stack monthly or every 25 Projects and opens a PR here.

Swapping a layer in a Project needs a `stack_note` in that Project's README saying why its Startup's problem needs it.

## Layers

| Layer | Pick | Version | Source (checked) |
| --- | --- | --- | --- |
| Runtime | Cloudflare Workers Free, static assets + API | wrangler 4.151.2 | developers.cloudflare.com/workers/platform/limits, npm (2026-10-19) |
| Deploy action | cloudflare/wrangler-action | v4 (v4.1.3) | github.com/cloudflare/wrangler-action/releases (2026-10-19) |
| SPA build | Vite | 8.3.4 | GitHub release (2026-10-19) |
| UI | React | 19.3.1 | npm; 19.3.0 stable since 2026-09-09 (2026-10-19) |
| API routes | Hono | 4.13.13 | hono.dev, npm (2026-10-19) |
| Styling | Tailwind CSS + @tailwindcss/vite | 4.3.3 | npm (2026-10-19) |
| Components | shadcn CLI, optional (`npx shadcn add <component>`) | 4.22.1 | npm (2026-10-19) |
| Database | Neon Postgres Free, one project per Project, `@neondatabase/serverless` over HTTP | 1.2.0 | neon.com/docs/introduction/plans, npm (2026-10-19) |
| ORM | drizzle-orm (neon-http); pgvector in the same database when needed | 0.45.4 | npm (2026-10-19) |
| LLM SDK | Vercel AI SDK `ai` | 7.0.145 | vercel.com/blog/ai-sdk-7, npm (2026-10-19) |
| Workers AI provider | workers-ai-provider | 4.0.0 | npm (2026-10-19) |
| AI Gateway provider | ai-gateway-provider (for Projects that route Groq/OpenRouter through a gateway) | 4.0.1 | npm (2026-10-19) |
| Groq provider | @ai-sdk/groq | 4.0.65 | npm (2026-10-19) |
| OpenRouter provider | @openrouter/ai-sdk-provider | 3.1.0 | research note winston-research-ai-tech, npm (2026-10-19) |
| Validation | Zod | 4.6.7 | npm (2026-10-19) |
| Evals (CI only) | promptfoo, `npm run eval` against the live URL | 0.124.1 | npm (2026-10-19) |
| Tracing | Langfuse Cloud Hobby, `@langfuse/tracing` (v6 too new per AD-17 rule 6) | server v4.64.0, SDK 5.14.0 | langfuse.com/pricing, npm (2026-10-19) |
| Build agent | anthropics/claude-code-action | v1 (1.0.253) | GitHub release (2026-10-19) |
| Secret scan | gitleaks | 8.30.1 | GitHub release (2026-10-19) |
| Tests | vitest | 5.0.5 | npm (2026-10-19) |
| Types | TypeScript | 7.0.2 | npm (2026-10-19) |

## LLM chain (AD-7)

`src/worker/llm.ts`, in order:

1. Per-visitor rate limit (Workers Rate Limiting binding `VISITOR_LIMIT`, 20 per 60 s). Over it: HTTP 429 `{"error":"slow down"}`.
2. Per-Project daily counter in Neon (`llm_usage`, cap `DAILY_LLM_CAP`, default 200). At the cap: demo mode, no provider is called.
3. Workers AI `@cf/google/gemma-4-26b-a4b-it` (binding `AI`; optional `AI_GATEWAY_ID` adds AI Gateway exact-match caching).
4. Groq `openai/gpt-oss-120b` (`GROQ_API_KEY`).
5. OpenRouter `openrouter/free` (`OPENROUTER_API_KEY`).
6. Demo mode: the closest recorded run from `demo_cache`, with the banner "Live AI quota reached, showing a recorded run".

A missing key or binding skips that provider. Any provider error (429 or other) falls through to the next.
No database, or a database error, fails closed to demo mode, served from `demo/runs.json` if `demo_cache` cannot be read.

Never on the live path: Gemini free tier (trains on prompts; EEA/UK/CH barred), Mistral Experiment (trains by default),
Cerebras (card), GitHub Models (retired 2026-07-30).

## Free limits that bite (2026-10-19)

| Limit | Project does |
| --- | --- |
| Workers Free: 100 Workers per account, 100k requests/day shared, 10 ms CPU | SPA is static assets (free); API rate-limited; retire after 14 quiet days (AD-8) |
| Workers AI: 10k neurons/day shared (~430 gemma-4 calls) | next provider |
| Groq free: 30/min, 1,000/day per model | next provider |
| OpenRouter `:free`: 50/day | demo mode |
| Neon Free: 100 projects, 1 GB each, 20 GB total | deploy fails over 200 MB per Project |
| Langfuse Hobby: 50k units/month | sample Project traces first |
| GitHub Actions and Pages | free for public repos |

## Allowed swaps (with a `stack_note`)

1. Cloudflare Agents SDK `agents` 0.28.1: stateful or realtime problems, or a remote MCP server.
2. `@mastra/core` 1.78.0: workflow-heavy problems.
3. TanStack Start 1.x: when SSR is needed.
4. Vectorize: tiny vector sets only.

Never: a card-only service, a paid tier, or Next/OpenNext.

## npm note

The lockfile installs with npm 10 and npm 11 (`npm ci`). Generating a fresh lockfile with npm 10.9 can hit an
arborist crash on optional peer chains; regenerate with `npx npm@11 install` if that happens.
`allowScripts` approves the esbuild and workerd install scripts for npm 11.
