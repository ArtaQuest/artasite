import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, cx } from "./ui";
import { shareLinks, shareToast } from "../lib/share";

/**
 * Share — a popover anchored to the button on desktop, a bottom sheet on phones (the system share
 * sheet first when the device has one). Rendered in a PORTAL with fixed positioning, so no card's
 * overflow, stacking context or the viewport edge can hide it (the old in-flow popover opened below
 * the fold / under the next card, so a click looked like it did nothing). Every action answers with
 * a toast. X gets the caption trimmed to fit 280 with the link; LinkedIn/Facebook unfurl the page's
 * server-rendered 1200×630 card; Instagram gets real images (a 1080×1350 post and a 1080×1920 Story,
 * rendered server-side per post) — shared as files on a phone, downloaded with the caption copied on a
 * desktop.
 *
 * (Formerly: shared "ready-to-post" share popover — a pre-composed caption + the page link (whose OG tags unfurl an
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

const LINK_ICON = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" /></svg>
);

async function fileFrom(src: string, name: string): Promise<File | null> {
  try {
    const r = await fetch(src, { credentials: "omit" });
    const b = await r.blob();
    return r.ok && b.type.startsWith("image/") ? new File([b], name, { type: b.type }) : null;
  } catch { return null; }
}
function download(f: File) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(f); a.download = f.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const isPhone = () => typeof window !== "undefined" && (window.matchMedia?.("(max-width: 639px)").matches || window.matchMedia?.("(pointer: coarse)").matches);

export function SharePanel({ title, url, message, image, cardId, dialogLabel = "Share", className, compact }: { title: string; url: string; message: string; image?: string;
  /** A feed post id: Instagram gets that post's generated 1080×1350 + 1080×1920 cards. */
  cardId?: number;
  dialogLabel?: string; className?: string;
  /** Icon-only trigger for tight rows (the feed card's action row) — same sheet, no label. */
  compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const btn = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const links = shareLinks(message, url);
  const caption = `${message} ${url}`;

  const place = useCallback(() => {
    const b = btn.current?.getBoundingClientRect(); const p = panel.current;
    if (!b || !p) return;
    const w = p.offsetWidth, h = p.offsetHeight, m = 8;
    const below = b.bottom + m, above = b.top - m - h;
    const top = below + h <= innerHeight - m || above < m ? Math.min(below, Math.max(m, innerHeight - m - h)) : above;
    const left = Math.min(Math.max(m, b.right - w), innerWidth - m - w);
    setPos({ top, left });
  }, []);
  useLayoutEffect(() => { if (open && !sheet) place(); }, [open, sheet, place]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { const t = e.target as Node; if (!panel.current?.contains(t) && !btn.current?.contains(t)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btn.current?.querySelector<HTMLElement>("button")?.focus(); } };
    const onMove = () => { if (!sheet) place(); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    addEventListener("resize", onMove); addEventListener("scroll", onMove, true);
    requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("a,button")?.focus({ preventScroll: true }));
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); removeEventListener("resize", onMove); removeEventListener("scroll", onMove, true); };
  }, [open, sheet, place]);

  const show = () => { setSheet(!!window.matchMedia?.("(max-width: 639px)").matches); setPos(null); setOpen(true); };
  const trigger = async () => {
    if (open) { setOpen(false); return; }
    // A phone opens the system share sheet first (every installed app); the bottom sheet is the fallback.
    if (isPhone() && typeof navigator.share === "function") {
      try { await navigator.share({ title, text: message, url }); return; }
      catch (e) { if ((e as Error)?.name === "AbortError") return; /* unsupported/blocked → our sheet */ }
    }
    show();
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); shareToast("Copied"); }
    catch { shareToast("Couldn’t copy — long-press the address bar instead"); }
    setOpen(false);
  };
  const instagram = async () => {
    if (busy) return;
    setBusy(true); shareToast("Preparing Instagram images…", 6000);
    const base = `${location.origin}/wp-json/aq/v1/share-card/${cardId}`;
    const got: (File | null)[] = await Promise.all(cardId
      ? [fileFrom(`${base}/feed`, "artaquest-post.png"), fileFrom(`${base}/story`, "artaquest-story.png")]
      : image ? [fileFrom(image, "artaquest.jpg")] : []);
    const files: File[] = got.filter((f): f is File => f !== null);
    setBusy(false);
    if (isPhone() && files.length && navigator.canShare?.({ files })) {
      try { await navigator.share({ files, text: caption }); setOpen(false); shareToast("Shared"); return; }
      catch (e) { if ((e as Error)?.name === "AbortError") { shareToast("Cancelled"); return; } }
    }
    await navigator.clipboard?.writeText(caption).catch(() => {});
    files.forEach(download);
    setOpen(false);
    shareToast(files.length ? "Images downloaded and caption copied — post them from the Instagram app (feed post 4:5, Story 9:16)." : "Caption copied — paste it in Instagram.", 6000);
  };
  const go = (name: string) => () => { setOpen(false); shareToast(`Opening ${name}…`); };

  const item = "flex flex-col items-center gap-1.5 rounded-field px-1 py-2.5 text-[12px] text-ink-2 transition-colors hover:bg-veil/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yin-ink";
  const disc = "grid h-12 w-12 place-items-center rounded-full border border-line bg-veil/[0.04] text-ink";
  const entries: { key: string; label: string; href?: string; on?: () => void; icon: ReactNode }[] = [
    { key: "x", label: "X", href: links.x, icon: NETWORK_ICONS.x },
    { key: "instagram", label: busy ? "Preparing…" : "Instagram", on: () => void instagram(), icon: NETWORK_ICONS.instagram },
    { key: "linkedin", label: "LinkedIn", href: links.linkedin, icon: NETWORK_ICONS.linkedin },
    { key: "facebook", label: "Facebook", href: links.facebook, icon: NETWORK_ICONS.facebook },
    { key: "whatsapp", label: "WhatsApp", href: links.whatsapp, icon: NETWORK_ICONS.whatsapp },
    { key: "copy", label: "Copy link", on: () => void copy(), icon: LINK_ICON },
  ];
  const grid = (
    <div className="grid grid-cols-3 gap-1 sm:grid-cols-6">
      {entries.map((n) => n.href ? (
        <a key={n.key} href={n.href} target="_blank" rel="noopener noreferrer" onClick={go(n.label)} aria-label={`Share on ${n.label}`} className={item}>
          <span className={disc}>{n.icon}</span>{n.label}
        </a>
      ) : (
        <button key={n.key} type="button" onClick={n.on} aria-label={n.key === "copy" ? "Copy link" : `Share on ${n.label}`} aria-busy={n.key === "instagram" && busy} className={item}>
          <span className={disc}>{n.icon}</span>{n.label}
        </button>
      ))}
    </div>
  );
  const ui = open ? createPortal(sheet ? (
    <div className="fixed inset-0 z-[1000]" onClick={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} aria-hidden />
      <div ref={panel} role="dialog" aria-modal="true" aria-label={dialogLabel}
        className="absolute inset-x-0 bottom-0 rounded-t-[20px] border-t border-line bg-space-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 shadow-card">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line" aria-hidden />
        <p className="mb-1 truncate px-1 text-[15px] font-semibold text-ink">{dialogLabel}</p>
        <p className="mb-3 line-clamp-2 px-1 text-[13px] text-ink-3">{title}</p>
        {grid}
        <Button variant="subtle" onClick={() => setOpen(false)} className="mt-3 h-11 w-full text-[15px]">Cancel</Button>
      </div>
    </div>
  ) : (
    <div ref={panel} role="dialog" aria-label={dialogLabel} onClick={(e) => e.stopPropagation()}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      className="fixed z-[1000] w-[22rem] max-w-[calc(100vw-1rem)] rounded-card border border-line bg-space-2 p-3 text-start shadow-card">
      <p className="mb-2 px-1 text-[13px] font-semibold text-ink">{dialogLabel}</p>
      {grid}
    </div>
  ), document.body) : null;

  return (
    <div ref={btn} className={cx("relative", className)}>
      {compact ? (
        <button type="button" onClick={() => void trigger()} aria-haspopup="dialog" aria-expanded={open} aria-label="Share" title="Share"
          className={cx("grid h-9 w-9 place-items-center rounded-full outline-none transition-colors hover:bg-yin-ink/10 hover:text-yin-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yin-ink", open ? "bg-yin-ink/10 text-yin-ink" : "text-ink-3")}>
          {SHARE_ICON}
        </button>
      ) : (
        <Button variant="outline" onClick={() => void trigger()} aria-haspopup="dialog" aria-expanded={open} className="h-9 w-full gap-1.5 px-3.5 text-[14px] sm:w-auto">
          {SHARE_ICON}Share
        </Button>
      )}
      {ui}
    </div>
  );
}
