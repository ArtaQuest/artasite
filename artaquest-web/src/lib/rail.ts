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
export function useRail(enabled = true) {
  const [challenges, setChallenges] = useState<Challenge[] | null>(null);
  const [news, setNews] = useState<NewsItem[] | null>(null);
  const [headlines, setHeadlines] = useState<TrendingKindItem[] | null>(null);
  const [topics, setTopics] = useState<TrendingTopic[] | null>(null);
  const [who, setWho] = useState<FollowSuggestion[] | null>(null);
  useEffect(() => {
    if (!enabled) { setChallenges([]); setWho([]); setNews([]); setHeadlines([]); setTopics([]); return; }
    listChallenges().then((r) => setChallenges([...r.current].sort((a, b) => a.deadline - b.deadline))).catch(() => setChallenges([]));
    listNews(4).then((r) => setNews(r.items)).catch(() => setNews([]));
    // ONE fetch feeds both X-style cards (operator 2026-07-30). The headlines and the topics come
    // out of the same 6h-refreshed crawl, so the two can never disagree about what is trending.
    scholarTrending().then((r) => {
      setHeadlines(r.kinds?.find((k) => k.kind === "news")?.items ?? []);
      setTopics(r.topics ?? []);
    }).catch(() => { setHeadlines([]); setTopics([]); });
    const me = currentUser();
    Promise.all([
      suggestFollow().then((r) => r.items).catch(() => [] as FollowSuggestion[]),
      // The suggestions GET is unpersonalised (CDN-safe); the viewer + already-followed drop here.
      isLoggedIn() ? Social.feed(0, 1).then((r) => r.followed || []).catch(() => [] as number[]) : Promise.resolve([] as number[]),
    ]).then(([items, followed]) => {
      const skip = new Set<number>(followed);
      setWho(items.filter((s) => s.slug !== me?.slug && !skip.has(s.id)).slice(0, 3));
    });
  }, [enabled]);
  return { challenges, news, headlines, topics, who };
}
