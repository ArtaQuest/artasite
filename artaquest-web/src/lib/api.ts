/**
 * The single typed client for the ArtaQuest backend (plugin: src/Rest.php).
 * One function per endpoint, mirroring `Rest::ROUTES` 1:1 — read this file alongside
 * that route table and you have the entire contract. Pages import only from here.
 *
 * Conventions:
 *   - Lists return { items, next } keyset cursors (pass `next` back as `cursor`).
 *   - GET = public + cacheable; POST = needs the session cookie (+ nonce in prod).
 */

import { aqFetch } from "./offline/fetch";

const BASE = "/wp-json/aq/v1";

/**
 * REST nonce WordPress injects on app routes (prod cookie auth). Empty in dev.
 *
 * MUTABLE, and read at SEND time — never captured into a header once at module load. A nonce lives
 * nonce_life (WP default 86400s) and this one is baked into a shell served from WP.com's edge
 * cache, so it ages with the cache entry rather than with the person: any tab left open past the
 * tick is holding a DEAD value. Core's rest_cookie_check_errors then refuses the request BEFORE
 * dispatch, for ANY route — even a public GET answers 403 {"code":"rest_cookie_invalid_nonce"}
 * (reproduced on prod 2026-07-31) — so the whole app goes read-AND-write dead until a hard reload.
 * send() below repairs that in place, once, and every later call uses the fresh value.
 */
let nonce =
  (typeof window !== "undefined" &&
    (window as unknown as { AQ_WP_NONCE?: string }).AQ_WP_NONCE) ||
  "";

/** The live REST nonce. Shared with lib/auth.ts's signOut() so the app holds exactly one. */
export const restNonce = (): string => nonce;

/** The in-flight refresh, shared so a burst of stale calls mints ONE new nonce, not one each. */
let refreshing: Promise<string> | null = null;

/**
 * Fetch a live REST nonce (core's admin-ajax `rest-nonce` — the same refresh wp-auth-check uses)
 * and adopt it for every later call. Returns '' when the refresh fails or answers something that
 * is not a nonce, so a caller gives up instead of retrying with a value that cannot work.
 * Time-bounded: a hung network must not strand the request waiting on it.
 */
export function refreshNonce(): Promise<string> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const r = await fetch("/wp-admin/admin-ajax.php?action=rest-nonce", {
        credentials: "include",
        signal: AbortSignal.timeout(8000),
      });
      const v = (await r.text()).trim();
      if (!r.ok || !/^[a-f0-9]{10}$/i.test(v)) return "";
      nonce = v;
      return v;
    } catch {
      return "";
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * One API request, carrying the live nonce, with a SINGLE refresh-and-retry.
 *
 * The replay fires only on core's pre-dispatch nonce refusal — 403 whose body carries core's own
 * `code` (not our `error`) as rest_cookie_invalid_nonce. That is the one failure a replay can fix
 * and the one where replaying is provably harmless: the route handler never ran, so even a
 * non-idempotent POST has done nothing yet. Every other 403 (a real permission refusal, ours or
 * core's) is handed back untouched. Once only — never a loop.
 */
async function send(url: string, init: RequestInit = {}, headers: Record<string, string> = {}): Promise<Response> {
  const attempt = (n: string) =>
    aqFetch(url, { ...init, credentials: "include", headers: n ? { ...headers, "X-WP-Nonce": n } : headers });
  const r = await attempt(nonce);
  if (r.status !== 403 || !nonce) return r;
  // clone() — the caller still has to read this body when the refusal turns out not to be the nonce.
  const j = (await r.clone().json().catch(() => null)) as { code?: string } | null;
  if (j?.code !== "rest_cookie_invalid_nonce") return r;
  const fresh = await refreshNonce();
  return fresh ? attempt(fresh) : r;
}

type Json = Record<string, unknown>;

async function get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const qs = params
    ? "?" + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
    : "";
  const r = await send(`${BASE}${path}${qs}`);
  if (!r.ok) throw new ApiError(path, r.status);
  return r.json();
}

async function post<T>(path: string, body: Json): Promise<T> {
  const r = await send(`${BASE}${path}`, { method: "POST", body: JSON.stringify(body) }, { "Content-Type": "application/json" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw apiError(path, r.status, j);
  return j as T;
}

/** DELETE — same auth + error handling as post(). */
async function del<T>(path: string): Promise<T> {
  const r = await send(`${BASE}${path}`, { method: "DELETE" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw apiError(path, r.status, j);
  return j as T;
}

/** POST multipart form-data (file uploads). No Content-Type header — the browser sets the
 *  multipart boundary itself. Mirrors `post()` for error handling. */
async function postForm<T>(path: string, fd: FormData): Promise<T> {
  const r = await send(`${BASE}${path}`, { method: "POST", body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw apiError(path, r.status, j);
  return j as T;
}

/** Store an image supplied as a base64 data URL → its public URL. Reuses the vetted /tickets/upload
 *  store (PNG/JPEG/WebP/GIF ≤6 MB, saved to the uploads dir) — the "upload from device" option behind
 *  every image field in the Studio editors (ticket #140), alongside the ticket-screenshot path that
 *  endpoint already serves. */
export const uploadImage = (image: string) => post<{ ok: boolean; url: string }>("/tickets/upload", { image });

export class ApiError extends Error {
  path: string;
  status: number;
  /** The backend's machine-readable `error` code (Rest::err), when it sent one — callers should
   *  branch on this, never on the human message (which is translated and may change). */
  code: string;
  /** The rest of the error body. Most refusals carry nothing here, but some are a refusal the caller
   *  must ACT on rather than merely display — `credit_offered` carries the donor and the slice the
   *  member is being asked to accept, and there is nowhere else for that to arrive. */
  data: Record<string, unknown>;
  constructor(path: string, status: number, message?: string, code = "", data: Record<string, unknown> = {}) {
    super(message || `${path} → ${status}`);
    this.path = path;
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/** Name of the window event fired the moment the backend refuses a call for a missing date of
 *  birth. Every ArtaQuest account states an exact one (Rest::birthday_gate); the SPA normally asks
 *  during sign-up, but a stale shell can still hold a session that never did — this is how the
 *  onboarding step learns to open anyway, from the only authority that actually knows. */
export const BIRTHDAY_REQUIRED_EVENT = "aq:birthday-required";

/** Build the error for a failed call and, when the reason is the missing birthday, announce it. */
function apiError(path: string, status: number, j: unknown): ApiError {
  const body = (j ?? {}) as { message?: string; error?: string; code?: string };
  // `error` is OUR code (Rest::err); `code` is WP core's, on anything refused before dispatch
  // (rest_cookie_invalid_nonce, rest_no_route…). Reading only the first left those with an EMPTY
  // code, so a caller could branch on nothing and the member got the bare "Cookie check failed".
  const code = body.error || body.code || "";
  if (code === "birthday_required" && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(BIRTHDAY_REQUIRED_EVENT));
  }
  return new ApiError(path, status, body.message, code, (j ?? {}) as Record<string, unknown>);
}

// ── Types (mirror the PHP response shapes) ──────────────────────────────────
export type Page<T> = { items: T[]; next: number | null };

export type CourseCard = {
  id: number; slug: string; title: string; image: string; channel: string;
  lessons: number; enrolled: number; duration: number; rating: number;
  price: number; // entry fee in coins = 1 coin per video, min ₳1 (Courses::card → Funds::cost_for_videos)
  comments_per_day: number; // rolling-24h comment rate — the comment-based ranking metric + card headline ("X/day")
  comments_total: number; // total YouTube comments across the course's videos (fallback card metric until a rate accrues)
};
export type CourseDetail = CourseCard & {
  summary: string;
  lessons: { id: number; idx: number; title: string; duration: number }[];
  enrolled: boolean;
};
export type Lesson = {
  id: number; course_id: number; idx: number; title: string;
  video_type: string; video: string; duration: number;
  seg_start: number; seg_end: number;
  locked: boolean; watched: boolean; commented: boolean; upvoted: boolean; engaged: boolean;
};
export type Wallet = {
  coins: number; points: number; tier: string;
  ledger: { delta: number; reason: string; ref: string; at: number }[];
};
export type LeaderRow = {
  rank: number;
  id: number; // target for POST /follow (public by design — same rows as /data/)
  name: string; slug: string; points: number; tier: string;
  avatar?: string; country?: string; // identity fields the endpoint exposes (see Economy::leaderboard)
};
export type ThreadCard = {
  id: number; title: string; topic: string; lang: string; author: string;
  comments: number; score: number; at: number;
};
export type Me = {
  id: number; name: string; slug: string; avatar: string;
  country?: string; // verified nationality (ISO alpha-2) → avatar flag; '' until verified
  points: number; coins: number; tier: string;
} | null;

// ── Courses / LMS ───────────────────────────────────────────────────────────
export const Courses = {
  list: (p?: { cursor?: number; q?: string; limit?: number; sort?: "trending" }) =>
    get<Page<CourseCard>>("/courses", p as Record<string, string | number>),
  get: (id: number) => get<CourseDetail>(`/courses/${id}`),
  bySlug: (slug: string) => get<CourseDetail>(`/courses/slug/${slug}`),
  lesson: (id: number) => get<Lesson>(`/lessons/${id}`),
  create: (b: { title: string; summary?: string; image?: string }) => post<{ id: number }>("/courses", b),
};

// ── Creator Studio (create + edit your own courses; owner or operator only) ──
export type StudioCourse = { id: number; slug: string; title: string; image: string; lessons: number; price: number; comments_per_day: number };
export type StudioLesson = { id?: number; title: string; video: string; duration: number; seg_start?: number; seg_end?: number; rate?: number };
export type StudioCandidate = { video: string; rate: number; baseline: number; ripe_in: number };
export type StudioCourseDetail = { id: number; slug: string; title: string; summary: string; image: string; topic: string; subtopic: string; search_terms: string; channel: string; lang: string; status: string; lessons: StudioLesson[]; candidates?: StudioCandidate[] };
export type CourseInsights = {
  enrollments: number; certificates: number; comments: number; votes: number;
  revenue: number; prize_pool: number; rating: number; rating_n: number;
  leaders: { name: string; slug: string; votes: number; prize: number }[];
};
export const Studio = {
  list: () => get<{ items: StudioCourse[]; total: number; scope?: "own" | "all" }>("/studio/courses"),
  get: (id: number) => get<StudioCourseDetail>(`/studio/courses/${id}`),
  insights: (id: number) => get<CourseInsights>(`/courses/${id}/insights`),
  importPlaylist: (id: number, url: string) =>
    post<{ ok: boolean; added: number; removed: number; skipped_unplayable: number; skipped_other_course: number; lesson_count: number }>(`/courses/${id}/import-playlist`, { url }),
  update: (id: number, b: { title?: string; summary?: string; image?: string; topic?: string; subtopic?: string; search_terms?: string; channel?: string; lang?: string; status?: string }) =>
    post<{ ok: boolean; updated: string[] }>(`/courses/${id}/update`, b),
  // Full content edit via the ID-preserving sync — existing lessons keep their ids; any video
  // change (add / remove / swap / retrim) resets the course's rank (it re-earns its place, same as
  // the pipeline). `reset` reports whether that reset fired for this save.
  saveLessons: (id: number, lessons: StudioLesson[]) =>
    post<{ ok: boolean; kept: number; added: number; removed: number; reset: boolean; lesson_count: number }>(`/courses/${id}/lessons`, { lessons }),
  // Permanent delete — the backend refuses (409) once any other member has enrolled.
  remove: (id: number) => post<{ ok: boolean; id: number }>(`/courses/${id}/delete`, {}),
  // Per-course control (owner/operator): find+track a candidate video now, recompute the rank, refresh rates.
  discover: (id: number) => post<{ ok: boolean; tracked: number; video?: string; reason: string }>(`/courses/${id}/discover`, {}),
  recompute: (id: number) => post<{ ok: boolean }>(`/courses/${id}/recompute`, {}),
  refresh: (id: number) => post<{ ok: boolean; refreshed: number }>(`/courses/${id}/refresh`, {}),
};

// ── Operator CONSOLE (manage_options only) — control + monitor of the discovery pipeline ──
export type ConsoleLastRun = { ts: number; [k: string]: number } | null;
export type ConsoleCandidate = { video: string; course_id: number; course: string; baseline: number; rate: number; ripe_in: number };
export type ConsoleCron = { hook: string; next_in: number | null; schedule: string; last: number | null; ms: number | null; err: string; skips: number };
export type HouseStat = { key: string; label: string; courses: number; videos: number; topics: number; disciplines: number; pct?: number };
export type ConsoleSnapshot = {
  catalogue: { published_courses: number; videos: number; total_rate: number; avg_rate: number; prune_eligible_courses: number };
  discovery: {
    enabled: boolean; searches_today: number; cap: number; per_run: number; cursor: number; next_course: string;
    candidate_count: number; candidates: ConsoleCandidate[]; last_discover: ConsoleLastRun; last_settle: ConsoleLastRun; last_prune: ConsoleLastRun;
  };
  crons: ConsoleCron[];
  research: {
    online: boolean; queued: number;
    counts: { submitted: number; reviewing: number; revisions: number; accepted: number; rejected: number; withdrawn: number };
    recent: { id: number; title: string; status: string; round: number; score: number; reproduced: boolean; updated: number }[];
  } | null;
  economy: { coins_issued: number; backing_mg: number; reserve_ok: boolean };
  system: { schema: string; aq_version: string };
  jobs: string[];
  now: number;
};
export const ConsoleApi = {
  get: () => get<ConsoleSnapshot>("/studio/console"),
  run: (job: string) => post<{ ok: boolean; job: string; result: Record<string, unknown> }>("/studio/console/run", { job }),
  config: (b: { cap?: number; per_run?: number; cursor?: number }) => post<{ ok: boolean; set: Record<string, number> }>("/studio/console/config", b),
  candidate: (video: string, action: "discard" | "settle") => post<{ ok: boolean; action: string; result?: Record<string, unknown> }>("/studio/console/candidate", { video, action }),
};

// ── Operator HEALTH check (manage_options only) — mirrors AQ\Health in the plugin ──
// Is the app the browser gets the app we built? Build integrity, route resolution, schema, brand
// arithmetic, jobs and credentials. Values are never returned for a credential — only whether one
// is configured, because the whole database is public.
export type HealthCheck = {
  id: string;
  group: "build" | "api" | "data" | "brand" | "ops";
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  evidence: string;
};
export type HealthReport = {
  ts: number;
  groups: Record<string, string>;
  summary: { total: number; ok: number; warn: number; fail: number; status: "ok" | "warn" | "fail" };
  checks: HealthCheck[];
};
export const HealthApi = {
  get: () => get<HealthReport>("/health"),
};

// ── Operator ARTAAI monitor (manage_options only) — every AI system on the platform, in one place ──
export type ArtaaiHead = { id: number; title: string; state: "queued" | "processing"; age: number | null };
export type ArtaaiSurface = {
  key: string; label: string; group: "chat" | "studio"; blurb: string;
  model: string; effort: string; engine: string; launch: string;
  pausable: boolean; paused: boolean;
  online: boolean | null; beat_age: number | null; has_beat: boolean;
  pending: number; busy: number; done: number; failed: number;
  done_24h: number | null; done_label: string;
  oldest_s: number | null; rounds_24h: number | null;
  can_requeue: boolean; head: ArtaaiHead[];
};
export type ArtaaiHfAccount = { name: string; use: number; ok: number; quota: number; last: number; valid?: boolean; parked?: number; pro?: boolean; weight?: number };
export type ArtaaiSnapshot = {
  now: number; laptop_online: boolean; global_pause: boolean;
  relays_alive: number; relays_total: number;
  total_pending: number; total_busy: number; total_failed: number; rounds_24h: number;
  park: { active: boolean; reset_in?: number; reset_at?: number };
  usage: { tokens_24h: number; tokens_7d: number; turns_24h: number };
  moderation: { threshold: number; default: number; queue: number; flagged: number; flagged_24h: number; processed: number };
  surfaces: ArtaaiSurface[];
  hf: { at: number; accounts: number; pool: ArtaaiHfAccount[] } | null;
  system: { schema: string; aq_version: string };
};
export type ArtaaiConfig =
  | { action: "pause"; surface: string; on: boolean }
  | { action: "pause_all"; on: boolean }
  | { action: "threshold"; value: number }
  | { action: "park"; minutes: number }
  | { action: "unpark" }
  | { action: "requeue"; surface: string }
  | { action: "moderate" };
export const ArtaaiApi = {
  get: () => get<ArtaaiSnapshot>("/studio/artaai"),
  config: (b: ArtaaiConfig) => post<{ ok: boolean; [k: string]: unknown }>("/studio/artaai/config", b),
};

// ── Operator MEMBERS directory (manage_options only) ──
export type StudioMember = {
  id: number; name: string; slug: string; email: string; points: number; tier: string;
  courses: number; joined: number; can_create: boolean; granted: boolean; operator: boolean;
};
export const Members = {
  list: (q: string) => get<{ items: StudioMember[]; total: number }>(`/studio/members${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  grant: (user: number, grant: boolean) => post<{ ok: boolean; user: number; granted: boolean }>("/studio/members/grant", { user, grant }),
};

// ── Operator DISCIPLINES registry (the 12 houses are fixed; the disciplines under them are CRUD-editable) ──
// Every discipline also carries a zodiac SIGN and a ruling PLANET — independent astrological dimensions
// (alongside its house) that content inherits, drive the Almanac, and ArtaCreate balances.
export type Discipline = { key: string; house: string; label: string; blurb?: string; sign?: string; planet?: string; score?: number; sig?: number; pos?: "noun" | "adj"; central?: number; ratio?: number };
export type AstroDim = "house" | "sign" | "planet";
export type DisciplineRegistry = {
  houses: HouseStat[]; // back-compat alias of dist.house
  dist: Record<AstroDim, HouseStat[]>; // the three distributions (axis keys house|sign|planet = what|why|how)
  disciplines: Discipline[];
  house_reps?: Record<string, HouseRep>; // each house's WHAT (noun) + HOW (adjective) camp reps (auto-updates)
  motivations: Record<string, string>; // WHY key → label
  pedagogies: Record<string, string>;  // HOW key → label (video formats; field name kept for back-compat)
};
export const Disciplines = {
  list: () => get<DisciplineRegistry>("/disciplines"),
  // `oldKey` (when it differs from `key`) renames the discipline, cascading to every topic/course link.
  save: (b: Discipline & { oldKey?: string }) => post<{ ok: boolean; key: string }>("/studio/disciplines", b),
  remove: (key: string) => post<{ ok: boolean }>(`/studio/disciplines/${encodeURIComponent(key)}/delete`, {}),
};

// ── The Twelve Seasons — the platform calendar (mirror of lib/seasons.ts; Seasons.php serves it).
//    A member follows exactly ONE season (their topic family); default = their birth season. ──
export type SeasonShape = { n: number; key: string; keeper: string; epithet: string; digit: string; from: string; craft: string; craft_label: string; traits: string; legend: string; avatar: string };
export const SeasonsApi = {
  wheel: () => get<{ seasons: SeasonShape[]; current: number; mine?: number }>("/seasons"),
  subscribe: (n: number) => post<{ ok: boolean; season: number }>("/me/season", { n }),
};

// ── Houses (operator): control the per-house sidereal-analysis fields. add/remove are QUEUED (the offline
//    pipeline does the analysis + redeploy), so a change shows up in `queue` until the collector applies it. ──
export type HouseField = { key: string; label: string; pos: "noun" | "adj"; score: number; ratio: number; rep: number };
export type StudioHouse = { key: string; label: string; fields: HouseField[] };
export type HousesQueue = { add: string[]; remove: string[] };
export const HousesApi = {
  list: () => get<{ houses: StudioHouse[]; queue: HousesQueue }>("/studio/houses"),
  field: (action: "add" | "remove", value: string) => post<{ ok: boolean; queue: HousesQueue }>("/studio/houses/field", { action, value }),
  unqueue: (action: "add" | "remove", value: string) => post<{ ok: boolean; queue: HousesQueue }>("/studio/houses/unqueue", { action, value }),
};

// The celestial-cycle explanatory ranking (GET /cycles) — each cycle's mean share of the disciplines'
// fitted search-trend signal + the fields it most explains. Powers the /cycles page.
export type CycleRef = { id: number; text: string; url: string };
export type CycleRank = {
  body: string; label: string; period: number; motivation: string; share: number; dominant: number;
  top: { key: string; label: string }[];
  // The academic dossier (the documented natural/social cycle behind the celestial period), verified citations.
  natural_cycle?: string; abstract?: string; the_cycle_in_nature?: string; discussion?: string;
  references?: CycleRef[]; match_strength?: string;
};
export const Cycles = {
  list: () => get<{ cycles: CycleRank[]; fit_n?: number }>("/cycles"),
};

// ── Competitions (Kaggle-style hosted datasets + a hidden-holdout leaderboard) ──
// A host publishes a dataset with a hidden test holdout; anyone submits predictions and is
// scored (R² on the held-out last 2 years). Mirrors src/Competition.php.
export type CompetitionCard = {
  slug: string; title: string; owner: string; owner_slug: string; metric: string;
  deadline: string; status: string; prize: number; n_teams: number; best_score: number | null;
  n_targets: number; created: number;  // unix seconds
  entry_fee?: number;          // ₳ per submission (C-to-C: the fee joins the pool as revenue; 0/absent = free)
};
export type CompetitionDetail = {
  id?: number;                 // numeric id — the dataset's key in the challenge frame (hearts)
  slug: string; title: string; owner: string; owner_slug: string; blurb: string; metric: string;
  holdout: string; deadline: string; status: string; created: string;
  prize: number;               // the LIVE coin pool (fixed prize + the full entry-fee revenue), paid 50/30/20 at the deadline (0 = none)
  entry_fee?: number;          // ₳ per submission, burned into the pool's revenue (0/absent = free)
  thread_id: number;           // the official discussion thread (aq_threads.id; 0 = none)
  key_col: string;             // the submission row key — "trend|sky" (topic-500), "id" (shuffled-row sets) or "trend|date"
  evaluation: string;          // the server's scoring explainer (echoed on the overview)
  n_train: number; n_test: number; n_features: number; n_targets: number;
  data: {
    train: string | null; test: string | null; sample_submission: string | null;
    notebook: string | null;   // starter.ipynb — the submission-template notebook, when bundled
  };
  sizes?: { train: number; test: number; sample_submission: number; notebook: number }; // bytes per file (0 = absent)
  columns?: { name: string; type: string; desc: string }[]; // documented schema of every data column
  my_review: MyReview;         // the signed-in caller's own solution-review state (null if none)
};
// The caller's own solution-review state, driving the "request verification" panel.
export type MyReview = {
  submission_id: number; score: number;
  review: "none" | "submitted" | "reviewing" | "verified" | "flagged" | "revisions-requested";
  round: number; max_rounds: number; verified: boolean; last_report: string; last_verdict: string;
} | null;
export type CompetitionLeaderRow = {
  rank: number; uid: number; name: string; slug: string; score: number; n_subs: number;
  bot: boolean;      // on the board but walled off from the coin prize (a bot's medal slot passes down)
  verified: boolean; // a solution of theirs passed the adversarial review → prize-eligible
  last: number;      // unix seconds
  code_url?: string; // public reproducible-code link on their best submission (Colab/gist/repo)
};
export type CompetitionSubmitResult = { score: number; rank: number; best: number };
// The leader's fit-vs-raw series for one topic of a sky dataset (GET competition/results). While the
// competition is live, test-month `actual`s are the PUBLIC topic-half only (nulls = the still-hidden
// private topics); `fit` is the sinc-GD baseline's fit over the clean months, `pred` the leader's holdout
// predictions for the 12 future months. `phase` is THIS topic's fitted read-out: the global phase `peak`
// (→ its zodiac `sign`), the per-body `freqs` (frequencies f_i, body order sun..node), and the baseline's
// holdout `r2`. `sign_dist` is the atlas — how the 500 topics' fitted signs spread the zodiac.
export type CompetitionResults = {
  slug: string; trend: string; topics: string[]; months: string[]; test_from: number;
  actual: (number | null)[]; fit: (number | null)[]; pred: (number | null)[]; closed: boolean;
  winner: { uid: number; name: string; slug: string; score: number } | null;
  phase: { sign: string; peak: number; freqs: number[]; r2: number } | null;
  sign_dist: Record<string, number>;
};
// A chant-competition entry receipt. No judge: the automated pipeline (ArtaTranslate → ArtaVoice)
// measures the total spoken time of the 12 laws × 20 languages and posts it as the board score.
export type CompetitionChantResult = { ok: boolean; submission_id: number; review: string; laws: string[]; message: string };
// One of the signed-in caller's own scored submissions (the Submit tab's "Your submissions" table).
export type MySubmission = {
  id: number; score: number;
  best: boolean;               // this row is the member's best — the one the leaderboard counts
  note: string;
  review: "none" | "submitted" | "reviewing" | "verified" | "flagged" | "revisions-requested";
  verified: boolean; created: number; // unix seconds
  code_url?: string;           // the public reproducible-code link submitted with this entry
};
// One round of the adversarial solution review — public, shown under Leaderboard → Solutions.
export type SolutionRound = {
  round: number; verdict: string; verified: boolean; score: number; report: string;
  model: string; effort: string; runtime_s: number; created: number; // unix seconds
};
// A publicly reviewable solution (open code + method write-up + every review round).
// Chant entries also carry `audio`: the published per-language recordings ({ lang → mp3 URL },
// present once the automated measurement has run — playable in all 20 languages).
export type CompetitionSolution = {
  submission_id: number; uid: number; name: string; slug: string; score: number;
  code_url: string; method: string; review: string; verified: boolean;
  audio?: Record<string, string>; rounds: SolutionRound[];
};
export const Competitions = {
  list: () => get<{ items: CompetitionCard[] }>("/competitions"),
  get: (slug: string) => get<CompetitionDetail>("/competition", { slug }),
  leaderboard: (slug: string) => get<{ slug: string; items: CompetitionLeaderRow[] }>("/competition/leaderboard", { slug }),
  // The leader's predicted-vs-raw train/test series for one topic (phase datasets — the Results tab).
  results: (slug: string, trend?: string) => get<CompetitionResults>("/competition/results", trend ? { slug, trend } : { slug }),
  // The signed-in caller's own scored submissions (cookie auth rides on `get`'s credentials).
  mySubmissions: (slug: string) => get<{ items: MySubmission[] }>("/competition/my-submissions", { slug }),
  // Public solution reviews — open code, method write-up, and each adversarial review round.
  solutions: (slug: string) => get<{ items: CompetitionSolution[] }>("/competition/solutions", { slug }),
  // Predictions keyed by the competition's key_col ("id" / "trend|id" / "trend|date") → value, or a raw
  // CSV string the backend parses (same shape as sample_submission.csv). `code_url` is a public,
  // reproducible-code link (Colab/gist/repo) required on every submission — surfaced on the board.
  submit: (slug: string, predictions: Record<string, number> | string, code_url: string) =>
    post<CompetitionSubmitResult>(`/competition/submit?slug=${encodeURIComponent(slug)}`, { predictions, code_url }),
  // CHANT competitions (metric 'chant'): the entry is just the twelve law sentences. The automated
  // pipeline measures them afterwards, so no instant score comes back — the receipt echoes the laws.
  submitChant: (slug: string, laws: string[]) =>
    post<CompetitionChantResult>(`/competition/submit?slug=${encodeURIComponent(slug)}`, { laws }),
  // Submit a SOLUTION (open code URL + method write-up) for adversarial review — required for the prize.
  verify: (slug: string, b: { code_url: string; method: string; submission_id?: number }) =>
    post<{ ok: boolean; submission_id: number; review: string; round: number }>(`/competition/verify?slug=${encodeURIComponent(slug)}`, b),
  create: (b: { title: string; blurb: string; slug?: string }) => post<{ slug: string }>("/competition/create", b),
};

// Each house's representatives, split into two camps — `what` (its top-score NOUN field) and `how` (its
// top-score ADJECTIVE field). The home recommender uses the field-house's `what` as the noun and the
// sign-house's `how` as the adjective, so both follow the data with no hard-coded labels. `key`/`label`
// mirror `what` for back-compat.
export type RepField = { key: string; label: string };
export type HouseRep = { key: string; label: string; what?: RepField | null; how?: RepField | null };
export const Houses = {
  reps: () => get<{ reps: Record<string, HouseRep> }>("/house-reps"),
};

// (The old zodiac-name house fallbacks — ZODIAC/HOUSE_SIGN/signAdj/houseTitleParts — were purged with
// the astrology framing, 2026-07-10. Houses group as the twelve SEASONS now; see lib/seasons.ts.)
export type LabelItem = { key: string; label: string };
export type LabelsRegistry = { houses: LabelItem[]; signs: LabelItem[] };
// Operator-editable display labels for the 12 fields (What) + 12 styles (How); `save` takes {key:label} maps.
export const Labels = {
  list: () => get<LabelsRegistry>("/labels"),
  save: (houses: Record<string, string>, signs: Record<string, string>) => post<{ ok: boolean }>("/studio/labels", { houses, signs }),
};

// ── Operator VIDEOS surface (all tracked videos + state/metadata; candidates live here too) ──
export type VideoRow = {
  video: string; thumb: string; state: "in-course" | "candidate" | "standalone" | "missing"; missing: boolean;
  rate: number; comments: number; views: number; likes: number;
  course: { title: string; slug: string } | null;
  candidate: { course: string; course_id: number; baseline: number; ripe_in: number } | null;
  last_refresh: number; created: number;
};
export const Videos = {
  list: (q: string) => get<{ items: VideoRow[]; counts: { total: number; candidates: number; missing: number }; now: number }>(`/studio/videos${q ? `?q=${encodeURIComponent(q)}` : ""}`),
};

// ── Creator Studio — TOPICS (DB-backed typology systems; author or operator can change anything) ──
export type TrendSeries = { ref: string; kind?: string; query?: string; found: boolean; series: number[]; score?: number; recent?: number; peak?: number; trough?: number; band?: number; momentum?: number; updated?: number };
// Google-Trends demand: one ref's cached 2004→now worldwide web-search series + score components.
// ref = "topic:<key>" | "cycle:<slug>". Read powers the Studio editor sparkline + the /why cycle chart.
export const Trends = {
  get: (ref: string) => get<TrendSeries>(`/trends?ref=${encodeURIComponent(ref)}`),
  importScores: (items: unknown[]) => post<{ ok: boolean; imported: number }>("/studio/trends/import", { items }),
};

export type StudioTopicCard = { key: string; name: string; category: string; status: string; sponsor: string; trend?: number };
export type TopicOption = { key: string; label: string; short?: string; desc?: string; image?: string };
export type TopicDimension = { key: string; name: string; low: string; high: string; desc?: string; image?: string };
export type TopicCitation = { title: string; authors?: string; year?: number; venue?: string; doi?: string };
export type StudioTopic = {
  key: string; name: string; category: string; status: string; statusNote: string; blurb: string;
  format: string; selfDescribe: boolean; source: string; video: string; instructor: string; course: string; image: string;
  sign: string; planet?: string; // sign = HOW (style). planet vestigial — WHY retired as a content tag (2026-06-24)
  trend?: number; // Google-Trends demand score 0-100 (-1 = unscored)
  options: TopicOption[]; dimensions: TopicDimension[]; citations: TopicCitation[];
  sponsor_name: string; sponsor_url: string; sponsor_logo: string;
  author?: { id: number; name: string; slug: string };
};
// `newKey` (when different from the current key) renames the topic's key/slug after creation (#141):
// the backend cascades the rename across selections/tags/endorsements + the fund ledger and 301-redirects
// the old URL. `update` returns the canonical `key` (the new one after a rename) and whether it renamed.
export type StudioTopicSave = Partial<Omit<StudioTopic, "author">> & { key?: string; newKey?: string };
export const StudioTopics = {
  list: () => get<{ items: StudioTopicCard[]; total: number; can_create: boolean }>("/studio/topics"),
  get: (key: string) => get<StudioTopic>(`/studio/topics/${encodeURIComponent(key)}`),
  create: (b: StudioTopicSave) => post<{ ok: boolean; key: string }>("/topics", b),
  update: (key: string, b: StudioTopicSave) => post<{ ok: boolean; updated: string[]; key: string; renamed: boolean }>(`/topics/${encodeURIComponent(key)}/update`, b),
  remove: (key: string) => post<{ ok: boolean }>(`/topics/${encodeURIComponent(key)}/delete`, {}),
};

// ── Creator Studio — GRANTS & SPONSORS (DB-backed aq_grants; author or operator can change anything) ──
export type StudioGrantCard = { id: number; title: string; funder: string; category: string; deadline: string; fit: number; active: number };
export type StudioGrant = {
  id: number; slug: string; title: string; funder: string; url: string; country: string; category: string;
  currency: string; amount_cad: number; amount_display: string; deadline: string; deadline_type: string;
  estimated: boolean; eligibility_ca: string; eligibility_intl: string; allows_regranting: string;
  fit: number; confidence: string; capacity: number; points: number; summary: string; red_flags: string;
  active: number; author?: { id: number; name: string; slug: string };
};
export type StudioGrantSave = Partial<Omit<StudioGrant, "author" | "id" | "slug">> & { title?: string };
export const StudioGrants = {
  list: () => get<{ items: StudioGrantCard[]; total: number; can_create: boolean }>("/studio/grants"),
  get: (id: number) => get<StudioGrant>(`/studio/grants/${id}`),
  create: (b: StudioGrantSave) => post<{ ok: boolean; id: number; slug: string }>("/grants", b),
  update: (id: number, b: StudioGrantSave) => post<{ ok: boolean; updated: string[] }>(`/grants/${id}/update`, b),
  remove: (id: number) => post<{ ok: boolean }>(`/grants/${id}/delete`, {}),
};

// ── Learning (discussion-first: watch → comment → upvote) ─────────────────────
export const Learn = {
  enroll: (course_id: number) => post<{ ok: true; enrolled: boolean }>("/enroll", { course_id }),
  // Heartbeat real playback position (`at` = seconds into the section); the server gates `done`.
  progress: (lesson_id: number, at: number) => post<{ ok: true; done: boolean; pct: number; watched: number; need: number }>("/progress", { lesson_id, at: Math.max(0, Math.floor(at)) }),
  // Post a comment (or threaded reply) to a section's discussion board.
  comment: (lesson_id: number, body: string, parent_id = 0) => post<{ ok: true; id: number; pct: number; first: boolean }>("/section/comment", { lesson_id, body, parent_id }),
  // The section's discussion board + the viewer's engagement state.
  sectionThread: (lesson_id: number, sort: "top" | "new" = "top", cursor = 0) => get<{ items: unknown[]; next: number | null; total: number; engaged: boolean }>(`/sections/${lesson_id}/thread?sort=${sort}${cursor ? `&cursor=${cursor}` : ""}`),
  // Toggle an upvote on a peer's comment.
  voteComment: (comment_id: number, dir: 1 | 0 | -1) => post<{ ok: true; my_vote: 1 | 0 | -1; votes: number; pct: number }>("/comment/vote", { comment_id, dir }),
  // A course's Kaggle-style board: ranked by comment upvotes, with medals + the reward pool.
  courseRankings: (course_id: number, season?: number) => get<{ course: string; enrolled: number; eligible: boolean; pool: number; items: unknown[] }>(`/courses/${course_id}/rankings${season ? `?season=${season}` : ""}`),
  dashboard: () => get<{ courses: unknown[]; points: number; coins: number }>("/dashboard"),
};

// ── Economy ─────────────────────────────────────────────────────────────────
export const Economy = {
  wallet: () => get<Wallet>("/wallet"),
  leaderboard: (track = "all") => get<Page<LeaderRow>>("/leaderboard", { track }),
  reserve: () => get<{ issued_coins: number; backing_mg: number; ratio: number; unit: string }>("/reserve"),
};

// ── Notifications (the account-drawer bell) ───────────────────────────────────
export type Notification = {
  id: number; type: string; title: string; body: string; url: string; read: boolean; at: number;
};
export const Notifications = {
  list: () => get<{ items: Notification[]; unread: number }>("/notifications"),
  markRead: (id?: number) => post<{ ok: true; unread: number }>("/notifications/read", id ? { id } : {}),
};

// ── Social ──────────────────────────────────────────────────────────────────
/** The votable thing a feed event points at (the discussion post, or the reply itself), so the
 *  feed renders live thumbs with no extra round-trip. `board` picks the vote route — 'thread'
 *  → the public POST /vote, 'section' → the competition's POST /comment/vote (enrolment-gated,
 *  no self-votes; the server enforces both). `my_vote` pre-lights the viewer's cast; `mine`
 *  marks the viewer's own post (rendered static, same as both boards). */
export type FeedTarget = {
  kind: "thread" | "comment";
  id: number;
  board: "thread" | "section";
  score: number;
  my_vote: -1 | 0 | 1;
  mine: boolean;
};
/** One event on the home-page activity feed (GET /feed) — something a person the viewer
 *  follows did. `type` picks the verb line; `title` is the target's headline (thread /
 *  video / course); `context` is its secondary label (topic, or the course of a video);
 *  `target` is the votable post/reply behind the event (null for enrolments). */
export type FeedItem = {
  type: "thread" | "reply" | "upvote" | "upvote_thread" | "enroll";
  actor: { name: string; slug: string; avatar: string; country?: string };
  title: string;
  context: string;
  excerpt: string;
  url: string;
  at: number;
  target: FeedTarget | null;
};
export const Social = {
  // Activity of the people the viewer follows, newest first (auth'd; keyset on `created`).
  // `following` distinguishes "follow someone first" from "quiet week" for the empty states;
  // `followed` (user ids) lets the suggestions rail skip people already followed.
  feed: (cursor = 0, limit = 20) =>
    get<{ items: FeedItem[]; next: number | null; following: number; followed?: number[] }>(
      "/feed",
      cursor ? { cursor, limit } : { limit },
    ),
  threads: (p?: { cursor?: number; topic?: string }) =>
    get<Page<ThreadCard>>("/threads", p as Record<string, string | number>),
  thread: (id: number) => get<ThreadCard & { body: string; comments: unknown[]; next: number | null }>(`/threads/${id}`),
  postThread: (b: { title: string; body?: string; topic?: string; lang?: string }) => post<{ id: number }>("/threads", b),
  comment: (id: number, body: string, lang = "en") => post<{ id: number }>(`/threads/${id}/comments`, { body, lang }),
  vote: (target_type: "thread" | "comment", target_id: number, val: -1 | 0 | 1) =>
    post<{ ok: true; score_delta: number }>("/vote", { target_type, target_id, val }),
  follow: (target_id: number, on = 1) => post<{ ok: true; following: boolean }>("/follow", { target_id, on }),
};

// ── Creative Challenges (the unified frame, 2026-07-11) — LEGACY, pre-feed. DO NOT BUILD ON IT ──
// Re-checked against Rest::ROUTES 2026-08-04. `detail`, `create` and `enterWork` were DELETED that
// day: they called GET /challenges/<key>, POST /challenges/create and POST /challenges/enter, none
// of which exist (the live ones are GET /challenges?id=, POST /challenges, POST
// /challenges/<id>/enter), and their only caller was the unrouted pages/Challenges.tsx — deleted
// with them. What is left below is live: heart / workHearts / certs / shelf all map to real routes.
// `list` still declares the retired {items, season, …} body where Notebook::challenges now answers
// {current, past, rule} — which is why ChallengeStrip's `r.items.find` throws into its own catch and
// that chrome silently never renders; components/studio.tsx is its last caller.
// The frame the app actually uses is listChallenges()/getChallenge()/chCreate()/chEnter() below.
export type ChallengeKind = "book" | "music" | "audiobook" | "animation" | "film" | "illustration" | "paper" | "dataset" | "model";
export type ChallengeSeason = { key: number; label: string; ends: number; closes_in: number; ends_label: string };
/** One row on the board index: a seasonal (system) challenge or a member-started one. */
export type ChallengeCard = {
  id: number; kind: ChallengeKind; title: string; system: boolean;
  owner: { id: number; name: string; slug: string } | null;
  pool: number; entries: number; thread_id: number;
};
export type ChallengeCert = { kind: string; season: number; label: string; status: "in_progress" | "certified"; place: number; medal: "" | "gold" | "silver" | "bronze" };
export const Challenges = {
  // The board index: every open challenge this season (the seasonal six pinned, then member pots).
  list: () => get<{ items: ChallengeCard[]; season: ChallengeSeason; payouts_live: boolean; create_fee: number; enter_fee: number; pool_share: number; podium: number[]; min_authors: number; min_hearters: number }>("/challenges"),
  // Heart (or un-heart) a published Library work — one heart per member per work, never your own.
  heart: (kind: ChallengeKind, id: number, val: 1 | 0) => post<{ ok: true; my_vote: 1 | 0; hearts: number }>("/work/heart", { kind, id, val }),
  workHearts: (kind: ChallengeKind, id: number) => get<{ hearts: number; my_vote: number }>("/work/hearts", { kind, id }),
  // Derived participation certificates: one per (kind, season) entered; podium medals attached.
  certs: (user?: number) => get<{ items: ChallengeCert[] }>("/challenge-certs", user ? { user } : undefined),
  // The caller's shelf meter (published works vs tier quota; quota 0 = unlimited).
  shelf: () => get<{ used: number; quota: number; tier: string; quotas: Record<string, number> }>("/shelf"),
};

// ── Models (the Library's Model shelf — verified competition solutions) ───────
export type ModelCard = {
  id: number; author: string; author_slug: string; score: number | null; metric: string;
  method: string; code_url: string; comp_slug: string; comp_title: string; created: number;
};
export const Models = {
  list: (cursor = 0) => get<{ items: ModelCard[]; next: number | null }>("/models", cursor ? { cursor } : undefined),
};

// ── Unified search (the Explore hub; GET /search) ─────────────────────────────
export type SearchGroup<T> = { items: T[]; next: number | null };
/** A published work as a search hit (Search::notebook_card) — the headline fields only, no assets
 *  and no checklist state. Every key it shares with NotebookCard is spelled the same, so one
 *  component renders a search hit and a feed card alike. */
export type SearchNotebook = {
  id: number; kind: NbKind; slug: string; title: string; abstract: string; thumb: string;
  hearts: number; comments: number; views: number;
  /** The citation of record, member-facing: only the /d/n<id> short link, '' before first publish. */
  doi_link: string;
  /** Who WROTE the notebook, as Kaggle reports it — the work is credited to them; `author` below
   *  is the member who brought it here, and on a re-published work the two differ. */
  kaggle: { owner: string; author: string; url: string };
  author: { id: number; name: string; slug: string; avatar: string };
  published_at: number;
};
/** The retired platform's shape. The server still returns a `courses` key and it is ALWAYS empty
 *  (the table was purged 2026-07-13) — the key survives so no existing client breaks. */
export type SearchCourse = {
  id: number; slug: string; title: string; image: string; channel: string;
  lessons: number; duration: number; comments_per_day: number; comments_total: number; price: number; rating: number; enrolled: number;
};
export type SearchGrant = {
  id: number; slug: string; title: string; funder: string; url: string; country: string; category: string;
  amount_display: string; amount_cad: number; deadline: string; deadline_type: string; estimated: boolean; fit: number; summary: string;
};
export type SearchDiscussion = { id: number; title: string; topic: string; lang: string; author: string; mine: boolean; comments: number; score: number; at: number };
// Topics, Groups + Causes are searched CLIENT-SIDE (the server returns these groups empty); the hook fills them.
export type SearchTopic = { key: string; name: string; status: string; empirical: boolean; blurb: string; count: number; category: string; image?: string };
// One group WITHIN a topic — an option a member can stand with (the Topics UI calls an option a
// "group": the fandom character groups, the MBTI types, the houses…). Surfaced so a search finds the
// group itself, not only its parent system. `topicKey` links back to the parent topic; `key` is
// `<system>:<option>` (unique across systems).
export type SearchGroupHit = { key: string; label: string; topic: string; topicKey: string; desc: string; image?: string };
export type SearchCause = { key: string; name: string; sub: string; members: number; raised: number };
export type SearchResults = {
  q: string;
  results: {
    notebooks: SearchGroup<SearchNotebook>;
    courses: SearchGroup<SearchCourse>;
    topics: SearchGroup<SearchTopic>;
    groups: SearchGroup<SearchGroupHit>;
    grants: SearchGroup<SearchGrant>;
    discussions: SearchGroup<SearchDiscussion>;
    causes: SearchGroup<SearchCause>;
  };
};
export const Search = {
  // Server-side domains are notebooks · discussions · grants (Search::SERVER_DOMAINS); page each one
  // independently by passing its `next` back as that domain's cursor. There is no `cursor_courses`:
  // the courses bucket is never queried, so its cursor is always null.
  all: (q: string, p?: { limit?: number; domains?: string; cursor_notebooks?: number; cursor_discussions?: number; cursor_grants?: number }) =>
    get<SearchResults>("/search", { q, ...(p as Record<string, string | number>) }),
};

// ── Auth (passwordless) ─────────────────────────────────────────────────────
export type AuthResult = { ok?: boolean; error?: string; message?: string; redirect?: string; expires_in?: number };
export const Auth = {
  requestCode: (email: string) => post<AuthResult>("/auth/request-code", { email }),
  verifyCode: (email: string, code: string, redirect = "/") => post<AuthResult>("/auth/verify-code", { email, code, redirect }),
  google: (credential: string, redirect = "/") => post<AuthResult>("/auth/google", { credential, redirect }),
  me: () => get<{ user: Me }>("/me"),
};

// ── Account security · active sign-in sessions ───────────────────────────────
export type SessionDevice = { browser: string; os: string; type: "desktop" | "mobile" | "tablet"; label: string };
export type SessionLocation = { label: string; city: string; country: string; cc: string; flag: string; local?: boolean };
export type SessionItem = {
  id: string;          // 64-hex verifier (safe to expose — a one-way hash, never the cookie token)
  current: boolean;    // the device you're on right now
  ip: string;
  device: SessionDevice;
  location: SessionLocation;
  login: number;       // unix seconds
  expires: number;     // unix seconds
};
export const Sessions = {
  list: () => get<{ items: SessionItem[]; count: number }>("/me/sessions"),
  revoke: (id: string) => post<{ ok: true; was_current: boolean; remaining: number }>("/me/sessions/revoke", { id }),
  revokeOthers: () => post<{ ok: true; remaining: number }>("/me/sessions/revoke-others", {}),
  logout: () => post<{ ok: true }>("/auth/logout", {}),
};

// ── Developer API tokens (src/Api.php; docs at /developers) ───────────────────
// Personal access tokens for programmatic + AI-agent use. Session-only management (a token can
// never mint or revoke tokens); the raw token appears once, in the create response, then only
// its hash survives. Publication stays behind the dual email gate whatever the credential.
export type ApiTokenScope = "read" | "write" | "economy";
export type ApiTokenItem = {
  id: number; label: string; prefix: string; scopes: ApiTokenScope[];
  calls: number; last_used: number; created: number; revoked: boolean;
};
export const ApiTokens = {
  list: () => get<{ items: ApiTokenItem[] }>("/api/tokens", { _: Date.now() }),
  create: (label: string, scopes: ApiTokenScope[]) =>
    post<{ ok: true; token: string; note: string; item: ApiTokenItem }>("/api/tokens", { label, scopes }),
  revoke: (id: number) => post<{ ok: true; item: ApiTokenItem }>(`/api/tokens/${id}/revoke`, {}),
};

// Passkeys (WebAuthn): the cryptographic publication co-signature — the device's private key
// never exists on the server, so nobody (agent, operator, server-root) can forge the author's
// publish consent. Session-only, like token management.
export type PasskeyItem = { id: number; label: string; created: number; last_used: number; revoked: boolean };
export const Passkeys = {
  list: () => get<{ items: PasskeyItem[] }>("/passkey", { _: Date.now() }),
  registerOptions: () => post<Record<string, unknown>>("/passkey/register/options", {}),
  register: (payload: { label: string; clientDataJSON: string; attestationObject: string }) =>
    post<{ ok: true }>("/passkey/register", payload),
  revoke: (id: number) => post<{ ok: true }>(`/passkey/${id}/revoke`, {}),
};
export type ApiDocsRoute = { method: string; path: string; auth: string; token_scope: ApiTokenScope | null };
export type ApiDocs = {
  name: string; version: string; base: string; docs: string; openapi: string;
  auth: { how: string; check: string; scopes: Record<string, string>; notes: string };
  publishing: { principle: string; flow: string[]; gate: string };
  conventions: Record<string, string>;
  endpoints: ApiDocsRoute[];
};
export const apiDocs = () => get<ApiDocs>("/api/docs");

// ── Account deletion (irreversible profile purge) ─────────────────────────────
// Two-step, two-factor guard so an accidental or hijacked-session click can't fire it:
// request emails a 6-digit re-auth code; confirm needs that code AND the typed word DELETE, then
// the backend purges the whole profile and signs the member out (see Account.php).
export const Account = {
  deleteRequest: () => post<{ ok: true; email: string; expires_in: number }>("/me/delete/request", {}),
  deleteConfirm: (code: string, confirm: string) =>
    post<{ ok: true; redirect: string }>("/me/delete/confirm", { code, confirm }),
};

// ── i18n ────────────────────────────────────────────────────────────────────
export type Language = { code: string; name: string; native: string; rtl: boolean };
export const I18n = {
  config: () => get<{ languages: Language[]; source: string; current: string }>("/i18n/config"),
  resolve: (lang: string, hashes: string[]) => post<{ hits: Record<string, string> }>("/i18n/resolve", { lang, hashes }),
  translate: (lang: string, strings: string[]) => post<{ map: Record<string, string> }>("/i18n/translate", { lang, strings }),
  save: (lang: string, items: { source: string; target: string }[]) => post<{ saved: number }>("/i18n/save", { lang, items }),
};

// ── Funds ───────────────────────────────────────────────────────────────────
export type ShareKit = { message: string; url: string; links: { x: string; facebook: string; linkedin: string; whatsapp: string } };
export type BursaryStatus = { available: boolean; fund_cents: number; currency: string; donate_url: string; share: ShareKit };
export type BursaryResult = { ok: boolean; granted?: boolean; already?: boolean; free?: boolean; fund_empty?: boolean; course?: string; group?: string; amount?: number; symbol?: string; message?: string; error?: string; share?: ShareKit };
export const Funds = {
  finances: () => get<{ total_cents: number; buckets: Record<string, number>; recent: unknown[] }>("/foundation/finances"),
  // Donations are charged through the cart checkout (Cart/Checkout → course-checkout → Stripe), never a
  // direct /donate call — that path is gone so no gift is recorded without a captured payment.
  // Is the bursary fund able to cover a grant right now?
  bursaryStatus: (group = "") => get<BursaryStatus>(`/bursary/status${group ? `?group=${encodeURIComponent(group)}` : ""}`),
  // Apply for a bursary to cover a course's entry fee (Outreach-funded).
  bursaryApply: (course_id: number, group: string, reason: string) =>
    post<BursaryResult>("/bursary/apply", { course_id, group, reason }),
};

// Eligibility groups — mirror Funds::GROUPS (backend single source of truth).
export const BURSARY_GROUPS: { key: string; label: string }[] = [
  { key: "refugees", label: "Refugees & displaced people" },
  { key: "low_income", label: "Low-income households" },
  { key: "students", label: "Students" },
  { key: "women_stem", label: "Women in STEM" },
  { key: "disabled", label: "People with disabilities" },
  { key: "rural", label: "Rural & remote communities" },
  { key: "unemployed", label: "Unemployed & career-changers" },
  { key: "indigenous", label: "Indigenous communities" },
];

// ── Contributions (Claude/ArtaBot-triaged tickets) ───────────────────────────
export type TicketKind = "bug" | "feature" | "content" | "suggestion";
export type TicketRole = "user" | "assistant" | "agent" | "system";
/** Single source of truth for the four contribution kinds → contributor role + UI copy.
 *  Mirrors Tickets::KINDS on the backend (each kind ranks on its OWN leaderboard board). */
export const KINDS: { key: TicketKind; label: string; role: string; hint: string }[] = [
  { key: "bug", label: "Bug", role: "Sentinel", hint: "Something's broken or wrong" },
  { key: "feature", label: "Feature", role: "Visionary", hint: "A new capability you'd love" },
  { key: "content", label: "Content", role: "Curator", hint: "Improve a course, copy, or translation" },
  { key: "suggestion", label: "Suggestion", role: "Sage", hint: "Any other idea" },
];
export type Ticket = {
  id: number; user_id: number; author: string; mine: boolean; kind: TicketKind; role: string;
  title: string; body: string; screenshot: string; where_url: string; status: string;
  msg_count: number; branch: string; pr_url: string; deploy_sha: string;
  points: number; created: number; resolved_at: number;
  /** The member's original chat words that triggered a chat-filed contribution (#121); '' / absent
   *  for a form-filed ticket. Only the single-ticket detail endpoint (Tickets.get) returns it. */
  chat_prompt?: string;
};
export type TicketMsg = {
  id: number; role: TicketRole; body: string; meta?: Record<string, unknown> | null;
  at: number; cost?: number;
};
export const Tickets = {
  create: (b: { kind: TicketKind; title: string; body: string; screenshot: string; where?: string }) =>
    post<{ ok: boolean; id: number }>("/tickets", b),
  /** Upload a screenshot (base64 data URL) → returns its stored URL. */
  uploadScreenshot: (image: string) => post<{ ok: boolean; url: string }>("/tickets/upload", { image }),
  list: (scope: "mine" | "all" = "mine", p?: { cursor?: number; kind?: TicketKind }) =>
    get<Page<Ticket>>("/tickets", { scope, ...(p as Record<string, string | number>) }),
  get: (id: number, cursor = 0) =>
    get<{ ticket: Ticket; messages: { items: TicketMsg[]; next: number | null } }>(
      `/tickets/${id}`,
      cursor ? { cursor } : undefined,
    ),
  /** Owner adds a turn. `image` (optional) is the stored URL of a screenshot attached via
   *  uploadScreenshot (#48) — JSON.stringify drops it when undefined, so text-only turns are unchanged. */
  message: (id: number, body: string, image?: string) =>
    post<{ ok: boolean; reply?: TicketMsg }>(`/tickets/${id}/message`, { body, image }),
  resolve: (id: number) => post<{ ok: boolean; points: number; track: string }>(`/tickets/${id}/resolve`, {}),
  reopen: (id: number) => post<{ ok: boolean }>(`/tickets/${id}/reopen`, {}),
};

// ── ArtaBot (the global AI assistant; persistent memory; free + unlimited) ───
// `image` is client-only — the data URL of a screenshot the member attached, shown live in their own
// bubble. The server forwards it to Claude for that turn but never stores or returns it.
export type ArtabotMsg = { id: number; role: "user" | "assistant"; body: string; tokens?: number; at: number; image?: string; ticket?: { id: number; kind: string; status: string } };
// Anonymous visitors carry a stable client id so the server can keep their own conversation
// across turns (kept in localStorage; logged-in users ignore it).
function anonId(): string {
  if (typeof window === "undefined") return "";
  try {
    let id = localStorage.getItem("aq_anon_id");
    if (!id) { id = ((crypto as { randomUUID?: () => string }).randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^a-z0-9]/gi, ""); localStorage.setItem("aq_anon_id", id); }
    return id;
  } catch { return ""; }
}
export const ArtaBot = {
  history: () => get<{ items: ArtabotMsg[]; anon?: boolean }>("/artabot", { anon: anonId() }),
  // `image` (optional) is a data URL of a screenshot to attach to this turn — sent inline to Claude,
  // never stored. JSON.stringify drops it when undefined, so text-only turns are unchanged.
  ask: (message: string, image?: string) => post<{ reply: ArtabotMsg }>("/artabot", { message, image, anon: anonId() }),
  clear: () => post<{ ok: boolean }>("/artabot/clear", { anon: anonId() }),
};

/** Server-injected first-paint identity (window.AQ_USER), present before any fetch. */
export function currentUser(): { id?: number; name: string; avatar: string; slug?: string; country?: string } | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { AQ_USER?: { id?: number; name: string; avatar: string; slug?: string; country?: string } }).AQ_USER ?? null;
}
export function isLoggedIn(): boolean {
  if (typeof window === "undefined") return false;
  const v = (window as unknown as { AQ_LOGGED_IN?: boolean }).AQ_LOGGED_IN;
  return v === undefined ? true : !!v;
}

// ── ArtaMod (public methodology + the actual labelled test set) ──────────────
export type FearCategory = { key: string; n: number; flagged: number; welcome: number };
/** ArtaMod's live receipts — what the screen has actually done on the real platform
 *  (Fearometer::transparency 'live', 2026-06-12). Optional: absent on older plugin builds,
 *  and the page hides the section until it arrives. */
export type FearLive = {
  replies_screened: number;
  flagged: number;
  flag_rate: number;
  /** Comments posted but not yet read by the screening relay. Screening is ASYNCHRONOUS — a
   *  comment is queued on post and read shortly after, and it never holds up posting — so
   *  `replies_screened` counts only what actually went through the queue. Required, not
   *  optional: the pair is the honest reading. A stalled relay shows up here instead of
   *  silently deflating the total, so render it beside the total, never the total alone. */
  queued: number;
  appeals: number;
  appeals_granted: number;
  most_flagged_courses: { slug: string; title: string; flagged: number }[];
};
export type FearTransparency = {
  threshold: number;
  scale: { min: number; max: number };
  model: string;
  criteria: string[];
  corpus: { total: number; languages: number; lang_codes: string[]; categories: FearCategory[] };
  calibration: { cases: number; languages: number; categories: number; accuracy: number; precision: number; recall: number; cycles: number; updated: string };
  live?: FearLive;
  consequence: string;
  promise?: string;
};
/** GET /fearometer — public methodology + live stats of the deployed test set (radical transparency). */
export function getFearometer(): Promise<FearTransparency> {
  return get<FearTransparency>("/fearometer");
}

// ── Awards (Kaggle-style engagement badges) ──────────────────────────────────
/** One badge from the catalog, with this member's earned-state + progress — exactly the rows
 *  Awards::evaluate returns (components/AwardBadge.tsx renders the wall). */
export type Award = {
  key: string;
  group: string;
  tier: "bronze" | "silver" | "gold";
  icon: string;
  label: string;
  desc: string;
  earned: boolean;
  have: number;
  need: number;
};

// ── ArtaQuest Research — the automated AI review pipeline (src/Science.php) ────
/** A journal hosted on the ArtaQuest Journals portal. The portal renders whatever the API returns —
 *  treat this list as data; never hardcode the set of journals. */
export type Journal = {
  slug: string;
  name: string;
  tagline: string;
  scope: string;
  published: number;
  in_review: number;
  total: number;
};
export type ReviewRound = {
  round: number;
  reproduced: boolean;
  verdict: "accept" | "revise" | "reject";
  score: number;
  /** Optional per-axis rubric breakdown (each 0–100); the overall `score` is their weighted average.
   *  Older reviews predate persistence and have this null/absent. Keys: reproducibility, honesty,
   *  communication, visualisation, accessibility, references, significance. See /artascience. */
  scores?: Record<string, number> | null;
  report: string;
  model?: string;
  effort?: string;
  runtime_s?: number;
  created: number;
};
/** One series within a figure. `emphasis` = a thicker/marked signature line (a median or named
 *  exemplar); `dash` = a dashed secondary line; `labels` = optional per-point text (used by "dots").
 *  Class is encoded by colour + dash + marker SHAPE together, so figures stay readable in greyscale
 *  and for colour-blind readers. */
export type ChartSeries = { name: string; values: number[]; emphasis?: boolean; dash?: boolean; labels?: (string | number)[];
  /** Optional band around this series' line (same length as `values`): renders a translucent filled
   *  ribbon between `lo` and `hi` — used for an interquartile (IQR) band around a median. */
  lo?: number[]; hi?: number[] };
/** A dashed reference/annotation line at a constant x or y (e.g. "1 year", "median"). */
export type ChartRule = { axis: "x" | "y"; value: number; label?: string };
/** The publication-grade chart spec the reviewer emits (Submission.charts is a JSON array of these).
 *  "dots" is a 1-D dot/strip plot of a small distribution; x is the value axis, each series a row of
 *  dots. Backward-compatible: pre-existing specs that lack the new fields still render. */
export type ChartSpec = {
  type?: "line" | "bar" | "scatter" | "area" | "dots";
  title?: string;
  caption?: string;
  x_label?: string;
  y_label?: string;
  x_unit?: string;
  y_unit?: string;
  x: (number | string)[];
  series: ChartSeries[];
  rules?: ChartRule[];
  /** The manuscript figure this spec belongs to — specs sharing a `figure` are that figure's PANELS
   *  (`panel` = the letter, e.g. "a"), so a multi-panel PDF figure carries over panel-for-panel. */
  figure?: number;
  panel?: string;
};

export type Submission = {
  id: number;
  title: string;
  status: "submitted" | "reviewing" | "revisions-requested" | "accepted" | "rejected" | "withdrawn";
  journal?: string;       // the journal this submission belongs to (slug)
  journal_name?: string;  // the journal's display name (for badges)
  round: number;
  score: number;
  reproduced: boolean;
  doi?: string;
  record_url?: string;
  colab_url?: string;   // legacy rows only — no longer written
  kaggle_url?: string;
  pdf_url?: string;     // the compiled manuscript PDF (same-origin) — embedded inline on the article page
  thumb_url?: string;   // generated article thumbnail (the typeset paper's first page) — cards + og:image
  thread_id?: number;   // the article's discussion thread (aq_threads id); 0 until published
  template_ok?: boolean; // false if the manuscript did NOT use the journal LaTeX template (author warning)
  author: { id: number; name: string; slug?: string } | null;
  created: number;
  updated: number;
  abstract?: string;
  data_url?: string;
  code_url?: string;
  paper_url?: string;
  dataset_id?: number; // the registered dataset artifact this submission is built on
  model_id?: number;   // the registered model artifact (standard reproduction contract)
  notebook?: string; // reproduction notebook JSON (only on a published article via getSubmission)
  body_html?: string; // sanitised full-text article HTML (the Nature-style reader; only via getSubmission)
  charts?: string;    // JSON array of interactive chart specs (validated server-side; only via getSubmission)
  reviews?: ReviewRound[];
};
/** Same-origin text proxy for an accepted article's data/code artefact (so the inline CSV/code viewers
 *  work regardless of the host's CORS). Returns text; throws on binary/zip (the viewer falls back to a link). */
export function getArtefact(id: number, which: "data" | "code") {
  return get<{ content_type: string; text: string; bytes: number; truncated: boolean }>("/research/artefact", { id, which, _: Date.now() });
}
/** Upload one artefact (manuscript zip / code / data file) → its public URL, an alternative to hosting a URL. */
export async function uploadResearchFile(file: File): Promise<{ url: string; name: string; size: number }> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  // No Content-Type — the browser sets the multipart boundary itself.
  const r = await send(`${BASE}/research/upload`, { method: "POST", body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError("/research/upload", r.status, (j as { message?: string }).message);
  return j as { url: string; name: string; size: number };
}
/** The journals hosted on the portal (publisher hub). Cache-busted so a new journal or a fresh
 *  count appears promptly. The hub renders whatever this returns — the set of journals is data. */
export function getJournals() {
  return get<{ journals: Journal[] }>("/research/journals", { _: Date.now() });
}
// ── Research artifacts — the dataset + model PREREQUISITES of every submission ──────────────────
// A manuscript can only be submitted once its open DATASET and its MODEL (code bundle carrying the
// journal's standard reproduction contract: reproduce.py or run.sh + requirements.txt + expected.json)
// are registered as validated platform artifacts. The reviewer pipeline pre-runs the contract.
export type ResearchArtifact = {
  id: number;
  kind: "dataset" | "model";
  title: string;
  description?: string;
  url: string;
  meta: {
    format?: string;        // dataset: csv/tsv/json/…
    columns?: string[];     // dataset: header columns (csv/tsv)
    bytes?: number;
    entrypoint?: string;    // model: reproduce.py | run.sh
    files?: string[];       // model: bundle contents (sample)
    expected?: Record<string, number>; // model: the author's declared key numbers (expected.json)
  };
  author?: { id: number; name: string; slug?: string } | null;
  created: number;
};
/** Public list of registered research artifacts (filter by kind and/or author). Cache-busted. */
export function listResearchArtifacts(params?: { kind?: "dataset" | "model"; author_id?: number; cursor?: number }) {
  return get<{ items: ResearchArtifact[]; next: number | null }>("/research/artifacts", { ...(params || {}), _: Date.now() });
}
/** Register an open DATASET (validated server-side: fetched, format-sniffed, columns recorded). */
export function createResearchDataset(b: { title: string; description?: string; url: string }) {
  return post<ResearchArtifact>("/research/dataset", b);
}
/** Register a MODEL code bundle (validated server-side: the zip must carry the standard reproduction
 *  contract — reproduce.py or run.sh, requirements.txt, and a numeric expected.json). */
export function createResearchModel(b: { title: string; description?: string; url: string }) {
  return post<ResearchArtifact>("/research/model", b);
}
/** Submit a manuscript for fully-automated AI review. Manuscript (LaTeX zip) + a registered dataset +
 *  a registered model + consent REQUIRED, plus the `journal` slug the work is submitted to. */
export function submitResearch(b: { journal: string; title: string; abstract: string; paper_url: string; dataset_id: number; model_id: number; consent: boolean }) {
  return post<{ id: number; status: string; round: number }>("/research/submit", b);
}
/** Author resubmits after a revise verdict — starts a new review round. */
export function reviseSubmission(id: number, b: { abstract?: string; paper_url?: string; dataset_id?: number; model_id?: number }) {
  return post<{ id: number; status: string; round: number }>(`/research/submissions/${id}/revise`, b);
}
/** Author withdraws a submission (not once accepted). */
export function withdrawSubmission(id: number) {
  return post<{ id: number; status: string }>(`/research/submissions/${id}/withdraw`, {});
}
/** Public, keyset-paginated list of submissions (radical transparency). Cache-busted so a freshly
 *  submitted/updated row shows immediately (these GETs are otherwise edge-cached). */
export function listSubmissions(params?: { status?: string; journal?: string; cursor?: number }) {
  return get<{ items: Submission[]; next: number | null }>("/research/submissions", { ...(params || {}), _: Date.now() });
}
/** One submission with every round of AI review (cache-busted — review rounds land asynchronously). */
export function getSubmission(id: number) {
  return get<Submission>(`/research/submissions/${id}`, { _: Date.now() });
}
/** Is the ArtaScience reviewer online, and how deep is the queue? (cache-busted — liveness/queue change) */
export function reviewStatus(journal?: string) {
  return get<{ online: boolean; queued: number; published: number }>("/research/review-status", journal ? { journal, _: Date.now() } : { _: Date.now() });
}

// ── ArtaPublishing — AI-edited, author-owned books (src/Library.php) ─────────
export type BookCard = {
  id: number; slug: string; title: string; summary: string; thumb: string;
  pages: number; views: number; author: { id: number; name: string; slug: string } | null; created: number;
  status?: string; book_state?: string; // present on the author's own shelf (/library/mine)
};
export type BookSource = { id: number; title: string; pages: number; url?: string };
/** One round of the UNIFIED public adversarial-review record (aq_reviews — books, films,
 *  narrations; ArtaScience/Sound/Illustration keep their native round tables). */
export type WorkReview = {
  round: number; reviewer: string; score: number; scores?: Record<string, number> | null; verdict: "pass" | "fix";
  chapter?: string; // '' = the book-level round; otherwise the chapter this round reviewed (each chapter is its own process)
  findings: { file?: string; quote?: string; en_quote?: string; bad?: string; problem: string; fix?: string; applied?: boolean }[];
  report: string; model: string; created: number;
};
export function workReviews(targetType: "book" | "film" | "narration", targetId: number) {
  return get<{ items: WorkReview[]; pass_score: number }>("/reviews", { target_type: targetType, target_id: targetId });
}
export type Book = BookCard & {
  status: string;       // draft | published | removed
  book_state: string;   // '' | queued | processing | review | failed | live
  body_html: string;    // the written book (owner sees drafts; everyone sees published)
  body_text: string;
  is_owner: boolean;
  brief?: string;       // owner only
  cost?: number;        // ArtaCoins to publish (owner only)
  paid?: boolean;       // already charged (owner only)
  sources?: BookSource[]; // private inspiration list (owner only)
  reviews?: WorkReview[]; // the public adversarial-review record (everyone)
};

/** Public, keyset-paginated list of PUBLISHED books (the /library hub). Cache-busted so a freshly
 *  published book shows immediately. */
export function listBooks(params?: { q?: string; cursor?: number }) {
  return get<Page<BookCard>>("/library/documents", { ...(params || {}), _: Date.now() });
}
/** The signed-in member's own book projects (drafts + published). */
export function myBooks() {
  return get<{ items: BookCard[] }>("/library/mine", { _: Date.now() });
}
/** One book — the reader payload (drafts owner-only). Cache-busted (book_state changes asynchronously). */
export function getBook(id: number) {
  return get<Book>(`/library/documents/${id}`, { _: Date.now() });
}
/** Start a book project from a brief (the request). Optional first inspiration PDF + ?generate=1. */
export async function createBook(
  b: { title: string; brief: string; pages: number; summary?: string; rights_ok: boolean; generate?: boolean },
  file?: File,
): Promise<Book> {
  const fd = new FormData();
  fd.append("title", b.title);
  fd.append("brief", b.brief);
  fd.append("pages", String(b.pages));
  if (b.summary) fd.append("summary", b.summary);
  fd.append("rights_ok", b.rights_ok ? "1" : "");
  if (b.generate) fd.append("generate", "1");
  if (file) fd.append("file", file, file.name);
  return postForm<Book>("/library/documents", fd);
}
/** Attach an inspiration PDF (born-digital only) to a book project. */
export function addBookSource(id: number, file: File): Promise<BookSource> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  return postForm<BookSource>(`/library/documents/${id}/sources`, fd);
}
/** Remove an inspiration source. */
export function removeBookSource(id: number, sid: number) {
  return post<{ ok: boolean }>(`/library/documents/${id}/sources/${sid}/delete`, {});
}
/** (Re)queue the AI write; optionally adjust the requested page count first. */
export function generateBook(id: number, pages?: number) {
  return post<{ ok: boolean; queued: boolean }>(`/library/documents/${id}/generate`, pages ? { pages } : {});
}
/** Publish (and optionally edit) the written book — charges ArtaCoins by page count. */
export function publishBook(id: number, b?: { body_html?: string; summary?: string }) {
  return post<Book>(`/library/documents/${id}/publish`, b || {});
}
/** Owner/operator takedown. */
export function deleteBook(id: number) {
  return post<{ ok: boolean }>(`/library/documents/${id}/delete`, {});
}

// ── ArtaSound — AI music studio + audiobooks (src/Music.php) ────────────────
export type TrackCard = {
  id: number; slug: string; title: string; kind: "music" | "audiobook"; summary: string; cover: string;
  seconds: number; length: string; plays: number; author: { id: number; name: string; slug: string } | null; created: number;
  status?: string; track_state?: string;
};
export type TrackSource = { id: number; title: string; url?: string };
/** One adversarial improvement round (the ArtaScience pattern) — public on published work.
 *  audio_url = THAT ROUND'S RECORDING (every attempt stays audible); metrics = its measurements. */
export type TrackReview = {
  round: number; verdict: "approve" | "revise"; score: number;
  scores?: Record<string, number> | null; report: string;
  audio_url?: string; metrics?: Record<string, number | number[]> | null;
  model: string; created: number;
};
/** GET /music/studio — the /artasound transparency pulse. */
export type MusicStudioStatus = {
  online: boolean; queued: number; processing: number; in_review: number;
  published: number; audiobooks: number; rounds_24h: number; rounds_total: number;
  max_rounds: number; model: string;
};
export function getMusicStudio() { return get<MusicStudioStatus>("/music/studio", { _: Date.now() }); }
/** GET /studio/pulse — ONE analytics shape for the whole studio family (the Library renders the
 *  same live strip on every tab). Keys of `kinds` = the MakeKind ids (book … paper). */
export type KindPulse = {
  online: boolean; queued: number; processing: number; in_review: number;
  published: number; rounds_24h: number; rounds_total: number;
};
export type StudioPulse = { model: string; points_per_coin: number; kinds: Record<string, KindPulse> };
export function getStudioPulse() { return get<StudioPulse>("/studio/pulse", { _: Date.now() }); }
export type Track = TrackCard & {
  status: string; track_state: string; // '' | queued | processing | review | failed | live
  round: number; progress: string; // live relay progress ("Round 2 of 3 — rendering" / "Narrating — 240 of 1,032 sentences")
  audio_url: string; audio_mime: string; lyrics?: string; is_owner: boolean;
  voice?: string; manuscript?: string; reviews?: TrackReview[];
  brief?: string; cost?: number; paid?: boolean; sources?: TrackSource[];
};
export function listTracks(params?: { q?: string; cursor?: number; kind?: "music" | "audiobook" }) {
  return get<Page<TrackCard>>("/music/tracks", { ...(params || {}), _: Date.now() });
}
export function myTracks() { return get<{ items: TrackCard[] }>("/music/mine", { _: Date.now() }); }
export function getTrack(id: number) { return get<Track>(`/music/tracks/${id}`, { _: Date.now() }); }
export async function createTrack(
  b: {
    title: string; brief?: string; seconds?: number; summary?: string; rights_ok: boolean; generate?: boolean;
    kind?: "music" | "audiobook"; voice?: string; manuscript?: string;
  },
  file?: File,
): Promise<Track> {
  const fd = new FormData();
  fd.append("title", b.title);
  if (b.kind) fd.append("kind", b.kind);
  if (b.brief) fd.append("brief", b.brief);
  if (b.seconds) fd.append("seconds", String(b.seconds));
  if (b.voice) fd.append("voice", b.voice);
  if (b.manuscript) fd.append("manuscript", b.manuscript);
  if (b.summary) fd.append("summary", b.summary);
  fd.append("rights_ok", b.rights_ok ? "1" : "");
  if (b.generate) fd.append("generate", "1");
  if (file) fd.append("file", file, file.name);
  return postForm<Track>("/music/tracks", fd);
}
export function addTrackSource(id: number, file: File): Promise<TrackSource> {
  const fd = new FormData(); fd.append("file", file, file.name);
  return postForm<TrackSource>(`/music/tracks/${id}/sources`, fd);
}
export function removeTrackSource(id: number, sid: number) { return post<{ ok: boolean }>(`/music/tracks/${id}/sources/${sid}/delete`, {}); }
export function generateTrack(id: number, seconds?: number) { return post<{ ok: boolean; queued: boolean }>(`/music/tracks/${id}/generate`, seconds ? { seconds } : {}); }
export function publishTrack(id: number, b?: { summary?: string }) { return post<Track>(`/music/tracks/${id}/publish`, b || {}); }
export function deleteTrack(id: number) { return post<{ ok: boolean }>(`/music/tracks/${id}/delete`, {}); }

// ── ArtaMotion — AI animation studio (src/Motion.php) ───────────────────────
export type AnimationCard = {
  id: number; slug: string; title: string; summary: string; poster: string;
  seconds: number; length: string; plays: number; author: { id: number; name: string; slug: string } | null; created: number;
  status?: string; anim_state?: string;
};
export type AnimationSource = { id: number; title: string; url?: string };
export type Animation = AnimationCard & {
  status: string; anim_state: string; // '' | queued | processing | review | failed | live
  video_url: string; script?: string; is_owner: boolean;
  brief?: string; cost?: number; paid?: boolean; sources?: AnimationSource[];
};
export function listAnimations(params?: { q?: string; cursor?: number }) {
  return get<Page<AnimationCard>>("/animations", { ...(params || {}), _: Date.now() });
}
export function myAnimations() { return get<{ items: AnimationCard[] }>("/animations/mine", { _: Date.now() }); }
export function getAnimation(id: number) { return get<Animation>(`/animations/${id}`, { _: Date.now() }); }
export async function createAnimation(
  b: { title: string; brief: string; seconds: number; summary?: string; rights_ok: boolean; generate?: boolean },
  file?: File,
): Promise<Animation> {
  const fd = new FormData();
  fd.append("title", b.title); fd.append("brief", b.brief); fd.append("seconds", String(b.seconds));
  if (b.summary) fd.append("summary", b.summary);
  fd.append("rights_ok", b.rights_ok ? "1" : "");
  if (b.generate) fd.append("generate", "1");
  if (file) fd.append("file", file, file.name);
  return postForm<Animation>("/animations", fd);
}
export function addAnimationSource(id: number, file: File): Promise<AnimationSource> {
  const fd = new FormData(); fd.append("file", file, file.name);
  return postForm<AnimationSource>(`/animations/${id}/sources`, fd);
}
export function removeAnimationSource(id: number, sid: number) { return post<{ ok: boolean }>(`/animations/${id}/sources/${sid}/delete`, {}); }
export function generateAnimation(id: number, seconds?: number) { return post<{ ok: boolean; queued: boolean }>(`/animations/${id}/generate`, seconds ? { seconds } : {}); }
export function publishAnimation(id: number, b?: { summary?: string }) { return post<Animation>(`/animations/${id}/publish`, b || {}); }
export function deleteAnimation(id: number) { return post<{ ok: boolean }>(`/animations/${id}/delete`, {}); }

// ── ArtaVoice narrations (read-along audiobooks of published works, any language) ──
export type NarrationSeg = { i: number; start: number; dur: number };
export type Narration = {
  id: number; target_type: string; target_id: number; title: string;
  voice: string; lang: string; state: string; // queued | processing | done | failed
  audio_url: string; total_secs: number; created: number;
  author: { id: number; name: string; slug: string };
  segments?: NarrationSeg[];
};
export function listNarrations(targetType: string, targetId: number) {
  return get<{ items: Narration[] }>("/narrations", { target_type: targetType, target_id: targetId });
}
export function getNarration(id: number) { return get<Narration>(`/narrations/${id}`); }
export function createNarration(b: { target_type: string; target_id: number; voice: string }) {
  return post<Narration>("/narrations", b);
}
export function deleteNarration(id: number) { return post<{ ok: boolean }>(`/narrations/${id}/delete`, {}); }
export function myNarrations() { return get<{ items: Narration[] }>("/narrations/mine"); }

// ── ArtaFilm (AI text-to-video studio) ──
export type FilmCard = {
  id: number; slug: string; title: string; summary: string; poster: string;
  seconds: number; length: string; plays: number; created: number;
  status?: string; film_state?: string; author: { id: number; name: string; slug: string } | null;
};
export type Film = FilmCard & {
  video_url: string; is_owner: boolean; brief?: string; cost?: number;
  reviews?: WorkReview[]; // the public adversarial-review record (everyone)
};
export function listFilms(cursor?: number, q?: string) {
  return get<{ items: FilmCard[]; next: number | null }>("/films", { ...(cursor ? { cursor } : {}), ...(q ? { q } : {}) });
}
export function myFilms() { return get<{ items: FilmCard[] }>("/films/mine"); }
export function getFilm(id: number) { return get<Film>(`/films/${id}`); }
export function createFilm(b: { title: string; brief: string; seconds: number; rights_ok: boolean; generate?: boolean }) {
  return post<Film>("/films", b);
}
export function generateFilm(id: number, seconds?: number) { return post<{ ok: boolean; queued: boolean }>(`/films/${id}/generate`, seconds ? { seconds } : {}); }
export function publishFilm(id: number, b?: { summary?: string }) { return post<Film>(`/films/${id}/publish`, b || {}); }
export function deleteFilm(id: number) { return post<{ ok: boolean }>(`/films/${id}/delete`, {}); }

// ── ArtaIllustration (AI illustration studio — adversarial improvement rounds) ──
export type IllustrationCard = {
  id: number; slug: string; title: string; summary: string; image: string; aspect: string;
  kind: "art" | "cover" | "plate"; book_id: number; rounds: number; score: number;
  views: number; created: number;
  status?: string; art_state?: string; author: { id: number; name: string; slug: string } | null;
  /** Present on scope=activity items: the latest round's verdict, for the transparency feed. */
  last_round?: { round: number; score: number; verdict: string; critique: string };
};
export type IllustrationRound = {
  round: number; action: string; prompt: string; critique: string;
  /** Per-axis rubric scores (fidelity/composition/craft/colour/purpose), when the critic supplied them. */
  axes?: Record<string, number> | null;
  score: number; verdict: string; engine: string; image: string;
};
export type Illustration = IllustrationCard & {
  engine: string; width: number; height: number; is_owner: boolean;
  improvements?: IllustrationRound[]; book?: { id: number; title: string };
  brief?: string; style?: string; cost?: number;
};
export function listIllustrations(opts?: { cursor?: number; q?: string; book?: number; kind?: string; scope?: "activity" }) {
  const { cursor, q, book, kind, scope } = opts || {};
  return get<{ items: IllustrationCard[]; next: number | null }>("/illustrations", {
    ...(cursor ? { cursor } : {}), ...(q ? { q } : {}), ...(book ? { book } : {}), ...(kind ? { kind } : {}), ...(scope ? { scope } : {}),
  });
}
export function myIllustrations() { return get<{ items: IllustrationCard[] }>("/illustrations/mine"); }
export function getIllustration(id: number) { return get<Illustration>(`/illustrations/${id}`); }
export function createIllustration(b: {
  title: string; brief: string; style?: string; kind?: string; book_id?: number; aspect?: string;
  rights_ok: boolean; generate?: boolean;
}) { return post<Illustration>("/illustrations", b); }
export function generateIllustration(id: number) { return post<{ ok: boolean; queued: boolean }>(`/illustrations/${id}/generate`, {}); }
export function publishIllustration(id: number, b?: { summary?: string }) { return post<Illustration>(`/illustrations/${id}/publish`, b || {}); }
export function deleteIllustration(id: number) { return post<{ ok: boolean }>(`/illustrations/${id}/delete`, {}); }

// ── ArtaTranslate (the mesh's slow second pass: SOTA model + adversarial rounds) ──
export type TranslateRound = {
  round: number; engine: string; candidate: string; critique: string; score: number; at?: number;
};
export type TranslateRecent = {
  hash: string; lang: string; source: string; final: string; quality: number;
  rounds: TranslateRound[]; at: number;
};
export type TranslateStatus = {
  engine: string;
  totals: { auto: number; arta: number };
  queue: Record<string, number>; // p2 (narrations) / p1 (fresh edge) / p0 (backlog)
  recent: TranslateRecent[];
};
export function translateStatus() { return get<TranslateStatus>("/translate/status"); }
export function translateRounds(hash: string, lang: string) {
  return get<{ source: string; final: string; status: string; quality: number; rounds: TranslateRound[] }>(
    "/translate/rounds", { hash, lang },
  );
}

// ── ArtaShop — worldwide hard copies (printed books, games, prints, merch; PTT tariff shipping) ──
export type ShopProduct = {
  id: number; kind: "book" | "game" | "print" | "merch"; slug: string; title: string;
  summary: string; image: string; source_type: string; source_id: number;
  price_coins: number; weight_g: number; stock: number; sold: number; available: boolean;
  status?: string; ship_from_coins?: number | null;
};
export type ShopQuote = {
  country: string; service: "registered" | "unregistered"; tracked: boolean; weight_g: number;
  postage_tl: number; customs_tl: number; insure_tl: number; total_tl: number;
  coins: number; tl_per_coin: number; goods_coins: number; total_coins: number;
};
export type ShopOrder = {
  id: number; status: string; country: string; service: string; insured: boolean;
  weight_g: number; coins_goods: number; coins_ship: number; coins_total: number;
  tracking: string; track_url: string; created: number; user_id?: number;
  items: { product_id: number; qty: number; title: string; coins_each: number }[];
  ship_to: { name: string; address: string; city: string; postcode: string; country: string } | null;
};
export const Shop = {
  list: (opts?: { kind?: string; cursor?: number }) =>
    get<{ items: ShopProduct[]; next: number | null }>("/shop/products", {
      ...(opts?.kind ? { kind: opts.kind } : {}), ...(opts?.cursor ? { cursor: opts.cursor } : {}),
    }),
  get: (id: number) => get<ShopProduct>(`/shop/products/${id}`),
  quote: (country: string, items: string, insured: boolean) =>
    get<ShopQuote>("/shop/quote", { country, items, insured: insured ? 1 : 0 }),
  order: (b: { items: string; country: string; name: string; address: string; city: string; postcode: string; insured: boolean }) =>
    post<{ ok: boolean; order: ShopOrder }>("/shop/order", { ...b, insured: b.insured ? 1 : 0 }),
  myOrders: () => get<{ items: ShopOrder[] }>("/shop/orders"),
  studio: () => get<{ products: ShopProduct[]; orders: ShopOrder[]; tl_per_coin: number }>("/studio/shop"),
  saveProduct: (b: Record<string, unknown>) => post<{ ok: boolean; product: ShopProduct }>("/studio/shop/product", b),
  updateOrder: (b: { id: number; action: "shipped" | "delivered" | "cancel"; tracking?: string }) =>
    post<{ ok: boolean; order: ShopOrder }>("/studio/shop/order", b),
};

// ── ArtaRPS — one wheel, twelve tools, thrown all at once (chess.com-style live matches,
//    lobby, Elo leaderboard, per-match chat). ─────────────────────────────────────────────────
export type RpsMode = "open" | "bot-chill" | "bot-sharp";
export type RpsPlayer = { uid: number; name: string; slug: string; rating: number; wins: number; losses: number; draws: number };
export type RpsRound = { r: number; a: string; b: string; pa: number; pb: number };
export type RpsChatMsg = { id: number; uid: number; name: string; body: string; created: number };
export type RpsGameId = "ring" | "cross" | "wheel";
export type RpsMatch = {
  id: number; ring: string; game: string; mode: RpsMode; status: "open" | "live" | "done"; rated: boolean;
  p1: RpsPlayer; p2: RpsPlayer | null; score: [number, number]; rounds_total: number;
  rounds: RpsRound[]; used: [string[], string[]]; pending: [boolean, boolean]; winner: 0 | 1 | 2; delta: [number, number];
  you: 0 | 1 | 2; last_move: number; created: number; idle_claim_s: number; chat?: RpsChatMsg[];
  // chess-style clock: each player's bank (s), which seat(s) are ticking, and the server clock so the
  // running bank can be counted down locally between polls. clock_s is the starting bank (10 min).
  clock: [number, number]; clock_s: number; clock_run: [boolean, boolean]; srv_now: number;
};
export type RpsBoard = {
  tools: string[]; clock_s: number;
  games: { id: RpsGameId; tools: string[]; rounds: number }[];
  leaderboard: { rank: number; uid: number; name: string; slug: string; rating: number; wins: number; losses: number; draws: number }[];
  lobby: { id: number; ring: string; game: string; by: RpsPlayer; created: number }[];
  mine: RpsMatch[]; me: RpsPlayer | null;
};
export function rpsBoard() { return get<RpsBoard>("/games/rps"); }
export function rpsCreate(mode: RpsMode, game: RpsGameId = "wheel") { return post<RpsMatch>("/games/rps/match", { mode, game }); }
export function rpsJoin(id: number) { return post<RpsMatch>(`/games/rps/match/${id}/join`, {}); }
export function rpsState(id: number, chatAfter: number) { return get<RpsMatch>(`/games/rps/match/${id}`, { chat_after: chatAfter }); }
export function rpsMove(id: number, tool: string) { return post<RpsMatch>(`/games/rps/match/${id}/move`, { tool }); }
export function rpsChat(id: number, body: string) { return post<{ id: number }>(`/games/rps/match/${id}/chat`, { body }); }
export function rpsClaim(id: number) { return post<RpsMatch>(`/games/rps/match/${id}/claim`, {}); }
export function rpsResign(id: number) { return post<RpsMatch | { withdrawn: boolean }>(`/games/rps/match/${id}/resign`, {}); }

// ── The feed (operator 2026-07-28) — ONE principle: every submission is a PUBLIC KAGGLE
//    NOTEBOOK THAT HAS BEEN RUN. The member pastes its output-page URL, picks which output files
//    to publish, and an exhaustive reproducibility checklist reads the facts back from the public
//    Kaggle API — which answers without a login, so any reader can re-run the same checks.
//    Blocking items must all pass; warnings never block; nothing is scored, graded or ranked.
//    Clearing the checklist only REQUESTS publication: the AUTHOR's own emailed single-use link,
//    signed by their device passkey, is the only thing that publishes and mints the DOI.
//    Published files enter the Library, attachable to any member's post. Mirrors Notebook.php +
//    Kernel.php. ──────────────────────────────────────────────────────────────────────────────
export type NbKind =
  | "survey" | "dataset" | "model" | "article"
  | "illustration2d" | "illustration3d" | "animation2d" | "animation3d"
  | "game2d" | "game3d" | "music";

export const NB_KINDS: NbKind[] = [
  "survey", "dataset", "model", "article",
  "illustration2d", "illustration3d", "animation2d", "animation3d",
  "game2d", "game3d", "music",
];

/** Pre-2026-07-22 kind values → their new home (CDN-cached cards + rows awaiting the
 *  server-side migrate_kinds() pass keep rendering; mirror of Notebook::LEGACY_KINDS).
 *  `music` is NOT here: it is a real kind again (operator 2026-07-26), so mapping it away
 *  would rewrite new tracks into articles. */
export const LEGACY_NB_KIND: Record<string, NbKind> = {
  paper: "article", book: "article", playlist: "article", presentation: "article",
  illustration: "illustration2d", animation: "animation2d", game: "game2d",
};
export const normalizeNbKind = (k: string): NbKind => LEGACY_NB_KIND[k] || (k as NbKind);

export type NbAsset = { name: string; url: string; bytes: number; mime: string };

export type NotebookCard = {
  id: number; kind: NbKind; slug: string; title: string; abstract: string;
  /** THE standard attachment pair: teaser-dark/-light webm — VP9 with alpha, transparent
   *  background, 640×360 24fps 6s loop, each optimised for its global theme. Every published
   *  kind carries the pair; feed cards render the active theme's variant as the uniform hero.
   *  `teaser` is the dark variant; `teaser_light` is '' on pre-pair publishes (fall back). */
  teaser: string;
  teaser_light: string;
  /** The SAFE CHANGE-RATE score (0–100, higher = calmer): machine-measured on every video
   *  deliverable (flicker/motion/cuts/chroma + WCAG flash limit); static works are 100.
   *  Details live in the public out/calm.json asset. */
  calm: number;
  /** True when a video was actually measured (the calm distribution + autoplay flagging
   *  consider only measured works — static works never flag). */
  calm_measured: boolean;
  thumb: string; assets: NbAsset[]; hearts: number; comments: number; views: number; score: number; status: "draft" | "pending" | "published" | "removed";
  doi_link: string; colab_url: string; kaggle_url?: string; size_bytes: number;
  author: { id: number; name: string; slug: string; avatar: string };
  /** WHO WROTE THE NOTEBOOK, as Kaggle reports it. `author` above is the ArtaQuest member who
   *  SUBMITTED it — any member may submit any public kernel, so on a re-published work the two
   *  differ and both must be shown. On a self-submitted work they simply agree. */
  kaggle?: { owner: string; author: string; url: string };
  /** The one published file a card should SHOW — best-first by media class. Null when the work
   *  published nothing serveable. Replaces the retired teaser/thumb, which nothing writes now. */
  hero?: LibraryItem | null;
  published_at: number; created: number; updated: number;
};

/** THE REQUIREMENTS FILE (operator order 2026-07-26) — the THREE caps the server enforces,
 *  mirrored from Notebook::MAX_REQ_PINS / MAX_REQ_LINES / MAX_REQ_BYTES so the editor can state
 *  the limits BEFORE a 422 does. All three are the published contract (SUBMISSIONS.md); change
 *  them together or not at all. The cap that means anything is the PIN count — comments and blank
 *  lines install nothing, so they cost nothing but still count towards lines and bytes. */
export const NB_REQ_MAX_PINS = 40;
export const NB_REQ_MAX_LINES = 100;
export const NB_REQ_MAX_BYTES = 4000;

/** DECLARED EXTERNAL MODELS (metadata.aq.models) — ONE schema, end to end.
 *
 *      { "repo": "owner/name", "revision": "<40-hex commit>",
 *        "files": [ { "file": "model.safetensors", "sha256": "<64 hex>" } ] }
 *
 *  This is exactly what `Notebook::declared_models()` accepts and normalises, and exactly what the
 *  relay's `modelRows()` provisions from — so the shape lives HERE, beside the routes, and the editor
 *  imports it instead of inventing a third spelling. TWO pins per file, both load-bearing: the
 *  immutable commit says WHICH bytes (a branch or a tag moves, so it could never reproduce), and the
 *  per-file sha256 is how the runner PROVES it fetched them — it will not place weights it cannot
 *  verify into the sandbox, which is why a file without a hash is refused at SAVE time rather than
 *  failing mysteriously twenty minutes into a run.
 *
 *  The server still READS the older `hf` spelling of `repo` (and is what emits `repo` back), so
 *  anything reading a stored declaration must accept both; anything WRITING one emits `repo`. */
export type NbModelFile = { file: string; sha256: string };
export type NbModelDecl = { repo: string; revision: string; files: NbModelFile[] };
/** The four charsets Notebook::declared_models() enforces, mirrored so the editor can say what is
 *  wrong while it is being typed instead of leaving it to a 422. Revision and sha256 are compared
 *  LOWERCASED (the server lowercases before matching, so a pasted uppercase hash is fine). */
export const NB_MODEL_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
export const NB_MODEL_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
export const NB_MODEL_REV_RE = /^[0-9a-f]{40}$/;
export const NB_MODEL_SHA_RE = /^[0-9a-f]{64}$/;

export type NotebookFull = NotebookCard & {
  ipynb: string;            // the source (canonical JSON string)
  ipynb_out: string;        // the executed notebook with outputs ('' until first clean run)
  /** THE REQUIREMENTS FILE — the literal text of a requirements.txt, installed before the
   *  kernel starts so the work reproduces in the environment it claims. Every requirement is
   *  FULLY PINNED (`name==version`); blank lines and #comments survive verbatim. '' is valid
   *  and means the base environment alone (numpy · pandas · matplotlib · pillow) — the
   *  effortless default no existing kind has to think about. It is part of the reproducibility
   *  claim, so changing it invalidates the gate exactly like editing a cell. */
  requirements: string;
  assets: NbAsset[];        // LEGACY (pre-2026-07-28 rows only) — published files now live in `files`
  fresh: boolean;           // executed outputs match the CURRENT source
  /** The Kaggle notebook this work IS — where every checklist item was read from. */
  kernel?: { owner: string; slug: string; url: string; facts: NbKernelFacts | null };
  /** THE GATE: the stored reproducibility checklist. Public on every work — a reader is entitled
   *  to the same list the author saw. Null before the first check. */
  checks?: NbChecklist | null;
  checked_at?: number;
  /** The Kaggle output filenames the author chose to publish. */
  selection?: string[];
  /** The one-line reason publication is currently refused; '' when the checklist is clear. */
  gate_reason?: string;
  /** The published files, once the work is live (mirrored to our CDN at publish time). */
  files?: LibraryItem[];
  publishable: boolean;     // === (gate_reason === "")
  pub_fee: number;          // legacy field (publishing is free); still mirrors size for points
  following: boolean;       // does the signed-in viewer follow the author
  open_run?: { id: number; type: "run" | "dev"; state: string; iters: number; iters_done: number; score: number; error: string; created: number } | null;
  /** Latest SETTLED run (done | error) — owner-only, same shape as open_run; carries why a failed run failed. */
  last_run?: { id: number; type: "run" | "dev"; state: string; iters: number; iters_done: number; score: number; error: string; created: number } | null;
  /** Why an open publication request ended without publishing — set when a pending work went back
   *  to draft (the author withdrew it from the emailed link, or an edit voided the request). There
   *  is no admin leg in this flow: the author's own inbox is the only approval (operator 2026-07-23). */
  decision_note?: string;
};

export type NbPulse = {
  online: boolean; queued: number; published: number; kinds: Partial<Record<NbKind, number>>;
  model: string; pass: number; fee: string;
  /** Motion-calm cutoffs for the 5 stops, derived from the measured distribution's percentiles
   *  (stop k flags works with calm < value; "Standard" flags half). Zeros = nothing measured. */
  calm_thresholds: number[];
};

export function listNotebooks(params?: { kind?: NbKind; q?: string; sort?: "new" | "top"; cursor?: number; following?: 1; author?: string; calm_min?: number }) {
  return get<Page<NotebookCard>>("/notebooks", { ...(params || {}) } as Record<string, string | number>);
}
export function getNotebook(id: number) {
  return get<NotebookFull>(`/notebooks/${id}`, { _: Date.now() });
}
export function heartNotebook(id: number, val: 0 | 1) {
  return post<{ ok: boolean; hearts: number; mine: number }>(`/notebooks/${id}/heart`, { val });
}
export function notebookPulse() {
  return get<NbPulse>("/notebooks/pulse");
}
export function myNotebooks(cursor?: number) {
  return get<Page<NotebookCard>>("/studio/notebooks", { _: Date.now(), ...(cursor ? { cursor } : {}) });
}
/**
 * Save a work's TITLE and ABSTRACT — the only two fields a client may write (Notebook::save).
 *
 * The code is not editable here and never will be: `ipynb` holds what we pulled from the author's
 * Kaggle kernel, and sig() over that value is what the confirm link, the review ledger and the
 * database publish-guard are all keyed on. Editing it here would desync that signature from the
 * notebook every check was read from — a green checklist certifying source nobody checked.
 *
 * CONSEQUENCE THE UI MUST SURFACE: changing either field while a publish request is PENDING
 * withdraws that request back to draft, because the author must only ever confirm exactly what they
 * were shown — title and abstract included, not just the notebook.
 */
export function saveNotebook(id: number, b: { title?: string; abstract?: string }) {
  return post<NotebookFull>(`/studio/notebooks/${id}/save`, b);
}

/** REQUESTS publication — never publishes. `emailed` is false when the confirm mail was throttled
 *  (one per hour per work), so the UI must not tell a member to check an inbox nothing was sent to. */
export function publishNotebook(id: number) {
  return post<NotebookFull & { emailed?: boolean }>(`/studio/notebooks/${id}/publish`, {});
}
export function deleteNotebook(id: number) {
  return post<{ ok: boolean }>(`/studio/notebooks/${id}/delete`, {});
}

/* ──────────────── Proving a Kaggle handle (operator, 2026-08-04) ────────────────
   A member may submit only a notebook from a Kaggle account they have PROVEN they control.
   Publication mints a permanent DOI crediting the notebook's KAGGLE author — until now that author
   never consented and might never learn of it. The proof runs entirely on Kaggle's credential-free
   read API, so a stranger can re-run it: claim a handle → the server mints a one-time string and
   keeps only its sha256 → the member puts the string in any public notebook under that handle →
   pastes that notebook's URL back → we pull the kernel with NO credential and check that it is
   public, that its owner is the claimed handle, and that the string is in its source. */

export type KaggleIdState = "pending" | "verified";
export type KaggleIdItem = {
  /** The Kaggle username, lowercased (how the server stores it) */
  handle: string;
  state: KaggleIdState;
  /** The public kernel the proof was read from — '' until the handle is verified */
  proof_kernel: string;
  /** Unix seconds; 0 while pending */
  verified_at: number;
};
export const KaggleIds = {
  /** Every handle this member has claimed, pending and proven. `_` defeats any edge cache — a claim
   *  made a second ago must appear. */
  list: () => get<{ items: KaggleIdItem[] }>("/kaggle-id", { _: Date.now() }),
  /** Claim a handle → the one-time proof string. The server stores only its sha256, so this is the
   *  ONLY time the string exists anywhere we can show it; claiming again mints a fresh one (and the
   *  old one stops working). */
  claim: (handle: string) => post<{ ok: true; handle: string; proof: string }>("/kaggle-id/claim", { handle }),
  /** Prove the claim from a public kernel of yours; answers with the handle's new state. */
  verify: (handle: string, url: string) =>
    post<{ ok: true; handle: string; state: KaggleIdState }>("/kaggle-id/verify", { handle, url }),
};

/* ─────────────────── The Kaggle submission (2026-07-28) ───────────────────
   A submission is the URL of a public Kaggle notebook's output page. The member picks which
   output files to publish, an exhaustive reproducibility checklist runs against Kaggle's public
   API, and clearing it only REQUESTS publication — the author's emailed secret is still the mint.
   Mirrors `Rest::ROUTES` (Kernel::import / recheck / outputs / select / library). */

/** One checklist row, exactly as the server stores and publishes it. */
export type NbCheck = {
  id: string;
  /** open = can anyone open it · inputs = can anyone re-run it · run = did that run make these files · rigour = how repeatable */
  group: "open" | "inputs" | "run" | "rigour";
  /** block = publication is refused until fixed · warn = shown loudly, never blocks */
  severity: "block" | "warn";
  title: string;
  /** skip = waiting on the author (not a failure — worded differently everywhere) */
  state: "pass" | "fail" | "skip";
  detail: string;
  /** The literal remedy, empty when the check passed */
  fix: string;
  /** The exact value the check read, for the reader to verify themselves */
  evidence: string;
};

/** What the kernel itself says about the run — every field read back from Kaggle, never asserted. */
export type NbKernelFacts = {
  owner: string; slug: string; url: string;
  title?: string; author?: string; votes?: number; version?: number;
  docker?: string; machine?: string; language?: string;
  internet?: boolean; gpu?: boolean; tpu?: boolean;
  cells?: number; code_cells?: number;
  file_count?: number; truncated?: boolean; run_seconds?: number;
  /** true = Kaggle rendered the finished notebook · false = it crashed · null = no marker either way */
  run_done?: boolean | null;
  sources?: Array<{ type: "dataset" | "model" | "kernel"; ref: string; public: boolean; note: string }>;
  competitions?: string[];
  sizes?: Record<string, number>;
  bytes?: number;
  source_sig?: string;
};

export type NbChecklist = {
  /** No blocks AND nothing still pending */
  ok: boolean;
  blocks: number;
  /** Checks waiting on the author (e.g. no files chosen yet) — NOT failures */
  pending: number;
  warnings: number;
  items: NbCheck[];
  facts: NbKernelFacts;
  groups: Record<string, string>;
  checked_at: number;
};

/** One published file, in the Library, attachable to any member's post. */
export type LibraryItem = {
  id: number;
  nb_id: number;
  name: string;
  label: string;
  // "scene" is SVG — a vector scene, not a picture of one. It is its own class because a card
  // re-renders it at the card's own width instead of resizing samples, which is the whole result
  // for procedural work (Kernel::TYPES). Its bytes are sanitised at publication (AQ\Svg).
  class: "scene" | "audio" | "image" | "video" | "model3d" | "data" | "weights" | "doc" | "notebook";
  mime: string;
  bytes: number;
  sha256: string;
  url: string;
  uses: number;
  work?: {
    id: number; title: string; slug: string; doi: string; kernel: string;
    author: { id: number; name: string; slug: string; avatar: string };
  };
};

/** Step one: paste a Kaggle notebook URL. Idempotent — the same kernel returns the same draft. */
export function importKernel(url: string) {
  return post<{ id: number; existing: boolean; checks: NbChecklist }>("/studio/kernels", { url });
}
/** Re-read everything from Kaggle and re-run every check (after the author fixes something there). */
export function recheckNotebook(id: number) {
  return post<{ ok: boolean; checks: NbChecklist }>(`/studio/notebooks/${id}/check`, {});
}
/** The run's output files, for the picker. `serveable` hides what the Library could not publish. */
export function kernelOutputs(id: number, opts?: { q?: string; serveable?: boolean; cursor?: number }) {
  return get<{
    items: Array<{ name: string; class: string; ext: string }>;
    total: number; all: number; counts: Record<string, number>;
    selection: string[]; next: number | null;
  }>(`/studio/notebooks/${id}/outputs`, {
    _: Date.now(),
    ...(opts?.q ? { q: opts.q } : {}),
    ...(opts?.serveable ? { serveable: 1 } : {}),
    ...(opts?.cursor ? { cursor: opts.cursor } : {}),
  });
}
/**
 * Choose what to publish. The work's kind is DERIVED from the choice and returned.
 *
 * `kind` overrides that derivation: some kinds simply are not inferable from a file extension (a
 * survey and a 2D game both ship JSON or HTML), so the derived value is a default the author may
 * correct. An unknown value is ignored server-side and the derivation stands.
 *
 * `voided` is true when this call withdrew an outstanding publication request — changing what gets
 * published invalidates a confirmation the author has not yet given.
 */
export function selectOutputs(id: number, files: string[], kind?: string) {
  return post<{ ok: boolean; kind: string; voided?: boolean; checks: NbChecklist }>(
    `/studio/notebooks/${id}/select`, { files, ...(kind ? { kind } : {}) });
}
/** ArtaNews — instrument detections, read straight from the detection ledger.
 *  Empty until something is detected; every rail module hides itself when its list is empty.
 *
 *  Each row now HAS a page: `News::feed` emits `slug` and `url`, and `GET news/{slug}` serves the
 *  one detection with its measurements and full provenance. This type previously stated the
 *  opposite — "no slug and no page to link to" — which was true of the 2026-07-31 model and stopped
 *  being true when the backend gained the route. The two halves deploy separately, so the stale
 *  half is what made 20 published permalinks dead ends. */
export type NewsItem = {
  id: number; ekey: string; title: string;
  /** the permalink's slug; pins the event by its trailing -e<id> so a regenerated headline cannot
   *  orphan a URL that is already published. */
  slug?: string;
  /** site-relative page for this detection, e.g. "/news/m5-6-earthquake-new-zealand-e279/". */
  url?: string;
  observed: number; updated: number;
  detector: string; detector_key: string;
  /** the measurement already rendered WITH its units — the units differ per detector, so the
   *  backend formats it; never re-derive it here from `severity`. */
  measure: string;
  place: string; country: string; place_km: number;
  confidence: string; severity: number; lat: number; lon: number;
};
export function listNews(limit = 5) {
  return get<{ items: NewsItem[] }>("/news", { limit });
}

/** ONE detection, with everything needed to check it: the measurements as the instrument reported
 *  them, and the product URL plus retrieval time they were read from.
 *
 *  `measures` is a label -> value map the BACKEND has already formatted with units, because units
 *  differ per detector — never re-derive a display value from `severity`, which is a ranking input
 *  and has published "M6.0 earthquake" for a M2.6 quarry blast when the two were conflated.
 *  `unknown` is the honest field: what the instrument did NOT establish. It renders as itself. */
export type NewsDetection = {
  slug: string; id: number; title: string; summary: string;
  detector: string; kind: string;
  measures: Record<string, string>;
  source: { name: string; url: string; retrieved: number; retrieved_iso: string };
  place: string; place_label: string; country: string; place_km: number;
  lat: number; lon: number;
  severity: number; energy_mj: number; confidence: string;
  observed: number; updated: number;
  /** inline animated SVG of the measured extent over time; empty when the detector has no raster. */
  svg: string;
  /** plain-language statement of what was not determined. Empty when nothing is outstanding. */
  unknown: string;
};
export function newsDetection(slug: string) {
  return get<NewsDetection>(`/news/${encodeURIComponent(slug)}`);
}

/** Every published file on the platform — anyone may attach any of these to their own post. */
export function libraryItems(opts?: { class?: string; q?: string; mine?: boolean; cursor?: number }) {
  return get<Page<LibraryItem>>("/library", {
    ...(opts?.class ? { class: opts.class } : {}),
    ...(opts?.q ? { q: opts.q } : {}),
    ...(opts?.mine ? { mine: 1 } : {}),
    ...(opts?.cursor ? { cursor: opts.cursor } : {}),
  });
}

// Challenges (MEMBER-FOUNDED challenges, 2026-07-14): pick category + topic + a full-moon
// deadline + entry fee, found it with your own notebook; every entrant pays in; winner takes all.
export type ChBoardRow = { rank: number; nb_id: number; title: string; slug: string; hearts: number; score: number; author: NotebookCard["author"] };
export type Challenge = {
  id: number; kind: NbKind; topic: string; title: string; fee: number; pool: number;
  deadline: number; state: "open" | "settled"; creator: NotebookCard["author"]; entries: number;
  results: { podium: (ChBoardRow & { prize: number })[]; paid?: number } | null;
  board?: ChBoardRow[];
};
export function listChallenges() {
  return get<{ current: Challenge[]; past: Challenge[]; rule: string }>("/challenges", { _: Date.now() });
}
export function getChallenge(id: number) {
  return get<Challenge>("/challenges", { id, _: Date.now() });
}
export function chOptions() {
  return get<{ topics: string[]; moons: number[]; kinds: NbKind[] }>("/challenges/options");
}
export function chCreate(b: { kind: NbKind; topic: string; title: string; deadline: number; fee: number; nb_id: number }) {
  return post<Challenge>("/challenges", b);
}
/** Enter a challenge. When the member is short the fee and a donor's ArtaCredit matches them, the
 *  FIRST call is refused with `credit_offered` (ApiError.data.credit names the donor and the slice);
 *  calling again with acceptCredit=true redeems it. Nothing is ever spent on a member's behalf
 *  without that second, informed call — see Notebook::ch_enter. */
export function chEnter(id: number, nbId: number, acceptCredit = false) {
  return post<{ ok: boolean; pool: number; certificate: string; credited?: CreditUsed }>(
    `/challenges/${id}/enter`,
    acceptCredit ? { nb_id: nbId, accept_credit: 1 } : { nb_id: nbId },
  );
}

/* ── ArtaCredits ─────────────────────────────────────────────────────────────
   A donor pays a stranger's challenge entry fee, targeted at a slice of the membership. */

/** The offer a member sees when a donor has already paid their fee (ApiError.data.credit on a 402). */
export type CreditOffer = { donor: string; named: boolean; slice: string; fee: number; notice: string };
export type CreditUsed = { donor: string; named: boolean; fee: number };
export type CreditOptions = {
  countries: { iso: string; name: string }[];
  genders: { key: string; label: string }[];
  bands: { key: string; label: string }[];
  fee_cap: number; moon_cap: number; reach_min: number; symbol: string;
};
/** Members a slice reaches. `exact` is false when the true count is below the floor — we report
 *  "fewer than N" rather than a precise number, so a narrow pick can never count identifiable people. */
export type CreditReach = { bucket: string; words: string; exact: boolean; members: number; floor: number };
export type CreditGift = {
  id: number; words: string; cents: number; entries: number; used: number; held: number; name: string; date: number;
  /** Already released to the general slice. */
  widened: boolean;
  /** Targeted, unspent and not yet released — the donor may open it to any member. */
  can_widen: boolean;
};

export function creditOptions() { return get<CreditOptions>("/credits/options"); }
export function creditReach(country: string, gender: string, band: string) {
  return get<CreditReach>("/credits/reach", { country, gender, band });
}
export function myCredits() { return get<{ items: CreditGift[] }>("/credits/mine"); }
/** Release an unspent, targeted gift to the general slice, where every member is eligible. The only
 *  way money aimed at a slice nobody matches can move — donor-only, and never toward another slice. */
export function widenCredit(id: number) {
  return post<{ ok: boolean; moved_cents: number; entries: number; message: string }>("/credits/widen", { id });
}
/** State, change, or clear ("clear") your gender. Opt-in, revocable, never inferred. */
export function setGender(gender: string) { return post<{ ok: boolean; gender: string }>("/identity/gender", { gender }); }

/* ── Certificate of Participation ────────────────────────────────────────────
   Every challenge entrant holds one. `place` is read from the FROZEN settlement board, so a printed
   certificate says the same thing in a year; it is 0 until the challenge settles at its full moon. */
export type PartCert = {
  valid: boolean;
  member: string; challenge: string; topic: string; kind: string;
  work: string; work_url: string;
  entered_ts: number; moon_ts: number; settled: boolean;
  place: number; field: number; prize: number;
  donor: string; slice: string; sponsored: boolean;
  code: string; verify_url: string;
};
/** A filled-in specimen for the donate page: the real document, with the donor's own name on it as
 *  they type. Everything but `donor` and `slice` is fixed illustrative content, and the face carries
 *  a Sample mark — so a preview can never be mistaken for an issued certificate. */
export function sampleCert(donorName: string, slice: string): PartCert {
  const now = Math.floor(Date.now() / 1000);
  return {
    valid: true,
    member: "Niloofar Rezaei",
    challenge: "What the Karun river carried",
    topic: "Earth science",
    kind: "dataset",
    work: "Sediment load, 1976–2025",
    work_url: "",
    entered_ts: now,
    moon_ts: now + 18 * 86400,
    settled: false,
    place: 0, field: 0, prize: 0,
    donor: donorName.trim(),
    slice,
    sponsored: true,
    code: "A7F2K9D4C1",
    verify_url: "",
  };
}

export function participationCert(challenge: number) { return get<PartCert>("/participation", { challenge }); }
export function myParticipation() {
  return get<{ items: { challenge_id: number; challenge: string; kind: string; topic: string; moon_ts: number; settled: boolean; url: string }[] }>("/participation/mine");
}
export function verifyParticipation(p: number, u: number, k: string) {
  return get<PartCert>("/participation/verify", { p, u, k });
}
/** The publish fee, mirrored from Notebook::pub_fee — the poster's pool contribution. */
export function nbPubFee(sizeBytes: number) {
  return Math.max(1, Math.ceil(sizeBytes / 102400));
}


// ── ArtaChat — end-to-end encrypted DMs (src/Chat.php) ──────────────────────
// The server (and the public DB) holds only P-256 public keys + AES-256-GCM ciphertext; all
// sealing/opening happens in lib/e2ee.ts on the member's device.
export type ChatUserCard = { id: number; name: string; slug: string; avatar: string };
export type ChatKey = { kid: number; pub: string; fp: string; created: number };
/** The newest sealed row of a conversation, shipped with the list so the client can decrypt a
 *  one-line preview on-device. Same ciphertext the public DB already carries — no `blob`, since a
 *  preview never needs the attachment bytes, only the sealed payload naming it. */
export type ChatLastMsg = { id: number; sender: number; akid: number; bkid: number; iv: string; ct: string; at: number };
export type ChatListItem = {
  id: number; peer: ChatUserCard; last_at: number; unread: number; online: boolean;
  low_uid: number; last: ChatLastMsg | null;
};
export type ChatCipherMsg = { id: number; sender: number; akid: number; bkid: number; iv: string; ct: string; blob: string; at: number };
export type ChatMessages = {
  chat_id: number; me: number; peer: ChatUserCard; peer_key: ChatKey | null; my_key: ChatKey | null;
  low_uid: number; keys: Record<number, { user_id: number; pub: string; fp: string }>;
  ttl: number; peer_read: number; peer_online: boolean; peer_typing: boolean;
  items: ChatCipherMsg[]; next: number | null;
};
export function chatGetKey(user: string | number) {
  return get<{ user: ChatUserCard; key: ChatKey | null }>("/chat/keys", { user });
}
export function chatRegisterKey(pub: string) {
  return post<{ ok: boolean; key: ChatKey; rotated: boolean }>("/chat/keys", { pub });
}
export type ChatListPage = {
  items: ChatListItem[];
  me: number;
  /** Every device public key the previews reference, so one still opens after a key rotation. */
  keys: Record<number, { user_id: number; pub: string; fp: string }>;
  my_key: ChatKey | null;
};
export function chatList() { return get<ChatListPage>("/chat/list"); }
/** Unread total for the dock's badge. A separate route from chatList on purpose: reading the LIST
 *  marks you "active in chat" server-side, which suppresses the peer's bell and away-email — so the
 *  thing polled from every page must be this one, which touches no presence. */
export function chatUnread() { return get<{ unread: number }>("/chat/unread"); }
/** One row of the member directory. `has_key` false = they have never opened Messages, so no
 *  device key exists to seal anything to them yet. */
export type ChatMember = {
  id: number; name: string; slug: string; avatar: string; country?: string;
  online: boolean; has_key: boolean;
};
/** One bounded page, no cursor: the sort key is live presence, so a positional cursor would
 *  duplicate and drop members as people come and go between requests. `capped` says when the
 *  membership is larger than the window — search reaches anyone outside it. */
export type ChatDirectory = {
  items: ChatMember[];
  total: number; online: number; listed: number; capped: boolean;
};
/** Everyone on ArtaQuest, online first (GET /chat/members). */
export function chatMembers(opts?: { q?: string }) {
  return get<ChatDirectory>("/chat/members", { ...(opts?.q ? { q: opts.q } : {}) });
}
export function chatMessages(withUid: number, opts?: { cursor?: number; after?: number }) {
  return get<ChatMessages>("/chat/messages", { with: withUid, ...(opts?.cursor ? { cursor: opts.cursor } : {}), ...(opts?.after ? { after: opts.after } : {}) });
}
/** `notify` tells the server whether this sealed row is a real message (bell + email while the peer
 *  is away) or a reaction/edit/tombstone that should stay silent. The server cannot tell them apart
 *  — every row is shape-identical by design — so the sending client says so. */
export function chatSend(to: number, b: { iv: string; ct: string; akid: number; bkid: number; blob?: string; notify?: 0 | 1 }) {
  return post<{ ok: boolean; id: number; chat_id: number; at: number }>("/chat/send", { to, ...b });
}
/** Whether this member is emailed about messages that arrive while they are away (GET), and the
 *  switch to turn it off/on (POST). */
export function chatEmailPrefs(on?: boolean) {
  return on === undefined
    ? get<{ ok: boolean; email_on: boolean }>("/chat/email-prefs")
    : post<{ ok: boolean; email_on: boolean }>("/chat/email-prefs", { on: on ? 1 : 0 });
}
/** Store one already-sealed attachment; the returned name goes into chatSend's `blob`. */
export function chatUploadBlob(sealed: Blob) {
  const fd = new FormData();
  fd.append("file", sealed, "a.bin");
  return postForm<{ ok: boolean; blob: string; url: string }>("/chat/blob", fd);
}
export function chatTyping(withUid: number) {
  return post<{ ok: boolean }>("/chat/typing", { with: withUid });
}
export function chatSetTtl(withUid: number, ttl: number) {
  return post<{ ok: boolean; ttl: number }>("/chat/ttl", { with: withUid, ttl });
}
/** Hard-delete one of the caller's own rows (+ sealed attachment) from the public record. */
export function chatUnsend(id: number) {
  return post<{ ok: boolean }>("/chat/unsend", { id });
}

// Post comments (the polymorphic aq_comments store, context 'notebook') + follows on the feed.
export type NbComment = {
  id: number; parent_id: number; body: string; votes: number; flagged: number; created: number;
  author: NotebookCard["author"]; replies?: NbComment[];
};
export function nbComments(id: number, cursor?: number) {
  return get<{ items: NbComment[]; next: number | null; mine: number[] }>(`/notebooks/${id}/comments`, { _: Date.now(), ...(cursor ? { cursor } : {}) });
}
export function nbComment(id: number, body: string, parentId?: number) {
  return post<{ ok: boolean; id: number; flagged: number }>(`/notebooks/${id}/comments`, { body, ...(parentId ? { parent_id: parentId } : {}) });
}
/** Heart a comment (the shared social vote — idempotent set). */
export function voteComment(id: number, val: 0 | 1) {
  return post<{ ok: boolean }>("/vote", { target_type: "comment", target_id: id, val });
}
export function followUser(targetId: number, on: boolean) {
  return post<{ ok: boolean; following: boolean }>("/follow", { target_id: targetId, on: on ? 1 : 0 });
}

// Survey polls: answer one item at a time; each answer reveals the community distribution.
export function nbPoll(id: number) {
  return get<{ dist: Record<string, number[]>; mine: Record<string, number> }>(`/notebooks/${id}/poll`, { _: Date.now() });
}
export function nbPollAnswer(id: number, item: string, val: number) {
  return post<{ ok: boolean; item: string; dist: number[] }>(`/notebooks/${id}/poll`, { item, val });
}
// Single-select typology (e.g. "which character do you like most?"): one pick per member; the
// chosen option's image becomes the member's public avatar (unless they uploaded a photo).
export function nbPick(id: number) {
  return get<{ counts: Record<string, number>; mine: string }>(`/notebooks/${id}/pick`, { _: Date.now() });
}
export function nbPickAnswer(id: number, option: string) {
  return post<{ ok: boolean; mine: string; counts: Record<string, number>; avatar: string; avatar_set: boolean }>(`/notebooks/${id}/pick`, { option });
}

// THE feed model (2026-07-14): posts — text-only (≤280) or text + ONE own notebook scoring ≥90;
// reposts/quotes reference another post. Notebook cards keep their own hearts (challenge scoring).
export type FeedPostT = {
  id: number; body: string; hearts: number; reposts: number; created: number;
  author: NotebookCard["author"]; nb: NotebookCard | null; repost: FeedPostT | null;
  /** Library attachments (max 4), each carrying the work it came out of — so a re-used
   *  artifact always shows whose run produced it, wherever it turns up. */
  media?: LibraryItem[];
};
/** `mine` is the ids of the posts the SIGNED-IN viewer has already hearted — without it the client
 *  cannot know, so a heart silently vanished on every reload and hearting again toggled it off. */
export function listPosts(params?: { kind?: NbKind; sort?: "new" | "top"; cursor?: number; following?: 1; calm_min?: number }) {
  return get<Page<FeedPostT> & { mine?: number[] }>("/posts", { ...(params || {}) } as Record<string, string | number>);
}
/** `media` are Library item ids (max 4). ANY member may attach ANY published item — provenance
 *  travels with it, so re-use is credited rather than prevented. */
export function createPost(body: string, nbId?: number, repostId?: number, media?: number[]) {
  return post<FeedPostT>("/posts", {
    body,
    ...(nbId ? { nb_id: nbId } : {}),
    ...(repostId ? { repost_id: repostId } : {}),
    ...(media && media.length ? { media } : {}),
  });
}
export function heartPost(id: number, val: 0 | 1) {
  return post<{ ok: boolean; hearts: number; mine: number }>(`/posts/${id}/heart`, { val });
}

// Owner controls: every post and reply is editable + deletable by its author (notebooks already
// have save/delete in the Studio).
export function editPost(id: number, body: string) {
  return post<FeedPostT>(`/posts/${id}/edit`, { body });
}
export function deletePost(id: number) {
  return post<{ ok: boolean }>(`/posts/${id}/delete`, {});
}
export function editComment(nbId: number, cid: number, body: string) {
  return post<{ ok: boolean; body: string }>(`/notebooks/${nbId}/comments/${cid}/edit`, { body });
}
export function deleteComment(nbId: number, cid: number) {
  return post<{ ok: boolean }>(`/notebooks/${nbId}/comments/${cid}/delete`, {});
}

// ── The feed's right rail (X-style): What's happening + Trending papers + Who to follow ────
// The research rail REPLACED the price-of-energy card 2026-07-22 (operator). GET /market/prices
// still exists server-side — the notebook relay serves that payload to every notebook as
// data/market-prices.json — but nothing in the SPA reads it any more, so it has no client here.

/** One trending paper: open-access with a REAL (liveness-checked) PDF, published in the last
 *  `days`, ranked by CITATION VELOCITY — `rate` = citations ÷ days since publication, computed
 *  server-side at assembly so it stays honest as the pool ages. All fields, every publisher/
 *  repository/preprint server — OpenAlex, the open scholarly graph (Google Scholar has no API
 *  and forbids scraping). */
export type TrendingPaper = {
  title: string; author: string; others: number; cites: number; rate: number; date: string;
  topic: string; field: string; venue: string; pdf: string; doi: string;
  /** AI summary of the paper (operator 2026-07-23: shown instead of a PDF link / thumbnail). */
  summary?: string;
};
/** One trending topic: an OpenAlex topic (~4.5k concepts) with its parent field, the summed
 *  citation velocity + totals of its recent papers, and its top 3 — at least 2 papers, so no
 *  single anomalous record can mint a trend. */
export type TrendingTopic = {
  name: string; field: string; cites: number; papers: number; rate: number;
  top: { title: string; cites: number; summary?: string }[];
};
/** One trending item from a kind's home marketplace (Trending now card). Which metric fields are
 *  set depends on the source: HN → points/comments · HF → score/downloads/likes · Sketchfab →
 *  likes/views · Civitai → reactions · itch/GIPHY → rank. */
export type TrendingKindItem = {
  title: string; by: string; url: string; ts?: number;
  /** The AI-written one-sentence summary of the item (operator 2026-07-23: "only AI summary of the
   *  contents" — no external pics, no outbound links). Empty until the crawl relay has summarised it. */
  summary?: string;
  /** OUR measured rate (Δcounter ÷ Δtime from hourly sampling), in the kind's `window` unit. */
  rate?: number;
  points?: number; comments?: number; score?: number; downloads?: number; likes?: number;
  views?: number; reactions?: number; rank?: number; posts?: number;
};
/** One platform kind + its marketplace's current trending items, SELECTED AND ORDERED by our own
 *  sampled rate (operator 2026-07-23) — `window` is the rate's unit: hour (news) · day (media,
 *  models, games) · month (papers, on their own cards). */
export type TrendingKind = { kind: string; label: string; source: string; window?: string; items: TrendingKindItem[] };
export type ScholarTrending = { updated: number; days: number; papers: TrendingPaper[]; topics: TrendingTopic[]; kinds?: TrendingKind[] };
export function scholarTrending() {
  return get<ScholarTrending>("/scholar/trending");
}
/** Educational-social crawl (operator 2026-07-23): trending EDUCATIONAL content from Reddit
 *  (discussions), YouTube (videos) and Instagram (posts), each rate-sampled and AI-summarised —
 *  no external pics, no outbound links. Same TrendingKind shape as the marketplace kinds. */
export type SocialTrending = { kinds: TrendingKind[]; ts: number };
export function socialTrending() {
  return get<SocialTrending>("/social/trending");
}
/** Daily commodity price in ArtaCoin (operator 2026-07-24): oil/gas/coal/wheat/maize over the last
 *  `days`, each day's USD close converted to ₳ (1 ₳ = 1 mg gold) via that day's gold price. */
export type Commodity = {
  key: string; label: string; unit: string; acoin: number;
  /** % change over the window — null when the row is a held-flat monthly price (its move would be
   *  pure gold-denominator, not a commodity price move). */
  pct: number | null;
  monthly?: boolean;
  /** The exact contract/source priced, e.g. "CLU26.NYM" or "World Bank monthly". */
  note?: string;
  series: number[]; dates: string[];
};
export type Commodities = { updated: number; days: number; points?: number; items: Commodity[] };
export function commodities() {
  return get<Commodities>("/commodities");
}
/** A "Who to follow" suggestion: top notebook authors by hearts. Unpersonalised on the server
 *  (CDN-cacheable); the client drops the viewer + already-followed ids (Social.feed's `followed`). */
export type FollowSuggestion = {
  id: number; name: string; slug: string; avatar: string; country: string; verified: boolean;
  hearts: number; works: number; followers: number;
};
export function suggestFollow() {
  return get<{ items: FollowSuggestion[] }>("/suggest/follow");
}

/** The in-browser runner — our own notebook editor (tools/lite-run.html, Pyodide worker kernel):
 *  opens the post's exact .ipynb client-side — no server, no account. Colab stays as the
 *  external option beside it. */
export function liteRunUrl(id: number, slug = "notebook") {
  // Drafts serve without auth (the whole DB is public by design), so run links never go stale.
  const raw = `/wp-json/aq/v1/notebooks/${id}/file/${(slug || "notebook").slice(0, 60)}.ipynb`;
  return `/wp-content/lite/run.html?src=${encodeURIComponent(raw)}`;
}

// ── ArtaCloud: the member's OPTIONAL public media shelf (plugin: src/Media.php) ─────────────
//
// The DEFAULT for My Library is the browser — files stay on the device and never touch a server
// (lib/media-store.ts). These calls are the opt-in: putting a file here PUBLISHES it, because every
// writable path on this host is world-fetchable. The UI says so before anything is sent.

export type CloudItem = {
  id: number; kind: "music" | "video" | "doc"; title: string; name: string;
  artist: string; album: string; bytes: number; duration: number; created: number;
  url: string; sha256: string;
};
export type CloudQuota = {
  used: number; capacity: number; free: number; free_grant: number;
  bytes_per_coin: number; balance: number; file_max: number; cdn: boolean;
};

export const cloudList = () => get<{ items: CloudItem[]; quota: CloudQuota }>("/media");
export const cloudQuota = () => get<CloudQuota>("/media/quota");
export const cloudBuy = (coins: number) =>
  post<{ ok: true; bytes: number; capacity: number; balance: number }>("/media/buy", { coins });
export const cloudDelete = (id: number) =>
  del<{ ok: true; quota: CloudQuota }>(`/media/${id}`);
export const cloudOf = (slug: string) => get<{ items: CloudItem[] }>(`/media/of/${encodeURIComponent(slug)}`);

/** Upload one file to the member's cloud shelf, in resumable chunks.
 *  Sequential by design (the server's committed byte count IS the cursor), so a dropped connection
 *  resumes from exactly what arrived rather than starting over. `onProgress` gets 0..1. */
export async function cloudUpload(
  file: File,
  meta: { title?: string; artist?: string; album?: string; duration?: number } = {},
  onProgress?: (frac: number) => void,
  signal?: AbortSignal,
): Promise<CloudItem> {
  const begun = await post<{ id: number; chunk_max: number }>("/media/begin", { name: file.name, bytes: file.size });
  const size = Math.max(1, begun.chunk_max);
  let sent = 0;
  while (sent < file.size) {
    if (signal?.aborted) throw new Error("cancelled");
    const end = Math.min(sent + size, file.size);
    const r = await send(
      `${BASE}/media/${begun.id}/part?offset=${sent}`,
      { method: "POST", body: file.slice(sent, end), signal },
      { "Content-Type": "application/octet-stream" },
    );
    const j = (await r.json().catch(() => ({}))) as { received?: number; message?: string };
    if (!r.ok) {
      // The server tells us where it actually is; trust that over our own count and resume there.
      if (r.status === 409 && typeof j.received === "number") { sent = j.received; continue; }
      throw new ApiError("/media/part", r.status, j.message);
    }
    sent = typeof j.received === "number" ? j.received : end;
    onProgress?.(sent / file.size);
  }
  return post<CloudItem>(`/media/${begun.id}/commit`, meta as Json);
}
