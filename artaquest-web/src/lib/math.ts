/**
 * LaTeX rendering for discussion + article content — render on load, and KEEP it rendered.
 *
 * Two source shapes, one KaTeX dependency:
 *   • Discussion / section bodies: the client renderer (lib/wp.ts `renderRich`) emits math as
 *     <span class="aq-math" data-tex="…"> (inline) / <div class="aq-math aq-math--display" data-tex="…">
 *     (display), carrying the raw "$…$" source as visible fallback text. `renderMathIn` upgrades those.
 *   • Article bodies (Journal of Seasonality): the reviewer ships real `\( … \)` inline + `\[ … \]`
 *     display math inline in the sanitised HTML. `autoRenderMathIn` finds those delimiters and typesets.
 *
 * KaTeX (its JS + CSS + web fonts) is sizeable, so it is loaded lazily — code-split into its own chunk
 * that downloads only the first time a surface actually contains math. That keeps it off the critical
 * path for every non-math surface of the SPA.
 *
 * WHY a watcher (`watchMath`) rather than a one-shot effect: the typeset DOM is fragile. A client-side
 * re-render can re-inject the raw HTML; the i18n engine walks the page and swaps text nodes (it can
 * touch a math-bearing paragraph before KaTeX has run); content can be re-mounted on scroll. Any of
 * these reverts the maths to raw source. `watchMath` typesets on attach AND re-typesets — via a
 * MutationObserver — whenever raw source reappears. It is self-stabilising: once everything is typeset
 * there is no raw math left to find, so the re-runs are cheap no-ops and never loop.
 */
type Katex = typeof import("katex");
type AutoRender = typeof import("katex/contrib/auto-render");

let loader: Promise<Katex> | null = null;

function loadKatex(): Promise<Katex> {
  if (!loader) {
    // Importing the stylesheet from inside the dynamic chunk makes Vite emit the KaTeX CSS (and
    // copy its woff2 fonts) as a separate asset, injected only when this chunk loads.
    loader = Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([katex]) => katex);
  }
  return loader;
}

let autoLoader: Promise<AutoRender> | null = null;

/** Lazy-load KaTeX's auto-render extension (and KaTeX itself + CSS). Cached, so repeated re-typesetting
 *  never re-imports. `katex/contrib/auto-render` is a CommonJS module (`export =`); depending on interop
 *  the callable lands on the namespace itself or on `.default` — accept either. */
function loadAutoRender(): Promise<AutoRender> {
  if (!autoLoader) {
    autoLoader = loadKatex()
      .then(() => import("katex/contrib/auto-render"))
      .then((mod) => {
        const m = mod as unknown as { default: AutoRender } | AutoRender;
        return (typeof m === "function" ? m : m.default) as AutoRender;
      });
  }
  return autoLoader;
}

/** True if `root` contains at least one not-yet-rendered `.aq-math` node — lets callers skip the import. */
export function hasMath(root: HTMLElement | null | undefined): boolean {
  return !!root && root.querySelector(".aq-math:not([data-rendered])") !== null;
}

/** Commands real papers use that KaTeX does not implement. OCR'd LaTeX is full of them, and an
 *  undefined control sequence fails the WHOLE equation, so map the common ones to their equivalents. */
const TEX_MACROS: Record<string, string> = {
  "\\mbox": "\\text{#1}",            // plain-TeX box → KaTeX's \text
  "\\bm": "\\boldsymbol{#1}",
  "\\mathbbm": "\\mathbb{#1}",
  "\\textsc": "\\textrm{#1}",
  "\\eqno": "\\tag{#1}",
  "\\nicefrac": "{}^{#1}\\!/\\!_{#2}",
};

/** Render LaTeX to a STATIC KaTeX HTML string (synchronous once KaTeX is loaded), so it can be
 *  embedded in content that is then measured — the book typesetter needs the equation's real height,
 *  which raw `\[..\]` delimiters (rendered later) don't give.
 *
 *  THROWS ON ERROR BY DESIGN: returns null when the LaTeX doesn't parse, so the caller keeps whatever
 *  it already had. With `throwOnError:false` KaTeX returns RED ERROR HTML instead — which once
 *  replaced a perfectly readable equation crop with raw source in red (operator screenshot). A failed
 *  render must never be shown to a member. */
export async function texToHtml(latex: string, display = true): Promise<string | null> {
  try {
    const katex = await loadKatex();
    return katex.renderToString(latex, {
      displayMode: display, throwOnError: true, output: "htmlAndMathml", trust: false, strict: false,
      macros: TEX_MACROS,
    });
  } catch { return null; }
}

// An inline `\(` or a display `\[` anywhere in the text. After KaTeX typesets, the delimiters are
// consumed (the source survives only inside a `.katex` MathML <annotation>, which carries no `\(`/`\[`),
// so this goes false once everything is rendered — that is what makes the re-typeset a stable no-op.
const MATH_RE = /\\\((?:.|\n)*?\\\)|\\\[(?:.|\n)*?\\\]|\$\$(?:.|\n)+?\$\$|\$(?=\S)(?:[^$\n])+?\$/;

/** True if `root` still holds raw `\(..\)` / `\[..\]` LaTeX that hasn't been typeset. */
export function hasAutoMath(root: HTMLElement | null | undefined): boolean {
  return !!root && MATH_RE.test(root.textContent || "");
}

/**
 * Typeset every un-rendered `.aq-math` node inside `root` with KaTeX. Idempotent (each node is
 * marked data-rendered), safe to call repeatedly, and a no-op — with no KaTeX download — when there
 * is no math to render. Renders from the pristine `data-tex` the renderer stashed (not the visible
 * text), so it survives even if the fallback text was mangled (e.g. by translation). On a parse error
 * KaTeX leaves the raw "$…$" fallback text in place rather than throwing.
 */
export async function renderMathIn(root: HTMLElement | null | undefined): Promise<void> {
  if (!hasMath(root)) return;
  const nodes = Array.from((root as HTMLElement).querySelectorAll<HTMLElement>(".aq-math:not([data-rendered])"));
  const katex = await loadKatex();
  for (const el of nodes) {
    // Prefer the exact TeX the renderer stashed; fall back to stripping the "$"/"$$" delimiters off the text.
    const tex = el.getAttribute("data-tex") || (el.textContent || "").replace(/^\s*\$+/, "").replace(/\$+\s*$/, "");
    el.setAttribute("data-rendered", "1");
    try {
      katex.render(tex, el, {
        displayMode: el.classList.contains("aq-math--display"),
        throwOnError: false,
        output: "htmlAndMathml",
        trust: false,
      });
    } catch {
      /* keep the readable "$…$" fallback already in the node */
    }
  }
}

/**
 * Auto-render LaTeX written inline in a block of HTML (the journal article body, which carries real
 * `\( … \)` inline math, `\[ … \]` displayed math, and `\[ … \tag{n} \]` numbered equations). Uses
 * KaTeX's auto-render extension to find the delimiters in text nodes and typeset them in place.
 *
 * Idempotent and re-runnable: `ignoredClasses` keeps it from re-walking its own `.katex` output, and
 * once the delimiters are consumed `hasAutoMath` is false so a repeat call returns immediately (no
 * KaTeX download, no DOM churn). `trust:false` + macros disabled keep it safe on the already-sanitised
 * server HTML. On failure the raw "\(…\)" text stays in place — still readable, still indexable.
 */
export async function autoRenderMathIn(root: HTMLElement | null | undefined): Promise<void> {
  if (!root || !hasAutoMath(root)) return; // no raw delimiters → nothing to do (also the stable post-render state)
  const renderMathInElement = await loadAutoRender();
  try {
    renderMathInElement(root, {
      delimiters: [
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
      ],
      throwOnError: false,
      trust: false,
      output: "htmlAndMathml",
      // Don't descend into our own end-matter / interactive widgets, nor re-typeset already-rendered math.
      ignoredClasses: ["aq-no-math", "katex"],
    });
  } catch {
    /* raw "\(…\)" stays in place — still readable */
  }
}

/** Is `node` inside (or itself) a typeset `.katex` subtree? Used to ignore KaTeX's own DOM writes. */
function insideKatex(node: Node | null): boolean {
  for (let p: Node | null = node; p; p = p.parentNode) {
    if (p.nodeType === 1 && (p as HTMLElement).classList?.contains("katex")) return true;
  }
  return false;
}

/**
 * Render the math in `root` now, and keep it rendered: a MutationObserver re-typesets whenever the
 * content reverts to raw source (a re-render re-injecting the HTML, the i18n engine swapping a
 * math-bearing text node, a re-mount on scroll, …). Returns a cleanup that disconnects the observer.
 *
 * `mode`: "auto" scans `\(..\)`/`\[..\]` delimiters (article bodies); "nodes" upgrades server-shaped
 * `.aq-math` spans (discussion / section bodies).
 *
 * Self-stabilising and loop-free: a re-typeset only acts while raw math is present, and a pass that
 * finds none makes no DOM change — so the observer is not re-triggered by it. Mutations that are purely
 * KaTeX's own output are ignored as an extra guard. The observer is attached only when the content
 * actually carries math, so a math-free body stays observer-free.
 */
export function watchMath(root: HTMLElement | null | undefined, mode: "auto" | "nodes"): () => void {
  if (!root) return () => {};
  const run = () => void (mode === "auto" ? autoRenderMathIn(root) : renderMathIn(root));
  run(); // initial typeset (a no-op when there is no math, so no KaTeX download on math-free content)
  // THE OBSERVER ATTACHES EVEN WHEN THERE IS NO MATHS YET. It used to bail out here — "nothing to
  // keep alive" — which is true of an article, whose content is all present at attach time, and
  // false of anything LIVE. A chat thread mounts empty and fills by poll, so the one root that most
  // needs watching was the one guaranteed to fail the test: a received equation stayed raw source
  // forever, because nothing was left watching for it to arrive. An observer on a root that never
  // mutates costs nothing (it only runs on mutations), and on a root that does, running is the job.
  let queued = false;
  const obs = new MutationObserver((muts) => {
    if (queued) return;
    // Skip batches that are only KaTeX's own DOM writes — avoids a render → observe → render churn.
    if (!muts.some((m) => !insideKatex(m.target))) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; run(); });
  });
  obs.observe(root, { childList: true, subtree: true, characterData: true });
  return () => obs.disconnect();
}
