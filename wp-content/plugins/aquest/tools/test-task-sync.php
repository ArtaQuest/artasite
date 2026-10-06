<?php
/**
 * Crypto + allow-list harness for ArtaTask phone sync (src/TaskSync.php).
 *
 * No WordPress, no database, no network. Proves the envelope round-trips, that the
 * plaintext is not recoverable from the stored bytes without the key, that a
 * dedicated AQ_TASK_SYNC_KEY does not strand rows sealed with the wp-config salts,
 * and that requestStatus / LinkedIn / Facebook names are not blobs.
 *
 * Run: php wp-content/plugins/aquest/tools/test-task-sync.php
 * Prints PASS/FAIL per assertion and exits non-zero on any failure.
 */
namespace {
	if ( defined( 'ABSPATH' ) ) { return; }
	define( 'ABSPATH', __DIR__ );
	define( 'AUTH_KEY', str_repeat( 'K', 64 ) );
	define( 'AUTH_SALT', str_repeat( 'S', 64 ) );
	$GLOBALS['aq_task_sync_test_secrets'] = [];
}

namespace AQ {

final class Secrets {
	public static function get( $name, $default = '' ) {
		$bag = $GLOBALS['aq_task_sync_test_secrets'] ?? [];
		return array_key_exists( $name, $bag ) ? (string) $bag[ $name ] : $default;
	}
}

require __DIR__ . '/../src/TaskSync.php';

$fail = 0;
$ok   = function ( $cond, $label, $detail = '' ) use ( &$fail ) {
	if ( $cond ) { echo "PASS  $label\n"; return; }
	$fail++;
	echo "FAIL  $label" . ( $detail !== '' ? " — $detail" : '' ) . "\n";
};

$ok( TaskSync::available(), 'libsodium + wp-config salts can seal' );

$marker = 'PLAINTEXT-MARKER-strava-follower-9f3c1a7e';
$plain  = '{"followers":[{"id":1,"name":"' . $marker . '"}]}';
$a = TaskSync::seal( $plain );
$b = TaskSync::seal( $plain );
$ok( $a !== '' && $b !== '' && $a !== $b, 'two seals of the same plaintext differ (fresh nonce)' );
$ok( TaskSync::open( $a ) === $plain, 'open returns the plaintext' );
$raw = base64_decode( $a, true );
$ok( is_string( $raw ) && $raw !== '' && $raw[0] === "\x01", 'unset AQ_TASK_SYNC_KEY seals version 0x01' );
$ok( strpos( $a, $marker ) === false && strpos( (string) $raw, $marker ) === false, 'plaintext marker is absent from the envelope' );

$tampered = $raw;
$tampered[ strlen( $tampered ) - 1 ] = $tampered[ strlen( $tampered ) - 1 ] === 'A' ? 'B' : 'A';
$ok( TaskSync::open( base64_encode( $tampered ) ) === null, 'flipping a ciphertext byte does not open' );
$ok( TaskSync::open( '' ) === null && TaskSync::open( '!!!!' ) === null, 'empty and non-base64 envelopes do not open' );
$ok( TaskSync::open( base64_encode( "\x09" . substr( $raw, 1 ) ) ) === null, 'unknown version byte does not open' );

$v1 = $a;
$GLOBALS['aq_task_sync_test_secrets']['AQ_TASK_SYNC_KEY'] = str_repeat( 'dedicated-sync-key-', 4 );
$ok( TaskSync::open( $v1 ) === $plain, 'setting AQ_TASK_SYNC_KEY still opens a version 0x01 row' );
$v2 = TaskSync::seal( $plain );
$v2raw = base64_decode( $v2, true );
$ok( is_string( $v2raw ) && $v2raw !== '' && $v2raw[0] === "\x02", 'dedicated key seals version 0x02' );
$ok( TaskSync::open( $v2 ) === $plain, 'version 0x02 opens with the dedicated key' );
unset( $GLOBALS['aq_task_sync_test_secrets']['AQ_TASK_SYNC_KEY'] );
$ok( TaskSync::open( $v2 ) === null, 'dropping AQ_TASK_SYNC_KEY makes version 0x02 unreadable' );
$ok( TaskSync::open( $v1 ) === $plain, 'version 0x01 still opens after the dedicated key is removed' );

foreach ( [
	'strava_followers.json', 'strava_followers', 'STRAVA_FOLLOWERS.JSON',
	'strava_following.json', 'mutual_connections.json', 'session_claim.json', 'prefs.json', 'prefs',
] as $name ) {
	$got = TaskSync::canonical_name( $name );
	$ok( $got !== '' && in_array( $got, TaskSync::NAMES, true ), "allowed name: $name", $got );
}
$ok( TaskSync::canonical_name( '../prefs.json' ) === 'prefs.json', 'a path is reduced to the filename' );
foreach ( [
	'requestStatus', 'requestStatus.json', 'request_status', 'requeststatus',
	'linkedin', 'facebook', 'linkedin_request.json', 'facebook_request_check',
	'strava_followers.json.json', 'prefs.json.bak', '',
] as $name ) {
	$ok( TaskSync::canonical_name( $name ) === '', 'rejected name: ' . var_export( $name, true ) );
}
$ok( TaskSync::canonical_name( 'strava_followers.json' ) === 'strava_followers.json', 'canonical filename keeps .json' );

$ok( ( TaskSync::parse_blob( '{}' )['body'] ?? '' ) === '{}', 'empty object is a blob and stays {}' );
$ok( ( TaskSync::parse_blob( "[]\n" )['body'] ?? '' ) === "[]\n", 'array blob keeps the original bytes' );
$ok( ( TaskSync::parse_blob( $plain )['body'] ?? '' ) === $plain, 'object blob kept verbatim' );
foreach ( [ '', '   ', '1', '"x"', 'null', 'true', '{"a":1', '[1,2', 'not json', '{"a":1} trailing', '{"a":1}{"b":2}' ] as $bad ) {
	$err = TaskSync::parse_blob( $bad )['error'] ?? '';
	$ok( $err === 'bad_body', 'rejected body ' . var_export( $bad, true ), $err );
}
$huge = '{' . str_repeat( '"k":1,', (int) ( TaskSync::MAX_BYTES / 6 ) ) . '"z":1}';
$ok( strlen( $huge ) > TaskSync::MAX_BYTES, 'fixture exceeds the cap', (string) strlen( $huge ) );
$ok( ( TaskSync::parse_blob( $huge )['error'] ?? '' ) === 'too_large', 'over 8 MiB is too_large' );

$src = file_get_contents( __DIR__ . '/../src/TaskSync.php' );
$ok( is_string( $src ) && strpos( $src, 'api.cloudflare.com' ) === false && strpos( $src, 'KVNamespace' ) === false, 'TaskSync.php has no Cloudflare KV client' );

echo $fail === 0 ? "AQ_TASK_SYNC_TEST=GREEN\n" : "AQ_TASK_SYNC_TEST=RED ($fail)\n";
exit( $fail === 0 ? 0 : 1 );

}
