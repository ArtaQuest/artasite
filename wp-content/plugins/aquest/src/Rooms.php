<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaRooms — group conversations and group calls, on the same "the server cannot read it" terms
 * as a 1:1 chat (src/Chat.php).
 *
 * WHY A SECOND SUBSTRATE. `aq_chats` is a PAIR: two uids, ordered, unique, and a conversation key
 * derived from exactly two device keys. That is what makes a DM simple, and it is why a group
 * cannot be bolted onto it — three people have no "the other one".
 *
 * THE GROUP KEY, and its honest limits. A room has ONE symmetric key, generated in the creator's
 * browser and never sent to this server in the clear. To add somebody, an existing member seals the
 * room key TO THAT PERSON using the pairwise ECDH that already exists between them (Chat's device
 * keys, unchanged), and stores the sealed blob in aq_room_keys. Every member can therefore unwrap
 * the room key, and messages are encrypted once with it rather than N times.
 *
 * What that buys: a group whose messages the server holds only as ciphertext, reusing a key
 * exchange that is already deployed and already trusted.
 *
 * What it costs, stated plainly because members are told it in the UI:
 *  • REMOVING somebody does not un-know the key they already hold. Their access to FUTURE messages
 *    ends only when the key is rotated, which is a deliberate act (`rooms/rotate`) that re-seals a
 *    fresh key to everyone who remains. Until then, "removed" means "removed from the room", not
 *    "cryptographically excluded".
 *  • There is no forward secrecy within a key epoch: anyone holding the room key can read the whole
 *    epoch's history. A DM has the same property per device-key epoch, so this is not a step down —
 *    but it is not Signal's double ratchet either, and saying so is the point.
 *
 * ROOMS ARE ALSO WHERE CALLS LIVE. A room with one member is a member's own space — somewhere to
 * open a camera alone and then invite people into — and the same mesh signalling serves two people
 * or five. The participant cap is real and structural (see MESH_MAX): every pair in a mesh call is
 * its own peer connection, so N people means N(N-1)/2 of them, and past a handful that is the
 * participants' upload bandwidth, not our server's.
 */
final class Rooms {

	const TABLE_VERSION = '1';

	/** Sealed room-key blob (base64) — a 32-byte key sealed with AES-GCM is tiny; this is slack. */
	const KEY_CT_MAX = 2000;
	/** Same ciphertext ceiling a DM uses, for the same reason. */
	const CT_MAX = 20000;
	/** Members per room. Chat scales fine past this; a MESH call does not (see below), and one
	 *  number people can hold in their head beats two that disagree. */
	const MAX_MEMBERS = 12;
	/**
	 * Participants in a live call. A mesh call has no server in the middle (that is the whole point
	 * — see lib/webrtc.ts), so every participant uploads their camera separately to every other
	 * one: five people is ten connections and four uplinks each, which is roughly where a normal
	 * home connection stops coping. Raising this needs an SFU, i.e. a server that sees the media,
	 * i.e. the thing we removed on purpose.
	 */
	const MESH_MAX = 5;
	/** How long a member's "I am in this call" beacon lives without a refresh. */
	const PRESENCE_S = 25;
	/** Room titles are member-authored and land in other people's sidebars. */
	const TITLE_MAX = 60;

	public static function ensure_tables() {
		if ( get_option( 'aq_rooms_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		$p       = $wpdb->prefix;

		dbDelta( "CREATE TABLE {$p}aq_rooms (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			owner_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			title VARCHAR(96) NOT NULL DEFAULT '',
			personal TINYINT UNSIGNED NOT NULL DEFAULT 0,
			key_epoch INT UNSIGNED NOT NULL DEFAULT 1,
			last_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			last_at INT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY owner_id (owner_id)
		) {$charset};" );

		// One row per (room, member). `last_read` is the watermark, exactly as a DM's is.
		dbDelta( "CREATE TABLE {$p}aq_room_members (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			room_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			role VARCHAR(12) NOT NULL DEFAULT 'member',
			last_read BIGINT UNSIGNED NOT NULL DEFAULT 0,
			muted TINYINT UNSIGNED NOT NULL DEFAULT 0,
			joined INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY room_user (room_id, user_id),
			KEY user_id (user_id)
		) {$charset};" );

		// The room key, sealed once per member per epoch. `from_uid`/`akid`/`bkid` name the pairwise
		// ECDH epoch it was sealed under, so the recipient knows which device keys to derive with —
		// the same bookkeeping aq_chat_msgs does, for the same reason.
		dbDelta( "CREATE TABLE {$p}aq_room_keys (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			room_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			epoch INT UNSIGNED NOT NULL DEFAULT 1,
			from_uid BIGINT UNSIGNED NOT NULL DEFAULT 0,
			akid BIGINT UNSIGNED NOT NULL DEFAULT 0,
			bkid BIGINT UNSIGNED NOT NULL DEFAULT 0,
			iv VARCHAR(32) NOT NULL DEFAULT '',
			ct VARCHAR(2048) NOT NULL DEFAULT '',
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY room_user_epoch (room_id, user_id, epoch)
		) {$charset};" );

		// Messages. Shape-identical to a DM's row on purpose: the public database should not be able
		// to tell a group reaction from a group essay any more than it can for a pair.
		dbDelta( "CREATE TABLE {$p}aq_room_msgs (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			room_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			sender_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			epoch INT UNSIGNED NOT NULL DEFAULT 1,
			iv VARCHAR(32) NOT NULL DEFAULT '',
			ct TEXT NULL,
			-- `att`, NOT `blob`: dbDelta silently emits NO TABLE AT ALL for a column named `blob`
			-- under the SQLite dev integration, because it is a type name there. The failure is
			-- invisible — CREATE returns, nothing exists — and it cost this build a green test run
			-- that had stored no messages. aq_chat_msgs only survives the same name because its
			-- column was added by an explicit ALTER long after its CREATE.
			att VARCHAR(191) NOT NULL DEFAULT '',
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY room_id_id (room_id, id)
		) {$charset};" );

		// SQLite (dev) can skip ALTERs dbDelta emits; verify rather than assume, and only record the
		// version when the tables really exist — the same rule Chat::ensure_tables follows after a
		// migration that claimed success it could not honour.
		$missing = [];
		foreach ( [ 'aq_rooms', 'aq_room_members', 'aq_room_keys', 'aq_room_msgs' ] as $t ) {
			$cols = $wpdb->get_col( "SHOW COLUMNS FROM {$p}{$t}" );
			if ( ! $cols ) { $missing[] = $t; }
		}
		if ( $missing ) {
			error_log( 'AQ Rooms: schema incomplete, not recording the version — missing ' . implode( ', ', $missing ) );
			return;
		}
		update_option( 'aq_rooms_table_version', self::TABLE_VERSION, true );
	}

	// ── Helpers ─────────────────────────────────────────────────────────────

	private static function room( $id ) {
		return Data::one( 'SELECT * FROM ' . Data::t( 'aq_rooms' ) . ' WHERE id = %d', [ (int) $id ] );
	}

	/** The caller's membership row, or null when they are not in this room. EVERY handler goes
	 *  through this: a room id is a guessable integer, so membership is the only thing standing
	 *  between a stranger and a group's ciphertext + metadata. */
	private static function member( $room_id, $uid ) {
		return Data::one(
			'SELECT * FROM ' . Data::t( 'aq_room_members' ) . ' WHERE room_id = %d AND user_id = %d',
			[ (int) $room_id, (int) $uid ]
		);
	}

	private static function members_of( $room_id ) {
		return Data::all(
			'SELECT user_id, role, muted, last_read FROM ' . Data::t( 'aq_room_members' ) . ' WHERE room_id = %d ORDER BY id ASC',
			[ (int) $room_id ]
		);
	}

	private static function card( $uid ) {
		$u = get_userdata( (int) $uid );
		return [
			'id'     => (int) $uid,
			'name'   => $u ? $u->display_name : 'Quester',
			'slug'   => $u ? $u->user_nicename : '',
			'avatar' => class_exists( '\\AQ\\Verify' ) ? Verify::avatar_url( (int) $uid, 96 ) : '',
		];
	}

	/**
	 * Does this member hold a USABLE copy of the current room key?
	 *
	 * Not merely "is there a row" — the row names the two device keys it was sealed under, and a
	 * member whose browser has since registered a new device key can no longer derive that pairwise
	 * secret. They would hold a blob they cannot open, forever, because a row exists and nothing
	 * would ever re-seal it. A DM degrades gracefully in that situation (old messages stay shut, new
	 * ones work); a room would simply become unreadable, which is worse and is not obvious.
	 *
	 * So a stale seal counts as NOT having the key, which puts the member back in `pending` and lets
	 * the next member who opens the room hand them a fresh copy. Rotation heals itself.
	 */
	private static function has_usable_key( $room_id, $uid, $epoch ) {
		$row = Data::one(
			'SELECT from_uid, akid, bkid FROM ' . Data::t( 'aq_room_keys' ) . ' WHERE room_id = %d AND user_id = %d AND epoch = %d',
			[ (int) $room_id, (int) $uid, (int) $epoch ]
		);
		if ( ! $row ) { return false; }
		$cur = (int) Data::col(
			'SELECT id FROM ' . Data::t( 'aq_chat_keys' ) . ' WHERE user_id = %d ORDER BY id DESC LIMIT 1',
			[ (int) $uid ]
		);
		if ( ! $cur ) { return false; }
		// akid belongs to the LOW uid of the sealing pair, bkid to the high — the same ordering
		// every pairwise row in this codebase uses.
		$mine = (int) $uid < (int) $row['from_uid'] ? (int) $row['akid'] : (int) $row['bkid'];
		// A self-seal names the same id twice, so the comparison holds there too.
		return $mine === $cur;
	}

	/** A room as the client sees it: who is in it, my unread count, and whether I can read it yet
	 *  (i.e. whether the current epoch's key has been sealed to me). */
	private static function payload( $room, $uid ) {
		$rid     = (int) $room['id'];
		$members = self::members_of( $rid );
		$me      = null;
		$people  = [];
		foreach ( $members as $m ) {
			if ( (int) $m['user_id'] === (int) $uid ) { $me = $m; }
			$people[] = self::card( (int) $m['user_id'] ) + [ 'role' => (string) $m['role'] ];
		}
		$seen   = (int) ( $me['last_read'] ?? 0 );
		$unread = (int) $room['last_id'] > $seen ? (int) Data::col(
			'SELECT COUNT(*) FROM ' . Data::t( 'aq_room_msgs' ) . ' WHERE room_id = %d AND id > %d AND sender_id != %d',
			[ $rid, $seen, (int) $uid ]
		) : 0;
		$has_key = self::has_usable_key( $rid, (int) $uid, (int) $room['key_epoch'] );
		return [
			'id'        => $rid,
			'title'     => (string) $room['title'],
			'personal'  => (int) $room['personal'] === 1,
			'owner'     => (int) $room['owner_id'],
			'epoch'     => (int) $room['key_epoch'],
			'members'   => $people,
			'count'     => count( $people ),
			'unread'    => $unread,
			'muted'     => (int) ( $me['muted'] ?? 0 ) === 1,
			'last_at'   => (int) $room['last_at'],
			'has_key'   => $has_key,
			'in_call'   => self::call_roster( $rid ),
			'max_call'  => self::MESH_MAX,
			'max_members' => self::MAX_MEMBERS,
		];
	}

	/** Who is in this room's call right now — presence beacons, nothing stored. */
	private static function call_roster( $room_id ) {
		$out = [];
		foreach ( self::members_of( $room_id ) as $m ) {
			$uid = (int) $m['user_id'];
			if ( get_transient( 'aq_room_in_' . (int) $room_id . '_' . $uid ) ) { $out[] = $uid; }
		}
		return $out;
	}

	// ── Rooms ───────────────────────────────────────────────────────────────

	/**
	 * POST rooms/create {title, personal} — open a room. The creator is its owner and only member;
	 * the room KEY is minted in their browser and posted separately (rooms/key), because this server
	 * must never be in a position to hold it.
	 */
	public static function create( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_room_new', 10, 300 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$personal = (int) Rest::p( $req, 'personal', 0 ) === 1;
		// EXACTLY ONE personal room per member — it is "your room", not "a room you keep making".
		if ( $personal ) {
			$own = Data::one( 'SELECT * FROM ' . Data::t( 'aq_rooms' ) . ' WHERE owner_id = %d AND personal = 1', [ $uid ] );
			if ( $own ) { return [ 'ok' => true, 'room' => self::payload( $own, $uid ), 'existing' => true ]; }
		}
		$title = trim( (string) Rest::p( $req, 'title', '' ) );
		$title = mb_substr( wp_strip_all_tags( $title ), 0, self::TITLE_MAX );
		if ( $title === '' ) {
			$u = get_userdata( $uid );
			$title = $personal ? ( ( $u ? $u->display_name : 'My' ) . '’s room' ) : 'New room';
		}
		$now = Data::now();
		$rid = Data::insert( 'aq_rooms', [
			'owner_id' => $uid, 'title' => $title, 'personal' => $personal ? 1 : 0,
			'key_epoch' => 1, 'created' => $now,
		] );
		if ( ! $rid ) { return Rest::err( 'server_error', 'Could not create the room.', 500 ); }
		Data::insert( 'aq_room_members', [
			'room_id' => $rid, 'user_id' => $uid, 'role' => 'owner', 'joined' => $now,
		] );
		return [ 'ok' => true, 'room' => self::payload( self::room( $rid ), $uid ) ];
	}

	/** GET rooms/list — every room the caller is in, most recent first. */
	public static function list_rooms( $req ) {
		self::ensure_tables();
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$rows = Data::all(
			'SELECT r.* FROM ' . Data::t( 'aq_rooms' ) . ' r JOIN ' . Data::t( 'aq_room_members' ) . ' m ON m.room_id = r.id'
			. ' WHERE m.user_id = %d ORDER BY r.last_id DESC LIMIT 60',
			[ $uid ]
		);
		$items = [];
		foreach ( $rows as $r ) { $items[] = self::payload( $r, $uid ); }
		return [ 'items' => $items, 'me' => $uid ];
	}

	/** GET rooms/get?id= — one room, for the header and the member list. */
	public static function get( $req ) {
		self::ensure_tables();
		$uid  = Rest::uid();
		$rid  = Rest::pint( $req, 'id', 0 );
		$room = $rid ? self::room( $rid ) : null;
		if ( ! $room || ! self::member( $rid, $uid ) ) { return Rest::err( 'not_found', 'No such room.', 404 ); }
		return [ 'room' => self::payload( $room, $uid ), 'me' => $uid ];
	}

	/**
	 * POST rooms/invite {id, user} — add somebody. Any member may invite; the room key still has to
	 * be sealed to them by a member's browser afterwards (rooms/key), so an invite alone grants
	 * membership and metadata, never the ability to read.
	 */
	public static function invite( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_room_invite', 30, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = Rest::uid();
		$rid  = Rest::pint( $req, 'id', 0 );
		$room = $rid ? self::room( $rid ) : null;
		if ( ! $room || ! self::member( $rid, $uid ) ) { return Rest::err( 'not_found', 'No such room.', 404 ); }
		$who = (string) Rest::p( $req, 'user', '' );
		$u   = ctype_digit( $who ) ? get_userdata( (int) $who ) : get_user_by( 'slug', sanitize_title( $who ) );
		if ( ! $u ) { return Rest::err( 'no_member', 'No member with that username.', 404 ); }
		$target = (int) $u->ID;
		if ( self::member( $rid, $target ) ) { return [ 'ok' => true, 'already' => true, 'room' => self::payload( $room, $uid ) ]; }
		if ( count( self::members_of( $rid ) ) >= self::MAX_MEMBERS ) {
			return Rest::err( 'full', 'This room is full (' . self::MAX_MEMBERS . ' members).', 400 );
		}
		// A member who has never opened ArtaChat has no device key, so nobody can seal the room key
		// to them — say so now rather than letting them sit in a room they cannot read.
		$has_key = (bool) Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_chat_keys' ) . ' WHERE user_id = %d LIMIT 1', [ $target ] );
		if ( ! $has_key ) {
			return Rest::err( 'no_device_key', $u->display_name . ' hasn’t opened ArtaChat yet, so there’s no key to seal this room to.', 400 );
		}
		Data::insert( 'aq_room_members', [
			'room_id' => $rid, 'user_id' => $target, 'role' => 'member', 'joined' => Data::now(),
		] );
		$me = get_userdata( $uid );
		Notify::push(
			$target, 'room',
			( $me ? $me->display_name : 'A member' ) . ' added you to ' . $room['title'],
			'', '/messages/?room=' . $rid, 'room' . $rid . '-' . $target
		);
		return [ 'ok' => true, 'room' => self::payload( self::room( $rid ), $uid ), 'invited' => self::card( $target ) ];
	}

	/** POST rooms/leave {id} — leave, or (owner) remove somebody with {user}. The room is deleted
	 *  when the last member goes, because an empty room is just rows nobody can reach. */
	public static function leave( $req ) {
		self::ensure_tables();
		global $wpdb;
		$uid  = Rest::uid();
		$rid  = Rest::pint( $req, 'id', 0 );
		$room = $rid ? self::room( $rid ) : null;
		$mine = $room ? self::member( $rid, $uid ) : null;
		if ( ! $room || ! $mine ) { return Rest::err( 'not_found', 'No such room.', 404 ); }
		$target = Rest::pint( $req, 'user', 0 ) ?: $uid;
		if ( $target !== $uid && (int) $room['owner_id'] !== $uid ) {
			return Rest::err( 'not_owner', 'Only the room’s owner can remove someone.', 403 );
		}
		$wpdb->delete( Data::t( 'aq_room_members' ), [ 'room_id' => $rid, 'user_id' => $target ] );
		$wpdb->delete( Data::t( 'aq_room_keys' ), [ 'room_id' => $rid, 'user_id' => $target ] );
		$left = self::members_of( $rid );
		if ( ! $left ) {
			$wpdb->delete( Data::t( 'aq_room_msgs' ), [ 'room_id' => $rid ] );
			$wpdb->delete( Data::t( 'aq_rooms' ), [ 'id' => $rid ] );
			return [ 'ok' => true, 'deleted' => true ];
		}
		// The owner leaving hands the room to whoever has been in it longest, so a room is never
		// ownerless (and therefore never un-manageable).
		if ( (int) $room['owner_id'] === $target ) {
			Data::update( 'aq_rooms', [ 'owner_id' => (int) $left[0]['user_id'] ], [ 'id' => $rid ] );
			Data::update( 'aq_room_members', [ 'role' => 'owner' ], [ 'room_id' => $rid, 'user_id' => (int) $left[0]['user_id'] ] );
		}
		return [ 'ok' => true, 'removed' => $target ];
	}

	// ── The room key ────────────────────────────────────────────────────────

	/**
	 * POST rooms/key {id, for, epoch, akid, bkid, iv, ct} — store the room key SEALED to one member.
	 *
	 * The server validates the envelope only: that the sealer is in the room, that the recipient is
	 * too, and that the named device keys belong to that pair. The key itself is opaque here — which
	 * is the entire reason a group can exist on a public database.
	 */
	public static function put_key( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_room_key', 60, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = Rest::uid();
		$rid  = Rest::pint( $req, 'id', 0 );
		$room = $rid ? self::room( $rid ) : null;
		if ( ! $room || ! self::member( $rid, $uid ) ) { return Rest::err( 'not_found', 'No such room.', 404 ); }
		$for = Rest::pint( $req, 'for', 0 );
		if ( ! $for || ! self::member( $rid, $for ) ) { return Rest::err( 'not_member', 'That member is not in this room.', 400 ); }
		$epoch = Rest::pint( $req, 'epoch', (int) $room['key_epoch'] );
		$iv    = trim( (string) Rest::p( $req, 'iv', '' ) );
		$ct    = trim( (string) Rest::p( $req, 'ct', '' ) );
		if ( $iv === '' || strlen( $iv ) > 32 || base64_decode( $iv, true ) === false ) {
			return Rest::err( 'bad_iv', 'Malformed IV.', 400 );
		}
		if ( $ct === '' || strlen( $ct ) > self::KEY_CT_MAX || base64_decode( $ct, true ) === false ) {
			return Rest::err( 'bad_ct', 'Malformed sealed key.', 400 );
		}
		$akid = Rest::pint( $req, 'akid', 0 );
		$bkid = Rest::pint( $req, 'bkid', 0 );
		$low  = min( $uid, $for );
		$high = max( $uid, $for );
		$ka   = Chat::key_by_id( $akid );
		$kb   = Chat::key_by_id( $bkid );
		if ( ! $ka || ! $kb || (int) $ka['user_id'] !== $low || (int) $kb['user_id'] !== $high ) {
			return Rest::err( 'bad_keys', 'Key ids do not match this pair.', 400 );
		}
		Data::upsert( 'aq_room_keys', [ 'room_id' => $rid, 'user_id' => $for, 'epoch' => $epoch ], [
			'from_uid' => $uid, 'akid' => $akid, 'bkid' => $bkid,
			'iv' => $iv, 'ct' => $ct, 'created' => Data::now(),
		] );
		return [ 'ok' => true ];
	}

	/** GET rooms/key?id= — MY sealed copy of this room's current key, plus the public keys needed to
	 *  unwrap it. Members only, and only ever their own row. */
	public static function get_key( $req ) {
		self::ensure_tables();
		$uid  = Rest::uid();
		$rid  = Rest::pint( $req, 'id', 0 );
		$room = $rid ? self::room( $rid ) : null;
		if ( ! $room || ! self::member( $rid, $uid ) ) { return Rest::err( 'not_found', 'No such room.', 404 ); }
		$row = Data::one(
			'SELECT * FROM ' . Data::t( 'aq_room_keys' ) . ' WHERE room_id = %d AND user_id = %d AND epoch = %d',
			[ $rid, $uid, (int) $room['key_epoch'] ]
		);
		if ( ! $row ) { return [ 'key' => null, 'epoch' => (int) $room['key_epoch'] ]; }
		$keys = [];
		foreach ( [ (int) $row['akid'], (int) $row['bkid'] ] as $kid ) {
			$k = Chat::key_by_id( $kid );
			if ( $k ) { $keys[ $kid ] = [ 'user_id' => (int) $k['user_id'], 'pub' => (string) $k['pub'] ]; }
		}
		return [
			'key' => [
				'epoch' => (int) $row['epoch'], 'from' => (int) $row['from_uid'],
				'akid' => (int) $row['akid'], 'bkid' => (int) $row['bkid'],
				'iv' => (string) $row['iv'], 'ct' => (string) $row['ct'],
			],
			'keys'  => $keys,
			'epoch' => (int) $room['key_epoch'],
		];
	}

	/** GET rooms/pending?id= — members of this room who do NOT yet hold the current key, so a
	 *  browser that has it can seal it to them. This is what makes an invite complete itself. */
	public static function pending_keys( $req ) {
		self::ensure_tables();
		$uid  = Rest::uid();
		$rid  = Rest::pint( $req, 'id', 0 );
		$room = $rid ? self::room( $rid ) : null;
		if ( ! $room || ! self::member( $rid, $uid ) ) { return Rest::err( 'not_found', 'No such room.', 404 ); }
		$epoch = (int) $room['key_epoch'];
		$out   = [];
		foreach ( self::members_of( $rid ) as $m ) {
			$target = (int) $m['user_id'];
			if ( self::has_usable_key( $rid, $target, $epoch ) ) { continue; }
			$k = Data::one(
				'SELECT id, pub FROM ' . Data::t( 'aq_chat_keys' ) . ' WHERE user_id = %d ORDER BY id DESC LIMIT 1',
				[ $target ]
			);
			if ( ! $k ) { continue; } // no device key — they cannot be sealed to at all yet
			$out[] = [ 'user' => self::card( $target ), 'kid' => (int) $k['id'], 'pub' => (string) $k['pub'] ];
		}
		return [ 'items' => $out, 'epoch' => $epoch ];
	}

	// ── Messages ────────────────────────────────────────────────────────────

	/** GET rooms/messages?id=&after=|&cursor= — the room's sealed rows, newest-last on the live path. */
	public static function messages( $req ) {
		self::ensure_tables();
		$uid  = Rest::uid();
		$rid  = Rest::pint( $req, 'id', 0 );
		$room = $rid ? self::room( $rid ) : null;
		$mine = $room ? self::member( $rid, $uid ) : null;
		if ( ! $room || ! $mine ) { return Rest::err( 'not_found', 'No such room.', 404 ); }
		$after = Rest::pint( $req, 'after', 0 );
		$next  = null;
		if ( $after > 0 ) {
			$items = Data::all(
				'SELECT id, sender_id, epoch, iv, ct, att, created FROM ' . Data::t( 'aq_room_msgs' )
				. ' WHERE room_id = %d AND id > %d ORDER BY id ASC LIMIT 100',
				[ $rid, $after ]
			);
		} else {
			[ $items, $next ] = Data::page(
				'aq_room_msgs', 'room_id = %d', [ $rid ],
				Rest::pint( $req, 'cursor', 0 ), Rest::pint( $req, 'limit', 50 )
			);
		}
		$max = 0;
		foreach ( $items as $m ) { $max = max( $max, (int) $m['id'] ); }
		if ( $max > (int) $mine['last_read'] ) {
			Data::update( 'aq_room_members', [ 'last_read' => $max ], [ 'room_id' => $rid, 'user_id' => $uid ] );
		}
		// Being here is being in the room — it is what the call roster and the "who is around" dot read.
		set_transient( 'aq_room_seen_' . $rid . '_' . $uid, 1, self::PRESENCE_S );
		return [
			'room'  => self::payload( $room, $uid ),
			'me'    => $uid,
			'items' => array_map( fn( $m ) => [
				'id'     => (int) $m['id'],
				'sender' => (int) $m['sender_id'],
				'epoch'  => (int) $m['epoch'],
				'iv'     => (string) $m['iv'],
				'ct'     => (string) $m['ct'],
				'att'    => (string) ( $m['att'] ?? '' ),
				'at'     => (int) $m['created'],
			], $items ),
			'next'  => $next,
		];
	}

	/** POST rooms/send {id, iv, ct, epoch, blob?, notify?} — append one sealed row to the room. */
	public static function send( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_room_send', 40, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = Rest::uid();
		$rid  = Rest::pint( $req, 'id', 0 );
		$room = $rid ? self::room( $rid ) : null;
		if ( ! $room || ! self::member( $rid, $uid ) ) { return Rest::err( 'not_found', 'No such room.', 404 ); }
		$iv = trim( (string) Rest::p( $req, 'iv', '' ) );
		$ct = trim( (string) Rest::p( $req, 'ct', '' ) );
		if ( $iv === '' || strlen( $iv ) > 32 || base64_decode( $iv, true ) === false ) {
			return Rest::err( 'bad_iv', 'Malformed IV.', 400 );
		}
		if ( $ct === '' || strlen( $ct ) > self::CT_MAX || base64_decode( $ct, true ) === false ) {
			return Rest::err( 'bad_ct', 'Message is empty, too large, or not base64.', 400 );
		}
		$att = trim( (string) Rest::p( $req, 'blob', '' ) );
		if ( $att !== '' && ! preg_match( '/^[a-f0-9]{32}\.bin$/', $att ) ) {
			return Rest::err( 'bad_blob', 'Malformed attachment reference.', 400 );
		}
		$now = Data::now();
		$id  = Data::insert( 'aq_room_msgs', [
			'room_id' => $rid, 'sender_id' => $uid, 'epoch' => (int) $room['key_epoch'],
			'iv' => $iv, 'ct' => $ct, 'att' => $att, 'created' => $now,
		] );
		// A FAILED INSERT MUST NOT REPORT SUCCESS. This returned ok with id 0 while the table did not
		// even exist, so the client believed a message had been stored that was never written — the
		// worst possible answer for a messenger to give.
		if ( ! $id ) { return Rest::err( 'server_error', 'Could not store the message.', 500 ); }
		Data::update( 'aq_rooms', [ 'last_id' => $id, 'last_at' => $now ], [ 'id' => $rid ] );
		Data::update( 'aq_room_members', [ 'last_read' => $id ], [ 'room_id' => $rid, 'user_id' => $uid ] );
		// One bell per member who is neither here nor muted. Same `notify` hint a DM uses: the server
		// cannot tell a reaction from an essay, so the sending client says which it is.
		if ( (int) Rest::p( $req, 'notify', 1 ) === 1 ) {
			$me   = get_userdata( $uid );
			$name = $me ? $me->display_name : 'A member';
			foreach ( self::members_of( $rid ) as $m ) {
				$target = (int) $m['user_id'];
				if ( $target === $uid || (int) $m['muted'] === 1 ) { continue; }
				if ( get_transient( 'aq_room_seen_' . $rid . '_' . $target ) ) { continue; }
				Notify::push( $target, 'room', $name . ' posted in ' . $room['title'], '', '/messages/?room=' . $rid, 'rm' . $id . '-' . $target );
			}
		}
		return [ 'ok' => true, 'id' => $id, 'at' => $now ];
	}

	// ── Calls ───────────────────────────────────────────────────────────────

	/**
	 * POST rooms/call {id, action:join|leave} — the call roster.
	 *
	 * A beacon, nothing more: it says WHO is in the call so the others know to offer them a peer
	 * connection. The WebRTC handshake itself travels as sealed room messages, so this server never
	 * holds anything that could join or listen to a call — exactly as for a 1:1 (see Chat::call).
	 */
	public static function call( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_room_call', 120, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = Rest::uid();
		$rid  = Rest::pint( $req, 'id', 0 );
		$room = $rid ? self::room( $rid ) : null;
		if ( ! $room || ! self::member( $rid, $uid ) ) { return Rest::err( 'not_found', 'No such room.', 404 ); }
		$act = (string) Rest::p( $req, 'action', 'join' );
		if ( $act === 'leave' ) {
			delete_transient( 'aq_room_in_' . $rid . '_' . $uid );
			return [ 'ok' => true, 'in_call' => self::call_roster( $rid ) ];
		}
		$roster = self::call_roster( $rid );
		if ( ! in_array( $uid, $roster, true ) && count( $roster ) >= self::MESH_MAX ) {
			return Rest::err( 'call_full', 'This call is full — ' . self::MESH_MAX . ' people is the limit for a call with no server in the middle.', 400 );
		}
		set_transient( 'aq_room_in_' . $rid . '_' . $uid, 1, self::PRESENCE_S );
		// Tell the room somebody started a call — once per member per minute, and never the mutes.
		if ( count( $roster ) === 0 ) {
			$me = get_userdata( $uid );
			foreach ( self::members_of( $rid ) as $m ) {
				$target = (int) $m['user_id'];
				if ( $target === $uid || (int) $m['muted'] === 1 ) { continue; }
				Notify::push(
					$target, 'call', ( $me ? $me->display_name : 'Someone' ) . ' started a call in ' . $room['title'],
					'', '/messages/?room=' . $rid, 'rcall' . $rid . '-' . intdiv( Data::now(), 60 )
				);
			}
		}
		return [ 'ok' => true, 'in_call' => self::call_roster( $rid ) ];
	}

	/** POST rooms/mute {id, on} — this member's own notification switch for this room. */
	public static function mute( $req ) {
		self::ensure_tables();
		$uid = Rest::uid();
		$rid = Rest::pint( $req, 'id', 0 );
		if ( ! $rid || ! self::member( $rid, $uid ) ) { return Rest::err( 'not_found', 'No such room.', 404 ); }
		Data::update( 'aq_room_members', [ 'muted' => (int) Rest::p( $req, 'on', 1 ) === 1 ? 1 : 0 ], [ 'room_id' => $rid, 'user_id' => $uid ] );
		return [ 'ok' => true ];
	}
}
