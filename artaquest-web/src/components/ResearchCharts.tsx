/* Interactive, zoomable charts for the field/research analysis pages — rendered entirely in JS (uPlot canvas).
 * Python only ships the FITTED DATA (tuning curve, actual/fit series, per-body shares); ALL plotting happens
 * here in the browser, so every chart is live:
 *   • drag across it to zoom into a range · double-click to reset · scroll-wheel to zoom under the cursor
 *   • a hover crosshair + legend reads off the exact value at any point
 * Colours come from the design tokens, so the charts follow the day/night theme and never break the two-colour brand. */
import { useCallback, useMemo } from "react";
import uPlot from "uplot";
import { UPlotChart, baseOpts, useThemeTokens, type DrawHook } from "./UPlotChart";

/** Draw a series as a SCATTER of dots on the canvas (only the in-view points), returning null so uPlot draws no
 *  line. Crucially this keeps the series' `points.show` FALSE, so uPlot still renders a hover focus-ring on it —
 *  always-on points would suppress that ring (you couldn't visually select a point). */
function scatterPaths(radius: number, color: string) {
  return (u: uPlot, sidx: number): uPlot.Series.Paths | null => {
    const ctx = u.ctx;
    const xd = u.data[0] as number[];
    const yd = u.data[sidx] as (number | null)[];
    const xmin = u.scales.x.min ?? -Infinity, xmax = u.scales.x.max ?? Infinity;
    ctx.save();
    ctx.fillStyle = color;
    for (let i = 0; i < xd.length; i++) {
      const xv = xd[i];
      if (xv < xmin || xv > xmax) continue;
      const yv = yd[i];
      if (yv == null) continue;
      ctx.beginPath();
      ctx.arc(u.valToPos(xv, "x", true), u.valToPos(yv, "y", true), radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    return null;
  };
}

/** The field's daily rhythm — RAW search interest (no cube-root) as a SCATTER of points, the model as a smooth
 *  spline, over a REAL date axis. The live readout gives the exact date, searched value, model value and the
 *  per-point error (residual). Falls back to a year axis when no daily start date is supplied. */
export function FitChart({ actual, fit, err, start, step, from, to, label }: {
  actual: number[]; fit: number[]; err?: number[]; start?: number; step?: number; from: string; to: string; label: string;
}) {
  const t = useThemeTokens();
  const timed = !!(start && step);
  const data = useMemo<uPlot.AlignedData>(() => {
    const n = actual.length;
    const xs = timed
      ? actual.map((_, i) => (start as number) + i * (step as number))                 // real unix-second dates
      : actual.map((_, i) => (parseFloat(from) || 0) + (i * ((parseFloat(to) || n - 1) - (parseFloat(from) || 0))) / Math.max(1, n - 1));
    const e = err && err.length === n ? err : actual.map((a, i) => +(a - fit[i]).toFixed(1));
    return [xs, actual, fit, e];
  }, [actual, fit, err, start, step, from, to, timed]);
  const build = useCallback<() => uPlot.Options>(() => {
    const base = baseOpts(t);
    const signed = (v: number | null) => (v == null ? "" : (v > 0 ? "+" : "") + v.toFixed(1));
    return {
      ...base,
      scales: { x: { time: timed } },                                                   // real calendar dates when timed
      series: [
        { label: timed ? "date" : "year", value: timed ? "{WWW} {YYYY}-{MM}-{DD}" : (_u, v) => (v == null ? "" : String(Math.round(v))) },
        // RAW interest → scatter drawn on the canvas (custom paths), points.show:false so uPlot still draws a hover
        // focus-ring on it (you can visually select a point). A line would draw misleading verticals over zero-days.
        { label: "searched", stroke: t.blue, fill: t.blue, paths: scatterPaths(2.4, t.blue), points: { show: false }, value: (_u, v) => (v == null ? "" : v.toFixed(0)) },
        // model → smooth spline
        { label: "model", stroke: t.gold, width: 2, paths: uPlot.paths.spline ? uPlot.paths.spline() : undefined, points: { show: false }, value: (_u, v) => (v == null ? "" : v.toFixed(1)) },
        // per-point error (residual) — not drawn, surfaced in the live readout
        { label: "error", stroke: t.mute, paths: () => null, points: { show: false }, value: (_u, v) => signed(v as number | null) },
      ],
      axes: [
        timed ? { ...base.axes![0] } : { ...base.axes![0], values: (_u, sp) => sp.map((s) => String(Math.round(s as number))) },
        { ...base.axes![1] },
      ],
    } as uPlot.Options;
  }, [t, timed]);
  return <ChartFrame label={label}><UPlotChart data={data} height={230} build={build} /></ChartFrame>;
}

/** In-sample fitting power: median R² (%) vs months of recent data cropped before fitting, with the knee marked. */
export function CropR2Chart({ curve, knee, label }: {
  curve: { months: number; r2_median: number }[]; knee: number; label: string;
}) {
  const t = useThemeTokens();
  const data = useMemo<uPlot.AlignedData>(
    () => [curve.map((c) => c.months), curve.map((c) => c.r2_median * 100)],
    [curve],
  );
  const build = useCallback<() => uPlot.Options>(() => {
    const base = baseOpts(t);
    return {
      ...base,
      series: [
        { label: "months cropped", value: (_u, v) => (v == null ? "" : `${Math.round(v)} mo`) },
        { label: "median R²", stroke: t.gold, width: 2.4, points: { show: true, size: 5, stroke: t.gold, fill: t.gold }, value: (_u, v) => (v == null ? "" : `${v.toFixed(1)}%`) },
      ],
    } as uPlot.Options;
  }, [t]);
  const draw: DrawHook = useCallback((u) => {
    const ctx = u.ctx, { left, top, width, height } = u.bbox;
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    const kx = u.valToPos(knee, "x", true);
    ctx.strokeStyle = t.mute; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(kx, top); ctx.lineTo(kx, top + height); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = t.mute; ctx.font = "11px system-ui";
    ctx.fillText(`knee = ${knee} mo`, Math.min(kx + 5, left + width - 70), top + 12);
    ctx.restore();
  }, [knee, t]);
  return <ChartFrame label={label}><UPlotChart data={data} height={240} build={build} draw={draw} /></ChartFrame>;
}

/** Horizontal bars: each body's % share of the explained variance (first bar gold, rest blue). Hover for detail. */
export function ContribBars({ items, label }: { items: { label: string; pct: number }[]; label: string }) {
  const t = useThemeTokens();
  const max = Math.max(...items.map((i) => i.pct), 1);
  return (
    <div role="img" aria-label={label} className="space-y-1.5">
      {items.map((it, i) => (
        <div
          key={it.label}
          title={`${it.label} — ${it.pct.toFixed(1)}% of the explained variance`}
          className="flex items-center gap-2 rounded px-1 py-0.5 text-[13px] transition-colors hover:bg-space-3/50"
        >
          <span className="w-40 shrink-0 truncate text-ink-2">{it.label}</span>
          <span className="relative h-3 flex-1 overflow-hidden rounded-pill bg-space-3">
            <span className="absolute inset-y-0 left-0 rounded-pill transition-[width]" style={{ width: `${(Math.max(0, it.pct) / max) * 100}%`, background: i === 0 ? t.gold : t.blue }} />
          </span>
          <span className="w-12 shrink-0 text-right font-bold tabular-nums" style={{ color: i === 0 ? t.gold : "var(--color-ink)" }}>{it.pct.toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
}

/** The fitted MODEL's per-body FREQUENCIES f_i — one bar per body (the inverse-width of that body's sinc
 *  term; larger = a narrower, sharper peak). The Sun, the annual term, is highlighted in gold. Mirrors the
 *  ContribBars pattern so it follows the two-colour brand. */
export function FreqBars({ items, label }: { items: { body: string; freq: number }[]; label: string }) {
  const t = useThemeTokens();
  const max = Math.max(...items.map((i) => i.freq), 1e-6);
  return (
    <div role="img" aria-label={label} className="space-y-1.5">
      {items.map((it, i) => (
        <div key={it.body} title={`${it.body} — frequency f = ${it.freq.toFixed(3)}`}
          className="flex items-center gap-2 rounded px-1 py-0.5 text-[13px] transition-colors hover:bg-space-3/50">
          <span className="w-24 shrink-0 truncate text-ink-2">{it.body}</span>
          <span className="relative h-3 flex-1 overflow-hidden rounded-pill bg-space-3">
            <span className="absolute inset-y-0 left-0 rounded-pill transition-[width]" style={{ width: `${(Math.max(0, it.freq) / max) * 100}%`, background: i === 0 ? t.gold : t.blue }} />
          </span>
          <span className="w-12 shrink-0 text-right font-bold tabular-nums" style={{ color: i === 0 ? t.gold : "var(--color-ink)" }}>{it.freq.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

/** The field's SOFT assignment as 12 bars — the area under each of the twelve signs (∫ fit-quality over the sign's
 *  band), the winning sign in gold. Replaces the per-angle tuning curve (operator 2026-06-29: "plot only 12 bars"). */
export function SignBars({ scores, signs, win, label }: { scores: number[]; signs: string[]; win: number; label: string }) {
  const t = useThemeTokens();
  const max = Math.max(...scores, 1e-6);
  return (
    <div role="img" aria-label={label} className="space-y-1.5">
      {scores.map((v, i) => (
        <div key={i} title={`${signs[i]} — ${(v * 100).toFixed(1)}% of the fit-quality area`}
          className="flex items-center gap-2 rounded px-1 py-0.5 text-[13px] transition-colors hover:bg-space-3/50">
          <span className="w-24 shrink-0 truncate text-ink-2">{signs[i]}</span>
          <span className="relative h-3 flex-1 overflow-hidden rounded-pill bg-space-3">
            <span className="absolute inset-y-0 left-0 rounded-pill transition-[width]" style={{ width: `${(Math.max(0, v) / max) * 100}%`, background: i === win ? t.gold : t.blue }} />
          </span>
          <span className="w-12 shrink-0 text-right font-bold tabular-nums" style={{ color: i === win ? t.gold : "var(--color-ink)" }}>{(v * 100).toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
}

/** The PERIOD tuning curve as a horizontal-bar list — one row per candidate period, ascending. F1 is the primary
 *  bar (harmonic mean of fit R² and decisiveness rep); the chosen period (max F1) is highlighted in gold. R² and
 *  rep ride along as context in the trailing readout. Mirrors ContribBars/SignBars so it follows the two-colour brand. */
export function PeriodCurveBars({ curve, chosen, label }: {
  curve: { period: number; r2: number; rep?: number | null; f1: number }[]; chosen?: number; label: string;
}) {
  const t = useThemeTokens();
  const max = Math.max(...curve.map((c) => c.f1), 1e-6);
  // The winning row = the one whose period matches `chosen`, else the max-F1 row (with a tolerance for float drift).
  const winIdx = (() => {
    if (chosen != null) {
      const i = curve.findIndex((c) => Math.abs(c.period - chosen) < 1e-6);
      if (i >= 0) return i;
    }
    let best = 0;
    for (let i = 1; i < curve.length; i++) if (curve[i].f1 > curve[best].f1) best = i;
    return best;
  })();
  return (
    <div role="img" aria-label={label} className="space-y-1.5">
      {curve.map((c, i) => {
        const win = i === winIdx;
        return (
          <div key={i}
            title={`${c.period.toFixed(2)} yr — score ${c.f1.toFixed(2)} (R² ${(c.r2 * 100).toFixed(0)}%${c.rep != null ? `, rep ${c.rep.toFixed(0)}%` : ""})`}
            className="flex items-center gap-2 rounded px-1 py-0.5 text-[13px] transition-colors hover:bg-space-3/50">
            <span className="w-14 shrink-0 text-right tabular-nums text-ink-2">{c.period.toFixed(2)} y</span>
            <span className="relative h-3 flex-1 overflow-hidden rounded-pill bg-space-3">
              <span className="absolute inset-y-0 left-0 rounded-pill transition-[width]" style={{ width: `${(Math.max(0, c.f1) / max) * 100}%`, background: win ? t.gold : t.blue }} />
            </span>
            <span className="w-10 shrink-0 text-right font-bold tabular-nums" style={{ color: win ? t.gold : "var(--color-ink)" }}>{c.f1.toFixed(2)}</span>
            <span className="w-24 shrink-0 text-right tabular-nums text-ink-3/80">R² {(c.r2 * 100).toFixed(0)}%{c.rep != null && <> · rep {c.rep.toFixed(0)}%</>}</span>
          </div>
        );
      })}
    </div>
  );
}

/** A competition topic's predicted-vs-raw series across BOTH regions: raw actuals (blue scatter),
 *  the reference model's TRAIN fit (muted line), and the leader's TEST predictions at their best
 *  shift (gold spline with points). The test window is shaded; null actuals (the still-hidden
 *  private-half test months) simply leave gaps. Mirrors the FitChart pattern. */
export function CompResultsChart({ months, actual, fit, pred, testFrom, label, bandLabel, actualLabel, fitLabel, predLabel }: {
  months: string[]; actual: (number | null)[]; fit: (number | null)[]; pred: (number | null)[]; testFrom: number; label: string;
  // Optional copy so the same chart reads naturally on a topic-analysis page (a fit + a real forecast)
  // as well as on the competition Results tab (a reference fit + the leader's holdout predictions).
  bandLabel?: string; actualLabel?: string; fitLabel?: string; predLabel?: string;
}) {
  const t = useThemeTokens();
  const data = useMemo<uPlot.AlignedData>(() => {
    const xs = months.map((m) => Date.parse(m + "-01T00:00:00Z") / 1000);
    const f = xs.map((_, i) => (i < fit.length ? fit[i] : null));            // train fit → null over test
    const p = xs.map((_, i) => pred[i] ?? null);                             // test preds → null over train
    return [xs, actual.map((v) => (v == null ? null : v)), f, p];
  }, [months, actual, fit, pred]);
  const build = useCallback<() => uPlot.Options>(() => {
    const base = baseOpts(t);
    return {
      ...base,
      scales: { x: { time: true } },
      series: [
        { label: "month", value: "{YYYY}-{MM}" },
        { label: actualLabel ?? "searched", stroke: t.blue, fill: t.blue, paths: scatterPaths(2.4, t.blue), points: { show: false }, value: (_u, v) => (v == null ? "hidden" : v.toFixed(0)) },
        { label: fitLabel ?? "reference fit", stroke: t.mute, width: 1.6, paths: uPlot.paths.spline ? uPlot.paths.spline() : undefined, points: { show: false }, value: (_u, v) => (v == null ? "" : v.toFixed(1)) },
        { label: predLabel ?? "winner predicts", stroke: t.gold, width: 2.2, paths: uPlot.paths.spline ? uPlot.paths.spline() : undefined, points: { show: true, size: 6, stroke: t.gold, fill: t.gold }, value: (_u, v) => (v == null ? "" : v.toFixed(1)) },
      ],
    } as uPlot.Options;
  }, [t, actualLabel, fitLabel, predLabel]);
  const draw: DrawHook = useCallback((u) => {
    const xs = u.data[0] as number[];
    if (!xs.length || testFrom <= 0 || testFrom >= xs.length) return;
    const ctx = u.ctx, { left, top, width, height } = u.bbox;
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    // Shade the FUTURE window (the last 12 months) + its boundary.
    const bx = u.valToPos(xs[testFrom], "x", true);
    ctx.globalAlpha = 0.08; ctx.fillStyle = t.gold; ctx.fillRect(bx, top, left + width - bx, height); ctx.globalAlpha = 1;
    ctx.strokeStyle = t.line; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(bx, top); ctx.lineTo(bx, top + height); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = t.mute; ctx.font = "11px system-ui";
    ctx.fillText(bandLabel ?? "test — the future", Math.min(bx + 5, left + width - 100), top + 12);
    ctx.restore();
  }, [testFrom, t, bandLabel]);
  return <ChartFrame label={label}><UPlotChart data={data} height={240} build={build} draw={draw} /></ChartFrame>;
}

/** Wraps an interactive chart with the standard "drag to zoom · double-click to reset" affordance hint. */
function ChartFrame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <figure className="m-0" aria-label={label}>
      {children}
      <figcaption className="mt-1 select-none text-right text-[10px] text-ink-2">drag to zoom · double-click to reset · scroll to zoom</figcaption>
    </figure>
  );
}
