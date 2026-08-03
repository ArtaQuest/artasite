#!/usr/bin/env python3
"""Reproduction run for "The Density Law: A One-Line Rule for Legible Colour from
Pixel Density and Background" (Educational Accessibility).

Usage:  python3 reproduce.py <path-to-glyph-density.json>

Standard library only. From the released density measurements this script:
  1. rebuilds the 40 threshold pairs from APCA's published font table (using APCA's
     own arithmetic, re-implemented below from its frozen constants);
  2. refits the law's three constants (C, Y0, b) by least squares on ln|dY|,
     with b restricted to the optically admissible band 0.5-1.5 px;
  3. recomputes every number the paper claims (R^2s, RMSE + adjusted R^2,
     cross-validation, size predictions, token densities, deployed ramp
     luminances), the uncertainty on the three constants (leave-one-cell-out
     refits, seeded cell bootstrap, 5%-SSE profile bands, ridge stability),
     the three ablations (polarity-symmetric veil, constant demand, log-linear
     baseline), and — when the dataset carries a "barlow" face — the
     reference-font refit on Barlow (APCA's own calibration face);
  4. writes results.json and the figure data files figure1.dat, figure2_light.dat,
     figure2_dark.dat, figure3.dat (residuals), figure4.dat (ramp) next to itself;
  5. asserts each claimed number (the same values as expected.json).

Everything is deterministic and there is no network access; the one use of
randomness (the cell bootstrap) is seeded and uses random.random() only, so the
run is bit-reproducible on every machine.
"""
import json, math, os, random, sys

# ── dataset ──────────────────────────────────────────────────────────────────
if len(sys.argv) < 2:
    sys.exit("usage: reproduce.py <glyph-density.json>")
_raw = json.load(open(sys.argv[1]))
if "D_ink" in _raw:                       # single-face file (rounds 1-2)
    FACE_DATA = {"inter": _raw}
else:                                     # multi-face wrapper: {"inter": {...}, "barlow": {...}}
    FACE_DATA = _raw
G = FACE_DATA["inter"]
HERE = os.path.dirname(os.path.abspath(__file__)) or "."
SIZES = [float(s) for s in G["sizes_px"]]
B_GRID = [float(b) for b in G["b_grid_px"]]
OPTICS = [i for i, b in enumerate(B_GRID) if 0.5 <= b <= 1.5]   # ~0.6-1.9 arcmin
for g in FACE_DATA.values():              # every face shares one measurement grid
    assert g["sizes_px"] == G["sizes_px"] and g["b_grid_px"] == G["b_grid_px"]

def skey(s):  # dataset keys are the ints as strings
    return str(int(s)) if float(s).is_integer() else str(s)

_DCOL = {}
def D_col(weight, bi, face="inter"):
    """min(D_ink, D_paper) over the size grid, made monotone for clean inversion."""
    if (face, weight, bi) in _DCOL:
        return _DCOL[(face, weight, bi)]
    g = FACE_DATA[face]
    di = [g["D_ink"][str(weight)][skey(s)][bi] for s in SIZES]
    dp = [g["D_paper"][str(weight)][skey(s)][bi] for s in SIZES]
    d = [min(a, b) for a, b in zip(di, dp)]
    out, m = [], 0.0
    for v in d:
        m = max(m, v)
        out.append(m)
    _DCOL[(face, weight, bi)] = out
    return out

def interp(x, xs, ys):
    if x <= xs[0]: return ys[0]
    if x >= xs[-1]: return ys[-1]
    for i in range(len(xs) - 1):
        if xs[i] <= x <= xs[i + 1]:
            t = (x - xs[i]) / (xs[i + 1] - xs[i])
            return ys[i] + t * (ys[i + 1] - ys[i])
    raise ValueError

LOGS = [math.log(s) for s in SIZES]
def D_of(size, weight, bi, face="inter"):
    return interp(math.log(size), LOGS, D_col(weight, bi, face))

# ── display luminance (the paper's eq. 1, grayscale case) ────────────────────
GAMMA = 2.2
def Y(v): return (v / 255.0) ** GAMMA

# ── APCA G-4g re-implementation (constants frozen since 2021; see apca-w3) ───
def apca_y(v): return (v / 255.0) ** 2.4
def clamp_blk(y): return y if y >= 0.022 else y + (0.022 - y) ** 1.414
def apca_lc(yt, yb):
    yt, yb = clamp_blk(yt), clamp_blk(yb)
    if abs(yb - yt) < 0.0005: return 0.0
    if yb > yt:
        s = (yb ** 0.56 - yt ** 0.57) * 1.14
        return 0.0 if s < 0.1 else (s - 0.027) * 100.0
    s = (yb ** 0.65 - yt ** 0.62) * 1.14
    return 0.0 if s > -0.1 else (s + 0.027) * 100.0

def gray_for_lc(bg_v, target, light):
    """The text grey whose |APCA Lc| against grey bg_v equals target (bisection)."""
    lo, hi = (bg_v, 255.0) if light else (0.0, bg_v)
    for _ in range(60):
        m = (lo + hi) / 2.0
        lc = abs(apca_lc(apca_y(m), apca_y(bg_v)))
        if light: lo, hi = (lo, m) if lc > target else (m, hi)
        else:     lo, hi = (m, hi) if lc > target else (lo, m)
    return (lo + hi) / 2.0

# APCA's published font table (fontMatrixAscend): Lc -> min px per weight.
# Lc 30 is excluded from the fit: APCA itself marks it sub-content.
FONT = {45: {300: 72, 400: 42, 500: 32, 700: 24},
        60: {300: 42, 400: 24, 500: 21, 700: 16},
        75: {300: 24, 400: 18, 500: 16, 700: 14},
        90: {300: 21, 400: 16, 500: 15.5, 700: 14},
        100: {300: 18.5, 400: 15, 500: 14.5, 700: 13}}

def points(weights=None):
    pts = []
    for lc, row in FONT.items():
        for wgt, px in row.items():
            if weights and wgt not in weights: continue
            for bg_v, light in ((255.0, False), (0.0, True)):
                tv = gray_for_lc(bg_v, lc, light)
                yt, yb = Y(tv), Y(bg_v)
                pts.append(dict(lc=lc, weight=wgt, px=px, light=light, Yt=yt, Yb=yb,
                                dY=abs(yt - yb), Ymax=max(yt, yb)))
    return pts

# ── the law: predicted required step (paper eq. 5, solved from eq. 4) ────────
def pred_dY(p, D, C, y0):
    if not p["light"]:
        return C * (p["Yb"] + y0) / D                 # darker ink
    return C * (p["Yb"] + y0) / (D - C) if D > C else None   # lighter ink

def prep(pts, bi, face="inter"):
    """Precompute per-point terms so the inner SSE loop is pure arithmetic."""
    return [(math.log(p["dY"]), p["Yb"], p["light"], D_of(p["px"], p["weight"], bi, face)) for p in pts]

def sse_prep(pp, y0, C, kind="law"):
    s = 0.0
    for ld, yb, light, d in pp:
        if kind == "law":                 # the veil rides on the BRIGHTER side (Ymax + Y0)
            if light:
                if d <= C: return None
                pd = C * (yb + y0) / (d - C)
            else:
                pd = C * (yb + y0) / d
        else:                             # "sym" ablation: veil on the DIMMER side (Ymin + Y0)
            pd = C * (yb + y0) / d if light else C * (yb + y0) / (d + C)
        if pd <= 0: return None
        s += (ld - math.log(pd)) ** 2
    return s

def sse_of(pts, bi, y0, C):
    return sse_prep(prep(pts, bi), y0, C)

Y0_GRID = [x / 1000.0 for x in list(range(2, 20, 2)) + list(range(20, 800, 5))]

def best_C(pp, y0, kind="law"):
    """Ternary-search the criterion C on one (b, Y0) slice; returns (sse, C) or None."""
    lo, hi = 0.005, 0.98
    for _ in range(45):
        m1, m2 = lo + (hi - lo) / 3, hi - (hi - lo) / 3
        c1, c2 = sse_prep(pp, y0, m1, kind), sse_prep(pp, y0, m2, kind)
        if c1 is None and c2 is None: hi = m2; continue
        if c1 is None: lo = m1; continue
        if c2 is None: hi = m2; continue
        if c1 < c2: hi = m2
        else: lo = m1
    C = (lo + hi) / 2
    cb = sse_prep(pp, y0, C, kind)
    return None if cb is None else (cb, C)

def fit(pts, face="inter", kind="law"):
    best = None
    for bi in OPTICS:
        pp = prep(pts, bi, face)
        for y0 in Y0_GRID:
            r = best_C(pp, y0, kind)
            if r is None: continue
            cb, C = r
            if best is None or cb < best[0]: best = (cb, bi, y0, C)
    return best

def sst_of(pts):
    ml = sum(math.log(p["dY"]) for p in pts) / len(pts)
    return sum((math.log(p["dY"]) - ml) ** 2 for p in pts)

def r2_dY(pts, bi, y0, C, kind="law", face="inter"):
    sse = sse_prep(prep(pts, bi, face), y0, C, kind)
    return 1 - sse / sst_of(pts)

# ── run the fit ───────────────────────────────────────────────────────────────
PTS = points()
assert len(PTS) == 40, "expected 20 cells x 2 polarities"
SSE, BI, Y0, C = fit(PTS)
B = B_GRID[BI]
R2_DY = r2_dY(PTS, BI, Y0, C)

# size predictions (invert D at the required density)
def size_stats(bi, y0, C):
    errs, lns, sse = [], [], 0.0
    for lc, row in FONT.items():
        for wgt, px in row.items():
            pairs = [(p["dY"], p["Ymax"]) for p in PTS if p["lc"] == lc and p["weight"] == wgt]
            d_req = max(C * (ymax + y0) / dy for dy, ymax in pairs)
            col = D_col(wgt, bi)
            if d_req <= col[0]: sp = SIZES[0] * d_req / col[0]
            elif d_req >= col[-1]: sp = 400.0
            else: sp = math.exp(interp(d_req, col, LOGS))
            errs.append(abs(math.log(sp / px)))
            sse += (math.log(sp) - math.log(px)) ** 2
            lns.append(math.log(px))
    ml = sum(lns) / len(lns)
    sst = sum((l - ml) ** 2 for l in lns)
    med = sorted(errs)[len(errs) // 2]
    return 1 - sse / sst, 100.0 * (math.exp(med) - 1)

R2_SIZE, MED_SIZE_ERR = size_stats(BI, Y0, C)

# cross-validation across held-out weights
def cv(train_w, test_w, kind="law", face="inter"):
    _, bi, y0, c = fit(points(train_w), face, kind)
    return r2_dY(points(test_w), bi, y0, c, kind, face)
R2_CV_A = cv({400, 700}, {300, 500})
R2_CV_B = cv({300, 500}, {400, 700})

# ── ablations: does the specific physics beat a generic 3-parameter fit? ──────
def adj(r2, n, p):
    return 1 - (1 - r2) * (n - 1) / (n - p - 1)

# (i) polarity-symmetric variant: the veil rides on the DIMMER side (Ymin + Y0)
_, SBI, SY0, SC = fit(PTS, kind="sym")
SYM_R2 = r2_dY(PTS, SBI, SY0, SC, kind="sym")
SYM_CV_A = cv({400, 700}, {300, 500}, kind="sym")
SYM_CV_B = cv({300, 500}, {400, 700}, kind="sym")

# (ii) no-adaptation variant: D·dY = C (constant demand; closed-form C per blur)
def const_fit(pts):
    best = None
    for bi in OPTICS:
        pp = prep(pts, bi)
        lc = sum(ld + math.log(d) for ld, yb, light, d in pp) / len(pp)
        s = sum((ld - (lc - math.log(d))) ** 2 for ld, yb, light, d in pp)
        if best is None or s < best[0]: best = (s, bi, lc)
    return best
def const_r2(pts, bi, lc):
    s = sum((math.log(p["dY"]) - (lc - math.log(D_of(p["px"], p["weight"], bi)))) ** 2 for p in pts)
    return 1 - s / sst_of(pts)
_, KBI, KLC = const_fit(PTS)
CONST_R2 = const_r2(PTS, KBI, KLC)
def const_cv(train_w, test_w):
    _, bi, lc = const_fit(points(train_w))
    return const_r2(points(test_w), bi, lc)
CONST_CV_A = const_cv({400, 700}, {300, 500})
CONST_CV_B = const_cv({300, 500}, {400, 700})

# (iii) mechanism-free log-linear baseline: ln dY = a + β ln D + γ·[light]
#       (fitted by OLS at every blur in the optics band, best blur kept — so it
#       actually gets one MORE degree of freedom than the law)
def ols3(rows):  # rows of (y, x1, x2); returns (a, b1, b2, sse)
    n = len(rows)
    s = [[0.0] * 4 for _ in range(3)]
    for y, x1, x2 in rows:
        xs = (1.0, x1, x2)
        for i in range(3):
            for j in range(3): s[i][j] += xs[i] * xs[j]
            s[i][3] += xs[i] * y
    # gaussian elimination on the 3x4 system
    for c in range(3):
        piv = max(range(c, 3), key=lambda r: abs(s[r][c]))
        s[c], s[piv] = s[piv], s[c]
        for r in range(3):
            if r != c and s[c][c] != 0:
                f = s[r][c] / s[c][c]
                for k in range(4): s[r][k] -= f * s[c][k]
    a, b1, b2 = (s[i][3] / s[i][i] for i in range(3))
    sse = sum((y - a - b1 * x1 - b2 * x2) ** 2 for y, x1, x2 in rows)
    return a, b1, b2, sse
def lin_rows(pts, bi):
    return [(math.log(p["dY"]), math.log(D_of(p["px"], p["weight"], bi)), 1.0 if p["light"] else 0.0)
            for p in pts]
def lin_fit(pts):
    best = None
    for bi in OPTICS:
        a, b1, b2, sse = ols3(lin_rows(pts, bi))
        if best is None or sse < best[0]: best = (sse, bi, a, b1, b2)
    return best
def lin_r2(pts, bi, a, b1, b2):
    s = sum((y - a - b1 * x1 - b2 * x2) ** 2 for y, x1, x2 in lin_rows(pts, bi))
    return 1 - s / sst_of(pts)
_, LBI, LA, LB1, LB2 = lin_fit(PTS)
LIN_R2 = lin_r2(PTS, LBI, LA, LB1, LB2)
def lin_cv(train_w, test_w):
    _, bi, a, b1, b2 = lin_fit(points(train_w))
    return lin_r2(points(test_w), bi, a, b1, b2)
LIN_CV_A = lin_cv({400, 700}, {300, 500})
LIN_CV_B = lin_cv({300, 500}, {400, 700})

# ── the reference-font check: refit on Barlow, APCA's own calibration face ────
BARLOW = None
if "barlow" in FACE_DATA:
    _, BBI, BY0, BC = fit(PTS, face="barlow")
    # ... and the same fit held at the Inter/textbook blur b=1.0: shows the basin
    # choice is a flat-ridge artefact while the R^2 drop is the real font effect.
    bi1 = B_GRID.index(1.0)
    pp1 = prep(PTS, bi1, "barlow")
    s1 = min(r[0] for y0 in Y0_GRID if (r := best_C(pp1, y0)) is not None)
    BARLOW = {
        "c": BC, "y0": BY0, "b": B_GRID[BBI],
        "r2": r2_dY(PTS, BBI, BY0, BC, face="barlow"),
        "r2_b1": 1 - s1 / sst_of(PTS),
        "cv_a": cv({400, 700}, {300, 500}, face="barlow"),
        "cv_b": cv({300, 500}, {400, 700}, face="barlow"),
        "d_body": D_of(16, 400, BBI, "barlow"),
    }

# ── absolute error + adjusted R^2 (the fit quality in physical units) ─────────
PP = prep(PTS, BI)
RESID = []   # ln(data) - ln(pred): positive = the standard demands more than the law
for p, (ld, yb, light, d) in zip(PTS, PP):
    RESID.append(ld - math.log(pred_dY(p, d, C, Y0)))
RMSE_LN = math.sqrt(sum(r * r for r in RESID) / len(RESID))
_med = sorted(abs(r) for r in RESID)[len(RESID) // 2]
MED_DY_ERR = 100.0 * (math.exp(_med) - 1)          # median |% error| on the step itself
ADJ_R2 = 1 - (1 - R2_DY) * (len(PTS) - 1) / (len(PTS) - 3 - 1)   # n=40, p=3

# ── uncertainty on the three constants ────────────────────────────────────────
# (a) leave-one-cell-out: drop each of the 20 (Lc, weight) cells (both its polarity
#     pairs together — they share a cell, so they leave together) and refit all three
#     constants from scratch. Deterministic; no randomness.
CELLS = [(lc, wgt) for lc in FONT for wgt in FONT[lc]]
def cell_pts(cells):
    return [p for c in cells for p in PTS if (p["lc"], p["weight"]) == c]
LOO = []
for cell in CELLS:
    _, bi_i, y0_i, c_i = fit(cell_pts([c for c in CELLS if c != cell]))
    LOO.append((c_i, y0_i, B_GRID[bi_i]))
C_LOO  = sorted(v[0] for v in LOO)
Y0_LOO = sorted(v[1] for v in LOO)
B_LOO  = sorted(v[2] for v in LOO)

# (b) cell bootstrap, 200 resamples: draw 20 cells with replacement, refit all three
#     constants, take the percentile interval. Seeded Mersenne random() only, so the
#     run stays bit-reproducible on every machine.
_rng = random.Random(19)
BOOT = []
for _ in range(200):
    draw = [CELLS[int(_rng.random() * len(CELLS))] for _ in CELLS]
    r = fit(cell_pts(draw))
    if r is not None:
        BOOT.append((r[3], r[2], B_GRID[r[1]]))
def pct(vals, q):
    v = sorted(vals)
    return v[min(len(v) - 1, max(0, round(q * (len(v) - 1))))]
C_CI  = (pct([b[0] for b in BOOT], 0.025), pct([b[0] for b in BOOT], 0.975))
Y0_CI = (pct([b[1] for b in BOOT], 0.025), pct([b[1] for b in BOOT], 0.975))
B_CI  = (pct([b[2] for b in BOOT], 0.025), pct([b[2] for b in BOOT], 0.975))

# (c) profile flatness: hold one constant at a trial value, re-optimise the other
#     two, and take the band within +5% of the optimal SSE. The three constants trade
#     off along a shallow ridge, so the joint bands are wide; what stays put along the
#     ridge is the fitted curve itself (quantified below).
TOL = SSE * 1.05
PP_BY_BI = {bi: prep(PTS, bi) for bi in OPTICS}

# conditional band first: C alone, (Y0, b) held at the optimum
cc_band = [c / 10000.0 for c in range(50, 9800, 5)
           if (s := sse_prep(PP, Y0, c / 10000.0)) is not None and s <= TOL]
C_COND = (min(cc_band), max(cc_band))

def prof_C(c):
    best = math.inf
    for pp in PP_BY_BI.values():
        for y0 in Y0_GRID:
            s = sse_prep(pp, y0, c)
            if s is not None and s < best: best = s
    return best

c_band = [c / 1000.0 for c in range(100, 601, 2) if prof_C(c / 1000.0) <= TOL]
C_PROF = (min(c_band), max(c_band))
assert 0.1 < C_PROF[0] and C_PROF[1] < 0.6, "C profile band hit the scan edge"

def prof_Y0(y0):
    fits = [r[0] for pp in PP_BY_BI.values() if (r := best_C(pp, y0)) is not None]
    return min(fits) if fits else math.inf

y0_band = [y0 for y0 in Y0_GRID if prof_Y0(y0) <= TOL]
Y0_PROF = (min(y0_band), max(y0_band))
b_band = []
for bi in OPTICS:
    fits = [r[0] for y0 in Y0_GRID if (r := best_C(PP_BY_BI[bi], y0)) is not None]
    if fits and min(fits) <= TOL:
        b_band.append(B_GRID[bi])
B_PROF = (min(b_band), max(b_band))

# (d) what the ridge does NOT move: the law's predictions. Compare the optimum against
#     the best triple at the far end of the blur band (the second basin the LOO refits
#     land in) — the predicted required steps barely change.
alt = None
for bi in OPTICS:
    if B_GRID[bi] == B_PROF[0] and B_GRID[bi] != B_GRID[BI]:
        fits = [(r[0], y0, r[1]) for y0 in Y0_GRID if (r := best_C(PP_BY_BI[bi], y0)) is not None]
        s_alt, y0_alt, c_alt = min(fits)
        alt = (bi, y0_alt, c_alt)
if alt is not None:
    pp_alt = PP_BY_BI[alt[0]]
    diffs = []
    for p, (ld, yb, light, d), (lda, yba, lighta, da) in zip(PTS, PP, pp_alt):
        pa, pb = pred_dY(p, d, C, Y0), pred_dY(p, da, alt[2], alt[1])
        diffs.append(abs(math.log(pa) - math.log(pb)))
    RIDGE_RMS = 100.0 * (math.exp(math.sqrt(sum(x * x for x in diffs) / len(diffs))) - 1)
    RIDGE_MAX = 100.0 * (math.exp(max(diffs)) - 1)
else:
    RIDGE_RMS = RIDGE_MAX = 0.0

# token densities + hairline closed form
def D_at(px, w): return D_of(px, w, BI)
D_BODY, D_SMALL, D_MICRO = D_at(16, 400), D_at(13, 400), D_at(12, 400)
D_HAIR = math.erf(1.0 / (2 * math.sqrt(2) * B))

# ── the deployed engine ramp — MIRRORS artaquest-web/src/lib/contrast.ts tokensFor() ─────────
# Levels rescale the criterion across each theme's physically available band; roles take a
# fraction of the ACHIEVED body visibility; statutory WCAG-AA clamps + dark halation ceiling.
BAND = {"dark": (0.74, 1.00), "light": (0.90, 1.06)}
ROLE = {"ink2": 0.80, "ink3": 0.69}
DARK_INK_CEIL_Y = 0.87
D_TOKEN = {"ink": D_BODY, "ink2": D_SMALL, "ink3": D_MICRO, "line": D_HAIR}
# Platform canvases: the dark card surface #161619 and the light card surface #ffffff.
def lum_rgb(r, g, b):
    return 0.2126 * (r / 255) ** GAMMA + 0.7152 * (g / 255) ** GAMMA + 0.0722 * (b / 255) ** GAMMA
CANVAS = {"dark": (lum_rgb(0x16, 0x16, 0x19), (0x16, 0x16, 0x19)), "light": (1.0, (255, 255, 255))}

def gray_v(y):  # luminance -> 8-bit grey channel (the engine's rounding)
    return max(0, min(255, round(255 * max(0.0, min(1.0, y)) ** (1 / GAMMA))))

def visibility(D, yt, yb):
    return D * abs(yt - yb) / (max(yt, yb) + Y0)

def solve_ink(Yb, D, Cc, prefer_light):
    darker = Yb - Cc * (Yb + Y0) / D
    lighter = (D * Yb + Cc * Y0) / (D - Cc) if D > Cc else None
    for want_light in (prefer_light, not prefer_light):
        if want_light and lighter is not None and lighter <= 1: return lighter
        if not want_light and darker >= 0: return darker
    return 1.0 if visibility(D, 1, Yb) >= visibility(D, 0, Yb) else 0.0

# WCAG 2.x (piecewise sRGB) — the statutory clamp, deliberately distinct from GAMMA above.
def wcag_ch(v):
    c = v / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
def wcag_ratio(v, bg_rgb):
    y1 = wcag_ch(v)
    y2 = 0.2126 * wcag_ch(bg_rgb[0]) + 0.7152 * wcag_ch(bg_rgb[1]) + 0.0722 * wcag_ch(bg_rgb[2])
    lo, hi = min(y1, y2), max(y1, y2)
    return (hi + 0.05) / (lo + 0.05)
def clamp_aa(v, bg_rgb, need, lighten):
    for _ in range(255):
        if wcag_ratio(v, bg_rgb) >= need or v <= 0 or v >= 255: break
        v += 1 if lighten else -1
    return v

def token_v(theme, level, tok):
    """8-bit grey of a neutral token, exactly as the deployed engine computes it."""
    Yb, bg_rgb = CANVAS[theme]
    dark = theme == "dark"
    t = (level - 1) / 4.0
    m_lo, m_hi = BAND[theme]
    Cc = C * (m_lo + t * (m_hi - m_lo))
    y_ink = solve_ink(Yb, D_TOKEN["ink"], Cc, dark)
    if dark: y_ink = min(y_ink, DARK_INK_CEIL_Y)
    v_ink = clamp_aa(gray_v(y_ink), bg_rgb, 4.5, dark)
    if tok == "ink": return v_ink
    v_ach = visibility(D_TOKEN["ink"], (v_ink / 255.0) ** GAMMA, Yb)
    y = solve_ink(Yb, D_TOKEN[tok], v_ach * ROLE[tok], dark)
    if dark: y = min(y, DARK_INK_CEIL_Y)
    return clamp_aa(gray_v(y), bg_rgb, 4.5 if tok == "ink2" else 3.0, dark)

FIG3 = []
for lv in range(1, 6):
    row = {"level": lv}
    for theme in ("dark", "light"):
        for tok in ("ink", "ink2"):
            row[f"{tok}_{theme}"] = (token_v(theme, lv, tok) / 255.0) ** GAMMA
    FIG3.append(row)

# ── figures ───────────────────────────────────────────────────────────────────
with open(os.path.join(HERE, "figure1.dat"), "w") as f:
    f.write("px w300 w400 w500 w700\n")
    for s in SIZES:
        f.write(f"{s:g} " + " ".join(f"{D_of(s, w, BI):.4f}" for w in (300, 400, 500, 700)) + "\n")

for pol, name in ((False, "figure2_light"), (True, "figure2_dark")):
    with open(os.path.join(HERE, f"{name}.dat"), "w") as f:
        f.write("pred data\n")
        for p in PTS:
            if p["light"] != pol: continue
            d = D_of(p["px"], p["weight"], BI)
            f.write(f"{pred_dY(p, d, C, Y0):.5f} {p['dY']:.5f}\n")

# figure3 = the residual panel; figure4 = the deployed ramp (file names match figure numbers)
with open(os.path.join(HERE, "figure3.dat"), "w") as f:
    f.write("px weight light lc resid\n")
    for p, r in zip(PTS, RESID):
        f.write(f"{p['px']:g} {p['weight']} {1 if p['light'] else 0} {p['lc']} {r:.4f}\n")

with open(os.path.join(HERE, "figure4.dat"), "w") as f:
    cols = ["level", "ink_dark", "ink2_dark", "ink_light", "ink2_light"]
    f.write(" ".join(cols) + "\n")
    for row in FIG3:
        f.write(" ".join(f"{row[c]:.4f}" if c != "level" else str(row[c]) for c in cols) + "\n")

# ── results + asserts ─────────────────────────────────────────────────────────
results = {
    "C": round(C, 4), "Y0": round(Y0, 3), "b_px": B,
    "r2_dy": round(R2_DY, 4), "r2_size": round(R2_SIZE, 4),
    "med_size_err_pct": round(MED_SIZE_ERR, 1),
    "r2_cv_a": round(R2_CV_A, 4), "r2_cv_b": round(R2_CV_B, 4),
    "n_pairs": len(PTS), "n_cells": sum(len(r) for r in FONT.values()),
    "dy_span_x": round(max(p["dY"] for p in PTS) / min(p["dY"] for p in PTS), 1),
    "d_body_16_400": round(D_BODY, 4), "d_small_13_400": round(D_SMALL, 4),
    "d_hairline_1px": round(D_HAIR, 4),
    "y_ink_dark_std": round(FIG3[2]["ink_dark"], 4),
    "y_ink_light_std": round(FIG3[2]["ink_light"], 4),
    # fit quality in absolute terms
    "rmse_ln_dy": round(RMSE_LN, 3),
    "med_dy_err_pct": round(MED_DY_ERR, 1),
    "adj_r2_dy": round(ADJ_R2, 3),
    # leave-one-cell-out ranges (20 deterministic refits)
    "c_loo_lo": round(C_LOO[0], 4), "c_loo_hi": round(C_LOO[-1], 4),
    "y0_loo_lo": round(Y0_LOO[0], 3), "y0_loo_hi": round(Y0_LOO[-1], 3),
    "b_loo_lo": round(B_LOO[0], 2), "b_loo_hi": round(B_LOO[-1], 2),
    # cell-bootstrap 95% percentile intervals (200 seeded resamples)
    "c_ci_lo": round(C_CI[0], 3), "c_ci_hi": round(C_CI[1], 3),
    "y0_ci_lo": round(Y0_CI[0], 2), "y0_ci_hi": round(Y0_CI[1], 2),
    "b_ci_lo": round(B_CI[0], 2), "b_ci_hi": round(B_CI[1], 2),
    # conditional band: C alone, (Y0, b) at the optimum, within +5% SSE
    "c_cond_lo": round(C_COND[0], 4), "c_cond_hi": round(C_COND[1], 4),
    # profile flatness: range of each constant, re-optimising the other two,
    # within +5% of the optimal SSE
    "c_prof_lo": round(C_PROF[0], 3), "c_prof_hi": round(C_PROF[1], 3),
    "y0_prof_lo": round(Y0_PROF[0], 3), "y0_prof_hi": round(Y0_PROF[1], 3),
    "b_prof_lo": round(B_PROF[0], 2), "b_prof_hi": round(B_PROF[1], 2),
    # prediction stability along the ridge (optimum vs the far basin), % on the step
    "ridge_pred_rms_pct": round(RIDGE_RMS, 1),
    "ridge_pred_max_pct": round(RIDGE_MAX, 1),
    # ablations (same data, same fitting machinery, same blur band)
    "abl_sym_r2": round(SYM_R2, 3), "abl_sym_adj": round(adj(SYM_R2, 40, 3), 3),
    "abl_sym_cv_a": round(SYM_CV_A, 3), "abl_sym_cv_b": round(SYM_CV_B, 3),
    "abl_const_r2": round(CONST_R2, 3), "abl_const_adj": round(adj(CONST_R2, 40, 2), 3),
    "abl_const_cv_a": round(CONST_CV_A, 3), "abl_const_cv_b": round(CONST_CV_B, 3),
    "abl_lin_r2": round(LIN_R2, 3), "abl_lin_adj": round(adj(LIN_R2, 40, 3), 3),
    "abl_lin_cv_a": round(LIN_CV_A, 3), "abl_lin_cv_b": round(LIN_CV_B, 3),
}
if BARLOW is not None:
    results.update({
        # the reference-font check: the law refitted on Barlow, APCA's calibration face
        "barlow_c": round(BARLOW["c"], 4), "barlow_y0": round(BARLOW["y0"], 3),
        "barlow_b_px": BARLOW["b"], "barlow_r2": round(BARLOW["r2"], 3),
        "barlow_r2_b1": round(BARLOW["r2_b1"], 3),
        "barlow_cv_a": round(BARLOW["cv_a"], 3), "barlow_cv_b": round(BARLOW["cv_b"], 3),
        "barlow_d_body_16_400": round(BARLOW["d_body"], 4),
    })
json.dump(results, open(os.path.join(HERE, "results.json"), "w"), indent=1)
print(json.dumps(results, indent=1))

exp_path = os.path.join(HERE, "expected.json")
if os.path.exists(exp_path):
    exp = json.load(open(exp_path))
    bad = []
    for k, v in exp.items():
        got = results.get(k)
        if got is None or abs(float(got) - float(v)) > max(1e-6, abs(float(v)) * 0.02):
            bad.append((k, v, got))
    assert not bad, f"MISMATCH vs expected.json: {bad}"
    print(f"OK — all {len(exp)} expected numbers reproduced.")
