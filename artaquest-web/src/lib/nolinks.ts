/**
 * No visible URLs anywhere in post or reply text: markdown links keep only their label, bare URLs
 * (https://…, www.…, and bare domains with a path such as math.bilkent.edu.tr/faculty.html) are removed,
 * along with the dangling punctuation and spacing they leave. Display-only — stored text is untouched.
 */
export function stripLinks(text: string): string {
  return (text || "")
    .replace(/\[([^\]\n]{1,200})\]\((?:https?:\/\/|\/)[^)\s]*\)/g, "$1")
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>()"“”]+/gi, "")
    .replace(/(^|[\s(“"'])(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>()"“”]*/gi, "$1")
    .replace(/[“"]\s*[”"]/g, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim();
}
