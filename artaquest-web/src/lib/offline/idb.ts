/**
 * Tiny promise-based IndexedDB wrapper — zero dependencies (keeps the bundle lean and the
 * offline layer self-contained). One database, several object stores; every store is a simple
 * key→value map. This is the durable backing for the "take it with you" offline feature:
 * downloaded course bundles, video blobs, captions, transcripts, language packs and the
 * public-database snapshot all live here so the SPA renders identically with no network.
 */

export const DB_NAME = "artaquest-offline";
const DB_VERSION = 1;

/** Object stores. `responses` is the heart of it: each downloaded endpoint response keyed by its
 *  AQ-relative path (e.g. "courses/77") so the data layer can transparently serve it offline. */
export const STORES = {
  responses: "responses",   // path → endpoint JSON (the SPA's normal data shapes)
  media: "media",           // `${lessonId}:${itag}` → Blob (a downloaded video file)
  mediaMeta: "mediaMeta",   // lessonId → { itag, label, bytes, mime }
  captions: "captions",     // `${lessonId}:${lang}` → WebVTT text
  transcripts: "transcripts", // lessonId → transcript text
  courses: "courses",       // courseId → manifest of a downloaded course
  langpacks: "langpacks",   // lang → { lang, count, at }
  dbtables: "dbtables",     // tableName → { columns, rows }
  meta: "meta",             // misc small values (flags, the catalogue manifest, etc.)
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const idb = {
  get<T = unknown>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return tx<T | undefined>(store, "readonly", (s) => s.get(key)).catch(() => undefined);
  },
  put(store: StoreName, key: IDBValidKey, value: unknown): Promise<void> {
    return tx<IDBValidKey>(store, "readwrite", (s) => s.put(value, key)).then(() => undefined);
  },
  del(store: StoreName, key: IDBValidKey): Promise<void> {
    return tx<undefined>(store, "readwrite", (s) => s.delete(key)).then(() => undefined);
  },
  keys(store: StoreName): Promise<IDBValidKey[]> {
    return tx<IDBValidKey[]>(store, "readonly", (s) => s.getAllKeys()).catch(() => []);
  },
  all<T = unknown>(store: StoreName): Promise<T[]> {
    return tx<T[]>(store, "readonly", (s) => s.getAll()).catch(() => []);
  },
  clear(store: StoreName): Promise<void> {
    return tx<undefined>(store, "readwrite", (s) => s.clear()).then(() => undefined).catch(() => undefined);
  },
};

/** Best-effort persisted-storage request + a quota estimate (bytes used / available). */
export async function storageEstimate(): Promise<{ usage: number; quota: number; persisted: boolean }> {
  let persisted = false;
  try {
    if (navigator.storage?.persisted) persisted = await navigator.storage.persisted();
    if (!persisted && navigator.storage?.persist) persisted = await navigator.storage.persist();
  } catch { /* not supported */ }
  try {
    const e = (await navigator.storage?.estimate?.()) ?? {};
    return { usage: e.usage ?? 0, quota: e.quota ?? 0, persisted };
  } catch {
    return { usage: 0, quota: 0, persisted };
  }
}
