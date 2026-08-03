// A small, on-brand area+line chart for a Google-Trends interest series (0-100 monthly
// values, 2004→now). Gold (yang) fill — search interest is the warmth/"why" of a topic.
// Used full-size on the /why cycle pages (empirical proof) and as a sparkline in Studio.
type Props = {
  series: number[];
  height?: number;
  from?: string; // left-edge label, e.g. "2004"
  to?: string; // right-edge label, e.g. "now"
  showAxis?: boolean; // year labels + baseline
  className?: string;
  label?: string; // a11y description
};

export default function TrendChart({ series, height = 120, from, to, showAxis = false, className, label }: Props) {
  if (!series || series.length < 2) return null;
  const W = 600, H = height, pad = 3;
  const n = series.length;
  const max = Math.max(...series, 1);
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const line = series.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  const peakI = series.indexOf(max);

  return (
    <figure className={className}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label || "Search interest over time"} style={{ width: "100%", height, display: "block" }}>
        <defs>
          <linearGradient id="aqTrendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#E8B923" stopOpacity="0.34" />
            <stop offset="100%" stopColor="#E8B923" stopOpacity="0" />
          </linearGradient>
        </defs>
        {showAxis && <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="currentColor" strokeOpacity="0.18" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
        <path d={area} fill="url(#aqTrendFill)" />
        <path d={line} fill="none" stroke="#E8B923" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <circle cx={x(peakI)} cy={y(max)} r="2.5" fill="#E8B923" />
      </svg>
      {showAxis && (from || to) && (
        <figcaption className="mt-1 flex justify-between text-[11px] font-medium text-ink-2">
          <span>{from}</span>
          <span>{to}</span>
        </figcaption>
      )}
    </figure>
  );
}
