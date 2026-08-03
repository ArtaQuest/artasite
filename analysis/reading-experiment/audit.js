/* ArtaContrast — live-DOM contrast audit (the dev tool).
 *
 * Read-only. Walks the REAL rendered page, and for every text/stroke element reads its computed
 * (size, weight, colour) and its PARENT-RESOLVED background, then computes the ACHIEVED APCA Lc against
 * that real background and the REQUIRED Lc for the element's size (APCA fontMatrixAscend = lcFloor).
 * Flags elements below the floor, de-dups by (px, weight, colour, bg), prints a table, and downloads the
 * open-data JSON. No dependencies, no mutation, runs on any page.
 *
 * Use: paste into the DevTools console on any ArtaQuest route (Standard mode), or save as a bookmarklet:
 *   javascript:(function(){var s=document.createElement('script');s.src='…/audit.js';document.body.appendChild(s);})()
 * Returns/echoes window.__aqAudit (the rows) and triggers a JSON download.
 */
(() => {
  // ── APCA (G-4g): sRGB → luminance → signed Lc (matches src/lib/contrast.ts, bit-exact) ──
  const sx = c => Math.pow(c / 255, 2.4);
  const aY = (r, g, b) => 0.2126729 * sx(r) + 0.7151522 * sx(g) + 0.072175 * sx(b);
  const clB = y => (y >= 0.022 ? y : y + Math.pow(0.022 - y, 1.414));
  function lc(txt, bg) {
    const Yt = clB(aY(...txt)), Yb = clB(aY(...bg));
    if (Math.abs(Yb - Yt) < 5e-4) return 0;
    let S, o;
    if (Yb > Yt) { S = (Math.pow(Yb, 0.56) - Math.pow(Yt, 0.57)) * 1.14; o = S < 0.1 ? 0 : S - 0.027; }
    else { S = (Math.pow(Yb, 0.65) - Math.pow(Yt, 0.62)) * 1.14; o = S > -0.1 ? 0 : S + 0.027; }
    return o * 100;
  }
  // ── APCA font matrix → required Lc for (px, weight) (the engine's lcFloor) ──
  const FONT = { 30:{300:120,400:108,500:108,700:72}, 45:{300:72,400:42,500:32,700:24},
    60:{300:42,400:24,500:21,700:16}, 75:{300:24,400:18,500:16,700:14},
    90:{300:21,400:16,500:15.5,700:14}, 100:{300:18.5,400:15,500:14.5,700:13} };
  const LCROWS = [30,45,60,75,90,100], WEIGHTS = [300,400,500,700];
  function lcFloor(px, weight) {
    const w = WEIGHTS.reduce((a,b)=>Math.abs(b-weight)<Math.abs(a-weight)?b:a);
    for (const r of LCROWS) if (px >= FONT[r][w]) return r;
    return 100;
  }
  // APCA's matrix floor is the LONG-FORM BODY minimum (Lc 100 for ≤14px) — too strict for UI spot-text,
  // so it would flag almost every caption. We grade by role/size into a realistic COMFORT target, and
  // call something a real problem only below a hard readability floor.
  const READ_FLOOR = 45;                                    // below this = genuinely hard to read
  const band = (px, kind) => kind === 'border' ? 'border' : px >= 24 ? 'display' : px >= 16 ? 'body' : px >= 12 ? 'ui' : 'micro';
  // Comfort mirrors the model + the engine's token contracts (contrast.ts TIER_FLOOR): content-scale
  // text (>=16px) is graded by APCA's own size×weight matrix (lcFloor — weight matters: 16px/400 → 75,
  // 18px/700 → 60, 24px+ → 45); below 16px the matrix assumes body-length prose and over-demands, so
  // the fluent-tier floor (Lc 60, the ink-2 contract) applies — micro is never graded BELOW fluent.
  const comfortOf = (px, weight, kind) => kind === 'border' ? 30 : px >= 16 ? Math.min(lcFloor(px, weight), 75) : 60; // matrix capped at the reading plateau (>=90 is APCA's *preferred* level — the Crisp/Max steps serve it)
  const px = s => parseFloat(s) || 0;
  const parseRGB = s => { const m = (s||'').match(/rgba?\(([^)]+)\)/i); if (!m) return null;
    const p = m[1].split(',').map(x => parseFloat(x)); return { rgb: [p[0]|0,p[1]|0,p[2]|0], a: p[3]===undefined?1:p[3] }; };
  const hex = ([r,g,b]) => '#'+[r,g,b].map(v=>(v|0).toString(16).padStart(2,'0')).join('');
  // resolve the background an element actually sits on (walk ancestors past transparent)
  function resolveBg(el) {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parseRGB(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.05) return c.rgb;
      n = n.parentElement;
    }
    const b = parseRGB(getComputedStyle(document.body).backgroundColor);
    return b ? b.rgb : [13,13,15];
  }
  const hasOwnText = el => Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim().length > 1);

  const rows = [], seen = new Set();
  // TEXT
  document.querySelectorAll('body *').forEach(el => {
    if (!hasOwnText(el)) return;
    // The ArtaQuest logotype is a brand mark (canonical complementary pair), not reading text — the
    // classic contrast-rule exemption. Identified by the lockup's own aria-label.
    if (el.closest('[aria-label="ArtaQuest"]')) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return;
    const fg = parseRGB(cs.color); if (!fg) return;
    const bg = resolveBg(el), size = px(cs.fontSize), weight = parseInt(cs.fontWeight) || 400;
    const key = `${size}|${weight}|${hex(fg.rgb)}|${hex(bg)}`; if (seen.has(key)) return; seen.add(key);
    const achieved = Math.abs(lc(fg.rgb, bg)), b = band(size, 'text'), comfort = comfortOf(size, weight, 'text');
    const severity = achieved < READ_FLOOR ? 'CRIT' : achieved < comfort - 0.5 ? 'WARN' : 'OK';
    rows.push({ kind:'text', px:size, weight, band:b, color:hex(fg.rgb), bg:hex(bg),
      achievedLc:+achieved.toFixed(1), comfortLc:comfort, apcaFloor:lcFloor(size, weight), severity,
      sample: (el.textContent||'').trim().slice(0,32) });
  });
  // STROKES (borders)
  document.querySelectorAll('body *').forEach(el => {
    const cs = getComputedStyle(el); const bw = px(cs.borderTopWidth);
    if (bw <= 0 || cs.borderTopStyle === 'none') return;
    const bc = parseRGB(cs.borderTopColor); if (!bc || bc.a < 0.05) return;
    const bg = resolveBg(el.parentElement || el);
    const key = `border|${bw}|${hex(bc.rgb)}|${hex(bg)}`; if (seen.has(key)) return; seen.add(key);
    const achieved = Math.abs(lc(bc.rgb, bg));               // borders are decorative non-text → never CRIT
    const severity = achieved < comfortOf(0, 0, 'border') - 0.5 ? 'WARN' : 'OK';
    rows.push({ kind:'border', px:bw, weight:0, band:'border', color:hex(bc.rgb), bg:hex(bg),
      achievedLc:+achieved.toFixed(1), comfortLc:comfortOf(0, 0, 'border'), apcaFloor:30, severity, sample:'' });
  });

  const rank = { CRIT:0, WARN:1, OK:2 };
  rows.sort((a,b)=> (rank[a.severity]-rank[b.severity]) || (a.achievedLc-b.achievedLc));
  const crit = rows.filter(r => r.severity==='CRIT'), warn = rows.filter(r => r.severity==='WARN');
  const out = { tool:'artacontrast-audit', url: location.href, theme: document.documentElement.getAttribute('data-theme'),
    contrast: document.documentElement.getAttribute('data-contrast'), dpr: window.devicePixelRatio||1,
    ts: new Date().toISOString(), summary:{ samples: rows.length, critical: crit.length, warn: warn.length }, rows };
  window.__aqAudit = out;
  console.log(`%cArtaContrast audit · ${location.pathname} · ${rows.length} samples · ${crit.length} CRITICAL · ${warn.length} below comfort`, 'font-weight:bold');
  console.table(rows.map(r => ({ sev:r.severity, kind:r.kind, px:r.px, w:r.weight, band:r.band, color:r.color, bg:r.bg, lc:r.achievedLc, comfort:r.comfortLc })));
  try {
    const b = new Blob([JSON.stringify(out, null, 1)], { type:'application/json' }), a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = `aqaudit_${location.pathname.replace(/\W+/g,'_')}_${Date.now()}.json`;
    a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
  } catch (e) { console.warn('download blocked; read window.__aqAudit', e); }
  return out;
})();
