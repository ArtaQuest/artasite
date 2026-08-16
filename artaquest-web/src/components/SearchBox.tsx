import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { localePath } from "../lib/wp";
import { listNotebooks, normalizeNbKind, searchMembers, type MemberCard } from "../lib/api";
import { NB_KIND_META } from "./nbview";
import { Avatar } from "./ui";

type SearchHit = { url: string; title: string; sub?: string; person?: MemberCard };
type SearchResults = { q: string; people: SearchHit[]; posts: SearchHit[] };
const EMPTY: SearchResults = { q: "", people: [], posts: [] };

/**
 * RECENT SEARCHES — the field forgot everything the moment it closed, which is the one thing a
 * search box is expected to remember. Reddit and X both open on your last few queries, and it is
 * the cheapest help there is: the query you want next is usually one you have typed before.
 *
 * On the device only (localStorage), never sent anywhere. This platform publishes its entire
 * database, so a member's search history must never become a row in it. Storage can be blocked
 * (private mode, a strict browser); every read and write is guarded, and where it is blocked the
 * feature simply does not appear.
 */
const RECENT_KEY = "aq_recent_searches";
const RECENT_MAX = 6;
function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch { return []; }
}
function writeRecent(list: string[]) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch { /* storage blocked */ }
}

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
                  <Avatar src={h.person.avatar} name={h.person.name}
                    className="h-8 w-8 shrink-0 text-[12px] text-ink ring-1 ring-yin-light/40" />
                ) : null}
                <span className="min-w-0 flex-1">
                  {/* A PERSON'S NAME IS NEVER SHORTENED (operator 2026-08-16): it wraps and the
                      type steps down. A post's TITLE still truncates — a title is a sentence whose
                      first line identifies it; half a name identifies nobody. */}
                  <span className={`block font-medium text-ink ${h.person ? `break-words leading-tight ${h.title.length > 26 ? "text-[12px]" : h.title.length > 18 ? "text-[13px]" : "text-[14px]"}` : "truncate text-[14px]"}`}>{h.title}</span>
                  {h.sub && <span className={`block text-[12px] text-ink-3 ${h.person ? "break-all leading-tight" : "truncate"}`}>{h.sub}</span>}
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

  // "/" jumps to search, as it does on X, Reddit and GitHub — but only for the field that is
  // actually on screen (the header's at md+, the sheet's on a phone), and never while the member is
  // typing somewhere else. Without the visibility test both instances would grab the same keypress
  // and the hidden one would win by mounting order.
  useEffect(() => {
    const onSlash = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const input = inputRef.current;
      if (!input || input.offsetParent === null) return;
      e.preventDefault();
      input.focus();
    };
    document.addEventListener("keydown", onSlash);
    return () => document.removeEventListener("keydown", onSlash);
  }, []);

  // The last few queries, read once on mount so a blocked localStorage costs nothing per render.
  const [recent, setRecent] = useState<string[]>(() => readRecent());
  const remember = useCallback((term: string) => {
    const t = term.trim();
    if (t.length < 2) return;
    setRecent((cur) => {
      const next = [t, ...cur.filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, RECENT_MAX);
      writeRecent(next);
      return next;
    });
  }, []);
  const forget = useCallback((term: string) => {
    setRecent((cur) => { const next = cur.filter((x) => x !== term); writeRecent(next); return next; });
  }, []);

  // One flat list for the arrow keys, People first — the order the panel renders them in.
  const hits = useMemo(() => [...res.people, ...res.posts], [res]);
  const total = hits.length;
  const showPanel = open && q.trim().length >= 2;

  // Enter → the highlighted hit, else the first one; nothing to open leaves the member where they
  // are (the inline panel IS the search surface — there is no results page to land on).
  function go(hit?: SearchHit) {
    if (!hit) return;
    remember(q);
    window.location.href = localePath(hit.url);
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

      {/* AN EMPTY, FOCUSED FIELD SHOWS YOUR LAST FEW QUERIES rather than nothing at all — the one
          thing a search box is expected to remember, and it never leaves the device. */}
      {open && q.trim().length < 2 && recent.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-40 mt-2 overflow-hidden rounded-card border border-line bg-space-1 shadow-2xl">
          <div className="flex items-baseline justify-between px-4 pb-1 pt-3">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-2">Recent</span>
            <button type="button" onClick={() => { setRecent([]); writeRecent([]); }}
              className="text-[12px] font-semibold text-ink-3 transition-colors hover:text-yang">Clear all</button>
          </div>
          <ul className="pb-1">
            {recent.map((term) => (
              <li key={term} className="flex items-center gap-2 px-2 hover:bg-veil/5">
                <button type="button" onClick={() => { setQ(term); inputRef.current?.focus(); }}
                  className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-2 text-start">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden className="shrink-0 text-ink-3"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" strokeLinecap="round" /></svg>
                  <span className="truncate text-[14px] text-ink">{term}</span>
                </button>
                <button type="button" onClick={() => forget(term)} aria-label={`Forget ${term}`}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-veil/10 hover:text-ink">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

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
