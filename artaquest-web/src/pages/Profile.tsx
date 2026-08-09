/**
 * Public member profile (social-feed pivot, 2026-07-13) — /u/:slug.
 *
 * Reads like an X profile: an identity header (avatar, name, follower counts, a follow
 * button), a stats strip over the member's published posts, then the posts themselves —
 * every one a reproducible notebook — as a card grid with a keyset "Load more".
 * The legacy course/certificate fields the profile endpoint still returns are ignored.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { listNotebooks, normalizeNbKind, type NbKind, type NotebookCard } from "../lib/api";
import { NB_KIND_META, NbCard } from "../components/nbview";
import { BlueCheck } from "../components/BlueCheck";
import { Avatar, Button, EmptyState, HeartGlyph, Input, LoadMoreButton, Pill, StatusNote, cx } from "../components/ui";
import {
  currentUser, fmtBirthday, followUser, getFollows, getProfile, isLoggedIn, lastSeenLabel, localePath, PROFILE_LINKS, relAgo,
  type FollowRow, type Profile as ProfileData,
} from "../lib/wp";
import { Points } from "../lib/currency";
import { sendCoins } from "../lib/api";

/** The feed API filters by author (GET /notebooks?author=<slug>); the shared params type
 *  doesn't declare `author` yet, so widen it locally rather than touching api.ts (other
 *  agents are editing that file in parallel). */
type AuthorParams = Parameters<typeof listNotebooks>[0] & { author: string };
const listByAuthor = (author: string, cursor?: number) =>
  listNotebooks({ author, ...(cursor ? { cursor } : {}) } as AuthorParams);

// ── little pieces ─────────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-[22px] font-bold leading-none text-ink tabular-nums">{value}</span>
      <span className="mt-1 text-[12.5px] text-ink-3">{label}</span>
    </div>
  );
}

/** Header placeholder while the profile payload loads — holds the layout, no jumps. */
function HeaderSkeleton() {
  return (
    <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center" aria-hidden>
      <div className="h-24 w-24 shrink-0 animate-pulse rounded-full bg-veil/[0.08]" />
      <div className="flex-1">
        <div className="h-6 w-48 animate-pulse rounded bg-veil/[0.08]" />
        <div className="mt-3 h-4 w-72 animate-pulse rounded bg-veil/[0.06]" />
        <div className="mt-2 h-4 w-40 animate-pulse rounded bg-veil/[0.06]" />
      </div>
    </div>
  );
}

/** One grid cell's placeholder, shaped like an NbCard (16/10 media + text lines). */
function CardSkeleton() {
  return (
    <li className="list-none overflow-hidden rounded-card border border-line bg-space-2" aria-hidden>
      <div className="aspect-[16/10] animate-pulse bg-veil/[0.06]" />
      <div className="flex flex-col gap-2 p-3">
        <div className="h-3.5 w-4/5 animate-pulse rounded bg-veil/[0.08]" />
        <div className="h-3 w-3/5 animate-pulse rounded bg-veil/[0.06]" />
      </div>
    </li>
  );
}

/** The inline list behind a tapped follower/following count — public member rows,
 *  newest follow first, paged with the standard keyset "Show more". */
function FollowPanel({ slug, dir, count, onClose }: {
  slug: string; dir: "followers" | "following"; count: number; onClose: () => void;
}) {
  const [rows, setRows] = useState<FollowRow[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [more, setMore] = useState(false);

  useEffect(() => {
    let live = true;
    setState("loading"); setRows([]); setNext(null);
    getFollows(slug, dir).then((d) => {
      if (!live) return;
      if (d) { setRows(d.items); setNext(d.next); setState("ready"); } else setState("error");
    });
    return () => { live = false; };
  }, [slug, dir]);

  const loadMore = async () => {
    if (!next || more) return;
    setMore(true);
    const d = await getFollows(slug, dir, next);
    if (d) { setRows((r) => [...r, ...d.items]); setNext(d.next); }
    setMore(false);
  };

  return (
    <section className="rounded-card border border-line bg-space-2 p-4" aria-label={dir === "followers" ? "Followers" : "Following"}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[17px] font-bold tracking-tight">
          {dir === "followers" ? "Followers" : "Following"}{" "}
          <span className="text-[13px] font-semibold tabular-nums text-ink-3">{count.toLocaleString()}</span>
        </h2>
        <button type="button" onClick={onClose} aria-label="Close list"
          className="grid h-8 w-8 place-items-center rounded-full text-[17px] text-ink-3 transition-colors hover:bg-veil/10 hover:text-ink">×</button>
      </div>
      {state === "loading" && <StatusNote className="py-6">Loading…</StatusNote>}
      {state === "error" && <StatusNote error className="py-6">Couldn't load this list — please try again.</StatusNote>}
      {state === "ready" && rows.length === 0 && (
        <StatusNote className="py-6">{dir === "followers" ? "No followers yet." : "Not following anyone yet."}</StatusNote>
      )}
      <ul className="mt-1 grid list-none grid-cols-1 gap-x-4 sm:grid-cols-2">
        {rows.map((r, i) => {
          const body = (
            <>
              <Avatar src={r.avatar} name={r.name} className="h-10 w-10 text-[15px]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-ink">{r.name}</span>
                {r.at > 0 && <span className="block text-[12px] text-ink-3">Followed {relAgo(r.at)}</span>}
              </span>
            </>
          );
          return (
            <li key={`${r.slug || "gone"}-${r.at}-${i}`}>
              {r.slug ? (
                <a href={localePath(`/u/${r.slug}/`)} className="flex items-center gap-3 rounded-card px-2 py-2 transition-colors hover:bg-veil/5">{body}</a>
              ) : (
                /* Deleted account — the follow row persists but there is no profile to open. */
                <span className="flex items-center gap-3 px-2 py-2 opacity-70">{body}</span>
              )}
            </li>
          );
        })}
      </ul>
      {next != null && <LoadMoreButton onClick={loadMore} loading={more} label="Show more" />}
    </section>
  );
}

// ── the page ──────────────────────────────────────────────────────────────────

/**
 * Send coins to this member.
 *
 * Deliberately a disclosure on the profile rather than a page of its own: you send coins to a
 * PERSON, and this is where you are looking at one — their name, their work, their handle. A
 * separate transfer screen would ask you to type a handle you just navigated away from, which is
 * both more work and the step where money goes to the wrong stranger.
 *
 * The nonce is minted per ATTEMPT and kept until that attempt resolves, so the retry after a
 * dropped response carries the same one and the server returns the original transfer instead of
 * sending twice. It is regenerated only once a send has succeeded.
 */
function SendCoins({ slug, name, onSent }: { slug: string; name: string; onSent: (balance: number) => void }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [done, setDone] = useState(false);
  const nonce = useRef<string>("");

  const n = Math.floor(Number(amount));
  const valid = Number.isFinite(n) && n >= 1;

  async function send() {
    if (!valid || busy) return;
    // One nonce per attempt: minted on the first try and REUSED by any retry of the same attempt.
    if (!nonce.current) nonce.current = (crypto.randomUUID?.() || String(Date.now()) + Math.random().toString(36).slice(2));
    setBusy(true);
    setMsg("");
    try {
      const r = await sendCoins(slug, n, nonce.current, note.trim() || undefined);
      nonce.current = ""; // this attempt is settled; a further send is a new one
      setDone(true);
      setMsg(r.code === "already" ? `Already sent to ${name}` : `Sent ₳${r.amount} to ${name}`);
      onSent(r.balance);
      setAmount("");
      setNote("");
    } catch (e) {
      // The server's own words — "Not enough coins for that", "The most you can send at once is
      // ₳5000" — are the useful ones. The nonce is KEPT so a retry is the same attempt.
      setMsg(e instanceof Error && e.message ? e.message : "Could not send — try again");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" onClick={() => { setOpen(true); setDone(false); setMsg(""); }}
        className="h-10 px-5 text-[14px]" title={`Send coins to ${name}`}>
        Send coins
      </Button>
    );
  }
  return (
    <div className="w-full rounded-card border border-line bg-space-1 p-3 sm:w-[320px]">
      <p className="text-[13px] font-semibold text-ink">Send coins to {name}</p>
      <div className="mt-2 flex gap-2">
        <Input value={amount} onChange={(e) => { setAmount(e.target.value.replace(/[^0-9]/g, "")); setDone(false); }}
          inputMode="numeric" placeholder="₳ amount" aria-label="Amount in coins" className="bg-space-2 px-3" />
        <Button type="button" onClick={send} disabled={!valid || busy}
          className="h-10 shrink-0 px-4 text-[14px] disabled:opacity-40">{busy ? "Sending…" : "Send"}</Button>
      </div>
      <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={160} placeholder="Note (optional)"
        aria-label="Note to include" className="mt-2 bg-space-2 px-3" />
      {msg && (
        <p role="status" className={`mt-2 text-[12.5px] ${done ? "text-yang" : "text-rose-300"}`}>{msg}</p>
      )}
      <button type="button" onClick={() => { setOpen(false); setMsg(""); }}
        className="mt-2 text-[12.5px] font-semibold text-ink-3 transition-colors hover:text-yang">Close</button>
    </div>
  );
}

export default function Profile() {
  const { slug = "" } = useParams();
  const [p, setP] = useState<ProfileData | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    setP(null); setMissing(false);
    getProfile(slug).then((d) => { if (d) setP(d); else setMissing(true); }).catch(() => setMissing(true));
  }, [slug]);
  // Dynamic-route title (RouteTitle skips /u/:slug so this owns it).
  useEffect(() => { if (p?.name) document.title = `${p.name} – ArtaQuest`; }, [p?.name]);

  // The member's published posts — newest first, keyset "Load more".
  const [items, setItems] = useState<NotebookCard[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [postsState, setPostsState] = useState<"loading" | "ready" | "error">("loading");
  const [more, setMore] = useState(false);
  const seq = useRef(0); // ignore stale responses after a slug change
  const load = useCallback((cursor?: number) => {
    const mine = ++seq.current;
    if (!cursor) { setPostsState("loading"); setItems([]); setNext(null); } else setMore(true);
    listByAuthor(slug, cursor)
      .then((pg) => {
        if (mine !== seq.current) return;
        setItems((prev) => (cursor ? [...prev, ...pg.items] : pg.items));
        setNext(pg.next);
        setPostsState("ready");
      })
      .catch(() => { if (mine === seq.current && !cursor) setPostsState("error"); })
      .finally(() => { if (mine === seq.current) setMore(false); });
  }, [slug]);
  useEffect(() => { if (slug) load(); }, [slug, load]);

  // Follow state — optimistic toggle, settled by the profile payload.
  const [following, setFollowing] = useState(false);
  const [followers, setFollowers] = useState(0);
  const [followBusy, setFollowBusy] = useState(false);
  useEffect(() => { if (p) { setFollowing(!!p.isFollowing); setFollowers(p.stats?.followers ?? 0); } }, [p]);
  const [listDir, setListDir] = useState<"followers" | "following" | null>(null);
  useEffect(() => setListDir(null), [slug]); // navigating to a member from the list closes it

  if (missing) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-10">
        <EmptyState title="No public profile" body={`There is no member at “${slug}”. They may have changed their handle or deleted their account.`} />
      </main>
    );
  }

  const isOwn = !!slug && currentUser()?.slug === slug;
  const toggleFollow = async () => {
    if (!p || followBusy) return;
    setFollowBusy(true);
    const on = !following;
    setFollowing(on); setFollowers((n) => Math.max(0, n + (on ? 1 : -1))); // optimistic
    try { await followUser(p.id, on); }
    catch { setFollowing(!on); setFollowers((n) => Math.max(0, n + (on ? -1 : 1))); } // revert
    finally { setFollowBusy(false); }
  };
  const loginHref = typeof window !== "undefined"
    ? `${localePath("/login/")}?redirect_to=${encodeURIComponent(window.location.pathname)}`
    : localePath("/login/");

  // Stats over the loaded pages. When more pages remain the hearts figure is a floor,
  // so it's labelled as covering recent posts only.
  const partial = next != null;
  const heartsTotal = items.reduce((n, nb) => n + nb.hearts, 0);
  const kindCounts = items.reduce<Partial<Record<NbKind, number>>>((m, nb) => {
    m[nb.kind] = (m[nb.kind] ?? 0) + 1; return m;
  }, {});
  const kinds = (Object.keys(kindCounts) as NbKind[]).sort((a, b) => (kindCounts[b] ?? 0) - (kindCounts[a] ?? 0));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6">
      {/* ── Identity header ── */}
      {!p ? <HeaderSkeleton /> : (
        <header className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          {/* The avatar carries the verified-nationality flag and the opt-in palm flip — both
              already on the wire, neither previously passed through. */}
          {/* priority: this is above the fold and is normally the profile page's LCP element —
              lazy-loading it made the browser wait for layout before even starting the request. */}
          <Avatar priority src={p.avatar} name={p.name} country={p.country} palm={p.palm || undefined}
            className="h-24 w-24 shrink-0 text-2xl ring-2 ring-line" />
          <div className="min-w-0 flex-1">
            {/* THE REAL NAME IS THE HEADING. `p.name` is display_name — the handle a member is
                addressed by, and on this platform frequently not a name at all ("Arash" for Arash
                Ashrafnejad, "Eceergun10" for Ece Ergün). full_name is what the identity gate
                collected and what the page's title, description and Person schema now say, so the
                visible heading agreeing with them is both the honest label and the one a visitor
                arriving from a name search expects to see. Falls back when a member has no full
                name on record. */}
            <h1 className="flex items-center gap-2 text-[28px] font-extrabold leading-tight tracking-tight">
              <span className="truncate">{p.fullName?.trim() || p.name}</span>
              {p.verified && <BlueCheck size={20} className="shrink-0" />}
            </h1>
            {/* THE HANDLE, which the profile never showed. It is how you are addressed here and the
                only thing /messages/?with= accepts, so "what is this person's handle" was a question
                their own profile could not answer. Shown whenever it adds something the heading has
                not already said. */}
            {(p.fullName?.trim() && p.fullName.trim() !== p.name ? p.name : p.slug) && (
              <p className="mt-0.5 truncate text-[14px] text-ink-3">
                @{p.slug}
                {p.fullName?.trim() && p.fullName.trim() !== p.name && p.name !== p.slug && (
                  <span className="text-ink-3"> · goes by {p.name}</span>
                )}
              </p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-ink-3">
              {p.tier && <Pill className="px-3 py-0.5 text-[13px]">{p.tier}</Pill>}
              <span className="inline-flex items-center gap-1 rounded-pill bg-yang/15 px-3 py-0.5 font-semibold text-yang" title="Lifetime points">
                <Points n={p.points} /> points
              </span>
              {p.joined && <span>Joined {p.joined}</span>}
              {/* Last seen, to the DAY — the server never records finer, because this database is
                  published and an exact activity log for every member is not something anybody
                  asked to publish. lastSeenLabel says only what that granularity supports; relAgo
                  would render the same value as "9h ago" and invent precision. Omitted entirely
                  when never recorded, rather than printed as "never". */}
              {p.lastSeen ? <span>{lastSeenLabel(p.lastSeen)}</span> : null}
            </div>
            {/* Public identity facts. Every member states an exact date of birth when they join,
                and ArtaQuest is radically transparent — the whole database is public — so the
                birthday is shown here rather than hidden behind a table nobody reads. */}
            {(() => {
              // The DATE only — no derived age (operator 2026-07-27). Anyone who wants the number
              // can do the subtraction; printing it turns a fact the member stated into a label
              // the site puts on them, and it re-renders differently every birthday.
              const born = fmtBirthday(p.birthday);
              if (!born) return null;
              return (
                <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-3">
                  <span className="inline-flex items-center gap-1.5">
                    {/* birthday-cake glyph, currentColor — no third accent */}
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M4 20h16v-6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2Zm0-3h16" />
                      <path d="M12 12V8m0-4v1.5M8 12V9m8 3V9" />
                    </svg>
                    <span className="text-ink-2">Born {born}</span>
                  </span>
                </p>
              );
            })()}
            <div className="mt-1.5 text-[13.5px] text-ink-3">
              {/* Each count is a live control: tap it to open the respective list below. */}
              <button type="button" onClick={() => setListDir((d) => (d === "followers" ? null : "followers"))}
                aria-expanded={listDir === "followers"} title="Show the followers list"
                className="group -my-2 py-2 transition-colors hover:text-yang">
                <b className="text-ink-2 tabular-nums transition-colors group-hover:text-yang">{followers.toLocaleString()}</b> follower{followers === 1 ? "" : "s"}
              </button>
              {" · "}
              <button type="button" onClick={() => setListDir((d) => (d === "following" ? null : "following"))}
                aria-expanded={listDir === "following"} title="Show the following list"
                className="group -my-2 py-2 transition-colors hover:text-yang">
                <b className="text-ink-2 tabular-nums transition-colors group-hover:text-yang">{(p.stats?.following ?? 0).toLocaleString()}</b> following
              </button>
            </div>
            {p.bio && <p className="mt-2.5 max-w-2xl text-[14.5px] leading-relaxed text-ink-2">{p.bio}</p>}
            {/* WHERE ELSE THEY ARE. Text, not brand logos: seven third-party marks would be seven
                trademarks to keep current and the only place on this site with colours outside the
                two. Every href was host-checked server-side (AQ\Auth::LINKS) before it was stored.
                rel: "me" states this is the same person — the claim the sameAs schema makes, in the
                markup a human-readable indexer reads; "nofollow ugc" because these are member-supplied
                and there must be no ranking to farm by putting a link here. */}
            {p.links && Object.keys(p.links).length > 0 && (
              <ul className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {PROFILE_LINKS.filter(([k]) => p.links?.[k]).map(([k, label]) => (
                  <li key={k}>
                    <a href={p.links![k]} target="_blank" rel="me nofollow ugc noopener noreferrer"
                      title={p.links![k]}
                      className="inline-flex items-center gap-1 rounded-pill border border-line px-3 py-1 text-[13px] text-ink-2 transition-colors hover:border-yin-light hover:text-yin-light">
                      {label}
                      {/* external-link glyph, currentColor — no third accent */}
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
                        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M7 17 17 7M9 7h8v8" />
                      </svg>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {isOwn ? (
            <a href={localePath("/user-account/?settings=1")} className="shrink-0 text-[13.5px] font-semibold text-ink-3 transition-colors hover:text-yang sm:ml-auto">
              Edit profile →
            </a>
          ) : isLoggedIn() ? (
            /* Follow + Message. Until now the ONLY way to open a conversation was typing a
               member's exact @handle into the ArtaChat sidebar — this is the entry point the
               /messages/?with= deep link was always built for. */
            <div className="flex shrink-0 gap-2 sm:ml-auto">
              <Button type="button" onClick={toggleFollow} disabled={followBusy}
                variant={following ? "outline" : "primaryYin"}
                className="h-10 px-6 text-[14px] disabled:opacity-60">
                {following ? "Following" : "Follow"}
              </Button>
              <Button href={localePath(`/messages/?with=${encodeURIComponent(p.slug)}`)} variant="outline"
                className="h-10 px-5 text-[14px]" title="Send an encrypted message">
                Message
              </Button>
              <SendCoins slug={p.slug} name={p.fullName?.trim() || p.name} onSent={() => undefined} />
            </div>
          ) : (
            <Button href={loginHref} variant="primaryYin" className="h-10 shrink-0 px-6 text-[14px] sm:ml-auto">Follow</Button>
          )}
        </header>
      )}

      {/* ── Follower / following list (inline, opened from the counts above) ── */}
      {p && listDir && (
        <FollowPanel slug={p.slug} dir={listDir}
          count={listDir === "followers" ? followers : p.stats?.following ?? 0}
          onClose={() => setListDir(null)} />
      )}

      {/* ── Stats over their posts ── */}
      <section className="grid grid-cols-2 gap-4 rounded-card border border-line bg-space-2 px-5 py-4" aria-label="Post stats">
        {postsState === "loading" ? (
          <div className="col-span-2 h-10 animate-pulse rounded bg-veil/[0.06]" aria-hidden />
        ) : (
          <>
            <Stat label="posts" value={partial ? `${items.length.toLocaleString()}+` : items.length.toLocaleString()} />
            <Stat label={partial ? "hearts on recent posts" : "hearts"}
              value={<span className="inline-flex items-center gap-1.5 text-yang-ink"><HeartGlyph size={15} /> <span className="text-ink">{heartsTotal.toLocaleString()}</span></span>} />
          </>
        )}
      </section>

      {/* ── The posts ── */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[19px] font-bold tracking-tight">Posts</h2>
          {/* What they make, at a glance — one chip per kind across the loaded posts. */}
          {kinds.map((k) => (
            <Pill key={k} className={cx("px-2.5 py-0.5 text-[12px]", "text-ink-2")}>
              {(kindCounts[k] === 1 ? NB_KIND_META[normalizeNbKind(k)]?.label || k : NB_KIND_META[normalizeNbKind(k)]?.plural || k)} · {kindCounts[k]}
            </Pill>
          ))}
        </div>
        {postsState === "loading" ? (
          <ul className="grid list-none grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4" aria-hidden>
            {Array.from({ length: 8 }, (_, i) => <CardSkeleton key={i} />)}
          </ul>
        ) : postsState === "error" ? (
          <StatusNote error>Couldn't load these posts — please refresh and try again.</StatusNote>
        ) : items.length ? (
          <>
            <ul className="grid list-none grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
              {items.map((nb) => <NbCard key={nb.id} nb={nb} />)}
            </ul>
            {next != null && <LoadMoreButton onClick={() => load(next)} loading={more} />}
          </>
        ) : (
          <EmptyState
            title="No posts yet"
            body={isOwn
              ? "Publish your first notebook from the Studio — every post here proves itself by running offline, start to finish."
              : `${p?.name || "This member"} hasn't published a post yet — every post is a reproducible notebook, so the first one takes a little longer.`}
            action={isOwn ? <Button href={localePath("/studio")}>Create a post</Button> : undefined}
          />
        )}
      </section>
    </main>
  );
}
