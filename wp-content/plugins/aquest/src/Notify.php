<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * A lightweight per-user notification centre. One append-only row per event in
 * `aq_notifications` (user_id, type, title, body, url, ref, read, created). Notifications are
 * pushed when something happens TO a member — their profile is updated, someone follows them,
 * a peer upvotes their reply — and surfaced in the account drawer's bell.
 *
 * `ref` makes a push idempotent for events that can replay (a follow toggled off/on), so the
 * same notification is never duplicated. Reads are keyset-cheap (KEY user_id_id).
 */
final class Notify {

	/** Schema version for the notifications table — bump to re-run dbDelta after a column change. */
	const TABLE_VERSION = '1';

	/**
	 * Create/upgrade the aq_notifications table. Self-contained (not in Schema::tables()) so the
	 * feature owns its storage without entangling the shared schema migration. Idempotent + cheap:
	 * dbDelta only runs when the stored table version moves. Hooked on plugins_loaded.
	 */
	public static function ensure_table() {
		if ( get_option( 'aq_notify_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$table   = $wpdb->prefix . 'aq_notifications';
		$charset = $wpdb->get_charset_collate();
		dbDelta( "CREATE TABLE {$table} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			type VARCHAR(24) NOT NULL DEFAULT '',
			title VARCHAR(191) NOT NULL DEFAULT '',
			body TEXT NULL,
			url VARCHAR(191) NOT NULL DEFAULT '',
			ref VARCHAR(64) NOT NULL DEFAULT '',
			`read` TINYINT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY user_id_id (user_id, id),
			KEY user_unread (user_id, `read`)
		) {$charset};" );
		update_option( 'aq_notify_table_version', self::TABLE_VERSION, true );
	}

	/**
	 * Push a notification to a member. Idempotent per (user, ref) when a ref is given.
	 *
	 * RETURNS TRUE ONLY WHEN A ROW WAS ACTUALLY WRITTEN — false when the ref had already rung, or
	 * when there is no member. That single bit is what lets a caller hang an EMAIL off the same
	 * `ref` without inventing a sent-flag column: the bell and the letter then share one delivery
	 * record, so a cron that fires five times inside a reminder bucket sends one of each. Callers
	 * that only want the bell can carry on ignoring the return.
	 */
	public static function push( $uid, $type, $title, $body = '', $url = '', $ref = '' ) {
		$uid = (int) $uid;
		if ( ! $uid ) { return false; }
		if ( $ref !== '' && Data::col(
			'SELECT 1 FROM ' . Data::t( 'aq_notifications' ) . ' WHERE user_id = %d AND ref = %s LIMIT 1',
			[ $uid, $ref ]
		) ) { return false; }
		Data::insert( 'aq_notifications', [
			'user_id' => $uid,
			'type'    => substr( (string) $type, 0, 24 ),
			'title'   => substr( (string) $title, 0, 191 ),
			'body'    => (string) $body,
			'url'     => substr( (string) $url, 0, 191 ),
			'ref'     => substr( (string) $ref, 0, 64 ),
			'read'    => 0,
			'created' => Data::now(),
		] );
		return true;
	}

	/**
	 * The bell AND the letter, sharing one delivery record.
	 *
	 * The email goes only when `push` actually wrote the row, so the ref that already makes the bell
	 * exactly-once makes the email exactly-once too — no sent-flag column, no second table, and no
	 * possibility of the two channels disagreeing about whether this member has been told.
	 *
	 * Mail is BEST EFFORT and never the caller's problem: an outbound failure must not roll back a
	 * booking that has already happened, so a throw is swallowed here. That is a deliberate exception
	 * to "never swallow an error" and it is safe for exactly one reason — this is delivery, never
	 * authorisation. Anything that decides whether an action is ALLOWED must still surface its errors.
	 *
	 * `$off_meta` is the member's own opt-out; an empty string means the mail cannot be turned off
	 * (used for nothing yet, and deliberately awkward to reach for).
	 */
	public static function push_mail( $uid, $type, $title, $body, $url, $ref, $tpl, $vars = [], $off_meta = 'aq_meet_email_off' ) {
		if ( ! self::push( $uid, $type, $title, $body, $url, $ref ) ) { return false; }
		self::mail( $uid, $tpl, $vars, $off_meta );
		return true;
	}

	/**
	 * The letter WITHOUT a bell — for the events that have already rung by another route.
	 *
	 * A booking rings the owner through the ordinary invitation (`add_guest`), and a second bell
	 * beside it would be two for one event. The inbox still needs telling, so the mail leg is
	 * separable. Best effort, exactly as in push_mail: delivery, never authorisation.
	 */
	public static function mail( $uid, $tpl, $vars = [], $off_meta = 'aq_meet_email_off' ) {
		$uid = (int) $uid;
		if ( ! $uid ) { return false; }
		if ( '' !== $off_meta && get_user_meta( $uid, $off_meta, true ) ) { return false; }
		if ( ! self::mail_allowed( $uid, $tpl ) ) { return false; }
		$u = get_userdata( $uid );
		if ( ! $u || ! is_email( (string) $u->user_email ) ) { return false; }
		try { return (bool) Mailer::send( $tpl, $u->user_email, $vars ); } catch ( \Throwable $e ) { return false; }
	}

	/** At most this many of ONE KIND of letter to ONE member per hour. */
	const MAIL_CAP    = 10;
	const MAIL_WINDOW = 3600;

	/**
	 * A ceiling on how much mail one member can be made to receive.
	 *
	 * The booking page is PUBLIC and its whole point is that people you do not know can take your
	 * published hours. `book/take` allows 8 per five minutes and cancelling allows 30, and each
	 * produces a letter — so one determined account could book-and-cancel roughly 190 emails an hour
	 * into an owner's inbox. Nothing about that is a bug in booking; it is the cost of the feature
	 * being open, and it has to be paid here rather than by making booking harder.
	 *
	 * PER TEMPLATE, not per member: a flood of "somebody booked you" must not be able to suppress the
	 * cancellation or the reminder for a DIFFERENT meeting that same hour. Each kind of news gets its
	 * own budget, so drowning one cannot silence the others. Ten an hour is far above any honest use
	 * — a person with ten bookings in one hour has a different problem — and far below a flood.
	 *
	 * The counter is a transient, deliberately: losing it on a cache flush re-opens the budget, which
	 * is the safe direction to fail for something whose job is to stop noise, not to guard access.
	 */
	private static function mail_allowed( $uid, $tpl ) {
		$k = 'aq_nmail_' . md5( (string) $tpl . '|' . (int) $uid );
		$n = (int) get_transient( $k );
		if ( $n >= self::MAIL_CAP ) { return false; }
		set_transient( $k, $n + 1, self::MAIL_WINDOW );
		return true;
	}

	/** GET /notifications — the signed-in member's recent notifications + unread count. */
	public static function list( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return [ 'items' => [], 'unread' => 0 ]; }
		$rows = Data::all(
			'SELECT id, type, title, body, url, `read`, created FROM ' . Data::t( 'aq_notifications' ) . ' WHERE user_id = %d ORDER BY id DESC LIMIT 30',
			[ $uid ]
		);
		$unread = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_notifications' ) . ' WHERE user_id = %d AND `read` = 0', [ $uid ] );
		return [
			'items'  => array_map( fn( $r ) => [
				'id'    => (int) $r['id'],
				'type'  => $r['type'],
				'title' => $r['title'],
				'body'  => (string) $r['body'],
				'url'   => (string) $r['url'],
				'read'  => (int) $r['read'] === 1,
				'at'    => (int) $r['created'],
			], $rows ),
			'unread' => $unread,
		];
	}

	/** POST /notifications/read {id?} — mark one notification read, or all when no id is given. */
	public static function mark_read( $req ) {
		global $wpdb;
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$id = Rest::pint( $req, 'id', 0 );
		if ( $id > 0 ) {
			$wpdb->update( Data::t( 'aq_notifications' ), [ 'read' => 1 ], [ 'id' => $id, 'user_id' => $uid ] );
		} else {
			$wpdb->query( $wpdb->prepare( 'UPDATE ' . Data::t( 'aq_notifications' ) . ' SET `read` = 1 WHERE user_id = %d AND `read` = 0', $uid ) );
		}
		return [ 'ok' => true, 'unread' => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_notifications' ) . ' WHERE user_id = %d AND `read` = 0', [ $uid ] ) ];
	}
}
