#!/usr/bin/env node
/**
 * Pull Arta's artifacts from the artalife repository into this one.
 *
 * Arta is authored in a separate repository — https://github.com/ArtaQuest/artalife
 * — because generation and integration are different pipelines. That one makes
 * the character; this one shows it. Nothing under artaquest-web/src/generated/arta
 * is edited here: a change made in the vendored copy is lost the next time
 * anyone syncs, and worse, it silently forks the mascot. Fix it upstream.
 *
 *   node tools/arta-sync.mjs              # sync from ../artalife, or a clone
 *   node tools/arta-sync.mjs --check      # fail if the copy has drifted (CI)
 *   node tools/arta-sync.mjs --scenes     # also copy dist/scenes/*.svg to public/
 *
 * Source resolution, in order: $ARTALIFE_DIR, a sibling ../artalife checkout,
 * else a shallow clone into a temp dir. The sibling is preferred so that a
 * local, uncommitted change upstream can be tried here before it is pushed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(ROOT, "artaquest-web/src/generated/arta");
const SCENES = path.join(ROOT, "artaquest-web/public/scenes");
const REMOTE = "https://github.com/ArtaQuest/artalife.git";

const check = process.argv.includes("--check");
const withScenes = process.argv.includes("--scenes");

/**
 * The artifacts this repo consumes. The vendored tree MIRRORS upstream's layout
 * — rig/ and render/ — rather than flattening it. Two reasons: no import path
 * needs rewriting on the way in, and `arta.ts` and `Arta.tsx` never share a
 * directory. Flattened, those two differ only in case, which resolves on Linux
 * and fails on macOS: a CI-green, laptop-broken build.
 */
const FILES = ["src/rig/arta.ts", "src/render/Arta.tsx"];

function resolveSource() {
  const env = process.env.ARTALIFE_DIR;
  if (env) {
    if (!existsSync(path.join(env, "src/rig/arta.ts"))) die(`ARTALIFE_DIR=${env} is not an artalife checkout`);
    return { dir: env, cloned: false };
  }
  const sibling = path.resolve(ROOT, "../artalife");
  if (existsSync(path.join(sibling, "src/rig/arta.ts"))) return { dir: sibling, cloned: false };
  const tmp = mkdtempSync(path.join(tmpdir(), "artalife-"));
  run("git", ["clone", "--depth", "1", "--quiet", REMOTE, tmp], ROOT, 120_000);
  return { dir: tmp, cloned: true };
}

function run(cmd, args, cwd, timeout = 30_000) {
  return execFileSync(cmd, args, { cwd, timeout, encoding: "utf8" }).trim();
}

function die(msg) {
  console.error(`arta-sync: ${msg}`);
  process.exit(1);
}

const src = resolveSource();
let sha = "unknown", dirty = false;
try {
  sha = run("git", ["rev-parse", "--short", "HEAD"], src.dir);
  dirty = run("git", ["status", "--porcelain"], src.dir).length > 0;
} catch {
  /* a source without git history still syncs; the banner just says so */
}

const banner = (rel) =>
  `/* GENERATED — DO NOT EDIT HERE.\n` +
  ` * Vendored from artalife ${rel} @ ${sha}${dirty ? " (dirty working tree)" : ""}.\n` +
  ` * Source of truth: ${REMOTE}\n` +
  ` * Re-run: node tools/arta-sync.mjs\n` +
  ` */\n`;

mkdirSync(DEST, { recursive: true });
let drift = 0;
for (const rel of FILES) {
  const from = path.join(src.dir, rel);
  if (!existsSync(from)) die(`missing upstream artifact: ${rel}`);
  const want = banner(rel) + readFileSync(from, "utf8");
  const to = path.join(DEST, rel.replace(/^src\//, ""));
  mkdirSync(path.dirname(to), { recursive: true });
  const have = existsSync(to) ? readFileSync(to, "utf8") : null;
  // the banner carries the sha, so compare the BODY — a re-sync of identical
  // code from a new upstream commit is not drift, it is just a newer stamp
  const body = (s) => (s === null ? null : s.replace(/^\/\* GENERATED[\s\S]*?\*\/\n/, ""));
  const same = body(have) === body(want);
  if (check) {
    if (!same) { console.error(`  DRIFT  ${rel}`); drift++; }
    else console.log(`  ok     ${rel}`);
    continue;
  }
  writeFileSync(to, want);
  console.log(`  ${same ? "unchanged" : "updated  "} ${rel}`);
}

if (withScenes) {
  const dist = path.join(src.dir, "dist/scenes");
  const svgs = existsSync(dist) ? readdirSync(dist).filter((n) => n.endsWith(".svg")) : [];
  if (!svgs.length) die("--scenes asked for films, upstream dist/scenes has none");
  mkdirSync(SCENES, { recursive: true });
  for (const n of svgs) {
    copyFileSync(path.join(dist, n), path.join(SCENES, n));
    console.log(`  scene    ${n}`);
  }
}

if (check && drift) {
  console.error(
    `\n${drift} vendored file(s) differ from artalife @ ${sha}.\n` +
    `Either the edit belongs upstream (make it there, push, re-sync), or this\n` +
    `checkout is stale: node tools/arta-sync.mjs`
  );
  process.exit(1);
}
console.log(`arta-sync: artalife @ ${sha}${dirty ? " (dirty)" : ""}${src.cloned ? " [clone]" : " [" + src.dir + "]"}`);
