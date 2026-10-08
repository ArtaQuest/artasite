/** Private details that must never travel into a public GitHub issue, even if a member posted them. */
export function redact(s: string): string {
  return String(s)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email removed]")
    .replace(/(?<![\w/])\+?\d[\d\s().-]{7,}\d(?![\w/])/g, "[number removed]");
}

/** Trim to max chars on a word boundary with an ellipsis — the same rule as Arta::clip. */
export function clip(s: string, max: number): string {
  const t = String(s).replace(/[ \t]+/g, " ").trim();
  if ([...t].length <= max) return t;
  let cut = [...t].slice(0, Math.max(1, max - 1)).join("");
  const sp = cut.lastIndexOf(" ");
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  return cut.replace(/[ ,;:.\-–—]+$/, "") + "…";
}

/** The member's words with the leading @handles and the "bug:" marker removed. */
export function stripLead(s: string): string {
  return String(s)
    .replace(/^(\s*(hey|hi|hello)?[\s,]*@[A-Za-z0-9-]+[\s,:]*)+/i, "")
    .replace(/^\s*(bug\s*[:\-–—]|#bug\b|\[bug\])\s*/i, "")
    .trim();
}

export function tokens(s: string): Set<string> {
  const stop = new Set(["the", "a", "an", "is", "on", "in", "of", "to", "and", "or", "when", "it", "my", "i", "not", "page", "bug", "arta", "with", "for", "after", "does", "doesn't", "dont", "don't"]);
  return new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !stop.has(w)));
}

/** Jaccard similarity of two titles' content words. */
export function similarity(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
