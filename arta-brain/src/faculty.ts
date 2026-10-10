import { capped } from "./attachments";
import { type Fetch, timed } from "./http";
import type { Person, Photo } from "./types";

/**
 * Photo fallback for real people the model named but could not find a photo of: official faculty
 * listings whose photos are rendered by JavaScript (so web search never sees them). One resolver per
 * site; the listing is fetched with a timeout and cached. Only an unambiguous name match counts.
 */
type Entry = { name: string; photo: string };
type Resolver = { affiliation: RegExp; data: string; photoBase: string; page: string; parse: (src: string) => Entry[] };

/** `{ name: "…", … photo: "…" }` objects of a static JS data file — read as text, never evaluated. */
function parseJsObjects(src: string): Entry[] {
  const out: Entry[] = [];
  for (const chunk of src.split(/\n\s*\{\s*\n/).slice(1)) {
    const name = /\bname:\s*"([^"]+)"/.exec(chunk)?.[1];
    const photo = /\bphoto:\s*"([^"]*)"/.exec(chunk)?.[1] ?? "";
    if (name) out.push({ name, photo });
  }
  return out;
}

export const RESOLVERS: Resolver[] = [
  {
    affiliation: /bilkent/i,
    data: "https://math.bilkent.edu.tr/assets/data/faculty.js",
    photoBase: "https://math.bilkent.edu.tr/personnel_photos/",
    page: "https://math.bilkent.edu.tr/faculty.html",
    parse: parseJsObjects,
  },
];

/** Lowercase, Turkish letters folded, punctuation dropped, split into words. */
export function nameTokens(s: string): string[] {
  return s.toLocaleLowerCase("tr").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i")
    .replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter((w) => w.length > 1 && !/^(dr|prof|doc|assoc|asst)$/.test(w));
}

/** Same surname, and every given name on the shorter side appears on the longer (middle names allowed). */
export function sameName(a: string, b: string): boolean {
  const x = nameTokens(a), y = nameTokens(b);
  if (!x.length || !y.length || x[x.length - 1] !== y[y.length - 1]) return false;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.length >= 2 && s.slice(0, -1).every((w) => l.slice(0, -1).includes(w));
}

const cache = new Map<string, { at: number; entries: Entry[] }>();
const TTL = 6 * 3600_000;

async function entries(r: Resolver, f: Fetch, now: number): Promise<Entry[]> {
  const hit = cache.get(r.data);
  if (hit && now - hit.at < TTL) return hit.entries;
  const res = await timed(f, r.data, { headers: { "User-Agent": "arta-brain/1 (+https://artaquest.com)" } }, 10_000);
  const body = res.ok ? await capped(res, 2_000_000) : null;
  if (!body) throw new Error(`faculty data HTTP ${res.status}`);
  const list = r.parse(new TextDecoder().decode(body));
  cache.set(r.data, { at: now, entries: list });
  return list;
}

/** A photo for this person from an official faculty listing, or null (no site, no unique match, no photo). */
export async function facultyPhoto(p: Person, gray: boolean, f: Fetch = fetch, log: (s: string) => void = () => {}, now = Date.now()): Promise<Photo | null> {
  for (const r of RESOLVERS) {
    if (!r.affiliation.test(p.affiliation)) continue;
    try {
      const hits = (await entries(r, f, now)).filter((e) => sameName(e.name, p.name));
      if (hits.length !== 1) { log(`faculty photo: ${hits.length} matches for "${p.name}" at ${r.page}`); continue; }
      const file = hits[0].photo.trim();
      if (!file || /placeholder/i.test(file) || !/^[\w.-]+\.(jpe?g|png|webp)$/i.test(file)) continue;
      return { url: r.photoBase + encodeURIComponent(file), page: r.page, gray };
    } catch (e) { log(`faculty photo: ${(e as Error).message}`); }
  }
  return null;
}

export function clearFacultyCache() { cache.clear(); }
