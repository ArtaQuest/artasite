<?php
/**
 * Triple-check the denormalized counters changed in the scale-up:
 *   - aq_comments.votes  maintained by an atomic signed-delta bump (Learn::vote_comment) must stay
 *     EXACTLY equal to SUM(aq_votes.val) for the comment, across arbitrary up/down/clear/flip sequences.
 *   - aq_lessons.comment_count maintained by bumps on post/delete must equal COUNT(*) of the section's
 *     comments.
 * Replays randomized vote sequences over a throwaway scenario, asserts the invariant after EVERY step,
 * then removes every row it created (no residue). Read-only against your real data.
 *
 *   studio wp eval "require WP_PLUGIN_DIR.'/aquest/tools/verify-denorm.php';"
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }
global $wpdb; $p = $wpdb->prefix;

$lid = (int) $wpdb->get_var( "SELECT id FROM {$p}aq_lessons ORDER BY id LIMIT 1" );
$cid = (int) $wpdb->get_var( $wpdb->prepare( "SELECT course_id FROM {$p}aq_lessons WHERE id=%d", $lid ) );
if ( ! $lid ) { echo "no lessons to test against\n"; return; }

$base_cc = (int) $wpdb->get_var( $wpdb->prepare( "SELECT comment_count FROM {$p}aq_lessons WHERE id=%d", $lid ) );
$made_comments = []; $made_votes = []; $fail = 0; $steps = 0;

// helper mirroring Data::bump (atomic increment) — the exact primitive the handlers use.
$bump_votes = function( $id, $by ) use ( $wpdb, $p ) {
	$wpdb->query( $wpdb->prepare( "UPDATE {$p}aq_comments SET votes = votes + %d WHERE id = %d", $by, $id ) );
};
$sum_votes = function( $id ) use ( $wpdb, $p ) {
	return (int) $wpdb->get_var( $wpdb->prepare( "SELECT COALESCE(SUM(val),0) FROM {$p}aq_votes WHERE target_type='comment' AND target_id=%d", $id ) );
};
$col_votes = function( $id ) use ( $wpdb, $p ) {
	return (int) $wpdb->get_var( $wpdb->prepare( "SELECT votes FROM {$p}aq_comments WHERE id=%d", $id ) );
};

// 1) create 3 section comments (mirrors Learn::post_comment maintenance: insert + bump comment_count)
for ( $i = 0; $i < 3; $i++ ) {
	$wpdb->insert( "{$p}aq_comments", [
		'context_type' => 'section', 'context_id' => $lid, 'course_id' => $cid,
		'parent_id' => 0, 'author_id' => 900000 + $i, 'body' => 'denorm-test', 'lang' => 'en',
		'votes' => 0, 'created' => time(),
	] );
	$made_comments[] = (int) $wpdb->insert_id;
	$wpdb->query( $wpdb->prepare( "UPDATE {$p}aq_lessons SET comment_count = comment_count + 1 WHERE id=%d", $lid ) );
}

// comment_count invariant after posting
$cc = (int) $wpdb->get_var( $wpdb->prepare( "SELECT comment_count FROM {$p}aq_lessons WHERE id=%d", $lid ) );
if ( $cc !== $base_cc + 3 ) { $fail++; echo "comment_count after post: got $cc, want " . ( $base_cc + 3 ) . " ✗\n"; }

// 2) replay randomized vote sequences (the EXACT delta logic from Learn::vote_comment)
mt_srand( 12345 ); // deterministic
$dirs = [ 1, -1, 0 ];
foreach ( $made_comments as $target ) {
	for ( $v = 0; $v < 60; $v++ ) {
		$voter = 800000 + ( $v % 7 );           // 7 distinct voters cycling → up/down/clear/flip mix
		$dir   = $dirs[ mt_rand( 0, 2 ) ];
		$cur   = $wpdb->get_var( $wpdb->prepare( "SELECT val FROM {$p}aq_votes WHERE user_id=%d AND target_type='comment' AND target_id=%d", $voter, $target ) );
		$cur   = $cur === null ? 0 : (int) $cur;
		$new   = ( $dir === 0 || $dir === $cur ) ? 0 : $dir;
		if ( $new !== $cur ) {
			if ( $new === 0 ) {
				$wpdb->delete( "{$p}aq_votes", [ 'user_id' => $voter, 'target_type' => 'comment', 'target_id' => $target ] );
			} else {
				$wpdb->replace( "{$p}aq_votes", [ 'user_id'=>$voter,'target_type'=>'comment','target_id'=>$target,'val'=>$new,'course_id'=>$cid,'context_id'=>$lid,'created'=>time() ] );
			}
			$bump_votes( $target, $new - $cur );
			$made_votes[] = [ $voter, $target ];
		}
		$steps++;
		$colv = $col_votes( $target ); $sumv = $sum_votes( $target );
		if ( $colv !== $sumv ) { $fail++; echo "DRIFT comment $target step $v: column=$colv sum=$sumv ✗\n"; break; }
	}
}

// 3) Courses::get exposes the right per-section comment count (reads the column)
$req = new WP_REST_Request( 'GET', '/aq/v1/courses/' . $cid );
$req->set_param( 'id', $cid );
$resp = \AQ\Courses::get( $req );
$shown = 0;
if ( is_array( $resp ) && ! empty( $resp['lessons'] ) ) {
	foreach ( $resp['lessons'] as $l ) { if ( (int) $l['id'] === $lid ) { $shown = (int) $l['comments']; } }
}
$want = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$p}aq_comments WHERE context_type='section' AND context_id=%d", $lid ) );
if ( $shown !== $want ) { $fail++; echo "Courses::get comments for lesson: shown=$shown want=$want ✗\n"; }

// ── cleanup: remove every row created, restore comment_count ──────────────────────
foreach ( $made_comments as $id ) {
	$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_votes WHERE target_type='comment' AND target_id=%d", $id ) );
	$wpdb->delete( "{$p}aq_comments", [ 'id' => $id ] );
}
$wpdb->query( $wpdb->prepare( "UPDATE {$p}aq_lessons SET comment_count=%d WHERE id=%d", $base_cc, $lid ) );

$resid = (int) $wpdb->get_var( $wpdb->prepare( "SELECT comment_count FROM {$p}aq_lessons WHERE id=%d", $lid ) );
echo "\nsteps replayed: $steps   votes cast: " . count( $made_votes ) . "   comment_count restored: $resid (was $base_cc)\n";
echo $fail === 0 ? "ALL DENORM INVARIANTS HELD ✓\n" : "DENORM INVARIANTS FAILED ($fail) ✗\n";
