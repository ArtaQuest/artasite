/**
 * The place-of-birth picker: type a few letters, choose a real city, keep its coordinates.
 *
 * A COMBOBOX, not a <select>. There are 34,078 cities in the gazetteer — a native select is
 * unusable at that size on every platform, and a free-text box gives us "tehran", "Tehrān", "Tehran,
 * Iran" and "teheran" for one place, none of which carries a coordinate. So: an input that searches,
 * a listbox that answers, and a picked value that is a ROW rather than a string.
 *
 * The value is only ever set by CHOOSING. Typing narrows the list and nothing else; a member who
 * types "Teh" and walks away has selected nothing, and the form says so rather than storing a
 * fragment. That is the whole reason this is not an autocomplete over a text field.
 *
 * Mobile first: the list is a full-width sheet under the input with 44px rows, it does not trap
 * scroll, and the input keeps `inputMode="search"` + `autoCapitalize="words"` so a phone keyboard
 * behaves. Desktop gets the same thing with keyboard navigation — ↑↓ move, Enter picks, Escape
 * closes — and the ARIA combobox pattern so a screen reader announces the count and the active row.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { cx } from "./ui";
import { searchCities, cityForTimezone, type City } from "../lib/api";

/** ISO 3166 alpha-2 → the reader's own name for that country, from the platform's active language. */
const REGION = (() => {
  try {
    const dn = new Intl.DisplayNames([document.documentElement.lang || "en"], { type: "region" });
    return (cc: string) => { try { return dn.of(cc.toUpperCase()) || cc; } catch { return cc; } };
  } catch {
    return (cc: string) => cc;
  }
})();

export default function CitySelect({ value, onPick, onClear, id, required, invalid, suggestFromTimezone, placeholder = "Start typing a city…" }: {
  /** The chosen city's display label, or "" when nothing is chosen. */
  value: string;
  onPick: (city: City) => void;
  onClear: () => void;
  id?: string;
  required?: boolean;
  invalid?: boolean;
  /** Offer the member their own city, derived from the browser's timezone. For WHERE THEY LIVE only
   *  — a birthplace is not where you are now, and suggesting one would be inventing a fact. */
  suggestFromTimezone?: boolean;
  placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<City[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const [hint, setHint] = useState<City | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const seq = useRef(0);

  // Debounced search. Every response carries the query number it answered, so a slow reply for "te"
  // can never overwrite the list for "tehr" — the classic autocomplete race.
  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 2) { setItems([]); setBusy(false); return; }
    setBusy(true);
    const mine = ++seq.current;
    const t = setTimeout(() => {
      searchCities(needle)
        .then((r) => { if (mine === seq.current) { setItems(r.items); setActive(0); setBusy(false); } })
        .catch(() => { if (mine === seq.current) { setItems([]); setBusy(false); } });
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  // The one-tap suggestion. Asked for ONCE, only when the field is empty, and it changes nothing on
  // its own — it renders a button the member may ignore. A silently prefilled location would be us
  // stating where somebody lives on their behalf, into a database that is published in full.
  useEffect(() => {
    if (!suggestFromTimezone || value) { setHint(null); return; }
    let live = true;
    let tz = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { /* no Intl */ }
    if (!tz) return;
    cityForTimezone(tz).then((r) => { if (live) setHint(r.items[0] ?? null); }).catch(() => { /* offer nothing */ });
    return () => { live = false; };
  }, [suggestFromTimezone, value]);

  // Close on an outside tap. Pointerdown rather than click: on iOS a click outside a focused input
  // arrives after the keyboard dismisses, which is late enough to look like the list ignored you.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const pick = useCallback((c: City) => {
    onPick(c);
    setQ(""); setItems([]); setOpen(false);
  }, [onPick]);

  const onKey = (e: React.KeyboardEvent) => {
    if (!open || !items.length) {
      if (e.key === "ArrowDown" && items.length) { setOpen(true); e.preventDefault(); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % items.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + items.length) % items.length); }
    else if (e.key === "Enter") { e.preventDefault(); pick(items[active]); }
    else if (e.key === "Escape") { setOpen(false); }
  };

  // CHOSEN: the field shows the place, not a search box. Changing it is one tap, and that tap is a
  // real 44px button rather than a decorative ×.
  if (value) {
    return (
      <div className="flex min-w-0 items-center gap-2 rounded-field border border-line bg-space-1 px-3.5 py-2">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7"
          strokeLinejoin="round" aria-hidden className="shrink-0 text-yang">
          <path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11z" /><circle cx="12" cy="10" r="2.6" />
        </svg>
        <span data-ay-skip="1" className="min-w-0 flex-1 truncate text-[15px] text-ink">{value}</span>
        <button type="button" onClick={() => { onClear(); setQ(""); setOpen(false); }}
          className="-my-2 shrink-0 rounded-pill px-2 py-2 text-[13px] font-semibold text-ink-3 transition-colors hover:text-yang">
          Change
        </button>
      </div>
    );
  }

  return (
    <div ref={box} className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-required={required}
        aria-invalid={invalid || undefined}
        autoComplete="off" autoCorrect="off" spellCheck={false}
        inputMode="search" autoCapitalize="words"
        value={q}
        placeholder={placeholder}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        className={cx(
          "h-11 w-full rounded-field border bg-space-1 px-3.5 text-[15px] text-ink outline-none transition-colors",
          invalid ? "border-yang" : "border-line focus:border-yin-light",
        )}
      />
      {/* "You look like you are in Istanbul" — one tap to accept, and typing dismisses it by filling
          the box. Never auto-applied. */}
      {hint && !q.trim() && (
        <button type="button" onClick={() => pick(hint)}
          className="mt-1.5 inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-line px-3 py-1 text-[13px] text-ink-2 transition-colors hover:border-yang hover:text-ink">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
            <path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11z" /><circle cx="12" cy="10" r="2.6" />
          </svg>
          <span data-ay-skip="1">{hint.name}</span>
          <span className="text-ink-3">— use this?</span>
        </button>
      )}

      {/* The live region says how many matches there are without stealing focus — otherwise a screen
          reader user types into silence. */}
      <span className="sr-only" role="status" aria-live="polite">
        {q.trim().length < 2 ? "" : busy ? "Searching" : `${items.length} ${items.length === 1 ? "city" : "cities"} found`}
      </span>

      {open && q.trim().length >= 2 && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-card border border-line bg-space-1 shadow-[0_16px_40px_rgba(0,0,0,.35)]">
          {busy && items.length === 0 ? (
            <p className="px-3.5 py-3 text-[13px] text-ink-3">Searching…</p>
          ) : items.length === 0 ? (
            <p className="px-3.5 py-3 text-[13px] text-ink-3">
              No city by that name. The list holds every city over 15,000 people — try the nearest larger one.
            </p>
          ) : (
            <ul id={listId} role="listbox" className="max-h-[min(60vh,20rem)] list-none overflow-y-auto overscroll-contain">
              {items.map((c, i) => (
                <li key={`${c.name}-${c.lat}-${c.lon}`} role="option" aria-selected={i === active}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(c)}
                    className={cx("flex min-h-11 w-full items-center gap-2 px-3.5 py-2 text-start transition-colors",
                      i === active ? "bg-veil/[0.08]" : "hover:bg-veil/[0.05]")}
                  >
                    <span data-ay-skip="1" className="min-w-0 flex-1 truncate text-[14.5px] text-ink">
                      {c.name}
                      {/* The state, ONLY where the code is letters — otherwise five Springfields in
                          five different states are five identical rows a member cannot choose between. */}
                      {c.admin1 && /^[A-Za-z]/.test(c.admin1) ? <span className="text-ink-3">, {c.admin1}</span> : null}
                    </span>
                    <span data-ay-skip="1" className="shrink-0 text-[12.5px] text-ink-3">{REGION(c.country)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/* CC BY 4.0 obliges us to say where this came from, and this is where a person sees it. */}
          <p className="border-t border-line px-3.5 py-1.5 text-[11px] text-ink-3">City list by GeoNames (CC BY 4.0)</p>
        </div>
      )}
    </div>
  );
}
