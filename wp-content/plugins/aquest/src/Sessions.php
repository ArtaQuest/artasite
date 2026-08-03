<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Account-security: active sign-in sessions.
 *
 * Sits on top of WordPress's native session store — every call to wp_set_auth_cookie() records a
 * row in usermeta `session_tokens`, keyed by the verifier sha256(token), holding { ip, ua, login,
 * expiration }. The raw token lives ONLY in the user's cookie, so the verifier is safe to surface
 * (you cannot forge the auth cookie from a hash without the secret salts, which are wp-config
 * constants — never in the public DB). We therefore never create a parallel session table: we read
 * what WP already stores and let the owner SEE and REVOKE their own sessions.
 *
 * Surfaced per session: device (browser/OS parsed from the UA), location (IP geolocated, cached),
 * sign-in time, expiry, and which one is "this device". Revoke a single session, or sign out of all
 * OTHER devices at once. A sign-in from an unrecognised device pushes an alert (bell + email) so a
 * member notices a hijack attempt.
 *
 * NOTE the public DB explorer redacts the `session_tokens` usermeta + sign-in code transients
 * (Extra::redact_row) — they are the directive's named security exceptions to full transparency.
 */
final class Sessions {

	/** Usermeta key WordPress stores its session map under. */
	const META = 'session_tokens';

	// ── Routes ───────────────────────────────────────────────────────────────

	/** GET /me/sessions — the signed-in member's active sessions, "this device" first. */
	public static function list( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$cur   = self::current_verifier();
		$items = [];
		foreach ( self::raw_sessions( $uid ) as $verifier => $s ) {
			$ip   = (string) ( $s['ip'] ?? '' );
			$ua   = (string) ( $s['ua'] ?? '' );
			$items[] = [
				'id'       => (string) $verifier,
				'current'  => $cur !== '' && hash_equals( (string) $verifier, $cur ),
				'ip'       => $ip,
				'device'   => self::device( $ua ),
				'location' => self::geo( $ip ),
				'login'    => (int) ( $s['login'] ?? 0 ),
				'expires'  => (int) ( $s['expiration'] ?? 0 ),
			];
		}
		// "This device" first, then most-recent sign-in.
		usort( $items, function ( $a, $b ) {
			if ( $a['current'] !== $b['current'] ) { return $a['current'] ? -1 : 1; }
			return $b['login'] <=> $a['login'];
		} );
		return [ 'items' => $items, 'count' => count( $items ) ];
	}

	/** POST /me/sessions/revoke {id} — sign one device out (id = the 64-hex verifier). */
	public static function revoke( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		if ( Rest::throttle( 'sess_revoke', 40, 600 ) ) { return Rest::err( 'rate_limited', 'Slow down a moment.', 429 ); }
		$id = preg_replace( '/[^a-f0-9]/', '', strtolower( (string) Rest::p( $req, 'id', '' ) ) );
		if ( strlen( $id ) !== 64 ) { return Rest::err( 'bad_input', 'Invalid session id.' ); }
		$map = get_user_meta( $uid, self::META, true );
		if ( ! is_array( $map ) || ! isset( $map[ $id ] ) ) { return Rest::err( 'not_found', 'That session no longer exists.', 404 ); }
		$was_current = self::current_verifier() !== '' && hash_equals( $id, self::current_verifier() );
		unset( $map[ $id ] );
		if ( $map ) { update_user_meta( $uid, self::META, $map ); }
		else        { delete_user_meta( $uid, self::META ); }
		// If they revoked the device they're on, their cookie is now dead — tell the client to bounce to login.
		return [ 'ok' => true, 'was_current' => $was_current, 'remaining' => count( self::raw_sessions( $uid ) ) ];
	}

	/** POST /me/sessions/revoke-others — sign out every device EXCEPT this one (keeps you signed in). */
	public static function revoke_others( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$token = function_exists( 'wp_get_session_token' ) ? wp_get_session_token() : '';
		if ( $token ) {
			$mgr = \WP_Session_Tokens::get_instance( $uid );
			$mgr->destroy_others( $token ); // keeps the current verifier, drops the rest
		} else {
			wp_destroy_other_sessions();
		}
		Notify::push( $uid, 'security', 'Signed out other devices', 'You signed out of all other active sessions. Only this device stays signed in.', '/user-account/' );
		return [ 'ok' => true, 'remaining' => count( self::raw_sessions( $uid ) ) ];
	}

	/** POST /auth/logout — sign THIS device out (destroys the current session token + clears cookies). */
	public static function logout( $req ) {
		wp_logout();
		return [ 'ok' => true ];
	}

	// ── Sign-in alert (called from Auth::sign_in, never blocks the login) ───────

	/**
	 * Right after a successful sign-in, alert the member if the device is one we haven't seen among
	 * their OTHER active sessions. First-ever session (no others) is skipped — that's the sign-in
	 * itself, not a surprise. Recognised device → silent. New device → bell + email, so a hijack
	 * (someone who got a code) is visible immediately.
	 */
	public static function on_sign_in( $uid ) {
		$uid = (int) $uid;
		if ( ! $uid ) { return; }
		$cur = self::current_verifier();
		$all = self::raw_sessions( $uid );

		// The session we just created (matched by the current cookie's verifier), else fall back to the request.
		$this_s = ( $cur !== '' && isset( $all[ $cur ] ) ) ? $all[ $cur ] : null;
		$ip = (string) ( $this_s['ip'] ?? ( $_SERVER['REMOTE_ADDR'] ?? '' ) );
		$ua = (string) ( $this_s['ua'] ?? ( $_SERVER['HTTP_USER_AGENT'] ?? '' ) );
		$dev = self::device( $ua );
		$fp  = strtolower( $dev['browser'] . '|' . $dev['os'] );

		$others = 0; $known = false;
		foreach ( $all as $v => $s ) {
			if ( $cur !== '' && hash_equals( (string) $v, $cur ) ) { continue; } // skip the just-created one
			$others++;
			$d = self::device( (string) ( $s['ua'] ?? '' ) );
			if ( strtolower( $d['browser'] . '|' . $d['os'] ) === $fp ) { $known = true; }
		}

		// ADMINISTRATOR sign-ins get a tamper-evident audit trail: every one is noted in the Watchdog
		// log (a file an attacker with DB access cannot scrub), and one from an UNRECOGNISED device
		// raises a real alarm — an operator session is full takeover, so the operator should hear about
		// a new device on any admin account the moment it happens, not only the account's own inbox.
		$is_admin = user_can( $uid, 'manage_options' );
		if ( $is_admin ) {
			$geo = self::geo( $ip );
			$u   = get_userdata( $uid );
			Watchdog::note( 'Admin sign-in: ' . ( $u ? $u->user_login : "#{$uid}" ) . ' from '
				. ( $geo['label'] ?: 'unknown' ) . ' on ' . $dev['label']
				. ( $others === 0 || $known ? '' : ' (NEW device)' ) );
		}
		if ( $others === 0 || $known ) { return; } // first session, or a device we recognise

		$geo   = $geo ?? self::geo( $ip );
		$where = ! empty( $geo['local'] ) ? 'your local network' : ( $geo['label'] !== '' ? $geo['label'] : 'an unknown location' );
		if ( $is_admin ) {
			$u = $u ?? get_userdata( $uid );
			Watchdog::alert( 'admin_new_device_' . $uid, 'ADMIN signed in from a NEW device',
				'Administrator `' . ( $u ? $u->user_login : "#{$uid}" ) . "` just signed in from an unrecognised device: "
				. $dev['label'] . ' — ' . $where . " (IP {$ip}).\n"
				. 'If this was you, ignore. If not, that account is compromised: revoke its sessions '
				. '(Account → Security), and check the Watchdog audit log for what the session touched.', true );
		}
		$body  = sprintf(
			'A new sign-in to your account from %s on %s. If this wasn\'t you, open Account → Security and sign out that device, then request a new code.',
			$where,
			$dev['label']
		);
		Notify::push( $uid, 'security', 'New sign-in to your account', $body, '/user-account/' );
		$u = get_userdata( $uid );
		if ( $u && $u->user_email ) {
			Mailer::send( 'new_device', $u->user_email, [
				'where'  => $where,
				'device' => $dev['label'],
				'when'   => date_i18n( 'M j, Y · H:i', time() ),
				'ip'     => $ip,
			] );
		}
	}

	// ── Helpers ────────────────────────────────────────────────────────────────

	/** Valid (unexpired) sessions for a user, as verifier => session map. */
	private static function raw_sessions( $uid ) {
		$map = get_user_meta( (int) $uid, self::META, true );
		if ( ! is_array( $map ) ) { return []; }
		$now = time(); $out = [];
		foreach ( $map as $verifier => $s ) {
			if ( is_array( $s ) && (int) ( $s['expiration'] ?? 0 ) >= $now ) { $out[ (string) $verifier ] = $s; }
		}
		return $out;
	}

	/** Verifier (sha256) of the current request's session token, or '' when not cookie-authed. */
	private static function current_verifier() {
		$t = function_exists( 'wp_get_session_token' ) ? wp_get_session_token() : '';
		return $t ? hash( 'sha256', $t ) : '';
	}

	/**
	 * Parse a User-Agent into { browser, os, type, label } with no dependency. Order matters:
	 * Edge/Opera/Samsung masquerade as Chrome, and Chrome's UA also contains "Safari".
	 */
	public static function device( $ua ) {
		$ua = (string) $ua;
		if ( $ua === '' ) {
			return [ 'browser' => 'Unknown', 'os' => 'Unknown', 'type' => 'desktop', 'label' => 'Unknown device' ];
		}

		$os = 'Unknown';
		if     ( preg_match( '/Windows NT 10/i', $ua ) )                 { $os = 'Windows 10/11'; }
		elseif ( preg_match( '/Windows NT 6\.[123]/i', $ua ) )           { $os = 'Windows'; }
		elseif ( preg_match( '/Windows/i', $ua ) )                       { $os = 'Windows'; }
		elseif ( preg_match( '/iPhone|iPad|iPod/i', $ua ) )              { $os = 'iOS'; }
		elseif ( preg_match( '/CrOS/i', $ua ) )                          { $os = 'ChromeOS'; }
		elseif ( preg_match( '/Mac OS X|Macintosh/i', $ua ) )            { $os = 'macOS'; }
		elseif ( preg_match( '/Android/i', $ua ) )                       { $os = 'Android'; }
		elseif ( preg_match( '/Linux/i', $ua ) )                         { $os = 'Linux'; }

		$browser = 'Unknown';
		if     ( preg_match( '/Edg(?:e|A|iOS)?\//i', $ua ) )             { $browser = 'Edge'; }
		elseif ( preg_match( '/OPR\/|Opera/i', $ua ) )                   { $browser = 'Opera'; }
		elseif ( preg_match( '/SamsungBrowser/i', $ua ) )               { $browser = 'Samsung Internet'; }
		elseif ( preg_match( '/Firefox\/|FxiOS/i', $ua ) )              { $browser = 'Firefox'; }
		elseif ( preg_match( '/CriOS\/|Chrome\//i', $ua ) )            { $browser = 'Chrome'; }
		elseif ( preg_match( '/Safari\//i', $ua ) )                     { $browser = 'Safari'; }

		$type = 'desktop';
		if     ( preg_match( '/iPad|Tablet/i', $ua ) )                  { $type = 'tablet'; }
		elseif ( preg_match( '/Mobi|iPhone|Android.*Mobile/i', $ua ) )  { $type = 'mobile'; }

		$label = ( $browser !== 'Unknown' && $os !== 'Unknown' ) ? "{$browser} on {$os}"
			: ( $browser !== 'Unknown' ? $browser : ( $os !== 'Unknown' ? $os : 'Unknown device' ) );

		return [ 'browser' => $browser, 'os' => $os, 'type' => $type, 'label' => $label ];
	}

	/**
	 * Geolocate an IP to { label, city, country, cc, flag, local }. Cached per IP for a week (failures
	 * cached briefly). Private/reserved/local IPs short-circuit with no external call. Best-effort:
	 * a lookup failure just yields an "Unknown location" — it never blocks the response.
	 */
	public static function geo( $ip ) {
		$ip = (string) $ip;
		if ( $ip === '' || self::is_local_ip( $ip ) ) {
			return [ 'label' => 'Local network', 'city' => '', 'country' => '', 'cc' => '', 'flag' => '🏠', 'local' => true ];
		}
		$key = 'aq_ipgeo_' . md5( $ip );
		$hit = get_transient( $key );
		if ( is_array( $hit ) ) { return $hit; }

		$unknown = [ 'label' => 'Unknown location', 'city' => '', 'country' => '', 'cc' => '', 'flag' => '🌐', 'local' => false ];
		$resp = wp_remote_get(
			'http://ip-api.com/json/' . rawurlencode( $ip ) . '?fields=status,country,countryCode,regionName,city',
			[ 'timeout' => 3 ]
		);
		if ( ! is_wp_error( $resp ) && 200 === (int) wp_remote_retrieve_response_code( $resp ) ) {
			$j = json_decode( wp_remote_retrieve_body( $resp ), true );
			if ( is_array( $j ) && ( $j['status'] ?? '' ) === 'success' ) {
				$city    = (string) ( $j['city'] ?? '' );
				$country = (string) ( $j['country'] ?? '' );
				$cc      = strtoupper( (string) ( $j['countryCode'] ?? '' ) );
				$parts   = array_filter( [ $city, $country ] );
				$out     = [
					'label'   => $parts ? implode( ', ', $parts ) : 'Unknown location',
					'city'    => $city,
					'country' => $country,
					'cc'      => $cc,
					'flag'    => self::flag( $cc ),
					'local'   => false,
				];
				set_transient( $key, $out, 7 * DAY_IN_SECONDS );
				return $out;
			}
		}
		set_transient( $key, $unknown, HOUR_IN_SECONDS ); // don't hammer a failing/blocked lookup
		return $unknown;
	}

	/** True for empty, malformed, loopback, private or reserved IPs (no point geolocating those). */
	private static function is_local_ip( $ip ) {
		if ( $ip === '127.0.0.1' || $ip === '::1' ) { return true; }
		if ( ! filter_var( $ip, FILTER_VALIDATE_IP ) ) { return true; }
		return ! filter_var( $ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE );
	}

	/** Two-letter country code → flag emoji (regional-indicator pair); 🌐 when unknown. */
	public static function flag( $cc ) {
		$cc = strtoupper( (string) $cc );
		if ( strlen( $cc ) !== 2 || ! ctype_alpha( $cc ) ) { return '🌐'; }
		return mb_chr( 0x1F1E6 + ord( $cc[0] ) - 65, 'UTF-8' ) . mb_chr( 0x1F1E6 + ord( $cc[1] ) - 65, 'UTF-8' );
	}
}
