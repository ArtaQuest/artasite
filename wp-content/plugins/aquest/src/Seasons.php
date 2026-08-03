<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * The Twelve Seasons — THE platform calendar (operator directives 2026-07-10).
 *
 * The year is a CYCLE of twelve fixed seasons on the sidereal (Lahiri) solar boundaries.
 * Astrology is never named anywhere on the site. Every season is a card RANK — and nothing
 * else (operator 2026-07-11: NO SUITS anywhere, no content classification): the cycle opens
 * at the QUEEN on 17 August and runs Q 1 … 10 J — the life-cycle arc, the Jack closing it.
 * Each rank is TONED by its season's stability — yin (blue, the initiators), yang (gold, the
 * steady keepers), dual (the gold→blue blend, the adaptive). Each season is an ARCHETYPE:
 * ARTA (truth) wakes one virtue and defeats one named DRUJ (deceit) per season.
 *
 * A member subscribes to exactly ONE season — their WHAT (user meta `aq_season`), by default
 * the season of their birthday (`aq_birthday`). The HOW is never chosen: it is the running
 * season's craft. Distinct from the lunar competition calendar (Season.php). The cycle is
 * drawn as a SINUSOID, never a radial chart (operator 2026-07-10).
 *
 * ⚠ Keep in exact sync with the SPA mirror artaquest-web/src/lib/seasons.ts.
 */
final class Seasons {

	const META = 'aq_season';

	/** n → [ key, archetype, epithet, rank, tone, open month, open day, craft (Library tab), craft label,
	 *        Arta's virtue, the Druj villain, the villain's vice ] — cycle order, n=1 is the Queen season. */
	const CYCLE = [
		1  => [ 's1',  'Crown',  'the Champion',     'Q',  'yang', 8,  17, 'film',         'Film',         'generous glory, warmth that rules',   'Mask',     'pride, the false face worn for worship' ],
		2  => [ 's2',  'Forge',  'the Artisan',      '1',  'dual', 9,  17, 'model',        'Model',        'craft, service, the patient maker',   'Rust',     'contempt, the scorn that corrodes the work' ],
		3  => [ 's3',  'Judge',  'the Arbiter',      '2',  'yin',  10, 17, 'competition',  'Dataset',      'justice, mercy, the fair measure',    'Stall',    'the measure that never falls — the verdict forever withheld' ],
		4  => [ 's4',  'Ember',  'the Alchemist',    '3',  'yang',   11, 16, 'animation',    'Animation',    'rebirth, death turned to new life',   'Poison',   'obsession, the venom kept for vengeance' ],
		5  => [ 's5',  'Torch',  'the Mentor',       '4',  'dual',   12, 16, 'book',         'Book',         'wisdom, the guiding light',           'Scourge',  'dogma, the guide turned punisher of all who stray' ],
		6  => [ 's6',  'Stone',  'the Architect',    '5',  'yin',    1,  14, 'paper',        'Paper',        'the order that endures, endurance',   'Tomb',     'rigidity, the order sealed into a grave' ],
		7  => [ 's7',  'Lens',   'the Visionary',    '6',  'yang',   2,  13, 'illustration', 'Illustration', 'true vision, the clear sight, hope',  'Mirage',   'delusion, the false image, cold abstraction' ],
		8  => [ 's8',  'Tide',   'the Mystic',       '7',  'dual',   3,  14, 'system',       'Typology',     'compassion, the deep that lifts all', 'Undertow', 'dissolution, the deep that drowns' ],
		9  => [ 's9',  'Spark',  'the Pioneer',      '8',  'yin',    4,  14, 'games',        'Game',         'courage, the first flame struck',     'Wildfire', 'fury, the fire that burns what it builds' ],
		10 => [ 's10', 'Grain',  'the Provider',     '9',  'yang',    5,  15, 'music',        'Music',        'plenty freely given, steadiness',     'Blight',   'hoarding, the harvest withheld and rotted' ],
		11 => [ 's11', 'Bridge', 'the Communicator', '10', 'dual',    6,  15, 'translate',    'Translation',  'the honest word, true connection',    'Whisper',  'deceit, the poisoned rumour' ],
		12 => [ 's12', 'Nest',   'the Guardian',     'J',  'yin',     7,  16, 'audiobook',    'Audiobook',    'tenderness, shelter, loyalty',        'Cage',     'clinging, the love that smothers' ],
	];

	const SIGIL_REV = 4; // busts the year-long edge cache on every art redesign — keep in sync with seasons.ts

	/** The season's rank emblem URL (the avatar bundled with the SPA). */
	public static function sigil_url( $n ) {
		$n = (int) $n;
		return ( $n >= 1 && $n <= 12 ) ? get_stylesheet_directory_uri() . '/app/seasons/s' . $n . '.svg?v=' . self::SIGIL_REV : '';
	}

	/** One season as its API shape. */
	public static function shape( $n ) {
		$w = self::CYCLE[ $n ];
		return [
			'n' => $n, 'key' => $w[0], 'keeper' => $w[1], 'epithet' => $w[2],
			'rank' => $w[3], 'tone' => $w[4],
			'from' => sprintf( '%02d-%02d', $w[5], $w[6] ), 'craft' => $w[7], 'craft_label' => $w[8],
			'arta' => $w[9], 'druj' => $w[10], 'vice' => $w[11], 'avatar' => self::sigil_url( $n ),
		];
	}

	/** The season containing a month/day: the latest ingress boundary at or before the date wins
	 *  (fixed sidereal-Lahiri dates); before the year's first boundary (14 Jan) it wraps to
	 *  season 5 (Torch, rank 4), which opened 16 Dec of the previous year. */
	public static function for_month_day( $month, $day ) {
		$d = $month * 100 + $day;
		$best = 5; $best_open = -1;
		foreach ( self::CYCLE as $n => $w ) {
			$open = $w[5] * 100 + $w[6];
			if ( $open <= $d && $open > $best_open ) { $best = $n; $best_open = $open; }
		}
		return $best;
	}

	/** The season the world is in right now (site timezone). */
	public static function current() {
		$now = new \DateTime( 'now', wp_timezone() );
		return self::for_month_day( (int) $now->format( 'n' ), (int) $now->format( 'j' ) );
	}

	/** The season of a YYYY-MM-DD birthday, or 0 when unset/invalid. */
	public static function for_birthday( $birthday ) {
		if ( ! preg_match( '/^\d{4}-(\d{2})-(\d{2})/', (string) $birthday, $m ) ) { return 0; }
		return self::for_month_day( (int) $m[1], (int) $m[2] );
	}

	/** The member's season: their explicit subscription, else their birth season, else 0. */
	public static function of_user( $uid ) {
		$uid = (int) $uid;
		if ( ! $uid ) { return 0; }
		$n = (int) get_user_meta( $uid, self::META, true );
		if ( $n >= 1 && $n <= 12 ) { return $n; }
		return self::for_birthday( get_user_meta( $uid, 'aq_birthday', true ) );
	}

	// ── REST ──────────────────────────────────────────────────────────────

	/** GET /seasons — the whole cycle + the current season (+ the caller's, when signed in). */
	public static function wheel_rest() {
		$out = [ 'seasons' => array_map( [ self::class, 'shape' ], array_keys( self::CYCLE ) ), 'current' => self::current() ];
		$uid = Rest::uid();
		if ( $uid ) { $out['mine'] = self::of_user( $uid ); }
		return $out;
	}

	/** POST /me/season {n} — subscribe to exactly one season (a member follows ONE topic family). */
	public static function subscribe_rest( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$n = (int) Rest::p( $req, 'n', 0 );
		if ( $n < 1 || $n > 12 ) { return Rest::err( 'bad_season', 'Pick a season on the cycle (1–12).' ); }
		update_user_meta( $uid, self::META, $n );
		return [ 'ok' => true, 'season' => $n ];
	}
}
