// BookReader — read an on-device PDF as a REAL book (operator, 2026-07-24). Desktop is a two-page
// spread with a 3D page-flip (drag a page edge or click/tap to turn); mobile is one leaf with a
// folded far edge. Content is TYPESET like print: BookFlow paginates the extracted blocks into
// fixed leaves with no scrolling — a paragraph splits at the exact word where the page ends and
// continues on the next leaf, so book pages and PDF pages are decoupled. PDF pages extract LAZILY
// (openPdf) and feed the flow only a couple of leaves ahead of where you are. Themed leaves
// (dark/light + ArtaContrast + Aa sizes) re-typeset on any geometry change, keeping your place by
// block id. Listen makes the book read itself — and turn its own pages. Scroll view stays a toggle.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PdfBook } from "../lib/pdf-extract";
import { BookFlow } from "../lib/book-flow";
import { currentTheme, toggleTheme, type Theme } from "../lib/theme";
import { currentLevel as currentContrast, setContrast, applyContrast, LEVELS as CONTRAST_LEVELS } from "../lib/contrast";
import { autoRenderMathIn, texToHtml } from "../lib/math";
import { sentencesFromRoot, NEURAL_VOICES, VOICE_GROUPS, type Sentence } from "../lib/tts";
import { useArtaTts, ttsVoiceKey } from "./use-artatts";
import { ocrEquations, disposeTexify } from "../lib/pdf-latex";
import { canRun } from "../lib/device-budget";

type Flip = { dir: "next" | "prev"; frontHtml: string; backHtml: string; underHtml: string; manual?: boolean } | null;

const FLIP_MS = 720;
const FONT_STEPS = [0.85, 0.925, 1, 1.075, 1.15, 1.25];
const LOOKAHEAD = 4; // keep this many leaves typeset beyond the visible spread

function hydrateLeaf(el: HTMLDivElement | null) {
  if (!el) return;
  void autoRenderMathIn(el);
}

export function BookReader({ book, onClose, onSwitchToScroll, returnFocus }: {
  book: PdfBook;
  onClose: () => void;
  onSwitchToScroll?: () => void;
  returnFocus?: () => void;
}) {
  const rtl = book.dir === "rtl"; // RTL books page right-to-left (the spread mirrors; forward turns the LEFT leaf)
  const [isMobile, setIsMobile] = useState(() => matchMedia("(max-width: 820px)").matches);
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const [contrast, setContrastLvl] = useState(() => currentContrast());
  const [fontStep, setFontStep] = useState(2);
  const [flip, setFlip] = useState<Flip>(null);

  // ── the typeset flow ──
  const flowRef = useRef<BookFlow | null>(null);
  const consumedRef = useRef(0);          // PDF pages fed to the flow
  const pumpingRef = useRef(false);
  const [leafCount, setLeafCount] = useState(0);
  const [consumed, setConsumed] = useState(0); // PDF pages typeset so far (the loader's truth)
  const [totalKnown, setTotalKnown] = useState(false);
  // Equation crisping: OCR each equation crop → LaTeX → static KaTeX HTML → re-typeset with crisp
  // equations. Crops show instantly; KaTeX swaps in when ready. Ids are page-GLOBAL ("n:local").
  const eqCropsRef = useRef<Map<string, string>>(new Map()); // id → crop src (data URI)
  const eqHtmlRef = useRef<Map<string, string>>(new Map());  // id → rendered KaTeX HTML
  const [eqProg, setEqProg] = useState<{ done: number; total: number } | null>(null);
  const [eqStatus, setEqStatus] = useState(""); // model-download note while crisping equations
  const enhancedRef = useRef(false);
  const geomRef = useRef({ w: 0, h: 0, font: 15 });
  const [figMax, setFigMax] = useState(0); // px cap for any crop so it never exceeds a leaf (+ heading room)

  // TRUE recto/verso over LEAF numbers: leaf 1 is a right-hand page; spreads are (0,1), (2,3), …
  // Resume: the stable address is a BLOCK id (survives re-typesetting at any font/size).
  const posKey = `aq-book-blk:${book.title.slice(0, 60)}:${book.numPages}`;
  const savedBlock = (() => { try { const v = Number(localStorage.getItem(posKey) || ""); return Number.isFinite(v) && v >= 0 ? v : 0; } catch { return 0; } })();
  const restoreBlockRef = useRef<number | null>(savedBlock > 0 ? savedBlock : null);
  const [leftPage, setLeftPage] = useState(0);
  const [mobilePage, setMobilePage] = useState(1);
  const bodyEls = useRef<Map<number, HTMLDivElement>>(new Map()); // live leaf body elements, by leaf number
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const mq = matchMedia("(max-width: 820px)");
    const on = () => setIsMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // Keep the reading position across the form-factor switch (leaf numbers are shared).
  const wasMobile = useRef(isMobile);
  useEffect(() => {
    if (wasMobile.current === isMobile) return;
    wasMobile.current = isMobile;
    if (isMobile) setMobilePage(Math.max(1, leftPage));
    else setLeftPage(mobilePage % 2 === 0 ? mobilePage : mobilePage - 1);
  }, [isMobile]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.documentElement.setAttribute("data-aq-reading", "1");
    const b = document.body.style;
    const prev = { overflow: b.overflow };
    b.overflow = "hidden";
    return () => { document.documentElement.removeAttribute("data-aq-reading"); b.overflow = prev.overflow; };
  }, []);

  useEffect(() => { applyContrast(contrast); }, [contrast]);
  useEffect(() => { closeRef.current?.focus(); }, []);

  // Rewrite one page's HTML for the flow: give each equation figure a page-GLOBAL id, record its
  // crop, and — once OCR'd — REPLACE the crop with static KaTeX (measured correctly by the flow).
  const processHtml = useCallback((n: number, raw: string): string => {
    if (!/data-eq=/.test(raw)) return raw;
    const tpl = document.createElement("template");
    tpl.innerHTML = raw;
    for (const fig of [...tpl.content.querySelectorAll('figure[data-eq]')]) {
      const local = fig.getAttribute("data-eq") || "0";
      const id = `${n}:${local}`;
      const src = fig.querySelector("image")?.getAttribute("href") || "";
      if (src) eqCropsRef.current.set(id, src);
      const katex = eqHtmlRef.current.get(id);
      if (katex) {
        const div = document.createElement("div");
        div.className = "aq-book-eq";
        div.innerHTML = katex;
        fig.replaceWith(div);
      } else {
        fig.setAttribute("data-eq", id);
      }
    }
    return tpl.innerHTML;
  }, []);

  // ── typeset pump: feed PDF pages into the flow until we have leaves beyond the target. Re-entrant
  // safe: a call while pumping QUEUES the target and re-pumps on release (a bare boolean guard
  // deadlocks under StrictMode's double-mount — the aborted first pump left no one to retry). Each
  // iteration re-reads the LIVE flow, so a mid-pump re-typeset just continues into the new flow. ──
  const pendingPumpRef = useRef<number | null>(null);
  const pump = useCallback(async (uptoLeaf: number) => {
    if (pumpingRef.current) { pendingPumpRef.current = Math.max(pendingPumpRef.current ?? 0, uptoLeaf); return; }
    pumpingRef.current = true;
    try {
      for (;;) {
        const flow = flowRef.current;
        if (!flow) break;
        if (!(flow.count < uptoLeaf + LOOKAHEAD && consumedRef.current < book.numPages)) break;
        const n = consumedRef.current + 1;
        const pg = await book.page(n);
        const live = flowRef.current;
        if (!live) break;
        if (live !== flow) continue; // re-typeset underneath us — re-read state and keep going
        consumedRef.current = n;
        live.appendPage(processHtml(n, pg.html));
        setLeafCount(live.count);
        setConsumed(n);
        if (n === book.numPages) setTotalKnown(true);
        await new Promise((r) => setTimeout(r, 0)); // keep the UI thread breathing
      }
      const flow = flowRef.current;
      if (flow) {
        setLeafCount(flow.count);
        if (consumedRef.current === book.numPages) setTotalKnown(true);
        // restore a saved position once enough of the book is typeset to know where it lives
        if (restoreBlockRef.current !== null && (flow.blocks > restoreBlockRef.current || consumedRef.current === book.numPages)) {
          const leaf = flow.leafOf(Math.min(restoreBlockRef.current, Math.max(0, flow.blocks - 1))) + 1;
          restoreBlockRef.current = null;
          setMobilePage(leaf);
          setLeftPage(leaf % 2 === 0 ? leaf : leaf - 1);
        }
      }
    } finally {
      pumpingRef.current = false;
      const p = pendingPumpRef.current;
      pendingPumpRef.current = null;
      if (p !== null) void pump(p);
    }
  }, [book, processHtml]);

  // ── create/re-create the flow when the leaf geometry changes (size, font, form factor) ──
  const rebuildFlow = useCallback(() => {
    const host = overlayRef.current;
    const probe = host?.querySelector(".aq-book-leaf");
    if (!host || !probe) return;
    const r = (probe as HTMLElement).getBoundingClientRect();
    if (r.width < 40 || r.height < 60) return;
    const font = 15 * FONT_STEPS[fontStep];
    const g = geomRef.current;
    if (flowRef.current && Math.abs(g.w - r.width) < 2 && Math.abs(g.h - r.height) < 2 && g.font === font) return;
    geomRef.current = { w: r.width, h: r.height, font };
    setFigMax(Math.max(120, Math.round(r.height - 92))); // leaf height minus padding + a heading's room
    // keep the place: the current left leaf's first block survives the re-typeset
    const old = flowRef.current;
    if (old && old.count) {
      const cur = Math.max(1, isMobile ? mobilePage : leftPage);
      restoreBlockRef.current = old.firstBlockOf(Math.min(cur, old.count) - 1);
    }
    old?.destroy();
    const flow = new BookFlow(host, r.width, r.height, font, book.lang, book.dir);
    flowRef.current = flow;
    consumedRef.current = 0;
    setLeafCount(0);
    setConsumed(0);
    setTotalKnown(false);
    void pump(Math.max(2, isMobile ? mobilePage : leftPage + 1));
  }, [book, fontStep, isMobile, leftPage, mobilePage, pump]);

  const rebuildFlowRef = useRef(rebuildFlow);
  rebuildFlowRef.current = rebuildFlow;
  useLayoutEffect(() => { rebuildFlow(); }, [rebuildFlow]);
  useEffect(() => {
    const on = () => rebuildFlow();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [rebuildFlow]);
  useEffect(() => () => { flowRef.current?.destroy(); flowRef.current = null; }, []);

  // keep the typesetting ahead of the reader
  const currentPage = isMobile ? mobilePage : leftPage;
  useEffect(() => { void pump((isMobile ? mobilePage : leftPage + 1) + 1); }, [leftPage, mobilePage, isMobile, pump, leafCount]);

  // ── CRISP EQUATIONS: OCR every equation crop on-device (texify2) → LaTeX → static KaTeX, then
  // re-typeset once with crisp, theme-native equations. Crops show instantly; this runs once in the
  // background and only if the device can hold the model. Fails soft — the crops simply remain. ──
  useEffect(() => {
    if (enhancedRef.current || !canRun("texify").ok) return;
    enhancedRef.current = true;
    const ctl = new AbortController();
    // StrictMode-safe: if this mount is torn down before the OCR finishes (dev double-mount), release
    // the guard so the remount actually runs it — otherwise the enhancement is aborted forever.
    let completed = false;
    (async () => {
      for (let n = 1; n <= book.numPages; n++) {
        if (ctl.signal.aborted) return;
        const pg = await book.page(n).catch(() => null);
        if (pg) processHtml(n, pg.html); // side effect: records every equation crop into eqCropsRef
      }
      const entries = [...eqCropsRef.current.entries()];
      if (!entries.length || ctl.signal.aborted) return;
      setEqProg({ done: 0, total: entries.length });
      const latexById = new Map<string, string>();
      await ocrEquations(
        entries.map(([, src]) => ({ src })),
        (i, latex) => { latexById.set(entries[i][0], latex); setEqProg((p) => (p ? { ...p, done: p.done + 1 } : p)); },
        ctl.signal,
        (pr) => setEqStatus(pr.status || ""),
      ).catch(() => {});
      await disposeTexify();
      setEqProg(null); setEqStatus("");
      if (ctl.signal.aborted || !latexById.size) return;
      for (const [id, latex] of latexById) {
        const html = await texToHtml(latex, true);
        if (html) eqHtmlRef.current.set(id, html);
      }
      if (ctl.signal.aborted || !eqHtmlRef.current.size) return;
      geomRef.current = { w: 0, h: 0, font: 0 }; // force a re-typeset that swaps crops → KaTeX
      rebuildFlowRef.current();
      completed = true;
    })();
    // Deps are STABLE (book, processHtml) — NOT rebuildFlow, which changes on every page turn and would
    // abort the in-flight OCR on each navigation. rebuildFlow is called through a ref instead.
    return () => { ctl.abort(); if (!completed) enhancedRef.current = false; };
  }, [book, processHtml]);

  // persist the position (block address)
  useEffect(() => {
    const flow = flowRef.current;
    if (!flow || !flow.count) return;
    const cur = Math.max(1, isMobile ? mobilePage : leftPage);
    try { localStorage.setItem(posKey, String(flow.firstBlockOf(Math.min(cur, flow.count) - 1))); } catch { /* blocked */ }
  }, [leftPage, mobilePage, isMobile, posKey, leafCount]);

  /** 1-based leaf html: "" = out of range (blank end-paper), null = still typesetting (spinner). */
  const html = (n: number): string | null => {
    if (n < 1) return "";
    const flow = flowRef.current;
    if (!flow) return null;
    const h = flow.leafHtml(n - 1);
    if (h !== null) return h;
    return totalKnown && n > flow.count ? "" : null;
  };

  const maxLeaf = totalKnown ? leafCount : Infinity;

  // ── LISTEN: the book reads itself, one leaf at a time, and turns its own pages. ──
  const [reading, setReading] = useState(false);
  const [, setReadPage] = useState<number | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const readingRef = useRef(false);
  const stopListenRef = useRef<(() => void) | null>(null);
  const readPageRef = useRef<number | null>(null);
  const advanceTimer = useRef<number>(0);
  const sessionRef = useRef<ReturnType<typeof useArtaTts> | null>(null);

  const startReadingPage = useCallback((page: number, at = 0) => {
    const el = bodyEls.current.get(page);
    if (!el) {
      window.clearTimeout(advanceTimer.current);
      advanceTimer.current = window.setTimeout(() => { if (readingRef.current) startReadingPage(page, at); }, 350);
      return;
    }
    const sents: Sentence[] = sentencesFromRoot(el);
    setReadPage(page); readPageRef.current = page;
    setScrollEl(el);
    if (!sents.length) { advanceFromRef.current?.(page); return; }
    sessionRef.current?.playList(sents, Math.min(at, sents.length - 1));
  }, []);

  const advanceFromRef = useRef<((page: number) => void) | null>(null);
  const goRef = useRef<(d: "next" | "prev") => void>(() => {});
  const autoTurnRef = useRef(false);
  advanceFromRef.current = (page: number) => {
    if (!readingRef.current) return;
    const next = page + 1;
    if (next > maxLeaf) { setReading(false); readingRef.current = false; setReadPage(null); readPageRef.current = null; return; }
    const visible = isMobile ? false : next === leftPage + 1 && page === leftPage;
    if (visible) { startReadingPage(next); return; }
    autoTurnRef.current = true;
    goRef.current("next"); // the book turns its own page…
    window.clearTimeout(advanceTimer.current);
    advanceTimer.current = window.setTimeout(() => { autoTurnRef.current = false; if (readingRef.current) startReadingPage(next); }, FLIP_MS + 200);
  };

  const session = useArtaTts({
    sentences: [],
    lang: book.lang,
    clickRoot: scrollEl,
    clickWhilePlayingOnly: true,
    scrollContainer: scrollEl,
    onEnd: () => { const p = readPageRef.current; if (p !== null) advanceFromRef.current?.(p); },
    onDead: (i) => { const p = readPageRef.current; if (readingRef.current && p !== null) startReadingPage(p, i); },
  });
  sessionRef.current = session;

  const toggleListen = useCallback(() => {
    if (reading) {
      if (session.playing) session.pause(); else session.resume();
      return;
    }
    session.unlock();
    setReading(true); readingRef.current = true;
    const first = isMobile ? mobilePage : Math.max(1, leftPage);
    startReadingPage(first);
  }, [reading, session, isMobile, mobilePage, leftPage, startReadingPage]);
  const stopListen = useCallback(() => {
    window.clearTimeout(advanceTimer.current);
    setReading(false); readingRef.current = false; setReadPage(null); readPageRef.current = null;
    sessionRef.current?.stop();
  }, []);
  stopListenRef.current = stopListen;
  useEffect(() => () => { window.clearTimeout(advanceTimer.current); sessionRef.current?.stop(); }, []);

  // ── navigation with flip animation ──
  const flippingRef = useRef(false);
  const go = useCallback((dir: "next" | "prev") => {
    if (flippingRef.current) return;
    if (readingRef.current && !autoTurnRef.current) stopListenRef.current?.();
    if (isMobile) {
      const target = dir === "next" ? mobilePage + 1 : mobilePage - 1;
      if (target < 1 || target > maxLeaf) return;
      const frontHtml = html(mobilePage) ?? "";
      const backHtml = html(target) ?? "";
      flippingRef.current = true;
      setFlip({ dir, frontHtml, backHtml, underHtml: backHtml });
      window.setTimeout(() => { setMobilePage(target); setFlip(null); flippingRef.current = false; }, FLIP_MS);
      return;
    }
    const target = dir === "next" ? leftPage + 2 : leftPage - 2;
    if (target < 0 || target > maxLeaf) return;
    const front = dir === "next" ? html(leftPage + 1) : html(leftPage);
    const back = dir === "next" ? html(leftPage + 2) : html(leftPage - 1);
    const under = dir === "next" ? html(leftPage + 3) : html(leftPage - 2);
    flippingRef.current = true;
    setFlip({ dir, frontHtml: front ?? "", backHtml: back ?? "", underHtml: under ?? "" });
    window.setTimeout(() => { setLeftPage(target); setFlip(null); flippingRef.current = false; }, FLIP_MS);
  }, [isMobile, leftPage, mobilePage, maxLeaf]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { goRef.current = go; }, [go]);

  // jump straight to a leaf (the slider)
  const jump = useCallback((n: number) => {
    if (readingRef.current) stopListenRef.current?.();
    const v = Math.max(1, Math.round(n));
    setMobilePage(v);
    setLeftPage(v % 2 === 0 ? v : v - 1);
  }, []);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { stopListenRef.current?.(); onClose(); returnFocus?.(); }
      else if (e.key === "l" || e.key === "L") toggleListen();
      else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); go("next"); }
      else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); go("prev"); }
      else if (e.key === "t" || e.key === "T") flipTheme();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const flipTheme = useCallback(() => { const t = toggleTheme(); applyContrast(); setTheme(t); }, []);

  // swipe (touch)
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touch.current || dragRef.current) return;
    const t = e.changedTouches[0], dx = t.clientX - touch.current.x, dy = t.clientY - touch.current.y;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) go(dx < 0 ? "next" : "prev");
    touch.current = null;
  };

  // ── DRAG-TO-TURN: grab a page edge and pull it across like a real book. ──
  const flipElRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<null | { dir: "next" | "prev"; side: "left" | "right"; startX: number; width: number; progress: number; moved: boolean; target: number }>(null);
  const mouseTurnRef = useRef(false); // a mouse interaction owns this turn — the zone's click must not double-fire
  const finishDrag = useCallback((complete: boolean) => {
    const d = dragRef.current, el = flipElRef.current;
    if (!d) return;
    dragRef.current = null;
    const settle = () => {
      if (complete) { if (isMobile) setMobilePage(d.target); else setLeftPage(d.target); }
      setFlip(null); flippingRef.current = false;
    };
    if (!el) { settle(); return; }
    const endDeg = complete ? (d.side === "right" ? -180 : 180) : 0;
    const remaining = complete ? 1 - d.progress : d.progress;
    const ms = Math.max(140, Math.round(FLIP_MS * 0.6 * remaining));
    el.style.transition = `transform ${ms}ms cubic-bezier(.3,.1,.3,1)`;
    el.style.transform = `rotateY(${endDeg}deg)`;
    window.setTimeout(settle, ms + 30);
  }, [isMobile]);
  const beginDrag = useCallback((dir: "next" | "prev", startX: number) => {
    if (flippingRef.current) return;
    if (readingRef.current) stopListenRef.current?.(); // a grabbed page ends the reading
    let target: number;
    let front: string | null, back: string | null, under: string | null;
    if (isMobile) {
      target = dir === "next" ? mobilePage + 1 : mobilePage - 1;
      if (target < 1 || target > maxLeaf) return;
      front = html(mobilePage); back = html(target); under = back;
    } else {
      target = dir === "next" ? leftPage + 2 : leftPage - 2;
      if (target < 0 || target > maxLeaf) return;
      front = dir === "next" ? html(leftPage + 1) : html(leftPage);
      back = dir === "next" ? html(leftPage + 2) : html(leftPage - 1);
      under = dir === "next" ? html(leftPage + 3) : html(leftPage - 2);
    }
    flippingRef.current = true;
    const width = overlayRef.current?.querySelector(".aq-book-book")?.getBoundingClientRect().width || 800;
    const side: "left" | "right" = (rtl && !isMobile) !== (dir === "next") ? "right" : "left";
    dragRef.current = { dir, side, startX, width: isMobile ? width : width / 2, progress: 0, moved: false, target };
    setFlip({ dir, frontHtml: front ?? "", backHtml: back ?? "", underHtml: under ?? "", manual: true });
  }, [isMobile, leftPage, mobilePage, maxLeaf, rtl]); // eslint-disable-line react-hooks/exhaustive-deps
  const dragMove = useCallback((x: number) => {
    const d = dragRef.current, el = flipElRef.current;
    if (!d || !el) return;
    const delta = d.side === "right" ? d.startX - x : x - d.startX; // pull the leaf TOWARD the spine
    if (Math.abs(x - d.startX) > 10) d.moved = true;
    const p = Math.min(1, Math.max(0, delta / (d.width * 1.15)));
    d.progress = p;
    el.style.transition = "none";
    el.style.transform = `rotateY(${(d.side === "right" ? -1 : 1) * 180 * p}deg)`;
  }, []);
  useEffect(() => {
    const up = () => {
      const d = dragRef.current;
      if (!d) return;
      mouseTurnRef.current = true;
      window.setTimeout(() => { mouseTurnRef.current = false; }, 120); // outlives the synthetic click
      if (!d.moved) { // a plain click on the zone — cancel the manual flip and do the animated turn
        const dir = d.dir;
        dragRef.current = null; setFlip(null); flippingRef.current = false;
        go(dir);
        return;
      }
      finishDrag(d.progress > 0.35);
    };
    const move = (e: PointerEvent) => dragMove(e.clientX);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); };
  }, [dragMove, finishDrag, go]);

  const fontScale = FONT_STEPS[fontStep];
  const canPrev = isMobile ? mobilePage > 1 : leftPage > 0;
  const canNext = (isMobile ? mobilePage : leftPage + 1) < Math.min(maxLeaf, leafCount + (totalKnown ? 0 : 1));
  const totalLabel = totalKnown ? String(leafCount) : `${leafCount}+`;
  const pageLabel = isMobile ? `${mobilePage} / ${totalLabel}`
    : leftPage === 0 ? `1 / ${totalLabel}`
    : leftPage >= leafCount && totalKnown ? `${leafCount} / ${totalLabel}`
    : `${leftPage}–${leftPage + 1} / ${totalLabel}`;

  // A rendered leaf; "" renders the blank end-paper, null the typesetting spinner.
  const Leaf = ({ n, side, override }: { n: number; side: "left" | "right"; override?: string | null }) => {
    const h = override !== undefined ? override : html(n);
    if (h === "") return <div className={`aq-book-leaf aq-book-blank aq-book-${side}`} aria-hidden />;
    return (
      <div className={`aq-book-leaf aq-book-${side}`} data-page={n}>
        <div className="aq-book-pageno" aria-hidden>{n}</div>
        {h === null
          ? <div className="aq-book-loading" role="status" aria-label={`Typesetting page ${n}`}>
              <span className="aq-book-spinner" />
              <span className="aq-book-load-cap">Typesetting…</span>
              <span className="aq-book-load-bar"><span style={{ width: `${Math.round((consumed / Math.max(1, book.numPages)) * 100)}%` }} /></span>
              <span className="aq-book-load-sub">{consumed} / {book.numPages} pages</span>
            </div>
          : <div ref={(el) => { hydrateLeaf(el); if (el) bodyEls.current.set(n, el); else bodyEls.current.delete(n); }}
              onScroll={(e) => { const t = e.currentTarget; if (t.scrollTop || t.scrollLeft) { t.scrollTop = 0; t.scrollLeft = 0; } }}
              className="aq-book-body aq-article-body" lang={book.lang} dir={book.dir} dangerouslySetInnerHTML={{ __html: h }} />}
      </div>
    );
  };
  // While a leaf turns, the side it lifts FROM must already show the page that will be under it.
  const leftOverride = flip && !isMobile && flip.dir === "prev" ? flip.underHtml : undefined;
  const rightOverride = flip && !isMobile && flip.dir === "next" ? flip.underHtml : undefined;

  return (
    <div ref={overlayRef} className={`aq-book-overlay${rtl ? " aq-book-rtl" : ""}`} data-theme={theme}
      style={figMax ? ({ ["--book-fig-max" as string]: `${figMax}px` }) : undefined}
      role="dialog" aria-label={`${book.title} — book reader`}>
      {/* Reading progress — a gold hairline across the very top (position in the book) */}
      <span className="aq-book-progress" aria-hidden><span style={{ width: `${leafCount ? Math.round((Math.min(currentPage + (isMobile ? 0 : 1), leafCount) / leafCount) * 100) : 0}%` }} /></span>
      {/* Title strip */}
      <div className="aq-book-topbar">
        <span className="aq-book-eyebrow">ArtaRead · Book</span>
        <span className="aq-book-title" title={book.title}>{book.title}</span>
        {(eqProg || eqStatus) && (
          <span className="aq-book-eqprog" aria-live="polite">
            <span className="aq-book-spinner aq-book-spinner-sm" aria-hidden />
            {eqProg ? `Sharpening equations ${eqProg.done}/${eqProg.total}` : (eqStatus || "Preparing equations…")}
          </span>
        )}
      </div>

      {/* The book */}
      <div
        className={`aq-book-stage ${isMobile ? "aq-book-mobile" : "aq-book-spread"}`}
        style={{ ["--book-font" as string]: String(fontScale) }}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {/* click/drag zones for turning */}
        <button type="button" className="aq-book-turn aq-book-turn-prev" aria-label="Previous page" disabled={!canPrev}
          onPointerDown={(e) => { if (e.pointerType !== "touch") { e.preventDefault(); beginDrag(rtl && !isMobile ? "next" : "prev", e.clientX); } }}
          onClick={() => { if (!mouseTurnRef.current) go(rtl && !isMobile ? "next" : "prev"); }} />
        <button type="button" className="aq-book-turn aq-book-turn-next" aria-label="Next page" disabled={!canNext}
          onPointerDown={(e) => { if (e.pointerType !== "touch") { e.preventDefault(); beginDrag(rtl && !isMobile ? "prev" : "next", e.clientX); } }}
          onClick={() => { if (!mouseTurnRef.current) go(rtl && !isMobile ? "prev" : "next"); }} />

        <div className="aq-book-book">
          {isMobile ? (
            <>
              <Leaf n={mobilePage} side="right" />
              <div className="aq-book-fold" aria-hidden />
            </>
          ) : (
            <>
              <Leaf n={leftPage} side="left" override={leftOverride} />
              <div className="aq-book-spine" aria-hidden />
              <Leaf n={leftPage + 1} side="right" override={rightOverride} />
            </>
          )}

          {/* the turning leaf */}
          {flip && (
            <div ref={flipElRef}
              className={`aq-book-flip aq-book-side-${(rtl && !isMobile) !== (flip.dir === "next") ? "right" : "left"} ${flip.manual ? "aq-book-flip-manual" : `aq-book-flip-${rtl && !isMobile ? (flip.dir === "next" ? "prev" : "next") : flip.dir}`} ${isMobile ? "aq-book-flip-mobile" : ""}`}
              key={`${leftPage}-${mobilePage}-${flip.dir}-${flip.manual ? "m" : "a"}`}>
              <div className="aq-book-flip-face aq-book-flip-front">
                <div ref={hydrateLeaf} className="aq-book-body aq-article-body" lang={book.lang} dir={book.dir} dangerouslySetInnerHTML={{ __html: flip.frontHtml }} />
              </div>
              <div className="aq-book-flip-face aq-book-flip-back">
                <div ref={hydrateLeaf} className="aq-book-body aq-article-body" lang={book.lang} dir={book.dir} dangerouslySetInnerHTML={{ __html: flip.backHtml }} />
              </div>
              <div className="aq-book-flip-shadow" aria-hidden />
            </div>
          )}
        </div>
      </div>

      {/* On-device translation of the paragraph being spoken (voice language ≠ document language) */}
      {reading && (session.translation || session.note || session.pct !== null) && (
        <div className={`aq-book-tr${session.note ? " aq-book-tr-note" : ""}`} dir="auto" aria-live="polite">
          {session.pct !== null && (
            <span className="aq-book-dl">
              <span className="aq-book-load-bar aq-book-dl-bar"><span style={{ width: `${session.pct}%` }} /></span>
              <span className="aq-book-dl-pct">{session.pct}%</span>
            </span>
          )}
          {session.note || session.translation}
        </div>
      )}

      {/* Bottom controls */}
      <div className="aq-book-bar">
        <button ref={closeRef} type="button" className="aq-book-ctl" onClick={() => { stopListen(); onClose(); returnFocus?.(); }} aria-label="Exit book (Esc)" title="Exit (Esc)">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
          <span className="aq-book-label">Exit</span>
        </button>

        <span className="aq-book-nav">
          <button type="button" className="aq-book-ctl" onClick={() => go("prev")} disabled={!canPrev} aria-label="Previous page" title="Previous (←)">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 5l-7 7 7 7" /></svg>
          </button>
          <span className="aq-book-count" aria-live="polite">{pageLabel}</span>
          <input type="range" className="aq-book-jump" min={1} max={Math.max(1, leafCount)} step={1}
            value={Math.min(Math.max(1, isMobile ? mobilePage : Math.max(1, leftPage)), Math.max(1, leafCount))}
            onChange={(e) => jump(Number(e.target.value))}
            aria-label={`Go to page (1 to ${leafCount})`} title="Go to page" />
          <button type="button" className="aq-book-ctl" onClick={() => go("next")} disabled={!canNext} aria-label="Next page" title="Next (→)">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 5l7 7-7 7" /></svg>
          </button>
        </span>

        <span className="aq-book-listen">
          <button type="button" className={`aq-book-ctl${reading ? " aq-book-on" : ""}`} onClick={toggleListen}
            aria-label={reading ? (session.playing ? "Pause reading" : "Resume reading") : "Listen — the book reads itself and turns its own pages"}
            title={reading ? (session.playing ? "Pause (L)" : "Resume (L)") : "Listen (L)"}>
            {reading && session.playing
              ? <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
              : <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>}
            <span className="aq-book-label">Listen</span>
          </button>
          {reading && (
            <button type="button" className="aq-book-ctl aq-book-mini" onClick={stopListen} aria-label="Stop reading" title="Stop">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>
            </button>
          )}
          <select className="aq-book-voice" aria-label="Voice"
            value={session.voice ? ttsVoiceKey(session.voice) : ""}
            onChange={(e) => session.changeVoice(e.target.value)}>
            {VOICE_GROUPS.map((g) => {
              const vs = NEURAL_VOICES.filter((v) => v.lang === g.lang);
              return vs.length ? (
                <optgroup key={g.lang} label={g.label}>
                  {vs.map((v) => <option key={ttsVoiceKey(v)} value={ttsVoiceKey(v)}>{v.name}</option>)}
                </optgroup>
              ) : null;
            })}
          </select>
        </span>

        <span className="aq-book-tools">
          <span className="aq-book-aa" title="Text size">
            <button type="button" className="aq-book-ctl aq-book-mini" onClick={() => setFontStep((s) => Math.max(0, s - 1))} disabled={fontStep === 0} aria-label="Smaller text">A−</button>
            <button type="button" className="aq-book-ctl aq-book-mini" onClick={() => setFontStep((s) => Math.min(FONT_STEPS.length - 1, s + 1))} disabled={fontStep === FONT_STEPS.length - 1} aria-label="Larger text">A+</button>
          </span>
          <button type="button" className="aq-book-ctl" onClick={flipTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`${theme === "dark" ? "Light" : "Dark"} (T)`}>
            {theme === "dark"
              ? <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="12" cy="12" r="4.5" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" /></svg>
              : <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>}
          </button>
          <span className="aq-book-seg" title="Text contrast (Calm ↔ Crisp)">
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" /></svg>
            <input type="range" min={1} max={CONTRAST_LEVELS} step={1} value={contrast} onChange={(e) => { const v = Number(e.target.value); setContrastLvl(v); setContrast(v); }} className="aq-book-crange" aria-label="Text contrast" />
          </span>
          {onSwitchToScroll && (
            <button type="button" className="aq-book-ctl" onClick={() => { stopListen(); onSwitchToScroll(); }} aria-label="Switch to scroll view" title="Scroll view">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8 4h8M8 20h8M6 8h12v8H6z" /></svg>
              <span className="aq-book-label">Scroll</span>
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
