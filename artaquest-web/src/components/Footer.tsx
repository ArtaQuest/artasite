import { localePath } from "../lib/wp";
import { LEGAL, SOCIALS } from "../lib/brand-links";

/**
 * THE ONE FOOTER (operator 2026-08-19: "this should be under right side of every page. factor it
 * out properly").
 *
 * It used to exist twice — a full-width <Footer> below the page (words left, icons right, its own
 * hairline and dock clearance) and a compact <RailFoot> inside the right column — the same links,
 * the same accounts, the same copyright, drawn two ways from the same data. Now there is one block,
 * <SiteFooter>: the quick links, the official accounts, the copyright — small and quiet, in the shape
 * the operator pointed at. It is placed by the SHELL, in exactly two spots:
 *
 *   • at lg+, PINNED to the foot of the right column (RightRail.tsx → ShellRail), where it is
 *     visible on every page without scrolling a hidden-scrollbar column to its end;
 *   • below lg, where there is no right column, as a full-width band under the page (<Footer>),
 *     with the clearance the fixed dock / phone tab bar need — the legal links are not optional
 *     furniture, and a phone would otherwise lose them entirely.
 *
 * Both are the same component with the same data (lib/brand-links.ts), so they cannot drift.
 * The old comment history — the 2026-07-16 "one quiet legal bar", the 4×40 icon row that fits a
 * 320px screen, ink-2 (not ink-3) because two of these links are the legally required ones, the
 * 40px hit areas — all still holds inside <SiteFooter>.
 */
export function SiteFooter({ className = "" }: { className?: string }) {
  const year = new Date().getFullYear();
  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      {/* Each link is a 40px-tall target with its text kept on the same visual line: the vertical
          padding is cancelled by a negative margin, so the row does not grow while the thumb gets
          the room it needs. ink-2: these are links a reader is meant to find and follow, and ink-3's
          3:1 tier is for rules and glyphs. */}
      <nav aria-label="Quick links" className="flex flex-wrap gap-x-3 gap-y-0 text-[12px] text-ink-2">
        {[{ label: "About", href: "/about/" }, { label: "Donations", href: "/donate/" }, { label: "Data", href: "/data/" }, { label: "FAQ", href: "/faq-contact/" }, ...LEGAL]
          .map((l) => <a key={l.href} href={localePath(l.href)} className="-mx-1 -my-2 inline-flex min-h-[40px] items-center px-1 transition-colors hover:text-ink hover:underline">{l.label}</a>)}
      </nav>
      {/* The official accounts: one row, every breakpoint (5 × 40 + 4 × 8 = 232px fits a 320px screen). */}
      <ul role="list" className="flex items-center gap-2" aria-label="Social media links">
        {SOCIALS.map((s) => (
          <li key={s.href} className="shrink-0">
            <a href={s.href} target="_blank" rel="noopener noreferrer" aria-label={s.label} title={s.label}
              className="grid h-10 w-10 place-items-center rounded-full border border-line text-ink-2 transition-colors hover:border-yin-light hover:text-ink">
              <svg viewBox={s.viewBox || "0 0 24 24"} width="15" height="15" fill="currentColor" aria-hidden><path d={s.path} /></svg>
            </a>
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-ink-2">
        &copy; {year} ArtaQuest &middot;{" "}
        <a href="https://ised-isde.canada.ca/cc/lgcy/fdrlCrpDtls.html?corpId=17948328" target="_blank" rel="noopener noreferrer"
          className="-my-2 inline-flex min-h-[40px] items-center underline underline-offset-2 transition-colors hover:text-yang">registered</a>{" "}
        not-for-profit
      </p>
    </div>
  );
}

/**
 * The full-width band BELOW lg only (AppShell renders it `lg:hidden`), where no right column exists.
 * Bottom clearance for something FIXED over the page end: the phone's tab bar, and the ArtaChat
 * dock on a signed-in tablet — measured 2026-07 (see the git history of this file); pb-24 / md:pb-20
 * are the numbers that leave the icon row clear of both.
 */
export function Footer() {
  return (
    <footer className="mt-6 border-t border-line bg-space-1 sm:mt-12">
      <div className="mx-auto max-w-content px-gutter pb-24 pt-6 md:pb-20">
        <SiteFooter />
      </div>
    </footer>
  );
}
