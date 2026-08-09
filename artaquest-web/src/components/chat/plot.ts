/**
 * The plot SPEC and its validator — plain functions, deliberately NOT in ChatPlot.tsx.
 *
 * A file that exports both a component and utilities breaks React Fast Refresh (and the lint rule
 * that guards it), which is the same reason fence.ts sits beside MessageBody.tsx.
 *
 * An interactive plot inside a message is written as DATA, never as code.
 *
 * THE CONSTRAINT THIS IS BUILT AROUND. MessageBody is explicitly not a Markdown renderer: message
 * text comes from the other party, so every feature is an attack surface, and it allows no links,
 * no images, no HTML. A plot that arrived as Plotly HTML or a `<script>` would hand that away for a
 * chart, on a platform whose whole promise is that a sealed message is only ever read.
 *
 * So a plot is a JSON spec and nothing else. It is JSON.parse'd, every field is validated and
 * coerced, and the numbers are handed to uPlot — which is already how the research pages draw. No
 * eval, no HTML, no fetch, no <script>, no remote data: a spec cannot name a URL, so a message
 * cannot make the reader's browser call anywhere. The only thing a sender controls is numbers and
 * short labels, and labels are rendered as text nodes by React.
 *
 * INTERACTIVE means uPlot's own cursor: hover to read exact values off the series, drag across the
 * x-axis to zoom into a range, double-click to reset. That is the part a static PNG of a chart
 * cannot do, and it is why sending one here beats sending a screenshot of one.
 *
 *   ```plot
 *   { "title": "loss", "x": [1,2,3], "series": [{ "label": "train", "y": [3,2,1] }] }
 *   ```
 *
 * BOUNDED ON PURPOSE. A message is untrusted input, so a spec that asks for a million points or
 * five hundred series is refused rather than rendered: the cost of drawing it lands on the reader's
 * tab, and "my chat froze" is a denial of service like any other. Over the limits it falls back to
 * showing the source as an ordinary code block, which is also what happens to malformed JSON —
 * never a blank space, never a thrown error inside someone's conversation.
 */

const MAX_SERIES = 8;
const MAX_POINTS = 5000;

export type PlotSpec = {
  title?: string;
  x?: number[];
  xLabel?: string;
  yLabel?: string;
  series: { label?: string; y: number[] }[];
};

/** Coerce one untrusted value to a finite number, or null. NaN/Infinity/strings/objects all fail —
 *  uPlot treats null as a gap, which is the honest rendering of "the sender sent nonsense here". */
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Validate an unknown parsed JSON value into a PlotSpec, or null if it is not one.
 * Returns null rather than throwing, and rather than repairing: a half-understood spec drawn
 * confidently is worse than the source shown as text.
 */
export function parsePlot(src: string): PlotSpec | null {
  let raw: unknown;
  try { raw = JSON.parse(src); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const rawSeries = Array.isArray(o.series) ? o.series : null;
  if (!rawSeries || !rawSeries.length || rawSeries.length > MAX_SERIES) return null;

  const series: PlotSpec["series"] = [];
  for (const s of rawSeries) {
    if (!s || typeof s !== "object" || Array.isArray(s)) return null;
    const so = s as Record<string, unknown>;
    if (!Array.isArray(so.y) || !so.y.length || so.y.length > MAX_POINTS) return null;
    series.push({
      // Labels are text: they reach React as a string child, never as markup. Length-capped so a
      // legend cannot be used as a wall of text.
      label: typeof so.label === "string" ? so.label.slice(0, 60) : undefined,
      y: so.y.map(num) as number[],
    });
  }
  // Every series shares one x axis, so they must agree on length — mismatched lengths are a spec
  // that means nothing rather than one to guess at.
  const n = series[0].y.length;
  if (series.some((s) => s.y.length !== n)) return null;

  let x: number[];
  if (Array.isArray(o.x)) {
    if (o.x.length !== n) return null;
    const xs = o.x.map(num);
    if (xs.some((v) => v === null)) return null; // an x axis with holes has no meaning
    x = xs as number[];
  } else {
    x = Array.from({ length: n }, (_, i) => i); // no x given: index it
  }

  return {
    title: typeof o.title === "string" ? o.title.slice(0, 90) : undefined,
    xLabel: typeof o.xLabel === "string" ? o.xLabel.slice(0, 40) : undefined,
    yLabel: typeof o.yLabel === "string" ? o.yLabel.slice(0, 40) : undefined,
    x,
    series,
  };
}

