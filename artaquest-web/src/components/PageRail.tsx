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
import { RailPortal } from "./RightRail";

/** Width of the desktop rail. One number, so the Lab and the work page cannot disagree. */
export const RAIL_W = 320;

export function WithRail({
  children,
  rail,
  label,
  top,
}: {
  children: ReactNode;
  rail: ReactNode;
  /** Unused since the rail became one shared column; kept so callers need no edit. */
  label?: string;
  top?: string;
}) {
  void label; void top;
  // The page's cards go into THE right column (AppShell renders it, RightRail.tsx defines it).
  // `mobile="none"`: below lg every caller already renders the same cards with <RailInline>, and
  // two copies on a phone is what the old separate aside was carefully avoiding.
  return (
    <>
      {children}
      <RailPortal mobile="none">{rail}</RailPortal>
    </>
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
