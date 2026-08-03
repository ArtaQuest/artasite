/**
 * balance.tsx — the shared "balance / focus" distribution panel used by Studio (catalogue
 * distribution). N buckets as sorted horizontal BARS: each bar's length ∝ its value, the top
 * buckets glow brightest. No radial charts anywhere (operator 2026-07-10 — wheels are banned);
 * buckets are fields / styles / motivations, never anything astrological.
 */
import { cx } from "./ui";

export type BalanceBucket = { key: string; label: string; value: number };

/** Normalised Shannon entropy of a distribution, 0–100 (100 = perfectly even = max entropy). */
export function balancePct(values: number[]): number {
  const tot = values.reduce((s, v) => s + v, 0);
  if (!tot) return 0;
  if (values.length < 2) return 100;
  const ps = values.map((v) => v / tot).filter((p) => p > 0);
  return Math.round((-ps.reduce((s, p) => s + p * Math.log(p), 0) / Math.log(values.length)) * 100);
}

/** A labelled balance column: heading (q-word + descriptor) + balance% + sorted bars + thinnest note. */
export function BalancePanel({ title, sub, balance, thinnest, buckets, top }: {
  title: string; sub: string; balance?: number; thinnest?: string;
  buckets: BalanceBucket[]; top?: Set<string>;
}) {
  const maxV = Math.max(1, ...buckets.map((b) => b.value));
  const total = buckets.reduce((s, b) => s + b.value, 0);
  const isCounts = buckets.every((b) => Number.isInteger(b.value));
  const sorted = [...buckets].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-1">
        <h4 className="text-[13px] font-semibold">{title} <span className="font-normal text-ink-3">· {sub}</span></h4>
        {balance != null && <span className="text-[11px] text-ink-2">Balance <b className="text-ink tabular-nums">{balance}%</b></span>}
      </div>
      <ul className="flex flex-col gap-1">
        {sorted.map((b) => {
          const isTop = top?.has(b.key);
          const pct = total ? Math.round((b.value * 100) / total) : 0;
          return (
            <li key={b.key} className="flex items-center gap-2 text-[12px]">
              <span className={cx("w-28 shrink-0 truncate", isTop ? "font-bold text-yang" : "font-semibold text-ink")} title={b.label}>{b.label}</span>
              <span className="h-3 min-w-0 flex-1 rounded-sm bg-veil/[0.06]">
                <span className="block h-full rounded-sm bg-yang" style={{ width: `${(b.value / maxV) * 100}%`, opacity: isTop ? 0.9 : 0.35 + 0.45 * (b.value / maxV) }} aria-hidden />
              </span>
              <span className="w-16 shrink-0 text-right tabular-nums text-ink-2">{isCounts ? `${b.value} · ${pct}%` : `${pct}%`}</span>
            </li>
          );
        })}
      </ul>
      {thinnest ? <p className="text-[11px] text-ink-2">thinnest <b className="text-yang">{thinnest}</b></p> : null}
    </div>
  );
}
