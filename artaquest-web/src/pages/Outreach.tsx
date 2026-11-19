import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  AlumniApi, canOutreach, type AlumniFacets, type AlumniFilter, type AlumniPlatform, type AlumniSort, type Alumnus,
} from "../lib/api";
import { Button, Card, ErrorNote, PageHero, SkeletonGrid, cx } from "../components/ui";
import { SocialIcon } from "../components/SocialLinks";
import NotFound from "./NotFound";
import { cleanHeadline, ESTIMATE_NOTE, evidenceChips, followRatioLabel, compactNumber, formatCount, gpaFollowScoreLabel, gpaLabel, istanbulTime, platformLabel, profileCounts, profileHandle, relTime } from "../lib/alumni-format";

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
const ALUMNI_PLATFORMS: AlumniPlatform[] = ["linkedin", "instagram", "facebook", "researchgate", "youtube", "github", "x", "strava", "bluesky", "spotify", "tiktok"];
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
function faviconFor(url: string): string {
  try { return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(url).hostname)}&sz=64`; }
  catch { return ""; }
}
function PlatformGlyph({ k, url, size = 14 }: { k: string; url?: string; size?: number }) {
  // SocialIcon already draws a globe when the brand path is missing; decorate with the host favicon
  // for unknown platforms so a new domain is recognizable without a code push.
  const known = ["linkedin","instagram","facebook","researchgate","youtube","github","x","strava","bluesky","spotify","tiktok","threads","reddit","medium","pinterest","twitch","snapchat","mastodon","kaggle","leetcode","behance","dribbble","letterboxd","goodreads"];
  if (known.includes(k) || !url) return <SocialIcon k={k} size={size} />;
  const src = faviconFor(url);
  if (!src) return <SocialIcon k={k} size={size} />;
  return <img src={src} alt="" width={size} height={size} className="rounded-sm" />;
}
const CHEVRON = <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>;
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

/** 1.25.37: one platform per view. Each card is that platform's handle, counts, ratio and its own Follow. */
export function AlumniRow({ a, platform }: { a: Alumnus; platform: string }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const pr = a.profiles[platform];
  const emails = alumniEmails(a);
  const [followedAt, setFollowedAt] = useState<string | null>(a.followed_at ?? a.follows?.[platform] ?? null);
  const [fBusy, setFBusy] = useState(false);
  const [fMsg, setFMsg] = useState("");
  const url = (() => { const u = pr?.url; try { return u && /^https?:$/.test(new URL(u).protocol) ? u : undefined; } catch { return undefined; } })();
  const isLi = platform === "linkedin";
  const toggleFollow = (e: ReactMouseEvent<HTMLElement>) => {
    e.preventDefault();
    const follow = !followedAt;
    if (follow && url) {
      const x = window.scrollX, y = window.scrollY;
      window.open(url, "_blank", "noopener,noreferrer");
      window.focus();
      if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
      const bg = e.metaKey || e.ctrlKey;
      setFMsg(bg ? "" : "Tip: ⌘/Ctrl-click Follow to open the profile behind this page.");
    } else setFMsg("");
    const prev = followedAt;
    setFollowedAt(follow ? new Date().toISOString().slice(0, 19).replace("T", " ") : null); setFBusy(true);
    AlumniApi.follow(a.id, follow, platform).then((r) => setFollowedAt(r.followed_at)).catch(() => { setFollowedAt(prev); setFMsg(`Couldn't save ${platformLabel(platform)} follow state.`); }).finally(() => setFBusy(false));
  };
  const toQueue = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await AlumniApi.toQueue(a.id, QUEUEABLE.has(platform as AlumniPlatform) ? [platform as AlumniPlatform] : []);
      setMsg(`${r.inserted} added to Review${r.updated ? `, ${r.updated} already there` : ""}`);
    } catch { setMsg("Couldn't add to the queue."); }
    setBusy(false);
  };
  const followTitle = followedAt
    ? `Followed on ${platformLabel(platform)} ${istanbulTime(followedAt) || followedAt} — click to mark as not followed`
    : url ? `Open the ${platformLabel(platform)} profile in a new tab` : `Mark as followed on ${platformLabel(platform)}`;
  const gpa = gpaLabel(a.gpa);
  const headline = cleanHeadline(a.full_name, a.headline, a.employer);
  const location = (a.location || "").trim() || [a.city, a.country].filter(Boolean).join(", ");
  const locFrom = (a.location || "").trim() && a.location_source ? `Stated on ${platformLabel(a.location_source)}` : "From the matched profile";
  const panelId = `alumni-detail-${a.id}`;
  const c = profileCounts(pr);
  const asOf = pr?.counts_at ? `As of ${pr.counts_at}${pr.counts_source ? ` · ${pr.counts_source}` : ""}` : "Public count; blank when the profile did not show one";
  const ratio = compactNumber(a.follow_ratio, a.follow_ratio_inf);
  const score = compactNumber(a.gpa_follow_score, a.gpa_follow_score_inf);
  const totals: { label: string; value: string; title: string; hot?: boolean }[] = [
    { label: "GPA", value: gpa, title: `${ESTIMATE_NOTE}, not official` },
    { label: "Followers", value: formatCount(a.followers_total) || c.followers, title: `${platformLabel(platform)} followers. ${asOf}` },
    { label: "Following", value: formatCount(a.following_total) || c.following, title: `${platformLabel(platform)} following. ${asOf}` },
    { label: "Ratio", value: ratio, title: followRatioLabel(a.follow_ratio, a.follow_ratio_inf) ? `Following ÷ followers on ${platformLabel(platform)}: ${followRatioLabel(a.follow_ratio, a.follow_ratio_inf)}` : `Following ÷ followers on ${platformLabel(platform)}. Blank until both numbers are known.` },
    { label: "Score", value: score, hot: true, title: gpaFollowScoreLabel(a.gpa_follow_score, a.gpa_follow_score_inf) ? `Est. GPA × following/followers on ${platformLabel(platform)}: ${gpaFollowScoreLabel(a.gpa_follow_score, a.gpa_follow_score_inf)}` : "Est. GPA × following/followers. Blank if any of the three is missing." },
  ];
  const showConn = isLi && !!c.connections;
  return (
    <li className="min-w-0 overflow-hidden rounded-card border border-line bg-space-2 shadow-card [contain-intrinsic-size:auto_280px] [content-visibility:auto]">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={panelId} aria-label={`${a.full_name}: ${open ? "hide" : "show"} details`}
        className={cx("flex w-full items-start gap-2 px-3 pt-3 text-left sm:px-4", FOCUS)}>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[16px] font-semibold leading-tight text-ink">{a.full_name}</span>
            {followedAt && <span className="rounded-full bg-yang/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-yang">Followed</span>}
          </span>
          <span className="mt-0.5 block text-[13px] text-ink-3">{a.department}{a.department && a.grad_year ? " · " : ""}{a.grad_year ? `Class of ${a.grad_year}` : ""}</span>
          {headline && <span className="mt-0.5 line-clamp-1 break-words text-[13px] text-ink-2">{headline}</span>}
        </span>
        <span aria-hidden className={cx("mt-1 shrink-0 text-ink-3 transition-transform", open && "rotate-180")}>{CHEVRON}</span>
      </button>

      <dl className="mx-3 mt-3 grid grid-cols-5 gap-1 sm:mx-4 sm:gap-2" aria-label={`${a.full_name} on ${platformLabel(platform)}: counts`}>
        {totals.map((t) => (
          <div key={t.label} title={t.title} className={cx("min-w-0 rounded-lg border px-0.5 py-1.5 text-center sm:px-2", t.hot && t.value ? "border-yang/50 bg-yang/10" : "border-line bg-space-1")}>
            <dt className="truncate text-[9px] font-medium leading-tight text-ink-3 sm:text-[11px]">{t.label}</dt>
            <dd className={cx("truncate text-[13px] font-semibold tabular-nums sm:text-[15px]", t.value ? "text-ink" : "font-normal text-ink-3")}>
              {t.value || <><span aria-hidden>—</span><span className="sr-only">not available</span></>}
            </dd>
          </div>
        ))}
      </dl>

      <section className="mx-3 mt-3 sm:mx-4" aria-label={`${a.full_name} on ${platformLabel(platform)}`}>
        {pr && url ? (
          <div className="flex min-w-0 flex-col gap-2 overflow-hidden rounded-lg border border-line bg-space-1 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
            <a href={url} target="_blank" rel="noopener noreferrer" title={pr.title ? `${pr.title}\n${url}` : url}
              aria-label={`${a.full_name} on ${platformLabel(platform)} (opens in a new tab)`}
              className={cx("group flex min-h-10 min-w-0 items-center gap-2 rounded sm:flex-1", FOCUS)}>
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line bg-space-2 text-ink-2 group-hover:border-yang group-hover:text-yang"><PlatformGlyph k={platform} url={url} size={16} /></span>
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold leading-tight text-ink group-hover:text-yang">{platformLabel(platform)}</span>
                <span className="block truncate text-[12px] leading-tight text-ink-3 group-hover:underline">{profileHandle(platform, url)}</span>
              </span>
            </a>
            <dl className={cx("grid min-w-0 gap-2 sm:shrink-0 sm:gap-3 sm:text-right", showConn ? "grid-cols-3" : "grid-cols-2")}>
              <div className="min-w-0 rounded-md bg-veil/5 px-2 py-1 sm:bg-transparent sm:px-0 sm:py-0" title={asOf}><dt className="truncate text-[10px] uppercase tracking-wide text-ink-3">Followers</dt><dd className="truncate text-[14px] font-semibold tabular-nums text-ink">{c.followers || "—"}</dd></div>
              <div className="min-w-0 rounded-md bg-veil/5 px-2 py-1 sm:bg-transparent sm:px-0 sm:py-0" title={asOf}><dt className="truncate text-[10px] uppercase tracking-wide text-ink-3">Following</dt><dd className="truncate text-[14px] font-semibold tabular-nums text-ink">{c.following || "—"}</dd></div>
              {showConn && <div className="min-w-0 rounded-md bg-veil/5 px-2 py-1 sm:bg-transparent sm:px-0 sm:py-0" title={asOf}><dt className="truncate text-[10px] uppercase tracking-wide text-ink-3"><span className="sm:hidden">Conn.</span><span className="hidden sm:inline">Connections</span></dt><dd className="truncate text-[14px] font-semibold tabular-nums text-ink">{c.connections || "—"}</dd></div>}
            </dl>
          </div>
        ) : <p className="rounded-lg border border-dashed border-line px-3 py-2 text-[13px] text-ink-3">No confirmed {platformLabel(platform)} account.</p>}
      </section>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line px-3 py-2.5 scroll-mb-[calc(var(--aq-bottom-bar)+4.75rem)] sm:px-4 md:scroll-mb-0">
        {url && (
          <button type="button" onClick={toggleFollow} disabled={fBusy} aria-pressed={!!followedAt} title={followTitle}
            aria-label={`${followedAt ? "Unfollow" : "Follow"} ${a.full_name} on ${platformLabel(platform)}`}
            className={cx("inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-[13px] font-semibold disabled:opacity-60 sm:h-8 sm:px-3 sm:text-[12px] whitespace-nowrap", FOCUS,
              followedAt ? "border border-line bg-veil/5 text-ink-3 hover:text-ink" : "bg-yang text-on-accent hover:bg-yin hover:text-white")}>
            <PlatformGlyph k={platform} url={url} size={12} />{followedAt ? "Unfollow" : "Follow"}
          </button>
        )}
        {emails.length > 0 && (
          <a href={`mailto:${emails[0].email}`} className={cx(ICON_BTN, "!h-10 !w-10 sm:!h-8 sm:!w-8", FOCUS)} aria-label={`Email ${a.full_name}`}
            title={emails[0].email + (emails.length > 1 ? ` (+${emails.length - 1} more in details)` : "")}>{MAIL_ICON}</a>
        )}
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={panelId}
          className={cx("ml-auto inline-flex h-10 items-center gap-1 rounded-full px-3 text-[12px] font-semibold text-ink-2 hover:text-yang sm:h-8", FOCUS)}>
          {open ? "Hide details" : "Details"}<span aria-hidden className={cx("transition-transform", open && "rotate-180")}>{CHEVRON}</span>
        </button>
      </div>
      {fMsg && <p className="px-3 pb-2.5 text-[12px] text-ink-3 sm:px-4" role="status">{fMsg}</p>}
      {open && (
        <div id={panelId} className="border-t border-line bg-space-1 px-3 py-4 text-[13px] sm:px-4">
          <div className="flex items-start gap-4">
            <div className="shrink-0 text-center">
              <span className="block sm:hidden"><AlumniPhoto a={a} size={64} /></span>
              <span className="hidden sm:block"><AlumniPhoto a={a} size={88} /></span>
              {a.photo_private && a.photo_meta && (
                <a href={a.photo_meta.profile_url} target="_blank" rel="noopener noreferrer"
                  title={`Photo from ${platformLabel(a.photo_meta.platform)}${istanbulTime(a.photo_meta.fetched_at) ? `, fetched ${istanbulTime(a.photo_meta.fetched_at)}` : ""}`}
                  className={cx("mt-1 inline-block rounded text-[11px] text-ink-3 hover:text-yang", FOCUS)}>
                  via {platformLabel(a.photo_meta.platform)}
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

          {pr && (
            <section className="mt-4" aria-label={`${platformLabel(platform)} evidence`}>
              <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Why we think this {platformLabel(platform)} is theirs</h4>
              <div className="flex flex-col gap-1.5 rounded-lg border border-line px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
                <div className="flex min-w-0 items-center gap-2 sm:w-[46%] sm:shrink-0">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-line text-ink-2"><PlatformGlyph k={platform} url={pr.url} size={14} /></span>
                  {url ? <a href={url} target="_blank" rel="noopener noreferrer" title={pr.title ? `${pr.title}\n${url}` : url}
                    className={cx("min-w-0 truncate rounded font-medium text-ink hover:text-yang hover:underline", FOCUS)}>
                    {profileHandle(platform, url)}<span className="sr-only"> (opens in a new tab)</span>
                  </a> : <span className="text-ink-3">No URL</span>}
                  {url && <span className="ml-auto sm:hidden"><CopyButton text={url} label={`Copy ${platformLabel(platform)} link`} /></span>}
                </div>
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 pl-9 sm:pl-0" title={pr.evidence ? `Evidence code: ${pr.evidence}` : undefined}>
                  {evidenceChips(pr.evidence).map((ch) => (
                    <span key={ch} className="rounded-full border border-line bg-veil/5 px-2 py-0.5 text-[11px] text-ink-2">{ch}</span>
                  ))}
                  {pr.counts_at && <span className="text-[11px] text-ink-3">counts as of {pr.counts_at}</span>}
                </div>
                {url && <span className="hidden sm:block"><CopyButton text={url} label={`Copy ${platformLabel(platform)} link`} /></span>}
              </div>
            </section>
          )}

          {emails.length > 0 && (
            <section className="mt-3" aria-label="Emails">
              <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Email{emails.length > 1 && `s · ${emails.length}`}</h4>
              <ul className="space-y-1">
                {emails.map((e) => (
                  <li key={e.email} className="flex flex-wrap items-center gap-2">
                    <span className="text-ink-3">{MAIL_ICON}</span>
                    <a className={cx("break-all rounded font-medium text-ink hover:text-yang hover:underline", FOCUS)} href={`mailto:${e.email}`}>{e.email}</a>
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
            {QUEUEABLE.has(platform as AlumniPlatform) && url && <Button size="sm" variant="outline" onClick={toQueue} disabled={busy} className={FOCUS}>{busy ? "Sending…" : "Send to queue"}</Button>}
            {msg && <span className="text-[12px] text-ink-2" role="status">{msg}</span>}
            <span className="flex flex-wrap gap-x-2 text-[12px] text-ink-3 sm:ml-auto">
              {followedAt && <><When label={`Followed on ${platformLabel(platform)}`} at={followedAt} /><span aria-hidden>·</span></>}
              <When label="Updated" at={a.updated_at} />
            </span>
          </div>
        </div>
      )}
    </li>
  );
}

const PF_KEY = "aq_outreach_platform";
const INPUT = "h-11 w-full rounded-lg border border-line bg-space-1 px-3 text-[14px] text-ink placeholder:text-ink-3 sm:h-10 " + FOCUS;
const SELECT = "h-11 w-full min-w-0 rounded-lg border border-line bg-space-1 px-2 text-[13px] sm:px-3 sm:text-[14px] text-ink sm:h-10 " + FOCUS;
const SORT_GROUPS: { group: string; options: { value: AlumniSort; label: string }[] }[] = [
  { group: "Academic", options: [
    { value: "gpa_desc", label: "Est. GPA: high to low" },
    { value: "gpa_asc", label: "Est. GPA: low to high" },
    { value: "class", label: "Class: newest first" },
    { value: "name", label: "Name A–Z" },
  ] },
  { group: "This platform", options: [
    { value: "followers_total_desc", label: "Followers: high to low" },
    { value: "following_total_desc", label: "Following: high to low" },
    { value: "follow_ratio_desc", label: "Following ÷ followers: high to low" },
  ] },
  { group: "Ranking", options: [
    { value: "gpa_follow_score_desc", label: "Est. GPA × following ÷ followers: high to low" },
  ] },
];
const FILTER_ICON = <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M4 6h16M7 12h10M10 18h4" /></svg>;

function readStoredPlatform(): string {
  try { return localStorage.getItem(PF_KEY) || ""; } catch { return ""; }
}
function writeStoredPlatform(k: string) {
  try { localStorage.setItem(PF_KEY, k); } catch { /* blocked */ }
}

/** 1.25.37: a required platform selector — the list is always one platform at a time. */
function AlumniSearch() {
  const [facets, setFacets] = useState<AlumniFacets | null>(null);
  const [viewPf, setViewPf] = useState(readStoredPlatform);
  const [f, setF] = useState<AlumniFilter>(() => { const p = readStoredPlatform(); return p ? { platform: p } : {}; });
  const [q, setQ] = useState("");
  const [loc, setLoc] = useState("");
  const [items, setItems] = useState<Alumnus[] | null>(null);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState(0);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState("");
  const [panel, setPanel] = useState(false);
  useEffect(() => { AlumniApi.facets().then(setFacets).catch(() => setErr("Couldn't load ArtaSearch.")); }, []);
  const platformKeys = (facets
    ? [...ALUMNI_PLATFORMS, ...Object.keys(facets.platforms).filter((k) => !ALUMNI_PLATFORMS.includes(k as AlumniPlatform))]
    : [...ALUMNI_PLATFORMS]
  ).filter((k) => !facets || (facets.platforms[k] ?? 0) > 0);
  useEffect(() => {
    if (!facets) return;
    const keys = [...ALUMNI_PLATFORMS, ...Object.keys(facets.platforms).filter((k) => !ALUMNI_PLATFORMS.includes(k as AlumniPlatform))]
      .filter((k) => (facets.platforms[k] ?? 0) > 0);
    if (keys.length === 0) return;
    setViewPf((cur) => {
      if (cur && keys.includes(cur)) return cur;
      const nextPf = keys.includes("linkedin") ? "linkedin" : keys[0];
      writeStoredPlatform(nextPf);
      return nextPf;
    });
  }, [facets]);
  const choosePf = (k: string) => { setViewPf(k); writeStoredPlatform(k); };
  useEffect(() => {
    setF((o) => (o.platform === viewPf || !viewPf ? o : { ...o, platform: viewPf }));
  }, [viewPf]);
  useEffect(() => { const t = setTimeout(() => setF((o) => ((o.q ?? "") === q ? o : { ...o, q })), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { const t = setTimeout(() => setF((o) => ((o.location ?? "") === loc.trim() ? o : { ...o, location: loc.trim() || undefined })), 300); return () => clearTimeout(t); }, [loc]);
  useEffect(() => {
    if (!panel) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && window.matchMedia("(max-width: 639.98px)").matches) setPanel(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [panel]);
  const load = useCallback(async (cursor: number) => {
    if (!f.platform) return;
    if (cursor) setMore(true);
    try {
      const r = await AlumniApi.list({ ...f, cursor });
      setItems((old) => (cursor && old ? [...old, ...r.items] : r.items)); setNext(r.next); setTotal(r.total); setErr("");
    } catch { setErr("Couldn't load alumni. Check your connection and try again."); if (!cursor) setItems([]); }
    finally { setMore(false); }
  }, [f]);
  useEffect(() => { if (!f.platform) return; setItems(null); load(0); }, [load, f.platform]);
  const set = (k: keyof AlumniFilter) => (v: string) => setF((o) => ({ ...o, [k]: v || undefined }));
  const exportCsv = async () => { try { const r = await AlumniApi.exportCsv(f); download(r.filename, r.csv); } catch { setErr("Couldn't export CSV."); } };
  const opt = (all: string, list: { value: string | number; n: number }[] = []) =>
    [{ value: "", label: all }, ...list.map((x) => ({ value: String(x.value), label: `${x.value} (${x.n})` }))];
  const active = !!(q || loc || f.year || f.department || f.country || f.followed || f.with_no_gpa);
  const reset = () => { setQ(""); setLoc(""); setF({ sort: f.sort, platform: viewPf || f.platform }); };
  const chips: { key: string; label: string; clear: () => void }[] = [
    ...(f.year ? [{ key: "year", label: `Class of ${f.year}`, clear: () => set("year")("") }] : []),
    ...(f.department ? [{ key: "dept", label: f.department, clear: () => set("department")("") }] : []),
    ...(f.country ? [{ key: "country", label: f.country, clear: () => set("country")("") }] : []),
    ...(loc.trim() ? [{ key: "loc", label: `Near “${loc.trim()}”`, clear: () => setLoc("") }] : []),
    ...(f.followed ? [{ key: "fol", label: f.followed === "1" ? "Followed" : "Not followed", clear: () => set("followed")("") }] : []),
    ...(f.with_no_gpa ? [{ key: "nogpa", label: "Incl. no GPA", clear: () => set("with_no_gpa")("") }] : []),
  ];
  const sort = f.sort ?? "gpa_desc";
  const pfLabel = viewPf ? platformLabel(viewPf) : "a platform";
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Card className="flex flex-col gap-3 p-3 sm:p-4">
        <div className="min-w-0">
          <p className="mb-1.5 text-[12px] font-medium text-ink-3">Platform</p>
          <div role="tablist" aria-label="Platform" className="-mx-1 flex gap-1 overflow-x-auto overscroll-x-contain px-1 pb-1 [scrollbar-width:thin]">
            {platformKeys.map((k) => {
              const on = viewPf === k;
              const n = facets?.platforms[k];
              return (
                <button key={k} type="button" role="tab" aria-selected={on} onClick={() => choosePf(k)}
                  className={cx("inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold", FOCUS,
                    on ? "border-yang bg-yang/10 text-ink" : "border-line text-ink-2 hover:text-ink")}>
                  <PlatformGlyph k={k} size={14} />
                  {platformLabel(k)}
                  {n !== undefined && <span className="tabular-nums text-ink-3">&nbsp;{n.toLocaleString()}</span>}
                </button>
              );
            })}
          </div>
        </div>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or employer" aria-label="Search alumni" className={cx(INPUT, "col-span-2")} />
          <label className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-ink-3"><span className="hidden shrink-0 sm:inline">Sort</span>
            <select value={sort} aria-label="Sort by" className={SELECT}
              onChange={(e) => { const v = e.target.value as AlumniSort; setF((o) => ({ ...o, sort: v, sort_platform: undefined })); }}>
              {SORT_GROUPS.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.options.map((o) => <option key={o.value} value={o.value} data-ay-skip="1">{o.label}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => setPanel((v) => !v)} aria-expanded={panel} aria-controls="outreach-filters"
            className={cx("inline-flex h-11 items-center justify-center gap-2 rounded-lg border px-4 text-[14px] font-semibold sm:h-10",
              FOCUS, chips.length ? "border-yang text-ink" : "border-line text-ink-2 hover:text-ink")}>
            {FILTER_ICON}Filters{chips.length > 0 && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-yang px-1 text-[11px] font-bold text-on-accent">{chips.length}</span>}
          </button>
        </div>

        {panel && <div className="fixed inset-0 z-[69] bg-black/50 sm:hidden" onClick={() => setPanel(false)} aria-hidden />}
        <div id="outreach-filters" hidden={!panel} role="group" aria-label="Filters"
          className="max-sm:fixed max-sm:inset-x-0 max-sm:bottom-[var(--aq-bottom-bar)] max-sm:z-[70] max-sm:flex max-sm:max-h-[min(85dvh,calc(100dvh-var(--aq-bottom-bar)))] max-sm:flex-col max-sm:overflow-hidden max-sm:rounded-t-2xl max-sm:border-t max-sm:border-line max-sm:bg-space-2 max-sm:p-4 max-sm:shadow-2xl sm:border-t sm:border-line sm:pt-3">
          <div className="mb-3 flex shrink-0 items-center justify-between sm:hidden">
            <h2 className="text-[16px] font-semibold text-ink">Filters</h2>
            <button type="button" onClick={() => setPanel(false)} aria-label="Close filters" className={cx("grid h-10 w-10 place-items-center rounded-full text-ink-2 hover:bg-veil/5", FOCUS)}>
              <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
          <div className="max-sm:min-h-0 max-sm:flex-1 max-sm:overflow-y-auto max-sm:overscroll-contain">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <label className="flex min-w-0 flex-col gap-1 text-[12px] text-ink-3">Class
              <select value={f.year ?? ""} onChange={(e) => set("year")(e.target.value)} className={SELECT}>{opt("All years", facets?.years).map((o) => <option key={o.value} value={o.value} data-ay-skip="1">{o.label}</option>)}</select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-[12px] text-ink-3">Department
              <select value={f.department ?? ""} onChange={(e) => set("department")(e.target.value)} className={SELECT}>{opt("All departments", facets?.departments).map((o) => <option key={o.value} value={o.value} data-ay-skip="1">{o.label}</option>)}</select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-[12px] text-ink-3">Country
              <select value={f.country ?? ""} onChange={(e) => set("country")(e.target.value)} className={SELECT}>{opt("All countries", facets?.countries).map((o) => <option key={o.value} value={o.value} data-ay-skip="1">{o.label}</option>)}</select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-[12px] text-ink-3">Follow status
              <select value={f.followed ?? ""} onChange={(e) => set("followed")(e.target.value)} className={SELECT}>
                <option value="" data-ay-skip="1">Followed or not</option><option value="1" data-ay-skip="1">Followed on {pfLabel}</option><option value="0" data-ay-skip="1">Not followed on {pfLabel}</option>
              </select>
            </label>
            <label className="col-span-2 flex min-w-0 flex-col gap-1 text-[12px] text-ink-3">City or country
              <input value={loc} onChange={(e) => setLoc(e.target.value)} placeholder="e.g. Berlin" className={INPUT} />
            </label>
          </div>
          {(facets?.without_gpa ?? 0) > 0 && (
            <label className="mt-3 flex min-h-10 cursor-pointer items-center gap-2 text-[13px] text-ink-2">
              <input type="checkbox" className="h-4 w-4" checked={f.with_no_gpa === "1"} onChange={(e) => setF((o) => ({ ...o, with_no_gpa: e.target.checked ? "1" : undefined }))} />
              Include people without a GPA ({facets?.without_gpa?.toLocaleString()})
            </label>
          )}
          </div>
          <div className="mt-3 flex shrink-0 items-center gap-2 border-t border-line pt-3 sm:hidden">
            <Button variant="outline" onClick={reset} disabled={!active} className="min-h-11 flex-1">Clear all</Button>
            <Button onClick={() => setPanel(false)} className="min-h-11 flex-[2]">{items === null ? "Show results" : `Show ${total.toLocaleString()} ${total === 1 ? "person" : "people"}`}</Button>
          </div>
        </div>

        {chips.length > 0 && (
          <ul className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
            {chips.map((c) => (
              <li key={c.key}>
                <button type="button" onClick={c.clear} aria-label={`Remove filter: ${c.label}`}
                  className={cx("inline-flex min-h-8 items-center gap-1 rounded-full border border-yang/60 bg-yang/10 px-2.5 text-[12px] text-ink", FOCUS)}>
                  {c.label}<span aria-hidden className="text-ink-3">×</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 text-[13px] text-ink-3" aria-live="polite">
        <span>
          <span className="font-semibold text-ink">{items === null ? "Searching…" : `${total.toLocaleString()} ${total === 1 ? "person" : "people"}${active ? " match" : ""}`}</span>
          {viewPf && <span> on {platformLabel(viewPf)}</span>}
          {facets && <span className="hidden sm:inline"> · {facets.total.toLocaleString()} alumni · {facets.with_any.toLocaleString()} with a confirmed profile{facets.synced_at && ` · updated ${local(facets.synced_at)}`}</span>}
        </span>
        <span className="flex items-center gap-1">
          {active && <Button size="sm" variant="ghost" onClick={reset}>Clear all</Button>}
          <Button size="sm" variant="outline" onClick={exportCsv}>Export CSV</Button>
        </span>
      </div>
      {err && <ErrorNote>{err}</ErrorNote>}
      {!f.platform ? <SkeletonGrid /> : items === null ? <SkeletonGrid /> : items.length === 0 ? (
        !err && <Card className="flex flex-col items-center gap-2 p-8 text-center">
          <p className="text-[15px] font-semibold text-ink">No one matches these filters</p>
          <p className="text-[13px] text-ink-3">{active ? "Try removing a filter or a search word." : viewPf ? `No confirmed ${platformLabel(viewPf)} profiles yet.` : "Rows appear here as the ArtaSearch scan confirms profiles."}</p>
          {active && <Button size="sm" variant="outline" onClick={reset}>Clear all filters</Button>}
        </Card>
      ) : (
        <>
          <ul aria-label="Alumni" className="flex min-w-0 flex-col gap-3">{items.map((a) => <AlumniRow key={`${a.id}:${viewPf}`} a={a} platform={viewPf} />)}</ul>
          {next > 0 && (
            <div className="flex flex-col items-center gap-1">
              <Button size="sm" variant="outline" onClick={() => load(next)} disabled={more} className="min-h-10">{more ? "Loading…" : "Load more"}</Button>
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
    <div className="flex min-w-0 flex-col gap-5 pb-[calc(var(--aq-bottom-bar)+4.75rem)] md:pb-0">
      <PageHero title="Outreach" lede="Find Bilkent alumni, one platform at a time. Follow opens that profile in your own browser; nothing is sent from this page." />
      <AlumniSearch />
    </div>
  );
}
