<?php
// php wp-content/plugins/aquest/tools/test-alumni-pf-follows.php — merge_pf_follows + refollow_platforms, no WordPress needed.
namespace AQ;
define( 'ABSPATH', __DIR__ );
if ( ! defined( 'DAY_IN_SECONDS' ) ) { define( 'DAY_IN_SECONDS', 86400 ); }
function wp_json_encode( $v ) { return json_encode( $v ); }
require __DIR__ . '/../src/AlumniSearch.php';
$ok = 0; $n = 0;
$t = function ( $name, $c ) use ( &$ok, &$n ) { $n++; $ok += $c ? 1 : 0; echo ( $c ? 'PASS ' : 'FAIL ' ) . $name . "\n"; };
$j = function ( $a ) { return json_encode( (object) $a ); };

$m = AlumniSearch::merge_pf_follows(
	[ 1 => '2026-10-01 10:00:00', 2 => '2026-10-02 10:00:00' ],
	[ 1 => '2026-10-30 12:00:00', 3 => '2026-11-01 08:00:00' ],
	[ 1 => [ 'linkedin', 'instagram', 'github' ], 2 => [ 'x' ], 3 => [ 'linkedin' ] ],
	[]
);
$t( 'shared maps onto instagram+github', ( $m[1]['instagram'] ?? '' ) === '2026-10-01 10:00:00' && ( $m[1]['github'] ?? '' ) === '2026-10-01 10:00:00' );
$t( 'linkedin from li map on person 1', ( $m[1]['linkedin'] ?? '' ) === '2026-10-30 12:00:00' );
$t( 'shared maps onto x for person 2', ( $m[2]['x'] ?? '' ) === '2026-10-02 10:00:00' && ! isset( $m[2]['linkedin'] ) );
$t( 'li-only person 3', ( $m[3]['linkedin'] ?? '' ) === '2026-11-01 08:00:00' && count( $m[3] ) === 1 );

$keep = AlumniSearch::merge_pf_follows(
	[ 1 => '2026-10-01 10:00:00' ],
	[ 1 => '2026-10-30 12:00:00' ],
	[ 1 => [ 'linkedin', 'instagram' ] ],
	[ 1 => [ 'instagram' => '2026-11-18 09:00:00', 'linkedin' => '2026-11-18 09:01:00' ] ]
);
$t( 'existing per-platform timestamps win', $keep[1]['instagram'] === '2026-11-18 09:00:00' && $keep[1]['linkedin'] === '2026-11-18 09:01:00' );

$t( 'refollow_platforms returns only new bluesky', AlumniSearch::refollow_platforms(
	$j( [ 'linkedin' => [ 'url' => 'https://www.linkedin.com/in/x/' ], 'instagram' => [ 'url' => 'https://instagram.com/x' ] ] ),
	$j( [ 'linkedin' => [ 'url' => 'https://www.linkedin.com/in/x/' ], 'instagram' => [ 'url' => 'https://instagram.com/x' ], 'bluesky' => [ 'url' => 'https://bsky.app/profile/a' ] ] )
) === [ 'bluesky' ] );
$t( 'refollow_needed still true for new bluesky', AlumniSearch::refollow_needed(
	$j( [ 'linkedin' => [ 'url' => 'https://www.linkedin.com/in/x/' ] ] ),
	$j( [ 'linkedin' => [ 'url' => 'https://www.linkedin.com/in/x/' ], 'bluesky' => [ 'url' => 'https://bsky.app/profile/a' ] ] )
) );
$t( 'changed strava only, not untouched tiktok', AlumniSearch::refollow_platforms(
	$j( [ 'strava' => [ 'url' => 'https://www.strava.com/athletes/1' ], 'tiktok' => [ 'url' => 'https://www.tiktok.com/@a' ] ] ),
	$j( [ 'strava' => [ 'url' => 'https://www.strava.com/athletes/2' ], 'tiktok' => [ 'url' => 'https://www.tiktok.com/@a' ] ] )
) === [ 'strava' ] );

echo "$ok/$n passed\n"; exit( $ok === $n ? 0 : 1 );
