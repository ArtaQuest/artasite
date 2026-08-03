/**
 * Discussions rebuild — browser smoke (CDP via the persistent Chrome, against the Vite dev server
 * which authenticates as the admin dev user through the localhost shim).
 * Verifies, as an ADMIN viewer (the reported-bug persona):
 *   1. a REPLY renders live vote arrows (not the dimmed own-post state)
 *   2. tapping upvote moves the count INSTANTLY (optimistic) and persists across reload
 *   3. tapping again clears it (Reddit toggle), count returns
 *   4. posting a reply appends it locally without a reload
 *   5. Top/New sort buttons refetch
 * Prints GREEN/RED marker. Usage: node aq-smoke-discussions.mjs <threadId>
 */
const PW = process.env.AQ_PW || "/Users/arash/.artaquest-dev/playwright-suite/node_modules/playwright/index.mjs";
const BASE = process.env.AQ_BASE || "http://localhost:5199";
const CDP = process.env.AQ_CDP || "http://127.0.0.1:9222";
const TID = process.argv[2];
if (!TID) { console.log("usage: node aq-smoke-discussions.mjs <threadId>"); process.exit(1); }

let pass = 0, fail = 0; const fails = [];
const ok = (label, cond) => { if (cond) { pass++; console.log("  ✓", label); } else { fail++; fails.push(label); console.log("  ✗ FAIL:", label); } };

// Fresh headless browser: the Vite dev proxy injects X-AQ-Dev-User, so auth needs no cookies.
const { chromium } = await import(PW);
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await ctx.addCookies([{ name: "ay_lang", value: "en", domain: "localhost", path: "/" }]);
const page = await ctx.newPage();
try {
  await page.goto(`${BASE}/discussions/?forum=general&thread=${TID}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("h1", { timeout: 20000 });

  // The reply row (text "fixture REPLY to vote on") must carry LIVE arrows for the admin viewer.
  const reply = page.locator("li", { hasText: "fixture REPLY to vote on" }).last();
  await reply.waitFor({ timeout: 15000 });
  const upBtn = reply.locator('button[aria-label="upvote" i], button[aria-label="Remove upvote" i]').first();
  ok("reply shows a clickable upvote arrow (admin not treated as owner)", (await upBtn.count()) > 0);

  // Read the count next to the arrows, tap up, and require the count to move within 150ms (optimistic).
  const score = reply.locator("span.tabular-nums").first();
  const before = parseInt((await score.innerText()).trim(), 10);
  await upBtn.click();
  await page.waitForTimeout(150);
  const after150 = parseInt((await score.innerText()).trim(), 10);
  ok(`upvote applies instantly (${before} → ${after150} within 150ms)`, after150 === before + 1);

  // Persisted: reload and the cast arrow + count must come back from the server.
  await page.waitForTimeout(800); // let the POST settle
  await page.reload({ waitUntil: "domcontentloaded" });
  const reply2 = page.locator("li", { hasText: "fixture REPLY to vote on" }).last();
  await reply2.waitFor({ timeout: 15000 });
  const cast = reply2.locator('button[aria-pressed="true"]');
  ok("vote persists across reload (arrow re-renders cast)", (await cast.count()) > 0);
  const score2 = parseInt((await reply2.locator("span.tabular-nums").first().innerText()).trim(), 10);
  ok("score persists across reload", score2 === before + 1);

  // Toggle off (Reddit): tap the cast arrow again → instant decrement; settle.
  await cast.first().click();
  await page.waitForTimeout(150);
  const after = parseInt((await reply2.locator("span.tabular-nums").first().innerText()).trim(), 10);
  ok("re-tap clears the vote instantly", after === before);
  await page.waitForTimeout(800);

  // Post a reply: it must appear WITHOUT a reload (local append of the server card).
  const root = page.locator("li", { hasText: "fixture root comment" }).first();
  await root.locator("button", { hasText: "Reply" }).first().click();
  const box = page.locator("textarea").last();
  const marker = `smoke reply ${Date.now()}`;
  await box.fill(marker);
  await page.locator("button", { hasText: /^(Reply|Post)$/ }).last().click();
  await page.waitForSelector(`text=${marker}`, { timeout: 10000 });
  ok("posted reply appears in place (no reload)", true);

  // Sort buttons trigger a server refetch (response watched on the wire).
  const sawSort = page.waitForResponse((r) => r.url().includes(`/threads/${TID}`) && r.url().includes("sort=new"), { timeout: 10000 }).then(() => true).catch(() => false);
  await page.locator("button", { hasText: /^New$/ }).first().click();
  ok("New sort refetches from the server", await sawSort);
} catch (e) {
  fail++; fails.push("exception: " + e.message);
  console.log("  ✗ exception:", e.message);
} finally {
  await page.close();
  await browser.close();
}
console.log(`\nPASS ${pass} / FAIL ${fail}`);
if (fails.length) console.log("FAILURES:\n  - " + fails.join("\n  - "));
console.log("AQ_SMOKE_RESULT=" + (fail ? "RED" : "GREEN"));
process.exit(fail ? 1 : 0);
