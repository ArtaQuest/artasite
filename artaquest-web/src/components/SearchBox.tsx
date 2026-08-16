import { useEffect, useMemo, useRef, useState } from "react";
import { localePath } from "../lib/wp";
import { listNotebooks, normalizeNbKind, searchMembers, type MemberCard } from "../lib/api";
import { NB_KIND_META } from "./nbview";
import { Avatar } from "./ui";

type SearchHit = { url: string; title: string; sub?: string; person?: MemberCard };
type SearchResults = { q: string; people: SearchHit[]; posts: SearchHit[] };
const EMPTY: SearchResults = { q: "", people: [], posts: [] };

/**
 * SEARCH LIVES ON THE RIGHT (operator 2026-08-15, "make it more like X").
 *
 * X puts search at the top of the right column on desktop and behind a magnifier on a phone —
 * never spanning the middle of the page, where it competes with the timeline it searches. This
 * component is the field itself and is deliberately width-agnostic (`w-full`): the RAIL decides how
 * wide it is, not the field. It previously carried `max-w-[977px] flex-1`, which is meaningless in
 * a flex COLUMN (flex-1 would have grown its height, not its width) — so it could not be dropped
 * into a rail as-is.
 *
 * `compact` is the topbar variant used on pages that have no rail of their own.
 */
function Group({ label, hits, cursor, base }: { label: string; hits: SearchHit[]; cursor: number; base: number }) {
  if (!hits.length) return null;
  return (
    <li role="none">
      <div className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-ink-2">{label}</div>
      <ul role="none">
        {hits.map((h, i) => {
          const on = base + i === cursor;
          return (
            <li key={h.url} role="none">
              <a
                role="option"
                id={`aq-search-opt-${base + i}`}
                aria-selected={on}
                href={localePath(h.url)}
                className={`flex items-center gap-2.5 px-4 py-2 ${on ? "bg-veil/[0.08]" : "hover:bg-veil/5"}`}
              >
                {/* A person is a face first — the same avatar the feed and the rail show, so one
                    member is recognisable in every list on the platform. */}
                {h.person ? (
                  <Avatar src={h.person.avatar} name={h.person.name} country={h.person.country}
                    className="h-8 w-8 shrink-0 text-[12px] text-ink ring-1 ring-yin-light/40" />
                ) : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-ink">{h.title}</span>
                  {h.sub && <span className="block truncate text-[12px] text-ink-3">{h.sub}</span>}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

export function SearchBox({ autoFocus = false, compact = false }: { autoFocus?: boolean; compact?: boolean } = {}) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<SearchResults>(EMPTY);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // Which hit the arrow keys are on. -1 = none (Enter then takes the first, as before).
  const [cursor, setCursor] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced fetch.
  useEffect(() => {
    const term = q.trim();
    setCursor(-1);
    if (term.length < 2) { setRes(EMPTY); setLoading(false); return; }
    setLoading(true);
    const t = setTimeout(() => {
      // PEOPLE AND POSTS TOGETHER (operator 2026-08-16: "it should be able to show all users"). The
      // field searched works only, so typing a member's name found nothing and read as broken.
      // allSettled, not all: one half failing must never blank the other.
      Promise.allSettled([searchMembers(term), listNotebooks({ q: term })])
        .then(([people, posts]) => {
          setRes({
            q: term,
            people: people.status === "fulfilled" ? people.value.items.slice(0, 6).map((m) => ({
              url: `/u/${m.slug}`,
              title: m.name,
              sub: `@${m.slug}${m.followers ? ` · ${m.followers} follower${m.followers === 1 ? "" : "s"}` : ""}`,
              person: m,
            })) : [],
            posts: posts.status === "fulfilled" ? posts.value.items.slice(0, 8).map((nb) => ({
              url: `/nb/${nb.id}/${nb.slug}`,
              title: nb.title,
              sub: `${NB_KIND_META[normalizeNbKind(nb.kind)]?.label || nb.kind} · ${nb.author.name}`,
            })) : [],
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

  // One flat list for the arrow keys, People first — the order the panel renders them in.
  const hits = useMemo(() => [...res.people, ...res.posts], [res]);
  const total = hits.length;
  const showPanel = open && q.trim().length >= 2;

  // Enter → the highlighted hit, else the first one; nothing to open leaves the member where they
  // are (the inline panel IS the search surface — there is no results page to land on).
  function go(hit?: SearchHit) {
    if (hit) window.location.href = localePath(hit.url);
  }
  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    go(hits[cursor >= 0 ? cursor : 0]);
  }
  // Arrow keys walk the list, X-style, without leaving the field.
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showPanel || !total) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => (c + 1) % total); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => (c <= 0 ? total - 1 : c - 1)); }
  }

  const h = compact ? "h-10" : "h-11";
  return (
    <div ref={ref} className="relative w-full">
      <form role="search" onSubmit={onSubmit}>
        {/* X's field: a filled pill that turns into an outlined one on focus, with the magnifier
            taking the accent. No border colour shift on hover — the field is a utility, not a CTA. */}
        <div className={`flex ${h} items-center gap-2.5 rounded-pill border border-transparent bg-space-2 px-4 text-ink-3 transition-colors focus-within:border-yin-light/70 focus-within:bg-space-1 focus-within:text-yin-ink`}>
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden className="shrink-0"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.5-4.5" strokeLinecap="round" /></svg>
          <input
            ref={inputRef}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            autoFocus={autoFocus}
            placeholder="Search ArtaQuest"
            aria-label="Search ArtaQuest"
            role="combobox"
            aria-expanded={showPanel}
            aria-controls="aq-search-results"
            aria-activedescendant={showPanel && cursor >= 0 ? `aq-search-opt-${cursor}` : undefined}
            className="h-full w-full bg-transparent text-[14px] text-ink placeholder:text-ink-2 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {/* Clearing a query is one tap, not a held backspace — the native search clear is hidden
              above so the control is the same on every browser. */}
          {q ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => { setQ(""); inputRef.current?.focus(); }}
              className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-yin/70 text-on-accent transition-opacity hover:opacity-80"
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          ) : null}
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
            <ul id="aq-search-results" role="listbox" aria-label="Search results" className="max-h-[60vh] overflow-y-auto py-1">
              <Group label="People" hits={res.people} cursor={cursor} base={0} />
              <Group label="Posts" hits={res.posts} cursor={cursor} base={res.people.length} />
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
