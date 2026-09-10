/**
 * pico — a face detector small enough to carry in a call.
 *
 * "Object Detection with Pixel Intensity Comparisons Organized in Decision Trees" (Markuš et al.,
 * 2013): a cascade of 468 depth-6 decision trees whose every node compares two pixels. No
 * convolutions, no matrix maths, no wasm, no model download of any size worth noticing — the whole
 * cascade is a 240 KB file, and a full scan of a 320×180 frame is a few milliseconds of plain
 * JavaScript. That is the budget a call can afford four times a second, which is why this and not
 * a neural detector is what auto-framing and the portrait light look through.
 *
 * Ported from nenadmarkus/picojs (pico.js, MIT) — the same arithmetic, typed and without globals.
 * The cascade file is nenadmarkus/pico `rnt/cascades/facefinder` (MIT), shipped under
 * public/look/. It finds frontal and near-frontal faces from about 20px across; a profile, a
 * hand over the mouth, or the back of a head are not faces to it, which is the right failure for
 * framing — the framer holds, then drifts back to the wide shot.
 *
 * Coordinates: pico thinks in (row, column, size) with the origin at the top-left, size being the
 * side of the square window. `detect` translates to the normalised boxes look-math uses.
 */

export type Classifier = (r: number, c: number, s: number, pixels: Uint8Array, ldim: number) => number;

/** A detection: centre row/column and side in pixels, plus the cascade's score. */
export type Detection = { r: number; c: number; s: number; q: number };

/** Parse a cascade file into its classification function. */
export function unpackCascade(bytes: Uint8Array): Classifier {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The first 8 bytes are a version number and training bookkeeping, then the tree depth and count.
  let p = 8;
  const tdepth = dv.getInt32(p, true); p += 4;
  const ntrees = dv.getInt32(p, true); p += 4;
  const pow2 = 1 << tdepth;
  const tcodes = new Int8Array(ntrees * 4 * pow2);
  const tpreds = new Float32Array(ntrees * pow2);
  const thresh = new Float32Array(ntrees);
  for (let t = 0; t < ntrees; t++) {
    // Node 0 is unused (indices start at 1), so each tree's codes begin with four zero bytes.
    const base = t * 4 * pow2 + 4;
    const n = 4 * pow2 - 4;
    for (let i = 0; i < n; i++) tcodes[base + i] = dv.getInt8(p + i);
    p += n;
    for (let i = 0; i < pow2; i++) { tpreds[t * pow2 + i] = dv.getFloat32(p, true); p += 4; }
    thresh[t] = dv.getFloat32(p, true); p += 4;
  }
  return (r, c, s, pixels, ldim) => {
    r *= 256; c *= 256;
    let root = 0, o = 0;
    for (let i = 0; i < ntrees; i++) {
      let idx = 1;
      for (let j = 0; j < tdepth; j++) {
        // `>> 8` is the integer division the fixed-point offsets above were scaled for.
        const a = pixels[((r + tcodes[root + 4 * idx] * s) >> 8) * ldim + ((c + tcodes[root + 4 * idx + 1] * s) >> 8)];
        const b = pixels[((r + tcodes[root + 4 * idx + 2] * s) >> 8) * ldim + ((c + tcodes[root + 4 * idx + 3] * s) >> 8)];
        idx = 2 * idx + (a <= b ? 1 : 0);
      }
      o += tpreds[pow2 * i + idx - pow2];
      if (o <= thresh[i]) return -1;
      root += 4 * pow2;
    }
    return o - thresh[ntrees - 1];
  };
}

export type ScanParams = {
  /** Smallest and largest face side to look for, pixels. */
  minsize: number; maxsize: number;
  /** Window step as a fraction of its size, and the ratio between successive sizes. */
  shiftfactor: number; scalefactor: number;
};

/** Slide the classifier over a grey image at every scale. */
export function runCascade(pixels: Uint8Array, nrows: number, ncols: number, classify: Classifier, p: ScanParams): Detection[] {
  const out: Detection[] = [];
  let scale = p.minsize;
  while (scale <= p.maxsize) {
    const step = Math.max(p.shiftfactor * scale, 1) >> 0;
    const offset = (scale / 2 + 1) >> 0;
    for (let r = offset; r <= nrows - offset; r += step) {
      for (let c = offset; c <= ncols - offset; c += step) {
        const q = classify(r, c, scale, pixels, ncols);
        if (q > 0) out.push({ r, c, s: scale, q });
      }
    }
    scale *= p.scalefactor;
  }
  return out;
}

/** Non-maximum suppression: overlapping windows become one detection with their scores summed —
 *  so a real face, hit at several positions and scales, outscores a lone accident. */
export function clusterDetections(dets: Detection[], iou = 0.2): Detection[] {
  dets = dets.slice().sort((a, b) => b.q - a.q);
  const iouOf = (a: Detection, b: Detection): number => {
    const overr = Math.max(0, Math.min(a.r + a.s / 2, b.r + b.s / 2) - Math.max(a.r - a.s / 2, b.r - b.s / 2));
    const overc = Math.max(0, Math.min(a.c + a.s / 2, b.c + b.s / 2) - Math.max(a.c - a.s / 2, b.c - b.s / 2));
    return overr * overc / (a.s * a.s + b.s * b.s - overr * overc);
  };
  const taken = new Uint8Array(dets.length);
  const out: Detection[] = [];
  for (let i = 0; i < dets.length; i++) {
    if (taken[i]) continue;
    let r = 0, c = 0, s = 0, q = 0, n = 0;
    for (let j = i; j < dets.length; j++) {
      if (iouOf(dets[i], dets[j]) > iou) { taken[j] = 1; r += dets[j].r; c += dets[j].c; s += dets[j].s; q += dets[j].q; n++; }
    }
    out.push({ r: r / n, c: c / n, s: s / n, q });
  }
  return out;
}

/** The grey plane of an RGBA buffer. */
export function greyOf(rgba: Uint8ClampedArray | Uint8Array, n: number): Uint8Array {
  const g = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) g[i] = (2 * rgba[p] + 7 * rgba[p + 1] + rgba[p + 2]) / 10;
  return g;
}

/** A face as a normalised box, or null. `minScore` is the clustered score a face must reach —
 *  the picojs demo draws at 50; a call frames at a little more, because a wrong frame is worse
 *  than a missed one. */
export function bestFace(clusters: Detection[], ncols: number, nrows: number, minScore = 60): { x: number; y: number; w: number; h: number; q: number } | null {
  let best: Detection | null = null;
  for (const d of clusters) if (d.q >= minScore && (!best || d.q > best.q)) best = d;
  if (!best) return null;
  // pico's window is a square around the face centre; the box handed on is the square itself.
  return { x: (best.c - best.s / 2) / ncols, y: (best.r - best.s / 2) / nrows, w: best.s / ncols, h: best.s / nrows, q: best.q };
}
