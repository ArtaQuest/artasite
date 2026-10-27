import { useCallback, useEffect, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  AlumniApi, OutreachApi, canOutreach, type AlumniFacets, type AlumniFilter, type AlumniPlatform, type Alumnus, type ProfileSyncItem,
  type OutreachAccount, type OutreachImportResult, type OutreachPlanRow, type OutreachPlatform, type OutreachStat, type OutreachStatus,
} from "../lib/api";
import { Button, Card, ErrorNote, PageHero, Select, SkeletonGrid, StatusNote, Tabs, Textarea, cx } from "../components/ui";
import { SocialIcon } from "../components/SocialLinks";
import NotFound from "./NotFound";
import { cleanHeadline, evidenceChips, istanbulTime, profileHandle, relTime } from "../lib/alumni-format";

/**
 * OUTREACH — the ArtaTask review queue and dashboard (operator 2026-10-15). ADMIN ONLY.
 *
 * Accounts LinkedIn, Facebook, Instagram, X, GitHub and Strava suggested to Arash. Each is included in the study
 * (the phone app later sends a request) or excluded, by hand, here. The page renders NotFound for
 * anyone without manage_options, and that is presentation only: every outreach/* route is 'admin'
 * in Rest::ROUTES, so a member who forces the page open gets 403s and no data.
 */

const PLATFORMS: OutreachPlatform[] = ["linkedin", "facebook", "instagram", "x", "github", "strava"];
const PLATFORM_LABEL: Record<OutreachPlatform, string> = { linkedin: "LinkedIn", facebook: "Facebook", instagram: "Instagram", x: "X", github: "GitHub", strava: "Strava" };
/** What "accepted" means per platform — GitHub and Strava are follow-based, so it is a follow-back. */
const ACCEPT_MEANS: Record<OutreachPlatform, string> = { linkedin: "connection accepted", facebook: "friend request accepted", instagram: "followed back", x: "followed back", github: "followed back", strava: "followed back" };
type View = "review" | "results" | "plan" | "sync" | "search";

const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString());
const local = (utc: string | null) => (utc ? new Date(utc.replace(" ", "T") + "Z").toLocaleString() : "");
function dur(s: number | null): string {
  if (s === null) return "—";
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
}
function download(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Row({ a, picked, onPick, onDecide, onSaved }: {
  a: OutreachAccount; picked: boolean; onPick: (on: boolean) => void;
  onDecide: (s: OutreachStatus) => void; onSaved: (a: OutreachAccount) => void;
}) {
  const [notes, setNotes] = useState(a.notes ?? "");
  const [busy, setBusy] = useState(false);
  const sent = !!a.request_sent_at;
  const save = async () => {
    setBusy(true);
    try { onSaved(await OutreachApi.notes(a.id, notes)); } finally { setBusy(false); }
  };
  return (
    <li className="flex gap-3 border-t border-line px-3 py-3 first:border-t-0">
      <input type="checkbox" className="mt-1" checked={picked} disabled={sent} onChange={(e) => onPick(e.target.checked)} aria-label={`Select ${a.full_name || a.handle}`} />
      {a.photo ? <img src={a.photo_private ? OutreachApi.photoUrl(a.id) : a.photo} alt="" width={48} height={48} loading="lazy" referrerPolicy="no-referrer" className="h-12 w-12 shrink-0 rounded-full object-cover" /> : <span className="h-12 w-12 shrink-0 rounded-full bg-veil/[0.06]" aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold text-ink">{a.full_name || a.handle}</span>
          <span className="text-[13px] text-ink-3">{PLATFORM_LABEL[a.platform]} · {a.profile_url ? <a className="hover:text-yang" href={a.profile_url} target="_blank" rel="noopener noreferrer">@{a.handle}</a> : `@${a.handle}`}</span>
          <span className="text-[12px] text-ink-3">{a.source}</span>
        </div>
        {a.tagline && <p className="text-[13px] italic text-ink-2">{a.tagline}</p>}
        {a.bio && <p className="line-clamp-3 text-[13px] text-ink-3">{a.bio}</p>}
        <p className="mt-1 text-[12px] text-ink-3">
          Mutuals {n(a.mutuals)} · Followers {n(a.followers)} · Following {n(a.following)}{a.connections !== null && ` · Connections ${n(a.connections)}`}
        </p>
        <p className="text-[12px] text-ink-3">
          Found {local(a.discovered_at)}{a.decided_at && ` · Decided ${local(a.decided_at)}`}{a.request_sent_at && ` · Sent ${local(a.request_sent_at)}`}{a.accepted_at && ` · Accepted ${local(a.accepted_at)} (${dur(a.time_to_accept_s)})`}
        </p>
        <div className="mt-2 flex items-start gap-2">
          <Textarea rows={1} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" className="min-h-0 flex-1 text-[13px]" aria-label="Notes" />
          <Button size="sm" variant="outline" onClick={save} disabled={busy || notes === (a.notes ?? "")}>Save notes</Button>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <span className={cx("text-[12px] font-semibold", a.status === "included" ? "text-yang" : "text-ink-3")}>{a.status}</span>
        {sent ? <span className="text-[12px] text-ink-3">Request sent</span> : <>
          {a.status !== "included" && <Button size="sm" onClick={() => onDecide("included")}>Include</Button>}
          {a.status !== "excluded" && <Button size="sm" variant="outline" onClick={() => onDecide("excluded")}>Exclude</Button>}
        </>}
      </div>
    </li>
  );
}

function Review() {
  const [platform, setPlatform] = useState("");
  const [status, setStatus] = useState<OutreachStatus | "">("pending");
  const [items, setItems] = useState<OutreachAccount[] | null>(null);
  const [counts, setCounts] = useState<Record<OutreachStatus, number> | null>(null);
  const [next, setNext] = useState(0);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [err, setErr] = useState("");
  const [imp, setImp] = useState<OutreachImportResult | null>(null);

  const load = useCallback(async (cursor = 0) => {
    setErr("");
    try {
      const r = await OutreachApi.list({ platform, status, cursor: cursor || undefined });
      setItems((prev) => (cursor ? [...(prev ?? []), ...r.items] : r.items));
      setCounts(r.counts); setNext(r.next);
      if (!cursor) setPicked(new Set());
    } catch { setErr("Couldn't load accounts."); }
  }, [platform, status]);
  useEffect(() => { void load(0); }, [load]);

  const decide = async (ids: number[], s: OutreachStatus) => {
    if (!ids.length) return;
    try { await OutreachApi.decide(ids, s); await load(0); } catch { setErr("Couldn't save that decision."); }
  };
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setErr("");
    if (/\.zip$/i.test(f.name)) {
      if (f.size > 50 * 1024 * 1024) { setErr("That zip is larger than 50 MB."); return; }
      try { setImp(await OutreachApi.importZip(f)); await load(0); } catch (x) { setErr(x instanceof Error && x.message ? `Import failed: ${x.message}` : "Import failed."); }
      return;
    }
    if (f.size > 2 * 1024 * 1024) { setErr("That CSV is larger than 2 MB."); return; }
    try { setImp(await OutreachApi.importCsv(await f.text())); await load(0); } catch { setErr("Import failed."); }
  };
  const exportView = async () => {
    try { const r = await OutreachApi.exportCsv({ platform, status }); download(r.filename, r.csv); } catch { setErr("Export failed."); }
  };
  const template = async () => {
    try { const r = await OutreachApi.template(); download(r.filename, r.csv); } catch { setErr("Couldn't fetch the template."); }
  };

  const total = counts ? counts.pending + counts.included + counts.excluded : 0;
  const statusTabs = [
    { key: "", label: `All (${total})` },
    ...(["pending", "included", "excluded"] as OutreachStatus[]).map((s) => ({ key: s, label: `${s[0].toUpperCase()}${s.slice(1)} (${counts?.[s] ?? 0})` })),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Tabs tabs={statusTabs} active={status} onChange={(k) => setStatus(k as OutreachStatus | "")} label="Status" />
        <Select label="Platform" value={platform} onChange={setPlatform} options={[{ value: "", label: "All platforms" }, ...PLATFORMS.map((p) => ({ value: p, label: PLATFORM_LABEL[p] }))]} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!picked.size} onClick={() => decide([...picked], "included")}>Include selected</Button>
        <Button size="sm" variant="outline" disabled={!picked.size} onClick={() => decide([...picked], "excluded")}>Exclude selected</Button>
        <Button size="sm" variant="ghost" disabled={!picked.size} onClick={() => decide([...picked], "pending")}>Back to pending</Button>
        <span className="flex-1" />
        <label className="cursor-pointer text-[13px] font-semibold text-ink-2 hover:text-yang">
          Import CSV or zip<input type="file" accept=".csv,text/csv,.zip,application/zip" className="sr-only" onChange={onFile} />
        </label>
        <Button size="sm" variant="ghost" onClick={exportView}>Export this view</Button>
        <Button size="sm" variant="ghost" onClick={template}>Template</Button>
      </div>
      {imp && (
        <StatusNote className="py-2 text-start">
          Import: {imp.inserted} inserted, {imp.updated} updated{"photos" in imp ? `, ${(imp as { photos: number }).photos} photos stored` : ""}, {imp.errors.length} errors.
          {imp.errors.slice(0, 50).map((e) => <span key={e.row} className="block">Row {e.row}: {e.error}</span>)}
        </StatusNote>
      )}
      {err && <ErrorNote>{err}</ErrorNote>}
      {items === null ? <SkeletonGrid count={4} media={false} /> : !items.length ? <StatusNote>Nothing here.</StatusNote> : (
        <Card className="p-0">
          <ul>
            {items.map((a) => (
              <Row key={a.id} a={a} picked={picked.has(a.id)}
                onPick={(on) => setPicked((p) => { const s = new Set(p); if (on) s.add(a.id); else s.delete(a.id); return s; })}
                onDecide={(s) => decide([a.id], s)}
                onSaved={(u) => setItems((prev) => (prev ?? []).map((x) => (x.id === u.id ? u : x)))} />
            ))}
          </ul>
        </Card>
      )}
      {next > 0 && <Button variant="outline" onClick={() => load(next)}>Older</Button>}
    </div>
  );
}

function Results() {
  const [rows, setRows] = useState<OutreachStat[] | null>(null);
  useEffect(() => { OutreachApi.stats().then((r) => setRows(r.platforms)).catch(() => setRows([])); }, []);
  if (rows === null) return <SkeletonGrid count={4} media={false} />;
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-[13px]">
        <thead><tr className="text-start text-ink-3">{["Platform", "Pending", "Included", "Excluded", "Sent", "Accepted", "Acceptance rate", "Time to accept (median)", "(mean)"].map((h) => <th key={h} className="px-3 py-2 text-start font-semibold">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.platform} className="border-t border-line">
              <td className="px-3 py-2"><span className="font-semibold text-ink">{PLATFORM_LABEL[r.platform]}</span><span className="block text-[11px] text-ink-3">accepted = {ACCEPT_MEANS[r.platform]}</span></td>
              <td className="px-3 py-2">{n(r.pending)}</td><td className="px-3 py-2">{n(r.included)}</td><td className="px-3 py-2">{n(r.excluded)}</td>
              <td className="px-3 py-2">{n(r.sent)}</td><td className="px-3 py-2">{n(r.accepted)}</td>
              <td className="px-3 py-2">{r.acceptance_rate === null ? "—" : `${(r.acceptance_rate * 100).toFixed(1)}%`}</td>
              <td className="px-3 py-2">{dur(r.tta_median_s)}</td><td className="px-3 py-2">{dur(r.tta_mean_s)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Plan() {
  const [rows, setRows] = useState<OutreachPlanRow[] | null>(null);
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const load = useCallback(() => OutreachApi.plan().then((r) => {
    setRows(r.platforms); setCaps(Object.fromEntries(r.platforms.map((p) => [p.platform, String(p.daily_cap)])));
  }).catch(() => setRows([])), []);
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    try {
      await OutreachApi.setCaps(Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, Number(v) || 0])) as Partial<Record<OutreachPlatform, number>>);
      setMsg("Daily caps saved."); await load();
    } catch { setMsg("Couldn't save the caps."); }
  };
  if (rows === null) return <SkeletonGrid count={4} media={false} />;
  return (
    <div className="flex flex-col gap-3">
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-[13px]">
          <thead><tr className="text-ink-3">{["Platform", "Daily cap", "Sent today (UTC)", "Remaining today", "Queued (included, not sent)", "Days to clear"].map((h) => <th key={h} className="px-3 py-2 text-start font-semibold">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.platform} className="border-t border-line">
                <td className="px-3 py-2 font-semibold text-ink">{PLATFORM_LABEL[r.platform]}</td>
                <td className="px-3 py-2"><input type="number" min={0} max={100} value={caps[r.platform] ?? ""} onChange={(e) => setCaps((c) => ({ ...c, [r.platform]: e.target.value }))} className="w-16 rounded border border-line bg-transparent px-1" aria-label={`${PLATFORM_LABEL[r.platform]} daily cap`} /></td>
                <td className="px-3 py-2">{n(r.sent_today)}</td><td className="px-3 py-2">{n(r.remaining_today)}</td>
                <td className="px-3 py-2">{n(r.queued)}</td><td className="px-3 py-2">{r.days_to_clear === null ? "—" : r.days_to_clear}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <div className="flex items-center gap-3"><Button size="sm" onClick={save}>Save daily caps</Button>{msg && <span className="text-[13px] text-ink-3">{msg}</span>}</div>
    </div>
  );
}

/** PROFILE SYNC — mirror each member's public profile (full name, /u/ URL) onto their WP user
 *  record (AQ\ProfileSync). Preview writes nothing; Apply needs an explicit confirm and only
 *  touches the users that Preview listed, in batches of 200. No logins or emails are shown. */
function ProfileSync() {
  const [items, setItems] = useState<ProfileSyncItem[] | null>(null);
  const [stats, setStats] = useState({ scanned: 0, bots: 0 });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState("");
  const preview = async () => {
    setBusy(true); setMsg(""); setConfirming(false);
    try {
      const all: ProfileSyncItem[] = []; let scanned = 0, bots = 0; let cursor: number | null = 0;
      while (cursor !== null) {
        const r = await OutreachApi.syncPreview(cursor);
        all.push(...r.items); scanned += r.scanned; bots += r.bots_skipped; cursor = r.next;
      }
      setItems(all); setStats({ scanned, bots });
    } catch { setMsg("Couldn't load the preview."); }
    setBusy(false);
  };
  const apply = async () => {
    if (!items?.length) return;
    setBusy(true); setConfirming(false);
    const tot = { updated: 0, unchanged: 0, skipped: 0, fields: 0 };
    try {
      const ids = items.map((i) => i.id);
      for (let k = 0; k < ids.length; k += 200) {
        const r = await OutreachApi.syncApply(ids.slice(k, k + 200));
        tot.updated += r.updated; tot.unchanged += r.unchanged; tot.skipped += r.skipped; tot.fields += r.fields;
      }
      setMsg(`Applied: ${tot.updated} users updated (${tot.fields} fields), ${tot.unchanged} already in sync, ${tot.skipped} skipped.`);
      setItems(null);
    } catch { setMsg(`Apply stopped partway: ${tot.updated} users updated so far. Run Preview again.`); }
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-ink-3">Copies each member's public profile (full name, profile address) onto their WordPress user. A name a member chose themselves is kept. Sign-in names, emails and roles are never changed; bots are skipped.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={preview} disabled={busy}>Preview</Button>
        {items && items.length > 0 && !confirming && <Button size="sm" onClick={() => setConfirming(true)} disabled={busy}>Apply…</Button>}
        {confirming && items && (
          <span className="flex items-center gap-2 text-[13px]">
            Update {items.length} user{items.length === 1 ? "" : "s"}?
            <Button size="sm" onClick={apply} disabled={busy}>Confirm apply</Button>
            <Button size="sm" onClick={() => setConfirming(false)} disabled={busy}>Cancel</Button>
          </span>
        )}
        {msg && <span className="text-[13px] text-ink-3">{msg}</span>}
      </div>
      {items && <p className="text-[13px] text-ink-3">{stats.scanned} users scanned, {items.length} would change, {stats.bots} bots skipped.</p>}
      {items && items.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-[13px]">
            <thead><tr className="text-ink-3">{["User", "Field", "Now", "Becomes"].map((h) => <th key={h} className="px-3 py-2 text-start font-semibold">{h}</th>)}</tr></thead>
            <tbody>
              {items.flatMap((it) => it.changes.map((c, j) => (
                <tr key={`${it.id}-${c.field}`} className="border-t border-line">
                  <td className="px-3 py-2">{j === 0 ? `#${it.id} @${it.handle}` : ""}</td>
                  <td className="px-3 py-2 font-mono">{c.field}</td>
                  <td className="px-3 py-2 text-ink-3">{c.old || "—"}</td>
                  <td className="px-3 py-2 text-ink">{c.new}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}


// ── ArtaSearch — the alumni directory (src/AlumniSearch.php). Rows arrive from the scan box via the
// key-protected ingest route; this tab only reads, filters, exports and copies a profile to the queue.
const ALUMNI_PLATFORMS: AlumniPlatform[] = ["linkedin", "instagram", "facebook", "researchgate", "youtube", "github", "x"];
const ALUMNI_LABEL: Record<AlumniPlatform, string> = { linkedin: "LinkedIn", instagram: "Instagram", facebook: "Facebook", researchgate: "ResearchGate", youtube: "YouTube", github: "GitHub", x: "X" };
const QUEUEABLE = new Set<AlumniPlatform>(["linkedin", "instagram", "facebook", "github", "x"]);

/** 1.25.9: the stored picture of a HIGH-confidence matched account (Instagram > LinkedIn > Facebook > GitHub), else initials. */
function AlumniPhoto({ a, size }: { a: Alumnus; size: number }) {
  const [bad, setBad] = useState(false);
  const initials = a.full_name.split(/\s+/).filter(Boolean).map((w) => w[0]).filter((_, i, l) => i === 0 || i === l.length - 1).join("").toUpperCase();
  if (a.photo_private && !bad) {
    return <img src={AlumniApi.photoUrl(a.id)} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" onError={() => setBad(true)}
      style={{ width: size, height: size }} className="rounded-full object-cover" />;
  }
  return <span aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size / 2.8) }}
    className="grid place-items-center rounded-full border border-line bg-space-1 font-semibold text-ink-2">{initials}</span>;
}

const MAIL_ICON = <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></svg>;
const PF_FILTER: { k: AlumniPlatform | "email"; label: string }[] = [
  { k: "linkedin", label: "LinkedIn" }, { k: "instagram", label: "Instagram" }, { k: "x", label: "X" }, { k: "facebook", label: "Facebook" },
  { k: "github", label: "GitHub" }, { k: "youtube", label: "YouTube" }, { k: "researchgate", label: "ResearchGate" }, { k: "email", label: "Email" },
];
const ICON_BTN = "grid h-7 w-7 place-items-center rounded-full border border-line bg-space-1 text-ink-2 hover:border-yang hover:text-yang";

/** The person's emails, best first: the confident-only list (1.25.7) or the older single public_email. */
function alumniEmails(a: Alumnus): { email: string; source: string; confidence: string }[] {
  if (a.emails && a.emails.length > 0) return a.emails.map((e) => ({ email: e.email, source: e.source, confidence: e.confidence ?? "" }));
  return a.public_email ? [{ email: a.public_email, source: a.email_source ?? "", confidence: "high" }] : [];
}

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yang";
const PIN_ICON = <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 21s-7-6.1-7-11.5A7 7 0 0 1 19 9.5C19 14.9 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></svg>;
const COPY_ICON = <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
const CHECK_ICON = <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;

/** A small icon button that copies text and confirms with a tick for 1.5 s. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(() => {});
  };
  return (
    <button type="button" onClick={copy} aria-label={done ? "Copied" : label} title={done ? "Copied" : label}
      className={cx("grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-veil/5 hover:text-ink", FOCUS)}>
      {done ? CHECK_ICON : COPY_ICON}
    </button>
  );
}

/** "Followed 3 days ago" with the exact Istanbul time on hover. */
function When({ label, at }: { label: string; at: string | null | undefined }) {
  const rel = relTime(at);
  if (!rel) return null;
  return <span title={istanbulTime(at)}>{label} {rel}</span>;
}

/** Arash 2026-10-23: the LIST stays minimal — one row per person: name, department, year, social icon links and an
 *  envelope icon (mailto: the first email; all of them in the detail). No picture in the list. Clicking the row opens the
 *  detail panel: the stored photo (Instagram > LinkedIn > Facebook > GitHub, initials otherwise) and every detail.
 *  1.25.19 (Arash 2026-10-27 "also improve the UI"): the detail panel reads like a profile card — clean header (name,
 *  department · class of, short headline, self-stated location), one row per account (icon, platform, handle, evidence
 *  chips with the raw code on hover, copy), relative times with Istanbul time on hover, no repeated "confidence: high"
 *  (only HIGH is ever stored), and one action bar (Follow/Unfollow + Send to queue). */
export function AlumniRow({ a }: { a: Alumnus }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const have = ALUMNI_PLATFORMS.filter((p) => a.profiles[p]);
  const queueable = have.filter((p) => QUEUEABLE.has(p));
  const emails = alumniEmails(a);
  const [followedAt, setFollowedAt] = useState<string | null>(a.followed_at ?? null);
  const [fBusy, setFBusy] = useState(false);
  const [fMsg, setFMsg] = useState("");
  // Follow (1.25.15, Arash 2026-10-24): open every social link in its own tab SYNCHRONOUSLY inside the click, and keep this
  // page where it is. Tested in Chrome: script cannot make a tab open in the background — synthetic ⌘/Ctrl-clicks on
  // anchors are ignored and window.focus() cannot take focus back — but window.open() honours the modifier of the REAL
  // click, so ⌘-click (macOS) / Ctrl-click Follow opens them all behind this page. A plain click opens them in front.
  // Chrome lets one click open ONE pop-up unless pop-ups are allowed for artaquest.com, hence the hint below.
  const toggleFollow = (e: ReactMouseEvent<HTMLElement>) => {
    e.preventDefault();
    const follow = !followedAt;
    if (follow) {
      const urls = have.map((p) => a.profiles[p]?.url).filter((u): u is string => !!u);
      const x = window.scrollX, y = window.scrollY;
      for (const u of urls) window.open(u, "_blank", "noopener,noreferrer");
      window.focus();
      if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
      const bg = e.metaKey || e.ctrlKey;
      if (urls.length > 1) setFMsg(`Opened ${urls.length} links${bg ? " behind this page" : ""}. Only one tab? Allow pop-ups for artaquest.com (address-bar icon) once.${bg ? "" : " Tip: ⌘/Ctrl-click Follow to keep this page in front."}`);
      else setFMsg(urls.length === 1 && !bg ? "Tip: ⌘/Ctrl-click Follow to open links behind this page." : "");
    } else setFMsg("");
    const prev = followedAt;
    setFollowedAt(follow ? new Date().toISOString().slice(0, 19).replace("T", " ") : null); setFBusy(true);
    AlumniApi.follow(a.id, follow).then((r) => setFollowedAt(r.followed_at)).catch(() => { setFollowedAt(prev); setFMsg("Couldn't save follow state."); }).finally(() => setFBusy(false));
  };
  const toQueue = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await AlumniApi.toQueue(a.id, queueable);
      setMsg(`${r.inserted} added to Review${r.updated ? `, ${r.updated} already there` : ""}`);
    } catch { setMsg("Couldn't add to the queue."); }
    setBusy(false);
  };
  const followTitle = followedAt
    ? `Followed ${istanbulTime(followedAt) || followedAt} — click to mark as not followed`
    : have.length ? `Open all ${have.length} social link(s) in new tabs and mark as followed (⌘/Ctrl-click: open them behind this page)` : "Mark as followed";
  const followBtn = (extra = "") => (
    <button type="button" onClick={toggleFollow} disabled={fBusy} aria-pressed={!!followedAt} title={followTitle}
      className={cx("h-7 rounded-full px-3 text-[12px] font-semibold disabled:opacity-60", FOCUS, extra,
        followedAt ? "border border-line bg-veil/5 text-ink-3 hover:text-ink" : "bg-yang text-on-accent hover:bg-yin hover:text-white")}>
      {followedAt ? "Unfollow" : "Follow"}
    </button>
  );
  const headline = cleanHeadline(a.full_name, a.headline, a.employer);
  const location = (a.location || "").trim() || [a.city, a.country].filter(Boolean).join(", ");
  const locFrom = (a.location || "").trim() && a.location_source ? `Stated on ${ALUMNI_LABEL[a.location_source as AlumniPlatform] ?? a.location_source}` : "From the matched profile";
  const panelId = `alumni-detail-${a.id}`;
  return (
    <li className="border-b border-line last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={panelId} aria-label={`${a.full_name}: ${open ? "hide" : "show"} details`}
          className={cx("min-w-0 flex-1 rounded text-left", FOCUS)}>
          <span className="font-semibold text-ink hover:text-yang">{a.full_name}</span>
          <span className="ml-2 text-[13px] text-ink-3">{a.department} · {a.grad_year}</span>
        </button>
        <div className="flex flex-wrap items-center gap-1.5">
          {have.map((p) => (
            <a key={p} href={a.profiles[p]?.url} target="_blank" rel="noopener noreferrer" title={ALUMNI_LABEL[p]} aria-label={`${a.full_name} on ${ALUMNI_LABEL[p]}`} className={cx(ICON_BTN, FOCUS)}>
              <SocialIcon k={p} size={14} />
            </a>
          ))}
          {emails.length > 0 && (
            <a href={`mailto:${emails[0].email}`} className={cx(ICON_BTN, FOCUS)} aria-label={`Email ${a.full_name}`}
              title={emails[0].email + (emails.length > 1 ? ` (+${emails.length - 1} more in details)` : "")}>{MAIL_ICON}</a>
          )}
          {followBtn("ml-1")}
        </div>
      </div>
      {fMsg && <p className="px-3 pb-2 text-[12px] text-ink-3" role="status">{fMsg}</p>}
      {open && (
        <div id={panelId} className="border-t border-line bg-space-1 px-3 py-4 text-[13px] sm:px-4">
          <div className="flex items-start gap-4">
            <div className="shrink-0 text-center">
              <span className="block sm:hidden"><AlumniPhoto a={a} size={64} /></span>
              <span className="hidden sm:block"><AlumniPhoto a={a} size={88} /></span>
              {a.photo_private && a.photo_meta && (
                <a href={a.photo_meta.profile_url} target="_blank" rel="noopener noreferrer"
                  title={`Photo from ${ALUMNI_LABEL[a.photo_meta.platform] ?? a.photo_meta.platform}${istanbulTime(a.photo_meta.fetched_at) ? `, fetched ${istanbulTime(a.photo_meta.fetched_at)}` : ""}`}
                  className={cx("mt-1 inline-block rounded text-[11px] text-ink-3 hover:text-yang", FOCUS)}>
                  via {ALUMNI_LABEL[a.photo_meta.platform] ?? a.photo_meta.platform}
                </a>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-[17px] font-semibold leading-tight text-ink">{a.full_name}</h3>
              <p className="mt-0.5 text-ink-2">{a.department}{a.department && a.grad_year ? " · " : ""}{a.grad_year ? `Class of ${a.grad_year}` : ""}</p>
              {headline && <p className="mt-1 break-words text-ink" title={a.headline || undefined}>{headline}</p>}
              {location && (
                <p className="mt-1 flex items-center gap-1 text-ink-3" title={locFrom}>
                  {PIN_ICON}<span>{location}</span><span className="sr-only"> ({locFrom})</span>
                </p>
              )}
            </div>
          </div>

          <section className="mt-4" aria-label="Accounts">
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Accounts{have.length > 0 && ` · ${have.length}`}</h4>
            {have.length === 0 ? <p className="text-ink-3">No confirmed accounts yet.</p> : (
              <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
                {have.map((p) => {
                  const pr = a.profiles[p]!;
                  const chips = evidenceChips(pr.evidence);
                  return (
                    <li key={p} className="flex flex-col gap-1.5 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
                      <div className="flex min-w-0 items-center gap-2 sm:w-[46%] sm:shrink-0">
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-line text-ink-2"><SocialIcon k={p} size={14} /></span>
                        <span className="w-[78px] shrink-0 text-[12px] text-ink-3">{ALUMNI_LABEL[p]}</span>
                        <a href={pr.url} target="_blank" rel="noopener noreferrer" title={pr.title ? `${pr.title}\n${pr.url}` : pr.url}
                          className={cx("min-w-0 truncate rounded font-medium text-ink hover:text-yang hover:underline", FOCUS)}>
                          {profileHandle(p, pr.url)}<span className="sr-only"> (opens in a new tab)</span>
                        </a>
                        <span className="ml-auto sm:hidden"><CopyButton text={pr.url} label={`Copy ${ALUMNI_LABEL[p]} link`} /></span>
                      </div>
                      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 pl-9 sm:pl-0" title={pr.evidence ? `Evidence code: ${pr.evidence}` : undefined}>
                        {chips.map((c) => (
                          <span key={c} className="rounded-full border border-line bg-veil/5 px-2 py-0.5 text-[11px] text-ink-2">{c}</span>
                        ))}
                      </div>
                      <span className="hidden sm:block"><CopyButton text={pr.url} label={`Copy ${ALUMNI_LABEL[p]} link`} /></span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {emails.length > 0 && (
            <section className="mt-3" aria-label="Emails">
              <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Email{emails.length > 1 && `s · ${emails.length}`}</h4>
              <ul className="space-y-1">
                {emails.map((e) => (
                  <li key={e.email} className="flex flex-wrap items-center gap-2">
                    <span className="text-ink-3">{MAIL_ICON}</span>
                    <a className={cx("rounded font-medium text-ink hover:text-yang hover:underline", FOCUS)} href={`mailto:${e.email}`}>{e.email}</a>
                    {e.source === "roster"
                      ? <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-3" title="Given in the alumni roster">from roster</span>
                      : e.source
                        ? <a className={cx("rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-3 hover:text-yang", FOCUS)} href={e.source} target="_blank" rel="noopener noreferrer" title={e.source}>
                            published on {(() => { try { return new URL(e.source).hostname.replace(/^www\./, ""); } catch { return "source"; } })()}
                          </a>
                        : null}
                    <CopyButton text={e.email} label="Copy email" />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Button size="sm" variant={followedAt ? "subtle" : "primary"} onClick={toggleFollow} disabled={fBusy} aria-pressed={!!followedAt} title={followTitle} className={FOCUS}>
              {followedAt ? "Unfollow" : "Follow"}
            </Button>
            {queueable.length > 0 && <Button size="sm" variant="outline" onClick={toQueue} disabled={busy} className={FOCUS}>{busy ? "Sending…" : "Send to queue"}</Button>}
            {msg && <span className="text-[12px] text-ink-2" role="status">{msg}</span>}
            <span className="flex flex-wrap gap-x-2 text-[12px] text-ink-3 sm:ml-auto">
              {followedAt && <><When label="Followed" at={followedAt} /><span aria-hidden>·</span></>}
              <When label="Updated" at={a.updated_at} />
            </span>
          </div>
        </div>
      )}
    </li>
  );
}

function AlumniSearch() {
  const [facets, setFacets] = useState<AlumniFacets | null>(null);
  const [f, setF] = useState<AlumniFilter>({});
  // Arash 2026-10-23 (1.25.13): multi-select platform filter; a person matches only when they have EVERY selected one (AND).
  // Default = none ticked = no filter (everyone).
  const [pfs, setPfs] = useState<string[]>([]);
  useEffect(() => { setF((o) => ({ ...o, platforms: pfs.length === 0 ? undefined : pfs.join(",") })); }, [pfs]);
  const togglePf = (k: string) => setPfs((o) => (o.includes(k) ? o.filter((x) => x !== k) : [...o, k]));
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Alumnus[] | null>(null);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState(0);
  const [err, setErr] = useState("");
  useEffect(() => { AlumniApi.facets().then(setFacets).catch(() => setErr("Couldn't load ArtaSearch.")); }, []);
  useEffect(() => { const t = setTimeout(() => setF((o) => ({ ...o, q })), 300); return () => clearTimeout(t); }, [q]);
  // 1.25.19: free-text location filter (self-stated location, city or country).
  const [loc, setLoc] = useState("");
  useEffect(() => { const t = setTimeout(() => setF((o) => ((o.location ?? "") === loc.trim() ? o : { ...o, location: loc.trim() || undefined })), 300); return () => clearTimeout(t); }, [loc]);
  const load = useCallback(async (cursor: number) => {
    try {
      const r = await AlumniApi.list({ ...f, cursor });
      setItems((old) => (cursor && old ? [...old, ...r.items] : r.items)); setNext(r.next); setTotal(r.total); setErr("");
    } catch { setErr("Couldn't load alumni."); }
  }, [f]);
  useEffect(() => { setItems(null); load(0); }, [load]);
  const set = (k: keyof AlumniFilter) => (v: string) => setF((o) => ({ ...o, [k]: v }));
  const exportCsv = async () => { const r = await AlumniApi.exportCsv(f); download(r.filename, r.csv); };
  const opt = (all: string, list: { value: string | number; n: number }[] = []) =>
    [{ value: "", label: all }, ...list.map((x) => ({ value: String(x.value), label: `${x.value} (${x.n})` }))];
  return (
    <div className="flex flex-col gap-3">
      {facets && (
        <p className="text-[13px] text-ink-3">
          {facets.total.toLocaleString()} alumni · {facets.with_any.toLocaleString()} with a confirmed profile · {ALUMNI_PLATFORMS.map((p) => `${ALUMNI_LABEL[p]} ${facets.platforms[p] ?? 0}`).join(" · ")}
          {facets.synced_at && ` · synced ${local(facets.synced_at)}`}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, employer, title" aria-label="Search alumni"
          className="h-9 min-w-[200px] flex-1 rounded-lg border border-line bg-space-1 px-3 text-[13px] text-ink" />
        <Select label="Year" value={f.year ?? ""} onChange={set("year")} options={opt("All years", facets?.years)} skipOptions />
        <Select label="Department" value={f.department ?? ""} onChange={set("department")} options={opt("All departments", facets?.departments)} skipOptions />
        <Select label="Country" value={f.country ?? ""} onChange={set("country")} options={opt("All countries", facets?.countries)} skipOptions />
        <input value={loc} onChange={(e) => setLoc(e.target.value)} placeholder="Location" aria-label="Filter by location"
          className="h-9 w-[150px] rounded-lg border border-line bg-space-1 px-3 text-[13px] text-ink" />
        <Select label="Followed" value={f.followed ?? ""} onChange={set("followed")} skipOptions
          options={[{ value: "", label: "Followed or not" }, { value: "1", label: "Followed" }, { value: "0", label: "Not followed" }]} />
        <Button size="sm" variant="outline" onClick={exportCsv}>Export CSV</Button>
      </div>
      <fieldset className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-2">
        <legend className="sr-only">Has all of these</legend>
        <span className="mr-1 text-ink-3">Has all of:</span>
        {PF_FILTER.map(({ k, label }) => {
          const on = pfs.includes(k);
          const n = k === "email" ? facets?.with_email : facets?.platforms[k as AlumniPlatform];
          return (
            <label key={k} className={`flex cursor-pointer items-center gap-1 rounded-full border px-2 py-1 ${on ? "border-yang text-ink" : "border-line text-ink-3"}`}>
              <input type="checkbox" className="sr-only" checked={on} onChange={() => togglePf(k)} />
              {k === "email" ? MAIL_ICON : <SocialIcon k={k} size={13} />}
              <span>{label}{n !== undefined && ` (${n})`}</span>
            </label>
          );
        })}
        {pfs.length > 0 && (
          <button type="button" className="ml-1 text-ink-3 hover:text-yang" onClick={() => setPfs([])}>
            Clear
          </button>
        )}
        {pfs.length === 0 && <span className="text-ink-3">(none ticked = everyone)</span>}
      </fieldset>
      {err && <ErrorNote>{err}</ErrorNote>}
      {items === null ? <SkeletonGrid /> : items.length === 0 ? <StatusNote>No alumni match. Rows arrive from the ArtaSearch scan.</StatusNote> : (
        <>
          <p className="text-[13px] text-ink-3">{total.toLocaleString()} match</p>
          <Card className="p-0"><ul aria-label="Alumni">{items.map((a) => <AlumniRow key={a.id} a={a} />)}</ul></Card>
          {next > 0 && <Button size="sm" variant="outline" onClick={() => load(next)}>Load more</Button>}
        </>
      )}
    </div>
  );
}

export default function Outreach() {
  const [view, setView] = useState<View>("review");
  if (!canOutreach()) return <NotFound />;
  return (
    <div className="flex flex-col gap-5">
      <PageHero title="Outreach" lede="Accounts the platforms suggested. Include one to add it to the study (ArtaTask will send the request); exclude to drop it. Nothing is sent from this page." />
      <Tabs tabs={[{ key: "review", label: "Review" }, { key: "results", label: "Results" }, { key: "plan", label: "Plan" }, { key: "sync", label: "Profile sync" }, { key: "search", label: "Search" }]} active={view} onChange={(k) => setView(k as View)} label="Outreach" />
      {view === "review" ? <Review /> : view === "results" ? <Results /> : view === "plan" ? <Plan /> : view === "sync" ? <ProfileSync /> : <AlumniSearch />}
    </div>
  );
}
