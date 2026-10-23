import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import {
  AlumniApi, OutreachApi, canOutreach, type AlumniFacets, type AlumniFilter, type AlumniPlatform, type Alumnus, type ProfileSyncItem,
  type OutreachAccount, type OutreachImportResult, type OutreachPlanRow, type OutreachPlatform, type OutreachStat, type OutreachStatus,
} from "../lib/api";
import { Button, Card, ErrorNote, PageHero, Select, SkeletonGrid, StatusNote, Tabs, Textarea, cx } from "../components/ui";
import { SocialIcon } from "../components/SocialLinks";
import NotFound from "./NotFound";

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

function AlumniCard({ a }: { a: Alumnus }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const have = ALUMNI_PLATFORMS.filter((p) => a.profiles[p]);
  const queueable = have.filter((p) => QUEUEABLE.has(p));
  const first = have[0];
  const toQueue = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await AlumniApi.toQueue(a.id, queueable);
      setMsg(`${r.inserted} added to Review${r.updated ? `, ${r.updated} already there` : ""}`);
    } catch { setMsg("Couldn't add to the queue."); }
    setBusy(false);
  };
  return (
    <Card className="flex gap-3 p-3">
      {a.photo ? (
        <a href={a.profiles.github?.url} target="_blank" rel="noopener noreferrer" className="shrink-0" aria-label={`${a.full_name} on GitHub`}>
          <img src={a.photo} alt="" width={56} height={56} loading="lazy" referrerPolicy="no-referrer" className="h-14 w-14 rounded-full object-cover" />
        </a>
      ) : first ? (
        <a href={a.profiles[first]?.url} target="_blank" rel="noopener noreferrer" aria-label={`${a.full_name} on ${ALUMNI_LABEL[first]}`} className="grid h-14 w-14 shrink-0 place-items-center rounded-full border border-line bg-space-1 text-ink-2 hover:text-yang">
          <SocialIcon k={first} size={26} />
        </a>
      ) : <span className="h-14 w-14 shrink-0 rounded-full bg-veil/[0.06]" aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-ink">{a.full_name}</div>
        <div className="text-[13px] text-ink-3">{a.department} · {a.grad_year}{(a.city || a.country) && ` · ${[a.city, a.country].filter(Boolean).join(", ")}`}</div>
        {(a.headline || a.employer) && <p className="line-clamp-2 text-[13px] text-ink-2">{a.headline || a.employer}</p>}
        {a.emails && a.emails.length > 0 ? a.emails.map((e) => (
          <p key={e.email} className="text-[12px] text-ink-3">
            {e.email} · {e.source === "roster" ? <span title="Given in the alumni roster">roster</span>
              : <a className="hover:text-yang" href={e.source} target="_blank" rel="noopener noreferrer" title="Published on this page (high confidence: carries the name, on the person's own page)">source</a>}
          </p>
        )) : a.public_email && <p className="text-[12px] text-ink-3">{a.public_email} · <a className="hover:text-yang" href={a.email_source} target="_blank" rel="noopener noreferrer">source</a></p>}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {have.map((p) => (
            <a key={p} href={a.profiles[p]?.url} target="_blank" rel="noopener noreferrer" title={a.profiles[p]?.title || ALUMNI_LABEL[p]} aria-label={ALUMNI_LABEL[p]}
              className="grid h-8 w-8 place-items-center rounded-full border border-line bg-space-1 text-ink-2 hover:border-yang hover:text-yang">
              <SocialIcon k={p} size={16} />
            </a>
          ))}
          {queueable.length > 0 && <Button size="sm" variant="outline" onClick={toQueue} disabled={busy}>Send to queue</Button>}
          {msg && <span className="text-[12px] text-ink-3">{msg}</span>}
        </div>
      </div>
    </Card>
  );
}

function AlumniSearch() {
  const [facets, setFacets] = useState<AlumniFacets | null>(null);
  const [f, setF] = useState<AlumniFilter>({ platform: "any" });
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Alumnus[] | null>(null);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState(0);
  const [err, setErr] = useState("");
  useEffect(() => { AlumniApi.facets().then(setFacets).catch(() => setErr("Couldn't load ArtaSearch.")); }, []);
  useEffect(() => { const t = setTimeout(() => setF((o) => ({ ...o, q })), 300); return () => clearTimeout(t); }, [q]);
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
        <Select label="Platform" value={f.platform ?? ""} onChange={set("platform")} skipOptions
          options={[{ value: "", label: "Everyone" }, { value: "any", label: "Any profile" }, ...ALUMNI_PLATFORMS.map((p) => ({ value: p, label: ALUMNI_LABEL[p] }))]} />
        <Button size="sm" variant="outline" onClick={exportCsv}>Export CSV</Button>
      </div>
      {err && <ErrorNote>{err}</ErrorNote>}
      {items === null ? <SkeletonGrid /> : items.length === 0 ? <StatusNote>No alumni match. Rows arrive from the ArtaSearch scan.</StatusNote> : (
        <>
          <p className="text-[13px] text-ink-3">{total.toLocaleString()} match</p>
          <div className="grid gap-3 md:grid-cols-2">{items.map((a) => <AlumniCard key={a.id} a={a} />)}</div>
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
