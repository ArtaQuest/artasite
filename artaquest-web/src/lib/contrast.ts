/**
 * ArtaContrast v3 — the Density Law engine.
 *
 * ONE law decides every neutral colour on the platform: an object's colour follows from its
 * content's PIXEL DENSITY and its BACKGROUND. Derived from three classroom facts (see the paper
 * "The Density Law: A One-Line Rule for Legible Colour from Pixel Density and Background",
 * Educational Accessibility, analysis/density-law/):
 *
 *   1. Displays mix light additively; a pixel's luminance is Y = (v/255)^2.2, cone-weighted per
 *      channel (blue carries only ~7% of luminance).
 *   2. The eye blurs what it cannot resolve (b ≈ 1 px at normal viewing ≈ 1 arcmin), and blurred
 *      light AVERAGES: a blur patch that is fraction D ink delivers only D of the luminance gap.
 *      D is the pixel density — measured for the platform's typeface (min of the ink side and
 *      the paper-between-strokes side; the DENSITY table below).
 *   3. The retina reports relative differences (Weber), with gain set by the brighter side of
 *      the pattern plus a stray-light veil Y0.
 *
 *          THE LAW:   D · (Ymax − Ymin)  ≥  C · (Ymax + Y0)
 *
 *   Constants fitted against APCA's published size×weight font table (R² = 0.83 over 40
 *   threshold pairs, both polarities; cross-validated across held-out font weights):
 *   C* = 0.2767 (the visibility fluent reading demands), Y0 = 0.63 (effective adaptation
 *   floor: ambient + intraocular scatter + incomplete local adaptation), b = 1.0 px.
 *
 * The law is solved in CLOSED FORM (no iteration, no lookup tables):
 *   darker ink:   Yt = Yb − C(Yb + Y0)/D
 *   lighter ink:  Yt = (D·Yb + C·Y0)/(D − C)        (only exists when D > C)
 *
 * DEPLOYMENT SHAPE (engineering, documented in the paper's §5):
 *   • The 5-stop slider rescales the criterion: C_level = C* · M, where M spans each theme's
 *     physically available band — dark [0.74, 1.00] (top = the halation ceiling: bright ink on
 *     dark scatters in the eye's optics, so ink never exceeds Y ≈ 0.87 ≈ #efefef), light
 *     [0.90, 1.06] (top = the white canvas's deliverable maximum V = D/(1 + Y0)).
 *   • Roles are fractions of the ACHIEVED body visibility (never of the raw demand, so the
 *     text hierarchy survives even where a canvas rails): ink-2 = 0.80, ink-3 = 0.69; hairlines
 *     are decorative (found, not read) and ramp 0.12 → 0.38 across the slider.
 *   • Statutory floors are clamps AFTER the solve, not part of the model: WCAG-AA 4.5:1 for
 *     ink/ink-2, 3:1 for ink-3. The law proposes, the legal minimum disposes.
 *
 * BRAND — gold (#E8B923) and blue (#1746DC = 255 − gold) are exact additive complements: the
 * pair sums to white per channel at every slider stop (muted toward the neutral midpoint 127.5).
 * The law only governs LUMINANCE, so hue stays free: the brand pair and the per-theme legible
 * brand inks below are identity constants the neutral system never touches.
 */

export type Theme = "dark" | "light";
export type RGB = [number, number, number];

// ── The law's constants (fitted; see analysis/density-law/paper) ──
const GAMMA = 2.2;
const C_STAR = 0.2767; // criterion: the visibility fluent reading demands
const Y_VEIL = 0.63; // effective adaptation floor, as a fraction of display white
// blur b = 1.0 px is baked into the measured densities below.

/** Pixel densities of the platform's content classes, measured at b = 1 px for Inter
 *  (min of ink-side and paper-side statistics; analysis/density-law/measure_density.py):
 *  body text 16px/400, small UI text 13px/400, incidental text 12px/400, and the closed-form
 *  1-px hairline erf(1/(2√2·b)). */
export const DENSITY = { ink: 0.4796, ink2: 0.4142, ink3: 0.3918, line: 0.3829 } as const;

// Criterion multiplier bands per theme (level 1 → 5). Ends are derived, not taste:
// dark top 1.00 = the halation ceiling engages exactly there; light top 1.06 ≈ the white
// canvas's deliverable maximum; bottoms sit at the AA-safe comfort floors.
const BAND: Record<Theme, [number, number]> = { dark: [0.74, 1.0], light: [0.9, 1.06] };
const ROLE = { ink2: 0.8, ink3: 0.69 } as const; // fractions of the achieved body visibility
const DARK_INK_CEIL_Y = 0.87; // halation guard: dark-theme ink never brighter than ~#efefef

export const LEVELS = 5;
export const DEFAULT_LEVEL = 3; // Standard = (almost) the fitted criterion itself
export const levelT = (level: number) => (Math.max(1, Math.min(LEVELS, level)) - 1) / (LEVELS - 1);

// ── Display physics (the paper's eq. 1) ──
const ch = (v: number) => Math.pow(v / 255, GAMMA);
/** Relative luminance of an sRGB colour under the engine's display law (γ = 2.2). */
export const lumY = ([r, g, b]: RGB): number => 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
const grayFor = (y: number): RGB => {
  const v = Math.max(0, Math.min(255, Math.round(255 * Math.pow(Math.max(0, Math.min(1, y)), 1 / GAMMA))));
  return [v, v, v];
};

/** The visibility the law assigns to a pattern of density D on a (Yt, Yb) pair. */
export const visibility = (D: number, Yt: number, Yb: number): number =>
  (D * Math.abs(Yt - Yb)) / (Math.max(Yt, Yb) + Y_VEIL);

/**
 * THE SOLVE — the closed-form heart of the engine. Given a background luminance, a content
 * density and a criterion C, return the ink luminance on the preferred side (falling back to
 * the other side, then to the rail with the larger deliverable visibility).
 */
export function solveInkY(Yb: number, D: number, C: number, preferLight: boolean): number {
  const darker = Yb - (C * (Yb + Y_VEIL)) / D; // ≥ 0 when reachable
  const lighter = D > C ? (D * Yb + C * Y_VEIL) / (D - C) : NaN; // ≤ 1 when reachable
  const pick = (light: boolean): number | null =>
    light ? (Number.isFinite(lighter) && lighter <= 1 ? lighter : null) : darker >= 0 ? darker : null;
  const first = pick(preferLight);
  if (first !== null) return first;
  const second = pick(!preferLight);
  if (second !== null) return second;
  // Neither side can carry C — rail on the side that delivers more visibility.
  return visibility(D, 1, Yb) >= visibility(D, 0, Yb) ? 1 : 0;
}

/** WCAG 2.x relative luminance + contrast ratio (the STATUTORY clamp only — the sRGB piecewise
 *  law, distinct from the engine's γ-2.2 display law by design: the statute is the statute). */
const wch = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const wcagY = ([r, g, b]: RGB) => 0.2126 * wch(r) + 0.7152 * wch(g) + 0.0722 * wch(b);
export function wcagRatio(a: RGB, b: RGB): number {
  const [lo, hi] = [wcagY(a), wcagY(b)].sort((x, y) => x - y);
  return (hi + 0.05) / (lo + 0.05);
}
/** Nudge a grey channel-step at a time until it clears `need`:1 against bg (bounded). */
function clampAA(ink: RGB, bg: RGB, need: number, lighten: boolean): RGB {
  let v = ink[0];
  for (let i = 0; i < 255 && wcagRatio([v, v, v], bg) < need; i++) v += lighten ? 1 : -1;
  return [v, v, v];
}

/**
 * The public per-object API — the paper's question verbatim: the colour of an object, given
 * its pixel density and its background. `role` picks the criterion: content is read fluently
 * (full C at the level), decoration only found.
 */
export function inkForDensity(
  bg: RGB,
  D: number,
  opts: { level?: number; role?: "read" | "decor" } = {},
): RGB {
  const theme: Theme = lumY(bg) < 0.25 ? "dark" : "light";
  const [mLo, mHi] = BAND[theme];
  const m = mLo + levelT(opts.level ?? currentLevel()) * (mHi - mLo);
  const t = levelT(opts.level ?? currentLevel());
  const C = C_STAR * m * (opts.role === "decor" ? 0.12 + 0.26 * t : 1);
  let y = solveInkY(lumY(bg), D, C, theme === "dark");
  if (theme === "dark") y = Math.min(y, DARK_INK_CEIL_Y);
  return grayFor(y);
}

// ── Hex helpers ──
export function parseHex(hex: string): RGB | null {
  const v = hex.trim();
  const rgb = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (rgb) return [Math.round(+rgb[1]), Math.round(+rgb[2]), Math.round(+rgb[3])];
  const h = v.replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}
const toHex = ([r, g, b]: RGB) => "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");

/**
 * The COMPLETE token set for (level, theme) on a canvas — the single source of truth shared by
 * the runtime (applyContrast) and the pre-paint CSS ramp generator (tools/gen-contrast-ramp.mjs).
 * Every neutral token is the density law solved for that token's measured density; the roles
 * take their fraction of the ACHIEVED body visibility so the hierarchy is ordered at every stop
 * on every canvas. The line token paints on BOTH surfaces (page + card), so it solves on each
 * and keeps the worst-canvas winner.
 */
export function tokensFor(level: number, theme: Theme, bg: RGB, bgPage: RGB = bg): Record<string, string> {
  const t = levelT(level);
  const dark = theme === "dark";
  const Yb = lumY(bg);
  const [mLo, mHi] = BAND[theme];
  const C = C_STAR * (mLo + t * (mHi - mLo));

  // Body ink: the law at full criterion, halation ceiling on dark, AA clamp after.
  let yInk = solveInkY(Yb, DENSITY.ink, C, dark);
  if (dark) yInk = Math.min(yInk, DARK_INK_CEIL_Y);
  const ink = clampAA(grayFor(yInk), bg, 4.5, dark);

  // Roles: fractions of the visibility the body ACTUALLY achieved (rails included).
  const vInk = visibility(DENSITY.ink, lumY(ink), Yb);
  const solveRole = (D: number, frac: number, aa: number) => {
    const y = solveInkY(Yb, D, vInk * frac, dark);
    return clampAA(grayFor(dark ? Math.min(y, DARK_INK_CEIL_Y) : y), bg, aa, dark);
  };
  const ink2 = solveRole(DENSITY.ink2, ROLE.ink2, 4.5);
  const ink3 = solveRole(DENSITY.ink3, ROLE.ink3, 3.0);

  // Hairlines: decorative — found, not read — ramping faint → crisp with the slider; solved on
  // both canvases, worst-canvas winner (no statutory floor: a divider is not text).
  const cLine = C * (0.12 + 0.26 * t);
  const lineOn = (canvas: RGB) => grayFor(solveInkY(lumY(canvas), DENSITY.line, cLine, dark));
  const lineCard = lineOn(bg);
  const linePage = lineOn(bgPage);
  const worst = (c: RGB) =>
    Math.min(visibility(DENSITY.line, lumY(c), Yb), visibility(DENSITY.line, lumY(c), lumY(bgPage)));
  const line = worst(linePage) > worst(lineCard) ? linePage : lineCard;

  // ── BRAND PAIR — gold + blue, scaled with the slider, symmetric about the neutral midpoint
  // (127.5) so the two ALWAYS sum to white (blue = 255 − gold, per channel — see
  // feedback_gold_blue_sum_white). At Standard it is EXACTLY the canonical #E8B923/#1746DC,
  // identical in both themes; Calm mutes both toward grey, Crisp/Max sharpen both. Identity
  // marks (logo, gradients) — hue is the law's one free axis.
  const K = [0.6, 0.8, 1, 1.15, 1.3][Math.max(1, Math.min(LEVELS, Math.round(level))) - 1];
  const MID = 127.5, cl = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const gold = ([232, 185, 35] as RGB).map((c) => cl(MID + K * (c - MID))) as RGB;
  const blue: RGB = [255 - gold[0], 255 - gold[1], 255 - gold[2]];
  const g = toHex(gold), b = toHex(blue);
  return {
    "--color-ink": toHex(ink),
    "--color-ink-2": toHex(ink2),
    "--color-ink-3": toHex(ink3),
    "--color-line": toHex(line),
    "--color-yang": g, "--color-yang-light": g, "--color-yang-dark": g,
    "--color-yin": b, "--color-yin-dark": b,
    // Hue-locked LEGIBLE brand inks per theme (small brand-coloured text + UI marks). The law
    // fixes how LIGHT they must be; these are the audited hue-preserving realisations. Brand
    // blue as fine text on dark is physically unusable (blue is ~7% of luminance), hence the
    // brightened #9CB6FF — the law's verdict, not a preference.
    "--color-yang-ink": theme === "light" ? "#8a6300" : "#e8b923",
    "--color-yin-ink": theme === "light" ? "#1746dc" : "#9cb6ff",
    "--ico-gold": theme === "light" ? "#9a6e00" : "#e8b923",
    "--color-yin-light": theme === "light" ? "#1746dc" : "#9cb6ff",
  };
}

// ── Persistence + application (unchanged public surface) ──
const KEY = "aq_contrast";

/** The unset default, biased by ambient brightness (time-of-day is a permission-free ambient
 *  proxy); OS accessibility preferences win outright. A saved choice always overrides. */
function ambientDefault(): number {
  try {
    if (matchMedia("(prefers-contrast: more)").matches) return LEVELS;
    if (matchMedia("(prefers-contrast: less)").matches) return 1;
  } catch {
    /* matchMedia unavailable — fall through */
  }
  let lv = DEFAULT_LEVEL;
  try {
    const h = new Date().getHours();
    if (h < 7 || h >= 21) lv -= 1; // dark ambient → calmer
  } catch {
    /* no clock — keep the base default */
  }
  return Math.max(1, Math.min(LEVELS, lv));
}

/** The saved level if the member has chosen one, else the ambient-biased default. */
export function currentLevel(): number {
  try {
    const v = parseInt(localStorage.getItem(KEY) ?? "", 10);
    if (v >= 1 && v <= LEVELS) return v;
  } catch {
    /* storage blocked — fall through */
  }
  return ambientDefault();
}

function activeTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

/** The live canvas the ink sits on (--color-space-2: cards/articles/comments). */
function canvas(): RGB {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--color-space-2");
  return parseHex(v) ?? (activeTheme() === "light" ? [255, 255, 255] : [22, 22, 25]);
}
/** The live page surface (--color-space-1) — hairlines also paint here. */
function canvasPage(): RGB {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--color-space-1");
  return parseHex(v) ?? (activeTheme() === "light" ? [246, 247, 249] : [13, 13, 15]);
}

/**
 * Re-tint the WHOLE neutral system for a slider level, against the active canvas, as inline
 * overrides on <html>. Identical values to the pre-paint CSS ramp (same tokensFor), refined
 * against the LIVE canvas. Idempotent; re-call after a theme change.
 */
export function applyContrast(level: number = currentLevel()): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-contrast", String(Math.max(1, Math.min(LEVELS, Math.round(level)))));
  const tokens = tokensFor(level, activeTheme(), canvas(), canvasPage());
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(tokens)) root.setProperty(k, v);
  // Canvas charts (uPlot) read tokens into JS — notify them to re-read + redraw.
  if (typeof window !== "undefined") window.dispatchEvent(new Event("aq:contrast"));
}

/** Persist + apply a level. */
export function setContrast(level: number): number {
  const lv = Math.max(1, Math.min(LEVELS, Math.round(level)));
  try {
    localStorage.setItem(KEY, String(lv));
  } catch {
    /* private mode — applies for this page anyway */
  }
  applyContrast(lv);
  return lv;
}
