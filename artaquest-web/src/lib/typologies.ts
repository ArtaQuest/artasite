/**
 * The full Typology registry — an exhaustive, neutrally-described catalogue of personality
 * typologies and identity self-identification systems (see pages/Typology.tsx). The descriptive
 * data lives in the generated typologies.data.json (built + adversarially fact-checked offline).
 *
 * This module imports that ~190 KB JSON, so it is only pulled in by the lazy-loaded Typology page.
 * Lightweight types, CATEGORIES, and the system-independent helpers live in typology-meta.ts (which
 * the Profile page and wp client import instead); they are re-exported here for the page's convenience.
 *
 * Everything a member selects is PUBLIC by design — choosing a group is itself the public statement,
 * and group self-identification is what gates the group donation classes.
 */
// The ~900 KB descriptive dataset is loaded at RUNTIME as a separate JSON asset (Vite's `?url`
// emits the file rather than inlining it into this chunk). Inlining it bloated the Typology page
// chunk to 636 KB of JS the browser had to parse before the page was interactive; fetched as a JSON
// asset it parses with native JSON.parse, downloads in parallel, and caches independently — better
// LCP/INP on a page that can rank for high-volume queries (MBTI, Enneagram, …). Call loadTypologies()
// (idempotent) and await it before reading SYSTEMS; the page gates its grid on that.
import dataUrl from "./typologies.data.json?url";
import { CATEGORIES, resolveImage, type Selection, type Selections, type SpectrumLevel, type TypologySystem, type TypologyTag } from "./typology-meta";

export * from "./typology-meta";

type TypologyData = { version: number; categories: unknown; systems: TypologySystem[]; renames?: Record<string, string> };

// Mutable, populated by loadTypologies(). `export let` gives importers a live binding, so the page's
// SYSTEMS reference updates once the data arrives (it re-renders on the dataReady flag).
export let SYSTEMS: TypologySystem[] = [];
let systemIndex: Record<string, TypologySystem> = {};
// old-key → current-key aliases for topics whose key was renamed after creation (#141), so any stale
// link or saved reference still resolves to the system under its current key.
let renames: Record<string, string> = {};
let loadPromise: Promise<void> | null = null;

/** Fetch + index the typology dataset once (idempotent). Resolves when SYSTEMS is populated.
 *  Topics are now DB-backed (GET /aq/v1/topics) so each is authored, editable in Studio, and
 *  sponsorable — and an edit goes live without a redeploy. Falls back to the build-time JSON asset
 *  if the API is unreachable, so these high-SEO pages (MBTI, Enneagram, …) never render empty. */
export function loadTypologies(): Promise<void> {
  if (!loadPromise) {
    const ingest = (raw: TypologyData) => {
      SYSTEMS = raw.systems ?? [];
      systemIndex = Object.fromEntries(SYSTEMS.map((s) => [s.key, s]));
      renames = raw.renames ?? {};
    };
    loadPromise = fetch("/wp-json/aq/v1/topics")
      .then((r) => { if (!r.ok) throw new Error("topics " + r.status); return r.json(); })
      .then(ingest)
      .catch(() => fetch(dataUrl).then((r) => r.json()).then(ingest).catch(() => { /* empty state, never crash */ }));
  }
  return loadPromise;
}

/** True once the dataset has been loaded (lets callers/render gate without holding the promise). */
export function typologiesReady(): boolean {
  return SYSTEMS.length > 0;
}

/** Resolve a (possibly renamed) system key to its CURRENT canonical key — transitive + cycle-guarded.
 *  An unknown / already-canonical key returns unchanged. Mirrors Typology::canonical_key on the server. */
export function canonicalKey(key: string): string {
  const seen = new Set<string>();
  let k = key;
  while (renames[k] && !seen.has(k)) { seen.add(k); k = renames[k]; }
  return k;
}

export function findSystem(key: string): TypologySystem | undefined {
  return systemIndex[key] ?? systemIndex[canonicalKey(key)];
}

/** The profile picture for a resolved public tag: the picked option's headshot (ticket #66) when
 *  the tag is a pick, else the system's group picture (ticket #67). '' when neither exists or the
 *  registry hasn't loaded yet — callers keep the letter avatar, exactly like the Topics page. */
export function tagImage(tag: TypologyTag): string {
  const sys = findSystem(tag.systemKey);
  if (!sys) return "";
  const opt = sys.options?.find((o) => o.key === tag.key);
  return resolveImage(opt?.image || sys.image);
}

export function systemsInCategory(catKey: string): TypologySystem[] {
  return SYSTEMS.filter((s) => s.category === catKey);
}

const LEVEL_WORD: Record<SpectrumLevel, string> = { low: "Low", mid: "Balanced", high: "High" };

/** Resolve one system's selection into display tags (used to render a member's public profile,
 *  and to send the server a ready-made, human-readable tag list for the group donation classes). */
export function selectionTags(sys: TypologySystem, sel: Selection): TypologyTag[] {
  const out: TypologyTag[] = [];
  const base = { system: sys.name, systemKey: sys.key, category: sys.category };
  for (const k of sel.picks ?? []) {
    const o = sys.options?.find((x) => x.key === k);
    if (o) out.push({ ...base, key: k, label: o.label, short: o.short || o.label });
  }
  if (sel.levels) {
    for (const [dimKey, lvl] of Object.entries(sel.levels)) {
      const d = sys.dimensions?.find((x) => x.key === dimKey);
      if (!d) continue;
      const label = lvl === "high" ? d.high : lvl === "low" ? d.low : `${d.name} — balanced`;
      out.push({ ...base, key: `${dimKey}:${lvl}`, label, short: `${LEVEL_WORD[lvl]} ${d.name}` });
    }
  }
  if (sel.self && sel.self.trim()) {
    const t = sel.self.trim();
    out.push({ ...base, key: "self", label: t, short: t });
  }
  return out;
}

/** Re-resolve a STORED public tag's display fields (system, category, label, short) against the
 *  CURRENT registry. A saved tag is a denormalized snapshot frozen when the member added it
 *  (Extra::typologies_save persists the resolved wording, not just the keys); its `systemKey`/`key`
 *  stay stable, but a chip's wording can later change (e.g. ticket #86 re-labelled the tropical Sun
 *  signs from a bare sign + date range to "Sun in <sign>"). The profile renders these snapshots, so
 *  without this they stay stale until the member removes and re-adds the chip. We look the tag back up
 *  by its stable keys and re-derive its wording with the SAME rules selectionTags() uses on save — so
 *  a re-resolved tag is identical to a freshly re-added one. Fail-open exactly like tagImage(): if the
 *  registry hasn't loaded, or the system/option no longer exists, the stored values pass through. A
 *  free-text `self` tag is the member's own words (never in the registry), so only its system/category
 *  refresh; its label/short are kept verbatim. */
export function resolveTag(tag: TypologyTag): TypologyTag {
  const sys = findSystem(tag.systemKey);
  if (!sys) return tag;
  const base: TypologyTag = { ...tag, system: sys.name, category: sys.category };
  if (tag.key === "self") return base;
  const lvl = /^(.+):(low|mid|high)$/.exec(tag.key);
  if (lvl) {
    const d = sys.dimensions?.find((x) => x.key === lvl[1]);
    if (!d) return base;
    const l = lvl[2] as SpectrumLevel;
    const label = l === "high" ? d.high : l === "low" ? d.low : `${d.name} — balanced`;
    return { ...base, label, short: `${LEVEL_WORD[l]} ${d.name}` };
  }
  const o = sys.options?.find((x) => x.key === tag.key);
  return o ? { ...base, label: o.label, short: o.short || o.label } : base;
}

/** Resolve a whole selection map into a flat, ordered list of public tags. */
export function selectionsToTags(selections: Selections): TypologyTag[] {
  const out: TypologyTag[] = [];
  for (const sys of SYSTEMS) {
    const sel = selections[sys.key];
    if (sel) out.push(...selectionTags(sys, sel));
  }
  return out;
}

/** Total number of public tags across every system (for the page's save bar). */
export function totalTagCount(selections: Selections): number {
  let n = 0;
  for (const sys of SYSTEMS) {
    const sel = selections[sys.key];
    if (sel) n += selectionTags(sys, sel).length;
  }
  return n;
}

// CATEGORIES is the canonical list from typology-meta; re-exported via `export *` above. Referenced
// here so a future drift between it and the generated data.categories can be asserted if needed.
void CATEGORIES;
