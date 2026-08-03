#!/usr/bin/env python3
"""Generate the paper's two figures from the open data (run after make_data.py):
     • seasonality2_fig1.png — a representative field: observed weekly interest + the 14-parameter Huber fit
     • seasonality2_fig2.png — the distribution of best-fit signs across the N fields
Brand colours only (gold #E8B923, blue #2352E8). Writes PNGs next to this file and into ../paper/.

  python3 journal/seasonality2/code/make_figs.py
"""
import json, os
from collections import Counter
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import reproduce as R   # reuse the exact model

GOLD, BLUE, INK = "#E8B923", "#2352E8", "#0C1E32"
HERE = os.path.dirname(__file__)
PAPER = os.path.join(HERE, "..", "paper")


def main():
    d = json.load(open(os.path.join(HERE, "series2.json")))
    eph = json.load(open(os.path.join(HERE, "ephemeris2.json")))
    weeks = np.array(d["weeks"], dtype="datetime64[D]")
    n = len(weeks) - R.DROP
    lon = {b: np.asarray(eph["lon"][b], float) for b in R.BODIES}
    lon["moon"] = (lon["moon"] - lon["sun"]) % 360
    lon = {b: v[:n] for b, v in lon.items()}
    des = R.designs(lon, 1.0)

    signs, best = [], None
    for k, vals in d["series"].items():
        v = np.array([x if x is not None else np.nan for x in vals], float)
        y = np.nan_to_num(v, nan=np.nanmean(v))[:n]
        rr, sg, ref, coef, pred = R.fit_field(y, des)
        signs.append(sg)
        if best is None or rr > best[0]:
            best = (rr, k, y, pred)

    # fig1 — representative fit
    rr, k, y, pred = best
    fig, ax = plt.subplots(figsize=(8.4, 3.6), dpi=150)
    t = weeks[:n]
    ax.plot(t, y, color=BLUE, lw=0.9, alpha=0.75, label="observed")
    ax.plot(t, pred, color=GOLD, lw=2.0, label="14-parameter Huber fit")
    ax.set_title(f"“{k}” — globally-anchored weekly interest (in-sample $R^2$ = {rr*100:.0f}%)",
                 color=INK, fontsize=11)
    ax.set_xlabel("year"); ax.set_ylabel("interest (% of “quest”)")
    ax.legend(frameon=False, fontsize=9); ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout(); fig.savefig(os.path.join(HERE, "seasonality2_fig1.png"))
    fig.savefig(os.path.join(PAPER, "seasonality2_fig1.png")); plt.close(fig)

    # fig2 — sign distribution
    c = Counter(signs); order = R.SIGNS
    vals = [c[s] for s in order]
    fig, ax = plt.subplots(figsize=(7.6, 3.2), dpi=150)
    ax.bar(range(12), vals, color=BLUE, edgecolor=INK, linewidth=0.4)
    ax.set_xticks(range(12)); ax.set_xticklabels([s[:3] for s in order], fontsize=9)
    ax.set_ylabel("fields"); ax.set_title("Distribution of best-fit signs", color=INK, fontsize=11)
    ax.spines[["top", "right"]].set_visible(False)
    ax.set_yticks(range(0, max(vals) + 1))
    fig.tight_layout(); fig.savefig(os.path.join(HERE, "seasonality2_fig2.png"))
    fig.savefig(os.path.join(PAPER, "seasonality2_fig2.png")); plt.close(fig)
    print(f"figures written (rep field “{k}”, R2 {rr*100:.0f}%); signs: " +
          " ".join(f"{s[:3]}:{c[s]}" for s in order if c[s]))


if __name__ == "__main__":
    main()
