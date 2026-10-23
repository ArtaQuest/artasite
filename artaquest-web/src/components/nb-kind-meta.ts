/**
 * The notebook-kind registry, in its own module so the always-loaded shell (SearchBox, RailCards)
 * can read kind labels/paths without pulling nbview — and through it the reader, ArtaTTS, the media
 * library and the audio player — into the entry bundle. nbview re-exports it, so existing imports
 * keep working.
 */
import type { NbKind } from "../lib/api";

/** blurb = the feed one-liner; contract = what a work of this kind typically ships.
 *  The kind is no longer chosen up front — it is DERIVED from the files an author publishes
 *  (Kernel::kind_for), so this registry is a lens for shelves, chips and SEO hubs, never a gate.
 *  Eleven kinds — Survey · Dataset · Model · Article · 2D/3D Illustration · 2D/3D Animation ·
 *  2D/3D Game · Music. Legacy kind values normalise via normalizeNbKind. */
export const NB_KIND_META: Record<NbKind, { label: string; plural: string; path: string; blurb: string; contract: string }> = {
  survey:         { label: "Survey",          plural: "Surveys",          path: "/surveys",          blurb: "survey instruments with their analysis pipelines",
    contract: "out/instrument.json — items[] (id, text, scale, reverse), scales[] and 5-point labels, plus an analysis demo on seeded simulated responses" },
  dataset:        { label: "Dataset",         plural: "Datasets",         path: "/datasets",         blurb: "datasets built deterministically, datasheet included",
    contract: "out/data.csv — built deterministically, with an inline datasheet (schema, provenance, licence)" },
  model:          { label: "Model",           plural: "Models",           path: "/models",           blurb: "models trained offline before your eyes",
    contract: "out/model.json — serialised weights trained offline in the notebook, plus metrics and an evaluation figure" },
  article:        { label: "Article",         plural: "Articles",         path: "/articles",         blurb: "writing where every claim is computed in place",
    contract: "out/article.html — the compiled article, self-contained with its own colours; every figure computed in the cells" },
  illustration2d: { label: "2D Illustration", plural: "2D Illustrations", path: "/2d-illustrations", blurb: "procedural artworks you can re-draw yourself",
    contract: "out/artwork.png — an artwork drawn procedurally by your code (also displayed inline)" },
  illustration3d: { label: "3D Illustration", plural: "3D Illustrations", path: "/3d-illustrations", blurb: "three-dimensional scenes built as geometry by code",
    contract: "out/artwork.png — a rendered view of the 3D scene your code built, PLUS out/scene.obj, its geometry as plain Wavefront OBJ" },
  animation2d:    { label: "2D Animation",    plural: "2D Animations",    path: "/2d-animations",    blurb: "animations rendered from code, frame by honest frame",
    contract: "out/animation.gif or out/animation.mp4 — the animation your code renders" },
  animation3d:    { label: "3D Animation",    plural: "3D Animations",    path: "/3d-animations",    blurb: "camera flights through scenes built in three dimensions",
    contract: "out/animation.mp4 or out/animation.gif — a scene genuinely moving in depth, PLUS out/scene.obj, the underlying geometry" },
  game2d:         { label: "2D Game",         plural: "2D Games",         path: "/2d-games",         blurb: "playable games written by their notebooks",
    contract: "out/game.html — fully self-contained and playable: bot + two-player modes on a start screen, every move animated with notebook-generated art" },
  game3d:         { label: "3D Game",         plural: "3D Games",         path: "/3d-games",         blurb: "playable worlds with real depth, written by their notebooks",
    contract: "out/game.html — the same fully self-contained bot + two-player contract as 2D, but genuinely three-dimensional: real-time perspective with depth the player moves through" },
  // The one kind with FIVE own axes (operator 2026-07-26): music is measured in more independent
  // dimensions than a still image, and the fifth axis IS the model requirement — the weights must
  // ship beside the track, cryptographically bound to the audio they render.
  music:          { label: "Music",           plural: "Music",            path: "/music",            blurb: "epic tracks rendered by models the notebook trains",
    contract: "out/track.wav — an original piece rendered from a generative model your notebook trains offline in its own cells (44.1 kHz 16-bit, 45–480 s, seeded and byte-stable), PLUS out/weights.safetensors, those trained weights carrying the track's own sha256 — reloaded from disk and re-rendered in the cells to prove the binding" },
};
