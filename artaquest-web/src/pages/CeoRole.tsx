/**
 * The CEO posting (operator, 2026-07-30; copy edited by the author 2026-07-31).
 *
 * The VOICE is Arash's and stays his — a founder's posting is a voice sample, and rewriting it into
 * house style would remove exactly the signal a candidate is reading it for. The original was kept
 * character-for-character until the author asked for the redundancy out ("remove the Straight up as
 * it's redundant"). What that licensed, and nothing beyond it:
 *   • "Straight up" deleted — "Brutally honest and forthcoming" one line above already says it.
 *   • "Pay" rewritten. It read "Willing to Participate in competitions, its the only way to make
 *     money", which buries the single most decision-relevant fact in the posting (there is no
 *     salary) inside a sentence a candidate has to parse twice. It now says so first.
 *   • "competitions" → "challenges" throughout. The nav item is "Challenge" and the page is
 *     /challenges; a candidate reading "competitions" here and finding no such thing in the product
 *     is being asked to translate. "Competition" is also the RETIRED course-era noun.
 *   • Grammar only otherwise: "everyday" → "every day", a missing article, one duplicated
 *     "prize pool".
 *
 * THE ISTANBUL REQUIREMENT IS GONE (operator, 2026-07-31: "we can cooperate anywhere in the globe, a
 * truly global company"). "Hours" used to read "Flexible, apart from one in-person meeting a week in
 * Istanbul", which quietly restricted the role to one city. Dropping it would have left the posting
 * silent on location — the first thing anyone looks for — so it is now stated positively in two
 * places: a "Where" term, and the hero eyebrow. The same requirement was ALSO baked into the
 * crawler/no-JS description in aq-app.php's 'ceo' entry, which is fixed alongside it; that copy is
 * what a search engine shows, so leaving it would have kept advertising a city we no longer require.
 *
 * **Applying is one click, not an instruction.** The posting says "Sign up at artaquest.com and
 * message me there with your CV", and the platform can already do that: ArtaChat is end-to-end
 * encrypted with per-attachment keys, and `/messages/?with=<slug>` is its deep link. So a signed-in
 * visitor lands straight in a conversation with Arash and attaches the file there; a signed-out one
 * goes to sign-in with that same destination as the redirect, so they arrive where they were going
 * rather than on the home page. Nobody is asked to find the ArtaChat tab and search for a person.
 *
 * Why a DM and not an upload form: a CV is personal data, and this platform publishes its ENTIRE
 * database. A file posted through any ordinary surface would be public. The chat is the one place
 * on ArtaQuest where bytes are sealed to the two devices in the conversation — so it is not merely
 * a convenient route for the CV, it is the only correct one.
 *
 * **Where the ask lives (2026-07-31).** The page had ONE action and printed it three times: once
 * under the job paragraph, once at the foot of "To apply", and once in a stray module-scope JSX
 * fragment left above the imports by an earlier edit (valid JS, so it built — it just constructed
 * an element on import and threw it away). A repeated CTA is not three chances to apply, it is one
 * ask the reader has to re-parse. It now lives in the shared right rail (<WithRail>), where it
 * stays on screen for the whole posting instead of waiting at the bottom, and <RailInline> puts the
 * same card back in the flow below `lg` where the rail leaves it. ApplyCard is defined ONCE and
 * rendered in both, so the two copies cannot drift.
 */
import { useEffect, type ReactNode } from "react";
import { Button, Card, PageHero } from "../components/ui";
import { RailInline, WithRail } from "../components/PageRail";
import { isLoggedIn, localePath } from "../lib/wp";

/**
 * WHAT WAS ADDED 2026-07-31, and why the posting itself still reads verbatim.
 *
 * The posting answered "what is the job" and "who is asking" and never once answered "what is this
 * place" — a candidate weighing a not-for-profit CEO role with no salary needs to be able to go and
 * LOOK at the thing before they can take the offer seriously, and every one of those surfaces is
 * public. <WhatYoudRun> is four links to them, not four more claims. It is the only content added;
 * YOU and TERMS are still Arash's words, character for character.
 */

/** Arash's member slug — the other end of the conversation. */
const CTO_SLUG = "arash";
const APPLY_PATH = `/messages/?with=${CTO_SLUG}`;

/** Signed in → straight into the conversation. Signed out → sign in, then the conversation. */
function applyHref(): string {
  return isLoggedIn()
    ? localePath(APPLY_PATH)
    : `${localePath("/login/")}?redirect=${encodeURIComponent(APPLY_PATH)}`;
}

const YOU: string[] = [
  "Recent grad with a fresh outlook on the social media landscape",
  "Studied Arts, Communication or Architecture",
  "Curious, optimistic and adventurous",
  "Brutally honest and forthcoming",
];

/** Corporations Canada's record for the federal not-for-profit — the same destination the footer's
 *  "registered" links to, so the one claim a candidate is most likely to check has one canonical
 *  source on every surface that makes it. */
const REGISTRY_URL = "https://ised-isde.canada.ca/cc/lgcy/fdrlCrpDtls.html?corpId=17948328";

const TERMS: { term: string; detail: ReactNode }[] = [
  { term: "Pay", detail: "No salary. You enter the challenges like everyone else — it's the only way money is made here" },
  { term: "Where", detail: "Anywhere in the world. Fully remote — no office, no relocation, no required city" },
  {
    term: "The org",
    // "you can look it up online" told the reader to go and find it; the link IS the looking up.
    // Styled exactly as the footer's, because it is the same word pointing at the same record.
    detail: (
      <>
        <a
          href={REGISTRY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 transition-colors hover:text-yang"
        >
          Registered
        </a>{" "}
        Canadian not-for-profit<span className="sr-only"> (opens the Corporations Canada record in a new tab)</span>
      </>
    ),
  },
  { term: "Hours", detail: "Flexible. We meet online, across whatever time zones we are in" },
  { term: "The team", detail: "Small. It's just me now, but you can grow your own" },
];

function ApplyButtons() {
  return (
    // Full-width on the smallest screens: two half-width pills at 320px leave ~130px each, which
    // truncates the label and gives a poor target.
    <div className="flex flex-wrap items-center gap-3 max-sm:flex-col max-sm:items-stretch">
      <Button href={applyHref()} size="md" className="max-sm:w-full">
        {isLoggedIn() ? "Message Arash with your CV" : "Sign up and message me your CV"}
      </Button>
      {/* Straight to #founder on the About page — not the /u/ profile, and not the top of /about
          either. Someone weighing up this job wants the person and the story, which is that
          section; landing at the top would make them scroll past the mission statement first. */}
      {/* `outline`, not `ghost`: in the 320px rail this sits under the primary with nothing beside it,
          and a borderless ghost there reads as a caption rather than a second action. */}
      <Button href={`${localePath("/about/")}#founder`} variant="outline" size="md" className="max-sm:w-full">
        See who you'd work with
      </Button>
    </div>
  );
}

/** The four public surfaces a candidate can check before deciding. Links, not claims — this posting
 *  asks someone to run an organisation, and the organisation is entirely inspectable. */
const LOOK: { label: string; body: string; href: string; cta: string }[] = [
  { label: "The product", body: "Every post, and the checklist that let it through.", href: "/works/", cta: "Open the feed" },
  { label: "The argument", body: "Why it is built this way — one equation, and the rules that follow.", href: "/about/#philosophy", cta: "Read the philosophy" },
  { label: "The books", body: "The gold reserve and every coin, donation and payout, live.", href: "/reserve/", cta: "See the reserve" },
  { label: "The machinery", body: "The whole backend API, generated from the routing table itself.", href: "/developers/", cta: "Read the API docs" },
];

function WhatYoudRun() {
  return (
    <section className="max-w-3xl">
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">What you'd be running</h2>
      <p className="mt-3 text-[16px] leading-relaxed text-ink">
        A not-for-profit social media for science and education. None of it has to be taken on trust —
        it is all public, no account needed. Go and look first.
      </p>
      <ul role="list" className="mt-6 grid gap-4 sm:grid-cols-2">
        {LOOK.map((l) => (
          <li key={l.label} className="rounded-card border border-line bg-space-2 p-5">
            <p className="text-[12.5px] font-semibold uppercase tracking-[0.16em] text-ink-2">{l.label}</p>
            <p className="mt-1.5 text-[14.5px] leading-relaxed text-ink">{l.body}</p>
            <p className="mt-3 text-[14px] font-semibold">
              <a href={localePath(l.href)} className="text-yang hover:underline">{l.cta} <span aria-hidden>→</span></a>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The page's one action, and the reason it is a DM. Rendered in the rail AND — below `lg`, where
 *  the rail is out of the flow — inline; one definition, so the two can never disagree. */
function ApplyCard() {
  return (
    <section className="flex flex-col gap-2 rounded-card border border-line bg-space-2 p-4">
      <h2 className="text-sm font-bold uppercase tracking-wider text-ink-3">To apply</h2>
      <p className="text-[15px] leading-relaxed text-ink">
        Sign up at artaquest.com and message me there with your CV.
      </p>
      <p className="text-[14px] leading-relaxed text-ink-2">
        The button below does both. It opens a private conversation with me and you attach the
        CV to it — the paperclip in the composer takes a PDF or a document.
      </p>
      <p className="text-[14px] leading-relaxed text-ink-2">
        Chat is end-to-end encrypted, so your CV is sealed to your device and mine.
        That matters more than usual on this platform: every other table is public on purpose,
        and the chat is the one place your file is not.
      </p>
      <div className="mt-2"><ApplyButtons /></div>
    </section>
  );
}

export default function CeoRole() {
  useEffect(() => {
    document.title = "CEO — ArtaQuest";
  }, []);

  return (
    <div className="flex flex-col gap-10 pb-12 sm:gap-12">
      <PageHero
        // "Remote, worldwide" rides the eyebrow rather than the lede: location is the first thing a
        // candidate looks for on any posting, and the lede is the founder's own sentence.
        eyebrow="Open role · Remote, worldwide"
        title="CEO"
        lede="I'm Arash, the CTO. I built the platform: a not-for-profit social media to make people smarter every day"
      />

      <WithRail label="How to apply" rail={<ApplyCard />}>
        <div className="flex flex-col gap-10 sm:gap-12">
          {/* The job. It was followed by the first of three copies of the ask; the ask is now in
              the rail, on screen for as long as this paragraph is. */}
          <section className="max-w-3xl">
            <p className="text-[19px] leading-relaxed text-ink sm:text-[20px]">
              Your job — run creative and educational challenges with a prize pool. I build the tools you
              suggest and set the rules that keep it fair. Every entry grows the pool, and the winner
              takes all.
            </p>
          </section>

          <WhatYoudRun />

          <section className="grid gap-6 lg:grid-cols-2">
            <Card className="p-6">
              <h2 className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">You</h2>
              {/* text-ink, not ink-2: this is the substance of the posting, and lib/contrast.ts binds
                  ink-2 to secondary/incidental copy. */}
              <ul role="list" className="mt-4 flex list-none flex-col gap-3 p-0">
                {YOU.map((line) => (
                  <li key={line} className="flex gap-3 text-[16px] leading-relaxed text-ink">
                    <span aria-hidden className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-yang" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </Card>

            <Card className="p-6">
              <h2 className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">The deal</h2>
              {/* The term label is the scan key a candidate reads first — Pay and Hours are the two
                  facts that decide whether the rest of the page is worth reading — so it sits on the
                  primary ink, not the incidental tier it shared with the surrounding furniture. */}
              <dl className="mt-4 flex flex-col gap-4">
                {TERMS.map((t) => (
                  <div key={t.term}>
                    <dt className="text-[13px] font-semibold uppercase tracking-wide text-ink">{t.term}</dt>
                    <dd className="mt-1 text-[16px] leading-relaxed text-ink-2">{t.detail}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </section>
        </div>
      </WithRail>

      {/* Below lg the rail leaves the flow, so the ask rides here — the same card, at the point in
          the posting where it used to sit. */}
      <RailInline><ApplyCard /></RailInline>
    </div>
  );
}
