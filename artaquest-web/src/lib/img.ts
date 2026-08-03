// Right-size YouTube thumbnails at render time.
//
// Course thumbnails are stored as the video's `maxresdefault.jpg` (1280×720, ~220 KB), but the cards
// that show them are only ~340–640 CSS px wide — so the browser downloads ~80% more pixels than it
// paints (the "improve image delivery" / oversized-image audit). YouTube's i.ytimg.com also can't be
// proxied/resized by the WordPress.com image CDN (i0.wp.com 302-redirects ytimg straight back to the
// full original), so the only lever we have is asking YouTube for a smaller named variant.
//
// We swap the stored maxres URL for a `srcset` of YouTube's smaller variants and let the browser pick
// the smallest one that covers the card at the device's DPR. Variants used (always present, even for
// videos that have no HD/maxres frame — so this never 404s a thumbnail the catalogue currently shows):
//   mqdefault 320×180 (native 16:9) · hqdefault 480×360 · sddefault 640×480
// hqdefault/sddefault are 4:3 with letterbox bars, but every card paints them with `object-cover` in a
// 16:9 box, which crops the bars away — so they read identically to the native-16:9 variants.
//
// Non-YouTube images (a creator's uploaded course image) fall through unchanged.

const YT_VI = /(?:i\.ytimg\.com|i\d?\.ytimg\.com|img\.youtube\.com)\/vi\/([A-Za-z0-9_-]{11})\//;

/** The 11-char YouTube video id embedded in a ytimg thumbnail URL, or null for non-ytimg URLs. */
export function ytThumbId(url?: string | null): string | null {
  if (!url) return null;
  const m = url.match(YT_VI);
  return m ? m[1] : null;
}

const variant = (id: string, name: string) => `https://i.ytimg.com/vi/${id}/${name}`;

/**
 * A right-sized `src` for a course thumbnail: hqdefault (≈30 KB) for YouTube thumbnails, the original
 * URL otherwise. Use together with thumbSrcSet() for DPR-aware selection; on its own it already cuts a
 * 220 KB maxres frame down by ~85%. Safe for CSS `background-image` too (where srcset isn't available).
 */
export function thumbSrc(url?: string | null): string {
  const id = ytThumbId(url);
  return id ? variant(id, "hqdefault.jpg") : (url ?? "");
}

/** A `srcset` of YouTube's small thumbnail variants (by intrinsic width), or undefined for non-ytimg. */
export function thumbSrcSet(url?: string | null): string | undefined {
  const id = ytThumbId(url);
  if (!id) return undefined;
  return `${variant(id, "mqdefault.jpg")} 320w, ${variant(id, "hqdefault.jpg")} 480w, ${variant(id, "sddefault.jpg")} 640w`;
}

// Default `sizes` for the course-card grids. Cards render ~256–344px wide at desktop widths (3 columns
// in the content column on Landing/Home; up to 4 in the catalogue grid), ~45vw on tablets, full-width on
// phones. Declaring 320px at ≥1024 lets DPR-1 desktops pick mqdefault (320w, ~12 KB) for these small
// cards and retina/phones pick sddefault (640w) — the variant ladder caps at 640w, so it never reaches
// for the 1280×720 maxres frame. (Earlier 360px made DPR-1 desktops over-fetch hqdefault unnecessarily.)
export const CARD_THUMB_SIZES = "(min-width: 1024px) 320px, (min-width: 640px) 45vw, 100vw";
