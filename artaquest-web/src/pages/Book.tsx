import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import {
  ApiError, bookPage, bookRuleOff, bookRules, bookSetRule, bookSlots, bookTake,
  type BookOwner, type BookRule,
} from "../lib/api";
import { currentUser, isLoggedIn, localePath } from "../lib/wp";
import {
  Avatar, Button, EmptyState, ErrorNote, Field, Input, PageHero, Pill, Segmented,
  Select, StatusNote, Textarea, cx,
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
 *     time is actually claimed — and the page says so before they invest a single click.
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
 * ⚠️ TIMEZONES ARE THE WHOLE PROBLEM. Slots arrive as UTC instants and are rendered in the VIEWER's
 * zone with the zone NAMED — an unlabelled clock time is the wrong-zone bug wearing a disguise. The
 * owner's zone is shown too, and can be switched to, because "2pm his time" is what the visitor is
 * really agreeing to. The owner's own hours are stored as minutes from midnight IN THEIR ZONE and
 * are never converted on the way out: "I am free from two" is a statement about their afternoon,
 * and it has to survive their DST as well as yours.
 *
 * ⚠️ `data-ay-skip="1"` on the wrapper around every formatted date, every member name and every
 * member-authored word. Not for secrecy — but the i18n mesh walks document.body and PERSISTS what
 * it finds into the public aq_translations table, which would republish a member's wording and
 * machine-translate a clock time in place. Mark wrappers, never leaves.
 */

const VIEWER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
})();

/** Every IANA zone the engine knows, for the owner who lives somewhere other than the machine they
 *  happen to be typing on. Falls back to the two zones we can always name. */
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

const clockOnly = (ts: number, tz: string) => fmt(ts, { hour: "2-digit", minute: "2-digit" }, tz);

/** YYYY-MM-DD for an instant in a named zone — en-CA writes that order natively, and it is what the
 *  day grouping and the Today/Tomorrow comparison are both keyed on. */
function dayKey(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Number(ts) * 1000));
}

/** A day heading from its key. Parsed back at UTC noon purely so it can be formatted: no zone can
 *  drag noon onto a neighbouring day, which a midnight would do for half the planet. */
function dayHeading(key: string, withYear: boolean): string {
  const noon = Math.round(Date.parse(key + "T12:00:00Z") / 1000);
  return fmt(noon, { weekday: "short", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) }, "UTC");
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
  return fmt(Math.round(Date.UTC(1970, 0, 1, 0, m) / 1000), { hour: "2-digit", minute: "2-digit" }, "UTC");
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

/* ───────────────────────── what a rule says ───────────────────────── */

const isEveryDay = (days: string) => /^1{7}$/.test(days);

/** The mask in words. "Any day" and "Weekdays" are the two shapes people actually choose, so they
 *  are named rather than spelled out as seven abbreviations. */
function daysLabel(days: string): string {
  const mask = (days || "").padEnd(7, "0").slice(0, 7);
  if (isEveryDay(mask)) return "Any day";
  if (mask === "1111100") return "Weekdays";
  if (mask === "0000011") return "Weekends";
  const on = MON_FIRST.filter((i) => mask[i] === "1").map((i) => WEEKDAY_NAMES[i]);
  return on.length ? on.join(", ") : "No days";
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
   trip with it: the slot they chose is in the URL before we leave, and the page picks it back up on
   the way in. Coming back to the top of a page you had already worked your way down is the quiet
   way to lose somebody. */

function signInTo(path: string) {
  window.location.assign(`${localePath("/login/")}?redirect_to=${encodeURIComponent(path)}`);
}

/* ───────────────────────── the visitor ───────────────────────── */

type DayGroup = { key: string; starts: number[] };

function OwnerLine({ owner, rule, tz }: { owner: BookOwner; rule: BookRule | null; tz: string }) {
  if (!rule) return null;
  const local = localWindow(rule, tz);
  return (
    <p className="text-[13px] leading-relaxed text-ink-3">
      <span data-ay-skip="1">{owner.name}</span> takes bookings{" "}
      <span data-ay-skip="1">{daysLabel(rule.days).toLowerCase()}</span>, between{" "}
      <span data-ay-skip="1">{minuteClock(rule.from_min)}</span> and{" "}
      <span data-ay-skip="1">{minuteClock(rule.to_min)}</span> in{" "}
      <span data-ay-skip="1">{rule.tz}</span>
      {local && <> — which is <span data-ay-skip="1">{local}</span> where you are</>}
    </p>
  );
}

function VisitorPage({ handle }: { handle: string }) {
  // Read ONCE, at mount: after a sign-in trip this is a fresh page load, and these are the crumbs
  // that trip left behind.
  const [entry] = useState(() => {
    const sp = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
    return { type: sp.get("type") || "", t: Number(sp.get("t")) || 0 };
  });

  const [owner, setOwner] = useState<BookOwner | null>(null);
  const [types, setTypes] = useState<BookRule[] | null>(null);
  const [pageErr, setPageErr] = useState("");
  const [typeSlug, setTypeSlug] = useState(entry.type);
  const [showTheirs, setShowTheirs] = useState(false);
  const [starts, setStarts] = useState<number[] | null>(null);
  const [slotsFailed, setSlotsFailed] = useState(false);
  const [day, setDay] = useState("");
  const [picked, setPicked] = useState(0);
  const [allDays, setAllDays] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [takeErr, setTakeErr] = useState("");
  const [gone, setGone] = useState(false);
  const [booked, setBooked] = useState<{ id: number; start: number } | null>(null);
  // Read once and ticked, never called during a render: "Today" has to stop meaning today when
  // midnight passes under an open page, and a clock read mid-render is a different answer every
  // time React happens to re-run the component.
  const [now, setNow] = useState(() => Math.round(Date.now() / 1000));
  const seq = useRef(0);
  const restored = useRef(false);
  const confirmBtn = useRef<HTMLButtonElement | null>(null);

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

  const type = useMemo(() => {
    const list = (types || []).filter((t) => Number(t.active) !== 0);
    return list.find((t) => t.slug === typeSlug) || list[0] || null;
  }, [types, typeSlug]);

  const loadSlots = useCallback(() => {
    if (!type) return;
    const mine = ++seq.current;
    const from = Math.round(Date.now() / 1000);
    // Ask for the rule's own horizon and let the server clamp it. The window is computed here, once
    // per load, rather than from a ticking clock — a tick must never re-fetch the grid out from
    // under a hand that is already reaching for it.
    const to = from + Math.max(1, Math.min(90, Number(type.horizon_d) || 21)) * 86400;
    setStarts(null);
    setSlotsFailed(false);
    bookSlots({ user: handle, type: type.slug, from, to })
      .then((r) => { if (mine === seq.current) setStarts(r.starts); })
      // A FAILED request is not an empty diary. Falling through to "no free times" would tell a
      // visitor this person is booked solid on exactly the request that never came back.
      .catch(() => { if (mine === seq.current) { setStarts(null); setSlotsFailed(true); } });
  }, [handle, type]);

  useEffect(() => { loadSlots(); }, [loadSlots]);

  const displayTz = showTheirs && owner?.tz ? owner.tz : VIEWER_TZ;

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

  // Pick the slot the sign-in trip was for, once, as soon as there is a grid to find it in.
  useEffect(() => {
    if (restored.current || !entry.t || !starts) return;
    restored.current = true;
    if (starts.includes(entry.t)) {
      setPicked(entry.t);
      // Focus rather than scroll: focus takes the keyboard there as well as the eye, and a member
      // who signed in with a keyboard is exactly who this matters to.
      window.requestAnimationFrame(() => confirmBtn.current?.focus());
    } else {
      setGone(true);
    }
  }, [entry.t, starts]);

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
  const tomorrowKey = dayKey(now + 86400, displayTz);
  const activeKey = picked ? dayKey(picked, displayTz) : (day || groups[0]?.key || "");
  const active = groups.find((g) => g.key === activeKey) || groups[0] || null;
  const shownDays = allDays ? groups : groups.slice(0, 10);

  function chooseDay(key: string) {
    setDay(key);
    setTakeErr("");
    // Their pick lives on another day; keeping it selected while its times are off screen is how a
    // person ends up confirming a slot they can no longer see.
    if (picked && dayKey(picked, displayTz) !== key) setPicked(0);
  }

  async function take() {
    if (!picked || !type) return;
    const back = `${window.location.pathname}?type=${encodeURIComponent(type.slug)}&t=${picked}`;
    if (!isLoggedIn()) { signInTo(back); return; }
    setBusy(true);
    setTakeErr("");
    try {
      const r = await bookTake({ user: handle, type: type.slug, start: picked, note });
      setBooked({ id: Number(r.meet?.id || r.id || 0), start: picked });
      setPicked(0);
      setNote("");
    } catch (e) {
      // The commonest refusal by far is that somebody took it while this page was open, so the
      // window is re-read as part of the failure rather than left showing a slot that has gone.
      setTakeErr(errText(e, "That time couldn’t be taken — it may have just gone. Here is what is still free."));
      loadSlots();
    } finally {
      setBusy(false);
    }
  }

  if (pageErr) {
    return (
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-6 pb-12">
        <PageHero eyebrow="Booking" title="Nothing to book here" />
        <EmptyState title="This page isn’t open" body={pageErr}
          action={<Button href="/meet/">Meet</Button>} />
      </div>
    );
  }

  if (!owner || types === null) {
    return (
      <div className="mx-auto w-full max-w-[860px] pb-12">
        <StatusNote>Loading…</StatusNote>
      </div>
    );
  }

  const offered = types.filter((t) => Number(t.active) !== 0);

  if (booked) {
    return (
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-6 pb-12">
        <PageHero eyebrow="Booking" title="That time is yours"
          lede={<>It is an ordinary meeting now — it is already in your calendar, and in <span data-ay-skip="1">{owner.name}</span>’s.</>} />
        <section className="rounded-card border border-line bg-space-2 p-5">
          <p className="text-[15px] font-semibold text-ink" data-ay-skip="1">
            {fmt(booked.start, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }, VIEWER_TZ)}
          </p>
          <p className="mt-1 text-[13px] text-ink-3">
            <span data-ay-skip="1">{VIEWER_TZ}</span> — your time
            {owner.tz && owner.tz !== VIEWER_TZ && (
              <> · <span data-ay-skip="1">{clockOnly(booked.start, owner.tz)}</span> in{" "}
                <span data-ay-skip="1">{owner.tz}</span>, theirs</>
            )}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {booked.id > 0 && <Button href={`/meet/${booked.id}`}>Open the meeting</Button>}
            <Button href="/calendar/" variant="outline">See it in your calendar</Button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-5 pb-12">
      <PageHero
        eyebrow="Booking"
        title={<><span data-ay-skip="1">{owner.name}</span></>}
        lede={type ? <span data-ay-skip="1">{type.title}</span> : undefined}
        aside={<Avatar src={owner.avatar} name={owner.name} className="h-16 w-16" priority />}
      />

      {offered.length === 0 ? (
        <EmptyState
          title={<><span data-ay-skip="1">{owner.name}</span> isn’t taking bookings</>}
          body="No times are being offered here at the moment. Nothing has gone wrong — this page only shows what somebody has chosen to offer."
          action={<Button href="/meet/" variant="outline">Schedule a meeting instead</Button>}
        />
      ) : (
        <>
          {/* Said BEFORE any effort, not after a time has been chosen. Someone who will have to sign
              in eventually is owed that fact while it still costs them nothing. */}
          {!isLoggedIn() && (
            <p className="rounded-card border border-line bg-space-2 px-4 py-3 text-[13px] leading-relaxed text-ink-2">
              You don’t need an account to see these times. Signing in is asked for once, at the last step, when you
              ask for one — and you’ll come straight back to the time you chose
            </p>
          )}

          {offered.length > 1 && (
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="What kind of meeting">
              {offered.map((t) => {
                const on = type?.slug === t.slug;
                return (
                  <button key={t.slug} type="button" role="radio" aria-checked={on}
                    onClick={() => { setTypeSlug(t.slug); setPicked(0); setDay(""); }}
                    className={cx("h-11 rounded-pill border px-4 text-[13.5px] font-semibold transition-colors",
                      on ? "border-yang bg-yang text-on-accent" : "border-line text-ink-2 hover:border-yin-light hover:text-ink")}>
                    <span data-ay-skip="1">{t.title}</span>
                  </button>
                );
              })}
            </div>
          )}

          <section className="rounded-card border border-line bg-space-2 p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                {type?.blurb && (
                  <p className="max-w-prose text-[14px] leading-relaxed text-ink-2" data-ay-skip="1">{type.blurb}</p>
                )}
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-3">
                  <Pill><span data-ay-skip="1">{durationLabel(type?.minutes || 30)}</span></Pill>
                  {type && Number(type.notice_h) > 0 && (
                    <span>book at least <span data-ay-skip="1">{noticeLabel(Number(type.notice_h))}</span> ahead</span>
                  )}
                </p>
                <div className="mt-2">
                  <OwnerLine owner={owner} rule={type} tz={VIEWER_TZ} />
                </div>
              </div>
              {owner.tz && owner.tz !== VIEWER_TZ && (
                <Segmented
                  label="Whose clock"
                  value={showTheirs ? "them" : "you"}
                  onChange={(v) => setShowTheirs(v === "them")}
                  options={[{ value: "you", label: "Your time" }, { value: "them", label: "Their time" }]}
                />
              )}
            </div>
            {/* The zone, named once and plainly. A clock time whose zone is left to be guessed is the
                wrong-zone bug wearing a disguise. */}
            <p className="mt-3 border-t border-line pt-3 text-[12.5px] text-ink-3">
              Times below are shown in{" "}
              <span data-ay-skip="1">{displayTz} ({zoneName(now, displayTz)})</span>
              {displayTz !== VIEWER_TZ && <> — not your own zone</>}
            </p>
          </section>

          {gone && (
            <ErrorNote>
              The time you’d chosen has just been taken. Everything below is still free
            </ErrorNote>
          )}

          {slotsFailed ? (
            <ErrorNote>
              Couldn’t load the free times.{" "}
              <button type="button" className="font-semibold underline" onClick={loadSlots}>Try again</button>
            </ErrorNote>
          ) : starts === null ? (
            <StatusNote>Looking for free times…</StatusNote>
          ) : groups.length === 0 ? (
            <EmptyState
              title="No free times ahead"
              body={<>
                <span data-ay-skip="1">{owner.name}</span> has nothing open in the next{" "}
                <span data-ay-skip="1">{Number(type?.horizon_d) || 21}</span> days. It is worth looking again in a
                day or two — a slot frees up the moment something moves
              </>}
              action={<Button variant="outline" onClick={loadSlots}>Look again</Button>}
            />
          ) : (
            <>
              <section aria-label="Which day">
                <h2 className="text-[13px] font-semibold uppercase tracking-wide text-ink-3">Pick a day</h2>
                <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Which day">
                  {shownDays.map((g) => {
                    const on = g.key === active?.key;
                    const literal = g.key === todayKey ? "Today" : g.key === tomorrowKey ? "Tomorrow" : "";
                    return (
                      <button key={g.key} type="button" role="radio" aria-checked={on} onClick={() => chooseDay(g.key)}
                        className={cx("flex h-12 min-w-[104px] flex-col items-center justify-center rounded-card border px-3 text-[13px] font-semibold transition-colors",
                          on ? "border-yang bg-yang/15 text-yang" : "border-line text-ink-2 hover:border-yin-light hover:text-ink")}>
                        <span>{literal || <span data-ay-skip="1">{dayHeading(g.key, g.key.slice(0, 4) !== todayKey.slice(0, 4))}</span>}</span>
                        <span className="text-[11.5px] font-normal text-ink-3">
                          <span data-ay-skip="1">{g.starts.length}</span> free
                        </span>
                      </button>
                    );
                  })}
                  {!allDays && groups.length > shownDays.length && (
                    <button type="button" onClick={() => setAllDays(true)}
                      className="h-12 rounded-card border border-line px-4 text-[13px] font-semibold text-ink-3 transition-colors hover:border-yin-light hover:text-ink">
                      More days
                    </button>
                  )}
                </div>
              </section>

              {active && (
                <section aria-label="Which time">
                  <h2 className="text-[13px] font-semibold uppercase tracking-wide text-ink-3">
                    Pick a time on{" "}
                    <span data-ay-skip="1">{dayHeading(active.key, false)}</span>
                  </h2>
                  <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
                    {active.starts.map((ts) => {
                      const on = ts === picked;
                      return (
                        <button key={ts} type="button" aria-pressed={on}
                          onClick={() => { setPicked(ts); setTakeErr(""); setGone(false); }}
                          className={cx("h-11 rounded-field border text-[14px] font-semibold tabular-nums transition-colors",
                            on ? "border-yang bg-yang text-on-accent" : "border-line text-ink-2 hover:border-yin-light hover:text-ink")}>
                          <span data-ay-skip="1">{clockOnly(ts, displayTz)}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              {picked > 0 && type && (
                <section className="rounded-card border border-yang/40 bg-space-2 p-4 sm:p-5" aria-label="Confirm">
                  <h2 className="text-[15px] font-bold text-ink">Ask for this time</h2>
                  <p className="mt-2 text-[15px] font-semibold text-ink" data-ay-skip="1">
                    {fmt(picked, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }, VIEWER_TZ)}
                  </p>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-3">
                    <span data-ay-skip="1">{durationLabel(type.minutes)}</span> in your own zone,{" "}
                    <span data-ay-skip="1">{VIEWER_TZ}</span>
                    {owner.tz && owner.tz !== VIEWER_TZ && (
                      <> — which is <span data-ay-skip="1">{clockOnly(picked, owner.tz)}</span> for{" "}
                        <span data-ay-skip="1">{owner.name}</span> in <span data-ay-skip="1">{owner.tz}</span></>
                    )}
                  </p>

                  <Field className="mt-4" label="What is it about?" optional
                    hint="They will see this with the invitation. A line is plenty">
                    <Textarea rows={3} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)}
                      placeholder="A sentence about what you’d like to talk about" />
                  </Field>

                  {takeErr && <div className="mt-3"><ErrorNote>{takeErr}</ErrorNote></div>}

                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    {/* A plain element rather than <Button>: this is the one control the page has to
                        be able to FOCUS on the way back from signing in, and Button owns its own ref. */}
                    <button ref={confirmBtn} type="button" onClick={() => void take()} disabled={busy}
                      className="inline-flex h-11 items-center justify-center rounded-pill bg-yang px-6 text-[14px] font-bold text-on-accent shadow-card transition-colors hover:bg-yin hover:text-white disabled:cursor-not-allowed disabled:opacity-50">
                      {busy ? "Asking…" : isLoggedIn() ? "Book this time" : "Sign in and book this time"}
                    </button>
                    <button type="button" onClick={() => setPicked(0)}
                      className="inline-flex h-11 items-center px-2 text-[13.5px] font-semibold text-ink-3 hover:text-ink">
                      Choose another
                    </button>
                  </div>
                  {!isLoggedIn() && (
                    <p className="mt-2 text-[12.5px] text-ink-3">
                      You’ll be brought straight back to this time
                    </p>
                  )}
                </section>
              )}
            </>
          )}
        </>
      )}
    </div>
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
  const [fromMin, setFromMin] = useState(Number(rule.from_min) || 540);
  const [toMin, setToMin] = useState(Number(rule.to_min) || 1020);
  const [buffer, setBuffer] = useState(Number(rule.buffer_min) || 0);
  const [notice, setNotice] = useState(Number(rule.notice_h) || 4);
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
            <Select value={tz} onChange={setTz} options={ZONES} />
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
            single commonest way to offer the wrong hours is to type them into the wrong zone. */}
        <p className="rounded-card border border-line bg-space-1/40 px-4 py-3 text-[13px] leading-relaxed text-ink-2">
          Anyone with your link can book <span data-ay-skip="1">{durationLabel(minutes)}</span> with you,{" "}
          <span data-ay-skip="1">{daysLabel(days).toLowerCase()}</span>, between{" "}
          <span data-ay-skip="1">{minuteClock(fromMin)}</span> and <span data-ay-skip="1">{minuteClock(toMin)}</span> in{" "}
          <span data-ay-skip="1">{tz}</span>
          {local && <> — which is <span data-ay-skip="1">{local}</span> on the clock you are reading this on</>}
        </p>

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

function RuleCard({ rule, onEdit, onOff, busy }: { rule: BookRule; onEdit: () => void; onOff: () => void; busy: boolean }) {
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
          <dd className="text-ink-2" data-ay-skip="1">{durationLabel(rule.minutes)}</dd></div>
        <div className="flex gap-2"><dt className="text-ink-3">Days</dt>
          <dd className="text-ink-2" data-ay-skip="1">{daysLabel(rule.days)}</dd></div>
        <div className="flex gap-2"><dt className="text-ink-3">Hours</dt>
          <dd className="text-ink-2" data-ay-skip="1">{hoursLabel(rule)} · {rule.tz}</dd></div>
        <div className="flex gap-2"><dt className="text-ink-3">Notice</dt>
          <dd className="text-ink-2" data-ay-skip="1">{noticeLabel(Number(rule.notice_h) || 0)}</dd></div>
        <div className="flex gap-2"><dt className="text-ink-3">Ahead</dt>
          <dd className="text-ink-2" data-ay-skip="1">{Number(rule.horizon_d) || 21} days</dd></div>
        {local && (
          <div className="flex gap-2"><dt className="text-ink-3">Your clock</dt>
            <dd className="text-ink-2" data-ay-skip="1">{local}</dd></div>
        )}
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={onEdit} className="h-10">Edit</Button>
        {!off && (
          <button type="button" onClick={onOff} disabled={busy}
            className="inline-flex h-10 items-center rounded-pill border border-line px-4 text-[13px] font-semibold text-ink-3 transition-colors hover:border-yin-light hover:text-ink disabled:opacity-50">
            Stop offering it
          </button>
        )}
      </div>
    </article>
  );
}

function ShareCard({ handle }: { handle: string }) {
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState("");
  const url = typeof window === "undefined" ? "" : `${window.location.origin}/book/${handle}`;

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
  const [editing, setEditing] = useState<BookRule | null>(null);
  const [busyId, setBusyId] = useState(0);

  const load = useCallback(() => {
    setFailed(false);
    bookRules()
      .then((r) => { setItems(r.items || []); if (r.handle) setHandle(r.handle); })
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
              <button type="button" className="font-semibold underline" onClick={load}>Try again</button>
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
              onEdit={() => setEditing(r)} onOff={() => void stopOffering(r)} />
          ))}

          {items !== null && items.length > 0 && !editing && (
            <div>
              <Button variant="outline" onClick={() => setEditing(BLANK)} className="h-11">Offer another kind of meeting</Button>
            </div>
          )}
        </main>

        <aside className="flex w-full flex-col gap-3 md:order-2 md:w-[300px] md:shrink-0 lg:w-[330px]"
          aria-label="Your link and how booking works">
          {handle ? <ShareCard handle={handle} /> : null}
          <HowPanel />
        </aside>
      </div>
    </div>
  );
}

/* ───────────────────────── the route ───────────────────────── */

export default function Book() {
  const { handle } = useParams();
  return handle ? <VisitorPage key={handle} handle={handle} /> : <OwnerPage />;
}
