/**
 * THE FRAME EVERY OTHER MEETING IS RECORDED IN.
 *
 * ArtaCast has a kit: two windows above, the host below, a timeline down each edge. An ordinary
 * meeting has none of that — it has a title and however many people turned up — so it gets the
 * plainest thing that still looks made: everyone on a grid that fills the 1920×1080, each name on
 * a plate under their own window, the meeting's title along the bottom with the clock.
 *
 * Same size, same frame rate, same file: what leaves this canvas goes down the identical road an
 * episode does — the host's Downloads, their shelf, Kaggle, −14 LUFS, YouTube.
 */

export const FRAME_W = 1920;
export const FRAME_H = 1080;

const INK1 = "#F4F4F5", INK2 = "#A6A8B0";
const SPACE = "#010C17", WINDOW = "#0C1E32", GOLD = "#E8B923";
const DISPLAY = 'Montserrat, "Helvetica Neue", Arial, sans-serif';
const BODY = 'Inter, "Helvetica Neue", Arial, sans-serif';

export type Tile = { uid: number; name: string; video: CanvasImageSource | null };

/** Columns × rows for n people, in the shape that wastes the least of a 16:9 frame. */
export function gridOf(n: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n <= 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  if (n <= 9) return { cols: 3, rows: 3 };
  return { cols: 4, rows: 3 };
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

/** One window: the picture cover-fitted into the box, or the empty box when there is none. */
function window_(ctx: CanvasRenderingContext2D, v: CanvasImageSource | null, x: number, y: number, w: number, h: number) {
  ctx.save();
  roundRect(ctx, x, y, w, h, 16);
  ctx.fillStyle = WINDOW;
  ctx.fill();
  ctx.clip();
  const vw = (v as HTMLVideoElement)?.videoWidth || 0;
  const vh = (v as HTMLVideoElement)?.videoHeight || 0;
  if (v && vw > 0 && vh > 0) {
    const s = Math.max(w / vw, h / vh);
    const dw = vw * s, dh = vh * s;
    ctx.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }
  ctx.restore();
}

/** A name on a plate, bottom-left of its own window — the same plate the kit uses. */
function plate(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, h: number, scale: number) {
  const text = (name || "").trim();
  if (!text) return;
  const size = Math.round(30 * scale);
  ctx.save();
  ctx.font = `600 ${size}px ${BODY}`;
  ctx.textBaseline = "middle";
  const padX = Math.round(14 * scale), boxH = Math.round(size * 1.75);
  const w = ctx.measureText(text).width + padX * 2;
  const bx = x + Math.round(14 * scale), by = y + h - boxH - Math.round(14 * scale);
  ctx.fillStyle = "rgba(1,12,23,0.72)";
  roundRect(ctx, bx, by, w, boxH, Math.round(6 * scale));
  ctx.fill();
  ctx.fillStyle = GOLD;
  ctx.fillRect(bx, by, Math.max(3, Math.round(4 * scale)), boxH);
  ctx.fillStyle = INK1;
  ctx.fillText(text, bx + padX, by + boxH / 2);
  ctx.restore();
}

/** mm:ss (or h:mm:ss past an hour) for the clock on the frame. */
export function clockLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const p = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`;
}

/** Draw one whole frame. Call at the recording's frame rate. */
export function drawMeetingFrame(
  ctx: CanvasRenderingContext2D,
  tiles: Tile[],
  opts: { title: string; seconds: number; names: boolean },
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = SPACE;
  ctx.fillRect(0, 0, FRAME_W, FRAME_H);

  const people = tiles.slice(0, 12);
  const { cols, rows } = gridOf(Math.max(1, people.length));
  const pad = 24, foot = 92;
  const areaW = FRAME_W - pad * 2, areaH = FRAME_H - pad * 2 - foot;
  const cw = Math.floor((areaW - pad * (cols - 1)) / cols);
  const ch = Math.floor((areaH - pad * (rows - 1)) / rows);
  // The last row is centred when it is short, so three people do not leave a hole on the right.
  people.forEach((t, i) => {
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, people.length - row * cols);
    const offset = Math.round(((cols - inRow) * (cw + pad)) / 2);
    const col = i % cols;
    const x = pad + offset + col * (cw + pad);
    const y = pad + row * (ch + pad);
    window_(ctx, t.video, x, y, cw, ch);
    if (opts.names) plate(ctx, t.name, x, y, ch, Math.min(1, cw / 900));
  });

  // The foot: the meeting's title on the left, the clock on the right.
  ctx.save();
  ctx.textBaseline = "middle";
  const fy = FRAME_H - foot / 2 - 4;
  ctx.fillStyle = INK1;
  ctx.font = `700 40px ${DISPLAY}`;
  const title = (opts.title || "").trim();
  if (title) ctx.fillText(title.length > 60 ? `${title.slice(0, 59)}…` : title, pad + 6, fy);
  ctx.fillStyle = INK2;
  ctx.font = `500 34px ${BODY}`;
  ctx.textAlign = "right";
  ctx.fillText(clockLabel(opts.seconds), FRAME_W - pad - 6, fy);
  ctx.restore();
}

/** The file name a meeting recording carries — its title and the day, as the host's clock sees it. */
export function meetingRecordingName(title: string, ext: string, when = new Date()): string {
  const clean = (s: string) => (s || "").normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}`;
  return `${clean(title) || "Meeting"}-${day}.${ext}`;
}
