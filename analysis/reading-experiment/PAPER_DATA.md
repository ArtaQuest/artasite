# ArtaContrast — open-data package for the Educational Accessibility paper

All data was collected **automatically, on production** (artaquest.org), via the persistent Chrome over CDP
(no user testing, no camera — per the protocol). Every number is the **rendered, on-device** value measured
against each element's **real background** in APCA Lc.

## 1. The model (what the paper proposes)
See **MODEL.md** (canonical). One sentence: *a component's contrast = the APCA-required Lc for its content's
fineness, realised against its real background; one slider scales five perceptually-even (linear-in-Lc) stops;
the two brand accents are exact additive complements (gold + blue = white).* Physics in MODEL.md §"Math/physics check".

## 2. Quantitative datasets (open data)
| File | What it is | Headline result |
|------|-----------|-----------------|
| `audit-out/audit-report.json` | light, 9 routes × 5 levels, per-element achieved-vs-required Lc | **0 criticals at Standard** |
| `audit-out/audit-report-dark.json` | dark, post-fix | **0 criticals** (was 9 before the blue-text fix) |
| `audit-out/audit-report-dark-extra.json` | dark, 6 more public routes | 0 criticals at Standard |
| `qa-report-dark.json` / `qa-report-light.json` | function + design QA, 11 routes/theme | 0 failing · 0 off-brand accents · slider verified moving `--color-ink` |
| `readmode-out/readmode-dark.json` | the seasonality article's reading typography | body 16px / measure 58–60 char / lh + Lc tuned |

Each audit row: `{kind, px, weight, color, bg, achievedLc, requiredLc/comfort, severity, sample}`.

## 3. Key empirical findings
1. **The default (Standard) is sound:** 0 genuinely-low-contrast elements (achieved Lc < 45) across 15 routes ×
   both themes. The "below APCA floor" counts are APCA's strict 100-for-≤14px rule on bold/uppercase eyebrow
   labels, which sit at Lc 53–64 — above realistic UI comfort.
2. **The one real bug class was blue text on dark** (blue is luminance-poor): `yin-ink` #6088ff = Lc 41,
   hardcoded axis blue #2352E8 = Lc 21. Fix → #9CB6FF (Lc 63); dark criticals **9 → 0**, verified by re-audit.
3. **The slider is perceptually monotonic:** dark `--color-ink` ramps #b6b6b6→#eeeeee (L1→L5); light *darkens*
   #6e6e6e→#080808 — equal Lc steps (≈8 Lc, one Miller-distinct increment).
4. **Brand pair sums to white** at every level (gold+blue = 255,255,255), confirmed in the live bundle.
5. **Read-mode (journal article):** measure (58–60 char, ≤70ch cap) and size (16px body, 41px h1) already
   optimal; body was in the *secondary* ink (Lc 71) at line-height 1.78 → moved to *primary* ink (Lc ~80) at
   1.62, links to the accessible blue ink. (before/after in `readmode-out/`.)

## 4. Qualitative figures (Standard mode, both themes)
`audit-out/shot_*_L3.png` (light) · `qa-out/{dark,light}/shot_*_L3.png` (both themes, 11 routes) ·
`qa-out/{dark,light}/slider_home_L{1..5}.png` (the 5-level sweep) · `readmode-out/article_{dark,light}_{full,body}.png`
(the article reader before/after). PNGs are git-ignored (large); regenerate with the tools below.

## 5. Methods (reproducible tooling — committed)
- `tools/contrast-audit.mjs` — CDP audit: per-element achieved-vs-required Lc on the real bg, any route/level/theme.
- `tools/contrast-audit-analyze.mjs` — re-grades by size-band + realistic comfort floor (CRIT<45 / WARN / OK).
- `tools/qa-prod.mjs` — function (console/page errors, SPA mount) + design (brand present, no off-brand accent,
  slider + theme mechanism) + screenshots.
- `tools/readmode-audit.mjs` — reading typography of an article (size, line-height, measure, per-element Lc).
- `analysis/reading-experiment/audit.js` — the same measurement as a paste-in console bookmarklet.
- Engine under test: `artaquest-web/src/lib/contrast.ts` (APCA G-4g, bit-exact vs apca-w3).

→ Paper draft: Intro (why APCA + reading-perf) · Model (MODEL.md) · Methods (§5) · Results (§3, with §2 datasets +
§4 figures) · honest scope (no "optimal"; APCA = cited physics; `w`/fineness = device-relative geometry index).
