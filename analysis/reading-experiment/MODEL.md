# ArtaContrast — the model (adversarially hardened; v2 = usage-tier token contracts)

> **Each component's contrast is the APCA-required Lc for its content's fineness, realised as a colour
> against its *real* background; the global slider scales which of five evenly-spaced stops shows.**

One idea, zero invented constants, background as a first-class input. (Survived a 6-facet red-team:
25/30 critiques confirmed; the bespoke `R(D)=45+47·D` apparatus was scrapped as redundant with what
already ships.)

## v2 — usage-tier token contracts (closes the gap the v1 paper named)
The v1 audit's honest finding was that every worst-case small label cleared the readable floor but none
met a fluent target — "where the next pass goes". v2 is that pass, done at the TOKEN level so it holds
globally by construction rather than per-component:

1. **Each neutral token is contracted to a usage tier**, and the engine (`contrast.ts tokensFor()`)
   guarantees the tier's Lc floor at **every** slider stop, both themes, any canvas:
   `--color-ink` = content/body (the theme AA body floor: Lc 62 dark / 75 light, rising with the slider);
   `--color-ink-2` = fluent UI text *including all micro labels <12px* (floor **Lc 60**);
   `--color-ink-3` = incidental text only — timestamps, placeholders, kickers ≥11px (floor **Lc 55**).
   Calm compresses the hierarchy toward the floors; it can no longer dip below them (dark Calm used to
   render ink-2/ink-3 at Lc 58/53).
2. **Components bind text to its tier's token** — the micro sweep moved every sub-12px label off ink-3
   onto ink-2, so "smaller text gets MORE contrast, never less" holds in the shipped UI, not just the spec.
3. **One source of truth for pre-paint and runtime** — the `[data-contrast]` CSS ramp in index.css is
   *generated* from the same `tokensFor()` the runtime applies (`tools/gen-contrast-ramp.mjs`; the SPA
   build fails if it is stale), so the page a learner sees before hydration is bit-identical in intent to
   the one after — including the K-scaled complementary brand pair, which the old hand-kept ramp froze
   at canonical.
4. **The audits grade by the tier model** (micro comfort = 60, never LESS than fluent — the old micro=55
   inverted the size→contrast law); the strict long-form APCA matrix stays as a reference column.

## The maths (reuses code already in `contrast.ts`)
For each component, an **anchor Lc** from its content's fineness, then five evenly-spaced stops, then a
colour solved on its **actual** surface:

- **Anchor (the required Lc):**
  - **Text** — straight from APCA's published size×weight matrix: `anchor = lcFloor(px, weight)`
    (already in the engine, bit-exact). *No new constants, no double-count.*
  - **Non-text (divider / border / icon stroke)** — closed-form, no rasteriser: a stroke of CSS width
    `t` has antialiased-rim fraction `D = min(1, 2/t)`; map `t` to an equivalent px and reuse the **same**
    `lcFloor` curve. (Thin `t→1px` ⇒ high-Lc floor; thick rules step down.)
- **Five stops — one shared ladder, additive in Lc (not multiplicative):**
  `stop(level) = clamp(anchor + (level−3)·Δ, floor, maxLc(bg))`, `Δ ≈ (max−floor)/4 ≈ 8 Lc` (the engine's
  existing spacing). On clamp, **shift the whole band** into `[floor, maxLc(bg)]` so all five stay
  equidistant + Miller-distinct at the rail (distinctness > honouring the anchor at the edge).
- **Background is first-class:** `colour = textForContrast(bg_real, target, hue)` — solved on the
  component's resolved surface (dark space, white card, gold button…). If clamped, report **achieved** Lc.

**Why (honest grounding).** *Physics:* APCA Lc + per-surface solve (already verified). *The size→contrast
law:* APCA's empirical font matrix (`lcFloor`), not a hand-fit line. *Fineness `D=2/t`:* a device-relative
**geometry index** for the strokes the matrix can't describe — explicitly *not* claimed as a CSF/perceptual
quantity. `prefers-contrast` stays frozen; density only moves neutral tokens.

## The brand pair — exact additive complements (gold + blue = white)
One rule: **blue = white − gold.** The two accents sum to white (255) per channel, so they are true
additive complements (yin + yang complete to light), with the true-neutral midpoint **MID = white/2 = 127.5**.
The contrast slider mutes both toward MID by a factor `k`; because `255 − mute(gold) = mute(255 − gold)`,
the muted pair still sums to white at **every** level — the invariant is structural, not enforced per-step.
Gold is kept canonical (`#E8B923`, the logo hue); blue is derived (`#1746DC` at full brand — the old
`#2352E8` summed to a super-white 267 that merely clipped). Brand-as-text uses the fixed `yin-ink`/`yang-ink`
tokens (legibility), so the complement rule governs *fills/marks*, not text contrast.

## Math/physics check (verified, `node`)
- **APCA G-4g bit-exact:** black-on-white Lc 106, white-on-black 108, mid-grey (#888 on #fff) 63; soft
  black-clamp exponent 1.414; polarity-asymmetric exponents (0.56/0.57 normal, 0.65/0.62 reverse).
- **Perceptual uniformity:** Lc is ~uniform for contrast, so the 5 slider stops are *linear in Lc*
  (equal perceived steps) and the text tiers step down by a constant Lc — Miller's ~5 distinct levels.
- **Complementarity:** gold + blue = (255,255,255) confirmed at k = 1 / 0.775 / 0.55; pair point-symmetric
  about 127.5. (Note: muting toward RGB-mid is symmetric in RGB but not in *luminance* — gold dims while
  blue brightens on dark — which is why brand-as-text uses the dedicated `yin-ink`, not the muted fill blue.)
- **Live audit:** 0 genuinely-low-contrast elements at Standard across 15 routes × both themes (see audit-out/).

## The dev tool — a live-DOM audit, not a registry
`?contrast-audit` mode on the real SPA: `querySelectorAll` + `getComputedStyle` reads each element's
`(fontSize, weight, family, color, stroke-width)` and its **parent-resolved background**, de-dups by the
tuple `(px, weight, family, color, bg)` — *bg in the key*, so the same text on dark vs gold are distinct.
Per sample: text → `lcFloor(px,weight)`; stroke → `lcFloor(2/t→w_eq)`; colour/achieved-Lc via
`textForContrast(bg, target)`. Emits a static `{token → anchor-Lc}` table → fed to the existing
`genramp.mjs` at **build time** (no runtime canvas, SSR-safe). Drift is impossible (nothing hand-copied);
CI re-runs the audit and diffs. Scrapped: the 12-item string registry, the mock gallery, the runtime
edge/ink rasteriser + its magic thresholds, the fixed black field, and `devicePixelRatio` from the model.

## Integration (SSR-safe, minimal, non-regressing)
Only one engine site changes: replace the ad-hoc line target `7 + t*23` with `lcFloor(w_eq)`; text tokens
already route through `lcFloor`-band + `textForContrast`. The slider, pre-paint attribute, complementary
brand, and `prefers-contrast` are untouched — the anchor table is a precomputed build constant.

## The paper (Educational Accessibility) — honest, falsifiable, screenshot-only
- **Claim 1 (validation):** on text, the unified `w→Lc` anchor tracks APCA's published matrix within ±X Lc
  (concordance, not a competing prediction).
- **Claim 2 (contribution):** the *same* scalar extends `lcFloor` to non-text primitives where APCA is
  silent — tested by **cross-primitive self-consistency** (primitives at equal `w` should reach equal
  achieved Lc; report the spread — low = universal, high = falsified).
- **Baseline:** 3-column per sample — fixed-Lc (null) · APCA-matrix (text) · unified-`w` — all in-browser.
- **Figures:** set `data-contrast="3"` on the live app, screenshot **real routes** (the figures *are* the product).
- **Open data:** the committed tuple snapshot `{component, px/weight or w, bg-hex, target-Lc, achieved-Lc per stop}` + font hash; CI-regenerable.
- **Scope (no over-claim):** drop "optimal" and "CSF/neuroscience-grounded"; `w` is a device-relative
  geometry index, APCA is the cited physics, monotone size→contrast is the correct *local* approximation
  in the acuity-limited UI band (CSF = qualitative motivation only).
