/**
 * Arta Coin — ArtaQuest's gold-backed currency. 1 ₳ = 1 milligram of gold; coins are
 * always whole integers. Prices are in coins; fiat (CAD) appears only when buying or
 * selling coins, or for donation / payment amounts.
 *
 * THE SYMBOL. Arta Coin's mark IS the ArtaQuest brand icon: the gold "A" cutting a blue
 * ring (the ring reads as a coin). It renders as an inline SVG via <Coins/> / <CoinMark/>
 * so it looks identical to the brand icon at any size. A plain-text fallback glyph "₳"
 * (COIN_SYMBOL) is used only where SVG can't go (order notes, emails, document titles).
 *
 * i18n + RTL: the site is DOM-translated and Arabic flips to RTL. Every rendered amount
 * goes through <Coins/>, which wraps the mark + digits in <bdi dir="ltr" data-ay-skip="1">
 * so the symbol stays left of the number, in order, and is never re-translated.
 */
import React from "react";

export const COIN_SYMBOL = "₳"; // U+20B3 — plain-text fallback only
export const COIN_NAME = "Arta Coin";

// The ArtaQuest brand mark, struck as a coin. Same geometry as <LogoMark/> / <CoinDisc/>: a gold "A"
// bursting through a blue ring that is NOTCHED where the A crosses it (a mask), with the A's
// triangular counter cut hollow (fillRule evenodd → engraved, never a filled blue triangle). Here
// the mark sits on a metallic gold disc with a beveled rim so it reads as a minted coin even at
// 14–16px. Inlined as createElement so this module stays JSX-free.
const A_OUTER = "M43.33 21.21L56.52 21.21L90.61 96.67L78.18 96.67L66.52 70.3L33.48 70.3L22.73 96.67L9.09 96.67Z";
const A_FULL = `${A_OUTER}M50 34.55L38.57 59.3L61.43 59.3Z`; // outer + counter; evenodd cuts the counter hollow

/** The Arta Coin mark — the brand A-in-ring struck on a gold coin. Inline; sizes with text. */
export function CoinMark({
  size = "1em",
  className = "",
  title,
}: {
  size?: string | number;
  className?: string;
  title?: string;
}): React.ReactElement {
  const h = React.createElement;
  // Unique id base per instance — the mark renders many times per page; shared <defs> ids would
  // break every coin after the first to unmount.
  const u = "aqc" + React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const stop = (offset: string, color: string) => h("stop", { offset, stopColor: color });
  return h(
    "svg",
    {
      viewBox: "0 0 100 100", width: size, height: size,
      className: `aq-coin-mark ${className}`.trim(), fill: "none",
      role: title ? "img" : undefined, "aria-label": title || undefined,
      "aria-hidden": title ? undefined : true, focusable: "false",
      style: { display: "inline-block", verticalAlign: "-0.13em", flex: "none" },
    },
    title ? h("title", null, title) : null,
    h(
      "defs",
      null,
      h("radialGradient", { id: `${u}-metal`, cx: "36%", cy: "34%", r: "78%" },
        stop("0%", "#FFE9A8"), stop("40%", "#F5D060"), stop("74%", "#E8B923"), stop("100%", "#C49B1A")),
      h("linearGradient", { id: `${u}-rim`, x1: "0", y1: "0", x2: "0", y2: "1" },
        stop("0%", "#FFE9A8"), stop("50%", "#E8B923"), stop("100%", "#8A6E12")),
      h("linearGradient", { id: `${u}-enamel`, x1: "0", y1: "0", x2: "0", y2: "1" },
        stop("0%", "#1A3DB5"), stop("55%", "#2352E8"), stop("100%", "#4A72FF")),
      h("radialGradient", { id: `${u}-agold`, cx: "38%", cy: "30%", r: "82%" },
        stop("0%", "#FFE9A8"), stop("52%", "#F5D060"), stop("100%", "#C49B1A")),
      h("mask", { id: `${u}-cut` },
        h("rect", { width: 100, height: 100, fill: "#fff" }),
        h("path", { d: A_OUTER, fill: "#000", stroke: "#000", strokeWidth: 7, strokeLinejoin: "round" as const })),
    ),
    // gold disc — bevelled rim + metallic face
    h("ellipse", { cx: 50, cy: 52, rx: 46, ry: 46, fill: "#000", opacity: 0.18 }),
    h("circle", { cx: 50, cy: 50, r: 46, fill: `url(#${u}-rim)` }),
    h("circle", { cx: 50, cy: 50, r: 42, fill: `url(#${u}-metal)` }),
    h("circle", { cx: 50, cy: 50, r: 42, fill: "none", stroke: "#8A6E12", strokeWidth: 1, opacity: 0.45 }),
    h("circle", { cx: 50, cy: 50, r: 43.4, fill: "none", stroke: "#FFE9A8", strokeWidth: 0.9, opacity: 0.6 }),
    // brand mark in a nested viewport (logo proportions) — ring NOTCHED by the A, A counter hollow
    h("svg", { x: 15, y: 15, width: 70, height: 70, viewBox: "0 0 100 100", overflow: "visible" },
      h("circle", { cx: 50, cy: 50, r: 41.6, fill: "none", stroke: "#1A3DB5", strokeWidth: 14, mask: `url(#${u}-cut)` }),
      h("circle", { cx: 50, cy: 50, r: 41.6, fill: "none", stroke: `url(#${u}-enamel)`, strokeWidth: 11.66, mask: `url(#${u}-cut)` }),
      h("circle", { cx: 50, cy: 50, r: 41.6, fill: "none", stroke: "#4A72FF", strokeWidth: 2.2, opacity: 0.55, strokeDasharray: "30 80", transform: "rotate(-120 50 50)", mask: `url(#${u}-cut)` }),
      h("path", { fillRule: "evenodd" as const, fill: "#8A6E12", opacity: 0.85, transform: "translate(1.6 1.8)", d: A_FULL }),
      h("path", { fillRule: "evenodd" as const, fill: "#FFE9A8", transform: "translate(-1.3 -1.5)", d: A_FULL }),
      h("path", { fillRule: "evenodd" as const, fill: `url(#${u}-agold)`, d: A_FULL }),
    ),
  );
}

/** Whole-coin amount with the ₳ symbol, plain string. Use only where JSX can't go. */
export function formatCoins(n: number): string {
  return COIN_SYMBOL + Math.round(n || 0).toLocaleString();
}

/** Sanitize a money text input to digits with at most ONE decimal point — so a stray second dot
 *  ("3.4.5") can't be typed and silently parse to a different value than what's shown. */
export function sanitizeDecimal(raw: string): string {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const i = cleaned.indexOf(".");
  return i === -1 ? cleaned : cleaned.slice(0, i + 1) + cleaned.slice(i + 1).replace(/\./g, "");
}

/** A coin amount: the brand mark + digits, isolated LTR + opted out of translation/RTL re-order.
 *  Use this for EVERY rendered coin value. */
export function Coins({
  n,
  markSize,
  nClassName,
}: {
  n: number;
  markSize?: string;
  nClassName?: string; // extra class on JUST the digits (e.g. `aq-grad`) — never on the mark, so the
                       // coin keeps its own fills and background-clip:text can't hide it on WebKit.
}): React.ReactElement {
  return React.createElement(
    "bdi",
    { dir: "ltr", "data-ay-skip": "1", className: "aq-coins" },
    React.createElement(CoinMark, {
      size: markSize,
      className: "aq-coins__mark",
      title: COIN_NAME,
    }),
    React.createElement(
      "span",
      { className: nClassName ? `aq-coins__n ${nClassName}` : "aq-coins__n", style: { marginInlineStart: "0.16em" } },
      Math.round(n || 0).toLocaleString(),
    ),
  );
}

/* ─────────────────────────── Points (≠ coins) ───────────────────────────
 * Points are a lifetime achievement SCORE (learn + donate + volunteer) that sets your tier on
 * the ladder. They are NOT money — never spent, never fall. Rendered with a distinct star mark
 * (not the gold coin disc) so the two are never confused. */

/** A small sparkle/star mark for points — deliberately unlike the coin disc. Sizes with text. */
export function PointsMark({ size = "1em", className = "", title }: { size?: string | number; className?: string; title?: string }): React.ReactElement {
  const h = React.createElement;
  return h(
    "svg",
    {
      viewBox: "0 0 24 24", width: size, height: size, className: `aq-points-mark ${className}`.trim(),
      role: title ? "img" : undefined, "aria-label": title || undefined, "aria-hidden": title ? undefined : true,
      focusable: "false", style: { display: "inline-block", verticalAlign: "-0.12em", flex: "none" },
    },
    title ? h("title", null, title) : null,
    // four-point sparkle in brand gold
    h("path", { fill: "#E8B923", d: "M12 1.6l2.2 6.0 6.0 2.2-6.0 2.2L12 18.4l-2.2-6.4-6.0-2.2 6.0-2.2z" }),
  );
}

/** Whole points as a plain string, e.g. "1,235 pts". */
export function formatPoints(n: number): string {
  return Math.round(n || 0).toLocaleString() + " pts";
}

/** A points value: star mark + number (+ optional "pts" label). Use for every rendered points value.
 *  `nClassName` styles ONLY the digits (e.g. `aq-grad`), leaving the gold star mark untouched. */
export function Points({ n, withLabel = false, markSize, nClassName }: { n: number; withLabel?: boolean; markSize?: string; nClassName?: string }): React.ReactElement {
  return React.createElement(
    // Matches Coins() above: a bdi pinned to ltr, so the star mark and the number keep their order
    // inside Persian/Arabic text instead of reading "pts 1,234" with the mark trailing.
    "bdi",
    { dir: "ltr", "data-ay-skip": "1", className: "aq-points", style: { whiteSpace: "nowrap" } },
    React.createElement(PointsMark, { size: markSize, className: "aq-points__mark", title: "points" }),
    React.createElement("span", { className: nClassName ? `aq-points__n ${nClassName}` : "aq-points__n", style: { marginInlineStart: "0.22em" } },
      Math.round(n || 0).toLocaleString() + (withLabel ? " pts" : "")),
  );
}

/** Fiat money (CAD by default) — only for buying/selling coins, donations, and payments. */
export function formatFiat(n: number, cur = "CAD"): string {
  const v = n || 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: cur,
      maximumFractionDigits: Number.isInteger(v) ? 0 : 2,
    }).format(v);
  } catch {
    return `$${v.toLocaleString()} ${cur}`;
  }
}

// Real video runtime → compact label ("31m" / "1h 10m"); "" when unknown (never fabricated).
// Shared by the Courses grid and the Landing featured tiles so they read consistently.
export function formatDuration(sec?: number): string {
  if (!sec || sec <= 0) return "";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}
