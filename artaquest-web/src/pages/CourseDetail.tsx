import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  getCourse, enrollCourse, localePath, isLoggedIn, getCourseRankings, getCourseCommentHistory,
  getCourseReviews, postCourseReview, getCourseThreads, postCourseThread,
  type CourseDetail as CD, type EnrollResult, type CourseReviews, type Thread, type CourseRankings, type CourseCommentHistory, type CommentRatePoint, type CourseVideoSeries,
} from "../lib/wp";
import { isLorem, loremCourse } from "../lib/lorem";
import { Coins } from "../lib/currency";
import { Avatar, Button, MetricChip, StatusNote, Tabs } from "../components/ui";
import { SYSTEMS, loadTypologies, typologiesReady } from "../lib/typologies";
import { type TypologySystem } from "../lib/typology-meta";
import { SharePanel } from "../components/SharePanel";

/** The topic pages this course belongs to: the typology systems that point at it (system.course ===
 *  the course URL → real /topics/<key> pages), plus its subject facet as a browse chip. Every course
 *  surfaces at least one topic tag — the subject chip — so a learner can always step out to the topic. */
function TopicTags({ url, topic, topicLabel, disciplines }: { url: string; topic?: string; topicLabel?: string; disciplines?: { key: string; label: string; house: string; houseLabel: string }[] }) {
  const [ready, setReady] = useState(typologiesReady());
  useEffect(() => { if (!ready) loadTypologies().then(() => setReady(true)).catch(() => {}); }, [ready]);
  const systems: TypologySystem[] = ready ? SYSTEMS.filter((s) => s.course === url) : [];
  const subject = topic && topic !== "other" ? { slug: topic, label: topicLabel || topic } : null;
  const discs = disciplines ?? [];
  if (!systems.length && !subject && !discs.length) return null;
  const chip = "inline-flex items-center gap-1 rounded-pill border border-line bg-veil/[0.03] px-2.5 py-1 text-[12.5px] font-semibold text-ink-2 transition-colors hover:border-yang/40 hover:text-yang";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="Topics and disciplines this course explores">
      <span className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Topics</span>
      {systems.map((s) => (
        <a key={s.key} href={localePath(`/topics/${s.key}/`)} className={chip} title={`Explore the ${s.name} topic`}>
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-yang" />{s.name}
        </a>
      ))}
      {subject && (
        <a href={localePath(`/courses/?topic=${encodeURIComponent(subject.slug)}`)} className={chip} title={`Browse ${subject.label} courses`}>
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-yin-light" />{subject.label}
        </a>
      )}
      {/* The academic disciplines this course teaches (multi — a course can span several houses) — each
          chip browses that discipline's courses. */}
      {discs.map((d) => (
        <a key={d.key} href={localePath(`/courses/?subtopic=${encodeURIComponent(d.key)}`)} className={chip} title={`Browse ${d.label} courses · ${d.houseLabel}`}>
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-yin-light/60" />{d.label}
        </a>
      ))}
    </div>
  );
}

const TABS = ["About", "Videos", "Rankings", "Reviews", "Discussion"] as const;
type TabKey = (typeof TABS)[number];

// Kaggle-style medal disc for the top three questers.
const MEDAL: Record<string, string> = { gold: "#E8B923", silver: "#C7CBD1", bronze: "#CD7F32" };
function Medal({ kind, rank }: { kind: string; rank: number }) {
  const c = MEDAL[kind];
  if (!c) return <span className="text-[14px] font-bold tabular-nums text-ink-3">{rank}</span>;
  return (
    <span className="relative grid h-7 w-7 place-items-center" role="img" aria-label={`${kind} medal`}>
      <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden><circle cx="12" cy="13" r="8" fill={c} /><circle cx="12" cy="13" r="8" fill="none" stroke="#0d0d0f" strokeOpacity="0.25" strokeWidth="1" /><path d="M9 2h6l-2 5h-2z" fill={c} /></svg>
      <span className="absolute text-[11px] font-black text-on-accent">{rank}</span>
    </span>
  );
}

// "3d 4h" / "5h 20m" / "12m" until the next reset.
function countdown(secs: number): string {
  if (secs <= 0) return "any moment";
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function CompetitionRules({ sharePct, split, minEnrol }: { sharePct: number; split: number[]; minEnrol: number }) {
  const [g, s, b] = split.length === 3 ? split : [50, 30, 20];
  return (
    <details className="mt-4 rounded-card border border-line bg-veil/[0.02]">
      <summary className="cursor-pointer list-none px-4 py-3 text-[13px] font-semibold text-ink marker:content-none [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-3" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" strokeLinecap="round" strokeLinejoin="round" /></svg>Competition rules</span>
      </summary>
      <ol className="list-decimal space-y-1.5 px-4 pb-4 pl-9 text-[13px] leading-relaxed text-ink-2 marker:text-ink-3">
        <li><strong className="text-ink">Join for 1 coin a video.</strong> Watching is free; enrolling costs 1 coin per video (a 12-video course costs ₳12), and that fee builds the prize pool. <a href={localePath("/sponsors/")} className="text-yang hover:underline">Sponsors</a> covers it if it’s a barrier.</li>
        <li><strong className="text-ink">Discuss, don’t answer.</strong> Watch each video in full, then post your reply in its discussion board. There are no right or wrong answers — share what it made you think.</li>
        <li><strong className="text-ink">Upvote your peers.</strong> Upvote at least one other learner’s reply in each video (you can’t upvote your own). The upvotes your replies earn this season decide the ranking.</li>
        <li><strong className="text-ink">Seasons reset on the new moon.</strong> Every competition resets on the day closest to each new moon, at 10:00&nbsp;AM&nbsp;ET. The leaderboard counts only upvotes earned this season; the deadline is shown above.</li>
        <li><strong className="text-ink">The podium wins the pool.</strong> The prize pool is <strong className="text-ink">{sharePct}%</strong> of the course’s revenue, split: 🥇 1st <strong className="text-ink">{g}%</strong> · 🥈 2nd <strong className="text-ink">{s}%</strong> · 🥉 3rd <strong className="text-ink">{b}%</strong>.</li>
        <li><strong className="text-ink">To collect:</strong> finish the course (earn the certificate). Prizes only pay out once the course has at least <strong className="text-ink">{minEnrol}</strong> learners enrolled.</li>
        <li><strong className="text-ink">Past seasons are archived.</strong> When a season closes its leaderboard is frozen and prizes are paid; browse previous seasons from the dropdown above.</li>
      </ol>
    </details>
  );
}

function CourseRankingsPanel({ courseId }: { courseId: number }) {
  const [r, setR] = useState<CourseRankings | null>(null);
  const [failed, setFailed] = useState(false);
  const [season, setSeason] = useState<number | undefined>(undefined); // undefined = current
  useEffect(() => { setR(null); setFailed(false); getCourseRankings(courseId, season).then((d) => (d ? setR(d) : setFailed(true))).catch(() => setFailed(true)); }, [courseId, season]);
  if (failed) return <StatusNote error>Couldn’t load the rankings — refresh to try again.</StatusNote>;
  if (!r) return <StatusNote>Loading…</StatusNote>;
  const [gold, silver, bronze] = r.split.length === 3 ? r.split : [50, 30, 20];
  const podium = [{ medal: "gold", place: "1st", pct: gold }, { medal: "silver", place: "2nd", pct: silver }, { medal: "bronze", place: "3rd", pct: bronze }];
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-bold tracking-tight">Course rankings</h2>
          {r.archived
            ? <p className="mt-1 text-[13px] font-semibold text-ink-3"><span className="rounded-pill bg-veil/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide">Archived</span> Final results · {r.season_label}</p>
            : <p className="mt-1 text-[13px] text-ink-2">Competition closes <strong className="text-ink">{r.reset_label}</strong> <span className="text-ink-3">(in {countdown(r.closes_in)})</span> — the day closest to the new moon, 10 AM&nbsp;ET.</p>}
        </div>
        {/* Season picker: current + archived past seasons */}
        {r.seasons.length > 1 && (
          <label className="flex items-center gap-2 text-[12px] text-ink-3">
            <span className="sr-only">View season</span>
            <select value={season ?? r.seasons.find((s) => s.current)?.key ?? 0}
              onChange={(e) => { const k = Number(e.target.value); setSeason(r.seasons.find((s) => s.current)?.key === k ? undefined : k); }}
              className="rounded-card border border-line bg-space-2 px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-yang">
              {r.seasons.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
        )}
      </div>
      <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-2">
        Every course is a competition that resets each new moon. Questers are ranked by the upvotes their
        replies earn this season — the sharpest contributions win. The prize pool is <strong className="text-ink">{r.share_pct}% of this
        course’s revenue</strong>, and the top three take it.
      </p>
      {/* The prize rule — dead simple, like Kaggle: gold/silver/bronze split the pool 50/30/20. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {podium.map((p) => (
          <div key={p.medal} className="flex items-center gap-3 rounded-card border border-line bg-veil/[0.03] p-4">
            <Medal kind={p.medal} rank={Number(p.place[0])} />
            <div>
              <p className="text-[13px] font-bold text-ink">{p.place} place</p>
              <p className="text-[12px] text-ink-3">{p.pct}% of the pool{r.pool > 0 ? <> · <span className="font-semibold text-yang">{Math.floor((r.pool * p.pct) / 100)} ₳</span></> : null}</p>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-3">
        <span>Pool: <strong className="text-yang"><Coins n={r.pool} /></strong></span>
        <span>Paid out: <strong className="text-ink"><Coins n={r.paid} /></strong></span>
        <span className={r.eligible ? "text-ink-2" : ""}>Enrolled: <strong className={r.eligible ? "text-ink" : "text-ink-3"}>{r.enrolled}</strong>{!r.eligible && ` / ${r.min_enrol} to unlock prizes`}</span>
      </p>
      {!r.archived && (
        <p className="mt-2 rounded-field border border-yang/25 bg-yang/[0.06] px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-2">
          To collect, <strong className="text-ink">finish the course</strong> (earn the certificate).
          {!r.eligible && <> Prizes unlock once <strong className="text-ink">{r.min_enrol} learners</strong> have enrolled —</>} every vote counts toward your place this season.
        </p>
      )}
      <CompetitionRules sharePct={r.share_pct} split={r.split} minEnrol={r.min_enrol} />
      {r.items.length === 0 ? (
        <p className="mt-6 py-6 text-center text-[14px] text-ink-3">{r.archived ? "No entries were recorded for this season." : "No replies yet this season — be the first to post one and top the board."}</p>
      ) : (
        <div className="-mx-gutter mt-5 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-line text-[12px] uppercase tracking-wide text-ink-3">
                <th scope="col" className="py-2 pl-gutter pr-1 text-center font-semibold">#</th>
                <th scope="col" className="py-2 font-semibold">Quester</th>
                <th scope="col" className="hidden py-2 text-right font-semibold sm:table-cell">Replies</th>
                <th scope="col" className="py-2 text-right font-semibold">Votes</th>
                <th scope="col" className="py-2 pl-1 pr-gutter text-right font-semibold">Prize</th>
              </tr>
            </thead>
            <tbody>
              {r.items.map((it) => (
                <tr key={it.rank} className="border-b border-line/70">
                  <td className="py-3 pl-gutter pr-1 text-center align-middle"><Medal kind={it.medal} rank={it.rank} /></td>
                  <td className="py-3 align-middle">
                    <a href={localePath(`/u/${it.slug}/`)} className="group flex min-w-0 items-center gap-2.5">
                      <Avatar src={it.avatar} name={it.name} country={it.country} className="h-7 w-7 text-[12px]" />
                      <span className="truncate text-[14px] font-semibold text-ink group-hover:text-yang">{it.name}</span>
                      {it.certified && <span title="Certified — eligible to collect" className="shrink-0 rounded-pill bg-yin/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-yin-light">cert</span>}
                    </a>
                  </td>
                  {/* Archived seasons don't snapshot the comment count, so show "—" rather than a misleading 0. */}
                  <td className="hidden py-3 text-right align-middle text-[14px] tabular-nums text-ink-2 sm:table-cell">{r.archived ? "—" : it.questions}</td>
                  <td className="py-3 text-right align-middle text-[14px] font-bold tabular-nums text-yang">{it.votes}</td>
                  <td className="py-3 pl-1 pr-gutter text-right align-middle text-[14px] tabular-nums">
                    {it.prize > 0
                      ? (it.reward > 0
                          ? <span className="font-semibold text-yang"><Coins n={it.reward} /></span>
                          : <span className="text-ink-3" title="Finish the course to collect"><Coins n={it.prize} /> <span className="text-[11px] text-ink-2">pending</span></span>)
                      : <span className="text-ink-3">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Five-star rating display (filled = gold).
function Stars({ n, size = 14 }: { n: number; size?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={`${n} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <svg key={i} viewBox="0 0 24 24" width={size} height={size} fill={i <= Math.round(n) ? "#E8B923" : "none"} stroke="#E8B923" strokeWidth="1.5" aria-hidden>
          <path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 18l-6.2 3.3L7 14.2l-5-4.9 6.9-1z" strokeLinejoin="round" />
        </svg>
      ))}
    </span>
  );
}

const w = (typeof window !== "undefined" ? (window as unknown as Record<string, string>) : {}) || {};

function MetaRow({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div>
      <dt className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className={`mt-0.5 text-[14px] ${accent ? "font-semibold text-yang" : "text-ink"}`}>{value}</dd>
    </div>
  );
}

// Gold check badge for a verified creator channel.
function VerifiedBadge() {
  return (
    <span title="Verified creator" role="img" aria-label="Verified creator" className="inline-grid h-3.5 w-3.5 place-items-center rounded-full bg-yang text-on-accent">
      <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="4" aria-hidden><path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </span>
  );
}

/**
 * Build an SVG area+line for a RATE series (comments/day over time). The y-axis is FIT TO THE DATA
 * WINDOW [min,max] — not 0 — so the line shows the actual variation in the rate; the magnitude lives
 * in the "/day" readout beside the chart (a sparkline shows shape, the number shows scale). A series
 * with no measurable variation (spanY≈0) collapses to a low steady baseline, reading as "quiet",
 * never pinned to the top. preserveAspectRatio="none" lets the path fill a fixed box at any width.
 */
function rateSpark(pts: CommentRatePoint[], W: number, H: number, padY: number) {
  const xs = pts.map((p) => p.day);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const spanX = maxX - minX || 1;
  const x = (t: number) => ((t - minX) / spanX) * W;
  const rs = pts.map((p) => p.rate);
  const minY = Math.min(...rs), maxY = Math.max(...rs);
  const spanY = maxY - minY;
  const y = (v: number) => spanY < 1 ? H - padY : H - padY - ((v - minY) / spanY) * (H - 2 * padY);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.day).toFixed(1)},${y(p.rate).toFixed(1)}`).join(" ");
  return { line, area: `${line} L${W},${H} L0,${H} Z`, minX, maxX };
}

/**
 * Discussion-rate graph for the course header (ticket #91, widened in #96; rate-based #97): a
 * hand-rolled SVG area+line of the course's discussion RATE over time — at each hour the AVERAGE of
 * its videos' own 28-day-rolling comment rates (the same average the catalogue ranks by) — headlined
 * by the current "X/day". The per-section charts below show each video's own line; this is merely
 * their average. No charting deps (mirrors the reserve PriceChart). Discussion is the platform's
 * warmth, so the line is gold (yang). Loads lazily; with no series yet it collapses to the compact
 * rate card so a course with no discussion keeps a clean header.
 */
function CommentRateChart({ courseId, history }: { courseId: number; history: CourseCommentHistory | null }) {
  const h = history; // fetched once by the parent and shared with the per-section lines, so all axes align
  if (!h) return null; // still loading — don't flash an empty box

  // The CURRENT comment rate as the headline ("rate card") — always shown; it IS the trending
  // metric the catalogue ranks by.
  const pts = h.points;
  const hasSeries = pts.length >= 2;
  const stat = (
    <div className="shrink-0">
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-2">Discussion rate</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="text-[26px] font-bold leading-none text-yang tabular-nums">{h.perDay.toLocaleString("en")}</span>
        <span className="text-[13px] font-semibold text-yang/80">/day</span>
      </div>
      <div className="text-[11px] text-ink-2">avg per video · {h.total.toLocaleString("en")} comment{h.total === 1 ? "" : "s"} total</div>
    </div>
  );

  // No history yet → collapse to just the rate card (a clean, compact header — no stretched void).
  if (!hasSeries) return <div className="inline-flex rounded-card border border-line bg-veil/[0.02] p-3">{stat}</div>;

  const W = 1000, H = 100, padY = 6;
  const sp = rateSpark(pts, W, H, padY);
  const fmtDate = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <div className="flex items-center gap-4 rounded-card border border-line bg-veil/[0.02] p-3" aria-label="Discussion rate">
      {stat}
      <div className="min-w-0 flex-1">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[80px] w-full" role="img"
          aria-label={`Average per-video discussion rate across ${pts.length} snapshots — ${h.perDay} comments per video per day now`}>
          <defs>
            <linearGradient id={`crc-${courseId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#E8B923" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#E8B923" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={sp.area} fill={`url(#crc-${courseId})`} stroke="none" />
          <path d={sp.line} fill="none" stroke="#E8B923" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {/* X-axis: start date · snapshot count · end date. The dates are pinned to the edges and
            never break mid-word (shrink-0 + nowrap); the snapshot count takes the middle and
            truncates rather than colliding when the column is narrow (mobile) — so the three labels
            never run together into "Junsnapshots Jun" (#101). gap-2 keeps breathing room. */}
        <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-2">
          <span className="shrink-0 whitespace-nowrap">{fmtDate(sp.minX)}</span>
          <span className="min-w-0 flex-1 truncate text-center text-ink-3/80">{pts.length.toLocaleString("en")} snapshots</span>
          <span className="shrink-0 whitespace-nowrap">{fmtDate(sp.maxX)}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Per-section discussion rate: a video tracks its OWN 28-day-rolling comment rate, shown as a compact
 * gold sparkline + the current "X/day" beside each section in the Videos list. Its series comes from
 * the SAME course-history payload as the header chart (on one shared grid), so every line — the course
 * average and each section — has identical start/end points. Until that loads (or with <2 points) it
 * shows just the number from the course payload, so a section never renders empty.
 */
function SectionRateChart({ video, series, fallbackRate }: { video: string; series: CourseVideoSeries | null; fallbackRate: number }) {
  const rate = series ? series.perDay : fallbackRate;
  const pts = series?.points ?? [];
  const W = 120, H = 28, padY = 3;
  const sp = pts.length >= 2 ? rateSpark(pts, W, H, padY) : null;
  return (
    <div className="flex shrink-0 items-center gap-2" title={`This video draws ~${rate.toLocaleString("en")} new YouTube comments a day`}>
      {/* Fixed sparkline SLOT — always the same width (even when there's no line yet) and a fixed-width,
          right-aligned rate label, so the gold lines sit at the SAME x on every row (the lines all share
          one time axis; a varying label width must not shift them). */}
      <span className="block h-[22px] w-[56px] shrink-0 sm:w-[84px]">
        {sp && (
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full" role="img"
            aria-label={`This video's discussion rate over time — ${rate} per day now`}>
            <defs>
              <linearGradient id={`sg-${video}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#E8B923" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#E8B923" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={sp.area} fill={`url(#sg-${video})`} stroke="none" />
            <path d={sp.line} fill="none" stroke="#E8B923" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>
        )}
      </span>
      <span className="inline-block w-[72px] shrink-0 whitespace-nowrap text-right tabular-nums text-[12px] font-semibold text-yang/90">{rate.toLocaleString("en")}<span className="text-yang/60">/day</span></span>
    </div>
  );
}

export default function CourseDetail() {
  const { slug = "" } = useParams();
  const [c, setC] = useState<CD | null>(null);
  const [missing, setMissing] = useState(false);
  // Deep-linkable tab (?tab=rankings) — the lesson sidebar links straight to the board.
  const initialTab = ((): TabKey => {
    const t = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "").get("tab");
    return TABS.find((x) => x.toLowerCase() === (t || "").toLowerCase()) || "About";
  })();
  const [tab, setTab] = useState<TabKey>(initialTab);
  useEffect(() => { if (isLorem()) { setC(loremCourse()); return; } if (slug) getCourse(slug).then((d) => (d ? setC(d) : setMissing(true))).catch(() => setMissing(true)); }, [slug]);
  // Dynamic-route title: the course name (RouteTitle skips dynamic routes so this owns it).
  useEffect(() => { if (c?.title) document.title = `${c.title} – ArtaQuest`; }, [c?.title]);

  // Reviews + course discussions, loaded lazily the first time their tab is opened.
  const [reviews, setReviews] = useState<CourseReviews | null>(null);
  const [threads, setThreads] = useState<Thread[] | null>(null);
  useEffect(() => { if (tab === "Reviews" && c && reviews === null) getCourseReviews(c.id).then(setReviews).catch(() => setReviews({ average: 0, count: 0, can_review: false, mine: null, items: [] })); }, [tab, c, reviews]);
  useEffect(() => { if (tab === "Discussion" && c && threads === null) getCourseThreads(c.id).then(setThreads).catch(() => setThreads([])); }, [tab, c, threads]);
  // Discussion-rate history, fetched ONCE here and shared with both the header chart and every
  // per-section sparkline — they all draw from the one payload's shared grid, so their axes align 1-to-1.
  const [hist, setHist] = useState<CourseCommentHistory | null>(null);
  useEffect(() => { if (!c?.id) return; let live = true; getCourseCommentHistory(c.id).then((d) => { if (live) setHist(d); }).catch(() => {}); return () => { live = false; }; }, [c?.id]);
  const seriesOf = (video: string): CourseVideoSeries | null => hist?.videos.find((v) => v.video === video) ?? null;
  const [rStars, setRStars] = useState(5);
  const [rBody, setRBody] = useState("");
  const [rBusy, setRBusy] = useState(false);
  const [rErr, setRErr] = useState("");
  const submitReview = async () => {
    if (!c) return; setRBusy(true); setRErr("");
    // Was a try/finally with NO catch — a failed submit (e.g. the server's identity
    // gate) silently did nothing, leaving the learner with no idea why. Surface it.
    try { await postCourseReview(c.id, rStars, rBody); setReviews(await getCourseReviews(c.id)); setRBody(""); }
    catch (e) { setRErr(e instanceof Error ? e.message : "Couldn't save your review — please try again."); }
    finally { setRBusy(false); }
  };
  const [tTitle, setTTitle] = useState("");
  const [tBody, setTBody] = useState("");
  const [tBusy, setTBusy] = useState(false);
  const [tErr, setTErr] = useState("");
  const submitThread = async () => {
    if (!c || !tTitle.trim()) return; setTBusy(true); setTErr("");
    // Was try/finally with NO catch — a failed post (e.g. the identity gate) silently
    // did nothing. Surface the reason so the learner isn't left guessing.
    try { await postCourseThread(c.id, tTitle, tBody); setThreads(await getCourseThreads(c.id)); setTTitle(""); setTBody(""); }
    catch (e) { setTErr(e instanceof Error ? e.message : "Couldn't post — please try again."); }
    finally { setTBusy(false); }
  };

  // Enrolment costs an entry fee in coins — that fee funds the course's seasonal prize pool, which
  // the best-voted questers win back (and then some). Enrol, then jump into the first section.
  const [busy, setBusy] = useState(false);
  const [enrollErr, setEnrollErr] = useState("");
  // /enroll returns 402 when the entry fee isn't covered (new members start with 0 coins). That's the
  // coin paywall working as designed, not a fault — so flag it separately and steer to a wallet top-up
  // rather than surfacing the raw API message as a scary error.
  const [needCoins, setNeedCoins] = useState(false);

  async function buy() {
    if (busy) return;
    setBusy(true); setEnrollErr(""); setNeedCoins(false);
    try {
      const r: EnrollResult = await enrollCourse(slug);
      if (r.ok) { window.location.assign(localePath(c?.start_url || c?.url || `/courses/${slug}/`)); }
    } catch (ex) {
      // 402 = needs coins → show the top-up CTA; anything else (auth, network, server) → a plain message.
      const status = ex && typeof ex === "object" && "status" in ex ? Number((ex as { status?: unknown }).status) : 0;
      if (status === 402) setNeedCoins(true);
      else setEnrollErr(ex instanceof Error ? ex.message : "Could not enrol. Please try again.");
    } finally { setBusy(false); }
  }

  if (missing) return <StatusNote className="py-16">Course not found.</StatusNote>;
  if (!c) return <StatusNote className="py-16">Loading…</StatusNote>;
  // Real video duration only — minutes for short videos, hours for long; hidden when unknown
  // (never fabricated from lesson count, matching the courses grid).
  const durSec = c.duration_sec || 0;
  const durationLabel = durSec >= 3600 ? `~${Math.round(durSec / 3600)}h` : durSec > 0 ? `~${Math.max(1, Math.round(durSec / 60))} min` : "";
  const tabItems = TABS.map((t) => ({ key: t, label: t === "Videos" ? `${t} (${c.lessons_total})` : t }));
  // Courses cost an entry fee; "owns" = already enrolled. Guests sign in first (the API 401s).
  const owns = c.has_access;
  // Show the entry price on the enrol CTA when there's a real fee (a bursary may still cover it).
  const priceLabel = c.price_display && !/free/i.test(c.price_display) ? c.price_display : "";
  const loginUrl = w.AQ_LOGIN_URL || `/login/?redirect_to=${encodeURIComponent(c.url || `/courses/${slug}/`)}`;
  // Absolute, locale-aware course URL for sharing — the page the learner is on, minus any ?tab cursor
  // (so the shared link is the canonical course page whose OG tags unfurl the thumbnail on social).
  const shareUrl = typeof window !== "undefined" ? window.location.origin + window.location.pathname : c.url;

  return (
    <div className="flex flex-col gap-5">
      {/* header: author line above a single grouped action row; title + thumbnail below */}
      <header className="border-b border-line pb-5">
        {/* row 1: the author line — author meta only (Share has moved into the action row below). */}
        <div className="flex items-center gap-2 text-[13px] text-ink-3">
          <Avatar src={c.instructor_avatar} name={c.instructor || "A"} className="h-6 w-6 bg-yin/25 text-[11px]" />
          {c.instructor_url ? (
            // Internal /u/ profile links navigate in-app; only true external URLs (a YouTube
            // channel fallback) open a new tab.
            <a href={c.instructor_url.startsWith("http") ? c.instructor_url : localePath(c.instructor_url)}
              {...(c.instructor_url.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              className="inline-flex items-center gap-1 font-semibold text-ink-2 hover:text-yang">
              {c.instructor || "ArtaQuest"}{c.instructor_verified && <VerifiedBadge />}
            </a>
          ) : (
            <span className="inline-flex items-center gap-1 font-semibold text-ink-2">{c.instructor || "ArtaQuest"}{c.instructor_verified && <VerifiedBadge />}</span>
          )}
          {c.updated && <span>· Updated <time dateTime={c.updated_ts ? new Date(c.updated_ts * 1000).toISOString().slice(0, 7) : undefined}>{c.updated}</time></span>}
        </div>
        {/* row 2 — the action row (ticket #126). Start watching, Join and Share were scattered across
            two separate rows (Share stranded up on the author line, the CTAs below), reading as
            unevenly placed on a phone. They're now ONE aligned block: on mobile the primary CTA spans
            the full width with the secondary actions (Join + Share) sharing an even row beneath; on
            sm+ it collapses to a single inline row, right-aligned where the eye expects the actions. */}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
          {owns ? (
            <Button variant="primaryYin" href={c.start_url || c.url} className="h-9 w-full px-5 text-[14px] sm:w-auto">{c.resume ? "Resume course" : "Start course"}</Button>
          ) : (
            // Watching is always free for everyone — no login, no enrolment, no coins. The entry
            // fee only buys into the discussion + competition (posting replies and voting).
            <Button variant="primaryYin" href={localePath((c.lessons[0]?.url) || c.url)} className="h-9 w-full px-5 text-[14px] sm:w-auto">Start watching · free</Button>
          )}
          {/* Secondary actions — an even pair on mobile (each flex-1, so they fill the row with no
              ragged edge), collapsing to natural width inline on sm+. */}
          <div className="flex gap-2">
            {!owns && (
              !c.logged_in ? (
                <Button variant="outline" href={loginUrl} className="h-9 flex-1 px-4 text-[14px] sm:flex-none">Sign in to compete</Button>
              ) : needCoins ? (
                // The enrol attempt hit the coin paywall — point this CTA straight at the wallet
                // top-up so the click isn't a dead end (the fuller explainer is in the sidebar).
                <Button variant="outline" href="/wallet/#buy" className="h-9 flex-1 px-4 text-[14px] sm:flex-none">Top up to join</Button>
              ) : (
                <Button variant="outline" onClick={buy} disabled={busy} className="h-9 flex-1 px-4 text-[14px] disabled:opacity-60 sm:flex-none">{busy ? "Enrolling…" : priceLabel ? `Join · ${priceLabel}` : "Join"}</Button>
              )
            )}
            <SharePanel title={c.title} url={shareUrl} image={c.image} dialogLabel="Share this course"
              message={`I’m learning “${c.title}” on ArtaQuest — every course is free to watch and a friendly competition where the best questions win a share of the prize pool. Come learn with me:`}
              className="flex-1 sm:flex-none" />
          </div>
        </div>
        {/* row 3: title + topics with an at-a-glance stat block beneath (left), and the course
            thumbnail (right). The discussion-rate card used to stack UNDER the thumbnail in a tall,
            narrow right rail that towered over the short title column — leaving a big empty void on
            the left between the topics and the tabs (ticket #92). The thumbnail is now a single tile
            and the discussion-rate widget sits under the title with the meta chips, so the column
            fills that space and the void is gone. */}
        <div className="mt-3 flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-6">
          <div className="min-w-0 flex-1">
            <h1 className="text-[36px] font-bold leading-[44px]">{c.title}</h1>
            <TopicTags url={c.url} topic={c.topic} topicLabel={c.topicLabel} disciplines={c.disciplines} />
            {/* At-a-glance meta chips. Always carry ≥1 (the video count), so the title column has
                enough height to balance the thumbnail even before a course has any discussion to
                chart — the old layout's imbalance is what produced the void. */}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <MetricChip>{c.lessons_total} {c.lessons_total === 1 ? "video" : "videos"}</MetricChip>
              {durationLabel && <MetricChip>{durationLabel}</MetricChip>}
              {c.level && <MetricChip>{c.level}</MetricChip>}
              {c.language && <MetricChip>{c.language}</MetricChip>}
            </div>
            {/* Discussion-rate band (ticket #96): the "X/day" rate card + a full-width graph of the
                whole hourly comment-rate history. Spans the title column's width so it fills the gap
                that used to sit empty between the rate readout and the thumbnail. */}
            <div className="mt-4">
              <CommentRateChart courseId={c.id} history={hist} />
            </div>
          </div>
          {/* Thumbnail — a single tile now (no stacked card): first on mobile, then on the right
              (vertically centred beside the taller title column) from sm up. */}
          <div className="order-first aspect-[16/10] w-full shrink-0 overflow-hidden rounded-card border border-line sm:order-none sm:w-[260px]">
            {c.image ? <img src={c.image} alt={c.title} fetchPriority="high" decoding="async" className="h-full w-full object-cover" /> : <div className="h-full w-full bg-gradient-to-br from-yang/30 via-yin/30 to-space-2" />}
          </div>
        </div>
      </header>

      {/* tabs: About | Videos | Rankings | Reviews | Discussion */}
      <Tabs tabs={tabItems} active={tab} onChange={(k) => setTab(k as TabKey)} label="Course tabs" className="-mx-gutter px-gutter" />

      {/* two-column body: main + right metadata sidebar */}
      <div className="flex flex-col gap-8 lg:flex-row">
        <div className="min-w-0 flex-1" role="tabpanel" id={`aqpanel-${tab}`} aria-labelledby={`aqtab-${tab}`}>
          {tab === "About" && (
            <>
              <h2 className="mb-3 text-[20px] font-bold tracking-tight">About this course</h2>
              {c.description
                ? <div className="aq-prose text-[16px] leading-relaxed" dangerouslySetInnerHTML={{ __html: c.description }} />
                : <p className="text-[15px] text-ink-3">No description yet — open the Videos tab to see what’s inside.</p>}
            </>
          )}
          {tab === "Videos" && (
            <>
              <p className="mb-3 text-[14px] leading-relaxed text-ink-3">Every video is free to watch — play them in any order. Watch one, then join its discussion: reply and upvote a peer.</p>
              <ol className="list-none">
                {c.lessons.map((l, i) => {
                  const complete = l.complete;
                  return (
                    <li key={l.id} className="flex items-center gap-3 border-b border-line/70 py-3">
                      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold ${complete ? "bg-yang/20 text-yang" : "bg-veil/5 text-ink-3"}`}>
                        {complete
                          ? <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="3" aria-label="Complete"><path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          : i + 1}
                      </span>
                      <a href={localePath(l.url)} className="min-w-0 flex-1 truncate text-[15px] text-ink-2 hover:text-yang">{l.title}</a>
                      {l.video && <SectionRateChart video={l.video} series={seriesOf(l.video)} fallbackRate={l.commentsPerDay} />}
                    </li>
                  );
                })}
                {c.lessons_total > c.lessons.length && (
                  <li className="py-3 text-[14px] text-ink-3">+ {c.lessons_total - c.lessons.length} more videos — <a href={localePath(c.url)} className="text-yang hover:underline">start the course</a></li>
                )}
              </ol>
            </>
          )}
          {tab === "Rankings" && <CourseRankingsPanel courseId={c.id} />}
          {tab === "Reviews" && (
            <div>
              <div className="mb-4 flex items-center gap-3">
                <span className="text-[28px] font-bold tracking-tight">{reviews?.average ? reviews.average.toFixed(1) : "—"}</span>
                <div><Stars n={reviews?.average || 0} size={16} /><p className="text-[13px] text-ink-3">{reviews?.count || 0} review{reviews?.count === 1 ? "" : "s"}</p></div>
              </div>
              {reviews?.can_review && (
                <div className="mb-5 rounded-card border border-line p-4">
                  <p className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-3">{reviews.mine ? "Update your review" : "Write a review"}</p>
                  <div className="mb-2 flex gap-1">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <button key={i} type="button" aria-label={`${i} star${i > 1 ? "s" : ""}`} onClick={() => setRStars(i)}>
                        <svg viewBox="0 0 24 24" width="22" height="22" fill={i <= rStars ? "#E8B923" : "none"} stroke="#E8B923" strokeWidth="1.5" aria-hidden><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 18l-6.2 3.3L7 14.2l-5-4.9 6.9-1z" strokeLinejoin="round" /></svg>
                      </button>
                    ))}
                  </div>
                  <textarea value={rBody} onChange={(e) => setRBody(e.target.value)} rows={3} placeholder="What did you think of this course?" className="w-full rounded-card border border-line bg-transparent p-3 text-[14px] text-ink outline-none focus:border-yang" />
                  <Button type="button" onClick={submitReview} disabled={rBusy} className="mt-2 h-9 text-[14px] disabled:opacity-60">{rBusy ? "Saving…" : "Submit review"}</Button>
                  {rErr && (
                    <p className="mt-2 text-[13px] text-yin-light">
                      {rErr}{" "}
                      {/name|birthday|identity/i.test(rErr) && <a href={localePath("/user-account/")} className="font-semibold text-yang hover:underline">Update your profile →</a>}
                    </p>
                  )}
                </div>
              )}
              <ul className="list-none">
                {(reviews?.items || []).map((r, i) => (
                  <li key={i} className="flex gap-3 border-b border-line/70 py-4">
                    <Avatar src={r.avatar} country={r.country} className="h-9 w-9 shrink-0" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2"><a href={localePath(`/u/${r.slug}/`)} className="text-[14px] font-semibold text-ink hover:text-yang">{r.author}</a><Stars n={r.rating} /></div>
                      {r.body && <p className="mt-1 text-[14px] leading-relaxed text-ink-2">{r.body}</p>}
                    </div>
                  </li>
                ))}
                {reviews && reviews.items.length === 0 && <li className="py-6 text-[14px] text-ink-3">No reviews yet{reviews.can_review ? " — be the first." : ". Enrol to leave one."}</li>}
              </ul>
            </div>
          )}
          {tab === "Discussion" && (
            <div>
              {/* The competition lives on the unified board: every section's discussion is browsable
                  from the global /discussions home, grouped under this course. */}
              <a href={localePath(`/discussions?course=${c.id}`)}
                className="mb-6 flex items-center justify-between gap-3 rounded-card border border-yin/30 bg-yin/5 px-4 py-3.5 transition-colors hover:border-yin/60">
                <span className="min-w-0">
                  <span className="block text-[14px] font-semibold text-ink">Section discussion boards</span>
                  <span className="block text-[13px] text-ink-3">Watch a section, then reply and upvote — the most-upvoted replies climb the rankings.</span>
                </span>
                <span className="shrink-0 text-[14px] font-semibold text-yin-light">Browse →</span>
              </a>

              {/* Course Q&A — free, course-level threads open to everyone (distinct from the per-section
                  competition boards above); kept here so no existing thread is orphaned. */}
              <p className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-3">Course Q&amp;A</p>
              {isLoggedIn() && (
                <div className="mb-5 rounded-card border border-line p-4">
                  <input value={tTitle} onChange={(e) => setTTitle(e.target.value)} placeholder="Title" className="mb-2 w-full rounded-card border border-line bg-transparent p-2.5 text-[14px] text-ink outline-none focus:border-yang" />
                  <textarea value={tBody} onChange={(e) => setTBody(e.target.value)} rows={3} placeholder="Ask a question or share a thought… (LaTeX with $…$ supported)" className="w-full rounded-card border border-line bg-transparent p-3 text-[14px] text-ink outline-none focus:border-yang" />
                  <Button type="button" onClick={submitThread} disabled={tBusy || !tTitle.trim()} className="mt-2 h-9 text-[14px] disabled:opacity-60">{tBusy ? "Posting…" : "Post"}</Button>
                  {tErr && (
                    <p className="mt-2 text-[13px] text-yin-light">
                      {tErr}{" "}
                      {/name|birthday|identity/i.test(tErr) && <a href={localePath("/user-account/")} className="font-semibold text-yang hover:underline">Update your profile →</a>}
                    </p>
                  )}
                </div>
              )}
              <ul className="list-none">
                {(threads || []).map((t) => (
                  <li key={t.slug} className="border-b border-line/70 py-3">
                    <a href={localePath(t.url)} className="text-[15px] font-semibold text-ink hover:text-yang">{t.title}</a>
                    <p className="text-[12px] text-ink-3">{t.author} · {t.replies} repl{t.replies === 1 ? "y" : "ies"} · {t.last_at}</p>
                  </li>
                ))}
                {threads && threads.length === 0 && <li className="py-6 text-[14px] text-ink-3">No course Q&amp;A yet{isLoggedIn() ? " — start one above." : ". Sign in to start one."}</li>}
              </ul>
            </div>
          )}
        </div>

        {/* lg:me-16 reserves the bottom-right lane the fixed ArtaBot launcher floats in: this right rail
            is flush to the viewport edge, so on common laptop heights the launcher's disc landed on the
            Enrol button and obscured its label (ticket #88). The launcher only auto-hides on touch (it
            stays on for desktop's fine pointer), so the desktop rail must step aside for it. */}
        <aside className="w-full shrink-0 lg:me-16 lg:w-[268px] lg:border-l lg:border-line lg:pl-8">
          <dl className="flex flex-col gap-4">
            <MetaRow label="Videos" value={String(c.lessons_total)} />
            {durationLabel && <MetaRow label="Duration" value={durationLabel} />}
            {/* Level + Language render ONLY when the backend actually supplies them — the course
                payload carries neither today, so don't fabricate "Beginner"/"English" defaults
                (right for Chess by luck, wrong for any other course). Same hide-when-unknown rule
                as Duration above and the Updated date in the header. */}
            {c.level && <MetaRow label="Level" value={c.level} />}
            <MetaRow label="Certificate" value="Earn it by completing every video" />
            {c.language && <MetaRow label="Language" value={c.language} />}
          </dl>
          {!owns && (
            <div className="mt-5 border-t border-line pt-4">
              {!c.logged_in ? (
                <Button variant="primaryYin" href={loginUrl} className="h-10 w-full text-[14px]">Sign in to enrol</Button>
              ) : (
                <>
                  <Button variant="primaryYin" onClick={buy} disabled={busy} className="h-10 w-full text-[14px] disabled:opacity-60">{busy ? "Enrolling…" : priceLabel ? `Enrol · ${priceLabel}` : "Enrol"}</Button>
                  {/* A 402 is the coin paywall, not a fault: new members start with 0 coins and the entry
                      fee funds the prize pool they can win back. So instead of the raw API error, guide
                      the learner to top up their wallet — with a bursary as the no-cost path. */}
                  {needCoins && (
                    <div role="alert" className="mt-3 rounded-card border border-yang/30 bg-yang/[0.06] p-3.5">
                      <p className="text-[13px] font-semibold text-ink">{priceLabel ? `You need ${priceLabel} to join` : "You need coins to join"}</p>
                      <p className="mt-1 text-[12px] leading-relaxed text-ink-2">Watching stays free — joining the competition costs the entry fee, which funds the prize pool. Top up your wallet to enrol.</p>
                      <Button variant="primaryYin" href="/wallet/#buy" className="mt-2.5 h-9 w-full text-[13px]">Top up your wallet</Button>
                      <p className="mt-2 text-[12px] text-ink-3">Fee a barrier? <a href={localePath("/sponsors/")} className="font-semibold text-yang hover:underline">Apply for a bursary</a></p>
                    </div>
                  )}
                  {/* Any non-paywall failure (network, server, session) — a plain message, no misleading top-up links. */}
                  {enrollErr && <p role="alert" className="mt-2 text-[12px] text-rose-300">{enrollErr}</p>}
                </>
              )}
              <p className="mt-2 text-[12px] leading-relaxed text-ink-3">Watching is free. {priceLabel ? <>Joining the competition costs <strong className="text-ink-2">{priceLabel}</strong> — 1 coin per video — and</> : "Joining the competition costs 1 coin per video, and"} funds the prize pool. Reply and upvote in each video’s discussion; the most-upvoted questers top the <button type="button" onClick={() => setTab("Rankings")} className="text-yang hover:underline">course rankings</button> and the top three win it back and more (50/30/20). <a href={localePath("/sponsors/")} className="text-yang hover:underline">Sponsors</a> can cover the fee.</p>
            </div>
          )}
          {owns && <p className="mt-5 border-t border-line pt-4 text-[13px] text-ink-3">You’re enrolled — pick up where you left off, or see the <button type="button" onClick={() => setTab("Rankings")} className="text-yang hover:underline">course rankings</button>.</p>}
        </aside>
      </div>
    </div>
  );
}
