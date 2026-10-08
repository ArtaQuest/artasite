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
import { BlueCheck, BlueCheckButton } from "../components/BlueCheck";
import { Avatar, Button, EmptyState, HeartGlyph, Input, LoadMoreButton, Pill, StatusNote, cx } from "../components/ui";
import {
  currentUser, fmtBirthday, followUser, getFollows, getProfile, isLoggedIn, lastSeenLabel, localePath, relAgo,
  type FollowRow, type Profile as ProfileData,
} from "../lib/wp";
import { Coins, CoinMark } from "../lib/currency";
import { sendCoins, ARTA_HANDLE } from "../lib/api";
import ArtaBotProfile from "./ArtaBotProfile";
import { nameClass } from "../lib/fmt";
import { VerifyApi, fileToImage } from "../lib/verify";
import { SocialLinks } from "../components/SocialLinks";
import { bareUrl } from "../lib/socials";

/** The feed API filters by author (GET /notebooks?author=<slug>); the shared params type
 *  doesn't declare `author` yet, so widen it locally rather than touching api.ts (other
 *  agents are editing that file in parallel). */
type AuthorParams = Parameters<typeof listNotebooks>[0] & { author: string };
const listByAuthor = (author: string, cursor?: number) =>
  listNotebooks({ author, ...(cursor ? { cursor } : {}) } as AuthorParams);

// ── little pieces ─────────────────────────────────────────────────────────────

/**
 * One item of the X-style meta row under the bio: a small grey glyph and the fact beside it, inline,
 * wrapping as whole items (operator 2026-10-08: "make it more like X"). What the member does, where
 * they live, their website, when they were born and when they joined — each says what it is through
 * its glyph and its wording ("Born …", "Joined …"), the way a reader of any profile already parses it.
 */
function MetaItem({ icon, children, label }: { icon: React.ReactNode; children: React.ReactNode; label: string }) {
  return (
    <li className="inline-flex max-w-full items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className="shrink-0">{icon}</span>
      <span className="sr-only">{label}: </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

const META_SVG = { viewBox: "0 0 24 24", width: 15, height: 15, fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const ICON_BRIEFCASE = <svg {...META_SVG}><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7M3 12.5h18" /></svg>;
const ICON_PIN = <svg {...META_SVG}><path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11z" /><circle cx="12" cy="10" r="2.6" /></svg>;
const ICON_LINK = <svg {...META_SVG}><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.1 1.1" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.1-1.1" /></svg>;
const ICON_BALLOON = <svg {...META_SVG}><path d="M12 3a6 6 0 0 0-6 6c0 3.7 2.9 7 6 7s6-3.3 6-7a6 6 0 0 0-6-6z" /><path d="m12 16-1 1.8h2zM12 17.8c0 1.6-1.6 1.9-1.6 3.2" /></svg>;
const ICON_CALENDAR = <svg {...META_SVG}><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>;
const ICON_CLOCK = <svg {...META_SVG}><circle cx="12" cy="12" r="8.25" /><path d="M12 8v4.25l2.75 1.6" /></svg>;

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
                <span className={cx("block font-semibold text-ink", nameClass(r.name, 15))}>{r.name}{r.verified && <BlueCheck size={15} className="ms-1" />}</span>
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
function SendCoins({ slug, name, onSent, compact }: { slug: string; name: string; onSent: (balance: number) => void; compact?: boolean }) {
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
        aria-label={`Send coins to ${name}`}
        className={compact
          ? "h-9 w-9 px-0 text-[13.5px] sm:h-10 sm:w-auto sm:px-4 sm:text-[14px]"
          : "h-9 px-3.5 text-[13.5px] font-semibold sm:h-10 sm:px-5 sm:text-[14px]"}
        title={`Send coins to ${name}`}>
        {compact ? (
          <>
            <span className="sm:hidden" aria-hidden><CoinMark size={18} /></span>
            <span className="hidden sm:inline">Send coins</span>
          </>
        ) : "Send coins"}
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

  // What this member has NOT said yet — used only on their own profile, to turn a sparse header into
  // one tap. Order matches the settings form so the prompt reads like a to-do list. The website is
  // stored with the handles but shown in the meta row, so it is split out here.
  const website = p?.socials?.find((x) => x.key === "website" && x.url);
  const networks = (p?.socials ?? []).filter((x) => x.key !== "website");
  const missingFacts = !p ? [] : [
    p.bio?.trim() ? "" : "Bio",
    // "What you do" and the website are optional extras, never nudged for: a member who cleared
    // them on purpose (the founder did, 2026-10-08) must not be asked to put them back.
    p.location?.trim() ? "" : "Where you live",
    networks.length ? "" : "Social profiles",
  ].filter(Boolean);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    setP(null); setMissing(false);
    getProfile(slug).then((d) => { if (d) setP(d); else setMissing(true); }).catch(() => setMissing(true));
  }, [slug]);
  // Dynamic-route title (RouteTitle skips /u/:slug so this owns it).
  useEffect(() => { const n = p?.fullName?.trim() || p?.name; if (n) document.title = `${n} – ArtaQuest`; }, [p?.fullName, p?.name]);

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

  // ARTA — the public assistant gets its own variant: no wallet, diary or inbox (the server refuses
  // all three), its status, a how-to, and its recent public answers instead of a notebook grid.
  if (p && (p.bot || p.slug === ARTA_HANDLE)) {
    return <ArtaBotProfile p={p} following={following} followers={followers} followBusy={followBusy} onToggleFollow={toggleFollow} loginHref={loginHref} />;
  }

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
  // On a PHONE it is a round calendar button beside Follow — the X header's icon-button pattern —
  // because the actions share the avatar's row and two worded buttons do not fit beside a 96px
  // portrait at 360px. The words return from `sm`; the accessible name is always the full label.
  const bookLabel = isOwn ? "Book me" : "Book a time";
  const bookButton = p ? (
    <Button href={localePath(`/book/${encodeURIComponent(p.slug)}`)} variant="outline" aria-label={bookLabel}
      className="h-9 w-9 px-0 text-[13.5px] sm:h-10 sm:w-auto sm:px-5 sm:text-[14px]" title={isOwn ? "Your public booking page — the link you share" : "See when they are free and take a time"}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="sm:hidden">
        <rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" />
      </svg>
      <span className="hidden sm:inline">{bookLabel}</span>
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
        <header className="overflow-hidden rounded-card border border-line bg-space-2 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]">
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
          <div className={p.banner ? "relative aspect-[3/1] max-h-60 w-full" : "relative h-[4.75rem] w-full sm:h-32"}>
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

          <div className="px-4 pb-4 sm:px-6 sm:pb-5">
            {/* X-LIKE HEADER (operator 2026-10-08, after PR #70: "look at how ugly it is").
                Clear rows, left-aligned content, nothing floating in the top-right:
                  1. Avatar straddling the cover + action group (Book FIRST, then Follow…) on the
                     same baseline. Counts sit as a compact inline line under the buttons on phones,
                     beside them from `sm` — never a squeezed stacked column.
                  2. Name + badge, with tier and coins as small chips on the same line.
                  3. @handle
                  4. Four social marks + "+N", left-aligned
                  5. Bio
                  6. Meta (location · born · joined)
                  7. Quiet "Active …" line
                `relative z-10` on the avatar row is load-bearing (cover is positioned; without it the
                radial overlay paints over the portrait). */}
            <div className="relative z-10 -mt-9 flex items-end justify-between gap-3 sm:-mt-12 sm:gap-4">
              <Avatar priority src={p.avatar} name={p.name} palm={p.palm || undefined}
                className="h-[4.5rem] w-[4.5rem] shrink-0 bg-space-2 text-[24px] ring-[3px] ring-space-2 sm:h-28 sm:w-28 sm:text-[2rem] sm:ring-[4px]" />
              {/* ACTIONS + COUNTS — right of the avatar, Book first (operator 2026-10-08). */}
              <div className="flex min-w-0 flex-col items-end gap-1.5 pb-0.5 sm:flex-row sm:items-center sm:gap-3.5 sm:pb-1">
                {/* COUNTS — always one horizontal line. Under the buttons on phones; beside them from sm. */}
                <div className="order-2 flex flex-wrap items-center justify-end gap-x-1 text-[13px] leading-none text-ink-3 sm:order-1 sm:text-[14px]">
                  <button type="button" onClick={() => setListDir((d) => (d === "following" ? null : "following"))}
                    aria-expanded={listDir === "following"} title="Show the following list"
                    className="whitespace-nowrap py-1 transition-colors hover:text-ink">
                    <b className="font-bold text-ink tabular-nums">{(p.stats?.following ?? 0).toLocaleString()}</b> Following
                  </button>
                  <span aria-hidden className="px-0.5 text-ink-3/40">·</span>
                  <button type="button" onClick={() => setListDir((d) => (d === "followers" ? null : "followers"))}
                    aria-expanded={listDir === "followers"} title="Show the followers list"
                    className="whitespace-nowrap py-1 transition-colors hover:text-ink">
                    <b className="font-bold text-ink tabular-nums">{followers.toLocaleString()}</b> {followers === 1 ? "Follower" : "Followers"}
                  </button>
                </div>
                <div className="order-1 flex flex-wrap items-center justify-end gap-2 sm:order-2">
                  {isOwn ? (
                    <>
                      {bookButton}
                      <a href={localePath("/user-account/?settings=1")}
                        className="inline-flex h-9 items-center rounded-pill border border-line px-3.5 text-[13px] font-semibold text-ink-2 transition-colors hover:border-yang hover:text-ink sm:h-10 sm:px-4 sm:text-[13.5px]">
                        Edit profile
                      </a>
                    </>
                  ) : isLoggedIn() ? (
                    <>
                      {bookButton}
                      <Button type="button" onClick={toggleFollow} disabled={followBusy}
                        variant={following ? "outline" : "primaryYin"}
                        className="h-9 px-4 text-[13.5px] font-semibold transition-opacity disabled:opacity-60 sm:h-10 sm:px-5 sm:text-[14px]">
                        {following ? "Following" : "Follow"}
                      </Button>
                      {/* Message + Send coins join this row from `sm` (room beside Follow). On phones
                          they sit on the secondary row below so the avatar baseline stays clean. */}
                      <span className="hidden sm:contents">
                        <Button href={localePath(`/messages/?with=${encodeURIComponent(p.slug)}`)} variant="outline" aria-label="Message"
                          className="h-10 px-4 text-[14px]" title="Send an encrypted message">Message</Button>
                        <SendCoins slug={p.slug} name={p.fullName?.trim() || p.name} onSent={() => undefined} />
                      </span>
                    </>
                  ) : (
                    <>
                      {bookButton}
                      <Button href={loginHref} variant="primaryYin" className="h-9 px-4 text-[13.5px] font-semibold sm:h-10 sm:px-5 sm:text-[14px]">Follow</Button>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* SECONDARY ACTIONS — phones only, for a signed-in visitor. Keeps Message + Send coins
                off the avatar baseline so they never orphan beside the portrait. */}
            {!isOwn && isLoggedIn() ? (
              <div className="mt-2 flex flex-wrap items-center justify-end gap-2 sm:hidden">
                <Button href={localePath(`/messages/?with=${encodeURIComponent(p.slug)}`)} variant="outline" aria-label="Message"
                  className="h-9 px-3.5 text-[13.5px] font-semibold" title="Send an encrypted message">Message</Button>
                <SendCoins slug={p.slug} name={p.fullName?.trim() || p.name} onSent={() => undefined} />
              </div>
            ) : null}

            {/* NAME + badge + standing chips — one clear identity line. */}
            <div className="mt-3.5 min-w-0 sm:mt-4">
              <h1 className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[21px] font-extrabold leading-[1.15] tracking-tight sm:text-[25px]">
                <span className="min-w-0 wrap-anywhere">{p.fullName?.trim() || p.name}</span>
                {p.verified && <BlueCheckButton size={19} via={p.verifiedVia} own={isOwn} className="translate-y-px sm:scale-105" />}
                {p.tier && (
                  <Pill className="ms-0.5 px-2 py-0.5 text-[11px] font-semibold normal-case tracking-normal sm:text-[11.5px]">{p.tier}</Pill>
                )}
                <span className="inline-flex items-center gap-1 rounded-pill bg-yin/12 px-2 py-0.5 text-[11px] font-semibold text-yin-ink sm:text-[11.5px]"
                  title="Coins in their wallet — every entry in the coin ledger is public">
                  <Coins n={p.coins ?? 0} />
                </span>
              </h1>
              <p className="mt-1 text-[14.5px] leading-snug text-ink-3 wrap-anywhere sm:text-[15px]">
                <span className="break-all">@{p.slug}</span>
                {p.fullName?.trim() && p.fullName.trim() !== p.name && p.name !== p.slug && (
                  <span> · goes by {p.name}</span>
                )}
              </p>
            </div>

            {/* SOCIALS — left-aligned under the handle, always four + "+N". */}
            {networks.length > 0 && (
              <SocialLinks socials={networks} name={p.fullName?.trim() || p.name} className="mt-2.5" />
            )}

            {p.bio && <p className="mt-3 max-w-2xl whitespace-pre-wrap text-[15px] leading-relaxed text-ink wrap-anywhere">{p.bio}</p>}

            {(p.category?.trim() || p.location?.trim() || website || fmtBirthday(p.birthday) || p.joined) ? (
              <ul className="mt-3 flex list-none flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-3 sm:mt-3.5 sm:gap-x-3.5 sm:text-[13.5px]" aria-label="About">
                {p.category?.trim() ? <MetaItem icon={ICON_BRIEFCASE} label="Does"><span data-ay-skip="1">{p.category.trim()}</span></MetaItem> : null}
                {p.location?.trim() ? <MetaItem icon={ICON_PIN} label="Lives in"><span data-ay-skip="1">{p.location.trim()}</span></MetaItem> : null}
                {website ? (
                  <MetaItem icon={ICON_LINK} label="Website">
                    <a href={website.url} target="_blank" rel="me nofollow ugc noopener noreferrer" data-ay-skip="1"
                      className="text-yin-ink hover:underline focus-visible:underline">{bareUrl(website.url)}</a>
                  </MetaItem>
                ) : null}
                {fmtBirthday(p.birthday) ? <MetaItem icon={ICON_BALLOON} label="Birthday"><span className="whitespace-nowrap">Born {fmtBirthday(p.birthday)}</span></MetaItem> : null}
                {p.joined ? <MetaItem icon={ICON_CALENDAR} label="Joined"><span className="whitespace-nowrap">Joined {p.joined}</span></MetaItem> : null}
              </ul>
            ) : null}

            {/* LAST ACTIVE — quiet foot of the header (operator 2026-10-08: "last active time shown below"). */}
            {p.lastSeen ? (
              <p className="mt-3.5 flex items-center gap-1.5 border-t border-line/60 pt-3 text-[12.5px] leading-none text-ink-3 sm:mt-4 sm:pt-3.5 sm:text-[13px]">
                <span className="inline-flex shrink-0 text-ink-3/80 [&_svg]:h-3.5 [&_svg]:w-3.5" aria-hidden>{ICON_CLOCK}</span>
                <span>{lastSeenLabel(p.lastSeen)}</span>
              </p>
            ) : null}

            {isOwn && missingFacts.length > 0 ? (
              <a href={localePath("/user-account/?settings=1")}
                className="group mt-3.5 flex min-w-0 items-start gap-2.5 rounded-card border border-dashed border-line px-3 py-2 transition-colors hover:border-yang">
                <span aria-hidden className="mt-0.5 shrink-0 text-ink-3 transition-colors group-hover:text-yang">
                  <svg {...META_SVG} width={16} height={16}><path d="M12 5v14M5 12h14" /></svg>
                </span>
                <span className="min-w-0">
                  <span className="block text-[11.5px] font-semibold uppercase tracking-wider text-ink-3">Add to your profile</span>
                  <span className="mt-0.5 block text-[14px] leading-snug text-ink-2 transition-colors group-hover:text-ink">
                    {missingFacts.join(" · ")}
                  </span>
                </span>
              </a>
            ) : null}
            {bannerMsg && <p role="alert" className="mt-3 text-[12.5px] text-yin-ink">{bannerMsg}</p>}
          </div>
        </header>
      )}

      {/* ── Follower / following list (inline, opened from the counts above) ──
          No separate "About" card any more (operator 2026-10-08, "make it more like X"): Born and the
          city moved into the header's meta row, and relationship status was removed. */}
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
