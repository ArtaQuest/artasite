import { useEffect, useRef, type ReactNode } from "react";
import { Button, Card } from "../components/ui";
import { watchMath } from "../lib/math";
import { localePath } from "../lib/wp";
import founderPhoto from "../assets/founder.jpg";
import founderAvatar from "../assets/founder-avatar.jpg";

/**
 * /about — what ArtaQuest is, who runs it, and the argument it is built on.
 *
 * Four audiences land here and want different things: a prospective member deciding whether to trust
 * the place, a journalist after the entity, a donor, and a CEO candidate deep-linked to `#founder`.
 * THREE sections, ordered by commitment — what it is (hero) → who runs it → why he runs it. Everything
 * else was a second telling: the CV retold the founder's own note, the two positioning cards retold
 * the hero, and the funding section retold RULES[3] and the note.
 *
 * The right rail is GONE (operator, 2026-08-03). It held one "Check it yourself" card — the reserve,
 * the ledgers and the registration — and those three links live in the page's own text and in the
 * left nav, so it was a fourth telling of what the page already says. Removing it took WithRail and
 * RailInline with it: a rail with nothing in it is not a layout, and this page now runs full width.
 *
 * THE PHILOSOPHY SECTION IS THE POINT OF THE PAGE (operator, 2026-07-31). It is the founder's own
 * argument, in first person, placed immediately AFTER his signed note because it is that note's last
 * paragraph written out properly — including the two things in the note that are wrong (the mechanism
 * by which a language model narrows, and the second law "ensuring" the mission succeeds). A signed
 * personal essay can only honestly be corrected in the same voice that signed it, so nothing in
 * FOUNDER changes and the correction lives below it.
 *
 * Every factual claim here was checked against shipped code, because the page's whole argument is
 * that its claims are checkable. These were DELETED for failing that check and must not come back
 * without a code path behind them:
 *   • "the small spread on buying and selling coins" — `Economy::sell` returns 503 while
 *     `cashout_enabled()` is false, so the sell leg is not a live revenue source.
 *   • "held in full reserve" — `Economy::reserve()` deliberately publishes the TRUE, possibly
 *     under-collateralised ratio (Economy.php:791-794), and /reserve renders it live. Say the RATIO
 *     is published; never say the coins are fully backed.
 *   • "donations accepted only from independent individuals — never from governments, corporations…"
 *     — implemented nowhere: no donor-class field, no screening, no refusal path in Funds.php.
 *   • "No autoplay" — components/nbview.tsx:471 renders every unflagged teaser `autoPlay={!flagged}
 *     muted loop`; only videos over the viewer's Motion-calm threshold render paused.
 *   • "the only fee anywhere is a challenge entry" — Shop.php:73 prices goods in `price_coins` and
 *     orders carry `coins_total`, so a printed book costs coins. The true form is "the only fee to
 *     take part".
 *   • "The full record on his profile →" — Profile.tsx renders a bio, counts and a post grid. There
 *     is no career record there to link to.
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
    body: "I was born in Tehran on 15 February 1994. I have two sisters, and we were raised by a single mom who taught French and English. I loved physics most of all, and as a teenager I competed in Iran's national olympiads. I have lived most of my life abroad — across Malaysia, Turkey, and Canada. I started teaching very young, and learned that teaching something is the best way to understand it deeply.",
  },
  {
    label: "The climb",
    body: "I had one goal — to figure out how the universe works, and why — and I followed it upward. From gases to galaxies, then to circuits and information systems, then to machine intelligence, and finally toward biological intelligence: the universe's masterpiece, the matter with the most degrees of freedom, the most conscious entropy. That climb led me to artificial intelligence, and I moved to Montréal to study it for a PhD.",
  },
  {
    label: "Why I left the PhD",
    body: "I passed the qualifying exam, but the more I saw of how these systems are trained, the more they worried me. An AI is trained to minimise entropy — to collapse a world of possibilities into its single most likely answer. That makes it confident, often overconfident: it hands you that answer before you have even finished your question, and points everyone toward the same one. Slowly, this can weaken our ability to think for ourselves — and, by narrowing the variety that change depends on, it could even harm our evolution over time. The danger looked less like the science-fiction fear of machines taking over, and more like people quietly choosing to let the machine think for them. As a researcher, I had no answer to this. As a teacher, I thought I might. So I left the PhD and returned to education.",
  },
  {
    label: "What science cannot ask",
    body: "I helped found Neuromatch Academy, an online school for science, and my most recent work was at the Center for Rigor, on how to make science itself more honest. Both taught me the same lesson. Science explains how the world works, but on its own it does not ask why — why we use what we learn, or who it serves. That question belongs to philosophy. Without it, science becomes only a tool — and that is how it earns its bad reputation: not because it is wrong, but because, lacking the why, it is so easily turned to domination and the suppression of people.",
  },
  {
    label: "Why ArtaQuest",
    body: "ArtaQuest grew from that: take the best free knowledge the world has already produced — on whatever people most need to learn — and give it an honest, focused home, free of propaganda, where anyone can learn it and think for themselves. I run it alone, on purpose: no employer, no funder, no organisation telling me what to teach. That keeps it honest, and keeps it on the mission I have set for my own life — to widen what every being is free to think, choose, and become, for as many as possible, across time and space. And the second law of thermodynamics ensures that time itself will serve this mission. So our success is only a matter of time…",
  },
];

/* ── The philosophy ─────────────────────────────────────────────────────────
   The equations are LaTeX in `\[ … \]` delimiters, typeset by KaTeX via watchMath("auto").
   They live inside `data-ay-skip="1"` wrappers: the i18n mesh walks text nodes and would otherwise
   publish the LaTeX source into the PUBLIC aq_translations table and serve translated nonsense at
   first paint in the other ~131 locales. The prose gloss stays OUTSIDE the skip — it must translate. */

const EQ_BOLTZMANN = String.raw`\[ S \;=\; k_{\mathrm{B}} \log W \]`;
const EQ_OBJECTIVE = String.raw`\[ J(a) \;=\; \int_{t_{0}}^{\infty} S_{\oplus}\bigl(t \mid a\bigr)\,\mathrm{d}t \]`;
const EQ_COMPARE = String.raw`\[ a \succ b \iff \lim_{T \to \infty} \int_{t_{0}}^{T} \Bigl[\, S_{\oplus}(t \mid a) - S_{\oplus}(t \mid b) \,\Bigr]\,\mathrm{d}t \;>\; 0 \]`;

/** The objections, answered. Four: the two that would sink the argument if unanswered (heat death,
 *  and the is/ought jump) plus the two an honest reader actually raises. */
const OBJECTIONS: { q: string; a: string }[] = [
  {
    q: "Maximising entropy means heat death — an argument for destroying the planet",
    a: "Heat death is not this quantity's maximum. It is its minimum: the molecular count as large as it can ever be, and exactly one distinguishable story left. One way left is the logarithm of one, which is zero. A burnt Earth scores nothing from that moment to eternity — and the integral runs to eternity.",
  },
  {
    q: "The second law says entropy rises anyway, so this is automatic",
    a: "The second law governs an isolated system — nothing in, nothing out. Earth misses that by about 120,000 terawatts of sunlight. And it only fixes the sign of one derivative. Every extinction obeys it. So does every rescue.",
  },
  {
    q: "Then burn everything. A fire raises entropy fastest",
    a: "A fire raises the molecular count fastest and destroys the count of futures fastest — and it is the futures that are measured. That is why the limit is forever: over a finite horizon you can win by spending capital; over an unbounded one only by keeping alive the thing that generates futures. An extinction sets every later term to zero, and no spike is large enough to pay for that.",
  },
  {
    q: "Physics describes; it cannot tell you what to want",
    a: "Correct. This is not a discovery, it is a preference — written in a language that can be argued with. You can point at something I do and argue, with evidence, that it lowers the count, and then I have to answer. It is a floor, not an ethics: a person can be free and miserable. It says only, do not be the one who closes the door.",
  },
];

/** The rules the platform actually runs on, one line each. The three that are NOT derived from the
 *  equation stay marked as such: a list that quietly claimed them would be the exact post-hoc
 *  rationalisation this section exists to avoid. */
const RULES: { rule: string; body: string }[] = [
  {
    rule: "The gate never scores",
    body: "The checklist returns facts, each naming the evidence it read. No number, no grade. Members do rank published work — the top tab counts hearts, and a challenge pays its most-hearted entry the pool — but that decides prizes, never admission.",
  },
  {
    rule: "Every input must be public",
    body: "A result built on a private dataset has exactly one possible re-runner.",
  },
  {
    rule: "The whole database is public — and this rule argues with itself",
    body: "Every table, every row, live — bar live credentials, a member's private book sources and a shop delivery address. Publishing a member's activity widens everyone else's view and narrows theirs. I resolved that towards publication, and would most like to be argued out of it.",
  },
  {
    rule: "Reading, submitting, checking and publishing are free",
    body: "A price is a filter on who can act. The only fee to take part is a challenge entry, paid back out to the entrants in full.",
  },
  {
    rule: "No hate, no fear — a judgement, not a derivation",
    body: "Every comment under a post is scored for hate or fear as it posts. One over the line is marked, never removed.",
  },
  {
    rule: "Publication is the author's alone — not derived",
    body: "A single-use secret goes to the author's own inbox; their click and device signature publish it. Option-counting alone would happily publish a stranger's work. Consent is a limit I place on the objective, not a result of it.",
  },
  {
    rule: "Hearts, never downvotes — a judgement, not a derivation",
    body: "No interface here can produce a minus one. The reason is not the equation: it is that a one-click way to bury a stranger's work makes a worse room to think in.",
  },
];

function IntegralFigure() {
  return (
    <figure className="mt-8">
      <div className="overflow-x-auto rounded-card border border-line bg-space-2 p-4 sm:p-6" dir="ltr">
        <svg
          viewBox="0 0 720 330"
          role="img"
          preserveAspectRatio="xMidYMid meet"
          className="h-auto w-full min-w-[520px] text-ink"
        >
          <title>Two futures, same second law</title>
          <desc>
            Two curves start from the same point. One spikes very high, crashes to zero early and stays
            there, enclosing only a small area. The other rises less far but stays up for the whole
            width of the picture, enclosing a much larger area — because the area is added up forever.
          </desc>

          {/* axes — one L-shaped hairline, no gridlines. The horizontal stops short of the edge so the
              ∞ can sit past its end and read as "this axis does not stop". */}
          <g stroke="currentColor" strokeOpacity="0.28" strokeWidth="1">
            <path d="M72 24 V286" />
            <path d="M72 286 H668" />
            <path d="M110 286 v6" />
          </g>
          <text x="694" y="291" textAnchor="middle" fontSize="16" fill="#4A72FF" fillOpacity="0.75" data-ay-skip="1">∞</text>

          {/* Curve A — the sustained future. Area first, so the stroke sits on top of it.
              IT MUST NOT RETURN TO THE AXIS. A gold curve that decays to zero at the right-hand edge
              draws the sustained future dying too, which is the opposite of what the section argues;
              it stays elevated and the area is closed with a vertical edge, reading as "continues". */}
          <path
            d="M110,252 C170,190 240,140 320,128 C420,113 520,120 600,128 C640,132 650,134 668,136 L668,286 L110,286 Z"
            fill="#E8B923" fillOpacity="0.16"
          />
          <path
            d="M110,252 C170,190 240,140 320,128 C420,113 520,120 600,128 C640,132 650,134 668,136"
            fill="none" stroke="#E8B923" strokeWidth="2.25" strokeLinecap="round" vectorEffect="non-scaling-stroke"
          />

          {/* Curve B — the spike. It reaches the baseline at x≈200 and STAYS there: a collapsed branch
              that hovers above the axis would draw a still-accruing integral in a figure whose whole
              claim is that the area stops accruing, which is the very objection this exists to answer. */}
          <path
            d="M110,252 C122,190 134,86 150,54 C166,88 176,200 190,262 C194,278 196,286 200,286 L668,286 L110,286 Z"
            fill="currentColor" fillOpacity="0.1"
          />
          <path
            d="M110,252 C122,190 134,86 150,54 C166,88 176,200 190,262 C194,278 196,286 200,286 L668,286"
            fill="none" stroke="currentColor" strokeOpacity="0.7" strokeWidth="1.5" strokeDasharray="5 4"
            vectorEffect="non-scaling-stroke"
          />

          {/* leader labels — placed off the curves they name, and vertically separated from each other
              (the first draft had these two overlapping). */}
          <g stroke="currentColor" strokeOpacity="0.3" strokeWidth="1">
            <path d="M154 52 L168 44" />
            <path d="M430 112 V102" />
          </g>
          <g fontSize="11.5" fill="currentColor" fillOpacity="0.66">
            <text x="172" y="41">spend it now — a spike, then nothing</text>
            <text x="430" y="96" textAnchor="middle">keep it alive — the count keeps branching</text>
          </g>

          {/* the one thing the figure has to teach */}
          <text x="420" y="222" textAnchor="middle" fontSize="11.5" fill="currentColor" fillOpacity="0.62">
            the shaded area is the integral
          </text>

          {/* axis labels */}
          <g fontSize="11" fill="currentColor" fillOpacity="0.66">
            <text x="110" y="304" textAnchor="middle">now</text>
            <text x="668" y="304" textAnchor="end">time, without end</text>
            <text x="26" y="155" textAnchor="middle" fontSize="11.5" transform="rotate(-90 26 155)">
              how many ways it could still go
            </text>
          </g>
        </svg>
      </div>
      <figcaption className="mx-auto mt-3 max-w-[60ch] text-center text-[12.5px] leading-relaxed text-ink-2">
        Both obey the second law. Only one of them keeps the integral growing
      </figcaption>
    </figure>
  );
}

/* ───────────────────────── page ───────────────────────── */

export default function About() {
  // The philosophy section carries three display equations. watchMath typesets them and KEEPS them
  // typeset — a bare one-shot render reverts to raw LaTeX on any re-render or i18n text-node swap.
  const mathRef = useRef<HTMLDivElement>(null);
  useEffect(() => watchMath(mathRef.current, "auto"), []);

  return (
    <div className="flex flex-col gap-16 pb-12 sm:gap-20">
      {/* Hero. The h1 is ONE text node with no inner `aq-grad` span: the i18n mesh walks text nodes
          individually, so a split heading is translated as two disconnected fragments in every
          locale, and `.aq-grad` measures ~1.84:1 on the default light canvas. */}
      <section className="relative overflow-hidden rounded-card border border-line bg-space-2 px-6 py-16 sm:px-12 sm:py-20">
        <div className="relative max-w-2xl">
          <h1 className="text-[clamp(1.85rem,3.2vw+1.1rem,3.3rem)] font-extrabold leading-[1.1]">
            Work you can check for yourself
          </h1>
          <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-ink">
            A not-for-profit social media for science and education. Every post is a public Kaggle
            notebook, run on Kaggle's own machines, checked against its public record and published
            only by its author. Free to read and re-run forever.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button href="/works/" size="xl">Open the feed</Button>
          </div>
        </div>
      </section>

      <div>
        <div className="flex flex-col gap-16 sm:gap-20">
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
            <Card className="mt-6 border-s-2 border-s-yang p-7 sm:p-9">
              <figure className="mx-auto mb-6 max-w-[280px] sm:float-end sm:mx-0 sm:mb-3 sm:ms-8 sm:w-60 sm:max-w-none">
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
              <div data-aq-vocab-exempt="founder-note" className="space-y-6 text-[15.5px] leading-relaxed text-ink [text-wrap:pretty]">
                {FOUNDER.map((p) => (
                  <div key={p.label} className="lg:grid lg:grid-cols-[9rem_1fr] lg:gap-x-8">
                    <p className="mb-1 text-[12.5px] font-semibold uppercase tracking-[0.14em] text-ink-2 lg:mb-0 lg:mt-1">{p.label}</p>
                    <p className="max-w-[68ch]">{p.body}</p>
                  </div>
                ))}
              </div>
              <p className="clear-both mt-6 font-display text-[21px] font-medium italic text-yang">— Arash</p>
              {/* Everything the deleted CV section could still tell a reader that his own note does
                  not: the years, and the two outbound links. Dates are load-bearing — undated
                  affiliations under a signature read as present tense, and he left both in 2024. */}
              <p className="mt-5 border-t border-line pt-4 text-[13.5px] leading-relaxed text-ink-2">
                Before ArtaQuest:{" "}
                <a href="https://www.neuromatchacademy.org/" target="_blank" rel="noopener noreferrer" className="text-yin-light underline underline-offset-2">
                  Neuromatch Academy<span className="sr-only"> (opens in a new tab)</span>
                </a>{" "}(2021 – 24),{" "}
                <a href="https://c4r.io" target="_blank" rel="noopener noreferrer" className="text-yin-light underline underline-offset-2">
                  the Center for Rigor<span className="sr-only"> (opens in a new tab)</span>
                </a>{" "}(2023 – 24) and SmartAlpha (2019 – 21); PhD studies at ÉTS Montréal (2021 – 24),
                BSc at Bilkent (2015 – 19).
              </p>
            </Card>
          </section>

          {/* ── THE PHILOSOPHY ── Unboxed prose on the page canvas: this is the one section people are
              meant to read rather than scan. */}
          <section ref={mathRef}>
            <H2 id="philosophy">I want to widen what is still possible</H2>
            <p className="mt-3 text-[13px] text-ink-2">Arash Ashrafnejad · the long version of the last paragraph above</p>

            <div className="mt-8 max-w-[68ch] space-y-5 text-[16px] leading-relaxed text-ink [text-wrap:pretty]">
              <p>
                I ended that note saying the second law of thermodynamics ensures time itself will serve
                this mission. It does not. Here is what I meant — it needs one idea first.
              </p>

              <h3 className="pt-4 text-[19px] font-bold text-ink">Entropy, in plain words</h3>
              <p>
                Shuffle a deck and you get a mess — not because the universe prefers messes, but because
                a couple of dozen arrangements run suit by suit, ace to king, and about eight followed by
                sixty-seven zeros do not. “A mess” is not one outcome. It is very nearly all of them.
              </p>
              <p>
                Entropy starts from that count: how many ways a situation could be arranged and still
                look, from outside, like the same situation. A tidy room has one; a lived-in room has
                billions.
              </p>
              <p>
                Then it takes the logarithm — roughly, how many digits the count has. That sets the floor
                everything below depends on: one way left scores zero.
              </p>
            </div>

            <div className="my-6 max-w-[68ch] overflow-x-auto text-ink" dir="ltr" data-ay-skip="1">{EQ_BOLTZMANN}</div>

            <div className="max-w-[68ch] space-y-5 text-[16px] leading-relaxed text-ink [text-wrap:pretty]">
              <p>
                Boltzmann arrived at this in the 1870s; the form above is Planck's. Entropy is not decay
                or waste — that is only what high-count situations look like from where we stand. And once
                entropy is a count, you can count anything: a field of forty crops survives more kinds of
                year than a field of one.
              </p>

              <h3 className="pt-4 text-[19px] font-bold text-ink">What I am counting</h3>
              <p>
                Every entropy counts things somebody decided to treat as the same, so here is what mine
                counts: how many distinguishable ways Earth's story could still go from a given moment,
                weighted by how likely each is. Not the positions of the planet's molecules. The
                branchings its story still has.
              </p>
              <p>
                A hot uniform gas has colossal entropy in the molecular sense and exactly one future: it
                stays a hot uniform gas.
              </p>
              <p>
                Freedom is a count somebody values; entropy is just the count. A person with savings,
                three languages and a passport has an enormous number of next years available. The same
                person, ill and under curfew, has very few. Almost nothing about their atoms changed.
              </p>

              <h3 className="pt-4 text-[19px] font-bold text-ink">The equation</h3>
            </div>

            <div className="my-6 max-w-[68ch] overflow-x-auto text-ink" dir="ltr" data-ay-skip="1">{EQ_OBJECTIVE}</div>

            <div className="max-w-[68ch] space-y-5 text-[16px] leading-relaxed text-ink [text-wrap:pretty]">
              <p>
                Read aloud: count how many ways Earth's story could still go at each moment from now to
                forever, and add it up. <strong className="font-semibold">a</strong> is a course of
                action; <strong className="font-semibold">S</strong> with the Earth symbol is the count
                at one moment. No discount, no horizon at which the people alive then stop mattering.
              </p>
              <p>
                Notice there is no “maximise” on that line, and there cannot be: while Earth keeps some
                futures open the total grows without limit, so no biggest value exists to pick. The
                working form is therefore a comparison, not a score:
              </p>
            </div>

            <div className="my-6 max-w-[68ch] overflow-x-auto text-ink" dir="ltr" data-ay-skip="1">{EQ_COMPARE}</div>

            <div className="max-w-[68ch] space-y-5 text-[16px] leading-relaxed text-ink [text-wrap:pretty]">
              <p>
                Two infinities compare nothing. Two futures compare fine. You never need the value —
                only which of two things you could do leaves more open.
              </p>
              <p>
                The Earth is the honest scope of what is being valued, not of anything I control. I
                decide how one website behaves, and this is what I decide it by. That does not make those
                decisions important. It makes them checkable.
              </p>
            </div>

            <IntegralFigure />

            <h3 className="mt-14 text-[19px] font-bold text-ink">What the equation rules out</h3>
            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              {OBJECTIONS.map((o) => (
                <div key={o.q} className="rounded-card border border-line bg-space-2 p-5">
                  <p className="text-[15px] font-bold leading-snug text-ink">“{o.q}”</p>
                  <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2">{o.a}</p>
                </div>
              ))}
            </div>

            <div className="mt-14 max-w-[68ch] space-y-5 text-[16px] leading-relaxed text-ink [text-wrap:pretty]">
              <h3 className="text-[19px] font-bold text-ink">Where the machine comes in</h3>
              <p>
                I wrote above that an AI is trained to minimise entropy. That is not how these models are
                trained, and I would rather correct it here than quietly edit the note. A language model
                is trained to <em>match</em> the spread of chances in its training text, never to shrink
                it.
              </p>
              <p>
                The narrowing comes afterwards, and every step of it is a decision, not a law. Decoding
                takes the likeliest next word and cuts off the tail. Preference tuning measurably reduces
                the diversity of what comes out. The interface shows one answer, with no visible
                alternatives, to hundreds of millions at once. Each step is defensible alone; together
                they narrow exactly the quantity above.
              </p>
              <p>
                Not an argument against these systems — I run this place with a team of AI agents — but
                about which side of the integral a tool sits on. Hand someone the median answer and the
                count falls. Hand them a runnable notebook, its inputs, and everything they need to
                disagree with you, and it rises.
              </p>
            </div>

            <h3 className="mt-14 text-[19px] font-bold text-ink">What follows from it here</h3>
            <p className="mt-3 max-w-[68ch] text-[16px] leading-relaxed text-ink">
              An equation earns its place by forbidding things. Three of these are not derived at all,
              and one cuts against me. I have said which.
            </p>
            <dl className="mt-6 max-w-[72ch] space-y-5">
              {RULES.map((r) => (
                <div key={r.rule} className="border-s-2 border-s-line ps-5">
                  <dt className="text-[15.5px] font-bold text-ink">{r.rule}</dt>
                  <dd className="mt-1.5 text-[15px] leading-relaxed text-ink-2">{r.body}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-8 max-w-[68ch] text-[16px] leading-relaxed text-ink">
              None of that follows from thermodynamics. It follows from a decision about what is worth
              wanting, made precise enough to argue with and to catch me getting wrong. That argument is
              the point.
            </p>
          </section>
        </div>
      </div>

      {/* Closing band. ONE ask: a reader who reached the bottom of an About page can reach the feed
          from every other surface. */}
      <section className="rounded-card border border-line bg-gradient-to-br from-space-2 to-space-3 px-6 py-12 text-center sm:px-12">
        <h2 className="mx-auto max-w-2xl text-[clamp(1.4rem,3vw,1.9rem)] font-bold leading-snug">We do not need to keep you happy — we need to keep you thinking</h2>
        <div className="mt-7 flex flex-col items-center gap-4">
          <Button href="/donate/" size="xl">Support the mission</Button>
          <a href={localePath("/faq-contact/")} className="text-[14px] font-semibold text-ink-2 hover:text-yin-light hover:underline">
            FAQ &amp; contact
          </a>
        </div>
      </section>
    </div>
  );
}
