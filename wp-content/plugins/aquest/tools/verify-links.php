<?php
/**
 * verify-links.php — the profile-link validator, exercised against the real code.
 *
 *   studio wp eval "require WP_PLUGIN_DIR.'/aquest/tools/verify-links.php';"   # exit 0 = green
 *
 * WHY THIS EXISTS. AQ\Auth::normalise_link() (normalise_social() then social_url()) is the only thing standing between a text box on a
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
	// The 2026-10-08 networks. Each bare handle must fit that network's own rule.
	array( 'instagram',  'artafather',                      true,  'instagram handle' ),
	array( 'instagram',  'https://www.instagram.com/artafather/', true, 'instagram url' ),
	array( 'instagram',  'https://instagram.com.evil.tld/a', false, 'suffix spoof (instagram)' ),
	array( 'facebook',   '100004123456789',                 true,  'facebook numeric id' ),
	array( 'threads',    'https://www.threads.net/@artafather', true, 'threads old host' ),
	array( 'bluesky',    'artafather',                      true,  'bluesky bare → .bsky.social' ),
	array( 'bluesky',    'artafather.bsky.social',          true,  'bluesky full handle' ),
	array( 'bluesky',    'https://bsky.app/profile/arash.dev', true, 'bluesky custom domain url' ),
	array( 'tiktok',     '@artafather',                     true,  'tiktok @handle' ),
	array( 'reddit',     'u/artafather',                    true,  'reddit u/ prefix' ),
	array( 'snapchat',   'artafather',                      true,  'snapchat' ),
	array( 'quora',      'Arash-Ashrafnejad',               true,  'quora slug' ),
	array( 'youtube',    'UCabcdefghijklmnopqrstuv',        true,  'youtube channel id' ),
	array( 'youtube',    'https://www.youtube.com/@artafather', true, 'youtube url' ),
	array( 'vk',         'artafather',                      true,  'vk' ),
	array( 'x',          'this_is_far_too_long_for_x',      false, 'x max 15' ),
	array( 'telegram',   'abc',                             false, 'telegram min 5' ),
	array( 'twitch',     'artafather',                      true,  'twitch' ),
	array( 'strava',     '7174722',                         true,  'strava numeric' ),
	array( 'letterboxd', 'artafather',                      true,  'letterboxd' ),
	array( 'goodreads',  '12345678',                        true,  'goodreads numeric' ),
	array( 'soundcloud', 'artafather',                      true,  'soundcloud' ),
	array( 'spotify',    'artafather',                      true,  'spotify user' ),
	array( 'kaggle',     'artafather',                      true,  'kaggle' ),
	array( 'huggingface','artafather',                      true,  'hugging face' ),
	array( 'medium',     '@artafather',                     true,  'medium' ),
	array( 'tumblr',     'artafather',                      true,  'tumblr' ),
	array( 'rumble',     'artafather',                      true,  'rumble' ),
	array( 'mastodon',   'artafather@mastodon.social',      true,  'mastodon user@instance' ),
	array( 'mastodon',   '@artafather@fosstodon.org',       true,  'mastodon @user@instance' ),
	array( 'mastodon',   'artafather',                      false, 'mastodon needs an instance' ),
	array( 'bilibili',   '12345',                           true,  'bilibili uid' ),
	array( 'bilibili',   'artafather',                      true,  'bilibili nickname → search' ),
	array( 'bilibili',   'https://evil.bilibili.com.x/1',   false, 'bilibili spoof' ),
	array( 'weibo',      'artafather',                      true,  'weibo nickname' ),
	array( 'weibo',      '1234567890',                      true,  'weibo uid' ),
	array( 'discord',    '123456789012345678',              true,  'discord numeric id has a url' ),
	array( 'github',     '<script>',                        false, 'markup' ),
	array( 'linkedin',   'javascript:alert(1)',             false, 'scheme injection (linkedin)' ),
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

// ID-only networks: accepted and STORED, but with no address to render — the profile offers them to
// copy. normalise_social() must keep the ID; social_url() must give nothing.
$ns = new ReflectionMethod( 'AQ\Auth', 'normalise_social' );
$ns->setAccessible( true );
foreach ( array(
	array( 'wechat',  'artafather',               'artafather' ),
	array( 'discord', 'artafather',               'artafather' ),
	array( 'wechat',  'https://weixin.qq.com/x',  '' ),
	array( 'discord', 'https://discord.com/x',    '' ),
	array( 'bluesky', 'ArtaFather',               'artafather.bsky.social' ),
	array( 'mastodon','artafather@Mastodon.Social','artafather@mastodon.social' ),
	array( 'instagram','https://www.instagram.com/artafather/', 'artafather' ),
) as $c ) {
	list( $key, $in, $want ) = $c;
	$got = $ns->invoke( null, $key, $in );
	$ok  = $got === $want && ( 'wechat' !== $key && 'discord' !== $key || '' === AQ\Auth::social_url( $key, $got ) );
	printf( "%s  %-9s %-34s stored as %s\n", $ok ? 'PASS' : 'FAIL', $key, substr( $in, 0, 32 ), var_export( $got, true ) );
	$ok ? $pass++ : $fail++;
}

printf( "\n%d passed, %d failed\nLINKS=%s\n", $pass, $fail, $fail ? 'RED (' . $fail . ')' : 'GREEN' );
if ( $fail ) { exit( 1 ); }
