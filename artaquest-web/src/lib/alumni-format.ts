/**
 * ArtaSearch detail-panel formatting (1.25.19, Arash 2026-10-27 "also improve the UI").
 * Pure functions only, so they can be checked without a browser (scripts/check-alumni-format.mjs).
 * Raw values stay available as tooltips; nothing here hides or invents data.
 */

/** Lower-case, accent-free, single-spaced — for comparing names typed with or without Turkish letters. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i").toLowerCase().replace(/\s+/g, " ").trim();
}

const SITE_SUFFIX = /\s*(?:[|·•\-–—]\s*)(?:LinkedIn|Instagram(?: photos and videos)?|Facebook|GitHub|YouTube|X|Twitter|ResearchGate|Strava|Bluesky|Spotify|TikTok)\s*$/i;

/**
 * The short headline from a stored profile title + employer:
 *   "Yunus Emre Erkan - Senior CS Student at Bilkent University | LinkedIn" + "Helmholtz Munich"
 *   -> "Senior CS Student at Bilkent University · Helmholtz Munich"
 * Drops the "| LinkedIn" suffix and a leading copy of the person's own name; keeps the employer
 * only when the role does not already mention it.
 */
export function cleanHeadline(fullName: string, headline: string, employer = ""): string {
  let h = (headline || "").trim();
  for (let i = 0; i < 2; i++) h = h.replace(SITE_SUFFIX, "").trim();
  const name = fold(fullName);
  const parts = h.split(/\s+[-–—|]\s+/);
  if (parts.length > 1 && fold(parts[0]) === name) h = parts.slice(1).join(" – ");
  else if (fold(h) === name) h = "";
  else if (fullName && h.toLowerCase().startsWith(fullName.toLowerCase() + " ")) h = h.slice(fullName.length).replace(/^[\s,:;-]+/, "");
  h = h.replace(/\s*\.{3}$|…$/, "").trim();
  const emp = (employer || "").trim();
  if (emp && fold(emp) !== name && !fold(h).includes(fold(emp))) h = h ? `${h} · ${emp}` : emp;
  return h;
}

/** A readable account label from its URL: linkedin.com/in/slug, @handle, researchgate.net/profile/Name … */
export function profileHandle(platform: string, url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  const seg = u.pathname.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const host = u.hostname.replace(/^(www|m|mobile|tr)\./, "");
  switch (platform) {
    case "linkedin": return seg[0] === "in" && seg[1] ? `linkedin.com/in/${seg[1]}` : `${host}/${seg.join("/")}`;
    case "instagram": case "x": case "github":
      return seg[0] ? `@${seg[0].replace(/^@/, "")}` : host;
    case "facebook":
      if (seg[0] === "profile.php") { const id = u.searchParams.get("id"); return id ? `facebook.com/profile.php?id=${id}` : host; }
      return seg[0] ? (seg[0] === "people" ? `facebook.com/people/${seg[1] ?? ""}` : `@${seg[0]}`) : host;
    case "youtube":
      if (seg[0]?.startsWith("@")) return seg[0];
      if (seg[0] === "c" || seg[0] === "user") return seg[1] ? `@${seg[1]}` : host;
      if (seg[0] === "channel" && seg[1]) return `youtube.com/channel/${seg[1].length > 14 ? seg[1].slice(0, 12) + "…" : seg[1]}`;
      return `${host}/${seg.join("/")}`;
    case "bluesky": return seg[0] === "profile" && seg[1] ? `@${seg[1]}` : `${host}/${seg.join("/")}`;
    case "spotify": return (seg[0] === "user" || seg[0] === "artist") && seg[1] ? `spotify.com/${seg[0]}/${seg[1]}` : `${host}/${seg.join("/")}`;
    case "tiktok": return seg[0] && seg[0].startsWith("@") ? seg[0] : `${host}/${seg.join("/")}`;
    case "strava": return seg[0] === "athletes" && seg[1] ? `strava.com/athletes/${seg[1]}` : `${host}/${seg.join("/")}`;
    case "researchgate": return seg[0] === "profile" && seg[1] ? `researchgate.net/profile/${seg[1]}` : `${host}/${seg.join("/")}`;
    default: return `${host}${seg.length ? "/" + seg.join("/") : ""}`;
  }
}

/** The scan's evidence codes as short human-readable chips. */
const EVIDENCE: Record<string, string> = {
  bilkent: "Bilkent on profile", "bilkent-page": "Listed on a Bilkent page", "dept-page": "Listed on the dept page",
  field: "Dept matches", dept: "Dept matches", degree: "Degree matches", year: "Year matches", student: "Student on profile",
  "distinct-name": "Distinctive name", "rare-name": "Rare name", "unique-fullname": "Unique full name", "unique-partial": "Unique name match",
  "name-handle": "Name = handle", "fullname-handle": "Name = handle", "xname-exact": "Exact name on X", "id-handle": "Handle = ID",
  "same-handle": "Same handle as a verified account", "handle-2x": "Same handle as a verified account", "site-handle": "Handle on own site",
  "yob-handle": "Year in handle", xplat: "Linked from another verified account", "cross-linked": "Linked from another verified account",
  "via-youtube": "Linked from their YouTube", "via-linkedin": "Linked from their LinkedIn",
  "own-video": "Own video", "own-upload": "Own upload", "own-video-title": "Name in video title", "own-lab-channel": "Lab channel",
  "other-uni": "Also lists another university", "same-city": "Same city", "dup-account": "Duplicate merged",
};
const PREFIX: Record<string, string> = {
  corroborated: "Backed by a linked account", xbio: "Linked from another verified account's bio", pair: "Paired with a verified account",
};
const titleCase = (s: string) => s.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().replace(/^./, (c) => c.toUpperCase());

/** "anchor:bilkent+field+distinct-name" -> ["Bilkent on profile", "Dept matches", "Distinctive name"], deduplicated. */
export function evidenceChips(code: string): string[] {
  const raw = (code || "").trim();
  if (!raw) return [];
  const out: string[] = [];
  const add = (s: string) => { if (s && !out.includes(s)) out.push(s); };
  let rest = raw;
  const m = /^([a-z]+):(.*)$/i.exec(raw);
  if (m && !m[1].includes("+") && m[1].toLowerCase() !== "shared") { const p = m[1].toLowerCase(); if (PREFIX[p]) add(PREFIX[p]); rest = m[2]; }
  for (const t0 of rest.split(/[+,]/)) {
    const t = t0.trim().toLowerCase();
    if (!t) continue;
    if (t.startsWith("shared:")) { add(`Shares ${titleCase(t.slice(7))}`); continue; }
    add(EVIDENCE[t] ?? titleCase(t));
  }
  return out;
}

/** Stored timestamps are UTC "YYYY-MM-DD[ HH:MM[:SS]]". */
export function parseUtc(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/.exec(s.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2] ?? "00:00:00"}${m[2] && m[2].length === 5 ? ":00" : ""}Z`);
  return isNaN(d.getTime()) ? null : d;
}

/** "3 days ago" / "just now" / "in 2 hours". */
export function relTime(s: string | null | undefined, now: Date = new Date()): string {
  const d = parseUtc(s);
  if (!d) return "";
  const sec = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(sec);
  if (abs < 45) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [[60, "second"], [3600, "minute"], [86400, "hour"], [604800, "day"], [2629800, "week"], [31557600, "month"], [Infinity, "year"]];
  const div: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2629800, year: 31557600 };
  for (const [lim, unit] of steps) if (abs < lim) return rtf.format(Math.round(sec / div[unit]), unit);
  return "";
}

/** The exact time in Istanbul for a tooltip: "24 Oct 2026, 13:05 (Istanbul time)". */
export function istanbulTime(s: string | null | undefined): string {
  const d = parseUtc(s);
  if (!d) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Istanbul", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(d) + " (Istanbul time)";
}

/** Estimated GPA for display: two decimals, or "" when there is none (null, undefined, NaN, out of range). It is an estimate from the
 *  roster, never an official figure — callers label it "Est. GPA" with the tooltip ESTIMATE_NOTE. */
export function gpaLabel(g: number | string | null | undefined): string {
  if (g === null || g === undefined || g === "") return "";
  const n = typeof g === "number" ? g : Number(g);
  return Number.isFinite(n) && n >= 0 && n <= 4.5 ? n.toFixed(2) : "";
}
export const ESTIMATE_NOTE = "Estimate from roster";


/** A public follower/following count for display. Empty when the value is missing — never shows 0 for a blank. */
export function formatCount(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "";
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return "";
  if (v < 10000) return Math.round(v).toLocaleString("en-US");
  const fmt = (d: number, s: string) => {
    const x = v / d;
    const t = x >= 100 ? Math.round(x).toString() : (Math.round(x * 10) / 10).toString().replace(/\.0$/, "");
    return t + s;
  };
  if (v < 1e6) return fmt(1e3, "K");
  if (v < 1e9) return fmt(1e6, "M");
  return fmt(1e9, "B");
}

/** following/followers ratio label. Inf (0 followers, known following) is flagged; blanks stay empty. */
export function followRatioLabel(ratio: number | string | null | undefined, inf?: boolean): string {
  if (inf) return "∞ (0 followers)";
  if (ratio === null || ratio === undefined || ratio === "") return "";
  const v = typeof ratio === "number" ? ratio : Number(ratio);
  if (!Number.isFinite(v) || v < 0) return "";
  return v.toFixed(2);
}

const PLATFORM_LABELS: Record<string, string> = {
  linkedin: "LinkedIn", instagram: "Instagram", facebook: "Facebook", researchgate: "ResearchGate",
  youtube: "YouTube", github: "GitHub", x: "X", strava: "Strava", bluesky: "Bluesky", spotify: "Spotify",
  tiktok: "TikTok", threads: "Threads", reddit: "Reddit", medium: "Medium", pinterest: "Pinterest",
  twitch: "Twitch", snapchat: "Snapchat", mastodon: "Mastodon", kaggle: "Kaggle", leetcode: "LeetCode",
  behance: "Behance", dribbble: "Dribbble", letterboxd: "Letterboxd", goodreads: "Goodreads",
};
export function platformLabel(p: string): string {
  if (PLATFORM_LABELS[p]) return PLATFORM_LABELS[p];
  return p.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** GPA × following/followers for display. Inf (0 followers, known following, GPA present) is flagged; blanks stay empty. */
export function gpaFollowScoreLabel(score: number | string | null | undefined, inf?: boolean): string {
  if (inf) return "∞ (0 followers)";
  if (score === null || score === undefined || score === "") return "";
  const v = typeof score === "number" ? score : Number(score);
  if (!Number.isFinite(v) || v < 0) return "";
  return v.toFixed(2);
}

/** The three public counts of one account, formatted; "" = the profile did not publish that number (never 0). */
export function profileCounts(pr: { followers?: number | string | null; following?: number | string | null; connections?: number | string | null } | null | undefined):
  { followers: string; following: string; connections: string } {
  return { followers: formatCount(pr?.followers), following: formatCount(pr?.following), connections: formatCount(pr?.connections) };
}

/** A short ratio/score for a stat tile: "∞" when flagged infinite, "" when blank. The full wording stays in the tooltip. */
export function compactNumber(v: number | string | null | undefined, inf?: boolean): string {
  return inf ? "∞" : followRatioLabel(v, false);
}
