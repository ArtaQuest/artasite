// Stage the FULL espeak-ng WASM build (all ~100 languages, incl. Farsi) into public/ so the built
// app serves it at the app root. Fetched LAZILY only when a non-English voice is first used (the
// precache deliberately excludes root-level files), then cache-first via the service worker.
// Copied from node_modules at build time — the 24 MB data file is never committed (gitignored).
import { copyFileSync, statSync } from "node:fs";

const pkg = new URL("../node_modules/@echogarden/espeak-ng-emscripten/", import.meta.url);
const pub = new URL("../public/", import.meta.url);
for (const f of ["espeak-ng.js", "espeak-ng.data"]) {
  copyFileSync(new URL(f, pkg), new URL(f, pub));
  console.log(`[copy-espeak] ${f} → public/ (${Math.round(statSync(new URL(f, pub)).size / 1048576)} MB)`);
}
