/**
 * ArtaQuest prod QA + paper-data capture (read-only, via the persistent Chrome/CDP).
 *
 * For each major route, in the given theme at Standard contrast:
 *   • FUNCTION  — console errors, page errors, SPA actually mounted (boot screen gone, real content),
 *                 a heading renders, document title set.
 *   • DESIGN    — brand gold + blue present; NO off-brand third accent (green/teal/purple/orange beyond
 *                 the allowed rose error tone); dark/light theme + the 5-level contrast slider both move
 *                 the tokens (mechanism works).
 *   • PAPER     — full-page Standard screenshot per route + a 5-level slider sweep on home.
 * Writes qa-out/<theme>/*.png + qa-report-<theme>.json. Never writes to the site.
 *
 *   AQ_THEME=dark node tools/qa-prod.mjs    |    AQ_THEME=light node tools/qa-prod.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";

const PW = process.env.AQ_PW || "/Users/arash/.artaquest-dev/playwright-suite/node_modules/playwright/index.mjs";
const BASE = (process.env.AQ_BASE || "https://artaquest.com").replace(/\/$/, "");
const CDP = process.env.AQ_CDP || "http://127.0.0.1:9222";
const THEME = process.env.AQ_THEME || "dark";
const OUT = new URL(`../analysis/reading-experiment/qa-out/${THEME}/`, import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const ROUTES = ["/", "/courses", "/fields", "/research", "/data", "/sponsors", "/about", "/donations", "/pricing", "/discussions", "/u/arash"];
const norm = (p) => (p === "/" ? "/" : (p.endsWith("/") ? p : p + "/"));

// in-page: parse colours, decide brand vs off-brand, summarise the rendered palette + key checks
function inspect() {
  const parse = (s) => { const m = (s || "").match(/rgba?\(([^)]+)\)/i); if (!m) return null; const p = m[1].split(",").map(Number); return p[3] === 0 ? null : [p[0] | 0, p[1] | 0, p[2] | 0]; };
  // hue/sat of an rgb (HSV) — to classify accents
  const hsv = ([r, g, b]) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0; if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; } return { h, s: mx ? d / mx : 0, v: mx }; };
  // ArtaQuest accents: gold ~45-55°, blue ~220-230°. Allowed extra: rose/red (errors) ~340-360/0-15°. Neutral = low sat.
  const classify = (rgb) => { const { h, s, v } = hsv(rgb); if (s < 0.25 || v < 0.12) return "neutral";
    if (h >= 38 && h <= 60) return "gold"; if (h >= 205 && h <= 245) return "blue"; if (h >= 330 || h <= 16) return "rose"; return "OFFBRAND(" + Math.round(h) + "°)"; };
  const acc = {};
  document.querySelectorAll("body *").forEach((el) => {
    const cs = getComputedStyle(el);
    for (const prop of ["color", "backgroundColor", "borderTopColor"]) {
      const rgb = parse(cs[prop]); if (!rgb) continue; const k = classify(rgb);
      if (k.startsWith("OFFBRAND") || k === "gold" || k === "blue") { const key = k + " " + rgb.map((v) => v.toString(16).padStart(2, "0")).join(""); acc[key] = (acc[key] || 0) + 1; }
    }
  });
  const root = document.documentElement;
  const boot = document.querySelector("#aq-boot-screen");
  return {
    theme: root.getAttribute("data-theme"), contrast: root.getAttribute("data-contrast"),
    title: document.title,
    mounted: !!document.querySelector("#aq-app-root") && document.querySelector("#aq-app-root").childElementCount > 0,
    bootHidden: !boot || boot.classList.contains("aqb-hide") || getComputedStyle(boot).opacity === "0" || getComputedStyle(boot).display === "none",
    headings: document.querySelectorAll("h1,h2").length,
    h1: (document.querySelector("h1,h2")?.textContent || "").trim().slice(0, 60),
    bodyText: document.body.innerText.trim().length,
    inkVar: getComputedStyle(root).getPropertyValue("--color-ink").trim(),
    yangVar: getComputedStyle(root).getPropertyValue("--color-yang").trim(),
    yinVar: getComputedStyle(root).getPropertyValue("--color-yin").trim(),
    accents: acc,
  };
}

const { chromium } = await import(PW);
const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0] || (await browser.newContext());
const host = new URL(BASE).hostname;
await ctx.addCookies([{ name: "ay_lang", value: "en", domain: host, path: "/" }, { name: "aq_lang", value: "en", domain: host, path: "/" }]);
const page = await ctx.newPage();
page.setDefaultTimeout(20000);

async function go(path, level = 3) {
  const errs = [];
  const onMsg = (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); };
  const onErr = (e) => errs.push("PAGEERR: " + e.message.slice(0, 160));
  page.on("console", onMsg); page.on("pageerror", onErr);
  await page.evaluate((o) => { try { localStorage.setItem("aq_contrast", String(o.l)); localStorage.setItem("aq_theme", o.t); localStorage.setItem("ay_lang", "en"); } catch {} }, { l: level, t: THEME }).catch(() => {});
  await page.goto(BASE + norm(path), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2600);
  page.off("console", onMsg); page.off("pageerror", onErr);
  return errs;
}

console.log(`QA ${BASE} theme=${THEME}`);
const report = { base: BASE, theme: THEME, ts: new Date().toISOString(), routes: {} };
const offbrand = new Set();

for (const route of ROUTES) {
  let errs, info;
  try { errs = await go(route); info = await page.evaluate(inspect); }
  catch (e) { console.log(`  ✗ ${route}: ${e.message.split("\n")[0]}`); report.routes[route] = { error: e.message.slice(0, 120) }; await page.goto(BASE + "/").catch(() => {}); continue; }
  const off = Object.keys(info.accents).filter((k) => k.startsWith("OFFBRAND"));
  off.forEach((o) => offbrand.add(o));
  const ok = info.mounted && info.bootHidden && info.headings > 0 && info.bodyText > 200;
  report.routes[route] = { ok, consoleErrors: errs, ...info };
  const name = "shot_" + (route === "/" ? "home" : route.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "")) + "_L3.png";
  await page.screenshot({ path: OUT + name, fullPage: true }).catch(() => {});
  console.log(`  ${ok ? "✓" : "✗"} ${route.padEnd(16)} mounted=${info.mounted} boot-gone=${info.bootHidden} h=${info.headings} errs=${errs.length} yin=${info.yinVar} ${off.length ? "OFFBRAND:" + off.join(",") : ""}`);
}

// 5-level slider sweep on home (mechanism check + paper figure)
console.log("  -- slider sweep (home, L1..L5) --");
const inkByLevel = {};
for (let l = 1; l <= 5; l++) {
  await go("/", l);
  const ink = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-ink").trim());
  inkByLevel[l] = ink;
  await page.screenshot({ path: OUT + `slider_home_L${l}.png`, fullPage: false }).catch(() => {});
}
const sliderWorks = new Set(Object.values(inkByLevel)).size >= 4; // ink should differ across levels
console.log(`  slider moves --color-ink: ${JSON.stringify(inkByLevel)} → ${sliderWorks ? "WORKS" : "STUCK"}`);
report.sliderWorks = sliderWorks; report.inkByLevel = inkByLevel;
report.offbrandAccents = [...offbrand];

writeFileSync(new URL(`../analysis/reading-experiment/qa-report-${THEME}.json`, import.meta.url).pathname, JSON.stringify(report, null, 1));
const fails = Object.entries(report.routes).filter(([, r]) => r.ok === false || r.error).map(([k]) => k);
console.log(`\nQA ${THEME}: ${Object.keys(report.routes).length} routes, ${fails.length} failing${fails.length ? " (" + fails.join(",") + ")" : ""}, slider=${sliderWorks ? "ok" : "STUCK"}, off-brand accents=${offbrand.size}${offbrand.size ? " " + [...offbrand].join(",") : ""}`);
await page.close(); await browser.close();
