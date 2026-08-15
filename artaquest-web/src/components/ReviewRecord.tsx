import { useState } from "react";
import { Link } from "react-router-dom";
import type { WorkReview } from "../lib/api";
import { localePath } from "../lib/wp";

const pretty = (key: string) =>
  key.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** One expandable round (verdict pill, 7-axis sub-scores, findings). Shared by the book-level list
 *  and each chapter's own list so the two read identically. */
function Round({ r, label, open, onToggle }: { r: WorkReview; label: string; open: boolean; onToggle: () => void }) {
  return (
    <li className="rounded-md border border-line bg-space-1/40">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-[13px]"
      >
        <span className="font-medium text-ink">
          {label}
          <span className="ms-2 text-[11.5px] font-normal text-ink-3">{r.reviewer}</span>
        </span>
        <span className="flex items-center gap-2">
          <span
            className={
              "rounded-full border border-line px-2 py-0.5 text-[11px] font-semibold " +
              (r.verdict === "pass" ? "text-yang" : "text-ink-3")
            }
          >
            {r.verdict === "pass" ? "Passed" : "Revise"}
          </span>
          <span className="text-ink-3">{r.score}/100</span>
          <span aria-hidden className="text-ink-3">{open ? "▴" : "▾"}</span>
        </span>
      </button>
      {open && (
        <div className="border-t border-line px-3 py-2.5 text-[13px] leading-relaxed text-ink-2">
          {r.report && <p className="whitespace-pre-wrap">{r.report}</p>}
          {r.scores && Object.keys(r.scores).length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(r.scores).map(([k, v]) => (
                <span key={k} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-3">
                  {k.replace(/_/g, " ")} <strong className="text-ink-2">{v}</strong>
                </span>
              ))}
            </div>
          )}
          {r.findings.length > 0 && (
            <ul className="mt-2 flex list-none flex-col gap-2">
              {r.findings.map((f, j) => (
                <li key={j} className="rounded-md border border-line bg-space-2/60 p-2.5">
                  {(f.quote || f.en_quote || f.bad) && (
                    <p className="mb-1 text-[12px] italic text-ink-3">“{f.quote || f.en_quote || f.bad}”</p>
                  )}
                  <p><strong className="text-ink">Finding:</strong> {f.problem}</p>
                  {f.fix && <p className="mt-0.5"><strong className="text-ink">Required fix:</strong> {f.fix}</p>}
                  {f.applied && <p className="mt-0.5 text-[11.5px] font-semibold text-yang">Resolved in the next round</p>}
                </li>
              ))}
            </ul>
          )}
          {r.model && <p className="mt-2 text-[11.5px] text-ink-3">Critic: {r.model}</p>}
        </div>
      )}
    </li>
  );
}

/** One chapter's own review process — its rounds collapse under a header showing the chapter's latest
 *  verdict. Makes "each chapter is reviewed separately" visible on the page. */
function ChapterBlock({ name, rounds }: { name: string; rounds: WorkReview[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const latest = rounds[rounds.length - 1];
  return (
    <li className="rounded-md border border-line bg-space-1/30 p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-ink">{pretty(name)}</span>
        <span className="flex items-center gap-2">
          <span
            className={
              "rounded-full border border-line px-2 py-0.5 text-[11px] font-semibold " +
              (latest.verdict === "pass" ? "text-yang" : "text-ink-3")
            }
          >
            {latest.verdict === "pass" ? "Passed" : "Revise"}
          </span>
          <span className="text-[11.5px] text-ink-3">round {latest.round} · {latest.score}/100</span>
        </span>
      </div>
      <ul className="flex list-none flex-col gap-1.5">
        {rounds.map((r, i) => (
          <Round key={`${name}-${r.round}-${i}`} r={r} label={`Round ${r.round}`} open={open === i} onToggle={() => setOpen(open === i ? null : i)} />
        ))}
      </ul>
    </li>
  );
}

/** The UNIFIED public adversarial-review record shown on every published work (books, films,
 *  narrations) — the same open process ArtaScience runs for papers: hostile AI critics score each
 *  round, list what must change, and nothing publishes until a round passes. Books additionally carry
 *  a SEPARATE review process per chapter (operator mandate 2026-07-03), shown below the book rounds. */
export default function ReviewRecord({ reviews, kind }: { reviews: WorkReview[]; kind: string }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!reviews?.length) return null;

  const bookRounds = reviews.filter((r) => !r.chapter);
  const rounds = bookRounds.length ? bookRounds : reviews; // fall back to flat if no book-level aggregate yet
  const last = rounds[rounds.length - 1];

  // Group chapter-scoped rounds by chapter, preserving round order within each.
  const byChapter = new Map<string, WorkReview[]>();
  for (const r of reviews) {
    if (!r.chapter) continue;
    const arr = byChapter.get(r.chapter) || [];
    arr.push(r);
    byChapter.set(r.chapter, arr);
  }
  for (const arr of byChapter.values()) arr.sort((a, b) => a.round - b.round);

  return (
    <section aria-label="Adversarial review record" className="mt-6">
      <h2 className="mb-2 text-[15px] font-semibold uppercase tracking-[0.14em] text-ink-3">
        Adversarial review · {rounds.length} {rounds.length === 1 ? "round" : "rounds"}
      </h2>
      <p className="mb-2 text-[12.5px] text-ink-3">
        Before this {kind} was published, independent AI critics attacked it — facts, logic, craft — and it
        could not publish until a round passed. Every round is public, findings and all: the same open
        process <Link to={localePath("/artascience/")} className="font-medium text-yin-ink hover:underline">ArtaScience</Link> runs
        for research papers.
      </p>
      <ul className="flex list-none flex-col gap-1.5">
        {rounds.map((r, i) => (
          <Round key={`book-${r.round}-${i}`} r={r} label={`Round ${r.round}`} open={open === i} onToggle={() => setOpen(open === i ? null : i)} />
        ))}
      </ul>

      {byChapter.size > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.12em] text-ink-3">
            Per-chapter review · {byChapter.size} {byChapter.size === 1 ? "chapter" : "chapters"}
          </h3>
          <p className="mb-2 text-[12px] text-ink-3">
            Each chapter is reviewed as its own separate process, and a pass only counts once a second,
            independent critic confirms it. When every chapter has passed, the whole book must still clear a
            cross-chapter coherence round before it can publish.
          </p>
          <ul className="flex list-none flex-col gap-1.5">
            {[...byChapter.entries()].map(([name, rs]) => (
              <ChapterBlock key={name} name={name} rounds={rs} />
            ))}
          </ul>
        </div>
      )}

      {last.verdict === "pass" && (
        <p className="mt-2 text-[12px] text-ink-3">
          Published after round {last.round} passed at {last.score}/100.
        </p>
      )}
    </section>
  );
}
