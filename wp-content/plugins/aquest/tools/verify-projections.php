<?php
/**
 * Verify the materialized projections equal the append-only ledgers they summarize.
 *
 * The ledgers (aq_coin_ledger / aq_points_ledger) are the source of truth; aq_standing /
 * aq_counters are a derived cache maintained in lockstep on write. This proves the cache is
 * EXACTLY consistent with the source — the safety invariant behind serving reads from the
 * projection. Optionally rebuilds first (pass 'rebuild') to test the full recompute path.
 *
 *   studio wp eval "require WP_PLUGIN_DIR.'/aquest/tools/verify-projections.php';"
 *   studio wp eval "define('AQ_REBUILD',1); require WP_PLUGIN_DIR.'/aquest/tools/verify-projections.php';"
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }

if ( defined( 'AQ_REBUILD' ) && AQ_REBUILD ) {
	\AQ\Economy::rebuild_projections();
	\AQ\Economy::rebuild_quester();
	echo "rebuilt projections (standing/counters/quester) from the source tables\n";
}

$allok = true;

// 1. ledger projections (aq_standing / aq_counters) vs the append-only ledgers
$rows = \AQ\Economy::verify_projections();
printf( "%-18s %14s %14s   %s\n", 'check', 'projected', 'ledger', 'ok' );
echo str_repeat( '─', 56 ) . "\n";
foreach ( $rows as $r ) {
	if ( ! $r['ok'] ) { $allok = false; }
	printf( "%-18s %14d %14d   %s\n", $r['check'], $r['projected'], $r['ledger'], $r['ok'] ? 'OK' : '✗ DRIFT' );
}
echo str_repeat( '─', 56 ) . "\n";

// 2. quester projection (aq_quester) vs the canonical aggregate over comments/votes, per course
$qrows = \AQ\Economy::verify_quester();
$qbad = 0;
foreach ( $qrows as $r ) { if ( ! $r['ok'] ) { $qbad++; $allok = false; echo "  quester DRIFT course {$r['course_id']}: {$r['note']}\n"; } }
echo 'quester: ' . ( count( $qrows ) - $qbad ) . '/' . count( $qrows ) . " courses match the comment/vote tables" . ( $qbad ? " ✗\n" : " ✓\n" );

// 3. full-reserve invariant: gold backing (aq_coin_backing_mg) ≥ coins in circulation (Σ coin ledger).
// A break means coins exist that no gold backs — a solvency failure. Every mint MUST be matched by
// backing (buy bumps it; bursary-funded fees call Economy::add_backing; settlement only mints from
// already-backed revenue), so this should always hold.
$res = \AQ\Economy::verify_reserve();
if ( ! $res['ok'] ) { $allok = false; }
printf( "reserve: issued %d ₳ · backing %d mg · ratio %.4f  %s\n",
	$res['issued'], $res['backing'], $res['ratio'], $res['ok'] ? '✓' : '✗ UNDER-COLLATERALIZED' );

echo "\n" . ( $allok ? "ALL PROJECTIONS EXACT + FULLY RESERVED ✓\n" : "INVARIANT BROKEN ✗ (run with AQ_REBUILD=1 to repair projections; reserve drift needs an operator)\n" );
