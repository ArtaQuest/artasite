import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { SocialIcon } from "./SocialLinks";
import { cx } from "./ui";

export type OrderItem = { key: string; label: string; handle: string };

/** How many icons sit on the profile before "+" (SocialLinks.SHOW). */
export const PROFILE_SHOW = 4;

/**
 * THE MEMBER'S OWN ORDER for their profile icons (operator 2026-10-08). The first four are the ones
 * shown on the profile; the rest live behind "+". A divider labels each group. Three ways to move
 * one: drag the grip (mouse/touch), ↑/↓ buttons, or ArrowUp/Down/Home/End on the grip.
 */
export function SocialOrder({ items, onChange }: { items: OrderItem[]; onChange: (keys: string[]) => void }) {
  const rows = useRef<Record<string, HTMLLIElement | null>>({});
  const grips = useRef<Record<string, HTMLButtonElement | null>>({});
  const [drag, setDrag] = useState<{ key: string; y: number; grab: number } | null>(null);
  const [say, setSay] = useState("");
  const keys = items.map((i) => i.key);
  const labelOf = (k: string) => items.find((i) => i.key === k)?.label || k;

  const move = (k: string, to: number, focus?: "up" | "down" | "grip") => {
    const from = keys.indexOf(k);
    const t = Math.max(0, Math.min(keys.length - 1, to));
    if (from < 0 || t === from) return;
    const next = keys.filter((x) => x !== k);
    next.splice(t, 0, k);
    onChange(next);
    setSay(`${labelOf(k)}, position ${t + 1} of ${keys.length}`);
    if (focus === "grip") requestAnimationFrame(() => grips.current[k]?.focus());
    else requestAnimationFrame(() => { if (document.activeElement === document.body) grips.current[k]?.focus(); });
  };

  useLayoutEffect(() => {
    if (!drag) return;
    const el = rows.current[drag.key];
    if (!el) return;
    el.style.transform = "none";
    const top = el.getBoundingClientRect().top;
    el.style.transform = `translateY(${drag.y - drag.grab - top}px)`;
  });

  const down = (e: RPointerEvent<HTMLButtonElement>, k: string) => {
    if (e.button !== 0) return;
    const el = rows.current[k];
    if (!el) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ key: k, y: e.clientY, grab: e.clientY - el.getBoundingClientRect().top });
  };
  const moveTo = (e: RPointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const el = rows.current[drag.key];
    if (!el) return;
    if (e.clientY < 72) window.scrollBy(0, -10);
    else if (e.clientY > window.innerHeight - 72) window.scrollBy(0, 10);
    const h = el.getBoundingClientRect().height;
    const centre = e.clientY - drag.grab + h / 2;
    let to = 0;
    for (const k of keys) {
      if (k === drag.key) continue;
      const r = rows.current[k]?.getBoundingClientRect();
      if (r && r.top + r.height / 2 < centre) to++;
    }
    if (to !== keys.indexOf(drag.key)) move(drag.key, to);
    setDrag({ ...drag, y: e.clientY });
  };
  const up = () => {
    if (!drag) return;
    const el = rows.current[drag.key];
    if (el) el.style.transform = "";
    setDrag(null);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, k: string) => {
    const i = keys.indexOf(k);
    const to = e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : e.key === "Home" ? 0 : e.key === "End" ? keys.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    move(k, to, "grip");
  };

  const btn = "grid h-10 w-10 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-veil/[0.07] hover:text-ink disabled:pointer-events-none disabled:opacity-25 focus-visible:outline-2 focus-visible:outline-yang";

  const row = (it: OrderItem, i: number): ReactNode => {
    const lifted = drag?.key === it.key;
    return (
      <li key={it.key} ref={(el) => { rows.current[it.key] = el; }}
        className={cx("relative flex min-w-0 items-center gap-1 rounded-xl border bg-space-1 py-0.5 pe-1 ps-0.5",
          lifted ? "z-10 border-yang shadow-[0_14px_30px_-10px_rgba(2,8,20,0.5)]" : "border-line")}>
        <button type="button" ref={(el) => { grips.current[it.key] = el; }}
          aria-label={`Reorder ${it.label}, position ${i + 1} of ${items.length}`} aria-describedby="aq-order-help"
          onPointerDown={(e) => down(e, it.key)} onPointerMove={moveTo} onPointerUp={up} onPointerCancel={up}
          onKeyDown={(e) => onKey(e, it.key)}
          className={cx(btn, "touch-none select-none", lifted ? "cursor-grabbing text-yang" : "cursor-grab")}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
            <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" />
            <circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
          </svg>
        </button>
        <span aria-hidden className="w-6 shrink-0 text-center text-[12px] font-semibold tabular-nums text-ink-3">{i + 1}</span>
        <SocialIcon k={it.key} size={18} className="shrink-0 text-ink-2" />
        <span className="ms-1.5 flex min-w-0 flex-1 flex-col leading-tight sm:flex-row sm:items-baseline sm:gap-2">
          <span className="truncate text-[13.5px] font-semibold text-ink">{it.label}</span>
          <span className="truncate text-[12px] font-normal text-ink-3" data-ay-skip="1">{it.handle}</span>
        </span>
        <button type="button" className={btn} disabled={i === 0} aria-label={`Move ${it.label} up`} onClick={() => move(it.key, i - 1)}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 15 6-6 6 6" /></svg>
        </button>
        <button type="button" className={btn} disabled={i === items.length - 1} aria-label={`Move ${it.label} down`} onClick={() => move(it.key, i + 1)}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
        </button>
      </li>
    );
  };

  const shown = items.slice(0, PROFILE_SHOW);
  const rest = items.slice(PROFILE_SHOW);
  const head = (label: string, id: string) => (
    <li role="presentation" className="list-none px-1 pb-0.5 pt-2 first:pt-0">
      <p id={id} className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{label}</p>
    </li>
  );

  return (
    <div>
      <p id="aq-order-help" className="sr-only">Drag a row by its grip, or focus the grip and use the arrow keys, or use the move up and move down buttons. The first four icons appear on your profile; the rest open from the + button.</p>
      <ol className="flex list-none flex-col gap-1" aria-label="Order of your social icons">
        {shown.length > 0 && head("Shown on your profile", "aq-order-shown")}
        {shown.map((it, i) => row(it, i))}
        {rest.length > 0 && head("In the + menu", "aq-order-more")}
        {rest.map((it, i) => row(it, i + shown.length))}
      </ol>
      <p aria-live="polite" className="sr-only">{say}</p>
    </div>
  );
}
