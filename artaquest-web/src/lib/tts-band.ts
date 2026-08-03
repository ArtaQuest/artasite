// ArtaTTS sentence band — the calm, eye-friendly read-along highlight. Instead of flashing a new WORD
// several times a second, ArtaTTS lights the CURRENT SENTENCE as a single soft gold gradient band and
// lets ONE CSS transition glide it to the next sentence (operator, 2026-07-20: "sentence by sentence,
// transitioned smoothly with a gradient; minimise frame-by-frame gradients to ease it for the eye").
//
// The band is a single absolutely-positioned element inside the scroll container, so it scrolls WITH the
// text for free (no scroll listener, no per-frame work) and only moves when the SENTENCE changes — the
// browser eases transform/size/opacity in one composited animation. Under reduced-motion / the strictest
// Motion-calm stop it jumps instantly (no animation), honouring the platform's motion-safety contract.

const PAD = 3; // px of breathing room around the sentence text
const TRANS = "transform .42s cubic-bezier(.4,0,.2,1), width .42s cubic-bezier(.4,0,.2,1), height .42s cubic-bezier(.4,0,.2,1), opacity .3s ease";

export class SentenceBand {
  private el: HTMLDivElement;
  private win: boolean;
  private scroller: HTMLElement | null;
  private restorePos: string | null = null;

  constructor(scroller: HTMLElement | Window) {
    this.win = scroller === window || !(scroller instanceof HTMLElement);
    this.scroller = this.win ? null : (scroller as HTMLElement);
    const host: HTMLElement = this.win ? document.body : (scroller as HTMLElement);
    // The band is absolute-positioned; its host must establish a positioning context so it scrolls with
    // the content. body (document ICB) already works; a static scroll container gets a temporary relative.
    if (!this.win && this.scroller) {
      const pos = getComputedStyle(this.scroller).position;
      if (pos === "static") { this.restorePos = this.scroller.style.position; this.scroller.style.position = "relative"; }
    }
    const el = document.createElement("div");
    el.className = "aq-tts-band";
    el.setAttribute("aria-hidden", "true");
    el.style.cssText =
      "position:absolute;top:0;left:0;pointer-events:none;z-index:0;opacity:0;border-radius:7px;" +
      // Soft vertical gold gradient — a gentle "reading zone", the brand token in both themes.
      "background:linear-gradient(180deg,color-mix(in srgb,var(--color-yang) 24%,transparent),color-mix(in srgb,var(--color-yang) 12%,transparent));" +
      "box-shadow:0 0 0 1px color-mix(in srgb,var(--color-yang) 14%,transparent);" +
      `will-change:transform,width,height,opacity;transition:${TRANS};`;
    host.appendChild(el);
    this.el = el;
  }

  /** Move+resize the band to cover `range`'s bounding box. Glides smoothly between VISIBLE sentences;
   *  APPEARING from hidden (first play, replay after stop) is placed instantly and only the opacity
   *  fades — so the band never streaks across the page from its last/origin position. `animate=false`
   *  (calm mode / reduced-motion) always jumps instantly. */
  show(range: Range, animate: boolean): void {
    const r = range.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) return;
    let top: number, left: number;
    if (this.win) { top = r.top + window.scrollY; left = r.left + window.scrollX; }
    else {
      const cr = this.scroller!.getBoundingClientRect();
      top = r.top - cr.top - this.scroller!.clientTop + this.scroller!.scrollTop;
      left = r.left - cr.left - this.scroller!.clientLeft + this.scroller!.scrollLeft;
    }
    const appearing = this.el.style.opacity !== "1"; // hidden → place instantly, fade opacity only
    const glide = animate && !appearing;
    this.el.style.transition = glide ? TRANS : "none";
    this.el.style.transform = `translate(${Math.round(left - PAD)}px, ${Math.round(top - PAD)}px)`;
    this.el.style.width = `${Math.round(r.width + PAD * 2)}px`;
    this.el.style.height = `${Math.round(r.height + PAD * 2)}px`;
    if (!glide) { void this.el.offsetWidth; this.el.style.transition = TRANS; } // restore for the next glide
    this.el.style.opacity = "1"; // opacity keeps its transition (a gentle fade-in) in all cases
  }

  hide(): void { this.el.style.opacity = "0"; }

  destroy(): void {
    this.el.remove();
    if (this.restorePos !== null && this.scroller) this.scroller.style.position = this.restorePos;
  }
}
