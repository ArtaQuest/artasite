/**
 * THE RIGHT COLUMN'S CARDS — what's happening, who to follow, the open challenges, the news.
 *
 * They lived inside Feed.tsx and were therefore the FEED's rail, which is why every other page's
 * right column was a search field and a row of links (operator 2026-08-16: "put some stuff to the
 * right"). They are the platform's discovery surface, not the timeline's, so they live here and
 * both callers mount the same components: the feed (which also interleaves them into the phone
 * timeline) and <ShellRail>, for every page that contributes no cards of its own.
 *
 * `useRail(enabled)` is the single fetch behind them; a page that does not render them passes
 * false and makes no requests at all.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  followUser,
  type Challenge, type FollowSuggestion, type NewsItem, type TrendingKindItem, type TrendingTopic,
} from "../lib/api";
import { Avatar, cx } from "./ui";
import { nameClass, closesIn, timeAgo, isFresh } from "../lib/fmt";
import { NB_KIND_META } from "./nbview";
import { isLoggedIn } from "../lib/auth";
import { localePath } from "../lib/wp";

// ── the right rail (X-style, operator 2026-07-28): Challenges · What's happening · Who to follow ──
// One fetch in Feed (useRail) feeds BOTH surfaces: the sticky desktop rail (lg+) and the
// compact modules interleaved into the phone timeline (X puts "What's happening" inline the same
// way). Every module hides itself when its data is empty — the rail never shows hollow boxes.


/** All trending kinds (marketplace + educational-social), merged for the per-type cards. */
export function RailCard({ title, more, children }: { title: string; more?: { href: string; label: string }; children: React.ReactNode }) {
  return (
    // shrink-0 is load-bearing: rail cards are flex children of a max-height, scrollable column;
    // without it an overflowing column COMPRESSES each card (and overflow-hidden clips the content
    // mid-row) instead of letting the column scroll.
    <section className="shrink-0 overflow-hidden rounded-2xl border border-line bg-space-2">
      <h2 className="px-4 pb-1.5 pt-3 text-[17px] font-extrabold tracking-tight">{title}</h2>
      {children}
      {more ? (
        <Link to={more.href} className="block px-4 py-3 text-[13px] font-semibold text-yin-ink transition-colors hover:bg-veil/[0.04]">{more.label}</Link>
      ) : null}
    </section>
  );
}

export function ChallengeRow({ c }: { c: Challenge }) {
  return (
    <Link to="/challenges" className="block px-4 py-2.5 transition-colors hover:bg-veil/[0.04]">
      <div className="flex items-baseline justify-between gap-2">
        <p className={`min-w-0 font-bold text-ink ${nameClass(c.title)}`}>{c.title}</p>
        <span className="shrink-0 text-[15px] font-extrabold tracking-tight text-yang">₳{c.pool}</span>
      </div>
      {/* The meta line carries the TOPIC, so it wraps rather than cutting one. */}
      <p className="mt-0.5 text-[12px] leading-tight text-ink-3">{NB_KIND_META[c.kind]?.label} · {c.topic} · closes {closesIn(c.deadline)} · {c.entries} in</p>
    </Link>
  );
}

export function ChallengesCard({ items }: { items: Challenge[] | null }) {
  if (items === null) return <div className="h-40 shrink-0 animate-pulse rounded-2xl bg-veil/[0.06]" aria-hidden />;
  if (!items.length) return null; // operator 2026-07-23: no empty cards — when there's no open challenge the card disappears entirely
  return (
    <RailCard title="Challenges" more={{ href: "/challenges", label: "Show all challenges" }}>
      {items.length ? items.slice(0, 3).map((c) => <ChallengeRow key={c.id} c={c} />) : (
        <p className="px-4 py-3 text-[13px] text-ink-3">No open challenge right now — found the next one.</p>
      )}
    </RailCard>
  );
}

// ── THE RESEARCH RAIL (operator 2026-07-22 — replaced the price-of-energy card) ──────────────
// X's right rail is "What's happening" (trends) then people; ours is the same two beats about
// research: the TOPICS the world is citing right now, then the PAPERS themselves. One backend
// fetch (GET /scholar/trending, 6h cron-refreshed) feeds both cards — the topics are grouped
// from the very pool the papers are drawn from, so the two can never disagree.
//
// Trending = CITATION VELOCITY (cites ÷ days since publication — the `rate` field), not raw
// counts: raw counts hand the card to whatever appeared on day 1 of the window. Same grammar
// as the course catalogue's "X/hr" view rate — this platform ranks by rate everywhere.
//
// Every row is OPEN ACCESS WITH A REAL PDF (operator) — liveness-checked server-side, no
// paywall, no landing-page dead end — across EVERY field, not one archive (operator: "all the
// topics, not only arXiv"). Source: OpenAlex, the open scholarly graph; Google Scholar (the
// operator's ask) publishes no API and forbids scraping, so this is the substitute covering
// the same ground legally. See Extra::scholar_trending for the ranking + junk-gate story.

/**
 * "Today's News" — X's headline card (operator 2026-07-30), carrying SCIENCE AND EDUCATION ONLY
 * (same instruction): three science newsrooms and three education ones, round-robin interleaved
 * server-side so neither half crowds out the other. See Extra::MKT_NEWS_FEEDS — the general
 * aggregators that used to feed this (Al Jazeera, Google News top stories, the Hacker News front
 * page) are gone from the crawl itself, not merely filtered out here.
 *
 * Each row is the headline, the AI one-liner, and the newsroom that published it. Deliberately NOT
 * a link: the standing rule for these crawl cards is summary-only — no outbound links, no external
 * images (operator 2026-07-23). The summary is what makes the row worth reading on its own.
 */
export function TodaysNewsCard({ items }: { items: TrendingKindItem[] | null }) {
  if (items === null) return <div className="h-48 shrink-0 animate-pulse rounded-2xl bg-veil/[0.06]" aria-hidden />;
  if (!items.length) return null;
  return (
    <RailCard title="Today's News">
      {items.slice(0, 4).map((n) => (
        // Headline, byline and summary are all THIRD-PARTY text: skipped, so the i18n mesh cannot
        // publish another newsroom's copy into the public aq_translations table.
        // A HEADLINE WITH NOWHERE TO GO IS A DEAD END. `url` was carried all the way here and spent
        // only as a React key — the card named a story and its publisher, then offered no way to
        // read it. Linking OUT is not republishing: the summary stays the AI one-liner rather than
        // the newsroom's own copy, which is what the no-republished-copy rule protects. nofollow
        // and noreferrer, because pointing at a story is not endorsing it and a reader's interest
        // is theirs, not the publisher's.
        <article key={n.url || n.title} className="px-4 py-2.5" data-ay-skip="1">
          {n.url ? (
            <a
              className="line-clamp-2 block text-[14px] font-bold leading-snug text-ink hover:text-yin-light hover:underline"
              href={n.url}
              rel="noreferrer nofollow"
              target="_blank"
            >
              {n.title}
            </a>
          ) : (
            <p className="line-clamp-2 text-[14px] font-bold leading-snug text-ink">{n.title}</p>
          )}
          {n.summary ? <p className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-ink-2">{n.summary}</p> : null}
          <p className="mt-1 text-[12px] leading-tight text-ink-3">
            {n.by || "Newsroom"}{n.ts ? ` · ${timeAgo(n.ts)}` : ""}
          </p>
        </article>
      ))}
    </RailCard>
  );
}

/**
 * "What's happening" — X's trend list, except a trend here is a RESEARCH TOPIC that the world is
 * citing right now, not a hashtag. The grammar is X's exactly: the parent field reads as the
 * category line, the topic name is the bold trend, and the volume sits underneath.
 *
 * `papers` is the volume shown; `rate` (citation velocity) is what SELECTED the topic server-side.
 * They are deliberately different numbers — a count shown to a reader must never double as the
 * sort key, or the card starts implying a ranking the number does not support.
 */
export function HappeningCard({ items }: { items: TrendingTopic[] | null }) {
  if (items === null) return <div className="h-48 shrink-0 animate-pulse rounded-2xl bg-veil/[0.06]" aria-hidden />;
  if (!items.length) return null;
  return (
    <RailCard title="What's happening" more={{ href: "/articles/", label: "Show more" }}>
      {items.slice(0, 5).map((t) => (
        // OpenAlex topic + field names are third-party strings — skipped, as above.
        <div key={t.name} className="px-4 py-2" data-ay-skip="1">
          {/* NO ELLIPSIS IN A NAME (operator 2026-08-18), and a field or a topic IS one: cut to
              "Biochemistry, Genetics and" it names nothing. Both wrap and step down by length, the
              same rule members' names follow (lib/fmt nameClass). The card grows a line; that is the
              cheaper cost. `papers` is a count and cannot overflow, so it just loses its truncate. */}
          <p className={`text-ink-3 ${nameClass(t.field, 12)}`}>{t.field} · Trending</p>
          <p className={`font-bold text-ink ${nameClass(t.name)}`}>{t.name}</p>
          <p className="text-[12px] leading-tight text-ink-3">{t.papers} paper{t.papers === 1 ? "" : "s"}</p>
        </div>
      ))}
    </RailCard>
  );
}

/**
 * ArtaNews in the rail — earthquakes, thermal anomalies, connectivity losses, market shocks and
 * service disruptions. Distinct from "Today's News" above, which reports what newsrooms wrote; this
 * reports what an instrument measured. Hides itself while empty, like every other rail module.
 *
 * DELIBERATELY NOT A LINK (operator 2026-07-31: these are "not posted"). Nothing is published for a
 * detection any more, so there is no page to open — which means the row has to carry the evidence
 * itself: what was measured, where, by which instrument, and when. The previous version linked to
 * /news/<slug>, a route backed by a retired table, so every one of those rows 404'd.
 *
 * The measurement string is rendered by the backend because its UNITS change per detector (MW,
 * percent below normal, magnitude, sigma). Never re-derive it here from `severity`.
 */
export function NewsCard({ items }: { items: NewsItem[] | null }) {
  if (!items?.length) return null;
  return (
    <RailCard title="Detected by instruments">
      {items.slice(0, 4).map((n) => {
        // The headline is composed from the same fields as the meta lines, so it usually ALREADY
        // contains them: "Major heat signature, Russia (483 MW)" was followed by "483 MW · Russia"
        // and then "Satellite thermal anomaly", which said Russia twice and MW three times. Show a
        // meta token only when the headline does not already carry it.
        // A token counts as already-said if the headline contains it, OR contains its leading
        // value — "483 MW radiated" is redundant beside "…, Russia (483 MW)" even though the exact
        // phrase differs. Two tokens is the right depth: enough for "483 MW" and "77% below",
        // not so many that a genuinely different measurement gets suppressed.
        const said = (t?: string) => {
          if (!t) return false;
          const title = n.title.toLowerCase();
          if (title.includes(t.toLowerCase())) return true;
          const head = t.split(/\s+/).slice(0, 2).join(" ").toLowerCase();
          return head.length > 1 && title.includes(head);
        };
        const where = n.place || n.country;
        // The measurement is the one token that makes this card different from a wire feed, so when
        // the headline has not already said it, it leads the meta line IN GOLD — the same accent the
        // challenge rows give a prize pool. Everything else stays quiet ink.
        const measure = said(n.measure) ? "" : n.measure;
        const meta = [
          said(where) ? "" : where,
          said(n.detector) ? "" : n.detector,
        ].filter(Boolean);
        const when = n.updated ? timeAgo(n.updated) : "";
        // A detection refreshed within the last six hours — one detection tick — is LIVE in the
        // only sense an instrument feed has: the measurement is current, not being written about.
        // The dot is decorative (aria-hidden) and gold; blue stays the hover accent, per the brand.
        const fresh = isFresh(n.updated, 6 * 3600);
        // Every row is a link now. feed() has emitted `url` since the detection pages shipped;
        // without an anchor each card was a dead end to a page that exists.
        const Row = n.url ? "a" : "div";
        return (
          <Row
            key={n.ekey || n.id}
            {...(n.url ? { href: localePath(n.url) } : {})}
            // px-4, like every other row in every other rail — NOT `-mx-1 px-1`.
            //
            // That pairing is the "let the hover background breathe past the text" trick, and it
            // only works inside a container with padding to absorb the negative margin. This
            // RailCard has none: its heading carries its own px-4 and `{children}` is flush. So each
            // row was 336px wide in a 328px box, sitting 4px outside the card on both sides — and
            // the card is overflow-hidden, so the overhang was CLIPPED rather than shown. Short
            // headlines never reached the edge and looked fine; "Wildfire, 31 km from Pavlohrad,
            // Ukraine (583 MW)" ran under the border with its measurement cut off.
            //
            // Matching the siblings also makes the hover band full-bleed, which is what the rows
            // above and below it already do.
            className={`block px-4 py-2${n.url ? " transition-colors hover:bg-space-3" : ""}`}
          >
            <p className="text-[13.5px] font-semibold leading-snug text-ink" data-ay-skip="1">
              {fresh ? (
                <span className="mb-px mr-1.5 inline-block size-[7px] animate-pulse rounded-full bg-yang align-middle" aria-hidden />
              ) : null}
              {n.title}
            </p>
            <p className="mt-0.5 text-[12px] leading-tight text-ink-3">
              {measure ? <span className="font-bold text-yang-ink" data-ay-skip="1">{measure}</span> : null}
              {measure && (meta.length || when) ? " · " : null}
              {meta.length ? <span data-ay-skip="1">{meta.join(" · ")}</span> : null}
              {meta.length && when ? " · " : null}
              {when}
            </p>
          </Row>
        );
      })}
    </RailCard>
  );
}

export function FollowButton({ id }: { id: number }) {
  const [on, setOn] = useState(false);
  const toggle = () => {
    if (!isLoggedIn()) { window.location.href = localePath("/login/"); return; }
    setOn(!on);
    followUser(id, !on).catch(() => setOn(on));
  };
  return (
    <button type="button" onClick={toggle} aria-pressed={on}
      className={cx("shrink-0 rounded-pill px-3.5 py-1.5 text-[13px] font-bold transition-colors",
        on ? "border border-line text-ink-2 hover:text-ink" : "bg-yang text-on-accent hover:opacity-90")}>
      {on ? "Following" : "Follow"}
    </button>
  );
}

export function WhoToFollowCard({ items }: { items: FollowSuggestion[] | null }) {
  if (!items || !items.length) return null;
  return (
    <RailCard title="Who to follow" more={{ href: "/rankings", label: "Show more creators" }}>
      {items.map((s) => (
        <div key={s.id} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-veil/[0.04]">
          <Link to={`/u/${s.slug}`} className="shrink-0"><Avatar name={s.name} src={s.avatar} className="h-10 w-10" /></Link>
          <div className="min-w-0 flex-1">
            <Link to={`/u/${s.slug}`} className={`block font-bold text-ink hover:underline ${nameClass(s.name)}`}>{s.name}</Link>
            <p className="truncate text-[12px] text-ink-3">{s.hearts} ♥ · {s.works} work{s.works === 1 ? "" : "s"}{s.followers ? ` · ${s.followers} follower${s.followers === 1 ? "" : "s"}` : ""}</p>
          </div>
          <FollowButton id={s.id} />
        </div>
      ))}
    </RailCard>
  );
}
