// ArtaRead — read ANY PDF with the platform reader. The member drops a PDF; it is parsed entirely
// ON THIS DEVICE (pdf.js — the file never uploads anywhere), rebuilt as a clean themed article, and
// opened in the SHARED ReadMode overlay — which brings dark/light theme flipping, ArtaContrast
// contrast steps, the Aa typography panel, ArtaTTS paragraph read-aloud, and the on-device
// translator (pick a voice in another language → translate → show → speak). One reader everywhere.
import { useCallback, useRef, useState } from "react";
import { ReadMode, type ReaderDoc } from "../components/reader";
import { BookReader } from "../components/book";
import { extractPdfArticle, openPdf, type PdfArticle, type PdfBook } from "../lib/pdf-extract";
import { captionFigures } from "../lib/pdf-caption";
import { ocrEquations, buildLatexZip, disposeTexify } from "../lib/pdf-latex";
import { autoRenderMathIn } from "../lib/math";
import { useEffect } from "react";

type LiveArticle = PdfArticle & { done: boolean };

export default function ArtaRead() {
  const [art, setArt] = useState<LiveArticle | null>(null);
  const [book, setBook] = useState<PdfBook | null>(null);
  const [mode, setMode] = useState<"book" | "scroll">("book"); // the book (2-page spread) is the default
  const fileRef2 = useRef<File | null>(null); // the current PDF, kept so we can build the OTHER mode on toggle
  useEffect(() => { document.title = "ArtaRead — read, translate and listen to any PDF · ArtaQuest"; }, []);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState("");
  const [drag, setDrag] = useState(false);
  const openBtnRef = useRef<HTMLButtonElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // texify2 LaTeX per equation id + Florence captions per figure id — feed the reader swap AND the export
  const eqTexRef = useRef(new Map<number, string>());
  const capsRef = useRef(new Map<number, string>());
  const [eqDone, setEqDone] = useState(0);
  const [zipBusy, setZipBusy] = useState(false);

  // Build the continuous SCROLL article (full extraction + streaming). Used by scroll mode.
  const loadScroll = useCallback(async (file: File) => {
    setBusy(true); setErr(""); setPct(0);
    eqTexRef.current = new Map(); capsRef.current = new Map(); setEqDone(0);
    // PAGE-BY-PAGE: the extractor streams each converted page; the reader opens on page 1 and grows.
    // Flushes follow an exponential page schedule (1, 2, 4, 8…) so re-rendering the article body stays
    // O(n log n) on huge documents instead of O(n²) — content-visibility keeps paint cost flat.
    const frags: string[] = [];
    let nextFlush = 1;
    const provisional = file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim() || "Your PDF";
    try {
      const a = await extractPdfArticle(file, setPct, (frag, page, total) => {
        frags.push(frag);
        const partial = frags.join("\n");
        if (page >= nextFlush && partial.length > 300) {
          nextFlush = page * 2;
          setArt({
            title: provisional, lang: "en", dir: "ltr", chars: partial.length, figures: [], pages: total,
            eqs: [], tables: [], outline: [],
            html: partial + `<p role="status">Converting page ${page} of ${total}…</p>`, done: false,
          });
        }
      });
      if (a.chars < 200) { setArt(null); setErr("This PDF has no readable text (it may be a scan of images). ArtaRead needs a text PDF."); return; }
      setArt({ ...a, done: true });
    } catch (e) {
      setArt(null);
      setErr("Could not read this PDF — " + (e instanceof Error ? e.message : "it may be corrupted or password-protected."));
    } finally { setBusy(false); }
  }, []);

  // Open a dropped/chosen PDF → the BOOK by default (fast: openPdf only does the text pre-pass; pages
  // extract lazily as you turn). Scroll mode is built on demand when the reader toggles to it.
  const open = useCallback(async (file: File | undefined | null) => {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { setErr("That doesn't look like a PDF."); return; }
    fileRef2.current = file; setErr(""); setArt(null); setBook(null); setMode("book");
    setBusy(true); setPct(0);
    try {
      const b = await openPdf(file, setPct);
      setBook(b);
    } catch (e) {
      setErr("Could not read this PDF — " + (e instanceof Error ? e.message : "it may be corrupted or password-protected."));
    } finally { setBusy(false); }
  }, []);

  // Toggle: book → scroll builds the scroll article if not already built; scroll → book reuses the book.
  const toScroll = useCallback(() => { setMode("scroll"); if (!art && fileRef2.current) loadScroll(fileRef2.current); }, [art, loadScroll]);
  const toBook = useCallback(() => { setMode("book"); }, []);
  const closeReader = useCallback(() => { setArt(null); setBook(null); fileRef2.current = null; setMode("book"); openBtnRef.current?.focus(); }, []);

  // Background model passes — STRICTLY SERIAL (one heavy model resident at a time, per the memory
  // budget): 1) texify2 reads each equation crop → the pixel crop is SWAPPED live for KaTeX-typeset
  // math (selectable, theme-native) and the LaTeX feeds the export; 2) Florence-2 captions each
  // figure into its <img alt>. Reading never waits on either; crops stay wherever a pass fails.
  useEffect(() => {
    if (!art?.done || (!art.eqs.length && !art.figures.length)) return;
    const ctl = new AbortController();
    (async () => {
      await ocrEquations(
        art.eqs,
        (i, latex) => {
          eqTexRef.current.set(i, latex);
          setEqDone(eqTexRef.current.size);
          const fig = document.querySelector(`figure[data-eq="${i}"]`);
          if (fig) {
            const p = document.createElement("p");
            p.className = "aq-eq-tex";
            p.textContent = `\\[ ${latex} \\]`;
            fig.replaceChildren(p);
            fig.className = "aq-eq-native"; // shed the crop styling (virtualised sizing, dark invert)
            fig.removeAttribute("data-invert");
            void autoRenderMathIn(fig as HTMLElement);
          }
        },
        ctl.signal,
      ).catch(() => { /* OCR unavailable (offline/low-memory) — pixel crops remain */ });
      if (ctl.signal.aborted) return;
      // free texify2 (~1.5 GB) BEFORE the captioner (~1.8 GB) loads — one heavy model resident at a time
      if (art.figures.length) await disposeTexify();
      await captionFigures(
        art.figures,
        (i, caption) => {
          capsRef.current.set(i, caption);
          for (const el of document.querySelectorAll(`[data-cap="${i}"]`)) {
            el.closest("svg")?.setAttribute("aria-label", "Figure: " + caption);
            (el.closest("figure") || el).setAttribute("title", caption);
          }
        },
        ctl.signal,
      ).catch(() => { /* captioner unavailable — generic alts remain */ });
    })();
    return () => ctl.abort();
  }, [art]);

  const downloadTex = useCallback(async () => {
    if (!art?.done || zipBusy) return;
    setZipBusy(true);
    try {
      const blob = await buildLatexZip(art, eqTexRef.current, capsRef.current);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (art.title || "article").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) + "-latex.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    } finally { setZipBusy(false); }
  }, [art, zipBusy]);

  // BOOK mode — the two-page spread (default). Renders once openPdf resolves.
  if (mode === "book" && book) {
    return <BookReader book={book} onClose={closeReader} onSwitchToScroll={toScroll} returnFocus={() => openBtnRef.current?.focus()} />;
  }

  // SCROLL mode — the continuous reader with LaTeX export + equation OCR + captions.
  if (mode === "scroll" && art) {
    const doc: ReaderDoc = {
      id: 0,
      title: art.title,
      eyebrow: art.done ? "ArtaRead · Your PDF" : `ArtaRead · converting… ${pct}%`,
      license: "Read privately on this device",
      lang: art.lang,
      dir: art.dir,
      posNs: "artaread",
    };
    const actions = (
      <>
        <button type="button" onClick={toBook} className="aq-read-ctl" aria-label="Read as a book" title="Book view (two-page spread)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v15M4 5h6a2 2 0 0 1 2 2M20 5h-6a2 2 0 0 0-2 2M4 5v13h6M20 5v13h-6" /></svg>
          <span className="aq-read-label">Book</span>
        </button>
        {art.done && (
          <button type="button" onClick={downloadTex} disabled={zipBusy} className="aq-read-ctl"
            aria-label="Download this document as LaTeX"
            title={`Download as LaTeX (.tex + figures)${art.eqs.length ? ` — ${eqDone}/${art.eqs.length} equations read` : ""}`}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3v12M7 10l5 5 5-5M4 19h16" /></svg>
            <span className="aq-read-label">{zipBusy ? "Packing…" : "LaTeX"}</span>
          </button>
        )}
      </>
    );
    return <ReadMode s={doc} body={art.html} actions={actions} onClose={closeReader} returnFocus={() => openBtnRef.current?.focus()} />;
  }

  // A PDF is loading into the chosen mode (book: openPdf pre-pass; scroll: still extracting).
  if (fileRef2.current && (busy || (mode === "book" && !book) || (mode === "scroll" && !art))) {
    return (
      <div className="mx-auto flex min-h-[60vh] w-full max-w-2xl flex-col items-center justify-center py-10 text-center">
        <span className="aq-book-spinner" style={{ width: 30, height: 30 }} />
        <p className="mt-4 text-[14px] font-semibold text-ink">Opening your book…</p>
        <span className="mt-3 inline-block h-1 w-56 overflow-hidden rounded-full bg-space-2"><span className="block h-full rounded-full bg-yang transition-[width] duration-300" style={{ width: `${pct}%` }} /></span>
        <p className="mt-2 text-[12px] tabular-nums text-ink-3">{pct}%</p>
        <p className="mt-1 text-[12.5px] text-ink-3">Read entirely on your device</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl py-10">
      <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">ArtaRead</p>
      <h1 className="mt-1 text-[26px] font-extrabold text-ink">Read any PDF — listened, translated, yours</h1>
      <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2">
        Drop a PDF and it opens in the ArtaQuest reader: light or dark with ArtaContrast steps, the Aa
        typography panel, paragraph-by-paragraph read-aloud, and on-device translation — pick a voice in
        another language and each paragraph is translated, shown, then spoken.
        <strong> The file is read entirely on this device and never uploaded.</strong>
      </p>
      <div
        role="button" tabIndex={0} aria-label="Choose a PDF to read"
        onClick={() => fileRef.current?.click()}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileRef.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); open(e.dataTransfer.files?.[0]); }}
        className={`mt-6 flex min-h-[11rem] cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-colors ${drag ? "border-yin bg-space-2" : "border-line hover:border-yin"}`}
      >
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ink-3"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M12 18v-6M9.5 14.5 12 12l2.5 2.5" /></svg>
        {busy ? (
          <>
            <p className="text-[14px] font-semibold text-ink">Reading your PDF… {pct}%</p>
            <span className="inline-block h-1 w-48 overflow-hidden rounded-full bg-space-2"><span className="block h-full bg-yang transition-[width] duration-300" style={{ width: `${pct}%` }} /></span>
          </>
        ) : (
          <>
            <p className="text-[14px] font-semibold text-ink">Drop a PDF here, or tap to choose</p>
            <p className="text-[12.5px] text-ink-3">Stays on your device · text PDFs (not scans)</p>
          </>
        )}
        <button ref={openBtnRef} type="button" className="sr-only">Choose a PDF</button>
      </div>
      <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => { open(e.target.files?.[0]); e.target.value = ""; }} />
      {err && <p className="mt-3 text-[13.5px] text-ink-2" role="alert">{err}</p>}
    </div>
  );
}
