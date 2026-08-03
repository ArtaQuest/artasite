import { useEffect, useState } from "react";
import { localePath, getDashboard, currentUser, type Dashboard } from "../lib/wp";
import { Coins, Points } from "../lib/currency";
import { Button, Card, CertBadge } from "../components/ui";
import FollowFeed from "../components/FollowFeed";
import SeasonNow from "../components/seasons";
import { thumbSrc } from "../lib/img";

const CARD_TINTS = ["from-yang/30", "from-yin/40", "from-yang/40"];

// The kept progress ring: % toward the next rank. The arc + the % sweep the brand duality (gold → blue)
// so the ring reads as the same blue+gold brand mark as the coin beside it — not a flat single-hue gold.
function TierRing({ tier }: { tier?: Dashboard["tier"] }) {
  const pct = tier?.pct ?? 0;
  const C = 100.53; // circumference 2π·16
  return (
    <div className="relative grid h-[88px] w-[88px] shrink-0 place-items-center" title={tier?.next ? `${tier.remaining} to ${tier.next}` : "Top rank"}>
      <svg viewBox="0 0 36 36" className="h-[88px] w-[88px] -rotate-90" aria-hidden>
        {/* Brand-duality sweep for the arc — gold (the Why) → blue (the How). The #E8B923/#2352E8
            sentinels are remapped to the live, theme + contrast-aware brand tokens by index.css,
            exactly like the coin mark, so the arc tracks the palette instead of a lone gold. */}
        <defs>
          <linearGradient id="aq-tier-arc" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#E8B923" />
            <stop offset="100%" stopColor="#2352E8" />
          </linearGradient>
        </defs>
        <circle cx="18" cy="18" r="16" fill="none" strokeWidth="2.5" className="stroke-line" />
        <circle cx="18" cy="18" r="16" fill="none" strokeWidth="2.5" strokeLinecap="round"
          stroke="url(#aq-tier-arc)"
          className="transition-[stroke-dasharray] duration-500"
          strokeDasharray={`${((pct * C) / 100).toFixed(2)} ${C}`} />
      </svg>
      <span className="absolute flex flex-col items-center leading-none">
        <span className="aq-grad text-[17px] font-bold">{tier ? `${pct}%` : "—"}</span>
        {tier?.next && <span className="mt-1 text-[9px] uppercase tracking-wide text-ink-2">to {tier.next}</span>}
      </span>
    </div>
  );
}

export default function Home() {
  const [dash, setDash] = useState<Dashboard | null>(null);

  useEffect(() => {
    getDashboard().then(setDash);
  }, []);

  // Name is injected by WP at first paint (currentUser) so the greeting renders correctly
  // with no placeholder flash; the dashboard fetch only refines it. Never show a bare "there".
  const name = dash?.user.name || currentUser()?.name || "Quester";
  // Time-of-day greeting — warmer than a static "Welcome back", and correct for brand-new
  // users too (who were never here before). Translatable like all UI copy.
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const tier = dash?.tier;
  // "Your courses" = the courses the user is actually enrolled in (with progress), NOT the
  // public catalogue. "Continue learning" resumes the most-recent course straight into the lesson
  // the learner left off at (resume), not its landing page; fall back to browsing when there are none.
  const courses = dash?.courses ?? [];
  const resumeUrl = courses[0]?.resume || courses[0]?.url || "/courses/";

  return (
    <div className="flex flex-col gap-10">
      {/* Welcome band: greeting + CTAs (left), coins + the progress ring (right). The decorative
          orbit motif was removed here — it collided with the stat cluster and the TierRing (two
          competing ring systems); the TierRing alone carries the motif cleanly. */}
      <section className="relative overflow-hidden rounded-card border border-line bg-space-2 px-6 py-9 shadow-card sm:px-9">
        <div className="relative flex flex-col gap-7 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[13px] font-semibold uppercase tracking-[0.18em] text-ink-3">{greeting}</p>
            <h1 className="mt-1.5 text-[clamp(1.9rem,4vw,2.4rem)] font-extrabold leading-tight">{name}</h1>
            <p className="mt-2 max-w-md text-[15px] leading-relaxed text-ink-2">Pick up where you left off, or start something new. Every video is a step on your quest for the truth.</p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button href={resumeUrl}>{courses.length ? "Continue learning" : "Browse courses"}</Button>
              <Button variant="outline" href="/discussions/" className="hover:text-yin-light">Discussions</Button>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-6">
            <div className="text-right">
              {/* The figures sweep the brand gold→blue duality — aq-grad on JUST the digits (via nClassName),
                  so the gradient hugs the number and the coin/star mark keeps its own fills (and can't be
                  hidden by background-clip:text on WebKit). Fixes the flat brown-gold; matches the coin. */}
              <div className="text-[30px] font-extrabold leading-none tabular-nums text-ink-3">{dash ? <Coins n={dash.coins} nClassName="aq-grad" /> : "—"}</div>
              <div className="mt-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-2">in your wallet</div>
              <div className="mt-3 text-[18px] font-bold leading-none tabular-nums text-ink-3">{dash ? <Points n={dash.points} nClassName="aq-grad" /> : "—"}</div>
              <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-ink-2">{tier?.label || "Quester"}</div>
            </div>
            <TierRing tier={tier} />
          </div>
        </div>
      </section>

      {/* What to study now — the daily study compass over the twelve cycles (Home only) */}
      <SeasonNow />

      {/* Your courses — enrolled courses with their real thumbnail + progress toward completion. Shown
          only when the learner actually has some; a member with none jumps straight to the feed (the
          stat tiles + the empty "start your first course" placeholder were removed — operator
          2026-07-03 — the wallet/points already sit in the welcome band, and the "Browse courses" CTA
          lives there too). */}
      {courses.length > 0 && (
        <section>
          <div className="mb-5 flex items-end justify-between">
            <h2 className="text-[22px] font-bold tracking-tight">Your courses</h2>
            <a href={localePath("/courses/")} className="text-[14px] font-semibold text-yang hover:underline">Browse all →</a>
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {courses.slice(0, 6).map((c, i) => (
              <Card as="a" key={c.url} href={localePath(c.url)} className="group overflow-hidden transition-colors hover:border-yin-light/40">
                {c.image ? (
                  <div className="h-28 bg-cover bg-center" style={{ backgroundImage: `url("${thumbSrc(c.image)}")` }} />
                ) : (
                  <div className={`h-28 bg-gradient-to-br ${CARD_TINTS[i % CARD_TINTS.length]} to-space-3`} />
                )}
                <div className="p-4">
                  <h3 className="line-clamp-2 text-[16px] font-bold transition-colors group-hover:text-yang">{c.value}</h3>
                  <div className="mt-3 flex items-center justify-between text-[12px] text-ink-3">
                    <span>{c.lessons ? `${c.lessons} video${c.lessons === 1 ? "" : "s"}` : "Interactive video course"}</span>
                    <span className="tabular-nums">{c.pct ?? 0}% {(c.pct ?? 0) >= 100 ? "complete" : "done"}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={c.pct ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label={`${c.value} progress`}>
                    <div className="h-full rounded-full bg-yang transition-[width] duration-500" style={{ width: `${c.pct ?? 0}%` }} />
                  </div>
                  {c.cert && <CertBadge className="mt-2.5" />}
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* What the people you follow have been doing — replies, upvotes, discussions, enrolments */}
      <FollowFeed />
    </div>
  );
}
