// ArtaRead PDF extraction v4 — turn an uploaded PDF into a clean, THEMED article entirely ON DEVICE.
// Renders through the shared ReadMode, so dark/light, ArtaContrast, the Aa panel, ArtaTTS and the
// on-device translator all apply for free.
//
// LAYOUT MODEL (operator, 2026-07-23 — a full rewrite for real 2-column papers):
//   1. FIGURES come from NON-TEXT ink. The page is rendered; every text glyph's box is masked out of
//      an ink grid; the remaining ink (strokes, plots, photos) is clustered into figure regions, and
//      any text sitting INSIDE a figure (axis labels, legend) is absorbed into it. So text is NEVER
//      mis-cropped as a "figure", and a plot's labels never leak into the prose.
//   2. EQUATIONS + TABLES are symbol-heavy / column-aligned TEXT lines — cropped PIXEL-TRUE from the
//      rendered page (crisp fraction bars, radicals, rules) with their own text as the a11y label.
//   3. PROSE + HEADINGS are real <p>/<h2> text, in correct TWO-COLUMN reading order: a gutter is
//      detected, full-width elements act as band breakers, and each band reads left column fully then
//      right — never line-by-line across the gutter.
//   4. Running headers, footers and page numbers (margin furniture) are dropped.
// Line-art crops invert in dark mode; photos never. Scanned (image-only) PDFs yield no text.

export type PdfFigure = { src: string; alt: string; w: number; h: number };
export type PdfEq = { src: string; alt: string };
export type PdfCell = { t: string; c: number }; // text + x-CENTER (pt) — columns cluster positionally
export type PdfTable = { cells: PdfCell[][]; src: string };
/** The document's structure, kept alongside the HTML so it can be re-assembled as LaTeX. */
export type TexBlock = { t: "h2" | "p"; text: string } | { t: "eq" | "tbl" | "fig"; id: number };
export type PdfArticle = {
  title: string; html: string; pages: number; chars: number; lang: string; dir: "ltr" | "rtl";
  figures: PdfFigure[]; eqs: PdfEq[]; tables: PdfTable[]; outline: TexBlock[];
};

type Item = { str: string; x: number; y: number; w: number; h: number };
type Line = { items: Item[]; x: number; y: number; size: number; text: string; right: number };
type Region = { kind: "figure" | "equation" | "table"; src: string; alt: string; w: number; h: number; invert: boolean };
type Block =
  | { tag: "h2" | "p"; text: string; y: number; col: number; band: number }
  | { tag: "region"; region: Region; y: number; col: number; band: number; capId: number; eqId?: number; tblId?: number };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MATHY = /[∑∏∫∮∇∂√±∓×÷≤≥≠≈≡∞∈∉⊂⊆∪∩→←↔⇒⇔∀∃∝⟨⟩∥·°µαβγδεζηθικλμνξπρστφχψωΓΔΘΛΞΠΣΦΨΩ▽]/;
const HEADING_RE = /^(\d+(\.\d+)*)\s+\p{Lu}\p{L}/u; // "3 Overview", "4.2 RAP Design …" — a real word must follow the number (a lone math capital, "24 𝑁", is a formula fragment)
const SECTION_RE = /^(abstract|references|bibliography|acknowledg?ements?|acknowledgments?|appendix(\s+[A-Z])?|conclusions?|introduction)$/i;

function sniffLang(text: string): { lang: string; dir: "ltr" | "rtl" } {
  const s = text.slice(0, 4000), c = (re: RegExp) => (s.match(re) || []).length;
  if (c(/[؀-ۿ]/g) > s.length * 0.15) return { lang: c(/[پچژگ]/g) > 0 ? "fa" : "ar", dir: "rtl" };
  if (c(/[一-鿿]/g) > s.length * 0.1) return { lang: "zh", dir: "ltr" };
  if (c(/[Ѐ-ӿ]/g) > s.length * 0.15) return { lang: "ru", dir: "ltr" };
  if (c(/[ऀ-ॿ]/g) > s.length * 0.15) return { lang: "hi", dir: "ltr" };
  return { lang: "en", dir: "ltr" };
}

/** Detect the two-column gutter from RAW ITEMS: the central x crossed by the fewest item spans is
 *  the gutter. Column gaps are only ~15pt, so partitioning ITEMS by the gutter (not splitting merged
 *  lines on a gap threshold) is what reliably separates columns. */
function detectGutter(items: Item[], pageW: number): { twoCol: boolean; gx: number } {
  // Straddle count at each candidate x. The best gx is the CENTER of the longest contiguous run of
  // minimal-straddle candidates — taking the first minimum lands on the gutter's left EDGE (where the
  // left column's lines end, within the split tolerance), and every row then fails to split.
  const cand: { gx: number; s: number }[] = [];
  for (let t = 0.40; t <= 0.60; t += 0.012) {
    const gx = pageW * t;
    let s = 0;
    for (const it of items) if (it.x < gx - 2 && it.x + it.w > gx + 2) s++;
    cand.push({ gx, s });
  }
  const bestStraddle = Math.min(...cand.map((c) => c.s));
  let bestGx = pageW / 2, runStart = -1, bestLen = 0;
  for (let i = 0; i <= cand.length; i++) {
    if (i < cand.length && cand[i].s === bestStraddle) { if (runStart < 0) runStart = i; }
    else if (runStart >= 0) {
      if (i - runStart > bestLen) { bestLen = i - runStart; bestGx = (cand[runStart].gx + cand[i - 1].gx) / 2; }
      runStart = -1;
    }
  }
  const L = items.filter((it) => it.x + it.w / 2 < bestGx).length, R = items.length - L;
  const twoCol = L >= 8 && R >= 8 && bestStraddle <= Math.max(3, items.length * 0.06);
  return { twoCol, gx: bestGx };
}

/** Group items (already one column) into rows by y and assemble each into a Line. No gutter logic. */
function mkLines(items: Item[]): Line[] {
  const rows: Item[][] = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const tol = Math.max(2, it.h * 0.45);
    const row = rows.find((r) => Math.abs(r[0].y - it.y) <= tol);
    if (row) row.push(it); else rows.push([it]);
  }
  return rows.map(mkLine).filter((l) => l.text);
}
function mkLine(items: Item[]): Line {
  items.sort((a, b) => a.x - b.x);
  const y = items.reduce((s, i) => s + i.y, 0) / items.length;
  let t = "";
  for (let i = 0; i < items.length; i++) { if (i > 0) { const p = items[i - 1]; if (items[i].x - (p.x + p.w) > Math.max(1.2, p.h * 0.18)) t += " "; } t += items[i].str; }
  return { items, x: items[0].x, y, size: Math.max(...items.map((i) => i.h)), right: Math.max(...items.map((i) => i.x + i.w)), text: t.replace(/\s+/g, " ").trim() };
}

const lettersRatio = (t: string) => (t.match(/[\p{L}\p{M}]/gu) || []).length / Math.max(1, t.length);

/** A stand-alone display equation line (symbol-heavy, or an equation-numbered math line). */
function isEquation(l: Line): boolean {
  if (l.text.length < 2) return false;
  const eqNum = /\(\s*\d+([.\-]\d+)?\s*\)\s*$/.test(l.text);
  const mathy = MATHY.test(l.text);
  const opEq = /[=<>]/.test(l.text) && lettersRatio(l.text) < 0.6;
  if (l.text.length > 140) return false;
  return (eqNum && (mathy || /[=]/.test(l.text))) || (mathy && lettersRatio(l.text) < 0.7) || (opEq && l.text.length < 90);
}

/** Cells-per-line where wide gaps split items into table columns. */
function cells(l: Line): number { let n = 1; for (let i = 1; i < l.items.length; i++) { const p = l.items[i - 1]; if (l.items[i].x - (p.x + p.w) > p.h * 1.5) n++; } return n; }
/** The same wide-gap rule, but returning cell TEXT + x-CENTER — the source for the tabular export
 *  (columns are clustered by centre, so a centred header aligns with its right-aligned numbers). */
function cellData(l: Line): PdfCell[] {
  const out: PdfCell[] = []; let cur = ""; let x0 = 0, x1 = 0;
  const flush = () => { const t = cur.trim(); if (t) out.push({ t, c: (x0 + x1) / 2 }); cur = ""; };
  for (let i = 0; i < l.items.length; i++) {
    const it = l.items[i];
    if (i > 0) { const p = l.items[i - 1]; const g = it.x - (p.x + p.w);
      // slightly softer than the table-DETECTION gap (1.5h): wide numeric cells leave less air between
      // columns, and a merged cell ruins the whole row's alignment
      if (g > p.h * 1.15) { flush(); } else if (g > Math.max(1.2, p.h * 0.18)) cur += " "; }
    if (!cur) x0 = it.x;
    x1 = it.x + it.w;
    cur += it.str;
  }
  flush();
  return out;
}

/** Make a crop's BACKGROUND TRANSPARENT so the figure sits ON the page instead of inside a coloured
 *  box (operator, 2026-07-25). The background is found by FLOOD FILL from the border — not by colour
 *  keying — so a plot area that happens to share the page colour is preserved, and only the region
 *  actually connected to the edge is cleared. Returns whether the surviving ink is predominantly dark,
 *  which decides the dark-mode invert: dark ink must flip to stay visible on a dark leaf, light ink
 *  (a figure authored on a dark background) must NOT flip.
 *  Also reports `uniform` — false when the border isn't one flat colour (a photo), where clearing
 *  anything would eat real content, so we leave it alone. */
function stripBackground(ctx: CanvasRenderingContext2D, w: number, h: number): { inkDark: boolean; cleared: boolean; chartLike: boolean } {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const at = (x: number, y: number) => (y * w + x) * 4;
  // dominant border colour + how uniform the border is
  const counts = new Map<number, number>();
  const key = (o: number) => ((d[o] >> 3) << 10) | ((d[o + 1] >> 3) << 5) | (d[o + 2] >> 3);
  let border = 0;
  for (let x = 0; x < w; x++) { for (const y of [0, h - 1]) { const k = key(at(x, y)); counts.set(k, (counts.get(k) || 0) + 1); border++; } }
  for (let y = 0; y < h; y++) { for (const x of [0, w - 1]) { const k = key(at(x, y)); counts.set(k, (counts.get(k) || 0) + 1); border++; } }
  let best = -1, bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { bestN = n; best = k; }
  if (best < 0 || bestN / Math.max(1, border) < 0.6) return { inkDark: true, cleared: false, chartLike: false }; // photo-ish edge: leave it
  const br = ((best >> 10) & 31) << 3, bg = ((best >> 5) & 31) << 3, bb = (best & 31) << 3;

  // Two tolerances. The connected flood can afford a loose one (connectivity bounds the damage, and
  // it has to swallow anti-aliased edges). The GLOBAL key must be tight: a pale fill — a 95%
  // confidence band, a highlighted table row — is real content, and at TOL 30 it was being erased.
  const TOL_FLOOD = 30, TOL_KEY = 10;
  const nearBy = (o: number, tol: number) => Math.abs(d[o] - br) <= tol && Math.abs(d[o + 1] - bg) <= tol && Math.abs(d[o + 2] - bb) <= tol;
  const near = (o: number) => nearBy(o, TOL_FLOOD);

  // A CHART/DIAGRAM is mostly background, and its plot area is FENCED IN by the axes — a connected
  // flood from the border would leave that inner panel opaque, i.e. still a box on the page. When the
  // background colour dominates the whole image, key it out GLOBALLY instead. A photograph never
  // trips this (its pixels are not overwhelmingly one flat colour), so photos keep the safe flood.
  let flat = 0, tot = 0;
  for (let o = 0; o < d.length; o += 4 * 5) { tot++; if (nearBy(o, TOL_KEY)) flat++; }
  const chartLike = tot > 0 && flat / tot > 0.45;
  const seen = new Uint8Array(w * h);
  const q = new Int32Array(w * h);
  let head = 0, tail = 0;
  const push = (x: number, y: number) => { const i = y * w + x; if (!seen[i] && near(i * 4)) { seen[i] = 1; q[tail++] = i; } };
  if (chartLike) {
    for (let i = 0; i < w * h; i++) if (nearBy(i * 4, TOL_KEY)) seen[i] = 1;
  } else {
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    while (head < tail) {
      const i = q[head++], x = i % w, y = (i / w) | 0;
      if (x > 0) push(x - 1, y);
      if (x < w - 1) push(x + 1, y);
      if (y > 0) push(x, y - 1);
      if (y < h - 1) push(x, y + 1);
    }
  }
  // Clear the background; then judge the ink by HOW MUCH OF IT IS DARK, not by its mean luminance.
  // A chart is mostly a pale confidence band with thin dark axes and labels: the mean reads "light"
  // and we skip the dark-mode flip, leaving the axis numbers dark-on-dark and unreadable. What
  // matters is whether a real share of the ink would vanish on a dark leaf.
  let inkDarkN = 0, inkN = 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (seen[i]) { d[o + 3] = 0; continue; }
    const lum = (d[o] * 299 + d[o + 1] * 587 + d[o + 2] * 114) / 1000;
    if (lum < 110) inkDarkN++;
    inkN++;
  }
  // Feather: a pixel touching cleared background gets partial alpha, so edges don't look cut out.
  ctx.putImageData(img, 0, 0);
  // Axis rules, ticks and labels are a THIN minority of a chart's surviving ink — a few per cent is
  // already a page full of unreadable numbers on a dark leaf, so the bar is deliberately low.
  return { inkDark: inkN > 0 ? inkDarkN / inkN >= 0.05 : true, cleared: true, chartLike };
}

/** SVG-wrapped pixel-true crop of a rendered-canvas region. `lineArt` inverts in dark mode. */
function cropRegion(
  canvas: HTMLCanvasElement, sxPt: number, syTopPt: number, wPt: number, hPt: number, scale: number,
  kind: Region["kind"], alt: string,
): Region {
  const pad = 4 * scale;
  const sx = Math.max(0, sxPt * scale - pad), sy = Math.max(0, syTopPt * scale - pad);
  const sw = Math.min(canvas.width - sx, wPt * scale + pad * 2), sh = Math.min(canvas.height - sy, hPt * scale + pad * 2);
  const outW = Math.min(sw, 1500), outH = Math.max(1, Math.round(sh * (Math.min(sw, 1500) / sw)));
  const crop = document.createElement("canvas");
  crop.width = outW; crop.height = outH;
  const cctx = crop.getContext("2d", { willReadFrequently: true })!;
  cctx.imageSmoothingQuality = "high";
  cctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, outW, outH);
  // Background OUT first, so the figure embeds into the leaf rather than sitting in a coloured box.
  const { inkDark, chartLike } = stripBackground(cctx, outW, outH);
  // Dark-mode inversion is now decided by the INK, not the whole image: dark ink on a now-transparent
  // background must flip to stay legible on a dark leaf; ink that is already light must not.
  // (A photo we could not clear keeps the old behaviour: never invert a photograph.)
  // Only line art / charts flip in dark mode (invert+hue-rotate keeps their hues); a photograph
  // never does, whether or not we managed to clear a uniform border behind it.
  const invert = chartLike ? inkDark : kind !== "figure";
  return { kind, src: crop.toDataURL("image/webp", 0.9), alt: alt.slice(0, 380), w: outW, h: outH, invert };
}

const LABEL = { figure: "Figure", equation: "Equation", table: "Table" } as const;
function blockHtml(b: Block): string {
  if (b.tag !== "region") return `<${b.tag}>${esc(b.text)}</${b.tag}>`;
  const r = b.region;
  const label = `${LABEL[r.kind]}${r.alt ? ": " + r.alt : " from the document"}`;
  const cap = b.capId >= 0 ? ` data-cap="${b.capId}"` : "";
  const ref = b.eqId !== undefined ? ` data-eq="${b.eqId}"` : b.tblId !== undefined ? ` data-tbl="${b.tblId}"` : "";
  return `<figure class="aq-pdf-crop" data-kind="${r.kind}"${ref}${r.invert ? ' data-invert="1"' : ""}><svg role="img" aria-label="${esc(label).slice(0, 420)}" viewBox="0 0 ${r.w} ${r.h}" preserveAspectRatio="xMidYMid meet"><image${cap} href="${r.src}" width="${r.w}" height="${r.h}"/></svg></figure>`;
}

export type PageHook = (fragmentHtml: string, page: number, totalPages: number) => void;

type PdfPageLike = {
  getViewport(o: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: unknown[] }>;
  render(o: unknown): { promise: Promise<void> };
};
type PageCfg = { SCALE: number; CELL: number; furniture: Set<string>; norm: (s: string) => string; bodySize: number };
type PageResult = { blocks: Block[]; figures: PdfFigure[]; eqs: PdfEq[]; tables: PdfTable[] };

/** Extract ONE page into sorted blocks + its page-local figures/eqs/tables (ids are page-local,
 *  so a lazy book leaf can render/OCR in isolation). Shared by the streaming article extractor
 *  and the on-demand book (openPdf). Renders one canvas and frees it before returning. */
async function extractPageBlocks(page: PdfPageLike, cfg: PageCfg): Promise<PageResult> {
  const { SCALE, CELL, furniture, norm, bodySize } = cfg;
  const figures: PdfFigure[] = [];
  const eqs: PdfEq[] = [];
  const tables: PdfTable[] = [];
    const v1 = page.getViewport({ scale: 1 });
    const pageH = v1.height, pageW = v1.width;
    const content = await page.getTextContent();
    const items: Item[] = (content.items as Array<{ str: string; transform: number[]; width: number; height: number }>)
      .filter((i) => i.str && i.str.trim())
      .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: Math.abs(i.transform[3]) || i.height || 10 }));
    // Partition items into columns by the detected gutter, THEN build lines per column — each line
    // carries its column (1=left, 2=right, 0=full-width straddler) so reading order is unambiguous.
    const { twoCol, gx } = detectGutter(items, pageW);
    type CLine = Line & { _col: 0 | 1 | 2; _band: number };
    let lines: CLine[];
    if (twoCol) {
      // Decide columns PER ROW: split a row into left+right only when the gutter x falls in an empty
      // gap in that row. A full-width row (title, or a table row whose cells span the gutter) has no
      // gap at gx → it stays ONE line (col 0), so full-width tables/figures are never cut in half.
      const rows: Item[][] = [];
      for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
        const tol = Math.max(2, it.h * 0.45);
        const row = rows.find((r) => Math.abs(r[0].y - it.y) <= tol);
        if (row) row.push(it); else rows.push([it]);
      }
      lines = [];
      for (const row of rows) {
        row.sort((a, b) => a.x - b.x);
        // Split at the gutter unless the row looks like a FULL-WIDTH TABLE ROW. A table row has wide
        // cell gaps on BOTH sides of the gutter; an equation line (naturally wide internal gaps) next
        // to a prose line in the other column has a gap-quiet side — split those, or the crop and the
        // reading order swallow the other column.
        let splitK = -1;
        for (let k = 1; k < row.length; k++) {
          if (row[k - 1].x + row[k - 1].w < gx - 1 && row[k].x > gx + 1) { splitK = k; break; }
        }
        let wl = 0, wr = 0;
        for (let k = 1; k < row.length; k++) {
          if (k === splitK) continue; // the gutter gap itself
          const g = row[k].x - (row[k - 1].x + row[k - 1].w);
          if (g > row[k - 1].h * 1.4) { if (splitK > 0 && k < splitK) wl++; else wr++; }
        }
        if (splitK > 0 && Math.min(wl, wr) <= 1) {
          lines.push({ ...mkLine(row.slice(0, splitK)), _col: 1 as const, _band: 0 });
          lines.push({ ...mkLine(row.slice(splitK)), _col: 2 as const, _band: 0 });
        } else {
          const l = mkLine(row);
          const col = (l.x < gx - 2 && l.right > gx + 2) ? 0 as const : (l.x + l.right) / 2 < gx ? 1 as const : 2 as const;
          lines.push({ ...l, _col: col, _band: 0 });
        }
      }
    } else {
      lines = mkLines(items).map((l) => ({ ...l, _col: 1 as const, _band: 0 }));
    }
    if (!lines.length && !items.length) return { blocks: [], figures, eqs, tables };

    // ── render + ink grid; mask EVERY glyph; cluster the remaining ink into FIGURE regions ──
    const vp = page.getViewport({ scale: SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await (page.render({ canvasContext: ctx, canvas, viewport: vp } as unknown as Parameters<typeof page.render>[0])).promise;
    const gw = Math.ceil(canvas.width / CELL), gh = Math.ceil(canvas.height / CELL);
    const grid = new Uint8Array(gw * gh);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
      let ink = 0; const x0 = cx * CELL, y0 = cy * CELL;
      for (let y = y0; y < Math.min(y0 + CELL, canvas.height) && !ink; y += 3) { const row = y * canvas.width; for (let x = x0; x < Math.min(x0 + CELL, canvas.width); x += 3) { const o = (row + x) * 4; if (255 - Math.min(img[o], img[o + 1], img[o + 2]) > 48) { ink = 1; break; } } }
      grid[cy * gw + cx] = ink;
    }
    // Mask every glyph (padded) → what remains is graphics ink only.
    const maskPt = (x0: number, x1: number, yTop: number, yBot: number) => {
      const a = Math.max(0, Math.floor((x0 * SCALE) / CELL)), b = Math.min(gw - 1, Math.ceil((x1 * SCALE) / CELL));
      const c = Math.max(0, Math.floor((yTop * SCALE) / CELL)), d = Math.min(gh - 1, Math.ceil((yBot * SCALE) / CELL));
      for (let cy = c; cy <= d; cy++) for (let cx = a; cx <= b; cx++) grid[cy * gw + cx] = 0;
    };
    for (const it of items) maskPt(it.x - 1, it.x + it.w + 1, pageH - it.y - it.h, pageH - it.y + it.h * 0.35);
    // ALSO mask EQUATION line regions (their fraction bars, radicals, matrix brackets are graphics ink
    // that would otherwise cluster into — and CHAIN together — figure regions).
    for (const l of lines) if (isEquation(l)) maskPt(l.x - 3, l.right + 3, pageH - l.y - l.size * 2, pageH - l.y + l.size * 1.2);
    // Connected components → boxes; merge nearby; keep only substantial graphics.
    const seen = new Uint8Array(gw * gh), qx = new Int32Array(gw * gh), qy = new Int32Array(gw * gh);
    let boxes: { x0: number; y0: number; x1: number; y1: number; cells: number }[] = [];
    for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
      const idx = cy * gw + cx; if (!grid[idx] || seen[idx]) continue;
      let head = 0, tail = 0; qx[0] = cx; qy[0] = cy; tail = 1; seen[idx] = 1;
      let x0 = cx, x1 = cx, y0 = cy, y1 = cy, cc = 0;
      while (head < tail) { const ax = qx[head], ay = qy[head]; head++; cc++; if (ax < x0) x0 = ax; if (ax > x1) x1 = ax; if (ay < y0) y0 = ay; if (ay > y1) y1 = ay;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = ax + dx, ny = ay + dy; if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue; const ni = ny * gw + nx; if (grid[ni] && !seen[ni]) { seen[ni] = 1; qx[tail] = nx; qy[tail] = ny; tail++; } } }
      boxes.push({ x0, y0, x1, y1, cells: cc });
    }
    // merge boxes within GAP cells (both axes)
    let mg = true; const GAP = 4;
    while (mg) { mg = false; for (let i = 0; i < boxes.length && !mg; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i], b = boxes[j]; if (a.x0 <= b.x1 + GAP && b.x0 <= a.x1 + GAP && a.y0 <= b.y1 + GAP && b.y0 <= a.y1 + GAP) { a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0); a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1); a.cells += b.cells; boxes.splice(j, 1); mg = true; break; } } }
    // figure regions in PDF points (y-up bottom-left); keep only real graphics
    type FigBox = { x: number; yTop: number; w: number; h: number; cells: number };
    const figBoxes: FigBox[] = boxes.map((b) => ({ x: (b.x0 * CELL) / SCALE, yTop: (b.y0 * CELL) / SCALE, w: ((b.x1 - b.x0 + 1) * CELL) / SCALE, h: ((b.y1 - b.y0 + 1) * CELL) / SCALE, cells: b.cells }))
      .filter((b) => b.cells >= 10 && b.w > 40 && b.h > 26 && b.w * b.h > 3000); // drop rules, ticks, stray strokes

    // Absorb text lines that sit INSIDE a figure (axis labels, legend) into that figure.
    const inFig = (l: CLine): FigBox | null => {
      const lyTop = pageH - l.y - l.size, lyBot = pageH - l.y + l.size * 0.3;
      for (const f of figBoxes) { const fx0 = f.x - 6, fx1 = f.x + f.w + 6, fy0 = f.yTop - 6, fy1 = f.yTop + f.h + 6;
        const cx = (l.x + l.right) / 2, cy = (lyTop + lyBot) / 2;
        if (cx >= fx0 && cx <= fx1 && cy >= fy0 && cy <= fy1) return f; }
      return null;
    };
    const absorbed = new Map<FigBox, CLine[]>();
    const free: CLine[] = [];
    // Running headers / footers / page numbers sit in the top/bottom margin and are furniture — drop
    // them (a bare page number, an "… et al." running head, or a "Title … N" / "N Author …" header).
    const isFurniture = (l: CLine): boolean => {
      const t = l.text.trim();
      if (furniture.has(norm(t))) return true;            // repeats across pages (running head/foot)
      if (l.y < pageH * 0.92 && l.y > pageH * 0.055) return false;
      return t.length < 6 || /^\d{1,3}$/.test(t) || /\bet al\.?\s*\d*$/.test(t)
        || /^\d{1,3}\s+\p{Lu}/u.test(t) || (t.length < 82 && /\d\s*$/.test(t) && !/[.:;,]$/.test(t));
    };
    for (const l of lines) {
      if (isFurniture(l)) continue;
      const f = inFig(l); if (f) { (absorbed.get(f) || absorbed.set(f, []).get(f)!).push(l); } else free.push(l);
    }

    // Bands: full-width straddler lines (_col 0) + full-width figures split the page into horizontal
    // bands; within each band, left column reads fully before right.
    const breakerYs: number[] = [];
    // multi-cell full-width lines are TABLE ROWS, not band breakers — breaking on each would isolate
    // every row into its own band and defeat the ≥3-consecutive-rows table detection
    for (const l of free) if (l._col === 0 && cells(l) < 3) breakerYs.push(l.y);
    for (const f of figBoxes) { if (twoCol && f.x < gx - 6 && f.x + f.w > gx + 6) breakerYs.push(pageH - f.yTop); }
    const bandOf = (y: number) => breakerYs.filter((by) => by > y + 0.5).length;
    for (const l of free) l._band = bandOf(l.y);

    // ── build page blocks ── (reading order: band, then column, then top→bottom)
    const pageBlocks: Block[] = [];
    type FL = CLine;
    const fl: FL[] = free;
    const colRank = (c: number) => (c === 0 ? 3 : c);
    fl.sort((a, b) => a._band - b._band || colRank(a._col) - colRank(b._col) || b.y - a.y);

    let buf: FL[] = [];
    const flushPara = () => {
      if (!buf.length) return;
      let cur = "", curY = 0, prev: FL | null = null;
      const col = buf[0]._col, band = buf[0]._band;
      const flush = () => { const t = cur.replace(/\s+/g, " ").trim(); if (t.length > 1) pageBlocks.push({ tag: "p", text: t, y: curY, col, band }); cur = ""; };
      for (const l of buf) {
        const heading = (HEADING_RE.test(l.text) && l.text.length < 80)
          || SECTION_RE.test(l.text.trim())
          || (l.size > bodySize * 1.16 && l.text.length < 80 && lettersRatio(l.text) > 0.6 && !MATHY.test(l.text) && /^[\p{Lu}\d]/u.test(l.text) && !/-$/.test(l.text));
        if (heading) { flush(); pageBlocks.push({ tag: "h2", text: l.text, y: l.y, col, band }); prev = null; continue; }
        const gap = prev ? prev.y - l.y : 0, pitch = Math.max(prev?.size || l.size, l.size) * 1.7;
        if (prev && (gap > pitch || gap < -2)) flush();
        if (!cur) curY = l.y;
        cur = cur ? (/[A-Za-zÀ-ž]-$/.test(cur) && /^[a-zà-ž]/.test(l.text) ? cur.slice(0, -1) + l.text : cur + " " + l.text) : l.text;
        prev = l;
      }
      flush();
    };
    let i = 0;
    while (i < fl.length) {
      const l = fl[i];
      // a new (band,column) run → close the current paragraph
      if (buf.length && (l._col !== buf[0]._col || l._band !== buf[0]._band)) flushPara(), buf = [];
      // TABLE: ≥3 consecutive multi-cell lines in the SAME run, close together
      if (cells(l) >= 3) {
        const run = [l]; let j = i + 1;
        while (j < fl.length && fl[j]._col === l._col && fl[j]._band === l._band && cells(fl[j]) >= 3 && fl[j - 1].y - fl[j].y < bodySize * 4) { run.push(fl[j]); j++; }
        if (run.length >= 3) {
          flushPara(); buf = [];
          const rx = Math.min(...run.map((r) => r.x)), rr = Math.max(...run.map((r) => r.right));
          const ryTop = pageH - run[0].y - run[0].size, ryBot = pageH - run[run.length - 1].y + run[run.length - 1].size * 0.3;
          const region = cropRegion(canvas, rx, ryTop, rr - rx, ryBot - ryTop, SCALE, "table", run.map((r) => r.text).join("; "));
          tables.push({ cells: run.map(cellData), src: region.src });
          pageBlocks.push({ tag: "region", region, y: run[0].y, col: l._col, band: l._band, capId: -1, tblId: tables.length - 1 });
          i = j; continue;
        }
      }
      // EQUATION: a symbol-heavy line → crop it. CONSECUTIVE equation lines (a matrix, a multi-line
      // derivation) merge into ONE union crop — cropping each line separately produced overlapping
      // near-duplicate images of the same region.
      if (isEquation(l)) {
        // A display equation SHATTERS into text rows: the main line plus small-font subscript/limit
        // fragment rows ("graph b i j", "i j i") above and below it. Absorb those into the run — they
        // are part of the equation's ink, and leaking them into prose mangles both.
        const frag = (x: FL): boolean => {
          if (x.text.length <= 3) return true;
          if (x.size >= bodySize * 0.85) return false;
          const tk = x.text.split(/\s+/);
          return tk.length >= 2 && tk.filter((t) => t.length <= 2).length >= tk.length * 0.6;
        };
        const run = [l]; let j = i + 1;
        while (j < fl.length && fl[j]._col === l._col && fl[j]._band === l._band && (isEquation(fl[j]) || frag(fl[j])) && fl[j - 1].y - fl[j].y < Math.max(fl[j - 1].size, fl[j].size) * 3.2) { run.push(fl[j]); j++; }
        // backward: rows JUST ABOVE the equation that are fragments OR x-CONTAINED in its span (a
        // piecewise case row inside the brace; prose spans the full column) belong to it, not to the
        // paragraph before
        while (buf.length) {
          const pv = buf[buf.length - 1];
          const rx0 = Math.min(...run.map((r) => r.x)), rr0 = Math.max(...run.map((r) => r.right));
          // containment only counts for rows clearly NARROWER than the run — justified prose spans
          // the full column exactly like a full-width equation line, and absorbing it EATS paragraphs
          const contained = pv.x >= rx0 - 8 && pv.right <= rr0 + 8 && (pv.right - pv.x) < (rr0 - rx0) * 0.7;
          if ((frag(pv) || contained) && pv.y > l.y && pv.y - run[0].y < Math.max(pv.size, l.size) * 1.9) run.unshift(buf.pop()!);
          else break;
        }
        flushPara(); buf = [];
        const backAbsorbed = run.indexOf(l); // rows pulled from buf sit BEFORE l in the run
        const first = run[0], last = run[run.length - 1];
        const rx = Math.min(...run.map((r) => r.x)), rr = Math.max(...run.map((r) => r.right));
        let eyTop = pageH - first.y - first.size * 1.9, eyBot = pageH - last.y + last.size * 1.1;
        // clamp padding against the NEIGHBOURING lines (same band+column) — otherwise the pad
        // swallows the prose line above/below and every crop duplicates its surroundings
        const prev = fl[i - 1 - backAbsorbed], next = fl[j]; // skip rows the run absorbed from buf
        if (prev && prev._col === l._col && prev._band === l._band) eyTop = Math.max(eyTop, pageH - prev.y + prev.size * 0.35);
        if (next && next._col === l._col && next._band === l._band) eyBot = Math.min(eyBot, pageH - next.y - next.size * 1.05);
        if (eyBot < eyTop + first.size) eyBot = eyTop + first.size * 1.6;
        const region = cropRegion(canvas, rx - 2, eyTop, (rr - rx) + 4, eyBot - eyTop, SCALE, "equation", run.map((r) => r.text).join(" "));
        eqs.push({ src: region.src, alt: region.alt });
        pageBlocks.push({ tag: "region", region, y: first.y, col: l._col, band: l._band, capId: -1, eqId: eqs.length - 1 });
        i = j; continue;
      }
      buf.push(l); i++;
    }
    flushPara();

    // figure regions → crops (with absorbed label text)
    for (const f of figBoxes) {
      const absorbedText = (absorbed.get(f) || []).sort((a, b) => b.y - a.y).map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
      const region = cropRegion(canvas, f.x, f.yTop, f.w, f.h, SCALE, "figure", absorbedText);
      const capId = figures.length;
      figures.push({ src: region.src, alt: "", w: region.w, h: region.h });
      const fcx0 = f.x, fcx1 = f.x + f.w, fcx = f.x + f.w / 2;
      const fcol = !twoCol ? 1 : (fcx0 < gx - 6 && fcx1 > gx + 6) ? 0 : fcx < gx ? 1 : 2;
      pageBlocks.push({ tag: "region", region, y: pageH - f.yTop, col: fcol, band: bandOf(pageH - f.yTop), capId });
    }
    canvas.width = canvas.height = 0;

    // reading order: (band asc, col asc [breaker 0 sorts last via +3], y desc)
    const key = (b: Block) => b.band * 1e9 + (b.col === 0 ? 3 : b.col) * 1e8 - b.y;
    pageBlocks.sort((a, b) => key(a) - key(b));
  return { blocks: pageBlocks, figures, eqs, tables };
}

type PdfDoc = { numPages: number; getPage(n: number): Promise<PdfPageLike>; getMetadata(): Promise<{ info?: { Title?: string } }> };

/** Load the PDF and run the shared text-only pre-pass (furniture repeats + document-wide body size +
 *  a language sample). No page is rendered here — rendering is per-page and deferred. */
async function prepare(file: File, onProgress?: (pct: number) => void): Promise<{ doc: PdfDoc; cfg: PageCfg; sampleText: string }> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = (await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise) as unknown as PdfDoc;
  const SCALE = 2, CELL = 12;
  const norm = (s: string) => s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().replace(/^#(\s+#)*\s+|\s+#(\s+#)*$/g, "").toLowerCase();
  const marginCount = new Map<string, number>();
  const allSizes: number[] = [];
  let sampleText = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const pg = await doc.getPage(p);
    const vh = pg.getViewport({ scale: 1 }).height;
    const its = ((await pg.getTextContent()).items as Array<{ str: string; transform: number[]; width: number; height: number }>)
      .filter((i) => i.str && i.str.trim()).map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: Math.abs(i.transform[3]) || i.height || 10 }));
    const ls = mkLines(its);
    if (!ls.length) continue;
    for (const l of ls) allSizes.push(l.size);
    if (sampleText.length < 4000) sampleText += ls.map((l) => l.text).join(" ") + " ";
    const top = ls.reduce((a, b) => (b.y > a.y ? b : a));
    const bot = ls.reduce((a, b) => (b.y < a.y ? b : a));
    for (const m of [top, bot]) if (m.text.length < 100 && (m.y > vh * 0.9 || m.y < vh * 0.085)) marginCount.set(norm(m.text), (marginCount.get(norm(m.text)) || 0) + 1);
    onProgress?.(Math.round((p / doc.numPages) * 100));
  }
  const furniture = new Set([...marginCount].filter(([, c]) => c >= 2).map(([k]) => k));
  allSizes.sort((a, b) => a - b);
  const bodySize = allSizes[Math.floor(allSizes.length / 2)] || 10;
  return { doc, cfg: { SCALE, CELL, furniture, norm, bodySize }, sampleText };
}

/** A lazily-paged PDF: `page(n)` extracts ONE page on demand (cached), so a book UI can process only
 *  the spread it is showing — never the whole document up front. Region ids are page-local; each leaf
 *  renders and OCRs in isolation. */
export type PdfBook = { numPages: number; title: string; lang: string; dir: "ltr" | "rtl"; page(n: number): Promise<PdfPage> };
export type PdfPage = { html: string; eqs: PdfEq[]; figures: PdfFigure[]; tables: PdfTable[] };

export async function openPdf(file: File, onProgress?: (pct: number) => void): Promise<PdfBook> {
  const { doc, cfg, sampleText } = await prepare(file, onProgress);
  const { lang, dir } = sniffLang(sampleText);
  const info = await doc.getMetadata().then((m) => m.info).catch(() => undefined);
  const metaTitle = (info?.Title || "").trim();
  const title = ((metaTitle.length > 8 && !/^untitled|^microsoft|\.(dvi|tex|doc)x?$/i.test(metaTitle) ? metaTitle : "")
    || file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim()).slice(0, 160);
  const cache = new Map<number, Promise<PdfPage>>();
  const page = (n: number): Promise<PdfPage> => {
    let c = cache.get(n);
    if (!c) {
      c = (async () => {
        const pg = await doc.getPage(n);
        const { blocks, figures, eqs, tables } = await extractPageBlocks(pg, cfg);
        return { html: blocks.map(blockHtml).join("\n"), figures, eqs, tables };
      })();
      cache.set(n, c);
    }
    return c;
  };
  return { numPages: doc.numPages, title, lang, dir, page };
}

/** Extract an uploaded PDF into a themed article. Never leaves the device.
 *  SCALABLE BY DESIGN (operator): the document is converted PAGE BY PAGE — each page renders to one
 *  canvas that is freed before the next begins, the page's HTML fragment streams out through
 *  `onPage` so the reader can show content immediately, and control yields to the event loop
 *  between pages so a 300-page book never freezes or overloads the browser. */
export async function extractPdfArticle(file: File, onProgress?: (pct: number) => void, onPage?: PageHook): Promise<PdfArticle> {
  const { doc, cfg } = await prepare(file);
  const all: Block[] = [];
  const figures: PdfFigure[] = [];
  const eqs: PdfEq[] = [];
  const tables: PdfTable[] = [];
  let carry: Block | null = null; // trailing paragraph held across a page boundary

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { blocks: pageBlocks, figures: pf, eqs: pe, tables: pt } = await extractPageBlocks(page as unknown as PdfPageLike, cfg);
    if (!pageBlocks.length && !pf.length) { onProgress?.(Math.round((p / doc.numPages) * 100)); continue; }
    // remap page-local region ids into the flat document-wide arrays (for the LaTeX export)
    const figOff = figures.length, eqOff = eqs.length, tblOff = tables.length;
    figures.push(...pf); eqs.push(...pe); tables.push(...pt);
    for (const b of pageBlocks) if (b.tag === "region") { if (b.capId >= 0) b.capId += figOff; if (b.eqId !== undefined) b.eqId += eqOff; if (b.tblId !== undefined) b.tblId += tblOff; }
    // stream this page's fragment (post-processed: leftover furniture dropped, cross-page paragraph
    // merged via the held-back trailing paragraph), then YIELD so the UI thread breathes.
    const pageOut: Block[] = [];
    for (const b of pageBlocks) {
      if (b.tag === "p" || b.tag === "h2") {
        const t = b.text.trim();
        if (t.length < 60 && (/^\d+$/.test(t) || /\bet al\.?\s*$/.test(t))) continue;
        const last = pageOut[pageOut.length - 1] ?? carry;
        if (b.tag === "p" && last && last.tag === "p" && /[a-zà-ž,;:؀-ۿ-]$/.test(last.text) && !/^[A-Z0-9(]/.test(t)) {
          last.text = (/-$/.test(last.text) ? last.text.slice(0, -1) : last.text + " ") + t; continue;
        }
      }
      pageOut.push(b);
    }
    const prevCarry = carry; carry = null;
    if (prevCarry) all.push(prevCarry); // the paragraph carried over the seam, now complete
    // hold back the trailing paragraph — the NEXT page may continue it mid-sentence
    const lastB = pageOut[pageOut.length - 1];
    if (p < doc.numPages && lastB && lastB.tag === "p" && /[a-zà-ž,;:-]$/.test(lastB.text)) { carry = lastB; pageOut.pop(); }
    all.push(...pageOut);
    onPage?.((prevCarry ? blockHtml(prevCarry) + "\n" : "") + pageOut.map(blockHtml).join("\n"), p, doc.numPages);
    onProgress?.(Math.round((p / doc.numPages) * 100));
    await new Promise((r) => setTimeout(r, 0)); // yield: keep the page responsive between pages
  }
  if (carry) all.push(carry);

  const blocks = all;

  const fullText = blocks.map((b) => (b.tag === "p" || b.tag === "h2" ? b.text : "")).join(" ");
  const { lang, dir } = sniffLang(fullText);
  // Title: the PDF's own metadata first (the visual title line is often dropped as a running-head
  // repeat), then the first heading, then the first paragraph, then the file name.
  const info = await doc.getMetadata().then((m) => m.info as { Title?: string }).catch(() => null);
  const metaTitle = (info?.Title || "").trim();
  const firstH2 = blocks.find((b) => b.tag === "h2") as { text: string } | undefined;
  const firstP = blocks.find((b) => b.tag === "p") as { text: string } | undefined;
  const title = ((metaTitle.length > 8 && !/^untitled|^microsoft|\.(dvi|tex|doc)x?$/i.test(metaTitle) ? metaTitle : "")
    || firstH2?.text || firstP?.text || file.name.replace(/\.pdf$/i, "")).slice(0, 160);
  const html = blocks.map(blockHtml).join("\n");
  const outline: TexBlock[] = blocks.map((b) => {
    if (b.tag !== "region") return { t: b.tag, text: b.text };
    if (b.eqId !== undefined) return { t: "eq" as const, id: b.eqId };
    if (b.tblId !== undefined) return { t: "tbl" as const, id: b.tblId };
    return { t: "fig" as const, id: b.capId };
  });
  return { title, html, pages: doc.numPages, chars: fullText.length, lang, dir, figures, eqs, tables, outline };
}
