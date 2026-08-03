/**
 * The Download Center engine: turns the server's self-contained bundles into durable, offline-ready
 * local data. Everything the platform serves is selectively downloadable — courses (structure +
 * boards + transcripts, optionally the video at a chosen quality + captions in a chosen language),
 * website language packs, and the entire public database. Online-only acts (posting, voting,
 * competing) are intentionally NOT replicated.
 *
 * Stored via lib/offline/idb.ts; served back transparently by lib/offline/fetch.ts (data layer) and
 * the service worker (app shell + assets + images).
 */
import { idb, STORES, storageEstimate } from "./idb";
import { canonicalQuery } from "./fetch";
import { seedTranslations } from "../i18n";

const AQ = "/wp-json/aq/v1";
const IMG_CACHE = "aq-img-v4"; // MUST match IMG in public/sw.js — the worker serves images from it
const APP_BASE = "/wp-content/themes/artaquest-theme/app/";
const APP_PRECACHE_URL = APP_BASE + "aq-precache.json";

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${AQ}${path}`, { credentials: "include" });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

// ── App files (full self-sufficiency) ────────────────────────────────────────
// Precache the ENTIRE built app — every route chunk, CSS, font, the world-map data — into Cache
// Storage, so ArtaQuest runs every page offline with no network and no external dependency. The
// service worker then serves these via caches.match. The app shell ('/') is precached too.
type AppManifest = { build: string; bytes: number; count: number; files: string[] };
let appManifestCache: AppManifest | null = null;
async function appManifest(): Promise<AppManifest> {
  if (appManifestCache) return appManifestCache;
  // Fetch directly (not via getJSON, which prepends the /aq/v1 base) — this is a theme-path file.
  // `no-cache` forces HTTP revalidation (the service worker additionally serves this file
  // network-first): a STALE manifest pins the previous build after a deploy, reporting the app
  // precache "complete" while the new build's route chunks were never downloaded — offline
  // navigation then fails on the missing chunk (ticket #26).
  const r = await fetch(APP_PRECACHE_URL, { credentials: "include", cache: "no-cache" });
  if (!r.ok) throw new Error(`precache manifest → ${r.status}`);
  appManifestCache = (await r.json()) as AppManifest;
  return appManifestCache;
}
const appCacheName = (build: string) => `aq-app-${build}`;

/** True size + how-many-cached for the current build, so the UI can show "App ready / X MB". */
export async function appFilesStatus(): Promise<{ build: string; total: number; have: number; bytes: number; complete: boolean }> {
  try {
    const m = await appManifest();
    const c = await caches.open(appCacheName(m.build));
    const have = (await c.keys()).length;
    return { build: m.build, total: m.count, have, bytes: m.bytes, complete: have >= m.count };
  } catch {
    return { build: "", total: 0, have: 0, bytes: 0, complete: false };
  }
}

/** Precache the whole app (idempotent). Reports progress; drops stale builds' caches. */
export async function downloadAppFiles(onProgress?: OnProgress): Promise<void> {
  const m = await appManifest();
  const cacheName = appCacheName(m.build);
  const c = await caches.open(cacheName);
  // Cache the app shell ('/') so a cold offline launch boots the SPA.
  try { const r = await fetch("/", { credentials: "include" }); if (r.ok) await c.put("/", r.clone()); } catch { /* offline */ }
  const already = new Set((await c.keys()).map((r) => new URL(r.url).pathname));
  let done = 0;
  for (const url of m.files) {
    if (!already.has(url)) {
      try { const r = await fetch(url, { cache: "reload" }); if (r.ok) await c.put(url, r.clone()); } catch { /* keep going; a missing chunk just won't be offline */ }
    }
    onProgress?.({ phase: "App files", done: ++done, total: m.files.length, bytes: m.bytes });
  }
  // Drop older app caches to reclaim space.
  for (const k of await caches.keys()) { if (k.startsWith("aq-app-") && k !== cacheName) await caches.delete(k); }
}

export async function removeAppFiles(): Promise<void> {
  for (const k of await caches.keys()) { if (k.startsWith("aq-app-")) await caches.delete(k); }
}

// ── Catalogue ────────────────────────────────────────────────────────────────
// The course catalogue is NOT in the manifest (it scales to millions) — it's discovered through the
// keyset-paginated /courses endpoint (lib/wp getCourseCards). The manifest carries only small facets.
export type OfflineLang = { code: string; name: string; native: string; rtl: boolean; strings: number };
export type OfflineTable = { name: string; label: string; rows: number };
export type Manifest = {
  v: number; site: string; course_count: number; languages: OfflineLang[]; tables: OfflineTable[]; note: string;
};

let manifestCache: Manifest | null = null;
export async function getManifest(force = false): Promise<Manifest> {
  if (manifestCache && !force) return manifestCache;
  manifestCache = await getJSON<Manifest>("/offline/manifest");
  return manifestCache;
}

// ── What's stored locally ──────────────────────────────────────────────────────
export type SavedCourse = {
  id: number; slug: string; title: string; image: string; lessons: number;
  video: boolean; videoLabel: string; capLang: string; bytes: number; at: number;
  // Best-effort video outcome: how many of this course's YouTube videos were actually saved as a
  // playable blob (videosSaved) out of how many were attempted (videosTotal). The rest stream online
  // only (ciphered / no progressive format) and stay covered by their transcript. 0/0 ⇒ text-only.
  videosSaved: number; videosTotal: number;
  // Every response key this bundle wrote, so removal deletes exactly what the download stored
  // (the bundle's contents — e.g. which discussion threads it carried — change over time).
  pathKeys?: string[];
};
export type SavedLang = { lang: string; native: string; count: number; at: number };
export type SavedDb = { tables: number; rows: number; at: number };

export const downloaded = {
  courses: () => idb.all<SavedCourse>(STORES.courses),
  course: (id: number) => idb.get<SavedCourse>(STORES.courses, id),
  langs: () => idb.all<SavedLang>(STORES.langpacks),
  db: () => idb.get<SavedDb>(STORES.meta, "db"),
};

export type Quality = "none" | "144p" | "360p" | "480p" | "720p" | "best";
const Q_HEIGHT: Record<Exclude<Quality, "none" | "best">, number> = { "144p": 144, "360p": 360, "480p": 480, "720p": 720 };
type MediaQuality = { itag: number; label: string; height: number; mime: string; bytes: number };

export type Progress = { phase: string; done: number; total: number; bytes: number };
type OnProgress = (p: Progress) => void;

type CourseBundle = {
  id: number; slug: string; title: string; image: string; lessons: number;
  paths: Record<string, unknown>;
  videos: { lesson_id: number; idx: number; title: string; vid: string; provider: string; seg_start: number; seg_end: number; transcript: string }[];
};

// ── Download a course ──────────────────────────────────────────────────────────
export async function downloadCourse(
  courseId: number,
  opts: { quality: Quality; capLang: string },
  onProgress?: OnProgress,
): Promise<SavedCourse> {
  const bundle = await getJSON<CourseBundle>(`/offline/course/${courseId}`);
  let bytes = 0;
  const report = (phase: string, done: number, total: number) => onProgress?.({ phase, done, total, bytes });

  // Unified progress: the structured-data writes, plus (optionally) one step per video.
  // Keys are re-canonicalized (sorted query params) so they always match what lib/offline/fetch
  // derives from a request URL, however the server happened to order them.
  const entries = Object.entries(bundle.paths || {}).map(([p, j]) => [canonicalKey(p), j] as const);
  const vidCount = opts.quality !== "none" ? (bundle.videos || []).filter((v) => v.vid && v.provider === "youtube").length : 0;
  const totalSteps = entries.length + vidCount;
  let step = 0;
  report("Saving content", 0, totalSteps);

  // 1) Structured data: every endpoint the SPA needs to render this course offline.
  for (const [path, json] of entries) {
    await idb.put(STORES.responses, path, json);
    bytes += JSON.stringify(json).length;
    report("Saving content", ++step, totalSteps);
  }
  // 2) Transcripts (always — they're tiny and make the lesson fully readable offline).
  for (const v of bundle.videos || []) {
    if (v.transcript) { await idb.put(STORES.transcripts, v.lesson_id, v.transcript); bytes += v.transcript.length; }
  }
  // 3) Warm the course thumbnail so the card shows offline. Load it as an <img> (img-src — CSP-safe;
  //    a cache.add() fetch would hit connect-src and be blocked) and let the SW's image handler cache it.
  if (bundle.image) {
    try { await new Promise<void>((res) => { const im = new Image(); im.onload = () => res(); im.onerror = () => res(); im.src = bundle.image; setTimeout(res, 4000); }); } catch { /* ignore */ }
  }

  // 4) Video media + captions (optional, opt-in; best-effort per video). The same-origin /offline/media
  //    stream proxy lets the browser fetch + store the bytes on ANY device (phone, tablet, computer) —
  //    no terminal, no app. Videos YouTube only ciphers / serves DASH-only can't be saved in-browser;
  //    those stay covered by their transcript, and the computer helper (yt-dlp) can grab every one.
  let videoLabel = "";
  let videosSaved = 0;
  let videosTotal = 0;
  if (opts.quality !== "none") {
    const vids = (bundle.videos || []).filter((v) => v.vid && v.provider === "youtube");
    videosTotal = vids.length;
    for (let i = 0; i < vids.length; i++) {
      const v = vids[i];
      report("Saving videos", step, totalSteps);
      try {
        // Cache-busted (a CDN copy of a throttle-window "no qualities" answer would otherwise poison
        // downloads for minutes) + one retry: YouTube resolution from the server is transiently flaky.
        let media = await getJSON<{ qualities: MediaQuality[]; captions: { lang: string; name: string }[] }>(`/offline/media/${v.lesson_id}?nc=${Date.now()}`);
        if (!media.qualities.length) {
          await new Promise((r) => setTimeout(r, 2500));
          media = await getJSON<{ qualities: MediaQuality[]; captions: { lang: string; name: string }[] }>(`/offline/media/${v.lesson_id}?nc=${Date.now()}`);
        }
        // Try the chosen quality, then degrade through progressively smaller ones, so a long video saves
        // at the best quality it actually can — instead of silently collapsing to 144p (or to online-only).
        // Each candidate is fetched in ranged chunks (downloadMediaBlob), which is what lets proper-quality,
        // hour-long videos save on a phone rather than only the tiny single-request 144p file.
        for (const pick of qualityCandidates(media.qualities, opts.quality)) {
          const dl = await downloadMediaParts(v.lesson_id, pick.itag);
          if (dl && dl.bytes) {
            // Store as ArrayBuffer chunks, NOT a Blob: Safari/WebKit can silently lose an IDB Blob's
            // backing file across sessions (the row + .size survive, the bytes don't) — the saved video
            // then sits at 0:00 forever. ArrayBuffers are stored inline and survive. getMediaBlobURL
            // rebuilds the playable Blob at read time (and still accepts old Blob rows).
            const key = `${v.lesson_id}:${pick.itag}`;
            await idb.put(STORES.media, key, { parts: dl.parts, bytes: dl.bytes });
            // Verify the write actually landed readable before counting it as saved.
            const back = await idb.get<{ parts: ArrayBuffer[]; bytes: number }>(STORES.media, key);
            const backBytes = back?.parts ? back.parts.reduce((n, p) => n + p.byteLength, 0) : 0;
            if (backBytes !== dl.bytes) { await idb.del(STORES.media, key); continue; }
            await idb.put(STORES.mediaMeta, v.lesson_id, { itag: pick.itag, label: pick.label, bytes: dl.bytes, mime: pick.mime || "video/mp4" });
            bytes += dl.bytes;
            videoLabel = pick.label;
            videosSaved++;
            break;
          }
        }
        // Captions in the chosen caption language (native track if present, else auto-translate).
        if (opts.capLang) {
          const native = media.captions.find((c) => c.lang.toLowerCase().split("-")[0] === opts.capLang);
          const tlang = native ? "" : (media.captions.length ? opts.capLang : "");
          if (native || tlang) {
            try {
              const cr = await fetch(`${AQ}/offline/captions/${v.lesson_id}?lang=${encodeURIComponent(native ? native.lang : (media.captions[0]?.lang || opts.capLang))}${tlang ? `&tlang=${encodeURIComponent(tlang)}` : ""}`, { credentials: "include" });
              if (cr.ok) { const vtt = await cr.text(); await idb.put(STORES.captions, `${v.lesson_id}:${opts.capLang}`, vtt); bytes += vtt.length; }
            } catch { /* captions optional */ }
          }
        }
      } catch { /* this video isn't downloadable in-browser — keep going; the yt-dlp pack covers it */ }
      report("Saving videos", ++step, totalSteps);
    }
  }
  report("Done", totalSteps, totalSteps);

  const saved: SavedCourse = {
    id: bundle.id, slug: bundle.slug, title: bundle.title, image: bundle.image, lessons: bundle.lessons,
    video: videosSaved > 0, videoLabel, capLang: opts.capLang, bytes, at: Date.now(),
    videosSaved, videosTotal,
    pathKeys: entries.map(([p]) => p),
  };
  await idb.put(STORES.courses, bundle.id, saved);
  await rebuildOfflineCatalogue();
  return saved;
}

/** Canonical response-store key for a bundle path: bare path, or path?sorted-query. */
function canonicalKey(path: string): string {
  const q = path.indexOf("?");
  if (q === -1) return path.replace(/\/+$/, "");
  const base = path.slice(0, q).replace(/\/+$/, "");
  const canon = canonicalQuery(new URLSearchParams(path.slice(q + 1)));
  return canon ? `${base}?${canon}` : base;
}

/** Rebuild the synthetic offline course catalogue — the bare `courses` response — from whatever is
 *  downloaded right now. Offline, this is what the /courses page AND the /discussions course-board
 *  browser render, so a saved course stays reachable by normal browsing (online, the network response
 *  always wins; this copy only serves as the offline/fallback view). Card fields come from the stored
 *  course-detail response (same shape, richer), with the bundle's own metadata as the floor. */
async function rebuildOfflineCatalogue(): Promise<void> {
  const saved = await idb.all<SavedCourse>(STORES.courses);
  if (!saved.length) { await idb.del(STORES.responses, "courses"); return; }
  const items: Record<string, unknown>[] = [];
  for (const s of [...saved].sort((a, b) => b.at - a.at)) {
    const d = (await idb.get<Record<string, unknown>>(STORES.responses, `courses/${s.id}`)) || {};
    items.push({
      id: s.id, slug: s.slug, title: s.title, image: s.image,
      channel: typeof d.channel === "string" ? d.channel : "",
      lessons: s.lessons, // the detail response's `lessons` is the array — the card wants the count
      duration: typeof d.duration === "number" ? d.duration : 0,
      price: typeof d.price === "number" ? d.price : 0,
      comments_per_day: typeof d.comments_per_day === "number" ? d.comments_per_day : 0,
      comments_total: typeof d.comments_total === "number" ? d.comments_total : 0,
      topic: typeof d.topic === "string" ? d.topic : "",
      topic_label: typeof d.topic_label === "string" ? d.topic_label : "",
    });
  }
  await idb.put(STORES.responses, "courses", { items, next: null });
}

/** Ordered list of formats to attempt for a video: the chosen quality first, then progressively
 *  smaller ones as graceful fallbacks (never larger than asked). The first entry is exactly the old
 *  single pick, so a video that downloads on the first try behaves as before; the rest only matter
 *  when a larger file can't be fetched, ensuring we never silently drop to nothing. */
function qualityCandidates(qualities: MediaQuality[], want: Quality): MediaQuality[] {
  if (!qualities.length || want === "none") return [];
  const sorted = [...qualities].sort((a, b) => a.height - b.height); // ascending by height
  let chosen: MediaQuality;
  if (want === "best") {
    chosen = sorted[sorted.length - 1];
  } else {
    const target = Q_HEIGHT[want];
    // Highest quality at or below the target; else the smallest available.
    const atOrBelow = sorted.filter((q) => q.height <= target);
    chosen = atOrBelow.length ? atOrBelow[atOrBelow.length - 1] : sorted[0];
  }
  const idx = sorted.indexOf(chosen);
  const out: MediaQuality[] = [];
  for (let i = idx; i >= 0; i--) out.push(sorted[i]); // chosen, then smaller and smaller
  return out;
}

// Progressive media files are large — an hour-long lecture at 360p is hundreds of MB — and pulling
// one in a single request risks a gateway/proxy timeout, which is why such videos used to save only
// as the tiny 144p file (or not at all). Fetch them from the same-origin proxy in modest RANGE chunks
// (the proxy forwards the Range header to YouTube and answers with 206s) and reassemble into one Blob,
// so even long videos download reliably on mobile at the quality the learner actually chose.
const MEDIA_CHUNK = 12 * 1024 * 1024; // 12 MB per ranged request — well under any reasonable timeout

/** The downloaded video as ArrayBuffer chunks (the IDB-durable form — see the save site). */
type MediaParts = { parts: ArrayBuffer[]; bytes: number };

async function downloadMediaParts(lessonId: number, itag: number): Promise<MediaParts | null> {
  const url = `${AQ}/offline/media/${lessonId}/stream?itag=${itag}`;
  const range = (from: number): Record<string, string> => ({ Range: `bytes=${from}-${from + MEDIA_CHUNK - 1}` });
  const parts: ArrayBuffer[] = [];
  let bytes = 0;
  const push = async (b: Blob) => { const buf = await b.arrayBuffer(); parts.push(buf); bytes += buf.byteLength; };
  let start = 0;
  let total = 0;
  for (let guard = 0; guard < 4000; guard++) {
    let r: Response;
    try {
      r = await fetch(url, { credentials: "include", headers: range(start) });
    } catch {
      try { r = await fetch(url, { credentials: "include", headers: range(start) }); } // one retry on a blip
      catch { return null; }
    }
    if (r.status === 200) {
      // Range wasn't honoured — the whole file came back at once. Use it directly.
      const b = await r.blob();
      if (!b.size) return null;
      await push(b);
      return { parts, bytes };
    }
    if (r.status !== 206) {
      if (r.status === 416 && parts.length) break; // asked past EOF: we already have everything
      return null; // a real mid-stream failure — don't store a truncated, unplayable file
    }
    const cr = r.headers.get("Content-Range") || ""; // e.g. "bytes 0-12582911/734003200"
    const blob = await r.blob();
    if (blob.size) await push(blob);
    const m = /bytes\s+\d+-(\d+)\/(\d+|\*)/i.exec(cr);
    if (m) {
      if (m[2] !== "*") total = parseInt(m[2], 10);
      start = parseInt(m[1], 10) + 1; // continue right after the bytes we actually received
    } else {
      start += blob.size || MEDIA_CHUNK;
    }
    if (!blob.size) break;
    if (total && start >= total) break;
    if (!total && blob.size < MEDIA_CHUNK) break; // short read, no range info ⇒ assume complete
  }
  return parts.length ? { parts, bytes } : null;
}

// ── One-click video downloader (server-generated) ──────────────────────────────
// In-browser download (above) gets MOST videos on any device. For the remainder — videos YouTube only
// ciphers or serves DASH-only, which a browser can't reassemble — this optional computer helper grabs
// every one (yt-dlp deciphers). The per-OS downloader SCRIPT is generated server-side
// (GET /offline/downloader) — offered as a Windows .cmd file or a Gatekeeper-safe
// `bash -c "$(curl ...)"` one-liner for Mac/Linux. This type is shared with the page.
export type DownloaderOS = "windows" | "mac" | "linux";

export async function removeCourse(courseId: number): Promise<void> {
  const saved = await idb.get<SavedCourse>(STORES.courses, courseId);
  // Remove this course's endpoint responses, media, captions, transcripts.
  const lessonIds = await courseLessonIds(courseId, saved);
  for (const lid of lessonIds) {
    await idb.del(STORES.transcripts, lid);
    const meta = await idb.get<{ itag: number }>(STORES.mediaMeta, lid);
    if (meta) await idb.del(STORES.media, `${lid}:${meta.itag}`);
    await idb.del(STORES.mediaMeta, lid);
    if (saved?.capLang) await idb.del(STORES.captions, `${lid}:${saved.capLang}`);
    await idb.del(STORES.responses, `lessons/${lid}`);
    await idb.del(STORES.responses, `sections/${lid}/thread`);
  }
  // Newer downloads record every key their bundle wrote (incl. discussion threads + video stats);
  // delete those exactly. The per-lesson/per-course deletes above remain for older saves.
  for (const key of saved?.pathKeys || []) await idb.del(STORES.responses, key);
  if (saved) {
    await idb.del(STORES.responses, `courses/${courseId}`);
    await idb.del(STORES.responses, `courses/${courseId}/reviews`);
    await idb.del(STORES.responses, `courses/${courseId}/rankings`);
    await idb.del(STORES.responses, `courses/${courseId}/stats`);
    await idb.del(STORES.responses, `courses/slug/${saved.slug}`);
  }
  await idb.del(STORES.courses, courseId);
  await rebuildOfflineCatalogue();
}

/** Resolve a downloaded course's lesson ids from its stored detail response. */
async function courseLessonIds(courseId: number, saved?: SavedCourse): Promise<number[]> {
  void saved;
  const detail = await idb.get<{ lessons?: { id: number }[] }>(STORES.responses, `courses/${courseId}`);
  return (detail?.lessons || []).map((l) => l.id);
}

// ── Language packs ─────────────────────────────────────────────────────────────
export async function downloadLangPack(lang: string, native: string, onProgress?: OnProgress): Promise<SavedLang> {
  let cursor = 0;
  let count = 0;
  let epoch: number | undefined;
  const all: Record<string, string> = {};
  for (let guard = 0; guard < 200; guard++) {
    const page = await getJSON<{ items: Record<string, string>; next: number | null; epoch?: number }>(`/offline/langpack/${lang}?cursor=${cursor}`);
    if (typeof page.epoch === "number") epoch = page.epoch;
    const items = page.items || {};
    for (const k in items) { all[k] = items[k]; count++; }
    onProgress?.({ phase: "Translations", done: count, total: count, bytes: 0 });
    if (page.next == null) break;
    cursor = page.next;
  }
  seedTranslations(lang, all, epoch); // merge into the live i18n engine + its localStorage cache
  // The pack marker exempts this language from the ArtaTranslate epoch drop — the localStorage dict
  // is the pack's only full copy, so it must survive upgrades (refresh = re-download in the Center).
  try { localStorage.setItem(`aq_i18n_${lang}_pack`, "1"); } catch { /* ignore */ }
  const saved: SavedLang = { lang, native, count, at: Date.now() };
  await idb.put(STORES.langpacks, lang, saved);
  return saved;
}

export async function removeLangPack(lang: string): Promise<void> {
  await idb.del(STORES.langpacks, lang);
  try {
    localStorage.removeItem(`aq_i18n_${lang}`);
    localStorage.removeItem(`aq_i18n_${lang}_epoch`);
    localStorage.removeItem(`aq_i18n_${lang}_pack`);
  } catch { /* ignore */ }
}

// ── Full public database snapshot ──────────────────────────────────────────────
export async function downloadDatabase(onProgress?: OnProgress): Promise<SavedDb> {
  const m = await getManifest();
  let totalRows = 0;
  let done = 0;
  for (const t of m.tables) {
    let cursor = 0;
    const columns: string[] = [];
    const rows: Record<string, unknown>[] = [];
    for (let guard = 0; guard < 1000; guard++) {
      const page = await getJSON<{ columns: string[]; rows: Record<string, unknown>[]; next: number | null }>(`/offline/db/${t.name}?cursor=${cursor}`);
      if (page.columns?.length && !columns.length) columns.push(...page.columns);
      rows.push(...(page.rows || []));
      if (page.next == null) break;
      cursor = page.next;
    }
    await idb.put(STORES.dbtables, t.name, { columns, rows });
    totalRows += rows.length;
    done++;
    onProgress?.({ phase: `Database (${t.label})`, done, total: m.tables.length, bytes: 0 });
  }
  const saved: SavedDb = { tables: m.tables.length, rows: totalRows, at: Date.now() };
  await idb.put(STORES.meta, "db", saved);
  return saved;
}

export async function removeDatabase(): Promise<void> {
  for (const key of await idb.keys(STORES.dbtables)) await idb.del(STORES.dbtables, key);
  await idb.del(STORES.meta, "db");
}

// ── Offline accessors used by the player ───────────────────────────────────────
export async function getMediaBlobURL(lessonId: number): Promise<{ url: string; mime: string } | null> {
  const meta = await idb.get<{ itag: number; mime: string }>(STORES.mediaMeta, lessonId);
  if (!meta) return null;
  const stored = await idb.get<Blob | MediaParts>(STORES.media, `${lessonId}:${meta.itag}`);
  if (!stored) return null;
  // New rows are ArrayBuffer chunks (IDB-durable on WebKit); old rows are a single Blob.
  const blob = stored instanceof Blob ? stored : new Blob(stored.parts || [], { type: meta.mime || "video/mp4" });
  if (!blob.size) return null;
  return { url: URL.createObjectURL(blob), mime: meta.mime || "video/mp4" };
}

/** Drop one lesson's saved video (used by the player's self-heal when a stored copy turns out to be
 *  unreadable — e.g. a Safari-evicted Blob — so the lesson falls back to streaming instead of 0:00). */
export async function dropMedia(lessonId: number): Promise<void> {
  const meta = await idb.get<{ itag: number }>(STORES.mediaMeta, lessonId);
  if (meta) await idb.del(STORES.media, `${lessonId}:${meta.itag}`);
  await idb.del(STORES.mediaMeta, lessonId);
}
export function getCaptionVTT(lessonId: number, lang: string): Promise<string | undefined> {
  return idb.get<string>(STORES.captions, `${lessonId}:${lang}`);
}
export function getTranscript(lessonId: number): Promise<string | undefined> {
  return idb.get<string>(STORES.transcripts, lessonId);
}

// ── Housekeeping ───────────────────────────────────────────────────────────────
export async function clearAll(): Promise<void> {
  for (const s of Object.values(STORES)) await idb.clear(s);
  try { await caches.delete(IMG_CACHE); } catch { /* ignore */ }
}

export { storageEstimate };
