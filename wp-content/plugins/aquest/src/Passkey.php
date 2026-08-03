<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Passkeys (WebAuthn) — the cryptographic half of the publication gate (operator 2026-07-24:
 * "only the user should have authorization to publish, not even the person who has access to
 * the server and source code").
 *
 * THE IDEA: the author's device holds a private key that NEVER exists on the server — not in
 * memory, not in mail, not anywhere the box can reach. Publishing signs the work's exact
 * source hash with that key; the signature is stored in the PUBLIC review ledger next to the
 * long-standing PUBLIC key, so the whole world can verify the author's consent and no one —
 * agent, operator, or server-root — can forge it. A server-holder's only remaining move is
 * swapping the stored public key, and key events are append-only in the public DB + alerted,
 * which makes that attack loud, dated, and evident to any auditor.
 *
 * Honest physics, stated once: whoever controls the server controls what the server DISPLAYS.
 * What this layer guarantees is the AUTHORIZATION RECORD — a publication without a valid
 * author signature is publicly provable as forged, forever.
 *
 * Scope: ES256 (P-256 ECDSA, COSE alg -7) — what every platform authenticator ships. No
 * attestation chain verification (we bind to the FIRST-USE key, standard for re-auth), no
 * resident-key requirement. Dependency-free: minimal CBOR walk + openssl_verify.
 */
final class Passkey {

	const TABLE_VERSION = '1';

	/** Active (unrevoked) passkeys per member. */
	const MAX_KEYS = 5;

	public static function ensure_table() {
		if ( get_option( 'aq_passkey_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$p = $wpdb->prefix;
		// Append-only by convention: revocation sets `revoked`, rows are never deleted, so the
		// public DB carries the full key history (a swapped key is a visible EVENT, not a silent
		// replacement).
		dbDelta( "CREATE TABLE {$p}aq_passkeys (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			label VARCHAR(80) NOT NULL DEFAULT '',
			cred_id VARCHAR(400) NOT NULL DEFAULT '',
			pubkey_pem TEXT,
			sign_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			last_used INT UNSIGNED NOT NULL DEFAULT 0,
			revoked INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY user (user_id, id),
			KEY cred (cred_id(191))
		) " . $wpdb->get_charset_collate() . ';' );
		update_option( 'aq_passkey_table_version', self::TABLE_VERSION );
	}

	// ── base64url ────────────────────────────────────────────────────────────

	public static function b64u_enc( $bin ) { return rtrim( strtr( base64_encode( (string) $bin ), '+/', '-_' ), '=' ); }
	public static function b64u_dec( $s ) {
		$s = strtr( (string) $s, '-_', '+/' );
		return base64_decode( $s . str_repeat( '=', ( 4 - strlen( $s ) % 4 ) % 4 ) );
	}

	// ── Minimal CBOR (just enough to walk an attestationObject / COSE key) ───

	private static function cbor( $bin, &$off ) {
		$b = ord( $bin[ $off++ ] );
		$maj = $b >> 5;
		$val = $b & 0x1f;
		if ( $val === 24 ) { $val = ord( $bin[ $off++ ] ); }
		elseif ( $val === 25 ) { $val = unpack( 'n', substr( $bin, $off, 2 ) )[1]; $off += 2; }
		elseif ( $val === 26 ) { $val = unpack( 'N', substr( $bin, $off, 4 ) )[1]; $off += 4; }
		elseif ( $val === 27 ) { $val = unpack( 'J', substr( $bin, $off, 8 ) )[1]; $off += 8; }
		switch ( $maj ) {
			case 0: return $val;                      // uint
			case 1: return -1 - $val;                 // negint
			case 2: case 3:                           // bytes / text
				$s = substr( $bin, $off, $val ); $off += $val; return $s;
			case 4:                                   // array
				$a = [];
				for ( $i = 0; $i < $val; $i++ ) { $a[] = self::cbor( $bin, $off ); }
				return $a;
			case 5:                                   // map
				$m = [];
				for ( $i = 0; $i < $val; $i++ ) { $k = self::cbor( $bin, $off ); $m[ is_string( $k ) ? $k : (string) $k ] = self::cbor( $bin, $off ); }
				return $m;
			default: return null;                     // tags/floats — not needed here
		}
	}

	/** COSE EC2 P-256 (x,y) → PEM public key (uncompressed point inside the standard SPKI header). */
	private static function cose_to_pem( $cose_bin ) {
		$off = 0;
		$k   = self::cbor( $cose_bin, $off );
		if ( ! is_array( $k ) || ( $k['3'] ?? null ) !== -7 || strlen( (string) ( $k['-2'] ?? '' ) ) !== 32 || strlen( (string) ( $k['-3'] ?? '' ) ) !== 32 ) { return ''; }
		$spki = hex2bin( '3059301306072a8648ce3d020106082a8648ce3d030107034200' ) . "\x04" . $k['-2'] . $k['-3'];
		return "-----BEGIN PUBLIC KEY-----\n" . chunk_split( base64_encode( $spki ), 64, "\n" ) . "-----END PUBLIC KEY-----\n";
	}

	// ── Registration (SESSION-ONLY, like token management) ───────────────────

	/** POST passkey/register/options — a fresh creation challenge for the signed-in member. */
	public static function register_options( $req ) {
		self::ensure_table();
		if ( Api::via_token() ) { return Rest::err( 'session_only', 'Passkey enrollment needs a signed-in session.', 403 ); }
		$uid = Rest::uid();
		$ch  = self::b64u_enc( random_bytes( 32 ) );
		set_transient( 'aq_pk_reg_' . $uid, $ch, 10 * MINUTE_IN_SECONDS );
		$u = get_userdata( $uid );
		return [
			'challenge' => $ch,
			'rp'        => [ 'id' => wp_parse_url( home_url(), PHP_URL_HOST ), 'name' => 'ArtaQuest' ],
			'user'      => [ 'id' => self::b64u_enc( 'aq-user-' . $uid ), 'name' => $u ? $u->user_login : ( 'member' . $uid ), 'displayName' => $u ? $u->display_name : ( 'Member ' . $uid ) ],
			'pubKeyCredParams' => [ [ 'type' => 'public-key', 'alg' => -7 ] ],
			'timeout'   => 120000,
			// residentKey required = a DISCOVERABLE credential, so the emailed confirm link can be
			// opened cross-device (scan the QR with a phone) and the passkey is found there; UV
			// required = the authenticator MUST verify the human (Face ID / Touch ID / device PIN),
			// enforced server-side below. Publication signing = QR + Face ID, by contract.
			'authenticatorSelection' => [ 'userVerification' => 'required', 'residentKey' => 'required', 'requireResidentKey' => true ],
			'attestation' => 'none',
		];
	}

	/** POST passkey/register {id, clientDataJSON, attestationObject, label} — verify + store. */
	public static function register( $req ) {
		self::ensure_table();
		if ( Api::via_token() ) { return Rest::err( 'session_only', 'Passkey enrollment needs a signed-in session.', 403 ); }
		$uid = Rest::uid();
		$ch  = (string) get_transient( 'aq_pk_reg_' . $uid );
		if ( $ch === '' ) { return Rest::err( 'expired', 'Enrollment challenge expired — start again.', 410 ); }
		delete_transient( 'aq_pk_reg_' . $uid );
		$cdj = self::b64u_dec( (string) Rest::p( $req, 'clientDataJSON', '' ) );
		$cd  = json_decode( $cdj, true );
		if ( ! is_array( $cd ) || ( $cd['type'] ?? '' ) !== 'webauthn.create' || ( $cd['challenge'] ?? '' ) !== $ch
			|| wp_parse_url( (string) ( $cd['origin'] ?? '' ), PHP_URL_HOST ) !== wp_parse_url( home_url(), PHP_URL_HOST ) ) {
			return Rest::err( 'bad_client_data', 'Client data did not verify.' );
		}
		$att = self::b64u_dec( (string) Rest::p( $req, 'attestationObject', '' ) );
		$off = 0;
		$obj = $att !== '' ? self::cbor( $att, $off ) : null;
		$auth = is_array( $obj ) ? (string) ( $obj['authData'] ?? '' ) : '';
		// authData: rpIdHash(32) flags(1) signCount(4) | AT: aaguid(16) credIdLen(2) credId cosePubkey
		// flags: 0x01 UP (user present) · 0x04 UV (user VERIFIED = biometric/PIN) · 0x40 AT (cred data)
		if ( strlen( $auth ) < 55 || ! ( ord( $auth[32] ) & 0x40 ) ) { return Rest::err( 'bad_attestation', 'No credential data present.' ); }
		if ( ! ( ord( $auth[32] ) & 0x04 ) ) { return Rest::err( 'uv_required', 'This passkey must verify you (Face ID / Touch ID / device PIN). Enrol on a device that supports it.' ); }
		if ( ! hash_equals( hash( 'sha256', (string) wp_parse_url( home_url(), PHP_URL_HOST ), true ), substr( $auth, 0, 32 ) ) ) {
			return Rest::err( 'bad_rp', 'Wrong relying party.' );
		}
		$len  = unpack( 'n', substr( $auth, 53, 2 ) )[1];
		$cid  = substr( $auth, 55, $len );
		$pem  = self::cose_to_pem( substr( $auth, 55 + $len ) );
		if ( $pem === '' ) { return Rest::err( 'bad_key', 'Only ES256 (P-256) passkeys are supported.' ); }
		$active = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_passkeys' ) . ' WHERE user_id = %d AND revoked = 0', [ $uid ] );
		if ( $active >= self::MAX_KEYS ) { return Rest::err( 'too_many', 'You already have ' . self::MAX_KEYS . ' active passkeys — revoke one first.', 409 ); }
		Data::insert( 'aq_passkeys', [
			'user_id'  => $uid,
			'label'    => sanitize_text_field( mb_substr( (string) Rest::p( $req, 'label', 'Passkey' ), 0, 80 ) ),
			'cred_id'  => self::b64u_enc( $cid ),
			'pubkey_pem' => $pem,
			'created'  => Data::now(),
		] );
		// The enrollment is a security EVENT: in-app + email, so a key planted by anything other
		// than the member is immediately visible to them.
		Notify::push( $uid, 'artadev', 'A new passkey was added to your account. It can now co-sign your publications. If this was not you, revoke it in Settings immediately.', '', '/user-account/', 'pkadd' . $uid . ':' . time() );
		$u = get_userdata( $uid );
		if ( $u && is_email( $u->user_email ) ) {
			Mailer::send( 'passkey_added', $u->user_email, [ 'label' => sanitize_text_field( mb_substr( (string) Rest::p( $req, 'label', 'Passkey' ), 0, 80 ) ) ] );
		}
		return [ 'ok' => true ];
	}

	/** GET passkey — the caller's keys (public metadata; the pubkey IS public by design). */
	public static function list_keys( $req ) {
		self::ensure_table();
		$rows = Data::all( 'SELECT id, label, cred_id, created, last_used, revoked FROM ' . Data::t( 'aq_passkeys' ) . ' WHERE user_id = %d ORDER BY id DESC LIMIT 20', [ Rest::uid() ] ) ?: [];
		return [ 'items' => array_map( static function ( $r ) {
			return [ 'id' => (int) $r['id'], 'label' => (string) $r['label'], 'created' => (int) $r['created'],
				'last_used' => (int) $r['last_used'], 'revoked' => (int) $r['revoked'] > 0 ];
		}, $rows ) ];
	}

	/** POST passkey/{id}/revoke — append-only revocation (the row and its history remain). */
	public static function revoke( $req ) {
		self::ensure_table();
		if ( Api::via_token() ) { return Rest::err( 'session_only', 'Passkey management needs a signed-in session.', 403 ); }
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_passkeys' ) . ' WHERE id = %d AND user_id = %d', [ Rest::pint( $req, 'id' ), Rest::uid() ] );
		if ( ! $row ) { return Rest::err( 'not_found', 'No such passkey', 404 ); }
		if ( ! (int) $row['revoked'] ) {
			Data::update( 'aq_passkeys', [ 'revoked' => Data::now() ], [ 'id' => (int) $row['id'] ] );
			self::revoke_alert( (int) $row['user_id'], (string) $row['label'] );
		}
		return [ 'ok' => true ];
	}

	/** Revoking a signing key is a security EVENT — announced like enrollment (email + in-app), so
	 *  a server-root actor cannot SILENTLY revoke a key to slip a signature-less publish past the
	 *  sweep. (The sweep also no longer trusts the revoked timestamp — see integrity_sweep.) */
	private static function revoke_alert( $uid, $label ) {
		Notify::push( (int) $uid, 'artadev', 'A passkey ("' . $label . '") was revoked from your account. If this was not you, someone has access to your session — sign out other devices and add a fresh passkey.', '', '/user-account/', 'pkrev' . (int) $uid . ':' . time() );
		$u = get_userdata( (int) $uid );
		if ( $u && is_email( $u->user_email ) ) {
			Mailer::send( 'passkey_revoked', $u->user_email, [ 'label' => (string) $label ] );
		}
	}

	// ── Assertion verification (the publication co-signature) ────────────────

	/** True iff the member has at least one active passkey (publishing then REQUIRES its signature). */
	public static function enrolled( $uid ) {
		self::ensure_table();
		return (bool) Data::col( 'SELECT id FROM ' . Data::t( 'aq_passkeys' ) . ' WHERE user_id = %d AND revoked = 0 LIMIT 1', [ (int) $uid ] );
	}

	/** The active credential ids for the confirm page's navigator.credentials.get allowlist. */
	public static function cred_ids( $uid ) {
		self::ensure_table();
		$rows = Data::all( 'SELECT cred_id FROM ' . Data::t( 'aq_passkeys' ) . ' WHERE user_id = %d AND revoked = 0 LIMIT 20', [ (int) $uid ] ) ?: [];
		return array_map( static function ( $r ) { return (string) $r['cred_id']; }, $rows );
	}

	/**
	 * Verify a WebAuthn assertion whose challenge IS the work's source sig (hex) — the device
	 * literally signed the exact bytes being published. Returns a verification record for the
	 * public ledger ('' on failure): anyone can recompute this check forever from public data.
	 */
	public static function verify_assertion( $uid, $expected_challenge, $cred_id_b64u, $client_data_b64u, $auth_data_b64u, $sig_b64u ) {
		self::ensure_table();
		$key = Data::one( 'SELECT * FROM ' . Data::t( 'aq_passkeys' ) . ' WHERE user_id = %d AND cred_id = %s AND revoked = 0',
			[ (int) $uid, (string) $cred_id_b64u ] );
		if ( ! $key ) { return ''; }
		$cdj = self::b64u_dec( $client_data_b64u );
		$cd  = json_decode( $cdj, true );
		if ( ! is_array( $cd ) || ( $cd['type'] ?? '' ) !== 'webauthn.get'
			|| ( $cd['challenge'] ?? '' ) !== self::b64u_enc( $expected_challenge )
			|| wp_parse_url( (string) ( $cd['origin'] ?? '' ), PHP_URL_HOST ) !== wp_parse_url( home_url(), PHP_URL_HOST ) ) { return ''; }
		$auth = self::b64u_dec( $auth_data_b64u );
		if ( strlen( $auth ) < 37 || ! hash_equals( hash( 'sha256', (string) wp_parse_url( home_url(), PHP_URL_HOST ), true ), substr( $auth, 0, 32 ) ) ) { return ''; }
		// flags byte (authData[32]): require UP (0x01, user present) AND UV (0x04, user VERIFIED —
		// Face ID / Touch ID / device PIN). A publication signature that skipped biometric/PIN
		// verification is refused: the contract is QR + Face ID, not a bare tap.
		if ( ( ord( $auth[32] ) & 0x05 ) !== 0x05 ) { return ''; }
		$ok = openssl_verify( $auth . hash( 'sha256', $cdj, true ), self::b64u_dec( $sig_b64u ), (string) $key['pubkey_pem'], OPENSSL_ALGO_SHA256 );
		if ( $ok !== 1 ) { return ''; }
		// Signature-counter monotonicity (WebAuthn clone/replay defense): reject a counter that
		// did not advance. Skip when the authenticator reports 0 (synced platform passkeys —
		// iCloud Keychain etc. — legitimately always send 0); the single-use challenge nonce is
		// the primary anti-replay there.
		$count = strlen( $auth ) >= 37 ? unpack( 'N', substr( $auth, 33, 4 ) )[1] : 0;
		if ( $count > 0 ) {
			if ( $count <= (int) $key['sign_count'] ) { return ''; }
			Data::update( 'aq_passkeys', [ 'sign_count' => $count ], [ 'id' => (int) $key['id'] ] );
		}
		Data::update( 'aq_passkeys', [ 'last_used' => Data::now() ], [ 'id' => (int) $key['id'] ] );
		// The publicly verifiable record: key row id + the signed material, replayable by anyone.
		return 'passkey:' . (int) $key['id'] . ' cred:' . (string) $key['cred_id']
			. ' challenge:' . (string) $expected_challenge
			. ' authData:' . (string) $auth_data_b64u
			. ' clientDataJSON:' . (string) $client_data_b64u
			. ' sig:' . (string) $sig_b64u;
	}
}
