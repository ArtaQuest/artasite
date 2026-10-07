<?php
/**
 * Pure helpers for ArashAcceptance (no WordPress bootstrap).
 * Run: php wp-content/plugins/aquest/tools/test-arash-acceptance.php
 */
$fail = 0;
$ok = function ($cond, $msg) use (&$fail) {
	if ( $cond ) { echo "OK  $msg\n"; return; }
	echo "FAIL $msg\n";
	$fail++;
};

// Inline the pure math from ArashAcceptance to avoid loading WP.
$rate = function ( $accepted, $pending ) {
	$den = (int) $accepted + (int) $pending;
	if ( $den <= 0 ) { return null; }
	return round( ( (int) $accepted ) / $den, 6 );
};
$wilson = function ( $successes, $n ) {
	$n = (int) $n; $s = (int) $successes;
	if ( $n <= 0 ) { return [ 'low' => null, 'high' => null ]; }
	$z = 1.959963984540054; $phat = $s / $n; $z2 = $z * $z; $den = 1 + $z2 / $n;
	$centre = $phat + $z2 / ( 2 * $n );
	$margin = $z * sqrt( ( $phat * ( 1 - $phat ) + $z2 / ( 4 * $n ) ) / $n );
	return [
		'low'  => round( max( 0.0, ( $centre - $margin ) / $den ), 6 ),
		'high' => round( min( 1.0, ( $centre + $margin ) / $den ), 6 ),
	];
};

$ok( $rate( 0, 0 ) === null, 'rate empty is null' );
$ok( $rate( 1, 1 ) === 0.5, 'rate 1/2 = 0.5' );
$ok( $rate( 3, 1 ) === 0.75, 'rate 3/4 = 0.75' );
$w = $wilson( 3, 4 );
$ok( $w['low'] !== null && $w['low'] < 0.75 && $w['high'] > 0.75, 'wilson brackets 0.75' );

// TaskSync allow-list (require TaskSync with stubbed WP bits is heavy — just parse the source).
$src = file_get_contents( __DIR__ . '/../src/TaskSync.php' );
$ok( strpos( $src, "'requestStatus.json'" ) !== false, 'TaskSync NAMES includes requestStatus.json' );
$ok( strpos( $src, 'ArashAcceptance::ingest_blob' ) !== false, 'TaskSync put ingests research tables' );
$schema = file_get_contents( __DIR__ . '/../src/Schema.php' );
$ok( strpos( $schema, 'aq_arash_request_events' ) !== false, 'schema has aq_arash_request_events' );
$ok( strpos( $schema, 'aq_arash_request_state' ) !== false, 'schema has aq_arash_request_state' );
$ok( strpos( $schema, 'aq_arash_acceptance_daily' ) !== false, 'schema has aq_arash_acceptance_daily' );
$ok( strpos( $schema, "VERSION = '1.80.0'" ) !== false, 'schema VERSION 1.80.0' );
$aq = file_get_contents( __DIR__ . '/../aquest.php' );
$ok( strpos( $aq, '1.20.748' ) !== false, 'plugin 1.20.748' );
$ok( strpos( $aq, "'ArashAcceptance'" ) !== false, 'ArashAcceptance loaded' );

exit( $fail ? 1 : 0 );
