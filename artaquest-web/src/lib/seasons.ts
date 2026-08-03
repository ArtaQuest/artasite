/**
 * The Twelve Seasons — THE platform calendar (operator directives 2026-07-10).
 *
 * The year is a CYCLE of twelve fixed seasons on the sidereal (Lahiri) solar boundaries — the
 * same dates as the Indian solar calendar. Astrology is never named anywhere on the site.
 *
 * Every season is a card RANK — and nothing else (operator 2026-07-11: NO SUITS anywhere, no
 * content classification): the cycle opens at the QUEEN on 17 August (the height of the sun)
 * and runs Q 1 2 3 4 5 6 7 8 9 10 J — the life-cycle arc, the Jack closing it before the next
 * Queen. Each rank is TONED by its season's stability: the four initiating seasons BLUE (yin),
 * the four steady seasons GOLD (yang), the four adaptive seasons the gold→blue BLEND (whose
 * midpoint is pure neutral — gold and blue are exact complements). Each season is an ARCHETYPE:
 * ARTA (truth) wakes one virtue and defeats one named DRUJ (deceit) per season.
 *
 * A member subscribes to exactly ONE season — their WHAT (the topic family they follow), by
 * default the season they were born in (`aq_birthday`). The HOW is never chosen: it is the
 * running season's own craft.
 *
 * ⚠ Keep in exact sync with the PHP mirror `wp-content/plugins/aquest/src/Seasons.php`.
 * ⚠ No wheels: the cycle is drawn as a SINUSOID (operator 2026-07-10) — never a radial chart.
 */

/** The Library tab key a craft opens (Library.tsx TABS). */
export type CraftTab =
  | "games" | "music" | "book" | "audiobook" | "film" | "competition"
  | "illustration" | "model" | "translate" | "paper" | "system" | "animation";

/** A season's stability tone: "yin" (blue — the initiators), "yang" (gold — the steady keepers),
 *  "dual" (the gold→blue blend — the adaptive). Purely presentational; never named in copy. */
export type SeasonTone = "yin" | "yang" | "dual";

export type Season = {
  n: number;            // 1…12, cycle position (internal storage key; n=1 is the Ace season)
  key: string;          // stable slug (s1…s12)
  rank: string;         // card rank, in cycle order: "Q", "1"…"10", "J"
  tone: SeasonTone;     // stability colour: yin (blue), yang (gold), dual (the blend)
  keeper: string;       // the season archetype's name in the Wheel-of-Arta mythology (Crown … Nest)
  epithet: string;      // "the Champion", "the Artisan", …
  from: [number, number]; // [month, day] the season opens (sidereal-Lahiri solar ingress)
  craft: CraftTab;      // the Library tab of the season's own craft
  craftLabel: string;   // singular display label of the craft (Library labels are singular)
  createHref: string;   // where "create one" goes (Library tab; challenges page when one runs)
  traits: string;       // the season's character, three plain words
  arta: string;         // the VIRTUE Arta wakes in this season
  druj: string;         // the DRUJ villain's name — the vice Arta defeats
  vice: string;         // the villain's vice, spelled out
  legend: string;       // one-line mythology (the duel)
};

/* Cycle order: the QUEEN opens 17 August (the height of the sun); archetypes keep their fixed
 * date spans, the ranks anchor to that opening: Q, then 1…10, the Jack last. */
export const SEASONS: Season[] = [
  { n: 1, key: "s1", rank: "Q", tone: "yang", keeper: "Crown", epithet: "the Champion", from: [8, 17], craft: "film", craftLabel: "Film", createHref: "/challenges/film", traits: "generous glory · warmth that rules", arta: "generous glory, warmth that rules", druj: "Mask", vice: "pride, the false face worn for worship", legend: "The cycle opens at the height of the sun: Arta rules with generous warmth, and defeats Mask, the false face worn for worship." },
  { n: 2, key: "s2", rank: "1", tone: "dual", keeper: "Forge", epithet: "the Artisan", from: [9, 17], craft: "model", craftLabel: "Model", createHref: "/library/?type=model", traits: "craft · service · the patient maker", arta: "craft, service, the patient maker", druj: "Rust", vice: "contempt, the scorn that corrodes the work", legend: "Arta shapes the work with patient craft, and defeats Rust, the scorn that corrodes it." },
  { n: 3, key: "s3", rank: "2", tone: "yin", keeper: "Judge", epithet: "the Arbiter", from: [10, 17], craft: "competition", craftLabel: "Dataset", createHref: "/library/?type=competition", traits: "justice · mercy · the fair measure", arta: "justice, mercy, the fair measure", druj: "Stall", vice: "the measure that never falls — the verdict forever withheld", legend: "Arta lets the fair measure fall, and defeats Stall, the verdict forever withheld." },
  { n: 4, key: "s4", rank: "3", tone: "yang", keeper: "Ember", epithet: "the Alchemist", from: [11, 16], craft: "animation", craftLabel: "Animation", createHref: "/challenges/animation", traits: "rebirth · transformation · new life", arta: "rebirth, death turned to new life", druj: "Poison", vice: "obsession, the venom kept for vengeance", legend: "Arta turns what has died into new life, and defeats Poison, the venom kept for vengeance." },
  { n: 5, key: "s5", rank: "4", tone: "dual", keeper: "Torch", epithet: "the Mentor", from: [12, 16], craft: "book", craftLabel: "Book", createHref: "/challenges/book", traits: "wisdom · the guiding light", arta: "wisdom, the guiding light", druj: "Scourge", vice: "dogma, the guide turned punisher of all who stray", legend: "Arta lifts the guiding light, and defeats Scourge, the guide turned punisher of all who stray." },
  { n: 6, key: "s6", rank: "5", tone: "yin", keeper: "Stone", epithet: "the Architect", from: [1, 14], craft: "paper", craftLabel: "Paper", createHref: "/library/?type=paper", traits: "order that endures · endurance", arta: "the order that endures, endurance", druj: "Tomb", vice: "rigidity, the order sealed into a grave", legend: "Arta builds the order that endures, and defeats Tomb, the order sealed into a grave." },
  { n: 7, key: "s7", rank: "6", tone: "yang", keeper: "Lens", epithet: "the Visionary", from: [2, 13], craft: "illustration", craftLabel: "Illustration", createHref: "/challenges/illustration", traits: "true vision · clear sight · hope", arta: "true vision, the clear sight, hope", druj: "Mirage", vice: "delusion, the false image, cold abstraction", legend: "Arta wakes true vision, and defeats Mirage, the false image." },
  { n: 8, key: "s8", rank: "7", tone: "dual", keeper: "Tide", epithet: "the Mystic", from: [3, 14], craft: "system", craftLabel: "Typology", createHref: "/library/?type=system", traits: "compassion · depth · the lifting deep", arta: "compassion, the deep that lifts all", druj: "Undertow", vice: "dissolution, the deep that drowns", legend: "Arta wakes the deep that lifts every soul, and defeats Undertow, the deep that drowns." },
  { n: 9, key: "s9", rank: "8", tone: "yin", keeper: "Spark", epithet: "the Pioneer", from: [4, 14], craft: "games", craftLabel: "Game", createHref: "/library/?type=games", traits: "courage · first flame · play", arta: "courage, the first flame struck", druj: "Wildfire", vice: "fury, the fire that burns what it builds", legend: "Arta strikes the first flame, and defeats Wildfire, the fire that burns what it builds." },
  { n: 10, key: "s10", rank: "9", tone: "yang", keeper: "Grain", epithet: "the Provider", from: [5, 15], craft: "music", craftLabel: "Music", createHref: "/challenges/music", traits: "plenty · steadiness · the given harvest", arta: "plenty freely given, steadiness", druj: "Blight", vice: "hoarding, the harvest withheld and rotted", legend: "Arta gives the harvest freely, and defeats Blight, the harvest withheld and rotted." },
  { n: 11, key: "s11", rank: "10", tone: "dual", keeper: "Bridge", epithet: "the Communicator", from: [6, 15], craft: "translate", craftLabel: "Translation", createHref: "/library/?type=translate", traits: "the honest word · true connection", arta: "the honest word, true connection", druj: "Whisper", vice: "deceit, the poisoned rumour", legend: "Arta speaks the honest word across every distance, and defeats Whisper, the poisoned rumour." },
  { n: 12, key: "s12", rank: "J", tone: "yin", keeper: "Nest", epithet: "the Guardian", from: [7, 16], craft: "audiobook", craftLabel: "Audiobook", createHref: "/challenges/audiobook", traits: "tenderness · shelter · loyalty", arta: "tenderness, shelter, loyalty", druj: "Cage", vice: "clinging, the love that smothers", legend: "Arta shelters every tale told aloud, defeats Cage, the love that smothers — and the cycle turns anew." },
];


const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "17 Aug – 16 Sep" (the season's inclusive span; end = day before the next season opens). */
export function seasonSpan(s: Season): string {
  const next = SEASONS[s.n % 12];
  const end = new Date(Date.UTC(2026, next.from[0] - 1, next.from[1]));
  end.setUTCDate(end.getUTCDate() - 1);
  return `${s.from[1]} ${MONTH_SHORT[s.from[0] - 1]} – ${end.getUTCDate()} ${MONTH_SHORT[end.getUTCMonth()]}`;
}

/** The season containing a (month, day): the latest ingress boundary at or before the date wins
 * (fixed sidereal-Lahiri dates); before 14 Jan it wraps to the season that opened 16 Dec. */
export function seasonForMonthDay(month: number, day: number): Season {
  const d = month * 100 + day;
  let best = SEASONS[4], bestOpen = -1; // 1–13 Jan → the 16 Dec season (Torch, rank 4)
  for (const s of SEASONS) {
    const open = s.from[0] * 100 + s.from[1];
    if (open <= d && open > bestOpen) { best = s; bestOpen = open; }
  }
  return best;
}

export const seasonForDate = (d: Date): Season => seasonForMonthDay(d.getMonth() + 1, d.getDate());
export const currentSeason = (): Season => seasonForDate(new Date());

/** The member's season from a "YYYY-MM-DD" birthday (null when unset/invalid). */
export function seasonForBirthday(birthday?: string | null): Season | null {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(birthday || "");
  return m ? seasonForMonthDay(+m[1], +m[2]) : null;
}

export const seasonByN = (n?: number | null): Season | null =>
  (typeof n === "number" && n >= 1 && n <= 12 && SEASONS[n - 1]) || null;

/** The season's emblem avatar (bundled SVG in public/seasons/, served under the SPA build base —
 * `/seasons/…` in dev, `…/artaquest-theme/app/seasons/…` in prod, same pattern as topic-art).
 * SIGIL_REV busts the year-long edge cache whenever the art is redesigned — bump it in BOTH
 * mirrors (Seasons.php sigil_url) on every art change. */
export const SIGIL_REV = 4;
export const seasonAvatar = (n: number): string => (import.meta.env.BASE_URL || "/") + `seasons/s${n}.svg?v=${SIGIL_REV}`;

/* The fitted-phase families in research.json still carry the analysis engine's internal 12 phase
 * keys (historic names, never rendered). This maps them onto the cycle: the key order opens at
 * the 14 Apr span, which is cycle position n=9 (the Ace season opens 17 Aug) — hence +8. */
const PHASE_ORDER = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"];
export const seasonForPhase = (phase?: string | null): Season | null => {
  const i = PHASE_ORDER.indexOf(phase || "");
  return i >= 0 ? SEASONS[(i + 8) % 12] : null;
};

/** "Crown, the Champion" */
export const seasonTitle = (s: Season): string => `${s.keeper}, ${s.epithet}`;
