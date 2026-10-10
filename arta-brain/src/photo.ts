import { capped, fetchable } from "./attachments";
import { sniffMime } from "./files";
import { type Fetch, timed } from "./http";
import type { OutFile, Photo } from "./types";

const OK = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Download the real photo the answer named (public https, 15 s, size-capped, jpeg/png/webp by its
 * bytes), re-encode it as photo.jpg — grayscale when asked — and drop its metadata. Null on any failure.
 */
export async function fetchPhoto(p: Photo, cap: number, f: Fetch = fetch, log: (s: string) => void = () => {}): Promise<OutFile | null> {
  if (!fetchable(p.url)) return null;
  try {
    const r = await timed(f, p.url, { headers: { "User-Agent": "arta-brain/1 (+https://artaquest.com)", Accept: "image/jpeg,image/png,image/webp" }, redirect: "follow" }, 15_000);
    if (!r.ok) { log(`photo: HTTP ${r.status}`); return null; }
    const raw = await capped(r, cap);
    if (!raw || !OK.has(sniffMime(raw))) { log("photo: not a jpeg/png/webp within the cap"); return null; }
    const sharp = (await import("sharp")).default;
    let img = sharp(raw, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true });
    if (p.gray) img = img.grayscale();
    const bytes = new Uint8Array(await img.jpeg({ quality: 85 }).toBuffer());
    return bytes.byteLength <= cap ? { name: "photo.jpg", mime: "image/jpeg", bytes } : null;
  } catch (e) { log(`photo: ${(e as Error).message.split("\n")[0]}`); return null; }
}
