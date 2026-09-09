import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RailPortal } from "../components/RightRail";
import {
  ApiError, bookSlots, castAccept, castConfirm, castFinal, castFinish, castHostOpen, castInbox, castInvite, castPage, castPhoto, castSave,
  castSchedule, castVolunteer, castWithdraw,
  type BookRule, type CastPage, type CastRequest, type CastSide, type CastRow,
} from "../lib/api";
import { isLoggedIn, localePath } from "../lib/wp";
import {
  Avatar, Button, ConfirmDialog, EmptyState, ErrorNote, Field, IconButton, Input, LinkButton, PageHero,
  Segmented, Textarea, cx,
} from "../components/ui";
import { CastFrame, CastThumb, type PreviewData } from "../components/cast/CastPreview";
import { sendForFinishing, sendIso, sendState, storedEpisodes, subscribeSend, type SendState, type Sidecar } from "../lib/episode-upload";
import { deleteRecording } from "../lib/episode-store";
import { CheckGlyph, ChevronGlyph, DayGrid, GlobeGlyph, GridSkeleton, WeekdayStrip } from "../components/cast/grid";
import {
  VIEWER_TZ, addMonths, clockOnly, dayHeading, dayHeadingLong, dayKey, longInstant, minKey, monthLabel, monthOf, zoneName,
} from "../lib/booking-time";

/**
 * ArtaCast — "come on the show".
 *
 * The host talks with couples about how they stayed together. This page is the whole of a couple's
 * side of that: ONE of them asks, enters the few facts the episode frame airs for BOTH of them,
 * invites the other with a single-use link, watches the thumbnail and the frame take shape as they
 * type, and takes a recording slot out of the host's published hours. The slot is an ordinary
 * ArtaMeet with the host and both of them on it.
 *
 * FOUR READERS, ONE FILE:
 *   · a stranger — the show, a demo frame, and "sign in to ask"
 *   · the one who asked (role 'a') — both forms, the invitation, the preview, the calendar
 *   · their partner (role 'b') — their own form, the preview, the booked time
 *   · the host — recording hours and the inbox of requests, each with its frame
 *
 * ⚠️ AUTOSAVE, NEVER A SAVE BUTTON. Every field is written 700ms after the last keystroke, and the
 * server merges only the keys sent — so the two of them can fill the form from two devices at once
 * without one blanking the other. The preview reads the LOCAL form, so it moves on every keystroke,
 * not on every save.
 *
 * ⚠️ `data-ay-skip="1"` on every member-authored word and every formatted date or clock.
 */

const AUTOSAVE_MS = 700;
const PHOTO_EDGE = 1600;
const ROWS_MAX = 6;
const LINK_HIT = "inline-flex min-h-[40px] items-center";

const EMPTY_SIDE: CastSide = { name: "", subtitle: "", born: "", place: "", photo: "", rows: [] };

/** The demo couple a stranger sees — fictional, the kit's own sample names. */
const DEMO: PreviewData = {
  a: { name: "Mohammadreza Hosseinzadeh", subtitle: "Master baker", born: "1951-05-09", place: "Tabriz", photo: "", rows: [{ y: 1975, l: "Opened the bakery" }, { y: 1998, l: "First grandchild" }] },
  b: { name: "Ana Costa", subtitle: "Head nurse", born: "1953-02-14", place: "Porto", photo: "", rows: [{ y: 1984, l: "Head nurse, São João" }] },
  married_y: 1979,
  hostPhoto: "",
};

function errText(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}
function signInTo(path: string) {
  window.location.assign(`${localePath("/login/")}?redirect_to=${encodeURIComponent(path)}`);
}

/** A picked file → a JPEG data URL no longer than PHOTO_EDGE on its long side. A phone photograph
 *  is 12 MB and 4000px; the frame needs 912. Shrinking here keeps the upload under the server's
 *  cap and makes the preview appear at once. */
async function fileToDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("unreadable"));
      i.src = url;
    });
    const s = Math.min(1, PHOTO_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.88);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The side fields the server merges — never the photo, which has its own call. */
function sideFields(s: CastSide) {
  return { name: s.name, subtitle: s.subtitle, born: s.born, place: s.place, rows: s.rows };
}

/* ───────────────────────── the form pieces ───────────────────────── */

function PhotoField({ side, value, busy, onFile }: { side: "a" | "b"; value: string; busy: boolean; onFile: (f: File) => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <div className="flex items-center gap-3">
      {value
        ? <img src={value} alt="" className="h-16 w-24 shrink-0 rounded-card object-cover" />
        : <span aria-hidden className="grid h-16 w-24 shrink-0 place-items-center rounded-card border border-dashed border-line text-[12px] text-ink-3">No photo</span>}
      <div className="min-w-0">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => ref.current?.click()}>
          {busy ? "Uploading…" : value ? "Change photo" : "Choose a photo"}
        </Button>
        <p className="mt-1 text-[12px] leading-snug text-ink-3">A clear, well-lit picture of the face. Landscape if you have one — it fills a 16:9 window.</p>
      </div>
      <input ref={ref} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" aria-label={`Photo for ${side === "a" ? "you" : "your partner"}`}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
    </div>
  );
}

function RowsEditor({ rows, onChange }: { rows: CastRow[]; onChange: (r: CastRow[]) => void }) {
  const set = (i: number, patch: Partial<CastRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input inputMode="numeric" value={r.y || ""} placeholder="Year" aria-label="Year" className="w-24 shrink-0 tabular-nums"
            onChange={(e) => set(i, { y: Number(e.target.value.replace(/\D/g, "").slice(0, 4)) || 0 })} />
          <Input value={r.l} placeholder="What happened, in a few words" aria-label="Milestone" maxLength={40} className="min-w-0 flex-1"
            onChange={(e) => set(i, { l: e.target.value })} />
          <IconButton label="Remove this milestone" className="h-10 w-10 shrink-0" onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</IconButton>
        </div>
      ))}
      {rows.length < ROWS_MAX && (
        <div><LinkButton className={LINK_HIT} onClick={() => onChange([...rows, { y: 0, l: "" }])}>+ Add a milestone</LinkButton></div>
      )}
    </div>
  );
}

function SideForm({ who, side, photoBusy, onChange, onFile, sideKey }: {
  who: string; side: CastSide; photoBusy: boolean; sideKey: "a" | "b";
  onChange: (s: CastSide) => void; onFile: (f: File) => void;
}) {
  const [rowsOpen, setRowsOpen] = useState(side.rows.length > 0);
  return (
    <div className="flex flex-col gap-4">
      <Field label="Name" required hint="Exactly as it should air. It is never shortened — a long name wraps.">
        <Input value={side.name} maxLength={60} placeholder={who === "you" ? "Your full name" : "Their full name"} onChange={(e) => onChange({ ...side, name: e.target.value })} />
      </Field>
      <Field label="One line, in your own words" required hint="What you are — “Master baker”, “Head nurse”. It airs under the name, on one line.">
        <Input value={side.subtitle} maxLength={40} placeholder="Master baker" onChange={(e) => onChange({ ...side, subtitle: e.target.value })} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date of birth" optional hint="Opens the timeline: “1951 · Born 9 May”.">
          <Input type="date" value={side.born} max={new Date().toISOString().slice(0, 10)} onChange={(e) => onChange({ ...side, born: e.target.value })} />
        </Field>
        <Field label="Place of birth" optional>
          <Input value={side.place} maxLength={40} placeholder="Tabriz" onChange={(e) => onChange({ ...side, place: e.target.value })} />
        </Field>
      </div>
      <Field label="Photo" required>
        <PhotoField side={sideKey} value={side.photo} busy={photoBusy} onFile={onFile} />
      </Field>
      {rowsOpen ? (
        <Field label="Milestones" optional hint={<>Up to <span data-ay-skip="1">{ROWS_MAX}</span> of the moments that matter — a move, a first shop, a grandchild. Year and a few words each.</>}>
          <RowsEditor rows={side.rows} onChange={(rows) => onChange({ ...side, rows })} />
        </Field>
      ) : (
        <div><LinkButton className={LINK_HIT} onClick={() => setRowsOpen(true)}>+ Add milestones for the timeline (optional)</LinkButton></div>
      )}
    </div>
  );
}

/* ───────────────────────── the calendar ───────────────────────── */

function TimePicker({ hostSlug, hostName, rule, onBook }: {
  hostSlug: string; hostName: string; rule: BookRule; onBook: (start: number) => Promise<void>;
}) {
  const [starts, setStarts] = useState<number[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [answered, setAnswered] = useState(0);
  const [now, setNow] = useState(() => Math.round(Date.now() / 1000));
  const [month, setMonth] = useState(() => monthOf(dayKey(Math.round(Date.now() / 1000), VIEWER_TZ)));
  const [day, setDay] = useState("");
  const [picked, setPicked] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const seq = useRef(0);
  const tz = VIEWER_TZ;
  const hostTz = rule.tz || "";

  useEffect(() => {
    const t = window.setInterval(() => setNow(Math.round(Date.now() / 1000)), 60000);
    return () => window.clearInterval(t);
  }, []);

  /** Follow `next` to the end of the window: one answer is 400 OFFERED instants, not the horizon. */
  const load = useCallback((quiet = false) => {
    const mine = ++seq.current;
    const from = Math.round(Date.now() / 1000);
    const to = from + Math.max(1, Math.min(90, Number(rule.horizon_d) || 21)) * 86400;
    if (!quiet) { setStarts(null); setAnswered(0); }
    setFailed(false);
    const all: number[] = [];
    const walk = (cursor: number, page: number): Promise<number> =>
      bookSlots({ user: hostSlug, type: rule.slug, from: cursor, to }).then((r) => {
        if (mine !== seq.current) return 0;
        all.push(...r.starts);
        return r.next && r.next > cursor && page + 1 < 12 ? walk(r.next, page + 1) : r.to;
      });
    walk(from, 0)
      .then((reached) => { if (mine !== seq.current) return; setStarts(all.slice().sort((a, b) => a - b)); setAnswered(reached); })
      .catch(() => { if (mine !== seq.current || quiet) return; setStarts(null); setFailed(true); });
  }, [hostSlug, rule.slug, rule.horizon_d]);

  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => {
    const out: { key: string; starts: number[] }[] = [];
    for (const ts of starts || []) {
      const key = dayKey(ts, tz);
      const last = out[out.length - 1];
      if (last && last.key === key) { last.starts.push(ts); continue; }
      out.push({ key, starts: [ts] });
    }
    return out;
  }, [starts, tz]);
  const dayMap = useMemo(() => new Map(groups.map((g) => [g.key, g.starts])), [groups]);
  const monthsWithSlots = useMemo(() => new Set(groups.map((g) => monthOf(g.key))), [groups]);

  const todayKey = dayKey(now, tz);
  const horizonD = Math.max(1, Math.min(90, Number(rule.horizon_d) || 21));
  const ruleHorizonKey = dayKey(now + horizonD * 86400, tz);
  const horizonKey = answered > 0 ? minKey(ruleHorizonKey, dayKey(answered, tz)) : ruleHorizonKey;
  const activeKey = (picked ? dayKey(picked, tz) : day) || groups[0]?.key || "";
  const active = dayMap.get(activeKey) || [];
  useEffect(() => { if (activeKey) setMonth(monthOf(activeKey)); }, [activeKey]);

  const nextMonth = addMonths(month, 1);
  const laterMonth = Array.from(monthsWithSlots).sort().find((m) => m > month) || "";
  const prevBlocked = month <= monthOf(todayKey);
  const nextBlocked = `${nextMonth}-01` > horizonKey;
  const empty = starts !== null && !failed && groups.length === 0;

  async function book() {
    if (!picked) return;
    setBusy(true); setErr("");
    try {
      await onBook(picked);
    } catch (e) {
      setErr(errText(e, "That time couldn’t be booked — it may have just gone. Here is what is still free."));
      setPicked(0);
      load(true);
    } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="mb-3 rounded-card border border-yang/30 bg-yang/[0.07] px-3 py-2 text-center">
        <p className="flex flex-wrap items-center justify-center gap-x-2 text-[13.5px] font-semibold text-ink">
          <span className="text-yang"><GlobeGlyph /></span>
          <span>Times shown in</span>
          <span data-ay-skip="1">{tz}</span>
          <span className="font-normal text-ink-2" data-ay-skip="1">({zoneName(now, tz)} · {clockOnly(now, tz)} now)</span>
        </p>
        <p className="mt-0.5 text-[12.5px] text-ink-2">
          That is your own zone{hostTz && hostTz !== tz && <> · <span data-ay-skip="1">{hostName}</span> is on <span data-ay-skip="1">{clockOnly(now, hostTz)}</span></>}
        </p>
      </div>

      {failed && (
        <ErrorNote>Couldn’t load the free times. <button type="button" className="font-semibold underline" onClick={() => load()}>Try again</button></ErrorNote>
      )}
      {empty ? (
        <EmptyState title={<>No free times in the next <span data-ay-skip="1">{horizonD}</span> days</>}
          body="Nothing is open that far ahead. Your request is saved — look again in a day or two; a slot frees the moment something moves."
          action={<Button variant="outline" onClick={() => load()}>Look again</Button>} />
      ) : (
        <div className="md:flex md:items-start md:gap-5">
          <div className="md:min-w-0 md:flex-1">
            <div className="flex h-10 items-center justify-between">
              <h3 className="text-[18px] font-bold text-ink"><time dateTime={month} data-ay-skip="1">{monthLabel(month)}</time></h3>
              <div className="flex items-center gap-1">
                <IconButton label="Previous month" className="h-10 w-10" disabled={prevBlocked} onClick={() => setMonth(addMonths(month, -1))}><ChevronGlyph back /></IconButton>
                <IconButton label="Next month" className="h-10 w-10" disabled={nextBlocked} onClick={() => setMonth(nextMonth)}><ChevronGlyph /></IconButton>
              </div>
            </div>
            <WeekdayStrip />
            {starts === null && !failed ? (
              <><GridSkeleton /><p className="mt-3 text-[13px] text-ink-2">Finding the host’s free times…</p></>
            ) : (
              <div className="relative">
                <DayGrid month={month} dayMap={dayMap} todayKey={todayKey} horizonKey={horizonKey} selected={activeKey}
                  onChoose={(k) => { setDay(k); setErr(""); if (picked && dayKey(picked, tz) !== k) setPicked(0); }} onMonth={setMonth} />
                {!failed && !monthsWithSlots.has(month) && (
                  <div className="pointer-events-none absolute inset-0 grid place-items-center">
                    <div className="pointer-events-auto rounded-card border border-line bg-space-2/95 px-4 py-3 text-center backdrop-blur">
                      <p className="text-[13px] text-ink-2">Nothing free in <span data-ay-skip="1">{monthLabel(month, false)}</span></p>
                      {laterMonth && <LinkButton className={LINK_HIT} onClick={() => setMonth(laterMonth)}>See <span data-ay-skip="1">{monthLabel(laterMonth, false)}</span></LinkButton>}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="mt-4 border-t border-line pt-4 md:mt-0 md:w-[210px] md:shrink-0 md:border-l md:border-t-0 md:ps-5 md:pt-0">
            <h3 className="text-[14px] font-semibold text-ink">
              {activeKey ? <><span className="md:hidden" data-ay-skip="1">{dayHeading(activeKey, false)}</span><span className="hidden md:inline" data-ay-skip="1">{dayHeadingLong(activeKey)}</span></> : "Pick a day"}
            </h3>
            {err && <div className="mt-3" role="status"><ErrorNote>{err}</ErrorNote></div>}
            <div className="mt-3">
              {active.length > 0 ? (
                <div className="grid grid-cols-3 gap-2 md:max-h-[444px] md:grid-cols-1 md:gap-1.5 md:overflow-y-auto md:pe-1">
                  {active.map((ts) => {
                    const on = ts === picked;
                    return (
                      <button key={ts} type="button" aria-pressed={on} onClick={() => { setPicked(ts); setErr(""); }}
                        className={cx("h-12 rounded-field border text-[15px] font-semibold tabular-nums transition-colors duration-150 md:h-11 md:text-[14.5px]",
                          on ? "border-yang bg-yang text-on-accent" : "border-line text-ink-2 hover:border-yin-light hover:text-ink")}>
                        <span data-ay-skip="1">{clockOnly(ts, tz)}</span>
                      </button>
                    );
                  })}
                </div>
              ) : starts === null ? null : (
                <p className="text-[13px] text-ink-2">Choose a day with a gold circle.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {picked > 0 && (
        <section aria-label="The time you pick" className="mt-4 rounded-card border border-yang/40 bg-yang/[0.06] p-4">
          <p className="text-[15px] font-semibold text-ink" data-ay-skip="1">{longInstant(picked, tz)}</p>
          {hostTz && hostTz !== tz && (
            <p className="mt-1 text-[12.5px] text-ink-2">which is <span data-ay-skip="1">{clockOnly(picked, hostTz)}</span> for <span data-ay-skip="1">{hostName}</span> in <span data-ay-skip="1">{hostTz}</span></p>
          )}
          <p className="mt-1 text-[12.5px] text-ink-2">The recording runs about <span data-ay-skip="1">{rule.minutes}</span> minutes, as an encrypted ArtaMeet call with the host and both of you.</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button onClick={() => void book()} disabled={busy}>{busy ? "Booking…" : "Book this recording"}</Button>
            <LinkButton className={LINK_HIT} onClick={() => { setPicked(0); setErr(""); }}>Choose another time</LinkButton>
          </div>
        </section>
      )}
    </div>
  );
}

/* ───────────────────────── the host ───────────────────────── */

/** What the finishing run is doing for one request, and the downloads when it is done. Links are
 *  minted on click (Kaggle's are signed and short-lived), never stored. */
function PipelineLine({ r }: { r: CastRequest }) {
  const p = r.pipeline;
  const [links, setLinks] = useState<{ name: string; url: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!p || !p.state) return null;
  async function fetchLinks() {
    setBusy(true); setErr("");
    try { const f = await castFinal(r.id); setLinks(f.files); }
    catch (e) { setErr(errText(e, "Kaggle did not answer — try again in a moment.")); }
    finally { setBusy(false); }
  }
  async function retry() {
    if (!r.meet) return;
    setBusy(true); setErr("");
    try { await castFinish(r.meet.id, p?.raw || 0); window.location.reload(); }
    catch (e) { setErr(errText(e, "Couldn’t restart the finishing run.")); setBusy(false); }
  }
  const label = (n: string) => /-report\.json$/.test(n) ? "Report" : /thumbnail/.test(n) ? "Thumbnail" : /\.(mp4|webm|m4a)$/.test(n) ? "Final episode" : n;
  return (
    <div className="mt-1 text-[12.5px]">
      {p.state === "running" && <p className="text-ink-2">Finishing on Kaggle GPU — cleaning the voices, setting the loudness — since <span data-ay-skip="1">{longInstant(p.started, VIEWER_TZ)}</span>. Usually under an hour; you will be emailed.</p>}
      {p.state === "failed" && p.retrying && (
        <p className="text-ink-2">Kaggle refused the run (<span data-ay-skip="1">{p.note.replace(/^Kaggle refused the kernel: /, "")}</span>) — it is retried automatically every ten minutes, up to four times.</p>
      )}
      {p.state === "failed" && !p.retrying && (
        <p className="text-yang">Finishing failed: <span data-ay-skip="1">{p.note}</span>{" "}
          <button type="button" className="underline" disabled={busy} onClick={() => void retry()}>Try again</button>
          {p.kernel && <> · <a className="underline" href={p.kernel} target="_blank" rel="noreferrer">kernel log</a></>}
        </p>
      )}
      {(r.iso?.length || 0) > 0 && (
        <p className="text-ink-2">Isolated tracks: {r.iso!.map((t) => <a key={t.name} className="me-2 underline" href={t.url} download data-ay-skip="1">{t.name} · {t.bytes < 1e9 ? `${(t.bytes / 1e6).toFixed(0)} MB` : `${(t.bytes / 1e9).toFixed(2)} GB`}</a>)}</p>
      )}
      {p.state === "done" && (
        <div>
          <p className="text-ink"><span className="font-semibold text-yang">Release ready</span> · <span data-ay-skip="1">{p.note}</span></p>
          {links ? (
            <div className="mt-1 flex flex-wrap gap-2">
              {links.map((f) => <a key={f.name} href={f.url} className="inline-flex h-9 items-center rounded-pill bg-yang px-3 text-[12.5px] font-bold text-on-accent" download={f.name}>{label(f.name)}</a>)}
              {p.thumb && !links.some((f) => /thumbnail/.test(f.name)) && <a href={p.thumb} className="inline-flex h-9 items-center rounded-pill border border-line px-3 text-[12.5px] font-semibold text-ink-2" download>Thumbnail</a>}
            </div>
          ) : (
            <button type="button" className="mt-1 inline-flex h-9 items-center rounded-pill bg-yang px-3 text-[12.5px] font-bold text-on-accent" disabled={busy} onClick={() => void fetchLinks()}>{busy ? "Fetching…" : "Get the downloads"}</button>
          )}
          <p className="mt-1 text-ink-3">Upload the final episode to YouTube as it is, with the thumbnail. Links expire after a while — press the button again for fresh ones.</p>
        </div>
      )}
      {err && <p className="text-yang">{err}</p>}
    </div>
  );
}

/** Episodes still in this browser's store — the way back when a send was interrupted. */
function StoredEpisodes({ iso = false }: { iso?: boolean }) {
  const [items, setItems] = useState<{ name: string; bytes: number; modified: number; side: Sidecar | null }[]>([]);
  const [, bump] = useState(0);
  const refresh = useCallback(() => { storedEpisodes().then((all) => setItems(all.filter((it) => !!it.side?.iso === iso))).catch(() => undefined); }, [iso]);
  useEffect(() => { refresh(); return subscribeSend(() => bump((n) => n + 1)); }, [refresh]);
  if (!items.length) return null;
  const fmtBytes = (n: number) => n < 1e9 ? `${(n / 1e6).toFixed(0)} MB` : `${(n / 1e9).toFixed(2)} GB`;
  return (
    <section className="rounded-card border border-line bg-space-2 p-4 md:p-5" aria-label="Recordings on this computer">
      <h2 className="text-[16px] font-bold text-ink">{iso ? "Your camera recordings on this computer" : "Recordings on this computer"}</h2>
      {iso && <p className="mt-1 text-[12.5px] text-ink-3">Recorded beside the episode at full quality, for the editor. They are sent to the show on their own; if a send was interrupted, send it again here.</p>}
      <ul className="mt-2 flex flex-col gap-2">
        {items.map((it) => {
          const st: SendState | undefined = sendState(it.name);
          const sending = st && (st.phase === "uploading" || st.phase === "thumb" || st.phase === "starting");
          return (
            <li key={it.name} className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="min-w-0 flex-1 break-all text-ink" data-ay-skip="1">{it.name} · {fmtBytes(it.bytes)}</span>
              {st?.phase === "uploading" && <span className="text-ink-2">Sending · <span data-ay-skip="1">{Math.round(st.frac * 100)}%</span></span>}
              {(st?.phase === "thumb" || st?.phase === "starting") && <span className="text-ink-2">Starting the finishing run…</span>}
              {st?.phase === "done" && <span className="text-yang">Sent — finishing on Kaggle</span>}
              {st?.phase === "error" && <span className="text-yang">{st.note}</span>}
              {it.side && !sending && st?.phase !== "done" && (
                <Button size="sm" onClick={() => { (iso ? sendIso(it.name, it.side!.meet_id) : sendForFinishing(it.name, it.side!.meet_id)).catch(() => undefined); }}>{st?.phase === "error" ? "Send again" : iso ? "Send to the show" : "Send for finishing"}</Button>
              )}
              {!it.side && <span className="text-ink-3">Not an episode file</span>}
              {!sending && <button type="button" className="text-[12.5px] text-ink-3 underline" onClick={() => { deleteRecording(it.name).then(() => { deleteRecording(`${it.name}.json`); deleteRecording(`${it.name}.thumb.png`); refresh(); }); }}>Delete</button>}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[12px] text-ink-3">A send that was interrupted resumes where it stopped. Keep this tab open while it runs.</p>
    </section>
  );
}

/** Minutes from midnight → the clock face the reader's locale writes, on a fixed UTC day. */
function minuteClock(min: number): string {
  const m = Math.max(0, Math.min(1439, Math.round(min)));
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "UTC" }).format(new Date(Date.UTC(1970, 0, 1, 0, m)));
}
function DaysWords({ days }: { days: string }) {
  if (/^1{7}$/.test(days)) return <>any day</>;
  if (days === "1111100") return <>weekdays</>;
  if (days === "0000011") return <>weekends</>;
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return <span data-ay-skip="1">{names.filter((_, i) => days[i] === "1").join(", ")}</span>;
}

function HostPanel({ page, onPreview, previewing }: { page: CastPage; onPreview: (r: CastRequest | null) => void; previewing: number }) {
  const [items, setItems] = useState<CastRequest[] | null>(null);
  const [rule, setRule] = useState<BookRule | null>(page.rule);
  const [err, setErr] = useState("");
  const [opening, setOpening] = useState(false);

  const [opened, setOpened] = useState(false);
  useEffect(() => {
    let stop = false;
    castInbox().then(async (r) => {
      if (stop) return;
      setItems(r.items); setRule(r.rule);
      // NO STEP FOR THE HOST. The first time the host looks at their show, the hours open themselves
      // with the show's defaults in the host's own zone; the sentence below says what they are and
      // where to change them. A show whose hours a couple cannot book is a show nobody is on.
      // ONLY FOR A HOST: an operator sees the requests but has no calendar here to open, and asking
      // the server to open one was answered "Only a host has recording hours" on every visit.
      if (!r.rule && page.hosting) {
        try { const o = await castHostOpen(VIEWER_TZ); if (!stop) { setRule(o.rule); setOpened(true); } }
        catch (e) { if (!stop) setErr(errText(e, "Couldn’t open the hours.")); }
      }
    }).catch((e) => { if (!stop) setErr(errText(e, "Couldn’t load the requests.")); });
    return () => { stop = true; };
  }, []);

  async function open() {
    setOpening(true); setErr("");
    try { const r = await castHostOpen(VIEWER_TZ); setRule(r.rule); }
    catch (e) { setErr(errText(e, "Couldn’t open the hours.")); }
    finally { setOpening(false); }
  }

  const label = (r: CastRequest) => [r.a.name, r.b.name].filter(Boolean).join(" & ") || `Request #${r.id}`;
  const [busyId, setBusyId] = useState(0);
  async function decide(r: CastRequest, ok: boolean) {
    setBusyId(r.id); setErr("");
    try {
      const res = await castConfirm(r.id, ok);
      if (res.request) setItems((cur) => (cur || []).map((x) => (x.id === r.id ? res.request! : x)));
      else if (res.declined) setItems((cur) => (cur || []).filter((x) => x.id !== r.id));
    } catch (e) { setErr(errText(e, ok ? "Couldn’t confirm that." : "Couldn’t decline that.")); }
    finally { setBusyId(0); }
  }
  return (
    <>
      {!page.hosting && (
        <section className="rounded-card border border-line bg-space-2 p-4 md:p-5" aria-label="Operator view">
          <h2 className="text-[16px] font-bold text-ink">You’re looking after the show</h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
            As an operator you see every request and where each episode stands. The recordings are booked in
            {" "}<span data-ay-skip="1">{page.host?.name || "the host"}</span>’s calendar
            {page.host?.slug && <> (<a className="underline" href={localePath(`/u/${encodeURIComponent(page.host.slug)}/`)} data-ay-skip="1">@{page.host.slug}</a>)</>}.
            To take episodes yourself, volunteer to host below and your own calendar opens.
          </p>
          <div className="mt-3"><Button variant="outline" onClick={() => { castVolunteer(true, VIEWER_TZ).then(() => window.location.reload()).catch((e) => setErr(errText(e, "Couldn’t sign you up to host."))); }}>Volunteer to host</Button></div>
        </section>
      )}
      {page.hosting && (
      <section className="rounded-card border border-line bg-space-2 p-4 md:p-5" aria-label="Recording hours">
        <h2 className="text-[16px] font-bold text-ink">Recording hours</h2>
        {rule ? (
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
            {opened ? "Your calendar is now open to couples: " : "Your calendar is open to couples: "}
            any free <span data-ay-skip="1">{rule.minutes}</span>-minute slot, <DaysWords days={rule.days} /> <span data-ay-skip="1">{minuteClock(rule.from_min)}–{minuteClock(rule.to_min)}</span> in <span data-ay-skip="1">{rule.tz}</span>, up to <span data-ay-skip="1">{rule.horizon_d}</span> days ahead.
            Every meeting already in your calendar blocks its time automatically — there are no show hours to keep. <a className="font-semibold underline" href={localePath("/book/")}>Adjust</a>
          </p>
        ) : (
          <>
            <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
              No couple can book a recording until you open hours. This writes an ordinary booking rule called “ArtaCast recording” — any free 90-minute slot, any day 9 AM to 9 PM in your own zone, three seats, up to 60 days ahead — which you can then shape at /book like any other. Every meeting already in your calendar blocks its time on its own.
            </p>
            <div className="mt-3"><Button onClick={() => void open()} disabled={opening}>{opening ? "Opening…" : "Open recording hours"}</Button></div>
          </>
        )}
        {err && <div className="mt-3"><ErrorNote>{err}</ErrorNote></div>}
      </section>
      )}
      {!page.hosting && err && <ErrorNote>{err}</ErrorNote>}
      {page.hosting && <StoredEpisodes />}
      <section className="rounded-card border border-line bg-space-2 p-4 md:p-5" aria-label="Requests">
        <h2 className="text-[16px] font-bold text-ink">Requests</h2>
        {items === null ? <p className="mt-2 text-[13px] text-ink-2">Loading…</p>
          : items.length === 0 ? <p className="mt-2 text-[13px] text-ink-2">Nobody has asked yet. Share <span data-ay-skip="1">artaquest.com/artacast</span>.</p>
          : (
            <ul className="mt-3 flex flex-col divide-y divide-line">
              {items.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="flex -space-x-2">
                    {r.a.photo ? <img src={r.a.photo} alt="" className="h-10 w-10 rounded-full object-cover ring-2 ring-space-2" /> : <Avatar name={r.a.name || "?"} className="h-10 w-10 text-[14px] ring-2 ring-space-2" />}
                    {r.b.photo ? <img src={r.b.photo} alt="" className="h-10 w-10 rounded-full object-cover ring-2 ring-space-2" /> : <Avatar name={r.b.name || "?"} className="h-10 w-10 text-[14px] ring-2 ring-space-2" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-semibold text-ink" data-ay-skip="1">{label(r)}</p>
                    <p className="text-[12.5px] text-ink-2">
                      {r.meet ? <>Recording <span data-ay-skip="1">{longInstant(r.meet.start_ts, VIEWER_TZ)}</span></>
                        : r.complete.a && r.complete.b ? "Details complete — no time yet" : "Still filling in details"}
                      {r.partner ? " · partner joined" : r.invite.pending ? " · partner invited" : " · partner not invited yet"}
                      {(r.recorded?.at || 0) > 0 && <> · <span className="text-yang">recorded</span> <span data-ay-skip="1">{r.recorded?.note}</span></>}
                    </p>
                    <PipelineLine r={r} />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {/* THE HOST'S WORD. A request is confirmed before the couple can take an hour
                        of the host's calendar; declining closes it with a letter to both. */}
                    {!r.confirmed ? (
                      <>
                        <Button size="sm" onClick={() => void decide(r, true)} disabled={busyId === r.id}>{busyId === r.id ? "…" : "Confirm"}</Button>
                        <Button size="sm" variant="outline" onClick={() => { if (window.confirm(`Decline ${label(r)}? They are told, and the request closes.`)) void decide(r, false); }} disabled={busyId === r.id}>Decline</Button>
                      </>
                    ) : (
                      <span className="inline-flex h-8 items-center rounded-pill bg-yang/15 px-2.5 text-[12px] font-semibold text-yang">Confirmed</span>
                    )}
                    {r.meet && <Button size="sm" variant="outline" href={r.meet.url}>Open the meeting</Button>}
                    <Button size="sm" variant={previewing === r.id ? "primary" : "outline"} onClick={() => onPreview(previewing === r.id ? null : r)}>{previewing === r.id ? "Hide frame" : "Frame"}</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </section>
    </>
  );
}

/* ───────────────────────── the page ───────────────────────── */

type Form = { a: CastSide; b: CastSide; married_y: number; story: string; b_email: string };
const formOf = (r: CastRequest): Form => ({ a: { ...EMPTY_SIDE, ...r.a }, b: { ...EMPTY_SIDE, ...r.b }, married_y: r.married_y, story: r.story, b_email: r.b_email });

function StepRow({ done, children }: { done: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[13px]">
      <span aria-hidden className={cx("mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px]", done ? "bg-yang text-on-accent" : "border border-line text-ink-3")}>{done ? "✓" : ""}</span>
      <span className={done ? "text-ink-2" : "text-ink"}>{children}</span>
    </li>
  );
}

export default function ArtaCast() {
  const [entry] = useState(() => {
    const sp = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
    let invite = (sp.get("invite") || "").toLowerCase();
    // A partner who is NEW here meets the identity step (name, date of birth) before any POST is
    // allowed, and that step ends in a full navigation to the front page — the link in the address
    // bar would be gone. So the secret is stashed the moment it is seen and picked up again on the
    // next visit to this page, whether that visit comes from the bell, the email or the nav.
    try {
      if (invite) window.localStorage.setItem("aq_cast_invite", invite);
      else invite = (window.localStorage.getItem("aq_cast_invite") || "").toLowerCase();
    } catch { /* storage refused — the link in the letter still works */ }
    return { invite: /^[0-9a-f]{40}$/.test(invite) ? invite : "" };
  });
  const [page, setPage] = useState<CastPage | null>(null);
  const [pageErr, setPageErr] = useState("");
  const [request, setRequest] = useState<CastRequest | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveErr, setSaveErr] = useState("");
  const [photoBusy, setPhotoBusy] = useState<{ a: boolean; b: boolean }>({ a: false, b: false });
  const [photoErr, setPhotoErr] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [inviteSent, setInviteSent] = useState<boolean | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteErr, setInviteErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [joinedNote, setJoinedNote] = useState("");
  const [inviteFail, setInviteFail] = useState("");
  const [tab, setTab] = useState<"thumb" | "frame">("thumb");
  const [starting, setStarting] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawNote, setWithdrawNote] = useState("");
  const [hostPreview, setHostPreview] = useState<CastRequest | null>(null);
  const saveTimer = useRef(0);
  const formLoaded = useRef(false);
  // The secret is SPENT by the first accept, and React's dev StrictMode runs a mount effect twice —
  // the second run would report the link as used to the very person who just used it.
  const acceptedKey = useRef("");
  const acceptNote = useRef("");
  const doneHead = useRef<HTMLHeadingElement | null>(null);
  const signedIn = isLoggedIn();

  // Load: an invitation in the address bar is accepted FIRST (signed in), so the page that follows
  // already shows the joined request. The parameter is then dropped from the URL — it is spent.
  useEffect(() => {
    let stop = false;
    (async () => {
      if (entry.invite && signedIn && acceptedKey.current !== entry.invite) {
        acceptedKey.current = entry.invite;
        try {
          const r = await castAccept(entry.invite);
          acceptNote.current = r.already ? "" : `You have joined ${r.request.requester?.name || "your partner"}’s request.`;
          try { window.localStorage.removeItem("aq_cast_invite"); } catch { /* fine */ }
        } catch (e) {
          // A DEFINITIVE refusal (used, expired, wrong person) retires the stash; anything else — the
          // identity gate, a dropped connection — keeps it, so the next visit tries again.
          const code = e instanceof ApiError ? String(e.code || "") : "";
          if (["bad_invite", "expired", "own_invite", "own_show", "busy"].includes(code)) {
            try { window.localStorage.removeItem("aq_cast_invite"); } catch { /* fine */ }
          }
          if (code !== "birthday_required") setInviteFail(errText(e, "That invitation could not be used."));
        }
        window.history.replaceState(null, "", window.location.pathname);
      }
      try {
        const p = await castPage();
        if (stop) return;
        setPage(p);
        if (p.request) { setRequest(p.request); setForm(formOf(p.request)); }
        if (acceptNote.current) setJoinedNote(acceptNote.current);
      } catch (e) {
        if (!stop) setPageErr(errText(e, "ArtaCast couldn’t be loaded."));
      }
    })();
    return () => { stop = true; };
  }, [entry.invite, signedIn]);

  const role = request?.role || "";

  // Autosave, debounced, only the keys this reader may write.
  useEffect(() => {
    if (!form || !request) return;
    if (!formLoaded.current) { formLoaded.current = true; return; }
    window.clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = window.setTimeout(async () => {
      try {
        const body = role === "b"
          ? { b: sideFields(form.b) }
          : { a: sideFields(form.a), b: sideFields(form.b), married_y: form.married_y, story: form.story, b_email: form.b_email };
        const r = await castSave(body);
        setRequest((cur) => (cur ? { ...r.request, a: { ...r.request.a, photo: cur.a.photo || r.request.a.photo }, b: { ...r.request.b, photo: cur.b.photo || r.request.b.photo } } : r.request));
        setSaveState("saved"); setSaveErr("");
      } catch (e) {
        setSaveState("error"); setSaveErr(errText(e, "Couldn’t save — check the connection."));
      }
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  async function start() {
    setStarting(true);
    try {
      const r = await castSave({});
      setRequest(r.request);
      formLoaded.current = false;
      setForm(formOf(r.request));
    } catch (e) {
      setPageErr(errText(e, "Couldn’t start your request."));
    } finally { setStarting(false); }
  }

  async function onFile(side: "a" | "b", f: File) {
    setPhotoErr("");
    setPhotoBusy((b) => ({ ...b, [side]: true }));
    try {
      const data = await fileToDataUrl(f);
      const r = await castPhoto(side, data);
      setRequest(r.request);
      setForm((cur) => (cur ? { ...cur, [side]: { ...cur[side], photo: r.url } } : cur));
    } catch (e) {
      setPhotoErr(errText(e, "That picture couldn’t be used — try a JPG or PNG."));
    } finally { setPhotoBusy((b) => ({ ...b, [side]: false })); }
  }

  async function sendInvite() {
    // Flush a pending email edit first: the server sends to what it HOLDS.
    if (form && form.b_email !== request?.b_email) {
      window.clearTimeout(saveTimer.current);
      try { const r = await castSave({ b_email: form.b_email, b: sideFields(form.b) }); setRequest(r.request); setSaveState("saved"); }
      catch (e) { setInviteErr(errText(e, "That address couldn’t be saved.")); return; }
    }
    setInviteBusy(true); setInviteErr(""); setCopied(false);
    try {
      const r = await castInvite();
      setInviteUrl(r.url); setInviteSent(r.sent); setRequest(r.request);
    } catch (e) {
      setInviteErr(errText(e, "The invitation couldn’t be sent."));
    } finally { setInviteBusy(false); }
  }

  async function copyLink() {
    try { await navigator.clipboard.writeText(inviteUrl); setCopied(true); window.setTimeout(() => setCopied(false), 2500); }
    catch { setCopied(false); }
  }

  async function book(start: number) {
    const r = await castSchedule(start);
    setRequest(r.request);
    window.requestAnimationFrame(() => doneHead.current?.focus());
  }

  async function withdraw() {
    setWithdrawing(true);
    try {
      const r = await castWithdraw();
      setWithdrawOpen(false);
      setRequest(null); setForm(null); formLoaded.current = false;
      setWithdrawNote(r.note ? `Your request is withdrawn. ${r.note}` : "Your request is withdrawn. You can ask again whenever you like.");
    } catch (e) {
      setSaveErr(errText(e, "Couldn’t withdraw."));
    } finally { setWithdrawing(false); }
  }

  const host = request?.host || page?.host || null;
  const hostName = host?.name || "the host";
  const hosts = page?.hosts || [];
  // The host's window shows a PHOTOGRAPH or the bust — never the season sigil the platform draws
  // for a member with no picture, which would air as a logo on the interview frame.
  const hostAvatar = host?.avatar || "";
  const hostPhoto = hostAvatar && !/\/seasons\//.test(hostAvatar) ? hostAvatar : "";
  const preview: PreviewData = useMemo(() => {
    if (hostPreview) return { a: hostPreview.a, b: hostPreview.b, married_y: hostPreview.married_y, hostPhoto };
    if (form) return { a: form.a, b: form.b, married_y: form.married_y, hostPhoto };
    return { ...DEMO, hostPhoto };
  }, [form, hostPreview, hostPhoto]);

  const frame = (hero: ReactNode, main: ReactNode, rail: ReactNode) => (
    <div className="flex flex-col gap-5 pb-12">
      <div className="mx-auto w-full max-w-[1076px]">{hero}</div>
      <div className="mx-auto flex w-full max-w-[1076px] flex-col gap-4 md:flex-row md:items-start lg:gap-7">
        <main className="flex w-full min-w-0 flex-col gap-4 md:max-w-2xl md:flex-1">{main}</main>
        <RailPortal>{rail}</RailPortal>
      </div>
    </div>
  );

  const previewCard = (
    <section className="rounded-card border border-line bg-space-2 p-4 md:p-5" aria-label="Your thumbnail and episode frame">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[16px] font-bold text-ink">{hostPreview ? "Their frame" : form ? "Your frame, live" : "What an episode looks like"}</h2>
        <Segmented label="Show" value={tab} onChange={(v) => setTab(v === "frame" ? "frame" : "thumb")}
          options={[{ value: "thumb", label: "Thumbnail" }, { value: "frame", label: "Episode frame" }]} />
      </div>
      <div className="mt-3">
        {tab === "thumb" ? <CastThumb data={preview} /> : <CastFrame data={preview} />}
      </div>
      <p className="mt-2 text-[12.5px] leading-snug text-ink-3">
        {tab === "thumb"
          ? "The two portraits either side, desaturated, with the years you have been married as the hook. YouTube shows this at a thumbnail’s size, so the faces and the number carry it."
          : "Both of you side by side, the host below, and one timeline each: your birth, the wedding, your milestones. Nothing is drawn on the host’s feed; no mark airs during the interview."}
      </p>
    </section>
  );

  const hostCard = host && (
    <section className="rounded-card border border-line bg-space-2 p-4" aria-label="Your host">
      <h2 className="text-[14px] font-semibold text-ink">Your host</h2>
      <div className="mt-3 flex items-center gap-3">
        <Avatar src={host.avatar} name={host.name} className="h-12 w-12" />
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-ink" data-ay-skip="1">{host.name}</p>
          {host.slug && <a className="text-[12.5px] text-ink-2 underline" href={localePath(`/u/${encodeURIComponent(host.slug)}/`)} data-ay-skip="1">@{host.slug}</a>}
        </div>
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">The recording is an encrypted ArtaMeet video call — the room opens fifteen minutes before it starts, from the meeting page.</p>
    </section>
  );

  const hero = <PageHero eyebrow="ArtaCast" title="Come on the show"
    lede={<>The ArtaQuest show where <span data-ay-skip="1">{hostName}</span> talks with couples about how they stayed together. Tell us who you are, invite your other half, see your episode take shape, and pick a time.</>} />;

  if (pageErr) {
    return frame(hero, <EmptyState title="ArtaCast isn’t open right now" body={pageErr} action={<Button href={localePath("/works/")} variant="outline">Look around ArtaQuest</Button>} />, null);
  }
  if (!page) {
    return frame(hero, <section role="status" className="rounded-card border border-line bg-space-2 p-5 text-[13px] text-ink-2">Loading…</section>, null);
  }

  // ── the host (or an operator): their panel sits ABOVE whatever else they are here for. A host
  //    may also ask to appear — on another host's episode — so the request form follows below,
  //    exactly as for any member. ──
  const hostHero = page.is_host ? (
    <PageHero eyebrow="ArtaCast" title={page.hosting ? "Your show" : "The show"}
        lede={page.hosting ? "Couples book any free slot in your calendar. Here is who has asked to come on, and where each episode stands." : "Here is who has asked to come on, and where each episode stands."} />
  ) : null;
  const hostBlock = page.is_host ? (
    <>
        <HostPanel page={page} onPreview={setHostPreview} previewing={hostPreview?.id || 0} />
        {hostPreview && (
          <>
            {previewCard}
            <section className="rounded-card border border-line bg-space-2 p-4 md:p-5">
              <h2 className="text-[16px] font-bold text-ink">The record</h2>
              <dl className="mt-3 grid gap-x-6 gap-y-2 text-[13.5px] sm:grid-cols-2">
                {(["a", "b"] as const).map((s) => (
                  <div key={s}>
                    <dt className="font-semibold text-ink" data-ay-skip="1">{hostPreview[s].name || (s === "a" ? "Unnamed" : "Unnamed partner")}</dt>
                    <dd className="text-ink-2" data-ay-skip="1">{[hostPreview[s].subtitle, hostPreview[s].born, hostPreview[s].place].filter(Boolean).join(" · ")}</dd>
                    {hostPreview[s].rows.length > 0 && <dd className="mt-1 text-ink-2" data-ay-skip="1">{hostPreview[s].rows.map((r) => `${r.y} ${r.l}`).join(" · ")}</dd>}
                  </div>
                ))}
                {hostPreview.married_y > 0 && <div><dt className="font-semibold text-ink">Married</dt><dd className="text-ink-2" data-ay-skip="1">{hostPreview.married_y}</dd></div>}
                {hostPreview.story && <div className="sm:col-span-2"><dt className="font-semibold text-ink">What they wrote</dt><dd className="whitespace-pre-line text-ink-2" data-ay-skip="1">{hostPreview.story}</dd></div>}
              </dl>
            </section>
          </>
        )}
    </>
  ) : null;

  // ── a stranger, or a member who has not asked yet ──
  if (!request || !form) {
    const back = `/artacast/${entry.invite ? `?invite=${encodeURIComponent(entry.invite)}` : ""}`;
    return frame(
      hostHero || hero,
      <>
        {hostBlock}
        {withdrawNote && <p role="status" className="rounded-card border border-line bg-space-2 px-4 py-3 text-[13.5px] text-ink-2">{withdrawNote}</p>}
        {inviteFail && <ErrorNote>{inviteFail}</ErrorNote>}
        <section className="rounded-card border border-line bg-space-2 p-4 md:p-5">
          <h2 className="text-[16px] font-bold text-ink">{page.is_host ? "Appear on an episode yourself" : "How it works"}</h2>
          {page.is_host && <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">Nobody hosts their own episode: your request goes to another host{host ? <> — <span data-ay-skip="1">{host.name}</span></> : null}. Everything else is the same as for any couple.</p>}
          <ol className="mt-3 flex flex-col gap-2 text-[14px] leading-relaxed text-ink-2">
            <li><b className="text-ink">1 · You.</b> Your name, one line in your own words, a photograph — and, if you like, where and when you were born and a few milestones for the timeline.</li>
            <li><b className="text-ink">2 · Your partner.</b> The same for them, and their email: they get a single-use link, sign in as themselves, and are seated in the recording.</li>
            <li><b className="text-ink">3 · Your frame.</b> The thumbnail and the episode frame draw themselves from what you type, live.</li>
            <li><b className="text-ink">4 · A time.</b> Pick any free slot in your host’s calendar{hosts.length > 1 ? " — and choose which host" : ""}. It becomes an ArtaMeet video call in all three calendars, and the episode is recorded and finished for YouTube from there.</li>
          </ol>
          <div className="mt-4">
            {signedIn
              ? <Button onClick={() => void start()} disabled={starting}>{starting ? "One moment…" : "Ask to appear"}</Button>
              : <Button onClick={() => signInTo(back)}>{entry.invite ? "Sign in to join your partner" : "Sign in to ask"}</Button>}
            {!signedIn && <p className="mt-2 text-[12.5px] text-ink-2">Signing in creates a free account in one step — an email code, nothing else.</p>}
            {!page.open && <p className="mt-2 text-[12.5px] text-ink-2">The host’s calendar isn’t open yet. You can still fill everything in; it appears the moment it is.</p>}
          </div>
        </section>
        {previewCard}
        {signedIn && !page.is_host && (
          <section className="rounded-card border border-line bg-space-2 p-4 md:p-5" aria-label="Host the show">
            <h2 className="text-[16px] font-bold text-ink">Would you host?</h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">Anyone can volunteer to host episodes. Couples then choose between hosts, book any free slot in your calendar, and the episode is recorded on your computer and finished automatically.</p>
            <div className="mt-3"><Button variant="outline" onClick={() => { castVolunteer(true, VIEWER_TZ).then(() => window.location.reload()).catch((e) => setPageErr(errText(e, "Couldn’t sign you up to host."))); }}>Volunteer to host</Button></div>
          </section>
        )}
      </>,
      hostCard,
    );
  }

  // ── the couple ──
  const isA = role === "a";
  const confirmed = (request.confirmed || 0) > 0;
  const canBook = isA && confirmed && request.complete.a && request.complete.b && page.open && !!host && !!page.rule;
  const booked = request.meet && request.meet.status !== "cancelled" ? request.meet : null;
  const steps = (
    <section className="rounded-card border border-line bg-space-2 p-4" aria-label="Where you are">
      <h2 className="text-[14px] font-semibold text-ink">Where you are</h2>
      <ul className="mt-3 flex flex-col gap-2">
        <StepRow done={request.complete.a}>{isA ? "Your" : <><span data-ay-skip="1">{request.requester?.name || "Their"}</span>’s</>} details</StepRow>
        <StepRow done={request.complete.b}>{isA ? "Your partner’s" : "Your"} details</StepRow>
        <StepRow done={!!request.partner || request.invite.pending}>{request.partner ? "Partner joined" : request.invite.pending ? "Partner invited — waiting for them" : "Invite your partner"}</StepRow>
        <StepRow done={confirmed}>{confirmed ? <>Confirmed by <span data-ay-skip="1">{hostName}</span></> : <><span data-ay-skip="1">{hostName}</span> confirms the episode</>}</StepRow>
        <StepRow done={!!booked}>{booked ? "Recording booked" : "A recording time"}</StepRow>
      </ul>
      <p className="mt-3 text-[12px] text-ink-3" role="status">
        {saveState === "saving" ? "Saving…" : saveState === "error" ? saveErr : saveState === "saved" ? "Saved" : ""}
      </p>
    </section>
  );
  const miniThumb = (
    <section className="hidden rounded-card border border-line bg-space-2 p-3 lg:block" aria-label="Your thumbnail, live">
      <CastThumb data={preview} />
      <p className="mt-2 text-[12px] text-ink-3">Your thumbnail — it follows every keystroke.</p>
    </section>
  );

  return frame(
    <PageHero eyebrow="ArtaCast" title={booked ? "You’re on the show" : "Come on the show"}
      lede={booked
        ? <>Your recording with <span data-ay-skip="1">{hostName}</span> is booked. You can still polish the frame until then — everything saves as you type.</>
        : isA
        ? <>Fill in the two of you, invite your partner, and pick a time with <span data-ay-skip="1">{hostName}</span>. Everything saves as you type.</>
        : <><span data-ay-skip="1">{request.requester?.name || "Your partner"}</span> asked for you both to appear. Check your own details, add a photo, and see your frame.</>} />,
    <>
      {hostBlock}
      {joinedNote && <p role="status" className="rounded-card border border-yang/30 bg-yang/[0.07] px-4 py-3 text-[13.5px] text-ink">{joinedNote}</p>}
      {inviteFail && <ErrorNote>{inviteFail}</ErrorNote>}
      {booked && (
        <section role="status" className="rounded-card border border-yang/40 bg-yang/[0.06] p-5">
          <CheckGlyph />
          <h2 ref={doneHead} tabIndex={-1} className="mt-3 text-[18px] font-bold text-ink outline-none">Recording booked</h2>
          <p className="mt-2 text-[15px] font-semibold text-ink" data-ay-skip="1">{longInstant(booked.start_ts, VIEWER_TZ)}</p>
          {booked.tz && booked.tz !== VIEWER_TZ && <p className="mt-1 text-[13px] text-ink-2"><span data-ay-skip="1">{clockOnly(booked.start_ts, booked.tz)}</span> for <span data-ay-skip="1">{hostName}</span> in <span data-ay-skip="1">{booked.tz}</span></p>}
          <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
            It is an ordinary ArtaMeet now — in your calendar, in <span data-ay-skip="1">{hostName}</span>’s{request.partner ? <>, and in <span data-ay-skip="1">{request.partner.name}</span>’s</> : ". Your partner is seated the moment they accept the invitation"}. The room opens fifteen minutes before, from the meeting page. You can still change photos and details until then.
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
            On the day: a laptop with a good camera, facing a window or a lamp, each of you on your own device if you can. The host records the episode on their computer; your own camera is recorded on yours at full quality for the editor, and sent on its own afterwards.
          </p>
          {request.stage && (
            <p className="mt-2 text-[13px] font-semibold text-ink" role="status">
              {request.stage === "recorded" && "The episode has been recorded."}
              {request.stage === "finishing" && "The episode has been recorded and is being finished for release."}
              {request.stage === "finished" && "The episode is finished and ready for release."}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button href={booked.url}>Open the meeting</Button>
            <Button href="/calendar/" variant="outline">See it in your calendar</Button>
          </div>
        </section>
      )}

      {previewCard}
      <StoredEpisodes iso />

      {isA && (
        <section className="rounded-card border border-line bg-space-2 p-4 md:p-5" aria-label="You">
          <h2 className="text-[16px] font-bold text-ink">You</h2>
          <p className="mt-1 text-[12.5px] text-ink-3">The left window of the frame.</p>
          <div className="mt-4">
            <SideForm who="you" sideKey="a" side={form.a} photoBusy={photoBusy.a} onChange={(a) => setForm({ ...form, a })} onFile={(f) => void onFile("a", f)} />
          </div>
        </section>
      )}

      <section className="rounded-card border border-line bg-space-2 p-4 md:p-5" aria-label={isA ? "Your partner" : "You"}>
        <h2 className="text-[16px] font-bold text-ink">{isA ? "Your partner" : "You"}</h2>
        <p className="mt-1 text-[12.5px] text-ink-3">The right window of the frame.{isA && !request.partner && " Fill in what you can — they check and correct it when they join."}</p>
        <div className="mt-4">
          <SideForm who={isA ? "them" : "you"} sideKey="b" side={form.b} photoBusy={photoBusy.b} onChange={(b) => setForm({ ...form, b })} onFile={(f) => void onFile("b", f)} />
        </div>
        {photoErr && <div className="mt-3"><ErrorNote>{photoErr}</ErrorNote></div>}

        {isA && (
          <div className="mt-5 border-t border-line pt-4">
            <h3 className="text-[14px] font-semibold text-ink">Invite them</h3>
            {request.partner ? (
              <p className="mt-2 flex items-center gap-2 text-[13.5px] text-ink-2">
                <Avatar src={request.partner.avatar} name={request.partner.name} className="h-6 w-6 text-[11px]" />
                <span><span data-ay-skip="1">{request.partner.name}</span> has joined — they can edit their own side from here on.</span>
              </p>
            ) : (
              <>
                <p className="mt-1 text-[12.5px] leading-snug text-ink-3">They get a single-use link: they sign in as themselves, check their details, and are seated in the recording. Nothing happens until they click.</p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                  <Field label="Their email" className="min-w-0 flex-1">
                    <Input type="email" inputMode="email" autoComplete="off" value={form.b_email} placeholder="partner@example.com" onChange={(e) => setForm({ ...form, b_email: e.target.value })} />
                  </Field>
                  <Button onClick={() => void sendInvite()} disabled={inviteBusy || !form.b_email.trim()} className="shrink-0">
                    {inviteBusy ? "Sending…" : request.invite.pending || inviteUrl ? "Send again" : "Send the invitation"}
                  </Button>
                </div>
                {inviteErr && <div className="mt-2"><ErrorNote>{inviteErr}</ErrorNote></div>}
                {inviteUrl ? (
                  <div className="mt-3 rounded-card border border-line bg-space-1/40 p-3">
                    <p className="text-[13px] text-ink">
                      {inviteSent ? <>Emailed to <span data-ay-skip="1">{request.b_email}</span>. You can also send them the link yourself:</> : "We couldn’t email it from here. Send them the link yourself:"}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <Input readOnly value={inviteUrl} className="min-w-0 flex-1 text-[13px]" onFocus={(e) => e.currentTarget.select()} aria-label="Invitation link" />
                      <Button size="sm" variant="outline" onClick={() => void copyLink()}>{copied ? "Copied" : "Copy"}</Button>
                    </div>
                    <p className="mt-2 text-[12px] text-ink-3">Works once, for 14 days. Sending again replaces it.</p>
                  </div>
                ) : request.invite.pending ? (
                  <p className="mt-2 text-[13px] text-ink-2">Invitation sent <span data-ay-skip="1">{dayHeading(dayKey(request.invite.sent, VIEWER_TZ), false)}</span> to <span data-ay-skip="1">{request.b_email}</span> — waiting for them to click.</p>
                ) : null}
              </>
            )}
          </div>
        )}
      </section>

      {isA && (
        <section className="rounded-card border border-line bg-space-2 p-4 md:p-5" aria-label="The two of you">
          <h2 className="text-[16px] font-bold text-ink">The two of you</h2>
          <div className="mt-4 grid gap-4">
            {hosts.length > 1 && (
              <Field label="Your host" hint={booked ? "The recording is booked with this host." : "Who you would like to talk with. You book a slot in their calendar."}>
                <div role="radiogroup" aria-label="Your host" className="flex flex-col gap-2">
                  {hosts.map((h) => {
                    const on = (request.host?.id || 0) === h.id;
                    return (
                      <button key={h.id} type="button" role="radio" aria-checked={on} disabled={!!booked}
                        onClick={() => { castSave({ host: h.id }).then((r) => setRequest(r.request)).catch((e) => setSaveErr(errText(e, "Couldn’t change the host."))); }}
                        className={cx("flex min-h-[56px] w-full items-center gap-3 rounded-field border p-3 text-start transition-colors duration-150 disabled:opacity-60",
                          on ? "border-yang bg-yang/12" : "border-line hover:border-yin-light")}>
                        <Avatar src={h.avatar} name={h.name} className="h-9 w-9 text-[13px]" />
                        <span className="min-w-0 flex-1 text-[14px] font-semibold text-ink" data-ay-skip="1">{h.name}</span>
                        <span className="shrink-0 text-[12px] text-ink-2">{h.open ? "calendar open" : "not open yet"}</span>
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}
            <Field label="The year you married" optional hint="The thumbnail’s hook — “47 years married” — and the second row of both timelines.">
              <Input inputMode="numeric" value={form.married_y || ""} placeholder="1979" className="w-32 tabular-nums"
                onChange={(e) => setForm({ ...form, married_y: Number(e.target.value.replace(/\D/g, "").slice(0, 4)) || 0 })} />
            </Field>
            <Field label="A few lines for the host" optional hint="How you met, what you would like to talk about. Only the host reads this before the recording.">
              <Textarea rows={4} maxLength={800} value={form.story} placeholder="We met in 1978 at…" onChange={(e) => setForm({ ...form, story: e.target.value })} />
            </Field>
          </div>
        </section>
      )}

      {!booked && (
        <section className="rounded-card border border-line bg-space-2 p-4 md:p-5" aria-label="Pick a recording time">
          <h2 className="text-[16px] font-bold text-ink">Pick a recording time</h2>
          {!isA ? (
            <p className="mt-2 text-[13.5px] text-ink-2"><span data-ay-skip="1">{request.requester?.name || "Your partner"}</span> picks the time; you will be told the moment it is booked, and it lands in your calendar.</p>
          ) : !page.open ? (
            <p className="mt-2 text-[13.5px] text-ink-2"><span data-ay-skip="1">{hostName}</span>’s calendar isn’t open yet. Your request is saved — it appears here the moment it is{hosts.length > 1 ? ", or choose another host above" : ""}.</p>
          ) : request.complete.a && request.complete.b && !confirmed ? (
            <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2" role="status">
              Everything is in. <span data-ay-skip="1">{hostName}</span> looks at your frame and confirms the episode — you get an email the moment they do, and the times open here then.
            </p>
          ) : !(request.complete.a && request.complete.b) ? (
            <p className="mt-2 text-[13.5px] text-ink-2">Once both of you have a name, a line and a photograph, <span data-ay-skip="1">{hostName}</span>’s free times appear here.</p>
          ) : canBook && host && page.rule ? (
            <div className="mt-3"><TimePicker hostSlug={host.slug} hostName={host.name} rule={page.rule} onBook={book} /></div>
          ) : null}
        </section>
      )}

      {isA && (
        <div className="flex items-center justify-end">
          <LinkButton className={cx(LINK_HIT, "text-[12.5px]")} onClick={() => setWithdrawOpen(true)}>Withdraw this request</LinkButton>
          <ConfirmDialog open={withdrawOpen} title="Withdraw your request?" confirmLabel="Withdraw" busy={withdrawing}
            body={booked ? "The recording is cancelled where it can be, your partner is told, and the photographs are deleted. You can ask again later." : "Your details and photographs are deleted. You can ask again later."}
            onConfirm={() => void withdraw()} onCancel={() => setWithdrawOpen(false)} />
        </div>
      )}
    </>,
    <>
      {miniThumb}
      {steps}
      {hostCard}
    </>,
  );
}
