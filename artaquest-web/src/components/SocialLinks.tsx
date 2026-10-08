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

/* ONE ROW, ALWAYS (operator 2026-10-08: "there should be only one row and rest with +"). A cell is
   44px — a full tap target. The row holds as many as its measured width allows with at least a 6px
   gap; when some are folded behind "+N" the leftover width is shared out between the cells (up to
   12px), so the "+" sits flush with the row's end instead of leaving a ragged gap after it. */
const CELL = 44;
const MIN_GAP = 6;
const GAP = 8;     // when everything fits: the natural spacing, left-aligned
const MAX_GAP = 12;

/** How many CELL px cells fit in `width` with at least MIN_GAP px between them. */
function capacity(width: number): number {
  return Math.max(1, Math.floor((width + MIN_GAP) / (CELL + MIN_GAP)));
}

const staticCls = "grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line bg-space-1 text-ink-2";
const cellCls = "grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line bg-space-1 text-ink-2 transition-colors hover:border-yang hover:text-yang focus-visible:border-yang focus-visible:text-yang focus-visible:outline-none";

/**
 * Where else this member is — round brand marks under the bio (operator 2026-10-08, reversing
 * 2026-08-18's "remove all the social links": the profile is now meant to carry them).
 *
 * MARKS, NOT CHIPS. Thirty-odd pills each reading "@artafather" is a wall of the same word; a row of
 * recognisable logos is scannable at a glance, and the network plus the handle travel in the
 * accessible name and the hover title.
 *
 * EXACTLY ONE ROW on every screen. The row's width is measured (ResizeObserver, before paint, so it
 * never flashes a wrong count) and holds as many 44px marks as fit; when they do not all fit, the
 * last slot is "+N" and opens the rest — a bottom sheet on a phone, a popover under the button from
 * `sm` up. The row never wraps and never scrolls sideways; when everything fits there is no "+".
 *
 * ORDER is the server's: the biggest networks first (operator 2026-10-08, "rank them based on
 * registered accounts"), so the marks that fit before "+N" are the ones a visitor most likely uses.
 *
 * WeChat and a Discord username have no public page, so their mark is NOT a link and there is no
 * copy button (operator 2026-10-08: "remove copy ID") — it is the plain icon with the handle as its
 * tooltip and accessible name, and plain text in the "+N" list. A numeric Discord user id does have
 * a page (discord.com/users/<id>) and links like any other. Links open in a new tab with
 * rel="me nofollow ugc" — `me` is the identity claim (it is what Mastodon's verification reads),
 * nofollow ugc because a member wrote it.
 */
export function SocialLinks({ socials, name }: { socials: Social[]; name: string }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState(0); // 0 = not measured yet
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = socials.length;
  const cap = width ? capacity(width) : 6;
  const folds = n > cap;
  const shownCount = folds ? cap - 1 : n;
  const gap = folds && cap > 1 ? Math.min(MAX_GAP, Math.floor((width - cap * CELL) / (cap - 1))) : GAP;
  const shown = socials.slice(0, shownCount);
  const rest = socials.slice(shownCount);

  // A grown window can leave nothing behind the "+": close what it opened.
  useEffect(() => { if (!rest.length && open) setOpen(false); }, [rest.length, open]);

  if (!n) return null;
  const close = () => { setOpen(false); moreRef.current?.focus(); };

  return (
    <div className="mt-4 min-w-0">
      <h2 className="sr-only">{`${name} elsewhere`}</h2>
      {/* overflow-hidden is only a guard: the count is computed to fit, so nothing is ever cut. */}
      <div ref={rowRef} className="flex h-11 min-w-0 flex-nowrap overflow-hidden" role="list" aria-label="Social profiles"
        style={{ gap, visibility: width ? undefined : "hidden" }}>
        {shown.map((s) => (
          <div role="listitem" key={s.key} className="shrink-0"><Mark s={s} /></div>
        ))}
        {rest.length > 0 && (
          <div role="listitem" className="shrink-0">
            <button ref={moreRef} type="button" onClick={() => setOpen((v) => !v)}
              aria-haspopup="dialog" aria-expanded={open} aria-label={`${rest.length} more social profiles`}
              title={`${rest.length} more`}
              className={cx(cellCls, "text-[13px] font-bold tabular-nums", open && "border-yang text-yang")}>
              +{rest.length}
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

/** One round mark: a link, or — for an ID with no public page — the plain mark, named. */
function Mark({ s }: { s: Social }) {
  const label = `${s.label}: ${displayHandle(s)}`;
  return s.url ? (
    <a href={s.url} target="_blank" rel="me nofollow ugc noopener noreferrer" aria-label={label} title={label} className={cellCls}>
      <SocialIcon k={s.key} />
    </a>
  ) : (
    // Not a control: nothing happens on tap, so it has no hover/focus state either. role="img" with
    // the label gives a screen reader the network and the handle; the title gives the mouse the same.
    <span role="img" aria-label={label} title={label} className={staticCls}>
      <SocialIcon k={s.key} />
    </span>
  );
}

const wide = () => typeof window !== "undefined" && window.matchMedia("(min-width: 640px)").matches;

/**
 * The rest, behind "+N". A list, not a second grid of marks: here there is room to NAME each one,
 * so every row reads icon · network · handle, 48px tall. Phones get a bottom sheet (thumb reach,
 * swipe-free close on the backdrop); from `sm` up a popover anchored under the "+" button, kept on
 * screen. Escape and an outside tap close it and focus returns to "+".
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
      const width = Math.min(360, window.innerWidth - 24);
      const left = Math.max(12, Math.min(r.right - width, window.innerWidth - width - 12));
      const below = window.innerHeight - r.bottom - 16;
      const top = below >= 260 ? r.bottom + 8 : Math.max(12, r.top - 8 - Math.min(420, r.top - 20));
      setPos({ top, left, width, maxHeight: below >= 260 ? Math.min(420, below) : Math.min(420, r.top - 20) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchor]);

  // The latest onClose, read through a ref so a parent re-render does not re-run the effects below
  // — which would steal focus back to the first row.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  // Focus moves INTO the panel once, when it opens.
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

  // The page behind a phone sheet stays put.
  useEffect(() => {
    if (isWide) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [isWide]);

  const rows = (
    <ul className="list-none">
      {items.map((s) => {
        const handle = displayHandle(s);
        const inner = (
          <>
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-line bg-space-1 text-ink-2 group-hover:border-yang group-hover:text-yang group-focus-visible:border-yang group-focus-visible:text-yang">
              <SocialIcon k={s.key} size={18} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold leading-tight text-ink">{s.label}</span>
              <span className="block truncate text-[12.5px] leading-tight text-ink-3" data-ay-skip="1">{handle}</span>
            </span>
          </>
        );
        const rowStatic = "flex min-h-12 w-full items-center gap-3 px-2.5 py-1.5";
        const row = "group flex min-h-12 w-full items-center gap-3 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-veil/5 focus-visible:bg-veil/5 focus-visible:outline-none";
        return (
          <li key={s.key}>
            {s.url ? (
              <a href={s.url} target="_blank" rel="me nofollow ugc noopener noreferrer" className={row}
                aria-label={`${s.label}: ${handle}`}>{inner}</a>
            ) : (
              // No page to open: the same row as plain text, with no hover state promising a tap.
              <div className={rowStatic}>{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );

  const title = `${items.length} more of ${total}`;
  if (isWide) {
    return createPortal(
      <div ref={panelRef} role="dialog" aria-label={`${name} — ${title} social profiles`}
        style={pos}
        className="fixed z-[100] flex flex-col overflow-hidden rounded-card border border-line bg-space-1 shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <p className="text-[13px] font-semibold text-ink-2">{title} profiles</p>
          <button type="button" data-close onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-ink-3 hover:bg-veil/5 hover:text-ink">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-1.5">{rows}</div>
      </div>,
      document.body,
    );
  }
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end bg-space-0/70 backdrop-blur-[2px]">
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={`${name} — ${title} social profiles`}
        className="flex max-h-[78vh] w-full flex-col rounded-t-[1.5rem] border border-b-0 border-line bg-space-1 shadow-2xl">
        <div aria-hidden className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-veil/20" />
        <div className="flex shrink-0 items-center justify-between px-5 pb-1 pt-2">
          <p className="text-[15px] font-bold text-ink">{title} profiles</p>
          <button type="button" data-close onClick={onClose} className="-mr-2 h-11 px-3 text-[14px] font-semibold text-ink-2 hover:text-yang">Done</button>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{rows}</div>
      </div>
    </div>,
    document.body,
  );
}
