#!/usr/bin/env python3
"""ArtaQuest brand kit — regenerate every logo / social / banner asset from one source.

Why a generator and not hand-made files: the mark's geometry lives in exactly one place
(the path data below, identical to <LogoMark/> in artaquest-web/src/components/ui.tsx and
aq_brand_svg() in the theme), and the colours are DERIVED from the single canonical gold
so the hard brand invariant — gold + blue == (255,255,255) per channel — cannot drift.

    python3 tools/brand-kit.py [--font <Montserrat[wght].ttf>] [--out <theme dir>]

Everything it writes is listed in assets/brand/README.md.
"""
import argparse
import os
import sys
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen

# ── the mark, in viewBox 0 0 100 100 units ──────────────────────────────────
A_OUTER_D = ("M43.33 21.21L56.52 21.21L90.61 96.67L78.18 96.67L66.52 70.3"
             "L33.48 70.3L22.73 96.67L9.09 96.67Z")
A_COUNTER_D = "M50 34.55L38.57 59.3L61.43 59.3Z"
A_OUTER = [(43.33, 21.21), (56.52, 21.21), (90.61, 96.67), (78.18, 96.67),
           (66.52, 70.30), (33.48, 70.30), (22.73, 96.67), (9.09, 96.67)]
A_COUNTER = [(50.0, 34.55), (38.57, 59.30), (61.43, 59.30)]
RING_R, RING_W, MOAT = 41.6, 11.66, 7.0
PAD = 9.0                     # clear space around the 100-unit box, in the same units
BOX = 100.0 + 2 * PAD         # 118 — matches the favicon viewBox "-9 -9 118 118"

# ── colour: ONE canonical gold; blue is derived, never typed by hand ────────
GOLD = (0xE8, 0xB9, 0x23)
BLUE = tuple(255 - c for c in GOLD)                       # #1746DC
assert all(g + b == 255 for g, b in zip(GOLD, BLUE)), "brand invariant broken"
HEX = lambda c: "#%02X%02X%02X" % c
SPACE = ((0x01, 0x0C, 0x17), (0x06, 0x12, 0x1E), (0x0C, 0x1E, 0x32))  # dark-space stops
INK_DIM = (0x9A, 0xA6, 0xBC)

TAGLINE = "Reproducible notebooks, published in a feed"
DOMAIN = "artaquest.com"

# ═══════════════════════════════════════════════════════════════════════════
# raster primitives
# ═══════════════════════════════════════════════════════════════════════════
SS = 8      # supersample factor for the mark


def _dilate(d, pts, s, off, radius, fill):
    """Minkowski sum of a closed polygon with a disc — exactly what the SVG mask's
    stroke-width=7 / stroke-linejoin=round produces around the A silhouette."""
    p = [(x * s + off[0], y * s + off[1]) for x, y in pts]
    r = radius * s
    d.polygon(p, fill=fill)
    d.line(p + [p[0]], fill=fill, width=max(1, int(round(2 * r))), joint="curve")
    for x, y in p:
        d.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def mark_masks(size, pad=PAD):
    """(gold A, blue ring) alpha masks, `size`x`size`, art inset by `pad` units."""
    span, S = 100.0 + 2 * pad, size * SS
    s = S / span
    off = (pad * s, pad * s)

    ring = Image.new("L", (S, S), 0)
    rd = ImageDraw.Draw(ring)
    cx = cy = 50.0 * s + off[0]
    for r, v in ((RING_R + RING_W / 2, 255), (RING_R - RING_W / 2, 0)):
        rr = r * s
        rd.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=v)
    _dilate(rd, A_OUTER, s, off, MOAT / 2, 0)

    a = Image.new("L", (S, S), 0)
    ad = ImageDraw.Draw(a)
    ad.polygon([(x * s + off[0], y * s + off[1]) for x, y in A_OUTER], fill=255)
    ad.polygon([(x * s + off[0], y * s + off[1]) for x, y in A_COUNTER], fill=0)

    L = Image.Resampling.LANCZOS
    return a.resize((size, size), L), ring.resize((size, size), L)


def mark_rgba(size, pad=PAD):
    """The mark on a fully transparent canvas — this IS the background-removed logo.

    Each half is a layer that is its brand colour at EVERY pixel and carries the shape
    only in its alpha, then the two are source-over composited. Do not build this with
    Image.paste(colour, mask): paste blends RGB as well as alpha, so against a transparent
    (0,0,0,0) canvas every antialiased edge pixel gets multiplied toward black and the
    finished logo wears a dark halo on any light background — the exact artefact that makes
    a "transparent" logo look cut out."""
    a, ring = mark_masks(size, pad)
    lo = Image.new("RGBA", (size, size), BLUE + (255,)); lo.putalpha(ring)
    hi = Image.new("RGBA", (size, size), GOLD + (255,)); hi.putalpha(a)
    return Image.alpha_composite(lo, hi)


def space_bg(w, h):
    """The brand dark-space gradient, top to bottom across the three space tones."""
    strip = Image.new("RGB", (1, h))
    px = strip.load()
    for y in range(h):
        t = y / max(1, h - 1)
        lo, hi, k = (SPACE[0], SPACE[1], t / 0.5) if t <= 0.5 else (SPACE[1], SPACE[2], (t - 0.5) / 0.5)
        px[0, y] = tuple(round(a + (b - a) * k) for a, b in zip(lo, hi))
    return strip.resize((w, h), Image.Resampling.BILINEAR).convert("RGBA")


def orbit_rings(w, h, cx, cy, r_inner, opacity=1.0, bodies=True):
    """The signature ambient motif (OrbitRings in ui.tsx): concentric orbits with a
    gold and a blue body on them. Anchored on the mark, so the orbits read as a quest
    circling the A rather than as wallpaper. `r_inner` is where the first orbit sits.
    Drawn 3x and downsampled so the hairlines stay smooth; a body that would land off
    (or hard against) the canvas edge is dropped rather than clipped."""
    k = 3
    layer = Image.new("RGBA", (w * k, h * k), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    u = r_inner * k / 58.0                       # ui.tsx works in a 400-box: 58 is orbit 1
    CX, CY = cx * k, cy * k

    for r, alpha in ((58, 0.15), (108, 0.11), (162, 0.075), (196, 0.05)):
        rr, a = r * u, int(alpha * 255 * opacity)
        d.ellipse([CX - rr, CY - rr, CX + rr, CY + rr], outline=(255, 255, 255, a),
                  width=max(1, round(1.5 * u)))
    for r, colour, alpha, arc in ((108, GOLD, 0.55, (250, 340)), (162, BLUE, 0.5, (70, 165))):
        rr = r * u
        d.arc([CX - rr, CY - rr, CX + rr, CY + rr], arc[0], arc[1],
              fill=colour + (int(alpha * 255 * opacity),), width=max(1, round(2.2 * u)))
    if bodies:
        for (dx, dy), r, colour in (((0, -108), 6.5, GOLD), ((162, 0), 5.5, BLUE)):
            px, py, rr = CX + dx * u, CY + dy * u, r * u
            m = 0.075 * min(w, h) * k + rr
            if m < px < w * k - m and m < py < h * k - m:
                d.ellipse([px - rr, py - rr, px + rr, py + rr], fill=colour + (int(235 * opacity),))
    return layer.resize((w, h), Image.Resampling.LANCZOS)


# ═══════════════════════════════════════════════════════════════════════════
# type
# ═══════════════════════════════════════════════════════════════════════════
class Face:
    """A static instance of the Montserrat variable font at one weight."""

    def __init__(self, src, wght, cache):
        self.path = os.path.join(cache, "Montserrat-%d.ttf" % wght)
        if not os.path.exists(self.path):
            instancer.instantiateVariableFont(TTFont(src), {"wght": wght},
                                              inplace=False).save(self.path)
        self.tt = TTFont(self.path)
        self.upem = self.tt["head"].unitsPerEm
        self.cap = self.tt["OS/2"].sCapHeight
        self.hmtx = self.tt["hmtx"]
        self.cmap = self.tt.getBestCmap()
        self.glyphset = self.tt.getGlyphSet()

    def name(self, ch):
        return self.cmap[ord(ch)]

    def advance(self, ch):
        return self.hmtx[self.name(ch)][0]

    def run_width(self, text, size, tracking):
        """Advance width of `text` at pixel `size` with `tracking` in em (no trailing track)."""
        adv = sum(self.advance(c) for c in text) / self.upem * size
        return adv + tracking * size * max(0, len(text) - 1)

    def ink(self, text):
        """(above-baseline, below-baseline) ink extent of `text`, in em. The Q's tail and
        the round letters' overshoot both exceed the cap height, so a box sized on cap
        height alone clips them."""
        from fontTools.pens.boundsPen import BoundsPen
        hi = lo = 0.0
        for ch in set(text):
            bp = BoundsPen(self.glyphset)
            self.glyphset[self.name(ch)].draw(bp)
            if bp.bounds:
                hi, lo = max(hi, bp.bounds[3]), min(lo, bp.bounds[1])
        return hi / self.upem, -lo / self.upem

    def pil(self, size):
        return ImageFont.truetype(self.path, int(round(size)))

    def draw(self, d, xy, text, size, fill, tracking=0.0):
        """Draw `text` with per-glyph tracking; xy is the LEFT/BASELINE origin."""
        f = self.pil(size)
        x, y = xy
        for ch in text:
            d.text((x, y), ch, font=f, fill=fill, anchor="ls")
            x += self.advance(ch) / self.upem * size + tracking * size
        return x

    def svg_path(self, ch):
        pen = SVGPathPen(self.glyphset)
        self.glyphset[self.name(ch)].draw(pen)
        return pen.getCommands()


# ── the wordmark: "Arta" (gold) + "Quest" (blue), matching <Logo/> in ui.tsx ─
TRACK = -0.025          # Tailwind `tracking-tight`
# The lockup is STACKED, not side-by-side: the mark IS a letter A, so setting it beside
# the wordmark reads "A ArtaQuest". The live shell never puts them adjacent either — the
# rail shows <LogoMark/> alone, the topbar shows <Logo/> alone.
MARK_TO_CAP = 2.55      # mark box height as a multiple of the wordmark cap height
STACK_GAP = 0.30        # vertical gap, in cap heights


def word_metrics(face, cap_px):
    """Box the wordmark on its real INK, not on the cap height: Montserrat's Q drops a
    tail below the baseline and its round letters overshoot the cap line, so a cap-height
    box clips both."""
    size = cap_px * face.upem / face.cap
    above, below = face.ink("ArtaQuest")
    return dict(size=size, width=face.run_width("ArtaQuest", size, TRACK),
                above=above * size, below=below * size, height=(above + below) * size)


def draw_wordmark(im, face, cap_px, left, baseline):
    d = ImageDraw.Draw(im)
    size = cap_px * face.upem / face.cap
    x = face.draw(d, (left, baseline), "Arta", size, GOLD + (255,), TRACK)
    x += TRACK * size                           # the inter-run track
    return face.draw(d, (x, baseline), "Quest", size, BLUE + (255,), TRACK)


def lockup_metrics(face, cap_px):
    w = word_metrics(face, cap_px)
    mark, gap = MARK_TO_CAP * cap_px, STACK_GAP * cap_px
    return dict(width=max(mark, w["width"]), height=mark + gap + w["height"],
                mark=mark, gap=gap, baseline=mark + gap + w["above"], size=w["size"])


def draw_lockup(im, face, cap_px, cx, top):
    """Stacked lockup: mark centred above the wordmark. `top` is the top of the ink.
    Returns its metrics."""
    m = lockup_metrics(face, cap_px)
    box = int(round(m["mark"]))
    im.alpha_composite(mark_rgba(box, pad=PAD), (round(cx - box / 2), round(top)))
    w = word_metrics(face, cap_px)
    draw_wordmark(im, face, cap_px, cx - w["width"] / 2, top + m["baseline"])
    return m


# ═══════════════════════════════════════════════════════════════════════════
# SVG emitters
# ═══════════════════════════════════════════════════════════════════════════
def svg_mark():
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="-9 -9 118 118" fill="none" role="img" aria-label="ArtaQuest">
  <!-- ArtaQuest brand mark — a solid gold "A" (the Why) cutting through a blue ring (the How).
       NO BACKGROUND: the moat where the A crosses the ring is transparent, so the mark adopts
       whatever it is placed on. HARD BRAND INVARIANT — gold + blue = (255,255,255) per channel
       ({HEX(GOLD)} + {HEX(BLUE)}); blue is derived as 255-gold and must never be typed by hand.
       Both themes use the canonical pair (ArtaContrast Standard, K=1) — do not add a
       prefers-color-scheme swap: any non-complementary blue breaks the identity. -->
  <defs>
    <mask id="aq-moat">
      <rect x="-9" y="-9" width="118" height="118" fill="#fff"/>
      <path d="{A_OUTER_D}" fill="#000" stroke="#000" stroke-width="{MOAT:g}" stroke-linejoin="round"/>
    </mask>
  </defs>
  <circle cx="50" cy="50" r="{RING_R:g}" fill="none" stroke="{HEX(BLUE)}" style="stroke:{HEX(BLUE)}" stroke-width="{RING_W:g}" mask="url(#aq-moat)"/>
  <path fill="{HEX(GOLD)}" style="fill:{HEX(GOLD)}" fill-rule="evenodd" d="{A_OUTER_D}{A_COUNTER_D}"/>
</svg>
'''


def _word_paths(face, cap, x0, baseline):
    """The wordmark as OUTLINED <path>s — no font dependency, no <text>."""
    size = cap * face.upem / face.cap
    scale = size / face.upem
    x, runs = x0, []
    for text, colour in (("Arta", GOLD), ("Quest", BLUE)):
        ds = []
        for ch in text:
            p = face.svg_path(ch)
            if p:
                ds.append(f'<path transform="translate({x:.2f} {baseline:.2f}) '
                          f'scale({scale:.6f} {-scale:.6f})" d="{p}"/>')
            x += face.advance(ch) / face.upem * size + TRACK * size
        # fill= AND style= : the attribute is the plain value, the inline style makes the
        # run immune to index.css's sentinel remap if the file is ever inlined into a page.
        runs.append(f'<g fill="{HEX(colour)}" style="fill:{HEX(colour)}">' + "".join(ds) + "</g>")
        x += TRACK * size
    return "\n  ".join(runs)


def svg_wordmark(face):
    cap = 100.0
    w = word_metrics(face, cap)
    W, H = w["width"] + 2 * PAD, w["height"] + 2 * PAD
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.2f} {H:.2f}" width="{W:.0f}" height="{H:.0f}" role="img" aria-label="ArtaQuest">
  <!-- ArtaQuest wordmark — "Arta" gold (the Why) + "Quest" blue (the How), Montserrat
       ExtraBold, tracking -0.025em, glyphs OUTLINED so no webfont is required.
       NO BACKGROUND. Gold {HEX(GOLD)} + blue {HEX(BLUE)} = white per channel (hard invariant):
       the two halves ARE the identity, so never recolour one of them on its own. -->
  {_word_paths(face, cap, PAD, PAD + w["above"])}
</svg>
'''


def svg_lockup(face):
    """Stacked mark-over-wordmark, transparent, glyphs outlined."""
    cap = 100.0
    m = lockup_metrics(face, cap)
    w = word_metrics(face, cap)
    W, H = m["width"] + 2 * PAD, m["height"] + 2 * PAD
    ms = m["mark"] / BOX                                  # mark art scale into the lockup
    mx = PAD + (m["width"] - m["mark"]) / 2               # mark box left edge
    g = f'translate({mx:.2f} {PAD:g}) scale({ms:.6f}) translate({PAD:g} {PAD:g})'
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.2f} {H:.2f}" width="{W:.0f}" height="{H:.0f}" fill="none" role="img" aria-label="ArtaQuest">
  <!-- ArtaQuest lockup — the A-in-ring mark STACKED over the wordmark. Stacked, not
       side-by-side: the mark is itself an A, so setting it beside "ArtaQuest" reads
       "A ArtaQuest". NO BACKGROUND anywhere, including the moat where the A crosses
       the ring. Gold {HEX(GOLD)} + blue {HEX(BLUE)} = white per channel (hard invariant). -->
  <defs>
    <mask id="aql-moat">
      <rect x="0" y="0" width="{W:.2f}" height="{H:.2f}" fill="#fff"/>
      <path transform="{g}" d="{A_OUTER_D}" fill="#000" stroke="#000" stroke-width="{MOAT:g}" stroke-linejoin="round"/>
    </mask>
  </defs>
  <g transform="{g}">
    <circle cx="50" cy="50" r="{RING_R:g}" fill="none" stroke="{HEX(BLUE)}" style="stroke:{HEX(BLUE)}" stroke-width="{RING_W:g}" mask="url(#aql-moat)"/>
    <path fill="{HEX(GOLD)}" style="fill:{HEX(GOLD)}" fill-rule="evenodd" d="{A_OUTER_D}{A_COUNTER_D}"/>
  </g>
  {_word_paths(face, cap, PAD + (m["width"] - w["width"]) / 2, PAD + m["baseline"])}
</svg>
'''


# ═══════════════════════════════════════════════════════════════════════════
# composed surfaces
# ═══════════════════════════════════════════════════════════════════════════
def avatar(size):
    """Square profile picture. A canvas is mandatory here — every platform crops the
    avatar to a circle over a page colour we don't control — so it is the brand's own
    dark space, and the art stays well inside the inscribed circle."""
    im = space_bg(size, size)
    c = size / 2
    im.alpha_composite(orbit_rings(size, size, c, c, size * 0.345, 0.75, bodies=False))
    box = int(round(size * 0.545))
    im.alpha_composite(mark_rgba(box, pad=PAD * 0.35), (round(c - box / 2), round(c - box / 2)))
    return im.convert("RGB")


def card(w, h, eb, med, cap, cy=None, orbit=1.0, domain=True):
    """A dark-space banner: the stacked lockup, the tagline, a gold hairline, the domain.
    The orbit motif is anchored on the MARK so the orbits circle the A."""
    im = space_bg(w, h)
    m = lockup_metrics(eb, cap)
    block = m["height"] + cap * 1.05 + (cap * 1.30 if domain else 0)
    cy = h * 0.5 if cy is None else cy
    top = cy - block / 2

    im.alpha_composite(orbit_rings(w, h, w / 2, top + m["mark"] / 2, m["mark"] * 0.80,
                                   orbit, bodies=True))
    draw_lockup(im, eb, cap, w / 2, top)

    d = ImageDraw.Draw(im)
    y = top + m["height"] + cap * 0.95
    tsz = cap * 0.50
    tw = med.run_width(TAGLINE, tsz, 0.004)
    med.draw(d, ((w - tw) / 2, y), TAGLINE, tsz, INK_DIM + (255,), 0.004)
    if domain:
        y += cap * 0.72
        gw, gh = cap * 1.35, max(2.0, cap * 0.032)
        d.rectangle([(w - gw) / 2, y, (w + gw) / 2, y + gh], fill=GOLD + (255,))
        y += cap * 0.62
        dsz = cap * 0.33
        dw = med.run_width(DOMAIN, dsz, 0.10)
        med.draw(d, ((w - dw) / 2, y), DOMAIN, dsz, GOLD + (205,), 0.10)
    return im.convert("RGB")


# ═══════════════════════════════════════════════════════════════════════════
def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cache", default=os.path.join(here, ".brand-cache"),
                    help="where the Montserrat instances live (gitignored)")
    ap.add_argument("--font", default=None, help="Montserrat[wght].ttf (fetched if absent)")
    ap.add_argument("--out", default=os.path.dirname(here), help="theme directory to write into")
    ap.add_argument("--spa", default=os.path.join(os.path.dirname(here), "..", "..", "..",
                                                  "artaquest-web", "public"),
                    help="the SPA public/ dir, which keeps its own copy of favicon.svg")
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True)
    font = a.font or os.path.join(a.cache, "Montserrat[wght].ttf")
    if not os.path.exists(font):
        # The wordmark needs Montserrat ExtraBold. Vendoring 745 KB of font for a build-time
        # tool is not worth it, so fetch it once into the cache. OFL-1.1, so redistributable.
        import urllib.request
        url = ("https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/"
               "Montserrat%5Bwght%5D.ttf")
        print("fetching Montserrat (OFL-1.1) -> %s" % font)
        try:
            with urllib.request.urlopen(url, timeout=60) as r, open(font, "wb") as fh:
                fh.write(r.read())
        except Exception as e:
            sys.exit("could not fetch the font (%s). Pass --font <Montserrat[wght].ttf>." % e)
    a.font = font
    brand = os.path.join(a.out, "assets", "brand")
    assets = os.path.join(a.out, "assets")
    os.makedirs(brand, exist_ok=True)
    eb, med = Face(a.font, 800, a.cache), Face(a.font, 500, a.cache)

    def png(im, path, **kw):
        im.save(path, "PNG", optimize=True, **kw)
        print("  %-58s %7d B  %sx%s" % (os.path.relpath(path, a.out), os.path.getsize(path), *im.size))

    def txt(s, path):
        open(path, "w").write(s)
        print("  %-58s %7d B" % (os.path.relpath(path, a.out), os.path.getsize(path)))

    print("logo — background removed, canonical pair %s + %s" % (HEX(GOLD), HEX(BLUE)))
    txt(svg_mark(), os.path.join(brand, "artaquest-mark.svg"))
    txt(svg_wordmark(eb), os.path.join(brand, "artaquest-wordmark.svg"))
    txt(svg_lockup(eb), os.path.join(brand, "artaquest-lockup.svg"))
    png(mark_rgba(1024), os.path.join(brand, "artaquest-mark-1024.png"))

    cap = 150
    m = lockup_metrics(eb, cap)
    lock = Image.new("RGBA", (round(m["width"] + 2 * PAD), round(m["height"] + 2 * PAD)), (0, 0, 0, 0))
    draw_lockup(lock, eb, cap, lock.width / 2, PAD)
    png(lock, os.path.join(brand, "artaquest-lockup-1024.png"))

    print("social")
    png(avatar(1024), os.path.join(brand, "social-avatar-1024.png"))
    png(card(1200, 630, eb, med, 62), os.path.join(brand, "social-card-1200x630.png"))
    # X crops the header on narrow viewports and drops the avatar over the lower left,
    # so the block is centred and the type stays clear of that corner.
    png(card(1500, 500, eb, med, 46, orbit=0.85), os.path.join(brand, "social-banner-x-1500x500.png"))
    # YouTube/LinkedIn/Facebook covers all crop to a centred strip, so keeping the whole
    # block inside YouTube's 1546x423 TV-safe area makes every other crop inherit it.
    png(card(2560, 1440, eb, med, 58, orbit=0.6), os.path.join(brand, "social-banner-2560x1440.png"))

    print("favicons + og (in place — same filenames the theme already links)")
    txt(svg_mark(), os.path.join(assets, "favicon.svg"))
    png(mark_rgba(32, pad=3.0), os.path.join(assets, "favicon-32.png"))
    png(avatar(180), os.path.join(assets, "favicon-180.png"))   # apple-touch: opaque by convention
    png(card(1200, 630, eb, med, 62), os.path.join(assets, "images", "og-image.png"))
    spa = os.path.normpath(a.spa)
    if os.path.isdir(spa):
        # The SPA ships its own byte-identical favicon.svg; if the two drift, which one a
        # visitor gets depends on whether the theme shell or the app wrote the <link>.
        open(os.path.join(spa, "favicon.svg"), "w").write(svg_mark())
        print("  %-58s %7d B" % (os.path.relpath(os.path.join(spa, "favicon.svg"), a.out),
                                 os.path.getsize(os.path.join(spa, "favicon.svg"))))


if __name__ == "__main__":
    main()
