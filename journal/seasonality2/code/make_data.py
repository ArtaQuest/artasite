#!/usr/bin/env python3
"""Build the open dataset for the paper from ArtaQuest's collected weekly fields:
     • series2.json    — {series: {field: [raw weekly interest, globally anchored]}, weeks: [ISO dates]}
     • ephemeris2.json — {lon: {body: [sidereal longitude on the weekly grid]}}
Run from the repo root AFTER collection reaches house coverage. Reads analysis/_fields_weekly.json (the
fitted fields), analysis/data_weekly/<slug>.csv (the stitched, anchored weekly series), and
analysis/_ephemeris_weekly.csv (the LAHIRI ephemeris). Copies both files into this code/ bundle.

  python3 journal/seasonality2/code/make_data.py
"""
import json, os, re
import numpy as np, pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
GRID = pd.date_range("2004-01-04", "2026-06-24", freq="W-SUN")
BODIES = ['sun','moon','mercury','venus','mars','jupiter','saturn','uranus','neptune','pluto','chiron','node']
slug = lambda s: re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')
HERE = os.path.dirname(__file__)


def clean(df):
    df = df.copy(); df["Time"] = pd.to_datetime(df["Time"])
    y = df.drop_duplicates("Time").set_index("Time")["v"].astype(float).reindex(GRID)
    if y.notna().sum() < len(GRID) * 0.5:
        return None
    return y.interpolate(limit_direction="both").ffill().bfill().round(3).tolist()


def main():
    fits = json.load(open(os.path.join(ROOT, "analysis/_fields_weekly.json")))
    series = {}
    for k, rec in fits.items():
        if rec.get("res") != "weekly":
            continue
        p = os.path.join(ROOT, f"analysis/data_weekly/{slug(k)}.csv")
        if not os.path.exists(p):
            continue
        y = clean(pd.read_csv(p))
        if y is not None:
            series[k] = y
    weeks = [d.strftime("%Y-%m-%d") for d in GRID]
    json.dump({"weeks": weeks, "series": series}, open(os.path.join(HERE, "series2.json"), "w"))
    print(f"series2.json: {len(series)} fields x {len(weeks)} weeks")

    eph = pd.read_csv(os.path.join(ROOT, "analysis/_ephemeris_weekly.csv"))
    lon = {b: eph[b].astype(float).round(4).tolist() for b in BODIES if b in eph.columns}
    json.dump({"lon": lon}, open(os.path.join(HERE, "ephemeris2.json"), "w"))
    print(f"ephemeris2.json: {len(lon)} bodies x {len(eph)} rows")


if __name__ == "__main__":
    main()
