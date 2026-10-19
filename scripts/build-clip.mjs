#!/usr/bin/env node
// Writes the ~30 s how-it-works clip as a HyperFrames composition (AD-13), from the Project's own facts only:
// public/explainer.json (nodes, edges, tour) and project.json (repo link, color). No LLM, no voice: captions
// carry the story with the sound off. It follows the architecture-explainer-video shape: name the thing,
// pull out to the whole system, zoom one station at a time in tour order (others blur), then an end card.
//   node scripts/build-clip.mjs <out dir>      then, in CI only: npx hyperframes render (ship.yml render-clip)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { escapeHtml, explainerProblems } from "./build-explainer.mjs";

const r2 = (n) => Math.round(n * 1000) / 1000;

export const HYPERFRAMES_VERSION = "0.8.154";
const W = 1920;
const H = 1080;
const CARD_W = 360;
const CARD_H = 150;
const INTRO = 3;
const OVERVIEW = 3;
const END = 3;
const COL_GAP = CARD_W + 140;
const ROW_GAP = CARD_H + 110;
const PAD = 60;

/** Seconds per tour stop: the whole clip stays near 30 s for 3-12 stops. */
export function stopSeconds(stops) {
  return Math.min(3.5, Math.max(2, (30 - INTRO - OVERVIEW - END) / Math.max(1, stops)));
}

/**
 * Columns by longest path from a source (cycle-safe), rows by tour order. Returns {id: {x, y}} card centers.
 * @returns {Record<string, {x: number, y: number}>}
 */
export function layoutNodes(data) {
  const ids = data.nodes.map((n) => n.id);
  const rank = Object.fromEntries(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const e of data.edges ?? []) {
      if (e.from !== e.to && rank[e.to] < rank[e.from] + 1 && rank[e.from] + 1 < ids.length) {
        rank[e.to] = rank[e.from] + 1;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const order = (id) => {
    const i = data.tour.findIndex((s) => s.node === id);
    return i < 0 ? data.tour.length + ids.indexOf(id) : i;
  };
  const cols = [...new Set(Object.values(rank))].sort((a, b) => a - b);
  /** @type {Record<string, {x: number, y: number}>} */
  const pos = {};
  // Fixed spacing in world units; the overview camera scales the whole world to fit the frame.
  const rows = Math.max(...cols.map((c) => ids.filter((id) => rank[id] === c).length));
  cols.forEach((c, ci) => {
    const inCol = ids.filter((id) => rank[id] === c).sort((a, b) => order(a) - order(b));
    const offset = ((rows - inCol.length) * ROW_GAP) / 2;
    inCol.forEach((id, ri) => {
      pos[id] = { x: PAD + CARD_W / 2 + ci * COL_GAP, y: PAD + CARD_H / 2 + offset + ri * ROW_GAP };
    });
  });
  return pos;
}

/** World size from the layout, and the overview camera that fits it above the caption. */
export function worldFit(pos) {
  const ps = Object.values(pos);
  const ww = Math.max(...ps.map((p) => p.x)) + CARD_W / 2 + PAD;
  const wh = Math.max(...ps.map((p) => p.y)) + CARD_H / 2 + PAD;
  const availH = H - 230; // the caption pill lives below this line
  const scale = Math.min(1.3, (W - 120) / ww, (availH - 60) / wh);
  return { ww, wh, cam: { x: r2((W - scale * ww) / 2), y: r2((availH - scale * wh) / 2 + 20), scale: r2(scale) } };
}

/** The beats: start, length, caption and which node the camera is on (null = the whole system). */
export function clipPlan(data) {
  const s = stopSeconds(data.tour.length);
  const beats = [
    { at: 0, dur: INTRO, caption: `How ${data.title} works.`, focus: null, kind: "intro" },
    { at: INTRO, dur: OVERVIEW, caption: `${data.nodes.length} parts, one path through them.`, focus: null, kind: "overview" },
  ];
  data.tour.forEach((step, i) => {
    beats.push({ at: INTRO + OVERVIEW + i * s, dur: s, caption: `${i + 1} · ${step.title}`, focus: step.node, kind: "stop" });
  });
  const endAt = INTRO + OVERVIEW + data.tour.length * s;
  beats.push({ at: endAt, dur: END, caption: "", focus: null, kind: "end" });
  return { duration: Math.round((endAt + END) * 100) / 100, beats };
}

export function renderClip(data, project = {}) {
  const pos = layoutNodes(data);
  const plan = clipPlan(data);
  const fit = worldFit(pos);
  const accent = /^#[0-9a-f]{6}$/i.test(project?.colors?.primary ?? "") ? project.colors.primary : "#D97757";
  const repo = typeof project?.repo === "string" && /^https:\/\/github\.com\//.test(project.repo) ? project.repo : "";
  const key = new Map(data.nodes.map((n, i) => [n.id, `n${i}`]));

  const edges = (data.edges ?? [])
    .map((e) => {
      const a = pos[e.from];
      const b = pos[e.to];
      return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`;
    })
    .join("\n          ");
  const cards = data.nodes
    .map((n) => {
      const p = pos[n.id];
      const stop = data.tour.findIndex((s) => s.node === n.id);
      return (
        `<div class="card" id="${key.get(n.id)}" style="left:${p.x - CARD_W / 2}px;top:${p.y - CARD_H / 2}px">` +
        `${stop >= 0 ? `<span class="num">${stop + 1}</span>` : ""}<div class="label" data-layout-allow-overlap>${escapeHtml(n.label)}</div></div>`
      );
    })
    .join("\n        ");
  const captions = plan.beats
    .filter((b) => b.caption)
    .map(
      (b, i) =>
        `<div class="cap clip" id="cap${i}" data-start="${r2(b.at)}" data-duration="${r2(b.dur)}" data-track-index="2">` +
        `<div class="pill" id="pill${i}" data-layout-allow-occlusion>${escapeHtml(b.caption)}</div></div>`,
    )
    .join("\n      ");

  // Camera: one world, transform-origin 0 0, so centering point (cx, cy) at scale s is x = 960 - s*cx.
  const cam = (focus, s) => (focus ? { x: r2(W / 2 - s * pos[focus].x), y: r2(H / 2 - 60 - s * pos[focus].y), scale: s } : fit.cam);
  const tweens = [];
  const ids = data.nodes.map((n) => key.get(n.id));
  const intro = plan.beats[0];
  tweens.push(`tl.fromTo("#title", { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, 0.1);`);
  tweens.push(`tl.fromTo("#summary", { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, 0.4);`);
  tweens.push(`tl.to("#intro", { opacity: 0, duration: 0.4, ease: "power2.in" }, ${r2(intro.dur - 0.4)});`);
  tweens.push(`tl.set("#world", { x: ${fit.cam.x}, y: ${fit.cam.y}, scale: ${fit.cam.scale} }, 0);`);
  tweens.push(`tl.fromTo("#world", { opacity: 0 }, { opacity: 1, duration: 0.4 }, ${r2(intro.dur - 0.2)});`);
  data.tour.forEach((step, i) => tweens.push(`tl.fromTo("#${key.get(step.node)}", { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.35, ease: "back.out(1.6)" }, ${r2(INTRO + i * (OVERVIEW - 0.6) / data.tour.length)});`));
  for (const n of data.nodes) {
    if (!data.tour.some((s) => s.node === n.id)) tweens.push(`tl.fromTo("#${key.get(n.id)}", { opacity: 0 }, { opacity: 1, duration: 0.35 }, ${INTRO});`);
  }
  tweens.push(`tl.fromTo("#edges", { opacity: 0 }, { opacity: 1, duration: 0.6 }, ${r2(INTRO + 0.6)});`);
  for (const b of plan.beats.filter((x) => x.kind === "stop" || x.kind === "end")) {
    const c = cam(b.focus, 1.7);
    const move = Math.min(0.8, b.dur * 0.35);
    tweens.push(`tl.to("#world", { x: ${c.x}, y: ${c.y}, scale: ${c.scale}, duration: ${r2(move)}, ease: "power3.inOut" }, ${r2(b.at)});`);
    tweens.push(`tl.to("#world", { filter: "blur(10px)", duration: ${r2(move / 2)}, ease: "power2.in" }, ${r2(b.at)});`);
    tweens.push(`tl.to("#world", { filter: "blur(0px)", duration: ${r2(move / 2)}, ease: "power2.out" }, ${r2(b.at + move / 2)});`);
    for (const id of ids) {
      const blur = b.focus && key.get(b.focus) !== id ? 6 : 0;
      tweens.push(`tl.to("#${id} .label", { filter: "blur(${blur}px)", duration: ${r2(move)} }, ${r2(b.at)});`);
    }
  }
  const end = plan.beats.at(-1);
  tweens.push(`tl.to("#world", { opacity: 0, duration: 0.5 }, ${r2(end.at + 0.3)});`);
  tweens.push(`tl.fromTo("#endcard", { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, ${r2(end.at + 0.4)});`);
  plan.beats
    .filter((b) => b.caption)
    .forEach((b, i) => tweens.push(`tl.fromTo("#pill${i}", { scale: 0.9 }, { scale: 1, duration: 0.2, ease: "back.out(2)" }, ${r2(b.at)});`));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <title>${escapeHtml(data.title)}: how it works</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      body { margin: 0; background: #F4F1EA; color: #1F1E1B; font-family: sans-serif; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #F4F1EA; }
      #intro { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; padding: 0 160px; gap: 28px; }
      #title { font-size: 96px; font-weight: 700; line-height: 1.05; max-width: 1600px; overflow-wrap: anywhere; }
      #summary { font-size: 40px; line-height: 1.3; color: #4A463F; max-width: 1500px; }
      #world { position: absolute; left: 0; top: 0; width: ${fit.ww}px; height: ${fit.wh}px; transform-origin: 0 0; opacity: 0; }
      #edges { position: absolute; inset: 0; width: ${fit.ww}px; height: ${fit.wh}px; }
      #edges line { stroke: #B8B0A0; stroke-width: 4; }
      .card { position: absolute; width: ${CARD_W}px; height: ${CARD_H}px; display: flex; align-items: center; justify-content: center;
              padding: 18px 26px; box-sizing: border-box; background: #FFFDF8; border: 3px solid #E2DDD1; border-radius: 22px;
              box-shadow: 0 10px 30px rgba(60, 50, 30, 0.12); }
      .label { font-size: 32px; font-weight: 700; text-align: center; line-height: 1.15; overflow-wrap: anywhere; }
      .num { position: absolute; left: -18px; top: -18px; width: 48px; height: 48px; border-radius: 50%; background: ${accent};
             color: #FFFFFF; font-size: 26px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
      .cap { position: absolute; left: 0; right: 0; bottom: 70px; display: flex; justify-content: center; }
      .pill { display: block; max-width: 1500px; background: #1F1E1B; color: #F4F1EA; font-size: 44px; line-height: 1.25;
              padding: 18px 40px; border-radius: 999px; text-align: center; }
      #endcard { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; opacity: 0; }
      #endcard .name { font-size: 88px; font-weight: 700; text-align: center; max-width: 1600px; overflow-wrap: anywhere; }
      #endcard .link { font-size: 36px; color: #4A463F; font-family: monospace; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${plan.duration}" data-width="${W}" data-height="${H}">
      <section id="scene" class="clip" data-start="0" data-duration="${plan.duration}" data-track-index="1">
        <div id="intro">
          <div id="title">${escapeHtml(data.title)}</div>
          <div id="summary">${escapeHtml(data.summary)}</div>
        </div>
        <div id="world" data-layout-allow-overflow>
          <svg id="edges" viewBox="0 0 ${fit.ww} ${fit.wh}" data-layout-ignore>
          ${edges}
          </svg>
        ${cards}
        </div>
        <div id="endcard">
          <div class="name">${escapeHtml(data.title)}</div>
          <div class="link">${escapeHtml(repo ? repo.replace(/^https:\/\//, "") : "how it works")}</div>
        </div>
      </section>
      ${captions}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${tweens.join("\n      ")}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: build-clip.mjs <out dir>");
    process.exit(1);
  }
  const data = JSON.parse(readFileSync("public/explainer.json", "utf8"));
  const problems = explainerProblems(data, (f) => existsSync(f));
  if (problems.length) {
    console.error(`build-clip: public/explainer.json:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  const project = existsSync("project.json") ? JSON.parse(readFileSync("project.json", "utf8")) : {};
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "index.html"), renderClip(data, project));
  writeFileSync(join(out, "meta.json"), JSON.stringify({ id: "how-it-works", name: "how-it-works" }, null, 2) + "\n");
  console.log(`build-clip: ${join(out, "index.html")} (${clipPlan(data).duration} s, ${data.tour.length} stops)`);
}
