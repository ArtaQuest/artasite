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
    { key: "x", label: "X", href: `https://twitter.com/intent/tweet?text=${both}` },
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
  return (
    <div ref={ref} className={cx("relative", className)}>
      {compact ? (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open} aria-label="Share" title="Share"
          className="-my-2 grid min-h-11 w-9 place-items-center rounded-pill text-ink-3 transition-colors hover:text-yin-ink">
          {SHARE_ICON}
        </button>
      ) : (
        <Button variant="outline" onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open} className="h-9 w-full gap-1.5 px-3.5 text-[14px] sm:w-auto">
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
          <div className="mt-3 grid grid-cols-5 gap-2">
            {networks.map((n) => (
              <a key={n.key} href={n.href} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}
                aria-label={`Share on ${n.label}`} title={`Share on ${n.label}`}
                className="flex h-12 items-center justify-center rounded-field border border-line bg-veil/[0.03] text-ink-2 transition-colors hover:border-yin-light hover:bg-veil/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yin-light">
                {NETWORK_ICONS[n.key]}
              </a>
            ))}
          </div>
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
