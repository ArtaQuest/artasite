<?php
/**
 * import-course.php — idempotent YouTube→course importer for the typology-course
 * dev loop. Creates (or updates, keyed by slug) one aq_courses row plus its
 * ordered aq_lessons sections, caches per-video YouTube metadata in the
 * aq_yt_meta_<vid> option (so the lesson player shows views/channel), and
 * recomputes the denormalized lesson_count + duration. The competition (seasons,
 * rankings, 20%-of-revenue podium) attaches automatically — it is data-driven off
 * the sections + activity, so nothing else is needed to give a course its contest.
 *
 * Run under WordPress (so $wpdb + AQ\Data are loaded):
 *   studio wp eval 'require WP_PLUGIN_DIR."/aquest/tools/import-course.php";'
 *
 * Input: a JSON spec at wp-content/uploads/aq-course-import.json (override the path
 * by setting $aq_import_file before the require). Shape:
 *   {
 *     "slug": "the-big-five",            // optional; derived from title if absent
 *     "title": "...",
 *     "summary": "<p>SEO-optimised HTML summary</p>",
 *     "image": "https://i.ytimg.com/.../maxresdefault.jpg",
 *     "channel": "Primary channel name",  // shown on the course card
 *     "author_id": 138325219,             // optional; defaults to first admin
 *     "price": 25,                        // optional entry fee in coins; 0/absent → platform default
 *     "lessons": [ { "title","video","duration","transcript"? }, ... ],
 *     "yt_meta": { "<vid>": {views,upload_ts,channel,channel_url,subs,verified,avatar} }
 *   }
 *
 * Output: prints a one-line JSON result { ok, id, slug, url, lessons, action }.
 */

namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

( function () {
	global $aq_import_file;
	$path = $aq_import_file ?: ( WP_CONTENT_DIR . '/uploads/aq-course-import.json' );
	if ( ! file_exists( $path ) ) {
		echo wp_json_encode( [ 'ok' => false, 'error' => 'spec_not_found', 'path' => $path ] ) . "\n";
		return;
	}
	$spec = json_decode( (string) file_get_contents( $path ), true );
	if ( ! is_array( $spec ) || empty( $spec['title'] ) || empty( $spec['lessons'] ) ) {
		echo wp_json_encode( [ 'ok' => false, 'error' => 'bad_spec' ] ) . "\n";
		return;
	}

	$title  = sanitize_text_field( (string) $spec['title'] );
	$slug   = sanitize_title( (string) ( $spec['slug'] ?? $title ) ) ?: 'course';
	$author = (int) ( $spec['author_id'] ?? 0 );
	if ( ! $author ) {
		// Pipeline courses belong to the operator's member account (/u/arash — `aq_course_author_uid`,
		// operator directive 2026-06-12); first admin only as a fresh-install fallback.
		$author = (int) get_option( 'aq_course_author_uid', 0 );
	}
	if ( ! $author ) {
		$admins = get_users( [ 'role' => 'administrator', 'number' => 1, 'fields' => 'ID' ] );
		$author = $admins ? (int) $admins[0] : 1;
	}
	$now = Data::now();

	$summary = wp_kses_post( (string) ( $spec['summary'] ?? '' ) );
	$channel = sanitize_text_field( (string) ( $spec['channel'] ?? '' ) );
	$fields = [
		'title'     => $title,
		'summary'   => $summary,
		'image'     => esc_url_raw( (string) ( $spec['image'] ?? '' ) ),
		'channel'   => $channel,
		'author_id' => $author,
		// Primary subject for the catalogue facet. Honour an explicit spec `topic` (validated), else
		// classify from the course text — so an imported course filters by subject straight away.
		'topic'     => Topics::is_valid( (string) ( $spec['topic'] ?? '' ) ) ? (string) $spec['topic'] : Topics::classify( $title, $channel, $summary ),
		'status'    => 'publish',
		// Entry fee in coins. 0 (the default) → the platform default fee applies (Funds::course_cost);
		// set a positive `price` in the spec to override it for this course.
		'price'     => max( 0, (int) ( $spec['price'] ?? 0 ) ),
	];

	// Upsert the course by slug (idempotent across loop re-runs).
	$existing = Data::one( 'SELECT id FROM ' . Data::t( 'aq_courses' ) . ' WHERE slug = %s', [ $slug ] );
	if ( $existing ) {
		$cid    = (int) $existing['id'];
		$action = 'updated';
		Data::update( 'aq_courses', $fields, [ 'id' => $cid ] );
	} else {
		$action = 'created';
		$cid    = Data::insert( 'aq_courses', array_merge( $fields, [ 'slug' => $slug, 'created' => $now ] ) );
	}

	// Sections: ID-PRESERVING diff-sync (matched rows keep their id, so members'
	// watch progress, section boards and engagement state survive a re-import).
	$inc = file_exists( __DIR__ . '/lesson-sync.inc.php' ) ? __DIR__ . '/lesson-sync.inc.php' : WP_PLUGIN_DIR . '/aquest/tools/lesson-sync.inc.php';
	require_once $inc;
	$sync = aq_sync_lessons( $cid, (array) $spec['lessons'] );
	$idx  = $sync['lesson_count'];

	// Cache per-video YouTube metadata for the lesson player (views, channel, …).
	if ( ! empty( $spec['yt_meta'] ) && is_array( $spec['yt_meta'] ) ) {
		foreach ( $spec['yt_meta'] as $vid => $m ) {
			$vid = sanitize_text_field( (string) $vid );
			if ( $vid === '' || ! is_array( $m ) ) { continue; }
			update_option( 'aq_yt_meta_' . $vid, [
				'views'       => (int) ( $m['views'] ?? 0 ),
				'upload_ts'   => (int) ( $m['upload_ts'] ?? 0 ),
				'channel'     => (string) ( $m['channel'] ?? '' ),
				'channel_url' => (string) ( $m['channel_url'] ?? '' ),
				'subs'        => (int) ( $m['subs'] ?? 0 ),
				'verified'    => ! empty( $m['verified'] ),
				'avatar'      => (string) ( $m['avatar'] ?? '' ),
			], false );
		}
	}

	// Register any new videos with the view-count monitor so the daily refresh picks them up
	// (carries the import-time view count above as their starting snapshot), then recompute this
	// course's denormalized view metrics + rank_score (avg views/video) so the catalogue ranks it
	// correctly straight away, not only after the next daily refresh.
	if ( class_exists( '\\AQ\\YouTube' ) ) { YouTube::sync_registry(); YouTube::recompute_course_trend( $cid ); }

	$slug_row = Data::one( 'SELECT slug FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
	echo wp_json_encode( [
		'ok'      => true,
		'action'  => $action,
		'id'      => $cid,
		'slug'    => $slug_row['slug'],
		'url'     => '/courses/' . $slug_row['slug'],
		'lessons' => $idx,
		'sync'    => [ 'kept' => $sync['kept'], 'moved' => $sync['moved'], 'added' => $sync['added'], 'removed' => $sync['removed'], 'removed_ids' => $sync['removed_ids'] ],
	] ) . "\n";
} )();
