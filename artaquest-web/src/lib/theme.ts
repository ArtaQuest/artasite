/**
 * Dark/light theme switch (ticket #44) — Kaggle-style.
 *
 * The theme is a `data-theme` attribute on <html>; every colour in the app derives
 * from the @theme tokens in index.css, which a single html[data-theme="light"]
 * block overrides. The SHELL (template-aq-app.php in prod, index.html in dev) sets
 * the attribute with an inline script BEFORE first paint — saved choice first
 * (localStorage "aq_theme"), else light for anonymous visitors, dark for members —
 * so there is never a flash of the wrong theme. This module is the client-side
 * owner of the SAME rule: it re-derives the default defensively and applies
 * changes from the toggle.
 *
 * The preference is device-local (localStorage) — radical-transparency rules out
 * per-user server state we don't need (the DB is public), and it keeps GETs CDN-cacheable.
 */
import { useEffect, useState } from "react";
import { isLoggedIn } from "./wp";

export type Theme = "dark" | "light";

const KEY = "aq_theme";
/* Address-bar / PWA chrome colour per theme — mirrors --color-space-1. */
const META_COLOR: Record<Theme, string> = { dark: "#0d0d0f", light: "#f6f7f9" };

function saved(): Theme | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === "dark" || t === "light" ? t : null;
  } catch {
    return null; // storage blocked (private mode) — fall through to the default
  }
}

/** The active theme: the <html> attribute (set pre-paint by the shell), else the
 *  saved choice, else the role default — light for anonymous visitors, dark for members. */
export function currentTheme(): Theme {
  if (typeof document !== "undefined") {
    const t = document.documentElement.getAttribute("data-theme");
    if (t === "dark" || t === "light") return t;
  }
  return saved() ?? (isLoggedIn() ? "dark" : "light");
}

/** Apply + persist a theme: <html data-theme>, the browser-chrome colour, localStorage. */
export function applyTheme(t: Theme): void {
  document.documentElement.setAttribute("data-theme", t);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", META_COLOR[t]);
  try { localStorage.setItem(KEY, t); } catch { /* private mode — theme still applies for this page */ }
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}

// ── the ArtaContrast Motion-calm control (operator 2026-07-17) ───────────────
// Every video deliverable carries a measured change-rate CALM score (0–100, higher = calmer).
// The member picks one of FIVE stops, mirroring the text-contrast slider. The stops are not
// fixed values: the server derives each stop's threshold from the PERCENTILES of the platform's
// own measured distribution (pulse.calm_thresholds) — "Standard" always flags half of the
// existing video content. A flagged video is never hidden; it simply DOES NOT AUTOPLAY.

const CALM_KEY = "aq_calm_stop";
export const CALM_STOPS = ["Still", "Gentle", "Standard", "Lively", "All"] as const;

/** The member's Motion-calm stop, 1 (strictest) … 5 (everything autoplays). Default Standard. */
export function calmStop(): number {
  try {
    const v = Math.round(Number(localStorage.getItem(CALM_KEY)));
    return v >= 1 && v <= 5 ? v : 3;
  } catch { return 3; }
}

/** Persist the Motion-calm stop and broadcast it (cards re-evaluate flags on "aq:calm"). */
export function setCalmStop(v: number): number {
  const clamped = Math.max(1, Math.min(5, Math.round(v)));
  try { localStorage.setItem(CALM_KEY, String(clamped)); } catch { /* private mode */ }
  window.dispatchEvent(new Event("aq:calm"));
  return clamped;
}

// Read once at module load: the MediaQueryList object is live, only the listener is per-component.
const REDUCE_Q = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
const motionSuppressed = () => (REDUCE_Q?.matches ?? false) || calmStop() === 1;

/**
 * Is motion suppressed for this member right now? OS "reduce motion" OR the strictest Motion-calm
 * stop ("Still") — the same pair ttsCalmMode() reads, because it is the same contract.
 *
 * THE PLATFORM OWNS THIS DECISION, not the individual file or component. It lives here, beside
 * calmStop and the "aq:calm" broadcast it listens to, so that every surface that moves — an
 * animated scene, an audio spectrum, a teaser — answers the question identically. It was defined
 * privately inside the Library kit until the audio players needed it too, and a second copy in the
 * main bundle would have been free to drift from this one.
 */
export function useMotionOff(): boolean {
  const [off, setOff] = useState(motionSuppressed);
  useEffect(() => {
    const on = () => setOff(motionSuppressed());
    REDUCE_Q?.addEventListener("change", on);
    window.addEventListener("aq:calm", on);  // the Motion-calm slider, live
    return () => { REDUCE_Q?.removeEventListener("change", on); window.removeEventListener("aq:calm", on); };
  }, []);
  return off;
}
