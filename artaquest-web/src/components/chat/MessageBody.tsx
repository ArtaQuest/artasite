import { useState } from "react";
import { escHtml, hlJS, hlPython } from "../../lib/highlight";

/**
 * A message, rendered for people who write about science.
 *
 * Three things a research conversation needs that plain text cannot give: an equation that reads as
 * an equation, code that keeps its shape and its tokens, and both of them legible next to ordinary
 * prose. This turns one decrypted string into exactly that and nothing more.
 *
 * WHAT IT IS NOT: a Markdown renderer. Message text is written by the other party, so every feature
 * is an attack surface — no links, no images, no HTML, no tables. The whole grammar is fenced code,
 * inline code, and LaTeX delimiters, because those are what the maths and the code need and the rest
 * is risk without a reason.
 *
 * SAFETY. Nothing here trusts its input. Prose is emitted as React TEXT NODES, never as HTML, so it
 * cannot inject anything. Code is the only path that produces markup, and it goes through
 * lib/highlight, which escapes every segment it emits — including the parts it does not tokenise.
 *
 * MATHS IS DELIBERATELY NOT PARSED HERE. The delimiters are left in the text and KaTeX typesets them
 * afterwards (lib/math `watchMath`, already watching the message scroller). That keeps ONE maths
 * implementation for the whole platform, and it is why code is wrapped in <pre><code>: KaTeX's
 * auto-render skips those tags, so a `$` inside a shell command stays a `$` instead of becoming an
 * equation.
 */

/** ```lang … ``` — the language is optional and only used to pick a grammar. */
const FENCE = /```([A-Za-z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/g;
/** `inline` — single backticks, no newlines, so a stray backtick in prose cannot swallow a paragraph. */
const INLINE = /`([^`\n]+)`/g;

/** Which grammar to highlight with. Anything we cannot highlight is still shown as code — monospace
 *  and preserved whitespace are most of the value; colour is the bonus. */
function highlight(lang: string, src: string): string {
  const l = lang.toLowerCase();
  if (l === "js" || l === "javascript" || l === "ts" || l === "typescript" || l === "json") return hlJS(src);
  if (l === "" || l === "py" || l === "python" || l === "r" || l === "julia" || l === "matlab") return hlPython(src);
  return escHtml(src);
}

function CodeBlock({ lang, src }: { lang: string; src: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="mt-1.5 block first:mt-0">
      <span className="flex items-center gap-2 rounded-t-card border border-b-0 border-line bg-space-1 px-2.5 py-1">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-3">{lang || "code"}</span>
        <button type="button"
          onClick={() => {
            navigator.clipboard?.writeText(src).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }).catch(() => undefined);
          }}
          className="ms-auto rounded px-1.5 py-0.5 text-[10.5px] font-semibold text-ink-3 hover:bg-veil/[0.08] hover:text-ink">
          {copied ? "Copied" : "Copy"}
        </button>
      </span>
      {/* <pre> both preserves the code's shape AND keeps KaTeX out of it. `aq-code` carries the
          monospace stack and the no-ligature rule — see index.css for why that matters. */}
      <pre className="aq-code overflow-x-auto rounded-b-card border border-line bg-space-1 px-2.5 py-2 text-[13px] leading-[1.55]"><code dangerouslySetInnerHTML={{ __html: highlight(lang, src) }} /></pre>
    </span>
  );
}

/**
 * REAL maths, by the no-adjacent-space rule.
 *
 * `$E = mc^2$` is an equation. `$5 and $9` is money, and `spend $5 on $HOME` is a shell variable —
 * but a plain `$…$` matcher pairs the first dollar with the next one and typesets the words between
 * them, which is exactly what happened the first time this shipped ("shell price is 5and9", in
 * italics). The rule every careful implementation lands on: the delimiters must not have whitespace
 * immediately inside them. `$5 and $` fails because the run ends on a space, so it stays text.
 */
const MATHS = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?![\s$])(?:[^$\n]*?[^\s$])?\$/g;

/**
 * Prose: inline code lifted out, real maths left for KaTeX, and every OTHER dollar sign isolated.
 *
 * The isolation is the load-bearing part. KaTeX's auto-render walks TEXT NODES, so a `$` that sits
 * in an element of its own can never be paired with another one — which is how a stray dollar is
 * kept out of the maths pass without touching the platform's single maths implementation.
 */
function Prose({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let key = 0;

  /** Emit a run that contains no maths: inline code becomes <code>, loose `$` become their own span. */
  const plain = (chunk: string) => {
    let last = 0;
    let m: RegExpExecArray | null;
    INLINE.lastIndex = 0;
    const pushText = (t: string) => {
      // Split on every dollar so each one lands in its own element.
      const bits = t.split("$");
      bits.forEach((b, i) => {
        if (b) out.push(b);
        if (i < bits.length - 1) out.push(<span key={`d${key++}`}>$</span>);
      });
    };
    while ((m = INLINE.exec(chunk))) {
      if (m.index > last) pushText(chunk.slice(last, m.index));
      out.push(
        <code key={`c${key++}`} className="aq-code rounded bg-veil/[0.10] px-1 py-px text-[0.92em]">{m[1]}</code>,
      );
      last = m.index + m[0].length;
    }
    if (last < chunk.length) pushText(chunk.slice(last));
  };

  let last = 0;
  let m: RegExpExecArray | null;
  MATHS.lastIndex = 0;
  while ((m = MATHS.exec(text))) {
    if (m.index > last) plain(text.slice(last, m.index));
    out.push(m[0]);   // a text node, delimiters intact — watchMath typesets it
    last = m.index + m[0].length;
  }
  if (last < text.length) plain(text.slice(last));
  return <span className="whitespace-pre-wrap break-words" dir="auto">{out}</span>;
}

export function MessageBody({ text }: { text: string }) {
  if (!text) return null;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  FENCE.lastIndex = 0;
  while ((m = FENCE.exec(text))) {
    if (m.index > last) parts.push(<Prose key={`p${last}`} text={text.slice(last, m.index)} />);
    parts.push(<CodeBlock key={`k${m.index}`} lang={m[1]} src={m[2].replace(/\n$/, "")} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<Prose key={`p${last}`} text={text.slice(last)} />);
  return <>{parts}</>;
}
