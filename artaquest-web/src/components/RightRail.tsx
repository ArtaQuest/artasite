/**
 * THE RIGHT COLUMN — where search lives, on every page (operator 2026-08-16: "the search bar must be
 * in the right column … I don't want it in the top bar at all anywhere. like X").
 *
 * X has no search field in its header on any surface. Search is the top of the right column on a
 * wide screen, and a tab on a phone. This module is what makes that true HERE, where — unlike X —
 * only some pages brought a right column of their own:
 *
 *   • A page that already has one (the feed's Highlights aside, PageRail's <WithRail>) puts the
 *     field at the top of ITS column and calls `useOwnsRail()` to say so.
 *   • Every other page gets `<ShellRail>` from AppShell — the same column, carrying the field and
 *     the quick links, so no page is left without a search.
 *   • Below lg there is no column at all, so the phone reaches search through `<SearchSheet>`:
 *     a full-screen field opened from the bottom tab bar or the nav drawer. Never the header.
 *
 * The ownership registry that decides between those first two lives in `lib/rail.ts` — a component
 * module cannot also export plain functions without breaking Fast Refresh.
 */
import { useCallback, useEffect, useState } from "react";
import { SearchBox } from "./SearchBox";
import { LEGAL, SOCIALS } from "../lib/brand-links";

/**
 * THE RAIL'S FOOT — what used to be the page footer (operator 2026-08-16: "all of these should be
 * in the right panel").
 *
 * On a wide screen the right column now ends the page the way X's does: the legal links, the
 * official accounts and the copyright, small and quiet, under whatever cards the page put above
 * them. The full-width <Footer> still renders BELOW lg, where there is no column to carry it — the
 * legal links are not optional furniture, and a phone would otherwise lose them entirely.
 *
 * Same data as the footer (lib/brand-links.ts), so the two cannot drift, and the schema mirror
 * documented there still governs the account list.
 */
export function RailFoot() {
  const year = new Date().getFullYear();
  return (
    <div className="flex flex-col gap-3 px-3 pb-2">
      <nav aria-label="Quick links" className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-3">
        {[{ label: "About", href: "/about/" }, { label: "Donations", href: "/donate/" }, { label: "Data", href: "/data/" }, { label: "FAQ", href: "/faq-contact/" }, ...LEGAL]
          .map((l) => <a key={l.href} href={l.href} className="-mx-1 inline-block px-1 py-1 transition-colors hover:text-ink-2 hover:underline">{l.label}</a>)}
      </nav>
      <div className="flex items-center gap-2">
        {SOCIALS.map((sIcon) => (
          <a key={sIcon.href} href={sIcon.href} target="_blank" rel="noopener noreferrer" aria-label={sIcon.label} title={sIcon.label}
            className="grid h-8 w-8 place-items-center rounded-full border border-line text-ink-3 transition-colors hover:border-yin-light hover:text-ink">
            <svg viewBox={sIcon.viewBox || "0 0 24 24"} width="15" height="15" fill="currentColor" aria-hidden><path d={sIcon.path} /></svg>
          </a>
        ))}
      </div>
      <p className="text-[12px] text-ink-3">
        © {year} ArtaQuest ·{" "}
        <a href="https://ised-isde.canada.ca/cc/lgcy/fdrlCrpDtls.html?corpId=17948328" target="_blank" rel="noopener noreferrer"
          className="underline underline-offset-2 transition-colors hover:text-yang">registered</a>{" "}
        not-for-profit
      </p>
    </div>
  );
}

/** The search field as the rail's first card — the shape every rail opens with. */
export function RailSearch() {
  return <div className="sticky top-0 z-10 bg-space-1 pb-1 pt-3"><SearchBox /></div>;
}

/**
 * The right column for pages that do not bring their own. Same 330px width and sticky behaviour as
 * the feed's, so search sits in the same place on the screen whatever page you are reading.
 */
export function ShellRail() {
  return (
    <aside className="hidden w-[330px] shrink-0 lg:block" aria-label="Search">
      <div className="sticky top-4 flex max-h-[calc(100vh-2rem)] flex-col gap-4 overflow-y-auto pb-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <RailSearch />
        <RailFoot />
      </div>
    </aside>
  );
}

/**
 * The phone's search surface: a full-screen field, opened by the Search tab. It exists because the
 * right column does not, below lg — and because the one place it must never go back to is the
 * header. Mounted once, by AppShell.
 */
export function SearchSheet() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("aq:search", onOpen);
    return () => window.removeEventListener("aq:search", onOpen);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    // The sheet covers the page; the page behind it must not scroll under the field.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open, close]);
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Search" className="fixed inset-0 z-[60] bg-space-1/98 backdrop-blur-md">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1"><SearchBox autoFocus /></div>
        <button type="button" onClick={close}
          className="shrink-0 rounded-pill px-3 py-2 text-[14px] font-semibold text-ink-2 transition-colors hover:text-ink">
          Cancel
        </button>
      </div>
    </div>
  );
}
