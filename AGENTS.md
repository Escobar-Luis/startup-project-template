# Build agent rules

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
2. Every LLM call goes through `llm()` in `src/worker/llm.ts`. Never call a provider directly.
3. Never add a card-only service, a paid tier, or Next/OpenNext.
4. The database URL and all keys live only in the Worker (`env`). Never import `src/worker` from `src/web`, and never put a key or a `postgres://` string in client code or in the repo.
5. A new table goes in `db/init.sql` and `db/schema.ts`. The app role gets SELECT, INSERT and UPDATE on it by default (`db/rls.sql`); narrow that with REVOKE/GRANT in `db/rls.sql` when the Worker needs less. A table that holds visitor input also gets `ENABLE` and `FORCE ROW LEVEL SECURITY` and a policy keyed on `current_setting('app.visitor', true)` in `db/rls.sql`, like `submissions`.
6. Heavy compute happens at build time and is committed; a Worker request has 10 ms of CPU.
7. Never change `.gitleaks.toml`, `.gitleaksignore`, `scripts/` or `.github/`. The publish job refuses the whole build if you do.

## Brand and honesty

1. No logos, trademarks, brand images or brand fonts of the Startup or anyone else.
2. Keep the footer: "independent demo by Luis Escobar, not affiliated with <company>" (set from `project.json`).
3. Claim in the README only what the Project actually does.

## Files you fill in

1. `project.json`: the Startup name and domain, a title, the problem in one sentence, colors (not the Startup's brand colors).
2. `demo/runs.json`: 3-5 recorded runs (`input`, `output`, `model`, `recorded_at`). Each output must be a real model output, and `model` must name the model that produced it.
3. `README.md`: the sections problem, evidence, what was built, how to run, stack_note.
4. `public/explainer.html`: the architecture explainer (AD-13).
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

6. Placeholders: the deploy refuses while `project.json` names "Example Startup", `demo/runs.json` has fewer than 3 runs or a `template-placeholder` run, or the README still says "Replace with".

## GitHub Pages

The deploy job publishes the stable front to the `gh-pages` branch, and fails with "Pages not enabled" if Pages is off.
Its token cannot enable Pages; the build step (story 3.9) does it once from the Mac (see README).
