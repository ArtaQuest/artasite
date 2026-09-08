import type { CastRow, CastSide } from "./api";
import { timelineRows } from "./cast-frame";

/**
 * THE EPISODE FRAME, DRAWN ON A CANVAS — the YouTube kit's Main board (1920×1080) as pixels.
 *
 * components/cast/CastPreview.tsx draws the same board as DOM for the couple's live preview. This
 * is the same geometry drawn with Canvas 2D, because a canvas is the only thing a browser can turn
 * into a video track (`captureStream`) and hand to MediaRecorder. The two must agree: every number
 * here is the kit's — windows 912×513 at (32,18) and (976,18), the host 640×360 at (640,625), the
 * lower-third's 10px blue bar and two hugging black-80% plates, the two timelines on 6px rails at
 * the frame's outer edges with 64px rows, both lists on one top. No mark airs on the interview
 * frame. Two colours only. Pure: no React, no DOM beyond the canvas it is handed, so it can be
 * exercised in a test page with synthetic video.
 */

export const FRAME_W = 1920;
export const FRAME_H = 1080;

export type EpisodeSpec = {
  meet_id: number;
  host_id: number;
  a: CastSide & { uid: number };
  b: CastSide & { uid: number };
  married_y: number;
  title: string;
};

/** What the compositor is told each frame: which video element carries which window, and the
 *  chapter each timeline has reached. */
export type FrameInput = {
  a: CanvasImageSource | null;
  b: CanvasImageSource | null;
  host: CanvasImageSource | null;
  /** Index of the current row on each rail — the gold reaches this far, the cursor sits here. */
  cursorA: number;
  cursorB: number;
  /** Lower-thirds shown or hidden (they come in on a guest's first words and leave later). */
  names: boolean;
};

const INK1 = "#F4F4F5", INK2 = "#A6A8B0", INK3 = "#8B8E98";
const SPACE = "#010C17", WINDOW = "#0C1E32", GOLD = "#E8B923", BLUE = "#1746DC";
const DISPLAY = 'Montserrat, "Helvetica Neue", Arial, sans-serif';
const BODY = 'Inter, "Helvetica Neue", Arial, sans-serif';

/** Ask the browser to have the two faces ready before the first frame is drawn — a frame drawn in
 *  a fallback face and re-drawn in Montserrat a second later is a visible flicker on the record. */
export async function warmFonts(): Promise<void> {
  const f = (document as unknown as { fonts?: { load: (s: string) => Promise<unknown> } }).fonts;
  if (!f) return;
  await Promise.all([
    f.load("700 60px Montserrat"), f.load("700 32px Montserrat"), f.load("600 44px Inter"), f.load("500 28px Inter"),
  ]).catch(() => undefined);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The natural size of whatever is being drawn, so a 4:3 camera can be COVER-fitted. */
function sizeOf(src: CanvasImageSource): [number, number] {
  const v = src as HTMLVideoElement;
  if (typeof v.videoWidth === "number" && v.videoWidth > 0) return [v.videoWidth, v.videoHeight];
  const c = src as HTMLCanvasElement;
  if (typeof c.width === "number" && c.width > 0) return [c.width, c.height];
  const i = src as HTMLImageElement;
  return [i.naturalWidth || 16, i.naturalHeight || 9];
}

/** The kit's placeholder bust, for a window whose feed has not arrived. */
function bust(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const s = w / 912;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s * (h / w) / (513 / 912));
  ctx.fillStyle = INK3;
  ctx.globalAlpha = 0.25;
  ctx.beginPath(); ctx.ellipse(456, 235, 105, 140, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(416, 360); ctx.lineTo(496, 360); ctx.lineTo(496, 410);
  ctx.bezierCurveTo(540, 450, 760, 470, 820, 513); ctx.lineTo(92, 513);
  ctx.bezierCurveTo(152, 470, 372, 450, 416, 410); ctx.closePath(); ctx.fill();
  ctx.restore();
}

/** One window: rounded, clipped, the feed COVER-fitted (a 16:9 feed fills it exactly, which is
 *  the kit's "no crop"; a phone held upright is centred and cropped rather than letterboxed). */
function window_(ctx: CanvasRenderingContext2D, src: CanvasImageSource | null, x: number, y: number, w: number, h: number) {
  ctx.save();
  roundRect(ctx, x, y, w, h, 16);
  ctx.clip();
  ctx.fillStyle = WINDOW;
  ctx.fillRect(x, y, w, h);
  if (src) {
    const [sw, sh] = sizeOf(src);
    const s = Math.max(w / sw, h / sh);
    const dw = sw * s, dh = sh * s;
    try { ctx.drawImage(src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); } catch { bust(ctx, x, y, w, h); }
  } else {
    bust(ctx, x, y, w, h);
  }
  ctx.restore();
}

/** Greedy word wrap at a pixel width; a single word wider than the line stands alone. */
function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(t).width <= max || !cur) cur = t;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * The lower-third, flush to a window's bottom-left. The name is set at 60/64 on one line when it
 * fits the 858px maximum, else at 48/52 and wrapped; the subtitle is one line at 44/48 and is
 * clipped rather than wrapped (the couple is told it is one line). Both plates hug their text.
 */
function lowerThird(ctx: CanvasRenderingContext2D, side: CastSide, wx: number, wy: number, ww: number, wh: number) {
  const name = (side.name || "").trim();
  if (!name) return;
  const sub = (side.subtitle || "").trim();
  const MAX = 858;
  ctx.font = `700 60px ${DISPLAY}`;
  let size = 60, lh = 64;
  let lines = [name];
  if (ctx.measureText(name).width > MAX) {
    size = 48; lh = 52;
    ctx.font = `700 48px ${DISPLAY}`;
    lines = wrap(ctx, name, MAX);
  }
  const nameW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const nameH = 10 + lines.length * lh + 10;
  ctx.font = `600 44px ${BODY}`;
  const subW = sub ? Math.min(ctx.measureText(sub).width, ww - 10 - 44) : 0;
  const subH = sub ? 6 + 48 + 6 : 0;
  const gap = sub ? 6 : 0;
  const total = nameH + gap + subH;
  const left = wx, bottom = wy + wh;
  // the bar, full height through the gap
  ctx.fillStyle = BLUE;
  ctx.fillRect(left, bottom - total, 10, total);
  // name plate
  ctx.fillStyle = "rgba(0,0,0,0.80)";
  ctx.fillRect(left + 10, bottom - total, 20 + nameW + 24, nameH);
  ctx.fillStyle = INK1;
  ctx.font = `700 ${size}px ${DISPLAY}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  lines.forEach((l, i) => ctx.fillText(l, left + 10 + 20, bottom - total + 10 + lh * i + lh * 0.78));
  if (sub) {
    const top = bottom - subH;
    ctx.fillStyle = "rgba(0,0,0,0.80)";
    ctx.fillRect(left + 10, top, 20 + subW + 24, subH);
    ctx.save();
    ctx.beginPath(); ctx.rect(left + 10, top, 20 + subW + 24, subH); ctx.clip();
    ctx.fillStyle = INK1;
    ctx.font = `600 44px ${BODY}`;
    ctx.fillText(sub, left + 10 + 20, top + 6 + 48 * 0.76);
    ctx.restore();
  }
}

/** One spouse's timeline: his reads left to right from the left rail, hers right to left from
 *  the right rail. The rail is gold as far as the cursor, ink-3 ahead; the cursor's tick is 34. */
function timeline(ctx: CanvasRenderingContext2D, rows: CastRow[], right: boolean, top: number, cursor: number) {
  const n = rows.length;
  if (!n) return;
  const x0 = right ? 1312 : 32;
  const railX = right ? x0 + 576 - 9 - 6 : x0 + 9;
  const cur = Math.max(0, Math.min(n - 1, cursor));
  ctx.fillStyle = INK3;
  ctx.fillRect(railX, top + 32, 6, Math.max(0, (n - 1) * 64));
  ctx.fillStyle = GOLD;
  ctx.fillRect(railX, top + 32, 6, cur * 64);
  rows.forEach((r, i) => {
    const y = top + i * 64;
    const past = i < cur, now = i === cur;
    const tickW = now ? 34 : 24;
    ctx.fillStyle = i <= cur ? GOLD : INK3;
    ctx.fillRect(right ? x0 + 576 - tickW : x0, y + 29, tickW, 6);
    const color = now ? INK1 : past ? INK2 : INK3;
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.font = `700 32px ${DISPLAY}`;
    const yearW = ctx.measureText(String(r.y)).width;
    ctx.font = `500 28px ${BODY}`;
    const labW = ctx.measureText(r.l).width;
    if (!right) {
      ctx.textAlign = "left";
      ctx.font = `700 32px ${DISPLAY}`; ctx.fillText(String(r.y), x0 + 40, y + 32);
      ctx.font = `500 28px ${BODY}`; ctx.fillText(r.l, x0 + 40 + yearW + 16, y + 32);
    } else {
      ctx.textAlign = "right";
      ctx.font = `700 32px ${DISPLAY}`; ctx.fillText(String(r.y), x0 + 576 - 40, y + 32);
      ctx.font = `500 28px ${BODY}`; ctx.fillText(r.l, x0 + 576 - 40 - yearW - 16, y + 32);
      void labW;
    }
  });
}

/** The rows each rail shows, and where their shared top sits — computed once per spec. */
export function episodeRows(spec: EpisodeSpec): { a: CastRow[]; b: CastRow[]; top: number } {
  const a = timelineRows(spec.a, spec.married_y);
  const b = timelineRows(spec.b, spec.married_y);
  const most = Math.max(a.length, b.length, 1);
  return { a, b, top: Math.round(549 + (513 - most * 64) / 2) };
}

/** Draw one whole frame. Call at the recording's frame rate. */
export function drawEpisodeFrame(ctx: CanvasRenderingContext2D, spec: EpisodeSpec, rows: ReturnType<typeof episodeRows>, input: FrameInput): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = SPACE;
  ctx.fillRect(0, 0, FRAME_W, FRAME_H);
  window_(ctx, input.a, 32, 18, 912, 513);
  window_(ctx, input.b, 976, 18, 912, 513);
  window_(ctx, input.host, 640, 625, 640, 360);
  if (input.names) {
    lowerThird(ctx, spec.a, 32, 18, 912, 513);
    lowerThird(ctx, spec.b, 976, 18, 912, 513);
  }
  timeline(ctx, rows.a, false, rows.top, input.cursorA);
  timeline(ctx, rows.b, true, rows.top, input.cursorB);
}

/** The container/codec MediaRecorder will write, best first: H.264 + AAC in MP4 is what every
 *  editor and YouTube take without a remux; VP9/Opus in WebM is what YouTube also accepts directly. */
export function pickRecordingType(): { mime: string; ext: string; label: string } | null {
  const MR = (globalThis as unknown as { MediaRecorder?: { isTypeSupported?: (t: string) => boolean } }).MediaRecorder;
  if (!MR?.isTypeSupported) return null;
  const tries: [string, string, string][] = [
    ["video/mp4;codecs=avc1.640028,mp4a.40.2", "mp4", "MP4 · H.264 High + AAC"],
    ["video/mp4;codecs=avc1.4d0028,mp4a.40.2", "mp4", "MP4 · H.264 Main + AAC"],
    ["video/mp4;codecs=avc1,mp4a.40.2", "mp4", "MP4 · H.264 + AAC"],
    ["video/mp4;codecs=avc1,opus", "mp4", "MP4 · H.264 + Opus"],
    ["video/mp4", "mp4", "MP4"],
    ["video/webm;codecs=vp9,opus", "webm", "WebM · VP9 + Opus"],
    ["video/webm;codecs=vp8,opus", "webm", "WebM · VP8 + Opus"],
    ["video/webm", "webm", "WebM"],
  ];
  for (const [mime, ext, label] of tries) {
    try { if (MR.isTypeSupported(mime)) return { mime, ext, label }; } catch { /* next */ }
  }
  return null;
}

/** A file name an editor can read at a glance. */
export function recordingName(spec: EpisodeSpec, ext: string, when = new Date()): string {
  const clean = (s: string) => (s || "").normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "guest";
  const d = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
  return `ArtaCast-${clean(spec.a.name)}-${clean(spec.b.name)}-${d}.${ext}`;
}
