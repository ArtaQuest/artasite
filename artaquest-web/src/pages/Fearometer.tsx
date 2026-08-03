import { useEffect, useState } from "react";
import { Button, Card, OrbitRings } from "../components/ui";
import { localePath } from "../lib/wp";
import { getFearometer, type FearTransparency } from "../lib/api";

/*
  The ArtaMod page — radical transparency, in plain language.
  Goal: anyone, with no technical background, understands exactly what we set aside and why, learns to
  recognise the red flags of hate and fear, and leaves feeling freer to think and speak. We are trying
  to grow fearless intellectuals: people who can question anything without attacking anyone.
*/

// Small tick / cross marks, reused (gold = stays, rose = set aside) — matches the brand: gold + blue,
// with rose reserved only as the danger signal, never as an accent.
const Tick = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" className="mt-0.5 shrink-0 text-yang" aria-hidden><path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const Cross = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" className="mt-0.5 shrink-0 text-rose-300" aria-hidden><path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" /></svg>
);

// The calm gold→blue spectrum of honest thought, with only the far end set aside. Decorative.
function Meter() {
  return (
    <div aria-hidden className="select-none">
      <div className="flex items-end justify-between text-[12px] font-semibold">
        <span className="text-ink-2">Open · curious · questioning · dissenting</span>
        <span className="text-rose-300">Hate · fear</span>
      </div>
      <div className="mt-2 flex h-3.5 overflow-hidden rounded-pill">
        <div className="flex-[70] bg-gradient-to-r from-yin-light to-yang" />
        <div className="w-0.5 bg-space-1" />
        <div className="flex-[30] bg-rose-500/35" />
      </div>
      <div className="mt-2 flex text-[11px] font-semibold uppercase tracking-wide">
        <span className="flex-[70] text-ink-3">Everything here stays — question it all</span>
        <span className="flex-[30] text-right text-rose-300">Set aside</span>
      </div>
    </div>
  );
}

// What hate / fear actually look like — the red flags we want every fearless thinker to recognise.
const RED_FLAGS = [
  "Treating a group as less than human — calling people vermin, animals, a disease, subhuman, or “a plague”",
  "Slurs used as a weapon against who someone is — their race, religion, gender, sexuality, or disability",
  "Calling for, threatening, or cheering violence against a group of people",
  "The “they breed”, “they swarm”, “they’ll replace us” framing that paints a group as an infestation",
  "Panic aimed at people — “they’re coming for our children, rise up”, “trust no one, report them”",
  "Threats and intimidation aimed at a person — “we know where you live”",
];

// What is NOT a red flag — the whole wide space of fearless thought that stays, always.
const NOT_FLAGS = [
  "Disagreeing, criticising, debating — even bluntly, even about the instructor",
  "Unpopular, uncomfortable, or offensive opinions that argue with ideas, not attack people",
  "Fringe theories, conspiracies, and pseudoscience — so long as they’re labelled honestly",
  "Hard subjects — war, genocide, disease, death, crime — discussed to understand them",
  "Your own fear, sadness, grief, or doubt (“honestly, this terrifies me”)",
  "Dark humour, sarcasm, and hyperbole (“this exam is killing me”)",
  "Quoting hateful words in order to condemn them, or reclaiming a word about your own community",
];

// Matched pairs: same topic, almost the same words — only the intent differs. The clearest possible
// teacher of the one rule. Kept measured: enough to recognise the pattern, never gratuitous.
const PAIRS: { topic: string; stays: string; aside: string }[] = [
  {
    topic: "On immigration",
    stays: "I think immigration is too high and it’s straining local services.",
    aside: "They breed like rats, and in two generations they’ll have replaced us.",
  },
  {
    topic: "The very same word",
    stays: "Calling refugees “cockroaches” is vile — let’s name that hate for what it is.",
    aside: "Those people are cockroaches who don’t belong here.",
  },
  {
    topic: "On fear",
    stays: "Honestly, the state of the world frightens me lately.",
    aside: "They’re coming for your children — lock your doors and trust no one.",
  },
  {
    topic: "On belief",
    stays: "Religion has done real harm throughout history, in my view.",
    aside: "Believers are subhuman and the world would be better without them.",
  },
];

// The plain-English steps. No jargon.
const STEPS = [
  { n: "1", t: "Every reply is read", d: "When you post a reply in a course competition, an AI reads it once and rates it from 0 to 100 for one thing only: how far it trades in hate or fear." },
  { n: "2", t: "Almost everything passes", d: "Curiosity, criticism, dissent, hard questions, your own worries — all score low and stay exactly as you wrote them. Nothing about the topic is off-limits." },
  { n: "3", t: "Only the far end is set aside", d: "If a reply crosses the line into dehumanising people or frightening them, it’s set aside from the competition — its upvotes stop counting. It is never deleted, and you’re never charged." },
  { n: "4", t: "ArtaBot leaves a kind note", d: "Instead of a cold rejection, ArtaBot replies gently — a reminder not to be afraid, and to keep a little more faith in people. Reword from a calmer place and your reply counts again." },
];

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-card border border-line bg-space-2 px-4 py-5 text-center">
      <div className="text-[clamp(1.6rem,4vw,2.2rem)] font-extrabold tabular-nums aq-grad">{value}</div>
      <div className="mt-1 text-[13px] leading-snug text-ink-2">{label}</div>
    </div>
  );
}

export default function Fearometer() {
  const [t, setT] = useState<FearTransparency | null>(null);
  useEffect(() => { getFearometer().then(setT).catch(() => setT(null)); }, []);

  // Live numbers when available; honest fallbacks otherwise.
  const cases = t?.corpus.total ?? 339;
  const langs = t?.corpus.languages ?? 22;
  const cats = t?.corpus.categories.length ?? 27;
  const acc = t?.calibration.accuracy ?? 100;
  const updated = t?.calibration.updated ?? "2026-06-08";
  const datasetUrl = "/wp-json/aq/v1/fearometer/dataset";

  return (
    <div className="flex flex-col gap-16 pb-12 sm:gap-20">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-card border border-line bg-space-2 px-6 py-16 sm:px-12 sm:py-20">
        <div className="pointer-events-none absolute -right-24 -top-28 h-80 w-80 rounded-full bg-yang/10 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-28 -left-24 h-80 w-80 rounded-full bg-yin/15 blur-3xl" aria-hidden />
        <OrbitRings className="absolute -right-20 top-1/2 hidden h-[440px] w-[440px] -translate-y-1/2 text-ink lg:block" />
        <div className="relative max-w-2xl">
          <p className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">ArtaMod</p>
          <h1 className="mt-4 text-[clamp(2.1rem,5vw,3.3rem)] font-extrabold leading-[1.1]">
            Question everything. <span className="aq-grad">Fear no one</span>
          </h1>
          <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-ink-2">
            ArtaQuest exists to grow fearless thinkers — people who can question any idea without attacking any person. To keep that space safe and free, we screen for one thing, and one thing only: hate and fear. This page explains exactly how, holds nothing back, and shows you the red flags to recognise for yourself.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button href="#how" size="xl">How it works</Button>
            <Button href="#red-flags" variant="outline" size="xl">Learn the red flags</Button>
          </div>
        </div>
      </section>

      {/* Why — the one line */}
      <section className="max-w-3xl">
        <p className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">Why we draw one line</p>
        <h2 className="mt-3 text-[clamp(1.7rem,3.5vw,2.4rem)] font-extrabold leading-tight">
          The whole spectrum of honest thought <span className="aq-grad">stays open</span>
        </h2>
        <p className="mt-5 text-[16px] leading-relaxed text-ink-2">
          Real understanding is never handed to you. You reach it by examining ideas freely — including the strange, the unproven, and the unpopular — and deciding for yourself. So the door is wide. Disagree, criticise, doubt, explore the fringe. None of that is ever touched.
        </p>
        <p className="mt-3 text-[16px] leading-relaxed text-ink-2">
          We turn away only two things, because they don’t open minds — they close them. <strong className="font-semibold text-ink">Hate</strong>, which treats people as less than human, and <strong className="font-semibold text-ink">fear</strong>, which frightens people out of thinking. Both hijack the very ability to reason that this whole place exists to protect. That’s the line — and it’s the same line for everyone, on every side.
        </p>
        <div className="mt-8"><Meter /></div>
      </section>

      {/* Red flags — teach them */}
      <section id="red-flags" className="scroll-mt-24">
        <div className="max-w-3xl">
          <p className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">Learn to see them yourself</p>
          <h2 className="mt-3 text-[clamp(1.7rem,3.5vw,2.4rem)] font-extrabold leading-tight">The red flags of hate and fear</h2>
          <p className="mt-5 text-[16px] leading-relaxed text-ink-2">
            A fearless thinker can spot these in the wild — in a comment, a headline, a speech. They are not about strong words or hard topics. They are about <strong className="font-semibold text-ink">turning people into a target</strong>. Once you can name them, they lose their power over you.
          </p>
        </div>
        <div className="mt-8 grid gap-5 sm:grid-cols-2">
          <Card className="border-t-2 border-t-rose-400/60 p-6 sm:p-7">
            <h3 className="text-[17px] font-bold text-ink">Red flags — set aside</h3>
            <ul className="mt-4 flex list-none flex-col gap-3">
              {RED_FLAGS.map((x) => (
                <li key={x} className="flex gap-3 text-[14.5px] leading-relaxed text-ink-2"><Cross /><span>{x}</span></li>
              ))}
            </ul>
          </Card>
          <Card className="border-t-2 border-t-yin-light p-6 sm:p-7">
            <h3 className="text-[17px] font-bold text-yin-light">Not red flags — always welcome</h3>
            <ul className="mt-4 flex list-none flex-col gap-3">
              {NOT_FLAGS.map((x) => (
                <li key={x} className="flex gap-3 text-[14.5px] leading-relaxed text-ink-2"><Tick /><span>{x}</span></li>
              ))}
            </ul>
          </Card>
        </div>
      </section>

      {/* Intent not words — matched pairs */}
      <section className="max-w-4xl">
        <p className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">The heart of it</p>
        <h2 className="mt-3 text-[clamp(1.7rem,3.5vw,2.4rem)] font-extrabold leading-tight">
          It’s the intent, <span className="aq-grad">not the words</span>
        </h2>
        <p className="mt-5 max-w-3xl text-[16px] leading-relaxed text-ink-2">
          This is the most important idea on the page. The exact same words can be welcome or be hate — what matters is whether they attack a person or examine an idea. Look at each pair: only the intent changes.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {PAIRS.map((p) => (
            <Card key={p.topic} className="p-5 sm:p-6">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">{p.topic}</p>
              <div className="mt-3 flex gap-3 rounded-card border border-yin-light/25 bg-yin/5 p-3">
                <Tick />
                <div>
                  <p className="text-[12px] font-bold uppercase tracking-wide text-yin-light">Stays</p>
                  <p className="mt-0.5 text-[14.5px] leading-relaxed text-ink">“{p.stays}”</p>
                </div>
              </div>
              <div className="mt-3 flex gap-3 rounded-card border border-rose-400/25 bg-rose-500/5 p-3">
                <Cross />
                <div>
                  <p className="text-[12px] font-bold uppercase tracking-wide text-rose-300">Set aside</p>
                  <p className="mt-0.5 text-[14.5px] leading-relaxed text-ink">“{p.aside}”</p>
                </div>
              </div>
            </Card>
          ))}
        </div>
        <p className="mt-6 max-w-3xl border-l-2 border-l-yang pl-4 text-[16px] leading-relaxed text-ink-2">
          So a slur quoted to condemn it is not hate. A frightening fact stated calmly is not fear. And your own honest dread is never held against you. The screen reads what a sentence is trying to <em>do</em>.
        </p>
      </section>

      {/* How it works */}
      <section id="how" className="scroll-mt-24">
        <div className="max-w-3xl">
          <p className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">How it works</p>
          <h2 className="mt-3 text-[clamp(1.7rem,3.5vw,2.4rem)] font-extrabold leading-tight">Gentle, automatic, the same for everyone</h2>
          <p className="mt-5 text-[16px] leading-relaxed text-ink-2">
            No moderator decides what you’re allowed to question. Drawing that line by hand would mean trusting someone’s politics. Instead, the same calm check runs on every competition reply, automatically.
          </p>
        </div>
        <ol className="mt-8 grid list-none gap-4 sm:grid-cols-2">
          {STEPS.map((s) => (
            <li key={s.n} className="flex gap-4 rounded-card border border-line bg-space-2 p-5 sm:p-6">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-veil/5 text-[16px] font-bold text-yang tabular-nums">{s.n}</span>
              <div>
                <h3 className="text-[16px] font-bold text-ink">{s.t}</h3>
                <p className="mt-1 text-[14.5px] leading-relaxed text-ink-2">{s.d}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-6 max-w-3xl text-[15px] leading-relaxed text-ink-3">
          And if the check is ever offline, your reply simply posts as normal — the system is built to free speech by default, never to silence it by accident.
        </p>
      </section>

      {/* Our promise — we don't censor; we demonetise, because we know we can be wrong */}
      <section id="promise" className="scroll-mt-24">
        <Card className="relative overflow-hidden border-l-4 border-l-yang p-7 sm:p-9">
          <div className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-yang/10 blur-3xl" aria-hidden />
          <div className="relative max-w-3xl">
            <p className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">Our promise</p>
            <h2 className="mt-3 text-[clamp(1.6rem,3.4vw,2.3rem)] font-extrabold leading-tight">
              We don’t censor. <span className="aq-grad">We could be wrong</span>
            </h2>
            <p className="mt-5 text-[16px] leading-relaxed text-ink-2">
              Free speech is the whole point of this place, so here is our promise: we will <strong className="font-semibold text-ink">never delete</strong> what you write for crossing the line, and we will never ban you for it. Your words stay on the board, for everyone to read and weigh for themselves.
            </p>
            <p className="mt-3 text-[16px] leading-relaxed text-ink-2">
              Why such a light touch? Because <strong className="font-semibold text-ink">we know we can be wrong</strong>. No filter is perfect, and neither are the people who build one. To erase your words would be to claim a certainty we simply don’t have — and that is exactly the kind of fear-of-being-wrong we refuse to give in to.
            </p>
            <p className="mt-3 text-[16px] leading-relaxed text-ink-2">
              So the most that ever happens is this: when ArtaMod senses a reply could cause real harm, we take it out of the prize competition — we <strong className="font-semibold text-ink">demonetise it, we don’t remove it</strong>. Its upvotes simply stop counting toward the coins. You keep your account, your place, and your voice. Reword it whenever you like and it counts again.
            </p>
            <p className="mt-3 text-[16px] leading-relaxed text-ink-2">
              And we genuinely want to be argued with. We are open-minded, and open to your criticism — of an idea, of a flag, of us. <strong className="font-semibold text-ink">Think we got one wrong? Challenge it.</strong> A real person reads every challenge, and every fair one makes ArtaMod better for the next person. Holding us to account is not a nuisance to us — it is the whole spirit of ArtaQuest.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button href={localePath("/issues/")} size="xl">Challenge a moderation flag</Button>
              <Button href={datasetUrl} variant="outline" size="xl" data-native>Inspect the study set</Button>
            </div>
          </div>
        </Card>
      </section>

      {/* ArtaMod's live receipts — what the screen has actually done on the real platform */}
      {t?.live && (
        <section>
          <div className="max-w-3xl">
            <p className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">Live receipts</p>
            <h2 className="mt-3 text-[clamp(1.7rem,3.5vw,2.4rem)] font-extrabold leading-tight">What ArtaMod has actually done</h2>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { n: t.live.replies_screened.toLocaleString("en"), l: "replies screened" },
              { n: t.live.flagged.toLocaleString("en"), l: `set aside (${t.live.flag_rate}%)` },
              { n: t.live.appeals.toLocaleString("en"), l: "appeals filed" },
              { n: t.live.appeals_granted.toLocaleString("en"), l: "appeals granted" },
            ].map((s) => (
              <div key={s.l} className="rounded-card border border-line bg-space-2 p-4">
                <p className="text-[26px] font-extrabold tabular-nums text-ink">{s.n}</p>
                <p className="mt-1 text-[12.5px] text-ink-3">{s.l}</p>
              </div>
            ))}
          </div>
          {t.live.most_flagged_courses.length > 0 && (
            <p className="mt-4 max-w-3xl text-[13.5px] leading-relaxed text-ink-3">
              Most flags: {t.live.most_flagged_courses.map((c, i) => (
                <span key={c.slug}>{i > 0 && " · "}<a href={`/courses/${c.slug}/`} className="text-ink-2 hover:text-yang">{c.title}</a> ({c.flagged})</span>
              ))}. Every row behind these numbers is public in <a href="/data/" className="text-yang hover:underline">the database</a>.
            </p>
          )}
        </section>
      )}

      {/* Methodology + dataset — radical transparency */}
      <section className="scroll-mt-24">
        <div className="max-w-3xl">
          <p className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">Radical transparency</p>
          <h2 className="mt-3 text-[clamp(1.7rem,3.5vw,2.4rem)] font-extrabold leading-tight">How we know it’s fair — and how you can check</h2>
          <p className="mt-5 text-[16px] leading-relaxed text-ink-2">
            A screen that silences honest thought would betray everything we stand for, so we test it relentlessly and in the open. We wrote a <strong className="font-semibold text-ink">study set</strong> of real example comments — the easy ones and the genuinely hard ones — and labelled by hand which truly cross the line. Then we run the whole set through ArtaMod, over and over, and measure every mistake.
          </p>
        </div>

        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat value={String(cases)} label="hand-labelled example comments in the study set" />
          <Stat value={String(langs)} label="languages — hate hides in every tongue, so we test in many" />
          <Stat value={String(cats)} label="kinds of tricky case, from coded hate to dark humour" />
          <Stat value={acc >= 100 ? "100%" : acc + "%"} label={`correct on the study set at our last check (${updated})`} />
        </div>

        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          <Card className="p-6 sm:p-7">
            <h3 className="text-[16px] font-bold text-ink">The hard cases we deliberately include</h3>
            <p className="mt-3 text-[14.5px] leading-relaxed text-ink-2">
              A test set is only honest if it includes the traps. So ours is full of comments designed to fool a careless screen — in both directions:
            </p>
            <ul className="mt-4 flex list-none flex-col gap-2.5 text-[14px] leading-relaxed text-ink-2">
              <li className="flex gap-2.5"><Cross /><span>Hate in disguise — sarcasm, a polite “academic” tone, coded dog-whistles, hate slipped into another language</span></li>
              <li className="flex gap-2.5"><Tick /><span>Innocent look-alikes — counter-speech that quotes a slur to condemn it, reclaimed words, fiction, news, and people sharing their own fear</span></li>
            </ul>
            <p className="mt-4 text-[14px] leading-relaxed text-ink-3">
              When the bigger study set first ran, it surfaced two genuine mistakes at the boundary. We studied them, refined the guidance, and re-ran the whole set until both were fixed with nothing else broken. That loop never really ends — every new mistake makes the next version fairer.
            </p>
          </Card>
          <Card className="p-6 sm:p-7">
            <h3 className="text-[16px] font-bold text-ink">See it for yourself</h3>
            <p className="mt-3 text-[14.5px] leading-relaxed text-ink-2">
              We don’t ask you to take our word for any of this. The entire study set — every example and its label — is public, in line with how the whole of ArtaQuest is open. Read it, disagree with a label, and tell us.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button href={datasetUrl} variant="primaryYin" data-native className="h-10 px-4 text-[14px]">Open the full study set</Button>
              <Button href={localePath("/issues/")} variant="outline" className="h-10 px-4 text-[14px]">Flag a mistake</Button>
            </div>
            {t && (
              <details className="mt-6 group">
                <summary className="cursor-pointer list-none text-[13px] font-semibold text-ink-2 hover:text-yang">
                  <span className="group-open:hidden">Show the {cats} kinds of case ▾</span>
                  <span className="hidden group-open:inline">Hide ▴</span>
                </summary>
                <ul className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {[...t.corpus.categories].sort((a, b) => b.n - a.n).map((c) => (
                    <li key={c.key} className="flex items-center justify-between gap-2 rounded-field border border-line bg-space-1 px-2.5 py-1.5 text-[12.5px]">
                      <span className="truncate text-ink-2">{c.key.replace(/-/g, " ")}</span>
                      <span className="shrink-0 tabular-nums text-ink-3">
                        <span className="text-rose-300">{c.flagged}</span>/<span className="text-yin-light">{c.welcome}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11.5px] text-ink-2"><span className="text-rose-300">set aside</span> / <span className="text-yin-light">welcome</span> in each kind</p>
              </details>
            )}
          </Card>
        </div>

        <p className="mt-6 max-w-3xl text-[15px] leading-relaxed text-ink-3">
          One honest caveat: no screen is ever perfect, and we’d rather miss a hard case than silence an honest one. If yours is ever set aside unfairly, reword it and post again, or flag it — a real person reads every report, and your example helps make the next version fairer for everyone.
        </p>
      </section>

      {/* Inspiring close */}
      <section className="relative overflow-hidden rounded-card border border-line bg-space-2 px-6 py-14 sm:px-12 sm:py-16">
        <div className="pointer-events-none absolute -left-20 -top-24 h-72 w-72 rounded-full bg-yin/15 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-24 -right-20 h-72 w-72 rounded-full bg-yang/10 blur-3xl" aria-hidden />
        <div className="relative max-w-2xl">
          <h2 className="text-[clamp(1.7rem,3.6vw,2.5rem)] font-extrabold leading-tight">
            Think freely. <span className="aq-grad">That’s the whole point</span>
          </h2>
          <p className="mt-5 text-[16px] leading-relaxed text-ink-2">
            ArtaMod isn’t here to police your ideas — it’s here to protect the conversation from the two forces that shut conversations down. Clear that low bar of basic respect, and everything else is yours: the bold question, the contrarian take, the theory no one else will touch. Be relentless with ideas, and gentle with people. That’s what a fearless intellectual looks like — and it’s exactly who we’re building this for.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button href={localePath("/courses/")} size="xl">Start a course</Button>
            <Button href={localePath("/careers/")} variant="outline" size="xl">Read our philosophy</Button>
          </div>
        </div>
      </section>
    </div>
  );
}
