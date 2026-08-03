<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Secrets come from the VAULT or the ENVIRONMENT, never the database.
 *
 * The whole database is public (see the Data explorer in Extra::db) — so anything stored in
 * wp_options is compromised the moment it's written. API keys, payment secrets, OAuth client
 * secrets, signing keys etc. must therefore live outside the DB, resolved in this order:
 *
 *   1. the VAULT (authoritative) — wp-admin → ArtaQuest Security. An encrypted, gitignored
 *      per-environment file (see Vault.php). Because it is checked FIRST, the admin page is
 *      the one place secrets are set and rotated — a value saved there wins immediately.
 *   2. an environment variable  — `STRIPE_SECRET_KEY=…` (dev/daemon fallback), or
 *   3. a wp-config.php constant  — `define( 'STRIPE_SECRET_KEY', '…' );` (gitignored; legacy
 *      fallback — import these into the vault from the admin page so rotation is tracked).
 *
 * Never `update_option()` a secret. Never hardcode one in source. Read it here:
 *
 *   $key = AQ\Secrets::get( 'STRIPE_SECRET_KEY' );
 *   if ( ! AQ\Secrets::has( 'STRIPE_SECRET_KEY' ) ) { … not configured … }
 */
final class Secrets {

	/** A secret from the vault (authoritative), env, or a wp-config constant. $default ('') when unset. */
	public static function get( $name, $default = '' ) {
		$v = Vault::get( $name );
		if ( $v !== '' ) { return $v; }
		$env = getenv( $name );
		if ( is_string( $env ) && $env !== '' ) { return $env; }
		if ( isset( $_SERVER[ $name ] ) && $_SERVER[ $name ] !== '' ) { return (string) $_SERVER[ $name ]; }
		if ( defined( $name ) ) {
			$v = constant( $name );
			if ( $v !== '' && $v !== null ) { return (string) $v; }
		}
		return $default;
	}

	/** True when a non-empty secret is configured in the vault / environment / wp-config. */
	public static function has( $name ) {
		return self::get( $name ) !== '';
	}

	/** Where a secret currently resolves from ('' when unset) — shown on the AQ Security page. */
	public static function source( $name ) {
		if ( Vault::get( $name ) !== '' ) { return 'vault'; }
		$env = getenv( $name );
		if ( ( is_string( $env ) && $env !== '' ) || ! empty( $_SERVER[ $name ] ) ) { return 'environment'; }
		if ( defined( $name ) && constant( $name ) !== '' && constant( $name ) !== null ) { return 'wp-config'; }
		return '';
	}
}
