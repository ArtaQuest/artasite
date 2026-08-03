# ArtaContrast → the universal colour optimizer (the end state)

**Goal.** A runtime engine that **iterates each UI component, analyses the pixel density (fineness φ) of
its rendered content, and sets that component's base/scale colour** to the optimum for its φ + background.
The reading study fits the model; this is the product that runs it on every device.

## The kernel (from the study)
> φ = measured rendered fineness of a component's content (edge px / inked px) · **R(φ)=clamp(floor, C, K·φ)**
> (CSF: finer ⇒ more contrast) · **base colour = the colour whose *effective* APCA Lc = ρ·R(φ)** on the
> component's background `bg`; brand hue locked + gated, comfort-capped at C.

## Runtime pipeline (on load, and on theme / contrast / DPR change)
1. **Inventory** the distinct *content signatures* actually present — text `(family, px, weight)`, SVG/icon
   ids, border/line widths, shape sizes. (A handful of distinct signatures, not every node.)
2. **Measure φ per signature on THIS device** at the live DPR — a sub-ms canvas micro-render (a lorem
   block for text; the actual SVG for an icon; the rule for a border) → read edge/ink density. **Cache by
   signature.** φ is automatically DPR/font/shape-aware, so the result is *per-device optimal* — which is
   the whole point of the study, productised.
3. **Resolve each component's background** (the surface token up its ancestor chain).
4. **Role weight ρ** from a tiny heuristic (body/heading/icon = 1; border/divider/decoration < 1 → stays subtle).
5. **Solve** `fg* = solveColour(bg, ρ·R(φ))` (existing engine: APCA-inverse, brand complementary + wash gate, comfort cap C).
6. **Apply by cluster, not per element:** group components by `(φ-signature × bg × role)`, compute `fg*`
   once per cluster, emit a small set of **derived CSS variables / tier classes** → the whole UI updates.
   O(distinct signatures), not O(elements).

## Why this subsumes today's ArtaContrast
- The fixed 5-level ramp + hand-set tiers (`ink`, `ink-2`, `ink-3`, `line`, brand) become **content-measured
  tiers**: each tier's φ is *measured* (body 16 px, muted 13 px, 1 px borders, icon strokes, headings),
  not guessed — so small/thin elements get exactly the extra contrast the CSF + rasterisation demand, and
  borders stay calm, **automatically and per device**.
- The **slider** stays as a global scaler on ρ / the target band (Calm↔Crisp); **prefers-contrast**,
  the **complementary brand pair**, and the **size/thickness awareness** all fall out of one function.
- Runtime (not build-time) because φ depends on the live DPR/device — measuring on-device is what makes it
  optimal *for that screen*.

## Performance & limits
- Cluster + cache ⇒ a few dozen micro-renders per load, recomputed only on theme/contrast/DPR change. Cheap.
- φ via canvas captures grayscale AA + DPR + shape (the cross-platform signal) — **not** Windows ClearType
  subpixel or the physical display (screenshot/canvas scope). Brand identity is preserved (hue locked).

## What the experiment delivers into this engine
The per-device JSONs fit: **K and the comfort ceiling C**, the **erosion correction** (designed→effective
per DPR), the default **ρ** per role, and the **φ-measurement spec** (window size, edge thresholds) — plus
the **universality collapse test** that proves one R(φ) curve serves text, lines, rings, circles, ellipses.
Until data lands, the engine runs on the APCA-anchored provisional calibration.
