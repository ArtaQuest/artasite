<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * MEMBER SHELLS — every member gets their own account on ArtaQuest's relay machine, reachable over
 * SSH with their own key: `ssh <handle>@shell.artaquest.com`.
 *
 * Operator directive (2026-08-08): "I want each user to have its own linux user with ssh key … each
 * user to be able to ssh to their sandbox into the server."
 *
 * WHAT A MEMBER IS ACTUALLY GETTING, and why this is not as alarming as "shell access to our server"
 * sounds. Their session is force-commanded into the SAME sandbox ArtaBot's tool turns already run in
 * — a bubblewrap namespace with a read-only /usr, a masked /etc, an nftables fence that blocks the
 * private network and the cloud metadata endpoint, and no platform credentials of any kind. What is
 * new is PERSISTENCE: their home survives, and it is the same home ArtaBot works in on their behalf,
 * so "ask ArtaBot to build it, then ssh in and find it" is one workspace rather than two. The machine
 * itself, production, this database and other members' files are all as unreachable from a member's
 * shell as they were from a tool turn. See tools/ticket-agent/artabot-shell.mjs.
 *
 * WHAT THIS CLASS HOLDS. Only PUBLIC keys, and that is deliberate rather than incidental: the whole
 * ArtaQuest database is published at /data/, so a private key could never live here (see the
 * "Security & radical transparency" rule — no secret is ever stored in the DB). A member pastes the
 * public half; the private half never leaves their machine. The key IS public, and the UI says so.
 *
 * The relay VM pulls the roster every few minutes over the existing worker secret and reconciles unix
 * accounts against it, so this class never reaches out to the machine — the same poll-only shape as
 * Relay, and for the same reason: prod cannot open connections to a box behind a firewall, and should
 * not be able to.
 */
final class Shell {

	const TABLE_VERSION = '1';

	/** Where members ssh to. A SUBDOMAIN, not artaquest.com: the apex A record is WordPress.com's, and
	 *  pointing it at the relay VM would take the website down. */
	const HOST = 'shell.artaquest.com';

	/** The machine's address, used ONLY while the DNS record above does not exist yet. A member should
	 *  never be shown a command that cannot work, and "we are waiting for DNS" is not their problem —
	 *  so the address they can actually reach is offered until the name resolves, and then it stops
	 *  being offered by itself. Nothing to remember to remove. */
	const HOST_IP = '51.12.95.156';

	/** The address to tell a member to use right now — the name once it resolves, the raw address until
	 *  then. Public so ArtaBot's prompt says the same thing the settings page does. */
	public static function reach() { return self::host_ready() ? self::HOST : self::HOST_IP; }

	/** IS THERE A MACHINE TO REACH? (2026-08-09.) The always-on VM those addresses point at was switched
	 *  off when ArtaBot moved to on-demand containers that cost nothing while nobody is using them, so
	 *  the ssh line above currently names a box that will not answer. Rather than a flag someone has to
	 *  remember to flip back, this asks the ONE thing that is true only once the replacement exists: the
	 *  address of its gateway. No endpoint configured ⇒ the machine is between homes, and the settings
	 *  page says so instead of handing out a command that times out. Configure it and the shell offers
	 *  itself again, by itself. Member homes are untouched throughout — they live on the file share, not
	 *  on the machine that was switched off. */
	public static function endpoint() { $u = Secrets::get( 'AQ_SHELL_URL' ); return is_string( $u ) ? trim( $u ) : ''; }

	/** Can a member open a shell at all right now? */
	public static function ready() { return self::endpoint() !== ''; }

	/** Does HOST resolve yet? Cached, because this is rendered on a settings page and a DNS lookup per
	 *  request would be a needless dependency on a resolver being fast. */
	private static function host_ready() {
		$v = get_transient( 'aq_shell_host_ok' );
		if ( $v !== false ) { return (bool) $v; }
		$ok = function_exists( 'gethostbyname' ) && gethostbyname( self::HOST ) !== self::HOST;
		set_transient( 'aq_shell_host_ok', $ok ? 1 : 0, $ok ? DAY_IN_SECONDS : 300 );
		return $ok;
	}

	/** Keys per member. Enough for a laptop, a desktop and a phone, few enough that a compromised
	 *  account cannot quietly accumulate a hundred ways back in. */
	const MAX_KEYS = 5;

	/** Self-installed table (the Relay/Notify pattern — this feature owns its storage). */
	public static function ensure_table() {
		if ( get_option( 'aq_shell_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$table   = $wpdb->prefix . 'aq_shell_keys';
		$charset = $wpdb->get_charset_collate();
		dbDelta( "CREATE TABLE {$table} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			label VARCHAR(60) NOT NULL DEFAULT '',
			pubkey TEXT NULL,
			fp VARCHAR(64) NOT NULL DEFAULT '',
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY user_created (user_id, created)
		) {$charset};" );
		update_option( 'aq_shell_table_version', self::TABLE_VERSION, true );
	}

	// ── keys ─────────────────────────────────────────────────────────────────────

	/**
	 * Validate ONE public key → the canonical `type base64` string, or '' if it is not one.
	 *
	 * This mirrors sanitizeKey() in artabot-shell.mjs deliberately, and both are load-bearing: this one
	 * keeps rubbish out of the database, that one decides what actually reaches authorized_keys. The
	 * rule that matters in both: an authorized_keys line may carry OPTIONS before the key type —
	 * `command="…"`, `environment="…"`, `permitopen=…` — and those are how a key becomes something
	 * other than what the server intended. Anything before a known key type is a REFUSAL, never
	 * something to strip and hope we stripped it all.
	 */
	public static function valid_key( $line ) {
		$s = trim( preg_replace( '/[\r\n]+/', ' ', (string) $line ) );
		$types = 'ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com';
		if ( ! preg_match( '/^(' . $types . ')\s+([A-Za-z0-9+\/=]+)(\s|$)/', $s, $m ) ) { return ''; }
		$type = $m[1];
		$blob = $m[2];
		if ( strlen( $blob ) < 32 || strlen( $blob ) > 1400 ) { return ''; }
		if ( $type === 'ssh-rsa' && strlen( $blob ) < 300 ) { return ''; }   // roughly < 2048-bit
		// The base64 must decode AND announce its own type — a blob whose header says something other
		// than the prefix is malformed or a deliberate mismatch, and either way we do not want it.
		$raw = base64_decode( $blob, true );
		if ( $raw === false || strlen( $raw ) < 12 ) { return ''; }
		$len = unpack( 'N', substr( $raw, 0, 4 ) )[1];
		if ( $len < 4 || $len > 64 || substr( $raw, 4, $len ) !== $type ) { return ''; }
		return $type . ' ' . $blob;
	}

	/** The fingerprint OpenSSH shows (`SHA256:…`), so a member can check that what we hold is what they
	 *  pasted by running `ssh-keygen -lf id_ed25519.pub` and comparing.
	 *
	 *  STANDARD base64, not url-safe. This is the whole value of the field: a fingerprint that does not
	 *  match `ssh-keygen -lf` character for character is worse than showing none, because the member
	 *  does the comparison, sees a difference, and concludes we are holding the wrong key. Most
	 *  fingerprints contain neither + nor / and the two encodings agree by luck — which is exactly how
	 *  this would have shipped looking correct. */
	public static function fingerprint( $canonical ) {
		$parts = explode( ' ', (string) $canonical );
		$raw   = base64_decode( $parts[1] ?? '', true );
		if ( $raw === false || $raw === '' ) { return ''; }
		return 'SHA256:' . rtrim( base64_encode( hash( 'sha256', $raw, true ) ), '=' );
	}

	/** A member's unix login: their HANDLE, so a person has one name everywhere on the platform.
	 *  Validated, never sanitised — see unixName() in artabot-shell.mjs for why mangling a handle into
	 *  a valid-looking name is an account-takeover shape. Returns '' when the handle cannot be one. */
	public static function unix_name( $handle ) {
		$n = strtolower( (string) $handle );
		if ( ! preg_match( '/^[a-z][a-z0-9_-]{1,30}$/', $n ) ) { return ''; }
		$reserved = [ 'root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news',
			'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'nobody', 'sshd', 'syslog', 'ubuntu',
			'admin', 'test', 'guest', 'arta', 'artatool', 'agent', 'aq', 'artaquest', 'artabot' ];
		return in_array( $n, $reserved, true ) ? '' : $n;
	}

	// ── member-facing routes ─────────────────────────────────────────────────────

	/** GET /shell — what this member's shell is, and which keys open it. */
	public static function mine( $req ) {
		self::ensure_table();
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'signin_required', 'Sign in to get your own shell', 401 ); }
		$u    = get_userdata( $uid );
		$unix = self::unix_name( $u ? $u->user_nicename : '' );
		$rows = Data::all( 'SELECT id, label, pubkey, fp, created FROM ' . Data::t( 'aq_shell_keys' ) . ' WHERE user_id = %d ORDER BY id ASC', [ $uid ] );
		return [
			'host'    => self::HOST,
			'unix'    => $unix,
			// Say WHY there is no shell rather than just showing nothing — a handle that cannot be a
			// unix name is fixable by the member in one field, but only if they are told.
			'blocked' => $unix ? '' : 'Your handle cannot be a Linux username. Change it in Settings to letters, digits, - or _ (starting with a letter) and your shell will appear within a few minutes.',
			// The command that works TODAY. Once shell.artaquest.com resolves this becomes the name, by
			// itself, without anybody editing anything — and while there is no machine to reach, there
			// is no command either, because a copyable line that hangs is worse than none.
			'command' => $unix && self::ready() ? 'ssh ' . $unix . '@' . ( self::host_ready() ? self::HOST : self::HOST_IP ) : '',
			'moving'  => self::ready() ? '' : 'Your machine is moving. ArtaBot now runs on hosting that costs nothing while nobody is using it, and your shell is being rebuilt the same way — so it will start when you connect rather than running around the clock. Your files are safe: homes live on the file share, not on the machine that was switched off. Keys you add here are kept and will work the moment it opens.',
			'max'     => self::MAX_KEYS,
			'keys'    => array_map( static function ( $r ) {
				return [ 'id' => (int) $r['id'], 'label' => (string) $r['label'], 'fp' => (string) $r['fp'],
				         'key' => (string) $r['pubkey'], 'at' => (int) $r['created'] ];
			}, $rows ),
		];
	}

	/** POST /shell/keys {label, key} — add a public key. */
	public static function add_key( $req ) {
		self::ensure_table();
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'signin_required', 'Sign in first', 401 ); }
		if ( Rest::throttle( 'shell_key', 20, 3600 ) ) { return Rest::err( 'rate_limited', 'Too many key changes — try again shortly', 429 ); }
		$key = self::valid_key( Rest::p( $req, 'key', '' ) );
		if ( $key === '' ) {
			return Rest::err( 'bad_key', 'That is not a public SSH key. Paste the contents of a .pub file — it starts with ssh-ed25519 or ssh-rsa. Never paste a private key.' );
		}
		$n = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_shell_keys' ) . ' WHERE user_id = %d', [ $uid ] );
		if ( $n >= self::MAX_KEYS ) { return Rest::err( 'too_many', 'You already have ' . self::MAX_KEYS . ' keys — remove one first' ); }
		$fp = self::fingerprint( $key );
		// Same key twice is a no-op, not an error: a member re-pasting after a failed attempt should
		// not be told off, and two identical lines in authorized_keys would be noise.
		if ( Data::col( 'SELECT id FROM ' . Data::t( 'aq_shell_keys' ) . ' WHERE user_id = %d AND fp = %s', [ $uid, $fp ] ) ) {
			return self::mine( $req );
		}
		Data::insert( 'aq_shell_keys', [
			'user_id' => $uid,
			'label'   => substr( sanitize_text_field( (string) Rest::p( $req, 'label', '' ) ), 0, 60 ),
			'pubkey'  => $key,
			'fp'      => $fp,
			'created' => Data::now(),
		] );
		return self::mine( $req );
	}

	/** POST /shell/keys/remove {id} — take a key away. Effective within one sync (~3 min). */
	public static function remove_key( $req ) {
		self::ensure_table();
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'signin_required', 'Sign in first', 401 ); }
		$id = (int) Rest::p( $req, 'id', 0 );
		global $wpdb;
		// user_id in the WHERE, not just the id — otherwise any member could delete anyone's key.
		$wpdb->delete( Data::t( 'aq_shell_keys' ), [ 'id' => $id, 'user_id' => $uid ] );
		return self::mine( $req );
	}

	// ── the relay-facing side (auth: 'worker') ───────────────────────────────────

	/**
	 * POST /relay/shell/roster — every member who should have an account, with their keys.
	 *
	 * Members WITHOUT keys are included on purpose. The account and its home are provisioned anyway, so
	 * ArtaBot has somewhere persistent to work on their behalf from the very first turn; adding a key
	 * later opens the door to a workspace that already exists rather than creating one.
	 */
	public static function roster( $req ) {
		self::ensure_table();
		global $wpdb;
		$t    = Data::t( 'aq_shell_keys' );
		$keys = [];
		foreach ( $wpdb->get_results( "SELECT user_id, label, pubkey FROM {$t} ORDER BY id ASC", ARRAY_A ) as $k ) {
			$keys[ (int) $k['user_id'] ][] = [ 'label' => (string) $k['label'], 'key' => (string) $k['pubkey'] ];
		}
		$out = [];
		foreach ( get_users( [ 'fields' => [ 'ID', 'user_nicename' ], 'number' => 2000 ] ) as $u ) {
			$unix = self::unix_name( $u->user_nicename );
			if ( ! $unix ) { continue; }
			$out[] = [ 'id' => (int) $u->ID, 'handle' => $u->user_nicename, 'keys' => $keys[ (int) $u->ID ] ?? [] ];
		}
		return [ 'members' => $out, 'host' => self::HOST ];
	}
}
