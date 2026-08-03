/**
 * The Library (/library) — every file the platform has published, in one browsable shelf.
 *
 * A file lands here when the public Kaggle notebook that produced it cleared the reproducibility
 * checklist and its author published it. The point of the shelf is re-use without ownership: any
 * member can attach any of these to their own post, and the provenance — the work, its author, the
 * notebook on Kaggle, its permanent link — travels with the file.
 */
import { useCallback, useEffect, useState } from "react";
import { libraryItems, type LibraryItem } from "../lib/api";
import { isLoggedIn } from "../lib/wp";
import {
  Chip, EmptyState, LoadMoreButton, PageHero, SearchPill, SkeletonGrid, StatusNote, Toolbar,
} from "../components/ui";
import { LibraryCard, LIBRARY_CLASSES } from "../components/library";

export default function Library() {
  const logged = isLoggedIn();
  const [q, setQ] = useState("");
  const [cls, setCls] = useState("");
  const [mine, setMine] = useState(false);
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    setItems(null); setErr("");
    const term = q.trim();
    const h = setTimeout(() => {
      libraryItems({ ...(cls ? { class: cls } : {}), ...(term ? { q: term } : {}), ...(mine ? { mine: true } : {}) })
        .then((p) => { if (live) { setItems(p.items); setNext(p.next); } })
        .catch(() => {
          if (!live) return;
          setItems([]); setNext(null);
          // The shared Library is a network surface and there is no honest way to show it offline.
          // Say which of the two it is, and point at My Library — anything already saved onto this
          // device plays with no connection, which is the answer the member actually needs.
          setErr(navigator.onLine === false
            ? "You're offline, so the shared Library can't load. Anything you saved onto this device is in My Library and still plays."
            : "The Library could not load — try again shortly.");
        });
    }, term ? 250 : 0);
    return () => { live = false; clearTimeout(h); };
  }, [q, cls, mine]);

  const loadMore = useCallback(async () => {
    if (next == null) return;
    setMore(true);
    try {
      const term = q.trim();
      const p = await libraryItems({
        ...(cls ? { class: cls } : {}),
        ...(term ? { q: term } : {}),
        ...(mine ? { mine: true } : {}),
        cursor: next,
      });
      setItems((cur) => [...(cur ?? []), ...p.items]);
      setNext(p.next);
    } catch {
      setErr("The Library could not load — try again shortly.");
    } finally {
      setMore(false);
    }
  }, [next, q, cls, mine]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <PageHero
        eyebrow="Published files"
        title="Library"
        lede="Every file here came out of a public Kaggle notebook that passed the reproducibility checklist, and its author published it. Anyone may attach any of them to their own post — you do not need to own a file to use it, because the work it came from, its author and its links travel with it."
      />

      <Toolbar
        search={<SearchPill placeholder="Search by file name" value={q} onChange={setQ} />}
        filters={LIBRARY_CLASSES.map((c) => (
          <Chip key={c.key || "all"} active={cls === c.key} onClick={() => setCls(c.key)}>{c.label}</Chip>
        ))}
        trailing={logged ? (
          <Chip active={mine} onClick={() => setMine((m) => !m)}>Mine</Chip>
        ) : undefined}
      />

      {err && items && items.length > 0 ? <StatusNote error>{err}</StatusNote> : null}

      {items === null ? (
        <SkeletonGrid count={8} />
      ) : err && items.length === 0 ? (
        <StatusNote error>{err}</StatusNote>
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing here yet"
          body={mine
            ? "You have not published a file yet. Bring a public Kaggle notebook you have run, clear the checklist, and its output files land here."
            : "No published file matches that. Try another word, or clear the filter."}
        />
      ) : (
        <>
          <ul className="grid list-none grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4">
            {items.map((it) => (
              <li key={it.id} className="min-w-0">
                <LibraryCard item={it} />
              </li>
            ))}
          </ul>
          {next != null ? <LoadMoreButton onClick={loadMore} loading={more} /> : null}
        </>
      )}
    </div>
  );
}
