<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaChat — end-to-end encrypted direct messages (X-style device keys, 2026-07-13).
 *
 * The entire database is public by design (the /data/ explorer serves every row), so the server
 * NEVER sees a message in plaintext. Each member's browser generates a NIST P-256 ECDH keypair
 * with the private half non-extractable, stored only in that device's IndexedDB; the public half
 * is registered here. A conversation key is derived client-side (ECDH → HKDF-SHA-256 →
 * AES-256-GCM), and every row in aq_chat_msgs is ciphertext + IV. Publishing the whole table
 * changes nothing: recovering one message without a participant's device key is a ~2^128
 * elliptic-curve problem — not reachable with normal (or national) compute.
 *
 * What the public CAN see is the metadata — who talked to whom, when, and how many bytes. That
 * is the honest radical-transparency trade: content sealed, existence public.
 *
 * Key history is append-only (aq_chat_keys): a member who clears their browser or moves device
 * registers a NEW key; old ciphertext stays bound to the key ids it was sealed for (akid/bkid on
 * each message) and simply becomes undecipherable to the new device — exactly X's behaviour, and
 * the only honest one (the server has nothing to re-encrypt with).
 */
final class Chat {

	const TABLE_VERSION = '2';

	/** Uncompressed P-256 point (0x04 ‖ X ‖ Y = 65 bytes) as base64 — the only accepted pub format. */
	const PUB_B64_LEN = 88;
	/** Ciphertext cap per message (base64). ~15 KB plaintext — a DM, not a file drop (files go
	 *  through the encrypted blob store; only the sealed pointer travels in the message). */
	const CT_MAX = 20000;
	/** Encrypted attachment cap (bytes, already-sealed). Images + voice notes. */
	const BLOB_MAX = 6000000;
	/** Per-member attachment budget per rolling day — the per-minute throttle alone would still
	 *  let one hostile account write ~7 GB/hour of opaque blobs to disk. */
	const BLOB_DAY_MAX = 200000000; // 200 MB
	/** The disappearing-message timers a chat can choose from (0 = keep forever). */
	const TTLS = [ 0, 3600, 86400, 604800 ];
	/** Typing signal lifetime (s) — a client re-pings while the member keeps typing. */
	const TYPING_S = 6;
	/** Presence lifetime (s) — refreshed by every chat list/messages poll. */
	const PRESENCE_S = 40;
	/** Largest ciphertext (base64 chars) the conversation list will carry for a one-line preview.
	 *  ~3 KB plaintext — far more than a preview shows, and it keeps a 50-conversation list from
	 *  putting a megabyte of body text on the wire every 15 seconds. */
	const PREVIEW_CT_MAX = 4000;

	public static function ensure_tables() {
		if ( get_option( 'aq_chat_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		$p       = $wpdb->prefix;
		// Append-only key registry: one row per registered device key, latest row per user = active.
		dbDelta( "CREATE TABLE {$p}aq_chat_keys (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			pub VARCHAR(96) NOT NULL DEFAULT '',
			fp VARCHAR(64) NOT NULL DEFAULT '',
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY user_id_id (user_id, id)
		) {$charset};" );
		// One row per 1:1 conversation; the pair is stored ordered (a < b) so it's unique.
		// a_read/b_read are read watermarks (last message id each side has seen); `ttl` is the
		// disappearing-message timer both parties see (0 = keep; else seconds a row lives).
		dbDelta( "CREATE TABLE {$p}aq_chats (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			a_uid BIGINT UNSIGNED NOT NULL DEFAULT 0,
			b_uid BIGINT UNSIGNED NOT NULL DEFAULT 0,
			last_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			last_at INT UNSIGNED NOT NULL DEFAULT 0,
			a_read BIGINT UNSIGNED NOT NULL DEFAULT 0,
			b_read BIGINT UNSIGNED NOT NULL DEFAULT 0,
			ttl INT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY pair (a_uid, b_uid),
			KEY a_last (a_uid, last_id),
			KEY b_last (b_uid, last_id)
		) {$charset};" );
		// The sealed messages. iv/ct are base64; akid/bkid are the aq_chat_keys ids the sender
		// derived the conversation key from (a = the pair's low uid, b = the high uid), so every
		// ciphertext row names exactly which public keys can open it — forever, even after rotation.
		// EVERY row is shape-identical whatever it carries (text, reaction, reply, edit, delete
		// marker, attachment pointer) — the type lives INSIDE the sealed payload, so the public DB
		// can't even tell a reaction from an essay. `blob` (optional) names the sealed attachment
		// file so the TTL purge / unsend can unlink it — the decryption key for it never leaves
		// the sealed payload.
		dbDelta( "CREATE TABLE {$p}aq_chat_msgs (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			chat_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			sender_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			akid BIGINT UNSIGNED NOT NULL DEFAULT 0,
			bkid BIGINT UNSIGNED NOT NULL DEFAULT 0,
			iv VARCHAR(32) NOT NULL DEFAULT '',
			ct TEXT NULL,
			blob VARCHAR(191) NOT NULL DEFAULT '',
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY chat_id_id (chat_id, id)
		) {$charset};" );
		// dbDelta adds new columns on MySQL, but the SQLite dev integration can skip ALTERs on an
		// existing table — add the v2 columns explicitly when absent (a no-op where dbDelta did it).
		foreach ( [ [ 'aq_chats', 'ttl', 'INT UNSIGNED NOT NULL DEFAULT 0' ],
					[ 'aq_chat_msgs', 'blob', "VARCHAR(191) NOT NULL DEFAULT ''" ] ] as [ $t, $col, $def ] ) {
			$cols = $wpdb->get_col( "SHOW COLUMNS FROM {$p}{$t}" );
			if ( $cols && ! in_array( $col, $cols, true ) ) {
				$wpdb->query( "ALTER TABLE {$p}{$t} ADD COLUMN `$col` $def" );
			}
		}
		update_option( 'aq_chat_table_version', self::TABLE_VERSION, true );
	}

	// ── Helpers ─────────────────────────────────────────────────────────────

	/** The caller's + peer's ordered pair (low, high). */
	private static function pair( $u1, $u2 ) {
		return $u1 < $u2 ? [ (int) $u1, (int) $u2 ] : [ (int) $u2, (int) $u1 ];
	}

	private static function chat_row( $u1, $u2 ) {
		[ $a, $b ] = self::pair( $u1, $u2 );
		return Data::one( 'SELECT * FROM ' . Data::t( 'aq_chats' ) . ' WHERE a_uid = %d AND b_uid = %d', [ $a, $b ] );
	}

	/** A member's ACTIVE (latest) public key row, or null when they never enabled chat. */
	private static function active_key( $uid ) {
		return Data::one(
			'SELECT id, pub, fp, created FROM ' . Data::t( 'aq_chat_keys' ) . ' WHERE user_id = %d ORDER BY id DESC LIMIT 1',
			[ (int) $uid ]
		);
	}

	private static function user_card( $uid ) {
		$u = get_userdata( (int) $uid );
		return [
			'id'     => (int) $uid,
			'name'   => $u ? $u->display_name : 'Quester',
			'slug'   => $u ? $u->user_nicename : '',
			'avatar' => class_exists( '\\AQ\\Verify' ) ? Verify::avatar_url( (int) $uid, 96 ) : '',
		];
	}

	private static function key_payload( $row ) {
		return $row ? [
			'kid'     => (int) $row['id'],
			'pub'     => (string) $row['pub'],
			'fp'      => (string) $row['fp'],
			'created' => (int) $row['created'],
		] : null;
	}

	// ── Liveness (typing + presence) — pure transients, nothing rests in the DB ──

	/**
	 * Refresh the caller's "active now" beacon.
	 *
	 * Presence means "IN a conversation", not "has ArtaQuest open". That distinction is the whole
	 * point: Chat::send only rings the bell and sends the away-email when the recipient is NOT
	 * online, so anything that marks presence on a routine background poll switches those
	 * notifications off. Listing conversations used to do exactly that — so a member who left the
	 * Messages tab open (or, once the dock shipped, ANY tab) was permanently "online" and silently
	 * received no bell and no email for the rest of the session. Only opening a thread
	 * (Chat::messages) or typing in one (Chat::typing) marks presence now.
	 */
	private static function mark_presence( $uid, $chat_id = 0 ) {
		set_transient( 'aq_chat_on_' . (int) $uid, time(), self::PRESENCE_S );
		// …and, when we know WHICH conversation, a per-chat beacon. See in_chat() for why the
		// global flag alone is not safe to gate notifications on.
		if ( $chat_id ) { set_transient( 'aq_chat_in_' . (int) $uid . '_' . (int) $chat_id, 1, self::PRESENCE_S ); }
	}

	/**
	 * Is this member sitting in THIS conversation right now?
	 *
	 * The notification gate has to ask that, not "are they anywhere in chat". The dock keeps a
	 * thread open across page navigation, and its poller marks presence every few seconds — so with
	 * a single global flag, one member reading a conversation with Bob for an hour would look
	 * present to Carol, Dave and Erin too, and every message they sent would arrive with no bell
	 * and no email. Silence from the people you are NOT talking to is the worst failure this
	 * feature has, because nothing on screen shows it is happening.
	 */
	private static function in_chat( $uid, $chat_id ) {
		return $chat_id ? (bool) get_transient( 'aq_chat_in_' . (int) $uid . '_' . (int) $chat_id ) : false;
	}

	/**
	 * GET chat/unread — the caller's total unread count, and nothing else.
	 *
	 * Deliberately does NOT mark presence: this is what the always-present chat dock polls from
	 * every page, and a badge refresh must never be mistaken for the member sitting in a
	 * conversation (see mark_presence). One indexed COUNT over the conversations they're in.
	 */
	public static function unread( $req ) {
		self::ensure_tables();
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$n = (int) Data::col(
			'SELECT COUNT(*) FROM ' . Data::t( 'aq_chat_msgs' ) . ' m JOIN ' . Data::t( 'aq_chats' ) . ' c ON c.id = m.chat_id'
			. ' WHERE ( c.a_uid = %d OR c.b_uid = %d ) AND m.sender_id != %d'
			// Skip conversations with nothing unread BEFORE touching the message table — last_id is
			// the cheap denormalised watermark the list already keeps, and it keeps this badge poll
			// off aq_chat_msgs entirely for every conversation the member is caught up on.
			. ' AND c.last_id > ( CASE WHEN c.a_uid = %d THEN c.a_read ELSE c.b_read END )'
			. ' AND m.id > ( CASE WHEN c.a_uid = %d THEN c.a_read ELSE c.b_read END )'
			// Never count a message the disappearing-message timer has already retired. Rows are
			// purged lazily (on the next read of that chat), so between expiry and purge they still
			// exist — and a badge that counts messages the member can never open is just a lie that
			// cannot be cleared by reading.
			. ' AND ( c.ttl = 0 OR m.created >= %d - c.ttl )',
			[ $uid, $uid, $uid, $uid, $uid, Data::now() ]
		);
		return [ 'unread' => $n ];
	}

	private static function online( $uid ) {
		return (bool) get_transient( 'aq_chat_on_' . (int) $uid );
	}

	/**
	 * The encrypted-attachment directory (uploads/aq-chat), created and HARDENED on first use.
	 *
	 * These files must stay publicly fetchable — the recipient's browser downloads the .bin over
	 * plain HTTP and decrypts it with the key that travelled inside the sealed message — so this is
	 * deliberately not the deny-all guard uploads/bursary-docs uses. What it does stop is the rest:
	 * no directory listing (the names are unguessable, but the DB that lists them is public, so
	 * listing would only add convenience), and no chance of a stored blob ever being interpreted as
	 * anything but opaque bytes — chat/blob necessarily accepts arbitrary content, since ciphertext
	 * is indistinguishable from anything else.
	 *
	 * Apache-only, honestly: production is WordPress.com Atomic behind nginx, which ignores
	 * .htaccess. The index.php stops listing everywhere, and the served Content-Type for .bin is
	 * application/octet-stream on both, which is what actually keeps a blob from executing.
	 */
	private static function blob_dir() {
		$up  = wp_upload_dir();
		$dir = trailingslashit( $up['basedir'] ) . 'aq-chat';
		if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		if ( is_dir( $dir ) && ! file_exists( $dir . '/index.php' ) ) {
			file_put_contents( $dir . '/index.php', "<?php\n// Silence is golden.\n" );
		}
		if ( is_dir( $dir ) && ! file_exists( $dir . '/.htaccess' ) ) {
			file_put_contents(
				$dir . '/.htaccess',
				"Options -Indexes\n"
				. "<IfModule mod_headers.c>\n"
				. "Header set X-Content-Type-Options nosniff\n"
				. "Header set Content-Disposition attachment\n"
				. "</IfModule>\n"
				. "<FilesMatch \"\\.bin$\">\n"
				. "ForceType application/octet-stream\n"
				. "</FilesMatch>\n"
			);
		}
		return [ $dir, trailingslashit( $up['baseurl'] ) . 'aq-chat' ];
	}

	private static function unlink_blob( $name ) {
		if ( $name === '' || ! preg_match( '/^[a-f0-9]{32}\.bin$/', $name ) ) { return; }
		[ $dir ] = self::blob_dir();
		$f = $dir . '/' . $name;
		if ( is_file( $f ) ) { @unlink( $f ); }
	}

	/**
	 * Disappearing messages: hard-delete every row (and its sealed attachment) older than the
	 * chat's ttl. Runs on every read/send of the chat, so expiry needs no cron — a message can
	 * outlive its timer only while nobody looks, and the next look removes it.
	 */
	private static function purge_expired( $chat ) {
		$ttl = (int) ( $chat['ttl'] ?? 0 );
		if ( $ttl <= 0 ) { return; }
		global $wpdb;
		$t      = Data::t( 'aq_chat_msgs' );
		$cutoff = Data::now() - $ttl;
		$dead   = Data::all( "SELECT id, `blob` FROM $t WHERE chat_id = %d AND created < %d", [ (int) $chat['id'], $cutoff ] );
		if ( ! $dead ) { return; }
		foreach ( $dead as $d ) { self::unlink_blob( (string) $d['blob'] ); }
		$wpdb->query( $wpdb->prepare( "DELETE FROM $t WHERE chat_id = %d AND created < %d", (int) $chat['id'], $cutoff ) );
	}

	// ── Keys ────────────────────────────────────────────────────────────────

	/**
	 * POST chat/keys {pub} — register the caller's device public key (base64 uncompressed P-256
	 * point). Idempotent: re-posting the active key returns its existing id; a different key
	 * APPENDS (rotation) and becomes active. The private half never reaches this server.
	 */
	public static function set_key( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_chat_key', 10, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		$pub = trim( (string) Rest::p( $req, 'pub', '' ) );
		$raw = base64_decode( $pub, true );
		// Strictly an uncompressed P-256 point: 65 raw bytes starting 0x04. Anything else is refused —
		// the registry must never carry a blob a peer's WebCrypto import would choke on.
		if ( strlen( $pub ) !== self::PUB_B64_LEN || $raw === false || strlen( $raw ) !== 65 || $raw[0] !== "\x04" ) {
			return Rest::err( 'bad_key', 'Expected a base64 uncompressed P-256 public key.', 400 );
		}
		$cur = self::active_key( $uid );
		if ( $cur && hash_equals( (string) $cur['pub'], $pub ) ) {
			return [ 'ok' => true, 'key' => self::key_payload( $cur ), 'rotated' => false ];
		}
		$id = Data::insert( 'aq_chat_keys', [
			'user_id' => $uid,
			'pub'     => $pub,
			'fp'      => hash( 'sha256', $raw ),
			'created' => Data::now(),
		] );
		return [ 'ok' => true, 'key' => self::key_payload( self::active_key( $uid ) ), 'rotated' => (bool) $cur, 'id' => $id ];
	}

	/**
	 * GET chat/keys?user=<slug|id> — a member's active public key (public: the same bytes sit in
	 * the open DB). Null key = they haven't opened Messages yet, so nobody can write to them.
	 */
	public static function get_key( $req ) {
		self::ensure_tables();
		$who = (string) Rest::p( $req, 'user', '' );
		$u   = ctype_digit( $who ) ? get_userdata( (int) $who ) : get_user_by( 'slug', sanitize_title( $who ) );
		if ( ! $u ) { return Rest::err( 'not_found', 'No such member', 404 ); }
		return [
			'user' => self::user_card( $u->ID ),
			'key'  => self::key_payload( self::active_key( $u->ID ) ),
		];
	}

	/** A specific historical key by id — lets a device open old ciphertext after the PEER rotated. */
	public static function key_by_id( $kid ) {
		return Data::one( 'SELECT id, user_id, pub, fp FROM ' . Data::t( 'aq_chat_keys' ) . ' WHERE id = %d', [ (int) $kid ] );
	}

	// ── Conversations ───────────────────────────────────────────────────────

	/**
	 * GET chat/list — the caller's conversations, most recent first (keyset on last_id).
	 *
	 * Each row also ships its LAST sealed message verbatim (`last`) plus the public keys it was
	 * sealed for (`keys`), so the client can decrypt a one-line preview on-device — the thing every
	 * messenger's list is actually made of. The server still learns nothing: it hands over the same
	 * opaque ciphertext the public DB already publishes, and only a participant's device key opens it.
	 */
	public static function list_chats( $req ) {
		self::ensure_tables();
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		// No mark_presence here — see mark_presence(). Listing conversations is browsing, not being
		// in one, and marking presence on this poll silently suppressed every bell and away-email
		// for as long as a Messages tab stayed open.
		$rows = Data::all(
			'SELECT * FROM ' . Data::t( 'aq_chats' ) . ' WHERE a_uid = %d OR b_uid = %d ORDER BY last_id DESC LIMIT 50',
			[ $uid, $uid ]
		);
		$items = [];
		$kids  = [];
		foreach ( $rows as $r ) {
			$is_a  = (int) $r['a_uid'] === $uid;
			$peer  = $is_a ? (int) $r['b_uid'] : (int) $r['a_uid'];
			$seen  = (int) ( $is_a ? $r['a_read'] : $r['b_read'] );
			$unread = 0;
			if ( (int) $r['last_id'] > $seen ) {
				$unread = (int) Data::col(
					'SELECT COUNT(*) FROM ' . Data::t( 'aq_chat_msgs' ) . ' WHERE chat_id = %d AND id > %d AND sender_id != %d',
					[ (int) $r['id'], $seen, $uid ]
				);
			}
			// Disappearing messages expire on READ, and this IS a read — without it the sidebar would
			// hand back the ciphertext of a message whose timer ran out while nobody had the thread
			// open, resurrecting in a preview exactly what the member was promised was hard-deleted.
			self::purge_expired( $r );
			// The newest sealed row — read by id (not last_id), so a conversation whose last message
			// was unsent or expired previews the one before it instead of going blank. Oversized
			// ciphertext is skipped: a preview is one line, and shipping every conversation's full
			// body on a 15s poll would put megabytes on the wire for text that is then truncated.
			$last = Data::one(
				'SELECT id, sender_id, akid, bkid, iv, ct, created FROM ' . Data::t( 'aq_chat_msgs' )
				. ' WHERE chat_id = %d AND LENGTH(ct) <= %d ORDER BY id DESC LIMIT 1',
				[ (int) $r['id'], self::PREVIEW_CT_MAX ]
			);
			if ( $last ) { $kids[ (int) $last['akid'] ] = 1; $kids[ (int) $last['bkid'] ] = 1; }
			$items[] = [
				'id'      => (int) $r['id'],
				'peer'    => self::user_card( $peer ),
				'last_at' => (int) $r['last_at'],
				'unread'  => $unread,
				'online'  => self::online( $peer ),
				'low_uid' => min( $uid, $peer ),
				'last'    => $last ? [
					'id'     => (int) $last['id'],
					'sender' => (int) $last['sender_id'],
					'akid'   => (int) $last['akid'],
					'bkid'   => (int) $last['bkid'],
					'iv'     => (string) $last['iv'],
					'ct'     => (string) $last['ct'],
					'at'     => (int) $last['created'],
				] : null,
			];
		}
		// Every key id the previews reference, resolved to its public bytes (exactly as messages()
		// does) so a preview still opens after either side rotated their device key.
		$keys = [];
		foreach ( array_keys( $kids ) as $kid ) {
			$k = self::key_by_id( $kid );
			if ( $k ) { $keys[ $kid ] = [ 'user_id' => (int) $k['user_id'], 'pub' => (string) $k['pub'], 'fp' => (string) $k['fp'] ]; }
		}
		return [ 'items' => $items, 'me' => $uid, 'keys' => $keys, 'my_key' => self::key_payload( self::active_key( $uid ) ) ];
	}

	/**
	 * GET chat/members?q=&cursor= — the member DIRECTORY with live presence: everyone you could
	 * write to, who is online right now, and who has a device key yet.
	 *
	 * There is nothing to hide here — the whole user table is already public in /data/ — so this
	 * exposes exactly what that does plus the presence beacon, and no more. Ordered online-first
	 * (then by name) so the answer to "who is around?" is the top of the list. `has_key` is what
	 * actually matters before writing: a member who has never opened Messages has published no
	 * public key, so nobody can seal anything to them yet.
	 *
	 * Presence lives in per-user transients, which SQL cannot ORDER BY — so this reads a bounded
	 * window (SCAN_MAX) and sorts in PHP.
	 *
	 * Deliberately ONE page, no cursor. A keyset cursor is the house rule for every other list, but
	 * it cannot be honest here: the sort key is live presence, so a member coming online between two
	 * requests reshuffles the order underneath a positional cursor and the second page silently
	 * duplicates and drops people. One bounded, self-consistent answer — with `listed`/`total` saying
	 * plainly when it is bounded — beats a paginated one that lies. Search narrows it.
	 */
	const SCAN_MAX = 200;

	public static function members( $req ) {
		self::ensure_tables();
		global $wpdb;
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		if ( Rest::throttle( 'aq_chat_dir', 40, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		// No mark_presence here either — browsing the member directory is not being in a chat.

		$q = trim( (string) Rest::p( $req, 'q', '' ) );

		// Service accounts are not people to strike up a conversation with. Excluded in SQL, not
		// after the fact, so `total` counts exactly what the list can show — otherwise the footer
		// ("showing the first N of M") would report a shortfall that is really just the bots.
		$bot   = (int) get_option( 'aq_artabot_uid', 0 );
		$where = 'WHERE u.ID != %d AND u.ID != %d'
			. " AND u.ID NOT IN ( SELECT user_id FROM {$wpdb->usermeta} WHERE meta_key = '_aq_is_bot' AND meta_value != '' )";
		$args  = [ $uid, $bot ];
		if ( $q !== '' ) {
			$like   = '%' . $wpdb->esc_like( $q ) . '%';
			$where .= ' AND ( u.display_name LIKE %s OR u.user_nicename LIKE %s )';
			$args[] = $like;
			$args[] = $like;
		}
		// Bounded scan: presence lives in transients that SQL cannot sort on, so a window is read and
		// ordered in PHP. `total` vs `listed` lets the UI say so rather than silently truncating.
		$total = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->users} u $where", $args ) );
		$rows  = $wpdb->get_results(
			$wpdb->prepare( "SELECT u.ID, u.display_name, u.user_nicename FROM {$wpdb->users} u $where ORDER BY u.display_name ASC LIMIT %d", array_merge( $args, [ self::SCAN_MAX ] ) )
		) ?: [];

		$ids = array_map( fn( $u ) => (int) $u->ID, $rows );

		// Prime the caches ONCE for the whole window. Read naively, each row cost a get_userdata, a
		// usermeta fetch (avatar + flag) and a transient lookup — ~3 queries per member, so a 200-row
		// directory refreshing every 20s was ~600 queries a tick, per open tab.
		if ( $ids ) {
			cache_users( $ids );
			update_meta_cache( 'user', $ids );
		}
		// Whether each member has EVER registered a device key, in one query instead of one per member.
		$keyed = [];
		if ( $ids ) {
			$ph = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
			foreach ( (array) $wpdb->get_col( $wpdb->prepare(
				'SELECT DISTINCT user_id FROM ' . Data::t( 'aq_chat_keys' ) . " WHERE user_id IN ($ph)", $ids
			) ) as $k ) { $keyed[ (int) $k ] = true; }
		}
		// Presence in ONE query too. An expiring transient is not autoloaded, so get_transient() per
		// member is a fresh options read each — 200 members would be hundreds of queries a tick. The
		// expiry sibling is checked here exactly as get_transient would, so a stale beacon still reads
		// as offline. With a persistent object cache present, fall back to the normal path.
		$live = [];
		if ( $ids && ! wp_using_ext_object_cache() ) {
			$names = array_map( fn( $i ) => '_transient_aq_chat_on_' . $i, $ids );
			$exp   = array_map( fn( $i ) => '_transient_timeout_aq_chat_on_' . $i, $ids );
			$all   = array_merge( $names, $exp );
			$ph    = implode( ',', array_fill( 0, count( $all ), '%s' ) );
			$rowsO = (array) $wpdb->get_results( $wpdb->prepare(
				"SELECT option_name, option_value FROM {$wpdb->options} WHERE option_name IN ($ph)", $all
			) );
			$val = []; $till = [];
			foreach ( $rowsO as $o ) {
				if ( strpos( $o->option_name, '_transient_timeout_aq_chat_on_' ) === 0 ) {
					$till[ (int) substr( $o->option_name, strlen( '_transient_timeout_aq_chat_on_' ) ) ] = (int) $o->option_value;
				} else {
					$val[ (int) substr( $o->option_name, strlen( '_transient_aq_chat_on_' ) ) ] = true;
				}
			}
			$now = time();
			foreach ( $ids as $i ) { $live[ $i ] = isset( $val[ $i ] ) && ( $till[ $i ] ?? 0 ) > $now; }
		}
		$is_online = fn( $id ) => array_key_exists( $id, $live ) ? $live[ $id ] : self::online( $id );

		$items = [];
		foreach ( $rows as $u ) {
			$id = (int) $u->ID;
			$items[] = [
				'id'      => $id,
				'name'    => (string) $u->display_name,
				'slug'    => (string) $u->user_nicename,
				'avatar'  => Verify::avatar_url( $id, 96 ),
				'country' => Verify::badge_country( $id ),
				'online'  => $is_online( $id ),
				'has_key' => isset( $keyed[ $id ] ),
			];
		}
		// Online first, then alphabetical — a stable, predictable directory.
		usort( $items, function ( $a, $b ) {
			if ( $a['online'] !== $b['online'] ) { return $a['online'] ? -1 : 1; }
			return strcasecmp( $a['name'], $b['name'] );
		} );

		return [
			'items'  => $items,
			'total'  => $total,
			'online' => count( array_filter( $items, fn( $m ) => $m['online'] ) ),
			'listed' => count( $items ),
			// True when the directory is showing a bounded slice of a larger membership — the UI says
			// so rather than pretending the list is everyone. Note the window is the alphabetically
			// first SCAN_MAX, so beyond that "online first" orders only what was scanned; search is
			// the way to reach anyone outside it.
			'capped' => $total > count( $items ),
		];
	}

	/**
	 * GET chat/messages?with=<uid>&cursor=|&after= — one conversation's ciphertext rows.
	 * cursor pages BACK through history (DESC keyset, like every list); `after` returns only rows
	 * newer than an id (ASC) — the live-polling path. Ships both parties' key material so the
	 * client can derive without extra round-trips, plus each row's exact key ids.
	 */
	public static function messages( $req ) {
		self::ensure_tables();
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$peer = Rest::pint( $req, 'with', 0 );
		// Self-chat is allowed — 'notes to yourself' sealed to your own key (operator 2026-07-14).
		if ( ! $peer || ! get_userdata( $peer ) ) { return Rest::err( 'bad_peer', 'No such member', 404 ); }
		$chat  = self::chat_row( $uid, $peer );
		// Presence is marked for THIS conversation as well as globally, so a thread the member keeps
		// open in the dock never silences the people they are not talking to (see in_chat()).
		self::mark_presence( $uid, $chat ? (int) $chat['id'] : 0 );
		$items = [];
		$next  = null;
		if ( $chat ) {
			self::purge_expired( $chat );
			$after = Rest::pint( $req, 'after', 0 );
			if ( $after > 0 ) {
				$items = Data::all(
					'SELECT id, sender_id, akid, bkid, iv, ct, `blob`, created FROM ' . Data::t( 'aq_chat_msgs' )
					. ' WHERE chat_id = %d AND id > %d ORDER BY id ASC LIMIT 100',
					[ (int) $chat['id'], $after ]
				);
			} else {
				[ $items, $next ] = Data::page(
					'aq_chat_msgs', 'chat_id = %d', [ (int) $chat['id'] ],
					Rest::pint( $req, 'cursor', 0 ), Rest::pint( $req, 'limit', 50 )
				);
			}
			// Mark the caller's side read up to the newest row they just received.
			$max = 0;
			foreach ( $items as $m ) { $max = max( $max, (int) $m['id'] ); }
			if ( $max > 0 ) {
				$col = (int) $chat['a_uid'] === $uid ? 'a_read' : 'b_read';
				if ( $max > (int) $chat[ $col ] ) {
					Data::update( 'aq_chats', [ $col => $max ], [ 'id' => (int) $chat['id'] ] );
					// They have caught up, so re-arm the email cooldown: the NEXT message that lands
					// while they are away should be announced, not eaten by a cooldown left over
					// from the batch they just finished reading.
					self::clear_dm_mail_cooldown( $uid, $peer );
				}
			}
		}
		// Every distinct key id referenced by this page, resolved to its public bytes — the client
		// needs the PEER's historical pubs to open rows sealed before a rotation.
		$kids = [];
		foreach ( $items as $m ) { $kids[ (int) $m['akid'] ] = 1; $kids[ (int) $m['bkid'] ] = 1; }
		$keys = [];
		foreach ( array_keys( $kids ) as $kid ) {
			$k = self::key_by_id( $kid );
			if ( $k ) { $keys[ $kid ] = [ 'user_id' => (int) $k['user_id'], 'pub' => (string) $k['pub'], 'fp' => (string) $k['fp'] ]; }
		}
		// Liveness + receipt facts for the header/ticks: is the peer here, are they typing to ME,
		// and what's the newest of MY messages they've seen (their read watermark).
		$peer_read = 0;
		if ( $chat ) {
			$peer_read = (int) ( (int) $chat['a_uid'] === $peer ? $chat['a_read'] : $chat['b_read'] );
		}
		return [
			'chat_id'     => $chat ? (int) $chat['id'] : 0,
			'me'          => $uid,
			'peer'        => self::user_card( $peer ),
			'peer_key'    => self::key_payload( self::active_key( $peer ) ),
			'my_key'      => self::key_payload( self::active_key( $uid ) ),
			'low_uid'     => min( $uid, $peer ),
			'keys'        => $keys,
			'ttl'         => $chat ? (int) $chat['ttl'] : 0,
			'peer_read'   => $peer_read,
			'peer_online' => self::online( $peer ),
			'peer_typing' => $chat ? (bool) get_transient( 'aq_chat_typing_' . (int) $chat['id'] . '_' . $peer ) : false,
			'items'       => array_map( fn( $m ) => [
				'id'     => (int) $m['id'],
				'sender' => (int) $m['sender_id'],
				'akid'   => (int) $m['akid'],
				'bkid'   => (int) $m['bkid'],
				'iv'     => (string) $m['iv'],
				'ct'     => (string) $m['ct'],
				'blob'   => (string) ( $m['blob'] ?? '' ),
				'at'     => (int) $m['created'],
			], $items ),
			'next'        => $next,
		];
	}

	/**
	 * POST chat/send {to, iv, ct, akid, bkid} — append one sealed message. The server can verify
	 * only the envelope (sizes, that both key ids belong to the pair); the content is opaque to it
	 * by construction. Creates the conversation row on first contact.
	 */
	public static function send( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_chat_send', 30, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = Rest::uid();
		$peer = Rest::pint( $req, 'to', 0 );
		// Self-chat is allowed — 'notes to yourself' sealed to your own key (operator 2026-07-14).
		if ( ! $peer || ! get_userdata( $peer ) ) { return Rest::err( 'bad_peer', 'No such member', 404 ); }
		$iv   = trim( (string) Rest::p( $req, 'iv', '' ) );
		$ct   = trim( (string) Rest::p( $req, 'ct', '' ) );
		$akid = Rest::pint( $req, 'akid', 0 );
		$bkid = Rest::pint( $req, 'bkid', 0 );
		if ( $iv === '' || strlen( $iv ) > 32 || base64_decode( $iv, true ) === false ) {
			return Rest::err( 'bad_iv', 'Malformed IV.', 400 );
		}
		if ( $ct === '' || strlen( $ct ) > self::CT_MAX || base64_decode( $ct, true ) === false ) {
			return Rest::err( 'bad_ct', 'Message is empty, too large, or not base64.', 400 );
		}
		// The named keys must be real and belong to this exact pair, low uid first — so every stored
		// row provably references the two public keys it was sealed for.
		[ $low, $high ] = self::pair( $uid, $peer );
		$ka = self::key_by_id( $akid );
		$kb = self::key_by_id( $bkid );
		if ( ! $ka || ! $kb || (int) $ka['user_id'] !== $low || (int) $kb['user_id'] !== $high ) {
			return Rest::err( 'bad_keys', 'Key ids do not match this conversation.', 400 );
		}
		// Optional sealed-attachment reference: must be a name our own blob() handed out and a file
		// that exists — so a row can never point the purge/unsend unlink at anything else.
		$blob = trim( (string) Rest::p( $req, 'blob', '' ) );
		if ( $blob !== '' ) {
			if ( ! preg_match( '/^[a-f0-9]{32}\.bin$/', $blob ) ) { return Rest::err( 'bad_blob', 'Malformed attachment reference.', 400 ); }
			[ $bdir ] = self::blob_dir();
			if ( ! is_file( $bdir . '/' . $blob ) ) { return Rest::err( 'bad_blob', 'No such attachment.', 400 ); }
		}
		$chat = self::chat_row( $uid, $peer );
		if ( ! $chat ) {
			Data::upsert( 'aq_chats', [ 'a_uid' => $low, 'b_uid' => $high ], [ 'created' => Data::now() ] );
			$chat = self::chat_row( $uid, $peer );
			if ( ! $chat ) { return Rest::err( 'server_error', 'Could not open the conversation.', 500 ); }
		}
		self::purge_expired( $chat );
		delete_transient( 'aq_chat_typing_' . (int) $chat['id'] . '_' . $uid ); // sending ends "typing…"
		$now = Data::now();
		$id  = Data::insert( 'aq_chat_msgs', [
			'chat_id'   => (int) $chat['id'],
			'sender_id' => $uid,
			'akid'      => $akid,
			'bkid'      => $bkid,
			'iv'        => $iv,
			'ct'        => $ct,
			'blob'      => $blob,
			'created'   => $now,
		] );
		// Sender has trivially "read" their own message.
		$col = (int) $chat['a_uid'] === $uid ? 'a_read' : 'b_read';
		Data::update( 'aq_chats', [ 'last_id' => $id, 'last_at' => $now, $col => $id ], [ 'id' => (int) $chat['id'] ] );
		// Bell + email only when the peer isn't actively in chat (presence beacon dark) — an online
		// peer sees the message arrive live.
		//
		// `notify` is the sender's client saying "this row is a real message, not a reaction, an
		// edit or a tombstone". The server genuinely cannot tell: every sealed row is shape-identical
		// by design, which is the whole point. It is a HINT, not a permission — a hostile client can
		// only silence or repeat notifications it was already entitled to send to that one peer, and
		// the cooldown below bounds the repeat. Absent (older clients) = notify, so nothing regresses.
		// The gate is "are they in THIS conversation", not "are they anywhere in chat" — otherwise one
		// thread left open in the dock would silence every OTHER sender for as long as it stayed open.
		if ( (int) Rest::p( $req, 'notify', 1 ) === 1 && ! self::in_chat( $peer, (int) $chat['id'] ) ) {
			$me   = get_userdata( $uid );
			$name = $me ? $me->display_name : 'A member';
			Notify::push( $peer, 'dm', $name . ' sent you an encrypted message', '', '/messages/', 'dm' . $id );
			self::email_dm( $peer, $uid, $name );
		}
		return [ 'ok' => true, 'id' => $id, 'chat_id' => (int) $chat['id'], 'at' => $now ];
	}

	/**
	 * Email the recipient that a message is waiting, while they are away.
	 *
	 * This is a stranger-triggered email sent from ArtaQuest's ONE signing identity — the same one
	 * sign-in codes go out on — so it is treated as an abuse surface first and a feature second:
	 *
	 *  • THREE limits, not one. Per pair (a burst of chat is one email), per RECIPIENT across all
	 *    senders (so N accounts cannot gang up on one inbox), and per SENDER across all recipients
	 *    (so one account cannot spray the member list). The pair cooldown alone bounded neither.
	 *  • The sender's name is SCRUBBED, not trusted. display_name is member-controlled and lands in
	 *    the subject line and — after the body's auto-linker — could otherwise become a live
	 *    hyperlink inside a DKIM-signed ArtaQuest email: a ready-made phishing lure. URLs are
	 *    stripped, entities decoded, CR/LF removed (header injection), length capped.
	 *  • The send is DEFERRED to cron. wp_mail with Vault SMTP opens an authenticated socket with a
	 *    10s timeout; doing that inline made the recipient's mail server a dependency of the
	 *    sender's message going through.
	 *  • Opt-out (`aq_dm_email_off`) is honoured, and the claim is only kept if the mail actually
	 *    goes out — a relay hiccup must not silence the next 30 minutes.
	 */
	const EMAIL_COOLDOWN = 1800;      // per conversation
	const EMAIL_RCPT_MAX = 6;         // …per recipient, across ALL senders
	const EMAIL_RCPT_WINDOW = 3600;
	const EMAIL_SENDER_MAX = 20;      // …per sender, across ALL recipients
	const EMAIL_SENDER_WINDOW = 86400;

	/** A member-controlled name made safe for a subject header and an auto-linking HTML body. */
	private static function safe_sender_name( $name ) {
		$n = wp_specialchars_decode( (string) $name, ENT_QUOTES ); // WP stores it entity-encoded
		$n = preg_replace( '#\b(?:https?://|www\.)\S*#i', '', $n );        // no links…
		$n = preg_replace( '#\b[\w.-]+\.(?:com|net|org|io|ru|xyz|link)\b#i', '', $n ); // …or bare domains
		$n = str_replace( [ "\r", "\n", "\t" ], ' ', (string) $n );        // no header injection
		$n = trim( preg_replace( '/\s+/', ' ', $n ) );
		$n = mb_substr( $n, 0, 40 );
		return $n !== '' ? $n : 'A member';
	}

	private static function email_dm( $peer, $from, $sender_name ) {
		$peer = (int) $peer;
		$from = (int) $from;
		if ( get_user_meta( $peer, 'aq_dm_email_off', true ) ) { return; }

		$pair = 'aq_dm_mail_' . $peer . '_' . $from;
		if ( get_transient( $pair ) ) { return; }
		// Volume caps BEFORE the claim, so a blocked send doesn't also burn the pair cooldown.
		$rk = 'aq_dm_mail_rcpt_' . $peer;
		$sk = 'aq_dm_mail_send_' . $from;
		if ( (int) get_transient( $rk ) >= self::EMAIL_RCPT_MAX ) { return; }
		if ( (int) get_transient( $sk ) >= self::EMAIL_SENDER_MAX ) { return; }

		$u = get_userdata( $peer );
		if ( ! $u || ! is_email( $u->user_email ) ) { return; }

		set_transient( $pair, 1, self::EMAIL_COOLDOWN );
		set_transient( $rk, (int) get_transient( $rk ) + 1, self::EMAIL_RCPT_WINDOW );
		set_transient( $sk, (int) get_transient( $sk ) + 1, self::EMAIL_SENDER_WINDOW );

		// Off the request path — the sender's message is already stored and must not wait on SMTP.
		wp_schedule_single_event( time(), 'aq_dm_email', [ $peer, self::safe_sender_name( $sender_name ) ] );
	}

	/** Cron target for the deferred DM email. Fail-soft: a bounce never costs anyone their message,
	 *  and a failed send releases the pair cooldown so the next message can still be announced. */
	public static function send_dm_email( $peer, $sender_name ) {
		$u = get_userdata( (int) $peer );
		if ( ! $u || ! is_email( $u->user_email ) || ! class_exists( '\\AQ\\Mailer' ) ) { return; }
		if ( get_user_meta( (int) $peer, 'aq_dm_email_off', true ) ) { return; } // opted out since
		$ok = false;
		try {
			$ok = (bool) Mailer::send( 'dm_received', $u->user_email, [ 'sender' => (string) $sender_name ] );
		} catch ( \Throwable $e ) { $ok = false; }
		if ( ! $ok ) {
			// Don't hold a 30-minute silence for an email that never left.
			global $wpdb;
			$like = $wpdb->esc_like( 'aq_dm_mail_' . (int) $peer . '_' ) . '%';
			foreach ( (array) $wpdb->get_col( $wpdb->prepare(
				"SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s", '_transient_' . $like
			) ) as $opt ) {
				delete_transient( substr( (string) $opt, strlen( '_transient_' ) ) );
			}
		}
	}

	/** Clear the "already emailed" cooldown for every conversation this member has just read, so a
	 *  later message while they are away is announced again instead of being silently swallowed. */
	private static function clear_dm_mail_cooldown( $uid, $peer ) {
		delete_transient( 'aq_dm_mail_' . (int) $uid . '_' . (int) $peer );
	}

	/**
	 * GET|POST chat/email-prefs — read or set whether this member is emailed about messages that
	 * arrive while they are away. On by default (an unread DM nobody is told about is a broken
	 * inbox), off with one tap, and stored as a plain user meta so the opt-out survives everything.
	 */
	public static function email_prefs( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		if ( $req->get_method() === 'POST' ) {
			if ( Rest::throttle( 'aq_chat_mailpref', 20, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
			// `on` is the member-facing sense (email me); the meta stores the NEGATIVE so that the
			// default for every account that has never touched this — no row — is "on".
			if ( (int) Rest::p( $req, 'on', 1 ) === 1 ) { delete_user_meta( $uid, 'aq_dm_email_off' ); }
			else { update_user_meta( $uid, 'aq_dm_email_off', 1 ); }
		}
		return [ 'ok' => true, 'email_on' => ! get_user_meta( $uid, 'aq_dm_email_off', true ) ];
	}

	/**
	 * POST chat/typing {with} — a 6-second "typing…" beacon the peer's next poll picks up.
	 * Pure transient; nothing is stored. No-op until the conversation exists.
	 */
	public static function typing( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_chat_typing', 60, 60 ) ) { return [ 'ok' => true ]; }
		$uid  = Rest::uid();
		$peer = Rest::pint( $req, 'with', 0 );
		$chat = $peer && $peer !== $uid ? self::chat_row( $uid, $peer ) : null;
		if ( $chat ) {
			set_transient( 'aq_chat_typing_' . (int) $chat['id'] . '_' . $uid, 1, self::TYPING_S );
		}
		self::mark_presence( $uid, $chat ? (int) $chat['id'] : 0 );
		return [ 'ok' => true ];
	}

	/**
	 * POST chat/ttl {with, ttl} — set the conversation's disappearing-message timer (either
	 * party; both live under it, WhatsApp/Signal-style). The timer itself is public metadata;
	 * expiry HARD-DELETES rows + sealed attachments on the next read, so disappeared means gone
	 * from the public dataset too.
	 */
	public static function set_ttl( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_chat_ttl', 10, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = Rest::uid();
		$peer = Rest::pint( $req, 'with', 0 );
		// Self-chat is allowed — 'notes to yourself' sealed to your own key (operator 2026-07-14).
		if ( ! $peer || ! get_userdata( $peer ) ) { return Rest::err( 'bad_peer', 'No such member', 404 ); }
		$ttl = Rest::pint( $req, 'ttl', 0 );
		if ( ! in_array( $ttl, self::TTLS, true ) ) { return Rest::err( 'bad_ttl', 'Unsupported timer.', 400 ); }
		[ $low, $high ] = self::pair( $uid, $peer );
		$chat = self::chat_row( $uid, $peer );
		if ( ! $chat ) {
			Data::upsert( 'aq_chats', [ 'a_uid' => $low, 'b_uid' => $high ], [ 'created' => Data::now() ] );
			$chat = self::chat_row( $uid, $peer );
			if ( ! $chat ) { return Rest::err( 'server_error', 'Could not open the conversation.', 500 ); }
		}
		Data::update( 'aq_chats', [ 'ttl' => $ttl ], [ 'id' => (int) $chat['id'] ] );
		$chat['ttl'] = $ttl;
		self::purge_expired( $chat );
		return [ 'ok' => true, 'ttl' => $ttl ];
	}

	/**
	 * POST chat/unsend {id} — the sender hard-deletes one of their own rows (and its sealed
	 * attachment) from the database. Pairs with a sealed delete-marker the client sends so the
	 * peer's open screen drops the bubble immediately; this removes the public record itself.
	 */
	public static function unsend( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_chat_unsend', 30, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		global $wpdb;
		$uid = Rest::uid();
		$id  = Rest::pint( $req, 'id', 0 );
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_chat_msgs' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $row || (int) $row['sender_id'] !== $uid ) { return Rest::err( 'not_found', 'No such message of yours.', 404 ); }
		self::unlink_blob( (string) ( $row['blob'] ?? '' ) );
		$wpdb->delete( Data::t( 'aq_chat_msgs' ), [ 'id' => $id, 'sender_id' => $uid ] );
		return [ 'ok' => true ];
	}

	/**
	 * POST chat/blob — store one ALREADY-SEALED attachment (multipart `file`). The server gets an
	 * opaque .bin it cannot open: the per-attachment AES-256-GCM key travels only inside the
	 * sealed message that references it. Returns the reference name `send` accepts as `blob`.
	 */
	public static function blob( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_chat_blob', 20, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$files = $req->get_file_params();
		$f     = $files['file'] ?? null;
		if ( ! $f || ! is_uploaded_file( $f['tmp_name'] ?? '' ) ) { return Rest::err( 'no_file', 'Attach a file.', 400 ); }
		if ( (int) $f['size'] <= 0 || (int) $f['size'] > self::BLOB_MAX ) {
			return Rest::err( 'too_big', 'Attachments are capped at 6 MB.', 400 );
		}
		$day_key = 'aq_chat_blob_day_' . Rest::uid();
		$spent   = (int) get_transient( $day_key );
		if ( $spent + (int) $f['size'] > self::BLOB_DAY_MAX ) {
			return Rest::err( 'quota', 'Daily attachment budget reached — try again tomorrow.', 429 );
		}
		set_transient( $day_key, $spent + (int) $f['size'], DAY_IN_SECONDS );
		[ $dir, $url ] = self::blob_dir();
		$name = bin2hex( random_bytes( 16 ) ) . '.bin';
		if ( ! move_uploaded_file( $f['tmp_name'], $dir . '/' . $name ) ) {
			return Rest::err( 'server_error', 'Could not store the attachment.', 500 );
		}
		return [ 'ok' => true, 'blob' => $name, 'url' => $url . '/' . $name ];
	}
}
