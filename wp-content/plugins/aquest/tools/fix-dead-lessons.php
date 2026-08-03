<?php
/**
 * fix-dead-lessons.php — replace specific dead (removed/privated) lesson videos with
 * fresh equivalents, in place. Reads replacement metadata from uploads/fix_bundle.json
 * (yt_research bundle format, keyed by video id). Updates aq_lessons (video, transcript,
 * duration, seg_start/end=0) and sets the aq_yt_meta_<vid> option. Idempotent: matches the
 * lesson by (course slug, idx, OLD video id) so a re-run after the swap is a no-op.
 *
 * Run on LOCAL from site root: studio wp eval 'require WP_PLUGIN_DIR."/aquest/tools/fix-dead-lessons.php";'
 * Then deploy-prod.sh propagates the corrected courses to prod.
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }

( function () {
	global $wpdb;
	$pf = $wpdb->prefix;
	$bundle = json_decode( (string) file_get_contents( WP_CONTENT_DIR . '/uploads/fix_bundle.json' ), true ) ?: [];

	// [ course_slug, idx, old_video, new_video, new_title ]
	$fixes = [
		[ 'economics-explained',     2, 'g9aDizJpd_s', '8JYP_wU1JTU', 'Supply and demand' ],
		[ 'personal-finance-basics', 2, 'TJDcGv9OH4Q', '_5ecgEXLoCA', 'The psychology of money' ],
	];

	foreach ( $fixes as list( $slug, $idx, $old, $new, $title ) ) {
		$cid = (int) $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$pf}aq_courses WHERE slug=%s", $slug ) );
		if ( ! $cid ) { echo "skip: no course $slug\n"; continue; }
		$m = $bundle[ $new ] ?? null;
		if ( ! $m ) { echo "skip: no bundle for $new\n"; continue; }
		$n = $wpdb->query( $wpdb->prepare(
			"UPDATE {$pf}aq_lessons SET video=%s, title=%s, transcript=%s, duration=%d, seg_start=0, seg_end=0
			 WHERE course_id=%d AND idx=%d AND video=%s",
			$new, $title, (string) ( $m['transcript'] ?? '' ), (int) ( $m['duration'] ?? 0 ), $cid, $idx, $old
		) );
		update_option( 'aq_yt_meta_' . $new, [
			'views' => $m['views'] ?? 0, 'upload_ts' => $m['upload_ts'] ?? 0, 'channel' => $m['channel'] ?? '',
			'channel_url' => $m['channel_url'] ?? '', 'subs' => $m['subs'] ?? 0,
			'verified' => $m['verified'] ?? false, 'avatar' => $m['avatar'] ?? '',
		], false );
		echo "fixed $slug idx$idx: $old -> $new (rows=$n)\n";
	}
} )();
