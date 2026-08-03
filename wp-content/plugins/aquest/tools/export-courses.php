<?php
/**
 * export-courses.php — dump every aq_courses row (+ its aq_lessons sections and the
 * per-video aq_yt_meta_<vid> options) to a single portable JSON, for a course-only
 * sync to production (NOT a full DB push — prod keeps its users/ledgers). The output
 * is consumed by import-courses-bulk.php on prod, which upserts idempotently by slug.
 *
 * Run on LOCAL: studio wp eval 'require WP_PLUGIN_DIR."/aquest/tools/export-courses.php";'
 * Writes: wp-content/uploads/aq-courses-export.json
 *
 * Superseded duplicate hub courses (replaced by bespoke deepening courses, 0 systems
 * reference them) are skipped so prod gets a clean catalogue.
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }

( function () {
	global $wpdb;
	$skip = [
		'the-big-five-personality-traits',           // → big-five-ocean-personality
		'ayurvedic-doshas-vata-pitta-kapha',         // → ayurveda-doshas-vata-pitta-kapha
		'astrology-sun-signs-and-the-zodiac',        // → western-birth-chart-placements
	];
	$pf   = $wpdb->prefix;
	$rows = $wpdb->get_results( "SELECT * FROM {$pf}aq_courses ORDER BY id", ARRAY_A );
	$specs = [];
	$vids  = [];
	foreach ( $rows as $c ) {
		if ( in_array( $c['slug'], $skip, true ) ) { continue; }
		$lessons = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$pf}aq_lessons WHERE course_id = %d ORDER BY idx, id", (int) $c['id'] ),
			ARRAY_A
		);
		$L = [];
		foreach ( $lessons as $l ) {
			$L[] = [
				'title'      => $l['title'],
				'video'      => $l['video'],
				'duration'   => (int) $l['duration'],
				'seg_start'  => (int) $l['seg_start'],
				'seg_end'    => (int) $l['seg_end'],
				'transcript' => $l['transcript'],
			];
			if ( ! empty( $l['video'] ) ) { $vids[ $l['video'] ] = 1; }
		}
		$specs[] = [
			'slug'      => $c['slug'],
			'title'     => $c['title'],
			'summary'   => $c['summary'],
			'image'     => $c['image'],
			'channel'   => $c['channel'],
			'author_id' => (int) $c['author_id'],
			// Carry the catalogue house so the linkage-derived/explicit subject survives the sync —
			// without it the bulk importer re-classify()s every course on prod each deploy, so an
			// explicitly-set house (e.g. a topic-linked course) never persists. The importer preserves
			// an existing valid house on the target, so this only seeds NEW courses + fixes 'other'.
			'topic'     => $c['topic'],
			'price'     => (int) $c['price'],
			'lessons'   => $L,
		];
	}
	$yt = [];
	foreach ( array_keys( $vids ) as $v ) {
		$o = get_option( 'aq_yt_meta_' . $v );
		if ( $o !== false ) { $yt[ $v ] = $o; }
	}
	$path = WP_CONTENT_DIR . '/uploads/aq-courses-export.json';
	file_put_contents( $path, wp_json_encode( [ 'specs' => $specs, 'yt_meta' => $yt ] ) );
	echo 'exported ' . count( $specs ) . ' courses, ' . count( $yt ) . " yt_meta videos to $path\n";
	echo 'bytes=' . filesize( $path ) . "\n";
} )();
