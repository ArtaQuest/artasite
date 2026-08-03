/**
 * MOVE THE PLATFORM'S HEAVY DATA TO KAGGLE (operator 2026-08-02).
 *
 * Every on-device model the SPA loads used to be fetched from the HuggingFace hub — some from our
 * own `artaquest` account, some from third-party repos. HuggingFace is being purged entirely, and
 * the Kaggle user **artafather** now hosts all of it.
 *
 * Kaggle was verified to be a viable browser byte-source before any of this was written:
 *   · the download API answers with NO credential for a public dataset
 *   · it sends access-control-allow-origin for our origin, then 302s to storage.googleapis.com
 *     which sends `*` — and CSP checks EVERY hop, so both hosts must be allow-listed
 *   · a single file comes back RAW, not zipped (verified with a 1 MB binary: exact byte count,
 *     matching sha256)
 *   · HTTP 206 Range works on the storage hop, which is what the 8 MB slice fetcher needs
 *
 * This script only MOVES BYTES. It downloads exactly the files the SPA actually loads (never a whole
 * repo — the upstream repos carry every dtype variant and run to tens of gigabytes), verifies each
 * one's size, and writes a dataset folder ready for `kaggle datasets create`. Re-runs are cheap: a
 * file already on disk at the right size is skipped.
 *
 *   node tools/kaggle-models-migrate.mjs            # fetch everything into the staging dir
 *   node tools/kaggle-models-migrate.mjs --only=kokoro
 *   node tools/kaggle-models-migrate.mjs --plan     # print the plan and exit, download nothing
 *
 * It deliberately does NOT push to Kaggle itself: publishing under the operator's account is their
 * action, and the command is printed at the end so it stays an explicit step.
 */
import { mkdirSync, existsSync, statSync, writeFileSync, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const STAGE = process.env.AQ_STAGE || "/Users/arash/.artaquest-dev/kaggle-staging";
const HF = "https://huggingface.co";
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1] || "";
const PLAN_ONLY = process.argv.includes("--plan");

/**
 * One Kaggle dataset per model family. `files` are [sourceURL, pathInDataset] pairs — ONLY the
 * variants the SPA can actually request, which is why this is ~2.5 GB and not the ~50 GB the
 * upstream repos weigh.
 */
const DATASETS = [
  {
    key: "aq-models",
    slug: "aq-models",
    title: "ArtaQuest on-device model weights",
    license: "other",
    about:
      "Quantised ONNX weights the ArtaQuest reader runs ON THE DEVICE — no inference server, nothing sent anywhere. " +
      "florence2/* is onnx-community/Florence-2-base-ft (MIT) — figure captioning. " +
      "texify2/* is Xenova/texify2 — equation OCR. " +
      "Mirrored verbatim; the upstream repos are the origin and keep their own licences.",
    files: [
      ["onnx-community/Florence-2-base-ft", "onnx/vision_encoder_fp16.onnx", "florence2/onnx/vision_encoder_fp16.onnx"],
      ["onnx-community/Florence-2-base-ft", "onnx/embed_tokens_fp16.onnx", "florence2/onnx/embed_tokens_fp16.onnx"],
      ["onnx-community/Florence-2-base-ft", "onnx/encoder_model_quantized.onnx", "florence2/onnx/encoder_model_quantized.onnx"],
      ["onnx-community/Florence-2-base-ft", "onnx/decoder_model_merged_quantized.onnx", "florence2/onnx/decoder_model_merged_quantized.onnx"],
      ["Xenova/texify2", "onnx/encoder_model_quantized.onnx", "texify2/onnx/encoder_model_quantized.onnx"],
      ["Xenova/texify2", "onnx/decoder_model_merged_quantized.onnx", "texify2/onnx/decoder_model_merged_quantized.onnx"],
    ],
    // transformers.js resolves these BESIDE the weights; without them from_pretrained throws before
    // a single weight byte is read.
    configs: [
      ["onnx-community/Florence-2-base-ft", "config.json", "florence2/config.json"],
      ["onnx-community/Florence-2-base-ft", "generation_config.json", "florence2/generation_config.json"],
      ["onnx-community/Florence-2-base-ft", "preprocessor_config.json", "florence2/preprocessor_config.json"],
      ["onnx-community/Florence-2-base-ft", "tokenizer.json", "florence2/tokenizer.json"],
      ["onnx-community/Florence-2-base-ft", "tokenizer_config.json", "florence2/tokenizer_config.json"],
      ["onnx-community/Florence-2-base-ft", "vocab.json", "florence2/vocab.json"],
      ["onnx-community/Florence-2-base-ft", "merges.txt", "florence2/merges.txt"],
      ["Xenova/texify2", "config.json", "texify2/config.json"],
      ["Xenova/texify2", "generation_config.json", "texify2/generation_config.json"],
      ["Xenova/texify2", "preprocessor_config.json", "texify2/preprocessor_config.json"],
      ["Xenova/texify2", "tokenizer.json", "texify2/tokenizer.json"],
      ["Xenova/texify2", "tokenizer_config.json", "texify2/tokenizer_config.json"],
    ],
  },
  {
    key: "kokoro",
    slug: "aq-tts-kokoro",
    title: "ArtaQuest ArtaTTS — Kokoro-82M ONNX",
    license: "apache-2.0",
    about:
      "onnx-community/Kokoro-82M-v1.0-ONNX (Apache-2.0), mirrored for ArtaQuest's on-device read-aloud. " +
      "ALL FIVE dtype variants are here on purpose: the voice tier is chosen at runtime from the device's " +
      "own capability (fp32 on a desktop GPU down to q8f16 on a phone), so a missing variant is a silent " +
      "failure on exactly the devices that need it most.",
    files: [
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "onnx/model.onnx", "onnx/model.onnx"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "onnx/model_fp16.onnx", "onnx/model_fp16.onnx"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "onnx/model_quantized.onnx", "onnx/model_quantized.onnx"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "onnx/model_q8f16.onnx", "onnx/model_q8f16.onnx"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "onnx/model_q4f16.onnx", "onnx/model_q4f16.onnx"],
    ],
    // THE VOICE STYLE VECTORS. Without these Kokoro loads its weights and then produces no audio at
    // all: generate_from_ids awaits the style bin and throws. kokoro-js builds this URL inside its own
    // dist bundle (voices/<id>.bin off the same repo), which is precisely why lib/model-host.ts
    // rewrites at the fetch layer rather than by handing the library a base URL. One bin per voice
    // the picker offers — a missing one is a voice that is listed and silent.
    configs: [
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "config.json", "config.json"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "tokenizer.json", "tokenizer.json"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "tokenizer_config.json", "tokenizer_config.json"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/af_heart.bin", "voices/af_heart.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/af_bella.bin", "voices/af_bella.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/af_nicole.bin", "voices/af_nicole.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/af_aoede.bin", "voices/af_aoede.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/af_kore.bin", "voices/af_kore.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/af_sarah.bin", "voices/af_sarah.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/af_nova.bin", "voices/af_nova.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/af_alloy.bin", "voices/af_alloy.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/af_jessica.bin", "voices/af_jessica.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/af_river.bin", "voices/af_river.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/af_sky.bin", "voices/af_sky.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/am_michael.bin", "voices/am_michael.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/am_fenrir.bin", "voices/am_fenrir.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/am_puck.bin", "voices/am_puck.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/am_adam.bin", "voices/am_adam.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/am_echo.bin", "voices/am_echo.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/am_eric.bin", "voices/am_eric.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/am_liam.bin", "voices/am_liam.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/am_onyx.bin", "voices/am_onyx.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/am_santa.bin", "voices/am_santa.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/bf_emma.bin", "voices/bf_emma.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/bf_isabella.bin", "voices/bf_isabella.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/bf_alice.bin", "voices/bf_alice.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/bf_lily.bin", "voices/bf_lily.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/bm_george.bin", "voices/bm_george.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/bm_fable.bin", "voices/bm_fable.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/bm_lewis.bin", "voices/bm_lewis.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/bm_daniel.bin", "voices/bm_daniel.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/ef_dora.bin", "voices/ef_dora.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/em_alex.bin", "voices/em_alex.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/em_santa.bin", "voices/em_santa.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/ff_siwis.bin", "voices/ff_siwis.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/hf_alpha.bin", "voices/hf_alpha.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/hf_beta.bin", "voices/hf_beta.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/hm_omega.bin", "voices/hm_omega.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/hm_psi.bin", "voices/hm_psi.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/if_sara.bin", "voices/if_sara.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/im_nicola.bin", "voices/im_nicola.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/pf_dora.bin", "voices/pf_dora.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/pm_alex.bin", "voices/pm_alex.bin"],
      ["onnx-community/Kokoro-82M-v1.0-ONNX", "voices/pm_santa.bin", "voices/pm_santa.bin"],
    ],
  },
  {
    key: "nllb",
    slug: "aq-translate-nllb",
    title: "ArtaQuest on-device translation — NLLB-200",
    license: "CC BY-NC-SA 4.0",
    about:
      "Xenova/nllb-200-distilled-600M, q8 ONNX only — the encoder/decoder pair ArtaQuest's reader uses to " +
      "translate a page ON THE DEVICE before reading it aloud. " +
      "UPSTREAM LICENCE IS CC-BY-NC-4.0: redistribution is permitted with attribution, for NON-COMMERCIAL use. " +
      "ArtaQuest Foundation is a non-profit funded by donations. Attribution: Meta AI, No Language Left Behind.",
    files: [
      ["Xenova/nllb-200-distilled-600M", "onnx/encoder_model_quantized.onnx", "onnx/encoder_model_quantized.onnx"],
      ["Xenova/nllb-200-distilled-600M", "onnx/decoder_model_merged_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"],
    ],
    configs: [
      ["Xenova/nllb-200-distilled-600M", "config.json", "config.json"],
      ["Xenova/nllb-200-distilled-600M", "generation_config.json", "generation_config.json"],
      ["Xenova/nllb-200-distilled-600M", "tokenizer.json", "tokenizer.json"],
      ["Xenova/nllb-200-distilled-600M", "tokenizer_config.json", "tokenizer_config.json"],
      ["Xenova/nllb-200-distilled-600M", "special_tokens_map.json", "special_tokens_map.json"],
    ],
  },
  {
    key: "piper",
    slug: "aq-tts-piper",
    title: "ArtaQuest ArtaTTS — Piper Farsi voices",
    license: "MIT",
    about:
      "The Farsi (فارسی) voices from rhasspy/piper-voices (MIT), mirrored for ArtaQuest's on-device " +
      "read-aloud. Farsi is the one language on the platform with NO Kokoro equivalent, so these are " +
      "not a nicety — without them that language simply has no voice. Paths match the upstream repo.",
    files: [
      ["rhasspy/piper-voices", "fa/fa_IR/amir/medium/fa_IR-amir-medium.onnx", "fa/fa_IR/amir/medium/fa_IR-amir-medium.onnx"],
      ["rhasspy/piper-voices", "fa/fa_IR/gyro/medium/fa_IR-gyro-medium.onnx", "fa/fa_IR/gyro/medium/fa_IR-gyro-medium.onnx"],
    ],
    configs: [
      ["rhasspy/piper-voices", "fa/fa_IR/amir/medium/fa_IR-amir-medium.onnx.json", "fa/fa_IR/amir/medium/fa_IR-amir-medium.onnx.json"],
      ["rhasspy/piper-voices", "fa/fa_IR/gyro/medium/fa_IR-gyro-medium.onnx.json", "fa/fa_IR/gyro/medium/fa_IR-gyro-medium.onnx.json"],
    ],
  },
];

const human = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1024) + " KB");

/** Declared size from HF's blob listing, so a truncated download is caught rather than published. */
async function sizes(repo, type = "models") {
  const r = await fetch(`${HF}/api/${type}/${repo}?blobs=true`);
  if (!r.ok) throw new Error(`${repo}: listing ${r.status}`);
  const d = await r.json();
  const m = new Map();
  for (const f of d.siblings || []) m.set(f.rfilename, f.size || 0);
  return m;
}

/** Kaggle serves ONLY the dataset root — a nested path 404s on the download endpoint even though the
 *  upload expands folders and the browser shows a tree. So a logical path becomes one flat filename;
 *  lib/model-host.ts folds the same way, and the two must never disagree. */
const flat = (p) => p.replace(/^\/+/, "").split("/").join("__");

async function grab(repo, src, dest, want, type = "models") {
  if (existsSync(dest)) {
    const have = statSync(dest).size;
    if (!want || have === want) { console.log(`    = ${dest.split("/").slice(-2).join("/")} (${human(have)}, already staged)`); return have; }
    console.log(`    ! ${dest.split("/").slice(-2).join("/")} is ${human(have)}, expected ${human(want)} — refetching`);
  }
  mkdirSync(dest.split("/").slice(0, -1).join("/"), { recursive: true });
  const url = `${HF}/${type === "datasets" ? "datasets/" : ""}${repo}/resolve/main/${src}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${repo}/${src}: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const got = statSync(dest).size;
  if (want && got !== want) throw new Error(`${repo}/${src}: got ${got} bytes, expected ${want}`);
  console.log(`    + ${dest.split("/").slice(-2).join("/")} (${human(got)})`);
  return got;
}

let grand = 0;
for (const ds of DATASETS) {
  if (ONLY && ds.key !== ONLY) continue;
  const dir = `${STAGE}/${ds.slug}`;
  console.log(`\n▸ ${ds.slug} — ${ds.title}`);
  const all = [...ds.files, ...ds.configs];
  const repos = [...new Set(all.map(([r]) => r))];
  const sizeOf = new Map();
  for (const r of repos) {
    try { for (const [k, v] of await sizes(r, ds.repoType || "models")) sizeOf.set(r + "|" + k, v); }
    catch (e) { console.log(`    (no listing for ${r}: ${e.message}) — sizes unverified`); }
  }
  const planned = all.reduce((n, [r, s]) => n + (sizeOf.get(r + "|" + s) || 0), 0);
  console.log(`    ${all.length} files, ${human(planned)}`);
  grand += planned;
  if (PLAN_ONLY) continue;

  mkdirSync(dir, { recursive: true });
  for (const [repo, src, dest] of all) {
    await grab(repo, src, `${dir}/${flat(dest)}`, sizeOf.get(repo + "|" + src), ds.repoType || "models");
  }
  writeFileSync(`${dir}/dataset-metadata.json`, JSON.stringify({
    title: ds.title,
    id: `artafather/${ds.slug}`,
    licenses: [{ name: ds.license }],
  }, null, 1));
  writeFileSync(`${dir}/README.md`, `# ${ds.title}\n\n${ds.about}\n\nMirrored for https://artaquest.com — every file is byte-identical to its upstream source.\n`);
  console.log(`    → staged at ${dir}`);
}

console.log(`\nTOTAL ${human(grand)}`);
console.log(`\nPublish each with (public, so a browser can fetch it with no credential):`);
for (const ds of DATASETS) {
  if (ONLY && ds.key !== ONLY) continue;
  console.log(`  python3 -m kaggle datasets create -p ${STAGE}/${ds.slug} --public`);
}
