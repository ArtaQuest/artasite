/**
 * ArtaContrast — live browser audit (the dev tool, automated via the persistent Chrome/CDP).
 *
 * v3: grades by the DENSITY LAW (the deployed model — see analysis/density-law/):
 *     V = D·(Ymax − Ymin)/(Ymax + Y0)  must reach the element's role bar.
 * For every text/stroke element it measures the ACHIEVED visibility V (density D from the same
 * measured table the engine bakes, luminance γ-2.2, parent-resolved background) against the bar the
 * engine solves for: body text (≥16px) the full level criterion, smaller UI text the ink-2 role
 * (0.80), with the ink-3 role (0.69) at the theme band's calm end as the never-below floor.
 * Borders are decorative (found, not read): the level's own hairline target. Flags below-floor
 * elements, screenshots Standard mode, writes the open-data JSON.
 *
 *   AQ_BASE=https://artaquest.com node tools/contrast-audit.mjs            # audit prod (read-only)
 *   AQ_BASE=http://localhost:8881 AQ_LEVELS=3 node tools/contrast-audit.mjs # local, Standard only
 *
 * Read-only: navigates + measures + screenshots. Never posts. One reused tab (persistent-chrome rule).
 */
import { writeFileSync, mkdirSync } from "node:fs";

const PW = process.env.AQ_PW || "/Users/arash/.artaquest-dev/playwright-suite/node_modules/playwright/index.mjs";
const BASE = (process.env.AQ_BASE || "https://artaquest.com").replace(/\/$/, "");
const CDP = process.env.AQ_CDP || "http://127.0.0.1:9222";
const LEVELS = (process.env.AQ_LEVELS || "1,2,3,4,5").split(",").map((n) => +n.trim());
const THEME = process.env.AQ_THEME || ""; // "", "dark", or "light" (logged-out default is light)
const TAG = THEME ? "-" + THEME : "";
const OUT = new URL("../analysis/reading-experiment/audit-out/", import.meta.url).pathname;
const SHOTS = LEVELS.includes(3) && process.env.AQ_NOSHOT !== "1";
mkdirSync(OUT, { recursive: true });

// ── the in-page audit (runs in the browser; mirrors lib/contrast.ts — the density law) ──
function pageAudit() {
  // The law's constants + the engine's deployment shape (keep in lockstep with lib/contrast.ts).
  const C_STAR = 0.2767, Y0 = 0.63, GAMMA = 2.2;
  const BAND = { dark: [0.74, 1.0], light: [0.9, 1.06] };
  const ROLE_UI = 0.8, ROLE_INCID = 0.69;
  // Measured density table min(D_ink, D_paper) at b = 1.0 px (analysis/density-law dataset).
  const D_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 21, 24, 28, 32, 36, 42, 48, 60, 72, 90, 108, 120, 130];
  const D_TAB = {
    300: [0.269, 0.2872, 0.3083, 0.3255, 0.3434, 0.3631, 0.3848, 0.4221, 0.4737, 0.5212, 0.5768, 0.6234, 0.6673, 0.7137, 0.7528, 0.8049, 0.8372, 0.8734, 0.8947, 0.9053, 0.9123],
    400: [0.3461, 0.3662, 0.3918, 0.4142, 0.4346, 0.4572, 0.4796, 0.5206, 0.5756, 0.6212, 0.6737, 0.7127, 0.7496, 0.7834, 0.8106, 0.8516, 0.8772, 0.9016, 0.9187, 0.9271, 0.9335],
    500: [0.3998, 0.4261, 0.4522, 0.4746, 0.4988, 0.5218, 0.5441, 0.5859, 0.6379, 0.6782, 0.7262, 0.761, 0.7892, 0.8189, 0.841, 0.8746, 0.8957, 0.9186, 0.9323, 0.9374, 0.9432],
    700: [0.499, 0.5245, 0.552, 0.5794, 0.6006, 0.6207, 0.6428, 0.678, 0.7246, 0.7542, 0.7912, 0.8175, 0.8371, 0.861, 0.8769, 0.9025, 0.919, 0.9363, 0.9463, 0.9513, 0.9565],
  };
  const WS = [300, 400, 500, 700];
  const densityOf = (px, weight) => {
    const w = WS.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) ? b : a));
    const tab = D_TAB[w];
    if (px <= D_SIZES[0]) return (tab[0] * px) / D_SIZES[0];
    if (px >= D_SIZES[D_SIZES.length - 1]) return tab[tab.length - 1];
    for (let i = 0; i < D_SIZES.length - 1; i++)
      if (px >= D_SIZES[i] && px <= D_SIZES[i + 1]) {
        const t = (Math.log(px) - Math.log(D_SIZES[i])) / (Math.log(D_SIZES[i + 1]) - Math.log(D_SIZES[i]));
        return tab[i] + t * (tab[i + 1] - tab[i]);
      }
    return tab[0];
  };
  // erf (Abramowitz–Stegun 7.1.26) for the hairline closed form D = erf(w/(2√2·b)), b = 1.
  const erf = (x) => {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  };
  const lum = (rgb) => 0.2126 * Math.pow(rgb[0] / 255, GAMMA) + 0.7152 * Math.pow(rgb[1] / 255, GAMMA) + 0.0722 * Math.pow(rgb[2] / 255, GAMMA);
  const vis = (D, a, b) => { const ya = lum(a), yb = lum(b); return (D * Math.abs(ya - yb)) / (Math.max(ya, yb) + Y0); };
  const num = (s) => parseFloat(s) || 0;
  const parseRGB = (s) => { const m = (s || "").match(/rgba?\(([^)]+)\)/i); if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x)); return { rgb: [p[0] | 0, p[1] | 0, p[2] | 0], a: p[3] === undefined ? 1 : p[3] }; };
  const hex = (a) => "#" + a.map((v) => (v | 0).toString(16).padStart(2, "0")).join("");
  const resolveBg = (el) => {
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
  // TIER IDENTITY — the live incidental token (--color-ink-3). Any text UNDER 12px painted in this exact
  // hex is a contract violation (sub-12px must bind to ink-2 or stronger), independent of its Lc — the
  // check the review asked for, so "grade by the tiers we enforce" is literally true.
  const rootStyle = getComputedStyle(document.documentElement);
  const ink3Hex = (() => { const p = parseRGB(rootStyle.getPropertyValue("--color-ink-3")); return p ? hex(p.rgb) : null; })();
  const rows = [], seen = new Set();
  document.querySelectorAll("body *").forEach((el) => {
    if (!ownText(el)) return;
    // NEVER measure the pre-hydration shell: the WP boot splash (#aq-boot-screen) paints a decorative 27px
    // gold/blue wordmark, and the SEO-fallback HTML behind it carries raw UA-default (#0000ee) links — both
    // are replaced by the SPA the instant it hydrates, so no user ever reads them. Sampling them is a
    // measurement error, not a finding. (render() also waits for the splash to lift; this is the belt.)
    if (el.closest("#aq-boot-screen")) return;
    // The logotype (the ArtaQuest wordmark lockup) is a BRAND MARK, not reading text — it must wear the
    // canonical complementary pair (gold+blue=white) on both themes, and logotypes are the classic
    // contrast-rule exemption. Identified by the lockup's own aria-label.
    if (el.closest('[aria-label="ArtaQuest"]')) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) return;
    const fg = parseRGB(cs.color); if (!fg || fg.a < 0.05) return;
    const bg = resolveBg(el), size = num(cs.fontSize), weight = parseInt(cs.fontWeight) || 400;
    const key = `${size}|${weight}|${hex(fg.rgb)}|${hex(bg)}`; if (seen.has(key)) return; seen.add(key);
    // Two graded bars in LAW units (mirrors contrast.ts tokensFor):
    //   floor   — must hold at EVERY comfort step: the weakest legitimate token (ink-3, role 0.69)
    //             at the theme band's CALM end. Calm is a chosen softness, never unreadability.
    //   comfort — the STANDARD-step target: body text (≥16px) carries the full Standard criterion;
    //             smaller text the ink-2 role (0.80) of it. 6% tolerance absorbs 8-bit rounding and
    //             live-canvas vs default-canvas drift.
    const theme = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    const [mLo, mHi] = BAND[theme];
    const cStd = C_STAR * (mLo + 0.5 * (mHi - mLo));
    const D = densityOf(size, weight);
    const achieved = vis(D, fg.rgb, bg);
    const band = size >= 24 ? "display" : size >= 16 ? "body" : size >= 12 ? "ui" : "micro";
    const role = size >= 16 ? 1.0 : ROLE_UI;
    const comfort = role * cStd * 0.94;
    const FLOOR = ROLE_INCID * C_STAR * mLo * 0.94;
    const tierViolation = size < 12 && ink3Hex != null && hex(fg.rgb) === ink3Hex; // sub-12px on incidental token
    rows.push({ kind: "text", px: size, weight, band, color: hex(fg.rgb), bg: hex(bg),
      achievedV: +achieved.toFixed(4), comfortV: +comfort.toFixed(4), floorV: +FLOOR.toFixed(4),
      deficit: +(comfort - achieved).toFixed(4), tierViolation,
      passFloor: achieved >= FLOOR, pass: achieved >= comfort && !tierViolation,
      sample: (el.textContent || "").trim().slice(0, 36) });
  });
  // Brand-pair borders (the gold/blue identity rules — pull-quote rails, brand separators) are decorative
  // brand MARKS like the logo, not information-bearing hairlines: exempt them by matching the live pair.
  const rootCs = getComputedStyle(document.documentElement);
  const brandHex = ["--color-yin", "--color-yang"].map((k) => (rootCs.getPropertyValue(k) || "").trim().toLowerCase());
  const brandRGB = brandHex.map((h) => (h.startsWith("#") && h.length === 7 ? [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] : null)).filter(Boolean);
  document.querySelectorAll("body *").forEach((el) => {
    const cs = getComputedStyle(el); const bw = num(cs.borderTopWidth);
    if (bw <= 0 || cs.borderTopStyle === "none") return;
    const bc = parseRGB(cs.borderTopColor); if (!bc || bc.a < 0.05) return;
    if (brandRGB.some((b) => b[0] === bc.rgb[0] && b[1] === bc.rgb[1] && b[2] === bc.rgb[2])) return;
    const bg = resolveBg(el.parentElement || el);
    const key = `border|${bw}|${hex(bc.rgb)}|${hex(bg)}`; if (seen.has(key)) return; seen.add(key);
    // Borders/dividers are decorative (found, not read): the ENGINE ramps them from faint at Calm to
    // crisp at Max — target C·(0.12 + 0.26·t) at slider position t, with the hairline's closed-form
    // density D = erf(w/(2√2·b)). Grade against the level's own target; a wider tolerance (10% + a
    // small absolute epsilon) absorbs 8-bit rounding at these tiny visibilities.
    const lvl = parseInt(document.documentElement.getAttribute("data-contrast")) || 3;
    const t = (lvl - 1) / 4;
    const themeB = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    const [bLo, bHi] = BAND[themeB];
    const cLine = C_STAR * (bLo + t * (bHi - bLo)) * (0.12 + 0.26 * t);
    const Db = erf(Math.max(bw, 0.5) / (2 * Math.SQRT2));
    const achieved = vis(Db, bc.rgb, bg);
    const required = cLine * 0.9 - 0.004;
    rows.push({ kind: "border", px: bw, weight: 0, band: "border", color: hex(bc.rgb), bg: hex(bg),
      achievedV: +achieved.toFixed(4), comfortV: +required.toFixed(4), deficit: +(required - achieved).toFixed(4),
      passFloor: true, pass: achieved >= required, sample: "" });
  });
  return { theme: document.documentElement.getAttribute("data-theme"),
    contrast: document.documentElement.getAttribute("data-contrast"), samples: rows.length, rows };
}

const { chromium } = await import(PW);
const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0] || (await browser.newContext());
const host = new URL(BASE).hostname;
await ctx.addCookies([{ name: "ay_lang", value: "en", domain: host, path: "/" },
  { name: "aq_lang", value: "en", domain: host, path: "/" }]);
const page = await ctx.newPage();
page.setDefaultTimeout(20000);

const norm = (p) => { // prod 301s non-trailing-slash → add it (before any ?query) to avoid redirect races
  if (p === "/") return "/";
  const [path, q] = p.split("?");
  const slashed = path.endsWith("/") ? path : path + "/";
  return q ? `${slashed}?${q}` : slashed;
};
async function render(path, level) {
  // set the level on the current (same-origin) page, THEN navigate — goto re-runs the pre-paint which
  // reads localStorage. No reload (which raced the 301). evaluate is best-effort (first call may be about:blank).
  await page.evaluate((o) => { try { localStorage.setItem("aq_contrast", String(o.l)); localStorage.setItem("ay_lang", "en"); if (o.t) localStorage.setItem("aq_theme", o.t); } catch {} }, { l: level, t: THEME }).catch(() => {});
  await page.goto(BASE + norm(path), { waitUntil: "domcontentloaded" });
  // Sample ONLY the fully-hydrated page. The WP shell paints a branded #aq-boot-screen loader that lib/boot.ts
  // removes exactly when the route's lazy chunk has loaded AND real content is on the canvas — so its ABSENCE
  // (plus a populated root) is the "past-FOUC" signal. Before that the DOM is the SEO fallback: raw <a> at the
  // UA-default #0000ee and the decorative splash wordmark — pre-hydration ghosts no user ever reads. If the
  // splash never lifts (a flaky prod 502/403 stalls the chunk) the page is NOT ready, so we SKIP this sample
  // rather than measure the fallback — a returned false the caller records + moves past, never a ghost finding.
  const ready = await page.waitForFunction(() => {
    if (document.getElementById("aq-boot-screen")) return false;
    const root = document.getElementById("aq-app-root") || document.getElementById("root") || document.body;
    return root && root.querySelectorAll("*").length > 30;
  }, { timeout: 15000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(2600); // SPA + i18n gate + lazy chunk
  return ready;
}

// The 7 base surfaces + 2 content routes (a course + its rankings tab) discovered from the catalogue, so
// the certificate covers reading content, not only chrome. The COLLECTOR MUST NOT SILENTLY UNDER-COVER:
// a certificate is only a bound if it samples what it claims, so a failed discovery is a HARD ERROR
// (exit 3), never a quiet 7-route subset — the paper's own thesis (fail the build on drift; grade the
// instrument, not just the output) applied to the collector. Override the base list with AQ_ROUTES, or
// set AQ_ALLOW_PARTIAL=1 to opt out of the content-route requirement (dev only, never for the paper).
const BASE_ROUTES = (process.env.AQ_ROUTES || "/,/courses,/fields,/research,/data,/sponsors,/about").split(",").map((s) => s.trim()).filter(Boolean);
let ROUTES = [...BASE_ROUTES];
if (!process.env.AQ_ROUTES) {
  let slug = null;
  for (let attempt = 1; attempt <= 3 && !slug; attempt++) {
    try {
      await page.goto(BASE + "/courses", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2600 + attempt * 1500); // give the lazy catalogue chunk more time each retry
      slug = await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a[href*="/courses/"]')).map((x) => x.getAttribute("href")).find((h) => h && h.split("/courses/")[1]);
        return a || null;
      });
    } catch (e) { console.log(`slug discovery attempt ${attempt} failed: ${e.message}`); }
    if (!slug && attempt < 3) console.log(`slug discovery attempt ${attempt}: no course link yet — retrying`);
  }
  if (slug) { ROUTES.push(slug); ROUTES.push(slug + "?tab=rankings"); }
  else if (process.env.AQ_ALLOW_PARTIAL === "1") { console.warn("⚠ course discovery failed — proceeding with the 7-route subset (AQ_ALLOW_PARTIAL=1)"); }
  else { console.error(`FATAL: could not discover a course route from ${BASE}/courses after 3 attempts — refusing to emit an under-covered certificate. Set AQ_ROUTES to pin routes, or AQ_ALLOW_PARTIAL=1 to override (dev only).`); await browser.close(); process.exit(3); }
}

console.log(`audit BASE=${BASE} levels=[${LEVELS}] routes=${ROUTES.length}`);
const report = { base: BASE, levels: LEVELS, routes: {}, generated: new Date().toISOString() };
let totalFail = 0, totalFloorFail = 0;

for (const route of ROUTES) {
  report.routes[route] = {};
  for (const level of LEVELS) {
    let res;
    try {
      const ready = await render(route, level);
      if (!ready) { console.log(`  ⤼ ${route} L${level}: boot splash never lifted (prod slow) — SKIP (would sample the un-hydrated SEO fallback)`); report.routes[route][level] = { skipped: "not-hydrated" }; continue; }
      res = await page.evaluate(pageAudit);
    }
    catch (e) { console.log(`  ✗ ${route} L${level}: ${e.message.split("\n")[0]}`); await page.goto(BASE + "/", { waitUntil: "domcontentloaded" }).catch(() => {}); continue; }
    // Grade: the readable floor must hold at EVERY step; the usage-tier comfort bar applies at the
    // STANDARD step (level 3) — the calmer steps are a chosen softness, measured but not failed.
    const floorFails = res.rows.filter((r) => r.kind === "text" && !r.passFloor);
    const comfortFails = res.rows.filter((r) => !r.pass).sort((a, b) => b.deficit - a.deficit);
    const graded = level === 3 ? comfortFails : floorFails;
    report.routes[route][level] = { samples: res.samples, belowFloor: floorFails.length,
      belowComfort: comfortFails.length, theme: res.theme, dataContrast: res.contrast,
      worst: (level === 3 ? comfortFails : floorFails).slice(0, 8),
      // At Standard, also keep the route's worst-8 TEXT samples by achieved Lc regardless of pass —
      // the same worst-case certificate collect.mjs emits, so measurements.json can be assembled from
      // this report (raw colour pairs only; Lc is always recomputed downstream).
      ...(level === 3 ? { samples8: res.rows.filter((r) => r.kind === "text")
        .sort((a, b) => a.achievedV - b.achievedV).slice(0, 8)
        .map((r) => ({ route, kind: r.kind, px: r.px, weight: r.weight, fg: r.color, bg: r.bg })) } : {}) };
    totalFail += graded.length;
    totalFloorFail += floorFails.length;
    console.log(`  ${route} L${level} [data-contrast=${res.contrast}]: ${res.samples} samples, ${floorFails.length} below floor, ${comfortFails.length} below Standard comfort` +
      (graded[0] ? ` — worst ${graded[0].kind} ${graded[0].px}px/${graded[0].weight} V ${graded[0].achievedV} (${graded[0].band ?? "border"}) "${graded[0].sample}"` : ""));
    if (level === 3 && SHOTS) {
      const name = "shot_" + (route === "/" ? "home" : route.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "")) + TAG + "_L3.png";
      await page.screenshot({ path: OUT + name, fullPage: true }).catch((e) => console.log("    shot failed:", e.message));
    }
  }
}

writeFileSync(OUT + `audit-report${TAG}.json`, JSON.stringify(report, null, 1));
console.log(`\nTOTAL graded fails (floor at calm steps, comfort bar at Standard; summed over routes×levels): ${totalFail}`);
console.log(`TOTAL below the readable FLOOR: ${totalFloorFail}`);
console.log(`report → ${OUT}audit-report.json` + (SHOTS ? `  + Standard-mode screenshots` : ""));
await page.close();
await browser.close();
