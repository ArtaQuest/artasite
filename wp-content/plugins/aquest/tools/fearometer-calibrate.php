<?php
/**
 * Fearometer calibration harness (corpus-driven).
 *
 * Loads a labelled corpus from tools/fearometer-corpus.json and scores each case through
 * AQ\Fearometer::score() against the live Claude API, emitting one machine-parseable ROW line per
 * case plus a SLICE summary, so calibration can be aggregated across many runs and dev cycles.
 *
 * Corpus row shape: {"category":..,"lang":..,"text":..,"flag":bool,"note":..}  (flag = gold label)
 *
 * Each studio wp eval has a ~120s WP-CLI ceiling, and the corpus is hundreds of live API calls, so
 * run in SLICES and sum the tallies:
 *   studio wp eval '$GLOBALS["aq_fear_off"]=0;$GLOBALS["aq_fear_lim"]=25;require WP_PLUGIN_DIR."/aquest/tools/fearometer-calibrate.php";'
 *
 * ROW format (tab-separated, newlines/tabs stripped from free text):
 *   ROW\t<idx>\t<category>\t<lang>\t<score>\t<exp01>\t<pred01>\t<ok01>\t<reason>
 * SLICE format:
 *   SLICE\toff=<>\tn=<>\tTP=<>\tFP=<>\tFN=<>\tTN=<>\tmaxNeg=<>\tminPos=<>
 *
 * The full text is NOT in ROW (look it up by idx in the corpus) so the output stays compact.
 */

if ( ! defined( 'ABSPATH' ) ) { exit; }
if ( ! class_exists( 'AQ\\Fearometer' ) ) { echo "Fearometer not loaded\n"; return; }

$corpus_path = AQ_DIR . '/tools/fearometer-corpus.json';
$cases = [];
if ( is_readable( $corpus_path ) ) {
	$cases = json_decode( (string) file_get_contents( $corpus_path ), true );
	if ( ! is_array( $cases ) ) { echo "corpus json parse error\n"; return; }
} else {
	echo "no corpus at $corpus_path — run the generator first\n"; return;
}

// Normalize rows to [category, lang, text, flag, note].
$cases = array_values( array_filter( array_map( function ( $r ) {
	if ( ! is_array( $r ) || ! isset( $r['text'] ) || trim( (string) $r['text'] ) === '' ) { return null; }
	return [ (string) ( $r['category'] ?? '?' ), (string) ( $r['lang'] ?? '?' ), (string) $r['text'], ! empty( $r['flag'] ), (string) ( $r['note'] ?? '' ) ];
}, $cases ) ) );

$off   = isset( $GLOBALS['aq_fear_off'] ) ? (int) $GLOBALS['aq_fear_off'] : 0;
$lim_n = isset( $GLOBALS['aq_fear_lim'] ) ? (int) $GLOBALS['aq_fear_lim'] : count( $cases );
$slice = array_slice( $cases, $off, $lim_n, true ); // preserve original indexes as ROW idx

$tp = $fp = $fn = $tn = 0; $maxNeg = -1; $minPos = 101; $nulls = 0;
$strip = fn( $s ) => trim( preg_replace( '/\s+/u', ' ', (string) $s ) );
foreach ( $slice as $idx => $c ) {
	[ $category, $lang, $text, $expect, $note ] = $c;
	$v = AQ\Fearometer::score( $text );
	if ( $v === null ) { // one retry on a transient upstream blip, then record as null (score -1)
		$nulls++; usleep( 700000 ); $v = AQ\Fearometer::score( $text );
	}
	if ( $v === null ) {
		printf( "ROW\t%d\t%s\t%s\t-1\t%d\t-1\t-1\tnull-upstream\n", $idx, $strip( $category ), $strip( $lang ), $expect ? 1 : 0 );
		continue;
	}
	$score = (int) $v['fear'];
	$pred  = (bool) $v['flagged'];
	$ok    = ( $pred === $expect );
	if ( $pred && $expect ) { $tp++; } elseif ( $pred && ! $expect ) { $fp++; } elseif ( ! $pred && $expect ) { $fn++; } else { $tn++; }
	if ( $expect ) { $minPos = min( $minPos, $score ); } else { $maxNeg = max( $maxNeg, $score ); }
	printf( "ROW\t%d\t%s\t%s\t%d\t%d\t%d\t%d\t%s\n", $idx, $strip( $category ), $strip( $lang ), $score, $expect ? 1 : 0, $pred ? 1 : 0, $ok ? 1 : 0, mb_substr( $strip( $v['reason'] ?? '' ), 0, 90 ) );
	usleep( 25000 );
}
printf( "SLICE\toff=%d\tn=%d\tTP=%d\tFP=%d\tFN=%d\tTN=%d\tmaxNeg=%d\tminPos=%d\tnulls=%d\tLIMIT=%d\n",
	$off, count( $slice ), $tp, $fp, $fn, $tn, $maxNeg, $minPos === 101 ? -1 : $minPos, $nulls, AQ\Fearometer::LIMIT );
