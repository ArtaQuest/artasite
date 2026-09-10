/**
 * ArtaLook — the arithmetic behind "Touch up", "Low light", "Portrait lighting" and "Auto-framing".
 *
 * Everything here is PURE: numbers in, numbers out, no DOM, no WebGL, no time read from a clock.
 * That is what makes it testable from node in milliseconds, and it is the only reason the engine
 * (`look.ts`) can be trusted to be cheap — every decision the shaders act on is made on a 96×54
 * thumbnail, four times a second, in a few thousand integer operations. The per-frame work is a
 * handful of uniforms and a draw.
 *
 * Coordinates are NORMALISED to the source frame (0..1 on both axes) so nothing here knows or
 * cares whether the camera answered 320×180 or 1280×720.
 */

/** A rectangle in normalised source coordinates. */
export type Box = { x: number; y: number; w: number; h: number };

/** The thumbnail everything is measured on. 96×54 is 16:9, 5,184 pixels — a histogram from it is
 *  within a bin or two of the full frame's, and a face at a normal distance is 8–20 cells wide. */
export const THUMB_W = 96;
export const THUMB_H = 54;

/* ── LOW LIGHT ─────────────────────────────────────────────────────────────────────────────────── */

export type Exposure = {
  /** Multiplier on the low end. 1 = untouched. The shader applies it through a soft knee, so 2.5
   *  never clips a highlight — see `knee` below for the exact curve. */
  gain: number;
  /** Mid-tone lift, as the exponent's reciprocal: out = in^(1/gamma). 1 = untouched. */
  gamma: number;
  /** Mean luma of the thumbnail, 0..1 — reported so a panel can say "your room is dark". */
  mean: number;
  /** True when the picture was judged dark enough to lift at all. */
  dark: boolean;
};

/** Where "dark" begins. A well-lit desk reads 0.40–0.55; a laptop screen as the only lamp reads
 *  0.12–0.25. Between the two the lift ramps in rather than switching, so a room at dusk does not
 *  flicker between two looks. */
export const DARK_MEAN = 0.34;
/** What the lift aims for. Not 0.5: a deliberately moody room should still look like one. */
export const TARGET_MEAN = 0.42;
export const MAX_GAIN = 2.6;
export const MAX_GAMMA = 1.7;

/** Mean luma from a 256-bin histogram. */
export function histMean(hist: ArrayLike<number>): number {
  let n = 0, sum = 0;
  for (let i = 0; i < 256; i++) { n += hist[i]; sum += hist[i] * i; }
  return n === 0 ? 0 : sum / n / 255;
}

/**
 * Auto exposure from a histogram. Lifts a dark picture towards TARGET_MEAN, never darkens, and
 * splits the lift between a gain (the deep shadows) and a gamma (the mid-tones) because gain
 * alone makes a face look like a torch was pointed at it and gamma alone leaves black clothes as
 * grey mush.
 */
export function exposureFor(hist: ArrayLike<number>): Exposure {
  const mean = histMean(hist);
  if (mean >= DARK_MEAN || mean <= 0) return { gain: 1, gamma: 1, mean, dark: false };
  // Ramp: fully on at 0.6×DARK_MEAN and below, fading to nothing at DARK_MEAN.
  const ramp = Math.min(1, (DARK_MEAN - mean) / (DARK_MEAN * 0.4));
  const wanted = Math.min(MAX_GAIN, TARGET_MEAN / mean);
  // Half the lift as gain, half as gamma — in log space, so the two halves multiply back to `wanted`.
  const gain = 1 + (Math.sqrt(wanted) - 1) * ramp;
  const gamma = Math.min(MAX_GAMMA, 1 + (Math.sqrt(wanted) - 1) * ramp);
  return { gain, gamma, mean, dark: true };
}

/** A manual level (0..1, the slider) as an exposure. */
export function exposureAt(level: number): Exposure {
  const t = Math.max(0, Math.min(1, level));
  return { gain: 1 + (MAX_GAIN - 1) * t * 0.6, gamma: 1 + (MAX_GAMMA - 1) * t, mean: 0, dark: t > 0 };
}

/** The soft knee the shader applies: `in·gain / (1 + (gain−1)·in)`. Maps 0→0, 1→1, and lifts the
 *  low end by exactly `gain`. Here so a test can check the shader's curve against a reference. */
export function knee(x: number, gain: number): number {
  return (x * gain) / (1 + (gain - 1) * x);
}

/* ── FINDING THE FACE ──────────────────────────────────────────────────────────────────────────── */

/**
 * Is this pixel skin? The classic YCbCr rule (Chai & Ngan 1999): chroma in a narrow box, whatever
 * the brightness — which is what lets it hold across skin tones, since the tones differ far more in
 * luma than in chroma. Written on 0..255 integers because that is what `getImageData` hands us.
 *
 * It is wrong about wood, cardboard and some paint, all of which sit in the same chroma box. The
 * blob filters below (shape, size, position, persistence) are what make it usable regardless, and a
 * platform face detector is preferred whenever the browser has one.
 */
export function isSkin(r: number, g: number, b: number): boolean {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  if (y < 40 || y > 245) return false;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
}

/** A candidate blob: bounding box in cells plus its area and centroid. */
type Blob = { x0: number; y0: number; x1: number; y1: number; area: number; cx: number; cy: number };

/**
 * Connected components (4-neighbour) over a binary mask. Iterative flood fill with an explicit
 * stack — the mask is at most a few thousand cells, so this is microseconds, and no recursion means
 * no stack limit to think about. `labels` carries each cell's blob index + 1 (0 = background), so a
 * caller can read one blob's shape row by row without re-walking the mask.
 */
export function blobs(mask: Uint8Array, w: number, h: number): { list: Blob[]; labels: Uint16Array } {
  const labels = new Uint16Array(w * h);
  const list: Blob[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = list.length + 1;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0, sx = 0, sy = 0;
    stack.push(start); labels[start] = id;
    while (stack.length) {
      const i = stack.pop() as number;
      const x = i % w, y = (i - x) / w;
      area++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[i - 1] && !labels[i - 1]) { labels[i - 1] = id; stack.push(i - 1); }
      if (x < w - 1 && mask[i + 1] && !labels[i + 1]) { labels[i + 1] = id; stack.push(i + 1); }
      if (y > 0 && mask[i - w] && !labels[i - w]) { labels[i - w] = id; stack.push(i - w); }
      if (y < h - 1 && mask[i + w] && !labels[i + w]) { labels[i + w] = id; stack.push(i + w); }
    }
    list.push({ x0, y0, x1, y1, area, cx: sx / area, cy: sy / area });
  }
  return { list, labels };
}

/**
 * Morphological OPENING (a 3×3 erosion, then a 3×3 dilation). Anything thinner than three cells —
 * a shelf edge, a picture frame, the strap of a bag, the thread that joins a face to the wooden
 * band behind it — is gone; a face ten cells across comes back the size it was. Eight-connected on
 * purpose: a four-connected erosion leaves diagonal threads standing.
 */
export function opened(mask: Uint8Array, w: number, h: number): Uint8Array {
  const er = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    er[i] = (mask[i] & mask[i - 1] & mask[i + 1] & mask[i - w] & mask[i + w]
      & mask[i - w - 1] & mask[i - w + 1] & mask[i + w - 1] & mask[i + w + 1]) as 0 | 1;
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    let v = 0;
    for (let dy = -1; dy <= 1 && !v; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < w && yy >= 0 && yy < h && er[yy * w + xx]) { v = 1; break; }
    }
    out[i] = v;
  }
  return out;
}

/**
 * The thumbnail's skin mask, from RGBA bytes. Exported for the tests and the engine alike.
 *
 * `gain` LIFTS A DARK PICTURE FIRST. Chroma is a difference from grey, and a difference shrinks
 * with the light: a face lit by nothing but a laptop screen sits at a fifth of its daylight value
 * and its Cb/Cr collapse towards 128, out of the skin box — exactly the room where the person most
 * wanted framing and a portrait light. Scaling the thumbnail back up restores the chroma along with
 * the brightness; the engine passes the same lift the exposure will apply.
 */
export function skinMask(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, gain = 1): Uint8Array {
  const m = new Uint8Array(w * h);
  const g = Math.max(1, gain);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    m[i] = isSkin(Math.min(255, rgba[p] * g), Math.min(255, rgba[p + 1] * g), Math.min(255, rgba[p + 2] * g)) ? 1 : 0;
  }
  return m;
}

/** The lift the skin mask wants for a picture of this mean: back to a daylight-ish 0.45, capped. */
export function thumbGain(mean: number): number {
  return mean <= 0 ? 1 : Math.min(3.5, Math.max(1, 0.45 / mean));
}

/** The thumbnail's luma plane, 0..255 per cell. */
export function lumaPlane(rgba: Uint8ClampedArray | Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) out[i] = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) | 0;
  return out;
}

/**
 * MOTION — the cue that tells a person from the furniture.
 *
 * Skin chroma alone took a shelf of beige books for a face and zoomed a live call onto it, and no
 * amount of shape filtering makes wood stop being wood-coloured. What a bookshelf never does is
 * MOVE. A person talking, nodding, breathing, leaning into a sentence keeps a few cells of the
 * thumbnail changing all the time; the room behind them changes only with the light. So every
 * face candidate must sit on cells that have moved recently, more than the picture as a whole.
 *
 * `alive` holds, per cell, a smoothed recent frame difference that decays over about ten seconds
 * of stillness, so a pause for thought does not drop the face. The test is RELATIVE to the median
 * cell, which absorbs sensor grain and a camera re-exposing the whole frame, plus an absolute
 * floor so a perfectly clean, perfectly still picture never passes anything. Until eight ticks
 * (two seconds) have been seen nothing passes at all: the honest failure is the wide shot.
 */
export class Motion {
  readonly alive: Float32Array;
  private ema: Float32Array;
  private prev: Uint8Array | null = null;
  private ticks = 0;
  private median = 0;
  private readonly w: number;
  private readonly h: number;
  static readonly WARM_TICKS = 8;
  /** Absolute floor, luma levels: below this a box is furniture whatever the median says. */
  static readonly FLOOR = 2.0;
  /** A face's cells must have moved this many times more than the median cell. */
  static readonly RATIO = 3;

  constructor(w: number, h: number) {
    this.w = w; this.h = h;
    this.alive = new Float32Array(w * h);
    this.ema = new Float32Array(w * h);
  }

  observe(luma: Uint8Array): void {
    const n = this.w * this.h;
    if (this.prev) {
      for (let i = 0; i < n; i++) {
        const d = Math.abs(luma[i] - this.prev[i]);
        this.ema[i] = this.ema[i] * 0.7 + d * 0.3;
        this.alive[i] = Math.max(this.alive[i] * 0.96, this.ema[i]);
      }
      // The median of every fourth cell: the same number, a quarter of the sort.
      const sample: number[] = [];
      for (let i = 0; i < n; i += 4) sample.push(this.alive[i]);
      sample.sort((a, b) => a - b);
      this.median = sample[sample.length >> 1];
    }
    this.prev = Uint8Array.from(luma);
    this.ticks++;
  }

  get warm(): boolean { return this.ticks >= Motion.WARM_TICKS; }

  /** Mean recent movement inside a normalised box, in luma levels. */
  energy(box: Box): number {
    const x0 = Math.max(0, Math.floor(box.x * this.w)), x1 = Math.min(this.w, Math.ceil((box.x + box.w) * this.w));
    const y0 = Math.max(0, Math.floor(box.y * this.h)), y1 = Math.min(this.h, Math.ceil((box.y + box.h) * this.h));
    let s = 0, c = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += this.alive[y * this.w + x]; c++; }
    return c ? s / c : 0;
  }

  /** May this box be a person? */
  gate(box: Box): boolean {
    if (!this.warm) return false;
    return this.energy(box) >= Math.max(Motion.FLOOR, this.median * Motion.RATIO);
  }
}

/** 256-bin luma histogram of the thumbnail. */
export function lumaHist(rgba: Uint8ClampedArray | Uint8Array, n: number): Uint32Array {
  const h = new Uint32Array(256);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    h[(0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) | 0]++;
  }
  return h;
}

/**
 * The face, from the skin mask — the fallback for browsers with no face detector.
 *
 * A face is the skin blob that is (a) big enough to be a head at conversation distance and not so
 * big it is a wall, (b) roughly as tall as it is wide — a bookshelf is a band, an arm is a stick,
 * (c) in the upper three quarters of the picture, and (d) when several qualify, the one nearest
 * where the face was a moment ago, then the one nearest the middle. A blob taller than 1.35× its
 * width is trimmed from the bottom: that is a face joined to a neck or a bare shoulder, and the
 * face is the top of it.
 *
 * Returns null rather than guessing. The framer treats null as "hold, then drift back to the full
 * picture", which is the right failure: a wrong face zooms the call onto a lamp.
 */
export function faceFromMask(raw: Uint8Array, w: number, h: number, prev: Box | null, accept?: (box: Box) => boolean): Box | null {
  const mask = opened(raw, w, h);
  const total = w * h;
  const { list, labels } = blobs(mask, w, h);
  let best: Box | null = null;
  let bestScore = -Infinity;
  for (let bi = 0; bi < list.length; bi++) {
    const b = list[bi], id = bi + 1;
    if (b.area > total * 0.5) continue;                                 // a wall
    // THE HEAD IS THE TOP OF THE BLOB, read row by row. A face's width grows from the forehead
    // to the cheeks and then NARROWS towards the chin; the neck is narrower still; and then
    // shoulders, a collar, the wooden edge of a shelf behind the chin, or a skin-coloured shirt
    // widen again — sometimes abruptly, more often along a curve. Three rules end the head, any
    // one of them: a row 1.3× wider than the widest row above it (a shoulder, a shelf); the
    // narrowest row below the cheeks once the profile widens again (the chin above a neck); or a
    // height of 1.35× the width (as tall as a head gets, for a chin that runs into a collar with
    // no visible neck). The box that is judged is the face — not the person wearing it.
    const rows: { wr: number; x0: number; x1: number }[] = [];
    let wMax = 0, wMin = 0, minRow = -1, narrowing = false, end = -1;
    for (let y = b.y0; y <= b.y1; y++) {
      let wr = 0, rx0 = w, rx1 = -1;
      for (let x = b.x0; x <= b.x1; x++) if (labels[y * w + x] === id) { wr++; if (x < rx0) rx0 = x; if (x > rx1) rx1 = x; }
      const r = y - b.y0;
      if (r >= 4 && wr > 1.3 * wMax) { end = r - 1; break; }                       // shoulders, a shelf
      if (narrowing) {
        if (wr < wMin) { wMin = wr; minRow = r; }
        else if (wr >= wMin * 1.15 + 1) { end = minRow; break; }                    // the chin, then a collar
      } else if (wMax >= 4 && wr <= 0.9 * wMax) { narrowing = true; wMin = wr; minRow = r; }
      if (wr > wMax) wMax = wr;
      rows.push({ wr, x0: rx0, x1: rx1 });
      if (wMax >= 4 && rows.length >= Math.round(1.35 * wMax)) { end = rows.length - 1; break; } // as tall as a head gets
    }
    if (end < 0) end = rows.length - 1;
    let cells = 0, hx0 = w, hx1 = -1;
    for (let r = 0; r <= end; r++) { cells += rows[r].wr; if (rows[r].x0 < hx0) hx0 = rows[r].x0; if (rows[r].x1 > hx1) hx1 = rows[r].x1; }
    const bw = hx1 - hx0 + 1, bh = end + 1;
    if (bw <= 0 || cells < total * 0.005) continue;                     // a nose at five metres
    if (cells / (bw * bh) < 0.4) continue;                              // a ring, a diagonal, noise
    const aspect = bw / bh;
    if (aspect < 0.5 || aspect > 1.7) continue;                         // sticks and bands
    const cx = (hx0 + bw / 2) / w, cy = (b.y0 + bh / 2) / h;
    if (cy > 0.78) continue;                                            // hands on the desk
    const box: Box = { x: hx0 / w, y: b.y0 / h, w: bw / w, h: bh / h };
    if (accept && !accept(box)) continue;                               // furniture: see Motion
    let score = cells / total;                                          // bigger is more face-like
    score -= 0.4 * Math.hypot(cx - 0.5, cy - 0.42);                     // nearer the middle
    if (prev) score += 0.6 * (1 - Math.min(1, Math.hypot(cx - (prev.x + prev.w / 2), cy - (prev.y + prev.h / 2)) * 4));
    if (score > bestScore) { bestScore = score; best = box; }
  }
  return best;
}

/* ── FRAMING ───────────────────────────────────────────────────────────────────────────────────── */

/** The most the picture may be enlarged. Two is where a 720p capture still fills a 360p output
 *  pixel-for-pixel; past it the tile is visibly soft, and softness is the one thing a framing
 *  feature must not add. */
export const MAX_ZOOM = 2;
/** How much of the crop's height the face should take up. A third reads as a portrait; a half is
 *  a passport photo. */
const FACE_SHARE = 0.34;
/** Where the face's centre sits vertically in the crop — above the middle, like every portrait. */
const EYE_LINE = 0.42;

/**
 * The crop that frames a face, for an output of a given aspect on a source of a given aspect.
 * Always inside the source, never enlarged past MAX_ZOOM, and always the OUTPUT's shape so nothing
 * is stretched.
 */
export function frameFor(face: Box, srcAspect: number, outAspect: number, maxZoom = MAX_ZOOM): Box {
  // Crop height in normalised units; width follows from the aspects.
  let h = Math.min(1, Math.max(1 / maxZoom, face.h / FACE_SHARE));
  let w = h * (outAspect / srcAspect);
  if (w > 1) { w = 1; h = w * (srcAspect / outAspect); }
  if (h > 1) { h = 1; w = h * (outAspect / srcAspect); }
  const fx = face.x + face.w / 2, fy = face.y + face.h / 2;
  const x = clamp(fx - w / 2, 0, 1 - w);
  const y = clamp(fy - h * EYE_LINE, 0, 1 - h);
  return { x, y, w, h };
}

/** The whole source, shaped to the output. */
export function fullFrame(srcAspect: number, outAspect: number): Box {
  return frameFor({ x: 0, y: 0, w: 1, h: 1 / FACE_SHARE }, srcAspect, outAspect);
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

/**
 * The FRAMER: turns a stream of face readings (noisy, four a second, sometimes missing) into a
 * crop that moves the way a camera operator would — not at all for small fidgets, then smoothly,
 * and back to the wide shot when the person leaves.
 *
 *  · DEAD ZONE. A new reading only becomes a new target when it disagrees with the current target
 *    by more than a tenth of the crop (position) or a quarter (size). Nodding, talking and leaning
 *    into a sentence never move the picture.
 *  · SETTLE. Even then, the reading has to hold for SETTLE_MS before the glide starts — a hand
 *    passing the face, or a detector flickering onto a lamp, is gone before that.
 *  · GLIDE. The crop approaches the target exponentially (a fraction of the remaining distance per
 *    second), which is what looks like a person panning: quick to start, slow to arrive, no overshoot.
 *  · LOST. No face for LOST_MS and the target is the full picture, reached by the same glide.
 */
export class Framer {
  private target: Box;
  private cur: Box;
  private pending: Box | null = null;
  private pendingSince = 0;
  private lastSeen = 0;
  private face: Box | null = null;
  static readonly SETTLE_MS = 600;
  static readonly LOST_MS = 4000;
  /** Per second: the fraction of the remaining distance closed. 3 ⇒ ~95% in a second. */
  static readonly GLIDE = 3;

  private srcAspect: number;
  private outAspect: number;
  /** The heuristic face-finder is trusted less than a platform detector: a wrong zoom of 1.7×
   *  is a mild fault, a wrong zoom of 2× is a call cropped onto a lamp. */
  private readonly maxZoom: number;

  constructor(srcAspect: number, outAspect: number, maxZoom = MAX_ZOOM) {
    this.srcAspect = srcAspect; this.outAspect = outAspect; this.maxZoom = maxZoom;
    this.target = this.cur = fullFrame(srcAspect, outAspect);
  }

  /** The source or output shape changed — start again from the wide shot. */
  reshape(srcAspect: number, outAspect: number): void {
    this.srcAspect = srcAspect; this.outAspect = outAspect;
    this.target = this.cur = fullFrame(srcAspect, outAspect);
    this.pending = null;
  }

  /** The last face accepted — in source coordinates, for the portrait light. */
  get lastFace(): Box | null { return this.face; }

  /** Feed one reading (or a miss) at time `now` (ms). */
  observe(face: Box | null, now: number): void {
    if (!face) {
      if (this.lastSeen && now - this.lastSeen > Framer.LOST_MS) {
        this.target = fullFrame(this.srcAspect, this.outAspect);
        this.face = null;
        this.pending = null;
      }
      return;
    }
    this.lastSeen = now;
    this.face = face;
    const want = frameFor(face, this.srcAspect, this.outAspect, this.maxZoom);
    if (!differs(want, this.target)) { this.pending = null; return; }
    if (this.pending && !differs(want, this.pending)) {
      if (now - this.pendingSince >= Framer.SETTLE_MS) { this.target = want; this.pending = null; }
    } else { this.pending = want; this.pendingSince = now; }
  }

  /** Advance the glide by `dtMs` and return the crop to draw. */
  step(dtMs: number): Box {
    const k = 1 - Math.exp(-Framer.GLIDE * Math.max(0, dtMs) / 1000);
    const c = this.cur, t = this.target;
    this.cur = {
      x: c.x + (t.x - c.x) * k, y: c.y + (t.y - c.y) * k,
      w: c.w + (t.w - c.w) * k, h: c.h + (t.h - c.h) * k,
    };
    // Snap the last hundredth of a percent so a settled crop is bit-stable, not forever creeping.
    if (Math.abs(this.cur.x - t.x) + Math.abs(this.cur.y - t.y) + Math.abs(this.cur.w - t.w) < 1e-4) this.cur = { ...t };
    return this.cur;
  }

  /** Where the glide is going — for tests, and for a panel that wants to say "re-framing". */
  get goal(): Box { return this.target; }
  get crop(): Box { return this.cur; }
}

/** The dead zone: a tenth of the crop in position, a quarter in size. */
function differs(a: Box, b: Box): boolean {
  return Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) > b.w * 0.1
    || Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) > b.h * 0.1
    || Math.abs(a.w - b.w) > b.w * 0.25;
}

/* ── THE GOVERNOR ──────────────────────────────────────────────────────────────────────────────── */

/**
 * How much of the frame interval the look may spend, before it gives something up.
 *
 * The rule the whole feature answers to: a look that costs the call its frame rate, or the audio
 * thread its CPU, is not a feature. So the engine times itself every frame, and this decides — from
 * a smoothed cost — which of three levels to run at:
 *
 *   2  everything: touch-up, light, portrait, framing, capture supersampled for framing
 *   1  the cheap half: no touch-up blur passes, detection at half rate, no supersampling
 *   0  passthrough: one blit, the picture goes out untouched, the panel says why
 *
 * Down is quick (two seconds over budget), up is slow (twenty seconds well under) — the same shape
 * as the link ladder in webrtc.ts, for the same reason: nothing is worse than a picture that
 * changes character every few seconds.
 */
export class Governor {
  private ema = 0;
  private over = 0;
  private under = 0;
  private lvl: 0 | 1 | 2;
  /** Fraction of the frame interval that is too much. A third leaves the encoder, the compositor
   *  and the audio graph the other two thirds of every frame. */
  static readonly OVER = 0.33;
  /** Fraction that is comfortably little. */
  static readonly UNDER = 0.12;
  static readonly DOWN_MS = 2000;
  static readonly UP_MS = 20000;

  constructor(start: 0 | 1 | 2 = 2) { this.lvl = start; }

  get level(): 0 | 1 | 2 { return this.lvl; }
  get costMs(): number { return this.ema; }

  /** One frame took `ms`, on a stream whose frames are `intervalMs` apart. Returns the level. */
  record(ms: number, intervalMs: number): 0 | 1 | 2 {
    this.ema = this.ema === 0 ? ms : this.ema * 0.9 + ms * 0.1;
    const share = this.ema / Math.max(1, intervalMs);
    if (share > Governor.OVER) { this.over += intervalMs; this.under = 0; }
    else if (share < Governor.UNDER) { this.under += intervalMs; this.over = 0; }
    else { this.over = 0; this.under = 0; }
    if (this.over >= Governor.DOWN_MS && this.lvl > 0) { this.lvl = (this.lvl - 1) as 0 | 1; this.over = 0; this.ema = 0; }
    else if (this.under >= Governor.UP_MS && this.lvl < 2) { this.lvl = (this.lvl + 1) as 1 | 2; this.under = 0; this.ema = 0; }
    return this.lvl;
  }
}
