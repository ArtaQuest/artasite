<?php
// php wp-content/plugins/aquest/tools/test-alumni-refollow.php — AlumniSearch::refollow_needed (1.25.31), no WordPress needed.
namespace AQ;
define( 'ABSPATH', __DIR__ );
if ( ! defined( 'DAY_IN_SECONDS' ) ) { define( 'DAY_IN_SECONDS', 86400 ); }
function wp_json_encode( $v ) { return json_encode( $v ); }
require __DIR__ . '/../src/AlumniSearch.php';
$ok = 0; $n = 0;
$t = function ( $name, $c ) use ( &$ok, &$n ) { $n++; $ok += $c ? 1 : 0; echo ( $c ? 'PASS ' : 'FAIL ' ) . $name . "\n"; };
$j = function ( $a ) { return json_encode( (object) $a ); };
$li = [ 'linkedin' => [ 'url' => 'https://www.linkedin.com/in/x/' ] ];
$t( 'new bluesky -> refollow', AlumniSearch::refollow_needed( $j( $li ), $j( $li + [ 'bluesky' => [ 'url' => 'https://bsky.app/profile/a.bsky.social' ] ] ) ) );
$t( 'new strava -> refollow', AlumniSearch::refollow_needed( $j( $li ), $j( $li + [ 'strava' => [ 'url' => 'https://www.strava.com/athletes/1' ] ] ) ) );
$t( 'same bluesky (slash/www) -> no', ! AlumniSearch::refollow_needed( $j( [ 'bluesky' => [ 'url' => 'https://bsky.app/profile/a.bsky.social/' ] ] ), $j( [ 'bluesky' => [ 'url' => 'https://bsky.app/profile/a.bsky.social' ] ] ) ) );
$t( 'changed strava -> refollow', AlumniSearch::refollow_needed( $j( [ 'strava' => [ 'url' => 'https://www.strava.com/athletes/1' ] ] ), $j( [ 'strava' => [ 'url' => 'https://www.strava.com/athletes/2' ] ] ) ) );
$t( 'new spotify -> refollow', AlumniSearch::refollow_needed( $j( $li ), $j( $li + [ 'spotify' => [ 'url' => 'https://open.spotify.com/user/a' ] ] ) ) );
$t( 'new tiktok -> refollow', AlumniSearch::refollow_needed( $j( $li ), $j( $li + [ 'tiktok' => [ 'url' => 'https://www.tiktok.com/@a' ] ] ) ) );
$t( 'same spotify (slash/www) -> no', ! AlumniSearch::refollow_needed( $j( [ 'spotify' => [ 'url' => 'https://open.spotify.com/user/a/' ] ] ), $j( [ 'spotify' => [ 'url' => 'https://open.spotify.com/user/a' ] ] ) ) );
$t( 'new linkedin/x only -> no', ! AlumniSearch::refollow_needed( $j( [] ), $j( $li + [ 'x' => [ 'url' => 'https://x.com/a' ] ] ) ) );
$t( 'bluesky removed -> no', ! AlumniSearch::refollow_needed( $j( [ 'bluesky' => [ 'url' => 'https://bsky.app/profile/a' ] ] ), $j( $li ) ) );
$t( 'garbage old json -> new bluesky refollows', AlumniSearch::refollow_needed( 'null', $j( [ 'bluesky' => [ 'url' => 'https://bsky.app/profile/a' ] ] ) ) );
echo "$ok/$n passed\n"; exit( $ok === $n ? 0 : 1 );
