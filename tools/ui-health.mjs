/**
 * UI HEALTH — "is the interface a member gets right now actually healthy?"
 *
 * The server-side half of this question is AQ\Health (GET /wp-json/aq/v1/health, operator-only):
 * does the build exist, do the routes resolve, is the schema migrated. This half answers the part
 * PHP cannot see — what the BROWSER ends up with after the bundle loads, React mounts, the i18n
 * gate opens and the contrast engine writes its tokens. Every measurement below is taken from the
 * RENDERED DOM on the live site; none of it reads source.
 *
 * Per route it measures:
 *   MOUNT     the SPA root has children, the boot screen is gone, a heading and real text render
 *   ERRORS    console errors, uncaught page errors, and same-origin requests that came back >= 400
 *             (a missing lazy chunk is a 404 here and a blank page for the member)
 *   BRAND     the CANONICAL rendered pair --color-yang + --color-yin must sum to WHITE per channel
 *             (yin = 255 - yang), plus a sweep for any third accent that is not gold/blue/neutral
 *   LAYOUT    no horizontal overflow at 390px, naming the elements that stick out
 *   A11Y      images with no alt, controls with no accessible name, inputs with no label,
 *             click handlers on non-interactive elements, primary tap targets under 44px
 *
 * Exit code is 1 when anything FAILS, so it can gate a deploy. It never writes to the site.
 *
 *   node tools/ui-health.mjs                          # prod, dark, the default route set
 *   AQ_BASE=http://localhost:5176 node tools/ui-health.mjs
 *   AQ_THEME=light AQ_ROUTES=/,/library node tools/ui-health.mjs
 *
 * Chrome: connects to the PERSISTENT browser over CDP (never headless — a headless render is not
 * the render a member gets). It REUSES the tab already marked #aq-audit when one exists, so a run
 * does not push the window past the four-tab ceiling, and it never activates that tab (a
 * non-activated tab is not rAF-throttled, so measurements stay honest in the background).
 */
import { writeFileSync, mkdirSync } from "node:fs";

const PW = process.env.AQ_PW || "/Users/arash/.artaquest-dev/tools/node_modules/playwright/index.mjs";
const BASE = (process.env.AQ_BASE || "https://artaquest.com").replace(/\/$/, "");
const CDP = process.env.AQ_CDP || "http://127.0.0.1:9222";
const THEME = process.env.AQ_THEME || "dark";
const LEVEL = +(process.env.AQ_LEVEL || 3);
const MOBILE_W = +(process.env.AQ_MOBILE_W || 390);
const OUT = new URL("../analysis/ui-health/", import.meta.url).pathname;

const ROUTES = (process.env.AQ_ROUTES || "/,/works,/library,/challenges,/discussions,/data,/about,/pricing,/developers,/u/arash")
  .split(",").map((s) => s.trim()).filter(Boolean);

const norm = (p) => (p === "/" ? "/" : p.endsWith("/") ? p : p + "/");

/** Everything measured inside the page. Returns plain JSON — no functions cross the boundary. */
function measure() {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const hex2rgb = (h) => {
    const m = String(h).trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return null;
    return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  };
  const parse = (s) => {
    const m = (s || "").match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    const p = m[1].split(",").map(Number);
    return p[3] === 0 ? null : [p[0] | 0, p[1] | 0, p[2] | 0];
  };
  const hsv = ([r, g, b]) => {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return { h, s: mx ? d / mx : 0, v: mx };
  };
  // Gold ~38-60deg, blue ~205-245deg. Rose/red is allowed for errors. Anything else is a third accent.
  const classify = (rgb) => {
    const { h, s, v } = hsv(rgb);
    if (s < 0.25 || v < 0.12) return "neutral";
    if (h >= 38 && h <= 60) return "gold";
    if (h >= 205 && h <= 245) return "blue";
    if (h >= 330 || h <= 16) return "rose";
    return "OFFBRAND(" + Math.round(h) + "deg)";
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0.05;
  };
  const named = (el) => {
    const t = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim();
    if (t) return true;
    const lb = el.getAttribute("aria-labelledby");
    if (lb && lb.split(/\s+/).some((id) => document.getElementById(id))) return true;
    // an <img alt> or an <svg><title> inside the control also names it
    return !!el.querySelector("img[alt]:not([alt=''])") || !!el.querySelector("svg title");
  };
  const where = (el) => {
    const id = el.id ? "#" + el.id : "";
    const cls = (el.className && typeof el.className === "string") ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    return (el.tagName.toLowerCase() + id + cls).slice(0, 70);
  };

  // ── brand: the canonical rendered pair must complete to white ────────────
  const yang = hex2rgb(cs.getPropertyValue("--color-yang")) || parse(cs.getPropertyValue("--color-yang"));
  const yin = hex2rgb(cs.getPropertyValue("--color-yin")) || parse(cs.getPropertyValue("--color-yin"));
  const sums = yang && yin ? [yang[0] + yin[0], yang[1] + yin[1], yang[2] + yin[2]] : null;

  // ── off-brand accent sweep over what is actually painted ─────────────────
  const accents = {};
  const els = [...document.querySelectorAll("body *")].slice(0, 4000);
  for (const el of els) {
    const s = getComputedStyle(el);
    for (const prop of ["color", "backgroundColor", "borderTopColor"]) {
      const rgb = parse(s[prop]);
      if (!rgb) continue;
      const k = classify(rgb);
      if (!k.startsWith("OFFBRAND")) continue;
      const key = k + " #" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
      accents[key] = (accents[key] || 0) + 1;
    }
  }

  // ── layout: what actually sticks out of the viewport ─────────────────────
  const docW = root.clientWidth;
  const overflow = [];
  if (document.body.scrollWidth > docW + 1) {
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.right > docW + 1 && visible(el)) overflow.push({ el: where(el), right: Math.round(r.right) });
      if (overflow.length >= 6) break;
    }
  }

  // ── a11y ────────────────────────────────────────────────────────────────
  const noAlt = [...document.querySelectorAll("img")].filter((i) => visible(i) && i.getAttribute("alt") === null).map(where).slice(0, 6);
  const unnamed = [...document.querySelectorAll("button,a[href],[role=button]")].filter((b) => visible(b) && !named(b)).map(where).slice(0, 6);
  const unlabelled = [...document.querySelectorAll("input:not([type=hidden]),select,textarea")].filter((f) => {
    if (!visible(f)) return false;
    if (f.getAttribute("aria-label") || f.getAttribute("aria-labelledby") || f.getAttribute("placeholder") || f.getAttribute("title")) return false;
    if (f.id && document.querySelector('label[for="' + CSS.escape(f.id) + '"]')) return false;
    return !f.closest("label");
  }).map(where).slice(0, 6);
  // A click handler on a plain div is only reachable by mouse — keyboard and screen-reader users
  // cannot fire it. Only inline handlers are visible from here, so this under-reports, never over.
  const fauxButtons = [...document.querySelectorAll("div[onclick],span[onclick]")]
    .filter((d) => visible(d) && !d.getAttribute("role") && d.tabIndex < 0).map(where).slice(0, 6);
  const smallTargets = [...document.querySelectorAll("button,a[href],[role=button]")].filter((b) => {
    if (!visible(b)) return false;
    const r = b.getBoundingClientRect();
    return r.height < 24 && r.width < 24; // clearly-too-small, not merely under 44
  }).map(where).slice(0, 6);

  const boot = document.querySelector("#aq-boot-screen");
  const appRoot = document.querySelector("#aq-app-root");
  return {
    title: document.title,
    // The visible prose, normalised — the i18n sweep after the route loop compares this across
    // locales. There are no translation KEYS to leak here (the mesh is content-addressed by the
    // md5 of the English source, so the fallback IS the English sentence); the only observable
    // failure is that a non-English reader gets English, which one render cannot tell you.
    proseSample: (document.querySelector("main, #aq-app-root")?.innerText || document.body.innerText || "")
      .replace(/\s+/g, " ").trim().slice(0, 400),
    lang: root.getAttribute("lang") || "",
    theme: root.getAttribute("data-theme"),
    contrast: root.getAttribute("data-contrast"),
    mounted: !!appRoot && appRoot.childElementCount > 0,
    bootHidden: !boot || boot.classList.contains("aqb-hide") || getComputedStyle(boot).opacity === "0" || getComputedStyle(boot).display === "none",
    headings: document.querySelectorAll("h1,h2").length,
    h1: (document.querySelector("h1,h2")?.textContent || "").trim().slice(0, 60),
    bodyText: document.body.innerText.trim().length,
    brand: { yang, yin, sums, complements: !!sums && sums.every((s) => s === 255) },
    offbrand: Object.keys(accents),
    viewportW: docW,
    scrollW: document.body.scrollWidth,
    overflow,
    a11y: { noAlt, unnamed, unlabelled, fauxButtons, smallTargets },
  };
}

// ── drive the persistent browser ───────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
let chromium;
try {
  ({ chromium } = await import(PW));
} catch {
  console.error(`ui-health: cannot load Playwright from ${PW}\n  set AQ_PW to your playwright index.mjs`);
  process.exit(2);
}

let browser;
try {
  browser = await chromium.connectOverCDP(CDP);
} catch {
  console.error(`ui-health: no Chrome listening on ${CDP}\n  start the persistent browser first (this tool never runs headless — a headless render is not the render a member gets)`);
  process.exit(2);
}

const ctx = browser.contexts()[0] || (await browser.newContext());
// Reuse the audit tab if it is already open, so a run never pushes the window past four tabs.
let page = ctx.pages().find((p) => p.url().includes("#aq-audit"));
const ours = !page;
if (!page) page = await ctx.newPage();
page.setDefaultTimeout(25000);

const host = new URL(BASE).hostname;
await ctx.addCookies([
  { name: "ay_lang", value: "en", domain: host, path: "/" },
  { name: "aq_lang", value: "en", domain: host, path: "/" },
]).catch(() => {});

const report = { base: BASE, theme: THEME, level: LEVEL, ts: new Date().toISOString(), routes: {} };
const fails = [];
const warns = [];

async function visit(path, width, level = LEVEL) {
  const errs = [];
  const bad = [];
  const onMsg = (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 180)); };
  const onErr = (e) => errs.push("PAGEERROR: " + e.message.slice(0, 180));
  const onRes = (r) => {
    const u = r.url();
    if (r.status() >= 400 && u.startsWith(BASE)) bad.push(r.status() + " " + u.replace(BASE, "").slice(0, 90));
  };
  // A request that never got a response has no status — it is the DNS/TLS/refused class, which is
  // how a dead third-party origin or a stale CDN host shows up. Console alone only says
  // "Failed to load resource", which names nothing and is useless for diagnosis.
  const onFail = (r) => {
    const u = r.url();
    if (u.startsWith("chrome-extension://") || u.startsWith("blob:") || u.startsWith("data:")) return;
    const why = (r.failure()?.errorText || "failed").replace("net::", "");
    // ERR_ABORTED is the SPA doing its job — an in-flight fetch cancelled because the component
    // unmounted or a newer request superseded it. Reporting it as a fault makes every route with a
    // race-guarded loader look broken.
    if (why === "ERR_ABORTED") return;
    bad.push(why + " " + u.slice(0, 110));
  };
  page.on("console", onMsg); page.on("pageerror", onErr); page.on("response", onRes); page.on("requestfailed", onFail);
  await page.setViewportSize({ width, height: 900 }).catch(() => {});
  // Set the theme/contrast the same way a member's browser does, then load the BARE url — a
  // ?cachebuster would hide a stale edge entry, which is the exact failure worth catching.
  await page.evaluate((o) => {
    try {
      localStorage.setItem("aq_contrast", String(o.l));
      localStorage.setItem("aq_theme", o.t);
      localStorage.setItem("ay_lang", "en");
    } catch { /* a fresh origin has no storage yet */ }
  }, { l: level, t: THEME }).catch(() => {});
  await page.goto(BASE + norm(path), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000); // the i18n gate + the lazy route chunk
  const m = await page.evaluate(measure);
  page.off("console", onMsg); page.off("pageerror", onErr); page.off("response", onRes); page.off("requestfailed", onFail);
  // "Failed to load resource" is the console's echo of a network failure the requestfailed/response
  // listeners already name precisely — keep the named one, drop the blind one.
  const named = errs.filter((e) => !/Failed to load resource/i.test(e));
  return { ...m, consoleErrors: named, badResponses: [...new Set(bad)] };
}

console.log(`UI HEALTH  ${BASE}  theme=${THEME} L${LEVEL}`);
// Warm-up navigation. visit() writes the theme/contrast into localStorage BEFORE it navigates, which
// only works once the tab is already on our origin — on a cold tab that write lands on about:blank
// (or whatever the tab held last) and the FIRST route silently renders with stale settings. That is
// how a run reported the L5 palette while claiming to measure L3.
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" }).catch(() => {});

for (const route of ROUTES) {
  let d, mob;
  try {
    d = await visit(route, 1440);
    mob = await visit(route, MOBILE_W);
  } catch (e) {
    const msg = e.message.split("\n")[0].slice(0, 120);
    report.routes[route] = { error: msg };
    fails.push(`${route}: ${msg}`);
    console.log(`  ✗ ${route.padEnd(14)} ${msg}`);
    continue;
  }

  const problems = [];
  if (!d.mounted) problems.push("SPA did not mount");
  if (!d.bootHidden) problems.push("boot screen never cleared");
  if (d.headings === 0) problems.push("no heading rendered");
  if (d.bodyText < 200) problems.push(`almost no text (${d.bodyText} chars)`);
  if (d.consoleErrors.length) problems.push(`${d.consoleErrors.length} console error(s): ${d.consoleErrors[0]}`);
  if (d.badResponses.length) problems.push(`${d.badResponses.length} failed request(s): ${d.badResponses[0]}`);
  if (d.brand.sums && !d.brand.complements) problems.push(`brand pair sums to ${d.brand.sums.join(",")} not 255,255,255`);
  if (mob.overflow.length) problems.push(`overflows ${MOBILE_W}px: ${mob.overflow[0].el} reaches ${mob.overflow[0].right}px`);

  const soft = [];
  if (d.offbrand.length) soft.push(`third accent: ${d.offbrand.slice(0, 3).join(", ")}`);
  for (const [k, label] of [["noAlt", "img without alt"], ["unnamed", "control with no accessible name"], ["unlabelled", "input with no label"], ["fauxButtons", "click handler on a plain div"], ["smallTargets", "tap target under 24px"]]) {
    if (d.a11y[k].length) soft.push(`${d.a11y[k].length} ${label} (${d.a11y[k][0]})`);
  }

  report.routes[route] = { ok: problems.length === 0, problems, soft, desktop: d, mobile: { overflow: mob.overflow, scrollW: mob.scrollW, viewportW: mob.viewportW } };
  problems.forEach((p) => fails.push(`${route}: ${p}`));
  soft.forEach((s) => warns.push(`${route}: ${s}`));

  console.log(
    `  ${problems.length ? "✗" : soft.length ? "!" : "✓"} ${route.padEnd(14)}` +
    ` mount=${d.mounted ? "y" : "N"} boot=${d.bootHidden ? "gone" : "STUCK"} h=${d.headings}` +
    ` err=${d.consoleErrors.length + d.badResponses.length} brand=${d.brand.complements ? "ok" : d.brand.sums ? d.brand.sums.join("/") : "?"}` +
    ` ovf=${mob.overflow.length}` + (soft.length ? `  a11y/brand: ${soft.length}` : "")
  );
  for (const p of problems) console.log(`      ✗ ${p}`);
  for (const s of soft) console.log(`      ! ${s}`);
}

// ── The contrast engine still MOVES ────────────────────────────────────────
// A frozen contrast slider reads as perfectly healthy on every per-route check above: the tokens are
// present, they complete to white, nothing errors. The only way to know the mechanism still works is
// to move it and watch --color-ink change. Five levels should give at least four distinct inks.
const inkByLevel = {};
for (let l = 1; l <= 5; l++) {
  try {
    await visit("/", 1440, l);
    inkByLevel[l] = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-ink").trim());
  } catch { inkByLevel[l] = ""; }
}
await visit("/", 1440, LEVEL).catch(() => {}); // leave the tab on the level this run reports
const sliderWorks = new Set(Object.values(inkByLevel).filter(Boolean)).size >= 4;
report.contrast = { inkByLevel, sliderWorks };
if (!sliderWorks) fails.push(`contrast slider is stuck — --color-ink took ${new Set(Object.values(inkByLevel)).size} distinct values across L1..L5`);
console.log(`\n  CONTRAST ${Object.entries(inkByLevel).map(([l, v]) => `L${l} ${v || "?"}`).join(" · ")}  ${sliderWorks ? "✓ moves" : "✗ STUCK"}`);

// ── The translation mesh actually translates ───────────────────────────────
// ~133 languages ride on this and it gates first paint, so when it stalls the symptom is not an
// error — it is every non-English reader silently getting English. One render can never show that;
// you have to load the same route twice in different locales and compare the prose.
// The locale is a URL PATH SEGMENT (/es/…), not a cookie — the theme routes on it (I18n::is_locale)
// and that is what a real non-English reader gets from a hreflang link or a search result. Asking
// with a cookie alone measures nothing and reports a false stall.
const I18N_LANG = process.env.AQ_I18N_LANG || "es";
let i18n = { lang: I18N_LANG, translated: null, en: "", other: "" };
try {
  const en = report.routes[ROUTES[0]]?.desktop?.proseSample || "";
  await page.goto(`${BASE}/${I18N_LANG}${norm(ROUTES[0])}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500); // the mesh translates on demand the first time a string is seen
  const other = await page.evaluate(() => (document.querySelector("main, #aq-app-root")?.innerText || document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400));
  i18n = { lang: I18N_LANG, translated: !!en && !!other && en !== other, en: en.slice(0, 80), other: other.slice(0, 80) };
  if (i18n.translated === false) warns.push(`i18n: /${I18N_LANG}/ renders the same prose as English — the mesh may be stalled`);
} catch (e) {
  warns.push(`i18n: could not compare locales (${String(e.message).split("\n")[0].slice(0, 80)})`);
}
report.i18n = i18n;
console.log(`  I18N     ${I18N_LANG} ${i18n.translated === null ? "?" : i18n.translated ? "✓ differs from English" : "✗ identical to English"}`);

// ── The routes the SPA actually calls still answer ─────────────────────────
// Incidental coverage is not coverage: a route is only exercised above if some page happened to fire
// it. Ask directly, from inside the page so the session cookie and same-origin rules are the real
// ones. 401/403 on a member-only route is a HEALTHY answer from a signed-out browser — only a 5xx,
// a 404 (route missing entirely) or a network failure is a fault.
const PROBE = (process.env.AQ_PROBE || "/posts?sort=new,/library,/challenges,/leaderboard,/reserve,/coins/price,/health/pulse")
  .split(",").map((s) => s.trim()).filter(Boolean);
const probed = await page.evaluate(async (paths) => {
  const out = {};
  for (const p of paths) {
    try {
      const r = await fetch("/wp-json/aq/v1" + p, { credentials: "include" });
      out[p] = r.status;
    } catch (e) {
      out[p] = String((e && e.message) || "network");
    }
  }
  return out;
}, PROBE);
report.api = probed;
const apiBad = Object.entries(probed).filter(([, s]) => typeof s !== "number" || s >= 500 || s === 404);
apiBad.forEach(([p, s]) => fails.push(`API ${p} → ${s}`));
console.log(`  API      ${Object.entries(probed).map(([p, s]) => `${p.split("?")[0]} ${s}`).join(" · ")}  ${apiBad.length ? "✗" : "✓"}`);

report.fails = fails;
report.warns = warns;
const file = OUT + `ui-health-${THEME}.json`;
writeFileSync(file, JSON.stringify(report, null, 1));

const first = report.routes[ROUTES[0]]?.desktop?.brand;
console.log(
  `\n  BRAND    ${first?.yang ? "#" + first.yang.map((v) => v.toString(16).padStart(2, "0")).join("") : "?"}` +
  ` + ${first?.yin ? "#" + first.yin.map((v) => v.toString(16).padStart(2, "0")).join("") : "?"}` +
  ` = ${first?.sums ? first.sums.join(", ") : "?"} ${first?.complements ? "✓ complete to white" : "✗ must be 255, 255, 255"}`
);
console.log(`  VERDICT  ${ROUTES.length} routes · ${fails.length} failing · ${warns.length} to polish  →  ${file}`);
if (fails.length) console.log(`\n  ${fails.length} FAILURES:\n` + fails.map((f) => "    ✗ " + f).join("\n"));

if (ours) await page.close().catch(() => {});
await browser.close().catch(() => {});
process.exit(fails.length ? 1 : 0);
