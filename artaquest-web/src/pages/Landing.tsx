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
    <div className="flex flex-col gap-10 pb-12">
      {/*
        Hero. The words take the left; the right used to hold the orbit motif and now holds Arta,
        who stands on the same hairline the whole page is built on. A mascot that shares the
        visitor's ground line reads as being in the room; one floating in a decorative box does not.
      */}
      <section className="relative overflow-hidden rounded-card border border-line bg-space-2 px-4 pb-[150px] pt-12 text-center sm:px-6 sm:pt-16 sm:pb-[178px] lg:px-12 lg:text-start">
        <div className="pointer-events-none absolute -right-24 -top-28 h-80 w-80 rounded-full bg-yang/10 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-28 -left-24 h-80 w-80 rounded-full bg-yin/15 blur-3xl" aria-hidden />
        <div className="relative mx-auto max-w-2xl lg:mx-0 lg:max-w-[36rem]">
          {/* One text node — see the file header. Deliberately NOT .aq-grad: that gradient runs
              through --color-yang, which is 1.84:1 on the light canvas anonymous visitors get by
              default. The most important line on the site has to be readable before it is pretty;
              the brand still carries the section through the gold/blue glow and the CTA. */}
          <h1 className="text-[clamp(2.1rem,5.5vw,3.4rem)] font-extrabold leading-[1.07] text-ink">
            Post stuff that actually works
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-[16.5px] leading-relaxed text-ink-2 lg:mx-0">
            Say something in 280 characters, or publish work anyone can run again for themselves —
            games, art, animations, datasets, models, papers. Every published file comes from a
            public Kaggle notebook that has already been run, and we check that in the open. Hearts
            decide who wins the prize pools.
          </p>
          <div ref={cta} className="mt-7 inline-flex flex-wrap justify-center gap-3 lg:justify-start">
            <Button href={join} size="xl">Join in — it's free</Button>
          </div>
          <p className="mt-3 text-[13px] text-ink-3">No password, no spam — just your email or Google.</p>
        </div>
      </section>

      {/* ArtaBot — the free chatbot is a real reason to sign up, so the landing page SELLS it. The
          widget itself is members-only (App.tsx gates the launcher; the artabot routes are user-auth),
          which is exactly why a visitor sees this pitch here instead of the chat. */}
      <section className="rounded-card border border-line bg-space-2 px-6 py-8 text-center">
        <p className="text-[12px] font-bold uppercase tracking-wider text-ink-3">Free with every account</p>
        <h2 className="mt-2 text-[22px] font-extrabold text-yang-ink sm:text-[26px]">
          Chat with a state-of-the-art AI — free, forever
        </h2>
        <p className="mx-auto mt-3 max-w-[60ch] text-[14.5px] leading-relaxed text-ink-2">
          ArtaBot runs on Claude Opus 5, one of the most capable models there is. Ask it anything, think
          out loud, get help making something — it remembers your conversation and it costs nothing.
          Members can spend ArtaCoin for deeper thinking when a question deserves it, but the everyday
          chat is simply free.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Button href={join} size="lg">Sign up free to chat</Button>
        </div>
        <p className="mt-3 text-[12.5px] text-ink-3">No card, no trial, no message limit</p>
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

      {/* A visitor who read the whole page used to arrive at the footer with nothing to do. */}
      <section className="rounded-card border border-line bg-space-2 px-6 py-10 text-center">
        <h2 className="text-[22px] font-extrabold">Make the next one</h2>
        <p className="mx-auto mt-2 max-w-[52ch] text-[14.5px] leading-relaxed text-ink-2">
          Submitting, checking and publishing are all free — always, because the Foundation runs on
          donations. You only ever pay to enter a tournament, and every coin of that fee goes straight
          into its prize pool, where the most-hearted entry takes it all.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Button href={join} size="lg">Create your free account</Button>
        </div>
      </section>
    </div>
  );
}
