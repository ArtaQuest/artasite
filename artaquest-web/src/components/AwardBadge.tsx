import { useEffect, useRef, useState } from "react";
import type { Award } from "../lib/api";
import { Button } from "./ui";

/**
 * Kaggle-style engagement badges, rendered as FLAT-TOP hexagon medallions — each category in its
 * own vibrant colour (blue/violet/green/gold/orange/red/cyan), tier-shaded — stacked as a HONEYCOMB
 * on the member's profile —
 * each row's hexes interlock with the row above (zig-zag offset, rows pulled up to nest, no
 * gaps). Earned badges are filled and lit; locked ones are muted with a blue progress arc.
 * Clicking a badge opens its detail (name, what it's for, your progress). All pure SVG.
 */

/** Regular flat-top hexagon filling a 100×86.6 box so neighbours tessellate edge-to-edge. */
const HEX = "25,0 75,0 100,43.3 75,86.6 25,86.6 0,43.3";

/** Cell geometry. Flat-top: height = √3/2 · width keeps the hexagon regular so the comb closes. */
const HEX_W = 80; // default hexagon width (the detail dialog overrides with a larger size)

/**
 * Kaggle-style colour: each CATEGORY owns a vibrant hue, so the wall reads as a colourful mosaic
 * rather than a gold+blue duo; the TIER then shades that hue (gold brightest → bronze deepest).
 * (User-directed 2026-06-08 — a scoped override of the two-colour brand, for the badge medallions.)
 */
const CAT: Record<string, { h: string; glyph: string }> = {
  learning:    { h: "#3b82f6", glyph: "#f7faff" }, // blue
  discussion:  { h: "#a855f7", glyph: "#fbf6ff" }, // violet
  competition: { h: "#f5b301", glyph: "#231a02" }, // gold (dark glyph on bright fill)
  community:   { h: "#22c55e", glyph: "#f3fff8" }, // green
  economy:     { h: "#fb923c", glyph: "#231202" }, // orange (dark glyph)
  service:     { h: "#ef4444", glyph: "#fff5f5" }, // red
  standing:    { h: "#06b6d4", glyph: "#effdff" }, // cyan
};

/** Tier shades the category hue — gold is light-dominant (brightest), bronze the deepest. */
const SHADE: Record<Award["tier"], { l: number; d: number }> = {
  gold:   { l: 0.34, d: 0.06 },
  silver: { l: 0.16, d: 0.24 },
  bronze: { l: 0.04, d: 0.40 },
};
const TIER_NAME: Record<Award["tier"], string> = { bronze: "Bronze", silver: "Silver", gold: "Gold" };

/** Clamp to a 2-digit hex byte. */
function hx(n: number) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0"); }
/** Linear blend of two #rrggbb colours by amt (0..1). */
function mix(hex: string, target: string, amt: number) {
  const a = hex.replace("#", ""), b = target.replace("#", "");
  const c = (s: number) => parseInt(a.slice(s, s + 2), 16), d = (s: number) => parseInt(b.slice(s, s + 2), 16);
  return "#" + hx(c(0) + (d(0) - c(0)) * amt) + hx(c(2) + (d(2) - c(2)) * amt) + hx(c(4) + (d(4) - c(4)) * amt);
}
/** The full colour set for one badge: gradient top/bottom, rim, glyph ink, glow + tier name. */
function palette(group: string, tier: Award["tier"]) {
  const c = CAT[group] ?? CAT.learning;
  const s = SHADE[tier] ?? SHADE.silver;
  return {
    light: mix(c.h, "#ffffff", s.l),
    dark: mix(c.h, "#000000", s.d),
    edge: mix(c.h, "#000000", 0.34),
    glyph: c.glyph,
    fill: c.h,
    name: TIER_NAME[tier] ?? "",
  };
}

/** Human labels for the catalog's category keys — shown in the detail dialog for context. */
const GROUP_LABEL: Record<string, string> = {
  learning: "Learning",
  discussion: "Discussion",
  competition: "Competition",
  community: "Community",
  economy: "Generosity",
  service: "Service",
  standing: "Standing",
};

/** Minimal line glyphs, drawn in a 24×24 box centred on (0,0) → placed at the hexagon's heart. */
function Glyph({ icon }: { icon: string }) {
  switch (icon) {
    case "cap":
      return <path d="M-11 -3 L0 -8 L11 -3 L0 2 Z M-7 -1 V5 Q0 9 7 5 V-1 M11 -3 V4" />;
    case "question":
      // A speech bubble holding a "?" — posting your own question/reply on a section board (the
      // question-first pedagogy), distinct from the plain "chat" conversation bubble.
      return <path d="M-9 -8 H9 a3 3 0 0 1 3 3 V2 a3 3 0 0 1 -3 3 H-3 L-7 9 V8 H-9 a3 3 0 0 1 -3 -3 V-5 a3 3 0 0 1 3 -3 Z M-2.6 -4 Q-2.6 -6 0 -6 Q2.8 -6 2.8 -3.8 Q2.8 -1.6 0 -0.8 V0.6 M0 2.6 v0.1" />;
    case "star":
      return <path d="M0 -10 L3 -3 L10 -3 L4.5 1.5 L6.5 9 L0 4.5 L-6.5 9 L-4.5 1.5 L-10 -3 L-3 -3 Z" />;
    case "heart":
      return <path d="M0 9 C-12 0 -9 -10 -2 -7 Q0 -6 0 -3 Q0 -6 2 -7 C9 -10 12 0 0 9 Z" />;
    case "medal":
      // Ribbons + disc with a small star struck into it, so it reads as an award medal, not a tick.
      return <path d="M-6 -10 L-2 0 M6 -10 L2 0 M0 9 m-7 0 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0 M0 5 L1.2 7.8 L4 7.8 L1.8 9.6 L2.6 12.6 L0 10.8 L-2.6 12.6 L-1.8 9.6 L-4 7.8 L-1.2 7.8 Z" />;
    case "people":
      return <path d="M-5 -3 a3 3 0 1 0 0.01 0 M5 -3 a3 3 0 1 0 0.01 0 M-10 9 q0 -7 5 -7 q3 0 5 3 q2 -3 5 -3 q5 0 5 7" />;
    case "coin":
      // A struck coin: outer rim + inner rim + the ArtaQuest "A" minted in the centre (not a target).
      return <path d="M0 0 m-10 0 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0 M0 0 m-7.5 0 a7.5 7.5 0 1 0 15 0 a7.5 7.5 0 1 0 -15 0 M-3.4 4.2 L0 -4.8 L3.4 4.2 M-1.9 0.7 H1.9" />;
    case "bug":
      // A ladybug: oval body + head + wing-division line + spots + three leg pairs (clearly a bug).
      return <path d="M0 1 m-6.5 0 a6.5 7 0 1 0 13 0 a6.5 7 0 1 0 -13 0 M0 -7 m-2.5 0 a2.5 2.5 0 1 0 5 0 a2.5 2.5 0 1 0 -5 0 M0 -5 V8 M-3 0 a1.2 1.2 0 1 0 0.1 0 M3 0 a1.2 1.2 0 1 0 0.1 0 M-3 4.5 a1.2 1.2 0 1 0 0.1 0 M3 4.5 a1.2 1.2 0 1 0 0.1 0 M-6.5 -1 l-3 -1.5 M6.5 -1 l3 -1.5 M-6.5 2 h-3 M6.5 2 h3 M-6 5 l-2.5 1.5 M6 5 l2.5 1.5" />;
    case "shield":
      return <path d="M0 -10 L9 -6 V2 Q9 8 0 10 Q-9 8 -9 2 V-6 Z M-4 -1 L-1 3 L5 -4" />;
    case "flame":
      // Outer flame + an inner core flame so it reads as fire, not a water droplet, at small sizes.
      return <path d="M0 10 C-8 6 -7 -2 -2 -10 C-2 -4 4 -5 2 0 C6 -2 7 3 4 6 C3 9 -3 9 0 10 Z M0 8 C-2.6 6.6 -2.6 3 0 0.6 C1.9 3 1.9 6 0 8 Z" />;
    case "chat":
      return <path d="M-10 -8 H10 V4 H-2 L-7 9 V4 H-10 Z M-6 -2 h12 M-6 1 h8" />;
    case "pen":
      return <path d="M-9 9 L-6 1 L4 -9 L8 -5 L-2 5 Z M2 -7 L6 -3 M-9 9 L-6 6" />;
    case "globe":
      // Circle + equator & two latitude chords + two curved longitude meridians — reads as a globe,
      // not a crosshair (no straight vertical cross).
      return <path d="M0 0 m-10 0 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0 M-10 0 H10 M-7.7 -6.4 H7.7 M-7.7 6.4 H7.7 M0 -10 a6 10 0 0 0 0 20 M0 -10 a6 10 0 0 1 0 20" />;
    case "calendar":
      return <path d="M-9 -7 H9 V9 H-9 Z M-9 -2 H9 M-5 -10 V-4 M5 -10 V-4 M-4 2 h3 M3 2 h3 M-4 6 h3" />;
    case "sparkle":
      return <path d="M0 -11 C1 -3 3 -1 11 0 C3 1 1 3 0 11 C-1 3 -3 1 -11 0 C-3 -1 -1 -3 0 -11 Z M8 -10 v5 M5.5 -7.5 h5" />;
    case "mic":
      return <path d="M0 -10 a3 3 0 0 1 3 3 V-1 a3 3 0 0 1 -6 0 V-7 a3 3 0 0 1 3 -3 Z M-6 -3 a6 6 0 0 0 12 0 M0 6 V10 M-4 10 h8" />;
    case "rocket":
      return <path d="M0 -11 C5 -6 5 3 0 9 C-5 3 -5 -6 0 -11 Z M0 -3 a2.2 2.2 0 1 0 0.01 0 M-4.5 5 L-8 10 L-3.5 8 M4.5 5 L8 10 L3.5 8 M-2 9 L0 13 L2 9" />;
    case "map":
      return <path d="M-10 -7 L-3 -9 L3 -7 L10 -9 V7 L3 9 L-3 7 L-10 9 Z M-3 -9 V7 M3 -7 V9" />;
    case "tag":
      return <path d="M-9 -9 H1 L10 0 L0 10 L-9 1 Z M-5 -5 a1.7 1.7 0 1 0 0.01 0" />;
    case "crown":
      return <path d="M-10 -3 L-6 -7 L-2 -2 L0 -8 L2 -2 L6 -7 L10 -3 L8 7 H-8 Z M-8 7 H8" />;
    case "flag":
      // Pole + swallowtail banner. Dropped the redundant inner rectangle that just cluttered it;
      // the banner's left edge is the pole itself, so no closing segment is needed (avoids a
      // double stroke over the pole).
      return <path d="M-7 -10 V11 M-7 -9 H8 L4 -5 L8 -1 H-7" />;
    case "rings":
      // Three strongly-interlocking rings (a trefoil/Venn) — breadth across areas (well-rounded),
      // not two-eyes-and-a-mouth.
      return <path d="M-3 -1.8 m-5.5 0 a5.5 5.5 0 1 0 11 0 a5.5 5.5 0 1 0 -11 0 M3 -1.8 m-5.5 0 a5.5 5.5 0 1 0 11 0 a5.5 5.5 0 1 0 -11 0 M0 3.8 m-5.5 0 a5.5 5.5 0 1 0 11 0 a5.5 5.5 0 1 0 -11 0" />;
    case "books":
      return <path d="M-9 -8 h5 a2 2 0 0 1 2 2 V9 a2 2 0 0 0 -2 -2 h-5 Z M9 -8 h-5 a2 2 0 0 0 -2 2 V9 a2 2 0 0 1 2 -2 h5 Z M2 -4 V9" />;
    case "gift":
      // A wrapped gift (box + lid + ribbon + bow) — giving/donation, distinct from the upvote heart.
      return <path d="M-8 -4 H8 V-1 H-8 Z M-7 -1 H7 V8 H-7 Z M0 -4 V8 M0 -4 C-1 -7 -5 -7 -4 -4 M0 -4 C1 -7 5 -7 4 -4" />;
    case "bulb":
      // A lightbulb (glass + screw base + filament) — ideas/contributions.
      return <path d="M0 -10 C5 -10 8 -6 8 -2 C8 1 6 3 5 5 H-5 C-6 3 -8 1 -8 -2 C-8 -6 -5 -10 0 -10 Z M-5 5 H5 M-3 8 H3 M-2 -4 L0 -1 L2 -4" />;
    case "trophy":
      // A winner's cup — bowl + two handles + stem + base. (champion / a standout reply)
      return <path d="M-6 -8 H6 V-5 Q6 1.5 0 2.5 Q-6 1.5 -6 -5 Z M-6 -6 Q-9.5 -6 -9.5 -3 Q-9.5 -0.5 -6 -0.5 M6 -6 Q9.5 -6 9.5 -3 Q9.5 -0.5 6 -0.5 M0 2.5 V5.5 M-4 5.5 H4 L2.6 9 H-2.6 Z" />;
    case "podium":
      // A 1-2-3 winners' podium (centre tallest) — placing / podium streak.
      return <path d="M-9.5 2 H-3.5 V9 H-9.5 Z M-3 -4 H3 V9 H-3 Z M3.5 5 H9.5 V9 H3.5 Z M0 -7 l1 2 2.2 .2 -1.6 1.6 .5 2.1 -2.1 -1.1 -2.1 1.1 .5 -2.1 -1.6 -1.6 2.2 -.2 Z" />;
    case "mosaic":
      // A 2×2 tile mosaic — variety / breadth across many sources (eclectic).
      return <path d="M-9 -9 H-1 V-1 H-9 Z M1 -9 H9 V-1 H1 Z M-9 1 H-1 V9 H-9 Z M1 1 H9 V9 H1 Z" />;
    case "compass":
    default:
      // A circle with a 4-point compass rose (N/S long needle + E/W needle) — clearly a compass.
      return <path d="M0 0 m-10 0 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0 M0 -7.5 L2.3 0 L0 7.5 L-2.3 0 Z M-7.5 0 L0 2.3 L7.5 0 L0 -2.3 Z" />;
  }
}

/** Compact threshold label (Kaggle-style number on tiered badges): 1000→"1k", 1000000→"1M". */
function kfmt(n: number) { return n >= 1e6 ? Math.round(n / 1e6) + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(n); }

/** A single flat-top hexagon at a fixed size (used in the comb and, larger, in the detail dialog).
 *  Prettified: a vertical fill gradient, a clipped glossy highlight across the top, an inset bevel
 *  rim for a raised/minted feel, and — at dialog size — a soft tier-coloured glow. Gradient ids are
 *  namespaced per (key,size) so many badges can render without colliding. */
function Hex({ award, size = HEX_W }: { award: Award; size?: number }) {
  const t = palette(award.group, award.tier);
  const earned = award.earned;
  const pct = award.need > 0 ? Math.min(100, Math.round((award.have / award.need) * 100)) : 0;
  const id = `${award.key}-${size}`;
  const big = size >= 90;
  // MULTI-SHADE fill (Kaggle-style): four tones of the category hue down a slightly diagonal axis,
  // plus an off-centre light bloom (top-left) and a deep shadow (bottom-right) → a painterly,
  // many-shaded medallion rather than a flat two-stop gradient. Locked badges stay neutral grey.
  const s0 = earned ? mix(t.fill, "#ffffff", 0.5) : "#2c2c33"; // bright corner
  const s1 = earned ? t.light : "#232329";
  const s2 = earned ? t.fill : "#1b1b20";
  const s3 = earned ? t.dark : "#141417";
  return (
    <svg viewBox="0 0 100 86.6" width={size} height={size * 0.866} className="block" overflow="visible">
      <defs>
        <linearGradient id={`f-${id}`} x1="0.1" y1="0" x2="0.55" y2="1">
          <stop offset="0" stopColor={s0} />
          <stop offset="0.4" stopColor={s1} />
          <stop offset="0.72" stopColor={s2} />
          <stop offset="1" stopColor={s3} />
        </linearGradient>
        <radialGradient id={`hl-${id}`} cx="0.32" cy="0.24" r="0.6">
          <stop offset="0" stopColor="#ffffff" stopOpacity={earned ? 0.32 : 0.05} />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`sh-${id}`} cx="0.76" cy="0.82" r="0.62">
          <stop offset="0" stopColor="#000000" stopOpacity={earned ? 0.3 : 0.22} />
          <stop offset="1" stopColor="#000000" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`g-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity={earned ? 0.4 : 0.12} />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`c-${id}`}><polygon points={HEX} /></clipPath>
        <filter id={`r-${id}`} x="-30%" y="-30%" width="160%" height="160%" filterUnits="objectBoundingBox">
          <feTurbulence type="fractalNoise" baseFrequency="0.11" numOctaves="2" seed="7" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="2.9" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        {earned && big && (
          <filter id={`s-${id}`} x="-45%" y="-45%" width="190%" height="190%">
            <feDropShadow dx="0" dy="0" stdDeviation="5" floodColor={t.fill} floodOpacity="0.6" />
          </filter>
        )}
      </defs>
      <polygon points={HEX} fill={`url(#f-${id})`} stroke={earned ? t.edge : "#2f2f37"} strokeWidth="2.5" strokeLinejoin="round" filter={earned && big ? `url(#s-${id})` : undefined} />
      <g clipPath={`url(#c-${id})`}>
        <rect x="0" y="0" width="100" height="86.6" fill={`url(#sh-${id})`} />
        <rect x="0" y="0" width="100" height="86.6" fill={`url(#hl-${id})`} />
        <rect x="0" y="0" width="100" height="44" fill={`url(#g-${id})`} />
        <polygon points={HEX} fill="none" stroke="#ffffff" strokeOpacity={earned ? 0.3 : 0.08} strokeWidth="2" strokeLinejoin="round" transform="translate(50 43.3) scale(0.84) translate(-50 -43.3)" />
      </g>
      {!earned && pct > 0 && (
        <polygon points={HEX} fill="none" stroke={t.fill} strokeWidth="3.5" strokeLinejoin="round" pathLength={100} strokeDasharray={`${pct} 100`} className="opacity-90" />
      )}
      {/* Hand-drawn look: the shared roughen filter (defined once in AwardWall) gives every glyph an
          organic, sketched wobble. Slightly heavier stroke for a marker feel. */}
      <g transform="translate(50 40) scale(1.4)" fill="none" stroke={earned ? t.glyph : "#9a9da6"} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" filter={`url(#r-${id})`}>
        <Glyph icon={award.icon} />
      </g>
      {/* Kaggle-style threshold number on tiered badges (need > 1) → makes each tier of a ladder unique. */}
      {award.need > 1 && (
        <g>
          <rect x="33" y="62" width="34" height="18" rx="9" fill="#0a0e16" fillOpacity="0.92" stroke={earned ? t.edge : "#2f2f37"} strokeWidth="1.4" />
          <text x="50" y="75.5" textAnchor="middle" fontSize="13" fontWeight="800" fill={earned ? "#ffffff" : "#9a9da6"} style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>{kfmt(award.need)}</text>
        </g>
      )}
    </svg>
  );
}

/**
 * The honeycomb wall. A TRUE honeycomb tessellation: each row is offset half a cell and pulled up
 * so every hex nests in the valley between the two above it (flat-top hexes, opposite sides
 * parallel). The gaps come from rendering each hexagon a touch smaller than its tessellation CELL,
 * so a uniform mortar gap rings every hex without breaking the comb. Horizontal + width-filling:
 * cells-per-row is measured from the container width, so it reflows responsively.
 */
const CELL = 80; // tessellation cell width (cells touch; the hex inside is smaller → the gap)
const CELL_H = Math.round(CELL * 0.866); // ≈ 69
const HEXSIZE = 56; // rendered hexagon width — smaller, with a wide Kaggle-style mortar gap (CELL−HEXSIZE)
const ADV = CELL * 0.75; // horizontal advance per hex in a row (quarter-cell overlap of cells)

export function AwardWall({ awards }: { awards: Award[] }) {
  // All hooks run unconditionally (before any early return) so hook order is stable across renders.
  const [open, setOpen] = useState<Award | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(8);
  const hasAwards = awards && awards.length > 0;
  useEffect(() => {
    // Re-run once awards load: the measured <div> only mounts after the early return below clears,
    // so attaching the observer on first (empty) render would no-op and leave cols stuck at default.
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const recompute = () => setCols(Math.max(1, Math.floor((el.clientWidth - CELL * 0.25) / ADV)));
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasAwards]);

  if (!awards || awards.length === 0) return null;

  // Earned first, led by the highest tier (gold → silver → bronze) so a member's best work shows
  // up front; then locked badges ordered by how close they are, teasing the next one to chase.
  // Sorts are stable-keyed by catalog index so same-rank badges keep their declared order.
  const rank: Record<Award["tier"], number> = { gold: 0, silver: 1, bronze: 2 };
  const idx = new Map(awards.map((a, i) => [a.key, i]));
  const prog = (a: Award) => (a.need > 0 ? a.have / a.need : 0);
  const earned = awards
    .filter((a) => a.earned)
    .sort((a, b) => rank[a.tier] - rank[b.tier] || (idx.get(a.key)! - idx.get(b.key)!));
  const locked = awards
    .filter((a) => !a.earned)
    .sort((a, b) => prog(b) - prog(a) || (idx.get(a.key)! - idx.get(b.key)!));
  const ordered = [...earned, ...locked];

  const rows: Award[][] = [];
  for (let i = 0; i < ordered.length; i += cols) rows.push(ordered.slice(i, i + cols));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[20px] font-bold tracking-tight">Awards</h2>
        <span className="text-[13px] text-ink-3">
          <b className="text-ink-2 tabular-nums">{earned.length}</b> of {awards.length} earned
        </span>
      </div>

      <div ref={wrapRef}>
        {rows.map((row, ri) => (
          <div key={ri} className="flex items-start" style={{ marginTop: ri ? -Math.round(CELL_H * 0.5) : 0 }}>
            {row.map((a, ci) => (
              <button
                key={a.key}
                type="button"
                onClick={() => setOpen(a)}
                className={`group relative grid place-items-center rounded-md outline-none transition-transform duration-150 hover:z-10 hover:scale-110 focus-visible:z-10 focus-visible:scale-110 ${a.earned ? "" : "opacity-65 hover:opacity-100"}`}
                style={{ width: CELL, height: CELL_H, marginLeft: ci ? -Math.round(CELL * 0.25) : 0, marginTop: ci % 2 ? Math.round(CELL_H * 0.5) : 0 }}
                aria-label={a.earned ? `Awarded: ${a.label}. ${a.desc}.` : `Locked: ${a.label}. ${a.desc}. Progress ${a.have} of ${a.need}.`}
                title={a.earned ? `${a.label} — ${a.desc}` : `${a.label} — ${a.desc} (${a.have}/${a.need})`}
              >
                <Hex award={a} size={HEXSIZE} />
              </button>
            ))}
          </div>
        ))}
      </div>

      {open && <AwardDialog award={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** Click-through detail for one badge — its hexagon, name, what earns it, and your progress. */
function AwardDialog({ award, onClose }: { award: Award; onClose: () => void }) {
  const t = palette(award.group, award.tier);
  const pct = award.need > 0 ? Math.min(100, Math.round((award.have / award.need) * 100)) : 0;
  const panelRef = useRef<HTMLDivElement>(null);
  // Standard dialog a11y: Escape closes (overlay/Close already do), and Tab is trapped inside the
  // panel so focus can't wander to the page behind the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const f = Array.from(panel.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((el) => !el.hasAttribute("disabled"));
      if (!f.length) { e.preventDefault(); panel.focus(); return; }
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Move focus into the dialog on open and return it to the trigger (the badge button) on close,
  // so keyboard + screen-reader users keep their place.
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => trigger?.focus?.();
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={award.label} onClick={onClose}>
      <div ref={panelRef} tabIndex={-1} className="w-full max-w-md rounded-2xl border border-line bg-space-2 p-6 shadow-2xl outline-none" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-4">
          <div className="shrink-0">
            <Hex award={award} size={96} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[22px] font-bold leading-tight tracking-tight">{award.label}</h3>
            <p className="mt-1 text-[13px] font-semibold uppercase tracking-wide" style={{ color: award.earned ? t.fill : "var(--color-ink-3)" }}>
              {(GROUP_LABEL[award.group] ?? award.group) + " · " + t.name + " · " + (award.earned ? "Awarded" : "Locked")}
            </p>
            <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{award.desc}.</p>
          </div>
        </div>
        {!award.earned && (
          <div className="mt-5">
            <div className="mb-1.5 flex justify-between text-[13px] text-ink-3">
              <span>Progress</span>
              <span className="tabular-nums">{award.have} / {award.need}</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-space-3">
              <div className="h-full rounded-full bg-yin-light" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
        <div className="mt-6 flex justify-end">
          <Button type="button" onClick={onClose} variant="outline" className="h-10 px-6 text-[14px]">Close</Button>
        </div>
      </div>
    </div>
  );
}
