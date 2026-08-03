/* A lightweight, global keyword → resonance lookup, built once at module load from the research atlas.
 * Every field in research.json carries its RESONANCE PERIOD (years) and its fitted phase key (an internal,
 * never-rendered identifier that maps onto the cycle of the twelve seasons). This maps a keyword/field name —
 * matched case-insensitively by `key` first, then by `label` — to that pair, so any keyword shown anywhere in
 * the SPA can reveal "{season} · resonates every {period} yr" on hover. */
import researchData from "../data/research.json";
import { seasonForPhase, seasonTitle } from "./seasons";

export type Resonance = { sign: string; period: number };

const byKey = new Map<string, Resonance>();
const byLabel = new Map<string, Resonance>();

for (const t of researchData.topics as any[]) {
  // Only index fields that actually carry a resonance period + sign; skip anything still being computed.
  if (t == null || t.period == null || !t.sign) continue;
  const r: Resonance = { sign: String(t.sign), period: Number(t.period) };
  if (t.key) byKey.set(String(t.key).toLowerCase(), r);
  if (t.label) byLabel.set(String(t.label).toLowerCase(), r);
}

/** The resonance (sign + period, years) for a keyword — matched by `key` first, then `label`, case-insensitively.
 *  Returns null when the keyword is unknown or its analysis hasn't been computed yet. */
export function resonanceOf(keyOrLabel: string): Resonance | null {
  if (!keyOrLabel) return null;
  const k = keyOrLabel.trim().toLowerCase();
  return byKey.get(k) ?? byLabel.get(k) ?? null;
}

/** The ready-made tooltip string ("A\u2666 \u00b7 Crown, the Champion \u00b7 resonates every {period} yr", period to
 *  2 dp) for a keyword, or "". The stored phase key itself is never shown (no astrology, 2026-07-10). */
export function resonanceTitle(keyOrLabel: string): string {
  const r = resonanceOf(keyOrLabel);
  if (!r) return "";
  const s = seasonForPhase(r.sign);
  return `${s ? `Season ${s.rank} · ${seasonTitle(s)}` : "—"} · resonates every ${r.period.toFixed(2)} yr`;
}
