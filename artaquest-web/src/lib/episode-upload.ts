import { castFinish, castIso, meetFinish, meetIso, uploadImage } from "./api";
import { listRecordings, openRecording, recordingFile } from "./episode-store";
import type { EpisodeSpec } from "./episode-frame";

/**
 * FROM THE HOST'S DISK TO THE FINISHING RUN, unattended.
 *
 * After Stop the recorder calls `sendForFinishing`: the episode file in the browser's store goes
 * to the host's ArtaCloud shelf in 8 MB parts (resumable — the server's byte count is the cursor),
 * the thumbnail goes up as an image, and `artacast/finish` starts the Kaggle run. Progress lives in
 * a module-level registry rather than in a component, because the call page is usually left while
 * the upload is still running: the host's show page reads the same registry and can resume or
 * restart any recording still on this computer. A sidecar `<name>.json` in the store remembers
 * which meeting a file belongs to, so nothing has to be typed.
 */

/** `kind` says which road the file takes home: an ArtaCast episode, or any other meeting. */
export type Sidecar = { meet_id: number; request_id: number; spec: EpisodeSpec | null; at: number; kind?: "cast" | "meet"; upload_id?: number; upload_bytes?: number; /** a guest's own camera track, not the master */ iso?: boolean };
export type SendState = { name: string; phase: "idle" | "uploading" | "thumb" | "starting" | "done" | "error"; frac: number; note: string; at: number };

const registry = new Map<string, SendState>();
const listeners = new Set<() => void>();
function set(name: string, patch: Partial<SendState>) {
  const cur = registry.get(name) || { name, phase: "idle", frac: 0, note: "", at: Date.now() };
  registry.set(name, { ...cur, ...patch, at: Date.now() });
  for (const l of listeners) l();
}
export function sendState(name: string): SendState | undefined { return registry.get(name); }
export function subscribeSend(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

export async function writeSidecar(name: string, s: Sidecar): Promise<void> {
  const w = await openRecording(`${name}.json`);
  if (!w) return;
  try { await w.write(new Blob([JSON.stringify(s)], { type: "application/json" })); await w.close(); } catch { /* the store refused; the host page will ask which meeting */ }
}
export async function readSidecar(name: string): Promise<Sidecar | null> {
  const f = await recordingFile(`${name}.json`);
  if (!f) return null;
  try { return JSON.parse(await f.text()) as Sidecar; } catch { return null; }
}
export async function writeThumb(name: string, blob: Blob): Promise<void> {
  const w = await openRecording(`${name}.thumb.png`);
  if (!w) return;
  try { await w.write(blob); await w.close(); } catch { /* no thumbnail — the run still finishes */ }
}

/** Recordings on this computer that are episodes (have a sidecar), newest first. */
export async function storedEpisodes(): Promise<{ name: string; bytes: number; modified: number; side: Sidecar | null }[]> {
  const all = await listRecordings();
  const out = [];
  for (const r of all) {
    if (r.name.endsWith(".json") || r.name.endsWith(".thumb.png")) continue;
    out.push({ ...r, side: await readSidecar(r.name) });
  }
  return out;
}

const dataUrl = (b: Blob) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(b); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * THE UPLOAD THAT DOES NOT START OVER. Five gigabytes over a home connection is an hour, and an
 * hour is long enough for a dropped connection, a sleeping laptop, or a closed tab. So:
 *   · the server's shelf id is written into the sidecar the moment the upload begins, and a later
 *     send — from this tab or the next one — resumes the SAME item at the server's byte count
 *     (a part at offset 0 answers 409 with `received`, which is the cursor);
 *   · every part is retried with backoff before the send is called failed;
 *   · a commit whose reply was lost is recovered by asking the shelf whether the item is ready.
 */
async function uploadResumable(name: string, f: File, side: Sidecar | null, meetId: number, onFrac: (n: number) => void, fresh = false): Promise<number> {
  const BASE = "/wp-json/aq/v1";
  const nonce = () => (window as unknown as { AQ_WP_NONCE?: string }).AQ_WP_NONCE || "";
  const call = async (path: string, init: RequestInit) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const r = await fetch(`${BASE}${path}`, { ...init, credentials: "include", headers: { ...(init.headers as Record<string, string> || {}), "X-WP-Nonce": nonce() } });
        if (r.status >= 500 || r.status === 429) { await sleep(2000 * 2 ** attempt); continue; }
        return r;
      } catch { await sleep(2000 * 2 ** attempt); }
    }
    throw new Error("The connection kept failing — the send will resume when you press Send again.");
  };
  let id = side?.upload_id && side.upload_bytes === f.size ? side.upload_id : 0;
  let chunk = 8 * 1024 * 1024;
  if (!id) {
    const r = await call("/media/begin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: f.name, bytes: f.size }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || "The shelf refused the upload.");
    id = j.id; chunk = Math.max(1, j.chunk_max || chunk);
    if (side) await writeSidecar(name, { ...side, meet_id: side.meet_id || meetId, upload_id: id, upload_bytes: f.size });
  }
  let sent = 0;
  while (sent < f.size) {
    const end = Math.min(sent + chunk, f.size);
    const r = await call(`/media/${id}/part?offset=${sent}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f.slice(sent, end) });
    const j = (await r.json().catch(() => ({}))) as { received?: number; message?: string; error?: string };
    if (!r.ok) {
      if (r.status === 409 && typeof j.received === "number") { sent = j.received; continue; }
      if (r.status === 409 && j.error === "closed") break; // already committed by an earlier send
      if (r.status === 404 && !fresh) { id = 0; break; }   // the item is gone: begin again below, once
      throw new Error(j.message || `Upload refused (${r.status}).`);
    }
    sent = typeof j.received === "number" ? j.received : end;
    onFrac(sent / f.size);
  }
  if (!id) { if (side) await writeSidecar(name, { ...side, upload_id: 0, upload_bytes: 0 }); return uploadResumable(name, f, side ? { ...side, upload_id: 0 } : null, meetId, onFrac, true); }
  const c = await call(`/media/${id}/commit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: name.replace(/\.[^.]+$/, "") }) });
  if (!c.ok) {
    const j = (await c.json().catch(() => ({}))) as { message?: string; error?: string };
    // "already finished" is success; anything else is reported.
    if (j.error !== "closed") throw new Error(j.message || "The shelf could not finish the upload.");
  }
  return id;
}

/** Upload the episode and start finishing it. Resolves when Kaggle has been asked. Safe to call
 *  again for the same file: a second send resumes the same shelf item at the server's byte count. */
export async function sendForFinishing(name: string, meetId: number, file?: File | null, kind: "cast" | "meet" = "cast"): Promise<void> {
  const cur = registry.get(name);
  if (cur && (cur.phase === "uploading" || cur.phase === "thumb" || cur.phase === "starting")) return;
  set(name, { phase: "uploading", frac: 0, note: "" });
  try {
    const f = file || (await recordingFile(name));
    if (!f) throw new Error("The recording is no longer on this computer.");
    const side = await readSidecar(name);
    const mediaId = await uploadResumable(name, f, side, meetId, (frac) => set(name, { frac }));
    const item = { id: mediaId };
    set(name, { phase: "thumb", frac: 1 });
    let thumb = "";
    const t = await recordingFile(`${name}.thumb.png`);
    if (t && t.size > 0 && t.size < 6 * 1024 * 1024) {
      try { thumb = (await uploadImage(await dataUrl(t))).url || ""; } catch { thumb = ""; }
    }
    set(name, { phase: "starting" });
    if (kind === "meet") await meetFinish(meetId, item.id, thumb);
    else await castFinish(meetId, item.id, thumb);
    set(name, { phase: "done", note: "Finishing on Kaggle — you will be emailed when it is ready." });
  } catch (e) {
    set(name, { phase: "error", note: (e as Error)?.message || "The upload failed." });
    throw e;
  }
}

/** A guest's isolated track: to their shelf, then attached to the request. Same resumable path. */
export async function sendIso(name: string, meetId: number, kind: "cast" | "meet" = "cast"): Promise<void> {
  const cur = registry.get(name);
  if (cur && (cur.phase === "uploading" || cur.phase === "thumb" || cur.phase === "starting")) return;
  set(name, { phase: "uploading", frac: 0, note: "" });
  try {
    const f = await recordingFile(name);
    if (!f) throw new Error("The recording is no longer on this computer.");
    const side = await readSidecar(name);
    const mediaId = await uploadResumable(name, f, side, meetId, (frac) => set(name, { frac }));
    set(name, { phase: "starting" });
    if (kind === "meet") await meetIso(meetId, mediaId);
    else await castIso(meetId, mediaId);
    set(name, { phase: "done", note: "Your camera recording is with the editor." });
  } catch (e) {
    set(name, { phase: "error", note: (e as Error)?.message || "The upload failed." });
    throw e;
  }
}
