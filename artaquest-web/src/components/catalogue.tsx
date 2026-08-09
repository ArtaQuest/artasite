/**
 * Catalogue card family — the unified ResultCard the browse pages (Courses · Topics · Grants ·
 * Discussions · Donate) all render, so a course, a topic, a grant, a discussion and a cause read
 * as one bespoke system. (The Explore hub that shared them is gone: /explore was retired to a
 * redirect to /works, and its page + search hook were dead code.) Built on the Orbit primitives in ui.tsx
 * (Card surface, MetricChip, Avatar). Cards take NORMALISED props — each caller maps its own row
 * (the wp.ts page shapes OR the /search result shapes) into them, so the card never couples to a
 * single backend shape. Two accents only (gold = the chosen/earned metric, blue = hover), no third
 * hue; status nuance stays inside gold/blue/ink.
 */
/* eslint-disable react-refresh/only-export-components -- catalogue kit module: like ui.tsx it
   exports the card components AND the small shared helpers/types (DomainGlyph, fmtDate, daysUntil)
   they're built from, in one cohesive place. */
import { type ReactNode } from "react";
import { localePath } from "../lib/wp";
import { CoinMark, formatDuration } from "../lib/currency";
import { Avatar, MetricChip, cx } from "./ui";
import { thumbSrc, thumbSrcSet, CARD_THUMB_SIZES } from "../lib/img";
import { CATEGORY_GROUPS, STYLE_HOW, STYLE_LABEL, AXIS_COLOR } from "../lib/typology-meta";

/* The five catalogue domains (+ explore for the hub) — one monochrome glyph each (the brand
   stays two-colour; domains are told apart by glyph + copy, never a new hue). */
export type Domain = "explore" | "course" | "topic" | "group" | "grant" | "discussion" | "cause";

const compact = (n: number) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);

// Whole days from now until a UNIX SECOND (`daysUntil` below is the other one — a date string, for
// grant deadlines). Reads the wall clock, so it lives OUTSIDE the render path: react-hooks/purity
// rightly refuses `Date.now()` in a component body. Re-deriving a countdown per render is correct
// behaviour for a countdown — the rule's objection is to the call site, not the arithmetic.
const daysFromNow = (ts?: number) => (ts ? Math.max(0, Math.ceil((ts - Date.now() / 1000) / 86400)) : 0);

/** Relative time from unix seconds ("3d", "2h", "just now"). Strings (already-relative) pass through. */
function rel(at?: string | number): string {
  if (at == null || at === "") return "";
  if (typeof at === "string") return at;
  const s = Math.max(0, Math.floor(Date.now() / 1000) - at);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo`;
  return `${Math.floor(mo / 12)}y`;
}

/** Gradient tints for course tiles without a thumbnail (gold/blue only — no third hue). */
const TINTS = ["from-yang/30 to-space-2", "from-yin/40 to-space-2", "from-yang/25 to-yin/20", "from-yin/30 to-space-3"];
const tintFor = (seed: string) => TINTS[[...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length];

/* ───────────────────────── DomainGlyph ─────────────────────────
   Single-stroke currentColor marks; sit in the PageHero eyebrow, EmptyState and topic chips. */
export function DomainGlyph({ domain, className }: { domain: Domain; className?: string }) {
  const p: Record<Domain, ReactNode> = {
    explore: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" strokeLinecap="round" /></>,
    course: <><circle cx="12" cy="12" r="9" /><path d="M10 9l5 3-5 3z" strokeLinejoin="round" /></>,
    topic: <><circle cx="12" cy="12" r="2.4" /><circle cx="12" cy="12" r="6.2" /><circle cx="12" cy="12" r="9.4" strokeOpacity=".55" /></>,
    group: <><circle cx="9" cy="9" r="3" /><path d="M4 19c0-3 2.2-5 5-5s5 2 5 5" strokeLinecap="round" /><path d="M15.5 6.4a2.6 2.6 0 0 1 0 5.2" strokeLinecap="round" strokeOpacity=".6" /><path d="M16 14.2c2 .4 3.5 2.2 3.5 4.8" strokeLinecap="round" strokeOpacity=".6" /></>,
    grant: <><path d="M12 3v8" strokeLinecap="round" /><path d="M12 11c0-3 2-5 5-5 0 3-2 5-5 5z" strokeLinejoin="round" /><path d="M12 11c0-3-2-5-5-5 0 3 2 5 5 5z" strokeLinejoin="round" /><path d="M6 14h12l-1 6H7z" strokeLinejoin="round" /></>,
    discussion: <><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z" strokeLinejoin="round" /></>,
    cause: <><path d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.6-7 9-7 9z" strokeLinejoin="round" /></>,
  };
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden className={cx("shrink-0", className)}>{p[domain]}</svg>;
}

/* ───────────────────────── StatusBadge (topic honesty label) ─────────────────────────
   Empirical/validated instruments get a blue badge; everything else a neutral one — so the
   honesty label is visible without a third colour. Shared so every surface showing a topic matches. */
export function StatusBadge({ label, empirical, className }: { label: string; empirical?: boolean; className?: string }) {
  return (
    <span className={cx("inline-flex items-center rounded-pill px-2 py-0.5 text-[11px] font-semibold",
      empirical ? "bg-yin/15 text-yin-light" : "bg-veil/[0.06] text-ink-2", className)}>
      {label}
    </span>
  );
}

/* ───────────────────────── AstroSignature ─────────────────────────
   Every topic's signature, read as two PLAIN questions: WHAT (the field) and HOW (the style). Plain phrases
   only — no astrology term is ever shown. (WHY was retired as a content tag — operator 2026-06-24; it lives
   only as the 12 transiting cycles.) `rows` (default) stacks them; `inline` is a compact one-liner. */
const HOUSE_LABEL_OF: Record<string, string> = Object.fromEntries(CATEGORY_GROUPS.map((g) => [g.key, g.label]));
// Each facet shows a single-word TITLE (`label`); `tip` is its PLAIN hover explanation (rendered as a native
// tooltip + a dotted underline that signals it's hoverable). WHAT is the field name (self-explanatory, no tip);
// HOW + WHY carry the crafted style/motivation words, each explained on hover. No astrology term is ever shown.
export type AstroFacet = { q: string; label: string; tip: string; axis: "what" | "how" | "why" };
export function astroFacets(house?: string, sign?: string): AstroFacet[] {
  const out: AstroFacet[] = [];
  if (house && HOUSE_LABEL_OF[house]) out.push({ q: "What", label: HOUSE_LABEL_OF[house], tip: "", axis: "what" });
  if (sign && STYLE_LABEL[sign]) out.push({ q: "How", label: STYLE_LABEL[sign], tip: STYLE_HOW[sign] || "", axis: "how" });
  return out;
}
const FACET_COLOR: Record<string, string | undefined> = { how: AXIS_COLOR.how, why: AXIS_COLOR.why };
// A facet word with a tip gets a dotted underline + help cursor so users know to hover for the explanation.
const TIP_CLASS = "cursor-help underline decoration-dotted decoration-ink-3/40 underline-offset-2";
/** A plain one-line summary (for a container tooltip): "What: Psychology · How: Mysterious — … · Why: Seeking — …". */
export function astroSummary(house?: string, sign?: string): string {
  return astroFacets(house, sign).map((f) => `${f.q}: ${f.label}${f.tip ? ` — ${f.tip}` : ""}`).join("  ·  ");
}
export function AstroSignature({ house, sign, className, variant = "rows" }: { house?: string; sign?: string; className?: string; variant?: "rows" | "inline" }) {
  const facets = astroFacets(house, sign);
  if (!facets.length) return null;
  if (variant === "inline") {
    return (
      <span className={cx("inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3", className)}>
        {facets.flatMap((f, i) => {
          const el = (
            <span key={f.q} className="inline-flex items-center gap-1">
              <span className="font-semibold" style={FACET_COLOR[f.axis] ? { color: FACET_COLOR[f.axis] } : undefined}>{f.q}</span>{" "}
              <span title={f.tip || undefined} className={cx("text-ink-2", f.tip && TIP_CLASS)}>{f.label}</span>
            </span>
          );
          return i === 0 ? [el] : [<span key={`s${i}`} aria-hidden className="text-ink-3/40">·</span>, el];
        })}
      </span>
    );
  }
  return (
    <dl className={cx("grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-1 text-[13px]", className)}>
      {facets.map((f) => (
        <div key={f.q} className="contents">
          <dt className="font-semibold text-ink-2" style={FACET_COLOR[f.axis] ? { color: FACET_COLOR[f.axis] } : undefined}>{f.q}</dt>
          <dd title={f.tip || undefined} className={cx("text-ink-2", f.tip && TIP_CLASS)}>{f.label}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ───────────────────────── ResultGrid ─────────────────────────
   grid = responsive cards (the full catalogues: Courses · Topics · Grants) · rail = mobile snap-scroll
   then grid (the Explore hub's course preview shelves, a peek-scroll beside a "See all" link) · list =
   full-width stacked rows (discussions). One wrapper so every surface's spacing/columns match. */
export function ResultGrid({ variant = "grid", children, className }: { variant?: "grid" | "rail" | "list"; children: ReactNode; className?: string }) {
  if (variant === "list") return <div className={cx("flex flex-col gap-2.5", className)}>{children}</div>;
  // Mobile = horizontal snap-scroll: each card needs a fixed width + shrink-0 (the card Shell is
  // overflow-hidden, so a flex item's min-width:auto resolves to 0 — without this the cards collapse
  // to ~0-width slivers instead of scrolling). At sm+ it becomes the responsive grid (width reset).
  if (variant === "rail") return <div className={cx("-mx-gutter flex snap-x gap-4 overflow-x-auto px-gutter pb-2 [scrollbar-width:none] [&>*]:w-[78%] [&>*]:shrink-0 [&>*]:snap-start sm:mx-0 sm:grid sm:grid-cols-2 sm:gap-5 sm:overflow-visible sm:px-0 sm:[&>*]:w-auto lg:grid-cols-3 xl:grid-cols-4", className)}>{children}</div>;
  return <div className={cx("grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4", className)}>{children}</div>;
}

/* ───────────────────────── ResultCard ─────────────────────────
   One shell, five normalised variants. Whole card is a link (href) or a toggle (onClick); the
   blue hover + gold focus ring are shared. Footer metrics use mt-auto so a row stays even. */
type Common = { href?: string; onClick?: () => void; selected?: boolean; className?: string };
export type ResultCardProps = Common & (
  | { variant: "course"; title: string; image?: string; lessons?: number; duration?: number; commentsPerDay?: number; commentsTotal?: number; pool?: number; seasonEnds?: number }
  | { variant: "topic"; name: string; image?: string; status?: string; empirical?: boolean; blurb?: string; count?: number; category?: string }
  | { variant: "group"; label: string; image?: string; topic?: string; desc?: string }
  | { variant: "grant"; title: string; funder?: string; country?: string; amount?: string; deadline?: string; rolling?: boolean; fit?: number; slotsLeft?: number; capacity?: number }
  | { variant: "discussion"; title: string; author?: string; at?: string | number; votes?: number; replies?: number; pinned?: boolean; topic?: string; srcLang?: string }
  | { variant: "cause"; name: string; sub?: string; members?: number; raised?: number }
);

// No explicit height — cards rely on the grid/flex container's `align-items: stretch` to fill the
// row to an EQUAL height. An explicit `h-full` (height:100%) breaks this on the mobile snap-rail:
// in WebKit/iOS a height:100% flex item in an indefinite-height row collapses to its own content
// height instead of stretching, so cards rendered at mismatched heights (ticket #107). With
// height:auto, stretch applies in every browser and `mt-auto` keeps the footer metrics on a shared
// baseline.
const SHELL = "group relative flex flex-col overflow-hidden rounded-card border bg-space-2 text-start shadow-card transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yang focus-visible:ring-offset-2 focus-visible:ring-offset-space-1";

function Shell({ href, onClick, selected, label, children }: Common & { label?: string; children: ReactNode }) {
  const cls = cx(SHELL, selected ? "border-yang" : "border-line hover:border-yin-light/40");
  if (href) return <a href={localePath(href)} aria-label={label} className={cls}>{children}</a>;
  if (onClick) return <button type="button" onClick={onClick} aria-pressed={selected} className={cls}>{children}</button>;
  return <div className={cls}>{children}</div>;
}

function TrendIcon() {
  return <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><path d="M5 18l5-6 4 4 5-8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function ResultCard(p: ResultCardProps) {
  // leading-normal (1.5), not leading-snug: card titles render in the tall Montserrat display font.
  // The clamped/truncated variants below add `overflow: hidden`; with too little room the clip box
  // shaves the tops of the first line's capitals/diacritics (ticket #138). Leading alone is marginal
  // (it left ~2px above the caps), so the clamped course title additionally pads its top — see below.
  const titleCls = "font-semibold leading-normal text-ink transition-colors group-hover:text-yang";

  if (p.variant === "course") {
    const metric = p.commentsPerDay && p.commentsPerDay > 0
      ? <MetricChip dense tone="gold" icon={<TrendIcon />} title={`Its average video draws about ${p.commentsPerDay.toLocaleString("en")} YouTube comments a day${p.commentsTotal ? ` — ${p.commentsTotal.toLocaleString("en")} comments in total` : ""} — how much discussion this course's videos draw`}>{compact(p.commentsPerDay)}/day</MetricChip>
      : p.commentsTotal && p.commentsTotal > 0 ? <MetricChip dense>{compact(p.commentsTotal)} comments</MetricChip> : null;
    // Live prize pool + season countdown — the strongest enrol signal a card can carry.
    const daysLeft = daysFromNow(p.seasonEnds);
    const poolChip = p.pool && p.pool > 0
      ? <MetricChip dense tone="gold" title={`This season's prize pool is ₳${p.pool.toLocaleString("en")} — the top three questers share it${daysLeft ? `; the season closes in ${daysLeft} day${daysLeft === 1 ? "" : "s"}` : ""}`}>₳{compact(p.pool)} pool{daysLeft ? ` · ${daysLeft}d` : ""}</MetricChip>
      : null;
    return (
      <Shell href={p.href} onClick={p.onClick} selected={p.selected} label={p.title}>
        <div className={cx("relative aspect-[16/9] w-full overflow-hidden", !p.image && `bg-gradient-to-br ${tintFor(p.title)}`)}>
          {p.image
            ? <img src={thumbSrc(p.image)} srcSet={thumbSrcSet(p.image)} sizes={CARD_THUMB_SIZES} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
            : <DomainGlyph domain="course" className="absolute inset-0 m-auto h-10 w-10 text-ink/25" />}
        </div>
        <div className="flex flex-1 flex-col gap-2 p-4">
          {/* Reserve two lines for the title so a one-line title ("Chess") occupies the same band as a
              wrapped one ("Romantic Love…") — that keeps every card's footer metrics on a shared
              baseline regardless of which stats are present (#107). The line-clamp adds `overflow:hidden`,
              which in the tall Montserrat face (h3 → font-display) shaves the FIRST line's capital tops;
              an explicit pt-[0.3em] keeps the clip edge clear of the capitals on every engine — WebKit's
              -webkit-line-clamp box is the tightest, and 0.2em still grazed it (ticket #138). min-h grows
              to match so both lines stay fully visible (band = 0.3em pad + 2 × leading-normal + slack). */}
          <h3 className={cx(titleCls, "line-clamp-2 min-h-[3.4em] pt-[0.3em] text-[15px]")}>{p.title}</h3>
          {/* Footer metrics. The three core stats (videos · duration · comments/day) sit in their own
              nowrap group so a card can never split "44.9/day" onto a second line — they're `dense` so
              the trio still fits one row on the ~220px-wide 4-up (xl) card where the default pill wrapped
              (ticket #138). The optional prize-pool chip is the ONE element allowed to drop below when
              space is tight, where it reads as an intentional highlighted badge rather than a stray stat. */}
          <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
            <span className="flex items-center gap-1">
              {p.lessons ? <MetricChip dense>{p.lessons} {p.lessons === 1 ? "video" : "videos"}</MetricChip> : null}
              {p.duration ? <MetricChip dense>{formatDuration(p.duration)}</MetricChip> : null}
              {metric}
            </span>
            {poolChip}
          </div>
        </div>
      </Shell>
    );
  }

  if (p.variant === "topic") {
    return (
      <Shell href={p.href} onClick={p.onClick} selected={p.selected} label={p.name}>
        <div className="flex flex-1 flex-col gap-2 p-4">
          <div className="flex items-center justify-between gap-2">
            {/* Group profile picture, or its letter avatar when none is set (ticket #67) — matches the Topics page cards. */}
            <Avatar src={p.image} name={p.name} className="h-9 w-9 text-sm" />
            {p.status && <StatusBadge label={p.status} empirical={p.empirical} />}
          </div>
          <h3 className={cx(titleCls, "text-[15px]")}>{p.name}</h3>
          {p.blurb && <p className="line-clamp-2 text-[13px] leading-relaxed text-ink-3">{p.blurb}</p>}
          <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
            {p.category && <MetricChip>{p.category}</MetricChip>}
            {p.count ? <MetricChip>{p.count} options</MetricChip> : null}
          </div>
        </div>
      </Shell>
    );
  }

  if (p.variant === "group") {
    return (
      <Shell href={p.href} onClick={p.onClick} selected={p.selected} label={p.label}>
        <div className="flex flex-1 flex-col gap-2 p-4">
          {/* The group's headshot/emblem — the same face the Topics page + a member's profile show. */}
          <Avatar src={p.image} name={p.label} className="h-9 w-9 text-sm" />
          <h3 className={cx(titleCls, "text-[15px]")}>{p.label}</h3>
          {p.desc && <p className="line-clamp-2 text-[13px] leading-relaxed text-ink-3">{p.desc}</p>}
          <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
            {p.topic && <MetricChip>{p.topic}</MetricChip>}
          </div>
        </div>
      </Shell>
    );
  }

  if (p.variant === "grant") {
    const soon = !p.rolling && p.deadline ? daysUntil(p.deadline) : null;
    return (
      <Shell href={p.href} onClick={p.onClick} selected={p.selected} label={p.title}>
        <div className="flex flex-1 flex-col gap-2 p-4">
          <span className="grid h-9 w-9 place-items-center rounded-card bg-yang/10 text-yang"><DomainGlyph domain="grant" className="h-5 w-5" /></span>
          <h3 className={cx(titleCls, "line-clamp-2 text-[15px]")}>{p.title}</h3>
          {(p.funder || p.country) && <p className="truncate text-[13px] text-ink-3">{[p.funder, p.country].filter(Boolean).join(" · ")}</p>}
          <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
            {p.amount && <MetricChip tone="gold">{p.amount}</MetricChip>}
            {p.deadline && !p.rolling ? <MetricChip tone={soon != null && soon <= 30 ? "gold" : "neutral"}>{fmtDate(p.deadline)}</MetricChip> : <MetricChip>Rolling</MetricChip>}
            {p.fit && p.fit >= 4 ? <MetricChip tone="gold">Fit {p.fit}</MetricChip> : null}
            {p.slotsLeft != null && p.capacity != null ? <MetricChip>{p.slotsLeft}/{p.capacity} slots</MetricChip> : null}
          </div>
        </div>
      </Shell>
    );
  }

  if (p.variant === "discussion") {
    const scoreColor = (p.votes ?? 0) < 0 ? "text-rose-400" : "text-ink-2";
    // User-authored title → translate into the reader's language (global board) when srcLang is given,
    // unless it's already in that language (the i18n engine skips data-ay-src === current).
    const trMark = p.srcLang !== undefined ? { "data-ay-tr": "1", "data-ay-src": p.srcLang || "en" } : {};
    return (
      <Shell href={p.href} onClick={p.onClick} selected={p.selected} label={p.title}>
        <div className="flex flex-1 items-center gap-3 p-3.5">
          <Avatar name={p.author} className="h-9 w-9 shrink-0 text-sm" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              {p.pinned && <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" className="shrink-0 text-yang" aria-label="Pinned"><path d="M16 3l5 5-4 1-4 4 1 5-3 1-2-2-7 7v-2l7-7-2-2 1-3 5 1 4-4z" /></svg>}
              <span {...trMark} className={cx(titleCls, "truncate text-[14px]")}>{p.title}</span>
            </span>
            <span className="mt-0.5 block truncate text-[12px] text-ink-3">{[p.author, rel(p.at)].filter(Boolean).join(" · ")}</span>
          </span>
          <span className="flex shrink-0 items-center gap-3 text-[12px]">
            <span className={cx("inline-flex items-center gap-1 font-semibold tabular-nums", scoreColor)}>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden><path d="M12 4l8 10h-5v6H9v-6H4z" /></svg>{p.votes ?? 0}
            </span>
            <span className="inline-flex items-center gap-1 text-ink-3"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z" strokeLinejoin="round" /></svg>{p.replies ?? 0}</span>
          </span>
        </div>
      </Shell>
    );
  }

  // cause
  return (
    <Shell href={p.href} onClick={p.onClick} selected={p.selected} label={p.name}>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <span className="grid h-9 w-9 place-items-center rounded-card bg-yang/10 text-yang"><DomainGlyph domain="cause" className="h-5 w-5" /></span>
        <h3 className={cx(titleCls, "text-[15px]")}>{p.name}</h3>
        {p.sub && <p className="line-clamp-2 text-[13px] text-ink-3">{p.sub}</p>}
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          {p.members != null && <MetricChip>{compact(p.members)} {p.members === 1 ? "member" : "members"}</MetricChip>}
          {p.raised ? <MetricChip tone="gold"><CoinMark className="h-3 w-3" />{compact(p.raised)}</MetricChip> : null}
        </div>
      </div>
    </Shell>
  );
}

/* ── grant date helpers (shared with the Sponsors page) ── */
const M_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDate(d: string): string {
  if (!d) return "Rolling";
  const [y, m, day] = d.split("-").map(Number);
  if (!y || !m || !day) return d;
  return `${M_ABBR[m - 1]} ${day}, ${y}`;
}
export function daysUntil(d: string): number | null {
  if (!d) return null;
  const t = Date.parse(d + "T00:00:00");
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

