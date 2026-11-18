<?php
// php wp-content/plugins/aquest/tools/test-alumni-generic-followers.php — 1.25.33 generic platforms + counts, no WordPress needed.
namespace AQ;
define( 'ABSPATH', __DIR__ );
if ( ! defined( 'DAY_IN_SECONDS' ) ) { define( 'DAY_IN_SECONDS', 86400 ); }
function wp_json_encode( $v ) { return json_encode( $v ); }
function esc_url_raw( $u, $p = null ) {
	$u = trim( (string) $u );
	return preg_match( '#^https://#i', $u ) ? $u : '';
}
function wp_parse_url( $u, $c = -1 ) {
	$x = parse_url( $u );
	if ( $c === PHP_URL_HOST ) { return $x['host'] ?? ''; }
	return $x;
}
function sanitize_key( $s ) { return strtolower( preg_replace( '/[^a-z0-9_\-]/', '', (string) $s ) ); }
function sanitize_text_field( $s ) { return (string) $s; }
function sanitize_email( $s ) { return (string) $s; }
require __DIR__ . '/../src/AlumniSearch.php';
$ok = 0; $n = 0;
$t = function ( $name, $c ) use ( &$ok, &$n ) { $n++; $ok += $c ? 1 : 0; echo ( $c ? 'PASS ' : 'FAIL ' ) . $name . "\n"; };

$t( 'known host accepted', AlumniSearch::clean_url( 'tiktok', 'https://www.tiktok.com/@a' ) === 'https://www.tiktok.com/@a' );
$t( 'known host rejected off-domain', AlumniSearch::clean_url( 'tiktok', 'https://evil.example/@a' ) === '' );
$t( 'generic platform any https host', AlumniSearch::clean_url( 'letterboxd', 'https://letterboxd.com/foo' ) === 'https://letterboxd.com/foo' );
$t( 'http rejected', AlumniSearch::clean_url( 'github', 'http://github.com/a' ) === '' );
$t( 'no host rejected', AlumniSearch::clean_url( 'custom', 'https://localhost' ) === '' || AlumniSearch::clean_url( 'custom', 'https://nohost' ) === '' );

$t( 'count int', AlumniSearch::count_or_null( 12 ) === 12 );
$t( 'count zero kept', AlumniSearch::count_or_null( 0 ) === 0 );
$t( 'count blank', AlumniSearch::count_or_null( null ) === null && AlumniSearch::count_or_null( '' ) === null );
$t( 'count junk blank', AlumniSearch::count_or_null( 'many' ) === null && AlumniSearch::count_or_null( 1.5 ) === null );

$p = [
	'instagram' => [ 'url' => 'https://instagram.com/a', 'followers' => 100, 'following' => 50 ],
	'github'    => [ 'url' => 'https://github.com/a', 'followers' => 20, 'following' => 10 ],
	'x'         => [ 'url' => 'https://x.com/a' ],
];
$c = AlumniSearch::tally_counts( $p );
$t( 'total followers sums known only', $c['followers_total'] === 120 );
$t( 'max followers', $c['followers_max'] === 100 );
$t( 'total following', $c['following_total'] === 60 );
$t( 'ratio 60/120', abs( $c['follow_ratio'] - 0.5 ) < 1e-9 && $c['follow_ratio_inf'] === 0 );

$z = AlumniSearch::tally_counts( [ 'x' => [ 'followers' => 0, 'following' => 40 ] ] );
$t( 'zero followers flagged inf', $z['follow_ratio_inf'] === 1 && $z['follow_ratio'] === null && $z['followers_total'] === 0 );

$b = AlumniSearch::tally_counts( [ 'x' => [ 'url' => 'https://x.com/a' ] ] );
$t( 'all blank sorts last (null ratio, not inf)', $b['followers_total'] === null && $b['follow_ratio'] === null && $b['follow_ratio_inf'] === 0 );

$t( 'linkedin connections are not followers', AlumniSearch::tally_counts( [ 'linkedin' => [ 'connections' => 500 ] ] )['followers_total'] === null );

echo "$ok/$n passed\n";
exit( $ok === $n ? 0 : 1 );
