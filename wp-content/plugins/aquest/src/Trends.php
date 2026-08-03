<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Google-Trends demand scoring for topics + cycles.
 *
 * The raw 2004→now worldwide web-search interest series for each query is fetched OUT OF BAND
 * by the local `trends-fetch` tool (Google Trends has no API + rate-limits hard, so we never
 * fetch from prod's request path) and bulk-imported here. We cache the RAW monthly series in
 * aq_trends so the 0-100 "demand score" can be recomputed in-place if its weighting changes —
 * no re-fetch. The score blends three signals off the same curve:
 *   • recent  — mean of the last 12 months (Google normalises the all-time peak to 100, so this
 *               is literally how close today's interest sits to the topic's all-time peak)
 *   • band    — where `recent` falls in the topic's own trough→peak range (0 = at its low, 100 = high)
 *   • momentum— recent minus the 2004 baseline (rising vs fading), mapped to 0-100
 * High score ⇒ the topic is at/near a peak of real-world curiosity right now; low ⇒ in a trough.
 */
class Trends {

	private static function mean( array $a ) { return $a ? array_sum( $a ) / count( $a ) : 0.0; }

	/** Recompute the 0-100 score (+ components) from a raw series. Null if too short to be meaningful. */
	public static function score_series( array $v ) {
		$v = array_values( array_map( 'intval', $v ) );
		$n = count( $v );
		if ( $n < 24 ) { return null; }
		$recent   = self::mean( array_slice( $v, -12 ) );
		$trough   = min( $v );
		$peak     = max( $v );
		$band     = $peak > $trough ? ( ( $recent - $trough ) / ( $peak - $trough ) ) * 100 : 50;
		$momentum = $recent - self::mean( array_slice( $v, 0, 12 ) );
		$momScore = max( 0, min( 100, 50 + $momentum / 2 ) );
		$score    = (int) round( 0.45 * $recent + 0.25 * $band + 0.30 * $momScore );
		return array(
			'score'    => $score,
			'recent'   => (int) round( $recent ),
			'peak'     => (int) $peak,
			'trough'   => (int) $trough,
			'band'     => (int) round( $band ),
			'momentum' => (int) round( $momentum ),
		);
	}

	/**
	 * Upsert trend rows. $items: [ { ref, kind, query, series:[int…], score?, … } ].
	 * `ref` is "topic:<topic_key>" or "cycle:<slug>". The score is recomputed from `series`
	 * when present (authoritative), else taken from the supplied components. For topic refs the
	 * denormalised aq_topics.trend_score is kept in sync. Returns the number of rows written.
	 */
	public static function import_array( array $items ) {
		global $wpdb;
		$p = $wpdb->prefix; $t = "{$p}aq_trends"; $now = time(); $n = 0;
		foreach ( $items as $it ) {
			$ref = sanitize_text_field( (string) ( $it['ref'] ?? '' ) );
			if ( $ref === '' ) { continue; }
			$kind   = sanitize_text_field( (string) ( $it['kind'] ?? ( strpos( $ref, 'cycle:' ) === 0 ? 'cycle' : 'topic' ) ) );
			$query  = sanitize_text_field( (string) ( $it['query'] ?? '' ) );
			$series = array_map( 'intval', (array) ( $it['series'] ?? array() ) );
			$sc = self::score_series( $series );
			if ( ! $sc ) {
				$sc = array(
					'score'    => (int) ( $it['score'] ?? -1 ),
					'recent'   => (int) ( $it['recent'] ?? 0 ),
					'peak'     => (int) ( $it['peak'] ?? 0 ),
					'trough'   => (int) ( $it['trough'] ?? 0 ),
					'band'     => (int) ( $it['band'] ?? 0 ),
					'momentum' => (int) ( $it['momentum'] ?? 0 ),
				);
			}
			$row = array_merge(
				array( 'ref' => $ref, 'kind' => $kind, 'query' => $query, 'series' => wp_json_encode( $series ), 'updated' => $now ),
				$sc
			);
			$id = $wpdb->get_var( $wpdb->prepare( "SELECT id FROM $t WHERE ref = %s", $ref ) );
			if ( $id ) { $wpdb->update( $t, $row, array( 'id' => (int) $id ) ); }
			else { $wpdb->insert( $t, $row ); }
			if ( $kind === 'topic' ) {
				$key = preg_replace( '/^topic:/', '', $ref );
				$wpdb->query( $wpdb->prepare( "UPDATE {$p}aq_topics SET trend_score = %d WHERE topic_key = %s", $sc['score'], $key ) );
			}
			$n++;
		}
		return $n;
	}

	/** POST studio/trends/import {items:[…]} — operator only (bulk sync from the local fetch tool). */
	public static function import_rest( $req ) {
		if ( ! current_user_can( 'manage_options' ) ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		$items = $req->get_param( 'items' );
		if ( ! is_array( $items ) ) { return Rest::err( 'bad_request', 'items[] required', 400 ); }
		return array( 'ok' => true, 'imported' => self::import_array( $items ) );
	}

	/**
	 * GET trends?ref=topic:<key>|cycle:<slug> — public, CDN-cacheable. Returns the cached series +
	 * score components for one ref (the Studio editor sparkline + the /why cycle chart read this).
	 */
	public static function get_rest( $req ) {
		global $wpdb;
		$p = $wpdb->prefix;
		$ref = sanitize_text_field( (string) $req->get_param( 'ref' ) );
		if ( $ref === '' ) { return Rest::err( 'bad_request', 'ref required', 400 ); }
		$r = $wpdb->get_row(
			$wpdb->prepare( "SELECT ref, kind, query, series, score, recent, peak, trough, band, momentum, updated FROM {$p}aq_trends WHERE ref = %s", $ref ),
			ARRAY_A
		);
		if ( ! $r ) { return array( 'ref' => $ref, 'found' => false, 'series' => array() ); }
		$r['series'] = json_decode( (string) $r['series'], true ) ?: array();
		foreach ( array( 'score', 'recent', 'peak', 'trough', 'band', 'momentum', 'updated' ) as $k ) { $r[ $k ] = (int) $r[ $k ]; }
		$r['found'] = true;
		return $r;
	}

	/**
	 * Import fetched Google-Trends scores from data/aq-trends.json on load (filemtime-gated, mirroring
	 * the grants/courses importers). The local trends-fetch tool writes this file; shipping it via deploy
	 * is how scores reach prod — we never scrape Google from prod's request path. Re-imports on change.
	 */
	public static function import_file() {
		$file = AQ_DIR . '/data/aq-trends.json';
		if ( ! is_readable( $file ) ) { return; }
		$mtime = (string) filemtime( $file );
		if ( get_option( 'aq_trends_import_mtime' ) === $mtime ) { return; }
		$data  = json_decode( (string) file_get_contents( $file ), true );
		$items = is_array( $data ) ? ( $data['items'] ?? $data ) : array();
		if ( is_array( $items ) && $items ) { self::import_array( $items ); }
		update_option( 'aq_trends_import_mtime', $mtime, false );
	}

	/**
	 * Import the per-DISCIPLINE Google-Trends series from data/aq-disc-trends.json (filemtime-gated) —
	 * ref "disc:<key>", kind "discipline" (quarterly-averaged 2004→now). These power the analysis chart
	 * shown when a field is opened on /fields; served by GET /trends?ref=disc:<key>.
	 */
	public static function import_disc_file() {
		$file = AQ_DIR . '/data/aq-disc-trends.json';
		if ( ! is_readable( $file ) ) { return; }
		$mtime = (string) filemtime( $file );
		if ( get_option( 'aq_disc_trends_mtime' ) === $mtime ) { return; }
		$data  = json_decode( (string) file_get_contents( $file ), true );
		$items = is_array( $data ) ? ( $data['items'] ?? $data ) : array();
		if ( is_array( $items ) && $items ) { self::import_array( $items ); }
		update_option( 'aq_disc_trends_mtime', $mtime, false );
	}
}
