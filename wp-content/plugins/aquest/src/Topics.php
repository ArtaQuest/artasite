<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Course subject taxonomy — the catalogue's facet/filter dimension.
 *
 * The subjects ARE the Topics "houses" — the 12 top-level category-groups of the typology registry
 * (Self, Roots, Meaning, Faith, Heart, Identity, Arts, World, Body, Living, Society,
 * Knowledge — kept in lockstep with CATEGORY_GROUPS in artaquest-web/src/lib/typology-meta.ts). The
 * catalogue and the Topics hub therefore browse by the SAME dimension: ArtaQuest is a humanitarian
 * platform whose courses help people understand humans, so a course belongs to the same house as the
 * topic it teaches (operator directive 2026-06-13 — replaced the old generic Udemy-style subjects
 * like "Programming"/"Business"). The course's house is set from its linked topic system where one
 * exists; the keyword scorer below is the offline fallback for an unlinked import.
 *
 * A course belongs to exactly ONE primary house, stored denormalized as the slug in aq_courses.topic
 * (indexed). Keeping it a single column — not a many-to-many pivot — preserves the catalogue's read
 * model: every list query stays one indexed keyset scan (WHERE status=? AND topic=? ORDER BY
 * rank_score,id), never a join + filesort, so faceted browsing read-scales to millions of courses
 * exactly like the unfiltered list (see ARCHITECTURE.md §2-3; Courses::list).
 *
 * Classification is a deterministic, dependency-free keyword scorer (no per-course API call): it
 * weights the title, channel and summary against each house's keyword set and picks the best match,
 * defaulting to OTHER. It runs at write time (Courses::create + the import tools) and as a one-time
 * backfill over existing rows on the schema bump (Schema::migrate → Topics::backfill). Being objective
 * + offline it never blocks a write and is trivially re-runnable.
 */
final class Topics {

	// Internal no-match sentinel for keyword_to_slug()/legacy filters — NOT a house. Every course and
	// topic resolves to one of the 12 real houses; there is no "Other" house in the facet.
	const OTHER = 'other';

	// Fallback house for the rare offline classify() with zero keyword hits (explicit classification
	// covers all real data, so this is a safety net only — never an "Other" bucket).
	const DEFAULT_HOUSE = 'psychology';

	/* ── How (STYLE · sign-aligned) · Why (MOTIVATION · planet-aligned) ─────────────────────────────
	 * Alongside its HOUSE (the field = WHAT), every discipline + topic + video carries a STYLE (HOW it is
	 * presented — 12, mapped to the signs) and a MOTIVATION (WHY you'd watch it — 10, mapped to the
	 * planets). The What·How·Why triple is a TAG/signature — it powers the balance wheels, the recommendation
	 * engine, and per-course consistency; discovery searches the field + a single best keyword, NEVER the raw
	 * triple (forced 3-grams like "Epic Transforming Politics" aren't real searches — operator 2026-06-22).
	 * No astrology is named in the UI (the date engine is client-side). For storage the existing aq_*.`sign`
	 * column holds the STYLE key (HOW) and `planet` holds the MOTIVATION key (WHY) — column + method names
	 * kept for legacy (note the SWAP: sign was motivation, planet was format). Keys mirror
	 * artaquest-web/src/lib/typology-meta.ts (STYLES on `sign`, MOTIVATIONS on `planet`). */
	const SIGNS = [ // HOW — styles (column `sign`), one per zodiac sign
		'powerful' => 'Beginner', 'practical' => 'Practical', 'quick' => 'Crash Course', 'calming' => 'Easy',
		'dramatic' => 'Documentary', 'detailed' => 'Complete', 'balanced' => 'Animated', 'mysterious' => 'Dark',
		'epic' => 'Ultimate', 'professional' => 'University', 'innovative' => 'Modern', 'creative' => 'Creative',
	];
	const PLANETS = [ // WHY — motivations (column `planet`), one per planet incl. the two lunar nodes (Rahu/Ketu)
		'becoming' => 'Becoming', 'reflecting' => 'Reflecting', 'understanding' => 'Questioning',
		'appreciating' => 'Appreciating', 'pursuing' => 'Striving', 'exploring' => 'Expanding',
		'mastering' => 'Building', 'rethinking' => 'Rethinking', 'reimagining' => 'Dreaming', 'transforming' => 'Transforming',
		'craving' => 'Nurturing', 'transcending' => 'Healing', // keys kept (no reclass): craving=Ceres/Nurturing · transcending=Chiron/Healing
	];
	// A sensible default STYLE (sign) + MOTIVATION (planet) per house; the editorial per-discipline map refines.
	const HOUSE_STYLE = [
		'psychology' => 'mysterious', 'economics' => 'practical', 'communication' => 'practical', 'history' => 'epic',
		'arts' => 'creative', 'medicine' => 'practical', 'politics' => 'balanced', 'anthropology' => 'detailed',
		'philosophy' => 'detailed', 'management' => 'professional', 'sociology' => 'innovative', 'theology' => 'calming',
	];
	const HOUSE_MOTIVATION = [
		'psychology' => 'understanding', 'economics' => 'pursuing', 'communication' => 'mastering', 'history' => 'understanding',
		'arts' => 'appreciating', 'medicine' => 'mastering', 'politics' => 'understanding', 'anthropology' => 'understanding',
		'philosophy' => 'reflecting', 'management' => 'pursuing', 'sociology' => 'craving', 'theology' => 'transcending',
	];

	private static $disc_list = null;  // cached editable discipline registry (cleared by bust_disc on any edit)
	private static $disc_index = null; // cached key => [house,label,sign,planet] index (cleared by bust_disc on any edit)

	/** Default STYLE (HOW · stored in the `sign` column) for a house. */
	public static function house_sign( $house ) { return self::HOUSE_STYLE[ $house ] ?? 'detailed'; }
	/** Default MOTIVATION (WHY · stored in the `planet` column) for a house. */
	public static function house_planet( $house ) { return self::HOUSE_MOTIVATION[ $house ] ?? 'understanding'; }
	public static function is_sign( $s ) { return is_string( $s ) && isset( self::SIGNS[ $s ] ); }       // style key (HOW)
	public static function is_planet( $p ) { return is_string( $p ) && isset( self::PLANETS[ $p ] ); }   // motivation key (WHY)
	public static function sign_label( $s ) { if ( null === self::$sign_ov ) { self::$sign_ov = (array) json_decode( (string) get_option( 'aq_sign_labels', '{}' ), true ); } $s = (string) $s; $ov = (string) ( self::$sign_ov[ $s ] ?? '' ); return '' !== $ov ? $ov : (string) ( self::SIGNS[ $s ] ?? '' ); }
	public static function planet_label( $p ) { return self::PLANETS[ $p ] ?? ''; }

	/**
	 * The 12 houses, in CATEGORY_GROUPS order. slug => [ label, keywords, subs ]. `label` is the chip
	 * text (no trailing punctuation, per brand voice) and MUST match the house label in typology-meta.ts;
	 * `keywords` are matched word-boundary-bounded (case-insensitive) against the course haystack by
	 * classify() — the fallback when a course has no linked topic system. Order here is the order
	 * facets() emits, so the filter bar reads in house order with OTHER last.
	 *
	 * `subs` is the SECOND level (ticket #89): a course-specific sub-taxonomy under each house — the
	 * concrete subjects a course actually teaches (Music, Photography, Physics…), distinct from the
	 * typology self-ID CATEGORIES (Personality Traits, Gender & Pronouns…) which don't map onto course
	 * subjects. Same shape (subslug => [ label, keywords ]); classify_sub() scores ONLY within the
	 * course's already-known house, so cross-house keyword overlaps are irrelevant and ties break by
	 * declaration order. The drill-down reveals these once a house is picked; a course matching no sub
	 * keeps subtopic='' (shows under "All <house>", never a dead chip). OTHER carries no subs.
	 */
	const ALL = [
		'psychology' => [ 'label' => 'Psychology', 'keywords' => [ 'psychology', 'psychological', 'personality', 'behaviour', 'behavior', 'mind', 'mental', 'cognitive', 'emotion', 'emotional', 'therapy', 'self', 'temperament', 'attachment', 'clinical psychology', 'clinical', 'developmental psychology', 'developmental', 'cognitive psychology', 'neuroscience', 'counseling', 'personality traits', 'traits', 'personality types', 'types', 'mindset outlook', 'mindset', 'outlook', 'colour personalities', 'colour', 'personalities', 'motivation values', 'motivation', 'values', 'relationships dating', 'relationships', 'dating', 'intimacy sexuality', 'intimacy', 'sexuality', 'parenting caregiving', 'parenting', 'caregiving', 'friendship social circles', 'friendship', 'social', 'circles', 'love languages styles', 'love', 'languages', 'styles', 'attachment bonding', 'bonding', 'mental health neurotype', 'health', 'neurotype', 'daily habits routines', 'daily', 'habits', 'routines' ], 'subs' => [
			'psychology-clinical' => [ 'label' => 'Clinical Psychology', 'keywords' => [ 'clinical psychology', 'clinical', 'psychology' ] ],
			'psychology-developmental' => [ 'label' => 'Developmental Psychology', 'keywords' => [ 'developmental psychology', 'developmental', 'psychology' ] ],
			'psychology-cognitive' => [ 'label' => 'Cognitive Psychology', 'keywords' => [ 'cognitive psychology', 'cognitive', 'psychology' ] ],
			'psychology-neuroscience' => [ 'label' => 'Neuroscience', 'keywords' => [ 'neuroscience' ] ],
			'psychology-counseling' => [ 'label' => 'Counseling', 'keywords' => [ 'counseling' ] ],
			'traits' => [ 'label' => 'Personality Traits', 'keywords' => [ 'personality traits', 'personality', 'traits' ] ],
			'psychology' => [ 'label' => 'Personality Types', 'keywords' => [ 'personality types', 'personality', 'types' ] ],
			'temperament' => [ 'label' => 'Temperament', 'keywords' => [ 'temperament' ] ],
			'disposition' => [ 'label' => 'Mindset & Outlook', 'keywords' => [ 'mindset outlook', 'mindset', 'outlook' ] ],
			'colour-typology' => [ 'label' => 'Colour Personalities', 'keywords' => [ 'colour personalities', 'colour', 'personalities' ] ],
			'motivation' => [ 'label' => 'Motivation & Values', 'keywords' => [ 'motivation values', 'motivation', 'values' ] ],
			'relationships' => [ 'label' => 'Relationships & Dating', 'keywords' => [ 'relationships dating', 'relationships', 'dating' ] ],
			'intimacy' => [ 'label' => 'Intimacy & Sexuality', 'keywords' => [ 'intimacy sexuality', 'intimacy', 'sexuality' ] ],
			'parenting' => [ 'label' => 'Parenting & Caregiving', 'keywords' => [ 'parenting caregiving', 'parenting', 'caregiving' ] ],
			'friendship' => [ 'label' => 'Friendship & Social Circles', 'keywords' => [ 'friendship social circles', 'friendship', 'social', 'circles' ] ],
			'loving' => [ 'label' => 'Love Languages & Styles', 'keywords' => [ 'love languages styles', 'love', 'languages', 'styles' ] ],
			'attachment' => [ 'label' => 'Attachment & Bonding', 'keywords' => [ 'attachment bonding', 'attachment', 'bonding' ] ],
			'mental-health' => [ 'label' => 'Mental Health & Neurotype', 'keywords' => [ 'mental health neurotype', 'mental', 'health', 'neurotype' ] ],
			'habits' => [ 'label' => 'Daily Habits & Routines', 'keywords' => [ 'daily habits routines', 'daily', 'habits', 'routines' ] ],
		] ],
		'economics' => [ 'label' => 'Economics', 'keywords' => [ 'economics', 'economy', 'economic', 'finance', 'financial', 'money', 'market', 'markets', 'trade', 'investment', 'accounting', 'macroeconomics', 'behavioural economics', 'behavioural', 'econometrics', 'development economics', 'development', 'economic thought', 'thought', 'money finance' ], 'subs' => [
			'economics-finance' => [ 'label' => 'Finance', 'keywords' => [ 'finance' ] ],
			'economics-accounting' => [ 'label' => 'Accounting', 'keywords' => [ 'accounting' ] ],
			'economics-behavioral' => [ 'label' => 'Behavioural Economics', 'keywords' => [ 'behavioural economics', 'behavioural', 'economics' ] ],
			'economics-econometrics' => [ 'label' => 'Econometrics', 'keywords' => [ 'econometrics' ] ],
			'economics-development' => [ 'label' => 'Development Economics', 'keywords' => [ 'development economics', 'development', 'economics' ] ],
			'economics' => [ 'label' => 'Economic Thought', 'keywords' => [ 'economic thought', 'economic', 'thought' ] ],
			'money' => [ 'label' => 'Money & Finance', 'keywords' => [ 'money finance', 'money', 'finance' ] ],
		] ],
		'communication' => [ 'label' => 'Science', 'keywords' => [ 'communication', 'language', 'linguistics', 'media', 'journalism', 'education', 'teaching', 'learning', 'rhetoric', 'literacy', 'applied linguistics', 'applied', 'sociolinguistics', 'communication studies', 'media studies', 'language expression', 'expression', 'mother tongue', 'mother', 'tongue', 'media news', 'news', 'fandoms fictional worlds', 'fandoms', 'fictional', 'worlds', 'technology digital life', 'technology', 'digital', 'life', 'learning education' ], 'subs' => [
			'communication-applied-linguistics' => [ 'label' => 'Applied Linguistics', 'keywords' => [ 'applied linguistics', 'applied', 'linguistics' ] ],
			'communication-sociolinguistics' => [ 'label' => 'Sociolinguistics', 'keywords' => [ 'sociolinguistics' ] ],
			'communication-comm-studies' => [ 'label' => 'Communication Studies', 'keywords' => [ 'communication studies', 'communication' ] ],
			'communication-media-studies' => [ 'label' => 'Media Studies', 'keywords' => [ 'media studies', 'media' ] ],
			'communication-education' => [ 'label' => 'Education', 'keywords' => [ 'education' ] ],
			'communication' => [ 'label' => 'Language & Expression', 'keywords' => [ 'language expression', 'language', 'expression' ] ],
			'mother-tongue' => [ 'label' => 'Mother Tongue', 'keywords' => [ 'mother tongue', 'mother', 'tongue' ] ],
			'culture' => [ 'label' => 'Media & News', 'keywords' => [ 'media news', 'media', 'news' ] ],
			'fandoms' => [ 'label' => 'Fandoms & Fictional Worlds', 'keywords' => [ 'fandoms fictional worlds', 'fandoms', 'fictional', 'worlds' ] ],
			'technology' => [ 'label' => 'Technology & Digital Life', 'keywords' => [ 'technology digital life', 'technology', 'digital', 'life' ] ],
			'education' => [ 'label' => 'Learning & Education', 'keywords' => [ 'learning education', 'learning', 'education' ] ],
		] ],
		'history' => [ 'label' => 'Family', 'keywords' => [ 'history', 'historical', 'ancient', 'archaeology', 'heritage', 'civilisation', 'civilization', 'empire', 'prehistoric', 'ancestry', 'anthropology', 'cultural studies', 'cultural', 'art history', 'art', 'developmental psychology', 'developmental', 'psychology', 'history outlook', 'outlook', 'nationality citizenship', 'nationality', 'citizenship' ], 'subs' => [
			'history-archaeology' => [ 'label' => 'Archaeology', 'keywords' => [ 'archaeology' ] ],
			'history-anthropology' => [ 'label' => 'Anthropology', 'keywords' => [ 'anthropology' ] ],
			'history-cultural-studies' => [ 'label' => 'Cultural Studies', 'keywords' => [ 'cultural studies', 'cultural' ] ],
			'history-art-history' => [ 'label' => 'Art History', 'keywords' => [ 'art history', 'art', 'history' ] ],
			'history-developmental-psychology' => [ 'label' => 'Developmental Psychology', 'keywords' => [ 'developmental psychology', 'developmental', 'psychology' ] ],
			'humanities' => [ 'label' => 'History & Outlook', 'keywords' => [ 'history outlook', 'history', 'outlook' ] ],
			'nationality' => [ 'label' => 'Nationality & Citizenship', 'keywords' => [ 'nationality citizenship', 'nationality', 'citizenship' ] ],
		] ],
		'arts' => [ 'label' => 'Arts', 'keywords' => [ 'art', 'arts', 'music', 'painting', 'drawing', 'design', 'film', 'cinema', 'dance', 'poetry', 'literature', 'creative', 'aesthetic', 'theatre', 'theater', 'photography', 'fine arts', 'fine', 'creative writing', 'writing', 'performing arts', 'performing', 'film studies', 'visual art aesthetics', 'visual', 'aesthetics', 'music sound', 'sound', 'fashion style', 'fashion', 'style', 'books film tv', 'books', 'architecture design', 'architecture', 'dance movement', 'movement', 'games play', 'games', 'play' ], 'subs' => [
			'arts-fine-arts' => [ 'label' => 'Fine Arts', 'keywords' => [ 'fine arts', 'fine', 'arts' ] ],
			'arts-creative-writing' => [ 'label' => 'Creative Writing', 'keywords' => [ 'creative writing', 'creative', 'writing' ] ],
			'arts-design' => [ 'label' => 'Design', 'keywords' => [ 'design' ] ],
			'arts-performing-arts' => [ 'label' => 'Performing Arts', 'keywords' => [ 'performing arts', 'performing', 'arts' ] ],
			'arts-film-studies' => [ 'label' => 'Film Studies', 'keywords' => [ 'film studies', 'film' ] ],
			'arts' => [ 'label' => 'Visual Art & Aesthetics', 'keywords' => [ 'visual art aesthetics', 'visual', 'art', 'aesthetics' ] ],
			'music' => [ 'label' => 'Music & Sound', 'keywords' => [ 'music sound', 'music', 'sound' ] ],
			'fashion' => [ 'label' => 'Fashion & Style', 'keywords' => [ 'fashion style', 'fashion', 'style' ] ],
			'stories' => [ 'label' => 'Books, Film & TV', 'keywords' => [ 'books film tv', 'books', 'film' ] ],
			'design' => [ 'label' => 'Architecture & Design', 'keywords' => [ 'architecture design', 'architecture', 'design' ] ],
			'dance' => [ 'label' => 'Dance & Movement', 'keywords' => [ 'dance movement', 'dance', 'movement' ] ],
			'games' => [ 'label' => 'Games & Play', 'keywords' => [ 'games play', 'games', 'play' ] ],
		] ],
		'medicine' => [ 'label' => 'Health', 'keywords' => [ 'medicine', 'medical', 'health', 'clinical', 'nursing', 'disease', 'anatomy', 'biomedical', 'pharmacy', 'nutrition', 'fitness', 'physiology', 'wellness', 'public health', 'public', 'veterinary medicine', 'veterinary', 'biomedical sciences', 'sciences', 'medicine health sciences', 'genetics heredity', 'genetics', 'heredity', 'sport fitness', 'sport', 'substance use', 'substance', 'use', 'sleep rest', 'sleep', 'rest', 'disability access', 'disability', 'access' ], 'subs' => [
			'medicine-nursing' => [ 'label' => 'Nursing', 'keywords' => [ 'nursing' ] ],
			'medicine-public-health' => [ 'label' => 'Public Health', 'keywords' => [ 'public health', 'public', 'health' ] ],
			'medicine-veterinary' => [ 'label' => 'Veterinary Medicine', 'keywords' => [ 'veterinary medicine', 'veterinary', 'medicine' ] ],
			'medicine-biomedical' => [ 'label' => 'Biomedical Sciences', 'keywords' => [ 'biomedical sciences', 'biomedical', 'sciences' ] ],
			'medicine-pharmacy' => [ 'label' => 'Pharmacy', 'keywords' => [ 'pharmacy' ] ],
			'medicine' => [ 'label' => 'Medicine & Health Sciences', 'keywords' => [ 'medicine health sciences', 'medicine', 'health', 'sciences' ] ],
			'genetics' => [ 'label' => 'Genetics & Heredity', 'keywords' => [ 'genetics heredity', 'genetics', 'heredity' ] ],
			'sports' => [ 'label' => 'Sport & Fitness', 'keywords' => [ 'sport fitness', 'sport', 'fitness' ] ],
			'substance-use' => [ 'label' => 'Substance Use', 'keywords' => [ 'substance use', 'substance', 'use' ] ],
			'sleep' => [ 'label' => 'Sleep & Rest', 'keywords' => [ 'sleep rest', 'sleep', 'rest' ] ],
			'disability' => [ 'label' => 'Disability & Access', 'keywords' => [ 'disability access', 'disability', 'access' ] ],
		] ],
		'politics' => [ 'label' => 'Politics', 'keywords' => [ 'politics', 'political', 'government', 'governance', 'policy', 'state', 'election', 'law', 'legal', 'justice', 'rights', 'court', 'crime', 'criminal', 'contract', 'constitution', 'litigation', 'international law', 'international', 'criminal law', 'business law', 'business', 'conflict resolution', 'conflict', 'resolution', 'political science', 'political', 'science', 'law justice' ], 'subs' => [
			'law-international' => [ 'label' => 'International Law', 'keywords' => [ 'international law', 'international', 'law' ] ],
			'law-criminal' => [ 'label' => 'Criminal Law', 'keywords' => [ 'criminal law', 'criminal', 'law' ] ],
			'law-business' => [ 'label' => 'Business Law', 'keywords' => [ 'business law', 'business', 'law' ] ],
			'law-conflict-resolution' => [ 'label' => 'Conflict Resolution', 'keywords' => [ 'conflict resolution', 'conflict', 'resolution' ] ],
			'law-political-science' => [ 'label' => 'Political Science', 'keywords' => [ 'political science', 'political', 'science' ] ],
			'law' => [ 'label' => 'Law & Justice', 'keywords' => [ 'law justice', 'law', 'justice' ] ],
		] ],
		'anthropology' => [ 'label' => 'Engineering', 'keywords' => [ 'anthropology', 'culture', 'cultural', 'ethnography', 'ritual', 'tribe', 'indigenous', 'custom', 'kinship', 'folklore', 'ethnicity', 'cultural anthropology', 'forensic anthropology', 'forensic', 'religious studies', 'religious', 'sociology', 'psychology', 'ethnicity ancestry', 'ancestry', 'travel places', 'travel', 'places', 'nature climate', 'nature', 'climate', 'landscapes wonders', 'landscapes', 'wonders', 'animals plants', 'animals', 'plants', 'seasons weather', 'seasons', 'weather', 'world cuisines', 'world', 'cuisines', 'food drink', 'food', 'drink' ], 'subs' => [
			'anthropology-cultural' => [ 'label' => 'Cultural Anthropology', 'keywords' => [ 'cultural anthropology', 'cultural', 'anthropology' ] ],
			'anthropology-forensic' => [ 'label' => 'Forensic Anthropology', 'keywords' => [ 'forensic anthropology', 'forensic', 'anthropology' ] ],
			'anthropology-religious-studies' => [ 'label' => 'Religious Studies', 'keywords' => [ 'religious studies', 'religious' ] ],
			'anthropology-sociology' => [ 'label' => 'Sociology', 'keywords' => [ 'sociology' ] ],
			'anthropology-psychology' => [ 'label' => 'Psychology', 'keywords' => [ 'psychology' ] ],
			'ethnicity' => [ 'label' => 'Ethnicity & Ancestry', 'keywords' => [ 'ethnicity ancestry', 'ethnicity', 'ancestry' ] ],
			'travel' => [ 'label' => 'Travel & Places', 'keywords' => [ 'travel places', 'travel', 'places' ] ],
			'nature' => [ 'label' => 'Nature & Climate', 'keywords' => [ 'nature climate', 'nature', 'climate' ] ],
			'landscapes' => [ 'label' => 'Landscapes & Wonders', 'keywords' => [ 'landscapes wonders', 'landscapes', 'wonders' ] ],
			'wildlife' => [ 'label' => 'Animals & Plants', 'keywords' => [ 'animals plants', 'animals', 'plants' ] ],
			'seasons' => [ 'label' => 'Seasons & Weather', 'keywords' => [ 'seasons weather', 'seasons', 'weather' ] ],
			'world-cuisine' => [ 'label' => 'World Cuisines', 'keywords' => [ 'world cuisines', 'world', 'cuisines' ] ],
			'food' => [ 'label' => 'Food & Drink', 'keywords' => [ 'food drink', 'food', 'drink' ] ],
		] ],
		'philosophy' => [ 'label' => 'Philosophy', 'keywords' => [ 'philosophy', 'philosopher', 'ethics', 'metaphysics', 'epistemology', 'logic', 'existential', 'existentialism', 'science', 'scientific', 'astronomy', 'mathematics', 'reason', 'stoicism', 'religious studies', 'religious', 'astrophysics', 'ethics morality', 'morality', 'meaning existence', 'meaning', 'existence', 'free will fate', 'free', 'will', 'fate', 'truth knowledge', 'truth', 'knowledge', 'nature of reality', 'nature', 'reality', 'science discovery', 'discovery', 'astronomy cosmos', 'cosmos', 'mathematics logic' ], 'subs' => [
			'philosophy-metaphysics' => [ 'label' => 'Metaphysics', 'keywords' => [ 'metaphysics' ] ],
			'philosophy-ethics' => [ 'label' => 'Ethics', 'keywords' => [ 'ethics' ] ],
			'philosophy-epistemology' => [ 'label' => 'Epistemology', 'keywords' => [ 'epistemology' ] ],
			'philosophy-religious-studies' => [ 'label' => 'Religious Studies', 'keywords' => [ 'religious studies', 'religious' ] ],
			'philosophy-astrophysics' => [ 'label' => 'Astrophysics', 'keywords' => [ 'astrophysics' ] ],
			'philosophy' => [ 'label' => 'Philosophy', 'keywords' => [ 'philosophy' ] ],
			'ethics' => [ 'label' => 'Ethics & Morality', 'keywords' => [ 'ethics morality', 'ethics', 'morality' ] ],
			'existence' => [ 'label' => 'Meaning & Existence', 'keywords' => [ 'meaning existence', 'meaning', 'existence' ] ],
			'free-will' => [ 'label' => 'Free Will & Fate', 'keywords' => [ 'free will fate', 'free', 'will', 'fate' ] ],
			'knowledge-truth' => [ 'label' => 'Truth & Knowledge', 'keywords' => [ 'truth knowledge', 'truth', 'knowledge' ] ],
			'reality' => [ 'label' => 'Nature of Reality', 'keywords' => [ 'nature of reality', 'nature', 'reality' ] ],
			'science' => [ 'label' => 'Science & Discovery', 'keywords' => [ 'science discovery', 'science', 'discovery' ] ],
			'astronomy' => [ 'label' => 'Astronomy & Cosmos', 'keywords' => [ 'astronomy cosmos', 'astronomy', 'cosmos' ] ],
			'mathematics' => [ 'label' => 'Mathematics & Logic', 'keywords' => [ 'mathematics logic', 'mathematics', 'logic' ] ],
		] ],
		'management' => [ 'label' => 'Business', 'keywords' => [ 'management', 'business', 'leadership', 'organisation', 'organization', 'administration', 'strategy', 'workplace', 'career', 'entrepreneurship', 'business administration', 'public administration', 'public', 'organizational psychology', 'organizational', 'psychology', 'leadership studies', 'political science', 'political', 'science', 'work career', 'work', 'leadership teams', 'teams' ], 'subs' => [
			'management-business-admin' => [ 'label' => 'Business Administration', 'keywords' => [ 'business administration', 'business', 'administration' ] ],
			'management-public-admin' => [ 'label' => 'Public Administration', 'keywords' => [ 'public administration', 'public', 'administration' ] ],
			'management-org-psychology' => [ 'label' => 'Organizational Psychology', 'keywords' => [ 'organizational psychology', 'organizational', 'psychology' ] ],
			'management-leadership' => [ 'label' => 'Leadership Studies', 'keywords' => [ 'leadership studies', 'leadership' ] ],
			'management-political-science' => [ 'label' => 'Political Science', 'keywords' => [ 'political science', 'political', 'science' ] ],
			'work' => [ 'label' => 'Work & Career', 'keywords' => [ 'work career', 'work', 'career' ] ],
			'leadership' => [ 'label' => 'Leadership & Teams', 'keywords' => [ 'leadership teams', 'leadership', 'teams' ] ],
		] ],
		'sociology' => [ 'label' => 'Sociology', 'keywords' => [ 'sociology', 'society', 'social', 'politics', 'political', 'community', 'class', 'gender', 'urban', 'demographic', 'inequality', 'social work', 'work', 'criminology', 'political science', 'science', 'urban studies', 'network science', 'network', 'status standing', 'status', 'standing', 'gender pronouns', 'pronouns', 'sexual romantic orientation', 'sexual', 'romantic', 'orientation', 'community causes', 'causes', 'subcultures scenes', 'subcultures', 'scenes', 'lifestyle preferences', 'lifestyle', 'preferences', 'politics ideology', 'ideology', 'family upbringing', 'family', 'upbringing', 'generation age', 'generation', 'age' ], 'subs' => [
			'sociology-social-work' => [ 'label' => 'Social Work', 'keywords' => [ 'social work', 'social', 'work' ] ],
			'sociology-criminology' => [ 'label' => 'Criminology', 'keywords' => [ 'criminology' ] ],
			'sociology-political-science' => [ 'label' => 'Political Science', 'keywords' => [ 'political science', 'political', 'science' ] ],
			'sociology-urban-studies' => [ 'label' => 'Urban Studies', 'keywords' => [ 'urban studies', 'urban' ] ],
			'sociology-network-science' => [ 'label' => 'Network Science', 'keywords' => [ 'network science', 'network', 'science' ] ],
			'identity' => [ 'label' => 'Status & Standing', 'keywords' => [ 'status standing', 'status', 'standing' ] ],
			'gender' => [ 'label' => 'Gender & Pronouns', 'keywords' => [ 'gender pronouns', 'gender', 'pronouns' ] ],
			'orientation' => [ 'label' => 'Sexual & Romantic Orientation', 'keywords' => [ 'sexual romantic orientation', 'sexual', 'romantic', 'orientation' ] ],
			'community' => [ 'label' => 'Community & Causes', 'keywords' => [ 'community causes', 'community', 'causes' ] ],
			'subcultures' => [ 'label' => 'Subcultures & Scenes', 'keywords' => [ 'subcultures scenes', 'subcultures', 'scenes' ] ],
			'lifestyle' => [ 'label' => 'Lifestyle & Preferences', 'keywords' => [ 'lifestyle preferences', 'lifestyle', 'preferences' ] ],
			'politics' => [ 'label' => 'Politics & Ideology', 'keywords' => [ 'politics ideology', 'politics', 'ideology' ] ],
			'family' => [ 'label' => 'Family & Upbringing', 'keywords' => [ 'family upbringing', 'family', 'upbringing' ] ],
			'generation' => [ 'label' => 'Generation & Age', 'keywords' => [ 'generation age', 'generation', 'age' ] ],
		] ],
		'theology' => [ 'label' => 'Spirituality', 'keywords' => [ 'theology', 'religion', 'religious', 'god', 'faith', 'spiritual', 'spirituality', 'sacred', 'scripture', 'prayer', 'astrology', 'mysticism', 'myth', 'mythology', 'zodiac', 'religious studies', 'philosophy of religion', 'philosophy', 'psychology of religion', 'psychology', 'anthropology of religion', 'anthropology', 'pastoral counseling', 'pastoral', 'counseling', 'abrahamic faiths', 'abrahamic', 'faiths', 'dharmic eastern faiths', 'dharmic', 'eastern', 'spirituality practice', 'practice', 'religion or worldview', 'worldview', 'devotion observance', 'devotion', 'observance', 'faith you were raised in', 'were', 'raised', 'mind body energy', 'mind', 'body', 'energy', 'numerology cards', 'numerology', 'cards', 'western astrology', 'western', 'vedic astrology', 'vedic', 'world zodiac traditions', 'world', 'traditions', 'mythology legend', 'legend' ], 'subs' => [
			'theology-religious-studies' => [ 'label' => 'Religious Studies', 'keywords' => [ 'religious studies', 'religious' ] ],
			'theology-philosophy' => [ 'label' => 'Philosophy of Religion', 'keywords' => [ 'philosophy of religion', 'philosophy', 'religion' ] ],
			'theology-psychology' => [ 'label' => 'Psychology of Religion', 'keywords' => [ 'psychology of religion', 'psychology', 'religion' ] ],
			'theology-anthropology' => [ 'label' => 'Anthropology of Religion', 'keywords' => [ 'anthropology of religion', 'anthropology', 'religion' ] ],
			'theology-counseling' => [ 'label' => 'Pastoral Counseling', 'keywords' => [ 'pastoral counseling', 'pastoral', 'counseling' ] ],
			'abrahamic' => [ 'label' => 'Abrahamic Faiths', 'keywords' => [ 'abrahamic faiths', 'abrahamic', 'faiths' ] ],
			'dharmic' => [ 'label' => 'Dharmic & Eastern Faiths', 'keywords' => [ 'dharmic eastern faiths', 'dharmic', 'eastern', 'faiths' ] ],
			'spirituality' => [ 'label' => 'Spirituality & Practice', 'keywords' => [ 'spirituality practice', 'spirituality', 'practice' ] ],
			'worldview-faith' => [ 'label' => 'Religion or Worldview', 'keywords' => [ 'religion or worldview', 'religion', 'worldview' ] ],
			'devotion' => [ 'label' => 'Devotion & Observance', 'keywords' => [ 'devotion observance', 'devotion', 'observance' ] ],
			'religious-upbringing' => [ 'label' => 'Faith You Were Raised In', 'keywords' => [ 'faith you were raised in', 'faith', 'were', 'raised' ] ],
			'metaphysics' => [ 'label' => 'Mind, Body & Energy', 'keywords' => [ 'mind body energy', 'mind', 'body', 'energy' ] ],
			'numerology' => [ 'label' => 'Numerology & Cards', 'keywords' => [ 'numerology cards', 'numerology', 'cards' ] ],
			// (The three birth-sign categories were PURGED with the astrology framing, 2026-07-10 —
			// the platform's only calendar is the twelve seasons; do not re-add them.)
			'mythology' => [ 'label' => 'Mythology & Legend', 'keywords' => [ 'mythology legend', 'mythology', 'legend' ] ],
		] ],
	];

	/** The valid topic slugs (canonical order). */
	public static function slugs() {
		return array_keys( self::ALL );
	}

	/** True if $slug is a known topic. */
	public static function is_valid( $slug ) {
		return is_string( $slug ) && $slug !== '' && isset( self::ALL[ $slug ] );
	}

	/** Human label for a slug (the chip text); '' for an unknown slug. */
	public static function label( $slug ) {
		return self::is_valid( $slug ) ? self::ALL[ $slug ]['label'] : '';
	}

	/** True if $sub is a defined sub-subject of the (valid) house $house. */
	public static function is_valid_sub( $house, $sub ) {
		return self::is_valid( $house ) && is_string( $sub ) && $sub !== '' && isset( self::ALL[ $house ]['subs'][ $sub ] );
	}

	/** Human label for a sub-subject within its house (the drill-down chip text); '' if unknown. */
	public static function sub_label( $house, $sub ) {
		return self::is_valid_sub( $house, $sub ) ? self::ALL[ $house ]['subs'][ $sub ]['label'] : '';
	}

	/* ── Disciplines as a flat, multi-membership dimension (a discipline key is globally unique and
	   belongs to exactly one house; topics + courses link to MANY disciplines). ────────────────── */

	/* ── The DB-editable discipline registry (Studio "Disciplines" mode) ──────────────────────────
	   The 12 HOUSES are fixed in code (ALL). The DISCIPLINES under them are EDITABLE at runtime: stored as
	   the `aq_disciplines` option ([{key,house,label,blurb}]), SEEDED once from the code defaults (ALL's
	   subs) so the live taxonomy is identical until an operator edits it. disc_map() is the key→{house,label}
	   index every helper + facet reads; a missing/empty/corrupt option falls back to the seed, so the
	   catalogue can never break from a bad option. */

	/** The discipline registry as a list [{key,house,label,blurb}], seeded from code defaults on first use. */
	public static function disciplines() {
		if ( self::$disc_list !== null ) { return self::$disc_list; }
		$opt  = (string) get_option( 'aq_disciplines', '' );
		$list = $opt !== '' ? json_decode( $opt, true ) : null;
		if ( ! is_array( $list ) || ! $list ) {
			$list = self::seed_disciplines();
			update_option( 'aq_disciplines', wp_json_encode( $list ), false );
		}
		self::$disc_list = $list;
		return $list;
	}

	/** The code-default discipline list (ALL's subs flattened) — the seed + the safety fallback.
	 *  Sign/planet default to the house's natural sign + ruler (independently reassignable later). */
	private static function seed_disciplines() {
		$out = [];
		foreach ( self::ALL as $house => $meta ) {
			foreach ( ( $meta['subs'] ?? [] ) as $key => $sm ) {
				$out[] = [ 'key' => $key, 'house' => $house, 'label' => $sm['label'], 'blurb' => '',
					'sign' => self::house_sign( $house ), 'planet' => self::house_planet( $house ) ];
			}
		}
		return $out;
	}

	/** key => [ house, label, sign, planet ] index over the (editable) registry; only rows under a valid
	 *  house. A registry row that predates sign/planet falls back to its house's natural sign + ruler. */
	public static function disc_map() {
		if ( self::$disc_index !== null ) { return self::$disc_index; }
		$m = [];
		foreach ( self::disciplines() as $d ) {
			$k = (string) ( $d['key'] ?? '' );
			$h = (string) ( $d['house'] ?? '' );
			if ( $k === '' || ! self::is_valid( $h ) ) { continue; }
			$sign   = ( isset( $d['sign'] ) && self::is_sign( $d['sign'] ) ) ? $d['sign'] : self::house_sign( $h );
			$planet = ( isset( $d['planet'] ) && self::is_planet( $d['planet'] ) ) ? $d['planet'] : self::house_planet( $h );
			$m[ $k ] = [ 'house' => $h, 'label' => (string) ( $d['label'] ?? $k ), 'sign' => $sign, 'planet' => $planet ];
		}
		self::$disc_index = $m;
		return $m;
	}

	/** The house slug that owns a discipline key, or '' if unknown. */
	public static function disc_house( $disc ) {
		$m = self::disc_map();
		return isset( $m[ $disc ] ) ? $m[ $disc ]['house'] : '';
	}

	/** Label for a discipline key regardless of house, or '' if unknown. */
	public static function disc_label( $disc ) {
		$m = self::disc_map();
		return isset( $m[ $disc ] ) ? $m[ $disc ]['label'] : '';
	}

	/** The single STYLE (HOW) / MOTIVATION (WHY) a discipline carries, or '' if the key is unknown.
	 *  One-hot: exactly one value per dimension (a topic/video carries one What + one How + one Why). */
	public static function disc_sign( $disc ) {
		$m = self::disc_map();
		return isset( $m[ $disc ] ) ? $m[ $disc ]['sign'] : '';
	}
	public static function disc_planet( $disc ) {
		$m = self::disc_map();
		return isset( $m[ $disc ] ) ? $m[ $disc ]['planet'] : '';
	}

	/** Create/update a discipline. Returns false on a bad key or unknown house. Empty sign/planet
	 *  default to the house's natural sign + ruler. */
	public static function save_discipline( $key, $house, $label, $blurb = '', $sign = '', $planet = '', $score = null ) {
		$key = sanitize_key( str_replace( ' ', '-', strtolower( (string) $key ) ) );
		if ( $key === '' || ! self::is_valid( $house ) ) { return false; }
		$label  = sanitize_text_field( (string) $label ); if ( $label === '' ) { $label = $key; }
		$blurb  = sanitize_text_field( (string) $blurb );
		$sign   = self::is_sign( $sign ) ? $sign : self::house_sign( $house );
		$planet = self::is_planet( $planet ) ? $planet : self::house_planet( $house );
		$list  = self::disciplines();
		$found = false;
		foreach ( $list as &$d ) {
			if ( (string) ( $d['key'] ?? '' ) === $key ) {
				$d['house'] = $house; $d['label'] = $label; $d['blurb'] = $blurb; $d['sign'] = $sign; $d['planet'] = $planet;
				if ( $score !== null ) { $d['score'] = (int) $score; }   // trend-fit quality — drives the house representative
				$found = true; break;
			}
		}
		unset( $d );
		if ( ! $found ) {
			$row = [ 'key' => $key, 'house' => $house, 'label' => $label, 'blurb' => $blurb, 'sign' => $sign, 'planet' => $planet ];
			if ( $score !== null ) { $row['score'] = (int) $score; }
			$list[] = $row;
		}
		update_option( 'aq_disciplines', wp_json_encode( array_values( $list ) ), false );
		self::bust_disc();
		return true;
	}

	/** Each house's REPRESENTATIVE disciplines, in TWO camps (score = the trend-fit R² quality of the field's
	 *  Google-Trends seasonality):
	 *    • `what` — the highest-`score` NOUN field    → the recommendation NOUN  (a field of knowledge),
	 *    • `how`  — the highest-`score` ADJECTIVE field → the recommendation ADJECTIVE (a style/quality).
	 *  A field's camp is its part of speech (`pos` = 'noun' | 'adj'; defaults to noun). Computed LIVE, so each
	 *  rep auto-updates as a house's members change. For back-compat, `key`/`label` mirror the `what` (noun) rep.
	 *  house slug => [ key, label, what:{key,label,score}|null, how:{key,label,score}|null ]. */
	public static function house_reps() {
		// The rep of each camp is its best REP-ELIGIBLE member — the `central` flag now means house_ratio > 1.5 (the
		// field's primary sign beats the runner-up by >1.5× area). A camp with no eligible member has NO rep (the
		// title falls back to the zodiac sign). Every field is still listed under its house; this only picks the title.
		$what_c = []; $what_a = []; $how_c = []; $how_a = [];
		$keep = function ( &$best, $h, $key, $label, $s ) {
			if ( ! isset( $best[ $h ] ) || $s > $best[ $h ]['score']
				|| ( $s === $best[ $h ]['score'] && strcmp( $label, $best[ $h ]['label'] ) < 0 ) ) {
				$best[ $h ] = [ 'key' => $key, 'label' => $label, 'score' => $s ];
			}
		};
		foreach ( self::disciplines() as $d ) {
			$h = (string) ( $d['house'] ?? '' );
			if ( ! self::is_valid( $h ) ) { continue; }
			$s   = (int) ( $d['score'] ?? 0 );
			$key = (string) ( $d['key'] ?? '' );
			$lab = (string) ( $d['label'] ?? '' );
			$central = (int) ( $d['central'] ?? 1 );
			if ( (string) ( $d['pos'] ?? 'noun' ) === 'adj' ) { $keep( $how_a, $h, $key, $lab, $s ); if ( $central ) { $keep( $how_c, $h, $key, $lab, $s ); } }
			else { $keep( $what_a, $h, $key, $lab, $s ); if ( $central ) { $keep( $what_c, $h, $key, $lab, $s ); } }
		}
		$out = [];
		foreach ( self::ALL as $house => $_meta ) {
			$w  = $what_c[ $house ] ?? null;   // ONLY a rep-eligible (house_ratio > 1.5) member may be the title — NO fallback
			$hw = $how_c[ $house ]  ?? null;
			if ( ! $w && ! $hw ) { continue; }
			$out[ $house ] = [
				'key'   => $w['key'] ?? ( $hw['key'] ?? '' ),     // back-compat: the WHAT (noun) rep
				'label' => $w['label'] ?? ( $hw['label'] ?? '' ),
				'what'  => $w,
				'how'   => $hw,
			];
		}
		return $out;
	}

	/** GET /house-reps — each house's representative discipline (its highest-`score` member), as a light
	 *  {house: {key,label}} map. The home recommender reads this (the full /disciplines is too heavy for
	 *  Home) and derives the noun + adjective from it, so both auto-update whenever a house's members change. */
	public static function house_reps_rest( $req ) {
		$out = array();
		$light = function ( $r ) { return $r ? array( 'key' => $r['key'], 'label' => $r['label'] ) : null; };
		foreach ( self::house_reps() as $h => $r ) {
			$out[ $h ] = array(
				'key'   => $r['key'], 'label' => $r['label'],          // back-compat = the WHAT (noun) rep
				'what'  => $light( $r['what'] ),                       // noun camp rep
				'how'   => $light( $r['how'] ),                        // adjective camp rep
			);
		}
		return array( 'reps' => $out );
	}

	/**
	 * Bulk-add the sidereal trend-fit DISCOVERED disciplines from data/aq-disciplines-add.json on load
	 * (filemtime-gated, mirroring the grants/courses/trends importers). Each entry {key,house,label,sign}
	 * is upserted via save_discipline — carrying its data-derived `sign` (the HOW-style picked by fitting
	 * the discipline's worldwide monthly Google-Trends series to the celestial cycles, mapped zodiac→style).
	 * The file is built ADD-ONLY (keys already in the registry are omitted), so this purely extends the
	 * taxonomy; existing disciplines are never re-bucketed. Re-imports only when the file changes.
	 */
	public static function import_disc_file() {
		$file = AQ_DIR . '/data/aq-disciplines-add.json';
		if ( ! is_readable( $file ) ) { return; }
		$mtime = (string) filemtime( $file );
		if ( get_option( 'aq_disc_add_mtime' ) === $mtime ) { return; }
		$data  = json_decode( (string) file_get_contents( $file ), true );
		$items = is_array( $data ) ? ( $data['items'] ?? $data ) : array();
		// Build the analysed registry rows + each house's representative in ONE pass; the registry is
		// REPLACED wholesale below (far cheaper than thousands of upserts that each re-encode the option).
		$rows = array(); $analysed = array(); $reps = array();
		foreach ( (array) $items as $d ) {
			$key   = sanitize_key( str_replace( ' ', '-', strtolower( (string) ( $d['key'] ?? '' ) ) ) );
			$house = (string) ( $d['house'] ?? '' );
			if ( $key === '' || ! self::is_valid( $house ) ) { continue; }
			$sign  = self::is_sign( (string) ( $d['sign'] ?? '' ) ) ? (string) $d['sign'] : self::house_sign( $house );
			$label = sanitize_text_field( (string) ( $d['label'] ?? $key ) ); if ( $label === '' ) { $label = $key; }
			$score = (int) ( $d['score'] ?? 0 );
			$central = (int) ( $d['central'] ?? 1 );             // 1 if the peak sits in the central 20° of the sign
			$pos = ( (string) ( $d['pos'] ?? 'noun' ) === 'adj' ) ? 'adj' : 'noun'; // WHAT (noun) vs HOW (adjective) camp
			$rows[]           = array( 'key' => $key, 'house' => $house, 'label' => $label, 'blurb' => sanitize_text_field( (string) ( $d['blurb'] ?? '' ) ), 'sign' => $sign, 'planet' => self::house_planet( $house ), 'score' => $score, 'sig' => (int) ( $d['sig'] ?? 0 ), 'central' => $central, 'pos' => $pos );
			$analysed[ $key ] = true;
			// Content (topics/courses) re-points onto the house's NOUN representative — a field is a thing, not a quality.
			if ( $central && $pos === 'noun' && ( ! isset( $reps[ $house ] ) || $score > $reps[ $house ]['score'] ) ) { $reps[ $house ] = array( 'key' => $key, 'label' => $label, 'score' => $score ); }
		}
		if ( ! $rows ) { return; }                                  // empty/unreadable items — leave the registry untouched
		self::migrate_to_analysed( $analysed, $reps );              // re-point topics + courses FIRST (legacy keys still resolve)
		update_option( 'aq_disciplines', wp_json_encode( $rows ), false ); // THEN make the registry the analysed set (the purge)
		self::bust_disc();
		update_option( 'aq_disc_add_mtime', $mtime, false );
	}

	/**
	 * Re-point every topic + course off the legacy disciplines onto the analysed set, BEFORE the registry
	 * is replaced (so the legacy keys still resolve to their house here). Each is moved to its house's
	 * REPRESENTATIVE analysed discipline ($reps: house => [key,label,score]), preserving its house. The 12
	 * houses are constants (Topics::ALL), untouched. Idempotent — content already on an analysed key is left.
	 */
	private static function migrate_to_analysed( array $analysed, array $reps ) {
		global $wpdb;
		$fallback = $reps[ self::DEFAULT_HOUSE ]['key'] ?? '';
		$rep_for  = function ( $house ) use ( $reps, $fallback ) {
			return ( $house !== '' && isset( $reps[ $house ] ) ) ? $reps[ $house ]['key'] : $fallback;
		};
		// Topics — category not in the analysed set → its house's representative (house resolved via the
		// still-present legacy registry).
		$tt = $wpdb->prefix . 'aq_topics';
		foreach ( (array) $wpdb->get_results( "SELECT id, category FROM $tt", ARRAY_A ) as $t ) {
			$cat = (string) $t['category'];
			if ( isset( $analysed[ $cat ] ) ) { continue; }
			$house = self::disc_house( $cat ); if ( $house === '' ) { $house = self::is_valid( $cat ) ? $cat : self::DEFAULT_HOUSE; }
			$rep = $rep_for( $house );
			if ( $rep !== '' && $rep !== $cat ) { $wpdb->update( $tt, array( 'category' => $rep ), array( 'id' => (int) $t['id'] ) ); }
		}
		// Courses — keep only analysed discipline tags; where none remain, tag the primary house's
		// representative. `houses` = the primary house (the analysed reps aren't in the registry yet, so
		// houses_of() can't resolve them — and a course belongs to its one primary house anyway).
		$ct = $wpdb->prefix . 'aq_courses';
		foreach ( (array) $wpdb->get_results( "SELECT id, topic FROM $ct", ARRAY_A ) as $c ) {
			$house = (string) $c['topic']; if ( ! self::is_valid( $house ) ) { $house = self::DEFAULT_HOUSE; }
			$rep = $rep_for( $house );                              // tag with the primary house's representative — disciplines ↔ house stay consistent
			$wpdb->update( $ct, array(
				'disciplines' => $rep !== '' ? ',' . $rep . ',' : '',
				'houses'      => ',' . $house . ',',
			), array( 'id' => (int) $c['id'] ) );
		}
	}

	/** Remove a discipline from the registry. Existing topic/course links to it simply become inert. */
	public static function delete_discipline( $key ) {
		$key  = sanitize_key( (string) $key );
		$list = array_values( array_filter( self::disciplines(), function ( $d ) use ( $key ) { return (string) ( $d['key'] ?? '' ) !== $key; } ) );
		update_option( 'aq_disciplines', wp_json_encode( $list ), false );
		self::bust_disc();
		return true;
	}

	/** Drop the facet cache after a registry edit (the per-request static caches reset next request). */
	private static function bust_disc() {
		self::$disc_list  = null;
		self::$disc_index = null;
		delete_transient( 'aq_topic_facets_v3' );
	}

	/** True if $disc is a known discipline key in any house. */
	public static function is_valid_disc( $disc ) {
		return is_string( $disc ) && $disc !== '' && self::disc_house( $disc ) !== '';
	}

	/** Distinct house slugs (in canonical house order) covered by a set of discipline keys. */
	public static function houses_of( array $discs ) {
		$set = [];
		foreach ( $discs as $d ) { $h = self::disc_house( $d ); if ( $h !== '' ) { $set[ $h ] = true; } }
		$out = [];
		foreach ( self::ALL as $house => $_m ) { if ( isset( $set[ $house ] ) ) { $out[] = $house; } }
		return $out;
	}

	/** Parse a comma-wrapped discipline CSV (",a,b,") to a clean list of valid discipline keys. */
	public static function parse_discs( $csv ) {
		$out = [];
		foreach ( explode( ',', (string) $csv ) as $d ) {
			$d = trim( $d );
			if ( $d !== '' && self::is_valid_disc( $d ) && ! in_array( $d, $out, true ) ) { $out[] = $d; }
		}
		return $out;
	}

	/** Parse a comma-wrapped house CSV (",a,b,") to a clean list of valid house slugs. */
	public static function parse_houses( $csv ) {
		$out = [];
		foreach ( explode( ',', (string) $csv ) as $h ) {
			$h = trim( $h );
			if ( $h !== '' && self::is_valid( $h ) && ! in_array( $h, $out, true ) ) { $out[] = $h; }
		}
		return $out;
	}

	/**
	 * Classify a course into ONE subject slug from its text. Deterministic + offline: builds a
	 * lowercased haystack (title weighted ×2, then channel, then the de-tagged summary), scores each
	 * subject by how many of its keywords appear (each match bounded so "art" never matches "start"),
	 * and returns the top scorer — OTHER when nothing matches. Ties break by canonical order (the
	 * first-declared subject wins), so the result is stable across runs.
	 */
	public static function classify( $title, $channel = '', $summary = '' ) {
		$title   = (string) $title;
		$haystack = ' ' . self::norm( $title . ' ' . $title . ' ' . (string) $channel . ' ' . wp_strip_all_tags( (string) $summary ) ) . ' ';
		$best = self::DEFAULT_HOUSE; $best_score = 0;
		foreach ( self::ALL as $slug => $meta ) {
			$score = 0;
			foreach ( $meta['keywords'] as $kw ) {
				$score += self::count_kw( $haystack, $kw );
			}
			if ( $score > $best_score ) { $best_score = $score; $best = $slug; }
		}
		return $best;
	}

	/**
	 * Classify a course into ONE sub-subject of its (already-known) house — the catalogue's second
	 * level (ticket #89). Same deterministic keyword scorer as classify(), but scoped to THAT house's
	 * `subs` only, so cross-house keyword overlaps are irrelevant. Returns '' (no sub) when the house
	 * has no sub-taxonomy (e.g. OTHER) or nothing matches — such a course shows under "All <house>"
	 * but on no specific sub chip. Ties break by declaration order, so the result is stable.
	 */
	public static function classify_sub( $house, $title, $channel = '', $summary = '' ) {
		if ( ! self::is_valid( $house ) || empty( self::ALL[ $house ]['subs'] ) ) { return ''; }
		$haystack = ' ' . self::norm( (string) $title . ' ' . (string) $title . ' ' . (string) $channel . ' ' . wp_strip_all_tags( (string) $summary ) ) . ' ';
		$best = ''; $best_score = 0;
		foreach ( self::ALL[ $house ]['subs'] as $slug => $meta ) {
			$score = 0;
			foreach ( $meta['keywords'] as $kw ) {
				$score += self::count_kw( $haystack, $kw );
			}
			if ( $score > $best_score ) { $best_score = $score; $best = $slug; }
		}
		return $best;
	}

	/**
	 * The denormalized DISCOVERY membership a course must carry so the catalogue's facet list
	 * (facets()) and its ?topic= / ?subtopic= filters can find it: those match on the comma-wrapped
	 * `houses` / `disciplines` CSV columns, NOT the primary `topic` column. Derived from the course's
	 * primary house (`topic`) + primary discipline (`subtopic`): `houses` = that house ∪ the house of
	 * every linked discipline (emitted in canonical order); `disciplines` = the linked disciplines, or
	 * '' when it links none (a `subtopic` that is not a current discipline key is dropped — mirrors how
	 * card()/facets() read the column). An invalid/empty `topic` falls back to DEFAULT_HOUSE (mirrors
	 * card()), so a course is ALWAYS reachable under some house. Call this on every write that sets
	 * topic/subtopic: the columns had silently drifted empty because only the migration/rename paths
	 * ever wrote them, so a freshly-classified course dropped out of every topic filter (ticket #155).
	 */
	public static function membership( $topic, $subtopic = '' ) {
		$house = self::is_valid( (string) $topic ) ? (string) $topic : self::DEFAULT_HOUSE;
		$discs = [];
		if ( is_string( $subtopic ) && $subtopic !== '' && self::is_valid_disc( $subtopic ) ) {
			$discs[] = $subtopic;
		}
		$want = [ $house ];
		foreach ( self::houses_of( $discs ) as $h ) { if ( ! in_array( $h, $want, true ) ) { $want[] = $h; } }
		// Emit in canonical house order so the CSV is stable regardless of input order.
		$houses = [];
		foreach ( self::ALL as $h => $_m ) { if ( in_array( $h, $want, true ) ) { $houses[] = $h; } }
		return [
			'houses'      => ',' . implode( ',', $houses ) . ',',
			'disciplines' => $discs ? ',' . implode( ',', $discs ) . ',' : '',
		];
	}

	/** Lowercase + collapse all non-alphanumerics (keeping + # . for c++/c#/node.js) to single spaces. */
	private static function norm( $s ) {
		$s = strtolower( $s );
		$s = preg_replace( '/[^a-z0-9+#.]+/', ' ', $s );
		return preg_replace( '/\s+/', ' ', (string) $s );
	}

	/**
	 * Count word-boundary-bounded occurrences of one keyword in the normalized haystack. The
	 * lookarounds treat alphanumerics as the boundary (so "ai" matches " ai " but not "train"),
	 * while preg_quote keeps tricky keywords like "c++"/"c#"/"node.js" literal.
	 */
	private static function count_kw( $haystack, $kw ) {
		$kw = self::norm( $kw );
		if ( $kw === '' || $kw === ' ' ) { return 0; }
		$kw = trim( $kw );
		$re = '/(?<![a-z0-9])' . preg_quote( $kw, '/' ) . '(?![a-z0-9])/';
		return (int) preg_match_all( $re, $haystack );
	}

	/**
	 * The catalogue's facet list: every subject that has ≥1 published course, with its count, in
	 * canonical order (OTHER last). One bounded GROUP BY (≤ |ALL| rows) over the (status, topic)
	 * index — public + CDN-cacheable. Any empty/legacy '' topic folds into OTHER so the counts always
	 * sum to the published total.
	 */
	public static function facets() {
		// Multi-discipline tally (2026-06): scan every published course's denormalized `houses`/`disciplines`
		// CSVs (bounded by the published count) — a course counts under EACH house it touches and each
		// discipline it links to. Cheap at catalogue scale; cached for a TTL and CDN-cached on top. The key
		// is versioned (_v3) so the academic-houses + multi-membership shape never serves a stale payload.
		$cached = get_transient( 'aq_topic_facets_v3' );
		if ( is_array( $cached ) && $cached ) { return $cached; }
		// Mid-deploy, before the houses/disciplines columns exist, this returns [] (Data::all swallows the
		// error) — we then DON'T cache, so it self-heals once Schema::migrate has added the columns.
		$rows = Data::all( 'SELECT houses, disciplines FROM ' . Data::t( 'aq_courses' ) . " WHERE status = 'publish'" );
		$house_counts = [];   // house slug => # courses linked
		$disc_counts  = [];   // discipline key => # courses linked
		foreach ( $rows as $r ) {
			foreach ( self::parse_houses( $r['houses'] ?? '' ) as $h ) { $house_counts[ $h ] = ( $house_counts[ $h ] ?? 0 ) + 1; }
			foreach ( self::parse_discs( $r['disciplines'] ?? '' ) as $d ) { $disc_counts[ $d ] = ( $disc_counts[ $d ] ?? 0 ) + 1; }
		}
		// Disciplines grouped by house from the EDITABLE registry, so operator edits show in the facet.
		$by_house = [];
		foreach ( self::disciplines() as $d ) {
			$h = (string) ( $d['house'] ?? '' );
			if ( self::is_valid( $h ) ) { $by_house[ $h ][] = $d; }
		}
		$out = [];
		foreach ( self::ALL as $slug => $meta ) {
			if ( empty( $house_counts[ $slug ] ) ) { continue; }
			$entry = [ 'slug' => $slug, 'label' => self::house_label( $slug ), 'count' => (int) $house_counts[ $slug ] ];
			$subs = [];
			foreach ( ( $by_house[ $slug ] ?? [] ) as $d ) {
				$sslug = (string) ( $d['key'] ?? '' );
				if ( $sslug !== '' && ! empty( $disc_counts[ $sslug ] ) ) {
					$subs[] = [ 'slug' => $sslug, 'label' => (string) ( $d['label'] ?? $sslug ), 'count' => (int) $disc_counts[ $sslug ] ];
				}
			}
			if ( $subs ) { $entry['subs'] = $subs; } // omit when no discipline has a course → client renders one level
			$out[] = $entry;
		}
		if ( $out ) { set_transient( 'aq_topic_facets_v3', $out, 5 * MINUTE_IN_SECONDS ); }
		return $out;
	}

	/**
	 * Given a raw search query, return the slug of the first topic whose keyword set contains
	 * the query (word-boundary bounded, case-insensitive), or OTHER when nothing matches.
	 * Used by Courses::list and Search::all to expand course search to topic-keyed results
	 * when the query is itself a topic keyword (e.g. "zoroastrianism" → "humanities").
	 */
	public static function keyword_to_slug( $q ) {
		$q = trim( self::norm( (string) $q ) );
		if ( strlen( $q ) < 2 ) { return self::OTHER; }
		$padded = ' ' . $q . ' ';
		foreach ( self::ALL as $slug => $meta ) {
			if ( $slug === self::OTHER ) { continue; }
			foreach ( $meta['keywords'] as $kw ) {
				if ( self::count_kw( $padded, $kw ) > 0 ) { return $slug; }
			}
		}
		return self::OTHER;
	}

	/**
	 * One-time classification pass over every course whose topic is still unset (''). Idempotent —
	 * once classified a row is skipped, so re-running is a cheap no-op. Called from Schema::migrate
	 * on the version bump that adds the column. Returns the number of rows classified.
	 */
	public static function backfill() {
		$rows = Data::all(
			'SELECT id, title, channel, summary FROM ' . Data::t( 'aq_courses' ) . " WHERE topic = '' OR topic IS NULL"
		);
		$n = 0;
		foreach ( $rows as $r ) {
			$topic = self::classify( $r['title'], $r['channel'], $r['summary'] );
			Data::update( 'aq_courses', [ 'topic' => $topic ], [ 'id' => (int) $r['id'] ] );
			$n++;
		}
		return $n;
	}

	/**
	 * One-time second-level classification pass (ticket #89): assign a sub-subject to every course whose
	 * subtopic is still unset (''), scoped to the course's already-stored house. Deterministic + offline
	 * like backfill(). A course whose text matches no sub keeps '' (it shows under "All <house>"); the
	 * option-gated caller in Schema::migrate runs this exactly once, so those unmatched rows are not
	 * rescanned on later bumps (rows created/imported since are classified at write time). Returns the
	 * number of rows given a sub.
	 */
	public static function backfill_sub() {
		$rows = Data::all(
			'SELECT id, topic, title, channel, summary FROM ' . Data::t( 'aq_courses' ) . " WHERE subtopic = '' OR subtopic IS NULL"
		);
		$n = 0;
		foreach ( $rows as $r ) {
			$house = (string) $r['topic'];
			if ( ! self::is_valid( $house ) || empty( self::ALL[ $house ]['subs'] ) ) { continue; }
			$sub = self::classify_sub( $house, $r['title'], $r['channel'], $r['summary'] );
			if ( $sub === '' ) { continue; }
			Data::update( 'aq_courses', [ 'subtopic' => $sub ], [ 'id' => (int) $r['id'] ] );
			$n++;
		}
		return $n;
	}

	/**
	 * One-time repair of the denormalized discovery columns (ticket #155). The catalogue facet list and
	 * the ?topic= / ?subtopic= filters match on the `houses` / `disciplines` CSVs, but create() /
	 * import_courses() / backfill() only ever set the primary `topic`/`subtopic` — so a classified course
	 * could carry an EMPTY `houses` and be invisible to every topic filter. Fill each empty-`houses` row
	 * from its stored topic + subtopic via membership(). Idempotent + safe: ONLY rows with houses='' are
	 * touched, so a course already carrying a (possibly multi-house cross-listed) membership is never
	 * clobbered. Called once per Schema::VERSION from migrate. Returns the number of rows repaired.
	 */
	public static function backfill_membership() {
		$rows = Data::all(
			'SELECT id, topic, subtopic FROM ' . Data::t( 'aq_courses' ) . " WHERE houses = '' OR houses IS NULL"
		);
		$n = 0;
		foreach ( $rows as $r ) {
			$m = self::membership( (string) $r['topic'], (string) ( $r['subtopic'] ?? '' ) );
			Data::update( 'aq_courses', [ 'houses' => $m['houses'], 'disciplines' => $m['disciplines'] ], [ 'id' => (int) $r['id'] ] );
			$n++;
		}
		return $n;
	}

	/* ── REST: the editable discipline registry (Studio "Disciplines" mode) ───────────────────────── */

	/** Distribution of all four content types across ONE dimension (house|sign). ONE-HOT: every
	 *  item counts EXACTLY ONCE by its single signature column — a course by `topic`(house)/`sign`/`planet`,
	 *  a video by its own `house`/`sign`/`planet`, a topic by its primary discipline's house + its own
	 *  sign/planet, a discipline by the registry. So all THREE dimension-wheels for a given content type
	 *  share the SAME total (= that type's classified count) — the center count is shown once, not per wheel.
	 *  Buckets emit in canonical order. */
	public static function distribution( $dim = 'house' ) {
		$dim = in_array( $dim, [ 'house', 'sign' ], true ) ? $dim : 'house';
		if ( $dim === 'house' ) { $buckets = []; foreach ( self::ALL as $k => $m ) { $buckets[ $k ] = self::house_label( $k ); } }
		elseif ( $dim === 'sign' ) { $buckets = self::signs_effective(); }
		else { $buckets = self::PLANETS; }
		$dm = self::disc_map(); // key => [house,label,sign,planet]
		$tally = function ( $rows, $field ) use ( $buckets ) {
			$o = []; foreach ( (array) $rows as $r ) { $b = (string) ( $r[ $field ] ?? '' ); if ( $b !== '' && isset( $buckets[ $b ] ) ) { $o[ $b ] = ( $o[ $b ] ?? 0 ) + 1; } } return $o;
		};
		// COURSES — one-hot: house = the `topic` column; how = `sign`; why = `planet`.
		$ccol = $dim === 'house' ? 'topic' : $dim;
		$bc = $tally( Data::all( 'SELECT ' . $ccol . ' AS b FROM ' . Data::t( 'aq_courses' ) . " WHERE status = 'publish'" ), 'b' );
		// VIDEOS — one-hot: each video's own house/sign/planet column (added 1.47.0).
		$vcol = $dim === 'house' ? 'house' : $dim;
		$bv = $tally( Data::all( 'SELECT ' . $vcol . ' AS b FROM ' . Data::t( 'aq_videos' ) . ' WHERE ' . $vcol . " <> ''" ), 'b' );
		// TOPICS — one-hot: house from the primary discipline; sign/planet are the topic's own (set on classify).
		$bt = [];
		foreach ( (array) Data::all( 'SELECT category, sign FROM ' . Data::t( 'aq_topics' ) . ' WHERE active = 1' ) as $r ) {
			$b = $dim === 'house' ? ( $dm[ (string) ( $r['category'] ?? '' ) ]['house'] ?? '' ) : (string) ( $r[ $dim ] ?? '' );
			if ( $b === '' || ! isset( $buckets[ $b ] ) ) { $b = $dm[ (string) ( $r['category'] ?? '' ) ][ $dim ] ?? ''; }
			if ( $b !== '' && isset( $buckets[ $b ] ) ) { $bt[ $b ] = ( $bt[ $b ] ?? 0 ) + 1; }
		}
		// DISCIPLINES — the registry (one each).
		$bd = []; foreach ( $dm as $info ) { $b = (string) ( $info[ $dim ] ?? '' ); if ( $b !== '' && isset( $buckets[ $b ] ) ) { $bd[ $b ] = ( $bd[ $b ] ?? 0 ) + 1; } }

		$out = [];
		foreach ( $buckets as $bk => $label ) {
			$out[] = [
				'key' => $bk, 'label' => $label,
				'courses' => (int) ( $bc[ $bk ] ?? 0 ), 'videos' => (int) ( $bv[ $bk ] ?? 0 ),
				'topics' => (int) ( $bt[ $bk ] ?? 0 ), 'disciplines' => (int) ( $bd[ $bk ] ?? 0 ),
			];
		}
		return $out;
	}

	/** Back-compat alias — the per-house distribution. */
	public static function house_distribution() { return self::distribution( 'house' ); }

	/** The registry as full rows [{key,house,label,blurb,sign,planet}], sign/planet defaulted from the house. */
	public static function disciplines_full() {
		$out = [];
		foreach ( self::disciplines() as $d ) {
			$h = (string) ( $d['house'] ?? '' );
			$out[] = [
				'key' => (string) ( $d['key'] ?? '' ), 'house' => $h,
				'label' => (string) ( $d['label'] ?? ( $d['key'] ?? '' ) ), 'blurb' => (string) ( $d['blurb'] ?? '' ),
				'sign' => ( isset( $d['sign'] ) && self::is_sign( $d['sign'] ) ) ? $d['sign'] : self::house_sign( $h ),
				'planet' => ( isset( $d['planet'] ) && self::is_planet( $d['planet'] ) ) ? $d['planet'] : self::house_planet( $h ),
				'score' => (int) ( $d['score'] ?? 0 ),
				'sig' => (int) ( $d['sig'] ?? 0 ),
				'pos' => ( (string) ( $d['pos'] ?? 'noun' ) === 'adj' ) ? 'adj' : 'noun',
			];
		}
		return $out;
	}

	/** GET /cycles — the celestial-cycle explanatory ranking (computed offline from the trend fits,
	 *  shipped in data/aq-cycles.json): each cycle's mean share of the disciplines' fitted signal, the
	 *  number of fields it most explains, and those top fields. Read-whole, statically cached. */
	public static function cycles_rest( $req ) {
		static $c = null;
		if ( $c === null ) {
			$file = AQ_DIR . '/data/aq-cycles.json';
			$c = is_readable( $file ) ? ( json_decode( (string) file_get_contents( $file ), true ) ?: array( 'cycles' => array() ) ) : array( 'cycles' => array() );
		}
		return $c;
	}

	/** GET disciplines — the registry + the two distributions (house|sign) + the sign
	 *  vocabularies. `houses` is kept for back-compat; `dist` carries all three dimensions. */
	public static function list_disciplines( $req ) {
		return [
			'houses'        => self::distribution( 'house' ),
			'dist'          => [ 'house' => self::distribution( 'house' ), 'sign' => self::distribution( 'sign' ) ],
			'disciplines'   => self::disciplines_full(),
			'house_reps'    => array_map( function ( $r ) {
				$light = function ( $x ) { return $x ? array( 'key' => $x['key'], 'label' => $x['label'] ) : null; };
				return array( 'key' => $r['key'], 'label' => $r['label'], 'what' => $light( $r['what'] ), 'how' => $light( $r['how'] ) ); // both camps → composed house title
			}, self::house_reps() ),
			'motivations'   => self::PLANETS,  // WHY vocabulary — planet column (key → label)
			'pedagogies'    => self::signs_effective(),    // HOW vocabulary — effective labels (operator-overridable)
		];
	}

	/** Rename a discipline KEY, cascading to every topic/course that links to it. The CSVs are
	 *  comma-wrapped so a REPLACE can't hit a partial-key match. Returns false if old is unknown or new
	 *  is invalid / already taken. */
	public static function rename_discipline( $old, $new ) {
		global $wpdb; $p = $wpdb->prefix;
		$old = sanitize_key( (string) $old );
		$new = sanitize_key( str_replace( ' ', '-', strtolower( (string) $new ) ) );
		if ( $old === '' || $new === '' || $old === $new ) { return false; }
		$map = self::disc_map();
		if ( ! isset( $map[ $old ] ) || isset( $map[ $new ] ) ) { return false; } // old must exist, new must be free
		$list = self::disciplines();
		foreach ( $list as &$d ) { if ( (string) ( $d['key'] ?? '' ) === $old ) { $d['key'] = $new; } }
		unset( $d );
		update_option( 'aq_disciplines', wp_json_encode( array_values( $list ) ), false );
		$wpdb->query( $wpdb->prepare( "UPDATE {$p}aq_topics  SET disciplines = REPLACE(disciplines, %s, %s) WHERE disciplines LIKE %s", ",$old,", ",$new,", '%,' . $wpdb->esc_like( $old ) . ',%' ) );
		$wpdb->query( $wpdb->prepare( "UPDATE {$p}aq_topics  SET category = %s WHERE category = %s", $new, $old ) );
		$wpdb->query( $wpdb->prepare( "UPDATE {$p}aq_courses SET disciplines = REPLACE(disciplines, %s, %s) WHERE disciplines LIKE %s", ",$old,", ",$new,", '%,' . $wpdb->esc_like( $old ) . ',%' ) );
		$wpdb->query( $wpdb->prepare( "UPDATE {$p}aq_courses SET subtopic = %s WHERE subtopic = %s", $new, $old ) );
		self::bust_disc();
		return true;
	}

	/** POST studio/disciplines — create / update / RENAME a discipline (operator only). When `oldKey` is
	 *  sent and differs from `key`, the discipline is renamed first (cascading to all topic/course links). */
	public static function save_disc_rest( $req ) {
		if ( ! current_user_can( 'manage_options' ) ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		$key = sanitize_key( str_replace( ' ', '-', strtolower( (string) Rest::p( $req, 'key', '' ) ) ) );
		$old = sanitize_key( (string) Rest::p( $req, 'oldKey', '' ) );
		if ( $old !== '' && $old !== $key && self::is_valid_disc( $old ) ) {
			if ( ! self::rename_discipline( $old, $key ) ) { return Rest::err( 'conflict', 'That key is invalid or already taken', 409 ); }
		}
		$ok = self::save_discipline(
			$key, (string) Rest::p( $req, 'house', '' ), (string) Rest::p( $req, 'label', '' ), (string) Rest::p( $req, 'blurb', '' ),
			(string) Rest::p( $req, 'sign', '' ), (string) Rest::p( $req, 'planet', '' )
		);
		if ( ! $ok ) { return Rest::err( 'bad_request', 'A key and a valid house are required', 400 ); }
		return [ 'ok' => true, 'key' => $key ];
	}

	/** POST studio/disciplines/{key}/delete — remove a discipline (operator only). */
	public static function delete_disc_rest( $req ) {
		if ( ! current_user_can( 'manage_options' ) ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		self::delete_discipline( (string) Rest::p( $req, 'key', '' ) );
		return [ 'ok' => true ];
	}

	/* ── editable display labels (operator: Studio "Labels") ────────────────────────────────────────────
	 * The 12 FIELD (house) + 12 STYLE (sign) labels are operator-overridable. Defaults live in self::ALL /
	 * self::SIGNS; an override is stored as a {key:label} JSON option (aq_house_labels / aq_sign_labels) and
	 * wins on read. Cached per request. The FE applies the SAME overrides over its own (identical) defaults
	 * via window.AQ_LABELS, so the two never diverge. */
	private static $house_ov = null;
	private static $sign_ov  = null;
	public static function house_label( $k ) {
		if ( null === self::$house_ov ) { self::$house_ov = (array) json_decode( (string) get_option( 'aq_house_labels', '{}' ), true ); }
		$k = (string) $k; $ov = (string) ( self::$house_ov[ $k ] ?? '' );
		return '' !== $ov ? $ov : (string) ( self::ALL[ $k ]['label'] ?? $k );
	}
	/** Effective style labels (key => label), defaults + overrides — for the Studio wheels + vocab lists. */
	public static function signs_effective() { $o = []; foreach ( self::SIGNS as $k => $l ) { $o[ (string) $k ] = self::sign_label( $k ); } return $o; }

	/** GET /labels — the effective FIELD (house) + STYLE (sign) labels (defaults + operator overrides), each an
	 *  ordered [{key,label}] list. Public + CDN-cacheable; the Studio "Labels" editor loads + edits these. */
	public static function list_labels( $req ) {
		$houses = array(); foreach ( self::ALL as $k => $m ) { $houses[] = array( 'key' => (string) $k, 'label' => self::house_label( $k ) ); }
		$signs  = array(); foreach ( self::SIGNS as $k => $l ) { $signs[]  = array( 'key' => (string) $k, 'label' => self::sign_label( $k ) ); }
		return array( 'houses' => $houses, 'signs' => $signs );
	}

	/** POST studio/labels {houses:{key:label}, signs:{key:label}} — operator: save the display-label overrides
	 *  for the 12 fields + 12 styles. Only known keys + non-empty labels (<=40 chars) are kept. */
	public static function save_labels_rest( $req ) {
		if ( ! current_user_can( 'manage_options' ) ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		$clean = function ( $in, $valid ) {
			$out = array();
			if ( is_array( $in ) ) {
				foreach ( $in as $k => $v ) {
					$k = (string) $k;
					if ( ! isset( $valid[ $k ] ) ) { continue; }
					$label = trim( sanitize_text_field( (string) $v ) );
					if ( '' !== $label && mb_strlen( $label ) <= 40 ) { $out[ $k ] = $label; }
				}
			}
			return $out;
		};
		$houses = $clean( $req->get_param( 'houses' ), self::ALL );
		$signs  = $clean( $req->get_param( 'signs' ), self::SIGNS );
		update_option( 'aq_house_labels', wp_json_encode( $houses ), false );
		update_option( 'aq_sign_labels', wp_json_encode( $signs ), false );
		self::$house_ov = $houses;
		self::$sign_ov  = $signs;
		delete_transient( 'aq_topic_facets_v3' );
		return array( 'ok' => true, 'houses' => $houses, 'signs' => $signs );
	}
}
