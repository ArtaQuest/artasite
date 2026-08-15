import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Cycles, type CycleRank } from "../lib/api";
import { Card } from "../components/ui";
import { WithRail, RailInline } from "../components/PageRail";
import { localePath } from "../lib/wp";
import { AXIS_COLOR } from "../lib/typology-meta";
import researchData from "../data/research.json";

const cycleHref = (slug: string) => `${localePath("/cycles/")}?cycle=${encodeURIComponent(slug)}`;
// Field refs land on the field's analysis page — Topics (/topics), the ONLY search-field page since
// the house-axis /professions atlas was retired with the Skills-500 purge (2026-07-05).
const fieldHref = (key: string) => `${localePath("/topics/")}?field=${encodeURIComponent(key)}`;
const Paras = ({ text }: { text?: string }) =>
  <>{(text || "").split(/\n\n+/).map((p, i) => <p key={i} className="mt-2 text-[14px] leading-relaxed text-ink-2">{p.trim()}</p>)}</>;

type FieldShare = { key: string; label: string; pct: number };
type CycleStat = { slug: string; body: string; label: string; period: string; share: number; dominant: number; top: FieldShare[] };

/* The ranking is computed DIRECTLY from the field analysis (src/data/research.json — the same daily fits the
   /fields pages render): each cycle's `share` is its mean % of the explained search-trend variance across all
   analysed fields, `dominant` is how many fields it is the strongest rhythm for, and `top` are those fields.
   So /cycles, /fields and the per-field analysis pages can never disagree — they read one source. */
const ANALYSIS: { cycles: CycleStat[]; n: number } = (() => {
  const cycles = researchData.cycles as { slug: string; body: string; label: string; period: string }[];
  const topics = researchData.topics as { key: string; label: string; shares: { slug: string; pct: number }[] }[];
  const n = topics.length || 1;
  const agg: Record<string, { sum: number; dominant: number; fields: FieldShare[] }> = {};
  cycles.forEach((c) => (agg[c.slug] = { sum: 0, dominant: 0, fields: [] }));
  topics.forEach((t) => {
    let topSlug = "", topPct = -1;
    t.shares.forEach((s) => {
      const a = agg[s.slug];
      if (!a) return;
      a.sum += s.pct;
      if (s.pct >= 0.05) a.fields.push({ key: t.key, label: t.label, pct: s.pct });
      if (s.pct > topPct) { topPct = s.pct; topSlug = s.slug; }
    });
    if (agg[topSlug]) agg[topSlug].dominant += 1;
  });
  // Normalize the aggregated per-cycle contributions to sum to EXACTLY 100% — divide each cycle's total share by the
  // grand total across all cycles (NOT by R², which sums to < 100%). So the ranked bars are a clean share-of-explained
  // decomposition: the 11 numbers add up to 100%.
  const grand = cycles.reduce((s, c) => s + agg[c.slug].sum, 0) || 1;
  const out = cycles.map((c) => {
    const a = agg[c.slug];
    return {
      slug: c.slug, body: c.body, label: c.label, period: c.period.replace(/^about\s+/i, ""),
      share: Math.round((a.sum / grand) * 1000) / 10,
      dominant: a.dominant,
      top: a.fields.sort((x, y) => y.pct - x.pct),
    } as CycleStat;
  }).sort((a, b) => b.share - a.share);
  return { cycles: out, n };
})();

/* The /cycles page — the eleven celestial rhythms ranked by how much of the world's 20-year search curiosity
   they explain, computed live from the field analysis. Each opens a short, plain-English page at
   /cycles/?cycle=<slug>: the real-world cycle it keeps time with, what the data found, and verified sources. */
export default function CyclesPage() {
  const [dossier, setDossier] = useState<Record<string, CycleRank>>({});
  const [params] = useSearchParams();
  const slug = params.get("cycle") || "";

  useEffect(() => {
    Cycles.list()
      .then((d) => {
        const m: Record<string, CycleRank> = {};
        (d.cycles || []).forEach((c) => { m[String(c.body).toLowerCase()] = c; });
        setDossier(m);
      })
      .catch(() => {});
  }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [slug]);

  if (slug) {
    const stat = ANALYSIS.cycles.find((c) => c.slug === slug) || null;
    return <CycleView stat={stat} dossier={dossier[slug]} n={ANALYSIS.n} />;
  }

  const maxShare = Math.max(1, ...ANALYSIS.cycles.map((c) => c.share));
  return (
    <div className="mx-auto max-w-3xl py-8 sm:py-10">
      <header className="mb-7">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Cycles</h1>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-3">
          The world&rsquo;s curiosity rises and falls in rhythms — some yearly, some lasting lifetimes. Here are the{" "}
          {ANALYSIS.cycles.length} celestial cycles, ranked by how much of that ebb and flow they explain across the{" "}
          {ANALYSIS.n} analysed fields. Tap any one to see the real-world cycle behind it.
        </p>
      </header>

      <div className="space-y-3">
        {ANALYSIS.cycles.map((c, i) => {
          const nat = dossier[c.slug]?.natural_cycle;
          return (
            <a key={c.slug} href={cycleHref(c.slug)} className="block">
              <Card className="p-4 transition-colors hover:border-yin-light sm:p-5">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="min-w-0 text-[17px] font-bold tracking-tight">
                    <span className="me-2 tabular-nums text-ink-3/60">{i + 1}</span>
                    {c.body}
                    <span className="ms-2 text-[12px] font-normal text-ink-3">{c.period}</span>
                  </h2>
                  <span className="shrink-0 text-[15px] font-bold tabular-nums" style={{ color: AXIS_COLOR.why }}>{c.share}%</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
                  <span className="block h-full rounded-full bg-yang" style={{ width: `${Math.max(2, (c.share / maxShare) * 100)}%` }} />
                </div>
                <p className="mt-2 text-[12.5px] text-ink-3">
                  {c.dominant > 0
                    ? <>strongest rhythm for {c.dominant} field{c.dominant === 1 ? "" : "s"}{c.top.length ? <> — {c.top.slice(0, 3).map((t) => t.label).join(", ")}</> : null}</>
                    : "a faint background rhythm in the data"}
                  {nat ? <> · {nat}</> : null}
                </p>
              </Card>
            </a>
          );
        })}
      </div>
    </div>
  );
}

function CycleView({ stat, dossier, n }: { stat: CycleStat | null; dossier?: CycleRank; n: number }) {
  // An unknown slug has no citation and nothing contextual — one line of prose, so no rail.
  if (!stat) {
    return (
      <article className="mx-auto max-w-2xl py-8 sm:py-10">
        <a href={localePath("/cycles/")} className="mb-5 inline-flex text-[13px] text-ink-3 hover:text-yin-light"><span aria-hidden className="inline-block rtl:-scale-x-100">←</span> Cycles</a>
        <p className="text-[14px] text-ink-3">Unknown cycle.</p>
      </article>
    );
  }

  const cite = `ArtaQuest Foundation (2026). ${stat.body} (${stat.period}): a trend-fit analysis of ${dossier?.natural_cycle || "a celestial cycle"}. ArtaQuest. https://artaquest.com/cycles/?cycle=${stat.slug}`;
  /* Defined ONCE and rendered twice — in the desktop rail and, below lg, inline — so the two copies
     cannot drift. The citation is why a reader scrolls to the bottom of this page, and it was
     scrolling away with it; sticky in the rail, it is there the whole way down.
     data-ay-skip: the string is generated from the cycle's own data (body, period, natural cycle,
     URL), and the i18n mesh publishes every rendered string into the public aq_translations. */
  const citeCard = (
    <section className="flex flex-col gap-2 rounded-card border border-line bg-space-2 p-4">
      <h2 className="text-sm font-bold uppercase tracking-wider text-ink-3">How to cite</h2>
      <p data-ay-skip="1" className="select-all text-[12px] leading-relaxed text-ink-2">{cite}</p>
    </section>
  );

  return (
    <WithRail label="How to cite this cycle" rail={citeCard}>
      <article className="mx-auto min-w-0 max-w-2xl py-8 sm:py-10">
        <a href={localePath("/cycles/")} className="mb-5 inline-flex text-[13px] text-ink-3 hover:text-yin-light"><span aria-hidden className="inline-block rtl:-scale-x-100">←</span> Cycles</a>
        <header className="mb-4">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{stat.body}</h1>
          <p className="mt-1 text-[13px] text-ink-3">{stat.period}{dossier?.natural_cycle ? <> · {dossier.natural_cycle}</> : null}</p>
        </header>

        {dossier?.abstract && <p className="mb-5 text-[15px] leading-relaxed text-ink-2">{dossier.abstract}</p>}

        {dossier?.the_cycle_in_nature && (
          <section className="mb-5">
            <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">In the real world</h2>
            <Paras text={dossier.the_cycle_in_nature} />
            {dossier.discussion && <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{dossier.discussion}</p>}
          </section>
        )}

        <section className="mb-5">
          <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">What we found</h2>
          <p className="text-[14px] leading-relaxed text-ink-2">
            Across the {n} analysed fields, this rhythm explains about{" "}
            <span className="font-semibold" style={{ color: AXIS_COLOR.why }}>{stat.share}%</span> of how the world&rsquo;s
            curiosity rises and falls
            {stat.dominant > 0
              ? <> — and it&rsquo;s the strongest rhythm for <span className="font-semibold">{stat.dominant}</span> field{stat.dominant === 1 ? "" : "s"}</>
              : ", a faint background presence"}
            {stat.top.length ? <>, like{" "}
              {stat.top.slice(0, 6).map((t, j) => (
                <span key={t.key}>{j ? ", " : ""}<a href={fieldHref(t.key)} className="hover:text-yin-light">{t.label}</a></span>
              ))}</> : null}.
          </p>
          <p className="mt-1.5 text-[11.5px] text-ink-2/70">Computed from ArtaQuest&rsquo;s weekly analysis of {n} fields&rsquo; 20-year search trends.</p>
        </section>

        {dossier?.references && dossier.references.length > 0 && (
          <section className="mb-5">
            <h2 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Sources</h2>
            <ol className="space-y-1.5">
              {dossier.references.map((r) => (
                <li key={r.id} id={`ref-${r.id}`} className="text-[12px] leading-relaxed text-ink-3">
                  [{r.id}] {r.text}{" "}
                  {r.url && <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-yin-light hover:underline">↗</a>}
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* Below lg the rail leaves the flow, so the SAME card rides here — the citation must not
            disappear on a phone for want of a column. */}
        <RailInline>{citeCard}</RailInline>
      </article>
    </WithRail>
  );
}
