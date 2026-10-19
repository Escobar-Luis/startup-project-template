---
name: project-explainer
description: Write this Project's architecture explainer, the one page that lets someone understand the Project in about 3 minutes and narrate it in tour order. Writes public/explainer.json (nodes, edges, a panel per node, a numbered tour) and builds public/explainer.html with scripts/build-explainer.mjs. Use as the last build step, after the code is done, or when asked for the explainer, the architecture page, the "how it works" page or the tour.
---

# Project explainer

One page per Project, always the same format (AD-13): a clickable architecture diagram, a panel per box
(what it does, its files, why it is built that way), and a numbered tour whose order is the talk track Luis
narrates on the call. You write only the data, `public/explainer.json`. The page shell
(`explainer.template.html`, next to this file) and the build script (`scripts/build-explainer.mjs`) are fixed;
don't edit them. The page opens from `file://`, as a Worker static asset and on GitHub Pages, with no server.
The same data also drives the ~30 s how-it-works clip, so every word must be true of this repo.

## Steps

1. **Read the facts first.** `README.md`, `project.json`, `docs/spec.md`, `docs/memlog.md`, then the code
   that makes each claim true: `src/worker/index.ts` (routes), `src/worker/llm.ts`, `db/*.sql`, `src/web/`,
   anything the build added. Never describe something the code doesn't do. Something not built yet is left out.
2. **Pick 5 to 9 nodes**: the parts a listener needs, not every file. Usually the visitor's page, the API,
   the model call, the database, the GitHub Pages front, plus what this Project added that matters most.
3. **Write `public/explainer.json`** in the format below. Delete `"template_sample"` if it is still there
   (the deploy refuses the template's sample).
4. **Order the tour as the talk track**: the order Luis would explain it out loud, usually following one
   request from the visitor through the system. Each stop's `title` is a plain caption of about 6 words with
   no jargon (it becomes the clip's caption); `say` is the one or two sentences he says there, where the
   engineering terms belong.
5. **Set `repo` in `project.json`** to `https://github.com/<owner>/<repo>` (`$GITHUB_REPOSITORY` in Actions)
   so file paths render as GitHub links.
6. **Build and check**: `npm run build` runs `node scripts/build-explainer.mjs` first. It fails, naming the
   problem, on an edge or tour stop that names an unknown node, a node with no files, a file that does not
   exist, or an empty tour. Fix the data until `npm test` and `npm run build` pass.
7. **Commit** `public/explainer.json` and `public/explainer.html` together: `docs: architecture explainer (<startup id>)`.

## Format

```json
{
  "title": "Project name",
  "summary": "One plain sentence: what it is and what it shows.",
  "nodes": [
    {
      "id": "worker",
      "label": "Worker API (Hono)",
      "does": "What it does, in one or two plain sentences.",
      "files": ["src/worker/index.ts", "wrangler.jsonc"],
      "why": "Why it is built this way: the constraint or trade-off that chose it."
    }
  ],
  "edges": [{ "from": "visitor", "to": "worker", "label": "POST /api/ask" }],
  "tour": [{ "node": "worker", "title": "One Worker holds every key.", "say": "What Luis says at this stop." }]
}
```

Rules the build enforces:

1. `id`: lowercase letters, digits, `-` or `_`, unique.
2. `label`, `does` and `why` are required on every node, and `files` lists at least one repo-relative path
   that exists (no leading `/`, no `..`).
3. Every edge's `from` and `to`, and every tour stop's `node`, name a node.
4. The tour has at least one stop; each has `title` and `say`. A node may appear in the tour more than once.

Text is escaped on the page, so write plain text, not HTML or Markdown.
