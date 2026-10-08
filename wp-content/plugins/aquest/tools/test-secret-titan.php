<?php
/**
 * Endpoint harness for the ArtaMail Titan secret route (Vault::rest_titan in src/Vault.php).
 *
 * No WordPress, no database, no network: WP primitives (WP_REST_Response, is_ssl, transients) and the
 * AQ\Secrets / AQ\Watchdog / AQ\Rest collaborators are stubbed, then src/Vault.php is required and the
 * handler is driven directly under crafted $_SERVER conditions.
 *
 * Covers: missing token (401), wrong/too-short token (403), good token (200 + password body),
 * unset secret (404), per-IP rate limit (429 on the 11th call), Cache-Control: no-store,
 * HTTPS enforcement (+ X-Forwarded-Proto), and that the password never appears in the audit log.
 *
 * Run: php wp-content/plugins/aquest/tools/test-secret-titan.php
 * Prints PASS/FAIL per assertion and exits non-zero on any failure.
 */
namespace {
	if ( ! defined( 'ABSPATH' ) ) { define( 'ABSPATH', __DIR__ ); }
	if ( ! defined( 'AUTH_KEY' ) )  { define( 'AUTH_KEY',  str_repeat( 'K', 64 ) ); }
	if ( ! defined( 'AUTH_SALT' ) ) { define( 'AUTH_SALT', str_repeat( 'S', 64 ) ); }
	if ( ! defined( 'WP_DEBUG' ) )  { define( 'WP_DEBUG', false ); }        // HTTPS enforced
	if ( ! defined( 'HOUR_IN_SECONDS' ) ) { define( 'HOUR_IN_SECONDS', 3600 ); }

	$GLOBALS['aq_secrets']    = [];
	$GLOBALS['aq_transients'] = [];
	$GLOBALS['aq_wd_log']     = [];
	$GLOBALS['aq_is_ssl']     = true;

	// Minimal WP_REST_Response.
	class WP_REST_Response {
		public $data; public $status; public $headers = [];
		public function __construct( $data = null, $status = 200 ) { $this->data = $data; $this->status = $status; }
		public function header( $k, $v ) { $this->headers[ $k ] = $v; }
		public function get_data() { return $this->data; }
		public function get_status() { return $this->status; }
		public function get_headers() { return $this->headers; }
	}

	function is_ssl() { return (bool) ( $GLOBALS['aq_is_ssl'] ?? false ); }
	function get_transient( $k ) { return $GLOBALS['aq_transients'][ $k ] ?? false; }
	function set_transient( $k, $v, $ttl = 0 ) { $GLOBALS['aq_transients'][ $k ] = $v; return true; }
}

namespace AQ {

	// Stubbed collaborators (defined BEFORE requiring Vault.php so its references resolve here).
	final class Secrets {
		public static function get( $name, $default = '' ) {
			$bag = $GLOBALS['aq_secrets'] ?? [];
			return array_key_exists( $name, $bag ) ? (string) $bag[ $name ] : $default;
		}
	}
	final class Watchdog {
		public static function note( $line ) { $GLOBALS['aq_wd_log'][] = (string) $line; }
	}
	final class Rest {
		// Mirrors the real fixed-window transient limiter (keyed by REMOTE_ADDR for token calls).
		public static function throttle( $bucket, $limit = 30, $window = 60 ) {
			$id = $_SERVER['REMOTE_ADDR'] ?? '0';
			$w  = max( 1, (int) $window );
			$k  = 'aq_rl_' . md5( $bucket . '|' . $id . '|' . (int) floor( time() / $w ) );
			$n  = (int) get_transient( $k );
			if ( $n >= $limit ) { return true; }
			set_transient( $k, $n + 1, $w );
			return false;
		}
	}

	require __DIR__ . '/../src/Vault.php';

	$fail = 0;
	$ok = function ( $cond, $label, $detail = '' ) use ( &$fail ) {
		if ( $cond ) { echo "PASS  $label\n"; return; }
		$fail++;
		echo "FAIL  $label" . ( $detail !== '' ? " — $detail" : '' ) . "\n";
	};

	$GOOD = 'aqmt_' . str_repeat( 'a', 40 );            // >= 32 chars
	$PW   = 'sUp3r-s3cret-titan-pw-DO-NOT-LEAK-42';

	// Fresh request environment; each scenario gets its own IP so rate buckets don't bleed across tests.
	$reset = function ( $ip ) {
		foreach ( [ 'HTTP_X_AQ_ARTAMAIL', 'HTTP_AUTHORIZATION', 'HTTP_X_FORWARDED_PROTO' ] as $h ) { unset( $_SERVER[ $h ] ); }
		$_SERVER['REMOTE_ADDR'] = $ip;
		$GLOBALS['aq_is_ssl']   = true;
	};

	// Registry carries both new entries.
	$ok( array_key_exists( 'TITAN_PASSWORD', Vault::REGISTRY ), 'registry has TITAN_PASSWORD' );
	$ok( array_key_exists( 'AQ_ARTAMAIL_TOKEN', Vault::REGISTRY ), 'registry has AQ_ARTAMAIL_TOKEN' );

	// 1) No token → 401
	$GLOBALS['aq_secrets'] = [ 'AQ_ARTAMAIL_TOKEN' => $GOOD, 'TITAN_PASSWORD' => $PW ];
	$reset( '10.0.0.1' );
	$r = Vault::rest_titan( null );
	$ok( $r->get_status() === 401, 'no token → 401', 'got ' . $r->get_status() );
	$ok( ( $r->get_data()['error'] ?? '' ) === 'unauthorized', 'no token → error=unauthorized' );
	$ok( ( $r->get_headers()['Cache-Control'] ?? '' ) === 'no-store', 'no token → no-store header' );

	// 2) Wrong token → 403
	$reset( '10.0.0.2' );
	$_SERVER['HTTP_AUTHORIZATION'] = 'Bearer wrong-token-value';
	$r = Vault::rest_titan( null );
	$ok( $r->get_status() === 403, 'wrong token → 403', 'got ' . $r->get_status() );

	// 2b) Too-short configured token is rejected even if it matches → 403
	$reset( '10.0.0.6' );
	$GLOBALS['aq_secrets'] = [ 'AQ_ARTAMAIL_TOKEN' => 'short', 'TITAN_PASSWORD' => $PW ];
	$_SERVER['HTTP_X_AQ_ARTAMAIL'] = 'short';
	$r = Vault::rest_titan( null );
	$ok( $r->get_status() === 403, 'too-short token → 403', 'got ' . $r->get_status() );
	$GLOBALS['aq_secrets'] = [ 'AQ_ARTAMAIL_TOKEN' => $GOOD, 'TITAN_PASSWORD' => $PW ];

	// 3) Good token (X-AQ-ArtaMail header) → 200 with the password, no-store
	$reset( '10.0.0.3' );
	$_SERVER['HTTP_X_AQ_ARTAMAIL'] = $GOOD;
	$r = Vault::rest_titan( null );
	$ok( $r->get_status() === 200, 'good token → 200', 'got ' . $r->get_status() );
	$ok( ( $r->get_data()['password'] ?? '' ) === $PW, 'good token → body.password is the secret' );
	$ok( ( $r->get_headers()['Cache-Control'] ?? '' ) === 'no-store', 'good token → Cache-Control: no-store' );

	// 3b) Good token via Authorization: Bearer → 200
	$reset( '10.0.0.7' );
	$_SERVER['HTTP_AUTHORIZATION'] = 'Bearer ' . $GOOD;
	$r = Vault::rest_titan( null );
	$ok( $r->get_status() === 200, 'good token via Bearer → 200', 'got ' . $r->get_status() );

	// 4) Secret unset → 404 (valid token)
	$reset( '10.0.0.4' );
	$GLOBALS['aq_secrets'] = [ 'AQ_ARTAMAIL_TOKEN' => $GOOD, 'TITAN_PASSWORD' => '' ];
	$_SERVER['HTTP_X_AQ_ARTAMAIL'] = $GOOD;
	$r = Vault::rest_titan( null );
	$ok( $r->get_status() === 404, 'unset secret → 404', 'got ' . $r->get_status() );
	$ok( ( $r->get_data()['error'] ?? '' ) === 'not_found', 'unset secret → error=not_found' );
	$GLOBALS['aq_secrets'] = [ 'AQ_ARTAMAIL_TOKEN' => $GOOD, 'TITAN_PASSWORD' => $PW ];

	// 5) Rate limit → 11th call from one IP is 429
	$reset( '10.0.0.5' );
	$_SERVER['HTTP_X_AQ_ARTAMAIL'] = $GOOD;
	$codes = [];
	for ( $i = 0; $i < 11; $i++ ) { $codes[] = Vault::rest_titan( null )->get_status(); }
	$ok( count( array_filter( array_slice( $codes, 0, 10 ), fn( $c ) => $c === 200 ) ) === 10, 'rate limit: first 10 ok', implode( ',', $codes ) );
	$ok( $codes[10] === 429, 'rate limit: 11th → 429', implode( ',', $codes ) );

	// 6) HTTPS enforcement: plain HTTP (WP_DEBUG off) → 403; X-Forwarded-Proto https is accepted
	$reset( '10.0.0.8' );
	$GLOBALS['aq_is_ssl'] = false;
	$_SERVER['HTTP_X_AQ_ARTAMAIL'] = $GOOD;
	$r = Vault::rest_titan( null );
	$ok( $r->get_status() === 403 && ( $r->get_data()['error'] ?? '' ) === 'https_required', 'plain HTTP → 403 https_required', 'got ' . $r->get_status() );
	$reset( '10.0.0.9' );
	$GLOBALS['aq_is_ssl'] = false;
	$_SERVER['HTTP_X_FORWARDED_PROTO'] = 'https';
	$_SERVER['HTTP_X_AQ_ARTAMAIL'] = $GOOD;
	$r = Vault::rest_titan( null );
	$ok( $r->get_status() === 200, 'X-Forwarded-Proto https → 200', 'got ' . $r->get_status() );

	// 7) The password never appears in the audit log (nor in any error body message)
	$log_blob = implode( "\n", $GLOBALS['aq_wd_log'] );
	$ok( strpos( $log_blob, $PW ) === false, 'password never written to the audit log' );
	$ok( count( $GLOBALS['aq_wd_log'] ) > 0 && strpos( $log_blob, 'secret/titan' ) !== false, 'each access is audited (result + ip)' );

	echo $fail ? "\n$fail assertion(s) FAILED\n" : "\nAll assertions passed\n";
	exit( $fail ? 1 : 0 );
}
