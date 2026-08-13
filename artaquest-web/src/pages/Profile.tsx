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
  currentUser, fmtBirthday, followUser, getFollows, getProfile, isLoggedIn, lastSeenLabel, localePath, PROFILE_LINKS, relAgo, relationshipLabel,
  type FollowRow, type Profile as ProfileData,
} from "../lib/wp";
import { Coins, Points } from "../lib/currency";
import { sendCoins } from "../lib/api";

/** The feed API filters by author (GET /notebooks?author=<slug>); the shared params type
 *  doesn't declare `author` yet, so widen it locally rather than touching api.ts (other
 *  agents are editing that file in parallel). */
type AuthorParams = Parameters<typeof listNotebooks>[0] & { author: string };
const listByAuthor = (author: string, cursor?: number) =>
  listNotebooks({ author, ...(cursor ? { cursor } : {}) } as AuthorParams);

// ── little pieces ─────────────────────────────────────────────────────────────

/**
 * One stated fact in the About grid: a glyph, a quiet label, and the value in reading weight.
 *
 * A LABEL, not a bare icon. The old header ran eight different kinds of fact together in one
 * wrapping line — a status, a city, a list of languages, a birthday, two currencies and two dates —
 * and a reader had to decode each from its glyph. On a page someone is reading to decide whether
 * they want to know this person, that is the whole content of the page, so it gets named rows.
 */
function Fact({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span aria-hidden className="mt-0.5 shrink-0 text-yang">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[11.5px] font-semibold uppercase tracking-wider text-ink-3">{label}</span>
        <span className="mt-0.5 block text-[14.5px] leading-snug text-ink">{children}</span>
      </span>
    </div>
  );
}

const FACT_SVG = { viewBox: "0 0 24 24", width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

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

  // What this member has NOT said yet — used only on their own profile, to turn an empty-looking
  // card into one tap. Order matches the settings form so the prompt reads like a to-do list.
  const missingFacts = !p ? [] : [
    relationshipLabel(p.relationship) ? "" : "Relationship",
    p.location?.trim() ? "" : "Where you live",
    (p.languages?.length ?? 0) > 0 ? "" : "Languages you speak",
  ].filter(Boolean);
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

  /** Shown to a signed-in visitor beside Message, and to a signed-out one beside Follow — the same
   *  element either way, so the two branches cannot drift. Never gated on a session: the booking
   *  page it points at is public on purpose. */
  const bookButton = p ? (
    <Button href={localePath(`/book/${encodeURIComponent(p.slug)}`)} variant="outline"
      className="h-10 px-5 text-[14px]" title="See when they are free and take a time">
      Book a time
    </Button>
  ) : null;

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
        <header className="overflow-hidden rounded-card border border-line bg-space-2">
          {/* THE COVER. Gold on one side, blue on the other, meeting in the middle — the platform's
              own thesis rendered as a band, because gold and blue here are exact additive
              complements that sum to white. No third hue, no photograph to moderate, and it costs
              nothing to load. It is the one element that turns this page from a record into
              somebody's page at a glance. */}
          <div className="relative h-20 w-full sm:h-32" aria-hidden>
            <div className="absolute inset-0 bg-gradient-to-r from-yang/80 via-yang/20 to-yin/80" />
            <div className="absolute inset-0 bg-[radial-gradient(120%_150%_at_18%_-30%,rgba(255,255,255,0.22),transparent_62%)]" />
            <div className="absolute inset-x-0 bottom-0 h-px bg-line" />
          </div>

          <div className="px-4 pb-5 sm:px-6">
            {/* The avatar STRADDLES the cover's edge — the pattern every profile uses, because it
                anchors the eye and makes the portrait the largest thing on the page. The ring is the
                card's own background, so the circle punches cleanly out of the gradient in both
                themes. */}
            <div className="-mt-10 flex flex-col gap-3 sm:-mt-14 sm:flex-row sm:items-end sm:gap-5">
              {/* priority: above the fold and normally this page's LCP element — lazy-loading it
                  made the browser wait for layout before even starting the request. Carries the
                  verified-nationality flag and the opt-in palm flip. */}
              <Avatar priority src={p.avatar} name={p.name} palm={p.palm || undefined}
                className="h-24 w-24 shrink-0 bg-space-2 text-3xl ring-4 ring-space-2 sm:h-32 sm:w-32" />
              <div className="min-w-0 flex-1 sm:pb-1">
                {/* THE REAL NAME IS THE HEADING. `p.name` is display_name — the handle a member is
                    addressed by, and frequently not a name at all ("Arash" for Arash Ashrafnejad).
                    full_name is what the identity gate collected and what the page title, description
                    and Person schema say, so the visible heading agreeing with them is both the
                    honest label and the one a visitor arriving from a name search expects. */}
                <h1 className="flex items-center gap-2 text-[26px] font-extrabold leading-tight tracking-tight sm:text-[30px]">
                  <span className="truncate">{p.fullName?.trim() || p.name}</span>
                  {p.verified && <BlueCheck size={20} className="shrink-0" />}
                </h1>
                {/* THE HANDLE. It is how you are addressed here and the only thing /messages/?with=
                    accepts, so "what is this person's handle" was a question their own profile could
                    not answer. Shown whenever it adds something the heading has not already said. */}
                {(p.fullName?.trim() && p.fullName.trim() !== p.name ? p.name : p.slug) && (
                  <p className="mt-0.5 truncate text-[14px] text-ink-3">
                    @{p.slug}
                    {p.fullName?.trim() && p.fullName.trim() !== p.name && p.name !== p.slug && (
                      <span className="text-ink-3"> · goes by {p.name}</span>
                    )}
                  </p>
                )}
              </div>
              {/* The actions sit WITH the name rather than at the far end of a wide empty row, which
                  is where a 1440px header had been putting them.

                  ONE definition, rendered from two branches. Beside Message it reads as the same act
                  at two speeds — say something now, or take some of their time later — and on its own
                  it is the only thing a signed-out reader can actually do with this person. Written
                  once because the last time it existed in only one branch, that was the bug. The
                  booking page says plainly when somebody is not offering any time, so it never leads
                  anywhere embarrassing. */}
              {isOwn ? (
                <a href={localePath("/user-account/?settings=1")} className="shrink-0 self-start text-[13.5px] font-semibold text-ink-3 transition-colors hover:text-yang sm:self-auto sm:pb-1">
                  Edit profile →
                </a>
              ) : isLoggedIn() ? (
                /* Follow + Message. Until this existed the ONLY way to open a conversation was typing
                   a member's exact @handle into the ArtaChat sidebar — this is the entry point the
                   /messages/?with= deep link was always built for. */
                <div className="flex shrink-0 flex-wrap gap-2 sm:pb-1">
                  <Button type="button" onClick={toggleFollow} disabled={followBusy}
                    variant={following ? "outline" : "primaryYin"}
                    className="h-10 px-6 text-[14px] disabled:opacity-60">
                    {following ? "Following" : "Follow"}
                  </Button>
                  <Button href={localePath(`/messages/?with=${encodeURIComponent(p.slug)}`)} variant="outline"
                    className="h-10 px-5 text-[14px]" title="Send an encrypted message">
                    Message
                  </Button>
                  {bookButton}
                  <SendCoins slug={p.slug} name={p.fullName?.trim() || p.name} onSent={() => undefined} />
                </div>
              ) : (
                /* SIGNED OUT — and a booking link belongs HERE most of all. Every other action on
                   this page needs an account, so they were all correctly behind one, and "Book a
                   time" got swept along with them. It should not have been: book/page and book/slots
                   are deliberately public, the booking page is built to be readable by a stranger,
                   and this profile is the thing a member actually shares. Hiding the link from
                   signed-out visitors meant the one audience it exists for could not see it. */
                <div className="flex shrink-0 flex-wrap gap-2 sm:pb-1">
                  <Button href={loginHref} variant="primaryYin" className="h-10 px-6 text-[14px]">Follow</Button>
                  {bookButton}
                </div>
              )}
            </div>

            {/* THE BIO, directly under the name where it is read. It used to sit below two rows of
                counters and a wall of chips. */}
            {p.bio && <p className="mt-4 max-w-2xl whitespace-pre-wrap text-[15px] leading-relaxed text-ink-2">{p.bio}</p>}

            {/* STANDING + ACTIVITY. Kept as chips and kept together, because they are one category —
                what this member has earned and when they were last around — and deliberately NOT
                mixed in with the stated facts below, which are a different kind of claim entirely. */}
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-ink-3">
              {p.tier && <Pill className="px-3 py-0.5 text-[13px]">{p.tier}</Pill>}
              <span className="inline-flex items-center gap-1 rounded-pill bg-yang/15 px-3 py-0.5 font-semibold text-yang" title="Lifetime points">
                <Points n={p.points} /> points
              </span>
              {/* THE WALLET, in the open. The whole coin ledger is already published — every entry of
                  it is downloadable from /data/ — so a balance was public in fact while being absent
                  from the one page about this member. Blue, because points are gold and the two
                  currencies must never read as one number (points are a lifetime score and are never
                  spent; coins are money and move). */}
              <span className="inline-flex items-center gap-1 rounded-pill bg-yin/15 px-3 py-0.5 font-semibold text-yin-ink"
                title="Coins in their wallet — every entry in the coin ledger is public">
                <Coins n={p.coins ?? 0} />
              </span>
              {p.joined && <span>Joined {p.joined}</span>}
              {/* Last seen, to the DAY — the server never records finer, because this database is
                  published and an exact activity log for every member is not something anybody asked
                  to publish. lastSeenLabel says only what that granularity supports; relAgo would
                  render the same value as "9h ago" and invent precision. */}
              {p.lastSeen ? <span>{lastSeenLabel(p.lastSeen)}</span> : null}
            </div>

            {/* Each count is a live control: tap it to open the respective list below. */}
            <div className="mt-2.5 text-[13.5px] text-ink-3">
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

            {/* WHERE ELSE THEY ARE. Text, not brand logos: seven third-party marks would be seven
                trademarks to keep current and the only place on this site with colours outside the
                two. Every href was host-checked server-side (AQ\Auth::LINKS) before it was stored.
                rel: "me" states this is the same person — the claim the sameAs schema makes, in the
                markup a human-readable indexer reads; "nofollow ugc" because these are member-supplied
                and there must be no ranking to farm by putting a link here. */}
            {p.links && Object.keys(p.links).length > 0 && (
              <ul className="mt-3 flex flex-wrap items-center gap-1.5">
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
        </header>
      )}

      {/* ── Follower / following list (inline, opened from the counts above) ── */}
      {/* ── WHAT THEY SAY ABOUT THEMSELVES ──
          Every value here was typed or picked by this member: nothing is inferred, and nothing is
          derived from an IP address or a header. Rows appear only when there is something to say —
          a member who has filled none of this in gets no card at all, rather than a grid of blanks
          advertising what they declined to answer. */}
      {p && (isOwn || relationshipLabel(p.relationship) || p.location?.trim() || (p.languages?.length ?? 0) > 0 || fmtBirthday(p.birthday)) ? (
        <section className="grid gap-x-8 gap-y-5 rounded-card border border-line bg-space-2 px-5 py-5 sm:grid-cols-2 lg:grid-cols-4" aria-label="About">
          {relationshipLabel(p.relationship) ? (
            <Fact label="Relationship" icon={<svg {...FACT_SVG}><path d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.6-7 9-7 9z" /></svg>}>
              {relationshipLabel(p.relationship)}
            </Fact>
          ) : null}
          {p.location?.trim() ? (
            <Fact label="Lives in" icon={<svg {...FACT_SVG}><path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11z" /><circle cx="12" cy="10" r="2.6" /></svg>}>
              <span data-ay-skip="1">{p.location.trim()}</span>
            </Fact>
          ) : null}
          {(p.languages?.length ?? 0) > 0 ? (
            /* Endonyms, because that is how LanguageSelector names a language and how a speaker
               recognises their own. Each in <bdi dir> with data-ay-skip, or an RTL name (فارسی,
               العربية) reorders the Latin punctuation around it and the translation mesh tries to
               translate a proper noun. */
            <Fact label="Speaks" icon={<svg {...FACT_SVG}><path d="M4 6h10M9 4v2c0 4-2.2 7-5 8" /><path d="M7 11c1.3 2.3 3.3 4 6 5" /><path d="M13 20l4-9 4 9M14.8 17h4.4" /></svg>}>
              <span className="flex flex-wrap gap-x-1.5">
                {p.languages!.map((l, i) => (
                  <span key={l.code}>
                    <bdi dir={l.dir} data-ay-skip="1">{l.native}</bdi>{i < p.languages!.length - 1 ? "," : ""}
                  </span>
                ))}
              </span>
            </Fact>
          ) : null}
          {/* The DATE only — no derived age (operator 2026-07-27). Anyone who wants the number can
              do the subtraction; printing it turns a fact the member stated into a label the site
              puts on them, and it re-renders differently every birthday. */}
          {fmtBirthday(p.birthday) ? (
            <Fact label="Born" icon={<svg {...FACT_SVG}><path d="M4 20h16v-6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2Zm0-3h16" /><path d="M12 12V8m0-4v1.5M8 12V9m8 3V9" /></svg>}>
              {fmtBirthday(p.birthday)}
            </Fact>
          ) : null}
          {/* YOUR OWN profile, and something is unsaid. A card holding one lonely row reads as broken
              rather than as sparse, and the member looking at it is the one person who can fix that —
              so the gaps become an invitation instead of empty space. Shown to NOBODY else: a visitor
              has no business seeing a list of what this person declined to answer. */}
          {isOwn && missingFacts.length > 0 ? (
            <a href={localePath("/user-account/?settings=1")}
              className="group flex min-w-0 items-start gap-2.5 rounded-card border border-dashed border-line px-3 py-2 transition-colors hover:border-yang">
              <span aria-hidden className="mt-0.5 shrink-0 text-ink-3 transition-colors group-hover:text-yang">
                <svg {...FACT_SVG}><path d="M12 5v14M5 12h14" /></svg>
              </span>
              <span className="min-w-0">
                <span className="block text-[11.5px] font-semibold uppercase tracking-wider text-ink-3">Add to your profile</span>
                <span className="mt-0.5 block text-[14px] leading-snug text-ink-2 transition-colors group-hover:text-ink">
                  {missingFacts.join(" · ")}
                </span>
              </span>
            </a>
          ) : null}
        </section>
      ) : null}

      {p && listDir && (
        <FollowPanel slug={p.slug} dir={listDir}
          count={listDir === "followers" ? followers : p.stats?.following ?? 0}
          onClose={() => setListDir(null)} />
      )}

      {/* ── Stats over their posts ── */}
      {/* ── The posts ── */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[19px] font-bold tracking-tight">Posts</h2>
          {/* The two counts, ON the heading they describe. They used to be a full-width bordered band
              holding two numbers — on a 1440px page that is a thousand pixels of empty card to say
              "3" and "0". Beside the word Posts they read as what they are: a caption. */}
          {postsState !== "loading" && (
            <span className="inline-flex items-center gap-2.5 text-[13px] text-ink-3">
              <span><b className="tabular-nums text-ink-2">{partial ? `${items.length.toLocaleString()}+` : items.length.toLocaleString()}</b> {items.length === 1 && !partial ? "post" : "posts"}</span>
              <span className="inline-flex items-center gap-1" title={partial ? "Hearts on the posts loaded so far" : "Hearts across every post"}>
                <span className="text-yang-ink"><HeartGlyph size={13} /></span>
                <b className="tabular-nums text-ink-2">{heartsTotal.toLocaleString()}</b>
              </span>
            </span>
          )}
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
