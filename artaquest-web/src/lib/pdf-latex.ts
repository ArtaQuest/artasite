// Comprehensive PDF → LaTeX for ArtaRead — entirely ON DEVICE (operator, 2026-07-23).
//   · EQUATIONS: each equation crop is OCR'd to real LaTeX by texify2 (the SOTA open image→LaTeX
//     model, ~320 MB q8) running in the browser via transformers.js. The reader swaps the pixel
//     crop for KaTeX-typeset math; the export embeds the LaTeX source.
//   · TABLES: rebuilt as \begin{tabular} from the exact cell text + geometry the extractor already
//     has — deterministic beats re-OCRing pixels we own the text of. Ragged grids fall back to the
//     pixel crop as an included graphic.
//   · EXPORT: a compilable bundle — main.tex (title, sections, paragraphs, equations, tables,
//     figure includes) + figures/*.png — zipped in the browser. Nothing leaves the device.
import type { NeuralProgress } from "./tts";
import type { PdfArticle } from "./pdf-extract";
import { rangedPrefetch, modelMirrorBase } from "./hf-prefetch";
import { flatName } from "./model-host";
import { canRun } from "./device-budget";

const REPO = "Xenova/texify2";

type Ocr = (dataUri: string) => Promise<string>;
let ocrP: Promise<Ocr> | null = null;
let ocrPipe: { dispose?: () => Promise<void> } | null = null;

/** Free the texify2 ORT session + weights so the NEXT heavy model (Florence captioner, ~1.8 GB) has
 *  the memory to itself — the reader runs the two passes strictly serially, one resident at a time.
 *  Idempotent; the cached weights make a later re-init fast (no re-download). */
export async function disposeTexify(): Promise<void> {
  const pipe = ocrPipe;
  ocrPipe = null; ocrP = null;
  try { await pipe?.dispose?.(); } catch { /* already gone */ }
}

function loadTexify(onProgress?: (p: NeuralProgress) => void): Promise<Ocr> {
  if (!ocrP) {
    ocrP = (async () => {
      const label = "Downloading the equation reader — ~320 MB, once…";
      onProgress?.({ pct: 0, status: label });
      const T = await import("@huggingface/transformers");
      // Pre-stage the big weights ranged. `src` is where the BYTES come from — the Kaggle dataset
      // artafather/aq-models (operator 2026-08-02, the HuggingFace purge). `key` is the CACHE KEY,
      // and it MUST stay the huggingface.co URL: transformers.js looks its cache up by the URL it
      // builds internally from REPO, so keying by anything else means the library misses the cache
      // and re-downloads both weights. Nothing fetches this URL — lib/model-host.ts rewrites any
      // that escapes — so it is a name here, not an address. Do not "tidy" it to a Kaggle URL.
      const R = `https://huggingface.co/${REPO}/resolve/main/onnx/`;
      const M = modelMirrorBase() + "/" + flatName("texify2/onnx/");
      const F = ["encoder_model_quantized.onnx", "decoder_model_merged_quantized.onnx"];
      await rangedPrefetch(F.map((f) => ({ key: R + f, src: M + f })), onProgress, label);
      const load = () => T.pipeline("image-to-text", REPO, {
        dtype: "q8",
        device: "wasm", // seq2seq decoding on WebGPU is unreliable — same pin as the translator/captioner
        progress_callback: (q: unknown) => {
          const d = q as { status?: string; progress?: number; file?: string };
          if (d.status === "progress" && typeof d.progress === "number" && /onnx/.test(d.file || ""))
            onProgress?.({ pct: Math.round(d.progress), status: label });
        },
      });
      let pipe;
      try { pipe = await load(); }
      catch { onProgress?.({ pct: 0, status: "Download interrupted — retrying…" }); pipe = await load(); }
      ocrPipe = pipe as unknown as { dispose?: () => Promise<void> }; // keep a handle so we can free it before the captioner loads
      const p = pipe as unknown as (img: unknown, opts: Record<string, unknown>) => Promise<Array<{ generated_text: string }>>;
      return async (dataUri: string) => {
        // Decode the data URI ourselves — fetch()ing data: URIs is blocked by the prod CSP.
        const [head, b64] = dataUri.split(",");
        const mime = (head.match(/data:([^;]+)/) || [])[1] || "image/webp";
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const image = await T.RawImage.fromBlob(new Blob([bytes], { type: mime }));
        const out = await p(image, { max_new_tokens: 384 });
        return (out?.[0]?.generated_text || "").trim();
      };
    })().catch((e) => { ocrP = null; throw e; });
  }
  return ocrP;
}

/** Make an OCR'd math string SAFE to wrap in `\[ … \]` — both KaTeX and pdfLaTeX break on a stray
 *  mode-toggling `$` or an unbalanced brace (a truncated OCR often drops a closing `}`). Strip every
 *  `$` (never valid inside display math), then balance braces: append missing closes, but REJECT
 *  (→ null, keep the pixel crop) when there are excess closes — those are ambiguous to repair. */
function sanitizeMath(s: string): string | null {
  let t = s.replace(/\$/g, "").trim();
  if (!t) return null;
  // KaTeX allows at most ONE \tag per rendered expression ("Multiple \tag"). texify2 emits a tag per
  // numbered equation, and two of them joined into one block is a hard parse failure — keep the first.
  let seenTag = false;
  t = t.replace(/\\tag\{[^}]*\}/g, (m) => (seenTag ? "" : ((seenTag = true), m))).trim();
  if (!t) return null;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "\\") { i++; continue; } // an escaped char (\{ \}) is a literal, not a group delimiter
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth < 0) return null; }
  }
  return depth > 0 ? t + "}".repeat(depth) : t;
}

/** texify2 returns markdown-ish text with $$…$$ / $…$ spans. Reduce to ONE display-math body, or
 *  null when the output carries no actual math (a mis-classified prose line — keep the crop). */
export function extractMath(raw: string): string | null {
  if (!raw) return null;
  const t = raw.replace(/\s+/g, " ").trim();
  const blocks = [...t.matchAll(/\$\$(.+?)\$\$/gs)].map((m) => m[1].trim()).filter(Boolean);
  if (blocks.length) return sanitizeMath(blocks.join(" \\qquad "));
  const inline = [...t.matchAll(/(?<!\$)\$([^$]+)\$(?!\$)/g)].map((m) => m[1].trim()).filter(Boolean);
  const mathy = (s: string) => /\\[a-zA-Z]+|[_^{}]/.test(s);
  if (inline.length && inline.some(mathy)) return sanitizeMath(inline.join(" \\quad "));
  return mathy(t) ? sanitizeMath(t) : null;
}

/** OCR every equation crop, serially (heavy model); `apply(i, latex)` fires as each lands. */
export async function ocrEquations(
  eqs: { src: string }[],
  apply: (i: number, latex: string) => void,
  signal?: AbortSignal,
  onProgress?: (p: NeuralProgress) => void,
): Promise<void> {
  if (!eqs.length) return;
  const budget = canRun("texify");
  if (!budget.ok) { onProgress?.({ pct: 100, status: "" }); return; } // crops stay — reading is unaffected
  const ocr = await loadTexify(onProgress);
  onProgress?.({ pct: 100, status: "" });
  for (let i = 0; i < eqs.length; i++) {
    if (signal?.aborted) return;
    try {
      const latex = extractMath(await ocr(eqs[i].src));
      if (latex && !signal?.aborted) apply(i, latex);
    } catch (e) { console.debug("[pdf-latex] eq", i, "failed:", String(e).slice(0, 200)); }
  }
}

// ── LaTeX document assembly ──────────────────────────────────────────────────────────────────────

// NB: the backslash is NOT in this list — it is stashed to a sentinel BEFORE these run and restored
// LAST (see texEscape), so the `{}` these introduce (\ldots{}, \textasciitilde{}, …) are never
// re-escaped by the `{}` rule, and an input backslash never turns into `\textbackslash\{\}`.
const TEX_SPECIALS: Array<[RegExp, string]> = [
  [/([&%$#_{}])/g, "\\$1"], [/~/g, "\\textasciitilde{}"], [/\^/g, "\\textasciicircum{}"],
  [/’|‘/g, "'"], [/“/g, "``"], [/”/g, "''"], [/—/g, "---"], [/–/g, "--"], [/…/g, "\\ldots{}"], [/·/g, "\\textperiodcentered{}"],
];
// Common maths/typographic Unicode that pdfLaTeX's fonts can't type directly — mapped to commands.
const TEX_UNICODE: Record<string, string> = {
  "−": "-", "∼": "\\(\\sim\\)", "′": "\\(\\prime\\)", "″": "\\(\\prime\\prime\\)", "×": "\\(\\times\\)", "÷": "\\(\\div\\)",
  "±": "\\(\\pm\\)", "≤": "\\(\\le\\)", "≥": "\\(\\ge\\)", "≈": "\\(\\approx\\)", "≠": "\\(\\ne\\)", "≡": "\\(\\equiv\\)",
  "∞": "\\(\\infty\\)", "°": "\\(^\\circ\\)", "µ": "\\(\\mu\\)", "→": "\\(\\rightarrow\\)", "←": "\\(\\leftarrow\\)",
  "∇": "\\(\\nabla\\)", "∂": "\\(\\partial\\)", "√": "\\(\\surd\\)", "∈": "\\(\\in\\)", "∑": "\\(\\sum\\)", "∫": "\\(\\int\\)",
  "α": "\\(\\alpha\\)", "β": "\\(\\beta\\)", "γ": "\\(\\gamma\\)", "δ": "\\(\\delta\\)", "ε": "\\(\\varepsilon\\)", "ζ": "\\(\\zeta\\)",
  "η": "\\(\\eta\\)", "θ": "\\(\\theta\\)", "κ": "\\(\\kappa\\)", "λ": "\\(\\lambda\\)", "ν": "\\(\\nu\\)", "ξ": "\\(\\xi\\)",
  "π": "\\(\\pi\\)", "ρ": "\\(\\rho\\)", "σ": "\\(\\sigma\\)", "τ": "\\(\\tau\\)", "φ": "\\(\\varphi\\)", "χ": "\\(\\chi\\)",
  "ψ": "\\(\\psi\\)", "ω": "\\(\\omega\\)", "Γ": "\\(\\Gamma\\)", "Δ": "\\(\\Delta\\)", "Θ": "\\(\\Theta\\)", "Λ": "\\(\\Lambda\\)",
  "Π": "\\(\\Pi\\)", "▽": "\\(\\triangledown\\)", "Σ": "\\(\\Sigma\\)", "Φ": "\\(\\Phi\\)", "Ψ": "\\(\\Psi\\)", "Ω": "\\(\\Omega\\)", "ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff",
};
const BSLASH = String.fromCharCode(0xe000); // private-use sentinel; never occurs in extracted prose
export function texEscape(s: string): string {
  // Stash input backslashes to the sentinel BEFORE the other escapes, restore them LAST — otherwise
  // the `{}` rule re-escapes the braces `\\textbackslash{}` would introduce (→ `\\textbackslash\\{\\}`).
  let t = s.split("\\").join(BSLASH);
  for (const [re, sub] of TEX_SPECIALS) t = t.replace(re, sub);
  t = t.replace(/[\u2212\u223c\u2032\u2033\u00d7\u00f7\u00b1\u2264\u2265\u2248\u2260\u2261\u221e\u00b0\u00b5\u2192\u2190\u2207\u2202\u221a\u2208\u2211\u222b\u25bd\u03b1\u03b2\u03b3\u03b4\u03b5\u03b6\u03b7\u03b8\u03ba\u03bb\u03bd\u03be\u03c0\u03c1\u03c3\u03c4\u03c6\u03c7\u03c8\u03c9\u0393\u0394\u0398\u039b\u03a0\u03a3\u03a6\u03a8\u03a9\ufb01\ufb02\ufb00]/g, (ch) => TEX_UNICODE[ch] ?? ch);
  return t.split(BSLASH).join("\\textbackslash{}");
}

/** Rebuild a grid POSITIONALLY: cluster every cell's x-centre into columns (rows may have missing or
 *  merged cells — a header row and its data rows rarely agree on a plain count). */
function tabular(cells: { t: string; c: number }[][]): string | null {
  if (cells.length < 2) return null;
  const centres = cells.flat().map((c) => c.c).sort((a, b) => a - b);
  if (centres.length < 4) return null;
  const cols: number[] = [];
  let prev = centres[0], sum = centres[0], n = 1;
  for (let i = 1; i <= centres.length; i++) {
    if (i < centres.length && centres[i] - prev <= 14) { prev = centres[i]; sum += centres[i]; n++; }
    else { cols.push(sum / n); if (i < centres.length) { prev = centres[i]; sum = centres[i]; n = 1; } }
  }
  if (cols.length < 2 || cols.length > 14) return null;
  const rows = cells.map((r) => {
    const cellsOut: string[] = Array(cols.length).fill("");
    for (const c of r) {
      let k = 0;
      for (let i = 1; i < cols.length; i++) if (Math.abs(cols[i] - c.c) < Math.abs(cols[k] - c.c)) k = i;
      cellsOut[k] = cellsOut[k] ? cellsOut[k] + " " + texEscape(c.t) : texEscape(c.t);
    }
    return cellsOut.join(" & ") + " \\\\";
  });
  return [
    "\\begin{table}[ht]\\centering",
    `\\begin{tabular}{${"l".repeat(cols.length)}}`,
    "\\toprule", rows[0], "\\midrule", ...rows.slice(1), "\\bottomrule",
    "\\end{tabular}", "\\end{table}",
  ].join("\n");
}

/** Assemble the complete main.tex. `eqTex` holds texify2 results; `caps` figure captions;
 *  `have` (when given) = the figure files actually present in the bundle — nothing else is \includegraphics'd. */
export function articleToTex(art: PdfArticle, eqTex: Map<number, string>, caps: Map<number, string>, have?: Set<string>): string {
  const out: string[] = [
    "% Generated by ArtaRead (artaquest.com) — converted entirely on the reader's device",
    "\\documentclass[11pt]{article}",
    "\\usepackage[utf8]{inputenc}",
    "\\usepackage[T1]{fontenc}",
    "\\usepackage{amsmath,amssymb,graphicx,booktabs}",
    "\\usepackage[margin=1in]{geometry}",
    `\\title{${texEscape(art.title)}}`,
    "\\date{}",
    "\\begin{document}",
    "\\maketitle",
    "",
  ];
  let firstH2 = true;
  for (const b of art.outline) {
    if (b.t === "h2") {
      // the PDF's own numbering ("3 Overview") is stripped — \section renumbers
      const t = b.text.replace(/^\d+(\.\d+)*\s+/, "");
      const sub = /^\d+\.\d+/.test(b.text);
      // the first heading is usually the title itself — skip the duplicate
      if (firstH2 && art.title.startsWith(b.text.slice(0, 40))) { firstH2 = false; continue; }
      firstH2 = false;
      out.push(`\\${sub ? "subsection" : "section"}{${texEscape(t)}}`, "");
    } else if (b.t === "p") {
      out.push(texEscape(b.text), "");
    } else if (b.t === "eq") {
      const tex = eqTex.get(b.id);
      if (tex) out.push("\\begin{equation*}", tex, "\\end{equation*}", "");
      else if (!have || have.has(`eq${b.id}`)) out.push(`\\begin{center}\\includegraphics[width=0.8\\linewidth]{figures/eq${b.id}.png}\\end{center}`, "");
    } else if (b.t === "tbl") {
      const tab = tabular(art.tables[b.id]?.cells || []);
      if (tab) out.push(tab, "");
      else if (!have || have.has(`tbl${b.id}`)) out.push(`\\begin{center}\\includegraphics[width=\\linewidth]{figures/tbl${b.id}.png}\\end{center}`, "");
    } else if (b.t === "fig" && b.id >= 0 && (!have || have.has(`fig${b.id}`))) {
      const cap = caps.get(b.id) || art.figures[b.id]?.alt || "";
      out.push(
        "\\begin{figure}[ht]\\centering",
        `\\includegraphics[width=\\linewidth]{figures/fig${b.id}.png}`,
        ...(cap ? [`\\caption{${texEscape(cap.slice(0, 300))}}`] : []),
        "\\end{figure}", "",
      );
    }
  }
  out.push("\\end{document}", "");
  return out.join("\n");
}

// ── zip (STORE, no compression — PNGs are already compressed) ────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(files: Array<{ name: string; data: Uint8Array }>): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number) => [v & 255, (v >> 8) & 255];
  const u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(f.data.length), ...u32(f.data.length), ...u16(name.length), ...u16(0)]);
    parts.push(head, name, f.data);
    central.push(new Uint8Array([0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(f.data.length), ...u32(f.data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
    offset += head.length + name.length + f.data.length;
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const end = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  return new Blob([...parts, ...central, end] as BlobPart[], { type: "application/zip" });
}

/** data-URI (webp) → PNG bytes via canvas — pdflatex reads png, not webp. */
async function toPng(dataUri: string): Promise<Uint8Array> {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUri; });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); // flatten alpha for print
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
  if (!blob) throw new Error("png encode failed");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Build the downloadable bundle: main.tex + figures/*.png (figures, un-OCR'd equations, ragged tables). */
export async function buildLatexZip(art: PdfArticle, eqTex: Map<number, string>, caps: Map<number, string>): Promise<Blob> {
  // SNAPSHOT the live maps — OCR keeps landing while the zip builds, and main.tex and the file list
  // must agree on which equations are LaTeX vs included crops.
  const eqSnap = new Map(eqTex), capSnap = new Map(caps);
  const files: Array<{ name: string; data: Uint8Array }> = [];
  const have = new Set<string>();
  for (const b of art.outline) {
    try {
      if (b.t === "fig" && b.id >= 0 && art.figures[b.id]) { files.push({ name: `figures/fig${b.id}.png`, data: await toPng(art.figures[b.id].src) }); have.add(`fig${b.id}`); }
      else if (b.t === "eq" && !eqSnap.has(b.id) && art.eqs[b.id]) { files.push({ name: `figures/eq${b.id}.png`, data: await toPng(art.eqs[b.id].src) }); have.add(`eq${b.id}`); }
      else if (b.t === "tbl" && !tabular(art.tables[b.id]?.cells || []) && art.tables[b.id]) { files.push({ name: `figures/tbl${b.id}.png`, data: await toPng(art.tables[b.id].src) }); have.add(`tbl${b.id}`); }
    } catch { /* a failed image never blocks the bundle — its include line is simply omitted too */ }
  }
  files.unshift({ name: "main.tex", data: new TextEncoder().encode(articleToTex(art, eqSnap, capSnap, have)) });
  return zipStore(files);
}
