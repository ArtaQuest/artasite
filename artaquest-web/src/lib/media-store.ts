// My Library media store — the member's OWN files (music, videos, documents), kept 100% ON DEVICE
// (operator, 2026-07-25): bytes, cover art and metadata all live in IndexedDB. Nothing ever uploads —
// the same privacy promise as ArtaRead — which also makes the library OFFLINE by construction: once
// imported it plays in a pocket with no connection.
//
// WHY IndexedDB AND NOT OPFS: `FileSystemFileHandle.createWritable()` is Safari/iOS **26+**, while
// `FileSystemFileHandle` itself is 15.2 — so on every pre-iOS-26 iPhone, getDirectory() →
// getDirectoryHandle() → getFileHandle({create:true}) ALL succeed and only the write is missing.
// There is no honest feature-detect short of calling it, and the failure lands after we have already
// told the member we are importing. IndexedDB Blob storage is universal (iOS 15 / Chrome 24 / Firefox),
// is the pattern this repo already uses for downloaded video (src/lib/offline/idb.ts), and — decisively
// — lets the bytes, the cover and the metadata row be written in ONE transaction, so an import is
// ATOMIC. OPFS bytes + IDB metadata cannot be, which is exactly what strands multi-GB orphans.

export type MediaKind = "music" | "video" | "doc";
export type MediaItem = {
  id: string;
  kind: MediaKind;
  name: string;           // original file name (fallback title)
  title: string;
  artist?: string;
  album?: string;
  mime: string;
  size: number;
  duration?: number;      // seconds, probed at import for music/video
  added: number;          // epoch ms
  hasCover: boolean;
  plays: number;
  lastPlayed?: number;
};
export type ImportFailure = { name: string; reason: string };
export type ImportResult = { added: MediaItem[]; failed: ImportFailure[] };

const DB_NAME = "aq-library";
const DB_VER = 2;   // v2 adds `progress` (resume) + `playlists`
const META = "items";
const COVERS = "covers";
const BLOBS = "blobs";
const PROGRESS = "progress";
const PLAYLISTS = "playlists";

let dbP: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbP) {
    dbP = new Promise<IDBDatabase>((res, rej) => {
      let req: IDBOpenDBRequest;
      try { req = indexedDB.open(DB_NAME, DB_VER); }
      catch (e) { rej(e); return; }             // Firefox private mode throws synchronously
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of [META, COVERS, BLOBS, PROGRESS, PLAYLISTS]) {
          if (!d.objectStoreNames.contains(s)) {
            d.createObjectStore(s, s === META || s === PROGRESS || s === PLAYLISTS ? { keyPath: "id" } : undefined);
          }
        }
      };
      req.onsuccess = () => {
        const d = req.result;
        // Another tab opened a newer version: close so it isn't blocked, and force a fresh open next call.
        d.onversionchange = () => { d.close(); dbP = null; };
        res(d);
      };
      req.onerror = () => rej(req.error);
      req.onblocked = () => rej(new Error("Your library is open in another tab — close it and try again."));
    }).catch((e) => { dbP = null; throw e; }); // never cache a rejection for the page's lifetime
  }
  return dbP;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((res, rej) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    r.onsuccess = () => res(r.result as T);
    r.onerror = () => rej(r.error);
    t.onabort = () => rej(t.error || new Error("aborted"));
  }));
}

/** Ask the browser to make this origin's storage durable (not evictable under pressure). */
export async function requestPersistence(): Promise<boolean> {
  try { return (await navigator.storage.persisted()) || (await navigator.storage.persist()); } catch { return false; }
}
export async function isPersisted(): Promise<boolean> {
  try { return await navigator.storage.persisted(); } catch { return false; }
}
export async function storageEstimate(): Promise<{ used: number; quota: number }> {
  try { const e = await navigator.storage.estimate(); return { used: e.usage || 0, quota: e.quota || 0 }; }
  catch { return { used: 0, quota: 0 }; }
}

export function kindOf(file: File): MediaKind | null {
  const mime = file.type || "";
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (mime.startsWith("audio/") || ["mp3", "m4a", "aac", "ogg", "oga", "flac", "wav", "opus"].includes(ext)) return "music";
  if (mime.startsWith("video/") || ["mp4", "m4v", "webm", "mov"].includes(ext)) return "video";
  if (mime === "application/pdf" || ext === "pdf") return "doc";
  return null;
}

// ── tags ─────────────────────────────────────────────────────────────────────────────────────────
// Minimal ID3v2 (TIT2/TPE1/TALB + APIC) and ID3v1. Every parser is wrapped by the caller: a malformed
// tag must degrade to "filename as title", never fail the import.

function id3v2(buf: ArrayBuffer): { title?: string; artist?: string; album?: string; cover?: Blob } {
  const u8 = new Uint8Array(buf);
  if (u8.length < 10 || u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return {};
  const ver = u8[3];
  const size = ((u8[6] & 0x7f) << 21) | ((u8[7] & 0x7f) << 14) | ((u8[8] & 0x7f) << 7) | (u8[9] & 0x7f);
  const end = Math.min(10 + size, u8.length);
  const out: { title?: string; artist?: string; album?: string; cover?: Blob } = {};
  const dec = (bytes: Uint8Array, enc: number): string => {
    try {
      const label = enc === 0 ? "latin1" : enc === 1 ? "utf-16" : enc === 2 ? "utf-16be" : "utf-8";
      return new TextDecoder(label).decode(bytes);
    } catch { return ""; }
  };
  let o = 10;
  if (u8[5] & 0x40) { // extended header — skip it
    const ex = ((u8[10] & 0x7f) << 21) | ((u8[11] & 0x7f) << 14) | ((u8[12] & 0x7f) << 7) | (u8[13] & 0x7f);
    o += Math.max(0, ex);
  }
  while (o + 10 <= end) {
    const id = String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsize = ver === 4
      ? ((u8[o + 4] & 0x7f) << 21) | ((u8[o + 5] & 0x7f) << 14) | ((u8[o + 6] & 0x7f) << 7) | (u8[o + 7] & 0x7f)
      : (u8[o + 4] << 24) | (u8[o + 5] << 16) | (u8[o + 6] << 8) | u8[o + 7];
    if (fsize <= 0 || o + 10 + fsize > end) break;
    const body = u8.subarray(o + 10, o + 10 + fsize);
    if (id === "TIT2" || id === "TPE1" || id === "TALB") {
      const text = dec(body.subarray(1), body[0]).replace(/\0+$/g, "").replace(/\0/g, " / ").trim();
      if (text) { if (id === "TIT2") out.title = text; else if (id === "TPE1") out.artist = text; else out.album = text; }
    } else if (id === "APIC" && !out.cover) {
      const enc = body[0];
      let p = 1;
      while (p < body.length && body[p] !== 0) p++;            // mime (always latin1)
      const mime = dec(body.subarray(1, p), 0) || "image/jpeg";
      p += 2;                                                   // NUL + picture type
      if (enc === 1 || enc === 2) { while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2; p += 2; }
      else { while (p < body.length && body[p] !== 0) p++; p += 1; }
      if (p < body.length) out.cover = new Blob([body.subarray(p)], { type: mime });
    }
    o += 10 + fsize;
    if (out.title && out.artist && out.album && out.cover) break;
  }
  return out;
}

function id3v1(buf: ArrayBuffer): { title?: string; artist?: string; album?: string } {
  if (buf.byteLength < 128) return {};
  const tag = new Uint8Array(buf, buf.byteLength - 128, 128);
  if (tag[0] !== 0x54 || tag[1] !== 0x41 || tag[2] !== 0x47) return {};
  const s = (from: number, len: number) => new TextDecoder("latin1").decode(tag.subarray(from, from + len)).replace(/\0.*$/, "").trim();
  return { title: s(3, 30) || undefined, artist: s(33, 30) || undefined, album: s(63, 30) || undefined };
}

/** Probe duration (and a poster frame for videos) with a temporary element that is ALWAYS torn down.
 *  `undecodable` is set when the engine rejects the bytes — a file named .mp3 that is not audio must
 *  fail the import rather than sit in the library as a tile that can never play. */
function probeMedia(file: File, kind: MediaKind): Promise<{ duration?: number; poster?: Blob; undecodable?: boolean }> {
  return new Promise((resolve) => {
    if (kind === "doc") return resolve({});
    const url = URL.createObjectURL(file);
    const el = document.createElement(kind === "video" ? "video" : "audio") as HTMLVideoElement;
    el.preload = "metadata";
    el.muted = true;
    let settled = false;
    const finish = (poster?: Blob, undecodable = false) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      const duration = isFinite(el.duration) && el.duration > 0 ? el.duration : undefined;
      el.onloadedmetadata = el.onseeked = el.onerror = null;
      try { el.pause(); } catch { /* not playing */ }
      el.removeAttribute("src");
      try { el.load(); } catch { /* teardown only */ }
      URL.revokeObjectURL(url);
      resolve({ duration, poster, undecodable: undecodable || !duration });
    };
    const timer = window.setTimeout(() => finish(), kind === "video" ? 6000 : 2500);
    el.onloadedmetadata = () => {
      if (kind !== "video") return finish();
      try { el.currentTime = Math.min(2, (el.duration || 2) / 3); } catch { finish(); }
    };
    el.onseeked = () => {
      try {
        const c = document.createElement("canvas");
        const w = el.videoWidth, h = el.videoHeight;
        if (!w || !h) return finish();
        const scale = Math.min(1, 480 / w);
        c.width = Math.max(1, Math.round(w * scale));
        c.height = Math.max(1, Math.round(h * scale));
        c.getContext("2d")!.drawImage(el, 0, 0, c.width, c.height);
        c.toBlob((b) => finish(b || undefined), "image/webp", 0.8);
      } catch { finish(); }
    };
    el.onerror = () => finish(undefined, true);
    el.src = url;
  });
}

/** Write one item ATOMICALLY: bytes + cover + metadata in a SINGLE transaction, so a failure can
 *  never leave orphaned megabytes behind. No `await` of a non-IDB promise inside — that would
 *  auto-close the transaction. */
function commit(item: MediaItem, bytes: Blob, cover?: Blob): Promise<void> {
  return db().then((d) => new Promise<void>((res, rej) => {
    const t = d.transaction([META, BLOBS, COVERS], "readwrite");
    t.oncomplete = () => res();
    t.onabort = () => rej(t.error || new Error("Could not save — your device may be out of space."));
    t.onerror = () => rej(t.error);
    t.objectStore(BLOBS).put(bytes, item.id);
    if (cover) t.objectStore(COVERS).put(cover, item.id);
    t.objectStore(META).put(item);
  }));
}

const humanReason = (e: unknown): string => {
  const err = e as { name?: string; message?: string } | null;
  if (err?.name === "QuotaExceededError") return "no room left on this device";
  if (/another tab/i.test(err?.message || "")) return err!.message!;
  return err?.message?.slice(0, 120) || "could not be read";
};

/** Import files into the library. Per-file fault isolation: one bad file never kills the batch. */
/**
 * DOWNLOAD A PUBLISHED LIBRARY FILE ONTO THIS DEVICE.
 *
 * The Library serves from a cross-origin CDN, so a track is streamable but not *yours* until it is
 * on the device: close the phone on a run and a streamed URL dies with the network. This fetches
 * the object once and hands it to importFiles() as a real File, which means it inherits every
 * guarantee the file-picker path already has — the honest quota pre-flight, the decode probe, ID3
 * tags, the cover, and a row in the same IndexedDB store the player reads. From there it behaves
 * exactly like a file the member imported themselves: it plays with the screen off, through the
 * lock-screen controls, with no network at all.
 *
 * `title`/`artist` come from the work, because a published file is named by its path
 * (`out/track.wav`) and the work's own title is what a listener would look for.
 *
 * IndexedDB, never OPFS — OPFS fails silently on iOS, which is the device this feature is for.
 */
export async function saveFromUrl(
  url: string,
  fileName: string,
  meta?: { title?: string; artist?: string; album?: string },
  onProgress?: (received: number, total: number) => void,
): Promise<ImportResult> {
  // ALREADY HERE? Every Save-offline button decides that once, on mount, from its own copy of the
  // list — so two buttons for the same file (a work page shows its hero AND lists it again) can
  // both still read "Save offline" when the first download finishes, and the second press stores a
  // second copy under a fresh random id. On a 300 MB video that is 600 MB of someone's phone and
  // two identical tiles. The check belongs HERE, where it covers every caller and costs nothing:
  // the name is `<libraryId>-<basename>`, so it identifies the Library item, not just the filename.
  try {
    const existing = (await listItems()).find((r) => r.name === fileName);
    if (existing) return { added: [existing], failed: [] };
  } catch { /* no device store on this browser — let the import fail with its own message */ }

  let blob: Blob;
  try {
    // No credentials: the CDN is a public bucket and sending cookies would fail the CORS check.
    const ctl = new AbortController();
    const r = await fetch(url, { credentials: "omit", mode: "cors", signal: ctl.signal });
    if (!r.ok) return { added: [], failed: [{ name: fileName, reason: `the file could not be downloaded (HTTP ${r.status})` }] };
    const total = Number(r.headers.get("content-length") || 0);
    // Check the quota from the HEADERS, before reading the body. importFiles pre-flights too, but by
    // then the bytes are already down — telling someone on mobile data that their 400 MB download
    // won't fit, after they have paid for it, is not a check. Aborting here costs only the headers.
    if (total > 0) {
      const { used, quota } = await storageEstimate();
      const free = Math.max(0, quota - used);
      if (quota > 0 && total > free) {
        ctl.abort();
        const mb = (n: number) => `${Math.max(1, Math.round(n / 1e6))} MB`;
        return { added: [], failed: [{ name: fileName, reason: `needs ${mb(total)} but only ${mb(free)} is free on this device` }] };
      }
    }
    if (r.body && onProgress && total > 0) {
      // Stream so a long download can show progress instead of looking frozen.
      const reader = r.body.getReader();
      const parts: BlobPart[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) { parts.push(value); got += value.byteLength; onProgress(got, total); }
      }
      blob = new Blob(parts, { type: r.headers.get("content-type") || "" });
    } else {
      blob = await r.blob();
    }
  } catch {
    // A CORS refusal and an offline device look identical here, and both mean the same thing to a
    // member standing in a lift.
    return { added: [], failed: [{ name: fileName, reason: "could not reach the file — check your connection and try again" }] };
  }
  const file = new File([blob], fileName, { type: blob.type || "application/octet-stream" });
  if (!kindOf(file)) {
    return { added: [], failed: [{ name: fileName, reason: "this kind of file cannot be played offline (music, video and PDF can)" }] };
  }
  const res = await importFiles([file]);
  // The work's title beats a path like `out/track.wav`, but never beats a real ID3 tag.
  if (res.added.length && meta) {
    const it = res.added[0];
    const patch: Partial<MediaItem> = {};
    if (meta.title && (it.title === file.name || it.title === file.name.replace(/\.[a-z0-9]+$/i, ""))) patch.title = meta.title;
    if (meta.artist && !it.artist) patch.artist = meta.artist;
    if (meta.album && !it.album) patch.album = meta.album;
    if (Object.keys(patch).length) { Object.assign(it, patch); await tx(META, "readwrite", (st) => st.put(it)); }
  }
  return res;
}

export async function importFiles(
  files: File[],
  onProgress?: (i: number, n: number, name: string) => void,
): Promise<ImportResult> {
  await requestPersistence();
  const added: MediaItem[] = [];
  const failed: ImportFailure[] = [];
  // A batch can import several files inside ONE millisecond; identical `added` values make the
  // list sort unstable (the grid and the click handler then disagree about which track is which).
  let stamp = Date.now();
  const nextStamp = () => (stamp = Math.max(stamp + 1, Date.now()));

  // Pre-flight the whole batch against the real quota so we refuse up front with honest numbers
  // instead of dying at file 47 of 60.
  const incoming = files.reduce((s, f) => s + f.size, 0);
  const { used, quota } = await storageEstimate();
  if (quota > 0 && incoming > Math.max(0, quota - used)) {
    const mb = (n: number) => `${Math.max(1, Math.round(n / 1e6))} MB`;
    return { added, failed: [{ name: `${files.length} file${files.length === 1 ? "" : "s"}`, reason: `needs ${mb(incoming)} but only ${mb(Math.max(0, quota - used))} is free on this device` }] };
  }

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onProgress?.(i, files.length, f.name);
    try {
      const kind = kindOf(f);
      if (!kind) { failed.push({ name: f.name, reason: "not a supported kind (music, video or PDF)" }); continue; }
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      let title = f.name.replace(/\.[a-z0-9]+$/i, "").replace(/_+/g, " ").trim() || f.name;
      let artist: string | undefined, album: string | undefined, cover: Blob | undefined;
      if (kind === "music") {
        try {
          const head = await f.slice(0, 1024 * 1024).arrayBuffer();
          const tail = await f.slice(Math.max(0, f.size - 128)).arrayBuffer();
          const t2 = id3v2(head), t1 = id3v1(tail);
          title = t2.title || t1.title || title;
          artist = t2.artist || t1.artist;
          album = t2.album || t1.album;
          cover = t2.cover;
        } catch { /* tags are optional — filename stands */ }
      }
      const probed = await probeMedia(f, kind);
      if (probed.undecodable) { failed.push({ name: f.name, reason: "isn't a playable media file" }); continue; }
      if (kind === "video" && probed.poster) cover = probed.poster;

      const item: MediaItem = {
        id, kind, name: f.name, title, artist, album,
        mime: f.type || (kind === "doc" ? "application/pdf" : "application/octet-stream"),
        size: f.size, duration: probed.duration, added: nextStamp(), hasCover: !!cover, plays: 0,
      };
      await commit(item, f, cover);
      added.push(item);
    } catch (e) {
      failed.push({ name: f.name, reason: humanReason(e) });
    }
  }
  onProgress?.(files.length, files.length, "");
  return { added, failed };
}

export async function listItems(): Promise<MediaItem[]> {
  const all = await tx<MediaItem[]>(META, "readonly", (s) => s.getAll() as IDBRequest<MediaItem[]>).catch(() => [] as MediaItem[]);
  return all.sort((a, b) => b.added - a.added || (a.id < b.id ? 1 : -1)); // total order: never ambiguous
}

export async function getBlob(id: string): Promise<Blob | undefined> {
  return tx<Blob | undefined>(BLOBS, "readonly", (s) => s.get(id) as IDBRequest<Blob | undefined>);
}

/** The bytes as a File (name + mime restored) — used to hand a PDF to the book reader / share sheet. */
export async function getFile(item: MediaItem): Promise<File> {
  const b = await getBlob(item.id);
  if (!b) throw new Error("This file is no longer on this device.");
  return b instanceof File ? b : new File([b], item.name, { type: item.mime });
}

// Blob URLs are bounded and revoked: an unbounded cache is a real leak in a long listening session.
const MEDIA_URLS = new Map<string, string>();  // item id → url (LRU, small)
const COVER_URLS = new Map<string, string>();  // item id → url (LRU, larger)
const MEDIA_MAX = 6, COVER_MAX = 240;
let pinned: string[] = [];                     // never evict the current/next track

/** Keep these item ids resident (the playing + upcoming track). */
export function pinMedia(ids: string[]): void { pinned = ids.filter(Boolean); }

function touch(map: Map<string, string>, key: string, max: number, keepPinned: boolean) {
  const v = map.get(key)!;
  map.delete(key); map.set(key, v);            // move to the end = most recent
  while (map.size > max) {
    const oldest = [...map.keys()].find((k) => !(keepPinned && pinned.includes(k)));
    if (!oldest) break;
    URL.revokeObjectURL(map.get(oldest)!);
    map.delete(oldest);
  }
}

export async function fileUrl(id: string): Promise<string> {
  const hit = MEDIA_URLS.get(id);
  if (hit) { touch(MEDIA_URLS, id, MEDIA_MAX, true); return hit; }
  const b = await getBlob(id);
  if (!b) throw new Error("This file is no longer on this device.");
  const url = URL.createObjectURL(b);
  MEDIA_URLS.set(id, url);
  touch(MEDIA_URLS, id, MEDIA_MAX, true);
  return url;
}

export async function coverUrl(id: string | undefined, hasCover = true): Promise<string | null> {
  if (!id || !hasCover) return null;
  const hit = COVER_URLS.get(id);
  if (hit) { touch(COVER_URLS, id, COVER_MAX, false); return hit; }
  const blob = await tx<Blob | undefined>(COVERS, "readonly", (s) => s.get(id) as IDBRequest<Blob | undefined>).catch(() => undefined);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  COVER_URLS.set(id, url);
  touch(COVER_URLS, id, COVER_MAX, false);
  return url;
}

function revokeFor(id: string) {
  for (const map of [MEDIA_URLS, COVER_URLS]) {
    const u = map.get(id);
    if (u) { URL.revokeObjectURL(u); map.delete(id); }
  }
}

export async function removeItem(item: MediaItem): Promise<void> {
  const d = await db();
  await new Promise<void>((res, rej) => {
    const t = d.transaction([META, BLOBS, COVERS], "readwrite");
    t.oncomplete = () => res();
    t.onabort = t.onerror = () => rej(t.error);
    t.objectStore(BLOBS).delete(item.id);
    t.objectStore(COVERS).delete(item.id);
    t.objectStore(META).delete(item.id);
  });
  revokeFor(item.id);
  await forgetEverywhere(item.id);
}

export async function notePlayed(id: string): Promise<void> {
  try {
    const item = await tx<MediaItem | undefined>(META, "readonly", (s) => s.get(id) as IDBRequest<MediaItem | undefined>);
    if (!item) return;
    item.plays = (item.plays || 0) + 1;
    item.lastPlayed = Date.now();
    await tx(META, "readwrite", (s) => s.put(item));
  } catch { /* a play counter is never worth surfacing an error for */ }
}

/** Reconcile: drop metadata rows whose bytes vanished (eviction, an interrupted early build) and
 *  orphaned blobs with no row. Cheap, runs once on mount. Returns how many rows it healed. */
export async function reconcile(): Promise<number> {
  try {
    const d = await db();
    const [ids, blobKeys] = await Promise.all([
      new Promise<string[]>((res) => { const r = d.transaction(META, "readonly").objectStore(META).getAllKeys(); r.onsuccess = () => res(r.result as string[]); r.onerror = () => res([]); }),
      new Promise<string[]>((res) => { const r = d.transaction(BLOBS, "readonly").objectStore(BLOBS).getAllKeys(); r.onsuccess = () => res(r.result as string[]); r.onerror = () => res([]); }),
    ]);
    const haveBlob = new Set(blobKeys), haveRow = new Set(ids);
    const deadRows = ids.filter((k) => !haveBlob.has(k));
    const orphanBlobs = blobKeys.filter((k) => !haveRow.has(k));
    if (!deadRows.length && !orphanBlobs.length) return 0;
    await new Promise<void>((res) => {
      const t = d.transaction([META, BLOBS, COVERS], "readwrite");
      t.oncomplete = t.onabort = t.onerror = () => res();
      for (const k of deadRows) { t.objectStore(META).delete(k); t.objectStore(COVERS).delete(k); }
      for (const k of orphanBlobs) { t.objectStore(BLOBS).delete(k); t.objectStore(COVERS).delete(k); }
    });
    return deadRows.length + orphanBlobs.length;
  } catch { return 0; }
}


// ── resume position ──────────────────────────────────────────────────────────────────────────────
// One position per item, whatever its kind: seconds into a track or video, or a book's block address.
// This is what turns a 9-hour audiobook or a 40-page paper from "start again" into "carry on", and it
// is the whole point of picking the library up mid-run.

export type Progress = { id: string; pos: number; pct: number; dur: number; updated: number; done: boolean };

export async function getProgress(id: string): Promise<Progress | undefined> {
  return tx<Progress | undefined>(PROGRESS, "readonly", (s) => s.get(id) as IDBRequest<Progress | undefined>).catch(() => undefined);
}

/** Record where the member is. Called from a timeupdate, so it must be cheap AND rate-limited by the
 *  caller — a write every 250 ms would hammer storage and a phone battery for no gain. */
export async function setProgress(id: string, pos: number, dur: number): Promise<void> {
  if (!isFinite(dur) || dur <= 0) return;                 // a VBR mp3 with no duration yet
  const pct = Math.max(0, Math.min(1, pos / dur));
  const done = pct >= 0.97;                                // finished: start from the top next time
  try { await tx(PROGRESS, "readwrite", (s) => s.put({ id, pos, pct, dur, updated: Date.now(), done })); }
  catch { /* a lost position is never worth an error */ }
}

/** Everything started but not finished, most recent first — the "Continue" shelf. */
export async function continueList(limit = 12): Promise<Progress[]> {
  const all = await tx<Progress[]>(PROGRESS, "readonly", (s) => s.getAll() as IDBRequest<Progress[]>).catch(() => [] as Progress[]);
  return all.filter((p) => !p.done && p.pct > 0.01 && p.pct < 0.97).sort((a, b) => b.updated - a.updated).slice(0, limit);
}

// ── playlists ────────────────────────────────────────────────────────────────────────────────────
// Purely local, like the rest of the device library. Order IS the array.

export type Playlist = { id: string; name: string; itemIds: string[]; created: number; updated: number };

export async function listPlaylists(): Promise<Playlist[]> {
  const all = await tx<Playlist[]>(PLAYLISTS, "readonly", (s) => s.getAll() as IDBRequest<Playlist[]>).catch(() => [] as Playlist[]);
  return all.sort((a, b) => b.updated - a.updated);
}

export async function savePlaylist(pl: Playlist): Promise<void> {
  await tx(PLAYLISTS, "readwrite", (s) => s.put({ ...pl, updated: Date.now() }));
}

export async function createPlaylist(name: string, itemIds: string[] = []): Promise<Playlist> {
  const pl: Playlist = { id: `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name: name.trim() || "Untitled", itemIds, created: Date.now(), updated: Date.now() };
  await savePlaylist(pl);
  return pl;
}

export async function deletePlaylist(id: string): Promise<void> {
  await tx(PLAYLISTS, "readwrite", (s) => s.delete(id));
}

/** Drop an item from every playlist and forget its position — called when the file is deleted, so no
 *  playlist keeps a ghost entry and no stale position resurfaces if the same id is ever reused. */
async function forgetEverywhere(id: string): Promise<void> {
  try {
    await tx(PROGRESS, "readwrite", (s) => s.delete(id));
    for (const pl of await listPlaylists()) {
      if (pl.itemIds.includes(id)) await savePlaylist({ ...pl, itemIds: pl.itemIds.filter((x) => x !== id) });
    }
  } catch { /* housekeeping only */ }
}

/** Share an item — the real file via the Web Share API where supported (straight into other apps /
 *  AirDrop on mobile); otherwise SAVE it to the member's downloads, which is a share they can act on.
 *  Nothing touches a server either way. */
export async function shareItem(item: MediaItem): Promise<"shared" | "saved" | "unsupported"> {
  let file: File;
  try { file = await getFile(item); } catch { return "unsupported"; }
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  try {
    if (nav.share && nav.canShare?.({ files: [file] })) {
      await nav.share({ files: [file], title: item.title });
      return "shared";
    }
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") return "shared"; // the member dismissed the sheet
  }
  try {                                    // real fallback: hand over the actual bytes, not a text card
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url; a.download = item.name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    return "saved";
  } catch { return "unsupported"; }
}
