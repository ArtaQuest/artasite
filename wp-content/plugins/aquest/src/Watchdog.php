<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * The security WATCHDOG — alarms + traps for a platform whose entire database is public.
 *
 * Threat model: the DB is open by design (Extra::db), so "secrecy of data" is not a defence.
 * What we defend is INTEGRITY (nobody writes to our DB or takes the site over without us
 * noticing) and CREDENTIALS (secrets never sit in the DB; the ones in the vault rotate on a
 * clock). Every baseline this class compares against lives in a gitignored FILE
 * (wp-content/aq-watchdog-state.php) — an attacker with full DB write access still cannot
 * forge a baseline, suppress a throttle, or silence an alarm, because none of that state is
 * in the database.
 *
 * Alarms (email to OPERATOR + bell notification to every administrator, per-key throttled):
 *   1. HONEYTRAPS — decoy "secrets" planted in the public wp_options (they look like exactly
 *      what an attacker scraping /data would hope to find). Two tripwires:
 *        - USE: any REST request presenting a trap value (worker header, bearer token, or a
 *          token/key/secret param) → instant CRITICAL alert with IP + UA, request rejected.
 *        - WRITE: a trap option changed or deleted ⇒ someone has direct DB write access ⇒
 *          CRITICAL alert (this is the cheap canary for "our DB got hijacked").
 *   2. ADMIN ROSTER — any change to the set of administrators (id/login/email/password hash)
 *      alerts; promotions via set_user_role alert instantly, direct-SQL edits within the hour.
 *   3. CRITICAL OPTIONS — siteurl/home/admin_email/active_plugins/user_roles/… changes alert.
 *   4. LEDGER IMMUTABILITY — the money/points/fund ledgers are append-only; per-table
 *      checkpoints (max id, COUNT, SUM) prove historical rows were never edited or deleted.
 *   5. SECRET-LEAK SCAN — the public DB must never contain a real credential; wp_options is
 *      swept for key-shaped values (sk_live_, sk-ant-, whsec_, AKIA, PEM blocks, …).
 *   6. ROTATION ALARMS — vault keys past their policy age, keys flagged compromised, and the
 *      AQ_ALLOW_PASSWORD_LOGIN escape hatch being set all raise alarms (see Vault).
 *   7. PASSWORD-PROBE TRAP — password logins are disabled (Auth::harden); anyone *attempting*
 *      one against an administrator account is probing with scraped material → alert.
 */
final class Watchdog {

	const FILE  = 'aq-watchdog-state.php'; // under WP_CONTENT_DIR — gitignored, never deployed
	const GUARD = "<?php http_response_code(404); exit; // ArtaQuest watchdog state ?>\n";

	/** Decoy secret options planted in the PUBLIC database. Juicy names, worthless values. */
	const TRAPS = [ 'aq_internal_admin_key', 'aq_worker_token_backup', 'aq_db_signing_secret' ];

	/** Options whose change should always raise an alarm (prefix-relative names resolved live). */
	const CRITICAL_OPTIONS = [ 'siteurl', 'home', 'admin_email', 'users_can_register', 'default_role', 'template', 'stylesheet', 'active_plugins' ];

	/** Append-only ledgers → the column whose prefix-SUM must never change. */
	const LEDGERS = [ 'aq_coin_ledger' => 'delta', 'aq_points_ledger' => 'delta', 'aq_fund_ledger' => 'cents' ];

	const THROTTLE = 6 * HOUR_IN_SECONDS; // min interval between identical alert emails

	private static $state = null;

	// ── Wiring (called from aquest.php) ─────────────────────────────────────

	public static function boot() {
		Mailer::boot(); // the mail channel every alarm below (and all member email) rides on
		add_action( 'aq_watchdog', [ self::class, 'run' ] );
		add_action( 'admin_init', [ self::class, 'heartbeat_guard' ] );
		add_filter( 'rest_pre_dispatch', [ self::class, 'trap_probe' ], 0, 3 );
		add_filter( 'authenticate', [ self::class, 'password_probe' ], 5, 3 ); // observe-only; Auth blocks at 30
		add_action( 'set_user_role', [ self::class, 'role_change' ], 10, 3 );
		add_action( 'updated_option', [ self::class, 'option_change' ], 10, 1 );
		add_action( 'deleted_option', [ self::class, 'option_change' ], 10, 1 );
	}

	// ── State file (never the DB — see class doc) ───────────────────────────

	public static function path() { return WP_CONTENT_DIR . '/' . self::FILE; }

	private static function state() {
		if ( self::$state !== null ) { return self::$state; }
		self::$state = [ 'v' => 1, 'traps' => [], 'baselines' => [], 'ledgers' => [], 'throttle' => [], 'log' => [], 'last_run' => 0 ];
		$raw = @file_get_contents( self::path() );
		if ( is_string( $raw ) && ( $pos = strpos( $raw, "\n" ) ) !== false ) {
			$data = json_decode( substr( $raw, $pos + 1 ), true );
			if ( is_array( $data ) && isset( $data['v'] ) ) { self::$state = $data + self::$state; }
		}
		return self::$state;
	}

	private static function save() {
		$path = self::path();
		$tmp  = $path . '.tmp.' . getmypid();
		$body = self::GUARD . wp_json_encode( self::$state, JSON_UNESCAPED_SLASHES );
		if ( file_put_contents( $tmp, $body, LOCK_EX ) !== false ) {
			@chmod( $tmp, 0600 );
			@rename( $tmp, $path );
		}
	}

	// ── Alarms ───────────────────────────────────────────────────────────────

	/**
	 * Raise an alarm: email the operator + push a bell notification to every administrator.
	 * Throttled per key so a persisting condition emails at most every THROTTLE seconds; the
	 * throttle ledger lives in the state FILE, so a DB attacker can't pre-fill it to mute us.
	 * In a DEV environment delivery is suppressed (the event is still logged) — see is_dev_env().
	 */
	public static function alert( $key, $subject, $body, $critical = false ) {
		$s    = self::state();
		$last = (int) ( $s['throttle'][ $key ] ?? 0 );
		self::note( ( $critical ? 'CRITICAL: ' : '' ) . $subject );
		// Dev environments (Studio reports 'local') trip these alarms constantly as a side effect of
		// ordinary work — reconfiguring siteurl/home, editing PHP in place, seeding test data — so the
		// email + bell delivery is pure inbox noise there. The audit log above still records the event;
		// we just don't DELIVER it. Production (the default) and staging are unaffected and alert as before.
		if ( self::is_dev_env() ) { self::save(); return; }
		if ( time() - $last < self::THROTTLE ) { self::save(); return; }
		self::$state['throttle'][ $key ] = time();
		self::save();
		$tag = $critical ? '🚨 [ArtaQuest SECURITY]' : '⚠️ [ArtaQuest security]';
		Mailer::send( 'security_alert', Mailer::operator(), [ 'tag' => $tag, 'subject' => $subject, 'body' => $body ] );
		foreach ( get_users( [ 'role' => 'administrator', 'fields' => 'ID' ] ) as $uid ) {
			Notify::push( (int) $uid, 'security', $subject, $body, '/wp-admin/admin.php?page=aq-security', 'sec:' . $key . ':' . gmdate( 'Ymd' ) );
		}
	}

	/**
	 * Whether this is a DEVELOPMENT environment, where automatic security alarms are suppressed.
	 * Studio (local dev) reports 'local'; an explicit 'development' counts too. Dev trips these
	 * alarms constantly as a side effect of normal work, so delivering them is just noise. 'production'
	 * is wp_get_environment_type()'s default when WP_ENVIRONMENT_TYPE is unset, so a real site never
	 * silences itself by accident; staging — a deploy target — keeps alerting too. Shared with Integrity,
	 * whose alarms ride this same channel. NOTE: the manual send_test() below deliberately ignores this,
	 * so an operator can still confirm the alert channel from any environment.
	 */
	public static function is_dev_env() {
		$env = wp_get_environment_type();
		return $env === 'local' || $env === 'development';
	}

	/** Fire a real alert end-to-end (email + every admin's bell), bypassing the throttle, so the
	 *  operator can confirm delivery works. Returns the recipient for the admin-page confirmation. */
	public static function send_test() {
		$who = wp_get_current_user();
		$body = "This is a TEST alert from the ArtaQuest security watchdog, triggered manually by "
			. ( $who ? $who->user_login : 'an operator' ) . " from wp-admin → AQ Security.\n\n"
			. "If you received this email AND see a notification on your bell, the alarm channel works — "
			. "real tamper/trap/rotation alarms will reach you the same way. No action needed.";
		self::note( 'Test alert sent by ' . ( $who ? $who->user_login : '?' ) );
		Mailer::send( 'security_test', Mailer::operator(), [ 'by' => $who ? $who->user_login : 'an operator' ] );
		foreach ( get_users( [ 'role' => 'administrator', 'fields' => 'ID' ] ) as $uid ) {
			Notify::push( (int) $uid, 'security', 'Security watchdog: test alert', $body,
				'/wp-admin/admin.php?page=aq-security', 'sec:test:' . wp_generate_password( 8, false ) );
		}
		return Mailer::operator();
	}

	/** Append a line to the watchdog's audit log (shown on the admin page; kept in the state file). */
	public static function note( $line ) {
		self::state();
		self::$state['log'][] = [ 't' => time(), 'm' => mb_substr( (string) $line, 0, 300 ) ];
		self::$state['log'] = array_slice( self::$state['log'], -60 );
		self::save();
	}

	// ── Honeytraps ───────────────────────────────────────────────────────────

	/** Plant (or replant) the decoy secrets in the public options table; remember them in the file. */
	public static function plant_traps( $force = false ) {
		$s = self::state();
		foreach ( self::TRAPS as $name ) {
			if ( ! $force && ! empty( $s['traps'][ $name ] ) && get_option( $name ) === $s['traps'][ $name ] ) { continue; }
			$value = 'aqk_' . bin2hex( random_bytes( 24 ) ); // looks like a real internal key
			update_option( $name, $value, true );            // autoloaded → free to verify each run
			self::$state['traps'][ $name ] = $value;
		}
		self::save();
	}

	/** WRITE tripwire: a trap option that changed/disappeared means direct DB write access. */
	private static function check_traps() {
		$s = self::state();
		foreach ( (array) $s['traps'] as $name => $value ) {
			$live = get_option( $name, null );
			if ( $live !== $value ) {
				self::alert( 'trap_write_' . $name, 'DB write tripwire: decoy option touched',
					"The canary option `{$name}` was " . ( $live === null ? 'DELETED' : 'MODIFIED' ) . " outside this plugin.\n"
					. "Nothing legitimate ever writes it — someone (or some code) has direct write access to the database.\n"
					. "Audit recent changes NOW, rotate all secrets from wp-admin → AQ Security, and check active sessions.", true );
				// Replant a fresh decoy so the tripwire re-arms (and the attacker's value doesn't linger).
				$fresh = 'aqk_' . bin2hex( random_bytes( 24 ) );
				update_option( $name, $fresh, true );
				self::$state['traps'][ $name ] = $fresh;
				self::save();
			}
		}
	}

	/** USE tripwire: any REST request presenting a trap value gets logged, alarmed, and rejected. */
	public static function trap_probe( $result, $server, $request ) {
		$s = self::state();
		if ( empty( $s['traps'] ) ) { return $result; }
		$presented = array_filter( [
			(string) ( $_SERVER['HTTP_X_AQ_WORKER'] ?? '' ),
			preg_replace( '/^Bearer\s+/i', '', (string) ( $_SERVER['HTTP_AUTHORIZATION'] ?? '' ) ),
			(string) ( $request->get_param( 'token' ) ?? '' ),
			(string) ( $request->get_param( 'key' ) ?? '' ),
			(string) ( $request->get_param( 'secret' ) ?? '' ),
			(string) ( $request->get_param( 'api_key' ) ?? '' ),
		] );
		if ( ! $presented ) { return $result; }
		foreach ( $presented as $cand ) {
			foreach ( $s['traps'] as $name => $value ) {
				if ( $value !== '' && hash_equals( $value, $cand ) ) {
					$ip = (string) ( $_SERVER['REMOTE_ADDR'] ?? '?' );
					$ua = (string) ( $_SERVER['HTTP_USER_AGENT'] ?? '?' );
					self::alert( 'trap_use_' . $name, 'Honeytrap credential USED — scraped-DB attack in progress',
						"A request just presented the decoy credential `{$name}` (plantable only by reading our public DB).\n"
						. 'Route: ' . $request->get_route() . "\nIP: {$ip}\nUser-Agent: {$ua}\n"
						. "The request was rejected. Whoever sent it is actively probing with data scraped from /data — "
						. 'verify the real secrets are vault-only and recently rotated.', true );
					return new \WP_Error( 'forbidden', 'Invalid credential.', [ 'status' => 403 ] );
				}
			}
		}
		return $result;
	}

	/** Observe-only authenticate filter: an attempted PASSWORD login on an admin = a probe. */
	public static function password_probe( $user, $username, $password ) {
		if ( $password !== '' && $username !== '' && ! Secrets::has( 'AQ_ALLOW_PASSWORD_LOGIN' ) ) {
			$u = get_user_by( 'login', $username ) ?: get_user_by( 'email', $username );
			if ( $u && user_can( $u, 'manage_options' ) ) {
				$ip = (string) ( $_SERVER['REMOTE_ADDR'] ?? '?' );
				self::alert( 'pw_probe', 'Password login attempted on an administrator account',
					"Someone tried to sign in to admin account `{$u->user_login}` with a PASSWORD (from {$ip}).\n"
					. 'Passwords are disabled platform-wide, so the attempt failed — but password hashes are public '
					. 'in /data, which means someone may be trying cracked material. No action required; this is your tripwire.' );
			}
		}
		return $user;
	}

	// ── Instant hooks (changes made through WordPress APIs) ──────────────────

	public static function role_change( $user_id, $role, $old_roles ) {
		if ( $role === 'administrator' ) {
			$u = get_userdata( $user_id );
			self::alert( 'admin_grant_' . $user_id, 'A user was just made ADMINISTRATOR',
				'User #' . $user_id . ' (' . ( $u ? $u->user_login . ' / ' . $u->user_email : '?' ) . ') was promoted to administrator'
				. ( $old_roles ? ' (was: ' . implode( ',', (array) $old_roles ) . ')' : '' ) . '. If this was not you, demote them and rotate every secret.', true );
		}
	}

	public static function option_change( $option ) {
		global $wpdb;
		if ( in_array( $option, self::CRITICAL_OPTIONS, true ) || $option === $wpdb->prefix . 'user_roles' ) {
			self::alert( 'opt_' . $option, "Critical option `{$option}` changed",
				"The WordPress option `{$option}` was just updated. Deploys and intentional admin changes do this too — "
				. 'but if you did not expect it, treat it as a takeover attempt.' );
		}
	}

	// ── Hourly sweep ─────────────────────────────────────────────────────────

	/**
	 * DEAD-MAN GUARD (runs on wp-admin page loads): the hourly sweep is the first thing an attacker —
	 * or a silently broken WP-cron — would stop, and a sweep that never runs cannot report its own
	 * absence; every alarm in this class goes dark with it. So any admin page load checks how stale the
	 * last sweep is: >3h dark ⇒ re-schedule the event (self-heal) and raise an alarm (the mail channel
	 * is direct SMTP — it does not need cron). Cost: one small state-file read per admin page load.
	 */
	public static function heartbeat_guard() {
		$last = (int) self::state()['last_run'];
		if ( ! $last || time() - $last < 3 * HOUR_IN_SECONDS ) { return; } // never ran ⇒ first sweep will baseline
		if ( ! wp_next_scheduled( 'aq_watchdog' ) ) { wp_schedule_event( time() + 60, 'hourly', 'aq_watchdog' ); }
		self::alert( 'watchdog_stale', 'Security sweep has been DARK for ' . (int) floor( ( time() - $last ) / HOUR_IN_SECONDS ) . 'h',
			"The hourly watchdog/integrity sweep last ran " . gmdate( 'Y-m-d H:i', $last ) . " UTC. Every tamper alarm "
			. "(traps, ledgers, admin roster, file integrity) is blind while it is not running.\n"
			. 'The schedule has been re-armed automatically — if the sweep goes dark again, WP-cron itself is broken '
			. 'or something is unscheduling it deliberately; investigate on the AQ Security page.' );
	}

	public static function run() {
		self::check_traps();   // BEFORE plant — detect tampering before the trap is refreshed
		self::plant_traps();   // create any never-planted / replant any deleted trap
		self::check_admins();
		self::check_options();
		self::check_ledgers();
		self::check_vault_file();
		self::scan_leaks();
		self::check_rotation();
		self::$state['last_run'] = time();
		self::save();
	}

	/** Fingerprint of the administrator set (incl. password-hash material) vs the file baseline. */
	private static function check_admins() {
		$admins = [];
		foreach ( get_users( [ 'role' => 'administrator', 'fields' => 'all' ] ) as $u ) {
			$admins[ (int) $u->ID ] = $u->user_login . '|' . $u->user_email . '|' . md5( (string) $u->user_pass );
		}
		ksort( $admins );
		$fp  = md5( wp_json_encode( $admins ) );
		$old = self::state()['baselines']['admins'] ?? null;
		if ( $old !== null && $old !== $fp ) {
			self::alert( 'admins_changed', 'Administrator accounts changed',
				"The set of administrator accounts (or one of their emails / password hashes) changed since the last baseline.\n"
				. 'Current admins: ' . implode( ', ', array_map( fn( $id ) => "#$id " . strtok( $admins[ $id ], '|' ), array_keys( $admins ) ) )
				. "\nIf you made this change, ignore — the baseline has been updated.", true );
		}
		self::$state['baselines']['admins'] = $fp;
	}

	/** Critical options vs the file baseline (catches DIRECT-SQL edits the option hooks never see). */
	private static function check_options() {
		global $wpdb;
		$names = array_merge( self::CRITICAL_OPTIONS, [ $wpdb->prefix . 'user_roles' ] );
		foreach ( $names as $name ) {
			$fp  = md5( maybe_serialize( get_option( $name ) ) );
			$old = self::state()['baselines'][ 'opt_' . $name ] ?? null;
			if ( $old !== null && $old !== $fp ) {
				// SAME throttle key as the instant updated_option hook: one legitimate change used to email
				// TWICE (once at change time as `opt_X`, again at the next sweep as `optsweep_X`). Sharing
				// the key means the sweep only alerts when the hooks never saw the change — the direct-SQL
				// case this sweep exists to catch.
				self::alert( 'opt_' . $name, "Critical option `{$name}` changed (hourly sweep)",
					"`{$name}` differs from the last security baseline. The option hooks did not report it at the time it happened, "
					. 'which can mean it was edited with DIRECT database access. Verify it now: ' . admin_url( 'options.php' ) );
			}
			self::$state['baselines'][ 'opt_' . $name ] = $fp;
		}
	}

	/**
	 * Append-only proof, scale-bounded. For each ledger we checkpoint (COUNT, SUM) over a WINDOW of the
	 * most-recent rows `id BETWEEN lo AND hi`; a re-scan of that SAME id-range next tick must match — any
	 * edit or deletion of a row in it breaks the proof. The scan is O(WINDOW), never O(table): while a
	 * ledger is small the window spans the whole table (a full append-only proof); once it grows past
	 * WINDOW rows the proof slides to cover the active tail (where tampering would hide a recent theft),
	 * so the hourly check never becomes a billion-row SUM. (A malicious INSERT lands at a fresh id and
	 * reads as a normal append — that vector is covered by the reserve/backing reconcile, not here; this
	 * proves history was not REWRITTEN.)
	 */
	const LEDGER_WINDOW = 50000;

	private static function check_ledgers() {
		global $wpdb;
		foreach ( self::LEDGERS as $table => $col ) {
			$t   = Data::t( $table );
			$old = self::state()['ledgers'][ $table ] ?? null;
			// Re-verify the previous window (bounded). Skip pre-upgrade checkpoints lacking 'hi'.
			if ( is_array( $old ) && isset( $old['hi'] ) && $old['hi'] > 0 ) {
				$row = $wpdb->get_row( $wpdb->prepare(
					"SELECT COUNT(*) c, COALESCE(SUM({$col}),0) s FROM {$t} WHERE id BETWEEN %d AND %d",
					(int) $old['lo'], (int) $old['hi'] ), ARRAY_A );
				if ( $row && ( (int) $row['c'] !== (int) $old['count'] || (string) $row['s'] !== (string) $old['sum'] ) ) {
					self::alert( 'ledger_' . $table, "Ledger `{$table}` was REWRITTEN — append-only violated",
						"Rows id {$old['lo']}–{$old['hi']} no longer match the security checkpoint "
						. "(count {$old['count']}→{$row['c']}, sum {$old['sum']}→{$row['s']}).\n"
						. 'Ledger rows are never legitimately edited or deleted — this is direct DB tampering with the money/points record. '
						. 'Freeze cash-outs (AQ_CASHOUT_FROZEN) and audit immediately.', true );
				}
			}
			// Advance the window to the current tail and record the new checkpoint.
			$hi = (int) $wpdb->get_var( "SELECT COALESCE(MAX(id),0) FROM {$t}" );
			$lo = max( 1, $hi - self::LEDGER_WINDOW + 1 );
			$new = $hi > 0
				? $wpdb->get_row( $wpdb->prepare( "SELECT COUNT(*) c, COALESCE(SUM({$col}),0) s FROM {$t} WHERE id BETWEEN %d AND %d", $lo, $hi ), ARRAY_A )
				: [ 'c' => 0, 's' => '0' ];
			self::$state['ledgers'][ $table ] = [ 'lo' => $lo, 'hi' => $hi, 'count' => (int) $new['c'], 'sum' => (string) $new['s'] ];
		}
	}

	/** The vault file itself is integrity-watched: any change alerts (rotations announce themselves). */
	private static function check_vault_file() {
		$fp  = file_exists( Vault::path() ) ? md5_file( Vault::path() ) : 'absent';
		$old = self::state()['baselines']['vault'] ?? null;
		if ( $old !== null && $old !== $fp ) {
			self::alert( 'vault_changed', 'Secrets vault file changed',
				$fp === 'absent'
					? 'The vault file was DELETED. Restore secrets from wp-admin → AQ Security.'
					: 'The secrets vault was modified (a rotation from wp-admin logs itself — check the audit log on the AQ Security page; an unlogged change means someone else has filesystem access).' );
		}
		self::$state['baselines']['vault'] = $fp;
	}

	/** The public DB must hold NOTHING credential-shaped. Sweep wp_options for key-like values. */
	private static function scan_leaks() {
		global $wpdb;
		// Match credential VALUE prefixes (not field NAMES — a serialized `client_secret` key whose value
		// is empty is not a leak), so the scan flags real keys without drowning in plugin-settings noise.
		$like = fn( $p ) => $wpdb->prepare( 'option_value LIKE %s', '%' . $wpdb->esc_like( $p ) . '%' );
		// `ya29.` is a LIVE Google OAuth2 access token — the shape a token-exchange result has. It is
		// here because exactly that leak happened: Meet::token() cached its access token in a
		// transient, which is a wp_options row wherever no persistent object cache exists, i.e. a live
		// credential in the table we publish. The caller was fixed (it is a per-request static now);
		// this pattern is so the NEXT one is caught by the alarm rather than by a code review.
		$where = implode( ' OR ', array_map( $like, [ 'sk_live_', 'sk-ant-', 'whsec_', 'AKIA', '-----BEGIN ', 'rk_live_', 'GOCSPX-', 'ya29.', 'hf_', 'ghp_', 'github_pat_' ] ) );
		$rows = $wpdb->get_results( "SELECT option_name, option_value FROM {$wpdb->options} WHERE {$where} LIMIT 10", ARRAY_A );
		// CONFIRM each LIKE hit against the full credential shape before alarming. The bare substrings
		// false-positive on ordinary data: 'AKIA' occurs in random base64 (any cached blob), and
		// '-----BEGIN ' also matches PUBLIC keys / certificates, which are not secrets. A real AWS key is
		// AKIA + exactly 16 upper/digits; the PEM block that matters says PRIVATE KEY; the vendor-prefixed
		// tokens carry a long random tail.
		$shapes = [
			'/\bsk_live_[0-9a-zA-Z]{10,}/', '/\brk_live_[0-9a-zA-Z]{10,}/', '/sk-ant-[0-9a-zA-Z_\-]{10,}/',
			'/\bwhsec_[0-9a-zA-Z]{10,}/', '/\bAKIA[0-9A-Z]{16}\b/', '/-----BEGIN [A-Z ]*PRIVATE KEY-----/',
			'/\bGOCSPX-[0-9A-Za-z_\-]{10,}/', '/\bya29\.[0-9A-Za-z_\-]{20,}/',
			'/\bhf_[0-9A-Za-z]{20,}/', '/\bghp_[0-9A-Za-z]{30,}/', '/\bgithub_pat_[0-9A-Za-z_]{30,}/',
		];
		$names = [];
		$vals  = [];
		foreach ( (array) $rows as $r ) {
			foreach ( $shapes as $re ) {
				if ( preg_match( $re, (string) $r['option_value'] ) ) {
					$names[] = $r['option_name'];
					$vals[ $r['option_name'] ] = (string) $r['option_value'];
					break;
				}
			}
		}
		$names = array_diff( $names, self::TRAPS );
		// A transient holding a TRAP's value is our own decoy echoing around — fine. A transient
		// holding anything ELSE credential-shaped is a leak like any other, and the most likely one:
		// caching is exactly how a live token ends up in wp_options by accident. The old rule skipped
		// every `_transient*` name outright, which made the single most probable leak the one place
		// the alarm could not see. Compare against the planted trap VALUES, not the name prefix.
		$traps = self::state()['traps'] ?? [];
		$decoy = array_filter( array_map( 'strval', is_array( $traps ) ? $traps : [] ) );
		$names = array_filter( $names, function ( $n ) use ( $vals, $decoy ) {
			if ( strpos( $n, '_transient' ) !== 0 ) { return true; }
			$v = $vals[ $n ] ?? '';
			foreach ( $decoy as $d ) { if ( $d !== '' && strpos( $v, $d ) !== false ) { return false; } }
			return true;
		} );
		if ( $names ) {
			self::alert( 'leak_' . md5( implode( ',', $names ) ), 'Possible SECRET stored in the public database',
				"These wp_options rows contain credential-shaped values: " . implode( ', ', $names ) . ".\n"
				. 'The entire database is PUBLIC — if any of these is a real secret it is already exposed. '
				. 'Move it to the vault (wp-admin → AQ Security), delete the option, and rotate the credential.', true );
		}
	}

	/** Rotation alarms from the vault metadata + the password-login escape hatch. */
	private static function check_rotation() {
		if ( Secrets::has( 'AQ_ALLOW_PASSWORD_LOGIN' ) ) {
			self::alert( 'pw_hatch', 'AQ_ALLOW_PASSWORD_LOGIN is SET — password logins are live',
				'The recovery escape hatch is enabled, which makes the PUBLIC password hashes in /data a usable attack '
				. 'surface. Unset it the moment recovery is done.', true );
		}
		$due = [];
		foreach ( Vault::meta() as $name => $m ) {
			if ( $m['compromised'] ) {
				self::alert( 'rot_comp_' . $name, "Rotate `{$name}` NOW — flagged compromised",
					"`{$name}` is marked compromised (e.g. it appeared in a transcript or log). Rotate it at the issuer, "
					. 'then save the new value in wp-admin → AQ Security. This alarm repeats until the flag clears (rotating clears it).', true );
			} elseif ( $m['in_vault'] && $m['max_days'] > 0 && $m['rotated'] > 0
				&& time() - $m['rotated'] > $m['max_days'] * DAY_IN_SECONDS ) {
				$due[] = $name . ' (' . (int) floor( ( time() - $m['rotated'] ) / DAY_IN_SECONDS ) . "d old, policy {$m['max_days']}d)";
			}
		}
		if ( $due ) {
			self::alert( 'rot_due', 'Secrets due for rotation: ' . count( $due ),
				"These vault secrets have exceeded their rotation policy:\n - " . implode( "\n - ", $due )
				. "\nRotate each at its issuer and save the new value in wp-admin → AQ Security." );
		}
	}

	// ── Admin-page status section + manual controls (rendered by Vault::render_page) ──

	/** Forget every baseline/checkpoint so the next run records fresh ones (after intentional bulk changes). */
	public static function rebaseline() {
		self::state();
		self::$state['baselines'] = [];
		self::$state['ledgers']   = [];
		self::note( 'Baselines rebuilt from wp-admin by ' . wp_get_current_user()->user_login );
		self::save();
		self::run();
	}

	/** Headline numbers for the dashboard cards (last sweep, traps armed, recent CRITICAL alarms). */
	public static function summary() {
		$s     = self::state();
		$since = time() - 7 * DAY_IN_SECONDS;
		$crit  = 0;
		foreach ( (array) $s['log'] as $e ) {
			if ( (int) $e['t'] >= $since && strpos( (string) $e['m'], 'CRITICAL' ) === 0 ) { $crit++; }
		}
		return [
			'last_run'     => (int) $s['last_run'],
			'traps_armed'  => count( array_filter( (array) $s['traps'] ) ),
			'traps_total'  => count( self::TRAPS ),
			'ledgers'      => count( (array) $s['ledgers'] ),
			'crit_7d'      => $crit,
		];
	}

	public static function render_status() {
		$s = self::state();
		echo '<h2 class="aq-h">Watchdog <span class="aq-sub">— hourly tamper sweep, alerts to ' . esc_html( Mailer::operator() ) . ' + every admin\'s bell</span></h2>';
		echo '<p class="aq-lead">Honeytrap canaries in the public DB (use + write tripwires), administrator-roster &amp; critical-option baselines, append-only ledger proofs, vault-file integrity, a secret-leak scan of the public DB, and rotation alarms. Every baseline lives in a file <em>outside</em> the database, so a DB attacker can\'t forge or silence it.</p>';

		echo '<div class="aq-actions">';
		echo self::ctl( 'runcheck', 'Run checks now', true );
		echo self::ctl( 'rebaseline', 'Rebuild baselines' );
		echo self::ctl( 'replant', 'Replant traps' );
		echo self::ctl( 'testalert', 'Send test alert' );
		echo '</div>';

		echo '<h3 class="aq-h3">Audit log</h3>';
		$log = array_reverse( array_slice( (array) $s['log'], -25 ) );
		if ( ! $log ) { echo '<p class="aq-muted">Nothing logged yet — the first sweep records baselines silently.</p>'; return; }
		echo '<table class="aq-log"><tbody>';
		foreach ( $log as $e ) {
			$m    = (string) $e['m'];
			$crit = strpos( $m, 'CRITICAL' ) === 0;
			$dot  = $crit ? 'crit' : ( strpos( $m, 'rotated' ) !== false || strpos( $m, 'Test alert' ) !== false ? 'ok' : 'info' );
			echo '<tr><td class="aq-when">' . esc_html( gmdate( 'Y-m-d H:i', (int) $e['t'] ) ) . ' UTC</td>'
				. '<td><span class="aq-dot ' . $dot . '"></span>' . esc_html( $m ) . '</td></tr>';
		}
		echo '</tbody></table>';
	}

	/** A styled watchdog action button (POST form with nonce). */
	private static function ctl( $action, $label, $primary = false ) {
		return '<form method="post">' . wp_nonce_field( 'aq_vault', '_wpnonce', true, false )
			. '<input type="hidden" name="aq_vault_action" value="' . esc_attr( $action ) . '">'
			. '<button class="button' . ( $primary ? ' button-primary' : '' ) . '">' . esc_html( $label ) . '</button></form>';
	}
}
