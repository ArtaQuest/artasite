# ArtaQuest brand assets

Everything here is generated — **do not hand-edit**. Change the source and re-run:

```bash
python3 wp-content/themes/artaquest-theme/tools/brand-kit.py
```

It rewrites this directory plus `assets/favicon.svg`, `assets/favicon-32.png`,
`assets/favicon-180.png`, `assets/images/og-image.png`, and the SPA's own copy at
`artaquest-web/public/favicon.svg` (which must stay byte-identical to the theme's).

## The two rules

**No background.** The mark carries none — not even in the moat where the A crosses the
ring. It adopts whatever it is placed on, which is why one file works on the dark space,
on white, and on a photograph. The only files with a canvas are the ones where a platform
forces one: the avatar (cropped to a circle over a page colour we don't control), the
banners, and `favicon-180.png` (apple-touch icons are opaque by convention).

**Gold + blue sum to white, per channel.** `#E8B923 + #1746DC = (255,255,255)` — yin and
yang complete to light. Blue is *derived* as `255 − gold` in the generator and must never
be typed by hand. Do not add a `prefers-color-scheme` swap and do not substitute the
lightened reading-ink blue (`#9CB6FF`) or the old `#4A72FF`/`#2352E8`: each breaks the sum,
and the sum is the identity. On any single background one half recedes (blue on dark, gold
on light) — that is the complementary pair doing its job, not a defect to correct.

## Files

| File | Use |
|------|-----|
| `artaquest-mark.svg` | **The logo.** A-in-ring, transparent, self-contained. Start here. |
| `artaquest-mark-1024.png` | Raster of the same, transparent, for tools that can't take SVG |
| `artaquest-wordmark.svg` | "ArtaQuest" alone, glyphs outlined (no webfont needed) |
| `artaquest-lockup.svg` | Mark **stacked over** the wordmark |
| `artaquest-lockup-1024.png` | Raster of the lockup, transparent |
| `social-avatar-1024.png` | Profile picture — X, LinkedIn, YouTube, GitHub, Instagram, Discord |
| `social-card-1200x630.png` | Share card — og:image, Twitter `summary_large_image`, Facebook, LinkedIn posts |
| `social-banner-x-1500x500.png` | X / Twitter header |
| `social-banner-2560x1440.png` | YouTube channel art; also the source crop for Facebook and LinkedIn covers |

The mark and the wordmark are **never set side by side** — the mark *is* a letter A, so
"◎ ArtaQuest" reads as "A ArtaQuest". The live shell follows the same rule: the rail shows
`<LogoMark/>` alone, the topbar shows `<Logo/>` alone. When you need both, stack them.

## Clear space and minimum size

Every asset already carries 9 units of clear space per 100 units of mark; keep at least
that much when placing the mark yourself. The mark stays legible down to ~24 px; below
that use the 32 px favicon, which is drawn with tighter padding for the pixel grid.

## Geometry lives in three places — keep them in step

The A path and ring metrics are duplicated in `tools/brand-kit.py`,
`artaquest-web/src/components/ui.tsx` (`LogoMark`), and `functions.php` (`aq_brand_svg`).
The generator's raster output was verified against a WebKit render of its own SVG and
matches to two decimals on every scanline, so any of the three can be used as the check on
the others. (Note: `cairosvg` is **not** a valid check — it silently ignores `stroke`
inside a `<mask>`, so it renders the mark with no moat at all.)
