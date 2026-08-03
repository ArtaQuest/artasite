# Protocol — the audit dev tool + the paper's screenshots

The model is in MODEL.md (adversarially hardened): **a component's contrast is the APCA-required Lc for
its content's fineness, realised against its *real* background.** The dev tool is now a live-DOM **audit**
(`audit.js`), not the old `R(D)` sample-renderer (`contrast-test.html` is superseded — kept only as a
historical demo).

## Run the audit (read-only, one paste, any device, no camera)
1. Open any ArtaQuest route in **Standard** mode (`data-contrast="3"`).
2. Paste `audit.js` into the DevTools console (or save it as a bookmarklet).
3. It walks the live DOM, and per element reads `(px, weight, colour)` + its **parent-resolved
   background**, computes the **achieved APCA Lc on that real background** vs the **required Lc for its
   size** (APCA font matrix), de-dups by `(px, weight, colour, bg)`, **flags anything below floor**,
   prints a table, and downloads `aqaudit_<route>_*.json`.
4. Repeat on the major routes — home, an article in the reader, a course, rankings — so coverage spans
   real production surfaces (each on its real background).

## Collect the paper's figures (Standard mode, qualitative)
- With `data-contrast="3"`, screenshot the **real routes** above — the figures *are* the product.
- The audit JSONs are the quantitative companion (per-component achieved vs required Lc).

## Open data for the paper
The committed `aqaudit_*.json` snapshots `{component, px/weight or border-width, bg-hex, achieved-Lc,
required-Lc, pass}` per real surface. That is the falsifiable backbone (MODEL.md, Claims 1–2): on text,
achieved vs APCA's published matrix; on non-text, cross-primitive consistency at equal fineness.

→ then: write the Nature-style paper for the Educational Accessibility journal from the audit data + the
Standard-mode screenshots (honest scope — no "optimal", APCA as the cited physics).
