/**
 * ArtaQuest UI design system — "Orbit". The reusable primitives every page is built
 * from: gold (the Why) / blue (the How) on a neutral dark-gray cosmos, soft
 * geometry, Montserrat display type. One place to change a variant. Tokens live
 * in index.css (@theme).
 */
/* eslint-disable react-refresh/only-export-components -- design-system module: by design it exports
   UI primitives AND the shared helpers/types (cx, variants) they're built from, in one place. */
import { forwardRef, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type ButtonHTMLAttributes, type AnchorHTMLAttributes, type ElementType, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { twMerge } from "tailwind-merge";
import { postDiscVote, getVoters, localePath, isLoggedIn, type Voter, type VoterRoster } from "../lib/wp";
import { createVoteCaster } from "../lib/votes";
import { watchMath } from "../lib/math";
import { countryName, flagEmoji } from "../lib/flags";

/** Classname joiner with Tailwind conflict resolution (last wins) — so a primitive's
 *  default utilities can be safely overridden by a caller's className. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return twMerge(parts.filter(Boolean).join(" "));
}

/* ───────────────────────── Button ───────────────────────── */
export type ButtonVariant = "primary" | "primaryYin" | "outline" | "ghost" | "subtle";
export type ButtonSize = "sm" | "md" | "lg" | "xl";

// Signature: primary rests gold (the Why), lifts to blue (the How) with a glow on
// hover — the duality in motion. Outline/ghost/subtle stay quiet for dense UI.
// Derived from the LIVE yin token, not a literal. #2352E8 is a legitimate sentinel elsewhere — the
// global remap in index.css rewrites [fill]/[stroke]/[stop-color] of that exact hex to the theme's
// blue — but a box-shadow is none of those, so the literal here was simply the retired blue, frozen.
// It stayed rgb(35,82,232) while the button's fill and text followed --color-yin (#1746DC) through
// every theme and contrast level: the one part of the button that did not move with the rest.
const GLOW_YIN = "hover:shadow-[0_8px_28px_color-mix(in_srgb,var(--color-yin)_38%,transparent)]";
const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary: `rounded-pill bg-yang font-bold text-on-accent shadow-card hover:-translate-y-0.5 active:translate-y-0 hover:bg-yin hover:text-white ${GLOW_YIN}`,
  primaryYin: `rounded-pill bg-yang font-bold text-on-accent shadow-card hover:-translate-y-0.5 active:translate-y-0 hover:bg-yin hover:text-white ${GLOW_YIN}`, // course "Start"
  outline: "rounded-pill border border-line font-semibold text-ink-2 hover:border-yin-light hover:text-ink",
  ghost: "rounded-field text-ink-2 hover:bg-veil/5 hover:text-ink",
  subtle: "rounded-pill bg-veil/5 font-semibold text-ink-2 hover:bg-veil/10 hover:text-ink",
};
const BTN_SIZE: Record<ButtonSize, string> = {
  sm: "h-9 px-4 text-[14px]",
  md: "h-11 px-5 text-[14px]",
  lg: "h-11 px-6 text-[15px]",
  xl: "h-12 px-7 text-[15px]",
};

/** A button explainer: a short string, or a { title, body } for a richer, methodology-style one. */
export type ButtonTip = string | { title: string; body: string };
type ButtonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  href?: string;
  className?: string;
  /** Hover/focus explainer, rendered in an on-brand styled bubble (string, or { title, body }). */
  tip?: ButtonTip;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement> & AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "children">;

/** The explainer bubble — PORTALLED to <body> (so no ancestor's overflow can clip it), FIXED-positioned and
 *  measured, then CLAMPED to the viewport so it can never overflow an edge, with an inline maxWidth so the
 *  text always wraps (never overruns). COLOURS use the theme tokens (bg-space-3 / text-ink / border-line),
 *  so it flips with light/dark mode exactly like a Card; only layout/position is inline (always-applies). */
function TipBubble({ anchor, tip }: { anchor: DOMRect; tip: ButtonTip }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const M = 8, GAP = 8;
    const vw = window.innerWidth, vh = window.innerHeight;
    const above = anchor.top - r.height - GAP >= M;            // prefer above; flip below if no room
    let top = above ? anchor.top - r.height - GAP : anchor.bottom + GAP;
    top = Math.max(M, Math.min(top, vh - r.height - M));        // clamp vertically
    let left = anchor.left + anchor.width / 2 - r.width / 2;    // centre on the button…
    left = Math.max(M, Math.min(left, vw - r.width - M));       // …then clamp horizontally → never overflow
    setPos({ left, top });
  }, [anchor]);
  return createPortal(
    <div ref={ref} role="tooltip"
      style={{
        position: "fixed", left: pos?.left ?? 0, top: pos?.top ?? 0, zIndex: 9999,
        maxWidth: "min(20rem, calc(100vw - 16px))",
        opacity: pos ? 1 : 0, transition: "opacity 120ms ease-out", pointerEvents: "none",
        boxShadow: "0 14px 36px -8px rgba(2,8,20,0.4)",
      }}
      className="rounded-xl border border-line bg-space-3 px-3.5 py-2.5 text-start">
      {typeof tip === "string"
        ? <span className="text-[13px] leading-relaxed text-ink-2">{tip}</span>
        : <>
            <div className="text-[13px] font-semibold leading-snug text-ink">{tip.title}</div>
            <div className="mt-1 text-[12.5px] leading-relaxed text-ink-3">{tip.body}</div>
          </>}
    </div>,
    document.body,
  );
}

/** Polymorphic button — renders <a> when `href` is set, else <button>. Size/width via className. A `tip`
 *  shows a portalled, viewport-clamped explainer bubble on hover/focus (+ an aria-label for assistive tech). */
export function Button({ variant = "primary", size = "md", href, className, tip, children, ...rest }: ButtonProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const open = () => { if (tip && ref.current) setAnchor(ref.current.getBoundingClientRect()); };
  const close = () => setAnchor(null);
  useEffect(() => {
    if (!anchor) return;
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [anchor]);
  const cls = cx(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50",
    BTN_VARIANT[variant],
    BTN_SIZE[size],
    className,
  );
  const hov = tip ? { onMouseEnter: open, onMouseLeave: close, onFocus: open, onBlur: close } : {};
  const aria = tip ? { "aria-label": (rest as { "aria-label"?: string })["aria-label"] || (typeof tip === "string" ? tip : tip.title) } : {};
  const bubble = anchor && tip ? <TipBubble anchor={anchor} tip={tip} /> : null;
  const setRef = (el: HTMLElement | null) => { ref.current = el; };
  return href
    ? <a ref={setRef} href={localePath(href)} className={cls} {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)} {...hov} {...aria}>{children}{bubble}</a>
    : <button ref={setRef} type="button" className={cls} {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)} {...hov} {...aria}>{children}{bubble}</button>;
}

/* ───────────────────────── Card ───────────────────────── */
export function Card({ as: As = "div", className, children, ...rest }: { as?: ElementType; className?: string; children: ReactNode } & Record<string, unknown>) {
  return <As className={cx("rounded-card border border-line bg-space-2 shadow-card", className)} {...rest}>{children}</As>;
}

/* ───────────────────────── Avatar ───────────────────────── */
/** Country-flag chip on an avatar — the VERIFIED-nationality badge (ticket #30; '' until the member
 *  passes the blue check, so it can't render an unverified claim). Defaults assume a `relative`
 *  parent and scale with it (percentage box, emoji in an SVG so the glyph scales to ANY chip size);
 *  override position/size via className for custom spots (e.g. the feed rows, the topbar trigger). */
export function FlagBadge({ country, className }: { country?: string; className?: string }) {
  const flag = flagEmoji(country);
  if (!flag) return null;
  const label = countryName(country);
  return (
    <span role="img" aria-label={label} title={label}
      className={cx("absolute -bottom-[10%] -right-[10%] grid aspect-square w-[44%] min-w-3.5 place-items-center overflow-hidden rounded-full border border-line bg-space-2", className)}>
      <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden focusable="false">
        <text x="12" y="13" textAnchor="middle" dominantBaseline="central" fontSize="15">{flag}</text>
      </svg>
    </span>
  );
}

/* ── Background-less topic/typology icons (ticket #97) ────────────────────────
   The SVGs in public/topic-art ship with no dark disc; their gold marks are painted with
   var(--ico-gold) so they adapt to the theme (vivid on the dark cosmos, a deeper amber on
   the light canvas — see index.css). A CSS variable can't cross an <img> boundary, so for
   THESE icons only we inject the SVG inline. Everything else the Avatar renders — member
   photos, the /emblem letter-avatar, flags — stays a plain <img> and is untouched. */
/* SAME-ORIGIN ONLY. A topic/group `image` is author-supplied — ImageInput lets an author PASTE any
   absolute URL — and resolveImage() passes an absolute https: URL through untouched. So a path test
   alone matched `https://<anything>/topic-art/x.svg` too, and that markup went to
   dangerouslySetInnerHTML below. CSP is not the backstop people assume: connect-src allow-lists
   cdn.jsdelivr.net, which serves any file from any published npm package, so an attacker could host
   their own /topic-art/x.svg on an allow-listed origin. A legitimate icon is ALWAYS same-origin —
   resolveImage() base-prefixes the bare `topic-art/<key>.svg` the picker yields — so requiring that
   costs nothing and makes the origin, not the path shape, the thing that is trusted. */
const isTopicIcon = (src?: string): src is string => {
  if (!src || !/(^|\/)topic-art\/[^/?#]+\.svg($|[?#])/i.test(src)) return false;
  try {
    return new URL(src, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
};

const topicSvgCache = new Map<string, string>(); // url → markup, or "" once a load has failed
const topicSvgInflight = new Map<string, Promise<string>>(); // dedupe concurrent loads of one url

function loadTopicSvg(url: string): Promise<string> {
  const cached = topicSvgCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);
  let p = topicSvgInflight.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.text() : ""))
      // Our own same-origin static asset (isTopicIcon enforces the origin), but this string still
      // reaches dangerouslySetInnerHTML, so it must be a bare <svg> and nothing else. <script> and
      // <foreignObject> were never the whole list: SVG runs script from EVENT ATTRIBUTES too, and an
      // innerHTML-inserted <svg onload=…> or <animate onbegin=…> fires immediately. Refuse any on*
      // attribute and any javascript: URL rather than trying to strip them — a static asset of ours
      // has none, so a hit here means the file is not what we think it is.
      .then((txt) =>
        /^\s*<svg[\s>]/i.test(txt) &&
        !/<script|<foreignObject/i.test(txt) &&
        !/\son[a-z]+\s*=/i.test(txt) &&
        !/javascript:/i.test(txt)
          ? txt
          : "")
      .catch(() => "")
      .then((markup) => { topicSvgCache.set(url, markup); topicSvgInflight.delete(url); return markup; });
    topicSvgInflight.set(url, p);
  }
  return p;
}

/** Inline markup for a topic icon: undefined while loading (or when `url` isn't a topic
 *  icon), "" if the fetch failed, else the SVG string. Cached, so remounts paint instantly. */
function useTopicIconMarkup(url: string | undefined): string | undefined {
  const [markup, setMarkup] = useState<string | undefined>(() => (url ? topicSvgCache.get(url) : undefined));
  useEffect(() => {
    if (!url) { setMarkup(undefined); return; }
    const cached = topicSvgCache.get(url);
    if (cached !== undefined) { setMarkup(cached); return; }
    let alive = true;
    setMarkup(undefined);
    loadTopicSvg(url).then((m) => { if (alive) setMarkup(m); });
    return () => { alive = false; };
  }, [url]);
  return markup;
}

/** Image or initial-badge. Size + ring via className (e.g. "h-9 w-9 text-sm"). Pass `country`
 *  (a verified nationality, ISO alpha-2 — see FlagBadge) to overlay the member's flag. Pass `alt`
 *  to give the image descriptive alt text — used where the picture is content the image search
 *  should index (e.g. a topic/group profile picture: alt = the topic or group name). Omit it
 *  (default "") where the image is decorative because an adjacent text label already names it. */
export function Avatar({ src, name, country, alt, className, palm, priority }: { src?: string; name?: string; country?: string; alt?: string; className?: string; palm?: string; priority?: boolean }) {
  const initial = (name?.trim()?.[0] || "?").toUpperCase();
  // Fall back to the initial if the image fails to load (broken/expired URL, or a cross-origin
  // avatar the browser ORB-blocks) — never show a broken-image icon.
  const [failed, setFailed] = useState(false);
  // Loading hints. `priority` marks the one avatar that is above the fold and is usually the
  // page's LCP element (the profile header): lazy is exactly wrong there, since the browser waits
  // for layout before it even starts the request. Everything else — list rows, comment authors,
  // the dock — stays lazy. decoding="async" keeps the decode off the main thread either way.
  const imgHints = priority
    ? ({ loading: "eager", fetchPriority: "high", decoding: "async" } as const)
    : ({ loading: "lazy", decoding: "async" } as const);
  // Topic/typology icons (ticket #97) render inline so the theme can recolour them; all other
  // sources stay a plain <img>. The hook no-ops for non-topic srcs.
  const topicMarkup = useTopicIconMarkup(src && !failed && isTopicIcon(src) ? src : undefined);
  let core: ReactNode;
  if (!src || failed) {
    core = <span aria-hidden className={cx("grid shrink-0 place-items-center rounded-full bg-yin/20 font-bold text-yin-light", className)}>{initial}</span>;
  } else if (isTopicIcon(src)) {
    if (topicMarkup) {
      core = <span role={alt ? "img" : undefined} aria-label={alt || undefined} aria-hidden={alt ? undefined : true} className={cx("aq-topic-icon shrink-0 rounded-full", className)} dangerouslySetInnerHTML={{ __html: topicMarkup }} />;
    } else if (topicMarkup === "") {
      // Inline load failed (offline/404) → plain <img>, which itself falls back to the initial.
      core = <img src={src} alt={alt || ""} {...imgHints} onError={() => setFailed(true)} className={cx("shrink-0 rounded-full object-contain", className)} />;
    } else {
      core = <span aria-hidden className={cx("aq-topic-icon shrink-0 rounded-full", className)} />; // loading: hold the sized box (no layout shift)
    }
  } else {
    core = <img src={src} alt={alt || ""} {...imgHints} onError={() => setFailed(true)} className={cx("shrink-0 rounded-full object-cover", className)} />;
  }
  // Palm "back photo" (ticket #94): when the member has set one, the picture becomes a tap-to-flip
  // card that reveals their palm. Only ever rendered when a palm URL is present, so EVERY other call
  // site keeps its exact legacy markup and can't regress.
  if (palm) return <FlipAvatar src={src} name={name} country={country} alt={alt} className={className} palm={palm} priority={priority} />;
  // No flag → exactly the legacy markup (no wrapper), so untouched call sites can't regress.
  if (!flagEmoji(country)) return core;
  return (
    <span className="relative inline-grid shrink-0">
      {core}
      <FlagBadge country={country} />
    </span>
  );
}

/** Avatar that flips on tap/click (and keyboard) to reveal the member's palm "back photo" — an
 *  opt-in, public self-verification image (ticket #94), distinct from the blue check. The picture
 *  itself is the button: the size/ring `className` lands on it; the two faces fill it and rotate in
 *  3D. The verified-nationality flag and a small flip hint sit on the front face only. */
function FlipAvatar({ src, name, country, alt, className, palm, priority }: { src?: string; name?: string; country?: string; alt?: string; className?: string; palm: string; priority?: boolean }) {
  const initial = (name?.trim()?.[0] || "?").toUpperCase();
  const who = name?.trim();
  const [flipped, setFlipped] = useState(false);
  const [faceFailed, setFaceFailed] = useState(false);
  const [palmFailed, setPalmFailed] = useState(false);
  const label = flipped ? "Show profile picture" : `Reveal ${who ? `${who}’s` : "the"} palm verification photo`;
  const face = src && !faceFailed
    ? <img src={src} alt={alt || ""} decoding="async"
        loading={priority ? "eager" : "lazy"} {...(priority ? { fetchPriority: "high" as const } : {})}
        onError={() => setFaceFailed(true)} className="h-full w-full rounded-full object-cover" />
    : <span aria-hidden className="grid h-full w-full place-items-center rounded-full bg-yin/20 font-bold text-yin-light">{initial}</span>;
  const hidden3d = { backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden" } as const;
  return (
    <span className="relative inline-grid shrink-0" style={{ perspective: "700px" }}>
      <button
        type="button" aria-label={label} aria-pressed={flipped} title={label}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setFlipped((v) => !v); }}
        className={cx("relative block rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yin-light", className)}
        style={{ transformStyle: "preserve-3d", transition: "transform 0.5s", transform: flipped ? "rotateY(180deg)" : undefined }}
      >
        {/* Front — the normal avatar + verified-nationality flag */}
        <span className="absolute inset-0" style={hidden3d}>
          {face}
          {flagEmoji(country) ? <FlagBadge country={country} /> : null}
        </span>
        {/* Back — the palm "back photo" (falls back to a hand glyph if it can't load) */}
        <span className="absolute inset-0 grid place-items-center overflow-hidden rounded-full bg-space-2" style={{ ...hidden3d, transform: "rotateY(180deg)" }}>
          {!palmFailed
            /* The palm sits on the HIDDEN back face — always lazy, whatever the front is doing:
               nobody has flipped it yet, and fetching it eagerly would compete with the real LCP. */
            ? <img src={palm} alt={who ? `${who}’s palm` : "Palm verification photo"} loading="lazy" decoding="async" onError={() => setPalmFailed(true)} className="h-full w-full rounded-full object-cover" />
            : <span aria-hidden className="text-xl text-ink-2">✋</span>}
        </span>
        {/* A small corner hint that the picture flips — front face only (top-right, clear of the flag) */}
        <span aria-hidden className="pointer-events-none absolute -top-[6%] -right-[6%] grid aspect-square w-[34%] min-w-3.5 max-w-5 place-items-center rounded-full border border-line bg-space-2/95 text-ink-2" style={hidden3d}>
          <svg viewBox="0 0 24 24" className="h-[58%] w-[58%]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" />
          </svg>
        </span>
      </button>
    </span>
  );
}

/* ───────────────────────── Chip (filter) ───────────────────────── */
/** Filter pill. With `onClick` it's a toggle button; with `href` it's a nav link (locale-aware,
 *  aria-current when active) — one pill for filter rows AND pill-style nav (e.g. forum switcher). */
export function Chip({ active, onClick, href, className, children }: { active?: boolean; onClick?: () => void; href?: string; className?: string; children: ReactNode }) {
  const cls = cx("inline-flex h-8 items-center whitespace-nowrap rounded-pill border px-3.5 text-[13px] font-medium transition-colors",
    active ? "border-yin bg-yin/15 text-yang" : "border-line text-ink-2 hover:border-yin-light/50 hover:text-ink", className);
  if (href) {
    return <a href={localePath(href)} aria-current={active ? "page" : undefined} className={cls}>{children}</a>;
  }
  return <button type="button" onClick={onClick} aria-pressed={active} className={cls}>{children}</button>;
}

/* ───────────────────────── Pill / Badge ───────────────────────── */
/** Small gold badge (a tier, price, or status label). Override padding/size/tone via className. */
export function Pill({ className, children }: { className?: string; children: ReactNode }) {
  // 12px, not 11. A chip is small by design, but 11px is under the floor the rest of the site keeps
  // and these carry real words — "Cancelled", "Happening now", a duration. The change only ever
  // makes text bigger, and a pill sets its own width from its padding, so nothing is squeezed.
  return <span className={cx("inline-flex items-center rounded-pill bg-yang/15 px-2 py-0.5 text-[12px] font-semibold text-yang", className)}>{children}</span>;
}

// "Certificate earned" badge — one source of truth so the account + dashboard course cards match.
// Built on Pill (same gold chip) with a ribbon-medal glyph + a hairline ring. Shown when a course's
// accuracy has reached the pass threshold (EnrolledCourse.cert). Given a `course` id it becomes a link
// to that course's certificate view (/certificate/?course=<id>) so the badge is the route to the cert.
export function CertBadge({ className, course }: { className?: string; course?: number }) {
  const inner = (
    <>
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="9" r="5" /><path d="m9 13-1.4 7L12 18l4.4 2L15 13" /></svg>
      Certificate earned
    </>
  );
  if (course) {
    return (
      <a href={localePath(`/certificate/?course=${course}`)} className={cx("inline-flex items-center gap-1 rounded-pill bg-yang/15 px-2 py-0.5 text-[11px] font-semibold text-yang ring-1 ring-yang/30 transition hover:bg-yang/25", className)}>
        {inner}
      </a>
    );
  }
  return <Pill className={cx("gap-1 ring-1 ring-yang/30", className)}>{inner}</Pill>;
}

// Inline error message with role="alert" baked in — one source of truth so a new error UI cannot
// forget the a11y attribute. Same rose card the checkout + wallet errors used inline.
export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
  // A leading alert glyph (non-colour cue, a11y audit) so the error reads as an error without relying
  // on colour alone — the icon carries the meaning, which is what a colour-blind member relies on.
  // BLUE, not rose: the platform has exactly two colours and failure states use the yin side. Rose was
  // a third accent, and the submission checklist already paints the same semantic (a blocking failure)
  // in blue — so the two most important error surfaces disagreed with each other.
  return (
    <p role="alert" className={cx("flex items-start gap-2 rounded-card border border-yin/40 bg-yin/10 px-4 py-2.5 text-[14px] text-yin-ink", className)}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-0.5 shrink-0"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
      <span>{children}</span>
    </p>
  );
}

/* ───────────────────────── Tabs (underline bar) ───────────────────────── */
export type Tab = { key: string; label: ReactNode; title?: string };
export function Tabs({ tabs, active, onChange, className, label = "Tabs", bordered = true }: { tabs: Tab[]; active: string; onChange: (k: string) => void; className?: string; label?: string; bordered?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // Roving-tabindex + arrow/Home/End keyboard nav (WAI-ARIA tabs pattern).
  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number) => {
    // Arrow keys follow VISUAL order: in an RTL tablist ArrowRight is the PREVIOUS tab. Read the
    // resolved direction off the live element — a tablist may sit in a subtree with its own dir.
    const rtl = !!ref.current && getComputedStyle(ref.current).direction === "rtl";
    let n: number;
    if (e.key === (rtl ? "ArrowLeft" : "ArrowRight")) n = (i + 1) % tabs.length;
    else if (e.key === (rtl ? "ArrowRight" : "ArrowLeft")) n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = tabs.length - 1;
    else return;
    e.preventDefault();
    onChange(tabs[n].key);
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[n]?.focus();
  };
  return (
    <div ref={ref} role="tablist" aria-label={label} className={cx("flex gap-1 overflow-x-auto", bordered && "border-b border-line", className)}>
      {tabs.map((t, i) => {
        const on = t.key === active;
        // No aria-controls: panels are rendered conditionally (often only the active one, or none for
        // filter-style tabs like rankings), so a per-tab aria-controls would dangle (aria-valid-attr-value).
        // The panel keeps aria-labelledby; role=tab + aria-selected carry the tablist semantics.
        return (
          <button key={t.key} type="button" role="tab" id={`aqtab-${t.key}`} aria-selected={on} title={t.title}
            tabIndex={on ? 0 : -1} onClick={() => onChange(t.key)} onKeyDown={(e) => onKey(e, i)}
            className={cx("-mb-px shrink-0 border-b-2 px-3.5 py-2.5 text-[14px] font-semibold transition-colors",
              on ? "border-yang text-yang" : "border-transparent text-ink-3 hover:text-ink")}>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/* ───────────────────────── LinkButton (quiet text action) ───────────────────────── */
/** The quiet inline text action ("Remove", "Withdraw", "clear", "Cancel") — a button that reads
 *  as a link. One source of truth for the idiom that was re-styled per page. */
export function LinkButton({ onClick, disabled, className, children, ...rest }: { onClick?: () => void; disabled?: boolean; className?: string; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      // ink-2. A LinkButton is a control that reads as text — "Show a different zone", "Add a line
      // about it" — and ink-3's 3:1 tier is for rules and glyphs, not for the words on something
      // a reader has to find and press.
      className={cx("text-[13px] text-ink-2 underline-offset-2 transition-colors hover:text-ink hover:underline disabled:opacity-50", className)} {...rest}>
      {children}
    </button>
  );
}

/* ───────────────────────── IconButton ───────────────────────── */
export function IconButton({ label, onClick, className, children, ...rest }: { label: string; onClick?: () => void; className?: string; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    /* A disabled button still matches `:hover`, so an unguarded hover fill lights one up under the
       cursor while it does nothing — read, correctly, as "this button is broken". It was also drawn
       at full strength, so there was no way to tell a dead control from a live one before pressing
       it. Dimmed, and the hover withdrawn, it simply says there is nothing that way. */
    <button type="button" aria-label={label} onClick={onClick}
      className={cx("grid place-items-center rounded-card text-ink-2 transition-colors hover:bg-veil/5 hover:text-ink",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-2", className)} {...rest}>
      {children}
    </button>
  );
}

/* ───────────────────────── Popover viewport clamp ───────────────────────── */
/** Keep an anchored `absolute` popover fully inside the viewport. The topbar popovers (Display
 *  settings, the language picker) end-align a fixed-width panel to their trigger; on a thin phone
 *  the trigger can sit closer to the start edge than the panel is wide, so the panel's far edge
 *  clips off-screen (the Display panel lost 44px on a 360px viewport). After the panel opens —
 *  and on resize while open — measure it and nudge it horizontally (a transform, so the anchor
 *  itself is untouched and re-measuring stays honest) until both edges sit ≥8px inside. */
export function useViewportNudge(ref: { current: HTMLElement | null }, open: boolean): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const nudge = () => {
      el.style.transform = ""; // measure at the natural anchor position
      const M = 8;
      const r = el.getBoundingClientRect();
      const dx = r.left < M ? M - r.left : r.right > window.innerWidth - M ? window.innerWidth - M - r.right : 0;
      if (dx) el.style.transform = `translateX(${dx}px)`;
    };
    nudge();
    window.addEventListener("resize", nudge);
    return () => window.removeEventListener("resize", nudge);
  }, [ref, open]);
}

/* ───────────────────────── Icons (shared) ───────────────────────── */
export function SearchIcon({ size = 18 }: { size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" strokeLinecap="round" /></svg>;
}

/* ───────────────────────── SearchPill ───────────────────────── */
// Decorative by default (static look). Pass `onChange` to make it a real, accessible search
// input that filters its list; existing decorative call-sites (no handler) are unaffected.
export function SearchPill({ placeholder, className, value, onChange, autoFocus, size = "md" }: { placeholder: string; className?: string; value?: string; onChange?: (v: string) => void; autoFocus?: boolean; size?: "md" | "lg" }) {
  // `lg` makes the bar a more prominent, easier-to-tap target (the course catalogue uses it); `md`
  // is the default every other surface keeps. Height, padding, gap, text and icon scale together so
  // the larger pill stays balanced rather than just taller.
  const lg = size === "lg";
  // aq-focus-wrap: the pill is the visible shape, the <input> inside is bare and transparent, so
  // focus has to be drawn on the WRAPPER (:focus-within). Drawn on the input it produced a hard
  // rectangle cutting through the pill — see index.css.
  const box = cx("aq-focus-wrap flex items-center rounded-pill border border-line bg-space-2 text-ink-3 transition-colors", lg ? "h-12 gap-2.5 px-5" : "h-10 gap-2 px-4");
  const txt = lg ? "text-[15px]" : "text-[14px]";
  const icon = lg ? 20 : 18;
  if (!onChange) {
    return (
      <div className={cx(box, className)}>
        <SearchIcon size={icon} />
        <span className={txt}>{placeholder}</span>
      </div>
    );
  }
  return (
    <label className={cx(box, "focus-within:border-ink-3", className)}>
      <SearchIcon size={icon} />
      <input value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} type="search" autoFocus={autoFocus}
        className={cx("min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-2", txt)} />
    </label>
  );
}

/* ───────────────────────── SearchSort (a search bar that carries its own sort) ─────────────────────────
   The ONE reusable search unit (ticket #152): a SearchPill paired with its own "Sort by" dropdown, so
   every catalogue's search + sort reads and behaves identically instead of each page bolting a sort
   control on in its own way (a detached "Sort by" row on Courses, a segmented control on Discussions).
   The search grows to fill the row; the sort sits at its trailing end (they stack on phones). The sort
   is OPTIONAL — pass sort/onSort/sortOptions to show it, omit them for a plain search bar. Drop it
   straight into a Toolbar `search` slot (it grows and lets a `trailing` action share the row) or use
   it standalone. */
export function SearchSort({
  placeholder, value, onChange, autoFocus, size = "md", className,
  sort, onSort, sortOptions, sortLabel = "Sort by", sortAriaLabel,
}: {
  placeholder: string; value?: string; onChange?: (v: string) => void; autoFocus?: boolean;
  size?: "md" | "lg"; className?: string;
  sort?: string; onSort?: (v: string) => void;
  sortOptions?: ReadonlyArray<{ value: string; label: ReactNode }>;
  sortLabel?: ReactNode; sortAriaLabel?: string;
}) {
  const hasSort = sort != null && !!onSort && !!sortOptions?.length;
  return (
    <div className={cx("flex min-w-0 flex-1 flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3", className)}>
      <SearchPill placeholder={placeholder} value={value} onChange={onChange} autoFocus={autoFocus} size={size} className="min-w-0 flex-1" />
      {hasSort && (
        // Wrapping <label> ties the visible "Sort by" text to the select (tap-to-focus); the select's
        // own aria-label is the fuller, page-specific description ("Sort courses by").
        <label className="flex shrink-0 items-center gap-2 text-[13px] text-ink-3">
          <span className="font-semibold">{sortLabel}</span>
          <Select label={sortAriaLabel ?? (typeof sortLabel === "string" ? sortLabel : "Sort")} value={sort}
            onChange={onSort!} options={sortOptions!} className="h-9 px-2.5 text-[13px]" />
        </label>
      )}
    </div>
  );
}

/* ───────────────────────── VotePill (heart + count) ───────────────────────── */
/** Static when no `target`; interactive (optimistic count) when a target id is given. Re-tapping
 *  the heart clears it (toggle off). `myVote` seeds the visitor's existing heart so it shows lit
 *  on load. */
/* ── VoteControl — ONE heart control for BOTH discussion boards (public threads + the per-section
   competition boards). HEARTS-ONLY since 2026-07-10 (Creative Challenges): the platform takes no
   downvotes — one gold heart, tap to love, tap again to clear. Controlled: the parent supplies
   onVote(dir) (only dir=1 is ever emitted now; the prop shape is kept so every board keeps
   working unchanged). `layout` keeps the compact pill / prominent pillar variants; `mine` shows
   the count beside a dimmed heart (you can't heart your own post). */
const OWN_POST_NOTE = "You can’t heart your own post — hearts come from peers";

/** Which vote row a control's transparency roster reads — mirrors postDiscVote's (kind, id). */
export type VotersTarget = { kind: "thread" | "comment"; id: number };

/** The one heart glyph every vote surface renders (filled when cast). */
export const HeartGlyph = ({ size = 11, filled = true }: { size?: number; filled?: boolean }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={filled ? 0 : 1.8} aria-hidden>
    <path d="M12 21s-7.5-4.9-10-9.5C.6 8.6 2.3 5 5.7 5c2 0 3.4 1.1 4.3 2.6l2 3.2 2-3.2C15 6.1 16.3 5 18.3 5c3.4 0 5.1 3.6 3.7 6.5C19.5 16.1 12 21 12 21z" strokeLinejoin="round" />
  </svg>
);

/* One side of the roster, earliest first. Hearts-only now — legacy downvoters (pre-2026-07-10
   rows) still render under a muted label so the transparency record stays complete. */
function VoterColumn({ dir, voters }: { dir: 1 | -1; voters: Voter[] }) {
  if (voters.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className={cx("flex items-center gap-1 font-semibold", dir === 1 ? "text-yang" : "text-ink-3")}>
        <HeartGlyph /> {dir === 1 ? "Loved" : "Downvoted (legacy)"} · {voters.length}
      </p>
      <ul className="flex list-none flex-col gap-1">
        {voters.map((v, i) => (
          <li key={`${v.slug || "x"}-${i}`} className="flex items-center gap-1.5">
            <Avatar src={v.avatar} name={v.name} country={v.country} className="h-5 w-5 text-[9px]" />
            <span data-ay-skip="1" className="truncate text-ink-2">{v.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* Transparency roster revealed on hover/focus of a vote control (ticket #90): every member who up-
   or down-voted this target, EARLIEST FIRST. Lazy — fetched the first time it opens, and refetched
   only when the score moves (someone voted) so it stays current without polling. Hover has no touch
   equivalent, so this never gates the arrows themselves — voting works the same with or without it. */
function VotersHover({ target, score, layout, align = "end", children }: { target: VotersTarget; score: number; layout: "pillar" | "pill"; align?: "start" | "end"; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [roster, setRoster] = useState<VoterRoster | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchedFor = useRef<number | null>(null); // score at last successful fetch — refetch when it moves
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const load = () => {
    if (loading || fetchedFor.current === score) return; // in flight, or already fresh for this score
    setLoading(true);
    getVoters(target.kind, target.id).then(
      (r) => { setRoster(r); fetchedFor.current = score; },
      () => {}, // a failed peek is silent — the arrows are what matter
    ).finally(() => setLoading(false));
  };
  const show = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => { setOpen(true); load(); }, 140); };
  const hide = () => { window.clearTimeout(timer.current); setOpen(false); };

  const total = roster ? roster.up.length + roster.down.length : 0;
  return (
    <span className="relative inline-flex shrink-0" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {open && (
        <span role="tooltip" className={cx(
          "absolute z-30 max-h-72 w-max min-w-[8rem] max-w-[min(280px,80vw)] overflow-y-auto overscroll-contain rounded-card border border-line bg-space-2/97 p-2.5 text-[12px] leading-snug text-ink shadow-xl shadow-black/50 backdrop-blur",
          // Logical start/end so the bubble mirrors with dir=rtl (Farsi/Arabic) instead of running off-screen.
          // Pill: hang from the same edge as the own-post note (start where the control sits at the row's
          // left, e.g. the follow feed; end for the right-aligned thread pills) so it grows inward.
          layout === "pillar" ? "start-full top-0 ms-2" : align === "start" ? "bottom-full start-0 mb-2" : "bottom-full end-0 mb-2")}>
          {!roster && loading ? (
            <span className="text-ink-3">Loading…</span>
          ) : total === 0 ? (
            <span className="text-ink-3">No votes yet</span>
          ) : (
            <span className="flex flex-col gap-2.5">
              <VoterColumn dir={1} voters={roster!.up} />
              <VoterColumn dir={-1} voters={roster!.down} />
              {roster!.more && <span className="text-ink-3">+ more voters…</span>}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

export function VoteControl({ votes, myVote = 0, mine = false, busy = false, onVote, layout = "pillar", noteAlign, votersTarget }: {
  votes: number; myVote?: number; mine?: boolean; busy?: boolean; onVote: (dir: 1 | -1) => void; layout?: "pillar" | "pill";
  /** Which edge of the control the own-post note hangs from (pill layout only) — "end" suits the
   *  right-aligned thread pills (default); pass "start" where the pill sits at the LEFT of a wide
   *  row (e.g. the follow feed) so the note grows into the row instead of off-screen. */
  noteAlign?: "start" | "end";
  /** When set, hovering/focusing the control reveals the transparency roster of who up/down-voted it. */
  votersTarget?: VotersTarget;
}) {
  const pillar = layout === "pillar";
  // Optionally reveal the who-voted roster on hover/focus (ticket #90) — wraps whatever the control
  // renders (own-post or live arrows) so the affordance is identical on every vote widget.
  const withRoster = (control: ReactNode) =>
    votersTarget ? <VotersHover target={votersTarget} score={votes} layout={layout} align={noteAlign}>{control}</VotersHover> : <>{control}</>;
  const wrap = pillar ? "w-9 flex-col gap-0.5" : "gap-1 rounded-pill border border-line bg-space-1/60 px-2 py-1";
  // Tap feedback for the intentionally-inert own-post arrows. The hover `title` can NEVER appear on
  // a touch screen, so tapping them gave no reaction at all — indistinguishable from broken arrows
  // ("up/down vote arrows do nothing when tapped", ticket #56, a phone on a page where every post
  // was the member's own). A tap now flashes the no-self-vote rule (server copy, Social::vote)
  // right beside the control.
  const [ownNote, setOwnNote] = useState(false);
  const noteTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(noteTimer.current), []);
  const flashOwnNote = () => {
    window.clearTimeout(noteTimer.current);
    setOwnNote(true);
    noteTimer.current = window.setTimeout(() => setOwnNote(false), 2400);
  };
  const Heart = ({ filled = true }: { filled?: boolean }) => (
    <HeartGlyph size={pillar ? 20 : 16} filled={filled} />
  );
  const scoreColor = myVote === 1 ? "text-yang" : votes < 0 ? "text-rose-400" : "text-ink-2";
  if (mine) {
    // Same h-7 w-7 slot as the live heart so an own-post control is the SAME size and shape as
    // every votable one — it used to render the bare glyphs, making a member's own replies show a
    // squat, cramped pill next to full-size ones ("reply vote buttons look broken", ticket #32).
    return withRoster(
      <button type="button" onClick={flashOwnNote} title={OWN_POST_NOTE}
        aria-label={`Hearts ${votes} — ${OWN_POST_NOTE}`}
        className={cx("relative flex shrink-0 cursor-default touch-manipulation items-center text-ink-3", wrap)}>
        <span aria-hidden className="grid h-7 w-7 place-items-center opacity-40"><Heart /></span>
        <span className="text-[13px] font-bold tabular-nums">{votes}</span>
        {/* Logical (start/end) anchoring: the app flips dir=rtl for Farsi/Arabic… (i18n.ts), the
            rows mirror with it, and a physically-anchored bubble would grow off-screen there. */}
        {ownNote && (
          <span role="status" className={cx(
            "pointer-events-none absolute z-20 w-max max-w-[min(260px,75vw)] rounded-pill border border-yang/30 bg-space-2/95 px-3 py-1.5 text-[12px] font-semibold leading-snug text-ink shadow-lg shadow-black/40 backdrop-blur",
            pillar ? "start-full top-1/2 ms-2 -translate-y-1/2" : noteAlign === "start" ? "bottom-full start-0 mb-1.5" : "bottom-full end-0 mb-1.5")}>
            {OWN_POST_NOTE}
          </span>
        )}
      </button>
    );
  }
  const on = myVote === 1;
  return withRoster(
    <div className={cx("flex shrink-0 items-center", wrap)} aria-label="Hearts">
      {/* touch-manipulation + an invisible ::after halo (36×44 effective target around the 28px
          heart) so phone taps land reliably — bare 28px squares were easy to miss (ticket #32). */}
      <button type="button" onClick={() => onVote(1)} disabled={busy} aria-pressed={on}
        aria-label={on ? "Remove heart" : "Heart this"}
        className={cx("relative grid h-7 w-7 touch-manipulation place-items-center rounded transition-colors after:absolute after:-inset-x-1 after:-inset-y-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yang/60 disabled:opacity-50",
          on ? "bg-yang/20 text-yang" : "text-ink-3 hover:bg-veil/5 hover:text-ink")}>
        <Heart filled={on} />
      </button>
      <span className={cx("text-[13px] font-bold tabular-nums", scoreColor)} aria-live="polite">{votes}</span>
    </div>
  );
}

/* VotePill — self-managing horizontal wrapper for the PUBLIC board (thread heads, list rows):
   OPTIMISTIC via the shared vote caster (lib/votes.ts) — the count moves the instant you tap,
   reconciles to the server's authoritative score, and rolls back on failure. `mine` renders the
   can't-vote-your-own state. The boards pass their own onVote to VoteControl directly. */
export function VotePill({ votes, target, kind = "thread", myVote: myVote0 = 0, mine = false }: { votes: number; sm?: boolean; target?: string; kind?: "thread" | "comment"; myVote?: number; mine?: boolean }) {
  const [state, setState] = useState({ votes, myVote: myVote0 });
  const ref = useRef(state);
  ref.current = state;
  const cast = useMemo(() => createVoteCaster<string>({
    send: (id, val) => postDiscVote(id, val, kind),
    read: () => ref.current,
    write: (_id, s) => setState(s),
  }), [kind]);
  // The transparency roster reads by the SAME (kind, id) the vote posts to — shown even on your own
  // pill (you can't vote it, but peers can, and seeing who is the point).
  const tid = target ? parseInt(target.replace(/\D/g, ""), 10) || 0 : 0;
  const vt: VotersTarget | undefined = tid ? { kind, id: tid } : undefined;
  if (!target || mine) return <VoteControl votes={state.votes} myVote={state.myVote} mine onVote={() => {}} layout="pill" votersTarget={vt} />;
  const onVote = (dir: 1 | -1) => {
    if (!isLoggedIn()) {
      window.location.assign((window as unknown as Record<string, string>).AQ_LOGIN_URL || `/login/?redirect_to=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    cast(target, dir);
  };
  return <VoteControl votes={state.votes} myVote={state.myVote} onVote={onVote} layout="pill" votersTarget={vt} />;
}

/* ───────────────────────── Form fields ───────────────────────── */
/** The one labelled-field wrapper (label + optional marker above the control) — so every form's
 *  label typography matches (was re-styled per page in Issues / Account / Wallet). */
export function Field({ label, optional, required, hint, className, children }: { label: ReactNode; optional?: boolean; required?: boolean; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <label className={cx("flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2", className)}>
      <span>
        {label}
        {optional && <span className="font-normal text-ink-3"> (optional)</span>}
        {/* A field the server will refuse to proceed without says so HERE, where it is being filled
            in — not only in a paragraph above the form, and not only in the error afterwards. */}
        {required && <span className="font-normal text-yang-ink"> · required</span>}
      </span>
      {children}
      {hint && <span className="font-normal leading-snug text-ink-3">{hint}</span>}
    </label>
  );
}

/* `placeholder:text-ink-2` is NOT decoration. Without it the placeholder falls back to the
   browser's own colour, which is neither theme-aware nor contrast-aware — on the dark canvas
   Chrome renders it far dimmer than any token we ship, which is what made "Search or type a
   @username" nearly unreadable in ArtaChat. ink-3 is the token that exists for exactly this
   (5.5:1 on space-2 at the default level, and it rises with the contrast slider like everything
   else). SearchPill had it right; the two primitives everything else is built from did not. */
export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("h-11 rounded-field border border-line bg-space-2 px-4 text-[15px] text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-yin-light", className)} {...rest} />;
}

/** Native <select> matching the Input look (border-line / space-2 / focus:yin-light). Accepts plain
 *  string options or {value,label} pairs; pass `label` to give it an accessible name when it isn't
 *  already wrapped in a <Field>. One source of truth shared by the catalogue sort + the Studio editors. */
export function Select({ value, onChange, options, label, className, skipOptions }: {
  value: string; onChange: (v: string) => void;
  options: ReadonlyArray<string | { value: string; label: ReactNode }>;
  label?: string; className?: string;
  /**
   * The options are IDENTIFIERS, not prose — IANA zone ids, codes, handles — so keep the i18n mesh
   * off them. Without this a zone picker hands ~400 strings like "Europe/Istanbul" to the
   * translator, which publishes every one into the public aq_translations table and then rewrites
   * the labels in place, leaving the reader hunting for a name that no longer appears in a list
   * still sorted by the English id.
   *
   * The marker goes on each OPTION rather than on the select or a wrapper on purpose: a skipped
   * ancestor also excludes its own aria-label, which would cost this control its translated
   * accessible name to protect its options.
   */
  skipOptions?: boolean;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
      className={cx("h-11 rounded-field border border-line bg-space-2 px-4 text-[15px] text-ink outline-none transition-colors focus:border-yin-light", className)}>
      {options.map((o) => {
        const v = typeof o === "string" ? o : o.value;
        const l = typeof o === "string" ? o : o.label;
        return <option key={v} value={v} {...(skipOptions ? { "data-ay-skip": "1" } : {})}>{l}</option>;
      })}
    </select>
  );
}

/** A checkbox with a wrapping label (so the box is programmatically tied to its text). Bakes in the
 *  focus-visible ring the hand-rolled checkboxes lacked — one source of truth for the Studio toggles. */
export function CheckField({ checked, onChange, className, children }: {
  checked: boolean; onChange: (v: boolean) => void; className?: string; children: ReactNode;
}) {
  return (
    <label className={cx("flex items-center gap-2 text-[13px] font-semibold text-ink-2", className)}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-line bg-space-2 accent-yang focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yang/50" />
      {children}
    </label>
  );
}

// Shared payment-method radio group (Checkout + Wallet). Descriptions are page-specific copy
// (e.g. "confirm receipt" vs "credit your coins"), so they're passed in; the markup + a11y
// (role=group, aria-pressed, labelId) live here once.
export function GatewayPicker({ gateways, value, onChange, descriptions, labelId, label = "Payment method" }: {
  gateways: { id: string; title: string; desc?: string }[];
  value: string;
  onChange: (id: string) => void;
  descriptions?: Record<string, string>;
  labelId: string;
  label?: string;
}) {
  return (
    <div>
      <span id={labelId} className="text-[13px] font-semibold text-ink-2">{label}</span>
      <div className="mt-2 flex flex-col gap-2" role="group" aria-labelledby={labelId}>
        {gateways.map((g) => {
          const desc = descriptions?.[g.id] || g.desc;
          return (
            <button key={g.id} type="button" onClick={() => onChange(g.id)} aria-pressed={value === g.id}
              className={cx("rounded-card border px-4 py-3 text-start transition-colors", value === g.id ? "border-yang bg-yang/10" : "border-line hover:border-ink-3")}>
              <span className="block text-[15px] font-semibold">{g.title}</span>
              {desc && <span className="mt-0.5 block text-[13px] text-ink-3">{desc}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cx("rounded-card border border-line bg-space-2 px-4 py-2.5 text-[15px] leading-relaxed text-ink outline-none placeholder:text-ink-2 focus:border-yin-light", className)} {...rest} />;
  },
);

/* ───────────────────────── RichText (sanitised markdown + LaTeX) ───────────────────────── */
/** Render a discussion body and upgrade any `.aq-math` LaTeX nodes to typeset math with KaTeX.
 *  XSS-safety: bodies are sanitised server-side with `wp_kses_post` on store (Social::post_thread/
 *  comment), so the HTML here is already filtered. NOTE (2026-06-04 cutover): the lean backend no
 *  longer renders markdown→HTML (the old `aq_md_to_html` was removed) — bodies are stored/served as
 *  raw text, so markdown (**bold**) and inline `$math$` currently display literally. Restoring rich
 *  rendering (server md, or a client renderer that emits `.aq-math` nodes) is a tracked open_flag.
 *
 *  Translation: when `srcLang` is given (global user content — discussion thread/comment bodies),
 *  the block is marked `data-ay-tr` + `data-ay-src` so the i18n engine translates it into the
 *  reader's language — UNLESS it is already in that language (engine skips data-ay-src === current).
 *  Without `srcLang` (e.g. the author's own live composer preview) it stays `data-ay-skip` — never
 *  translated. Typeset math (.katex) is always left untouched by the engine. */
export function RichText({ html, className, srcLang }: { html: string; className?: string; srcLang?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // Typeset the `.aq-math` nodes AND keep them typeset: re-render if the i18n engine (this block is a
  // translated `[data-ay-tr]` root) or any re-render reverts a node to its raw "$…$" source. (#143)
  useEffect(() => watchMath(ref.current, "nodes"), [html]);
  const mark = srcLang !== undefined
    ? { "data-ay-tr": "1", "data-ay-src": srcLang || "en" }
    : { "data-ay-skip": "1" };
  // dir="auto" because this renders MEMBER-authored text — comments, thread bodies, descriptions —
  // whose language is independent of the page's. Pairs with `unicode-bidi: plaintext` on .aq-prose so
  // multi-paragraph bodies resolve per paragraph, not from the opening word of the whole block.
  return <div ref={ref} dir="auto" {...mark} className={cx("aq-prose", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

/* ───────────────────────── LogoMark (brand A-in-ring) ───────────────────────── */
/** The ArtaQuest brand mark: a solid gold "A" (the Why) cutting through a blue ring
 *  (the How). The ring is notched wherever the A crosses it (a dark moat); the A's
 *  crossbar matches the ring's line weight. Square; size via className (default h-8 w-8). */
export function LogoMark({ className }: { className?: string; iconSize?: number }) {
  const id = useId();
  const aOuter = "M43.33 21.21L56.52 21.21L90.61 96.67L78.18 96.67L66.52 70.3L33.48 70.3L22.73 96.67L9.09 96.67Z";
  return (
    <svg className={cx("h-8 w-8 shrink-0", className)} viewBox="0 0 100 100" fill="none" role="img" aria-label="ArtaQuest" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <mask id={id}>
          <rect width="100" height="100" fill="#fff" />
          <path d={aOuter} fill="#000" stroke="#000" strokeWidth="7" strokeLinejoin="round" />
        </mask>
      </defs>
      {/* HARD BRAND INVARIANT: gold A + blue ring sum to WHITE per channel — yin + yang complete to light.
          Use the CANONICAL tokens (--color-yang #E8B923 + --color-yin #1746DC = (255,255,255)) directly via
          inline style, NOT the #E8B923/#2352E8 sentinels: the global contrast remaps would swap in the
          deepened ico-gold / lightened yin-ink, which do NOT sum to white and break the brand mark. */}
      <circle cx="50" cy="50" r="41.6" fill="none" style={{ stroke: "var(--color-yin)" }} strokeWidth="11.66" mask={`url(#${id})`} />
      <path style={{ fill: "var(--color-yang)" }} fillRule="evenodd" d={`${aOuter}M50 34.55L38.57 59.3L61.43 59.3Z`} />
    </svg>
  );
}

/** The ArtaQuest brand lockup — the wordmark: "Arta" in gold (the Why) + "Quest" in blue (the How),
 *  set in Montserrat with tight tracking. The single brand lockup the shell reuses. (The A-in-ring
 *  icon — see <LogoMark/> — now serves as the Arta Coin mark.) */
/** Brand wordmark transliterated for RTL scripts (gold "Arta" part · blue "Quest" part).
 *  On RTL pages we render the native-script lockup so the brand is not an island of Latin
 *  in an Arabic/Persian/Urdu/Hebrew page; LTR pages keep the Latin "ArtaQuest". */
const RTL_WORDMARK: Record<string, [string, string]> = {
  ar: ["أرتا", "كويست"],
  fa: ["آرتا", "کوئست"],
  ur: ["آرتا", "کوئسٹ"],
  he: ["ארטה", "קווסט"],
};

export function Logo({ className, size = "text-2xl" }: { className?: string; size?: string }) {
  const lang = (typeof document !== "undefined" ? document.documentElement.lang : "").toLowerCase().split("-")[0];
  const rtl = RTL_WORDMARK[lang];
  const [a, q] = rtl ?? ["Arta", "Quest"];
  return (
    <span
      className={cx(
        // `size` is an explicit prop (not a className override) so callers can set a responsive
        // font-size without fighting the base class in the cascade — the phone topbars need a
        // smaller lockup to fit beside their controls (ticket #47).
        "inline-flex items-baseline whitespace-nowrap font-display font-extrabold leading-none tracking-tight",
        size,
        className,
      )}
      aria-label="ArtaQuest"
      data-ay-skip="1"
      dir={rtl ? "rtl" : "ltr"}
    >
      {/* The wordmark IS the brand lockup (gold + blue TOGETHER = the identity), so the pair must sum to white
          (hard constraint) and match the A-in-ring <LogoMark/>. Use the CANONICAL tokens via INLINE STYLE,
          exactly as the icon does — NOT the text-yang/text-yin-ink utilities, which resolve to the theme-adaptive
          legible inks (text-yang → #8a6300 on light) and so break the sum. --color-yang + --color-yin are
          255−each per channel → white on both themes, identical to the icon. On each theme one half recedes
          (blue on dark, gold on light): that IS the complementary pair summing to white, and it matches the icon. */}
      <span style={{ color: "var(--color-yang)" }}>{a}</span>
      <span style={{ color: "var(--color-yin)" }}>{q}</span>
    </span>
  );
}

/* ───────────────────────── OrbitRings (signature motif) ───────────────────────── */
/** Concentric orbit rings with a gold + blue body orbiting — ArtaQuest's ambient brand
 *  motif (a quest for the truth). Decorative only; tint the rings via the parent's
 *  text colour (currentColor). Size/position via className. */
export function OrbitRings({ className }: { className?: string }) {
  return (
    <svg className={cx("pointer-events-none select-none", className)} viewBox="0 0 400 400" fill="none" aria-hidden>
      <g stroke="currentColor" strokeWidth="1.5">
        <circle cx="200" cy="200" r="58" strokeOpacity="0.14" />
        <circle cx="200" cy="200" r="108" strokeOpacity="0.10" />
        <circle cx="200" cy="200" r="162" strokeOpacity="0.07" />
        <circle cx="200" cy="200" r="196" strokeOpacity="0.045" />
      </g>
      {/* arcs imply motion; bodies mark the two forces on their orbits */}
      <path d="M200 92 A108 108 0 0 1 308 200" stroke="#E8B923" strokeOpacity="0.55" strokeWidth="2" strokeLinecap="round" />
      <path d="M38 200 A162 162 0 0 0 200 362" stroke="#4A72FF" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
      <circle cx="200" cy="92" r="6" fill="#E8B923" />
      <circle cx="362" cy="200" r="5" fill="#4A72FF" />
    </svg>
  );
}

/* ───────────────────────── SectionHeader ───────────────────────── */
export function SectionHeader({ icon, title, action, className }: { icon?: ReactNode; title: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-center justify-between", className)}>
      <h2 className="flex items-center gap-2 text-[18px] font-bold tracking-tight">{icon}{title}</h2>
      {action}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Catalogue kit — the shared page scaffold every browse/search surface is built
   from (Explore + Courses + Topics + Grants + Donate + Discussions), so they read
   as one bespoke system. Pure presentation; data-shaped cards live in catalogue.tsx.
   ════════════════════════════════════════════════════════════════════════════ */

/* ───────────────────────── PageHero ─────────────────────────
   The one page header pattern: an uppercase eyebrow (with an optional domain glyph),
   the display headline (exactly one <h1> — ClientNav focuses it on route change), a
   supporting lede, and an optional decorative aside (OrbitRings / a hero metric). */
export function PageHero({ eyebrow, glyph, title, lede, aside, className }: {
  eyebrow?: ReactNode; glyph?: ReactNode; title: ReactNode; lede?: ReactNode; aside?: ReactNode; className?: string;
}) {
  return (
    <header className={cx("relative flex items-start justify-between gap-6", className)}>
      <div className="min-w-0 flex-1">
        {eyebrow && (
          <p className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.2em] text-ink-2">
            {glyph}{eyebrow}
          </p>
        )}
        <h1 className="text-[clamp(1.85rem,3.4vw,2.5rem)] font-extrabold leading-[1.08] tracking-tight">{title}</h1>
        {lede && <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-ink-2">{lede}</p>}
      </div>
      {aside && <div className="hidden shrink-0 self-center lg:block">{aside}</div>}
    </header>
  );
}

/* ───────────────────────── Toolbar (search + filters + sort) ─────────────────────────
   Slot-based filter bar shared by every catalogue surface. `sticky` parks it under the
   60px topbar as a translucent blur bar. Owns the polite result-count live region so
   every page announces narrowing identically (WCAG 4.1.3). Logical `ms-auto` → RTL-safe. */
export function Toolbar({ search, filters, trailing, count, sticky = false, className }: {
  search?: ReactNode; filters?: ReactNode; trailing?: ReactNode; count?: ReactNode; sticky?: boolean; className?: string;
}) {
  return (
    <div className={cx(
      "flex flex-col gap-2.5",
      sticky && "sticky top-topbar z-20 -mx-gutter border-b border-line bg-space-1/85 px-gutter py-3 backdrop-blur supports-[backdrop-filter]:bg-space-1/70",
      className,
    )}>
      {/* Stack on phones (search on its own full-width row, then filters / trailing) so a wide
          control can never push the page sideways on a narrow viewport; single row on sm+. */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        {search}
        {filters && <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5 sm:w-auto">{filters}</div>}
        {trailing && <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:ms-auto sm:w-auto sm:justify-end">{trailing}</div>}
      </div>
      {/* ink-2: this line names the zone every time on it is read in, which is the last thing that
          should be the faintest text on the page. */}
      {count != null && count !== false && <p role="status" aria-live="polite" className="text-[13px] text-ink-2">{count}</p>}
    </div>
  );
}

/* ───────────────────────── Segmented (sort / view switch) ─────────────────────────
   A 2–4 option segmented control (role=radiogroup). Active segment = gold fill (the
   chosen option), inactive = quiet. Replaces ad-hoc <select>s; keyboard via radio roles. */
export function Segmented({ options, value, onChange, label = "Sort", className }: {
  options: { value: string; label: ReactNode }[]; value: string; onChange: (v: string) => void; label?: string; className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cx("inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-pill border border-line bg-space-2 p-0.5", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
            className={cx("h-8 shrink-0 whitespace-nowrap rounded-pill px-3.5 text-[13px] font-semibold transition-colors",
              on ? "bg-yang text-on-accent" : "text-ink-2 hover:bg-veil/5 hover:text-ink")}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ───────────────────────── DrillDownFilter (faceted two-level chip filter) ─────────────────────────
   The ONE faceted filter the browse surfaces share — Topics, Courses, and the course-discussion
   picker — so filtering reads and behaves identically everywhere. The top strip is the main facets
   ("houses"), each with an optional count; selecting one whose taxonomy has a second level reveals
   its sub-facets ("subtopics") in a strip beneath — a drill-down, instead of showing every sub-facet
   at once (a flat pyramid of chips). A one-level taxonomy (options with no `children`) just renders
   the single top strip. Controlled — the page owns the {group, sub} selection via onSelect. Pass
   `href` instead to render the top strip as nav links (the forum switcher): link mode is a <nav>
   landmark and never drills down. Each strip is an edge-to-edge snap-scroll on phones so a long row
   can't push the page sideways; it wraps to rows at sm+. */
export type FilterOption = { key: string; label: string; count?: number; children?: FilterOption[] };

// aq-scroll-fade-r (index.css) softens the trailing edge on phones so a peeking next chip reads as
// "scroll for more" instead of a chip chopped at the viewport edge (ticket #129); it lifts at sm+ where
// the strip stops scrolling and wraps to rows.
const FACET_STRIP = "aq-scroll-fade-r -mx-gutter flex snap-x gap-2 overflow-x-auto px-gutter pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0";

function FacetChip({ active, count, href, onClick, children }: { active: boolean; count?: number; href?: string; onClick?: () => void; children: ReactNode }) {
  return (
    <Chip active={active} href={href} onClick={onClick}>
      {children}{count != null && <span className="ms-1.5 tabular-nums text-ink-2">{count}</span>}
    </Chip>
  );
}

export function DrillDownFilter({
  options, group, sub = "", onSelect, href, allLabel = "All", allCount, showAll = true,
  subAllLabel, ariaLabel = "Filter", trailing, className,
}: {
  options: FilterOption[];
  group: string;            // selected top-level facet key ("" = All)
  sub?: string;             // selected sub-facet key ("" = the whole group, or none)
  onSelect?: (group: string, sub: string) => void;
  href?: (group: string) => string;   // nav mode: render the top strip as links to this path
  allLabel?: ReactNode;     // copy for the reset chip (e.g. "All 142 systems")
  allCount?: number;
  showAll?: boolean;        // hide the reset chip (e.g. the forum switcher, where there's no "All")
  subAllLabel?: ReactNode;  // copy for the "whole house" chip (defaults to "All <house>")
  ariaLabel?: string;
  trailing?: ReactNode;     // extra chip(s) after the top strip (e.g. the "Course boards →" link)
  className?: string;
}) {
  const active = options.find((o) => o.key === group);
  const kids = active?.children ?? [];
  const strips = (
    <>
      <div className={FACET_STRIP}>
        {showAll && (
          <FacetChip active={!group} count={allCount}
            href={href ? href("") : undefined} onClick={href ? undefined : () => onSelect?.("", "")}>
            {allLabel}
          </FacetChip>
        )}
        {options.map((o) => (
          <FacetChip key={o.key} active={group === o.key} count={o.count}
            href={href ? href(o.key) : undefined} onClick={href ? undefined : () => onSelect?.(o.key, "")}>
            {o.label}
          </FacetChip>
        ))}
        {trailing}
      </div>
      {/* Drill-down: the selected house's subtopics (controlled mode only — nav-mode filters don't nest). */}
      {!href && active && kids.length > 0 && (
        <div className={FACET_STRIP} role="group" aria-label={`Narrow ${active.label}`}>
          <FacetChip active={!sub} onClick={() => onSelect?.(group, "")}>{subAllLabel ?? `All ${active.label}`}</FacetChip>
          {kids.map((c) => (
            <FacetChip key={c.key} active={sub === c.key} count={c.count} onClick={() => onSelect?.(group, c.key)}>
              {c.label}
            </FacetChip>
          ))}
        </div>
      )}
    </>
  );
  return href
    ? <nav aria-label={ariaLabel} className={cx("flex flex-col gap-2.5", className)}>{strips}</nav>
    : <div role="group" aria-label={ariaLabel} className={cx("flex flex-col gap-2.5", className)}>{strips}</div>;
}

/* ───────────────────────── MetricChip ─────────────────────────
   The small card-footer metric pill. `gold` for the headline/earned metric, `neutral`
   for counts. Generalises Courses' AvgViews pill so every domain's metric reads alike. */
export function MetricChip({ tone = "neutral", dense, icon, title, children, className }: {
  tone?: "gold" | "neutral"; dense?: boolean; icon?: ReactNode; title?: string; children: ReactNode; className?: string;
}) {
  // `dense` shrinks the pill (shorter, tighter padding, 11px) so several stat chips fit on ONE row
  // inside a narrow card — used by the course card's footer, where the 4-up (xl) column is only
  // ~200px wide and the default pill made the third stat wrap (ticket #138).
  return (
    <span title={title} className={cx("inline-flex items-center whitespace-nowrap rounded-pill font-semibold",
      dense ? "h-5 gap-0.5 px-1.5 text-[11px]" : "h-6 gap-1 px-2 text-[12px]",
      tone === "gold" ? "bg-yang/15 text-yang ring-1 ring-yang/25" : "bg-veil/[0.06] text-ink-2", className)}>
      {icon}{children}
    </span>
  );
}

/* ───────────────────────── EmptyState ─────────────────────────
   One no-results / nothing-here block (role=status). Replaces the five different ad-hoc
   "No … match" paragraphs with a consistent glyph + headline + body + optional action. */
export function EmptyState({ icon, title, body, action, className }: {
  icon?: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode; className?: string;
}) {
  return (
    <div role="status" className={cx("flex flex-col items-center gap-3 rounded-card border border-dashed border-line bg-space-2/40 px-6 py-16 text-center", className)}>
      {icon && <span aria-hidden className="grid h-12 w-12 place-items-center rounded-full bg-veil/[0.04] text-ink-3">{icon}</span>}
      <p className="text-[16px] font-semibold text-ink">{title}</p>
      {/* ink-2, not ink-3. ink-3 clamps to 3:1 — a tier for rules and glyphs — and this is the
          sentence that explains an empty screen, i.e. the one thing on it worth reading. */}
      {body && <p className="max-w-sm text-[14px] leading-relaxed text-ink-2">{body}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/* ───────────────────────── Skeletons ─────────────────────────
   Shimmer placeholders for loading grids/lists. The global prefers-reduced-motion reset
   (index.css) freezes the pulse automatically — no extra a11y work needed. */
export function SkeletonCard({ media = true, className }: { media?: boolean; className?: string }) {
  return (
    <div className={cx("animate-pulse overflow-hidden rounded-card border border-line bg-space-2", className)}>
      {media && <div className="aspect-[16/9] bg-veil/5" />}
      <div className="flex flex-col gap-2.5 p-4">
        <div className="h-3.5 w-4/5 rounded bg-veil/10" />
        <div className="h-3 w-2/5 rounded bg-veil/5" />
        <div className="mt-1 h-5 w-1/3 rounded-pill bg-veil/5" />
      </div>
    </div>
  );
}
export function SkeletonGrid({ count = 8, media = true, className }: { count?: number; media?: boolean; className?: string }) {
  return (
    <div aria-hidden className={cx("grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4", className)}>
      {Array.from({ length: count }, (_, i) => <SkeletonCard key={i} media={media} />)}
    </div>
  );
}

/* ───────────────────────── SignInGate ─────────────────────────
   The one signed-out screen for member-only pages (wallet, account, …) — headline, a line on
   why signing in is needed, and the sign-in button (AQ_LOGIN_URL when the shell provides it). */
export function SignInGate({ title, body, cta = "Sign in", href }: { title: ReactNode; body: ReactNode; cta?: ReactNode; href?: string }) {
  const login = href
    || (typeof window !== "undefined" ? (window as unknown as Record<string, string>).AQ_LOGIN_URL : "")
    || "/login/";
  return (
    <div className="py-20 text-center">
      <h1 className="text-[26px] font-bold tracking-tight">{title}</h1>
      <p className="mt-2 text-ink-2">{body}</p>
      <Button href={login} className="mt-6 h-11 px-7 text-[15px]">{cta}</Button>
    </div>
  );
}

/* ───────────────────────── StatusNote ─────────────────────────
   The one centred in-flow status line ("Loading…", "Couldn't load — refresh") used while a
   list/table fills in. Replaces the per-page ad-hoc <p class="py-10 text-center …"> copies.
   `error` switches to role=alert; substantial no-result states should use EmptyState instead. */
export function StatusNote({ error, className, children }: { error?: boolean; className?: string; children: ReactNode }) {
  return (
    <p role={error ? "alert" : "status"} className={cx("py-10 text-center text-[14px] text-ink-3", className)}>
      {children}
    </p>
  );
}

/* ───────────────────────── BackLink ─────────────────────────
   The one "← back to the list" affordance (Issues detail, course/section boards, thread views).
   Renders an <a> with href (locale-aware) or a <button> with onClick. */
export function BackLink({ href, onClick, className, children }: { href?: string; onClick?: () => void; className?: string; children: ReactNode }) {
  const cls = cx("inline-flex items-center gap-1 self-start text-[14px] font-semibold text-ink-3 transition-colors hover:text-yang", className);
  // The arrow points the way the reader travels, so it mirrors. It already sits in its own
  // aria-hidden span, so it was never baked into a translated string — flipping it costs no cache.
  const inner = <><span aria-hidden className="inline-block rtl:-scale-x-100">←</span>{children}</>;
  return href
    ? <a href={localePath(href)} className={cls}>{inner}</a>
    : <button type="button" onClick={onClick} className={cls}>{inner}</button>;
}

/* ───────────────────────── LoadMoreButton (keyset) ─────────────────────────
   One source of truth for the "Load more" keyset button (was duplicated verbatim in
   Courses + Discussions). Render only when there's a next cursor; appends, never OFFSET. */
export function LoadMoreButton({ onClick, loading, label = "Load more", className }: {
  onClick: () => void; loading?: boolean; label?: string; className?: string;
}) {
  return (
    <div className={cx("flex justify-center pt-2", className)}>
      <button type="button" onClick={onClick} disabled={loading}
        className="inline-flex h-11 items-center gap-2 rounded-pill border border-line bg-space-2 px-6 text-[14px] font-semibold text-ink-2 transition-colors hover:border-yin-light hover:text-ink disabled:opacity-50">
        {loading ? "Loading…" : label}
      </button>
    </div>
  );
}
