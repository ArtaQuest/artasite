/**
 * Notebook rendering + the kind registry for the feed — keys MUST mirror Notebook::KINDS
 * (the canonical list; ELEVEN kinds since Music returned, 2026-07-26).
 *
 * Every feed submission is a Kaggle notebook that has been run; this module renders one —
 * markdown cells through the shared XSS-safe MarkdownLite, the executed outputs (streams,
 * images, errors) always visible, and code folded behind a per-cell disclosure (collapsed by
 * default: the published page reads as the work, the code is one tap away). HTML outputs render
 * ONLY inside a fully sandboxed iframe (no script access to our origin) — that is also how a
 * published game is playable in place.
 *
 * The measured-gate vocabulary this file used to mirror (rubric axes, their named failure
 * directions, the safe zone, BALANCE) went with the gate itself on 2026-07-28. What replaced it
 * is not a mirror of anything: the checklist ships from the server as data and is rendered,
 * item for item, by components/checklist.tsx.
 */
/* eslint-disable react-refresh/only-export-components -- domain module, like ui.tsx: by design it
   exports the notebook COMPONENTS and the registry/vocabulary/helpers they are built from, in one
   place, because the server-mirrored constants and the components that draw them must not drift. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { normalizeNbKind, notebookPulse, type NbKind, type NotebookCard } from "../lib/api";
import { calmStop } from "../lib/theme";
import { MarkdownLite } from "./reader";
import { watchMath } from "../lib/math";
import { Avatar, Chip, cx, HeartGlyph } from "./ui";
import { nameClass } from "../lib/fmt";
import { LibraryMedia } from "./library";

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

/** Declared external models (metadata.aq.models) — mirrors Notebook::MAX_MODELS / MAX_MODEL_FILES.
 *  The file cap is the relay's own shelf budget and applies ACROSS every declared model in a run,
 *  not per model, so a counter has to total them (a shelf, not a mirror of the Hub). */
export const NB_MAX_MODELS = 4;
export const NB_MAX_MODEL_FILES = 8;

export type NbOutput = {
  output_type: string;
  name?: string;
  text?: string | string[];
  data?: Record<string, string | string[] | unknown>;
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  ename?: string; evalue?: string; traceback?: string[];
};
export type NbCell = { cell_type: "markdown" | "code" | "raw"; source: string | string[]; outputs?: NbOutput[]; execution_count?: number | null };

const joinSrc = (s: string | string[] | undefined) => (Array.isArray(s) ? s.join("") : String(s ?? ""));
// eslint-disable-next-line no-control-regex -- the ESC byte is the point: this strips ANSI colour codes from a cell's stdout
const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, "");

export function parseNb(ipynb: string): NbCell[] {
  try {
    const nb = JSON.parse(ipynb) as { cells?: NbCell[] };
    return Array.isArray(nb.cells) ? nb.cells : [];
  } catch {
    return [];
  }
}

// ── output rendering ──

function ImageOut({ mime, b64 }: { mime: string; b64: string }) {
  return <img src={`data:${mime};base64,${(b64 || "").replace(/\n/g, "")}`} alt="notebook output" className="max-w-full rounded-card" loading="lazy" />;
}

// ── deliverable media, inline (2026-07-22) ──────────────────────────────────
// A notebook's film/track/artwork is usually WRITTEN to out/ (published as an asset), not
// embedded in the ipynb — so the cell that made it ends in "wrote out/animation.mp4" with
// nothing playable. These helpers put the published file right below its producing cell:
// an asset qualifies when the cell's own text outputs mention `out/<name>` (the relay
// publishes every out/ file; intermediates a cell names without the out/ prefix never match).

export type NbAssetRef = { name: string; url: string };

const VIDEO_EXT = /\.(mp4|webm|m4v|mov)$/i;
const AUDIO_EXT = /\.(wav|mp3|ogg|flac|m4a)$/i;
const IMAGE_EXT = /\.(gif|png|jpe?g|webp|svg)$/i;
const isMediaAsset = (n: string) => VIDEO_EXT.test(n) || AUDIO_EXT.test(n) || IMAGE_EXT.test(n);

/** Every text this cell's outputs carry (streams + reprs + html), joined for ref-matching. */
function cellText(c: NbCell): string {
  const parts: string[] = [];
  for (const o of c.outputs || []) {
    if (o.output_type === "stream") parts.push(joinSrc(o.text));
    const d = o.data || {};
    if (typeof d["text/plain"] !== "undefined") parts.push(joinSrc(d["text/plain"] as string | string[]));
    if (typeof d["text/html"] !== "undefined") parts.push(joinSrc(d["text/html"] as string | string[]));
  }
  return parts.join("\n");
}

/** The published media assets this cell wrote (its outputs mention `out/<name>`), in asset order. */
export function cellMedia(c: NbCell, assets: NbAssetRef[] | undefined): NbAssetRef[] {
  if (!assets?.length || c.cell_type !== "code") return [];
  const media = assets.filter((a) => isMediaAsset(a.name));
  if (!media.length) return [];
  const text = cellText(c);
  return media.filter((a) => text.includes(`out/${a.name}`));
}

/** Rewrite `out/<name>` file references to the published asset URLs (for sandboxed HTML). */
function resolveOutRefs(html: string, assets: NbAssetRef[] | undefined): string {
  let out = html;
  for (const a of assets || []) out = out.split(`out/${a.name}`).join(a.url);
  return out;
}

/** IPython's Video/Audio display as a lone <video>/<audio> HTML tag — extract-only detection
 *  so it plays natively instead of behind the sandbox gate. The HTML is NEVER rendered: we pull
 *  one src and require data:video|audio or https (no scripts can ride a media element's src).
 *  Anything richer than a single bare media tag falls back to the sandboxed iframe. */
function extractBareMedia(html: string): { tag: "video" | "audio"; src: string } | null {
  const t = html.trim();
  const m = /^<(video|audio)\b[^<]*(?:<source\b[^>]*\/?>|<\/?\1>|[^<])*$/i.exec(t);
  if (!m) return null;
  const srcm = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(t);
  const src = srcm ? srcm[1] : "";
  if (!/^data:(?:video|audio)\/[a-z0-9.+-]+;base64,/i.test(src) && !/^https:\/\//i.test(src)) return null;
  return { tag: m[1].toLowerCase() as "video" | "audio", src };
}

/** Image formats that can animate on their own — an <img> can't pause them, so they wait
 *  for a tap (Motion-calm: nothing below a cell moves unasked). */
const ANIM_IMG_EXT = /\.(gif|webp|apng)$/i;

/** One published deliverable, playable in place. Nothing animates unasked: video/audio wait
 *  for their controls, gif/webp wait behind a tap-to-play gate. */
function MediaOut({ asset }: { asset: NbAssetRef }) {
  const [play, setPlay] = useState(false);
  if (VIDEO_EXT.test(asset.name)) {
    return <video controls playsInline preload="metadata" src={asset.url} className="max-w-full rounded-card" />;
  }
  if (AUDIO_EXT.test(asset.name)) {
    return <audio controls preload="metadata" src={asset.url} className="w-full" />;
  }
  if (ANIM_IMG_EXT.test(asset.name) && !play) {
    return (
      <button type="button" onClick={() => setPlay(true)} className="self-start rounded-field border border-line bg-space-2 px-3 py-2 text-sm text-ink-2 hover:border-yin-ink">
        ▶ Play {asset.name}
      </button>
    );
  }
  return <img src={asset.url} alt={asset.name} loading="lazy" className="max-w-full rounded-card" />;
}

function HtmlOut({ html, autoOpen }: { html: string; autoOpen?: boolean }) {
  const [open, setOpen] = useState(!!autoOpen);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="rounded-field border border-line bg-space-2 px-3 py-2 text-sm text-ink-2 hover:border-yin-ink">
        Show HTML output (runs sandboxed)
      </button>
    );
  }
  return (
    <iframe
      sandbox="allow-scripts"
      srcDoc={html}
      title="sandboxed notebook output"
      className="h-96 w-full rounded-card border border-line bg-white"
    />
  );
}

/** One nbformat output → DOM. `live` marks outputs the member just executed in THEIR browser
 *  (the Lab): HTML/JS render immediately in the sandbox instead of behind the click gate that
 *  guards stored outputs from strangers' notebooks. `assets` (the published deliverables)
 *  resolves `out/<name>` references inside HTML outputs to their real URLs. */
export function OutputView({ o, live, assets }: { o: NbOutput; live?: boolean; assets?: NbAssetRef[] }) {
  if (o.output_type === "stream") {
    return <pre className="overflow-x-auto whitespace-pre-wrap rounded-card bg-space-1 p-3 text-xs leading-relaxed text-ink-2">{stripAnsi(joinSrc(o.text))}</pre>;
  }
  if (o.output_type === "error") {
    return (
      <pre className="nb-err overflow-x-auto whitespace-pre-wrap rounded-card border border-line bg-space-1 p-3 text-xs leading-relaxed text-ink-2">
        {stripAnsi([`${o.ename}: ${o.evalue}`, ...(o.traceback || [])].join("\n"))}
      </pre>
    );
  }
  const data = o.data || {};
  for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    if (typeof data[mime] === "string") return <ImageOut mime={mime} b64={data[mime] as string} />;
  }
  // Embedded media (IPython Video/Audio with embed=True) plays natively — data: URLs carry no script.
  for (const mime of ["video/mp4", "video/webm", "video/ogg"]) {
    if (typeof data[mime] !== "undefined") {
      const b64 = joinSrc(data[mime] as string | string[]).replace(/\n/g, "");
      return <video controls playsInline preload="metadata" src={`data:${mime};base64,${b64}`} className="max-w-full rounded-card" />;
    }
  }
  for (const mime of ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/ogg", "audio/flac"]) {
    if (typeof data[mime] !== "undefined") {
      const b64 = joinSrc(data[mime] as string | string[]).replace(/\n/g, "");
      return <audio controls preload="metadata" src={`data:${mime === "audio/x-wav" ? "audio/wav" : mime};base64,${b64}`} className="w-full" />;
    }
  }
  if (typeof data["image/svg+xml"] !== "undefined") {
    // SVG can carry script — treat it like HTML and sandbox it.
    return <HtmlOut html={joinSrc(data["image/svg+xml"] as string | string[])} autoOpen={live} />;
  }
  if (typeof data["text/html"] !== "undefined") {
    const html = resolveOutRefs(joinSrc(data["text/html"] as string | string[]), assets);
    const media = extractBareMedia(html);
    if (media?.tag === "video") return <video controls playsInline preload="metadata" src={media.src} className="max-w-full rounded-card" />;
    if (media?.tag === "audio") return <audio controls preload="metadata" src={media.src} className="w-full" />;
    return <HtmlOut html={html} autoOpen={live} />;
  }
  if (typeof data["application/javascript"] !== "undefined") {
    // stored JS outputs (e.g. IPython %%javascript) run ONLY inside the sandboxed iframe
    const js = joinSrc(data["application/javascript"] as string | string[]).replace(/<\/script/gi, "<\\/script");
    return <HtmlOut html={`<script>\n${js}\n</scr` + "ipt>"} autoOpen={live} />;
  }
  if (typeof data["text/latex"] !== "undefined") {
    // KaTeX typesets it — NbView's watchMath sweeps the whole view; the Lab calls renderMathIn.
    const tex = joinSrc(data["text/latex"] as string | string[]).trim();
    return <div className="py-1 text-center text-ink">{/^\$/.test(tex) ? tex : `$$${tex}$$`}</div>;
  }
  if (typeof data["text/plain"] !== "undefined") {
    return <pre className="overflow-x-auto whitespace-pre-wrap rounded-card bg-space-1 p-3 text-xs leading-relaxed text-ink-2">{joinSrc(data["text/plain"] as string | string[])}</pre>;
  }
  return null;
}

// ── the full notebook ──

/** One code cell: outputs always visible, the code itself folded behind a quiet disclosure;
 *  published media the cell wrote to out/ plays right below its outputs. */
function CodeCell({ src, outputs, media, assets, open, onToggle }: {
  src: string; outputs: NbOutput[]; media: NbAssetRef[]; assets?: NbAssetRef[]; open: boolean; onToggle: () => void;
}) {
  const hasCode = src.trim().length > 0;
  return (
    <>
      {hasCode && (
        <div>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="-my-1 inline-flex items-center gap-1.5 py-1 text-[11px] uppercase tracking-wider text-ink-3 transition-colors hover:text-ink-2"
          >
            <span aria-hidden className={cx("inline-block transition-transform", open && "rotate-90")}>▸</span>
            {open ? "Hide code" : "Show code"}
          </button>
          {open && (
            <pre className="mt-1.5 overflow-x-auto rounded-card bg-space-1 p-3 text-xs leading-relaxed text-ink-2" data-ay-skip="1">
              <code>{src}</code>
            </pre>
          )}
        </div>
      )}
      {outputs.map((o, j) => <OutputView key={j} o={o} assets={assets} />)}
      {media.map((a) => <MediaOut key={a.url} asset={a} />)}
    </>
  );
}

// ── the environment the result was produced in (operator order 2026-07-26) ───
// Every submission carries its OWN requirements file, installed before the kernel starts, so the
// packages are part of the claim a published work makes — a figure produced under torch 2.6.0 is
// not the same evidence as one produced under 2.7. Show the file verbatim and make it copyable:
// a reader rebuilding the environment should be able to take the text as-is (`pip install -r`),
// never retype pins out of a screenshot.

const reqPins = (text: string) => text.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#")).length;

/** The work's requirements file, verbatim + copyable. An EMPTY file is not a gap — it is the
 *  strongest form of the claim (nothing beyond the base environment), so it still says so. */
export function NbRequirements({ requirements }: { requirements: string }) {
  const text = (requirements || "").replace(/\s+$/, "");
  const [copied, setCopied] = useState(false);
  const pins = text ? reqPins(text) : 0;
  return (
    <section className="flex flex-col gap-1.5 rounded-card border border-line bg-space-2 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="m-0 text-[11px] font-bold uppercase tracking-wider text-ink-3">The environment</h3>
        {/* the count lives in its own skipped span: baked into the sentence it would mint a fresh
            translation key per pin count and never resolve from the cache */}
        <span className="inline-flex items-baseline gap-1 text-xs text-ink-3">
          {pins ? (
            <>
              <code className="text-ink-2">requirements.txt</code>
              <span aria-hidden>—</span>
              <span className="tabular-nums" data-ay-skip="1">{pins}</span>
              <span>{pins === 1 ? "pinned package" : "pinned packages"}</span>
            </>
          ) : (
            <span>the base environment only</span>
          )}
        </span>
        {text ? (
          <button
            type="button"
            onClick={() => { navigator.clipboard?.writeText(`${text}\n`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }); }}
            className="ml-auto py-0.5 text-xs text-ink-3 transition-colors hover:text-ink-2"
            title="Copy the requirements file"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        ) : null}
      </div>
      {text ? (
        <pre className="overflow-x-auto rounded-card bg-space-1 p-3 text-xs leading-relaxed text-ink-2" data-ay-skip="1"><code>{text}</code></pre>
      ) : null}
      <p className="m-0 text-xs leading-relaxed text-ink-3">
        {text
          ? "Installed before the notebook ran, with the network off for every cell. Every version is pinned exactly, so this environment rebuilds the same way years from now."
          : "Nothing declared — this notebook ran on the base environment alone: Python with numpy, pandas, matplotlib and pillow, network off."}
      </p>
    </section>
  );
}

/** The requirements a notebook FILE carries itself (`metadata.aq.requirements`) — the fallback
 *  for a caller that renders an .ipynb without the work row beside it (an import, a copy from
 *  elsewhere). The work's own column is authoritative: pass it as the prop. */
function metaRequirements(ipynb: string): string {
  try {
    const m = (JSON.parse(ipynb) as { metadata?: { aq?: { requirements?: unknown } } }).metadata?.aq?.requirements;
    return typeof m === "string" ? m : "";
  } catch {
    return "";
  }
}

/** `codeOpen` is the page's master switch: false (default) folds every cell's code, true
 *  unfolds it all. Either way each cell keeps its own disclosure; flipping the master
 *  clears the per-cell overrides so the two never fight. `assets` (published deliverables)
 *  makes the media a cell wrote to out/ playable right below that cell. `requirements` is the
 *  work's requirements file: passing it (even as '') states the environment claim above the
 *  cells; omitting it leaves every existing call site rendering exactly as before. */
export function NbView({ ipynb, codeOpen, assets, requirements }: { ipynb: string; codeOpen?: boolean; assets?: NbAssetRef[]; requirements?: string }) {
  const cells = useMemo(() => parseNb(ipynb), [ipynb]);
  // memoised with the same care as parseNb: the fallback re-parses the whole notebook
  const env = useMemo(() => (typeof requirements === "string" ? requirements : metaRequirements(ipynb)), [requirements, ipynb]);
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  // Reset during render (not in an effect) so a flipped master never paints stale per-cell state.
  const [seen, setSeen] = useState({ ipynb, codeOpen });
  if (seen.ipynb !== ipynb || seen.codeOpen !== codeOpen) {
    setSeen({ ipynb, codeOpen });
    setOverrides({});
  }
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => watchMath(box.current, "auto"), [ipynb]);  // $…$ / $$…$$ typeset everywhere, i18n-safe
  if (!cells.length) return <p className="text-sm text-ink-3">This notebook has no readable cells.</p>;
  return (
    <div ref={box} className="flex flex-col gap-4">
      {typeof requirements === "string" || env ? <NbRequirements requirements={env} /> : null}
      {cells.map((c, i) => {
        if (c.cell_type === "markdown") {
          return (
            <div key={i} className="max-w-none text-[0.95rem] leading-relaxed text-ink [&_h1]:mt-2 [&_h1]:text-2xl [&_h2]:mt-2 [&_h2]:text-xl [&_h3]:text-lg">
              <MarkdownLite text={joinSrc(c.source)} />
            </div>
          );
        }
        if (c.cell_type !== "code") return null;
        const src = joinSrc(c.source);
        const outputs = c.outputs || [];
        if (!src.trim() && !outputs.length) return null;  // empty cell — nothing to say
        return (
          <div key={i} className="flex flex-col gap-2">
            <CodeCell
              src={src}
              outputs={outputs}
              media={cellMedia(c, assets)}
              assets={assets}
              open={overrides[i] ?? !!codeOpen}
              onToggle={() => setOverrides((m) => ({ ...m, [i]: !(m[i] ?? !!codeOpen) }))}
            />
          </div>
        );
      })}
    </div>
  );
}

// ── the feed card ──

const readTheme = (): "dark" | "light" =>
  document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";

/** The active dark/light theme, live. The contrast engine dispatches `aq:contrast` on every
 *  theme flip (applyTheme is always followed by applyContrast), so listening to that one event
 *  is enough — no MutationObserver (they fight React and pin WebKit). */
export function useAqTheme(): "dark" | "light" {
  const [theme, setTheme] = useState<"dark" | "light">(readTheme);
  useEffect(() => {
    const on = () => setTheme(readTheme());
    window.addEventListener("aq:contrast", on);
    return () => window.removeEventListener("aq:contrast", on);
  }, []);
  return theme;
}

/** The theme's teaser variant; either side of the pair covers a legacy single-teaser publish. */
export const teaserSrc = (nb: NotebookCard, theme: "dark" | "light") =>
  theme === "light" ? nb.teaser_light || nb.teaser : nb.teaser || nb.teaser_light;

// ── the Motion-calm gate (operator 2026-07-17) ───────────────────────────────
// The 5 calm stops map to thresholds DERIVED from the measured distribution's percentiles
// (served in pulse.calm_thresholds; Standard flags half of measured video content). A flagged
// work stays fully visible — its video just never autoplays (tap ▶ to play).

let CALM_T: number[] = [0, 0, 0, 0, 0];
let calmFetched = false;
function ensureThresholds(bump: () => void) {
  if (calmFetched) return;
  calmFetched = true;
  notebookPulse().then((p) => {
    if (Array.isArray(p.calm_thresholds) && p.calm_thresholds.length === 5) { CALM_T = p.calm_thresholds; bump(); }
  }).catch(() => { calmFetched = false; });
}

/** Is this work's video flagged (no autoplay) at the member's current calm stop? Live.
 *  Accepts a not-yet-loaded work (null) so a caller can keep this hook above its early returns
 *  — a page that loads its work asynchronously must still call it unconditionally. */
export function useCalmFlag(nb: NotebookCard | null | undefined): boolean {
  const [, setTick] = useState(0);
  useEffect(() => {
    ensureThresholds(() => setTick((t) => t + 1));
    const on = () => setTick((t) => t + 1);
    window.addEventListener("aq:calm", on);
    return () => window.removeEventListener("aq:calm", on);
  }, []);
  if (!nb?.calm_measured) return false;
  return nb.calm < (CALM_T[calmStop() - 1] ?? 0);
}

/** The shared no-autoplay teaser: flagged videos render paused with a ▶ overlay. */
export function TeaserVideo({ src, poster, flagged, className, onError }: {
  src: string; poster?: string; flagged: boolean; className: string; onError?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => { setPlaying(false); }, [src, flagged]);
  return (
    <span className="relative block h-full w-full">
      <video key={src + (flagged ? "-p" : "-a")} ref={ref} src={src} poster={poster}
        autoPlay={!flagged} muted loop playsInline aria-hidden={!flagged} onError={onError}
        className={className} />
      {flagged && !playing ? (
        <button
          type="button"
          aria-label="Play — this video's measured change rate is above your Motion-calm setting"
          title="Flagged by your Motion-calm setting — tap to play"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); ref.current?.play(); setPlaying(true); }}
          className="absolute inset-0 grid place-items-center"
        >
          <span className="grid h-11 w-11 place-items-center rounded-full border border-line bg-space-1/80 text-ink backdrop-blur">▶</span>
        </button>
      ) : null}
    </span>
  );
}

/** `to` overrides the card's destination: the author's own Studio grid points at the Studio room
 *  (`/studio/nb/:id`), because on a phone the card IS the tap target and a draft's public page is
 *  the wrong place to land. Everywhere else it keeps pointing at the public work. */
export function NbCard({ nb, to, badge }: { nb: NotebookCard; to?: string; badge?: ReactNode }) {
  const meta = NB_KIND_META[normalizeNbKind(nb.kind)];
  const theme = useAqTheme();
  const flagged = useCalmFlag(nb);
  const src = teaserSrc(nb, theme);
  const [teaserOk, setTeaserOk] = useState(true); // VP9-alpha unsupported / file gone → legacy thumb
  const teaser = src && teaserOk;
  return (
    <li className="list-none">
      <Link to={to || `/nb/${nb.id}/${nb.slug}`} className="group flex h-full flex-col overflow-hidden rounded-card border border-line bg-space-2 transition-colors hover:border-yin-ink">
        <div className={cx("aspect-[16/10] w-full overflow-hidden", teaser ? "" : "bg-space-1")}>
          {teaser ? (
            /* the standard teaser: transparent background, so no card backdrop behind it;
               flagged by the Motion-calm gate → paused with a ▶ (never autoplays) */
            <TeaserVideo src={src} poster={nb.thumb || undefined} flagged={flagged} onError={() => setTeaserOk(false)}
              className={cx("h-full w-full object-contain", !flagged && "pointer-events-none")} />
          ) : nb.thumb ? (
            <img src={nb.thumb} alt="" loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]" />
          ) : nb.hero ? (
            /* THE WORK ITSELF. teaser/thumb came from the retired execution relay and nothing
               writes them now, so without this every profile and catalogue card was a grey box
               with its own kind's name in it — the same defect already fixed on the feed card. */
            <LibraryMedia item={nb.hero} className="h-full w-full" still />
          ) : (
            <div className="grid h-full w-full place-items-center text-xs uppercase tracking-widest text-ink-3">{meta?.label || nb.kind}</div>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-1.5 p-3">
          <div className="flex items-center gap-2 text-[0.7rem] uppercase tracking-wider text-ink-3">
            <span>{meta?.label || nb.kind}</span>
            {badge}
            {nb.doi_link ? <Chip>DOI</Chip> : null}
            {/* the measured change-rate score — published with every work that carries video */}
            {nb.calm < 100 ? <span title="Measured change rate — higher is calmer (slower change)"><Chip>Calm {nb.calm}</Chip></span> : null}
          </div>
          <h3 className="line-clamp-2 text-sm font-semibold text-ink">{nb.title}</h3>
          {nb.abstract ? <p className="line-clamp-2 text-xs leading-relaxed text-ink-3">{nb.abstract}</p> : null}
          <div className="mt-auto flex items-center gap-2 pt-1 text-xs text-ink-3">
            <Avatar name={nb.author.name} src={nb.author.avatar} className="h-[18px] w-[18px] text-[9px]" />
            <span className={cx("min-w-0", nameClass(nb.author.name, 12))}>{nb.author.name}</span>
            <span className="ml-auto inline-flex items-center gap-1"><HeartGlyph size={13} /> {nb.hearts}</span>
          </div>
        </div>
      </Link>
    </li>
  );
}
