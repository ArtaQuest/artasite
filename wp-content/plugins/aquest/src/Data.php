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
	 * Columns are projected. The default is every column except LONGTEXT: a list
	 * read must not pull a notebook body or an article just because the table has
	 * one. Pass the columns the caller serialises. Pass ['*'] only when the row's
	 * blobs are themselves the payload.
	 *
	 * @param string            $key     aq_* table
	 * @param string            $where   extra WHERE (without the cursor clause), e.g. "status = 'publish'"
	 * @param array             $args    args for $where placeholders
	 * @param int               $cursor  exclusive upper-bound id (0 = first page)
	 * @param int               $limit   page size
	 * @param string            $order   'DESC' (newest first) or 'ASC'
	 * @param string            $cur_col id column to page on
	 * @param array|string|null $select  column list, ['*'], or null for the narrow default
	 */
	public static function page( $key, $where, $args, $cursor, $limit, $order = 'DESC', $cur_col = 'id', $select = null ) {
		global $wpdb;
		$t = self::t( $key );
		$limit = max( 1, min( 100, (int) $limit ) );
		$cmp = $order === 'DESC' ? '<' : '>';
		$clauses = [];
		if ( $where ) { $clauses[] = "($where)"; }
		if ( $cursor > 0 ) { $clauses[] = "$cur_col $cmp %d"; $args[] = (int) $cursor; }
		$sql = 'SELECT ' . self::project( $t, $select, $cur_col ) . " FROM $t" . ( $clauses ? ' WHERE ' . implode( ' AND ', $clauses ) : '' )
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
	 * SQL column list for a read of $table (already prefixed).
	 *
	 * null     — every column except LONGTEXT (memoised SHOW COLUMNS). SELECT *
	 *            only if the table cannot be described, so a missing table fails
	 *            the way it used to rather than as a made-up column list.
	 * ['*']    — SELECT *. The caller needs the blobs.
	 * list     — those identifiers. $cur_col is added when the cursor reads it
	 *            and the caller left it out.
	 */
	public static function project( $table, $select = null, $cur_col = '' ) {
		if ( $select === '*' || $select === [ '*' ] ) { return '*'; }
		if ( is_array( $select ) && $select ) {
			$cols = self::idents( $select );
			$cur  = self::ident( $cur_col );
			if ( $cur !== '' && ! in_array( $cur, $cols, true ) ) { $cols[] = $cur; }
			if ( $cols ) { return implode( ', ', array_map( static fn( $c ) => '`' . $c . '`', $cols ) ); }
		}
		return self::narrow( $table );
	}

	/** Identifier-safe column names. Anything else is dropped, never interpolated. */
	private static function idents( $cols ) {
		$out = [];
		foreach ( (array) $cols as $c ) {
			$c = self::ident( $c );
			if ( $c !== '' ) { $out[] = $c; }
		}
		return $out;
	}

	private static function ident( $c ) {
		$c = (string) $c;
		return preg_match( '/^[A-Za-z_][A-Za-z0-9_]*$/', $c ) ? $c : '';
	}

	/** Every column of $table except LONGTEXT, or '*' when the table cannot be described. */
	private static function narrow( $table ) {
		static $memo = [];
		if ( isset( $memo[ $table ] ) ) { return $memo[ $table ]; }
		if ( ! preg_match( '/^[A-Za-z0-9_]+$/', (string) $table ) ) { return $memo[ $table ] = '*'; }
		global $wpdb;
		$rows = $wpdb->get_results( 'SHOW COLUMNS FROM `' . $table . '`', ARRAY_A );
		if ( ! $rows ) { return $memo[ $table ] = '*'; }
		$keep = [];
		foreach ( $rows as $r ) {
			if ( stripos( (string) ( $r['Type'] ?? '' ), 'longtext' ) !== false ) { continue; }
			$f = self::ident( $r['Field'] ?? '' );
			if ( $f !== '' ) { $keep[] = '`' . $f . '`'; }
		}
		return $memo[ $table ] = $keep ? implode( ', ', $keep ) : '*';
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
	 * @param int               $limit       page size
	 * @param array|string|null $select      columns to read (see page()); null = narrow default
	 */
	public static function search_page( $key, $cols, $q, $extra_where, $extra_args, $cursor, $limit, $select = null ) {
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
		return self::page( $key, $where, $args, $cursor, $limit, 'DESC', 'id', $select );
	}

	public static function dec( $v ) { return json_decode( (string) $v, true ) ?: null; }
	public static function enc( $v ) { return wp_json_encode( $v ); }
}
