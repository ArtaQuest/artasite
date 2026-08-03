/**
 * Analyse audit-report.json into an ACTIONABLE summary (density-law units).
 *
 * The audit rows carry the law's own grading (see tools/contrast-audit.mjs):
 *   achievedV — the element's visibility V = D·(Ymax−Ymin)/(Ymax+Y0)
 *   floorV    — the never-below bar (weakest legitimate token at the theme's calm end)
 *   comfortV  — the Standard-step bar for the element's role (body = full criterion, small = ink-2)
 * Severity:
 *   CRITICAL  achievedV < floorV   (genuinely hard to read at ANY comfort step — a real bug)
 *   WARN      floorV ≤ achievedV < comfortV   (readable but below the Standard target)
 *   OK        otherwise
 * Reports per level: counts by severity, and the worst CRITICALs (the fix list). Focuses on Standard (L3).
 *
 *   node tools/contrast-audit-analyze.mjs [audit-report.json]
 */
import { readFileSync } from "node:fs";
const OUT = new URL("../analysis/reading-experiment/audit-out/", import.meta.url).pathname;
const rep = JSON.parse(readFileSync(OUT + (process.argv[2] || "audit-report.json"), "utf8"));

const sev = (r) => {
  if (r.kind !== "border" && r.floorV != null && r.achievedV < r.floorV) return "CRIT";
  if (r.achievedV < r.comfortV) return "WARN";
  return "OK";
};
const band = (r) => r.band || (r.kind === "border" ? "border" : r.px >= 16 ? "body" : r.px >= 12 ? "ui" : "micro");

const crit = []; // collect CRITICALs across the report for the fix list
for (const [route, byLevel] of Object.entries(rep.routes)) {
  for (const [level, d] of Object.entries(byLevel)) {
    for (const r of d.worst || []) {
      if (sev(r) === "CRIT") crit.push({ route, level: +level, ...r, band: band(r) });
    }
  }
}

// Standard-mode (L3) health, the default everyone sees
console.log("=== STANDARD (L3) per-route severity (worst-8 sample only) ===");
for (const [route, byLevel] of Object.entries(rep.routes)) {
  const d = byLevel["3"]; if (!d) continue;
  const c = { CRIT: 0, WARN: 0, OK: 0 };
  for (const r of d.worst || []) c[sev(r)]++;
  console.log(`  ${route.padEnd(34)} samples=${String(d.samples).padStart(3)}  worst8: CRIT=${c.CRIT} WARN=${c.WARN} OK=${c.OK}  [data-contrast=${d.dataContrast}]`);
}

// dedupe CRITs by (kind,px,weight,color,bg); show the genuinely-low-contrast fix list
const seen = new Map();
for (const r of crit) {
  const k = `${r.kind}|${r.px}|${r.weight}|${r.color}|${r.bg}`;
  if (!seen.has(k) || r.achievedV < seen.get(k).achievedV) seen.set(k, r);
}
const fixes = [...seen.values()].sort((a, b) => a.achievedV - b.achievedV);
console.log(`\n=== CRITICAL (below the law's floor — genuinely low contrast): ${fixes.length} distinct ===`);
for (const r of fixes.slice(0, 25))
  console.log(`  L${r.level} ${r.band.padEnd(6)} ${String(r.px).padStart(4)}px/${r.weight}  fg ${r.color} on ${r.bg}  V ${r.achievedV} < floor ${r.floorV}  "${r.sample}"  (${r.route})`);

// Standard-only CRITs are the urgent ones (default experience)
const stdCrit = fixes.filter((r) => r.level === 3);
console.log(`\n=== Standard-mode (L3) CRITICALs: ${stdCrit.length} ===`);
for (const r of stdCrit) console.log(`  ${r.band} ${r.px}px/${r.weight} ${r.color} on ${r.bg} V ${r.achievedV} "${r.sample}" (${r.route})`);
console.log(stdCrit.length === 0 ? "\n✓ No genuinely-low-contrast text at Standard — the default experience is sound." : "\n→ Fix these at Standard first.");
