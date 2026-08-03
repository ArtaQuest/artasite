/**
 * Read-mode audit for a journal article (the core reading surface). Measures the article's reading
 * typography against the empirical reading-optimization literature, in a given theme, + screenshots.
 *
 * Captures, for the MAIN article column:
 *   • body: font-size, line-height ratio, colour, APCA Lc on its real bg, and the MEASURE (chars/line)
 *   • headings h1/h2/h3, links, blockquote, figcaption, code/pre, list/reference items — size + Lc
 *   • the reading column width (px) and paragraph spacing (vertical rhythm)
 * Verdict vs lit: body 16–19px · line-height 1.5–1.7 · measure 45–75 char · body Lc 75–90 · clear hierarchy.
 *
 *   AQ_URL='https://artaquest.com/research/?journal=seasonality&submission=9' AQ_THEME=dark node tools/readmode-audit.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
const PW = process.env.AQ_PW || "/Users/arash/.artaquest-dev/playwright-suite/node_modules/playwright/index.mjs";
const URL_ = process.env.AQ_URL || "https://artaquest.com/research/?journal=seasonality&submission=9";
const CDP = process.env.AQ_CDP || "http://127.0.0.1:9222";
const THEME = process.env.AQ_THEME || "dark";
const LEVEL = +(process.env.AQ_LEVEL || 3);
const OUT = new URL("../analysis/reading-experiment/readmode-out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function measureReading() {
  const sx = (c) => Math.pow(c / 255, 2.4);
  const aY = (a) => 0.2126729 * sx(a[0]) + 0.7151522 * sx(a[1]) + 0.072175 * sx(a[2]);
  const clB = (y) => (y >= 0.022 ? y : y + Math.pow(0.022 - y, 1.414));
  const lc = (t, b) => { const Yt = clB(aY(t)), Yb = clB(aY(b)); if (Math.abs(Yb - Yt) < 5e-4) return 0; let S, o;
    if (Yb > Yt) { S = (Math.pow(Yb, 0.56) - Math.pow(Yt, 0.57)) * 1.14; o = S < 0.1 ? 0 : S - 0.027; }
    else { S = (Math.pow(Yb, 0.65) - Math.pow(Yt, 0.62)) * 1.14; o = S > -0.1 ? 0 : S + 0.027; } return Math.abs(o * 100); };
  const parse = (s) => { const m = (s || "").match(/rgba?\(([^)]+)\)/i); if (!m) return [0, 0, 0]; const p = m[1].split(",").map(Number); return [p[0] | 0, p[1] | 0, p[2] | 0]; };
  const bgOf = (el) => { let n = el; while (n && n !== document.documentElement) { const c = getComputedStyle(n).backgroundColor; const m = (c || "").match(/rgba?\(([^)]+)\)/i); if (m) { const p = m[1].split(",").map(Number); if (p[3] === undefined || p[3] > 0.05) return [p[0] | 0, p[1] | 0, p[2] | 0]; } n = n.parentElement; } return parse(getComputedStyle(document.body).backgroundColor); };
  const px = (s) => parseFloat(s) || 0;
  // width of "n" glyphs via canvas at the element's font → chars per line = colWidth / avgAdvance
  const cv = document.createElement("canvas").getContext("2d");
  const charsPerLine = (el) => { const cs = getComputedStyle(el); cv.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const w = cv.measureText("abcdefghijklmnopqrstuvwxyz ".repeat(2)).width / 54; return w ? Math.round(el.clientWidth / w) : null; };
  const info = (el) => { if (!el) return null; const cs = getComputedStyle(el); const fg = parse(cs.color), bg = bgOf(el);
    return { px: +px(cs.fontSize).toFixed(1), weight: +cs.fontWeight, lineHeight: +(px(cs.lineHeight) / px(cs.fontSize)).toFixed(2),
      color: "#" + fg.map((v) => v.toString(16).padStart(2, "0")).join(""), bg: "#" + bg.map((v) => v.toString(16).padStart(2, "0")).join(""),
      lc: +lc(fg, bg).toFixed(1), text: (el.textContent || "").trim().slice(0, 50) }; };

  // find the article column: the container of the longest run of <p>
  const ps = [...document.querySelectorAll("p")].filter((p) => (p.textContent || "").trim().length > 120);
  const body = ps.sort((a, b) => b.textContent.length - a.textContent.length)[0];
  const col = body ? body.parentElement : null;
  const pick = (sel) => { const els = [...document.querySelectorAll(sel)].filter((e) => (e.textContent || "").trim().length > 2); return els[0]; };
  return {
    theme: document.documentElement.getAttribute("data-theme"), contrast: document.documentElement.getAttribute("data-contrast"),
    title: document.title, viewport: { w: innerWidth, h: innerHeight },
    columnWidthPx: col ? col.clientWidth : null,
    body: body ? { ...info(body), measureChars: charsPerLine(body) } : null,
    h1: info(pick("h1")), h2: info(pick("h2")), h3: info(pick("h3")),
    lead: info(pick("p.lead, .lead, header p, [class*=lede]")),
    link: info(pick("article a, main a, .prose a, a[href^='#'], a")),
    blockquote: info(pick("blockquote")), figcaption: info(pick("figcaption, figure figcaption")),
    code: info(pick("code, pre")), listItem: info(pick("li")),
    paraGapPx: ps.length > 1 ? Math.round(ps[1].getBoundingClientRect().top - ps[0].getBoundingClientRect().bottom) : null,
    paragraphCount: ps.length,
  };
}

const { chromium } = await import(PW);
const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0] || (await browser.newContext());
const host = new URL(URL_).hostname;
await ctx.addCookies([{ name: "ay_lang", value: "en", domain: host, path: "/" }]);
const page = await ctx.newPage();
page.setDefaultTimeout(25000);
await page.goto(URL_, { waitUntil: "domcontentloaded" });
await page.evaluate((o) => { try { localStorage.setItem("aq_contrast", String(o.l)); localStorage.setItem("aq_theme", o.t); localStorage.setItem("ay_lang", "en"); } catch {} }, { l: LEVEL, t: THEME });
await page.goto(URL_, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);

const m = await page.evaluate(measureReading);
writeFileSync(OUT + `readmode-${THEME}.json`, JSON.stringify({ url: URL_, ...m }, null, 1));
await page.screenshot({ path: OUT + `article_${THEME}_full.png`, fullPage: true }).catch(() => {});
// a viewport crop of the body for a close legibility read
await page.evaluate(() => { const p = [...document.querySelectorAll("p")].filter((x) => x.textContent.trim().length > 120)[0]; if (p) p.scrollIntoView({ block: "center" }); });
await page.waitForTimeout(400);
await page.screenshot({ path: OUT + `article_${THEME}_body.png`, fullPage: false }).catch(() => {});

const v = [];
if (m.body) {
  v.push(`body: ${m.body.px}px / lh ${m.body.lineHeight} / Lc ${m.body.lc} / measure ${m.body.measureChars} char  on ${m.body.bg}`);
  v.push(`  size 16-19px? ${m.body.px >= 16 && m.body.px <= 19.5 ? "OK" : "OFF (" + m.body.px + ")"}`);
  v.push(`  line-height 1.5-1.7? ${m.body.lineHeight >= 1.45 && m.body.lineHeight <= 1.75 ? "OK" : "OFF (" + m.body.lineHeight + ")"}`);
  v.push(`  measure 45-75 char? ${m.body.measureChars >= 45 && m.body.measureChars <= 78 ? "OK" : "OFF (" + m.body.measureChars + ")"}`);
  v.push(`  body Lc 75-90? ${m.body.lc >= 72 ? "OK" : "LOW (" + m.body.lc + ")"}`);
}
v.push(`column ${m.columnWidthPx}px · para-gap ${m.paraGapPx}px · ${m.paragraphCount} paragraphs`);
if (m.h2) v.push(`h2 ${m.h2.px}px Lc ${m.h2.lc} · h3 ${m.h3 ? m.h3.px + "px" : "—"} · link Lc ${m.link ? m.link.lc : "—"} (${m.link ? m.link.color : ""})`);
console.log(`READ-MODE ${THEME} @ ${URL_}\n` + v.map((x) => "  " + x).join("\n"));
console.log(`  → ${OUT}readmode-${THEME}.json + article_${THEME}_{full,body}.png`);
await page.close(); await browser.close();
