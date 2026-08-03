<?php
/**
 * import-courses-bulk.php — apply a course-only export (from export-courses.php) on a
 * target site, upserting every course idempotently BY SLUG. Mirrors import-course.php's
 * logic but loops over many courses in one pass. Touches ONLY aq_courses, aq_lessons and
 * aq_yt_meta_<vid> options — never users, ledgers, options or any other prod data.
 *
 * Run on PROD over SSH:
 *   wp eval-file import-courses-bulk.php           (reads ./aq-courses-export.json)
 *   AQ_BULK_FILE=/path/to.json wp eval-file import-courses-bulk.php   (override path)
 *
 * Safe to re-run; existing courses are updated, missing ones created. IDs are assigned
 * by the target DB (the SPA links by slug, so cross-environment IDs need not match).
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }

( function () {
	$path = getenv( 'AQ_BULK_FILE' ) ?: ( __DIR__ . '/aq-courses-export.json' );
	if ( ! file_exists( $path ) ) {
		// Fall back to common locations.
		foreach ( [ getcwd() . '/aq-courses-export.json', '/tmp/aq-courses-export.json', WP_CONTENT_DIR . '/uploads/aq-courses-export.json' ] as $p ) {
			if ( file_exists( $p ) ) { $path = $p; break; }
		}
	}
	if ( ! file_exists( $path ) ) {
		echo wp_json_encode( [ 'ok' => false, 'error' => 'export_not_found', 'tried' => $path ] ) . "\n";
		return;
	}
	$data  = json_decode( (string) file_get_contents( $path ), true );
	$specs = $data['specs'] ?? [];
	$yt    = $data['yt_meta'] ?? [];
	if ( ! $specs ) {
		echo wp_json_encode( [ 'ok' => false, 'error' => 'no_specs', 'path' => $path ] ) . "\n";
		return;
	}

	// ID-preserving lesson sync (members' progress/boards survive re-imports). The
	// include travels next to this file when scp'd to prod uploads; falls back to
	// the plugin tools dir when run in place.
	$inc = file_exists( __DIR__ . '/lesson-sync.inc.php' ) ? __DIR__ . '/lesson-sync.inc.php' : WP_PLUGIN_DIR . '/aquest/tools/lesson-sync.inc.php';
	if ( ! file_exists( $inc ) ) {
		echo wp_json_encode( [ 'ok' => false, 'error' => 'lesson_sync_inc_not_found', 'tried' => $inc ] ) . "\n";
		return;
	}
	require_once $inc;

	global $wpdb;
	$now     = \AQ\Data::now();
	$created = 0; $updated = 0; $sections = 0; $cids = [];

	// Course authorship: every pipeline-imported course belongs to the operator's member account
	// (/u/arash — operator directive 2026-06-12), pinned by the `aq_course_author_uid` option so
	// local and prod stay consistent; first admin only as a fresh-install fallback.
	$default_author = (int) get_option( 'aq_course_author_uid', 0 );
	if ( ! $default_author ) {
		$admins = get_users( [ 'role' => 'administrator', 'number' => 1, 'fields' => 'ID' ] );
		$default_author = $admins ? (int) $admins[0] : 1;
	}

	foreach ( $specs as $spec ) {
		$slug = sanitize_title( (string) ( $spec['slug'] ?? '' ) );
		if ( $slug === '' ) { continue; }
		$author = (int) ( $spec['author_id'] ?? 0 ) ?: $default_author;
		$c_title   = sanitize_text_field( (string) ( $spec['title'] ?? '' ) );
		$c_summary = wp_kses_post( (string) ( $spec['summary'] ?? '' ) );
		$c_channel = sanitize_text_field( (string) ( $spec['channel'] ?? '' ) );
		$fields = [
			'title'     => $c_title,
			'summary'   => $c_summary,
			'image'     => esc_url_raw( (string) ( $spec['image'] ?? '' ) ),
			'channel'   => $c_channel,
			'author_id' => $author,
			'status'    => 'publish',
			'price'     => max( 0, (int) ( $spec['price'] ?? 0 ) ),
		];
		$existing = \AQ\Data::one( 'SELECT id, topic FROM ' . \AQ\Data::t( 'aq_courses' ) . ' WHERE slug = %s', [ $slug ] );
		// Catalogue subject facet. Seed it from the explicit spec `topic` (validated) or, failing that,
		// classify the text — but for a course that ALREADY has a valid, specific house on the target,
		// PRESERVE it. A course-data sync must not silently reshuffle the catalogue's facets on every
		// deploy (the previous always-classify path did exactly that). New courses still take the house
		// their spec carries (e.g. a topic-linked course's house); an existing 'other'/invalid is upgraded.
		$spec_topic = \AQ\Topics::is_valid( (string) ( $spec['topic'] ?? '' ) )
			? (string) $spec['topic']
			: \AQ\Topics::classify( $c_title, $c_channel, $c_summary );
		$keep_topic = $existing
			&& \AQ\Topics::is_valid( (string) $existing['topic'] )
			&& (string) $existing['topic'] !== \AQ\Topics::OTHER;
		$fields['topic'] = $keep_topic ? (string) $existing['topic'] : $spec_topic;
		if ( $existing ) {
			$cid = (int) $existing['id'];
			\AQ\Data::update( 'aq_courses', $fields, [ 'id' => $cid ] );
			$updated++;
		} else {
			$cid = \AQ\Data::insert( 'aq_courses', array_merge( $fields, [ 'slug' => $slug, 'created' => $now ] ) );
			$created++;
		}
		$sync = aq_sync_lessons( $cid, (array) ( $spec['lessons'] ?? [] ) );
		$sections += $sync['lesson_count'];
		$cids[] = $cid;
	}

	$opts = 0;
	foreach ( (array) $yt as $vid => $m ) {
		$vid = sanitize_text_field( (string) $vid );
		if ( $vid === '' || ! is_array( $m ) ) { continue; }
		update_option( 'aq_yt_meta_' . $vid, $m, false );
		$opts++;
	}

	// Register the imported videos with the view-count monitor, then recompute each course's view
	// metrics + rank_score (avg views/video) so the catalogue ranks them right away (carries the
	// import-time view snapshot above), not only after the next daily refresh.
	if ( class_exists( '\\AQ\\YouTube' ) ) {
		\AQ\YouTube::sync_registry();
		foreach ( array_unique( $cids ) as $cid ) { \AQ\YouTube::recompute_course_trend( (int) $cid ); }
	}

	echo wp_json_encode( [
		'ok'       => true,
		'created'  => $created,
		'updated'  => $updated,
		'sections' => $sections,
		'yt_meta'  => $opts,
	] ) . "\n";
} )();
