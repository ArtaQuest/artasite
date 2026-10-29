#!/usr/bin/env node
// Checks the ArtaSearch detail-panel formatters (src/lib/alumni-format.ts): headline cleanup, account handles,
// evidence chips and times. Transpiles the one module with TypeScript (already a devDependency); no test runner.
// Run: node scripts/check-alumni-format.mjs
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/alumni-format.ts"), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const file = join(mkdtempSync(join(tmpdir(), "aqfmt-")), "alumni-format.mjs");
writeFileSync(file, js);
const f = await import(file);

let fail = 0;
const eq = (got, want, what) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.error(`FAIL ${what}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};

eq(f.cleanHeadline("Yunus Emre Erkan", "Yunus Emre Erkan - Senior CS Student at Bilkent University | LinkedIn", "Helmholtz Munich"),
  "Senior CS Student at Bilkent University · Helmholtz Munich", "headline: LinkedIn title + employer");
eq(f.cleanHeadline("Ali Veli", "Ali Veli – Software Engineer – Google | LinkedIn", "Google"), "Software Engineer – Google", "headline: employer already in role");
eq(f.cleanHeadline("Ali Veli", "Ali Veli | LinkedIn", ""), "", "headline: name only");
eq(f.cleanHeadline("Şule Işık", "Sule Isik - PhD Candidate | LinkedIn", ""), "PhD Candidate", "headline: accent-insensitive name");
eq(f.cleanHeadline("Ali Veli", "", "ASELSAN"), "ASELSAN", "headline: employer only");
eq(f.cleanHeadline("Ali Veli", "Data Scientist at Trendyol", ""), "Data Scientist at Trendyol", "headline: plain role kept");

eq(f.profileHandle("linkedin", "https://www.linkedin.com/in/yunus-emre-erkan/"), "linkedin.com/in/yunus-emre-erkan", "handle: linkedin");
eq(f.profileHandle("linkedin", "https://tr.linkedin.com/in/%C5%9Fule-i%C5%9F%C4%B1k"), "linkedin.com/in/şule-işık", "handle: linkedin decoded");
eq(f.profileHandle("github", "https://github.com/yunusee"), "@yunusee", "handle: github");
eq(f.profileHandle("x", "https://x.com/yunus"), "@yunus", "handle: x");
eq(f.profileHandle("instagram", "https://www.instagram.com/aysedemir.ee/"), "@aysedemir.ee", "handle: instagram");
eq(f.profileHandle("youtube", "https://www.youtube.com/@ayse"), "@ayse", "handle: youtube @");
eq(f.profileHandle("facebook", "https://www.facebook.com/profile.php?id=1000123"), "facebook.com/profile.php?id=1000123", "handle: facebook id");
eq(f.profileHandle("researchgate", "https://www.researchgate.net/profile/Ali-Veli"), "researchgate.net/profile/Ali-Veli", "handle: researchgate");

eq(f.evidenceChips("anchor:bilkent+field+distinct-name"), ["Bilkent on profile", "Dept matches", "Distinctive name"], "evidence: anchor");
eq(f.evidenceChips("corroborated:distinct-name+fullname-handle+xname-exact"),
  ["Backed by a linked account", "Distinctive name", "Name = handle", "Exact name on X"], "evidence: corroborated");
eq(f.evidenceChips("bilkent+dept"), ["Bilkent on profile", "Dept matches"], "evidence: plain");
eq(f.evidenceChips("bilkent+shared:purdue+some-new-code"), ["Bilkent on profile", "Shares Purdue", "Some new code"], "evidence: shared + unknown");
eq(f.evidenceChips(""), [], "evidence: empty");

const now = new Date("2026-10-27T14:48:00Z");
eq(f.relTime("2026-10-24 10:05:35", now), "3 days ago", "relTime days");
eq(f.relTime("2026-10-27 14:47:50", now), "just now", "relTime now");
eq(f.relTime("2026-10-27 12:48:00", now), "2 hours ago", "relTime hours");
eq(f.relTime("2026-10-24", now), "4 days ago", "relTime date only");
eq(f.istanbulTime("2026-10-24 10:05:35"), "24 Oct 2026, 13:05 (Istanbul time)", "istanbulTime");
eq(f.relTime(null, now), "", "relTime null");

eq(f.gpaLabel(3.6), "3.60", "gpaLabel pads to two decimals");
eq(f.gpaLabel("2.28"), "2.28", "gpaLabel string from the API");
eq(f.gpaLabel(3.825), "3.83", "gpaLabel rounds");
eq([f.gpaLabel(null), f.gpaLabel(undefined), f.gpaLabel(""), f.gpaLabel(NaN), f.gpaLabel(-1), f.gpaLabel(9)], ["", "", "", "", "", ""], "gpaLabel none/invalid -> empty");
eq(f.ESTIMATE_NOTE, "Estimate from roster", "estimate tooltip");

if (fail) { console.error(`${fail} alumni-format check(s) failed`); process.exit(1); }
console.log("alumni-format: all checks pass");
