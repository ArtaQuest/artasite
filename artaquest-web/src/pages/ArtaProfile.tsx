/**
 * /arta — the mascot's own profile.
 *
 * Every member here has a profile, so the mascot has one too, and it is the
 * character bible rather than a marketing page: who Arta is, the rules that
 * keep a companion from becoming a nuisance, and a stage where you can make it
 * do each thing yourself. A mascot nobody can inspect is a logo.
 *
 * i18n: every sentence is ONE text node. The mesh translates text nodes
 * individually, so a sentence split by a styling <span> gets translated in
 * halves into ~133 languages.
 */
import { useEffect, useRef } from "react";
import { arta } from "../generated/arta/rig/arta";
import { Button } from "../components/ui";
import { localePath } from "../lib/wp";

/** The behaviour vocabulary, as a thing you can press. */
const MOVES: Array<[string, () => void, string]> = [
  ["Wave", () => arta.wave(), "Hello. Used once, on arrival, never on a loop."],
  ["Aim", () => arta.pointAt(document.getElementById("arta-target")), "The signature. Sagittarius is the archer, so Arta aims at what matters."],
  ["Leap", () => arta.cheer(), "Something worked. Anticipate, launch, absorb — a jump with no crouch reads as a shrug."],
  ["Think", () => arta.think(), "Weight on one leg, a hand near the head. Thinking, with no face to think with."],
  ["Read", () => arta.peer(), "Leaning in. The truth-seeker's default posture."],
  ["Shrug", () => arta.shrug(), "That didn't work, and pretending otherwise would be worse."],
  ["Travel", () => arta.travelTo(document.getElementById("arta-target")),
    "Go there. Short and level is a walk; far or vertical is a rope — the arrow carries the line."],
];

const LAWS: Array<[string, string]> = [
  ["It never blocks", "Arta does not cover content, never opens a dialogue, and never needs dismissing. It draws on a layer that cannot receive a click, so it can never swallow one meant for a button."],
  ["It reacts, it does not interrupt", "Arta answers what you do. It has no opinions to volunteer, no tips to offer, and nothing to say that you did not just cause."],
  ["It goes still when you work", "Typing, reading, scrolling — Arta settles. Presence and motion are different things, and a companion that moves while you are concentrating is furniture that fidgets."],
];

export default function ArtaProfile() {
  const target = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => arta.wave(), 700);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8 pb-14">
      {/* Hero — Arta at full size, on the page's own baseline. */}
      <section className="relative overflow-hidden rounded-card border border-line bg-space-2 px-6 pb-[210px] pt-10 sm:px-10">
        <div className="pointer-events-none absolute -right-24 -top-28 h-80 w-80 rounded-full bg-yang/10 blur-3xl" aria-hidden />
        <p className="text-[12px] font-bold uppercase tracking-wider text-ink-3">Mascot in residence</p>
        <h1 className="mt-2 text-[clamp(2rem,5vw,3rem)] font-extrabold leading-[1.05] text-ink">Arta</h1>
        <p className="mt-3 max-w-[58ch] text-[16px] leading-relaxed text-ink-2">
          Curious, truth-seeking, adventurous — a Sagittarius, which is why the one gesture Arta has
          all to itself is aiming at something. It has no face on purpose: with no expression to lean
          on, everything has to be said with posture and timing, and that is a discipline rather than
          a shortcut.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {["Curious", "Truth-seeker", "Adventurous", "Sagittarius", "Faceless, on purpose"].map((t) => (
            <span key={t} className="rounded-full border border-line px-3 py-1 text-[12.5px] text-ink-2">{t}</span>
          ))}
        </div>
      </section>

      {/* The stage — the vocabulary, as buttons. */}
      <section className="rounded-card border border-line bg-space-2 p-6 sm:p-8">
        <h2 className="text-[20px] font-extrabold text-ink">Make it do something</h2>
        <p className="mt-1.5 max-w-[62ch] text-[14.5px] leading-relaxed text-ink-2">
          This is the whole vocabulary. Every gesture is one function in the rig and one line in the
          state machine, which is what makes it cheap to give Arta something new to do.
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {MOVES.map(([name, run, why]) => (
            <button
              key={name}
              type="button"
              onClick={run}
              className="rounded-card border border-line bg-space-1 p-4 text-start transition hover:border-yin hover:bg-space-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <span className="block text-[15px] font-bold text-yang-ink">{name}</span>
              <span className="mt-1 block text-[13px] leading-relaxed text-ink-3">{why}</span>
            </button>
          ))}
        </div>
        <div ref={target} id="arta-target" className="mt-6 rounded-card border border-dashed border-line px-4 py-6 text-center">
          <p className="text-[13.5px] text-ink-3">Press Aim, and watch where Arta sends the arrow.</p>
        </div>
      </section>

      {/* The rules — the part that actually keeps it likeable. */}
      <section className="rounded-card border border-line bg-space-2 p-6 sm:p-8">
        <h2 className="text-[20px] font-extrabold text-ink">Three laws</h2>
        <p className="mt-1.5 max-w-[62ch] text-[14.5px] leading-relaxed text-ink-2">
          A character on every page is either a companion or an irritation, and the difference is
          entirely in what it refuses to do.
        </p>
        <div className="mt-5 grid gap-5 sm:grid-cols-3">
          {LAWS.map(([h, b], i) => (
            <div key={h}>
              <p className="text-[12px] font-bold uppercase tracking-wider text-ink-3">{`Law ${i + 1}`}</p>
              <h3 className="mt-1 text-[15.5px] font-extrabold text-yang-ink">{h}</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-ink-2">{b}</p>
            </div>
          ))}
        </div>
        <p className="mt-6 border-t border-line pt-5 text-[14px] leading-relaxed text-ink-2">
          There is a fourth rule that is not really Arta's: if your system asks for reduced motion,
          Arta stops moving entirely and holds a single pose. It is still there, it can still point
          at things, and no animation frame is ever scheduled. Absence would have been the lazy
          answer to that setting.
        </p>
      </section>

      {/* Provenance — the mascot is not a drawing, it is a rig with a published credit. */}
      <section className="rounded-card border border-line bg-space-2 p-6 sm:p-8">
        <h2 className="text-[20px] font-extrabold text-ink">One rig, two lives</h2>
        <p className="mt-2 max-w-[68ch] text-[14.5px] leading-relaxed text-ink-2">
          Arta on this page and Arta in the film are the same skeleton, the same joint convention and
          the same cadence rules — the figure holds each drawing for two frames while it is calm and
          drops to one while it moves, which is the hand-drawn cadence rather than a smooth tween.
          Keeping the two in step is the point: two mascots that merely resemble each other are no
          mascot at all.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button href={localePath("/works/")} variant="outline">See Arta's published work</Button>
          <Button href={localePath("/login/")}>Join in — it's free</Button>
        </div>
      </section>
    </div>
  );
}
