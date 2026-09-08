import type { CastRow, CastSide } from "./api";

/** What the ArtaCast preview draws from, and the pure rules that turn a couple's facts into the
 *  frame's rows and the thumbnail's hook. Components live in components/cast/CastPreview.tsx. */

export type PreviewData = {
  a: CastSide;
  b: CastSide;
  married_y: number;
  /** The host's picture for the small window. Nothing else is ever drawn on his feed. */
  hostPhoto: string;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The rows one spouse's rail shows: their birth first (date AND place air here and nowhere else),
 *  the wedding, then their own milestones in year order. Eight at most — the kit's ceiling. */
export function timelineRows(side: CastSide, married_y: number): CastRow[] {
  const out: CastRow[] = [];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(side.born || "");
  if (m) {
    const label = `Born ${Number(m[3])} ${MONTHS[Number(m[2]) - 1] || ""}${side.place ? ` · ${side.place}` : ""}`;
    out.push({ y: Number(m[1]), l: label });
  }
  if (married_y > 0) out.push({ y: married_y, l: "Married" });
  const rest = (side.rows || []).filter((r) => r && r.y > 0 && r.l).slice().sort((p, q) => p.y - q.y);
  return [...out, ...rest].slice(0, 8);
}

export const firstName = (name: string) => (name || "").trim().split(/\s+/)[0] || "";

/** The thumbnail's hook: the years married as the number, or the show's question when the year
 *  is not given yet. One type size for all three lines — the phrase is the hook, not the figure. */
export function hookLines(married_y: number, now = new Date()): [string, string, string] {
  const years = married_y > 0 ? now.getUTCFullYear() - married_y : 0;
  if (years >= 1) return [String(years), years === 1 ? "Year" : "Years", "Married"];
  if (married_y > 0) return ["Just", "Got", "Married"];
  return ["How", "We", "Stayed"];
}

