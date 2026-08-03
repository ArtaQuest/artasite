// Dismiss the server-painted #aq-boot-screen (the branded full-viewport loader the WP template emits,
// see theme template-aq-app.php) — fade it out, then remove it.
//
// Timing (VISUAL): keep the loader up until the matched route's lazy chunk has actually loaded AND
// painted, not merely until React's first commit (which is the bare <Suspense> "Loading…" fallback).
// So this is called from <BootGate>, which sits inside the same Suspense as <Routes> and thus mounts
// only once real content is on the canvas — the visitor sees the branded loader, then the page, with
// no "Loading…" flash in between. (The CLS *score* is fixed separately, by the min-h-screen Suspense
// fallback keeping the loaded-in footer below the fold: layout shift is scored by geometry, not by
// what's painted on top, so covering the reflow with this loader does not by itself reduce CLS.)
//
// Idempotent: also called from a fallback timer in main.tsx (and the route error boundary), so a
// route chunk that never resolves (offline, a 404'd asset) can't trap the visitor behind the loader.

let dismissed = false;

export function dismissBootScreen(): void {
  if (dismissed || typeof document === "undefined") return;
  const boot = document.getElementById("aq-boot-screen");
  if (!boot) {
    dismissed = true; // dev (Vite #root) has no boot screen — nothing to do, and don't re-query.
    return;
  }
  dismissed = true;
  boot.classList.add("aqb-hide");
  const done = () => boot.remove();
  boot.addEventListener("transitionend", done, { once: true });
  // Fallback if transitionend never fires (reduced-motion, or the node was detached mid-transition).
  setTimeout(done, 600);
}
