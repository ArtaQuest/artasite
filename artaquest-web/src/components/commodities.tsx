/**
 * THE PRICE OF ENERGY, in ArtaCoin.
 *
 * Lifted out of the feed rail (operator 2026-07-28). Commodity prices are an ECONOMY surface —
 * they explain what a prize pool is worth in real terms — so they belong with the challenges those
 * pools fund, not beside somebody's post. The feed rail is now what X's is: what's happening, and
 * who to follow.
 *
 * The top-5 fuels the operator named (oil · gas · coal · wheat · maize), each a 56-day ₳ series
 * with an inline sparkline, priced in gold-backed coin so it moves in real terms against the peg.
 * ONE shared scale across every fuel: the whole point of a common ₳/kWh axis is that a cheap fuel
 * LOOKS cheap. Disappears entirely if the upstream data is unavailable.
 */
import { useState } from "react";
import type { Commodities, Commodity } from "../lib/api";
import { Card, cx } from "./ui";
import { uiLocale } from "../lib/wp";

function Sparkline({ series, at, onScrub, lo, hi }: { series: number[]; at: number | null; onScrub: (i: number | null) => void; lo: number; hi: number }) {
  if (!series || series.length < 2) return null;
  const w = 84, h = 24, n = series.length;
  // ONE shared scale across every fuel (operator 2026-07-25): the whole point of a common ₳/kWh
  // axis is that a cheap fuel LOOKS cheap, so each line's height is its real level, not its own
  // self-normalised wiggle.
  const span = (hi - lo) || 1;
  const x = (i: number) => (i / (n - 1)) * w;
  const y = (v: number) => h - ((v - lo) / span) * h;
  const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  // Scrub with ONE handler for mouse + touch + pen (pointer events), mapping the x position to the
  // nearest sample. touch-none stops the browser stealing the gesture as a scroll on phones.
  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0) return;
    onScrub(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
  };
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} preserveAspectRatio="none"
      className="shrink-0 cursor-crosshair touch-none"
      role="img" aria-label={`${n}-day price trend; drag across to read each day`}
      onPointerDown={pick} onPointerMove={pick}
      onPointerLeave={() => onScrub(null)} onPointerCancel={() => onScrub(null)} onPointerUp={() => onScrub(null)}>
      <polyline points={pts} fill="none" stroke="var(--color-yang)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {at != null && series[at] != null ? (
        <>
          <line x1={x(at)} y1="0" x2={x(at)} y2={h} stroke="var(--color-yin)" strokeWidth="1" opacity="0.55" />
          <circle cx={x(at)} cy={y(series[at])} r="2.4" fill="var(--color-yang)" />
        </>
      ) : null}
    </svg>
  );
}

/** "24 Jul" — a scrubbed day reads as a plain short date, no year noise inside a 56-day window. */
function shortDay(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return isNaN(+d) ? iso : d.toLocaleDateString(uiLocale(), { day: "numeric", month: "short", timeZone: "UTC" });
}

/** "₳0.402" · standardized per-kWh prices are small — keep 3 decimals below ₳1. */
function fmtCoin(n: number) {
  return `₳${n >= 1000 ? Math.round(n).toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: n >= 100 ? 0 : n >= 1 ? 1 : 3 })}`;
}

function CommodityRow({ c, at, onScrub, lo, hi }: { c: Commodity; at: number | null; onScrub: (i: number | null) => void; lo: number; hi: number }) {
  const up = (c.pct ?? 0) >= 0;
  const scrubbed = at != null && c.series[at] != null;
  return (
    <div className="flex items-center gap-3 px-4 py-1.5">
      <p className="w-[86px] shrink-0 truncate text-[13px] font-bold text-ink">{c.label}</p>
      <p className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
        <span className="font-semibold tabular-nums text-yang-ink">{fmtCoin(scrubbed ? c.series[at as number] : c.acoin)}</span>
        {scrubbed
          ? <> · <span className="tabular-nums">{c.dates?.[at as number] ? shortDay(c.dates[at as number]) : ""}</span></>
          : c.pct != null
            ? <> · <span className={cx("tabular-nums", up ? "text-yang-ink" : "text-yin-ink")}>{up ? "+" : ""}{c.pct}%</span></>
            : <> · <span className="text-ink-3">monthly</span></>}
      </p>
      <Sparkline series={c.series} at={at} onScrub={onScrub} lo={lo} hi={hi} />
    </div>
  );
}

/** Commodity prices in ArtaCoin — the top-5 the operator named (oil · gas · coal · wheat · maize),
 *  each a 56-day ₳ series with an inline sparkline. Priced in gold-backed coin, so it moves in
 *  real terms against the peg. Disappears if the upstream data is unavailable. */
export function CommoditiesCard({ data }: { data: Commodities | null }) {
  // The scrub index lives HERE, not per row, so dragging any chart moves every chart to the same
  // day — that is what makes five fuels readable as one picture instead of five.
  const [at, setAt] = useState<number | null>(null);
  if (data === null) return <div className="h-56 shrink-0 animate-pulse rounded-2xl bg-veil/[0.06]" aria-hidden />;
  const items = data.items ?? [];
  if (!items.length) return null;
  const all = items.flatMap((c) => c.series ?? []).filter((v) => v > 0);
  const lo = all.length ? Math.min(...all) : 0;
  const hi = all.length ? Math.max(...all) : 1;
  const day = at != null ? items.find((c) => c.dates?.[at])?.dates?.[at] : null;
  return (
    <Card className="shrink-0 overflow-hidden py-3">
      <h2 className="px-4 pb-1 text-[15px] font-bold text-ink">Energy prices</h2>
      <p className="px-4 pb-1.5 text-[11px] text-ink-3">
        ₳ per kWh · same scale · {day ? shortDay(day) : `${data.points ?? ""} trading days`}
      </p>
      {items.map((c) => <CommodityRow key={c.key} c={c} at={at} onScrub={setAt} lo={lo} hi={hi} />)}
      <p className="px-4 pb-3 pt-2 text-[11px] leading-relaxed text-ink-3">
        Every fuel priced the same way — ArtaCoin per kilowatt-hour of energy it contains, gold-backed
        (1 ₳ = 1 mg). All five share one scale, so the cheap ones look cheap. Drag any line to read
        that day across all of them. Coal is a monthly assessment; the rest are daily closes.
      </p>
    </Card>
  );
}
