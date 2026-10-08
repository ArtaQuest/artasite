/**
 * The social handles a member can list on their profile — the SPA's half of `AQ\Auth::LINKS`.
 *
 * ORDER AND KEYS MIRROR THE SERVER, which is the authority: it validates every value against that
 * network's own handle rule, stores the HANDLE (not a URL), and builds each address on read. This
 * file only knows how to ASK for a value (label, placeholder, keyboard) — it never builds a URL,
 * so the two cannot disagree about where a link goes. An unknown key is dropped by the server.
 */

/** One handle as the server returns it (`socials` on /profile, /me and /profile-update). */
export type Social = {
  key: string;
  label: string;
  /** What the member is called there — `artafather`, `artafather.bsky.social`, `user@instance`.
   *  An absolute URL only when one was saved that is not reducible to a handle. */
  handle: string;
  /** Where the profile links to; '' for an ID with no public page (WeChat, a Discord username),
   *  which the profile offers to COPY instead. */
  url: string;
  /** false for an address that is a search rather than a profile page (a Bilibili nickname). */
  profile?: boolean;
};

export type SocialField = {
  key: string;
  label: string;
  /** Example value — shows the SHAPE the network expects, which is the part people get wrong. */
  placeholder: string;
  /** Networks with no public profile page: shown on the profile as a copyable ID. */
  copyOnly?: boolean;
};

export const SOCIAL_FIELDS: readonly SocialField[] = [
  { key: "website", label: "Website", placeholder: "https://your.site" },
  { key: "linkedin", label: "LinkedIn", placeholder: "handle (linkedin.com/in/…)" },
  { key: "instagram", label: "Instagram", placeholder: "handle" },
  { key: "facebook", label: "Facebook", placeholder: "username or numeric ID" },
  { key: "threads", label: "Threads", placeholder: "handle" },
  { key: "bluesky", label: "Bluesky", placeholder: "handle.bsky.social" },
  { key: "tiktok", label: "TikTok", placeholder: "handle" },
  { key: "pinterest", label: "Pinterest", placeholder: "username" },
  { key: "reddit", label: "Reddit", placeholder: "username (u/…)" },
  { key: "snapchat", label: "Snapchat", placeholder: "username" },
  { key: "quora", label: "Quora", placeholder: "profile name (Your-Name)" },
  { key: "youtube", label: "YouTube", placeholder: "@handle or channel ID" },
  { key: "vk", label: "VK", placeholder: "username or numeric ID" },
  { key: "x", label: "X", placeholder: "handle" },
  { key: "telegram", label: "Telegram", placeholder: "username" },
  { key: "wechat", label: "WeChat", placeholder: "WeChat ID", copyOnly: true },
  { key: "discord", label: "Discord", placeholder: "username", copyOnly: true },
  { key: "twitch", label: "Twitch", placeholder: "username" },
  { key: "github", label: "GitHub", placeholder: "username" },
  { key: "strava", label: "Strava", placeholder: "athlete ID or vanity name" },
  { key: "letterboxd", label: "Letterboxd", placeholder: "username" },
  { key: "goodreads", label: "Goodreads", placeholder: "username or user ID" },
  { key: "soundcloud", label: "SoundCloud", placeholder: "username" },
  { key: "spotify", label: "Spotify", placeholder: "username or user ID" },
  { key: "kaggle", label: "Kaggle", placeholder: "username" },
  { key: "huggingface", label: "Hugging Face", placeholder: "username" },
  { key: "medium", label: "Medium", placeholder: "@handle" },
  { key: "tumblr", label: "Tumblr", placeholder: "blog name" },
  { key: "rumble", label: "Rumble", placeholder: "username" },
  { key: "mastodon", label: "Mastodon", placeholder: "user@instance.social" },
  { key: "bilibili", label: "Bilibili", placeholder: "UID (or nickname)" },
  { key: "weibo", label: "Weibo", placeholder: "nickname or UID" },
  { key: "scholar", label: "Google Scholar", placeholder: "profile ID or URL" },
  { key: "orcid", label: "ORCID", placeholder: "0000-0000-0000-0000" },
];

export const SOCIAL_BY_KEY: Record<string, SocialField> = Object.fromEntries(SOCIAL_FIELDS.map((f) => [f.key, f]));

/** A handle as a reader should see it: `@name` where that is the network's own convention, the
 *  bare value otherwise, and a long saved URL shortened to host + path. */
export function displayHandle(s: Pick<Social, "key" | "handle">): string {
  const h = s.handle.trim();
  if (/^https?:\/\//i.test(h)) {
    try { const u = new URL(h); return (u.host.replace(/^www\./, "") + u.pathname).replace(/\/$/, ""); } catch { return h; }
  }
  if (["website", "scholar", "orcid", "bluesky", "wechat", "bilibili", "weibo", "facebook", "strava", "goodreads", "spotify", "quora", "linkedin"].includes(s.key)) return h;
  if (s.key === "mastodon") return h.startsWith("@") ? h : `@${h}`;
  if (s.key === "reddit") return `u/${h}`;
  return `@${h.replace(/^@/, "")}`;
}
