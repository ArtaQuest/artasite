<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaMeet — scheduled meetings.
 *
 * A meeting is a PROMISE about a future time. The end-to-end encrypted ArtaRooms room that carries
 * it is bound at T-15m by whoever arrives first and thrown away afterwards, so a week-old invitation
 * never depends on a week-old key epoch: the room is never older than the meeting. That separation
 * is the whole design. It is what lets a guest be invited before they have ever opened ArtaChat, it
 * is what lets a cryptographically dead room be replaced rather than mourned, and it is what gives a
 * calendar client a plaintext SUMMARY and a stable UID without contaminating aq_rooms.
 *
 * Three rules this class exists to enforce:
 *
 *  1. `meet/open` binds a room containing EXACTLY ONE member — the binder. Nothing else may add
 *     members before that browser has minted the room key (see open()).
 *  2. Only somebody who can already open the room may seat anyone into it (see seat()). The server
 *     never holds a key and can never hand one over; it can only decide who is allowed to be sealed
 *     to, and recruit the members who actually can.
 *  3. Nothing that admits you to a call ever rides inside a calendar file or an email. Every .ics
 *     and every notification points at /meet/<id>, which is session-gated and guest-gated.
 *
 * WRITES to a room go through the Rooms public API (create / invite / leave), never around it, so
 * ArtaRooms keeps deciding who may be in a room and on what terms. READS of the room substrate are
 * done here as plain projections (who is a member, who holds a usable key) because a guest waiting
 * to be let in is not yet a room member and cannot ask Rooms about it on their own behalf.
 */
final class Meetings {

	/** People on the call, host included. A mesh has no server in the middle — Rooms::MESH_MAX is
	 *  the structural fact, and here it is ALSO the invitation cap: no overbooking, no waitlist. */
	const SEATS_MAX  = Rooms::MESH_MAX;
	/** Member-authored, in CHARACTERS. The column is VARCHAR(255) because VARCHAR counts BYTES and
	 *  MySQL rejects the whole row on overflow — 60 emoji is 240 bytes. */
	const TITLE_MAX  = 60;
	const AGENDA_MAX = 500;
	/** The room may be bound 15 minutes early… */
	const OPEN_LEAD_S = 900;
	/** …and up to 30 minutes after the meeting should have ended. */
	const GRACE_S     = 1800;
	/** Lobby presence beacon, same lifetime as a room's. */
	const HERE_S      = 25;
	/** How far back and forward the subscribed feed reaches. A cancelled meeting keeps emitting
	 *  STATUS:CANCELLED for the whole backward window: an event that simply vanishes from a feed is
	 *  not a cancellation, it is a ghost. */
	const ICS_PAST_S   = 2592000;   // 30 days
	const ICS_FUTURE_S = 15552000;  // 180 days

	/** Grant working sessions: reminder_key → days before the deadline. Kept verbatim from the
	 *  retired Google path — it was pure scheduling policy and it was right. */
	const REMINDERS = [ 't-14' => 14, 't-1' => 1 ];
	const HOUR_ET   = 16;
	const TZ        = 'America/New_York';
	/** A runaway guard, not a capacity policy: a grant with hundreds of registrants should not
	 *  silently book a hundred sittings. */
	const GRANT_SITTINGS_MAX = 12;
	/** Minutes between consecutive sittings of the same milestone, so one facilitator can chair them
	 *  back to back — and so two sittings never share a start_ts. */
	const SITTING_STAGGER_S = 1800;

	// ── Rows ────────────────────────────────────────────────────────────────

	private static function row( $id ) {
		return Data::one( 'SELECT * FROM ' . Data::t( 'aq_meets' ) . ' WHERE id = %d', [ (int) $id ] );
	}

	/** The caller's invitation, or null. EVERY handler goes through this: a meeting id is a
	 *  guessable integer, and a guest row plus a session is the entire authorisation model. */
	private static function guest_row( $mid, $uid ) {
		return Data::one(
			'SELECT * FROM ' . Data::t( 'aq_meet_guests' ) . ' WHERE meet_id = %d AND user_id = %d',
			[ (int) $mid, (int) $uid ]
		);
	}

	private static function guests_of( $mid ) {
		return Data::all(
			'SELECT * FROM ' . Data::t( 'aq_meet_guests' ) . ' WHERE meet_id = %d ORDER BY id ASC',
			[ (int) $mid ]
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

	/** start_ts × 10000000 + id — a unique, monotone, time-ordered cursor. Paging on start_ts alone
	 *  silently drops rows that tie, and grant sittings tie by construction. */
	private static function sort_key( $start, $id ) { return ( (int) $start * 10000000 ) + (int) $id; }

	/** Column names, deliberately: the SPA's Meet type mirrors the row, so a reader can hold one set
	 *  of names for the table, the API and the page. */
	private static function meet_payload( $m ) {
		return [
			'id'        => (int) $m['id'],
			'host_id'   => (int) $m['host_id'],
			'title'     => (string) $m['title'],
			'agenda'    => (string) ( $m['agenda'] ?? '' ),
			'start_ts'  => (int) $m['start_ts'],
			'end_ts'    => (int) $m['end_ts'],
			'tz'        => (string) $m['tz'],
			'seats'     => (int) $m['seats'],
			'status'    => (string) $m['status'],
			'phase'     => self::phase( $m ),
			'room_id'   => (int) $m['room_id'],
			'opened_ts' => (int) $m['opened_ts'],
			'seq'       => (int) $m['seq'],
			'context_type' => (string) $m['context_type'],
			'context_id'   => (int) $m['context_id'],
			'ctx_key'   => (string) $m['ctx_key'],
			'created'   => (int) $m['created'],
			'updated'   => (int) $m['updated'],
		];
	}

	/** Derived from TIMESTAMPS, never from the status column: cron can stall, wall-clock cannot. The
	 *  one exception is a cancellation, which is a decision rather than a moment. */
	private static function phase( $m ) {
		if ( 'cancelled' === (string) $m['status'] ) { return 'cancelled'; }
		$now   = Data::now();
		$start = (int) $m['start_ts'];
		$end   = (int) $m['end_ts'];
		if ( $now > $end + self::GRACE_S )        { return 'ended'; }
		if ( $now < $start - self::OPEN_LEAD_S )  { return 'waiting'; }
		return (int) $m['room_id'] > 0 ? 'live' : 'open';
	}

	// ── The room substrate (writes through Rooms, reads as projections) ──────

	/** Call a Rooms handler the way the REST layer would. Returns the handler's array, or an array
	 *  carrying `error`/`message` when it refused — so a refusal is data here, not an exception. */
	private static function rooms( $fn, array $params, $as_uid = 0 ) {
		$req = new \WP_REST_Request();
		foreach ( $params as $k => $v ) { $req->set_param( $k, $v ); }
		// ACT AS a specific member when asked. Rooms reads the caller from the session, and some of
		// what this class must do on a member's behalf — removing them from a finished meeting's room
		// — is refused for anyone else unless the caller owns the room. Which member happened to bind
		// the room is an accident of who arrived first, so depending on it would make disposal work
		// only sometimes. Restored in `finally`, including when the handler throws.
		$prev = 0;
		if ( $as_uid ) { $prev = get_current_user_id(); wp_set_current_user( (int) $as_uid ); }
		try {
			$out = Rooms::$fn( $req );
		} catch ( \Throwable $e ) {
			error_log( 'AQ Meetings rooms/' . $fn . ': ' . $e->getMessage() );
			return [ 'error' => 'server_error', 'message' => $e->getMessage() ];
		} finally {
			if ( $as_uid ) { wp_set_current_user( $prev ); }
		}
		if ( $out instanceof \WP_REST_Response ) {
			$d = (array) $out->get_data();
			return isset( $d['error'] ) ? $d : $d + [ 'error' => '' ];
		}
		return is_array( $out ) ? $out : [ 'error' => 'server_error', 'message' => 'No answer from the room.' ];
	}

	private static function room_epoch( $rid ) {
		return (int) Data::col( 'SELECT key_epoch FROM ' . Data::t( 'aq_rooms' ) . ' WHERE id = %d', [ (int) $rid ] );
	}

	private static function room_member_ids( $rid ) {
		$out = [];
		foreach ( Data::all( 'SELECT user_id FROM ' . Data::t( 'aq_room_members' ) . ' WHERE room_id = %d', [ (int) $rid ] ) as $r ) {
			$out[] = (int) $r['user_id'];
		}
		return $out;
	}

	/**
	 * Does this member hold a USABLE copy of the room key right now?
	 *
	 * Not "is there a sealed row" — the row names the two device keys it was sealed under, so a
	 * member who has since cleared their browser holds a blob they can never open. A stale seal
	 * therefore counts as NOT holding the key, which is what puts them back in rooms/pending and
	 * lets a present holder re-seal to them. This is the same comparison Rooms::has_usable_key
	 * makes; it defers to the public wrapper the moment Rooms exposes one, because two copies of
	 * seal logic is how seal logic drifts.
	 */
	private static function holds_key( $rid, $uid, $epoch ) {
		if ( is_callable( [ Rooms::class, 'holds_key' ] ) ) { return (bool) Rooms::holds_key( $rid, $uid, $epoch ); }
		$row = Data::one(
			'SELECT from_uid, akid, bkid FROM ' . Data::t( 'aq_room_keys' ) . ' WHERE room_id = %d AND user_id = %d AND epoch = %d',
			[ (int) $rid, (int) $uid, (int) $epoch ]
		);
		if ( ! $row ) { return false; }
		$cur = (int) Data::col(
			'SELECT id FROM ' . Data::t( 'aq_chat_keys' ) . ' WHERE user_id = %d ORDER BY id DESC LIMIT 1',
			[ (int) $uid ]
		);
		if ( ! $cur ) { return false; }
		// akid belongs to the LOW uid of the sealing pair, bkid to the high — a self-seal names the
		// same id twice, so the comparison holds there too.
		$mine = (int) $uid < (int) $row['from_uid'] ? (int) $row['akid'] : (int) $row['bkid'];
		return $mine === $cur;
	}

	/** Has this member ever registered a device key? Somebody with none cannot be sealed to at all
	 *  yet — which is a reason to seat them later, never a reason to refuse the invitation. */
	private static function has_device( $uid ) {
		return (bool) Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_chat_keys' ) . ' WHERE user_id = %d LIMIT 1', [ (int) $uid ] );
	}

	// ── Calendar signature ──────────────────────────────────────────────────

	/**
	 * The key in /meet.ics?u=<uid>&k=<32 hex>.
	 *
	 * A calendar client sends no cookie and no nonce — it is a robot fetching a URL forever from an
	 * IP we do not control — so the URL has to carry the authorisation. The entire database is
	 * public, so the secret behind it can never be IN the database: it is DERIVED from wp_salt('auth')
	 * (a wp-config constant, never served by Extra::db) plus a per-member revision counter. Nothing
	 * is stored, so there is no token column to redact and no row for a scraper to lift.
	 *
	 * Notebook.php records that this pattern was deliberately abandoned for publication, because
	 * wp_salt is readable by any process on the box and a signature it can mint is not consent. That
	 * caveat binds anything that WRITES. This feed mutates nothing, and the worst a forged signature
	 * buys is meeting times that are already public rows at /data/. It must never be reused for
	 * meet/open, which seats a person in a live human conversation and stays session-only, forever.
	 */
	public static function cal_key( $uid ) {
		$rev = max( 1, (int) get_user_meta( (int) $uid, 'aq_meet_cal_rev', true ) );
		return substr( hash_hmac( 'sha256', 'meetcal|' . (int) $uid . '|' . $rev, wp_salt( 'auth' ) ), 0, 32 );
	}

	/** The subscription pair for one member. A single meeting's download is the same URL with &m=<id>,
	 *  which the page composes itself — one signed URL to issue, and one to revoke. */
	private static function cal_urls( $uid ) {
		$ics = home_url( '/meet.ics?u=' . (int) $uid . '&k=' . self::cal_key( $uid ) );
		return [
			'ics'    => $ics,
			'webcal' => preg_replace( '#^https?://#i', 'webcal://', $ics ),
			'rev'    => max( 1, (int) get_user_meta( (int) $uid, 'aq_meet_cal_rev', true ) ),
		];
	}

	// ── Create ──────────────────────────────────────────────────────────────

	/** POST meet/create {title, agenda?, start, minutes, tz, seats?, guests?[]} — a promise, and
	 *  NEVER a room: binding one now would hand every guest a key epoch that has a week to rot. */
	public static function create( $req ) {
		if ( Rest::throttle( 'aq_meet_new', 10, 300 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }

		$title = mb_substr( wp_strip_all_tags( trim( (string) Rest::p( $req, 'title', '' ) ) ), 0, self::TITLE_MAX );
		if ( '' === $title ) { return Rest::err( 'bad_title', 'Give the meeting a title.', 400 ); }
		$agenda = mb_substr( wp_strip_all_tags( trim( (string) Rest::p( $req, 'agenda', '' ) ) ), 0, self::AGENDA_MAX );

		$now   = Data::now();
		$start = Rest::pint( $req, 'start', 0 );
		if ( $start < $now + 300 )      { return Rest::err( 'too_soon', 'Schedule a meeting at least five minutes out.', 400 ); }
		if ( $start > $now + 31536000 ) { return Rest::err( 'too_far', 'Meetings can be scheduled up to a year ahead.', 400 ); }
		$minutes = Rest::pint( $req, 'minutes', 60 );
		if ( $minutes < 15 || $minutes > 480 ) { return Rest::err( 'bad_duration', 'A meeting runs between 15 minutes and 8 hours.', 400 ); }

		$tz    = (string) Rest::p( $req, 'tz', 'UTC' );
		$tz    = in_array( $tz, timezone_identifiers_list(), true ) ? $tz : 'UTC';
		$seats = max( 2, min( self::SEATS_MAX, Rest::pint( $req, 'seats', self::SEATS_MAX ) ) );

		$id = Data::insert( 'aq_meets', [
			'host_id'  => $uid,
			'title'    => $title,
			'agenda'   => $agenda,
			'start_ts' => $start,
			'end_ts'   => $start + ( $minutes * 60 ),
			'tz'       => $tz,
			'seats'    => $seats,
			'status'   => 'scheduled',
			'room_id'  => 0,
			'seq'      => 0,
			// ctx_key is UNIQUE, so it must be distinct from the very first write: two members
			// creating a meeting in the same second would both insert '' and the second would be
			// refused. A throwaway unique value here, the real 'm:<id>' one line below.
			'ctx_key'  => 'new:' . wp_generate_uuid4(),
			'created'  => $now,
			'updated'  => $now,
		] );
		if ( ! $id ) { return Rest::err( 'server_error', 'Could not schedule the meeting.', 500 ); }
		// Both of these derive from the auto-increment id, so they are a second write by necessity.
		Data::update( 'aq_meets', [ 'ctx_key' => 'm:' . $id, 'sort_key' => self::sort_key( $start, $id ) ], [ 'id' => $id ] );
		Data::insert( 'aq_meet_guests', [
			'meet_id' => $id, 'user_id' => $uid, 'role' => 'host',
			'rsvp' => 'yes', 'invited_by' => $uid, 'invited' => $now, 'rsvp_ts' => $now,
		] );

		// A guest we cannot resolve is a warning, never a failed meeting: the meeting exists, and the
		// host can fix a mistyped name from the page they land on.
		$warnings = [];
		$asked    = Rest::p( $req, 'guests', [] );
		foreach ( ( is_array( $asked ) ? $asked : [] ) as $who ) {
			$r = self::add_guest( self::row( $id ), $who, $uid );
			if ( ! empty( $r['error'] ) ) { $warnings[] = trim( (string) $who ) . ': ' . $r['message']; }
		}

		return [
			'ok'       => true,
			'meet'     => self::meet_payload( self::row( $id ) ),
			'guests'   => self::guest_cards( $id ),
			'warnings' => $warnings,
			'cal'      => self::cal_urls( $uid ),
		];
	}

	/**
	 * Resolve a member and record the invitation. Shared by create() and invite().
	 *
	 * DELIBERATELY ABSENT: any check for a device key. Rooms::invite refuses somebody who has never
	 * opened ArtaChat, and it is right to — a room member who can never be sealed to is a member who
	 * can never read. But being invited to a MEETING touches no key material at all, so ArtaMeet
	 * records them with seated = 0 and every meet/seat call re-attempts. Opening /meet/<id> registers
	 * a device key on its own, which is why this resolves itself seconds after they arrive.
	 *
	 * DELIBERATELY ABSENT: free-text email addresses. Guests are members, resolved by uid or
	 * nicename — which removes the whole open-relay abuse class from a DKIM-signed sending identity.
	 */
	private static function add_guest( $m, $who, $by ) {
		$who = (string) $who;
		$u   = ctype_digit( $who ) ? get_userdata( (int) $who ) : get_user_by( 'slug', sanitize_title( $who ) );
		if ( ! $u ) { return [ 'error' => 'no_member', 'message' => 'No member with that username.' ]; }
		$target = (int) $u->ID;
		$mid    = (int) $m['id'];
		if ( self::guest_row( $mid, $target ) ) { return [ 'ok' => true, 'already' => true, 'user' => $target ]; }
		if ( count( self::guests_of( $mid ) ) >= (int) $m['seats'] ) {
			return [
				'error'   => 'full',
				'message' => 'This meeting holds ' . (int) $m['seats'] . ' people — the limit for a call with no server in the middle. Schedule a second sitting.',
			];
		}
		$now = Data::now();
		Data::insert( 'aq_meet_guests', [
			'meet_id' => $mid, 'user_id' => $target, 'role' => 'guest',
			'rsvp' => 'none', 'invited_by' => (int) $by, 'invited' => $now,
		] );
		$host = get_userdata( (int) $by );
		Notify::push(
			$target, 'meeting',
			( $host ? $host->display_name : 'A member' ) . ' invited you to ' . $m['title'],
			'', '/meet/' . $mid, 'mtinv' . $mid . '-' . $target
		);
		return [ 'ok' => true, 'user' => $target ];
	}

	private static function guest_cards( $mid, $room_id = 0, $epoch = 0 ) {
		$out = [];
		foreach ( self::guests_of( $mid ) as $g ) {
			$uid = (int) $g['user_id'];
			$out[] = self::card( $uid ) + [
				'role'       => (string) $g['role'],
				'rsvp'       => (string) $g['rsvp'],
				'seated'     => (int) $g['seated'],
				'has_device' => self::has_device( $uid ),
				'holds_key'  => $room_id > 0 ? self::holds_key( $room_id, $uid, $epoch ) : false,
			];
		}
		return $out;
	}

	// ── Invitations ─────────────────────────────────────────────────────────

	/** POST meet/invite {id, user} — host only, and never past the seat count. */
	public static function invite( $req ) {
		if ( Rest::throttle( 'aq_meet_invite', 30, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mid = Rest::pint( $req, 'id', 0 );
		$m   = $mid ? self::row( $mid ) : null;
		if ( ! $m || ! self::guest_row( $mid, $uid ) ) { return Rest::err( 'not_found', 'No such meeting.', 404 ); }
		if ( (int) $m['host_id'] !== $uid ) { return Rest::err( 'not_host', 'Only the host can invite people to this meeting.', 403 ); }
		if ( 'scheduled' !== (string) $m['status'] ) { return Rest::err( 'closed', 'This meeting is no longer taking invitations.', 400 ); }

		$r = self::add_guest( $m, (string) Rest::p( $req, 'user', '' ), $uid );
		if ( ! empty( $r['error'] ) ) {
			return Rest::err( $r['error'], $r['message'], 'no_member' === $r['error'] ? 404 : 400 );
		}
		return [
			'ok'      => true,
			'already' => ! empty( $r['already'] ),
			'meet'    => self::meet_payload( self::row( $mid ) ),
			'guests'  => self::guest_cards( $mid ),
		];
	}

	/**
	 * POST meet/uninvite {id, user} — host only, and never the host.
	 *
	 * If the room is already bound we also try to remove them from it, but say plainly what that is
	 * and is not: there is no key rotation here, so anybody ever handed this room's key can still
	 * decrypt this epoch. The blast radius is one call, because the room is per-meeting and thrown
	 * away afterwards — that is exactly why it is disposable.
	 */
	public static function uninvite( $req ) {
		if ( Rest::throttle( 'aq_meet_invite', 30, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		global $wpdb;
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mid = Rest::pint( $req, 'id', 0 );
		$m   = $mid ? self::row( $mid ) : null;
		if ( ! $m || ! self::guest_row( $mid, $uid ) ) { return Rest::err( 'not_found', 'No such meeting.', 404 ); }
		if ( (int) $m['host_id'] !== $uid ) { return Rest::err( 'not_host', 'Only the host can remove someone from this meeting.', 403 ); }

		$who    = (string) Rest::p( $req, 'user', '' );
		$u      = ctype_digit( $who ) ? get_userdata( (int) $who ) : get_user_by( 'slug', sanitize_title( $who ) );
		$target = $u ? (int) $u->ID : 0;
		if ( ! $target ) { return Rest::err( 'no_member', 'No member with that username.', 404 ); }
		if ( $target === (int) $m['host_id'] ) { return Rest::err( 'is_host', 'The host cannot be removed from their own meeting.', 400 ); }
		$g = self::guest_row( $mid, $target );
		if ( ! $g ) { return [ 'ok' => true, 'already' => true, 'guests' => self::guest_cards( $mid ) ]; }

		$wpdb->delete( Data::t( 'aq_meet_guests' ), [ 'meet_id' => $mid, 'user_id' => $target ] );
		$left = false;
		if ( (int) $m['room_id'] > 0 && (int) $g['seated'] > 0 ) {
			$r    = self::rooms( 'leave', [ 'id' => (int) $m['room_id'], 'user' => $target ] );
			$left = empty( $r['error'] );
		}
		return [ 'ok' => true, 'removed' => $target, 'left_room' => $left, 'guests' => self::guest_cards( $mid ) ];
	}

	/** POST meet/rsvp {id, reply} — yes | no | maybe, from anybody who was invited. */
	public static function rsvp( $req ) {
		if ( Rest::throttle( 'aq_meet_rsvp', 30, 300 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mid   = Rest::pint( $req, 'id', 0 );
		$reply = (string) Rest::p( $req, 'reply', '' );
		if ( ! in_array( $reply, [ 'yes', 'no', 'maybe' ], true ) ) { return Rest::err( 'bad_reply', 'Answer yes, no or maybe.', 400 ); }
		$m = $mid ? self::row( $mid ) : null;
		if ( ! $m ) { return Rest::err( 'not_found', 'No such meeting.', 404 ); }
		if ( ! self::guest_row( $mid, $uid ) ) { return Rest::err( 'not_invited', 'You are not on this meeting’s guest list.', 403 ); }
		Data::update( 'aq_meet_guests', [ 'rsvp' => $reply, 'rsvp_ts' => Data::now() ], [ 'meet_id' => $mid, 'user_id' => $uid ] );
		return [ 'ok' => true, 'meet' => self::meet_payload( $m ), 'guests' => self::guest_cards( $mid ), 'my_rsvp' => $reply ];
	}

	// ── Change and cancel ───────────────────────────────────────────────────

	/**
	 * POST meet/update {id, title?, agenda?, start?, minutes?, seats?, tz?} — host only.
	 *
	 * Any change to the time, the title or the status advances `seq`. Without an advancing
	 * SEQUENCE a subscribed calendar IGNORES the updated VEVENT, so everyone keeps the old time and
	 * nobody finds out until the meeting does not happen.
	 */
	public static function update( $req ) {
		if ( Rest::throttle( 'aq_meet_edit', 30, 300 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mid = Rest::pint( $req, 'id', 0 );
		$m   = $mid ? self::row( $mid ) : null;
		if ( ! $m || ! self::guest_row( $mid, $uid ) ) { return Rest::err( 'not_found', 'No such meeting.', 404 ); }
		if ( (int) $m['host_id'] !== $uid ) { return Rest::err( 'not_host', 'Only the host can change this meeting.', 403 ); }
		if ( 'scheduled' !== (string) $m['status'] ) { return Rest::err( 'closed', 'This meeting can no longer be changed.', 400 ); }

		$now    = Data::now();
		$fields = [];
		$notify = false;

		if ( null !== Rest::p( $req, 'title', null ) ) {
			$title = mb_substr( wp_strip_all_tags( trim( (string) Rest::p( $req, 'title', '' ) ) ), 0, self::TITLE_MAX );
			if ( '' === $title ) { return Rest::err( 'bad_title', 'Give the meeting a title.', 400 ); }
			if ( $title !== (string) $m['title'] ) { $fields['title'] = $title; $notify = true; }
		}
		if ( null !== Rest::p( $req, 'agenda', null ) ) {
			$fields['agenda'] = mb_substr( wp_strip_all_tags( trim( (string) Rest::p( $req, 'agenda', '' ) ) ), 0, self::AGENDA_MAX );
		}
		if ( null !== Rest::p( $req, 'tz', null ) ) {
			$tz = (string) Rest::p( $req, 'tz', 'UTC' );
			$fields['tz'] = in_array( $tz, timezone_identifiers_list(), true ) ? $tz : 'UTC';
		}
		if ( null !== Rest::p( $req, 'seats', null ) ) {
			$seats = max( 2, min( self::SEATS_MAX, Rest::pint( $req, 'seats', self::SEATS_MAX ) ) );
			$have  = count( self::guests_of( $mid ) );
			if ( $seats < $have ) {
				return Rest::err( 'too_many_guests', 'There are already ' . $have . ' people invited — remove someone first.', 400 );
			}
			$fields['seats'] = $seats;
		}

		$start = (int) $m['start_ts'];
		$mins  = max( 1, (int) round( ( (int) $m['end_ts'] - $start ) / 60 ) );
		$timed = false;
		if ( null !== Rest::p( $req, 'start', null ) ) {
			$start = Rest::pint( $req, 'start', 0 );
			if ( $start < $now + 300 )      { return Rest::err( 'too_soon', 'Schedule a meeting at least five minutes out.', 400 ); }
			if ( $start > $now + 31536000 ) { return Rest::err( 'too_far', 'Meetings can be scheduled up to a year ahead.', 400 ); }
			$timed = true;
		}
		if ( null !== Rest::p( $req, 'minutes', null ) ) {
			$mins = Rest::pint( $req, 'minutes', $mins );
			if ( $mins < 15 || $mins > 480 ) { return Rest::err( 'bad_duration', 'A meeting runs between 15 minutes and 8 hours.', 400 ); }
			$timed = true;
		}
		if ( $timed ) {
			$fields['start_ts'] = $start;
			$fields['end_ts']   = $start + ( $mins * 60 );
			$fields['sort_key'] = self::sort_key( $start, $mid );
			$notify = true;
		}

		if ( ! $fields ) { return [ 'ok' => true, 'unchanged' => true, 'meet' => self::meet_payload( $m ), 'guests' => self::guest_cards( $mid ) ]; }
		$fields['updated'] = $now;
		if ( $notify ) { $fields['seq'] = (int) $m['seq'] + 1; }
		Data::update( 'aq_meets', $fields, [ 'id' => $mid ] );

		$after = self::row( $mid );
		if ( $notify ) { self::tell_guests( $after, 'changed', $after['title'] . ' was rescheduled', 'no' ); }
		return [ 'ok' => true, 'meet' => self::meet_payload( $after ), 'guests' => self::guest_cards( $mid ) ];
	}

	/**
	 * POST meet/cancel {id} — host only.
	 *
	 * The row is NEVER deleted here. A subscribed client that was offline when you cancelled must
	 * still receive the cancellation on its next poll, so the meeting keeps emitting
	 * STATUS:CANCELLED with an advanced SEQUENCE until it falls out of the feed's backward window.
	 * A bound room is left alone: deleting it would be the server destroying member data it cannot
	 * read and cannot judge.
	 */
	public static function cancel( $req ) {
		if ( Rest::throttle( 'aq_meet_edit', 30, 300 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mid = Rest::pint( $req, 'id', 0 );
		$m   = $mid ? self::row( $mid ) : null;
		if ( ! $m || ! self::guest_row( $mid, $uid ) ) { return Rest::err( 'not_found', 'No such meeting.', 404 ); }
		if ( (int) $m['host_id'] !== $uid ) { return Rest::err( 'not_host', 'Only the host can cancel this meeting.', 403 ); }
		if ( 'cancelled' === (string) $m['status'] ) { return [ 'ok' => true, 'already' => true, 'meet' => self::meet_payload( $m ) ]; }
		self::cancel_row( $m, $m['title'] . ' was cancelled' );
		return [ 'ok' => true, 'meet' => self::meet_payload( self::row( $mid ) ) ];
	}

	private static function cancel_row( $m, $headline ) {
		Data::update( 'aq_meets', [
			'status'  => 'cancelled',
			'seq'     => (int) $m['seq'] + 1,
			'updated' => Data::now(),
		], [ 'id' => (int) $m['id'] ] );
		self::tell_guests( self::row( (int) $m['id'] ), 'cancelled', $headline, '' );
	}

	/** One bell per guest, deduped on the meeting's SEQUENCE so a second edit rings again and a
	 *  retry does not. $skip_rsvp drops the people who already said they were not coming. */
	private static function tell_guests( $m, $kind, $headline, $skip_rsvp = '' ) {
		$mid = (int) $m['id'];
		foreach ( self::guests_of( $mid ) as $g ) {
			$uid = (int) $g['user_id'];
			if ( '' !== $skip_rsvp && $skip_rsvp === (string) $g['rsvp'] ) { continue; }
			Notify::push(
				$uid, 'meeting', $headline, '', '/meet/' . $mid,
				'mt' . $kind . $mid . '-' . (int) $m['seq'] . '-' . $uid
			);
		}
	}

	// ── Reading ─────────────────────────────────────────────────────────────

	/**
	 * GET meet/list?scope=upcoming|past&cursor=&limit= — every meeting the caller is a guest of.
	 *
	 * Hand-written keyset rather than Data::page, because Data::page cannot JOIN and the join to
	 * aq_meet_guests is not optional. The semantics are Data::page's exactly: page on one column,
	 * ask for limit + 1, and return the last row's cursor value (null at the end).
	 */
	public static function list_mine( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		self::tick(); // belt-and-braces: a quiet site still sweeps whenever anyone opens the page

		$past   = 'past' === (string) Rest::p( $req, 'scope', 'upcoming' );
		$limit  = max( 1, min( 50, Rest::pint( $req, 'limit', 20 ) ) );
		$cursor = Rest::pint( $req, 'cursor', 0 );
		$edge   = Data::now() - 3600; // an hour of grace, so a meeting does not vanish while it runs

		$sql  = 'SELECT m.*, g.rsvp AS my_rsvp FROM ' . Data::t( 'aq_meets' ) . ' m JOIN ' . Data::t( 'aq_meet_guests' ) . ' g'
			. ' ON g.meet_id = m.id AND g.user_id = %d WHERE m.end_ts ' . ( $past ? '<' : '>=' ) . ' %d';
		$args = [ $uid, $edge ];
		if ( $cursor > 0 ) { $sql .= ' AND m.sort_key ' . ( $past ? '<' : '>' ) . ' %d'; $args[] = $cursor; }
		$sql   .= ' ORDER BY m.sort_key ' . ( $past ? 'DESC' : 'ASC' ) . ' LIMIT %d';
		$args[] = $limit + 1;

		$rows = Data::all( $sql, $args );
		$next = null;
		if ( count( $rows ) > $limit ) {
			$next = (int) $rows[ $limit - 1 ]['sort_key'];
			$rows = array_slice( $rows, 0, $limit );
		}
		$items = [];
		foreach ( $rows as $r ) {
			$items[] = self::meet_payload( $r ) + [ 'my_rsvp' => (string) ( $r['my_rsvp'] ?? 'none' ) ];
		}
		return [
			'items'     => $items,
			'next'      => $next,
			'me'        => $uid,
			'cal'       => self::cal_urls( $uid ),
			'seats_max' => self::SEATS_MAX,
		];
	}

	/** GET meet/get?id= — one meeting and its guest list, for anybody invited to it. A meeting you
	 *  are not on answers 404, exactly as a missing one does: the API should not be a probe for
	 *  guest lists, even though the row itself is public at /data/. */
	public static function get( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mid = Rest::pint( $req, 'id', 0 );
		$m   = $mid ? self::row( $mid ) : null;
		$g   = $m ? self::guest_row( $mid, $uid ) : null;
		if ( ! $m || ! $g ) { return Rest::err( 'not_found', 'No such meeting.', 404 ); }
		return [
			'meet'    => self::meet_payload( $m ),
			'guests'  => self::guest_cards( $mid ),
			'me'      => $uid,
			'my_rsvp' => (string) $g['rsvp'],
			'is_host' => (int) $m['host_id'] === $uid,
			'cal'     => self::cal_urls( $uid ),
		];
	}

	/**
	 * GET meet/lobby?id= — the join-window poll, and the only route that computes key state.
	 *
	 * `holders` is the load-bearing field: it is who could seal the room key to a newcomer RIGHT NOW,
	 * computed by comparing each seal against that member's current device key. The server works it
	 * out without ever seeing a key. It is two indexed reads per guest, seats are capped at five, and
	 * it is only computed while a room is bound — a ~45-minute window per meeting.
	 */
	public static function lobby( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mid = Rest::pint( $req, 'id', 0 );
		$m   = $mid ? self::row( $mid ) : null;
		if ( ! $m || ! self::guest_row( $mid, $uid ) ) { return Rest::err( 'not_found', 'No such meeting.', 404 ); }

		// Being here IS the presence beacon — the same read-side transient Rooms::messages uses, which
		// is why there is no separate presence route to forget to call.
		set_transient( 'aq_meet_here_' . $mid . '_' . $uid, 1, self::HERE_S );

		// Self-heal on read: the last member leaving a room deletes it, and a meeting pointing at a
		// room that no longer exists would offer a join button that can never work.
		$rid = (int) $m['room_id'];
		if ( $rid > 0 && ! self::room_epoch( $rid ) ) {
			// The status is only wound back from 'live'. Writing 'scheduled' unconditionally meant any
			// guest's read-only poll silently UN-CANCELLED a meeting the host had called off, and made
			// it joinable again. A poll must never overturn a decision.
			$heal = [ 'room_id' => 0, 'opened_ts' => 0, 'updated' => Data::now() ];
			if ( 'live' === (string) $m['status'] ) { $heal['status'] = 'scheduled'; }
			Data::update( 'aq_meets', $heal, [ 'id' => $mid ] );
			$m   = self::row( $mid );
			$rid = 0;
		}

		$epoch   = $rid > 0 ? self::room_epoch( $rid ) : 0;
		$in_room = $rid > 0 ? self::room_member_ids( $rid ) : [];
		$phase   = self::phase( $m );

		$here = [];
		$holders = [];
		$unseated = [];
		foreach ( self::guests_of( $mid ) as $g ) {
			$gid = (int) $g['user_id'];
			if ( get_transient( 'aq_meet_here_' . $mid . '_' . $gid ) ) { $here[] = $gid; }
			if ( $rid > 0 && in_array( $gid, $in_room, true ) && self::holds_key( $rid, $gid, $epoch ) ) { $holders[] = $gid; }
			if ( $rid > 0 && ! (int) $g['seated'] ) { $unseated[] = $gid; }
		}
		$present = array_values( array_intersect( $holders, $here ) );

		$room = null;
		if ( $rid > 0 && in_array( $uid, $in_room, true ) ) {
			$r    = self::rooms( 'get', [ 'id' => $rid ] );
			$room = empty( $r['error'] ) ? ( $r['room'] ?? null ) : null;
		}

		return [
			'meet'      => self::meet_payload( $m ),
			'me'        => $uid,
			'phase'     => $phase,
			'here'      => $here,
			'guests'    => self::guest_cards( $mid, $rid, $epoch ),
			'room_id'   => $rid,
			'epoch'     => $epoch,
			'holders'   => $holders,
			'present_holders' => $present,
			'unseated'  => $unseated,
			// 'open' already means "inside the join window and nothing bound yet" — phase never reads
			// 'open' while a room exists, so this is the whole condition.
			'can_open'  => 'open' === $phase,
			'can_seat'  => in_array( $uid, $holders, true ) && ! empty( $unseated ),
			'room'      => $room,
			'seats_max' => self::SEATS_MAX,
		];
	}

	// ── Binding the room ────────────────────────────────────────────────────

	/**
	 * POST meet/open {id} — bind a disposable room to this meeting, atomically and exactly once.
	 *
	 * THIS ROUTE NEVER ADDS A MEMBER TO AN EXISTING ROOM. The binder must be ALONE in the room when
	 * their browser first calls roomKey(), because lib/rooms.ts mints the room key only under
	 * `room.count === 1 && room.members[0].id === me`. Seat anybody here and the mint refuses,
	 * nobody ever holds the key, and the meeting is dead on an empty room that cannot be opened.
	 * All seating goes through meet/seat, which is refused unless the caller can prove they already
	 * hold the key. This is the single most fragile invariant in ArtaMeet.
	 */
	public static function open( $req ) {
		if ( Rest::throttle( 'aq_meet_open', 20, 300 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mid = Rest::pint( $req, 'id', 0 );
		$m   = $mid ? self::row( $mid ) : null;
		if ( ! $m || ! self::guest_row( $mid, $uid ) ) { return Rest::err( 'not_found', 'No such meeting.', 404 ); }

		$phase = self::phase( $m );
		if ( 'cancelled' === $phase ) { return Rest::err( 'cancelled', 'This meeting was cancelled.', 409 ); }
		if ( 'waiting' === $phase )   { return Rest::err( 'too_early', 'The room opens 15 minutes before the meeting starts.', 409 ); }
		if ( 'ended' === $phase )     { return Rest::err( 'too_late', 'This meeting is over.', 409 ); }

		// Two people pressing Join in the same second is the normal case, not the exotic one.
		if ( ! Economy::acquire_lock( 'meetopen' . $mid, 15 ) ) {
			return Rest::err( 'busy', 'Someone else is opening this meeting — try again in a moment.', 429 );
		}
		try {
			global $wpdb;
			$m = self::row( $mid );
			if ( (int) $m['room_id'] > 0 ) {
				return self::open_result( $m, $uid, false );
			}
			$made = self::rooms( 'create', [ 'title' => (string) $m['title'], 'personal' => 0 ] );
			if ( ! empty( $made['error'] ) || empty( $made['room']['id'] ) ) {
				return Rest::err( 'room_failed', $made['message'] ?? 'Could not open a room for this meeting.', 500 );
			}
			$rid = (int) $made['room']['id'];
			$now = Data::now();
			$wpdb->query( $wpdb->prepare(
				'UPDATE ' . Data::t( 'aq_meets' ) . " SET room_id = %d, opened_ts = %d, status = 'live', updated = %d WHERE id = %d AND room_id = 0",
				$rid, $now, $now, $mid
			) );
			if ( 1 !== (int) $wpdb->rows_affected ) {
				// Belt, behind the lock's braces. The room we just made has exactly one member — us —
				// so leaving it deletes it outright. Never fire-and-forget: an orphan room is a room
				// in somebody's sidebar forever.
				$gone = self::rooms( 'leave', [ 'id' => $rid ] );
				if ( ! empty( $gone['error'] ) ) { error_log( 'AQ Meetings: orphan room ' . $rid . ' from meeting ' . $mid . ' — ' . $gone['error'] ); }
				return self::open_result( self::row( $mid ), $uid, false );
			}
			Data::update( 'aq_meet_guests', [ 'seated' => $now ], [ 'meet_id' => $mid, 'user_id' => $uid ] );
			return [
				'ok'      => true,
				'room_id' => $rid,
				'epoch'   => (int) ( $made['room']['epoch'] ?? 1 ),
				'mint'    => true,   // you are alone in this room: call roomKey() now
				'seated'  => true,
				'meet'    => self::meet_payload( self::row( $mid ) ),
			];
		} finally {
			Economy::release_lock( 'meetopen' . $mid );
		}
	}

	/** The answer for whoever lost the race: the winner's room, and explicitly no mint. */
	private static function open_result( $m, $uid, $mint ) {
		$rid = (int) $m['room_id'];
		return [
			'ok'      => true,
			'room_id' => $rid,
			'epoch'   => $rid ? self::room_epoch( $rid ) : 0,
			'mint'    => (bool) $mint,
			'seated'  => $rid ? in_array( (int) $uid, self::room_member_ids( $rid ), true ) : false,
			'meet'    => self::meet_payload( $m ),
		];
	}

	/**
	 * POST meet/seat {id} — let the people who are still outside in.
	 *
	 * Gated on the caller ALREADY holding the room key, which is the only honest gate available: the
	 * server cannot seal anything to anybody, so adding a member is only useful when somebody in the
	 * room can follow it with a seal. Idempotent, and called from the lobby poll by every present
	 * key-holder, so a guest who registers a device key mid-meeting is seated within one tick.
	 */
	public static function seat( $req ) {
		if ( Rest::throttle( 'aq_meet_seat', 60, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mid = Rest::pint( $req, 'id', 0 );
		$m   = $mid ? self::row( $mid ) : null;
		if ( ! $m || ! self::guest_row( $mid, $uid ) ) { return Rest::err( 'not_found', 'No such meeting.', 404 ); }
		$rid = (int) $m['room_id'];
		if ( ! $rid || ! self::room_epoch( $rid ) ) { return Rest::err( 'not_open', 'This meeting has no room yet.', 409 ); }
		$epoch = self::room_epoch( $rid );
		if ( ! self::holds_key( $rid, $uid, $epoch ) ) {
			return Rest::err( 'no_key', 'Only someone who can already open this room can seat other people.', 403 );
		}

		$seated  = [];
		$needs   = [];
		$now     = Data::now();
		$in_room = self::room_member_ids( $rid );
		foreach ( self::guests_of( $mid ) as $g ) {
			$gid = (int) $g['user_id'];
			if ( 'no' === (string) $g['rsvp'] || (int) $g['seated'] > 0 ) { continue; }
			if ( in_array( $gid, $in_room, true ) ) {
				Data::update( 'aq_meet_guests', [ 'seated' => $now ], [ 'meet_id' => $mid, 'user_id' => $gid ] );
				$seated[] = $gid;
				continue;
			}
			// A guest with no device key is not a failure — they are simply early. Leave seated = 0 and
			// the next tick retries; opening /meet/<id> registers a key on its own.
			if ( ! self::has_device( $gid ) ) { $needs[] = $gid; continue; }
			$r = self::rooms( 'invite', [ 'id' => $rid, 'user' => (string) $gid ] );
			if ( ! empty( $r['error'] ) ) { $needs[] = $gid; continue; }
			Data::update( 'aq_meet_guests', [ 'seated' => $now ], [ 'meet_id' => $mid, 'user_id' => $gid ] );
			$in_room[] = $gid;
			$seated[]  = $gid;
		}
		return [ 'ok' => true, 'seated' => $seated, 'needs_device' => $needs, 'guests' => self::guest_cards( $mid, $rid, $epoch ) ];
	}

	// ── The calendar ────────────────────────────────────────────────────────

	/** GET meet/cal — the calling member's own subscription URLs. Never in a list payload, never on
	 *  a public route: a subscription URL is by nature a URL that gets pasted into other people's
	 *  servers, so it is handed out one member at a time and revocable. */
	public static function cal( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$c = self::cal_urls( $uid );
		// `url` and `ics` are the same string under two names: the calendar panel asks this route for
		// a `url`, and every list payload carries a `cal` object keyed `ics`. One value, both spellings.
		return [ 'ok' => true, 'url' => $c['ics'] ] + $c;
	}

	/** POST meet/cal — revoke every calendar URL ever issued to this member and mint the next one.
	 *  The rev is a COUNTER, not a credential: nothing about it needs masking at /data/. */
	public static function cal_rotate( $req ) {
		if ( Rest::throttle( 'aq_meet_cal', 5, 600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$rev = max( 1, (int) get_user_meta( $uid, 'aq_meet_cal_rev', true ) ) + 1;
		update_user_meta( $uid, 'aq_meet_cal_rev', $rev );
		$c = self::cal_urls( $uid );
		return [ 'ok' => true, 'url' => $c['ics'] ] + $c;
	}

	/**
	 * /meet.ics?u=<uid>&k=<32 hex> — the member's subscribable feed, or ?m=<id> for one event as a
	 * download. Served from template_redirect (aquest.php), because calendar clients sniff the .ics
	 * extension and /wp-json/… has none.
	 *
	 * This is the only ArtaMeet surface an unauthenticated request reaches, and it is READ-ONLY on
	 * purpose — see cal_key() for why a derived signature is acceptable here and nowhere else.
	 */
	public static function serve_ics() {
		$u = isset( $_GET['u'] ) ? (int) $_GET['u'] : 0;
		$k = isset( $_GET['k'] ) ? (string) wp_unslash( $_GET['k'] ) : '';
		$m = isset( $_GET['m'] ) ? (int) $_GET['m'] : 0;
		if ( ! $u || ! preg_match( '/^[a-f0-9]{32}$/', $k ) ) { self::ics_deny(); }
		// SIGNATURE FIRST, THROTTLE SECOND. The other order looks harmless and is not: the bucket
		// name contains the CALLER'S OWN `u`, so an unauthenticated stranger could mint an unbounded
		// number of transient rows — wp_options rows, on a site with no persistent object cache — by
		// varying a number in a URL. Nothing an unsigned request says may reach storage.
		// Constant-time, and the refusal never varies: a wrong key and an unknown member must be
		// indistinguishable, or the endpoint becomes a membership oracle.
		if ( ! hash_equals( self::cal_key( $u ), $k ) ) { self::ics_deny(); }
		if ( Rest::throttle( 'aq_meetics_' . $u, 120, 3600 ) ) { self::ics_deny(); }

		$now  = Data::now();
		$sql  = 'SELECT m.* FROM ' . Data::t( 'aq_meets' ) . ' m JOIN ' . Data::t( 'aq_meet_guests' ) . ' g'
			. ' ON g.meet_id = m.id AND g.user_id = %d WHERE m.start_ts >= %d AND m.start_ts <= %d';
		$args = [ $u, $now - self::ICS_PAST_S, $now + self::ICS_FUTURE_S ];
		if ( $m ) { $sql .= ' AND m.id = %d'; $args[] = $m; }
		$sql   .= ' ORDER BY m.start_ts ASC LIMIT %d';
		$args[] = $m ? 1 : 500;
		$rows   = Data::all( $sql, $args );
		if ( $m && ! $rows ) { self::ics_deny(); }

		$lines = [
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'PRODID:-//ArtaQuest//ArtaMeet//EN',
			'CALSCALE:GREGORIAN',
			'METHOD:PUBLISH',
			'X-WR-CALNAME:ArtaQuest — my meetings',
			'X-WR-TIMEZONE:UTC',
			'X-PUBLISHED-TTL:PT1H',
			'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
		];
		foreach ( $rows as $r ) { $lines = array_merge( $lines, self::vevent( $r ) ); }
		$lines[] = 'END:VCALENDAR';

		// The response is written by hand from here down. WP core attaches no-cache headers on a 404
		// before template_redirect runs, so a handler living on an otherwise-404 path has to remove
		// them explicitly — and nocache_headers() is exactly the mistake that makes the grants feed an
		// always-MISS at the edge. `private` forbids the shared edge from storing a personal calendar.
		while ( ob_get_level() > 0 ) { @ob_end_clean(); }
		header_remove( 'Cache-Control' );
		header_remove( 'Pragma' );
		header_remove( 'Expires' );
		status_header( 200 );
		header( 'Content-Type: text/calendar; charset=utf-8' );
		header( 'Content-Disposition: ' . ( $m ? 'attachment' : 'inline' ) . '; filename="artaquest-meeting' . ( $m ? '-' . $m : 's' ) . '.ics"' );
		header( 'Cache-Control: private, max-age=300' );
		echo implode( "\r\n", $lines ) . "\r\n";
		exit;
	}

	private static function ics_deny() {
		while ( ob_get_level() > 0 ) { @ob_end_clean(); }
		status_header( 403 );
		header( 'Content-Type: text/plain; charset=utf-8' );
		header( 'Cache-Control: private, no-store' );
		echo "Forbidden\r\n";
		exit;
	}

	/**
	 * One VEVENT.
	 *
	 * UID is DERIVED, never stored — row ids are never reused, so it is stable across a retime and a
	 * cancellation, which is what RFC 5545 requires for an in-place update. DTSTAMP tracks the row's
	 * own last change rather than the moment of the fetch, so an unchanged event is byte-identical
	 * on every poll. The two VALARMs reproduce what the retired Google path was giving us (a day
	 * ahead, and half an hour ahead) — and they fire on the member's own device, with no server
	 * involved, which is what carries the reminder when our cron is late.
	 */
	private static function vevent( $r ) {
		$id      = (int) $r['id'];
		$stamp   = gmdate( 'Ymd\THis\Z', (int) ( $r['updated'] ?: $r['created'] ?: $r['start_ts'] ) );
		$join    = home_url( '/meet/' . $id );
		$cancel  = 'cancelled' === (string) $r['status'];
		$where   = (string) $r['tz'];
		$desc    = trim( (string) ( $r['agenda'] ?? '' ) );
		$desc   .= ( '' !== $desc ? "\n\n" : '' ) . 'Join: ' . $join;
		// The host's own zone, spelled out because an email or a calendar note has no browser to ask.
		// Guarded: a zone the DB no longer recognises must cost us a line of prose, not the feed.
		if ( 'UTC' !== $where && in_array( $where, timezone_identifiers_list(), true ) ) {
			$desc .= "\n" . 'Scheduled for ' . wp_date( 'H:i', (int) $r['start_ts'], new \DateTimeZone( $where ) ) . ' ' . $where . '.';
		}
		$desc .= "\n" . 'Up to ' . (int) $r['seats'] . ' people, end-to-end encrypted: nothing is recorded and nobody, including ArtaQuest, can listen in.';

		$out = [
			'BEGIN:VEVENT',
			'UID:artameet-' . $id . '@artaquest.org',
			'SEQUENCE:' . (int) $r['seq'],
			'DTSTAMP:' . $stamp,
			'LAST-MODIFIED:' . $stamp,
			'DTSTART:' . gmdate( 'Ymd\THis\Z', (int) $r['start_ts'] ),
			'DTEND:' . gmdate( 'Ymd\THis\Z', (int) $r['end_ts'] ),
			'STATUS:' . ( $cancel ? 'CANCELLED' : 'CONFIRMED' ),
			self::ics_fold( 'SUMMARY:' . self::ics_esc( ( $cancel ? 'Cancelled: ' : '' ) . (string) $r['title'] ) ),
			self::ics_fold( 'DESCRIPTION:' . self::ics_esc( $desc ) ),
			self::ics_fold( 'URL:' . self::ics_esc( $join ) ),
			self::ics_fold( 'LOCATION:' . self::ics_esc( $join ) ),
			'ORGANIZER;CN=ArtaQuest:mailto:support@artaquest.org',
		];
		if ( ! $cancel ) {
			foreach ( [ '-P1D' => 'ArtaMeet tomorrow — ' . $r['title'], '-PT30M' => 'ArtaMeet in 30 minutes — ' . $r['title'] ] as $trigger => $text ) {
				$out[] = 'BEGIN:VALARM';
				$out[] = 'TRIGGER:' . $trigger;
				$out[] = 'ACTION:DISPLAY';
				$out[] = self::ics_fold( 'DESCRIPTION:' . self::ics_esc( $text ) );
				$out[] = 'END:VALARM';
			}
		}
		$out[] = 'END:VEVENT';
		return $out;
	}

	/** Escape a value for an iCalendar text field (RFC 5545 §3.3.11). Defers to Extra's twin the
	 *  moment that one is public — one implementation of this rule, forever. */
	private static function ics_esc( $s ) {
		if ( is_callable( [ Extra::class, 'ics_esc' ] ) ) { return Extra::ics_esc( $s ); }
		return str_replace( [ "\\", "\n", ',', ';' ], [ "\\\\", "\\n", "\\,", "\\;" ], (string) $s );
	}

	/** Fold a content line to ≤75 OCTETS (not characters), continuations prefixed with one space. */
	private static function ics_fold( $line ) {
		if ( is_callable( [ Extra::class, 'ics_fold' ] ) ) { return Extra::ics_fold( $line ); }
		if ( strlen( $line ) <= 75 ) { return $line; }
		$out   = '';
		$first = true;
		while ( strlen( $line ) > 0 ) {
			$take  = $first ? 75 : 74;
			$out  .= ( $first ? '' : "\r\n " ) . substr( $line, 0, $take );
			$line  = substr( $line, $take );
			$first = false;
		}
		return $out;
	}

	// ── Grant working sessions ──────────────────────────────────────────────

	/** Unix start for a milestone: N days before the deadline, at 16:00 ET. DateTimeZone arithmetic,
	 *  never N × 86400 on a UTC integer — that lands on 15:00 or 17:00 across a DST boundary and
	 *  nobody notices until November. */
	private static function start_for( $deadline, $days_before ) {
		try {
			$dt = new \DateTime( $deadline . ' ' . sprintf( '%02d:00:00', self::HOUR_ET ), new \DateTimeZone( self::TZ ) );
			$dt->modify( '-' . (int) $days_before . ' days' );
			return $dt->getTimestamp();
		} catch ( \Exception $e ) { return 0; }
	}

	/**
	 * Create, retime, resize and tear down a grant's working sessions. Idempotent, safe on every
	 * claim and release, and it never throws — a failure here degrades to "no session", never to a
	 * failed claim.
	 *
	 * It SPLITS BY CAPACITY. A mesh call holds five people, so a grant with 20 registrants gets four
	 * sittings half an hour apart rather than one meeting that turns 15 people away at 16:00. The
	 * stagger also guarantees two sittings never share a start_ts.
	 *
	 * It TEARS DOWN. The Google path returned before touching the calendar when the last registrant
	 * left, so a grant with zero registrants went on advertising a joinable link forever. Zero
	 * registrants, an inactive grant or an undated one all cancel every sitting here.
	 */
	public static function ensure_for_grant( $gid ) {
		$gid = (int) $gid;
		if ( ! $gid ) { return; }
		$g = Data::one(
			'SELECT id, title, funder, url, deadline, active FROM ' . Data::t( 'aq_grants' ) . ' WHERE id = %d',
			[ $gid ]
		);
		$dated = $g && 1 === (int) $g['active'] && preg_match( '/^\d{4}-\d{2}-\d{2}$/', (string) $g['deadline'] );

		// Registrants in claim order — the same people the grant page shows as holding a slot.
		$people = [];
		if ( $dated ) {
			foreach ( Data::all(
				'SELECT c.user_id FROM ' . Data::t( 'aq_grant_claims' ) . ' c WHERE c.grant_id = %d AND c.status IN '
				. Extra::CLAIM_ACTIVE . ' ORDER BY c.id ASC',
				[ $gid ]
			) as $c ) { $people[] = (int) $c['user_id']; }
		}

		$now  = Data::now();
		$want = [];
		foreach ( ( $people ? self::REMINDERS : [] ) as $key => $days ) {
			$base = self::start_for( (string) $g['deadline'], $days );
			if ( $base <= $now ) { continue; } // the milestone has passed — nothing left to schedule
			$n = (int) ceil( count( $people ) / self::SEATS_MAX );
			if ( $n > self::GRANT_SITTINGS_MAX ) {
				error_log( 'AQ Meetings: grant ' . $gid . ' wants ' . $n . ' sittings at ' . $key . ' — capped at ' . self::GRANT_SITTINGS_MAX );
				$n = self::GRANT_SITTINGS_MAX;
			}
			$label = 1 === (int) $days ? 'final review' : 'T-' . (int) $days;
			for ( $i = 0; $i < $n; $i++ ) {
				$slice = array_slice( $people, $i * self::SEATS_MAX, self::SEATS_MAX );
				if ( ! $slice ) { break; }
				$suffix = ' — working session (' . $label . ')' . ( $i ? ' #' . ( $i + 1 ) : '' );
				$start  = $base + ( $i * self::SITTING_STAGGER_S );
				$want[ 'grant:' . $gid . ':' . $key . ( $i ? chr( 97 + $i ) : '' ) ] = [
					'start'  => $start,
					'end'    => $start + 3600,
					'title'  => mb_substr( (string) $g['funder'], 0, max( 8, self::TITLE_MAX - mb_strlen( $suffix ) ) ) . $suffix,
					'agenda' => mb_substr( wp_strip_all_tags(
						'Working session for the ArtaQuest Foundation’s application to ' . $g['funder'] . '. '
						. $g['title'] . ( $g['url'] ? ' — ' . $g['url'] : '' ) . ' Deadline: ' . $g['deadline']
					), 0, self::AGENDA_MAX ),
					'people' => $slice,
				];
			}
		}

		foreach ( $want as $ck => $w ) { self::ensure_sitting( $gid, $ck, $w ); }

		// Anything this grant used to hold that it no longer wants — a released claim, a moved
		// deadline that dropped a sitting, a deactivated grant — is cancelled, not deleted, so the
		// cancellation reaches every subscribed calendar.
		foreach ( Data::all(
			'SELECT * FROM ' . Data::t( 'aq_meets' ) . " WHERE context_type = 'grant' AND context_id = %d AND status <> 'cancelled'",
			[ $gid ]
		) as $old ) {
			if ( isset( $want[ (string) $old['ctx_key'] ] ) ) { continue; }
			self::cancel_row( $old, $old['title'] . ' was cancelled' );
		}
	}

	/** One sitting: created if new, retimed (with an advancing SEQUENCE) if the deadline moved, and
	 *  its guest list reconciled against the registrants assigned to it. */
	private static function ensure_sitting( $gid, $ck, $w ) {
		$now = Data::now();
		$m   = Data::one( 'SELECT * FROM ' . Data::t( 'aq_meets' ) . ' WHERE ctx_key = %s', [ $ck ] );
		if ( ! $m ) {
			// ctx_key is UNIQUE, which is what makes this safe under two simultaneous claims — the
			// loser's insert is refused rather than duplicating the sitting.
			$id = Data::insert( 'aq_meets', [
				'host_id'  => 0, // the foundation's own sync owns these rows; no member is their host
				'title'    => $w['title'],
				'agenda'   => $w['agenda'],
				'start_ts' => $w['start'],
				'end_ts'   => $w['end'],
				'tz'       => self::TZ,
				'seats'    => self::SEATS_MAX,
				'status'   => 'scheduled',
				'context_type' => 'grant',
				'context_id'   => $gid,
				'ctx_key'  => $ck,
				'created'  => $now,
				'updated'  => $now,
			] );
			if ( ! $id ) { return; }
			Data::update( 'aq_meets', [ 'sort_key' => self::sort_key( $w['start'], $id ) ], [ 'id' => $id ] );
			$m = self::row( $id );
			if ( ! $m ) { return; }
		} elseif ( (int) $m['start_ts'] !== (int) $w['start'] || (int) $m['end_ts'] !== (int) $w['end']
			|| (string) $m['title'] !== (string) $w['title'] || 'cancelled' === (string) $m['status'] ) {
			// A moved deadline retimes the sitting; a grant that lost every registrant and then gained
			// one back revives it. Either way the SEQUENCE advances, or no subscribed calendar moves.
			// Everything ensure_for_grant builds is still in the future, so the status is scheduled.
			$back = 'cancelled' === (string) $m['status'];
			Data::update( 'aq_meets', [
				'title'    => $w['title'],
				'agenda'   => $w['agenda'],
				'start_ts' => $w['start'],
				'end_ts'   => $w['end'],
				'sort_key' => self::sort_key( $w['start'], (int) $m['id'] ),
				'seq'      => (int) $m['seq'] + 1,
				'status'   => 'scheduled',
				'updated'  => $now,
			], [ 'id' => (int) $m['id'] ] );
			$m = self::row( (int) $m['id'] );
			self::tell_guests( $m, 'changed', $m['title'] . ( $back ? ' is back on' : ' was rescheduled' ), 'no' );
		}

		$mid  = (int) $m['id'];
		$have = [];
		foreach ( self::guests_of( $mid ) as $g ) { $have[] = (int) $g['user_id']; }
		foreach ( array_diff( $w['people'], $have ) as $uid ) {
			Data::insert( 'aq_meet_guests', [
				'meet_id' => $mid, 'user_id' => (int) $uid, 'role' => 'guest',
				'rsvp' => 'none', 'invited_by' => 0, 'invited' => $now,
			] );
			Notify::push( (int) $uid, 'meeting', 'You are invited to ' . $m['title'], '', '/meet/' . $mid, 'mtinv' . $mid . '-' . (int) $uid );
		}
		// Somebody who released their claim is no longer on this grant, so they come off the sitting —
		// but the sitting itself stands for everyone still working on it.
		foreach ( array_diff( $have, $w['people'] ) as $uid ) {
			$GLOBALS['wpdb']->delete( Data::t( 'aq_meet_guests' ), [ 'meet_id' => $mid, 'user_id' => (int) $uid ] );
		}
	}

	// ── Housekeeping ────────────────────────────────────────────────────────

	/**
	 * Bounded sweeps, run lazily from meet/list (the Season::ensure_archived pattern) so a quiet
	 * site still keeps its rows honest. Gated to once every five minutes: every transient here is a
	 * wp_options write on a box with no persistent object cache.
	 */
	public static function tick() {
		if ( get_transient( 'aq_meet_tick' ) ) { return; }
		set_transient( 'aq_meet_tick', 1, 300 );
		global $wpdb;
		$now = Data::now();
		$t   = Data::t( 'aq_meets' );

		// THE ROOM IS ACTUALLY THROWN AWAY, because the page says it is. The sweep used to null
		// `room_id` and stop, which unbound the room without disposing of it — so a meeting told its
		// members "the room is made fifteen minutes before and thrown away after" while the room and
		// every sealed message in it stayed in ArtaChat indefinitely. A promise about what happens to
		// people's words is not a thing to be approximately right about. Emptying it is the disposal:
		// Rooms deletes a room when its last member leaves, so removing each member in turn is what
		// makes the sentence true.
		foreach ( Data::all(
			"SELECT id, room_id FROM $t WHERE status IN ('scheduled','live') AND room_id > 0 AND end_ts > 0 AND end_ts < %d LIMIT 100",
			[ $now - self::GRACE_S ]
		) as $r ) {
			$rid = (int) $r['room_id'];
			foreach ( self::room_member_ids( $rid ) as $uid ) {
				// Each member removes THEMSELVES — Rooms::leave refuses anyone else unless the caller
				// owns the room, and which member happened to bind it is not something to depend on.
				self::rooms( 'leave', [ 'id' => $rid ], $uid );
			}
		}

		// Anything past its grace window is over, whether or not anyone pressed anything.
		$wpdb->query( $wpdb->prepare(
			"UPDATE $t SET status = 'ended', room_id = 0, updated = %d WHERE status IN ('scheduled','live') AND end_ts > 0 AND end_ts < %d",
			$now, $now - self::GRACE_S
		) );

		// A room whose last member left is deleted by Rooms, and a meeting pointing at one that no
		// longer exists would offer a join button that can never work. lobby() heals on read too.
		foreach ( Data::all( "SELECT id, room_id FROM $t WHERE room_id > 0 LIMIT 200" ) as $r ) {
			if ( self::room_epoch( (int) $r['room_id'] ) ) { continue; }
			Data::update( 'aq_meets', [ 'room_id' => 0, 'opened_ts' => 0, 'updated' => $now ], [ 'id' => (int) $r['id'] ] );
		}

		// A cancelled meeting has finished doing its job once it has fallen out of the feed's
		// backward window — until then it must keep emitting STATUS:CANCELLED.
		foreach ( Data::all(
			"SELECT id FROM $t WHERE status = 'cancelled' AND start_ts > 0 AND start_ts < %d LIMIT 100",
			[ $now - self::ICS_PAST_S ]
		) as $r ) {
			$wpdb->delete( Data::t( 'aq_meet_guests' ), [ 'meet_id' => (int) $r['id'] ] );
			$wpdb->delete( Data::t( 'aq_meets' ), [ 'id' => (int) $r['id'] ] );
		}
	}
}
