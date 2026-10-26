<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * The secrets VAULT — every operational secret, manageable from ONE place: wp-admin →
 * ArtaQuest Security (operators only, `manage_options`). This is the authoritative store:
 * Secrets::get() checks the vault FIRST, so a value rotated here wins over any leftover
 * environment variable or wp-config constant immediately.
 *
 * Storage — never the database (the whole DB is public, see Extra::db):
 *   - One gitignored file per environment: wp-content/aq-vault.php. `studio push` excludes
 *     gitignored files, so a deploy can never ship or overwrite a vault.
 *   - Values are ENCRYPTED at rest (libsodium secretbox) with a key derived from the
 *     wp-config AUTH_KEY/AUTH_SALT constants — which live outside both the DB and this file.
 *     Someone who somehow obtains the file still can't read it without wp-config.
 *   - The file is a PHP script whose first line 404s and exits on any direct web hit; the
 *     JSON payload after it is reached only via file_get_contents (never include → the
 *     reader is immune to stale opcache across WP.com Atomic containers).
 *
 * The admin page is WRITE-ONLY for values: it shows existence, source, age and the last 4
 * characters — never a full secret. Rotation metadata (rotated-at, compromised flag) lives in
 * the vault file too, and Watchdog::check_rotation raises the alarms when a key is overdue.
 */
final class Vault {

	const FILE = 'aq-vault.php'; // under WP_CONTENT_DIR
	const GUARD = "<?php http_response_code(404); exit; // ArtaQuest vault — managed from wp-admin → ArtaQuest Security ?>\n";

	/**
	 * Every secret the platform reads (grep Secrets::get to extend), GROUPED BY PURPOSE:
	 *   NAME => [ one-line description, rotation policy in days, optional, group ]
	 *
	 * ROTATION POLICY (operator 2026-10-26: "only rotate every 90 days the absolute important ones"):
	 *   90  — a credential that moves money, sends mail as us, or writes our storage/DNS account
	 *   180 — a lower-risk token (one route, one bot, one integration)
	 *   365 — a narrow token that only publishes our own public work
	 *   0   — NOT a credential: an identifier, hostname, address, port, publishable key or flag.
	 *         No rotation clock, never "rotation due", never counted as a missing credential.
	 * OPTIONAL: `true` = not required; a NAME = another secret that satisfies the same need.
	 *
	 * NAMES WERE SIMPLIFIED on 2026-10-26 (MAIL_*, CLOUDFLARE_*, R2_*, CALLS_*, BOT_*, ARTA_*, FLAG_*).
	 * The old names in ALIASES still resolve everywhere (vault, env, wp-config), and migrate_names()
	 * moves a vault entry to its new name — the same ciphertext, so no value is re-entered.
	 */
	const REGISTRY = [
		// ── Payments ──────────────────────────────────────────────────────────────────────────
		'STRIPE_SECRET_KEY'            => [ 'Stripe LIVE secret key (sk_live_…) — coin purchases, donations, cash-outs', 90, false, 'Payments' ],
		'STRIPE_WEBHOOK_SECRET'        => [ 'Stripe webhook signing secret (whsec_…) — proves a payment event came from Stripe', 90, false, 'Payments' ],
		'STRIPE_PUBLISHABLE_KEY'       => [ 'Stripe publishable key (pk_live_…) — public by design, shown to browsers; replace it when the secret key is rolled', 0, false, 'Payments' ],

		// ── Email ─────────────────────────────────────────────────────────────────────────────
		// ACS is the primary sender; SMTP is the fallback when ACS refuses. Either one delivers mail.
		'MAIL_ACS_CONNECTION'          => [ 'Azure Communication Services connection string (endpoint=…;accesskey=…) — primary sender for all platform email', 90, 'MAIL_SMTP_PASSWORD', 'Email' ],
		'MAIL_ACS_SENDER'              => [ 'ACS verified sender address, e.g. DoNotReply@mail.artaquest.org', 0, true, 'Email' ],
		'MAIL_SMTP_PASSWORD'           => [ 'SMTP password / app password for the support@ mailbox — fallback sender when ACS refuses', 90, 'MAIL_ACS_CONNECTION', 'Email' ],
		'MAIL_SMTP_HOST'               => [ 'SMTP host — default smtp.gmail.com', 0, true, 'Email' ],
		'MAIL_SMTP_PORT'               => [ 'SMTP port — default 587 (STARTTLS); 465 = SSL', 0, true, 'Email' ],
		'MAIL_SMTP_USER'               => [ 'SMTP username — default support@artaquest.org', 0, true, 'Email' ],
		'MAIL_TITAN_PASSWORD'          => [ 'Titan mailbox password (arash@ / support@) — handed only to ArtaMail via GET /aq/v1/secret/titan', 90, true, 'Email' ],
		'MAIL_ALERTS_TO'               => [ 'Where security and ops alerts are emailed — default the site admin email', 0, true, 'Email' ],

		// ── Cloudflare: media storage (R2) ────────────────────────────────────────────────────
		// All four of CLOUDFLARE_ACCOUNT_ID + R2_BUCKET + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY switch
		// uploads to R2 (Media::r2_ready); with any one missing, files stay on this server.
		'CLOUDFLARE_ACCOUNT_ID'        => [ 'Cloudflare account ID (32 hex) that owns the R2 bucket', 0, true, 'Cloudflare' ],
		'R2_BUCKET'                    => [ 'R2 bucket name for media, e.g. artaquest-media', 0, true, 'Cloudflare' ],
		'R2_ACCESS_KEY_ID'             => [ 'R2 S3 access key ID — from an R2 API token with Object Read & Write on the media bucket only. Rotates with the secret below', 90, true, 'Cloudflare' ],
		'R2_SECRET_ACCESS_KEY'         => [ 'R2 S3 secret access key — the secret half of R2_ACCESS_KEY_ID', 90, true, 'Cloudflare' ],
		'MEDIA_CDN_URL'                => [ 'Public base URL media is served from (the bucket public URL or its custom domain), no trailing slash', 0, true, 'Cloudflare' ],
		'CLOUDFLARE_API_TOKEN'         => [ 'Cloudflare API token, Account › Workers R2 Storage: Edit (bucket usage + CORS), optionally Account Analytics: Read', 90, true, 'Cloudflare' ],

		// ── Calls (WebRTC relay for room calls) ───────────────────────────────────────────────
		// Either a Cloudflare Realtime TURN key OR a static TURN server. Neither = STUN only.
		'CALLS_TURN_KEY_ID'            => [ 'Cloudflare Realtime TURN key ID — call relay for devices STUN cannot join', 0, true, 'Calls' ],
		'CALLS_TURN_KEY_TOKEN'         => [ 'Cloudflare Realtime TURN key API token (pairs with CALLS_TURN_KEY_ID)', 180, true, 'Calls' ],
		'CALLS_TURN_URLS'              => [ 'Static TURN server URLs, comma-separated — alternative to the Cloudflare TURN key', 0, true, 'Calls' ],
		'CALLS_TURN_USER'              => [ 'Static TURN username', 0, true, 'Calls' ],
		'CALLS_TURN_PASSWORD'          => [ 'Static TURN password', 180, true, 'Calls' ],

		// ── Google & YouTube ──────────────────────────────────────────────────────────────────
		'GOOGLE_SIGNIN_CLIENT_ID'      => [ 'Google sign-in OAuth client ID — public, embedded in the sign-in button', 0, false, 'Google & YouTube' ],
		'YOUTUBE_SERVICE_ACCOUNT_JSON' => [ 'YouTube service-account JSON — primary auth for the video view monitor', 180, 'YOUTUBE_API_KEY', 'Google & YouTube' ],
		'YOUTUBE_API_KEY'              => [ 'YouTube Data API key — alternative to the service account (read-only, public data)', 365, 'YOUTUBE_SERVICE_ACCOUNT_JSON', 'Google & YouTube' ],

		// ── Integrations ──────────────────────────────────────────────────────────────────────
		'KAGGLE_TOKEN'                 => [ 'Kaggle API token (KGAT_…) — dataset cards and reading public kernels', 365, true, 'Integrations' ],
		'KAGGLE_API_KEY'               => [ 'Kaggle legacy API key — needed to PUSH notebooks as kernels (HTTP Basic with KAGGLE_USERNAME)', 180, true, 'Integrations' ],
		'KAGGLE_USERNAME'              => [ 'Kaggle account the API key belongs to — default artafather', 0, true, 'Integrations' ],
		'GITHUB_GIST_TOKEN'            => [ 'GitHub token with only the `gist` scope — mirrors submitted notebooks to public gists (one-click Colab)', 365, true, 'Integrations' ],
		'ZENODO_TOKEN'                 => [ 'Zenodo token (deposit:write + deposit:actions) — mints DOIs for Research articles', 365, true, 'Integrations' ],

		// ── Bot tokens (we mint these; each unlocks ONE route) ────────────────────────────────
		'BOT_ARTA_TOKEN'               => [ 'Token the @artabot brain sends (X-Arta-Token) to claim mentions and reply — ≥32 chars, same value as the brain ARTA_REPLY_TOKEN', 180, true, 'Bot tokens' ],
		'BOT_ARTAMAIL_TOKEN'           => [ 'Token ArtaMail sends to GET /aq/v1/secret/titan (its only route) — ≥32 chars, not the Titan password', 180, true, 'Bot tokens' ],
		'BOT_ARTASEARCH_TOKEN'         => [ 'Token the ArtaSearch scan box sends (X-AQ-Alumni-Token) to POST /aq/v1/outreach/alumni/ingest — ≥32 chars', 180, true, 'Bot tokens' ],
		'BOT_WORKER_TOKEN'             => [ 'Token the ArtaDev ticket worker sends (X-AQ-Worker). Unset = worker routes closed', 180, true, 'Bot tokens' ],

		// ── Arta relay (where an Arta turn is pushed — endpoints, not credentials) ────────────
		'ARTA_RELAY_URL'               => [ 'Default Arta turn endpoint (plain chat turns)', 0, true, 'Arta relay' ],
		'ARTA_TOOLS_URL'               => [ 'Default Arta TOOLS endpoint (member tool turns) when a tier has none of its own', 0, true, 'Arta relay' ],
		'ARTA_TOOLS_URL_LOW'           => [ 'Arta tools endpoint for the Low tier', 0, true, 'Arta relay' ],
		'ARTA_TOOLS_URL_MEDIUM'        => [ 'Arta tools endpoint for the Medium tier', 0, true, 'Arta relay' ],
		'ARTA_TOOLS_URL_HIGH'          => [ 'Arta tools endpoint for the High tier', 0, true, 'Arta relay' ],
		'ARTA_TOOLS_URL_XHIGH'         => [ 'Arta tools endpoint for the X-High tier', 0, true, 'Arta relay' ],
		'ARTA_TOOLS_URL_MAX'           => [ 'Arta tools endpoint for the Max tier', 0, true, 'Arta relay' ],
		'ARTA_TOOLS_URL_WORKFLOW'      => [ 'Arta tools endpoint for multi-agent Workflow turns', 0, true, 'Arta relay' ],
		'ARTA_BROKER_URL'              => [ 'Arta broker endpoint (optional)', 0, true, 'Arta relay' ],
		'ARTA_SHELL_URL'               => [ 'ArtaShell endpoint (the member terminal)', 0, true, 'Arta relay' ],
		'ARTA_RELAY_SECRET'            => [ 'Shared HMAC secret that signs relay + shell job tokens', 180, true, 'Arta relay' ],

		// ── Encryption ────────────────────────────────────────────────────────────────────────
		'TASK_SYNC_KEY'                => [ 'Optional dedicated key for ArtaTask phone-sync blobs. Do NOT rotate on a clock: changing it strands rows until phones re-upload (docs/artatask-sync.md)', 0, true, 'Encryption' ],

		// ── Flags (set = on; not credentials) ─────────────────────────────────────────────────
		'FLAG_CASHOUT_FROZEN'          => [ 'FLAG — set to freeze coin cash-outs', 0, true, 'Flags' ],
		'FLAG_ALLOW_PASSWORD_LOGIN'    => [ 'RECOVERY FLAG — re-enables password logins. Must stay UNSET (the DB is public)', 0, true, 'Flags' ],
	];

	/** NEW NAME => [ old names ]. Every old name keeps resolving (vault, environment, wp-config). */
	const ALIASES = [
		'MAIL_ACS_CONNECTION'          => [ 'AQ_ACS_EMAIL_CONNECTION' ],
		'MAIL_ACS_SENDER'              => [ 'AQ_ACS_EMAIL_SENDER' ],
		'MAIL_SMTP_PASSWORD'           => [ 'SMTP_PASS' ],
		'MAIL_SMTP_HOST'               => [ 'SMTP_HOST' ],
		'MAIL_SMTP_PORT'               => [ 'SMTP_PORT' ],
		'MAIL_SMTP_USER'               => [ 'SMTP_USER' ],
		'MAIL_TITAN_PASSWORD'          => [ 'TITAN_PASSWORD' ],
		'MAIL_ALERTS_TO'               => [ 'OPERATOR_EMAIL' ],
		'CLOUDFLARE_ACCOUNT_ID'        => [ 'AQ_R2_ACCOUNT' ],
		'R2_BUCKET'                    => [ 'AQ_R2_BUCKET' ],
		'R2_ACCESS_KEY_ID'             => [ 'AQ_R2_KEY' ],
		'R2_SECRET_ACCESS_KEY'         => [ 'AQ_R2_SECRET' ],
		'MEDIA_CDN_URL'                => [ 'AQ_MEDIA_CDN' ],
		'CLOUDFLARE_API_TOKEN'         => [ 'AQ_CF_API_TOKEN' ],
		'CALLS_TURN_KEY_ID'            => [ 'AQ_CF_TURN_KEY_ID' ],
		'CALLS_TURN_KEY_TOKEN'         => [ 'AQ_CF_TURN_KEY_TOKEN' ],
		'CALLS_TURN_URLS'              => [ 'AQ_TURN_URLS' ],
		'CALLS_TURN_USER'              => [ 'AQ_TURN_USER' ],
		'CALLS_TURN_PASSWORD'          => [ 'AQ_TURN_PASS' ],
		'GOOGLE_SIGNIN_CLIENT_ID'      => [ 'GOOGLE_OAUTH_CLIENT_ID' ],
		'YOUTUBE_SERVICE_ACCOUNT_JSON' => [ 'YOUTUBE_SA_JSON' ],
		'KAGGLE_API_KEY'               => [ 'KAGGLE_KEY' ],
		'BOT_ARTA_TOKEN'               => [ 'AQ_ARTA_REPLY_TOKEN' ],
		'BOT_ARTAMAIL_TOKEN'           => [ 'AQ_ARTAMAIL_TOKEN' ],
		'BOT_ARTASEARCH_TOKEN'         => [ 'AQ_ALUMNI_INGEST_TOKEN' ],
		'BOT_WORKER_TOKEN'             => [ 'AQ_WORKER_TOKEN' ],
		'ARTA_RELAY_URL'               => [ 'AQ_TURN_URL' ],
		'ARTA_TOOLS_URL'               => [ 'AQ_TURN_URL_TOOLS' ],
		'ARTA_SHELL_URL'               => [ 'AQ_SHELL_URL' ],
		'ARTA_BROKER_URL'              => [ 'AQ_BROKER_URL' ],
		'ARTA_RELAY_SECRET'            => [ 'AQ_TURN_SECRET' ],
		'TASK_SYNC_KEY'                => [ 'AQ_TASK_SYNC_KEY' ],
		'FLAG_CASHOUT_FROZEN'          => [ 'AQ_CASHOUT_FROZEN' ],
		'FLAG_ALLOW_PASSWORD_LOGIN'    => [ 'AQ_ALLOW_PASSWORD_LOGIN' ],
	];

	/** Per-tier relay names are built at runtime (Relay: ARTA_RELAY_URL_<TIER>, ARTA_TOOLS_URL_<TIER>). */
	const ALIAS_PREFIXES = [ 'ARTA_TOOLS_URL_' => 'AQ_TURN_URL_TOOLS_', 'ARTA_RELAY_URL_' => 'AQ_TURN_URL_' ];

	/** Names NO code reads any more. A stored value is listed under "Unused — safe to forget", never alarms. */
	const RETIRED = [
		'GOOGLE_OAUTH_CLIENT_SECRET' => 'No server code reads it: Google sign-in needs only the client ID, and the Calendar/Meet integration that used it is gone.',
		'GOOGLE_OAUTH_REFRESH_TOKEN' => 'No server code reads it (the Calendar/Meet integration is gone). Revoke it at myaccount.google.com → Security → Third-party access.',
		'HF_TOKEN'                   => 'HuggingFace was purged on 2026-08-02. Revoke the token at huggingface.co too.',
		'RECAPTCHA_SECRET'           => 'No code reads it — sign-in is email code + Google + passkeys, with no reCAPTCHA check.',
	];

	/** [ canonical, ...old names ] for any name, old or new. */
	public static function names( $name ) {
		$name = (string) $name;
		static $rev = null;
		if ( $rev === null ) {
			$rev = [];
			foreach ( self::ALIASES as $canon => $olds ) { foreach ( $olds as $o ) { $rev[ $o ] = $canon; } }
		}
		$canon = $rev[ $name ] ?? $name;
		if ( ! isset( $rev[ $name ] ) ) {
			foreach ( self::ALIAS_PREFIXES as $new => $old ) {
				// longest old prefix first is guaranteed by the ordering above (TOOLS_ before URL_)
				if ( strpos( $name, $old ) === 0 && strlen( $name ) > strlen( $old ) ) { $canon = $new . substr( $name, strlen( $old ) ); break; }
			}
		}
		$out = [ $canon ];
		foreach ( self::ALIASES[ $canon ] ?? [] as $o ) { $out[] = $o; }
		foreach ( self::ALIAS_PREFIXES as $new => $old ) {
			if ( strpos( $canon, $new ) === 0 && strlen( $canon ) > strlen( $new ) ) { $out[] = $old . substr( $canon, strlen( $new ) ); }
		}
		return array_values( array_unique( $out ) );
	}

	/** The vault row a name resolves to (new name first, then each old name) → [ stored name, row ] or [ '', null ]. */
	private static function row( $name ) {
		$all = self::load()['secrets'];
		foreach ( self::names( $name ) as $n ) {
			if ( isset( $all[ $n ] ) && ! empty( $all[ $n ]['ct'] ) ) { return [ $n, $all[ $n ] ]; }
		}
		$canon = self::names( $name )[0];
		return isset( $all[ $canon ] ) ? [ $canon, $all[ $canon ] ] : [ '', null ];
	}

	/**
	 * Move vault entries stored under an OLD name to the NEW one. The ciphertext is copied as-is (the
	 * encryption key does not depend on the name), with its rotated-at, tail and compromised flag, so
	 * no value is decrypted, re-entered or written anywhere else. When both names hold a value the new
	 * one wins and the old one is left alone, listed as unused. Logged to the Watchdog audit log
	 * (names only), and the vault-file baseline is advanced so the move does not read as tampering.
	 */
	public static function migrate_names() {
		$data = self::load();
		if ( empty( $data['secrets'] ) || ! is_array( $data['secrets'] ) ) { return 0; }
		$moved = [];
		foreach ( array_keys( $data['secrets'] ) as $stored ) {
			$canon = self::names( $stored )[0];
			if ( $canon === $stored ) { continue; }
			if ( isset( $data['secrets'][ $canon ] ) && ! empty( $data['secrets'][ $canon ]['ct'] ) ) { continue; }
			$data['secrets'][ $canon ] = $data['secrets'][ $stored ];
			unset( $data['secrets'][ $stored ] );
			$moved[] = $stored . ' → ' . $canon;
		}
		if ( ! $moved ) { return 0; }
		if ( ! self::persist( $data ) ) { return 0; }
		if ( class_exists( '\\AQ\\Watchdog' ) ) {
			Watchdog::accept_vault_change( 'Vault: renamed ' . count( $moved ) . ' secret(s) to their new names — ' . implode( ', ', $moved ) );
		}
		return count( $moved );
	}

	private static $cache = null;    // parsed vault file (this request)
	private static $plain = [];      // per-request decrypted values

	public static function path() { return WP_CONTENT_DIR . '/' . self::FILE; }

	/** Vault is usable only when real wp-config salts exist — never derive a key from DB-stored salts. */
	public static function available() {
		return function_exists( 'sodium_crypto_secretbox' )
			&& defined( 'AUTH_KEY' ) && defined( 'AUTH_SALT' )
			&& strlen( (string) AUTH_KEY ) >= 32 && strlen( (string) AUTH_SALT ) >= 32;
	}

	private static function key() {
		return hash( 'sha256', AUTH_KEY . '|' . AUTH_SALT . '|aq-vault-v1', true ); // 32 bytes
	}

	private static function load() {
		if ( self::$cache !== null ) { return self::$cache; }
		self::$cache = [ 'v' => 1, 'secrets' => [] ];
		$raw = @file_get_contents( self::path() );
		if ( is_string( $raw ) && ( $pos = strpos( $raw, "\n" ) ) !== false ) {
			$data = json_decode( substr( $raw, $pos + 1 ), true );
			if ( is_array( $data ) && isset( $data['secrets'] ) ) { self::$cache = $data; }
		}
		return self::$cache;
	}

	private static function persist( $data ) {
		$path = self::path();
		$tmp  = $path . '.tmp.' . getmypid();
		$body = self::GUARD . wp_json_encode( $data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
		if ( file_put_contents( $tmp, $body, LOCK_EX ) === false ) { return false; }
		@chmod( $tmp, 0600 );
		$ok = @rename( $tmp, $path );
		if ( ! $ok ) { @unlink( $tmp ); }
		self::$cache = $data;
		self::$plain = [];
		return $ok;
	}

	/** Decrypted vault value, or '' when absent/undecryptable. Called by Secrets::get on every lookup. */
	public static function get( $name ) {
		if ( array_key_exists( $name, self::$plain ) ) { return self::$plain[ $name ]; }
		$out = '';
		[ , $row ] = self::row( $name ); // the new name first, then each old one
		if ( $row && ! empty( $row['ct'] ) && self::available() ) {
			$blob = base64_decode( (string) $row['ct'], true );
			if ( $blob !== false && strlen( $blob ) > SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ) {
				$nonce = substr( $blob, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
				$ct    = substr( $blob, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
				$pt    = @sodium_crypto_secretbox_open( $ct, $nonce, self::key() );
				if ( $pt !== false ) { $out = $pt; }
			}
		}
		return self::$plain[ $name ] = $out;
	}

	/** Store/rotate a secret. Records rotated-at and clears any compromised flag. */
	public static function set( $name, $value ) {
		// CAST BEFORE THE GUARD: a caller passing a non-string falsy — `getenv()` returns FALSE for an
		// unset variable, and that is exactly how a wp-cli one-liner supplies a value — is not `=== ''`,
		// so it slipped past, encrypted an empty string, and returned TRUE. The secret then read back
		// empty while the admin page showed it as freshly rotated: a silent no-op that looks like a save.
		$value = is_scalar( $value ) ? (string) $value : '';
		if ( ! self::available() || $value === '' ) { return false; }
		$nonce = random_bytes( SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		$ct    = sodium_crypto_secretbox( (string) $value, $nonce, self::key() );
		$data  = self::load();
		$name  = self::names( $name )[0];               // always store under the NEW name
		foreach ( array_slice( self::names( $name ), 1 ) as $old ) { unset( $data['secrets'][ $old ] ); } // superseded by this value
		$data['secrets'][ $name ] = [
			'ct'          => base64_encode( $nonce . $ct ),
			'tail'        => strlen( $value ) > 8 ? substr( $value, -4 ) : '', // masked preview only
			'rotated'     => time(),
			'compromised' => 0,
		];
		return self::persist( $data );
	}

	public static function forget( $name ) {
		$data = self::load();
		unset( $data['secrets'][ $name ] );
		return self::persist( $data );
	}

	/** Flag a secret as known-leaked → Watchdog alarms daily until it is rotated. */
	public static function mark_compromised( $name, $flag = true ) {
		$data = self::load();
		[ $stored ] = self::row( $name );
		$name = $stored !== '' ? $stored : self::names( $name )[0];
		if ( ! isset( $data['secrets'][ $name ] ) ) {
			$data['secrets'][ $name ] = [ 'ct' => '', 'tail' => '', 'rotated' => 0, 'compromised' => 0 ];
		}
		$data['secrets'][ $name ]['compromised'] = $flag ? 1 : 0;
		return self::persist( $data );
	}

	/**
	 * Metadata for every known secret (registry ∪ vault), with live source resolution. Never values.
	 * A vault row stored under an OLD name is reported under its NEW name. A row no code reads
	 * (RETIRED, or an old-name copy shadowed by a newer value) comes back with `unused` set, so the
	 * page lists it under "Unused — safe to forget" and nothing alarms on it.
	 */
	public static function meta() {
		$stored = self::load()['secrets'];
		$names  = array_keys( self::REGISTRY );
		$unused = [];
		foreach ( array_keys( $stored ) as $n ) {
			if ( isset( self::RETIRED[ $n ] ) ) { $unused[ $n ] = self::RETIRED[ $n ]; continue; }
			$canon = self::names( $n )[0];
			if ( $canon !== $n ) {
				[ $resolved ] = self::row( $canon );
				if ( $resolved !== $n ) { $unused[ $n ] = 'Old name of ' . $canon . ', which holds its own value — this copy is no longer read.'; continue; }
			}
			$names[] = $canon;
		}
		$names = array_values( array_unique( $names ) );
		$out = [];
		foreach ( $names as $name ) {
			[ , $row ] = self::row( $name );
			$reg  = self::REGISTRY[ $name ] ?? [ '(custom secret — not in the registry; Forget it if nothing outside this site uses it)', 365, true, 'Other' ];
			$opt  = $reg[2] ?? false;                          // false | true | "ALT_SECRET_NAME"
			$alt  = is_string( $opt ) ? $opt : '';
			$out[ $name ] = [
				'desc'        => $reg[0],
				'max_days'    => (int) $reg[1],
				'optional'    => $opt !== false,
				'group'       => $reg[3] ?? 'Other',
				'alt'         => $alt,                          // the secret that covers this one, if any
				'covered'     => $alt !== '' && Secrets::has( $alt ), // alternative is configured
				'in_vault'    => $row && ! empty( $row['ct'] ),
				'tail'        => $row['tail'] ?? '',
				'rotated'     => (int) ( $row['rotated'] ?? 0 ),
				'compromised' => (int) ( $row['compromised'] ?? 0 ) === 1,
				'source'      => Secrets::source( $name ),
				'set'         => Secrets::has( $name ),
				'unused'      => '',
			];
		}
		foreach ( $unused as $name => $why ) {
			$row = $stored[ $name ];
			$out[ $name ] = [
				'desc' => $why, 'max_days' => 0, 'optional' => true, 'group' => 'Unused', 'alt' => '', 'covered' => false,
				'in_vault' => ! empty( $row['ct'] ), 'tail' => $row['tail'] ?? '', 'rotated' => (int) ( $row['rotated'] ?? 0 ),
				'compromised' => false, 'source' => 'vault', 'set' => ! empty( $row['ct'] ), 'unused' => $why,
			];
		}
		return $out;
	}

	// ── ArtaMail Titan secret endpoint ──────────────────────────────────────
	//
	// GET /wp-json/aq/v1/secret/titan — hands ArtaMail (and its live e2e test) the ONE Titan mailbox
	// password and nothing else. There is deliberately no generic secret/{name} route. The secret stays
	// write-only in wp-admin; this is the only way it leaves the server, and only to a holder of the
	// dedicated token.

	/** The ArtaMail token the caller presented: `X-AQ-ArtaMail: <t>` or `Authorization: Bearer <t>`. '' when absent. */
	private static function presented_token() {
		if ( isset( $_SERVER['HTTP_X_AQ_ARTAMAIL'] ) && $_SERVER['HTTP_X_AQ_ARTAMAIL'] !== '' ) {
			return (string) $_SERVER['HTTP_X_AQ_ARTAMAIL'];
		}
		if ( isset( $_SERVER['HTTP_AUTHORIZATION'] ) && preg_match( '/^Bearer\\s+(\\S+)$/', (string) $_SERVER['HTTP_AUTHORIZATION'], $m ) ) {
			return $m[1];
		}
		return '';
	}

	/**
	 * Serve ONLY the Titan password, to a holder of BOT_ARTAMAIL_TOKEN. HTTPS required (plain HTTP
	 * allowed only for local WP_DEBUG dev); response is Cache-Control: no-store; 10 requests/hour/IP;
	 * every hit audited (timestamp via Watchdog, IP, result — never the value). 401 missing token,
	 * 403 bad token / insecure, 404 when the secret is not configured, 429 when rate-limited.
	 */
	public static function rest_titan( $req ) {
		$ip    = isset( $_SERVER['REMOTE_ADDR'] ) ? (string) $_SERVER['REMOTE_ADDR'] : '0';
		$audit = function ( $result ) use ( $ip ) {
			if ( class_exists( '\\AQ\\Watchdog' ) ) { Watchdog::note( "secret/titan {$result} ip={$ip}" ); }
		};
		$reply = function ( $body, $status ) {
			$res = new \WP_REST_Response( $body, $status );
			$res->header( 'Cache-Control', 'no-store' );
			return $res;
		};

		// HTTPS only (allow plain HTTP solely for local WP_DEBUG development).
		$https = is_ssl() || ( isset( $_SERVER['HTTP_X_FORWARDED_PROTO'] ) && strtolower( (string) $_SERVER['HTTP_X_FORWARDED_PROTO'] ) === 'https' );
		if ( ! $https && ! ( defined( 'WP_DEBUG' ) && WP_DEBUG ) ) {
			$audit( 'fail:insecure' );
			return $reply( [ 'error' => 'https_required', 'message' => 'HTTPS is required.' ], 403 );
		}

		// Rate limit (per IP, fixed hourly window) — also caps brute-forcing the token.
		if ( Rest::throttle( 'secret_titan', 10, HOUR_IN_SECONDS ) ) {
			$audit( 'fail:rate' );
			return $reply( [ 'error' => 'rate_limited', 'message' => 'Too many requests.' ], 429 );
		}

		// Dedicated token, constant-time compared. Missing -> 401, present-but-wrong -> 403.
		$want = (string) Secrets::get( 'BOT_ARTAMAIL_TOKEN' );
		$got  = self::presented_token();
		if ( $got === '' ) {
			$audit( 'fail:no-token' );
			return $reply( [ 'error' => 'unauthorized', 'message' => 'Missing access token.' ], 401 );
		}
		if ( strlen( $want ) < 32 || ! hash_equals( $want, $got ) ) {
			$audit( 'fail:bad-token' );
			return $reply( [ 'error' => 'forbidden', 'message' => 'Invalid access token.' ], 403 );
		}

		// The secret itself — 404 when an operator has not set it yet.
		$password = (string) Secrets::get( 'MAIL_TITAN_PASSWORD' );
		if ( $password === '' ) {
			$audit( 'fail:unset' );
			return $reply( [ 'error' => 'not_found', 'message' => 'Titan password is not configured.' ], 404 );
		}

		$audit( 'ok' );
		return $reply( [ 'password' => $password ], 200 );
	}

	// ── wp-admin page (operators only) ──────────────────────────────────────

	public static function admin_menu() {
		add_menu_page(
			'ArtaQuest Security', 'AQ Security', 'manage_options', 'aq-security',
			[ self::class, 'render_page' ], 'dashicons-shield', 59
		);
	}

	/** Handle the page's POST actions (nonce + capability checked), then redirect back. */
	public static function handle_actions() {
		if ( empty( $_POST['aq_vault_action'] ) || ! current_user_can( 'manage_options' ) ) { return; }
		check_admin_referer( 'aq_vault' );
		$action = sanitize_key( (string) $_POST['aq_vault_action'] );
		$name   = strtoupper( preg_replace( '/[^A-Za-z0-9_]/', '', (string) ( $_POST['name'] ?? '' ) ) );
		$msg    = '';
		if ( $name === '' && ! in_array( $action, [ 'rebaseline', 'replant', 'runcheck', 'testalert' ], true ) ) { return; }
		switch ( $action ) {
			case 'set': // set / rotate — value is read raw (secrets may contain anything) and never logged
				$value = (string) wp_unslash( $_POST['value'] ?? '' );
				$msg = $value === '' ? 'empty:' . $name
					: ( self::set( $name, $value ) ? 'rotated:' . $name : 'fail:' . $name );
				if ( strpos( $msg, 'rotated' ) === 0 ) { Watchdog::note( "Secret {$name} rotated via wp-admin by " . wp_get_current_user()->user_login ); }
				break;
			case 'import': // copy the live env/constant value into the vault so rotation tracking starts
				$cur = Secrets::get( $name );
				$msg = $cur === '' ? 'empty:' . $name
					: ( self::set( $name, $cur ) ? 'imported:' . $name : 'fail:' . $name );
				break;
			case 'forget':
				self::forget( $name );
				$msg = 'forgot:' . $name;
				break;
			case 'compromised':
				self::mark_compromised( $name, true );
				$msg = 'flagged:' . $name;
				break;
			case 'clearflag':
				self::mark_compromised( $name, false );
				$msg = 'unflagged:' . $name;
				break;
			case 'rebaseline': Watchdog::rebaseline(); $msg = 'rebaselined'; break;
			case 'replant':    Watchdog::plant_traps( true ); $msg = 'replanted'; break;
			case 'runcheck':   Watchdog::run(); $msg = 'checked'; break;
			case 'testalert':  $msg = 'test alert sent to ' . Watchdog::send_test(); break;
		}
		wp_safe_redirect( add_query_arg( [ 'page' => 'aq-security', 'aq_msg' => rawurlencode( $msg ) ], admin_url( 'admin.php' ) ) );
		exit;
	}

	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) { return; }
		$meta = self::meta();
		$now  = time();

		// ── Roll up the headline numbers for the status cards ────────────
		// Required credentials only (flags AND optional/alternative secrets excluded from the headline counts).
		$secrets = array_filter( $meta, fn( $m ) => $m['max_days'] > 0 && ! $m['optional'] );
		$in_vault = $missing = $overdue = $compromised = 0;
		foreach ( $secrets as $m ) {
			if ( $m['in_vault'] ) { $in_vault++; }
			if ( ! $m['set'] ) { $missing++; }
			if ( $m['compromised'] ) { $compromised++; }
			if ( $m['in_vault'] && $m['rotated'] > 0 && $now - $m['rotated'] > $m['max_days'] * DAY_IN_SECONDS ) { $overdue++; }
		}
		$wd = Watchdog::summary();
		$attention = $missing + $overdue + $compromised + $wd['crit_7d'] + ( Secrets::has( 'FLAG_ALLOW_PASSWORD_LOGIN' ) ? 1 : 0 );

		echo '<div class="wrap aq-sec">';
		echo self::styles();
		// Hero header
		echo '<div class="aq-hero"><div class="aq-mark">A</div><div><div class="aq-title">ArtaQuest Security</div>'
			. '<div class="aq-tag">The single place secrets are stored, rotated, and watched — never the public database</div></div>'
			. '<div class="aq-health ' . ( $attention ? 'warn' : 'ok' ) . '">' . ( $attention ? '⚠ ' . (int) $attention . ' need' . ( $attention === 1 ? 's' : '' ) . ' attention' : '✓ All clear' ) . '</div></div>';

		if ( ! empty( $_GET['aq_msg'] ) ) {
			echo '<div class="notice notice-success is-dismissible"><p>' . esc_html( (string) wp_unslash( $_GET['aq_msg'] ) ) . '</p></div>';
		}
		if ( ! self::available() ) {
			echo '<div class="notice notice-error"><p><strong>Vault unavailable:</strong> this site has no AUTH_KEY / AUTH_SALT constants in wp-config.php (or libsodium is missing). Add real salts to wp-config.php first — the vault refuses to derive its encryption key from database-stored salts, because the database is public.</p></div>';
		}

		// Status cards
		echo '<div class="aq-cards">';
		echo self::card( 'In vault', $in_vault . '<span class="aq-of">/' . count( $secrets ) . '</span>', 'encrypted secrets', $in_vault >= count( $secrets ) ? 'ok' : 'info' );
		echo self::card( 'Missing', (string) $missing, 'unconfigured', $missing ? 'bad' : 'ok' );
		echo self::card( 'Rotation due', (string) ( $overdue + $compromised ), $compromised ? $compromised . ' compromised' : 'past policy age', ( $overdue + $compromised ) ? 'bad' : 'ok' );
		echo self::card( 'Traps armed', $wd['traps_armed'] . '<span class="aq-of">/' . $wd['traps_total'] . '</span>', 'DB honeypots', $wd['traps_armed'] >= $wd['traps_total'] ? 'ok' : 'bad' );
		echo self::card( 'Alarms (7d)', (string) $wd['crit_7d'], 'critical events', $wd['crit_7d'] ? 'bad' : 'ok' );
		echo self::card( 'Last sweep', $wd['last_run'] ? esc_html( human_time_diff( $wd['last_run'] ) ) : '—', $wd['last_run'] ? 'ago' : 'never run', $wd['last_run'] && $now - $wd['last_run'] < 2 * HOUR_IN_SECONDS ? 'ok' : 'info' );
		echo '</div>';

		echo '<p class="aq-lead">Values are <strong>write-only</strong> here, encrypted on disk with the wp-config salts, and <strong>never touch the database</strong> (the whole DB is public at <code>/data/</code>). Saving takes effect immediately and overrides any environment variable or wp-config constant.</p>';

		// ── Secrets table ────────────────────────────────────────────────
		echo '<h2 class="aq-h">Secrets</h2>';
		echo '<table class="aq-table"><thead><tr><th>Secret</th><th>Status</th><th>Source</th><th>Rotation</th><th class="aq-act-col">Manage</th></tr></thead><tbody>';
		// Grouped by purpose, in registry order; anything unregistered last; unused in its own section.
		$order = [];
		foreach ( self::REGISTRY as $r ) { $order[ $r[3] ?? 'Other' ] = count( $order ); }
		$order['Other'] = count( $order );
		$unused = array_filter( $meta, fn( $m ) => $m['unused'] !== '' );
		$listed = array_filter( $meta, fn( $m ) => $m['unused'] === '' );
		$pos    = array_flip( array_keys( self::REGISTRY ) );
		uksort( $listed, function ( $a, $b ) use ( $listed, $order, $pos ) {
			$ga = $order[ $listed[ $a ]['group'] ] ?? 99; $gb = $order[ $listed[ $b ]['group'] ] ?? 99;
			if ( $ga !== $gb ) { return $ga <=> $gb; }
			return ( $pos[ $a ] ?? 999 ) <=> ( $pos[ $b ] ?? 999 ) ?: strcmp( $a, $b );
		} );
		$group = null;
		foreach ( $listed as $name => $m ) {
			if ( $m['group'] !== $group ) {
				$group = $m['group'];
				echo '<tr class="aq-group"><td colspan="5">' . esc_html( $group ) . '</td></tr>';
			}
			$is_flag = $m['max_days'] === 0;
			// status pill — optional/alternative credentials never read as an alarming "missing"
			if ( $m['compromised'] ) { $status = self::pill( 'compromised', 'bad' ); }
			elseif ( ! $m['set'] ) {
				$status = ( $is_flag || $m['optional'] ) ? self::pill( $m['optional'] ? 'optional' : 'unset', 'mute' ) : self::pill( 'missing', 'bad' );
			}
			else { $status = self::pill( 'set', 'ok' ) . ( $m['tail'] !== '' ? ' <code class="aq-tail">…' . esc_html( $m['tail'] ) . '</code>' : '' ); }
			// rotation cell
			if ( $is_flag ) {
				$rot = '<span class="aq-muted">' . ( strpos( $name, 'FLAG_' ) === 0 ? 'flag' : 'not a credential' ) . ' — no rotation</span>';
			} elseif ( ! $m['set'] && $m['optional'] ) {
				$rot = '<span class="aq-muted">not required' . ( $m['covered'] ? ' — covered by ' . esc_html( $m['alt'] ) : '' ) . '</span>';
			} elseif ( $m['in_vault'] && $m['rotated'] ) {
				$age = (int) floor( ( $now - $m['rotated'] ) / DAY_IN_SECONDS );
				$due = $age > $m['max_days'];
				$rot = '<span class="' . ( $due ? 'aq-bad' : 'aq-muted' ) . '">' . esc_html( gmdate( 'Y-m-d', $m['rotated'] ) ) . ' · ' . $age . 'd';
				$rot .= $due ? ' · overdue (>' . (int) $m['max_days'] . 'd)' : ' · policy ' . (int) $m['max_days'] . 'd';
				$rot .= '</span>';
			} elseif ( $m['set'] ) {
				$rot = '<span class="aq-warn">untracked — import to start the clock</span>';
			} else {
				$rot = '<span class="aq-muted">—</span>';
			}
			$src = $m['source'] ? self::pill( $m['source'], $m['source'] === 'vault' ? 'brand' : 'mute' ) : '<span class="aq-muted">—</span>';

			echo '<tr><td><code class="aq-name">' . esc_html( $name ) . '</code><div class="aq-desc">' . esc_html( $m['desc'] ) . '</div></td>'
				. '<td>' . $status . '</td><td>' . $src . '</td><td>' . $rot . '</td><td class="aq-act">';
			echo '<form method="post" class="aq-rotate">' . wp_nonce_field( 'aq_vault', '_wpnonce', true, false )
				. '<input type="hidden" name="aq_vault_action" value="set"><input type="hidden" name="name" value="' . esc_attr( $name ) . '">'
				. '<input type="password" name="value" placeholder="new value" autocomplete="new-password">'
				. ' <button class="button button-primary">' . ( $m['in_vault'] ? 'Rotate' : 'Set' ) . '</button></form>';
			$more = '';
			if ( $m['set'] && ! $m['in_vault'] ) { $more .= self::inline_action( $name, 'import', 'Import' ); }
			if ( $m['in_vault'] ) { $more .= self::inline_action( $name, 'forget', 'Forget', true ); }
			$more .= $m['compromised'] ? self::inline_action( $name, 'clearflag', 'Clear flag' ) : self::inline_action( $name, 'compromised', 'Flag leaked' );
			echo '<div class="aq-more">' . $more . '</div></td></tr>';
		}
		echo '</tbody></table>';

		// Unused — stored values no code reads any more. Nothing alarms on them; Forget removes the row.
		if ( $unused ) {
			echo '<h2 class="aq-h">Unused — safe to forget <span class="aq-sub">stored values that no code reads any more</span></h2>';
			echo '<table class="aq-table"><tbody>';
			foreach ( $unused as $name => $m ) {
				echo '<tr><td><code class="aq-name">' . esc_html( $name ) . '</code><div class="aq-desc">' . esc_html( $m['unused'] ) . '</div></td>'
					. '<td>' . ( $m['rotated'] ? '<span class="aq-muted">stored ' . esc_html( gmdate( 'Y-m-d', $m['rotated'] ) ) . '</span>' : '' ) . '</td>'
					. '<td class="aq-act">' . self::inline_action( $name, 'forget', 'Forget' , true ) . '</td></tr>';
			}
			echo '</tbody></table>';
		}

		// add-custom
		echo '<form method="post" class="aq-add">' . wp_nonce_field( 'aq_vault', '_wpnonce', true, false )
			. '<input type="hidden" name="aq_vault_action" value="set">'
			. '<input type="text" name="name" placeholder="NEW_SECRET_NAME" class="aq-newname"> '
			. '<input type="password" name="value" placeholder="value" autocomplete="new-password" class="aq-newval"> '
			. '<button class="button">Add secret</button></form>';

		Watchdog::render_status();
		echo '</div>';
	}

	private static function card( $label, $value, $sub, $tone = 'info' ) {
		return '<div class="aq-card ' . esc_attr( $tone ) . '"><div class="aq-card-l">' . esc_html( $label ) . '</div>'
			. '<div class="aq-card-v">' . $value . '</div><div class="aq-card-s">' . esc_html( $sub ) . '</div></div>';
	}

	private static function pill( $text, $tone = 'mute' ) {
		return '<span class="aq-pill ' . esc_attr( $tone ) . '">' . esc_html( $text ) . '</span>';
	}

	private static function inline_action( $name, $action, $label, $confirm = false ) {
		$js = $confirm ? ' onsubmit="return confirm(\'Remove ' . esc_js( $name ) . ' from the vault?\')"' : '';
		return '<form method="post"' . $js . '>' . wp_nonce_field( 'aq_vault', '_wpnonce', true, false )
			. '<input type="hidden" name="aq_vault_action" value="' . esc_attr( $action ) . '"><input type="hidden" name="name" value="' . esc_attr( $name ) . '">'
			. '<button class="button button-small button-link aq-link">' . esc_html( $label ) . '</button></form>';
	}

	/** Scoped styling — brand gold/blue on the dark hero; the rest stays native-admin clean. */
	private static function styles() {
		return '<style>
		.aq-sec{max-width:1180px}
		.aq-hero{display:flex;align-items:center;gap:16px;background:linear-gradient(120deg,#010C17,#0C1E32);border:1px solid #16324f;border-radius:12px;padding:18px 22px;margin:14px 0 20px;color:#eaf1f9}
		.aq-mark{width:44px;height:44px;border-radius:50%;border:3px solid #2352E8;color:#E8B923;font:700 24px/38px Georgia,serif;text-align:center;flex:none}
		.aq-title{font-size:20px;font-weight:700;letter-spacing:.2px}
		.aq-tag{font-size:13px;color:#9db4cc;margin-top:2px}
		.aq-health{margin-left:auto;font-weight:700;font-size:13px;padding:7px 14px;border-radius:999px}
		.aq-health.ok{background:rgba(35,82,232,.18);color:#9db9ff;border:1px solid #2352E8}
		.aq-health.warn{background:rgba(232,185,35,.16);color:#E8B923;border:1px solid #E8B923}
		.aq-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 0 18px}
		.aq-card{background:#fff;border:1px solid #dcdfe4;border-left-width:4px;border-radius:8px;padding:12px 14px}
		.aq-card-l{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6a7280;font-weight:600}
		.aq-card-v{font-size:26px;font-weight:700;line-height:1.1;margin:2px 0;color:#0C1E32}
		.aq-card-v .aq-of{font-size:15px;color:#9aa3ad;font-weight:600}
		.aq-card-s{font-size:12px;color:#6a7280}
		.aq-card.ok{border-left-color:#2352E8}.aq-card.bad{border-left-color:#b32d2e}.aq-card.info{border-left-color:#E8B923}
		.aq-lead{max-width:880px;color:#3c434a;font-size:13.5px}
		.aq-h{font-size:16px;margin:24px 0 8px}.aq-h .aq-sub{font-weight:400;font-size:13px;color:#6a7280}
		.aq-h3{font-size:14px;margin:20px 0 8px}
		.aq-table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dcdfe4;border-radius:8px;overflow:hidden}
		.aq-table th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#6a7280;background:#f6f7f8;padding:9px 12px;border-bottom:1px solid #dcdfe4}
		.aq-table td{padding:11px 12px;border-bottom:1px solid #eef0f2;vertical-align:top}
		.aq-table tr:last-child td{border-bottom:0}
		.aq-table tr.aq-group td{background:#f6f7f8;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#0C1E32;padding:7px 12px}
		.aq-name{font-size:13px;font-weight:600;background:none;padding:0;color:#0C1E32}
		.aq-desc{font-size:12px;color:#6a7280;margin-top:3px;max-width:320px}
		.aq-tail{background:#f0f2f4;border-radius:4px;padding:1px 5px;font-size:12px}
		.aq-pill{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;padding:2px 9px;border-radius:999px}
		.aq-pill.ok{background:rgba(35,82,232,.12);color:#2352E8}
		.aq-pill.brand{background:rgba(232,185,35,.18);color:#9a7400}
		.aq-pill.bad{background:rgba(179,45,46,.12);color:#b32d2e}
		.aq-pill.mute{background:#eef0f2;color:#6a7280}
		.aq-muted{color:#9aa3ad;font-size:12.5px}.aq-bad{color:#b32d2e;font-weight:600;font-size:12.5px}.aq-warn{color:#9a7400;font-size:12.5px}
		.aq-act-col{min-width:300px}
		.aq-act form{display:inline-block}
		.aq-rotate input[type=password]{width:140px;height:30px}
		.aq-more{margin-top:6px;display:flex;gap:2px;flex-wrap:wrap}
		.aq-link{color:#2352E8!important;text-decoration:none;padding:0 6px!important}
		.aq-add{margin:14px 0 4px;display:flex;gap:8px;align-items:center}
		.aq-newname{width:230px;text-transform:uppercase}.aq-newval{width:300px}
		.aq-actions{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 4px}.aq-actions form{display:inline-block}
		.aq-log{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dcdfe4;border-radius:8px;overflow:hidden;font-size:13px}
		.aq-log td{padding:8px 12px;border-bottom:1px solid #eef0f2}.aq-log tr:last-child td{border-bottom:0}
		.aq-when{white-space:nowrap;color:#9aa3ad;font-size:12px;width:160px}
		.aq-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;vertical-align:middle}
		.aq-dot.crit{background:#b32d2e}.aq-dot.ok{background:#2352E8}.aq-dot.info{background:#E8B923}
		</style>';
	}
}
