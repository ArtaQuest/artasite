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
export function useTypewriter(body: string, onTick?: () => void, onDone?: () => void, streaming = false) {
  // Words + their trailing whitespace stay paired, so revealed prefixes keep the original spacing.
  // A markdown link ([text with spaces](url)) or inline code (`a b`) counts as ONE token — revealed
  // whole — so the member never sees half its raw syntax flash by mid-reveal.
  // STREAMING-AWARE. `body` used to be a finished reply, snapshotted once; it is now also the LIVE
  // buffer of a turn still being written, which grows between renders. So re-tokenise whenever it
  // grows — holding the revealed index, so the reveal continues from where it was instead of
  // restarting. `streaming` keeps `onDone` from firing at every momentary catch-up: while the answer
  // is still arriving, running out of words means "waiting", not "finished".
  const tokenise = (s: string) => s.match(/(?:`[^`\n]+`|\[[^\]\n]*\]\([^)\n]*\)|\S)+\s*/g) ?? (s ? [s] : []);
  const tokens = useRef<string[]>(tokenise(body));
  const src = useRef(body);
  if (body !== src.current) {
    // A pure prefix-extension is the streaming case; anything else (a corrected or replaced body)
    // re-tokenises from scratch, and the revealed index is clamped so it can never point past the end.
    tokens.current = tokenise(body);
    src.current = body;
  }
  const [n, setN] = useState(1);
  const done = useRef(false);
  const finishOnce = () => { if (!done.current) { done.current = true; onDone?.(); } };
  const finish = () => { setN(tokens.current.length); finishOnce(); };

  useEffect(() => {
    const total = tokens.current.length;
    if (n >= total) {
      // Caught up. Only a turn that is genuinely COMPLETE is done; a streaming one is just waiting
      // for the next slice, and calling onDone here would end the animation mid-answer.
      if (!streaming) finishOnce();
      return;
    }
    const word = tokens.current[n - 1] ?? "";
    const pause = /[.!?:]\s*$/.test(word) ? PAUSE_MS : 0;
    // Catch-up: when a slice lands faster than the reveal, speed up rather than fall behind — the
    // member should never be reading text that arrived seconds ago.
    const behind = total - n;
    const speed = behind > 60 ? 0.15 : behind > 25 ? 0.4 : 1;
    const t = setTimeout(() => { setN((c) => c + 1); onTick?.(); },
      (WORD_MS + Math.random() * WORD_JITTER_MS + pause) * speed);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, body, streaming]);

  return { text: tokens.current.slice(0, n).join(""), finish };
}
