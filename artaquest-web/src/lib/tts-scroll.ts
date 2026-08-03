// ArtaTTS smooth scroll-follow — keeps the word being spoken inside a comfort band of the viewport,
// on mobile and desktop, without ever fighting the reader. Requirement: the highlight must ALWAYS stay
// in sync with speech and scroll smoothly (operator, 2026-07-20).
//
// Design (grounded research): don't scrollIntoView({block:'center'}) per word — that re-centres on every
// word and fights momentum scrolling. Instead keep the active element inside a 35-45% band and only
// scroll when it leaves the band (≈ once per line). Any manual scroll (wheel / touch / key / pointer)
// suspends auto-follow for RESUME_MS, then it resumes. Works against BOTH an overflow container (the
// ReadMode overlay has its own scroll) and the window. Honours prefers-reduced-motion. rAF-lerp fallback
// where scrollTo({behavior:'smooth'}) is unavailable (iOS < 15.4).

const BAND_TOP = 0.35; // comfort band top, as a fraction of the scrollport height
const BAND_BOT = 0.45; // comfort band bottom
const BAND_MID = (BAND_TOP + BAND_BOT) / 2;
const RESUME_MS = 2500; // resume auto-follow this long after the reader last scrolled by hand

type Scroller = HTMLElement | Window;

/** A thing with a client rect — an Element or a Range (word highlights are Ranges, not Elements). */
type Rectable = { getClientRects: () => DOMRectList; getBoundingClientRect: () => DOMRect };

export type ScrollFollower = {
  /** Bring `target` into the comfort band if it has drifted out (no-op while the user is scrolling). */
  follow: (target: Rectable | null | undefined) => void;
  /** Tear down listeners + any in-flight animation. */
  destroy: () => void;
};

function reduceMotion(): boolean {
  try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}
function smoothSupported(): boolean {
  try { return "scrollBehavior" in document.documentElement.style; } catch { return false; }
}

export function makeScrollFollower(scroller: Scroller, forceReduce = false): ScrollFollower {
  const isWin = scroller === window || scroller === (document.defaultView as unknown);
  const target: EventTarget = isWin ? window : (scroller as HTMLElement);
  const reduce = forceReduce || reduceMotion(); // calm mode / OS reduce-motion → instant, no scroll animation
  const canSmooth = smoothSupported();

  let userScrolling = false;
  let resumeTimer = 0;
  let raf = 0;
  let destroyed = false;

  const scrollEl = (): HTMLElement =>
    isWin ? (document.scrollingElement as HTMLElement) || document.documentElement : (scroller as HTMLElement);
  const viewTop = (): number => (isWin ? 0 : (scroller as HTMLElement).getBoundingClientRect().top);
  const viewH = (): number => (isWin ? window.innerHeight : (scroller as HTMLElement).clientHeight);
  const curScroll = (): number => scrollEl().scrollTop;
  const maxScroll = (): number => { const e = scrollEl(); return Math.max(0, e.scrollHeight - e.clientHeight); };

  const onUserIntent = (e: Event) => {
    // Interacting with the reader's own controls (play/next/voice/speed) is NOT the user scrolling —
    // those live inside the scroll container, so without this guard every button tap would suspend
    // auto-follow and the highlight would drift off-screen.
    const t = e.target as Element | null;
    if (t?.closest?.(".aq-read-bar,.aq-tts-ui,.aq-listen,button,select,input,[role='group']")) return;
    userScrolling = true;
    if (raf) { cancelAnimationFrame(raf); raf = 0; } // abandon a programmatic animation the user interrupted
    clearTimeout(resumeTimer);
    resumeTimer = window.setTimeout(() => { userScrolling = false; }, RESUME_MS);
  };
  const INTENT = ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"] as const;
  for (const ev of INTENT) target.addEventListener(ev, onUserIntent, { passive: true });

  const animateTo = (to: number) => {
    const clamped = Math.max(0, Math.min(to, maxScroll()));
    const el = scrollEl();
    if (reduce || !canSmooth) {
      // Instant (reduced-motion) or manual lerp fallback (no native smooth).
      if (reduce) { el.scrollTop = clamped; return; }
      const from = el.scrollTop;
      const dist = clamped - from;
      if (Math.abs(dist) < 1) return;
      const t0 = performance.now();
      const DUR = 320;
      const step = (now: number) => {
        if (destroyed || userScrolling) { raf = 0; return; }
        const p = Math.min(1, (now - t0) / DUR);
        const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // easeInOutQuad
        el.scrollTop = from + dist * ease;
        raf = p < 1 ? requestAnimationFrame(step) : 0;
      };
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(step);
      return;
    }
    // Native smooth scroll on the right scrollport.
    try {
      if (isWin) window.scrollTo({ top: clamped, behavior: "smooth" });
      else (scroller as HTMLElement).scrollTo({ top: clamped, behavior: "smooth" });
    } catch { el.scrollTop = clamped; }
  };

  const follow = (target: Rectable | null | undefined) => {
    if (destroyed || userScrolling || !target) return;
    const rects = target.getClientRects();
    const r = rects.length ? rects[0] : target.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) return;
    const relTop = r.top - viewTop(); // active element's top within the scrollport
    const h = viewH();
    if (relTop >= h * BAND_TOP && relTop <= h * BAND_BOT) return; // still comfy → throttle (do nothing)
    animateTo(curScroll() + (relTop - h * BAND_MID));
  };

  const destroy = () => {
    destroyed = true;
    for (const ev of INTENT) target.removeEventListener(ev, onUserIntent);
    clearTimeout(resumeTimer);
    if (raf) cancelAnimationFrame(raf);
  };

  return { follow, destroy };
}
