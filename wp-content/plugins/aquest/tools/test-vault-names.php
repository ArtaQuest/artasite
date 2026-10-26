<?php
/**
 * Secret renames (2026-10-26) — the new names resolve values stored under the old ones, the vault
 * migration moves ciphertext without touching a value, and nothing that used to work stops working.
 *
 * No WordPress: a temp WP_CONTENT_DIR, real src/Vault.php + src/Secrets.php, a stub Watchdog.
 * Run: php wp-content/plugins/aquest/tools/test-vault-names.php — exits non-zero on any failure.
 */
namespace {
	define( 'ABSPATH', __DIR__ );
	define( 'AUTH_KEY', str_repeat( 'K', 64 ) );
	define( 'AUTH_SALT', str_repeat( 'S', 64 ) );
	define( 'DAY_IN_SECONDS', 86400 );
	define( 'WP_CONTENT_DIR', sys_get_temp_dir() . '/aq-vault-test-' . getmypid() );
	@mkdir( WP_CONTENT_DIR );
	define( 'AQ_TURN_PASS', 'legacy-constant-value' ); // an OLD-name wp-config constant must still resolve
	function wp_json_encode( $v, $f = 0 ) { return json_encode( $v, $f ); }
}
namespace AQ {
	final class Watchdog {
		public static $log = [];
		public static function accept_vault_change( $why ) { self::$log[] = $why; }
		public static function note( $l ) { self::$log[] = $l; }
	}
	require __DIR__ . '/../src/Vault.php';
	require __DIR__ . '/../src/Secrets.php';

	$fail = 0;
	$ok = function ( $c, $m ) use ( &$fail ) { echo ( $c ? 'PASS ' : 'FAIL ' ) . $m . "\n"; if ( ! $c ) { $fail++; } };

	// Write a vault the way production has it today: OLD names. Encrypt with the real key path.
	$key  = hash( 'sha256', AUTH_KEY . '|' . AUTH_SALT . '|aq-vault-v1', true );
	$seal = function ( $v ) use ( $key ) { $n = random_bytes( SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ); return base64_encode( $n . sodium_crypto_secretbox( $v, $n, $key ) ); };
	$rows = [
		'AQ_R2_KEY'                 => [ 'ct' => $seal( 'r2-access-key-id-value' ), 'tail' => 'alue', 'rotated' => 1754000000, 'compromised' => 0 ],
		'AQ_MEDIA_CDN'              => [ 'ct' => $seal( 'https://cdn.example' ), 'tail' => 'mple', 'rotated' => 1753400000, 'compromised' => 0 ],
		'AQ_TURN_URL_TOOLS_HIGH'    => [ 'ct' => $seal( 'https://tools-high.example/turn' ), 'tail' => 'turn', 'rotated' => 1, 'compromised' => 0 ],
		'TITAN_PASSWORD'            => [ 'ct' => $seal( 'titan-pw' ), 'tail' => '', 'rotated' => 5, 'compromised' => 1 ],
		'HF_TOKEN'                  => [ 'ct' => $seal( 'hf-old' ), 'tail' => '', 'rotated' => 2, 'compromised' => 0 ],
		'STRIPE_SECRET_KEY'         => [ 'ct' => $seal( 'sk-test-value' ), 'tail' => 'alue', 'rotated' => 3, 'compromised' => 0 ],
		'MAIL_SMTP_PASSWORD'        => [ 'ct' => $seal( 'new-smtp' ), 'tail' => '', 'rotated' => 9, 'compromised' => 0 ],
		'SMTP_PASS'                 => [ 'ct' => $seal( 'old-smtp' ), 'tail' => '', 'rotated' => 4, 'compromised' => 0 ],
	];
	file_put_contents( Vault::path(), Vault::GUARD . json_encode( [ 'v' => 1, 'secrets' => $rows ] ) );

	// 1. Before migration: new names read old rows; old names still read too.
	$ok( Secrets::get( 'R2_ACCESS_KEY_ID' ) === 'r2-access-key-id-value', 'new name reads a value stored under the old name' );
	$ok( Secrets::get( 'AQ_R2_KEY' ) === 'r2-access-key-id-value', 'old name still reads it' );
	$ok( Secrets::get( 'ARTA_TOOLS_URL_HIGH' ) === 'https://tools-high.example/turn', 'per-tier prefix alias resolves' );
	$ok( Secrets::get( 'CALLS_TURN_PASSWORD' ) === 'legacy-constant-value', 'old-name wp-config constant resolves under the new name' );
	$ok( Secrets::source( 'CALLS_TURN_PASSWORD' ) === 'wp-config', 'source() reports the constant' );
	$ok( Secrets::get( 'MAIL_SMTP_PASSWORD' ) === 'new-smtp', 'when both names hold a value, the NEW one wins' );
	$ok( Secrets::get( 'STRIPE_SECRET_KEY' ) === 'sk-test-value', 'unrenamed secret unaffected' );
	$ok( Secrets::get( 'NOT_A_SECRET_XYZ', 'd' ) === 'd', 'unset name returns the default' );

	// 2. meta(): grouped, renamed, retired → unused, shadowed old copy → unused, identifiers have no clock.
	$m = Vault::meta();
	$ok( isset( $m['MEDIA_CDN_URL'] ) && $m['MEDIA_CDN_URL']['in_vault'] && $m['MEDIA_CDN_URL']['max_days'] === 0, 'MEDIA_CDN_URL listed, in vault, no rotation' );
	$ok( ! isset( $m['AQ_MEDIA_CDN'] ), 'old name not listed separately' );
	$ok( ( $m['HF_TOKEN']['unused'] ?? '' ) !== '', 'retired HF_TOKEN listed as unused' );
	$ok( ( $m['SMTP_PASS']['unused'] ?? '' ) !== '', 'shadowed old SMTP_PASS listed as unused' );
	$ok( $m['STRIPE_SECRET_KEY']['max_days'] === 90 && $m['CLOUDFLARE_API_TOKEN']['max_days'] === 90, 'critical credentials on 90 days' );
	$ok( $m['CLOUDFLARE_ACCOUNT_ID']['max_days'] === 0 && $m['R2_BUCKET']['max_days'] === 0, 'account ID and bucket have no rotation' );
	$ok( $m['MAIL_TITAN_PASSWORD']['compromised'] === true, 'compromised flag survives the rename' );
	foreach ( Vault::REGISTRY as $n => $spec ) { if ( count( $spec ) !== 4 || ! is_string( $spec[3] ) ) { $ok( false, "registry row $n has a group" ); } }
	foreach ( Vault::ALIASES as $n => $olds ) { if ( ! isset( Vault::REGISTRY[ $n ] ) ) { $ok( false, "alias target $n is registered" ); } }

	// 3. Migration: ciphertext moved, metadata kept, logged, idempotent.
	$before = json_decode( substr( file_get_contents( Vault::path() ), strpos( file_get_contents( Vault::path() ), "\n" ) + 1 ), true )['secrets'];
	$n = Vault::migrate_names();
	$after = json_decode( substr( file_get_contents( Vault::path() ), strpos( file_get_contents( Vault::path() ), "\n" ) + 1 ), true )['secrets'];
	$ok( $n === 4, "migrate moved 4 rows (got $n)" );
	$ok( isset( $after['R2_ACCESS_KEY_ID'] ) && ! isset( $after['AQ_R2_KEY'] ), 'row now under the new name' );
	$ok( $after['R2_ACCESS_KEY_ID'] === $before['AQ_R2_KEY'], 'ciphertext + rotated-at copied byte-for-byte' );
	$ok( isset( $after['ARTA_TOOLS_URL_HIGH'] ), 'tier row migrated' );
	$ok( isset( $after['SMTP_PASS'] ) && $after['MAIL_SMTP_PASSWORD'] === $before['MAIL_SMTP_PASSWORD'], 'shadowed old row left alone, new row untouched' );
	$ok( isset( $after['HF_TOKEN'] ), 'retired row is not deleted' );
	$ok( count( Watchdog::$log ) === 1 && strpos( Watchdog::$log[0], 'AQ_R2_KEY → R2_ACCESS_KEY_ID' ) !== false, 'migration logged once, by name' );
	$log = implode( "\n", Watchdog::$log );
	$ok( strpos( $log, 'r2-access-key' ) === false && strpos( $log, 'titan-pw' ) === false, 'no value in the audit log' );
	$ok( Vault::migrate_names() === 0, 'second run is a no-op' );
	$ok( Secrets::get( 'AQ_R2_KEY' ) === 'r2-access-key-id-value' && Secrets::get( 'TITAN_PASSWORD' ) === 'titan-pw', 'old names still resolve after migration' );

	// 4. set() stores under the new name even when given an old one.
	Vault::set( 'AQ_CF_API_TOKEN', 'cf-token-value-123' );
	$after = json_decode( substr( file_get_contents( Vault::path() ), strpos( file_get_contents( Vault::path() ), "\n" ) + 1 ), true )['secrets'];
	$ok( isset( $after['CLOUDFLARE_API_TOKEN'] ) && ! isset( $after['AQ_CF_API_TOKEN'] ), 'set() with an old name writes the new name' );

	@unlink( Vault::path() ); @rmdir( WP_CONTENT_DIR );
	echo $fail ? "FAILED: $fail\n" : "vault names: all assertions passed\n";
	exit( $fail ? 1 : 0 );
}
