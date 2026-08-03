/**
 * curriculum-astro.ts — turns a SIDEREAL (Vedic) chart into a CURRICULUM reading.
 *
 * The 12 academic houses ARE the 12 sidereal zodiac signs, in order (Aries→Psychology … Pisces→Theology),
 * so a planet in a sign "lights up" that academic house, and an aspect between two planets links the two
 * houses into a cross-disciplinary recommendation. The same machinery reads a DATE (transit/gochara) and,
 * with a second chart, a PERSON (transit-to-natal) — driving the personalised curriculum. (Signs are
 * sidereal — see astro.ts — so which field a planet lights follows the constellation-aligned zodiac.)
 */
import { CATEGORY_GROUPS } from "./typology-meta";
import { aspects, transits, chart, houseOfLon, type Chart, type Placement, type Aspect, type Body, type Houses } from "./astro";

export type House = { key: string; label: string; sign: number };
// Sign index (0 = Aries … 11 = Pisces) → academic house, in the registry's canonical order. This mapping
// is the engine's INTERNAL mechanism for ranking fields by date; the UI never shows the sign itself.
export const HOUSES: House[] = CATEGORY_GROUPS.map((g, i) => ({ key: g.key, label: g.label, sign: i }));
export const houseOfSign = (sign: number): House => HOUSES[((sign % 12) + 12) % 12];

// How strongly each body lights the house it sits in (slower/larger bodies weigh more). Weights only —
// no human-facing "role" copy lives here (the UI describes a field/approach/motivation, never a planet).
export const PLANET_META: Record<Body, number> = {
  Sun: 5, Moon: 4, Mercury: 3, Venus: 3, Mars: 3, Ceres: 3, Jupiter: 4, Saturn: 4,
  Chiron: 3, Uranus: 2, Neptune: 2, Pluto: 2, // Ceres (nurture) + Chiron (healing) — first-class personal-body motivations
};

// The astrology → How/Why ALIGNMENT (hidden under the hood, mirrors typology-meta + Topics). A planet's
// SIGN carries the APPROACH (HOW); the PLANET itself carries the MOTIVATION (WHY). Used only to personalise
// (a member's natal signature tilts their approach + motivation, not just their field) — never shown.
export const SIGN_APPROACH = ["powerful", "practical", "quick", "calming", "dramatic", "detailed", "balanced", "mysterious", "epic", "professional", "innovative", "creative"]; // Aries…Pisces → STYLE key
export const BODY_MOTIVATION: Record<Body, string> = {
  Sun: "becoming", Moon: "reflecting", Mercury: "understanding", Venus: "appreciating", Mars: "pursuing",
  Ceres: "craving", Jupiter: "exploring", Saturn: "mastering", Chiron: "transcending",
  Uranus: "rethinking", Neptune: "reimagining", Pluto: "transforming",
  // Keys kept for storage stability (no topic reclassification): Ceres carries the "craving" key (label Nurturing),
  // Chiron the "transcending" key (label Healing). Labels live in typology-meta.
};

// Essential dignity (the sky's own physics of strength): a body is STRONGER in the sign it rules
// (domicile) or is exalted in, and WEAKER in the opposite sign (detriment / fall). Because the bodies
// transit signs at hugely different rates — the Moon ~2.3 days a sign, the Sun ~30, Mars ~6 weeks,
// Saturn ~2.5 years — a dignity multiplier makes each body's pull WAX AND WANE over time. That is what
// stops the WHY (motivation) reading from being uniform: the motivation is pinned to the body, so without
// dignity every chart returns the same fixed motivation weights (Sun→becoming always on top). With it,
// "reflecting" surges when the Moon is in Cancer and fades a few days later, the Sun's "becoming" peaks
// in Leo, and the ranking genuinely shifts day to day. Classical rulerships for the seven visible bodies,
// modern rulerships for the outers; the nodes carry only their (Vedic) exaltation.
const RULES: Partial<Record<Body, number[]>> = { // sign indices a body rules (domicile); 0=Aries … 11=Pisces
  Sun: [4], Moon: [3], Mercury: [2, 5], Venus: [1, 6], Mars: [0, 7], Jupiter: [8, 11], Saturn: [9, 10],
  Uranus: [10], Neptune: [11], Pluto: [7],
};
const EXALT: Partial<Record<Body, number>> = { // exaltation sign (the classical seven; Ceres + Chiron carry no standard exaltation → dignity-neutral, varying only by combustion/retrograde)
  Sun: 0, Moon: 1, Mercury: 5, Venus: 11, Mars: 9, Jupiter: 3, Saturn: 6,
};
// Deep-exaltation (paramocha) DEGREE within the exaltation sign — a planet is strongest at this exact
// degree, tapering toward the sign's edges; its debilitation runs deepest at the same degree in the
// opposite sign. Classical Jyotish values (Sun 10° Aries, Moon 3° Taurus, Mercury 15° Virgo, Venus 27°
// Pisces, Mars 28° Capricorn, Jupiter 5° Cancer, Saturn 20° Libra). The two nodes carry no exact degree.
const EXALT_DEG: Partial<Record<Body, number>> = { Sun: 10, Moon: 3, Mercury: 15, Venus: 27, Mars: 28, Jupiter: 5, Saturn: 20 };
const opp = (s: number) => (s + 6) % 12;
/** Essential-dignity multiplier for a body at a sidereal sign+degree — domicile 2.0, exaltation 1.4–1.7
 *  (peaking at the deep-exaltation degree), detriment 0.6, fall 0.5–0.8 (deepest at the debilitation
 *  degree), else neutral 1.0 (strongest applicable wins). The degree-taper makes the pull wax and wane
 *  even WITHIN a sign — a finer drift than sign-only dignity. `deg` is the 0–30° position in the sign
 *  (defaults to mid-sign for callers that don't track it). */
export function dignity(body: Body, sign: number, deg = 15): number {
  const s = ((sign % 12) + 12) % 12;
  const rules = RULES[body] || [], ex = EXALT[body], exD = EXALT_DEG[body];
  if (rules.includes(s)) return 2.0;                          // domicile (sign-wide)
  const near = exD === undefined ? 0.5 : 1 - Math.min(Math.abs(deg - exD), 30) / 30; // 1 at the exact degree → 0 at the far edge
  if (ex === s) return 1.4 + 0.3 * near;                       // exaltation: 1.7 at the deep-exaltation degree → 1.4 at the edge
  if (rules.some((r) => opp(r) === s)) return 0.6;            // detriment (opposite a ruled sign)
  if (ex !== undefined && opp(ex) === s) return 0.8 - 0.3 * near; // fall: 0.5 at the exact debilitation degree → 0.8 at the edge
  return 1.0;
}

// Retrograde (vakri) intensity. A body retrogrades around its closest, brightest approach to Earth
// (opposition for the outer planets, inferior conjunction for Mercury/Venus), and sidereal/Vedic practice
// reads a retrograde body as INTENSIFIED — its pull presses harder, turned-inward and insistent. Because
// each body flips retrograde↔direct on its own cycle (Mercury 3×/yr, Mars every ~2 yr, Ceres + Chiron + the
// outers around half the year), this adds another real time-varying layer on top of dignity. The Sun and
// Moon never retrograde, so they never take the boost.
const RETRO_BOOST = 1.3;
const retroFactor = (retro: boolean): number => (retro ? RETRO_BOOST : 1);

// Combustion (asta) — a classical graha too near the Sun is burnt up in its glare and loses strength.
// Orbs (degrees from the Sun) are the traditional Jyotish values; Mercury and Venus tighten when
// retrograde. The Sun itself (the burner), the two nodes, and the modern outers are exempt. Deepest at
// exact conjunction (×0.5), fading linearly to no effect at the orb edge. Another real time-varying layer:
// the fast inner planets pass in and out of the Sun's beams every few weeks, so their motivations dim and
// recover — Mercury (understanding/Questioning) and Venus (appreciating) especially.
const COMBUST_ORB: Partial<Record<Body, number>> = { Moon: 12, Mars: 17, Mercury: 14, Jupiter: 11, Venus: 10, Saturn: 15 };
const COMBUST_ORB_RETRO: Partial<Record<Body, number>> = { Mercury: 12, Venus: 8 };
const sep180 = (a: number, b: number): number => { const s = Math.abs(a - b) % 360; return s > 180 ? 360 - s : s; };
/** Combustion multiplier (≤1) for a body given its longitude, the Sun's longitude and its retrograde
 *  state — 0.5 at exact conjunction, rising to 1.0 at the orb edge; 1.0 (no effect) for exempt bodies or
 *  when far enough from the Sun. */
function combustion(body: Body, lon: number, sunLon: number, retro: boolean): number {
  const orb = (retro && COMBUST_ORB_RETRO[body]) || COMBUST_ORB[body];
  if (!orb) return 1;
  const sep = sep180(lon, sunLon);
  return sep >= orb ? 1 : 0.5 + 0.5 * (sep / orb);
}

const HARMONY_FACTOR: Record<Aspect["harmony"], number> = { fusion: 1, harmonious: 0.8, challenging: 0.6, polarity: 0.7 };
// Generic guidance per harmony — the two houses are named by the caller (the card title), so the
// phrase stays about HOW to study them together, never repeating the labels.
const ASPECT_PHRASE: Record<Aspect["harmony"], string> = {
  fusion: "study where the two become one",
  harmonious: "an easy pairing — learn one through the other",
  challenging: "work the productive tension between them",
  polarity: "hold both sides in balance",
};

export type HouseScore = { house: House; score: number; bodies: Placement[]; aspectBonus: number };
export type RankedKey = { key: string; score: number };
export type Dynamic = { aspect: Aspect; houseA: House; houseB: House; phrase: string };
export type Reading = {
  scores: HouseScore[];        // FIELDS (houses), ranked — what the chart most lights up
  approach: RankedKey[];       // APPROACHES (HOW), from the planets' signs, ranked
  motivation: RankedKey[];     // MOTIVATIONS (WHY), from the planets, ranked
  dynamics: Dynamic[];
  headline: { sun: House; moon: House; jupiter: House; saturn: House };
};

/** Read a chart (a DATE's transit, or a person's natal) into ranked fields + approaches + motivations, all
 *  DIRECTLY from the sky: a planet's SIGN gives a field (the house) and an approach; the planet gives a
 *  motivation; each body's pull is scaled by its essential DIGNITY in that sign AND by whether it is
 *  RETROGRADE (so the WHY waxes/wanes as bodies transit and turn retrograde, not pinned to the fixed
 *  planet→motivation map); and an aspect intensifies BOTH its planets across all three. Net effect: all
 *  three axes — what, how AND why — drift day to day. */
export function reading(chart: Chart): Reading {
  const byHouse = new Map<string, HouseScore>();
  for (const h of HOUSES) byHouse.set(h.key, { house: h, score: 0, bodies: [], aspectBonus: 0 });
  const apW = new Map<string, number>(), moW = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string, v: number) => { if (k) m.set(k, (m.get(k) || 0) + v); };
  const sunLon = chart.placements.find((p) => p.body === "Sun")?.lon ?? 0; // for the combustion factor below
  for (const p of chart.placements) {
    const w = PLANET_META[p.body] * dignity(p.body, p.sign, p.deg) * retroFactor(p.retro) * combustion(p.body, p.lon, sunLon, p.retro), h = byHouse.get(houseOfSign(p.sign).key)!;
    h.score += w; h.bodies.push(p);
    bump(apW, SIGN_APPROACH[((p.sign % 12) + 12) % 12], w); // the sign's APPROACH (HOW), dignity-weighted
    bump(moW, BODY_MOTIVATION[p.body], w);                  // the body's MOTIVATION (WHY), dignity-weighted
  }
  const dynamics: Dynamic[] = [];
  const seenPair = new Set<string>(); // one card per field pairing (aspects() is exactness-sorted → keep the tightest)
  for (const a of aspects(chart)) {
    const bonus = HARMONY_FACTOR[a.harmony] * a.exactness * 2;
    for (const pl of [a.a, a.b]) { // an aspect intensifies BOTH planets' approach + motivation
      bump(apW, SIGN_APPROACH[((pl.sign % 12) + 12) % 12], bonus);
      bump(moW, BODY_MOTIVATION[pl.body], bonus);
    }
    const ha = houseOfSign(a.a.sign), hb = houseOfSign(a.b.sign);
    if (ha.key === hb.key) continue; // same field → no cross-disciplinary pairing
    byHouse.get(ha.key)!.score += bonus; byHouse.get(ha.key)!.aspectBonus += bonus;
    byHouse.get(hb.key)!.score += bonus; byHouse.get(hb.key)!.aspectBonus += bonus;
    const pair = [ha.key, hb.key].sort().join("|");
    if (seenPair.has(pair)) continue;
    seenPair.add(pair);
    dynamics.push({ aspect: a, houseA: ha, houseB: hb, phrase: ASPECT_PHRASE[a.harmony] });
  }
  const rank = (m: Map<string, number>): RankedKey[] => [...m].map(([key, score]) => ({ key, score })).sort((x, y) => y.score - x.score);
  const find = (b: Body) => { const p = chart.placements.find((x) => x.body === b); return houseOfSign(p ? p.sign : 0); };
  return {
    scores: [...byHouse.values()].sort((x, y) => y.score - x.score),
    approach: rank(apW), motivation: rank(moW),
    dynamics: dynamics.slice(0, 10),
    headline: { sun: find("Sun"), moon: find("Moon"), jupiter: find("Jupiter"), saturn: find("Saturn") },
  };
}

export type Activation = { house: House; score: number };
/** Personalised reading: a member's innate field emphasis + what TODAY activates in them (transit-to-natal). */
export function personal(transit: Chart, natal: Chart): Activation[] {
  const byHouse = new Map<string, Activation>();
  for (const h of HOUSES) byHouse.set(h.key, { house: h, score: 0 });
  for (const p of natal.placements) byHouse.get(houseOfSign(p.sign).key)!.score += PLANET_META[p.body] * 0.5; // innate emphasis
  for (const a of aspects(transit, natal)) {
    byHouse.get(houseOfSign(a.b.sign).key)!.score += HARMONY_FACTOR[a.harmony] * a.exactness * 3; // a.b = the natal body → its field is activated
  }
  return [...byHouse.values()].filter((a) => a.score > 0).sort((x, y) => y.score - x.score);
}

/** A member's innate APPROACH + MOTIVATION weights from their natal chart — their planets' signs give their
 *  preferred approaches (HOW), their planets give their motivations (WHY). Lets the recommendation tilt all
 *  three dimensions to the person, not just the field. Never surfaced as astrology. */
export function personalSignature(natal: Chart): { approachW: Map<string, number>; motivationW: Map<string, number> } {
  const approachW = new Map<string, number>(), motivationW = new Map<string, number>();
  for (const p of natal.placements) {
    const w = PLANET_META[p.body];
    const ap = SIGN_APPROACH[((p.sign % 12) + 12) % 12];
    approachW.set(ap, (approachW.get(ap) || 0) + w);
    const mo = BODY_MOTIVATION[p.body];
    if (mo) motivationW.set(mo, (motivationW.get(mo) || 0) + w);
  }
  return { approachW, motivationW };
}

// ── TRANSIT-TO-NATAL reading (the Recommendations page) ───────────────────────────────────────────────
// Each transiting body falls in one of the person's twelve natal HOUSES (life areas). The HOUSE says WHICH
// area of life the sky is lighting up now (→ a field to study); the BODY says the DRIVE behind it; the
// SIGN says the STYLE. All surfaced in PLAIN words — no planet/sign/house/transit term ever appears.
// The field for house N is HOUSES[N-1] (the houses run in the same order as the twelve academic fields).
export const HOUSE_AREA: string[] = [
  "yourself and your identity", "money and what you value", "learning and communication", "home, family and roots",
  "creativity and self-expression", "work, health and daily craft", "relationships and partnerships",
  "depth, change and what's hidden", "meaning and big ideas", "career and ambition", "community and the future",
  "solitude and the inner life",
];
// Body → a plain DRIVE (the energy behind a transit). No body is ever named in the UI.
export const PLANET_DRIVE: Partial<Record<Body, string>> = {
  Sun: "vitality and purpose", Moon: "feeling and comfort", Mercury: "thinking and curiosity",
  Venus: "connection and beauty", Mars: "drive and action", Ceres: "care and nourishment",
  Jupiter: "growth and opportunity", Saturn: "focus and discipline", Chiron: "healing and wholeness",
  Uranus: "change and fresh thinking", Neptune: "imagination and inspiration", Pluto: "deep transformation",
};
// Body → a plain TIMESCALE: how long this focus tends to last, set by how fast the body moves through the
// sky. The Moon flits through in days (a passing mood); the Sun colours a year; Saturn shapes a whole
// chapter; Pluto an age. Surfaced so a recommendation signals whether to act on it now or let it unfold.
// No body is ever named. Mirrors the cycle-grounded WHY titles (Reflecting=month … Transforming=age).
export const PLANET_TIMESCALE: Partial<Record<Body, string>> = {
  Moon: "this month", Mercury: "these few weeks", Venus: "these months", Sun: "this year",
  Mars: "the year ahead", Ceres: "the next few years", Jupiter: "this decade", Saturn: "this chapter of life",
  Chiron: "this half-century", Uranus: "this lifetime", Neptune: "a long, slow season", Pluto: "a deep, lasting shift",
};

export type TransitActivation = {
  house: number; field: House; area: string; score: number; count: number;
  drive: string;      // the dominant body's plain drive
  style: string;      // the dominant body's sign → STYLE key (e.g. "practical")
  timescale: string;  // the dominant body's plain timescale (how long this focus lasts)
};
export type TransitReading = {
  activations: TransitActivation[];     // life areas lit up now, strongest first
  fieldW: Map<string, number>;          // field key → weight (for topic ranking)
  styleW: Record<string, number>;       // STYLE key → weight
  whyW: Record<string, number>;         // MOTIVATION key → weight
};

/** Read the current sky against a person's natal HOUSES into ranked life-area activations + field/style/
 *  motivation weights — the basis for the Recommendations page. Each of the twelve bodies adds its dignity-
 *  and-retrograde-weighted pull to the natal house it currently occupies. */
export function transitReading(transit: Chart, houses: Houses): TransitReading {
  const hits = transits(transit, houses);
  const sun = hits.find((h) => h.body === "Sun");
  const sunLon = sun ? sun.sign * 30 + sun.deg : 0; // for combustion: how close each body sits to the Sun's beams
  const byHouse = new Map<number, { score: number; count: number; top: { body: Body; w: number; sign: number } | null }>();
  const fieldW = new Map<string, number>();
  const styleW: Record<string, number> = {};
  const whyW: Record<string, number> = {};
  for (const h of hits) {
    const lon = h.sign * 30 + h.deg;
    const w = PLANET_META[h.body] * dignity(h.body, h.sign, h.deg) * retroFactor(h.retro) * combustion(h.body, lon, sunLon, h.retro);
    const cur = byHouse.get(h.house) || { score: 0, count: 0, top: null };
    cur.score += w; cur.count += 1;
    if (!cur.top || w > cur.top.w) cur.top = { body: h.body, w, sign: h.sign };
    byHouse.set(h.house, cur);
    fieldW.set(HOUSES[h.house - 1].key, (fieldW.get(HOUSES[h.house - 1].key) || 0) + w);
    const style = SIGN_APPROACH[((h.sign % 12) + 12) % 12];
    styleW[style] = (styleW[style] || 0) + w;
    const why = BODY_MOTIVATION[h.body];
    whyW[why] = (whyW[why] || 0) + w;
  }
  const activations: TransitActivation[] = [...byHouse.entries()].map(([house, v]) => ({
    house, field: HOUSES[house - 1], area: HOUSE_AREA[house - 1], score: v.score, count: v.count,
    drive: v.top ? (PLANET_DRIVE[v.top.body] || "") : "",
    style: v.top ? SIGN_APPROACH[((v.top.sign % 12) + 12) % 12] : "balanced",
    timescale: v.top ? (PLANET_TIMESCALE[v.top.body] || "") : "",
  })).sort((a, b) => b.score - a.score);
  return { activations, fieldW, styleW, whyW };
}

// ── How long the current phase lasts (the progress bar + tooltip on each Home cycle row) ──────────────
// Each body's geocentric MEAN motion (zodiac degrees per day) — its steady long-run rate across the signs.
// Mercury & Venus stay tethered to the Sun, so their long-run AVERAGE is ~the Sun's 1°/day; this table is
// the floor/fallback for the fast bodies (which actually read their current speed below) and the real rate
// for the slow ones.
const MEAN_DEG_PER_DAY: Record<Body, number> = {
  Moon: 13.176, Mercury: 0.986, Venus: 0.986, Sun: 0.986, Mars: 0.524, Ceres: 0.214,
  Jupiter: 0.0831, Saturn: 0.0335, Chiron: 0.0196, Uranus: 0.0117, Neptune: 0.00598, Pluto: 0.00398,
};
// The fast, personal bodies move at a speed you'd notice change week to week, so we read their CURRENT
// apparent speed — that's why the Moon, Mercury, Venus, Sun and Mars each show a DIFFERENT per-sign length
// (the same long-run average would make Mercury/Venus/Sun identical). The slow, social bodies (Ceres
// outward) are dominated by Earth's own motion — their apparent speed swings wildly and even reverses near
// opposition — so the instant speed misleads (it once made retrograde Pluto read "2 years"); they use the
// steady MEAN above, which keeps Pluto reading ~two decades.
const INSTANTANEOUS: Body[] = ["Moon", "Mercury", "Venus", "Sun", "Mars"];
const n360 = (x: number) => { x %= 360; return x < 0 ? x + 360 : x; };
export type PhaseInfo = { passed: number; left: number; progress: number }; // days into the current HOUSE, days left in it, progress 0..1
// A body's "phase" is its passage through one of YOUR natal HOUSES — a field of life, bounded by the two
// house cusps around it — so it depends on the birth chart, and the tuning slider (which nudges the assumed
// birth time → the cusps) reshapes it. `progress` = how far across the house the body has come; `passed`/
// `left` = the days since it entered and until it leaves, at its speed: the CURRENT apparent speed for the
// fast personal bodies (so Mercury/Venus/Sun differ), the steady MEAN for the slow ones (Earth's parallax
// makes a slow body's instantaneous speed misleading). The UI turns passed/left into precise start/end dates.
export function phaseInfo(now: Date, houses: Houses): Map<Body, PhaseInfo> {
  const DT = 0.5, MS = 86400000;
  const before = chart(new Date(now.getTime() - DT * MS)).placements;
  const after = chart(new Date(now.getTime() + DT * MS)).placements;
  const out = new Map<Body, PhaseInfo>();
  for (const p of chart(now).placements) {
    const h = houseOfLon(houses, p.lon);                       // the natal house (1..12) the body sits in now
    const span = n360(houses.cusps[h % 12] - houses.cusps[h - 1]) || 30; // that house's width in degrees
    const within = n360(p.lon - houses.cusps[h - 1]);          // degrees the body has travelled into the house
    const mean = MEAN_DEG_PER_DAY[p.body] || 1;
    let rate = mean;
    if (INSTANTANEOUS.includes(p.body)) {                      // fast/personal body → use its CURRENT apparent speed
      const b = before.find((x) => x.body === p.body), a = after.find((x) => x.body === p.body);
      if (b && a) {
        let d = (a.lon - b.lon) % 360; if (d > 180) d -= 360; if (d < -180) d += 360;
        rate = Math.max(Math.abs(d) / (2 * DT), 0.4 * mean);   // floored so a near-station body can't blow up
      }
    }
    out.set(p.body, { passed: within / rate, left: (span - within) / rate, progress: Math.min(1, Math.max(0, within / span)) });
  }
  return out;
}

/** A plain day-count phrase — days only (operator 2026-06-24): 2.3 → "2 days", 4824 → "4,824 days". */
export function humanizeDaysLeft(days: number): string {
  if (!isFinite(days)) return "—";
  const d = Math.max(0, Math.round(days));
  return `${d.toLocaleString("en")} day${d === 1 ? "" : "s"}`;
}

/** Days-only label for the flanking bar labels — only "d" (operator 2026-06-24): 0.6 → "1d", 4824 → "4,824d". */
export function compactDuration(days: number): string {
  if (!isFinite(days)) return "—";
  return `${Math.max(0, Math.round(days)).toLocaleString("en")}d`;
}
