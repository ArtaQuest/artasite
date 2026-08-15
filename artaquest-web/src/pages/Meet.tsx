import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ApiError,
  meetCalRotate, meetEmailPrefs, meetCancel, meetCreate, meetGet, meetInvite, meetList, meetLobby,
  meetRetime, meetRetimeRespond,
  meetNow, meetOpen, meetRsvp, meetSeat, meetUninvite, meetUpdate, roomsCall,
  type Meet as MeetRow, type MeetCal, type MeetGuest, type MeetLobby, type MeetRsvp,
} from "../lib/api";
import { isLoggedIn, localePath } from "../lib/wp";
import { bootChat, getChatState, subscribeChat } from "../lib/chat-store";
import { distributeRoomKey, roomKey } from "../lib/rooms";
import { shouldAnchor } from "../lib/anchor";
import { RoomThread } from "../components/chat/RoomThread";
import { RoomCall } from "../components/chat/RoomCall";
import { CallModeChoice } from "../components/chat/CallPanel";
import { CALL_MODES, callModePref, deviceSuggestedMode, rememberCallMode } from "../components/chat/callmode";
import type { CallMode } from "../lib/webrtc";
import {
  Avatar, Button, EmptyState, ErrorNote, Field, Input, LoadMoreButton, PageHero,
  Pill, Segmented, Select, SignInGate, StatusNote, Textarea, Toolbar,
} from "../components/ui";

/**
 * ArtaMeet — meetings you can actually put in a calendar, held in a room nobody can listen to.
 *
 * A meeting is a PROMISE about a future time (aq_meets). The end-to-end encrypted ArtaRooms room
 * that carries it is bound fifteen minutes before it starts and thrown away afterwards, which is
 * why an invitation issued a week ago still works on a laptop bought yesterday: the room is never
 * older than the meeting, so there is always a live key-holder to hand the key on.
 *
 * ⚠️ THIS PAGE RUNS THE KEY-DISTRIBUTION LOOP, and that is not a duplicate of anything RoomThread
 * does. RoomThread calls distributeRoomKey exactly ONCE per tab, inside its "I have no key yet"
 * branch, and once more only for an invite issued from that same tab. Neither is a continuing loop.
 * A guest who arrives ten minutes late, or who clears their site data and registers a fresh device
 * key mid-meeting, is sealed to by THIS page's lobby tick — every tick, from every present
 * key-holder. Delete the repeat calls below and late arrivals silently never get in.
 *
 * ⚠️ `data-ay-skip="1"` on the wrappers around the title, the agenda and every member name. Not for
 * secrecy — those are public rows at /data/ — but because the i18n mesh walks document.body and
 * PERSISTS what it finds into aq_translations, republishing a host's wording onto a second public
 * surface they never chose. Mark wrappers, never leaves.
 */

/** Before the join window there is nothing to race for; inside it, five seconds is the difference
 *  between "we're all here" and everyone reloading the page. */
const CALM_POLL_MS = 30000;
const LIVE_POLL_MS = 5000;
const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480];

const VIEWER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
})();

/** Every IANA zone the browser knows, for the host who is scheduling into somebody else's morning.
 *  Falls back to the two zones we can always name when the engine has no list. */
const ZONES: string[] = (() => {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    const list = f ? f("timeZone") : [];
    if (list.length) return list.includes(VIEWER_TZ) ? list : [VIEWER_TZ, ...list];
  } catch { /* an engine without the list is not a reason to refuse to schedule */ }
  return Array.from(new Set([VIEWER_TZ, "UTC"]));
})();

/* ───────────────────────── time ─────────────────────────
   start_ts is a UTC instant and is the only thing that decides when a meeting is. It is ALWAYS
   rendered in the viewer's own zone with the zone named, because a time shown in the wrong zone is
   worse than no time at all — and the zone is named because "16:00" with no zone is exactly that
   mistake wearing a disguise. `dateStyle`/`timeStyle` cannot be combined with `timeZoneName` (it
   throws), so these spell the components out. */

function fmt(ts: number, opts: Intl.DateTimeFormatOptions, tz?: string): string {
  const d = new Date(Number(ts) * 1000);
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { ...opts, ...(tz ? { timeZone: tz } : {}) }).format(d);
}

const longWhen = (ts: number, tz?: string) => fmt(ts, {
  weekday: "long", day: "numeric", month: "long", year: "numeric",
  hour: "2-digit", minute: "2-digit", timeZoneName: "short",
}, tz);

const shortWhen = (ts: number) => fmt(ts, {
  weekday: "short", day: "numeric", month: "short",
  hour: "2-digit", minute: "2-digit", timeZoneName: "short",
});

const clockOnly = (ts: number, tz?: string) => fmt(ts, { hour: "2-digit", minute: "2-digit" }, tz);

function fmtRelative(ts: number, now: number): string {
  const d = Number(ts) - now;
  const abs = Math.abs(d);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60) return rtf.format(Math.round(d), "second");
  if (abs < 3600) return rtf.format(Math.round(d / 60), "minute");
  if (abs < 172800) return rtf.format(Math.round(d / 3600), "hour");
  return rtf.format(Math.round(d / 86400), "day");
}

/** The zone's offset, in seconds, at one instant — read back out of the formatter rather than
 *  guessed, because that is the only source that knows about DST. */
function zoneOffsetSec(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const p: Record<string, number> = {};
  for (const x of parts) if (x.type !== "literal") p[x.type] = Number(x.value);
  const asIfUtc = Date.UTC(p.year, (p.month || 1) - 1, p.day || 1, (p.hour || 0) % 24, p.minute || 0, p.second || 0);
  return (asIfUtc - utcMs) / 1000;
}

/** A wall-clock date + time IN `tz` → the UTC instant it names. Two passes: the offset near a DST
 *  step is not the offset at the first guess, and an hour's error there is a meeting nobody attends. */
function zonedToTs(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  if (!y || !mo || !d) return 0;
  const guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0);
  let ms = guess - zoneOffsetSec(guess, tz) * 1000;
  ms = guess - zoneOffsetSec(ms, tz) * 1000;
  return Math.round(ms / 1000);
}

/** The reverse, for filling the retime form with what the host originally chose. */
function tsToZoned(ts: number, tz: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(Number(ts) * 1000));
  const p: Record<string, string> = {};
  for (const x of parts) if (x.type !== "literal") p[x.type] = x.value;
  const hour = p.hour === "24" ? "00" : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}` };
}

const minutesOf = (m: MeetRow) => Math.max(15, Math.round((Number(m.end_ts) - Number(m.start_ts)) / 60));

function durationLabel(m: number): string {
  if (m < 60) return `${m} minutes`;
  if (m === 60) return "1 hour";
  const h = Math.round(m / 6) / 10;
  return `${h} hours`;
}

function errText(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

/** The one-event download. The signature in a calendar URL covers the MEMBER, not the meeting, so
 *  naming a meeting inside their own subscription URL is the same authorisation narrowed — not a
 *  second secret, and not something the page has to be trusted with. */
function oneEventIcs(subscription: string, id: number): string {
  if (!subscription) return "";
  return subscription + (subscription.includes("?") ? "&" : "?") + "m=" + id;
}

/* ───────────────────────── shared bits ───────────────────────── */

/** The server derives `phase` from the timestamps on every read; trust that over anything computed
 *  here, so one meeting never reads as two different things on two surfaces. */
function StatusPill({ meet }: { meet: MeetRow }) {
  if (meet.phase === "cancelled") return <Pill className="bg-veil/10 text-ink-3">Cancelled</Pill>;
  if (meet.phase === "ended") return <Pill className="bg-veil/10 text-ink-3">Ended</Pill>;
  if (meet.phase === "live") return <Pill>Happening now</Pill>;
  if (meet.phase === "open") return <Pill>Open now</Pill>;
  return <Pill className="bg-veil/10 text-ink-2">Scheduled</Pill>;
}

/** The host chose the time somewhere; say where, but only when it is somewhere else. */
function HostZoneLine({ meet }: { meet: MeetRow }) {
  if (!meet.tz || meet.tz === VIEWER_TZ) return null;
  return (
    <p className="text-[12.5px] text-ink-3">
      {clockOnly(meet.start_ts, meet.tz)} in the host’s time {/* data-ay-skip: a formatted date is machine output, and the i18n mesh persists every
            reachable string into the PUBLIC aq_translations table — one new row per meeting,
            forever, and the date itself machine-translated in place. */}
            <span data-ay-skip="1">({meet.tz})</span>
    </p>
  );
}

const RSVP_LABEL: Record<Exclude<MeetRsvp, "none">, string> = { yes: "Going", maybe: "Maybe", no: "Can’t make it" };

function RsvpControl({ mine, busy, onPick }: { mine: MeetRsvp; busy: boolean; onPick: (r: "yes" | "no" | "maybe") => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-semibold text-ink-2">Are you coming?</span>
      <div className="flex flex-wrap gap-1.5">
        {(["yes", "maybe", "no"] as const).map((r) => (
          <button key={r} type="button" disabled={busy} onClick={() => onPick(r)} aria-pressed={mine === r}
            className={`h-9 rounded-pill border px-3.5 text-[13px] font-semibold transition-colors disabled:opacity-50 ${
              mine === r ? "border-yin bg-yin/15 text-yang" : "border-line text-ink-2 hover:border-yin-light hover:text-ink"}`}>
            {RSVP_LABEL[r]}
          </button>
        ))}
      </div>
    </div>
  );
}

function GuestList({ guests, seats, hostId, isHost, bound, busy, onRemove }: {
  guests: MeetGuest[]; seats: number; hostId: number; isHost: boolean; bound: boolean; busy: boolean;
  onRemove?: (uid: number) => void;
}) {
  /** Once a room is bound, "who replied yes" stops being the interesting fact and "who can open
   *  the room" starts being it — including the one state that looks like nothing at all from the
   *  outside: invited, willing, and with no device key for anyone to seal to. */
  const standing = (g: MeetGuest): string => {
    if (g.id === hostId) return "Host";
    if (bound && g.holds_key) return "In the room";
    if (bound && !g.has_device) return "No device key yet";
    return g.rsvp === "none" ? "No reply yet" : RSVP_LABEL[g.rsvp];
  };
  return (
    <section className="rounded-card border border-line bg-space-2 p-4" aria-label="Who is invited">
      <h2 className="text-[14px] font-semibold text-ink">
        Invited <span className="font-normal text-ink-3">· {guests.length} of {seats}</span>
      </h2>
      <ul className="mt-3 flex flex-col gap-2">
        {guests.map((g) => (
          <li key={g.id} className="flex items-center gap-2.5">
            <span data-ay-skip="1" className="flex min-w-0 flex-1 items-center gap-2.5">
              <Avatar src={g.avatar} name={g.name} className="h-8 w-8 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-ink">{g.name}</span>
                <span className="block truncate text-[11.5px] text-ink-3">{standing(g)}</span>
              </span>
            </span>
            {isHost && g.id !== hostId && onRemove && (
              <button type="button" disabled={busy} onClick={() => onRemove(g.id)}
                className="shrink-0 rounded-pill border border-line px-2.5 py-1 text-[12px] font-semibold text-ink-3 hover:border-yin-light hover:text-ink disabled:opacity-50">
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {isHost && (
        <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
          Removing someone takes them off the guest list and out of the room. It is not a lock changed behind them —
          anyone ever handed this room’s key can still read what was said in it, which is one call and no more
        </p>
      )}
    </section>
  );
}

function PrivacyNote() {
  return (
    <p className="rounded-card border border-line bg-space-2 p-4 text-[12.5px] leading-relaxed text-ink-3">
      Meet holds five people on a call. There’s no server in the middle, so nothing is recorded and nobody,
      including ArtaQuest, can listen in.
    </p>
  );
}

/** The subscription panel. The URL is a signature over the member, not a stored token — resetting it
 *  is the only revocation there is, so the control says exactly what it costs. */
function CalendarPanel({ cal, onRotate }: { cal: MeetCal | null; onRotate: (c: MeetCal) => void }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

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

  async function rotate() {
    setBusy(true);
    try {
      const r = await meetCalRotate();
      onRotate({ ics: r.ics, webcal: r.webcal, rev: r.rev });
      setConfirming(false);
      setNote("Done — add the new address anywhere you still want these meetings.");
    } catch (e) {
      setNote(errText(e, "Couldn’t reset the address — try again."));
    }
    setBusy(false);
  }

  return (
    <section className="rounded-card border border-line bg-space-2 p-4" aria-label="Calendar subscription">
      <h2 className="text-[14px] font-semibold text-ink">Add Meet to your calendar</h2>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">
        Every meeting you’re invited to, kept up to date — retimed, cancelled and all
      </p>
      {!cal ? (
        <StatusNote className="py-6">Fetching your calendar address…</StatusNote>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href={cal.webcal} className="inline-flex h-9 items-center rounded-pill bg-yang px-4 text-[13px] font-bold text-on-accent transition-colors hover:bg-yin hover:text-white">
              Subscribe
            </a>
            <button type="button" onClick={() => void copy()}
              className="inline-flex h-9 items-center rounded-pill border border-line px-4 text-[13px] font-semibold text-ink-2 hover:border-yin-light hover:text-ink">
              {copied ? "Copied" : "Copy the address"}
            </button>
          </div>
          <p className="mt-2 break-all text-[11.5px] text-ink-3" data-ay-skip="1">{cal.ics}</p>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
            Apple Calendar and Outlook take the Subscribe button. Google Calendar wants the address pasted into
            Other calendars → From URL
          </p>
          <div className="mt-3 border-t border-line pt-3">
            {confirming ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12.5px] text-ink-2">Every calendar you’ve added this to stops updating.</span>
                <button type="button" disabled={busy} onClick={() => void rotate()}
                  className="h-9 rounded-pill bg-yang px-4 text-[13px] font-bold text-on-accent disabled:opacity-50">
                  Reset it
                </button>
                <button type="button" onClick={() => setConfirming(false)}
                  className="h-9 rounded-pill border border-line px-4 text-[13px] font-semibold text-ink-2">Keep it</button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirming(true)}
                className="text-[12.5px] font-semibold text-ink-3 hover:text-ink">Reset this link</button>
            )}
          </div>
        </>
      )}
      {note && <p className="mt-2 text-[12.5px] text-ink-2">{note}</p>}
      <MeetEmailToggle />
    </section>
  );
}

/**
 * The switch the meeting emails tell people about.
 *
 * Four templates end with "turn off Email me about meetings in your account", and until this existed
 * that sentence pointed at nothing — an instruction a member could follow only by guessing at a REST
 * route. An email that tells you how to stop it, and then cannot, is worse than one that says nothing.
 *
 * It lives beside the calendar subscription because that is the one place on this page already about
 * how meetings reach you when you are not looking at ArtaQuest. On unless turned off: the person who
 * has never opened a settings panel is exactly the one who needs telling that their week just changed.
 */
function MeetEmailToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { meetEmailPrefs().then((r) => setOn(!!r.email_on)).catch(() => setOn(null)); }, []);
  if (on === null) return null;
  return (
    <label className="mt-3 flex cursor-pointer items-start gap-2 border-t border-line pt-3 text-[12.5px] leading-relaxed text-ink-3">
      <input type="checkbox" checked={on} className="mt-0.5 accent-yang"
        onChange={(e) => {
          const next = e.target.checked;
          setOn(next);
          meetEmailPrefs(next).catch(() => setOn(!next)); // put it back if the server disagrees
        }} />
      <span>Email me about my meetings — booked, moved, cancelled, and before they start</span>
    </label>
  );
}

/* ───────────────────────── /meet — my meetings ───────────────────────── */

function NewMeetingForm({ seatsMax, onDone, onClose }: {
  seatsMax: number; onDone: (m: MeetRow, warnings: string[]) => void; onClose: () => void;
}) {
  const [initial] = useState(() => tsToZoned(Math.round(Date.now() / 1000) + 3600, VIEWER_TZ));
  const [title, setTitle] = useState("");
  const [agenda, setAgenda] = useState("");
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [minutes, setMinutes] = useState(60);
  const [tz, setTz] = useState(VIEWER_TZ);
  const [seats, setSeats] = useState(seatsMax);
  const [guest, setGuest] = useState("");
  const [guests, setGuests] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const start = date && time ? zonedToTs(date, time, tz) : 0;
  const seatOptions = Array.from({ length: Math.max(1, seatsMax - 1) }, (_, i) => String(i + 2));

  function addGuest() {
    const h = guest.trim().replace(/^@/, "");
    if (!h) return;
    setGuests((cur) => (cur.includes(h) || cur.length >= seats - 1 ? cur : [...cur, h]));
    setGuest("");
  }

  async function submit() {
    if (busy) return;
    if (!title.trim()) { setErr("Give the meeting a title."); return; }
    if (!start) { setErr("Pick a date and a time."); return; }
    setBusy(true); setErr(null);
    try {
      const r = await meetCreate({
        title: title.trim(), agenda: agenda.trim(), start, minutes, tz, seats,
        ...(guests.length ? { guests } : {}),
      });
      onDone(r.meet, r.warnings || []);
    } catch (e) {
      setErr(errText(e, "Couldn’t schedule that — try again."));
    }
    setBusy(false);
  }

  return (
    <form className="flex flex-col gap-3.5 rounded-card border border-line bg-space-2 p-4"
      onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 className="text-[15px] font-semibold text-ink">New meeting</h2>
      {err && <ErrorNote>{err}</ErrorNote>}

      <Field label="Title" required>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60}
          placeholder="What is this meeting for?" />
      </Field>

      <Field label="Agenda" optional
        hint="The call is encrypted end to end; the agenda is not — we can read it, and it travels in calendar invitations">
        <Textarea value={agenda} onChange={(e) => setAgenda(e.target.value)} rows={3} maxLength={500}
          placeholder="What you want to get through" />
      </Field>
      {/* NOT a policy page. title, agenda, time and the whole guest list are plaintext rows served
          in full at /data/ — so the sentence belongs where the host is typing them. */}
      <p className="-mt-2 text-[12px] leading-relaxed text-ink-3">
        Anyone can see that this meeting exists, when it is, and who is invited. Its title and agenda are
        withheld from the public data explorer, but they are not encrypted the way the call is: we can read
        them, and they travel in calendar invitations. Nobody but the people in it can see or hear what
        happens — the call itself is encrypted end to end
      </p>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Field label="Date" className="flex-1">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Time" className="flex-1">
          <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Field label="Length" className="flex-1">
          <Select value={String(minutes)} onChange={(v) => setMinutes(Number(v))} label="Length"
            options={DURATIONS.map((m) => ({ value: String(m), label: durationLabel(m) }))} />
        </Field>
        <Field label="People" className="flex-1"
          hint="A call with no server in the middle tops out at five">
          <Select value={String(seats)} onChange={(v) => setSeats(Number(v))} label="People"
            options={seatOptions} />
        </Field>
      </div>

      {/* JSX, not a template literal. This was written as a backtick string containing JSX SOURCE, so
          the form rendered the characters `$<span data-ay-skip="1">{longWhen(start)}</span>` at a
          member scheduling a meeting. Field takes a ReactNode, and the skip wrapper is load-bearing:
          a formatted date is a live value the i18n mesh would otherwise persist into the PUBLIC
          translations table. */}
      <Field label="Time zone" hint={start ? <>That is <span data-ay-skip="1">{longWhen(start)}</span> where you are</> : undefined}>
        <Select value={tz} onChange={setTz} label="Time zone" options={ZONES} />
      </Field>

      <Field label="Guests" optional hint="Members, by their @username">
        <div className="flex gap-2">
          <Input value={guest} onChange={(e) => setGuest(e.target.value)} placeholder="@username" className="flex-1"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addGuest(); } }} />
          <button type="button" onClick={addGuest} disabled={!guest.trim() || guests.length >= seats - 1}
            className="h-11 shrink-0 rounded-pill border border-line px-4 text-[13.5px] font-semibold text-ink-2 hover:border-yin-light hover:text-ink disabled:opacity-50">
            Add
          </button>
        </div>
      </Field>
      {guests.length > 0 && (
        <ul className="-mt-1 flex flex-wrap gap-1.5" data-ay-skip="1">
          {guests.map((h) => (
            <li key={h}>
              <button type="button" onClick={() => setGuests((cur) => cur.filter((x) => x !== h))}
                className="inline-flex h-8 items-center gap-1.5 rounded-pill border border-line px-3 text-[12.5px] text-ink-2 hover:border-yin-light hover:text-ink">
                @{h}<span aria-hidden>×</span><span className="sr-only">Remove</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button type="submit" disabled={busy}>{busy ? "Scheduling…" : "Schedule it"}</Button>
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

function MeetingCard({ meet, now, calIcs }: { meet: MeetRow; now: number; calIcs: string }) {
  const ics = oneEventIcs(calIcs, Number(meet.id));
  return (
    <article className="rounded-card border border-line bg-space-2 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <span data-ay-skip="1">
            <Link to={localePath(`/meet/${meet.id}`)}
              className={`block truncate text-[16px] font-semibold text-ink hover:text-yang ${meet.status === "cancelled" ? "line-through" : ""}`}>
              {meet.title}
            </Link>
          </span>
          <p className="mt-1 text-[13px] text-ink-2">
            <span data-ay-skip="1">{shortWhen(meet.start_ts)}</span> – {clockOnly(meet.end_ts)}
          </p>
          <HostZoneLine meet={meet} />
        </div>
        <StatusPill meet={meet} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Link to={localePath(`/meet/${meet.id}`)}
          className="inline-flex h-9 items-center rounded-pill bg-yang px-4 text-[13px] font-bold text-on-accent transition-colors hover:bg-yin hover:text-white">
          {meet.phase === "open" || meet.phase === "live" ? "Join" : "Open"}
        </Link>
        {ics && meet.phase !== "cancelled" && (
          <a href={ics} className="text-[12.5px] font-semibold text-ink-3 hover:text-ink">Add this one to your calendar</a>
        )}
        <span className="text-[12.5px] text-ink-3"><span data-ay-skip="1">{fmtRelative(meet.start_ts, now)}</span></span>
      </div>
    </article>
  );
}

function MeetList() {
  const nav = useNavigate();
  const [scope, setScope] = useState<"upcoming" | "past">("upcoming");
  const [items, setItems] = useState<MeetRow[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [cal, setCal] = useState<MeetCal | null>(null);
  const [seatsMax, setSeatsMax] = useState(5);
  const [composing, setComposing] = useState(false);
  /** The confirmation carries the host's own title and the server's per-guest warnings, so it is
   *  held apart from the sentence around it — those two pieces get the skip marker, the copy does not. */
  const [note, setNote] = useState<{ title: string; warnings: string[] } | null>(null);
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.round(Date.now() / 1000));
  const seq = useRef(0);

  // The relative line ("in 12 minutes") is the only thing on this page that has to keep moving.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Math.round(Date.now() / 1000)), 30000);
    return () => window.clearInterval(t);
  }, []);

  const load = useCallback((cursor?: number) => {
    const mine = ++seq.current;
    if (cursor) setMore(true);
    meetList({ scope, ...(cursor ? { cursor } : {}) })
      .then((p) => {
        if (mine !== seq.current) return;
        setFailed(false);
        setItems((prev) => (cursor && prev ? [...prev, ...p.items] : p.items));
        setNext(p.next);
        setCal(p.cal);
        if (p.seats_max) setSeatsMax(p.seats_max);
      })
      // A FAILED request is not an empty diary. Falling through to the empty state would tell a
      // member with six meetings this week that they have none, on precisely the request that
      // did not come back.
      .catch(() => { if (mine === seq.current && !cursor) { setItems(null); setNext(null); setFailed(true); } })
      .finally(() => { if (mine === seq.current) setMore(false); });
  }, [scope]);

  useEffect(() => { setItems(null); load(); }, [load]);

  /** One press: a meeting that has already started, and straight into it. `starting` is NOT cleared
   *  on the way out — the navigation is the success, and re-enabling the button during it is how a
   *  second press books a second meeting nobody asked for. */
  async function startNow() {
    if (starting) return;
    setStarting(true); setStartErr(null);
    try {
      const r = await meetNow();
      nav(localePath(`/meet/${r.meet.id}`));
    } catch (e) {
      setStarting(false);
      setStartErr(errText(e, "Couldn’t start a meeting just now — try again."));
    }
  }

  if (!isLoggedIn()) {
    // PageHero owns the page's one <h1>, so the gate here is an EmptyState rather than SignInGate —
    // two <h1>s is what ClientNav's route-change focus lands on, and it has to land on one thing.
    return (
      <div className="flex flex-col gap-6 pb-12">
        <div className="mx-auto w-full max-w-[1076px]">
          <PageHero eyebrow="Community" title="Meet"
            lede="Meetings you can put in your calendar, held in a room nobody else can listen to." />
        </div>
        <EmptyState className="mx-auto w-full max-w-[1076px]" title="Sign in to see your meetings"
          body="Your meetings, the people in them and the key that opens the room all belong to your account — there is no link that lets anybody else in."
          action={<Button href="/login/">Sign in</Button>} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 pb-12">
      <div className="mx-auto w-full max-w-[1076px]">
        <PageHero eyebrow="Community" title="Meet"
          lede="Meetings you can put in your calendar, held in a room nobody else can listen to — not even us." />
      </div>

      <div className="mx-auto flex w-full max-w-[1076px] flex-col gap-4 md:flex-row md:items-start lg:gap-7">
        <main className="flex w-full min-w-0 flex-col gap-4 md:max-w-2xl md:flex-1">
          <Toolbar
            filters={
              <Segmented label="Which meetings" value={scope} onChange={(v) => setScope(v as "upcoming" | "past")}
                options={[{ value: "upcoming", label: "Upcoming" }, { value: "past", label: "Past" }]} />
            }
            trailing={!composing && (
              <>
                {/* The loudest control on the page, because it is the shortest path in the product:
                    nothing → a room you are already in. Scheduling is the considered thing next to it. */}
                <Button size="sm" disabled={starting} onClick={() => void startNow()}>
                  {starting ? "Starting…" : "Meet now"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setComposing(true)}>New meeting</Button>
              </>
            )}
          />

          {startErr && <ErrorNote>{startErr}</ErrorNote>}

          {note && (
            <StatusNote className="py-3">
              <span data-ay-skip="1">“{note.title}”</span>{" "}
              {note.warnings.length ? "is scheduled" : "is scheduled — it’s in the list below"}
              {note.warnings.length > 0 && <span data-ay-skip="1">. {note.warnings.join(" ")}</span>}
            </StatusNote>
          )}

          {composing && (
            <NewMeetingForm seatsMax={seatsMax}
              onClose={() => setComposing(false)}
              onDone={(m, warnings) => {
                setComposing(false);
                setNote({ title: m.title, warnings });
                setScope("upcoming");
                load();
              }} />
          )}

          {failed ? (
            <ErrorNote>Couldn’t load your meetings. <button type="button" className="-my-1 inline-block py-1 font-semibold underline" onClick={() => load()}>Try again</button></ErrorNote>
          ) : items === null ? (
            <StatusNote>Loading your meetings…</StatusNote>
          ) : items.length === 0 ? (
            <EmptyState
              title={scope === "upcoming" ? "Nothing scheduled" : "Nothing behind you yet"}
              body={scope === "upcoming"
                ? "Schedule a meeting and everyone invited gets it in their own calendar, in their own time zone."
                : "Meetings you have been part of appear here once they are over."}
              action={scope === "upcoming" && !composing
                ? <Button onClick={() => setComposing(true)}>New meeting</Button>
                : undefined} />
          ) : (
            <>
              <ul className="flex flex-col gap-3">
                {items.map((m) => (
                  <li key={m.id}><MeetingCard meet={m} now={now} calIcs={cal?.ics || ""} /></li>
                ))}
              </ul>
              {next != null && <LoadMoreButton onClick={() => load(next)} loading={more} />}
            </>
          )}
        </main>

        <aside className="flex w-full flex-col gap-3 md:order-2 md:w-[300px] md:shrink-0 lg:w-[330px]"
          aria-label="Calendar and what Meet is">
          <CalendarPanel cal={cal} onRotate={setCal} />
          <PrivacyNote />
        </aside>
      </div>
    </div>
  );
}

/* ───────────────────────── /meet/:id — one meeting ───────────────────────── */

function HostControls({ meet, busy, onInvite, onRetime, onCancel }: {
  meet: MeetRow; busy: boolean;
  onInvite: (handle: string) => void;
  onRetime: (start: number, minutes: number, tz: string) => void;
  onCancel: () => void;
}) {
  const [handle, setHandle] = useState("");
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const from = useMemo(() => tsToZoned(Number(meet.start_ts), meet.tz || VIEWER_TZ), [meet.start_ts, meet.tz]);
  const [date, setDate] = useState(from.date);
  const [time, setTime] = useState(from.time);
  const [minutes, setMinutes] = useState(minutesOf(meet));
  const tz = meet.tz || VIEWER_TZ;

  return (
    <section className="rounded-card border border-line bg-space-2 p-4" aria-label="Host controls">
      <h2 className="text-[14px] font-semibold text-ink">You’re hosting</h2>

      <div className="mt-3 flex gap-2">
        <Input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@username" className="flex-1"
          aria-label="Invite a member by username"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onInvite(handle); setHandle(""); } }} />
        <button type="button" disabled={busy || !handle.trim()} onClick={() => { onInvite(handle); setHandle(""); }}
          className="h-11 shrink-0 rounded-pill bg-yang px-4 text-[13.5px] font-bold text-on-accent disabled:opacity-50">
          Invite
        </button>
      </div>

      <div className="mt-3 border-t border-line pt-3">
        {/* Refill from the meeting each time the panel opens. Initialising the fields once meant
            that after a successful retime the form still showed the OLD time, and a second edit
            would quietly move the meeting back to it. */}
        <button type="button" aria-expanded={open}
          onClick={() => setOpen((o) => {
            if (!o) { setDate(from.date); setTime(from.time); setMinutes(minutesOf(meet)); }
            return !o;
          })}
          className="text-[12.5px] font-semibold text-ink-3 hover:text-ink">
          {open ? "Keep the time" : "Change the time"}
        </button>
        {open && (
          <div className="mt-2.5 flex flex-col gap-2.5">
            <div className="flex flex-col gap-2.5 sm:flex-row">
              <Field label="Date" className="flex-1"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
              <Field label="Time" className="flex-1"><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
            </div>
            <Field label="Length"
              hint={`Chosen in ${tz}. Everyone sees it in their own time zone`}>
              <Select value={String(minutes)} onChange={(v) => setMinutes(Number(v))} label="Length"
                options={DURATIONS.map((m) => ({ value: String(m), label: durationLabel(m) }))} />
            </Field>
            <div>
              <button type="button" disabled={busy || !date || !time}
                onClick={() => onRetime(zonedToTs(date, time, tz), minutes, tz)}
                className="h-9 rounded-pill bg-yang px-4 text-[13px] font-bold text-on-accent disabled:opacity-50">
                Move the meeting
              </button>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
                Everyone invited is told, and every calendar subscribed to it updates in place
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 border-t border-line pt-3">
        {confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] text-ink-2">Everyone invited is told, and it shows as cancelled in their calendar.</span>
            <button type="button" disabled={busy} onClick={onCancel}
              className="h-9 rounded-pill bg-yang px-4 text-[13px] font-bold text-on-accent disabled:opacity-50">Cancel it</button>
            <button type="button" onClick={() => setConfirming(false)}
              className="h-9 rounded-pill border border-line px-4 text-[13px] font-semibold text-ink-2">Keep it</button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirming(true)}
            className="text-[12.5px] font-semibold text-ink-3 hover:text-ink">Cancel this meeting</button>
        )}
      </div>
    </section>
  );
}

/**
 * HOW YOU WILL JOIN — the choice, before the door.
 *
 * Somebody on a train who knows their connection is poor should be able to say so DELIBERATELY,
 * and arrive with sound only; somebody who has never thought about it should never be asked. So
 * this is one sentence and a link, not a form: the default comes from the device and the link
 * itself (lib/webrtc's suggestedMode, via callModePref), and the choice is remembered per device
 * because it is a fact about someone's morning rather than about this meeting.
 *
 * It writes the preference rather than passing it down: the call surface is mounted later, by
 * RoomThread, from a completely different branch of this page, and RoomCall reads the same
 * preference on the way in. One value, two surfaces, no prop threaded through a component that
 * has nothing to do with cameras.
 */
function JoinAs() {
  const [mode, setMode] = useState<CallMode>(callModePref);
  const [suggested] = useState(deviceSuggestedMode);
  const [open, setOpen] = useState(false);
  const chosen = CALL_MODES.find((m) => m.value === mode);
  return (
    <div className="mt-4 border-t border-line pt-3 text-start">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-[12.5px] text-ink-2">
          You’ll join with <span className="font-semibold text-ink">{chosen?.label}</span>
        </p>
        {/* 40px of height even though it reads as a link: it is the one control on this panel a
            member on a phone actually has to hit. */}
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          className="inline-flex h-10 items-center text-[12.5px] font-semibold text-ink-3 underline underline-offset-2 hover:text-ink">
          {open ? "Keep it" : "Change"}
        </button>
      </div>
      {!open && chosen && <p className="mt-1 text-[12px] leading-relaxed text-ink-3">{chosen.blurb}</p>}
      {open && (
        <div className="mt-2.5">
          <CallModeChoice value={mode} suggested={suggested}
            onChange={(m) => { setMode(m); rememberCallMode(m); setOpen(false); }} />
          <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
            A call with no server in it means everyone sends their own camera to everyone else, so on a
            small connection the picture is what has to give — never the voice. You can change this during
            the meeting
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The join panel — the whole point of the page.
 *
 * It never mounts the call surface without a key. A member who joins the roster with no key opens
 * their camera and is invisible to everyone else, because every signalling send returns early
 * without one: the failure looks exactly like a broken meeting and says nothing. So each keyless
 * state below names what is actually happening and who can fix it.
 */
function JoinPanel({ lobby, busy, now, opening, onOpen, guests }: {
  lobby: MeetLobby; guests: MeetGuest[]; busy: boolean; now: number; opening: boolean; onOpen: () => void;
}) {
  // WHAT bootChat MADE OF THIS BROWSER. It has three outcomes that publish NO device key — one
  // needs the member's recovery code, two are hard failures — and all three are reported only on
  // /messages/. Ignoring them left a member reading "Handing your device the key…" for the length of
  // the meeting, about a key that was never coming, while this page advertised them to everyone else
  // as somebody to seal to.
  const [chatState, setChatState] = useState(getChatState);
  useEffect(() => subscribeChat(() => setChatState(getChatState())), []);
  const { meet, phase } = lobby;
  // Never name MYSELF as the person I am waiting for. The server computes holders from the seals it
  // can see; this device's own view of whether it holds the key is the one that decided we are here.
  const holders = lobby.holders.filter((u) => u !== lobby.me);
  const present = lobby.present_holders.filter((u) => u !== lobby.me);
  const nameOf = (uid: number) => guests.find((g) => g.id === uid)?.name || "Another guest";

  if (phase === "cancelled") {
    return (
      <div className="rounded-card border border-line bg-space-2 p-5">
        <p className="text-[15px] font-semibold text-ink">This meeting was cancelled</p>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
          It stays here, and in the calendars subscribed to it, so nobody turns up to it by mistake
        </p>
      </div>
    );
  }

  if (phase === "ended") {
    return (
      <div className="rounded-card border border-line bg-space-2 p-5">
        <p className="text-[15px] font-semibold text-ink">This meeting is over</p>
        {/* This says the room is gone, and Meetings::tick() now genuinely empties it — Rooms deletes a
            room when its last member leaves. It did NOT, for a while: the sweep unbound the room and
            left it standing, so this paragraph was false. A promise about what happens to people's
            words is not a thing to be approximately right about; the code was changed to match the
            sentence rather than the sentence softened to match the code. */}
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
          The room it was held in was disposable and is gone. Nothing of what was said survives on our side —
          there was never a copy here to keep
        </p>
      </div>
    );
  }

  if (phase === "waiting") {
    return (
      <div className="rounded-card border border-line bg-space-2 p-5">
        <p className="text-[15px] font-semibold text-ink">Opens <span data-ay-skip="1">{fmtRelative(Number(meet.start_ts) - 900, now)}</span></p>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
          The room is made fifteen minutes before the meeting and thrown away after, so an invitation sent weeks
          ago still works on a laptop you bought yesterday
        </p>
        <JoinAs />
      </div>
    );
  }

  // phase is open or live from here down.
  if (!lobby.room_id) {
    return (
      <div className="rounded-card border border-line bg-space-2 p-5 text-center">
        <p className="text-[15px] font-semibold text-ink">Ready when you are</p>
        <p className="mx-auto mt-1.5 max-w-sm text-[13.5px] leading-relaxed text-ink-2">
          Whoever opens it first makes the room and its key. Everyone else is handed the key as they arrive
        </p>
        <Button className="mt-4 h-12 px-7 text-[15px]" disabled={busy || opening || !lobby.can_open} onClick={onOpen}>
          {opening ? "Opening…" : "Open the meeting"}
        </Button>
        <JoinAs />
      </div>
    );
  }

  // Nothing below can happen without a device key, and these two states mean this browser has none.
  // Say so where the member is, rather than letting them wait for something that is not coming.
  if (chatState.fatal) {
    return (
      <div className="rounded-card border border-line bg-space-2 p-5">
        <p className="text-[15px] font-semibold text-ink">This browser can’t hold the key</p>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2" data-ay-skip="1">{chatState.fatal}</p>
      </div>
    );
  }
  if (chatState.recovery === "restore") {
    return (
      <div className="rounded-card border border-line bg-space-2 p-5">
        <p className="text-[15px] font-semibold text-ink">Enter your recovery code first</p>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
          Your conversations are sealed to a key this browser doesn’t have yet, so nobody can hand it this
          meeting’s key either. Restore it once and both work here.
        </p>
        <a href={localePath("/messages/")}
          className="mt-3 inline-flex h-10 items-center rounded-pill bg-yang px-4 text-[13px] font-bold text-on-accent hover:opacity-90">
          Restore this device
        </a>
      </div>
    );
  }

  if (present.length) {
    return (
      <div className="rounded-card border border-line bg-space-2 p-5">
        <p className="text-[15px] font-semibold text-ink">Handing your device the key…</p>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
          <span data-ay-skip="1">{nameOf(present[0])}</span> is in the room and their browser is sealing the key to
          this device. It takes a few seconds, and it is the only way in — we don’t hold a copy to give you
        </p>
        <JoinAs />
      </div>
    );
  }

  if (holders.length) {
    return (
      <div className="rounded-card border border-line bg-space-2 p-5">
        <p className="text-[15px] font-semibold text-ink">Waiting for someone who can open the room</p>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
          <span data-ay-skip="1">{nameOf(holders[0])}</span> holds this room’s key but isn’t here right now. The
          moment they open this page, your device is sealed in — nothing here can hand it over on their behalf
        </p>
        <JoinAs />
      </div>
    );
  }

  return (
    <div className="rounded-card border border-line bg-space-2 p-5">
      <p className="text-[15px] font-semibold text-ink">Nobody here holds this room’s key yet</p>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
        The room is open but its key hasn’t reached anyone who is here. Stay on this page — the first key-holder
        to arrive seals it to you automatically
      </p>
      <JoinAs />
    </div>
  );
}

function MeetingPage({ id }: { id: number }) {
  const nav = useNavigate();
  const [meet, setMeet] = useState<MeetRow | null>(null);
  const [guests, setGuests] = useState<MeetGuest[]>([]);
  const [cal, setCal] = useState<MeetCal | null>(null);
  const [me, setMe] = useState(0);
  const [lobby, setLobby] = useState<MeetLobby | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [gone, setGone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [now, setNow] = useState(() => Math.round(Date.now() / 1000));
  const joinedRoom = useRef(0);
  /** Poll ticks, so a non-anchor still seals occasionally — see the distribution loop. */
  const ticks = useRef(0);
  /** The poll's own tick, so an action can pull the next one forward instead of waiting out the
   *  interval — opening a meeting and then watching a spinner for five seconds reads as broken. */
  const tickNow = useRef<() => void>(() => {});

  /**
   * REGISTER THIS DEVICE'S KEY FIRST.
   *
   * lib/rooms only ever loads an identity; it is bootChat that PUBLISHES the public half into
   * aq_chat_keys. Without that row the server cannot list this device as needing the room key,
   * nobody can seal to it, and the meeting fails silently for exactly one person. It is also the
   * onboarding path: a member who has never opened ArtaChat gets a device key by opening a meeting.
   */
  useEffect(() => { void bootChat(); }, []);

  // "Starts in 12 minutes" has to keep counting, and the join window opens on a clock rather than
  // on a response — so the page's idea of now cannot come only from the poll.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Math.round(Date.now() / 1000)), 15000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    let stop = false;
    setLoading(true); setGone(false); setMeet(null); setLobby(null); setHasKey(false);
    joinedRoom.current = 0;
    meetGet(id)
      .then((r) => {
        if (stop) return;
        setMeet(r.meet); setGuests(r.guests); setMe(r.me); setCal(r.cal);
      })
      .catch((e) => {
        if (stop) return;
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) setGone(true);
        else setErr("Couldn’t load this meeting.");
      })
      .finally(() => { if (!stop) setLoading(false); });
    return () => { stop = true; };
  }, [id]);

  useEffect(() => {
    let stop = false, dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;

    async function tick() {
      ticks.current += 1;
      if (inFlight || dead) return;
      inFlight = true;
      timer = undefined;
      let wait = CALM_POLL_MS;
      try {
        const L = await meetLobby(id);
        if (stop) return;
        setLobby(L);
        setMeet(L.meet);
        setGuests(L.guests);
        if (L.me) setMe(L.me);
        setNote(null);
        // The window opens on a clock, not on a response — so the last couple of minutes before it
        // poll at the live cadence too, or a member sits on "Opens in a moment" for half a minute
        // after it already has.
        const toOpen = Number(L.meet.start_ts) - 900 - Math.round(Date.now() / 1000);
        wait = L.phase === "open" || L.phase === "live" || (L.phase === "waiting" && toOpen < 120)
          ? LIVE_POLL_MS : CALM_POLL_MS;

        /* ── THE DISTRIBUTION LOOP ──────────────────────────────────────────────────────────
           Every tick, from every present key-holder, in this order. roomKey() caches per room for
           the tab's lifetime and distributeRoomKey() reads that same module cache, so the repeat
           calls cost one request and no crypto — and they are what seals the key to a guest who
           arrives late, or who cleared their site data and registered a new device key ten minutes
           into the meeting. RoomThread fires distributeRoomKey ONCE per tab; that is not a loop and
           this does not rely on it. Do not "de-duplicate" these away. */
        if (!L.room) {
          setHasKey(false);
        } else {
          const k = await roomKey(L.room, L.me);
          if (stop) return;
          setHasKey(!!k);
          if (k) {
            if (L.unseated.length) await meetSeat(id).catch(() => undefined);
            // PREFER THE ANCHOR, NEVER DEPEND ON IT. Every key-holder used to seal on every tick,
            // which is what heals a guest who arrives late or re-registers mid-meeting — so this
            // does not gate on the election, it DEFERS to it: the steadiest link keeps doing it
            // every tick, everyone else drops to roughly one in four. The healing property is
            // untouched (a newcomer still waits at most a few ticks even if the anchor has gone
            // silent), and the redundant sealing that used to scale with the size of the room does
            // not. Do not turn this into a hard gate — an election that has not resolved must never
            // mean nobody lets anybody in.
            if (shouldAnchor(L.room.id, L.me) || ticks.current % 4 === 0) {
              await distributeRoomKey(L.room, L.me);
            }
          }
        }
      } catch (e) {
        if (stop) return;
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) { dead = true; setGone(true); }
        else setNote("Couldn’t reach the meeting — retrying.");
      } finally {
        inFlight = false;
      }
      if (!stop && !dead && !timer && !document.hidden) timer = setTimeout(() => void tick(), wait);
    }

    tickNow.current = () => { if (!inFlight) void tick(); };
    void tick();
    const onVis = () => { if (!document.hidden && !timer && !inFlight) void tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop = true;
      clearTimeout(timer);
      tickNow.current = () => {};
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [id]);

  // Being in the room and being on the call are two different rosters. Join once per bound room —
  // once only, so leaving the call does not immediately put you back in it.
  const roomId = Number(lobby?.room_id || 0);
  useEffect(() => {
    if (!roomId || !hasKey || joinedRoom.current === roomId) return;
    joinedRoom.current = roomId;
    void roomsCall(roomId, "join").catch(() => undefined);
  }, [roomId, hasKey]);

  const isHost = !!meet && Number(meet.host_id) === me && me > 0;
  const myRsvp: MeetRsvp = guests.find((g) => g.id === me)?.rsvp || "none";
  const live = roomId > 0 && hasKey && me > 0;

  async function act(job: () => Promise<void>, fallback: string) {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await job(); } catch (e) { setErr(errText(e, fallback)); }
    setBusy(false);
  }

  const doRsvp = (reply: "yes" | "no" | "maybe") => act(async () => {
    const r = await meetRsvp(id, reply);
    setMeet(r.meet); setGuests(r.guests);
  }, "Couldn’t save that reply — try again.");

  const doInvite = (handle: string) => {
    const h = handle.trim().replace(/^@/, "");
    if (!h) return;
    void act(async () => {
      // invite answers with the uid it resolved, not a guest list — the poll is what redraws the
      // list, and pulling its next tick forward is cheaper than a second round trip here.
      await meetInvite(id, h);
      tickNow.current();
    }, "Couldn’t invite that member.");
  };

  const doUninvite = (uid: number) => act(async () => {
    const r = await meetUninvite(id, uid);
    if (r.guests) setGuests(r.guests); else setGuests((cur) => cur.filter((g) => g.id !== uid));
  }, "Couldn’t remove that guest.");

  const doRetime = (start: number, minutes: number, tz: string) => act(async () => {
    if (!start) throw new Error("Pick a date and a time.");
    const r = await meetUpdate({ id, start, minutes, tz });
    setMeet(r.meet);
    tickNow.current();
  }, "Couldn’t move the meeting.");

  const [confirmDrop, setConfirmDrop] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [askAt, setAskAt] = useState("");
  const doAsk = () => act(async () => {
    const t = Math.round(new Date(askAt).getTime() / 1000);
    if (!t) return;
    const r = await meetRetime(id, t);
    setMeet(r.meet); setAskOpen(false); setAskAt("");
    tickNow.current();
  }, "Couldn’t send that suggestion.");
  const doAnswerAsk = (accept: boolean) => act(async () => {
    const r = await meetRetimeRespond(id, accept);
    setMeet(r.meet);
    tickNow.current();
  }, "Couldn’t answer that suggestion.");

  const doCancel = () => act(async () => {
    const r = await meetCancel(id);
    setMeet(r.meet);
    tickNow.current();
  }, "Couldn’t cancel the meeting.");

  async function doOpen() {
    if (opening) return;
    setOpening(true); setErr(null);
    try {
      await meetOpen(id);
      // mint or not, the next tick is what calls roomKey() — pull it forward rather than making the
      // member watch a button they already pressed.
      tickNow.current();
    } catch (e) {
      setErr(errText(e, "Couldn’t open the meeting — try again."));
    }
    setOpening(false);
  }

  if (!isLoggedIn()) {
    return (
      <div className="mx-auto w-full max-w-[1076px] pb-12">
        <SignInGate title="Sign in to open this meeting"
          body="A meeting is opened by your account and your device — there is no link that lets anybody else in." />
      </div>
    );
  }

  // Before the meeting itself is on screen, the page still needs its one <h1> — that is what the
  // shell focuses on every route change, and what a screen reader is told it has arrived at.
  if (gone || (!meet && !loading) || (loading && !meet)) {
    return (
      <div className="mx-auto flex w-full max-w-[1076px] flex-col gap-6 pb-12">
        <PageHero eyebrow="Community" title="Meet" />
        {gone ? (
          <EmptyState title="This meeting isn’t open to you"
            body="Either it doesn’t exist or you’re not on its guest list. Ask the host to invite you."
            action={<Button href="/meet/">Your meetings</Button>} />
        ) : loading ? (
          <StatusNote>Opening the meeting…</StatusNote>
        ) : (
          <ErrorNote>{err || "Couldn’t load this meeting."}</ErrorNote>
        )}
      </div>
    );
  }
  if (!meet) return null;

  const minutes = minutesOf(meet);

  return (
    <div className="flex flex-col gap-4 pb-12">
      {/* THE ROW OWNS THE HEIGHT while a call is up: `flex-1` on the thread sets flex-basis 0, which
          beats a height set on the thread itself, so the cap has to live on the container or the
          conversation grows the page instead of scrolling inside it. `items-start` and
          `items-stretch` must never both be in the class list — Tailwind decides which wins by
          stylesheet order, not by the order they are written here. */}
      <div className={`mx-auto flex w-full max-w-[1076px] flex-col gap-4 md:flex-row lg:gap-7 ${
        live ? "md:h-[calc(100dvh-13rem)] md:max-h-[820px] md:min-h-[420px] md:items-stretch" : "md:items-start"}`}>

        <main className="flex w-full min-w-0 flex-col gap-4 md:max-w-2xl md:min-h-0 md:flex-1">
          <header className="flex shrink-0 flex-col gap-2">
            <div className="flex items-start gap-3">
              <span data-ay-skip="1" className="min-w-0 flex-1">
                <h1 className={`text-[clamp(1.35rem,3vw,1.9rem)] font-extrabold leading-tight tracking-tight ${
                  meet.status === "cancelled" ? "line-through" : ""}`}>{meet.title}</h1>
              </span>
              <span className="mt-1 shrink-0"><StatusPill meet={meet} /></span>
            </div>
            <p className="text-[14px] text-ink-2">
              <span data-ay-skip="1">{longWhen(meet.start_ts)}</span> – {clockOnly(meet.end_ts)}
              <span className="text-ink-3"> · {durationLabel(minutes)}</span>
            </p>
            <HostZoneLine meet={meet} />
            {meet.status !== "cancelled" && now < Number(meet.end_ts) && (
              <p className="text-[12.5px] text-ink-3">Starts <span data-ay-skip="1">{fmtRelative(meet.start_ts, now)}</span></p>
            )}
          </header>

          {err && <ErrorNote>{err}</ErrorNote>}
          {note && <StatusNote className="py-2">{note}</StatusNote>}

          {live ? (
            /* Not `compact`: the full form is the one that caps its own height on a phone
               (100dvh − chrome) and hands the sizing to the row on desktop. Compact has neither,
               so the transcript would push the composer off the bottom of a phone screen. */
            <RoomThread managed roomId={roomId} me={me} onLeave={() => nav(localePath("/meet/"))}
              /* NEVER the call surface without a key: without one every offer and answer is dropped
                 before it is sent, so the camera opens and nobody can see or hear you. */
              renderCall={(room, key, meId, leaveCall) => (key && room.in_call.includes(meId)
                ? <RoomCall room={room} roomKey={key} me={meId} onLeft={leaveCall} />
                : null)} />
          ) : lobby ? (
            <JoinPanel lobby={lobby} guests={guests} busy={busy} now={now} opening={opening} onOpen={() => void doOpen()} />
          ) : (
            <StatusNote>Checking the room…</StatusNote>
          )}

          {meet.agenda && !live && (
            <section className="rounded-card border border-line bg-space-2 p-4" aria-label="Agenda">
              <h2 className="text-[14px] font-semibold text-ink">Agenda</h2>
              <p data-ay-skip="1" className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-ink-2">{meet.agenda}</p>
            </section>
          )}
        </main>

        <aside className={`flex w-full flex-col gap-3 md:order-2 md:w-[300px] md:shrink-0 lg:w-[330px] ${
          live ? "md:min-h-0 md:overflow-y-auto" : ""}`} aria-label="Guests and calendar">
          {meet.status !== "cancelled" && me > 0 && !isHost && (
            <div className="rounded-card border border-line bg-space-2 p-4">
              <RsvpControl mine={myRsvp} busy={busy} onPick={(r) => void doRsvp(r)} />
              {/* THE PERSON WHO TOOK THE HOUR CAN GIVE IT BACK. On a booking the OWNER is the host,
                  so the booker had no cancel — and saying "not coming" releases nothing: free/busy
                  filters on status, never on RSVP, so the slot stayed shut for everybody. Only shown
                  for a two-party booking, which is exactly what the server now permits; a booking the
                  owner has invited others into stays theirs to end. */}
              {/* ASK FOR A DIFFERENT TIME. Before this a guest whose week had moved could only keep a
                  slot they could not make or cancel it outright and start again — and on a booking
                  that means giving the hour back to a stranger's queue. Asking is the middle one a
                  person would actually take. It writes a PROPOSAL: the meeting keeps its time and
                  its calendar entry until the host says yes. */}
              {meet.status === "scheduled" && Number(meet.start_ts) > now && (
                <div className="mt-3 border-t border-line pt-3">
                  {Number(meet.retime_ts) > 0 ? (
                    <p className="text-[12.5px] leading-relaxed text-ink-2">
                      You asked for <span className="font-semibold text-ink" data-ay-skip="1">{longWhen(Number(meet.retime_ts), meet.tz)}</span>.
                      {" "}Waiting for <span data-ay-skip="1">{guests.find((g) => g.id === Number(meet.host_id))?.name || "the host"}</span> to answer — until then it stays as it is.
                    </p>
                  ) : askOpen ? (
                    <div className="flex flex-col gap-2">
                      <label htmlFor="aq-ask-when" className="text-[12.5px] font-semibold text-ink">Suggest a time</label>
                      <input id="aq-ask-when" type="datetime-local" value={askAt} onChange={(e) => setAskAt(e.target.value)}
                        className="h-10 rounded-field border border-line bg-space-2 px-3 text-[14px] text-ink outline-none focus:border-yin-light" />
                      <div className="flex flex-wrap gap-2">
                        <button type="button" disabled={busy || !askAt} onClick={() => void doAsk()}
                          className="h-9 rounded-pill bg-yang px-4 text-[13px] font-bold text-on-accent disabled:opacity-50">Ask</button>
                        <button type="button" onClick={() => { setAskOpen(false); setAskAt(""); }}
                          className="h-9 rounded-pill border border-line px-4 text-[13px] font-semibold text-ink-2">Never mind</button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setAskOpen(true)}
                      className="text-[12.5px] font-semibold text-ink-2 hover:text-ink">Ask for a different time</button>
                  )}
                </div>
              )}

              {String(meet.context_type) === "book" && guests.length === 2
                && meet.status === "scheduled" && Number(meet.start_ts) > now && (
                <div className="mt-3 border-t border-line pt-3">
                  {confirmDrop ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[12.5px] text-ink-2">The hour goes back on offer.</span>
                      <button type="button" disabled={busy} onClick={() => { setConfirmDrop(false); void doCancel(); }}
                        className="h-9 rounded-pill bg-yang px-4 text-[13px] font-bold text-on-accent disabled:opacity-50">Cancel it</button>
                      <button type="button" onClick={() => setConfirmDrop(false)}
                        className="h-9 rounded-pill border border-line px-4 text-[13px] font-semibold text-ink-2">Keep it</button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setConfirmDrop(true)}
                      className="text-[12.5px] font-semibold text-ink-2 hover:text-ink">Cancel this booking</button>
                  )}
                </div>
              )}
            </div>
          )}

          <GuestList guests={guests} seats={Number(meet.seats) || 5} hostId={Number(meet.host_id)}
            isHost={isHost} bound={roomId > 0} busy={busy} onRemove={(uid) => void doUninvite(uid)} />

          {/* A PROPOSAL IS A QUESTION, and it belongs where the host already looks. Accepting goes
              through the ordinary retime — same seq bump, same guest emails, same calendar update —
              so there is only ever one way a meeting moves. */}
          {isHost && meet.status === "scheduled" && Number(meet.retime_ts) > 0 && (
            <section className="rounded-card border border-yang/40 bg-yang/[0.07] p-4" aria-label="A suggested time">
              <h2 className="text-[14px] font-semibold text-ink">
                <span data-ay-skip="1">{guests.find((g) => g.id === Number(meet.retime_by))?.name || "A guest"}</span>
                {" "}asked for a different time
              </h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
                They suggested <span className="font-semibold text-ink" data-ay-skip="1">{longWhen(Number(meet.retime_ts), meet.tz)}</span>.
                {" "}It is <span data-ay-skip="1">{longWhen(meet.start_ts, meet.tz)}</span> now, and nothing moves until you decide.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => void doAnswerAsk(true)}
                  className="h-9 rounded-pill bg-yang px-4 text-[13px] font-bold text-on-accent disabled:opacity-50">Move it</button>
                <button type="button" disabled={busy} onClick={() => void doAnswerAsk(false)}
                  className="h-9 rounded-pill border border-line px-4 text-[13px] font-semibold text-ink-2 disabled:opacity-50">Keep the time</button>
              </div>
            </section>
          )}

          {isHost && meet.status === "scheduled" && (
            <HostControls meet={meet} busy={busy}
              onInvite={doInvite}
              onRetime={(s, m, tz) => void doRetime(s, m, tz)}
              onCancel={() => void doCancel()} />
          )}

          {cal && meet.status !== "cancelled" && (
            <a href={oneEventIcs(cal.ics, id)}
              className="inline-flex h-10 items-center justify-center rounded-pill border border-line px-4 text-[13px] font-semibold text-ink-2 hover:border-yin-light hover:text-ink">
              Add this one to your calendar
            </a>
          )}

          {/* Google takes a template URL rather than a file, and the SERVER composes it — the title,
              both instants and the join link are its to state, and a URL built here would be a
              second place for this meeting's wording to drift out of step with the .ics above. */}
          {meet.gcal_url && meet.status !== "cancelled" && (
            <a href={meet.gcal_url} target="_blank" rel="noopener noreferrer"
              className="inline-flex h-10 items-center justify-center rounded-pill border border-line px-4 text-[13px] font-semibold text-ink-2 hover:border-yin-light hover:text-ink">
              Add to Google Calendar
            </a>
          )}

          <PrivacyNote />
          <Link to={localePath("/meet/")} className="text-[13px] font-semibold text-ink-3 hover:text-ink">
            ← All your meetings
          </Link>
        </aside>
      </div>
    </div>
  );
}

export default function Meet() {
  const { id } = useParams();
  const numeric = Number(id);
  return id && Number.isFinite(numeric) && numeric > 0 ? <MeetingPage key={numeric} id={numeric} /> : <MeetList />;
}
