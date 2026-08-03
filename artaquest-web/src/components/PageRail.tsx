/**
 * ONE desktop three-column shape: left nav (AppShell) · content · right rail.
 *
 * Operator, 2026-07-31: "the right side cards should always be there in desktop (also make it
 * consistent in code editor) … in the content page the content must fit between the right cards and
 * the left menu."
 *
 * Before this, every page invented its own geometry inside AppShell's wrapper — the work page opened
 * a second `<main max-w-6xl px-4>` INSIDE the shell's `<main><div max-w-content px-gutter>` (a nested
 * landmark, and gutters applied twice), the Lab used max-w-7xl and had no rail at all, and the feed
 * used 1076px with its own aside. Three different content widths and three different answers to
 * "where do the side cards go", so nothing lined up between pages.
 *
 * The rules this encodes:
 *
 *   - The rail is a FLEX SIBLING of the content, never an overlay and never a grid column the
 *     content can be squeezed out of. `min-w-0` on the content is load-bearing: without it a wide
 *     child (a table, a code block, a chart) sets the flex base and pushes the rail off-screen
 *     instead of scrolling inside its own box.
 *   - It STICKS. These cards are the reason someone is on the page — how to run the work, how to
 *     cite it — and they were scrolling away after the first screen.
 *   - It is `hidden lg:block`, out of the FLOW rather than merely invisible, so a narrow viewport
 *     lays out as one column with no phantom track. Below lg the same cards render inline via
 *     <RailInline>, so a phone loses the column and not the content.
 *   - It does NOT add another max-width or gutter. AppShell already centres every page in
 *     max-w-content with px-gutter; a second wrapper is what made the work page's column drift.
 */
import type { ReactNode } from "react";

/** Width of the desktop rail. One number, so the Lab and the work page cannot disagree. */
export const RAIL_W = 320;

export function WithRail({
  children,
  rail,
  label = "About this work",
  /** Vertical offset for the sticky rail — clears AppShell's sticky topbar. */
  top = "5rem",
}: {
  children: ReactNode;
  rail: ReactNode;
  label?: string;
  top?: string;
}) {
  return (
    <div className="flex w-full items-start gap-6">
      {/* min-w-0: see the docblock — this is what lets a wide child scroll instead of shoving the
          rail out of the viewport. */}
      <div className="min-w-0 flex-1">{children}</div>
      <aside
        aria-label={label}
        style={{ width: RAIL_W, top, maxHeight: `calc(100vh - ${top} - 1rem)` }}
        /* `hidden lg:block` (not lg:visible): out of the flow entirely below lg, so a phone gets a
           single column rather than a collapsed 320px track it has to lay out around.
           THE MAX-HEIGHT IS WHAT MAKES IT STICK. `position: sticky` only pins an element that FITS
           the viewport; a rail taller than the screen scrolls away with the page until its bottom
           arrives, which is exactly what "the cards should always be there" rules out — measured on
           prod, the rail's top reached -145px. Cap it to the viewport and let the rail itself
           scroll. The scrollbar is hidden so a pinned column does not grow furniture, matching the
           feed rail. */
        className="sticky hidden shrink-0 self-start overflow-y-auto lg:block [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="flex flex-col gap-4 pb-2">{rail}</div>
      </aside>
    </div>
  );
}

/**
 * The same cards, below the lg breakpoint, in the flow.
 *
 * A phone must not lose "how do I run this" and "how do I cite this" just because there is no room
 * for a column — the rail is hidden there, so the content has to reappear somewhere. Place this at
 * the point in the page where it reads naturally (after the work, before the discussion).
 */
export function RailInline({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4 lg:hidden">{children}</div>;
}
