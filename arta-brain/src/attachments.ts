import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import { FILE_TYPES, safeName } from "./files";
import { type Fetch, timed } from "./http";
import type { Attachment, Mention } from "./types";

export type NotAttached = { a: Attachment; why: string };
export type Prepared = { paths: string[]; attached: Attachment[]; notAttached: NotAttached[]; cleanup: () => Promise<void> };

const WHY: Record<string, string> = { type: "type not supported", size: "too large", count: "too many files" };

/** Only public https URLs (and the local stand-in server in tests) are ever fetched. */
export function fetchable(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" && u.hostname === "127.0.0.1") return true;
    if (u.protocol !== "https:") return false;
    return !/^(localhost|0\.0\.0\.0|\[?::1\]?|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname);
  } catch { return false; }
}

/** Read a response body, refusing more than `cap` bytes (whatever Content-Length claimed). */
export async function capped(r: Response, cap: number): Promise<Uint8Array | null> {
  const len = Number(r.headers.get("content-length") || 0);
  if (len > cap) return null;
  if (!r.body) return new Uint8Array(await r.arrayBuffer());
  const parts: Uint8Array[] = []; let n = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

/**
 * Download the mention's files to a private temp dir for upload to the chat page. Whatever cannot be
 * attached (type, size, count, a failed download) is reported so the prompt can say so. ALWAYS call
 * cleanup() — the worker does, in a finally.
 */
export async function prepareAttachments(m: Mention, cfg: Config, f: Fetch = fetch, root = tmpdir()): Promise<Prepared> {
  const attached: Attachment[] = []; const notAttached: NotAttached[] = []; const paths: string[] = [];
  let dir = "";
  const cleanup = async () => { if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {}); };
  try {
    for (const a of m.attachments ?? []) {
      if (a.skip) { notAttached.push({ a, why: WHY[a.skip] || "not attached" }); continue; }
      if (attached.length >= cfg.attachMax) { notAttached.push({ a, why: WHY.count }); continue; }
      if (!FILE_TYPES[a.mime]) { notAttached.push({ a, why: WHY.type }); continue; }
      if (!(a.bytes > 0) || a.bytes > cfg.attachBytes) { notAttached.push({ a, why: WHY.size }); continue; }
      if (!fetchable(a.url)) { notAttached.push({ a, why: "not reachable" }); continue; }
      let body: Uint8Array | null = null;
      try {
        const r = await timed(f, a.url, { headers: { "User-Agent": "arta-brain/1" } }, 60_000);
        if (!r.ok) { notAttached.push({ a, why: `could not be downloaded (${r.status})` }); continue; }
        body = await capped(r, cfg.attachBytes);
      } catch { notAttached.push({ a, why: "could not be downloaded" }); continue; }
      if (!body) { notAttached.push({ a, why: WHY.size }); continue; }
      if (!dir) dir = await mkdtemp(join(root, "arta-in-"));
      const path = join(dir, `${attached.length + 1}-${safeName(a.name, a.mime)}`);
      await writeFile(path, body, { mode: 0o600 });
      paths.push(path); attached.push(a);
    }
  } catch (e) { await cleanup(); throw e; }
  return { paths, attached, notAttached, cleanup };
}
