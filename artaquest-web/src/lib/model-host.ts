/**
 * WHERE THE ON-DEVICE MODELS COME FROM (operator 2026-08-02 — the HuggingFace purge).
 *
 * Every model this app runs in the browser — Kokoro voices, the NLLB reading translator, Florence-2
 * figure captioning, texify2 equation OCR — is now downloaded from a PUBLIC KAGGLE DATASET owned by
 * `artafather`. HuggingFace is gone: no account, no token, no host in the CSP.
 *
 * WHY AN INTERCEPTOR AND NOT JUST CONSTANTS. We do not build most of these URLs. `kokoro-js`
 * hard-codes the voice style-vector URL inside its own dist bundle, and `@huggingface/transformers`
 * assembles `{host}/{repo}/resolve/{revision}/{file}` internally from a repo id. Repointing only the
 * strings WE own would leave both libraries fetching huggingface.co — which, once the CSP stops
 * listing it, fails as a blocked request rather than a missing file, i.e. the reader silently loses
 * its voice. Patching node_modules would fix it until the next install; forking two libraries to
 * change a hostname is worse. So the rewrite happens at the one place every path passes through.
 *
 * WHAT IT DOES. Exactly one thing: a request for a HuggingFace resolve URL is rewritten to the
 * Kaggle dataset file that holds the same bytes. Everything else is passed through untouched. It is
 * installed once, before any model code runs, and it is idempotent.
 *
 * KAGGLE'S SHAPE, verified live before this was written:
 *   https://www.kaggle.com/api/v1/datasets/download/<owner>/<slug>/<path/inside/the/dataset>
 *   · answers with NO credential for a public dataset
 *   · sends access-control-allow-origin for our origin, then 302s to storage.googleapis.com
 *     which sends `*` — CSP must list BOTH hosts, because it checks every hop
 *   · returns the file RAW, not zipped (checked with a 1 MB binary: exact byte count, matching
 *     sha256) — which is what makes it a drop-in for a weights URL at all
 *   · supports Range: a slice comes back 206 with a correct content-range, so the 8 MB-slice
 *     fetcher in hf-prefetch.ts keeps working unchanged
 */

/** The Kaggle account that hosts the platform's heavy data. */
export const KAGGLE_OWNER = "artafather";

const DL = "https://www.kaggle.com/api/v1/datasets/download";

/**
 * KAGGLE SERVES ONLY THE DATASET ROOT. Its per-file download endpoint 404s on any path with a
 * directory in it — `…/aq-tts-kokoro/config.json` is 200 while `…/aq-tts-kokoro/voices/af_bella.bin`
 * is 404, verified against a real published dataset. (The upload happily accepts and even EXPANDS a
 * folder, so the dataset browser shows a perfectly good tree that you then cannot address a file in:
 * the listing and the download endpoint disagree, and only the listing is reassuring.)
 *
 * So every file is stored FLAT, with its directory path folded into the name by this separator, and
 * both sides of the move use this one function to agree on the result.
 */
const SEP = "__";

/** The flat Kaggle filename for a path inside a model repo: `onnx/model.onnx` → `onnx__model.onnx`. */
export function flatName(path: string): string {
  return path.replace(/^\/+/, "").split("/").join(SEP);
}

/** A file inside one of our datasets. `path` is the LOGICAL path; it is flattened on the way out. */
export function kaggleFile(slug: string, path: string): string {
  return `${DL}/${KAGGLE_OWNER}/${slug}/${flatName(path)}`;
}

/**
 * HuggingFace repo id → the Kaggle dataset holding the same files, and an optional prefix within it.
 * Only repos this app actually loads appear here; anything else is left alone so an unexpected fetch
 * fails loudly at the network layer instead of being silently redirected somewhere wrong.
 */
const REPOS: Record<string, { slug: string; prefix?: string }> = {
  "onnx-community/Kokoro-82M-v1.0-ONNX": { slug: "aq-tts-kokoro" },
  "Xenova/nllb-200-distilled-600M": { slug: "aq-translate-nllb" },
  "onnx-community/Florence-2-base-ft": { slug: "aq-models", prefix: "florence2" },
  "Xenova/texify2": { slug: "aq-models", prefix: "texify2" },
  // Kokoro's voice style vectors live in the base Kokoro-82M repo, not the ONNX one — kokoro-js
  // builds that URL itself, which is the entire reason this table exists.
  "hexgrad/Kokoro-82M": { slug: "aq-tts-kokoro" },
  "rhasspy/piper-voices": { slug: "aq-tts-piper" },
};

/** `.../resolve/main/onnx/model.onnx` and `.../resolve/main/voices/af_bella.bin` both land here. */
const RESOLVE = /^https?:\/\/(?:huggingface\.co|hf\.co)\/(?:datasets\/)?([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/;

/** The Kaggle URL for a HuggingFace resolve URL, or null when we do not host that repo. */
export function toKaggle(url: string): string | null {
  const m = RESOLVE.exec(url);
  if (!m) return null;
  const hit = REPOS[m[1]];
  if (!hit) return null;
  const path = m[2].split("?")[0];
  return kaggleFile(hit.slug, hit.prefix ? `${hit.prefix}/${path}` : path);
}

let installed = false;

/**
 * Rewrite HuggingFace model fetches to Kaggle, once, for the lifetime of the page.
 *
 * Called from main.tsx before anything can import a model loader. Wrapping fetch is a big hammer, so
 * it is kept deliberately small: a single regex, a lookup, and a pass-through for everything that
 * does not match — no logging of URLs (they would be noise), no retry logic (the slice fetcher owns
 * that), no caching (the Cache API layer above owns that).
 */
export function installModelHost(): void {
  if (installed || typeof globalThis.fetch !== "function") return;
  installed = true;
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url && url.includes("huggingface.co/")) {
        const to = toKaggle(url);
        // A Request carries headers/method/signal we must not drop — rebuild it around the new URL
        // rather than passing the string, or a ranged model slice loses its Range header.
        if (to) return real(input instanceof Request ? new Request(to, input) : to, init);
      }
    } catch {
      /* never let the rewrite itself break a request — fall through to the real fetch */
    }
    return real(input as RequestInfo, init);
  };
}
