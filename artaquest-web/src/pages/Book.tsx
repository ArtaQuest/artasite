import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { RailSearch } from "../components/RightRail";
import { useOwnsRail } from "../lib/rail";
import { useParams } from "react-router-dom";
import {
  ApiError, bookPage, bookRuleOff, bookRules, bookSetRule, bookSlots, bookTake,
  type BookOwner, type BookRule,
} from "../lib/api";
import { currentUser, isLoggedIn, localePath } from "../lib/wp";
import {
  Avatar, Button, EmptyState, ErrorNote, Field, IconButton, Input, LinkButton, PageHero, Pill,
  Segmented, Select, SkeletonCard, StatusNote, Textarea, cx,
} from "../components/ui";

/**
 * ArtaBook — "here is when I am free; take one".
 *
 * TWO AUDIENCES, ONE FILE, and the split is the whole design:
 *
 *   /book/<handle> — a VISITOR, quite possibly a stranger and quite possibly signed out. They see
 *     whose page this is, what is offered and WHEN THAT PERSON IS FREE, with no account at all.
 *     That is the competitive part: somebody deciding whether to ask for your time should not have
 *     to register to find out whether you have any. Signing in is asked for once, at the moment a
 *     time is actually claimed — and the page says so three times before they invest a single click.
 *
 *   /book — the OWNER. Their own availability as a RULE (which days, which hours of THEIR day, how
 *     long, how much notice, how far ahead) and the one link they hand out.
 *
 * ⚠️ FREE/BUSY ONLY. Everything the public half receives is a list of start instants. A busy hour
 * is simply an absent instant — never a title, never a name, never a count. Meetings are separately
 * public rows at /data/, and that is a different argument entirely: a page built to be pasted into
 * a stranger's inbox is not the place to re-publish someone's diary. If a title ever appears on
 * this wire, it is a bug (see the note over bookSlots in lib/api.ts).
 *
 * ⚠️ A BOOKING IS A MEETING. Taking a slot creates an ordinary aq_meets row with both people as
 * guests, which is why the success card can simply link to /meet/<id> and why ArtaCalendar and the
 * .ics feed carry a booking without knowing this page exists.
 *
 * ⚠️ ONE REQUEST HOLDS THE WHOLE HORIZON. bookSlots answers with every free instant to the rule's
 * horizon, so the month grid, the density bars, the "is there anything in September" question and
 * the whole timezone switch are CLIENT-SIDE DERIVATIONS of one list. Never fetch per month, per
 * zone, or on a zone change: the other booking pages click because their data is not already here.
 *
 * ⚠️ TIMEZONES ARE THE WHOLE PROBLEM. Slots arrive as UTC instants and are rendered in the chosen
 * display zone with the zone NAMED — an unlabelled clock time is the wrong-zone bug wearing a
 * disguise. The owner's zone is shown too, and can be switched to, because "2pm his time" is what
 * the visitor is really agreeing to. The owner's own hours are stored as minutes from midnight IN
 * THEIR ZONE and are never converted on the way out: "I am free from two" is a statement about
 * their afternoon, and it has to survive their DST as well as yours. The INSTANT is the truth and
 * the day key is derived from it, which is why a pick survives a zone switch that moves it onto a
 * neighbouring date. We deliberately do NOT persist a zone — VIEWER_TZ is re-read on every load, so
 * the "your saved zone has drifted" problem cannot exist here. Only the clock FORMAT is persisted.
 *
 * ⚠️ `data-ay-skip="1"` on the wrapper around every formatted date, every clock face, every zone
 * id, every count, every member name and every member-authored word (title, blurb, the visitor's
 * own note). Not for secrecy — but the i18n mesh walks document.body and PERSISTS what it finds
 * into the public aq_translations table, which would republish a member's wording and
 * machine-translate a clock time in place. Mark wrappers, never leaves: write
 * `<span data-ay-skip="1">8</span> times free`, never `<span data-ay-skip="1">8 times free</span>`.
 */

const VIEWER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
})();

/** Every IANA zone the engine knows, for the owner who lives somewhere other than the machine they
 *  happen to be typing on — and for the visitor reading this in an airport. Falls back to the two
 *  zones we can always name. */
const ZONES: string[] = (() => {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    const list = f ? f("timeZone") : [];
    if (list.length) return list.includes(VIEWER_TZ) ? list : [VIEWER_TZ, ...list];
  } catch { /* an engine with no zone list is not a reason to refuse to offer times */ }
  return Array.from(new Set([VIEWER_TZ, "UTC"]));
})();

const DURATIONS = [15, 20, 30, 45, 60, 90, 120];
const BUFFERS = [0, 5, 10, 15, 30];
const NOTICES = [1, 2, 4, 8, 12, 24, 48];
const HORIZONS = [7, 14, 21, 30, 60, 90];
const SEATS = [2, 3, 4, 6, 8];

/** The mask is MONDAY FIRST, which is neither JS's week nor the one half the world starts on — so
 *  it is written down once, here, and every conversion goes through these two. */
const MON_FIRST = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAY_NAMES = MON_FIRST.map((i) =>
  // 2024-01-01 was a Monday, so index 0 formats as Monday in whatever language the page is in.
  new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1 + i))));

/* ───────────────────────── time ─────────────────────────
   These mirror ArtaMeet's and ArtaCalendar's formatters deliberately rather than importing them:
   neither page exports them, and this one is not allowed to reach into either. If they ever move
   into a shared module all three should move together — one surface reading an instant differently
   from another is exactly the confusion the zone label exists to prevent. */

/** "" = whatever the reader's locale does; "12"/"24" = the reader has said, and it then governs
 *  EVERY clock face on the page (slot buttons, both zone clocks, the confirm restatement) and no
 *  date part, which stays locale-shaped. */
/** THE PAGE SPEAKS am/pm, and only am/pm. There used to be a visible 12/24 switch beside the times:
 *  one more decision on a page whose whole job is to make a single decision easy, and it could only
 *  make a familiar row of times less familiar. hour12 and hourCycle fight each other when both are
 *  given, so give exactly one. */
const HOUR_OPTS: Intl.DateTimeFormatOptions = { hour12: true };

function fmt(ts: number, opts: Intl.DateTimeFormatOptions, tz?: string): string {
  const d = new Date(Number(ts) * 1000);
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { ...opts, ...(tz ? { timeZone: tz } : {}) }).format(d);
}

/** The zone's own short name at an instant ("GMT+3", "BST"), read out of the formatter rather than
 *  guessed — it is the only source that knows about DST. A formatter given ONLY timeZoneName prints
 *  a date beside it, so ask for a time and keep the part we want. */
function zoneName(ts: number, tz: string): string {
  const parts = new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "2-digit", minute: "2-digit", timeZoneName: "short" })
    .formatToParts(new Date(Number(ts) * 1000));
  return parts.find((p) => p.type === "timeZoneName")?.value || "";
}

const clockOnly = (ts: number, tz: string) =>
  fmt(ts, { hour: "2-digit", minute: "2-digit", ...HOUR_OPTS }, tz);

/** The whole instant, spelled out, with the zone NAMED — the one shape allowed on a confirmation. */
const longInstant = (ts: number, tz: string) =>
  fmt(ts, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZoneName: "short", ...HOUR_OPTS }, tz);

/** YYYY-MM-DD for an instant in a named zone — en-CA writes that order natively, and it is what the
 *  day grouping, the month grid and the Today comparison are all keyed on. */
function dayKey(ts: number, tz: string): string {
  const d = new Date(Number(ts) * 1000);
  // `t` in the address bar is visitor-controlled and is read back at mount, so this runs on whatever
  // a crafted link supplies. `?t=99999999999999` is finite but outside the Date range, and
  // Intl.format THROWS RangeError on it — inside an effect, which the route error boundary catches
  // by replacing the whole booking page. An owner's link then looks broken to whoever was sent it.
  // An unreadable instant has no day; "" is a value every caller already handles by falling back to
  // the first free day. `fmt` guards itself the same way, for the same reason.
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(d);
}

/** The earlier of two day keys. They are YYYY-MM-DD, so ordering them is ordering the strings; an
 *  empty key means "unknown", and an unknown bound must never be the one that wins. */
function minKey(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/** A day heading from its key. Parsed back at UTC noon purely so it can be formatted: no zone can
 *  drag noon onto a neighbouring day, which a midnight would do for half the planet. */
function dayHeading(key: string, withYear: boolean): string {
  const noon = Math.round(Date.parse(key + "T12:00:00Z") / 1000);
  return fmt(noon, { weekday: "short", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) }, "UTC");
}

/** The same day at full length ("Monday, 17 August"). The phone keeps the short form above, so the
 *  heading changes FORMAT between breakpoints and never size. */
function dayHeadingLong(key: string): string {
  const noon = Math.round(Date.parse(key + "T12:00:00Z") / 1000);
  return fmt(noon, { weekday: "long", day: "numeric", month: "long" }, "UTC");
}

/* ── the month grid is a CALENDAR, not an instant ──
   Every function below is civil-date arithmetic on UTC Dates: a grid of numbered squares has no
   zone, and doing it on local Dates is how a month grid ends up starting on the wrong square for
   readers west of Greenwich. */

const monthOf = (key: string) => key.slice(0, 7);
const pad2 = (n: number) => String(n).padStart(2, "0");

function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** Monday-first weekday index of a day key, 0–6. */
const weekIndex = (key: string) => (new Date(key + "T12:00:00Z").getUTCDay() + 6) % 7;

function monthLabel(month: string, withYear = true): string {
  const [y, m] = month.split("-").map(Number);
  return fmt(Math.round(Date.UTC(y, m - 1, 1, 12) / 1000), { month: "long", ...(withYear ? { year: "numeric" } : {}) }, "UTC");
}

/** The 42 cells of a Monday-first month, '' for the leading and trailing blanks. ALWAYS six rows:
 *  a five-row month and a six-row month must measure the same, or the times below them move. */
function monthCells(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out: string[] = [];
  for (let i = 0; i < 42; i++) {
    const d = i - lead + 1;
    out.push(d >= 1 && d <= days ? `${month}-${pad2(d)}` : "");
  }
  return out;
}

/** Same day-of-month in another month, or that month's last day. */
function sameDayIn(month: string, key: string): string {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${pad2(Math.min(Number(key.slice(8, 10)) || 1, last))}`;
}

/** The zone's offset in seconds at one instant, read back out of the formatter — the only source
 *  that knows about DST. */
function zoneOffsetSec(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const p: Record<string, number> = {};
  for (const x of parts) if (x.type !== "literal") p[x.type] = Number(x.value);
  const asIfUtc = Date.UTC(p.year, (p.month || 1) - 1, p.day || 1, (p.hour || 0) % 24, p.minute || 0, p.second || 0);
  return (asIfUtc - utcMs) / 1000;
}

/** A wall-clock date + minutes-from-midnight IN `tz` → the UTC instant it names. Two passes: the
 *  offset near a DST step is not the offset at the first guess, and an hour's error there is the
 *  difference between an afternoon and a meeting nobody attends. */
function wallToTs(iso: string, min: number, tz: string): number {
  const [y, mo, d] = iso.split("-").map(Number);
  if (!y || !mo || !d) return 0;
  const guess = Date.UTC(y, mo - 1, d, 0, min);
  let ms = guess - zoneOffsetSec(guess, tz) * 1000;
  ms = guess - zoneOffsetSec(ms, tz) * 1000;
  return Math.round(ms / 1000);
}

/** Minutes from midnight → the clock face the reader's locale writes ("2:00 pm" or "14:00"). Built
 *  on a fixed UTC day so the number is shown as itself, in nobody's zone. */
function minuteClock(min: number): string {
  const m = Math.max(0, Math.min(1439, Math.round(min)));
  return fmt(Math.round(Date.UTC(1970, 0, 1, 0, m) / 1000), { hour: "2-digit", minute: "2-digit", ...HOUR_OPTS }, "UTC");
}

/** The 24-hour "HH:MM" an <input type="time"> speaks, and back. Never shown to a reader — that is
 *  minuteClock's job — but the control's value is a fixed grammar, not a locale. */
const minuteInput = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
function inputMinute(v: string): number {
  const [h, m] = v.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return -1;
  return Math.max(0, Math.min(1439, h * 60 + m));
}

function durationLabel(m: number): string {
  if (m < 60) return `${m} minutes`;
  if (m === 60) return "1 hour";
  const h = Math.round(m / 6) / 10;
  return `${h} hours`;
}

function noticeLabel(h: number): string {
  if (h < 24) return h === 1 ? "1 hour" : `${h} hours`;
  const d = Math.round(h / 24);
  return d === 1 ? "1 day" : `${d} days`;
}

function errText(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

/* ───────────────────────── glyphs ─────────────────────────
   Six line glyphs, drawn here. A dependency for six paths is still a dependency, and these have to
   inherit `currentColor` so ArtaContrast can mute them with the text beside them. */

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const CameraGlyph = ({ size = 16 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden className="mt-px shrink-0" {...STROKE}><rect x="3" y="6" width="12" height="12" rx="3" /><path d="m15 11.2 5-3.2v8l-5-3.2z" /></svg>
);
const PeopleGlyph = ({ size = 16 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden className="mt-px shrink-0" {...STROKE}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M16 6.2a3 3 0 0 1 0 5.6" /><path d="M17 14.6A5.4 5.4 0 0 1 20.5 19" /></svg>
);
const CalGlyph = ({ size = 16 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden className="mt-px shrink-0" {...STROKE}><rect x="3.5" y="5.5" width="17" height="15" rx="3" /><path d="M8 3.5v4M16 3.5v4M3.5 10.5h17" /></svg>
);
const GlobeGlyph = ({ size = 14 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden className="shrink-0" {...STROKE}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" /></svg>
);
const CheckGlyph = ({ size = 28 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden className="shrink-0 text-yang" {...STROKE}><circle cx="12" cy="12" r="9" /><path d="m8 12.4 2.6 2.6L16 9.6" /></svg>
);
const ChevronGlyph = ({ back }: { back?: boolean }) => (
  <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden {...STROKE}><path d={back ? "m14 6-6 6 6 6" : "m10 6 6 6-6 6"} /></svg>
);

/* ───────────────────────── what a rule says ───────────────────────── */

const isEveryDay = (days: string) => /^1{7}$/.test(days);

/** The mask in words. "Any day" and "Weekdays" are the two shapes people actually choose, so they
 *  are named rather than spelled out as seven abbreviations. */
/* The same three facts as ELEMENTS rather than strings.
   The string helpers above build sentences out of our own English nouns — "minutes", "hours",
   "day", "Weekdays" — and every place that SHOWS one wrapped the whole return value in
   data-ay-skip="1". That marker excludes the entire subtree from the mesh, so those words could
   never be translated: a French visitor read "Ouvert pour les 21 days" and an owner's rule card
   said "Weekdays" in every one of the ~133 languages. The rule is that the marker goes around the
   formatted VALUE and nothing else, so these hold the numeral (or the weekday names, which are
   formatted by Intl and are not ours to translate) inside the wrapper and leave the words outside.
   The string helpers stay: <Select> option labels are plain prose the mesh should translate whole,
   and an option cannot carry an element. */

/* Each returns ONE inline element, never a fragment. The space between the numeral and the word is
   its own text node, and a fragment drops it straight into whatever the parent is — inside a Pill or
   the meta list, both flex, a whitespace-only node is a flex ITEM and gets collapsed away, which
   rendered "1hour" in the pill and "1  hour" in the list. An inline wrapper keeps the pair as a
   single item and lets normal inline whitespace do its job. */

function DurationText({ m }: { m: number }) {
  const n = m < 60 ? m : m === 60 ? 1 : Math.round(m / 6) / 10;
  return (
    <span><span data-ay-skip="1">{n}</span> {m < 60 ? "minutes" : m === 60 ? "hour" : "hours"}</span>
  );
}

function NoticeText({ h }: { h: number }) {
  const days = h >= 24;
  const n = days ? Math.round(h / 24) : h;
  return (
    <span><span data-ay-skip="1">{n}</span> {days ? (n === 1 ? "day" : "days") : n === 1 ? "hour" : "hours"}</span>
  );
}

/** `lower` is for the middle of a sentence. It is a SEPARATE English string rather than
 *  `.toLowerCase()` on the translated one, because lowercasing a translation is a different
 *  operation in half the world's scripts and a wrong one in German. */
function DaysText({ days, lower }: { days: string; lower?: boolean }) {
  const mask = (days || "").padEnd(7, "0").slice(0, 7);
  if (isEveryDay(mask)) return <>{lower ? "any day" : "Any day"}</>;
  if (mask === "1111100") return <>{lower ? "weekdays" : "Weekdays"}</>;
  if (mask === "0000011") return <>{lower ? "weekends" : "Weekends"}</>;
  const on = MON_FIRST.filter((i) => mask[i] === "1").map((i) => WEEKDAY_NAMES[i]);
  // Weekday names come from Intl, so they are already in the reader's language — a formatted value,
  // and one the mesh must not touch.
  return on.length ? <span data-ay-skip="1">{on.join(", ")}</span> : <>{lower ? "no days" : "No days"}</>;
}

/** The rule's hours as the OWNER keeps them — the sentence the visitor is really agreeing to. */
const hoursLabel = (r: BookRule) => `${minuteClock(r.from_min)} – ${minuteClock(r.to_min)}`;

/** The same window as it falls where the READER is standing, computed on today's date in the
 *  owner's zone so the offset used is the one in force, not an average of the year. Returns '' when
 *  both zones are the same, because saying it twice is worse than not saying it. */
function localWindow(r: BookRule, tz: string): string {
  if (!r.tz || r.tz === tz) return "";
  const iso = dayKey(Math.round(Date.now() / 1000), r.tz);
  const a = wallToTs(iso, r.from_min, r.tz);
  const b = wallToTs(iso, r.to_min, r.tz);
  if (!a || !b) return "";
  return `${clockOnly(a, tz)} – ${clockOnly(b, tz)}`;
}

/* ───────────────────────── sign-in ─────────────────────────
   The visitor half is readable signed out, so the ONE place a session is needed carries the return
   trip with it: the slot they chose is in the URL before we leave, their note is in sessionStorage
   beside it, and the page picks both back up on the way in. Coming back to the top of a page you
   had already worked your way down is the quiet way to lose somebody.

   The NOTE is deliberately not a query parameter. A visitor's sentence about why they want to talk
   is theirs, and a URL leaks into referrers, server logs and browser history. */

function signInTo(path: string) {
  window.location.assign(`${localePath("/login/")}?redirect_to=${encodeURIComponent(path)}`);
}

const noteKey = (handle: string, t: number) => `book:${handle}:${t}`;

function stashNote(handle: string, t: number, note: string) {
  try {
    if (note.trim()) window.sessionStorage.setItem(noteKey(handle, t), note);
    else window.sessionStorage.removeItem(noteKey(handle, t));
  } catch { /* a browser that refuses session storage loses a sentence, never the booking */ }
}
function takeNote(handle: string, t: number): string {
  try { return window.sessionStorage.getItem(noteKey(handle, t)) || ""; } catch { return ""; }
}
function dropNote(handle: string, t: number) {
  try { window.sessionStorage.removeItem(noteKey(handle, t)); } catch { /* nothing to clean up */ }
}

/* ───────────────────────── the visitor ───────────────────────── */

type DayGroup = { key: string; starts: number[] };

/** The one place the grid's geometry is written down. Both the real grid and the skeleton use these,
 *  so a loading month and a loaded month cannot measure differently:
 *    1440px → 6 × 64 + 5 × 8 = 424px      393px → 6 × 52 + 5 × 4 = 332px
 *  Cells are 83 × 64 on desktop and 43.6 × 52 on a phone — both well over the 40px floor. */
const GRID_ROWS = "grid grid-cols-7 gap-1 md:gap-2";
const CELL_H = "h-[52px] md:h-16";

/** A text link is still a TARGET. Every quiet LinkButton on this page — "Not your zone?", "Choose
 *  another time", "See September" — is a real step in the flow, and a 13px line of text is an 18px
 *  box. These two classes carry the 40px floor to the controls that are text rather than buttons,
 *  and are written once so an audit can measure the page rather than argue about it.
 *  Segmented's own segments are h-8 in the shared component; this page needs them thumb-sized. */
const LINK_HIT = "inline-flex min-h-[40px] items-center";
const SEG_HIT = "[&>button]:h-10";

function WeekdayStrip() {
  return (
    // The row carries the skip, not the leaves: these are formatted names, and the mesh would
    // otherwise persist seven abbreviations into the public translations table.
    <div data-ay-skip="1" aria-hidden className={cx(GRID_ROWS, "mt-3 text-[11px] uppercase tracking-[0.14em] text-ink-3")}>
      {MON_FIRST.map((i) => <span key={i} className="text-center">{WEEKDAY_NAMES[i]}</span>)}
    </div>
  );
}

/** The six-row skeleton — the FINAL geometry, so nothing moves when the data lands. */
function GridSkeleton() {
  return (
    <div aria-hidden className={cx(GRID_ROWS, "mt-2")}>
      {Array.from({ length: 42 }, (_, i) => (
        <div key={i} className={cx(CELL_H, "animate-pulse rounded-card bg-veil/5")} />
      ))}
    </div>
  );
}

function DayGrid({ month, dayMap, todayKey, horizonKey, selected, onChoose, onMonth }: {
  month: string;
  dayMap: Map<string, number[]>;
  todayKey: string;
  horizonKey: string;
  selected: string;
  onChoose: (key: string) => void;
  onMonth: (m: string) => void;
}) {
  const cells = useMemo(() => monthCells(month), [month]);

  /** The first square anybody can actually press. `cells.find(Boolean)` is the 1st of the month,
   *  which on a mid-month visit is in the past — and once the dead weeks stop being drawn (below)
   *  it is not on the page at all, so a roving stop pointing at it leaves Tab focusing nothing. */
  const firstStop = useMemo(
    () => cells.find((k) => k && k >= todayKey && k <= horizonKey) || cells.find(Boolean) || "",
    [cells, todayKey, horizonKey],
  );

  /** Six weeks are drawn for a month; far fewer can be booked. With a seven-day horizon that is ONE
   *  live week and five empty ones — ~230px of nothing on a phone, sitting between the day you tap
   *  and the times you came for. Only weeks wholly BEFORE today or wholly PAST the horizon are
   *  dropped, both of which are unreachable by pointer and by keyboard (`move` clamps to the same
   *  two bounds), so this hides no bookable day. Blanks inside a kept row still hold their cell. */
  const rows = useMemo(() => {
    const all = [0, 1, 2, 3, 4, 5];
    const live = (r: number) =>
      cells.slice(r * 7, r * 7 + 7).some((k) => k && k >= todayKey && k <= horizonKey);
    const first = all.findIndex(live);
    if (first < 0) return all; // the whole month is outside the range — draw it as it is
    return all.slice(first, all.length - [...all].reverse().findIndex(live));
  }, [cells, todayKey, horizonKey]);

  const [focusKey, setFocusKey] = useState(selected || firstStop);
  // Focus is moved ONLY when the keyboard asked for it. A grid that focuses itself on every re-render
  // steals the caret from whatever the member was actually typing in.
  const want = useRef("");
  const boxes = useRef<Record<string, HTMLElement | null>>({});

  // The roving stop follows the month and the selection; the keyboard then moves it independently,
  // which is why it is state rather than a derivation.
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

  // The busiest day in THIS month is the density bar's full mark, so the bars compare days a visitor
  // is actually looking at rather than against a horizon they cannot see.
  const busiest = useMemo(() => {
    let n = 0;
    for (const key of cells) if (key) n = Math.max(n, dayMap.get(key)?.length || 0);
    return n;
  }, [cells, dayMap]);

  function move(to: string) {
    if (!to) return;
    // Clamped by the RULE — today at one end, the horizon at the other — so the keyboard can never
    // walk into a month that cannot be booked.
    const next = to < todayKey ? todayKey : to > horizonKey ? horizonKey : to;
    want.current = next;
    if (monthOf(next) !== month) onMonth(monthOf(next));
    setFocusKey(next);
  }

  /** The whole keyboard contract of a month grid, as a lookup: a day, a week, the ends of the week,
   *  a month. Anything else belongs to the page — Tab must still leave, and Escape must still reach
   *  the handler that gives a picked time back. */
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
        // `contents` keeps one CSS grid for the geometry while giving assistive tech real rows.
        <div key={row} role="row" className="contents">
          {cells.slice(row * 7, row * 7 + 7).map((key, i) => {
            // A blank still occupies a CELL. Without the height the sixth row of a five-row month
            // collapses to nothing and the block measures 360px instead of 424 — which moves every
            // time below it as the visitor pages between months. Measured, not assumed.
            if (!key) return <div key={`b${row}-${i}`} aria-hidden="true" className={CELL_H} />;
            const free = dayMap.get(key)?.length || 0;
            const on = key === selected;
            const isToday = key === todayKey;
            const roving = key === focusKey ? 0 : -1;
            const setRef = (el: HTMLElement | null) => { boxes.current[key] = el; };
            if (!free) {
              // NOT decorated. Only availability gets a border, a fill or a bar, so the eye lands on
              // what can be done rather than on what cannot — no grey-out, no strike-through.
              return (
                <div key={key} role="gridcell" aria-disabled="true" tabIndex={roving} ref={setRef}
                  {...(isToday ? { "aria-current": "date" as const } : {})}
                  style={{ position: "relative" }}
                  className={cx("grid place-items-center text-[15px] font-normal tabular-nums text-ink-3 outline-none md:text-[17px]",
                    CELL_H)}>
                  {isToday && <span aria-hidden className="pointer-events-none absolute h-9 w-9 rounded-full ring-1 ring-inset ring-yin-light/60 md:h-11 md:w-11" />}
                  {/* The numeral is the DECORATION and the sr-only line is the NAME: a reader who
                      cannot see which column a square is in gets the weekday, not a bare "17". The
                      formatted date is skip-wrapped, the words beside it are not. */}
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
                {/* A CIRCLE, not a bordered box. Every free day used to be a rounded rectangle with a
                    border and a small bar chart inside it, and twenty of those in a grid read as a
                    wall of controls rather than as a month — the page looked busy while saying very
                    little. A tinted disc says "this day is open" with no border at all, the gold fill
                    says "this is the one you chose", and the density that bar carried survives as the
                    dot below: same information, a fraction of the ink. */}
                <span aria-hidden
                  className={cx("relative grid h-9 w-9 place-items-center rounded-full text-[15px] font-semibold tabular-nums transition-colors duration-150 md:h-11 md:w-11 md:text-[17px]",
                    on ? "bg-yang text-on-accent shadow-card"
                       : "bg-yang/[0.10] text-ink group-hover:bg-yang/25 group-focus-visible:bg-yang/25",
                    // Blue marks where you STAND, gold marks what you CHOSE. The two brand colours
                    // never do the same job, and no third mark is invented for "today".
                    isToday && !on && "ring-1 ring-inset ring-yin-light/60")}>
                  <span data-ay-skip="1">{Number(key.slice(8, 10))}</span>
                </span>
                <span aria-hidden
                  className={cx("mt-1 h-1 w-1 rounded-full transition-opacity", on ? "bg-yang" : "bg-yang")}
                  style={{ opacity: on ? 0 : 0.25 + (pct / 100) * 0.6 }} />
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

/** The type chooser. One offer is a heading; several are a vertical radiogroup of full rows — never
 *  a row of gold pills, which fought the day cells for the same colour and the same meaning. */
function TypeChooser({ offered, current, onPick }: { offered: BookRule[]; current: BookRule | null; onPick: (slug: string) => void }) {
  if (offered.length < 2) return null;
  return (
    <div role="radiogroup" aria-label="What kind of meeting" className="flex flex-col gap-2">
      {offered.map((t) => {
        const on = current?.slug === t.slug;
        return (
          <button key={t.slug} type="button" role="radio" aria-checked={on} onClick={() => onPick(t.slug)}
            className={cx("flex min-h-[56px] w-full items-center justify-between gap-3 rounded-field border p-3 text-start transition-colors duration-150",
              on ? "border-yang bg-yang/12" : "border-line hover:border-yin-light")}>
            <span className="min-w-0 text-[14px] font-semibold text-ink" data-ay-skip="1">{t.title}</span>
            <span className="shrink-0 text-[12.5px] text-ink-3"><DurationText m={Number(t.minutes) || 30} /></span>
          </button>
        );
      })}
    </div>
  );
}

/** What the meeting actually IS — the five facts a stranger needs and today's page never told them.
 *  `seats` in particular is filled in by every owner and has never been shown to a visitor. */
function MetaList({ type, className }: { type: BookRule; className?: string }) {
  const seats = Number(type.seats) || 2;
  const notice = Number(type.notice_h) || 0;
  const horizon = Number(type.horizon_d) || 21;
  /* Five lines became three. The duration was the first of them AND the pill beside the title at
     both call sites — the same fact twice, three words apart. And the notice and the horizon are
     not two facts: they are the two ends of one window, so they are stated as one. */
  return (
    <ul className={cx("flex flex-col gap-2 text-[13px] text-ink-2", className)}>
      <li className="flex items-start gap-2.5"><span className="text-ink-3"><CameraGlyph /></span>
        <span>Encrypted video call on ArtaMeet</span></li>
      <li className="flex items-start gap-2.5"><span className="text-ink-3"><PeopleGlyph /></span>
        <span>{seats <= 2 ? "Just the two of you" : <>Up to <span data-ay-skip="1">{seats}</span> people</>}</span></li>
      <li className="flex items-start gap-2.5"><span className="text-ink-3"><CalGlyph /></span>
        <span>{notice > 0
          ? <>Book <NoticeText h={notice} /> to <span data-ay-skip="1">{horizon}</span> days ahead</>
          : <>Open for the next <span data-ay-skip="1">{horizon}</span> days</>}</span></li>
    </ul>
  );
}

function VisitorPage({ handle }: { handle: string }) {
  // Read ONCE, at mount: after a sign-in trip this is a fresh page load, and these are the crumbs
  // that trip left behind — the slot in the address bar, the note beside it in session storage.
  const [entry] = useState(() => {
    const sp = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
    const t = Number(sp.get("t")) || 0;
    return { type: sp.get("type") || "", t, note: t ? takeNote(handle, t) : "" };
  });

  const [owner, setOwner] = useState<BookOwner | null>(null);
  const [types, setTypes] = useState<BookRule[] | null>(null);
  const [pageErr, setPageErr] = useState("");
  const [typeSlug, setTypeSlug] = useState(entry.type);
  const [displayTz, setDisplayTz] = useState(VIEWER_TZ);
  const [zonePicker, setZonePicker] = useState(false);
  const [starts, setStarts] = useState<number[] | null>(null);
  // Instants this page HAD on screen that a re-read no longer offers. Held separately from `starts`
  // because they are no longer free and must not colour a density bar or count towards a day.
  const [vanished, setVanished] = useState<number[]>([]);
  const [slotsFailed, setSlotsFailed] = useState(false);
  // The furthest instant the server actually ANSWERED for, which is its own clamp (SPAN_MAX_S = 62
  // days) and can be nearer than the horizon the rule advertises. The month grid is bounded by this
  // rather than by the rule, so it cannot page into a month nobody was asked about and then report
  // that month as empty. 0 until the first answer lands.
  const [answered, setAnswered] = useState(0);
  const [month, setMonth] = useState(() => monthOf(dayKey(Math.round(Date.now() / 1000), VIEWER_TZ)));
  const [day, setDay] = useState("");
  const [picked, setPicked] = useState(0);
  const [note, setNote] = useState(entry.note);
  const [noteOpen, setNoteOpen] = useState(!!entry.note);
  const [busy, setBusy] = useState(false);
  const [takeErr, setTakeErr] = useState("");
  const [gone, setGone] = useState(false);
  const [booked, setBooked] = useState<{ id: number; start: number; note: string } | null>(null);
  // Read once and ticked, never called during a render: "today" has to stop meaning today when
  // midnight passes under an open page, and a clock read mid-render is a different answer every
  // time React happens to re-run the component. It also drives both live zone clocks.
  const [now, setNow] = useState(() => Math.round(Date.now() / 1000));
  const seq = useRef(0);
  const restored = useRef(false);
  // What the times region is showing right now, so a re-read can diff against it. A ref rather than
  // state: it is read inside the fetch callback and must never itself cause a render.
  const shownRef = useRef<number[]>([]);
  const confirmBtn = useRef<HTMLButtonElement | null>(null);
  const timesHead = useRef<HTMLHeadingElement | null>(null);
  const timesBox = useRef<HTMLDivElement | null>(null);
  const noteBox = useRef<HTMLTextAreaElement | null>(null);
  const doneHead = useRef<HTMLHeadingElement | null>(null);
  // The first selection is a PRESELECTION, and the restore trip owns its own focus — neither should
  // yank the caret to the times heading.
  const skipFocus = useRef(true);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Math.round(Date.now() / 1000)), 60000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    let stop = false;
    bookPage(handle)
      .then((p) => {
        if (stop) return;
        setOwner(p.owner);
        setTypes(p.types || []);
      })
      .catch((e) => {
        if (!stop) setPageErr(errText(e, "That booking page couldn’t be loaded."));
      });
    return () => { stop = true; };
  }, [handle]);

  const offered = useMemo(() => (types || []).filter((t) => Number(t.active) !== 0), [types]);
  const type = useMemo(() => offered.find((t) => t.slug === typeSlug) || offered[0] || null, [offered, typeSlug]);

  /**
   * Read the whole horizon.
   *
   * `quiet` is the difference between a FIRST read and a RE-read. A first read has nothing to
   * protect, so it blanks to the skeleton. A re-read happens because a take was just refused —
   * almost always because somebody else got there first — and blanking then would sweep the whole
   * day away and drop the visitor back at a fresh grid holding the news that something went wrong
   * but not which thing. A quiet read leaves the times exactly where they are and lets the diff
   * below mark the one that has gone.
   */
  const loadSlots = useCallback((quiet = false) => {
    if (!type) return;
    const mine = ++seq.current;
    const from = Math.round(Date.now() / 1000);
    // Ask for the rule's own horizon and let the server clamp it. The window is computed here, once
    // per load, rather than from a ticking clock — a tick must never re-fetch the grid out from
    // under a hand that is already reaching for it.
    const to = from + Math.max(1, Math.min(90, Number(type.horizon_d) || 21)) * 86400;
    if (!quiet) { setStarts(null); setVanished([]); setAnswered(0); }
    setSlotsFailed(false);

    /* Follow the cursor to the end of the window.
       `Booking::slots` walks the offered grid only as far as MAX_SLOTS (400) instants — counted
       BEFORE the busy filter — and returns `next` for the remainder. One request is therefore not
       the horizon, and treating it as one does not merely shorten the page: the days past the cap
       arrive indistinguishable from days with nothing free, so the grid draws them as inert cells
       reading "nothing free" and the month overlay states it outright, over time the server will
       happily book. Measured against a real rule — 15-minute slots, any day, 09:00–17:00, 30 days —
       one call answered 396 starts ending 25 Aug for a horizon running to 11 Sept.
       PAGE_MAX bounds the walk: 12 pages is ~4,800 offered instants, past any rule this form can
       express, so a server that kept returning a cursor could never spin this loop. */
    const PAGE_MAX = 12;
    const all: number[] = [];
    const walk = (cursor: number, page: number): Promise<number> =>
      bookSlots({ user: handle, type: type.slug, from: cursor, to }).then((r) => {
        if (mine !== seq.current) return 0;
        all.push(...r.starts);
        // `to` is the window the server ANSWERED, which is its own clamp (SPAN_MAX_S = 62 days) and
        // may be nearer than the horizon the rule advertises. The grid is bounded by this, not by
        // the rule, so it never opens a month nothing was asked about.
        const reached = r.to;
        return r.next && r.next > cursor && page + 1 < PAGE_MAX
          ? walk(r.next, page + 1)
          : reached;
      });

    walk(from, 0)
      .then((reached) => {
        if (mine !== seq.current) return;
        const fresh = all.slice().sort((a, b) => a - b);
        // Anything the visitor could see a moment ago and the server no longer offers. It stays on
        // screen, disabled and labelled, rather than disappearing from under a cursor that was
        // already travelling towards it — the list must never renumber itself mid-reach.
        if (quiet) {
          const now = new Set(fresh);
          setVanished(shownRef.current.filter((ts) => !now.has(ts)));
        }
        setStarts(fresh);
        setAnswered(reached);
      })
      // A FAILED request is not an empty diary. Falling through to "no free times" would tell a
      // visitor this person is booked solid on exactly the request that never came back. A QUIET
      // read is a re-read that already has a good grid on screen, so a failure there must leave it
      // alone — blanking is precisely what `quiet` exists to prevent, and doing it here stranded a
      // visitor holding a chosen time with no diary around it.
      .catch(() => {
        if (mine !== seq.current || quiet) return;
        setStarts(null);
        setSlotsFailed(true);
      });
  }, [handle, type]);

  useEffect(() => { loadSlots(); }, [loadSlots]);

  const groups = useMemo<DayGroup[]>(() => {
    const out: DayGroup[] = [];
    for (const ts of starts || []) {
      const key = dayKey(ts, displayTz);
      const last = out[out.length - 1];
      if (last && last.key === key) { last.starts.push(ts); continue; }
      out.push({ key, starts: [ts] });
    }
    return out;
  }, [starts, displayTz]);

  const dayMap = useMemo(() => new Map(groups.map((g) => [g.key, g.starts])), [groups]);
  const monthsWithSlots = useMemo(() => new Set(groups.map((g) => monthOf(g.key))), [groups]);

  /**
   * How much room the times below the calendar hold OPEN — the phone reserve only; beside the
   * calendar (`md:`) the column has its own height and needs none.
   *
   * It was a flat 236px, which is the right idea and the wrong number: the block must not collapse
   * and shove the page around as you move between days, but 236px was chosen for a rule offering a
   * dozen times, and the live rule offers five. Measured on the page: 104px of reserved nothing
   * under the last time, on a 612px card.
   *
   * So reserve what the BUSIEST day actually needs, over every day in the horizon — not the day
   * showing, or the reserve would itself be the thing that jumps. Constants are measured off the
   * rendered page, not derived from the classes: chip 48px, row gap 8px, three columns, and 45px
   * of rule, padding and heading above the first chip. A day with more times than the busiest
   * simply grows past it; `min-height` reserves, it does not cap.
   */
  const timesFloor = useMemo(() => {
    let most = 0;
    for (const g of groups) most = Math.max(most, g.starts.length);
    const rows = Math.max(1, Math.ceil(most / 3));
    return 45 + rows * 48 + (rows - 1) * 8;
  }, [groups]);

  // Pick the slot the sign-in trip was for, once, as soon as there is a grid to find it in.
  useEffect(() => {
    if (restored.current || !entry.t || !starts) return;
    restored.current = true;
    skipFocus.current = true;
    const key = dayKey(entry.t, displayTz);
    setDay(key);
    if (starts.includes(entry.t)) {
      setPicked(entry.t);
      // Focus rather than scroll: focus takes the keyboard there as well as the eye, and a member
      // who signed in with a keyboard is exactly who this matters to. One press finishes.
      window.requestAnimationFrame(() => confirmBtn.current?.focus());
    } else {
      // The slot died while they were signing in. Keep the same DAY selected so its neighbours are
      // already on screen, and never pick one on their behalf.
      setGone(true);
    }
  }, [entry.t, starts, displayTz]);

  // Keep the chosen slot in the address bar. It is what makes a sign-in trip — or a reload, or a
  // link sent to a colleague — come back to the same time rather than to the top of the page.
  useEffect(() => {
    if (typeof window === "undefined" || !type) return;
    const sp = new URLSearchParams(window.location.search);
    sp.set("type", type.slug);
    if (picked) sp.set("t", String(picked)); else sp.delete("t");
    window.history.replaceState(null, "", `${window.location.pathname}?${sp.toString()}`);
  }, [type, picked]);

  const todayKey = dayKey(now, displayTz);
  const horizonD = Math.max(1, Math.min(90, Number(type?.horizon_d) || 21));
  // What the RULE advertises, and what the SERVER answered, are two different dates: `Booking::slots`
  // clamps its own window to SPAN_MAX_S (62 days), so a 90-day rule is answered for 62. The grid is
  // bounded by the nearer of the two, because a month the server was never asked about must not be
  // reachable — paging into one and being told "nothing free" is a lie about a diary nobody read.
  // Before the first answer lands `answered` is 0 and the rule's own horizon stands.
  const ruleHorizonKey = dayKey(now + horizonD * 86400, displayTz);
  const horizonKey = answered > 0 ? minKey(ruleHorizonKey, dayKey(answered, displayTz)) : ruleHorizonKey;
  // The instant is the truth; the day is derived from it. That is what lets a zone switch move a
  // pick onto a neighbouring date without losing it. With nothing chosen the nearest open day is
  // already selected — we hold the whole horizon, so a mandatory first click would be theatre.
  const activeKey = (picked ? dayKey(picked, displayTz) : day) || groups[0]?.key || "";
  const active = dayMap.get(activeKey) || null;

  /** The times actually rendered for the chosen day: what is free, plus anything that has GONE since
   *  this visitor last looked, folded back in at its own place in the day. The set of free instants
   *  is what decides which of the two a button is. */
  const freeSet = useMemo(() => new Set(starts || []), [starts]);
  const dayTimes = useMemo(() => {
    if (!activeKey) return [];
    const dead = vanished.filter((ts) => dayKey(ts, displayTz) === activeKey && !freeSet.has(ts));
    return dead.length ? [...(active || []), ...dead].sort((a, b) => a - b) : (active || []);
  }, [active, vanished, activeKey, displayTz, freeSet]);

  // The diff a quiet re-read runs is against what was ON SCREEN, so record that and nothing wider.
  useEffect(() => { shownRef.current = dayTimes.filter((ts) => freeSet.has(ts)); }, [dayTimes, freeSet]);

  // The browsed month always contains the chosen day — including after a zone switch has moved that
  // instant onto a neighbouring date, and after the sign-in trip restored one.
  useEffect(() => { if (activeKey) setMonth(monthOf(activeKey)); }, [activeKey]);

  // Keyed on the DAY, never fired from a one-shot ref: a scroll that works exactly once and then
  // silently stops is the single most-reported bug in every other booking page.
  useEffect(() => {
    if (!activeKey) return;
    if (skipFocus.current) { skipFocus.current = false; return; }
    const h = timesHead.current;
    if (!h) return;
    h.focus({ preventScroll: true });
    const still = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Scroll the times REGION, not the heading. `nearest` on the heading alone satisfies itself the
    // moment its top edge clears the fold — measured on a 393×852 phone that leaves the heading on
    // the last 16px of the screen with every time button still below it, which is a scroll that
    // technically ran and showed the visitor nothing.
    (timesBox.current || h).scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [activeKey]);

  // Escape gives the time back. A picked slot is a commitment on screen, and there has to be a way
  // out of it that is not "find the small grey link".
  useEffect(() => {
    if (!picked) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { setPicked(0); setTakeErr(""); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picked]);

  function chooseDay(key: string) {
    setDay(key);
    setTakeErr("");
    setGone(false);
    // "Taken" is news about the day you were looking at, not a permanent label. Moving on clears it.
    if (vanished.length) setVanished([]);
    // Their pick lives on another day; keeping it selected while its times are off screen is how a
    // person ends up confirming a slot they can no longer see.
    if (picked && dayKey(picked, displayTz) !== key) setPicked(0);
  }

  function openNote() {
    setNoteOpen(true);
    // NEVER on a coarse pointer: raising the keyboard over the bar a visitor has just tapped hides
    // the very button they were reaching for.
    const coarse = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
    if (!coarse) window.requestAnimationFrame(() => noteBox.current?.focus());
  }

  async function take() {
    if (!picked || !type) return;
    const back = `${window.location.pathname}?type=${encodeURIComponent(type.slug)}&t=${picked}`;
    if (!isLoggedIn()) { stashNote(handle, picked, note); signInTo(back); return; }
    setBusy(true);
    setTakeErr("");
    try {
      const r = await bookTake({ user: handle, type: type.slug, start: picked, note });
      dropNote(handle, picked);
      setBooked({ id: Number(r.meet?.id || r.id || 0), start: picked, note });
      setPicked(0);
      setNote("");
    } catch (e) {
      // The commonest refusal by far is that somebody took it while this page was open, so the
      // window is re-read as part of the failure rather than left showing a slot that has gone.
      setTakeErr(errText(e, "That time couldn’t be taken — it may have just gone. Here is what is still free."));
      // QUIET: the day stays exactly where it is and the slot that went is marked in place, rather
      // than the whole grid blanking to a skeleton and coming back one button shorter.
      loadSlots(true);
      // And let the dead instant GO. The re-read above marks it "Taken" in the grid, but the confirm
      // surface renders on `picked` alone — so leaving it set kept a primary action pointed at a
      // slot the same render had just declared gone, and every further press re-posted it for the
      // same refusal. On a phone that action is the fixed bar over the thumb. The error stays; the
      // pick does not. The day is untouched, so the times they were looking at are still there.
      setPicked(0);
    } finally {
      setBusy(false);
    }
  }

  // Focus the confirmation, not the top of the page: the one thing that changed is what should be
  // read out.
  useEffect(() => { if (booked) window.requestAnimationFrame(() => doneHead.current?.focus()); }, [booked]);

  if (pageErr) {
    return (
      <div className="mx-auto flex w-full max-w-[1076px] flex-col gap-6 pb-12">
        <PageHero eyebrow="Time with" title="Nothing to book here" />
        {/* The SAME correction as the "isn't taking bookings" state below, and this branch needs it
            more: it is what a stranger sees when a shared booking link is mistyped or its owner has
            gone, which is the likeliest way somebody arrives here at all. "Meet" sent them to a page
            that only asks them to sign in. There is no member to point at from here — the handle did
            not resolve — so the honest door is the front of the site. */}
        <EmptyState title="This page isn’t open" body={pageErr}
          action={isLoggedIn()
            ? <Button href={localePath("/meet/")}>Meet</Button>
            : <Button href={localePath("/works")} variant="outline">Look around ArtaQuest</Button>} />
      </div>
    );
  }

  const ownerName = owner?.name || "";
  const ownerTz = owner?.tz || "";
  const bothZones = !!ownerTz && ownerTz !== displayTz;
  const me = currentUser();


  /* THE CLOCK, STATED WHERE THE TIME IS CHOSEN.
     Booking 2pm in the wrong zone is the one mistake this page can make that costs somebody a real
     hour of their day, and the zone was a caption: a quiet rail card on a desktop and a small strip
     at the top of a phone, both far from the row of times a visitor is actually reading. It sits
     directly above the times now, centred, in reading weight rather than the muted tier, and it says
     WHOSE clock it is — "your own" is the reassurance, "Arash's" is the warning. The offset is there
     for anyone who thinks in offsets; the running clock is there because a person verifies a zone by
     recognising the time in it, not by decoding GMT+3. */
  const zoneBanner = (
    <div data-zone-banner className="mb-3 rounded-card border border-yang/30 bg-yang/[0.07] px-3 py-2 text-center">
      <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[13.5px] font-semibold text-ink">
        <span className="text-yang"><GlobeGlyph /></span>
        <span>Times shown in</span>
        <span data-ay-skip="1">{displayTz}</span>
        <span className="font-normal text-ink-2" data-ay-skip="1">({zoneName(now, displayTz)} · {clockOnly(now, displayTz)} now)</span>
      </p>
      <p className="mt-0.5 text-[12.5px] text-ink-2">
        {displayTz === VIEWER_TZ
          ? "That is your own zone"
          : <>That is <span data-ay-skip="1">{ownerName}</span>’s zone, not yours</>}
        {bothZones && (
          <>
            {" · "}
            <span data-ay-skip="1">{ownerName}</span> is on{" "}
            <span data-ay-skip="1">{clockOnly(now, ownerTz)}</span>
          </>
        )}
      </p>
      <div className="mt-2 flex flex-col items-center gap-1">
        {bothZones && (
          <Segmented className={SEG_HIT} label="Show times in"
            value={displayTz === ownerTz ? "them" : "you"}
            onChange={(v) => setDisplayTz(v === "them" ? ownerTz : VIEWER_TZ)}
            options={[{ value: "you", label: "Yours" }, { value: "them", label: "Theirs" }]} />
        )}
        {zonePicker ? (
          <Select className="h-11 w-full max-w-[320px]" label="Show times in this zone"
            value={displayTz} onChange={setDisplayTz} options={ZONES} skipOptions />
        ) : (
          <LinkButton className={cx("text-[12.5px]", LINK_HIT)} onClick={() => setZonePicker(true)}>
            Show a different zone
          </LinkButton>
        )}
      </div>
    </div>
  );

  /* ── the confirm surface: ONE instance, two positions ──
     A second copy would fork the note and the button ref. On a phone it becomes a fixed bar once a
     time is chosen (parked above AppShell's own bottom quick-nav, whose height lives in
     --aq-bottom-bar); at rest it stays in flow so a permanent bar is not sitting on the times. */
  const signedIn = isLoggedIn();
  /* NOTHING until there is something to confirm. At rest this card carried a heading naming itself
     and a line — "Pick a day, then a time" — instructing the visitor to do the thing the calendar
     beside it is already asking for. A card whose whole content is a restatement of the page is a
     card to delete, so it now exists only once a time is held. */
  const confirmSurface = picked > 0 && type ? (
    <section
      aria-label="The time you pick"
      className={cx(
        "rounded-card border border-line bg-space-2 p-4 md:sticky md:top-[76px] md:bg-space-2 md:p-4 md:backdrop-blur-none",
        // `fixed` is unprefixed and `md:sticky` lives in a media query, so the media rule is emitted
        // later and wins from md up: one element, a bar on a phone and the rail card on a desktop.
        // `md:order-first` is what makes the desktop visibility STRUCTURAL rather than lucky. Sitting
        // fourth in the rail, this card's top depends on the three above it, so a member with a
        // longer title, a blurb or several types pushes the confirm button back below the fold —
        // collapsing the note only bought 66px. First in the rail, `sticky top-[76px]` pins it for
        // the whole scroll range, so the action is on screen at any rail height and any window.
        "fixed inset-x-0 bottom-[var(--aq-bottom-bar)] z-30 rounded-none border-x-0 border-b-0 border-t border-line bg-space-2/95 p-3 backdrop-blur md:inset-x-auto md:bottom-auto md:order-first md:rounded-card md:border md:p-4",
      )}>
      {/* The heading is the rail card's title and stays on a wide screen. On a phone the same
          element has become a one-line bar above the thumb, where a title is a wasted row — so it
          is hidden by CLASS, not by the `hidden` attribute, whose UA rule a `md:block` would
          silently outrank. */}
      <h2 className="hidden text-[14px] font-semibold text-ink md:block">The time you pick</h2>
      <>
          <p className="text-[14px] font-semibold text-ink md:text-[15px]" data-ay-skip="1">
            {longInstant(picked, displayTz)}
          </p>
          {bothZones && (
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
              which is <span data-ay-skip="1">{clockOnly(picked, ownerTz)}</span> for{" "}
              <span data-ay-skip="1">{ownerName}</span> in <span data-ay-skip="1">{ownerTz}</span>
            </p>
          )}

          {/* The note is one tap away at EVERY width, not just on a phone. Held open on a wide
              screen it added ~110px above the button, which put the one action this page exists for
              at y=943 in a 1440x900 viewport — measured, not guessed. The optional sentence is worth
              a click; the confirm button being below the fold is not. A note carried back from
              signing in re-opens itself (`useState(!!entry.note)`), so nothing is ever hidden. */}
          <div className={cx("mt-3", noteOpen ? "block" : "hidden")}>
            <Field label="What would you like to talk about?" optional
                hint="They’ll see this before the call. Unlike the call itself, this note isn’t encrypted — we can read it, so keep anything private for the conversation">
              <Textarea ref={noteBox} rows={3} value={note} maxLength={500}
                onChange={(e) => setNote(e.target.value)}
                placeholder="A sentence is plenty" />
            </Field>
          </div>
          {!noteOpen && <div className="mt-2"><LinkButton className={LINK_HIT} onClick={openNote}>Add a line about it</LinkButton></div>}


          <div className="mt-3 flex items-center gap-3">
            {/* A plain element rather than <Button>: this is the one control the page has to be able
                to FOCUS on the way back from signing in, and Button owns its own ref. */}
            <button ref={confirmBtn} type="button" onClick={() => void take()} disabled={busy}
              className="inline-flex h-11 flex-1 items-center justify-center rounded-pill bg-yang px-6 text-[14px] font-bold text-on-accent shadow-card transition-colors duration-150 hover:bg-yin hover:text-white disabled:cursor-not-allowed disabled:opacity-50 md:flex-none">
              {busy ? "Asking…" : signedIn ? "Book this time" : "Sign in and book this time"}
            </button>
            <LinkButton className={LINK_HIT} onClick={() => { setPicked(0); setTakeErr(""); }}>Choose another time</LinkButton>
          </div>

          {/* WHO is booking stays — it is the other half of "an account is needed", and it is one
              line. The signed-out twin ("New here? The same step creates your free account…") is
              gone: on a phone this surface is a FIXED BAR, so every line in it is permanent
              furniture standing over the calendar, and that one said what the button says. */}
          {signedIn && (
            <p className="mt-2 flex items-center gap-2 text-[12.5px] text-ink-3">
              <Avatar src={me?.avatar} name={me?.name} className="h-5 w-5 text-[10px]" />
              <span>Booking as <span data-ay-skip="1">{me?.name || "you"}</span></span>
            </p>
          )}
        </>
    </section>
  ) : null;

  /* ── the frame ──
     The house row: a 1076px band, a 672px main column, a 330px rail. Identical to Meet and Messages,
     which is the whole reason this page stops looking like a stranger's page. */
  const frame = (hero: ReactNode, main: ReactNode, rail: ReactNode) => (
    <div className={cx("flex flex-col gap-5 pb-12", picked > 0 && "pb-44 md:pb-12")}>
      <div className="mx-auto w-full max-w-[1076px]">{hero}</div>
      <div className="mx-auto flex w-full max-w-[1076px] flex-col gap-4 md:flex-row md:items-start lg:gap-7">
        <main className="flex w-full min-w-0 flex-col gap-4 md:max-w-2xl md:flex-1">{main}</main>
        <aside className="flex w-full flex-col gap-3 md:order-2 md:w-[300px] md:shrink-0 lg:w-[330px]"
          aria-label="Who you’d be meeting, and in whose clock">
          {/* Search heads the right column on every page (operator 2026-08-16). */}
          <div className="max-md:hidden"><RailSearch /></div>
          {rail}
        </aside>
      </div>
    </div>
  );

  // PHASE 1 — nothing known yet. An <h1> from the FIRST frame: the shell focuses the page heading on
  // every route change, and a loading screen with no heading breaks that for everyone using it.
  if (!owner || types === null) {
    return frame(
      <PageHero eyebrow="Time with" title="Booking a time" lede="Fetching what this member is offering, and when they’re free" />,
      <section role="status" aria-label="Loading this booking page" className="rounded-card border border-line bg-space-2 p-4 md:p-5">
        <div className="flex h-10 items-center justify-between">
          <span className="h-5 w-36 animate-pulse rounded bg-veil/10" />
          <span className="flex gap-2"><span className="h-10 w-10 animate-pulse rounded-card bg-veil/5" /><span className="h-10 w-10 animate-pulse rounded-card bg-veil/5" /></span>
        </div>
        <WeekdayStrip />
        <GridSkeleton />
        <div className="mt-4 min-h-[236px] border-t border-line pt-4 md:min-h-[156px]">
          <p className="text-[13px] text-ink-3">Loading this booking page…</p>
        </div>
      </section>,
      <SkeletonCard media={false} />,
    );
  }

  const viewerIsOwner = !!owner.slug && me?.slug === owner.slug;

  if (booked) {
    return frame(
      <PageHero eyebrow="Time with" title="That’s arranged"
        lede={<>It’s an ordinary meeting now — it’s in your calendar, and in <span data-ay-skip="1">{owner.name}</span>’s</>} />,
      <section role="status" className="rounded-card border border-line bg-space-2 p-5">
        <CheckGlyph />
        <h2 ref={doneHead} tabIndex={-1} className="mt-3 text-[18px] font-bold text-ink outline-none">Booked</h2>
        <p className="mt-2 text-[15px] font-semibold text-ink" data-ay-skip="1">
          {longInstant(booked.start, displayTz)}
        </p>
        {!!ownerTz && ownerTz !== displayTz && (
          <p className="mt-1 text-[13px] text-ink-3">
            <span data-ay-skip="1">{clockOnly(booked.start, ownerTz)}</span> for{" "}
            <span data-ay-skip="1">{owner.name}</span> in <span data-ay-skip="1">{ownerTz}</span>
          </p>
        )}
        {booked.note.trim() && (
          <p className="mt-4 border-s-2 border-yang/40 ps-3 text-[14px] italic leading-relaxed text-ink-2" data-ay-skip="1">
            {booked.note}
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          {booked.id > 0 && <Button href={`/meet/${booked.id}`}>Open the meeting</Button>}
          <Button href="/calendar/" variant="outline">See it in your calendar</Button>
        </div>
      </section>,
      <section className="rounded-card border border-line bg-space-2 p-4" aria-label="Who you’d be meeting">
        <h2 className="text-[14px] font-semibold text-ink">Who you’re meeting</h2>
        <div className="mt-3 flex items-center gap-3">
          <Avatar src={owner.avatar} name={owner.name} className="h-14 w-14" priority />
          <div className="min-w-0">
            <p className="text-[15px] font-semibold text-ink" data-ay-skip="1">{owner.name}</p>
            {owner.slug && <p className="text-[12.5px] text-ink-3" data-ay-skip="1">@{owner.slug}</p>}
          </div>
        </div>
      </section>,
    );
  }

  /* ── nothing offered ── */
  if (offered.length === 0) {
    return frame(
      <PageHero eyebrow="Time with" title={<span data-ay-skip="1">{owner.name}</span>} />,
      /* THE OWNER IS NOT A VISITOR. Reading "Arash isn't taking bookings" on your own page tells you
         what is wrong and nothing about how to fix it — and this is the exact screen somebody lands
         on the first time they follow their own link, before they have set anything. Same emptiness,
         two different readers, two different next steps. */
      viewerIsOwner ? (
        <EmptyState
          title="Your booking page is ready — it just has no hours yet"
          body="Say when you are open to being booked and this page starts offering those times to anyone with the link. You can change or pause it whenever you like."
          action={<Button href={localePath("/book")}>Set your hours</Button>}
        />
      ) : (
        <EmptyState
          title={<><span data-ay-skip="1">{owner.name}</span> isn’t taking bookings</>}
          body="No times are being offered here at the moment. Nothing has gone wrong — this page only shows what somebody has chosen to offer."
          /* The way OUT of a dead end has to be a door the reader can actually open. Every profile
             now offers "Book a time" to signed-out visitors — which is the point — so a stranger
             reaching this state is the common case, not the rare one, and "Schedule a meeting" sends
             them to a page that asks them to sign in to do something nobody invited them to do.
             Their real next step is the member: public, and where the ways to reach them live.
             (`localePath` on both, which the /meet/ link had been missing — a bare path drops a
             reader out of their language.) */
          action={isLoggedIn()
            ? <Button href={localePath("/meet/")} variant="outline">Schedule a meeting instead</Button>
            : owner.slug
              ? <Button href={localePath(`/u/${encodeURIComponent(owner.slug)}`)} variant="outline">See their profile</Button>
              : null}
        />
      ),
      null,
    );
  }

  const soonest = groups[0]?.starts[0] || 0;
  const nextMonth = addMonths(month, 1);
  const laterMonth = Array.from(monthsWithSlots).sort().find((m) => m > month) || "";
  const prevBlocked = month <= monthOf(todayKey);
  // Disabled from the RULE, never from the data: `${nextMonth}-01` is beyond the horizon or it is
  // not. An arrow is never dead and never lies.
  const nextBlocked = `${nextMonth}-01` > horizonKey;
  const emptyHorizon = starts !== null && !slotsFailed && groups.length === 0;

  const heroLede = type?.blurb
    ? <span data-ay-skip="1">{type.blurb}</span>
    : "Pick a time that suits you — it becomes an encrypted ArtaMeet in both calendars";

  return frame(
    <PageHero eyebrow="Time with" title={<span data-ay-skip="1">{owner.name}</span>} lede={heroLede} />,
    <>
      {viewerIsOwner && (
        <p className="rounded-card border border-yin/40 bg-yin/10 px-4 py-3 text-[13px] leading-relaxed text-ink-2">
          This is your own page — exactly what a visitor sees.{" "}
          <LinkButton className={cx("text-[13px]", LINK_HIT)} onClick={() => { window.location.assign(localePath("/book")); }}>Edit your hours</LinkButton>
        </p>
      )}

      {/* PHONE HEADER. The face and the offer above the fold, then the times. It is a second copy of
          the rail's first two cards, not a second instance: only ever one of the pair is display:block,
          so nothing is announced twice and no state is forked (it all lives here). */}
      <section className="rounded-card border border-line bg-space-2 p-4 md:hidden" aria-label="Who you’d be meeting">
        <div className="flex items-start gap-3">
          <Avatar src={owner.avatar} name={owner.name} className="h-11 w-11" priority />
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold text-ink" data-ay-skip="1">{owner.name}</p>
            {type && (
              <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
                <span data-ay-skip="1">{type.title}</span>
                <Pill><DurationText m={Number(type.minutes) || 30} /></Pill>
              </p>
            )}
          </div>
        </div>
        {type?.blurb && <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-ink-2" data-ay-skip="1">{type.blurb}</p>}
        {type && <MetaList type={type} className="mt-3 gap-1.5 text-[12.5px]" />}
        {offered.length > 1 && (
          <div className="mt-3">
            <TypeChooser offered={offered} current={type} onPick={(s) => { setTypeSlug(s); setPicked(0); setDay(""); }} />
          </div>
        )}
      </section>


      {slotsFailed && (
        <ErrorNote>
          Couldn’t load the free times.{" "}
          <button type="button" className="-my-2 inline-flex min-h-[40px] items-center py-2 font-semibold underline" onClick={() => loadSlots()}>Try again</button>
        </ErrorNote>
      )}

      {gone && (
        <ErrorNote>
          That time went while you were signing in. Everything below is still free
          {note.trim() ? <> — your note is still here</> : null}
        </ErrorNote>
      )}

      {emptyHorizon ? (
        <EmptyState
          title={<>No free times in the next <span data-ay-skip="1">{horizonD}</span> days</>}
          body={<>
            <span data-ay-skip="1">{owner.name}</span> has nothing open that far ahead. It is worth looking again in a
            day or two — a slot frees the moment something moves
          </>}
          action={<Button variant="outline" onClick={() => loadSlots()}>Look again</Button>}
        />
      ) : (
        <>
          {soonest > 0 && (
            <p className="text-[13px] text-ink-3">
              Soonest free:{" "}
              <span data-ay-skip="1">{dayHeading(groups[0].key, false)}, {clockOnly(soonest, displayTz)}</span>
            </p>
          )}

          <section className="rounded-card border border-line bg-space-2 p-4 md:p-5" aria-label="Choose a day and a time">
            {zoneBanner}
            <div className="md:flex md:items-start md:gap-5">
            <div className="md:min-w-0 md:flex-1">
            <div className="flex h-10 items-center justify-between">
              <h2 className="text-[18px] font-bold text-ink">
                <time dateTime={month} data-ay-skip="1">{monthLabel(month)}</time>
              </h2>
              <div className="flex items-center gap-1">
                <IconButton label="Previous month" className="h-10 w-10" disabled={prevBlocked}
                  onClick={() => setMonth(addMonths(month, -1))}
                  aria-disabled={prevBlocked} ><ChevronGlyph back /></IconButton>
                <IconButton label="Next month" className="h-10 w-10" disabled={nextBlocked}
                  onClick={() => setMonth(nextMonth)}
                  aria-disabled={nextBlocked}><ChevronGlyph /></IconButton>
              </div>
            </div>

            <WeekdayStrip />

            {starts === null && !slotsFailed ? (
              <>
                <GridSkeleton />
                <p className="mt-3 text-[13px] text-ink-3">Finding their free times…</p>
              </>
            ) : (
              <div className="relative">
                {/* A failed fetch and an empty month both keep the grid at FULL height with plain
                    numerals. Rendering either as a collapsed diary tells a visitor something about
                    this person's week that we do not actually know. */}
                <DayGrid month={month} dayMap={dayMap} todayKey={todayKey} horizonKey={horizonKey}
                  selected={activeKey} onChoose={chooseDay} onMonth={setMonth} />
                {!slotsFailed && !monthsWithSlots.has(month) && (
                  <div className="pointer-events-none absolute inset-0 grid place-items-center">
                    <div className="pointer-events-auto rounded-card border border-line bg-space-2/95 px-4 py-3 text-center backdrop-blur">
                      <p className="text-[13px] text-ink-2">
                        Nothing free in <span data-ay-skip="1">{monthLabel(month, false)}</span>
                      </p>
                      {/* Only ever offered when that month is KNOWN to hold something — we hold the
                          whole horizon, so this is never a guess and never a dead link. */}
                      {laterMonth && (
                        <LinkButton className={LINK_HIT} onClick={() => setMonth(laterMonth)}>
                          See <span data-ay-skip="1">{monthLabel(laterMonth, false)}</span>
                        </LinkButton>
                      )}
                      {!laterMonth && (
                        <p className="mt-1 text-[12.5px] text-ink-3">
                          <span data-ay-skip="1">{owner.name}</span> takes bookings up to{" "}
                          <span data-ay-skip="1">{horizonD}</span> days ahead
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            </div>

            {/* The reserve arrives as a CUSTOM PROPERTY rather than an inline `minHeight`: inline
                styles beat every class, so a computed height set that way would also apply beside
                the calendar and defeat `md:min-h-0`. As a variable, the breakpoint still wins. */}
            <div ref={timesBox} style={{ "--times-floor": `${timesFloor}px` } as CSSProperties}
              className="mt-4 min-h-[var(--times-floor)] scroll-mt-topbar border-t border-line pt-4 md:mt-0 md:min-h-0 md:w-[210px] md:shrink-0 md:border-l md:border-t-0 md:ps-5 md:pt-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 ref={timesHead} tabIndex={-1} className="text-[14px] font-semibold text-ink outline-none">
                  {activeKey
                    ? <>
                        <span className="md:hidden" data-ay-skip="1">{dayHeading(activeKey, false)}</span>
                        <span className="hidden md:inline" data-ay-skip="1">{dayHeadingLong(activeKey)}</span>
                      </>
                    : <>Pick a day</>}
                </h2>
              </div>

              {/* A refused take is reported HERE, beside the times, and not on the confirm surface:
                  the refusal releases the pick (otherwise the page keeps offering an instant it has
                  just marked "Taken"), and the confirm surface only renders while a pick is held —
                  so a note living there would be cleared by the very thing that caused it. This is
                  also where the visitor is looking: the slot that went is marked in place one line
                  below, among the times that are still free. */}
              {takeErr && <div className="mt-3" role="status"><ErrorNote>{takeErr}</ErrorNote></div>}

              <div className="mt-3">
                {dayTimes.length > 0 ? (
                  <div className="grid grid-cols-3 gap-2 md:max-h-[444px] md:grid-cols-1 md:gap-1.5 md:overflow-y-auto md:pe-1">
                    {dayTimes.map((ts) => {
                      const on = ts === picked;
                      // A slot a re-read says has gone stays PUT, disabled and labelled — it must
                      // never vanish from under the cursor that was travelling towards it, and the
                      // rest of the row must not shuffle along one place to fill the gap.
                      const dead = !freeSet.has(ts);
                      return (
                        <button key={ts} type="button" aria-pressed={on} disabled={dead}
                          onClick={() => { setPicked(ts); setTakeErr(""); setGone(false); }}
                          className={cx("h-12 rounded-field border text-[15px] font-semibold tabular-nums transition-colors duration-150 md:h-11 md:text-[14.5px]",
                            dead ? "cursor-not-allowed border-line text-ink-3"
                              : on ? "border-yang bg-yang text-on-accent"
                              : "border-line text-ink-2 hover:border-yin-light hover:text-ink")}>
                          {dead
                            ? <>Taken <span className="sr-only">— <span data-ay-skip="1">{clockOnly(ts, displayTz)}</span></span></>
                            : <span data-ay-skip="1">{clockOnly(ts, displayTz)}</span>}
                        </button>
                      );
                    })}
                  </div>
                ) : slotsFailed ? (
                  <p className="rounded-card border border-line p-4 text-[13px] text-ink-3">
                    The free times couldn’t be loaded — nothing here is a statement about this week
                  </p>
                ) : starts === null ? null : (
                  <p className="rounded-card border border-line p-4 text-[13px] text-ink-3">All taken — try another day</p>
                )}
              </div>
            </div>
            </div>
          </section>
        </>
      )}

      {/* One polite region for the whole calendar: which month, which day, how much is in it. */}
      <p aria-live="polite" className="sr-only">
        <span data-ay-skip="1">{monthLabel(month)}</span>
        {activeKey ? <>. <span data-ay-skip="1">{dayHeadingLong(activeKey)}</span>, <span data-ay-skip="1">{active?.length || 0}</span> times free</> : null}
      </p>

    </>,
    <>
      <section className="hidden rounded-card border border-line bg-space-2 p-4 md:block" aria-label="Who you’d be meeting">
        <h2 className="text-[14px] font-semibold text-ink">Who you’d be meeting</h2>
        <div className="mt-3 flex items-center gap-3">
          <Avatar src={owner.avatar} name={owner.name} className="h-14 w-14" priority />
          <div className="min-w-0">
            <p className="text-[15px] font-semibold text-ink" data-ay-skip="1">{owner.name}</p>
            {owner.slug && <p className="text-[12.5px] text-ink-3" data-ay-skip="1">@{owner.slug}</p>}
          </div>
        </div>
        {owner.slug && (
          <div className="mt-3">
            <Button variant="outline" className="h-10" href={`/u/${owner.slug}`}>Their profile</Button>
          </div>
        )}
      </section>

      {type && (
        /* The card's own title was "What you're asking for", above the meeting's title — a label
           announcing the thing directly beneath it. The meeting IS the heading now, and the label
           survives only for assistive tech, where a section does need a name. */
        <section className="hidden rounded-card border border-line bg-space-2 p-4 md:block" aria-label="What you’re asking for">
          {offered.length > 1 ? (
            <TypeChooser offered={offered} current={type} onPick={(s) => { setTypeSlug(s); setPicked(0); setDay(""); }} />
          ) : (
            <>
              <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-ink">
                <span data-ay-skip="1">{type.title}</span>
                <Pill><DurationText m={Number(type.minutes) || 30} /></Pill>
              </h2>
              {type.blurb && <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-ink-2" data-ay-skip="1">{type.blurb}</p>}
            </>
          )}
          <MetaList type={type} className="mt-3.5 border-t border-line pt-3.5" />
        </section>
      )}

      {confirmSurface}

    </>,
  );
}

/* ───────────────────────── the owner ───────────────────────── */

const BLANK: BookRule = {
  id: 0, slug: "", title: "Meeting", blurb: "", minutes: 30, tz: VIEWER_TZ, days: "1111100",
  from_min: 540, to_min: 1020, buffer_min: 10, notice_h: 4, horizon_d: 21, seats: 2, active: 1,
};

function RuleForm({ rule, onSaved, onCancel }: { rule: BookRule; onSaved: (r: BookRule | null) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(rule.title || "Meeting");
  const [blurb, setBlurb] = useState(rule.blurb || "");
  const [minutes, setMinutes] = useState(Number(rule.minutes) || 30);
  const [tz, setTz] = useState(rule.tz || VIEWER_TZ);
  const [days, setDays] = useState((rule.days || "1111100").padEnd(7, "0").slice(0, 7));
  // `??` against a NUMBER, not `||`: midnight is 0, and 0 is a value this very form can produce
  // (`<input type="time">` at 00:00) and the server stores (`from_min < 0` is its only floor). With
  // `||` the form read a saved 00:00 back as 09:00 and Save wrote that, silently withdrawing nine
  // published hours the owner never touched; with From 00:00 / Until 06:00 it read back as 540/360
  // and the "finishing time" check disabled Save, locking the owner out of their own rule. Same
  // shape for notice_h, where 0 means "no notice at all" and is equally legal.
  const num = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const [fromMin, setFromMin] = useState(() => num(rule.from_min, 540));
  const [toMin, setToMin] = useState(() => num(rule.to_min, 1020));
  const [buffer, setBuffer] = useState(() => num(rule.buffer_min, 0));
  const [notice, setNotice] = useState(() => num(rule.notice_h, 4));
  const [horizon, setHorizon] = useState(Number(rule.horizon_d) || 21);
  const [seats, setSeats] = useState(Number(rule.seats) || 2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggleDay = (i: number) => setDays((d) => d.slice(0, i) + (d[i] === "1" ? "0" : "1") + d.slice(i + 1));

  const problem = !title.trim() ? "Give it a name — it is the first thing anybody reads."
    : !/1/.test(days) ? "Choose at least one day, or nobody can book anything."
    : toMin <= fromMin ? "The finishing time has to come after the starting one."
    : toMin - fromMin < minutes ? "The window is shorter than one meeting, so no slot would fit."
    : "";

  async function save() {
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError("");
    try {
      const r = await bookSetRule({
        ...(rule.id ? { id: rule.id } : {}),
        title: title.trim(), blurb: blurb.trim(), minutes, tz, days,
        from_min: fromMin, to_min: toMin, buffer_min: buffer, notice_h: notice, horizon_d: horizon, seats,
      });
      onSaved(r.rule || null);
    } catch (e) {
      setError(errText(e, "That couldn’t be saved. Try again in a moment."));
    } finally {
      setBusy(false);
    }
  }

  const local = localWindow({ ...BLANK, tz, from_min: fromMin, to_min: toMin }, VIEWER_TZ);

  return (
    <section className="rounded-card border border-line bg-space-2 p-4 sm:p-5" aria-label="Availability">
      <div className="flex flex-col gap-4">
        <Field label="What is this called?" required hint="Visitors see this as the kind of meeting they are asking for">
          <Input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder="A conversation" />
        </Field>

        <Field label="A line about it" optional>
          <Textarea rows={2} value={blurb} maxLength={400} onChange={(e) => setBlurb(e.target.value)}
            placeholder="What you are happy to be asked about" />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="How long">
            <Select value={String(minutes)} onChange={(v) => setMinutes(Number(v))}
              options={DURATIONS.map((m) => ({ value: String(m), label: durationLabel(m) }))} />
          </Field>
          <Field label="Your time zone" hint="The hours below are hours of YOUR day, in this zone">
            <Select value={tz} onChange={setTz} options={ZONES} skipOptions />
          </Field>
        </div>

        <div>
          <span className="text-[13px] font-semibold text-ink-2">Which days</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {MON_FIRST.map((i) => {
              const on = days[i] === "1";
              return (
                <button key={i} type="button" aria-pressed={on} onClick={() => toggleDay(i)}
                  className={cx("h-10 min-w-[52px] rounded-pill border px-3 text-[13px] font-semibold transition-colors",
                    on ? "border-yang bg-yang/15 text-yang" : "border-line text-ink-3 hover:border-yin-light hover:text-ink")}>
                  <span data-ay-skip="1">{WEEKDAY_NAMES[i]}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => setDays("1111111")}
              className="inline-flex h-10 items-center rounded-pill border border-line px-3.5 text-[12.5px] font-semibold text-ink-3 hover:border-yin-light hover:text-ink">
              Any day
            </button>
            <button type="button" onClick={() => setDays("1111100")}
              className="inline-flex h-10 items-center rounded-pill border border-line px-3.5 text-[12.5px] font-semibold text-ink-3 hover:border-yin-light hover:text-ink">
              Weekdays
            </button>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* type="time" so the control speaks the reader's own clock (12-hour where that is the
              habit) while the value stays a fixed 24-hour grammar. */}
          <Field label="From" hint="In the zone above">
            <Input type="time" value={minuteInput(fromMin)} step={300}
              onChange={(e) => { const m = inputMinute(e.target.value); if (m >= 0) setFromMin(m); }} />
          </Field>
          <Field label="Until">
            <Input type="time" value={minuteInput(toMin)} step={300}
              onChange={(e) => { const m = inputMinute(e.target.value); if (m >= 0) setToMin(m); }} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Least notice">
            <Select value={String(notice)} onChange={(v) => setNotice(Number(v))}
              options={NOTICES.map((h) => ({ value: String(h), label: noticeLabel(h) }))} />
          </Field>
          <Field label="How far ahead">
            <Select value={String(horizon)} onChange={(v) => setHorizon(Number(v))}
              options={HORIZONS.map((d) => ({ value: String(d), label: `${d} days` }))} />
          </Field>
          <Field label="Gap between">
            <Select value={String(buffer)} onChange={(v) => setBuffer(Number(v))}
              options={BUFFERS.map((m) => ({ value: String(m), label: m === 0 ? "None" : `${m} minutes` }))} />
          </Field>
          <Field label="Seats">
            <Select value={String(seats)} onChange={(v) => setSeats(Number(v))}
              options={SEATS.map((s) => ({ value: String(s), label: s === 2 ? "Just the two of us" : `Up to ${s} people` }))} />
          </Field>
        </div>

        {/* The rule read back as a sentence, in the owner's zone and in their browser's, because the
            single commonest way to offer the wrong hours is to type them into the wrong zone. The
            second line is the VISITOR's phrasing, so what a stranger will read is on this screen. */}
        <div className="rounded-card border border-line bg-space-1/40 px-4 py-3 text-[13px] leading-relaxed text-ink-2">
          <p>
            Anyone with your link can book <DurationText m={minutes} /> with you,{" "}
            <DaysText days={days} lower />, between{" "}
            <span data-ay-skip="1">{minuteClock(fromMin)}</span> and <span data-ay-skip="1">{minuteClock(toMin)}</span> in{" "}
            <span data-ay-skip="1">{tz}</span>
            {local && <> — which is <span data-ay-skip="1">{local}</span> on the clock you are reading this on</>}
          </p>
          <p className="mt-1.5 text-ink-3">
            Anyone with your link sees{" "}
            <DaysText days={days} />, <span data-ay-skip="1">{minuteClock(fromMin)} – {minuteClock(toMin)}</span>, your time
          </p>
        </div>

        {(error || problem) && <ErrorNote>{error || problem}</ErrorNote>}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void save()} disabled={busy || !!problem} className="h-11 px-6">
            {busy ? "Saving…" : rule.id ? "Save" : "Start offering this"}
          </Button>
          <button type="button" onClick={onCancel}
            className="inline-flex h-11 items-center px-2 text-[13.5px] font-semibold text-ink-3 hover:text-ink">
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}

function RuleCard({ rule, onEdit, onOff, onOn, busy }: { rule: BookRule; onEdit: () => void; onOff: () => void; onOn: () => void; busy: boolean }) {
  const off = Number(rule.active) === 0;
  const local = localWindow(rule, VIEWER_TZ);
  return (
    <article className={cx("rounded-card border bg-space-2 p-4 sm:p-5", off ? "border-line opacity-70" : "border-line")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[16px] font-bold text-ink" data-ay-skip="1">{rule.title}</h3>
          {rule.blurb && <p className="mt-1 max-w-prose text-[13.5px] leading-relaxed text-ink-2" data-ay-skip="1">{rule.blurb}</p>}
        </div>
        {off ? <Pill className="bg-veil/10 text-ink-3">Not offered</Pill> : <Pill>Open</Pill>}
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
        <div className="flex gap-2"><dt className="text-ink-3">Length</dt>
          <dd className="text-ink-2"><DurationText m={Number(rule.minutes) || 30} /></dd></div>
        <div className="flex gap-2"><dt className="text-ink-3">Days</dt>
          <dd className="text-ink-2"><DaysText days={rule.days} /></dd></div>
        <div className="flex gap-2"><dt className="text-ink-3">Hours</dt>
          <dd className="text-ink-2" data-ay-skip="1">{hoursLabel(rule)} · {rule.tz}</dd></div>
        <div className="flex gap-2"><dt className="text-ink-3">Notice</dt>
          <dd className="text-ink-2"><NoticeText h={Number(rule.notice_h) || 0} /></dd></div>
        <div className="flex gap-2"><dt className="text-ink-3">Ahead</dt>
          <dd className="text-ink-2" data-ay-skip="1">{Number(rule.horizon_d) || 21} days</dd></div>
        {local && (
          <div className="flex gap-2"><dt className="text-ink-3">Your clock</dt>
            <dd className="text-ink-2" data-ay-skip="1">{local}</dd></div>
        )}
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={onEdit} className="h-10">Edit</Button>
        {off ? (
          /* Withdrawing was one-way unless you opened the form — a visible dead end on your own
             page. The row survives a withdrawal precisely so the same link works again. */
          <button type="button" onClick={onOn} disabled={busy}
            className="inline-flex h-10 items-center rounded-pill border border-line px-4 text-[13px] font-semibold text-ink-2 transition-colors hover:border-yin-light hover:text-ink disabled:opacity-50">
            Offer this again
          </button>
        ) : (
          <button type="button" onClick={onOff} disabled={busy}
            className="inline-flex h-10 items-center rounded-pill border border-line px-4 text-[13px] font-semibold text-ink-3 transition-colors hover:border-yin-light hover:text-ink disabled:opacity-50">
            Stop offering it
          </button>
        )}
      </div>
    </article>
  );
}

function ShareCard({ handle, url: given }: { handle: string; url?: string }) {
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState("");
  // The server already composes the link it considers canonical — recomposing it from
  // window.location.origin is how a page hands out a link from whatever host it happens to be on.
  const url = given || (typeof window === "undefined" ? "" : `${window.location.origin}/book/${handle}`);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setNote("This browser wouldn’t let the page copy — select the address and copy it by hand.");
    }
  }

  return (
    <section className="rounded-card border border-line bg-space-2 p-4" aria-label="Your booking link">
      <h2 className="text-[14px] font-semibold text-ink">Your link</h2>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">
        Send this to anybody. They can see when you are free without an account, and only sign in to take a time
      </p>
      <p className="mt-2 break-all text-[12px] text-ink-2" data-ay-skip="1">{url}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void copy()}
          className="inline-flex h-10 items-center rounded-pill bg-yang px-4 text-[13px] font-bold text-on-accent transition-colors hover:bg-yin hover:text-white">
          {copied ? "Copied" : "Copy the link"}
        </button>
        <a href={localePath(`/book/${handle}`)}
          className="inline-flex h-10 items-center rounded-pill border border-line px-4 text-[13px] font-semibold text-ink-2 transition-colors hover:border-yin-light hover:text-ink">
          See what they see
        </a>
      </div>
      {note && <p className="mt-2 text-[12.5px] text-ink-2">{note}</p>}
    </section>
  );
}

function HowPanel() {
  const rows: { label: string; body: ReactNode }[] = [
    { label: "Nobody sees your diary", body: "A visitor is told which times are free and nothing else — never what you are busy with, never who with, never how much of it there is" },
    { label: "A booking is a meeting", body: "When somebody takes a time it becomes an ordinary meeting with both of you on it: in your calendar, in your subscription feed, in the encrypted room when it starts" },
    { label: "It is a rule, not a diary", body: "You are describing hours of your own week. Anything already in your calendar takes those hours out of it automatically" },
  ];
  return (
    <section className="rounded-card border border-line bg-space-2 p-4" aria-label="How booking works">
      <h2 className="text-[14px] font-semibold text-ink">How this works</h2>
      <ul className="mt-3 flex flex-col gap-3">
        {rows.map((r) => (
          <li key={r.label}>
            <p className="text-[13px] font-semibold text-ink">{r.label}</p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">{r.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function OwnerPage() {
  const me = currentUser();
  const [items, setItems] = useState<BookRule[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [handle, setHandle] = useState(me?.slug || "");
  const [shareUrl, setShareUrl] = useState("");
  const [editing, setEditing] = useState<BookRule | null>(null);
  const [busyId, setBusyId] = useState(0);

  const load = useCallback(() => {
    setFailed(false);
    bookRules()
      .then((r) => { setItems(r.items || []); if (r.handle) setHandle(r.handle); if (r.url) setShareUrl(r.url); })
      // An unanswered request is not "you offer nothing" — that would invite somebody to create a
      // second copy of a rule they already have.
      .catch(() => { setItems(null); setFailed(true); });
  }, []);

  useEffect(() => { load(); }, [load]);

  async function stopOffering(rule: BookRule) {
    setBusyId(rule.id);
    try {
      await bookRuleOff(rule.id);
      load();
    } catch { setFailed(true); } finally { setBusyId(0); }
  }

  async function startOffering(rule: BookRule) {
    setBusyId(rule.id);
    try {
      // Absent fields keep what the row already said, so this switches the one column it names.
      await bookSetRule({
        id: rule.id, title: rule.title, minutes: rule.minutes, tz: rule.tz, days: rule.days,
        from_min: rule.from_min, to_min: rule.to_min, active: 1,
      });
      load();
    } catch { setFailed(true); } finally { setBusyId(0); }
  }

  if (!isLoggedIn()) {
    // PageHero owns the page's one <h1>, so the gate is an EmptyState rather than SignInGate — the
    // shell's route-change focus has to land on exactly one heading.
    return (
      <div className="mx-auto flex w-full max-w-[1076px] flex-col gap-6 pb-12">
        <PageHero eyebrow="Community" title="Let people book you"
          lede="Offer the hours of your week you are happy to be asked for, and share one link." />
        <EmptyState title="Sign in to offer your time"
          body="Your availability is yours: which hours of your own week you are happy to be asked for, and who has taken one. None of it exists for anyone who is not signed in as you."
          action={<Button href="/login/">Sign in</Button>} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 pb-12">
      <div className="mx-auto w-full max-w-[1076px]">
        <PageHero eyebrow="Community" title="Let people book you"
          lede="Say which hours of your own week you are happy to be asked for. Share one link — anybody can see when you are free without an account, and taking a time makes an ordinary meeting." />
      </div>

      <div className="mx-auto flex w-full max-w-[1076px] flex-col gap-4 md:flex-row md:items-start lg:gap-7">
        <main className="flex w-full min-w-0 flex-col gap-4 md:max-w-2xl md:flex-1">
          {failed ? (
            <ErrorNote>
              Couldn’t load your availability.{" "}
              <button type="button" className="-my-2 inline-flex min-h-[40px] items-center py-2 font-semibold underline" onClick={load}>Try again</button>
            </ErrorNote>
          ) : items === null ? (
            <StatusNote>Loading your availability…</StatusNote>
          ) : null}

          {editing && (
            <RuleForm
              key={editing.id || "new"}
              rule={editing}
              onCancel={() => setEditing(null)}
              onSaved={() => { setEditing(null); load(); }}
            />
          )}

          {items !== null && items.length === 0 && !editing && (
            <EmptyState
              title="You aren’t offering any times yet"
              body="Describe one window of your week — the days, the hours of your own day and how long a conversation runs — and you have a link to hand out."
              action={<Button onClick={() => setEditing(BLANK)}>Offer some time</Button>}
            />
          )}

          {items?.map((r) => (
            <RuleCard key={r.id} rule={r} busy={busyId === r.id}
              onEdit={() => setEditing(r)} onOff={() => void stopOffering(r)} onOn={() => void startOffering(r)} />
          ))}

          {items !== null && items.length > 0 && !editing && (
            <div>
              <Button variant="outline" onClick={() => setEditing(BLANK)} className="h-11">Offer another kind of meeting</Button>
            </div>
          )}
        </main>

        <aside className="flex w-full flex-col gap-3 md:order-2 md:w-[300px] md:shrink-0 lg:w-[330px]"
          aria-label="Your link and how booking works">
          <div className="max-md:hidden"><RailSearch /></div>
          {handle ? <ShareCard handle={handle} url={shareUrl} /> : null}
          <HowPanel />
        </aside>
      </div>
    </div>
  );
}

/* ───────────────────────── the route ───────────────────────── */

export default function Book() {
  // This page renders its own right column, so the shell must not add a second one.
  useOwnsRail();
  const { handle } = useParams();
  return handle ? <VisitorPage key={handle} handle={handle} /> : <OwnerPage />;
}
