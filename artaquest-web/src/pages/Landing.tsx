/**
 * The logged-out landing (2026-07-14, Gen-Z soft voice): one gentle promise, three honest steps,
 * then the ACTUAL live feed embedded right here — the product is the marketing.
 *
 * Two rules this file has to keep, both learned the hard way:
 *   • The feed is LAZY. Importing it statically pulled NotebookPage and the Pyodide shim into the
 *     landing's own chunk, so the hero could not paint until the whole thing had downloaded — on
 *     the single page where first paint decides whether a visitor stays at all.
 *   • Sentences are ONE text node. The i18n mesh walks and translates text nodes individually, so
 *     a headline split by a styling <span> is translated in halves into 132 languages, which is
 *     how you get grammatical nonsense everywhere but English.
 */
import { Suspense, lazy, useEffect, useRef } from "react";
import { localePath } from "../lib/wp";
import { Button } from "../components/ui";
import { arta } from "../generated/arta/rig/arta";

const Feed = lazy(() => import("./Feed"));

/** Holds the feed's slot while its chunk loads, so nothing below it jumps. */
function FeedSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-4" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-card border border-line p-4">
          <div className="h-4 w-1/3 animate-pulse rounded bg-veil/[0.08]" />
          <div className="mt-3 h-3 w-4/5 animate-pulse rounded bg-veil/[0.06]" />
          <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-veil/[0.06]" />
        </div>
      ))}
    </div>
  );
}

export default function Landing() {
  const join = localePath("/login/");
  const cta = useRef<HTMLDivElement | null>(null);

  /*
    Arta greets, then does its job: it AIMS at the one thing a visitor should do.
    Sagittarius is the archer, so pointing is the signature gesture, and giving
    it a target turns the mascot from decoration into wayfinding.

    The timings are the whole trick. Waving the instant the page paints reads as
    a pop-up; waiting a beat reads as noticing you. And the point comes after the
    headline has had time to be read, not on top of it.
  */
  useEffect(() => {
    const hello = window.setTimeout(() => arta.wave(), 900);
    const aim = window.setTimeout(() => arta.pointAt(cta.current), 3200);
    return () => { window.clearTimeout(hello); window.clearTimeout(aim); };
  }, []);

  return (
    <div className="flex flex-col gap-6 pb-12 sm:gap-8">
      {/*
        Hero. It used to reserve 150-178px of bottom padding for Arta, who stood on the hairline at
        the foot of this section — and Arta now lives on the message dock as one page-level
        companion, so that space had become a wide empty band above the fold on every visit. On a
        phone it cost most of a screen before anything else could be seen.
      */}
      {/* @container, and the headline is measured in `cqw` — the width of THIS CARD, not the window
          (operator 2026-08-21). `clamp(2rem, 6vw, 3.4rem)` is a VIEWPORT unit, and the shell leaves
          this page a ~718px column at a 1440px window and ~442px at 1100 — so at 1100 the headline
          still resolved to its 54px ceiling inside a 392px box and took three lines, making the hero
          TALLER (511px) on the narrower screen than on the wide one (453px). 7cqw asks the card. */}
      <section className="@container relative overflow-hidden rounded-card border border-line bg-space-2 px-5 py-10 text-center @lg:px-6 @lg:py-14">
        <div className="pointer-events-none absolute -right-24 -top-28 h-80 w-80 rounded-full bg-yang/10 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-28 -left-24 h-80 w-80 rounded-full bg-yin/15 blur-3xl" aria-hidden />
        <div className="relative mx-auto max-w-2xl">
          {/* One text node — see the file header. Deliberately NOT .aq-grad: that gradient runs
              through --color-yang, which is 1.84:1 on the light canvas anonymous visitors get by
              default. The most important line on the site has to be readable before it is pretty. */}
          <h1 className="text-[clamp(1.95rem,7cqw,3.25rem)] font-extrabold leading-[1.07] text-ink [text-wrap:balance]">
            Post stuff that actually works
          </h1>
          <p className="mx-auto mt-4 max-w-[44ch] text-[17px] leading-relaxed text-ink-2">
            Publish work anyone can run again. Hearts decide who takes the prize pool.
          </p>
          <div ref={cta} className="mt-7 inline-flex flex-wrap justify-center gap-3">
            <Button href={join} size="xl">Sign up free</Button>
          </div>
          {/* @artabot, condensed to one line: a real reason to sign up, not a section of its own. */}
          <p className="mt-3 text-[13px] text-ink-3">Tag @artabot on any post and Arta answers in public. No card needed.</p>
        </div>
      </section>

      {/* The live feed IS the pitch. Embedded: no second <h1>, no nested <main>, no rail calls. */}
      <section aria-labelledby="aq-landing-feed">
        <h2 id="aq-landing-feed" className="mb-2 px-1 text-[15px] font-bold uppercase tracking-wider text-ink-3">Happening right now</h2>
        <div className="rounded-card border border-line">
          <Suspense fallback={<FeedSkeleton />}>
            <Feed embedded />
          </Suspense>
        </div>
      </section>

    </div>
  );
}
