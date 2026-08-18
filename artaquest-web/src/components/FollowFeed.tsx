import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, Courses, Economy, Learn, Social, type CourseCard, type FeedItem, type FeedTarget, type LeaderRow } from "../lib/api";
import { nameClass } from "../lib/fmt";
import { currentUser, localePath, relAgo } from "../lib/wp";
import { Avatar, Button, Card, Chip, FlagBadge, LoadMoreButton, SectionHeader, VoteControl, cx } from "./ui";

// One verb line per event type — plain English like all UI copy (the i18n mesh translates it).
// Indexed by string so an event type this build doesn't know yet degrades to a generic line
// instead of crashing the feed.
const VERB: Record<string, string> = {
  thread: "started a discussion",
  reply: "replied in",
  upvote: "hearted a reply in",   upvote_thread: "hearted the discussion",
  enroll: "joined the course",
};

// Event-type glyph badge: what happened, at a glance. Two brand tones only — blue (yin) for
// talking, gold (yang) for support + joining a quest; each gets a matching tinted chip so the
// type column reads at a glance. `fill` switches the svg between stroke icons and the solid
// vote triangle (the same shape VoteControl uses).
const GLYPH: Record<string, { d: string; tone: string; tint: string; fill?: boolean; label: string }> = {
  thread: { d: "M21 11.5a8.38 8.38 0 0 1-8.5 8.5A8.5 8.5 0 0 1 9 19.07L3 21l1.93-6A8.5 8.5 0 1 1 21 11.5Z", tone: "text-yin-light", tint: "bg-yin/15", label: "New discussion" },
  reply: { d: "M9 17l-5-5 5-5M20 18v-2a4 4 0 0 0-4-4H4", tone: "text-yin-light", tint: "bg-yin/15", label: "Reply" },
  upvote: { d: "M12 4l8 10h-5v6H9v-6H4z", tone: "text-yang", tint: "bg-yang/15", fill: true, label:
  "Heart" },   upvote_thread: { d: "M12 4l8 10h-5v6H9v-6H4z", tone: "text-yang", tint: "bg-yang/15",
  fill: true, label: "Heart" },
  enroll: { d: "M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z", tone: "text-yang", tint: "bg-yang/15", label: "Joined a course" },
};

/** The event-type chip — on an avatar corner (solid backdrop so it stays legible over a photo)
 *  or inline at the start of a grouped action line (brand-tinted). */
function Glyph({ type, solid, className }: { type: string; solid?: boolean; className?: string }) {
  const g = GLYPH[type] || GLYPH.reply;
  return (
    <span className={cx("grid h-5 w-5 place-items-center rounded-full border border-line", solid ? "bg-space-2" : g.tint, g.tone, className)} title={g.label}>
      {g.fill
        ? <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden><path d={g.d} /></svg>
        : <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={g.d} /></svg>}
    </span>
  );
}

// Client-side view filters over the loaded pages ("Show more" keeps appending into the
// active view). Mutually exclusive by what the EVENT is, so the chips partition the feed.
const FILTERS: { key: string; label: string; types: FeedItem["type"][] | null }[] = [
  { key: "all", label: "All", types: null },
  { key: "discussions", label: "Discussions", types: ["thread"] },
  { key: "replies", label: "Replies", types: ["reply"] },
  { key: "upvotes", label: "Hearts", types: ["upvote", "upvote_thread"] },
  { key: "courses", label: "Courses", types: ["enroll"] },
];

const targetKey = (t: FeedTarget) => `${t.kind}:${t.id}`;

/** CONSECUTIVE events by the same person collapse into one card row (a burst of replies or
 *  upvotes reads as one "session" instead of n near-identical cards). Order is untouched, so
 *  the merged newest-first timeline stays honest across pages and filters. */
type Group = { actor: FeedItem["actor"]; items: FeedItem[] };
function groupByActor(list: FeedItem[]): Group[] {
  const out: Group[] = [];
  for (const it of list) {
    const last = out[out.length - 1];
    if (last && last.actor.slug === it.actor.slug && last.actor.name === it.actor.name) last.items.push(it);
    else out.push({ actor: it.actor, items: [it] });
  }
  return out;
}

/** One event's substance: the verb line (with optional leading name), quoted excerpt, live vote
 *  control and its error note. `lead` carries the actor's name on single rows; grouped rows name
 *  the actor once in their header instead. */
function EventLine({ it, lead, busy, err, onVote }: {
  it: FeedItem; lead?: ReactNode; busy: boolean; err: string; onVote: (t: FeedTarget, dir: 1 | -1) => void;
}) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[14px] leading-snug text-ink-2">
          {lead}{VERB[it.type] || "shared"}{" "}
          <a href={localePath(it.url)} className="font-semibold text-ink transition-colors hover:text-yang">{it.title}</a>
          {it.context && <span className="text-ink-3"> · {it.context}</span>}
        </p>
        <span className="shrink-0 text-[12px] text-ink-3">{relAgo(it.at)}</span>
      </div>
      {it.excerpt && (
        <p className="mt-1.5 line-clamp-3 border-s-2 border-line bg-veil/5 py-1 ps-3 pe-2 text-[13px] leading-relaxed text-ink-2">{it.excerpt}</p>
      )}
      {it.target && (
        <div className="mt-1.5">
          <VoteControl layout="pill" noteAlign="start" votes={it.target.score} myVote={it.target.my_vote} mine={it.target.mine}
            busy={busy} onVote={(dir) => onVote(it.target as FeedTarget, dir)}
            votersTarget={{ kind: it.target.kind, id: it.target.id }} />
        </div>
      )}
      {err && <p role="alert" className="mt-1.5 rounded-card border border-yin/30 bg-yin/5 px-3 py-1.5 text-[12px] text-yin-light">{err}</p>}
    </>
  );
}

function GroupRow({ g, voteBusy, voteErr, onVote }: {
  g: Group; voteBusy: string | null; voteErr: { key: string; msg: string } | null; onVote: (t: FeedTarget, dir: 1 | -1) => void;
}) {
  const { actor, items } = g;
  const single = items.length === 1;
  const profile = actor.slug ? localePath(`/u/${actor.slug}/`) : "";
  const name = profile
    ? <a href={profile} data-ay-skip="1" className="font-semibold text-ink transition-colors hover:text-yang">{actor.name}</a>
    : <span data-ay-skip="1" className="font-semibold text-ink">{actor.name}</span>;
  const lineProps = (it: FeedItem) => ({
    it,
    busy: !!it.target && voteBusy === targetKey(it.target),
    err: it.target && voteErr?.key === targetKey(it.target) ? voteErr.msg : "",
    onVote,
  });
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="relative shrink-0">
        {profile
          ? <a href={profile} aria-label={actor.name}><Avatar src={actor.avatar} name={actor.name} className="h-9 w-9 text-sm ring-1 ring-line" /></a>
          : <Avatar src={actor.avatar} name={actor.name} className="h-9 w-9 text-sm ring-1 ring-line" />}
        {/* Nationality flag bottom-LEFT — the bottom-right corner belongs to the event glyph. */}
        <FlagBadge country={actor.country} className="-left-1 right-auto w-4" />
        {single && <Glyph type={items[0].type} solid className="absolute -bottom-1 -right-1" />}
      </div>
      <div className="min-w-0 flex-1">
        {single ? (
          <EventLine {...lineProps(items[0])} lead={<>{name}{" "}</>} />
        ) : (
          <>
            <p className="text-[14px] leading-snug text-ink-2">{name} <span className="text-ink-3">· {items.length} actions</span></p>
            <div className="mt-2 flex flex-col gap-2.5">
              {items.map((it, i) => (
                <div key={`${it.type}-${it.at}-${i}`} className="flex items-start gap-2">
                  <Glyph type={it.type} className="mt-px shrink-0" />
                  <div className="min-w-0 flex-1"><EventLine {...lineProps(it)} /></div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── Right rail (suggestions) ───────────────────────── */

function RailCard({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-[12px] font-bold uppercase tracking-[0.14em] text-ink-3">{title}</h3>
        {action}
      </div>
      {children}
    </Card>
  );
}

const railLink = (href: string, label: string) => (
  <a href={localePath(href)} className="shrink-0 text-[12px] font-semibold text-yang hover:underline">{label}</a>
);

/** "Questers to follow" — the top of the global leaderboard, minus the viewer and anyone already
 *  followed (the feed's `followed` ids). Follow goes through the same POST /follow the profile
 *  button uses; rows just followed stay in place with a quiet "Following" so the list never
 *  jumps mid-interaction. */
function PeerRail({ followedIds, onFollowed }: { followedIds: number[]; onFollowed: () => void }) {
  const [peers, setPeers] = useState<LeaderRow[]>([]);
  const [followedHere, setFollowedHere] = useState<number[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    Economy.leaderboard()
      .then((r) => setPeers(r.items))
      .catch(() => { /* suggestions are a bonus — on error the card simply doesn't render */ });
  }, []);
  const meSlug = currentUser()?.slug;
  const rows = useMemo(
    () => peers.filter((p) => p.id && p.slug !== meSlug && (!followedIds.includes(p.id) || followedHere.includes(p.id))).slice(0, 5),
    [peers, followedIds, followedHere, meSlug],
  );
  if (rows.length === 0) return null;

  const follow = async (p: LeaderRow) => {
    if (busy) return;
    setBusy(p.id);
    try {
      await Social.follow(p.id);
      setFollowedHere((cur) => [...cur, p.id]);
      onFollowed();
    } catch { /* quiet — the button simply stays "Follow" to try again */ }
    finally { setBusy(null); }
  };

  return (
    <RailCard title="Members to follow" action={railLink("/rankings/", "Rankings →")}>
      <ul className="flex flex-col gap-3">
        {rows.map((p) => {
          const done = followedHere.includes(p.id);
          const profile = p.slug ? localePath(`/u/${p.slug}/`) : "";
          return (
            <li key={p.id} className="flex items-center gap-2.5">
              {profile
                ? <a href={profile} aria-label={p.name}><Avatar src={p.avatar} name={p.name} className="h-9 w-9 text-sm ring-1 ring-line" /></a>
                : <Avatar src={p.avatar} name={p.name} className="h-9 w-9 text-sm ring-1 ring-line" />}
              <div className="min-w-0 flex-1">
                {profile
                  ? <a href={profile} data-ay-skip="1" className={`block font-semibold text-ink transition-colors hover:text-yang ${nameClass(p.name)}`}>{p.name}</a>
                  : <span data-ay-skip="1" className={`block font-semibold text-ink ${nameClass(p.name)}`}>{p.name}</span>}
                <p className="truncate text-[12px] text-ink-3">{p.tier} · {p.points.toLocaleString()} points</p>
              </div>
              {done
                ? <span className="shrink-0 px-1 text-[12px] font-semibold text-yang">Following</span>
                : <Button size="sm" variant="subtle" disabled={busy === p.id} onClick={() => { void follow(p); }} className="h-8 shrink-0 px-3.5 text-[13px]">Follow</Button>}
            </li>
          );
        })}
      </ul>
    </RailCard>
  );
}

/** "Courses to explore" — the catalogue's trending shortlist (rank_score = avg per-video rolling-24h
 *  comment count, the same metric /courses leads with), so the rail always has something worth joining. */
function CourseRail() {
  const [items, setItems] = useState<CourseCard[]>([]);
  useEffect(() => {
    Courses.list({ limit: 4, sort: "trending" })
      .then((r) => setItems(r.items))
      .catch(() => { /* suggestions are a bonus — on error the card simply doesn't render */ });
  }, []);
  if (items.length === 0) return null;
  return (
    <RailCard title="Courses to explore" action={railLink("/courses/", "Browse all →")}>
      <ul className="flex flex-col gap-3">
        {items.map((c) => (
          <li key={c.id}>
            <a href={localePath(`/courses/${c.slug}`)} className="group flex items-center gap-3">
              {c.image
                ? <span className="h-10 w-16 shrink-0 rounded-field bg-cover bg-center ring-1 ring-line" style={{ backgroundImage: `url("${c.image}")` }} aria-hidden />
                : <span className="h-10 w-16 shrink-0 rounded-field bg-gradient-to-br from-yin/40 to-space-3 ring-1 ring-line" aria-hidden />}
              <span className="min-w-0">
                <span className="line-clamp-2 text-[13px] font-semibold leading-snug text-ink transition-colors group-hover:text-yang">{c.title}</span>
                <span className="mt-0.5 block text-[12px] text-ink-3">{c.lessons} video{c.lessons === 1 ? "" : "s"}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </RailCard>
  );
}

/**
 * The home-page follower activity feed: what the people the viewer follows have been doing
 * (replies, upvotes, new discussions, course enrolments — GET /feed). Self-contained so Home
 * stays presentational; on any fetch error it renders nothing rather than breaking the page.
 *
 * Layout: the feed column plus a right-hand suggestions rail on desktop (questers to follow from
 * the leaderboard + trending courses) — the rail is what fills the formerly-empty space beside
 * the feed, and it renders for the no-follows state too, where it IS the call to action.
 *
 * Every event that points at a votable post/reply carries `target`, and the row renders the
 * SAME up/down control the boards use — votes cast here go through the same guarded routes
 * (public POST /vote; competition POST /comment/vote, which keeps enrolment, self-vote and
 * season-projection rules intact). One target can appear behind several rows (a reply AND a
 * peer's upvote of it), so a cast patches every row sharing that target.
 */
export default function FollowFeed() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [following, setFollowing] = useState(-1); // -1 = loading or failed → section hidden
  const [followed, setFollowed] = useState<number[]>([]); // ids the viewer follows → rail exclusions
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("all");
  const [voteBusy, setVoteBusy] = useState<string | null>(null); // targetKey of the in-flight cast
  const [voteErr, setVoteErr] = useState<{ key: string; msg: string } | null>(null);

  const load = useCallback(() => {
    Social.feed()
      .then((r) => { setItems(r.items); setNext(r.next); setFollowing(r.following); setFollowed(r.followed ?? []); })
      .catch(() => { /* signed-out tab or transient error — the section simply doesn't render */ });
  }, []);
  useEffect(() => { load(); }, [load]);

  const more = async () => {
    if (!next || busy) return;
    setBusy(true);
    try {
      const r = await Social.feed(next);
      setItems((cur) => [...cur, ...r.items]);
      setNext(r.next);
    } catch {
      setNext(null); // pagination failed — keep what's shown, drop the button
    } finally {
      setBusy(false);
    }
  };

  // Following someone from the rail: an EMPTY feed springs to life right away (the cold-start
  // payoff); a feed mid-read is left alone — no pagination reset under the reader.
  const onFollowed = () => { if (following === 0 || items.length === 0) load(); };

  // Reddit-style toggle (same semantics as both boards): re-tapping the cast arrow clears,
  // the opposite arrow flips. The competition route returns the authoritative score; the
  // public route returns the delta. On failure say so with the server's own message when it
  // has one (the enrol gate, a self-vote) — a silent no-op reads as "the buttons don't work".
  const castVote = async (t: FeedTarget, dir: 1 | -1) => {
    if (voteBusy) return;
    const key = targetKey(t);
    const val = (t.my_vote === dir ? 0 : dir) as -1 | 0 | 1;
    const patch = (p: Partial<FeedTarget>) =>
      setItems((cur) => cur.map((x) => (x.target && targetKey(x.target) === key ? { ...x, target: { ...x.target, ...p } } : x)));
    setVoteBusy(key);
    setVoteErr(null);
    try {
      if (t.kind === "comment" && t.board === "section") {
        const r = await Learn.voteComment(t.id, val);
        patch({ my_vote: r.my_vote, score: r.votes });
      } else {
        const r = await Social.vote(t.kind, t.id, val);
        patch({ my_vote: val, score: t.score + r.score_delta });
      }
    } catch (e) {
      // ApiError's fallback message is the synthesized "path → status" — only relay real ones.
      const server = e instanceof ApiError && e.message && !e.message.includes("→") ? e.message : "";
      setVoteErr({ key, msg: server || "Couldn't record your vote — please try again." });
    } finally {
      setVoteBusy(null);
    }
  };

  const active = FILTERS.find((f) => f.key === filter) || FILTERS[0];
  const visible = useMemo(
    () => (active.types ? items.filter((it) => (active.types as FeedItem["type"][]).includes(it.type)) : items),
    [items, active],
  );
  const groups = useMemo(() => groupByActor(visible), [visible]);

  if (following < 0) return null;

  const feed = following === 0 ? (
    <Card className="flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h3 className="text-[16px] font-bold">Your feed is waiting</h3>
        <p className="mt-1 max-w-md text-[14px] text-ink-2">Follow other members to see their replies and hearts here — start with the suggestions alongside, find people in the rankings, or tap Follow on any profile.</p>
      </div>
      <Button variant="outline" href="/rankings/">See the rankings</Button>
    </Card>
  ) : items.length === 0 ? (
    <Card className="px-5 py-6 text-[14px] text-ink-3">Nothing new from the people you follow yet — check back soon.</Card>
  ) : (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Chip key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</Chip>
        ))}
      </div>
      <Card className="divide-y divide-line">
        {groups.length === 0 ? (
          <p className="px-5 py-6 text-[14px] text-ink-3">Nothing here yet — try another filter, or load more below.</p>
        ) : (
          groups.map((g, i) => (
            <GroupRow key={`${g.actor.slug}-${g.items[0].at}-${i}`} g={g}
              voteBusy={voteBusy} voteErr={voteErr} onVote={castVote} />
          ))
        )}
      </Card>
      {next != null && <LoadMoreButton onClick={() => { void more(); }} loading={busy} label="Show more" className="pt-3" />}
    </>
  );

  return (
    <section>
      <SectionHeader title="From people you follow" className="mb-4" />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">{feed}</div>
        {/* The right-hand rail: who to follow next + what's trending. Stacks below the feed on
            phones; sticky beside it on desktop (76px clears the 60px topbar). */}
        <aside aria-label="Suggestions" className="grid gap-5 lg:sticky lg:top-[76px]">
          <PeerRail followedIds={followed} onFollowed={onFollowed} />
          <CourseRail />
        </aside>
      </div>
    </section>
  );
}
