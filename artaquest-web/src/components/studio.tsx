/* eslint-disable react-refresh/only-export-components -- studio-family module: by design it exports
   the shared components (WorkCard, CreateWork) AND the kind registry/normalisers they're built from. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { seasonByN, seasonForDate } from "../lib/seasons";
import { CATEGORY_GROUPS } from "../lib/typology-meta";
import { uiLocale, localePath, isLoggedIn, currentUser } from "../lib/wp";
import {
  createBook, createTrack, createAnimation, createFilm, createIllustration, myBooks,
  getStudioPulse, type StudioPulse, Challenges as ChallengesApi,
  type BookCard, type TrackCard, type AnimationCard, type FilmCard, type IllustrationCard,
  type Submission, type CompetitionCard, ApiError,
} from "../lib/api";
import { type CourseCard } from "../lib/wp";
import { Button, Card, Field, Input, Textarea, CheckField, Select, StatusNote, cx, HeartGlyph } from "./ui";
import EDGE_VOICES from "../data/edge-voices.json";

/**
 * The studio family, unified. Every AI-content type on ArtaQuest — books, music, audiobooks,
 * animations, films, illustrations, papers — shares ONE publishing experience: brief → the studio
 * generates → public adversarial review rounds → you publish under your name (₳ by length).
 * This module is the shared vocabulary for that experience: the kind registry, the normalised
 * WorkItem card, and the one CreateWork form the Library hub drives. Detail pages stay per-kind
 * (a reader, a player, a screening room…); the HUB experience is one.
 */

/* ───────────────────────── Kind registry ───────────────────────── */

// The AI "works" — brief → generate → adversarial review → publish. These fill the Create form.
export type MakeKind = "book" | "music" | "audiobook" | "animation" | "film" | "illustration" | "paper";
// Every card kind in the Library, including the curated/hosted surfaces that have no create flow.
export type WorkKind = MakeKind | "course" | "competition";

export const WORK_KINDS: Record<WorkKind, {
  label: string;        // singular ("Book")
  plural: string;       // shelf/tab label ("Books")
  studio: string;       // the studio brand that makes it
  createLabel: string;  // CTA verb ("Write a book")
  searchPlaceholder: string;
}> = {
  book:         { label: "Book",         plural: "Books",         studio: "ArtaPublishing",  createLabel: "Write a book",             searchPlaceholder: "Search books" },
  music:        { label: "Track",        plural: "Music",         studio: "ArtaSound",       createLabel: "Compose a track",          searchPlaceholder: "Search music" },
  audiobook:    { label: "Audiobook",    plural: "Audiobooks",    studio: "ArtaSound",       createLabel: "Record an audiobook",      searchPlaceholder: "Search audiobooks" },
  animation:    { label: "Animation",    plural: "Animations",    studio: "ArtaMotion",      createLabel: "Animate a topic",          searchPlaceholder: "Search animations" },
  film:         { label: "Film",         plural: "Films",         studio: "ArtaFilm",        createLabel: "Make a film",              searchPlaceholder: "Search films" },
  illustration: { label: "Illustration", plural: "Illustrations", studio: "ArtaIllustration", createLabel: "Commission art",          searchPlaceholder: "Search illustrations" },
  paper:        { label: "Paper",        plural: "Papers",        studio: "ArtaScience",     createLabel: "Submit a paper",           searchPlaceholder: "Search papers" },
  course:       { label: "Course",       plural: "Courses",       studio: "ArtaCycle",       createLabel: "Browse courses",           searchPlaceholder: "Search courses" },
  competition:  { label: "Competition",  plural: "Competitions",  studio: "ArtaCompete",     createLabel: "Host a competition",       searchPlaceholder: "Search competitions" },
};

export const KIND_LABEL: Record<string, string> = { art: "Artwork", cover: "Book cover", plate: "Book plate" };

/** Draft-state label, unified across the family (the per-kind verb keeps each studio's voice). */
export function workStateLabel(kind: WorkKind, status?: string, state?: string): string {
  if (status === "published") return "Published";
  switch (state) {
    case "queued": return "Queued";
    case "processing":
      return kind === "book" ? "Writing…" : kind === "music" || kind === "audiobook" ? "Composing…"
        : kind === "animation" ? "Rendering…" : kind === "film" ? "Filming…" : kind === "illustration" ? "Painting…" : "Working…";
    case "review": return "Ready to review";
    case "failed": return "Failed";
    default: return "Draft";
  }
}

/** Back-compat alias for the illustration surfaces (Studio.tsx, Illustration.tsx). */
export function artStateLabel(status?: string, state?: string): string {
  return workStateLabel("illustration", status, state);
}

/* ───────────────────────── Normalised card ───────────────────────── */

export type WorkItem = {
  kind: WorkKind;
  id: number;
  to: string;              // detail path (un-localised)
  title: string;
  author?: string;
  image?: string;
  aspect: string;          // tailwind aspect class for the cover box
  meta: string;            // one footer line ("32 pages · Jun 2026", "▶ 2:30 · 41 plays")
  badge?: string;          // small overlay chip ("Audiobook", "Refined ×4", "Score 92")
  status?: string;         // for drafts strips
  state?: string;
  season?: number;         // the work's season (1…12): its topic's season when known, else its birth season
};

// Every post carries its season RANK (operator 2026-07-11 — no suits, no content classification):
// its topic's season when known, else the season it was born in (created).
const bornSeason = (ts?: number): number | undefined => (ts ? seasonForDate(new Date(ts * 1000)).n : undefined);
// A course's rank comes from its TOPIC's season: the house slots map onto the cycle by the same
// +8 rotation as seasonForPhase (the house list opens at the 14 Apr span = cycle position 9).
const HOUSE_N: Record<string, number> = Object.fromEntries(CATEGORY_GROUPS.map((g, i) => [g.key, ((i + 8) % 12) + 1]));
const houseSeasonN = (house?: string): number | undefined => (house && HOUSE_N[house]) || undefined;

/** The small rank chip a work wears ("9") — its season, stability-toned like every rank. */
export function WorkCardChip({ w }: { w: WorkItem }) {
  const se = seasonByN(w.season);
  if (!se) return null;
  const toneStyle = se.tone === "dual"
    ? { backgroundImage: "linear-gradient(105deg, var(--color-yang-ink), var(--color-yin-ink))", WebkitBackgroundClip: "text" as const, backgroundClip: "text" as const, color: "transparent" }
    : undefined;
  return (
    <span title={`Season ${se.rank} — ${se.keeper}, ${se.epithet}`}
      className="absolute right-2 top-2 rounded bg-space-1/85 px-1.5 py-0.5 text-[11px] font-bold">
      <span className={se.tone === "yang" ? "text-yang-ink" : se.tone === "yin" ? "text-yin-light" : undefined} style={toneStyle}>{se.rank}</span>
    </span>
  );
}

function fmtWhen(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString(uiLocale(), { year: "numeric", month: "short", day: "numeric" });
}
function mmss(s: number) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

const ILLUST_ASPECT: Record<string, string> = {
  "1:1": "aspect-square", "3:2": "aspect-[3/2]", "2:3": "aspect-[2/3]", "16:9": "aspect-video", "9:16": "aspect-[9/16]",
};

export const toWork = {
  book: (b: BookCard): WorkItem => ({
    kind: "book", id: b.id, to: `/read/${b.id}/`, title: b.title, author: b.author?.name, image: b.thumb,
    aspect: "aspect-[3/4]", meta: `${b.pages} pages · ${fmtWhen(b.created)}`, status: b.status, state: b.book_state, season: bornSeason(b.created),
  }),
  track: (t: TrackCard): WorkItem => ({
    kind: t.kind === "audiobook" ? "audiobook" : "music", id: t.id, to: `/listen/${t.id}/`, title: t.title,
    author: t.author?.name, image: t.cover, aspect: "aspect-square",
    meta: `▶ ${t.length} · ${t.plays.toLocaleString("en")} plays`,
    badge: t.kind === "audiobook" ? "Audiobook" : undefined, status: t.status, state: t.track_state, season: bornSeason(t.created),
  }),
  animation: (a: AnimationCard): WorkItem => ({
    kind: "animation", id: a.id, to: `/watch/${a.id}/`, title: a.title, author: a.author?.name, image: a.poster,
    aspect: "aspect-video", meta: `▶ ${a.length} · ${a.plays.toLocaleString("en")} plays`, status: a.status, state: a.anim_state, season: bornSeason(a.created),
  }),
  film: (f: FilmCard): WorkItem => ({
    kind: "film", id: f.id, to: `/film/${f.id}/`, title: f.title, author: f.author?.name, image: f.poster,
    aspect: "aspect-video", meta: `▶ ${f.length} · ${f.plays.toLocaleString("en")} plays`, status: f.status, state: f.film_state, season: bornSeason(f.created),
  }),
  illustration: (i: IllustrationCard): WorkItem => ({
    kind: "illustration", id: i.id, to: `/illustration/${i.id}/`, title: i.title, author: i.author?.name, image: i.image,
    aspect: ILLUST_ASPECT[i.aspect] || "aspect-square",
    meta: `${KIND_LABEL[i.kind] || "Artwork"}${i.rounds > 1 ? ` · refined ×${i.rounds}` : ""}`,
    status: i.status, state: i.art_state, season: bornSeason(i.created),
  }),
  paper: (s: Submission): WorkItem => ({
    kind: "paper", id: s.id, to: `/research/?submission=${s.id}`, title: s.title, author: s.author?.name,
    aspect: "aspect-[3/4]", meta: `${s.journal_name || "Journal"} · ${fmtWhen(s.created)}`,
    badge: s.score ? `Score ${s.score}` : undefined, season: bornSeason(s.created),
  }),
  // Curated video courses + Kaggle-style competitions aren't AI "works" (no brief→generate flow), but
  // they belong in the Library's overview shelves. They map to the SAME card via their own detail links.
  course: (c: CourseCard): WorkItem => ({
    kind: "course", id: c.id ?? 0, to: c.url, title: c.title, author: c.instructor || undefined, image: c.image,
    aspect: "aspect-video",
    meta: c.comments_per_day ? `${c.lessons} videos · ${c.comments_per_day.toFixed(1)}/day`
      : `${c.lessons} video${c.lessons === 1 ? "" : "s"}${c.comments_total ? ` · ${c.comments_total.toLocaleString("en")} comments` : ""}`,
    badge: c.pool ? `₳${c.pool} pool` : undefined, season: houseSeasonN(c.topic),
  }),
  competition: (c: CompetitionCard): WorkItem => ({
    kind: "competition", id: 0, to: `/competition/?slug=${encodeURIComponent(c.slug)}`, title: c.title,
    author: c.owner || undefined, aspect: "aspect-[3/2]",
    meta: `${c.status === "closed" ? "Closed" : "Open"} · ${c.n_teams || 0} team${c.n_teams === 1 ? "" : "s"}`,
    badge: c.prize ? `₳${c.prize}` : undefined,
  }),
};

/** On-brand cover when a work has no image yet — initials on the gold→blue gradient. */
export function CoverArt({ title, src, className }: { title: string; src?: string; className?: string }) {
  if (src) return <img src={src} alt="" loading="lazy" className={cx("h-full w-full object-cover", className)} />;
  const initials = (title.match(/\b\w/g) || []).slice(0, 2).join("").toUpperCase() || "A";
  return (
    <div className={cx("flex h-full w-full items-center justify-center bg-gradient-to-br from-yang/25 to-yin/25", className)}>
      <span className="text-2xl font-bold tracking-tight text-ink">{initials}</span>
    </div>
  );
}

/** ONE card for every kind — cover (kind-appropriate aspect), title, author, one meta line. */
export function WorkCard({ w }: { w: WorkItem }) {
  return (
    <Card as={Link} to={localePath(w.to)} className="group flex flex-col overflow-hidden no-underline transition hover:border-yin/40">
      <div className={cx("relative w-full overflow-hidden bg-space-2", w.aspect)}>
        <CoverArt title={w.title} src={w.image} />
        {(w.kind === "animation" || w.kind === "film" || w.kind === "course") && (
          <span className="absolute inset-0 grid place-items-center"><span className="grid h-11 w-11 place-items-center rounded-full bg-black/45 text-white backdrop-blur"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg></span></span>
        )}
        {w.badge && <span className="absolute left-2 top-2 rounded-full bg-space-1/85 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-ink-2">{w.badge}</span>}
        <WorkCardChip w={w} />
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <span className="line-clamp-2 font-semibold tracking-tight text-ink">{w.title}</span>
        {w.author && <span className="text-[12.5px] text-ink-3">by {w.author}</span>}
        <span className="mt-auto pt-2 text-[11.5px] text-ink-3">{w.meta}</span>
      </div>
    </Card>
  );
}

/* ───────────────────────── Unified studio analytics ───────────────────────── */

/** Studios with a FULL public transparency page beyond the strip (every round, verdict, recording). */
const STUDIO_RECORD: Partial<Record<WorkKind, string>> = {
  music: "/artasound/", audiobook: "/artasound/", illustration: "/artaillustration/", paper: "/artascience/",
};

// One fetch feeds every tab (the pulse covers ALL kinds); refetched after a minute at most.
let pulseCache: { at: number; p: Promise<StudioPulse> } | null = null;
function fetchPulse(): Promise<StudioPulse> {
  if (!pulseCache || Date.now() - pulseCache.at > 60_000) pulseCache = { at: Date.now(), p: getStudioPulse() };
  return pulseCache.p;
}

/* ───────────────────────── Creative Challenges chrome (2026-07-10) ───────────────────────── */

/** The challenge kinds — every content type holds a seasonal hearts competition (generalized
 *  2026-07-11): the six creative works + papers, datasets and models. */
export type HeartKind = "book" | "music" | "audiobook" | "animation" | "film" | "illustration" | "paper" | "dataset" | "model";

// One fetch feeds every challenge strip (the hub payload covers ALL kinds); 60s cache like the pulse.
let chalCache: { at: number; p: ReturnType<typeof ChallengesApi.list> } | null = null;
function fetchChallenges() {
  if (!chalCache || Date.now() - chalCache.at > 60_000) chalCache = { at: Date.now(), p: ChallengesApi.list() };
  return chalCache.p;
}

/** One line of challenge chrome for a Library grid tab: this season's pool + deadline + board link.
 *  The pool is the tab's strongest create incentive — publishing here IS the entry. */
export function ChallengeStrip({ kind }: { kind: MakeKind }) {
  const [c, setC] = useState<{ pool: number; entries: number; closes: string } | null>(null);
  useEffect(() => {
    let live = true;
    fetchChallenges().then((r) => {
      if (!live) return;
      const it = r.items.find((i) => i.system && i.kind === (kind as HeartKind));
      if (!it) return;
      const d = Math.floor(r.season.closes_in / 86400), h = Math.floor((r.season.closes_in % 86400) / 3600);
      setC({ pool: it.pool, entries: it.entries, closes: d > 0 ? `${d}d ${h}h` : `${h}h` });
    }).catch(() => { /* optional chrome */ });
    return () => { live = false; };
  }, [kind]);
  if (!c) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-card border border-yang/25 bg-yang/5 px-3 py-2 text-[13px] text-ink-2">
      <span className="font-semibold text-ink">This season's {WORK_KINDS[kind].label} Challenge</span>
      <span className="font-bold text-yang">₳{c.pool} pool</span>
      <span>· {c.entries} {c.entries === 1 ? "entry" : "entries"} · closes in {c.closes}</span>
      <span>· publishing enters your work</span>
      <Link to={localePath(`/challenges/${kind}/`)} className="ms-auto font-semibold text-yin-light no-underline hover:underline">Board <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></Link>
    </p>
  );
}

/** THE heart a work detail page wears — one gold heart per member per work, never your own.
 *  Self-contained: fetches the count + the caller's heart, casts optimistically, reconciles to the
 *  server. Signed-out (or own-work) renders the count statically; the server refuses self-hearts
 *  anyway (403) — `authorSlug` just spares the round-trip. */
export function WorkHeart({ kind, id, authorSlug }: { kind: HeartKind; id: number; authorSlug?: string }) {
  const [st, setSt] = useState<{ hearts: number; my: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const logged = isLoggedIn();
  const mine = !!authorSlug && currentUser()?.slug === authorSlug;
  useEffect(() => {
    let live = true;
    ChallengesApi.workHearts(kind, id).then((r) => { if (live) setSt({ hearts: r.hearts, my: r.my_vote }); }, () => {});
    return () => { live = false; };
  }, [kind, id]);
  if (!st) return null;
  if (!logged || mine) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-line px-2.5 py-1 text-[13px] font-bold tabular-nums text-ink-2"
        title={mine ? "You can’t heart your own work — hearts come from peers" : "Sign in to heart this"}>
        <HeartGlyph size={16} /> {st.hearts}
      </span>
    );
  }
  const cast = async () => {
    if (busy) return;
    const want = st.my === 1 ? 0 : 1;
    const prev = st;
    setBusy(true);
    setSt({ my: want, hearts: st.hearts + (want === 1 ? 1 : -1) });
    try {
      const r = await ChallengesApi.heart(kind, id, want as 1 | 0);
      setSt({ my: r.my_vote, hearts: r.hearts });
    } catch { setSt(prev); } finally { setBusy(false); }
  };
  return (
    <button type="button" onClick={cast} disabled={busy} aria-pressed={st.my === 1}
      aria-label={st.my === 1 ? "Remove heart" : "Heart this work"}
      title="Hearts rank this season's challenge board"
      className={cx("inline-flex shrink-0 touch-manipulation items-center gap-1.5 rounded-pill border px-2.5 py-1 text-[13px] font-bold tabular-nums transition-colors disabled:opacity-50",
        st.my === 1 ? "border-yang/50 bg-yang/15 text-yang" : "border-line text-ink-3 hover:border-yang/50 hover:text-ink")}>
      <HeartGlyph size={16} filled={st.my === 1} /> {st.hearts}
    </button>
  );
}

/** ONE analytics strip for every studio kind — the same live counters (daemon liveness, queue,
 *  works in progress, drafts ready to review, published, critic rounds) on every Library tab,
 *  mirroring the studios' transparency pages. */
export function StudioPulseStrip({ kind }: { kind: MakeKind }) {
  const [pulse, setPulse] = useState<StudioPulse | null>(null);
  useEffect(() => {
    let live = true;
    fetchPulse().then((p) => { if (live) setPulse(p); }).catch(() => { /* the strip is optional chrome */ });
    return () => { live = false; };
  }, []);
  const k = pulse?.kinds[kind];
  if (!pulse || !k) return null;
  const record = STUDIO_RECORD[kind];
  const stats: [string, number][] = [
    ["queued", k.queued], ["in the studio", k.processing], ["ready to review", k.in_review],
    ["published", k.published], ...(k.rounds_total > 0 ? [["review rounds (24h)", k.rounds_24h] as [string, number]] : []),
  ];
  return (
    <Card className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3" aria-label={`${WORK_KINDS[kind].studio} studio analytics`}>
      <span className="flex items-center gap-2 text-[12.5px] font-semibold text-ink">
        <span className={cx("h-2 w-2 rounded-full", k.online ? "bg-yang" : "bg-line")} aria-hidden />
        {WORK_KINDS[kind].studio}
        <span className="font-normal text-ink-3">{k.online ? "online now" : "offline — the queue waits"}</span>
      </span>
      {stats.map(([label, n]) => (
        <span key={label} className="text-[12.5px] text-ink-3"><b className="tabular-nums text-ink">{n.toLocaleString("en")}</b> {label}</span>
      ))}
      <span className="text-[12.5px] text-ink-3">{pulse.model} · +{pulse.points_per_coin} points per ₳1 published</span>
      {record && (
        <Link to={localePath(record)} className="ml-auto text-[12.5px] font-semibold text-yin-light no-underline hover:underline">
          Full studio record <span aria-hidden className="inline-block rtl:-scale-x-100">→</span>
        </Link>
      )}
    </Card>
  );
}

/* ───────────────────────── Unified create ───────────────────────── */

type Voice = { id: string; lang: string; gender: string; name: string };
const VOICES = EDGE_VOICES as Voice[];
const VOICE_LANGS = [...new Set(VOICES.map((v) => v.lang))].sort();
function langName(code: string) {
  try { return `${new Intl.DisplayNames(["en"], { type: "language" }).of(code.split("-")[0]) || code} (${code})`; } catch { return code; }
}

const CREATABLE: MakeKind[] = ["book", "music", "audiobook", "animation", "film", "illustration", "paper"];

/** Per-kind intro line — each studio keeps its voice inside the one form. */
const INTRO: Record<MakeKind, ReactNode> = {
  book: <>ArtaPublishing is your AI editor — Claude Opus 5, Anthropic's flagship model, at maximum effort. Describe the book you want; optionally add a PDF as inspiration. The editor writes a completely original book — no copying — that is published as <strong>your own work</strong>.</>,
  music: <>ArtaSound is your AI studio. Describe the music; optionally add a track as inspiration. It composes a completely original piece — no copying — then puts it through rounds of critique and improvement before you hear it. Published as <strong>your own work</strong>.</>,
  audiobook: <>ArtaSound narrates <strong>your own writing</strong> sentence by sentence in any of ~300 voices. Long books are fine — the studio works through them steadily and tells you when it's done.</>,
  animation: <>ArtaMotion scripts a 3Blue1Brown-style explainer of your topic in the ArtaQuest style, then renders it to video — published as <strong>your own work</strong>. Optionally add reference images.</>,
  film: <>ArtaFilm is your AI video studio. Describe the video — for your music, book, course, or anything — and it films a completely original short with a state-of-the-art text-to-video model, published as <strong>your own work</strong>.</>,
  illustration: <>ArtaIllustration is your AI art studio. Describe the picture — a standalone artwork, a cover for one of your books, or a plate inside it — and the studio paints it with state-of-the-art open models, then <strong>improves it over adversarial rounds</strong>: an AI critic inspects every render and directs targeted fixes until it holds up. Every round is public.</>,
  paper: <>ArtaScience runs the journals: submit a LaTeX manuscript with open data + code, and an AI reviewer <strong>reproduces your results</strong> before anything is accepted — no fees, CC BY 4.0, DOIs minted on acceptance.</>,
};

const RIGHTS: Partial<Record<MakeKind, string>> = {
  book: "This will be my own original work. Any material I upload is for private inspiration only — I have the right to use it, and I am not asking for anyone else's text to be copied.",
  music: "This will be my own original work. Any audio I upload is for private inspiration only — I have the right to use it, and I am not asking for anyone else's music to be copied.",
  audiobook: "This manuscript is my own original work and I have the right to publish it as an audiobook.",
  animation: "This will be my own original work. Any image I upload is for private reference only — I have the right to use it, and I am not asking for anyone else's work to be copied.",
  film: "This will be my own original work",
  illustration: "This will be my own original work",
};

function LengthPills({ presets, value, onPick, min, max, onCustom }: { presets: number[]; value: number; onPick: (s: number) => void; min: number; max: number; onCustom: (s: number) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {presets.map((s) => (
        <button key={s} type="button" onClick={() => onPick(s)}
          className={cx("rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors",
            value === s ? "border-yin bg-yin/10 text-ink" : "border-line text-ink-3 hover:border-yin/50")}>
          {mmss(s)}
        </button>
      ))}
      <Input type="number" min={min} max={max} value={value}
        onChange={(e) => onCustom(Math.max(min, Math.min(max, Number(e.target.value) || min)))} className="w-24" aria-label="Custom length in seconds" />
    </div>
  );
}

/** The ONE create form for the whole studio family. Pick what to make; the shared fields stay put
 *  (title · brief · rights · cost-on-publish) and only the kind's own extras swap in. Papers keep
 *  their academic flow — the picker hands off to the journal's submission form. */
/** The shelf-quota meter (Creative Challenges, 2026-07-10): live published works vs the member's
 *  tier quota. Informative only — the server enforces the 409 shelf_full gate at publish; this
 *  tells the member BEFORE they invest a brief that their shelf is full, and that pruning weaker
 *  work (which frees the slot, never refunds the fee) is the way to keep publishing. */
function ShelfMeter() {
  const [shelf, setShelf] = useState<{ used: number; quota: number; tier: string } | null>(null);
  useEffect(() => { ChallengesApi.shelf().then(setShelf, () => {}); }, []);
  if (!shelf || shelf.quota <= 0) return null; // unlimited (Legend/operator) or not loaded — say nothing
  const full = shelf.used >= shelf.quota;
  return (
    <p className={cx("rounded-card border px-3 py-2 text-[13px]", full ? "border-yang/40 bg-yang/10 text-ink" : "border-line text-ink-3")}>
      Shelf: <strong className="tabular-nums">{shelf.used} of {shelf.quota}</strong> published works ({shelf.tier} tier).{" "}
      {full
        ? "Your shelf is full — retire a weaker work (or earn the next tier) to publish this one. Hearts follow your best work."
        : "Each tier holds a bigger shelf; curate it — hearts follow your best work."}
    </p>
  );
}

export function CreateWork({ initialKind = "book", onDone }: { initialKind?: MakeKind; onDone: () => void }) {
  const nav = useNavigate();
  const [kind, setKind] = useState<MakeKind>(initialKind);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [file, setFile] = useState<File | null>(null);
  // book
  const [pages, setPages] = useState(30);
  // music / animation / film
  const [seconds, setSeconds] = useState(150);
  // audiobook
  const [manuscript, setManuscript] = useState("");
  const [lang, setLang] = useState("en-US");
  const [voice, setVoice] = useState("en-US-AndrewMultilingualNeural");
  // illustration
  const [style, setStyle] = useState("");
  const [artKind, setArtKind] = useState<"art" | "cover" | "plate">("art");
  const [aspect, setAspect] = useState("1:1");
  const [bookId, setBookId] = useState(0);
  const [books, setBooks] = useState<BookCard[] | null>(null);

  const pick = (k: MakeKind) => {
    setKind(k); setErr(""); setFile(null);
    // sensible per-kind length defaults (mirror the studios' old standalone forms)
    if (k === "music") setSeconds(150);
    if (k === "animation") setSeconds(60);
    if (k === "film") setSeconds(20);
  };
  useEffect(() => { if (kind === "illustration" && artKind !== "art" && books === null) myBooks().then((r) => setBooks(r.items)).catch(() => setBooks([])); }, [kind, artKind, books]);
  const words = useMemo(() => (manuscript.match(/\S+/g) || []).length, [manuscript]);
  const voicesForLang = useMemo(() => VOICES.filter((v) => v.lang === lang), [lang]);
  useEffect(() => { if (voicesForLang.length && !voicesForLang.some((v) => v.id === voice)) setVoice(voicesForLang[0].id); }, [voicesForLang, voice]);

  // Cost mirrors each backend's cost_for_* — the member sees the price before they start.
  const cost = kind === "book" ? Math.max(1, pages)
    : kind === "music" ? Math.max(1, Math.ceil(seconds / 30))
    : kind === "audiobook" ? Math.max(1, Math.ceil(words / 2000))
    : kind === "animation" ? Math.max(1, Math.ceil(seconds / 30)) * 2
    : kind === "film" ? Math.max(1, Math.ceil(seconds / 5)) * 2
    : 2; // illustration

  async function submit() {
    setErr("");
    if (!title.trim()) return setErr(`Give the ${WORK_KINDS[kind].label.toLowerCase()} a title`);
    if (kind === "audiobook") { if (manuscript.trim().length < 100) return setErr("Paste the manuscript to narrate — at least a paragraph"); }
    else if (!brief.trim()) return setErr(`Describe the ${WORK_KINDS[kind].label.toLowerCase()} you want`);
    if (kind === "illustration" && artKind !== "art" && !bookId) return setErr("Pick which of your books this is for");
    if (!rights) return setErr("Please confirm the authorship & rights statement");
    setBusy(true);
    try {
      const t = title.trim(), b = brief.trim();
      let to = "";
      if (kind === "book") { const w = await createBook({ title: t, brief: b, pages, rights_ok: true, generate: true }, file ?? undefined); to = `/read/${w.id}/`; }
      else if (kind === "music") { const w = await createTrack({ title: t, brief: b, seconds, rights_ok: true, generate: true }, file ?? undefined); to = `/listen/${w.id}/`; }
      else if (kind === "audiobook") { const w = await createTrack({ title: t, kind: "audiobook", manuscript: manuscript.trim(), voice, rights_ok: true, generate: true }); to = `/listen/${w.id}/`; }
      else if (kind === "animation") { const w = await createAnimation({ title: t, brief: b, seconds, rights_ok: true, generate: true }, file ?? undefined); to = `/watch/${w.id}/`; }
      else if (kind === "film") { const w = await createFilm({ title: t, brief: b, seconds, rights_ok: true, generate: true }); to = `/film/${w.id}/`; }
      else { const w = await createIllustration({ title: t, brief: b, style: style.trim() || undefined, kind: artKind, ...(artKind !== "art" ? { book_id: bookId } : {}), aspect: artKind === "cover" ? "2:3" : aspect, rights_ok: true, generate: true }); to = `/illustration/${w.id}/`; }
      onDone();
      nav(localePath(to));
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Could not start the project"); setBusy(false); }
  }

  const fileField = (accept: string, label: string, hint: string) => (
    <Field label={label} optional>
      <input type="file" accept={accept} onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="block w-full text-[13px] text-ink-2 file:me-3 file:rounded-md file:border-0 file:bg-space-3 file:px-3 file:py-1.5 file:text-ink" />
      <p className="mt-1 text-[12px] text-ink-3">{hint}</p>
    </Field>
  );

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="text-[20px] font-bold tracking-tight">Create</h2>
        <p className="mt-1 text-[13px] text-ink-3">One studio, one process: brief it, the AI makes an original draft, public review rounds improve it, and you publish it under your name — and every published work enters its kind's seasonal Creative Challenge.</p>
      </div>
      <ShelfMeter />
      {/* what to make */}
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="What do you want to make?">
        {CREATABLE.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => pick(k)}
            className={cx("rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors",
              kind === k ? "border-yin bg-yin/10 text-ink" : "border-line text-ink-3 hover:border-yin/50")}>
            {WORK_KINDS[k].label}
          </button>
        ))}
      </div>
      <p className="text-[13px] text-ink-3">{INTRO[kind]}</p>

      {kind === "paper" ? (
        <div><Button href={localePath("/research/")}>Go to the journals <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></Button></div>
      ) : (
        <>
          <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`The title of your ${WORK_KINDS[kind].label.toLowerCase()}`} maxLength={255} /></Field>

          {kind !== "audiobook" && (
            <Field label="Your brief">
              <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={kind === "book" || kind === "animation" ? 5 : 4}
                placeholder={kind === "book" ? "What is the book about? Who is it for? What should it cover, in what voice and structure? The more you say, the closer it lands."
                  : kind === "music" ? "What's the mood, genre, instruments, tempo, energy? The more you say, the closer it lands."
                  : kind === "animation" ? "What concept should it explain, and how? The intuition to build, the steps to show, the visuals you imagine. The more you say, the closer it lands."
                  : kind === "film" ? "What should the video show? The mood, the scenes, the story. The more vivid, the better it films."
                  : "What should the picture show? Subject, setting, mood, light. The more vivid, the better it paints."} />
            </Field>
          )}

          {kind === "book" && (
            <>
              <Field label="Length (pages)">
                <Input type="number" min={1} max={1000} value={pages} onChange={(e) => setPages(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))} />
                <p className="mt-1 text-[12px] text-ink-3">Up to 1,000 pages — long books are written chapter by chapter, part by part, so a big one takes hours rather than minutes. Publishing will cost ₳{cost} ({pages} page{pages === 1 ? "" : "s"} × ₳1). Writing the draft is free; you only pay when you publish.</p>
              </Field>
              {fileField("application/pdf", "Inspiration PDF", "A born-digital PDF (real text — scans are rejected). Used privately as inspiration only; never shared or published. You can add more on the next screen.")}
            </>
          )}

          {kind === "music" && (
            <>
              <Field label="Length">
                <LengthPills presets={[60, 120, 150, 180, 240]} value={seconds} onPick={setSeconds} min={1} max={600} onCustom={setSeconds} />
                <p className="mt-1.5 text-[12px] text-ink-3">Publishing will cost ₳{cost} ({mmss(seconds)} · ₳1 per 30s). A full song is usually 2–4 minutes. Composing the draft is free; you only pay when you publish.</p>
              </Field>
              {fileField("audio/*", "Inspiration track", "An audio file (mp3/wav/m4a/flac). Used privately as inspiration only; never shared or published. Add more on the next screen.")}
            </>
          )}

          {kind === "audiobook" && (
            <>
              <Field label="Your manuscript">
                <Textarea value={manuscript} onChange={(e) => setManuscript(e.target.value)} rows={10}
                  placeholder="Paste the full text to narrate — your own writing. Paragraphs and headings read naturally." />
                <p className="mt-1 text-[12px] text-ink-3">{words.toLocaleString("en")} words · publishing will cost ₳{cost} (₳1 per 2,000 words). Narrating the draft is free; you only pay when you publish.</p>
              </Field>
              <Field label="Voice">
                <div className="flex flex-wrap gap-2">
                  <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Language"
                    className="rounded-md border border-line bg-space-2 px-2.5 py-1.5 text-[13px] text-ink">
                    {VOICE_LANGS.map((l) => <option key={l} value={l}>{langName(l)}</option>)}
                  </select>
                  <select value={voice} onChange={(e) => setVoice(e.target.value)} aria-label="Voice"
                    className="rounded-md border border-line bg-space-2 px-2.5 py-1.5 text-[13px] text-ink">
                    {voicesForLang.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.gender})</option>)}
                  </select>
                </div>
              </Field>
            </>
          )}

          {kind === "animation" && (
            <>
              <Field label="Length (seconds)">
                <Input type="number" min={1} max={600} value={seconds} onChange={(e) => setSeconds(Math.max(1, Math.min(600, Number(e.target.value) || 1)))} />
                <p className="mt-1 text-[12px] text-ink-3">Publishing will cost ₳{cost} ({mmss(seconds)} · ₳2 per 30s — rendering is heavy). Rendering the draft is free; you only pay when you publish.</p>
              </Field>
              {fileField("image/*", "Reference image", "An image (png/jpg/svg). Used privately as reference only; never published. Add more on the next screen.")}
            </>
          )}

          {kind === "film" && (
            <Field label="Length">
              <LengthPills presets={[8, 12, 20, 32, 48]} value={seconds} onPick={setSeconds} min={4} max={120} onCustom={setSeconds} />
              <p className="mt-1.5 text-[12px] text-ink-3">Publishing will cost ₳{cost} ({mmss(seconds)} · ₳2 per 5s — video is heavy). Filming the draft is free; you only pay when you publish. It renders scene by scene in the background.</p>
            </Field>
          )}

          {kind === "illustration" && (
            <>
              <Field label="Style (optional)"><Input value={style} onChange={(e) => setStyle(e.target.value)} placeholder="e.g. gouache, woodcut, cinematic photo, children's-book watercolour" maxLength={255} /></Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="What is it for?">
                  <div className="flex flex-wrap gap-1.5">
                    {(["art", "cover", "plate"] as const).map((k) => (
                      <button key={k} type="button" onClick={() => { setArtKind(k); if (k === "cover") setAspect("2:3"); }}
                        className={cx("rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors", artKind === k ? "border-yin bg-yin/10 text-ink" : "border-line text-ink-3 hover:border-yin/50")}>
                        {KIND_LABEL[k]}
                      </button>
                    ))}
                  </div>
                  {artKind !== "art" && (
                    <div className="mt-2">
                      {books === null ? <p className="text-[12px] text-ink-3">Loading your books…</p> : books.length === 0 ? (
                        <p className="text-[12px] text-ink-3">You have no books yet — write one first, then commission its art.</p>
                      ) : (
                        <Select label="Which of your books" value={String(bookId || "")} onChange={(v) => setBookId(Number(v) || 0)}
                          options={[{ value: "", label: "Choose a book…" }, ...books.map((b) => ({ value: String(b.id), label: b.title }))]} />
                      )}
                    </div>
                  )}
                </Field>
                <Field label="Shape">
                  <div className="flex flex-wrap gap-1.5">
                    {["1:1", "3:2", "2:3", "16:9", "9:16"].map((a) => (
                      <button key={a} type="button" onClick={() => setAspect(a)} disabled={artKind === "cover" && a !== "2:3"}
                        className={cx("rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors disabled:opacity-40",
                          (artKind === "cover" ? "2:3" : aspect) === a ? "border-yin bg-yin/10 text-ink" : "border-line text-ink-3 hover:border-yin/50")}>
                        {a}
                      </button>
                    ))}
                  </div>
                  {artKind === "cover" && <p className="mt-1.5 text-[12px] text-ink-3">A book cover is always portrait (2:3), painted with no lettering — your title is set as type on top.</p>}
                </Field>
              </div>
              <p className="text-[12px] text-ink-3">Publishing will cost ₳2. Painting the draft — including all its improvement rounds — is free; you only pay when you publish.</p>
            </>
          )}

          <CheckField checked={rights} onChange={setRights}>
            <span className="text-[12.5px] text-ink-3">{RIGHTS[kind]}</span>
          </CheckField>
          {err && <StatusNote error>{err}</StatusNote>}
          <div className="flex items-center gap-2">
            <Button onClick={submit} disabled={busy}>{busy ? "Starting…" : WORK_KINDS[kind].createLabel}</Button>
            <Button variant="ghost" onClick={onDone} disabled={busy}>Cancel</Button>
          </div>
        </>
      )}
    </Card>
  );
}
