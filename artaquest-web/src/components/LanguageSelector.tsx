import { useEffect, useId, useMemo, useRef, useState } from "react";
import { availableLangs, currentLang } from "../lib/i18n";
import { switchLang } from "../lib/geo";
import { useViewportNudge } from "./ui";

// Diacritic- and case-insensitive fold for the language search, so an ASCII approximation of a
// native name still matches: "espanol" → "Español", "turkce" → "Türkçe", "francais" → "Français".
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const Globe = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </svg>
);

/**
 * Language selector — pick any of the supported languages (the full Google set,
 * ~133). Selecting one persists a sticky preference and reloads into that
 * language; the server re-renders the shell and the client mesh translates the
 * whole page.
 *
 * Combobox-pattern keyboard support (essential for a 133-item list): the search
 * filters by native name / English name / code; ↑↓ move a highlight, Enter
 * selects, Home/End jump, Esc closes. The active language is pinned to the top.
 * `compact` for the top nav, full-width for the sidebar foot.
 */
export function LanguageSelector({ compact = false }: { compact?: boolean } = {}) {
  const langs = availableLangs();
  const cur = currentLang();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Thin phones: the 288px compact panel end-aligns to a trigger sitting mid-row — nudge it back
  // inside the viewport instead of letting its start edge clip off-screen.
  useViewportNudge(panelRef, open);
  const close = (focusBtn = false) => { setOpen(false); if (focusBtn) btnRef.current?.focus(); };
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optId = (i: number) => `${baseId}-opt-${i}`;

  const active = useMemo(() => langs.find((l) => l.code === cur) ?? langs[0], [langs, cur]);

  // Filtered + (when not searching) current language pinned to the top.
  const ordered = useMemo(() => {
    const s = fold(q.trim());
    if (s) {
      return langs.filter((l) =>
        fold(l.native).includes(s) || fold(l.name).includes(s) || l.code.toLowerCase().includes(s),
      );
    }
    const curL = langs.find((l) => l.code === cur);
    const rest = langs.filter((l) => l.code !== cur);
    return curL ? [curL, ...rest] : langs;
  }, [langs, q, cur]);

  // Open/close wiring: outside-click + Esc close, focus the search on open.
  useEffect(() => {
    if (!open) return;
    setActiveIdx(0);
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    const t = setTimeout(() => searchRef.current?.focus(), 30);
    return () => { document.removeEventListener("mousedown", onDoc); clearTimeout(t); };
  }, [open]);

  // Keep the highlight in range as the filter narrows, and scroll it into view.
  useEffect(() => { setActiveIdx((i) => Math.min(i, Math.max(0, ordered.length - 1))); }, [ordered.length]);
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[activeIdx];
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, ordered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Home") { e.preventDefault(); setActiveIdx(0); }
    else if (e.key === "End") { e.preventDefault(); setActiveIdx(ordered.length - 1); }
    else if (e.key === "Enter") { e.preventDefault(); const l = ordered[activeIdx]; if (l) switchLang(l.code); }
    else if (e.key === "Escape") { e.preventDefault(); close(true); }
  }

  // No registry → nothing to switch (keeps the shell happy when AQ_I18N is absent).
  if (!langs.length || !active) return null;

  return (
    <div ref={ref} className={compact ? "relative" : "relative px-3 py-3"}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Language: ${active.name}. Change language`}
        className={compact
          ? "flex items-center gap-1.5 rounded-pill border border-line px-2.5 py-1.5 text-[13px] text-ink-2 transition-colors hover:text-ink sm:px-3"
          : "flex w-full items-center gap-2.5 rounded-card px-3 py-2 text-[14px] text-ink-2 transition-colors hover:bg-veil/5 hover:text-ink"}
      >
        {/* Phones get the bare code pill — globe + chevron hide so the topbar row (lockup,
            theme toggle, language, account/CTA) fits a 360px viewport instead of clipping
            off-screen (ticket #47). */}
        <span aria-hidden className={compact ? "hidden text-ink-3 sm:inline" : "text-ink-3"}>{Globe}</span>
        {compact ? (
          <>
            {/* Desktop: native name. Mobile: the short code, so the active language is still visible. */}
            <span className="hidden sm:inline"><bdi dir={active.dir} data-ay-skip="1">{active.native}</bdi></span>
            <span className="text-[12px] font-semibold uppercase sm:hidden" data-ay-skip="1">{active.code.split("-")[0]}</span>
          </>
        ) : (
          <span className="flex-1 text-left"><bdi dir={active.dir} data-ay-skip="1">{active.native}</bdi></span>
        )}
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" className={`text-ink-3 transition-transform ${open ? "rotate-180" : ""} ${compact ? "hidden sm:block" : ""}`} aria-hidden>
          <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          ref={panelRef}
          className={`absolute z-50 rounded-card border border-line bg-space-2 py-1.5 shadow-2xl ${compact ? "end-0 top-full mt-2 w-72 max-w-[calc(100vw-1.5rem)]" : "bottom-full left-3 right-3 mb-2"}`}
        >
          <div className="flex items-center gap-2 px-3 pb-2 pt-1">
            <span className="text-ink-3">{Globe}</span>
            <input
              ref={searchRef}
              type="text"
              value={q}
              onChange={(e) => { setQ(e.target.value); setActiveIdx(0); }}
              onKeyDown={onKeyDown}
              placeholder="Search languages…"
              aria-label="Search languages"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={ordered[activeIdx] ? optId(activeIdx) : undefined}
              className="h-8 w-full rounded-field border border-line bg-space-1 px-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:border-yin-light focus:outline-none"
            />
          </div>
          <ul ref={listRef} id={listId} role="listbox" aria-label="Select your language" className="max-h-[50vh] overflow-y-auto">
            {ordered.map((l, i) => {
              const isActive = l.code === active.code;
              const isHi = i === activeIdx;
              return (
                <li key={l.code} role="none">
                  <button
                    id={optId(i)}
                    role="option"
                    type="button"
                    tabIndex={-1}
                    onClick={() => switchLang(l.code)}
                    onMouseEnter={() => setActiveIdx(i)}
                    aria-selected={isActive}
                    lang={l.code}
                    dir={l.dir}
                    data-ay-skip="1"
                    className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-[14px] transition-colors ${
                      isHi ? "bg-veil/[0.07]" : ""
                    } ${isActive ? "font-semibold text-yang" : "text-ink-2 hover:text-ink"}`}
                  >
                    <bdi className="truncate">{l.native}</bdi>
                    <span className={`shrink-0 text-[12px] ${isActive ? "text-yang" : "text-ink-3"}`}>{l.name}</span>
                  </button>
                </li>
              );
            })}
            {ordered.length === 0 && <li role="none" className="px-4 py-3 text-[13px] text-ink-3">No languages match “{q}”.</li>}
          </ul>
          {/* ArtaTranslate transparency — every language here is continuously upgraded by it. */}
          <div className="border-t border-line px-4 pb-1 pt-2">
            <a href="/artatranslate" className="text-[12px] font-semibold text-yin-light hover:underline">
              How these translations are made and improved →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
