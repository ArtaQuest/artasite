import { localePath } from "../lib/wp";
import { LEGAL, SOCIALS } from "../lib/brand-links";

// Minimal footer (operator 2026-07-16): ONE quiet legal bar. The old four labelled rows of
// pill links duplicated navigation that already lives elsewhere — the sidebar carries
// Community/Foundation/About, the kind shelves are chips on /works/ itself, and Challenges
// headlines the home-feed rail — so the footer repeated ~25 links on every page and pushed
// real content up. A study-focused surface ends where the content ends; the footer now only
// says who runs the site and where the policies are.

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="mt-6 border-t border-line bg-space-1 sm:mt-12">
      {/* duality hairline: blue (How) → gold (Why) */}
      <div className="h-px bg-gradient-to-r rtl:bg-gradient-to-l from-yin-light/55 via-veil/12 to-yang/55" aria-hidden />
      {/* Bottom clearance, on both form factors, for something FIXED that sits over the page end:
          a phone carries the signed-in tab bar there, desktop carries the ArtaChat dock.

          `md:pb-8` (32px) was sized for a small floating bubble. The dock is not a bubble. Measured
          at 1440x900 scrolled to the document end, signed in: the dock is a fixed panel spanning
          x 1020-1420 with its top edge at y 850, and the social icons span x 1144-1328 — entirely
          inside the dock's column. At pb-8 the icon row sat ~48px lower, putting its bottom edge
          below the dock's top edge, so the icons rendered behind the panel (visible in a screenshot;
          only their lower half was covered, so this was a partial occlusion rather than four dead
          links). `md:pb-20` (80px) leaves a measured 30px gap between the icon row and the dock.

          Vertical clearance, not more `pe-`: the dock is 400px wide, and reserving that horizontally
          would push the whole footer off-centre on every screen to fix a collision at one scroll
          position. Note the dock only renders for signed-in members — an anonymous visitor never had
          the collision, which is why it survived this long. */}
      <div className="mx-auto max-w-content px-gutter pb-24 pt-8 md:pb-20 md:pe-20">
        {/*
          TWO GROUPS: the words on one side, the icons on the other.

          The old comment here reasoned at length about an eighth icon orphaning onto its own row and
          about a deliberate 4+4 mobile grid. With four accounts (operator, 2026-07-31) none of that
          machinery is needed: 4 x 40 + 3 x 8 = 184px fits one row even at 320px, so the grid, the
          `flex-nowrap` guard and the per-breakpoint icon sizing all go and the row is simply a row.

          Text sits on ink-2, not ink-3. lib/contrast.ts binds ink-3 to *incidental* text at a 3:1
          floor, and on the light canvas (the default for anonymous visitors) it measures ~3.2:1 at
          the lowest contrast level — under WCAG 1.4.3 for body text. These are the only links in the
          footer and two of them are the legally-required ones, so they are not incidental.
        */}
        <div className="flex flex-col items-center gap-5 md:flex-row md:items-center md:justify-between md:gap-8">
          {/* The words: copyright and legal, wrapping together as one block of small print. */}
          <div className="flex flex-col items-center gap-x-6 gap-y-2 md:flex-row md:flex-wrap md:items-baseline">
            <p className="order-2 text-center text-[13px] leading-relaxed text-ink-2 md:order-none md:text-start">
              &copy; {year} ArtaQuest &middot;{" "}
              <a
                href="https://ised-isde.canada.ca/cc/lgcy/fdrlCrpDtls.html?corpId=17948328"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 transition-colors hover:text-yang"
              >
                registered
              </a>{" "}
              not-for-profit
            </p>
            <nav aria-label="Legal" className="order-1 md:order-none">
              <ul role="list" className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
                {LEGAL.map((l) => (
                  <li key={l.href}>
                    {/* py-2.5 = a 40px hit area (13px text ≈ 20px line + 2×10px). Measured at 28px
                        before, which is under the touch floor for three stacked links a thumb has to
                        pick between — and these are the legal pages, the ones somebody taps
                        deliberately. `-my-1.5` gives the extra height back so the footer rhythm is
                        unchanged. */}
                    <a href={localePath(l.href)} className="-my-1.5 inline-block py-2.5 text-[13px] text-ink-2 transition-colors hover:text-yang">{l.label}</a>
                  </li>
                ))}
              </ul>
            </nav>
          </div>

          {/* The icons: one row, every breakpoint. */}
          <ul role="list" className="flex shrink-0 items-center gap-2" aria-label="Social media links">
            {SOCIALS.map((s) => (
              <li key={s.label} className="shrink-0">
                <a
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={s.label}
                  title={s.label}
                  className="grid h-10 w-10 place-items-center rounded-full border border-line text-ink-2 transition-colors hover:border-yang/50 hover:text-yang"
                >
                  <svg viewBox={s.viewBox || "0 0 24 24"} width="16" height="16" fill="currentColor" aria-hidden><path d={s.path} /></svg>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </footer>
  );
}
