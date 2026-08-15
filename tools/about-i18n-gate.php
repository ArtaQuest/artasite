<?php
/**
 * THE FOUNDER'S NOTE STILL MATCHES ITS HAND-WRITTEN TRANSLATIONS — a drift gate.
 *
 * `AboutI18n::pairs()` keys Persian and Arabic on **md5 of the English source**, because that is how
 * `aq_translations` is addressed. So changing one character of a paragraph in About.tsx — a comma, a
 * straight apostrophe for a curly one, an en dash for an em dash — silently orphans its translation.
 * Nothing errors. The page simply falls back to machine output in Persian and Arabic, which is the
 * exact outcome the hand-written text exists to prevent, and the failure is invisible in English.
 *
 * So this asserts, for every English source in pairs(), that the string still appears VERBATIM in
 * About.tsx. It is deliberately a substring check rather than a parse: the strings live in a TS
 * array today and could live in JSON tomorrow, and what matters is only that the exact bytes we
 * hashed are still the bytes the page renders.
 *
 * Exit 0 = every translation still reachable. Exit 1 = at least one orphaned, and it names them.
 * Exit 2 = the gate could not read its own inputs (fail loudly; a check that matches nothing is
 * worse than no check).
 */

$root  = dirname( __DIR__ );
$tsx   = $root . '/artaquest-web/src/pages/About.tsx';
$php   = $root . '/wp-content/plugins/aquest/src/AboutI18n.php';

$page = @file_get_contents( $tsx );
if ( $page === false ) { fwrite( STDERR, "about-i18n-gate: cannot read $tsx\n" ); exit( 2 ); }
$src = @file_get_contents( $php );
if ( $src === false ) { fwrite( STDERR, "about-i18n-gate: cannot read $php\n" ); exit( 2 ); }

// Load pairs() without booting WordPress: the class only needs its own file, and seed() (the one
// method that touches $wpdb) is never called here.
if ( ! defined( 'ABSPATH' ) ) { define( 'ABSPATH', $root . '/' ); }
require_once $php;
if ( ! class_exists( '\\AQ\\AboutI18n' ) ) { fwrite( STDERR, "about-i18n-gate: AQ\\AboutI18n did not load\n" ); exit( 2 ); }

$pairs = \AQ\AboutI18n::pairs();
if ( ! $pairs ) { fwrite( STDERR, "about-i18n-gate: pairs() is empty — refactored?\n" ); exit( 2 ); }

// About.tsx stores these inside double-quoted TS string literals, so an apostrophe is written `\'`
// in the PHP source but appears bare in the TSX. Compare against a copy with TS escaping undone.
$hay = str_replace( [ '\\"', "\\'" ], [ '"', "'" ], $page );

$missing = [];
$ok      = 0;
foreach ( $pairs as $en => $tr ) {
	// Labels are short and also appear in prose; the paragraphs are what actually drift. Both are
	// checked the same way — a short string that vanished is just as orphaned.
	if ( strpos( $hay, $en ) !== false ) { $ok++; continue; }
	$missing[] = $en;
}

foreach ( $missing as $m ) {
	fwrite( STDERR, "  ORPHANED (no longer in About.tsx, its fa/ar will be ignored):\n    \"" . mb_substr( $m, 0, 96 ) . ( mb_strlen( $m ) > 96 ? '…' : '' ) . "\"\n" );
}
if ( $missing ) {
	fwrite( STDERR, "\nabout-i18n-gate: " . count( $missing ) . " of " . count( $pairs ) . " sources no longer match About.tsx.\n" );
	fwrite( STDERR, "Edit AboutI18n::pairs() to the new English, and re-translate that paragraph — the md5 key changed.\n" );
	exit( 1 );
}
echo "OK — all $ok English sources still verbatim in About.tsx (fa + ar reachable)\n";
exit( 0 );
