/**
 * Section (competition) board smoke — drives the rebuilt SectionBoardView on the standalone
 * /discussions/?section=<lessonId> page through the Vite dev server (X-AQ-Dev-User auth shim).
 * Verifies: optimistic vote on a PEER comment (instant + persists + toggles), local append on
 * posting a reply (no board refetch losing scroll/pages). Usage: node aq-smoke-section.mjs <lessonId>
 */
const PW = process.env.AQ_PW || "/Users/arash/.artaquest-dev/playwright-suite/node_modules/playwright/index.mjs";
const BASE = process.env.AQ_BASE || "http://localhost:5199";
const LID = process.argv[2];
if (!LID) { console.log("usage: node aq-smoke-section.mjs <lessonId>"); process.exit(1); }

let pass = 0, fail = 0; const fails = [];
const ok = (label, cond) => { if (cond) { pass++; console.log("  ✓", label); } else { fail++; fails.push(label); console.log("  ✗ FAIL:", label); } };

const { chromium } = await import(PW);
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await ctx.addCookies([{ name: "ay_lang", value: "en", domain: "localhost", path: "/" }]);
const page = await ctx.newPage();
try {
  await page.goto(`${BASE}/discussions/?section=${LID}`, { waitUntil: "domcontentloaded" });
  // A peer comment = a votable control exists (own comments render the dimmed state instead).
  const wall = page.locator('[aria-label="Vote"]').first(); // the live VoteControl container
  await wall.waitFor({ timeout: 20000 });
  const up = wall.locator('button[aria-label="upvote" i]');
  const score = wall.locator("span.tabular-nums");
  const before = parseInt((await score.innerText()).trim(), 10);
  await up.click();
  await page.waitForTimeout(150);
  const after150 = parseInt((await score.innerText()).trim(), 10);
  ok(`peer upvote applies instantly (${before} → ${after150} within 150ms)`, after150 === before + 1);
  await page.waitForTimeout(1200);
  await page.reload({ waitUntil: "domcontentloaded" });
  const cast = page.locator('button[aria-pressed="true"][aria-label="Remove upvote" i]').first();
  await cast.waitFor({ timeout: 20000 });
  ok("vote persists across reload (arrow re-renders cast)", true);
  await cast.click(); // toggle back off so the smoke is idempotent
  await page.waitForTimeout(1200);

  // Reply to the first comment — must appear in place, with NO /thread refetch of the whole board.
  let boardRefetches = 0;
  page.on("request", (r) => { if (r.url().includes(`/sections/${LID}/thread`) && !r.url().includes("parent=")) boardRefetches++; });
  await page.locator("button", { hasText: "Reply" }).first().click();
  const marker = `section smoke reply ${Date.now()}`;
  await page.locator("textarea").last().fill(marker);
  await page.locator('button[type="submit"]', { hasText: "Reply" }).last().click();
  await page.waitForSelector(`text=${marker}`, { timeout: 10000 });
  ok("posted reply appears in place", true);
  ok("no full-board refetch on post (local append)", boardRefetches === 0);
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
