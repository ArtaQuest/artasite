import { useEffect, useState } from "react";
import { getDashboard, currentUser, type Dashboard } from "../lib/wp";
import { Coins, Points } from "../lib/currency";
import { Button } from "../components/ui";
import FollowFeed from "../components/FollowFeed";
import SeasonNow from "../components/seasons";

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
            {/* Both buttons here used to lead somewhere retired. "Browse courses" pointed at
                /courses/, which two-hops through /playlists/ to /articles/, and "Discussions" at
                /discussions/, which 301s to /works/ — the standalone forum was retired 2026-07-14.
                So the first thing a signed-in member saw offered two redirects and a sentence about
                videos, on a platform whose unit is a published notebook.

                The primary action is now the one the platform exists for and the one a member has to
                be told about, since it starts on Kaggle: bring a notebook. The secondary is the feed
                itself. Both are direct, 200, no hops. */}
            <p className="mt-2 max-w-md text-[15px] leading-relaxed text-ink-2">Bring a notebook you have run on Kaggle, and let anyone check it for themselves. Every work here carries its own evidence.</p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button href="/studio/">Submit a notebook</Button>
              <Button variant="outline" href="/works/" className="hover:text-yin-light">Browse the feed</Button>
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

      {/* (Your courses — the enrolled-course grid — removed 2026-08-08. The courses platform was
          purged 2026-07-13, so `dash.courses` has been empty ever since and this section's own
          `courses.length > 0` guard meant it could never render again. It was dead code that still
          had to be read, typechecked and shipped in every bundle. The dashboard tiles that reported
          the same purged data are gone with it — see getDashboard in lib/wp.ts.) */}

      {/* What the people you follow have been doing — replies, upvotes, discussions, enrolments */}
      <FollowFeed />
    </div>
  );
}
