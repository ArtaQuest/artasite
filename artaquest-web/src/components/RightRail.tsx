/**
 * THE RIGHT COLUMN — where search lives, on every page (operator 2026-08-16: "the search bar must be
 * in the right column … I don't want it in the top bar at all anywhere. like X", and then "ensure
 * that there is universally 3 columns everywhere").
 *
 * X has no search field in its header on any surface. Search is the top of the right column on a
 * wide screen and a tab on a phone. Here that is ONE column, rendered by AppShell on every page
 * that has room for it:
 *
 *   • <ShellRail> is the column: whatever the page contributed, scrolling, and then the FOOT pinned
 *     under it — the one <SiteFooter> (components/Footer.tsx: the legal links, the accounts, the
 *     copyright), visible on every page. The SEARCH FIELD is the header's again since the operator
 *     asked for Reddit's centred bar — see AppShell's Topbar.
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
import { SiteFooter } from "./Footer";
import { isLoggedIn } from "../lib/wp";

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
          column's top sat at -143px with 204px of it behind the bar.

          TWO PARTS, and only the first scrolls (operator 2026-08-19: the footer "should be under
          right side of every page"). The cards scroll inside the column behind a hidden scrollbar;
          the FOOTER is pinned under them, at the bottom of the sticky column, so it is on screen on
          every page — before this it sat at the END of that hidden-scrollbar column, reachable only
          by scrolling a scrollbar nobody could see, i.e. invisible on any page with more than a
          card or two. */}
      <div className="sticky top-[calc(var(--spacing-topbar)+1rem)] flex max-h-[calc(100vh-var(--spacing-topbar)-2rem)] flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* Where the page's own cards land (a work's cite/run cards, the calendar's subscribe
              panel, the feed's highlights). */}
          <div ref={setRailNode} className="contents" />
          {/* …and when the page brought none, the column carries the platform's own discovery cards
              rather than a field over a row of links (operator 2026-08-16: "put some stuff to the
              right"). One fetch, and only on the pages that actually render them. */}
          <RailDefaults />
        </div>
        {/* THE FOOT — the one footer (components/Footer.tsx), pinned. A signed-in member has the
            ArtaChat dock fixed over the bottom-right of the window — 400px wide, its collapsed bar
            ~64px tall, squarely over this column's foot — so the foot clears it with pb-24 (96px:
            the bar and a breath). Signed out there is no dock and no band of empty space (the same
            asymmetry AppShell keeps for Arta's ledge). Measured at 1440×900 in the lab: the copyright
            line sat behind the dock's bar before this. */}
        <div className={`shrink-0 border-t border-line px-3 pt-4 ${isLoggedIn() ? "pb-24" : "pb-6"}`}>
          <SiteFooter />
        </div>
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
