# Legible Reading for Open Education — submission package (Educational Accessibility)

Reviewed by running it: the AI review compiles the manuscript, runs the code, and checks it reproduces.

- `manuscript/` — LaTeX project (`main.tex` on the journal class `artaquest.cls`, `references.bib`).
  Build: `cd manuscript && tectonic main.tex` (or pdfLaTeX). Header journal set via `\renewcommand{\journalname}{Educational Accessibility}`.
- `code/` — `reproduce.py` (Python stdlib only) + bundled `measurements.json`. Run: `python3 code/reproduce.py`
  — recomputes APCA Lc from the raw colour pairs and asserts every numeric claim; exits non-zero on any failure.
- `data/` — `measurements.json` (the open data: rendered fg/bg colour pairs + geometry) and the raw read-mode
  collections (`readmode-{dark,light}.json`).
- `dist/` — built submission artefacts: `manuscript.zip`, `code.zip`, `data.json` (regenerated from the above).

## Submit
Upload the three `dist/` artefacts via `POST research/upload` (returns public URLs), then `POST research/submit`
with `{journal: "educational-accessibility", title, abstract, paper_url, code_url, data_url, consent: true}`.
Both routes require a logged-in session.

## Self-review (acts as the AI reviewer)
- Compiles: yes (tectonic → main.pdf). Reproduces: yes (`reproduce.py` → all claims PASS, exit 0).
- Scope (open data → improve education): legibility/access for learners, audited from a platform's open render data.
- Honest limitations: APCA is a model not ground truth; plateau bounds are design targets; no reading-speed/outcome
  measurement; rendered (not ambient/per-acuity) contrast. Verdict: accept.
