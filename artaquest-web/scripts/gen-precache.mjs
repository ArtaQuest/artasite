/**
 * Post-build: enumerate the ENTIRE built app (every JS chunk, CSS, font, the world-map data, …)
 * and write app/aq-precache.json — the manifest the Download Center uses to precache the whole app
 * into Cache Storage so ArtaQuest is fully self-sufficient offline (every route works with no network,
 * no external dependency). Run automatically after `vite build`.
 */
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

const APP_DIR = new URL("../../wp-content/themes/artaquest-theme/app/", import.meta.url).pathname;
const BASE = "/wp-content/themes/artaquest-theme/app/";
// Files we never precache: the SW + its own manifests, source maps, the Vite build manifest.
const SKIP = new Set(["sw.js", "manifest.webmanifest", "aq-precache.json"]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === ".vite") continue; // Vite's build manifest dir — not a runtime dependency
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = [];
let bytes = 0;
for (const full of walk(APP_DIR)) {
  const rel = relative(APP_DIR, full).split("\\").join("/");
  const top = rel.split("/")[0];
  if (SKIP.has(rel) || rel.endsWith(".map")) continue;
  if (top === "icons.svg" || top === "favicon.svg" || top === "signature.png" || top === "index.html" || top === "assets") {
    files.push(BASE + rel);
    bytes += statSync(full).size;
  }
}
files.sort();

const build = createHash("sha256").update(files.join("|")).digest("hex").slice(0, 12);
const manifest = { build, bytes, count: files.length, files };
writeFileSync(join(APP_DIR, "aq-precache.json"), JSON.stringify(manifest));
console.log(`aq-precache.json: ${files.length} files, ${(bytes / 1048576).toFixed(2)} MB, build ${build}`);
