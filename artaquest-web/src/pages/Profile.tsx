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
  currentUser, fmtBirthday, followUser, getFollows, getProfile, isLoggedIn, lastSeenLabel, localePath, relAgo, relationshipLabel,
  type FollowRow, type Profile as ProfileData,
} from "../lib/wp";
import { Coins } from "../lib/currency";
import { sendCoins } from "../lib/api";
import { nameClass } from "../lib/fmt";
import { VerifyApi, fileToImage } from "../lib/verify";

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
    <div className="flex flex-wrap items-center gap-4" aria-hidden>
      <div className="h-24 w-24 shrink-0 animate-pulse rounded-full bg-veil/[0.08]" />
      {/* WRAP rather than switch on the viewport, and cap the bars. `sm:flex-row` put these beside
          the 96px circle from a 640px WINDOW onward, but the shell's content column is only ~366px
          at 1024 and ~410px at 1100, and the bars are fixed widths — 96 + 16 + 288 (w-72) is wider
          than the column, so the placeholder for a page about to load overflowed it (operator
          2026-08-21). The block asks for 18rem and takes its own line when the column cannot hold
          both; max-w-full keeps each bar inside whatever width it lands in. */}
      <div className="min-w-0 flex-[1_1_18rem]">
        <div className="h-6 w-48 max-w-full animate-pulse rounded bg-veil/[0.08]" />
        <div className="mt-3 h-4 w-72 max-w-full animate-pulse rounded bg-veil/[0.06]" />
        <div className="mt-2 h-4 w-40 max-w-full animate-pulse rounded bg-veil/[0.06]" />
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
      {/* auto-fit, not `sm:grid-cols-2`: `sm:` is a 640px VIEWPORT query and this panel sits in the
          shell's content column, ~410px at 1100 and ~366px at 1024. Two fixed tracks made each row
          181px wide, of which a 40px avatar and the row's own padding take 68px — 113px for a member
          NAME, which is never truncated and so simply wrapped down the page (operator 2026-08-21).
          Each row asks for 14rem: two 319px rows at 1440, two 261px ones at 1280, one column at
          1100 and below. */}
      <ul className="mt-1 grid list-none grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-x-4">
        {rows.map((r, i) => {
          const body = (
            <>
              <Avatar src={r.avatar} name={r.name} className="h-10 w-10 text-[15px]" />
              <span className="min-w-0 flex-1">
                <span className={cx("block font-semibold text-ink", nameClass(r.name, 15))}>{r.name}</span>
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
  // Languages are not listed either: the card stopped showing "Speaks" on 2026-08-18 (operator).
  const missingFacts = !p ? [] : [
    p.location?.trim() ? "" : "Where you live",
    relationshipLabel(p.relationship) ? "" : "Relationship",
    // Nationality is deliberately NOT listed: this card links to the settings editor, and the
    // nationality picker lives in the Identity section further down the Account page — a prompt
    // that lands somewhere without the field is worse than none. Every member states one at
    // sign-up now, and the operator set the existing accounts' by hand (2026-08-18).
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

  // THE BANNER (operator 2026-08-18: "make banner pic updatable"). Own profile only: a file picker
  // behind an "Add/Change cover" pill on the cover itself, the picture downscaled in the browser
  // (≤1600px on the long edge, JPEG) and sent to /profile/banner; the page swaps it in without a
  // reload. Remove paints the gold→blue band again. Free, public, nothing to do with the blue check.
  const bannerInput = useRef<HTMLInputElement | null>(null);
  const [bannerBusy, setBannerBusy] = useState(false);
  const [bannerMsg, setBannerMsg] = useState("");
  const onBannerPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // the same file may be picked again after a failure
    if (!f || bannerBusy) return;
    setBannerBusy(true); setBannerMsg("");
    try {
      const url = await fileToImage(f, 1600, 0.85);
      const r = await VerifyApi.setBanner(url);
      if (r?.ok && r.banner) setP((prev) => (prev ? { ...prev, banner: r.banner } : prev));
      else setBannerMsg(r?.message || "Couldn't save that picture — try a JPG or PNG under 5 MB.");
    } catch {
      setBannerMsg("Couldn't read that image.");
    } finally {
      setBannerBusy(false);
    }
  };
  const removeBanner = async () => {
    if (bannerBusy) return;
    setBannerBusy(true); setBannerMsg("");
    try {
      const r = await VerifyApi.removeBanner();
      if (r?.ok) setP((prev) => (prev ? { ...prev, banner: "" } : prev));
      else setBannerMsg(r?.message || "Couldn't remove the cover — try again.");
    } catch {
      setBannerMsg("Couldn't remove the cover — try again.");
    } finally {
      setBannerBusy(false);
    }
  };

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

  /** Shown to a signed-in visitor beside Message, to a signed-out one beside Follow, and — since
   *  2026-08-16 — to the MEMBER THEMSELVES beside Edit profile. The same element in all three
   *  branches, so they cannot drift. Never gated on a session: the booking page it points at is
   *  public on purpose.
   *
   *  The owner's copy is what was missing, and it is the copy that matters most: /book/<handle> is
   *  the link a member hands to somebody else, and their own profile is where they would go to find
   *  it. Every other route to it — the Meet page, the share card on the booking page itself —
   *  assumes you already know the URL exists. The label changes because the act does: a visitor
   *  takes a time, an owner copies the link they are about to send. */
  const bookButton = p ? (
    <Button href={localePath(`/book/${encodeURIComponent(p.slug)}`)} variant="outline"
      className="h-10 px-5 text-[14px]" title={isOwn ? "Your public booking page — the link you share" : "See when they are free and take a time"}>
      {isOwn ? "Book me" : "Book a time"}
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
              complements. No third hue, no photograph to moderate, and it costs nothing to load.

              TWO STOPS, NOT THREE. It used to fade through `via-yang/20`, which was checked on the
              light canvas where 20% gold over near-white is a pale cream and reads as a graceful
              fade. Composited over the DARK card it is rgb(64,55,27) — luminance 55, against 151 at
              the gold end and 61 at the blue — so the middle of the band was a dark olive DIP,
              darker than either end, and the whole cover read as a smeared, muddy photograph.
              Straight gold to blue passes through a near-neutral grey instead, which is not a
              compromise but the point: these two are complements, and muted they meet at the true
              neutral midpoint. Verified in both themes. */}
          {/* WITH A BANNER (member-set, 2026-08-18) the cover is the picture at 3:1 — the shape every
              other social banner is cut to, so a picture made for X or LinkedIn lands here whole —
              capped at 15rem tall; without one it stays the 80/128px band above. object-cover
              centre-crops anything that is not 3:1 rather than letterboxing it. The container is no
              longer aria-hidden as a whole: the picture is decorative (alt="") and the two gradient
              layers are hidden, but the owner's controls on it must reach assistive tech. */}
          <div className={p.banner ? "relative aspect-[3/1] max-h-60 w-full" : "relative h-20 w-full sm:h-32"}>
            {p.banner ? (
              <img src={p.banner} alt="" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <>
                <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-yang/80 to-yin/80" />
                <div aria-hidden className="absolute inset-0 bg-[radial-gradient(120%_150%_at_18%_-30%,rgba(255,255,255,0.22),transparent_62%)]" />
              </>
            )}
            <div aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-line" />
            {isOwn && (
              /* The owner's controls, top-end, clear of the avatar (which straddles the bottom-left
                 edge). Frosted so they read on any picture; end-anchored so RTL mirrors them. */
              <div className="absolute end-3 top-3 flex items-center gap-1.5">
                <button type="button" onClick={() => bannerInput.current?.click()} disabled={bannerBusy}
                  title="Change the picture behind your profile — a wide (3:1) picture fits best"
                  className="inline-flex h-8 items-center gap-1.5 rounded-pill border border-line bg-space-1/80 px-3 text-[12.5px] font-semibold text-ink backdrop-blur transition-colors hover:border-yang disabled:opacity-60">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.2" />
                  </svg>
                  {bannerBusy ? "Saving…" : p.banner ? "Change cover" : "Add cover"}
                </button>
                {p.banner && !bannerBusy ? (
                  <button type="button" onClick={removeBanner} title="Remove the cover picture" aria-label="Remove the cover picture"
                    className="grid h-8 w-8 place-items-center rounded-full border border-line bg-space-1/80 text-ink-2 backdrop-blur transition-colors hover:border-yang hover:text-ink">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
                  </button>
                ) : null}
                <input ref={bannerInput} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" tabIndex={-1} aria-hidden onChange={onBannerPick} />
              </div>
            )}
          </div>

          <div className="px-4 pb-5 sm:px-6">
            {/* The avatar STRADDLES the cover's edge — the pattern every profile uses, because it
                anchors the eye and makes the portrait the largest thing on the page. The ring is the
                card's own background, so the circle punches cleanly out of the gradient in both
                themes.

                `relative z-10` is LOAD-BEARING, not decoration. The cover above is
                `position: relative`, and a positioned element paints in a LATER step than
                non-positioned block content regardless of DOM order — so while this row was static,
                the cover's white radial-gradient overlay painted straight over the avatar's top
                40px. The portrait's upper half was visibly washed out, with a hard seam exactly at
                the cover's bottom edge, which reads as a badly centred sigil rather than as an
                overlay. Measured on prod: elementFromPoint at the avatar's centre-x, 18% down,
                returned the cover's gradient div. Positioning this row puts it in the same paint
                step, where later-in-DOM wins.

                THIS ROW IS AVATAR + NAME, NOTHING ELSE (operator, four screenshots on 2026-08-18). It
                began the day as avatar + name + the action buttons on one non-wrapping row, where the
                name block was the only thing that could give — it gave until it was one character
                wide ("r" over "@") while Send coins ran off the card. The buttons moved through
                "wrap under the name", then "at the right", and finally to the STANDING line below,
                where the member's chips and follow counts fill the space to their left ("forgot to fit
                the rest of data"). What stays here: the name block is `min-w-0 grow shrink basis-0
                sm:basis-auto` — its flex base size is the name on ONE line — and it wraps only when it
                does not fit beside the avatar alone (then it takes a line under the avatar, whole,
                thanks to `wrap-anywhere`); the avatar stays `shrink-0`; below `sm` the column layout is
                unchanged. A name is never truncated. Measured at 390/700/1100/1440 through ArtaFocus. */}
            <div className="relative z-10 -mt-10 flex flex-col gap-3 sm:-mt-14 sm:flex-row sm:items-end sm:gap-5">
              {/* priority: above the fold and normally this page's LCP element — lazy-loading it
                  made the browser wait for layout before even starting the request. Carries the
                  STATED nationality flag and the opt-in palm flip. THE FLAG CHIP ON THE AVATAR IS THE
                  ONE PLACE the nationality shows on this page (operator 2026-08-18, settled after two
                  rounds: "this is enough, no need for separate section or after dob") — no
                  "Nationality" row in the About card, nothing after the date of birth. The flag is a
                  claim, exactly like the date of birth below — the member picked it; the blue check
                  beside the name is the verification signal, not the flag. `country` is what the
                  backend chose to expose and today carries the same value; the claim is read first
                  so the flag never depends on which one arrived. */}
              <Avatar priority src={p.avatar} name={p.name} palm={p.palm || undefined}
                country={p.nationality || p.country || undefined}
                className="h-24 w-24 shrink-0 bg-space-2 text-3xl ring-4 ring-space-2 sm:h-32 sm:w-32" />
              <div className="min-w-0 grow shrink basis-0 sm:basis-auto sm:pb-1">
                {/* THE REAL NAME IS THE HEADING. `p.name` is display_name — the handle a member is
                    addressed by, and frequently not a name at all ("Arash" for Arash Ashrafnejad).
                    full_name is what the identity gate collected and what the page title, description
                    and Person schema say, so the visible heading agreeing with them is both the
                    honest label and the one a visitor arriving from a name search expects.

                    NEVER TRUNCATED. A name wraps; `overflow-wrap: anywhere` (Tailwind's `wrap-anywhere`)
                    lets a single long token break rather than overflow, and — unlike `break-word` — it
                    counts those breaks in the flex item's min-content size, so the item can actually
                    shrink to fit. */}
                <h1 className="flex items-center gap-2 text-[26px] font-extrabold leading-tight tracking-tight sm:text-[30px]">
                  <span className="min-w-0 wrap-anywhere">{p.fullName?.trim() || p.name}</span>
                  {p.verified && <BlueCheck size={20} className="shrink-0" />}
                </h1>
                {/* THE HANDLE. It is how you are addressed here and the only thing /messages/?with=
                    accepts, so "what is this person's handle" was a question their own profile could
                    not answer. Shown whenever it adds something the heading has not already said.
                    Never truncated either: the handle is a slug, so it may break anywhere; the "goes
                    by" name beside it wraps at spaces first. */}
                {(p.fullName?.trim() && p.fullName.trim() !== p.name ? p.name : p.slug) && (
                  <p className="mt-0.5 text-[14px] text-ink-3 wrap-anywhere">
                    <span className="break-all">@{p.slug}</span>
                    {p.fullName?.trim() && p.fullName.trim() !== p.name && p.name !== p.slug && (
                      <span className="text-ink-3"> · goes by {p.name}</span>
                    )}
                  </p>
                )}
              </div>
            </div>


            {/* STANDING + ACTIVITY + FOLLOW COUNTS on ONE line, with the ACTIONS at its right (operator
                2026-08-18, "forgot to fit the rest of data": the button row had been sitting alone at
                the right of an empty line, with three short left-aligned rows stacked under it). The
                meta block asks for 18rem (`sm:basis-72`) and then grows: with less than that left
                beside the buttons it would crumble into one chip per line (measured: four buttons in a
                686px column left it 190px), so instead the buttons drop to a line of their own — still
                at the right, `ms-auto`, folding toward it in a narrow shell column — and the meta takes
                the whole line above them. When there IS room (two buttons at 686px, four at 976px) they
                share the line, meta left, buttons right. Below `sm` the two stack.
                Chips kept as chips and kept together: what this member has earned and when they were
                last around are one category, deliberately NOT mixed with the stated facts below. */}
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-2">
            <div className="flex min-w-0 grow shrink basis-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-ink-3 sm:basis-72">
              {p.tier && <Pill className="px-3 py-0.5 text-[13px]">{p.tier}</Pill>}
              {/* ONE currency on this page: ArtaCoin (operator 2026-08-15). The lifetime points score
                  used to sit here in gold beside it, and two numbers in two currencies on one line is
                  a thing to decode rather than a fact to read — especially on a page people now come
                  to in order to meet someone. Points still exist, are still earned, and still rank the
                  Careers and Grants pages; they are simply not what this page is about.
                  THE WALLET, in the open: the whole coin ledger is already published — every entry
                  downloadable from /data/ — so a balance was public in fact while being absent from
                  the one page about this member. */}
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
              {/* Each count is a live control: tap it to open the respective list below. Kept as one
                  unit ("2 followers · 2 following") so a wrap never splits the pair. */}
              <span className="whitespace-nowrap text-[13.5px]">
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
              </span>
            </div>
              {/* The actions sit at the RIGHT of this row (operator 2026-08-18), with the member's
                  standing and activity filling the space to their left — see the note above the row.

                  ONE definition, rendered from two branches. Beside Message it reads as the same act
                  at two speeds — say something now, or take some of their time later — and on its own
                  it is the only thing a signed-out reader can actually do with this person. Written
                  once because the last time it existed in only one branch, that was the bug. The
                  booking page says plainly when somebody is not offering any time, so it never leads
                  anywhere embarrassing. */}
              {isOwn ? (
                <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3 sm:ms-auto sm:justify-end">
                  {bookButton}
                  <a href={localePath("/user-account/?settings=1")} className="self-start text-[13.5px] font-semibold text-ink-3 transition-colors hover:text-yang sm:self-auto">
                    Edit profile <span aria-hidden className="inline-block rtl:-scale-x-100">→</span>
                  </a>
                </div>
              ) : isLoggedIn() ? (
                /* Follow + Message. Until this existed the ONLY way to open a conversation was typing
                   a member's exact @handle into the ArtaChat sidebar — this is the entry point the
                   /messages/?with= deep link was always built for. */
                <div className="flex min-w-0 max-w-full flex-wrap gap-2 sm:ms-auto sm:justify-end">
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
                <div className="flex min-w-0 max-w-full flex-wrap gap-2 sm:ms-auto sm:justify-end">
                  <Button href={loginHref} variant="primaryYin" className="h-10 px-6 text-[14px]">Follow</Button>
                  {bookButton}
                </div>
              )}
            </div>

            {/* THE BIO, under the standing line — the actions stay near the top whatever its length. */}
            {p.bio && <p className="mt-4 max-w-2xl whitespace-pre-wrap text-[15px] leading-relaxed text-ink-2">{p.bio}</p>}
            {bannerMsg && <p role="alert" className="mt-3 text-[12.5px] text-yin-ink">{bannerMsg}</p>}

            {/* NO social links here (operator 2026-08-18: "remove all the social links"). They are
                still collected in Settings, because they feed the Person schema's sameAs (aq-app.php)
                — an indexer's fact, not a row of pills on the page. */}
          </div>
        </header>
      )}

      {/* ── Follower / following list (inline, opened from the counts above) ── */}
      {/* ── WHAT THEY SAY ABOUT THEMSELVES ──
          Every value here was typed or picked by this member: nothing is inferred, and nothing is
          derived from an IP address or a header. Rows appear only when there is something to say —
          a member who has filled none of this in gets no card at all, rather than a grid of blanks
          advertising what they declined to answer. */}
      {/* AUTO-FIT columns, not `lg:grid-cols-4`: the shell gives this page a ~686px column at a
          1440px window (and ~410px at 1100px), where four fixed columns were 137px each and
          "February 15, 1994" broke after the comma (operator's Born screenshot, 2026-08-18). Each
          fact now asks for 11rem and the row holds as many as fit — three at 686px, one on a phone. */}
      {p && (isOwn || fmtBirthday(p.birthday) || p.location?.trim() || relationshipLabel(p.relationship)) ? (
        <section className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-x-8 gap-y-5 rounded-card border border-line bg-space-2 px-5 py-5" aria-label="About">
          {/* ORDER (operator 2026-08-18): Born, then Lives in, then Relationship. "Speaks" (the
              languages) left the card the same day; the languages are still collected and public,
              they are simply not a row here.
              The DATE, to everyone — no derived age. Operator 2026-07-27, reaffirmed 2026-08-15:
              "printing it turns a fact the member stated into a label the site puts on them", and it
              re-renders differently every birthday. Between 08-14 and 08-15 this showed a derived age
              to visitors and the date only to the member; that was my call and the operator reversed
              it. `p.age` still arrives from the API for other clients — do not render it here. */}
          {fmtBirthday(p.birthday) ? (
            <Fact label="Born" icon={<svg {...FACT_SVG}><path d="M4 20h16v-6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2Zm0-3h16" /><path d="M12 12V8m0-4v1.5M8 12V9m8 3V9" /></svg>}>
              <span className="whitespace-nowrap">{fmtBirthday(p.birthday)}</span>
            </Fact>
          ) : null}
          {p.location?.trim() ? (
            <Fact label="Lives in" icon={<svg {...FACT_SVG}><path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11z" /><circle cx="12" cy="10" r="2.6" /></svg>}>
              <span data-ay-skip="1">{p.location.trim()}</span>
            </Fact>
          ) : null}
          {relationshipLabel(p.relationship) ? (
            <Fact label="Relationship" icon={<svg {...FACT_SVG}><path d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.6-7 9-7 9z" /></svg>}>
              {relationshipLabel(p.relationship)}
            </Fact>
          ) : null}
          {/* NO "Nationality" row here, and no flag after the date (operator 2026-08-18: "this is
              enough, no need for separate section or after dob") — the flag chip on the avatar in the
              header is the one place the stated nationality shows on this page. It is a claim, like
              the date of birth; the blue check beside the name is the only verification signal. */}
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
        {/* auto-fit, not `lg:grid-cols-3 xl:grid-cols-4`: both are VIEWPORT queries, and 1024 — where
            `lg:` asks for a third track — is the exact width at which the shell's 330px right column
            appears, so the page was cut to ~366px at the same moment it was told to hold three cards.
            Measured: 151px NbCards at 1440 and 115px at 1100, for a card carrying a 16/10 teaser, a
            two-line title and an author's name (operator 2026-08-21). Each card asks for 10rem, which
            is the width the phone's two-up already gives it, so the row is three 218px cards at 1440,
            three 179px at 1280, two 197px at 1100 and two on a phone exactly as before. The skeleton
            below uses the same track definition so nothing reflows when the posts arrive. */}
        {postsState === "loading" ? (
          <ul className="grid list-none grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3 sm:gap-4" aria-hidden>
            {Array.from({ length: 8 }, (_, i) => <CardSkeleton key={i} />)}
          </ul>
        ) : postsState === "error" ? (
          <StatusNote error>Couldn't load these posts — please refresh and try again.</StatusNote>
        ) : items.length ? (
          <>
            <ul className="grid list-none grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3 sm:gap-4">
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
