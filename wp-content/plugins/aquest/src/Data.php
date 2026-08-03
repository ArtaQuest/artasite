<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Thin data-access helpers over $wpdb. Everything the domains need to talk to the
 * aq_* tables lives here so the query patterns (prepared statements, keyset
 * pagination, counter bumps, upserts) are written once and reused.
 */
final class Data {

	/** Fully-qualified, prefixed table name for an aq_* key. */
	public static function t( $key ) {
		global $wpdb;
		return $wpdb->prefix . $key;
	}

	public static function now() { return time(); }

	/** One row as an assoc array, or null. $args fill ? placeholders in $sql. */
	public static function one( $sql, $args = [] ) {
		global $wpdb;
		$q = $args ? $wpdb->prepare( $sql, $args ) : $sql;
		$row = $wpdb->get_row( $q, ARRAY_A );
		return $row ?: null;
	}

	/** All rows as assoc arrays. */
	public static function all( $sql, $args = [] ) {
		global $wpdb;
		$q = $args ? $wpdb->prepare( $sql, $args ) : $sql;
		return $wpdb->get_results( $q, ARRAY_A ) ?: [];
	}

	/** A single scalar column. */
	public static function col( $sql, $args = [] ) {
		global $wpdb;
		$q = $args ? $wpdb->prepare( $sql, $args ) : $sql;
		return $wpdb->get_var( $q );
	}

	public static function insert( $key, $data ) {
		global $wpdb;
		$wpdb->insert( self::t( $key ), $data );
		return (int) $wpdb->insert_id;
	}

	public static function update( $key, $data, $where ) {
		global $wpdb;
		return $wpdb->update( self::t( $key ), $data, $where );
	}

	/**
	 * Insert-or-update keyed by $where (idempotent write). Used for enroll/progress/
	 * section votes/bursary so a retried request never duplicates a row.
	 */
	public static function upsert( $key, $where, $data ) {
		global $wpdb;
		$t = self::t( $key );
		$cols = [];
		$conds = [];
		foreach ( $where as $c => $v ) { $conds[] = "$c = " . ( is_int( $v ) ? '%d' : '%s' ); $cols[] = $v; }
		$found = $wpdb->get_var( $wpdb->prepare( "SELECT 1 FROM $t WHERE " . implode( ' AND ', $conds ) . ' LIMIT 1', $cols ) );
		if ( $found ) {
			$wpdb->update( $t, $data, $where );
			return false; // updated
		}
		// Report whether a NEW row was actually inserted. Under a race (a concurrent request inserted the
		// same key between the SELECT and here) or a UNIQUE-key collision, $wpdb->insert returns false — and
		// callers that bump counters/charge on $inserted (enroll, bursary, follow) MUST see false then, or
		// they'd double-bump. Suppressed so the expected collision doesn't spam the error log.
		$prev = $wpdb->suppress_errors( true );
		$ok   = $wpdb->insert( $t, array_merge( $where, $data ) );
		$wpdb->suppress_errors( $prev );
		return (bool) $ok; // true only when this call created the row
	}

	/** Atomically bump a denormalized counter column by $by (may be negative). */
	public static function bump( $key, $where, $col, $by = 1 ) {
		global $wpdb;
		$t = self::t( $key );
		$conds = [];
		$args = [ $by ];
		foreach ( $where as $c => $v ) { $conds[] = "$c = %d"; $args[] = $v; }
		$wpdb->query( $wpdb->prepare(
			"UPDATE $t SET `$col` = `$col` + %d WHERE " . implode( ' AND ', $conds ),
			$args
		) );
	}

	/**
	 * Keyset (cursor) pagination — the only list pattern we use. Returns
	 * [ items, next ] where `next` is the id to pass as ?cursor for the following
	 * page, or null at the end. O(page) at any depth, unlike OFFSET.
	 *
	 * @param string $key     aq_* table
	 * @param string $where   extra WHERE (without the cursor clause), e.g. "status = 'publish'"
	 * @param array  $args    args for $where placeholders
	 * @param int    $cursor  exclusive upper-bound id (0 = first page)
	 * @param int    $limit   page size
	 * @param string $order   'DESC' (newest first) or 'ASC'
	 * @param string $cur_col id column to page on
	 */
	public static function page( $key, $where, $args, $cursor, $limit, $order = 'DESC', $cur_col = 'id' ) {
		global $wpdb;
		$t = self::t( $key );
		$limit = max( 1, min( 100, (int) $limit ) );
		$cmp = $order === 'DESC' ? '<' : '>';
		$clauses = [];
		if ( $where ) { $clauses[] = "($where)"; }
		if ( $cursor > 0 ) { $clauses[] = "$cur_col $cmp %d"; $args[] = (int) $cursor; }
		$sql = "SELECT * FROM $t" . ( $clauses ? ' WHERE ' . implode( ' AND ', $clauses ) : '' )
			. " ORDER BY $cur_col $order LIMIT %d";
		$args[] = $limit + 1;
		$rows = $wpdb->get_results( $wpdb->prepare( $sql, $args ), ARRAY_A ) ?: [];
		$next = null;
		if ( count( $rows ) > $limit ) {
			$last = $rows[ $limit - 1 ];
			$next = (int) $last[ $cur_col ];
			$rows = array_slice( $rows, 0, $limit );
		}
		return [ $rows, $next ];
	}

	/**
	 * LIKE search across $cols (OR'd together) combined with keyset pagination. Thin wrapper
	 * over self::page so the cursor + `next` semantics are identical to every other list. $q is
	 * matched as a "contains" substring (esc_like'd); an empty $q filters on $extra_where alone.
	 * Powers the unified Search::all (and is available to any list that wants text search).
	 *
	 * @param string $key         aq_* table
	 * @param array  $cols        columns to OR a LIKE over, e.g. ['title','channel'] (already trusted identifiers)
	 * @param string $q           raw search text ('' = no text filter)
	 * @param string $extra_where extra WHERE without the cursor clause, e.g. "status = 'publish'"
	 * @param array  $extra_args  args for $extra_where placeholders
	 * @param int    $cursor      keyset cursor (0 = first page)
	 * @param int    $limit       page size
	 */
	public static function search_page( $key, $cols, $q, $extra_where, $extra_args, $cursor, $limit ) {
		global $wpdb;
		$where = (string) $extra_where;
		$args  = (array) $extra_args;
		$q     = trim( (string) $q );
		if ( $q !== '' && $cols ) {
			$like = '%' . $wpdb->esc_like( $q ) . '%';
			$ors  = [];
			foreach ( $cols as $c ) { $ors[] = "$c LIKE %s"; $args[] = $like; }
			$clause = '(' . implode( ' OR ', $ors ) . ')';
			$where  = $where !== '' ? "$where AND $clause" : $clause;
		}
		return self::page( $key, $where, $args, $cursor, $limit );
	}

	public static function dec( $v ) { return json_decode( (string) $v, true ) ?: null; }
	public static function enc( $v ) { return wp_json_encode( $v ); }
}
