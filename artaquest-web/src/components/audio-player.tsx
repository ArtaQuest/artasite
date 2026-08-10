/**
 * The audio player — one custom transport with a live FFT spectrum, in place of the browser's
 * default `<audio controls>` bar. Every published track (Music works, and any audio attached to a
 * post) goes through this, so a song in the feed looks like a song and not like a grey OS widget.
 *
 * WHY THE SAME-ORIGIN GUARD IS NOT OPTIONAL. `createMediaElementSource()` re-routes the element's
 * output THROUGH the Web Audio graph. If the media is cross-origin without CORS the stream is
 * tainted: the analyser reads all zeros AND the audio goes SILENT — a visualiser that breaks
 * playback is far worse than no visualiser. Our library serves audio from artaquest.com itself
 * (verified against the live API), and the offline player hands us `blob:` URLs, so both are safe;
 * anything else keeps the transport and simply loses the bars. Never remove `canAnalyse`.
 *
 * ONE graph per element, ONE context per document. Calling `createMediaElementSource` twice on the
 * same element throws, and browsers cap a document at a handful of AudioContexts — so the context
 * is a module singleton and each element's nodes are cached in a WeakMap (they die with it).
 *
 * Motion is the platform's decision, not this file's: `motionOff` comes from the same pair every
 * other surface reads (OS reduce-motion OR the Motion-calm "Still" stop). Suppressed means the
 * spectrum is drawn ONCE as a static resting shape — the player still works, it just stops moving.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { cx } from "./ui";

/* ── the graph ────────────────────────────────────────────────────────────────────────────── */

type Graph = { ctx: AudioContext; analyser: AnalyserNode };

let SHARED: AudioContext | null = null;
const GRAPHS = new WeakMap<HTMLAudioElement, Graph | null>();

/** Can we tap this URL without tainting it (and thereby muting it)? */
function canAnalyse(src: string): boolean {
  if (!src) return false;
  if (src.startsWith("blob:") || src.startsWith("data:")) return true;
  try { return new URL(src, location.href).origin === location.origin; } catch { return false; }
}

/** The element's analyser tap, built at most once. `null` = play normally, without bars. */
function graphFor(el: HTMLAudioElement, src: string): Graph | null {
  const cached = GRAPHS.get(el);
  if (cached !== undefined) return cached;
  let g: Graph | null = null;
  const Ctor: typeof AudioContext | undefined =
    typeof window !== "undefined" ? window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext : undefined;
  if (Ctor && canAnalyse(src)) {
    try {
      SHARED = SHARED || new Ctor();
      const analyser = SHARED.createAnalyser();
      analyser.fftSize = 2048;          // 1024 bins ≈ 22 Hz each at 44.1 kHz — enough to see a bassline
      analyser.smoothingTimeConstant = 0.8; // the browser's own decay; the peak caps add the rest
      // MEASURED on a real published track (KEEP THE KEY, mid-song): at the Web Audio defaults
      // (-100/-30 dB) the byte spectrum SATURATES at 255 — a mastered mix sits far above -30 dBFS,
      // so the loud bars pin to the ceiling and the display stops moving where it should be liveliest.
      // -85 lifts the floor above the noise (bars rest at zero instead of hovering) and -22 leaves
      // headroom for a loud chorus. Real content on that track runs to ~17 kHz, which is why the
      // bands below top out at 16 kHz rather than at Nyquist.
      analyser.minDecibels = -85;
      analyser.maxDecibels = -22;
      const source = SHARED.createMediaElementSource(el);
      source.connect(analyser);
      analyser.connect(SHARED.destination); // MUST reach the destination, or the tap becomes a mute
      g = { ctx: SHARED, analyser };
    } catch { g = null; }               // already tapped, or the context refused — play on regardless
  }
  GRAPHS.set(el, g);
  return g;
}

/**
 * Log-spaced band edges: bar i covers [f0,f1) geometrically from 32 Hz up. A LINEAR map (the naive
 * `bins.slice(i*n)`) puts everything a listener can hear as "music" in the leftmost few per cent
 * and leaves two thirds of the display showing inaudible hiss — the bars barely move.
 */
function bandEdges(bars: number, binCount: number, nyquist: number): Int32Array {
  const lo = 32, hi = Math.min(16000, nyquist);
  const out = new Int32Array(bars + 1);
  for (let i = 0; i <= bars; i++) {
    const f = lo * Math.pow(hi / lo, i / bars);
    out[i] = Math.max(0, Math.min(binCount, Math.round((f / nyquist) * binCount)));
  }
  for (let i = 1; i <= bars; i++) if (out[i] <= out[i - 1]) out[i] = out[i - 1] + 1; // never an empty band
  return out;
}

const cssVar = (name: string, fallback: string) => {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
};

const fmt = (s: number) => {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

/* ── the spectrum ─────────────────────────────────────────────────────────────────────────── */

/** The bars alone — for a player that already owns its transport (the offline "Now playing" sheet). */
export function Spectrum({ el, playing, motionOff, className }: {
  el: HTMLAudioElement | null; playing: boolean; motionOff: boolean; className?: string;
}) {
  const cv = useRef<HTMLCanvasElement | null>(null);
  const peaks = useRef<Float32Array | null>(null);
  const vals = useRef<Float32Array | null>(null);
  const raf = useRef(0);
  const seen = useRef(true); // offscreen cards must not burn a frame budget

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const io = new IntersectionObserver((e) => { seen.current = e.some((x) => x.isIntersecting); });
    io.observe(c);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const ctx2d = c.getContext("2d");
    if (!ctx2d) return;

    let edges: Int32Array | null = null;
    let bars = 0;
    let grad: CanvasGradient | null = null;
    // Explicitly backed by an ArrayBuffer: getByteFrequencyData refuses a SharedArrayBuffer-backed
    // view, and `new Uint8Array(n)` widens to ArrayBufferLike under the current lib types.
    let freq: Uint8Array<ArrayBuffer> | null = null;

    // Device-pixel sizing, re-derived whenever the card resizes (a phone rotate, a rail collapse).
    const measure = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, c.clientWidth), h = Math.max(1, c.clientHeight);
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Roughly one bar per 7px, so a phone gets ~40 and a wide card ~90 — never a comb of hairlines.
      bars = Math.max(16, Math.min(96, Math.floor(w / 7)));
      peaks.current = new Float32Array(bars);
      vals.current = new Float32Array(bars);
      edges = null; // rebuilt on the next frame, once we know the analyser's bin count
      grad = ctx2d.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, cssVar("--color-yin-light", "#4a72ff"));  // cool at the peaks
      grad.addColorStop(0.55, cssVar("--color-yang", "#e8b923"));    // warm through the body
      grad.addColorStop(1, cssVar("--color-yang-dark", "#c49b1a"));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(c);

    const draw = () => {
      const w = c.clientWidth, h = c.clientHeight;
      const v = vals.current, pk = peaks.current;
      if (!v || !pk) return;
      const g = el ? GRAPHS.get(el) ?? null : null;

      if (g && playing) {
        const bins = g.analyser.frequencyBinCount;
        if (!edges || edges.length !== bars + 1) edges = bandEdges(bars, bins, g.ctx.sampleRate / 2);
        if (!freq || freq.length !== bins) freq = new Uint8Array(new ArrayBuffer(bins));
        g.analyser.getByteFrequencyData(freq);
        for (let i = 0; i < bars; i++) {
          let sum = 0;
          const a = edges[i], b = Math.max(a + 1, edges[i + 1]);
          for (let j = a; j < b; j++) sum += freq[j];
          // Gentle tilt: treble carries far less energy than bass, so without it the right half of
          // the display is permanently flat even on a bright mix.
          const tilt = 1 + 0.9 * (i / bars);
          v[i] = Math.min(1, (sum / (b - a) / 255) * tilt);
        }
      } else {
        for (let i = 0; i < bars; i++) v[i] *= 0.86; // settle to the resting line when paused
      }

      ctx2d.clearRect(0, 0, w, h);
      const gap = w / bars >= 5 ? 1.5 : 0.75;
      const bw = Math.max(1, w / bars - gap);
      const floor = 1.5; // the resting line: a silent track is still a track, not an empty box
      ctx2d.fillStyle = grad || cssVar("--color-yang", "#e8b923");
      for (let i = 0; i < bars; i++) {
        const bh = Math.max(floor, v[i] * (h - 3));
        const x = i * (w / bars), y = h - bh;
        ctx2d.beginPath();
        // Rounded caps read as a soft equaliser rather than a spreadsheet chart.
        if (ctx2d.roundRect) ctx2d.roundRect(x, y, bw, bh, Math.min(bw / 2, 2));
        else ctx2d.rect(x, y, bw, bh);
        ctx2d.fill();
        // Peak-hold: a bright tick that falls slower than the bar, the classic "fancy" cue.
        pk[i] = Math.max(v[i], pk[i] - 0.012);
        if (pk[i] > 0.04) {
          const py = h - Math.max(floor, pk[i] * (h - 3)) - 1.5;
          ctx2d.globalAlpha = 0.55;
          ctx2d.fillRect(x, Math.max(0, py), bw, 1.5);
          ctx2d.globalAlpha = 1;
        }
      }
    };

    // A static resting shape when motion is suppressed — drawn once, never animated.
    if (motionOff || !playing) {
      draw();
      return () => { ro.disconnect(); cancelAnimationFrame(raf.current); };
    }
    const loop = () => {
      if (seen.current) draw();
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => { ro.disconnect(); cancelAnimationFrame(raf.current); };
  }, [el, playing, motionOff]);

  return <canvas ref={cv} aria-hidden className={cx("block h-full w-full", className)} />;
}

/* ── the player ───────────────────────────────────────────────────────────────────────────── */

export default function AudioPlayer({ src, motionOff = false, className }: {
  src: string; motionOff?: boolean; className?: string;
}) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [el, setEl] = useState<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);

  // An INLINE ref callback re-runs on every render and would rebuild the graph; take the node once.
  useEffect(() => { setEl(ref.current); }, []);

  const toggle = useCallback(() => {
    const a = ref.current;
    if (!a) return;
    if (a.paused) {
      // Build the tap and lift the autoplay suspension INSIDE the gesture — a context created
      // outside one starts suspended and the spectrum would stay flat for the whole track.
      const g = graphFor(a, src);
      if (g && g.ctx.state === "suspended") void g.ctx.resume();
      void a.play().catch(() => setFailed(true));
    } else a.pause();
  }, [src]);

  const pct = dur > 0 ? (t / dur) * 100 : 0;

  return (
    <div className={cx("flex w-full min-w-0 flex-col gap-2 rounded-xl border border-line bg-space-2/60 p-2.5", className)}>
      <audio
        ref={ref} src={src} preload="metadata"
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
        onError={() => setFailed(true)}
      />
      {/* The spectrum band. Short on a phone, taller where there is room. */}
      <div className="h-10 w-full overflow-hidden rounded-lg sm:h-14">
        <Spectrum el={el} playing={playing} motionOff={motionOff} />
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button" onClick={toggle} disabled={failed}
          aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause" : "Play"}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-line text-ink transition-colors hover:border-yin hover:text-yang disabled:opacity-40 sm:h-9 sm:w-9"
        >
          {playing
            ? <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
            : <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden className="ms-0.5"><path d="M8 5v14l11-7z" /></svg>}
        </button>

        {/* A 6px-tall range input is a 6px-tall HIT AREA — measured on /library, and on a phone that
            is a scrub bar you stab at. The bar stays visually thin, but the control is 28px: the
            painted track is a sibling, and the input lies transparent on top of it at full height. */}
        <span className="relative flex h-7 min-w-0 flex-1 items-center">
          <span aria-hidden className="pointer-events-none absolute inset-x-0 h-1.5 rounded-full"
            style={{ backgroundImage: `linear-gradient(to right, var(--color-yang) ${pct}%, var(--color-space-3) ${pct}%)` }} />
          <input
            type="range" min={0} max={dur || 0} step={0.01} value={Math.min(t, dur || 0)}
            onChange={(e) => { const a = ref.current; if (a) { a.currentTime = Number(e.target.value); setT(Number(e.target.value)); } }}
            aria-label="Seek" disabled={!dur}
            className={cx(
              "absolute inset-0 m-0 h-7 w-full cursor-pointer appearance-none bg-transparent disabled:cursor-default",
              "[&::-webkit-slider-runnable-track]:h-7 [&::-webkit-slider-runnable-track]:bg-transparent",
              "[&::-webkit-slider-thumb]:mt-[0.6875rem] [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-yang [&::-webkit-slider-thumb]:transition-transform hover:[&::-webkit-slider-thumb]:scale-125",
              "[&::-moz-range-track]:h-7 [&::-moz-range-track]:bg-transparent",
              "[&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-yang",
            )}
          />
        </span>

        <span data-ay-skip="1" className="shrink-0 text-[11px] tabular-nums text-ink-3">{fmt(t)} / {fmt(dur)}</span>

        <button
          type="button"
          onClick={() => { const a = ref.current; if (a) { a.muted = !a.muted; setMuted(a.muted); } }}
          aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:text-yang"
        >
          {muted
            ? <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M4 9v6h4l5 4V5L8 9H4z" /><path d="M17 9l4 6M21 9l-4 6" /></svg>
            : <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M4 9v6h4l5 4V5L8 9H4z" /><path d="M17 8.5a5 5 0 0 1 0 7" /></svg>}
        </button>
      </div>

      {failed ? <p className="text-[11px] text-ink-3">This track couldn’t be played. <a href={src} className="underline hover:text-yang">Download it</a> instead.</p> : null}
    </div>
  );
}
