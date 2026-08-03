<?php
/**
 * Prove the podium projection (aq_quester, read with ORDER BY votes DESC, comments DESC, user_id DESC)
 * returns EXACTLY the same ranking as the canonical aggregate podium_ledger() — including across rows
 * tied on votes AND on comments, where the user_id tiebreak decides order. This is what guards the
 * 1.20.0 tiebreak flip (… user_id ASC → DESC): both the hot read and the source-of-truth must agree, or
 * verify_quester would drift and settlement could pay the wrong quester.
 *
 * Builds a throwaway course scenario with engineered ties, runs the REAL maintenance (quester_touch via
 * the same path post/vote use), checks podium()==podium_ledger(), then removes every row it created.
 *
 *   studio wp eval "require WP_PLUGIN_DIR.'/aquest/tools/verify-podium.php';"
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }
global $wpdb; $p = $wpdb->prefix;

$lid = (int) $wpdb->get_var( "SELECT id FROM {$p}aq_lessons ORDER BY id LIMIT 1" );
$cid = 990001; // synthetic course id unlikely to collide; quester/podium are keyed by it directly
if ( ! $lid ) { echo "no lessons\n"; return; }

$s   = \AQ\Season::current();
$now = (int) $s['start'] + 10; // inside the current season window so quester_touch counts it
$authors = [ 700101, 700102, 700103, 700104, 700105 ];
$made_c = []; $made_v = [];

// Engineer ties: authors get vote totals [5,5,3,3,0] and comment counts chosen so two pairs tie on BOTH
// votes and comments → the user_id tiebreak alone orders them. author 5 has comments but 0 votes.
//   a1: 1 comment, 5 votes     a2: 1 comment, 5 votes   (tie 5v/1c → user_id decides)
//   a3: 2 comments, 3 votes    a4: 2 comments, 3 votes   (tie 3v/2c → user_id decides)
//   a5: 1 comment, 0 votes
$plan = [
	700101 => [ 'comments' => 1, 'votes' => 5 ],
	700102 => [ 'comments' => 1, 'votes' => 5 ],
	700103 => [ 'comments' => 2, 'votes' => 3 ],
	700104 => [ 'comments' => 2, 'votes' => 3 ],
	700105 => [ 'comments' => 1, 'votes' => 0 ],
];
$voter = 700999;
foreach ( $plan as $author => $spec ) {
	$remaining_votes = $spec['votes'];
	for ( $i = 0; $i < $spec['comments']; $i++ ) {
		$wpdb->insert( "{$p}aq_comments", [
			'context_type' => 'section', 'context_id' => $lid, 'course_id' => $cid,
			'parent_id' => 0, 'author_id' => $author, 'body' => 'podium-test', 'lang' => 'en',
			'votes' => 0, 'flagged' => 0, 'created' => $now,
		] );
		$comment_id = (int) $wpdb->insert_id;
		$made_c[] = $comment_id;
		// put all of this author's votes on their first comment
		$give = ( $i === 0 ) ? $remaining_votes : 0;
		for ( $v = 0; $v < $give; $v++ ) {
			$uid = $voter + $v; // distinct voters
			$wpdb->replace( "{$p}aq_votes", [ 'user_id' => $uid, 'target_type' => 'comment', 'target_id' => $comment_id, 'val' => 1, 'course_id' => $cid, 'context_id' => $lid, 'created' => $now ] );
			$made_v[] = [ $uid, $comment_id ];
		}
	}
}

// run the REAL scoped maintenance for each author (exactly what post/vote call)
foreach ( $authors as $a ) { \AQ\Economy::quester_touch( $cid, $a ); }

// compare projection vs ledger
$proj = \AQ\Economy::podium( $cid, 0, $s['start'], $s['end'] );
$ref  = \AQ\Economy::podium_ledger( $cid, $s['start'], $s['end'] );
$ref  = array_slice( $ref, 0, \AQ\Economy::PODIUM_BOARD );

echo "rank  proj(user/votes/q)      ledger(user/votes/q)\n";
$fail = 0;
$max = max( count( $proj ), count( $ref ) );
for ( $i = 0; $i < $max; $i++ ) {
	$pp = $proj[ $i ] ?? null; $rr = $ref[ $i ] ?? null;
	$ps = $pp ? "{$pp['user_id']}/{$pp['votes']}/{$pp['questions']}" : '—';
	$rs = $rr ? "{$rr['user_id']}/{$rr['votes']}/{$rr['questions']}" : '—';
	$ok = $pp && $rr && (int) $pp['user_id'] === (int) $rr['user_id'] && (int) $pp['votes'] === (int) $rr['votes'] && (int) $pp['questions'] === (int) $rr['questions'];
	if ( ! $ok ) { $fail++; }
	printf( "%-5d %-23s %-23s %s\n", $i + 1, $ps, $rs, $ok ? 'OK' : '✗' );
}

// cleanup
foreach ( $made_c as $id ) {
	$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_votes WHERE target_type='comment' AND target_id=%d", $id ) );
	$wpdb->delete( "{$p}aq_comments", [ 'id' => $id ] );
}
$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_quester WHERE course_id=%d", $cid ) );

echo "\n" . ( $fail === 0 ? "PODIUM PROJECTION == LEDGER (tiebreaks agree) ✓\n" : "PODIUM MISMATCH ($fail rows) ✗\n" );
