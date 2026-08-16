/**
 * Who owns the right column, and how the phone opens search.
 *
 * The hooks live here rather than beside the components in `components/RightRail.tsx` because a
 * module that exports both components and plain functions breaks Fast Refresh (and the lint rule
 * that guards it). Same reason `lib/` holds every other cross-component primitive.
 *
 * A module-level counter, not context: the two rail owners (the feed's Highlights aside and
 * PageRail's <WithRail>) are rendered by ROUTES, so there is no provider AppShell could wrap them
 * in. `useLayoutEffect` is load-bearing — with `useEffect` the shell's column paints for one frame
 * before the page's own column claims it, and the feed flickers two search fields on every
 * navigation.
 */
import { useLayoutEffect, useSyncExternalStore } from "react";

let owners = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

/** Call from a page that renders its own right column, so the shell does not add a second one. */
export function useOwnsRail() {
  useLayoutEffect(() => {
    owners += 1; emit();
    return () => { owners -= 1; emit(); };
  }, []);
}

/** True while some page on screen owns the right column. */
export function usePageOwnsRail() {
  return useSyncExternalStore(subscribe, () => owners > 0, () => true);
}

/** Open the phone's search surface from anywhere (bottom tab bar, nav drawer). */
export function openSearch() {
  window.dispatchEvent(new Event("aq:search"));
}
