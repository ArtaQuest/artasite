import { useEffect, useState } from "react";
import { getCreatorLadder, getCreatorStatus, isLoggedIn, localePath, type CreatorTier, type CreatorStatus } from "../lib/wp";
import { Points, formatPoints } from "../lib/currency";
import { Button, Card, OrbitRings } from "../components/ui";

// What we welcome — questioning is the whole point, so the door is wide. The only thing we
// ask in return is honest labelling: a theory presented as a theory, a belief as a belief.
const WELCOME = [
  "Questionable theories and ideas with limited evidence — conspiracies, fringe science, contested and revisionist history, the speculative and the unorthodox.",
  "Strong, unpopular, or uncomfortable arguments — as long as they are offered to be examined, not to recruit.",
  "Faith, philosophy, and the unprovable — presented honestly as belief or interpretation, never dressed up as settled fact.",
];

// The single line we draw — content that shuts questioning down instead of opening it up.
// This is the one filter, and ArtaMod applies it automatically and objectively.
const LINE = [
  "Hate speech — content that dehumanises or targets people for who they are.",
  "Fear-mongering — content whose pull is panic, threat, and doom rather than understanding.",
  "Coercion and propaganda — material built to force a belief on you, including covert advertising and pure partisan recruitment.",
];

// (The "submit a playlist" form that used to live here is gone. Courses from YouTube playlists went
// with the rest of the legacy platform, purged 2026-07-13, and POST /creator/submit-playlist now
// answers 410 — so the form rendered for every can_create member and handed each one an error. A
// submission is a public Kaggle notebook now, and the Studio is where it is pasted.)

// Live standing on the ladder — sourced from the creator-status BFF. Tier is set by TOTAL
// lifetime points (learn + donate + volunteer + grant-winner), shown with the per-track breakdown and
// progress to the next rung; can_create is what opens the Studio. The coin wallet is separate.
function ProgressPanel() {
  const loggedIn = isLoggedIn();
  const [s, setS] = useState<CreatorStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { if (loggedIn) getCreatorStatus().then(setS).finally(() => setLoaded(true)); }, [loggedIn]);

  if (!loggedIn) {
    return (
      <Card className="flex flex-col items-start gap-3 p-6">
        <h3 className="text-[16px] font-bold">See how close you are</h3>
        <p className="text-[14px] leading-relaxed text-ink-2">Sign in to track your points up the ladder.</p>
        <Button href="/login/" size="md">Sign in</Button>
      </Card>
    );
  }
  if (!loaded) return <Card className="p-6 text-[14px] text-ink-3">Loading your progress…</Card>;
  if (!s) return <Card className="flex flex-col items-start gap-3 p-6 text-[14px] text-ink-2">Your session has expired. <Button href="/login/" size="md">Sign in again</Button></Card>;

  const atTop = !s.next_tier || s.next_at <= 0;
  const pct = atTop ? 100 : Math.min(100, Math.max(3, Math.round((s.points / s.next_at) * 100)));
  const remaining = Math.max(0, s.next_at - s.points);
  const bd = s.breakdown || { learn: 0, donate: 0, volunteer: 0, outreach: 0, total: s.points };
  return (
    <div className="flex flex-col gap-4">
      <Card className="p-6">
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-2 text-[16px] font-bold text-yang"><Points n={s.points} withLabel /></span>
          {/* The API still returns `share` — the retired courses economy's cut of an enrolment's
              revenue. Nothing pays it out any more, so it is no longer shown anywhere on this page. */}
          <span className="text-[13px] text-ink-3">{s.tier}{!atTop && s.next_tier ? ` · next: ${s.next_tier}` : ""}</span>
        </div>
        <p className="mt-2 text-[12.5px] text-ink-3">Learner {bd.learn.toLocaleString()} · Donor {bd.donate.toLocaleString()} · Volunteer {bd.volunteer.toLocaleString()} · Grant-winner {bd.outreach.toLocaleString()}</p>
        {!atTop && (
          <div className="mt-3 h-2 w-full overflow-hidden rounded-pill bg-veil/[0.08]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-pill bg-gradient-to-r from-yang to-yin-light" style={{ width: `${pct}%` }} />
          </div>
        )}
        <p className="mt-3 text-[14px] leading-relaxed text-ink-2">
          {atTop
            ? "You’re at the top rung — the Studio is fully open, and your shelf has no limit."
            : <>Earn <span className="font-semibold text-ink">{formatPoints(remaining)}</span> more to reach <span className="font-semibold text-ink">{s.next_tier}</span> and what it opens up. Any track counts — learn, donate, volunteer, or win sponsors.</>}
        </p>
        <Button href="/" variant="subtle" size="md" className="mt-4">Go to your dashboard</Button>
      </Card>
      {s.caps.can_create && (
        <Card className="flex flex-col items-start gap-3 p-5">
          <h3 className="text-[16px] font-bold">The Studio is open to you</h3>
          <p className="text-[13px] leading-relaxed text-ink-2">Your rung unlocks the Studio: author a grant application, or propose a sitewide topic. Submitting a Kaggle notebook is open to every member, and starts there too.</p>
          <Button href="/studio/" size="md">Open the Studio</Button>
        </Card>
      )}
    </div>
  );
}

// The ArtaMod scale, drawn calmly and on-brand: the whole gold→blue spectrum of honest
// thought is open to question; only the high-fear/hate end is blocked. Decorative — the
// meaning lives in the surrounding copy, so the meter itself is aria-hidden.
function FearMeter() {
  return (
    <div aria-hidden className="select-none">
      <div className="flex items-end justify-between text-[12px] font-semibold">
        <span className="text-ink-2">Open · curious · questioning</span>
        <span className="text-rose-300">Hate · fear</span>
      </div>
      <div className="mt-2 flex h-3 overflow-hidden rounded-pill">
        <div className="flex-[72] bg-gradient-to-r from-yin-light to-yang" />
        <div className="w-0.5 bg-space-1" />
        <div className="flex-[28] bg-rose-500/35" />
      </div>
      <div className="mt-2 flex text-[11px] font-semibold uppercase tracking-wide">
        <span className="flex-[72] text-ink-3">Welcome</span>
        <span className="flex-[28] text-right text-rose-300">Blocked</span>
      </div>
    </div>
  );
}

// The full creator ladder (5 tiers) — sourced from the canonical Extra::TIERS via the BFF so it
// never drifts from the dashboard/profile tier data. Each rung's own blurb says what it opens
// (the Studio, then more room on your shelf); the tier's `share` is a retired field, not rendered.
function CreatorLadder() {
  const [tiers, setTiers] = useState<CreatorTier[]>([]);
  useEffect(() => { getCreatorLadder().then(setTiers); }, []);
  if (!tiers.length) return null;
  return (
    <section>
      <p className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">The creator ladder</p>
      <h2 className="mt-3 text-[clamp(1.5rem,3vw,2rem)] font-bold leading-tight">More opens up as you climb</h2>
      <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-2">
        Every member starts at <strong className="font-semibold text-ink">Quester</strong> and rises by earning points — by learning, donating, volunteering, or winning grants. Each rung opens the Studio wider and makes room for more published work on your shelf, until at <strong className="font-semibold text-ink">Legend</strong> there is no limit at all. A rung is standing, never a claim on anyone’s money: challenge pools are won, not shared out by rank.
      </p>
      <ol className="mt-8 flex list-none flex-col gap-3">
        {tiers.map((t, i) => (
          <li key={t.key} className="flex items-center gap-4 rounded-card border border-line bg-space-2 p-4 sm:p-5">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-veil/5 text-[15px] font-bold text-ink-3 tabular-nums">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-[17px] font-bold text-ink">{t.label}</span>
                <span className="text-[15px] font-extrabold tabular-nums text-yang">{(t.points ?? 0) > 0 ? formatPoints(t.points ?? 0) : "from day one"}</span>
              </div>
              <p className="mt-1 text-[14px] leading-relaxed text-ink-2">{t.blurb}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function Careers() {
  return (
    <div className="flex flex-col gap-16 pb-12 sm:gap-20">
      {/* Hero — philosophy first: we help people think, not tell them what to think */}
      <section className="relative overflow-hidden rounded-card border border-line bg-space-2 px-6 py-16 sm:px-12 sm:py-20">
        <div className="pointer-events-none absolute -right-24 -top-28 h-80 w-80 rounded-full bg-yang/10 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-28 -left-24 h-80 w-80 rounded-full bg-yin/15 blur-3xl" aria-hidden />
        <OrbitRings className="absolute -right-20 top-1/2 hidden h-[440px] w-[440px] -translate-y-1/2 text-ink lg:block" />
        <div className="relative max-w-2xl">
          <p className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">Creating on ArtaQuest</p>
          <h1 className="mt-4 text-[clamp(2.1rem,5vw,3.3rem)] font-extrabold leading-[1.1]">
            Help people <span className="aq-grad">think for themselves</span>
          </h1>
          <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-ink-2">
            We want members who bring work with real depth and real honesty — no agenda, no propaganda. Bring the hard questions. Our job is to keep the space safe and free, so anyone can check what they are shown and reach their own conclusions.
          </p>
          <div className="mt-8"><Button href="#how-to-qualify" size="xl">How to qualify</Button></div>
        </div>
      </section>

      {/* Philosophy — the heart of the page: question everything, in a safe and free space */}
      <section id="philosophy" className="scroll-mt-24">
        <div className="max-w-3xl">
          <p className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">What we stand for</p>
          <h2 className="mt-3 text-[clamp(1.7rem,3.5vw,2.4rem)] font-extrabold leading-tight">
            We are here to question, <span className="aq-grad">not to be brainwashed</span>
          </h2>
          <p className="mt-5 text-[16px] leading-relaxed text-ink-2">
            ArtaQuest is a place to question, not a place to be told what to believe. Understanding is never handed to you; you reach it by examining ideas freely — including the strange, the unproven, and the unpopular — and deciding for yourself.
          </p>
          <p className="mt-3 text-[16px] leading-relaxed text-ink-2">
            So the door is wide. We welcome questionable theories and ideas with limited evidence — conspiracies, pseudoscience, contested history, the speculative and the unorthodox. We ask only one thing in return: label them honestly. A theory presented as a theory, a belief as a belief — never disguised as settled fact.
          </p>
        </div>

        <div className="mt-8 grid gap-5 sm:grid-cols-2">
          <Card className="border-t-2 border-t-yin-light p-6 sm:p-7">
            <h3 className="text-[17px] font-bold text-yin-light">What we welcome</h3>
            {/* "Faith, philosophy, and the unprovable" names philosophy as a welcomed CATEGORY of
                content (the academic discipline) — not the retired "physics+philosophy" brand
                framing. Exempt from the brand-vocab lint; the section prose stays linted. */}
            <ul data-aq-vocab-exempt="welcome-categories" className="mt-4 flex list-none flex-col gap-3">
              {WELCOME.map((t) => (
                <li key={t} className="flex gap-3 text-[14.5px] leading-relaxed text-ink-2">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" className="mt-0.5 shrink-0 text-yang" aria-hidden><path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card className="border-t-2 border-t-rose-400/60 p-6 sm:p-7">
            <h3 className="text-[17px] font-bold text-ink">The one line we draw</h3>
            <ul className="mt-4 flex list-none flex-col gap-3">
              {LINE.map((t) => (
                <li key={t} className="flex gap-3 text-[14.5px] leading-relaxed text-ink-2">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" className="mt-0.5 shrink-0 text-rose-300" aria-hidden><path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" /></svg>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <p className="mt-7 max-w-3xl border-l-2 border-l-yang pl-4 text-[16px] leading-relaxed text-ink-2">
          Hate and fear are the only ideas we turn away — not because they are unpopular, but because they are divisive and they hijack the very capacity for critical thinking we exist to protect. We will never coerce you into a belief. Persuasion by evidence is welcome here; manipulation by fear is not.
        </p>
      </section>

      {/* ArtaMod — how the one line is enforced: automatically, objectively, for everyone */}
      <section>
        <div className="grid gap-8 lg:grid-cols-[1.2fr_1fr] lg:items-center">
          <div>
            <p className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">How we keep it fair</p>
            <h2 className="mt-3 text-[clamp(1.7rem,3.5vw,2.4rem)] font-extrabold leading-tight">
              Moderated by <span className="aq-grad">ArtaMod</span>, not by opinion
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-2">
              Drawing that line by hand would mean trusting someone’s politics to decide what you are allowed to question. We do not. Instead, every comment and submitted request is screened automatically by <strong className="font-semibold text-ink">ArtaMod</strong> — our own AI, built to measure one thing: how far a piece of content trades in hate or fear. It reads shortly after you post, never before: nothing is held up, and nothing is ever deleted.
            </p>
            <p className="mt-3 text-[16px] leading-relaxed text-ink-2">
              It does not care who is speaking or which side they are on. It reads only for language meant to dehumanise or to frighten. The same measure is applied to every request, objectively and automatically, so the standard stays identical for everyone — mainstream or fringe, one side or the other. Question everything; just never by attacking people or spreading fear.
            </p>
            <p className="mt-5">
              <a href={localePath("/fearometer/")} className="font-semibold text-yang underline-offset-2 hover:underline">See exactly how ArtaMod works, and the study set behind it →</a>
            </p>
          </div>
          <Card className="p-6 sm:p-7">
            <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">ArtaMod</p>
            <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
              Every submission is scored on one scale. The whole spectrum of honest thought stays open — only hate and fear are filtered out.
            </p>
            <div className="mt-6"><FearMeter /></div>
          </Card>
        </div>
      </section>

      {/* The deal — the challenge pool (no competitor comparison) */}
      <section>
        <div className="grid gap-8 lg:grid-cols-[1.2fr_1fr] lg:items-center">
          <div>
            <p className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">The deal</p>
            <h2 className="mt-3 text-[clamp(1.7rem,3.5vw,2.4rem)] font-extrabold leading-tight">
              The winner takes <span className="text-yang">100%</span> of the pool
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-2">
              Reading, submitting, checking and publishing are free. Members earn by winning member-founded challenges: every entrant’s fee goes into the pool, and at the full moon the most-hearted entry takes <strong className="font-semibold text-ink">the whole pool</strong> — an exact tie splits it evenly. The Foundation never takes a cut of a pool; it runs on donations, and bursary donations exist so an entry fee never decides who takes part. What ArtaQuest keeps covers hosting, payment processing, and day-to-day running costs. No investor, manager, or staff member profits from it — ArtaQuest is a registered non-profit foundation.
            </p>
          </div>
          <Card className="p-6 sm:p-7">
            <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Your share</p>
            <p className="mt-3 text-[clamp(2.6rem,7vw,3.4rem)] font-extrabold leading-none text-yang tabular-nums">100%</p>
            <p className="mt-2 text-[14px] leading-relaxed text-ink-2">of every challenge pool you win — the entry fees in full, with nothing taken by the Foundation.</p>
            <hr className="my-5 border-line" />
            <p className="text-[13px] leading-relaxed text-ink-3">The remainder covers hosting and payment processing only. Nobody takes a profit — ArtaQuest is a non-profit foundation.</p>
          </Card>
        </div>
      </section>

      {/* The creator ladder — 5 tiers; what each rung unlocks grows with rank */}
      <CreatorLadder />

      {/* One requirement — earn enough points */}
      <section id="how-to-qualify" className="scroll-mt-24">
        <div className="grid gap-8 lg:grid-cols-[1.2fr_1fr] lg:items-start">
          <div>
            <p className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">One requirement</p>
            <h2 className="mt-3 text-[clamp(1.5rem,3vw,2rem)] font-bold leading-tight">Earn enough points</h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-2">
              Instead of weighing credentials or filtering applicants through a gate-keeper, we have one rule: earn enough points and you climb the ladder. Submitting a public Kaggle notebook is open to everyone from day one; what the rungs open is the <strong className="font-semibold text-ink">Studio</strong> — authoring grant applications and sitewide topics — and room to keep more of your published work live at once. Points are a lifetime score of what you contribute — never spent, never falling — so they reward real, lasting participation. It is a deliberate choice.
            </p>
            <p className="mt-3 text-[16px] leading-relaxed text-ink-2">
              There are four ways to earn them, and any of them moves you up: <strong className="font-semibold text-ink">learn</strong> — a point for every comment you post on a published work; <strong className="font-semibold text-ink">donate</strong> — a point for every whole unit of currency you give to the Foundation’s funds; <strong className="font-semibold text-ink">volunteer</strong> — a point for starting a discussion, and one for each contribution of yours that gets resolved; <strong className="font-semibold text-ink">win sponsors</strong> — points equal to the funding you help the foundation win on the Sponsors page. It is a path up the ladder, not a shortcut around our content standards — everything posted is still read by ArtaMod.
            </p>
          </div>
          <ProgressPanel />
        </div>
      </section>

      {/* Questions / contact */}
      <section className="rounded-card border border-line bg-gradient-to-br from-space-2 to-space-3 px-6 py-12 text-center sm:px-12">
        <h2 className="text-[clamp(1.4rem,3vw,1.9rem)] font-bold leading-snug">Have work in mind?</h2>
        <p className="mx-auto mt-3 max-w-xl text-[15px] text-ink-2">If you are not yet sure it fits, write to us with a one-paragraph summary. We read every message and reply within 3–5 business days.</p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Button href="mailto:support@artaquest.org" size="xl">Email support@artaquest.org</Button>
          <Button variant="outline" size="xl" href="/faq-contact/" className="text-ink hover:text-yin-light">FAQ & contact</Button>
        </div>
      </section>
    </div>
  );
}
