#!/usr/bin/env node
/**
 * collect.mjs — the measurement collector for "Legible reading for open education".
 *
 * This is the DOM-walking step the paper describes: it loads each route of a live site in a headless
 * browser and, for every visible text element, reads the computed foreground colour, font size and weight,
 * and the PARENT-RESOLVED opaque background (walking ancestors until an opaque background is found). It then
 * recomputes APCA Lc from that raw foreground/background pair and keeps each route's worst-8 lowest-contrast
 * components. The output is the open-data `measurements.json` that the stdlib `reproduce.py` then verifies —
 * so the whole pipeline is: collect.mjs (rendered pixels -> colour pairs) ; reproduce.py (colour pairs -> Lc).
 *
 *   npm i playwright            # one-time; Playwright ships its own Chromium
 *   node collect.mjs https://your-platform.example  [route,route,...]  [--theme dark|light]
 *
 * It writes audit-samples.json (worst-8 per route, as raw colour pairs) to the current directory. Nothing is
 * posted; the browser is launched fresh and headless, so it runs the audit on ANY site's own rendered pages.
 *
 * The in-page measurement (pageAudit) is byte-identical to reproduce.py's APCA and to the platform's own
 * contrast engine — colour-only, no contrast value is ever trusted as input.
 */
import { writeFileSync } from "node:fs";
import { chromium } from "playwright"; // self-contained; no personal CDP, no remote debugger

const BASE = (process.argv[2] || "https://artaquest.org").replace(/\/$/, "");
const ROUTES_EXPLICIT = !!(process.argv[3] && !process.argv[3].startsWith("--"));
const ROUTES = (ROUTES_EXPLICIT ? process.argv[3] : "/,/courses,/fields,/research,/data,/sponsors,/about")
  .split(",").map((s) => s.trim()).filter(Boolean);
const THEME = (process.argv.find((a) => a.startsWith("--theme=")) || "--theme=").split("=")[1]
  || (process.argv.includes("--theme") ? process.argv[process.argv.indexOf("--theme") + 1] : "");
const WORST = 8; // worst-N lowest-contrast components per route — a worst-case certificate for the route

// ── runs inside the page: parent-resolved background + APCA Lc + APCA size-conditioned target ──
function pageAudit() {
  const sx = (c) => Math.pow(c / 255, 2.4);
  const aY = (r, g, b) => 0.2126729 * sx(r) + 0.7151522 * sx(g) + 0.0721750 * sx(b);
  const clB = (y) => (y >= 0.022 ? y : y + Math.pow(0.022 - y, 1.414));
  const lc = (t, b) => {
    const Yt = clB(aY(t[0], t[1], t[2])), Yb = clB(aY(b[0], b[1], b[2]));
    if (Math.abs(Yb - Yt) < 5e-4) return 0;
    let S, o;
    if (Yb > Yt) { S = (Math.pow(Yb, 0.56) - Math.pow(Yt, 0.57)) * 1.14; o = S < 0.1 ? 0 : S - 0.027; }
    else { S = (Math.pow(Yb, 0.65) - Math.pow(Yt, 0.62)) * 1.14; o = S > -0.1 ? 0 : S + 0.027; }
    return o * 100;
  };
  // APCA font lookup: minimum px per (Lc level, weight); invert to the required Lc for a size/weight.
  const FONT = { 30: { 300: 120, 400: 108, 500: 108, 700: 72 }, 45: { 300: 72, 400: 42, 500: 32, 700: 24 },
    60: { 300: 42, 400: 24, 500: 21, 700: 16 }, 75: { 300: 24, 400: 18, 500: 16, 700: 14 },
    90: { 300: 21, 400: 16, 500: 15.5, 700: 14 }, 100: { 300: 18.5, 400: 15, 500: 14.5, 700: 13 } };
  const ROWS = [30, 45, 60, 75, 90, 100], WS = [300, 400, 500, 700];
  const requiredLc = (px, weight) => {
    const w = WS.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) ? b : a));
    for (const r of ROWS) if (px >= FONT[r][w]) return r;
    return 100;
  };
  const num = (s) => parseFloat(s) || 0;
  const parseRGB = (s) => { const m = (s || "").match(/rgba?\(([^)]+)\)/i); if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x)); return { rgb: [p[0] | 0, p[1] | 0, p[2] | 0], a: p[3] === undefined ? 1 : p[3] }; };
  const hex = (a) => "#" + a.map((v) => (v | 0).toString(16).padStart(2, "0")).join("");
  const resolveBg = (el) => {                       // walk ancestors to the first opaque background
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parseRGB(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.05) return c.rgb;
      n = n.parentElement;
    }
    const b = parseRGB(getComputedStyle(document.body).backgroundColor);
    return b ? b.rgb : [13, 13, 15];
  };
  const ownText = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
  const rows = [], seen = new Set();
  document.querySelectorAll("body *").forEach((el) => {
    if (!ownText(el)) return;
    // Never measure the pre-hydration shell: a full-screen loader/splash (here #aq-boot-screen) and the SEO
    // fallback behind it carry ghost markup (a decorative splash wordmark; raw UA-default #0000ee links) that
    // the SPA replaces the instant it hydrates — no user reads them (adapt the selector to your own loader).
    if (el.closest("#aq-boot-screen")) return;
    // Logotypes are brand marks, not reading text — the classic contrast-rule exemption (this platform's
    // wordmark carries its own aria-label; adapt the selector for another site's lockup).
    if (el.closest('[aria-label="ArtaQuest"]')) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) return;
    const fg = parseRGB(cs.color); if (!fg || fg.a < 0.05) return;
    const bg = resolveBg(el), size = num(cs.fontSize), weight = parseInt(cs.fontWeight) || 400;
    const key = `${size}|${weight}|${hex(fg.rgb)}|${hex(bg)}`; if (seen.has(key)) return; seen.add(key);
    const achieved = Math.abs(lc(fg.rgb, bg)), required = requiredLc(size, weight);
    rows.push({ kind: "text", px: size, weight, fg: hex(fg.rgb), bg: hex(bg),
      achievedLc: +achieved.toFixed(1), requiredLc: required });
  });
  rows.sort((a, b) => a.achievedLc - b.achievedLc); // lowest contrast first
  return rows;
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ colorScheme: THEME === "light" ? "light" : THEME === "dark" ? "dark" : undefined });
const page = await ctx.newPage();
page.setDefaultTimeout(20000);

// When routes aren't given explicitly, discover a course page + its rankings tab from the catalogue, so a
// bare `node collect.mjs https://site` reproduces the paper's 9-route audit (7 catalogue routes + 2 content).
// A certificate is only a bound if it samples what it claims, so a FAILED discovery is a HARD ERROR (exit 3),
// never a silent 7-route subset — the paper's own thesis (fail loudly on shortfall; grade the instrument, not
// just its output) applied to the collector. Pin routes explicitly, or set ALLOW_PARTIAL=1, to opt out.
if (!ROUTES_EXPLICIT) {
  let slug = null;
  for (let attempt = 1; attempt <= 3 && !slug; attempt++) {
    try {
      await page.goto(BASE + "/courses", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2600 + attempt * 1500); // give the lazy catalogue chunk more time each retry
      slug = await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a[href*="/courses/"]'))
          .map((x) => x.getAttribute("href")).find((h) => h && h.split("/courses/")[1]);
        return a || null;
      });
    } catch (e) { console.log(`course-route discovery attempt ${attempt} failed: ${e.message}`); }
  }
  if (slug) ROUTES.push(slug, slug + (slug.includes("?") ? "&" : "?") + "tab=rankings");
  else if (process.env.ALLOW_PARTIAL === "1") console.warn("⚠ course discovery failed — proceeding with the 7-route subset (ALLOW_PARTIAL=1)");
  else { console.error(`FATAL: no course route discoverable at ${BASE}/courses after 3 attempts — refusing to emit an under-covered certificate. Pass routes explicitly, or set ALLOW_PARTIAL=1 (dev only).`); await browser.close(); process.exit(3); }
}
const samples = [];
for (const route of ROUTES) {
  try {
    if (THEME) await page.addInitScript((t) => { try { localStorage.setItem("aq_theme", t); } catch {} }, THEME);
    await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
    // Sample only past hydration: wait for any full-screen loader (#aq-boot-screen) to lift and real content
    // to be on the canvas. If it never lifts (a stalled chunk on a flaky host), SKIP the route rather than
    // measure the un-hydrated SEO fallback — a skipped route is honest; a ghost sample is not.
    const ready = await page.waitForFunction(() => {
      if (document.getElementById("aq-boot-screen")) return false;
      const root = document.getElementById("aq-app-root") || document.getElementById("root") || document.body;
      return root && root.querySelectorAll("*").length > 30;
    }, { timeout: 15000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(2600); // let the SPA settle + lazy chunks paint
    if (!ready) { console.log(`${route}: skipped (loader never lifted — un-hydrated)`); continue; }
    const rows = await page.evaluate(pageAudit);
    rows.slice(0, WORST).forEach((r) => samples.push({ route, ...r }));
    console.log(`${route}: ${rows.length} text components, worst Lc ${rows[0]?.achievedLc}`);
  } catch (e) { console.log(`${route}: skipped (${e.message})`); }
}
await browser.close();
const out = { base: BASE, theme: THEME || "default", worst_per_route: WORST,
  note: "Each row is a rendered foreground/background colour pair (the worst-N lowest-contrast text per route). Lc + requiredLc are recomputed by reproduce.py from fg/bg; they are not trusted as input.",
  samples };
writeFileSync("audit-samples.json", JSON.stringify(out, null, 1));
console.log(`\nwrote audit-samples.json — ${samples.length} samples across ${ROUTES.length} routes`);
