/**
 * The Library kit — one artifact renderer, one card, one picker.
 *
 * A Library item is a single file that came out of a public Kaggle notebook once that notebook
 * cleared the reproducibility checklist. Ownership is deliberately NOT required to re-use one:
 * any member can attach any item to their own post, and provenance travels with it — the work it
 * came out of, the member who authored that work, the notebook on Kaggle, and its permanent link.
 *
 * Four exports, used by the browse page (/library), the feed cards and the composer:
 *   LibraryMedia  — the artifact itself, sized entirely by its container.
 *   SceneMedia    — a VECTOR work (scene.svg + its twins), in an <img> and never inline.
 *   LibraryCard   — the artifact + its name, size and provenance; selectable when `onPick` is set.
 *   LibraryPicker — the modal that chooses up to `max` items and hands them back.
 */
/* eslint-disable react-refresh/only-export-components -- domain module, like ui.tsx and nbview.tsx:
   by design it exports the Library COMPONENTS and the vocabulary/helpers they are drawn from (the
   class labels, the byte formatter), in one place, so the card, the picker and the composer can
   never disagree about what a file is called or how big it is. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { libraryItems, type LibraryItem } from "../lib/api";
import { listItems, saveFromUrl } from "../lib/media-store";
import { useMotionOff } from "../lib/theme";
import AudioPlayer from "./audio-player";
import {
  Avatar, Button, Card, Chip, EmptyState, IconButton, LoadMoreButton,
  SearchPill, SkeletonGrid, StatusNote, cx,
} from "./ui";

export type { LibraryItem };

/* ───────────────────────── literals ───────────────────────── */

/** Human file size. Always a bare literal — render it inside `data-ay-skip="1"`. */
export function prettyBytes(n: number): string {
  const v0 = Number(n);
  if (!Number.isFinite(v0) || v0 <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = v0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  const decimals = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(decimals)} ${units[i]}`;
}

/** The file's extension, for the typed tile. Falls back to the mime subtype. */
function fileExt(item: LibraryItem): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(item.label || item.name || "");
  if (m) return m[1].toUpperCase();
  const sub = (item.mime || "").split("/")[1] || "";
  return (sub.split(/[.+]/).pop() || "FILE").toUpperCase();
}

/* ───────────────────────── classes ───────────────────────── */

// Category labels are SINGULAR, matching every other shelf on the platform.
const CLASS_LABEL: Record<LibraryItem["class"], string> = {
  scene: "Drawing",   audio: "Audio",   image: "Image",   video: "Video",   model3d: "3D model",
  data: "Data",
  weights: "Weights",
  doc: "Document",
  notebook: "Notebook",
};

/** The filter row shared by the browse page and the picker. An empty key means no filter. */
export const LIBRARY_CLASSES: Array<{ key: string; label: string }> = [
  { key: "", label: "Everything" },
  { key: "scene", label: CLASS_LABEL.scene },
  { key: "image", label: CLASS_LABEL.image },
  { key: "audio", label: CLASS_LABEL.audio },
  { key: "video", label: CLASS_LABEL.video },
  { key: "model3d", label: CLASS_LABEL.model3d },
  { key: "data", label: CLASS_LABEL.data },
  { key: "weights", label: CLASS_LABEL.weights },
  { key: "doc", label: CLASS_LABEL.doc },
  { key: "notebook", label: CLASS_LABEL.notebook },
];

export function libraryClassLabel(cls: LibraryItem["class"] | string): string {
  return CLASS_LABEL[cls as LibraryItem["class"]] || String(cls);
}

/* ───────────────────────── glyphs ───────────────────────── */

const SVG = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

function ClassGlyph({ cls, size = 22 }: { cls: LibraryItem["class"]; size?: number }) {
  const p = { ...SVG, width: size, height: size } as const;
  switch (cls) {
    case "scene": return <svg {...p}><path d="M12 3.5 20.5 12 12 20.5 3.5 12 12 3.5Z" /><circle cx="12" cy="12" r="3.5" /></svg>;
    case "audio": return <svg {...p}><path d="M4 13v-2M8 16V8M12 19V5M16 16V8M20 13v-2" /></svg>;
    case "video": return <svg {...p}><rect x="3" y="5" width="14" height="14" rx="2.5" /><path d="m17 10 4-2.5v9L17 14" /></svg>;
    case "image": return <svg {...p}><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="9" cy="9.5" r="1.6" /><path d="m4 17 4.5-4.5 4 3.5 3-2.5L20 17" /></svg>;
    case "model3d": return <svg {...p}><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m12 12 8-4.5M12 12v9M12 12 4 7.5" /></svg>;
    case "data": return <svg {...p}><ellipse cx="12" cy="6" rx="7.5" ry="3" /><path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" /></svg>;
    case "weights": return <svg {...p}><circle cx="12" cy="12" r="3" /><circle cx="5" cy="6" r="2" /><circle cx="5" cy="18" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="19" cy="18" r="2" /><path d="m7 7 2.5 3M7 17l2.5-3M17 7l-2.5 3M17 17l-2.5-3" /></svg>;
    case "notebook": return <svg {...p}><rect x="5" y="3" width="14" height="18" rx="2.5" /><path d="M9 3v18M12 8h4M12 12h4" /></svg>;
    default: return <svg {...p}><path d="M14 3v5h5" /><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /></svg>;
  }
}

function CheckGlyph({ size = 13 }: { size?: number }) {
  return <svg {...SVG} strokeWidth={3} width={size} height={size}><path d="m5 12.5 4.5 4.5L19 7" /></svg>;
}

function PlayGlyph({ size = 22 }: { size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden><path d="M8 5.5v13l11-6.5-11-6.5Z" /></svg>;
}

/* ───────────────────────── LibraryMedia ───────────────────────── */

// No width, height or radius of its own: the caller owns the box (an aspect wrapper on the browse
// grid, a 64px square in the composer), so the same renderer works at every size and can never
// push its container sideways — `overflow-hidden` plus `max-w-full` on the media element.
const BOX = "@container relative flex min-w-0 items-center justify-center overflow-hidden bg-space-3 text-ink-3";
const FILL = "h-full max-h-full w-full max-w-full object-contain";

/* ───────────────────────── scenes (vector works) ───────────────────────── */

/**
 * A SCENE — a work whose deliverable is an ANIMATED SVG instead of a video (operator 2026-07-30).
 *
 * Measured that day: a 1080px-wide video shown in a ~430px feed card thins the illusion's 9px
 * hairline to 3.6px and loses 58% of the direction signal the effect depends on. The codec costs
 * about 3% of that — the damage is DISPLAY SCALING, so no encode setting can fix it, because the
 * same card is 430px on one device and 1290px on another. A vector's
 * `vector-effect="non-scaling-stroke"` holds the hairline at a CONSTANT width at every card size
 * and every devicePixelRatio (10px at 430@1x, 430@2x, 430@3x, 600 and 1080, where a normal stroke
 * collapses to 4px), matches the notebook's computed ground truth to 2/255 across 25 probes, and
 * costs 14.9 KB against the 599 KB webm it replaces.
 *
 * IT MUST STAY IN AN <img>. Scripts inside an <img>-embedded SVG DO NOT EXECUTE — verified in
 * Chrome across five configurations, and that is the whole security argument: the bytes are
 * attacker-influenced (any member may submit any public kernel, and its author wrote the file).
 * So never an inline <svg>, which would run them against our own origin, and never an <iframe> or
 * an <object> — <img> safety does not extend to a TOP-LEVEL DOCUMENT, and a published file always
 * has a direct URL somebody can open. That case is covered on the SERVER instead: `Media` admits
 * svg to the origin only when the bytes ARE `Svg::clean()`'s own output (`ORIGIN_SERVABLE_SANITISED`),
 * so the file has no script to run whichever way it is opened. Do not weaken either half — this
 * <img> rule and that server rule are one argument, and the reason they are written in both places
 * is that the last person to read only one of them drew the wrong conclusion. Never a <video>
 * either: replacing the video is the entire point.
 *
 * A scene work publishes ONE picture as three files, and they are used strictly in this order:
 *   scene.svg   the work itself, animated
 *   loop.webp   a lossless animated raster twin (45 KB) — OG cards, RSS, download
 *   poster.png  the first frame — the still we swap in for reduced motion and off-screen cards
 */

const SCENE_LOOP = "loop.webp";
const SCENE_POSTER = "poster.png";

/** The file's own name, without the `out/` prefix the notebook wrote it under. */
const baseName = (item: LibraryItem) => ((item.label || item.name || "").split("/").pop() || "").toLowerCase();

/** The vector deliverable itself. ANY published .svg counts: the motion and inlining rules above
 *  are about what a browser does with the bytes, not about what the file is called. */
export const isScene = (item: LibraryItem) =>
  item.mime === "image/svg+xml" || /\.svg$/i.test(item.label || item.name || "");

/** One of the three faces of the same picture — the only files SceneMedia ever renders. */
const sceneFace = (item: LibraryItem) => isScene(item) || baseName(item) === SCENE_LOOP || baseName(item) === SCENE_POSTER;

export type SceneSet = { scene: LibraryItem; loop?: LibraryItem; poster?: LibraryItem };

/**
 * The scene set inside a list of published files, or null when the work published no vector.
 *
 * A caller holding the whole work (`nb.files`) gets all three; a feed card holds exactly ONE
 * published file — the hero — so it gets a set of one, and every branch below copes with the
 * twins being absent.
 */
export function sceneSet(
  files: LibraryItem[] | null | undefined,
  /** The scene this set is FOR. Without it the first vector in the list wins, which silently
   *  renders figure one in place of figure two on a work that published two drawings. */
  want?: LibraryItem | null,
): SceneSet | null {
  const list = files || [];
  const scene = want && isScene(want) ? want : list.find(isScene);
  if (!scene) return null;
  const named = (n: string) => list.find((f) => baseName(f) === n);
  return { scene, loop: named(SCENE_LOOP), poster: named(SCENE_POSTER) };
}

/**
 * The work's files with a scene's TWINS folded away — the same picture in another format is not
 * another deliverable, and three figures of one picture (two of them animating) is not what the
 * author published. The scene keeps its place in the list; the list is returned untouched when
 * the work published no vector. Nothing is hidden by this: every file stays listed, sized and
 * downloadable in the work's Published files panel.
 */
export function foldScene(files: LibraryItem[]): LibraryItem[] {
  const set = sceneSet(files);
  if (!set) return files;
  const twins = [set.loop?.id, set.poster?.id].filter((id) => typeof id === "number");
  return files.filter((f) => !twins.includes(f.id));
}


/**
 * The scene, in an <img>.
 *
 * `still` is the caller's inert-preview flag (the picker), and motion is suppressed on top of that
 * by the member's reduce-motion / Motion-calm setting and while the card is off the screen — a
 * timeline of scenes must not animate a hundred pictures nobody is looking at.
 */
export function SceneMedia({ set, className, still }: {
  set: SceneSet; className?: string; still?: boolean;
}) {
  const box = useRef<HTMLSpanElement>(null);
  // Start visible: a browser without IntersectionObserver, or a card that unmounts before the
  // first callback, must still show the work. The one root <span> below never changes identity,
  // so the observer can never end up watching a node React has thrown away.
  const [onScreen, setOnScreen] = useState(true);
  const [step, setStep] = useState(0);  // how far down the source chain a load failure has pushed us
  const motionOff = useMotionOff();

  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver !== "function") return;
    const io = new IntersectionObserver((es) => setOnScreen(es.some((e) => e.isIntersecting)), { rootMargin: "200px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const alt = set.scene.label || set.scene.name;
  const hold = !!still || motionOff || !onScreen;  // do not animate right now
  // `still` is a PROMISE the caller made to its own reader — a picker tile and a catalogue card
  // say they are inert — so it may never fall through to the animated source, even when the work
  // published no poster to substitute. Reduced motion and off-screen are different: the scene's
  // own media query already stops it for the first, and the second only asks us not to waste work
  // on a card nobody is looking at, so an animated fallback there is a nuisance, not a broken
  // promise. Without this split, every picker tile of a poster-less scene animated.
  const neverAnimate = !!still;

  // Best first. <picture> chooses on FORMAT SUPPORT alone, so it cannot cover a source that simply
  // fails to LOAD, and any of these can 404 or be blocked. `step` is that second cascade: an <img>
  // error drops the head of the chain and the browser re-selects from what is left.
  const chain = [
    { url: set.scene.url, type: "image/svg+xml" },
    ...(set.loop ? [{ url: set.loop.url, type: "image/webp" }] : []),
    ...(set.poster ? [{ url: set.poster.url, type: "image/png" }] : []),
  ].slice(step);

  let body: ReactNode = null;
  let tile = false;
  if (hold && set.poster) {
    // Reduced motion, an inert picker tile, or off the screen — the published first frame.
    body = <img src={set.poster.url} alt={alt} loading="lazy" decoding="async" className={FILL} />;
  } else if (hold && !onScreen) {
    // Nothing still to swap to and nobody looking: hold the box empty. That IS the pause — an
    // <img> cannot be told to stop animating, only to stop being an animation.
  } else if (neverAnimate) {
    // Asked for inert, with no poster published to be inert WITH. The typed tile is the honest
    // answer; animating here would quietly break the caller's promise to its reader.
    tile = true;
    body = <FileTileBody item={set.scene} />;
  } else if (chain.length) {
    // On screen and free to move — or suppressed with no still twin published, where there is
    // nothing to substitute and the file's own reduced-motion block is the only line left. That
    // gap is exactly why poster.png is part of the published set.
    body = (
      <picture key={step} className="contents">
        {chain.slice(0, -1).map((s) => <source key={s.url} srcSet={s.url} type={s.type} />)}
        <img
          src={chain[chain.length - 1].url}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => setStep((n) => n + 1)}
          className={FILL}
        />
      </picture>
    );
  } else {
    // Every source failed — the same typed tile any unrenderable file gets.
    tile = true;
    body = <FileTileBody item={set.scene} />;
  }

  return <span ref={box} className={cx(BOX, className, tile && "flex-col gap-1 p-2 text-center")}>{body}</span>;
}

/**
 * Audio — our own transport plus a live FFT spectrum (audio-player.tsx), never the browser's grey
 * `<audio controls>` bar. A component of its own rather than a branch inside LibraryMedia, because
 * the motion decision is read with a HOOK and LibraryMedia returns early several times above the
 * audio branch — a hook down there would run conditionally.
 */
function AudioTile({ item, className }: { item: LibraryItem; className?: string }) {
  const motionOff = useMotionOff();
  // Deliberately NOT wrapped in BOX. The player already carries the border, the surface and the
  // padding, and nesting it inside the generic tile stacked three panels of slightly different
  // greys around one transport bar.
  return <AudioPlayer src={item.url} motionOff={motionOff} className={cx("min-w-0", className)} />;
}

/** The neutral typed tile — glyph, extension, size. Contents only: the caller owns the box. */
function FileTileBody({ item }: { item: LibraryItem }) {
  return (
    <>
      <span aria-hidden className="text-ink-2"><ClassGlyph cls={item.class} /></span>
      <span data-ay-skip="1" className="max-w-full truncate text-[12px] font-bold tracking-wide text-ink-2">{fileExt(item)}</span>
      {/* In a thumbnail-sized box (the composer's 64px chip) the size line has nowhere to go.
          Stated as a hide-when-small rule so a browser without container queries keeps it. */}
      <span data-ay-skip="1" className="max-w-full truncate text-[11px] text-ink-3 @max-[7rem]:hidden">{prettyBytes(item.bytes)}</span>
    </>
  );
}

/**
 * The artifact itself, by class.
 *
 * `still` renders an INERT preview instead of a live one. The picker needs it because media
 * controls inside a selectable tile are a control inside a control (and swallow the tap that
 * selects it) — but it matters far more than that now: without it a 64px composer chip mounted a
 * script-running iframe, a PDF viewer, or a ranged network fetch, four at a time, for files the
 * member has merely ticked. Every heavy branch below is gated on `!still`.
 *
 * `files` is the work's OTHER published files, when the caller holds them. A scene's fallback
 * chain and its reduced-motion still are made of those twins, so the work page passes `nb.files`
 * and a feed card — which carries only its hero — passes nothing and renders the vector alone.
 */
export function LibraryMedia({ item, className, still, files }: {
  item: LibraryItem; className?: string; still?: boolean; files?: LibraryItem[];
}) {
  const box = cx(BOX, className);

  // A SCENE — the work as an animated SVG, in an <img> and never inlined (see SceneMedia). It is
  // checked before the image branch because a scene's TWINS (loop.webp, poster.png) are class
  // `image` even though the scene itself is class `scene`, and whichever face the caller happens to
  // hold must render the one picture, once. sceneFace() keys off mime and filename rather than
  // class, so it kept working unchanged when svg became its own class (Kernel::TYPES, 2026-07-30).
  const scene = sceneFace(item) ? sceneSet(files?.length ? files : [item], item) : null;
  if (scene) return <SceneMedia set={scene} className={className} still={still} />;

  if (item.class === "image") {
    return (
      <span className={box}>
        <img src={item.url} alt={item.label || item.name} loading="lazy" decoding="async" className={FILL} />
      </span>
    );
  }

  if (item.class === "video") {
    return (
      <span className={box}>
        <video
          src={item.url}
          preload="metadata"
          playsInline
          {...(still ? { muted: true, tabIndex: -1 } : { controls: true })}
          className={FILL}
        />
        {still ? (
          <span aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center text-ink">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-space-1/70 ps-0.5"><PlayGlyph size={18} /></span>
          </span>
        ) : null}
      </span>
    );
  }

  if (item.class === "audio" && !still) return <AudioTile item={item} className={className} />;

  const ext = fileExt(item).toLowerCase();

  // HTML — a 2D/3D GAME, or an interactive article. This is the whole point of those two kinds, and
  // without it a published game rendered as a grey tile saying "HTML". Sandboxed exactly as the
  // confirm page sandboxes it: scripts may run, but they get no access to our origin.
  if (ext === "html" && !still) {
    return (
      <span className={cx(box, "block")}>
        <iframe
          src={item.url}
          title={item.label || item.name}
          loading="lazy"
          sandbox="allow-scripts allow-pointer-lock"
          className="h-full w-full border-0 bg-space-1"
        />
      </span>
    );
  }

  // PDF — the browser's own viewer, in an IFRAME rather than an <object>: the platform's CSP sets
  // `object-src 'none'` and that is a default worth keeping, so the PDF branch would simply never
  // have rendered. frame-src names the media CDN, so an iframe works without weakening anything.
  if (ext === "pdf" && !still) {
    return (
      <span className={cx(box, "block")}>
        <iframe src={item.url} title={item.label || item.name} loading="lazy" className="h-full w-full border-0 bg-space-1" />
      </span>
    );
  }

  // Text the browser can simply show: markdown, plain text, and small data files. Fetched with a
  // hard byte ceiling — a 500 MB CSV must never be pulled into a feed card.
  if (!still && ["md", "txt", "csv", "json", "jsonl", "ndjson"].includes(ext)) {
    return <TextPreview item={item} className={className} />;
  }

  // Everything else (3D meshes, weights, notebooks, and a still audio thumb): a typed file tile.
  return <span className={cx(box, "flex-col gap-1 p-2 text-center")}><FileTileBody item={item} /></span>;
}

/** Never pull more than this into a card — some published data files are hundreds of megabytes. */
const PREVIEW_BYTES = 64 * 1024;

/**
 * Text and tabular files, shown rather than described.
 *
 * A dataset is one of the eleven kinds, so "data" cannot be a grey tile with the word CSV on it.
 * Small files render inline; a large one shows its head and says so. CSV becomes a real table,
 * because a table is the thing a reader came to look at.
 */
function TextPreview({ item, className }: { item: LibraryItem; className?: string }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const ext = fileExt(item).toLowerCase();
  const truncated = item.bytes > PREVIEW_BYTES;

  useEffect(() => {
    let live = true;
    fetch(item.url, truncated ? { headers: { Range: `bytes=0-${PREVIEW_BYTES}` } } : undefined)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => { if (live) setText(t); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [item.url, truncated]);

  const rows = useMemo<string[][] | null>(() => {
    if (ext !== "csv" || !text) return null;
    return text.split(/\r?\n/).filter(Boolean).slice(0, 12).map((r) => r.split(","));
  }, [ext, text]);

  if (failed) {
    return (
      <span className={cx(BOX, className, "flex-col gap-1 p-2 text-center")}>
        <span aria-hidden className="text-ink-2"><ClassGlyph cls={item.class} /></span>
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="inline-block py-1 text-[12px] text-yin-ink hover:underline">Open the file</a>
      </span>
    );
  }
  if (text === null) {
    return <span className={cx(BOX, className)} aria-busy="true"><span className="h-full w-full animate-pulse bg-veil/[0.06]" /></span>;
  }
  return (
    <span className={cx(BOX, className, "block overflow-auto bg-space-1 text-start")}>
      {rows ? (
        <table className="w-full border-collapse text-[11.5px]">
          <tbody>
            {rows.map((cells, i) => (
              <tr key={i} className={i === 0 ? "bg-space-3 font-semibold text-ink-2" : "text-ink-3"}>
                {cells.slice(0, 8).map((c, j) => (
                  <td key={j} className="max-w-[12ch] truncate border border-line/60 px-1.5 py-0.5" data-ay-skip="1">{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <pre className="whitespace-pre-wrap break-words p-2 font-mono text-[11.5px] leading-relaxed text-ink-3" data-ay-skip="1">
          {text.slice(0, 4000)}
        </pre>
      )}
      {truncated ? <span className="block px-2 pb-1.5 text-[11px] text-ink-3">Preview of the first part — download for the whole file.</span> : null}
    </span>
  );
}

/* ───────────────────────── provenance ───────────────────────── */

/**
 * Where the file came from — the work, its author, the notebook on Kaggle and its permanent link.
 * `links` is off inside a selectable tile, where a link would be nested inside a button.
 */
function Provenance({ work, links, compact }: {
  work: NonNullable<LibraryItem["work"]>; links: boolean; compact?: boolean;
}) {
  const dot = <span aria-hidden className="text-ink-3">·</span>;
  const title = <span data-ay-skip="1">{work.title}</span>;
  const name = <span data-ay-skip="1" className="truncate">{work.author.name}</span>;
  return (
    /* Measured on /library: each of these four links was 17px tall, and on a phone they sit a
       couple of millimetres apart separated by a dot — four crowded targets in one line. The
       anchors get a vertical pad so each clears 24px; the type size and the line's density are
       untouched, because this is a provenance run and it should still read as one. */
    <span className={cx("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-3 [&_a]:py-1",
      !compact && "mt-auto w-full border-t border-line pt-2")}>
      {links ? (
        <Link to={`/nb/${work.id}/${work.slug}`} className="min-w-0 max-w-full truncate font-semibold text-ink-2 no-underline hover:underline">{title}</Link>
      ) : (
        <span className="min-w-0 max-w-full truncate font-semibold text-ink-2">{title}</span>
      )}
      {dot}
      {links ? (
        <Link to={`/u/${work.author.slug}`} className="inline-flex min-w-0 max-w-full items-center gap-1 no-underline text-ink-3 hover:underline">
          <Avatar src={work.author.avatar} name={work.author.name} className="h-4 w-4 text-[9px]" />
          {name}
        </Link>
      ) : (
        <span className="inline-flex min-w-0 max-w-full items-center gap-1">
          <Avatar src={work.author.avatar} name={work.author.name} className="h-4 w-4 text-[9px]" />
          {name}
        </span>
      )}
      {links && work.kernel ? (
        <>
          {dot}
          <a href={work.kernel} target="_blank" rel="noopener noreferrer" className="font-semibold text-yin-ink hover:underline">Kaggle notebook</a>
        </>
      ) : null}
      {links && work.doi ? (
        <>
          {dot}
          {/* The permanent short link — a server route, so a plain full-load anchor. */}
          <a href={`/d/n${work.id}`} className="rounded px-1.5 font-semibold text-yin-ink hover:underline" title="The permanent citation for this work"><span data-ay-skip="1">DOI</span></a>
        </>
      ) : null}
    </span>
  );
}

/* ───────────────────────── LibraryCard ───────────────────────── */

/**
 * One Library item. Default: a card with the artifact on top. `compact`: a row with a small thumb,
 * which is what stays readable in a single column at 360px. `onPick` turns the whole card into a
 * selectable tile (a real button, `aria-pressed`) — links are dropped there, so nothing inside the
 * tile competes with the tap that selects it.
 */
export function LibraryCard({ item, onPick, picked, compact }: {
  item: LibraryItem;
  onPick?: (item: LibraryItem) => void;
  picked?: boolean;
  compact?: boolean;
}) {
  const picking = !!onPick;
  const thumb = (
    <span className={cx("block shrink-0 overflow-hidden rounded-field bg-space-3",
      compact ? "h-16 w-16" : "aspect-[4/3] w-full")}>
      <LibraryMedia item={item} className="h-full w-full" still={picking} />
    </span>
  );
  const head = (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span data-ay-skip="1" className="truncate text-[13.5px] font-semibold text-ink">{item.label || item.name}</span>
      <span className="flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-ink-3">
        <span>{libraryClassLabel(item.class)}</span>
        <span aria-hidden>·</span>
        <span data-ay-skip="1">{prettyBytes(item.bytes)}</span>
      </span>
    </span>
  );
  const prov = item.work ? <Provenance work={item.work} links={!picking} compact={compact} /> : null;

  if (onPick) {
    return (
      <button
        type="button"
        aria-pressed={!!picked}
        onClick={() => onPick(item)}
        className={cx("relative flex w-full min-w-0 rounded-card border p-2 text-start transition-colors",
          compact ? "items-center gap-3" : "flex-col gap-2",
          picked ? "border-yin bg-yin/10" : "border-line bg-space-2 hover:border-yin-ink/60")}
      >
        {thumb}
        <span className="flex min-w-0 flex-1 flex-col gap-1">{head}{prov}</span>
        <span aria-hidden className={cx("grid h-6 w-6 shrink-0 place-items-center rounded-full border",
          compact ? "ms-auto" : "absolute end-3 top-3",
          picked ? "border-yin bg-yin text-on-accent" : "border-line bg-space-1/80 text-ink-3")}>
          {picked ? <CheckGlyph /> : null}
        </span>
      </button>
    );
  }

  return (
    <Card className={cx("flex h-full min-w-0", compact ? "items-center gap-3 p-2" : "flex-col gap-2.5 p-3")}>
      {thumb}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {head}{prov}
        <SaveOffline item={item} />
      </div>
    </Card>
  );
}

/**
 * TAKE IT WITH YOU.
 *
 * A Library track streams from a cross-origin CDN, which is no use on a run with the phone in a
 * pocket and no signal. This downloads the file into the member's own device library (IndexedDB —
 * never OPFS, which fails silently on iOS), where it becomes an ordinary MediaItem: it plays with
 * the screen off, drives the lock-screen controls through the MediaSession the player already
 * registers, and needs no network at all.
 *
 * Only music and video are offered — a CSV has nothing to play, and the file is downloadable from
 * its own link anyway.
 */
export function SaveOffline({ item }: { item: LibraryItem }) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [pct, setPct] = useState(0);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let live = true;
    listItems().then((rows) => {
      if (live && rows.some((r) => r.name === libFileName(item))) setState("saved");
    }).catch(() => {});
    return () => { live = false; };
  }, [item]);

  // What the device store can actually hold and play back (media-store's kindOf: music, video,
  // doc-as-PDF). The `doc` class also covers md/txt/html, which it cannot — so check the extension
  // rather than the class, or a member gets a Save button that always fails.
  const savable =
    item.class === "audio" || item.class === "video" ||
    (item.class === "doc" && /\.pdf$/i.test(item.label || item.name || ""));
  if (!savable) return null;

  const save = () => {
    setState("saving"); setPct(0); setMsg("");
    saveFromUrl(item.url, libFileName(item), {
      title: item.work?.title || item.label,
      artist: item.work?.author?.name,
    }, (got, total) => setPct(total ? Math.min(100, Math.round((got / total) * 100)) : 0))
      .then((r) => {
        if (r.added.length) { setState("saved"); return; }
        setState("error");
        setMsg(r.failed[0]?.reason || "could not be saved");
      })
      .catch(() => { setState("error"); setMsg("could not be saved"); });
  };

  if (state === "saved") {
    return (
      <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-yang-ink">
        <CheckGlyph size={12} /> On this device
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <button
        type="button"
        onClick={save}
        disabled={state === "saving"}
        className="inline-flex min-h-8 items-center gap-1.5 self-start rounded-pill border border-line px-2.5 text-[12px] font-semibold text-ink-2 transition-colors hover:border-yin-ink hover:text-ink disabled:opacity-60"
      >
        {state === "saving"
          ? <>Saving <span data-ay-skip="1">{pct}%</span></>
          : <>Save offline</>}
      </button>
      {state === "error" && msg !== "" ? (
        <span role="alert" className="text-[11.5px] text-yin-ink" data-ay-skip="1">{msg}</span>
      ) : null}
    </span>
  );
}

/** A published path is `out/track.wav`; the device library wants a plain, unique file name. */
function libFileName(item: LibraryItem): string {
  const base = (item.label || item.name).split("/").pop() || "track";
  return `${item.id}-${base}`;
}

/* ───────────────────────── LibraryPicker ───────────────────────── */

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])';

/**
 * The modal that attaches Library items to a post. Traps focus, closes on Escape and on a backdrop
 * click, hands focus back to whatever opened it, and is one column on a phone.
 */
export function LibraryPicker({ open, onClose, onConfirm, max = 4 }: {
  open: boolean;
  onClose: () => void;
  onConfirm: (items: LibraryItem[]) => void;
  max?: number;
}) {
  const cap = Math.max(0, Math.floor(Number.isFinite(max) ? max : 0));
  const panel = useRef<HTMLDivElement>(null);
  // Callers pass an inline `onClose`, so its identity changes on every parent render. The focus
  // trap must not re-run for that — its cleanup hands focus back to the opener, which would yank
  // the caret out of the search field mid-word. Read it through a ref; depend only on `open`.
  const closeRef = useRef(onClose);
  const [q, setQ] = useState("");
  const [cls, setCls] = useState("");
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<LibraryItem[]>([]);

  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  // Each opening starts clean — a picker that remembers last time's ticks attaches by accident.
  useEffect(() => {
    if (!open) return;
    setSel([]); setQ(""); setCls("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setItems(null); setErr("");
    const term = q.trim();
    const h = setTimeout(() => {
      libraryItems({ ...(cls ? { class: cls } : {}), ...(term ? { q: term } : {}) })
        .then((p) => { if (live) { setItems(p.items); setNext(p.next); } })
        .catch(() => { if (live) { setItems([]); setNext(null); setErr("The Library could not load — try again shortly."); } });
    }, term ? 250 : 0);
    return () => { live = false; clearTimeout(h); };
  }, [open, q, cls]);

  // Focus management: focus the panel, trap Tab inside it, hand focus back on close, lock the
  // page behind it. Escape always leaves.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); closeRef.current(); return; }
      if (e.key !== "Tab" || !panel.current) return;
      const nodes = panel.current.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prev;
      opener?.focus?.();
    };
  }, [open]);

  const loadMore = useCallback(async () => {
    if (next == null) return;
    setMore(true);
    try {
      const term = q.trim();
      const p = await libraryItems({ ...(cls ? { class: cls } : {}), ...(term ? { q: term } : {}), cursor: next });
      setItems((cur) => [...(cur ?? []), ...p.items]);
      setNext(p.next);
    } catch {
      setErr("The Library could not load — try again shortly.");
    } finally {
      setMore(false);
    }
  }, [next, q, cls]);

  if (!open) return null;

  const full = sel.length >= cap;
  const toggle = (it: LibraryItem) => setSel((cur) => {
    if (cur.some((x) => x.id === it.id)) return cur.filter((x) => x.id !== it.id);
    return cur.length >= cap ? cur : [...cur, it];
  });

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-space-1/80 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Attach from the Library"
        className="flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-card border border-line bg-space-1 shadow-pop outline-none sm:max-h-[86dvh] sm:rounded-card"
      >
        <header className="flex items-start gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-bold tracking-tight text-ink">Attach from the Library</h2>
            <p className="mt-0.5 text-[12.5px] leading-snug text-ink-2">
              Every file here came out of a public Kaggle notebook. Attach any of them — you do not need to own it, and its work, author and links travel with it.
            </p>
          </div>
          <IconButton label="Close" onClick={onClose} className="h-9 w-9 shrink-0">
            <svg {...SVG} strokeWidth={2} width={16} height={16}><path d="M6 6l12 12M18 6 6 18" /></svg>
          </IconButton>
        </header>

        <div className="flex flex-col gap-2 border-b border-line px-4 py-3">
          <SearchPill placeholder="Search by file name" value={q} onChange={setQ} />
          <div className="-mx-1 flex flex-wrap gap-1.5 px-1">
            {LIBRARY_CLASSES.map((c) => (
              <Chip key={c.key || "all"} active={cls === c.key} onClick={() => setCls(c.key)}>{c.label}</Chip>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {cap === 0 ? (
            <StatusNote>You have attached as many files as a post can carry.</StatusNote>
          ) : err && items && items.length === 0 ? (
            <StatusNote error>{err}</StatusNote>
          ) : items === null ? (
            <SkeletonGrid count={4} />
          ) : items.length === 0 ? (
            <EmptyState
              title="Nothing here yet"
              body="No published file matches that. Try another word, or clear the filter."
            />
          ) : (
            <>
              {err ? <StatusNote error>{err}</StatusNote> : null}
              <ul className="grid list-none grid-cols-1 gap-2 sm:grid-cols-2">
                {items.map((it) => (
                  <li key={it.id} className="min-w-0">
                    <LibraryCard item={it} compact picked={sel.some((x) => x.id === it.id)} onPick={toggle} />
                  </li>
                ))}
              </ul>
              {next != null ? <LoadMoreButton onClick={loadMore} loading={more} /> : null}
            </>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
          <p className="min-w-0 flex-1 text-[12.5px] text-ink-3">
            {full ? <span className="text-yang">Limit reached</span> : <span>Chosen</span>}{" "}
            <span data-ay-skip="1" className="tabular-nums">{`${sel.length}/${cap}`}</span>
          </p>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={sel.length === 0} onClick={() => { onConfirm(sel); onClose(); }}>Attach</Button>
        </footer>
      </div>
    </div>
  );
}
