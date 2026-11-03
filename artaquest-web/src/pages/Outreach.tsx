import { useCallback, useEffect, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";
import {
  AlumniApi, ApiError, canOutreach, type AlumniFacets, type AlumniFilter, type AlumniPlatform, type AlumniSort, type Alumnus, type LinkedInQuota,
} from "../lib/api";
import { Button, Card, ErrorNote, PageHero, Select, SkeletonGrid, cx } from "../components/ui";
import { SocialIcon } from "../components/SocialLinks";
import NotFound from "./NotFound";
import { cleanHeadline, ESTIMATE_NOTE, evidenceChips, gpaLabel, istanbulTime, profileHandle, relTime } from "../lib/alumni-format";

/**
 * OUTREACH — ArtaSearch alumni search only (1.25.27; the Review/Results/Plan/Profile-sync tabs were removed from the
 * UI, their routes and data are untouched). ADMIN ONLY. The page renders NotFound for
 * anyone without manage_options, and that is presentation only: every outreach/* route is 'admin'
 * in Rest::ROUTES, so a member who forces the page open gets 403s and no data.
 */


const local = (utc: string | null) => (utc ? new Date(utc.replace(" ", "T") + "Z").toLocaleString() : "");
function download(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

/** 1.25.23 (Arash 2026-10-30): LinkedIn has its own Follow button and a lower WEEKLY quota (rolling 7 days, server-enforced,
 *  set in Rest outreach/alumni/linkedin-quota). One module-level copy so every row's counter updates together. */
let liQuota: LinkedInQuota | null = null;
const liSubs = new Set<() => void>();
let liLoading = false;
const setLiQuota = (q: LinkedInQuota) => { liQuota = q; liSubs.forEach((f) => f()); };
function useLinkedInQuota(): LinkedInQuota | null {
  const q = useSyncExternalStore((f) => { liSubs.add(f); return () => { liSubs.delete(f); }; }, () => liQuota);
  useEffect(() => {
    if (liQuota || liLoading) return;
    liLoading = true;
    AlumniApi.linkedInQuota().then(setLiQuota).catch(() => {}).finally(() => { liLoading = false; });
  }, []);
  return q;
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
  const others = have.filter((p) => p !== "linkedin"); // 1.25.23: the shared Follow never opens or counts LinkedIn
  const queueable = have.filter((p) => QUEUEABLE.has(p));
  const emails = alumniEmails(a);
  const [followedAt, setFollowedAt] = useState<string | null>(a.followed_at ?? null);
  const [fBusy, setFBusy] = useState(false);
  const [fMsg, setFMsg] = useState("");
  const liUrl = (() => { const u = a.profiles.linkedin?.url; try { return u && /^https?:$/.test(new URL(u).protocol) && /(^|\.)linkedin\.com$/i.test(new URL(u).hostname) ? u : undefined; } catch { return undefined; } })();
  const [liAt, setLiAt] = useState<string | null>(a.li_followed_at ?? null);
  const [liBusy, setLiBusy] = useState(false);
  const quota = useLinkedInQuota();
  // 1.25.26: no hard LinkedIn limit — the weekly number is a soft counter only, the button never deactivates.
  const liOver = !liAt && !!quota && quota.remaining <= 0;
  // Follow (1.25.15, Arash 2026-10-24): open every social link in its own tab SYNCHRONOUSLY inside the click, and keep this
  // page where it is. Tested in Chrome: script cannot make a tab open in the background — synthetic ⌘/Ctrl-clicks on
  // anchors are ignored and window.focus() cannot take focus back — but window.open() honours the modifier of the REAL
  // click, so ⌘-click (macOS) / Ctrl-click Follow opens them all behind this page. A plain click opens them in front.
  // Chrome lets one click open ONE pop-up unless pop-ups are allowed for artaquest.com, hence the hint below.
  const toggleFollow = (e: ReactMouseEvent<HTMLElement>) => {
    e.preventDefault();
    const follow = !followedAt;
    if (follow) {
      const urls = others.map((p) => a.profiles[p]?.url).filter((u): u is string => !!u);
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
  // LinkedIn Follow: opens ONLY the LinkedIn profile in the admin's own browser (they follow/connect by hand) and records it
  // toward the weekly counter (soft, never blocks since 1.25.26); unfollow only flips the state, no refund.
  const toggleLinkedIn = (e: ReactMouseEvent<HTMLElement>) => {
    e.preventDefault();
    const follow = !liAt;
    if (follow && liUrl) window.open(liUrl, "_blank", "noopener,noreferrer");
    const prev = liAt;
    setLiAt(follow ? new Date().toISOString().slice(0, 19).replace("T", " ") : null); setLiBusy(true);
    AlumniApi.followLinkedIn(a.id, follow)
      .then((r) => { setLiAt(r.li_followed_at); setLiQuota(r.quota); })
      .catch((err: unknown) => {
        setLiAt(prev);
        const q = err instanceof ApiError ? (err.data as { data?: { quota?: LinkedInQuota } })?.data?.quota : undefined;
        if (q) setLiQuota(q);
        setFMsg("Couldn't save LinkedIn follow state.");
      })
      .finally(() => setLiBusy(false));
  };
  const liTitle = liAt
    ? `Followed on LinkedIn ${istanbulTime(liAt) || liAt} — click to mark as not followed`
    : liOver ? `Open the LinkedIn profile in a new tab (past the ${quota!.cap}-per-7-days guide, still allowed)` : "Open the LinkedIn profile in a new tab and count it toward the LinkedIn weekly counter";
  const liLeft = quota ? `${quota.remaining}/${quota.cap} left this week` : "";
  const liBtn = (extra = "") => liUrl ? (
    <span className={cx("inline-flex items-center gap-1", extra)}>
      <button type="button" onClick={toggleLinkedIn} disabled={liBusy} aria-pressed={!!liAt} title={liTitle}
        aria-label={`${liAt ? "Unfollow" : "Follow"} ${a.full_name} on LinkedIn${quota ? ` (${quota.remaining} of ${quota.cap} LinkedIn follows left this week)` : ""}`}
        className={cx("inline-flex h-7 items-center gap-1 rounded-full px-3 text-[12px] font-semibold disabled:opacity-60", FOCUS,
          liAt ? "border border-line bg-veil/5 text-ink-3 hover:text-ink" : "bg-yang text-on-accent hover:bg-yin hover:text-white")}>
        <SocialIcon k="linkedin" size={12} />{liAt ? "Unfollow" : "Follow"}
      </button>
      {liLeft && <span className="whitespace-nowrap text-[11px] tabular-nums text-ink-3" title="LinkedIn follows in the last 7 days (rolling)">{liLeft}</span>}
    </span>
  ) : null;
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
    : others.length ? `Open all ${others.length} non-LinkedIn link(s) in new tabs and mark as followed (⌘/Ctrl-click: open them behind this page)` : "Mark as followed";
  const followBtn = (extra = "") => (
    <button type="button" onClick={toggleFollow} disabled={fBusy} aria-pressed={!!followedAt} title={followTitle}
      aria-label={`${followedAt ? "Unfollow" : "Follow"} ${a.full_name}${liUrl ? " (all platforms except LinkedIn)" : ""}`}
      className={cx("h-7 rounded-full px-3 text-[12px] font-semibold disabled:opacity-60", FOCUS, extra,
        followedAt ? "border border-line bg-veil/5 text-ink-3 hover:text-ink" : "bg-yang text-on-accent hover:bg-yin hover:text-white")}>
      {followedAt ? "Unfollow" : "Follow"}
    </button>
  );
  const gpa = gpaLabel(a.gpa);
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
        {gpa && (
          <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-ink-3" title={ESTIMATE_NOTE} aria-label={`Estimated GPA ${gpa} (${ESTIMATE_NOTE.toLowerCase()})`}>
            Est. GPA <span className="text-ink-2">{gpa}</span>
          </span>
        )}
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
          {(others.length > 0 || !liUrl) && followBtn("ml-1")}
          {liBtn("ml-1")}
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
              {gpa && <p className="mt-1 text-ink-3" title={ESTIMATE_NOTE}>Est. GPA <span className="tabular-nums text-ink-2">{gpa}</span> <span className="text-[11px]">· estimate from roster, not official</span></p>}
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
            {(others.length > 0 || !liUrl) && <Button size="sm" variant={followedAt ? "subtle" : "primary"} onClick={toggleFollow} disabled={fBusy} aria-pressed={!!followedAt} title={followTitle} className={FOCUS}>
              {followedAt ? "Unfollow" : "Follow"}
            </Button>}
            {liBtn()}
            {queueable.length > 0 && <Button size="sm" variant="outline" onClick={toQueue} disabled={busy} className={FOCUS}>{busy ? "Sending…" : "Send to queue"}</Button>}
            {msg && <span className="text-[12px] text-ink-2" role="status">{msg}</span>}
            <span className="flex flex-wrap gap-x-2 text-[12px] text-ink-3 sm:ml-auto">
              {followedAt && <><When label="Followed" at={followedAt} /><span aria-hidden>·</span></>}
              {liAt && <><When label="LinkedIn followed" at={liAt} /><span aria-hidden>·</span></>}
              <When label="Updated" at={a.updated_at} />
            </span>
          </div>
        </div>
      )}
    </li>
  );
}


const INPUT = "h-10 w-full rounded-lg border border-line bg-space-1 px-3 text-[14px] text-ink placeholder:text-ink-3 " + FOCUS;

/** 1.25.27 (Arash 2026-11-03: "the outreach should be just the search tab. simplify and improve the UI/UX"). */
function AlumniSearch() {
  const [facets, setFacets] = useState<AlumniFacets | null>(null);
  const [f, setF] = useState<AlumniFilter>({});
  // Multi-select platform filter; a person matches only when they have EVERY selected one (AND). None ticked = everyone.
  const [pfs, setPfs] = useState<string[]>([]);
  useEffect(() => { setF((o) => ({ ...o, platforms: pfs.length === 0 ? undefined : pfs.join(",") })); }, [pfs]);
  const togglePf = (k: string) => setPfs((o) => (o.includes(k) ? o.filter((x) => x !== k) : [...o, k]));
  const [q, setQ] = useState("");
  const [loc, setLoc] = useState("");
  const [items, setItems] = useState<Alumnus[] | null>(null);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState(0);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState("");
  const [showMore, setShowMore] = useState(false);
  useEffect(() => { AlumniApi.facets().then(setFacets).catch(() => setErr("Couldn't load ArtaSearch.")); }, []);
  useEffect(() => { const t = setTimeout(() => setF((o) => ((o.q ?? "") === q ? o : { ...o, q })), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { const t = setTimeout(() => setF((o) => ((o.location ?? "") === loc.trim() ? o : { ...o, location: loc.trim() || undefined })), 300); return () => clearTimeout(t); }, [loc]);
  const load = useCallback(async (cursor: number) => {
    if (cursor) setMore(true);
    try {
      const r = await AlumniApi.list({ ...f, cursor });
      setItems((old) => (cursor && old ? [...old, ...r.items] : r.items)); setNext(r.next); setTotal(r.total); setErr("");
    } catch { setErr("Couldn't load alumni. Check your connection and try again."); if (!cursor) setItems([]); }
    finally { setMore(false); }
  }, [f]);
  useEffect(() => { setItems(null); load(0); }, [load]);
  const set = (k: keyof AlumniFilter) => (v: string) => setF((o) => ({ ...o, [k]: v || undefined }));
  const exportCsv = async () => { try { const r = await AlumniApi.exportCsv(f); download(r.filename, r.csv); } catch { setErr("Couldn't export CSV."); } };
  const opt = (all: string, list: { value: string | number; n: number }[] = []) =>
    [{ value: "", label: all }, ...list.map((x) => ({ value: String(x.value), label: `${x.value} (${x.n})` }))];
  const active = !!(q || loc || f.year || f.department || f.country || f.followed || f.with_no_gpa || pfs.length);
  const reset = () => { setQ(""); setLoc(""); setPfs([]); setF({ sort: f.sort }); };
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, employer or title" aria-label="Search alumni" className={INPUT} />
          <input value={loc} onChange={(e) => setLoc(e.target.value)} placeholder="City or country" aria-label="Filter by location" className={cx(INPUT, "sm:w-[200px]")} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select label="Year" value={f.year ?? ""} onChange={set("year")} options={opt("All years", facets?.years)} skipOptions />
          <Select label="Department" value={f.department ?? ""} onChange={set("department")} options={opt("All departments", facets?.departments)} skipOptions />
          <Select label="Followed" value={f.followed ?? ""} onChange={set("followed")} skipOptions
            options={[{ value: "", label: "Followed or not" }, { value: "1", label: "Followed" }, { value: "0", label: "Not followed" }]} />
          <Select label="Sort" value={f.sort ?? "gpa_desc"} onChange={(v) => setF((o) => ({ ...o, sort: v as AlumniSort }))} skipOptions
            options={[{ value: "gpa_desc", label: "Est. GPA: high to low" }, { value: "gpa_asc", label: "Est. GPA: low to high" }, { value: "class", label: "Class: newest first" }, { value: "name", label: "Name A–Z" }]} />
          <button type="button" onClick={() => setShowMore((v) => !v)} aria-expanded={showMore} className={cx("text-[13px] text-ink-3 hover:text-yang", FOCUS)}>
            {showMore ? "Fewer filters" : "More filters"}
          </button>
          <span className="ml-auto flex items-center gap-2">
            {active && <Button size="sm" variant="ghost" onClick={reset}>Clear all</Button>}
            <Button size="sm" variant="outline" onClick={exportCsv}>Export CSV</Button>
          </span>
        </div>
        {showMore && (
          <div className="flex flex-wrap items-center gap-3">
            <Select label="Country" value={f.country ?? ""} onChange={set("country")} options={opt("All countries", facets?.countries)} skipOptions />
            {(facets?.without_gpa ?? 0) > 0 && (
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
                <input type="checkbox" checked={f.with_no_gpa === "1"} onChange={(e) => setF((o) => ({ ...o, with_no_gpa: e.target.checked ? "1" : undefined }))} />
                Include people without a GPA ({facets?.without_gpa?.toLocaleString()})
              </label>
            )}
          </div>
        )}
        <fieldset className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <legend className="sr-only">Has all of these accounts</legend>
          <span className="mr-1 text-ink-3">Has:</span>
          {PF_FILTER.map(({ k, label }) => {
            const on = pfs.includes(k);
            const c = k === "email" ? facets?.with_email : facets?.platforms[k as AlumniPlatform];
            return (
              <label key={k} className={cx("flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 transition-colors focus-within:outline-2 focus-within:outline-yang",
                on ? "border-yang bg-yang/10 text-ink" : "border-line text-ink-3 hover:text-ink")}>
                <input type="checkbox" className="sr-only" checked={on} onChange={() => togglePf(k)} />
                {k === "email" ? MAIL_ICON : <SocialIcon k={k} size={13} />}
                <span>{label}{c !== undefined && <span className="tabular-nums text-ink-3"> {c.toLocaleString()}</span>}</span>
              </label>
            );
          })}
        </fieldset>
      </Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-[13px] text-ink-3" aria-live="polite">
        <span>{items === null ? "Searching…" : `${total.toLocaleString()} ${total === 1 ? "person" : "people"}${active ? " match" : ""}`}</span>
        {facets && <span>{facets.total.toLocaleString()} alumni · {facets.with_any.toLocaleString()} with a confirmed profile{facets.synced_at && ` · updated ${local(facets.synced_at)}`}</span>}
      </div>
      {err && <ErrorNote>{err}</ErrorNote>}
      {items === null ? <SkeletonGrid /> : items.length === 0 ? (
        !err && <Card className="flex flex-col items-center gap-2 p-8 text-center">
          <p className="text-[15px] font-semibold text-ink">No one matches these filters</p>
          <p className="text-[13px] text-ink-3">{active ? "Try removing a filter or a search word." : "Rows appear here as the ArtaSearch scan confirms profiles."}</p>
          {active && <Button size="sm" variant="outline" onClick={reset}>Clear all filters</Button>}
        </Card>
      ) : (
        <>
          <Card className="p-0"><ul aria-label="Alumni">{items.map((a) => <AlumniRow key={a.id} a={a} />)}</ul></Card>
          {next > 0 && (
            <div className="flex flex-col items-center gap-1">
              <Button size="sm" variant="outline" onClick={() => load(next)} disabled={more}>{more ? "Loading…" : "Load more"}</Button>
              <span className="text-[12px] text-ink-3">Showing {items.length.toLocaleString()} of {total.toLocaleString()}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function Outreach() {
  if (!canOutreach()) return <NotFound />;
  return (
    <div className="flex flex-col gap-5">
      <PageHero title="Outreach" lede="Find Bilkent alumni and open their confirmed profiles. Follow opens the links in your own browser; nothing is sent from this page." />
      <AlumniSearch />
    </div>
  );
}
