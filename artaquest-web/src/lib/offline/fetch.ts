/**
 * Offline-aware fetch shim. Both data clients (lib/wp.ts and lib/api.ts) route their requests
 * through this so the SAME code paths work online and offline:
 *
 *   • GET  — online: hit the network, but if it fails fall back to a downloaded copy.
 *            offline: serve the downloaded copy instantly; if none, surface a normal failure.
 *   • POST — offline: short-circuit with a 503 carrying a friendly "needs a connection" message,
 *            so existing error handling shows it (posting / voting / competing are online-only).
 *
 * Downloaded GET responses are keyed by their AQ-relative path (e.g. "courses/77"), written by
 * the Download Center (lib/offline/store.ts) from the server's self-contained course bundle.
 */
import { idb, STORES } from "./idb";
import { isOnline } from "./net";

/** The cache keys a request URL can match, most-specific first.
 *  "…/wp-json/aq/v1/threads?topic=course-77" → exact "threads?topic=course-77", base "threads".
 *  Bundles store most resources under their bare path (the default view — any sort/filter of it is
 *  served from that one copy), but query-distinguished resources (a course's threads vs the global
 *  list) are stored WITH their canonical query. Pagination params (cursor/parent) identify a page,
 *  not a view — falling back to the base copy would re-serve page 1 and duplicate items, so those
 *  requests only ever match an exact key. Returns null for non-AQ URLs (never intercepted). */
function keysFor(url: string): { exact: string; base: string; paged: boolean } | null {
  let u: URL;
  try {
    u = new URL(url, typeof location !== "undefined" ? location.origin : "http://localhost");
  } catch {
    return null;
  }
  const marker = "/aq/v1/";
  const i = u.pathname.indexOf(marker);
  if (i === -1) return null;
  const base = u.pathname.slice(i + marker.length).replace(/\/+$/, "");
  if (!base) return null;
  const canon = canonicalQuery(u.searchParams);
  return {
    exact: canon ? `${base}?${canon}` : base,
    base,
    paged: u.searchParams.has("cursor") || u.searchParams.has("parent"),
  };
}

/** Sorted, empty-stripped query string so the same view always produces the same key (the server's
 *  bundle builder authors keys in this same canonical form; lib/offline/store re-canonicalizes on
 *  write as a belt-and-braces). */
export function canonicalQuery(params: URLSearchParams): string {
  const entries = [...params.entries()].filter(([, v]) => v !== "");
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

/** Read the stored copy for a request: the exact path?query first, then the bare-path default view
 *  (never for paginated requests — see keysFor). */
async function storedCopy(keys: { exact: string; base: string; paged: boolean }): Promise<unknown | undefined> {
  const exact = await idb.get(STORES.responses, keys.exact);
  if (exact !== undefined) return exact;
  if (keys.paged || keys.exact === keys.base) return undefined;
  return idb.get(STORES.responses, keys.base);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const OFFLINE_MSG =
  "You're offline. Watching and reading work offline; posting, voting, and competing need a connection.";

/** Read a downloaded endpoint response, or undefined if not stored. */
export async function cachedResponse(url: string): Promise<unknown | undefined> {
  const keys = keysFor(url);
  if (!keys) return undefined;
  return storedCopy(keys);
}

/** Drop-in replacement for fetch() with offline fallback for the AQ API. */
export async function aqFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const keys = keysFor(url);

  if (method !== "GET") {
    // Writes can't happen offline. Fail fast with a clear message instead of a confusing timeout.
    if (!isOnline()) return jsonResponse({ error: "offline", message: OFFLINE_MSG }, 503);
    return fetch(url, init);
  }

  // GET. Offline → serve the downloaded copy first.
  if (keys && !isOnline()) {
    const hit = await storedCopy(keys);
    if (hit !== undefined) return jsonResponse(hit);
    // No copy — let the caller's try/catch treat it as an unavailable read.
    return jsonResponse({ error: "offline", message: OFFLINE_MSG }, 503);
  }

  // Online → network first, with a downloaded copy as a resilience fallback.
  try {
    const r = await fetch(url, init);
    if (!r.ok && keys) {
      const hit = await storedCopy(keys);
      if (hit !== undefined) return jsonResponse(hit);
    }
    return r;
  } catch (e) {
    if (keys) {
      const hit = await storedCopy(keys);
      if (hit !== undefined) return jsonResponse(hit);
    }
    throw e;
  }
}
