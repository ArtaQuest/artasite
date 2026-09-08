import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cx } from "../ui";
import { MON_FIRST, WEEKDAY_NAMES, addDays, addMonths, dayHeadingLong, monthCells, monthOf, sameDayIn, weekIndex } from "../../lib/booking-time";

/**
 * The booking calendar, shared.
 *
 * The three components below are copies of the ones in pages/Book.tsx (which deliberately exports
 * nothing — a page module that also exports helpers breaks Fast Refresh and the lint). Book.tsx is
 * the original: change it there first, then here. The arithmetic they draw with is in
 * lib/booking-time.ts.
 */

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;
export const ChevronGlyph = ({ back }: { back?: boolean }) => (
  <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden {...STROKE}><path d={back ? "m14 6-6 6 6 6" : "m10 6 6 6-6 6"} /></svg>
);
export const CheckGlyph = ({ size = 28 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden className="shrink-0 text-yang" {...STROKE}><circle cx="12" cy="12" r="9" /><path d="m8 12.4 2.6 2.6L16 9.6" /></svg>
);
export const GlobeGlyph = ({ size = 14 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden className="shrink-0" {...STROKE}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" /></svg>
);

/** The grid's geometry, written down once so the skeleton and the real month measure the same. */
const GRID_ROWS = "grid grid-cols-7 gap-1 md:gap-2";
const CELL_H = "h-[52px] md:h-16";

export function WeekdayStrip() {
  return (
    <div data-ay-skip="1" aria-hidden className={cx(GRID_ROWS, "mt-3 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-2")}>
      {MON_FIRST.map((i) => <span key={i} className="text-center">{WEEKDAY_NAMES[i]}</span>)}
    </div>
  );
}

export function GridSkeleton() {
  return (
    <div aria-hidden className={cx(GRID_ROWS, "mt-2")}>
      {Array.from({ length: 42 }, (_, i) => (
        <div key={i} className={cx(CELL_H, "animate-pulse rounded-card bg-veil/5")} />
      ))}
    </div>
  );
}

export function DayGrid({ month, dayMap, todayKey, horizonKey, selected, onChoose, onMonth }: {
  month: string;
  dayMap: Map<string, number[]>;
  todayKey: string;
  horizonKey: string;
  selected: string;
  onChoose: (key: string) => void;
  onMonth: (m: string) => void;
}) {
  const cells = useMemo(() => monthCells(month), [month]);
  const firstStop = useMemo(
    () => cells.find((k) => k && k >= todayKey && k <= horizonKey) || cells.find(Boolean) || "",
    [cells, todayKey, horizonKey],
  );
  const rows = useMemo(() => {
    const all = [0, 1, 2, 3, 4, 5];
    const live = (r: number) =>
      cells.slice(r * 7, r * 7 + 7).some((k) => k && k >= todayKey && k <= horizonKey);
    const first = all.findIndex(live);
    if (first < 0) return all;
    return all.slice(first, all.length - [...all].reverse().findIndex(live));
  }, [cells, todayKey, horizonKey]);

  const [focusKey, setFocusKey] = useState(selected || firstStop);
  const want = useRef("");
  const boxes = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    setFocusKey((k) => (k && monthOf(k) === month ? k
      : selected && monthOf(selected) === month ? selected
      : firstStop));
  }, [month, selected, firstStop]);

  useEffect(() => {
    if (!want.current) return;
    const el = boxes.current[want.current];
    want.current = "";
    el?.focus();
  }, [focusKey, month]);

  const busiest = useMemo(() => {
    let n = 0;
    for (const key of cells) if (key) n = Math.max(n, dayMap.get(key)?.length || 0);
    return n;
  }, [cells, dayMap]);

  function move(to: string) {
    if (!to) return;
    const next = to < todayKey ? todayKey : to > horizonKey ? horizonKey : to;
    want.current = next;
    if (monthOf(next) !== month) onMonth(monthOf(next));
    setFocusKey(next);
  }

  function keyTarget(key: string, k: string): string {
    switch (key) {
      case "ArrowLeft": return addDays(k, -1);
      case "ArrowRight": return addDays(k, 1);
      case "ArrowUp": return addDays(k, -7);
      case "ArrowDown": return addDays(k, 7);
      case "Home": return addDays(k, -weekIndex(k));
      case "End": return addDays(k, 6 - weekIndex(k));
      case "PageUp": return sameDayIn(addMonths(month, -1), k);
      case "PageDown": return sameDayIn(addMonths(month, 1), k);
      default: return "";
    }
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const k = focusKey;
    if (!k) return;
    const next = keyTarget(e.key, k);
    if (!next) return;
    e.preventDefault();
    move(next);
  }

  return (
    <div role="grid" aria-label="Days" className={cx(GRID_ROWS, "mt-2")} onKeyDown={onKey}>
      {rows.map((row) => (
        <div key={row} role="row" className="contents">
          {cells.slice(row * 7, row * 7 + 7).map((key, i) => {
            if (!key) return <div key={`b${row}-${i}`} aria-hidden="true" className={CELL_H} />;
            const free = dayMap.get(key)?.length || 0;
            const on = key === selected;
            const isToday = key === todayKey;
            const roving = key === focusKey ? 0 : -1;
            const setRef = (el: HTMLElement | null) => { boxes.current[key] = el; };
            if (!free) {
              return (
                <div key={key} role="gridcell" aria-disabled="true" tabIndex={roving} ref={setRef}
                  {...(isToday ? { "aria-current": "date" as const } : {})}
                  style={{ position: "relative" }}
                  className={cx("grid place-items-center text-[15px] font-normal tabular-nums text-ink-2 outline-none md:text-[17px]", CELL_H)}>
                  {isToday && <span aria-hidden className="pointer-events-none absolute h-9 w-9 rounded-full ring-1 ring-inset ring-yin-light/60 md:h-11 md:w-11" />}
                  <span aria-hidden data-ay-skip="1">{Number(key.slice(8, 10))}</span>
                  <span className="sr-only"><span data-ay-skip="1">{dayHeadingLong(key)}</span> — nothing free</span>
                </div>
              );
            }
            const pct = busiest ? Math.max(12, Math.round((free / busiest) * 100)) : 0;
            return (
              <button key={key} type="button" role="gridcell" ref={setRef} tabIndex={roving}
                aria-selected={on} {...(isToday ? { "aria-current": "date" as const } : {})}
                onClick={() => onChoose(key)}
                className={cx("group grid place-items-center outline-none", CELL_H)}>
                <span aria-hidden
                  className={cx("relative grid h-9 w-9 place-items-center rounded-full text-[15px] font-semibold tabular-nums transition-colors duration-150 md:h-11 md:w-11 md:text-[17px]",
                    on ? "bg-yang text-on-accent shadow-card"
                       : "bg-yang/[0.10] text-ink group-hover:bg-yang/25 group-focus-visible:bg-yang/25",
                    isToday && !on && "ring-1 ring-inset ring-yin-light/60")}>
                  <span data-ay-skip="1">{Number(key.slice(8, 10))}</span>
                </span>
                <span aria-hidden className="mt-1 h-1 w-1 rounded-full bg-yang" style={{ opacity: on ? 0 : 0.25 + (pct / 100) * 0.6 }} />
                <span className="sr-only">
                  <span data-ay-skip="1">{dayHeadingLong(key)}</span>, <span data-ay-skip="1">{free}</span> times free
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
