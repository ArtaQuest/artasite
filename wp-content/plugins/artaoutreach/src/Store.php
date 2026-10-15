<?php
namespace ArtaOutreach;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/** All SQL for the review table. Every query goes through $wpdb->prepare(); keyset paging only. */
class Store {
	const PLATFORMS = [ 'linkedin', 'facebook', 'instagram', 'x' ];
	const STATUSES  = [ 'pending', 'included', 'excluded' ];
	const PER_PAGE  = 50;

	public static function now() { return current_time( 'mysql', true ); }

	private static function count_or_null( $v ) {
		if ( $v === null || $v === '' ) { return null; }
		return is_numeric( $v ) && $v >= 0 ? (int) $v : null;
	}

	/** Normalize one ingest record; returns [row] or WP_Error. */
	public static function clean( array $r ) {
		$platform = strtolower( trim( (string) ( $r['platform'] ?? '' ) ) );
		if ( $platform === 'twitter' ) { $platform = 'x'; }
		if ( ! in_array( $platform, self::PLATFORMS, true ) ) {
			return new \WP_Error( 'aor_platform', 'platform must be one of ' . implode( ', ', self::PLATFORMS ) );
		}
		$handle = trim( (string) ( $r['handle'] ?? '' ) );
		$handle = ltrim( $handle, '@' );
		if ( $handle === '' || strlen( $handle ) > 191 ) {
			return new \WP_Error( 'aor_handle', 'handle is required (max 191 chars)' );
		}
		return [
			'platform'    => $platform,
			'handle'      => $handle,
			'profile_url' => esc_url_raw( (string) ( $r['profile_url'] ?? '' ) ),
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

	/**
	 * Upsert by (platform, handle). Profile fields are refreshed; status, decisions, sent/accepted
	 * timestamps and notes are NEVER touched by ingest, so re-discovery cannot undo a decision.
	 * Returns 'inserted' | 'updated'.
	 */
	public static function upsert( array $row, $discovered_at = null, $present = null ) {
		global $wpdb;
		$t   = Schema::table();
		$now = self::now();
		$id  = $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$t} WHERE platform = %s AND handle = %s", $row['platform'], $row['handle'] ) );
		if ( $id ) {
			$upd = $row;
			unset( $upd['platform'], $upd['handle'] );
			// Only overwrite fields the caller actually sent; a partial record must not blank the rest.
			if ( is_array( $present ) ) { $upd = array_intersect_key( $upd, array_flip( $present ) ); }
			$upd['updated_at'] = $now;
			$wpdb->update( $t, $upd, [ 'id' => (int) $id ] );
			return 'updated';
		}
		$row['status']        = 'pending';
		$row['discovered_at'] = $discovered_at ?: $now;
		$row['updated_at']    = $now;
		$wpdb->insert( $t, $row );
		return 'inserted';
	}

	public static function id_for( $platform, $handle ) {
		global $wpdb;
		$t = Schema::table();
		return (int) $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$t} WHERE platform = %s AND handle = %s", $platform, $handle ) );
	}

	public static function get( $id ) {
		global $wpdb;
		$t = Schema::table();
		return $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$t} WHERE id = %d", $id ), ARRAY_A );
	}

	/** Keyset page, newest first. $before = id cursor (0 = first page). */
	public static function page( $platform = '', $status = '', $before = 0, $limit = self::PER_PAGE ) {
		global $wpdb;
		$t     = Schema::table();
		$where = [ '1=1' ];
		$args  = [];
		if ( in_array( $platform, self::PLATFORMS, true ) ) { $where[] = 'platform = %s'; $args[] = $platform; }
		if ( in_array( $status, self::STATUSES, true ) ) { $where[] = 'status = %s'; $args[] = $status; }
		if ( $before > 0 ) { $where[] = 'id < %d'; $args[] = (int) $before; }
		$args[] = max( 1, min( 200, (int) $limit ) );
		$sql    = "SELECT * FROM {$t} WHERE " . implode( ' AND ', $where ) . ' ORDER BY id DESC LIMIT %d';
		return (array) $wpdb->get_results( $wpdb->prepare( $sql, $args ), ARRAY_A );
	}

	/** Counts per status (small table, admin-only; one grouped read). */
	public static function counts() {
		global $wpdb;
		$t   = Schema::table();
		$out = array_fill_keys( self::STATUSES, 0 );
		foreach ( (array) $wpdb->get_results( "SELECT status, COUNT(*) AS n FROM {$t} GROUP BY status", ARRAY_A ) as $r ) {
			$out[ $r['status'] ] = (int) $r['n'];
		}
		return $out;
	}

	/** Set status on ids. Only pending/included/excluded; a row already sent is not reopened. */
	public static function decide( array $ids, $status ) {
		global $wpdb;
		if ( ! in_array( $status, self::STATUSES, true ) ) { return 0; }
		$ids = array_values( array_filter( array_map( 'intval', $ids ) ) );
		if ( ! $ids ) { return 0; }
		$t   = Schema::table();
		$ph  = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
		$sql = "UPDATE {$t} SET status = %s, decided_at = %s, updated_at = %s WHERE request_sent_at IS NULL AND id IN ({$ph})";
		return (int) $wpdb->query( $wpdb->prepare( $sql, array_merge( [ $status, self::now(), self::now() ], $ids ) ) );
	}

	public static function set_notes( $id, $notes ) {
		global $wpdb;
		return $wpdb->update( Schema::table(), [ 'notes' => sanitize_textarea_field( $notes ), 'updated_at' => self::now() ], [ 'id' => (int) $id ] );
	}

	/** The phone's queue: included, not yet sent, oldest decision first. */
	public static function queue( $platform = '', $limit = 20 ) {
		global $wpdb;
		$t    = Schema::table();
		$args = [];
		$pf   = '';
		if ( in_array( $platform, self::PLATFORMS, true ) ) { $pf = ' AND platform = %s'; $args[] = $platform; }
		$args[] = max( 1, min( 100, (int) $limit ) );
		$sql    = "SELECT id, platform, handle, profile_url, full_name, tagline, mutuals, decided_at FROM {$t}
			WHERE status = 'included' AND request_sent_at IS NULL{$pf} ORDER BY decided_at ASC, id ASC LIMIT %d";
		return (array) $wpdb->get_results( $wpdb->prepare( $sql, $args ), ARRAY_A );
	}

	/** Phone reports. 'sent' needs status=included; 'accepted' needs a prior send. Idempotent. */
	public static function mark( $id, $what, $at = null ) {
		global $wpdb;
		$t  = Schema::table();
		$at = $at ?: self::now();
		if ( $what === 'sent' ) {
			$sql = "UPDATE {$t} SET request_sent_at = %s, updated_at = %s WHERE id = %d AND status = 'included' AND request_sent_at IS NULL";
		} elseif ( $what === 'accepted' ) {
			$sql = "UPDATE {$t} SET accepted_at = %s, updated_at = %s WHERE id = %d AND request_sent_at IS NOT NULL AND accepted_at IS NULL";
		} else {
			return new \WP_Error( 'aor_mark', 'mark must be sent or accepted', [ 'status' => 400 ] );
		}
		$wpdb->query( $wpdb->prepare( $sql, $at, self::now(), (int) $id ) );
		return self::get( $id );
	}

	/** Seconds from request to acceptance, or null. */
	public static function time_to_accept( array $r ) {
		if ( empty( $r['request_sent_at'] ) || empty( $r['accepted_at'] ) ) { return null; }
		return strtotime( $r['accepted_at'] . ' UTC' ) - strtotime( $r['request_sent_at'] . ' UTC' );
	}
}
