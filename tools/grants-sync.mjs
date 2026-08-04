#!/usr/bin/env node
/**
 * Pull the funder catalogue from the artagrants repository into this one.
 *
 * The catalogue is RESEARCHED elsewhere — https://github.com/ArtaQuest/artagrants — because
 * maintaining it and serving it are different jobs on different clocks: that repository re-verifies
 * deadlines on a cycle, this one just ships whatever it last agreed to serve. `store.json` there is
 * the source of record; `wp-content/plugins/aquest/data/outreach-grants.json` here is a COPY.
 *
 * Do not hand-edit the copy. `Extra::import_grants()` is filemtime-gated, so an edit here would go
 * live, look authoritative, and be silently overwritten by the next sync — with no trace of what it
 * said or who changed it. Fix it upstream: correct `store.json`, run `grants.py export`, sync.
 *
 *   node tools/grants-sync.mjs           # sync from artagrants
 *   node tools/grants-sync.mjs --check   # fail if the copy has drifted from upstream (CI)
 *
 * Source resolution, in order: $ARTAGRANTS_DIR, a sibling ../artagrants checkout,
 * ~/.artaquest-dev/grants (the operator's long-running copy, which IS a checkout of it), else a
 * shallow clone into a temp dir. A local checkout is preferred so an upstream correction can be
 * tried here before it is pushed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(ROOT, "wp-content/plugins/aquest/data/outreach-grants.json");
const REMOTE = "https://github.com/ArtaQuest/artagrants.git";
const REL = "catalogue/outreach-grants.json";

const check = process.argv.includes("--check");

const git = (dir, ...args) => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 30_000 }).trim();
  } catch {
    return "";
  }
};

/** A directory counts as the source only if it actually holds an exported catalogue. */
const usable = (dir) => dir && existsSync(path.join(dir, REL));

function resolveSource() {
  for (const [dir, how] of [
    [process.env.ARTAGRANTS_DIR, "$ARTAGRANTS_DIR"],
    [path.resolve(ROOT, "../artagrants"), "sibling checkout"],
    [path.join(homedir(), ".artaquest-dev/grants"), "~/.artaquest-dev/grants"],
  ]) {
    if (usable(dir)) return { dir, how };
  }
  const dir = mkdtempSync(path.join(tmpdir(), "artagrants-"));
  // Bounded: a hung clone is a bug, not a wait. --depth 1 because only the tip matters here.
  execFileSync("git", ["clone", "--depth", "1", "--quiet", REMOTE, dir], { timeout: 180_000 });
  if (!usable(dir)) throw new Error(`cloned ${REMOTE} but it has no ${REL}`);
  return { dir, how: "shallow clone" };
}

/**
 * The copy is written WRAPPED — { _source, grants: [...] } — not as a bare array, so the file the
 * site serves says where it came from. `Extra::import_grants()` reads `$rows['grants'] ?? $rows`
 * and has always accepted both shapes; this uses the one that carries provenance.
 *
 * No timestamp. A synced-at field would change on every run and make --check fail against itself,
 * turning a drift alarm into noise everybody learns to ignore.
 */
const unwrap = (text) => {
  const v = JSON.parse(text);
  return Array.isArray(v) ? v : v.grants;
};

const { dir: SRC, how } = resolveSource();
const srcText = readFileSync(path.join(SRC, REL), "utf8");
const grants = unwrap(srcText);
if (!Array.isArray(grants) || grants.length === 0) throw new Error(`${REL} holds no grants`);

const commit = git(SRC, "rev-parse", "HEAD") || "(unknown)";
const dirty = git(SRC, "status", "--porcelain", "--", REL) !== "";

const wrapped = {
  _source: {
    repo: "https://github.com/ArtaQuest/artagrants",
    commit,
    file: REL,
    note: "Researched and maintained upstream. Do not edit this copy — run tools/grants-sync.mjs.",
    ...(dirty ? { uncommitted: true } : {}),
  },
  grants,
};
const out = JSON.stringify(wrapped, null, 1) + "\n";

if (check) {
  // Compare the DATA, not the wrapper. An unrelated upstream commit (a README fix) must not fail
  // this repository's CI — only a catalogue that actually differs should.
  const have = existsSync(DEST) ? unwrap(readFileSync(DEST, "utf8")) : null;
  const same = have && JSON.stringify(have) === JSON.stringify(grants);
  if (!same) {
    console.error(`grants-sync: DRIFTED from artagrants (${how}, ${commit.slice(0, 12)})`);
    console.error(`  upstream ${grants.length} rows, local ${have ? have.length : "missing"}`);
    console.error("  run: node tools/grants-sync.mjs");
    process.exit(1);
  }
  console.log(`grants-sync: in step with artagrants (${grants.length} rows, ${commit.slice(0, 12)})`);
} else {
  writeFileSync(DEST, out);
  const kinds = grants.reduce((a, g) => ((a[g.category || "other"] = (a[g.category || "other"] || 0) + 1), a), {});
  console.log(`grants-sync: ${grants.length} rows from ${how} @ ${commit.slice(0, 12)}${dirty ? " (UNCOMMITTED upstream)" : ""}`);
  console.log(`  industry-sponsor ${kinds["industry-sponsor"] || 0} · nonprofit-tech-credit ${kinds["nonprofit-tech-credit"] || 0} · other ${grants.length - (kinds["industry-sponsor"] || 0) - (kinds["nonprofit-tech-credit"] || 0)}`);
  console.log(`  → ${path.relative(ROOT, DEST)}`);
}
