# Legible Reading for Open Education — code

Two scripts make the audit literally "one command on your own pages":

## 1. `reproduce.py` — verify (Python standard library only, no deps, no network)

The open data is `measurements.json` (raw rendered foreground/background colour pairs + geometry). The
script recomputes the APCA Lc of every pair from first principles and asserts every numeric claim and figure
datum in the paper — including the platform-wide audit, which it **computes** from the 144 released per-sample
colour pairs (nothing is echoed from a stored summary).

    python3 reproduce.py        # PASS/FAIL line per claim; exits non-zero on any failure

It also reports the APCA **size-conditioned** target per sample (the worst-case small labels clear the flat
readable floor but sit below the fluent-reading target their size demands), and emits `figure1.dat` +
`figure2.dat` so the figures are generated from the code. `measurements.json` ships next to the code so it
runs standalone; it is also the paper's open data.

## 2. `collect.mjs` — measure any site (Node + Playwright)

The DOM-walking collector described in the Methods: it launches a headless browser over a live site's own
rendered pages, walks each text element's parent-resolved opaque background, recomputes Lc, and keeps each
route's worst-8 lowest-contrast components — emitting the `measurements.json` that `reproduce.py` verifies.

    npm i playwright
    node collect.mjs https://your-platform.example  [/route,/route,...]  [--theme dark|light]

Read-only: it navigates and measures, never posts. The in-page APCA + parent-background resolution is
byte-identical to `reproduce.py`, so the whole pipeline is: collect.mjs (rendered pixels → colour pairs);
reproduce.py (colour pairs → Lc), with no contrast value ever trusted as input.
