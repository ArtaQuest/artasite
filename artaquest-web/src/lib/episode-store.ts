/**
 * WHERE A RECORDING LIVES WHILE IT IS BEING MADE — the browser's origin-private file system.
 *
 * A two-hour episode at 8 Mbit/s is seven gigabytes. Holding that in memory until Stop is how it
 * is lost at the last second, and asking the host to pick a file before Record is a prompt in the
 * way of the one button the call is for. OPFS is a real file on disk that needs no prompt, works in
 * Chrome, Edge, Safari and Firefox, and outlives a crash or a closed tab: every second's chunk is
 * appended as it arrives, and the finished file — or the interrupted one — is listed under the
 * recorder for download until the host deletes it. Nothing here touches the network.
 */

type Dir = {
  getFileHandle: (name: string, o?: { create?: boolean }) => Promise<FileHandle>;
  getDirectoryHandle: (name: string, o?: { create?: boolean }) => Promise<Dir>;
  removeEntry: (name: string) => Promise<void>;
  entries?: () => AsyncIterable<[string, unknown]>;
  keys?: () => AsyncIterable<string>;
};
type FileHandle = {
  kind?: string;
  getFile: () => Promise<File>;
  createWritable?: (o?: { keepExistingData?: boolean }) => Promise<Writable>;
};
export type Writable = { write: (d: Blob) => Promise<void>; close: () => Promise<void> };
export type StoredRecording = { name: string; bytes: number; modified: number };

const DIR = "artacast";

async function dir(): Promise<Dir | null> {
  try {
    const root = await (navigator.storage as unknown as { getDirectory?: () => Promise<Dir> }).getDirectory?.();
    if (!root) return null;
    return await root.getDirectoryHandle(DIR, { create: true });
  } catch { return null; }
}

/** True when this browser can append a recording to disk as it is made. */
export async function canStore(): Promise<boolean> {
  const d = await dir();
  if (!d) return false;
  try {
    const h = await d.getFileHandle(".probe", { create: true });
    const ok = typeof h.createWritable === "function";
    await d.removeEntry(".probe").catch(() => undefined);
    return ok;
  } catch { return false; }
}

/** A writable for a new recording, or null when the browser cannot give one. */
export async function openRecording(name: string): Promise<Writable | null> {
  const d = await dir();
  if (!d) return null;
  try {
    const h = await d.getFileHandle(name, { create: true });
    if (typeof h.createWritable !== "function") return null;
    return await h.createWritable();
  } catch { return null; }
}

export async function listRecordings(): Promise<StoredRecording[]> {
  const d = await dir();
  if (!d) return [];
  const out: StoredRecording[] = [];
  try {
    const names: string[] = [];
    if (d.keys) { for await (const k of d.keys()) names.push(k); }
    else if (d.entries) { for await (const [k] of d.entries()) names.push(k); }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      try {
        const f = await (await d.getFileHandle(n)).getFile();
        out.push({ name: n, bytes: f.size, modified: f.lastModified });
      } catch { /* a handle mid-write; it will list next time */ }
    }
  } catch { /* nothing listable */ }
  return out.sort((a, b) => b.modified - a.modified);
}

/** The stored file, for a download link. `URL.createObjectURL(File)` streams from disk — it does
 *  not load seven gigabytes into memory. */
export async function recordingFile(name: string): Promise<File | null> {
  const d = await dir();
  if (!d) return null;
  try { return await (await d.getFileHandle(name)).getFile(); } catch { return null; }
}

export async function deleteRecording(name: string): Promise<boolean> {
  const d = await dir();
  if (!d) return false;
  try { await d.removeEntry(name); return true; } catch { return false; }
}
