import { castFinish, cloudUpload, uploadImage } from "./api";
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

export type Sidecar = { meet_id: number; request_id: number; spec: EpisodeSpec; at: number };
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

/** Upload the episode and start finishing it. Resolves when Kaggle has been asked. Safe to call
 *  again for the same file: a second upload of an unfinished send simply resumes on the server's
 *  byte count. */
export async function sendForFinishing(name: string, meetId: number, file?: File | null): Promise<void> {
  const cur = registry.get(name);
  if (cur && (cur.phase === "uploading" || cur.phase === "thumb" || cur.phase === "starting")) return;
  set(name, { phase: "uploading", frac: 0, note: "" });
  try {
    const f = file || (await recordingFile(name));
    if (!f) throw new Error("The recording is no longer on this computer.");
    const item = await cloudUpload(f, { title: name.replace(/\.[^.]+$/, "") }, (frac) => set(name, { frac }));
    set(name, { phase: "thumb", frac: 1 });
    let thumb = "";
    const t = await recordingFile(`${name}.thumb.png`);
    if (t && t.size > 0 && t.size < 6 * 1024 * 1024) {
      try { thumb = (await uploadImage(await dataUrl(t))).url || ""; } catch { thumb = ""; }
    }
    set(name, { phase: "starting" });
    await castFinish(meetId, item.id, thumb);
    set(name, { phase: "done", note: "Finishing on Kaggle — you will be emailed when the episode is ready." });
  } catch (e) {
    set(name, { phase: "error", note: (e as Error)?.message || "The upload failed." });
    throw e;
  }
}
