/**
 * Lightweight typology metadata + types — everything the rest of the app needs WITHOUT pulling in
 * the ~190 KB generated registry (typologies.data.json). The Profile page and the wp client import
 * from here so the heavy data only loads on the (lazy) Typology page itself. The full registry +
 * system-dependent helpers live in typologies.ts, which re-exports these.
 */

export type TypologyOption = {
  key: string; label: string; short?: string; desc: string;
  image?: string; // the option-group's headshot URL (optional — shown beside the label, ticket #66)
};
export type TypologyDimension = {
  key: string; name: string; low: string; high: string; desc: string;
  image?: string; // the dimension's profile picture (optional — ArtaPolish authors one per group/dimension)
};
export type TypologyFormat = "single" | "multi" | "spectrum";
export type TypologyStatus = "empirical" | "popular" | "traditional" | "cultural" | "demographic";

/** A real, verifiable academic reference for the framework behind a system — the peer-reviewed
 *  paper(s) or seminal work(s) it rests on, not the one-line `source`. Authored only by the
 *  ArtaPolish topic-improvement loop, which is forbidden from inventing one (every citation is a
 *  genuine, locatable publication). Rendered as a "References" list on the Topics page; `doi` wins
 *  over `url` as the link. Shown for empirical/traditional frameworks; absent for pure-for-fun ones. */
export type Citation = {
  title: string;     // the paper or work's title
  authors: string;   // e.g. "Costa, P. T., & McCrae, R. R." (or "Goldberg, L. R." / "Author et al.")
  year: number;      // year of publication
  venue?: string;    // journal, conference, or publisher (optional)
  doi?: string;      // a bare DOI, e.g. "10.1037/0022-3514.52.1.81" (preferred link; optional)
  url?: string;      // a stable URL when there is no DOI (optional)
};

export type TypologySystem = {
  key: string;
  name: string;
  category: string;
  status: TypologyStatus;
  statusNote: string;
  blurb: string;
  format: TypologyFormat;
  selfDescribe: boolean;
  source: string;
  options?: TypologyOption[];
  dimensions?: TypologyDimension[];
  video?: string;       // YouTube video id of a curated instructor explainer (optional)
  instructor?: string;  // the channel / instructor name for that video (optional)
  course?: string;      // internal ArtaQuest course URL once one exists for this system (optional)
  image?: string;       // the group's profile picture URL (optional — UI falls back to its letter avatar, ticket #67)
  citations?: Citation[]; // real academic references behind the framework (optional — ArtaPolish loop, never invented)
  author?: { id: number; name: string; slug: string }; // who authored this topic (DB-backed; default /u/arash)
  sponsor?: { name: string; url?: string; logo?: string }; // an industry sponsor of this topic (optional)
  // The video signature: WHAT (the field/house), HOW (a video FORMAT), WHY (a motivation). Stored in the
  // `sign`/`planet` columns for compactness (no astrology); default to the primary discipline's, editable.
  house?: string;  // house key (psychology … theology) — WHAT
  sign?: string;   // motivation key (curiosity … application) — WHY
  planet?: string; // format key (lecture … crashcourse) — HOW
};

export type TypologyCategory = { key: string; label: string; blurb: string; group: string };

/** A member's standing on a spectrum dimension. */
export type SpectrumLevel = "low" | "mid" | "high";

/** What a member has chosen for one system. */
export type Selection = { picks?: string[]; levels?: Record<string, SpectrumLevel>; self?: string };

/** The whole self-identification map a member saves, keyed by system key. */
export type Selections = Record<string, Selection>;

/** A resolved, human-readable public tag — what shows on the profile and what the server keeps. */
export type TypologyTag = {
  system: string;
  systemKey: string;
  category: string;
  key: string;
  label: string;
  short: string;
};

/** The top level of the taxonomy: a set of broad GROUPS, each holding a set of CATEGORIES (below),
 *  each category holding the self-ID systems. They run as a plain, sensible hierarchy from the
 *  innermost self outward to the lived, shared world. Faith (the religions) is a first-class group in
 *  its own right; the esoteric strands (astrology, divination, numerology) now sit WITHIN Self as the
 *  ways people read their own nature, while real astronomy sits under Knowledge, kept apart from
 *  astrology. The Typology page lays the groups out LEFT-ALIGNED — one
 *  labelled row per group, top to bottom, each row's category chips flowing left to right. */
// The 12 WHAT fields — popular single-word labels (operator 2026-06-22); KEYS kept stable so links +
// classifications don't break. Two keys changed MEANING: anthropology→Science, sociology→Technology
// (the catalogue's social-science disciplines were re-housed to their true fields; these now hold STEM).
// Operator label overrides (window.AQ_LABELS, injected by the theme from the aq_house_labels / aq_sign_labels
// options) — applied over the defaults below so the 12 FIELD + 12 STYLE labels are editable from Studio with
// no code change. Empty/missing → the default. The PHP applies the SAME overrides over identical defaults.
const AQ_LABEL_OV: { houses: Record<string, string>; signs: Record<string, string> } = (() => {
  const w = typeof window !== "undefined" ? (window as unknown as { AQ_LABELS?: { houses?: Record<string, string>; signs?: Record<string, string> } }).AQ_LABELS : undefined;
  return { houses: (w && w.houses) || {}, signs: (w && w.signs) || {} };
})();
const CATEGORY_DEFAULTS: { key: string; label: string }[] = [
  { key: "psychology", label: "Psychology" },       // the mind, behaviour, the self
  { key: "economics", label: "Economics" },         // economics, money, finance, markets
  { key: "communication", label: "Science" },       // science — physics, chemistry, biology, the cosmos
  { key: "history", label: "Family" },              // family, home, relationships, roots
  { key: "arts", label: "Arts" },                   // art, music, film, design, the creative
  { key: "medicine", label: "Health" },             // health, medicine, the body, fitness
  { key: "politics", label: "Politics" },           // government, power, law, justice
  { key: "anthropology", label: "Engineering" },    // engineering, building, making, applied science
  { key: "philosophy", label: "Philosophy" },       // meaning, ethics, logic, wisdom
  { key: "management", label: "Business" },          // business, leadership, enterprise, work
  { key: "sociology", label: "Sociology" },         // society, culture, community, the social
  { key: "theology", label: "Spirituality" },       // spirituality, religion, the transcendent
];
// HOUSE = SEASON: the 12 house slots ARE the twelve seasons of the year's cycle, 1:1 (a field
// belongs to the season its worldwide interest peaks in — fixed sidereal-Lahiri boundaries; see
// lib/seasons.ts). The houses therefore DISPLAY as their season archetypes, not academic names.
// Astrology is never named; the cycle is never drawn as a wheel.
const HOUSE_SEASON = ["Spark", "Grain", "Bridge", "Nest", "Crown", "Forge", "Judge", "Ember", "Torch", "Stone", "Lens", "Tide"];
export const CATEGORY_GROUPS = CATEGORY_DEFAULTS.map((g, i) => ({ key: g.key, label: HOUSE_SEASON[i] || g.label }));
// The same 12 houses displayed as their ACADEMIC FIELD names (the What axis) — the operator-overridable labels
// the "What · field" balance wheel and the backend's Topics::house_label() show. Window.AQ_LABELS.houses wins
// over the defaults, exactly as the PHP does, so a field renamed in Studio's Labels tab stays in sync everywhere.
// (CATEGORY_GROUPS, above, instead remaps these to the season keepers for the Topics-wheel/curriculum
// pages — keep the two distinct.) Mirrors STYLES, the How-axis equivalent.
export const FIELDS = CATEGORY_DEFAULTS.map((g) => ({ key: g.key, label: AQ_LABEL_OV.houses[g.key] || g.label }));

/* ── How (12 STYLES · signs) · Why (10 MOTIVATIONS · planets) ───────────────────────────────────────
 * Every topic/discipline/video/course carries EXACTLY THREE one-hot tags: a FIELD (what — its house), a
 * STYLE (how it's presented — the sign) and a MOTIVATION (why you'd watch — the planet). The triple is a
 * TAG; discovery searches the 2-grams What+Style or What+Motivation (288 total = 12×12 ∪ 12×12), composed
 * from each title's ranked `kw` keywords — never the 3-gram (operator 2026-06-22). Astrology is never named
 * in the UI (the date engine in astro.ts reads the sky under the hood). ⚠ STORAGE: the `sign` column holds
 * the STYLE key (HOW), the `planet` column holds the MOTIVATION key (WHY) — column names kept (note the SWAP
 * from the prior model). Keys mirror Topics::SIGNS (styles) / PLANETS (motivations) exactly. UI colour:
 * HOW renders BLUE (yin #2352E8), WHY renders GOLD (yang #E8B923), WHAT neutral ink. */
export const ASTRO_AXIS_MEANING = { house: "what", sign: "how" } as const; // WHY retired as a content tag (2026-06-24)
// Contrast/theme-aware brand-ink tokens (set by applyContrast per theme): blue=how (yin) brightens to a
// readable #9CB6FF on dark / canonical #2352E8 on light; gold=why (yang) reads on dark / deep amber on
// light. The hardcoded hex used to render the small "How · styles" axis label at Lc 21 on the dark canvas
// (live-audit critical); the var() keeps every axis-coloured label legible on both themes + every level.
export const AXIS_COLOR = { how: "var(--color-yin-ink)", why: "var(--color-yang-ink)" } as const;
// HOW — the 12 styles (column `sign`). `how` reads after "How:"; `kw` = ranked keywords for 2-gram search.
const STYLE_DEFAULTS: { key: string; label: string; how: string; kw: string[] }[] = [
  { key: "powerful", label: "Beginner", how: "a beginner-friendly start", kw: ["beginner", "for beginners", "introduction to", "basics", "getting started", "101"] },
  { key: "practical", label: "Practical", how: "hands-on and practical", kw: ["practical", "hands-on", "real-world", "applied", "how to", "step-by-step"] },
  { key: "quick", label: "Crash Course", how: "a quick crash course", kw: ["crash course", "explained", "in 10 minutes", "simply explained", "summary", "quick"] },
  { key: "calming", label: "Easy", how: "easy and approachable", kw: ["easy", "simple", "made simple", "for dummies", "made easy", "in plain english"] },
  { key: "dramatic", label: "Documentary", how: "a cinematic documentary", kw: ["documentary", "full documentary", "the story of", "explained", "history of", "famous"] },
  { key: "detailed", label: "Complete", how: "a complete, thorough course", kw: ["complete", "full course", "in-depth", "comprehensive", "detailed", "everything you need"] },
  { key: "balanced", label: "Animated", how: "an animated visual explainer", kw: ["animated", "animation", "visual", "illustrated", "visualized", "with animations"] },
  { key: "mysterious", label: "Dark", how: "the hidden, darker side", kw: ["dark side of", "the dark side", "hidden", "secrets of", "the truth about", "untold"] },
  { key: "epic", label: "Ultimate", how: "the ultimate big-picture guide", kw: ["ultimate guide", "everything about", "the story of", "complete guide", "deep dive", "epic"] },
  { key: "professional", label: "University", how: "a university-level lecture", kw: ["university", "lecture", "course", "advanced", "masterclass", "degree"] },
  { key: "innovative", label: "Modern", how: "modern and cutting-edge", kw: ["modern", "the future of", "cutting-edge", "new", "next-gen", "21st century"] },
  { key: "creative", label: "Creative", how: "creative and imaginative", kw: ["creative", "inspiring", "aesthetic", "artistic", "imaginative", "beautiful"] },
];
export const STYLES = STYLE_DEFAULTS.map((s) => ({ ...s, label: AQ_LABEL_OV.signs[s.key] || s.label }));
// WHY — the 12 motivations (column `planet`), one per body: the ten planets + Ceres (Nurturing) + Chiron (Healing).
// `why` reads after "Why:"; `kw` = ranked keywords for 2-gram search.
export const MOTIVATIONS: { key: string; label: string; why: string; kw: string[] }[] = [
  // Labels are tuned to each body's natural CYCLE (its orbital period ↔ a documented natural/social cycle); every
  // label is a genuine study-MOTIVE, never a state. Storage keys are kept verbatim so tagged topics need no reclass.
  { key: "becoming", label: "Becoming", why: "to become who you are", kw: ["becoming", "finding yourself", "self-discovery", "awakening", "flourishing", "realising"] },          // Sun · the year
  { key: "reflecting", label: "Reflecting", why: "to reflect and look within", kw: ["reflecting", "processing", "contemplating", "introspecting", "self-awareness", "pondering"] }, // Moon · the month
  { key: "understanding", label: "Questioning", why: "to question and understand it", kw: ["learning", "understanding", "making sense", "grasping", "comprehending", "clarifying"] }, // Mercury · the quarter
  { key: "appreciating", label: "Appreciating", why: "to appreciate and enjoy it", kw: ["loving", "enjoying", "appreciating", "admiring", "valuing", "savouring"] },               // Venus · the season
  { key: "pursuing", label: "Striving", why: "to strive and get ahead", kw: ["winning", "competing", "pursuing", "striving", "chasing", "driving"] },                              // Mars · two years
  { key: "exploring", label: "Expanding", why: "to expand and grow", kw: ["exploring", "expanding", "growing", "discovering", "broadening", "venturing"] },                        // Jupiter · the boom (~12 yr)
  { key: "mastering", label: "Building", why: "to build something that lasts", kw: ["mastering", "training", "practising", "perfecting", "upskilling", "honing"] },                 // Saturn · the generation (~29 yr)
  { key: "rethinking", label: "Rethinking", why: "to rethink it", kw: ["hacking", "questioning", "challenging", "rethinking", "disrupting", "reframing"] },                        // Uranus · the lifetime (~84 yr)
  { key: "reimagining", label: "Dreaming", why: "to dream up something new", kw: ["creating", "designing", "dreaming", "inventing", "reimagining", "envisioning"] },               // Neptune · the era (~165 yr)
  { key: "transforming", label: "Transforming", why: "to transform", kw: ["transforming", "changing", "overcoming", "evolving", "rebuilding", "reinventing"] },                   // Pluto · the age (~248 yr)
  // Ceres (the asteroid, ~4.6-yr harvest/nurture cycle) — nurture, care, cultivation, sustenance.
  // Storage key stays "craving" (legacy) so tagged topics need no reclassification — its LABEL is now Nurturing.
  // ⚠ topics tagged "craving" under the old Seeking/frontier meaning read as "Nurturing" until the content loop re-tags them.
  { key: "craving", label: "Nurturing", why: "to nurture and care for what matters", kw: ["caring", "nurturing", "wellbeing", "cultivating", "nourishing", "tending"] },
  // Chiron (the centaur, ~50-yr wounded-healer cycle) — healing and wholeness. (Key stays "transcending"; was the South Node/Ketu.)
  { key: "transcending", label: "Healing", why: "to heal and renew", kw: ["healing", "recovery", "renewal", "self-healing", "mending", "wholeness"] },
];
// HOW (style) lookups — `sign` column. (Legacy export names PEDAGOGY_* kept as aliases so consumers don't break.)
export const STYLE_LABEL: Record<string, string> = Object.fromEntries(STYLES.map((s) => [s.key, s.label]));
export const STYLE_HOW: Record<string, string> = Object.fromEntries(STYLES.map((s) => [s.key, s.how]));
export const STYLE_KW: Record<string, string[]> = Object.fromEntries(STYLES.map((s) => [s.key, s.kw]));
export const PEDAGOGIES = STYLES;                 // legacy alias (HOW lives on `sign` now)
export const PEDAGOGY_LABEL = STYLE_LABEL;        // legacy alias
export const PEDAGOGY_HOW = STYLE_HOW;            // legacy alias
// WHY (motivation) lookups — `planet` column.
export const MOTIVATION_LABEL: Record<string, string> = Object.fromEntries(MOTIVATIONS.map((m) => [m.key, m.label]));
export const MOTIVATION_WHY: Record<string, string> = Object.fromEntries(MOTIVATIONS.map((m) => [m.key, m.why]));
export const MOTIVATION_KW: Record<string, string[]> = Object.fromEntries(MOTIVATIONS.map((m) => [m.key, m.kw]));
// Each field's default STYLE (sign) + MOTIVATION (planet), mirroring Topics::HOUSE_STYLE / HOUSE_MOTIVATION.
export const HOUSE_STYLE: Record<string, string> = {
  psychology: "mysterious", economics: "practical", communication: "practical", history: "epic",
  arts: "creative", medicine: "practical", politics: "balanced", anthropology: "detailed",
  philosophy: "detailed", management: "professional", sociology: "innovative", theology: "calming",
};
export const HOUSE_MOTIVATION: Record<string, string> = {
  psychology: "understanding", economics: "pursuing", communication: "mastering", history: "understanding",
  arts: "appreciating", medicine: "mastering", politics: "understanding", anthropology: "understanding",
  philosophy: "reflecting", management: "pursuing", sociology: "craving", theology: "transcending",
};
export const HOUSE_PEDAGOGY = HOUSE_STYLE;        // legacy alias (HOW default per house)

/** The CATEGORIES — the middle level of the taxonomy. Each belongs to a GROUP (`group` = a group key
 *  above) and holds the self-ID systems. Kept here (small + stable) so the Profile page can group
 *  tags without importing the heavy registry. Listed in group order; within a group, in display order.
 *  Each category is a field of life; its systems are the ways that field categorises people
 *  (Politics → ideologies & nations, Psychology → traits & types, Religion → faiths & denominations…). */
export const CATEGORIES: TypologyCategory[] = [
  // ── Psychology ──
  { key: "psychology-clinical", group: "psychology", label: "Clinical Psychology", blurb: "Assessment and treatment of mental health and psychological disorders." },
  { key: "psychology-developmental", group: "psychology", label: "Developmental Psychology", blurb: "How people grow and change across the lifespan." },
  { key: "psychology-cognitive", group: "psychology", label: "Cognitive Psychology", blurb: "Memory, perception, attention, and how the mind processes information." },
  { key: "psychology-neuroscience", group: "psychology", label: "Neuroscience", blurb: "The brain and nervous system behind the mind and behaviour." },
  { key: "psychology-counseling", group: "psychology", label: "Counseling", blurb: "Guidance and therapeutic support for personal challenges." },
  { key: "traits", group: "psychology", label: "Personality Traits", blurb: "The measurable dimensions of personality — the trait models psychology uses to map how people differ." },
  { key: "psychology", group: "psychology", label: "Personality Types", blurb: "The type frameworks that sort people into kinds — from Myers-Briggs and the Enneagram to Jungian archetypes." },
  { key: "temperament", group: "psychology", label: "Temperament", blurb: "Your innate temperament — the classical and clinical models of inborn disposition." },
  { key: "disposition", group: "psychology", label: "Mindset & Outlook", blurb: "Your everyday cast of mind — introvert or extrovert, optimist or pessimist, fixed or growth." },
  { key: "colour-typology", group: "psychology", label: "Colour Personalities", blurb: "The popular four-colour personality systems used in coaching and teamwork. For insight, not science." },
  { key: "motivation", group: "psychology", label: "Motivation & Values", blurb: "What drives you and the values you hold — your motives, character strengths, and moral reasoning." },
  { key: "relationships", group: "psychology", label: "Relationships & Dating", blurb: "Your relationship status, what you're looking for, and what you value in a partner." },
  { key: "intimacy", group: "psychology", label: "Intimacy & Sexuality", blurb: "How you experience intimacy and sex. An adults-only space — included openly as part of comprehensive, judgement-free sex education." },
  { key: "parenting", group: "psychology", label: "Parenting & Caregiving", blurb: "How you raise children and care for others — your parenting style and where you are with family." },
  { key: "friendship", group: "psychology", label: "Friendship & Social Circles", blurb: "Your friendships and social circles — how you make friends, the company you keep, and your role in the group." },
  { key: "loving", group: "psychology", label: "Love Languages & Styles", blurb: "How you express and receive love — your love languages and love style." },
  { key: "attachment", group: "psychology", label: "Attachment & Bonding", blurb: "How you bond and attach in close relationships — your attachment style." },
  { key: "mental-health", group: "psychology", label: "Mental Health & Neurotype", blurb: "Mental-health experiences and your neurotype — shared only if you choose, in a supportive, de-stigmatising space." },
  { key: "habits", group: "psychology", label: "Daily Habits & Routines", blurb: "Your everyday rhythms — how you start the day, plan, and keep your space." },
  // ── Economics ──
  { key: "economics-finance", group: "economics", label: "Finance", blurb: "Markets, investment, and the management of money over time." },
  { key: "economics-accounting", group: "economics", label: "Accounting", blurb: "Measuring, recording, and reporting economic activity." },
  { key: "economics-behavioral", group: "economics", label: "Behavioural Economics", blurb: "How real human psychology shapes economic choices." },
  { key: "economics-econometrics", group: "economics", label: "Econometrics", blurb: "Statistical methods applied to economic data." },
  { key: "economics-development", group: "economics", label: "Development Economics", blurb: "Growth, poverty, and the economics of developing nations." },
  { key: "economics", group: "economics", label: "Economic Thought", blurb: "The schools of economic thought and systems you favour." },
  { key: "money", group: "economics", label: "Money & Finance", blurb: "How you relate to money, saving, risk, and your means." },
  // ── Communication ──
  { key: "communication-applied-linguistics", group: "communication", label: "Applied Linguistics", blurb: "Language in real-world use, learning, and translation." },
  { key: "communication-sociolinguistics", group: "communication", label: "Sociolinguistics", blurb: "How language varies with society, region, and identity." },
  { key: "communication-comm-studies", group: "communication", label: "Communication Studies", blurb: "How messages are made, shared, and understood." },
  { key: "communication-media-studies", group: "communication", label: "Media Studies", blurb: "Media, journalism, and their role in society." },
  { key: "communication-education", group: "communication", label: "Education", blurb: "Teaching, learning, and the science of how we learn." },
  { key: "communication", group: "communication", label: "Language & Expression", blurb: "The languages you speak and the way you express and connect with others." },
  { key: "mother-tongue", group: "communication", label: "Mother Tongue", blurb: "The language family of your first language — the roots of how you speak." },
  { key: "culture", group: "communication", label: "Media & News", blurb: "Where you get your news and how you take in media." },
  { key: "fandoms", group: "communication", label: "Fandoms & Fictional Worlds", blurb: "The fictional worlds you belong to — which house, faction, or character you are." },
  { key: "technology", group: "communication", label: "Technology & Digital Life", blurb: "How you build with, use, and relate to technology." },
  { key: "education", group: "communication", label: "Learning & Education", blurb: "How you learn, think, and take in the world." },
  // ── History ──
  { key: "history-archaeology", group: "history", label: "Archaeology", blurb: "The human past read from material remains." },
  { key: "history-anthropology", group: "history", label: "Anthropology", blurb: "Humanity across time and cultures." },
  { key: "history-cultural-studies", group: "history", label: "Cultural Studies", blurb: "How cultures, traditions, and meanings form and change." },
  { key: "history-art-history", group: "history", label: "Art History", blurb: "Art, its movements, and their place in history." },
  { key: "history-developmental-psychology", group: "history", label: "Developmental Psychology", blurb: "How human development has shaped peoples and societies." },
  { key: "humanities", group: "history", label: "History & Outlook", blurb: "The history you come from and the cultural outlook you carry." },
  { key: "nationality", group: "history", label: "Nationality & Citizenship", blurb: "The country and citizenship you belong to." },
  // ── Arts ──
  { key: "arts-fine-arts", group: "arts", label: "Fine Arts", blurb: "Painting, sculpture, and the visual fine-art traditions." },
  { key: "arts-creative-writing", group: "arts", label: "Creative Writing", blurb: "Fiction, poetry, and the craft of writing." },
  { key: "arts-design", group: "arts", label: "Design", blurb: "Visual, product, and experience design." },
  { key: "arts-performing-arts", group: "arts", label: "Performing Arts", blurb: "Theatre, live music, and the stage." },
  { key: "arts-film-studies", group: "arts", label: "Film Studies", blurb: "Cinema, its history, and the language of film." },
  { key: "arts", group: "arts", label: "Visual Art & Aesthetics", blurb: "Your taste in visual art and the aesthetics you live in — including the photography you love to make." },
  { key: "music", group: "arts", label: "Music & Sound", blurb: "The music you make and love — the genres, instruments, and the way you listen." },
  { key: "fashion", group: "arts", label: "Fashion & Style", blurb: "Your personal style — fashion, colour analysis, and the way you present yourself." },
  { key: "stories", group: "arts", label: "Books, Film & TV", blurb: "The stories you love — the books you read and the films and shows you watch." },
  { key: "design", group: "arts", label: "Architecture & Design", blurb: "The built and designed world you admire — architecture, interiors, and design." },
  { key: "dance", group: "arts", label: "Dance & Movement", blurb: "The dance and movement styles you love." },
  { key: "games", group: "arts", label: "Games & Play", blurb: "The games you love and who you are in them — tabletop, video, and classic games." },
  // ── Medicine ──
  { key: "medicine-nursing", group: "medicine", label: "Nursing", blurb: "Patient care and the nursing professions." },
  { key: "medicine-public-health", group: "medicine", label: "Public Health", blurb: "The health of populations and the prevention of disease." },
  { key: "medicine-veterinary", group: "medicine", label: "Veterinary Medicine", blurb: "The health and medicine of animals." },
  { key: "medicine-biomedical", group: "medicine", label: "Biomedical Sciences", blurb: "The science underpinning medicine and the body." },
  { key: "medicine-pharmacy", group: "medicine", label: "Pharmacy", blurb: "Medicines, their action, and their safe use." },
  { key: "medicine", group: "medicine", label: "Medicine & Health Sciences", blurb: "The fields of medicine and health science you're drawn to." },
  { key: "genetics", group: "medicine", label: "Genetics & Heredity", blurb: "The traits you were born with — blood group, inherited features, and physical build." },
  { key: "sports", group: "medicine", label: "Sport & Fitness", blurb: "How you train, move, and compete — the sports and fitness worlds you belong to." },
  { key: "substance-use", group: "medicine", label: "Substance Use", blurb: "Your relationship with alcohol, smoking, and other substances — neutral and judgment-free." },
  { key: "sleep", group: "medicine", label: "Sleep & Rest", blurb: "Your sleep — when you're at your best and how you rest." },
  { key: "disability", group: "medicine", label: "Disability & Access", blurb: "Disability and accessibility — your lived experience, shared only if you choose." },
  // ── Law ──
  { key: "law-international", group: "politics", label: "International Law", blurb: "Law between nations and across borders." },
  { key: "law-criminal", group: "politics", label: "Criminal Law", blurb: "Crime, punishment, and the criminal justice system." },
  { key: "law-business", group: "politics", label: "Business Law", blurb: "The law of commerce, contracts, and companies." },
  { key: "law-conflict-resolution", group: "politics", label: "Conflict Resolution", blurb: "Mediation, negotiation, and resolving disputes." },
  { key: "law-political-science", group: "politics", label: "Political Science", blurb: "Government, power, and political systems." },
  { key: "law", group: "politics", label: "Law & Justice", blurb: "How you think about law, rights, justice, and the rules we live by." },
  // ── Anthropology ──
  { key: "anthropology-cultural", group: "anthropology", label: "Cultural Anthropology", blurb: "Living cultures, customs, and ways of life." },
  { key: "anthropology-forensic", group: "anthropology", label: "Forensic Anthropology", blurb: "Human remains in legal and historical investigation." },
  { key: "anthropology-religious-studies", group: "anthropology", label: "Religious Studies", blurb: "Religions studied across human cultures." },
  { key: "anthropology-sociology", group: "anthropology", label: "Sociology", blurb: "Society and social life, cross-culturally." },
  { key: "anthropology-psychology", group: "anthropology", label: "Psychology", blurb: "Mind and behaviour across cultures." },
  { key: "ethnicity", group: "anthropology", label: "Ethnicity & Ancestry", blurb: "Your ethnic background and ancestral heritage — the peoples and places you descend from." },
  { key: "travel", group: "anthropology", label: "Travel & Places", blurb: "How you explore the world — the places you've been and the kind of traveller you are." },
  { key: "nature", group: "anthropology", label: "Nature & Climate", blurb: "How you relate to the living world and the climate you live in and care about." },
  { key: "landscapes", group: "anthropology", label: "Landscapes & Wonders", blurb: "The landscapes, natural wonders, and outdoor places that move you." },
  { key: "wildlife", group: "anthropology", label: "Animals & Plants", blurb: "The animals you feel a kinship with and your relationship with growing things." },
  { key: "seasons", group: "anthropology", label: "Seasons & Weather", blurb: "The season and weather you feel most at home in." },
  { key: "world-cuisine", group: "anthropology", label: "World Cuisines", blurb: "The world's cuisines you most love to eat and explore." },
  { key: "food", group: "anthropology", label: "Food & Drink", blurb: "What and how you eat and drink — diet, taste, cooking, coffee or tea." },
  // ── Philosophy ──
  { key: "philosophy-metaphysics", group: "philosophy", label: "Metaphysics", blurb: "The fundamental nature of reality and being." },
  { key: "philosophy-ethics", group: "philosophy", label: "Ethics", blurb: "Right, wrong, and how we ought to live." },
  { key: "philosophy-epistemology", group: "philosophy", label: "Epistemology", blurb: "The theory of knowledge and justified belief." },
  { key: "philosophy-religious-studies", group: "philosophy", label: "Religious Studies", blurb: "Religion examined philosophically." },
  { key: "philosophy-astrophysics", group: "philosophy", label: "Astrophysics", blurb: "The physics of stars, galaxies, and the cosmos." },
  { key: "philosophy", group: "philosophy", label: "Philosophy", blurb: "The philosophical school and worldview you lean toward." },
  { key: "ethics", group: "philosophy", label: "Ethics & Morality", blurb: "How you tell right from wrong — your ethical framework and the moral foundations you weigh." },
  { key: "existence", group: "philosophy", label: "Meaning & Existence", blurb: "The big existential questions — what gives life meaning, your stance on God, and your view of death." },
  { key: "free-will", group: "philosophy", label: "Free Will & Fate", blurb: "Where you stand on free will, determinism, and fate." },
  { key: "knowledge-truth", group: "philosophy", label: "Truth & Knowledge", blurb: "How you decide what is true — your theory of knowledge." },
  { key: "reality", group: "philosophy", label: "Nature of Reality", blurb: "Your view of what reality fundamentally is." },
  { key: "science", group: "philosophy", label: "Science & Discovery", blurb: "The scientific fields that fascinate you and how you engage with science." },
  { key: "astronomy", group: "philosophy", label: "Astronomy & Cosmos", blurb: "The night sky and the universe as astronomers chart it — planets, stars, galaxies, and deep space (the real science, distinct from astrology)." },
  { key: "mathematics", group: "philosophy", label: "Mathematics & Logic", blurb: "The branches of mathematics and formal logic that draw you in." },
  // ── Management ──
  { key: "management-business-admin", group: "management", label: "Business Administration", blurb: "Running organisations and enterprises." },
  { key: "management-public-admin", group: "management", label: "Public Administration", blurb: "Governing and running public institutions." },
  { key: "management-org-psychology", group: "management", label: "Organizational Psychology", blurb: "People, behaviour, and culture at work." },
  { key: "management-leadership", group: "management", label: "Leadership Studies", blurb: "How leaders guide people and organisations." },
  { key: "management-political-science", group: "management", label: "Political Science", blurb: "Politics, policy, and governance." },
  { key: "work", group: "management", label: "Work & Career", blurb: "Your vocational interests, career anchors, and where you work best." },
  { key: "leadership", group: "management", label: "Leadership & Teams", blurb: "How you lead, handle conflict, and the role you play on a team." },
  // ── Sociology ──
  { key: "sociology-social-work", group: "sociology", label: "Social Work", blurb: "Supporting people and communities in need." },
  { key: "sociology-criminology", group: "sociology", label: "Criminology", blurb: "Crime, deviance, and society's response." },
  { key: "sociology-political-science", group: "sociology", label: "Political Science", blurb: "Politics and the life of society." },
  { key: "sociology-urban-studies", group: "sociology", label: "Urban Studies", blurb: "Cities, communities, and how they work." },
  { key: "sociology-network-science", group: "sociology", label: "Network Science", blurb: "The structure of social and complex networks." },
  { key: "identity", group: "sociology", label: "Status & Standing", blurb: "Your social standing — the education and class you identify with. Everything here is public, a statement you choose to make." },
  { key: "gender", group: "sociology", label: "Gender & Pronouns", blurb: "Your gender, sex assigned at birth, and pronouns — described in your own terms. Shared only if you choose." },
  { key: "orientation", group: "sociology", label: "Sexual & Romantic Orientation", blurb: "Who you are drawn to, romantically and sexually — in your own terms. Shared only if you choose." },
  { key: "community", group: "sociology", label: "Community & Causes", blurb: "The communities you belong to, the causes you support, and where you call home." },
  { key: "subcultures", group: "sociology", label: "Subcultures & Scenes", blurb: "The subcultures, scenes, and tribes you feel part of." },
  { key: "lifestyle", group: "sociology", label: "Lifestyle & Preferences", blurb: "The everyday this-or-that choices that quietly define you — cat or dog, beach or mountains, planner or free spirit." },
  { key: "politics", group: "sociology", label: "Politics & Ideology", blurb: "Where you stand on how society should be run." },
  { key: "family", group: "sociology", label: "Family & Upbringing", blurb: "The family you grew up in — its shape and your place in it." },
  { key: "generation", group: "sociology", label: "Generation & Age", blurb: "The generation you belong to — Boomer, Gen X, Millennial, Gen Z, and beyond." },
  // ── Theology ──
  { key: "theology-religious-studies", group: "theology", label: "Religious Studies", blurb: "Faiths, scriptures, and the world's religious traditions." },
  { key: "theology-philosophy", group: "theology", label: "Philosophy of Religion", blurb: "Reason, faith, and the philosophy of the transcendent." },
  { key: "theology-psychology", group: "theology", label: "Psychology of Religion", blurb: "The psychology of faith, ritual, and meaning." },
  { key: "theology-anthropology", group: "theology", label: "Anthropology of Religion", blurb: "Religion across human cultures." },
  { key: "theology-counseling", group: "theology", label: "Pastoral Counseling", blurb: "Pastoral and spiritual care." },
  { key: "abrahamic", group: "theology", label: "Abrahamic Faiths", blurb: "The Christian, Islamic, and Jewish traditions and their denominations — described respectfully and even-handedly. Public only if you choose to share it." },
  { key: "dharmic", group: "theology", label: "Dharmic & Eastern Faiths", blurb: "The Buddhist, Hindu, and other Eastern traditions — described respectfully and even-handedly. Public only if you choose to share it." },
  { key: "spirituality", group: "theology", label: "Spirituality & Practice", blurb: "How you practise and experience the spiritual, whether religious or secular." },
  { key: "worldview-faith", group: "theology", label: "Religion or Worldview", blurb: "Where you stand overall — a religion, a spirituality, or a secular worldview." },
  { key: "devotion", group: "theology", label: "Devotion & Observance", blurb: "How observant you are and how you live your faith day to day." },
  { key: "religious-upbringing", group: "theology", label: "Faith You Were Raised In", blurb: "The faith, if any, you were raised in — which may differ from where you stand now." },
  { key: "metaphysics", group: "theology", label: "Mind, Body & Energy", blurb: "Traditional mind–body systems that map your constitution, energy or type — from energy centres and body types to the hand — popular self-identification, not science." },
  { key: "numerology", group: "theology", label: "Numerology & Cards", blurb: "Meaning read from numbers and cards — your life-path number and tarot birth card. Popular belief, not science." },
  // (The three birth-sign categories were PURGED with the astrology framing, 2026-07-10 — the
  // platform's only calendar is the twelve seasons; do not re-add them.)
  { key: "mythology", group: "theology", label: "Mythology & Legend", blurb: "The myths, pantheons, and gods you're drawn to — the legends you see yourself in." },
];

const STATUS_LABEL: Record<TypologyStatus, string> = {
  empirical: "Research-based",
  popular: "Popular framework",
  traditional: "Traditional",
  cultural: "Cultural / for fun",
  demographic: "Self-identification",
};
export function statusLabel(s: TypologyStatus): string {
  return STATUS_LABEL[s] ?? s;
}

/** Cache-busting revision for the SELF-HOSTED icon assets — the `public/topic-art/*.svg` files and
 *  the `/aq/v1/emblem` endpoint. Both live at STABLE URLs (no content hash) served with a long
 *  immutable cache (topic-art: `max-age=1y`; emblem: `immutable`), AND the service worker serves
 *  everything under the app dir cache-first across every cache. So when their CONTENT changes — as in
 *  ticket #97, which made them background-less + theme-adaptive — a RETURNING visitor keeps seeing the
 *  old bytes forever: a plain SW cache-version bump cannot help, because the SW's revalidating
 *  `fetch()` just re-reads the same 1-year HTTP-cached URL. The only reliable busting is a NEW URL, so
 *  we stamp one here. **Bump this whenever a topic-art SVG, the favicon, or the emblem markup changes.** */
export const ICON_REV = "4"; // 4: re-stamp the #146 South Park redraw — v3 shipped the JS that requests `?v=3`, but the
// transparent SVG BYTES never reached prod (prod kept serving the first ship's grey-disc files), so every cache pinned
// `?v=3` → grey-disc. Re-deploying the transparent bytes at the SAME url can't reach those caches; a fresh `?v=4` url can.

/** Append the icon revision so a changed stable-URL asset reaches returning visitors (idempotent). */
function withIconRev(url: string): string {
  if (url.includes(`?v=${ICON_REV}`) || url.includes(`&v=${ICON_REV}`)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${ICON_REV}`;
}

/** Resolve a topic/group `image` value to a loadable URL. Real canonical images (Wikimedia Commons,
 *  official media APIs — Rick & Morty style) are stored as absolute `https://…` URLs and pass through
 *  untouched, as do `data:`/`blob:` URIs. A self-hosted bespoke SVG authored by the ArtaPolish loop is
 *  stored as a BASE-relative path (e.g. `"topic-art/big-five.svg"`, the file living in
 *  `public/topic-art/`); we prefix it with the SPA's build base so it resolves both in dev (served at
 *  `/topic-art/…`) and in prod (served under `…/artaquest-theme/app/topic-art/…`), AND stamp the icon
 *  revision (see ICON_REV) so the background-less redraw lands past the HTTP/SW cache. Self-hosted
 *  emblem URLs are likewise revisioned; other absolute origin paths pass through. */
export function resolveImage(img?: string): string {
  if (!img) return "";
  if (/^(data:|blob:)/i.test(img)) return img;                     // inline data — never cache-keyed
  if (/\/aq\/v1\/emblem(\?|$)/i.test(img)) return withIconRev(img); // self-hosted emblem — bust the baked-disc cache
  if (/^https?:/i.test(img)) return img;                           // third-party image — untouched
  if (img.startsWith("/")) return img;                             // other absolute origin path — untouched
  return withIconRev((import.meta.env.BASE_URL || "/") + img);     // self-hosted topic-art SVG — base-prefix + bust
}

/** A self-hosted brand profile emblem for a topic or one of its groups (GET /aq/v1/emblem) —
 *  deterministic, on-brand (gold/blue), background-less + theme-adaptive (ticket #97), and never 404s.
 *  Used as the fallback so EVERY topic and group shows a profile picture even when no explicit `image`
 *  is authored. Revisioned so a returning visitor drops the previous (baked dark-disc) emblem. */
export function emblemUrl(seed: string, label: string): string {
  return withIconRev(`/wp-json/aq/v1/emblem?seed=${encodeURIComponent(seed)}&label=${encodeURIComponent(label)}`);
}

/** A "learn this" target for a system: the ArtaQuest course if one exists, otherwise a curated
 *  instructor video, otherwise a YouTube search that surfaces explainer videos — so every system
 *  always has an instructor to watch. (The cycle curates specific videos + courses over time.) */
export function systemLearnUrl(sys: { name: string; video?: string; course?: string }): string {
  if (sys.course) return sys.course;
  if (sys.video) return `https://www.youtube.com/watch?v=${sys.video}`;
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(sys.name + " personality type explained")}`;
}

/** Is anything selected for this one system? (No registry needed.) */
export function hasSelection(sel?: Selection): boolean {
  if (!sel) return false;
  return Boolean((sel.picks && sel.picks.length) || (sel.levels && Object.keys(sel.levels).length) || (sel.self && sel.self.trim()));
}

/** Count the distinct tags a single system selection yields (for the per-card summary). */
export function selectionCount(sel?: Selection): number {
  if (!sel) return 0;
  let n = (sel.picks?.length ?? 0) + (sel.levels ? Object.keys(sel.levels).length : 0);
  if (sel.self && sel.self.trim()) n += 1;
  return n;
}
