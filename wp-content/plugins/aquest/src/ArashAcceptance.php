<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Arash request-check acceptance research store (LinkedIn / Instagram / Facebook).
 *
 * Publication tables under /data (NOT Extra::PRIVATE_TABLES):
 *   aq_arash_request_events   — append-only status observations
 *   aq_arash_request_state    — current snapshot per person_key+platform
 *   aq_arash_acceptance_daily — materialized rates for plots
 *
 * On-device / task-sync blob requestStatus.json is encrypted cache in aq_task_sync.
 * When that blob is PUT, {@see ingest_blob} unpacks events into these tables.
 *
 * Denominator for acceptance_rate: n_accepted / (n_accepted + n_pending)
 * among still-known (accepted+pending) observations that day. Gone is tracked
 * separately and is not in that rate.
 *
 * HTTP:
 *   GET /wp-json/aq/v1/arash/acceptance
 *   GET /wp-json/aq/v1/arash/acceptance/plot-data
 *   GET /wp-json/aq/v1/arash/acceptance/events.csv
 */
final class ArashAcceptance {

	const PLATFORMS = [ 'linkedin', 'instagram', 'facebook' ];
	const STATUSES  = [ 'pending', 'accepted', 'gone' ];
	const SOURCE    = 'request_check';

	/** Unpack a requestStatus.json body into the research tables. */
	public static function ingest_blob( $uid, $plain ) {
		$uid = (int) $uid;
		if ( $uid <= 0 || ! is_string( $plain ) || $plain === '' ) { return [ 'ok' => false, 'ingested' => 0 ]; }
		try {
			$data = json_decode( $plain, true, 512, JSON_THROW_ON_ERROR );
		} catch ( \JsonException $e ) {
			return [ 'ok' => false, 'error' => 'bad_body', 'ingested' => 0 ];
		}
		if ( ! is_array( $data ) ) { return [ 'ok' => false, 'error' => 'bad_body', 'ingested' => 0 ]; }
		$events = $data['events'] ?? null;
		if ( ! is_array( $events ) ) { return [ 'ok' => true, 'ingested' => 0 ]; }
		$n = 0;
		$touched_days = [];
		foreach ( $events as $ev ) {
			if ( ! is_array( $ev ) ) { continue; }
			$r = self::ingest_event( $uid, $ev );
			if ( ! empty( $r['ok'] ) ) {
				$n++;
				if ( ! empty( $r['day'] ) ) { $touched_days[ $r['day'] . '|' . $r['platform'] ] = [ $r['day'], $r['platform'] ]; }
			}
		}
		foreach ( $touched_days as $pair ) {
			self::rebuild_daily( $pair[0], $pair[1] );
		}
		return [ 'ok' => true, 'ingested' => $n ];
	}

	/** Insert one observation (idempotent on person_key+platform+observed_at_ms+request_status). */
	public static function ingest_event( $uid, array $ev ) {
		$platform = strtolower( trim( (string) ( $ev['platform'] ?? '' ) ) );
		$status   = strtolower( trim( (string) ( $ev['request_status'] ?? '' ) ) );
		$key      = trim( (string) ( $ev['person_key'] ?? '' ) );
		$obs_ms   = (int) ( $ev['observed_at_ms'] ?? 0 );
		if ( $key === '' || $obs_ms <= 0 ) { return [ 'ok' => false ]; }
		if ( ! in_array( $platform, self::PLATFORMS, true ) ) { return [ 'ok' => false ]; }
		if ( ! in_array( $status, self::STATUSES, true ) ) { return [ 'ok' => false ]; }

		$mutual = self::nullable_smallint( $ev['mutual_count'] ?? null );
		$bin    = self::nullable_smallint( $ev['treatment_bin'] ?? null );
		if ( $bin === null && $mutual !== null && $mutual >= 3 && $mutual <= 9 ) { $bin = $mutual; }
		$list_complete = ! empty( $ev['list_complete'] ) ? 1 : 0;
		$handle = self::nullable_str( $ev['handle'] ?? null, 255 );
		$url    = self::nullable_str( $ev['profile_url'] ?? null, 2000 );
		$session = self::nullable_str( $ev['session_id'] ?? null, 64 );
		$device  = self::nullable_str( $ev['device_id'] ?? null, 64 );
		$source  = self::nullable_str( $ev['source'] ?? self::SOURCE, 64 ) ?: self::SOURCE;
		$raw     = isset( $ev['raw_signals'] ) ? wp_json_encode( $ev['raw_signals'] ) : null;
		$obs_at  = gmdate( 'Y-m-d H:i:s', (int) floor( $obs_ms / 1000 ) );
		$day     = gmdate( 'Y-m-d', (int) floor( $obs_ms / 1000 ) );
		$now     = gmdate( 'Y-m-d H:i:s' );

		$t_events = Data::t( 'aq_arash_request_events' );
		$exists = Data::one(
			"SELECT id FROM {$t_events} WHERE person_key = %s AND platform = %s AND observed_at_ms = %d AND request_status = %s",
			[ $key, $platform, $obs_ms, $status ]
		);
		if ( ! $exists ) {
			Data::insert( 'aq_arash_request_events', [
				'user_id'         => (int) $uid,
				'person_key'      => $key,
				'platform'        => $platform,
				'handle'          => $handle,
				'profile_url'     => $url,
				'mutual_count'    => $mutual,
				'treatment_bin'   => $bin,
				'request_status'  => $status,
				'observed_at_ms'  => $obs_ms,
				'observed_at'     => $obs_at,
				'session_id'      => $session,
				'device_id'       => $device,
				'list_complete'   => $list_complete,
				'source'          => $source,
				'raw_signals'     => $raw,
				'created_at'      => $now,
			] );
		}

		self::upsert_state( (int) $uid, $key, $platform, $handle, $url, $mutual, $bin, $status, $obs_ms, $session, $device );
		return [ 'ok' => true, 'day' => $day, 'platform' => $platform ];
	}

	private static function upsert_state( $uid, $key, $platform, $handle, $url, $mutual, $bin, $status, $obs_ms, $session, $device ) {
		$t = Data::t( 'aq_arash_request_state' );
		$row = Data::one(
			"SELECT * FROM {$t} WHERE person_key = %s AND platform = %s",
			[ $key, $platform ]
		);
		$now = gmdate( 'Y-m-d H:i:s' );
		$fields = [
			'user_id'             => $uid,
			'handle'              => $handle,
			'profile_url'         => $url,
			'mutual_count'        => $mutual,
			'treatment_bin'       => $bin,
			'request_status'      => $status,
			'last_observed_at_ms' => $obs_ms,
			'last_session_id'     => $session,
			'last_device_id'      => $device,
			'updated_at'          => $now,
		];
		if ( ! $row ) {
			$fields['person_key'] = $key;
			$fields['platform']   = $platform;
			$fields['first_pending_at_ms']  = $status === 'pending' ? $obs_ms : null;
			$fields['first_accepted_at_ms'] = $status === 'accepted' ? $obs_ms : null;
			$fields['first_gone_at_ms']     = $status === 'gone' ? $obs_ms : null;
			Data::insert( 'aq_arash_request_state', $fields );
			return;
		}
		if ( $status === 'pending' && empty( $row['first_pending_at_ms'] ) ) {
			$fields['first_pending_at_ms'] = $obs_ms;
		}
		if ( $status === 'accepted' && empty( $row['first_accepted_at_ms'] ) ) {
			$fields['first_accepted_at_ms'] = $obs_ms;
		}
		if ( $status === 'gone' && empty( $row['first_gone_at_ms'] ) ) {
			$fields['first_gone_at_ms'] = $obs_ms;
		}
		// Keep earliest first_* timestamps from the existing row when already set.
		foreach ( [ 'first_pending_at_ms', 'first_accepted_at_ms', 'first_gone_at_ms' ] as $col ) {
			if ( ! array_key_exists( $col, $fields ) && isset( $row[ $col ] ) ) {
				$fields[ $col ] = $row[ $col ];
			}
		}
		Data::update( 'aq_arash_request_state', $fields, [ 'person_key' => $key, 'platform' => $platform ] );
	}

	/**
	 * Rebuild one (day, platform) slice of aq_arash_acceptance_daily from events.
	 * NULL mutual_count / treatment_bin stored as sentinel -1 in the PK.
	 */
	public static function rebuild_daily( $day, $platform ) {
		$day = preg_replace( '/[^0-9\-]/', '', (string) $day );
		$platform = strtolower( (string) $platform );
		if ( $day === '' || ! in_array( $platform, self::PLATFORMS, true ) ) { return; }
		$t_events = Data::t( 'aq_arash_request_events' );
		$t_daily  = Data::t( 'aq_arash_acceptance_daily' );
		$rows = Data::all(
			"SELECT
				COALESCE(mutual_count, -1) AS mutual_count,
				COALESCE(treatment_bin, -1) AS treatment_bin,
				SUM(request_status = 'pending') AS n_pending,
				SUM(request_status = 'accepted') AS n_accepted,
				SUM(request_status = 'gone') AS n_gone,
				COUNT(*) AS n_observed
			 FROM {$t_events}
			 WHERE DATE(observed_at) = %s AND platform = %s
			 GROUP BY COALESCE(mutual_count, -1), COALESCE(treatment_bin, -1)",
			[ $day, $platform ]
		);
		$now = gmdate( 'Y-m-d H:i:s' );
		// Cumulative accepted/(accepted+pending) up to and including this day.
		$cum = Data::one(
			"SELECT
				SUM(request_status = 'pending') AS n_pending,
				SUM(request_status = 'accepted') AS n_accepted
			 FROM {$t_events}
			 WHERE DATE(observed_at) <= %s AND platform = %s",
			[ $day, $platform ]
		);
		$cum_rate = self::rate( (int) ( $cum['n_accepted'] ?? 0 ), (int) ( $cum['n_pending'] ?? 0 ) );

		global $wpdb;
		$wpdb->query( $wpdb->prepare(
			"DELETE FROM {$t_daily} WHERE day = %s AND platform = %s",
			$day, $platform
		) );
		foreach ( (array) $rows as $r ) {
			$acc = (int) $r['n_accepted'];
			$pen = (int) $r['n_pending'];
			Data::insert( 'aq_arash_acceptance_daily', [
				'day'                        => $day,
				'platform'                   => $platform,
				'mutual_count'               => (int) $r['mutual_count'],
				'treatment_bin'              => (int) $r['treatment_bin'],
				'n_pending'                  => $pen,
				'n_accepted'                 => $acc,
				'n_gone'                     => (int) $r['n_gone'],
				'n_observed'                 => (int) $r['n_observed'],
				'acceptance_rate'            => self::rate( $acc, $pen ),
				'cumulative_acceptance_rate' => $cum_rate,
				'updated_at'                 => $now,
			] );
		}
	}

	/** Rebuild every day present in events (operator / after bulk ingest). */
	public static function rebuild_all_daily() {
		$t = Data::t( 'aq_arash_request_events' );
		$rows = Data::all( "SELECT DISTINCT DATE(observed_at) AS day, platform FROM {$t}" );
		foreach ( (array) $rows as $r ) {
			self::rebuild_daily( $r['day'], $r['platform'] );
		}
		return [ 'ok' => true, 'slices' => count( (array) $rows ) ];
	}

	// ── HTTP ───────────────────────────────────────────────────────────────

	/** GET arash/acceptance?platform=&from=&to=&group_by=mutual_count|day|platform */
	public static function acceptance( $req ) {
		$platform = strtolower( trim( (string) Rest::p( $req, 'platform', '' ) ) );
		$from     = self::date_or( Rest::p( $req, 'from', '' ), '1970-01-01' );
		$to       = self::date_or( Rest::p( $req, 'to', '' ), gmdate( 'Y-m-d' ) );
		$group    = strtolower( trim( (string) Rest::p( $req, 'group_by', 'day' ) ) );
		if ( ! in_array( $group, [ 'day', 'platform', 'mutual_count' ], true ) ) { $group = 'day'; }
		$t = Data::t( 'aq_arash_acceptance_daily' );
		$where = 'day >= %s AND day <= %s';
		$args  = [ $from, $to ];
		if ( $platform !== '' && in_array( $platform, self::PLATFORMS, true ) ) {
			$where .= ' AND platform = %s';
			$args[] = $platform;
		}
		if ( $group === 'day' ) {
			$sql = "SELECT day, platform,
				SUM(n_pending) n_pending, SUM(n_accepted) n_accepted, SUM(n_gone) n_gone,
				SUM(n_observed) n_observed
				FROM {$t} WHERE {$where}
				GROUP BY day, platform ORDER BY day ASC, platform ASC";
		} elseif ( $group === 'platform' ) {
			$sql = "SELECT platform,
				SUM(n_pending) n_pending, SUM(n_accepted) n_accepted, SUM(n_gone) n_gone,
				SUM(n_observed) n_observed
				FROM {$t} WHERE {$where}
				GROUP BY platform ORDER BY platform ASC";
		} else {
			$sql = "SELECT platform, mutual_count, treatment_bin,
				SUM(n_pending) n_pending, SUM(n_accepted) n_accepted, SUM(n_gone) n_gone,
				SUM(n_observed) n_observed
				FROM {$t} WHERE {$where}
				GROUP BY platform, mutual_count, treatment_bin
				ORDER BY platform ASC, mutual_count ASC";
		}
		$rows = Data::all( $sql, $args );
		$out = [];
		foreach ( (array) $rows as $r ) {
			$acc = (int) $r['n_accepted'];
			$pen = (int) $r['n_pending'];
			$item = [
				'n_pending'       => $pen,
				'n_accepted'      => $acc,
				'n_gone'          => (int) $r['n_gone'],
				'n_observed'      => (int) $r['n_observed'],
				'acceptance_rate' => self::rate( $acc, $pen ),
				'wilson_ci_95'    => self::wilson( $acc, $acc + $pen ),
			];
			if ( isset( $r['day'] ) ) { $item['day'] = $r['day']; }
			if ( isset( $r['platform'] ) ) { $item['platform'] = $r['platform']; }
			if ( isset( $r['mutual_count'] ) ) {
				$mc = (int) $r['mutual_count'];
				$item['mutual_count'] = $mc < 0 ? null : $mc;
			}
			if ( isset( $r['treatment_bin'] ) ) {
				$tb = (int) $r['treatment_bin'];
				$item['treatment_bin'] = $tb < 0 ? null : $tb;
			}
			$out[] = $item;
		}
		return [
			'ok'         => true,
			'from'       => $from,
			'to'         => $to,
			'group_by'   => $group,
			'platform'   => $platform !== '' ? $platform : null,
			'denominator'=> 'n_accepted / (n_accepted + n_pending) among still-known',
			'rows'       => $out,
		];
	}

	/** GET arash/acceptance/plot-data — same filters, chart-ready series. */
	public static function plot_data( $req ) {
		$platform = strtolower( trim( (string) Rest::p( $req, 'platform', '' ) ) );
		$from     = self::date_or( Rest::p( $req, 'from', '' ), '1970-01-01' );
		$to       = self::date_or( Rest::p( $req, 'to', '' ), gmdate( 'Y-m-d' ) );
		$day_req  = new \WP_REST_Request( 'GET' );
		$day_req->set_param( 'platform', $platform );
		$day_req->set_param( 'from', $from );
		$day_req->set_param( 'to', $to );
		$day_req->set_param( 'group_by', 'day' );
		$mut_req = clone $day_req;
		$mut_req->set_param( 'group_by', 'mutual_count' );
		$series_day = self::acceptance( $day_req );
		$series_mut = self::acceptance( $mut_req );
		$elbow = [];
		foreach ( (array) ( $series_mut['rows'] ?? [] ) as $r ) {
			$mc = $r['mutual_count'] ?? null;
			if ( $mc === null || $mc < 3 || $mc > 9 ) { continue; }
			$elbow[] = $r;
		}
		return [
			'ok' => true,
			'from' => $from,
			'to' => $to,
			'platform' => $platform !== '' ? $platform : null,
			'denominator' => 'n_accepted / (n_accepted + n_pending) among still-known',
			'time_series' => $series_day['rows'],
			'by_mutual_count' => $series_mut['rows'],
			'elbow_3_9' => $elbow,
			'flat_test_6_9' => self::flat_test( $elbow, 6, 9 ),
		];
	}

	/** GET arash/acceptance/events.csv — export for the paper. */
	public static function events_csv( $req ) {
		$platform = strtolower( trim( (string) Rest::p( $req, 'platform', '' ) ) );
		$from     = self::date_or( Rest::p( $req, 'from', '' ), '1970-01-01' );
		$to       = self::date_or( Rest::p( $req, 'to', '' ), gmdate( 'Y-m-d' ) );
		$t = Data::t( 'aq_arash_request_events' );
		$where = 'DATE(observed_at) >= %s AND DATE(observed_at) <= %s';
		$args  = [ $from, $to ];
		if ( $platform !== '' && in_array( $platform, self::PLATFORMS, true ) ) {
			$where .= ' AND platform = %s';
			$args[] = $platform;
		}
		$rows = Data::all(
			"SELECT person_key, platform, handle, mutual_count, treatment_bin, request_status,
			        observed_at_ms, observed_at, session_id, device_id, list_complete, source
			 FROM {$t} WHERE {$where} ORDER BY observed_at_ms ASC LIMIT 100000",
			$args
		);
		$fh = fopen( 'php://temp', 'r+' );
		fputcsv( $fh, [ 'person_key', 'platform', 'handle', 'mutual_count', 'treatment_bin', 'request_status', 'observed_at_ms', 'observed_at', 'session_id', 'device_id', 'list_complete', 'source' ] );
		foreach ( (array) $rows as $r ) {
			fputcsv( $fh, [
				$r['person_key'], $r['platform'], $r['handle'], $r['mutual_count'], $r['treatment_bin'],
				$r['request_status'], $r['observed_at_ms'], $r['observed_at'], $r['session_id'],
				$r['device_id'], $r['list_complete'], $r['source'],
			] );
		}
		rewind( $fh );
		$csv = stream_get_contents( $fh );
		fclose( $fh );
		return [
			'ok'       => true,
			'filename' => 'aq_arash_request_events.csv',
			'mime'     => 'text/csv',
			'csv'      => $csv,
			'rows'     => count( (array) $rows ),
		];
	}

	// ── helpers ────────────────────────────────────────────────────────────

	public static function rate( $accepted, $pending ) {
		$den = (int) $accepted + (int) $pending;
		if ( $den <= 0 ) { return null; }
		return round( ( (int) $accepted ) / $den, 6 );
	}

	/** Wilson score interval for a proportion (95%). */
	public static function wilson( $successes, $n ) {
		$n = (int) $n;
		$s = (int) $successes;
		if ( $n <= 0 ) { return [ 'low' => null, 'high' => null ]; }
		$z = 1.959963984540054; // 95%
		$phat = $s / $n;
		$z2 = $z * $z;
		$den = 1 + $z2 / $n;
		$centre = $phat + $z2 / ( 2 * $n );
		$margin = $z * sqrt( ( $phat * ( 1 - $phat ) + $z2 / ( 4 * $n ) ) / $n );
		return [
			'low'  => round( max( 0.0, ( $centre - $margin ) / $den ), 6 ),
			'high' => round( min( 1.0, ( $centre + $margin ) / $den ), 6 ),
		];
	}

	/**
	 * Pre-registered flat test for mutual-count bins lo..hi inclusive:
	 * max(rate) - min(rate) among bins that have observations, plus a note.
	 */
	public static function flat_test( array $elbow_rows, $lo, $hi ) {
		$rates = [];
		foreach ( $elbow_rows as $r ) {
			$mc = $r['mutual_count'] ?? null;
			if ( $mc === null || $mc < $lo || $mc > $hi ) { continue; }
			if ( $r['acceptance_rate'] === null ) { continue; }
			$rates[ (int) $mc ] = (float) $r['acceptance_rate'];
		}
		if ( count( $rates ) < 2 ) {
			return [ 'bins' => $rates, 'spread' => null, 'flat' => null, 'note' => 'need ≥2 bins with rates' ];
		}
		$spread = max( $rates ) - min( $rates );
		return [
			'bins'   => $rates,
			'spread' => round( $spread, 6 ),
			'flat'   => $spread < 0.05,
			'note'   => 'pre-registered: treat 6–9 as flat when max−min rate < 0.05',
		];
	}

	private static function nullable_smallint( $v ) {
		if ( $v === null || $v === '' || $v === false ) { return null; }
		if ( ! is_numeric( $v ) ) { return null; }
		return (int) $v;
	}

	private static function nullable_str( $v, $max ) {
		if ( $v === null ) { return null; }
		$s = trim( (string) $v );
		if ( $s === '' || strtolower( $s ) === 'null' ) { return null; }
		return substr( $s, 0, $max );
	}

	private static function date_or( $raw, $fallback ) {
		$s = trim( (string) $raw );
		if ( preg_match( '/^\d{4}-\d{2}-\d{2}$/', $s ) ) { return $s; }
		return $fallback;
	}

}
