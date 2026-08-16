/**
 * THE ONE RIGHT COLUMN — the shell owns it; pages fill it.
 *
 * The first version of this was an ownership handshake: a page with its own aside registered, and
 * the shell stood its column down. That has a failure mode I shipped — a page can register and then
 * render NOTHING (signed out, still loading, an error state), and the viewer gets no column and no
 * search at all. /calendar did exactly that to a signed-out reader.
 *
 * So the shell now always renders the column, and a page contributes cards INTO it through a
 * portal. There is no state in which the column can go missing, because nothing can turn it off.
 *
 * `wide` gates the portal on the same 1024px breakpoint the column itself uses: below it there is
 * no column, so a page's cards must stay where they are in the flow (or be suppressed, for pages
 * that already render their own phone copies).
 */
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import {
  listChallenges, listNews, scholarTrending, suggestFollow, Social,
  type Challenge, type FollowSuggestion, type NewsItem, type TrendingKindItem, type TrendingTopic,
} from "./api";
import { isLoggedIn } from "./auth";
import { currentUser } from "./wp";

let node: HTMLElement | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

/** The shell calls this with the element its cards should mount into (null on unmount). */
export function setRailNode(el: HTMLElement | null) {
  if (node === el) return;
  node = el;
  emit();
}

/** The live portal target, or null before the column has mounted. */
export function useRailNode() {
  return useSyncExternalStore(subscribe, () => node, () => null);
}

/** True at lg and up — where the right column exists. Kept in sync with Tailwind's lg (1024px). */
export function useWide() {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return wide;
}

let fillers = 0;
const fillerListeners = new Set<() => void>();
const fillerEmit = () => fillerListeners.forEach((f) => f());
const fillerSub = (f: () => void) => { fillerListeners.add(f); return () => { fillerListeners.delete(f); }; };

/** A <RailPortal> announces itself here so the column knows the page brought its own cards. */
export function useIsFilling() {
  useLayoutEffect(() => {
    fillers += 1; fillerEmit();
    return () => { fillers -= 1; fillerEmit(); };
  }, []);
}

/** True while some page is contributing cards — the column then skips its default content. */
export function useRailFilled() {
  return useSyncExternalStore(fillerSub, () => fillers > 0, () => false);
}

/** Open the phone's search surface from anywhere (bottom tab bar, nav drawer). */
export function openSearch() {
  window.dispatchEvent(new Event("aq:search"));
}

/** `enabled=false` (the embedded landing feed) skips the rail entirely — five extra backend calls
 *  a marketing page has no use for, on the one visit where speed matters most. */
export type RailData = {
  challenges: Challenge[] | null; news: NewsItem[] | null;
  headlines: TrendingKindItem[] | null; topics: TrendingTopic[] | null; who: FollowSuggestion[] | null;
};

/**
 * ONE fetch for the whole session, not one per page.
 *
 * These cards used to live on the feed alone, so a fetch per mount cost five requests on the one
 * page a member lands on. They are now in the right column of EVERY page (operator 2026-08-16:
 * "put some stuff to the right"), which turns the same code into five requests per navigation —
 * for cards whose sources refresh on a 6-hour crawl and a challenge deadline measured in weeks.
 *
 * So the payload is cached at module scope with a TTL, and concurrent mounts share the SAME
 * in-flight promise rather than racing five duplicate requests each. Nothing here is personal
 * beyond the follow filter, which is applied per-viewer on read.
 */
const RAIL_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; data: RailData } | null = null;
let inflight: Promise<RailData> | null = null;

const EMPTY_RAIL: RailData = { challenges: [], news: [], headlines: [], topics: [], who: [] };

function fetchRail(): Promise<RailData> {
  if (cache && Date.now() - cache.at < RAIL_TTL_MS) return Promise.resolve(cache.data);
  if (inflight) return inflight;
  const me = currentUser();
  inflight = Promise.all([
    listChallenges().then((r) => [...r.current].sort((a, b) => a.deadline - b.deadline)).catch(() => [] as Challenge[]),
    listNews(4).then((r) => r.items).catch(() => [] as NewsItem[]),
    // ONE fetch feeds both X-style cards (operator 2026-07-30). The headlines and the topics come
    // out of the same 6h-refreshed crawl, so the two can never disagree about what is trending.
    scholarTrending().then((r) => ({
      headlines: r.kinds?.find((k) => k.kind === "news")?.items ?? [],
      topics: r.topics ?? [],
    })).catch(() => ({ headlines: [] as TrendingKindItem[], topics: [] as TrendingTopic[] })),
    suggestFollow().then((r) => r.items).catch(() => [] as FollowSuggestion[]),
    // The suggestions GET is unpersonalised (CDN-safe); the viewer + already-followed drop here.
    isLoggedIn() ? Social.feed(0, 1).then((r) => r.followed || []).catch(() => [] as number[]) : Promise.resolve([] as number[]),
  ]).then(([challenges, news, trending, suggestions, followed]) => {
    const skip = new Set<number>(followed);
    const data: RailData = {
      challenges, news,
      headlines: trending.headlines, topics: trending.topics,
      who: suggestions.filter((s) => s.slug !== me?.slug && !skip.has(s.id)).slice(0, 3),
    };
    cache = { at: Date.now(), data };
    inflight = null;
    return data;
  }).catch(() => { inflight = null; return EMPTY_RAIL; });
  return inflight;
}

export function useRail(enabled = true): RailData {
  // Served straight from cache on a second page, so the column paints filled instead of empty.
  const [data, setData] = useState<RailData>(() => (cache ? cache.data : { challenges: null, news: null, headlines: null, topics: null, who: null }));
  useEffect(() => {
    if (!enabled) { setData(EMPTY_RAIL); return; }
    let live = true;
    fetchRail().then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, [enabled]);
  return data;
}
