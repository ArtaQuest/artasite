import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import {
  Courses, Studio as StudioApi, StudioTopics, StudioGrants, ConsoleApi, Members as MembersApi, Disciplines as DisciplinesApi, Trends as TrendsApi, Videos as VideosApi, HousesApi,
  type StudioMember, type Discipline, type DisciplineRegistry, type TrendSeries, type VideoRow,
  type StudioHouse, type HousesQueue,
  type StudioCourse, type StudioCourseDetail, type StudioLesson,
  type StudioTopic, type StudioTopicCard, type StudioTopicSave,
  type TopicOption, type TopicDimension, type TopicCitation,
  type StudioGrant, type StudioGrantCard, type StudioGrantSave,
  type ConsoleSnapshot, type ConsoleLastRun, type CourseInsights,
  ArtaaiApi, type ArtaaiSnapshot, type ArtaaiSurface,
} from "../lib/api";
import { myBooks, type BookCard, myTracks, type TrackCard, myAnimations, type AnimationCard, myIllustrations, type IllustrationCard } from "../lib/api";
import { Shop as ShopFrontApi, type ShopProduct, type ShopOrder } from "../lib/api";
import TrendChart from "../components/TrendChart";
import { getCreatorStatus, isLoggedIn, localePath, type CreatorStatus } from "../lib/wp";
import { Button, Card, CheckField, Field, Input, PageHero, SearchPill, Select, SignInGate, SkeletonGrid, StatusNote, Tabs, Textarea, cx, type ButtonTip } from "../components/ui";
import { ImageInput } from "../components/ImageInput";
import { FIELDS, PEDAGOGIES, PEDAGOGY_LABEL, MOTIVATION_LABEL, CATEGORY_GROUPS } from "../lib/typology-meta";
import { BalancePanel, balancePct } from "../components/balance";
import { HealthPanel } from "../components/health";
import { KIND_LABEL } from "../components/studio";

/* Creator Studio — create and edit YOUR courses (operator rule 2026-06-12: creator tiers have all
   edit access to their courses). List → editor; lesson edits run through the backend's
   ID-preserving sync, so learner progress/boards/votes survive and an edited course re-earns its
   trending rank from zero (the standard content-change reset).

   A second mode edits TOPICS — the DB-backed typology systems (the author or an operator can change
   anything about a topic, to enable diverse formats). The two modes share the same gate + style. */

type Mode = "courses" | "books" | "music" | "animations" | "illustrations" | "topics" | "grants" | "artaai" | "console" | "members" | "disciplines" | "videos" | "houses" | "shop" | "health";

// Offline/initial FALLBACK for the course editor's House picker: the 12 fields (Psychology … Spirituality)
// from the bundled registry. At runtime the picker PREFERS the LIVE backend houses (Disciplines.list() →
// houses — the SAME source the "Courses balance" What·field balance chart reads, with operator label overrides
// applied server-side), so it reflects an operator's Labels-tab renames immediately and can never drift
// from the universal house field. This bundled list (a page-load snapshot of window.AQ_LABELS, which does
// NOT refresh after an in-session rename) only shows until that fetch resolves, or if it can't load. slug → label.
const HOUSES: ReadonlyArray<readonly [string, string]> = FIELDS.map((g) => [g.key, g.label] as const);

// Detailed methodology explainer per discovery-pipeline job (Console "Run …" buttons).
const JOB_TIPS: Record<string, ButtonTip> = {
  discover: { title: "Discover candidates", body: "Rotates through the catalogue and searches each course's tuned keywords on YouTube, scores results by recent comment velocity (not lifetime totals, so it skips old saturated videos), and tracks the most promising new one as a 24-hour candidate. It never adds a video to a course directly." },
  settle: { title: "Settle — prove, then add", body: "Judges every candidate whose 24-hour trial has elapsed. A thin course (under 5 videos) gains any genuinely-active video; a full course only gains one discussed at least as much as its average. Anything weaker is discarded." },
  prune: { title: "Prune the persistent lows", body: "For a course with more than 5 videos, drops any whose comment rate sits more than 2 standard deviations below the course mean — never below a 2-video floor. A single popular video widens the spread, which deliberately protects the rest." },
  trend_sweep: { title: "Re-score trending ranks", body: "Recomputes every course's trending rank from its videos' current comment rates. Pure database work, no quota — the same sweep the hourly cron runs." },
  refresh: { title: "Refresh comment counts", body: "Fetches the latest YouTube comment counts for the videos that are due and recomputes their per-day rates. One cheap batched call per 50 videos." },
  seed: { title: "Seed discussion boards", body: "Gives any unseeded video a starter card built from its own top YouTube comment, so a board is never empty when learners arrive." },
  purge: { title: "Purge dead content", body: "Removes videos measured at zero comments per day, and any course left with no videos — tombstoning the slug so a redeploy can't resurrect it." },
};

// One-line explainer per Studio tab (shown on hover).
const TAB_TIPS: Record<Mode, string> = {
  courses: "Create and edit courses",
  books: "Your ArtaPublishing books — write new ones and open your drafts",
  music: "Your ArtaSound tracks — compose new ones and open your drafts",
  animations: "Your ArtaMotion animations — script new ones and open your drafts",
  illustrations: "Your ArtaIllustration artwork — commission new pieces, book covers and plates",
  topics: "Edit the typology topics — the DB-backed personality/identity systems",
  grants: "Edit sponsors and grant opportunities",
  artaai: "Operator: monitor and control every AI system on the platform",
  console: "Operator: monitor and control the video-discovery pipeline",
  members: "Operator: the member directory — grant course-creation access",
  disciplines: "Operator: disciplines under each house + the house-distribution chart",
  videos: "Operator: every tracked video — state, metadata, and incubating candidates",
  houses: "Operator: the 12 houses — add fields for sidereal analysis or purge existing ones",
  shop: "Operator: ArtaShop — hard-copy products (books, games, prints, merch) + order fulfilment",
  health: "Operator: is the app the browser gets the app we built — build, routes, schema, brand, jobs",
};

export default function Studio() {
  const [status, setStatus] = useState<CreatorStatus | null | undefined>(undefined);
  const [courses, setCourses] = useState<StudioCourse[] | null>(null);
  const [scope, setScope] = useState<"own" | "all">("own");
  const [mode, setMode] = useState<Mode>("courses");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<StudioCourseDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { if (isLoggedIn()) { getCreatorStatus().then(setStatus).catch(() => setStatus(null)); } }, []);
  useEffect(() => {
    if (status?.caps?.can_create) { StudioApi.list().then((r) => { setCourses(r.items); setScope(r.scope ?? "own"); }).catch(() => setErr("Couldn't load your courses — please refresh.")); }
  }, [status]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (courses ?? []).filter((c) => !needle || c.title.toLowerCase().includes(needle) || c.slug.includes(needle));
  }, [courses, q]);

  if (!isLoggedIn()) return <SignInGate title="Console" body="Sign in to open the operator console." />;
  if (status === undefined) return <SkeletonGrid count={6} />;
  if (!status?.caps?.can_create) {
    return (
      <div className="flex flex-col gap-4">
        <PageHero title="Console" lede="The operator console." />
        <StatusNote>The Console unlocks at the <strong>Creator</strong> tier (1,000 points). Keep publishing, replying and contributing — your points add up. (The Studio, where you submit a Kaggle notebook, needs nothing but an account.)</StatusNote>
      </div>
    );
  }

  const openEditor = async (id: number) => {
    setErr("");
    try { setEditing(await StudioApi.get(id)); window.scrollTo({ top: 0 }); }
    catch { setErr("Couldn't open that course."); }
  };

  const switchMode = (m: Mode) => { setMode(m); setQ(""); setEditing(null); setCreating(false); setErr(""); };

  return (
    <div className="flex flex-col gap-5">
      <PageHero title="Console" lede="The operator console — books, music, topics, sponsors and the surfaces the platform is run from. To publish a Kaggle notebook, use the Studio." />

      <Tabs label="Studio sections" active={mode} onChange={(k) => switchMode(k as Mode)}
        tabs={(([["courses", "Courses"], ["books", "Books"], ["music", "Music"], ["animations", "Animations"], ["illustrations", "Illustrations"], ["topics", "Topics"], ["grants", "Sponsors"], ...(status?.operator ? [["health", "Health"], ["artaai", "ArtaAI"], ["shop", "Shop"], ["houses", "Houses"], ["disciplines", "Disciplines"], ["videos", "Videos"], ["console", "Console"], ["members", "Members"]] : [])]) as [Mode, string][]).map(([m, label]) => ({ key: m, label, title: TAB_TIPS[m] }))} />

      {err && <StatusNote error>{err}</StatusNote>}

      {mode === "books" ? (
        <BooksMode />
      ) : mode === "music" ? (
        <MusicMode />
      ) : mode === "animations" ? (
        <AnimationsMode />
      ) : mode === "illustrations" ? (
        <IllustrationsMode />
      ) : mode === "health" ? (
        <HealthPanel />
      ) : mode === "artaai" ? (
        <ArtaaiMode />
      ) : mode === "houses" ? (
        <HousesMode />
      ) : mode === "disciplines" ? (
        <DisciplinesMode />
      ) : mode === "videos" ? (
        <VideosMode />
      ) : mode === "console" ? (
        <ConsoleMode />
      ) : mode === "members" ? (
        <MembersMode />
      ) : mode === "shop" ? (
        <ShopMode />
      ) : mode === "topics" ? (
        <TopicsMode />
      ) : mode === "grants" ? (
        <GrantsMode />
      ) : editing ? (
        <Editor course={editing} onClose={(refresh) => { setEditing(null); if (refresh) StudioApi.list().then((r) => setCourses(r.items)).catch(() => {}); }} />
      ) : creating ? (
        <CreateForm onClose={(created) => { setCreating(false); if (created) openEditor(created); }} />
      ) : (
        <>
          {scope === "all" && <StatusNote>Operator view — all {courses?.length ?? 0} published courses; you can open and edit any of them.</StatusNote>}
          {status?.operator && <DistBalance metric="courses" />}
          <div className="flex flex-wrap items-center gap-3">
            <SearchPill value={q} onChange={setQ} placeholder={`Search ${scope === "all" ? "all" : "your"} ${courses?.length ?? ""} courses…`} className="max-w-sm flex-1" />
            <Button tip="Start a new course from scratch" onClick={() => setCreating(true)}>New course</Button>
          </div>
          {courses === null ? <SkeletonGrid count={6} /> : (
            /* auto-fit, not `sm:`/`lg:` (operator 2026-08-21). `sm:` and `lg:` are VIEWPORT queries, and the
                shell's right column leaves this page a ~686px content column at a 1440px window, ~570px at
                1280, ~410px at 1100 and ~366px at 1024 — so `lg:grid-cols-3` fired at the very pixel the right
                column appeared and cut a 366px column into three 114px cards, clipping the trending rate off
                every one of them. Each card now asks for 13rem and the row takes as many as fit: three at 1440
                (~220px each), two at 1280 (~279px), one from 1024 down (~366px) — no breakpoint to be wrong. */
            <ul className="grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-3">
              {filtered.map((c) => (
                <li key={c.id}>
                  <button type="button" title="Open this course to edit its details, videos and analytics" onClick={() => openEditor(c.id)}
                    className="group flex h-full w-full flex-col overflow-hidden rounded-card border border-line bg-veil/[0.02] text-start transition-colors hover:border-yang/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yang/60">
                    {c.image && <img src={c.image} alt="" loading="lazy" className="aspect-video w-full object-cover" />}
                    <span className="flex flex-1 flex-col gap-1 p-3">
                      <span className="font-semibold leading-snug text-ink transition-colors group-hover:text-yang">{c.title}</span>
                      <span className="mt-auto flex flex-wrap items-center gap-2 pt-1 text-[12px] text-ink-3">
                        <span>{c.lessons} videos</span><span>· ₳{c.price}</span>
                        {c.comments_per_day > 0 && <span className="font-semibold text-yang">▲ {c.comments_per_day.toLocaleString("en")}/day</span>}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

// ── Books (ArtaPublishing): the member's own books — write new ones, open drafts/published ─────────
function bookStateLabel(status?: string, state?: string): string {
  if (status === "published") return "Published";
  switch (state) {
    case "queued": return "Queued to write";
    case "processing": return "Writing…";
    case "review": return "Ready to review";
    case "failed": return "Write failed";
    default: return "Draft";
  }
}
function BooksMode() {
  const [books, setBooks] = useState<BookCard[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { myBooks().then((r) => setBooks(r.items)).catch(() => setErr("Couldn't load your books — please refresh.")); }, []);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (books ?? []).filter((b) => !needle || b.title.toLowerCase().includes(needle));
  }, [books, q]);
  return (
    <>
      {err && <StatusNote error>{err}</StatusNote>}
      <div className="flex flex-wrap items-center gap-3">
        <SearchPill value={q} onChange={setQ} placeholder={`Search your ${books?.length ?? ""} books…`} className="max-w-sm flex-1" />
        <Button href="/library" tip="Brief the AI editor and publish an original book">Write a book</Button>
      </div>
      {books === null ? <SkeletonGrid count={6} /> : books.length === 0 ? (
        <StatusNote>You haven't written a book yet. <a className="font-semibold text-yin-light hover:underline" href={localePath("/library/")}>Write your first one</a> — brief the AI editor, review the draft, and publish it under your name.</StatusNote>
      ) : (
        /* auto-fit, not `sm:`/`lg:` (operator 2026-08-21) — see the courses grid above. This column is
            ~686px at 1440 and ~366px at 1024, where three tracks left 114px a book. 13rem a card gives
            three at 1440, two at 1280 and one full-width card from 1024 down. */
        <ul className="grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-3">
          {filtered.map((b) => (
            <li key={b.id}>
              <a href={localePath(`/read/${b.id}/`)} title="Open this book"
                className="group flex h-full w-full flex-col overflow-hidden rounded-card border border-line bg-veil/[0.02] text-start no-underline transition-colors hover:border-yang/40">
                {b.thumb
                  ? <img src={b.thumb} alt="" loading="lazy" className="aspect-[3/4] w-full object-cover" />
                  : <span className="flex aspect-[3/4] w-full items-center justify-center bg-gradient-to-br from-yang/25 to-yin/25 text-2xl font-bold text-ink">{(b.title.match(/\b\w/g) || []).slice(0, 2).join("").toUpperCase() || "A"}</span>}
                <span className="flex flex-1 flex-col gap-1 p-3">
                  <span className="font-semibold leading-snug text-ink transition-colors group-hover:text-yang">{b.title}</span>
                  <span className="mt-auto flex flex-wrap items-center gap-2 pt-1 text-[12px] text-ink-3">
                    <span className="rounded-full bg-veil/[0.06] px-2 py-0.5 font-medium">{bookStateLabel(b.status, b.book_state)}</span>
                    <span>{b.pages} pages</span>
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ── Music (ArtaSound): the member's own tracks ────────────────────────────────────────────────────
function mediaStateLabel(status: string | undefined, state: string | undefined, verb: string): string {
  if (status === "published") return "Published";
  switch (state) {
    case "queued": return "Queued";
    case "processing": return verb;
    case "review": return "Ready to review";
    case "failed": return "Failed";
    default: return "Draft";
  }
}
function MediaInitials({ title, fallback }: { title: string; fallback: string }) {
  return <span className="flex h-full w-full items-center justify-center bg-gradient-to-br from-yang/25 to-yin/25 text-xl font-bold text-ink">{(title.match(/\b\w/g) || []).slice(0, 2).join("").toUpperCase() || fallback}</span>;
}
function MusicMode() {
  const [items, setItems] = useState<TrackCard[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { myTracks().then((r) => setItems(r.items)).catch(() => setErr("Couldn't load your tracks — please refresh.")); }, []);
  const filtered = useMemo(() => { const n = q.trim().toLowerCase(); return (items ?? []).filter((t) => !n || t.title.toLowerCase().includes(n)); }, [items, q]);
  return (
    <>
      {err && <StatusNote error>{err}</StatusNote>}
      <div className="flex flex-wrap items-center gap-3">
        <SearchPill value={q} onChange={setQ} placeholder={`Search your ${items?.length ?? ""} tracks…`} className="max-w-sm flex-1" />
        <Button href="/music" tip="Brief the AI studio and publish an original track">Compose a track</Button>
      </div>
      {items === null ? <SkeletonGrid count={6} /> : items.length === 0 ? (
        <StatusNote>You haven't composed a track yet. <a className="font-semibold text-yin-light hover:underline" href={localePath("/music/")}>Compose your first one</a>.</StatusNote>
      ) : (
        /* auto-fit, not `sm:`/`lg:` (operator 2026-08-21). A track card is a 56px cover beside its title,
            so three tracks in the ~366px column at 1024 left 114px — barely 34px of it for the name. 13rem
            a card keeps ~184px of content after the p-3: three at 1440, two at 1280, one from 1024 down. */
        <ul className="grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-3">
          {filtered.map((t) => (
            <li key={t.id}>
              <a href={localePath(`/listen/${t.id}/`)} className="group flex h-full w-full items-center gap-3 overflow-hidden rounded-card border border-line bg-veil/[0.02] p-3 no-underline transition-colors hover:border-yang/40">
                <span className="h-14 w-14 shrink-0 overflow-hidden rounded">{t.cover ? <img src={t.cover} alt="" className="h-full w-full object-cover" /> : <MediaInitials title={t.title} fallback="♪" />}</span>
                <span className="flex min-w-0 flex-col gap-1"><span className="truncate font-semibold text-ink group-hover:text-yang">{t.title}</span><span className="rounded-full bg-veil/[0.06] px-2 py-0.5 text-[12px] font-medium text-ink-3 self-start">{mediaStateLabel(t.status, t.track_state, "Composing…")}</span></span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
// ── Animations (ArtaMotion): the member's own explainers ──────────────────────────────────────────
function AnimationsMode() {
  const [items, setItems] = useState<AnimationCard[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { myAnimations().then((r) => setItems(r.items)).catch(() => setErr("Couldn't load your animations — please refresh.")); }, []);
  const filtered = useMemo(() => { const n = q.trim().toLowerCase(); return (items ?? []).filter((a) => !n || a.title.toLowerCase().includes(n)); }, [items, q]);
  return (
    <>
      {err && <StatusNote error>{err}</StatusNote>}
      <div className="flex flex-wrap items-center gap-3">
        <SearchPill value={q} onChange={setQ} placeholder={`Search your ${items?.length ?? ""} animations…`} className="max-w-sm flex-1" />
        <Button href="/animations" tip="Brief the AI studio and publish an original animation">Animate a topic</Button>
      </div>
      {items === null ? <SkeletonGrid count={6} /> : items.length === 0 ? (
        <StatusNote>You haven't made an animation yet. <a className="font-semibold text-yin-light hover:underline" href={localePath("/animations/")}>Animate your first topic</a>.</StatusNote>
      ) : (
        /* auto-fit, not `sm:`/`lg:` (operator 2026-08-21) — the same column as the grids above: ~686px at
            1440, ~570px at 1280, ~366px at 1024. 13rem a card gives three at 1440, two at 1280 and one
            from 1024 down, instead of three 114px cards the moment the right column appeared. */
        <ul className="grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-3">
          {filtered.map((a) => (
            <li key={a.id}>
              <a href={localePath(`/watch/${a.id}/`)} className="group flex h-full w-full flex-col overflow-hidden rounded-card border border-line bg-veil/[0.02] no-underline transition-colors hover:border-yang/40">
                <span className="aspect-video w-full overflow-hidden">{a.poster ? <img src={a.poster} alt="" className="h-full w-full object-cover" /> : <MediaInitials title={a.title} fallback="▶" />}</span>
                <span className="flex flex-col gap-1 p-3"><span className="truncate font-semibold text-ink group-hover:text-yang">{a.title}</span><span className="rounded-full bg-veil/[0.06] px-2 py-0.5 text-[12px] font-medium text-ink-3 self-start">{mediaStateLabel(a.status, a.anim_state, "Rendering…")}</span></span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ── Illustrations (ArtaIllustration): the member's own artwork, covers + plates ────────────────────
function IllustrationsMode() {
  const [items, setItems] = useState<IllustrationCard[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { myIllustrations().then((r) => setItems(r.items)).catch(() => setErr("Couldn't load your illustrations — please refresh.")); }, []);
  const filtered = useMemo(() => { const n = q.trim().toLowerCase(); return (items ?? []).filter((i) => !n || i.title.toLowerCase().includes(n)); }, [items, q]);
  return (
    <>
      {err && <StatusNote error>{err}</StatusNote>}
      <div className="flex flex-wrap items-center gap-3">
        <SearchPill value={q} onChange={setQ} placeholder={`Search your ${items?.length ?? ""} illustrations…`} className="max-w-sm flex-1" />
        <Button href="/illustrations" tip="Brief the AI art studio — it paints, then improves the piece over adversarial rounds">Commission art</Button>
      </div>
      {items === null ? <SkeletonGrid count={6} /> : items.length === 0 ? (
        <StatusNote>You haven't commissioned an illustration yet. <a className="font-semibold text-yin-light hover:underline" href={localePath("/illustrations/")}>Commission your first one</a> — a standalone artwork, or a cover/plate for one of your books.</StatusNote>
      ) : (
        /* auto-fit, not `sm:`/`lg:` (operator 2026-08-21). At 1024 `lg:grid-cols-3` gave each piece 114px
            of the ~366px column — narrower than its own state pill and kind label side by side. 13rem a
            card: three at 1440, two at 1280, one from 1024 down. */
        <ul className="grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-3">
          {filtered.map((i) => (
            <li key={i.id}>
              <a href={localePath(`/illustration/${i.id}/`)} className="group flex h-full w-full flex-col overflow-hidden rounded-card border border-line bg-veil/[0.02] no-underline transition-colors hover:border-yang/40">
                <span className="aspect-square w-full overflow-hidden">{i.image ? <img src={i.image} alt="" className="h-full w-full object-cover" /> : <MediaInitials title={i.title} fallback="✦" />}</span>
                <span className="flex flex-col gap-1 p-3">
                  <span className="truncate font-semibold text-ink group-hover:text-yang">{i.title}</span>
                  <span className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
                    <span className="rounded-full bg-veil/[0.06] px-2 py-0.5 font-medium">{mediaStateLabel(i.status, i.art_state, "Painting…")}</span>
                    <span>{KIND_LABEL[i.kind] || "Artwork"}</span>
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ── Operator Console (manage_options only): control + monitor the discovery pipeline ──────────────
function rel(s: number) {
  s = Math.abs(Math.round(s));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
function lastSummary(r: ConsoleLastRun) {
  if (!r) return "never";
  const parts = Object.entries(r).filter(([k]) => k !== "ts").map(([k, v]) => `${v} ${k}`);
  return parts.join(", ") || "ok";
}
function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <Card className="flex flex-col gap-0.5 p-4">
      <span className="text-[11px] uppercase tracking-wide text-ink-2">{label}</span>
      <span className="text-[22px] font-bold leading-tight tracking-tight text-ink">{value}</span>
      {hint && <span className="text-[12px] text-ink-3">{hint}</span>}
    </Card>
  );
}
function NumberLever({ label, value, min, max, onSet, disabled, tip }: { label: string; value: number; min: number; max: number; onSet: (v: number) => void; disabled?: boolean; tip?: ButtonTip }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] text-ink-3">{label}</span>
      <span className="flex gap-1">
        <Input type="number" aria-label={label} min={min} max={max} value={v} onChange={(e) => setV(e.target.value)} className="h-9 w-20 text-[14px]" />
        <Button variant="outline" tip={tip || "Apply this value"} onClick={() => onSet(Math.max(min, Math.min(max, parseInt(v, 10) || 0)))} disabled={disabled} className="h-9 px-2.5 text-[13px]">Set</Button>
      </span>
    </div>
  );
}
type HouseMetric = "videos" | "courses" | "topics" | "disciplines";
const METRIC_LABEL: Record<HouseMetric, string> = { videos: "Videos", courses: "Courses", topics: "Topics", disciplines: "Disciplines" };
// The three independent astrological dimensions a content type is distributed across.
type AstroAxis = "house" | "sign" | "planet";
// The UI shows no astrology term/glyph: the HOW axis is a style, the WHY axis a motivation, the WHAT axis
// a field. (The dist axis keys stay house|sign|planet internally; sign carries a STYLE key (HOW) and planet
// a MOTIVATION key (WHY) — note the SWAP from the prior model.) (operator 2026-06-22)
const bucketLabel = (axis: AstroAxis, key: string, fallback: string) =>
  (axis === "sign" ? PEDAGOGY_LABEL[key] : axis === "planet" ? MOTIVATION_LABEL[key] : "") || fallback;
// A leading blank = "inherit the field's default" so an empty value shows that, not a misleading first item.
const SIGN_OPTS = [{ value: "", label: "Default (from field)" }, ...PEDAGOGIES.map((p) => ({ value: p.key, label: p.label }))];   // HOW (styles) — sign column

// TWO balance charts for ONE content type (metric): its distribution across the field (What) and the
// style (How) — always in What · How order. Self-fetches the registry
// (or reuses one passed in). Dropped into the matching Studio tab; uses the shared BalancePanel bars.
function DistBalance({ metric, reg }: { metric: HouseMetric; reg?: DisciplineRegistry }) {
  const [fetched, setFetched] = useState<DisciplineRegistry | null>(null);
  useEffect(() => { if (!reg) DisciplinesApi.list().then(setFetched).catch(() => setFetched(null)); }, [reg]);
  const r = reg ?? fetched;
  if (!r) return <Card className="p-5"><div className="h-4 w-40 animate-pulse rounded bg-veil/10" /></Card>;
  const axes: AstroAxis[] = ["house", "sign"]; // What · How (WHY retired as a content tag 2026-06-24)
  if (!axes.some((a) => (r.dist?.[a] || []).some((b) => Number(b[metric]) > 0))) return null;
  const HEAD: Record<AstroAxis, [string, string]> = { house: ["What", "field"], sign: ["How", "approach"], planet: ["Why", "motivation"] };
  // One-hot: all three axes classify the SAME items, so the total is identical across the charts — show it ONCE.
  const total = (r.dist?.house || []).reduce((s, b) => s + (Number(b[metric]) || 0), 0);
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-[15px] font-bold">{METRIC_LABEL[metric]} balance</h3>
        <span className="text-[12.5px] text-ink-3"><b className="text-ink tabular-nums">{total.toLocaleString("en")}</b> {METRIC_LABEL[metric].toLowerCase()} · across <b className="text-ink-2">What · How</b></span>
      </div>
      <div className="grid gap-6 sm:grid-cols-2">
        {axes.map((a) => {
          const wb = (r.dist?.[a] || []).map((b) => ({ key: b.key, label: bucketLabel(a, b.key, b.label), value: Number(b[metric]) || 0 }));
          const top = new Set([...wb].sort((x, y) => y.value - x.value).slice(0, 3).map((b) => b.key));
          const thin = [...wb].sort((x, y) => x.value - y.value)[0];
          const bal = balancePct(wb.map((b) => b.value));
          return (
            <BalancePanel key={a} title={HEAD[a][0]} sub={HEAD[a][1]} balance={bal}
              thinnest={bal < 100 && thin ? thin.label : undefined}
              buckets={wb} top={top} />
          );
        })}
      </div>
    </Card>
  );
}

// ── Operator ARTAAI monitor (manage_options only): every AI system on the platform, monitored + controlled ──
function SurfaceRow({ s, busyKey, act }: { s: ArtaaiSurface; busyKey: string; act: (key: string, body: Parameters<typeof ArtaaiApi.config>[0], label: string) => void }) {
  const dot = s.paused ? "bg-rose-400" : s.online === null ? "bg-ink-3" : s.online ? "bg-yang" : "bg-rose-400";
  const state = s.paused ? "paused" : s.online === null ? "queue-driven" : s.online ? "online" : "offline";
  const stateColor = s.paused ? "text-rose-400" : s.online ? "text-yang" : "text-ink-3";
  const pauseKey = `pause:${s.key}`, requeueKey = `requeue:${s.key}`;
  return (
    <li className="flex flex-col gap-2 rounded-card border border-line bg-veil/[0.02] p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={cx("h-2.5 w-2.5 shrink-0 rounded-full", dot)} title={state} />
        <span className="font-semibold text-ink">{s.label}</span>
        <span className={cx("text-[12px] font-semibold", stateColor)}>{state}</span>
        {s.has_beat && s.online && s.beat_age !== null && <span className="text-[11px] text-ink-2" title="Time since the daemon's last poll">beat {rel(s.beat_age)} ago</span>}
        <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
          <span title="Waiting in the queue"><b className="text-ink">{s.pending}</b> queued</span>
          <span title="Currently being generated"><b className="text-ink">{s.busy}</b> in flight</span>
          {s.failed > 0 && <span className="font-semibold text-rose-400" title="Failed — the author can regenerate; a requeue does not retry these">{s.failed} failed</span>}
          {s.done_24h !== null && <span title={`Reached ${s.done_label} in the last 24 hours (${s.done.toLocaleString("en")} all-time)`}><b className="text-ink">{s.done_24h}</b> {s.done_label}/24h</span>}
          {s.rounds_24h !== null && <span title="Adversarial improvement rounds recorded in the last 24 hours"><b className="text-ink">{s.rounds_24h}</b> rounds/24h</span>}
          {s.oldest_s !== null && s.oldest_s > 600 && <span className="text-yang" title="How long the oldest queued item has been waiting">oldest waits {rel(s.oldest_s)}</span>}
          {s.can_requeue && s.busy > 0 && (
            <Button variant="outline" onClick={() => act(requeueKey, { action: "requeue", surface: s.key }, `${s.label}: stale work requeued.`)} disabled={busyKey === requeueKey}
              tip={{ title: "Requeue stale work", body: "Rescue in-flight rows a crashed daemon left behind: anything untouched for over an hour goes back to the queue. A live long job heartbeats and is never yanked." }}
              className="h-7 px-2.5 text-[12px]">{busyKey === requeueKey ? "…" : "Requeue stale"}</Button>
          )}
          {s.pausable && (
            <Button variant="outline" onClick={() => act(pauseKey, { action: "pause", surface: s.key, on: !s.paused }, `${s.label} ${s.paused ? "resumed" : "paused"}.`)} disabled={busyKey === pauseKey}
              tip={s.paused ? { title: "Resume", body: "Hand this surface new jobs again — its backed-up queue drains from where it left off." } : { title: "Pause", body: "Stop handing this surface new jobs. Its queue simply backs up (nothing is lost) and drains once resumed. In-flight work is never interrupted." }}
              className={cx("h-7 px-2.5 text-[12px]", s.paused && "text-yang")}>{busyKey === pauseKey ? "…" : s.paused ? "Resume" : "Pause"}</Button>
          )}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 ps-5 text-[12px] text-ink-3">
        <span>{s.blurb}</span>
        <span className="text-ink-3/70">·</span>
        {s.model && <span className="rounded bg-veil/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-ink-2" title="Relay model · reasoning effort">{s.model}{s.effort ? ` · ${s.effort}` : ""}</span>}
        {s.engine && <span className="rounded bg-veil/[0.06] px-1.5 py-0.5 text-[11px]" title="Generation engine (free HuggingFace ZeroGPU)">{s.engine}</span>}
      </div>
      {s.head.length > 0 && (
        <ul className="flex list-none flex-col gap-1 ps-5">
          {s.head.map((h, i) => (
            <li key={`${h.id}-${i}`} className="flex items-center gap-2 rounded border border-line/50 px-2 py-1 text-[12px]">
              <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", h.state === "processing" ? "bg-yang" : "bg-ink-3")} />
              <span className="truncate text-ink-2" title={h.title}>{h.title || `#${h.id}`}</span>
              <span className="ml-auto shrink-0 text-ink-3">{h.state === "processing" ? "generating" : "next"}{h.age !== null ? ` · ${rel(h.age)}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
function ArtaaiMode() {
  const [snap, setSnap] = useState<ArtaaiSnapshot | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [thr, setThr] = useState<string | null>(null); // null = untouched → tracks the server value
  const load = () => ArtaaiApi.get().then(setSnap).catch(() => setErr("Couldn't load the ArtaAI monitor."));
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 20000);
    return () => clearInterval(t);
  }, []);

  const act = async (key: string, body: Parameters<typeof ArtaaiApi.config>[0], label: string) => {
    setBusy(key); setNote(""); setErr("");
    try {
      const r = await ArtaaiApi.config(body);
      await load();
      setNote(body.action === "requeue" ? `${label.replace(" requeued.", "")}: ${Number(r.requeued ?? 0)} row(s) requeued.`
        : body.action === "moderate" ? `Moderation drained — ${Number(r.resolved ?? 0)} comment(s) scored.` : label);
      if (body.action === "threshold") setThr(null); // re-track the server value
    } catch (e) { setErr(e instanceof Error ? e.message : "Action failed."); }
    setBusy("");
  };

  if (!snap) return err ? <StatusNote error>{err}</StatusNote> : <SkeletonGrid count={3} />;
  const chat = snap.surfaces.filter((s) => s.group === "chat");
  const studio = snap.surfaces.filter((s) => s.group === "studio");
  const thrShown = thr ?? String(snap.moderation.threshold);
  const thrNum = Math.max(1, Math.min(100, parseInt(thrShown, 10) || snap.moderation.default));
  const parkAt = snap.park.reset_at ? new Date(snap.park.reset_at * 1000).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }) : "";

  return (
    <div className="flex flex-col gap-4">
      {note && <StatusNote>{note}</StatusNote>}
      {err && <StatusNote error>{err}</StatusNote>}

      <StatusNote>Every AI system on the platform runs on your Claude Max subscription (via the laptop relays) plus free HuggingFace model backends — nothing here bills the API. Pausing a surface only stops it being handed <em>new</em> jobs: the queue backs up and drains when you resume.</StatusNote>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Stat label="Laptop relay" value={snap.laptop_online ? "Online ✓" : "Offline"} hint={`${snap.relays_alive}/${snap.relays_total} relays beating`} />
        <Stat label="Queued" value={snap.total_pending.toLocaleString("en")} hint={`${snap.total_busy} in flight${snap.total_failed ? ` · ${snap.total_failed} failed` : ""}`} />
        <Stat label="AI rounds" value={snap.rounds_24h.toLocaleString("en")} hint="improvement rounds, 24h" />
        <Stat label="ArtaBot" value={snap.usage.turns_24h.toLocaleString("en")} hint={`chat turns, 24h · ${snap.usage.tokens_24h.toLocaleString("en")} tokens`} />
        <Stat label="ArtaMod queue" value={snap.moderation.queue.toLocaleString("en")} hint={`${snap.moderation.flagged_24h} flagged in 24h`} />
        <Stat label="Subscription" value={snap.park.active ? `Parked ${rel(snap.park.reset_in ?? 0)}` : "Clear ✓"} hint={snap.park.active ? `resumes ~${parkAt}` : "relay work flowing"} />
      </div>

      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-[14px] font-bold">{snap.global_pause ? "AI is globally paused" : snap.park.active ? "Relay work is parked" : "All AI systems live"}</span>
          <span className="text-[12px] text-ink-3">
            {snap.global_pause ? "No studio surface is being handed new jobs."
              : snap.park.active ? `The subscription is held until ~${parkAt} — clear the park to resume relay work now.`
              : "Pause everything, park the subscription for a while, or control individual surfaces below."}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {snap.park.active ? (
            <Button variant="outline" tip={{ title: "Clear the park", body: "Relay work is held — either a reported subscription usage limit or a manual park. Clear it to hand out work again now (for a usage limit, only if you know the window has reset)." }} onClick={() => act("unpark", { action: "unpark" }, "Park cleared — relay work is flowing again.")} disabled={!!busy} className="h-9 text-[13px] text-yang">{busy === "unpark" ? "…" : "Clear park"}</Button>
          ) : (
            <>
              <Button variant="outline" tip={{ title: "Park for 30 minutes", body: "Hold ALL relay work for 30 minutes — the same mechanism as a usage-limit park, so every consumer backs off gracefully. Handy to keep the subscription free while you work interactively." }} onClick={() => act("park30", { action: "park", minutes: 30 }, "Parked for 30 minutes.")} disabled={!!busy} className="h-9 text-[13px]">{busy === "park30" ? "…" : "Park 30m"}</Button>
              <Button variant="outline" tip={{ title: "Park for 2 hours", body: "Hold ALL relay work for 2 hours. Queues back up and drain once the park lifts (or you clear it)." }} onClick={() => act("park120", { action: "park", minutes: 120 }, "Parked for 2 hours.")} disabled={!!busy} className="h-9 text-[13px]">{busy === "park120" ? "…" : "Park 2h"}</Button>
            </>
          )}
          <Button variant={snap.global_pause ? "primary" : "outline"} tip={snap.global_pause ? { title: "Resume all", body: "Let every studio surface be handed jobs again (individually-paused surfaces stay paused until resumed below)." } : { title: "Pause all", body: "Stop handing every studio surface new jobs. Queues back up and drain on resume; chat + in-flight work are untouched." }}
            onClick={() => act("all", { action: "pause_all", on: !snap.global_pause }, snap.global_pause ? "All AI resumed." : "All AI paused.")} disabled={!!busy}
            className={cx("h-9 text-[13px]", snap.global_pause && "text-yang")}>{busy === "all" ? "…" : snap.global_pause ? "Resume all" : "Pause all"}</Button>
        </div>
      </Card>

      <Card className="flex flex-col gap-2 p-5">
        <h3 className="text-[15px] font-bold">Chat &amp; moderation <span className="font-normal text-ink-3">— the always-on subscription relay</span></h3>
        <ul className="flex list-none flex-col gap-2">
          {chat.map((s) => <SurfaceRow key={s.key} s={s} busyKey={busy} act={act} />)}
        </ul>
        <div className="mt-1 flex flex-wrap items-end gap-x-4 gap-y-2 border-t border-line/60 pt-3">
          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-ink-3">ArtaMod flag threshold <span className="text-ink-3/70">(calibrated default {snap.moderation.default})</span></span>
            <span className="flex items-center gap-1">
              <Input type="number" aria-label="ArtaMod flag threshold" min={1} max={100} value={thrShown} onChange={(e) => setThr(e.target.value)} className="h-9 w-20 text-[14px]" />
              <Button variant="outline" tip={{ title: "Set the hate/fear flag line", body: "A comment scoring at or above this (0-100) has its upvotes excluded from the competition and gets a consoling ArtaBot reply. Lower = stricter. Applies to new verdicts and appeals immediately; already-scored comments keep their verdict." }} onClick={() => act("threshold", { action: "threshold", value: thrNum }, `Threshold set to ${thrNum}.`)} disabled={busy === "threshold" || thrNum === snap.moderation.threshold} className="h-9 px-2.5 text-[13px]">{busy === "threshold" ? "…" : "Set"}</Button>
            </span>
          </div>
          <Button variant="outline" tip={{ title: "Drain the moderation queue now", body: "Score every comment waiting in the ArtaMod queue right now, instead of waiting for the 5-minute cron. Needs the laptop relay online; fails open (comments stay queued) otherwise." }} onClick={() => act("moderate", { action: "moderate" }, "Moderation drained.")} disabled={!!busy || !snap.laptop_online} className="h-9 text-[13px]">{busy === "moderate" ? "draining…" : "Run moderation now"}</Button>
          <span className="text-[12px] text-ink-3">{snap.moderation.processed.toLocaleString("en")} processed · {snap.moderation.flagged.toLocaleString("en")} flagged all-time</span>
        </div>
      </Card>

      <Card className="flex flex-col gap-2 p-5">
        <h3 className="text-[15px] font-bold">Studios <span className="font-normal text-ink-3">— brief → AI original → review → publish</span></h3>
        <ul className="flex list-none flex-col gap-2">
          {studio.map((s) => <SurfaceRow key={s.key} s={s} busyKey={busy} act={act} />)}
        </ul>
      </Card>

      <Card className="flex flex-col gap-2 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-[15px] font-bold">HuggingFace accounts <span className="font-normal text-ink-3">— the free ZeroGPU pool behind the studios</span></h3>
          {snap.hf && (
            <span className="text-[12px] text-ink-3">
              {snap.hf.accounts} account{snap.hf.accounts === 1 ? "" : "s"} · <b className="text-ink" title="How closely each account's share matches its quota-weighted target (measured on use ÷ weight, which is even at the optimum)">{balancePct(snap.hf.pool.filter((a) => a.valid !== false).map((a) => a.use / (a.weight || 1)))}%</b> on target · reported {rel(snap.now - snap.hf.at)} ago
            </span>
          )}
        </div>
        {!snap.hf ? (
          <p className="text-[13px] text-ink-3">No usage report yet — the pool rotates least-used-first and reports its ledger on every studio relay tick (music, film, illustration, translate). It appears here after the first tick.</p>
        ) : (() => {
          const total = snap.hf.pool.reduce((s, a) => s + a.use, 0);
          const liveW = snap.hf.pool.filter((a) => a.valid !== false).reduce((s, a) => s + (a.weight || 1), 0) || 1;
          const anyPro = snap.hf.pool.some((a) => a.pro);
          return (
            <>
              <p className="text-[12.5px] text-ink-3">Every generation attempt picks the <em>least-used</em> account first, weighted by quota (recent quota hits go to the back). {anyPro ? <>A <strong>PRO</strong> account has ~5× the ZeroGPU quota + priority, so it carries a proportionally larger target share (shown per row).</> : <>All accounts weigh equally, so shares converge on ~{(100 / liveW).toFixed(0)}% each.</>} Names only — a token value never leaves the laptop.</p>
              <ul className="flex list-none flex-col gap-1.5">
                {snap.hf.pool.map((a) => {
                  const share = total > 0 ? (a.use / total) * 100 : 0;
                  const target = a.valid === false ? 0 : ((a.weight || 1) / liveW) * 100;
                  return (
                    <li key={a.name} className="flex flex-col gap-1 rounded-card border border-line/60 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px]">
                        <span className="w-28 font-mono font-semibold text-ink">{a.name}</span>
                        {a.pro && <span className="rounded-pill bg-yang/20 px-2 py-0.5 text-[11px] font-bold uppercase text-yang" title="HuggingFace PRO account — ~5× ZeroGPU quota and priority queue, so the pool routes a larger share here.">⭐ PRO</span>}
                        {a.valid === false && <span className="rounded-pill bg-rose-500/15 px-2 py-0.5 text-[11px] font-bold uppercase text-rose-300" title="The token failed HuggingFace's whoami check (revoked or expired). It is excluded from the pool — the studios fall back to the tiny anonymous quota. Rotate it in wp-admin › AQ Security.">invalid — rotate</span>}
                        <span className="text-ink-2 tabular-nums" title={`Share of all generation attempts (target ~${target.toFixed(0)}% by quota weight)`}>{total > 0 ? `${share.toFixed(1)}%` : "—"}{target > 0 ? <span className="text-ink-3"> / {target.toFixed(0)}%</span> : null}</span>
                        <span className="ml-auto flex items-center gap-3 text-[12px] text-ink-3">
                          <span title="Generation attempts with this account"><b className="text-ink">{a.use.toLocaleString("en")}</b> used</span>
                          <span title="Successful renders"><b className="text-ink">{a.ok.toLocaleString("en")}</b> ok</span>
                          {a.quota > 0 && <span className="text-yang" title="ZeroGPU quota rejections — the account parks until HuggingFace's reported reset window elapses">{a.quota.toLocaleString("en")} quota</span>}
                          {a.parked && a.parked > 0 ? <span className="rounded-pill bg-yang/15 px-2 py-0.5 font-semibold text-yang" title="Cooling down until this account's ZeroGPU quota is expected back (parsed from HuggingFace's own retry window); excluded from rotation until then">parked {rel(a.parked)}</span> : null}
                          <span title="Last time this account was tried">{a.last > 0 ? `${rel(snap.now - a.last)} ago` : "never"}</span>
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-veil/[0.08]" role="img" aria-label={`${a.name} carries ${share.toFixed(1)}% of attempts`}>
                        <div className="h-full rounded-full bg-yang" style={{ width: `${Math.min(100, Math.max(share > 0 ? 2 : 0, share))}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          );
        })()}
      </Card>

      <div className="flex items-center justify-between text-[12px] text-ink-3">
        <span>schema {snap.system.schema} · {snap.system.aq_version} · auto-refreshes every 20s</span>
        <Button variant="outline" tip="Reload the monitor now" onClick={load} className="h-8 px-3 text-[12px]">↻ Refresh</Button>
      </div>
    </div>
  );
}

function ConsoleMode() {
  const [snap, setSnap] = useState<ConsoleSnapshot | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const load = () => ConsoleApi.get().then(setSnap).catch(() => setErr("Couldn't load the console."));
  useEffect(() => { load(); }, []);

  const guard = async (key: string, fn: () => Promise<unknown>, label: string) => {
    setBusy(key); setNote(""); setErr("");
    try { await fn(); await load(); setNote(label); }
    catch (e) { setErr(e instanceof Error ? e.message : "Action failed."); }
    setBusy("");
  };
  const run = (job: string) => guard(job, async () => { const r = await ConsoleApi.run(job); setNote(`${job}: ${lastSummary({ ts: 0, ...(r.result as Record<string, number>) })}`); }, "");
  const setCfg = (b: { cap?: number; per_run?: number; cursor?: number }) => guard("config", () => ConsoleApi.config(b), "Saved.");

  if (!snap) return err ? <StatusNote error>{err}</StatusNote> : <SkeletonGrid count={3} />;
  const d = snap.discovery, cat = snap.catalogue;
  const ago = (t?: number) => (t ? `${rel(snap.now - t)} ago` : "—");

  return (
    <div className="flex flex-col gap-4">
      {note && <StatusNote>{note}</StatusNote>}
      {err && <StatusNote error>{err}</StatusNote>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total discussion" value={`${cat.total_rate.toLocaleString("en")}/day`} hint={`${cat.videos} videos · ${cat.avg_rate}/day avg`} />
        <Stat label="Published courses" value={cat.published_courses} hint={`${cat.prune_eligible_courses} with >5 videos`} />
        <Stat label="Incubating" value={d.candidate_count} hint="candidates being proven" />
        <Stat label="Reserve" value={snap.economy.reserve_ok ? "Full ✓" : "SHORT ⚠"} hint={`${snap.economy.coins_issued.toLocaleString("en")} ₳ · ${snap.economy.backing_mg.toLocaleString("en")} mg`} />
      </div>

      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-[15px] font-bold">Discovery pipeline</h3>
          <span className={cx("text-[12px] font-semibold", d.enabled ? "text-yang" : "text-rose-400")}>{d.enabled ? "YouTube API enabled" : "YouTube API off"}</span>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-ink-3">
          <span>Budget today: <b className="text-ink">{d.searches_today}/{d.cap}</b> searches</span>
          <span>Cursor: <b className="text-ink">#{d.cursor}</b> → {d.next_course || "—"}</span>
          <span>Last discover {ago(d.last_discover?.ts)} <span className="text-ink-3/70">({lastSummary(d.last_discover)})</span></span>
          <span>settle {ago(d.last_settle?.ts)} <span className="text-ink-3/70">({lastSummary(d.last_settle)})</span></span>
          <span>prune {ago(d.last_prune?.ts)} <span className="text-ink-3/70">({lastSummary(d.last_prune)})</span></span>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <NumberLever label="Daily cap (0 = pause)" value={d.cap} min={0} max={90} onSet={(v) => setCfg({ cap: v })} disabled={busy === "config"} tip={{ title: "Daily search cap", body: "The hard ceiling on YouTube search calls per day. 0 pauses discovery entirely. Clamped to 90 so it can never exhaust the 10,000-unit daily quota the rate monitor also needs." }} />
          <NumberLever label="Courses / run" value={d.per_run} min={1} max={10} onSet={(v) => setCfg({ per_run: v })} disabled={busy === "config"} tip={{ title: "Courses per run", body: "How many courses each hourly discover run searches. The daily cap is still the real limit — this just paces how fast it's spent." }} />
          <Button variant="outline" tip={{ title: "Reset rotation", body: "Moves the discovery cursor back to the first course, so the next runs re-sweep the whole catalogue from the start." }} onClick={() => setCfg({ cursor: 0 })} disabled={busy === "config"} className="h-9 text-[13px]">Reset rotation</Button>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-line/60 pt-3">
          {snap.jobs.map((j) => (
            <Button key={j} variant="outline" tip={JOB_TIPS[j] || `Run the ${j} job now`} onClick={() => run(j)} disabled={!!busy} className="text-[13px]">{busy === j ? "running…" : `Run ${j}`}</Button>
          ))}
        </div>
      </Card>

      <Card className="flex flex-col gap-2 p-5">
        <h3 className="text-[15px] font-bold">Background jobs <span className="font-normal text-ink-3">— WP-cron schedule + health</span></h3>
        <ul className="grid list-none grid-cols-1 gap-1 text-[13px] sm:grid-cols-2">
          {snap.crons.map((c) => (
            <li key={c.hook} className="flex flex-col gap-0.5 rounded border border-line/50 px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-ink-3">{c.hook}</span>
                <span className={cx(c.next_in === null ? "text-rose-400" : "text-ink")}>{c.next_in === null ? "not scheduled" : `in ${rel(c.next_in)}`}</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-ink-3">{c.last === null ? "never run" : `ran ${rel(c.last)} ago${c.ms != null ? ` (${c.ms < 1000 ? `${c.ms}ms` : `${(c.ms / 1000).toFixed(1)}s`})` : ""}`}{c.skips > 0 ? ` · ${c.skips}× skipped` : ""}</span>
                {c.err && <span className="truncate text-rose-400" title={c.err}>⚠ {c.err}</span>}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {snap.research && (
        <Card className="flex flex-col gap-2 p-5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[15px] font-bold">ArtaScience <span className="font-normal text-ink-3">— automated AI review queue</span></h3>
            <span className={cx("text-[12px] font-semibold", snap.research.online ? "text-yang" : "text-ink-3")}>
              <span className={cx("me-1 inline-block h-2 w-2 rounded-full align-middle", snap.research.online ? "bg-yang" : "bg-ink-3")} />
              reviewer {snap.research.online ? "online" : "offline"}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-2">
            <span><b className="text-ink">{snap.research.counts.submitted + snap.research.counts.reviewing}</b> in queue</span>
            <span><b className="text-ink">{snap.research.counts.reviewing}</b> under review</span>
            <span><b className="text-ink">{snap.research.counts.revisions}</b> in revision</span>
            <span><b className="text-yang">{snap.research.counts.accepted}</b> accepted</span>
            <span><b className="text-ink-3">{snap.research.counts.rejected}</b> rejected</span>
          </div>
          {snap.research.recent.length > 0 && (
            <ul className="mt-1 grid list-none grid-cols-1 gap-1 text-[13px]">
              {snap.research.recent.map((s) => (
                <li key={s.id}>
                  <a href={`/research/?submission=${s.id}`} className="flex items-center justify-between gap-2 rounded border border-line/50 px-2 py-1.5 hover:bg-veil/[0.04]">
                    <span className="truncate text-ink">{s.title}</span>
                    <span className="shrink-0 text-ink-3">{s.status}{s.score ? ` · ${s.score}` : ""}{s.reproduced ? " · ✓" : ""} · {rel(snap.now - s.updated)} ago</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <div className="flex items-center justify-between text-[12px] text-ink-3">
        <span>schema {snap.system.schema} · {snap.system.aq_version}</span>
        <Button variant="outline" tip="Reload the console with the latest figures" onClick={load} className="h-8 px-3 text-[12px]">↻ Refresh</Button>
      </div>
    </div>
  );
}

// Operator "Houses" mode: every analysed field organised into the 12 houses, with add-for-analysis + purge. The
// sidereal fit runs in the OFFLINE pipeline, so add/remove are QUEUED (shown "in flight") and the collector applies
// them on its next pass and redeploys. The house a field lands in is decided by its data, not picked here.
function HousesMode() {
  const [data, setData] = useState<{ houses: StudioHouse[]; queue: HousesQueue } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [word, setWord] = useState("");
  const load = () => HousesApi.list().then(setData).catch(() => setErr("Couldn't load the houses."));
  useEffect(() => { load(); }, []);

  const seasonLabel = (key: string) => CATEGORY_GROUPS.find((g) => g.key === key)?.label || key;
  const setQueue = (queue: HousesQueue) => setData((d) => (d ? { ...d, queue } : d));

  const addField = async () => {
    const w = word.trim().toLowerCase();
    if (w.length < 2) return;
    setBusy("add"); setErr("");
    try { const r = await HousesApi.field("add", w); setQueue(r.queue); setWord(""); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't queue the field."); }
    setBusy("");
  };
  const removeField = async (key: string) => {
    if (!window.confirm(`Purge "${key}" from the analysis? The offline pipeline removes it and redeploys on its next pass.`)) return;
    setBusy(key); setErr("");
    try { const r = await HousesApi.field("remove", key); setQueue(r.queue); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't queue the removal."); }
    setBusy("");
  };
  const unqueue = async (action: "add" | "remove", value: string) => {
    setBusy(value);
    try { const r = await HousesApi.unqueue(action, value); setQueue(r.queue); } catch { /* ignore */ }
    setBusy("");
  };

  if (!data) return err ? <StatusNote error>{err}</StatusNote> : <SkeletonGrid count={4} />;
  const { houses, queue } = data;
  const pending = queue.add.length + queue.remove.length;

  return (
    <div className="flex flex-col gap-4">
      {err && <StatusNote error>{err}</StatusNote>}

      <Card className="p-4 sm:p-5">
        <h2 className="mb-1 text-[15px] font-bold tracking-tight">Submit a field for analysis</h2>
        <p className="mb-3 max-w-2xl text-[13px] leading-relaxed text-ink-3">
          Add a search word to the sidereal-analysis work-list. The offline pipeline fetches its 22-year worldwide
          Google-Trends rhythm, fits the 15-parameter model, and places it in whichever house its data prefers — then
          redeploys. The house is decided by the fit, not chosen here.
        </p>
        <div className="flex flex-wrap gap-2">
          <Input className="min-w-[14rem] flex-1" value={word} maxLength={60}
            onChange={(e) => setWord(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addField(); }}
            placeholder="a single word or phrase — e.g. astronomy, festival, anxious" />
          <Button onClick={addField} disabled={busy === "add" || word.trim().length < 2}
            tip={{ title: "Queue for analysis", body: "Adds the word to the offline collector's work-list; it's analysed and deployed on the next pass." }}>
            {busy === "add" ? "Queuing…" : "Queue for analysis"}
          </Button>
        </div>
      </Card>

      {pending > 0 && (
        <Card className="p-4 sm:p-5">
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">In flight · {pending} queued for the offline collector</h2>
          <div className="flex flex-wrap gap-1.5">
            {queue.add.map((w) => (
              <span key={`a-${w}`} className="inline-flex items-center gap-1 rounded-full border border-line bg-space-3/40 px-2.5 py-1 text-[13px]">
                <span className="text-yin-light">+ {w}</span>
                <button onClick={() => unqueue("add", w)} disabled={busy === w} className="text-ink-3 hover:text-ink" aria-label={`cancel adding ${w}`}>×</button>
              </span>
            ))}
            {queue.remove.map((k) => (
              <span key={`r-${k}`} className="inline-flex items-center gap-1 rounded-full border border-line bg-space-3/40 px-2.5 py-1 text-[13px]">
                <span className="text-yang">− {k}</span>
                <button onClick={() => unqueue("remove", k)} disabled={busy === k} className="text-ink-3 hover:text-ink" aria-label={`cancel removing ${k}`}>×</button>
              </span>
            ))}
          </div>
        </Card>
      )}

      <div className="space-y-3">
        {houses.map((h, idx) => (
          <Card key={h.key} className="p-4 sm:p-5">
            <div className={cx("flex items-baseline justify-between gap-3", h.fields.length > 0 && "mb-3 border-b border-line/60 pb-2")}>
              <h2 className="text-[16px] font-bold tracking-tight">
                <span className="tabular-nums text-ink-3">{idx + 1}</span>
                <span className="ms-2">{seasonLabel(h.key)}</span>
              </h2>
              <span className="shrink-0 text-[12px] tabular-nums text-ink-3">{h.fields.length}</span>
            </div>
            {h.fields.length ? (
              <div className="flex flex-wrap gap-1.5">
                {h.fields.map((f) => (
                  <span key={f.key}
                    className={cx("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[13px]",
                      f.rep ? "border-yin-light bg-space-3/70 font-semibold text-ink" : "border-line bg-space-3/40 text-ink-2")}>
                    <a href={localePath(`/topics/?field=${encodeURIComponent(f.key)}`)} className="hover:text-yin-light">{f.label}</a>
                    {f.rep ? <span className="text-[11px] text-ink-2">rep {f.ratio}×</span> : null}
                    <button onClick={() => removeField(f.key)} disabled={busy === f.key} className="text-ink-3 hover:text-yang" aria-label={`purge ${f.label}`} title="Purge this field from the analysis">×</button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[12px] text-ink-3/50">no analysed fields yet</p>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

function DisciplinesMode() {
  const [reg, setReg] = useState<DisciplineRegistry | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [q, setQ] = useState("");
  const load = () => DisciplinesApi.list().then(setReg).catch(() => setErr("Couldn't load the discipline registry."));
  useEffect(() => { load(); }, []);

  const save = async (d: Discipline & { oldKey?: string }) => {
    setBusy(d.oldKey || d.key || "+"); setErr("");
    try { await DisciplinesApi.save(d); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't save the discipline."); }
    setBusy("");
  };
  const remove = async (key: string) => {
    setBusy(key); setErr("");
    try { await DisciplinesApi.remove(key); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't remove the discipline."); }
    setBusy("");
  };

  if (!reg) return err ? <StatusNote error>{err}</StatusNote> : <SkeletonGrid count={4} />;
  const houseOpts = reg.houses.map((h) => ({ value: h.key, label: h.label }));
  const needle = q.trim().toLowerCase();
  const groups = reg.houses.map((h) => ({
    house: h,
    items: reg.disciplines.filter((d) => d.house === h.key && (!needle || d.label.toLowerCase().includes(needle) || d.key.includes(needle))),
  }));

  return (
    <div className="flex flex-col gap-4">
      {err && <StatusNote error>{err}</StatusNote>}
      <DistBalance metric="disciplines" reg={reg} />
      <StatusNote>The 12 houses are fixed; each <strong>discipline</strong> carries a field (<strong>What</strong>), a style (<strong>How</strong>) and a motivation (<strong>Why</strong>) — all editable here. How + Why are independent of the field (that's what makes the three diagrams distinct); leave them on the default or reassign to balance the How/Why charts. A removed discipline simply stops showing — existing links become inert.</StatusNote>
      <div className="flex flex-wrap items-center gap-3">
        <SearchPill value={q} onChange={setQ} placeholder={`Search ${reg.disciplines.length} disciplines…`} className="max-w-sm flex-1" />
        <AddDiscipline houses={houseOpts} onAdd={save} busy={busy === "+"} />
      </div>
      {groups.map(({ house, items }) => (
        <Card key={house.key} className="flex flex-col gap-2 p-4">
          <h3 className="text-[15px] font-bold">{house.label} <span className="font-normal text-ink-3">— {items.length} {items.length === 1 ? "discipline" : "disciplines"}</span></h3>
          {items.length === 0 ? <p className="text-[13px] text-ink-3">No disciplines{needle ? " match" : " yet"}.</p> : (
            <ul className="flex list-none flex-col gap-1.5">
              {items.map((d) => (
                <DisciplineRow key={d.key} d={d} houses={houseOpts} busy={busy === d.key} onSave={save} onRemove={remove} />
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}

function DisciplineRow({ d, houses, busy, onSave, onRemove }: { d: Discipline; houses: { value: string; label: ReactNode }[]; busy: boolean; onSave: (d: Discipline & { oldKey?: string }) => void; onRemove: (key: string) => void }) {
  const [key, setKey] = useState(d.key);
  const [label, setLabel] = useState(d.label);
  const [house, setHouse] = useState(d.house);
  const [sign, setSign] = useState(d.sign || "");
  useEffect(() => { setKey(d.key); setLabel(d.label); setHouse(d.house); setSign(d.sign || ""); }, [d.key, d.label, d.house, d.sign]);
  const dirty = key !== d.key || label !== d.label || house !== d.house || sign !== (d.sign || "");
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-card border border-line p-2 text-[13px]">
      <Input aria-label="Discipline key — renaming cascades to every link" value={key} onChange={(e) => setKey(e.target.value)} className="h-9 w-44 shrink-0 font-mono text-[12px]" />
      <Input aria-label="Discipline label" value={label} onChange={(e) => setLabel(e.target.value)} className="h-9 min-w-36 flex-1 text-[14px]" />
      <Select label="House (what)" value={house} onChange={setHouse} options={houses} className="h-9 text-[13px]" />
      <Select label="How (approach)" value={sign} onChange={setSign} options={SIGN_OPTS} className="h-9 text-[13px]" />
      <Button variant="outline" tip="Save — renaming the key cascades to every topic & course linked to it" onClick={() => onSave({ key, oldKey: d.key, house, label, blurb: d.blurb, sign })} disabled={busy || !dirty} className="h-9 px-3 text-[13px]">{busy ? "…" : "Save"}</Button>
      <Button variant="outline" tip="Remove this discipline from the registry" onClick={() => onRemove(d.key)} disabled={busy} className="h-9 px-2.5 text-rose-400" aria-label="Remove discipline">✕</Button>
    </li>
  );
}

function AddDiscipline({ houses, onAdd, busy }: { houses: { value: string; label: ReactNode }[]; onAdd: (d: Discipline & { oldKey?: string }) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [house, setHouse] = useState(houses[0]?.value ?? "");
  const [label, setLabel] = useState("");
  if (!open) return <Button tip="Add a new discipline to a house" onClick={() => setOpen(true)}>Add a discipline</Button>;
  const submit = () => { if (key.trim() && house && label.trim()) { onAdd({ key: key.trim(), house, label: label.trim() }); setKey(""); setLabel(""); setOpen(false); } };
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Input aria-label="New discipline key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="key (e.g. law-tax)" className="h-9 w-44 font-mono text-[13px]" />
      <Select label="House" value={house} onChange={setHouse} options={houses} className="h-9 text-[13px]" />
      <Input aria-label="New discipline label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" className="h-9 w-40 text-[14px]" />
      <Button tip="Create the discipline" onClick={submit} disabled={busy}>Add</Button>
      <Button variant="outline" tip="Cancel" onClick={() => setOpen(false)}>Cancel</Button>
    </span>
  );
}

// ── Operator VIDEOS surface (manage_options only): every tracked video + its state/metadata; the
// incubating candidates live here too, with settle/discard control. ──
function VideosMode() {
  const [data, setData] = useState<{ items: VideoRow[]; counts: { total: number; candidates: number; missing: number }; now: number } | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "candidate" | "in-course" | "standalone" | "missing">("all");
  const [busy, setBusy] = useState("");
  const load = (query: string) => VideosApi.list(query).then(setData).catch(() => setErr("Couldn't load videos."));
  useEffect(() => { const t = setTimeout(() => load(q), 300); return () => clearTimeout(t); }, [q]);

  const candAct = async (video: string, action: "discard" | "settle") => {
    setBusy(video); setErr("");
    try { await ConsoleApi.candidate(video, action); await load(q); }
    catch (e) { setErr(e instanceof Error ? e.message : "Action failed."); }
    setBusy("");
  };

  if (!data) return err ? <StatusNote error>{err}</StatusNote> : <SkeletonGrid count={4} />;
  const items = data.items.filter((v) => filter === "all" || v.state === filter);
  const badge: Record<string, string> = {
    "in-course": "bg-yang/15 text-yang", candidate: "bg-yin/15 text-yin-light", standalone: "bg-veil/10 text-ink-3", missing: "bg-rose-500/15 text-rose-300",
  };
  const filters: [typeof filter, string][] = [["all", `All ${data.counts.total}`], ["candidate", `Incubating ${data.counts.candidates}`], ["in-course", "In a course"], ["standalone", "Standalone"], ["missing", `Missing ${data.counts.missing}`]];
  return (
    <div className="flex flex-col gap-4">
      {err && <StatusNote error>{err}</StatusNote>}
      <StatusNote>Every video the engine tracks — with its live state, metrics and the incubating candidates. Search by id; filter by state; settle or discard a candidate inline.</StatusNote>
      <DistBalance metric="videos" />
      <SearchPill value={q} onChange={setQ} placeholder={`Search ${data.counts.total} videos by id…`} className="max-w-sm" />
      <div className="flex flex-wrap gap-1.5 text-[13px]">
        {filters.map(([f, label]) => (
          <button key={f} type="button" onClick={() => setFilter(f)} title={`Show ${f} videos`}
            className={cx("rounded-pill border px-3 py-1 font-semibold transition-colors", filter === f ? "border-yin bg-yin/15 text-yang" : "border-line text-ink-3 hover:text-ink")}>{label}</button>
        ))}
      </div>
      <ul className="flex list-none flex-col gap-1.5">
        {items.length === 0 ? <li className="text-[13px] text-ink-3">No videos match.</li> : items.map((v) => (
          <li key={v.video} className="flex flex-wrap items-center gap-2 rounded-card border border-line bg-veil/[0.02] p-2 text-[13px]">
            {v.thumb ? <img src={v.thumb} alt="" loading="lazy" className="h-9 w-16 shrink-0 rounded object-cover" /> : <span className="h-9 w-16 shrink-0 rounded bg-veil/10" />}
            <a href={`https://youtu.be/${v.video}`} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-yin-light hover:underline">{v.video}</a>
            <span className={cx("rounded-pill px-2 py-0.5 text-[11px] font-semibold", badge[v.state])}>{v.state}</span>
            {v.course && <a href={localePath(`/courses/${v.course.slug}`)} className="truncate text-ink-2 hover:text-yang hover:underline" title={v.course.title}>{v.course.title}</a>}
            {v.candidate && <span className="text-ink-3">→ {v.candidate.course} · {v.candidate.ripe_in > 0 ? `ripe in ${rel(v.candidate.ripe_in)}` : "ready"} (vs {v.candidate.baseline})</span>}
            <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-ink-3">
              <span title="rolling comments per day" className="font-semibold text-yang">{v.rate}/day</span>
              <span title="total comments">{v.comments.toLocaleString("en")}c</span>
              <span title="views">{v.views.toLocaleString("en")}v</span>
              <span title="likes">{v.likes.toLocaleString("en")}♥</span>
              <span title="last refreshed">{v.last_refresh ? `${rel(data.now - v.last_refresh)} ago` : "—"}</span>
              {v.candidate && (
                <span className="flex gap-1">
                  <Button variant="outline" tip="Settle now — end the trial and judge on the measured rate" onClick={() => candAct(v.video, "settle")} disabled={!!busy} className="h-7 px-2 text-[11px]">Settle</Button>
                  <Button variant="outline" tip="Discard this candidate without adding it" onClick={() => candAct(v.video, "discard")} disabled={!!busy} className="h-7 px-2 text-[11px] text-rose-400">Discard</Button>
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Operator Members directory (manage_options only): see members + grant course-creation access ──
function MembersMode() {
  const [q, setQ] = useState("");
  const [members, setMembers] = useState<StudioMember[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(0);
  const load = (query: string) => MembersApi.list(query).then((r) => setMembers(r.items)).catch(() => setErr("Couldn't load members."));
  useEffect(() => { const t = setTimeout(() => load(q), 300); return () => clearTimeout(t); }, [q]);

  const grant = async (m: StudioMember, on: boolean) => {
    setBusy(m.id); setErr("");
    try { await MembersApi.grant(m.id, on); await load(q); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't update access."); }
    setBusy(0);
  };

  return (
    <div className="flex flex-col gap-4">
      {err && <StatusNote error>{err}</StatusNote>}
      <SearchPill value={q} onChange={setQ} placeholder="Search members by name, email or handle…" className="max-w-sm" />
      {members === null ? <SkeletonGrid count={4} /> : members.length === 0 ? (
        <StatusNote>No members match that search.</StatusNote>
      ) : (
        <ul className="flex list-none flex-col gap-2">
          {members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-line p-3">
              <a href={localePath(`/u/${m.slug}/`)} className="font-semibold text-ink hover:text-yang" title="Open this member's public profile">{m.name}</a>
              <span className="text-[12px] text-ink-3">{m.email}</span>
              <span className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
                <span className="rounded-pill bg-veil/5 px-2 py-0.5">{m.tier}</span>
                <span>{m.points.toLocaleString("en")} pts</span>
                {m.courses > 0 && <span>· {m.courses} course{m.courses > 1 ? "s" : ""}</span>}
              </span>
              <span className="ml-auto flex items-center gap-2">
                {m.operator ? (
                  <span className="text-[12px] font-semibold text-yang" title="A platform operator (wp-admin) — full access">Operator</span>
                ) : m.granted ? (
                  <Button variant="outline" tip="Revoke this member's granted course-creation access. Their point-earned tier is untouched." onClick={() => grant(m, false)} disabled={busy === m.id} className="h-8 px-3 text-[12px] text-rose-400">{busy === m.id ? "…" : "Revoke access"}</Button>
                ) : m.can_create ? (
                  <span className="text-[12px] text-ink-3" title="Can create courses — earned by reaching the Creator tier (1,000 points)">Creator (earned)</span>
                ) : (
                  <Button variant="outline" tip="Let this member create courses now, before they reach the 1,000-point Creator tier" onClick={() => grant(m, true)} disabled={busy === m.id} className="h-8 px-3 text-[12px]">{busy === m.id ? "…" : "Grant creator access"}</Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ArtaShop (operator): the hard-copy catalogue + order fulfilment. Products are authored here
   (price ₳, weight g — the weight drives the PTT shipping quote); orders arrive 'paid' and are
   marked shipped (with tracking) / delivered, or cancelled with a full coin refund. */
const SHOP_KIND_LABEL: Record<string, string> = { book: "Book", game: "Game", print: "Print", merch: "Merch" };
function ShopMode() {
  const empty = { id: 0, kind: "merch", title: "", summary: "", image: "", price_coins: 10, weight_g: 500, stock: -1, status: "draft", source_type: "", source_id: 0 };
  const [products, setProducts] = useState<ShopProduct[] | null>(null);
  const [orders, setOrders] = useState<ShopOrder[]>([]);
  const [edit, setEdit] = useState<Record<string, unknown> | null>(null);
  const [tracking, setTracking] = useState<Record<number, string>>({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => ShopFrontApi.studio()
    .then((r) => { setProducts(r.products); setOrders(r.orders); })
    .catch(() => setErr("Couldn't load the shop (operator only)."));
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!edit) return;
    setBusy(true); setErr("");
    try { await ShopFrontApi.saveProduct(edit); setEdit(null); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't save the product."); }
    setBusy(false);
  };
  const act = async (o: ShopOrder, action: "shipped" | "delivered" | "cancel") => {
    if (action === "cancel" && !window.confirm(`Cancel order #${o.id} and refund ₳${o.coins_total}?`)) return;
    setBusy(true); setErr("");
    try { await ShopFrontApi.updateOrder({ id: o.id, action, tracking: tracking[o.id] || "" }); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't update the order."); }
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-5">
      {err && <StatusNote error>{err}</StatusNote>}

      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-[18px] font-bold tracking-tight">Products</h2>
        <Button className="ml-auto" tip="Add a hard-copy product to the shop" onClick={() => setEdit({ ...empty })}>New product</Button>
      </div>

      {edit && (
        <Card className="flex max-w-2xl flex-col gap-3 p-5">
          <h3 className="text-[16px] font-bold tracking-tight">{edit.id ? `Edit product #${edit.id}` : "New product"}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Title" className="sm:col-span-2"><Input value={String(edit.title ?? "")} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
            <Field label="Kind">
              <Select value={String(edit.kind ?? "merch")} onChange={(v) => setEdit({ ...edit, kind: v })}
                options={[{ value: "book", label: "Book (hard copy)" }, { value: "game", label: "Game" }, { value: "print", label: "Illustration print" }, { value: "merch", label: "Merch" }]} />
            </Field>
            <Field label="Status">
              <Select value={String(edit.status ?? "draft")} onChange={(v) => setEdit({ ...edit, status: v })}
                options={[{ value: "draft", label: "Draft (hidden)" }, { value: "published", label: "Published" }]} />
            </Field>
            <Field label="Price (₳)"><Input type="number" min={1} value={Number(edit.price_coins ?? 1)} onChange={(e) => setEdit({ ...edit, price_coins: Number(e.target.value) })} /></Field>
            <Field label="Weight (grams — drives the shipping fee)"><Input type="number" min={1} value={Number(edit.weight_g ?? 500)} onChange={(e) => setEdit({ ...edit, weight_g: Number(e.target.value) })} /></Field>
            <Field label="Stock (−1 = made to order)"><Input type="number" min={-1} value={Number(edit.stock ?? -1)} onChange={(e) => setEdit({ ...edit, stock: Number(e.target.value) })} /></Field>
            <Field label="Source (optional — links the digital original)">
              <div className="flex gap-2">
                <Select value={String(edit.source_type ?? "")} onChange={(v) => setEdit({ ...edit, source_type: v })} className="flex-1"
                  options={[{ value: "", label: "None" }, { value: "document", label: "Book (/read id)" }, { value: "illustration", label: "Illustration (id)" }]} />
                <Input type="number" min={0} value={Number(edit.source_id ?? 0)} onChange={(e) => setEdit({ ...edit, source_id: Number(e.target.value) })} className="w-24" aria-label="Source id" />
              </div>
            </Field>
            <Field label="Summary" className="sm:col-span-2"><Textarea rows={3} value={String(edit.summary ?? "")} onChange={(e) => setEdit({ ...edit, summary: e.target.value })} /></Field>
            <Field label="Image" className="sm:col-span-2"><ImageInput value={String(edit.image ?? "")} onChange={(v) => setEdit({ ...edit, image: v })} /></Field>
          </div>
          <div className="flex gap-2">
            <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
            <Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button>
            {!!edit.id && (
              <Button variant="outline" className="ml-auto text-rose-400" disabled={busy}
                onClick={() => { if (window.confirm("Remove this product from the shop?")) { ShopFrontApi.saveProduct({ id: edit.id, delete: 1 }).then(() => { setEdit(null); load(); }); } }}>
                Remove
              </Button>
            )}
          </div>
        </Card>
      )}

      {products === null ? <SkeletonGrid count={4} /> : products.length === 0 ? (
        <StatusNote>No products yet — add the first hard copy above.</StatusNote>
      ) : (
        <ul className="flex list-none flex-col gap-2">
          {products.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-line p-3">
              <span className="font-semibold text-ink">{p.title}</span>
              <span className="rounded-pill bg-veil/5 px-2 py-0.5 text-[12px] text-ink-3">{SHOP_KIND_LABEL[p.kind] ?? p.kind}</span>
              <span className="text-[12px] text-ink-3">₳{p.price_coins} · {p.weight_g} g · {p.stock < 0 ? "made to order" : `${p.stock} in stock`} · {p.sold} sold</span>
              {p.status !== "published" && <span className="text-[12px] font-semibold text-yang">{p.status}</span>}
              <Button variant="outline" className="ml-auto h-8 px-3 text-[12px]" onClick={() => setEdit({ ...p })}>Edit</Button>
            </li>
          ))}
        </ul>
      )}

      <h2 className="text-[18px] font-bold tracking-tight">Orders</h2>
      {orders.length === 0 ? <StatusNote>No orders yet.</StatusNote> : (
        <ul className="flex list-none flex-col gap-2">
          {orders.map((o) => (
            <li key={o.id} className="flex flex-col gap-2 rounded-card border border-line p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-semibold text-ink">#{o.id} · ₳{o.coins_total}</span>
                <span className="rounded-pill bg-veil/5 px-2 py-0.5 text-[12px] text-ink-3">{o.status}</span>
                <span className="text-[12px] text-ink-3">{o.items.map((i) => `${i.qty}× ${i.title}`).join(" · ")}</span>
                <span className="text-[12px] text-ink-3">{(o.weight_g / 1000).toFixed(1)} kg · {o.service} → {o.country}</span>
              </div>
              {o.ship_to && (
                <p className="text-[12px] text-ink-3">
                  {o.ship_to.name} — {o.ship_to.address}, {o.ship_to.city} {o.ship_to.postcode}, {o.ship_to.country}
                </p>
              )}
              {o.status === "paid" && (
                <div className="flex flex-wrap items-center gap-2">
                  <Input value={tracking[o.id] ?? o.tracking} onChange={(e) => setTracking({ ...tracking, [o.id]: e.target.value })}
                    placeholder="PTT tracking number" aria-label="Tracking number" className="h-8 max-w-60 text-[12px]" />
                  <Button variant="outline" className="h-8 px-3 text-[12px]" disabled={busy} onClick={() => act(o, "shipped")}>Mark shipped</Button>
                  <Button variant="outline" className="h-8 px-3 text-[12px] text-rose-400" disabled={busy} onClick={() => act(o, "cancel")}>Cancel + refund</Button>
                </div>
              )}
              {o.status === "shipped" && (
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="outline" className="h-8 px-3 text-[12px]" disabled={busy} onClick={() => act(o, "delivered")}>Mark delivered</Button>
                  {o.tracking && o.track_url && (
                    <a href={o.track_url} target="_blank" rel="noopener noreferrer" className="text-[12px] font-mono font-semibold text-yin-light hover:underline">PTT {o.tracking} ↗</a>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateForm({ onClose }: { onClose: (createdId?: number) => void }) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    if (!title.trim()) { setErr("Give the course a title."); return; }
    setBusy(true); setErr("");
    try { const r = await Courses.create({ title: title.trim(), summary }); onClose(r.id); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't create the course."); setBusy(false); }
  };
  return (
    <Card className="flex max-w-2xl flex-col gap-4 p-5">
      <h2 className="text-[20px] font-bold tracking-tight">New course</h2>
      {err && <StatusNote error>{err}</StatusNote>}
      <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="How Bridges Work" /></Field>
      <Field label="Summary" optional><Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} placeholder="What will learners get out of it?" /></Field>
      <div className="flex gap-2">
        <Button tip="Create the course, then add its videos" onClick={submit} disabled={busy}>{busy ? "Creating…" : "Create course"}</Button>
        <Button variant="outline" tip="Discard and go back" onClick={() => onClose()}>Cancel</Button>
      </div>
    </Card>
  );
}

function Editor({ course, onClose }: { course: StudioCourseDetail; onClose: (refresh: boolean) => void }) {
  const [title, setTitle] = useState(course.title);
  const [summary, setSummary] = useState(course.summary);
  const [image, setImage] = useState(course.image);
  const [topic, setTopic] = useState(course.topic || "");
  // House (field) options: prefer the LIVE registry the balance chart reads, fall back to the bundled list.
  const [houseOpts, setHouseOpts] = useState<ReadonlyArray<readonly [string, string]>>(HOUSES);
  const [subtopic, setSubtopic] = useState(course.subtopic || "");
  const [searchTerms, setSearchTerms] = useState(course.search_terms || "");
  const [channel, setChannel] = useState(course.channel || "");
  const [lang, setLang] = useState(course.lang || "en");
  const [status, setStatus] = useState(course.status || "publish");
  const [lessons, setLessons] = useState<StudioLesson[]>(course.lessons);
  const [insights, setInsights] = useState<CourseInsights | null>(null);
  const [playlist, setPlaylist] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const touched = JSON.stringify(lessons) !== JSON.stringify(course.lessons);
  useEffect(() => { StudioApi.insights(course.id).then(setInsights).catch(() => {}); }, [course.id]);
  // Match the House picker to the universal What·field control: source its options from the SAME live registry
  // the "Courses balance" wheel uses (Disciplines.list() → houses, operator label overrides applied), so the
  // two ALWAYS stay in sync — including an operator's Labels-tab renames — with no page reload needed.
  useEffect(() => {
    DisciplinesApi.list()
      .then((reg) => { if (reg.houses?.length) setHouseOpts(reg.houses.map((h) => [h.key, h.label] as const)); })
      .catch(() => { /* keep the bundled FIELDS fallback */ });
  }, []);

  const saveMeta = async () => {
    setBusy(true); setErr(""); setNote("");
    try { await StudioApi.update(course.id, { title, summary, image, topic, subtopic, search_terms: searchTerms, channel, lang, status }); setNote("Course details saved."); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't save."); }
    setBusy(false);
  };
  const saveLessons = async () => {
    if (lessons.some((l) => !/^[A-Za-z0-9_-]{6,20}$/.test(l.video))) { setErr("Every video needs a valid YouTube video id."); return; }
    setBusy(true); setErr(""); setNote("");
    try {
      const r = await StudioApi.saveLessons(course.id, lessons);
      setNote(`Videos saved — ${r.kept} kept, ${r.added} added, ${r.removed} removed. ${r.reset ? "A video changed, so the course's trending rank resets while it re-earns its place." : ""}`);
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't save the videos."); }
    setBusy(false);
  };
  const importPlaylist = async () => {
    if (!playlist.trim()) return;
    setBusy(true); setErr(""); setNote("");
    try {
      const r = await StudioApi.importPlaylist(course.id, playlist.trim());
      setNote(`Playlist imported — ${r.added} added${r.skipped_unplayable ? `, ${r.skipped_unplayable} too short/unplayable` : ""}${r.skipped_other_course ? `, ${r.skipped_other_course} already in another course` : ""}. ${r.lesson_count} videos now.`);
      setPlaylist("");
      const fresh = await StudioApi.get(course.id); setLessons(fresh.lessons);
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't import that playlist."); }
    setBusy(false);
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= lessons.length) return;
    const next = [...lessons];
    [next[i], next[j]] = [next[j], next[i]];
    setLessons(next);
  };
  const set = (i: number, patch: Partial<StudioLesson>) => setLessons(lessons.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const courseAction = async (fn: () => Promise<Record<string, unknown>>, label: string) => {
    setBusy(true); setErr(""); setNote("");
    try { const r = await fn(); setNote(`${label} — ${JSON.stringify(r)}`); }
    catch (e) { setErr(e instanceof Error ? e.message : "Action failed."); }
    setBusy(false);
  };

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[20px] font-bold tracking-tight">Edit · {course.title}</h2>
        <a href={localePath(`/courses/${course.slug}/`)} className="text-[13px] font-semibold text-yang hover:underline">View course <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></a>
      </div>
      {note && <StatusNote>{note}</StatusNote>}
      {err && <StatusNote error>{err}</StatusNote>}

      <Card className="flex flex-col gap-4 p-5">
        <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Summary"><Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={5} /></Field>
        <Field label="Cover image" optional><ImageInput value={image} onChange={setImage} placeholder="https://…" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="House" optional>
            <select value={topic} onChange={(e) => setTopic(e.target.value)}
              className="h-11 w-full rounded-card border border-line bg-space-2 px-4 text-[15px] text-ink outline-none focus:border-yin-light">
              <option value="">— pick a house —</option>
              {houseOpts.map(([slug, label]) => <option key={slug} value={slug}>{label}</option>)}
            </select>
          </Field>
          <Field label="Sub-subject" optional>
            <Input value={subtopic} onChange={(e) => setSubtopic(e.target.value)} placeholder="finer subject key under the house" />
          </Field>
        </div>
        <Field label="Discovery keywords" optional>
          <Input value={searchTerms} onChange={(e) => setSearchTerms(e.target.value)} placeholder={course.title} />
          <p className="mt-1 text-[12px] text-ink-3">What the platform searches YouTube for when finding new videos for this course. Tune it to reach the most popular videos on this subject — leave blank to use the title.</p>
        </Field>
        <Field label="Byline — source channel" optional>
          <Input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="e.g. Veritasium" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Language" optional>
            <Input value={lang} onChange={(e) => setLang(e.target.value)} placeholder="en" />
          </Field>
          <Field label="Visibility">
            <select value={status} onChange={(e) => setStatus(e.target.value)}
              className="h-11 w-full rounded-card border border-line bg-space-2 px-4 text-[15px] text-ink outline-none focus:border-yin-light">
              <option value="publish">Published — visible to everyone</option>
              <option value="draft">Draft — hidden from public lists</option>
            </select>
          </Field>
        </div>
        <div><Button tip="Save the title, summary, house, keywords and visibility above" onClick={saveMeta} disabled={busy}>{busy ? "Saving…" : "Save details"}</Button></div>
      </Card>

      {insights && (
        <Card className="flex flex-col gap-3 p-5">
          <h3 className="text-[15px] font-bold">Performance</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Enrolled" value={insights.enrollments.toLocaleString("en")} hint={`${insights.certificates.toLocaleString("en")} certified`} />
            <Stat label="Discussion" value={insights.comments.toLocaleString("en")} hint={`${insights.votes.toLocaleString("en")} upvotes`} />
            <Stat label="Prize pool" value={`₳${insights.prize_pool.toLocaleString("en")}`} hint={`₳${insights.revenue.toLocaleString("en")} revenue`} />
            <Stat label="Rating" value={insights.rating_n > 0 ? `${insights.rating}★` : "—"} hint={insights.rating_n > 0 ? `${insights.rating_n} ratings` : "no ratings yet"} />
          </div>
          {insights.leaders.length > 0 && (
            <div>
              <h4 className="mb-1 text-[13px] font-semibold text-ink-3">Top questers</h4>
              <ol className="flex list-none flex-col gap-1 text-[13px]">
                {insights.leaders.map((l, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="w-5 text-ink-3">{i + 1}.</span>
                    {l.slug ? <a href={localePath(`/u/${l.slug}/`)} className="font-semibold text-yang hover:underline">{l.name}</a> : <span className="font-semibold">{l.name}</span>}
                    <span className="text-ink-3">{l.votes.toLocaleString("en")} upvotes</span>
                    {l.prize > 0 && <span className="ml-auto font-semibold text-yang">₳{l.prize.toLocaleString("en")}</span>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </Card>
      )}

      <Card className="flex flex-col gap-3 p-5">
        <h3 className="text-[15px] font-bold">Videos <span className="font-normal text-ink-3">— the entry fee is ₳1 per video (a course of N videos costs ₳N)</span></h3>
        <ul className="flex list-none flex-col gap-2">
          {lessons.map((l, i) => (
            <li key={`${l.video}-${i}`} className="flex flex-col gap-1.5 rounded-card border border-line p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-6 text-center text-[12px] text-ink-3">{i + 1}</span>
                <Input aria-label="Video title" value={l.title} onChange={(e) => set(i, { title: e.target.value })} placeholder="Video title" className="h-9 min-w-40 flex-1 text-[14px]" />
                <Input aria-label="YouTube video id" value={l.video} onChange={(e) => set(i, { video: e.target.value.trim() })} placeholder="YouTube id" className="h-9 w-36 font-mono text-[13px]" />
                {typeof l.rate === "number" && l.rate > 0 && <span className="text-[12px] font-semibold text-yang" title="rolling comments per day">▲ {l.rate}/day</span>}
                <span className="flex gap-1">
                  <Button variant="outline" tip="Move up" onClick={() => move(i, -1)} disabled={i === 0} className="h-9 px-2.5" aria-label="Move up">↑</Button>
                  <Button variant="outline" tip="Move down" onClick={() => move(i, 1)} disabled={i === lessons.length - 1} className="h-9 px-2.5" aria-label="Move down">↓</Button>
                  <Button variant="outline" tip="Remove this video from the course" onClick={() => setLessons(lessons.filter((_, k) => k !== i))} className={cx("h-9 px-2.5 text-rose-400")} aria-label="Remove video">✕</Button>
                </span>
              </div>
              {/* Segment trim — turn one long video into a focused section by clipping to a span (seconds).
                  Leave both 0 to play the whole video. A trim change re-syncs the section (ids preserved). */}
              <div className="flex flex-wrap items-center gap-2 ps-8 text-[12px] text-ink-3">
                <span>Trim (optional):</span>
                <span>from <Input type="number" aria-label="Trim start (seconds)" min={0} value={l.seg_start || 0} onChange={(e) => set(i, { seg_start: Math.max(0, parseInt(e.target.value, 10) || 0) })} className="h-8 w-20 text-[13px]" /> s</span>
                <span>to <Input type="number" aria-label="Trim end (seconds)" min={0} value={l.seg_end || 0} onChange={(e) => set(i, { seg_end: Math.max(0, parseInt(e.target.value, 10) || 0) })} className="h-8 w-20 text-[13px]" /> s</span>
                <span className="text-ink-3/70">(0 = whole video)</span>
              </div>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" tip="Add an empty video row to fill in" onClick={() => setLessons([...lessons, { title: "", video: "", duration: 0 }])}>Add a video</Button>
          <Button tip="Save the video list — re-syncs the course (ids preserved); any video change resets its trending rank" onClick={saveLessons} disabled={busy || !lessons.length}>{busy ? "Saving…" : touched ? "Save videos" : "Save videos (no changes)"}</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line/60 pt-3">
          <span className="text-[13px] text-ink-3">or bulk-add a whole playlist:</span>
          <Input aria-label="YouTube playlist URL" value={playlist} onChange={(e) => setPlaylist(e.target.value)} placeholder="YouTube playlist URL" className="h-9 min-w-48 flex-1 text-[14px]" />
          <Button variant="outline" tip="Fetch a YouTube playlist and add all its playable videos at once" onClick={importPlaylist} disabled={busy || !playlist.trim()}>{busy ? "Importing…" : "Import playlist"}</Button>
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-5">
        <h3 className="text-[15px] font-bold">Discovery &amp; health</h3>
        {course.candidates && course.candidates.length > 0 ? (
          <p className="text-[13px] text-ink-3">
            Testing now:{" "}
            {course.candidates.map((c) => (
              <span key={c.video} className="me-3">
                <a href={`https://youtu.be/${c.video}`} target="_blank" rel="noreferrer" className="font-mono text-yin-light hover:underline">{c.video}</a>
                {" "}<span className={cx(c.rate >= c.baseline && c.rate > 0 ? "text-yang" : "")}>{c.rate}/day vs {c.baseline}</span>, {c.ripe_in > 0 ? `ripe in ${rel(c.ripe_in)}` : "ready"}
              </span>
            ))}
          </p>
        ) : <p className="text-[13px] text-ink-3">No candidate video is being tested for this course right now.</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" tip={{ title: "Find a video now", body: "Searches this course's discovery keywords and tracks the best fresh candidate for a 24-hour trial. It joins the course only if its measured comment rate beats the course's — never instantly. Skips if one is already incubating." }} onClick={() => courseAction(() => StudioApi.discover(course.id), "Find a video")} disabled={busy}>Find a video now</Button>
          <Button variant="outline" tip={{ title: "Refresh rates", body: "Re-fetches this course's videos' YouTube comment counts right now, so the per-video /day figures reflect the latest measurement." }} onClick={() => courseAction(() => StudioApi.refresh(course.id), "Refreshed rates")} disabled={busy}>Refresh rates</Button>
          <Button variant="outline" tip={{ title: "Recompute rank", body: "Re-derives this course's trending rank and thumbnail from its videos' current rates, without changing any videos." }} onClick={() => courseAction(() => StudioApi.recompute(course.id), "Recomputed rank")} disabled={busy}>Recompute rank</Button>
        </div>
        <p className="text-[12px] text-ink-3/70">"Find a video now" searches this course's discovery keywords and tracks the best new one — it joins the course in ~24h only if its discussion rate beats the course's. Reopen to see updated rates.</p>
      </Card>

      <DeleteCourse course={course} onDeleted={() => onClose(true)} />

      <div><Button variant="outline" tip="Return to the course list" onClick={() => onClose(true)}><span aria-hidden className="inline-block rtl:-scale-x-100">←</span> Back to your courses</Button></div>
    </div>
  );
}

/** Owner delete with an inline two-step confirm (the Thread.tsx idiom). The backend allows it
 *  only while no OTHER member has enrolled — once entry fees fund the prize pool, it refuses
 *  (409) and the message explains why. */
function DeleteCourse({ course, onDeleted }: { course: StudioCourseDetail; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const doDelete = async () => {
    setBusy(true); setErr("");
    try { await StudioApi.remove(course.id); onDeleted(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't delete the course."); setBusy(false); setConfirming(false); }
  };
  return (
    <Card className="flex flex-col gap-3 border-rose-400/25 p-5">
      <h3 className="text-[15px] font-bold text-rose-300">Delete this course</h3>
      <p className="text-[13px] leading-relaxed text-ink-3">
        Deleting is permanent: the course, its video list and its discussion boards are all removed.
        It's only possible while no other member has enrolled — once someone has paid the entry fee, the course stays.
      </p>
      {err && <StatusNote error>{err}</StatusNote>}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[13px] font-semibold text-ink">Delete “{course.title}” for good? This can't be undone.</span>
          <span className="flex gap-2">
            <Button variant="outline" tip="Permanently delete — only allowed while no other member has enrolled" onClick={doDelete} disabled={busy} className="border-rose-400/40 text-rose-300 hover:border-rose-300 hover:text-rose-200">{busy ? "Deleting…" : "Yes, delete it"}</Button>
            <Button variant="outline" tip="Cancel — keep it" onClick={() => setConfirming(false)} disabled={busy}>Keep it</Button>
          </span>
        </div>
      ) : (
        <div><Button variant="outline" tip="Delete this — refused once another member has enrolled" onClick={() => setConfirming(true)} className="border-rose-400/40 text-rose-300 hover:border-rose-300 hover:text-rose-200">Delete course</Button></div>
      )}
    </Card>
  );
}

/* ────────────────────────────── Topics ──────────────────────────────
   Edit the DB-backed typology systems. A topic is far richer than a course: its blurb, its
   media, its options (single/multi) or dimensions (spectrum), its citations and its
   industry sponsor are all editable here — the operator can reshape ANY of it. */

const TOPIC_STATUSES = ["empirical", "popular", "traditional", "cultural", "demographic"] as const;
const TOPIC_FORMATS = ["single", "multi", "spectrum"] as const;

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/* Select now lives in the shared design system (components/ui.tsx) — used by both Studio and the
   catalogue sort, so there is one source of truth for the field look + accessible name. */

function TopicsMode() {
  const [topics, setTopics] = useState<StudioTopicCard[] | null>(null);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<StudioTopic | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");

  const reload = () => StudioTopics.list().then((r) => setTopics(r.items)).catch(() => setErr("Couldn't load topics — please refresh."));
  useEffect(() => { reload(); }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (topics ?? []).filter((t) =>
      !needle || t.name.toLowerCase().includes(needle) || t.key.includes(needle) || t.category.toLowerCase().includes(needle));
  }, [topics, q]);

  const openEditor = async (key: string) => {
    setErr("");
    try { setEditing(await StudioTopics.get(key)); window.scrollTo({ top: 0 }); }
    catch { setErr("Couldn't open that topic."); }
  };

  if (editing) {
    return <TopicEditor topic={editing} isNew={false}
      onClose={(refresh) => { setEditing(null); if (refresh) reload(); }} />;
  }
  if (creating) {
    return <TopicEditor topic={blankTopic()} isNew
      onClose={(refresh, key) => { setCreating(false); if (refresh) reload(); if (key) openEditor(key); }} />;
  }

  return (
    <>
      {err && <StatusNote error>{err}</StatusNote>}
      <DistBalance metric="topics" />
      <div className="flex flex-wrap items-center gap-3">
        <SearchPill value={q} onChange={setQ} placeholder={`Search ${topics?.length ?? ""} topics…`} className="max-w-sm flex-1" />
        <Button tip="Create a new typology topic" onClick={() => setCreating(true)}>New topic</Button>
      </div>
      {topics === null ? <SkeletonGrid count={6} /> : (
        /* auto-fit, not `sm:`/`lg:` (operator 2026-08-21). The topic chips (category, status, trend) sat
            in a 114px card at 1024, where this column is ~366px. 13rem a card: three at 1440 (~220px), two
            at 1280 (~279px), one from 1024 down. */
        <ul className="grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-3">
          {filtered.map((t) => (
            <li key={t.key}>
              <button type="button" title="Open this topic to edit it" onClick={() => openEditor(t.key)}
                className="group flex h-full w-full flex-col gap-2 rounded-card border border-line bg-veil/[0.02] p-3 text-start transition-colors hover:border-yang/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yang/60">
                <span className="font-semibold leading-snug text-ink transition-colors group-hover:text-yang">{t.name}</span>
                <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
                  {t.category && <span className="rounded-full border border-line px-2 py-0.5">{t.category}</span>}
                  {t.status && <span className="rounded-full border border-yin/40 px-2 py-0.5 text-yin-light">{t.status}</span>}
                  {typeof t.trend === "number" && t.trend >= 0 && <span className="rounded-full border border-yang/40 px-2 py-0.5 font-semibold text-yang" title="Search-demand score (0–100): how close worldwide Google interest is to this topic's all-time peak, blended with its long-run trajectory since 2004">trend {t.trend}</span>}
                </span>
                {t.sponsor && <span className="mt-auto text-[12px] font-semibold text-yang">Sponsored by {t.sponsor}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function blankTopic(): StudioTopic {
  return {
    key: "", name: "", category: "", status: "popular", statusNote: "", blurb: "",
    format: "single", selfDescribe: false, source: "", video: "", instructor: "", course: "", image: "",
    sign: "",
    options: [], dimensions: [], citations: [],
    sponsor_name: "", sponsor_url: "", sponsor_logo: "",
  };
}

function TopicEditor({ topic, isNew, onClose }: {
  topic: StudioTopic; isNew: boolean; onClose: (refresh: boolean, openKey?: string) => void;
}) {
  const [name, setName] = useState(topic.name);
  const [key, setKey] = useState(topic.key);
  const [savedKey, setSavedKey] = useState(topic.key); // the key currently persisted (changes after a rename)
  const [keyTouched, setKeyTouched] = useState(false);
  const [category, setCategory] = useState(topic.category);
  const [sign, setSign] = useState(topic.sign || "");
  const [status, setStatus] = useState(topic.status || "popular");
  const [format, setFormat] = useState(topic.format || "single");
  const [selfDescribe, setSelfDescribe] = useState(topic.selfDescribe);
  const [source, setSource] = useState(topic.source);
  const [blurb, setBlurb] = useState(topic.blurb);
  const [statusNote, setStatusNote] = useState(topic.statusNote);
  const [video, setVideo] = useState(topic.video);
  const [instructor, setInstructor] = useState(topic.instructor);
  const [course, setCourse] = useState(topic.course);
  const [image, setImage] = useState(topic.image);
  const [options, setOptions] = useState<TopicOption[]>(topic.options ?? []);
  const [dimensions, setDimensions] = useState<TopicDimension[]>(topic.dimensions ?? []);
  const [citations, setCitations] = useState<TopicCitation[]>(topic.citations ?? []);
  const [sponsorName, setSponsorName] = useState(topic.sponsor_name);
  const [sponsorUrl, setSponsorUrl] = useState(topic.sponsor_url);
  const [sponsorLogo, setSponsorLogo] = useState(topic.sponsor_logo);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [trend, setTrend] = useState<TrendSeries | null>(null);
  useEffect(() => {
    if (isNew || !savedKey) { setTrend(null); return; }
    let on = true;
    TrendsApi.get(`topic:${savedKey}`).then((t) => { if (on) setTrend(t.found ? t : null); }).catch(() => {});
    return () => { on = false; };
  }, [isNew, savedKey]);

  // On create, derive the key slug from the name until the operator edits it directly.
  const onNameChange = (v: string) => {
    setName(v);
    if (isNew && !keyTouched) setKey(slugify(v));
  };

  const save = async () => {
    if (!name.trim()) { setErr("Give the topic a name."); return; }
    if (!key.trim()) { setErr("Give the topic a key (slug)."); return; }
    setBusy(true); setErr(""); setNote("");
    const body: StudioTopicSave = {
      name: name.trim(), category, sign, status, format, selfDescribe, source,
      blurb, statusNote, video: video.trim(), instructor, course, image,
      options, dimensions, citations,
      sponsor_name: sponsorName, sponsor_url: sponsorUrl, sponsor_logo: sponsorLogo,
    };
    try {
      if (isNew) {
        const r = await StudioTopics.create({ ...body, key: key.trim() });
        onClose(true, r.key);
      } else {
        // A changed key RENAMES the topic's slug everywhere (#141); the old URL then 301-redirects here.
        const nextKey = key.trim();
        const r = await StudioTopics.update(savedKey, nextKey !== savedKey ? { ...body, newKey: nextKey } : body);
        setSavedKey(r.key);
        setKey(r.key); // reflect the server-canonicalised key
        setNote(r.renamed ? "Topic saved — key renamed. The old link now redirects here." : "Topic saved.");
      }
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't save the topic."); }
    setBusy(false);
  };

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[20px] font-bold tracking-tight">{isNew ? "New topic" : `Edit · ${topic.name}`}</h2>
        {!isNew && <a href={localePath(`/topics/${savedKey}/`)} className="text-[13px] font-semibold text-yang hover:underline">View topic <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></a>}
      </div>
      {note && <StatusNote>{note}</StatusNote>}
      {err && <StatusNote error>{err}</StatusNote>}

      {!isNew && (((typeof topic.trend === "number" && topic.trend >= 0)) || trend) && (
        <Card className="flex flex-col gap-3 p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[15px] font-bold">Search demand</h3>
            {(trend?.score ?? topic.trend ?? -1) >= 0 && <span className="rounded-full border border-yang/40 px-2.5 py-0.5 text-[13px] font-bold text-yang">{trend?.score ?? topic.trend}/100</span>}
          </div>
          {trend && trend.series.length > 1 ? (
            <>
              <TrendChart series={trend.series} height={90} from="2004" to="today" showAxis className="text-ink-3" label={`Search interest in ${trend.query}`} />
              <p className="text-[12px] text-ink-3">Worldwide Google interest in <b className="text-ink-2">“{trend.query}”</b> since 2004 — recent {trend.recent}/100, all-time low {trend.trough}, {(trend.momentum ?? 0) >= 0 ? `up ${trend.momentum}` : `down ${Math.abs(trend.momentum ?? 0)}`} vs its 2004 level. The score blends how near today's interest is to the all-time peak with that long-run trajectory.</p>
            </>
          ) : (
            <p className="text-[12px] text-ink-3">Demand score {topic.trend}/100. The full curve is still syncing.</p>
          )}
        </Card>
      )}

      {/* Basics */}
      <Card className="flex flex-col gap-4 p-5">
        <h3 className="text-[15px] font-bold">Basics</h3>
        <Field label="Name"><Input value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="The Big Five" /></Field>
        <Field label="Key">
          <Input value={key}
            onChange={(e) => { setKeyTouched(true); setKey(slugify(e.target.value)); }}
            placeholder="big-five" className="font-mono text-[14px]" />
        </Field>
        <p className="-mt-2 text-[12px] text-ink-3">
          {isNew
            ? "The key is the topic's slug in its URL — lowercase, dashes for spaces."
            : "The key is the topic's slug in its URL. Editing it renames the topic everywhere; the old link will 301-redirect here."}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category (primary discipline)"><Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="psychology-clinical" /></Field>
          <Field label="Status"><Select value={status} onChange={setStatus} options={TOPIC_STATUSES} /></Field>
          <Field label="Format"><Select value={format} onChange={setFormat} options={TOPIC_FORMATS} /></Field>
          <Field label="Source" optional><Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Where this typology comes from" /></Field>
          <Field label="How — the approach"><Select value={sign} onChange={setSign} options={SIGN_OPTS} /></Field>
        </div>
        <p className="-mt-2 text-[12px] text-ink-3">The signature shown in plain words: <strong>What</strong> is the field (from the category) and <strong>How</strong> the approach. How is independent of the field and feeds the balance charts. (Why was retired as a content tag — it now lives only as the study cycles.)</p>
        <CheckField checked={selfDescribe} onChange={setSelfDescribe}>Members may self-describe (free-text) instead of picking an option</CheckField>
      </Card>

      {/* Description */}
      <Card className="flex flex-col gap-4 p-5">
        <h3 className="text-[15px] font-bold">Description</h3>
        <Field label="Blurb"><Textarea value={blurb} onChange={(e) => setBlurb(e.target.value)} rows={4} placeholder="What this topic is, in plain English" /></Field>
        <Field label="Status note" optional><Textarea value={statusNote} onChange={(e) => setStatusNote(e.target.value)} rows={3} placeholder="A caveat about the evidence behind this typology" /></Field>
      </Card>

      {/* Pedagogy media */}
      <Card className="flex flex-col gap-4 p-5">
        <h3 className="text-[15px] font-bold">Pedagogy media</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Video" optional><Input value={video} onChange={(e) => setVideo(e.target.value.trim())} placeholder="YouTube id" className="font-mono text-[14px]" /></Field>
          <Field label="Instructor" optional><Input value={instructor} onChange={(e) => setInstructor(e.target.value)} placeholder="Who teaches the intro" /></Field>
          <Field label="Course" optional><Input value={course} onChange={(e) => setCourse(e.target.value)} placeholder="/courses/slug" /></Field>
          <Field label="Image" optional><ImageInput value={image} onChange={setImage} placeholder="URL or topic-art/<key>.svg" /></Field>
        </div>
      </Card>

      {/* Dimensions (spectrum) */}
      <Card className="flex flex-col gap-3 p-5">
        <h3 className="text-[15px] font-bold">Dimensions <span className="font-normal text-ink-3">— the spectrum poles (used when format is spectrum)</span></h3>
        <RowList
          rows={dimensions}
          onChange={setDimensions}
          blank={() => ({ key: "", name: "", low: "", high: "", desc: "", image: "" })}
          addLabel="Add a dimension"
          render={(d, set) => (
            <>
              <Input aria-label="Dimension key" value={d.key} onChange={(e) => set({ key: slugify(e.target.value) })} placeholder="key" className="h-9 w-28 font-mono text-[13px]" />
              <Input aria-label="Dimension name" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Name" className="h-9 min-w-32 flex-1 text-[14px]" />
              <Input aria-label="Low pole" value={d.low} onChange={(e) => set({ low: e.target.value })} placeholder="Low pole" className="h-9 w-32 text-[14px]" />
              <Input aria-label="High pole" value={d.high} onChange={(e) => set({ high: e.target.value })} placeholder="High pole" className="h-9 w-32 text-[14px]" />
              <Input aria-label="Dimension description" value={d.desc ?? ""} onChange={(e) => set({ desc: e.target.value })} placeholder="Description (optional)" className="h-9 min-w-40 flex-1 text-[14px]" />
              <ImageInput compact ariaLabel="Dimension image" value={d.image ?? ""} onChange={(v) => set({ image: v })} placeholder="Image (optional)" className="min-w-48" />
            </>
          )}
        />
      </Card>

      {/* Options (single / multi) */}
      <Card className="flex flex-col gap-3 p-5">
        <h3 className="text-[15px] font-bold">Options <span className="font-normal text-ink-3">— the groups members can stand with (used when format is single or multi)</span></h3>
        <RowList
          rows={options}
          onChange={setOptions}
          blank={() => ({ key: "", label: "", short: "", desc: "", image: "" })}
          addLabel="Add an option"
          render={(o, set) => (
            <>
              <Input aria-label="Option key" value={o.key} onChange={(e) => set({ key: slugify(e.target.value) })} placeholder="key" className="h-9 w-28 font-mono text-[13px]" />
              <Input aria-label="Option label" value={o.label} onChange={(e) => set({ label: e.target.value })} placeholder="Label" className="h-9 min-w-32 flex-1 text-[14px]" />
              <Input aria-label="Option short label" value={o.short ?? ""} onChange={(e) => set({ short: e.target.value })} placeholder="Short (optional)" className="h-9 w-32 text-[14px]" />
              <Input aria-label="Option description" value={o.desc ?? ""} onChange={(e) => set({ desc: e.target.value })} placeholder="Description (optional)" className="h-9 min-w-40 flex-1 text-[14px]" />
              <ImageInput compact ariaLabel="Option image" value={o.image ?? ""} onChange={(v) => set({ image: v })} placeholder="Image (optional)" className="min-w-48" />
            </>
          )}
        />
      </Card>

      {/* Citations */}
      <Card className="flex flex-col gap-3 p-5">
        <h3 className="text-[15px] font-bold">Citations <span className="font-normal text-ink-3">— the sources behind the typology</span></h3>
        <RowList
          rows={citations}
          onChange={setCitations}
          blank={() => ({ title: "", authors: "", year: undefined, venue: "", doi: "" })}
          addLabel="Add a citation"
          render={(c, set) => (
            <>
              <Input aria-label="Citation title" value={c.title} onChange={(e) => set({ title: e.target.value })} placeholder="Title" className="h-9 min-w-48 flex-1 text-[14px]" />
              <Input aria-label="Citation authors" value={c.authors ?? ""} onChange={(e) => set({ authors: e.target.value })} placeholder="Authors" className="h-9 min-w-32 flex-1 text-[14px]" />
              <Input type="number" aria-label="Citation year" value={c.year ?? ""} onChange={(e) => set({ year: e.target.value ? Number(e.target.value) : undefined })} placeholder="Year" className="h-9 w-24 text-[14px]" />
              <Input aria-label="Citation venue" value={c.venue ?? ""} onChange={(e) => set({ venue: e.target.value })} placeholder="Venue" className="h-9 min-w-32 flex-1 text-[14px]" />
              <Input aria-label="Citation DOI" value={c.doi ?? ""} onChange={(e) => set({ doi: e.target.value })} placeholder="DOI" className="h-9 w-40 font-mono text-[13px]" />
            </>
          )}
        />
      </Card>

      {/* Sponsor */}
      <Card className="flex flex-col gap-4 p-5">
        <h3 className="text-[15px] font-bold">Sponsor <span className="font-normal text-ink-3">— an industry partner credited on the topic</span></h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Sponsor name" optional><Input value={sponsorName} onChange={(e) => setSponsorName(e.target.value)} placeholder="Partner organisation" /></Field>
          <Field label="Sponsor URL" optional><Input value={sponsorUrl} onChange={(e) => setSponsorUrl(e.target.value)} placeholder="https://…" /></Field>
          <Field label="Sponsor logo" optional className="sm:col-span-2"><ImageInput value={sponsorLogo} onChange={setSponsorLogo} placeholder="Logo URL" /></Field>
        </div>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button tip="Save this topic — its name, blurb, options, citations and sponsor" onClick={save} disabled={busy}>{busy ? "Saving…" : isNew ? "Create topic" : "Save topic"}</Button>
        <Button variant="outline" tip={isNew ? "Discard this new topic" : "Back to the topic list"} onClick={() => onClose(false)}>{isNew ? "Cancel" : "← Back to topics"}</Button>
      </div>

      {!isNew && <DeleteTopic topic={topic} onDeleted={() => onClose(true)} />}
    </div>
  );
}

/** A reusable add/remove list of editable rows — the {options,dimensions,citations} idiom shared
 *  across the editor. `render` draws one row's inputs; `set` patches that row in place. */
function RowList<T>({ rows, onChange, blank, addLabel, render }: {
  rows: T[];
  onChange: (rows: T[]) => void;
  blank: () => T;
  addLabel: string;
  render: (row: T, set: (patch: Partial<T>) => void) => ReactNode;
}) {
  const set = (i: number, patch: Partial<T>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <>
      <ul className="flex list-none flex-col gap-2">
        {rows.map((row, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 rounded-card border border-line p-2">
            <span className="w-6 text-center text-[12px] text-ink-3">{i + 1}</span>
            {render(row, (patch) => set(i, patch))}
            <span className="flex gap-1">
              <Button variant="outline" tip="Move up" onClick={() => move(i, -1)} disabled={i === 0} className="h-9 px-2.5" aria-label="Move up">↑</Button>
              <Button variant="outline" tip="Move down" onClick={() => move(i, 1)} disabled={i === rows.length - 1} className="h-9 px-2.5" aria-label="Move down">↓</Button>
              <Button variant="outline" tip="Remove this row" onClick={() => onChange(rows.filter((_, k) => k !== i))} className={cx("h-9 px-2.5 text-rose-400")} aria-label="Remove row">✕</Button>
            </span>
          </li>
        ))}
      </ul>
      <div><Button variant="outline" tip="Add another row" onClick={() => onChange([...rows, blank()])}>{addLabel}</Button></div>
    </>
  );
}

/** Soft-delete a topic, with the two-step confirm (the DeleteCourse idiom). */
function DeleteTopic({ topic, onDeleted }: { topic: StudioTopic; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const doDelete = async () => {
    setBusy(true); setErr("");
    try { await StudioTopics.remove(topic.key); onDeleted(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't delete the topic."); setBusy(false); setConfirming(false); }
  };
  return (
    <Card className="flex flex-col gap-3 border-rose-400/25 p-5">
      <h3 className="text-[15px] font-bold text-rose-300">Delete this topic</h3>
      <p className="text-[13px] leading-relaxed text-ink-3">
        Deleting hides the topic from the platform. Its members' picks are kept, so it can be restored.
      </p>
      {err && <StatusNote error>{err}</StatusNote>}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[13px] font-semibold text-ink">Delete “{topic.name}”?</span>
          <span className="flex gap-2">
            <Button variant="outline" tip="Permanently delete — only allowed while no other member has enrolled" onClick={doDelete} disabled={busy} className="border-rose-400/40 text-rose-300 hover:border-rose-300 hover:text-rose-200">{busy ? "Deleting…" : "Yes, delete it"}</Button>
            <Button variant="outline" tip="Cancel — keep it" onClick={() => setConfirming(false)} disabled={busy}>Keep it</Button>
          </span>
        </div>
      ) : (
        <div><Button variant="outline" tip="Delete this — refused once another member has enrolled" onClick={() => setConfirming(true)} className="border-rose-400/40 text-rose-300 hover:border-rose-300 hover:text-rose-200">Delete topic</Button></div>
      )}
    </Card>
  );
}

/* ────────────────────────────── Grants ──────────────────────────────
   Edit the DB-backed funding programmes (aq_grants) that surface on the public /sponsors page — the
   author or an operator can change anything. Mirrors the Topics mode: searchable list → editor.
   "Industry-sponsor" grants (an industry partner, not a charity) are badged in gold. */

const DEADLINE_TYPES = ["fixed_date", "annual_recurring", "rolling"] as const;
const GRANT_FITS = ["0", "1", "2", "3", "4", "5"] as const;
const SPONSOR_CATEGORY = "industry-sponsor";

/** A small 0–5 fit indicator (filled gold dots), matching the public Grants page's fit emphasis. */
function FitDots({ fit }: { fit: number }) {
  const n = Math.max(0, Math.min(5, fit));
  return (
    <span className="inline-flex items-center gap-0.5" title={`Fit ${n}/5`} aria-label={`Fit ${n} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={cx("h-1.5 w-1.5 rounded-full", i <= n ? "bg-yang" : "bg-veil/15")} />
      ))}
    </span>
  );
}

function GrantsMode() {
  const [grants, setGrants] = useState<StudioGrantCard[] | null>(null);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<StudioGrant | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");

  const reload = () => StudioGrants.list().then((r) => setGrants(r.items)).catch(() => setErr("Couldn't load sponsors — please refresh."));
  useEffect(() => { reload(); }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (grants ?? []).filter((g) =>
      !needle || g.title.toLowerCase().includes(needle) || g.funder.toLowerCase().includes(needle) || g.category.toLowerCase().includes(needle));
  }, [grants, q]);

  const openEditor = async (id: number) => {
    setErr("");
    try { setEditing(await StudioGrants.get(id)); window.scrollTo({ top: 0 }); }
    catch { setErr("Couldn't open that sponsor."); }
  };

  if (editing) {
    return <GrantEditor grant={editing} isNew={false}
      onClose={(refresh) => { setEditing(null); if (refresh) reload(); }} />;
  }
  if (creating) {
    return <GrantEditor grant={blankGrant()} isNew
      onClose={(refresh, id) => { setCreating(false); if (refresh) reload(); if (id) openEditor(id); }} />;
  }

  return (
    <>
      {err && <StatusNote error>{err}</StatusNote>}
      <div className="flex flex-wrap items-center gap-3">
        <SearchPill value={q} onChange={setQ} placeholder={`Search ${grants?.length ?? ""} sponsors…`} className="max-w-sm flex-1" />
        <Button tip="Add a new sponsor / grant opportunity" onClick={() => setCreating(true)}>New sponsor</Button>
      </div>
      {grants === null ? <SkeletonGrid count={6} /> : (
        /* auto-fit, not `sm:`/`lg:` (operator 2026-08-21). A sponsor card carries a title, a funder line
            and a deadline; three tracks in the ~366px column at 1024 left 114px for all of it. 13rem a
            card: three at 1440, two at 1280, one from 1024 down. */
        <ul className="grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-3">
          {filtered.map((g) => {
            const sponsor = g.category === SPONSOR_CATEGORY;
            return (
              <li key={g.id}>
                <button type="button" title="Open this sponsor to edit it" onClick={() => openEditor(g.id)}
                  className="group flex h-full w-full flex-col gap-2 rounded-card border border-line bg-veil/[0.02] p-3 text-start transition-colors hover:border-yang/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yang/60">
                  <span className="flex items-start justify-between gap-2">
                    <span className={cx("font-semibold leading-snug transition-colors group-hover:text-yang", g.active === 0 ? "text-ink-3" : "text-ink")}>{g.title}</span>
                    <FitDots fit={g.fit} />
                  </span>
                  {g.funder && <span className="text-[12.5px] text-ink-3">{g.funder}</span>}
                  <span className="mt-auto flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
                    {sponsor
                      ? <span className="rounded-full bg-yang/15 px-2 py-0.5 font-semibold text-yang">Industry partner</span>
                      : g.category && <span className="rounded-full border border-line px-2 py-0.5">{g.category}</span>}
                    {g.deadline && <span className="tabular-nums">{g.deadline}</span>}
                    {g.active === 0 && <span className="rounded-full border border-line px-2 py-0.5 text-ink-3/70">inactive</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function blankGrant(): StudioGrant {
  return {
    id: 0, slug: "", title: "", funder: "", url: "", country: "", category: "",
    currency: "", amount_cad: 0, amount_display: "", deadline: "", deadline_type: "fixed_date",
    estimated: false, eligibility_ca: "", eligibility_intl: "", allows_regranting: "",
    fit: 0, confidence: "", capacity: 0, points: 0, summary: "", red_flags: "", active: 1,
  };
}

function GrantEditor({ grant, isNew, onClose }: {
  grant: StudioGrant; isNew: boolean; onClose: (refresh: boolean, openId?: number) => void;
}) {
  const [title, setTitle] = useState(grant.title);
  const [funder, setFunder] = useState(grant.funder);
  const [url, setUrl] = useState(grant.url);
  const [country, setCountry] = useState(grant.country);
  const [category, setCategory] = useState(grant.category);
  const [active, setActive] = useState(grant.active !== 0);
  const [amountCad, setAmountCad] = useState(grant.amount_cad);
  const [amountDisplay, setAmountDisplay] = useState(grant.amount_display);
  const [deadline, setDeadline] = useState(grant.deadline);
  const [deadlineType, setDeadlineType] = useState(grant.deadline_type || "fixed_date");
  const [estimated, setEstimated] = useState(grant.estimated);
  const [currency, setCurrency] = useState(grant.currency);
  const [fit, setFit] = useState(grant.fit ?? 0);
  const [confidence, setConfidence] = useState(grant.confidence);
  const [capacity, setCapacity] = useState(grant.capacity ?? 0);
  const [points, setPoints] = useState(grant.points ?? 0);
  const [eligibilityCa, setEligibilityCa] = useState(grant.eligibility_ca);
  const [eligibilityIntl, setEligibilityIntl] = useState(grant.eligibility_intl);
  const [allowsRegranting, setAllowsRegranting] = useState(grant.allows_regranting);
  const [summary, setSummary] = useState(grant.summary);
  const [redFlags, setRedFlags] = useState(grant.red_flags);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  // A number <input> that keeps its raw text while editing but stores a clean number (NaN → 0).
  const numHandler = (set: (n: number) => void) => (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value.trim();
    set(v === "" ? 0 : Number.isNaN(Number(v)) ? 0 : Number(v));
  };

  const save = async () => {
    if (!title.trim()) { setErr("Give the sponsor a title."); return; }
    setBusy(true); setErr(""); setNote("");
    const body: StudioGrantSave = {
      title: title.trim(), funder, url: url.trim(), country, category,
      currency, amount_cad: amountCad, amount_display: amountDisplay,
      deadline: deadline.trim(), deadline_type: deadlineType, estimated,
      fit, confidence, capacity, points,
      eligibility_ca: eligibilityCa, eligibility_intl: eligibilityIntl, allows_regranting: allowsRegranting,
      summary, red_flags: redFlags, active: active ? 1 : 0,
    };
    try {
      if (isNew) {
        const r = await StudioGrants.create(body);
        onClose(true, r.id);
      } else {
        await StudioGrants.update(grant.id, body);
        setNote("Sponsor saved.");
      }
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't save the sponsor."); }
    setBusy(false);
  };

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[20px] font-bold tracking-tight">{isNew ? "New sponsor" : `Edit · ${grant.title}`}</h2>
        <a href={localePath("/sponsors/")} className="text-[13px] font-semibold text-yang hover:underline">View sponsors <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></a>
      </div>
      {note && <StatusNote>{note}</StatusNote>}
      {err && <StatusNote error>{err}</StatusNote>}

      {/* Basics */}
      <Card className="flex flex-col gap-4 p-5">
        <h3 className="text-[15px] font-bold">Basics</h3>
        <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Open Education Fund" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Funder" optional><Input value={funder} onChange={(e) => setFunder(e.target.value)} placeholder="The funding organisation" /></Field>
          <Field label="Country" optional><Input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="e.g. Canada, International" /></Field>
          <Field label="URL" optional><Input value={url} onChange={(e) => setUrl(e.target.value.trim())} placeholder="https://…" /></Field>
          <Field label="Category" optional><Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. industry-sponsor" /></Field>
        </div>
        <CheckField checked={active} onChange={setActive}>Active (shown on the public Sponsors page)</CheckField>
      </Card>

      {/* Amount & deadline */}
      <Card className="flex flex-col gap-4 p-5">
        <h3 className="text-[15px] font-bold">Amount &amp; deadline</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount (CAD)" optional><Input type="number" min={0} value={amountCad || ""} onChange={numHandler(setAmountCad)} placeholder="100000" /></Field>
          <Field label="Amount display" optional><Input value={amountDisplay} onChange={(e) => setAmountDisplay(e.target.value)} placeholder="up to USD 100,000" /></Field>
          <Field label="Currency" optional><Input value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder="CAD" /></Field>
          <Field label="Deadline" optional><Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} placeholder="YYYY-MM-DD" /></Field>
          <Field label="Deadline type"><Select value={deadlineType} onChange={setDeadlineType} options={DEADLINE_TYPES} /></Field>
        </div>
        <CheckField checked={estimated} onChange={setEstimated}>Deadline is estimated from prior cycles (shown with ≈)</CheckField>
      </Card>

      {/* Fit & eligibility */}
      <Card className="flex flex-col gap-4 p-5">
        <h3 className="text-[15px] font-bold">Fit &amp; eligibility</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Fit (0–5)"><Select value={String(fit)} onChange={(v) => setFit(Number(v))} options={GRANT_FITS} /></Field>
          <Field label="Confidence" optional><Input value={confidence} onChange={(e) => setConfidence(e.target.value)} placeholder="e.g. high, medium" /></Field>
          <Field label="Capacity (slots)" optional><Input type="number" min={0} value={capacity || ""} onChange={numHandler(setCapacity)} placeholder="3" /></Field>
          <Field label="Points" optional><Input type="number" min={0} value={points || ""} onChange={numHandler(setPoints)} placeholder="Points awarded" /></Field>
          <Field label="Eligibility — Canada" optional><Input value={eligibilityCa} onChange={(e) => setEligibilityCa(e.target.value)} placeholder="yes / via_equivalency_or_sponsor / no" /></Field>
          <Field label="Eligibility — international" optional><Input value={eligibilityIntl} onChange={(e) => setEligibilityIntl(e.target.value)} placeholder="yes / no" /></Field>
          <Field label="Allows regranting" optional className="sm:col-span-2"><Input value={allowsRegranting} onChange={(e) => setAllowsRegranting(e.target.value)} placeholder="yes / no / unknown" /></Field>
        </div>
      </Card>

      {/* Detail */}
      <Card className="flex flex-col gap-4 p-5">
        <h3 className="text-[15px] font-bold">Detail</h3>
        <Field label="Summary" optional><Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} placeholder="What this sponsor funds, in plain English" /></Field>
        <Field label="Watch-outs" optional><Textarea value={redFlags} onChange={(e) => setRedFlags(e.target.value)} rows={3} placeholder="Red flags or caveats applicants should know" /></Field>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button tip="Save this sponsor — funder, amount, deadline, eligibility and visibility" onClick={save} disabled={busy}>{busy ? "Saving…" : isNew ? "Create sponsor" : "Save sponsor"}</Button>
        <Button variant="outline" tip={isNew ? "Discard this new sponsor" : "Back to the sponsor list"} onClick={() => onClose(false)}>{isNew ? "Cancel" : "← Back to sponsors"}</Button>
      </div>

      {!isNew && <DeleteGrant grant={grant} onDeleted={() => onClose(true)} />}
    </div>
  );
}

/** Soft-delete a grant (active → 0), with the two-step confirm (the DeleteTopic idiom). */
function DeleteGrant({ grant, onDeleted }: { grant: StudioGrant; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const doDelete = async () => {
    setBusy(true); setErr("");
    try { await StudioGrants.remove(grant.id); onDeleted(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't delete the sponsor."); setBusy(false); setConfirming(false); }
  };
  return (
    <Card className="flex flex-col gap-3 border-rose-400/25 p-5">
      <h3 className="text-[15px] font-bold text-rose-300">Delete this sponsor</h3>
      <p className="text-[13px] leading-relaxed text-ink-3">
        Deleting hides the sponsor from the public Sponsors page. The listing is kept, so it can be restored.
      </p>
      {err && <StatusNote error>{err}</StatusNote>}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[13px] font-semibold text-ink">Delete “{grant.title}”?</span>
          <span className="flex gap-2">
            <Button variant="outline" tip="Permanently delete — only allowed while no other member has enrolled" onClick={doDelete} disabled={busy} className="border-rose-400/40 text-rose-300 hover:border-rose-300 hover:text-rose-200">{busy ? "Deleting…" : "Yes, delete it"}</Button>
            <Button variant="outline" tip="Cancel — keep it" onClick={() => setConfirming(false)} disabled={busy}>Keep it</Button>
          </span>
        </div>
      ) : (
        <div><Button variant="outline" tip="Delete this — refused once another member has enrolled" onClick={() => setConfirming(true)} className="border-rose-400/40 text-rose-300 hover:border-rose-300 hover:text-rose-200">Delete sponsor</Button></div>
      )}
    </Card>
  );
}
