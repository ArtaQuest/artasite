# The universal optimal-colour model — fg*(object, background)

**Question.** For **any object** (text, line, circle, ellipse, …) on a background `bg`, what foreground
colour is optimal? Screenshots only — no camera. Physics (luminance/contrast) + neuroscience (the
contrast-sensitivity function), with the device's anti-aliasing loss read from its own rasterisation.

## Universal size parameter — MEASURED, not assumed
Different objects have no common "thickness", so instead of a per-type geometry formula we **measure a
single pixel statistic from the object's own rasterisation** — its **rendered fineness φ**:

```
φ  =  (anti-aliased edge pixels) / (total inked pixels)   ∈ [0,1]
```

A 1-px line is almost all edge (φ→high); a large filled disc is mostly solid interior (φ→low); a big
lorem-ipsum block's φ falls as the font grows. φ is **universal** (any rendered object), **measured from
the same screenshot**, and **inherently DPR/font/shape-aware** (it reflects exactly how *this* device drew
the object). It is also the CSF's currency: edge density ∝ 1/feature-size ∝ spatial frequency, so
**φ ∝ 1/σ**. The geometric **angular size σ** is then just its *physical interpretation* / cross-check:

```
characteristic feature ≈ c/φ device-px  →  σ(arcmin) = (c/φ)/DPR · 60 / (device_ppi · distance_inch · π/180)
```
(For text, φ is most stable measured over a sizeable lorem-ipsum block; for a single shape, over the shape.)

## The model (simple, monotonic, calibrated)
> **R(φ) = clamp( floor, C, K · φ )**   ·   **fg\*(object, bg) = the colour whose *effective* APCA Lc = ρ · R(φ)**, solved on `bg`.

- **R(φ) — neuroscience.** Since φ ∝ spatial frequency (∝ 1/feature-size), required contrast **rises with
  φ** on the CSF's high-frequency limb — finer/thinner objects (high φ) need more, large/solid objects
  (low φ) floor out (easy). Monotonic — correct for *objects* (vs gratings). Equivalent to the inverse law
  R ∝ K/σ via φ ∝ 1/σ.
- **Calibration (fit, not assumed).** K, the comfort ceiling **C (≈92, the saturation/halation band)**,
  the floor **(≈45)**, and the reference viewing distance are **fit** by anchoring text to the verified
  APCA matrix (16 px→Lc 90, 24 px→Lc 60 at the reference geometry ⇒ b=1, K≈720·arcmin) and to the
  screenshot/subjective data.
- **physics.** sRGB → linear → APCA luminance → Lc (IEC 61966-2-1 + APCA G-4g).
- **effective Lc — the screenshot term.** Anti-aliasing erodes thin objects; the instrument reads the
  *coverage-weighted rendered luminance* of the object's ink from the device's own rasterisation, so the
  *designed* colour needed to reach a target *effective* Lc is higher on low-CSS-PPD / heavy-AA platforms.
- **ρ — role weight ∈ (0,1].** Legibility objects (text/icons) ρ=1; *decorative* thin objects
  (borders/dividers) ρ<1 to stay subtle. The only design input.

## Instrument & data (one click, per device)
Renders, at native DPR, a grid of **object {text 11–28 px×weights · lines 1–3 px · circle outlines ·
filled circles 4–32 px · ellipses} × background (greys spanning black→white) × foreground sweep**, reads
back the pixels, records `{type, σ_px, bg, fg, designedLc, effectiveLc}` + metadata (UA, DPR, est.
CSS-ppi, colour-gamut, prefers-contrast) → one JSON. Deterministic.

## Fitting, optimisation & the universality test
1. Per (object, bg, device): the fg sweep gives **effective Lc(fg)** → **invert** at ρ·R(σ) → **fg\*.**
2. **Universality test (key):** pool *all* object types and plot the perceived-threshold effective Lc vs
   **σ** — text, lines, discs, ellipses must **collapse onto one R(σ) curve**. The collapse residual fits
   K/b and validates the per-type `governingSize` map (if a type sits off-curve, its map is wrong).
3. Fit the **erosion** E(σ, DPR) = designed(fg\*) − R(σ) across devices; aggregate → robust `fg*(object,bg)`.

## Feeds back into ArtaContrast
Every token becomes a thin wrapper over `fg*`: compute σ from the element's type/size + the surface, look
up ρ for its role, solve on `bg`. So `--color-ink-3` (small) and a thin icon stroke get the extra contrast
σ demands, borders (ρ low) stay calm, big headings/fills relax — one model, any object, instead of a
hand-built ramp.

## Scope & honesty
Screenshots capture framebuffer rasterisation (grayscale AA, hinting, DPR) — not ClearType subpixel, the
physical display, ambient glare or brightness (camera study = out of scope). σ uses an *assumed* viewing
distance per device class (fit, stated). Deterministic ⇒ CIs from pixel sampling + bootstrap; **n = devices**
— a reproducible model fit + rendering audit, not population inference. Pre-register ρ, C, distances.
