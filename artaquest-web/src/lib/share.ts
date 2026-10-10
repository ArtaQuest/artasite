/** Share helpers (no React): platform links, X caption fitting, and the share toast. */
/** X counts every link as 23 characters; the caption is trimmed (at a word, with "…") so caption + space + link ≤ 280. */
export function xText(message: string, max = 280 - 23 - 1): string {
  const t = message.replace(/\s+/g, " ").trim();
  if ([...t].length <= max) return t;
  const cut = [...t].slice(0, max - 1).join("");
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,.;:–—-]+$/, "") + "…";
}

export function shareLinks(message: string, url: string) {
  const u = encodeURIComponent(url);
  return {
    x: `https://twitter.com/intent/tweet?text=${encodeURIComponent(xText(message))}&url=${u}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(`${message} ${url}`)}`,
  };
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** One app-wide toast (bottom-centre, above the bottom sheet), so every share action is visibly answered. */
export function shareToast(text: string, ms = 2200) {
  if (typeof document === "undefined") return;
  let el = document.getElementById("aq-share-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "aq-share-toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.className = "pointer-events-none fixed inset-x-0 bottom-6 z-[1001] mx-auto w-fit max-w-[calc(100vw-2rem)] rounded-pill bg-ink px-4 py-2 text-center text-[13.5px] font-medium text-space-1 shadow-card transition-opacity duration-200";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = "1";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (el) el.style.opacity = "0"; }, ms);
}

