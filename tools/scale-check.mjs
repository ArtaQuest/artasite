/**
 * Slider-scaling check: does EVERY coloured thing (text, border, background, and SVG fill/stroke/stop)
 * actually change when the contrast slider moves? Loads each route at L1 and L5, snapshots every visible
 * element's computed paint, and flags any colour that is IDENTICAL at both levels = NOT scaling (a
 * hardcoded colour the slider can't reach). SVG paints are called out separately (the focus).
 *
 *   AQ_THEME=dark node tools/scale-check.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
const PW = process.env.AQ_PW || "/Users/arash/.artaquest-dev/playwright-suite/node_modules/playwright/index.mjs";
const BASE = (process.env.AQ_BASE || "https://artaquest.com").replace(/\/$/, "");
const CDP = process.env.AQ_CDP || "http://127.0.0.1:9222";
const THEME = process.env.AQ_THEME || "dark";
const OUT = new URL("../analysis/reading-experiment/scale-out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const ROUTES = (process.env.AQ_ROUTES || "/,/fields,/research,/courses,/u/arash").split(",").map((s) => s.trim());
const norm = (p) => { if (p === "/") return "/"; const [a, q] = p.split("?"); const s = a.endsWith("/") ? a : a + "/"; return q ? s + "?" + q : s; };

function snapshot() {
  const norm = (s) => { const m = (s || "").match(/rgba?\(([^)]+)\)/i); if (!m) return null; const p = m[1].split(",").map(Number); if (p[3] === 0) return null; return "rgb(" + (p[0] | 0) + "," + (p[1] | 0) + "," + (p[2] | 0) + ")"; };
  const SVG = new Set(["svg", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "g", "use", "stop"]);
  const out = {}; // key "idx|prop" -> {hex, tag, svg, cls, text}
  const els = document.querySelectorAll("body *");
  els.forEach((el, i) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) return;
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return;
    const tag = el.tagName.toLowerCase(), isSvg = SVG.has(tag);
    const props = isSvg ? ["fill", "stroke"] : ["color", "borderTopColor", "backgroundColor"];
    for (const p of props) {
      let v = norm(cs[p]);
      // SVG paint can be an attribute (stop-color) or currentColor (→ tracks color, which scales)
      if (isSvg && !v && el.getAttribute(p === "fill" ? "fill" : p)) v = norm(el.getAttribute(p));
      if (!v) continue;
      out[i + "|" + p] = { hex: v, tag, svg: isSvg, cls: (el.getAttribute("class") || "").slice(0, 40), text: (el.textContent || "").trim().slice(0, 24) };
    }
  });
  return out;
}

const { chromium } = await import(PW);
const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0] || (await browser.newContext());
const host = new URL(BASE).hostname;
await ctx.addCookies([{ name: "ay_lang", value: "en", domain: host, path: "/" }]);
const page = await ctx.newPage();
page.setDefaultTimeout(20000);

async function at(path, level) {
  await page.evaluate((o) => { try { localStorage.setItem("aq_contrast", String(o.l)); localStorage.setItem("aq_theme", o.t); localStorage.setItem("ay_lang", "en"); } catch {} }, { l: level, t: THEME }).catch(() => {});
  await page.goto(BASE + norm(path), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2600);
  return page.evaluate(snapshot);
}

const report = { base: BASE, theme: THEME, routes: {} };
let totalStuck = 0, svgStuck = 0;
for (const route of ROUTES) {
  let s1, s5;
  try { await page.goto(BASE + "/", { waitUntil: "domcontentloaded" }); s1 = await at(route, 1); s5 = await at(route, 5); }
  catch (e) { console.log(`  ✗ ${route}: ${e.message.split("\n")[0]}`); continue; }
  // an element|prop that exists at both levels with the SAME hex = not scaling
  const stuck = {}; // hex -> {count, svgCount, samples}
  for (const k of Object.keys(s1)) {
    if (!s5[k] || s5[k].hex !== s1[k].hex) continue; // changed (or gone) → scaling/ok
    const e = s1[k];
    // skip pure transparent already filtered; skip the canvas surface bg (space-*) which is theme-fixed by design
    const g = stuck[e.hex] || (stuck[e.hex] = { count: 0, svg: 0, prop: e.svg ? e.prop : "", samples: [] });
    g.count++; if (e.svg) g.svg++;
    if (g.samples.length < 4) g.samples.push(`${e.tag}${e.svg ? "(svg)" : ""}.${e.cls}${e.text ? " '" + e.text + "'" : ""} [${k.split("|")[1]}]`);
  }
  report.routes[route] = stuck;
  const colors = Object.entries(stuck).sort((a, b) => b[1].svg - a[1].svg || b[1].count - a[1].count);
  const svgColors = colors.filter(([, v]) => v.svg > 0);
  totalStuck += colors.length; svgStuck += svgColors.length;
  console.log(`\n${route}: ${colors.length} non-scaling colours (${svgColors.length} on SVG)`);
  for (const [hex, v] of colors.slice(0, 12)) console.log(`  ${v.svg ? "▲SVG" : "    "} ${hex.padEnd(18)} ×${v.count}  ${v.samples[0]}`);
}
writeFileSync(OUT + `scale-${THEME}.json`, JSON.stringify(report, null, 1));
console.log(`\nTOTAL distinct non-scaling colours: ${totalStuck} (${svgStuck} involve SVG). → ${OUT}scale-${THEME}.json`);
await page.close(); await browser.close();
