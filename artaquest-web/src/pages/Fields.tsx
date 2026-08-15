import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SeasonsApi, type Discipline } from "../lib/api";
import { CATEGORY_GROUPS } from "../lib/typology-meta";
import { SEASONS, type Season, currentSeason, seasonByN, seasonForDate, seasonForPhase, seasonSpan } from "../lib/seasons";
import { mySeason } from "../components/seasons";
import { Card } from "../components/ui";
import researchData from "../data/research.json";
import { localePath, isLoggedIn } from "../lib/wp";
import { resonanceTitle } from "../lib/resonance";

// The full topic-500-winner analysis for a field, keyed identically to the disciplines registry.
const ANALYSIS: Record<string, any> = Object.fromEntries((researchData.topics as any[]).map((t) => [t.key, t]));
// The shared yearly time axis (per-field: its own start … 2055, one point per calendar year) for the
// fit+forecast plot; each chunk's actual+forecast align to it.
// A topic's SEASON: from its fitted peak phase in research.json, falling back to the backend
// discipline house slot. The house list opens at the 14 Apr span, which is cycle position n=9
// (the Queen season opens 17 Aug) — hence the +8 rotation, mirroring seasonForPhase.
const SIGN_NAMES = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"];
const signOfN = (n: number): string => SIGN_NAMES[(n + 3) % 12];
const SIGN2 = ["Ar", "Ta", "Ge", "Ca", "Le", "Vi", "Li", "Sc", "Sa", "Cp", "Aq", "Pi"];
const sign2OfN = (n: number): string => SIGN2[(n + 3) % 12];
const HOUSE_TO_N: Record<string, number> = Object.fromEntries(CATEGORY_GROUPS.map((g, i) => [g.key, ((i + 8) % 12) + 1]));
const topicSeason = (key: string, fallbackHouse: string): Season =>
  seasonForPhase(ANALYSIS[key]?.sign) || seasonByN(HOUSE_TO_N[fallbackHouse]) || SEASONS[0];
// A topic's fit quality (R², 0…1) — the cycle ranks every season's topics by it.
const r2Of = (d: Discipline): number => (typeof ANALYSIS[d.key]?.r2 === "number" ? ANALYSIS[d.key].r2 : (d.score || 0) / 100);

// CITATIONS PIVOT (operator 2026-07-23): the atlas IS the list — every OpenAlex subfield fitted on
// its per-year share of all citations RECEIVED (mid-year sky sampling). No backend registry.
const ALL_FIELDS: Discipline[] = (researchData.topics as any[])
  .map((t) => ({ key: t.key, house: "", label: t.label, sign: t.sign, score: (t.r2 ?? 0) * 100, central: 0 }));

type AxisCfg = { axis: "house" | "topic"; title: string; noun: string; blurb: string; base: string };
export const SKILLS_CFG: AxisCfg = {
  axis: "topic", title: "Topics", noun: "topic", base: "/topics",
  blurb: "Every OpenAlex research subfield, measured as its share of the citations the whole scholarly record received each year, the sky sampled at each year's mid-point — each field modelled on its own, over its own history since it emerged — placed in the sidereal sign its Pluto tuning falls in (Lahiri dates), ranked by model fit. Follow one sign: its topics are what we recommend you.",
};

/* ── The cycle ──────────────────────────────────────────────────────────────────────────────
   The year drawn as a SINUSOID (operator 2026-07-10 — never a wheel): one full cosine period
   from Queen to Queen. The curve PEAKS at the Q season (the cycle opens at the height of the sun, 17 Aug),
   descends to its trough at midwinter (rank 6, Lens), and climbs back to the next Queen. Each season is a
   band under the curve labelled by its sidereal sign; hovering or picking a band opens the sign
   panel with the full, scrollable, R²-ranked topic list. */
const CY = { w: 960, h: 338, x0: 40, x1: 920, mid: 148, amp: 78, axis: 248 };
const bandX = (i: number): number => CY.x0 + ((CY.x1 - CY.x0) * i) / 12;
const curveY = (t: number): number => CY.mid - CY.amp * Math.cos(2 * Math.PI * t);
const curvePath = (t0: number, t1: number, steps = 64): string => {
  let d = "";
  for (let k = 0; k <= steps; k++) {
    const t = t0 + ((t1 - t0) * k) / steps;
    d += `${k ? "L" : "M"}${(CY.x0 + (CY.x1 - CY.x0) * t).toFixed(1)} ${curveY(t).toFixed(1)}`;
  }
  return d;
};
/** Today's position along the cycle year (0 at the Queen boundary, 1 at the next). */
const nowT = (): number => {
  const today = new Date();
  const cur = seasonForDate(today);
  const i = cur.n - 1;
  const yr = today.getFullYear();
  const openTs = new Date(yr, cur.from[0] - 1, cur.from[1]).getTime();
  const open = openTs > today.getTime() ? new Date(yr - 1, cur.from[0] - 1, cur.from[1]).getTime() : openTs;
  const next = SEASONS[cur.n % 12];
  let close = new Date(new Date(open).getFullYear(), next.from[0] - 1, next.from[1]).getTime();
  if (close <= open) close = new Date(new Date(open).getFullYear() + 1, next.from[0] - 1, next.from[1]).getTime();
  return (i + Math.min(1, Math.max(0, (today.getTime() - open) / (close - open)))) / 12;
};

function SeasonCycle({ bySeason, sel, onSel, mineN, nowN }: {
  bySeason: Record<number, Discipline[]>; sel: number; onSel: (n: number) => void; mineN: number | null; nowN: number;
}) {
  const tNow = nowT();
  const nowX = CY.x0 + (CY.x1 - CY.x0) * tNow;
  const nowY = curveY(tNow);
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${CY.w} ${CY.h}`} className="mx-auto block w-full min-w-[720px]" role="listbox" aria-label="The cycle of the twelve seasons">
        <defs>
          {/* The dual (adaptive) tone: gold→blue — exact complements, neutral at the midpoint. */}
          <linearGradient id="aqToneDual" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--color-yang-ink)" /><stop offset="1" stopColor="var(--color-yin-ink)" />
          </linearGradient>
        </defs>
        {/* Season bands. */}
        {SEASONS.map((s, i) => {
          const x = bandX(i), xw = bandX(i + 1) - x;
          const active = sel === s.n;
          const tops = (bySeason[s.n] || []).length;
          const tMid = (i + 0.5) / 12;
          const my = curveY(tMid);
          return (
            <g key={s.n} role="option" aria-selected={active} tabIndex={0} className="cursor-pointer outline-none"
              onClick={() => onSel(s.n)} onMouseEnter={() => onSel(s.n)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSel(s.n); } }}
              aria-label={`${signOfN(s.n)}, ${tops} topics`}>
              <rect x={x} y={16} width={xw} height={CY.axis - 16}
                fill={s.n === nowN ? "var(--color-yang)" : "var(--color-yin)"}
                fillOpacity={active ? (s.n === nowN ? 0.2 : 0.14) : s.n === nowN ? 0.1 : i % 2 ? 0.04 : 0.08}
                stroke={active ? "var(--color-yang)" : "var(--aq-line, #223)"} strokeWidth={active ? 1.5 : 0.75} />
              {/* The season's point on the curve. */}
              <circle cx={x + xw / 2} cy={my} r={active ? 5 : 3.5} fill={active || s.n === nowN ? "var(--color-yang)" : "var(--color-yin)"} />
              <text x={x + xw / 2} y={CY.axis + 22} textAnchor="middle" fontSize="11.5" fontWeight="700" fill="currentColor" opacity=".9">{sign2OfN(s.n)}</text>
              <text x={x + xw / 2} y={CY.axis + 36} textAnchor="middle" fontSize="9" fill="currentColor" opacity=".6">{tops} topics{mineN === s.n ? " · yours" : ""}</text>
              {/* Boundary date tick. */}
              <text x={x} y={CY.axis + 10} textAnchor="middle" fontSize="9.5" fill="currentColor" opacity=".65">{s.from[1]}/{s.from[0]}</text>
            </g>
          );
        })}
        {/* Axis + the sinusoid (dashed tails hint that the cycle never ends). */}
        <line x1={CY.x0} y1={CY.axis} x2={CY.x1} y2={CY.axis} stroke="var(--aq-line, #223)" strokeWidth="1" />
        <path d={curvePath(-0.06, 0)} fill="none" stroke="var(--color-yang)" strokeWidth="2" strokeDasharray="2 5" opacity=".5" />
        <path d={curvePath(0, 1)} fill="none" stroke="var(--color-yang)" strokeWidth="2.25" strokeLinecap="round" />
        <path d={curvePath(1, 1.06)} fill="none" stroke="var(--color-yang)" strokeWidth="2" strokeDasharray="2 5" opacity=".5" />
        {/* Now — today's exact position on the cycle. */}
        <line x1={nowX} y1={20} x2={nowX} y2={CY.axis} stroke="var(--color-yang)" strokeWidth="1" strokeDasharray="3 4" opacity=".7" />
        <circle cx={nowX} cy={nowY} r="5" fill="var(--color-yang)" stroke="var(--color-space-1, #010C17)" strokeWidth="1.5" />
        <text x={nowX} y={14} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--color-yang-ink)">now</text>
      </svg>
      <p className="mt-2 text-center text-[12.5px] text-ink-3">
        the Sun crosses one sign a month — the year is their full circle ·{" "}
        <a href={localePath("/animations/")} className="text-yin-ink underline decoration-dotted hover:text-yang-ink">watch the research animation</a>
      </p>
    </div>
  );
}

/* The atlas, reframed — every learning topic in its season on the year's cycle. Every chip
   links to that field's ANALYSIS PAGE (<base>/?field=<key>): its 326-year citations-received
   share rhythm over the field's own history, one point per year (the curve the model fit) + the fit quality that places it. */
const PLANETS = ["mars", "jupiter", "saturn", "uranus", "neptune", "pluto", "node"];  // 7 bodies (mars in; sun/mercury/venus + chiron excluded)

function PlanetView({ planet, cfg }: { planet: string; cfg: AxisCfg }) {
  const rows = (researchData.topics as any[])
    .filter((t) => t.dominantPlanet === planet)
    .sort((x, y) => (y.domShare || 0) - (x.domShare || 0));
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
      <a href={localePath(cfg.base + "/")} className="mb-5 inline-flex text-[13px] text-ink-3 hover:text-yin-light">← {cfg.title}</a>
      <h1 className="text-2xl font-bold capitalize tracking-tight sm:text-3xl">{planet}</h1>
      <p className="mt-1 text-[13px] text-ink-3">The {rows.length} topics whose longest arrow is {planet} — the body that explains most of their rhythm.</p>
      <div className="mt-4 space-y-1.5">
        {rows.map((t) => (
          <a key={t.key} href={`${localePath(cfg.base + "/")}?field=${encodeURIComponent(t.key)}`}
             className="flex items-center justify-between gap-3 rounded-card border border-line bg-space-2 px-3 py-2 text-[14px] transition-colors hover:border-yin-light">
            <span className="min-w-0 flex-1 truncate text-ink-2">{t.label}</span>
            <span className="shrink-0 text-[12px] text-ink-3">{t.phaseSign}</span>
            <span className="w-12 shrink-0 text-end text-[12px] tabular-nums text-ink-3">{Math.round((t.domShare || 0) * 100)}%</span>
          </a>
        ))}
      </div>
      <p className="mt-3 text-[12px] text-ink-3">Share = that planet&rsquo;s arrow as a fraction of the topic&rsquo;s seven.</p>
    </div>
  );
}

/* The GENERAL methodology — shown ONCE on the topics index (operator 2026-07-22); topic pages link here. */
/** ARTATREND — choose any field and read the model's thirty-year forecast, year by year.
 *  The curve is produced by the deployed receiver: each year's value is the rectified square of the
 *  seven planets' projections onto that field's own tunings, so the forecast is a pure function of the
 *  sky and extends as far as the ephemeris does. */
function TrendView({ cfg, initial }: { cfg: AxisCfg; initial: string }) {
  const [key, setKey] = useState<string>(initial || ALL_FIELDS[0]?.key || "");
  const [daily, setDaily] = useState<DailySeries | null>(null);
  const [loading, setLoading] = useState(false);
  const field = useMemo(() => ALL_FIELDS.find((d) => d.key === key) || null, [key]);
  useEffect(() => {
    if (!key) return;
    setDaily(null); setLoading(true);
    import(`../data/field-daily/${key}.json`)
      .then((m) => setDaily((m.default as DailySeries) || null))
      .catch(() => setDaily(null))
      .finally(() => setLoading(false));
  }, [key]);

  const rows = useMemo(() => {
    if (!daily?.pred) return [];
    const from = Number(daily.from);
    const lastData = from + (daily.actual?.length ?? 0) - 1;      // final observed year
    return daily.pred
      .map((v, i) => ({ year: from + i, v }))
      .filter((r) => r.year > lastData);                          // the forecast tail only
  }, [daily]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
      <a href={localePath(cfg.base + "/")} className="mb-5 inline-flex text-[13px] text-ink-3 hover:text-yin-light">← {cfg.title}</a>
      <header className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">ArtaTrend</h1>
        <p className="mt-1 text-[13px] text-ink-3">Pick a field and read its next thirty years — rolled forward from the sky alone.</p>
      </header>

      <Card className="p-4 sm:p-6">
        <label className="text-[12px] font-semibold uppercase tracking-[0.1em] text-ink-3" htmlFor="aq-trend-pick">Field</label>
        <select id="aq-trend-pick" value={key} onChange={(e) => setKey(e.target.value)}
          className="mt-1 w-full rounded-card border border-line bg-space-2 px-3 py-2 text-[14px] text-ink">
          {ALL_FIELDS.slice().sort((a, b) => (a.label || "").localeCompare(b.label || ""))
            .map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select>
        {field && <p className="mt-2 text-[12px] text-ink-3">Sign · {ANALYSIS[field.key]?.phaseSign || "—"}</p>}
      </Card>

      {loading && <p className="mt-4 text-[13px] text-ink-3">Rolling the forecast…</p>}

      {daily?.pred && rows.length > 0 && (() => {
        const from = Number(daily.from);
        const act = daily.actual || [];
        const hist = act.map((v, i) => ({ year: from + i, v })).slice(-40);   // recent history for context
        // The model's own curve is CONTINUOUS across the join: `pred` covers the observed years too,
        // so we draw it solid where it was fitted and dashed where it forecasts. Drawing only the
        // forecast leaves a visible step at the wall — the model's fitted value in the last observed
        // year is not the observation itself, and pretending otherwise would be the wrong fix.
        const i0 = hist.length ? hist[0].year - from : 0;                 // first displayed index
        const fitWin = (daily.pred || []).slice(i0, i0 + hist.length);    // model over the shown history
        const all = [...hist.map((r) => r.v), ...fitWin, ...rows.map((r) => r.v)];
        const W = 640, Hh = 200, padT = 10, padB = 22;
        const hi = Math.max(...all), lo = Math.min(...all);
        const pad = Math.max((hi - lo) * 0.07, 1e-9);
        const y0 = Math.max(0, lo - pad), rng = hi + pad - y0;
        const xs = hist.length + rows.length;
        const xOf = (i: number) => (i * W) / (xs - 1);
        const yOf = (v: number) => padT + (1 - (v - y0) / rng) * (Hh - padT - padB);
        const path = (vals: number[], off: number) =>
          vals.map((v, i) => `${i === 0 ? "M" : "L"}${xOf(off + i).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
        return (
          <Card className="mt-4 p-4 sm:p-6">
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">The next thirty years</h2>
            <svg viewBox={`0 0 ${W} ${Hh}`} className="w-full" role="img"
                 aria-label={`Recent history and the thirty-year forecast for ${field?.label || "this field"}`}>
              <rect x={xOf(hist.length - 1)} y={0} width={W - xOf(hist.length - 1)} height={Hh} fill="var(--color-yin)" opacity="0.07" />
              <line x1={xOf(hist.length - 1)} y1={0} x2={xOf(hist.length - 1)} y2={Hh} stroke="var(--color-yin-ink, #1746DC)" strokeWidth="1" opacity="0.35" />
              <path d={path(hist.map((r) => r.v), 0)} fill="none" stroke="var(--color-yin-ink, #1746DC)" strokeWidth="1.6" opacity="0.9" />
              <path d={path(fitWin, 0)} fill="none" stroke="var(--ico-gold, #E8B923)" strokeWidth="1.8" opacity="0.75" />
              <path d={path([fitWin[fitWin.length - 1], ...rows.map((r) => r.v)], hist.length - 1)} fill="none" stroke="var(--ico-gold, #E8B923)" strokeWidth="2.2" strokeDasharray="5 3" />
              <text x={4} y={14} fontSize="9" fill="var(--color-ink-3, #888)">{hist[0]?.year} · blue observed · gold model</text>
              <text x={W - 4} y={14} fontSize="9" textAnchor="end" fill="var(--color-ink-3, #888)">gold forecast → {rows[rows.length - 1].year}</text>
            </svg>
            <div className="mt-3 max-h-64 overflow-y-auto rounded-card border border-line/60 bg-space-3/30 p-2.5">
              <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-[12.5px] tabular-nums text-ink-2 sm:grid-cols-5">
                {rows.map((r) => (
                  <div key={r.year} className="flex justify-between gap-2">
                    <span className="text-ink-3">{r.year}</span><b>{r.v.toFixed(3)}%</b>
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-2 text-[12px] text-ink-3">Each year is the field&rsquo;s predicted share of that year&rsquo;s citations. The forecast reads <b>only the sky</b> — the planets&rsquo; angles are known centuries in advance, so the curve extends without ever seeing a future citation. How it is built, and how well it scores against thirty years it never saw, is on the <a href={localePath(cfg.base + "/")} className="font-semibold text-yin-light hover:underline">topics page <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></a></p>
          </Card>
        );
      })()}
    </div>
  );
}

function MethodCard() {
  // Every number quoted below is read from the exported atlas, never typed in — a figure written into
  // prose is a figure the model can quietly drift away from, and this page has done that before.
  const g = (researchData as any).aggregate as {
    auc: number; skillMedian: number; pctPositive: number; topics: number;
    persistence: number | null; paramsPerTopic: number | null;
  };
  const par = g.paramsPerTopic ?? 9;
  return (
        <Card className="mt-5 p-4 sm:p-6">
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">The model &amp; the method — concise, complete</h2>
            <p className="mt-2 text-[13px] text-ink-3">
              <b>The data.</b> The <a href="/nb/45" className="text-yin-ink underline decoration-dotted">scholarly citation record</a> — every reference edge in the OpenAlex snapshot (2026-06-26, CC0), 3&nbsp;billion of them, each dated by the <b>citing</b> work&rsquo;s year. For each research subfield we take the <b>citations it received</b> in a year (the event measure: attention <i>arriving</i>, not citations a paper will eventually earn), and its value is its <b>share of that year&rsquo;s total citations</b> (its citations ÷ the whole record&rsquo;s that year). At yearly resolution the citations dated only to a year — about a fifth of the record, commoner in older sources — are exact, so nothing is imputed. The sky is read from <b>seven bodies</b> (Mars, Jupiter, Saturn, Uranus, Neptune, Pluto and the lunar node; sidereal Lahiri) at each year&rsquo;s mid-point — the Sun, Mercury and Venus are excluded because at yearly sampling the Sun returns to nearly the same longitude each year and the two innermost planets cycle too fast to resolve, and Chiron is dropped because it overfits at the thirty-year horizon (below). <b>251 OpenAlex subfields.</b> To handle emerging topics honestly, each field is fit on its <b>own</b> history — starting the year it becomes consistently non-zero (its pre-existence years are never scored) — so a young field like Software or Artificial Intelligence is modelled only from when it appears, and no field is dropped.
            </p>
            <p className="mt-2 text-[13px] text-ink-3">
              <b>The model — one independent receiver per field.</b> Each field is fit entirely on its own — non-cross-sectional, no shared factors, no pie. The receiver is a <b>square-law detector</b>: it sums the seven planets&rsquo; waves projected onto the field&rsquo;s own tuning, C(t) = b + Σᵢ aᵢ·cos(θᵢ(t)−φ) — a reference level b plus seven planet waves (Mars outward), each an equal unit wave read from its true longitude θᵢ(t) (the model reads <b>angles only</b>; distance factors help short horizons but hurt the long test), met by <b>one tuning φ that the field uses for every body</b>. The predicted citation share is the <b>rectified power</b>, max(C, 0)² — the field goes <b>dark</b> when the summed projection drops below zero and <b>bright</b> on a transit — read straight off the sky, so it extends to any future year. Per field: 7 arrows + 1 shared tuning + 1 level = <b>{par} parameters</b>, and nothing is shared across fields. Mars (a 1.9-year orbit) is the fastest body the yearly grain can hold; the slowest — Pluto and Neptune — carry the long-range forecast and end up the dominant arrows for most fields.
            </p>
            <p className="mt-2 text-[13px] text-ink-3">
              <b>One tuning, and a sign.</b> A single tuning serving seven planets sounds too tight to work, and on its own it would be. What makes it work is that the arrows are <b>signed</b>: a negative arrow is <i>exactly</i> a 180° flip of that body against the shared tuning, since −a·cos(θ−φ) = a·cos(θ−(φ+180°)). So every body makes one binary choice — <b>agree with the field&rsquo;s tuning, or oppose it</b> — and almost every field uses both: 98% of the {g.topics} have at least one arrow pointing against the rest, with a third of all arrows sitting in the minority direction. (Which way is &ldquo;forward&rdquo; is arbitrary — flipping the tuning by 180° and every sign with it gives the identical model — so the honest figure is how many arrows sit in the smaller camp, not how many oppose some chosen direction.) The model is therefore one continuous phase plus seven binary ones, and that is measured to be the right amount of freedom, not a guess: take the signs away and force every arrow positive, and forecast skill collapses by <b>−0.19</b> across twelve historical origins — losing at every single one; go the other way and give every body its own free continuous tuning, and it overfits by <b>−0.01</b> at the thirty-year wall while costing six more parameters per field. Both directions are worse than the middle, which is why the atlas is drawn from {par} numbers a field rather than fifteen.
            </p>
            <p className="mt-2 text-[13px] text-ink-3">
              <b>Why this detector, why these bodies.</b> Two exhaustive ablations (2026-07-24) searched the whole family — receiver vs pie vs tides, this rectified sum vs the rotating-phasor envelope <span className="whitespace-nowrap">|Σ aᵢe<sup>iφᵢ</sup>|²</span> vs a plain linear rectifier and higher powers, √ vs log amplitude, absolute vs squared error, one to three harmonics, every roster and distance law — scored first on a twelve-year wall, then re-run on the <b>thirty-year wall</b> (fit ≤1995, forecast 1996-2025) and seed-checked. The rectified square-law won on both — it fits because a field&rsquo;s share sits near zero for long stretches and then spikes, exactly what a rectifier draws. The thirty-year test then reshaped the roster and the weights: <b>Chiron overfits</b> at that horizon (dropping it lifts the honest thirty-year skill from +0.14 to +0.40, and its AUC +0.58→+0.64), higher harmonics collapse, and the rehearsal-selected <b>N¾</b> evidence weight (below) lifted the wall to +0.69. A final round put <b>eight rival approaches</b> — new links, losses, optimisers, hierarchical pooling, extra data columns, ensembling — through the same rehearsal, each one re-run and audited for leakage by an independent adversary. Six genuinely beat the old model; the winner, by a distance, was not a new architecture at all but the <b>horizon anchor</b> in the training objective (below). The receiver itself came through untouched: every alternative link, loss and harmonic lost. A last round (2026-07-28) then went the other way and asked what could be <b>removed</b>: the seven free tunings collapsed to one (each extra tuning lowers the training error by construction and makes the forecast worse — the textbook shape of overfitting), and a further search for anything worth doing with the parameter saved came back empty. Deleting a planet, tying arrows together, replacing the seven arrow lengths with a smooth power law or with one shape shared by every field, fitting absolute instead of squared error, pinning the level to the anchor — <b>none of them measurably won</b>. The closest was deleting Jupiter, and it is worth telling on ourselves here: at the thirty-year wall it appeared to gain +0.02, but that wall was also what had picked it, and on origins that had no part in choosing it the gain fell to +0.0008 ± 0.0007 — a tie, not a win. So the deployed model is deliberately the <b>simplest</b> form that survives thirty years: adding to it makes it worse, and cutting from it buys nothing we can measure. <b>One more thing we owe you.</b> That last round scored its candidates on the thirty-year wall itself — the same 1996 cut-off whose {g.auc >= 0 ? "+" : ""}{g.auc.toFixed(2)} is quoted above as a clean holdout. For the decision to collapse seven tunings into one, it therefore is <i>not</i> a clean holdout, and we would rather say so than let the number carry more weight than it has earned. The twelve-origin comparison below is the part of the evidence that does not share that flaw: ten of its twelve origins had no hand in choosing anything.
            </p>
            <p className="mt-2 text-[13px] text-ink-3">
              <b>Why it still explains transits and aspects.</b> Because the level is a <b>squared real sum</b>, in the lit regime it expands — <b>exactly, not approximately</b> — into named terms: a baseline, a <b>transit</b> for every planet, 2b·aᵢ·cos(θᵢ−pᵢ) — the planet crossing the field&rsquo;s tuning, brightest at conjunction and darkest opposed — and a <b>pair</b> term for every planet couple, 2aᵢaₖ·cos(θᵢ−pᵢ)·cos(θₖ−pₖ): two planets <b>both lit past the tuning at once</b> multiply up, and when either falls dark the pair cancels. Each field&rsquo;s own page names its strongest pair and its live transits, with the full arithmetic.
            </p>
            <p className="mt-2 text-[13px] text-ink-3">
              <b>The fitting — there is no training run.</b> Once the tuning φ is fixed, the receiver is <b>linear</b> in everything that is left, because b + Σᵢ aᵢ·cos(θᵢ−φ) expands into b + Σᵢ[aᵢcosφ·cosθᵢ + aᵢsinφ·sinθᵢ]. So the whole model is fitted by sweeping φ over the circle <b>one degree at a time</b> and solving the remaining eight numbers exactly, by least squares, at each step — then keeping the best. There is no optimiser to converge, no random seed, no early stopping and no learning rate: refit it and you get the same numbers, bit for bit. That matters more than it sounds. This page makes a claim about {g.topics} research fields, and a claim you cannot reproduce exactly is a weaker claim. <b>The horizon anchor</b> lives inside that same solve, as extra rows rather than as a penalty: the model&rsquo;s own forecast over the next thirty years is pulled toward the level the field actually held in its last five <i>training</i> years, weighted so the pull is scale-free. It reads nothing but planet angles and training data, and it exists because the weakness was never the fit but the extrapolation — the slowest bodies sweep only a fraction of a cycle inside the window, so they behave like an unpinned trend that wanders once the data runs out. Its strength and its five-year memory were chosen by <b>rehearsal at two historical origins</b> (fit to 1935 then judge 1936&ndash;65; fit to 1965 then judge 1966&ndash;95) — never against the years being forecast. The fit runs over only each field&rsquo;s own non-zero years, with each year weighted by <b>N¾</b> — a share estimated from N citations carries noise ∝ 1/√N, which alone would give a √N weight; but a <b>rehearsal wall</b> (fit to 1965 only, judged on 1966&ndash;1995 — the test years never touched) selects a heavier lean onto the high-evidence modern years, a plateau around N^0.70&ndash;0.80, of which N¾ is the mid-point. The exponent is chosen by that rehearsal, not by hand — dropping the weight entirely collapses the long forecast. <b>Three constants, and no more.</b> Earlier versions of this page claimed &ldquo;no penalties, no regularisation, no tuned constants&rdquo;, which was not true and is worth correcting: the horizon anchor <i>is</i> a regulariser, and it has a strength and a five-year memory, which with the N¾ exponent makes three numbers that are not free parameters. What we can say is that none of the three was set by taste or by trying it against the years being forecast — each was fixed by rehearsal at historical origins. Beyond those three, nothing: every parameter of every field is free.
            </p>
            <p className="mt-2 text-[13px] text-ink-3">
              <b>The evaluation</b> is honest walls: the same model refitted knowing nothing after a cut-off 4, 12 and <b>30</b> years back, then scored against what actually happened (skill = error vs simply carrying each field&rsquo;s mean forward; the aggregate card above shows all three, and the <b>thirty-year wall</b> — the headline — is the curve drawn there). That test fits only to 1995 and then forecasts across the entire internet and deep-learning era it never saw; pooled AUC <b>{g.auc >= 0 ? "+" : ""}{g.auc.toFixed(2)}</b>, median field skill {g.skillMedian >= 0 ? "+" : ""}{g.skillMedian.toFixed(2)}, with {Math.round(g.pctPositive)}% of fields beating their own mean thirty years out. <b>And a harder bar.</b> Beating a field&rsquo;s long-run mean is a low hurdle, so we also measure against the strongest trivial forecast there is — <b>carry the last observed year forward, unchanged, for thirty years</b>.{typeof g.persistence === "number" && <> That costless rule scores <b>{g.persistence >= 0 ? "+" : ""}{g.persistence.toFixed(2)}</b> on the same test, which is <i>better</i> than several sky models we have deployed in the past; the current one clears it by {(g.auc - g.persistence).toFixed(2)}.</>} We report both, because a model that cannot beat doing nothing is not a model. That +0.73, though, is also a single-wall number, and measured the wider way it is a much closer race: across twelve historical origins the model averages <b>+0.88</b> to carry-forward&rsquo;s <b>+0.85</b>, and is ahead at only <b>seven of the twelve</b>. A real edge over doing nothing, then, but not a comfortable one — and on a five-origin stretch in the 1960s and 1970s, doing nothing wins. <b>One wall is not enough, either.</b> A single cut-off can flatter a model by luck, so the choice between this receiver and the larger gradient-fitted one it replaced was settled over <b>twelve</b> origins from 1963 to 1996, each forecasting its own next thirty years. The deterministic receiver averages <b>+0.88</b> against <b>+0.85</b>, winning nine of the twelve — while using {par} parameters a field instead of fifteen and needing no random seed. <b>The honest caveat, stated plainly:</b> the older model is the better one at three of those twelve origins, and it is better at all three of the walls whose numbers this page shows above — it scored +0.98, +0.95 and +0.82 there against our +0.97, +0.93 and {g.auc >= 0 ? "+" : ""}{g.auc.toFixed(2)}. We changed models anyway, because those three walls are three readings of the same recent cut-off and the twelve origins are a wider question; and because a forecast you can reproduce exactly, from a third of the parameters, is worth a small step back in a number we had already learned not to over-read. The twelve windows also overlap heavily, so treat the margin as a direction of travel rather than a precise measurement. A reader who weighs the displayed walls more highly than we do would keep the old model, and the numbers to make that case are all on this page. For the charts, the same model is refitted on the years <b>left of the line</b> only; right of it the curve is a <b>pure ephemeris forecast</b> — the sky&rsquo;s angles are known in advance, so the model extends without ever seeing those years. <b style={{ color: "var(--color-yin-ink)" }}>Blue</b> — the field&rsquo;s actual share of each year&rsquo;s citations. <b style={{ color: "var(--ico-gold)" }}>Gold</b> — the model: solid where it was fitted, dashed where it forecasts. <a className="text-yin-ink underline decoration-dotted" href="/animations/">Watch the 1-minute animation of the research behind it <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></a>
            </p>
        </Card>
  );
}

export default function Fields({ cfg = SKILLS_CFG }: { cfg?: AxisCfg } = {}) {
  const [params] = useSearchParams();
  const now = currentSeason();
  const [sel, setSel] = useState<number>(now.n);
  const [mineN, setMineN] = useState<number | null>(() => mySeason()?.n ?? null);
  const [saving, setSaving] = useState(false);
  const fieldKey = params.get("field") || "";
  const planetKey = params.get("planet") || "";
  const fieldHref = (key: string) => `${localePath(cfg.base + "/")}?field=${encodeURIComponent(key)}`;

  useEffect(() => {
    if (isLoggedIn()) SeasonsApi.wheel().then((w) => { if (w.mine) setMineN(w.mine); }).catch(() => {});
  }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [fieldKey]);

  // The analysed OpenAlex subfields — the atlas itself is the list.
  const mine = ALL_FIELDS;
  const field = useMemo(() => mine.find((d) => d.key === fieldKey) || null, [mine, fieldKey]);
  // Group every topic under its SEASON (fitted peak phase; house slot as fallback), ranked by R².
  const bySeason = useMemo(() => {
    const m: Record<number, Discipline[]> = {};
    mine.forEach((d) => { (m[topicSeason(d.key, d.house).n] ||= []).push(d); });
    Object.values(m).forEach((list) => list.sort((a, b) => r2Of(b) - r2Of(a) || (a.label || "").localeCompare(b.label || "")));
    return m;
  }, [mine]);

  // ArtaTrend — pick any field, roll its next thirty years (public, under the /topics/* route).
  if (params.get("trend") !== null) return <TrendView cfg={cfg} initial={params.get("trend") || ""} />;

  // A single field's analysis page.
  if (planetKey && PLANETS.includes(planetKey)) return <PlanetView planet={planetKey} cfg={cfg} />;
  if (fieldKey) return <FieldView d={field} loading={false} cfg={cfg} />;

  const selSeason = seasonByN(sel) || now;
  const selTopics = bySeason[sel] || [];
  const total = mine.length;

  const follow = async (n: number) => {
    if (!isLoggedIn()) { window.location.href = localePath("/login/"); return; }
    setSaving(true);
    try { await SeasonsApi.subscribe(n); setMineN(n); } catch { /* keep the previous choice */ }
    setSaving(false);
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{cfg.title}</h1>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-3">{cfg.blurb}</p>
        {total > 0 && (
          /* Dek/el drawn as rotated 2/3 (their Unicode construction) — the raw ↊/↋ chars tofu on many fonts. */
          <p className="mt-1 text-[12px] text-ink-3/70">
            {total} {cfg.noun}s across the twelve seasons · ranked Q · 1–10 · J (the Queen opens the cycle on 17 Aug; the Jack closes the life-cycle) · blue = the initiating seasons, gold = the steady, the blend = the adaptive
          </p>
        )}
      </header>

      {(
        <>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {PLANETS.map((b) => (
              <a key={b} href={`${localePath(cfg.base + "/")}?planet=${b}`} className="rounded-pill border border-line bg-space-2 px-3 py-1 text-[12px] capitalize text-ink-2 hover:border-yin-light">{b}</a>
            ))}
          </div>

          <SeasonCycle bySeason={bySeason} sel={sel} onSel={setSel} mineN={mineN} nowN={now.n} />



          {/* The selected season's panel — mythology, dates, craft, and EVERY topic ranked by fit. */}
          <Card className="mt-5 p-4 sm:p-6">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-[19px] font-bold tracking-tight">
                  {signOfN(selSeason.n)} <span className="font-normal text-ink-3">· {seasonSpan(selSeason)}</span>
                </h2>
                              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                {mineN === selSeason.n ? (
                  <span className="rounded-pill border border-yang/60 px-3.5 py-1.5 text-[13px] font-semibold text-yang-ink">Your season ✓</span>
                ) : (
                  <button onClick={() => follow(selSeason.n)} disabled={saving}
                    className="rounded-pill bg-yang px-3.5 py-1.5 text-[13px] font-semibold text-on-accent hover:opacity-90 disabled:opacity-50">
                    Follow this season
                  </button>
                )}
                <a href={localePath(selSeason.createHref)} className="text-[12px] font-semibold text-yin-light hover:underline">
                  {selSeason.craftLabel} is its craft →
                </a>
              </div>
            </div>
            <p className="mt-2 text-[12px] leading-snug text-ink-3">
              {selSeason.n === now.n
                ? <>This season is running now — the whole platform is creating <b className="text-ink-2">{selSeason.craftLabel.toLowerCase()}s</b> until it turns.</>
                : <>While it runs ({seasonSpan(selSeason)}), the whole platform creates <b className="text-ink-2">{selSeason.craftLabel.toLowerCase()}s</b>.</>}
              {" "}Following a season means its topics are the ones we recommend you, whatever the world is making.
            </p>
            {selTopics.length > 0 && (
              <div className="mt-3 max-h-72 overflow-y-auto rounded-card border border-line/60 bg-space-3/30 p-2.5" aria-label={`All ${selTopics.length} topics of this sign, ranked by fit`}>
                <div className="flex flex-wrap gap-1.5">
                  {selTopics.map((d, i) => {
                    const rep = i === 0;
                    return (
                      <a key={d.key} href={fieldHref(d.key)}
                        title={resonanceTitle(d.key) || resonanceTitle(d.label) || undefined}
                        className={`rounded-full border px-2.5 py-1 text-[13px] transition-colors hover:border-yin-light hover:text-yin-light ${rep ? "border-yin-light bg-space-3/70 font-semibold text-ink" : "border-line bg-space-3/40 text-ink-2"}`}>
                        {d.label}
                        <span className="ms-1.5 text-[10.5px] tabular-nums text-ink-3">{Math.round(r2Of(d) * 100)}%</span>
                      </a>
                    );
                  })}
                </div>
              </div>
            )}
            {selTopics.length === 0 && <p className="mt-3 text-[13px] text-ink-3">No topics placed in this sign yet.</p>}
          </Card>

          <p className="mb-2 mt-6 max-w-2xl text-[13px] leading-relaxed text-ink-3">
            <a href={localePath(cfg.base + "/?trend=")} className="font-semibold text-yin-light hover:underline">ArtaTrend — roll any field forward thirty years <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></a>
          </p>
          <p className="mb-2 mt-2 max-w-2xl text-[13px] leading-relaxed text-ink-3">
            Every {cfg.noun} peaks on its own natural rhythm — <a href={localePath("/cycles/")} className="font-semibold text-yin-light hover:underline">explore the cycles <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></a>
          </p>

          {(researchData as any).aggregate && (() => {

            const g = (researchData as any).aggregate as { skillCurve: number[]; auc: number; skillMedian: number; pctPositive: number; topics: number };

            const c = g.skillCurve || [];

            if (!c.length) return null;

            const W = 640, Hh = 172, padT = 24, padB = 30;

            const lo = Math.min(0, ...c), hi = Math.max(...c, 0.01), rng = hi - lo;

            const xOf = (k: number) => (k * W) / (c.length - 1);

            const yOf = (v: number) => padT + (1 - (v - lo) / rng) * (Hh - padT - padB);

            const d = c.map((v, k) => `${k === 0 ? "M" : "L"}${xOf(k).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");

            return (

              <Card className="mt-5 p-4 sm:p-6">

                <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Across all {g.topics} topics — how far ahead the model sees</h2>
                <p className="mb-2 text-[12px] text-ink-3">Forecast skill by years ahead — the benchmark model over the {g.skillCurve.length} unseen years.</p>

                <svg viewBox={`0 0 ${W} ${Hh}`} className="w-full" role="img" aria-label={`Pooled forecast skill by years ahead, one to ${g.skillCurve.length}, with the area under the curve`}>

                  <line x1={0} y1={yOf(0)} x2={W} y2={yOf(0)} stroke="var(--color-ink-3, #888)" strokeWidth="1" opacity="0.4" strokeDasharray="3 3" />

                  <path d={`${c.map((v, k) => `${k === 0 ? "M" : "L"}${xOf(k).toFixed(1)},${yOf(Math.max(v, 0)).toFixed(1)}`).join(" ")} L${W},${yOf(0)} L0,${yOf(0)} Z`} fill="var(--ico-gold, #E8B923)" opacity="0.14" />

                  <path d={d} fill="none" stroke="var(--ico-gold, #E8B923)" strokeWidth="2.2" />

                  

                  {[4, 8].map((m2) => (
                    <g key={m2}>
                      <line x1={xOf(m2 - 1)} y1={padT} x2={xOf(m2 - 1)} y2={Hh - padB} stroke="var(--color-ink-3, #888)" strokeWidth="0.5" opacity="0.2" />
                      <text x={xOf(m2 - 1)} y={Hh - 6} fontSize="9" textAnchor="middle" fill="var(--color-ink-3, #888)">{m2} yr</text>
                    </g>
                  ))}

                  <text x={W * 0.72} y={yOf(0) - 6} fontSize="9" textAnchor="middle" fill="var(--color-ink-3, #888)">0 — no better than the baseline</text>

                  <text x={xOf(0) + 2} y={Math.max(yOf(c[0]) - 8, 12)} fontSize="9.5" fontWeight="700" fill="var(--ico-gold, #E8B923)">+{c[0].toFixed(2)}</text>

                  <text x={W - 6} y={Math.min(Math.max(yOf(c[c.length - 1]) - 10, 12), Hh - padB - 22)} fontSize="9.5" fontWeight="700" textAnchor="end" fill="var(--ico-gold, #E8B923)">{c[c.length - 1] >= 0 ? "+" : "−"}{Math.abs(c[c.length - 1]).toFixed(2)}</text>

                  <text x={4} y={Hh - 6} fontSize="9" fill="var(--color-ink-3, #888)">1 yr</text>

                  <text x={W - 4} y={Hh - 6} fontSize="9" textAnchor="end" fill="var(--color-ink-3, #888)">{c.length} yr</text>

                </svg>

                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-3">

                  <span>AUC <b className="text-ink-2">{g.auc.toFixed(2)}</b></span>

                  <span>median topic skill <b className="text-ink-2">{g.skillMedian.toFixed(2)}</b></span>

                  <span>topics beating the baseline <b className="text-ink-2">{g.pctPositive.toFixed(0)}%</b></span>

                  {typeof (g as any).auc2 === "number" && <span>four years out, AUC <b className="text-ink-2">{(g as any).auc2.toFixed(2)}</b></span>}

                  {typeof (g as any).auc4 === "number" && <span>twelve years out, AUC <b className="text-ink-2">{(g as any).auc4.toFixed(2)}</b></span>}

                </div>

                <p className="mt-2 text-[12px] text-ink-3">The shaded area is the AUC: pooled skill (vs carrying each topic&rsquo;s mean forward) at every horizon from one year to thirty years, from the benchmark model that never saw those years.</p>

              </Card>

            );

          })()}

          <MethodCard />
        </>
      )}
    </div>
  );
}

/** A compact labelled stat tile for the topic-analysis facts row (two colours only). */
function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-card border border-line bg-space-2 px-3 py-2.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-3">{label}</div>
      <div className="mt-0.5 text-[18px] font-bold tabular-nums text-ink">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] leading-snug text-ink-3">{hint}</div>}
    </div>
  );
}

type DailySeries = { actual: number[]; fit: number[]; err?: number[]; forecast?: number[]; pred?: number[]; bench?: number[]; benchWall?: number; predStart?: number; predWall?: number; r2Ins?: number; r2Oos?: number;  bodyShares?: number[]; bodyPhases?: number[]; transits?: { b: string; th: number; tu: number; ang: number; con: number }[]; topAspects?: { a: string; b: string; rel: number; ai: number; ak: number; w: number; sep: number; tun: number; eff: number; pi?: number; pk?: number; cos: number; con: number }[]; start?: number; step?: number; from: string; to: string };

function FieldView({ d, loading, cfg }: { d: Discipline | null; loading: boolean; cfg: AxisCfg }) {
  const [daily, setDaily] = useState<DailySeries | null>(null);
  useEffect(() => {
    if (!d) return;
    // Lazy-load THIS field's full yearly series (its own ~4 KB chunk, dynamic-imported by key) only when
    // the page opens — the raw actual shares plus both models' curves for the plots below.
    setDaily(null);
    import(`../data/field-daily/${d.key}.json`).then((m) => setDaily((m.default as DailySeries) || null)).catch(() => {});
  }, [d?.key, d?.house, d?.sign]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
      <a href={localePath(cfg.base + "/")} className="mb-5 inline-flex text-[13px] text-ink-3 hover:text-yin-light">← {cfg.title}</a>
      {loading || !d ? (
        <p className="text-[14px] text-ink-3">{loading ? "Loading…" : "Unknown field."}</p>
      ) : (
        <>
          {(() => {
            const a = ANALYSIS[d.key];
            const ts = topicSeason(d.key, d.house);
            return (
              <>
                <header className="mb-4">
                  <h1 className="text-2xl font-bold tracking-tight sm:text-3xl" title={resonanceTitle(d.key) || resonanceTitle(d.label) || undefined}>{d.label}</h1>
                  <p className="mt-1 text-[13px] text-ink-3">Sign · {a?.phaseSign || signOfN(ts.n)}</p>
                  {ANALYSIS[d.key]?.worldEvent && (
                    <p className="mt-1 text-[12px] text-ink-3">A world-event measure — the daily global share of this event type (GDELT), aggregated monthly, fit exactly like a search topic.</p>
                  )}
                </header>
                {!a ? (
                  <Card className="p-4 sm:p-6">
                    <p className="text-[14px] leading-relaxed text-ink-3">This topic&rsquo;s analysis is being computed — check back shortly.</p>
                  </Card>
                ) : (() => {
            // TREND-led vs SEASON-led: trend-led topics are a secular rise/fall — lead with the trend;
            // the rare seasonal topic leads with its sign on the cycle.
            const isTrend = a.trend === true;
            const dir = a.trendDir || "steady";
            const trendHead = dir === "rising" ? "A rising trend" : dir === "falling" ? "A fading trend" : "A steady presence";
            const trendVerb = dir === "rising" ? "climbed steadily" : dir === "falling" ? "faded over time" : "held broadly steady";
            return (
              <>
                {isTrend ? (
                  /* HERO (trend topics) — lead with the long-term trend, not a noisy season. */
                  <Card className="p-4 sm:p-6">
                    <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Its shape over its own history</h2>
                    <p className="text-[2.4rem] font-extrabold leading-none text-yang">{trendHead}</p>
                    <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
                      The share of each year&rsquo;s citations going to <b className="text-ink">{d.label.toLowerCase()}</b> has <b className="text-ink">{trendVerb}</b> over the years it has existed — driven by long-term change, not the yearly season.
                    </p>
                    <p className="mt-2 text-[12px] leading-snug text-ink-3">Sign: <b className="text-ink-2">{a.phaseSign || signOfN(ts.n)}</b> — where its Pluto tuning points (below).</p>
                  </Card>
                ) : (
                  /* HERO (rare — a field with real within-year seasonality). */
                  <Card className="p-4 sm:p-6">
                    <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Its sign</h2>
                    <p className="flex items-center gap-3 text-[2.4rem] font-extrabold leading-none text-yang">
                      {a.phaseSign || signOfN(ts.n)}
                    </p>
                    <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
                      The sign <b className="text-ink">{d.label.toLowerCase()}</b>&rsquo;s Pluto tuning falls in — <b className="text-ink">{seasonSpan(ts)}</b>.
                    </p>
                  </Card>
                )}

                <Card className="mt-4 p-4 sm:p-6">
                  <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">What the numbers say</h2>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {a.popularity != null && <Fact label="Citation share" value={`${a.popularity}%`} hint="its mean share of each year's citations received" />}
                    {typeof a.r2Oos === "number" && <Fact label="30-yr forecast skill" value={a.r2Oos.toFixed(2)} hint="held-out thirty-year skill vs carrying its mean forward" />}
                  </div>
                </Card>

                {/* THE PREDICTION — the phasor model's monthly curve: in-sample fit, then a pure
                    ephemeris forecast, extended past the data out to 2030. */}
                {daily?.pred && daily.pred.length > 48 && daily.actual && (
                  <Card className="mt-4 p-4 sm:p-6">
                    <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">The forecast — the deployed model, the next thirty years</h2>
                    {(() => {
                      const pred = daily.pred!;
                      const off = daily.predStart ?? Math.max(0, daily.actual.length - pred.length);
                      const act = daily.actual.slice(off);
                      const nAct = act.length;                       // last actual year
                      const n = pred.length;                         // the curve runs past the data, to today
                      const wallAbs = Math.min(daily.predWall ?? 325, n - 1);
                      const yr0 = String(Number(daily.from) + Math.round(off / 12));
                      const W = 640, Hh = 190, padT = 8, padB = 14;
                      // Fit the y-axis to the DATA's own range (not 0..1%) so a small-share field still fills the plot.
                      const yhi = Math.max(...act, ...pred), ylo = Math.min(...act, ...pred);
                      const ypad = Math.max((yhi - ylo) * 0.07, 1e-9);
                      const y0 = Math.max(0, ylo - ypad), yrng = yhi + ypad - y0;
                      const xOf = (i: number) => (i * W) / (n - 1);
                      const yOf = (v: number) => padT + (1 - (v - y0) / yrng) * (Hh - padT - padB);
                      const path = (vals: number[], i0: number, i1: number, x0: number) =>
                        vals.slice(i0, i1).map((v, i) => `${i === 0 ? "M" : "L"}${xOf(x0 + i0 + i).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
                                            return (
                        <svg viewBox={`0 0 ${W} ${Hh}`} className="w-full" role="img"
                             aria-label="Yearly citations-received share with the receiver model's in-sample fit and its out-of-sample forecast over the held-out final years">
                          <rect x={xOf(wallAbs)} y={0} width={W - xOf(wallAbs)} height={Hh} fill="var(--color-yin)" opacity="0.07" />
                          <line x1={xOf(wallAbs)} y1={0} x2={xOf(wallAbs)} y2={Hh} stroke="var(--color-yin-ink, #1746DC)" strokeWidth="1" opacity="0.35" />
                          <path d={path(act, 0, nAct, 0)} fill="none" stroke="var(--color-yin-ink, #1746DC)" strokeWidth="1.6" opacity="0.9" />
                          <path d={path(pred, 0, wallAbs + 1, 0)} fill="none" stroke="var(--ico-gold, #E8B923)" strokeWidth="1.8" opacity="0.75" />
                          <path d={path(pred, wallAbs, n, 0)} fill="none" stroke="var(--ico-gold, #E8B923)" strokeWidth="2.2" strokeDasharray="5 3" />
                          <line x1={xOf(nAct - 1)} y1={0} x2={xOf(nAct - 1)} y2={Hh} stroke="var(--color-ink-3, #888)" strokeWidth="1" strokeDasharray="2 3" opacity="0.5" />
                          <text x={Math.min(xOf(wallAbs) + 5, W - 150)} y={16} fontSize="9" fill="var(--color-ink-3, #888)">forecast <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></text>
                          <text x={W - 4} y={16} fontSize="9" textAnchor="end" fill="var(--color-ink-3, #888)">→ 2055</text>
                          <text x={4} y={16} fontSize="9" fill="var(--color-ink-3, #888)">{yr0}–now · blue actual · gold model</text>
                        </svg>
                      );
                    })()}
                  </Card>
                )}

                {typeof a.phaseEst === "number" && (() => {
                  const SG = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"];
                  const ph = a.phaseEst as number;
                  const band = Math.floor(ph / 30) % 12;
                  return (
                    <Card className="mt-4 p-4 sm:p-6">
                      <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Its sign — {SG[band]}, where its Pluto points</h2>
                      <p className="mb-3 text-[13px] leading-relaxed text-ink-3">Every topic is classified by <b>Pluto&rsquo;s tuning</b> — the direction the model learned for the deepest, slowest body, the one that carries the long-horizon forecast. For this field Pluto is tuned to <b className="text-ink-2">{Math.round(ph)}°</b> of the sidereal zodiac, which falls in <b className="text-ink-2">{SG[band]}</b>. That is its placement — read straight off the model, one number, no weighting.</p>
                      <svg viewBox="0 0 640 64" className="w-full" role="img" aria-label="The zodiac 0 to 360 degrees with this field's Pluto tuning marked — its sign">
                        {Array.from({ length: 12 }, (_, i) => (
                          <rect key={i} x={(i * 640) / 12} y={0} width={640 / 12} height={44}
                            fill={i === band ? "var(--color-yang)" : "var(--color-yin)"}
                            fillOpacity={i === band ? 0.18 : i % 2 ? 0.04 : 0.09} />
                        ))}
                        <rect x={(ph / 360) * 640 - 1.5} y={0} width={3} height={44} fill="var(--color-yang)" />
                        {Array.from({ length: 12 }, (_, i) => (
                          <text key={i} x={(i * 640) / 12 + 640 / 24} y={58} textAnchor="middle" fontSize="8.5" fill="var(--color-ink-3, #888)">{["Ari","Tau","Gem","Can","Leo","Vir","Lib","Sco","Sag","Cap","Aqu","Pis"][i]}</text>
                        ))}
                      </svg>
                      <p className="mt-2 text-[12px] text-ink-3">The <b style={{ color: "var(--color-yang-ink)" }}>gold</b> tick is Pluto&rsquo;s tuning pₚₗᵤₜₒ; the shaded band is the sign it falls in.</p>
                    </Card>
                  );
                })()}

                {daily?.bodyShares && daily.bodyShares.length === 7 && (
                  <Card className="mt-4 p-4 sm:p-6">
                    <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">What the receiver heard — the seven arrows and the aspects</h2>
                    <div className="space-y-1">
                      {["mars","jupiter","saturn","uranus","neptune","pluto","node"].map((b, i) => {
                        const v = daily.bodyShares![i] || 0;
                        const mx = Math.max(...daily.bodyShares!, 1e-6);
                        const dom = v === mx;
                        return (
                          <div key={b} className="flex items-center gap-2">
                            <span className="w-16 shrink-0 text-[11px] capitalize text-ink-3">{b}</span>
                            <div className="h-2 flex-1 overflow-hidden rounded-pill bg-space-3">
                              <div className="h-full rounded-pill" style={{ width: `${Math.max(2, (v / mx) * 100)}%`, background: dom ? "var(--color-yang)" : "var(--color-yin)" }} />
                            </div>
                            <span className="w-10 shrink-0 text-end text-[11px] tabular-nums text-ink-3">{Math.round(v * 100)}%</span>
                          </div>
                        );
                      })}
                    </div>
                    <p className="mt-2 text-[12px] text-ink-3">Arrow lengths aᵢ — how strongly the topic listens to each body (<b style={{ color: "var(--color-yang-ink)" }}>gold</b> = dominant).</p>
                    {daily.bodyPhases && daily.bodyPhases.length === 7 && (
                      <div className="mt-3">
                        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Where each planet is tuned — its identified sign</h3>
                        <div className="space-y-1">
                          {["mars","jupiter","saturn","uranus","neptune","pluto","node"].map((b, i) => {
                            const ph = daily.bodyPhases![i] || 0;
                            const SG = ["Aries","Taurus","Gemini","Cancer","Leo","Virgo","Libra","Scorpio","Sagittarius","Capricorn","Aquarius","Pisces"];
                            const sg = SG[Math.floor(ph / 30) % 12];
                            return (
                              <div key={b} className="flex items-center gap-2">
                                <span className="w-16 shrink-0 text-[11px] capitalize text-ink-3">{b}</span>
                                <div className="relative h-3 flex-1 overflow-hidden rounded-pill">
                                  {Array.from({ length: 12 }, (_, k) => (
                                    <div key={k} className="absolute top-0 h-full" style={{ left: `${(k * 100) / 12}%`, width: `${100 / 12}%`, background: "var(--color-yin)", opacity: k % 2 ? 0.06 : 0.14 }} />
                                  ))}
                                  <div className="absolute top-0 h-full w-[2.5px] rounded-pill" style={{ left: `calc(${(ph / 360) * 100}% - 1px)`, background: b === "sun" ? "var(--color-yang)" : "var(--color-yang-ink)" }} />
                                </div>
                                <span className="w-24 shrink-0 text-end text-[11px] tabular-nums text-ink-3">{Math.round(ph)}° {sg}</span>
                              </div>
                            );
                          })}
                        </div>
                        <p className="mt-1 text-[12px] text-ink-3">The zodiac 0–360°; each tick is that planet&rsquo;s tuning pᵢ — the direction whose crossing boosts the topic.</p>
                      </div>
                    )}
                    
                                                {daily.topAspects && daily.topAspects.length > 0 && (
                  <div className="mt-3">
                    <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Natal pairs — the topic&rsquo;s personality</h3>
                    <div className="space-y-1">
                      {daily.topAspects.map((t) => {
                        const tun = t.tun >= 359.95 ? 0 : t.tun;
                        const dn = Math.min(tun, 360 - tun);
                        // The topic has ONE tuning and each body either takes it or flips 180° against it,
                        // so a pair can only ever agree or oppose — there is no spectrum to round to, and
                        // pretending to classify a sextile or a trine here would be inventing precision.
                        const agree = dn < 90;
                        return (
                          <div key={t.a + t.b} className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] tabular-nums text-ink-2">
                            <span className="capitalize font-semibold text-ink">{t.a}–{t.b}</span>
                            <span>{agree ? <><b>agree</b> — same tuning</> : <><b>oppose</b> — {dn.toFixed(0)}° apart</>}</span>
                            <span className="text-ink-3">· weight 2·aᵢ·aₖ = {t.w.toFixed(2)}</span>
                          </div>
                        );
                      })}
                    </div>
                    <p className="mt-1 text-[12px] text-ink-3">Relations between the topic&rsquo;s <b>own tunings</b> — fixed: its character. There are only <b>two</b> of them, and that is the model, not a shortcut: the topic has a single tuning, and each body either takes it or flips exactly 180° against it. Agreeing pairs reinforce whenever both are lit; opposed pairs cancel.</p>
                    {daily.transits && daily.transits.length > 0 && (
                      <div className="mt-3">
                        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Transit aspects — this year&rsquo;s sky against the natal tunings</h3>
                        <div className="space-y-1">
                          {daily.transits.map((t) => {
                            const d = Math.min(t.ang, 360 - t.ang);
                            const TYPES: [number, string, number][] = [[0, "conjunction", 1], [60, "sextile", 0.5], [90, "square", 0], [120, "trine", -0.5], [180, "opposition", -1]];
                            let bt = TYPES[0];
                            for (const ty of TYPES) if (Math.abs(d - ty[0]) < Math.abs(d - bt[0])) bt = ty;
                            return (
                              <div key={t.b} className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] tabular-nums text-ink-2">
                                <span className="capitalize font-semibold text-ink">{t.b}</span>
                                <span>now at <b>{t.th.toFixed(1)}°</b> vs its natal tuning <b>{t.tu.toFixed(1)}°</b> → <b>{d.toFixed(1)}°</b> ≈ <b>{bt[1]}</b></span>
                                <span style={{ color: t.con >= 0 ? "var(--color-yang-ink)" : "var(--color-yin-ink)" }}><b>{t.con >= 0 ? "+" : ""}{t.con.toFixed(1)}%</b> of its level</span>
                              </div>
                            );
                          })}
                        </div>
                        <p className="mt-1 text-[12px] text-ink-3">2·b·aᵢ·cos(θᵢ−pᵢ): a planet <b>crossing its natal tuning</b> boosts; opposing damps. Changes each year.</p>
                      </div>
                    )}
                    <h3 className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Pair transits — the full arithmetic</h3>
                    <div className="space-y-2">
                      {daily.topAspects.map((t) => {
                        const d = Math.min(t.eff, 360 - t.eff);
                        const TYPES: [number, string, number][] = [[0, "conjunction", 1], [60, "sextile", 0.5], [90, "square", 0], [120, "trine", -0.5], [180, "opposition", -1]];
                        let best = TYPES[0];
                        for (const ty of TYPES) if (Math.abs(d - ty[0]) < Math.abs(d - best[0])) best = ty;
                        return (
                          <div key={t.a + t.b} className="rounded-card border border-line bg-space-2 p-3 text-[12.5px] leading-relaxed">
                            <div className="mb-0.5 font-semibold capitalize text-ink">{t.a}–{t.b} <span className="font-normal text-ink-3">({Math.round(t.rel * 100)}% of the strongest)</span></div>
                            <div className="tabular-nums text-ink-2">coupling&ensp;= 2 × {t.a} <b>{t.ai.toFixed(2)}</b> × {t.b} <b>{t.ak.toFixed(2)}</b> = <b>{t.w.toFixed(2)}</b> <span className="text-ink-3">(the most this pair can add)</span></div>
                            <div className="tabular-nums text-ink-2">lit now&ensp;= {t.a} <b>{(t.pi ?? 0).toFixed(2)}</b> × {t.b} <b>{(t.pk ?? 0).toFixed(2)}</b> = <b>{t.cos.toFixed(2)}</b> <span className="text-ink-3">(each = cos past its tuning; current separation {d.toFixed(1)}° ≈ {best[1]})</span></div>
                            <div className="tabular-nums text-ink-2">effect&ensp;= {t.w.toFixed(2)} × <b>{t.cos.toFixed(2)}</b> = <b style={{ color: t.con >= 0 ? "var(--color-yang-ink)" : "var(--color-yin-ink)" }}>{t.con >= 0 ? "+" : ""}{t.con.toFixed(1)}%</b> of the topic&rsquo;s level this year</div>
                          </div>
                        );
                      })}
                    </div>
                    <p className="mt-2 text-[12px] text-ink-3"><b>Why these pairs</b>: the receiver squares a real sum, so each planet couple contributes 2aᵢaₖ · (how lit each one is now) — its <b>coupling</b> is the product of the two arrows above (the ceiling), and its live effect scales by how far <b>past its tuning</b> each planet sits (cos of that angle). Both lit → they reinforce; one dark → they cancel. The classical aspect names label the pair&rsquo;s current separation, but the effect is the joint illumination, not cos of the angle alone.</p>
                  </div>
                )}
                  </Card>
                )}


                <p className="mt-4 text-[12.5px] text-ink-3">How this all works — the data, the independent receiver, the per-field history, the training and the three honest walls — is explained once on the <a href={localePath(cfg.base + "/")} className="font-semibold text-yin-light hover:underline">topics page <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></a></p>


                {daily?.bench && daily.bench.length > 48 && daily.actual && (() => {
                  const off = daily.predStart ?? 0;
                  const act = daily.actual.slice(off);
                  const bench = daily.bench!;
                  const nAct = act.length;
                  const n = Math.min(bench.length, nAct);          // benchmark shown over the DATA years only
                  const wallAbs = Math.min(daily.benchWall ?? 296, n - 1);
                  const W = 640, Hh = 170, padT = 8, padB = 14;
                  // Same data-range fit as the forecast card above.
                  const yhi = Math.max(...act.slice(0, n), ...bench.slice(0, n)), ylo = Math.min(...act.slice(0, n), ...bench.slice(0, n));
                  const ypad = Math.max((yhi - ylo) * 0.07, 1e-9);
                  const y0 = Math.max(0, ylo - ypad), yrng = yhi + ypad - y0;
                  const xOf = (i2: number) => (i2 * W) / (n - 1);
                  const yOf = (v: number) => padT + (1 - (v - y0) / yrng) * (Hh - padT - padB);
                  const path = (vals: number[], i0: number, i1: number) => vals.slice(i0, i1).map((v, i2) => `${i2 === 0 ? "M" : "L"}${xOf(i0 + i2).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
                  return (
                    <Card className="mt-4 p-4 sm:p-6">
                      <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">The honest test — a second model that never saw the last thirty years</h2>
                      <svg viewBox={`0 0 ${W} ${Hh}`} className="w-full" role="img" aria-label="Benchmark: a model fitted only before the wall, its forecast versus what actually happened">
                        <rect x={xOf(wallAbs)} y={0} width={W - xOf(wallAbs)} height={Hh} fill="var(--color-yin)" opacity="0.07" />
                        <line x1={xOf(wallAbs)} y1={0} x2={xOf(wallAbs)} y2={Hh} stroke="var(--color-yin-ink, #1746DC)" strokeWidth="1" opacity="0.35" />
                        <path d={path(act, 0, n)} fill="none" stroke="var(--color-yin-ink, #1746DC)" strokeWidth="1.6" opacity="0.9" />
                        <path d={path(bench, 0, wallAbs + 1)} fill="none" stroke="var(--ico-gold, #E8B923)" strokeWidth="1.8" opacity="0.75" />
                        <path d={path(bench, wallAbs, n)} fill="none" stroke="var(--ico-gold, #E8B923)" strokeWidth="2.2" strokeDasharray="5 3" />
                        <text x={Math.min(xOf(wallAbs) + 5, W - 130)} y={16} fontSize="9" fill="var(--color-ink-3, #888)">never seen <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></text>
                      </svg>
                      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-3">
                        {typeof daily.r2Ins === "number" && <span>before the wall <b className="text-ink-2">{daily.r2Ins.toFixed(2)}</b></span>}
                        {typeof daily.r2Oos === "number" && <span>held-out thirty years <b className="text-ink-2">{daily.r2Oos.toFixed(2)}</b></span>}
                      </div>
                      <p className="mt-2 text-[12px] text-ink-3">Same model, refitted using <b>only the years left of the wall</b> — the dashed curve is its forecast of thirty years it never saw, drawn over what actually happened. This is the evidence for the forecasting power of the deployed model above.</p>
                    </Card>
                  );
                })()}

                <p className="mt-4 text-[11px] leading-relaxed text-ink-2/80"><b>Correlation is not causation.</b> A transparent statistical curiosity: it only measures whether two rhythms line up. Nothing here claims the sky causes anything.</p>
              </>
            );
                })()}
              </>
            );
          })()}
        </>
      )}
    </div>
  );
}
