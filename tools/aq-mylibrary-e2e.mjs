// My Library E2E — run with: node tools/aq-mylibrary-e2e.mjs (needs `npm run dev` + persistent Chrome
// on :9222, and fixtures built by the ffmpeg block in the header comment below).
//   mkdir -p /tmp/aq-fixtures && ffmpeg -f lavfi -i sine=frequency=440:duration=3 -i cover.png \
//     -map 0:a -map 1:v -c:v copy -disposition:v attached_pic -metadata title=... -id3v2_version 3 tone1.mp3
// My Library E2E — import → parse tags → play (real gesture) → persist → offline → delete.
import { connectCDP } from "/private/tmp/claude-501/-Users-arash-Studio-artaquest/8dc7d313-b866-4d38-8f5f-c1bf8dd9fddf/scratchpad/cdp.mjs";
const FX = "/tmp/aq-fixtures";
setTimeout(() => { console.log("WATCHDOG: exceeded 5 min — dumping partial results"); process.exit(2); }, 300000);
const browser = await connectCDP();
const pg = await browser.contexts()[0].newPage();
await pg.setViewportSize({ width: 1280, height: 900 });
const errs = [];
pg.on("pageerror", (e) => errs.push("PAGEERR " + String(e).slice(0, 160)));
pg.on("console", (m) => { if (m.type() === "error" && !/favicon|404/.test(m.text())) errs.push(m.text().slice(0, 140)); });
pg.on("dialog", d => { console.log("… dialog:", d.message().slice(0,40)); d.accept().catch(() => {}); });
const pass = [], fail = [];
const check = (name, ok, detail = "") => { (ok ? pass : fail).push(name + (detail ? ` — ${detail}` : "")); console.log((ok ? "  ok  " : "  FAIL") + " " + name + (detail ? ` — ${detail}` : "")); };

pg.setDefaultTimeout(45000);
await pg.context().setOffline(false); // reset: a previous aborted run can leave the context offline
await pg.goto("http://localhost:5173/my-library", { waitUntil: "domcontentloaded" });
// clean slate
await pg.evaluate(async () => { try { indexedDB.deleteDatabase("aq-library"); } catch {} });
await pg.reload({ waitUntil: "domcontentloaded" });
await pg.waitForSelector('input[type="file"]', { state: "attached", timeout: 60000 });
check("1 page renders + styled", await pg.evaluate(() => getComputedStyle(document.querySelector(".aq-lib-add")).cursor === "pointer"));

// IMPORT: 2 mp3 + mp4 + pdf + a corrupt file (fault isolation)
console.log("… importing");
await pg.setInputFiles('input[type="file"]', [`${FX}/tone1.mp3`, `${FX}/tone2.mp3`, `${FX}/clip.mp4`, `${FX}/doc.pdf`, `${FX}/corrupt.mp3`]);
await pg.waitForFunction(() => document.querySelectorAll(".aq-lib-item").length >= 4, { timeout: 120000 }).catch(() => {});
await new Promise(r => setTimeout(r, 2500));   // covers + posters resolve in an async effect
const after = await pg.evaluate(() => ({
  n: document.querySelectorAll(".aq-lib-item").length,
  titles: [...document.querySelectorAll(".aq-lib-title")].map(e => e.textContent),
  subs: [...document.querySelectorAll(".aq-lib-sub")].map(e => e.textContent),
  note: document.body.textContent || "",
  covers: document.querySelectorAll("img.aq-lib-art").length,
}));
check("2 imported exactly the 4 valid files", after.n === 4, `got ${after.n}`);
check("3 ID3 title parsed", after.titles.some(t => /Tone Test One/.test(t)), JSON.stringify(after.titles));
check("4 ID3 artist parsed", after.subs.some(s => /Arta Tester/.test(s)));
check("5 embedded cover extracted", after.covers >= 1, `${after.covers} cover imgs`);
check("6 corrupt file reported, batch survived", /couldn't be added/i.test(after.note) && /playable/i.test(after.note), (after.note.match(/[^.]*couldn't be added[^.]*/) || ["(no failure notice)"])[0].slice(0, 100));
check("7 privacy: member titles carry data-ay-skip",
  await pg.evaluate(() => [...document.querySelectorAll(".aq-lib-title")].every(t => t.closest("[data-ay-skip]"))));
check("8 no aria-label leaks a filename",
  await pg.evaluate(() => ![...document.querySelectorAll("[aria-label]")].some(e => /tone1|Tone Test|\.mp3/i.test(e.getAttribute("aria-label") || ""))));

// PLAY with a REAL user gesture (autoplay policy: a scripted play() would be a false green)
console.log("… playing");
await pg.evaluate(() => { const t = [...document.querySelectorAll(".aq-lib-tab")].find(x => /Music/.test(x.textContent || "")); t?.click(); });
await pg.waitForFunction(() => [...document.querySelectorAll(".aq-lib-sub")].every(s => !/PDF|Video/.test(s.textContent || "")), { timeout: 10000 }).catch(() => {});
const musicTile = await pg.$('.aq-lib-item .aq-lib-open');   // now guaranteed to be a track
await musicTile.click();
await pg.waitForSelector(".aq-pl-bar", { timeout: 30000 }).catch(() => {});
// WAIT for real playback rather than sleeping: on a loaded machine 2.5 s can land mid-transition.
await pg.waitForFunction(() => { const a = document.querySelector("audio"); return a && !a.paused && a.currentTime > 0.3; }, { timeout: 30000 }).catch(() => {});
const play = await pg.evaluate(() => {
  const a = [...document.querySelectorAll("audio")].find(x => x.src) || document.querySelector("audio");
  return { bar: !!document.querySelector(".aq-pl-bar"), t: a?.currentTime ?? -1, paused: a?.paused ?? true, src: (a?.src || "").slice(0, 12) };
});
check("9 player bar appears", play.bar);
check("10 audio ACTUALLY advances", play.t > 0.2 && !play.paused, `t=${play.t.toFixed?.(2)} paused=${play.paused}`);
check("11 plays from a blob (on-device)", play.src.startsWith("blob:"), play.src);

// next track
const before12 = await pg.evaluate(() => document.querySelector(".aq-pl-meta-title")?.textContent || "");
await pg.click('.aq-pl-bar button[aria-label="Next track"]').catch(() => {});
await pg.waitForFunction((prev) => (document.querySelector(".aq-pl-meta-title")?.textContent || "") !== prev, before12, { timeout: 20000 }).catch(() => {});
const after12 = await pg.evaluate(() => document.querySelector(".aq-pl-meta-title")?.textContent || "");
check("12 next track switches", after12 && after12 !== before12, `${before12} → ${after12}`);

// PERSISTENCE across reload
console.log("… reload");
await pg.reload({ waitUntil: "domcontentloaded" });
await pg.waitForSelector(".aq-lib-item", { timeout: 60000 }).catch(() => {});
check("13 library persists across reload", await pg.evaluate(() => document.querySelectorAll(".aq-lib-item").length === 4), await pg.evaluate(() => String(document.querySelectorAll(".aq-lib-item").length)));

// OFFLINE: kill the network, library must still play
console.log("… offline phase");
// stash the module BEFORE going offline — a dynamic import cannot be fetched with the network down
await pg.evaluate(async () => { window.__ms = await import("/src/lib/media-store.ts"); });
await pg.context().setOffline(true);
// NOTE: Vite dev ships no service worker, so an offline RELOAD can never work here — that shell check
// belongs to prod. What we CAN prove offline is the real claim: the bytes come from the device.
const off = await pg.evaluate(async () => {
  const m = window.__ms;
  const items = await m.listItems();
  const url = items.length ? await m.fileUrl(items.find(i => i.kind === "music").id) : "";
  return { n: items.length, blob: url.startsWith("blob:") };
});
check("14 OFFLINE: library reads from the device", off.n === 4 && off.blob, JSON.stringify(off));
const played = await pg.evaluate(async () => {
  const a = document.querySelector("audio"); if (!a) return false;
  try { await a.play(); } catch { /* already playing */ }
  const t0 = a.currentTime; await new Promise(r => setTimeout(r, 900));
  return a.currentTime > t0;
});
check("15 OFFLINE: audio keeps advancing", played);
console.log("… back online");
await pg.context().setOffline(false);
await new Promise(r => setTimeout(r, 800));
console.log("… reload after offline");
// STORAGE meter + DELETE
await pg.goto("http://localhost:5173/my-library", { waitUntil: "domcontentloaded" }).catch(e => console.log("  nav failed:", String(e).slice(0,70)));
console.log("… reloaded");
await pg.waitForSelector(".aq-lib-item", { timeout: 60000 }).catch(() => {});
check("16 storage meter honest", await pg.evaluate(() => /used of/.test(document.body.textContent || "")));

console.log("… delete");
await pg.evaluate(() => { const t = [...document.querySelectorAll(".aq-lib-tab")].find(x => /Everything/.test(x.textContent||"")); t?.click(); });
await new Promise(r => setTimeout(r, 500));
await pg.click('.aq-lib-item .aq-lib-act[aria-label="Remove from this device"]', { timeout: 20000 }).catch(e => console.log("  delete click failed:", String(e).slice(0,80)));
await new Promise(r => setTimeout(r, 2000));
const del = await pg.evaluate(async () => {
  const n = document.querySelectorAll(".aq-lib-item").length;
  const db = await new Promise(res => { const r = indexedDB.open("aq-library"); r.onsuccess = () => res(r.result); });
  const count = (s) => new Promise(res => { const r = db.transaction(s).objectStore(s).count(); r.onsuccess = () => res(r.result); });
  return { n, items: await count("items"), blobs: await count("blobs") };
});
check("17 delete removes tile", del.n === 3, `${del.n} tiles`);
check("18 delete removes BYTES too (no orphan)", del.items === 3 && del.blobs === 3, `items=${del.items} blobs=${del.blobs}`);

await pg.context().setOffline(false).catch(() => {});
console.log("\nPASS " + pass.length + " / " + (pass.length + fail.length));
for (const f of fail) console.log("  FAIL:", f);
console.log("console errors:", errs.length ? errs.slice(0, 4) : "none");
await pg.close(); process.exit(fail.length ? 1 : 0);
