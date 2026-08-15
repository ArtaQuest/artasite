// Shared reading kit — the SAME reader the Journal of Seasonality (pages/Research.tsx) and the
// ArtaPublishing book reader (pages/Read.tsx) both use. Generic over content via `ReaderDoc`, so a
// research Submission OR a Library Book drives the identical experience: the distraction-free ReadMode
// overlay, the progress-spine ReadingToc, the XSS-safe MarkdownLite, the reading-preference constants,
// and wide-table containment. Figures are passed in pre-rendered (ReadMode stays chart-agnostic), so the
// research chart components remain in Research.tsx.
/* eslint-disable react-refresh/only-export-components -- domain module, like ui.tsx and
   nbview.tsx: by design it exports the reading COMPONENTS together with the helpers they
   are built from (mdSlug in particular), because a table of contents must derive anchor
   ids with the very function that renders them or every link silently scrolls nowhere. */
import { useEffect, useMemo, useRef, useState, useCallback, memo, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import { cx } from "./ui";
import { Listen, type ListenHandle } from "./listen";
import { watchMath } from "../lib/math";
import { currentTheme, toggleTheme, type Theme } from "../lib/theme";
import { currentLevel as currentContrast, setContrast, applyContrast, LEVELS as CONTRAST_LEVELS } from "../lib/contrast";

/** Generic content a reader can render — satisfied by a research Submission, a Library Book, or ANY
 *  text content a page adapts into this shape (title + sanitised body HTML is the whole contract). */
export type ReaderDoc = {
  id: number;
  title: string;
  author?: { name: string; slug?: string } | null;
  created?: number;
  abstract?: string;
  doi?: string;
  journal_name?: string; // research: the journal; the eyebrow becomes "<journal> · Article"
  eyebrow?: string;      // override the masthead eyebrow verbatim (e.g. "ArtaQuest Library · Book")
  license?: string;      // byline licence/credit; defaults to "CC BY 4.0" when omitted
  narrate?: { type: string; id: number }; // narratable target (recorded narrations) — e.g. {type:'book', id}
  lang?: string;         // BCP-47 content language — drives TTS segmentation + the hyphenator
  dir?: "ltr" | "rtl" | "auto"; // reading direction; default "auto" (first strong character decides)
  posNs?: string;        // reading-position namespace (defaults: journal docs "sub", others "book")
};

/** Minimal, XSS-safe Markdown → React renderer for AI review reports. Handles headings, bold/italic,
 *  inline + fenced code, links (https only), and bullet/numbered lists. No dangerouslySetInnerHTML —
 *  every text node is React-escaped and links are restricted to http(s). */
/**
 * Heading text → anchor id. Exported because a table of contents has to derive the same id from
 * the same source text WITHOUT rendering the document twice; if the two ever disagree, every
 * TOC link silently scrolls nowhere.
 */
/**
 * The five HTML entities, decoded for a TEXT label.
 *
 * The contents panel is a regex over the rendered HTML, so a heading containing a quote or an
 * ampersand arrived as `&quot;fix&quot;` and was shown that way — visible markup in a navigation
 * list. Notebook headings hit this constantly (the JupyterBook page renders author markdown), which
 * is where it was spotted. Safe by construction: the result is handed to React as a text node, so
 * React escapes it again on the way out — decoding here cannot inject anything.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");   // LAST — so "&amp;lt;" decodes to "&lt;", not "<"
}

export function mdSlug(text: string): string {
  return "s-" + text
    .replace(/[`*_[\]()]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\uffff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function MarkdownLite({ text }: { text: string }) {
  const lines = (text || "").replace(/\r\n/g, "\n").split("\n");
  const inline = (s: string): ReactNode[] => {
    const out: ReactNode[] = [];
    const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*([^*]+)\*)/g;
    let last = 0, m: RegExpExecArray | null, k = 0;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      if (m[2] != null) out.push(<b key={k++} className="text-ink">{m[2]}</b>);
      else if (m[3] != null) out.push(<code key={k++} className="rounded bg-space-1 px-1 py-0.5 font-mono text-[12px]">{m[3]}</code>);
      else if (m[4] != null) out.push(<a key={k++} href={m[5]} target="_blank" rel="noopener noreferrer" className="text-yin-light hover:underline">{m[4]}</a>);
      else if (m[6] != null) out.push(<i key={k++}>{m[6]}</i>);
      last = m.index + m[0].length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  };
  const blocks: ReactNode[] = [];
  let i = 0, key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      blocks.push(<pre key={key++} className="overflow-x-auto rounded-card bg-space-1 p-2.5 font-mono text-[12px] text-ink-2"><code>{buf.join("\n")}</code></pre>);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      // REAL heading elements with stable ids (2026-07-28). These were bold <p>s, which gave the
      // rendered notebook no document structure at all: nothing for a table of contents to anchor
      // to, nothing for a screen reader to navigate by, and no landmark for "skip to section".
      // A published notebook has to read like a document, so it is built as one.
      const depth = Math.min(6, h[1].length);
      const Tag = (`h${Math.min(4, depth + 1)}`) as "h2" | "h3" | "h4" | "h5";
      const size = depth <= 1 ? "text-[19px]" : depth === 2 ? "text-[16.5px]" : "text-[15px]";
      blocks.push(
        <Tag key={key++} id={mdSlug(h[2])} className={`mt-5 scroll-mt-24 font-bold leading-snug text-ink ${size}`}>
          {inline(h[2])}
        </Tag>,
      );
      i++; continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
      blocks.push(<ul key={key++} className="list-disc space-y-0.5 ps-5">{items.map((it, x) => <li key={x}>{inline(it)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
      blocks.push(<ol key={key++} className="list-decimal space-y-0.5 ps-5">{items.map((it, x) => <li key={x}>{inline(it)}</li>)}</ol>);
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    const buf = [line]; i++;
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) { buf.push(lines[i]); i++; }
    blocks.push(<p key={key++}>{inline(buf.join(" "))}</p>);
  }
  return <div className="space-y-2 text-[13.5px] leading-relaxed text-ink-2">{blocks}</div>;
}

/** Keep wide block content (data tables) from blowing out the narrow mobile reading column. The reviewer's
 *  body HTML carries bare <table>s; a table can't shrink below its columns' min-content, so on a phone it
 *  forces the whole article wider than the viewport and every line of running text is shifted/clipped (the
 *  "scrambled on mobile" report). We wrap each table in a horizontal-scroll container so it scrolls within
 *  the measure instead — keeping its collapsed-border styling (the table stays display:table). Idempotent
 *  (skips a table already wrapped), so it's safe to re-run, including under watchMath's MutationObserver.
 *  Display equations already self-scroll (.katex-display / figure.aq-eq), so they need no wrapping here. */
export function containWideTables(root: HTMLElement | null | undefined): void {
  if (!root) return;
  for (const table of Array.from(root.querySelectorAll("table"))) {
    const parent = table.parentElement;
    if (!parent || parent.classList.contains("aq-table-scroll")) continue; // already wrapped
    const wrap = document.createElement("div");
    wrap.className = "aq-table-scroll";
    parent.insertBefore(wrap, table);
    wrap.appendChild(table);
  }
}

// ── READ MODE — a distraction-free, full-viewport immersive reader ──────────────────────────────────
// Persisted reading preferences (device-local, like the theme — the DB is public so we keep no per-user
// server state we don't need). Text size is one of four steps; the reading face is serif (default, best
// for long-form legibility) or sans.
const READ_SCALES = [0.92, 1, 1.12, 1.26] as const; // S · M · L · XL
const READ_SIZE_LABELS = ["S", "M", "L", "XL"] as const;
// Reading-column measures (max-width of the prose), one per width step. Narrow ≈ 52ch, Normal ≈ 62ch,
// Wide ≈ 74ch — all comfortable; "Wide" still keeps a measure (never edge-to-edge) for legibility.
const READ_WIDTHS = ["36rem", "44rem", "54rem"] as const; // Narrow · Normal · Wide
const READ_WIDTH_LABELS = ["Narrow", "Normal", "Wide"] as const;
// Line height + letter spacing — the two spacing levers low-vision and dyslexic readers ask for
// first (WCAG 1.4.12 sets 1.5/0.12em as the bar text must TOLERATE; we offer them as choices).
const READ_LH = [1.5, 1.62, 1.85] as const;
const READ_LH_LABELS = ["Compact", "Normal", "Relaxed"] as const;
const READ_LS = ["0em", "0.01em", "0.025em"] as const;
const READ_LS_LABELS = ["Tight", "Normal", "Open"] as const;
const SIZE_KEY = "aq_read_size";
const FACE_KEY = "aq_read_face";
const WIDTH_KEY = "aq_read_width";
const LH_KEY = "aq_read_lh";
const LS_KEY = "aq_read_ls";
const JUSTIFY_KEY = "aq_read_justify";
const RULER_KEY = "aq_read_ruler";
// Per-document scroll offset, NAMESPACED BY TYPE: ReadMode serves journal articles, Library books
// AND feed notebooks — book #7, article #7 and notebook #7 must never share a saved position (one's
// deep offset would dump another at its bottom). A doc can pass its own namespace via posNs; journal
// docs default to "sub", everything else to "book".
const POS_KEY = (s: ReaderDoc) => `aq_read_pos_${s.posNs || (s.journal_name ? "sub" : "book")}_${s.id}`;
const WPM = 220; // average adult reading speed, for the "min read" estimate
type ReadFace = "serif" | "sans";
function readSizeInit(): number {
  try { const n = parseInt(localStorage.getItem(SIZE_KEY) || "", 10); if (n >= 0 && n < READ_SCALES.length) return n; } catch { /* blocked */ }
  return 1; // M
}
function readFaceInit(): ReadFace {
  try { return localStorage.getItem(FACE_KEY) === "sans" ? "sans" : "serif"; } catch { return "serif"; }
}
function readWidthInit(): number {
  try { const n = parseInt(localStorage.getItem(WIDTH_KEY) || "", 10); if (n >= 0 && n < READ_WIDTHS.length) return n; } catch { /* blocked */ }
  return 1; // Normal
}
function stepInit(key: string, len: number, fallback: number): number {
  try { const n = parseInt(localStorage.getItem(key) || "", 10); if (n >= 0 && n < len) return n; } catch { /* blocked */ }
  return fallback;
}
function boolInit(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}
/** Estimated reading minutes from the HTML body's visible text (+ the abstract). Never less than 1. */
function readingMinutes(html: string, abstract?: string): number {
  const text = (html || "").replace(/<[^>]+>/g, " ") + " " + (abstract || "");
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WPM));
}

export type TocItem = { id: string; label: string; level: number };

/** A shared, premium table of contents that doubles as a reading-position progress bar. Used in BOTH the
 *  inline article reader (scrollRoot = window) AND the distraction-free read mode (scrollRoot = the overlay
 *  element). Behaviour:
 *   • A thin vertical SPINE runs the full height of the list; a gold fill grows top→down with scroll, so the
 *     spine itself is a progress bar of the whole article.
 *   • The section currently being read is highlighted (gold, medium weight, aria-current); passed sections
 *     read normal, upcoming ones muted — "where am I + how far through" at a glance.
 *   • Clicking an item smooth-scrolls its target into view within the correct scroll root.
 *  PERFORMANCE: one rAF-throttled scroll listener on the root. The spine fill height is written directly to
 *  the DOM (element.style) every frame — NEVER React state — so the gold bar tracks scroll at 60fps with no
 *  re-renders. setState fires ONLY when the active id changes (a handful of times across a whole article),
 *  so scrolling stays smooth. */
export function ReadingToc({ items, scrollRoot, className, onNavigate }: { items: TocItem[]; scrollRoot?: HTMLElement | null; className?: string; onNavigate?: () => void }) {
  const [active, setActive] = useState("");
  const fillRef = useRef<HTMLSpanElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);

  // FOLLOW the active item inside the TOC's OWN scroll box (.aq-toc is overflow:auto). A long book's
  // contents (a 12-month book lists ~200 sections ≈ 5600px) is far taller than the sticky box, so
  // without this the gold "you are here" highlight drifts thousands of px below the visible list and
  // the TOC looks like it stopped tracking. Scroll the nav's OWN scrollTop only — never
  // scrollIntoView, which walks every ancestor and would yank the page/overlay the reader is reading.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || !active || nav.scrollHeight <= nav.clientHeight) return;
    const el = listRef.current?.querySelector<HTMLElement>('a[aria-current="true"]');
    if (!el) return;
    const nr = nav.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const pad = 56; // keep a little context above/below the highlighted row
    if (er.top < nr.top + pad) nav.scrollTo({ top: nav.scrollTop + er.top - (nr.top + pad), behavior: "smooth" });
    else if (er.bottom > nr.bottom - pad) nav.scrollTo({ top: nav.scrollTop + er.bottom - (nr.bottom - pad), behavior: "smooth" });
  }, [active]);

  // Resolve a target heading/section element for an id within the active scroll root (overlay) or document.
  const find = useCallback((id: string): HTMLElement | null => {
    if (scrollRoot) return scrollRoot.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    return document.getElementById(id);
  }, [scrollRoot]);

  // ONE rAF-throttled scroll/resize listener. Updates the spine fill imperatively (no state) and only
  // setState()s the active id when it actually changes. Re-attaches when the item list or root changes.
  useEffect(() => {
    if (items.length === 0) return;
    const root = scrollRoot ?? null;
    const winScroll = !root;
    let raf = 0, last = "";

    const tick = () => {
      raf = 0;
      // 1) Progress fill — fraction of the article scrolled through (decorative; written straight to DOM).
      let frac = 0;
      if (winScroll) {
        const h = document.documentElement;
        const max = h.scrollHeight - h.clientHeight;
        frac = max > 0 ? h.scrollTop / max : 0;
      } else if (root) {
        const max = root.scrollHeight - root.clientHeight;
        frac = max > 0 ? root.scrollTop / max : 0;
      }
      frac = Math.min(1, Math.max(0, frac));
      if (fillRef.current) fillRef.current.style.height = (frac * 100).toFixed(2) + "%";

      // 2) Active section — the last heading whose top is at/above a "you are here" line just below the
      //    root's top edge. Compared in viewport coords so it works for both window + overlay roots.
      const topEdge = winScroll ? 0 : (root as HTMLElement).getBoundingClientRect().top;
      const line = topEdge + 104;
      let cur = items[0].id;
      for (const it of items) {
        const el = find(it.id);
        if (el && el.getBoundingClientRect().top <= line) cur = it.id; else if (el) break;
      }
      // Snap to the last item once scrolled to the very bottom (short trailing sections never "win" the line).
      if (frac > 0.995) cur = items[items.length - 1].id;
      if (cur !== last) { last = cur; setActive(cur); }
    };

    const on = () => { if (!raf) raf = requestAnimationFrame(tick); };
    tick();
    const target: EventTarget = winScroll ? window : (root as HTMLElement);
    target.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => { target.removeEventListener("scroll", on); window.removeEventListener("resize", on); if (raf) cancelAnimationFrame(raf); };
  }, [items, scrollRoot, find]);

  const go = useCallback((e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    const el = find(id);
    if (!el) return;
    if (scrollRoot) {
      // Align the target near the top of the overlay, honouring the prose `scroll-mt` (~80px ≈ 5rem).
      const root = scrollRoot;
      const delta = el.getBoundingClientRect().top - root.getBoundingClientRect().top;
      root.scrollTo({ top: root.scrollTop + delta - 80, behavior: "smooth" });
    } else {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      history.replaceState(null, "", `#${id}`);
    }
    onNavigate?.();
  }, [find, scrollRoot, onNavigate]);

  if (items.length === 0) return null;
  return (
    <nav ref={navRef} className={cx("aq-toc", className)} aria-label="Contents">
      <p className="aq-toc-eyebrow">Contents</p>
      <div className="aq-toc-body">
        <span className="aq-toc-spine" aria-hidden>
          <span ref={fillRef} className="aq-toc-fill" aria-hidden />
        </span>
        <ul ref={listRef} className="aq-toc-list">
          {items.map((it) => (
            <li key={it.id}>
              <a
                href={`#${it.id}`}
                onClick={(e) => go(e, it.id)}
                aria-current={active === it.id ? "true" : undefined}
                className={cx("aq-toc-item", it.level === 3 && "aq-toc-sub", active === it.id && "is-active")}
              >
                {it.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

/** The full-screen, distraction-free reading overlay. Renders ONLY the title, a single quiet byline, the
 *  abstract, the full body (KaTeX typeset + interactive figures re-rendered here), and the references — over
 *  a centred reading column with comfortable measure and generous rhythm. role="dialog" + aria-modal, focus
 *  is moved in on open and restored to the toggle on close, focus is trapped, background scroll is locked,
 *  and Esc closes. Uses the Fullscreen API when granted, with a fixed full-viewport fallback otherwise. */
/** The sanitised article body. MEMOISED on html+className ONLY: unrelated ReadMode re-renders (the
 *  idle-cursor toggle, contrast/theme/size changes that don't alter the prose class) must NOT re-apply
 *  dangerouslySetInnerHTML — doing so replaces every text node and detaches the ArtaTTS sentence-follow
 *  ranges mid-read (the band would freeze). onClick/innerRef are stable, so freezing them is safe. */
const ArticleBody = memo(
  function ArticleBody({ html, className, onClick, innerRef }: {
    html: string; className: string; onClick: (e: ReactMouseEvent) => void; innerRef: React.RefObject<HTMLDivElement | null>;
  }) {
    return <div ref={innerRef} className={className} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
  },
  (prev, next) => prev.html === next.html && prev.className === next.className,
);

export function ReadMode({ s, body, figures, hasFigures, actions, onClose, returnFocus }: {
  s: ReaderDoc; body: string; figures?: ReactNode; hasFigures?: boolean; actions?: ReactNode; onClose: () => void; returnFocus: () => void;
}) {
  const eyebrow = s.eyebrow || ((s.journal_name || "ArtaQuest Journals") + " · Article");
  const licence = s.license ?? "CC BY 4.0";
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const [size, setSize] = useState(readSizeInit);
  const [face, setFace] = useState<ReadFace>(readFaceInit);
  const [width, setWidth] = useState(readWidthInit);
  const [lh, setLh] = useState(() => stepInit(LH_KEY, READ_LH.length, 1));
  const [ls, setLs] = useState(() => stepInit(LS_KEY, READ_LS.length, 1));
  const [justify, setJustify] = useState(() => boolInit(JUSTIFY_KEY));
  const [ruler, setRuler] = useState(() => boolInit(RULER_KEY));
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const [contrast, setContrastLvl] = useState(() => currentContrast());
  const [isFs, setIsFs] = useState(false);     // mirrors document.fullscreenElement, for the toggle icon
  const [showHelp, setShowHelp] = useState(false); // the keyboard-shortcuts panel
  const [showAa, setShowAa] = useState(false);     // the typography (Aa) popover
  const [showToc, setShowToc] = useState(false); // the mobile Contents bottom-sheet (side TOC hidden ≤1100px)
  const tocBtnRef = useRef<HTMLButtonElement | null>(null);     // restore focus here when the sheet closes
  const tocSheetRef = useRef<HTMLDivElement | null>(null);
  const aaBtnRef = useRef<HTMLButtonElement | null>(null);
  const listenRef = useRef<ListenHandle | null>(null);
  const progressRef = useRef<HTMLSpanElement | null>(null); // the top hairline's gold fill (written per frame)
  const minLeftRef = useRef<HTMLSpanElement | null>(null);  // "N min left" (written only when the number moves)
  const rulerRef = useRef<HTMLDivElement | null>(null);     // the reading ruler band (follows the pointer)
  const [idle, setIdle] = useState(false);     // cursor auto-hide for immersion
  const intentionalFsExit = useRef(false);     // true when WE exit fullscreen (toggle/f) — don't close read mode

  const date = s.created ? new Date(s.created * 1000).toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "";
  const minutes = useMemo(() => readingMinutes(body, s.abstract), [body, s.abstract]);

  // Persist every reading preference (device-local, like the theme).
  useEffect(() => { try { localStorage.setItem(SIZE_KEY, String(size)); } catch { /* blocked */ } }, [size]);
  useEffect(() => { try { localStorage.setItem(FACE_KEY, face); } catch { /* blocked */ } }, [face]);
  useEffect(() => { try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* blocked */ } }, [width]);
  useEffect(() => { try { localStorage.setItem(LH_KEY, String(lh)); } catch { /* blocked */ } }, [lh]);
  useEffect(() => { try { localStorage.setItem(LS_KEY, String(ls)); } catch { /* blocked */ } }, [ls]);
  useEffect(() => { try { localStorage.setItem(JUSTIFY_KEY, justify ? "1" : "0"); } catch { /* blocked */ } }, [justify]);
  useEffect(() => { try { localStorage.setItem(RULER_KEY, ruler ? "1" : "0"); } catch { /* blocked */ } }, [ruler]);

  // Mark the document while a reader is open — the global selection-Listen pill stands down (the
  // reader's own Listen owns speech here) and page chrome can react if it ever needs to.
  useEffect(() => {
    document.documentElement.setAttribute("data-aq-reading", "1");
    return () => document.documentElement.removeAttribute("data-aq-reading");
  }, []);

  // Lock background scroll while the overlay is open; restore the underlying page's scroll on close.
  // iOS Safari ignores body{overflow:hidden}, so ALSO pin the body (position:fixed + top:-scrollY) —
  // the only lock that actually holds on iOS; without it the page behind the reader scrolls and the
  // overlay's own scrolling misbehaves.
  useEffect(() => {
    const scrollY = window.scrollY;
    const b = document.body.style;
    const prev = { overflow: b.overflow, position: b.position, top: b.top, width: b.width };
    b.overflow = "hidden";
    b.position = "fixed";
    b.top = `-${scrollY}px`;
    b.width = "100%";
    return () => {
      b.overflow = prev.overflow; b.position = prev.position; b.top = prev.top; b.width = prev.width;
      // Restore the page where the reader left it (unpinning the body resets the scroll).
      window.scrollTo(0, scrollY);
    };
  }, []);

  // Request real fullscreen on the overlay; the fixed-inset CSS overlay is the always-correct fallback when
  // denied (never throws uncaught). On unmount, leave fullscreen cleanly.
  useEffect(() => {
    const el = overlayRef.current;
    el?.requestFullscreen?.().catch(() => { /* denied → the fixed-inset CSS overlay already covers everything */ });
    return () => { if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); };
  }, []);

  // Keep `isFs` in sync, AND make an UNINTENTIONAL exit of fullscreen close read mode. In a real browser,
  // pressing Esc while in fullscreen makes the BROWSER exit fullscreen and can CONSUME the key so the
  // overlay's keydown never fires — which used to leave a stuck, no-longer-fullscreen overlay. Treating that
  // Esc/F11/OS exit as "close read mode" makes a single Esc feel natural (leave fullscreen AND exit).
  // BUT when the user deliberately leaves fullscreen via the toggle button or `f`, they want to STAY in read
  // mode — `intentionalFsExit` distinguishes the two. We also only honour the close once we've actually
  // entered fullscreen, so a denied request doesn't insta-close.
  useEffect(() => {
    let entered = false;
    const onFsChange = () => {
      const fs = !!document.fullscreenElement;
      setIsFs(fs);
      if (fs) { entered = true; return; }
      if (intentionalFsExit.current) { intentionalFsExit.current = false; return; }
      if (entered) onClose();
    };
    document.addEventListener("fullscreenchange", onFsChange);
    // pick up the initial state (the request above may have resolved already)
    setIsFs(!!document.fullscreenElement);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [onClose]);

  // Document-level Escape — ALWAYS exits read mode, even if the overlay div never sees the keydown (the
  // fullscreen-consumes-Esc case, or focus parked somewhere unusual). Belt-and-braces with the fs handler.
  useEffect(() => {
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // Esc closes an open Contents sheet / Aa popover / help panel first; otherwise exits read mode.
      if (showToc) { setShowToc(false); return; }
      if (showAa) { setShowAa(false); aaBtnRef.current?.focus(); return; }
      if (showHelp) { setShowHelp(false); return; }
      onClose();
    };
    document.addEventListener("keydown", onDocKey);
    return () => document.removeEventListener("keydown", onDocKey);
  }, [onClose, showToc, showHelp, showAa]);

  // Move focus into the overlay on open; restore it to the toggle on close.
  useEffect(() => {
    closeBtnRef.current?.focus();
    return () => returnFocus();
  }, [returnFocus]);

  // Mobile Contents sheet: move focus into the sheet on open, restore to its trigger on close.
  useEffect(() => {
    if (!showToc) return;
    const prev = document.activeElement as HTMLElement | null;
    tocSheetRef.current?.focus();
    return () => { (prev ?? tocBtnRef.current)?.focus?.(); };
  }, [showToc]);

  // Typeset the body's LaTeX inside the overlay's own DOM (a separate node from the inline reader), and
  // keep it typeset (watchMath re-runs on i18n/re-render reverts). Re-keyed on the article.
  useEffect(() => {
    containWideTables(bodyRef.current);       // wrap wide tables so they scroll within the column, not past the viewport
    return watchMath(bodyRef.current, "auto"); // typeset + keep math typeset (returns the observer cleanup)
  }, [s.id, body]);

  // Persist the scroll offset per article (restored on reopen). NO React state is set on scroll — that was
  // the jank: setState on every scroll event forced 60 re-renders/sec. A debounced localStorage write only.
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    let saveT: ReturnType<typeof setTimeout> | undefined;
    const on = () => {
      clearTimeout(saveT);
      saveT = setTimeout(() => { try { localStorage.setItem(POS_KEY(s), String(Math.round(el.scrollTop))); } catch { /* blocked */ } }, 250);
    };
    el.addEventListener("scroll", on, { passive: true });
    return () => { el.removeEventListener("scroll", on); clearTimeout(saveT); };
  }, [s.id]);

  // WHERE AM I — the top hairline progress bar + "N min left". One rAF-throttled scroll listener;
  // the fill width is written straight to the DOM every frame (never React state), and the minutes
  // label only when the whole-minute figure moves — reading progress with zero re-render cost.
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    let raf = 0, lastLabel = "";
    const tick = () => {
      raf = 0;
      const max = el.scrollHeight - el.clientHeight;
      const frac = max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 1;
      if (progressRef.current) progressRef.current.style.width = (frac * 100).toFixed(2) + "%";
      const label = frac >= 0.99 ? "read" : `${Math.max(1, Math.ceil(minutes * (1 - frac)))} min left`;
      if (label !== lastLabel && minLeftRef.current) { lastLabel = label; minLeftRef.current.textContent = label; }
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(tick); };
    tick();
    el.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => { el.removeEventListener("scroll", on); window.removeEventListener("resize", on); if (raf) cancelAnimationFrame(raf); };
  }, [s.id, minutes]);

  // READING RULER — a soft gold band that tracks the pointer's line, for readers who lose their
  // place (tracking/attention difficulties). Pure DOM writes on pointermove; pointer-events: none.
  useEffect(() => {
    if (!ruler) return;
    const el = overlayRef.current;
    if (!el) return;
    let raf = 0, y = window.innerHeight * 0.4;
    const paint = () => { raf = 0; if (rulerRef.current) rulerRef.current.style.top = y + "px"; };
    const onMove = (e: PointerEvent) => { y = e.clientY; if (!raf) raf = requestAnimationFrame(paint); };
    paint();
    el.addEventListener("pointermove", onMove, { passive: true });
    return () => { el.removeEventListener("pointermove", onMove); if (raf) cancelAnimationFrame(raf); };
  }, [ruler]);


  // The shared-TOC item set for read mode: Abstract + the body's h2/h3 (which includes a "References"
  // heading when the article has one) + Figures. Parsed from the body HTML so it's ready on first paint
  // (no DOM-settle delay); the live overlay heading ids are matched by ReadingToc's scroll-spy. The overlay
  // is mounted by the time the TOC renders, so we re-key on s.id/body to refresh between articles.
  const readModeToc = useMemo<TocItem[]>(() => {
    const out: TocItem[] = [];
    if (s.abstract) out.push({ id: "abstract", label: "Abstract", level: 2 });
    const re = /<(h2|h3)\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const label = decodeEntities(m[3].replace(/<[^>]+>/g, "").trim().replace(/\s+/g, " "));
      if (label) out.push({ id: m[2], label, level: m[1].toLowerCase() === "h3" ? 3 : 2 });
    }
    if (hasFigures) out.push({ id: "figures", label: "Figures", level: 2 });
    return out;
  }, [s.id, s.abstract, body, hasFigures]);

  /** Scroll to the next/previous section heading — single-key section hopping (N / P). */
  const hopSection = useCallback((dir: 1 | -1) => {
    const root = overlayRef.current;
    if (!root || readModeToc.length === 0) return;
    const line = root.getBoundingClientRect().top + 104;
    let curIdx = 0;
    for (let i = 0; i < readModeToc.length; i++) {
      const el2 = root.querySelector<HTMLElement>(`[id="${CSS.escape(readModeToc[i].id)}"]`);
      if (el2 && el2.getBoundingClientRect().top <= line + 2) curIdx = i;
    }
    const next = readModeToc[Math.max(0, Math.min(readModeToc.length - 1, curIdx + dir))];
    const target = next && root.querySelector<HTMLElement>(`[id="${CSS.escape(next.id)}"]`);
    if (target) {
      const delta = target.getBoundingClientRect().top - root.getBoundingClientRect().top;
      root.scrollTo({ top: root.scrollTop + delta - 80, behavior: "smooth" });
    }
  }, [readModeToc]);

  // ReadingToc's scroll-spy resolves heading elements live from `overlayRef`. The ref isn't populated on the
  // first render, so flip a flag once it is — that re-renders with a non-null scrollRoot and arms the spy.
  const [overlayReady, setOverlayReady] = useState(false);
  useEffect(() => { setOverlayReady(true); }, []);

  // Restore the saved scroll position for THIS article on open (only if it's the same article). Runs after
  // layout + math typeset settle so the offset lands on the right place; harmless when there's nothing saved.
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    let raf2 = 0, retryT = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        try {
          const saved = parseInt(localStorage.getItem(POS_KEY(s)) || "", 10);
          if (!Number.isFinite(saved) || saved <= 0) return;
          // The browser clamps the assignment itself — no manual Math.min, which measured a PRE-settle
          // scrollHeight (KaTeX + figures still loading) and could land short of a deep saved position.
          el.scrollTop = saved;
          const applied = el.scrollTop; // what the pre-settle layout allowed
          // One late re-apply after math/figures settle: only when the first assignment was clamped
          // short AND the user hasn't scrolled away from that clamped spot in the meantime.
          if (applied < saved) {
            retryT = window.setTimeout(() => { if (Math.abs(el.scrollTop - applied) < 4) el.scrollTop = saved; }, 800);
          }
        } catch { /* blocked */ }
      });
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); clearTimeout(retryT); };
  }, [s.id]);

  // Auto-hide the mouse cursor after a couple of idle seconds inside the overlay (reverts on any move) for
  // an immersive read; never hides while a control is focused (keyboard users keep their pointer visible).
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const wake = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 2500); };
    wake();
    el.addEventListener("mousemove", wake);
    return () => { el.removeEventListener("mousemove", wake); clearTimeout(t); };
  }, []);

  // Toggle theme AND re-derive the contrast ink for the new theme (light/dark have different ink ramps;
  // without this the inline --color-ink kept the old theme's values → "contrast not updated" on toggle).
  const flipTheme = useCallback(() => { const t = toggleTheme(); applyContrast(); setTheme(t); }, []);
  const dec = useCallback(() => setSize((n) => Math.max(0, n - 1)), []);
  const inc = useCallback(() => setSize((n) => Math.min(READ_SCALES.length - 1, n + 1)), []);
  const narrower = useCallback(() => setWidth((n) => Math.max(0, n - 1)), []);
  const wider = useCallback(() => setWidth((n) => Math.min(READ_WIDTHS.length - 1, n + 1)), []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      intentionalFsExit.current = true; // deliberate exit — stay in read mode (don't trigger the close-on-exit)
      document.exitFullscreen?.().catch(() => { intentionalFsExit.current = false; });
    } else {
      overlayRef.current?.requestFullscreen?.().catch(() => {});
    }
  }, []);

  // Single-key reading shortcuts. They never fire while focus is in a text field, and modifier combos
  // (Ctrl/Cmd/Alt) are left to the browser. Esc is handled at the document level above.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      // Focus trap — keep Tab / Shift+Tab inside the overlay.
      const root = overlayRef.current;
      if (!root) return;
      const f = Array.from(root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )).filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tgt = e.target as HTMLElement;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT" || tgt.isContentEditable)) return;
    switch (e.key) {
      case "q": e.preventDefault(); onClose(); break;
      case "+": case "=": e.preventDefault(); inc(); break;
      case "-": case "_": e.preventDefault(); dec(); break;
      case "t": e.preventDefault(); flipTheme(); break;
      case "f": e.preventDefault(); toggleFullscreen(); break;
      case "[": e.preventDefault(); narrower(); break;
      case "]": e.preventDefault(); wider(); break;
      case "l": e.preventDefault(); listenRef.current?.toggle(); break;
      case "r": e.preventDefault(); setRuler((v) => !v); break;
      case "n": e.preventDefault(); hopSection(1); break;
      case "p": e.preventDefault(); hopSection(-1); break;
      case "a": e.preventDefault(); setShowAa((v) => !v); break;
      case "?": e.preventDefault(); setShowHelp((v) => !v); break;
      default: break;
    }
  };

  const onBodyClick = (e: ReactMouseEvent) => {
    // In-body cross-references stay live (citation [1] → #ref-1, "Figure 1" → #fig-1) — scroll within the
    // overlay; image clicks are inert here (the lightbox is site chrome we deliberately leave out).
    const t = e.target as HTMLElement;
    const a = t.closest?.("a") as HTMLAnchorElement | null;
    const href = a?.getAttribute("href") || "";
    if (href.startsWith("#")) {
      e.preventDefault();
      const el = overlayRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(href.slice(1))}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        // the landing flash uses the live brand token, so it reads correctly in BOTH themes and at
        // every ArtaContrast level (never a hardcoded gold)
        el.style.transition = "background-color .5s";
        el.style.backgroundColor = "color-mix(in srgb, var(--color-yang) 18%, transparent)";
        setTimeout(() => { el.style.backgroundColor = ""; }, 1500);
      }
    }
  };

  const prose = "[&_h2]:font-bold [&_h2]:tracking-tight [&_h2]:text-ink [&_h2]:scroll-mt-20 [&_h3]:font-bold [&_h3]:text-ink [&_h3]:scroll-mt-20 [&_a]:text-yin-ink [&_a]:font-medium hover:[&_a]:underline [&_figure]:text-center [&_img]:mx-auto [&_img]:max-w-full [&_img]:border [&_img]:border-line [&_figcaption]:mt-2 [&_figcaption]:text-[0.85em] [&_figcaption]:leading-relaxed [&_figcaption]:text-ink-3 [&_table]:w-full [&_table]:border-collapse [&_table]:scroll-mt-20 [&_th]:border [&_th]:border-line [&_th]:bg-space-2 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-start [&_td]:border [&_td]:border-line [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:text-ink [&_blockquote]:my-6 [&_sup]:text-[0.7em] [&_sup_a]:font-semibold [&_sup_a]:text-yin-ink [&_code]:rounded [&_code]:bg-space-1 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_section]:scroll-mt-20 [&_li[id^='ref-']]:scroll-mt-20";

  return (
    <div
      ref={overlayRef}
      className={cx("aq-read-overlay", idle && "aq-read-idle")}
      style={{
        ["--aq-read-scale" as string]: String(READ_SCALES[size]),
        ["--aq-read-measure" as string]: READ_WIDTHS[width],
        ["--aq-read-lh" as string]: String(READ_LH[lh]),
        ["--aq-read-ls" as string]: READ_LS[ls],
      }}
      role="dialog" aria-modal="true" aria-label={`Reading: ${s.title}`}
      aria-describedby="aq-read-help-hint"
      onKeyDown={onKeyDown}
    >
      <p id="aq-read-help-hint" className="sr-only">Distraction-free reader. Keyboard shortcuts: Escape or Q to exit; plus or minus for text size; A for typography options; L to listen; N and P to hop sections; R for the reading ruler; T for theme; F for fullscreen; square brackets for column width; question mark for help.</p>
      {/* Reading progress — a hairline across the very top; its gold fill is written per frame. */}
      <span className="aq-read-progress" aria-hidden><span ref={progressRef} /></span>
      {/* The reading ruler — a soft band that follows the pointer's line (toggle: Aa panel or R). */}
      {ruler && <div ref={rulerRef} className="aq-read-ruler" aria-hidden />}
      <div className="aq-read-scroll">
        {/* Fixed bottom control bar */}
        <div className="aq-read-bar">
          <button ref={closeBtnRef} type="button" onClick={onClose} className="aq-read-ctl" aria-label="Exit read mode (Esc)" title="Exit read mode (Esc or Q)">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
            <span className="aq-read-label">Exit</span>
          </button>
          {/* Contents — opens the section list as a bottom sheet. Only shown when the side TOC is hidden
              (≤1100px, via .aq-read-only-narrow) and there's more than one section to jump between. */}
          {readModeToc.length > 1 && (
            <button ref={tocBtnRef} type="button" onClick={() => setShowToc(true)} className="aq-read-ctl aq-read-only-narrow" aria-haspopup="dialog" aria-expanded={showToc} aria-label="Contents" title="Contents">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>
              <span className="aq-read-label">Contents</span>
            </button>
          )}
          <span className="mx-auto flex flex-wrap items-center justify-center gap-2">
            <Listen ref={listenRef} bodyRef={bodyRef} target={s.narrate} lang={s.lang} />
            <button ref={aaBtnRef} type="button" onClick={() => setShowAa((v) => !v)} aria-expanded={showAa} aria-haspopup="dialog"
              className="aq-read-ctl" aria-label="Typography and reading options" title="Typography — size, width, face, spacing, ruler (A)">
              <span aria-hidden style={{ letterSpacing: "0.02em" }}>Aa</span>
            </button>
            <button type="button" onClick={flipTheme} className="aq-read-ctl" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`${theme === "dark" ? "Light" : "Dark"} theme (T)`}>
              {theme === "dark"
                ? <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="12" cy="12" r="4.5" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" /></svg>
                : <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>}
            </button>
            <span className="aq-read-seg aq-read-contrast" title="Text contrast (Calm ↔ Crisp)">
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" /></svg>
              <input type="range" min={1} max={CONTRAST_LEVELS} step={1} value={contrast}
                onChange={(e) => { const v = Number(e.target.value); setContrastLvl(v); setContrast(v); }}
                className="aq-read-crange" aria-label="Text contrast, Calm to Crisp" />
            </span>
            <button type="button" onClick={toggleFullscreen} aria-pressed={isFs} className="aq-read-ctl aq-read-hide-sm" aria-label={isFs ? "Exit fullscreen" : "Enter fullscreen"} title={`${isFs ? "Exit" : "Enter"} fullscreen (F)`}>
              {isFs
                ? <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>
                : <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>}
            </button>
            <button type="button" onClick={() => setShowHelp((v) => !v)} aria-pressed={showHelp} className="aq-read-ctl aq-read-hide-sm" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">?</button>
            {actions}
          </span>
          <span ref={minLeftRef} className="aq-read-minleft aq-read-hide-sm" aria-hidden />
        </div>

        {/* The Aa popover — every typography + comfort choice in one calm card above the bar. */}
        {showAa && (
          <div className="aq-read-help" role="presentation" onClick={() => { setShowAa(false); aaBtnRef.current?.focus(); }}>
            <div className="aq-read-help-card aq-aa-card" role="dialog" aria-label="Typography and reading options" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[14px] font-bold text-ink">Reading options</h2>
                <button type="button" onClick={() => { setShowAa(false); aaBtnRef.current?.focus(); }} className="aq-read-ctl" aria-label="Close reading options">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </div>
              <div className="aq-aa-row" role="group" aria-label="Text size">
                <span className="aq-aa-label">Text size</span>
                <span className="aq-read-seg">
                  <button type="button" onClick={dec} disabled={size === 0} className="aq-read-ctl" aria-label="Decrease text size" title="Smaller text (−)">A<span className="text-[0.7em]">−</span></button>
                  <span className="px-1.5 text-[0.72rem] font-semibold tabular-nums text-ink-3" aria-hidden>{READ_SIZE_LABELS[size]}</span>
                  <button type="button" onClick={inc} disabled={size === READ_SCALES.length - 1} className="aq-read-ctl" aria-label="Increase text size" title="Larger text (+)">A<span className="text-[0.85em]">+</span></button>
                </span>
              </div>
              <div className="aq-aa-row" role="group" aria-label="Column width">
                <span className="aq-aa-label">Width</span>
                <span className="aq-read-seg">
                  {READ_WIDTH_LABELS.map((w, i) => (
                    <button key={w} type="button" onClick={() => setWidth(i)} aria-pressed={width === i} className="aq-read-ctl">{w}</button>
                  ))}
                </span>
              </div>
              <div className="aq-aa-row" role="group" aria-label="Reading typeface">
                <span className="aq-aa-label">Typeface</span>
                <span className="aq-read-seg">
                  <button type="button" onClick={() => setFace("serif")} aria-pressed={face === "serif"} className="aq-read-ctl" title="Serif reading face">Serif</button>
                  <button type="button" onClick={() => setFace("sans")} aria-pressed={face === "sans"} className="aq-read-ctl" title="Sans-serif reading face">Sans</button>
                </span>
              </div>
              <div className="aq-aa-row" role="group" aria-label="Line height">
                <span className="aq-aa-label">Line height</span>
                <span className="aq-read-seg">
                  {READ_LH_LABELS.map((w, i) => (
                    <button key={w} type="button" onClick={() => setLh(i)} aria-pressed={lh === i} className="aq-read-ctl">{w}</button>
                  ))}
                </span>
              </div>
              <div className="aq-aa-row" role="group" aria-label="Letter spacing">
                <span className="aq-aa-label">Letter spacing</span>
                <span className="aq-read-seg">
                  {READ_LS_LABELS.map((w, i) => (
                    <button key={w} type="button" onClick={() => setLs(i)} aria-pressed={ls === i} className="aq-read-ctl">{w}</button>
                  ))}
                </span>
              </div>
              <div className="aq-aa-row">
                <span className="aq-aa-label" id="aq-aa-justify">Justify text</span>
                <button type="button" role="switch" aria-checked={justify} aria-labelledby="aq-aa-justify"
                  onClick={() => setJustify((v) => !v)} className="aq-read-ctl">{justify ? "On" : "Off"}</button>
              </div>
              <div className="aq-aa-row">
                <span className="aq-aa-label" id="aq-aa-ruler">Reading ruler <span className="text-ink-3">(R)</span></span>
                <button type="button" role="switch" aria-checked={ruler} aria-labelledby="aq-aa-ruler"
                  onClick={() => setRuler((v) => !v)} className="aq-read-ctl">{ruler ? "On" : "Off"}</button>
              </div>
            </div>
          </div>
        )}

        {showHelp && (
          <div className="aq-read-help" role="dialog" aria-label="Keyboard shortcuts" onClick={() => setShowHelp(false)}>
            <div className="aq-read-help-card" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[14px] font-bold text-ink">Keyboard shortcuts</h2>
                <button type="button" onClick={() => setShowHelp(false)} className="aq-read-ctl" aria-label="Close shortcuts">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </div>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
                {[
                  ["Esc / Q", "Exit read mode"],
                  ["L", "Listen / pause (read aloud)"],
                  ["A", "Typography and reading options"],
                  ["+ / −", "Text size"],
                  ["[ / ]", "Column width"],
                  ["N / P", "Next / previous section"],
                  ["R", "Reading ruler"],
                  ["T", "Light / dark theme"],
                  ["F", "Toggle fullscreen"],
                  ["? ", "This help"],
                  ["↑ ↓ Space", "Scroll"],
                ].map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt><kbd className="aq-read-kbd">{k}</kbd></dt>
                    <dd className="self-center text-ink-2">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        )}

        {/* Mobile/tablet Contents sheet — the section list as a bottom sheet (the side TOC is hidden
            ≤1100px). Reuses ReadingToc (gold progress spine + active highlight); a section tap smooth-
            scrolls within the overlay AND closes the sheet via onNavigate. Accessible: dialog + aria-modal,
            focus moved in/restored, Esc + scrim-tap to close, safe-area aware, above the bar. */}
        {showToc && (
          <div className="aq-read-sheet-scrim" onClick={() => setShowToc(false)}>
            <div
              ref={tocSheetRef}
              className="aq-read-sheet"
              role="dialog" aria-modal="true" aria-label="Contents"
              tabIndex={-1}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="aq-read-sheet-head">
                <span className="aq-read-sheet-grip" aria-hidden />
                <button type="button" onClick={() => setShowToc(false)} className="aq-read-ctl" aria-label="Close contents">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </div>
              <ReadingToc
                className="aq-read-sheet-toc"
                items={readModeToc}
                scrollRoot={overlayReady ? overlayRef.current : null}
                onNavigate={() => setShowToc(false)}
              />
            </div>
          </div>
        )}

        <div className="aq-read-layout">
        {readModeToc.length > 1 && (
          <ReadingToc className="aq-read-toc" items={readModeToc} scrollRoot={overlayReady ? overlayRef.current : null} />
        )}
        <article
          className={cx("aq-read-col", face === "serif" ? "aq-read-serif" : "aq-read-sans", justify && "aq-read-justify")}
          lang={s.lang || undefined}
          dir={s.dir || "auto"}
        >
          <p className="aq-read-eyebrow">{eyebrow}</p>
          <h1 className="aq-read-title">{s.title}</h1>
          <p className="aq-read-byline">
            {s.author?.slug ? <a href={`/u/${s.author.slug}`}>{s.author.name}</a> : <b>{s.author?.name || "—"}</b>}
            {date && <> · {date}</>}
            <> · {minutes} min read</>
            {licence && <> · {licence}</>}
            {s.doi && <> · DOI <a href={`https://doi.org/${s.doi}`} target="_blank" rel="noopener noreferrer">{s.doi}</a></>}
          </p>

          {s.abstract && (
            <section className="aq-read-abstract" id="abstract">
              <h2>Abstract</h2>
              <MarkdownLite text={s.abstract} />
            </section>
          )}

          <hr className="aq-read-rule" />

          {/* The reviewer-rendered full text (sanitised server-side). KaTeX is typeset by the effect above. */}
          <ArticleBody innerRef={bodyRef} className={cx("aq-article-body", prose)} onClick={onBodyClick} html={body} />

          {hasFigures && (
            <section className="aq-read-figs aq-no-math" id="figures">
              <h2>Figures</h2>
              <div className="mt-4">{figures}</div>
            </section>
          )}
        </article>
        </div>
      </div>
    </div>
  );
}
