/**
 * The Explore hub's search hook — the single seam where the server-backed domains (courses,
 * discussions, grants via GET /search) are merged with the CLIENT-side domains (topics from the
 * typology JSON, causes from the donation-targets payload) into one SearchResults shape. The page
 * stays presentational and never has to know which domains are server- vs client-searched.
 *
 * Debounced + sequence-guarded (a stale in-flight response can't overwrite a newer query), and it
 * only searches once the query is ≥2 chars. Topics/causes data is loaded lazily and cached.
 */
import { useEffect, useRef, useState } from "react";
import { Search, type SearchResults, type SearchTopic, type SearchGroupHit, type SearchCause } from "./api";
import { loadTypologies, resolveImage, emblemUrl, SYSTEMS, statusLabel } from "./typologies";
import { getTypologyTargets } from "./wp";

const MIN_LEN = 2;
const DEBOUNCE = 250;

/** Causes (donation targets) are a small aggregated set — fetch once, reuse across queries. */
let causesCache: SearchCause[] | null = null;
async function loadCauses(): Promise<SearchCause[]> {
  if (causesCache) return causesCache;
  const t = await getTypologyTargets();
  causesCache = t.systems.flatMap((s) =>
    s.types.map((ty) => ({ key: `${s.key}:${ty.key}`, name: ty.label, sub: s.name, members: ty.count, raised: ty.raised })),
  );
  return causesCache;
}

/** Filter the loaded typology SYSTEMS by name/blurb/category/option label/desc/short (matches the Topics page search). */
function topicHits(needle: string, limit: number): SearchTopic[] {
  const out: SearchTopic[] = [];
  for (const s of SYSTEMS) {
    const hay = `${s.key} ${s.name} ${s.blurb} ${s.category}`.toLowerCase();
    const inOpts = (s.options || []).some((o) =>
        (o.label || "").toLowerCase().includes(needle) ||
        (o.short || "").toLowerCase().includes(needle) ||
        (o.desc || "").toLowerCase().includes(needle)
      )
      || (s.dimensions || []).some((d) =>
        (d.name || "").toLowerCase().includes(needle) ||
        (d.desc || "").toLowerCase().includes(needle)
      );
    if (hay.includes(needle) || inOpts) {
      out.push({
        key: s.key, name: s.name, status: statusLabel(s.status), empirical: s.status === "empirical",
        blurb: s.blurb, count: s.options?.length || s.dimensions?.length || 0, category: s.category,
        image: resolveImage(s.image),
      });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Surface the individual GROUPS within topics (the Topics UI's word for an option — the fandom
 *  character groups, the MBTI types, the houses…) whose label/short/desc matches, each linking back
 *  to its parent topic. This lets a search for e.g. "Gryffindor" or "INTJ" return that group itself,
 *  not only its parent system. Every hit carries an image (the option's headshot, else its on-brand
 *  emblem) so a result is never a bare letter avatar — matching the Topics/Profile group rows. */
function groupHits(needle: string, limit: number): SearchGroupHit[] {
  const out: SearchGroupHit[] = [];
  for (const s of SYSTEMS) {
    for (const o of s.options || []) {
      const matches =
        (o.label || "").toLowerCase().includes(needle) ||
        (o.short || "").toLowerCase().includes(needle) ||
        (o.desc || "").toLowerCase().includes(needle);
      if (!matches) continue;
      out.push({
        key: `${s.key}:${o.key}`, label: o.label, topic: s.name, topicKey: s.key,
        desc: o.desc, image: resolveImage(o.image) || emblemUrl(o.key, o.label),
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function causeHits(needle: string, limit: number): SearchCause[] {
  if (!causesCache) return [];
  return causesCache.filter((c) => `${c.name} ${c.sub}`.toLowerCase().includes(needle)).slice(0, limit);
}

export function useCatalogueSearch(q: string, limit = 8): { data: SearchResults | null; loading: boolean; failed: boolean } {
  const [data, setData] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < MIN_LEN) { setData(null); setLoading(false); setFailed(false); return; }
    const mine = ++seq.current;
    setLoading(true); setFailed(false);
    const timer = setTimeout(async () => {
      try {
        // Server domains + the lazy client data in parallel; SYSTEMS/causesCache are populated by the awaits.
        const [server] = await Promise.all([Search.all(q.trim(), { limit }), loadTypologies(), loadCauses()]);
        if (mine !== seq.current) return; // a newer query superseded this one
        setData({
          q: server.q,
          results: {
            ...server.results,
            topics: { items: topicHits(needle, limit), next: null },
            groups: { items: groupHits(needle, limit), next: null },
            causes: { items: causeHits(needle, limit), next: null },
          },
        });
        setLoading(false);
      } catch {
        if (mine !== seq.current) return;
        setFailed(true); setLoading(false);
      }
    }, DEBOUNCE);
    return () => clearTimeout(timer);
  }, [q, limit]);

  return { data, loading, failed };
}
