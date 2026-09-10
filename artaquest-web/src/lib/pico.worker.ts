/**
 * The pico scan, off the main thread.
 *
 * A full cascade pass over 320×180 is a few to a few tens of milliseconds depending on the machine
 * and the scene — small next to a 250 ms tick, but on the MAIN thread it lands in the same frame
 * as the encoder's texture upload and the audio graph's callbacks, and a call's audio is the one
 * thing that must never wait for a picture effect. So the scan runs here: the main thread posts a
 * grey plane (transferred, not copied), this thread answers with the detections, and the
 * governor's per-frame cost never sees it.
 *
 * The cascade is fetched here too, once per worker, so the 240 KB never crosses the thread border.
 */
import { type Classifier, type Detection, type ScanParams, runCascade, unpackCascade } from "./pico";

type In =
  | { t: "load"; url: string }
  | { t: "scan"; id: number; grey: ArrayBuffer; w: number; h: number; p: ScanParams };
type Out =
  | { t: "loaded"; ok: boolean }
  | { t: "dets"; id: number; dets: Detection[] };

let classify: Classifier | null = null;
const post = (m: Out) => (self as unknown as { postMessage: (m: Out) => void }).postMessage(m);

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  if (m.t === "load") {
    try {
      const r = await fetch(m.url);
      if (!r.ok) throw new Error(String(r.status));
      classify = unpackCascade(new Uint8Array(await r.arrayBuffer()));
      post({ t: "loaded", ok: true });
    } catch { post({ t: "loaded", ok: false }); }
    return;
  }
  if (m.t === "scan") {
    const dets = classify ? runCascade(new Uint8Array(m.grey), m.h, m.w, classify, m.p) : [];
    post({ t: "dets", id: m.id, dets });
  }
};
