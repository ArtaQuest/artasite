<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * The competition calendar. Every course's leaderboard is a SEASON that resets on the calendar
 * day closest to each new moon, at 10:00 America/New_York ("10 AM EST"). All courses share one
 * global calendar, so every competition opens and closes together.
 *
 * Boundaries are computed astronomically — a reference new moon plus the mean synodic month — so
 * there is nothing to schedule or maintain. A season is the half-open window (start, end]; its
 * KEY is its end timestamp (the reset/deadline). The current leaderboard counts votes whose
 * `created` falls in the current window, so each season is a fresh contest while comments and
 * certificates persist across seasons.
 *
 * At each reset the just-closed season is settled (prizes paid) and snapshotted into
 * aq_season_results; ensure_archived() does this both from WP-cron and lazily on read.
 */
final class Season {

	const REF_NEW_MOON = 947182440;          // 2000-01-06 18:14:00 UTC — a known new moon
	const SYNODIC      = 2551442.876;        // mean synodic month in seconds (29.530588853 days)
	const TZ           = 'America/New_York';  // "10 AM EST" — local NY time (DST-aware)
	const RESET_HOUR   = 10;

	/** The new-moon instant for index k (k=0 ≈ the reference new moon). */
	private static function new_moon( $k ) {
		return self::REF_NEW_MOON + (int) round( $k * self::SYNODIC );
	}

	/** The reset boundary for a new-moon instant: the NY calendar day CLOSEST to the new moon,
	 *  at 10:00 NY time. (If the new moon falls past local noon, the following day is closer.) */
	private static function reset_for_new_moon( $nm ) {
		$dt = new \DateTime( '@' . (int) $nm );
		$dt->setTimezone( new \DateTimeZone( self::TZ ) );
		if ( (int) $dt->format( 'G' ) >= 12 ) { $dt->modify( '+1 day' ); }
		$dt->setTime( self::RESET_HOUR, 0, 0 );
		return $dt->getTimestamp();
	}

	/** Sorted, unique reset boundaries for the new moons near time $t (± $span months). */
	private static function resets_near( $t, $span = 4 ) {
		$k0  = (int) round( ( $t - self::REF_NEW_MOON ) / self::SYNODIC );
		$set = [];
		for ( $k = $k0 - $span; $k <= $k0 + $span; $k++ ) { $set[ self::reset_for_new_moon( self::new_moon( $k ) ) ] = true; }
		$rs = array_keys( $set );
		sort( $rs );
		return $rs;
	}

	/** The current season: [ start, end, key(=end/deadline), closes_in, label, ends_label ]. */
	public static function current( $now = null ) {
		$now  = $now ?: time();
		$rs   = self::resets_near( $now );
		$prev = 0; $next = 0;
		foreach ( $rs as $r ) {
			if ( $r > $now ) { $next = $r; break; }
			$prev = $r;
		}
		if ( ! $next ) { $next = $prev + (int) self::SYNODIC; } // far-future guard
		return [
			'start'      => $prev,
			'end'        => $next,
			'key'        => $next,
			'closes_in'  => max( 0, $next - $now ),
			'label'      => self::label( $prev, $next ),
			'ends_label' => self::fmt( $next ),
		];
	}

	/** The next FULL-moon instant strictly after $t (a full moon = a new moon + half a synodic
	 *  month, on the same mean-synodic calendar the season resets use). Used for competition
	 *  deadlines ("closes at the next full moon"). */
	public static function next_full_moon( $t = null ) {
		$t = $t ?: time();
		$k = (int) floor( ( $t - self::REF_NEW_MOON ) / self::SYNODIC - 0.5 );
		for ( $i = $k; $i <= $k + 2; $i++ ) {
			$fm = self::REF_NEW_MOON + (int) round( ( $i + 0.5 ) * self::SYNODIC );
			if ( $fm > $t ) { return $fm; }
		}
		return $t + (int) self::SYNODIC; // unreachable belt-and-braces
	}

	/** The reset boundary immediately before $key (the start of the season that ended at $key). */
	public static function reset_before( $key ) {
		$prev = 0;
		foreach ( self::resets_near( $key - 1 ) as $r ) { if ( $r < $key ) { $prev = $r; } }
		return $prev;
	}

	/** A human label for a season window, e.g. "May 7 – Jun 5". */
	public static function label( $start, $end ) {
		return ( $start ? self::fmt( $start ) . ' – ' : '' ) . self::fmt( $end );
	}
	private static function fmt( $ts ) {
		$dt = new \DateTime( '@' . (int) $ts );
		$dt->setTimezone( new \DateTimeZone( self::TZ ) );
		return $dt->format( 'M j, Y' );
	}

	/**
	 * Close + archive any season that has ended but isn't recorded as closed yet. Idempotent and
	 * cheap when there's nothing to do (one indexed lookup). Settles the closed season's prizes a
	 * final time and snapshots its leaderboard so the past-seasons dropdown can show it.
	 */
	public static function ensure_archived( $now = null ) {
		$cur  = self::current( $now );
		$key  = (int) $cur['start']; // the reset that just ended the PREVIOUS season
		if ( $key <= 0 ) { return; }
		if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_seasons' ) . ' WHERE season_key = %d AND closed = 1', [ $key ] ) ) { return; }
		$start = self::reset_before( $key );

		// Every course with competition activity in the closed season gets settled + snapshotted. Read
		// from the aq_quester projection — a walk of its (season_key, …) PK — never a created-range scan
		// of aq_votes (a whole month of votes, unbounded at scale). Slight superset of the old "saw an
		// upvote" set: it also includes courses whose questers only commented (their podium rows exist at
		// 0 votes), which settle to nothing and archive honestly — harmless, arguably more complete.
		$courses = Data::all( 'SELECT DISTINCT course_id FROM ' . Data::t( 'aq_quester' ) . ' WHERE season_key = %d', [ $key ] );
		foreach ( $courses as $cr ) {
			$cid  = (int) $cr['course_id'];
			$c    = Data::one( 'SELECT revenue, enroll_count FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
			if ( ! $c ) { continue; }
			Economy::settle_window( $cid, $start, $key, $key, (int) $c['enroll_count'], (int) $c['revenue'] ); // final payout for the closed season
			$pool = Economy::reward_pool( $c['revenue'] );
			foreach ( Economy::podium( $cid, $pool, $start, $key ) as $row ) {
				if ( $row['rank'] > 10 && $row['prize'] <= 0 ) { continue; } // keep the snapshot bounded (top 10 + any winner)
				Data::insert( 'aq_season_results', [
					'season_key' => $key, 'course_id' => $cid, 'place' => $row['rank'], 'user_id' => $row['user_id'],
					'votes' => $row['votes'], 'prize' => $row['prize'], 'created' => time(),
				] );
			}
		}
		Data::insert( 'aq_seasons', [ 'season_key' => $key, 'start_ts' => $start, 'label' => self::label( $start, $key ), 'closed' => 1, 'created' => time() ] );
	}

	/** Past seasons that have an archived result for a course (newest first), for the dropdown. */
	public static function archived_for_course( $cid, $limit = 24 ) {
		$rows = Data::all(
			'SELECT DISTINCT r.season_key, s.start_ts, s.label FROM ' . Data::t( 'aq_season_results' ) . ' r
			   JOIN ' . Data::t( 'aq_seasons' ) . ' s ON s.season_key = r.season_key
			  WHERE r.course_id = %d ORDER BY r.season_key DESC LIMIT %d',
			[ (int) $cid, (int) $limit ]
		);
		return array_map( fn( $r ) => [ 'key' => (int) $r['season_key'], 'label' => (string) $r['label'] ], $rows );
	}
}
