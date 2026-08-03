/* Thin React wrapper around uPlot — interactive, zoomable, brand-themed line charts.
 *   • drag horizontally to zoom into a range · double-click to reset · scroll-wheel to zoom under the cursor
 *   • a hover crosshair + legend reads off the exact values
 * Colours are pulled live from the design tokens (getComputedStyle) so the chart follows the day/night theme.
 * uPlot is canvas (fast for thousands of points) with a tiny DOM legend; we theme the legend in index.css. */
import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export type DrawHook = (u: uPlot) => void;

const tok = (name: string, fallback: string) =>
  (typeof document !== "undefined" &&
    getComputedStyle(document.documentElement).getPropertyValue(name).trim()) || fallback;

export const theme = () => ({
  gold: tok("--color-yang", "#E8B923"),
  blue: tok("--color-yin-ink", "#9cb6ff"),   // brand blue as UI/data ink — same token as text/links, so charts + SignBars match the rest of the UI (yin-ink = #9cb6ff dark / #1746dc light). NOT yin-light (#4a72ff), which clashed.
  ink: tok("--color-ink", "#e8eef5"),
  mute: tok("--color-ink-3", "#7d93ac"),
  line: tok("--color-line", "#22364a"),
});

/** Re-render counter that bumps whenever the contrast/theme changes (applyContrast dispatches
 *  "aq:contrast"). Canvas charts read CSS tokens into JS, so they must re-read + redraw on change —
 *  CSS alone can't reach a <canvas>. */
export function useContrastVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const bump = () => setV((x) => x + 1);
    window.addEventListener("aq:contrast", bump);
    return () => window.removeEventListener("aq:contrast", bump);
  }, []);
  return v;
}

/** theme() tokens that re-read on every contrast/theme change, so uPlot charts rescale live. */
export function useThemeTokens() {
  const v = useContrastVersion(); // bumps on contrast/theme change → re-read tokens
  // eslint-disable-next-line react-hooks/exhaustive-deps -- v is the intentional cache-buster
  return useMemo(() => theme(), [v]);
}

/** Resolve a token hex to an rgba() string for canvas use (uPlot can't consume a CSS var()). */
export const withAlpha = (hex: string, a: number): string => {
  const h = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return hex;
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
};

/** Scroll-wheel zoom centred on the cursor, CLAMPED to the full data range so zooming out can never reveal
 *  empty space beyond the series — it just expands back to the full extent (drag-zoom + dblclick-reset are
 *  built into uPlot). */
function wheelZoom(factor = 0.8) {
  return {
    hooks: {
      ready: [(u: uPlot) => {
        const over = u.over;
        over.addEventListener("wheel", (e: WheelEvent) => {
          e.preventDefault();
          const rect = over.getBoundingClientRect();
          const xs = u.data[0] as number[];
          const dataMin = xs[0], dataMax = xs[xs.length - 1];
          const cur = u.posToVal(e.clientX - rect.left, "x");
          const min = u.scales.x.min ?? dataMin;
          const max = u.scales.x.max ?? dataMax;
          const f = e.deltaY < 0 ? factor : 1 / factor;
          // expand/contract around the cursor, then clamp to the data extent (never past it)
          const nMin = Math.max(dataMin, cur - (cur - min) * f);
          const nMax = Math.min(dataMax, cur + (max - cur) * f);
          if (nMax > nMin) u.setScale("x", { min: nMin, max: nMax });
        }, { passive: false });
      }],
    },
  } as unknown as uPlot.Plugin;
}

export function UPlotChart({ data, height, build, draw }: {
  data: uPlot.AlignedData;
  height: number;
  build: () => uPlot.Options;       // memoised by the caller — identity controls full rebuilds
  draw?: DrawHook;                  // extra canvas painting (bands, marker lines) after the series
}) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const opts = useMemo(build, [build]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const o: uPlot.Options = {
      ...opts,
      width: el.clientWidth || 640,
      height,
      plugins: [...(opts.plugins ?? []), wheelZoom()],
      hooks: { ...(opts.hooks ?? {}), draw: [...(opts.hooks?.draw ?? []), ...(draw ? [draw] : [])] },
    };
    plot.current = new uPlot(o, data, el);
    const ro = new ResizeObserver(() => {
      if (plot.current && el.clientWidth) plot.current.setSize({ width: el.clientWidth, height });
    });
    ro.observe(el);
    return () => { ro.disconnect(); plot.current?.destroy(); plot.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts, height, draw]);

  useEffect(() => { plot.current?.setData(data); }, [data]);

  return <div ref={host} className="uplot-aq w-full" />;
}

/** Shared base options: dark/brand axes, no title, a value-reading cursor, drag-x zoom. */
export function baseOpts(t: ReturnType<typeof theme>): Partial<uPlot.Options> {
  return {
    // The cursor's vertical bar PINPOINTS + HIGHLIGHTS where it crosses each series: a filled dot in the series'
    // colour (blue=searched, gold=model) with a white outline, at every crossing. The readout-only "error" series
    // (index ≥3) opts out so no stray dot is drawn.
    cursor: {
      y: false,
      drag: { x: true, y: false },
      points: {
        show: (_u: uPlot, sidx: number) => sidx < 3,
        size: 10,
        width: 2,
        stroke: () => "#fff",
        fill: (_u: uPlot, sidx: number) => (sidx === 2 ? t.gold : t.blue),
      } as unknown as uPlot.Cursor.Points,
    },
    legend: { live: true },
    scales: { x: { time: false } },
    axes: [
      { stroke: t.mute, grid: { stroke: t.line, width: 1 }, ticks: { stroke: t.line, width: 1 },
        font: "11px system-ui", size: 30 },
      { stroke: t.mute, grid: { stroke: t.line, width: 1 }, ticks: { stroke: t.line, width: 1 },
        font: "11px system-ui", size: 42 },
    ],
  };
}
