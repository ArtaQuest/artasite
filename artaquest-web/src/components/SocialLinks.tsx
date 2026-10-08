import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { SOCIAL_ICONS } from "../lib/social-icons";
import { displayHandle, type Social } from "../lib/socials";
import { cx } from "./ui";

/** The mark for one network — the brand path from Simple Icons, or a globe for a personal site. */
export function SocialIcon({ k, size = 20, className }: { k: string; size?: number; className?: string }) {
  const d = SOCIAL_ICONS[k];
  if (!d) {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden className={className}>
        <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" />
      </svg>
    );
  }
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden className={className}><path d={d} /></svg>;
}

/* ALWAYS FOUR marks, then "+N" for the rest (operator 2026-10-08: four icons + count after +).
   No width measuring. 32px circle / 16px glyph; "+N" is a pill of the same height, wide enough for
   the digits. */
const SHOW = 4;
const markCls = "relative grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line bg-space-1 text-ink-2 transition-colors before:absolute before:-inset-[3px] before:rounded-full before:content-['']";
const staticCls = markCls;
const cellCls = `${markCls} hover:border-yang hover:text-yang focus-visible:border-yang focus-visible:text-yang focus-visible:outline-none`;

/**
 * Where else this member is — round brand marks next to the handle (operator 2026-10-08,
 * "relocate it to look aesthetically nice"). Exactly four marks, then "+" for the rest (sheet on a
 * phone, popover from `sm`). ORDER is the server's: the member's saved order first, then the size
 * ranking. Website lives in the meta row, never here.
 */
export function SocialLinks({ socials, name, className }: { socials: Social[]; name: string; className?: string }) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const n = socials.length;
  const shown = socials.slice(0, SHOW);
  const rest = socials.slice(SHOW);
  const close = () => { setOpen(false); moreRef.current?.focus(); };

  useEffect(() => { if (!rest.length && open) setOpen(false); }, [rest.length, open]);

  if (!n) return null;

  return (
    <div className={cx("min-w-0", className)}>
      <h2 className="sr-only">{`${name} elsewhere`}</h2>
      <div className="-m-[3px] flex h-[38px] flex-nowrap items-center gap-2 overflow-visible p-[3px]" role="list" aria-label="Social profiles">
        {shown.map((s) => (
          <div role="listitem" key={s.key} className="shrink-0"><Mark s={s} /></div>
        ))}
        {rest.length > 0 && (
          <div role="listitem" className="shrink-0">
            <button ref={moreRef} type="button" onClick={() => setOpen((v) => !v)}
              aria-haspopup="dialog" aria-expanded={open}
              aria-label={`More profiles (${rest.length})`}
              title={`${rest.length} more profiles`}
              className={cx(
                "relative inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-full border border-line bg-space-1 px-2 text-[12px] font-bold tabular-nums leading-none tracking-tight text-ink-2 transition-colors before:absolute before:-inset-[3px] before:rounded-full before:content-[''] hover:border-yang hover:text-yang focus-visible:border-yang focus-visible:text-yang focus-visible:outline-none",
                open && "border-yang text-yang",
              )}>
              <span aria-hidden>+{rest.length}</span>
            </button>
          </div>
        )}
      </div>
      {open && rest.length > 0 && (
        <MorePanel items={rest} total={n} name={name} anchor={moreRef} onClose={close} />
      )}
    </div>
  );
}

function Mark({ s }: { s: Social }) {
  const label = `${s.label}: ${displayHandle(s)}`;
  return s.url ? (
    <a href={s.url} target="_blank" rel="me nofollow ugc noopener noreferrer" aria-label={label} title={label} className={cellCls}>
      <SocialIcon k={s.key} size={16} />
    </a>
  ) : (
    <span role="img" aria-label={label} title={label} className={staticCls}>
      <SocialIcon k={s.key} size={16} />
    </span>
  );
}

const wide = () => typeof window !== "undefined" && window.matchMedia("(min-width: 640px)").matches;

/**
 * The rest, behind "+N". A polished list: icon · network · handle, ranked. Header carries the count
 * ("27 more profiles"). Phone = bottom sheet; from `sm` = popover under "+N". Escape / outside tap
 * closes and focus returns to "+".
 */
function MorePanel({ items, total, name, anchor, onClose }: {
  items: Social[]; total: number; name: string; anchor: { current: HTMLElement | null };
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [isWide, setIsWide] = useState(wide);
  const [pos, setPos] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    const place = () => {
      const w = wide();
      setIsWide(w);
      const a = anchor.current;
      if (!w || !a) return;
      const r = a.getBoundingClientRect();
      const width = Math.min(340, window.innerWidth - 24);
      const left = Math.max(12, Math.min(r.right - width, window.innerWidth - width - 12));
      const below = window.innerHeight - r.bottom - 16;
      const top = below >= 260 ? r.bottom + 8 : Math.max(12, r.top - 8 - Math.min(440, r.top - 20));
      setPos({ top, left, width, maxHeight: below >= 260 ? Math.min(440, below) : Math.min(440, r.top - 20) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchor]);

  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    (panelRef.current?.querySelector<HTMLElement>("a") ?? panelRef.current?.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); closeRef.current(); } };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchor.current?.contains(t)) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [anchor]);

  useEffect(() => {
    if (isWide) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [isWide]);

  const rows = (
    <ul className="list-none divide-y divide-line/60">
      {items.map((s) => {
        const handle = displayHandle(s);
        const inner = (
          <>
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-line bg-space-2 text-ink-2 transition-colors group-hover:border-yang group-hover:text-yang group-focus-visible:border-yang group-focus-visible:text-yang">
              <SocialIcon k={s.key} size={17} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold leading-tight text-ink">{s.label}</span>
              <span className="mt-0.5 block truncate text-[12.5px] leading-tight text-ink-3" data-ay-skip="1">{handle}</span>
            </span>
            {s.url ? (
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden
                className="me-0.5 shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <path d="M7 17 17 7M9 7h8v8" />
              </svg>
            ) : null}
          </>
        );
        const rowStatic = "flex min-h-12 w-full items-center gap-3 px-3 py-2";
        const row = "group flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-veil/[0.06] focus-visible:bg-veil/[0.06] focus-visible:outline-none";
        return (
          <li key={s.key}>
            {s.url ? (
              <a href={s.url} target="_blank" rel="me nofollow ugc noopener noreferrer" className={row}
                aria-label={`${s.label}: ${handle}`}>{inner}</a>
            ) : (
              <div className={rowStatic}>{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );

  const title = `${items.length} more profile${items.length === 1 ? "" : "s"}`;
  if (isWide) {
    return createPortal(
      <div ref={panelRef} role="dialog" aria-label={`${name} — ${title}`}
        style={pos}
        className="fixed z-[100] flex flex-col overflow-hidden rounded-2xl border border-line bg-space-1 shadow-[0_24px_48px_-12px_rgba(2,8,20,0.55)]">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-[13.5px] font-semibold text-ink">{title}</p>
            <p className="truncate text-[11.5px] text-ink-3">{total} in total · your order</p>
          </div>
          <button type="button" data-close onClick={onClose} aria-label="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-veil/10 hover:text-ink focus-visible:outline-2 focus-visible:outline-yang">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain py-1">{rows}</div>
      </div>,
      document.body,
    );
  }
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end bg-space-0/70 backdrop-blur-[2px]" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={`${name} — ${title}`}
        className="flex max-h-[80vh] w-full flex-col rounded-t-[1.5rem] border border-b-0 border-line bg-space-1 shadow-2xl">
        <div aria-hidden className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-veil/25" />
        <div className="flex shrink-0 items-center justify-between gap-3 px-5 pb-2 pt-2.5">
          <div className="min-w-0">
            <p className="truncate text-[16px] font-bold tracking-tight text-ink">{title}</p>
            <p className="truncate text-[12.5px] text-ink-3">{total} in total · your order</p>
          </div>
          <button type="button" data-close onClick={onClose}
            className="-me-1.5 inline-flex h-11 items-center rounded-pill px-3.5 text-[14px] font-semibold text-ink-2 transition-colors hover:text-yang focus-visible:outline-2 focus-visible:outline-yang">
            Done
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain pb-[max(0.75rem,env(safe-area-inset-bottom))]">{rows}</div>
      </div>
    </div>,
    document.body,
  );
}
