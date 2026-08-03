#!/usr/bin/env node
// Build-time regression guard for the research / ArtaScience chart renderers.
//
// Historical breakage this gate keeps from recurring:
//
//   Submission #10's published figures (src/pages/Research.tsx) rendered horribly — a bar chart with a
//   sub-zero baseline (axis from -4.73), ~116px bars slammed against the frame edges, a line-style legend
//   for bars, and dot labels overprinting into mush ("20x68x"). The data specs were fine; the SVG
//   renderer was wrong. Each SOURCE_INVARIANT below is a STRUCTURAL fix that must stay present — remove one
//   and the build FAILS here rather than silently shipping a broken plot again.
//
//   (The ArtaScience FFT SpectrumChart axis/legend guards #147/#148 were retired when the FFT + per-field
//    frequency tuning was removed — commit 8a4c1a4b fixed every sinc to a one-year period, deleting
//    SpectrumChart/FreqAreaBars from ResearchCharts.tsx — so there is no spectrum plot left to guard.)
//
// Wired into `npm run build`, so every deploy is gated. Pure JS — no test runner, no app imports.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");

const researchSrc = read("src", "pages", "Research.tsx");

/** @type {{ file: string, src: string, name: string, re: RegExp, why: string }[]} */
const SOURCE_INVARIANTS = [
  // ---- src/pages/Research.tsx — submission #10's broken figures ----
  {
    file: "Research.tsx", src: researchSrc, name: "bar/area zero baseline",
    re: /\(type === "bar" \|\| type === "area"\) && min >= 0\) min = 0/,
    why: "bars must grow from a true zero baseline — never pad the y-axis below zero (that gave the -4.73 baseline).",
  },
  {
    file: "Research.tsx", src: researchSrc, name: "equal category bands for bars",
    re: /type === "bar" \? ML \+ \(i \+ 0\.5\) \* band/,
    why: "bar categories sit centred in equal bands, not at line-chart edge positions i/(n-1) (which flung 2 categories to the far edges).",
  },
  {
    file: "Research.tsx", src: researchSrc, name: "bar width cap",
    re: /Math\.min\(46, Math\.max\(2, \(band \* 0\.72\) \/ series\.length\)\)/,
    why: "bar width is capped so a few categories don't yield enormous bars.",
  },
  {
    file: "Research.tsx", src: researchSrc, name: "filled bar legend swatch",
    re: /if \(barMode\) return \(/,
    why: "bar charts get a filled-rectangle legend swatch, not a line+marker (which misrepresented bars as lines).",
  },
  {
    file: "Research.tsx", src: researchSrc, name: "bar legend wired",
    re: /barMode=\{type === "bar"\}/,
    why: "the bar legend swatch must actually be requested by ResultChart's legend.",
  },
  {
    file: "Research.tsx", src: researchSrc, name: "dot-label collision stagger",
    re: /lvlByI\[p\.i\] = Math\.min\(2, staggerLevel\(lblX, k, 22\)\)/,
    why: "per-point dot labels must stagger onto clear levels so close labels never overprint into mush.",
  },
];

const missing = SOURCE_INVARIANTS.filter((inv) => !inv.re.test(inv.src));
if (missing.length) {
  console.error("\n✗ chart-render regression guard FAILED — required rendering invariant(s) missing:\n");
  for (const m of missing) console.error(`  • [${m.file}] ${m.name}\n    ${m.why}\n`);
  console.error("These guard the broken plots seen on submission #10. Restore them before building.\n");
  process.exit(1);
}

console.log(`✓ chart-render guard: ${SOURCE_INVARIANTS.length} renderer invariants present`);
