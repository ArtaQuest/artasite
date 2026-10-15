<?php
namespace AQ;

/**
 * ProfileSync — mirrors a member's PUBLIC ArtaQuest profile onto the WordPress user record, so WP
 * Admin → Users shows the same person the site does (operator 2026-10-15).
 *
 * Writes only fields that are already public on /u/<handle>/ and in the /db explorer:
 *   first_name / last_name / nickname  ← aq_full_name (split at the last space)
 *   display_name                       ← aq_full_name, ONLY when display_name is empty or still the
 *                                        email-derived default Auth::find_or_create() stamped at
 *                                        sign-up. A name the member chose themselves is kept.
 *   user_url                           ← home_url( '/u/<user_nicename>/' )
 * Never touches user_login, user_email, roles/capabilities or description (profile save owns the
 * bio). Bots (_aq_is_bot, ArtaBot) are skipped. Writes only when a value actually changes.
 */
final class ProfileSync {

	/** Re-entrancy guard: wp_update_user fires profile_update, which would call us again. */
	private static $busy = false;

	public static function hooks() {
		add_action( 'added_user_meta', [ __CLASS__, 'on_meta' ], 10, 3 );
		add_action( 'updated_user_meta', [ __CLASS__, 'on_meta' ], 10, 3 );
		add_action( 'profile_update', [ __CLASS__, 'on_profile_update' ], 20, 1 );
	}

	public static function on_meta( $meta_id, $uid, $key ) {
		if ( 'aq_full_name' === $key ) { self::sync( (int) $uid ); }
	}

	public static function on_profile_update( $uid ) { self::sync( (int) $uid ); }

	public static function is_bot( $u ) {
		return ! $u || get_user_meta( $u->ID, '_aq_is_bot', true ) || $u->user_nicename === Arta::HANDLE;
	}

	/** What sign-up stamps as display_name when no name was given (mirror of Auth::find_or_create). */
	public static function email_default( $email ) {
		$local = strstr( (string) $email, '@', true );
		return false === $local ? '' : ucwords( str_replace( [ '.', '_', '-' ], ' ', $local ) );
	}

	/** first/last from a full name: last space splits; a single word is the first name. */
	public static function split( $full ) {
		$full = trim( preg_replace( '/\s+/u', ' ', (string) $full ) );
		$at   = function_exists( 'mb_strrpos' ) ? mb_strrpos( $full, ' ' ) : strrpos( $full, ' ' );
		if ( false === $at ) { return [ $full, '' ]; }
		return [ mb_substr( $full, 0, $at ), mb_substr( $full, $at + 1 ) ];
	}

	/** PURE: the changes sync() would make, as field => [ old, new ]. Empty = already in sync. */
	public static function plan( $uid ) {
		$u = get_userdata( (int) $uid );
		if ( self::is_bot( $u ) ) { return []; }
		$want = [];
		$full = trim( (string) get_user_meta( $u->ID, 'aq_full_name', true ) );
		if ( '' !== $full ) {
			[ $first, $last ] = self::split( $full );
			$want['first_name'] = $first;
			$want['last_name']  = $last;
			$want['nickname']   = $full;
			$dn = trim( (string) $u->display_name );
			if ( '' === $dn || $dn === self::email_default( $u->user_email ) ) { $want['display_name'] = $full; }
		}
		if ( '' !== (string) $u->user_nicename ) {
			$want['user_url'] = home_url( '/u/' . $u->user_nicename . '/' );
		}
		$diff = [];
		foreach ( $want as $f => $new ) {
			$old = (string) $u->$f;
			if ( $old !== $new ) { $diff[ $f ] = [ $old, $new ]; }
		}
		return $diff;
	}

	/** Apply plan(). Returns the diff that was applied. */
	public static function sync( $uid ) {
		if ( self::$busy ) { return []; }
		$diff = self::plan( $uid );
		if ( ! $diff ) { return []; }
		self::$busy = true;
		try {
			$args = [ 'ID' => (int) $uid ];
			foreach ( $diff as $f => $pair ) { $args[ $f ] = $pair[1]; }
			$res = wp_update_user( $args );
		} finally {
			self::$busy = false;
		}
		return is_wp_error( $res ) ? [] : $diff;
	}
}
