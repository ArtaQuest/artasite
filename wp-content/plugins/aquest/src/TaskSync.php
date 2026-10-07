<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaTask phone sync — the five JSON blobs the Cloudflare TASK_SYNC worker used to keep,
 * now rows in main SQL. There is no Workers KV, D1, or worker on this path.
 *
 * The whole database is public (/data, the nightly export). These blobs are a member's
 * Strava graph, session claim and phone prefs, so two things are true at once:
 *   - the table is in Extra::PRIVATE_TABLES, so the explorer, /schema and /offline skip it;
 *   - the payload column is ciphertext. The key never sits in the row.
 *
 * Envelope (not meeting-room E2E, and not Relay's worker-token AES-GCM):
 *   Rooms.php seals chat with keys that never reach the server, so the server could not
 *   hand the plaintext back to AccountSync. Relay::enc_image seals a screenshot for a
 *   laptop that shares AQ_WORKER_TOKEN; the phone does not hold that token, and a social
 *   graph must not be wrapped in the worker credential. Vault.php already seals secrets
 *   at rest with libsodium secretbox and a key derived from wp-config AUTH_KEY/AUTH_SALT
 *   (outside the database). This is that envelope, with its own context string so a vault
 *   ciphertext and a sync ciphertext are not interchangeable.
 *
 *   stored = base64( version || nonce(24) || secretbox(plaintext) )
 *   version 0x01 — key = sha256(AUTH_KEY | AUTH_SALT | "aq-task-sync-v1")
 *   version 0x02 — key = sha256("aq-task-sync-v2|" + AQ_TASK_SYNC_KEY) when that secret is set
 *   Writes use 0x02 once AQ_TASK_SYNC_KEY is set, and 0x01 otherwise. Reads pick the key
 *   from the version byte, so setting the dedicated key later does not strand existing rows.
 *
 * Rows mirror the KV key shape u:<wp user id>:<filename>. The HTTP path does not take a
 * user id: the signed-in member (cookie session, or a personal access token with the
 * `sync` scope) is the only row key a request can touch.
 *
 * Names are an allow-list. requestStatus.json carries LinkedIn/Instagram/Facebook
 * acceptance research events (still sealed here); on PUT the plaintext is also
 * unpacked into the public aq_arash_request_* tables. See docs/artatask-sync.md.
 */
final class TaskSync {

	const MAX_BYTES = 8388608; // 8 MiB plaintext. Base64 ciphertext then fits a 16MB max_allowed_packet.

	/** The filenames TASK_SYNC stored. A bare stem (no .json) is accepted and canonicalized. */
	const NAMES = [
		'strava_followers.json',
		'strava_following.json',
		'mutual_connections.json',
		'session_claim.json',
		'prefs.json',
		'requestStatus.json',
	];

	const WRITE_LIMIT = 120; // puts + deletes per member per hour
	const READ_LIMIT  = 600;

	/** '' when $raw is not one of NAMES. Never a path. requestStatus is allow-listed. */
	public static function canonical_name( $raw ) {
		$n = strtolower( trim( (string) $raw ) );
		$n = str_replace( '\\', '/', $n );
		$n = basename( $n );
		if ( $n === '' || $n === '.' || $n === '..' ) { return ''; }
		if ( substr( $n, -5 ) !== '.json' ) { $n .= '.json'; }
		if ( $n === 'requeststatus.json' ) { return 'requestStatus.json'; }
		foreach ( self::NAMES as $allowed ) {
			if ( strtolower( $allowed ) === $n ) { return $allowed; }
		}
		return '';
	}

	public static function available() {
		return function_exists( 'sodium_crypto_secretbox' )
			&& ( self::explicit_key() !== '' || self::derived_key() !== '' );
	}

	/**
	 * Validate a PUT/POST body. Returns ['body' => exact bytes] or ['error' => bad_body|too_large].
	 * Objects stay objects (`{}` is not stored as `[]`). The bytes are what we seal — no re-encode.
	 */
	public static function parse_blob( $body ) {
		if ( ! is_string( $body ) ) { return [ 'error' => 'bad_body' ]; }
		if ( strlen( $body ) > self::MAX_BYTES ) { return [ 'error' => 'too_large' ]; }
		if ( trim( $body ) === '' ) { return [ 'error' => 'bad_body' ]; }
		if ( ! self::spans_one_value( $body ) ) { return [ 'error' => 'bad_body' ]; }
		try {
			$decoded = json_decode( $body, false, 512, JSON_THROW_ON_ERROR );
		} catch ( \JsonException $e ) {
			return [ 'error' => 'bad_body' ];
		}
		if ( ! is_array( $decoded ) && ! ( $decoded instanceof \stdClass ) ) { return [ 'error' => 'bad_body' ]; }
		return [ 'body' => $body ];
	}

	/** base64 envelope, or '' when sealing is impossible. */
	public static function seal( $plain ) {
		if ( ! function_exists( 'sodium_crypto_secretbox' ) ) { return ''; }
		[ $ver, $key ] = self::seal_key();
		if ( $key === '' ) { return ''; }
		try {
			$nonce = random_bytes( SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
			$ct    = sodium_crypto_secretbox( (string) $plain, $nonce, $key );
		} finally {
			self::wipe( $key );
		}
		return base64_encode( $ver . $nonce . $ct );
	}

	/** Plaintext, or null when the envelope is missing, tampered, or the matching key is absent. */
	public static function open( $stored ) {
		if ( ! function_exists( 'sodium_crypto_secretbox_open' ) ) { return null; }
		$blob = base64_decode( (string) $stored, true );
		$nlen = SODIUM_CRYPTO_SECRETBOX_NONCEBYTES;
		if ( $blob === false || strlen( $blob ) < 1 + $nlen + SODIUM_CRYPTO_SECRETBOX_MACBYTES ) { return null; }
		$ver = $blob[0];
		if ( $ver === "\x01" ) { $key = self::derived_key(); }
		elseif ( $ver === "\x02" ) { $key = self::explicit_key(); }
		else { return null; }
		if ( $key === '' ) { return null; }
		$nonce = substr( $blob, 1, $nlen );
		$ct    = substr( $blob, 1 + $nlen );
		try {
			$pt = sodium_crypto_secretbox_open( $ct, $nonce, $key );
		} finally {
			self::wipe( $key );
		}
		return $pt === false ? null : $pt;
	}

	// ── HTTP (Rest::ROUTES) ─────────────────────────────────────────────────

	/** GET /task-sync — names, sizes, timestamps. No payloads. */
	public static function index( $req ) {
		if ( $err = self::throttle_read() ) { return $err; }
		$uid  = Rest::uid();
		$rows = Data::all(
			'SELECT blob_name, bytes, updated FROM ' . Data::t( 'aq_task_sync' ) . ' WHERE user_id = %d ORDER BY blob_name ASC',
			[ $uid ]
		);
		$items = [];
		foreach ( $rows as $r ) {
			$items[] = [
				'name'    => (string) $r['blob_name'],
				'bytes'   => (int) $r['bytes'],
				'updated' => (int) $r['updated'],
			];
		}
		return [
			'items'     => $items,
			'names'     => self::NAMES,
			'max_bytes' => self::MAX_BYTES,
		];
	}

	/** GET /task-sync/{name} — { name, bytes, updated, data }. 404 when this member has no row. */
	public static function get( $req ) {
		$name = self::canonical_name( Rest::p( $req, 'name', '' ) );
		if ( $name === '' ) { return self::bad_name(); }
		if ( $err = self::throttle_read() ) { return $err; }
		if ( $err = self::ready() ) { return $err; }
		$row = Data::one(
			'SELECT blob_name, ciphertext, bytes, updated FROM ' . Data::t( 'aq_task_sync' ) . ' WHERE user_id = %d AND blob_name = %s',
			[ Rest::uid(), $name ]
		);
		if ( ! $row || (string) $row['ciphertext'] === '' ) {
			return Rest::err( 'not_found', 'No sync blob stored under that name.', 404 );
		}
		$plain = self::open( (string) $row['ciphertext'] );
		if ( $plain === null ) {
			return Rest::err( 'undecryptable', 'Stored sync data could not be opened. Upload the phone\'s local copy again.', 409 );
		}
		try {
			$data = json_decode( $plain, false, 512, JSON_THROW_ON_ERROR );
		} catch ( \JsonException $e ) {
			return Rest::err( 'bad_stored', 'Stored sync data is not JSON. Upload the phone\'s local copy again.', 409 );
		}
		return [
			'name'    => (string) $row['blob_name'],
			'bytes'   => (int) $row['bytes'],
			'updated' => (int) $row['updated'],
			'data'    => $data,
		];
	}

	/** PUT or POST /task-sync/{name} — body is the JSON blob itself, not a wrapper. */
	public static function put( $req ) {
		$name = self::canonical_name( Rest::p( $req, 'name', '' ) );
		if ( $name === '' ) { return self::bad_name(); }
		if ( $err = self::throttle_write() ) { return $err; }
		if ( $err = self::ready() ) { return $err; }
		$parsed = self::parse_blob( (string) $req->get_body() );
		if ( isset( $parsed['error'] ) ) { return self::blob_error( $parsed['error'] ); }
		$plain = $parsed['body'];
		$ct    = self::seal( $plain );
		if ( $ct === '' ) {
			return Rest::err( 'sync_unavailable', 'Phone sync encryption failed.', 503 );
		}
		$uid   = Rest::uid();
		$now   = Data::now();
		$bytes = strlen( $plain );
		// upsert updates an existing row, but a unique-key race (two puts, neither saw the row)
		// makes the insert fail without writing. The follow-up update is the last-writer win.
		Data::upsert( 'aq_task_sync',
			[ 'user_id' => $uid, 'blob_name' => $name ],
			[ 'ciphertext' => $ct, 'bytes' => $bytes, 'updated' => $now ]
		);
		Data::update( 'aq_task_sync',
			[ 'ciphertext' => $ct, 'bytes' => $bytes, 'updated' => $now ],
			[ 'user_id' => $uid, 'blob_name' => $name ]
		);
		$research = null;
		if ( $name === 'requestStatus.json' && class_exists( __NAMESPACE__ . '\\ArashAcceptance' ) ) {
			$research = ArashAcceptance::ingest_blob( $uid, $plain );
		}
		$out = [ 'ok' => true, 'name' => $name, 'bytes' => $bytes, 'updated' => $now ];
		if ( is_array( $research ) ) { $out['research'] = $research; }
		return $out;
	}

	/** DELETE /task-sync/{name} — idempotent. Does not need the key (the row just goes away). */
	public static function remove( $req ) {
		$name = self::canonical_name( Rest::p( $req, 'name', '' ) );
		if ( $name === '' ) { return self::bad_name(); }
		if ( $err = self::throttle_write() ) { return $err; }
		global $wpdb;
		$n = $wpdb->delete(
			Data::t( 'aq_task_sync' ),
			[ 'user_id' => Rest::uid(), 'blob_name' => $name ],
			[ '%d', '%s' ]
		);
		return [ 'ok' => true, 'name' => $name, 'deleted' => (int) $n > 0 ];
	}

	/**
	 * True when the trimmed body is exactly one JSON object or array, with nothing after it.
	 * json_decode() on its own accepts `{"a":1}{"b":2}` and returns only the first value.
	 */
	private static function spans_one_value( $body ) {
		$s = trim( $body );
		$n = strlen( $s );
		if ( $n < 2 || ( $s[0] !== '{' && $s[0] !== '[' ) ) { return false; }
		$stack = [];
		$in    = false;
		$esc   = false;
		for ( $i = 0; $i < $n; $i++ ) {
			$c = $s[ $i ];
			if ( $in ) {
				if ( $esc ) { $esc = false; continue; }
				if ( $c === '\\' ) { $esc = true; continue; }
				if ( $c === '"' ) { $in = false; }
				continue;
			}
			if ( $c === '"' ) { $in = true; continue; }
			if ( $c === '{' || $c === '[' ) { $stack[] = $c; continue; }
			if ( $c === '}' || $c === ']' ) {
				if ( ! $stack ) { return false; }
				$open = array_pop( $stack );
				if ( ( $open === '{' && $c !== '}' ) || ( $open === '[' && $c !== ']' ) ) { return false; }
				if ( ! $stack ) { return trim( substr( $s, $i + 1 ) ) === ''; }
			}
		}
		return false;
	}

	// ── keys ────────────────────────────────────────────────────────────────

	private static function derived_key() {
		if ( ! defined( 'AUTH_KEY' ) || ! defined( 'AUTH_SALT' ) ) { return ''; }
		if ( strlen( (string) AUTH_KEY ) < 32 || strlen( (string) AUTH_SALT ) < 32 ) { return ''; }
		return hash( 'sha256', AUTH_KEY . '|' . AUTH_SALT . '|aq-task-sync-v1', true );
	}

	private static function explicit_key() {
		$raw = Secrets::get( 'AQ_TASK_SYNC_KEY' );
		if ( $raw === '' ) { return ''; }
		return hash( 'sha256', 'aq-task-sync-v2|' . $raw, true );
	}

	private static function seal_key() {
		$explicit = self::explicit_key();
		if ( $explicit !== '' ) { return [ "\x02", $explicit ]; }
		$derived = self::derived_key();
		if ( $derived !== '' ) { return [ "\x01", $derived ]; }
		return [ '', '' ];
	}

	private static function wipe( &$key ) {
		if ( $key !== '' && function_exists( 'sodium_memzero' ) ) {
			try { sodium_memzero( $key ); } catch ( \Throwable $e ) { /* best-effort */ }
		}
	}

	private static function ready() {
		if ( self::available() ) { return null; }
		return Rest::err(
			'sync_unavailable',
			'Phone sync encryption is not available on this site (needs libsodium, and wp-config AUTH_KEY / AUTH_SALT or AQ_TASK_SYNC_KEY).',
			503
		);
	}

	private static function bad_name() {
		return Rest::err(
			'bad_name',
			'Unknown sync blob. Allowed: ' . implode( ', ', self::NAMES ) . '.',
			400
		);
	}

	private static function blob_error( $code ) {
		if ( $code === 'too_large' ) {
			return Rest::err( 'too_large', 'Sync blob exceeds ' . self::MAX_BYTES . ' bytes.', 400 );
		}
		return Rest::err( 'bad_body', 'Send one JSON object or array as the request body (the blob itself, not a wrapper).', 400 );
	}

	private static function throttle_read() {
		if ( Rest::throttle( 'task_sync_read', self::READ_LIMIT, HOUR_IN_SECONDS ) ) {
			return Rest::err( 'rate_limited', 'Too many sync reads. Try again shortly.', 400 );
		}
		return null;
	}

	private static function throttle_write() {
		if ( Rest::throttle( 'task_sync_write', self::WRITE_LIMIT, HOUR_IN_SECONDS ) ) {
			return Rest::err( 'rate_limited', 'Too many sync writes. Try again shortly.', 400 );
		}
		return null;
	}
}
