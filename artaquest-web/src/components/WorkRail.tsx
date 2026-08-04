/**
 * The work's right-rail cards — run it, cite it, take the files.
 *
 * Its own module, not a page export, because BOTH the work page and the Lab mount it. When it lived
 * in NotebookPage.tsx, importing it into the editor dragged the entire work page — hero stage,
 * comment thread, checklist — into the Lab's chunk for the sake of two cards.
 *
 * One definition also means the desktop rail and the phone stack (<RailInline>) cannot drift, and
 * that "run it" and "cite it" mean the same thing whether you are reading the work or editing it.
 */
import { useState } from "react";
import { Button } from "./ui";
import { SaveOffline } from "./library";
import { RunTiers } from "./runtiers";
import { WorkStats } from "./WorkEdit";
import { fmtBytes } from "../lib/bytes";
import { NB_KIND_META } from "./nbview";
import { normalizeNbKind, type NotebookFull } from "../lib/api";

function bibtex(nb: NotebookFull) {
  const year = new Date((nb.published_at || nb.created) * 1000).getUTCFullYear();
  const key = `${(nb.author.slug || "artaquest").replace(/[^a-z0-9]/gi, "")}${year}nb${nb.id}`;
  return [
    `@misc{${key},`,
    `  author = {${nb.kaggle?.author || nb.author.name}},`,
    `  title  = {${nb.title}},`,
    `  year   = {${year}},`,
    `  howpublished = {ArtaQuest ${NB_KIND_META[normalizeNbKind(nb.kind)]?.label || nb.kind}},`,
    `  url    = {${nb.doi_link || `https://artaquest.com/nb/${nb.id}/${nb.slug}`}},`,
    `  note   = {Public Kaggle notebook, checked against Kaggle's public record on ArtaQuest}`,
    `}`,
  ].join("\n");
}

export function CiteBox({ nb }: { nb: NotebookFull }) {
  const [copied, setCopied] = useState("");
  const copy = (label: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(label); setTimeout(() => setCopied(""), 1600); });
  };
  return (
    <aside className="flex flex-col gap-3 rounded-card border border-line bg-space-2 p-4">
      <h2 className="text-sm font-bold uppercase tracking-wider text-ink-3">Cite this work</h2>
      {nb.doi_link ? (
        <button type="button" onClick={() => copy("doi", nb.doi_link)} className="break-all text-left text-sm text-yin-ink hover:underline" title="Copy the permanent link">
          {nb.doi_link.replace(/^https?:\/\//, "")}
        </button>
      ) : (
        <p className="text-xs text-ink-3">The permanent link is being minted.</p>
      )}
      {/* Citation only. Running the work is a three-tier ladder with its own card (RunTiers) —
          mixing "how to cite this" with "how to run this" made both harder to find, and the run
          buttons carried no hint that the tiers differ in what they cost and what they prove. */}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => copy("bibtex", bibtex(nb))}>Copy BibTeX</Button>
      </div>
      {copied ? <p className="text-xs text-yang-ink">Copied the {copied === "doi" ? "permanent link" : "BibTeX entry"}.</p> : null}

    </aside>
  );
}

/**
 * The work's right-rail cards, in one place.
 *
 * Rendered twice per page — in the desktop rail and, below lg, inline — so they must be defined
 * once or the two copies drift. The Lab mounts the same component beside the editor, which is what
 * makes "run it" and "cite it" mean the same thing whether you are reading the work or editing it.
 */
export function WorkRail({ nb }: { nb: NotebookFull }) {
  return (
    <>
      {/* Running it comes BEFORE citing it: a reader who has just seen the work wants to try it,
          and the citation is what they want after they believe it. */}
      <RunTiers id={nb.id} slug={nb.slug} kaggleUrl={nb.kaggle?.url || nb.kaggle_url || ""} colabUrl={nb.colab_url} />
      <CiteBox nb={nb} />
      {/* Analytics on the work's own page (operator 2026-07-31), not buried in the Studio. */}
      <WorkStats nb={nb} />
      {nb.files?.length ? (
        <section className="flex flex-col gap-2 rounded-card border border-line bg-space-2 p-4">
          <h2 className="text-sm font-bold uppercase tracking-wider text-ink-3">Published files</h2>
          <ul className="flex list-none flex-col gap-1.5 p-0">
            {nb.files.map((f) => (
              <li key={f.id}>
                <a href={f.url} target="_blank" rel="noopener noreferrer nofollow" className="flex items-baseline gap-2 text-sm text-yin-ink hover:underline">
                  <span className="truncate" data-ay-skip="1">{f.label}</span>
                  <span className="ml-auto shrink-0 text-xs text-ink-3" data-ay-skip="1">{fmtBytes(f.bytes)}</span>
                </a>
                <SaveOffline item={f} />
              </li>
            ))}
          </ul>
          <p className="text-xs leading-relaxed text-ink-3">
            Each file came out of the Kaggle run below and is mirrored here, so it outlives that
            copy. Any member can attach these to a post from the Library.
          </p>
        </section>
      ) : null}
    </>
  );
}
