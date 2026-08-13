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
    body: "I was born in Tehran on 15 February 1994. I have two sisters, and we were raised by a single mom who taught French and English. I loved physics most of all, and as a teenager I competed in Iran's national olympiads. I have lived most of my life abroad — across Malaysia, Turkey and Canada. I started teaching very young, and I learned that teaching something is the best way to understand it deeply.",
  },
  {
    label: "The climb",
    body: "I had one goal — to figure out how the universe works, and why — and I followed it upward. From gases to galaxies, then to circuits and information systems, then to machine intelligence, and finally to biological intelligence: the universe's masterpiece, the matter with the most degrees of freedom, the most conscious entropy. That climb led me to artificial intelligence, and I moved to Montréal to study it for a PhD.",
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
    body: "ArtaQuest grew from that: take the best free knowledge the world has already produced — on whatever people most need to learn — and give it an honest, focused home, free of propaganda, where anyone can learn it and think for themselves. I run it alone, on purpose: no employer, no funder, no organisation telling me what to teach. That keeps it honest, and keeps it on the mission I have set for my own life — to widen what every being is free to think, choose and become, for as many as possible, across time and space. And the second law of thermodynamics ensures that time itself will serve this mission. So our success is only a matter of time…",
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

/** The objections, answered. Four: the two that would defeat the argument if left unanswered (heat death,
 *  and the move from what is to what ought to be) plus the two an honest reader actually raises. */
const OBJECTIONS: { q: string; a: string }[] = [
  {
    q: "Making entropy as large as possible means heat death, so this is an argument for destroying the planet",
    a: "Heat death is the largest value of one count and the smallest value of mine. The molecule count is as large as it can ever be. The story has exactly one way left to continue: nothing more happens, ever. One way left reads as zero on the scale above, so from that moment my quantity is zero. A burnt Earth is not quite that, but it adds almost nothing from that moment onward and goes on adding almost nothing, while the total keeps adding moments with no end.",
  },
  {
    q: "Entropy rises by itself under the second law, so none of this needs doing",
    a: "The second law says entropy never falls inside a sealed box — nothing in, nothing out, not even heat. It holds for Earth too. It just does not decide anything here, because Earth is not that box: about 120,000 terawatts of sunlight are soaked up here — a terawatt being a trillion joules every second — roughly a kilowatt on each sunny square metre, across a disc the width of the planet, less the near-third that cloud, snow and sea bounce straight back — and every watt of it came from outside. Entropy here is free to fall while the Sun's rises by far more. And the law only tells you which direction one quantity moves. It does not tell you which future you end up in. Losing a species obeys the second law. Saving one obeys it just as well.",
  },
  {
    q: "Then burn everything, because a fire raises entropy fastest",
    a: "A fire does raise the molecule count fast. It also destroys futures fast, and futures are what this counts. That is why the sum has no end date. If you only add up to some date you pick, you can win by using up everything you have the day before it — and that is true of every date, which is why I name none. If you add up all of time, the only way to win is to keep alive the thing that makes new futures. Wipe that out and every later moment is zero. Wipe out anything smaller and you take a slice out of every later moment instead — and the moments do not stop coming. Either way, no short burst is big enough to make it back.",
  },
  {
    q: "Physics can describe the world. It cannot tell you what to want",
    a: "True. This is not a discovery. It is something I want, written down clearly enough to argue with. You can point at something I do, show me evidence that it leaves people with fewer ways to go, and then I have to answer you. It is not a full set of ethics. It is one low line: a person can have many choices and still be unhappy. All it says is, do not be the one who takes other people's choices away.",
  },
];

/** The rules the platform actually runs on, one line each. The three that are NOT derived from the
 *  equation stay marked as such: a list that quietly claimed them would be exactly the after-the-fact
 *  excuse-making this section exists to avoid. */
const RULES: { rule: string; body: string }[] = [
  {
    rule: "The checklist never gives a score",
    body: "It reports facts, and for each fact it shows the evidence it read. No number, no grade, no ranking. It refuses a notebook for three kinds of reason, and no others: something that makes the run impossible for a stranger to repeat; our own limits on what we can store and serve — at most 24 files, 512 MB each, 1 GB in total, in a format we can render; and a drawing we cannot rebuild without script, because an SVG is the one thing published here that a reader's browser executes. Everything else is shown as a warning and lets the work through. Members do rank published work between themselves. They give hearts, and a challenge pays its whole prize to the entry with the most hearts. Hearts decide prizes. Hearts never decide what gets published.",
  },
  {
    rule: "Every input must be public",
    body: "If a notebook uses private data, almost nobody else can run it again, so almost nobody can check it.",
  },
  {
    rule: "The whole database is public — and this rule argues with itself",
    body: "Every table and every row, live. The only things held back are a member's own credentials — sign-in sessions and codes, password-reset keys, API token hashes and a live publication confirm link — plus a member's private book files and a shop delivery address. The site's own keys are never in the database at all; they live in the environment. Publishing what a member does widens what everyone else can see and narrows what that member can still choose. I decided in favour of publishing. This is the decision I would most like someone to talk me out of.",
  },
  {
    rule: "Reading, submitting, checking and publishing are free",
    body: "A price decides who is allowed to take part. The only fee to take part is a challenge entry, and all of that money goes back to the entrants.",
  },
  {
    rule: "No hate, no fear — my choice, not something the equation proves",
    body: "When you post a comment, it is queued and read for language built to make people hate a group, or built to frighten them. A comment over the limit is marked. It is never deleted, and the check never holds up your post.",
  },
  {
    rule: "You can only publish a notebook from a Kaggle account you have proved is yours — again my choice, not the equation",
    body: "From 4 August 2026 you can only submit a notebook from a Kaggle account you have proved you control: we give you a one-time string, you put it in a public notebook under that account, and we read it back from an address on Kaggle that answers anybody, with no login at all — so it is a check a stranger can repeat, not one you have to take my word for. Before that, anyone could submit anyone's public notebook, and a permanent citation could be minted in the name of a person who had never been asked. Three works were published under the old rule, naming two different Kaggle accounts, and nothing can go back and check them: the check did not exist yet, and a published work is never re-examined here. So this rule is about what happens from now on, and I would rather say that than let you assume it covers everything on the site. What the proof shows is that the account is yours, not that you typed every line — I say what I check and no more. Publishing is still a request, never a taking: a one-time link goes to your own registered email address, and your click, together with a signature from your own device, is what publishes the work. No operator, no access key and no AI agent can do it instead. Counting futures on its own would happily publish without asking anyone. Consent is a limit I place on the aim, not something the aim produced.",
  },
  {
    rule: "Hearts, never downvotes — my choice as well",
    body: "Nothing on this site can give a work a minus. The equation did not decide that. I did, because a one-click way to push a stranger's work out of sight makes this a worse place to think.",
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
            Two lines start from the same point. One rises very high, then falls to zero early and stays at zero, so
            the shaded area under it is small. The other does not rise as high, but it stays up across
            the whole picture, so the shaded area under it is much larger. The area keeps adding up with
            no end.
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
            <text x="172" y="41">use it all now — high for a moment, then nothing</text>
            <text x="430" y="96" textAnchor="middle">keep it alive — new ways keep opening</text>
          </g>

          {/* the one thing the figure has to teach */}
          <text x="420" y="222" textAnchor="middle" fontSize="11.5" fill="currentColor" fillOpacity="0.62">
            the shaded area is the running total
          </text>

          {/* axis labels */}
          <g fontSize="11" fill="currentColor" fillOpacity="0.66">
            <text x="110" y="304" textAnchor="middle">now</text>
            <text x="668" y="304" textAnchor="end">time, without end</text>
            <text x="26" y="155" textAnchor="middle" fontSize="11.5" transform="rotate(-90 26 155)">
              how much room the story still has
            </text>
          </g>
        </svg>
      </div>
      <figcaption className="mx-auto mt-3 max-w-[60ch] text-center text-[12.5px] leading-relaxed text-ink-2">
        Both obey the second law. Only one of them keeps the total growing — a line that reaches the floor has one way left, and one way counts as zero
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
            </Card>
          </section>

          {/* ── THE PHILOSOPHY ── Unboxed prose on the page canvas: this is the one section people are
              meant to read rather than scan. */}
          <section ref={mathRef}>
            <H2 id="philosophy">I want to widen what is still possible</H2>
            <p className="mt-3 text-[13px] text-ink-2">Arash Ashrafnejad · the long version of the last paragraph above</p>

            <div className="mt-8 max-w-[68ch] space-y-5 text-[16px] leading-relaxed text-ink [text-wrap:pretty]">
              <p>
                At the end of that note I said the second law of thermodynamics makes sure that time itself will serve
                this mission. The second law is the rule that says entropy never falls: left alone it climbs, and once it has nowhere left to climb it stays there. It does not
                make sure of anything like that. Here is what I actually meant. It takes one idea to
                explain, so let me start there.
              </p>

              <h3 className="pt-4 text-[19px] font-bold text-ink">Entropy, in plain words</h3>
              <p>
                Shuffle a pack of cards and you get a mess. That is not because the universe prefers messes. It is only
                counting. Call an order tidy when each suit is kept together and runs ace to king. Then
                the only thing left to choose is which suit comes first, second, third and fourth:
                4 × 3 × 2 × 1, which is twenty-four tidy orders. Now count every order the pack can be
                in: fifty-two cards to choose for the top, fifty-one left for the next, and so on down.
                That is 52 × 51 × 50 × … × 1, about eight followed by sixty-seven zeros. So “a mess” is
                not one result. It is very nearly all of the results.
              </p>
              <p>
                Entropy begins with that count. Take any situation and ask one question: how many ways could it be
                arranged and still look the same to someone watching from outside? A room where every
                single thing has exactly one place it belongs has one. A room that people actually live
                in has more than that shuffled pack, and by a long way.
              </p>
              <p>
                Then it does one more thing, and it is the one step worth slowing down for. It does not use that count
                itself. It uses the length of the count: the zeros you write after the first digit.
                Eight followed by sixty-seven zeros becomes sixty-seven. Why the length
                rather than the count? Because counts multiply and lengths add. Take a one followed by sixty-seven zeros, and another. Multiplied, they give a one followed by a hundred and thirty-four zeros: the counts multiplied, and the lengths simply added. Two things together should
                be worth the one plus the other, the way their weights are. And notice where the bottom
                of that scale sits. One arrangement is written 1. There are no zeros after it, so the
                value is zero. Everything I say below rests on that zero.
              </p>
            </div>

            <div className="my-6 max-w-[68ch] overflow-x-auto text-ink" dir="ltr" data-ay-skip="1">{EQ_BOLTZMANN}</div>

            <div className="max-w-[68ch] space-y-5 text-[16px] leading-relaxed text-ink [text-wrap:pretty]">
              <p>
                W is the count of arrangements, log is the operation just described — it turns that count into its
                length — and the k in front is a fixed conversion number that puts the answer into the
                units physicists measure heat in. It never changes, so it can never change which of two
                things is larger. (Physicists take the length to a different base than ten. That moves
                the units too, and nothing else.) Boltzmann worked this out in the 1870s. The way it is
                written above is Planck's. Entropy is not decay, and it is not waste. Decay is simply
                what a high count looks like to us. And once you have the shape of it — count the ways,
                take the length, one way left reads zero — you can lay that shape over other lists. That
                part is no longer physics and I will not dress it up as physics; I will just say plainly
                what I am counting. A field with forty kinds of crop lives through more kinds of bad
                year than a field with one kind: same shape, different list.
              </p>

              <h3 className="pt-4 text-[19px] font-bold text-ink">What I am counting</h3>
              <p>
                Every count like this depends on what someone decided to treat as the same thing. So here is what I
                count. From any moment, how many ways could the story of Earth still go — ways we could
                actually tell apart, counting a barely possible one for almost nothing and a real
                possibility in full? I am not counting where the planet's molecules sit. I am counting
                the choices the story still has ahead of it.
              </p>
              <p>
                A sealed box of hot, evenly mixed gas has an enormous count if you count molecules. Count the futures
                you could tell apart from outside and it has one: it goes on being a box of hot, evenly
                mixed gas. That is everything it will ever do.
              </p>
              <p>
                Entropy is only the count. It asks for nothing; nothing in physics asks for anything. The wanting is
                mine: I look at that count and I want it to be large, for one person and for the whole
                planet. That step is not in the physics, and I answer for it below. Take it with me and
                freedom and this count are the same thing. Think of a
                person with savings, three languages and a passport. The number of different next years
                open to them is huge. Now take the same person, ill and not allowed to leave their home.
                The number is tiny. Almost nothing about their atoms changed.
              </p>

              <h3 className="pt-4 text-[19px] font-bold text-ink">The equation</h3>
            </div>

            <div className="my-6 max-w-[68ch] overflow-x-auto text-ink" dir="ltr" data-ay-skip="1">{EQ_OBJECTIVE}</div>

            <div className="max-w-[68ch] space-y-5 text-[16px] leading-relaxed text-ink [text-wrap:pretty]">
              <p>
                In words: at every moment from now on, count the ways Earth's story could still go, take that count's
                length — the zeros, as above — and add those lengths up, moment after moment, with no
                end. The tall stretched S is that adding-up; the t-nought under it is
                now; the sideways eight above it means the adding never stops. <strong
                className="font-semibold">a</strong> is something a person could do. <strong
                className="font-semibold">S</strong> with the Earth symbol is that length at one moment.
                The length is why a dead Earth adds nothing: one way left is not a small
                amount to add up, it is nothing at all. A moment far in the future
                counts exactly as much as this one, and there is no date after which the people
                alive stop mattering — and whatever date I chose instead, the way to win would be to
                spend everything the day before it.
              </p>
              <p>
                Notice that the line never says “make this as large as possible”. It cannot. As long as Earth keeps some
                futures open, the total keeps growing and never stops, so there is no largest value to
                aim at. What you can do instead is compare two futures:
              </p>
            </div>

            <div className="my-6 max-w-[68ch] overflow-x-auto text-ink" dir="ltr" data-ay-skip="1">{EQ_COMPARE}</div>

            <div className="max-w-[68ch] space-y-5 text-[16px] leading-relaxed text-ink [text-wrap:pretty]">
              <p>
                Read that line as: of the two, a is the one to choose. The order of the work is what makes it possible —
                do not add up two endless totals and then subtract them, because endless minus endless
                is not a number. Subtract first. At every moment ask how much more the
                one leaves open than the other, keep a running total of that difference,
                and let it run as long as you like. Comparing two totals that never stop
                growing tells you nothing. Comparing the gap between them works whenever
                that gap settles on one side and stays there. It does not always settle,
                and when it does not, this rule has no answer to give and I would rather say so
                than pretend it does. In the case that matters most it settles very plainly: a future
                that ends adds nothing for the rest of time, so the gap only widens. You never need the
                number itself. You only need to know which of the two things you could do leaves more
                open.
              </p>
              <p>
                Earth is the honest size of what I say I care about. It is not the size of anything I control. What I
                control is how one website behaves, and this is the rule I decide it by. That does not
                make those decisions important. It makes them possible to check.
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
              <h3 className="text-[19px] font-bold text-ink">Where AI comes in</h3>
              <p>
                Above, I said that an AI is trained to minimise entropy. That is not how these models are trained. I
                would rather correct it here than quietly change the note. A language model is trained
                to <em>match</em> how likely each possibility is in its training text, not to narrow that down.
              </p>
              <p>
                The narrowing happens later, and every step of it is a choice somebody made, not a law of nature. First,
                when the model writes, it keeps the most likely words and drops the rest. Then the
                tuning that teaches it what people prefer measurably reduces how varied its answers are.
                Then the screen shows one answer, with no other options in sight, to hundreds of
                millions of people at the same time. Each step makes sense on its own. Together they
                narrow exactly the count above.
              </p>
              <p>
                This is not an argument against AI. I run this site with a team of AI agents. It is an argument about
                what a tool does to the count. Give someone one average answer and the count goes down.
                Give them a notebook they can run, the data it used, and everything they need to
                disagree with you, and the count goes up.
              </p>
            </div>

            <h3 className="mt-14 text-[19px] font-bold text-ink">What this means for the site</h3>
            <p className="mt-3 max-w-[68ch] text-[16px] leading-relaxed text-ink">
              An idea is only worth having if it rules some things out. Three of the rules below do not come from the
              equation at all, and one of the rules works against me. I have marked which.
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
              None of that comes from physics. It comes from a decision about what is worth wanting, written down
              clearly enough that you can argue with it and catch me when I get it wrong. That argument
              is the point.
            </p>
          </section>
        </div>
      </div>

      {/* Closing band. ONE ask: a reader who reached the bottom of an About page can reach the feed
          from every other surface. */}
      <section className="rounded-card border border-line bg-gradient-to-br from-space-2 to-space-3 px-6 py-12 text-center sm:px-12">
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
