<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * OUTREACH — Arash's review queue for accounts LinkedIn / Facebook / Instagram / X / GitHub / Strava suggested to
 * him, plus the ArtaTask dashboard (acceptance rates, time-to-accept, the send plan + daily caps).
 *
 * ADMIN ONLY, server-side: every route in Rest::ROUTES is 'admin' (a cookie session with
 * manage_options; an API token is refused even for an operator). The table describes third parties
 * who never joined ArtaQuest, so it is in Extra::PRIVATE_TABLES — never in /data, /schema, /offline.
 *
 * Nothing here discovers or contacts anyone. Rows arrive by ingest or CSV; a human includes or
 * excludes each one; the phone app later sends only to `included` rows and reports back.
 */
final class Outreach {

	const TABLE     = 'aq_artaoutreach';
	const PLATFORMS = [ 'linkedin', 'facebook', 'instagram', 'x', 'github', 'strava' ];
	const STATUSES  = [ 'pending', 'included', 'excluded' ];
	const PER_PAGE  = 50;
	const CSV_MAX   = 2097152; // 2 MB
	const CSV_ROWS  = 5000;
	const CSV_IN    = [ 'platform', 'handle', 'profile_url', 'full_name', 'tagline', 'bio', 'photo', 'followers', 'following', 'connections', 'mutuals', 'notes' ];
	const CSV_OUT   = [ 'id', 'platform', 'handle', 'profile_url', 'full_name', 'tagline', 'bio', 'photo', 'followers', 'following', 'connections', 'mutuals', 'source', 'status', 'discovered_at', 'decided_at', 'request_sent_at', 'accepted_at', 'notes' ];
	const CAPS_OPT  = 'aq_outreach_caps';
	const CAPS_DEF  = [ 'linkedin' => 3, 'facebook' => 0, 'instagram' => 0, 'x' => 0, 'github' => 0, 'strava' => 0 ];
	/** Profile address built from a handle when the record carries none. GitHub and Strava are
	 *  follow-based: "accepted" there means the person followed back. A Strava handle is the athlete
	 *  id (or vanity name) from strava.com/athletes/<handle>. */
	const URL_FMT   = [
		'linkedin'  => 'https://www.linkedin.com/in/%s/',
		'facebook'  => 'https://www.facebook.com/%s',
		'instagram' => 'https://www.instagram.com/%s/',
		'x'         => 'https://x.com/%s',
		'github'    => 'https://github.com/%s',
		'strava'    => 'https://www.strava.com/athletes/%s',
	];

	public static function profile_url( $platform, $handle ) {
		return isset( self::URL_FMT[ $platform ] ) && $handle !== '' ? sprintf( self::URL_FMT[ $platform ], rawurlencode( $handle ) ) : '';
	}

	private static function t() { global $wpdb; return $wpdb->prefix . self::TABLE; }
	private static function now() { return gmdate( 'Y-m-d H:i:s' ); }

	private static function ts( $v ) {
		if ( ! $v ) { return null; }
		$t = strtotime( (string) $v );
		return $t ? gmdate( 'Y-m-d H:i:s', $t ) : null;
	}

	private static function count_or_null( $v ) {
		if ( $v === null || $v === '' ) { return null; }
		return is_numeric( $v ) && $v >= 0 ? (int) $v : null;
	}

	/** Shape one row for the client: ints as ints, plus time_to_accept_s. */
	private static function out( $r ) {
		if ( ! $r ) { return null; }
		foreach ( [ 'id', 'followers', 'following', 'connections', 'mutuals' ] as $k ) {
			$r[ $k ] = $r[ $k ] === null ? null : (int) $r[ $k ];
		}
		$r['time_to_accept_s'] = self::tta( $r );
		return $r;
	}

	public static function tta( $r ) {
		if ( empty( $r['request_sent_at'] ) || empty( $r['accepted_at'] ) ) { return null; }
		return strtotime( $r['accepted_at'] . ' UTC' ) - strtotime( $r['request_sent_at'] . ' UTC' );
	}

	/** Normalize one record → row array, or WP_Error. */
	public static function clean( array $r ) {
		$platform = strtolower( trim( (string) ( $r['platform'] ?? '' ) ) );
		if ( $platform === 'twitter' ) { $platform = 'x'; }
		if ( $platform === 'gh' ) { $platform = 'github'; }
		if ( ! in_array( $platform, self::PLATFORMS, true ) ) {
			return new \WP_Error( 'platform', 'platform must be one of ' . implode( ', ', self::PLATFORMS ) );
		}
		$handle = ltrim( trim( (string) ( $r['handle'] ?? '' ) ), '@' );
		if ( $handle === '' || strlen( $handle ) > 191 ) { return new \WP_Error( 'handle', 'handle is required (max 191 chars)' ); }
		return [
			'platform'    => $platform,
			'handle'      => $handle,
			'profile_url' => esc_url_raw( (string) ( $r['profile_url'] ?? '' ) ) ?: self::profile_url( $platform, $handle ),
			'full_name'   => mb_substr( sanitize_text_field( (string) ( $r['full_name'] ?? '' ) ), 0, 255 ),
			'tagline'     => mb_substr( sanitize_text_field( (string) ( $r['tagline'] ?? '' ) ), 0, 500 ),
			'bio'         => sanitize_textarea_field( (string) ( $r['bio'] ?? '' ) ),
			'photo'       => mb_substr( sanitize_text_field( (string) ( $r['photo'] ?? '' ) ), 0, 500 ),
			'followers'   => self::count_or_null( $r['followers'] ?? null ),
			'following'   => self::count_or_null( $r['following'] ?? null ),
			'connections' => self::count_or_null( $r['connections'] ?? null ),
			'mutuals'     => self::count_or_null( $r['mutuals'] ?? null ),
			'source'      => sanitize_key( (string) ( $r['source'] ?? 'suggested' ) ) ?: 'suggested',
		];
	}

	public static function id_for( $platform, $handle ) {
		global $wpdb;
		return (int) $wpdb->get_var( $wpdb->prepare( 'SELECT id FROM ' . self::t() . ' WHERE platform = %s AND handle = %s', $platform, $handle ) );
	}

	private static function row( $id ) {
		global $wpdb;
		return $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM ' . self::t() . ' WHERE id = %d', $id ), ARRAY_A );
	}

	/**
	 * Upsert by (platform, handle). Only the fields the caller SENT are refreshed on an existing row
	 * ($present), so a partial record never blanks the rest; status, decisions, sent/accepted and
	 * source are never touched by ingest, so re-discovery cannot undo a decision.
	 */
	public static function upsert( array $row, $discovered_at = null, $present = null ) {
		global $wpdb;
		$id = self::id_for( $row['platform'], $row['handle'] );
		if ( $id ) {
			$upd = $row;
			unset( $upd['platform'], $upd['handle'], $upd['source'] );
			if ( is_array( $present ) ) { $upd = array_intersect_key( $upd, array_flip( $present ) ); }
			$upd['updated_at'] = self::now();
			$wpdb->update( self::t(), $upd, [ 'id' => $id ] );
			return 'updated';
		}
		$row['status']        = 'pending';
		$row['discovered_at'] = $discovered_at ?: self::now();
		$row['updated_at']    = self::now();
		$wpdb->insert( self::t(), $row );
		return 'inserted';
	}

	private static function set_notes( $id, $notes ) {
		global $wpdb;
		$wpdb->update( self::t(), [ 'notes' => sanitize_textarea_field( (string) $notes ), 'updated_at' => self::now() ], [ 'id' => (int) $id ] );
	}

	/** Keyset page, newest first. */
	private static function page( $platform, $status, $before, $limit ) {
		global $wpdb;
		$where = [ '1=1' ];
		$args  = [];
		if ( in_array( $platform, self::PLATFORMS, true ) ) { $where[] = 'platform = %s'; $args[] = $platform; }
		if ( in_array( $status, self::STATUSES, true ) ) { $where[] = 'status = %s'; $args[] = $status; }
		if ( $before > 0 ) { $where[] = 'id < %d'; $args[] = (int) $before; }
		$args[] = max( 1, min( 200, (int) $limit ) );
		$sql    = 'SELECT * FROM ' . self::t() . ' WHERE ' . implode( ' AND ', $where ) . ' ORDER BY id DESC LIMIT %d';
		return (array) $wpdb->get_results( $wpdb->prepare( $sql, $args ), ARRAY_A );
	}

	// ── Routes (all 'admin' in Rest::ROUTES) ───────────────────────────────────────────────────

	/** GET outreach/accounts ?platform=&status=&cursor= */
	public static function list( $req ) {
		global $wpdb;
		$rows   = self::page( sanitize_key( Rest::p( $req, 'platform' ) ), sanitize_key( Rest::p( $req, 'status' ) ), Rest::pint( $req, 'cursor' ), self::PER_PAGE );
		$counts = array_fill_keys( self::STATUSES, 0 );
		foreach ( (array) $wpdb->get_results( 'SELECT status, COUNT(*) AS n FROM ' . self::t() . ' GROUP BY status', ARRAY_A ) as $c ) { $counts[ $c['status'] ] = (int) $c['n']; }
		$next = count( $rows ) === self::PER_PAGE ? (int) end( $rows )['id'] : 0;
		return [ 'items' => array_map( [ self::class, 'out' ], $rows ), 'next' => $next, 'counts' => $counts ];
	}

	/** POST outreach/accounts — one record, or {accounts:[…]} (≤500). The Mac discovery ingest. */
	public static function ingest( $req ) {
		$body = (array) $req->get_json_params();
		$list = isset( $body['accounts'] ) && is_array( $body['accounts'] ) ? $body['accounts'] : [ $body ];
		if ( count( $list ) > 500 ) { return new \WP_Error( 'too_many', 'max 500 accounts per request', 413 ); }
		$out = [ 'inserted' => 0, 'updated' => 0, 'errors' => [] ];
		foreach ( array_values( $list ) as $i => $r ) {
			$row = is_array( $r ) ? self::clean( $r ) : new \WP_Error( 'item', 'not an object' );
			if ( is_wp_error( $row ) ) { $out['errors'][] = [ 'row' => $i, 'error' => $row->get_error_message() ]; continue; }
			$out[ self::upsert( $row, self::ts( $r['discovered_at'] ?? null ), array_keys( $r ) ) ]++;
		}
		return $out;
	}

	/** POST outreach/decide {ids:[], status} — include / exclude / back to pending. A sent row is final. */
	public static function decide( $req ) {
		global $wpdb;
		$status = sanitize_key( Rest::p( $req, 'status' ) );
		if ( ! in_array( $status, self::STATUSES, true ) ) { return new \WP_Error( 'status', 'status must be pending, included or excluded', 400 ); }
		$ids = array_values( array_filter( array_map( 'intval', (array) Rest::p( $req, 'ids', [] ) ) ) );
		if ( ! $ids || count( $ids ) > 500 ) { return new \WP_Error( 'ids', '1–500 ids required', 400 ); }
		$ph  = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
		$now = self::now();
		$n   = $wpdb->query( $wpdb->prepare( 'UPDATE ' . self::t() . " SET status = %s, decided_at = %s, updated_at = %s WHERE request_sent_at IS NULL AND id IN ({$ph})", array_merge( [ $status, $now, $now ], $ids ) ) );
		return [ 'ok' => true, 'updated' => (int) $n ];
	}

	/** POST outreach/accounts/{id}/notes {notes} */
	public static function notes( $req ) {
		$id = Rest::pint( $req, 'id' );
		if ( ! self::row( $id ) ) { return new \WP_Error( 'not_found', 'no such account', 404 ); }
		$notes = Rest::p( $req, 'notes', null );
		if ( ! is_string( $notes ) ) { return new \WP_Error( 'notes', 'notes (string) required', 400 ); }
		self::set_notes( $id, $notes );
		return self::out( self::row( $id ) );
	}

	/** GET outreach/queue ?platform=&limit= — included, not yet sent, oldest decision first (the phone). */
	public static function queue( $req ) {
		global $wpdb;
		$pf   = sanitize_key( Rest::p( $req, 'platform' ) );
		$args = [];
		$and  = '';
		if ( in_array( $pf, self::PLATFORMS, true ) ) { $and = ' AND platform = %s'; $args[] = $pf; }
		$args[] = max( 1, min( 100, Rest::pint( $req, 'limit', 20 ) ) );
		$rows   = $wpdb->get_results( $wpdb->prepare( 'SELECT id, platform, handle, profile_url, full_name, tagline, mutuals, decided_at FROM ' . self::t() . " WHERE status = 'included' AND request_sent_at IS NULL{$and} ORDER BY decided_at ASC, id ASC LIMIT %d", $args ), ARRAY_A );
		return [ 'items' => (array) $rows ];
	}

	private static function mark( $req, $what ) {
		global $wpdb;
		$id = Rest::pint( $req, 'id' );
		if ( ! self::row( $id ) ) { return new \WP_Error( 'not_found', 'no such account', 404 ); }
		$at  = self::ts( Rest::p( $req, 'at' ) ) ?: self::now();
		$sql = $what === 'sent'
			? 'UPDATE ' . self::t() . " SET request_sent_at = %s, updated_at = %s WHERE id = %d AND status = 'included' AND request_sent_at IS NULL"
			: 'UPDATE ' . self::t() . ' SET accepted_at = %s, updated_at = %s WHERE id = %d AND request_sent_at IS NOT NULL AND accepted_at IS NULL';
		$wpdb->query( $wpdb->prepare( $sql, $at, self::now(), $id ) );
		return self::out( self::row( $id ) );
	}
	/** POST outreach/accounts/{id}/sent {at?} — only for included rows; idempotent. */
	public static function sent( $req ) { return self::mark( $req, 'sent' ); }
	/** POST outreach/accounts/{id}/accepted {at?} — needs a prior send; idempotent. */
	public static function accepted( $req ) { return self::mark( $req, 'accepted' ); }

	/** GET outreach/stats — per platform: counts, acceptance rate, time-to-accept (median/mean). */
	public static function stats( $req ) {
		global $wpdb;
		$out = [];
		foreach ( self::PLATFORMS as $p ) {
			$c = $wpdb->get_row( $wpdb->prepare( "SELECT COUNT(*) AS total,
				SUM(status='pending') AS pending, SUM(status='included') AS included, SUM(status='excluded') AS excluded,
				SUM(request_sent_at IS NOT NULL) AS sent, SUM(accepted_at IS NOT NULL) AS accepted
				FROM " . self::t() . ' WHERE platform = %s', $p ), ARRAY_A );
			$pairs = (array) $wpdb->get_results( $wpdb->prepare( 'SELECT request_sent_at, accepted_at FROM ' . self::t() . ' WHERE platform = %s AND accepted_at IS NOT NULL ORDER BY id DESC LIMIT 5000', $p ), ARRAY_A );
			$d     = array_values( array_filter( array_map( [ self::class, 'tta' ], $pairs ), fn( $v ) => $v !== null ) );
			sort( $d );
			$k      = count( $d );
			$median = $k ? ( $k % 2 ? $d[ intdiv( $k, 2 ) ] : intdiv( $d[ $k / 2 - 1 ] + $d[ $k / 2 ], 2 ) ) : null;
			$c      = array_map( 'intval', (array) $c );
			$out[]  = $c + [
				'platform'          => $p,
				'acceptance_rate'   => $c['sent'] ? round( $c['accepted'] / $c['sent'], 4 ) : null,
				'tta_median_s'      => $median,
				'tta_mean_s'        => $k ? (int) round( array_sum( $d ) / $k ) : null,
			];
		}
		return [ 'platforms' => $out ];
	}

	private static function caps() {
		$c = json_decode( (string) get_option( self::CAPS_OPT, '' ), true );
		return array_merge( self::CAPS_DEF, is_array( $c ) ? array_intersect_key( $c, self::CAPS_DEF ) : [] );
	}

	/** GET outreach/plan — daily caps, sent today (UTC), remaining, and the next queue per platform. */
	public static function plan( $req ) {
		global $wpdb;
		$caps  = self::caps();
		$today = gmdate( 'Y-m-d 00:00:00' );
		$out   = [];
		foreach ( self::PLATFORMS as $p ) {
			$sent  = (int) $wpdb->get_var( $wpdb->prepare( 'SELECT COUNT(*) FROM ' . self::t() . ' WHERE platform = %s AND request_sent_at >= %s', $p, $today ) );
			$queue = (int) $wpdb->get_var( $wpdb->prepare( 'SELECT COUNT(*) FROM ' . self::t() . " WHERE platform = %s AND status = 'included' AND request_sent_at IS NULL", $p ) );
			$cap   = (int) $caps[ $p ];
			$out[] = [ 'platform' => $p, 'daily_cap' => $cap, 'sent_today' => $sent, 'remaining_today' => max( 0, $cap - $sent ), 'queued' => $queue, 'days_to_clear' => $cap > 0 ? (int) ceil( $queue / $cap ) : null ];
		}
		return [ 'platforms' => $out, 'day_starts' => $today . ' UTC' ];
	}

	/** POST outreach/caps {linkedin?, facebook?, instagram?, x?, github?, strava?} — 0…100 per day. */
	public static function set_caps( $req ) {
		$caps = self::caps();
		foreach ( self::PLATFORMS as $p ) {
			$v = Rest::p( $req, $p, null );
			if ( $v !== null && is_numeric( $v ) ) { $caps[ $p ] = max( 0, min( 100, (int) $v ) ); }
		}
		update_option( self::CAPS_OPT, wp_json_encode( $caps ), false );
		return [ 'ok' => true, 'caps' => $caps ];
	}

	// ── CSV ────────────────────────────────────────────────────────────────────────────────────

	/** Spreadsheet formula injection: a cell starting = + - @ (or tab/CR) gets a leading '. */
	public static function safe_cell( $v ) {
		$v = (string) $v;
		return ( $v !== '' && strpos( "=+-@\t\r", $v[0] ) !== false ) ? "'" . $v : $v;
	}

	private static function csv( array $header, array $rows ) {
		$fh = fopen( 'php://temp', 'r+' );
		fputcsv( $fh, $header, ',', '"', '' );
		foreach ( $rows as $r ) { fputcsv( $fh, array_map( [ self::class, 'safe_cell' ], $r ), ',', '"', '' ); }
		rewind( $fh );
		$s = stream_get_contents( $fh );
		fclose( $fh );
		return $s;
	}

	/** GET outreach/export ?platform=&status= — the filtered view as CSV text (UTC dates). */
	public static function export( $req ) {
		$pf = sanitize_key( Rest::p( $req, 'platform' ) );
		$st = sanitize_key( Rest::p( $req, 'status' ) );
		$rows = [];
		$before = 0;
		do {
			$page = self::page( $pf, $st, $before, 200 );
			foreach ( $page as $r ) { $rows[] = array_map( fn( $k ) => $r[ $k ] ?? '', self::CSV_OUT ); $before = (int) $r['id']; }
		} while ( count( $page ) === 200 && count( $rows ) < 100000 );
		return [ 'filename' => 'outreach-' . ( $pf ?: 'all' ) . '-' . ( $st ?: 'all' ) . '-' . gmdate( 'Ymd-His' ) . '.csv', 'rows' => count( $rows ), 'csv' => self::csv( self::CSV_OUT, $rows ) ];
	}

	/** GET outreach/template */
	public static function template( $req ) {
		return [ 'filename' => 'outreach-template.csv', 'csv' => self::csv( self::CSV_IN, [
			[ 'linkedin', 'example-person-1', 'https://www.linkedin.com/in/example-person-1', 'Example Person 1', 'Example tagline', 'Example bio', 'https://example.com/photo1.jpg', '', '', '250', '4', 'optional note' ],
			[ 'github', 'example-dev-2', '', 'Example Dev 2', 'Example tagline', 'Example bio', '', '120', '80', '', '3', 'profile_url is built from the handle when empty' ],
			[ 'strava', '12345678', '', 'Example Runner 3', '', '', '', '45', '60', '', '2', 'handle = athlete id' ],
		] ) ];
	}

	/** Parse CSV text → {inserted, updated, errors[{row, error}]}. New rows get source=manual. */
	public static function import_string( $csv ) {
		$res = [ 'inserted' => 0, 'updated' => 0, 'errors' => [] ];
		$fh  = fopen( 'php://temp', 'r+' );
		fwrite( $fh, preg_replace( '/^\xEF\xBB\xBF/', '', (string) $csv ) );
		rewind( $fh );
		$head = fgetcsv( $fh, 0, ',', '"', '' );
		if ( ! $head || $head === [ null ] ) { $res['errors'][] = [ 'row' => 1, 'error' => 'empty file' ]; return $res; }
		$head    = array_map( fn( $h ) => strtolower( trim( (string) $h ) ), $head );
		$unknown = array_diff( $head, self::CSV_IN );
		if ( $unknown || ! in_array( 'platform', $head, true ) || ! in_array( 'handle', $head, true ) ) {
			$res['errors'][] = [ 'row' => 1, 'error' => 'header must use only: ' . implode( ',', self::CSV_IN ) . ' (platform and handle required)' . ( $unknown ? '; unknown: ' . implode( ',', $unknown ) : '' ) ];
			return $res;
		}
		$line = 1;
		while ( ( $cells = fgetcsv( $fh, 0, ',', '"', '' ) ) !== false ) {
			$line++;
			if ( $cells === [ null ] ) { continue; }
			if ( $line - 1 > self::CSV_ROWS ) { $res['errors'][] = [ 'row' => $line, 'error' => 'row limit ' . self::CSV_ROWS . ' reached; rest ignored' ]; break; }
			if ( count( $cells ) !== count( $head ) ) { $res['errors'][] = [ 'row' => $line, 'error' => 'expected ' . count( $head ) . ' columns, got ' . count( $cells ) ]; continue; }
			$rec = array_combine( $head, $cells );
			$rec = array_map( fn( $v ) => ( strlen( $v ) > 1 && $v[0] === "'" && strpos( "=+-@\t\r", $v[1] ) !== false ) ? substr( $v, 1 ) : $v, $rec );
			$rec['source'] = 'manual';
			$row = self::clean( $rec );
			if ( is_wp_error( $row ) ) { $res['errors'][] = [ 'row' => $line, 'error' => $row->get_error_message() ]; continue; }
			$res[ self::upsert( $row, null, array_keys( array_filter( $rec, fn( $v ) => $v !== '' ) ) ) ]++;
			if ( isset( $rec['notes'] ) && trim( $rec['notes'] ) !== '' ) { self::set_notes( self::id_for( $row['platform'], $row['handle'] ), $rec['notes'] ); }
		}
		fclose( $fh );
		return $res;
	}

	/** POST outreach/import {csv} — CSV text (the SPA reads the file), ≤2 MB. */
	public static function import( $req ) {
		$csv = Rest::p( $req, 'csv', '' );
		if ( ! is_string( $csv ) || $csv === '' ) { return new \WP_Error( 'csv', 'csv text required', 400 ); }
		if ( strlen( $csv ) > self::CSV_MAX ) { return new \WP_Error( 'too_large', 'CSV larger than 2 MB', 413 ); }
		return self::import_string( $csv );
	}
}
