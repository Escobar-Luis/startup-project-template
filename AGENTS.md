# Build agent rules

North-star deck (the problem, evidence and our answer): <deck link, filled in per Project; none yet>

You are building one Project: a small, live, $0 full-stack demo that shows a fix for one Startup's problem.
These rules bind every agent working in this repo.

## Loop (BMad)

1. Read `project.json`, `README.md` and anything under `docs/` (the Startup's problem, evidence and pick).
2. Write a short spec in `docs/spec.md`, then stories, then build one story at a time.
3. Log every decision and every answered question in `docs/memlog.md`.
4. Run `npm test` and `npm run build` until both pass. Add a vitest test for each new behavior.
5. Review your own diff and write `review/code-review.md` (format below). Fix every high finding.
6. Commit with conventional prefixes (`feat:`, `fix:`, `test:`, `docs:`, `chore:`) naming the Startup id. Never push; the workflow pushes after gitleaks.

## Research before asking; never invent

1. An open question about the domain, a vendor or an API: research it (docs, the Startup's public site) and log the answer with its source in `docs/memlog.md`.
2. A fact you cannot find: write it as an open question in `docs/memlog.md`. Never fill a plausible guess.
3. Never invent facts about the Startup, its customers, its numbers, or about Luis.

## Stack

1. Use the layers in `STACK.md` at their pinned versions. A swap needs a `stack_note` in the README naming why this problem needs it.
2. Every LLM call goes through `llm()` in `src/worker/llm.ts`. Never call a provider directly. `llm()` already traces each call to Langfuse (`src/worker/trace.ts`); pass the Worker's `waitUntil` when you call it from a new route.
   Its per-visitor limit is enforced in the Project's own Neon database (`visitor_hits`, `VISITOR_LIMIT_PER_MIN`, default 20 per minute):
   the Workers Rate Limiting binding did not enforce on Workers Free (2026-10-20 smoke test on https://epic3-smoke-test.lae311.workers.dev,
   30 concurrent POSTs from one IP all got 200). Never remove the Neon limiter or rely on the binding alone.
3. Never add a card-only service, a paid tier, or Next/OpenNext.
4. The database URL and all keys live only in the Worker (`env`). Never import `src/worker` from `src/web`, and never put a key or a `postgres://` string in client code or in the repo.
5. A new table goes in `db/init.sql` and `db/schema.ts`. The app role gets SELECT, INSERT and UPDATE on it by default (`db/rls.sql`); narrow that with REVOKE/GRANT in `db/rls.sql` when the Worker needs less. A table that holds visitor input also gets `ENABLE` and `FORCE ROW LEVEL SECURITY` and a policy keyed on `current_setting('app.visitor', true)` in `db/rls.sql`, like `submissions`.
6. Heavy compute happens at build time and is committed; a Worker request has 10 ms of CPU.
7. Never change `.gitleaks.toml`, `.gitleaksignore`, `scripts/` or `.github/`. The publish job refuses the whole build if you do.

## Brand and honesty

1. No logos, trademarks, brand images or brand fonts of the Startup or anyone else.
2. Keep the footer: "independent demo by Luis Escobar, not affiliated with <company>" (set from `project.json`).
3. Claim in the README only what the Project actually does.
4. This repo is public. Never name the companies, postings or job IDs Luis is applying to in any committed file (docs, planning output, code, commit messages, PR text); describe roles by type ("applied AI engineer"). Public facts about a company used as problem evidence are fine, as long as nothing ties them to his applications. Check the diff for this before every commit.

## Files you fill in

1. `project.json`: the Startup name and domain, a title, the problem in one sentence, colors (not the Startup's brand colors).
2. `demo/runs.json`: 3-5 recorded runs (`input`, `output`, `model`, `recorded_at`). Each output must be a real model output, and `model` must name the model that produced it.
3. `README.md`: the sections problem, evidence, what was built, how to run, stack_note.
4. `public/explainer.json`: the architecture explainer's data (AD-13), written by the `project-explainer` skill
   (`.claude/skills/project-explainer/SKILL.md`). `npm run build` checks it and builds `public/explainer.html`.
   Make the explainer last, after the code is done: in Actions, the build job's explainer step runs the skill after
   you finish (it may change only the two explainer files after your review); in a local session, run the skill
   yourself as the last step. The tour order is the talk-track order. Set `repo` in `project.json` to
   `https://github.com/<owner>/<repo>` (`$GITHUB_REPOSITORY`) during your build so the explainer links files.
5. `review/code-review.md`, written last, after your final code commit. The deploy job checks it:
   - the first line is `# Code review: <sha>`, the commit you reviewed; only `review/` may change after it;
   - at least one checklist line; write `- [x] none: no findings` if there are none;
   - no unchecked line that mentions high or critical, and no unchecked line under a High or Critical heading.

```markdown
# Code review: <full or short sha>

- [x] high: <finding>, fixed in <commit>
- [ ] medium: <finding>
- [ ] low: <finding>
```

6. Placeholders: the deploy refuses while `project.json` names "Example Startup" or the template repo, `demo/runs.json` has fewer than 3 runs or a `template-placeholder` run, `public/explainer.json` is still the template's sample, or the README still says "Replace with".

## How-it-works clip

After publish, the best-effort `render-clip` job turns `public/explainer.json` into a ~30 s captioned clip
(`scripts/build-clip.mjs`, HyperFrames in a headless Chrome on the runner) and the deploy ships it as
`how-it-works.mp4` when it rendered. A failed render never fails the deploy; the job summary says `clip: skipped (<reason>)` when it could not render.

## GitHub Pages

The deploy job publishes the stable front to the `gh-pages` branch, and fails with "Pages not enabled" if Pages is off.
Its token cannot enable Pages; the build step (story 3.9) does it once from the Mac (see README).
