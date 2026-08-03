/**
 * Connectivity state for the offline layer. `navigator.onLine` is the baseline; we also expose a
 * subscribe() so the UI (the offline banner, disabled write buttons) reacts to going on/offline.
 */

export function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

type Listener = (online: boolean) => void;
const listeners = new Set<Listener>();

if (typeof window !== "undefined") {
  const fire = () => { const o = isOnline(); listeners.forEach((l) => l(o)); };
  window.addEventListener("online", fire);
  window.addEventListener("offline", fire);
}

/** Subscribe to online/offline changes. Returns an unsubscribe fn. */
export function onConnectivity(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Friendly error thrown when a write (POST) is attempted while offline. */
export class OfflineError extends Error {
  constructor(msg = "You're offline. Posting, voting, and competing need a connection — everything else works offline.") {
    super(msg);
    this.name = "OfflineError";
  }
}
