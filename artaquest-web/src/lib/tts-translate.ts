// On-device reading translator — NLLB-200 (distilled 600M), the state-of-the-art open multilingual
// MT model, running LOCALLY via transformers.js (ONNX, WebGPU when available, WASM otherwise).
// Nothing the member reads leaves the device. Used by the reader: when the chosen VOICE's language
// differs from the document's, each paragraph is translated first (shown in the translation panel)
// and then spoken by that language's Kokoro voice. One-time model download (~600 MB q8), cached by
// the browser like the voice model.
import type { NeuralProgress } from "./tts";
import { canRun } from "./device-budget";

const NLLB = "Xenova/nllb-200-distilled-600M";

// FLORES-200 codes for the languages the reader can speak or commonly reads. The translator itself
// covers 200 languages — extend this map as voices grow.
const CODES: Record<string, string> = {
  en: "eng_Latn", es: "spa_Latn", fr: "fra_Latn", hi: "hin_Deva", it: "ita_Latn",
  pt: "por_Latn", fa: "pes_Arab", de: "deu_Latn", ar: "arb_Arab", zh: "zho_Hans",
  ru: "rus_Cyrl", ja: "jpn_Jpan", tr: "tur_Latn", ko: "kor_Hang", nl: "nld_Latn",
};
export function nllbCode(lang: string): string | null {
  return CODES[(lang || "").toLowerCase().split("-")[0]] ?? null;
}

// NLLB is a SENTENCE-trained model: translate sentence by sentence (never mid-number — a naive split
// once cut "0.7°" into two "sentences" and garbled the output), packing short ones together.
const TR_MAX = 320;
function trChunks(text: string): string[] {
  // A sentence ends at .!?۔। followed by whitespace + an uppercase/RTL/other non-lowercase start —
  // decimals ("0.7"), "Fig. 2" and "e.g. x" never match because what follows isn't a capital start.
  const sents = text.trim().split(/(?<=[.!?۔।])\s+(?=[^a-z\d\s])/g).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const s of sents.length ? sents : [text.trim()]) {
    if (s.length > TR_MAX) { // one giant unpunctuated sentence — split at a word boundary
      if (cur) { out.push(cur); cur = ""; }
      let rest = s;
      while (rest.length > TR_MAX) {
        let cut = rest.slice(0, TR_MAX).lastIndexOf(" ");
        if (cut < 1) cut = TR_MAX - 1;
        out.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1).trim();
      }
      cur = rest;
      continue;
    }
    if (cur && cur.length + s.length + 1 > TR_MAX) { out.push(cur); cur = s; }
    else cur = cur ? cur + " " + s : s;
  }
  if (cur) out.push(cur);
  return out.filter(Boolean);
}

// Numbers, units and ranges pass through NLLB VERBATIM behind placeholders — the model reliably
// garbled them ("96–100%" → "96100٪", operator screenshot). Restored inside Unicode FSI…PDI
// isolates so "47 px" renders correctly inside RTL text.
const NUM_RE = /\(?\d[\d.,:%×–—°-]*(?:\s?(?:px|ms|s|Hz|kHz|MB|GB|CI|°|%))*\)?%?/g;
function maskNumbers(text: string): { masked: string; slots: string[] } {
  const slots: string[] = [];
  const masked = text.replace(NUM_RE, (m) => { slots.push(m); return ` X${slots.length}Z `; });
  return { masked: masked.replace(/\s+/g, " "), slots };
}
function unmaskNumbers(text: string, slots: string[]): string {
  return text.replace(/X\s?(\d+)\s?Z/gi, (_, n) => `⁨${slots[Number(n) - 1] ?? ""}⁩`).replace(/\s+/g, " ").trim();
}

type TranslatorPipe = (text: string, opts: { src_lang: string; tgt_lang: string }) => Promise<Array<{ translation_text: string }>>;
let pipeP: Promise<TranslatorPipe> | null = null;

// ALWAYS WASM: transformers.js seq2seq DECODING on the WebGPU backend is numerically broken for this
// model (fluent on CPU, token salad on WebGPU — verified both ways 2026-07-22). CPU decodes a
// paragraph in ~2-5 s and the reader's read-ahead hides it. Do not switch back without an A/B check.
function loadPipe(onProgress?: (p: NeuralProgress) => void): Promise<TranslatorPipe> {
  if (!pipeP) {
    pipeP = (async () => {
      const label = "Downloading the translator — ~900 MB, once…";
      onProgress?.({ pct: 0, status: label });
      const { pipeline } = await import("@huggingface/transformers");
      const load = () => pipeline("translation", NLLB, {
        dtype: "q8",
        device: "wasm",
        progress_callback: (q: unknown) => {
          const d = q as { status?: string; progress?: number; file?: string };
          if (d.status === "progress" && typeof d.progress === "number" && /onnx/.test(d.file || ""))
            onProgress?.({ pct: Math.round(d.progress), status: label });
        },
      });
      // The ~450 MB model parts can drop mid-fetch on flaky links (browsers only Cache-API a COMPLETE
      // response, so a retry restarts cleanly) — one automatic retry before surfacing the error.
      let p;
      try { p = await load(); }
      catch { onProgress?.({ pct: 0, status: "Download interrupted — retrying…" }); p = await load(); }
      return p as unknown as TranslatorPipe;
    })().catch((e) => { pipeP = null; throw e; });
  }
  return pipeP;
}

/** Translate one paragraph on-device. `src`/`tgt` are BCP-47-ish; unsupported pairs throw. */
export async function translateLocal(
  text: string, src: string, tgt: string,
  onProgress?: (p: NeuralProgress) => void,
): Promise<string> {
  const s = nllbCode(src), t = nllbCode(tgt);
  if (!s || !t) throw new Error(`translation pair not supported (${src} → ${tgt})`);
  const budget = canRun("nllb");
  if (!budget.ok) throw new Error("insufficient-memory: " + budget.why);
  const pipe = await loadPipe(onProgress);
  const parts: string[] = [];
  for (const chunk of trChunks(text)) {
    const { masked, slots } = maskNumbers(chunk);
    const r = await pipe(masked, { src_lang: s, tgt_lang: t });
    parts.push(unmaskNumbers((r?.[0]?.translation_text || "").trim(), slots));
  }
  return parts.filter(Boolean).join(" ");
}
