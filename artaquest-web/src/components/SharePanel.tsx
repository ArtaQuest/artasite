import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, cx, Logo } from "./ui";
import { thumbSrc, thumbSrcSet } from "../lib/img";

/**
 * Shared "ready-to-post" share popover — a pre-composed caption + the page link (whose OG tags unfurl an
 * image preview on every network), one-tap posting to each platform, a Copy button, and the device's
 * native share sheet where one exists. Used by course pages AND the Journal of Seasonality article reader;
 * the caller supplies the caption via `message` so each surface posts its own words.
 */
const SHARE_ICON = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" /></svg>
);
// Recognisable brand marks (simple-icons paths). Monochrome — they inherit currentColor so they read
// on-brand (ink → blue on hover), not each network's own colour (the two-colour brand allows only blue).
const brandGlyph = (d: string): ReactNode => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden focusable="false"><path d={d} /></svg>
);
const NETWORK_ICONS: Record<string, ReactNode> = {
  x: brandGlyph("M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"),
  facebook: brandGlyph("M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z"),
  linkedin: brandGlyph("M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"),
  whatsapp: brandGlyph("M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.71.306 1.263.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885M20.52 3.449C18.24 1.245 15.24 0 12.045 0 5.463 0 .104 5.359.101 11.892c0 2.096.549 4.142 1.595 5.945L0 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.582 0 11.94-5.359 11.943-11.893a11.821 11.821 0 0 0-3.487-8.413Z"),
  instagram: brandGlyph("M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16M12 0C8.74 0 8.33.01 7.05.07 5.78.13 4.9.33 4.14.63a5.9 5.9 0 0 0-2.13 1.38A5.9 5.9 0 0 0 .63 4.14C.33 4.9.13 5.78.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.06 1.27.26 2.15.56 2.91.3.79.72 1.46 1.38 2.13a5.9 5.9 0 0 0 2.13 1.38c.76.3 1.64.5 2.91.56C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c1.27-.06 2.15-.26 2.91-.56a5.9 5.9 0 0 0 2.13-1.38 5.9 5.9 0 0 0 1.38-2.13c.3-.76.5-1.64.56-2.91.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95c-.06-1.27-.26-2.15-.56-2.91a5.9 5.9 0 0 0-1.38-2.13A5.9 5.9 0 0 0 19.86.63C19.1.33 18.22.13 16.95.07 15.67.01 15.26 0 12 0zm0 5.84a6.16 6.16 0 1 0 0 12.32 6.16 6.16 0 0 0 0-12.32zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.4-11.85a1.44 1.44 0 1 0 0 2.88 1.44 1.44 0 0 0 0-2.88z"),
  telegram: brandGlyph("M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.139-5.061 3.345-.479.329-.913.489-1.302.481-.428-.009-1.252-.242-1.865-.44-.752-.244-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"),
};

export function SharePanel({ title, url, message, image, dialogLabel = "Share", className, compact }: { title: string; url: string; message: string; image?: string; dialogLabel?: string; className?: string;
  /** Icon-only trigger for tight rows (the feed card's title line) — same popover, no label. */
  compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [imgOk, setImgOk] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const post = `${message} ${url}`;
  const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "artaquest.com"; } })();
  const both = encodeURIComponent(post);
  const u = encodeURIComponent(url);
  const networks: { key: string; label: string; href: string }[] = [
    { key: "x", label: "X", href: `https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}&url=${u}` },
    { key: "facebook", label: "Facebook", href: `https://www.facebook.com/sharer/sharer.php?u=${u}` },
    { key: "linkedin", label: "LinkedIn", href: `https://www.linkedin.com/sharing/share-offsite/?url=${u}` },
    { key: "whatsapp", label: "WhatsApp", href: `https://wa.me/?text=${both}` },
    { key: "telegram", label: "Telegram", href: `https://t.me/share/url?url=${u}&text=${encodeURIComponent(message)}` },
  ];
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const copy = () => { navigator.clipboard?.writeText(post).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(() => {}); };
  const hasNative = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const nativeShare = async () => { try { await navigator.share?.({ title, text: message, url }); setOpen(false); } catch { /* dismissed */ } };
  // On a phone the trigger opens the system share sheet straight away (every installed app, Instagram
  // included); the popover is the desktop path and the fallback when there is no sheet.
  const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  const trigger = () => { if (!open && hasNative && coarse) { void nativeShare(); return; } setOpen((o) => !o); };
  const [igNote, setIgNote] = useState("");
  /** Instagram has no web share URL. Phone: the share sheet, with the image as a file when the browser
   *  allows it. Elsewhere: copy the link and download the picture, ready to post from the app. */
  const instagram = async () => {
    let file: File | null = null;
    if (image) {
      try {
        const b = await (await fetch(image, { credentials: "omit" })).blob();
        if (b.type.startsWith("image/")) file = new File([b], `artaquest.${b.type.split("/")[1] || "png"}`, { type: b.type });
      } catch { /* cross-origin or offline: link only */ }
    }
    try {
      if (file && navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title, text: post }); setOpen(false); return; }
      if (hasNative && coarse) { await navigator.share({ title, text: message, url }); setOpen(false); return; }
    } catch { return; /* dismissed */ }
    await navigator.clipboard?.writeText(post).catch(() => {});
    if (file) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(file); a.download = file.name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    setIgNote(file ? "Link copied and image downloaded — post it from the Instagram app." : "Link copied — paste it in Instagram.");
    setTimeout(() => setIgNote(""), 4000);
  };
  return (
    <div ref={ref} className={cx("relative", className)}>
      {compact ? (
        <button type="button" onClick={trigger} aria-haspopup="dialog" aria-expanded={open} aria-label="Share" title="Share"
          className="-my-2 grid min-h-11 w-9 place-items-center rounded-pill text-ink-3 transition-colors hover:text-yin-ink">
          {SHARE_ICON}
        </button>
      ) : (
        <Button variant="outline" onClick={trigger} aria-haspopup="dialog" aria-expanded={open} className="h-9 w-full gap-1.5 px-3.5 text-[14px] sm:w-auto">
          {SHARE_ICON}Share
        </Button>
      )}
      {open && (
        <div role="dialog" aria-label={dialogLabel} className="absolute right-0 z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-card border border-line bg-space-2 p-4 text-start shadow-card">
          <p className="text-[13px] font-semibold text-ink">Ready-to-post — pick a platform</p>
          <div className="mt-3 overflow-hidden rounded-field border border-line">
            <div className="aspect-[16/9] w-full overflow-hidden bg-space-3">
              {image && imgOk ? (
                <img src={thumbSrc(image)} srcSet={thumbSrcSet(image)} sizes="288px" alt="" loading="lazy" decoding="async" onError={() => setImgOk(false)} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#010C17] via-[#06121E] to-[#0C1E32]"><Logo size="text-2xl" /></div>
              )}
            </div>
            <div className="border-t border-line bg-veil/[0.02] px-3 py-2">
              <p className="truncate text-[11px] uppercase tracking-wide text-ink-2">{host}</p>
              <p className="line-clamp-2 text-[13px] font-semibold leading-snug text-ink">{title}</p>
            </div>
          </div>
          <p className="mt-3 rounded-field border border-line bg-veil/[0.03] p-3 text-[13px] leading-relaxed text-ink-2">{post}</p>
          <div className="mt-3 grid grid-cols-6 gap-1.5">
            {networks.slice(0, 3).map((n) => (
              <a key={n.key} href={n.href} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}
                aria-label={`Share on ${n.label}`} title={`Share on ${n.label}`}
                className="flex h-12 items-center justify-center rounded-field border border-line bg-veil/[0.03] text-ink-2 transition-colors hover:border-yin-ink hover:bg-veil/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yin-ink">
                {NETWORK_ICONS[n.key]}
              </a>
            ))}
            <button type="button" onClick={() => void instagram()} aria-label="Share on Instagram" title="Share on Instagram"
              className="flex h-12 items-center justify-center rounded-field border border-line bg-veil/[0.03] text-ink-2 transition-colors hover:border-yin-ink hover:bg-veil/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yin-ink">
              {NETWORK_ICONS.instagram}
            </button>
            {networks.slice(3).map((n) => (
              <a key={n.key} href={n.href} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}
                aria-label={`Share on ${n.label}`} title={`Share on ${n.label}`}
                className="flex h-12 items-center justify-center rounded-field border border-line bg-veil/[0.03] text-ink-2 transition-colors hover:border-yin-ink hover:bg-veil/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yin-ink">
                {NETWORK_ICONS[n.key]}
              </a>
            ))}
          </div>
          {igNote ? <p role="status" className="mt-2 text-[12.5px] text-ink-2">{igNote}</p> : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button onClick={copy} variant="subtle" className="h-9 px-3.5 text-[13px]">{copied ? "Copied ✓" : "Copy post"}</Button>
            {hasNative && <Button onClick={nativeShare} variant="subtle" className="h-9 px-3.5 text-[13px]">More…</Button>}
          </div>
          <span className="sr-only" role="status" aria-live="polite">{copied ? "Post copied to clipboard" : ""}</span>
        </div>
      )}
    </div>
  );
}
