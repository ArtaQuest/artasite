<?php
/**
 * verify-creator-split.php — prove settle_window pays a course's CREATOR their tier-scaled share of the
 * non-pool remainder (the ≤20% after the questers' 80% pool): Creator 50% → Legend 100%, the foundation
 * keeps the rest. Idempotent (signed-delta, one ref per course+season) and the full-reserve invariant
 * (backing ≥ issued) holds through the minting. Self-cleaning synthetic scenario (restores the global
 * coin counters it touches).
 *
 *   studio wp eval "require WP_PLUGIN_DIR.'/aquest/tools/verify-creator-split.php';"
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }
global $wpdb; $p = $wpdb->prefix;
$fail = 0;
$ok = function ( $cond, $label, $detail = '' ) use ( &$fail ) {
	echo ( $cond ? 'PASS  ' : 'FAIL  ' ) . $label . ( $cond ? '' : " — $detail" ) . "\n";
	if ( ! $cond ) { $fail++; }
};

$AUTHOR  = 760001;
$SLUG    = 'aq-test-creator-split';
$REVENUE = 100; // pool = floor(100 × 0.8) = 80 ; remainder = 20

// Self-cleaning: remove any scratch course(s) + reverse the global counters this test bumped. Idempotent,
// loops every matching row so a previously-aborted run is fully undone on the next start.
$cleanup = function () use ( $wpdb, $p, $SLUG, $AUTHOR, $REVENUE ) {
	foreach ( $wpdb->get_col( $wpdb->prepare( "SELECT id FROM {$p}aq_courses WHERE slug = %s", $SLUG ) ) as $cid ) {
		$cid    = (int) $cid;
		$like   = $wpdb->esc_like( 'c' . $cid . ':' ) . '%';
		$minted = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COALESCE(SUM(delta),0) FROM {$p}aq_coin_ledger WHERE ref LIKE %s", $like ) );
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_coin_ledger WHERE ref LIKE %s", $like ) );
		if ( $minted ) { \AQ\Economy::counter_add( 'coins_issued', -$minted ); } // reverse the supply bump
		\AQ\Economy::counter_add( 'backing_mg', -$REVENUE );                      // reverse the simulated gold
		$wpdb->delete( "{$p}aq_courses", [ 'id' => $cid ] );
	}
	$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_standing WHERE user_id = %d", $AUTHOR ) );
};
$cleanup();

$reserve0 = \AQ\Economy::verify_reserve();

// Scratch course: known author, revenue set, 20 enrolled (eligible). add_backing(revenue) stands in for the
// gold a paid enrol's burn (or a bursary/sponsor's add_backing) would have left in reserve.
$cid = (int) \AQ\Data::insert( 'aq_courses', [
	'slug' => $SLUG, 'title' => 'Creator split test', 'summary' => '', 'image' => '',
	'channel' => 'Test', 'author_id' => $AUTHOR, 'status' => 'draft',
	'revenue' => $REVENUE, 'enroll_count' => 20, 'created' => \AQ\Data::now(),
] );
\AQ\Economy::add_backing( $REVENUE );

// Author at CREATOR tier (1,000 pts) → share 0.50 → target floor(20 × 0.5) = 10.
$wpdb->insert( "{$p}aq_standing", [ 'track' => 'all', 'user_id' => $AUTHOR, 'points' => 1000, 'updated' => \AQ\Data::now() ] );
$ok( abs( \AQ\Economy::creator_share( $AUTHOR ) - 0.50 ) < 1e-9, 'creator_share: 1,000 pts → Creator → 0.50' );

\AQ\Economy::settle_course_rewards( $cid );
$ok( \AQ\Economy::coin_balance( $AUTHOR ) === 10, 'Creator tier: creator earns floor(20 × 0.50) = 10', (string) \AQ\Economy::coin_balance( $AUTHOR ) );

\AQ\Economy::settle_course_rewards( $cid ); // idempotent
$ok( \AQ\Economy::coin_balance( $AUTHOR ) === 10, 'idempotent: re-settle does not double-pay', (string) \AQ\Economy::coin_balance( $AUTHOR ) );

// Promote to LEGEND (1,000,000 pts) → share 1.00 → target 20 → +10 signed-delta rebalance.
$wpdb->query( $wpdb->prepare( "UPDATE {$p}aq_standing SET points = 1000000 WHERE track = 'all' AND user_id = %d", $AUTHOR ) );
$ok( \AQ\Economy::creator_share( $AUTHOR ) === 1.00, 'creator_share: 1,000,000 pts → Legend → 1.00' );
\AQ\Economy::settle_course_rewards( $cid );
$ok( \AQ\Economy::coin_balance( $AUTHOR ) === 20, 'Legend: rebalances up to floor(20 × 1.00) = 20 (foundation 0)', (string) \AQ\Economy::coin_balance( $AUTHOR ) );

$reserve1 = \AQ\Economy::verify_reserve();
$ok( $reserve1['ok'], 'full-reserve invariant holds (backing ≥ issued) after creator minting', json_encode( $reserve1 ) );

// Below the Creator rung → share 0, earns nothing.
$wpdb->query( $wpdb->prepare( "UPDATE {$p}aq_standing SET points = 10 WHERE track = 'all' AND user_id = %d", $AUTHOR ) );
$ok( \AQ\Economy::creator_share( $AUTHOR ) === 0.0, 'creator_share: below Creator rung → 0.0' );

$cleanup();
$reserve2 = \AQ\Economy::verify_reserve();
$ok( $reserve2['issued'] === $reserve0['issued'] && $reserve2['backing'] === $reserve0['backing'], 'cleanup: reserve restored to baseline', json_encode( [ $reserve0, $reserve2 ] ) );

echo "\n" . ( $fail === 0 ? "CREATOR_SPLIT=GREEN\n" : "CREATOR_SPLIT=RED ($fail failures)\n" );
