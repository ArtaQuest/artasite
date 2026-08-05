/* GENERATED — DO NOT EDIT HERE.
 * Vendored from artalife tools/arta-audit.mjs @ e37c551.
 * Source of truth: https://github.com/ArtaQuest/artalife.git
 * Re-run: node tools/arta-sync.mjs
 */
/**
 * ArtaAudit — the mascot's motion invariants, measured in a real browser.
 *
 * ARTA.md states the laws; this proves them. Everything here was written to
 * catch a bug that had already shipped past a careful reading of the code, so
 * treat a failure as real until the PROBE is disproved — three of the probes in
 * this file were themselves wrong at least once.
 *
 *   node tools/arta-audit.mjs [url]
 *
 * Needs the persistent dev Chrome on :9222 (AQ_CDP to override) and a page
 * containing an <Arta>. Defaults to the local dev landing page.
 *
 * TAB CONDUCT — this is a user directive, not a preference. It reuses ONE tab,
 * marked with #aq-audit, and leaves it open between runs. It never calls
 * Target.activateTarget and never closes the tab, because both yank the user
 * into the testing window while they are working.
 *
 * Measured 2026-07-31, correcting a wrong belief that caused exactly that: a tab
 * created with Target.createTarget and NEVER activated reports
 * visibilityState "visible" and runs requestAnimationFrame at a full 60 fps.
 * Background throttling is not a problem here and activateTarget buys nothing.
 *
 * Checks, all against ARTA.md:
 *   cost      §10  frames + attribute writes on screen / off screen / hidden
 *   reduced   §9   zero frames, still drawn, still able to aim
 *   speed     §3   peak per-frame movement of any joint, in CSS px
 *   calm      §13  steady-state act changes and head oscillation
 *   head      §3   head direction reversals under four pointer conditions
 *
 * Exit code is the number of failed checks, so CI can gate on it.
 */
import { writeFileSync } from "node:fs";

const HOST = process.env.AQ_CDP || "http://127.0.0.1:9222";
const URL_ = process.argv[2] || "http://localhost:5174/";
const OUT = process.env.AQ_AUDIT_OUT || "";
// Viewport is parameterised so the same invariants can be asserted on a phone,
// where the stage is narrow and the pointer is coarse.
const VW = +(process.env.AQ_W || 1280), VH = +(process.env.AQ_H || 900);
const MOBILE = VW < 500;

// ── thresholds. These ARE the acceptance criteria in ARTA.md. ───────────────
const LIMIT = {
  // The rig's OWN measurement is authoritative and strict (SAFE.MAX_PX_PER_FRAME
  // = 12, asserted via the data-overspeed flag below). This external number is
  // sampled from a separate rAF, so whenever the two callbacks swap order it
  // sees two sim frames as one and reports up to double. Hence the tolerance:
  // it is a sampling bound, not the invariant.
  peakPxPerFrameSampled: 15.6,
  idleActChangesPer5s: 1,  // §13 a settled Arta re-entering an act is a shake
  idleHeadHz: 0.8,         // §13 the breath is 0.42 Hz; twice that is a wobble
  // A shake measured 8.6 reversals/s. Healthy measures 0.4-2.3, because the
  // breath, the weight shift and the tilt drift are three independent slow
  // oscillations whose reversals add up — roughly 2/s of legitimate motion
  // before the pointer is involved at all. 3.5 sits cleanly between the two and
  // still catches a shake by a factor of two.
  headReversalsPerSec: 3.5,
  offscreenRafPerSec: 1,
};

const { webSocketDebuggerUrl } = await (await fetch(HOST + "/json/version")).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pend = new Map(), waits = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const { res } = pend.get(m.id); pend.delete(m.id);
    res(m.error ? { __e: m.error.message } : m.result); }
  else if (m.method) for (let i = waits.length - 1; i >= 0; i--)
    if (waits[i].m === m.method) waits.splice(i, 1)[0].res(m.params);
};
// Resolve rather than reject: closing a tab rejects whatever was in flight for
// it, and one unawaited rejection takes the whole process down mid-audit.
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const id = ++seq; pend.set(id, { res });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const once = (m, ms = 25000) => new Promise((res) => {
  waits.push({ m, res }); setTimeout(() => res({ __timeout: m }), ms);
});

const COUNTERS = `
  window.__aq = { raf: 0, attrs: 0 };
  const rAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => { window.__aq.raf++; return rAF(cb); };
  const sa = SVGElement.prototype.setAttribute;
  SVGElement.prototype.setAttribute = function (k, v) {
    if (k === "d" || k === "cx") window.__aq.attrs++;
    return sa.call(this, k, v);
  };
  window.AQ_LOGGED_IN = false;   // the landing page only exists for visitors
`;

const TAB_MARK = "#aq-audit";
let phaseNo = 0;
let auditTarget = null, auditSession = null;

/** The one reusable tab. Found by its marker, created only if absent, never closed. */
async function audiTab() {
  if (auditTarget) return auditTarget;
  const list = await (await fetch(HOST + "/json/list")).json();
  const found = list.find((t) => t.type === "page" && (t.url || "").includes(TAB_MARK));
  auditTarget = found ? found.id
    : (await send("Target.createTarget", { url: "about:blank" })).targetId;
  auditSession = (await send("Target.attachToTarget",
    { targetId: auditTarget, flatten: true })).sessionId;
  return auditTarget;
}

async function tab(media, fn) {
  await audiTab();
  const S = auditSession;
  const ev = async (x) => {
    // Never wait for ever: a hung in-page promise must surface as a failure, not
    // as a run that simply never ends.
    const r = await Promise.race([
      send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }, S),
      new Promise((res) => setTimeout(() => res({ __e: "evaluate timed out after 90s" }), 90000)),
    ]);
    if (r.__e) return null;
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  };
  const api = { ev, wait: (ms) => ev(`new Promise(r=>setTimeout(()=>r(1),${ms}))`),
    reset: () => ev(`window.__aq={raf:0,attrs:0},1`),
    read: () => ev(`JSON.stringify(window.__aq)`).then(JSON.parse) };
  try {
    await send("Page.enable", {}, S);
    // Keep the renderer running WITHOUT stealing focus. The probes below await
    // requestAnimationFrame, and a genuinely backgrounded tab throttles it to a
    // stop — the evaluate then never resolves and the audit hangs for ever.
    // setWebLifecycleState('active') tells Chrome to treat the page as active;
    // Target.activateTarget would also work and is BANNED, because it yanks the
    // user into the testing window (see feedback_persistent_chrome_only).
    await send("Page.setWebLifecycleState", { state: "active" }, S);
    // ...and that alone is NOT enough: a background tab still throttles rAF to a
    // stop, and the evaluate below times out. Screencasting forces the
    // compositor to keep producing frames, which keeps rAF alive — the only
    // lever that works here without focusing the window.
    await send("Page.startScreencast", { format: "jpeg", quality: 5, everyNthFrame: 4 }, S);
    await send("Emulation.setDeviceMetricsOverride",
      { width: VW, height: VH, deviceScaleFactor: MOBILE ? 3 : 1, mobile: MOBILE }, S);
    // The tab is reused, so a previous run's prefers-reduced-motion leaks
    // forward — and it does NOT clear from `{features: []}` alone, which made a
    // whole mobile run measure a reduced-motion Arta and report a green 13/13
    // built entirely from zeros. Set it explicitly, then ASSERT it took.
    await send("Emulation.setEmulatedMedia", { media: "", features: media }, S);
    // The site registers a service worker. A stale one from an earlier build
    // intercepts and serves its offline fallback — "Something interrupted
    // loading this page" — and the audit then measures a cached shell with no
    // Arta in it and reports a page that is perfectly healthy as broken.
    const origin = new URL(URL_).origin;
    await send("Storage.clearDataForOrigin",
      { origin, storageTypes: "service_workers,cache_storage,appcache" }, S);
    await send("Network.enable", {}, S);
    await send("Network.setCacheDisabled", { cacheDisabled: true }, S);
    await send("Page.addScriptToEvaluateOnNewDocument", { source: COUNTERS }, S);
    // A UNIQUE url per phase. Navigating a reused tab to the identical URL is a
    // same-document fragment change: no reload, no remount, and the phase
    // inherits the previous one's component state — which is how a phase ended
    // up running against a Brain still stuck in the previous phase's gesture,
    // with its loop never started. The SPA ignores the extra query key.
    const sep = URL_.includes("?") ? "&" : "?";
    await send("Page.navigate",
      { url: `${URL_}${sep}aqa=${++phaseNo}${TAB_MARK}` }, S);
    await once("Page.loadEventFired", 20000);
    // POLL for the mascot, do not sleep at it. A fixed wait is fine against a
    // local dev server and far too short against production, where the route's
    // lazy chunk still has to cross the network — the audit then reports a
    // perfectly healthy site as having no Arta on it.
    await ev(`(async () => { for (let i = 0; i < 120; i++) {
      if (document.readyState === "complete" && document.querySelector("[data-arta]")) return 1;
      await new Promise(r => setTimeout(r, 150));
    } return 0; })()`);
    // A REUSED tab keeps its scroll position across navigations. The off-screen
    // phase scrolls to 6000, and on a tall page the next phase then loads with
    // Arta still out of view — every subsequent probe reads zero and the suite
    // reports a green 13/13 while measuring nothing at all. Reset it, hard.
    await ev(`history.scrollRestoration = 'manual';
      document.scrollingElement.scrollTop = 0;
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        if (/(auto|scroll)/.test(cs.overflowY)) el.scrollTop = 0;
      } 1`);
    await api.wait(300);
    const wantReduced = media.some((f) => f.name === "prefers-reduced-motion");
    const isReduced = await ev(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
    if (isReduced !== wantReduced)
      throw new Error(`media emulation did not take: reduced=${isReduced}, wanted ${wantReduced}`);
    if (!(await ev(`!!document.querySelector('[data-arta]')`)))
      throw new Error(`no <Arta> on ${URL_}`);
    const seen = await ev(`(() => { const r = document.querySelector('[data-arta]')
      .getBoundingClientRect();
      return r.width > 0 && r.bottom > 0 && r.top < innerHeight; })()`);
    if (!seen) throw new Error("Arta is not in view — every probe would read zero");
    return await fn(api);
  } finally {
    // Deliberately NOT closed. Tab churn in the user's own Chrome is disruptive,
    // and the marked tab is what the next run reuses.
    await send("Page.stopScreencast", {}, S);
  }
}

const per = (c, ms) => ({ raf: +(c.raf / (ms / 1000)).toFixed(1),
                          attrs: +(c.attrs / (ms / 1000)).toFixed(1) });
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); };

// ── normal ──────────────────────────────────────────────────────────────────
const normal = await tab([], async (a) => {
  const r = {};
  await a.reset(); await a.wait(2500);
  r.onScreen = per(await a.read(), 2500);

  // The SPA scrolls an inner container; window.scrollTo is a no-op here, and the
  // rect must be re-read AFTER any smooth-scroll finishes or it reports the old
  // position and the whole check silently measures the wrong thing.
  const scrollAll = (y) => a.ev(`(() => {
    document.scrollingElement.scrollTop = ${y};
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 40) el.scrollTop = ${y};
    } return 1; })()`);
  await scrollAll(6000); await a.wait(1000);
  r.rect = await a.ev(`(() => { const h=document.querySelector('[data-arta]');
    const b=h.getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), vh: innerHeight,
             fixed: getComputedStyle(h).position === 'fixed' }; })()`);
  r.reallyOffscreen = r.rect.bottom < -80 || r.rect.top > r.rect.vh + 80;
  await a.reset(); await a.wait(1800);
  r.offScreen = per(await a.read(), 1800);
  await scrollAll(0); await a.wait(900);

  await a.ev(`Object.defineProperty(document,'hidden',{get:()=>true,configurable:true});
              Object.defineProperty(document,'visibilityState',{get:()=>'hidden',configurable:true});
              document.dispatchEvent(new Event('visibilitychange')),1`);
  await a.wait(500); await a.reset(); await a.wait(1500);
  r.hidden = per(await a.read(), 1500);
  return r;
});

check("cost · runs on screen", normal.onScreen.raf > 30,
  `${normal.onScreen.raf} rAF/s, ${normal.onScreen.attrs} attr/s`);
// Three outcomes, not two. A fixed companion layer genuinely cannot leave the
// viewport, so this law does not apply to it and the tab-hidden check below is
// what covers the cost concern — say so, and count it as skipped rather than
// passed. But a host that CAN scroll and did not is a broken probe, and a broken
// probe reporting PASS is exactly the hollow green this suite exists to catch.
if (normal.rect.fixed && !normal.reallyOffscreen) {
  results.push({ name: "cost · stops off screen", ok: true, skipped: true,
    detail: "N/A — fixed companion layer never leaves the viewport; 'stops when tab hidden' covers this" });
} else if (!normal.reallyOffscreen) {
  check("cost · stops off screen", false,
    `PROBE FAILED — host is scrollable but stayed on screen (top ${normal.rect.top}, vh ${normal.rect.vh})`);
} else {
  check("cost · stops off screen", normal.offScreen.raf <= LIMIT.offscreenRafPerSec,
    `${normal.offScreen.raf} rAF/s`);
}
check("cost · stops when tab hidden", normal.hidden.raf === 0, `${normal.hidden.raf} rAF/s`);

// ── steady state: the shake check ───────────────────────────────────────────
const calm = await tab([], async (a) => a.ev(`(async () => {
  const host = document.querySelector('[data-arta]');
  const c = host.querySelector('g[stroke-width="7"] circle');
  const hb = host.getBoundingClientRect();
  const put = (x, y) => window.dispatchEvent(new PointerEvent('pointermove',
    { clientX: x, clientY: y, bubbles: true }));
  put(hb.left + 40, hb.top + 60);
  // let arrival gestures finish — folding a legitimate transient into a min/max
  // makes a perfectly calm figure look broken
  const s0 = performance.now();
  while (performance.now() - s0 < 4500) { await new Promise(r => requestAnimationFrame(r)); put(hb.left+40, hb.top+60); }
  let changes = 0, last = host.getAttribute('data-act');
  const mo = new MutationObserver(() => { const v = host.getAttribute('data-act');
    if (v !== last) { changes++; last = v; } });
  mo.observe(host, { attributes: true, attributeFilter: ['data-act'] });
  const ys = []; const t0 = performance.now();
  while (performance.now() - t0 < 5000) {
    await new Promise(r => requestAnimationFrame(r)); put(hb.left+40, hb.top+60);
    ys.push(+c.getAttribute('cy'));
  }
  mo.disconnect();
  const mean = ys.reduce((s,v)=>s+v,0)/ys.length;
  let cross = 0; for (let i=1;i<ys.length;i++) if ((ys[i-1]-mean)*(ys[i]-mean)<0) cross++;
  return { act: host.getAttribute('data-act'), changes, hz: +(cross/2/5).toFixed(2),
           overspeed: host.getAttribute('data-overspeed') };
})()`));

if (!calm) { check("calm · probe completed", false, "the calm probe timed out — frames are not being produced"); }
check("calm · settles into an act", !!calm && calm.changes <= LIMIT.idleActChangesPer5s,
  calm ? `act=${calm.act}, ${calm.changes} changes in 5s` : "no data");
check("calm · head oscillates at breath rate only", !!calm && calm.hz <= LIMIT.idleHeadHz,
  calm ? `${calm.hz} Hz (breath is 0.42)` : "no data");

// ── head, under four pointer conditions ─────────────────────────────────────
const head = await tab([], async (a) => a.ev(`(async () => {
  const host = document.querySelector('[data-arta]');
  const svg = host.querySelector('svg');
  const c = host.querySelector('g[stroke-width="7"] circle');
  const hb = host.getBoundingClientRect();
  const px = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
  const put = (x, y) => window.dispatchEvent(new PointerEvent('pointermove',
    { clientX: x, clientY: y, bubbles: true }));
  await new Promise(r => setTimeout(r, 3500));
  const run = async (label, move, ms) => {
    const xs = [], ys = []; const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      await new Promise(r => requestAnimationFrame(r));
      move(performance.now() - t0);
      xs.push(+c.getAttribute('cx')); ys.push(+c.getAttribute('cy'));
    }
    const rev = (arr) => { let n = 0, prev = 0;
      for (let i = 1; i < arr.length; i++) { const d = arr[i]-arr[i-1];
        if (Math.abs(d) < 0.05) continue;                 // rounding, not motion
        if (prev && Math.sign(d) !== Math.sign(prev)) n++;
        prev = d; }
      return +(n/(ms/1000)).toFixed(1); };
    const span = (a) => (Math.max(...a) - Math.min(...a)) * px;
    return { label, x: rev(xs), y: rev(ys), swing: +span(xs).toFixed(1) };
  };
  return [
    await run('still', () => put(hb.left+40, hb.top+60), 4000),
    await run('sweeping', (t) => { const u=(Math.sin(t/1400)+1)/2;
      put(60+u*(innerWidth-120), 300); }, 4000),
    // what a real hand does: slow drift with a few px of tremor on top. This is
    // the condition that decides whether the head reads as calm in ordinary use.
    await run('realistic hand', (t) => {
      const drift = hb.left + hb.width*0.35 + Math.sin(t/2600)*120;
      put(drift + Math.sin(t/20)*2.2 + Math.sin(t/7)*0.9, 300 + Math.sin(t/23)*1.8); }, 4000),
    // deliberately shaking the mouse: reported, NOT asserted. Following a 2.6 Hz
    // input is correct behaviour, not a defect.
    await run('mouse shaken (reported only)', (t) =>
      put(hb.left+hb.width*0.5 + Math.sin(t/60)*30, hb.top+80), 4000),
  ];
})()`));

// The sweep swings the pointer the full width of the window, so the head MUST
// move. If it did not, the probe is broken and every other head number is void.
const sweep = head[1];
check("head · probe actually saw motion", sweep.swing > 1,
  `${sweep.swing} px of head travel while the pointer crossed the window`);
for (const h of head.slice(0, 3)) {
  check(`head · ${h.label}`, Math.max(h.x, h.y) <= LIMIT.headReversalsPerSec,
    `${h.x}/${h.y} reversals/s`);
}
const shaken = head[3];

// ── speed ceiling under stress ──────────────────────────────────────────────
const speed = await tab([], async (a) => a.ev(`(async () => {
  const host = document.querySelector('[data-arta]');
  const svg = host.querySelector('svg');
  const g = host.querySelector('g[stroke-width="7"]');
  const px = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
  const read = () => { const out = [];
    const c = g.querySelector('circle'); out.push(+c.getAttribute('cx'), +c.getAttribute('cy'));
    for (const p of g.querySelectorAll('path'))
      for (const v of (p.getAttribute('d')||'').match(/-?\\d+(?:\\.\\d+)?/g) || []) out.push(+v);
    return out; };
  let prev = read(), peak = 0, stop = false;
  const tick = () => { if (stop) return; requestAnimationFrame(tick);
    const cur = read();
    if (cur.length === prev.length)
      for (let i = 0; i + 1 < cur.length; i += 2)
        peak = Math.max(peak, Math.hypot(cur[i]-prev[i], cur[i+1]-prev[i+1]) * px);
    prev = cur; };
  requestAnimationFrame(tick);
  const fire = (re) => { const b = [...document.querySelectorAll('button')]
    .find(x => re.test(x.textContent||'')); if (b) b.click(); };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let round = 0; round < 3; round++)
    for (const re of [/^Leap/, /^Aim/, /^Shrug/, /^Read/, /^Think/, /^Wave/]) {
      fire(re);
      for (let i = 0; i < 5; i++) {
        window.dispatchEvent(new PointerEvent('pointermove',
          { clientX: i % 2 ? 60 : innerWidth - 60, clientY: 500, bubbles: true }));
        await sleep(90);
      }
    }
  stop = true;
  return { peak: +peak.toFixed(2), overspeed: host.getAttribute('data-overspeed') };
})()`));

check("speed · probe actually saw motion", speed.peak > 0.2,
  `${speed.peak} px — zero here means the probe measured nothing, not that Arta is calm`);
check("speed · peak per-frame movement (sampled)",
  speed.peak > 0.2 && speed.peak <= LIMIT.peakPxPerFrameSampled,
  `${speed.peak} px (sampling bound ${LIMIT.peakPxPerFrameSampled}; the rig's own limit is 12)`);
check("speed · overspeed flag never raised", !speed.overspeed,
  speed.overspeed ? `raised at ${speed.overspeed} px` : "clean");

// ── reduced motion ──────────────────────────────────────────────────────────
const reduced = await tab([{ name: "prefers-reduced-motion", value: "reduce" }], async (a) => {
  await a.reset(); await a.wait(2200);
  const cost = per(await a.read(), 2200);
  const limbs = await a.ev(`[...document.querySelectorAll('[data-arta] svg g[stroke-width="7"] path')]
    .filter(p => (p.getAttribute('d')||'').length > 4).length`);
  const fired = await a.ev(`(() => { const b = [...document.querySelectorAll('button')]
    .find(x => /^Aim/.test(x.textContent||'')); if (!b) return false; b.click(); return true; })()`);
  await a.wait(500);
  // Ask for the arrow BY NAME. This was `svg > path` — "the first bare path is
  // the arrow" — which was true until the rope was added as an earlier sibling,
  // and then the check read the rope's permanent opacity 0 and called a working
  // arrow broken. A positional selector is a claim about a layout that nobody
  // promised to keep. `marker` proves we found the element we meant, so this
  // cannot quietly go back to measuring the wrong thing.
  //
  // Visible means three things, and opacity is only one of them. An arrow can
  // be fully opaque, correctly drawn, and outside the viewBox — which is what a
  // target below the fold produced. Assert it lands ON the stage.
  const arrowEl = await a.ev(`(() => {
    const p = document.querySelector('[data-arta] [data-arta-arrow]');
    if (!p) return { marker: false };
    const vb = p.ownerSVGElement.viewBox.baseVal, b = p.getBBox();
    return { marker: true, opacity: +(p.getAttribute('opacity') || 0),
             drawn: (p.getAttribute('d') || '').length > 4,
             onStage: b.width + b.height > 0 && b.x < vb.x + vb.width && b.x + b.width > vb.x
                      && b.y < vb.y + vb.height && b.y + b.height > vb.y,
             box: [b.x, b.y, b.width, b.height].map(Math.round).join(","),
             stage: [vb.width, vb.height].map(Math.round).join("x") };
  })()`);
  return { cost, limbs, fired, arrowEl, raf: (await a.read()).raf };
});

check("reduced · schedules no frames", reduced.cost.raf === 0, `${reduced.cost.raf} rAF/s`);
check("reduced · Arta is still drawn", reduced.limbs === 5, `${reduced.limbs}/5 limbs`);
// Do not let a missing control pass as a working one. The landing page has no
// Aim button, so `!fired || arrow > 0` passed vacuously while testing nothing —
// the same hollow green this suite already exists to catch.
if (!reduced.fired) {
  results.push({ name: "reduced · can still aim", ok: true, skipped: true,
    detail: "SKIPPED — no Aim control on this page; run against /arta to test it" });
} else if (!reduced.arrowEl.marker) {
  check("reduced · can still aim", false, "no [data-arta-arrow] element — the renderer changed shape");
} else {
  const ar = reduced.arrowEl;
  check("reduced · can still aim", ar.opacity > 0 && ar.drawn && ar.onStage,
    `opacity ${ar.opacity}, path ${ar.drawn ? "drawn" : "EMPTY"}, ` +
    `${ar.onStage ? "on stage" : `OFF STAGE box ${ar.box} vs ${ar.stage}`}`);
}

ws.close();

// ── report ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped);
const pad = Math.max(...results.map((r) => r.name.length));
console.log(`\nArtaAudit — ${URL_}  @ ${VW}x${VH}${MOBILE ? " (mobile, dpr3)" : ""}\n`);
for (const r of results)
  console.log(`  ${!r.ok ? "FAIL" : r.skipped ? "SKIP" : "PASS"}  ${r.name.padEnd(pad)}  ${r.detail}`);
console.log(`\n  (reported, not asserted) head · ${shaken.label}: ${shaken.x}/${shaken.y} reversals/s`);
// A skip is not a pass. Rolling them together is how "15/15" came to describe
// a run in which two of the fifteen measured nothing.
const asserted = results.length - skipped.length;
console.log(`\n  ${asserted - failed.length}/${asserted} asserted checks passed` +
  (skipped.length ? `, ${skipped.length} skipped (${skipped.map((r) => r.name).join("; ")})` : "") + `\n`);
if (OUT) writeFileSync(OUT, JSON.stringify({ url: URL_, results, shaken, speed, calm }, null, 1));
process.exit(failed.length);
