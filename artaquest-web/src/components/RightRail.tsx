/**
 * THE RIGHT COLUMN — where search lives, on every page (operator 2026-08-16: "the search bar must be
 * in the right column … I don't want it in the top bar at all anywhere. like X", and then "ensure
 * that there is universally 3 columns everywhere").
 *
 * X has no search field in its header on any surface. Search is the top of the right column on a
 * wide screen and a tab on a phone. Here that is ONE column, rendered by AppShell on every page
 * that has room for it:
 *
 *   • <ShellRail> is the column: whatever the page contributed, then the foot (the legal links and
 *     accounts that used to be the page footer). The SEARCH FIELD is the header's again since the
 *     operator asked for Reddit's centred bar — see AppShell's Topbar.
 *   • A page adds cards with <RailPortal> — the feed's highlights, a work's cite/run cards, the
 *     calendar's subscribe panel. It cannot switch the column off, which is the whole point: the
 *     first design let a page CLAIM the column and then render nothing, and a signed-out reader on
 *     /calendar was left with no column and no search at all.
 *   • Below lg there is no column, so the phone reaches search through <SearchSheet>: a full-screen
 *     field opened from the bottom tab bar or the nav drawer. Never the header.
 *
 * The portal target and the lg media query live in `lib/rail.ts` — a component module cannot also
 * export plain functions without breaking Fast Refresh.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { setRailNode, useIsFilling, useRail, useRailFilled, useRailNode, useWide } from "../lib/rail";
import { ChallengesCard, HappeningCard, NewsCard, TodaysNewsCard, WhoToFollowCard } from "./RailCards";
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
      {/* ink-2: these are links a reader is meant to find and follow, and ink-3's 3:1 tier is for
          rules and glyphs. Measured at 3.68:1 on the light canvas before this. */}
      {/* Each link is a 40px-tall target with its text kept on the same visual line: the vertical
          padding is cancelled by a negative margin, so the row does not grow while the thumb gets
          the room it needs. They were 26px. */}
      <nav aria-label="Quick links" className="flex flex-wrap gap-x-3 gap-y-0 text-[12px] text-ink-2">
        {[{ label: "About", href: "/about/" }, { label: "Donations", href: "/donate/" }, { label: "Data", href: "/data/" }, { label: "FAQ", href: "/faq-contact/" }, ...LEGAL]
          .map((l) => <a key={l.href} href={l.href} className="-mx-1 -my-2 inline-flex min-h-[40px] items-center px-1 transition-colors hover:text-ink hover:underline">{l.label}</a>)}
      </nav>
      <div className="flex items-center gap-2">
        {SOCIALS.map((sIcon) => (
          <a key={sIcon.href} href={sIcon.href} target="_blank" rel="noopener noreferrer" aria-label={sIcon.label} title={sIcon.label}
            className="grid h-10 w-10 place-items-center rounded-full border border-line text-ink-2 transition-colors hover:border-yin-light hover:text-ink">
            <svg viewBox={sIcon.viewBox || "0 0 24 24"} width="15" height="15" fill="currentColor" aria-hidden><path d={sIcon.path} /></svg>
          </a>
        ))}
      </div>
      <p className="text-[12px] text-ink-2">
        © {year} ArtaQuest ·{" "}
        <a href="https://ised-isde.canada.ca/cc/lgcy/fdrlCrpDtls.html?corpId=17948328" target="_blank" rel="noopener noreferrer"
          className="-my-2 inline-flex min-h-[40px] items-center underline underline-offset-2 transition-colors hover:text-yang">registered</a>{" "}
        not-for-profit
      </p>
    </div>
  );
}

/**
 * THE right column — one per page, rendered by the shell, on every page that has room for it.
 *
 * Its middle is a portal target: a page drops its own cards in through <RailPortal> and they land
 * between the search field and the foot. Nothing can switch this column off, which is the point —
 * the previous design let a page claim the column and then render nothing, and a signed-out reader
 * on /calendar got neither cards nor search.
 */
export function ShellRail() {
  return (
    <aside className="hidden w-[330px] shrink-0 lg:block" aria-label="Search and highlights">
      {/* top = the bar (60px) + a 16px breath, and the height subtracts the same, or the column
          pins UNDER the bar and loses its first card. Measured on a work page before this: the
          column's top sat at -143px with 204px of it behind the bar. */}
      <div className="sticky top-[calc(var(--spacing-topbar)+1rem)] flex max-h-[calc(100vh-var(--spacing-topbar)-2rem)] flex-col gap-4 overflow-y-auto pb-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* Where the page's own cards land (a work's cite/run cards, the calendar's subscribe
            panel, the feed's highlights). */}
        <div ref={setRailNode} className="contents" />
        {/* …and when the page brought none, the column carries the platform's own discovery cards
            rather than a field over a row of links (operator 2026-08-16: "put some stuff to the
            right"). One fetch, and only on the pages that actually render them. */}
        <RailDefaults />
        <RailFoot />
      </div>
    </aside>
  );
}

/**
 * A page's cards, placed in THE right column.
 *
 * At lg+ they are portalled into <ShellRail>. Below lg there is no column: `mobile="inline"` leaves
 * them where they sit in the page (the old behaviour of every page-level aside), and `mobile="none"`
 * drops them for pages that already render their own phone copies — the feed interleaves its
 * modules between posts, and PageRail pages carry <RailInline>. Rendering both would show the cards
 * twice on a phone.
 */
function RailDefaults() {
  const filled = useRailFilled();
  const rail = useRail(!filled);
  if (filled) return null;
  return (
    <>
      <TodaysNewsCard items={rail.headlines} />
      <HappeningCard items={rail.topics} />
      <ChallengesCard items={rail.challenges} />
      <WhoToFollowCard items={rail.who} />
      <NewsCard items={rail.news} />
    </>
  );
}

export function RailPortal({ children, mobile = "inline" }: { children: ReactNode; mobile?: "inline" | "none" }) {
  useIsFilling();
  const node = useRailNode();
  const wide = useWide();
  if (wide) return node ? createPortal(children, node) : null;
  return mobile === "inline" ? <>{children}</> : null;
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
