/**
 * ArtaQuest question-first model — browser smoke test (part of the dev cycle).
 *
 * Drives the REAL site through the persistent Chrome (CDP) as a logged-in admin: loads a
 * section, submits a question, checks the voting wall, then opens the course Rankings tab and
 * verifies the Kaggle podium (gold/silver/bronze 50/30/20). Forces English so the i18n mesh
 * doesn't translate the UI out from under the matchers. Prints assertions + a GREEN/RED marker.
 *
 *   node tools/browser-smoke.mjs            (needs the persistent Chrome on :9222)
 *
 * Playwright is resolved from the dev suite; override with AQ_PW=/path/to/playwright/index.mjs.
 */
const PW = process.env.AQ_PW || "/Users/arash/.artaquest-dev/playwright-suite/node_modules/playwright/index.mjs";
const BASE = process.env.AQ_BASE || "http://localhost:8881";
const CDP = process.env.AQ_CDP || "http://127.0.0.1:9222";
const SLUG = process.env.AQ_SLUG || "how-to-play-chess-the-ultimate-beginners-guide";

let pass = 0, fail = 0; const fails = [];
const ok = (label, cond) => { if (cond) pass++; else { fail++; fails.push(label); console.log("  ✗ FAIL:", label); } };

let chromium;
try { ({ chromium } = await import(PW)); }
catch { console.log("SKIP: playwright not found at", PW, "(set AQ_PW). AQ_BROWSER_RESULT=SKIP"); process.exit(0); }

let browser;
try { browser = await chromium.connectOverCDP(CDP); }
catch { console.log("SKIP: no Chrome on", CDP, "(persistent Chrome not running). AQ_BROWSER_RESULT=SKIP"); process.exit(0); }

const ctx = browser.contexts()[0];
await ctx.addCookies([{ name: "ay_lang", value: "en", domain: new URL(BASE).hostname, path: "/" }]);
const page = await ctx.newPage();
await page.addInitScript(() => {
  try { localStorage.setItem("ay_lang", "en"); } catch {}
  // Neutralize real full screen so the focus-mode check never hijacks the tester's screen — and spy it.
  window.__fs = 0;
  const noop = function () { window.__fs++; return Promise.resolve(); };
  HTMLElement.prototype.requestFullscreen = noop;
  HTMLElement.prototype.webkitRequestFullscreen = noop;
});
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERR: " + e.message));

try {
  // Log in as admin (session + AQ_WP_NONCE on the SPA shell).
  await page.goto(`${BASE}/studio-auto-login?redirect_to=%2F`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // ── Lesson surface ──
  await page.goto(`${BASE}/video/?video=1`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  ok("nonce injected for authed POSTs", await page.evaluate(() => !!window.AQ_WP_NONCE));
  ok("focus mode: play button is full-screen-gated", await page.locator('button[aria-label="Play video in full screen"]').first().isVisible().catch(() => false));
  ok("focus mode: explainer shown", await page.locator("text=Focus mode").first().isVisible().catch(() => false));
  // Enforcement: pressing play REQUESTS full screen; with real full screen spied to a no-op, the
  // watchdog must auto-pause (the play button returns) — i.e. playback can't run outside full screen.
  await page.locator('button[aria-label="Play video in full screen"]').first().click().catch(() => {});
  await page.waitForTimeout(900);
  ok("focus mode: play requests full screen", await page.evaluate(() => (window).__fs > 0));
  await page.waitForTimeout(3200);
  ok("focus mode: playback auto-pauses when not full screen", await page.locator('button[aria-label="Play video in full screen"]').first().isVisible().catch(() => false));
  ok("'Section discussion' board renders", await page.locator("text=Section discussion").first().isVisible().catch(() => false));
  ok("engagement steps (watch/comment/upvote) shown", await page.locator("text=Upvote a peer").first().isVisible().catch(() => false));
  ok("curriculum sidebar lists sections", (await page.locator("aside ol li").count()) >= 1);

  const ta = page.locator("#aq-comment");
  const body = `Dev-cycle smoke: a real takeaway from this section. (${Date.now() % 100000})`;
  if (await ta.count()) {
    await ta.first().fill(body);
    await page.locator('button:has-text("Post reply"), button:has-text("Post comment")').first().click();
    await page.waitForTimeout(1800);
    ok("comment appears in the board", await page.locator(`text=${body.slice(0, 30)}`).first().isVisible().catch(() => false));
    ok("Reddit up/down vote arrows render", (await page.locator('button[aria-label*="vote on"], button[aria-label*="upvote"], button[aria-label*="downvote"]').count()) >= 1 || (await page.locator("text=Sort").count()) >= 1);
    ok("Top/New sort controls render", (await page.locator('button:has-text("top"), button:has-text("new")').count()) >= 1);
  } else { ok("comment composer present", false); }

  // ── Rankings tab (podium) ──
  await page.goto(`${BASE}/courses/${SLUG}?tab=rankings`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const panel = (await page.locator('[role="tabpanel"]').innerText().catch(() => "")) || "";
  ok("rankings panel renders the header", /Course rankings/i.test(panel));
  ok("podium shows 1st/2nd/3rd place", /1st place/i.test(panel) && /2nd place/i.test(panel) && /3rd place/i.test(panel));
  ok("podium shows the 50/30/20 split", /50% of the pool/i.test(panel) && /30% of the pool/i.test(panel) && /20% of the pool/i.test(panel));
  ok("competition shows a new-moon deadline", /Competition closes/i.test(panel) && /new moon/i.test(panel));
  ok("competition rules are spelled out", /Competition rules/i.test(panel));

  ok("no console/page errors", errors.length === 0);
  if (errors.length) console.log("  console errors:", errors.slice(0, 6));
} catch (e) {
  ok("smoke test ran without throwing", false);
  console.log("  THREW:", e.message);
} finally {
  await page.close();
  await browser.close();
  console.log(`\nbrowser: PASS ${pass} / FAIL ${fail}`);
  if (fails.length) console.log("FAILURES:\n  - " + fails.join("\n  - "));
  console.log(fail === 0 ? "AQ_BROWSER_RESULT=GREEN" : "AQ_BROWSER_RESULT=RED");
  process.exit(0);
}
