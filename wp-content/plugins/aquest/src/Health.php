<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * THE HEALTH CHECK — "is the thing the browser gets actually the thing we built?"
 *
 * Watchdog.php answers a different question (is anyone TAMPERING with us). This class answers the
 * boring one that has actually caused every visible outage here: a half-committed SPA build, a route
 * whose handler was renamed, a token allow-list entry pointing at a path that no longer exists, a
 * cron that has silently not fired for a week, a required credential that quietly went missing.
 *
 * Every check is DETERMINISTIC and READ-ONLY — it reads a file, a route table, an option, or the
 * information schema, and reports what it read. Nothing here writes, deploys, or calls out to the
 * network, so it is safe to run on every page load of the operator's Health tab.
 *
 * THE ONE RULE: a check never reports a secret's VALUE, only whether one is configured — the whole
 * database is public (Extra::db), and so is anything a check accidentally echoes into it.
 *
 * Surfaces:
 *   GET aq/v1/health        → Health::report  (operator only — the full evidence)
 *   GET aq/v1/health/pulse  → Health::pulse   (public — counts only, for uptime pinging)
 *
 * The browser-side other half is tools/ui-health.mjs, which measures the RENDERED DOM on the live
 * site (mount, console errors, brand tokens, overflow, a11y). Server truth + rendered truth are
 * different failures and neither substitutes for the other.
 */
final class Health {

	const OK   = 'ok';
	const WARN = 'warn';
	const FAIL = 'fail';

	/** Check groups, in the order the operator reads them. */
	const GROUPS = [
		'build' => 'The app the browser gets',
		'api'   => 'The routes the app calls',
		'data'  => 'The shape the code expects',
		'brand' => 'The two colours',
		'ops'   => 'Jobs and credentials',
	];

	/** WP-cron hooks that must stay scheduled, with how stale a last-run may get before it worries us. */
	const CRONS = [
		'aq_watchdog'      => 6 * HOUR_IN_SECONDS,
		'aq_video_refresh' => 6 * HOUR_IN_SECONDS,
		'aq_trend_sweep'   => 2 * DAY_IN_SECONDS,
		'aq_moderate'      => 2 * DAY_IN_SECONDS,
		'aq_nb_settle'     => 2 * DAY_IN_SECONDS,
		'aq_gold_rate'     => 2 * DAY_IN_SECONDS,
		'aq_prune'         => 3 * DAY_IN_SECONDS,
		'aq_tr_gc'         => 3 * DAY_IN_SECONDS,
	];

	// ── The two REST handlers ────────────────────────────────────────────────

	/** The full report — operator only (Rest::ROUTES declares this 'admin'). */
	public static function report( $req = null ) {
		$checks = self::run();
		return [
			'ts'      => time(),
			'groups'  => self::GROUPS,
			'summary' => self::summarise( $checks ),
			'checks'  => $checks,
		];
	}

	/**
	 * The public liveness ping: counts only, never a detail. Deliberately says nothing an anonymous
	 * caller could use — "3 things are unhealthy" is not a map of what to attack, and the whole DB
	 * is public anyway, so the counts leak nothing the explorer does not already hand out.
	 */
	public static function pulse( $req = null ) {
		$s = self::summarise( self::run() );
		return [ 'ok' => $s['fail'] === 0, 'fail' => $s['fail'], 'warn' => $s['warn'], 'total' => $s['total'], 'ts' => time() ];
	}

	// ── The checks ───────────────────────────────────────────────────────────

	/** Every check, in group order. Each entry: id, group, label, status, detail, evidence. */
	public static function run() {
		$out = [];
		foreach ( [ 'build', 'api', 'data', 'brand', 'ops' ] as $g ) {
			$fn  = 'check_' . $g;
			try {
				$out = array_merge( $out, self::$fn() );
			} catch ( \Throwable $e ) {
				// A check that throws is itself a finding — but it must never take the report down.
				$out[] = self::c( $g . '.error', $g, ucfirst( $g ) . ' checks', self::FAIL, 'The check itself failed', $e->getMessage() );
			}
		}
		return $out;
	}

	private static function summarise( $checks ) {
		$n = [ self::OK => 0, self::WARN => 0, self::FAIL => 0 ];
		foreach ( $checks as $c ) { $n[ $c['status'] ] = ( $n[ $c['status'] ] ?? 0 ) + 1; }
		return [
			'total'  => count( $checks ),
			'ok'     => $n[ self::OK ],
			'warn'   => $n[ self::WARN ],
			'fail'   => $n[ self::FAIL ],
			'status' => $n[ self::FAIL ] ? self::FAIL : ( $n[ self::WARN ] ? self::WARN : self::OK ),
		];
	}

	private static function c( $id, $group, $label, $status, $detail, $evidence = '' ) {
		return [
			'id'       => $id,
			'group'    => $group,
			'label'    => $label,
			'status'   => $status,
			'detail'   => (string) $detail,
			'evidence' => is_string( $evidence ) ? $evidence : wp_json_encode( $evidence ),
		];
	}

	/**
	 * BUILD — the single most common way this site breaks: the theme prints an asset URL out of
	 * app/.vite/manifest.json, and the file it names is not there. A half-committed build (the
	 * manifest from one build, the chunks from another) serves a blank page with a 404 in the
	 * console, and NOTHING server-side notices, because PHP never touches those files.
	 */
	private static function check_build() {
		$out  = [];
		$dir  = get_theme_file_path( 'app' );
		$mf   = $dir . '/.vite/manifest.json';

		if ( ! file_exists( $mf ) ) {
			return [ self::c( 'build.manifest', 'build', 'Vite manifest', self::FAIL, 'No app/.vite/manifest.json — the theme cannot resolve any asset URL', $mf ) ];
		}
		$data = json_decode( (string) file_get_contents( $mf ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		if ( ! is_array( $data ) || ! $data ) {
			return [ self::c( 'build.manifest', 'build', 'Vite manifest', self::FAIL, 'app/.vite/manifest.json is present but unreadable as JSON', $mf ) ];
		}
		$out[] = self::c( 'build.manifest', 'build', 'Vite manifest', self::OK, count( $data ) . ' entries', 'built ' . self::ago( (int) filemtime( $mf ) ) . ' ago' );

		// The ENTRY is what the theme actually prints (aq_app_assets()). If it is missing, the SPA
		// never boots at all — this is the difference between "a page looks wrong" and "nothing loads".
		$entry = null;
		foreach ( $data as $e ) { if ( ! empty( $e['isEntry'] ) ) { $entry = $e; break; } }
		if ( ! $entry || empty( $entry['file'] ) ) {
			$out[] = self::c( 'build.entry', 'build', 'SPA entry', self::FAIL, 'No isEntry chunk in the manifest — aq_app_assets() has nothing to print', '' );
		} else {
			$missing = [];
			foreach ( array_merge( [ $entry['file'] ], (array) ( $entry['css'] ?? [] ) ) as $f ) {
				if ( ! file_exists( $dir . '/' . $f ) ) { $missing[] = $f; }
			}
			$out[] = $missing
				? self::c( 'build.entry', 'build', 'SPA entry', self::FAIL, count( $missing ) . ' entry file(s) named by the manifest are NOT on disk', implode( ', ', $missing ) )
				: self::c( 'build.entry', 'build', 'SPA entry', self::OK, $entry['file'], self::kb( $dir . '/' . $entry['file'] ) . ' + ' . count( (array) ( $entry['css'] ?? [] ) ) . ' css' );
		}

		// EVERY chunk, not just the entry: a lazy route chunk that is missing is a page that goes
		// blank only when someone navigates to it — the failure mode that survives a smoke test.
		$want = [];
		foreach ( $data as $e ) {
			if ( ! empty( $e['file'] ) ) { $want[] = $e['file']; }
			foreach ( (array) ( $e['css'] ?? [] ) as $css ) { $want[] = $css; }
		}
		$want    = array_values( array_unique( $want ) );
		$absent  = [];
		foreach ( $want as $f ) { if ( ! file_exists( $dir . '/' . $f ) ) { $absent[] = $f; } }
		$out[] = $absent
			? self::c( 'build.chunks', 'build', 'Route chunks', self::FAIL, count( $absent ) . ' of ' . count( $want ) . ' built files are missing — those routes render blank', implode( ', ', array_slice( $absent, 0, 8 ) ) . ( count( $absent ) > 8 ? ' …' : '' ) )
			: self::c( 'build.chunks', 'build', 'Route chunks', self::OK, count( $want ) . ' files all present', '' );

		// The service worker precaches this list. A name in it that is not on disk makes the install
		// step reject, which silently costs every member offline support (project_offline_media...).
		$pre = $dir . '/aq-precache.json';
		if ( ! file_exists( $pre ) ) {
			$out[] = self::c( 'build.precache', 'build', 'Offline precache', self::WARN, 'No app/aq-precache.json — offline support ships nothing', $pre );
		} else {
			$raw  = json_decode( (string) file_get_contents( $pre ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions
			// The file is { build, bytes, count, files: [...] } — read ONLY `files`. Walking the whole
			// object treats the build hash as a filename and reports a phantom miss.
			$list = ( is_array( $raw ) && isset( $raw['files'] ) && is_array( $raw['files'] ) ) ? $raw['files'] : ( is_array( $raw ) ? [] : [] );
			$gone = [];
			foreach ( $list as $f ) {
				if ( ! is_string( $f ) ) { continue; }
				$rel = ltrim( (string) preg_replace( '#^.*/app/#', '', $f ), '/' );
				if ( $rel !== '' && strpos( $rel, 'http' ) !== 0 && ! file_exists( $dir . '/' . $rel ) ) { $gone[] = $rel; }
			}
			$out[] = $gone
				? self::c( 'build.precache', 'build', 'Offline precache', self::FAIL, count( $gone ) . ' precached names are not on disk — the service worker install will reject', implode( ', ', array_slice( $gone, 0, 6 ) ) )
				: self::c( 'build.precache', 'build', 'Offline precache', self::OK, count( $list ) . ' assets', '' );
		}

		return $out;
	}

	/**
	 * API — the route table is the whole contract (Rest::ROUTES). Three ways it rots silently:
	 * a handler gets renamed and the row still points at the old name (500 for whoever hits it);
	 * a TOKEN_ROUTES key stops matching any declared path (a documented API promise that can never
	 * be kept); and a method+path declared twice, where only one registration survives.
	 */
	private static function check_api() {
		$out    = [];
		$routes = Rest::ROUTES;

		$broken = [];
		foreach ( $routes as [ $method, $path, $handler, $auth ] ) {
			$parts = explode( '::', $handler );
			if ( count( $parts ) !== 2 || ! is_callable( [ 'AQ\\' . $parts[0], $parts[1] ] ) ) {
				$broken[] = $method . ' ' . $path . ' → ' . $handler;
			}
		}
		$out[] = $broken
			? self::c( 'api.handlers', 'api', 'Route handlers', self::FAIL, count( $broken ) . ' of ' . count( $routes ) . ' routes point at a handler that does not exist', implode( ' · ', array_slice( $broken, 0, 6 ) ) )
			: self::c( 'api.handlers', 'api', 'Route handlers', self::OK, count( $routes ) . ' routes all resolve', '' );

		$declared = [];
		foreach ( $routes as [ $method, $path ] ) { $declared[ $path ][] = $method; }

		$stale = [];
		foreach ( Api::TOKEN_ROUTES as $path => $methods ) {
			if ( ! isset( $declared[ $path ] ) ) { $stale[] = $path; continue; }
			foreach ( array_keys( (array) $methods ) as $m ) {
				if ( ! in_array( $m, $declared[ $path ], true ) ) { $stale[] = $m . ' ' . $path; }
			}
		}
		$out[] = $stale
			? self::c( 'api.tokens', 'api', 'Token allow-list', self::FAIL, count( $stale ) . ' Api::TOKEN_ROUTES entries match no declared route — that API surface is documented but dead', implode( ' · ', array_slice( $stale, 0, 6 ) ) )
			: self::c( 'api.tokens', 'api', 'Token allow-list', self::OK, count( Api::TOKEN_ROUTES ) . ' entries all resolve', '' );

		$dupes = [];
		foreach ( $declared as $path => $methods ) {
			$seen = array_count_values( $methods );
			foreach ( $seen as $m => $n ) { if ( $n > 1 ) { $dupes[] = $m . ' ' . $path . ' ×' . $n; } }
		}
		$out[] = $dupes
			? self::c( 'api.dupes', 'api', 'Duplicate routes', self::WARN, count( $dupes ) . ' method+path pairs declared more than once — only one registration wins', implode( ' · ', $dupes ) )
			: self::c( 'api.dupes', 'api', 'Duplicate routes', self::OK, 'no method+path declared twice', '' );

		// A mutating verb declared 'public' has no session behind it. A handful legitimately cannot
		// have one — you cannot require a session to CREATE a session, and the translation mesh gates
		// first paint before anyone has signed in. Those are named here, deliberately and by handler,
		// so that a NEW public mutation shows up on the day it lands rather than the day it is abused.
		$exempt = [
			'Extra::stripe_webhook', // signature-verified raw body from Stripe; sessionless by construction
			'Auth::request_code', 'Auth::verify_code', 'Auth::google', // sign-in: the session does not exist yet
			'I18n::resolve', 'I18n::translate', 'I18n::save', // the mesh gates first paint, before any session
			// The fully-powered tools container completes turns through this. It deliberately holds NO
			// shared secret — a member has a root shell in there and could read one — so it authenticates
			// with an HMAC over ONE job id instead (Relay::verify_token), which the handler checks before
			// doing anything. Sessionless by construction, like the Stripe webhook above.
			'Relay::job_complete',
		];
		$open   = [];
		foreach ( $routes as [ $method, $path, $handler, $auth ] ) {
			if ( $auth === 'public' && $method !== 'GET' && ! in_array( $handler, $exempt, true ) ) {
				$open[] = $method . ' ' . $path . ' → ' . $handler;
			}
		}
		$out[] = $open
			? self::c( 'api.open_writes', 'api', 'Unauthenticated writes', self::FAIL, count( $open ) . ' mutating routes are declared public', implode( ' · ', $open ) )
			: self::c( 'api.open_writes', 'api', 'Unauthenticated writes', self::OK, 'every mutation requires a session, a token or the worker secret', '' );

		return $out;
	}

	/** DATA — the migration ran, and every table the code writes to actually exists. */
	private static function check_data() {
		global $wpdb;
		$out       = [];
		$installed = (string) get_option( 'aq_schema_version', '' );
		$out[]     = $installed === Schema::VERSION
			? self::c( 'data.schema', 'data', 'Schema version', self::OK, 'v' . Schema::VERSION, '' )
			: self::c( 'data.schema', 'data', 'Schema version', self::FAIL, 'code wants v' . Schema::VERSION . ', database is at v' . ( $installed ?: 'none' ) . ' — the migration has not run on this environment', '' );

		$want    = array_keys( Schema::tables() );
		$missing = [];
		foreach ( $want as $t ) {
			$name = $wpdb->prefix . $t;
			$got  = $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $name ) );
			if ( $got !== $name ) { $missing[] = $t; }
		}
		$out[] = $missing
			? self::c( 'data.tables', 'data', 'Tables', self::FAIL, count( $missing ) . ' of ' . count( $want ) . ' aq_ tables are missing', implode( ', ', array_slice( $missing, 0, 8 ) ) )
			: self::c( 'data.tables', 'data', 'Tables', self::OK, count( $want ) . ' aq_ tables present', '' );

		return $out;
	}

	/**
	 * BRAND — the one design rule that is arithmetic rather than taste: gold + blue sum to WHITE on
	 * every channel (yin = 255 − yang). Yin/yang complete to light; a pair that sums to more than 255
	 * merely CLIPS, which looks fine and is wrong. The eye cannot audit this, so a machine should.
	 *
	 * The theme emits its own pair as `--yang` / `--yin` in <style id="ay-brand-vars"> on every page
	 * (aq_brand_css_vars), and ~58 rules across the theme consume var(--yin). That is the pair the
	 * SERVER controls, so it is the pair checked here. The SPA's canonical `--color-yang` /
	 * `--color-yin` are computed per contrast level in the browser (lib/contrast.ts) and can only be
	 * read from the RENDERED DOM — tools/ui-health.mjs does exactly that. Neither check substitutes
	 * for the other, and reading the source instead of the render is how you get a false pass.
	 */
	private static function check_brand() {
		if ( ! function_exists( 'aq_brand_css_vars' ) ) {
			return [ self::c( 'brand.tokens', 'brand', 'Gold + blue', self::WARN, 'aq_brand_css_vars() is not loaded — cannot read the theme tokens', 'the SPA pair is measured by tools/ui-health.mjs' ) ];
		}
		$css  = (string) aq_brand_css_vars();
		$yang = self::hex_of( $css, 'yang' );
		$yin  = self::hex_of( $css, 'yin' );
		if ( ! $yang || ! $yin ) {
			return [ self::c( 'brand.tokens', 'brand', 'Gold + blue', self::WARN, 'could not parse --yang / --yin out of the theme CSS', '' ) ];
		}
		$hex  = function ( $c ) { return '#' . strtoupper( implode( '', array_map( function ( $v ) { return str_pad( dechex( max( 0, min( 255, (int) $v ) ) ), 2, '0', STR_PAD_LEFT ); }, $c ) ) ); };
		$sums = [ $yang[0] + $yin[0], $yang[1] + $yin[1], $yang[2] + $yin[2] ];
		$want = [ 255 - $yang[0], 255 - $yang[1], 255 - $yang[2] ];
		$ok   = ( $sums === [ 255, 255, 255 ] );
		return [ $ok
			? self::c( 'brand.tokens', 'brand', 'Gold + blue', self::OK, $hex( $yang ) . ' + ' . $hex( $yin ) . ' = white', 'per channel: ' . implode( ', ', $sums ) )
			: self::c( 'brand.tokens', 'brand', 'Gold + blue', self::WARN, 'the theme pair does not sum to white: ' . $hex( $yang ) . ' + ' . $hex( $yin ) . ' = ' . implode( ', ', $sums ) . ' (want 255, 255, 255)', 'the complement of ' . $hex( $yang ) . ' is ' . $hex( $want ) . ' — var(--yin) is consumed by theme rules, so this is a live pair, not a dead token' ),
		];
	}

	/** OPS — the background jobs still fire, and the credentials the platform needs are configured. */
	private static function check_ops() {
		$out   = [];
		$stats = get_option( Cron::STATS_OPT, [] );
		$stats = is_array( $stats ) ? $stats : [];

		$unscheduled = [];
		$stalled     = [];
		$erroring    = [];
		foreach ( self::CRONS as $hook => $maxAge ) {
			if ( ! wp_next_scheduled( $hook ) ) { $unscheduled[] = $hook; }
			$s  = isset( $stats[ $hook ] ) && is_array( $stats[ $hook ] ) ? $stats[ $hook ] : [];
			$at = (int) ( $s['at'] ?? 0 );
			if ( $at && ( time() - $at ) > $maxAge ) { $stalled[] = $hook . ' (' . self::ago( $at ) . ' ago)'; }
			if ( ! empty( $s['err'] ) ) { $erroring[] = $hook . ': ' . substr( (string) $s['err'], 0, 60 ); }
		}
		if ( $unscheduled ) {
			$out[] = self::c( 'ops.cron', 'ops', 'Scheduled jobs', self::FAIL, count( $unscheduled ) . ' of ' . count( self::CRONS ) . ' jobs are not scheduled at all', implode( ', ', $unscheduled ) );
		} elseif ( $stalled ) {
			$out[] = self::c( 'ops.cron', 'ops', 'Scheduled jobs', self::WARN, count( $stalled ) . ' jobs are scheduled but have not run recently', implode( ' · ', $stalled ) );
		} else {
			$out[] = self::c( 'ops.cron', 'ops', 'Scheduled jobs', self::OK, count( self::CRONS ) . ' jobs scheduled and running', '' );
		}
		if ( $erroring ) {
			$out[] = self::c( 'ops.cron_errors', 'ops', 'Job errors', self::WARN, count( $erroring ) . ' jobs recorded an error on their last run', implode( ' · ', array_slice( $erroring, 0, 4 ) ) );
		}

		// Credentials: PRESENCE only. Never a value, never a prefix, never a length — this response
		// is JSON on a platform whose database is public, and a shape is a search key.
		$missing  = [];
		$optional = 0;
		foreach ( Vault::REGISTRY as $name => $spec ) {
			$policy = isset( $spec[1] ) ? (int) $spec[1] : 0;
			$opt    = $spec[2] ?? false;
			if ( $policy === 0 ) { continue; } // an ops FLAG, not a credential
			if ( Secrets::has( $name ) ) { continue; }
			if ( $opt === true ) { $optional++; continue; }
			if ( is_string( $opt ) && Secrets::has( $opt ) ) { continue; } // an alternative satisfies it
			if ( is_string( $opt ) ) { $optional++; continue; }
			$missing[] = $name;
		}
		$out[] = $missing
			? self::c( 'ops.secrets', 'ops', 'Credentials', self::FAIL, count( $missing ) . ' required credentials are not configured', implode( ', ', $missing ) )
			: self::c( 'ops.secrets', 'ops', 'Credentials', self::OK, 'every required credential is configured' . ( $optional ? ' (' . $optional . ' optional unset)' : '' ), '' );

		// The documented recovery flag. Password logins on a platform whose password hashes are
		// public is the one setting that must never be left on after an incident.
		$out[] = Secrets::has( 'AQ_ALLOW_PASSWORD_LOGIN' )
			? self::c( 'ops.password_login', 'ops', 'Password logins', self::FAIL, 'AQ_ALLOW_PASSWORD_LOGIN is SET — password sign-in is open while the hashes are public', 'unset it in the vault' )
			: self::c( 'ops.password_login', 'ops', 'Password logins', self::OK, 'disabled — email code and Google only', '' );

		return $out;
	}

	// ── Small helpers ────────────────────────────────────────────────────────

	/** [r,g,b] of a `--<name>: #rrggbb` declaration in a CSS blob, or null. */
	private static function hex_of( $css, $name ) {
		if ( ! preg_match( '/--' . preg_quote( $name, '/' ) . '\s*:\s*#([0-9a-fA-F]{6})/', $css, $m ) ) { return null; }
		return [ hexdec( substr( $m[1], 0, 2 ) ), hexdec( substr( $m[1], 2, 2 ) ), hexdec( substr( $m[1], 4, 2 ) ) ];
	}

	private static function ago( $ts ) {
		$d = max( 0, time() - (int) $ts );
		if ( $d < 90 ) { return $d . 's'; }
		if ( $d < 5400 ) { return round( $d / 60 ) . 'm'; }
		if ( $d < 172800 ) { return round( $d / 3600 ) . 'h'; }
		return round( $d / 86400 ) . 'd';
	}

	private static function kb( $path ) {
		$b = @filesize( $path );
		return $b ? round( $b / 1024 ) . ' KB' : '?';
	}
}
