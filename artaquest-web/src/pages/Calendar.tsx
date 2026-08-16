import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  calendarAgenda, calendarCal,
  type CalendarCal, type CalendarItem, type CalendarKind,
} from "../lib/api";
import { RailPortal } from "../components/RightRail";
import { isLoggedIn, localePath } from "../lib/wp";
import { Button, EmptyState, ErrorNote, PageHero, Segmented, StatusNote, Toolbar, cx } from "../components/ui";

/**
 * ArtaCalendar — a member's dated life in one place.
 *
 * Three sources, one window: the ArtaMeet meetings you are invited to, the grant deadlines you are
 * on the hook for, and the challenges you entered. It owns no rows of its own — every item here is
 * a projection of something that already exists somewhere else, which is why an item is identified
 * by a key naming its source ("meet:12") rather than by an id of its own.
 *
 * ⚠️ TWO KINDS OF WHEN, and conflating them is the one bug this page cannot ship with. A meeting
 * happens at an INSTANT, so it is rendered in the viewer's own zone with the zone named — a time in
 * the wrong zone is worse than no time. A deadline is a DATE: it is carried as midnight UTC and is
 * rendered in UTC, because formatting it in the viewer's zone shows everybody west of Greenwich a
 * deadline a day early. Neither treatment is right for the other value. See whenLine() and zoneOf().
 *
 * ⚠️ `data-ay-skip="1"` on the wrapper around every formatted date, every member-authored title and
 * every live count. Not for secrecy — these are public rows at /data/ — but because the i18n mesh
 * walks document.body and PERSISTS what it finds into the public aq_translations table, which would
 * republish a host's wording, and machine-translate a date in place. Mark wrappers, never leaves.
 * The one deliberate exception is "Today"/"Tomorrow": those are our words, not machine output, and
 * they are rendered unmarked so they can be translated like the rest of the page.
 */

/** How far ahead the window reaches. 30 days is the default because a month is the unit people
 *  actually plan in; the other two are "just this week" and "the whole term". */
const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "3 months" },
] as const;

const VIEWER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
})();

/* ───────────────────────── time ─────────────────────────
   These mirror ArtaMeet's formatters deliberately, rather than importing them: pages/Meet.tsx does
   not export them, and this page is not allowed to reach into it. If they ever move into a shared
   module, both should move together — one calendar reading a time differently from the other is
   exactly the confusion the zone label exists to prevent. */

function fmt(ts: number, opts: Intl.DateTimeFormatOptions, tz?: string): string {
  const d = new Date(Number(ts) * 1000);
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { ...opts, ...(tz ? { timeZone: tz } : {}) }).format(d);
}

/** The zone's own short name at an instant ("GMT+3", "BST"), read out of the formatter. A formatter
 *  given ONLY timeZoneName falls back to printing a date beside it, so ask for a time and keep the
 *  one part we want. */
function zoneName(ts: number): string {
  const parts = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })
    .formatToParts(new Date(Number(ts) * 1000));
  return parts.find((p) => p.type === "timeZoneName")?.value || "";
}

/** YYYY-MM-DD for an instant in a named zone — en-CA writes that order natively, and it is what the
 *  day grouping and the Today/Tomorrow comparison are both keyed on. */
function dayKey(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Number(ts) * 1000));
}

/** Midnight today, in the viewer's zone, as a unix instant — the lower edge of the window. Derived
 *  by subtracting the clock time that has elapsed today rather than by arithmetic on a UTC day, so
 *  it lands on the member's own midnight. Across a DST step it can land an hour early, which widens
 *  the window by an hour and can never hide an item. */
function startOfToday(now: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: VIEWER_TZ, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(now * 1000));
  const p: Record<string, number> = {};
  for (const x of parts) if (x.type !== "literal") p[x.type] = Number(x.value);
  const elapsed = ((p.hour || 0) % 24) * 3600 + (p.minute || 0) * 60 + (p.second || 0);
  return now - elapsed;
}

function fmtRelative(ts: number, now: number): string {
  const d = Number(ts) - now;
  const abs = Math.abs(d);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60) return rtf.format(Math.round(d), "second");
  if (abs < 3600) return rtf.format(Math.round(d / 60), "minute");
  if (abs < 172800) return rtf.format(Math.round(d / 3600), "hour");
  return rtf.format(Math.round(d / 86400), "day");
}

/** The zone an item is honest in. A timed thing belongs to the viewer's day; an all-day thing IS a
 *  date, carried as midnight UTC, and belongs to the UTC one. */
const zoneOf = (it: CalendarItem) => (it.all_day ? "UTC" : VIEWER_TZ);

/** The one long "when" line, in the item's own terms and always naming the zone when there is a
 *  clock time to name it for. */
function whenLine(it: CalendarItem): string {
  if (it.all_day) {
    return fmt(it.start_ts, { weekday: "long", day: "numeric", month: "long", year: "numeric" }, "UTC") + " · all day";
  }
  const start = fmt(it.start_ts, {
    weekday: "long", day: "numeric", month: "long",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });
  return Number(it.end_ts) > Number(it.start_ts)
    ? `${start} – ${fmt(it.end_ts, { hour: "2-digit", minute: "2-digit" })}`
    : start;
}

/* ───────────────────────── kinds ───────────────────────── */

const KIND: Record<CalendarKind, { label: string; glyph: ReactNode }> = {
  meeting: {
    label: "Meeting",
    glyph: <><circle cx="10" cy="10" r="7.25" /><path d="M10 5.5V10l3 1.8" /></>,
  },
  grant: {
    label: "Deadline",
    glyph: <><path d="M5.25 17.5V3" /><path d="M5.25 4h9.5l-2.2 3.2 2.2 3.2h-9.5" /></>,
  },
  challenge: {
    label: "Challenge",
    glyph: <><path d="M7 3.5h6v3.75a3 3 0 0 1-6 0z" /><path d="M7 4.75H4.5v.75a3 3 0 0 0 2.9 3M13 4.75h2.5v.75a3 3 0 0 1-2.9 3M10 10.5v3.25M7.25 16.5h5.5" /></>,
  },
};

function KindTag({ kind, timed }: { kind: CalendarKind; timed: boolean }) {
  return (
    // Two colours, and they carry the meaning the page is asked to make visible: gold is a timed
    // thing that starts at a clock time, blue is an all-day date. The word beside the glyph says
    // which of the three sources it came from, so nothing rests on colour alone.
    <span className={cx("inline-flex h-6 shrink-0 items-center gap-1 rounded-pill px-2 text-[11px] font-semibold",
      timed ? "bg-yang/15 text-yang" : "bg-yin/15 text-yin-light")}>
      <svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden>{KIND[kind].glyph}</svg>
      {KIND[kind].label}
    </span>
  );
}

/* ───────────────────────── actions ───────────────────────── */

/** Every action is 40px tall on every viewport. A calendar is read one-handed on a phone, and the
 *  two secondary links sit next to a primary one — a 28px text link between them is a miss. */
const ACTION = "inline-flex h-10 items-center rounded-pill text-[13px] font-semibold";

function openLabel(it: CalendarItem): string {
  if (it.kind === "meeting") return "Open";
  return it.kind === "grant" ? "Open the grant" : "Open the challenge";
}

function ItemActions({ it }: { it: CalendarItem }) {
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1">
      {it.url && it.status !== "cancelled" && (
        <Link to={localePath(it.url)}
          className={cx(ACTION, "bg-yang px-4 text-on-accent transition-colors hover:bg-yin hover:text-white")}>
          {openLabel(it)}
        </Link>
      )}
      {/* The server composes both of these — a Google template URL built in the browser is a second
          place for the same event's wording and instants to drift out of step with the .ics. */}
      {it.gcal_url && it.status !== "cancelled" && (
        <a href={it.gcal_url} target="_blank" rel="noopener noreferrer"
          className={cx(ACTION, "px-2 text-ink-2 hover:text-ink")}>＋ Google Calendar</a>
      )}
    </div>
  );
}

/* ───────────────────────── the next thing ───────────────────────── */

/** The whole point of opening this page, and it must be readable without scrolling — so it is a
 *  block of its own above the list rather than the first row of it. */
function NextUp({ it, now }: { it: CalendarItem; now: number }) {
  return (
    <section aria-label="What is next" className="rounded-card border border-line bg-space-2 p-4 sm:p-5">
      <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-ink-2">Next up</p>
      <div className="mt-2 flex items-start gap-3">
        <span data-ay-skip="1" className="min-w-0 flex-1">
          <h2 className={cx("break-words text-[clamp(1.05rem,2.4vw,1.3rem)] font-bold leading-snug text-ink",
            it.status === "cancelled" && "line-through")}>{it.title}</h2>
        </span>
        <KindTag kind={it.kind} timed={!it.all_day} />
      </div>
      <p className="mt-1.5 text-[14px] leading-relaxed text-ink-2" data-ay-skip="1">{whenLine(it)}</p>
      <p className="mt-0.5 text-[12.5px] text-ink-2">
        {it.status === "cancelled" ? "Cancelled — it stays here so nobody turns up to it by mistake" : (
          <>Starts <span data-ay-skip="1">{fmtRelative(it.start_ts, now)}</span></>
        )}
      </p>
      {it.detail && <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2" data-ay-skip="1">{it.detail}</p>}
      <ItemActions it={it} />
    </section>
  );
}

/* ───────────────────────── one row ───────────────────────── */

function ItemRow({ it, now }: { it: CalendarItem; now: number }) {
  const timed = !it.all_day;
  const done = Number(it.end_ts) <= now;
  return (
    <article className={cx(
      "group relative flex gap-3 rounded-card border border-s-[3px] border-line bg-space-2 p-3.5",
      timed ? "border-s-yang" : "border-s-yin-light",
      (done || it.status === "cancelled") && "opacity-60",
    )}>
      {/* THE WHOLE ROW IS THE LINK. It used to be the title alone — a 23px line inside a 70px
          card, so most of what looked pressable was not. A stretched <a> behind the content, with
          the content ignoring the pointer so a tap anywhere on the row lands on it. */}
      {it.url && <Link to={localePath(it.url)} className="absolute inset-0 z-0 rounded-card outline-none" aria-label={it.title} />}
      {/* The time column is what makes a list of rows read as a day. The zone is NOT repeated here:
          the toolbar above says once, in words, which zone every time on the page is in, and a
          two-letter code under each clock was the same fact forty times at 11px. */}
      <div className="pointer-events-none relative z-[1] w-[62px] shrink-0 sm:w-[76px]">
        {timed ? (
          <span className="block text-[14px] font-semibold tabular-nums text-yang" data-ay-skip="1">
            {fmt(it.start_ts, { hour: "2-digit", minute: "2-digit" })}
          </span>
        ) : (
          <span className="block text-[13px] font-semibold leading-tight text-yin-light">All day</span>
        )}
      </div>

      <div className="pointer-events-none relative z-[1] min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <span data-ay-skip="1" className="min-w-0 flex-1">
            {it.url ? (
              <span className={cx("block break-words text-[15px] font-semibold text-ink group-hover:text-yang", it.status === "cancelled" && "line-through")}>
                {it.title}
              </span>
            ) : (
              <span className={cx("block break-words text-[15px] font-semibold text-ink", it.status === "cancelled" && "line-through")}>{it.title}</span>
            )}
          </span>
          <KindTag kind={it.kind} timed={timed} />
        </div>

        {timed && (
          <p className="mt-0.5 text-[12px] text-ink-2">
            <span data-ay-skip="1">
              until {fmt(it.end_ts, { hour: "2-digit", minute: "2-digit" })}
            </span>
            {!done && it.status !== "cancelled" && <> · <span data-ay-skip="1">{fmtRelative(it.start_ts, now)}</span></>}
          </p>
        )}
        {/* Two lines, then an ellipsis. A grant's `detail` is its whole eligibility paragraph, and
            unclamped it turned one row of a diary into fifteen lines of prose — the row is the
            pointer, the page it links to is the reading. */}
        {it.detail && <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-ink-2" data-ay-skip="1">{it.detail}</p>}
        {it.status === "cancelled" && <p className="mt-1 text-[12.5px] font-semibold text-ink-2">Cancelled</p>}
        {/* The row's own buttons take the pointer back — the wrapper gave it up so the row-link
            beneath could have it, and a control that inherits that is a control that cannot be
            pressed. */}
        <div className="pointer-events-auto"><ItemActions it={it} /></div>
      </div>
    </article>
  );
}

/* ───────────────────────── the rail ───────────────────────── */

/** The subscription. One address covers all three sources, so a member's phone shows their next
 *  meeting and their next deadline in the same place they keep everything else. */
function SubscribePanel({ cal }: { cal: CalendarCal | null }) {
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function copy() {
    if (!cal) return;
    try {
      await navigator.clipboard.writeText(cal.ics);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setNote("This browser wouldn’t let the page copy — select the address and copy it by hand.");
    }
  }

  return (
    <section className="rounded-card border border-line bg-space-2 p-4" aria-label="Calendar subscription">
      <h2 className="text-[14px] font-semibold text-ink">Subscribe to Calendar</h2>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">
        Your meetings, your deadlines and the challenges you entered — kept up to date wherever you keep the
        rest of your life
      </p>
      {!cal ? (
        <StatusNote className="py-6">Fetching your calendar address…</StatusNote>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href={cal.webcal}
              className="inline-flex h-10 items-center rounded-pill bg-yang px-4 text-[13px] font-bold text-on-accent transition-colors hover:bg-yin hover:text-white">
              Subscribe
            </a>
            <button type="button" onClick={() => void copy()}
              className="inline-flex h-10 items-center rounded-pill border border-line px-4 text-[13px] font-semibold text-ink-2 hover:border-yin-light hover:text-ink">
              {copied ? "Copied" : "Copy the address"}
            </button>
          </div>
          <p className="mt-2 break-all font-mono text-[12px] leading-relaxed text-ink-2" data-ay-skip="1">{cal.ics}</p>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-2">
            Apple Calendar and Outlook take the Subscribe button. Google Calendar wants the address pasted into
            Other calendars → From URL
          </p>
        </>
      )}
      {note && <p className="mt-2 text-[12.5px] text-ink-2">{note}</p>}
    </section>
  );
}

/** What a member can DO about an empty calendar, in the rail as well as in the empty state — the
 *  three sources are not obvious from the outside, and a page that only says "nothing here" leaves
 *  someone with no idea which door to knock on. */
const SOURCES: { label: string; body: string; href: string; cta: string }[] = [
  { label: "Meetings", body: "Every meeting you host or are invited to, from the moment you are invited", href: "/messages/?box=meetings", cta: "ArtaChat" },
  { label: "Deadlines", body: "The grants you registered to help us apply for, plus their working sessions", href: "/sponsors/", cta: "Sponsors" },
  { label: "Challenges", body: "The ones you entered, dated by their full-moon deadline", href: "/challenges/", cta: "Challenges" },
];

function SourcesPanel() {
  return (
    <section className="rounded-card border border-line bg-space-2 p-4" aria-label="How a date gets here">
      <h2 className="text-[14px] font-semibold text-ink">How a date gets here</h2>
      <ul className="mt-3 flex flex-col gap-3">
        {SOURCES.map((s) => (
          <li key={s.href}>
            <p className="text-[13px] font-semibold text-ink">{s.label}</p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-2">{s.body}</p>
            <Link to={localePath(s.href)} className="-mx-1 mt-0.5 inline-flex h-10 items-center px-1 text-[12.5px] font-semibold text-ink-2 hover:text-ink">
              {s.cta} →
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-3 border-t border-line pt-3 text-[12px] leading-relaxed text-ink-2">
        Nothing is added here on your behalf. A date appears because you were invited, you registered, or you
        entered — and it leaves when that does
      </p>
    </section>
  );
}

/* ───────────────────────── the page ───────────────────────── */

type DayGroup = { key: string; label: string; literal: boolean; items: CalendarItem[] };

/** Deferred: the booking module carries a calendar grid and slot maths that somebody reading their
 *  week never needs loaded. */
const Availability = lazy(() => import("./Availability"));

/**
 * Two halves of one question — your time.
 *
 * "Ahead" is what has already been claimed: meetings, deadlines, challenges. "When I'm free" is the
 * other side of the same sheet: the hours you are happy to be ASKED for, and the link that shares
 * them. Booking used to be a page of its own at /book, which meant the two answers to "what does my
 * week look like" lived in different places and neither mentioned the other.
 */
export default function Calendar() {
  const [view, setView] = useState<"ahead" | "free">(() =>
    (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab") === "free")
      ? "free" : "ahead");
  const [days, setDays] = useState<number>(30);
  const [items, setItems] = useState<CalendarItem[] | null>(null);
  const [cal, setCal] = useState<CalendarCal | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Math.round(Date.now() / 1000));
  const seq = useRef(0);

  // The relative lines ("in 12 minutes") are the only thing on this page that has to keep moving.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Math.round(Date.now() / 1000)), 30000);
    return () => window.clearInterval(t);
  }, []);

  const load = useCallback((span: number) => {
    const mine = ++seq.current;
    // The window is computed HERE rather than from the ticking `now`, so a clock tick can never
    // re-fetch the page out from under someone reading it.
    const from = startOfToday(Math.round(Date.now() / 1000));
    calendarAgenda({ from, to: from + span * 86400 })
      .then((p) => {
        if (mine !== seq.current) return;
        setFailed(false);
        setItems([...p.items].sort((a, b) => Number(a.start_ts) - Number(b.start_ts)));
      })
      // A FAILED request is not an empty diary. Falling through to the empty state would tell a
      // member with three deadlines this month that they have none, on exactly the request that
      // did not come back.
      .catch(() => { if (mine === seq.current) { setItems(null); setFailed(true); } });
  }, []);

  useEffect(() => { setItems(null); load(days); }, [days, load]);

  useEffect(() => {
    let stop = false;
    calendarCal().then((c) => { if (!stop) setCal(c); }).catch(() => undefined);
    return () => { stop = true; };
  }, []);

  const todayKey = useMemo(() => dayKey(now, VIEWER_TZ), [now]);
  const tomorrowKey = useMemo(() => dayKey(now + 86400, VIEWER_TZ), [now]);

  /** One block per calendar day, in order. Keyed on the day each item is honest in — the viewer's
   *  for a timed one, UTC for a date — so a deadline sits under the day it is actually due. */
  const groups = useMemo<DayGroup[]>(() => {
    const out: DayGroup[] = [];
    for (const it of items || []) {
      const key = dayKey(it.start_ts, zoneOf(it));
      const last = out[out.length - 1];
      if (last && last.key === key) { last.items.push(it); continue; }
      // Today and Tomorrow are OUR words and are left translatable; every other heading is machine
      // output and is marked at the call site. The key is parsed back at UTC noon purely to format
      // it, so no zone can drag the heading onto a neighbouring day.
      const literal = key === todayKey || key === tomorrowKey;
      const noon = Math.round(Date.parse(key + "T12:00:00Z") / 1000);
      out.push({
        key,
        literal,
        label: key === todayKey ? "Today" : key === tomorrowKey ? "Tomorrow" : fmt(noon, {
          weekday: "long", day: "numeric", month: "long",
          ...(key.slice(0, 4) !== todayKey.slice(0, 4) ? { year: "numeric" } : {}),
        }, "UTC"),
        items: [it],
      });
    }
    return out;
  }, [items, todayKey, tomorrowKey]);

  const next = useMemo(() => (items || []).find((it) => Number(it.end_ts) > now && it.status !== "cancelled"), [items, now]);
  const rangeLabel = RANGES.find((r) => r.days === days)?.label || `${days} days`;

  if (!isLoggedIn()) {
    // PageHero owns the page's one <h1>, so the gate is an EmptyState rather than SignInGate — two
    // <h1>s is what the shell's route-change focus lands on, and it has to land on one thing.
    return (
      <div className="flex flex-col gap-6 pb-12">
        <div className="mx-auto w-full max-w-[1076px]">
          <PageHero eyebrow="Community" title="Calendar"
            lede="Your meetings, your deadlines and the challenges you entered — one page, your own time zone." />
        </div>
        <EmptyState className="mx-auto w-full max-w-[1076px]" title="Sign in to see your calendar"
          body="A calendar is only yours: the meetings you were invited to, the grants you registered for, the challenges you entered. None of it exists for anyone who is not signed in as you."
          action={<Button href="/login/">Sign in</Button>} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 pb-12">
      <div className="mx-auto w-full max-w-[1076px]">
        <PageHero eyebrow="Community" title="Calendar"
          lede="Everything you are dated for, in one place and in your own time zone — meetings, deadlines and the challenges you entered." />
      </div>

      <div className="mx-auto flex w-full max-w-[1076px] flex-col gap-4 md:flex-row md:items-start lg:gap-7">
        <main className="flex w-full min-w-0 flex-col gap-4 md:max-w-2xl md:flex-1">
          <Segmented className="[&>button]:h-10" label="Your time" value={view}
            onChange={(v) => setView(v as "ahead" | "free")}
            options={[{ value: "ahead", label: "Ahead" }, { value: "free", label: "When I’m free" }]} />

          {view === "free" ? (
            <Suspense fallback={<StatusNote>Loading your availability…</StatusNote>}>
              <Availability share="inline" />
            </Suspense>
          ) : failed ? (
            <ErrorNote>
              Couldn’t load your calendar.{" "}
              <button type="button" className="-my-1 inline-block py-1 font-semibold underline" onClick={() => load(days)}>Try again</button>
            </ErrorNote>
          ) : items === null ? (
            <StatusNote>Loading your calendar…</StatusNote>
          ) : next ? (
            <NextUp it={next} now={now} />
          ) : items.length > 0 ? (
            <StatusNote className="rounded-card border border-line bg-space-2 py-6">
              Nothing else ahead in the next <span data-ay-skip="1">{rangeLabel}</span> — what is below has already been and gone
            </StatusNote>
          ) : null}

          <Toolbar
            filters={
              <div role="radiogroup" aria-label="How far ahead"
                className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-pill border border-line bg-space-2 p-0.5">
                {RANGES.map((r) => {
                  const on = r.days === days;
                  return (
                    <button key={r.days} type="button" role="radio" aria-checked={on} onClick={() => setDays(r.days)}
                      className={cx("h-10 shrink-0 whitespace-nowrap rounded-pill px-3.5 text-[13px] font-semibold transition-colors",
                        on ? "bg-yang text-on-accent" : "text-ink-2 hover:bg-veil/5 hover:text-ink")}>
                      {r.label}
                    </button>
                  );
                })}
              </div>
            }
            count={items && items.length > 0 ? (
              <>
                <span data-ay-skip="1">{items.length}</span> dated {items.length === 1 ? "thing" : "things"} in the next{" "}
                <span data-ay-skip="1">{rangeLabel}</span>. All times shown in{" "}
                {/* The zone, named once and plainly. A clock time whose zone is left to be guessed is
                    the same mistake as the wrong zone, wearing a disguise. */}
                <span data-ay-skip="1">{VIEWER_TZ} ({zoneName(now)})</span>
              </>
            ) : undefined}
          />

          {items !== null && items.length === 0 && !failed && (
            <EmptyState
              title={`Nothing in the next ${rangeLabel}`}
              body="A date lands here on its own: when someone invites you to a meeting, when you register on a grant we are applying for, or when you enter a challenge. Nothing is ever added here on your behalf."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button href="/messages/?box=meetings">Schedule a meeting</Button>
                  <Button href="/challenges/" variant="outline">Find a challenge</Button>
                </div>
              } />
          )}

          {groups.map((g) => (
            <section key={g.key} aria-label={g.label}>
              <h2 className="sticky top-topbar z-10 -mx-1 bg-space-1/85 px-1 py-1.5 text-[13px] font-semibold uppercase tracking-wide text-ink-2 backdrop-blur supports-[backdrop-filter]:bg-space-1/70">
                {g.literal ? g.label : <span data-ay-skip="1">{g.label}</span>}
              </h2>
              <ul className="mt-1.5 flex flex-col gap-2.5">
                {g.items.map((it) => (
                  <li key={it.key}><ItemRow it={it} now={now} /></li>
                ))}
              </ul>
            </section>
          ))}

          {/* Looking further ahead belongs at the BOTTOM as well as the top: the member who has just
              read to the end of the window is the one who wants more of it. */}
          {items !== null && items.length > 0 && days < 90 && (
            <div className="flex justify-center pt-1">
              <button type="button" onClick={() => setDays(days === 7 ? 30 : 90)}
                className="inline-flex h-11 items-center rounded-pill border border-line bg-space-2 px-6 text-[14px] font-semibold text-ink-2 transition-colors hover:border-yin-light hover:text-ink">
                {days === 7 ? "Look 30 days ahead" : "Look 3 months ahead"}
              </button>
            </div>
          )}
        </main>

                {/* These cards belong to THE right column (RightRail.tsx); below lg they stay here in
            the flow, which is where this aside always rendered on a phone. */}
        <RailPortal>
          <SubscribePanel cal={cal} />
          <SourcesPanel />
        </RailPortal>
      </div>
    </div>
  );
}
