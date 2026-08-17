/**
 * Edit a work FROM ITS OWN PAGE (operator, 2026-07-31: "the contents must be editable in their page
 * by their users, skip the studio listing").
 *
 * The author used to have to leave the work, find it again in the Studio listing, edit it there and
 * come back — a round trip to change a typo in a title they were already looking at.
 *
 * TWO FIELDS, and that is not a simplification. `Notebook::save` accepts title and abstract only:
 * `ipynb` holds what we pulled from the author's Kaggle kernel, and sig() over that value is what
 * the confirm link, the review ledger and the database publish-guard are all keyed on. A client that
 * could write it would desync that signature from the notebook every check was read from — a green
 * checklist certifying source nobody checked. The code is edited on Kaggle and re-checked; the Lab
 * is for trying changes, not for changing the record.
 *
 * THE PENDING WARNING IS LOAD-BEARING. Saving while a publish request is out withdraws it back to
 * draft, because the author must only ever confirm exactly what they were shown — title and
 * abstract included, not just the notebook. That is correct behaviour and it must never be a
 * surprise, so it is stated before the save, not reported after it.
 */
import { useState } from "react";
import { Button } from "./ui";
import { deleteNotebook, saveNotebook, type NotebookFull } from "../lib/api";

const field =
  "w-full rounded-field border border-line bg-space-1 px-3 py-2 text-ink outline-none transition-colors focus:border-yin-light";

export function WorkEdit({
  nb,
  onSaved,
  onCancel,
}: {
  nb: NotebookFull;
  onSaved: (next: NotebookFull) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(nb.title);
  const [abstract, setAbstract] = useState(nb.abstract || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Compare TRIMMED to TRIMMED. Comparing the trimmed draft against the RAW record made `changed`
  // true on open whenever the stored title or abstract carried stray whitespace or a trailing
  // newline — so Save was live before the author had touched anything. Measured on prod: the button
  // was enabled the moment the editor opened. That is not merely untidy here: saving an unchanged
  // work whose status is `pending` WITHDRAWS the publication request, so a stray click on a button
  // that should have been dead would have cost the author their confirmation.
  const changed = title.trim() !== nb.title.trim() || abstract.trim() !== (nb.abstract || "").trim();
  const titleOk = title.trim().length >= 3; // matches Notebook::save's own floor
  const ready = changed && titleOk && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setErr("");
    try {
      const next = await saveNotebook(nb.id, { title: title.trim(), abstract: abstract.trim() });
      // The server answers with the whole updated work, so the page re-renders from the RECORD
      // rather than from what we hoped we saved — including a status that may have just moved back
      // to draft.
      onSaved(next);
    } catch {
      setErr("Couldn't save — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-card border border-yang/40 bg-space-2 p-4">
      <label className="block">
        <span className="mb-1 block text-[13px] font-medium text-ink-2">Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={160}
          autoFocus
          aria-invalid={!titleOk || undefined}
          className={`${field} text-[17px] font-bold`}
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[13px] font-medium text-ink-2">Abstract</span>
        <textarea
          value={abstract}
          onChange={(e) => setAbstract(e.target.value)}
          rows={4}
          maxLength={2000}
          className={`${field} resize-y text-[14px] leading-relaxed`}
        />
      </label>

      {nb.status === "pending" && changed ? (
        <p className="rounded-field border border-yang/40 bg-yang/10 px-3 py-2 text-[13px] leading-relaxed text-ink-2">
          Saving this withdraws your publication request — you'll be asked to confirm again, so that
          what you approve is exactly what is published.
        </p>
      ) : null}

      {err ? <p role="alert" className="text-[13px] text-yin-ink">{err}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={!ready} className="disabled:opacity-50">
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <span className="text-[12px] text-ink-3">The notebook itself is edited on Kaggle, then re-checked</span>
      </div>
    </form>
  );
}

/** The "Edit" affordance on the work's own page — nothing at all for anyone but the author. */
/**
 * DELETE, on the work's own page (operator 2026-08-16: "I want to be able to delete it here").
 *
 * The only delete lived in the Studio, so an author reading their own work had to remember where
 * else to go — and the Studio lists submissions, not the thing they are looking at. It sits beside
 * Edit because they are the same kind of act: this is mine, and I am changing it.
 *
 * The confirmation is a typed word rather than a native confirm(), and it says the two things that
 * cannot be taken back — a minted DOI keeps resolving to a deleted-by-author notice, and Zenodo's
 * archived copy is outside our control. Same wording as the Studio's, because it is the same act.
 */
export function DeleteWork({ own, id, doi }: { own: boolean; id: number; doi?: string }) {
  const [busy, setBusy] = useState(false);
  if (!own) return null;
  const drop = () => {
    const lines = [
      "This deletes the work permanently from ArtaQuest — the notebook copy, its published files, its comments and hearts.",
      doi ? "Its DOI stays a valid link and will say the work was deleted by its author. The copy Zenodo archived when it was published is outside our control." : "",
      "Your notebook on Kaggle is untouched.",
      "",
      "Type DELETE to confirm.",
    ].filter(Boolean).join("\n");
    if (window.prompt(lines) !== "DELETE") return;
    setBusy(true);
    deleteNotebook(id)
      .then(() => { window.location.href = "/works"; })
      .catch(() => setBusy(false));
  };
  return (
    <button type="button" onClick={drop} disabled={busy}
      className="inline-flex w-fit items-center gap-1.5 rounded-pill border border-line px-3 py-1 text-[13px] text-ink-3 transition-colors hover:border-rose-400/60 hover:text-rose-300 disabled:opacity-50">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
      </svg>
      {busy ? "Deleting…" : "Delete"}
    </button>
  );
}

export function EditLink({ own, onClick }: { own: boolean; onClick: () => void }) {
  if (!own) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex w-fit items-center gap-1.5 rounded-pill border border-line px-3 py-1 text-[13px] text-ink-2 transition-colors hover:border-yin-ink hover:text-ink"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 20h4l10-10a2.1 2.1 0 0 0-3-3L5 17v3z" /><path d="M13.5 6.5l4 4" />
      </svg>
      Edit title and abstract
    </button>
  );
}

/**
 * The work's numbers, on the work's own page (operator: "the content page must have analytics").
 *
 * Views are counted server-side in Notebook::get and EXCLUDE the author's own visits, so this is
 * what other people did — an author refreshing their page does not inflate it.
 *
 * Shown to everyone, because on this platform the whole database is public and hiding a view count
 * from readers while showing it to the author would be a private number on a public record. It is
 * deliberately plain: three figures, no trend arrows, no "performance" framing. The platform ranks
 * by hearts and reads by discussion; this is information, not a scoreboard.
 */
export function WorkStats({ nb }: { nb: NotebookFull }) {
  const rows: [string, number][] = [
    ["Views", nb.views || 0],
    ["Hearts", nb.hearts || 0],
    ["Comments", nb.comments || 0],
  ];
  return (
    <section className="flex flex-col gap-2 rounded-card border border-line bg-space-2 p-4">
      <h2 className="text-sm font-bold uppercase tracking-wider text-ink-3">Analytics</h2>
      <dl className="m-0 flex flex-col gap-1.5">
        {rows.map(([label, n]) => (
          <div key={label} className="flex items-baseline justify-between gap-3">
            <dt className="text-[13px] text-ink-2">{label}</dt>
            {/* The number is its own skipped node: the i18n mesh collects rendered strings into the
                public aq_translations table, and a live count would write a row per value. */}
            <dd className="m-0 text-[15px] font-bold tabular-nums text-ink" data-ay-skip="1">
              {n.toLocaleString()}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-xs leading-relaxed text-ink-3">
        Views count other people — your own visits to your work are not included.
      </p>
    </section>
  );
}
