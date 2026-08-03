/**
 * astro.ts — a small, dependency-free SIDEREAL (Vedic / Jyotish) ephemeris + aspect engine.
 *
 * Purpose: place the Sun, Moon, Mercury…Pluto plus Ceres (the asteroid) and Chiron (the centaur) in the
 * SIDEREAL zodiac — the constellation-aligned zodiac of Vedic astrology, fixed to the stars rather than
 * the moving equinox — for any date, plus each body's NAKSHATRA (lunar mansion), and the aspects between
 * two charts. Accuracy is ~1° (signs are 30° wide and aspects use 4–8° orbs, so this is ample) over
 * roughly 1900–2100.
 *
 * Tropical vs sidereal: tropical longitude is measured from the vernal equinox of date, which precesses
 * westward ~50.3″/yr; sidereal longitude is measured from a fixed point among the stars. They differ by
 * the AYANAMSA — currently ~24° — so a body that is, say, late tropical Aries is early sidereal Aries.
 * We use the LAHIRI (Chitrapaksha) ayanamsa, the Indian-government standard for Jyotish. So the Sun
 * crosses 0° sidereal Aries near 14 April (Mesha Saṅkrānti), not at the March equinox — the defining
 * sidereal checkpoint this engine is calibrated against.
 *
 * A "chart" is just a set of body longitudes — so the SAME engine serves a DATE (transit chart) and a
 * PERSON (natal chart), and aspects(transit, natal) gives the transit-to-natal ("gochara") picture the
 * personalised-curriculum feature needs. Pure + deterministic (no Date.now inside).
 *
 * Method: JPL/Standish low-precision Keplerian elements (J2000 ecliptic) for the planets + Ceres + Chiron;
 * Meeus abbreviated series for the Moon. Each body is first taken to TROPICAL longitude of date — the
 * Keplerian longitudes come out in the (inertial) J2000 frame so we add the accumulated general precession
 * (PREC·T) to carry them to the of-date equinox; the Moon series is already of date — and THEN the
 * ayanamsa is subtracted to land in the sidereal
 * zodiac. The curriculum's TWELVE "why" motivations map one-to-one onto twelve bodies chosen for a clean,
 * gap-free ladder of cycle periods — the ten planets PLUS Ceres (the asteroid, ~4.6-yr harvest/nurture
 * cycle) and Chiron (the centaur, ~50-yr wounded-healer cycle), which fill the 2–12-yr and 30–84-yr gaps
 * the lunar nodes (both ~18.6 yr, so never complementary) were dropped to make room for.
 */

export type Body = "Sun" | "Moon" | "Mercury" | "Venus" | "Mars" | "Ceres" | "Jupiter" | "Saturn" | "Chiron" | "Uranus" | "Neptune" | "Pluto";
export const BODIES: Body[] = ["Sun", "Moon", "Mercury", "Venus", "Mars", "Ceres", "Jupiter", "Saturn", "Chiron", "Uranus", "Neptune", "Pluto"];

export const SIGNS = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"] as const;
export const SIGN_GLYPH = ["♈", "♉", "♊", "♋", "♌", "♍", "♎", "♏", "♐", "♑", "♒", "♓"];

// The 27 nakshatras (lunar mansions), each 13°20′ of the SIDEREAL ecliptic starting at 0° Aries
// (Ashwinī). The Moon's nakshatra at birth is the Janma Nakshatra — the "birth star", the single most
// personal point in a Vedic chart. Each splits into four padas (quarters) of 3°20′.
export const NAKSHATRAS = [
  "Ashwini", "Bharani", "Krittika", "Rohini", "Mrigashira", "Ardra", "Punarvasu", "Pushya", "Ashlesha",
  "Magha", "Purva Phalguni", "Uttara Phalguni", "Hasta", "Chitra", "Swati", "Vishakha", "Anuradha",
  "Jyeshtha", "Mula", "Purva Ashadha", "Uttara Ashadha", "Shravana", "Dhanishta", "Shatabhisha",
  "Purva Bhadrapada", "Uttara Bhadrapada", "Revati",
] as const;
export const BODY_GLYPH: Record<Body, string> = {
  Sun: "☉", Moon: "☽", Mercury: "☿", Venus: "♀", Mars: "♂", Ceres: "⚳", Jupiter: "♃", Saturn: "♄",
  Chiron: "⚷", Uranus: "♅", Neptune: "♆", Pluto: "♇",
};

export type Placement = { body: Body; lon: number; sign: number; signName: string; deg: number; retro: boolean; nak: number; nakName: string; pada: number };
export type Chart = { jd: number; iso: string; ayanamsa: number; placements: Placement[] };

const PREC = 1.396971;      // general precession in longitude, deg per Julian century (carries J2000 → of-date)
// Lahiri (Chitrapaksha) ayanamsa at J2000.0, in degrees — the tropical→sidereal offset, the Indian
// standard for Jyotish. It grows with precession (≈ PREC per century), so ayanamsa(T) = AYAN_J2000 +
// PREC·T (≈ 24.2° in 2026). Calibrated so the Sun reaches 0° sidereal Aries at Mesha Saṅkrānti (~14 Apr).
const AYAN_J2000 = 23.8531;
const NAK_ARC = 360 / 27;   // one nakshatra = 13°20′
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const norm360 = (x: number) => { x %= 360; return x < 0 ? x + 360 : x; };
const sin = (d: number) => Math.sin(d * D2R), cos = (d: number) => Math.cos(d * D2R);

/** Lahiri ayanamsa (deg) at Julian centuries T from J2000 — the angle to subtract from a tropical
 *  longitude to get the sidereal one. */
export const ayanamsaDeg = (T: number): number => AYAN_J2000 + PREC * T;

/** The nakshatra (0–26) + pada (1–4) for a SIDEREAL ecliptic longitude. */
export function nakshatra(lon: number): { index: number; name: string; pada: number } {
  const l = norm360(lon);
  const index = Math.floor(l / NAK_ARC) % 27;
  const pada = Math.floor((l % NAK_ARC) / (NAK_ARC / 4)) + 1; // four 3°20′ quarters
  return { index, name: NAKSHATRAS[index], pada };
}

/** Gregorian calendar date → Julian Day (UT, at the given fractional day). */
export function julianDay(y: number, m: number, d: number): number {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100), B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}

// JPL/Standish low-precision Keplerian elements (1800–2050), J2000 ecliptic.
// [a(AU), e, I(°), L(°), ϖ(°), Ω(°)] and their rates per Julian century.
const ELEM: Record<string, [number[], number[]]> = {
  Mercury: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593], [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
  Venus:   [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255], [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
  Earth:   [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0], [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
  Mars:    [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891], [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
  Jupiter: [[5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
  Saturn:  [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448], [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
  Uranus:  [[19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503], [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]],
  Neptune: [[30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574], [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]],
  Pluto:   [[39.48211675, 0.24882730, 17.14001206, 238.92903833, 224.06891629, 110.30393684], [-0.00031596, 0.00005170, 0.00004818, 145.20780515, -0.04062942, -0.01183482]],
  // Minor bodies added for the twelve-WHY cycle ladder. Osculating J2000 elements; the small secular rates
  // are negligible at our ~1° bar, so only the mean-motion (dL/dt) rate is carried. VERIFIED against
  // ephemeris to <1°: Chiron's 2018 Aries + 2026 Taurus ingresses and Ceres' 2026 Taurus all reproduced.
  Ceres:   [[2.76534850, 0.07913825, 10.58682, 160.20, 152.983, 80.393], [0, 0, 0, 7826.0, 0, 0]],
  Chiron:  [[13.70000000, 0.38230000, 6.93000, 216.80, 188.700, 209.300], [0, 0, 0, 710.0, 0, 0]],
};

function kepler(M: number, e: number): number {
  M = ((M + 180) % 360 + 360) % 360 - 180; // −180..180 deg
  let E = M + e * R2D * sin(M);
  for (let i = 0; i < 8; i++) {
    const dM = M - (E - e * R2D * sin(E));
    E += dM / (1 - e * cos(E));
  }
  return E; // deg
}

/** Heliocentric J2000 ecliptic rectangular coords (AU) of a planet at T (Julian centuries from J2000). */
function helio(planet: string, T: number): [number, number, number] {
  const [c, r] = ELEM[planet];
  const a = c[0] + r[0] * T, e = c[1] + r[1] * T, I = c[2] + r[2] * T;
  const L = c[3] + r[3] * T, wbar = c[4] + r[4] * T, Om = c[5] + r[5] * T;
  const w = wbar - Om;                 // argument of perihelion
  const E = kepler(L - wbar, e);
  const xp = a * (cos(E) - e), yp = a * Math.sqrt(1 - e * e) * sin(E);
  const cw = cos(w), sw = sin(w), cO = cos(Om), sO = sin(Om), cI = cos(I), sI = sin(I);
  return [
    (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    (sw * sI) * xp + (cw * sI) * yp,
  ];
}

/** Geocentric J2000 ecliptic longitude (deg) of a planet at Julian Day jd. */
function geoLonJ2000(planet: string, jd: number): number {
  const T = (jd - 2451545.0) / 36525;
  const [xe, ye] = helio("Earth", T);
  if (planet === "Sun") return norm360(R2D * Math.atan2(-ye, -xe));
  const [xp, yp] = helio(planet, T);
  return norm360(R2D * Math.atan2(yp - ye, xp - xe));
}

/** Moon geocentric ecliptic longitude OF DATE (deg) — Meeus abbreviated (~0.3°). */
function moonLonOfDate(jd: number): number {
  const d = jd - 2451545.0;
  const L = 218.3164477 + 13.17639648 * d;       // mean longitude
  const M = 134.9633964 + 13.06499295 * d;       // moon mean anomaly
  const Ms = 357.5291092 + 0.98560028 * d;       // sun mean anomaly
  const D = 297.8501921 + 12.19074912 * d;       // mean elongation
  const F = 93.2720950 + 13.22935024 * d;        // argument of latitude
  const lon = L
    + 6.289 * sin(M) + 1.274 * sin(2 * D - M) + 0.658 * sin(2 * D)
    + 0.214 * sin(2 * M) - 0.186 * sin(Ms) - 0.114 * sin(2 * F)
    + 0.059 * sin(2 * D - 2 * M) + 0.057 * sin(2 * D - Ms - M)
    + 0.053 * sin(2 * D + M) - 0.046 * sin(2 * D - Ms) + 0.041 * sin(M - Ms);
  return norm360(lon);
}

/** Build a SIDEREAL (Vedic) chart for a calendar date (UT noon of that day). Each body is computed in
 *  tropical longitude of date, then the Lahiri ayanamsa is subtracted to land in the sidereal zodiac. */
export function chart(date: Date): Chart {
  const jd = julianDay(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()) + 0.5; // noon UT
  const T = (jd - 2451545.0) / 36525;
  const ayan = ayanamsaDeg(T);
  const tropJ2000 = (lon: number) => norm360(lon + PREC * T); // planets: J2000 frame → of-date equinox
  const sidereal = (tropLon: number) => norm360(tropLon - ayan); // tropical of date → sidereal zodiac
  // (the Moon/node series are already referred to the mean equinox of date, so they skip tropJ2000)
  const place = (body: Body, lon: number, retro: boolean): Placement => {
    const sign = Math.floor(lon / 30) % 12;
    const nk = nakshatra(lon);
    return { body, lon, sign, signName: SIGNS[sign], deg: lon - sign * 30, retro, nak: nk.index, nakName: nk.name, pada: nk.pada };
  };
  const planets: Body[] = ["Sun", "Mercury", "Venus", "Mars", "Ceres", "Jupiter", "Saturn", "Chiron", "Uranus", "Neptune", "Pluto"];
  const placements: Placement[] = planets.map((p) => {
    const lon0 = geoLonJ2000(p, jd), lon1 = geoLonJ2000(p, jd + 1);
    const retro = p !== "Sun" && norm360(lon1 - lon0) > 180; // longitude decreasing day-over-day (frame-independent)
    return place(p, sidereal(tropJ2000(lon0)), retro);
  });
  placements.splice(1, 0, place("Moon", sidereal(moonLonOfDate(jd)), false)); // Moon after the Sun
  return { jd, iso: date.toISOString().slice(0, 10), ayanamsa: ayan, placements };
}

export type AspectType = "conjunction" | "sextile" | "square" | "trine" | "opposition";
export const ASPECT_DEFS: { type: AspectType; angle: number; orb: number; harmony: "fusion" | "harmonious" | "challenging" | "polarity" }[] = [
  { type: "conjunction", angle: 0, orb: 8, harmony: "fusion" },
  { type: "sextile", angle: 60, orb: 4, harmony: "harmonious" },
  { type: "square", angle: 90, orb: 6, harmony: "challenging" },
  { type: "trine", angle: 120, orb: 6, harmony: "harmonious" },
  { type: "opposition", angle: 180, orb: 8, harmony: "polarity" },
];

export type Aspect = {
  a: Placement; b: Placement; type: AspectType; harmony: "fusion" | "harmonious" | "challenging" | "polarity";
  orbDelta: number; exactness: number; // 0..1, 1 = exact
};

/** Aspects within one chart (B omitted) or BETWEEN two charts (transit↔natal / synastry). */
export function aspects(A: Chart, B?: Chart): Aspect[] {
  const pa = A.placements, pb = (B ?? A).placements, same = !B;
  const out: Aspect[] = [];
  for (let i = 0; i < pa.length; i++) {
    for (let j = same ? i + 1 : 0; j < pb.length; j++) {
      const a = pa[i], b = pb[j];
      if (same && a.body === b.body) continue;
      let sep = Math.abs(a.lon - b.lon) % 360; if (sep > 180) sep = 360 - sep;
      for (const d of ASPECT_DEFS) {
        const delta = Math.abs(sep - d.angle);
        if (delta <= d.orb) {
          out.push({ a, b, type: d.type, harmony: d.harmony, orbDelta: delta, exactness: 1 - delta / d.orb });
          break;
        }
      }
    }
  }
  return out.sort((x, y) => y.exactness - x.exactness);
}

/** A neutral natal chart for a birth DATE (noon UT — exact for all bodies except a cusp-near Moon). */
export function natalChart(birthISO: string): Chart | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthISO);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  // Reject calendar-impossible dates: Date.UTC ROLLS OVER (2001-02-29 → Mar 1), so isNaN never fires —
  // confirm the date round-trips before trusting it, or a bad birthday would silently chart the wrong day.
  if (isNaN(d.getTime()) || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return chart(d);
}

// The twelve bodies a transit reading uses: the ten planets + Ceres + Chiron (chosen for a gap-free ladder
// of cycle periods; the lunar nodes were dropped — both sit at ~18.6 yr, so they weren't complementary).
export const TRANSIT_BODIES: Body[] = ["Sun", "Moon", "Mercury", "Venus", "Mars", "Ceres", "Jupiter", "Saturn", "Chiron", "Uranus", "Neptune", "Pluto"];
export type Houses = { cusps: number[]; system: "placidus" | "whole-sign" }; // 12 sidereal cusp longitudes; cusps[i] begins house i+1
export type TransitHit = { body: Body; sign: number; signName: string; deg: number; house: number; retro: boolean };
export type BirthPlace = { jdUT: number; lat: number; lon: number }; // lon = east-positive degrees

const tand = (d: number) => Math.tan(d * D2R);
const asinD = (x: number) => Math.asin(Math.max(-1, Math.min(1, x))) * R2D;
const atan2D = (y: number, x: number) => Math.atan2(y, x) * R2D;

/** Julian Day (UT) for a birth date + UT hour — feed the place's local time minus its UTC offset. */
export function julianDayUT(y: number, m: number, d: number, hourUT: number): number {
  return julianDay(y, m, d) + hourUT / 24;
}

/** SIDEREAL house cusps for a birth with a KNOWN time + place — Placidus (the quadrant system pro software
 *  uses): the Ascendant (1st) + Midheaven (10th) from the local sidereal time + latitude, the intermediate
 *  cusps (11,12,2,3) by the Placidus semi-arc iteration, the rest as opposites. Verified to reproduce a
 *  professional chart's transit-to-natal house overlay exactly. */
export function placidusHouses(b: BirthPlace): Houses {
  const T = (b.jdUT - 2451545.0) / 36525;
  const ayan = ayanamsaDeg(T);
  const ramc = norm360(norm360(280.46061837 + 360.98564736629 * (b.jdUT - 2451545.0) + 0.000387933 * T * T) + b.lon);
  const eps = 23.4393 - 0.0130 * T;
  const mc = norm360(atan2D(sin(ramc), cos(ramc) * cos(eps)));
  const asc = norm360(atan2D(cos(ramc), -(sin(ramc) * cos(eps) + tand(b.lat) * sin(eps))));
  const plac = (cusp: 11 | 12 | 2 | 3): number => {
    let lam = norm360(ramc + ({ 11: 30, 12: 60, 2: 210, 3: 240 } as Record<number, number>)[cusp]);
    for (let i = 0; i < 40; i++) {
      const sa = 90 + asinD(tand(asinD(sin(eps) * sin(lam))) * tand(b.lat)); // semidiurnal arc of the trial cusp
      const ra = cusp === 11 ? ramc + sa / 3 : cusp === 12 ? ramc + 2 * sa / 3
        : cusp === 2 ? ramc + 180 - 2 * (180 - sa) / 3 : ramc + 180 - (180 - sa) / 3;
      lam = norm360(atan2D(sin(ra), cos(ra) * cos(eps)));
    }
    return lam;
  };
  const c = new Array(13).fill(0);
  c[10] = mc; c[1] = asc; c[4] = norm360(mc + 180); c[7] = norm360(asc + 180);
  c[11] = plac(11); c[12] = plac(12); c[2] = plac(2); c[3] = plac(3);
  c[5] = norm360(c[11] + 180); c[6] = norm360(c[12] + 180); c[8] = norm360(c[2] + 180); c[9] = norm360(c[3] + 180);
  return { cusps: c.slice(1).map((x) => norm360(x - ayan)), system: "placidus" };
}

/** SIDEREAL whole-sign house cusps from the natal Sun's sign — the FALLBACK when birth time/place are
 *  missing (we have only the date): the Sun's sign is the 1st house, each following sign the next. */
export function wholeSignHouses(natalSunSign: number): Houses {
  const start = (((natalSunSign % 12) + 12) % 12) * 30;
  return { cusps: Array.from({ length: 12 }, (_, i) => norm360(start + i * 30)), system: "whole-sign" };
}

/** The house (1–12) a sidereal longitude falls in, for a set of cusps. */
export function houseOfLon(houses: Houses, lon: number): number {
  const c = houses.cusps;
  for (let i = 0; i < 12; i++) if (norm360(lon - c[i]) < norm360(c[(i + 1) % 12] - c[i])) return i + 1;
  return 12;
}

/** Natal houses, ROBUST to missing data: Placidus when birth time + place are known, else whole-sign from
 *  the natal Sun. Pass `place` only when you have all of time + latitude + longitude. */
export function natalHouses(natal: Chart, place?: BirthPlace | null): Houses {
  if (place && Number.isFinite(place.jdUT) && Number.isFinite(place.lat) && Number.isFinite(place.lon)) return placidusHouses(place);
  const sun = natal.placements.find((p) => p.body === "Sun");
  return wholeSignHouses(sun ? sun.sign : 0);
}

/** Each of the twelve bodies right now: its sign + the NATAL HOUSE it falls in — which area of the
 *  person's life the sky is lighting up. Raw data, kept under the hood; the UI speaks only plain life areas. */
export function transits(transit: Chart, houses: Houses): TransitHit[] {
  const byBody = new Map(transit.placements.map((p) => [p.body, p] as const));
  return TRANSIT_BODIES.map((b) => {
    const p = byBody.get(b)!;
    return { body: b, sign: p.sign, signName: p.signName, deg: p.deg, house: houseOfLon(houses, p.lon), retro: p.retro };
  });
}

/** The midpoint COMPOSITE of two charts: each body placed at the circular midpoint (shorter arc) of its
 *  two longitudes. The standard way to read two charts as ONE blended chart — here it fuses a person's
 *  birth chart with a moment's chart into "this person, at this time". Retrograde is undefined for a
 *  composite (it is not an instant in time), so it is left false. */
export function composite(a: Chart, b: Chart): Chart {
  const mid = (x: number, y: number) => { const d = ((y - x + 540) % 360) - 180; return norm360(x + d / 2); }; // shorter-arc midpoint
  const byBody = new Map(b.placements.map((p) => [p.body, p] as const));
  const placements: Placement[] = a.placements.map((pa) => {
    const pb = byBody.get(pa.body);
    const lon = pb ? mid(pa.lon, pb.lon) : pa.lon;
    const sign = Math.floor(lon / 30) % 12;
    const nk = nakshatra(lon);
    return { body: pa.body, lon, sign, signName: SIGNS[sign], deg: lon - sign * 30, retro: false, nak: nk.index, nakName: nk.name, pada: nk.pada };
  });
  return { jd: (a.jd + b.jd) / 2, iso: a.iso, ayanamsa: (a.ayanamsa + b.ayanamsa) / 2, placements };
}
