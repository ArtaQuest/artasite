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
/** Milestones per person — the same for both, so the two rails run in step. */
export const MILESTONES = 3;

/**
 * THE STORY IS ONE LINE, told in turns: his first row, then hers, then his next, then hers — the
 * conversation starts with him and ends with her. Each chapter names one rail and one row; with
 * both rails the same length (MILESTONES is mandatory for both) that is 2×rows chapters.
 */
export type Chapter = { rail: "a" | "b"; row: number };
export function chapterSequence(nA: number, nB: number): Chapter[] {
  const out: Chapter[] = [];
  for (let i = 0; i < Math.max(nA, nB); i++) {
    if (i < nA) out.push({ rail: "a", row: i });
    if (i < nB) out.push({ rail: "b", row: i });
  }
  return out;
}
/** Where each rail's gold has reached at chapter `c` (−1 = nothing yet), and which rail speaks. */
export function cursorsAt(seq: Chapter[], c: number): { a: number; b: number; active: "a" | "b" | null } {
  let a = -1, b = -1;
  const upTo = Math.max(-1, Math.min(seq.length - 1, c));
  for (let i = 0; i <= upTo; i++) { if (seq[i].rail === "a") a = seq[i].row; else b = seq[i].row; }
  return { a, b, active: upTo >= 0 ? seq[upTo].rail : null };
}

export function timelineRows(side: CastSide, married_y: number): CastRow[] {
  const out: CastRow[] = [];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(side.born || "");
  if (m) {
    const label = `Born ${Number(m[3])} ${MONTHS[Number(m[2]) - 1] || ""}${side.place ? ` · ${side.place}` : ""}`;
    out.push({ y: Number(m[1]), l: label });
  }
  // IN YEAR ORDER, birth first. The wedding used to be pinned second whatever its year, so a
  // milestone from before the marriage read as if it came after it. Birth stays at the top even
  // when a stray milestone predates it — a rail that starts anywhere but the birth is unreadable.
  const later = [
    ...(married_y > 0 ? [{ y: married_y, l: "Married" }] : []),
    ...(side.rows || []).filter((r) => r && r.y > 0 && r.l),
  ].sort((p, q) => p.y - q.y);
  return [...out, ...later].slice(0, 8);
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

