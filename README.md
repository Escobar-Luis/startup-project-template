# startup-project-template

The template every Project starts from: a live, $0, full-stack demo with its own database, a stable link and a demo mode.
`gh repo create <name> --public --template Escobar-Luis/startup-project-template`.

## Problem

Replace with the Startup's problem: who hurts, and how much, in two or three sentences.

## Evidence

Replace with the evidence for the problem, each item with its source link and date.

## What was built

The template ships:

1. A Vite + React + Tailwind single-page app served as Workers static assets, reading `project.json` for the Startup name, colors and problem.
2. A Hono API on the same Worker under `/api/*`, plus `/health` (`{ok, db, sha}`, always 200).
3. `llm()` (`src/worker/llm.ts`): per-visitor rate limit, a daily counter in Neon, then Workers AI, Groq and OpenRouter free tiers, then demo mode with the banner "Live AI quota reached, showing a recorded run".
4. Neon Postgres per Project through drizzle over HTTP, with row-level security on visitor input (`db/rls.sql`).
5. `.github/workflows/ship.yml`: a `build` job (Claude Code action, tests, build, gitleaks, push) and a `deploy` job (review gate, Neon provisioning, size gate, wrangler deploy, secrets, `deployed.json`, GitHub Pages).
6. A GitHub Pages front (`pages/index.html`) that sends visitors to the live Worker when it answers and shows the recorded runs when it does not. It is the link to share; it outlives the Worker.

The footer reads "independent demo by Luis Escobar, not affiliated with <company>".

## How to run

```bash
npm ci
npm test          # vitest; providers and the database are mocked
npm run build     # type-check, Vite build to dist/, and a check that no secret reached dist/
npm run build:worker   # wrangler dry-run bundle of the Worker
```

Deploys run only in GitHub Actions (`ship.yml`), never on a laptop. One-time setup per Project:

```bash
gh secret set CLAUDE_CODE_OAUTH_TOKEN --env build
gh secret set CLOUDFLARE_API_TOKEN --env deploy     # Workers Scripts:Edit
gh secret set CLOUDFLARE_ACCOUNT_ID --env deploy
gh secret set NEON_API_KEY --env deploy
gh secret set GROQ_API_KEY --env deploy             # optional
gh secret set OPENROUTER_API_KEY --env deploy       # optional
gh workflow run ship.yml -f max_turns=80 -f timeout_minutes=60
```

Pages is served from the `gh-pages` branch, which the deploy job writes.

## stack_note

None: this Project uses the template stack in `STACK.md` unchanged.
