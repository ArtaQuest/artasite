// BookFlow — real book TYPESETTING for ArtaRead (operator, 2026-07-24): content is flowed into
// fixed-size leaves with NO scrolling; a paragraph that doesn't fit is SPLIT at the exact word where
// the page ends and continues on the next leaf — so book pages and PDF pages are decoupled, exactly
// like a printed book. Measurement runs in a hidden leaf-sized clone (same width/padding/font), so
// "fits" is the real rendered geometry, not an estimate.
//
// Incremental + append-only: PDF pages feed in one at a time (the lazy openPdf order); sealed leaves
// NEVER change afterwards (flips and positions stay stable) — only the OPEN last leaf keeps filling
// until it overflows. Every top-level block carries a monotonically increasing block id (data-bid),
// which is the stable "content address" used to keep the reading position across re-pagination
// (font-size change, rotation) and for resume.

export type FlowLeafInfo = { html: string; firstBlock: number };


export class BookFlow {
  private measurer: HTMLDivElement;
  private sealed: FlowLeafInfo[] = [];
  private openFirst = -1;              // first block id of the open leaf (-1 = no open leaf)
  private lastHeading: HTMLElement | null = null; // widow guard: a heading never ends a leaf
  private blockId = 0;
  private destroyed = false;

  constructor(host: HTMLElement, widthPx: number, heightPx: number, fontPx: number, lang: string, dir: string) {
    const m = document.createElement("div");
    m.className = "aq-book-body aq-article-body aq-book-measure";
    // Measure a FULL LINE shy of the true leaf: real rendering drifts from the hidden measurer by up
    // to ~a line (sub-pixel accumulation, font metrics), and a book page wants bottom breathing room —
    // this guarantees the last line never clips. Padding is set EXPLICITLY (same numbers the leaf's
    // clamp() resolves to against the LEAF width): the measurer's own %-padding would resolve against
    // its positioned ancestor — the full-width overlay — and measure every figure at the wrong width.
    const padSide = Math.min(Math.max(16, widthPx * 0.045), 41.6);
    const padTop = Math.min(Math.max(16, widthPx * 0.032), 35.2);
    const safety = Math.max(28, Math.ceil(fontPx * 1.75)); // ≥ one line of the current size
    m.style.cssText = `position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;overflow:hidden;` +
      `width:${widthPx}px;height:${Math.max(80, heightPx - safety)}px;font-size:${fontPx}px;` +
      `padding:${padTop}px ${padSide}px 32px;`;
    m.lang = lang; m.dir = dir;
    host.appendChild(m);
    this.measurer = m;
  }

  destroy(): void { this.destroyed = true; this.measurer.remove(); }

  /** Total leaves so far (sealed + the open one). */
  get count(): number { return this.sealed.length + (this.openFirst >= 0 ? 1 : 0); }
  /** Highest block id assigned so far (exclusive). */
  get blocks(): number { return this.blockId; }

  /** 0-based leaf html; the open leaf reads live from the measurer. */
  leafHtml(i: number): string | null {
    if (i < this.sealed.length) return this.sealed[i].html;
    if (i === this.sealed.length && this.openFirst >= 0) return this.measurer.innerHTML;
    return null;
  }

  firstBlockOf(i: number): number {
    if (i < this.sealed.length) return this.sealed[i].firstBlock;
    if (i === this.sealed.length && this.openFirst >= 0) return this.openFirst;
    return 0;
  }

  /** The leaf (0-based) containing block id `b`, or the last leaf if past the end so far. */
  leafOf(b: number): number {
    for (let i = 0; i < this.sealed.length; i++) {
      const next = i + 1 < this.sealed.length ? this.sealed[i + 1].firstBlock : this.openFirst >= 0 ? this.openFirst : Infinity;
      if (b < next) return i;
    }
    return Math.max(0, this.count - 1);
  }

  private fits(): boolean { return this.measurer.scrollHeight <= this.measurer.clientHeight + 1; }

  private seal(): void {
    if (this.openFirst < 0) return;
    this.sealed.push({ html: this.measurer.innerHTML, firstBlock: this.openFirst });
    this.measurer.innerHTML = "";
    this.openFirst = -1;
    this.lastHeading = null;
  }

  private place(node: HTMLElement): void {
    if (this.openFirst < 0) this.openFirst = Number(node.dataset.bid ?? this.blockId);
    this.measurer.appendChild(node);
  }

  /** Flow one extracted PDF page's html into the leaves. Returns the number of NEW sealed leaves. */
  appendPage(pageHtml: string): number {
    if (this.destroyed) return 0;
    const before = this.sealed.length;
    const tpl = document.createElement("template");
    tpl.innerHTML = pageHtml;
    const blocks = [...tpl.content.children].filter((el): el is HTMLElement => el instanceof HTMLElement);
    for (const el of blocks) {
      el.dataset.bid = String(this.blockId++);
      this.flowBlock(el);
    }
    return this.sealed.length - before;
  }

  private flowBlock(el: HTMLElement): void {
    this.place(el);
    if (this.fits()) { this.lastHeading = /^H\d$/.test(el.tagName) ? el : null; return; }
    this.measurer.removeChild(el);

    // widow guard: a heading must not be the last thing on a leaf — carry it to the next leaf with
    // its following block, so a section title never dangles at a page bottom.
    const heading = this.lastHeading && this.lastHeading.parentElement === this.measurer ? this.lastHeading : null;
    if (heading) this.measurer.removeChild(heading);
    this.lastHeading = null;

    // A PARAGRAPH with no carried heading splits IN PLACE — its first part fills the current leaf's
    // remaining space, the rest flows on (normal book flow, leaves stay full). Anything else — a
    // figure/table crop (unsplittable, must not be squeezed on top of existing content) or a
    // paragraph led by a carried heading (widow guard: the heading leads the NEXT leaf WITH it) —
    // seals the current leaf and continues on a fresh one. The heading+300-word "References"
    // paragraph and the cover sheet's stacked figures both need this seal-first path.
    const splitInPlace = el.tagName === "P" && !heading;
    if (!splitInPlace) { if (this.openFirst >= 0) this.seal(); if (heading) this.place(heading); }
    this.placeOrSplit(el);
  }

  /** Put `el` on the CURRENT (fresh) leaf. If it overflows, split a paragraph at the exact fitting
   *  word (recursing the remainder) or squeeze an oversized figure — so content NEVER clips. */
  private placeOrSplit(el: HTMLElement): void {
    this.place(el);
    if (this.fits()) { this.lastHeading = /^H\d$/.test(el.tagName) ? el : null; return; }

    if (el.tagName === "P") {
      const words = (el.textContent || "").split(/\s+/).filter(Boolean);
      // binary-search the most words that fit here (a heading may already lead this leaf, so measure
      // in place). The remainder flows on — possibly splitting again for a very long list/paragraph.
      el.textContent = "";
      let lo = 1, hi = words.length, k = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        el.textContent = words.slice(0, mid).join(" ");
        if (this.fits()) { k = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      if (k >= 1 && k < words.length) {
        el.textContent = words.slice(0, k).join(" ");
        this.seal();
        const rest = el.cloneNode(false) as HTMLElement;
        rest.textContent = words.slice(k).join(" ");
        rest.dataset.bid = el.dataset.bid || "";
        rest.dataset.cont = "1"; // continuation — no drop-cap
        this.flowBlock(rest);
        return;
      }
      // k === 0: not even one word fits in the leaf's REMAINING space (the leaf is nearly full from
      // earlier content — e.g. the last author line after the cover sheet's figures). Seal the leaf
      // and place the whole paragraph on a FRESH one, where it fits (or splits properly). A fresh
      // leaf always fits ≥1 word, so this can't loop.
      this.measurer.removeChild(el);
      if (this.openFirst >= 0) this.seal();
      el.textContent = words.join(" ");
      this.placeOrSplit(el);
      return;
    }

    // FIGURE / table / equation crop — capped to the leaf height by CSS (--book-fig-max), so it fits
    // on its own leaf. The centring class balances it in the leftover space.
    if (el.tagName === "FIGURE") el.classList.add("aq-book-squeeze");
    this.lastHeading = null;
  }
}
