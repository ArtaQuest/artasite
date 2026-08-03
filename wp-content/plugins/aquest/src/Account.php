<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Account deletion — the member's irreversible "purge my profile" control (ticket #110).
 *
 * Auth here is passwordless (email one-time code / Google), so the destructive action is gated by a
 * TWO-FACTOR confirmation that survives both an accidental click and a hijacked live session:
 *   1. a RE-AUTH code emailed to the member's address (proves possession of the actual auth factor), and
 *   2. a TYPED confirmation phrase ("DELETE").
 * Both are required by delete_confirm(); the code is single-use, hashed in a short-lived transient, and
 * rate-limited. Operator (manage_options) and the ArtaBot bot account can't be deleted through it.
 *
 * WHAT A PURGE REMOVES vs KEEPS — the whole DB is PUBLIC (radical transparency), so "purge" means erase
 * every piece of the member's identity, content and personal state, while honouring the two invariants
 * the architecture is built on:
 *
 *   DELETED (the profile + the member's own footprint):
 *     • the WordPress user + ALL usermeta — name, email, the random unused password hash, identity
 *       (full name / birthday / nationality), the blue-check flag, avatar + palm URLs, bio, typology
 *       tags, Stripe-account id, session tokens — and the avatar/palm files on disk (PII purge);
 *     • their discussion threads (+ every reply/vote beneath, like Social::thread_delete);
 *     • their comments everywhere else (soft-deleted to "[deleted]" when other members have replied so
 *       the subtree stays readable, hard-deleted when a leaf — exactly Social::comment_delete's rules),
 *       with the denormalized board counters kept exact;
 *     • enrolments (+ each course's learner count decremented), lesson progress, reviews (+ the course
 *       rating recomputed from the survivors), bursary grants, the social graph (both directions),
 *       contribution tickets + their messages, the ArtaBot conversation, issue reports, grant claims,
 *       peer endorsements (given + received), notifications, the per-season competition standing
 *       (aq_quester) and frozen past-season podium rows (aq_season_results).
 *
 *   KEPT — anonymized, never deleted (the member is gone, so a bare user_id no longer resolves to a
 *   person; every read path already renders a vanished user as "Quester"/unlinked, the leaderboard
 *   skips them, and these carry no PII):
 *     • the APPEND-ONLY ledgers aq_coin_ledger + aq_points_ledger and their aq_standing projection —
 *       deleting them would break the full-reserve proof (SUM(coin.delta) == backing) / the points
 *       projection and retroactively reduce the global circulating-supply counter; financial records
 *       are retained by design (a deleted account never claws coins back out of circulation);
 *     • the votes the member CAST on other people's posts — removing them would retroactively strip
 *       other members of upvotes they fairly earned (and could claw back a past season's prize, which
 *       the competition never does);
 *     • courses the member authored stay published with an orphaned author_id, so the other learners,
 *       comments, rankings and prize pools on those courses are untouched.
 */
final class Account {

	const CODE_TTL     = 900;      // the re-auth code's life — 15 minutes
	const CONFIRM_WORD = 'DELETE'; // the typed confirmation phrase (case-sensitive)

	// ── Routes ───────────────────────────────────────────────────────────────

	/** POST /me/delete/request — email the member a 6-digit code to confirm deletion (re-auth step). */
	public static function delete_request( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		if ( $blocked = self::undeletable( $uid ) ) { return $blocked; }
		if ( Rest::throttle( 'del_req_' . $uid, 5, 3600 ) ) {
			return Rest::err( 'rate_limited', 'Too many requests. Try again shortly.', 429 );
		}
		$code = (string) wp_rand( 100000, 999999 );
		set_transient( self::code_key( $uid ), wp_hash( $code ), self::CODE_TTL );
		$u = get_userdata( $uid );
		if ( $u && $u->user_email ) {
			Mailer::send( 'delete_account', $u->user_email, [ 'code' => $code ] ); // best-effort; never blocks
		}
		return [ 'ok' => true, 'email' => $u ? self::mask_email( $u->user_email ) : '', 'expires_in' => self::CODE_TTL ];
	}

	/** POST /me/delete/confirm {code, confirm} — verify the code + typed phrase, then PURGE + sign out. */
	public static function delete_confirm( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		if ( $blocked = self::undeletable( $uid ) ) { return $blocked; }
		if ( Rest::throttle( 'del_confirm_' . $uid, 12, 3600 ) ) {
			return Rest::err( 'rate_limited', 'Too many attempts. Try again shortly.', 429 );
		}
		// The typed confirmation — the anti-accident guard (must be EXACTLY the word, no trimming slack
		// beyond the surrounding whitespace the field may add).
		if ( trim( (string) Rest::p( $req, 'confirm', '' ) ) !== self::CONFIRM_WORD ) {
			return Rest::err( 'bad_confirm', 'Type ' . self::CONFIRM_WORD . ' to confirm.' );
		}
		// The re-auth code — single-use, compared in constant time against the salted hash transient.
		$code   = preg_replace( '/\D/', '', (string) Rest::p( $req, 'code', '' ) );
		$stored = get_transient( self::code_key( $uid ) );
		if ( ! $stored || strlen( $code ) !== 6 || ! hash_equals( (string) $stored, wp_hash( $code ) ) ) {
			return Rest::err( 'bad_code', 'That code is wrong or expired. Request a new one.' );
		}
		delete_transient( self::code_key( $uid ) ); // burn it — one shot

		self::purge( $uid );
		wp_logout(); // session destroyed + cookies cleared so the SPA bounces to a logged-out state
		return [ 'ok' => true, 'redirect' => '/' ];
	}

	// ── Guards / helpers ──────────────────────────────────────────────────────

	/** Why this account may NOT be self-deleted (operator + the ArtaBot system user), or null. */
	private static function undeletable( $uid ) {
		if ( user_can( (int) $uid, 'manage_options' ) ) {
			return Rest::err( 'forbidden', 'Operator accounts can’t be deleted here.', 403 );
		}
		if ( (int) $uid === (int) get_option( 'aq_artabot_uid', 0 ) ) {
			return Rest::err( 'forbidden', 'This account can’t be deleted.', 403 );
		}
		return null;
	}

	private static function code_key( $uid ) { return 'aq_del_' . (int) $uid; }

	/** a@host → a•••@host — enough to recognise your own address without echoing it in full. */
	private static function mask_email( $email ) {
		$email = (string) $email;
		$at    = strpos( $email, '@' );
		if ( $at === false ) { return ''; }
		$name = substr( $email, 0, $at );
		return mb_substr( $name, 0, 1 ) . str_repeat( '•', max( 1, mb_strlen( $name ) - 1 ) ) . substr( $email, $at );
	}

	/**
	 * Decrement an UNSIGNED denormalized counter without ever underflowing it past 0 — a raw
	 * `col = col - n` would WRAP an UNSIGNED column to a huge number if pre-existing drift left it < n
	 * (the exact class of bug noted around aq_lessons.comment_count). Floors at 0.
	 */
	private static function dec_counter( $key, $id, $col, $by ) {
		global $wpdb;
		$by = (int) $by;
		if ( $by <= 0 || ! (int) $id ) { return; }
		$t = Data::t( $key );
		$wpdb->query( $wpdb->prepare(
			"UPDATE $t SET `$col` = CASE WHEN `$col` >= %d THEN `$col` - %d ELSE 0 END WHERE id = %d",
			$by, $by, (int) $id
		) );
	}

	// ── The purge cascade ──────────────────────────────────────────────────────

	/**
	 * Erase the member from the database. See the class doc-block for the full DELETED-vs-KEPT contract.
	 * Idempotent enough to be safely retried: every step targets the member's own rows by id, and the
	 * WordPress account is deleted LAST, so a mid-way failure leaves the account intact and re-runnable.
	 *
	 * KNOWN SCALE NOTE: account deletion is inherently O(the member's footprint) — it must touch each of
	 * their rows. It is a rare, member-initiated, one-time action, so the per-row work is acceptable; the
	 * genuinely expensive recompute (course trend) is batched to once per affected course.
	 */
	private static function purge( $uid ) {
		global $wpdb;
		$uid = (int) $uid;
		if ( $uid <= 0 ) { return; }

		$C  = Data::t( 'aq_comments' );
		$V  = Data::t( 'aq_votes' );
		$TH = Data::t( 'aq_threads' );

		// 1. The member's own DISCUSSION THREADS — delete each with its whole reply/vote subtree, exactly
		//    as Social::thread_delete does (a thread takes its replies with it, regardless of their author).
		foreach ( array_map( 'intval', $wpdb->get_col( $wpdb->prepare( "SELECT id FROM $TH WHERE author_id = %d", $uid ) ) ) as $tid ) {
			$wpdb->query( $wpdb->prepare(
				"DELETE FROM $V WHERE target_type = 'comment' AND target_id IN ( SELECT id FROM $C WHERE context_type = 'thread' AND context_id = %d )",
				$tid
			) );
			$wpdb->delete( $V,  [ 'target_type' => 'thread', 'target_id' => $tid ] );
			$wpdb->delete( $C,  [ 'context_type' => 'thread', 'context_id' => $tid ] );
			$wpdb->delete( $TH, [ 'id' => $tid ] );
		}

		// 2. The member's COMMENTS everywhere else (other people's threads + the section/competition
		//    boards). Mirror Social::comment_delete: a comment that others have replied to is SOFT-deleted
		//    (author zeroed, body blanked → "[deleted]") so the subtree survives; a leaf is hard-deleted.
		//    Votes the comment EARNED drop with the content either way. Counter decrements are batched.
		$rows        = $wpdb->get_results( $wpdb->prepare(
			"SELECT id, context_type, context_id, course_id, parent_id, reply_count FROM $C WHERE author_id = %d", $uid ), ARRAY_A );
		$parent_dec  = []; // comment id → replies to subtract
		$lesson_dec  = []; // lesson id  → section comments to subtract from comment_count
		$thread_dec  = []; // thread id  → comments to subtract from comment_count
		$trend_cids  = []; // section courses whose comment-based trend must be recomputed
		foreach ( $rows as $r ) {
			$id = (int) $r['id'];
			$wpdb->delete( $V, [ 'target_type' => 'comment', 'target_id' => $id ] ); // others' votes on this comment
			if ( (int) $r['reply_count'] > 0 ) {
				$wpdb->update( $C, [ 'author_id' => 0, 'body' => '', 'votes' => 0 ], [ 'id' => $id ] ); // soft
			} else {
				$wpdb->delete( $C, [ 'id' => $id ] ); // leaf — hard delete + maintain the denormalized counters
				if ( (int) $r['parent_id'] > 0 ) { $parent_dec[ (int) $r['parent_id'] ] = ( $parent_dec[ (int) $r['parent_id'] ] ?? 0 ) + 1; }
				if ( $r['context_type'] === 'section' ) { $lesson_dec[ (int) $r['context_id'] ] = ( $lesson_dec[ (int) $r['context_id'] ] ?? 0 ) + 1; }
				else                                      { $thread_dec[ (int) $r['context_id'] ] = ( $thread_dec[ (int) $r['context_id'] ] ?? 0 ) + 1; }
			}
			if ( $r['context_type'] === 'section' && (int) $r['course_id'] > 0 ) { $trend_cids[ (int) $r['course_id'] ] = true; }
		}
		foreach ( $parent_dec as $pid => $n ) { self::dec_counter( 'aq_comments', $pid, 'reply_count', $n ); }
		foreach ( $lesson_dec as $lid => $n ) { self::dec_counter( 'aq_lessons', $lid, 'comment_count', $n ); }
		foreach ( $thread_dec as $tid => $n ) { self::dec_counter( 'aq_threads', $tid, 'comment_count', $n ); }
		if ( class_exists( '\\AQ\\YouTube' ) ) {
			foreach ( array_keys( $trend_cids ) as $cid ) { YouTube::recompute_course_trend( $cid ); } // comment-based ranking follows the removed comments
		}

		// 3. The COMPETITION: their section comments are gone above, so drop their per-season standing
		//    projection (aq_quester) and their frozen past-season podium rows (aq_season_results). Both
		//    are per-user; other questers' buckets/results — and the upvotes THEY earned — are untouched.
		$wpdb->delete( Data::t( 'aq_quester' ),        [ 'user_id' => $uid ] );
		$wpdb->delete( Data::t( 'aq_season_results' ), [ 'user_id' => $uid ] );

		// 4. ENROLMENTS + per-lesson PROGRESS. Decrement each course's denormalized learner count (the
		//    inverse of Learn::ensure_enrolled's +1); the fee already paid stays as course `revenue` so
		//    the prize pool isn't reduced — only the live learner count follows the member out.
		$E = Data::t( 'aq_enroll' );
		foreach ( array_map( 'intval', $wpdb->get_col( $wpdb->prepare( "SELECT course_id FROM $E WHERE user_id = %d", $uid ) ) ) as $cid ) {
			self::dec_counter( 'aq_courses', $cid, 'enroll_count', 1 );
		}
		$wpdb->delete( $E, [ 'user_id' => $uid ] );
		$wpdb->delete( Data::t( 'aq_progress' ), [ 'user_id' => $uid ] );

		// 5. REVIEWS — delete, then recompute each affected course's rating aggregates from the SURVIVING
		//    reviews (the exact recompute Courses::add_review uses), so the star average stays exact.
		$RV = Data::t( 'aq_reviews' );
		$review_cids = array_map( 'intval', $wpdb->get_col( $wpdb->prepare( "SELECT DISTINCT course_id FROM $RV WHERE user_id = %d", $uid ) ) );
		$wpdb->delete( $RV, [ 'user_id' => $uid ] );
		foreach ( $review_cids as $cid ) {
			$agg = Data::one( "SELECT COUNT(*) n, COALESCE(SUM(rating),0) s FROM $RV WHERE course_id = %d", [ $cid ] );
			Data::update( 'aq_courses', [ 'rating_n' => (int) $agg['n'], 'rating_sum' => (int) $agg['s'] ], [ 'id' => $cid ] );
		}

		// 6. The rest of the member's own rows: bursary grants, the follow graph (both directions),
		//    contribution tickets + their message threads, the ArtaBot conversation, issue reports, grant
		//    claims, peer endorsements (given + received), and notifications.
		$wpdb->delete( Data::t( 'aq_bursary' ), [ 'user_id' => $uid ] );
		$wpdb->delete( Data::t( 'aq_follows' ), [ 'follower_id' => $uid ] );
		$wpdb->delete( Data::t( 'aq_follows' ), [ 'target_id' => $uid ] );
		$TK = Data::t( 'aq_tickets' );
		$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . Data::t( 'aq_ticket_messages' ) . " WHERE ticket_id IN ( SELECT id FROM $TK WHERE user_id = %d )", $uid ) );
		$wpdb->delete( $TK, [ 'user_id' => $uid ] );
		$wpdb->delete( Data::t( 'aq_artabot_messages' ), [ 'user_id' => $uid ] );
		$wpdb->delete( Data::t( 'aq_bug_findings' ),     [ 'user_id' => $uid ] );
		$wpdb->delete( Data::t( 'aq_grant_claims' ),     [ 'user_id' => $uid ] );
		$wpdb->delete( Data::t( 'aq_endorsements' ),     [ 'user_id' => $uid ] );   // endorsements the member GAVE
		$wpdb->delete( Data::t( 'aq_endorsements' ),     [ 'target_id' => $uid ] ); // endorsements the member RECEIVED
		$wpdb->delete( Data::t( 'aq_notifications' ),    [ 'user_id' => $uid ] );

		// 7. Uploaded files — the avatar + palm "back photo" on disk. wp_delete_user clears the usermeta
		//    that points at them, but not the files wp_upload_bits wrote, so unlink them first.
		foreach ( [ 'aq_avatar_file', 'aq_palm_file' ] as $mk ) {
			$f = (string) get_user_meta( $uid, $mk, true );
			if ( $f !== '' && @file_exists( $f ) ) { @unlink( $f ); }
		}

		// 8. KEPT BY DESIGN (see the class doc-block): aq_coin_ledger + aq_points_ledger + aq_standing
		//    (append-only / full-reserve + points invariants), the votes the member cast (other members'
		//    earned upvotes), and aq_courses they authored (other learners' courses). Nothing to do here —
		//    these are deliberately left as anonymized, ownerless rows the read paths already tolerate.

		// 9. Finally the WordPress account itself — wp_users + ALL usermeta (the PII purge). reassign=null
		//    also removes any stray wp_posts the user owns (ArtaQuest keeps no content there, so none).
		if ( ! function_exists( 'wp_delete_user' ) ) { require_once ABSPATH . 'wp-admin/includes/user.php'; }
		wp_delete_user( $uid );
	}
}
