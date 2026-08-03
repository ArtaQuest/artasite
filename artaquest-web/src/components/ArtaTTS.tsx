// ArtaTTS launcher — mounted once in App. Watches the member's text selection anywhere on the site;
// when a big enough passage is selected a small "Listen" pill appears by the selection, and tapping it
// opens the ArtaTTS reader (artatts-player.tsx, lazy), which reads the passage sentence by sentence in
// the chosen voice/speed with a live word-follow highlight that scrolls smoothly to stay in view.
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { primeTtsEngines } from "../lib/tts-prime";

const Player = lazy(() => import("./artatts-player"));

const MIN_CHARS = 80; // "big text" — don't offer the reader for a stray word or two

export function ArtaTTS() {
  const [pill, setPill] = useState<{ x: number; y: number } | null>(null);
  const [session, setSession] = useState<{ range: Range; key: number } | null>(null);
  const candidateRef = useRef<Range | null>(null);
  const sessionRef = useRef<typeof session>(null);
  const keyRef = useRef(0);
  sessionRef.current = session;

  useEffect(() => {
    let t = 0;
    const check = () => {
      // Stand down while the reader owns speech (ReadMode) OR while our own player is open — otherwise
      // the player's selection-fallback highlight (browsers without the Highlight API move the native
      // selection) would re-fire selectionchange and re-summon this pill mid-read.
      if (document.documentElement.hasAttribute("data-aq-reading") || sessionRef.current) { setPill(null); return; }
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || sel.toString().trim().length < MIN_CHARS) { setPill(null); return; }
      const r = sel.getRangeAt(0);
      const anchor = r.commonAncestorContainer;
      const el = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
      if (!el || el.closest("input,textarea,[contenteditable],.aq-tts-ui")) { setPill(null); return; }
      const rects = r.getClientRects();
      const last = rects.length ? rects[rects.length - 1] : r.getBoundingClientRect();
      if (!last || (last.width === 0 && last.height === 0)) { setPill(null); return; }
      candidateRef.current = r.cloneRange();
      setPill({
        x: Math.min(Math.max(last.right, 56), window.innerWidth - 56),
        y: Math.min(Math.max(last.bottom + 10, 16), window.innerHeight - 56),
      });
    };
    const onSel = () => { clearTimeout(t); t = window.setTimeout(check, 250); };
    const onScroll = () => setPill(null); // its anchor rect is stale the moment the page scrolls
    document.addEventListener("selectionchange", onSel);
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => {
      document.removeEventListener("selectionchange", onSel);
      window.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
      clearTimeout(t);
    };
  }, []);

  // If ReadMode opens while our floating player is up, close the player. It and the reader's embedded
  // Listen share ONE <audio> element + the global speechSynthesis (tts-prime.ts), so two live sessions
  // would clobber each other's handlers/src/currentTime and cross-cut teardown. ReadMode owns speech —
  // the pill already stands down (check() above); this stands the whole player down too.
  useEffect(() => {
    const de = document.documentElement;
    const mo = new MutationObserver(() => {
      if (de.hasAttribute("data-aq-reading") && sessionRef.current) { setSession(null); setPill(null); }
    });
    mo.observe(de, { attributes: true, attributeFilter: ["data-aq-reading"] });
    return () => mo.disconnect();
  }, []);

  const open = () => {
    const r = candidateRef.current;
    if (!r) return;
    primeTtsEngines(); // unlock audio + speechSynthesis INSIDE this tap (iOS) before the player mounts
    setPill(null);
    setSession({ range: r, key: ++keyRef.current }); // new key remounts the player per selection
  };

  return (
    <>
      {pill && (
        <button
          type="button"
          className="aq-tts-ui fixed z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-space-1/95 px-3 py-1.5 text-[12.5px] font-semibold text-ink shadow-[0_8px_24px_rgba(0,0,0,.4)] backdrop-blur hover:border-yin"
          style={{ left: pill.x, top: pill.y }}
          onPointerDown={(e) => e.preventDefault()} // keep the selection alive through the click
          onClick={open}
          aria-label="Listen to the selected text"
          title="Listen — ArtaTTS reads the selection aloud"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.6 5.4a9 9 0 0 1 0 13.2" />
          </svg>
          Listen
        </button>
      )}
      {session && (
        <Suspense fallback={null}>
          <Player key={session.key} range={session.range} onClose={() => setSession(null)} />
        </Suspense>
      )}
    </>
  );
}
