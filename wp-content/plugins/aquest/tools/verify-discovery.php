<?php
/**
 * verify-discovery.php — unit tests for the Data-API DISCOVERY + CHURN pipeline (YouTube.php, 1.39.0).
 *
 * Exercises the PURE decision logic that drives the three crons — iso8601_seconds, pick_candidate,
 * settle_decision (prove-then-add), prune_targets (the >5-videos / mean−2σ drop rule) — plus the daily
 * quota counter's date-reset and the fail-safe that discover() no-ops when the API is unconfigured.
 * Touches NO network and mutates NO course (it never calls settle_candidates/prune_underperformers,
 * which write) — only the quota option, which it restores. Self-contained + GREEN/RED.
 *
 * Run:  studio wp eval 'require WP_PLUGIN_DIR . "/aquest/tools/verify-discovery.php";'
 */

if ( ! defined( 'ABSPATH' ) ) { exit; }
use AQ\YouTube;

$pass = 0; $fail = 0;
$ok = function ( $cond, $label ) use ( &$pass, &$fail ) {
	if ( $cond ) { $pass++; echo "  ok  $label\n"; }
	else { $fail++; echo "  FAIL $label\n"; }
};

echo "== iso8601_seconds ==\n";
$ok( YouTube::iso8601_seconds( 'PT5M30S' ) === 330, 'PT5M30S = 330' );
$ok( YouTube::iso8601_seconds( 'PT1H2M3S' ) === 3723, 'PT1H2M3S = 3723' );
$ok( YouTube::iso8601_seconds( 'PT45S' ) === 45, 'PT45S = 45' );
$ok( YouTube::iso8601_seconds( 'PT10M' ) === 600, 'PT10M = 600' );
$ok( YouTube::iso8601_seconds( 'PT2H' ) === 7200, 'PT2H = 7200' );
$ok( YouTube::iso8601_seconds( '' ) === 0, 'empty = 0' );
$ok( YouTube::iso8601_seconds( 'garbage' ) === 0, 'garbage = 0' );

echo "== pick_candidate ==\n";
// A single valid candidate is chosen.
$ok( YouTube::pick_candidate( 'Stoicism', [
	[ 'id' => 'aaa', 'title' => 'Intro to Stoicism', 'seconds' => 600, 'comments' => 40, 'embeddable' => true, 'public' => true ],
] ) === 'aaa', 'one valid candidate picked' );
// Too short / no comments / not embeddable / private are all filtered out → none valid.
$ok( YouTube::pick_candidate( 'X', [
	[ 'id' => 'short', 'title' => 'X', 'seconds' => 60, 'comments' => 99, 'embeddable' => true, 'public' => true ],
	[ 'id' => 'silent', 'title' => 'X', 'seconds' => 600, 'comments' => 0, 'embeddable' => true, 'public' => true ],
	[ 'id' => 'noembed', 'title' => 'X', 'seconds' => 600, 'comments' => 9, 'embeddable' => false, 'public' => true ],
	[ 'id' => 'private', 'title' => 'X', 'seconds' => 600, 'comments' => 9, 'embeddable' => true, 'public' => false ],
] ) === '', 'all-invalid → empty' );
// On-topic beats a higher-comment off-topic one (relevance nudge).
$ok( YouTube::pick_candidate( 'Photosynthesis Basics', [
	[ 'id' => 'offtopic', 'title' => 'Funny cats compilation', 'seconds' => 600, 'comments' => 5000, 'embeddable' => true, 'public' => true ],
	[ 'id' => 'ontopic', 'title' => 'How Photosynthesis Works', 'seconds' => 600, 'comments' => 80, 'embeddable' => true, 'public' => true ],
] ) === 'ontopic', 'on-topic preferred over higher-comment off-topic' );
// Among on-topic, the most-discussed wins.
$ok( YouTube::pick_candidate( 'Quantum Mechanics', [
	[ 'id' => 'lo', 'title' => 'Quantum Mechanics for beginners', 'seconds' => 600, 'comments' => 30, 'embeddable' => true, 'public' => true ],
	[ 'id' => 'hi', 'title' => 'Quantum Mechanics explained', 'seconds' => 600, 'comments' => 300, 'embeddable' => true, 'public' => true ],
] ) === 'hi', 'among on-topic, most comments wins' );
// No on-topic match → falls back to the most-discussed valid one (search was already topical).
$ok( YouTube::pick_candidate( 'Zzzz', [
	[ 'id' => 'a', 'title' => 'Alpha', 'seconds' => 600, 'comments' => 10, 'embeddable' => true, 'public' => true ],
	[ 'id' => 'b', 'title' => 'Beta', 'seconds' => 600, 'comments' => 90, 'embeddable' => true, 'public' => true ],
] ) === 'b', 'no on-topic → top valid by comments' );

echo "== pick_candidate velocity (recent beats old-saturated) ==\n";
$nowt = time();
$velset = [
	[ 'id' => 'old', 'title' => 'Quantum old', 'seconds' => 600, 'comments' => 50000, 'embeddable' => true, 'public' => true, 'published' => $nowt - 3000 * 86400 ],
	[ 'id' => 'new', 'title' => 'Quantum new', 'seconds' => 600, 'comments' => 1000, 'embeddable' => true, 'public' => true, 'published' => $nowt - 30 * 86400 ],
];
$ok( YouTube::pick_candidate( 'Quantum', $velset, $nowt ) === 'new', 'recent 33/day beats old-saturated 16/day (despite 50× the cumulative)' );
$ok( YouTube::pick_candidate( 'Quantum', $velset ) === 'old', 'no dates (now=0) → falls back to cumulative' );

echo "== settle_decision (prove-then-add) ==\n";
$ok( YouTube::settle_decision( 100, 50 ) === true, 'rate>baseline → add' );
$ok( YouTube::settle_decision( 50, 50 ) === true, 'rate==baseline → add' );
$ok( YouTube::settle_decision( 49, 50 ) === false, 'rate<baseline → discard' );
$ok( YouTube::settle_decision( 0, 0 ) === false, 'rate 0 (even vs 0 baseline) → discard' );
$ok( YouTube::settle_decision( 1, 0 ) === true, 'any positive rate beats a 0 baseline' );

echo "== settle_decision grow (thin) vs maintain (full) ==\n";
$ok( YouTube::settle_decision( 150, 1000, 1 ) === true, 'GROW (1 video): active candidate added even below average' );
$ok( YouTube::settle_decision( 50, 10, 1 ) === false, 'GROW: near-dead (<1/day = 100 centi) rejected even above baseline' );
$ok( YouTube::settle_decision( 150, 1000, 5 ) === false, 'MAINTAIN (5 videos): below-average rejected' );
$ok( YouTube::settle_decision( 1000, 1000, 5 ) === true, 'MAINTAIN: at-average added' );
$ok( YouTube::settle_decision( 0, 0, 1 ) === false, 'dead video never added (grow phase)' );

echo "== prune_targets (>5 videos, mean−2σ, floor) ==\n";
// Not eligible: 5 or fewer videos.
$ok( YouTube::prune_targets( [ 'a' => 100, 'b' => 100, 'c' => 100, 'd' => 100, 'e' => 1 ] ) === [], '5 videos → not eligible' );
// Eligible (6) with one extreme low outlier → it is dropped.
$drop = YouTube::prune_targets( [ 'a' => 100, 'b' => 105, 'c' => 95, 'd' => 100, 'e' => 102, 'low' => 0 ] );
$ok( $drop === [ 'low' ], '6 videos, clear low outlier dropped: ' . json_encode( $drop ) );
// All equal → σ=0 → nothing dropped.
$ok( YouTube::prune_targets( array_fill_keys( [ 'a','b','c','d','e','f' ], 50 ) ) === [], 'all equal → no drop' );
// A tight cluster with no point beyond 2σ → nothing dropped.
$ok( YouTube::prune_targets( [ 'a'=>100,'b'=>101,'c'=>99,'d'=>100,'e'=>100,'f'=>100 ] ) === [], 'no 2σ outlier → no drop' );
// MIN_VIDEOS floor: even with many lows, never shrink below the floor.
$many = [ 'k1'=>1000,'k2'=>1000 ];
for ( $i = 0; $i < 6; $i++ ) { $many[ 'z' . $i ] = 0; } // 8 videos, 6 zeros far below the mean
$kept = 8 - count( YouTube::prune_targets( $many ) );
$ok( $kept >= 2, "floor respected — kept $kept (>=2)" );

echo "== quota counter (daily reset) ==\n";
$saved = get_option( 'aq_yt_discover_count' );
update_option( 'aq_yt_discover_count', [ 'day' => (int) gmdate( 'Ymd' ), 'n' => 7 ], false );
$ok( YouTube::discover_searches_today() === 7, 'today\'s count read back = 7' );
update_option( 'aq_yt_discover_count', [ 'day' => (int) gmdate( 'Ymd', time() - 86400 ), 'n' => 999 ], false );
$ok( YouTube::discover_searches_today() === 0, 'yesterday\'s count resets to 0' );
if ( $saved === false ) { delete_option( 'aq_yt_discover_count' ); } else { update_option( 'aq_yt_discover_count', $saved, false ); }

echo "== operator levers clamp (Console config) ==\n";
$saved_cap = get_option( 'aq_discover_cap' );
$saved_pr  = get_option( 'aq_discover_per_run' );
update_option( 'aq_discover_cap', 999, false );  $ok( YouTube::discover_cap() === 90, 'cap clamps high → 90: ' . YouTube::discover_cap() );
update_option( 'aq_discover_cap', -5, false );   $ok( YouTube::discover_cap() === 0, 'cap clamps low → 0 (pause): ' . YouTube::discover_cap() );
update_option( 'aq_discover_per_run', 50, false );$ok( YouTube::discover_per_run() === 10, 'per_run clamps high → 10: ' . YouTube::discover_per_run() );
update_option( 'aq_discover_per_run', 0, false ); $ok( YouTube::discover_per_run() === 1, 'per_run clamps low → 1: ' . YouTube::discover_per_run() );
if ( $saved_cap === false ) { delete_option( 'aq_discover_cap' ); } else { update_option( 'aq_discover_cap', $saved_cap, false ); }
if ( $saved_pr === false ) { delete_option( 'aq_discover_per_run' ); } else { update_option( 'aq_discover_per_run', $saved_pr, false ); }

echo "== discover() fail-safe (no API configured locally) ==\n";
if ( ! YouTube::enabled() ) {
	$cur = (int) get_option( 'aq_discover_cursor', 0 );
	$r = YouTube::discover();
	$ok( is_array( $r ) && ( $r['reason'] ?? '' ) === 'disabled' && (int) $r['tracked'] === 0, 'discover() no-ops when disabled' );
	$ok( (int) get_option( 'aq_discover_cursor', 0 ) === $cur, 'discover() left the cursor untouched' );
} else {
	echo "  (skipped — API is configured here; would make live calls)\n";
}

echo "\n== verify-discovery: $pass passed, $fail failed ==\n";
