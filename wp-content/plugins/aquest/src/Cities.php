<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * The city gazetteer behind the place-of-birth selector.
 *
 * WHY A LOCAL TABLE AND NOT THE GEONAMES WEB API. ArtaMatch resolves cities through GeoNames online
 * (kerykeion's cache sits beside it), which is fine for a batch job and wrong for this: place of
 * birth is asked for during SIGN-UP, and sign-up must not fail because a third party is down, rate
 * limits us, or is slow from wherever the member is. So the gazetteer ships with the plugin and the
 * search runs on our own database.
 *
 * DATA: GeoNames cities15000 (every city over 15,000 people — 34,078 of them), trimmed to the eight
 * fields a selector and a birth chart need. Licensed CC BY 4.0, which requires attribution: the
 * picker credits GeoNames in the UI, and this notice is the other half of that obligation.
 * Coordinates are stored to 4 decimal places (~11 m) — far past what any chart needs, and it halves
 * the file. Rebuild with tools/cities-build.mjs.
 */
final class Cities {

	const FILE  = AQ_DIR . '/data/cities.tsv';
	const LIMIT = 8;

	/** Fold a query the same way the build script folded the search column: lowercase, no accents. */
	public static function fold( $s ) {
		$s = mb_strtolower( trim( (string) $s ) );
		if ( function_exists( 'iconv' ) ) {
			$t = @iconv( 'UTF-8', 'ASCII//TRANSLIT//IGNORE', $s );
			if ( is_string( $t ) && $t !== '' ) { $s = strtolower( $t ); }
		}
		return preg_replace( '/[^a-z0-9 ]+/', '', $s );
	}

	/**
	 * GET /cities?q= — type-ahead over the gazetteer.
	 *
	 * Ranked by POPULATION, which is the only ranking a birthplace picker can honestly apply: typing
	 * "tehran" must offer the city of 7 million before a hamlet that shares its name, and no other
	 * signal here distinguishes them. Prefix matches beat contains-matches so a full name typed out
	 * lands first.
	 */
	public static function search( $req ) {
		global $wpdb;
		$q = self::fold( Rest::p( $req, 'q', '' ) );
		if ( mb_strlen( $q ) < 2 ) { return [ 'items' => [] ]; }
		$t    = Data::t( 'aq_cities' );
		$like = $wpdb->esc_like( $q );
		$rows = Data::all(
			"SELECT name, country, admin1, lat, lon, tz, population FROM {$t}
			  WHERE search LIKE %s
			  ORDER BY (CASE WHEN search LIKE %s THEN 0 ELSE 1 END), population DESC
			  LIMIT %d",
			[ '%' . $like . '%', $like . '%', self::LIMIT ]
		);
		$out = [];
		foreach ( $rows as $r ) {
			$out[] = [
				'name'    => (string) $r['name'],
				'country' => (string) $r['country'],
				'admin1'  => (string) $r['admin1'],
				'lat'     => (float) $r['lat'],
				'lon'     => (float) $r['lon'],
				'tz'      => (string) $r['tz'],
			];
		}
		return [ 'items' => $out, 'attribution' => 'GeoNames (CC BY 4.0)' ];
	}

	/** How many cities are loaded. 0 means the seed never ran — the picker then has nothing to offer. */
	public static function count() {
		return (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_cities' ) );
	}

	/**
	 * Load the gazetteer, once. Idempotent by row count: a table that already holds cities is left
	 * alone, so a Schema bump for an unrelated reason never re-imports 34k rows.
	 *
	 * Chunked because a single 34,000-row INSERT exceeds max_allowed_packet on a default MySQL and
	 * fails as one unit — 500 at a time is well inside it and a partial failure leaves a countable,
	 * re-runnable state rather than an empty table that looks seeded.
	 */
	public static function seed( $force = false ) {
		global $wpdb;
		if ( ! $force && self::count() > 0 ) { return 0; }
		if ( ! is_readable( self::FILE ) ) { return 0; }
		$t = Data::t( 'aq_cities' );
		if ( $force ) { $wpdb->query( "DELETE FROM {$t}" ); }
		$fh = fopen( self::FILE, 'r' );
		if ( ! $fh ) { return 0; }
		$n = 0; $batch = []; $vals = [];
		while ( ( $line = fgets( $fh ) ) !== false ) {
			$p = explode( "\t", rtrim( $line, "\n" ) );
			if ( count( $p ) < 8 ) { continue; }
			$batch[] = '(%s,%s,%s,%s,%f,%f,%d,%s)';
			array_push( $vals, $p[0], $p[1], $p[2], $p[3], (float) $p[4], (float) $p[5], (int) $p[6], $p[7] );
			if ( count( $batch ) >= 500 ) { $n += self::flush( $t, $batch, $vals ); $batch = []; $vals = []; }
		}
		if ( $batch ) { $n += self::flush( $t, $batch, $vals ); }
		fclose( $fh );
		return $n;
	}

	private static function flush( $t, $batch, $vals ) {
		global $wpdb;
		$sql = "INSERT INTO {$t} (name,search,country,admin1,lat,lon,population,tz) VALUES " . implode( ',', $batch );
		$ok  = $wpdb->query( $wpdb->prepare( $sql, $vals ) );
		return $ok ? count( $batch ) : 0;
	}
}
