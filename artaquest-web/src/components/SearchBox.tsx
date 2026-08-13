import { useEffect, useRef, useState } from "react";
import { localePath } from "../lib/wp";
import { listNotebooks, normalizeNbKind } from "../lib/api";
import { NB_KIND_META } from "./nbview";

type SearchHit = { url: string; title: string; sub?: string };
type SearchResults = { q: string; posts: SearchHit[] };
const EMPTY: SearchResults = { q: "", posts: [] };

function Group({ label, hits }: { label: string; hits: SearchHit[] }) {
  if (!hits.length) return null;
  return (
    <li role="none">
      <div className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-ink-2">{label}</div>
      <ul role="none">
        {hits.map((h) => (
          <li key={h.url} role="none">
            <a role="option" aria-selected="false" href={localePath(h.url)} className="block px-4 py-2 hover:bg-veil/5">
              <div className="truncate text-[14px] font-medium text-ink">{h.title}</div>
              {h.sub && <div className="truncate text-[12px] text-ink-3">{h.sub}</div>}
            </a>
          </li>
        ))}
      </ul>
    </li>
  );
}

export function SearchBox({ autoFocus = false }: { autoFocus?: boolean } = {}) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<SearchResults>(EMPTY);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Debounced fetch.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setRes(EMPTY); setLoading(false); return; }
    setLoading(true);
    const t = setTimeout(() => {
      listNotebooks({ q: term })
        .then((r) => {
          setRes({
            q: term,
            posts: r.items.slice(0, 8).map((nb) => ({
              url: `/nb/${nb.id}/${nb.slug}`,
              title: nb.title,
              sub: `${NB_KIND_META[normalizeNbKind(nb.kind)]?.label || nb.kind} · ${nb.author.name}`,
            })),
          });
          setLoading(false);
        })
        .catch(() => { setRes(EMPTY); setLoading(false); });
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  // Close on outside click / Escape.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, []);

  const total = res.posts.length;
  const showPanel = open && q.trim().length >= 2;

  // Enter → the first hit, else stay put (the inline panel IS the search surface now).
  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const first = res.posts[0];
    if (first) window.location.href = localePath(first.url);
  }

  return (
    <div ref={ref} className="relative max-w-[977px] flex-1">
      <form role="search" onSubmit={onSubmit}>
        <div className="flex h-[52px] items-center gap-2 rounded-pill border border-line bg-space-2 px-4 text-ink-3 focus-within:border-yin-light/60">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.5-4.5" strokeLinecap="round" /></svg>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setOpen(true)}
            autoFocus={autoFocus}
            placeholder="Search posts…"
            aria-label="Search ArtaQuest"
            className="h-full w-full bg-transparent text-[14px] text-ink placeholder:text-ink-2 focus:outline-none"
          />
        </div>
      </form>

      {/* SR-only status: announce result count / no-results as the query changes (WCAG 4.1.3) — the
          results panel is a visual listbox, so its count isn't conveyed to screen readers on type. */}
      <p className="sr-only" role="status" aria-live="polite">
        {q.trim().length >= 2 && !loading ? (total === 0 ? `No results for ${q.trim()}.` : `${total} result${total === 1 ? "" : "s"} for ${q.trim()}.`) : ""}
      </p>

      {showPanel && (
        <div className="absolute left-0 right-0 top-full z-40 mt-2 overflow-hidden rounded-card border border-line bg-space-1 shadow-2xl">
          {loading && total === 0 ? (
            <div className="px-4 py-5 text-[13px] text-ink-3">Searching…</div>
          ) : total === 0 ? (
            <div className="px-4 py-5 text-[13px] text-ink-3">No results for “{q.trim()}”.</div>
          ) : (
            <>
              <ul role="listbox" aria-label="Search results" className="max-h-[60vh] overflow-y-auto py-1">
                <Group label="Posts" hits={res.posts} />
              </ul>

            </>
          )}
        </div>
      )}
    </div>
  );
}
