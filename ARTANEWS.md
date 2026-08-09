# ArtaNews — the contract

**Operator orders (2026-07-25 → 07-27), in force:**
1. Objective, data-driven news only — instrument detection, no editorial selection.
2. Detect attacks in the Middle East.
3. Nothing publishes automatically; the author confirms by email, like any other content.
4. ArtaNews **merges** into the one content model — every report is an ordinary notebook.
5. Reports must be **detailed, with visualisation**, must **search and reference possible
   causes**, must carry **many references**, and must be **readable by a layperson**.

ArtaNews is not a separate system. It is a *detector* that authors ordinary submissions.

---

## 1. The two tiers (load-bearing — everything else is detail)

**TIER 1 — DETECTION: INSTRUMENTS ONLY.** A story exists only because a physical measurement
crossed a threshold: a radiometer, a seismometer, the global routing table, a settlement price.
No wire service, social post or conflict database may create one. *You cannot fake a
seismometer* — that is the platform's immunity to information flooding.

**TIER 2 — RESEARCH: human reporting, as ATTRIBUTED CONTEXT ONLY.** It may never start a story,
raise a confidence tier, or supply a number no instrument measured.

**The platform never asserts cause or perpetrator.** A satellite sees radiant heat; a seismometer
sees ground motion; BGP sees withdrawn prefixes.

### Reddit sits in Tier 2, and that is not a style preference (2026-08-09)

Operator asked for Reddit. It is in — as **attributed context hung off a detection an instrument
already made**, never as a detector. The rule above is the whole reason this platform is hard to
flood: you cannot fake a seismometer, and you can fake a Reddit post in four seconds. A social
detector would hand any account holder the power to manufacture an ArtaQuest story, so
`News::social_tick` can only ever write an option — it cannot create, rank, revise or promote an
event, and the scheduler shows that as a separate hook on a separate cadence.

⚠️ **The match is by place NAME, not by position, and every panel says so.** Reddit's search
endpoint answers 429 to unauthenticated clients without exception, so "what was posted near this
coordinate" is unanswerable; only "what did these subreddits post recently" is. The first live test
proved why that must be stated rather than assumed — a detection in Russia drew *"Russia Hit Odesa
with 11 Missiles and 100 Drones"*, a post about a city in **Ukraine**, matched on the country name
alone. Each reference therefore carries its own match strength (`settlement` beats `country`, and
sorts above it) instead of relying on one blanket caveat a reader may not carry down the list.

Measured limits, live 2026-08-09, none worked around: plain subreddit RSS (`/r/<sub>/new/.rss`) is
the last keyless surface; it 429s roughly half of requests even 30 s apart; and a subreddit can be
silently dead — r/earthquake's newest post was two years old. Everything fails soft, records health
per subreddit, and a detection with no context renders exactly as before: the measurement, alone.

---

## 2. ⚠️ THE JUXTAPOSITION TRAP — the single most dangerous thing in this design

Operator asked to "search and reference any possible causes". A naive implementation is measurably
unsafe. Verified live 2026-07-27 for the real event *Major heat signature, 22 km from Erbil Iraq
(59 MW)*, Google News returned:

> "Missile, drone attack hits Iraq's Sulaymaniyah" — Anadolu Ajansı

**Sulaymaniyah is 147 km from the measurement and the report has nothing to do with it.** Printed
under a heading like "possible causes", that asserts a missile strike *by layout alone*.

A second failure mode, same source: the query `Ukraine fire when:7d` returned *"Zelenskyy **fires**
his commander in chief"* — keyword search matching the metaphorical sense.

**Therefore, mandatory:**
- Queries use a physical-event term set plus negative terms that kill metaphorical senses.
- Every reference is **geolocated where possible and its distance from the measurement stated**.
- The section is headed *what was reported in this area and period* — **never** "causes".
- Each panel carries an explicit line: *these reports are not evidence of a connection to this
  measurement; no link has been established.*
- A quoted headline stays **inside** its `<cite>` — never echoed in the title, abstract, slug or
  platform prose, because outlet headlines routinely assert cause and repeating one outside its
  attribution wrapper makes **the platform** the asserter.

## 3. "Possible causes", done honestly — two separate things

| | Source | What it may say |
|---|---|---|
| **Physical interpretation** | the measurement itself | which phenomena are *consistent* with this FRP band, cluster geometry, persistence and overpass time — hedged, plural, never selecting one |
| **Reported context** | human reporting, attributed | what outlets published about this area and window, each with publisher, timestamp and **distance from the measurement** |

They are never merged, and neither is headed "cause".

## 4. Citation form — cite fully, never as a live hyperlink

`self_contained = 50 − 15·min(4, ext_refs) + 10·min(2, inline_mb)`, safe zone **[40, 60]**. One
external `<a href>` scores 35 — a hard fail. So references live in `<cite>`:

> outlet · headline verbatim in quotes · byline · publication timestamp UTC · **URL as plain
> text** · retrieved timestamp UTC · **sha256 of the fetched bytes**

Zero external refs ⇒ exactly 50.0, and this is *stronger* provenance than a link: a hash is
verifiable, a link rots. Anything with a DOI keeps a real `href` (`doi.org` is allowlisted, as is
`artaquest.com` since 2026-07-27 — commit bbb354147).

⚠️ `retrieved` and the sha256 must be **constants read from the frozen record**. A `datetime.now()`
makes `article.html` differ across the two executions ⇒ `reproducibility` → 12.0.

## 5. The gate is a BALANCE gate — aim at 50, never upward

⚠️ The operator's own working notes still describe the superseded v2 floors ("≥80 per category, mean ≥85").
The live code is v3: each axis is a **trade-off position**, ideal **50.0**, safe zone **[40, 60]**,
**both directions fail** — an axis at 80 fails on the *excess* side. `BALANCE = 100 − 2·mean|s−50|`
must reach 80, then 3 blind seats must pass unanimously.

Targets that matter here (`nb-metrics.py`, calibrated overrides in `nb-metrics-calib.json`):

| Axis | Target | Trap |
|---|---|---|
| `education` | **13.5 words per non-blank code line** (ceiling 37) | *This is the hard cap on prose.* Layperson explanation must be **earned by real computation**, not added on top — a wordy article over thin code fails on excess |
| `evidence` | ~1.8 figures per 1000 markdown words | more detail ⇒ proportionally more figures |
| `structure` | ~6 markdown headings (zone 3–19) | `article.html` headings are **not** counted |
| `readability` | ~2 prose comment lines per 10 code lines | dense pandas alone scores 44.4 |
| `reproducibility` | a real computation, seeded | figures-only scores 64.0 (excess: "stability without computation is rigidity"); `random_state=0` alone scores 38.0 |
| `runnability` | ideal ~44 s | a shelf-read-only report runs ~10 s → 45.9 |
| `accessibility` | mean ink sRGB ≈ 127.5 | matplotlib's default white figure background scores 93.2, far out |
| `self_contained` | 50.0 | see §4 |

## 6. Offline reproducibility — the data shelf

The sandbox has no network (`AQ_OFFLINE=1`). Real data enters **only** via the shelf
(`provisionData()`, `notebook-relay.mjs:245-296`), which fetches each rail from a public ArtaQuest
GET. Two new rails, kept **schema-separate so the two-tier rule is structural, not a comment**:

- **`news-events.csv`** — instrument measurements only.
- **`news-refs.csv`** — frozen human-report citations, each with publisher, timestamp, URL,
  retrieved-at, sha256, and distance-from-measurement.

**Nothing on the citation rail may ever be written back to `aq_news_events`.**

⚠️ The rail **moves** (detection runs every 6 h) while the existing four are fixed snapshots. It
must therefore be an **immutable date-keyed snapshot** with an `AS_OF` cutoff pinned in the
notebook source, or a later reader cannot fetch the bytes the run read.

⚠️ `provisionData()` is **unconditional** — every rail is downloaded for *every* member notebook
run (28.3 MB today). Adding rails taxes the whole platform. Fix first: per-notebook
`metadata.aq.data` declarations + a sha256 manifest so unchanged rails cost ~1 KB.

## 7. Cadence

One notebook per event is **ungateable**: the `completeness` axis needs ≥30 rows and a single event
scores near zero, so the panel is never convened — and a templated per-event notebook is exactly
what the gaming veto seat exists to kill. ArtaNews therefore publishes a **periodic digest** over
many events.

⚠️ Budget, read live 2026-07-27: `support@` (the only daemon-usable account) is at **util 0.85**,
~3.99M tokens remaining, resetting 2026-07-31. One 3-seat panel ≈ **2.70M**. There is room for
roughly **one panel** before the reset.

## 8. What is KEPT from the current implementation

The detectors, the `aq_news_cells` persistence census (180 days of accumulated flare evidence — the
single biggest false-positive killer), the offline geocoder, `aq_news_events` as the detection
ledger, and **`prose_ok()`** — the no-invented-figure / no-asserted-cause validator, which has **no
equivalent anywhere in the notebook rubric** and must be ported, not dropped.
