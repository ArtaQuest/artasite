/**
 * ArtaChat's own stickers — the twelve animated SVGs in public/stickers/.
 *
 * They are OURS, which is the whole design: a sticker travels as an id inside the sealed message
 * (`{t:"stick", id}`), not as bytes, so sending one costs a few hundred sealed characters instead of
 * a 40 KB attachment upload, and the recipient renders a file their browser already has. No
 * third-party sticker host is contacted, ever — by anyone, on either side.
 *
 * The alternative — a GIF — is somebody else's file and goes the ordinary sealed-attachment route
 * (an `img` payload with `gif: true`). The two are deliberately different mechanisms because they
 * have deliberately different privacy properties, and pretending otherwise would be the kind of
 * quiet leak this app exists to not have.
 */

export type Sticker = { id: string; label: string; k: string };

/** The set. `id` is the filename stem — it is what gets sealed, so it is permanent: renaming one
 *  would blank every sticker anybody has ever sent. Add freely; never rename. */
export const STICKERS: Sticker[] = [
  { id: "yes",    label: "Yes",       k: "yes ok agree tick check done correct" },
  { id: "no",     label: "No",        k: "no nope wrong cross disagree" },
  { id: "love",   label: "Love",      k: "love heart like adore" },
  { id: "laugh",  label: "Laughing",  k: "laugh haha funny lol joy" },
  { id: "think",  label: "Thinking",  k: "think hmm question wondering unsure" },
  { id: "fire",   label: "Fire",      k: "fire lit hot amazing great" },
  { id: "wave",   label: "Wave",      k: "wave hello hi bye greeting" },
  { id: "star",   label: "Sparkle",   k: "star sparkle magic nice brilliant" },
  { id: "moon",   label: "Balance",   k: "moon balance yin yang duality artaquest" },
  { id: "coffee", label: "Coffee",    k: "coffee tea break brb morning" },
  { id: "sleep",  label: "Sleeping",  k: "sleep tired night bed zzz goodnight" },
  { id: "party",  label: "Party",     k: "party celebrate congrats confetti well done" },
];

const BY_ID = new Map(STICKERS.map((s) => [s.id, s]));

/** The URL of a sticker, base-prefixed so it resolves in dev (/stickers/…) and in prod (under the
 *  theme's app/ dir) alike — the same rule lib/typology-meta.ts resolveImage() follows. */
export function stickerUrl(id: string): string {
  return (import.meta.env.BASE_URL || "/") + "stickers/" + id + ".svg";
}

/** A sticker's human label, for alt text and the conversation-list preview. Unknown ids (a newer
 *  client sent one this build doesn't ship) degrade to the plain word rather than a broken image. */
export function stickerLabel(id: string): string {
  return BY_ID.get(id)?.label ?? "Sticker";
}

export function knownSticker(id: string): boolean {
  return BY_ID.has(id);
}

export function searchStickers(q: string): Sticker[] {
  const term = q.trim().toLowerCase();
  if (!term) return STICKERS;
  return STICKERS.filter((s) => s.k.includes(term) || s.label.toLowerCase().includes(term));
}
