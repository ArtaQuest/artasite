<?php
/**
 * verify-sponsor-topic.php — prove Funds::sponsor_topic flows a topic-earmarked gift into the topic's
 * LIVE course prize pool: records the typ_<key> earmark (gross), grows the course revenue in coins, buys
 * matching gold (backing), debits the earmark for the spent CAD, and the full-reserve invariant holds.
 * Self-cleaning — captures every economy counter it touches and restores the exact baseline.
 *
 *   studio wp eval "require WP_PLUGIN_DIR.'/aquest/tools/verify-sponsor-topic.php';"
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }
global $wpdb; $p = $wpdb->prefix;
$fail = 0;
$ok = function ( $c, $l, $d = '' ) use ( &$fail ) { echo ( $c ? 'PASS  ' : 'FAIL  ' ) . $l . ( $c ? '' : " — $d" ) . "\n"; if ( ! $c ) { $fail++; } };

$UID = 770001; $AUTHOR = 770002; $TOPIC = 'aqtestsponsor'; $SLUG = 'aq-test-sponsor-course';
$CENTS = 10000; // $100 gift

$cleanup = function () use ( $wpdb, $p, $TOPIC, $SLUG, $UID, $AUTHOR ) {
	foreach ( $wpdb->get_col( $wpdb->prepare( "SELECT id FROM {$p}aq_courses WHERE slug = %s", $SLUG ) ) as $cid ) {
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_coin_ledger WHERE ref LIKE %s", $wpdb->esc_like( 'c' . (int) $cid . ':' ) . '%' ) );
		$wpdb->delete( "{$p}aq_courses", [ 'id' => (int) $cid ] );
	}
	$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_fund_ledger WHERE bucket = %s", 'typ_' . $TOPIC ) );
	$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_points_ledger WHERE user_id = %d", $UID ) );
	$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_standing WHERE user_id IN (%d, %d)", $UID, $AUTHOR ) );
	$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_topics WHERE topic_key = %s", $TOPIC ) );
};
$cleanup();

// Baseline of every counter this test moves, so we can prove we restored it exactly.
$b_back = \AQ\Economy::backing_mg();
$b_iss  = \AQ\Economy::counter( 'coins_issued' );
$reserve0 = \AQ\Economy::verify_reserve();

// Scratch topic linked to a scratch LIVE course (≥20 enrolled, Legend author so the whole 20% is minted).
$cid = (int) \AQ\Data::insert( 'aq_courses', [
	'slug' => $SLUG, 'title' => 'Sponsor flow test', 'summary' => '', 'image' => '', 'channel' => 'Test',
	'author_id' => $AUTHOR, 'status' => 'publish', 'revenue' => 0, 'enroll_count' => 20, 'created' => \AQ\Data::now(),
] );
$wpdb->insert( "{$p}aq_topics", [ 'topic_key' => $TOPIC, 'name' => 'Sponsor Test', 'blurb' => 'x', 'course' => '/courses/' . $SLUG, 'active' => 1 ] );
$wpdb->insert( "{$p}aq_standing", [ 'track' => 'all', 'user_id' => $AUTHOR, 'points' => 1000000, 'updated' => \AQ\Data::now() ] ); // Legend

$price = (float) \AQ\Economy::coin_price()['sell'];
$coins = (int) floor( $CENTS / ( $price * 100 ) );
$spent = (int) round( $coins * $price * 100 );

\AQ\Funds::sponsor_topic( $UID, $CENTS, $TOPIC, 'test:sponsor' );

$rev = (int) \AQ\Data::col( "SELECT revenue FROM {$p}aq_courses WHERE id = %d", [ $cid ] );
$ok( $coins >= 1, "coin price gives a movable amount ($coins coins from \$100 at sell $price)", "coins=$coins" );
$ok( $rev === $coins, "course revenue grew by the gift's coin value ($coins)", "revenue=$rev" );
$ok( \AQ\Economy::backing_mg() - $b_back === $coins, "gold backing grew by $coins mg (mint stays fully backed)", (string) ( \AQ\Economy::backing_mg() - $b_back ) );
$net = (int) \AQ\Economy::counter( 'fund_typ_' . $TOPIC );
$ok( $net === $CENTS - $spent, "typ_ earmark nets the held sub-coin remainder (gross $CENTS − spent $spent)", "net=$net" );
$ok( \AQ\Economy::verify_reserve()['ok'], 'full-reserve invariant holds after the sponsorship flow', json_encode( \AQ\Economy::verify_reserve() ) );
// Legend author + 20 enrolled → settlement minted the creator 20% of the remainder (proves it reached settle).
$pool = \AQ\Economy::reward_pool( $coins );
$ok( \AQ\Economy::coin_balance( $AUTHOR ) === ( $coins - $pool ), "settled: Legend creator earned the full remainder (coins-pool=" . ( $coins - $pool ) . ")", (string) \AQ\Economy::coin_balance( $AUTHOR ) );
// no live course → the gift is HELD, not lost
\AQ\Funds::sponsor_topic( $UID, 500, 'aqtestnocourse', 'test:held' );
$ok( (int) \AQ\Economy::counter( 'fund_typ_aqtestnocourse' ) === 500, 'course-less topic: gift HELD in the earmark (not lost)', (string) \AQ\Economy::counter( 'fund_typ_aqtestnocourse' ) );
$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_fund_ledger WHERE bucket = %s", 'typ_aqtestnocourse' ) );

$cleanup();
// restore the coin counters to baseline (the fund counters are rebuilt from the now-clean ledger)
\AQ\Economy::counter_add( 'backing_mg', $b_back - \AQ\Economy::backing_mg() );
\AQ\Economy::counter_add( 'coins_issued', $b_iss - \AQ\Economy::counter( 'coins_issued' ) );
\AQ\Funds::rebuild_fund_counters();
$reserve2 = \AQ\Economy::verify_reserve();
$ok( $reserve2['issued'] === $reserve0['issued'] && $reserve2['backing'] === $reserve0['backing'], 'cleanup: reserve restored to baseline', json_encode( [ $reserve0, $reserve2 ] ) );

echo "\n" . ( $fail === 0 ? "SPONSOR_TOPIC=GREEN\n" : "SPONSOR_TOPIC=RED ($fail failures)\n" );
