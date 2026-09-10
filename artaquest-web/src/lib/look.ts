/**
 * ArtaLook — how you appear in a call: touch-up, low light, portrait lighting, auto-framing.
 *
 * ONE PLACE, ONE PASS. The camera track is wrapped exactly once, where it is opened (`dress`, called
 * from lib/webrtc's capture functions), and everything downstream — every peer connection, the
 * member's own tile, the recorders, the pop-out — receives the DRESSED track without knowing it.
 * The dressed track answers `stop`, `getSettings`, `getCapabilities` and `applyConstraints` the way
 * the camera would, so the quality ladder's `shapeCapture` keeps working unchanged: a request for
 * 320×180 becomes a 320×180 output here and a 320×180 (or, for framing, 640×360) request to the
 * camera behind it.
 *
 * WHAT IT COSTS, and why it is allowed to. The per-frame work is a texture upload and one or three
 * draws on the GPU at the OUTPUT size (360p for a call) — well under a millisecond on anything with
 * a GPU. Every decision (how dark is the room, where is the face) is made on a 96×54 thumbnail four
 * times a second in `look-math.ts`. And the engine times itself: the Governor drops to the cheap
 * half and then to a plain blit the moment the look is eating a third of the frame interval, and
 * the panel says so. A picture effect that costs the call its frame rate, or the audio thread its
 * CPU, is not a feature — that rule is enforced, not hoped for.
 *
 * WHAT IT SENDS. Nothing here changes the bitrate ladder: the output track is the same size the
 * ladder asked for, `contentHint = "motion"` keeps the encoder treating it as a camera (a canvas
 * track is otherwise encoded like a screen share — sharp, jerky, and wrong for a face), and framing
 * supersamples the CAPTURE, never the output, so a 2× crop still fills its 360p pixels. On a phone
 * or a modest laptop capture is never supersampled at all.
 *
 * WHAT IT DOES NOT DO. There is no background replacement and no machine-learned segmentation —
 * both cost a real fraction of a CPU core per frame, and the call already spends that on encoding
 * N−1 copies of the picture. Background blur stays where it was: on the camera, when the platform
 * offers it (`getCapabilities().backgroundBlur`), and nowhere otherwise.
 */
import {
  type Box, type Exposure, Framer, Governor, Motion, THUMB_H, THUMB_W,
  exposureAt, exposureFor, faceFromMask, fullFrame, histMean, lumaHist, lumaPlane, skinMask, thumbGain,
} from "./look-math";

/* ── SETTINGS ──────────────────────────────────────────────────────────────────────────────────── */

export type LookSettings = {
  /** Touch-up strength, 0 (off) to 1. */
  touch: number;
  /** Low-light correction: off, decided from the picture, or set by hand. */
  light: "off" | "auto" | "manual";
  /** The manual level, 0..1. Kept while in auto so switching back restores it. */
  lightLevel: number;
  /** Lift the face, soften the room. */
  portrait: boolean;
  /** Keep the face framed as it moves. */
  frame: boolean;
};

const DEFAULTS: LookSettings = { touch: 0, light: "off", lightLevel: 0.5, portrait: false, frame: false };
/** A look is a fact about this member on this browser, like the device choice beside it. */
const KEY = "aq_call_look";
const listeners = new Set<(s: LookSettings) => void>();
let cached: LookSettings | null = null;

export function lookSettings(): LookSettings {
  if (cached) return cached;
  let v: Partial<LookSettings> = {};
  try { v = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<LookSettings>; } catch { /* private mode */ }
  const s: LookSettings = { ...DEFAULTS };
  if (typeof v.touch === "number" && v.touch >= 0 && v.touch <= 1) s.touch = v.touch;
  if (v.light === "off" || v.light === "auto" || v.light === "manual") s.light = v.light;
  if (typeof v.lightLevel === "number" && v.lightLevel >= 0 && v.lightLevel <= 1) s.lightLevel = v.lightLevel;
  if (typeof v.portrait === "boolean") s.portrait = v.portrait;
  if (typeof v.frame === "boolean") s.frame = v.frame;
  cached = s;
  return s;
}

export function setLook(patch: Partial<LookSettings>): LookSettings {
  const s = { ...lookSettings(), ...patch };
  cached = s;
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
  for (const fn of listeners) fn(s);
  return s;
}

export function onLook(fn: (s: LookSettings) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** True when any effect is on. */
export function lookActive(s: LookSettings = lookSettings()): boolean {
  return s.touch > 0 || s.light !== "off" || s.portrait || s.frame;
}

/* ── SUPPORT ───────────────────────────────────────────────────────────────────────────────────── */

let supported: boolean | null = null;
/** WebGL + canvas capture + a video element — every evergreen browser since 2021, iOS included. */
export function lookSupported(): boolean {
  if (supported !== null) return supported;
  if (typeof document === "undefined") return (supported = false);
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl", { failIfMajorPerformanceCaveat: true }) as WebGLRenderingContext | null;
    supported = !!gl && typeof c.captureStream === "function";
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch { supported = false; }
  return supported;
}

/** A device that should never be asked to do the expensive half: a phone, or two to four slow
 *  cores with little memory. Mirrors the shape of lib/webrtc's device ceiling without importing it
 *  (webrtc imports this file). */
function modestDevice(): boolean {
  if (typeof navigator === "undefined") return true;
  const cores = navigator.hardwareConcurrency ?? 0;
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 0;
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const shortSide = typeof screen !== "undefined" ? Math.min(screen.width || 0, screen.height || 0) : 0;
  if (coarse && shortSide > 0 && shortSide <= 500) return true;
  return (cores > 0 && cores <= 4) || (mem > 0 && mem <= 4);
}

/* ── THE PLATFORM FACE DETECTOR, where there is one ────────────────────────────────────────────── */

type DetectedFace = { boundingBox: { x: number; y: number; width: number; height: number } };
type FaceDetectorLike = { detect(src: HTMLVideoElement | HTMLCanvasElement): Promise<DetectedFace[]> };
function platformDetector(): FaceDetectorLike | null {
  const Ctor = (globalThis as unknown as { FaceDetector?: new (o: { fastMode: boolean; maxDetectedFaces: number }) => FaceDetectorLike }).FaceDetector;
  if (!Ctor) return null;
  try { return new Ctor({ fastMode: true, maxDetectedFaces: 1 }); } catch { return null; }
}

/* ── SHADERS ───────────────────────────────────────────────────────────────────────────────────── */

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  // Texture rows come in top-first (no UNPACK flip), so v runs downwards: the canvas's bottom edge
  // samples the source's bottom row.
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/** One direction of a separable Gaussian, σ≈2 texels, 9 taps. Run twice at reduced size. */
const BLUR = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uStep;
void main() {
  vec3 s = texture2D(uTex, vUv).rgb * 0.2270;
  s += (texture2D(uTex, vUv + uStep).rgb + texture2D(uTex, vUv - uStep).rgb) * 0.1945;
  s += (texture2D(uTex, vUv + uStep * 2.0).rgb + texture2D(uTex, vUv - uStep * 2.0).rgb) * 0.1216;
  s += (texture2D(uTex, vUv + uStep * 3.0).rgb + texture2D(uTex, vUv - uStep * 3.0).rgb) * 0.0540;
  s += (texture2D(uTex, vUv + uStep * 4.0).rgb + texture2D(uTex, vUv - uStep * 4.0).rgb) * 0.0162;
  gl_FragColor = vec4(s, 1.0);
}`;

/**
 * The composite. Crop → touch-up → exposure → portrait light. All four are gated on their uniform
 * so the passthrough case (nothing on, or the Governor at 0) is a crop of the whole frame and a
 * copy — one texture read per pixel.
 *
 * TOUCH-UP is a surface blur, not a blur: the blurred picture replaces the original only where the
 * two differ by LITTLE (pores, small blemishes, sensor noise) and only on skin. Where they differ
 * by a lot — an eyelash, the edge of the hair, the frame of a pair of glasses — the original is
 * kept, which is what stops it looking like a wax figure. The skin test is the same YCbCr box as
 * look-math's `isSkin`, with soft edges.
 *
 * EXPOSURE is a knee (in·g / (1 + (g−1)·in)) — lifts the low end by g, maps white to white, never
 * clips — followed by a gamma for the mid-tones. LOW LIGHT also carries noise; the touch-up's
 * blur, when it is on, is doing double duty as the denoiser.
 *
 * PORTRAIT LIGHT is a soft ellipse of extra exposure on the face and a gentle vignette on the
 * rest — the same thing a ring light in front and a dimmer behind would do.
 */
const MAIN = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform sampler2D uBlur;
uniform vec4 uCrop;
uniform float uTouch;
uniform float uGain;
uniform float uGamma;
uniform float uPortrait;
uniform vec4 uFace;
uniform float uAspect;
vec3 expose(vec3 c) {
  if (uGain > 1.0) c = c * uGain / (1.0 + (uGain - 1.0) * c);
  if (uGamma > 1.0) c = pow(max(c, vec3(0.0)), vec3(1.0 / uGamma));
  return c;
}
float skin(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  float cb = 0.5 - 0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b;
  float cr = 0.5 + 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b;
  float m = smoothstep(0.28, 0.32, cb) * (1.0 - smoothstep(0.48, 0.52, cb))
          * smoothstep(0.50, 0.54, cr) * (1.0 - smoothstep(0.66, 0.70, cr));
  return m * smoothstep(0.12, 0.20, y);
}
void main() {
  vec2 uv = uCrop.xy + vUv * uCrop.zw;
  vec3 c = expose(texture2D(uSrc, uv).rgb);
  if (uTouch > 0.0) {
    // The blurred picture is lifted the same way, so the two differ only in detail, never in
    // exposure — and the skin test sees daylight chroma in a dark room (see look-math skinMask).
    vec3 b = expose(texture2D(uBlur, uv).rgb);
    float amp = length(c - b);
    // Pores and sensor grain sit under ~0.06; an eyelash, a lip line or the edge of the hair is
    // over 0.18. The skin test reads the BLURRED colour: noise pushes a single pixel's chroma out
    // of the skin box, and the mask would otherwise be full of holes exactly where it matters.
    float keep = smoothstep(0.06, 0.18, amp);
    c = mix(c, b, uTouch * skin(b) * (1.0 - keep));
  }
  if (uPortrait > 0.0) {
    vec2 p = (vUv - uFace.xy) / uFace.zw;
    float light = 1.0 + 0.30 * uPortrait * (1.0 - smoothstep(0.55, 1.6, length(p)));
    vec2 q = (vUv - vec2(0.5)) * vec2(uAspect, 1.0);
    float vig = 1.0 - 0.22 * uPortrait * smoothstep(0.55, 1.15, length(q));
    c = c * light * vig;
    c = c / (1.0 + max(c - vec3(1.0), vec3(0.0)));
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

/* ── THE ENGINE ────────────────────────────────────────────────────────────────────────────────── */

/** What the panel and the tests can read off a live engine. */
export type LookStats = {
  /** Governor level: 2 everything, 1 the cheap half, 0 passthrough. */
  level: 0 | 1 | 2;
  /** Smoothed cost of one frame, ms — the number the Governor decides on. */
  costMs: number;
  /** Frames rendered in the last second. */
  fps: number;
  /** Source and output sizes. */
  src: { w: number; h: number };
  out: { w: number; h: number };
  /** The face last accepted by the framer, in source coordinates, or null. */
  face: Box | null;
  /** Which detector is finding it. */
  detector: "platform" | "skin";
  /** The exposure currently applied. */
  exposure: Exposure;
  /** The crop currently drawn. */
  crop: Box;
  /** Frames rendered in total — a test's proof that anything ran. */
  frames: number;
};

/** How often the thumbnail is measured at full level, and at the cheap level. */
const DETECT_MS = 250;
const DETECT_SLOW_MS = 500;

type Program = { prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null>; pos: number };

class Look {
  readonly out: MediaStreamTrack;
  private s: LookSettings;
  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private blurP: Program | null = null;
  private mainP: Program | null = null;
  private quad: WebGLBuffer | null = null;
  private srcTex: WebGLTexture | null = null;
  private fbo: { fb: WebGLFramebuffer; tex: WebGLTexture }[] = [];
  private fboW = 0; private fboH = 0;
  private readonly thumb: CanvasRenderingContext2D | null;
  private readonly framer: Framer;
  /** Where the picture has been moving — the furniture filter for the skin face-finder. */
  private readonly motion = new Motion(THUMB_W, THUMB_H);
  private readonly gov: Governor;
  private detector: FaceDetectorLike | null;
  private detecting = false;
  private lastDetect = 0;
  private lastFrame = 0;
  private srcW = 0; private srcH = 0;
  private outW = 0; private outH = 0; private outFps = 30;
  private wantExp: Exposure = { gain: 1, gamma: 1, mean: 0, dark: false };
  private exp: Exposure = { gain: 1, gamma: 1, mean: 0, dark: false };
  private lastFace: Box | null = null;
  /** The portrait light's centre, smoothed, in source coordinates. */
  private light: Box | null = null;
  private crop: Box = { x: 0, y: 0, w: 1, h: 1 };
  private disposed = false;
  private unsub: () => void;
  private frames = 0; private fpsCount = 0; private fpsAt = 0; private fps = 0;
  private timer: number | null = null;
  private rvfc: number | null = null;
  private supersampled = false;

  private readonly raw: MediaStreamTrack;

  constructor(raw: MediaStreamTrack) {
    this.raw = raw;
    this.s = lookSettings();
    this.gov = new Governor(modestDevice() ? 1 : 2);
    this.detector = platformDetector();
    const st = raw.getSettings();
    this.srcW = st.width || 640; this.srcH = st.height || 360;
    this.outW = this.srcW; this.outH = this.srcH;
    this.outFps = Math.min(30, Math.max(1, Math.round(st.frameRate || 30)));
    // The heuristic finder gets a shorter leash than a platform detector: see Framer.
    this.framer = new Framer(this.srcW / this.srcH, this.outW / this.outH, this.detector ? 2 : 1.7);
    this.crop = this.framer.crop;

    this.video = document.createElement("video");
    this.video.muted = true; this.video.playsInline = true; this.video.autoplay = true;
    this.video.setAttribute("aria-hidden", "true");
    this.video.srcObject = new MediaStream([raw]);

    this.canvas = document.createElement("canvas");
    this.canvas.width = this.outW; this.canvas.height = this.outH;
    // Parked off-screen but IN the document: a detached canvas is not composited, and some browsers
    // only hand a captured frame to the track when the canvas is. Not display:none for the same reason.
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;pointer-events:none;opacity:0";
    document.body.appendChild(this.canvas);

    const t = document.createElement("canvas");
    t.width = THUMB_W; t.height = THUMB_H;
    this.thumb = t.getContext("2d", { willReadFrequently: true });

    this.initGl();
    this.canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.gl = null; });
    this.canvas.addEventListener("webglcontextrestored", () => { this.initGl(); });

    const stream = this.canvas.captureStream(30);
    this.out = stream.getVideoTracks()[0];
    this.out.contentHint = "motion";
    this.wrap();

    this.unsub = onLook((s) => this.apply(s));
    raw.addEventListener("ended", () => this.dispose());
    void this.video.play().catch(() => undefined);
    void this.setOutput(this.outW, this.outH, this.outFps);
    this.schedule();
    live.set(this.out, this);
  }

  /** Make the dressed track answer like the camera it stands in front of. */
  private wrap(): void {
    const out = this.out, raw = this.raw;
    const proto = MediaStreamTrack.prototype;
    Object.defineProperties(out, {
      label: { value: raw.label, configurable: true },
      stop: {
        configurable: true,
        value: () => { raw.stop(); this.dispose(); proto.stop.call(out); },
      },
      getSettings: {
        configurable: true,
        value: (): MediaTrackSettings => {
          const r = raw.getSettings();
          return {
            ...proto.getSettings.call(out),
            deviceId: r.deviceId, groupId: r.groupId, facingMode: r.facingMode,
            width: this.outW, height: this.outH, frameRate: this.outFps,
            ...("backgroundBlur" in r ? { backgroundBlur: (r as { backgroundBlur?: boolean }).backgroundBlur } : {}),
          } as MediaTrackSettings;
        },
      },
      getCapabilities: {
        configurable: true,
        value: (): MediaTrackCapabilities => { try { return raw.getCapabilities(); } catch { return {}; } },
      },
      applyConstraints: {
        configurable: true,
        value: (c?: MediaTrackConstraints): Promise<void> => this.constrain(c || {}),
      },
    });
  }

  /** `applyConstraints` on the dressed track: sizes shape the output (and the camera behind it);
   *  anything else — background blur — goes straight to the camera. */
  private async constrain(c: MediaTrackConstraints): Promise<void> {
    const pick = (v: unknown, cur: number): number => {
      if (typeof v === "number") return v;
      if (v && typeof v === "object") {
        const o = v as { ideal?: number; max?: number; exact?: number };
        return o.exact ?? o.ideal ?? o.max ?? cur;
      }
      return cur;
    };
    const rest: Record<string, unknown> = {};
    for (const k of Object.keys(c)) if (k !== "width" && k !== "height" && k !== "frameRate" && k !== "facingMode" && k !== "deviceId") rest[k] = (c as Record<string, unknown>)[k];
    if (Object.keys(rest).length) await this.raw.applyConstraints(rest as MediaTrackConstraints);
    if ("width" in c || "height" in c || "frameRate" in c) {
      await this.setOutput(pick(c.width, this.outW), pick(c.height, this.outH), pick(c.frameRate, this.outFps));
    }
  }

  /** The output size is the ladder's; the camera is asked for the same, or 2× of it for framing
   *  on a device that can afford to encode from a bigger capture. */
  private async setOutput(w: number, h: number, fps: number): Promise<void> {
    if (this.disposed) return;
    w = Math.max(16, Math.round(w)); h = Math.max(16, Math.round(h));
    this.outFps = Math.min(30, Math.max(1, Math.round(fps)));
    if (w !== this.outW || h !== this.outH) {
      this.outW = w; this.outH = h;
      this.canvas.width = w; this.canvas.height = h;
      this.framer.reshape(this.srcW / this.srcH, w / h);
    }
    const sup = this.s.frame && this.gov.level === 2 && !modestDevice();
    const k = sup ? 2 : 1;
    this.supersampled = sup;
    const want = { width: { ideal: w * k }, height: { ideal: h * k }, frameRate: { ideal: this.outFps, max: this.outFps } };
    try { await this.raw.applyConstraints(want); } catch { /* fixed-format camera — we crop what it gives */ }
    // A camera that ignores a polite request and answers 1080p is asked again with a ceiling — the
    // same insistence lib/webrtc applies, because the pixels would otherwise be uploaded to the GPU
    // and thrown away thirty times a second.
    let got: MediaTrackSettings = {};
    try { got = this.raw.getSettings(); } catch { /* nothing to check */ }
    if ((got.width || 0) > w * k * 1.5 || (got.frameRate || 0) > this.outFps + 5) {
      try { await this.raw.applyConstraints({ width: { max: w * k }, height: { max: h * k }, frameRate: { max: this.outFps } }); } catch { /* cannot */ }
    }
  }

  private apply(s: LookSettings): void {
    const wasFrame = this.s.frame;
    this.s = s;
    if (s.light === "off") this.wantExp = { gain: 1, gamma: 1, mean: this.wantExp.mean, dark: false };
    else if (s.light === "manual") this.wantExp = exposureAt(s.lightLevel);
    if (s.frame !== wasFrame) {
      this.framer.reshape(this.srcW / this.srcH, this.outW / this.outH);
      void this.setOutput(this.outW, this.outH, this.outFps);
    }
  }

  /* ── GL ── */

  private initGl(): void {
    const gl = this.canvas.getContext("webgl", {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: "low-power",
    }) as WebGLRenderingContext | null;
    if (!gl) return;
    this.gl = gl;
    const compile = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { gl.deleteShader(sh); return null; }
      return sh;
    };
    const link = (frag: string, uniforms: string[]): Program | null => {
      const v = compile(gl.VERTEX_SHADER, VERT), f = compile(gl.FRAGMENT_SHADER, frag);
      const prog = gl.createProgram();
      if (!v || !f || !prog) return null;
      gl.attachShader(prog, v); gl.attachShader(prog, f); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
      const loc: Record<string, WebGLUniformLocation | null> = {};
      for (const u of uniforms) loc[u] = gl.getUniformLocation(prog, u);
      return { prog, loc, pos: gl.getAttribLocation(prog, "aPos") };
    };
    this.blurP = link(BLUR, ["uTex", "uStep"]);
    this.mainP = link(MAIN, ["uSrc", "uBlur", "uCrop", "uTouch", "uGain", "uGamma", "uPortrait", "uFace", "uAspect"]);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.srcTex = this.texture(gl);
    this.fbo = []; this.fboW = this.fboH = 0;
    if (!this.blurP || !this.mainP) this.gl = null;
  }

  private texture(gl: WebGLRenderingContext): WebGLTexture | null {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  /** The two half-size buffers the blur ping-pongs between, re-made when the source changes size.
   *  Half of the source up to 720 wide, a quarter above: the blur's radius should scale with the
   *  face, and the face scales with the capture. */
  private ensureFbos(gl: WebGLRenderingContext): void {
    const div = this.srcW > 960 ? 4 : 2;
    const w = Math.max(8, Math.round(this.srcW / div)), h = Math.max(8, Math.round(this.srcH / div));
    if (this.fbo.length === 2 && this.fboW === w && this.fboH === h) return;
    for (const f of this.fbo) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }
    this.fbo = [];
    for (let i = 0; i < 2; i++) {
      const tex = this.texture(gl);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, w, h, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (fb && tex) this.fbo.push({ fb, tex });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fboW = w; this.fboH = h;
  }

  private draw(gl: WebGLRenderingContext, p: Program): void {
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(p.pos);
    gl.vertexAttribPointer(p.pos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /* ── THE LOOP ── */

  private schedule(): void {
    if (this.disposed) return;
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (typeof v.requestVideoFrameCallback === "function") {
      this.rvfc = v.requestVideoFrameCallback(() => { this.rvfc = null; this.render(); this.schedule(); });
    } else {
      this.timer = window.setTimeout(() => { this.timer = null; this.render(); this.schedule(); }, 1000 / this.outFps);
    }
  }

  private render(): void {
    if (this.disposed) return;
    const now = performance.now();
    const v = this.video;
    // Nothing to draw: the camera is off (the track sends black by itself), the tab is hidden (the
    // ladder has shed video), or the element has no frame yet. No work is the whole point.
    if (!this.out.enabled || document.hidden || v.readyState < 2 || v.videoWidth === 0) { this.lastFrame = now; return; }
    const dt = this.lastFrame ? Math.min(200, now - this.lastFrame) : 1000 / this.outFps;
    this.lastFrame = now;
    if (v.videoWidth !== this.srcW || v.videoHeight !== this.srcH) {
      this.srcW = v.videoWidth; this.srcH = v.videoHeight;
      this.framer.reshape(this.srcW / this.srcH, this.outW / this.outH);
    }
    const s = this.s;
    const lvl = this.gov.level;
    const wantTouch = s.touch > 0 && lvl === 2;
    const wantLight = s.light !== "off" && lvl > 0;
    const wantFace = (s.portrait || s.frame) && lvl > 0;
    const active = wantTouch || wantLight || (s.portrait && lvl > 0) || (s.frame && lvl > 0);

    if (active && now - this.lastDetect >= (lvl === 2 ? DETECT_MS : DETECT_SLOW_MS)) {
      this.lastDetect = now;
      this.measure(now, wantLight && s.light === "auto", wantFace);
    }

    // Glide the numbers, so a new exposure or a new face never lands as a cut.
    const k = 1 - Math.exp(-dt / 400);
    this.exp = {
      gain: this.exp.gain + (this.wantExp.gain - this.exp.gain) * k,
      gamma: this.exp.gamma + (this.wantExp.gamma - this.exp.gamma) * k,
      mean: this.wantExp.mean, dark: this.wantExp.dark,
    };
    this.crop = s.frame && lvl > 0 ? this.framer.step(dt) : fullFrame(this.srcW / this.srcH, this.outW / this.outH);
    const face = this.framer.lastFace;
    if (face) {
      const kf = 1 - Math.exp(-dt / 600);
      this.light = this.light
        ? { x: this.light.x + (face.x - this.light.x) * kf, y: this.light.y + (face.y - this.light.y) * kf, w: this.light.w + (face.w - this.light.w) * kf, h: this.light.h + (face.h - this.light.h) * kf }
        : { ...face };
    }

    const gl = this.gl;
    if (!gl) return;   // context lost: the track keeps its last frame; restored → drawing resumes
    try {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, v);
      if (wantTouch && this.blurP) {
        this.ensureFbos(gl);
        gl.viewport(0, 0, this.fboW, this.fboH);
        gl.useProgram(this.blurP.prog);
        gl.uniform1i(this.blurP.loc.uTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[0].fb);
        gl.uniform2f(this.blurP.loc.uStep, 1 / this.fboW, 0);
        this.draw(gl, this.blurP);
        gl.bindTexture(gl.TEXTURE_2D, this.fbo[0].tex);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[1].fb);
        gl.uniform2f(this.blurP.loc.uStep, 0, 1 / this.fboH);
        this.draw(gl, this.blurP);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.fbo[1].tex);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      }
      const m = this.mainP as Program;
      gl.viewport(0, 0, this.outW, this.outH);
      gl.useProgram(m.prog);
      gl.uniform1i(m.loc.uSrc, 0);
      gl.uniform1i(m.loc.uBlur, 1);
      const c = this.crop;
      gl.uniform4f(m.loc.uCrop, c.x, c.y, c.w, c.h);
      gl.uniform1f(m.loc.uTouch, wantTouch ? s.touch : 0);
      gl.uniform1f(m.loc.uGain, wantLight ? this.exp.gain : 1);
      gl.uniform1f(m.loc.uGamma, wantLight ? this.exp.gamma : 1);
      const portrait = s.portrait && lvl > 0;
      gl.uniform1f(m.loc.uPortrait, portrait ? 1 : 0);
      if (portrait) {
        // The light follows the face through the crop; with no face known it sits where a face
        // usually is, a little above the middle, wide enough to be gentle.
        const f = this.light;
        const cx = f ? (f.x + f.w / 2 - c.x) / c.w : 0.5;
        const cy = f ? (f.y + f.h / 2 - c.y) / c.h : 0.42;
        const rx = f ? Math.max(0.12, (f.w / c.w) * 1.1) : 0.28;
        const ry = f ? Math.max(0.15, (f.h / c.h) * 1.3) : 0.42;
        gl.uniform4f(m.loc.uFace, cx, cy, rx, ry);
      }
      gl.uniform1f(m.loc.uAspect, this.outW / this.outH);
      this.draw(gl, m);
    } catch { /* a lost context mid-frame; the handler above resets */ }

    const cost = performance.now() - now;
    const before = this.gov.level;
    const after = this.gov.record(cost, 1000 / this.outFps);
    if (after !== before) void this.setOutput(this.outW, this.outH, this.outFps);
    this.frames++; this.fpsCount++;
    if (now - this.fpsAt >= 1000) { this.fps = this.fpsCount; this.fpsCount = 0; this.fpsAt = now; }
  }

  /** The thumbnail pass: histogram for the exposure, skin mask (or the platform detector) for the
   *  face. Four times a second at most; the platform detector is asynchronous and never overlapped. */
  private measure(now: number, light: boolean, face: boolean): void {
    const ctx = this.thumb;
    if (!ctx) return;
    let px: Uint8ClampedArray | null = null;
    if (light || face) {
      try {
        ctx.drawImage(this.video, 0, 0, THUMB_W, THUMB_H);
        px = ctx.getImageData(0, 0, THUMB_W, THUMB_H).data;
      } catch { return; }
    }
    let gain = 1;
    if (px) {
      const hist = lumaHist(px, THUMB_W * THUMB_H);
      if (light) this.wantExp = exposureFor(hist);
      gain = thumbGain(histMean(hist));
    }
    if (!face) return;
    if (this.detector && !this.detecting) {
      this.detecting = true;
      const w = this.srcW, h = this.srcH;
      this.detector.detect(this.video).then((faces) => {
        this.detecting = false;
        const f = faces[0]?.boundingBox;
        const box: Box | null = f && w > 0 && h > 0 ? { x: f.x / w, y: f.y / h, w: f.width / w, h: f.height / h } : null;
        this.lastFace = box;
        this.framer.observe(box, performance.now());
      }).catch(() => {
        // "Face detection service unavailable" — Chrome on a machine without the platform model.
        this.detecting = false;
        this.detector = null;
      });
    } else if (px) {
      // A candidate has to sit on cells that have MOVED lately, or it is the furniture.
      this.motion.observe(lumaPlane(px, THUMB_W * THUMB_H));
      const box = faceFromMask(skinMask(px, THUMB_W, THUMB_H, gain), THUMB_W, THUMB_H, this.lastFace, (b) => this.motion.gate(b));
      this.lastFace = box;
      this.framer.observe(box, now);
    }
  }

  stats(): LookStats {
    return {
      level: this.gov.level, costMs: this.gov.costMs, fps: this.fps,
      src: { w: this.srcW, h: this.srcH }, out: { w: this.outW, h: this.outH },
      face: this.framer.lastFace, detector: this.detector ? "platform" : "skin",
      exposure: this.exp, crop: this.crop, frames: this.frames,
    };
  }

  get isSupersampled(): boolean { return this.supersampled; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsub();
    live.delete(this.out);
    if (this.timer !== null) window.clearTimeout(this.timer);
    const v = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void };
    if (this.rvfc !== null && typeof v.cancelVideoFrameCallback === "function") v.cancelVideoFrameCallback(this.rvfc);
    try { this.video.pause(); } catch { /* fine */ }
    this.video.srcObject = null;
    const gl = this.gl;
    if (gl) {
      for (const f of this.fbo) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }
      gl.deleteTexture(this.srcTex);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.canvas.remove();
  }
}

/** Every dressed track alive on this page, by its output track. */
const live = new Map<MediaStreamTrack, Look>();

/**
 * Dress a camera track. The one entry point: returns the processed track, or the raw one where the
 * browser cannot do this (no WebGL, no canvas capture) — callers never need to know which.
 */
export function dress(raw: MediaStreamTrack): MediaStreamTrack {
  if (raw.kind !== "video" || !lookSupported()) return raw;
  if (live.has(raw)) return raw;   // already dressed: never wrap a wrapper
  try { return new Look(raw).out; } catch { return raw; }
}

/** The live engine behind a dressed track, or null for a raw one. */
export function lookStats(track: MediaStreamTrack | null | undefined): LookStats | null {
  const l = track ? live.get(track) : undefined;
  return l ? l.stats() : null;
}

/** True when this track is a dressed one. */
export function isDressed(track: MediaStreamTrack | null | undefined): boolean {
  return !!track && live.has(track);
}
