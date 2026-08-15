/**
 * Compatibility adapter: presents the legacy page-facing API but sources everything
 * from the new ArtaQuest backend (`/wp-json/aq/v1/*`, see plugin src/Rest.php). This
 * lets the existing pages run unchanged on the lean new backend during/after the cutover.
 * New code should import from `./api` directly; this file is the bridge.
 */
import { aqCountryId } from "./geo";
import type { TypologyTag, Selections } from "./typology-meta";
import { aqFetch } from "./offline/fetch";
import { ApiError } from "./api";

const BASE = "/wp-json";
const NONCE =
  (typeof window !== "undefined" && (window as unknown as { AQ_WP_NONCE?: string }).AQ_WP_NONCE) || "";

async function get<T>(path: string): Promise<T> {
  const r = await aqFetch(`${BASE}${path}`, {
    credentials: "include",
    headers: NONCE ? { "X-WP-Nonce": NONCE } : {},
  });
  if (!r.ok) throw new Error(`WP ${path} → ${r.status}`);
  return r.json();
}
async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const r = await aqFetch(`${BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(NONCE ? { "X-WP-Nonce": NONCE } : {}) },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  // Carry the HTTP status (mirrors ./api's ApiError) so callers can tell a paywall (402) — e.g. the
  // enrol entry fee a new member can't yet cover — apart from an auth/network/server failure. The
  // backend message is preserved, so existing `catch (e) { e.message }` consumers are unaffected.
  if (!r.ok) {
    // A STALE NONCE IS NOT A SERVER ERROR, AND IT MUST NOT READ LIKE ONE.
    //
    // NONCE is captured once when this module is imported and sent for the life of the tab, but
    // WordPress REST nonces roll on the 12/24-hour tick. After that, rest_cookie_check_errors
    // rejects the request before the route's permission callback ever runs, and the message the
    // browser gets back is WordPress's own "Cookie check failed" — which names no cause and offers
    // no way out. Pages surface it verbatim, so on /donate (which invites a long dwell: three
    // decision steps, a live certificate preview and the whole books section) the one tap that
    // moves money failed with a sentence about cookies. Say what actually happened instead.
    const code = (j as { code?: string })?.code || "";
    if ((r.status === 401 || r.status === 403) && /nonce|cookie/i.test(code + " " + ((j as { message?: string })?.message || ""))) {
      // Deliberately generic: post() is shared by every page, and only some of them can promise that
      // reloading keeps anything. A page that CAN (see Donate's stashIntent) says so itself.
      throw new ApiError(path, r.status, "Your session has expired. Please reload the page and try again.");
    }
    throw new ApiError(path, r.status, (j as { message?: string })?.message);
  }
  return j as T;
}
const AQ = "/aq/v1";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

/**
 * Render a discussion / ArtaBot body (raw markdown + LaTeX) to safe HTML — the client-side
 * equivalent of the old server md renderer. XSS-safe: every run of text is HTML-escaped before any
 * tag is emitted, so nothing the author (or the model) writes can inject markup. Math `$…$` / `$$…$$`
 * becomes `.aq-math[data-tex]` nodes that RichText's renderMathIn() typesets with KaTeX; currency-safe
 * — a `$…$` that is just a number/amount is left as literal text so prices don't become equations.
 * Markdown covered: **bold**, *italic*, `inline code`, fenced ```code blocks```, [links](https://…),
 * `#`/`##`/`###` headings, `-`/`*`/`+` and `1.` lists, and paragraphs (blank line = new block, lone
 * newline = <br>). Emitted class names match the `.aq-prose .aq-md-*` styles in index.css.
 */
export function renderRich(raw: string): string {
  if (!raw) return "";
  // Stash the non-inline constructs (fenced code + math) behind NUL-delimited placeholders so the
  // escape / inline / block passes never see — or mangle — their literal contents; restored at the end.
  // NUL can't occur in real text and survives esc()/inline rules untouched. Built at runtime so no
  // control character ever lives in this source file (and no `new RegExp` needs a lint exception).
  const NUL = String.fromCharCode(0);
  const stash: string[] = [];
  const hold = (html: string) => `${NUL}B${stash.push(html) - 1}${NUL}`;

  // 1) Fenced code blocks first — content is literal (escaped, never md/math-processed). Isolated on
  //    its own line (newlines around the placeholder) so the block pass emits a standalone <pre>.
  let s = raw.replace(/```[ \t]*[\w+#.-]*[ \t]*\r?\n([\s\S]*?)```/g,
    (_m, code: string) => `\n${hold(`<pre class="aq-md-pre"><code>${esc(code.replace(/\r?\n$/, ""))}</code></pre>`)}\n`);

  // 2) LaTeX math (display + inline) — stash the source so esc()/inline rules leave the TeX intact.
  const math = (tex: string, display: boolean) => {
    const tag = display ? "div" : "span";
    const cls = display ? "aq-math aq-math--display" : "aq-math";
    const d = display ? "$$" : "$";
    return hold(`<${tag} class="${cls}" data-tex="${esc(tex)}">${d}${esc(tex)}${d}</${tag}>`);
  };
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_m, t: string) => math(t.trim(), true));
  s = s.replace(/\$([^$\n]+?)\$/g, (m: string, t: string) => (/^[\s\d.,]+$/.test(t) ? m : math(t.trim(), false)));

  // 3) Escape everything that remains, THEN build block structure (inline formatting is applied
  //    per block in mdBlocks, after list/heading markers are stripped — so a `*`-bullet never
  //    collides with `*italic*`).
  s = mdBlocks(esc(s), NUL);

  // 4) Restore the stashed code blocks + math.
  return s.replace(new RegExp(NUL + "B(\\d+)" + NUL, "g"), (_m, i: string) => stash[+i]);
}

/** Media embeds are allowed ONLY from our own uploads.
 *
 *  ArtaBot returns charts and animations it produced as `![alt](url)`, and those must render as
 *  pictures rather than as the literal `!` and a link they were showing before. But inlineMd runs over
 *  every member-authored string on the platform, and an unrestricted image rule would let anyone embed
 *  a remote URL in a post — which loads on every reader's device and hands a third party their IP and
 *  a view count. So the embed is scoped to the uploads path, where the bytes are ours; anything else
 *  stays a link, which is what a link is for. */
const OUR_MEDIA = /^https:\/\/(?:[a-z0-9-]+\.)?artaquest\.(?:com|org)\/wp-content\/uploads\/(?!.*\.\.)[\w./-]+$/i;

/** Inline markdown on a single (already HTML-escaped) line: code, bold, italic, images, links. */
function inlineMd(t: string): string {
  return t
    .replace(/`([^`]+)`/g, '<code class="aq-md-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    // Images and video BEFORE links, or the link rule consumes the `](` and leaves a stray `!`.
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m: string, alt: string, url: string) =>
      OUR_MEDIA.test(url)
        ? `<img src="${url}" alt="${alt}" loading="lazy" class="aq-md-img" />`
        : `<a href="${url}" target="_blank" rel="noopener noreferrer">${alt || url}</a>`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+\.(?:mp4|webm))\)/g, (_m: string, label: string, url: string) =>
      OUR_MEDIA.test(url)
        ? `<video src="${url}" controls playsinline preload="metadata" class="aq-md-img"></video>`
        : `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    // Sound gets a player rather than a download link, which shows nobody anything.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+\.(?:mp3|wav|ogg|m4a))\)/g, (_m: string, label: string, url: string) =>
      OUR_MEDIA.test(url)
        ? `<audio src="${url}" controls preload="metadata" class="aq-md-audio"></audio>`
        : `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    // INTERACTIVE. A self-contained page ArtaBot built, embedded live so it can be explored rather
    // than described. `sandbox` WITHOUT allow-same-origin is the whole safety argument: the frame gets
    // an opaque origin, so its scripts run but cannot read a cookie, a token or the DOM around them —
    // and it is still only ever loaded from our own uploads, never a URL somebody pasted.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+\.html)\)/g, (_m: string, label: string, url: string) =>
      OUR_MEDIA.test(url)
        ? `<iframe src="${url}" title="${label}" class="aq-md-frame" sandbox="allow-scripts allow-popups" loading="lazy" referrerpolicy="no-referrer"></iframe>`
        : `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

/** Group already-escaped lines into block elements: `#`/`##`/`###` headings, `-`/`*`/`+` and `1.`
 *  lists, and paragraphs (a blank line ends a block; a lone newline becomes <br>). A line that is
 *  solely a stashed placeholder (fenced code / display math) is emitted as its own block — never
 *  wrapped in a <p>. Each block's text is inline-formatted via inlineMd. */
function mdBlocks(src: string, NUL: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  const isHold = new RegExp(`^${NUL}B\\d+${NUL}$`);
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inlineMd).join("<br>")}</p>`); para = []; } };
  const flushList = () => {
    if (list) {
      const cls = list.tag === "ul" ? "aq-md-ul" : "aq-md-ol";
      out.push(`<${list.tag} class="${cls}">${list.items.map((i) => `<li>${inlineMd(i)}</li>`).join("")}</${list.tag}>`);
      list = null;
    }
  };
  for (const ln of src.split("\n")) {
    const line = ln.trim();
    if (!line) { flushPara(); flushList(); continue; }            // blank line = block break
    if (isHold.test(line)) { flushPara(); flushList(); out.push(line); continue; } // standalone code/display-math
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) { flushPara(); flushList(); out.push(`<h${h[1].length} class="aq-md-h">${inlineMd(h[2])}</h${h[1].length}>`); continue; }
    const ul = /^[-*+]\s+(.+)$/.exec(line);
    if (ul) { flushPara(); if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; } list.items.push(ul[1]); continue; }
    const ol = /^\d+\.\s+(.+)$/.exec(line);
    if (ol) { flushPara(); if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; } list.items.push(ol[1]); continue; }
    flushList(); para.push(line);
  }
  flushPara(); flushList();
  return out.join("");
}

/** Compact relative time ("just now", "5m ago", "3d ago") from a unix-seconds timestamp. The
 *  backend ships raw `at`/`created` ints; the bridge formats them so pages stay presentational. */
export function relAgo(secs: number): string {
  if (!secs) return "";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - secs);
  const units: [string, number][] = [["y", 31536000], ["mo", 2592000], ["w", 604800], ["d", 86400], ["h", 3600], ["m", 60]];
  for (const [u, s] of units) { const v = Math.floor(diff / s); if (v >= 1) return `${v}${u} ago`; }
  return "just now";
}

/**
 * "Active today" / "yesterday" / "3 days ago" for a LAST-SEEN value.
 *
 * Not relAgo(). The server stores UTC midnight of the day a member was last around and nothing
 * finer (Auth::mark_seen — the database is public, so precision that is collected is precision that
 * is published). Passing that to relAgo would print "9h ago" or "23h ago" for somebody seen today:
 * an hour-accurate sentence built from a value that only knows the date, which is a claim the data
 * cannot support and reads as tracking that is not happening.
 *
 * So it counts whole DAYS between calendar days, and says nothing more exact than it knows. ''
 * when never recorded, so a caller can omit the line entirely rather than print "never".
 */
export function lastSeenLabel(secs: number): string {
  if (!secs) return "";
  const DAY = 86400;
  // Both sides floored to a UTC day boundary: comparing a midnight against "now" would call
  // somebody seen this morning "yesterday" for most of the day.
  const days = Math.max(0, Math.floor(Date.now() / 1000 / DAY) - Math.floor(secs / DAY));
  if (days === 0) return "Active today";
  if (days === 1) return "Active yesterday";
  if (days < 7) return `Active ${days} days ago`;
  if (days < 14) return "Active last week";
  if (days < 60) return `Active ${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `Active ${Math.floor(days / 30)} months ago`;
  const y = Math.floor(days / 365);
  return `Active ${y} year${y === 1 ? "" : "s"} ago`;
}

/** A stored `YYYY-MM-DD` birthday as a full date in the reader's language ("14 March 1998").
 *  Built from the calendar PARTS, never `new Date("1998-03-14")` — that parses as UTC midnight,
 *  which renders as the previous day for every reader west of Greenwich. '' when unset/malformed. */
export function fmtBirthday(ymd?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((ymd || "").trim());
  if (!m) return "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return "";
  // uiLocale(), not uiLang(): a bare "fa" renders this in the Jalali calendar, so a member whose
  // stored birthday is 1990-08-14 saw a different day and year on their own profile, with nothing
  // saying it had been converted. The value here is a Gregorian YYYY-MM-DD; it is displayed as one.
  try { return d.toLocaleDateString(uiLocale(), { day: "numeric", month: "long", year: "numeric" }); }
  catch { return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }); }
}

/** Whole years since a `YYYY-MM-DD` birthday, or null when unset/malformed. Local-calendar
 *  arithmetic (no timestamps), so it never slips a day across a timezone or a leap year. */
export function ageFrom(ymd?: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((ymd || "").trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const now = new Date();
  let age = now.getFullYear() - y;
  const md = (now.getMonth() + 1) * 100 + now.getDate();
  if (md < mo * 100 + d) age--;
  return age >= 0 && age <= 150 ? age : null;
}

// ── Session helpers (server-injected on first paint) ─────────────────────────
export function isLoggedIn(): boolean {
  if (typeof window === "undefined") return false;
  const v = (window as unknown as { AQ_LOGGED_IN?: boolean }).AQ_LOGGED_IN;
  return v === undefined ? true : !!v;
}
export function currentUser(): { name: string; avatar: string; slug?: string; country?: string; birthday?: string; nationality?: string; birth_min?: string; has_identity?: boolean; season?: number } | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { AQ_USER?: { name: string; avatar: string; slug?: string; country?: string; birthday?: string; nationality?: string; birth_min?: string; has_identity?: boolean; season?: number } }).AQ_USER ?? null;
}
export function googleClientId(): string {
  if (typeof window === "undefined") return "";
  return (window as unknown as { AQ_GOOGLE_CLIENT_ID?: string }).AQ_GOOGLE_CLIENT_ID || "";
}
/** Prefix an internal link with the visitor's current language (English un-prefixed). */
export function localePath(href: string): string {
  if (typeof window === "undefined" || !href) return href;
  let origin = "", rest = href;
  if (/^https?:\/\//i.test(href)) {
    try {
      const u = new URL(href);
      if (u.origin !== window.location.origin) return href;
      origin = u.origin; rest = u.pathname + u.search + u.hash;
    } catch { return href; }
  } else if (!href.startsWith("/") || href.startsWith("//")) {
    return href;
  }
  const cur = ((window as unknown as { AQ_I18N?: { current?: string } }).AQ_I18N?.current || "en").toLowerCase().split("-")[0];
  if (!cur || cur === "en") return href;
  if ((rest.split("/")[1] || "").toLowerCase() === cur) return href;
  return origin + "/" + cur + rest;
}
export function uiLang(): string {
  const w = window as unknown as { AQ_I18N?: { current?: string } };
  return (w.AQ_I18N?.current || document.documentElement.lang || "en").toLowerCase().split("-")[0];
}

/**
 * The locale to format DATES in — the SITE's language, not the browser's.
 *
 * Every date on the platform used `toLocaleDateString(undefined, …)`, which reads the BROWSER's
 * locale. A Persian reader on `/fa/` whose browser is en-US therefore saw "August 14, 2026" on an
 * otherwise Persian page. The page's language is the right answer, and it is the one thing
 * `undefined` can never be.
 *
 * TWO extensions are pinned, and both are load-bearing:
 *
 *  - `ca-gregory` — bare "fa" formats in the JALALI calendar: 14 August 2026 becomes ۲۳ مرداد ۱۴۰۵.
 *    For a DOI-bearing, citable record that is a change to the PUBLICATION DATE, not to its
 *    presentation, so it must never happen implicitly. A reader-facing Jalali option is a real
 *    feature, but it belongs behind an explicit preference, decided separately.
 *  - `nu-latn` — keeps Western digits. Numerals are a separate, uniform decision (the server still
 *    sends `digits: null`, leaving the localiser in lib/i18n.ts dormant); pinning them here means
 *    dates cannot drift into Persian digits while every other number on the page stays Latin.
 *
 * Net effect for Persian: "August 14, 2026" → "14 اوت 2026" — the language localises, the calendar
 * and the numerals do not.
 */
export function uiLocale(): string {
  const l = uiLang();
  return l === "en" ? "en" : `${l}-u-ca-gregory-nu-latn`;
}

// ── Auth (passwordless) — endpoints are unchanged in the new backend ─────────
export type AuthResult = {
  ok: boolean; error?: string; message?: string; redirect?: string;
  user?: { name: string; avatar: string; slug?: string; country?: string }; cooldown?: number; expires_in?: number;
};
async function authPost(action: string, body: Record<string, unknown>): Promise<AuthResult> {
  try {
    const r = await fetch(`${BASE}${AQ}/auth/${action}`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json", ...(NONCE ? { "X-WP-Nonce": NONCE } : {}) },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    return { ...j, ok: r.ok && j?.ok === true };
  } catch {
    return { ok: false, message: "Network error. Please try again." };
  }
}
/** Unused by the login page, which has its own client in lib/auth.ts — kept for other callers. */
export const requestLoginCode = (email: string) => authPost("request-code", { email });
export const verifyLoginCode = (email: string, code: string, redirect?: string) => authPost("verify-code", { email, code, redirect });
export const googleSignIn = (credential: string, redirect?: string) => authPost("google", { credential, redirect });

// ── Types (page-facing shapes; preserved so pages compile unchanged) ─────────
export type Stat = { label: string; value: string; sub: string };
export type PointBreakdown = {
  learn: number; donate: number; volunteer: number; outreach: number; total: number;
  // Contribution tracks (each its own leaderboard): bug→Sentinel, feature→Visionary,
  // content→Curator (creation points, ∝ the coins a published work cost), suggestion→Sage.
  bug?: number; feature?: number; content?: number; suggestion?: number;
};
/** Per-track points as the backend returns them (no `total`); the bridge adds `total` = balance. */
export type TrackPoints = {
  learn: number; donate: number; volunteer: number; outreach: number;
  bug?: number; feature?: number; content?: number; suggestion?: number;
};
const ZERO_TRACKS: TrackPoints = { learn: 0, donate: 0, volunteer: 0, outreach: 0 };
export type EnrolledCourse = { id?: number; value: string; url: string; resume?: string; image?: string; lessons?: number; pct?: number; cert?: boolean };
export type Dashboard = {
  user: { name: string; avatar: string; slug?: string; bio?: string; country?: string; palm?: string; links?: Partial<Record<ProfileLinkKey, string>>; relationship?: string; location?: string; languages?: string[] };
  coins: number; points: number;
  tier: { label?: string; next: string | null; pct: number; remaining: number };
  stats: Stat[]; courses: EnrolledCourse[];
};

/** Compose the dashboard from the new /dashboard + /me endpoints. */
export async function getDashboard(): Promise<Dashboard | null> {
  try {
    const [d, me] = await Promise.all([
      get<{ courses: EnrolledCourse[]; points: number; coins: number }>(`${AQ}/dashboard`),
      get<{ user: ({ name: string; slug: string; avatar: string; country?: string; palm?: string; tier: string; bio?: string; links?: Partial<Record<ProfileLinkKey, string>>; relationship?: string; location?: string; languages?: string[]; completed?: number; works?: number; progress?: { label: string; next: string | null; pct: number; remaining: number } }) | null }>(`${AQ}/me`),
    ]);
    const u = me.user;
    const courses = d.courses || [];
    return {
      user: { name: u?.name || "Quester", avatar: u?.avatar || "", slug: u?.slug, bio: u?.bio || "", country: u?.country || "", palm: u?.palm || "", links: u?.links, relationship: u?.relationship || "", location: u?.location || "", languages: u?.languages ?? [] },
      coins: d.coins, points: d.points,
      // Real rank-ring progress, computed server-side (Economy::tier_progress) — was hardcoded next:null/pct:0.
      tier: u?.progress ?? { label: u?.tier || "Quester", next: null, pct: 0, remaining: 0 },
      // The dashboard's four numbers.
      //
      // "Courses enrolled" and "Completed — certificates earned" were the first two, and both had
      // read a permanent 0 since the courses platform was purged in July: not an empty state a member
      // could act on, but two tiles advertising a product that does not exist, on the page they land
      // on. Unlike Home's course grid, which hides itself when there are none, these rendered
      // unconditionally — so the zero was the only thing they ever said.
      //
      // Works replaces both, because it is the number this platform is actually about and the one a
      // member can move. Points and Coins are unchanged.
      stats: [
        { label: "Works", value: String(u?.works ?? 0), sub: "published" },
        { label: "Points", value: String(d.points ?? 0), sub: "lifetime, all tracks" },
        { label: "Coins", value: String(d.coins ?? 0), sub: "in your wallet" },
      ],
      courses,
    };
  } catch { return null; }
}

export async function postProfileUpdate(
  name: string,
  bio: string,
  username?: string,
  links?: Partial<Record<ProfileLinkKey, string>>,
  // Both follow the links contract: `undefined` means LEAVE IT ALONE, "" means stop saying.
  relationship?: string,
  location?: string,
  languages?: string[],
): Promise<{ ok: boolean; name: string; bio: string; slug?: string; links?: Partial<Record<ProfileLinkKey, string>>; relationship?: string; location?: string; languages?: string[]; message?: string }> {
  try {
    const body: Record<string, unknown> = { name, bio };
    if (username) body.username = username; // only sent when the member actually changed their handle
    // OMITTED means "leave them alone"; {} means "clear them". A caller that does not edit links must
    // not wipe them, so this is only sent when the caller actually has a value to state.
    if (links) body.links = links;
    if (relationship !== undefined) body.relationship = relationship;
    if (location !== undefined) body.location = location;
    if (languages !== undefined) body.languages = languages;
    const r = await post<{ ok: boolean; name: string; bio: string; slug?: string; links?: Partial<Record<ProfileLinkKey, string>>; relationship?: string; location?: string; languages?: string[] }>(`${AQ}/profile-update`, body);
    return { ok: !!r.ok, name: r.name ?? name, bio: r.bio ?? bio, slug: r.slug, links: r.links, relationship: r.relationship, location: r.location, languages: r.languages };
  } catch (e) {
    // Surface the server's reason (taken / reserved / invalid / rate-limited) so the form can show it.
    return { ok: false, name, bio, message: e instanceof Error ? e.message : undefined };
  }
}

/** Live username availability for the settings form (GET /username/check). null = couldn't check. */
export type UsernameCheck = { username: string; available: boolean; reason?: string; message?: string };
export async function checkUsername(u: string): Promise<UsernameCheck | null> {
  try { return await get<UsernameCheck>(`${AQ}/username/check?u=${encodeURIComponent(u)}`); }
  catch { return null; }
}
// ── Discussions ──────────────────────────────────────────────────────────────
export type Forum = { slug: string; title: string; desc: string };
export type Thread = {
  slug: string; title: string; excerpt: string; author: string;
  votes: number; replies: number; views: number; last_at: string; last_by: string;
  pinned: boolean; url: string; lang?: string;
};
export type DiscussionsData = { forums: Forum[]; forum: Forum | null; threads: Thread[]; next: number | null };
const FORUMS: Forum[] = [
  { slug: "general", title: "General", desc: "Anything about learning here" },
  { slug: "courses", title: "Courses", desc: "Questions about specific courses" },
  { slug: "feedback", title: "Feedback", desc: "Ideas and issues" },
];
type ThreadCardR = { id: number; title: string; topic: string; lang: string; author: string; comments: number; score: number; at: number };
export async function getDiscussions(forum = "general", cursor: number | null = null): Promise<DiscussionsData> {
  try {
    const params = new URLSearchParams({ topic: forum });
    if (cursor) params.set("cursor", String(cursor));
    const d = await get<{ items: ThreadCardR[]; next: number | null }>(`${AQ}/threads?${params}`);
    return {
      forums: FORUMS,
      forum: FORUMS.find((f) => f.slug === forum) || FORUMS[0],
      threads: (d.items || []).map((t) => ({
        // No last-comment data in the lean backend (aq_threads has no last-activity column), so
        // show when the thread was STARTED (its created time) rather than a fake "last comment".
        slug: String(t.id), title: t.title, excerpt: "", author: t.author,
        votes: t.score, replies: t.comments, views: 0, last_at: relAgo(t.at), last_by: t.author,
        pinned: false, url: `/discussions/?forum=${forum}&thread=${t.id}`, lang: t.lang,
      })),
      // Keyset cursor (never OFFSET) — board scales past the first page; null = no further pages.
      next: d.next ?? null,
    };
  } catch { return { forums: FORUMS, forum: FORUMS[0], threads: [], next: null }; }
}

export type ThreadComment = {
  id: string; author: string; votes: number; my_vote?: number; parent: string;
  body_html: string; body_md?: string; time: string; mine?: boolean; edited?: boolean; deleted?: boolean; lang?: string;
  slug?: string; avatar?: string; country?: string;
  replies?: number; // TOTAL direct replies (server reply_count) — drives "show N more replies"
};
export type ThreadData = {
  forum: string; slug: string; id: string; title: string; author: string; time: string;
  votes: number; my_vote?: number; body_html: string; body_md?: string;
  mine?: boolean; edited?: boolean; comments: ThreadComment[]; lang?: string;
  next?: number | null;   // keyset cursor for more TOP-LEVEL comments (null = end)
  total?: number;         // denormalized comment_count (all comments, not just this page)
  sort?: "top" | "new";
};
type CommentR = {
  id: number; parent?: number; body: string; lang: string; author: string; score: number; at: number;
  my_vote?: number; mine?: boolean; slug?: string; avatar?: string; country?: string; replies?: number; edited?: boolean; deleted?: boolean;
};
const mapComment = (c: CommentR): ThreadComment => ({
  id: String(c.id), author: c.author, votes: c.score, my_vote: c.my_vote ?? 0, mine: !!c.mine,
  parent: c.parent ? String(c.parent) : "", // threaded reply nesting (0 = root); persists across reloads
  body_html: renderRich(c.body), body_md: c.body, time: relAgo(c.at), lang: c.lang,
  slug: c.slug, avatar: c.avatar, country: c.country, replies: c.replies ?? 0, edited: !!c.edited, deleted: !!c.deleted,
});
/** Thread + one page of its comment tree. Reddit-style read model: top-level comments are
 *  keyset-paginated by `sort`, each inlining its first replies; `next` pages more roots and
 *  getThreadReplies() pages one comment's children at any depth. */
export async function getThread(forum: string, thread: string, opts: { sort?: "top" | "new"; cursor?: number } = {}): Promise<ThreadData | null> {
  try {
    const qs = new URLSearchParams();
    if (opts.sort) qs.set("sort", opts.sort);
    if (opts.cursor) qs.set("cursor", String(opts.cursor));
    const t = await get<ThreadCardR & {
      body: string; my_vote?: number; mine?: boolean; comments: CommentR[];
      next?: number | null; total?: number; sort?: "top" | "new";
    }>(`${AQ}/threads/${encodeURIComponent(thread)}${qs.toString() ? `?${qs}` : ""}`);
    return {
      forum, slug: String(t.id), id: String(t.id), title: t.title, author: t.author, time: relAgo(t.at),
      // my_vote = the viewer's own cast (server truth), so the arrows render in-state on reload, not neutral.
      // mine = the viewer WROTE it (strict authorship — the no-self-vote state AND the only key that
      // unlocks Edit/Delete; ticket #65 removed the operator exception, posts are the author's alone).
      // Render markdown + LaTeX to HTML (KaTeX nodes); keep body_md raw so the edit composer round-trips.
      votes: t.score, my_vote: t.my_vote ?? 0, mine: !!t.mine, body_html: renderRich(t.body), body_md: t.body, lang: t.lang,
      comments: (t.comments || []).map(mapComment),
      next: t.next ?? null, total: t.total ?? (t.comments || []).length, sort: t.sort ?? "top",
    };
  } catch { return null; }
}
/** Page one comment's direct replies (any depth) — GET /threads/{id}?parent=&cursor=. */
export async function getThreadReplies(thread: string, parentId: string, cursor = 0): Promise<{ items: ThreadComment[]; next: number | null }> {
  const qs = new URLSearchParams({ parent: parentId });
  if (cursor) qs.set("cursor", String(cursor));
  try {
    const r = await get<{ items: CommentR[]; next: number | null }>(`${AQ}/threads/${encodeURIComponent(thread)}?${qs}`);
    return { items: (r.items || []).map(mapComment), next: r.next ?? null };
  } catch { return { items: [], next: null }; }
}
export type NewThread = { id: string; slug: string; forum: string; title: string; url: string };
export async function postDiscThread(forum: string, title: string, body: string): Promise<NewThread> {
  const j = await post<{ id: number }>(`${AQ}/threads`, { title, body, topic: forum, lang: uiLang() });
  return { id: String(j.id), slug: String(j.id), forum, title, url: `/discussions/?forum=${forum}&thread=${j.id}` };
}
export async function postDiscComment(thread: string, body: string, parent = ""): Promise<ThreadComment> {
  // Send `parent` so a reply persists its nesting (backend validates it belongs to this thread);
  // omit it for a root comment. The server returns the FULL shaped card — append the real row
  // (server author/avatar/timestamps), not a fabricated one that drifts from the next reload.
  const j = await post<{ id: number; card?: CommentR | null }>(`${AQ}/threads/${encodeURIComponent(thread)}/comments`, parent ? { body, lang: uiLang(), parent } : { body, lang: uiLang() });
  if (j.card) return mapComment(j.card);
  return { id: String(j.id), author: currentUser()?.name || "You", votes: 0, mine: true, parent, body_html: renderRich(body), body_md: body, time: "just now", replies: 0 };
}
export async function previewMarkdown(body: string): Promise<string> {
  // Same renderer as the posted result, so the composer preview matches (markdown + LaTeX).
  return renderRich(body);
}
export async function postDiscVote(target: string, val: -1 | 0 | 1, kind: "thread" | "comment" = "thread"): Promise<{ my_vote: number; votes: number }> {
  const id = parseInt(target.replace(/\D/g, ""), 10) || 0;
  // `val` is the DESIRED end state (set semantics — a retry can never flip a vote); target_type is
  // the EXPLICIT `kind` from the caller. The server replies with the AUTHORITATIVE new score (others
  // may be voting concurrently) + the recorded my_vote — the optimistic caster (lib/votes.ts)
  // reconciles the on-screen count to it. A failure THROWS so the caster rolls back the optimistic
  // state and surfaces the error (a silent no-op reads as "the vote buttons don't work", ticket #32).
  const r = await post<{ ok: boolean; my_vote?: number; votes?: number }>(`${AQ}/vote`, { target_type: kind, target_id: id, val });
  return { my_vote: r.my_vote ?? val, votes: r.votes ?? 0 };
}

// ── Vote transparency roster (who up/down-voted) ───────────────────────────────
export type Voter = { name: string; slug: string; avatar: string; country: string; verified: boolean; at: number };
export type VoterRoster = { up: Voter[]; down: Voter[]; more: boolean };
/** Everyone who up- or down-voted a target, EARLIEST FIRST (the hover roster on a vote control).
 *  `kind`/`id` mirror postDiscVote — a thread head or a comment (section or public board). */
export async function getVoters(kind: "thread" | "comment", id: number): Promise<VoterRoster> {
  const r = await get<{ up?: Voter[]; down?: Voter[]; more?: boolean }>(`${AQ}/votes/${kind}/${id}`);
  return { up: r.up ?? [], down: r.down ?? [], more: !!r.more };
}

// ── Content pages + search ────────────────────────────────────────────────────
export type WpPage = { title: string; content: string; updated?: number };
export async function getPage(id: number | string): Promise<WpPage | null> {
  try {
    const p = await get<{ title: { rendered: string }; content: { rendered: string }; modified_gmt?: string }>(`/wp/v2/pages/${encodeURIComponent(String(id))}`);
    // modified_gmt is UTC without a 'Z' suffix — append one so it parses as UTC, not local. Drives
    // the "Last updated" <time> in <Page/> (matters most on legal pages: Terms/Privacy/Refund).
    const mod = p.modified_gmt ? Date.parse(p.modified_gmt + "Z") : NaN;
    return { title: p.title?.rendered || "", content: p.content?.rendered || "", updated: Number.isNaN(mod) ? undefined : Math.floor(mod / 1000) };
  } catch { return null; }
}
export type SearchHit = { title: string; url: string; sub: string };
export type SearchResults = { q: string; courses: SearchHit[]; threads: SearchHit[] };
export async function getSearch(q: string): Promise<SearchResults> {
  const enc = encodeURIComponent(q);
  try {
    // Search courses + discussions in parallel (both back the topbar + 404 search box). The
    // placeholder promises "courses, discussions", so both must actually be queried.
    const [c, t] = await Promise.all([
      get<{ items: { title: string; slug: string; channel: string }[] }>(`${AQ}/courses?q=${enc}`),
      get<{ items: { id: number; title: string; topic: string }[] }>(`${AQ}/threads?q=${enc}&limit=6`).catch(() => ({ items: [] })),
    ]);
    return {
      q,
      courses: (c.items || []).map((x) => ({ title: x.title, url: `/courses/${x.slug}`, sub: x.channel || "Course" })),
      threads: (t.items || []).map((x) => ({ title: x.title, url: `/discussions/?forum=${x.topic || "general"}&thread=${x.id}`, sub: x.topic ? `#${x.topic}` : "Discussion" })),
    };
  } catch { return { q, courses: [], threads: [] }; }
}

// ── Donations + transparency ──────────────────────────────────────────────────
export type DonateGateway = { id: string; title: string; desc: string };
export type DonateOptions = { currency: string; symbol: string; presets: number[]; gateways: DonateGateway[]; coin_buy_price?: number; coin_sell_price?: number; coin_fiat?: string };
export async function getDonateOptions(): Promise<DonateOptions> {
  const base: DonateOptions = { currency: "CAD", symbol: "$", presets: [5, 15, 30, 60, 120], gateways: [{ id: "card", title: "Card", desc: "Pay by card" }] };
  // Supply the gold-backed coin price (from /reserve) so the donate page can show what a gift
  // covers. BOTH sides of the spread: `buy` for the mint figure, and `sell` because that is what a
  // redeemed ArtaCredit actually costs the fund (Credits::cents_for) and what the server freezes
  // onto the gift. Quoting one side while charging the other made the donor's figure a number they
  // were never actually charged at.
  try {
    const r = await getReserve();
    if (r && r.buy > 0) { base.coin_buy_price = r.buy; base.coin_fiat = r.fiat; }
    if (r && r.sell > 0) { base.coin_sell_price = r.sell; }
  } catch { /* keep the static base if the reserve fetch fails */ }
  return base;
}
export type FundLedgerRow = { id: number; scope: string; direction: "in" | "out"; coins: number; reason: string; date: number };
// One earmarked destination (a directed donation pool): a group/country and the dollars it received.
export type FundEarmark = { bucket: string; kind: "grp" | "cty" | "typ"; key: string; label: string; dollars: number };
export type FoundationFinances = {
  symbol: string; currency: string; fiat: string;
  donations_fiat: number; donations_count: number;
  fund_issued: number; fund_balance: number;
  coin_supply: number; reserve_mg: number; backing_ratio: number;
  ledger: FundLedgerRow[];
  earmarks: FundEarmark[]; // where directed gifts went (empty until any earmarked donation)
};
export async function getFoundationFinances(): Promise<FoundationFinances | null> {
  try {
    // The books = donations (foundation/finances) + the REAL gold-backed coin reserve (reserve).
    const [f, r] = await Promise.all([
      get<{ total_cents: number; buckets: Record<string, number>; earmarks?: { bucket: string; kind: string; key: string; label: string; cents: number }[]; recent: { bucket: string; cents: number; note: string; at: number }[] }>(`${AQ}/foundation/finances`),
      get<{ issued_coins?: number; backing_mg?: number; ratio?: number }>(`${AQ}/reserve`).catch(() => ({} as { issued_coins?: number; backing_mg?: number; ratio?: number })),
    ]);
    const total = (f.total_cents || 0) / 100;
    return {
      symbol: "$", currency: "CAD", fiat: "CAD",
      // `donations_count` is the size of the last-25 `recent` WINDOW, spends included — it is not a
      // gift count and never was, so it is capped at 25 by construction and counts money leaving as
      // money arriving. No consumer may label it "gifts"; /reserve did, and that tile is gone.
      donations_fiat: total, donations_count: (f.recent || []).length,
      // `?? 1` claimed a perfect backing ratio whenever the server omitted one. A ratio is a
      // published financial figure: absent means 0 known backing, never "fully backed".
      fund_issued: 0, fund_balance: total,
      coin_supply: r.issued_coins ?? 0, reserve_mg: r.backing_mg ?? 0, backing_ratio: r.ratio ?? 0,
      ledger: (f.recent || []).map((rr, i) => ({ id: i, scope: rr.bucket, direction: "in", coins: rr.cents / 100, reason: rr.note || rr.bucket, date: rr.at })),
      earmarks: (f.earmarks || []).map((e) => ({ bucket: e.bucket, kind: (e.kind as "grp" | "cty" | "typ"), key: e.key, label: e.label, dollars: e.cents / 100 })),
    };
  } catch { return null; }
}

// ── Courses ────────────────────────────────────────────────────────────────
export type CourseCard = {
  id?: number;
  title: string; url: string; excerpt: string; image: string;
  instructor: string; lessons: number; category: string; duration_sec?: number;
  // Subject facet: `topic` is the canonical slug (drives the catalogue filter); `category` carries
  // its human label (the card metric). `subtopic` is the second-level slug under the house (ticket
  // #89; "" when the course matched no sub). All empty on the dev/lorem path.
  topic?: string;
  subtopic?: string;
  is_free?: boolean; price?: number; currency?: string; price_display?: string;
  rating?: number; enrolled?: number;
  // Ranking metric (comment-based trending, 2026-06-13): a course trends by the DISCUSSION it sparks,
  // not passive views. `comments_per_day` = the AVERAGE per-video rolling-24h comment count (the card's
  // headline metric, "X/day" — YouTube comments the average video drew in the trailing day; ticket #95);
  // `comments_total` = total comments across the course (the fallback metric until a rate accrues — a
  // video earns no rate on its first refresh). Both 0 for a course with no discussion yet. Sort = rate ×100.
  comments_per_day?: number; comments_total?: number;
  pool?: number; // live prize pool in coins (QUESTER_SHARE of revenue) — card shows "₳N pool" with the season countdown
};
type CourseDisciplineR = { key: string; label: string; house: string; house_label: string };
type CourseCardR = { id: number; slug: string; title: string; image: string; channel: string; lessons: number; duration: number; price: number; comments_per_day?: number; comments_total?: number; pool?: number; topic?: string; topic_label?: string; subtopic?: string; subtopic_label?: string; disciplines?: CourseDisciplineR[] };
// Map one raw catalogue row (the backend shape) → the SPA CourseCard. Shared by the paginated catalogue
// list and the home recommender's per-cell course fetch, so both stay in lockstep.
function toCard(c: CourseCardR): CourseCard {
  return {
    id: c.id, title: c.title, url: `/courses/${c.slug}`, excerpt: "", image: c.image,
    instructor: c.channel || "", lessons: c.lessons, category: c.topic_label || "", duration_sec: c.duration,
    topic: c.topic || "", subtopic: c.subtopic || "",
    is_free: (c.price ?? 0) <= 0, price: c.price ?? 0, currency: "ARTA",
    price_display: (c.price ?? 0) > 0 ? `₳${c.price}` : "",
    comments_per_day: c.comments_per_day ?? 0, comments_total: c.comments_total ?? 0, pool: c.pool ?? 0,
  };
}
// One subject facet for the catalogue filter bar: a canonical topic slug, its human label, and how
// many published courses carry it. Returned by getCourseTopics (GET /courses/topics), broadest-first.
// `subs` is the optional SECOND level (ticket #89) — the house's sub-subjects that have ≥1 published
// course, each with its own count; absent when the house has no populated sub (→ the filter renders
// one level for that house, exactly as before).
export type CourseTopicSub = { slug: string; label: string; count: number };
export type CourseTopic = { slug: string; label: string; count: number; subs?: CourseTopicSub[] };
// `next` is a number id for the newest-first list, or a "score:id" compound-cursor string for the
// ranked (sort="trending") list — opaque to the caller, just pass it straight back as the next `cursor`.
export type CourseCursor = number | string | null;
export type CourseCardPage = { items: CourseCard[]; next: CourseCursor; seasonEnds?: number };
/** One keyset-cursor page of the catalogue ({items, next}), mirroring the backend — never OFFSET.
 *  `q` = server-side title search; `sort="trending"` ranks by rolling-24h comment rate; `topic` = a
 *  canonical subject slug to facet on (from getCourseTopics). `subtopic` drills into that house's
 *  sub-subject (ticket #89; only meaningful with a `topic`). Pass the previous page's `next` as
 *  `cursor` to fetch the next page (null = first page). `limit` caps the page size. `next` is null
 *  when there are no further pages. */
export async function getCourseCards(q = "", cursor: CourseCursor = null, limit?: number, sort?: string, topic?: string, subtopic?: string): Promise<CourseCardPage> {
  try {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (cursor) params.set("cursor", String(cursor));
    if (limit) params.set("limit", String(limit));
    if (sort) params.set("sort", sort);
    if (topic) params.set("topic", topic);
    if (subtopic) params.set("subtopic", subtopic);
    const qs = params.toString();
    const d = await get<{ items: CourseCardR[]; next: CourseCursor; season_ends?: number }>(`${AQ}/courses${qs ? `?${qs}` : ""}`);
    return {
      items: (d.items || []).map(toCard),
      next: d.next ?? null,
      seasonEnds: d.season_ends ?? 0,
    };
  } catch { return { items: [], next: null }; }
}

/** Courses in ONE strict (house × sign) cell — the home recommender's drill-down. Uses the primary-house
 *  facet (?house=, NOT the catalogue's cross-listed ?topic=) so each course sits in exactly one cell, and
 *  ranks them trending. Returns the top `limit` cards ([] on failure, so a cell just renders without them). */
export async function getCellCourses(house: string, sign: string, limit = 6): Promise<CourseCard[]> {
  try {
    const qs = new URLSearchParams({ house, sign, sort: "trending", limit: String(limit) }).toString();
    const d = await get<{ items: CourseCardR[] }>(`${AQ}/courses?${qs}`);
    return (d.items || []).map(toCard);
  } catch { return []; }
}

/** The catalogue's subject facets ({slug,label,count}) — every topic with ≥1 published course,
 *  broadest-first, for the Courses filter bar (GET /courses/topics). Empty array on failure so the
 *  page simply renders without the filter rather than erroring. */
export async function getCourseTopics(): Promise<CourseTopic[]> {
  try {
    const d = await get<{ items: CourseTopic[] }>(`${AQ}/courses/topics`);
    return (d.items || []).map((t) => ({
      slug: t.slug, label: t.label, count: t.count ?? 0,
      // Second-level facets (ticket #89) — kept only when the backend sent a populated `subs`, so a
      // house with no sub-subject in the catalogue stays one level (no empty drill-down).
      subs: Array.isArray(t.subs) && t.subs.length
        ? t.subs.map((s) => ({ slug: s.slug, label: s.label, count: s.count ?? 0 }))
        : undefined,
    }));
  } catch { return []; }
}

// (The YouTube view-count history monitor — getVideoHistory / getCourseHistory and their sparkline
//  types — was retired with comment-based trending, 2026-06-13. A course now trends by the discussion
//  it sparks, not passive views, so there is no view series to chart.)

export type CourseDetail = {
  id: number;
  title: string; url: string; start_url: string; resume?: string; excerpt: string; description: string; image: string;
  instructor: string; instructor_avatar: string; instructor_url?: string; instructor_verified?: boolean; updated?: string; updated_ts?: number; category: string;
  // Subject facet: the PRIMARY house slug + label, plus the full multi-discipline list (a course can
  // belong to several academic houses) — both drive the course-page topic/discipline tags.
  topic?: string; topicLabel?: string;
  disciplines?: { key: string; label: string; house: string; houseLabel: string }[];
  level?: string; language?: string;
  lessons_total: number; duration_sec?: number; lessons: { id: number; title: string; url: string; video: string; commentsPerDay: number; done: boolean; complete: boolean; locked: boolean }[];
  is_free: boolean; price: number; currency: string; product_id: number;
  price_display?: string; price_symbol?: string; coin_buy_price?: number; coin_fiat?: string;
  has_access: boolean; logged_in: boolean; bursary_url: string;
};
type CourseDetailR = CourseCardR & {
  summary: string; enrolled: boolean; resume?: string | null;
  // Channel identity for the header (logo / link / verified badge) — empty strings when the
  // backend has no cached meta for this channel, in which case Avatar falls back to the initial.
  channel_url?: string; channel_avatar?: string; channel_verified?: boolean;
  // Course OWNER — the member it was created under (/u/<slug>); the byline renders this.
  author?: { name: string; slug: string; avatar?: string } | null;
  lessons: { id: number; idx: number; title: string; duration: number; video?: string; comments_per_day?: number; done?: boolean; complete?: boolean; locked?: boolean }[];
};
export async function getCourse(slug: string): Promise<CourseDetail | null> {
  try {
    const c = await get<CourseDetailR>(`${AQ}/courses/slug/${encodeURIComponent(slug)}`);
    const lessons = (c.lessons || []).map((l) => ({ id: l.id, title: l.title, url: `/video/?video=${l.id}`, video: l.video || "", commentsPerDay: l.comments_per_day ?? 0, done: !!l.done, complete: !!l.complete, locked: !!l.locked }));
    return {
      id: c.id,
      title: c.title, url: `/courses/${slug}`, start_url: c.resume || lessons[0]?.url || `/courses/${slug}`, resume: c.resume || "",
      excerpt: "", description: c.summary || "", image: c.image,
      // Byline = the course OWNER (the member it was created under, e.g. /u/arash), linked to
      // their profile — NOT the YouTube channel (which used to render here, with an "ArtaQuest"
      // placeholder when empty). Channel identity falls back only if the author is missing.
      instructor: c.author?.name || c.channel || "",
      instructor_avatar: c.author?.avatar || c.channel_avatar || "",
      instructor_url: c.author?.slug ? `/u/${c.author.slug}/` : (c.channel_url || ""),
      instructor_verified: c.author ? false : !!c.channel_verified, category: "",
      topic: c.topic || "", topicLabel: c.topic_label || "",
      disciplines: (c.disciplines || []).map((d) => ({ key: d.key, label: d.label, house: d.house, houseLabel: d.house_label })),
      lessons_total: lessons.length, duration_sec: c.duration, lessons,
      is_free: (c.price ?? 0) <= 0, price: c.price ?? 0, currency: "ARTA", product_id: 0,
      price_display: (c.price ?? 0) > 0 ? `₳${c.price}` : "", price_symbol: "₳",
      has_access: !!c.enrolled, logged_in: isLoggedIn(), bursary_url: "/outreach/",
    };
  } catch { return null; }
}

// A course's section boards for the discussions browse: id/title/slug + each lesson's title +
// discussion comment count (from GET /courses/{id}, public). Read-only; everyone can browse.
export type CourseSections = { id: number; title: string; slug: string; lessons: { id: number; title: string; comments: number; complete: boolean }[] };
export async function getCourseSections(id: number): Promise<CourseSections | null> {
  try {
    const c = await get<{ id: number; title: string; slug: string; lessons?: { id: number; title: string; comments?: number; complete?: boolean }[] }>(`${AQ}/courses/${id}`);
    return { id: c.id, title: c.title, slug: c.slug, lessons: (c.lessons || []).map((l) => ({ id: l.id, title: l.title, comments: l.comments ?? 0, complete: !!l.complete })) };
  } catch { return null; }
}

// Enrol succeeds (ok:true) or the POST throws with the backend message (e.g. a 402 when the learner
// can't afford the entry fee — CourseDetail surfaces it with top-up/bursary links). The old structured
// "short" shape is gone: the paywall now 402s rather than returning a need/have payload.
export type EnrollResult = { ok: boolean; enrolled?: boolean; course?: string };
export async function enrollCourse(slug: string): Promise<EnrollResult> {
  const c = await get<CourseDetailR>(`${AQ}/courses/slug/${encodeURIComponent(slug)}`);
  await post<{ ok: true }>(`${AQ}/enroll`, { course_id: c.id });
  return { ok: true, enrolled: true, course: c.title };
}

// ── Lesson player (discussion-first: watch → comment → upvote) ──────────────────
export type CurriculumItem = { id: number; n: number; title: string; url: string; current: boolean; done: boolean; complete: boolean; locked: boolean };
export type LessonChannel = { name: string; url: string; subs: number; verified: boolean; avatar: string };
export type LessonData = {
  id: number; title: string;
  video: { provider: string; id: string; start: number; upload_ts: number | null };
  channel: LessonChannel | null;
  course: { id: number; title: string; url: string };
  curriculum: CurriculumItem[];
  seg_start: number; seg_end: number;
  // The viewer's engagement with this section: watched the video, left a comment, upvoted a peer.
  locked: boolean; watched: boolean; commented: boolean; upvoted: boolean; engaged: boolean;
};
type YtMeta = { upload_ts: number | null; channel: string; channel_url: string; subs: number; verified: boolean; avatar: string };
type LessonR = {
  id: number; course_id: number; idx: number; title: string; video_type: string; video: string; duration: number;
  seg_start: number; seg_end: number; yt: YtMeta | null;
  locked: boolean; watched: boolean; commented: boolean; upvoted: boolean; engaged: boolean;
};
export async function getLesson(id: number | string): Promise<LessonData | null> {
  try {
    const l = await get<LessonR>(`${AQ}/lessons/${encodeURIComponent(String(id))}`);
    let courseTitle = "", courseSlug = "", curriculum: CurriculumItem[] = [];
    try {
      const c = await get<CourseDetailR>(`${AQ}/courses/${l.course_id}`);
      courseTitle = c.title; courseSlug = c.slug;
      curriculum = (c.lessons || []).map((x, i) => ({
        id: x.id, n: i + 1, title: x.title, url: `/video/?video=${x.id}`, current: x.id === l.id,
        done: !!x.done, complete: !!x.complete, locked: !!x.locked,
      }));
    } catch { /* curriculum optional */ }
    const yt = l.yt;
    return {
      id: l.id, title: l.title,
      // start = the section's segment start in the shared video, so clicking a section
      // seeks the player to that time-section (these lessons are segments of one video).
      video: { provider: l.video_type, id: l.video, start: l.seg_start || 0, upload_ts: yt?.upload_ts ?? null },
      channel: yt && yt.channel
        ? { name: yt.channel, url: yt.channel_url, subs: yt.subs, verified: yt.verified, avatar: yt.avatar }
        : null,
      course: { id: l.course_id, title: courseTitle, url: `/courses/${courseSlug}` },
      curriculum,
      seg_start: l.seg_start || 0, seg_end: l.seg_end || 0,
      locked: !!l.locked, watched: !!l.watched, commented: !!l.commented, upvoted: !!l.upvoted, engaged: !!l.engaged,
    };
  } catch { return null; }
}

/** Heartbeat the learner's real playback position (`at` = seconds into the section) while the video
 *  plays. The SERVER decides when the section is watched (done) — it credits watched-time no faster
 *  than real elapsed time, so seeking/skipping can't complete it. Returns done once the gate is met. */
export async function postWatchProgress(lesson: number, at: number): Promise<{ ok: boolean; done?: boolean; pct?: number; watched?: number; need?: number }> {
  try {
    const j = await post<{ ok: boolean; done: boolean; pct: number; watched: number; need: number }>(`${AQ}/progress`, { lesson_id: lesson, at: Math.max(0, Math.floor(at)) });
    return { ok: j.ok, done: j.done, pct: j.pct, watched: j.watched, need: j.need };
  } catch { return { ok: false }; }
}

// ── Section discussion board (Reddit-style: comment, threaded replies, up/down vote) ────
export type VoteDir = 1 | 0 | -1;
export type SectionComment = {
  id: number; parent: number; body: string; votes: number; my_vote: VoteDir; replies: number;
  mine: boolean; author: string; slug: string; avatar: string; country?: string; at: number;
  children?: SectionComment[]; more_replies?: number;
  flagged?: boolean; bot?: boolean; // ArtaMod: set aside from the competition / ArtaBot's consoling reply
  appealed?: boolean; // the one ArtaMod appeal was used
  anchor?: number;    // seconds into the section video the reply references (0/absent = unanchored)
  ref?: { author: string; avatar: string; likes: number; text: string; url: string } | null; // seed → top YouTube comment
};
export type ThreadSort = "top" | "new";
export type SectionThread = {
  items: SectionComment[]; next: number | null; sort: ThreadSort; total: number;
  mine_commented: boolean; mine_upvoted: boolean; others_exist: boolean; engaged: boolean;
  // Write-gate context: read is public; only enrolled members can post/vote.
  enrolled: boolean; price: number; price_display: string; course_url: string;
};
/** Post a comment (or a threaded reply) to a section's discussion board — POST /section/comment.
 *  `card` is the full server-shaped row, so the board appends it in place without a refetch. */
export async function postSectionComment(lessonId: number, body: string, parentId = 0, anchor = 0): Promise<{ ok: boolean; id: number; pct: number; first: boolean; flagged?: boolean; card?: SectionComment | null }> {
  // anchor = seconds into the video this reply references (the Lesson page captures the live
  // playback position into window.AQ_PLAYER_AT); 0 = unanchored.
  return post(`${AQ}/section/comment`, { lesson_id: lessonId, body, parent_id: parentId, anchor: Math.max(0, Math.floor(anchor)) });
}

/** Appeal an ArtaMod flag on YOUR reply (one appeal per reply) — POST /fearometer/appeal. */
export async function appealFlag(commentId: number, reason: string): Promise<{ ok: boolean; granted: boolean; fear: number }> {
  return post(`${AQ}/fearometer/appeal`, { comment_id: commentId, reason });
}
/** The section's discussion board — keyset-paginated top-level comments (each with its first replies)
 *  + the viewer's engagement state. GET /sections/{id}/thread?sort=&cursor=. */
export async function getSectionThread(lessonId: number, opts: { sort?: ThreadSort; cursor?: number } = {}): Promise<SectionThread> {
  const qs = new URLSearchParams();
  if (opts.sort) qs.set("sort", opts.sort);
  if (opts.cursor) qs.set("cursor", String(opts.cursor));
  try { return await get<SectionThread>(`${AQ}/sections/${lessonId}/thread${qs.toString() ? `?${qs}` : ""}`); }
  catch { return { items: [], next: null, sort: opts.sort ?? "top", total: 0, mine_commented: false, mine_upvoted: false, others_exist: false, engaged: false, enrolled: false, price: 0, price_display: "", course_url: "/courses/" }; }
}
/** Load more replies for one comment (keyset, oldest-first) — GET /sections/{id}/thread?parent=&cursor=. */
export async function getMoreReplies(lessonId: number, parentId: number, cursor = 0): Promise<{ items: SectionComment[]; next: number | null }> {
  const qs = new URLSearchParams({ parent: String(parentId) });
  if (cursor) qs.set("cursor", String(cursor));
  try { return await get<{ items: SectionComment[]; next: number | null }>(`${AQ}/sections/${lessonId}/thread?${qs}`); }
  catch { return { items: [], next: null }; }
}
/** Reddit-style up/down vote on a peer's comment — POST /comment/vote. dir: 1 up · -1 down · 0 clear. */
export async function voteSectionComment(commentId: number, dir: VoteDir): Promise<{ ok: boolean; my_vote: VoteDir; votes: number; pct: number }> {
  return post(`${AQ}/comment/vote`, { comment_id: commentId, dir });
}

// ── Course rankings (Kaggle-style: ranked by reply upvotes, medals, reward pool) ─
export type CourseRankRow = { rank: number; medal: "gold" | "silver" | "bronze" | ""; name: string; slug: string; avatar: string; country?: string; votes: number; questions: number; certified: boolean; prize: number; reward: number };
export type SeasonOption = { key: number; label: string; current: boolean };
export type CourseRankings = {
  course: string; slug: string; enrolled: number; min_enrol: number; eligible: boolean;
  revenue: number; pool: number; share_pct: number; split: number[]; paid: number;
  // Competition season: the current window's deadline + the dropdown of seasons (current + archived).
  reset_at: number; reset_label: string; closes_in: number;
  season_key: number; season_label: string; archived: boolean; seasons: SeasonOption[];
  items: CourseRankRow[];
};
export async function getCourseRankings(courseId: number, season?: number): Promise<CourseRankings | null> {
  try { return await get<CourseRankings>(`${AQ}/courses/${courseId}/rankings${season ? `?season=${season}` : ""}`); }
  catch { return null; }
}

// The course's discussion-rate history: each point is the AVERAGE of its videos' own trailing-24h
// comment rates at that hour ("X/day"), plus the running comment total and the current headline rate
// (matching the catalogue card; ticket #95). Powers the course-header graph (GET .../comment-stats).
// null on failure so the header simply renders without the graph rather than erroring.
export type CommentRatePoint = { day: number; rate: number };
// Each video's own line, returned by the course endpoint on the SAME shared grid as the course
// average — so the course header chart and every per-section sparkline have identical start/end points.
export type CourseVideoSeries = { video: string; perDay: number; points: CommentRatePoint[] };
export type CourseCommentHistory = { total: number; perDay: number; points: CommentRatePoint[]; videos: CourseVideoSeries[] };
export async function getCourseCommentHistory(courseId: number, days = 90): Promise<CourseCommentHistory | null> {
  try {
    const d = await get<{ total?: number; per_day?: number; points?: { day: number; rate: number }[]; videos?: { video: string; per_day?: number; points?: { day: number; rate: number }[] }[] }>(
      `${AQ}/courses/${courseId}/comment-stats${days !== 90 ? `?days=${days}` : ""}`);
    return {
      total: d.total ?? 0, perDay: d.per_day ?? 0,
      points: (d.points || []).map((p) => ({ day: +p.day, rate: +p.rate })),
      videos: (d.videos || []).map((v) => ({ video: String(v.video), perDay: v.per_day ?? 0, points: (v.points || []).map((p) => ({ day: +p.day, rate: +p.rate })) })),
    };
  } catch { return null; }
}

// One VIDEO's own discussion-rate history — its trailing-24h comment rate over time — for the
// per-section sparkline (GET /videos/{vid}/comment-stats). Same shape as the course history minus the id.
export type VideoCommentHistory = { perDay: number; total: number; points: CommentRatePoint[] };
export async function getVideoCommentStats(video: string, days = 90): Promise<VideoCommentHistory | null> {
  try {
    const d = await get<{ per_day?: number; total?: number; points?: { day: number; rate: number }[] }>(
      `${AQ}/videos/${encodeURIComponent(video)}/comment-stats${days !== 90 ? `?days=${days}` : ""}`);
    return { perDay: d.per_day ?? 0, total: d.total ?? 0, points: (d.points || []).map((p) => ({ day: +p.day, rate: +p.rate })) };
  } catch { return null; }
}

// ── Profiles ──────────────────────────────────────────────────────────────────
/** The networks a member may list, in the order a profile shows them. Mirrors AQ\Auth::LINKS —
 *  add a key there first; anything unknown is dropped by the server rather than stored. */
export const PROFILE_LINKS = [
  ["website", "Website"], ["github", "GitHub"], ["scholar", "Google Scholar"], ["orcid", "ORCID"],
  ["linkedin", "LinkedIn"], ["x", "X"], ["mastodon", "Mastodon"],
] as const;
export type ProfileLinkKey = (typeof PROFILE_LINKS)[number][0];

/** Relationship options, in the order the picker lists them. MIRRORS `AQ\Auth::RELATIONSHIPS` —
 *  the server refuses any key not in its own copy, so the two lists must not drift. The empty key
 *  is deliberately absent: "not saying" is the ABSENCE of a value, not an option with a label. */
export const RELATIONSHIPS = [
  ["single", "Single"], ["relationship", "In a relationship"], ["engaged", "Engaged"],
  ["married", "Married"], ["partnership", "In a civil partnership"], ["open", "In an open relationship"],
  ["complicated", "It\u2019s complicated"], ["separated", "Separated"], ["divorced", "Divorced"],
  ["widowed", "Widowed"],
] as const;
export type RelationshipKey = (typeof RELATIONSHIPS)[number][0];
/** '' for anything unknown, so a junk value stored by hand renders as nothing rather than as text. */
export const relationshipLabel = (k?: string): string =>
  RELATIONSHIPS.find(([key]) => key === k)?.[1] ?? "";
/** Matches AQ\Auth::LOCATION_MAX — a city, not an address. */
export const LOCATION_MAX = 60;
/** Matches AQ\Auth::LANGS_MAX — how many languages a member may claim. */
export const LANGS_MAX = 8;

/** One language on a profile, as the server resolved it. */
export type ProfileLang = { code: string; name: string; native: string; dir: "ltr" | "rtl" };

export type ProfileStats = { threads: number; comments: number; reviews: number; enrolled: number; followers: number; following: number };
export type ProfileThread = { id: number; title: string; comments: number; score: number; at: number; topic?: string; excerpt?: string };
export type Profile = {
  id: number;
  name: string; slug: string; avatar: string; bio: string; email: string;
  /** Where else this member is. Keys are AQ\Auth::LINKS; every value is an absolute https URL,
   *  host-checked server-side at save time, so a renderer may link it without re-validating. */
  links?: Partial<Record<ProfileLinkKey, string>>;
  /** UTC midnight of the day they were last around; 0 when never recorded. Day-granular by
   *  design — render it with lastSeenLabel(), never relAgo(). */
  lastSeen?: number;
  country?: string; // verified nationality (ISO alpha-2) → avatar flag; '' until verified
  // Public identity facts (radical transparency — the same values the /data/ explorer serves, and
  // required of every member at signup).
  //
  // `age` is the PUBLIC one — whole years, from the server. `birthday` is the EXACT date and now
  // arrives ONLY on your own profile (and for operators); it is '' for every other viewer, so a
  // component that renders it is automatically own-only. See Verify::age() for why.
  age?: number;
  birthday?: string;
  fullName?: string;
  verified?: boolean; // the blue check (Verify::is_verified)
  season?: number; // the ONE season this member follows (1…12 cycle position; 0 = none on record)
  palm?: string; // opt-in palm "back photo" (ticket #94) → the avatar flips to it; '' if unset
  nationality?: string; // self-entered nationality claim (ISO alpha-2) → header flag detail; '' if unset (shown unverified, like the birthday)
  /** Self-declared, both. `relationship` is a RELATIONSHIPS key ('' = not saying); `location` is
   *  whatever the member typed and is NEVER inferred from an IP address (see AQ\Auth::location). */
  relationship?: string;
  location?: string;
  /** Languages the member says they speak, RESOLVED SERVER-SIDE (AQ\I18n::language_meta) so the
   *  page never depends on window.AQ_I18N to name one. Member's own order; we collect no fluency,
   *  so the order implies nothing. */
  languages?: ProfileLang[];
  coins: number; points: number; breakdown: PointBreakdown;
  tier: string; joined: string; completed?: number;
  typologies?: TypologyTag[];
  endorsements?: Record<string, number>; // public peer-endorsement counts, keyed `systemKey:key`
  stats?: ProfileStats;
  isFollowing?: boolean;
  recentThreads?: ProfileThread[];
  // Creator-ladder rank ('' when not a creator) + the member's published courses — public.
  creatorTier?: string;
  coursesTotal?: number;
  courses?: ProfileCourse[];
  // Courses the member has completed (earned the certificate) — public, mirrors the `completed` count.
  completedCourses?: ProfileCourse[];
  // Typology topics the member authored (aq_topics.author_id) — public, shown like their courses (#127).
  topicsCreated?: ProfileTopic[];
  topicsTotal?: number;
  // Published Journal of Seasonality articles (accepted submissions) — public, shown like courses/topics.
  research?: ProfileArticle[];
  researchTotal?: number;
  // Books published via ArtaPublishing (author-owned original works) — public, shown like courses/topics.
  books?: ProfileBook[];
  booksTotal?: number;
  // Tracks (ArtaSound) + Animations (ArtaMotion) the member published — public.
  tracks?: ProfileTrack[];
  tracksTotal?: number;
  animations?: ProfileAnimation[];
  animationsTotal?: number;
  films?: ProfileFilm[];
  filmsTotal?: number;
  illustrations?: ProfileIllustration[];
  illustrationsTotal?: number;
};
export type ProfileArticle = { id: number; title: string; doi?: string; colab_url?: string; kaggle_url?: string; created: number };
export type ProfileBook = { id: number; slug: string; title: string; summary: string; thumb: string; pages: number; views: number; created: number };
export type ProfileTrack = { id: number; slug: string; title: string; summary: string; cover: string; seconds: number; plays: number; created: number };
export type ProfileAnimation = { id: number; slug: string; title: string; summary: string; poster: string; seconds: number; plays: number; created: number };
export type ProfileFilm = { id: number; slug: string; title: string; summary: string; poster: string; seconds: number; plays: number; created: number };
export type ProfileIllustration = { id: number; slug: string; title: string; summary: string; image: string; kind: string; rounds: number; views: number; created: number };
export type ProfileCourse = { id: number; slug: string; title: string; image: string; lessons: number; price: number; comments_per_day: number };
// One authored-topic card on a profile: the typology system's key (→ /topics/<key>/), name, category,
// status, and raw image ('' → the card falls back to the on-brand emblem, same as the Topics page).
export type ProfileTopic = { key: string; name: string; category: string; status: string; image: string };
type ProfileR = {
  id: number; name: string; slug: string; avatar: string; palm?: string; country?: string; nationality?: string; email?: string; points: number; tier: string;
  /** Whole years, computed server-side (Verify::age). The public profile publishes THIS; the
   *  exact `birthday` below now arrives only on your OWN profile. 0 = no valid date on record. */
  age?: number;
  birthday?: string; full_name?: string; season?: number; verified?: boolean;
  links?: Partial<Record<ProfileLinkKey, string>>;
  last_seen?: number;
  // Self-declared, both. Added to the endpoint 2026-08-10; they must be listed HERE and mapped in
  // getProfile below, or the SPA silently drops them exactly as it once dropped the birthday.
  relationship?: string;
  location?: string;
  languages?: ProfileLang[];
  coins?: number; joined?: string; bio?: string; completed?: number; breakdown?: TrackPoints;
  typologies?: TypologyTag[]; endorsements?: Record<string, number>; stats?: ProfileStats; is_following?: boolean;
  recent_threads?: ProfileThread[];
  creator_tier?: string; courses_total?: number; courses?: ProfileCourse[]; completed_courses?: ProfileCourse[];
  topics_created?: ProfileTopic[]; topics_total?: number;
  research?: ProfileArticle[]; research_total?: number;
  books?: ProfileBook[]; books_total?: number;
  tracks?: ProfileTrack[]; tracks_total?: number;
  animations?: ProfileAnimation[]; animations_total?: number;
  films?: ProfileFilm[]; films_total?: number;
  illustrations?: ProfileIllustration[]; illustrations_total?: number;
};
/** Follow / unfollow a member (POST /follow). */
export async function followUser(targetId: number, on: boolean): Promise<{ ok: boolean; following: boolean }> {
  return post(`${AQ}/follow`, { target_id: targetId, on: on ? 1 : 0 });
}
/** One row of a followers / following list — the standard public member card + when the follow happened. */
export type FollowRow = { name: string; slug: string; avatar: string; country?: string; verified?: boolean; at: number };
/** A page of who follows a member (dir=followers) or who they follow (dir=following) — GET
 *  /profile/follows, keyset cursor on the follow time. null = the request failed (distinct from
 *  an empty list, so the profile's list dialog can say "couldn't load" instead of "no followers"). */
export async function getFollows(slug: string, dir: "followers" | "following", cursor = 0): Promise<{ items: FollowRow[]; next: number | null } | null> {
  const qs = new URLSearchParams({ slug, dir });
  if (cursor) qs.set("cursor", String(cursor));
  try { return await get<{ items: FollowRow[]; next: number | null }>(`${AQ}/profile/follows?${qs}`); }
  catch { return null; }
}
/** The tags of one member the signed-in viewer has endorsed (GET /typology/endorsements). */
export async function getMyEndorsements(targetId: number): Promise<string[]> {
  try {
    const d = await get<{ tags: string[] }>(`${AQ}/typology/endorsements?target_id=${targetId}`);
    return d.tags ?? [];
  } catch { return []; }
}
/** Endorse / withdraw an endorsement of a member's identity tag (POST /typology/endorse). */
export async function endorseTag(targetId: number, tag: string, on: boolean): Promise<{ ok: boolean; endorsed: boolean; count: number }> {
  return post(`${AQ}/typology/endorse`, { target_id: targetId, tag, on: on ? 1 : 0 });
}
export async function getProfile(slug: string): Promise<Profile | null> {
  // The public /profile endpoint carries the full public picture — identity, standing, wallet
  // balance, typology tags, activity stats, recent threads, follow state. ArtaQuest is radically
  // transparent (the whole DB is public via /data/), so the wallet is public too. Two fields are
  // NOT: `email` and the exact `birthday` come back only on your own profile — see Verify::age().
  try {
    const pr = await get<ProfileR>(`${AQ}/profile?slug=${encodeURIComponent(slug)}`);
    return {
      id: pr.id, name: pr.name, slug: pr.slug, avatar: pr.avatar, palm: pr.palm || "", email: pr.email || "", bio: pr.bio || "", links: pr.links || undefined, lastSeen: pr.last_seen || 0,
      // Public identity facts the endpoint has always emitted but the SPA used to drop on the floor.
      age: pr.age ?? 0, birthday: pr.birthday || "", fullName: pr.full_name || "", season: pr.season ?? 0, verified: !!pr.verified,
      relationship: pr.relationship || "", location: pr.location || "", languages: pr.languages ?? [],
      coins: pr.coins ?? 0, points: pr.points, completed: pr.completed ?? 0,
      breakdown: { ...ZERO_TRACKS, ...pr.breakdown, total: pr.points },
      tier: pr.tier, joined: pr.joined || "",
      typologies: pr.typologies ?? [],
      endorsements: pr.endorsements ?? {},
      stats: pr.stats,
      isFollowing: !!pr.is_following,
      recentThreads: pr.recent_threads ?? [],
      creatorTier: pr.creator_tier || "",
      coursesTotal: pr.courses_total ?? 0,
      courses: pr.courses ?? [],
      completedCourses: pr.completed_courses ?? [],
      topicsCreated: pr.topics_created ?? [],
      topicsTotal: pr.topics_total ?? 0,
      research: pr.research ?? [],
      researchTotal: pr.research_total ?? 0,
      books: pr.books ?? [],
      booksTotal: pr.books_total ?? 0,
      tracks: pr.tracks ?? [],
      tracksTotal: pr.tracks_total ?? 0,
      animations: pr.animations ?? [],
      animationsTotal: pr.animations_total ?? 0,
      films: pr.films ?? [],
      filmsTotal: pr.films_total ?? 0,
      illustrations: pr.illustrations ?? [],
      illustrationsTotal: pr.illustrations_total ?? 0,
    };
  } catch { return null; }
}

// ── Rankings ──────────────────────────────────────────────────────────────────
export type RankRow = { rank: number; name: string; points: number; tier: string; avatar: string; country: string; profile_url: string; joined: string };
export async function getRankings(category = "all"): Promise<RankRow[]> {
  try {
    const d = await get<{ items: { rank: number; name: string; slug: string; points: number; tier: string; avatar?: string; country?: string; joined?: string }[] }>(`${AQ}/leaderboard?track=${encodeURIComponent(category)}`);
    return (d.items || []).map((r) => ({
      rank: r.rank, name: r.name, points: r.points, tier: r.tier,
      avatar: r.avatar || "", country: r.country || "", profile_url: `/u/${r.slug}`, joined: r.joined || "",
    }));
  } catch { return []; }
}

// ── Arta Coin reserve (read-only; degraded until the FX layer is rebuilt) ─────
export type ReservePoint = { ts: number; spot: number; buy: number; sell: number };
export type Reserve = {
  symbol: string; code: string; name: string; peg: string;
  supply: number; reserve_mg: number; backing_ratio: number; fully_backed: boolean;
  reserve_value: number; gold_oz_usd: number; fiat: string; spread: number; spread_total: number;
  spot: number; buy: number; sell: number; updated: number; history: ReservePoint[];
  payments: boolean; // Stripe configured → buying coins is live; the Wallet gates the Buy form on this
  cashout: boolean; // false until a real fiat payout rail exists — the Wallet gates cash-out on this
  // THE HONEST HALF. /reserve has published these since 2026-08-11 and this mapper dropped all four,
  // so the two oldest money pages could only ever render the flattering version of the story: coin
  // issued to settle a director's advance is backed by NOTHING, because that cash went to a supplier
  // instead of into the vault. `backed` is the server's own verdict — never re-derive it from a ratio
  // here, and never substitute a default for it.
  backed: boolean;
  shortfall_mg: number;            // issued coins that no gold stands behind
  authorised_shortfall_mg: number; // …of which this much is the disclosed, board-authorised tranche
  shortfall_note: string;          // the server's plain-English explanation; render it verbatim
};

// ── Wallet (the signed-in user's balances + recent ledger activity) ──────────
export type WalletTxn = { delta: number; reason: string; ref: string; at: number };
export type WalletData = { coins: number; points: number; tier: string; ledger: WalletTxn[] };
export async function getWallet(): Promise<WalletData | null> {
  try {
    const w = await get<{ coins: number; points: number; tier: string; ledger?: WalletTxn[] }>(`${AQ}/wallet`);
    return { coins: w.coins, points: w.points, tier: w.tier, ledger: w.ledger || [] };
  } catch { return null; }
}
export async function getReserve(): Promise<Reserve | null> {
  try {
    const r = await get<{ issued_coins: number; backing_mg: number; ratio: number; backed?: boolean; shortfall_mg?: number; authorised_shortfall_mg?: number; shortfall_note?: string; fiat?: string; spot?: number; buy?: number; sell?: number; spread?: number; gold_oz_usd?: number; updated?: number; payments?: boolean; cashout?: boolean; history?: ReservePoint[] }>(`${AQ}/reserve`);
    return {
      symbol: "₳", code: "ARTA", name: "Arta Coin", peg: "1 ₳ = 1 mg gold",
      // `?? 0`, NEVER `|| 0` and never a default of 1: a ratio of 0 is a REAL, publishable answer, and
      // the falsy-coalesce that used to sit downstream of this turned it into a perfect 100%.
      supply: r.issued_coins, reserve_mg: r.backing_mg, backing_ratio: r.ratio ?? 0,
      // Trust the server's verdict; `ratio >= 1` was a local re-derivation that disagreed with it the
      // moment the server learned about an authorised shortfall.
      fully_backed: r.backed ?? (r.ratio ?? 0) >= 1,
      backed: r.backed ?? (r.ratio ?? 0) >= 1,
      shortfall_mg: r.shortfall_mg ?? 0,
      authorised_shortfall_mg: r.authorised_shortfall_mg ?? 0,
      shortfall_note: r.shortfall_note ?? "",
      // Fiat worth of the gold held = milligrams reserved × the per-mg spot price (1 coin = 1 mg), so
      // the Reserve page's "Reserve value" reflects the vault instead of a hardcoded 0.
      reserve_value: r.backing_mg * (r.spot ?? 0), gold_oz_usd: r.gold_oz_usd ?? 0, fiat: r.fiat || "CAD", spread: r.spread ?? 0, spread_total: (r.spread ?? 0) * 2,
      spot: r.spot ?? 0, buy: r.buy ?? 0, sell: r.sell ?? 0, updated: r.updated ?? 0,
      // Price-over-time series for the Reserve chart (oldest→newest). Coerce to numbers so the SVG
      // maths is safe even if the JSON arrives stringified; absent/short series → chart placeholder.
      history: Array.isArray(r.history) ? r.history.map((p) => ({ ts: +p.ts, spot: +p.spot, buy: +p.buy, sell: +p.sell })) : [],
      payments: r.payments ?? false,
      cashout: r.cashout ?? false,
    };
  } catch { return null; }
}

export const aqCountry = aqCountryId; // re-export to keep geo import live

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY DEGRADED STUBS — features whose backend was retired in the lean redesign
// (coin FX buy/sell, bursary, creator analytics, typology donation targets, comment
// edit/delete, cross-user profiles) — now all rebuilt on the new plugin and wired below.
// ─────────────────────────────────────────────────────────────────────────────

/** Whether the fiat payment/checkout layer is live. The lean redesign retired it (no buy/sell
 *  endpoints; Funds::donate has no payment verification; the old /enroll + /cart checkout pages
 *  are gone), so pages show honest "being rebuilt" states instead of CTAs that dead-end or mint
 *  unpaid coins. Flip to true once the payment endpoints + a real gateway list exist. */
// Payment/FX + community features are now live on the new plugin.
export const CHECKOUT_LIVE: boolean = true;

export type DistCountry = { code: string; key?: string; id?: number; label: string; amount: number; pct: number };
export type TypologyTargetType = { key: string; label: string; short: string; count: number; raised: number };
export type TypologyTargetSystem = { key: string; name: string; category: string; total: number; types: TypologyTargetType[] };
export type TypologyTargets = { systems: TypologyTargetSystem[]; symbol: string };
/** Communities members self-identify with, for the donation target picker (GET /typology/targets). */
export async function getTypologyTargets(): Promise<TypologyTargets> {
  try { return await get<TypologyTargets>(`${AQ}/typology/targets`); }
  catch { return { systems: [], symbol: "₳" }; }
}

/** A topic a donor can SPONSOR — its gift funds that topic's course prize pool (GET /sponsor/topics). */
export type SponsorableTopic = { key: string; name: string; course: string };
export async function getSponsorableTopics(): Promise<SponsorableTopic[]> {
  try { return (await get<{ items: SponsorableTopic[] }>(`${AQ}/sponsor/topics`)).items || []; }
  catch { return []; }
}

export type BuyCoinsResult = { ok: boolean; coins: number; order: string; total: number; total_display: string; gateway: string; instructions?: string; url?: string; redirect?: boolean; message?: string };
export type SellCoinsResult = { ok: boolean; coins: number; payout: number; currency: string; balance: number; message: string; error?: string };
export type PayoutStatus = { cashout_enabled: boolean; connected: boolean; payouts_enabled: boolean; balance: number; sell_price: number; currency: string };
/** Buy Arta Coins with fiat (amount in CAD) — POST /coins/buy. */
export async function buyCoins(amount: number, gateway: string, email: string): Promise<BuyCoinsResult> {
  return post<BuyCoinsResult>(`${AQ}/coins/buy`, { amount, gateway, email });
}
/** Cash out Arta Coins for fiat — POST /coins/sell. Returns the error CODE in `error` (no throw) so the
 *  UI can branch on `needs_onboarding` and route the member through Stripe payout setup. */
export async function sellCoins(coins: number): Promise<SellCoinsResult> {
  const r = await fetch(`${BASE}${AQ}/coins/sell`, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json", ...(NONCE ? { "X-WP-Nonce": NONCE } : {}) },
    body: JSON.stringify({ coins }),
  });
  const j = (await r.json().catch(() => ({}))) as SellCoinsResult & { error?: string; message?: string };
  if (!r.ok) return { ok: false, coins: 0, payout: 0, currency: "CAD", balance: 0, message: j.message || "Could not cash out.", error: j.error || `${r.status}` };
  return j;
}
/** Where the member stands on cash-out: rail live? connected account? payouts enabled? — GET /coins/payout/status. */
export async function getPayoutStatus(): Promise<PayoutStatus | null> {
  try { return await get<PayoutStatus>(`${AQ}/coins/payout/status`); }
  catch { return null; }
}
/** Start/resume Stripe Express payout onboarding — POST /coins/payout/connect → { url } to redirect to. */
export async function connectPayout(): Promise<{ ok: boolean; url?: string; message?: string }> {
  try { return await post<{ ok: boolean; url?: string }>(`${AQ}/coins/payout/connect`, {}); }
  catch (e) { return { ok: false, message: e instanceof Error ? e.message : "Could not start payout setup." }; }
}

export async function updateDiscComment(id: string, body: string): Promise<{ ok: boolean; id: string; body_html: string }> {
  const j = await post<{ ok: boolean; id: string; body_html: string }>(`${AQ}/comments/${encodeURIComponent(id)}/update`, { body });
  return { ...j, body_html: renderRich(body) };
}
export async function deleteDiscComment(id: string): Promise<{ ok: boolean; id: string; soft: boolean }> {
  return post(`${AQ}/comments/${encodeURIComponent(id)}/delete`, {});
}
export async function updateDiscThread(id: string, title: string, body: string): Promise<{ ok: boolean; id: string; title: string; body_html: string }> {
  const j = await post<{ ok: boolean; id: string; title: string; body_html: string }>(`${AQ}/threads/${encodeURIComponent(id)}/update`, { title, body });
  return { ...j, body_html: renderRich(body) };
}
export async function deleteDiscThread(id: string): Promise<{ ok: boolean; id: string; redirect: string }> {
  return post(`${AQ}/threads/${encodeURIComponent(id)}/delete`, {});
}

// ─────────────────────────────────────────────────────────────────────────────
// RESTORED PAGES — bridge functions for Typology, Outreach, Issues, Careers, Data,
// Pricing, Checkout, Certificate (all served by the plugin's Extra domain).
// ─────────────────────────────────────────────────────────────────────────────

// Typology self-identification. Tagging rights are effort-modulated: a member may publicly stand with
// as many groups as they have lifetime points (1-to-1) — `allowance` is that cap, `points` their standing.
export type MyTypologies = { selections: Selections; allowance: number; points: number };
export async function getMyTypologies(): Promise<MyTypologies> {
  try {
    const d = await get<{ selections: Selections; allowance?: number; points?: number }>(`${AQ}/typologies`);
    return { selections: d.selections ?? {}, allowance: d.allowance ?? 0, points: d.points ?? 0 };
  } catch { return { selections: {}, allowance: 0, points: 0 }; }
}
export type SaveTypologiesResult = { ok: boolean; count: number; allowance?: number; points?: number; error?: string; message?: string };
export async function saveMyTypologies(selections: Selections, tags: TypologyTag[]): Promise<SaveTypologiesResult> {
  const r = await fetch(`${BASE}${AQ}/typologies`, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json", ...(NONCE ? { "X-WP-Nonce": NONCE } : {}) },
    body: JSON.stringify({ selections, tags }),
  });
  const j = (await r.json().catch(() => ({}))) as SaveTypologiesResult;
  if (!r.ok) return { ok: false, count: tags.length, error: j.error || `${r.status}`, message: j.message || "Could not save — please try again", allowance: j.allowance };
  return j;
}

// Outreach grants
export type OutreachMember = { slug: string; name: string; avatar: string; country?: string; status: string; at: number };
export type OutreachMeeting = { reminder_key: string; start: number; end: number; meet_url: string };
export type OutreachGrant = {
  id: number; slug: string; title: string; funder: string; url: string;
  country: string; category: string; amount_display: string; amount_cad: number;
  deadline: string; deadline_type: string; estimated: boolean;
  eligibility_ca: string; eligibility_intl: string; allows_regranting: string;
  fit: number; confidence: string; capacity: number; taken: number; slots_left: number;
  points: number; summary: string; red_flags: string; gcal_url: string;
  members: OutreachMember[]; meetings: OutreachMeeting[];
  my_status: null | "claimed" | "submitted" | "verified" | "released" | "rejected";
  // An industry partner (a sponsor that funds work directly), not a charitable grant — the page badges
  // these distinctly and lets visitors filter by kind. `author` = the member who curated the listing.
  is_sponsor: boolean;
  author?: { id: number; name: string; slug: string };
};
export type OutreachData = {
  grants: OutreachGrant[]; count: number; total_registered: number;
  logged_in: boolean; meet_enabled: boolean; ics_url: string;
};
export async function getOutreach(): Promise<OutreachData> {
  try { return await get<OutreachData>(`${AQ}/outreach`); }
  catch { return { grants: [], count: 0, total_registered: 0, logged_in: false, meet_enabled: false, ics_url: "" }; }
}
async function outreachPost(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  try { return await post(`${AQ}${path}`, body); } catch (e) { return { ok: false, error: (e as Error).message }; }
}
export const claimGrant = (grant: number) => outreachPost("/outreach/claim", { grant });
export const submitGrant = (grant: number, note: string, ref: string) => outreachPost("/outreach/submit", { grant, note, ref });
export const releaseGrant = (grant: number) => outreachPost("/outreach/release", { grant });

// Creator ladder
export type CreatorCaps = { can_create?: boolean; needs_playlist_approval?: boolean; can_edit_content?: boolean; needs_channel_approval?: boolean; can_upload_any?: boolean };
export type CreatorTier = { key: string; label: string; share: number; points: number; coins?: number; caps: CreatorCaps; blurb: string };
export async function getCreatorLadder(): Promise<CreatorTier[]> {
  try { return (await get<{ tiers: CreatorTier[] }>(`${AQ}/creator/ladder`)).tiers; } catch { return []; }
}
export type CreatorSubmission = { id: number; url?: string; channel?: string; status: "pending" | "approved" | "rejected"; date?: number };
export type CreatorStatus = {
  points: number; breakdown: PointBreakdown; coins: number; symbol: string;
  tier: string; tier_key: string; share: number;
  caps: CreatorCaps; operator?: boolean; next_tier: string | null; next_at: number; submissions: CreatorSubmission[];
};
export async function getCreatorStatus(): Promise<CreatorStatus | null> {
  try { const d = await get<Omit<CreatorStatus, "breakdown"> & { breakdown: TrackPoints }>(`${AQ}/creator/status`); return { ...d, breakdown: { ...ZERO_TRACKS, ...d.breakdown, total: d.points } }; }
  catch { return null; }
}
export async function submitPlaylist(url: string, channel: string): Promise<{ ok: boolean; id: number; status: "pending" | "approved"; needs_playlist_approval: boolean; needs_channel_approval: boolean; message: string }> {
  return post(`${AQ}/creator/submit-playlist`, { url, channel });
}

// Public database explorer
export type DbTable = { name: string; label: string; desc: string; rows: number };
export type DbTableList = { tables: DbTable[]; note: string };
export type DbRow = Record<string, string | number | null>;
export type DbRows = { table: string; label: string; columns: string[]; rows: DbRow[]; total: number; page: number; pages: number; per: number };
export async function getDbTables(): Promise<DbTableList> {
  try { return await get<DbTableList>(`${AQ}/db`); } catch { return { tables: [], note: "" }; }
}
export async function getDbRows(table: string, page = 1): Promise<DbRows | null> {
  try { return await get<DbRows>(`${AQ}/db?table=${encodeURIComponent(table)}&page=${page}`); } catch { return null; }
}

// Arta Coin world price map
export type CoinWorldCountry = { code: string; iso3: string; name: string; currency: string; buy: number; sell: number };
export type CoinWorld = { symbol: string; peg: string; gold_oz_usd: number; spot_usd: number; base_fiat: string; buy_base: number; sell_base: number; spread: number; you?: string; countries: CoinWorldCountry[] };
export async function getCoinWorld(): Promise<CoinWorld | null> {
  try { return await get<CoinWorld>(`${AQ}/coin-world`); } catch { return null; }
}

// Certificates
export type Medal = "gold" | "silver" | "bronze" | "";
export type Cert = {
  earned: boolean; course: string;
  progress?: number; threshold?: number; course_url?: string;
  learner?: string; date_ts?: number; code?: string; course_id?: number;
  // Verification + podium medal (present on earned / verified certificates)
  valid?: boolean; verify_url?: string;
  medal?: Medal; rank?: number; votes?: number; prize?: number; reward?: number;
};
export async function getCertificate(course: number): Promise<Cert | null> {
  try { return await get<Cert>(`${AQ}/certificate?course=${course}`); } catch { return null; }
}
/** Public authenticity check for a shared/printed certificate (the /verify QR + code resolve here). */
export async function verifyCertificate(c: number, u: number, k: string): Promise<Cert | null> {
  try { return await get<Cert>(`${AQ}/cert-verify?c=${c}&u=${u}&k=${encodeURIComponent(k)}`); } catch { return null; }
}

// Course checkout (charges the entry fee → enrolment) + Stripe verify
export type CheckoutResult = { ok: boolean; already?: boolean; order?: string; total?: number; currency?: string; total_display?: string; course: string; items?: string[]; gateway?: string; instructions?: string; url?: string; redirect?: boolean };
/** A donation's ArtaCredits targeting — the slice of the membership whose challenge entry fees this
 *  gift will cover. Every axis is optional; omitting one means "no preference" on it. */
export type DonationCredit = { country?: string; gender?: string; band?: string; fee_cap?: number; name?: string };
export async function postCourseCheckout(body: { slug?: string; slugs?: string[]; donations?: { amount: number; countries?: string[]; groups?: string[]; credit?: DonationCredit }[]; email: string; name: string; gateway: string }): Promise<CheckoutResult> {
  return post(`${AQ}/course-checkout`, { ...body, country: aqCountryId() });
}
export type StripeVerify = { ok: boolean; paid: boolean; order: string; course: string; total: number };
export async function getStripeVerify(session: string): Promise<StripeVerify | null> {
  try { return await get<StripeVerify>(`${AQ}/stripe-verify?session=${encodeURIComponent(session)}`); } catch { return null; }
}

// ── Course reviews + course discussions (CourseDetail tabs) ──────────────────
export type CourseReview = { author: string; slug: string; avatar: string; country?: string; rating: number; body: string; at: number };
export type CourseReviews = { average: number; count: number; can_review: boolean; mine: { rating: number; body: string } | null; items: CourseReview[] };
export async function getCourseReviews(courseId: number): Promise<CourseReviews> {
  try { return await get<CourseReviews>(`${AQ}/courses/${courseId}/reviews`); }
  catch { return { average: 0, count: 0, can_review: false, mine: null, items: [] }; }
}
export async function postCourseReview(courseId: number, rating: number, body: string): Promise<{ ok: boolean; average: number; count: number }> {
  return post(`${AQ}/courses/${courseId}/review`, { rating, body });
}

/** A course's discussion threads = global threads tagged with the course topic. */
export async function getCourseThreads(courseId: number): Promise<Thread[]> {
  try {
    const d = await get<{ items: ThreadCardR[] }>(`${AQ}/threads?topic=course-${courseId}`);
    return (d.items || []).map((t) => ({
      slug: String(t.id), title: t.title, excerpt: "", author: t.author,
      votes: t.score, replies: t.comments, views: 0, last_at: relAgo(t.at), last_by: t.author,
      // Query-param form — the /discussions router resolves a thread ONLY from ?thread= (a
      // path-segment form like /discussions/course-1/2 lands on the boards page instead).
      pinned: false, url: `/discussions/?forum=course-${courseId}&thread=${t.id}`, lang: t.lang,
    }));
  } catch { return []; }
}
export async function postCourseThread(courseId: number, title: string, body: string): Promise<{ id: number }> {
  return post(`${AQ}/threads`, { title, body, topic: `course-${courseId}`, lang: uiLang() });
}
