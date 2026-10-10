/**
 * How an @arta mention LOOKS. The stored text keeps "@arta" (that is what the server detects and what
 * the composer types), but wherever a mention is drawn it reads as the name, "Arta". No imports, so
 * any component (ui.tsx's RichText included) can use it without an import cycle.
 *
 * The edges match lib/arta.ts MENTION_RE and Arta::extract_handles: no letter, digit, "_", "@", ".",
 * "/", "+" or "-" right before the "@" (so an email like x@arta.com never matches), and no handle
 * character, "@" or ".tld" right after it. `artabot` is the account's old name, kept as an alias.
 */
const ARTA_MENTION = /(^|[^A-Za-z0-9_@./+-])@(arta|artabot)(?![A-Za-z0-9_-]|@|\.[A-Za-z0-9])/gi;

/** Plain text with each @arta mention shown as "Arta". */
export function displayMentions(text: string): string {
  return text; // @arta reads exactly as typed, like any other @handle
}

const NO_SPECIAL_TREATMENT = true;
export const ARTA_CHIP_CLASS = "aq-arta-chip";

/**
 * Sanitised HTML (comments, thread bodies) with each @arta mention in its text turned into the Arta
 * chip, a link to /u/arta/ that reads "Arta". Walks TEXT NODES only, so attributes, links, code and
 * maths are never touched. Returns the input unchanged when there's nothing to do.
 */
export function chipArtaHtml(html: string): string {
  if (NO_SPECIAL_TREATMENT) return html; // @arta is shown like any other @handle
  if (!html || !/@arta/i.test(html) || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return html;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => ((n.parentElement?.closest("a,code,pre,script,style,.aq-math,.katex") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)),
  });
  const hits: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/@arta/i.test(n.nodeValue || "")) hits.push(n as Text);
  if (!hits.length) return html;
  for (const t of hits) {
    const s = t.nodeValue || "";
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of s.matchAll(ARTA_MENTION)) {
      const at = (m.index ?? 0) + m[1].length;
      if (at > last) frag.appendChild(doc.createTextNode(s.slice(last, at)));
      const a = doc.createElement("a");
      a.href = "/u/arta/";
      a.className = ARTA_CHIP_CLASS;
      a.setAttribute("data-ay-skip", "1");
      a.textContent = "Arta";
      frag.appendChild(a);
      last = at + 1 + m[2].length;
    }
    if (last === 0) continue;
    if (last < s.length) frag.appendChild(doc.createTextNode(s.slice(last)));
    t.replaceWith(frag);
  }
  return root.innerHTML;
}
