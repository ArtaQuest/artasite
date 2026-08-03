import { useEffect, useState } from "react";
import { Competitions, type CompetitionCard } from "../lib/api";
import { Button, Card, Pill } from "../components/ui";
import { WithRail, RailInline } from "../components/PageRail";
import { localePath, relAgo } from "../lib/wp";

/* Trophy glyph — the competitions motif, matching the sidebar/Rankings icon set. */
function Trophy({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 4h8v4a4 4 0 0 1-8 0Z" /><path d="M4 5h4v3a2 2 0 0 1-4 0Z" /><path d="M20 5h-4v3a2 2 0 0 0 4 0Z" /><path d="M9 14h6l-1 6h-4Z" />
    </svg>
  );
}

const isOpen = (status: string) => ["open", "active"].includes(status.toLowerCase());

/** Time until a "YYYY-MM-DD HH:MM:SS" UTC deadline as a compact "27d" / "14h" — null once passed/absent. */
function closesIn(deadline: string): string | null {
  if (!deadline) return null;
  const t = new Date(deadline.replace(" ", "T") + "Z").getTime();
  if (!Number.isFinite(t)) return null;
  const ms = t - Date.now();
  if (ms <= 0) return null;
  const d = Math.floor(ms / 86400000);
  return d >= 1 ? `${d}d` : `${Math.max(1, Math.floor(ms / 3600000))}h`;
}

/** A competition's status → a plain, gently-toned label. `open` reads gold (live), everything else neutral. */
function StatusPill({ status, deadline }: { status: string; deadline: string }) {
  const open = isOpen(status);
  return (
    <span className={open
      ? "inline-flex items-center gap-1 rounded-pill bg-yang/15 px-2 py-0.5 text-[11px] font-semibold text-yang"
      : "inline-flex items-center gap-1 rounded-pill bg-veil/10 px-2 py-0.5 text-[11px] font-semibold text-ink-2"}>
      {open ? "Open" : status || "Closed"}{deadline ? ` · ${deadline}` : ""}
    </span>
  );
}

function CompetitionRow({ c }: { c: CompetitionCard }) {
  const left = isOpen(c.status) ? closesIn(c.deadline) : null;
  return (
    <a href={`${localePath("/competition/")}?slug=${encodeURIComponent(c.slug)}`} className="block">
      <Card className="p-4 transition-colors hover:border-yin-light sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[17px] font-bold tracking-tight">{c.title}</h2>
            <p className="mt-0.5 truncate text-[13px] text-ink-3">by {c.owner || "ArtaQuest"}</p>
          </div>
          {c.metric && <Pill className="shrink-0">{c.metric}</Pill>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-ink-3">
          <StatusPill status={c.status} deadline={c.deadline} />
          {left && (
            <span className="inline-flex items-center gap-1 rounded-pill bg-yin/15 px-2 py-0.5 text-[11px] font-semibold text-yin-light">
              closes in <span className="tabular-nums">{left}</span>
            </span>
          )}
          {c.prize > 0 && (
            <span className="inline-flex items-center rounded-pill bg-yang/15 px-2 py-0.5 text-[11px] font-bold text-yang">₳{c.prize} prize</span>
          )}
          {c.n_targets > 1 && (
            <span><span className="font-semibold tabular-nums text-ink-2">{c.n_targets.toLocaleString()}</span> topics</span>
          )}
          <span className="inline-flex items-center gap-1"><Trophy size={13} /> {c.n_teams} team{c.n_teams === 1 ? "" : "s"}</span>
          {c.best_score != null && Number.isFinite(c.best_score) && (
            <span>best <span className="font-semibold tabular-nums text-ink-2">{c.best_score.toFixed(5)}</span></span>
          )}
          {c.created ? <span>{relAgo(c.created)}</span> : null}
        </div>
      </Card>
    </a>
  );
}

/* The one contextual card on this page: what a competition IS (the hidden holdout) and the way in
   (host your own). It is not part of the list — it's the frame around it — so beside the list is
   where it belongs, not stacked on top of it pushing the first competition below the fold.
   Defined ONCE and handed to both <WithRail> and <RailInline>; two copies drift. */
const HostingCard = (
  <section className="flex flex-col gap-2 rounded-card border border-line bg-space-2 p-4">
    <h2 className="text-sm font-bold uppercase tracking-wider text-ink-3">How it works</h2>
    <p className="text-[13px] leading-relaxed text-ink-3">
      Host a dataset with a hidden holdout, or compete on someone else&rsquo;s. Submit your predictions,
      get scored on the held-out data you never see, and climb the leaderboard — the sharpest model wins.
    </p>
    <Button href="/competitions/new/" className="mt-1 self-start">New competition</Button>
  </section>
);

/* The /competitions hub — Kaggle-style: host a dataset with a hidden holdout, others compete on it.
   Cards link to each competition's detail (Overview / Data / Leaderboard / Submit / Rules tabs). */
export default function CompetitionsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [items, setItems] = useState<CompetitionCard[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    Competitions.list()
      .then((d) => setItems(d.items || []))
      .catch(() => setErr(true));
  }, []);

  // The list body — identical whether this is the standalone page or the Library tab.
  const list = err ? (
    <p className="text-[14px] text-ink-3">Couldn&rsquo;t load competitions. Please try again.</p>
  ) : items === null ? (
    <p className="text-[14px] text-ink-3">Loading…</p>
  ) : items.length === 0 ? (
    <Card className="p-8 text-center">
      <p className="text-[15px] font-semibold text-ink">No competitions yet</p>
      <p className="mt-1.5 text-[13px] text-ink-3">Be the first to host one — it starts a fresh leaderboard.</p>
      <Button href="/competitions/new/" className="mt-4">New competition</Button>
    </Card>
  ) : (
    <div className="space-y-3">
      {items.map((c) => <CompetitionRow key={c.slug} c={c} />)}
    </div>
  );

  // Embedded as the Library "Competitions" tab: drop the page frame + the h1 (the Library supplies the
  // hero) and open NO rail — the Library owns the page geometry, and a rail inside a rail's content
  // column just squeezes both. The same card renders in the flow instead, so the hidden-holdout
  // explainer (that's the review story) and the "New competition" CTA still travel with the tab.
  if (embedded) {
    return (
      <div className="flex flex-col gap-6">
        {HostingCard}
        {list}
      </div>
    );
  }

  return (
    /* No max-width and no px-* out here: AppShell already centres every page in max-w-content with
       px-gutter, and <WithRail> needs the full width to seat its 320px rail. The content column
       keeps its own max-w-3xl — the reading width this list has always had. */
    <div className="flex flex-col">
      <WithRail label="How competitions work" rail={HostingCard}>
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Competitions</h1>
          {/* Below lg the rail is out of the flow, so the same card reads here instead — above the
              list, exactly where the explainer used to sit. `hidden` on the wrapper means it is not
              a flex item at all on desktop, so it leaves no phantom gap. */}
          <RailInline>{HostingCard}</RailInline>
          {list}
        </div>
      </WithRail>
    </div>
  );
}
