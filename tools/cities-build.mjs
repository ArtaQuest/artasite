#!/usr/bin/env node
// Rebuilds wp-content/plugins/aquest/data/cities.tsv from GeoNames.
//
// SOURCE: cities15000 — every city over 15,000 people (34,078 of them). Licensed CC BY 4.0, which
// obliges us to attribute: AQ\Cities carries the notice and the picker credits GeoNames in the UI.
// Coordinates are kept to 4dp (~11 m), which is far past what a birth chart needs and halves the file.
//
//   node tools/cities-build.mjs          # rebuild in place
//
// The output is COMMITTED, like the grant catalogue: CI has no network and production must not
// depend on GeoNames being up at deploy time.
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const OUT = new URL("../wp-content/plugins/aquest/data/cities.tsv", import.meta.url).pathname;
const fold = (s) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, "");

const dir = await mkdtemp(join(tmpdir(), "aq-cities-"));
try {
  const zip = join(dir, "cities15000.zip");
  const res = await fetch("https://download.geonames.org/export/dump/cities15000.zip");
  if (!res.ok) throw new Error(`geonames: HTTP ${res.status}`);
  await new Promise(async (ok, bad) => {
    const f = createWriteStream(zip); f.on("finish", ok); f.on("error", bad);
    f.end(Buffer.from(await res.arrayBuffer()));
  });
  execFileSync("unzip", ["-qo", zip, "-d", dir]);
  const txt = await readFile(join(dir, "cities15000.txt"), "utf8");

  const rows = [];
  for (const line of txt.split("\n")) {
    const p = line.split("\t");
    if (p.length < 18) continue;
    const [, name, ascii, , lat, lon, , , cc, , adm1] = p;
    const pop = parseInt(p[14] || "0", 10) || 0;
    const tz = p[17];
    rows.push({ name, ascii, cc, adm1, lat: (+lat).toFixed(4), lon: (+lon).toFixed(4), pop, tz });
  }
  rows.sort((a, b) => b.pop - a.pop); // seeded in population order, so identical names rank sanely
  const out = rows.map((r) => {
    const a = fold(r.name), b = fold(r.ascii);
    return [r.name, a === b ? a : `${a} ${b}`, r.cc, r.adm1, r.lat, r.lon, r.pop, r.tz].join("\t");
  }).join("\n") + "\n";
  await new Promise((ok, bad) => { const f = createWriteStream(OUT); f.on("finish", ok); f.on("error", bad); f.end(out); });
  console.log(`cities.tsv: ${rows.length} cities, ${out.length} bytes`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
