import { uiLocale } from "./wp";

/**
 * Small formatters shared by the timeline and the right column's cards (components/RailCards.tsx).
 * They were defined inside Feed.tsx, which made them the feed's private business — and the cards
 * could not move out of that file without them.
 */
/** Was this unix-seconds timestamp within the last `horizonS` seconds? A helper rather than an
 *  inline `Date.now()` because the react-hooks purity rule (rightly) bars impure calls in render —
 *  the clock read lives here with timeAgo's, its natural neighbour. */
export function isFresh(ts: number, horizonS: number) {
  return !!ts && Date.now() / 1000 - ts < horizonS;
}

export function timeAgo(ts: number) {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(ts * 1000).toLocaleDateString(uiLocale(), { month: "short", day: "numeric" });
}

export function closesIn(ts: number) {
  const s = Math.max(0, ts - Math.floor(Date.now() / 1000));
  const d = Math.floor(s / 86400);
  if (d >= 2) return `${d} days`;
  const h = Math.floor(s / 3600);
  return h >= 1 ? `${h}h` : `${Math.max(1, Math.floor(s / 60))}m`;
}

export function fmtCount(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}


/**
 * A NAME IS NEVER SHORTENED (operator 2026-08-16, again 2026-08-18: "reduce the font to avoid … in
 * the name"). `truncate` puts an ellipsis through the middle of a person's name, which is the one
 * string on the platform where half of it identifies nobody. The type steps down instead, and the
 * name wraps if it still does not fit.
 *
 * EVERY CLASS HERE IS A LITERAL. Tailwind scans source text, so a class built by template —
 * `text-[${px}px]` — is never generated and silently resolves to no font-size at all. That is the
 * same failure that cost an hour on the sticky column this week (`theme()` inside an arbitrary
 * value, also emitting nothing), and a class that compiles to nothing looks exactly like one that
 * works until it is measured.
 *
 * Stepped by LENGTH, not by measurement: a measured fit depends on a font that may not have loaded
 * when the row first paints, and would reflow when it does. Steps are per base size, so a 14px row
 * and a 17px heading each shrink within their own scale instead of all collapsing to 12px.
 */
const NAME_STEPS = {
  12: ["text-[12px]", "text-[11px]", "text-[10px]"],
  13: ["text-[13px]", "text-[12px]", "text-[11px]"],
  14: ["text-[14px]", "text-[13px]", "text-[12px]"],
  15: ["text-[15px]", "text-[14px]", "text-[12.5px]"],
  17: ["text-[17px]", "text-[15px]", "text-[13px]"],
} as const;

export function nameSize(name: string, base: keyof typeof NAME_STEPS = 14): string {
  const n = (name || "").trim().length;
  const [a, b, c] = NAME_STEPS[base];
  return n <= 16 ? a : n <= 22 ? b : c;
}

/** The full class for a member name: no ellipsis, wraps, type stepped to the length. */
export function nameClass(name: string, base: keyof typeof NAME_STEPS = 14): string {
  return `break-words leading-tight ${nameSize(name, base)}`;
}
