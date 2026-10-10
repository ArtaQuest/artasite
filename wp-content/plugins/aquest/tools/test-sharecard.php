<?php
/** test-sharecard.php — ShareCard text cleaning, wrapping and rendering (needs GD + FreeType). php tools/test-sharecard.php */
define( 'ABSPATH', '/' ); define( 'AQ_DIR', dirname( __DIR__ ) );
function wp_strip_all_tags( $s ) { return strip_tags( $s ); }
require AQ_DIR . '/src/ShareCard.php';
use AQ\ShareCard;
$fail = 0; $ok = function ( $c, $m ) use ( &$fail ) { echo ( $c ? 'PASS  ' : 'FAIL  ' ) . $m . "\n"; if ( ! $c ) { $fail++; } };
$ok( ShareCard::clean( "Hi [there](https://x.y) **bold** 👀\n\nok" ) === 'Hi there bold ok', 'clean: links → labels, markup and emoji gone, folded' );
if ( ! function_exists( 'imagettftext' ) ) { echo "SKIP  rendering (no GD/FreeType)\n"; exit( $fail ? 1 : 0 ); }
$f = AQ_DIR . '/assets/fonts/Inter-Bold.ttf';
$l = ShareCard::wrap( str_repeat( 'word ', 200 ), 40, $f, 600, 3 );
$ok( 3 === count( $l ) && '…' === mb_substr( end( $l ), -1 ), 'wrap: capped lines end in an ellipsis' );
$d = [ 'id' => 9, 'text' => 'A short post', 'name' => 'Arta', 'handle' => 'artabot', 'photo' => '' ];
foreach ( ShareCard::FORMATS as $fmt => [ $w, $h ] ) {
	$png = ShareCard::render( $d, $fmt );
	$sz  = getimagesizefromstring( $png );
	$ok( $sz && $sz[0] === $w && $sz[1] === $h && 'image/png' === $sz['mime'], "render $fmt: {$w}×{$h} PNG" );
}
echo $fail ? "✗ $fail FAILED\n" : "✓ ALL PASS\n"; exit( $fail ? 1 : 0 );
