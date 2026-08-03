/**
 * I18nGate — drives the client translation engine and gates the UI behind a
 * translated loader so a half-translated page is never shown.
 *
 * Two modes:
 *  - Non-source language (e.g. /es/, /ar/): the whole UI is translated. An opaque,
 *    already-translated loading screen covers the first paint (and any first-visit
 *    route) until translation finishes — no untranslated component is ever shown.
 *  - Source language (English): the engine still runs, but only to translate
 *    foreign user-generated content (global discussions) into English in place —
 *    no full-screen overlay (the English chrome needs no translation).
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { getEngine, bootText, isSourceLang } from "../lib/i18n";

function Loader() {
  // Inline styles only — the overlay must paint correctly even before/without the
  // Tailwind bundle, on the canvas the boot CSS already established. Colours come from
  // the theme tokens (with dark fallbacks) so the loader follows dark/light mode (#44).
  return (
    <div
      data-ay-skip="1"
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483600,
        display: "grid",
        placeItems: "center",
        background: "var(--color-space-1, #0d0d0f)",
        color: "var(--color-ink, #f4f4f5)",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        textAlign: "center",
        padding: "24px",
        animation: "aqI18nFade .2s ease",
      }}
    >
      <style>{`@keyframes aqI18nSpin{to{transform:rotate(360deg)}}@keyframes aqI18nFade{from{opacity:.7}to{opacity:1}}@media(prefers-reduced-motion:reduce){.aqI18nDisc{animation:none!important}}`}</style>
      <div style={{ maxWidth: "30rem" }}>
        <div
          className="aqI18nDisc"
          aria-hidden="true"
          style={{
            width: 40,
            height: 40,
            margin: "0 auto 20px",
            borderRadius: "50%",
            border: "3px solid color-mix(in srgb, var(--color-veil, #fff) 12%, transparent)",
            borderTopColor: "var(--color-yang)",
            animation: "aqI18nSpin .7s linear infinite",
          }}
        />
        <p style={{ margin: "0 0 8px", fontSize: "1.0625rem", fontWeight: 600 }}>
          {bootText("Preparing this page in your language")}
        </p>
        <p style={{ margin: 0, fontSize: ".875rem", lineHeight: 1.6, color: "var(--color-ink-2, rgba(255,255,255,.6))" }}>
          {bootText("First time in this language — this takes a moment, then it loads instantly for everyone.")}
        </p>
      </div>
    </div>
  );
}

export function I18nGate({ children }: { children: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(typeof navigator === "undefined" || navigator.onLine);
  const loc = useLocation();
  const started = useRef(false);
  const firstNav = useRef(true);
  // Only the non-source language gets the full-screen gate; English translates foreign content in
  // place without covering the page. AND never gate while OFFLINE: translation needs the network, so
  // a blocking "preparing in your language" loader would just cover the page (or the offline error
  // notice) — exactly the "stays black offline" report. Offline we reveal immediately with whatever's
  // cached (a downloaded language pack, else the source text).
  const overlay = !isSourceLang() && online;

  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  // Boot the engine once; mirror its busy state into the overlay.
  useEffect(() => {
    const eng = getEngine();
    if (!eng) return;
    const unsub = eng.subscribe(setBusy);
    if (!started.current) {
      started.current = true;
      void eng.start();
    }
    return unsub;
  }, []);

  // Re-translate on client-side route changes (the first nav is the engine's
  // initial pass, already handled by start()).
  useEffect(() => {
    if (firstNav.current) {
      firstNav.current = false;
      return;
    }
    const eng = getEngine();
    if (eng) void eng.route();
  }, [loc.pathname, loc.search]);

  return (
    <>
      {children}
      {overlay && busy ? <Loader /> : null}
    </>
  );
}
