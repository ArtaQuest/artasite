# Reproduction — Globally-Anchored, Robust Seasonality (and the scale-invariance of period-sinc kernels)

This bundle reproduces every headline number in the paper from the open data.

```sh
pip install -r requirements.txt     # numpy, scipy, scikit-learn
python3 reproduce.py
```

`reproduce.py` downloads the open data if it is not already next to it:

- `series2.json` — `{weeks: [ISO dates], series: {field: [raw weekly interest, globally anchored]}}`
  (the N fields, ~1173 weeks, 2004–2026; every series measured against the fixed anchors "arta"/"quest"),
- `ephemeris2.json` — `{lon: {body: [sidereal longitude on the weekly grid]}}` (LAHIRI ayanamsa).

Both are also hosted at `https://artaquest.org/wp-content/uploads/research/`.

## What it prints

1. **Results** — fields fit, median & mean in-sample R² (raw interest, non-negative **Huber** fit,
   synodic Moon, 1° phase sweep), the sign distribution, and the per-body variance decomposition.
2. **Scale-invariance (Section 4)** — the mean in-sample R² as the single global kernel scale `s` is
   swept over `{0.5, 1, 2, 4, 8, 16, 32}`; the spread is a fraction of a percentage point, the paper's
   central methodological claim.
3. **Honest bounds (Section 6)** — the data-optimal PCA ceiling, the no-astrology trend+annual baseline,
   and the zodiac-system (ayanamsa) invariance.

## Regenerating the data

`make_data.py` rebuilds `series2.json` + `ephemeris2.json` from the ArtaQuest analysis tree (run from the
repo root). It is included for provenance; the reviewer only needs `reproduce.py` and the hosted data.
