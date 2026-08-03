// Automated, dependency-free measurement + model fit on THIS device (no user, no camera).
// Geometric anti-aliasing is area coverage, so we rasterise strokes exactly in pure JS (browser-style
// sRGB-space AA blend), measure the EFFECTIVE APCA Lc of an object of a given stroke width at each DPR,
// and emit the size/DPR-aware ArtaContrast token colours: fg* = colour whose effective Lc = rho*R(tier).
//   node measure.mjs
const sx = c => Math.pow(c / 255, 2.4);
const apcaY = ([r, g, b]) => 0.2126729 * sx(r) + 0.7151522 * sx(g) + 0.072175 * sx(b);
const cl = y => (y >= 0.022 ? y : y + Math.pow(0.022 - y, 1.414));
function lcY(Yt, Yb) { Yt = cl(Yt); Yb = cl(Yb); if (Math.abs(Yb - Yt) < 5e-4) return 0; let S, o;
  if (Yb > Yt) { S = (Math.pow(Yb, 0.56) - Math.pow(Yt, 0.57)) * 1.14; o = S < 0.1 ? 0 : S - 0.027; }
  else { S = (Math.pow(Yb, 0.65) - Math.pow(Yt, 0.62)) * 1.14; o = S > -0.1 ? 0 : S + 0.027; } return Math.abs(o * 100); }
const gY = v => apcaY([v, v, v]);
const hex = v => '#' + [v, v, v].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');

// EFFECTIVE Lc of a stroke of CSS width wCss rendered at devicePixelRatio dpr, fg/bg grey (sRGB 0–255).
// Area-coverage AA, blended in sRGB space (as browsers do for text), averaged over sub-pixel offsets.
function effLc(wCss, dpr, fg, bg) {
  const wDev = wCss * dpr, Ybg = gY(bg), Yfg = gY(fg), span = Math.max(1e-6, Math.abs(Yfg - Ybg));
  let accCov = 0, accCovY = 0; const OFF = 12;
  for (let o = 0; o < OFF; o++) {
    const off = o / OFF;
    for (let p = Math.floor(off) - 1; p < Math.ceil(off + wDev) + 1; p++) {
      const cov = Math.max(0, Math.min(p + 1, off + wDev) - Math.max(p, off)); // overlap ∈ [0,1]
      if (cov <= 1e-4) continue;
      const px = cov * fg + (1 - cov) * bg;            // browser-style gamma-space AA blend
      const Ypx = gY(px); const c = Math.min(1, Math.abs(Ypx - Ybg) / span);
      accCov += c; accCovY += c * Ypx;
    }
  }
  const effY = accCov > 0 ? accCovY / accCov : Yfg;
  return lcY(effY, Ybg);
}
// solve the grey fg (on the higher-contrast side of bg) whose EFFECTIVE Lc = target, at (wCss,dpr).
function solveFg(bg, target, wCss, dpr) {
  const dark = gY(bg) < 0.18; let best = dark ? 255 : 0, bestErr = 1e9, lo = dark ? bg : 0, hi = dark ? 255 : bg;
  for (let v = lo; dark ? v <= hi : v <= hi; v++) { const e = Math.abs(effLc(wCss, dpr, v, bg) - target);
    if (e < bestErr) { bestErr = e; best = v; } }
  return best;
}

// stroke width (CSS px) of an object: text → stem ≈ fontPx·stemFactor(weight); line/border → its thickness.
const stem = (px, w) => px * (0.058 + 0.05 * (w - 400) / 300);

// tiers: target PERCEIVED Lc R (APCA-informed) × role ρ × the object's stroke width.
const TIERS = [
  { name: 'ink (16px body, 400)',      R: 80, rho: 1.0, w: stem(16, 400) },
  { name: 'ink-2 (14px secondary)',    R: 68, rho: 1.0, w: stem(14, 400) },
  { name: 'ink-3 (13px muted)',        R: 58, rho: 1.0, w: stem(13, 400) },
  { name: 'caption (11px, 400)',       R: 55, rho: 1.0, w: stem(11, 400) },
  { name: 'heading (24px, 700)',       R: 62, rho: 1.0, w: stem(24, 700) },
  { name: 'line/border (1px)',         R: 30, rho: 1.0, w: 1.0 },
  { name: 'hairline (0.5px)',          R: 30, rho: 1.0, w: 0.5 },
];
const SURFACES = { 'dark #161619': 22, 'light #ffffff': 255 };
const DPRS = [1, 2, 3];
const C = 92, FLOOR = 30;

console.log('=== measured AA erosion (designed→effective Lc) for a thin stroke, by DPR (dark #161619) ===');
for (const w of [0.5, 1, 2, 3]) console.log('  w=' + w + 'px  ' + DPRS.map(d => {
  const fg = 230; return `DPR${d}: ${(lcY(gY(fg), gY(22)) - effLc(w, d, fg, 22)).toFixed(1)}`; }).join('  ') + '   (Lc lost to AA)');

console.log('\n=== size/DPR-aware token colours: fg* whose EFFECTIVE Lc = ρ·R(tier) ===');
const out = {};
for (const [sname, bg] of Object.entries(SURFACES)) {
  console.log('\n— ' + sname + ' —');
  for (const t of TIERS) {
    const target = Math.max(FLOOR, Math.min(C, t.rho * t.R));
    const row = DPRS.map(d => { const fg = solveFg(bg, target, t.w, d); out[`${sname}|${t.name}|DPR${d}`] = hex(fg);
      return `DPR${d} ${hex(fg)} (eff ${effLc(t.w, d, fg, bg).toFixed(0)})`; });
    console.log('  ' + t.name.padEnd(26) + ' R=' + target + '  ' + row.join('  '));
  }
}
console.log('\nNote: thin/small tiers need a MORE extreme colour at DPR1 (AA erodes more) than at DPR2/3 — that gap is the size/DPR-aware correction the static ramp lacks.');

// persist the offline-generated size/DPR-aware tokens for wiring into ArtaContrast
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./tokens.generated.json', import.meta.url),
  JSON.stringify({ generated: 'measure.mjs (area-coverage AA, sRGB-space blend)', model: 'fg* : effective APCA Lc = rho*R(tier)',
    comfortC: C, floor: FLOOR, tiers: TIERS, surfaces: SURFACES, dprs: DPRS, tokens: out }, null, 1));
console.log('\nwrote tokens.generated.json');
