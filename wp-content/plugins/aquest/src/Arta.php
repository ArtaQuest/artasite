<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * @artabot — ArtaQuest's public assistant. A real member account that only ever speaks in public.
 *
 * THE ONLY WAY TO TALK TO ARTA IS IN PUBLIC. A member writes "Hey @artabot …" in a feed post, a reply
 * to a post, or a comment anywhere on the platform; Arta answers in that same thread, as a reply
 * everybody can read. There is no private chat, no session, no inbox, no price.
 *
 * HOW A MENTION TRAVELS
 *   1. The post/comment is written as usual. In the same request, Arta::record() reads its text,
 *      notifies any member it @-mentions, and — when it mentions @artabot (or the old @artabot alias) —
 *      inserts ONE aq_mentions row (UNIQUE on source + target, so a retry cannot double it).
 *   2. If the author and the platform are under the rate limits, the row is `queued`. That row IS
 *      the queue: nothing is pushed anywhere. Arta's brain (/arta-brain, a daemon on the operator's
 *      Azure VM that answers on a flat-rate subscription) PULLS it through `arta/pending` every few
 *      seconds with the scoped AQ_ARTA_REPLY_TOKEN. Nothing is paid per reply, nothing listens on
 *      the internet, and when the brain is down, paused or at its own cap the mention simply
 *      waits (up to MAX_AGE) and is answered when it is back.
 *   3. The brain CLAIMS the row (atomic queued → working), decides what it is (a question, a bug
 *      report, or something to leave alone), and posts the answer through `arta/reply`. That route
 *      writes the reply as @artabot, in-thread, exactly once: a second reply for the same mention is
 *      refused as a duplicate, whoever sends it.
 *
 * NOTHING HERE CAN TAKE A MEMBER'S POST DOWN. Every entry point is wrapped so that a failure in
 * mention handling is logged and swallowed; the post or comment that triggered it has already been
 * written by the time this code runs.
 *
 * The brain never sees anything that is not already public: the mention's text, the thread it sits
 * in, and the public handles and display names of the people in it.
 */
final class Arta {

	const HANDLE = 'artabot';
	const NAME   = 'Arta';
	/** Every handle that reaches Arta. `artabot` is the account's old name, kept as an alias. */
	const ALIASES = [ 'arta', 'artabot' ];
	/** Handles no member may claim — Arta itself and the near-misses someone could impersonate it with. */
	const RESERVED = [
		'arta', 'artabot', 'arta-bot', 'artaai', 'arta-ai', 'arta-assistant', 'artaassistant',
		'arta-official', 'artaofficial', 'official-arta', 'the-arta', 'thearta', 'ask-arta', 'askarta',
		'hey-arta', 'heyarta', 'arta-help', 'artahelp', 'arta-support', 'artasupport', 'arta1', 'arta0',
		'artta', 'arrta', 'arta-quest-bot', 'artaquest-bot', 'artaquestbot',
	];
	const BIO = 'ArtaQuest’s public assistant. Mention @artabot in a post or a comment and I reply in the thread, in public. Start with “bug:” to report a problem and I file it on GitHub for the team.';

	const TABLE_VERSION = '4';   // 2: aq_arta_files (files on Arta's replies); 3: + source_url; 4: aq_arta_dm (private chat)
	const IDENTITY_VERSION = '2';

	// ── Limits. A participant, not a flood. ──────────────────────────────────────────────────────
	const USER_PER_HOUR   = 5;
	const USER_PER_DAY    = 15;
	const GLOBAL_PER_HOUR = 60;
	const GLOBAL_PER_DAY  = 300;    // = the brain's own daily pace cap (ARTA_PER_DAY) — more would only expire in the queue
	const MAX_HANDLES     = 5;      // @-mentions honoured per post — more is a spam pattern, not a conversation
	const POST_MAX        = 280;    // feed posts and replies — the same ceiling every member writes under
	const COMMENT_MAX     = 2000;
	const DM_MAX          = 2000;   // a private chat turn, either side
	const DM_HISTORY      = 8;      // earlier turns handed to the brain as context

	// ── Files IN: what a mention's post (and the posts above it) carries, handed to the brain. ─────
	// The brain uploads these to the chat page, so only types that page reads are offered, and a few.
	const ATTACH_MAX   = 4;          // files the brain attaches per mention
	const ATTACH_LIST  = 8;          // files LISTED per mention (the rest of a long thread is not worth naming)
	const ATTACH_BYTES = 20971520;   // 20 MB each
	const ATTACH_MIMES = [ 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json' ];

	// ── Files OUT: what the brain may attach to Arta's reply (generated images, the full long answer).
	// Sniffed from the bytes, never trusted from the name or the declared type; anything else is refused.
	const REPLY_FILES_MAX   = 4;
	const REPLY_FILE_BYTES  = 10485760;  // 10 MB each
	const REPLY_TOTAL_BYTES = 26214400;  // 25 MB per reply
	/** sniffed mime => [ extension, Library class ] — the ONLY types Arta's replies can carry. */
	const REPLY_TYPES = [
		'image/png' => [ 'png', 'image' ], 'image/jpeg' => [ 'jpg', 'image' ], 'image/gif' => [ 'gif', 'image' ], 'image/webp' => [ 'webp', 'image' ],
		'application/pdf' => [ 'pdf', 'doc' ], 'text/plain' => [ 'txt', 'doc' ], 'text/markdown' => [ 'md', 'doc' ],
		'text/csv' => [ 'csv', 'data' ], 'application/json' => [ 'json', 'data' ],
	];
	const MAX_AGE         = 172800; // 48 h — after that a mention expires unanswered rather than surfacing late
	const CLAIM_TTL       = 900;    // a brain claim older than this is presumed dead and re-queued
	const BEAT_FRESH      = 120;    // the brain counts as online if it polled within this many seconds

	const STATUSES = [ 'queued', 'working', 'replying', 'replied', 'skipped', 'failed', 'limited', 'expired' ];

	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// PURE helpers — no WordPress, no database. tools/test-arta.php covers every one.
	// ═════════════════════════════════════════════════════════════════════════════════════════════

	/**
	 * The @handles a text addresses, lower-cased, de-duplicated, in order of first appearance,
	 * capped at MAX_HANDLES. A handle is 3–30 of [a-z0-9-] with no hyphen at either end (the
	 * username rule in Auth::username_problem). An "@" glued to a preceding word character is an
	 * email address or a path, never a mention: "me@arta.org" mentions nobody.
	 */
	public static function extract_handles( $text ) {
		$text = (string) $text;
		if ( strpos( $text, '@' ) === false ) { return []; }
		if ( ! preg_match_all( '/(?<![A-Za-z0-9_@.\/+-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,28}[A-Za-z0-9])?)(?![A-Za-z0-9_-]|@|\.[A-Za-z0-9])/u', $text, $m ) ) {
			return [];
		}
		$out = [];
		foreach ( $m[1] as $h ) {
			$h = strtolower( $h );
			if ( strlen( $h ) < 3 || in_array( $h, $out, true ) ) { continue; }
			$out[] = $h;
			if ( count( $out ) >= self::MAX_HANDLES ) { break; }
		}
		return $out;
	}

	/**
	 * How a mention READS: "@artabot" (or the old @artabot) shown as "Arta" in display copy such as
	 * notifications, link-card descriptions and structured data. The stored text keeps "@artabot", which
	 * is what detection runs on. Same edges as extract_handles, so an email like x@arta.com is untouched.
	 */
	public static function display_mentions( $text ) {
		$text = (string) $text;
		if ( '' === $text || false === stripos( $text, '@arta' ) ) { return $text; }
		return (string) preg_replace( '~(^|[^A-Za-z0-9_@./+\-])@(?:arta|artabot)(?![A-Za-z0-9_\-]|@|\.[A-Za-z0-9])~i', '$1Arta', $text );
	}

	/** True when the text addresses Arta under any of its handles. */
	public static function mentions_arta( $text ) {
		return (bool) array_intersect( self::extract_handles( $text ), self::ALIASES );
	}

	/** True for a handle members may not take: Arta's own, its alias, and close imitations. */
	public static function is_reserved( $handle ) {
		$h = strtolower( trim( (string) $handle ) );
		if ( in_array( $h, self::RESERVED, true ) ) { return true; }
		// "arta" plus only separators/digits/assistant words reads as Arta to anyone glancing at a reply.
		return (bool) preg_match( '/^(the-?)?arta(-?(bot|ai|official|assistant|help|support|team|[0-9]+))?$/', $h );
	}

	/**
	 * An explicit bug report: after any leading @handles, the text opens with "bug:", "bug -",
	 * "#bug" or "[bug]". The brain also classifies free text; this prefix is the member's own
	 * unambiguous signal and always wins.
	 */
	public static function is_bug_prefix( $text ) {
		$t = preg_replace( '/^(\s*(hey|hi|hello)?[\s,]*@[A-Za-z0-9-]+[\s,:]*)+/iu', '', (string) $text );
		return (bool) preg_match( '/^\s*(bug\s*[:\-–—]|#bug\b|\[bug\])/iu', (string) $t );
	}

	/**
	 * The rate-limit decision from four counts of mentions ALREADY accepted (not counting this one).
	 * 'ok' | 'user' (this member is over their hourly or daily allowance) | 'global' (the platform is).
	 * The member's own limit is checked first so a single noisy account is told it is them.
	 */
	public static function limit_verdict( $user_hour, $user_day, $global_hour, $global_day ) {
		if ( (int) $user_hour >= self::USER_PER_HOUR || (int) $user_day >= self::USER_PER_DAY ) { return 'user'; }
		if ( (int) $global_hour >= self::GLOBAL_PER_HOUR || (int) $global_day >= self::GLOBAL_PER_DAY ) { return 'global'; }
		return 'ok';
	}

	/** Trim to $max characters on a word boundary, adding an ellipsis when anything was cut. */
	public static function clip( $text, $max ) {
		$text = trim( preg_replace( "/[ \t]+/u", ' ', (string) $text ) );
		if ( mb_strlen( $text ) <= $max ) { return $text; }
		$cut = mb_substr( $text, 0, max( 1, $max - 1 ) );
		$sp  = mb_strrpos( $cut, ' ' );
		if ( $sp !== false && $sp > $max * 0.6 ) { $cut = mb_substr( $cut, 0, $sp ); }
		return rtrim( $cut, " ,;:.-–—" ) . '…';
	}

	/**
	 * Make a brain-written reply safe to store as a member post: plain text only, no markup, and no
	 * links except to artaquest.com/.org and the GitHub repository the issues live in. A model that
	 * is talked into emitting a phishing link has that link removed here, not merely discouraged.
	 */
	/**
	 * The sources Arta cites (https only): an Ekşi Sözlük entry permalink, or the official page a real
	 * person's photo came from — Wikipedia/Wikimedia or a university site.
	 */
	public static function cited_link( $url, $host ) {
		if ( stripos( $url, 'https://' ) !== 0 ) { return false; }
		if ( ( $host === 'eksisozluk.com' || $host === 'www.eksisozluk.com' ) ) { return (bool) preg_match( '#^https://(www\.)?eksisozluk\.com/entry/\d+/?$#i', $url ); }
		return (bool) preg_match( '/(^|\.)(wikipedia\.org|wikimedia\.org|edu\.tr|edu)$/', $host );
	}

	/**
	 * `sources` = JSON {file name: page URL}: where an attached real photo came from. Kept only when it
	 * is a cited source (cited_link); the feed opens it when the photo is clicked.
	 */
	public static function file_sources( $raw ) {
		$j   = is_string( $raw ) ? json_decode( $raw, true ) : $raw;
		$out = [];
		foreach ( is_array( $j ) ? $j : [] as $name => $url ) {
			$url  = trim( (string) $url );
			$host = strtolower( (string) parse_url( $url, PHP_URL_HOST ) );
			if ( strlen( $url ) <= 500 && preg_match( '#^https://[^\s<>"\']+$#', $url ) && self::cited_link( $url, $host ) && ! preg_match( '#^https://(www\.)?eksisozluk\.com#i', $url ) ) {
				$out[ (string) $name ] = $url;
			}
		}
		return $out;
	}

	public static function sanitize_reply( $text, $max ) {
		$t = html_entity_decode( strip_tags( (string) $text ), ENT_QUOTES, 'UTF-8' );
		$t = preg_replace_callback( '#https?://[^\s<>()]+#iu', function ( $m ) {
			$host = strtolower( (string) parse_url( $m[0], PHP_URL_HOST ) );
			$ok   = in_array( $host, [ 'artaquest.com', 'www.artaquest.com', 'artaquest.org', 'www.artaquest.org' ], true )
				|| ( $host === 'github.com' && stripos( $m[0], 'github.com/ArtaQuest/' ) !== false )
				|| self::cited_link( $m[0], $host );
			return $ok ? $m[0] : '[link removed]';
		}, $t );
		$t = preg_replace( "/\n{3,}/", "\n\n", (string) $t );
		return self::clip( $t, $max );
	}

	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// Storage
	// ═════════════════════════════════════════════════════════════════════════════════════════════

	public static function ensure_tables() {
		if ( get_option( 'aq_arta_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		// One row per (source item, mentioned account). Only Arta mentions are stored: a mention of
		// a person is a notification and nothing more. The UNIQUE key is the idempotency guarantee —
		// recording the same post twice is a no-op, so a retried request cannot queue twice.
		// No `--` comments inside the DDL: dbDelta mis-parses them (see Usage::ensure_tables).
		dbDelta( "CREATE TABLE {$wpdb->prefix}aq_mentions (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			src_type VARCHAR(12) NOT NULL DEFAULT 'post',
			src_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			ctx_type VARCHAR(16) NOT NULL DEFAULT 'post',
			ctx_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			target_uid BIGINT UNSIGNED NOT NULL DEFAULT 0,
			status VARCHAR(12) NOT NULL DEFAULT 'queued',
			hint VARCHAR(12) NOT NULL DEFAULT '',
			kind VARCHAR(12) NOT NULL DEFAULT '',
			claimed_at INT UNSIGNED NOT NULL DEFAULT 0,
			reply_type VARCHAR(12) NOT NULL DEFAULT '',
			reply_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			issue_url VARCHAR(255) NOT NULL DEFAULT '',
			note VARCHAR(190) NOT NULL DEFAULT '',
			created INT UNSIGNED NOT NULL DEFAULT 0,
			updated INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY src (src_type, src_id, target_uid),
			KEY status_id (status, id),
			KEY author_created (author_id, created),
			KEY created (created)
		) {$charset};" );
		// Files on Arta's replies. Content-addressed in the public media store (key arta/<sha256>.<ext>);
		// a row ties one stored file to one reply so the reply renders it like a post attachment.
		dbDelta( "CREATE TABLE {$wpdb->prefix}aq_arta_files (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			mention_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			reply_type VARCHAR(12) NOT NULL DEFAULT '',
			reply_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			pos TINYINT UNSIGNED NOT NULL DEFAULT 0,
			name VARCHAR(120) NOT NULL DEFAULT '',
			class VARCHAR(12) NOT NULL DEFAULT '',
			mime VARCHAR(64) NOT NULL DEFAULT '',
			bytes INT UNSIGNED NOT NULL DEFAULT 0,
			sha256 CHAR(64) NOT NULL DEFAULT '',
			cdn_key VARCHAR(190) NOT NULL DEFAULT '',
			source_url VARCHAR(500) NOT NULL DEFAULT '',
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY reply (reply_type, reply_id, pos),
			KEY mention (mention_id)
		) {$charset};" );
		// The PRIVATE channel: one member and Arta, 1:1. Not end-to-end encrypted (Arta has to read it to
		// answer), and the UI says so. Visible only to that member (and the brain, which answers it).
		dbDelta( "CREATE TABLE {$wpdb->prefix}aq_arta_dm (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			from_arta TINYINT UNSIGNED NOT NULL DEFAULT 0,
			body TEXT NOT NULL,
			mention_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY user_id_id (user_id, id)
		) {$charset};" );
		update_option( 'aq_arta_table_version', self::TABLE_VERSION, true );
	}

	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// Identity
	// ═════════════════════════════════════════════════════════════════════════════════════════════

	/**
	 * Arta's WordPress user id. The account predates the rename (it was `artabot`, id 138325230 on
	 * production) and the id is kept in the same option the rest of the codebase already reads
	 * (`aq_artabot_uid`), so every "is this the bot?" check keeps working unchanged.
	 */
	public static function uid() {
		$uid = (int) get_option( 'aq_artabot_uid', 0 );
		if ( $uid && get_userdata( $uid ) ) { return $uid; }
		foreach ( self::ALIASES as $login ) {
			$u = get_user_by( 'slug', $login ) ?: get_user_by( 'login', $login );
			if ( $u ) { update_option( 'aq_artabot_uid', (int) $u->ID, true ); return (int) $u->ID; }
		}
		$host = wp_parse_url( home_url(), PHP_URL_HOST ) ?: 'example.org';
		$uid  = wp_insert_user( [
			'user_login'    => self::HANDLE,
			'user_nicename' => self::HANDLE,
			'display_name'  => self::NAME,
			'nickname'      => self::NAME,
			'user_email'    => self::HANDLE . '@' . $host,
			'user_pass'     => wp_generate_password( 40, true, true ),
			'role'          => 'subscriber',
		] );
		if ( is_wp_error( $uid ) ) { error_log( 'AQ Arta user: ' . $uid->get_error_message() ); return 0; }
		update_option( 'aq_artabot_uid', (int) $uid, true );
		self::stamp_identity( (int) $uid );
		return (int) $uid;
	}

	/** True for Arta's own account (so it never answers itself, and the UI can badge it). */
	public static function is_arta( $uid ) {
		$id = (int) get_option( 'aq_artabot_uid', 0 );
		return $id > 0 && (int) $uid === $id;
	}

	/**
	 * ONE-TIME rename of the existing bot account: handle `artabot` → `arta`, display name 'Arta'.
	 * The account id, its history and every row that points at it are untouched; only the public
	 * name changes. Gated on an option so it runs once per environment, and refuses (loudly, in the
	 * log) if some other account already holds `arta` rather than overwriting it.
	 */
	public static function migrate_identity() {
		if ( get_option( 'aq_arta_identity' ) === self::IDENTITY_VERSION ) { return; }
		$uid = self::uid();
		if ( ! $uid ) { return; }
		$u = get_userdata( $uid );
		if ( ! $u ) { return; }
		$holder = get_user_by( 'slug', self::HANDLE );
		if ( $holder && (int) $holder->ID !== $uid ) {
			error_log( 'AQ Arta: the handle @' . self::HANDLE . ' is held by user ' . (int) $holder->ID . ' — rename skipped' );
			update_option( 'aq_arta_identity', self::IDENTITY_VERSION, true );
			return;
		}
		global $wpdb;
		// user_login cannot be changed through wp_update_user. It is an inert identifier here (the
		// platform is passwordless and this account has no usable password), so it is set directly.
		if ( $u->user_login !== self::HANDLE && ! username_exists( self::HANDLE ) ) {
			$wpdb->update( $wpdb->users, [ 'user_login' => self::HANDLE ], [ 'ID' => $uid ] );
		}
		wp_update_user( [ 'ID' => $uid, 'user_nicename' => self::HANDLE, 'display_name' => self::NAME, 'nickname' => self::NAME ] );
		clean_user_cache( $uid );
		self::stamp_identity( $uid );
		update_option( 'aq_arta_identity', self::IDENTITY_VERSION, true );
	}

	private static function stamp_identity( $uid ) {
		update_user_meta( $uid, 'aq_full_name', self::NAME ); // satisfies the identity gate, harmless
		update_user_meta( $uid, 'description', self::BIO );
		update_user_meta( $uid, '_aq_is_bot', 1 );
	}

	/** Profile/slug lookups: the old handle resolves to the account under its new name. */
	public static function resolve_alias( $slug ) {
		$s = strtolower( (string) $slug );
		return in_array( $s, self::ALIASES, true ) ? self::HANDLE : (string) $slug;
	}

	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// Recording mentions (called by every writer of public text)
	// ═════════════════════════════════════════════════════════════════════════════════════════════

	/**
	 * Read the @-mentions in a freshly written post or comment. Never throws.
	 *
	 * @param string $src_type  'post' | 'comment'
	 * @param int    $src_id    aq_posts.id | aq_comments.id
	 * @param int    $author    who wrote it
	 * @param string $body      its text
	 * @param string $ctx_type  'post' for feed posts; the comment's context_type otherwise
	 * @param int    $ctx_id    the root post id / the comment's context_id
	 * @param string $url       where the item can be read (for notifications)
	 * @return int  the aq_mentions id when Arta was mentioned and queued/limited, else 0
	 */
	public static function record( $src_type, $src_id, $author, $body, $ctx_type, $ctx_id, $url = '' ) {
		try {
			$handles = self::extract_handles( $body );
			if ( ! $handles ) { return 0; }
			$author = (int) $author;
			$me     = get_userdata( $author );
			$who    = $me ? $me->display_name : 'Someone';
			$wants_arta = false;
			foreach ( $handles as $h ) {
				if ( in_array( $h, self::ALIASES, true ) ) { $wants_arta = true; continue; }
				$u = get_user_by( 'slug', $h );
				if ( ! $u || (int) $u->ID === $author ) { continue; }
				Notify::push( (int) $u->ID, 'mention', $who . ' mentioned you', mb_substr( wp_strip_all_tags( (string) $body ), 0, 120 ), $url, 'm-' . $src_type . $src_id );
			}
			if ( ! $wants_arta ) { return 0; }
			$arta = self::uid();
			if ( ! $arta || $author === $arta || get_user_meta( $author, '_aq_is_bot', true ) ) { return 0; }
			return self::enqueue( $src_type, (int) $src_id, $author, (string) $body, (string) $ctx_type, (int) $ctx_id, $arta );
		} catch ( \Throwable $e ) {
			error_log( 'AQ Arta::record: ' . $e->getMessage() );
			return 0;
		}
	}

	private static function enqueue( $src_type, $src_id, $author, $body, $ctx_type, $ctx_id, $arta ) {
		self::ensure_tables();
		$T = Data::t( 'aq_mentions' );
		$existing = (int) Data::col( "SELECT id FROM $T WHERE src_type = %s AND src_id = %d AND target_uid = %d", [ $src_type, $src_id, $arta ] );
		if ( $existing ) { return $existing; }
		$now  = time();
		$live = "status <> 'limited'";
		$v = self::limit_verdict(
			(int) Data::col( "SELECT COUNT(*) FROM $T WHERE author_id = %d AND created >= %d AND $live", [ $author, $now - 3600 ] ),
			(int) Data::col( "SELECT COUNT(*) FROM $T WHERE author_id = %d AND created >= %d AND $live", [ $author, $now - 86400 ] ),
			(int) Data::col( "SELECT COUNT(*) FROM $T WHERE created >= %d AND $live", [ $now - 3600 ] ),
			(int) Data::col( "SELECT COUNT(*) FROM $T WHERE created >= %d AND $live", [ $now - 86400 ] )
		);
		global $wpdb;
		// INSERT IGNORE: two requests racing on the same source collapse onto the UNIQUE key.
		$wpdb->query( $wpdb->prepare(
			"INSERT IGNORE INTO $T (src_type, src_id, ctx_type, ctx_id, author_id, target_uid, status, hint, note, created, updated)
			 VALUES (%s, %d, %s, %d, %d, %d, %s, %s, %s, %d, %d)",
			$src_type, $src_id, $ctx_type, $ctx_id, $author, $arta,
			$v === 'ok' ? 'queued' : 'limited', self::is_bug_prefix( $body ) ? 'bug' : '',
			$v === 'ok' ? '' : 'limit:' . $v, $now, $now
		) );
		$id = (int) Data::col( "SELECT id FROM $T WHERE src_type = %s AND src_id = %d AND target_uid = %d", [ $src_type, $src_id, $arta ] );
		if ( ! $id ) { return 0; }
		if ( $v !== 'ok' ) {
			// Told once per hour, privately, so a member is not left wondering why Arta went quiet.
			Notify::push( $author, 'arta', 'Arta is taking a breather',
				$v === 'user'
					? 'You have reached Arta’s limit of ' . self::USER_PER_HOUR . ' mentions an hour (' . self::USER_PER_DAY . ' a day). Try again a little later.'
					: 'Arta is answering a lot of people right now. Please mention it again in a while.',
				'', 'arta-limit-' . $author . '-' . (int) floor( $now / 3600 ) );
			return $id;
		}
		return $id; // queued: the brain pulls it (arta/pending)
	}

	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// Is the brain there? (it pulls, so its polls are its heartbeat)
	// ═════════════════════════════════════════════════════════════════════════════════════════════

	/** The brain API is open only when a long-enough token is set (token_ok refuses otherwise). */
	public static function configured() {
		return strlen( (string) Secrets::get( 'AQ_ARTA_REPLY_TOKEN' ) ) >= 32;
	}

	/** Seconds since the brain last polled, or -1 if it never has. */
	public static function beat_age() {
		$b = (int) get_option( 'aq_arta_beat', 0 );
		return $b ? max( 0, time() - $b ) : -1;
	}

	private static function row( $id ) {
		self::ensure_tables();
		return Data::one( 'SELECT * FROM ' . Data::t( 'aq_mentions' ) . ' WHERE id = %d', [ (int) $id ] );
	}

	/** A public author card for the brain: handle and display name, never an email or anything private. */
	private static function who( $uid ) {
		$u = get_userdata( (int) $uid );
		return [ 'handle' => $u ? (string) $u->user_nicename : '', 'name' => $u ? (string) $u->display_name : 'Member', 'is_arta' => self::is_arta( $uid ) ];
	}

	/**
	 * Everything the brain needs to answer one mention — and only public things: the text, where it
	 * sits, the few items above it in the thread, and the public names of the people involved.
	 * Null when the source item has since been deleted (the mention is then skipped).
	 */
	public static function payload( $m ) {
		$src  = self::source( $m );
		if ( ! $src ) { return null; }
		$ctx  = [];
		$ids  = [];   // posts whose files travel with the mention: the mentioning post, then upwards
		if ( $m['src_type'] === 'dm' ) {
			$prev = Data::all( 'SELECT from_arta, body FROM ' . Data::t( 'aq_arta_dm' ) . ' WHERE user_id = %d AND id < %d ORDER BY id DESC LIMIT %d',
				[ (int) $src['user_id'], (int) $src['id'], self::DM_HISTORY ] );
			$me = self::who( $src['user_id'] );
			foreach ( array_reverse( (array) $prev ) as $p ) {
				$ctx[] = [ 'author' => (int) $p['from_arta'] ? self::who( self::known_uid() ) : $me, 'body' => mb_substr( (string) $p['body'], 0, 1500 ) ];
			}
			return [
				'id' => (int) $m['id'], 'hint' => (string) $m['hint'], 'created' => (int) $m['created'], 'max_chars' => self::DM_MAX,
				'private' => true,
				'source' => [ 'type' => 'dm', 'id' => (int) $src['id'], 'url' => home_url( '/messages/' ),
					'body' => mb_substr( (string) $src['body'], 0, 4000 ), 'author' => $me ],
				'context' => $ctx, 'attachments' => [],
			];
		}
		if ( $m['src_type'] === 'post' ) {
			$ids[] = (int) $src['id'];
			$pid = (int) $src['parent_id'];
			for ( $i = 0; $pid && $i < 4; $i++ ) {
				$p = Data::one( 'SELECT id, author_id, body, parent_id FROM ' . Data::t( 'aq_posts' ) . ' WHERE id = %d', [ $pid ] );
				if ( ! $p ) { break; }
				array_unshift( $ctx, [ 'author' => self::who( $p['author_id'] ), 'body' => (string) $p['body'] ] );
				$ids[] = (int) $p['id'];
				$pid = (int) $p['parent_id'];
			}
			$url = home_url( Notebook::post_url( (int) $src['id'] ) );
			$max = self::POST_MAX;
		} else {
			$pid = (int) $src['parent_id'];
			if ( $pid ) {
				$p = Data::one( 'SELECT author_id, body FROM ' . Data::t( 'aq_comments' ) . ' WHERE id = %d', [ $pid ] );
				if ( $p ) { $ctx[] = [ 'author' => self::who( $p['author_id'] ), 'body' => mb_substr( wp_strip_all_tags( (string) $p['body'] ), 0, 1500 ) ]; }
			}
			if ( $src['context_type'] === 'thread' ) {
				$t = Data::one( 'SELECT title, body FROM ' . Data::t( 'aq_threads' ) . ' WHERE id = %d', [ (int) $src['context_id'] ] );
				if ( $t ) { array_unshift( $ctx, [ 'author' => null, 'title' => (string) $t['title'], 'body' => mb_substr( wp_strip_all_tags( (string) $t['body'] ), 0, 1500 ) ] ); }
			} elseif ( $src['context_type'] === 'notebook' ) {
				$n = Data::one( 'SELECT title, abstract FROM ' . Data::t( 'aq_notebooks' ) . ' WHERE id = %d', [ (int) $src['context_id'] ] );
				if ( $n ) { array_unshift( $ctx, [ 'author' => null, 'title' => (string) $n['title'], 'body' => mb_substr( (string) $n['abstract'], 0, 1500 ) ] ); }
			}
			$url = self::comment_url( $src );
			$max = self::COMMENT_MAX;
		}
		return [
			'id'        => (int) $m['id'],
			'hint'      => (string) $m['hint'],
			'created'   => (int) $m['created'],
			'max_chars' => $max,
			'source'    => [
				'type'   => (string) $m['src_type'],
				'id'     => (int) $src['id'],
				'url'    => $url,
				'body'   => mb_substr( wp_strip_all_tags( (string) $src['body'] ), 0, 4000 ),
				'author' => self::who( $src['author_id'] ),
			],
			'context'   => $ctx,
			// Public files on the mentioning post and the posts above it ("@artabot what's this?" under a
			// picture). `skip` names why one is listed but not handed over: type | size | count.
			'attachments' => $ids ? self::attachments_for_posts( $ids ) : [],
		];
	}

	/**
	 * The Library files attached to these posts (nearest first), as the brain receives them. Only
	 * published files — the same join the feed uses — so nothing private or withdrawn can leak in.
	 */
	public static function attachments_for_posts( array $ids ) {
		$out = []; $taken = 0;
		foreach ( array_values( $ids ) as $i => $pid ) {
			$rows = Data::all(
				'SELECT l.name, l.label, l.mime, l.bytes, l.cdn_key FROM ' . Data::t( 'aq_post_media' ) . ' m'
				. ' JOIN ' . Data::t( 'aq_library' ) . ' l ON l.id = m.lib_id'
				. ' JOIN ' . Data::t( 'aq_notebooks' ) . " n ON n.id = l.nb_id AND n.status = 'published'"
				. ' WHERE m.post_id = %d ORDER BY m.pos, m.id', [ (int) $pid ] );
			foreach ( (array) $rows as $r ) {
				if ( count( $out ) >= self::ATTACH_LIST ) { break 2; }
				$mime  = strtolower( trim( (string) $r['mime'] ) );
				$bytes = (int) $r['bytes'];
				$skip  = '';
				if ( ! in_array( $mime, self::ATTACH_MIMES, true ) ) { $skip = 'type'; }
				elseif ( $bytes <= 0 || $bytes > self::ATTACH_BYTES ) { $skip = 'size'; }
				elseif ( $taken >= self::ATTACH_MAX ) { $skip = 'count'; }
				else { $taken++; }
				$name = basename( (string) ( $r['label'] !== '' && $r['label'] !== null ? $r['label'] : $r['name'] ) );
				$out[] = [
					'name' => mb_substr( $name, 0, 120 ), 'mime' => $mime, 'bytes' => $bytes,
					'url'  => Media::url( (string) $r['cdn_key'] ),
					'from' => $i === 0 ? 'mention' : 'parent', 'post_id' => (int) $pid, 'skip' => $skip,
				];
			}
		}
		return $out;
	}

	/** Arta's reply files, shaped like Library cards so the feed renders them as post attachments. */
	public static function files_for( $type, $id ) {
		if ( ! get_option( 'aq_arta_table_version' ) ) { return []; }
		self::ensure_tables(); // a one-time column add after an upgrade; a single option read otherwise
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_arta_files' ) . ' WHERE reply_type = %s AND reply_id = %d ORDER BY pos, id', [ (string) $type, (int) $id ] );
		return array_map( function ( $r ) {
			return [
				'id' => -(int) $r['id'], 'nb_id' => 0, 'name' => (string) $r['name'], 'label' => (string) $r['name'],
				'class' => (string) $r['class'], 'mime' => (string) $r['mime'], 'bytes' => (int) $r['bytes'],
				'sha256' => (string) $r['sha256'], 'url' => Media::url( (string) $r['cdn_key'] ), 'uses' => 0, 'mine' => false,
				'source' => (string) ( $r['source_url'] ?? '' ),
			];
		}, (array) $rows );
	}

	/** The account id Arta is known by, without creating it (cheap enough for every feed card). */
	public static function known_uid() {
		return (int) get_option( 'aq_artabot_uid', 0 );
	}

	/**
	 * What the bytes ARE, from their first bytes and (for text) their encoding — never from the name
	 * or the declared type. Returns one of REPLY_TYPES' keys, or '' to refuse. Images must also parse
	 * as images; text must be valid UTF-8 without NUL bytes, and JSON must parse. Anything executable,
	 * archived, HTML or SVG falls through to ''.
	 */
	public static function sniff( $path, $name ) {
		$fh = @fopen( $path, 'rb' );
		if ( ! $fh ) { return ''; }
		$head = (string) fread( $fh, 16 );
		fclose( $fh );
		$mime = '';
		if ( strncmp( $head, "\x89PNG\r\n\x1a\n", 8 ) === 0 ) { $mime = 'image/png'; }
		elseif ( strncmp( $head, "\xFF\xD8\xFF", 3 ) === 0 ) { $mime = 'image/jpeg'; }
		elseif ( strncmp( $head, 'GIF87a', 6 ) === 0 || strncmp( $head, 'GIF89a', 6 ) === 0 ) { $mime = 'image/gif'; }
		elseif ( strncmp( $head, 'RIFF', 4 ) === 0 && substr( $head, 8, 4 ) === 'WEBP' ) { $mime = 'image/webp'; }
		elseif ( strncmp( $head, '%PDF-', 5 ) === 0 ) { $mime = 'application/pdf'; }
		if ( $mime !== '' ) {
			if ( class_exists( 'finfo' ) ) {
				$fi = ( new \finfo( FILEINFO_MIME_TYPE ) )->file( $path );
				if ( is_string( $fi ) && $fi !== $mime && ! ( $mime === 'image/webp' && $fi === 'image/x-webp' ) ) { return ''; }
			}
			if ( strpos( $mime, 'image/' ) === 0 && function_exists( 'getimagesize' ) && ! @getimagesize( $path ) ) { return ''; }
			return $mime;
		}
		// Text: the whole file (≤ REPLY_FILE_BYTES) must be clean UTF-8.
		$text = (string) @file_get_contents( $path );
		if ( $text === '' || ! mb_check_encoding( $text, 'UTF-8' ) ) { return ''; }
		// Control characters (other than tab, newlines and form feed) mean binary — an archive or a
		// program whose first bytes happened to be printable.
		if ( preg_match( '/[\x00-\x08\x0B\x0E-\x1F\x7F]/', $text ) ) { return ''; }
		$lead = strtolower( ltrim( substr( $text, 0, 512 ), "\xEF\xBB\xBF \t\r\n" ) );
		foreach ( [ '<!doctype', '<html', '<svg', '<?xml', '<script', '<?php' ] as $bad ) {
			if ( strpos( $lead, $bad ) === 0 ) { return ''; }
		}
		$ext = strtolower( (string) pathinfo( (string) $name, PATHINFO_EXTENSION ) );
		if ( $ext === 'json' ) { return json_decode( $text ) !== null || trim( $text ) === 'null' ? 'application/json' : ''; }
		if ( $ext === 'csv' ) { return 'text/csv'; }
		if ( $ext === 'md' || $ext === 'markdown' ) { return 'text/markdown'; }
		return 'text/plain';
	}

	/**
	 * The files on a reply request (multipart field `files[]`), validated. Returns [ ok, dropped ]:
	 * ok = [ path, name, mime, ext, class, bytes, sha ]; dropped = human-readable reasons. Nothing is
	 * stored here — that happens only once this request has won the right to reply.
	 */
	public static function reply_files( $req ) {
		$real = is_object( $req ) && method_exists( $req, 'get_file_params' );
		$raw  = $real ? (array) $req->get_file_params() : (array) ( $req['_files'] ?? [] );
		$f    = $raw['files'] ?? ( $raw['files[]'] ?? [] );
		$list = [];
		if ( isset( $f['name'] ) && is_array( $f['name'] ) ) {
			foreach ( array_keys( $f['name'] ) as $k ) {
				$list[] = [ 'name' => $f['name'][ $k ] ?? '', 'tmp_name' => $f['tmp_name'][ $k ] ?? '', 'error' => $f['error'][ $k ] ?? 1 ];
			}
		} elseif ( isset( $f['name'] ) ) {
			$list[] = $f;
		} else {
			$list = array_values( array_filter( (array) $f, 'is_array' ) );
		}
		$ok = []; $dropped = []; $total = 0;
		foreach ( $list as $one ) {
			$name = preg_replace( '/[^A-Za-z0-9._ -]+/', '_', basename( (string) ( $one['name'] ?? 'file' ) ) );
			$name = trim( mb_substr( (string) $name, 0, 80 ), ' .' ) ?: 'file';
			$tmp  = (string) ( $one['tmp_name'] ?? '' );
			if ( count( $ok ) >= self::REPLY_FILES_MAX ) { $dropped[] = "$name: more than " . self::REPLY_FILES_MAX . ' files'; continue; }
			if ( (int) ( $one['error'] ?? 1 ) !== 0 || $tmp === '' || ! is_file( $tmp ) || ( $real && ! is_uploaded_file( $tmp ) ) ) { $dropped[] = "$name: upload failed"; continue; }
			$bytes = (int) filesize( $tmp );
			if ( $bytes <= 0 || $bytes > self::REPLY_FILE_BYTES ) { $dropped[] = "$name: size"; continue; }
			if ( $total + $bytes > self::REPLY_TOTAL_BYTES ) { $dropped[] = "$name: total size"; continue; }
			$mime = self::sniff( $tmp, $name );
			if ( $mime === '' || ! isset( self::REPLY_TYPES[ $mime ] ) ) { $dropped[] = "$name: type"; continue; }
			[ $ext, $class ] = self::REPLY_TYPES[ $mime ];
			$base  = (string) pathinfo( $name, PATHINFO_FILENAME );
			$total += $bytes;
			$ok[] = [ 'path' => $tmp, 'name' => ( $base !== '' ? $base : 'file' ) . '.' . $ext, 'mime' => $mime, 'ext' => $ext, 'class' => $class, 'bytes' => $bytes, 'sha' => hash_file( 'sha256', $tmp ) ];
		}
		return [ $ok, $dropped ];
	}


	private static function source( $m ) {
		if ( $m['src_type'] === 'dm' ) {
			return Data::one( 'SELECT * FROM ' . Data::t( 'aq_arta_dm' ) . ' WHERE id = %d AND from_arta = 0', [ (int) $m['src_id'] ] );
		}
		if ( $m['src_type'] === 'post' ) {
			return Data::one( 'SELECT * FROM ' . Data::t( 'aq_posts' ) . ' WHERE id = %d', [ (int) $m['src_id'] ] );
		}
		$c = Data::one( 'SELECT * FROM ' . Data::t( 'aq_comments' ) . ' WHERE id = %d', [ (int) $m['src_id'] ] );
		return $c && empty( $c['flagged'] ) ? $c : null;
	}

	private static function comment_url( $c ) {
		switch ( (string) $c['context_type'] ) {
			case 'thread':   return home_url( '/discussions/' . (int) $c['context_id'] . '/#c' . (int) $c['id'] );
			case 'notebook':
				$n = Data::one( 'SELECT slug FROM ' . Data::t( 'aq_notebooks' ) . ' WHERE id = %d', [ (int) $c['context_id'] ] );
				return home_url( '/nb/' . (int) $c['context_id'] . '/' . ( $n ? $n['slug'] : '' ) . '/#c' . (int) $c['id'] );
			default:         return home_url( '/' );
		}
	}

	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// REST — the brain's side (auth 'arta': X-Arta-Token / Bearer = AQ_ARTA_REPLY_TOKEN)
	// ═════════════════════════════════════════════════════════════════════════════════════════════

	/** Constant-time check of the brain's token. Closed by default: unset token = no access. */
	public static function token_ok() {
		$want = (string) Secrets::get( 'AQ_ARTA_REPLY_TOKEN' );
		if ( strlen( $want ) < 32 ) { return false; }
		$got = isset( $_SERVER['HTTP_X_ARTA_TOKEN'] ) ? (string) $_SERVER['HTTP_X_ARTA_TOKEN'] : '';
		if ( $got === '' && isset( $_SERVER['HTTP_AUTHORIZATION'] ) && preg_match( '/^Bearer\s+(\S+)$/', (string) $_SERVER['HTTP_AUTHORIZATION'], $mm ) ) {
			$got = $mm[1];
		}
		return $got !== '' && hash_equals( $want, $got );
	}

	/** POST arta/pending {status?, limit?, paused_until?} — the brain's poll: what is waiting, oldest first (POST so no cache can hold it). */
	public static function pending( $req ) {
		self::ensure_tables();
		// Every poll is the brain's heartbeat. `paused_until` (unix s, 0 = running) is the brain saying it
		// is at its own pace cap or signed out, so the public status can say "back at …" honestly.
		update_option( 'aq_arta_beat', time(), false );
		update_option( 'aq_arta_paused_until', max( 0, min( time() + 172800, Rest::pint( $req, 'paused_until', 0 ) ) ), false );
		$status = (string) Rest::p( $req, 'status', 'queued' );
		if ( ! in_array( $status, self::STATUSES, true ) ) { $status = 'queued'; }
		$limit  = max( 1, min( 50, Rest::pint( $req, 'limit', 25 ) ) );
		$rows   = Data::all( 'SELECT * FROM ' . Data::t( 'aq_mentions' ) . ' WHERE status = %s AND created >= %d ORDER BY id ASC LIMIT %d',
			[ $status, time() - self::MAX_AGE, $limit ] );
		$items = [];
		foreach ( (array) $rows as $r ) {
			$p = self::payload( $r );
			if ( $p ) { $items[] = $p; }
			else { self::set_status( (int) $r['id'], 'skipped', 'source deleted' ); }
		}
		return [ 'items' => $items ];
	}

	/**
	 * POST arta/mentions/{id}/claim — atomically take a queued mention (or one whose earlier claim
	 * went stale). Exactly one caller wins; the rest get 409 and move on. This is what stops two
	 * brain processes (a restart overlapping the old one) from both answering the same mention.
	 */
	public static function claim( $req ) {
		self::ensure_tables();
		global $wpdb;
		$id  = Rest::pint( $req, 'id' );
		$now = time();
		$n   = $wpdb->query( $wpdb->prepare(
			'UPDATE ' . Data::t( 'aq_mentions' ) . " SET status = 'working', claimed_at = %d, updated = %d
			  WHERE id = %d AND reply_id = 0 AND ( status = 'queued' OR ( status = 'working' AND claimed_at < %d ) )",
			$now, $now, $id, $now - self::CLAIM_TTL ) );
		if ( ! $n ) {
			$m = self::row( $id );
			return Rest::err( 'not_claimable', $m ? 'Mention is ' . $m['status'] : 'No such mention', $m ? 409 : 404 );
		}
		$m = self::row( $id );
		$p = $m ? self::payload( $m ) : null;
		if ( ! $p ) { self::set_status( $id, 'skipped', 'source deleted' ); return Rest::err( 'gone', 'The post was deleted', 410 ); }
		return [ 'ok' => true, 'mention' => $p ];
	}

	/** POST arta/mentions/{id}/status {status: skipped|failed|queued, note} — the brain lets go. */
	public static function status( $req ) {
		$id = Rest::pint( $req, 'id' );
		$st = (string) Rest::p( $req, 'status', '' );
		if ( ! in_array( $st, [ 'skipped', 'failed', 'queued' ], true ) ) { return Rest::err( 'bad_status', 'status must be skipped, failed or queued' ); }
		$m = self::row( $id );
		if ( ! $m ) { return Rest::err( 'not_found', 'No such mention', 404 ); }
		if ( (int) $m['reply_id'] ) { return Rest::err( 'already_replied', 'This mention was answered', 409 ); }
		self::set_status( $id, $st, sanitize_text_field( (string) Rest::p( $req, 'note', '' ) ) );
		return [ 'ok' => true, 'id' => $id, 'status' => $st ];
	}

	private static function set_status( $id, $status, $note = '' ) {
		Data::update( 'aq_mentions', [ 'status' => $status, 'note' => mb_substr( (string) $note, 0, 190 ), 'updated' => time() ], [ 'id' => (int) $id ] );
	}

	/**
	 * POST arta/reply {mention_id, body, kind?: answer|bug|declined, issue_url?, issue_number?, issue_title?}
	 * — JSON, or multipart/form-data with up to REPLY_FILES_MAX files in `files[]` (see reply_files).
	 *
	 * Writes Arta's public reply in the mention's own thread — EXACTLY ONCE. The row is moved to
	 * `replying` with a conditional UPDATE before anything is written, so two concurrent calls cannot
	 * both reply; a call for an already-answered mention returns the existing reply with
	 * duplicate:true (200), which makes the brain's retries safe.
	 */
	public static function reply( $req ) {
		self::ensure_tables();
		global $wpdb;
		$id = Rest::pint( $req, 'mention_id' );
		$m  = self::row( $id );
		if ( ! $m ) { return Rest::err( 'not_found', 'No such mention', 404 ); }
		if ( (int) $m['reply_id'] ) {
			return [ 'ok' => true, 'duplicate' => true, 'reply_type' => $m['reply_type'], 'reply_id' => (int) $m['reply_id'], 'url' => self::reply_url( $m ) ];
		}
		$kind  = (string) Rest::p( $req, 'kind', 'answer' );
		$kind  = in_array( $kind, [ 'answer', 'bug', 'declined' ], true ) ? $kind : 'answer';
		$issue = esc_url_raw( (string) Rest::p( $req, 'issue_url', '' ) );
		if ( $issue !== '' && ! preg_match( '#^https://github\.com/ArtaQuest/[A-Za-z0-9_.-]+/issues/[0-9]+$#', $issue ) ) { $issue = ''; }
		$dm   = $m['src_type'] === 'dm';
		$max  = $dm ? self::DM_MAX : ( $m['src_type'] === 'post' ? self::POST_MAX : self::COMMENT_MAX );
		$body = self::sanitize_reply( (string) Rest::p( $req, 'body', '' ), $max );
		if ( mb_strlen( $body ) < 2 ) { return Rest::err( 'empty', 'Reply body is empty' ); }
		[ $files, $dropped ] = self::reply_files( $req );
		// Files would go to the PUBLIC media store, which a private chat must never feed. Refused.
		if ( $dm && $files ) { foreach ( $files as $f ) { $dropped[] = $f['name'] . ': not in private chat'; } $files = []; }
		$sources = self::file_sources( Rest::p( $req, 'sources', '' ) );

		$now = time();
		$won = $wpdb->query( $wpdb->prepare(
			'UPDATE ' . Data::t( 'aq_mentions' ) . " SET status = 'replying', updated = %d WHERE id = %d AND reply_id = 0 AND status NOT IN ( 'replying', 'replied' )",
			$now, $id ) );
		if ( ! $won ) {
			$m = self::row( $id );
			if ( $m && (int) $m['reply_id'] ) {
				return [ 'ok' => true, 'duplicate' => true, 'reply_type' => $m['reply_type'], 'reply_id' => (int) $m['reply_id'], 'url' => self::reply_url( $m ) ];
			}
			return Rest::err( 'in_progress', 'Another reply to this mention is being written', 409 );
		}
		$src = self::source( $m );
		if ( ! $src ) { self::set_status( $id, 'skipped', 'source deleted' ); return Rest::err( 'gone', 'The post was deleted', 410 ); }

		// Files are stored only now that this request owns the reply. Content-addressed keys make a
		// retry's second store of the same bytes a no-op overwrite of identical content.
		$stored = [];
		foreach ( $files as $f ) {
			$key = 'arta/' . $f['sha'] . '.' . $f['ext'];
			if ( Media::put_public_file( $key, $f['path'], $f['mime'] ) ) { $stored[] = $f + [ 'key' => $key ]; }
			else { $dropped[] = $f['name'] . ': store failed'; }
		}
		// A comment has no attachment strip, so its files are listed under the text as links.
		if ( $stored && $m['src_type'] !== 'post' ) {
			$list = "\n\nFiles:";
			foreach ( $stored as $f ) { $list .= "\n" . $f['name'] . ' — ' . Media::url( $f['key'] ); }
			$body = self::clip( $body, max( 20, $max - mb_strlen( $list ) ) ) . $list;
		}

		$arta = self::uid();
		[ $type, $rid ] = $dm
			? [ 'dm', Data::insert( 'aq_arta_dm', [ 'user_id' => (int) $src['user_id'], 'from_arta' => 1, 'body' => $body, 'mention_id' => $id, 'created' => time() ] ) ]
			: ( $m['src_type'] === 'post'
				? [ 'post', Notebook::insert_reply( $arta, (int) $src['id'], $body ) ]
				: [ 'comment', self::insert_comment_reply( $arta, $src, $body ) ] );
		if ( ! $rid ) {
			self::set_status( $id, 'queued', 'reply insert failed' );
			return Rest::err( 'server_error', 'Could not write the reply', 500 );
		}
		foreach ( array_values( $stored ) as $pos => $f ) {
			Data::insert( 'aq_arta_files', [
				'mention_id' => $id, 'reply_type' => $type, 'reply_id' => (int) $rid, 'pos' => $pos,
				'name' => $f['name'], 'class' => $f['class'], 'mime' => $f['mime'], 'bytes' => $f['bytes'],
				'sha256' => $f['sha'], 'cdn_key' => $f['key'], 'source_url' => $sources[ $f['name'] ] ?? '', 'created' => time(),
			] );
		}
		Data::update( 'aq_mentions', [
			'status' => 'replied', 'reply_type' => $type, 'reply_id' => (int) $rid, 'kind' => $kind,
			'issue_url' => $issue, 'updated' => time(),
		], [ 'id' => $id ] );
		$m = self::row( $id );
		$url = self::reply_url( $m );
		Notify::push( (int) $m['author_id'], 'arta', 'Arta replied to you', mb_substr( $body, 0, 140 ), wp_make_link_relative( $url ), 'arta-reply-' . $id );
		if ( $kind === 'bug' && $issue !== '' && ! $dm ) {
			self::link_ticket( $m, $src, (string) Rest::p( $req, 'issue_title', '' ), $issue );
		}
		return [ 'ok' => true, 'duplicate' => false, 'reply_type' => $type, 'reply_id' => (int) $rid, 'url' => $url, 'files' => count( $stored ), 'dropped' => $dropped ];
	}

	private static function reply_url( $m ) {
		if ( $m['reply_type'] === 'dm' || $m['src_type'] === 'dm' ) { return home_url( '/messages/?arta=1' ); }
		if ( $m['reply_type'] === 'post' ) { return home_url( Notebook::post_url( (int) $m['reply_id'] ) ); }
		$c = Data::one( 'SELECT * FROM ' . Data::t( 'aq_comments' ) . ' WHERE id = %d', [ (int) $m['reply_id'] ] );
		return $c ? self::comment_url( $c ) : home_url( '/' );
	}

	/** Arta's reply under a comment: same context, nested under the comment that mentioned it. */
	private static function insert_comment_reply( $arta, $c, $body ) {
		$id = Data::insert( 'aq_comments', [
			'context_type' => (string) $c['context_type'], 'context_id' => (int) $c['context_id'],
			'course_id' => (int) ( $c['course_id'] ?? 0 ), 'parent_id' => (int) $c['id'],
			'author_id' => (int) $arta, 'body' => $body, 'lang' => (string) ( $c['lang'] ?? 'en' ) ?: 'en',
			'flagged' => 0, 'modq' => 0, 'created' => Data::now(),
		] );
		if ( ! $id ) { return 0; }
		Data::bump( 'aq_comments', [ 'id' => (int) $c['id'] ], 'reply_count', 1 );
		if ( $c['context_type'] === 'thread' ) { Data::bump( 'aq_threads', [ 'id' => (int) $c['context_id'] ], 'comment_count', 1 ); }
		if ( $c['context_type'] === 'notebook' ) { Data::bump( 'aq_notebooks', [ 'id' => (int) $c['context_id'] ], 'comments' ); }
		return (int) $id;
	}

	/**
	 * Mirror a filed bug into /issues so the contribution page, its Sentinel points and the member's
	 * own list keep working. The ticket carries the GitHub link; the GitHub issue is the record.
	 */
	private static function link_ticket( $m, $src, $title, $issue ) {
		try {
			$title = sanitize_text_field( $title !== '' ? $title : wp_trim_words( wp_strip_all_tags( (string) $src['body'] ), 10, '…' ) );
			$body  = wp_strip_all_tags( (string) $src['body'] );
			if ( mb_strlen( $title ) < 4 ) { $title = 'Bug reported to @artabot'; }
			if ( mb_strlen( $body ) < 10 ) { $body = $body . ' (reported to @artabot)'; }
			$t = Tickets::open_from_arta( (int) $m['author_id'], $title, $body, self::reply_url( $m ), $issue );
			return $t;
		} catch ( \Throwable $e ) {
			error_log( 'AQ Arta::link_ticket: ' . $e->getMessage() );
			return null;
		}
	}

	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// REST — the member's PRIVATE chat with Arta (auth 'user'). Same queue, limits and brain as the
	// public mentions; only the place the answer lands differs (aq_arta_dm, visible to this member).
	// ═════════════════════════════════════════════════════════════════════════════════════════════

	/** One chat turn as the member's client sees it. */
	private static function dm_row( $r ) {
		return [ 'id' => (int) $r['id'], 'from_arta' => (bool) (int) $r['from_arta'], 'body' => (string) $r['body'], 'created' => (int) $r['created'] ];
	}

	/** GET arta/dm?after= — my private chat with Arta (newest 50, oldest first) and where my last question is. */
	public static function dm_list( $req ) {
		self::ensure_tables();
		$uid   = Rest::uid();
		$after = max( 0, Rest::pint( $req, 'after', 0 ) );
		$D     = Data::t( 'aq_arta_dm' );
		$rows  = $after
			? Data::all( "SELECT * FROM $D WHERE user_id = %d AND id > %d ORDER BY id ASC LIMIT 50", [ $uid, $after ] )
			: array_reverse( (array) Data::all( "SELECT * FROM $D WHERE user_id = %d ORDER BY id DESC LIMIT 50", [ $uid ] ) );
		$T    = Data::t( 'aq_mentions' );
		$last = Data::one( "SELECT id, status, note, created FROM $T WHERE src_type = 'dm' AND author_id = %d ORDER BY id DESC LIMIT 1", [ $uid ] );
		$pending = null;
		if ( $last && in_array( $last['status'], [ 'queued', 'working', 'replying', 'limited' ], true ) && (int) $last['created'] >= time() - self::MAX_AGE ) {
			$pos = $last['status'] === 'queued'
				? 1 + (int) Data::col( "SELECT COUNT(*) FROM $T WHERE status IN ('queued','working') AND created >= %d AND id < %d", [ time() - self::MAX_AGE, (int) $last['id'] ] )
				: 0;
			$pending = [ 'status' => (string) $last['status'], 'position' => $pos ];
		}
		$st = self::public_status( $req );
		return [ 'items' => array_map( [ self::class, 'dm_row' ], (array) $rows ), 'pending' => $pending,
			'online' => $st['online'], 'enabled' => $st['enabled'], 'paused_until' => $st['paused_until'] ];
	}

	/** POST arta/dm {body} — ask Arta privately. Queued exactly like a mention (same per-member limits). */
	public static function dm_send( $req ) {
		self::ensure_tables();
		$uid  = Rest::uid();
		$body = trim( wp_strip_all_tags( (string) Rest::p( $req, 'body', '' ) ) );
		if ( mb_strlen( $body ) < 1 ) { return Rest::err( 'empty', 'Write something first' ); }
		if ( mb_strlen( $body ) > self::DM_MAX ) { return Rest::err( 'too_long', 'Keep it under ' . self::DM_MAX . ' characters' ); }
		$arta = self::uid();
		if ( ! $arta || self::is_arta( $uid ) ) { return Rest::err( 'unavailable', 'Arta is not available', 503 ); }
		$id = (int) Data::insert( 'aq_arta_dm', [ 'user_id' => $uid, 'from_arta' => 0, 'body' => $body, 'mention_id' => 0, 'created' => time() ] );
		if ( ! $id ) { return Rest::err( 'server_error', 'Could not save your message', 500 ); }
		$mid = self::enqueue( 'dm', $id, $uid, $body, 'dm', $uid, $arta );
		if ( $mid ) { Data::update( 'aq_arta_dm', [ 'mention_id' => $mid ], [ 'id' => $id ] ); }
		$m = $mid ? self::row( $mid ) : null;
		return [ 'ok' => true, 'item' => self::dm_row( Data::one( 'SELECT * FROM ' . Data::t( 'aq_arta_dm' ) . ' WHERE id = %d', [ $id ] ) ),
			'status' => $m ? (string) $m['status'] : 'failed' ];
	}

	/** POST arta/dm/clear — delete my whole private chat with Arta (both sides). */
	public static function dm_clear( $req ) {
		self::ensure_tables();
		global $wpdb;
		$uid = Rest::uid();
		$n = (int) $wpdb->query( $wpdb->prepare( 'DELETE FROM ' . Data::t( 'aq_arta_dm' ) . ' WHERE user_id = %d', $uid ) );
		// Unanswered questions go too, so the brain cannot answer into a chat that no longer exists.
		$wpdb->query( $wpdb->prepare( 'UPDATE ' . Data::t( 'aq_mentions' ) . " SET status = 'skipped', note = 'chat cleared', updated = %d WHERE src_type = 'dm' AND author_id = %d AND status IN ('queued','working','limited')", time(), $uid ) );
		return [ 'ok' => true, 'deleted' => $n ];
	}

	/** GET arta/status — public: is Arta wired up, and how much is waiting. For smoke tests and the UI. */
	public static function public_status( $req ) {
		self::ensure_tables();
		$T = Data::t( 'aq_mentions' );
		return [
			'handle'   => self::HANDLE,
			'name'     => self::NAME,
			'enabled'  => self::configured(),
			'online'   => self::configured() && self::beat_age() >= 0 && self::beat_age() <= self::BEAT_FRESH,
			'paused_until' => (int) get_option( 'aq_arta_paused_until', 0 ) > time() ? (int) get_option( 'aq_arta_paused_until', 0 ) : 0,
			'queued'   => (int) Data::col( "SELECT COUNT(*) FROM $T WHERE status IN ('queued','working') AND created >= %d", [ time() - self::MAX_AGE ] ),
			'replied_24h' => (int) Data::col( "SELECT COUNT(*) FROM $T WHERE status = 'replied' AND updated >= %d", [ time() - 86400 ] ),
			'limits'   => [ 'user_per_hour' => self::USER_PER_HOUR, 'user_per_day' => self::USER_PER_DAY ],
		];
	}

	/**
	 * GET arta/watch/{id} — public: where Arta is with the mentions in ONE thread (post {id} and its
	 * direct replies), so the page that asked can show "Queued #3" / "thinking…" / "offline" instead
	 * of a sentence that is right only half the time, and stop polling the moment the answer lands.
	 * Everything here is already public (the posts are public, the queue length is on arta/status);
	 * no author, body or note leaves this route — only statuses and positions.
	 */
	public static function watch( $req ) {
		self::ensure_tables();
		$id   = (int) Rest::pint( $req, 'id', 0 );
		$arta = self::known_uid();
		$st   = self::public_status( $req );
		$out  = [ 'online' => $st['online'], 'enabled' => $st['enabled'], 'paused_until' => $st['paused_until'], 'queued' => $st['queued'], 'items' => [] ];
		if ( $id <= 0 || ! $arta ) { return $out; }
		$rows = Data::all( 'SELECT id FROM ' . Data::t( 'aq_posts' ) . ' WHERE id = %d OR parent_id = %d ORDER BY id DESC LIMIT 60', [ $id, $id ] );
		$ids  = array_map( 'intval', array_column( (array) $rows, 'id' ) );
		if ( ! $ids ) { return $out; }
		$T  = Data::t( 'aq_mentions' );
		$in = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
		$ms = Data::all( "SELECT id, src_id, status, reply_id, created FROM $T WHERE src_type = 'post' AND target_uid = %d AND src_id IN ($in) ORDER BY id", array_merge( [ $arta ], $ids ) );
		$since = time() - self::MAX_AGE;
		foreach ( (array) $ms as $m ) {
			$s   = (string) $m['status'];
			$pos = 0;
			if ( $s === 'queued' ) {
				$pos = 1 + (int) Data::col( "SELECT COUNT(*) FROM $T WHERE status IN ('queued','working') AND created >= %d AND id < %d", [ $since, (int) $m['id'] ] );
			}
			$out['items'][] = [ 'post_id' => (int) $m['src_id'], 'status' => $s, 'position' => $pos, 'reply_id' => (int) $m['reply_id'] ];
		}
		return $out;
	}

	/**
	 * Arta's picture: upper-body crop of artalife's official think() pose (assets/arta/). Same
	 * skeleton/colour/stroke as the companion the footer draws. A code-level override
	 * (Verify::own_picture asks here first), so it holds in every environment without a migration
	 * and cannot be replaced by an upload to the bot account.
	 */
	public static function avatar_url() {
		static $v = null;
		if ( $v === null ) {
			// Cache-bust by CONTENT, not by a hand-kept number: the edge caches this file for years, keyed
			// by query string, so a hand-bumped ?v= that anyone fetches before the deploy lands keeps the
			// old picture forever. A hash of the bytes changes exactly when the picture does.
			$file = ( defined( 'AQ_DIR' ) ? AQ_DIR : dirname( __DIR__ ) ) . '/assets/arta/arta-thinking.svg';
			$h    = is_readable( $file ) ? @md5_file( $file ) : false;
			$v    = $h ? substr( $h, 0, 10 ) : '2';
		}
		$base = defined( 'AQ_URL' ) ? AQ_URL : '';
		return $base . '/assets/arta/arta-thinking.svg?v=' . $v;
	}

	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// Housekeeping (cron, every 5 minutes): expire what is too old, free what a dead brain held
	// ═════════════════════════════════════════════════════════════════════════════════════════════

	public static function reconcile_tick() {
		self::ensure_tables();
		global $wpdb;
		$T   = Data::t( 'aq_mentions' );
		$now = time();
		// Expire what is too old to answer usefully.
		$wpdb->query( $wpdb->prepare( "UPDATE $T SET status = 'expired', updated = %d WHERE status IN ('queued','working') AND created < %d", $now, $now - self::MAX_AGE ) );
		// A claim whose brain died goes back on the queue.
		$wpdb->query( $wpdb->prepare( "UPDATE $T SET status = 'queued', updated = %d WHERE status = 'working' AND claimed_at < %d", $now, $now - self::CLAIM_TTL ) );
		// A reply interrupted between its two writes (no reply id) is re-queued; the reply route is idempotent.
		$wpdb->query( $wpdb->prepare( "UPDATE $T SET status = 'queued', updated = %d WHERE status = 'replying' AND reply_id = 0 AND updated < %d", $now, $now - 300 ) );
	}
}
