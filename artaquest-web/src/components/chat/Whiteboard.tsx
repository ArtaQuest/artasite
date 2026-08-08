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
 * Normalising means the drawing is the same shape for everybody, at any size — and it is what lets
 * the same board be a strip beside a video grid or the whole stage.
 *
 * A stroke is emitted ON RELEASE rather than per-move: at 60 points a second, live streaming would
 * be a message per frame per person. The line you are drawing is shown locally while you draw, so
 * it still feels immediate to the person drawing it, and lands as one message for everyone else.
 */

export type Stroke = { pts: [number, number][]; color: string; w: number; by?: number };
export type Ping = { x: number; y: number; at: number; by?: number };

/** Brand only — gold and blue — plus ink and the board's own background, which is the eraser. */
const COLORS = ["#E8B923", "#1746DC", "#F5F7FA", "#0C1E32"];
const TOOLS = [
  { k: "pen" as const, label: "Pen", hint: "Draw" },
  { k: "point" as const, label: "Point", hint: "Tap to show everyone where you mean" },
];

export function Whiteboard({ strokes, pings, onStroke, onClear, onUndo, onPoint, canUndo, tall }: {
  strokes: Stroke[];
  pings: Ping[];
  onStroke: (s: Stroke) => void;
  onClear: () => void;
  onUndo: () => void;
  onPoint: (x: number, y: number) => void;
  canUndo: boolean;
  /** True on the focus stage, where the board is the whole surface rather than a strip. */
  tall?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef<[number, number][] | null>(null);
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(3);
  const [tool, setTool] = useState<"pen" | "point">("pen");

  /** Repaint everything. Cheap at whiteboard scale, and it means there is exactly one code path for
   *  "what the board looks like" — no incremental state to drift out of step. */
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
    // Pointer pulses fade over their lifetime, so "look here" reads as a gesture rather than a mark.
    const now = Date.now();
    for (const p of pings) {
      const age = (now - p.at) / 2000;
      if (age < 0 || age > 1) continue;
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, (10 + age * 26) * (w / 1000), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(232,185,35,${(1 - age).toFixed(2)})`;
      ctx.lineWidth = 3 * (w / 1000);
      ctx.stroke();
    }
  }

  useEffect(paint);

  // Pulses need repainting while they fade, and only then — an always-on loop would burn a frame
  // budget on a static board.
  useEffect(() => {
    if (!pings.some((p) => Date.now() - p.at < 2000)) return;
    const t = setInterval(paint, 60);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pings]);

  // Match the backing store to the displayed size, so lines are crisp rather than scaled.
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
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }

  const btn = "rounded-pill px-2.5 py-0.5 text-[11.5px] font-semibold";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5">
        {TOOLS.map((t) => (
          <button key={t.k} type="button" onClick={() => setTool(t.k)} title={t.hint}
            className={`${btn} ${tool === t.k ? "bg-yang text-on-accent" : "border border-line text-ink-2 hover:text-ink"}`}>
            {t.label}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        {COLORS.map((c) => (
          <button key={c} type="button" onClick={() => { setColor(c); setTool("pen"); }} aria-label={`Colour ${c}`}
            className={`h-6 w-6 rounded-full border-2 ${color === c ? "border-ink" : "border-line"}`}
            style={{ background: c }} />
        ))}
        {[2, 4, 8].map((w) => (
          <button key={w} type="button" onClick={() => { setWidth(w); setTool("pen"); }} aria-label={`Pen ${w}`}
            className={`grid h-6 w-6 place-items-center rounded-full ${width === w ? "bg-veil/[0.14]" : "hover:bg-veil/[0.07]"}`}>
            <span className="rounded-full bg-ink-2" style={{ width: w + 2, height: w + 2 }} />
          </button>
        ))}
        <button type="button" onClick={onUndo} disabled={!canUndo}
          className={`${btn} ms-auto border border-line text-ink-2 hover:text-ink disabled:opacity-40`}>Undo</button>
        <button type="button" onClick={onClear}
          className={`${btn} border border-line text-ink-2 hover:text-ink`}>Clear</button>
      </div>
      <canvas
        ref={canvas}
        className={`w-full touch-none bg-space-1 ${tall ? "min-h-0 flex-1" : "h-[260px]"} ${tool === "point" ? "cursor-crosshair" : ""}`}
        aria-label="Shared whiteboard"
        onPointerDown={(e) => {
          if (tool === "point") { const [x, y] = at(e); onPoint(x, y); return; }
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
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
          if (pts && pts.length) onStroke({ pts, color, w: width });
          paint();
        }}
        onPointerLeave={() => {
          if (!drawing.current) return;
          const p = drawing.current;
          drawing.current = null;
          if (p.length) onStroke({ pts: p, color, w: width });
          paint();
        }}
      />
      <p className="px-2 py-1 text-[11px] text-ink-3">
        Every stroke is sealed with the room’s key before it leaves your device — the board is as private as the conversation.
      </p>
    </div>
  );
}
