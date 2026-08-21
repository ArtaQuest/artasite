import { type ReactNode } from "react";
import { Button, Card } from "../components/ui";
import { localePath } from "../lib/wp";
import founderPhoto from "../assets/founder.jpg";
import founderAvatar from "../assets/founder-avatar.jpg";

/**
 * /about — what ArtaQuest is, who runs it, and the argument it is built on.
 *
 * Four audiences land here and want different things: a prospective member deciding whether to trust
 * the place, a journalist after the entity, a donor, and a CEO candidate deep-linked to `#founder`.
 * TWO sections now — what it is (hero) → who runs it, in his own words. Everything else was a second
 * telling: the CV retold the founder's own note and the two positioning cards retold the hero.
 *
 * The right rail is GONE (operator, 2026-08-03). It held one "Check it yourself" card — the reserve,
 * the ledgers and the registration — and those three links live in the page's own text and in the
 * left nav, so it was a fourth telling of what the page already says. Removing it took WithRail and
 * RailInline with it: a rail with nothing in it is not a layout, and this page now runs full width.
 *
 * THE PHILOSOPHY SECTION WAS REMOVED 2026-08-15 (operator: "cut the rest (physics part)"). It ran
 * from Boltzmann's entropy through three display equations, an integral figure, four answered
 * objections, and the site's operating rules. It was added 2026-07-31 as the long form of the note's
 * last paragraph — and that paragraph is gone too: the rewritten note ends on the mission rather than
 * on the second law, so the essay no longer had a sentence to expand.
 *
 * TWO things left with it, and neither is replaced. Both were flagged to the operator:
 *  1. A correction. The note says an AI is "trained to minimise entropy"; the cut section said
 *     plainly that this is not how these models are trained, and described the real narrowing
 *     (decoding, preference tuning, one answer on one screen). The note now carries that sentence
 *     uncorrected. If it should be corrected again, correct it IN the note — a signed personal
 *     essay can only honestly be corrected in the voice that signed it.
 *  2. The seven operating rules — never scores, inputs public, database public, free to take part,
 *     no hate/fear, proved Kaggle ownership, hearts never downvotes. Those are checkable claims
 *     about how the platform runs, and this page no longer makes them. They are worth their own
 *     short section if the operator wants them back; they were cut because they lived inside the
 *     physics argument and were framed as consequences of its equation.
 *
 * Every factual claim here was checked against shipped code, because the page's whole argument is
 * that its claims are checkable. These were DELETED for failing that check and must not come back
 * without a code path behind them:
 * • "the small spread on buying and selling coins" — `Economy::sell` returns 503 while
 * `cashout_enabled()` is false, so the sell leg is not a live revenue source.
 * • "held in full reserve" — `Economy::reserve()` deliberately publishes the TRUE, possibly
 * under-collateralised ratio (Economy.php:791-794), and /reserve renders it live. Say the RATIO
 * is published; never say the coins are fully backed.
 * • "donations accepted only from independent individuals — never from governments, corporations…"
 * — implemented nowhere: no donor-class field, no screening, no refusal path in Funds.php.
 * • "No autoplay" — components/nbview.tsx:471 renders every unflagged teaser `autoPlay={!flagged}
 * muted loop`; only videos over the viewer's Motion-calm threshold render paused.
 * • "the only fee anywhere is a challenge entry" — Shop.php:73 prices goods in `price_coins` and
 * orders carry `coins_total`, so a printed book costs coins. The true form is "the only fee to
 * take part".
 * • "The full record on his profile →" — Profile.tsx renders a bio, counts and a post grid. There
 * is no career record there to link to.
 * • "Only the person who wrote the notebook can publish it here" — DELETED 2026-08-03, RESTORED in a
 * NARROWER form 2026-08-04. The blanket claim was false: `author_confirm_email()` mails the
 * single-use secret to `get_userdata( $r['author_id'] )->user_email`, i.e. the MEMBER who
 * submitted it, `kaggle.author` is a name read back off Kaggle, and nothing linked a member
 * account to a Kaggle handle — so we could not check the claim even if we made it. That link now
 * exists: `Kernel::inspect` blocks on `owner_proven`, which asks `KaggleId::verified_handle()`
 * whether this member has proved control of the kernel's Kaggle account (a one-time string posted
 * in a public notebook under that handle, read back off an endpoint that needs no credential —
 * re-runnable by anyone). Note the endpoint, not our call: `Kaggle::get()` sends the platform's
 * Bearer token on every request and `pull()` refuses to run without one, so "WE read it with no
 * login" is false. What is true, and checked live 2026-08-04, is that an unauthenticated GET of
 * the same URL answers 200, and a wrong owner answers 403.
 * So the page may say you can only submit from an account you have proved is yours, and that
 * publishing is still the member's own emailed, passkey-signed decision. It may NOT say every
 * published work was author-verified: the check dates from 2026-08-04, no path re-inspects a
 * published row, and the THREE works published before it (9318, 9319, 9321 — one member, two
 * different Kaggle handles; counted in the public `aq_notebooks` register, not assumed) carry no
 * such item. Nor may it say we verify who WROTE the code — the proof is control of the account,
 * and nothing more.
 * • "it is checked" (the hate/fear line, read as happening at post time) — `Social::comment` and
 * `Notebook::comment` both store the comment with `modq = 1` and return; the reading happens later,
 * when `Fearometer::process_queue` drains the queue through the subscription relay. Since the paid
 * API was removed (2026-06-13) there is nothing left that could read a comment inline, and posting
 * has never waited on it. Say it is QUEUED and read — a promise about what happens to a comment,
 * never about what has already happened to it.
 */

/** A section heading + its anchor. `scroll-mt-24` clears the 60px sticky topbar plus air, so a jump
 *  lands the heading visible instead of tucked underneath it. */
function H2({ id, children, className = "" }: { id: string; children: ReactNode; className?: string }) {
  return (
    <h2 id={id} className={`scroll-mt-24 text-[clamp(1.5rem,3vw,2.05rem)] font-extrabold leading-tight tracking-tight ${className}`}>
      {children}
    </h2>
  );
}

/**
 * The founder's note — his own words, not one of them changed. The margin labels are navigation:
 * five dense paragraphs ran about five phone screens with no entry point.
 */
const FOUNDER: { label: string; body: string }[] = [
  {
    label: "Tehran, 1994",
    body: "I was born in Tehran on 15 February 1994. I have two sisters, and we were raised by a single mom who taught French and English. I love physics, and as a teenager I competed in Iran's national olympiads. I have lived most of my life abroad — across Malaysia, Turkey and Canada. I started teaching very young, and I learned that teaching something is the best way to understand it deeply.",
  },
  {
    label: "The climb",
    body: "I had one goal — to figure out how the universe works, and why — and I followed it upward. From gases to galaxies, then to circuits and information systems, then to machine intelligence, and finally to biological intelligence: the universe's masterpiece, the matter with the most degrees of freedom, the most conscious entity. That climb led me to artificial intelligence, and I moved to Montréal to study it for a PhD.",
  },
  {
    label: "Why I left the PhD",
    body: "I passed the qualifying exam, but the more I saw of how these systems are trained, the more they worried me. An AI is trained to minimise entropy — to collapse a world of possibilities into its single most likely answer. That makes it confident, often overconfident: it hands you that answer before you have even finished your question, and points everyone towards the same one. Slowly, this can weaken our ability to think for ourselves — and, by narrowing the variety that change depends on, it could even harm our evolution over time. The danger looked less like the science-fiction fear of machines taking over, and more like people quietly choosing to let the machine think for them. As a researcher, I had no answer to this. As a teacher, I thought I might. So I left the PhD and returned to education.",
  },
  {
    label: "What science cannot ask",
    body: "I helped found Neuromatch Academy, an online school for science. My most recent work was at the Center for Rigor, on how to make science itself more honest. Both taught me the same lesson. Science explains how the world works, but on its own it does not ask why — why we use what we learn, or who it serves. That question belongs to philosophy. Without it, science becomes only a tool — and that is how it earns its bad reputation: not because it is wrong, but because, without the why, it is so easily turned to domination and the suppression of people.",
  },
  {
    label: "Why ArtaQuest",
    body: "ArtaQuest grew from that: take the best free knowledge the world has already produced — on whatever people most need to learn — and give it an honest, focused home, free of propaganda, where anyone can learn it and think for themselves. I run it alone, on purpose: no employer, no funder, no organisation telling me what to teach. That keeps it honest, and keeps it on the mission I have set for my life — to expand everyone's creativity.",
  },
];

export default function About() {
  return (
    <div className="@container flex flex-col gap-12 pb-12 @xl:gap-16">
      {/* Hero. The h1 is ONE text node with no inner `aq-grad` span: the i18n mesh walks text nodes
          individually, so a split heading is translated as two disconnected fragments in every
          locale, and `.aq-grad` measures ~1.84:1 on the default light canvas. */}
      {/* Same rule as the founder card: the hero pads to ITS OWN width, not the window's. At the
          ~686px column a 1440px window gives this page, `sm:px-12 sm:py-20` spent 96px of a 686px
          card on side padding and 160px of height on air. */}
      <section className="@container relative overflow-hidden rounded-card border border-line bg-space-2 px-6 py-12 @xl:px-10 @xl:py-16">
        <div className="relative max-w-2xl">
          <h1 className="text-[clamp(1.85rem,3.2vw+1.1rem,3.3rem)] font-extrabold leading-[1.1]">
            Work you can check for yourself
          </h1>
          <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-ink">
            A not-for-profit social feed for science and education. Every post here is a public notebook on Kaggle:
            writing and code that Kaggle has already run on its own computers. Kaggle keeps a public
            record of that run. We read that record and show you what it says. Since 4 August 2026 you can only
            submit a notebook from a Kaggle account you have proved you control, so on every work submitted
            since, the member who publishes it is its Kaggle author and the citation credits them. Publishing
            takes a one-time link sent to your own inbox and a signature from your own device — nothing and
            nobody else can do it. It stays free to read, and anyone can run it
            again on Kaggle for as long as its author keeps it there — which is why publishing also
            mints a permanent citation link that outlives the notebook.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button href="/works/" size="xl">Open the feed</Button>
          </div>
        </div>
      </section>

      <div>
        <div className="flex flex-col gap-12 @xl:gap-16">
          {/* From the founder — the landing point for /about#founder, where the CEO posting sends a
              candidate. */}
          <section>
            <div className="flex items-center gap-4">
              {/* Decorative: it sat inside an aria-hidden, tabIndex={-1} anchor, i.e. a link no user
                  could reach. The name beside it is the real link. */}
              <img
                src={founderAvatar}
                width={48}
                height={48}
                loading="lazy"
                decoding="async"
                alt=""
                className="h-12 w-12 shrink-0 rounded-full object-cover ring-1 ring-yang/30"
              />
              <div>
                <H2 id="founder">From the founder</H2>
                <p className="text-[13px] text-ink-2">
                  <a href={localePath("/u/arash/")} className="hover:text-yin-light hover:underline">Arash Ashrafnejad</a> · Founder, ArtaQuest Foundation
                </p>
              </div>
            </div>
            {/* @container, not viewport breakpoints (operator 2026-08-21, with a screenshot of the
                note reading five words to a line). Everything below sizes itself to THIS CARD, which
                is nothing like the window: the shell keeps a 330px right column and a left rail, so a
                1440px window gives the page ~686px and this card ~614px inside its padding — while
                `sm:`/`lg:` were both firing as if there were 1440px to spend. The old markup floated a
                240px photo AND opened a 9rem margin-label column inside those 614px, leaving the prose
                ~166px: about five words a line, on the one page that is a long read. A grid container
                also establishes its own formatting context, so each paragraph row was shortened beside
                the float rather than flowing under it — the two decisions compounded. */}
            <Card className="@container mt-6 border-s-2 border-s-yang p-6 @xl:p-9">
              {/* The portrait moves beside the text only when the CARD can hold both, and its size
                  follows the card: at @lg (512px of card) an 11rem photo still leaves ~40 characters
                  a line, at @2xl (672px) a 13rem one leaves ~53. Below @lg it is a centred figure
                  above the essay — what a phone has room for, and equally what the ~394px card a
                  1100px window actually produces. 220px there, not 280: this is a 540×938 portrait,
                  so every 100px of width is 174px of scrolling before the essay starts. Measured at
                  390/900/1100/1280/1440 in the lab. */}
              <figure className="mx-auto mb-6 max-w-[220px] @lg:float-end @lg:mx-0 @lg:mb-3 @lg:ms-5 @lg:w-44 @lg:max-w-none @2xl:ms-6 @2xl:w-52">
                <a href={localePath("/u/arash/")} className="block">
                  <img
                    src={founderPhoto}
                    width={540}
                    height={938}
                    loading="lazy"
                    decoding="async"
                    alt="ArtaQuest's founder, Arash Ashrafnejad, running a 10 km road race in the rain, bib number 2490."
                    className="w-full rounded-card border border-line object-cover shadow-card transition-opacity hover:opacity-90"
                  />
                </a>
                <figcaption className="mt-2.5 text-[12.5px] leading-snug text-ink-2">
                  Enjoying the race in the rain — Montréal, Canada, 2024
                </figcaption>
              </figure>
              {/* The founder's first-person essay — his authentic words. Exempt from the brand-vocab
                  lint: it is his voice, not platform framing. The margin labels are navigation only;
                  not one word of his text changes. */}
              {/* The labels are navigation, not headings — they name the beat each paragraph is on so
                  a reader can find their place again. They sit ABOVE their paragraph at every width
                  the platform actually produces; the margin column returns only at @5xl (64rem), a
                  width no shell column reaches today, so it can never again eat the prose. Not one
                  word of the note changes: its English is hashed to the hand-written Persian and
                  Arabic (tools/about-i18n-gate.php). */}
              <div data-aq-vocab-exempt="founder-note" className="space-y-6 text-[15.5px] leading-relaxed text-ink [text-wrap:pretty] @xl:space-y-7">
                {FOUNDER.map((p) => (
                  <div key={p.label} className="@5xl:grid @5xl:grid-cols-[8rem_1fr] @5xl:gap-x-8">
                    <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.14em] text-ink-2 @5xl:mb-0 @5xl:mt-1 @5xl:text-[12.5px]">{p.label}</p>
                    {/* A measure, not a cap in `ch`: 68ch of this display face measured 643px, i.e.
                        81 characters a line — past the comfortable 45-75. 36rem lands at ~73. */}
                    <p className="max-w-[36rem]">{p.body}</p>
                  </div>
                ))}
              </div>
              <p className="clear-both mt-6 font-display text-[21px] font-medium italic text-yang">— Arash</p>
              {/* Everything the deleted CV section could still tell a reader that his own note does
                  not: the years, and the two outbound links. Dates are load-bearing — undated
                  affiliations under a signature read as present tense, and he left both in 2024. */}
            </Card>
          </section>

        </div>
      </div>

      {/* Closing band. ONE ask: a reader who reached the bottom of an About page can reach the feed
          from every other surface. */}
      <section className="@container rounded-card border border-line bg-gradient-to-br from-space-2 to-space-3 px-6 py-12 text-center @xl:px-10">
        <h2 className="mx-auto max-w-2xl text-[clamp(1.4rem,3vw,1.9rem)] font-bold leading-snug">We do not need to keep you happy — we need to keep you thinking</h2>
        <div className="mt-7 flex flex-col items-center gap-4">
          <Button href="/donate/" size="xl">Support this work</Button>
          <a href={localePath("/faq-contact/")} className="inline-block py-1.5 text-[14px] font-semibold text-ink-2 hover:text-yin-light hover:underline">
            FAQ &amp; contact
          </a>
        </div>
      </section>
    </div>
  );
}
