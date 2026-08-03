import { useMemo, useEffect, useState } from "react";

/**
 * Date of birth as three scroll wheels (operator, 2026-07-30: "faster, like a wheel").
 *
 * A native `<input type="date">` is the wrong control for a BIRTHDAY. It opens on the current month
 * — so a member born in 1994 starts roughly 380 taps of "previous month" away, and on desktop it is
 * a typing exercise with a locale-dependent order (is 03/04 March or April?). Day / month / year as
 * three columns is one flick each, and the year column can be entered anywhere along its length.
 *
 * Built from three native `<select>`s, deliberately:
 *   - iOS and Android already render a select as a full-height wheel picker, which is exactly the
 *     control asked for, with the platform's own momentum, haptics and accessibility.
 *   - It is a real form control, so it keyboards, screen-reads, autofills and validates for free.
 *     A hand-rolled scroll-snap wheel gets none of that and has to reimplement all of it badly.
 *   - On desktop it is a dropdown you can TYPE into: "199" jumps straight to 1990.
 *
 * The value is the same `YYYY-MM-DD` string the server expects, so nothing downstream changes; it
 * emits only when all three columns are set, and it clamps the day to the selected month (choosing
 * 31 then February must not produce the 31st of February).
 */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function daysIn(year: number, month: number): number {
  if (!year || !month) return 31;          // nothing chosen yet — offer the full range
  return new Date(year, month, 0).getDate(); // day 0 of next month = last day of this one
}

const pad = (n: number) => String(n).padStart(2, "0");

export function DobWheel({
  value,
  onChange,
  minYear,
  maxYear,
  id,
  describedBy,
  invalid,
}: {
  /** `YYYY-MM-DD`, or "" when incomplete. */
  value: string;
  onChange: (ymd: string) => void;
  minYear: number;
  maxYear: number;
  id?: string;
  describedBy?: string;
  invalid?: boolean;
}) {
  /* THE THREE COLUMNS ARE HELD HERE, not derived from `value`.
   *
   * This component reports a date only when all three parts are chosen — the parent wants a whole
   * `YYYY-MM-DD` or nothing. Deriving the columns straight back out of that string made the control
   * impossible to use: picking a day emitted "" (month and year still unset), "" parsed back to
   * day 0, and the column you had just set snapped to "Day". Every pick was discarded, so the third
   * pick could never happen and NOBODY COULD COMPLETE SIGN-UP. It failed everywhere, but it reads
   * as a mobile fault because there the wheel visibly closes and reverts.
   *
   * So the parts are local state, seeded from `value` and re-adopted whenever the parent hands down
   * a COMPLETE date that differs (an existing birthday, a reset). A parent value of "" never clears
   * what the member has picked so far — that is exactly the state being reported as incomplete. */
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  const [parts, setParts] = useState(() => ({
    y: parsed ? Number(parsed[1]) : 0,
    mo: parsed ? Number(parsed[2]) : 0,
    d: parsed ? Number(parsed[3]) : 0,
  }));
  const { y, mo, d } = parts;
  useEffect(() => {
    const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    if (!p) return; // incomplete upstream — keep the columns the member has already set
    const [ny, nmo, nd] = [Number(p[1]), Number(p[2]), Number(p[3])];
    setParts((cur) => (cur.y === ny && cur.mo === nmo && cur.d === nd ? cur : { y: ny, mo: nmo, d: nd }));
  }, [value]);

  // Newest first: a member is far likelier to be 22 than 98, so the plausible years are at the top
  // of the wheel rather than a hundred rows down.
  const years = useMemo(() => {
    const out: number[] = [];
    for (let v = maxYear; v >= minYear; v--) out.push(v);
    return out;
  }, [minYear, maxYear]);

  const days = useMemo(() => {
    const n = daysIn(y, mo);
    return Array.from({ length: n }, (_, i) => i + 1);
  }, [y, mo]);

  // Selecting a shorter month while a late day is held must not produce an impossible date: the day
  // is clamped in the COLUMNS as well as in what we report, so the member sees 31 become 28 rather
  // than sending one date while the wheel shows another.
  const emit = (ny: number, nm: number, nd: number) => {
    const capped = nd && nm && ny ? Math.min(nd, daysIn(ny, nm)) : nd;
    setParts({ y: ny, mo: nm, d: capped });
    onChange(ny && nm && capped ? `${ny}-${pad(nm)}-${pad(capped)}` : "");
  };

  /* NOTHING focuses itself here, in either direction.
   *
   * On mount, focusing would throw a wheel open over the form before the member has read what is
   * being asked for. And focusing on `invalid` was worse: `invalid` can only become true once all
   * three columns are set — i.e. immediately after their LAST pick, which is nearly always the Year
   * (rightmost column, and the 13/120 rule is a year rule). So the moment they chose a year we
   * yanked focus back to the Day column, and their next keystroke silently edited the wrong field.
   * The error text below the row is how the problem is reported; it does not need to steal focus. */

  // Option ink/surface is handled site-wide in index.css (`select option`): a native menu paints its
  // own LIGHT surface, so options inheriting this field's near-white text render invisible.
  const sel =
    "h-11 min-w-0 flex-1 rounded-field border border-line bg-space-1 px-2 text-[15px] text-ink outline-none transition-colors focus:border-yin-light";

  return (
    <div className="flex gap-2" id={id}>
      <select
        className={sel}
        aria-label="Day of birth"
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        value={d || ""}
        onChange={(e) => emit(y, mo, Number(e.target.value))}
      >
        <option value="">Day</option>
        {days.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <select
        className={`${sel} flex-[1.5]`}
        aria-label="Month of birth"
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        value={mo || ""}
        onChange={(e) => emit(y, Number(e.target.value), d)}
      >
        <option value="">Month</option>
        {MONTHS.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
      </select>
      <select
        className={sel}
        aria-label="Year of birth"
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        value={y || ""}
        onChange={(e) => emit(Number(e.target.value), mo, d)}
      >
        <option value="">Year</option>
        {years.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </div>
  );
}
