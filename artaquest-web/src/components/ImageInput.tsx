import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Avatar, Button, Input, SearchPill, StatusNote, cx } from "./ui";
import { ICON_REV, resolveImage } from "../lib/typology-meta";
import { uploadImage } from "../lib/api";

/* ───────────────────────── ImageInput (ticket #140) ─────────────────────────
   Three ways to set ANY image field, so every image-change control in the Studio editors behaves
   the same: (1) type/paste a URL, (2) pick one of the bundled topic-art SVGs from a searchable
   library, or (3) upload a file from the device. The stored value is whatever the chosen method
   yields — an absolute URL (paste/upload) or a base-relative `topic-art/<key>.svg` path (library) —
   exactly the shapes resolveImage already understands, so the live preview here matches every
   surface that renders the picture. Controlled: the parent owns the string via value/onChange. */

const MAX_BYTES = 6 * 1024 * 1024; // mirrors the server cap (Tickets::save_data_url_image)
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });
}

export function ImageInput({ value, onChange, placeholder, ariaLabel, compact, className }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Accessible name for the URL input when it isn't already wrapped in a <Field> (dense rows). */
  ariaLabel?: string;
  /** Dense variant for the spectrum/option rows: shorter controls, fits the wrapping row. */
  compact?: boolean;
  className?: string;
}) {
  const [picking, setPicking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setErr("");
    if (file.size > MAX_BYTES) { setErr("That image is over 6 MB — choose a smaller one."); return; }
    setUploading(true);
    try {
      const { url } = await uploadImage(await readAsDataURL(file));
      onChange(url);
    } catch {
      setErr("Couldn’t upload that image — try a PNG, JPEG, WebP or GIF under 6 MB.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = ""; // let the same file be re-picked
    }
  };

  const previewBox = compact ? "h-9 w-9" : "h-11 w-11";
  return (
    <div className={cx("flex min-w-0 flex-1 flex-col gap-1.5", className)}>
      <div className="flex min-w-0 items-center gap-2">
        {value
          ? <Avatar src={resolveImage(value)} name="?" className={cx("shrink-0 rounded-card", previewBox, compact ? "text-[12px]" : "text-[14px]")} />
          : <span aria-hidden className={cx("grid shrink-0 place-items-center rounded-card border border-dashed border-line text-ink-3", previewBox)}>
              <ImageGlyph />
            </span>}
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={ariaLabel}
          className={cx("min-w-0 flex-1", compact && "h-9 text-[14px]")} />
        <Button variant="outline" size="sm" tip="Pick one of the bundled topic-art SVGs"
          onClick={() => { setErr(""); setPicking(true); }} className={cx(compact ? "h-9 px-2.5" : "h-11")}>SVG</Button>
        <Button variant="outline" size="sm" tip="Upload an image from your device" disabled={uploading}
          onClick={() => fileRef.current?.click()} className={cx(compact ? "h-9 px-2.5" : "h-11")}>{uploading ? "…" : "Upload"}</Button>
        <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
      </div>
      {err && <span role="alert" className="text-[12px] text-rose-400">{err}</span>}
      {picking && <SvgPicker onPick={(name) => { onChange(`topic-art/${name}`); setPicking(false); }} onClose={() => setPicking(false)} />}
    </div>
  );
}

function ImageGlyph() {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" />
    </svg>
  );
}

/* The topic-art library: a searchable grid of every bundled SVG (public/topic-art/, listed in
   topic-art-index.json — built by scripts/gen-topic-art-index.mjs). Thumbnails are plain <img> so
   only the on-screen ones load (the SVGs carry a hex fallback on their var(--ico-gold) marks, so
   they paint correctly outside the inline-injection path). Modal idiom mirrors Profile's roster. */
const PICKER_LIMIT = 240; // cap rendered thumbnails; search narrows the full set

function SvgPicker({ onPick, onClose }: { onPick: (name: string) => void; onClose: () => void }) {
  const [all, setAll] = useState<string[] | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");
  const [q, setQ] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    let alive = true;
    const base = import.meta.env.BASE_URL || "/";
    fetch(`${base}topic-art-index.json?v=${ICON_REV}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((list: string[]) => { if (alive) { setAll(Array.isArray(list) ? list : []); setState("ready"); } })
      .catch(() => { if (alive) setState("error"); });
    return () => { alive = false; };
  }, []);

  // Focus the panel on open, close on Escape, restore focus to the opener on unmount.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); opener?.focus?.(); };
  }, [onClose]);

  const needle = q.trim().toLowerCase();
  const matches = (all ?? []).filter((f) => !needle || f.toLowerCase().includes(needle));
  const shown = matches.slice(0, PICKER_LIMIT);

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={onClose}>
      <div ref={panelRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-line bg-space-2 shadow-2xl outline-none">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h3 id={titleId} className="text-[18px] font-bold tracking-tight">
            Topic-art library{state === "ready" && <span className="ms-2 text-[14px] font-semibold tabular-nums text-ink-3">{matches.length.toLocaleString()}</span>}
          </h3>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-full text-[18px] text-ink-3 transition-colors hover:bg-veil/10 hover:text-ink">×</button>
        </div>
        <div className="border-b border-line p-3">
          <SearchPill value={q} onChange={setQ} placeholder="Search SVGs…" autoFocus />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {state === "loading" && <StatusNote>Loading the library…</StatusNote>}
          {state === "error" && <StatusNote error>Couldn’t load the SVG library — paste a URL or upload a file instead.</StatusNote>}
          {state === "ready" && matches.length === 0 && <StatusNote>No SVGs match “{q}”.</StatusNote>}
          {shown.length > 0 && (
            <ul className="grid list-none grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
              {shown.map((f) => {
                const label = f.replace(/\.svg$/i, "");
                return (
                  <li key={f}>
                    <button type="button" onClick={() => onPick(f)} title={label}
                      className="flex w-full flex-col items-center gap-1 rounded-card border border-line p-2 transition-colors hover:border-yin-light hover:bg-veil/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yin-light">
                      <img src={resolveImage(`topic-art/${f}`)} alt="" width={48} height={48} loading="lazy" decoding="async" className="h-12 w-12 object-contain" />
                      <span className="w-full truncate text-center text-[10px] text-ink-2">{label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {matches.length > shown.length && (
            <p className="px-1 pt-3 text-center text-[12px] text-ink-3">
              Showing the first {PICKER_LIMIT.toLocaleString()} of {matches.length.toLocaleString()} — refine your search to narrow the list.
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
