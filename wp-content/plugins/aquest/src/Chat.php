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

	const TABLE_VERSION = '6';

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
	/** How many messages a member may send into a conversation the other side has NOT accepted.
	 *  A message request is an ask, not a channel: it says who you are and why, and then it waits.
	 *  Without this cap "requests" would be a folder that still receives an unbounded stream. */
	const REQUEST_MAX = 3;
	/** How long an unanswered call beacon rings before the callee's client stops showing it.
	 *  Longer than the badge poll interval (30 s) BY CONSTRUCTION: a ring shorter than the poll can
	 *  begin and end between two requests, and a call that never rings is worse than no calling. */
	const RING_S = 75;
	/** Remote-media fetch (the "paste a GIF link" path) — ceiling, and the only content types we
	 *  will pull from a stranger's host on a member's behalf. */
	const FETCH_MAX  = 5000000;
	const FETCH_MIME = [ 'image/gif', 'image/png', 'image/jpeg', 'image/webp', 'video/mp4' ];

	public static function ensure_tables() {
		if ( get_option( 'aq_chat_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		$p       = $wpdb->prefix;
		// Append-only key registry: one row per registered device key. The member's ACTIVE key is the
		// most recently PRESENTED one (`seen`), not the most recently created — see set_key().
		dbDelta( "CREATE TABLE {$p}aq_chat_keys (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			pub VARCHAR(96) NOT NULL DEFAULT '',
			fp VARCHAR(64) NOT NULL DEFAULT '',
			created INT UNSIGNED NOT NULL DEFAULT 0,
			seen INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY user_id_id (user_id, id),
			KEY user_id_seen (user_id, seen)
		) {$charset};" );
		// dbDelta silently skips an ADD COLUMN under Studio's SQLite, so add it explicitly there.
		$cols = $wpdb->get_col( "SHOW COLUMNS FROM {$p}aq_chat_keys" );
		if ( is_array( $cols ) && ! in_array( 'seen', $cols, true ) ) {
			$wpdb->query( "ALTER TABLE {$p}aq_chat_keys ADD COLUMN seen INT UNSIGNED NOT NULL DEFAULT 0" );
		}
		// BACK-FILL UNCONDITIONALLY. This was nested inside the guard above, and on MySQL dbDelta had
		// already added the column by the time the guard ran — so the guard skipped, and every
		// existing row stayed at the DEFAULT 0. With the whole table at zero, `ORDER BY seen DESC,
		// id DESC` degenerates to exactly the `id DESC` this change exists to replace. The two are
		// separate questions: who adds the column, and whether the rows have a value.
		$wpdb->query( "UPDATE {$p}aq_chat_keys SET seen = created WHERE seen = 0 AND created > 0" );

		/**
		 * THE ESCROW. One row per member: their own private key, sealed in their browser under a
		 * 160-bit recovery code we never see, so a new device can restore the SAME key and open the
		 * whole history instead of starting a fresh epoch and orphaning it.
		 *
		 * Storing this in a database published in full at /data/ is deliberate and safe, for exactly
		 * the reason the message ciphertext beside it is safe: we hold no key for either. It is not a
		 * platform secret and Secrets::get has nothing to do with it. What makes it safe is that the
		 * code is GENERATED, never chosen — a member's password would be brute-forced offline by
		 * anyone who downloaded this table, and 160 random bits cannot be.
		 *
		 * The column is `vault_key` so Extra::redact_row's default-deny-by-name-shape masks it in the
		 * explorer anyway. Belt and braces: publishing it would not be a breach, and not publishing
		 * it costs nothing.
		 */
		dbDelta( "CREATE TABLE {$p}aq_chat_vault (
			user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			vault_key TEXT NOT NULL,
			fp VARCHAR(64) NOT NULL DEFAULT '',
			created INT UNSIGNED NOT NULL DEFAULT 0,
			updated INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (user_id)
		) {$charset};" );
		// One row per 1:1 conversation; the pair is stored ordered (a < b) so it's unique.
		// a_read/b_read are read watermarks (last message id each side has seen); `ttl` is the
		// disappearing-message timer both parties see (0 = keep; else seconds a row lives).
		//
		// v3 adds the two things a 1:1 conversation needs beyond its messages:
		//  • WHO ASKED (`starter`) and WHETHER THE OTHER SIDE SAID YES (`accepted`). A conversation
		//    a stranger opens is a message REQUEST until the recipient accepts it: it sits in its own
		//    box, it rings the bell exactly once, and the sender may add at most REQUEST_MAX messages
		//    to it. Replying accepts, because there is no way to reply by accident.
		//  • PER-SIDE state — block / mute / pin / archive. Deliberately one column per side rather
		//    than a shared flag: muting is MY choice about MY inbox and must never be visible as a
		//    change to the other person's conversation. (It is visible in the public DB, like all
		//    ArtaChat metadata — that is the standing trade, and the reason nothing here is a secret.)
		dbDelta( "CREATE TABLE {$p}aq_chats (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			a_uid BIGINT UNSIGNED NOT NULL DEFAULT 0,
			b_uid BIGINT UNSIGNED NOT NULL DEFAULT 0,
			last_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			last_at INT UNSIGNED NOT NULL DEFAULT 0,
			a_read BIGINT UNSIGNED NOT NULL DEFAULT 0,
			b_read BIGINT UNSIGNED NOT NULL DEFAULT 0,
			ttl INT UNSIGNED NOT NULL DEFAULT 0,
			starter BIGINT UNSIGNED NOT NULL DEFAULT 0,
			accepted TINYINT UNSIGNED NOT NULL DEFAULT 1,
			a_block TINYINT UNSIGNED NOT NULL DEFAULT 0,
			b_block TINYINT UNSIGNED NOT NULL DEFAULT 0,
			a_mute TINYINT UNSIGNED NOT NULL DEFAULT 0,
			b_mute TINYINT UNSIGNED NOT NULL DEFAULT 0,
			a_pin TINYINT UNSIGNED NOT NULL DEFAULT 0,
			b_pin TINYINT UNSIGNED NOT NULL DEFAULT 0,
			a_arch TINYINT UNSIGNED NOT NULL DEFAULT 0,
			b_arch TINYINT UNSIGNED NOT NULL DEFAULT 0,
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
		// existing table — add the v2/v3 columns explicitly when absent (a no-op where dbDelta did
		// it). `accepted` defaults to 1 on purpose: every conversation that existed before message
		// requests was, by definition, already accepted, and a default of 0 would have quietly
		// swept the whole site's history into the Requests box on deploy.
		$flag = 'TINYINT UNSIGNED NOT NULL DEFAULT 0';
		$want = [];   // table → columns this version REQUIRES, checked for real below
		foreach ( [ [ 'aq_chats', 'ttl', 'INT UNSIGNED NOT NULL DEFAULT 0' ],
					[ 'aq_chats', 'starter', 'BIGINT UNSIGNED NOT NULL DEFAULT 0' ],
					[ 'aq_chats', 'accepted', 'TINYINT UNSIGNED NOT NULL DEFAULT 1' ],
					[ 'aq_chats', 'a_block', $flag ], [ 'aq_chats', 'b_block', $flag ],
					[ 'aq_chats', 'a_mute',  $flag ], [ 'aq_chats', 'b_mute',  $flag ],
					[ 'aq_chats', 'a_pin',   $flag ], [ 'aq_chats', 'b_pin',   $flag ],
					[ 'aq_chats', 'a_arch',  $flag ], [ 'aq_chats', 'b_arch',  $flag ],
					[ 'aq_chat_msgs', 'blob', "VARCHAR(191) NOT NULL DEFAULT ''" ] ] as [ $t, $col, $def ] ) {
			$cols = $wpdb->get_col( "SHOW COLUMNS FROM {$p}{$t}" );
			if ( $cols && ! in_array( $col, $cols, true ) ) {
				$wpdb->query( "ALTER TABLE {$p}{$t} ADD COLUMN `$col` $def" );
			}
			$want[ $t ][] = $col;
		}
		// VERIFY BEFORE CLAIMING. The version option is a "do not run this again" guard, so writing
		// it is a promise that the columns are there — and every query below this line names them.
		// Recorded unconditionally, one silently-failed ALTER would leave the guard saying "migrated"
		// while every chat query referenced a column that does not exist: Messages broken for
		// everyone, and the retry that would fix it suppressed by the very flag that lied.
		//
		// This is not hypothetical caution. dbDelta is already known in this codebase to emit nothing
		// at all under the SQLite dev integration for shapes it dislikes, which is why the explicit
		// ALTERs above exist; a migration that cannot tell whether it worked has the same shape.
		// Re-read the live schema instead, and if anything is missing leave the option UNSET so the
		// next request tries again rather than proceeding on a false promise.
		$missing = [];
		foreach ( $want as $t => $cols_wanted ) {
			$have = (array) $wpdb->get_col( "SHOW COLUMNS FROM {$p}{$t}" );
			foreach ( $cols_wanted as $c ) {
				if ( ! in_array( $c, $have, true ) ) { $missing[] = "$t.$c"; }
			}
		}
		if ( $missing ) {
			error_log( 'AQ Chat: schema v' . self::TABLE_VERSION . ' incomplete, not recording the version — missing ' . implode( ', ', $missing ) );
			return;
		}
		update_option( 'aq_chat_table_version', self::TABLE_VERSION, true );
	}

	// ── Helpers ─────────────────────────────────────────────────────────────

	/** The caller's + peer's ordered pair (low, high). */
	private static function pair( $u1, $u2 ) {
		return $u1 < $u2 ? [ (int) $u1, (int) $u2 ] : [ (int) $u2, (int) $u1 ];
	}

	/**
	 * Has $uid blocked $other?
	 *
	 * A block is a property of a CONVERSATION, not a global list, so no conversation means no
	 * block — which is right: you cannot have blocked somebody you have never spoken to. Public
	 * because blocking has to mean the same thing everywhere a person can reach you, and since
	 * the booking page went live that includes your diary.
	 */
	public static function blocks( $uid, $other ) {
		$c = self::chat_row( (int) $uid, (int) $other );
		return $c ? self::flag( $c, (int) $uid, 'block' ) : false;
	}

	private static function chat_row( $u1, $u2 ) {
		[ $a, $b ] = self::pair( $u1, $u2 );
		return Data::one( 'SELECT * FROM ' . Data::t( 'aq_chats' ) . ' WHERE a_uid = %d AND b_uid = %d', [ $a, $b ] );
	}

	/**
	 * The conversation between these two, created if it does not exist yet — THE ONLY PLACE a row in
	 * aq_chats is minted.
	 *
	 * That exclusivity is the point, and it was a real hole before this existed. `accepted` defaults
	 * to 1 in the schema (so that every conversation predating message requests stays accepted), so
	 * any creation path that forgets to say otherwise silently produces an ACCEPTED conversation.
	 * chat/ttl had exactly that shape: a stranger could set a disappearing-message timer on a
	 * conversation that did not exist, which minted an accepted row, and then write to that member
	 * without ever passing through the request gate at all. Deciding it here, once, means a new
	 * creation path cannot reintroduce the bypass by omission.
	 */
	private static function ensure_chat( $uid, $peer ) {
		$chat = self::chat_row( $uid, $peer );
		if ( $chat ) { return $chat; }
		[ $low, $high ] = self::pair( $uid, $peer );
		Data::upsert( 'aq_chats', [ 'a_uid' => $low, 'b_uid' => $high ], [
			'created'  => Data::now(),
			'starter'  => (int) $uid,
			'accepted' => self::pre_accepted( $uid, $peer ) ? 1 : 0,
		] );
		return self::chat_row( $uid, $peer );
	}

	/**
	 * A member's ACTIVE public key row — the one most recently PRESENTED by a device, not the one
	 * most recently created.
	 *
	 * It used to be `ORDER BY id DESC`, i.e. the newest key ever minted, and that silently locked
	 * members out of their own rooms. Seals are addressed to exactly one kid per member, and
	 * set_key() is idempotent across the whole key history — so a member with several devices got
	 * every seal addressed to whichever device registered LAST, and every other browser of theirs
	 * derived against a kid whose private half it does not hold. It could not open the room, and no
	 * amount of waiting would help: the next seal went to the same wrong kid. The member sat on
	 * "their browser is sealing the key to this device" for the length of the meeting.
	 *
	 * Ordering by `seen` makes the active key follow the device actually in use: bootChat presents
	 * this browser's key on every boot, so opening the page is what makes you the seal target, and
	 * the present key-holder's next tick reaches you.
	 */
	private static function active_key( $uid ) {
		return Data::one(
			'SELECT id, pub, fp, created FROM ' . Data::t( 'aq_chat_keys' ) . ' WHERE user_id = %d ORDER BY seen DESC, id DESC LIMIT 1',
			[ (int) $uid ]
		);
	}

	/** Mark a registered key as the one this member is using right now. Cheap and idempotent; it is
	 *  called on every key presentation, which is once per chat boot. */
	private static function touch_key( $kid ) {
		Data::update( 'aq_chat_keys', [ 'seen' => Data::now() ], [ 'id' => (int) $kid ] );
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

	// ── Per-side conversation state (requests · block · mute · pin · archive) ──
	//
	// Every one of these is stored twice, once per side, in a column prefixed a_/b_ by the pair's
	// low/high uid. `side()` turns "me" into that prefix so nothing downstream has to remember
	// which of us is `a`, and `flag()` reads one of my own flags off a chat row.

	/** 'a' or 'b' — which half of this ordered pair the given member is. */
	private static function side( $chat, $uid ) {
		return (int) $chat['a_uid'] === (int) $uid ? 'a' : 'b';
	}

	/** One of $uid's own per-side flags on this conversation (block|mute|pin|arch). */
	private static function flag( $chat, $uid, $name ) {
		return (int) ( $chat[ self::side( $chat, $uid ) . '_' . $name ] ?? 0 ) === 1;
	}

	/** …and the OTHER side's. */
	private static function peer_flag( $chat, $uid, $name ) {
		return (int) ( $chat[ ( self::side( $chat, $uid ) === 'a' ? 'b' : 'a' ) . '_' . $name ] ?? 0 ) === 1;
	}

	/**
	 * Is this conversation still an unanswered REQUEST sitting in $uid's request box?
	 *
	 * True only for the RECIPIENT of an un-accepted conversation. To the person who opened it, their
	 * own outgoing request is just a conversation they started — showing them a "request" box
	 * containing their own message would say nothing they don't know and hide the thread they are
	 * waiting on.
	 */
	private static function is_request( $chat, $uid ) {
		return ! (int) $chat['accepted'] && (int) $chat['starter'] !== (int) $uid;
	}

	/**
	 * Does the recipient already know the sender well enough to skip the request box?
	 *
	 * Following someone is a public, deliberate act that says "I want to hear from this account", so
	 * a message from someone the RECIPIENT follows goes straight to their inbox. The reverse (the
	 * sender following the recipient) is deliberately NOT enough — anyone can follow anyone, so it
	 * would be a one-click bypass of the whole mechanism.
	 */
	private static function pre_accepted( $sender, $peer ) {
		if ( (int) $sender === (int) $peer ) { return true; } // notes to yourself
		return (bool) Data::col(
			'SELECT 1 FROM ' . Data::t( 'aq_follows' ) . ' WHERE follower_id = %d AND target_id = %d LIMIT 1',
			[ (int) $peer, (int) $sender ]
		);
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
	 * GET chat/unread — the caller's badge state, and nothing else: unread messages, waiting
	 * requests, and whether somebody is ringing them right now.
	 *
	 * Deliberately does NOT mark presence: this is what the always-present chat dock polls from
	 * every page, and a badge refresh must never be mistaken for the member sitting in a
	 * conversation (see mark_presence). One indexed COUNT over the conversations they're in.
	 *
	 * MUTED, ARCHIVED, BLOCKED and un-accepted conversations are all excluded from the count. A
	 * badge is a claim that something needs attention: a muted thread by definition does not, and a
	 * stranger's request is counted separately so accepting it is a decision rather than a chore
	 * that arrives pre-attached to the same number as your friends' messages.
	 */
	public static function unread( $req ) {
		self::ensure_tables();
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mine = ' ( CASE WHEN c.a_uid = %d THEN c.a_read ELSE c.b_read END )';
		$n = (int) Data::col(
			'SELECT COUNT(*) FROM ' . Data::t( 'aq_chat_msgs' ) . ' m JOIN ' . Data::t( 'aq_chats' ) . ' c ON c.id = m.chat_id'
			. ' WHERE ( c.a_uid = %d OR c.b_uid = %d ) AND m.sender_id != %d'
			// Only conversations that are actually in the inbox: accepted (or my own outgoing ask),
			// not muted by me, not archived by me, not blocked by me.
			. ' AND ( c.accepted = 1 OR c.starter = %d )'
			. ' AND ( CASE WHEN c.a_uid = %d THEN c.a_mute + c.a_arch + c.a_block ELSE c.b_mute + c.b_arch + c.b_block END ) = 0'
			// Skip conversations with nothing unread BEFORE touching the message table — last_id is
			// the cheap denormalised watermark the list already keeps, and it keeps this badge poll
			// off aq_chat_msgs entirely for every conversation the member is caught up on.
			. ' AND c.last_id >' . $mine
			. ' AND m.id >' . $mine
			// Never count a message the disappearing-message timer has already retired. Rows are
			// purged lazily (on the next read of that chat), so between expiry and purge they still
			// exist — and a badge that counts messages the member can never open is just a lie that
			// cannot be cleared by reading.
			. ' AND ( c.ttl = 0 OR m.created >= %d - c.ttl )',
			[ $uid, $uid, $uid, $uid, $uid, $uid, $uid, Data::now() ]
		);
		return [ 'unread' => $n, 'requests' => self::request_count( $uid ), 'ring' => self::ring_state( $uid ) ];
	}

	/** How many un-accepted conversations are waiting on this member's yes-or-no (never their own). */
	private static function request_count( $uid ) {
		return (int) Data::col(
			'SELECT COUNT(*) FROM ' . Data::t( 'aq_chats' )
			. ' WHERE ( a_uid = %d OR b_uid = %d ) AND accepted = 0 AND starter != %d AND last_id > 0'
			. ' AND ( CASE WHEN a_uid = %d THEN a_block ELSE b_block END ) = 0',
			[ (int) $uid, (int) $uid, (int) $uid, (int) $uid ]
		);
	}

	private static function online( $uid ) {
		return (bool) get_transient( 'aq_chat_on_' . (int) $uid );
	}

	// ── Video calls (Jitsi) ─────────────────────────────────────────────────
	//
	// THE SERVER NEVER LEARNS THE ROOM. A call is proposed as an ordinary sealed message — the room
	// name (160 bits of client-side entropy) lives inside the ciphertext with everything else, so
	// the public database says only "these two people had a call at 14:05", exactly as much as it
	// already says about a photo. What the server DOES hold is a 45-second beacon saying somebody is
	// ringing, because a ring has to reach a member who is reading a different page — and a beacon
	// that named the room would hand a walk-in key to every visitor of /data/.

	/** POST chat/call {with, action:ring|end} — start or stop ringing the other side. */
	public static function call( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_chat_call', 20, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = Rest::uid();
		$peer = Rest::pint( $req, 'with', 0 );
		if ( ! $peer || ! get_userdata( $peer ) ) { return Rest::err( 'bad_peer', 'No such member', 404 ); }
		$chat = self::chat_row( $uid, $peer );
		if ( ! $chat ) { return Rest::err( 'no_chat', 'Open the conversation first.', 400 ); }
		$act = (string) Rest::p( $req, 'action', 'ring' );
		if ( $act === 'end' ) {
			// `end` is BOTH sides of hanging up, and it has to clear whichever beacon belongs to the
			// caller. Hanging up as the CALLER clears the ring sitting on the callee; declining as the
			// CALLEE clears the one sitting on me. Only the first case existed at first, so declining
			// a call in the thread left the dock's banner ringing for the rest of the 75 seconds —
			// the one moment a member is most certain they have already answered.
			//
			// Each branch verifies the beacon actually belongs to this pair, so neither side can
			// silence a call they are not part of.
			foreach ( [ $peer => $uid, $uid => $peer ] as $holder => $from ) {
				$r = get_transient( 'aq_chat_ring_' . $holder );
				if ( is_array( $r ) && (int) ( $r['from'] ?? 0 ) === (int) $from ) {
					delete_transient( 'aq_chat_ring_' . $holder );
				}
			}
			return [ 'ok' => true ];
		}
		// Ringing is a message, so it obeys the same gates one does: no calling somebody who blocked
		// you, and no calling out of a request the other side has not accepted.
		if ( self::peer_flag( $chat, $uid, 'block' ) ) { return Rest::err( 'blocked', 'You can’t call this member.', 403 ); }
		if ( self::is_request( $chat, $peer ) ) { return Rest::err( 'pending', 'They haven’t accepted your message request yet.', 403 ); }
		$me   = get_userdata( $uid );
		$name = $me ? $me->display_name : 'A member';
		set_transient( 'aq_chat_ring_' . $peer, [ 'from' => $uid, 'chat' => (int) $chat['id'], 'at' => Data::now() ], self::RING_S );
		if ( ! self::flag( $chat, $peer, 'mute' ) ) {
			Notify::push( $peer, 'call', self::safe_sender_name( $name ) . ' is calling you', '', '/messages/?with=' . rawurlencode( $me ? $me->user_nicename : '' ), 'ring' . $chat['id'] . '-' . intdiv( Data::now(), 60 ) );
		}
		return [ 'ok' => true, 'ringing' => true ];
	}

	/** The live inbound ring for this member, or null — carried on the badge poll so a call reaches
	 *  them wherever they are on the site. Never carries the room (see above). */
	private static function ring_state( $uid ) {
		$r = get_transient( 'aq_chat_ring_' . (int) $uid );
		if ( ! is_array( $r ) || empty( $r['from'] ) ) { return null; }
		return [
			'from' => self::user_card( (int) $r['from'] ),
			'chat' => (int) ( $r['chat'] ?? 0 ),
			'at'   => (int) ( $r['at'] ?? 0 ),
		];
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
		self::resync_last( (int) $chat['id'] );
	}

	/**
	 * Re-point a conversation's denormalised last_id/last_at at the newest row that still exists.
	 *
	 * Rows leave by two doors — the disappearing-message purge and unsend — and neither used to
	 * touch this. A conversation whose last message was removed kept a last_id naming a row that is
	 * gone, which is the cheap watermark the unread badge and the request box both test against:
	 * a request whose only message was unsent stayed in the recipient's Requests list forever,
	 * pointing at nothing.
	 */
	private static function resync_last( $chat_id ) {
		$row = Data::one(
			'SELECT id, created FROM ' . Data::t( 'aq_chat_msgs' ) . ' WHERE chat_id = %d ORDER BY id DESC LIMIT 1',
			[ (int) $chat_id ]
		);
		Data::update( 'aq_chats', [
			'last_id' => $row ? (int) $row['id'] : 0,
			'last_at' => $row ? (int) $row['created'] : 0,
		], [ 'id' => (int) $chat_id ] );
	}

	// ── Keys ────────────────────────────────────────────────────────────────

	/**
	 * POST chat/keys {pub} — register the caller's device public key (base64 uncompressed P-256
	 * point). Idempotent: re-posting the active key returns its existing id; a different key
	 * APPENDS (rotation) and becomes active. The private half never reaches this server.
	 */
	/**
	 * GET chat/vault — the caller's own sealed key blob, or null.
	 *
	 * Caller's OWN only. The blob is safe to publish (see the table comment), but there is no reason
	 * to hand one member another's, and an endpoint that will only ever serve you your own is one
	 * fewer thing to reason about later.
	 */
	public static function get_vault( $req ) {
		self::ensure_tables();
		$uid = Rest::uid();
		$row = Data::one( 'SELECT vault_key, fp, updated FROM ' . Data::t( 'aq_chat_vault' ) . ' WHERE user_id = %d', [ $uid ] );
		if ( ! $row ) { return [ 'blob' => null, 'fp' => '', 'at' => 0 ]; }
		$blob = json_decode( (string) $row['vault_key'], true );
		return [ 'blob' => is_array( $blob ) ? $blob : null, 'fp' => (string) $row['fp'], 'at' => (int) $row['updated'] ];
	}

	/**
	 * POST chat/vault — store (or replace) the caller's sealed key blob.
	 *
	 * The server validates SHAPE and nothing else: it cannot check the contents of something it has
	 * no key for, and pretending otherwise would be theatre. `fp` is the fingerprint of the PUBLIC
	 * key this blob restores, so a device can tell whether the escrow matches the key currently
	 * registered without unwrapping anything.
	 */
	public static function set_vault( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_chat_vault', 10, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = Rest::uid();
		$blob = Rest::p( $req, 'blob', null );
		$fp   = preg_replace( '/[^a-f0-9]/', '', strtolower( (string) Rest::p( $req, 'fp', '' ) ) );
		if ( ! is_array( $blob ) || empty( $blob['ct'] ) || empty( $blob['iv'] ) || empty( $blob['salt'] ) ) {
			return Rest::err( 'bad_blob', 'Expected a sealed key blob.', 400 );
		}
		$json = wp_json_encode( [
			'v'    => (int) ( $blob['v'] ?? 1 ),
			'iter' => (int) ( $blob['iter'] ?? 0 ),
			'salt' => (string) $blob['salt'],
			'iv'   => (string) $blob['iv'],
			'ct'   => (string) $blob['ct'],
		] );
		// A blob is ~1KB of base64; anything far larger is not one of ours.
		if ( ! $json || strlen( $json ) > 8000 || strlen( $fp ) !== 64 ) {
			return Rest::err( 'bad_blob', 'Expected a sealed key blob.', 400 );
		}
		$now = Data::now();
		Data::upsert( 'aq_chat_vault', [ 'user_id' => $uid ], [ 'vault_key' => $json, 'fp' => $fp, 'created' => $now, 'updated' => $now ] );
		return [ 'ok' => true, 'at' => $now ];
	}

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
			self::touch_key( (int) $cur['id'] );
			return [ 'ok' => true, 'key' => self::key_payload( $cur ), 'rotated' => false ];
		}
		// IDEMPOTENT ACROSS THE MEMBER'S WHOLE KEY HISTORY, not just their newest key. A member who
		// restores their escrowed key on a second device is presenting a public key they ALREADY
		// registered; inserting it again would mint a second id for one key, and every message sealed
		// under the first id would then be addressed to an epoch nothing points at. Same key, same id.
		$known = Data::one(
			'SELECT id, pub, fp, created FROM ' . Data::t( 'aq_chat_keys' ) . ' WHERE user_id = %d AND pub = %s ORDER BY id ASC LIMIT 1',
			[ $uid, $pub ]
		);
		if ( $known ) {
			// THE PATH THAT WAS THE BUG. A second device presenting a key it registered long ago gets
			// its original id back — correct, and until now that was the end of it, so the member's
			// active key stayed whatever some other device had registered later. Presenting it is the
			// device saying "I am the one being used"; that is what makes it the seal target.
			self::touch_key( (int) $known['id'] );
			return [ 'ok' => true, 'key' => self::key_payload( $known ), 'rotated' => false ];
		}
		$id = Data::insert( 'aq_chat_keys', [
			'user_id' => $uid,
			'pub'     => $pub,
			'fp'      => hash( 'sha256', $raw ),
			'seen'    => Data::now(),
			'created' => Data::now(),
		] );
		return [ 'ok' => true, 'key' => self::key_payload( self::active_key( $uid ) ), 'rotated' => (bool) $cur, 'id' => $id ];
	}

	/**
	 * GET chat/keys?user=<slug|id> — a member's active public key (public: the same bytes sit in
	 * the open DB). Null key = they haven't opened ArtaChat yet, so nobody can write to them.
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
	 *
	 * ?box= picks WHICH list: `chats` (the inbox), `requests` (strangers waiting on a yes),
	 * `archived`, or `blocked`. One route, because they are one query with a different filter, and
	 * because a conversation moves between them — a request that gets accepted must not need a
	 * different endpoint to appear.
	 */
	public static function list_chats( $req ) {
		self::ensure_tables();
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$box = (string) Rest::p( $req, 'box', 'chats' );
		if ( ! in_array( $box, [ 'chats', 'requests', 'archived', 'blocked' ], true ) ) { $box = 'chats'; }
		// No mark_presence here — see mark_presence(). Listing conversations is browsing, not being
		// in one, and marking presence on this poll silently suppressed every bell and away-email
		// for as long as a Messages tab stayed open.
		//
		// The per-side flags are selected as `mine_*` so the filters below read the same whichever
		// half of the pair the caller is.
		$mine = fn( $col ) => "( CASE WHEN c.a_uid = %d THEN c.a_$col ELSE c.b_$col END )";
		$sel  = 'SELECT c.*, ' . $mine( 'block' ) . ' AS mine_block, ' . $mine( 'mute' ) . ' AS mine_mute, '
			. $mine( 'pin' ) . ' AS mine_pin, ' . $mine( 'arch' ) . ' AS mine_arch';
		$args = [ $uid, $uid, $uid, $uid ];       // the four CASE expressions above
		$where = ' FROM ' . Data::t( 'aq_chats' ) . ' c WHERE ( c.a_uid = %d OR c.b_uid = %d )';
		array_push( $args, $uid, $uid );
		if ( $box === 'blocked' ) {
			$where .= ' AND ' . $mine( 'block' ) . ' = 1';
			$args[] = $uid;
		} else {
			$where .= ' AND ' . $mine( 'block' ) . ' = 0';
			$args[] = $uid;
			if ( $box === 'requests' ) {
				// Somebody else's ask, not yet answered — and never an empty shell (a conversation row
				// is created by set_ttl too, and an empty one is not a request).
				$where .= ' AND c.accepted = 0 AND c.starter != %d AND c.last_id > 0';
				$args[] = $uid;
			} elseif ( $box === 'archived' ) {
				$where .= ' AND ' . $mine( 'arch' ) . ' = 1';
				$args[] = $uid;
			} else {
				$where .= ' AND ' . $mine( 'arch' ) . ' = 0 AND ( c.accepted = 1 OR c.starter = %d )';
				array_push( $args, $uid, $uid );
			}
		}
		// Pinned conversations first, then most recent — the one ordering every messenger has, and
		// the reason `pin` exists at all.
		$order = ' ORDER BY ' . $mine( 'pin' ) . ' DESC, c.last_id DESC LIMIT 60';
		$args[] = $uid;
		$rows = Data::all( $sel . $where . $order, $args );
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
				// Per-side state, from the caller's point of view only. `pending` = they asked and I
				// have not answered; `asked` = I asked and they have not — two different rows in the
				// UI, and the second is the reason an outgoing request stays in my own inbox.
				'pending' => self::is_request( $r, $uid ),
				'asked'   => ! (int) $r['accepted'] && (int) $r['starter'] === $uid,
				'muted'   => (int) ( $r['mine_mute'] ?? 0 ) === 1,
				'pinned'  => (int) ( $r['mine_pin'] ?? 0 ) === 1,
				'archived' => (int) ( $r['mine_arch'] ?? 0 ) === 1,
				'blocked' => (int) ( $r['mine_block'] ?? 0 ) === 1,
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
		return [
			'items'    => $items,
			'me'       => $uid,
			'keys'     => $keys,
			'my_key'   => self::key_payload( self::active_key( $uid ) ),
			'box'      => $box,
			// Always shipped, whichever box was asked for, so the tab that is NOT on screen can still
			// carry its badge without a second request.
			'requests' => self::request_count( $uid ),
			// …and the inbound ring, for the same reason: while a surface is showing the list, the
			// badge poll is switched OFF (chat-store), so this is the only thing still asking.
			'ring'     => self::ring_state( $uid ),
		];
	}

	/**
	 * POST chat/relation {with, action} — every per-side decision about one conversation in one
	 * route: accept · decline · block · unblock · mute · unmute · pin · unpin · archive · unarchive.
	 *
	 * They are one route because they are one row and one shape of authorisation — "this is MY side
	 * of MY conversation" — and because the alternative is ten near-identical handlers that drift.
	 *
	 * ACCEPT and DECLINE are the two ends of a message request. Accepting is permanent and mutual:
	 * the conversation becomes an ordinary one for both of us. Declining sets my block flag, which
	 * is honest about what declining actually does — it stops them writing — and, unlike deleting
	 * the thread, does not reach into the other person's copy of a conversation they can still see.
	 * It is reversible from the Blocked list; nothing here destroys a message.
	 */
	public static function relation( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_chat_rel', 40, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = Rest::uid();
		$peer = Rest::pint( $req, 'with', 0 );
		if ( ! $peer || ! get_userdata( $peer ) ) { return Rest::err( 'bad_peer', 'No such member', 404 ); }
		$act  = (string) Rest::p( $req, 'action', '' );
		$chat = self::chat_row( $uid, $peer );
		if ( ! $chat ) { return Rest::err( 'no_chat', 'No conversation with that member.', 404 ); }
		$s = self::side( $chat, $uid );
		// action → the column it sets and the value it sets. `accept` is the one that is not a
		// per-side flag: it clears the request for BOTH sides, which is the whole point of accepting.
		$map = [
			'accept'    => [ 'accepted', 1 ],
			'decline'   => [ $s . '_block', 1 ],
			'block'     => [ $s . '_block', 1 ],
			'unblock'   => [ $s . '_block', 0 ],
			'mute'      => [ $s . '_mute', 1 ],
			'unmute'    => [ $s . '_mute', 0 ],
			'pin'       => [ $s . '_pin', 1 ],
			'unpin'     => [ $s . '_pin', 0 ],
			'archive'   => [ $s . '_arch', 1 ],
			'unarchive' => [ $s . '_arch', 0 ],
		];
		if ( ! isset( $map[ $act ] ) ) { return Rest::err( 'bad_action', 'Unknown action.', 400 ); }
		// ONLY THE RECIPIENT MAY ACCEPT. Every other action here is per-side and therefore
		// self-authorising — but `accept` is the one that clears the request for BOTH of us, so
		// without this the person who opened the conversation could accept their own request and
		// walk straight past the gate. The cap on messages would still hold; the request box, the
		// one-notification rule and the recipient's actual consent would not.
		if ( $act === 'accept' && (int) $chat['starter'] === $uid && (int) $chat['accepted'] !== 1 ) {
			return Rest::err( 'not_yours', 'Only the person you wrote to can accept a message request.', 403 );
		}
		[ $col, $val ] = $map[ $act ];
		$patch = [ $col => $val ];
		// Accepting also un-blocks and un-archives: saying yes to someone can't leave the thread in
		// a box where the yes has no visible effect.
		if ( $act === 'accept' ) { $patch[ $s . '_block' ] = 0; $patch[ $s . '_arch' ] = 0; }
		// Un-blocking a conversation you never accepted returns it to the request box rather than
		// silently letting them back into your inbox.
		Data::update( 'aq_chats', $patch, [ 'id' => (int) $chat['id'] ] );
		$fresh = self::chat_row( $uid, $peer );
		return [
			'ok'       => true,
			'action'   => $act,
			'pending'  => self::is_request( $fresh, $uid ),
			'blocked'  => self::flag( $fresh, $uid, 'block' ),
			'muted'    => self::flag( $fresh, $uid, 'mute' ),
			'pinned'   => self::flag( $fresh, $uid, 'pin' ),
			'archived' => self::flag( $fresh, $uid, 'arch' ),
			'requests' => self::request_count( $uid ),
		];
	}

	/**
	 * GET chat/members?q=&cursor= — the member DIRECTORY with live presence: everyone you could
	 * write to, who is online right now, and who has a device key yet.
	 *
	 * There is nothing to hide here — the whole user table is already public in /data/ — so this
	 * exposes exactly what that does plus the presence beacon, and no more. Ordered online-first
	 * (then by name) so the answer to "who is around?" is the top of the list. `has_key` is what
	 * actually matters before writing: a member who has never opened ArtaChat has published no
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
		// How many more messages this member may add to a request the other side has not answered —
		// shown in the composer, so the cap is a visible rule rather than a refusal that arrives
		// without warning at the fourth message.
		$left = self::REQUEST_MAX;
		if ( $chat && ! (int) $chat['accepted'] && (int) $chat['starter'] === $uid ) {
			$left = max( 0, self::REQUEST_MAX - (int) Data::col(
				'SELECT COUNT(*) FROM ' . Data::t( 'aq_chat_msgs' ) . ' WHERE chat_id = %d AND sender_id = %d',
				[ (int) $chat['id'], $uid ]
			) );
		}
		return [
			'chat_id'     => $chat ? (int) $chat['id'] : 0,
			'me'          => $uid,
			'peer'        => self::user_card( $peer ),
			// The caller's side of this conversation — what the thread header and composer need to
			// know before showing a send box: is this an unanswered request (mine or theirs), have
			// either of us blocked the other, is it muted/pinned/archived.
			'pending'      => $chat ? self::is_request( $chat, $uid ) : false,
			'asked'        => $chat ? ( ! (int) $chat['accepted'] && (int) $chat['starter'] === $uid ) : false,
			// BEFORE the first word is typed, not after it is sent. `asked` can only be true once a
			// message exists, so someone writing to a stranger learned their message was a request —
			// capped at three, deliverable only if the other side agrees — from a line that appeared
			// AFTERWARDS. This is the same question asked one moment earlier: if I write here now,
			// is it a request? Only meaningful while the conversation does not exist yet.
			'will_request' => $chat ? false : ! self::pre_accepted( $uid, $peer ),
			'request_left' => $left,
			'blocked'      => $chat ? self::flag( $chat, $uid, 'block' ) : false,
			'blocked_by'   => $chat ? self::peer_flag( $chat, $uid, 'block' ) : false,
			'muted'        => $chat ? self::flag( $chat, $uid, 'mute' ) : false,
			'pinned'       => $chat ? self::flag( $chat, $uid, 'pin' ) : false,
			'archived'     => $chat ? self::flag( $chat, $uid, 'arch' ) : false,
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
		// First contact mints the row, and ensure_chat() is where "conversation or REQUEST" is decided.
		$chat = self::ensure_chat( $uid, $peer );
		if ( ! $chat ) { return Rest::err( 'server_error', 'Could not open the conversation.', 500 ); }
		// ── The two gates a message has to pass before it is stored ──
		// Blocked: silence, stated plainly to the sender. Telling them is the honest option — a
		// message that vanishes without a word is worse for everyone, and blocking is public
		// metadata in this database anyway, so pretending otherwise would fool nobody.
		if ( self::peer_flag( $chat, $uid, 'block' ) ) {
			return Rest::err( 'blocked', 'This member isn’t accepting messages from you.', 403 );
		}
		// Request: the sender gets REQUEST_MAX messages to say who they are, and then it waits.
		if ( ! (int) $chat['accepted'] ) {
			if ( (int) $chat['starter'] === $uid ) {
				$sent = (int) Data::col(
					'SELECT COUNT(*) FROM ' . Data::t( 'aq_chat_msgs' ) . ' WHERE chat_id = %d AND sender_id = %d',
					[ (int) $chat['id'], $uid ]
				);
				if ( $sent >= self::REQUEST_MAX ) {
					return Rest::err( 'pending', 'They haven’t accepted your message request yet — you can write again once they do.', 403 );
				}
			} else {
				// Replying IS accepting. There is no way to answer a request by accident, so asking
				// the recipient to press a button they have already effectively pressed is friction
				// with nothing on the other side of it.
				Data::update( 'aq_chats', [ 'accepted' => 1 ], [ 'id' => (int) $chat['id'] ] );
				$chat['accepted'] = 1;
			}
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
		//
		// A MUTED conversation and an already-announced REQUEST are both silent. A request rings
		// once — the first message — and then the other two the sender is allowed say nothing more
		// than the first did: the recipient has been told somebody is asking, and repeating it is
		// how a request box becomes the thing it was built to prevent.
		$is_request = ! (int) $chat['accepted'] && (int) $chat['starter'] === $uid;
		$first_ask  = $is_request && (int) Data::col(
			'SELECT COUNT(*) FROM ' . Data::t( 'aq_chat_msgs' ) . ' WHERE chat_id = %d AND sender_id = %d',
			[ (int) $chat['id'], $uid ]
		) === 1;
		if ( (int) Rest::p( $req, 'notify', 1 ) === 1
			&& ! self::in_chat( $peer, (int) $chat['id'] )
			&& ! self::flag( $chat, $peer, 'mute' )
			&& ( ! $is_request || $first_ask ) ) {
			$me   = get_userdata( $uid );
			$name = $me ? $me->display_name : 'A member';
			Notify::push(
				$peer, 'dm',
				$name . ( $is_request ? ' wants to message you' : ' sent you an encrypted message' ),
				'', '/messages/', 'dm' . $id
			);
			self::email_dm( $peer, $uid, $name, (int) $chat['id'], $id, $is_request );
		}
		return [ 'ok' => true, 'id' => $id, 'chat_id' => (int) $chat['id'], 'at' => $now, 'request' => $is_request ];
	}

	/**
	 * Email the recipient that a message is waiting, while they are away.
	 *
	 * NOT IMMEDIATELY — after QUIET_S. An email about an unread message is only worth sending if the
	 * message is still unread when it arrives, and the overwhelmingly common case is that it is not:
	 * someone is mid-conversation, steps away for ninety seconds, comes back. Sending on the instant
	 * the presence beacon goes dark turned every such pause into an inbox item about a message the
	 * member had already read by the time they saw the notification. So the send is scheduled a few
	 * minutes out and RE-CHECKED at the last moment against the read watermark: read it in the
	 * meantime — on any device, in the dock, anywhere — and the email is simply never sent.
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
	/** How long a message must sit UNREAD before we email about it. Long enough that stepping away
	 *  from an open conversation costs nobody an inbox item; short enough to still be a notification
	 *  rather than a digest. */
	const EMAIL_QUIET_S = 300;

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

	private static function email_dm( $peer, $from, $sender_name, $chat_id = 0, $msg_id = 0, $is_request = false ) {
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

		// The cooldown is claimed NOW rather than at send time, so a burst of ten messages schedules
		// one email, not ten that each discover the others at the last moment.
		set_transient( $pair, 1, self::EMAIL_COOLDOWN );
		set_transient( $rk, (int) get_transient( $rk ) + 1, self::EMAIL_RCPT_WINDOW );
		set_transient( $sk, (int) get_transient( $sk ) + 1, self::EMAIL_SENDER_WINDOW );

		// Off the request path — the sender's message is already stored and must not wait on SMTP —
		// and QUIET_S out, so a member who reads it in the meantime is never emailed at all.
		wp_schedule_single_event(
			time() + self::EMAIL_QUIET_S, 'aq_dm_email',
			[ $peer, self::safe_sender_name( $sender_name ), (int) $chat_id, (int) $msg_id, $is_request ? 1 : 0 ]
		);
	}

	/**
	 * Cron target for the deferred DM email. Fail-soft: a bounce never costs anyone their message,
	 * and a failed send releases the pair cooldown so the next message can still be announced.
	 *
	 * The LAST-MOMENT CHECK lives here: an email about an unread message is only true while the
	 * message is unread. `$msg_id` is compared with the recipient's own read watermark, so anything
	 * they caught up on during the quiet window is silently dropped.
	 */
	public static function send_dm_email( $peer, $sender_name, $chat_id = 0, $msg_id = 0, $is_request = 0 ) {
		$u = get_userdata( (int) $peer );
		if ( ! $u || ! is_email( $u->user_email ) || ! class_exists( '\\AQ\\Mailer' ) ) { return; }
		if ( get_user_meta( (int) $peer, 'aq_dm_email_off', true ) ) { return; } // opted out since
		// Still unread? (Older scheduled events carry no ids — those send, as they always did.)
		if ( $chat_id && $msg_id ) {
			$c = Data::one( 'SELECT a_uid, b_uid, a_read, b_read FROM ' . Data::t( 'aq_chats' ) . ' WHERE id = %d', [ (int) $chat_id ] );
			if ( ! $c ) { return; } // conversation gone (declined, purged) — nothing to announce
			$is_a = (int) $c['a_uid'] === (int) $peer;
			$read = (int) ( $is_a ? $c['a_read'] : $c['b_read'] );
			if ( $read >= (int) $msg_id ) {
				// They read it. Release the pair cooldown so the NEXT message that lands while they
				// are away is announced normally instead of inheriting this one's silence.
				self::clear_dm_mail_cooldown( (int) $peer, (int) ( $is_a ? $c['b_uid'] : $c['a_uid'] ) );
				return;
			}
		}
		$ok = false;
		try {
			$ok = (bool) Mailer::send(
				(int) $is_request ? 'dm_request' : 'dm_received',
				$u->user_email, [ 'sender' => (string) $sender_name ]
			);
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
		// Through ensure_chat, so setting a timer on a conversation that does not exist yet cannot
		// mint an ACCEPTED one and walk past the request gate (see that method).
		$chat = self::ensure_chat( $uid, $peer );
		if ( ! $chat ) { return Rest::err( 'server_error', 'Could not open the conversation.', 500 ); }
		// A disappearing-message timer is a shared setting, so it is not something a stranger gets to
		// impose while their request is still unanswered.
		if ( self::is_request( $chat, $peer ) || self::peer_flag( $chat, $uid, 'block' ) ) {
			return Rest::err( 'pending', 'You can set a timer once they’ve accepted your message request.', 403 );
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
		self::resync_last( (int) $row['chat_id'] ); // the list's watermark must not name a deleted row
		return [ 'ok' => true ];
	}

	/**
	 * POST chat/fetch {url} — pull a remote image/GIF on the member's behalf and hand back the raw
	 * bytes (base64) for the browser to SEAL and upload like any other attachment.
	 *
	 * This exists so "paste a GIF link" can work without the recipient's browser ever touching the
	 * source host: by the time the message is sent, the GIF is ciphertext in our own blob store, and
	 * opening it reveals nothing to anyone. Fetching client-side was not an option either way — our
	 * CSP `connect-src` is 'self', deliberately.
	 *
	 * Fetching an arbitrary URL from the server is an SSRF primitive, so it is fenced accordingly:
	 * https only; no redirects followed (a 302 to 169.254.169.254 is the classic bypass, and
	 * validating hop one proves nothing about hop two); every resolved address checked against the
	 * private/loopback/link-local ranges; a media content type from a fixed list; and a hard byte
	 * ceiling enforced on the response we actually received, not on the Content-Length it claimed.
	 */
	public static function fetch_url( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_chat_fetch', 12, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$url  = trim( (string) Rest::p( $req, 'url', '' ) );
		$bits = wp_parse_url( $url );
		if ( ! $bits || strtolower( $bits['scheme'] ?? '' ) !== 'https' || empty( $bits['host'] ) ) {
			return Rest::err( 'bad_url', 'Paste an https:// link to an image or GIF.', 400 );
		}
		$host = $bits['host'];
		// Every address the host resolves to must be public. gethostbyname returns the input string
		// unchanged when it cannot resolve, which is not an address — and therefore not allowed.
		$ips = [];
		if ( filter_var( $host, FILTER_VALIDATE_IP ) ) {
			$ips = [ $host ];
		} else {
			$recs = @dns_get_record( $host, DNS_A | DNS_AAAA ) ?: [];
			foreach ( $recs as $r ) {
				if ( ! empty( $r['ip'] ) )   { $ips[] = $r['ip']; }
				if ( ! empty( $r['ipv6'] ) ) { $ips[] = $r['ipv6']; }
			}
		}
		if ( ! $ips ) { return Rest::err( 'bad_url', 'That host doesn’t resolve.', 400 ); }
		foreach ( $ips as $ip ) {
			if ( ! filter_var( $ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE ) ) {
				return Rest::err( 'bad_url', 'That address isn’t reachable from here.', 400 );
			}
		}
		// wp_SAFE_remote_get, not wp_remote_get: WP's own SSRF guard (wp_http_validate_url) runs on
		// the request AND on every redirect the transport would follow, which is the one thing the
		// check above genuinely cannot do — DNS can answer differently between our resolution and
		// curl's. Two independent guards, and the belt is the one that sees the second hop.
		$resp = wp_safe_remote_get( $url, [
			'timeout'     => 12,
			'redirection' => 0,   // see the docblock: a followed redirect is an unvalidated second request
			'headers'     => [ 'Accept' => implode( ',', self::FETCH_MIME ) ],
		] );
		if ( is_wp_error( $resp ) ) { return Rest::err( 'fetch_failed', 'Couldn’t download that link.', 502 ); }
		if ( (int) wp_remote_retrieve_response_code( $resp ) !== 200 ) {
			return Rest::err( 'fetch_failed', 'That link didn’t return an image.', 502 );
		}
		$mime = strtolower( trim( explode( ';', (string) wp_remote_retrieve_header( $resp, 'content-type' ) )[0] ) );
		if ( ! in_array( $mime, self::FETCH_MIME, true ) ) {
			return Rest::err( 'bad_type', 'That link isn’t an image, GIF or MP4.', 400 );
		}
		$body = (string) wp_remote_retrieve_body( $resp );
		if ( $body === '' || strlen( $body ) > self::FETCH_MAX ) {
			return Rest::err( 'too_big', 'That file is empty or larger than 5 MB.', 400 );
		}
		return [ 'ok' => true, 'mime' => $mime, 'size' => strlen( $body ), 'data' => base64_encode( $body ) ];
	}

	/**
	 * Cron: unlink sealed attachments no message points at.
	 *
	 * chat/blob stores the bytes BEFORE chat/send names them, so every abandoned composer — a failed
	 * send, a closed tab, a member who changed their mind — leaves an orphan on disk that nothing
	 * will ever read or delete. One a day is invisible; the daily budget allows 200 MB per member,
	 * so at the ceiling this is the difference between a bounded store and an unbounded one.
	 *
	 * The 24-hour floor matters: a file younger than that may be an upload whose chat/send has not
	 * arrived yet, and deleting it would break a message as it was being written.
	 */
	public static function gc_blobs() {
		self::ensure_tables();
		[ $dir ] = self::blob_dir();
		if ( ! is_dir( $dir ) ) { return 0; }
		$files = glob( $dir . '/*.bin' ) ?: [];
		if ( ! $files ) { return 0; }
		$cutoff = time() - DAY_IN_SECONDS;
		$stale  = [];
		foreach ( $files as $f ) {
			if ( @filemtime( $f ) < $cutoff ) { $stale[ basename( $f ) ] = $f; }
		}
		if ( ! $stale ) { return 0; }
		global $wpdb;
		$n = 0;
		// Ask the DB about the stale names only, in chunks — never load every referenced blob name.
		foreach ( array_chunk( array_keys( $stale ), 200 ) as $chunk ) {
			$ph   = implode( ',', array_fill( 0, count( $chunk ), '%s' ) );
			$live = (array) $wpdb->get_col( $wpdb->prepare(
				'SELECT `blob` FROM ' . Data::t( 'aq_chat_msgs' ) . " WHERE `blob` IN ($ph)", $chunk
			) );
			foreach ( array_diff( $chunk, $live ) as $name ) {
				if ( @unlink( $stale[ $name ] ) ) { $n++; }
			}
		}
		return $n;
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
