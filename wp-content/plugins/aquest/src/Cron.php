<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Cron::guard — the one wrapper EVERY aq_* WP-cron handler runs through. It gives the scheduler three
 * things vanilla WP-cron lacks:
 *
 *   1. OVERLAP LOCK — if a run of this job started < $ttl ago and hasn't finished, the new fire is
 *      SKIPPED. WP-cron will happily fire an hourly hook again while the last run is still in flight
 *      (slow YouTube calls, a big dataset build), which double-spends the YouTube quota the rate monitor
 *      depends on and races the job against itself. The lock closes that.
 *   2. ERROR ISOLATION — the callback runs inside try/catch(\Throwable). A single job that fatals can
 *      otherwise 500 the whole wp-cron request and starve every job scheduled after it in that tick.
 *   3. OBSERVABILITY — each run records { at, ms, err, ok, fail, skip } into the aq_cron_stats option,
 *      surfaced in the operator Console so last-run + last-error are visible without SSH.
 *
 * Locks + stats are best-effort options (non-autoloaded) and NEVER throw — observability must not be
 * able to break a job. $ttl should be ≈ the longest expected runtime of the job (a crashed run releases
 * its lock only when $ttl elapses, so too-small a TTL lets an overlap slip while too-large delays
 * recovery after a hard crash).
 */
final class Cron {
	const STATS_OPT = 'aq_cron_stats';

	public static function guard( $key, $cb, $ttl = 1800 ) {
		$key  = (string) $key;
		$lock = 'aq_cron_lock_' . preg_replace( '/[^a-z0-9_]/', '_', strtolower( $key ) );
		$now  = time();
		$held = (int) get_option( $lock, 0 );
		if ( $held && ( $now - $held ) < (int) $ttl ) { self::record( $key, 0, '', true ); return; } // still in flight → skip
		update_option( $lock, $now, false );
		$t0 = microtime( true ); $err = '';
		try {
			call_user_func( $cb );
		} catch ( \Throwable $e ) {
			$err = $e->getMessage();
			error_log( '[aq_cron] ' . $key . ' failed: ' . $err );
		}
		self::record( $key, (int) round( ( microtime( true ) - $t0 ) * 1000 ), $err, false );
		delete_option( $lock );
	}

	/** Fold one run's outcome into the per-job stats map. Bounded + swallows its own errors. */
	private static function record( $key, $ms, $err, $skipped ) {
		try {
			$all = get_option( self::STATS_OPT, [] ); if ( ! is_array( $all ) ) { $all = []; }
			$s = ( isset( $all[ $key ] ) && is_array( $all[ $key ] ) ) ? $all[ $key ] : [ 'ok' => 0, 'fail' => 0, 'skip' => 0 ];
			if ( $skipped ) {
				$s['skip'] = (int) ( $s['skip'] ?? 0 ) + 1;
			} else {
				$s['at']  = time();
				$s['ms']  = (int) $ms;
				$s['err'] = (string) $err;
				if ( $err === '' ) { $s['ok'] = (int) ( $s['ok'] ?? 0 ) + 1; } else { $s['fail'] = (int) ( $s['fail'] ?? 0 ) + 1; }
			}
			$all[ $key ] = $s;
			update_option( self::STATS_OPT, $all, false );
		} catch ( \Throwable $e ) { /* observability must never break a job */ }
	}

	/** The stats map { key => { at, ms, err, ok, fail, skip } } for the operator Console. */
	public static function stats() {
		$all = get_option( self::STATS_OPT, [] );
		return is_array( $all ) ? $all : [];
	}
}
