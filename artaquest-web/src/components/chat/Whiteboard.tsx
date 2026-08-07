import { useEffect, useRef, useState } from "react";

/**
 * A shared whiteboard — sealed, like everything else in the room.
 *
 * WHAT TRAVELS IS A STROKE, NOT AN IMAGE. Each completed stroke is a short list of points sent as an
 * ordinary sealed room message (`{t:"draw"}`), so the board inherits the room's encryption exactly
 * as a sentence does: the server stores the same opaque ciphertext and could not reconstruct the
 * drawing if it tried. Sending pixels instead would have meant either a plaintext image or a
 * megabyte per change.
 *
 * POINTS ARE STORED 0..1, not in pixels. Two people on a laptop and a phone have different canvas
 * sizes, and a stroke recorded in device pixels would land somewhere else on the other screen.
 * Normalising means the drawing is the same shape for everybody, at any size.
 *
 * A stroke is emitted ON RELEASE rather than per-move: at 60 points a second, live streaming would
 * be a message per frame per person. The line you are drawing is shown locally while you draw, so
 * it still feels immediate to the person drawing it, and lands as one message for everyone else.
 */

export type Stroke = { pts: [number, number][]; color: string; w: number };

/** The palette — brand only, plus an eraser that draws in the board's own background. */
const COLORS = ["#E8B923", "#1746DC", "#F5F7FA", "#0C1E32"];

export function Whiteboard({ strokes, onStroke, onClear }: {
  strokes: Stroke[];
  onStroke: (s: Stroke) => void;
  onClear: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef<[number, number][] | null>(null);
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(3);

  /** Repaint everything. Cheap enough at whiteboard scale, and it means there is exactly one code
   *  path for "what the board looks like" — no incremental state to drift. */
  function paint() {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const { width: w, height: h } = c;
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const all = drawing.current ? [...strokes, { pts: drawing.current, color, w: width }] : strokes;
    for (const s of all) {
      if (s.pts.length < 1) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.w * (w / 1000);
      ctx.beginPath();
      ctx.moveTo(s.pts[0][0] * w, s.pts[0][1] * h);
      for (const [x, y] of s.pts.slice(1)) ctx.lineTo(x * w, y * h);
      if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] * w + 0.1, s.pts[0][1] * h);
      ctx.stroke();
    }
  }

  useEffect(paint);

  // Match the canvas backing store to its displayed size, so lines are crisp rather than scaled.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const fit = () => {
      const r = c.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      paint();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(c);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function at(e: React.PointerEvent): [number, number] {
    const r = (e.target as HTMLElement).getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5">
        {COLORS.map((c) => (
          <button key={c} type="button" onClick={() => setColor(c)} aria-label={`Colour ${c}`}
            className={`h-6 w-6 rounded-full border-2 ${color === c ? "border-ink" : "border-line"}`}
            style={{ background: c }} />
        ))}
        {[2, 4, 8].map((w) => (
          <button key={w} type="button" onClick={() => setWidth(w)} aria-label={`Pen ${w}`}
            className={`grid h-6 w-6 place-items-center rounded-full ${width === w ? "bg-veil/[0.14]" : "hover:bg-veil/[0.07]"}`}>
            <span className="rounded-full bg-ink-2" style={{ width: w + 2, height: w + 2 }} />
          </button>
        ))}
        <button type="button" onClick={onClear}
          className="ms-auto rounded-pill border border-line px-2.5 py-0.5 text-[11.5px] font-semibold text-ink-2 hover:text-ink">Clear</button>
      </div>
      <canvas
        ref={canvas}
        className="h-[260px] w-full touch-none bg-space-1"
        aria-label="Shared whiteboard"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drawing.current = [at(e)];
          paint();
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          drawing.current.push(at(e));
          paint();
        }}
        onPointerUp={() => {
          const pts = drawing.current;
          drawing.current = null;
          // One message per stroke — see the note above on why not per move.
          if (pts && pts.length) onStroke({ pts, color, w: width });
          paint();
        }}
        onPointerLeave={() => { if (drawing.current) { const p = drawing.current; drawing.current = null; if (p.length) onStroke({ pts: p, color, w: width }); paint(); } }}
      />
      <p className="px-2 py-1 text-[11px] text-ink-3">
        Every stroke is sealed with the room’s key before it leaves your device — the board is as private as the conversation.
      </p>
    </div>
  );
}
