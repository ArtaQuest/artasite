#!/usr/bin/env python3
"""Measure BOTH sides of the rendered-text pattern:
  D_ink   = mean blurred ink coverage over solid-ink pixels  (strokes still visible?)
  D_paper = mean blurred paper coverage over solid-paper pixels NEAR ink (counters still open?)
'Near ink' = paper pixels within 0.15 em of any ink (so word gaps don't dilute the statistic).
Adds both to glyph-density.json over the same (size, weight, blur) grid.
"""
import hashlib, json, sys, os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
FACES = {
    "inter": {300: "fonts/Inter-Light.ttf", 400: "fonts/Inter-Regular.ttf",
              500: "fonts/Inter-Medium.ttf", 700: "fonts/Inter-Bold.ttf"},
    # APCA's font table is calibrated with Barlow as its reference face — measured
    # for the paper's reference-font check (fonts-barlow/, Google Fonts, SIL OFL).
    "barlow": {300: "fonts-barlow/Barlow-Light.ttf", 400: "fonts-barlow/Barlow-Regular.ttf",
               500: "fonts-barlow/Barlow-Medium.ttf", 700: "fonts-barlow/Barlow-Bold.ttf"},
}
FACE = sys.argv[1] if len(sys.argv) > 1 else "inter"
FONTS = FACES[FACE]
OUT_NAME = "glyph-density.json" if FACE == "inter" else f"glyph-density-{FACE}.json"
TEXT = "the quick brown fox jumps over the lazy dog"
SS = 4
SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 21, 24, 28, 32, 36, 42, 48, 60, 72, 90, 108, 120, 130]
B_GRID = [round(0.5 + 0.25 * i, 2) for i in range(0, 23)]  # 0.5 .. 6.0 CSS px
NEAR_EM = 0.15  # paper counts as 'near ink' within this fraction of an em

def ink_image(size_px, weight):
    font = ImageFont.truetype(os.path.join(HERE, FONTS[weight]), size_px * SS)
    pad = size_px * SS
    tmp = Image.new("L", (10, 10), 255)
    bbox = ImageDraw.Draw(tmp).textbbox((0, 0), TEXT, font=font)
    w, h = bbox[2] - bbox[0] + 2 * pad, bbox[3] - bbox[1] + 2 * pad
    img = Image.new("L", (w, h), 255)
    ImageDraw.Draw(img).text((pad - bbox[0], pad - bbox[1]), TEXT, font=font, fill=0)
    return img

def near_mask(ink_solid, radius_px):
    # dilate the solid-ink mask by ~radius via a box MaxFilter chain (cheap, adequate)
    m = Image.fromarray((ink_solid * 255).astype(np.uint8))
    r = max(1, int(radius_px))
    k = 2 * r + 1
    if k > 31:  # chain filters to keep kernels small
        n, k = divmod(k - 1, 30)
        for _ in range(n): m = m.filter(ImageFilter.MaxFilter(31))
        if k >= 2: m = m.filter(ImageFilter.MaxFilter(k + 1 if (k + 1) % 2 else k + 2 if k else 3))
    else:
        m = m.filter(ImageFilter.MaxFilter(k))
    return np.asarray(m) > 0

def sha(p): return hashlib.sha256(open(p, "rb").read()).hexdigest()

out = {"text": TEXT, "ss": SS, "sizes_px": SIZES, "weights": sorted(FONTS), "b_grid_px": B_GRID,
       "near_em": NEAR_EM,
       "fonts": {str(w): {"file": os.path.basename(p), "sha256": sha(os.path.join(HERE, p))} for w, p in FONTS.items()},
       "D_ink": {}, "D_paper": {}}
for wgt in sorted(FONTS):
    out["D_ink"][str(wgt)], out["D_paper"][str(wgt)] = {}, {}
    for s in SIZES:
        img = ink_image(s, wgt)
        src = np.asarray(img, dtype=np.float32)
        ink_solid = src <= 2
        paper_solid = src >= 253
        near = near_mask(ink_solid, NEAR_EM * s * SS)
        paper_near = paper_solid & near
        ri, rp = [], []
        for b in B_GRID:
            bl = np.asarray(img.filter(ImageFilter.GaussianBlur(radius=b * SS)), dtype=np.float32)
            ink_cov = (255.0 - bl) / 255.0
            ri.append(round(float(ink_cov[ink_solid].mean()), 5))
            rp.append(round(float((1.0 - ink_cov)[paper_near].mean()), 5))
        out["D_ink"][str(wgt)][str(s)] = ri
        out["D_paper"][str(wgt)][str(s)] = rp
        print(f"w{wgt} {s:>3}px  Dink(b=1)={ri[2]:.3f} Dpap(b=1)={rp[2]:.3f}  Dink(b=2)={ri[6]:.3f} Dpap(b=2)={rp[6]:.3f}", file=sys.stderr)

json.dump(out, open(os.path.join(HERE, OUT_NAME), "w"))
print(f"wrote {OUT_NAME}", file=sys.stderr)
