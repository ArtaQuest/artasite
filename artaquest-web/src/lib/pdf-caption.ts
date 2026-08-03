// On-device figure captioning for ArtaRead — Florence-2 (base, ~230 MB once) via transformers.js.
// Runs AFTER the article opens, in the background: each extracted figure gets a descriptive caption
// written into its <img alt> (screen readers + the reader's TTS skip-nothing story). Nothing leaves
// the device. Chosen over vit-gpt2 after a live A/B (Florence: "two cats sleeping on the pink color
// cloth" vs vit-gpt2's "a cat laying on a couch with a cat laying on it").
import type { NeuralProgress } from "./tts";
import { rangedPrefetch, modelMirrorBase } from "./hf-prefetch";
import { flatName } from "./model-host";
import { canRun } from "./device-budget";

type Captioner = (dataUri: string) => Promise<string>;
let capP: Promise<Captioner> | null = null;

function loadCaptioner(onProgress?: (p: NeuralProgress) => void): Promise<Captioner> {
  if (!capP) {
    capP = (async () => {
      const label = "Downloading the image describer — ~230 MB, once…";
      onProgress?.({ pct: 0, status: label });
      const T = await import("@huggingface/transformers");
      console.debug("[pdf-caption] transformers loaded");
      // Pre-stage the big weights. `src` is where the BYTES come from — the Kaggle dataset
      // artafather/aq-models (operator 2026-08-02, the HuggingFace purge). `key` is the CACHE KEY,
      // and it MUST stay the huggingface.co URL: transformers.js looks its cache up by the URL it
      // builds internally from the repo id, so keying by anything else means the library misses the
      // cache and downloads all four weights a second time. Nothing ever fetches this URL — the
      // interceptor in lib/model-host.ts rewrites any that escapes to Kaggle — so it is a name here,
      // not an address. Do not "tidy" it to a Kaggle URL.
      const R = "https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/onnx/";
      const M = modelMirrorBase() + "/" + flatName("florence2/onnx/");
      const F = ["embed_tokens_fp16.onnx", "vision_encoder_fp16.onnx", "encoder_model_quantized.onnx", "decoder_model_merged_quantized.onnx"];
      await rangedPrefetch(F.map((f) => ({ key: R + f, src: M + f })), onProgress, label);
      const progress_callback = (q: unknown) => {
        const d = q as { status?: string; progress?: number; file?: string };
        if (d.status === "progress" && typeof d.progress === "number" && /onnx/.test(d.file || ""))
          onProgress?.({ pct: Math.round(d.progress), status: label });
      };
      const loadModel = () => T.Florence2ForConditionalGeneration.from_pretrained("onnx-community/Florence-2-base-ft", {
        dtype: { embed_tokens: "fp16", vision_encoder: "fp16", encoder_model: "q8", decoder_model_merged: "q8" },
        device: "wasm", // decode parity with the translator: seq2seq decoding on WebGPU is unreliable
        progress_callback,
      });
      // HF's big-file fetches can die mid-stream (ERR_HTTP2_PROTOCOL_ERROR — same as the translator);
      // completed files are already Cache-API'd, so retries only refetch what actually broke.
      let model;
      try { model = await loadModel(); }
      catch { onProgress?.({ pct: 0, status: "Download interrupted — retrying…" });
        try { model = await loadModel(); }
        catch { await new Promise((r) => setTimeout(r, 2500)); model = await loadModel(); } }
      console.debug("[pdf-caption] model ready");
      const processor = await T.AutoProcessor.from_pretrained("onnx-community/Florence-2-base-ft", {}) as unknown as {
        (image: unknown, prompts: unknown): Promise<Record<string, unknown>>;
        construct_prompts: (t: string) => unknown;
        batch_decode: (g: unknown, o: unknown) => string[];
        post_process_generation: (t: string, task: string, size: unknown) => Record<string, string>;
      };
      console.debug("[pdf-caption] processor ready");
      const task = "<DETAILED_CAPTION>";
      return async (dataUri: string) => {
        // Decode the data URI OURSELVES: RawImage.fromURL fetch()es it, and fetching data: URIs is
        // blocked by the prod CSP's connect-src (display via <img> uses img-src and is fine).
        const [head, b64] = dataUri.split(",");
        const mime = (head.match(/data:([^;]+)/) || [])[1] || "image/webp";
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const image = await T.RawImage.fromBlob(new Blob([bytes], { type: mime }));
        const inputs = await processor(image, processor.construct_prompts(task));
        console.debug("[pdf-caption] generating…");
        const gen = await (model.generate as (o: Record<string, unknown>) => Promise<unknown>)({ ...inputs, max_new_tokens: 96, num_beams: 1 });
        console.debug("[pdf-caption] generated");
        const text = processor.batch_decode(gen, { skip_special_tokens: false })[0];
        const out = processor.post_process_generation(text, task, image.size);
        return String(out[task] || "").replace(/^In this image\s*,?\s*/i, "").trim();
      };
    })().catch((e) => { capP = null; throw e; });
  }
  return capP;
}

/** Caption `figures` one by one, calling `apply(i, caption)` as each lands. Serial (heavy model),
 *  abortable, and every failure is per-figure (one bad image never stops the rest). */
export async function captionFigures(
  figures: { src: string }[],
  apply: (i: number, caption: string) => void,
  signal?: AbortSignal,
  onProgress?: (p: NeuralProgress) => void,
): Promise<void> {
  if (!figures.length) return;
  // Never load the ~1.8 GB describer on a device that can't hold it (operator: don't crash the system).
  const budget = canRun("florence");
  if (!budget.ok) { onProgress?.({ pct: 100, status: "" }); return; } // generic alts stay; reading is unaffected
  const cap = await loadCaptioner(onProgress);
  onProgress?.({ pct: 100, status: "" });
  for (let i = 0; i < figures.length; i++) {
    if (signal?.aborted) return;
    try {
      const c = await cap(figures[i].src);
      if (c && !signal?.aborted) apply(i, c);
    } catch (e) { console.debug("[pdf-caption] figure", i, "failed:", String(e).slice(0, 200)); }
  }
}
