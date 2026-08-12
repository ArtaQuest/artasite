import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { chart, natalChart, natalHouses, transits, type Body } from "../lib/astro";
import { HOUSES, SIGN_APPROACH, PLANET_TIMESCALE } from "../lib/curriculum-astro";
import { STYLE_LABEL } from "../lib/typology-meta";
import { SYSTEMS, loadTypologies, typologiesReady } from "../lib/typologies";
import { currentUser, localePath, getCourseCards, type CourseCard } from "../lib/wp";
import { Card, PageHero, OrbitRings } from "../components/ui";
import { DomainGlyph } from "../components/catalogue";
import TrendChart from "../components/TrendChart";
import { Trends, type TrendSeries } from "../lib/api";

const ls = (k: string) => (typeof localStorage !== "undefined" ? localStorage.getItem(k) || "" : "");

type Cite = { text: string; href?: string };
type Cycle = {
  slug: string;     // motivation key — the /why/<slug>
  name: string;     // the cycle's plain name (the WHY label)
  body: Body;       // which transiting body keeps this cycle (engine-side; never shown as astrology)
  period: string;   // human period, e.g. "≈ 29.5 days"
  essence: string;  // a one-line study drive
  nature: string[]; // the documented natural / social cycle + its research, plain prose
  cites: Cite[];    // references behind it
};

// The twelve cycles, in ASCENDING period — each WHY paired with the documented natural, biological,
// economic or historical rhythm of the same length. The astronomy/astrology sits under the hood; the
// page speaks only of real, cited cycles in nature and society. Sourced from the project's cycle research.
const CYCLES: Cycle[] = [
  {
    slug: "reflecting", name: "Reflecting", body: "Moon", period: "≈ 29.5 days", essence: "look within, process, and renew",
    nature: [
      "The Moon runs through its phases in about 29.5 days, and living things keep time with it. The human menstrual cycle averages close to 29 days; the ocean's tides rise and fall with the Moon and swell at the new and full moon; and chronobiologists record circalunar (‘circatrigintan’, roughly 30-day) rhythms in physiology.",
      "It is the swiftest of the twelve cycles — the clock of mood, rest and renewal. Study under it in short, reflective passes: notice where you are, let what you have learned settle, and return.",
    ],
    cites: [
      { text: "Helfrich-Förster et al., menstrual cycles synchronising with the Moon, Science Advances (2021)" },
      { text: "Menstrual cycle — Wikipedia", href: "https://en.wikipedia.org/wiki/Menstrual_cycle" },
      { text: "Chronobiology: infradian / circalunar rhythms (Halberg)", href: "https://en.wikipedia.org/wiki/Infradian_rhythm" },
    ],
  },
  {
    slug: "understanding", name: "Questioning", body: "Mercury", period: "≈ 3 months", essence: "ask, learn, and make sense of it",
    nature: [
      "Mercury circles the Sun in about 88 days and turns retrograde three times a year, a natural rhythm of exchange and review. Human life keeps a matching beat: the academic term and the financial quarter both run about three months — the span over which we gather news, take stock and revise.",
      "It is the cycle of curiosity and communication. Study under it in question-first bursts: gather, compare, ask the sharper question — the heart of how this place learns.",
    ],
    cites: [
      { text: "Mercury (planet) — orbital period & retrogrades, Wikipedia", href: "https://en.wikipedia.org/wiki/Mercury_(planet)" },
      { text: "Academic term — the ~3-month quarter/semester, Wikipedia", href: "https://en.wikipedia.org/wiki/Academic_term" },
      { text: "Fiscal quarter — the business reporting cycle, Wikipedia", href: "https://en.wikipedia.org/wiki/Fiscal_year" },
    ],
  },
  {
    slug: "appreciating", name: "Appreciating", body: "Venus", period: "≈ 8 months (an 8-year return)", essence: "bond, savour, and value it",
    nature: [
      "Venus orbits in about 225 days, and its dance with Earth traces a near-perfect five-pointed star every eight years (13 Venus orbits ≈ 8 of ours) — one of the sky's most exact returns, known since antiquity. Its season is the long arc of courtship and ripening: attraction, growing, harvest of feeling.",
      "It is the cycle of beauty, bonds and worth. Study under it unhurriedly: dwell on what you love and let appreciation deepen over the months.",
    ],
    cites: [
      { text: "Venus — the 8-year pentagram (13:8 resonance with Earth), Wikipedia", href: "https://en.wikipedia.org/wiki/Venus" },
      { text: "Pentagram of Venus — the five-fold synodic pattern", href: "https://en.wikipedia.org/wiki/Pentagram_of_Venus" },
    ],
  },
  {
    slug: "becoming", name: "Becoming", body: "Sun", period: "≈ 1 year", essence: "grow into who you are",
    nature: [
      "The Earth's year around the Sun gives us the seasons — the master cycle of growth, harvest and rest that agriculture, the calendar and the body all follow. Chronobiology documents circannual (~one-year) rhythms in mood and physiology, including seasonal affective patterns tied to the changing light.",
      "It is the cycle of identity and renewal — the birthday, the fresh year. Study under it as a year-long arc: set a direction in spring, build through summer, harvest and reflect.",
    ],
    cites: [
      { text: "Circannual rhythm & seasonality — Wikipedia", href: "https://en.wikipedia.org/wiki/Circannual_rhythm" },
      { text: "Seasonal affective disorder — light & the annual cycle, Wikipedia", href: "https://en.wikipedia.org/wiki/Seasonal_affective_disorder" },
    ],
  },
  {
    slug: "pursuing", name: "Striving", body: "Mars", period: "≈ 2 years", essence: "push, contest, and get ahead",
    nature: [
      "Mars returns to the same place in our sky about every two years (its synodic cycle is ~2.14 years). The same biennial beat runs through human contest and through nature: the stratosphere's Quasi-Biennial Oscillation reverses its winds about every 28 months, and societies cluster their elections and their games (the Olympiad) on roughly two-year rhythms.",
      "It is the cycle of drive and assertion. Study under it as a focused campaign: pick a contest, push hard, and measure the gain over a season or two.",
    ],
    cites: [
      { text: "Quasi-biennial oscillation (~28 months) — Wikipedia", href: "https://en.wikipedia.org/wiki/Quasi-biennial_oscillation" },
      { text: "Mars — synodic period ~2.14 years, Wikipedia", href: "https://en.wikipedia.org/wiki/Mars" },
    ],
  },
  {
    slug: "craving", name: "Nurturing", body: "Ceres", period: "≈ 4–5 years", essence: "tend, nourish, and care for what matters",
    nature: [
      "Ceres — the largest body of the asteroid belt, named for the goddess of the harvest — orbits in about 4.6 years, filling the gap between the swift inner cycles and the long planetary ones. Its span matches the El Niño–Southern Oscillation, the 2-to-7-year ocean–atmosphere swing (averaging ~4 years) that, more than any other climate cycle, governs the world's harvests and food security.",
      "It is the cycle of care, cultivation and sustenance. Study under it patiently, tending what you are growing over a few years until it bears fruit.",
    ],
    cites: [
      { text: "El Niño–Southern Oscillation (2–7-year cycle) — Wikipedia", href: "https://en.wikipedia.org/wiki/El_Ni%C3%B1o%E2%80%93Southern_Oscillation" },
      { text: "ENSO impacts on agriculture & food security — NOAA Climate.gov", href: "https://www.climate.gov/enso" },
      { text: "Ceres (dwarf planet) — Wikipedia", href: "https://en.wikipedia.org/wiki/Ceres_(dwarf_planet)" },
    ],
  },
  {
    slug: "exploring", name: "Expanding", body: "Jupiter", period: "≈ 12 years", essence: "grow, venture, and seize the opening",
    nature: [
      "Jupiter circles the Sun in 11.9 years — almost exactly the length of the Sun's own Schwabe sunspot cycle (~11 years), which some solar physicists argue is itself tuned by the tides of Venus, Earth and Jupiter. Economies keep a kindred beat: the Juglar fixed-investment cycle runs 7–11 years, and East Asia has counted time in a 12-year calendar cycle for millennia, with Jupiter as its ‘Year Star’.",
      "It is the cycle of growth, boom and opportunity. Study under it expansively: follow what is opening up and let the field broaden over the decade.",
    ],
    cites: [
      { text: "Solar cycle (~11-year Schwabe cycle) — Wikipedia", href: "https://en.wikipedia.org/wiki/Solar_cycle" },
      { text: "Juglar cycle (7–11-year investment cycle) — Wikipedia", href: "https://en.wikipedia.org/wiki/Juglar_cycle" },
      { text: "Stefani et al., planetary tides & the solar cycle (Venus–Earth–Jupiter), arXiv" },
    ],
  },
  {
    slug: "mastering", name: "Building", body: "Saturn", period: "≈ 29 years", essence: "build something that lasts",
    nature: [
      "Saturn takes about 29.5 years to round the Sun — close to a human generation. Economic history records the matching Kuznets swing of ~15–25 years in infrastructure and building, and demographers measure a generation at roughly 25–30 years: the time it takes to mature, take responsibility, and hand on.",
      "It is the cycle of mastery, discipline and structure. Study under it as a long apprenticeship — build the foundations that will still stand a generation from now.",
    ],
    cites: [
      { text: "Kuznets swing (~15–25-year infrastructure cycle) — Wikipedia", href: "https://en.wikipedia.org/wiki/Kuznets_swing" },
      { text: "Generation — the ~25–30-year span, Wikipedia", href: "https://en.wikipedia.org/wiki/Generation" },
    ],
  },
  {
    slug: "transcending", name: "Healing", body: "Chiron", period: "≈ 50 years", essence: "heal, reckon, and make whole",
    nature: [
      "Chiron — a comet-like body orbiting between Saturn and Uranus — completes its circuit in about 50 years, the span of the great social long wave. Economists from Kondratiev onward chart a ~45–60-year wave of innovation, boom, saturation and renewal; the Hebrew Jubilee released debts every 50 years; and historians find generational reckonings with inherited wounds on a roughly half-century beat.",
      "It is the cycle of healing and reinvention across a working lifetime. Study under it as a reckoning — returning to an old wound or unfinished question to make it whole.",
    ],
    cites: [
      { text: "Kondratiev wave (~45–60-year long wave) — Wikipedia", href: "https://en.wikipedia.org/wiki/Kondratiev_wave" },
      { text: "Jubilee (biblical 50-year release) — Wikipedia", href: "https://en.wikipedia.org/wiki/Jubilee_(biblical)" },
      { text: "Turchin, secular cycles & the ‘fathers-and-sons’ rhythm" },
    ],
  },
  {
    slug: "rethinking", name: "Rethinking", body: "Uranus", period: "≈ 84 years", essence: "question the frame, break free, see anew",
    nature: [
      "Uranus orbits in 84 years — about a full human lifespan. The Sun keeps a cycle of nearly the same length: the Gleissberg modulation of solar activity runs ~80–90 years. And historians describe a ‘saeculum’ — the ~80–90-year cycle of four generational turnings (Strauss and Howe) — across which a society forgets and must re-learn its hardest lessons.",
      "It is the cycle of upheaval and fresh sight. Study under it by questioning the inherited frame — what does a whole lifetime of received wisdom get wrong?",
    ],
    cites: [
      { text: "Strauss–Howe generational theory (the ~80–90-year saeculum) — Wikipedia", href: "https://en.wikipedia.org/wiki/Strauss%E2%80%93Howe_generational_theory" },
      { text: "Gleissberg cycle (~87-year solar modulation) — Wikipedia", href: "https://en.wikipedia.org/wiki/Solar_cycle#Gleissberg_cycle" },
    ],
  },
  {
    slug: "reimagining", name: "Dreaming", body: "Neptune", period: "≈ 165 years", essence: "envision the era, dream something new",
    nature: [
      "Neptune takes about 165 years to round the Sun, the span of a cultural epoch. The Sun has a rhythm near it too — the ~178-year Jose cycle of the Sun's wobble about the Solar System's centre of mass — and cultural historians measure the great artistic and spiritual eras (the Romantic age, for one) on a similar scale.",
      "It is the slow cycle of imagination and vision. Study under it as a dreamer of eras — the ideas and images a whole age will live inside.",
    ],
    cites: [
      { text: "Jose cycle (~178.7-year solar inertial motion), Jose (1965)" },
      { text: "Romanticism — the cultural epoch, Wikipedia", href: "https://en.wikipedia.org/wiki/Romanticism" },
    ],
  },
  {
    slug: "transforming", name: "Transforming", body: "Pluto", period: "≈ 248 years", essence: "transform at the roots; rise and renew",
    nature: [
      "Pluto's orbit lasts about 248 years — the lifespan of empires. Sir John Glubb, surveying history, put the typical empire at about 250 years (ten generations), from pioneers through conquest and commerce to affluence and decline; cliodynamics finds ‘secular cycles’ of 200–300 years in the same data.",
      "It is the deepest, slowest cycle — root transformation, the rise and fall and renewal of whole orders. Study under it as the long game: the forces that remake civilisations.",
    ],
    cites: [
      { text: "John Glubb, ‘The Fate of Empires’ (~250-year lifespan)", href: "https://en.wikipedia.org/wiki/John_Bagot_Glubb" },
      { text: "Secular cycles / cliodynamics (Turchin), 200–300-year cycles", href: "https://en.wikipedia.org/wiki/Cliodynamics" },
    ],
  },
];
const BY_SLUG: Record<string, Cycle> = Object.fromEntries(CYCLES.map((c) => [c.slug, c]));

/**
 * The member's natal houses, from their date of birth alone.
 *
 * This used to derive a BIRTH LOCATION by taking the capital city of the member's stated
 * nationality — a crude proxy, but a location. Nationality stopped being collected on 2026-08-11
 * (operator), so that lookup could only ever resolve nothing, and place-of-birth — which would have
 * been the accurate input — was removed the same day. So: whole-sign houses off the Sun, which is
 * what natalHouses() falls back to without a place. Coarser, and honest about it. If a birth
 * location is ever collected again, pass it here and Placidus houses come back for free.
 */
function useNatalHouses() {
  const birth = currentUser()?.birthday || ls("aq_almanac_birth");
  return useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) return null;
    const natal = natalChart(birth);
    if (!natal) return null;
    return natalHouses(natal, null);
  }, [birth]);
}

// What this cycle's body lights up RIGHT NOW for this member: the field (its natal house) × style (its
// sign). Returns null when there's no birthday (the page still shows the research; the live picks need it).
function useFocusNow(body: Body) {
  const houses = useNatalHouses();
  return useMemo(() => {
    if (!houses) return null;
    const hit = transits(chart(new Date()), houses).find((h) => h.body === body);
    if (!hit) return null;
    const what = HOUSES[hit.house - 1];
    const howKey = SIGN_APPROACH[((hit.sign % 12) + 12) % 12];
    return { whatKey: what.key, whatLabel: what.label, howKey, howLabel: STYLE_LABEL[howKey] || howKey };
  }, [houses, body]);
}

function CycleDetail({ cycle }: { cycle: Cycle }) {
  useEffect(() => { document.title = `${cycle.name} — study cycles · ArtaQuest`; }, [cycle.name]);
  const focus = useFocusNow(cycle.body);
  const [ready, setReady] = useState(typologiesReady());
  const [courses, setCourses] = useState<CourseCard[] | null>(null);
  useEffect(() => { if (!ready) loadTypologies().then(() => setReady(true)).catch(() => {}); }, [ready]);
  useEffect(() => {
    if (!focus) { setCourses(null); return; }
    let on = true;
    getCourseCards("", null, 6, "trending", focus.whatKey).then((r) => { if (on) setCourses(r.items); }).catch(() => { if (on) setCourses([]); });
    return () => { on = false; };
  }, [focus]);

  const [trend, setTrend] = useState<TrendSeries | null>(null);
  useEffect(() => {
    let on = true;
    setTrend(null);
    Trends.get(`cycle:${cycle.slug}`).then((t) => { if (on) setTrend(t.found ? t : null); }).catch(() => {});
    return () => { on = false; };
  }, [cycle.slug]);

  const topics = useMemo(() => {
    if (!ready || !focus) return [];
    return SYSTEMS.filter((s) => s.house === focus.whatKey && s.sign === focus.howKey).slice(0, 24);
  }, [ready, focus]);

  const idx = CYCLES.findIndex((c) => c.slug === cycle.slug);
  const prev = CYCLES[(idx + CYCLES.length - 1) % CYCLES.length], next = CYCLES[(idx + 1) % CYCLES.length];

  return (
    <div className="flex flex-col gap-6 pb-12">
      <a href={localePath("/why/")} className="text-[13px] font-semibold text-ink-3 hover:text-yang">← All study cycles</a>
      <PageHero
        eyebrow="Study cycle" glyph={<DomainGlyph domain="course" />}
        title={cycle.name}
        lede={`The ${cycle.period} cycle — ${cycle.essence}.`}
        aside={<OrbitRings className="h-[116px] w-[116px] text-ink/70" />}
      />

      <Card className="flex flex-col gap-3 p-5 sm:p-6">
        <h2 className="text-[16px] font-bold tracking-tight">The cycle in nature</h2>
        {cycle.nature.map((p, i) => <p key={i} className="max-w-3xl text-[15px] leading-relaxed text-ink-2">{p}</p>)}
        <p className="text-[13px] text-ink-3">A recommendation under this cycle is worth about <b className="text-ink-2">{PLANET_TIMESCALE[cycle.body] || "a season"}</b> of study — a lens for curiosity and reflection, never a forecast.</p>
        <div className="mt-1 border-t border-line/60 pt-3">
          <h3 className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">References</h3>
          <ul className="mt-1.5 space-y-1">
            {cycle.cites.map((c, i) => (
              <li key={i} className="text-[13px] leading-relaxed text-ink-3">
                {c.href ? <a href={c.href} target="_blank" rel="noopener noreferrer" className="text-ink-2 underline decoration-line underline-offset-2 hover:text-yang">{c.text}</a> : c.text}
              </li>
            ))}
          </ul>
        </div>
      </Card>

      {trend && trend.series.length > 1 && (
        <Card className="flex flex-col gap-3 p-5 sm:p-6">
          <h2 className="text-[16px] font-bold tracking-tight">The evidence in real search</h2>
          <p className="max-w-3xl text-[14px] leading-relaxed text-ink-2">
            Worldwide Google searches for <b className="text-ink">“{trend.query}”</b> since 2004 — the rises and falls of real human attention to this theme. The cycle isn't a forecast; it's a rhythm you can watch people live.
          </p>
          <TrendChart series={trend.series} height={150} from="2004" to="today" showAxis label={`Worldwide search interest in ${trend.query}, 2004 to today`} className="text-ink-3" />
          <p className="text-[12px] text-ink-3">Source: Google Trends · worldwide · web search · interest scaled 0–100 against the all-time peak.{typeof trend.momentum === "number" && trend.momentum !== 0 ? ` Recent interest sits ${trend.momentum > 0 ? "well above" : "below"} its 2004 level.` : ""}</p>
        </Card>
      )}

      <Card className="flex flex-col gap-3 p-5 sm:p-6">
        <h2 className="text-[16px] font-bold tracking-tight">To study under this cycle now</h2>
        {focus ? (
          <>
            <p className="text-[14px] text-ink-2">Right now this cycle lights up <b style={{ color: "var(--color-yin-ink)" }}>{focus.howLabel}</b> <b className="text-ink">{focus.whatLabel}</b> — these topics and courses sit there.</p>
            {topics.length > 0 && (
              <div>
                <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Topics</h3>
                <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  {topics.map((t) => (
                    <li key={t.key}><a href={localePath(`/topics/${t.key}/`)} className="text-[14px] text-ink-2 hover:text-yin-light">{t.name}</a></li>
                  ))}
                </ul>
              </div>
            )}
            {courses && courses.length > 0 && (
              <div className="mt-1">
                <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Courses</h3>
                <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  {courses.map((c) => (
                    <li key={c.url}><a href={localePath(c.url)} className="line-clamp-1 text-[14px] text-ink-2 hover:text-yin-light">{c.title}</a></li>
                  ))}
                </ul>
              </div>
            )}
            {topics.length === 0 && (!courses || courses.length === 0) && <p className="text-[13px] text-ink-3">Nothing sits in that corner of the catalogue just now — this cycle moves on soon.</p>}
          </>
        ) : (
          <p className="text-[14px] text-ink-2">Add your birthday in <a href={localePath("/user-account/")} className="font-semibold text-yang hover:underline">your account</a> to see what this cycle lights up for you, or open the <a href={localePath("/")} className="font-semibold text-yang hover:underline">study compass on your home page</a>.</p>
        )}
      </Card>

      <div className="flex items-center justify-between gap-3 text-[13px]">
        <a href={localePath(`/why/${prev.slug}/`)} className="font-semibold text-ink-2 hover:text-yang">← {prev.name}</a>
        <a href={localePath(`/why/${next.slug}/`)} className="font-semibold text-ink-2 hover:text-yang">{next.name} →</a>
      </div>
    </div>
  );
}

function CycleIndex() {
  useEffect(() => { document.title = "Study cycles · ArtaQuest"; }, []);
  return (
    <div className="flex flex-col gap-6 pb-12">
      <PageHero
        eyebrow="Study cycles" glyph={<DomainGlyph domain="course" />}
        title="The twelve cycles"
        lede="Twelve natural rhythms — from the lunar month to the rise and fall of civilisations — each a lens on what is worth studying now. The swiftest first."
        aside={<OrbitRings className="h-[116px] w-[116px] text-ink/70" />}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CYCLES.map((c) => (
          <Card as="a" key={c.slug} href={localePath(`/why/${c.slug}/`)} className="group flex flex-col gap-1 p-5 transition-colors hover:border-yin-light/40">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--color-yang)" }}>{c.period}</span>
            <h2 className="text-[18px] font-bold tracking-tight transition-colors group-hover:text-yang">{c.name}</h2>
            <p className="text-[13.5px] leading-relaxed text-ink-3">{c.essence.charAt(0).toUpperCase() + c.essence.slice(1)}.</p>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function Why() {
  const { slug } = useParams();
  const cycle = slug ? BY_SLUG[slug] : undefined;
  return cycle ? <CycleDetail cycle={cycle} /> : <CycleIndex />;
}
