import { uiLocale } from "./wp";

/**
 * Small formatters shared by the timeline and the right column's cards (components/RailCards.tsx).
 * They were defined inside Feed.tsx, which made them the feed's private business — and the cards
 * could not move out of that file without them.
 */
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
