/**
 * The living hand — React wrappers around the ArtaHand engine (lib/hands.ts).
 *
 * <HandDefs/>   shared SVG defs (gold/blue gradients + drop shadow) — render ONCE per page.
 * <HandGlyph>   cheap static pose for wheels, chips and lists.
 * <HandThrow>   the competitive throw: snap to fist, pump, reveal — rAF-driven with
 *               per-digit stagger + spring (verbatim artifact timing). Fires onRevealed
 *               when the pose lands. Respects prefers-reduced-motion (jumps to the pose).
 *
 * Player hands are gold and face right; the rival is blue and mirrored, so the two
 * hands meet exactly as they do across a real table.
 */
import { useEffect, useMemo, useRef } from "react";
import { FIST, TOOL_FC, handInner, type ToolKey } from "../lib/hands";

// The thumb is the heavy digit: it starts a beat after the index and travels longest, so its big
// swing (lying along the fist → leaning past vertical) reads as mass, not a flick.
const HAND_DELAY = [55, 0, 45, 90, 135], HAND_DUR = [470, 340, 340, 340, 340];
const REDUCED = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const easeOutBack = (p: number) => { const s = 1.35; p -= 1; return p * p * ((s + 1) * p + s) + 1; };
const easeInOutCubic = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

export function HandDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <linearGradient id="aqhand" x1="0" y1="0" x2="0" y2="54" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#F6D46E" /><stop offset=".55" stopColor="#E8B923" /><stop offset="1" stopColor="#C08E13" />
        </linearGradient>
        <linearGradient id="aqhandB" x1="0" y1="0" x2="0" y2="54" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8FA3F2" /><stop offset=".55" stopColor="#3B62F0" /><stop offset="1" stopColor="#1D3BA8" />
        </linearGradient>
        <filter id="aqhsh" x="-25%" y="-25%" width="150%" height="150%">
          <feDropShadow dx="0" dy="1.1" stdDeviation="1" floodColor="#000" floodOpacity=".38" />
        </filter>
      </defs>
    </svg>
  );
}

export function HandGlyph({ tool, width = 46, blue = false, mirror = false, className }: {
  tool: ToolKey; width?: number; blue?: boolean; mirror?: boolean; className?: string;
}) {
  const html = useMemo(() => handInner(TOOL_FC[tool]), [tool]);
  return (
    <svg viewBox="0 -10 62 52" width={width} height={Math.round(width * (52 / 62))} aria-hidden="true"
      className={className} style={{ overflow: "visible", display: "block" }}>
      <g transform={mirror ? "translate(48 0) scale(-1 1)" : undefined}>
        <g fill={`url(#aqhand${blue ? "B" : ""})`} filter="url(#aqhsh)" dangerouslySetInnerHTML={{ __html: html }} />
      </g>
    </svg>
  );
}

/** Imperative engine — direct-DOM rAF like the artifact (no per-frame React state). */
class ArtaHandEngine {
  private g: SVGGElement; private svg: SVGSVGElement; private f: number[]; private raf = 0;
  constructor(host: HTMLElement, opts: { fc?: number[]; blue?: boolean; mirror?: boolean }) {
    this.f = (opts.fc || FIST).map(Number);
    host.innerHTML = '<svg viewBox="0 -10 62 52" style="width:100%;height:auto;display:block;overflow:visible"><g'
      + (opts.mirror ? ' transform="translate(48 0) scale(-1 1)"' : "")
      + '><g class="hg" fill="url(#aqhand' + (opts.blue ? "B" : "") + ')" filter="url(#aqhsh)"></g></g></svg>';
    this.svg = host.querySelector("svg") as SVGSVGElement;
    this.g = host.querySelector(".hg") as SVGGElement;
    this.draw();
  }
  private draw() { this.g.innerHTML = handInner(this.f); }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; this.svg.style.transform = ""; }
  set(fc: number[]) { this.stop(); this.f = fc.map(Number); this.draw(); }
  to(fc: number[], done?: () => void) {
    if (REDUCED) { this.set(fc); done?.(); return; }
    const from = this.f.slice(), to = fc.map(Number);
    this.stop();
    const t0 = performance.now();
    const step = (now: number) => {
      const t = now - t0; let all = true; const f = [0, 0, 0, 0, 0];
      for (let k = 0; k < 5; k++) {
        const p = Math.min(1, Math.max(0, (t - HAND_DELAY[k]) / HAND_DUR[k]));
        if (p < 1) all = false;
        const e = to[k] > from[k] ? easeOutBack(p) : easeInOutCubic(p);
        f[k] = from[k] + (to[k] - from[k]) * e;
      }
      this.f = f; this.draw();
      if (!all) { this.raf = requestAnimationFrame(step); }
      else { this.f = to.slice(); this.draw(); this.raf = 0; done?.(); }
    };
    this.raf = requestAnimationFrame(step);
  }
  throwSign(fc: number[], pumps: number, done?: () => void) {
    if (REDUCED) { this.set(fc); done?.(); return; }
    const from = this.f.slice(), t0 = performance.now(), SNAP = 170;
    this.stop();
    const pump = (ts: number, k: number) => {
      const PD = 270;
      const pstep = (now: number) => {
        const p = Math.min(1, (now - ts) / PD), y = Math.sin(p * Math.PI) * 7;
        this.svg.style.transform = "translateY(" + -y + "px)";
        if (p < 1) this.raf = requestAnimationFrame(pstep);
        else { this.svg.style.transform = ""; if (k + 1 < pumps) pump(performance.now(), k + 1); else this.to(fc, done); }
      };
      this.raf = requestAnimationFrame(pstep);
    };
    const snap = (now: number) => {
      const p = Math.min(1, (now - t0) / SNAP), e = easeInOutCubic(p);
      this.f = from.map((v) => v * (1 - e)); this.draw();
      if (p < 1) this.raf = requestAnimationFrame(snap); else pump(performance.now(), 0);
    };
    this.raf = requestAnimationFrame(snap);
  }
}

/** A resting hand that plays its throw on hover/tap — the artifact's living-grid feel. */
export function HandLive({ tool, width = 46, blue = false, mirror = false, className }: {
  tool: ToolKey; width?: number; blue?: boolean; mirror?: boolean; className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const eng = useRef<ArtaHandEngine | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const e = new ArtaHandEngine(el, { blue, mirror, fc: TOOL_FC[tool] });
    eng.current = e;
    return () => { e.stop(); eng.current = null; };
  }, [tool, blue, mirror]);
  const play = () => eng.current?.throwSign(TOOL_FC[tool], 1);
  return <div ref={host} onMouseEnter={play} onClick={play} className={className} style={{ width }} aria-hidden="true" />;
}

/** Mounts as a fist, pumps, reveals the tool — the round's simultaneous reveal. */
export function HandThrow({ tool, width = 150, blue = false, mirror = false, pumps = 2, onRevealed, className }: {
  tool: ToolKey; width?: number; blue?: boolean; mirror?: boolean; pumps?: number; onRevealed?: () => void; className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const revealed = useRef(onRevealed);
  revealed.current = onRevealed;
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const eng = new ArtaHandEngine(el, { blue, mirror, fc: FIST });
    eng.throwSign(TOOL_FC[tool], pumps, () => revealed.current?.());
    return () => eng.stop();
  }, [tool, blue, mirror, pumps]);
  return <div ref={host} className={className} style={{ width }} aria-hidden="true" />;
}
