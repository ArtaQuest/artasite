import { useMemo } from "react";
import uPlot from "uplot";
import { UPlotChart, baseOpts, theme, withAlpha } from "../UPlotChart";
import type { PlotSpec } from "./plot";

/** Draws a validated PlotSpec. Validation lives in ./plot — see the note there. */
export default function ChatPlot({ spec }: { spec: PlotSpec }) {
  const t = theme();
  const data = useMemo(
    () => [spec.x as number[], ...spec.series.map((s) => s.y)] as unknown as uPlot.AlignedData,
    [spec],
  );
  // Memoised: UPlotChart keys a full rebuild off this function's identity, so an inline arrow would
  // tear down and re-create the chart on every render of the message list.
  const build = useMemo(() => {
    const base = baseOpts(t);
    return () => ({
      ...base,
      // Gold then blue, alternating. Never a third hue — the brand is two colours, and a chart
      // inside a message is not the place to introduce one.
      series: [
        {},
        ...spec.series.map((sr, i) => {
          const stroke = i % 2 === 0 ? t.gold : t.blue;
          return {
            label: sr.label || `series ${i + 1}`,
            stroke,
            fill: spec.series.length === 1 ? withAlpha(stroke, 0.12) : undefined,
            width: 1.6,
            // A gap where the sender sent a non-number, rather than a line drawn through nothing.
            spanGaps: false,
          };
        }),
      ],
    }) as uPlot.Options;
  }, [spec, t]);

  return (
    <span className="mt-1.5 block overflow-hidden rounded-card border border-line bg-space-1 first:mt-0">
      {spec.title ? (
        <span className="block border-b border-line px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">
          {spec.title}
        </span>
      ) : null}
      {/* baseOpts already carries the value-reading cursor and drag-x zoom, and UPlotChart adds
          wheel zoom — so "interactive" here is the shared chart behaviour the research pages use,
          not a second implementation of it. */}
      <span className="block px-1 py-1">
        <UPlotChart data={data} height={180} build={build} />
      </span>
    </span>
  );
}
