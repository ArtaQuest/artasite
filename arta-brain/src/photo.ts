import sharp from "sharp";
import { capped, fetchable } from "./attachments";
import type { Config } from "./config";
import { sniffMime } from "./files";
import { type Fetch, timed } from "./http";
import type { OutFile, Photo } from "./types";

const HOST = /^https:\/\/upload\.wikimedia\.org\//;
const RAW_CAP = 15 * 1048576;

/**
 * A real photo the answer pointed at: downloaded from Wikimedia only, checked to BE a still image,
 * oriented, bounded to 1200 px, optionally grayscale, re-encoded as JPEG (which also strips metadata).
 * Never throws — any failure is logged and returns null, so the reply still goes out as text.
 */
export async function fetchPhoto(ph: Photo, cfg: Config, f: Fetch = fetch, log: (s: string) => void = () => {}): Promise<OutFile | null> {
  try {
    if (!HOST.test(ph.url) || !fetchable(ph.url)) { log("photo: host not allowed"); return null; }
    const r = await timed(f, ph.url, { headers: { "User-Agent": "arta-brain/1 (https://artaquest.com)" } }, 15_000);
    if (!r.ok) { log(`photo: HTTP ${r.status}`); return null; }
    const raw = await capped(r, RAW_CAP);
    if (!raw) { log("photo: too large"); return null; }
    const mime = sniffMime(raw);
    if (!mime || !/^image\/(jpeg|png|webp)$/.test(mime)) { log(`photo: not a still image (${mime || "unknown"})`); return null; }
    let p = sharp(raw, { animated: false, limitInputPixels: 50_000_000 }).rotate()
      .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true });
    if (ph.grayscale) p = p.grayscale();
    const out = new Uint8Array(await p.jpeg({ quality: 85, mozjpeg: true }).toBuffer());
    if (out.byteLength > cfg.outFileBytes) { log("photo: too large after conversion"); return null; }
    return { name: ph.grayscale ? "photo-bw.jpg" : "photo.jpg", mime: "image/jpeg", bytes: out };
  } catch (e) {
    log(`photo: ${(e as Error).message.split("\n")[0]}`);
    return null;
  }
}
