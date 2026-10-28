import { localePath } from "../lib/wp";
import { LEGAL, SOCIALS } from "../lib/brand-links";

/**
 * THE ONE FOOTER (operator 2026-08-19: "this should be under right side of every page. factor it
 * out properly").
 *
 * It used to exist twice — a full-width <Footer> below the page and a compact <RailFoot> inside the
 * right column. Now there is one block, <SiteFooter>, placed by the SHELL in exactly two spots:
 *   • at lg+, PINNED to the foot of the right column (RightRail.tsx → ShellRail);
 *   • below lg, as a full-width band under the page (<Footer>).
 * Both share lib/brand-links.ts, so they cannot drift.
 *
 * The four marks (operator 2026-10-08: "also show the same four for the artasite footer") match the
 * profile row — Instagram, Facebook, LinkedIn, X for artafather — same 32px circle / 16px glyph.
 */
export function SiteFooter({ className = "" }: { className?: string }) {
  const year = new Date().getFullYear();
  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      <nav aria-label="Quick links" className="flex flex-wrap gap-x-3 gap-y-0 text-[12px] text-ink-2">
        {[{ label: "About", href: "/about/" }, { label: "Donations", href: "/donate/" }, { label: "Data", href: "/data/" }, { label: "FAQ", href: "/faq-contact/" }, ...LEGAL]
          .map((l) => <a key={l.href} href={localePath(l.href)} className="-mx-1 -my-2 inline-flex min-h-[40px] items-center px-1 transition-colors hover:text-ink hover:underline">{l.label}</a>)}
      </nav>
      {/* Same marks as the profile row: 32px circle, 16px glyph, 38px invisible hit via padding. */}
      <ul role="list" className="-m-[3px] flex items-center gap-2 p-[3px]" aria-label="Social media links">
        {SOCIALS.map((s) => (
          <li key={s.href} className="shrink-0">
            <a href={s.href} target="_blank" rel="noopener noreferrer" aria-label={s.label} title={s.label}
              className="relative grid h-8 w-8 place-items-center rounded-full border border-line bg-space-1 text-ink-2 transition-colors before:absolute before:-inset-[3px] before:rounded-full before:content-[''] hover:border-yang hover:text-yang focus-visible:border-yang focus-visible:text-yang focus-visible:outline-none">
              <svg viewBox={s.viewBox || "0 0 24 24"} width="16" height="16" fill="currentColor" aria-hidden><path d={s.path} /></svg>
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

export function Footer() {
  return (
    <footer className="mt-6 border-t border-line bg-space-1 sm:mt-12">
      <div className="mx-auto max-w-content px-gutter pb-24 pt-6 md:pb-20">
        <SiteFooter />
      </div>
    </footer>
  );
}
