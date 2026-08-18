/**
 * The Feed (social-feed pivot, 2026-07-13) — the whole platform's front surface.
 *
 * ArtaQuest reads like X: one fast, calm timeline of recent posts, newest first — except every
 * post carries work anyone can run again: a public Kaggle notebook that has been run, whose
 * reproducibility checklist is public on the work. Posts may also carry Library attachments —
 * published files from ANY member's work, re-used with their provenance attached.
 * Hearts pick the podium that wins a challenge pool when it closes. UX priorities: instant optimistic hearts, infinite scroll with
 * no pagination buttons, a sticky filter bar, skeletons that hold layout, whole-card tap targets.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { watchMath } from "../lib/math";
import { Link, useNavigate } from "react-router-dom";
import {
  createPost, deletePost, editPost, heartNotebook, heartPost, listPosts,
  myNotebooks, liteRunUrl,
  type Challenge, type FeedPostT, type LibraryItem,
  type NbKind, type NotebookCard,
  normalizeNbKind,
} from "../lib/api";
import { NB_KIND_META, teaserSrc, TeaserVideo, useAqTheme, useCalmFlag } from "../components/nbview";
import { LibraryMedia, LibraryPicker } from "../components/library";

import { PostThread } from "./NotebookPage";
import { ConfirmDialog, Avatar, Button, cx, EmptyState, HeartGlyph } from "../components/ui";
import { RailPortal } from "../components/RightRail";
import { ChallengesCard, HappeningCard, NewsCard, TodaysNewsCard, WhoToFollowCard } from "../components/RailCards";
import { useRail } from "../lib/rail";
import { nameClass, closesIn, fmtCount, timeAgo } from "../lib/fmt";
import { isLoggedIn } from "../lib/auth";
// localePath: a programmatic redirect is NOT intercepted by AppShell's locale safety net (that only
// rewrites clicks on real <a> elements), so a signed-out reader on /fa/ was dropped on the English
// login and lost their language mid-flow.
import { currentUser, localePath } from "../lib/wp";

// ── little helpers ───────────────────────────────────────────────────────────



// ── one post ─────────────────────────────────────────────────────────────────


/** Height-limits a post's content: anything taller than CAP collapses behind a fade + Show more. */
const CAP = 560;
function Collapse({ children }: { children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const check = () => setOver(el.scrollHeight > CAP + 60);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="relative">
      <div ref={box} style={!open && over ? { maxHeight: CAP, overflow: "hidden" } : undefined}>{children}</div>
      {over && !open ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-space-1 to-transparent" aria-hidden />
      ) : null}
      {over ? (
        <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(!open); }} aria-expanded={open}
          className="relative mt-1 text-[13px] font-semibold text-yin-ink hover:underline">
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

/* Library attachments (2026-07-28). Any member may attach any published Library item to their own
   post — ownership is deliberately not required, so provenance has to travel WITH the item: every
   attachment names the work it came from and who made it. Sliced defensively: the server caps
   attachments at MEDIA_MAX, and the layouts below only describe 1-4. */
const MEDIA_MAX = 4;
function mediaOf(p: FeedPostT | null | undefined): LibraryItem[] {
  return Array.isArray(p?.media) ? p.media.slice(0, MEDIA_MAX) : [];
}

/** 1–4 attachments under a post body, then one quiet provenance line each. Calm on purpose: no
 *  prices, no "use this", no counts — just the work, its author, and a way back to both. */
function PostMedia({ items }: { items: LibraryItem[] }) {
  if (!items.length) return null;
  const one = items.length === 1;
  return (
    <div className="mt-2">
      <ul className={cx("grid gap-1.5", one ? "grid-cols-1" : "grid-cols-2")}>
        {items.map((it, i) => {
          const wide = one || (items.length === 3 && i === 2); // the odd third tile runs the full width
          // AUDIO IS NOT A PICTURE. A track is a transport bar a few rems tall, so an aspect box
          // either stranded it in the middle of a square of empty space or squashed it — now that it
          // renders a real player with a spectrum, it takes the full width and its own height.
          const audio = it.class === "audio";
          return (
            <li key={it.id} className={cx("overflow-hidden rounded-2xl border border-line bg-space-2", audio ? "col-span-full" : wide && !one && "col-span-2")}>
              {audio ? (
                <LibraryMedia item={it} className="w-full" />
              ) : (
                <span className={cx("block w-full", wide ? "aspect-[16/9]" : "aspect-square")}>
                  <LibraryMedia item={it} className="h-full w-full" />
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <ul className="mt-1.5 flex flex-col gap-0.5">
        {items.map((it) => (it.work ? (
          <li key={it.id} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12px] text-ink-3">
            {one ? null : <span data-ay-skip="1" className="max-w-[9rem] shrink-0 truncate">{it.label}</span>}
            <Link to={`/nb/${it.work.id}/${it.work.slug}`} onClick={(e) => e.stopPropagation()}
              className="min-w-0 max-w-full truncate font-semibold text-ink-2 hover:underline">
              <span data-ay-skip="1">{it.work.title}</span>
            </Link>
            <span>from</span>
            <Link to={`/u/${it.work.author.slug}`} onClick={(e) => e.stopPropagation()} className="min-w-0 max-w-full break-words hover:underline">
              <span data-ay-skip="1">{it.work.author.name}</span>
            </Link>
          </li>
        ) : null))}
      </ul>
    </div>
  );
}

function NbBlock({ nb, compact }: { nb: NotebookCard; compact?: boolean }) {
  const nav = useNavigate();
  const meta = NB_KIND_META[normalizeNbKind(nb.kind)];
  const theme = useAqTheme();
  const flagged = useCalmFlag(nb); // Motion-calm gate: flagged videos never autoplay
  const teaser = teaserSrc(nb, theme);
  const [teaserOk, setTeaserOk] = useState(true); // VP9-alpha unsupported / file gone → legacy thumb
  return (
    <div
      role="link" tabIndex={0} aria-label={nb.title}
      onClick={(e) => { e.stopPropagation(); nav(`/nb/${nb.id}/${nb.slug}`); }}
      onKeyDown={(e) => { if (e.key === "Enter") nav(`/nb/${nb.id}/${nb.slug}`); }}
      className="mt-2 cursor-pointer rounded-2xl border border-line p-3 transition-colors hover:border-yin-ink"
    >
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-ink-3">
        <span>{meta?.label || nb.kind}</span>
        {nb.doi_link ? <span className="rounded-pill border border-line px-1.5">DOI</span> : null}
        {nb.calm < 100 ? <span className="rounded-pill border border-line px-1.5" title="Measured change rate — higher is calmer">Calm {nb.calm}/100</span> : null}
      </div>
      <h2 className="mt-0.5 text-[15px] font-semibold leading-snug text-ink">{nb.title}</h2>

      {!compact && nb.abstract ? <p className="mt-1 line-clamp-3 text-sm leading-relaxed text-ink-2">{nb.abstract}</p> : null}
      {/* THE uniform feed hero: the standard teaser pair (alpha, transparent background — blends
          with the adaptive global background), the active theme's variant. Same element for every
          kind; the interactive deliverable lives on the notebook page. Legacy thumb only as
          fallback. Keyed on src so a theme flip swaps the variant cleanly. */}
      {!compact && teaser && teaserOk ? (
        <span className="mt-2 block aspect-[16/9] w-full">
          <TeaserVideo src={teaser} poster={nb.thumb || undefined} flagged={flagged} onError={() => setTeaserOk(false)}
            className={"h-full w-full object-contain" + (flagged ? "" : " pointer-events-none")} />
        </span>
      ) : !compact && nb.thumb ? (
        <img src={nb.thumb} alt="" loading="lazy" className="mt-2 aspect-[16/9] w-full rounded-xl border border-line object-cover" />
      ) : !compact && nb.hero ? (
        /* THE WORK ITSELF. teaser/thumb were written by the retired execution relay, so without
           this every Kaggle-era publication landed in the timeline as a grey box bearing its own
           kind's name — a member's first work looking broken while its artifact sat on our CDN. */
        nb.hero.class === "audio" ? (
          /* A track brings its own surface (the player) — no outer panel to nest it in. */
          <div className="mt-2"><LibraryMedia item={nb.hero} className="w-full" /></div>
        ) : (
          <div className="mt-2 aspect-[16/9] overflow-hidden rounded-xl border border-line bg-space-2">
            <LibraryMedia item={nb.hero} className="h-full w-full" />
          </div>
        )
      ) : !compact ? (
        /* Last resort — a work with no serveable file still keeps a visual, not a bare text card. */
        <div className="mt-2 grid aspect-[16/9] w-full place-items-center rounded-xl border border-line bg-space-2 text-xs uppercase tracking-widest text-ink-3">
          {meta?.label || nb.kind}
        </div>
      ) : null}
      {!compact ? <NbContinue /> : null}
    </div>
  );
}

/**
 * The way in. The block has always navigated on click, but nothing SAID so — a hover border is
 * not an invitation, and on a phone there is no hover at all, so the whole affordance simply did
 * not exist for most readers.
 *
 * Deliberately NOT a button or a link: the block around it is already `role="link"`, and nesting
 * an interactive element inside one is invalid and gives a screen reader two targets for one
 * destination. This is a painted affordance — `aria-hidden`, because the block's own aria-label
 * already names where it goes — and the click it appears to invite is handled by the block.
 *
 * Gold, and not by default: gold is the platform's *why*, and "why does this work" is exactly what
 * is on the other side of it. Blue stays the hover accent, as everywhere else.
 *
 * The breathing is a BREATH, not a flash — one slow cycle every 2.6s, opacity only, over a few per
 * cent of the card. It stops on hover (you have arrived; stop asking), and it stops entirely under
 * `prefers-reduced-motion` or the reader's Motion-calm setting. A feed is meant to be calm, so this
 * is the smallest cue that reads as "there is more here" without nagging.
 */
function NbContinue() {
  return (
    <span aria-hidden className="mt-2.5 flex items-center">
      <span className="aq-continue inline-flex items-center gap-1.5 rounded-pill border border-yang/40 bg-yang/[0.10] px-3 py-1.5
                       text-[13px] font-semibold text-yang transition-colors">
        See how it works
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2"
          strokeLinecap="round" strokeLinejoin="round" className="aq-continue-arrow">
          <path d="M5 12h13M12.5 6l6 6-6 6" />
        </svg>
      </span>
    </span>
  );
}

/** X's "⋯" corner menu on your own posts — Edit/Delete used to sit inline in the action row,
 *  which no other feed does; X users reach for the corner. Dependency-free popover: a fixed
 *  full-screen catch layer closes it on any outside tap. */
function OwnMenu({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const item = "px-4 py-2.5 text-start text-[14px] font-semibold text-ink transition-colors hover:bg-veil/[0.06]";
  return (
    <span className="relative ms-auto shrink-0">
      <button type="button" aria-label="More options" aria-haspopup="menu" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="-my-1.5 grid h-8 w-8 place-items-center rounded-full text-ink-3 transition-colors hover:bg-veil/[0.06] hover:text-ink">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden>
          <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
        </svg>
      </button>
      {open ? (
        <>
          <span className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); setOpen(false); }} aria-hidden />
          <span role="menu" className="absolute end-0 top-8 z-20 flex w-40 flex-col overflow-hidden rounded-xl border border-line bg-space-1 py-1 shadow-lg shadow-black/40">
            <button type="button" role="menuitem" className={item}
              onClick={(e) => { e.stopPropagation(); setOpen(false); onEdit(); }}>Edit</button>
            <button type="button" role="menuitem" className={item}
              onClick={(e) => { e.stopPropagation(); setOpen(false); onDelete(); }}>Delete</button>
          </span>
        </>
      ) : null}
    </span>
  );
}

function FeedPost({ post, onDeleted, hearted }: { post: FeedPostT; onDeleted?: (id: number) => void; hearted?: boolean }) {
  const nb = post.nb;
  const me = currentUser();
  const own = !!me?.slug && me.slug === post.author.slug;
  const [body, setBody] = useState(post.body);
  const [editing, setEditing] = useState(false);
  // The post's own confirmation, in our surface rather than the browser's (ui.tsx ConfirmDialog).
  // No typed word here: a post is one sentence and deleting it is not a DOI-bearing act — the guard
  // is the second deliberate click, not a spelling test.
  const [askDelete, setAskDelete] = useState(false);
  const [draft, setDraft] = useState(post.body);
  // Save and Delete used to have no .catch at all: a stale nonce, a rate limit or an offline moment
  // rejected silently, the button looked like it had done nothing, and a member retyping the same
  // edit hit the same wall. A write that fails has to say so.
  const [writeErr, setWriteErr] = useState("");
  const [hearts, setHearts] = useState(nb ? nb.hearts : post.hearts);
  const [mine, setMine] = useState(!!hearted);
  useEffect(() => { setMine(!!hearted); }, [hearted]);
  const [pop, setPop] = useState(false);
  const [talk, setTalk] = useState(false);
  const [reposts, setReposts] = useState(post.reposts);
  const [reposted, setReposted] = useState(false);

  const toggleHeart = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isLoggedIn()) { window.location.href = localePath("/login/"); return; }
    const v = mine ? 0 : 1;
    setMine(!mine); setHearts((h) => h + (v ? 1 : -1));
    if (v) { setPop(true); setTimeout(() => setPop(false), 350); }
    (nb ? heartNotebook(nb.id, v as 0 | 1) : heartPost(post.id, v as 0 | 1))
      .then((r) => setHearts(r.hearts)).catch(() => { setMine(mine); setHearts(nb ? nb.hearts : post.hearts); });
  };
  const doRepost = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isLoggedIn()) { window.location.href = localePath("/login/"); return; }
    if (reposted) return;
    setReposted(true); setReposts((n) => n + 1);
    createPost("", undefined, post.id).catch(() => { setReposted(false); setReposts((n) => n - 1); });
  };

  // KaTeX, attached ONCE. This was an inline `ref={(el) => watchMath(el)}`, which React re-runs on
  // every render and which discarded watchMath's returned disconnect — so every heart tap, edit and
  // repost left ANOTHER MutationObserver watching that post's subtree, in a timeline that never
  // stops growing. Every other caller on the platform already did it this way; the feed, the one
  // surface where it compounds, was the exception.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => watchMath(bodyRef.current, "auto"), []);

  const [burst, setBurst] = useState(false);
  const doubleTap = () => {                       // Instagram muscle memory: double-tap hearts
    if (!mine) toggleHeart({ stopPropagation: () => {} } as React.MouseEvent);
    setBurst(true); setTimeout(() => setBurst(false), 650);
    navigator.vibrate?.(12);
  };
  return (
    <article className="relative px-4 py-4 transition-colors hover:bg-space-2/40" onDoubleClick={doubleTap}>
      {burst ? (
        <span aria-hidden className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
          <span className="animate-ping text-5xl">❤️</span>
        </span>
      ) : null}
      <div className="flex gap-3">
        <Link to={`/u/${post.author.slug}`} className="shrink-0 self-start">
          <Avatar name={post.author.name} src={post.author.avatar} className="h-10 w-10" />
        </Link>
        <div className="min-w-0 flex-1" ref={bodyRef}>
          {/* X's byline: bold name, muted @handle, dot, relative time — then the ⋯ corner menu on
              your own posts. The handle doubles as the profile link's visible address. */}
          <div className="flex items-center gap-1.5 text-sm">
            <Link to={`/u/${post.author.slug}`} className={`font-bold text-ink hover:underline ${nameClass(post.author.name)}`}>{post.author.name}</Link>
            <Link to={`/u/${post.author.slug}`} tabIndex={-1} className="hidden min-w-0 shrink-[2] break-all text-ink-3 sm:block"><bdi dir="ltr" data-ay-skip="1">@{post.author.slug}</bdi></Link>
            <span className="text-ink-3">·</span>
            <time className="shrink-0 text-ink-3" dateTime={new Date(post.created * 1000).toISOString()}>{timeAgo(post.created)}</time>
            {own ? (
              <OwnMenu onEdit={() => setEditing(true)} onDelete={() => setAskDelete(true)} />
            ) : null}
          </div>
          <ConfirmDialog
            open={askDelete}
            danger
            title="Delete this post?"
            confirmLabel="Delete"
            onCancel={() => setAskDelete(false)}
            onConfirm={() => {
              setAskDelete(false);
              setWriteErr("");
              deletePost(post.id)
                .then(() => onDeleted?.(post.id))
                .catch((e) => setWriteErr(e instanceof Error && e.message ? e.message : "Couldn't delete that post."));
            }}
            body={<p>It goes for good, with its attachments, its hearts and any bare reposts of it. Quotes of it stay, and will show the post as unavailable.</p>}
          />
          <Collapse>
            {editing ? (
              <div onClick={(e) => e.stopPropagation()} className="mt-1">
                <textarea value={draft} onChange={(e) => setDraft(e.currentTarget.value)} maxLength={340} rows={3}
                  className="w-full resize-none rounded-xl border border-line bg-space-1 p-2.5 text-[15px] text-ink outline-none focus:border-yin-ink" />
                <div className="mt-1 flex items-center gap-3 text-[12px]">
                  <span className={280 - draft.length < 0 ? "font-bold text-yang" : "text-ink-3"}>{280 - draft.length}</span>
                  <button type="button" className="ml-auto text-ink-3 hover:text-ink" onClick={() => { setEditing(false); setDraft(body); }}>Cancel</button>
                  <button type="button" className="rounded-pill bg-yang px-3 py-1 font-bold text-on-accent disabled:opacity-40"
                    disabled={draft.length > 280}
                    onClick={() => {
                      setWriteErr("");
                      editPost(post.id, draft.trim())
                        .then((r) => { setBody(r.body); setEditing(false); })
                        .catch((e) => setWriteErr(e instanceof Error && e.message ? e.message : "Couldn't save your edit."));
                    }}>Save</button>
                </div>
              </div>
            ) : body ? <p className="mt-0.5 whitespace-pre-wrap text-[15px] leading-relaxed text-ink">{body}</p> : null}
            {writeErr ? (
              <p role="status" className="mt-1 text-[12.5px] text-yang" onClick={(e) => e.stopPropagation()}>{writeErr}</p>
            ) : null}
            <PostMedia items={mediaOf(post)} />
            {nb ? <NbBlock nb={nb} /> : null}
            {post.repost ? (
              <div className="mt-2 rounded-2xl border border-line bg-space-2/40 px-3 py-2.5">
                <p className="flex items-center gap-1.5 text-[13px]">
                  <Avatar name={post.repost.author.name} src={post.repost.author.avatar} className="h-5 w-5 text-[9px]" />
                  <span className="font-bold text-ink">{post.repost.author.name}</span>
                  <span className="text-ink-3">· {timeAgo(post.repost.created)}</span>
                </p>
                {post.repost.body ? <p className="mt-1 whitespace-pre-wrap text-[14px] leading-relaxed text-ink-2">{post.repost.body}</p> : null}
                <PostMedia items={mediaOf(post.repost)} />
                {post.repost.nb ? <NbBlock nb={post.repost.nb} compact /> : null}
              </div>
            ) : null}
          </Collapse>
          {/* X's action row: the icons SPREAD across the card (justify-between up to X's ~425px),
              in X's order — reply · repost · heart · views · run. Counts hug their icons; Edit /
              Delete moved to the ⋯ corner menu above. Quote lives beside repost, X's split. */}
          <div className="mt-2.5 flex max-w-[425px] items-center justify-between gap-x-2 text-[13px] text-ink-3">
            {nb ? (
              <button type="button" onClick={(e) => { e.stopPropagation(); setTalk((v) => !v); }} aria-expanded={talk}
                className={cx("-my-2 -ms-1.5 inline-flex min-h-11 items-center gap-1 rounded-pill px-1.5 py-2 transition-colors", talk ? "text-yin-ink" : "hover:text-yin-ink")} aria-label="Reply">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M21 11.5a8.4 8.4 0 0 1-9.4 8.3L3 21l1.2-3.6A8.4 8.4 0 1 1 21 11.5Z" /></svg>
                {nb.comments > 0 ? nb.comments : ""}
              </button>
            ) : null}
            <span className="inline-flex items-center">
              <button type="button" onClick={doRepost} aria-label="Repost" aria-pressed={reposted}
                className={cx("-my-2 inline-flex min-h-11 items-center gap-1 rounded-pill px-1.5 py-2 transition-colors", reposted ? "text-yang-ink" : "hover:text-yang-ink")}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>
                {reposts > 0 ? reposts : ""}
              </button>
              {/* Same 44px target as its neighbours: this was a bare 12px text run, the one control
                  in the row a thumb could miss. */}
              <button type="button" onClick={(e) => { e.stopPropagation(); quoteIntent?.(post); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                aria-label="Quote" className="-my-2 inline-flex min-h-11 items-center rounded-pill px-1.5 py-2 text-[12px] transition-colors hover:text-yang-ink">Quote</button>
            </span>
            <button type="button" onClick={toggleHeart} aria-pressed={mine} aria-label={mine ? "Remove heart" : "Heart"}
              className={cx("-my-2 inline-flex min-h-11 items-center gap-1 rounded-pill px-1.5 py-2 transition-colors", mine ? "text-yang" : "hover:text-yang")}>
              <span className={cx("inline-flex transition-transform duration-300", pop && "scale-[1.35]")}><HeartGlyph size={16} filled={mine} /></span>
              {hearts > 0 ? hearts : ""}
            </button>
            {nb && nb.views > 0 ? (
              <span className="inline-flex items-center gap-1" title="Views">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M4 20V10M12 20V4M20 20v-7" strokeLinecap="round" /></svg>
                {fmtCount(nb.views)}
              </span>
            ) : null}
            {/* Measured at 48x20 in the rendered feed while every button beside it was 44 tall —
                the last short target in the row. */}
            {nb ? <a href={liteRunUrl(nb.id, nb.slug)} onClick={(e) => e.stopPropagation()} target="_blank" rel="noopener" className="-my-2 -me-1.5 inline-flex min-h-11 items-center rounded-pill px-1.5 py-2 transition-colors hover:text-ink-2" title="Runs in your browser — nothing leaves your device">Run it ↗</a> : null}
          </div>
          {talk && nb ? (
            <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="mt-3 cursor-default rounded-2xl border border-line bg-space-1/60 p-3">
              <PostThread id={nb.id} count={nb.comments} />
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function PostSkeleton() {
  return (
    <div className="flex gap-3 px-4 py-4" aria-hidden>
      <div className="h-10 w-10 animate-pulse rounded-full bg-veil/[0.08]" />
      <div className="flex-1">
        <div className="h-3.5 w-40 animate-pulse rounded bg-veil/[0.08]" />
        <div className="mt-2 h-4 w-4/5 animate-pulse rounded bg-veil/[0.08]" />
        <div className="mt-2 h-3.5 w-3/5 animate-pulse rounded bg-veil/[0.08]" />
        <div className="mt-3 aspect-[16/9] animate-pulse rounded-2xl bg-veil/[0.06]" />
      </div>
    </div>
  );
}

/** The rail's tiny footer, X-style — the page footer sits far below an infinite timeline, so the
 *  essential destinations get a quiet second home that's always on screen. */
/** Phones only: open challenges as a swipeable strip under the composer (the rail is lg+). */
function ChallengesStrip({ items }: { items: Challenge[] | null }) {
  if (!items || !items.length) return null;
  return (
    <div className="border-b border-line px-4 py-3 lg:hidden">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-extrabold tracking-tight">🏆 Challenges</h2>
        <Link to="/challenges" className="text-[13px] font-semibold text-yin-ink hover:underline">Show all</Link>
      </div>
      <div className="[scrollbar-width:none] [&::-webkit-scrollbar]:hidden -mx-4 mt-2 flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-4">
        {items.slice(0, 6).map((c) => (
          <Link key={c.id} to="/challenges" className="min-w-[220px] max-w-[240px] shrink-0 snap-start rounded-2xl border border-line bg-space-2 p-3 transition-colors hover:border-yin-ink">
            <div className="flex items-baseline justify-between gap-2">
              <p className="min-w-0 truncate text-[13.5px] font-bold text-ink">{c.title}</p>
              <span className="shrink-0 text-[14px] font-extrabold text-yang">₳{c.pool}</span>
            </div>
            <p className="mt-0.5 truncate text-[11.5px] text-ink-3">{NB_KIND_META[c.kind]?.label} · closes {closesIn(c.deadline)}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ── the feed ─────────────────────────────────────────────────────────────────

const CHAR_LIMIT = 280; // old-Twitter discipline
let quoteIntent: ((p: FeedPostT) => void) | null = null; // FeedPost → Composer quote channel

function Composer({ onPosted }: { onPosted: (p: FeedPostT) => void }) {
  const nav = useNavigate();
  const me = currentUser();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState<NotebookCard[] | null>(null);
  const [attach, setAttach] = useState<NotebookCard | null>(null);
  const [quote, setQuote] = useState<FeedPostT | null>(null);
  // Library attachments: up to four published files, anyone's, carried with their provenance.
  const [media, setMedia] = useState<LibraryItem[]>([]);
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { quoteIntent = (p) => { setQuote(p); setOpen(true); box.current?.focus(); }; return () => { quoteIntent = null; }; }, []);
  const left = CHAR_LIMIT - text.length;
  const EMOJI = ["😀", "🔬", "📐", "🎉", "🤯", "❤️"];
  // Published works only. The old filter was `score >= 90`; nothing writes a score any more,
  // so it matched nothing and the whole attach-your-own-work feature was silently dead.
  const loadMine = () => { if (mine === null) myNotebooks().then((r) => setMine(r.items.filter((n) => n.status === "published"))).catch(() => setMine([])); };
  // A post with attachments and no words is a real post now — the files are the content.
  const empty = !text.trim() && !attach && !quote && !media.length;
  const post = () => {
    if (empty || left < 0 || busy) return;
    setBusy(true);
    setErr("");
    createPost(text.trim(), attach?.id, quote?.id, media.map((m) => m.id))
      .then((p) => { setText(""); setAttach(null); setQuote(null); setMedia([]); setOpen(false); onPosted(p); })
      // Without this a rejected post simply disappeared: the box emptied, nothing appeared in the
      // timeline, and the member was never told why.
      .catch((e: unknown) => setErr((e as { message?: string })?.message || "That post could not be sent."))
      .finally(() => setBusy(false));
  };
  const addMedia = (picked: LibraryItem[]) => {
    setPicking(false);
    setErr("");
    setMedia((cur) => {
      const out = [...cur];
      let added = 0;
      for (const m of picked) if (!out.some((x) => x.id === m.id)) { out.push(m); added++; }
      // Silence on a no-op reads as a broken picker. Say what happened.
      if (picked.length && added === 0) setErr("Already attached.");
      else if (out.length > MEDIA_MAX) setErr(`Only ${MEDIA_MAX} files can ride on one post.`);
      return out.slice(0, MEDIA_MAX);
    });
  };
  return (
    <div className="border-b border-line px-4 py-3">
      <div className="flex gap-3">
        <Avatar name={me?.name} src={me?.avatar} className="h-10 w-10 shrink-0" />
        <div className="min-w-0 flex-1">
          <textarea ref={box} value={text} onChange={(e) => setText(e.currentTarget.value)} onFocus={() => setOpen(true)}
            rows={open ? 3 : 1} maxLength={CHAR_LIMIT + 60} placeholder={quote ? "Say something about this…" : "What's happening?"}
            aria-label="Compose a post"
            className="w-full resize-none bg-transparent pt-1.5 text-[17px] leading-snug text-ink outline-none placeholder:text-ink-2" />
          {quote ? (
            <div className="mb-2 rounded-xl border border-line bg-space-2/60 px-3 py-2 text-[13px] text-ink-3">
              Quoting <span className="font-semibold text-ink-2">{quote.author.name}</span>: {quote.body || quote.nb?.title}
              <button type="button" onClick={() => setQuote(null)} className="ms-2 text-yin-ink hover:underline">remove</button>
            </div>
          ) : null}
          {attach ? (
            <div className="mb-2 flex items-center gap-2 rounded-xl border border-yin/50 bg-yin/10 px-3 py-2 text-[13px]">
              <span className="truncate text-ink-2">📓 {attach.title}</span>
              <button type="button" onClick={() => setAttach(null)} className="ml-auto text-yin-ink hover:underline">remove</button>
            </div>
          ) : null}
          {/* Chosen Library files — small square thumbs, each removable, above the action row. */}
          {media.length ? (
            <ul className="mb-2 flex flex-wrap gap-2 pt-1">
              {media.map((it) => (
                <li key={it.id} className="relative w-16">
                  <span className="block aspect-square w-16 overflow-hidden rounded-xl border border-line bg-space-2">
                    {/* INERT at 64px: a chip is a receipt for a tick, not a place to run a member's
                        game, mount a PDF viewer or start a ranged fetch — four at a time. */}
                    <LibraryMedia item={it} className="h-full w-full" still />
                  </span>
                  <button type="button" onClick={() => setMedia((cur) => cur.filter((m) => m.id !== it.id))}
                    aria-label="Remove attachment" title="Remove attachment"
                    className="absolute -top-1 end-[-4px] grid h-8 w-8 place-items-center rounded-full border border-line bg-space-1 text-ink-2 transition-colors hover:text-ink">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </button>
                  <span data-ay-skip="1" className="mt-0.5 block w-16 truncate text-[10px] leading-tight text-ink-3">{it.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {open ? (
            <>
              {!attach && !quote ? (
                <details onToggle={loadMine} className="mb-1.5">
                  <summary className="cursor-pointer list-none text-[13px] text-yin-ink hover:underline">📓 Attach one of your notebooks </summary>
                  <div className="mt-1.5 flex flex-col gap-1">
                    {mine === null ? <span className="text-[12px] text-ink-3">Loading…</span>
                      : mine.length ? mine.map((n) => (
                        <button key={n.id} type="button" onClick={() => setAttach(n)}
                          className="truncate rounded-lg border border-line px-2.5 py-1.5 text-start text-[13px] text-ink-2 hover:border-yin-ink">
                          {NB_KIND_META[n.kind]?.label} · {n.title}
                        </button>
                      )) : <span className="text-[12px] text-ink-3">You have no published work yet — <button type="button" className="text-yin-ink hover:underline" onClick={() => nav("/studio")}>publish one in the Studio</button>. Text posts need no attachment.</span>}
                  </div>
                </details>
              ) : null}
              {err !== "" && <p role="alert" className="pb-2 text-[13px] text-yin-ink">{err}</p>}
              <div className="flex items-center gap-1.5 border-t border-line pt-2">
                <button type="button" onClick={() => setPicking(true)} disabled={media.length >= MEDIA_MAX}
                  aria-label="Attach from Library" title="Attach from Library"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-yin-ink transition-colors hover:bg-veil/[0.06] disabled:opacity-40">
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M21.4 11.1 12.2 20.3a5 5 0 0 1-7.1-7.1l9.2-9.2a3.5 3.5 0 0 1 5 5l-9.2 9.2a2 2 0 0 1-2.8-2.9l8.5-8.4" />
                  </svg>
                </button>
                {/* The emoji row is the one droppable thing here: at 360px the paperclip, six
                    glyphs, the counter, the ring and Post do not fit, and Post is what must
                    survive. It returns at 400px. */}
                <span className="hidden min-[400px]:flex min-w-0 items-center gap-1.5 overflow-hidden">
                  {EMOJI.map((e) => (
                    <button key={e} type="button" onClick={() => { setText((t) => t + e); box.current?.focus(); }}
                      aria-label={`Insert ${e}`} className="min-h-6 shrink-0 rounded-md px-1 py-0.5 text-[16px] transition-transform hover:scale-125">{e}</button>
                  ))}
                </span>
                <span aria-live="polite" className={cx("ms-auto shrink-0 text-[12px] tabular-nums",
                  left < 0 ? "font-bold text-yang" : left <= 20 ? "text-yang-ink" : "text-ink-3")}>{left}</span>
                <svg viewBox="0 0 24 24" width="20" height="20" className="hidden shrink-0 -rotate-90 min-[400px]:block" aria-hidden>
                  <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" className="text-veil/15" />
                  <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeDasharray={`${Math.max(0, Math.min(1, text.length / CHAR_LIMIT)) * 56.5} 56.5`}
                    className={left < 0 ? "text-yang" : left <= 20 ? "text-yang-ink" : "text-yin-ink"} />
                </svg>
                <button type="button" onClick={post} disabled={empty || left < 0 || busy}
                  className="shrink-0 rounded-pill bg-yang px-4 py-1.5 text-sm font-bold text-on-accent transition-opacity disabled:opacity-40">
                  {busy ? "Posting…" : "Post"}
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
      <LibraryPicker open={picking} onClose={() => setPicking(false)} onConfirm={addMedia} max={MEDIA_MAX - media.length} />
    </div>
  );
}

/**
 * `embedded` — the landing page shows the real feed as its own proof. That instance must not act
 * like a page: a second `<h1>` and a nested `<main>` inside the shell's own `<main>` are both
 * document-structure errors that screen readers and search engines read literally, and the rail's
 * five backend calls are pure cost on a marketing page.
 */
export default function Feed({ initialKind, embedded = false }: { initialKind?: NbKind; embedded?: boolean }) {
  const nav = useNavigate();
  const [kind, setKind] = useState<NbKind | "">(initialKind || "");
  const rail = useRail(!embedded);
  const [items, setItems] = useState<FeedPostT[]>([]);
  const [hearted, setHearted] = useState<Set<number>>(new Set());
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  // A failed request and an empty feed are different facts and must never render as the same screen —
  // see the load() catch below.
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);


  // A kind shelf has no For-you/Following tabs (its header is ← + title), so entering one drops
  // any lingering "following" filter — otherwise it would keep filtering with no visible control.
  useEffect(() => { setKind(initialKind || ""); }, [initialKind]);

  const load = useCallback((cursor?: number) => {
    const mine = ++seq.current;
    if (!cursor) setLoading(true); else setMore(true);
    if (!cursor) setFailed(false);
    listPosts({ ...(kind ? { kind } : {}), sort: "new", ...(cursor ? { cursor } : {}) })
      .then((p) => {
        if (mine !== seq.current) return;
        setFailed(false);
        setItems((prev) => (cursor ? [...prev, ...p.items] : p.items));
        setNext(p.next);
        setHearted((prev) => {
          const ids = p.mine || [];
          return cursor ? new Set([...prev, ...ids]) : new Set(ids);
        });
      })
      // A FAILED request is not an empty feed. Clearing items and falling through to the empty state
      // told a member "Nothing here yet — publish the first work" when the truth was that the request
      // did not come back: the one screen that makes a reader think the platform is deserted, shown
      // precisely when it is unreachable. Record the failure and let the render say so, with a retry.
      .catch(() => { if (mine === seq.current && !cursor) { setItems([]); setNext(null); setFailed(true); } })
      .finally(() => { if (mine === seq.current) { setLoading(false); setMore(false); } });
  }, [kind]);

  useEffect(() => { load(); }, [load]);

  // Infinite scroll — no buttons, the timeline just continues.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || next == null) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !more) load(next);
    }, { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [next, more, load]);

  const meta = kind ? NB_KIND_META[kind] : null;
  // Where the phone timeline interleaves the rail modules (X puts "What's happening" a few posts
  // down). Clamped so short feeds still get them after the last post (they may stack there).
  const trendsIdx = Math.min(2, items.length - 1);
  const whoIdx = Math.min(12, items.length - 1);

  // Embedded (on the landing page) the column is a labelled region inside the shell's <main>, and
  // "Home" is an ordinary heading — the page above it already owns the document's one <h1>.
  const Col = embedded ? "section" : "main";
  const Title = embedded ? "h2" : "h1";

  return (
    <div className="mx-auto flex w-full max-w-[1076px] justify-center px-0 sm:px-4 lg:gap-7">
      <Col className={cx("w-full min-w-0 max-w-2xl border-line sm:border-x", !isLoggedIn() ? "pb-28" : "pb-16 md:pb-0")}>
        {/* ONE TIMELINE (operator 2026-07-28). The For-you/Following tabs and the eleven-kind chip
            shelf are gone: a feed with almost no posts cannot fill two timelines, and a chip row
            that filters a near-empty list only ever shows a member an empty state they chose. A
            kind shelf still exists as its own route (/music, /datasets…), which is where a filter
            belongs — a destination, not a permanent control eating the top of every phone screen.
            What is left is X's secondary-column header: a title, and a back arrow on a shelf. */}
        {/* Under the bar, not behind it: the full-bleed header is 60px of fixed chrome, so a
            timeline header pinned at top-0 spends its whole life hidden by it (measured: 61px of it,
            i.e. all of it). */}
        <div className="sticky top-topbar z-10 border-b border-line bg-space-1/85 backdrop-blur">
          <div className="flex min-h-[52px] items-center">
            {meta ? (
              <div className="flex min-w-0 flex-1 items-center gap-1 px-2">
                <button type="button" onClick={() => { setKind(""); nav("/works"); }} aria-label="Back to the whole feed"
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-ink transition-colors hover:bg-veil/[0.06]">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5m7-7-7 7 7 7" /></svg>
                </button>
                <h1 className="truncate px-1 text-lg font-extrabold tracking-tight">{meta.plural}</h1>
              </div>
            ) : (
              <Title className="flex min-w-0 flex-1 items-center px-4 text-lg font-extrabold tracking-tight">Home</Title>
            )}
          </div>
        </div>

        {/* Composer teaser */}
        {isLoggedIn() ? (
          <Composer onPosted={(p) => setItems((cur) => [p, ...cur])} />
        ) : (
          <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
            <p className="text-[14px] text-ink-2">Every post proves itself — it is a public Kaggle notebook that ran, from public inputs, and you can run it again yourself.</p>
            <Button href="/login/" size="sm" className="ml-auto shrink-0">Join</Button>
          </div>
        )}

        {/* Phones: the open challenges ride as a swipe strip up top (the rail carries them on lg+) */}
        <ChallengesStrip items={rail.challenges} />

        {/* The timeline. On phones the rail modules interleave a few posts down, X-style. */}
        {loading ? (
          <div className="divide-y divide-line">{Array.from({ length: 5 }, (_, i) => <PostSkeleton key={i} />)}</div>
        ) : items.length ? (
          <>
            <div className="divide-y divide-line">
              {items.map((p, i) => (
                <Fragment key={p.id}>
                  <FeedPost post={p} hearted={hearted.has(p.id)} onDeleted={(id) => setItems((cur) => cur.filter((x) => x.id !== id))} />
                  {/* Phones get the same modules the rail carries on lg+, injected inline — and in the
                      SAME ORDER, which is why the instruments card rides with Who-to-follow down here
                      rather than with the trends block above. "The bottom card" has to mean the same
                      thing on a phone as it does on a desktop. */}
                  {i === trendsIdx ? <div className="flex flex-col gap-3 px-3 py-3 lg:hidden"><TodaysNewsCard items={rail.headlines} /><HappeningCard items={rail.topics} /></div> : null}
                  {i === whoIdx ? <div className="flex flex-col gap-3 px-3 py-3 lg:hidden"><WhoToFollowCard items={rail.who} /><NewsCard items={rail.news} /></div> : null}
                </Fragment>
              ))}
            </div>
            {next != null ? (
              <div ref={sentinel} className="py-6 text-center text-[13px] text-ink-3" aria-hidden>
                {more ? "Loading more…" : ""}
              </div>
            ) : (
              <p className="border-t border-line py-8 text-center text-[13px] text-ink-3">You're all caught up</p>
            )}
          </>
        ) : (
          <div className="px-4 py-10">
            {failed ? (
              <EmptyState
                title="Couldn't load the feed"
                body="The request didn't come back. This is a connection problem, not an empty feed — nothing has been lost."
                action={<Button onClick={() => load()}>Try again</Button>}
              />
            ) : (
              <EmptyState
                title="Nothing here yet"
                body={meta ? `No ${meta.plural.toLowerCase()} have been published yet — the pool is waiting for the first entry.` : "The feed is brand new. Publish the first work."}
                action={isLoggedIn() ? <Button onClick={() => nav("/studio")}>Publish the first one</Button> : <Button href="/login/">Join to publish</Button>}
              />
            )}
            {/* Phones: an empty timeline still gets the discovery modules (the rail carries them on lg+) */}
            <div className="mt-6 flex flex-col gap-4 lg:hidden">
              <TodaysNewsCard items={rail.headlines} />
              <HappeningCard items={rail.topics} />
              <ChallengesCard items={rail.challenges} />
              <WhoToFollowCard items={rail.who} />
              <NewsCard items={rail.news} />
            </div>
          </div>
        )}
      </Col>

      {/* The right rail (lg+), X-style and deliberately short: challenges · what's happening ·
          who to follow · quick links. The price-of-energy card was pulled from the feed (operator
          2026-07-28) — commodity prices are an economy surface, so they belong with the challenges
          they fund, not beside somebody's post. Sticky, and it SCROLLS (each card is shrink-0 so an
          overflowing column scrolls instead of squashing cards). Phones get the same modules
          inline (above). */}
      {/* The feed's cards, in THE right column (RightRail.tsx). `mobile="none"` because a phone
          already gets these same modules interleaved between posts, a few posts down, X-style. */}
      <RailPortal mobile="none">
        <TodaysNewsCard items={rail.headlines} />
        <HappeningCard items={rail.topics} />
        <ChallengesCard items={rail.challenges} />
        <WhoToFollowCard items={rail.who} />
        <NewsCard items={rail.news} />
      </RailPortal>
    </div>
  );
}

