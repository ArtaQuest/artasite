// Chunked-Range model downloader with MIRROR support — defeats the chronic mid-stream kills
// (ERR_HTTP2_PROTOCOL_ERROR / ERR_CONNECTION_RESET) that whole-file fetches of big ONNX weights hit
// on huggingface's xet CDN from some networks. Two defences:
//   1. short-lived 8 MB Range slices, each retried independently;
//   2. an optional SAME-ORIGIN mirror (the platform hosts the weights under uploads/aq-models/ on
//      the wp.com CDN) used as the byte source, while the assembled file is stored in the Cache API
//      bucket transformers.js reads ("transformers-cache") UNDER THE CANONICAL HF URL — the library
//      then finds it "cached" and never touches the fragile host at all.
import type { NeuralProgress } from "./tts";

const CACHE = "transformers-cache";
const SLICE = 8 * 1024 * 1024;
const TRIES = 4;

export type PrefetchFile = { key: string; src?: string }; // key = canonical HF URL; src = mirror (defaults to key)

async function fetchSlice(url: string, from: number, to: number): Promise<{ buf: ArrayBuffer; total: number; status: number }> {
  let lastErr: unknown = null;
  for (let t = 0; t < TRIES; t++) {
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } });
      if (res.status !== 206 && res.status !== 200 && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      if (res.status === 404) return { buf: new ArrayBuffer(0), total: 0, status: 404 };
      const buf = await res.arrayBuffer();
      const cr = res.headers.get("Content-Range"); // "bytes 0-8388607/123456789"
      const total = cr ? Number(cr.split("/")[1]) : buf.byteLength;
      return { buf, total, status: res.status };
    } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 900 * (t + 1))); }
  }
  throw lastErr;
}

async function downloadWhole(url: string, onPct: (gotBytes: number, total: number) => void): Promise<Blob | null> {
  const first = await fetchSlice(url, 0, SLICE - 1);
  if (first.status === 404) return null;
  const total = first.total;
  const parts: ArrayBuffer[] = [first.buf];
  let got = first.buf.byteLength;
  onPct(got, total);
  // A 200 to a Range request = server ignored ranges and sent everything already.
  if (first.status === 200 || got >= total) return new Blob(parts);
  while (got < total) {
    const { buf } = await fetchSlice(url, got, Math.min(got + SLICE, total) - 1);
    if (!buf.byteLength) throw new Error("empty slice");
    parts.push(buf); got += buf.byteLength;
    onPct(got, total);
  }
  return new Blob(parts);
}

/** Ensure every file is present in transformers.js's cache under its canonical URL, sourcing bytes
 *  from the mirror when given (falling back to the canonical host if the mirror 404s). */
export async function rangedPrefetch(files: PrefetchFile[], onProgress?: (p: NeuralProgress) => void, label = "Downloading the model…"): Promise<void> {
  let cache: Cache;
  try { cache = await caches.open(CACHE); } catch { return; } // no Cache API → let the library fetch normally
  const todo: PrefetchFile[] = [];
  for (const f of files) { if (!(await cache.match(f.key))) todo.push(f); }
  for (let i = 0; i < todo.length; i++) {
    const f = todo[i];
    const onPct = (got: number, total: number) => onProgress?.({ pct: Math.round(((i + (total ? got / total : 0)) / todo.length) * 100), status: label });
    let blob = f.src ? await downloadWhole(f.src, onPct) : null;
    if (!blob) blob = await downloadWhole(f.key, onPct); // mirror missing → canonical host (ranged)
    if (!blob) throw new Error(`model file unavailable: ${f.key.split("/").pop()}`);
    await cache.put(f.key, new Response(blob, {
      status: 200,
      headers: { "Content-Type": "binary/octet-stream", "Content-Length": String(blob.size) },
    }));
    onProgress?.({ pct: Math.round(((i + 1) / todo.length) * 100), status: label });
  }
}

/** Where the platform's model weights live: a PUBLIC KAGGLE DATASET owned by `artafather`
 *  (operator 2026-08-02 — HuggingFace purged entirely, Kaggle takes all the heavy data).
 *
 *  Kaggle was checked against exactly what this file needs before the move: the download API answers
 *  with no credential, sends CORS for our origin, 302s to storage.googleapis.com (which sends `*`,
 *  and which the CSP must therefore list too — it validates every hop), returns the file RAW rather
 *  than zipped, and honours Range with a 206. That last one is the one that matters here.
 *
 *  Do not "simplify" fetchSlice into a single whole-file fetch. The 8 MB Range slices, each retried
 *  independently, are why a big ONNX download survives a flaky connection; they were built when
 *  whole-file fetches were being killed mid-stream, and nothing about changing host removes that.
 *  The assembled bytes are still cached under the URL the LIBRARY asks for, so a returning device
 *  never re-downloads — see lib/model-host.ts, which rewrites those library URLs to this host. */
const KAGGLE_MODELS = "https://www.kaggle.com/api/v1/datasets/download/artafather/aq-models";

export function modelMirrorBase(): string {
  return KAGGLE_MODELS;
}
