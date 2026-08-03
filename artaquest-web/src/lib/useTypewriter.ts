import { useEffect, useRef, useState } from "react";

// ── Typewriter reveal ──────────────────────────────────────────────────────────
// A fresh ArtaBot reply types itself out word by word instead of appearing all at once — the wait for
// the answer (which can stretch when a turn is relayed through the operator's laptop) reads as ArtaBot
// composing, not the app stalling. Shared by the floating ArtaBot chat and the contribution thread
// (#76) so both surfaces reveal at the same cadence; only a JUST-RECEIVED reply animates, history
// renders instantly.
//
// Render-agnostic: the hook returns the revealed PREFIX of `body` plus a `finish` that skips to the
// end. The caller decides how to render that prefix — ArtaBot wraps it in RichText (Markdown), the
// contribution thread renders it as plain text. EITHER WAY the caller must keep the revealing text out
// of the i18n mesh (a `data-ay-skip` ancestor: RichText without `srcLang`, or a marked plain span), so
// half-sentences are never collected — or worse, cached — as translations; the finished message,
// rendered normally by the parent once `onDone` fires, then translates as usual.
const WORD_MS = 38;        // base delay per word — brisk but legible
const WORD_JITTER_MS = 40; // randomness so the rhythm feels human, not metronomic
const PAUSE_MS = 180;      // extra breath after sentence-ending punctuation

/** Word-by-word reveal of `body`. `onTick` fires after each word (e.g. to follow-scroll); `onDone`
 *  fires exactly once, when the reveal finishes or is skipped. Returns the revealed `text` so far and
 *  a `finish` to jump straight to the end (wire it to a click so a member can skip the animation). */
export function useTypewriter(body: string, onTick?: () => void, onDone?: () => void) {
  // Words + their trailing whitespace stay paired, so revealed prefixes keep the original spacing.
  // A markdown link ([text with spaces](url)) or inline code (`a b`) counts as ONE token — revealed
  // whole — so the member never sees half its raw syntax flash by mid-reveal.
  const tokens = useRef(body.match(/(?:`[^`\n]+`|\[[^\]\n]*\]\([^)\n]*\)|\S)+\s*/g) ?? [body]).current;
  const [n, setN] = useState(1);
  const done = useRef(false);
  const finishOnce = () => { if (!done.current) { done.current = true; onDone?.(); } };
  const finish = () => { setN(tokens.length); finishOnce(); };

  useEffect(() => {
    if (n >= tokens.length) { finishOnce(); return; }
    const word = tokens[n - 1] ?? "";
    const pause = /[.!?:]\s*$/.test(word) ? PAUSE_MS : 0;
    const t = setTimeout(() => { setN((c) => c + 1); onTick?.(); }, WORD_MS + Math.random() * WORD_JITTER_MS + pause);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);

  return { text: tokens.slice(0, n).join(""), finish };
}
