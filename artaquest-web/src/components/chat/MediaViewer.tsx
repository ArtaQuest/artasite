import { useCallback, useEffect, useRef, useState } from "react";

/** Local, like Messages.tsx's own set: three glyphs is not worth a shared module, and the viewer
 *  stays independent of whatever that page reorganises next. currentColor, same stroke weight. */
function Ic({ d, size = 18 }: { d: React.ReactNode; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
  );
}
const X = <path d="M6 6l12 12M18 6 6 18" />;
const PLUS = <path d="M12 5v14M5 12h14" />;
const MINUS = <path d="M5 12h14" />;

/**
 * The full-screen viewer for a decrypted chat attachment — an image, an animation or a video —
 * with real magnification.
 *
 * WHAT IT REPLACES. The old lightbox was one `<img className="max-h-[92vh] object-contain">`: it
 * fitted the picture to the screen and stopped there. That is fine for a photo and useless for the
 * things people actually send here — a plot with axis labels, a screenshot of a stack trace, a
 * frame of a simulation. You could see that there was text and not read it. Video never opened at
 * all; it played inline at 288px however much detail was in it.
 *
 * So: wheel or pinch to zoom, drag to pan, double-tap to toggle, and the same viewer for all three
 * kinds, because "let me look closer at that" does not depend on the container being a still.
 *
 * ZOOM IS ABOUT THE POINTER, not the centre. Zooming to the middle of the screen means chasing the
 * thing you wanted to look at back out of view on every step — the detail under the cursor is the
 * detail you are asking about, so it stays put and the rest of the frame moves around it.
 *
 * NOTHING HERE TOUCHES THE NETWORK. The src is an object URL for bytes already decrypted in this
 * tab (Messages.tsx mints and revokes them); this component only paints them. It never fetches,
 * and it never gets the message text — the viewer has no business knowing what was said.
 */

const MIN = 1;
const MAX = 8;
/** Where a double-tap lands: far enough in to read small type, not so far that you are lost. */
const SNAP = 2.5;

type Props = { src: string; mime: string; alt?: string; onClose: () => void };

export default function MediaViewer({ src, mime, alt, onClose }: Props) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const box = useRef<HTMLDivElement | null>(null);
  // Pointer bookkeeping for drag-to-pan and two-finger pinch. A ref, not state: these change on
  // every pointer event and re-rendering per move would make the pan lag behind the finger.
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const pinch = useRef<{ dist: number; scale: number } | null>(null);
  // Distinguishes a click that closes from the mouse-up at the end of a pan. Without it, panning a
  // zoomed image and releasing over the backdrop dismissed the viewer mid-gesture.
  const moved = useRef(false);

  const isVideo = mime.startsWith("video/");
  /** Multiply the current scale, anchored at a point. Kept as a ref-free helper so the wheel
   *  listener (registered once, non-passive) always multiplies the LATEST scale. */
  const scaleAtRef = useRef<(f: number, x: number, y: number) => void>(() => {});
  const setScaleAt = (f: number, x: number, y: number) => scaleAtRef.current(f, x, y);
  const reset = useCallback(() => { setScale(1); setTx(0); setTy(0); }, []);

  /**
   * Zoom toward a point in viewport coordinates, keeping whatever is under it under it.
   *
   * The content is drawn as translate(t) then scale(s) about the container's centre, so a viewport
   * point at offset `o` from that centre currently shows content coordinate (o - t) / s. Holding
   * that coordinate still across s → k gives t' = o - (o - t) * (k / s), which is the whole of it.
   * Written out because the version this replaces tried to do it in one expression and got the
   * sign wrong in a way that only showed at high zoom.
   */
  const zoomAt = useCallback((next: number, cx: number, cy: number) => {
    const el = box.current;
    const k = Math.min(MAX, Math.max(MIN, next));
    if (!el) { setScale(k); return; }
    const r = el.getBoundingClientRect();
    const ox = cx - (r.left + r.width / 2);
    const oy = cy - (r.top + r.height / 2);
    setScale((s) => {
      const f = k / s;
      if (k === MIN) { setTx(0); setTy(0); }
      else {
        setTx((t) => ox - (ox - t) * f);
        setTy((t) => oy - (oy - t) * f);
      }
      return k;
    });
  }, []);

  // Wheel/trackpad. Non-passive and preventDefault'd, or the page behind scrolls while you zoom —
  // and on a trackpad a pinch arrives here as ctrlKey+wheel, which is the same gesture.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Exponential, so every notch is the same RATIO — linear steps feel fast when zoomed out and
      // useless when zoomed in. ctrlKey+wheel is what a trackpad pinch arrives as; same gesture.
      const step = Math.exp(-e.deltaY / (e.ctrlKey ? 120 : 320));
      setScaleAt(step, e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Esc closes; +/- zoom; 0 resets. Bound to the window because focus may sit on the close button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "+" || e.key === "=") { e.preventDefault(); setScale((s) => Math.min(MAX, s * 1.4)); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); setScale((s) => { const k = Math.max(MIN, s / 1.4); if (k === MIN) { setTx(0); setTy(0); } return k; }); }
      else if (e.key === "0") { e.preventDefault(); reset(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, reset]);

  const onPointerDown = (e: React.PointerEvent) => {
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;
    if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale };
      drag.current = null;
    } else if (scale > MIN) {
      drag.current = { x: e.clientX, y: e.clientY, tx, ty };
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pts.current.has(e.pointerId)) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      moved.current = true;
      const k = Math.min(MAX, Math.max(MIN, pinch.current.scale * (d / (pinch.current.dist || 1))));
      setScale(k);
      if (k === MIN) { setTx(0); setTy(0); }
      return;
    }
    if (drag.current) {
      const dx = e.clientX - drag.current.x;
      const dy = e.clientY - drag.current.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved.current = true;
      setTx(drag.current.tx + dx);
      setTy(drag.current.ty + dy);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pts.current.delete(e.pointerId);
    if (pts.current.size < 2) pinch.current = null;
    if (pts.current.size === 0) drag.current = null;
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (scale > MIN) reset(); else zoomAt(SNAP, e.clientX, e.clientY);
  };

  // Refreshed every render so the once-registered wheel handler never multiplies a stale scale.
  scaleAtRef.current = (f, x, y) => zoomAt(scale * f, x, y);

  const zoomed = scale > MIN;
  const common = {
    className: "max-h-[92vh] max-w-[94vw] select-none rounded-card object-contain",
    style: { transform: `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`, transition: drag.current || pinch.current ? "none" : "transform 120ms ease-out" },
    draggable: false as const,
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={isVideo ? "Video" : "Image"} tabIndex={-1}
      // Closing on backdrop click, but never on the mouse-up that ends a pan.
      onClick={() => { if (!moved.current) onClose(); }}
      className="fixed inset-0 z-[80] grid place-items-center overflow-hidden bg-black/85 p-4">
      <div ref={box} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onDoubleClick={onDoubleClick}
        onClick={(e) => e.stopPropagation()}
        // touch-action:none so the browser does not claim the gesture for page scroll/zoom first.
        style={{ touchAction: "none", cursor: zoomed ? (drag.current ? "grabbing" : "grab") : "zoom-in" }}
        className="grid place-items-center">
        {isVideo
          ? <video {...common} src={src} controls playsInline autoPlay aria-label={alt || "Video"} />
          : <img {...common} src={src} alt={alt || ""} />}
      </div>

      {/* Controls. Labelled, keyboard-reachable, and stopPropagation so tapping one does not also
          hit the backdrop's close. */}
      <div className="absolute bottom-4 start-1/2 flex -translate-x-1/2 items-center gap-1 rounded-pill bg-space-2/95 px-1.5 py-1.5 shadow-card rtl:translate-x-1/2"
        onClick={(e) => e.stopPropagation()}>
        <button type="button" aria-label="Zoom out" title="Zoom out (−)" disabled={scale <= MIN}
          onClick={() => setScale((s) => { const k = Math.max(MIN, s / 1.4); if (k === MIN) { setTx(0); setTy(0); } return k; })}
          className="grid h-9 w-9 place-items-center rounded-full text-ink transition-colors hover:bg-veil/[0.08] disabled:opacity-35">
          <Ic d={MINUS} />
        </button>
        <span className="min-w-[52px] text-center text-[12px] font-semibold tabular-nums text-ink-2">{Math.round(scale * 100)}%</span>
        <button type="button" aria-label="Zoom in" title="Zoom in (+)" disabled={scale >= MAX}
          onClick={() => setScale((s) => Math.min(MAX, s * 1.4))}
          className="grid h-9 w-9 place-items-center rounded-full text-ink transition-colors hover:bg-veil/[0.08] disabled:opacity-35">
          <Ic d={PLUS} />
        </button>
        <button type="button" aria-label="Reset zoom" title="Reset (0)" disabled={!zoomed} onClick={reset}
          className="ms-0.5 rounded-pill px-3 py-1.5 text-[12px] font-semibold text-ink-2 transition-colors hover:bg-veil/[0.08] disabled:opacity-35">
          Reset
        </button>
      </div>

      <button type="button" aria-label="Close" onClick={onClose}
        className="absolute end-4 top-4 grid h-10 w-10 place-items-center rounded-full bg-space-2 text-ink shadow-card">
        <Ic d={X} />
      </button>
    </div>
  );
}
