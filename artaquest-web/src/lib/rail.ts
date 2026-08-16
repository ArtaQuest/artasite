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
import { useEffect, useState, useSyncExternalStore } from "react";

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

/** Open the phone's search surface from anywhere (bottom tab bar, nav drawer). */
export function openSearch() {
  window.dispatchEvent(new Event("aq:search"));
}
