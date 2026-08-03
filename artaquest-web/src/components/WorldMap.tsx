import { useEffect, useState, type ReactNode } from "react";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import type { DistCountry } from "../lib/wp";
import { atlasId } from "../lib/iso";
import { formatCoins } from "../lib/currency";
import { loadWorldGeos, type AtlasFeature } from "../lib/geo";

const EMPTY_SET = new Set<string>();
const W = 880, H = 430;

/* Generic Natural-Earth choropleth shared by every world map (donation reach, coin value, …).
   Loads the self-hosted atlas once, builds the projection + path, and renders one <path> per
   country with caller-supplied fill / stroke / aria-label / tooltip. Manages the hover and
   keyboard-focus tooltip (WCAG 2.4.7) and click / Enter / Space selection. Domain logic
   (choropleth maths, selection) lives in the thin wrappers; this component is purely
   presentational, so both maps share one projection/path/tooltip/loading implementation. */
export function GeoMap<T>({ byId, fillFor, strokeFor, countryLabel, onSelect, ariaLabel, renderTooltip }: {
  byId: Map<number, T>;
  fillFor: (d: T | undefined) => string;
  strokeFor?: (d: T | undefined) => { stroke: string; width: number };
  countryLabel?: (d: T) => string;
  onSelect?: (d: T) => void;
  ariaLabel: string;
  renderTooltip: (d: T) => ReactNode;
}) {
  const [geos, setGeos] = useState<AtlasFeature[] | null>(null);
  const [hover, setHover] = useState<{ d: T; x: number; y: number } | null>(null);

  useEffect(() => {
    let alive = true;
    loadWorldGeos().then((f) => { if (alive) setGeos(f); }).catch(() => setGeos([]));
    return () => { alive = false; };
  }, []);

  if (!geos) return <div className="grid h-[300px] place-items-center rounded-card border border-line bg-space-2 text-[14px] text-ink-3">Loading world map…</div>;

  const proj = geoNaturalEarth1().fitSize([W, H], { type: "FeatureCollection", features: geos } as never);
  const path = geoPath(proj);
  const interactive = !!onSelect;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={ariaLabel}>
        {geos.map((g, i) => {
          const d = byId.get(Number(g.id ?? -1));
          const s = strokeFor ? strokeFor(d) : { stroke: "var(--color-space-1)", width: 0.5 };
          return (
            <path
              key={i} d={path(g as never) || ""} fill={fillFor(d)} stroke={s.stroke} strokeWidth={s.width}
              className={d && interactive ? "cursor-pointer outline-none" : "outline-none"}
              tabIndex={d && interactive ? 0 : -1}
              aria-label={d && countryLabel ? countryLabel(d) : undefined}
              onMouseMove={(e) => {
                if (!d) return;
                const host = (e.currentTarget.ownerSVGElement?.parentElement as HTMLElement | null)?.getBoundingClientRect();
                setHover({ d, x: host ? e.clientX - host.left : 0, y: host ? e.clientY - host.top : 0 });
              }}
              onMouseLeave={() => setHover(null)}
              onFocus={(e) => {
                // Keyboard focus shows the same tooltip as hover (WCAG 2.4.7), positioned at the
                // focused country's box centre since there's no pointer coordinate.
                if (!d) return;
                const host = (e.currentTarget.ownerSVGElement?.parentElement as HTMLElement | null)?.getBoundingClientRect();
                const box = e.currentTarget.getBoundingClientRect();
                setHover({ d, x: host ? box.left + box.width / 2 - host.left : 0, y: host ? box.top - host.top : 0 });
              }}
              onBlur={() => setHover(null)}
              onClick={() => { if (d && onSelect) onSelect(d); }}
              onKeyDown={(e) => { if (d && onSelect && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelect(d); } }}
            />
          );
        })}
      </svg>
      {hover && (
        <div className="pointer-events-none absolute z-10 w-56 rounded-card border border-line bg-space-1/95 p-3 text-[13px] shadow-2xl backdrop-blur-sm"
          style={{ left: Math.min(hover.x + 14, W - 30), top: hover.y + 14 }}>
          {renderTooltip(hover.d)}
        </div>
      )}
    </div>
  );
}

/* Choropleth of donation reach by country, in Arta Coins. Hover/focus → tooltip with %/coins held
   for that country. Click a country to direct your donation there. */
export function WorldMap({ data, selected, onToggle }: {
  data: DistCountry[]; currency?: string; selected?: Set<string>; onToggle?: (code: string) => void;
}) {
  const sel = selected ?? EMPTY_SET;
  const allMode = sel.size === 0;
  const max = Math.max(1, ...data.map((d) => d.amount));
  const byId = new Map(data.map((d) => [atlasId(d), d]));
  return (
    <GeoMap<DistCountry>
      byId={byId}
      ariaLabel="World map of donation reach by country"
      fillFor={(d) => {
        if (!d) return "var(--color-space-3)";
        const t = d.amount / max;
        const a = allMode || sel.has(d.code) ? 0.3 + 0.6 * t : 0.12;
        return `rgba(232,185,35,${a.toFixed(2)})`;
      }}
      strokeFor={(d) => {
        const isSel = !!d && (allMode || sel.has(d.code));
        return { stroke: isSel ? "#4A72FF" : "var(--color-space-1)", width: isSel ? 1.2 : 0.4 };
      }}
      countryLabel={(d) => `${d.label}: ${d.pct}% , ${formatCoins(d.amount)}`}
      onSelect={onToggle ? (d) => onToggle(d.code) : undefined}
      renderTooltip={(d) => (
        <>
          <p className="font-bold text-ink">{d.label}</p>
          <p className="mt-0.5 text-[12px] text-ink-3">{d.pct}% of reach · <span className="font-semibold text-yang"><bdi dir="ltr" data-ay-skip="1">{formatCoins(d.amount)}</bdi></span></p>
          <p className="mt-2 border-t border-line pt-2 text-[12px] text-ink-2">Gold-backed coins held for learners here.</p>
        </>
      )}
    />
  );
}
