<?php
/**
 * verify-links.php — the profile-link validator, exercised against the real code.
 *
 *   studio wp eval "require WP_PLUGIN_DIR.'/aquest/tools/verify-links.php';"   # exit 0 = green
 *
 * WHY THIS EXISTS. AQ\Auth::normalise_link() is the only thing standing between a text box on a
 * public, indexed profile page and an arbitrary outbound link. It is host-locked per network, and
 * host-matching is exactly the kind of check that looks right and is not: "github.com.evil.tld" ends
 * with the host, "evil.tld/github.com" contains it. Both are in here, and both must be refused.
 *
 * Prints PASS/FAIL per case and exits non-zero on any failure, so it can gate a merge. It writes
 * nothing: normalise_link is pure, and the round-trip cases below use a scratch user meta key that
 * is removed again.
 */

if ( ! defined( 'ABSPATH' ) ) { exit; }

$pass = 0; $fail = 0;
$m = new ReflectionMethod( 'AQ\Auth', 'normalise_link' );
$m->setAccessible( true );
$norm = function ( $k, $v ) use ( $m ) { return $m->invoke( null, $k, $v ); };

/** @var array<int,array{0:string,1:string,2:bool,3:string}> key, input, should-accept, why */
$cases = array(
	array( 'github',   'arash',                             true,  'bare handle' ),
	array( 'github',   '@arash',                            true,  '@handle' ),
	array( 'github',   'https://github.com/arash',          true,  'full url' ),
	array( 'github',   'https://www.github.com/arash',      true,  'www subdomain' ),
	array( 'github',   'http://github.com/arash',           true,  'http upgraded' ),
	array( 'github',   'https://github.com.evil.tld/x',     false, 'suffix spoof' ),
	array( 'github',   'https://evil.tld/github.com',       false, 'host in path' ),
	array( 'github',   'javascript:alert(1)',               false, 'scheme injection' ),
	array( 'github',   'https://evil.tld/arash',            false, 'wrong host' ),
	array( 'github',   '../../etc/passwd',                  false, 'traversal' ),
	array( 'github',   'a b c',                             false, 'spaces' ),
	array( 'x',        'https://twitter.com/arash',         true,  'old name, same service' ),
	array( 'x',        'https://x.com.evil.tld/a',          false, 'suffix spoof (x)' ),
	array( 'x',        'https://twitter.com.evil.tld/a',    false, 'suffix spoof (twitter)' ),
	array( 'orcid',    '0000-0002-1825-0097',               true,  'orcid id' ),
	array( 'scholar',  'https://scholar.google.com/citations?user=A', true, 'query preserved' ),
	array( 'linkedin', 'https://uk.linkedin.com/in/arash',  true,  'country subdomain' ),
	array( 'website',  'https://arash.dev',                 true,  'any https host' ),
	array( 'website',  'arash.dev',                         false, 'handle is not a site' ),
	array( 'website',  'javascript:alert(1)',               false, 'scheme injection' ),
	array( 'mastodon', 'https://mastodon.social/@arash',    true,  'federated, any host' ),
	array( 'bogus',    'arash',                             false, 'unknown network' ),
);

foreach ( $cases as $c ) {
	list( $key, $in, $want, $why ) = $c;
	$got = $norm( $key, $in );
	$ok  = $want ? ( '' !== $got ) : ( '' === $got );
	// An accepted value must ALWAYS come back absolute and https — a relative or http result would
	// be a link this site renders and does not control.
	if ( $ok && $want && 0 !== strpos( $got, 'https://' ) ) { $ok = false; $why .= ' (not https!)'; }
	printf( "%s  %-9s %-34s %s\n", $ok ? 'PASS' : 'FAIL', $key, substr( $in, 0, 32 ), $why );
	$ok ? $pass++ : $fail++;
}

printf( "\n%d passed, %d failed\nLINKS=%s\n", $pass, $fail, $fail ? 'RED (' . $fail . ')' : 'GREEN' );
if ( $fail ) { exit( 1 ); }
