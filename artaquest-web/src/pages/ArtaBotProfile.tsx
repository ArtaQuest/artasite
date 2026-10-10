/**
 * /u/arta — the assistant's own profile (the "assistant" variant of Profile.tsx).
 *
 * Arta is not a member: it has no wallet, no diary and no inbox (the server refuses coins, bookings
 * and DMs to it — Economy::transfer_coins, Booking::page/slots/take, Chat::send/knock). So this page
 * drops Message / Book a time / Send coins / the coin chip / the rank, keeps Follow, and says what
 * the account is FOR: a primary "Ask @artabot in public" (the composer, "@artabot " typed), a small "Report
 * a bug" ("@artabot bug: "), the live status from arta/status, a short how-to, and — instead of "No
 * posts yet", which is all a notebook list can say about an account that publishes none — its recent
 * public answers, each with the question it answered and a link to the thread.
 *
 * i18n: every sentence is ONE text node.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { artaReplies, artaStatus, askArtaHref, type ArtaStatus, type FeedPostT } from "../lib/api";
import { isArtaFile } from "../lib/arta";
import { ArtaAvatar, ArtaFiles, MentionText } from "../components/arta";
import { Avatar, Button, EmptyState, LoadMoreButton, StatusNote, cx } from "../components/ui";
import { isLoggedIn, localePath, type Profile as ProfileData } from "../lib/wp";
import { timeAgo } from "../lib/fmt";

type Reply = FeedPostT & { parent: FeedPostT | null };

function useArtaStatus() {
  const [st, setSt] = useState<ArtaStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => artaStatus().then((s) => { if (live) { setSt(s); setFailed(false); } }).catch(() => { if (live) setFailed(true); });
    load();
    const t = window.setInterval(() => { if (!document.hidden) load(); }, 60_000);
    return () => { live = false; window.clearInterval(t); };
  }, []);
  return { st, failed };
}

function StatusChip({ st, failed }: { st: ArtaStatus | null; failed: boolean }) {
  if (!st) {
    return failed ? null : <span aria-hidden className="inline-block h-7 w-40 animate-pulse rounded-pill bg-veil/[0.06]" />;
  }
  const paused = st.paused_until > 0; // the server sends 0 once a pause is over
  const online = st.enabled && st.online && !paused;
  const label = online
    ? (st.queued > 0 ? `Online · ${st.queued} in the queue` : "Online · ready for questions")
    : paused ? "Taking a short break · questions are saved"
    : "Offline · questions wait in the queue";
  return (
    <span role="status" className={cx("inline-flex min-h-7 items-center gap-2 rounded-pill border px-3 text-[13px] font-semibold",
      online ? "border-yang/40 bg-yang/[0.10] text-ink" : "border-line bg-veil/[0.04] text-ink-2")}>
      <span aria-hidden className="relative grid h-2.5 w-2.5 place-items-center">
        {online ? <span className="absolute inset-0 animate-ping rounded-full bg-yang/60" /> : null}
        <span className={cx("relative h-2.5 w-2.5 rounded-full", online ? "bg-yang" : paused ? "bg-yin-light" : "bg-ink-3")} />
      </span>
      {label}
    </span>
  );
}

const STEP_ICO = { viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const STEPS: Array<[React.ReactNode, string, string]> = [
  [<svg {...STEP_ICO}><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></svg>,
    "Mention @artabot", "In a post, a reply or a comment — anywhere public."],
  [<svg {...STEP_ICO}><path d="M21 11.5a8.4 8.4 0 0 1-9.4 8.3L3 21l1.2-3.6A8.4 8.4 0 1 1 21 11.5Z" /></svg>,
    "It replies in the thread", "In public, under your post. There is no private chat."],
  [<svg {...STEP_ICO}><path d="M21.4 11.1 12.2 20.3a5 5 0 0 1-7.1-7.1l9.2-9.2a3.5 3.5 0 0 1 5 5l-9.2 9.2a2 2 0 0 1-2.8-2.9l8.5-8.4" /></svg>,
    "Attachments work both ways", "Images, PDFs and text files on your post are read; Arta can reply with files too."],
  [<svg {...STEP_ICO}><path d="M8 2v3M16 2v3M7 8h10a3 3 0 0 1 3 3v3a8 8 0 0 1-16 0v-3a3 3 0 0 1 3-3Z" /><path d="M12 12v6M4 13H1M23 13h-3" /></svg>,
    "Start with bug:", "Arta files a GitHub issue for the team and replies with the link."],
];

function HowTo({ st }: { st: ArtaStatus | null }) {
  return (
    <section aria-labelledby="arta-howto" className="rounded-card border border-line bg-space-2 p-4 sm:p-5">
      <h2 id="arta-howto" className="font-display text-[17px] font-bold tracking-tight">How to use Arta</h2>
      <ol className="mt-3 grid list-none gap-3 sm:grid-cols-2">
        {STEPS.map(([ico, title, body], i) => (
          <li key={i} className="flex min-w-0 gap-3 rounded-2xl border border-line bg-space-1/60 p-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-yin/[0.12] text-yin-ink">{ico}</span>
            <span className="min-w-0">
              <span className="block text-[14px] font-semibold text-ink">{title}</span>
              <span className="mt-0.5 block text-[13px] leading-snug text-ink-2">{body}</span>
            </span>
          </li>
        ))}
      </ol>
      {st ? (
        <p className="mt-3 text-[12.5px] text-ink-3">{`Up to ${st.limits.user_per_hour} questions an hour and ${st.limits.user_per_day} a day per member, so everyone gets an answer.`}</p>
      ) : null}
    </section>
  );
}

function ReplyCard({ r }: { r: Reply }) {
  const q = r.parent;
  const thread = `/works/?post=${q ? q.id : r.id}`;
  return (
    <li className="overflow-hidden rounded-card border border-line bg-space-2">
      {q ? (
        <div className="flex gap-2.5 border-b border-line bg-space-1/50 px-4 py-3">
          <Avatar src={q.author.avatar} name={q.author.name} className="h-7 w-7 shrink-0 text-[11px]" />
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 items-center gap-1.5 text-[13px]">
              <Link to={`/u/${q.author.slug}`} className="truncate font-semibold text-ink hover:underline" data-ay-skip="1">{q.author.name}</Link>
              <span className="shrink-0 text-ink-3">· {timeAgo(q.created)}</span>
            </p>
            <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-[14px] leading-snug text-ink-2 [overflow-wrap:anywhere]"><MentionText text={q.body} /></p>
          </div>
        </div>
      ) : null}
      <div className="relative flex gap-3 bg-gradient-to-br from-yang/[0.06] via-transparent to-yin/[0.04] px-4 py-3.5">
                <ArtaAvatar className="h-9 w-9" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[13.5px]">
            <span className="font-bold text-ink">Arta</span>
            <span className="text-ink-3">· {timeAgo(r.created)}</span>
          </p>
          <p className="mt-0.5 whitespace-pre-wrap text-[15px] leading-relaxed text-ink [overflow-wrap:anywhere]"><MentionText text={r.body} /></p>
          <ArtaFiles items={(r.media || []).filter(isArtaFile)} />
          <Link to={thread} className="mt-2 inline-flex min-h-9 items-center gap-1 text-[13px] font-semibold text-yin-ink hover:underline">
            View thread <span aria-hidden className="inline-block rtl:-scale-x-100">→</span>
          </Link>
        </div>
      </div>
    </li>
  );
}

export default function ArtaBotProfile({ p, following, followers, followBusy, onToggleFollow, loginHref }: {
  p: ProfileData; following: boolean; followers: number; followBusy: boolean; onToggleFollow: () => void; loginHref: string;
}) {
  const { st, failed } = useArtaStatus();
  const signedIn = isLoggedIn();
  const ask = askArtaHref();
  const bug = `/works/?compose=${encodeURIComponent("@artabot bug: ")}`;
  const gate = (to: string) => (signedIn ? to : `${localePath("/login/")}?redirect_to=${encodeURIComponent(to)}`);

  const [items, setItems] = useState<Reply[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [more, setMore] = useState(false);
  const seq = useRef(0);
  const load = useCallback((cursor?: number) => {
    const mine = ++seq.current;
    if (cursor) setMore(true);
    artaReplies(cursor)
      .then((pg) => { if (mine !== seq.current) return; setItems((prev) => (cursor ? [...prev, ...pg.items] : pg.items)); setNext(pg.next); setState("ready"); })
      .catch(() => { if (mine === seq.current && !cursor) setState("error"); })
      .finally(() => { if (mine === seq.current) setMore(false); });
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6">
      <header className="overflow-hidden rounded-card border border-line bg-space-2">
        {/* THE ASSISTANT'S COVER — not the member band: the brand pair drifting under a field of
            "thought" dots, so this page reads as the assistant's at a glance. Pure CSS, decorative,
            and still under prefers-reduced-motion (index.css .aq-arta-cover). */}
        <div aria-hidden className="aq-arta-cover relative h-24 w-full sm:h-36">
          <span className="aq-arta-cover-dots absolute inset-0" />
          <span className="absolute inset-x-0 bottom-0 h-px bg-line" />
        </div>
        <div className="px-4 pb-5 sm:px-6">
          <div className="relative z-10 -mt-10 flex items-start justify-between gap-3 sm:-mt-14">
            <span className="shrink-0 rounded-full bg-space-2 p-1">
              <ArtaAvatar alt="Arta" className="h-20 w-20 sm:h-32 sm:w-32" />
            </span>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 pt-11 sm:pt-16">
              {signedIn ? (
                <Button type="button" onClick={onToggleFollow} disabled={followBusy} variant="outline" className="h-10 px-5 text-[14px] disabled:opacity-60">
                  {following ? "Following" : "Follow"}
                </Button>
              ) : (
                <Button href={loginHref} variant="outline" className="h-10 px-5 text-[14px]">Follow</Button>
              )}
            </div>
          </div>

          <div className="mt-3 min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-[24px] font-extrabold leading-tight tracking-tight sm:text-[28px]">
              <span>{p.fullName?.trim() || p.name || "Arta"}</span>
            </h1>
            <p className="mt-0.5 text-[15px] text-ink-3"><bdi dir="ltr">@{p.slug}</bdi> · ArtaQuest's public assistant</p>
          </div>
          {p.bio ? <p className="mt-3 max-w-2xl whitespace-pre-wrap text-[15px] leading-normal text-ink">{p.bio}</p> : null}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Link to={gate(ask)}
              className="inline-flex h-11 items-center gap-2 rounded-pill bg-yang pe-5 ps-1.5 text-[15px] font-bold text-on-accent shadow-sm transition-colors hover:bg-yang-light">
              <ArtaAvatar className="h-8 w-8 ring-2 ring-on-accent/20" />
              Ask Arta in public
            </Link>
            <Link to={gate(bug)}
              className="inline-flex h-11 items-center gap-1.5 rounded-pill border border-line px-4 text-[14px] font-semibold text-ink-2 transition-colors hover:border-yin-ink hover:text-ink">
              <svg {...STEP_ICO} width={16} height={16}><path d="M8 2v3M16 2v3M7 8h10a3 3 0 0 1 3 3v3a8 8 0 0 1-16 0v-3a3 3 0 0 1 3-3Z" /><path d="M12 12v6" /></svg>
              Report a bug
            </Link>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[14.5px] text-ink-3">
            <StatusChip st={st} failed={failed} />
            {st && st.replied_24h > 0 ? <span><b className="font-bold tabular-nums text-ink">{st.replied_24h.toLocaleString()}</b> {st.replied_24h === 1 ? "answer" : "answers"} in the last day</span> : null}
            <span><b className="font-bold tabular-nums text-ink">{followers.toLocaleString()}</b> {followers === 1 ? "Follower" : "Followers"}</span>
            {p.joined ? <span className="whitespace-nowrap">Here since {p.joined}</span> : null}
          </div>
        </div>
      </header>

      <HowTo st={st} />

      <section aria-labelledby="arta-answers" className="flex flex-col gap-3">
        <h2 id="arta-answers" className="flex items-baseline gap-2 text-[19px] font-bold tracking-tight">
          Recent answers
          <span className="text-[13px] font-normal text-ink-3">in public threads</span>
        </h2>
        {state === "loading" ? (
          <ul className="flex list-none flex-col gap-3" aria-hidden>
            {[0, 1].map((k) => (
              <li key={k} className="rounded-card border border-line bg-space-2 p-4">
                <div className="flex gap-2.5"><div className="h-7 w-7 animate-pulse rounded-full bg-veil/[0.08]" /><div className="h-3.5 w-2/3 animate-pulse rounded bg-veil/[0.07]" /></div>
                <div className="mt-4 flex gap-3"><div className="h-9 w-9 animate-pulse rounded-full bg-yang/[0.15]" /><div className="flex-1"><div className="h-3.5 w-11/12 animate-pulse rounded bg-veil/[0.07]" /><div className="mt-2 h-3.5 w-1/2 animate-pulse rounded bg-veil/[0.07]" /></div></div>
              </li>
            ))}
          </ul>
        ) : state === "error" ? (
          <StatusNote error>Couldn't load Arta's answers — please refresh and try again.</StatusNote>
        ) : items.length ? (
          <>
            <ul className="flex list-none flex-col gap-3">{items.map((r) => <ReplyCard key={r.id} r={r} />)}</ul>
            {next != null ? <LoadMoreButton onClick={() => load(next)} loading={more} /> : null}
          </>
        ) : (
          <EmptyState
            icon={<ArtaAvatar className="h-12 w-12" />}
            title="No answers yet"
            body="Arta's public answers show up here. Ask the first question — it replies in your thread."
            action={<Link to={gate(ask)} className="inline-flex h-10 items-center rounded-pill bg-yang px-5 text-[14px] font-bold text-on-accent hover:bg-yang-light">Ask Arta in public</Link>}
          />
        )}
      </section>
    </main>
  );
}
