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
   *  which the profile shows as plain text — never a link, and no copy button. */
  url: string;
  /** false for an address that is a search rather than a profile page (a Bilibili nickname). */
  profile?: boolean;
};

export type SocialField = {
  key: string;
  label: string;
  /** Example value — shows the SHAPE the network expects, which is the part people get wrong. */
  placeholder: string;
};

/** The personal website — stored with the handles (`aq_links.website`) but shown in the profile's
 *  meta row beside the city, the way X shows it, and edited with the other "about you" facts. */
export const WEBSITE_FIELD: SocialField = { key: "website", label: "Website", placeholder: "https://your.site" };

/**
 * The 31 networks, LARGEST FIRST by published accounts/users (operator 2026-10-08: "rank them based
 * on registered accounts in each"), so the ones a visitor most likely uses are the ones visible
 * before "+N". Registered accounts where a network publishes them, otherwise its own active-user
 * figure — the table with sources is in the PR. Google Scholar and ORCID are research identifiers,
 * not networks, so they follow the ranked list.
 */
export const SOCIAL_FIELDS: readonly SocialField[] = [
  { key: "facebook", label: "Facebook", placeholder: "username or numeric ID" },      // 3.07B MAU
  { key: "instagram", label: "Instagram", placeholder: "handle" },                    // 3B MAU
  { key: "youtube", label: "YouTube", placeholder: "@handle or channel ID" },         // 2.53B
  { key: "tiktok", label: "TikTok", placeholder: "handle" },                          // 1.59B
  { key: "wechat", label: "WeChat", placeholder: "WeChat ID" },                       // 1.42B MAU
  { key: "linkedin", label: "LinkedIn", placeholder: "handle (linkedin.com/in/…)" },  // ~1.3B members
  { key: "telegram", label: "Telegram", placeholder: "username" },                    // 1B+ MAU
  { key: "snapchat", label: "Snapchat", placeholder: "username" },                    // 971M MAU
  { key: "spotify", label: "Spotify", placeholder: "username or user ID" },           // 777M MAU
  { key: "pinterest", label: "Pinterest", placeholder: "username" },                  // 640M MAU
  { key: "weibo", label: "Weibo", placeholder: "nickname or UID" },                   // 561M MAU
  { key: "x", label: "X", placeholder: "handle" },                                    // ~550M MAU
  { key: "reddit", label: "Reddit", placeholder: "username (u/…)" },                  // 515M WAU
  { key: "threads", label: "Threads", placeholder: "handle" },                        // 500M MAU
  { key: "tumblr", label: "Tumblr", placeholder: "blog name" },                       // 500M+ blogs
  { key: "quora", label: "Quora", placeholder: "profile name (Your-Name)" },          // 400M+ monthly
  { key: "bilibili", label: "Bilibili", placeholder: "UID (or nickname)" },           // 371M MAU
  { key: "discord", label: "Discord", placeholder: "username or user ID" },           // 200M+ MAU
  { key: "github", label: "GitHub", placeholder: "username" },                        // 180M+ developers
  { key: "strava", label: "Strava", placeholder: "athlete ID or vanity name" },       // 180M+ users
  { key: "goodreads", label: "Goodreads", placeholder: "username or user ID" },       // 150M+ members
  { key: "twitch", label: "Twitch", placeholder: "username" },                        // 105M monthly
  { key: "medium", label: "Medium", placeholder: "@handle" },                         // 100M+ monthly
  { key: "vk", label: "VK", placeholder: "username or numeric ID" },                  // 94M monthly
  { key: "rumble", label: "Rumble", placeholder: "username" },                        // 57M MAU
  { key: "bluesky", label: "Bluesky", placeholder: "handle.bsky.social" },            // 46.9M accounts
  { key: "soundcloud", label: "SoundCloud", placeholder: "username" },                // 40M+ creators
  { key: "kaggle", label: "Kaggle", placeholder: "username" },                        // 34M+ users
  { key: "letterboxd", label: "Letterboxd", placeholder: "username" },                // 30M+ members
  { key: "huggingface", label: "Hugging Face", placeholder: "username" },             // 13M users
  { key: "mastodon", label: "Mastodon", placeholder: "user@instance.social" },        // 11.7M accounts
  { key: "scholar", label: "Google Scholar", placeholder: "profile ID or URL" },
  { key: "orcid", label: "ORCID", placeholder: "0000-0000-0000-0000" },
];

export const SOCIAL_BY_KEY: Record<string, SocialField> = Object.fromEntries([WEBSITE_FIELD, ...SOCIAL_FIELDS].map((f) => [f.key, f]));

/** "https://www.artaquest.com/" → "artaquest.com" — a website as X shows it: host and path, no
 *  scheme, no www, no trailing slash. */
export function bareUrl(url: string): string {
  try { const u = new URL(url); return (u.host.replace(/^www\./, "") + u.pathname + u.search).replace(/\/$/, ""); } catch { return url; }
}

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
