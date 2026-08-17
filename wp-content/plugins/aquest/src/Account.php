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
 *     • AND (2026-08-16, operator: "authors should have purge access to all their data") the whole
 *       feed footprint — every work (drafts and published; a DOI'd work leaves a content-free
 *       tombstone so its DOI keeps resolving), every post, the hearts they gave (with the targets'
 *       counters corrected), their Library files and uploads INCLUDING the CDN objects, their side of
 *       every ArtaChat conversation and room, meetings hosted, invitations, availability, API tokens,
 *       passkeys, shell keys, the Kaggle handle proof — see purge_feed(); then a schema SWEEP deletes
 *       by member-shaped column from every aq_* table not on the RETAIN list, so a table nobody
 *       remembered is covered by default rather than by luck.
 *
 *   KEPT — anonymized, never deleted (the member is gone, so a bare user_id no longer resolves to a
 *   person, and none of it carries PII), each named in RETAIN with its reason:
 *     • the APPEND-ONLY money records — aq_coin_ledger + aq_points_ledger + aq_standing, the donation
 *       ledger, the Foundation's double-entry books, invoices and metered usage. Deleting them would
 *       break the reserve proof (SUM(coin.delta) == backing) and the statements a corporation must
 *       file; a deleted account never claws coins back out of circulation;
 *     • challenges the member FOUNDED that hold other members' entry fees (anonymised — the pool is
 *       other people's money and settles on its own deadline), and settled prize records;
 *     • courses the member authored on the retired platform stay with an orphaned author_id.
 *
 *   NOT IN OUR POWER: the copy Zenodo archived when a DOI was minted. Its API deletes drafts only.
 *   The confirmation screen says so before the member commits.
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

		// 8. THE FEED — everything the member made after the Kaggle-notebook reset (operator 2026-08-16:
		//    "authors should have purge access to all their data"). Steps 1-7 above are the RETIRED
		//    platform's footprint; until this step existed, a deleted member left every work, post,
		//    heart, file, conversation and meeting behind under an orphaned id.
		self::purge_feed( $uid );

		// 9. KEPT BY DESIGN: the append-only ledgers (aq_coin_ledger, aq_points_ledger, aq_standing,
		//    aq_fund_ledger, the Foundation's books), invoices and metered usage — the money records a
		//    corporation must keep, none of which resolve to a person once the account row is gone.
		//    Challenges the member FOUNDED that hold other members' entry fees are anonymised, not
		//    deleted: the pool is other people's money and settles on its own deadline.

		// 10. THE SWEEP — the guarantee that a table nobody remembered still gets purged. Every aq_*
		//     table with a member-shaped column not on the retained list is deleted by that column.
		//     Default-delete, like the public-DB redaction is default-deny: a table added next month
		//     with an author_id is covered before anybody thinks about it, and one that must be kept
		//     has to be NAMED here with a reason.
		self::sweep( $uid );

		// 11. Finally the WordPress account itself — wp_users + ALL usermeta (the PII purge). reassign=null
		//    also removes any stray wp_posts the user owns (ArtaQuest keeps no content there, so none).
		if ( ! function_exists( 'wp_delete_user' ) ) { require_once ABSPATH . 'wp-admin/includes/user.php'; }
		wp_delete_user( $uid );
	}

	/**
	 * The member's footprint on the feed platform: works, posts, hearts, files, conversations,
	 * rooms, meetings, keys and tokens. Each destroyed the way its own delete does it, so a member
	 * who deleted things one by one and a member who purged the account end in the same state.
	 */
	private static function purge_feed( $uid ) {
		global $wpdb;
		$uid = (int) $uid;
		Notebook::ensure_tables();

		// Works — every status, drafts included. purge_work takes the Library rows, CDN objects,
		// comments, hearts, entries and the auto-post with each; a DOI'd work leaves its tombstone.
		foreach ( Data::all( 'SELECT * FROM ' . Data::t( 'aq_notebooks' ) . ' WHERE author_id = %d', [ $uid ] ) as $r ) {
			Notebook::purge_work( $r );
		}
		// Posts the member wrote (reposts and quotes included), each with its attachments + hearts.
		foreach ( Data::all( 'SELECT * FROM ' . Data::t( 'aq_posts' ) . ' WHERE author_id = %d', [ $uid ] ) as $post ) {
			Notebook::purge_post( $post );
		}
		// Hearts the member CAST. The retired platform kept a departed member's upvotes so nobody
		// lost a season standing retroactively; the operator's rule for THIS platform is that all of a
		// member's activity goes. The target's denormalised counter follows, so counts stay exact.
		$V = Data::t( 'aq_votes' );
		foreach ( Data::all( "SELECT target_type, target_id FROM $V WHERE user_id = %d", [ $uid ] ) as $v ) {
			$tbl = [ 'notebook' => 'aq_notebooks', 'post' => 'aq_posts' ][ (string) $v['target_type'] ] ?? '';
			if ( '' !== $tbl ) {
				$wpdb->query( $wpdb->prepare( 'UPDATE ' . Data::t( $tbl ) . ' SET hearts = GREATEST(hearts - 1, 0) WHERE id = %d', (int) $v['target_id'] ) );
			}
		}
		$wpdb->delete( $V, [ 'user_id' => $uid ] );

		// Challenge entries (the fee already sits in the pool ledger — the entry is the member's link
		// to it, and that link is theirs to remove). Challenges FOUNDED: gone if nobody has entered,
		// otherwise anonymised — see step 9.
		$wpdb->delete( Data::t( 'aq_nb_entries' ), [ 'user_id' => $uid ] );
		$CH = Data::t( 'aq_nb_challenges' ); $EN = Data::t( 'aq_nb_entries' );
		$wpdb->query( $wpdb->prepare( "DELETE FROM $CH WHERE creator_id = %d AND NOT EXISTS ( SELECT 1 FROM $EN e WHERE e.ch_id = $CH.id )", $uid ) );
		$wpdb->query( $wpdb->prepare( "UPDATE $CH SET creator_id = 0 WHERE creator_id = %d", $uid ) );

		// Uploaded media — through Media::destroy so the CDN object goes with the row.
		if ( class_exists( '\\AQ\\Media' ) ) {
			foreach ( Data::all( 'SELECT id, store_key FROM ' . Data::t( 'aq_media' ) . ' WHERE user_id = %d', [ $uid ] ) as $m ) {
				Media::destroy( (string) $m['store_key'] );
				$wpdb->delete( Data::t( 'aq_media' ), [ 'id' => (int) $m['id'] ] );
			}
		}

		// ArtaChat. The member's own messages (ciphertext + attachment blobs) go; the OTHER party's
		// messages in the same conversation are the other party's — they stay, as on any messenger
		// where deleting your account clears your side. Then the conversation rows, keys and the
		// recovery escrow.
		$CM = Data::t( 'aq_chat_msgs' ); $CT = Data::t( 'aq_chats' );
		if ( class_exists( '\\AQ\\Chat' ) && method_exists( '\\AQ\\Chat', 'purge_member' ) ) {
			Chat::purge_member( $uid );
		} else {
			$wpdb->delete( $CM, [ 'sender_id' => $uid ] );
			$wpdb->query( $wpdb->prepare( "DELETE FROM $CM WHERE chat_id IN ( SELECT id FROM $CT WHERE a_uid = %d OR b_uid = %d ) AND sender_id = %d", $uid, $uid, $uid ) );
			$wpdb->query( $wpdb->prepare( "DELETE FROM $CT WHERE a_uid = %d OR b_uid = %d", $uid, $uid ) );
			$wpdb->delete( Data::t( 'aq_chat_keys' ),  [ 'user_id' => $uid ] );
			$wpdb->delete( Data::t( 'aq_chat_vault' ), [ 'user_id' => $uid ] );
		}
		// Rooms: messages sent, memberships and key grants go; a room the member OWNS goes whole —
		// it is their room, as a deleted post is their post.
		$R = Data::t( 'aq_rooms' ); $RM = Data::t( 'aq_room_members' ); $RS = Data::t( 'aq_room_msgs' ); $RK = Data::t( 'aq_room_keys' );
		foreach ( Data::all( "SELECT id FROM $R WHERE owner_id = %d", [ $uid ] ) as $room ) {
			$rid = (int) $room['id'];
			$wpdb->delete( $RS, [ 'room_id' => $rid ] );
			$wpdb->delete( $RK, [ 'room_id' => $rid ] );
			$wpdb->delete( $RM, [ 'room_id' => $rid ] );
			$wpdb->delete( $R,  [ 'id' => $rid ] );
		}
		$wpdb->delete( $RS, [ 'sender_id' => $uid ] );
		$wpdb->delete( $RM, [ 'user_id' => $uid ] );
		$wpdb->delete( $RK, [ 'user_id' => $uid ] );
		$wpdb->delete( $RK, [ 'from_uid' => $uid ] );

		// Meetings hosted (with their guest lists), invitations received, availability rules.
		$M = Data::t( 'aq_meets' ); $MG = Data::t( 'aq_meet_guests' );
		$wpdb->query( $wpdb->prepare( "DELETE FROM $MG WHERE meet_id IN ( SELECT id FROM $M WHERE host_id = %d )", $uid ) );
		$wpdb->delete( $M,  [ 'host_id' => $uid ] );
		$wpdb->delete( $MG, [ 'user_id' => $uid ] );
		$wpdb->delete( Data::t( 'aq_meet_rules' ), [ 'user_id' => $uid ] );

		// BOOKS (ArtaRead documents) — through Library::purge_doc, so the sources, the cover and the
		// extracted body text go, not just the row. The sweep alone would delete rows and leave files.
		if ( class_exists( '\\AQ\\Library' ) && method_exists( '\\AQ\\Library', 'purge_doc' ) ) {
			foreach ( Data::all( 'SELECT * FROM ' . Data::t( 'aq_documents' ) . ' WHERE author_id = %d', [ $uid ] ) as $doc ) {
				Library::purge_doc( $doc );
			}
		}
		// THE RETIRED KINDS' FILES. Their tables are swept by author_id, but a swept row leaves its
		// bytes on disk — so unlink the file columns FIRST, while the rows are still readable. Each
		// pair is table => [url columns]; every one of these deletes already worked this way per item.
		foreach ( [
			'aq_films'         => [ 'video_url', 'poster' ],
			'aq_illustrations' => [ 'image_url' ],
			'aq_animations'    => [ 'video_url', 'poster' ],
			'aq_tracks'        => [ 'audio_url', 'cover' ],
			'aq_narrations'    => [ 'audio_url' ],
		] as $tbl => $cols ) {
			$t = Data::t( $tbl );
			// The retired kinds' tables may not exist on a fresh install (their seeders were removed
			// with the platform), and SELECTing from a missing table is a fatal, not an empty set.
			if ( ! Data::col( 'SHOW TABLES LIKE %s', [ $t ] ) ) { continue; }
			foreach ( Data::all( "SELECT * FROM $t WHERE author_id = %d", [ $uid ] ) as $row ) {
				foreach ( $cols as $c ) {
					$u = (string) ( $row[ $c ] ?? '' );
					if ( '' !== $u ) { Media::destroy( $u ); }
				}
			}
		}

		// Credentials and identities: API tokens, passkeys, shell keys, the Kaggle handle proof.
		foreach ( [ 'aq_api_tokens', 'aq_passkeys', 'aq_shell_keys', 'aq_kaggle_ids', 'aq_artabot_sessions' ] as $t ) {
			$wpdb->delete( Data::t( $t ), [ 'user_id' => $uid ] );
		}
	}

	/**
	 * Tables whose member-shaped columns the sweep must NOT delete by, each with its reason. Anything
	 * NOT here that carries such a column is swept. Keep the reasons honest: this list is the only
	 * thing standing between "purge" and "purge except what we forgot to think about".
	 */
	const RETAIN = [
		'aq_coin_ledger'   => 'append-only money ledger; SUM(delta) is the reserve proof',
		'aq_points_ledger' => 'append-only points ledger',
		'aq_standing'      => 'projection of the points ledger',
		'aq_fund_ledger'   => 'donation ledger, mirrored into the general ledger',
		'aq_books_entry'   => 'the Foundation\'s general ledger (double entry)',
		'aq_books_line'    => 'general ledger lines',
		'aq_books_invoice' => 'invoice register (drives the authorised reserve shortfall)',
		'aq_books_doc'     => 'ledger documents',
		'aq_invoices'      => 'usage invoices — a corporation keeps its invoices',
		'aq_usage'         => 'metered usage behind those invoices',
		'aq_orders'        => 'shop orders (financial)',
		'aq_order_items'   => 'shop order lines',
		'aq_order_ship'    => 'shop shipments',
		'aq_fulfilment'    => 'payment fulfilment records',
		'aq_credit_grants' => 'ArtaBot credit ledger',
		'aq_credit_gifts'  => 'ArtaBot credit ledger',
		'aq_nb_challenges' => 'founded challenges holding others\' fees are anonymised in purge_feed',
		'aq_challenge_results' => 'settled prize records (ledger-adjacent)',
		'aq_courses'       => 'retired platform: other learners\' courses stay, author orphaned',
		'aq_votes'         => 'handled in purge_feed with counter maintenance',
		'aq_endorsements'  => 'handled above (both directions)',
		'aq_follows'       => 'handled above (both directions)',
		'aq_notebooks'     => 'handled by purge_work (tombstones keep author_id 0)',
	];

	/** Column names that mean "this row belongs to a member". Deliberately NOT target_id, which is
	 *  polymorphic (a comment id in aq_votes, a user id in aq_follows) and is handled per table above. */
	const MEMBER_COLS = [ 'user_id', 'author_id', 'owner_id', 'uid', 'member_id', 'host_id', 'creator_id', 'founder_id',
		'sender_id', 'follower_id', 'from_uid', 'to_uid', 'guest_id', 'donor_id', 'booker_id', 'a_uid', 'b_uid' ];

	/**
	 * Delete the member's rows from every aq_* table with a member-shaped column that is not on the
	 * RETAIN list. Returns [table.column => rows] for the log. SHOW TABLES / SHOW COLUMNS run on both
	 * MySQL (prod) and the SQLite shim (Studio).
	 */
	public static function sweep( $uid, $dry = false ) {
		global $wpdb;
		$uid  = (int) $uid;
		$done = [];
		$tables = (array) $wpdb->get_col( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $wpdb->prefix . 'aq_' ) . '%' ) );
		foreach ( $tables as $full ) {
			$short = substr( $full, strlen( $wpdb->prefix ) );
			if ( isset( self::RETAIN[ $short ] ) ) { continue; }
			$cols = (array) $wpdb->get_col( "SHOW COLUMNS FROM `$full`", 0 );
			foreach ( array_intersect( $cols, self::MEMBER_COLS ) as $col ) {
				$n = $dry
					? (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM `$full` WHERE `$col` = %d", $uid ) )
					: (int) $wpdb->query( $wpdb->prepare( "DELETE FROM `$full` WHERE `$col` = %d", $uid ) );
				if ( $n > 0 ) { $done[ "$short.$col" ] = $n; }
			}
		}
		if ( $done && ! $dry ) { error_log( 'aq purge sweep uid=' . $uid . ' ' . wp_json_encode( $done ) ); }
		return $done;
	}

	/**
	 * GET /me/footprint — what a purge would destroy, counted, so the confirmation screen can say it
	 * in numbers rather than adjectives. Read-only; the same tables the purge walks.
	 */
	public static function footprint( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Sign in first', 401 ); }
		Notebook::ensure_tables();
		$c = static fn( $t, $where, $args = [] ) => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( $t ) . " WHERE $where", $args );
		return [
			'works_published' => $c( 'aq_notebooks', "author_id = %d AND status = 'published'", [ $uid ] ),
			'works_drafts'    => $c( 'aq_notebooks', "author_id = %d AND status NOT IN ('published','removed','deleted')", [ $uid ] ),
			'works_with_doi'  => $c( 'aq_notebooks', "author_id = %d AND doi <> ''", [ $uid ] ),
			'posts'           => $c( 'aq_posts', 'author_id = %d', [ $uid ] ),
			'comments'        => $c( 'aq_comments', 'author_id = %d', [ $uid ] ),
			'hearts_given'    => $c( 'aq_votes', 'user_id = %d', [ $uid ] ),
			'files'           => $c( 'aq_library', 'author_id = %d', [ $uid ] ) + $c( 'aq_media', 'user_id = %d', [ $uid ] ),
			'messages'        => $c( 'aq_chat_msgs', 'sender_id = %d', [ $uid ] ) + $c( 'aq_room_msgs', 'sender_id = %d', [ $uid ] ),
			'meetings_hosted' => $c( 'aq_meets', 'host_id = %d', [ $uid ] ),
			'challenges_founded' => $c( 'aq_nb_challenges', 'creator_id = %d', [ $uid ] ),
			'followers'       => $c( 'aq_follows', 'target_id = %d', [ $uid ] ),
			'following'       => $c( 'aq_follows', 'follower_id = %d', [ $uid ] ),
			// What the sweep would additionally touch — surfaced so a member can see the long tail.
			'other'           => self::sweep( $uid, true ),
		];
	}
}
