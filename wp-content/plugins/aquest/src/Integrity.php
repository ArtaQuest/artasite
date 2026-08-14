<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Filesystem + invariant INTEGRITY monitor — the half of defence the Watchdog doesn't cover.
 *
 * Watchdog.php watches the DATABASE for tampering. This watches everything else an attacker would
 * touch to take over or persist, and the one economic invariant that must never break:
 *
 *   1. WEBSHELL SCAN — executable code (*.php/.phtml/.phar/…) under wp-content/uploads is the
 *      classic backdoor drop site. Baseline the (path → hash) of every such file; a NEW path or a
 *      CHANGED hash ⇒ CRITICAL. (This site legitimately keeps uploads/lesson-sync.inc.php, so the
 *      check is baseline-driven, not "any php = bad".)
 *   2. DROP-IN / ROOT CODE — wp-content/*.php (db.php, object-cache.php, advanced-cache.php, …) are
 *      auto-loaded by WordPress; a swapped or planted drop-in is a silent backdoor. Baseline + hash;
 *      new/changed ⇒ CRITICAL. (Our own managed files — the vault + watchdog/integrity state — change
 *      by design and are excluded.)
 *   3. MU-PLUGINS — must-use plugins load unconditionally and silently (perfect persistence). Baseline
 *      the entry set; a new entry ⇒ CRITICAL.
 *   4. CODE MANIFESTS — hash the plugin's and the theme's PHP as TWO manifests, each gated by its own
 *      version marker (plugin → AQ_VERSION; theme → the style.css Version header, since a themes-only
 *      push can never move AQ_VERSION on the server). A hash change without the matching version moving
 *      means code was edited on the server outside a deploy (injected backdoor) ⇒ alert. Legit deploys
 *      move the right version AUTOMATICALLY (tools/ticket-agent/deploy.mjs → selfMarkVersion /
 *      markDeployVersion), and drift within SETTLE_S of a version move is treated as WP.com sync
 *      straggle (a push lands over minutes and can tear across an hourly sweep). Every change is logged
 *      to the audit trail regardless. (Local/dev edits PHP in place as the normal workflow, so this one
 *      alert is suppressed there — that guard cannot help in production, where the alarm is raised.)
 *   5. CRON PERSISTENCE — attackers add a scheduled event to run their payload. Baseline the hook set;
 *      a new, unrecognised hook ⇒ alert.
 *   6. FULL-RESERVE INVARIANT — coins in circulation must never exceed the gold backing
 *      (Economy::verify_reserve). A break means coins were minted that no value backs (a ledger/counter
 *      attack or a solvency bug) ⇒ CRITICAL.
 *   7. LEDGER REF WIDTH — every Stripe idempotency guard is a `WHERE ref = 'stripe:<session id>'`, and
 *      that string is 73 characters. If a ledger's `ref` column cannot hold it, wpdb truncates on write
 *      while the probe uses the full length, so no guard can ever match: payments fulfil twice and
 *      refunds reverse nothing. Read the width back from the live DB rather than trusting the
 *      migration ⇒ CRITICAL.
 *   8. THE PLATFORM'S OWN PROOFS — Economy::verify_projections() (every counter equals the Σ of the
 *      ledger it mirrors) and Books::verify() (every published statement follows from the lines). Both
 *      are cited everywhere as the guarantee that figures cannot drift, and NEITHER had a production
 *      caller until now: one lived only in a dev CLI script, the other only behind a public endpoint
 *      nobody polls ⇒ CRITICAL. This is also the only guard over aq_counters, which holds backing_mg
 *      and coins_issued, is mutable, and is published in full.
 *
 * Baselines live in a gitignored file (aq-integrity-state.php), outside the public DB, so an attacker
 * with DB write access can't forge them. Alarms ride the Watchdog channel (operator email + every
 * admin's bell + shared audit log + throttle). First run records baselines silently — no false alarms.
 */
final class Integrity {

	const FILE  = 'aq-integrity-state.php'; // under WP_CONTENT_DIR — gitignored, never deployed
	const GUARD = "<?php http_response_code(404); exit; // ArtaQuest integrity state ?>\n";

	/** Executable-on-this-host extensions that have no business being uploaded as content. */
	const EXEC_EXT = [ 'php', 'phtml', 'phar', 'pht', 'phps', 'php3', 'php4', 'php5', 'php7', 'php8', 'cgi', 'pl' ];

	/** wp-content root .php files we write ourselves — they change by design, so don't hash-watch them. */
	const SELF_FILES = [ 'aq-vault.php', 'aq-watchdog-state.php', 'aq-integrity-state.php' ];

	const MAX_SCAN = 4000;  // hard cap on files walked under uploads (bounded cost at any scale)

	private static $state = null;

	public static function path() { return WP_CONTENT_DIR . '/' . self::FILE; }

	private static function state() {
		if ( self::$state !== null ) { return self::$state; }
		self::$state = [ 'v' => 1, 'uploads' => null, 'root' => null, 'mu' => null, 'code' => null, 'cron' => null, 'last_run' => 0 ];
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

	/** Hourly sweep (hooked on aq_watchdog alongside Watchdog::run). */
	public static function run() {
		self::state();
		self::check_uploads();
		self::check_root();
		self::check_muplugins();
		self::check_code();
		self::check_cron();
		self::check_reserve();
		self::check_ref_width();
		self::check_invariants();
		self::$state['last_run'] = time();
		self::save();
	}

	// ── 1. Webshell scan under uploads ──────────────────────────────────────
	private static function check_uploads() {
		$dir = WP_CONTENT_DIR . '/uploads';
		if ( ! is_dir( $dir ) ) { return; }
		$map = [];
		$n   = 0;
		try {
			$it = new \RecursiveIteratorIterator( new \RecursiveDirectoryIterator( $dir, \FilesystemIterator::SKIP_DOTS ) );
			foreach ( $it as $f ) {
				if ( ++$n > self::MAX_SCAN ) { break; }
				if ( ! $f->isFile() ) { continue; }
				$ext = strtolower( $f->getExtension() );
				if ( in_array( $ext, self::EXEC_EXT, true ) ) {
					$map[ str_replace( WP_CONTENT_DIR, '', $f->getPathname() ) ] = md5_file( $f->getPathname() );
				}
			}
		} catch ( \Throwable $e ) { return; } // unreadable tree → skip, never fatal
		self::diff_files( 'uploads', $map, 'Executable code under wp-content/uploads',
			'A PHP/executable file in the uploads directory is the classic web-shell backdoor. These appeared or changed:', true );
	}

	// ── 2. Drop-ins / wp-content root code ──────────────────────────────────
	private static function check_root() {
		$map = [];
		foreach ( (array) glob( WP_CONTENT_DIR . '/*.php' ) as $p ) {
			if ( in_array( basename( $p ), self::SELF_FILES, true ) ) { continue; } // our managed state
			$map[ str_replace( WP_CONTENT_DIR, '', $p ) ] = md5_file( $p );
		}
		self::diff_files( 'root', $map, 'wp-content drop-in / root code changed',
			'A wp-content root PHP file (drop-in like db.php / object-cache.php / advanced-cache.php) was planted or modified — these auto-load on every request and are a silent backdoor vector:', true );
	}

	// ── 3. Must-use plugins ─────────────────────────────────────────────────
	private static function check_muplugins() {
		$dir = WP_CONTENT_DIR . '/mu-plugins';
		if ( ! is_dir( $dir ) ) { return; }
		$entries = array_values( array_diff( (array) scandir( $dir ), [ '.', '..' ] ) );
		sort( $entries );
		$old = self::state()['mu'];
		if ( is_array( $old ) ) {
			$new = array_values( array_diff( $entries, $old ) );
			if ( $new ) {
				Watchdog::alert( 'integrity_mu', 'New must-use plugin appeared',
					"New entries in wp-content/mu-plugins (these load unconditionally on every request — a top persistence vector): "
					. implode( ', ', $new ) . ".\nIf you did not add them, treat as a backdoor.", true );
			}
		}
		self::$state['mu'] = $entries;
	}

	// ── 4. Plugin + theme code manifests (each gated by ITS OWN version) ────
	//
	// Two SEPARATE manifests because the two code bodies ship through different pipes: the plugin
	// deploys via aq-deploy `--options plugins` (which self-marks AQ_VERSION), while theme PHP rides
	// `--options themes` pushes (isolated-deploy SPA builds) that CANNOT move AQ_VERSION on prod —
	// the plugin main file isn't in a themes push. Gating both on AQ_VERSION made every theme-PHP
	// deploy read as a tamper (the recurring false CRITICAL in the 2026-07 audit log). The theme is
	// gated on its own style.css Version header, which a themes push DOES ship (deploy tooling bumps
	// it — deploy.mjs markDeployVersion/selfMarkVersion).
	//
	// SETTLE_S: WP.com applies a push over minutes, so an hourly sweep can catch a TORN deploy — the
	// version file landed but sibling PHP is still syncing (or vice versa); the next sweep then sees
	// "hash moved, version didn't" purely from straggle. After a version moves, hash drift within
	// SETTLE_S re-baselines with an audit note instead of alerting. An attacker editing PHP in that
	// window escapes the alert — but they could also just bump the version constant themselves, so
	// the tripwire's strength against a file-write attacker is unchanged; only the noise goes.
	const SETTLE_S = 3 * HOUR_IN_SECONDS;

	private static function check_code() {
		unset( self::$state['code'] ); // legacy combined manifest (pre-split) — superseded by codep/codet
		self::check_manifest( 'codep', 'plugin', [ AQ_DIR . '/*.php', AQ_DIR . '/src/*.php' ],
			defined( 'AQ_VERSION' ) ? AQ_VERSION : '?', 'AQ_VERSION' );
		self::check_manifest( 'codet', 'theme', [ get_template_directory() . '/*.php', get_template_directory() . '/includes/*.php' ],
			(string) wp_get_theme( get_template() )->get( 'Version' ), 'the theme Version header' );
	}

	private static function check_manifest( $key, $label, $globs, $ver, $gate_name ) {
		$files = [];
		foreach ( $globs as $g ) { $files = array_merge( $files, (array) glob( $g ) ); }
		sort( $files );
		$parts = [];
		foreach ( $files as $f ) { $parts[] = basename( $f ) . ':' . md5_file( $f ); }
		$hash = md5( implode( '|', $parts ) );
		$old  = self::state()[ $key ] ?? null;
		$now  = time();
		$moved_at = is_array( $old ) ? (int) ( $old['moved'] ?? 0 ) : 0;
		if ( is_array( $old ) && ! empty( $old['hash'] ) && $old['hash'] !== $hash ) {
			$count = count( $files );
			Watchdog::note( ucfirst( $label ) . " code changed ({$count} files hashed; version {$old['ver']}→{$ver})" );
			if ( $old['ver'] === $ver && ! Watchdog::is_dev_env() ) {
				if ( $now - $moved_at < self::SETTLE_S ) {
					Watchdog::note( ucfirst( $label ) . ' code drift inside the deploy-settle window (version moved '
						. (int) round( ( $now - $moved_at ) / 60 ) . 'min ago) — treated as WP.com sync straggle, re-baselined' );
				} else {
					Watchdog::alert( 'integrity_' . $key, ucfirst( $label ) . ' PHP changed WITHOUT a version bump',
						"The ArtaQuest {$label} PHP changed but {$gate_name} stayed {$ver}. Every legitimate deploy moves the "
						. "version, so server-side code edited in place (an injected backdoor) is the likely cause. Compare the "
						. 'deployed source against git and audit recent file writes.', true );
				}
			}
		}
		if ( ! is_array( $old ) || ( $old['ver'] ?? null ) !== $ver ) { $moved_at = $now; }
		self::$state[ $key ] = [ 'hash' => $hash, 'ver' => $ver, 'moved' => $moved_at ];
	}

	// ── 5. Cron persistence ─────────────────────────────────────────────────
	private static function check_cron() {
		$hooks = [];
		foreach ( (array) _get_cron_array() as $events ) {
			foreach ( (array) $events as $hook => $_ ) { $hooks[ $hook ] = true; }
		}
		$hooks = array_keys( $hooks );
		sort( $hooks );
		$old = self::state()['cron'];
		if ( is_array( $old ) ) {
			$new = array_values( array_diff( $hooks, $old ) );
			// Ignore the platform's own well-known recurring hooks (wp_*, aq_*, action-scheduler, jetpack/wpcom).
			$new = array_filter( $new, fn( $h ) => ! preg_match( '/^(wp_|aq_|action_scheduler|jetpack|jp_|wpcom)/', $h ) );
			if ( $new ) {
				Watchdog::alert( 'integrity_cron', 'New scheduled task (cron) appeared',
					"Unrecognised WP-cron hook(s) scheduled: " . implode( ', ', $new ) . ".\n"
					. 'Attackers schedule cron events to re-run a payload — if you did not register these, investigate.' );
			}
		}
		self::$state['cron'] = $hooks;
	}

	// ── 6. Full-reserve solvency invariant ──────────────────────────────────
	private static function check_reserve() {
		if ( ! class_exists( 'AQ\\Economy' ) || ! method_exists( 'AQ\\Economy', 'verify_reserve' ) ) { return; }
		$r = Economy::verify_reserve();
		if ( ! isset( $r['ok'] ) || $r['ok'] ) { return; }

		// An alarm worth having says "something happened that nobody authorised", not "the ratio is
		// below one". Since 2026-08-11 the Foundation deliberately holds an unbacked tranche — coin
		// issued to settle costs a director paid out of pocket — and paging hourly about a state the
		// operator chose would train everyone to ignore this alert, which is how the real one gets
		// missed. So the authorised shortfall is subtracted, and the alarm fires on the EXCESS.
		$authorised = class_exists( 'AQ\\Books' ) ? Books::authorised_shortfall() : 0;
		$shortfall  = max( 0, (int) $r['issued'] - (int) $r['backing'] );
		if ( $shortfall <= $authorised ) { return; }

		Watchdog::alert( 'integrity_reserve', 'FULL-RESERVE INVARIANT BROKEN — coins exceed gold backing',
			"Coins in circulation ({$r['issued']} ₳) exceed the gold backing ({$r['backing']} mg) — ratio {$r['ratio']}.\n"
			. "Shortfall {$shortfall} mg, of which {$authorised} mg is the authorised unbacked tranche, so "
			. ( $shortfall - $authorised ) . " mg is UNEXPLAINED.\n"
			. 'Coins were minted that no value backs: either the coin ledger / backing counter was tampered with directly, '
			. 'or a minting bug fired. FREEZE cash-outs (set AQ_CASHOUT_FROZEN) and audit the coin ledger now.', true );
	}

	// ── 7. LEDGER REF WIDTH — the idempotency keys must fit the columns that hold them ──────
	/**
	 * Every money guard on the Stripe path is the string `'stripe:' . <checkout session id>` compared
	 * with `WHERE ref = %s`. A modern session id is `cs_live_` + 58 characters, so the ref is 73 — and
	 * until Schema 1.70.0 the four ledger `ref` columns were VARCHAR(64).
	 *
	 * That combination is silent and total. WordPress strips STRICT_TRANS_TABLES in wpdb::set_sql_mode,
	 * so wpdb truncates the value to 64 characters BEFORE the query, with no error; every later lookup
	 * still uses the full 73-character literal, so it can never match the row it just wrote. Each guard
	 * that was supposed to make a payment idempotent — the fulfilment probe, the fund replay guard,
	 * fulfil_coin_purchase, reverse_coin_purchase — returns false forever. A payment can then be
	 * fulfilled twice (mint the coins again), and a refund reverses nothing at all.
	 *
	 * A schema migration that fails is normally quiet, which is exactly the failure mode that must not
	 * be quiet here. dbDelta is also known in this project to emit NO TABLE at all under Studio's
	 * SQLite for certain definitions. So rather than trust the migration, read the width back from the
	 * live database and page if a ref column cannot hold the key we are about to probe with.
	 */
	private static function check_ref_width() {
		global $wpdb;
		if ( ! isset( $wpdb ) ) { return; }
		// SQLite (local Studio) has no VARCHAR length enforcement and INFORMATION_SCHEMA is absent, so
		// there is nothing to read and nothing that can truncate. Abstain rather than alarm.
		if ( ! defined( 'DB_NAME' ) ) { return; }
		$need   = 73; // 'stripe:' + cs_live_ + 58
		$narrow = [];
		foreach ( [ 'aq_coin_ledger', 'aq_points_ledger', 'aq_fund_ledger', 'aq_credit_gifts' ] as $t ) {
			$table = Data::t( $t );
			$len   = $wpdb->get_var( $wpdb->prepare(
				'SELECT CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS'
				. ' WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s AND COLUMN_NAME = %s',
				DB_NAME, $table, 'ref'
			) );
			if ( $len === null ) { continue; }        // table absent on this install — not our alarm
			if ( (int) $len < $need ) { $narrow[] = $table . '.ref is VARCHAR(' . (int) $len . ')'; }
		}
		if ( ! $narrow ) { return; }
		Watchdog::alert( 'integrity_ref_width', 'LEDGER REF COLUMN TOO NARROW — payment idempotency is OFF',
			"These columns cannot hold a Stripe idempotency key (needs {$need} characters):\n - "
			. implode( "\n - ", $narrow ) . "\n\n"
			. "wpdb truncates the value silently on write while every guard probes with the full-length string, so "
			. "no `WHERE ref = …` can match: a paid Checkout Session can be fulfilled more than once (minting coins "
			. "again from one payment) and a refund reverses nothing.\n"
			. 'The Schema 1.70.0 migration widens all four to VARCHAR(191). It has not taken effect here — re-run it '
			. 'before accepting another payment, or freeze payments (unset STRIPE_SECRET_KEY).', true );
	}

	// ── 8. THE PLATFORM'S OWN PROOFS, ACTUALLY EXECUTED ─────────────────────────────────────
	/**
	 * Run Economy::verify_projections() and Books::verify() on the hourly tick and page on a failure.
	 *
	 * Both functions are held up — in code comments, in CLAUDE.md and on /finances itself — as the
	 * proof that the counters cannot drift from the ledgers and that the published statements cannot
	 * drift from the lines. Neither had a production caller. verify_projections() appeared exactly
	 * twice in the tree: its own definition and tools/verify-projections.php, a developer CLI script.
	 * Books::verify() was reachable only as a public endpoint nobody polls. A proof nobody runs is a
	 * comment.
	 *
	 * This matters most for the counters. aq_counters holds backing_mg and coins_issued, it is a
	 * MUTABLE row in a database this project publishes in full, and the threat model these classes
	 * exist for is explicitly an attacker with DB write access. Watchdog::LEDGERS cannot cover it —
	 * those are append-only prefix sums and a counter legitimately changes. The projection check is
	 * the guard that fits: a counter inflated by hand no longer equals the Σ of the ledger it mirrors,
	 * and that inequality is exactly what this reads. Without it, one UPDATE made /reserve report
	 * backed:true AND disarmed Integrity::check_reserve, which reads the same unwatched counter.
	 */
	private static function check_invariants() {
		$broken = [];
		if ( class_exists( 'AQ\\Economy' ) && method_exists( 'AQ\\Economy', 'verify_projections' ) ) {
			foreach ( (array) Economy::verify_projections() as $c ) {
				if ( empty( $c['ok'] ) ) {
					$broken[] = 'projection ' . ( $c['check'] ?? '?' ) . ': counter ' . ( $c['projected'] ?? '?' )
						. ' vs ledger ' . ( $c['ledger'] ?? '?' );
				}
			}
		}
		if ( class_exists( 'AQ\\Books' ) && method_exists( 'AQ\\Books', 'verify' ) ) {
			foreach ( (array) Books::verify() as $c ) {
				if ( empty( $c['ok'] ) ) { $broken[] = 'books ' . ( $c['check'] ?? '?' ) . ': ' . ( $c['detail'] ?? '' ); }
			}
		}
		if ( ! $broken ) { return; }
		Watchdog::alert( 'integrity_invariants', 'LEDGER INVARIANT BROKEN — a projection or the books disagree with the ledger',
			"These proofs failed on the hourly sweep:\n - " . implode( "\n - ", array_slice( $broken, 0, 10 ) )
			. ( count( $broken ) > 10 ? "\n - … +" . ( count( $broken ) - 10 ) . ' more' : '' ) . "\n\n"
			. "A counter that no longer equals the Σ of its ledger means either a write that skipped the ledger, or a\n"
			. "direct edit of aq_counters — which would also make /reserve report a backing it does not hold and disarm\n"
			. "the full-reserve alarm, since that reads the same counter. A books check failing means a published\n"
			. "statement disagrees with the lines it claims to be computed from.\n"
			. 'Rebuild with tools/verify-projections.php, and audit the ledgers before trusting any published figure.', true );
	}

	/**
	 * Compare a fresh (path → md5) map against the stored baseline; alert on any added or changed
	 * path, then store the new baseline. First run (no baseline) records silently.
	 */
	private static function diff_files( $key, $map, $subject, $intro, $critical ) {
		$old = self::state()[ $key ];
		if ( is_array( $old ) ) {
			$hits = [];
			foreach ( $map as $path => $h ) {
				if ( ! isset( $old[ $path ] ) ) { $hits[] = $path . ' (new)'; }
				elseif ( $old[ $path ] !== $h ) { $hits[] = $path . ' (modified)'; }
			}
			if ( $hits ) {
				Watchdog::alert( 'integrity_' . $key, $subject,
					$intro . "\n - " . implode( "\n - ", array_slice( $hits, 0, 8 ) )
					. ( count( $hits ) > 8 ? "\n - … +" . ( count( $hits ) - 8 ) . ' more' : '' ), $critical );
			}
		}
		self::$state[ $key ] = $map;
	}

	/** Headline numbers for the dashboard (files baselined, last run). */
	public static function summary() {
		$s = self::state();
		return [
			'last_run' => (int) $s['last_run'],
			'uploads'  => is_array( $s['uploads'] ) ? count( $s['uploads'] ) : 0,
			'root'     => is_array( $s['root'] ) ? count( $s['root'] ) : 0,
			'mu'       => is_array( $s['mu'] ) ? count( $s['mu'] ) : 0,
		];
	}
}
