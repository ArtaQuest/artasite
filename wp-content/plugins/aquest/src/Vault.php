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
 * WHICH secrets exist, what each is for, who reads it and how often it rotates is defined ONCE in
 * SecretRegistry (and generated into docs/SECRETS.md). This class only stores and shows them.
 *
 * The admin page is WRITE-ONLY for values: it shows existence, source, age and the last 4
 * characters — never a full secret. Rotation metadata (rotated-at, compromised flag) lives in
 * the vault file too, and Watchdog::check_rotation raises the alarms when a key is overdue.
 */
final class Vault {

	const FILE = 'aq-vault.php'; // under WP_CONTENT_DIR
	const GUARD = "<?php http_response_code(404); exit; // ArtaQuest vault — managed from wp-admin → ArtaQuest Security ?>\n";

	/** [ new name, ...old names ] — see SecretRegistry::names (kept here for callers that use the vault directly). */
	public static function names( $name ) { return SecretRegistry::names( $name ); }

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
	 * Headline numbers for the AQ Security cards, from meta() (so they use the CURRENT names and the
	 * registry's tiers — the same rule Watchdog::check_rotation alarms on). Unused rows never count.
	 *   in_vault    — configured values stored encrypted in the vault
	 *   set         — configured values from any source (vault, env, wp-config)
	 *   missing     — required keys unset, plus either/or pairs with neither side set (counted once)
	 *   overdue     — vault values older than their tier's rotation clock (identifiers/flags never)
	 *   compromised — values flagged leaked
	 */
	public static function tally( array $meta, $now ) {
		$t = [ 'in_vault' => 0, 'set' => 0, 'missing' => 0, 'overdue' => 0, 'compromised' => 0, 'overdue_names' => [], 'missing_names' => [] ];
		foreach ( $meta as $name => $m ) {
			if ( ( $m['unused'] ?? '' ) !== '' ) { continue; }
			if ( $m['in_vault'] ) { $t['in_vault']++; }
			if ( $m['set'] ) { $t['set']++; }
			if ( $m['compromised'] ) { $t['compromised']++; }
			if ( ! $m['set'] ) {
				$alt = (string) ( $m['alt'] ?? '' );
				if ( ! $m['optional'] || ( $alt !== '' && ! $m['covered'] && strcmp( $name, $alt ) < 0 ) ) {
					$t['missing']++; $t['missing_names'][] = $alt !== '' ? "$name or $alt" : $name;
				}
			}
			if ( $m['in_vault'] && $m['max_days'] > 0 && $m['rotated'] > 0 && ! $m['compromised']
				&& $now - $m['rotated'] > $m['max_days'] * DAY_IN_SECONDS ) {
				$t['overdue']++; $t['overdue_names'][] = $name;
			}
		}
		return $t;
	}

	/**
	 * Remove every vault row that no code reads (meta() marks them `unused`). Names only are returned
	 * for the audit log; nothing registered, and nothing a current name resolves to, is touched.
	 */
	public static function forget_unused() {
		$gone = [];
		foreach ( self::meta() as $name => $m ) {
			if ( $m['unused'] === '' ) { continue; }
			self::forget( $name );
			$gone[] = $name;
		}
		return $gone;
	}

	/**
	 * Metadata for every known secret (registry ∪ vault), with live source resolution. Never values.
	 * A vault row stored under an OLD name is reported under its NEW name. A row no code reads
	 * (RETIRED, or an old-name copy shadowed by a newer value) comes back with `unused` set, so the
	 * page lists it under "Unused — safe to forget" and nothing alarms on it.
	 */
	public static function meta() {
		$stored = self::load()['secrets'];
		$names  = array_keys( SecretRegistry::KEYS );
		$unused = [];
		foreach ( array_keys( $stored ) as $n ) {
			if ( isset( SecretRegistry::RETIRED[ $n ] ) ) { $unused[ $n ] = SecretRegistry::RETIRED[ $n ]; continue; }
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
			$sp   = SecretRegistry::spec( $name );
			$out[ $name ] = [
				'desc'        => $sp['desc'],
				'max_days'    => $sp['days'],
				'tier'        => $sp['tier'],
				'optional'    => $sp['need'] !== 'required',
				'group'       => $sp['group'],
				'used_by'     => $sp['used_by'],
				'alt'         => $sp['alt'],                     // the secret that covers this one, if any
				'covered'     => $sp['alt'] !== '' && Secrets::has( $sp['alt'] ), // alternative is configured
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
				'desc' => $why, 'max_days' => 0, 'tier' => 'none', 'optional' => true, 'group' => 'Unused', 'used_by' => '', 'alt' => '', 'covered' => false,
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
		if ( $name === '' && ! in_array( $action, [ 'rebaseline', 'replant', 'runcheck', 'testalert', 'forget_unused' ], true ) ) { return; }
		$who = wp_get_current_user()->user_login;
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
				Watchdog::accept_vault_change( "Secret {$name} forgotten via wp-admin by {$who}" );
				$msg = 'forgot:' . $name;
				break;
			case 'forget_unused': // one click: every row NO code reads (RETIRED, or an old name shadowed by its new one)
				$gone = self::forget_unused();
				if ( $gone ) { Watchdog::accept_vault_change( 'Vault: forgot ' . count( $gone ) . " unused secret(s) via wp-admin by {$who} — " . implode( ', ', $gone ) ); }
				$msg = 'forgot ' . count( $gone ) . ' unused';
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
		$t = self::tally( $meta, $now );
		[ $in_vault, $set_total, $missing, $overdue, $compromised ] = [ $t['in_vault'], $t['set'], $t['missing'], $t['overdue'], $t['compromised'] ];
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
		echo self::card( 'In vault', $in_vault . '<span class="aq-of">/' . $set_total . '</span>', 'of the configured values', $in_vault >= $set_total ? 'ok' : 'info' );
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
		foreach ( array_keys( SecretRegistry::GROUPS ) as $g ) { $order[ $g ] = count( $order ); }
		$order['Other'] = count( $order );
		$unused = array_filter( $meta, fn( $m ) => $m['unused'] !== '' );
		$listed = array_filter( $meta, fn( $m ) => $m['unused'] === '' );
		$pos    = array_flip( array_keys( SecretRegistry::KEYS ) );
		uksort( $listed, function ( $a, $b ) use ( $listed, $order, $pos ) {
			$ga = $order[ $listed[ $a ]['group'] ] ?? 99; $gb = $order[ $listed[ $b ]['group'] ] ?? 99;
			if ( $ga !== $gb ) { return $ga <=> $gb; }
			return ( $pos[ $a ] ?? 999 ) <=> ( $pos[ $b ] ?? 999 ) ?: strcmp( $a, $b );
		} );
		$group = null;
		foreach ( $listed as $name => $m ) {
			if ( $m['group'] !== $group ) {
				$group = $m['group'];
				$gdesc = SecretRegistry::GROUPS[ $group ] ?? '';
				echo '<tr class="aq-group"><td colspan="5">' . esc_html( $group ) . ( $gdesc !== '' ? ' <span class="aq-gdesc">— ' . esc_html( $gdesc ) . '</span>' : '' ) . '</td></tr>';
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
				$rot = '<span class="aq-muted">' . ( $m['group'] === 'Flags' ? 'flag' : 'not a credential' ) . ' — no rotation</span>';
			} elseif ( ! $m['set'] && $m['optional'] ) {
				$rot = '<span class="aq-muted">not required' . ( $m['covered'] ? ' — covered by ' . esc_html( $m['alt'] ) : '' ) . '</span>';
			} elseif ( $m['in_vault'] && $m['rotated'] ) {
				$age = (int) floor( ( $now - $m['rotated'] ) / DAY_IN_SECONDS );
				$due = $age > $m['max_days'];
				$rot = '<span class="' . ( $due ? 'aq-bad' : 'aq-muted' ) . '">' . esc_html( gmdate( 'Y-m-d', $m['rotated'] ) ) . ' · ' . $age . 'd';
				$rot .= $due ? ' · overdue (>' . (int) $m['max_days'] . 'd)' : ' · ' . esc_html( $m['tier'] ) . ', every ' . (int) $m['max_days'] . 'd';
				$rot .= '</span>';
			} elseif ( $m['set'] ) {
				$rot = '<span class="aq-warn">untracked — import to start the clock</span>';
			} else {
				$rot = '<span class="aq-muted">—</span>';
			}
			$src = $m['source'] ? self::pill( $m['source'], $m['source'] === 'vault' ? 'brand' : 'mute' ) : '<span class="aq-muted">—</span>';

			echo '<tr><td><code class="aq-name">' . esc_html( $name ) . '</code><div class="aq-desc">' . esc_html( $m['desc'] ) . '</div>'
				. ( $m['used_by'] !== '' ? '<div class="aq-desc aq-used">Used by: ' . esc_html( $m['used_by'] ) . '</div>' : '' ) . '</td>'
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
			echo '<h2 class="aq-h">Unused — safe to forget <span class="aq-sub">stored values that no production code reads</span></h2>';
			echo '<form method="post" onsubmit="return confirm(\'Forget all ' . count( $unused ) . ' unused secrets? Each name is written to the audit log.\')">' . wp_nonce_field( 'aq_vault', '_wpnonce', true, false )
				. '<input type="hidden" name="aq_vault_action" value="forget_unused"><button class="button">Forget all unused (' . count( $unused ) . ')</button></form>';
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
		.aq-table tr.aq-group .aq-gdesc{font-weight:400;text-transform:none;letter-spacing:0;color:#50575e}
		.aq-table tr.aq-group td{background:#f6f7f8;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#0C1E32;padding:7px 12px}
		.aq-name{font-size:13px;font-weight:600;background:none;padding:0;color:#0C1E32}
		.aq-desc{font-size:12px;color:#6a7280;margin-top:3px;max-width:320px}
		.aq-used{font-size:11px;color:#8a919a}
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
