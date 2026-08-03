# The Density Law — reproduction bundle

Companion code for **"The Density Law: A One-Line Rule for Legible Colour from Pixel Density
and Background"** (Educational Accessibility).

The law: an object's colour follows from its content's pixel density D and its background —
`D · (Ymax − Ymin) ≥ C · (Ymax + Y0)`, with C = 0.2767, Y0 = 0.63, b = 1.0 px fitted against
the APCA font table.

## Standard reproduction contract

```
python3 reproduce.py <path-to-glyph-density.json>
```

`reproduce.py` (Python 3 standard library only — `requirements.txt` is empty) takes the released
dataset as its one argument and:

1. rebuilds the 40 threshold pairs from APCA's published font table (APCA re-implemented from
   its frozen constants);
2. refits the law's three constants (C, Y0, b), b restricted to the optics band 0.5–1.5 px;
3. recomputes every number the paper claims — R² (and adjusted R², RMSE, median % error) on the
   required steps, R² and median error on the recovered minimum font sizes, both weight
   cross-validations, token densities, and the deployed ramp luminances;
4. quantifies the uncertainty on the three constants: 20 leave-one-cell-out refits, a 200-replicate
   seeded cell bootstrap (95% percentile intervals), and +5%-SSE profile bands;
5. runs the three ablations (veil on the dimmer side; no adaptation; mechanism-free log-linear
   baseline with a polarity dummy) — same data, machinery, loss, and blur band — and, when the
   dataset carries a `barlow` face, the reference-font refit on Barlow (APCA's calibration face);
6. writes `results.json` and the figure data files `figure1.dat`, `figure2_light.dat`,
   `figure2_dark.dat`, `figure3.dat` (residuals), `figure4.dat` (ramp);
7. asserts every value in `expected.json` (2% tolerance); any mismatch raises.

Deterministic and network-free; the bootstrap is seeded (`random.Random(19)`, `random()` draws
only), so the run is bit-reproducible on every machine. Runtime ≈ 2 minutes (pure-python grid fit).

## Other files

- `measure_density.py` (Python + Pillow + numpy) — regenerates the dataset itself from the
  pinned fonts (SHA-256 checksums are recorded inside the dataset): `python3 measure_density.py`
  writes the Inter face; `python3 measure_density.py barlow` writes the Barlow face.
- `contrast.ts` — the deployed TypeScript engine (ArtaQuest's `lib/contrast.ts`): the closed-form
  solve of the law, the (density, role) token system, and the comfort slider as criterion
  rescaling. `tokensFor()` computes the identical ramp values `reproduce.py` emits in
  `figure4.dat`.
- `fonts/` — Inter 4.1 static TTFs; `fonts-barlow/` — Barlow 1.408 static TTFs, APCA's reference
  face, for the paper's reference-font check (both SIL OFL 1.1; LICENSE.txt included).

## Dataset

One self-describing JSON with two faces — `{"inter": {...}, "barlow": {...}}` — each face: a
lowercase pangram at 21 sizes × 4 weights × 23 Gaussian blur widths (0.5–6.0 px), both density
statistics — `D_ink` (mean blurred ink coverage over solid-ink pixels) and `D_paper` (mean blurred
paper coverage over solid paper pixels within 0.15 em of ink) — plus the exact text, 4×
supersampling factor, and font checksums. (`reproduce.py` also accepts the round-1/2 single-face
file, which is the `inter` face alone.)
