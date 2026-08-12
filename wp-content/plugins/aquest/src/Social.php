<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Global discussion graph: threads, comments, votes, follows. Boards are GLOBAL (not
 * partitioned per language) — every thread is visible to everyone and translated
 * per-viewer by the i18n mesh. User content carries its source `lang` so the client
 * skips translating posts already in the reader's language.
 *
 * Counters (comment_count, vote_score) are denormalized and bumped on write, so thread
 * lists and pages never aggregate.
 */
final class Social {

	/** GET /threads?cursor=&topic=&q= — newest-first keyset list (q = title search, powers global search). */
	public static function threads( $req ) {
		$cursor = Rest::pint( $req, 'cursor', 0 );
		$topic  = sanitize_key( (string) Rest::p( $req, 'topic', '' ) );
		$q      = trim( (string) Rest::p( $req, 'q', '' ) );
		$where  = "status = 'publish'";
		$args   = [];
		if ( $topic ) { $where .= ' AND topic = %s'; $args[] = $topic; }
		if ( $q !== '' ) { $where .= ' AND title LIKE %s'; $args[] = '%' . $GLOBALS['wpdb']->esc_like( $q ) . '%'; }
		[ $rows, $next ] = Data::page( 'aq_threads', $where, $args, $cursor, Rest::pint( $req, 'limit', 25 ) );
		return [ 'items' => array_map( [ self::class, 'thread_card' ], $rows ), 'next' => $next ];
	}

	const PAGE_TOP   = 20; // top-level comments per page (keyset, Reddit-style — same as Learn::PAGE_TOP)
	const PAGE_REPLY = 10; // direct replies inlined per comment; deeper/extra levels page via ?parent=

	/**
	 * GET /threads/{id}?sort=top|new&cursor=&parent= — thread + its comment tree, Reddit-style.
	 * TOP-LEVEL comments are keyset-paginated by sort (top = net score, new = newest); each carries
	 * its first PAGE_REPLY direct replies inline. Every row ships its own `replies` total, so the
	 * client renders "show N more replies" and pages any comment's children — at ANY depth — via
	 * ?parent=<comment id>. Rows are FLAT (parent ids); the client rebuilds the tree.
	 * Per-user fields (my_vote/mine) → this GET is no-store for authed requests (Rest::dispatch).
	 */
	public static function thread( $req ) {
		$id = Rest::pint( $req, 'id' );
		$t  = Data::one( 'SELECT * FROM ' . Data::t( 'aq_threads' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $t ) { return Rest::err( 'not_found', 'Thread not found', 404 ); }
		$uid    = Rest::uid();
		$cursor = Rest::pint( $req, 'cursor', 0 );
		$parent = Rest::pint( $req, 'parent', 0 );
		$T      = Data::t( 'aq_comments' );

		// ── Paging ONE comment's direct replies (?parent=), oldest-first conversation order ──
		if ( $parent ) {
			[ $rows, $next ] = Data::page( 'aq_comments', "context_type = 'thread' AND context_id = %d AND parent_id = %d", [ $id, $parent ], $cursor, self::PAGE_REPLY, 'ASC' );
			$myv = self::my_votes( $uid, $rows );
			return [ 'items' => array_map( fn( $r ) => self::comment_card( $r, $myv ), $rows ), 'next' => $next ];
		}

		// ── Top-level comments, keyset-paginated by sort ──
		$sort = Rest::p( $req, 'sort', 'top' ) === 'new' ? 'new' : 'top';
		$ROOT = "context_type = 'thread' AND context_id = %d AND parent_id = 0";
		if ( $sort === 'new' ) {
			[ $tops, $next ] = Data::page( 'aq_comments', $ROOT, [ $id ], $cursor, self::PAGE_TOP, 'DESC' );
		} else {
			// Net score, newest-first among ties — both keys DESC so the (context, parent, votes[, id])
			// index serves it as one reverse walk (same pattern + rationale as Learn::section_thread).
			$cv = $cursor ? (int) Data::col( "SELECT votes FROM $T WHERE id = %d", [ $cursor ] ) : null;
			if ( $cursor && $cv !== null ) {
				$tops = Data::all( "SELECT * FROM $T WHERE $ROOT AND ( votes < %d OR ( votes = %d AND id < %d ) ) ORDER BY votes DESC, id DESC LIMIT %d", [ $id, $cv, $cv, $cursor, self::PAGE_TOP + 1 ] );
			} else {
				$tops = Data::all( "SELECT * FROM $T WHERE $ROOT ORDER BY votes DESC, id DESC LIMIT %d", [ $id, self::PAGE_TOP + 1 ] );
			}
			$next = null;
			if ( count( $tops ) > self::PAGE_TOP ) { $tops = array_slice( $tops, 0, self::PAGE_TOP ); $next = (int) end( $tops )['id']; }
		}

		// Inline the first PAGE_REPLY direct replies of each shown root (oldest-first). One bounded
		// indexed read per root that HAS replies — reply_count is the gate, so quiet roots cost nothing.
		$all = $tops;
		foreach ( $tops as $c ) {
			if ( (int) $c['reply_count'] > 0 ) {
				$reps = Data::all( "SELECT * FROM $T WHERE context_type = 'thread' AND context_id = %d AND parent_id = %d ORDER BY id ASC LIMIT %d", [ $id, (int) $c['id'], self::PAGE_REPLY ] );
				$all  = array_merge( $all, $reps );
			}
		}

		$myv = self::my_votes( $uid, $all );
		$out = self::thread_card( $t );
		$out['body']     = (string) $t['body'];
		$out['comments'] = array_map( fn( $r ) => self::comment_card( $r, $myv ), $all );
		$out['next']     = $next;
		$out['sort']     = $sort;
		$out['total']    = (int) $t['comment_count'];
		// `mine` is strictly "I wrote this" — it drives both the can't-vote-your-own state and the
		// Edit/Delete controls. There is deliberately NO moderator escape hatch here (ticket #65:
		// operators saw Edit/Delete on every comment and could rewrite members' posts): only the
		// author may touch a post; moderation is ArtaMod's flag, never editing someone's words.
		$out['my_vote'] = $uid ? (int) Data::col(
			'SELECT val FROM ' . Data::t( 'aq_votes' ) . ' WHERE user_id = %d AND target_type = %s AND target_id = %d',
			[ $uid, 'thread', $id ]
		) : 0;
		return $out;
	}

	/** The viewer's vote per returned comment, one IN() read — [] when logged out or no rows. */
	private static function my_votes( $uid, $rows ) {
		if ( ! $uid || ! $rows ) { return []; }
		$ids   = array_map( fn( $r ) => (int) $r['id'], $rows );
		$place = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
		$map   = [];
		foreach ( Data::all(
			'SELECT target_id, val FROM ' . Data::t( 'aq_votes' ) . " WHERE user_id = %d AND target_type = 'comment' AND target_id IN ($place)",
			array_merge( [ $uid ], $ids )
		) as $v ) { $map[ (int) $v['target_id'] ] = (int) $v['val']; }
		return $map;
	}

	/** POST /threads {title, body, topic, lang} */
	public static function post_thread( $req ) {
		if ( Rest::throttle( 'thread', 10, 600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$title = sanitize_text_field( (string) Rest::p( $req, 'title', '' ) );
		if ( $title === '' ) { return Rest::err( 'bad_input', 'Title required' ); }
		$uid = Rest::uid();
		if ( $err = Verify::require_identity( $uid ) ) { return $err; }
		$id  = Data::insert( 'aq_threads', [
			'author_id' => $uid,
			'title'     => $title,
			'body'      => wp_kses_post( (string) Rest::p( $req, 'body', '' ) ),
			'lang'      => self::lang( $req ),
			'topic'     => sanitize_key( (string) Rest::p( $req, 'topic', '' ) ),
			'created'   => Data::now(),
		] );
		Economy::award_points( $uid, 1, 'volunteer', 'thread' . $id );
		return [ 'id' => $id ];
	}

	/** POST /threads/{id}/comments {body, lang, parent} — parent nests this as a threaded reply. */
	public static function comment( $req ) {
		if ( Rest::throttle( 'comment', 30, 600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$tid = Rest::pint( $req, 'id' );
		if ( ! Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_threads' ) . ' WHERE id = %d', [ $tid ] ) ) {
			return Rest::err( 'not_found', 'Thread not found', 404 );
		}
		$body = wp_kses_post( (string) Rest::p( $req, 'body', '' ) );
		if ( trim( $body ) === '' ) { return Rest::err( 'bad_input', 'Empty comment' ); }
		$uid = Rest::uid();
		if ( $err = Verify::require_identity( $uid ) ) { return $err; }
		// Threaded replies: a comment may nest under another comment of the SAME thread — at any depth
		// (Reddit-style). Validate the parent belongs to this thread (else fall back to a root comment)
		// so the tree can't be corrupted.
		$parent = Rest::pint( $req, 'parent', 0 );
		if ( $parent && ! Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_comments' ) . " WHERE id = %d AND context_type = 'thread' AND context_id = %d", [ $parent, $tid ] ) ) {
			$parent = 0;
		}
		// ArtaMod. The /about rule says, without qualification, that when you post a comment it is
		// checked — and this surface did not call the Fearometer at all. The only context that ever
		// wrote a moderation flag was the section board, whose courses were purged in July, so every
		// live discussion board was unscreened while the page promised otherwise.
		//
		// Calling score() is NOT screening. There is no server-side scorer: the paid API was removed
		// (2026-06-13) and the subscription relay scores in batches, so score() answers NULL for
		// every real post and only the test seam ever returns a verdict inline. Reading that null as
		// "clean" is what stored flagged=0 unconditionally on this surface. A null verdict means NOT
		// SCREENED YET, so the comment goes into the moderation queue (modq = 1) and
		// Fearometer::process_queue scores it on the relay — the same path Learn::post_comment uses.
		// Fail-open by design: the comment is visible instantly, and if the relay never comes back it
		// simply stays queued. ArtaMod never blocks posting, it only sets aside.
		$flagged = 0;
		$modq    = 1;
		try {
			if ( class_exists( '\\AQ\\Fearometer' ) && method_exists( '\\AQ\\Fearometer', 'score' ) ) {
				$verdict = Fearometer::score( $body );
				if ( is_array( $verdict ) ) { $flagged = empty( $verdict['flagged'] ) ? 0 : 1; $modq = 0; }
			}
		} catch ( \Throwable $e ) { $flagged = 0; $modq = 1; } // the queue retries; posting never fails
		$id  = Data::insert( 'aq_comments', [
			'context_type' => 'thread', 'context_id' => $tid, 'parent_id' => $parent, 'author_id' => $uid, 'body' => $body,
			'flagged' => $flagged, 'modq' => $modq,
			'lang' => self::lang( $req ), 'created' => Data::now(),
		] );
		if ( $parent ) { Data::bump( 'aq_comments', [ 'id' => $parent ], 'reply_count', 1 ); } // pages "show N more replies"
		Data::bump( 'aq_threads', [ 'id' => $tid ], 'comment_count', 1 );
		// Return the full card (not just the id) so the client appends the REAL row — server-shaped
		// author/avatar/timestamps — instead of fabricating one that drifts from the next reload.
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_comments' ) . ' WHERE id = %d', [ $id ] );
		return [ 'id' => $id, 'card' => $row ? self::comment_card( $row ) : null ];
	}

	/**
	 * POST /vote {target_type:thread|comment, target_id, val:0|1} — idempotent SET (not a toggle:
	 * the client sends the state it wants, so a retried request can never flip a vote). Returns the
	 * AUTHORITATIVE new score read back after the bump — the client reconciles its optimistic count
	 * to it, so concurrent voters never leave a drifted number on screen.
	 *
	 * HEARTS-ONLY (2026-07-10, Creative Challenges): the platform no longer takes downvotes —
	 * val is clamped to {0, 1} (heart / un-heart). Legacy −1 rows persist and age out of season
	 * windows; the SUM(val) scores stay correct throughout.
	 */
	public static function vote( $req ) {
		$uid  = Rest::uid();
		$type = Rest::p( $req, 'target_type', 'thread' ) === 'comment' ? 'comment' : 'thread';
		$tid  = Rest::pint( $req, 'target_id' );
		$val  = Rest::pint( $req, 'val', 1 ) > 0 ? 1 : 0;
		$table = $type === 'comment' ? 'aq_comments' : 'aq_threads';
		$score = $type === 'comment' ? 'votes' : 'vote_score';
		$row = Data::one(
			'SELECT author_id' . ( $type === 'comment' ? ', context_type' : '' ) . ' FROM ' . Data::t( $table ) . ' WHERE id = %d',
			[ $tid ]
		);
		if ( ! $row ) { return Rest::err( 'not_found', 'Target not found', 404 ); }
		// Section (competition) comments are voted ONLY through Learn::vote_comment, which keeps the
		// quester projection in step and tags the vote with course/lesson. Routing a section comment
		// through this generic path would bypass all of that (stale aq_quester, a course_id=0 vote row
		// that drifts the board) — so refuse and point to the proper route.
		if ( $type === 'comment' && $row['context_type'] === 'section' ) {
			return Rest::err( 'wrong_route', 'Use the section board to vote on competition replies.', 400 );
		}
		// Upvotes are peer support — you can't vote on your own post (same rule as the competition).
		if ( (int) $row['author_id'] === $uid ) { return Rest::err( 'self_vote', 'You can’t vote on your own post.', 403 ); }
		$prev = (int) Data::col(
			'SELECT val FROM ' . Data::t( 'aq_votes' ) . ' WHERE user_id = %d AND target_type = %s AND target_id = %d',
			[ $uid, $type, $tid ]
		);
		if ( $prev !== $val ) {
			Data::upsert( 'aq_votes', [ 'user_id' => $uid, 'target_type' => $type, 'target_id' => $tid ], [
				'val' => $val, 'created' => Data::now(),
			] );
			Data::bump( $table, [ 'id' => $tid ], $score, $val - $prev );
		}
		$votes = (int) Data::col( 'SELECT ' . $score . ' FROM ' . Data::t( $table ) . ' WHERE id = %d', [ $tid ] );
		return [ 'ok' => true, 'score_delta' => $val - $prev, 'my_vote' => $val, 'votes' => $votes ];
	}

	/**
	 * GET /votes/{type}/{id} — the transparency roster behind a vote control: everyone who up- or
	 * down-voted a target (a thread head or a comment — section OR public), in the order they cast it,
	 * earliest first. Public by design: the same aq_votes rows are already browsable in /data/, so this
	 * only shapes them into the member cards the hover tooltip renders. Cleared votes (val 0 — the
	 * generic toggle leaves the row behind) are not voters, so they're excluded. Bounded to $max cards
	 * (a viral comment could have millions of votes); `more` flags a capped roster. Anonymous GET, so
	 * the result is edge-cached (see Rest::dispatch) — a hot target's roster is built rarely.
	 */
	public static function voters( $req ) {
		$type = Rest::p( $req, 'type', 'comment' ) === 'thread' ? 'thread' : 'comment';
		$id   = Rest::pint( $req, 'id' );
		if ( ! $id ) { return Rest::err( 'bad_input', 'Invalid target' ); }
		$max  = 500;
		// One indexed lookup on (target_type, target_id), earliest-first; fetch one past the cap so we
		// can report `more` without COUNT-ing a whole viral comment's vote set.
		$rows = Data::all(
			'SELECT user_id, val, created FROM ' . Data::t( 'aq_votes' )
			. ' WHERE target_type = %s AND target_id = %d AND val <> 0 ORDER BY created ASC, user_id ASC LIMIT %d',
			[ $type, $id, $max + 1 ]
		);
		$more = count( $rows ) > $max;
		if ( $more ) { array_pop( $rows ); }
		$up = array(); $down = array();
		foreach ( $rows as $r ) {
			$card = self::voter_card( (int) $r['user_id'], (int) $r['created'] );
			if ( (int) $r['val'] > 0 ) { $up[] = $card; } else { $down[] = $card; }
		}
		return [ 'up' => $up, 'down' => $down, 'more' => $more ];
	}

	/** A member card for the vote-transparency roster — the standard public card shape every list here
	 *  emits, plus the vote time. A deleted account keeps its vote row but ships slug '' (rendered
	 *  unlinked) and the fallback name. */
	private static function voter_card( $uid, $at ) {
		$u = get_userdata( $uid );
		return [
			'name'     => $u ? $u->display_name : 'Quester',
			'slug'     => $u ? $u->user_nicename : '',
			'avatar'   => $u ? Verify::avatar_url( $uid, 48 ) : '',
			'verified' => $u ? Verify::is_verified( $uid ) : false,
			'at'       => (int) $at,
		];
	}

	/** POST /follow {target_id, on} — follow/unfollow another user. */
	public static function follow( $req ) {
		$uid = Rest::uid();
		$tid = Rest::pint( $req, 'target_id' );
		if ( ! $tid || $tid === $uid ) { return Rest::err( 'bad_input', 'Invalid target' ); }
		$on = Rest::pint( $req, 'on', 1 );
		if ( $on ) {
			$new = Data::upsert( 'aq_follows', [ 'follower_id' => $uid, 'target_id' => $tid ], [ 'created' => Data::now() ] );
			if ( $new ) { // only on a genuinely new follow, and once per (follower→target)
				$me = get_userdata( $uid );
				Notify::push( $tid, 'follow', ( $me ? $me->display_name : 'Someone' ) . ' started following you', '', $me ? '/u/' . $me->user_nicename . '/' : '', 'follow' . $uid );
			}
		} else {
			$GLOBALS['wpdb']->delete( Data::t( 'aq_follows' ), [ 'follower_id' => $uid, 'target_id' => $tid ] );
		}
		return [ 'ok' => true, 'following' => (bool) $on ];
	}

	/**
	 * GET /profile/follows?slug=&dir=followers|following&cursor= — the lists behind a profile's
	 * follower/following counts: who follows the member, or who they follow, newest follow first,
	 * as the standard { items, next } keyset page. Public by design — the same aq_follows rows are
	 * browsable in /data/. The table has no surrogate id (PK is follower_id+target_id), so the
	 * cursor rides the follow time; rows sharing the boundary second can be skipped — for a social
	 * list that cosmetic edge beats a composite cursor (the same stance as ::feed's cursor).
	 */
	public static function follows( $req ) {
		$slug = sanitize_title( (string) Rest::p( $req, 'slug', '' ) );
		$u    = $slug ? get_user_by( 'slug', $slug ) : null;
		if ( ! $u ) { return Rest::err( 'not_found', 'Profile not found', 404 ); }
		// followers = rows pointing AT the member (show who cast the follow);
		// following = rows the member created (show who they aimed it at).
		$dir   = Rest::p( $req, 'dir', 'followers' ) === 'following' ? 'following' : 'followers';
		$whose = $dir === 'following' ? 'follower_id' : 'target_id';
		$show  = $dir === 'following' ? 'target_id' : 'follower_id';
		[ $rows, $next ] = Data::page(
			'aq_follows', "$whose = %d", [ (int) $u->ID ],
			Rest::pint( $req, 'cursor', 0 ), Rest::pint( $req, 'limit', 50 ), 'DESC', 'created'
		);
		// Each row is the standard public member card (same fields every card shaper here emits);
		// a deleted account keeps its row but ships slug '' so the client renders it unlinked.
		$items = [];
		foreach ( $rows as $r ) {
			$mid = (int) $r[ $show ];
			$m   = get_userdata( $mid );
			$items[] = [
				'name'     => $m ? $m->display_name : 'Quester',
				'slug'     => $m ? $m->user_nicename : '',
				'avatar'   => $m ? Verify::avatar_url( $mid, 96 ) : '',
				'verified' => $m ? Verify::is_verified( $mid ) : false,
				'at'       => (int) $r['created'],
			];
		}
		return [ 'items' => $items, 'next' => $next ];
	}

	/**
	 * GET /suggest/follow — the feed's "Who to follow" rail: the members whose published notebooks
	 * have earned the most hearts, freshest publisher first among ties. Deliberately UNPERSONALISED
	 * so the GET stays CDN-cacheable (the client drops the viewer + people already followed using
	 * the `followed` ids that GET /feed already ships). Bots (`_aq_is_bot`) and deleted accounts
	 * never surface. One bounded GROUP BY over the (small) published set + one IN() for followers.
	 */
	public static function suggest_follow() {
		$rows = Data::all(
			'SELECT author_id, SUM(hearts) AS hearts, COUNT(*) AS works, MAX(published_at) AS latest FROM '
			. Data::t( 'aq_notebooks' )
			. " WHERE status = 'published' AND author_id > 0"
			. ' GROUP BY author_id ORDER BY hearts DESC, latest DESC LIMIT 20'
		);
		$ids = array_map( static fn( $r ) => (int) $r['author_id'], $rows );
		$followers = [];
		if ( $ids ) {
			$in  = implode( ',', $ids );
			foreach ( Data::all( 'SELECT target_id, COUNT(*) AS n FROM ' . Data::t( 'aq_follows' ) . " WHERE target_id IN ($in) GROUP BY target_id" ) as $f ) {
				$followers[ (int) $f['target_id'] ] = (int) $f['n'];
			}
		}
		$items = [];
		foreach ( $rows as $r ) {
			$mid = (int) $r['author_id'];
			$m   = get_userdata( $mid );
			if ( ! $m || get_user_meta( $mid, '_aq_is_bot', true ) ) { continue; }
			$items[] = [
				'id'        => $mid,
				'name'      => $m->display_name,
				'slug'      => $m->user_nicename,
				'avatar'    => Verify::avatar_url( $mid, 96 ),
				'verified'  => Verify::is_verified( $mid ),
				'hearts'    => (int) $r['hearts'],
				'works'     => (int) $r['works'],
				'followers' => $followers[ $mid ] ?? 0,
			];
			if ( count( $items ) >= 8 ) { break; }
		}
		return [ 'items' => $items ];
	}

	/**
	 * GET /feed?cursor=&limit= — the home-page activity feed: what the people the viewer follows
	 * have been doing, newest first. Four event sources, all existing tables:
	 *   thread                  — started a discussion (aq_threads)
	 *   reply                   — posted on a public board or a section (competition) board (aq_comments)
	 *   upvote / upvote_thread  — upvoted a reply / a discussion (aq_votes, val = +1 only — support, not pile-ons)
	 *   enroll                  — joined a course (aq_enroll)
	 *
	 * Fan-out-on-READ: no feed table to keep in sync, no write amplification on post/vote. Every
	 * query is bounded — the follow list is capped at the newest FOLLOW_CAP follows, each source
	 * contributes at most one page (+1 probe row), and hydration is one IN() batch per entity.
	 * KNOWN SCALE LIMIT: with celebrity-size follow graphs the durable design is a fan-out-on-write
	 * feed projection maintained like aq_quester; revisit when follow counts demand it.
	 *
	 * Keyset cursor on `created` (unix secs, exclusive <) merged across the sources — the standard
	 * { items, next } contract. Events in the same second as a page boundary can be skipped; for a
	 * social feed that cosmetic edge beats a 4-way composite cursor. Everything returned is public
	 * by design (the same rows are browsable in /data/); fear-flagged comments stay on their boards
	 * but are NOT amplified onto home pages (same stance as the competition, which voids their votes).
	 *
	 * Each thread/reply/upvote event also carries `target` — the votable thing it points at —
	 * so the feed can render live thumbs without another round-trip:
	 *   { kind: thread|comment, id, board: thread|section, score, my_vote, mine }
	 * `board` picks the vote route client-side (public POST /vote vs the competition's enrolment-
	 * gated POST /comment/vote — votes cast from the feed go through the SAME guarded endpoints
	 * as the boards themselves); `my_vote` pre-lights the viewer's cast; `mine` marks the viewer's
	 * own posts (rendered static — both boards' UI treats own posts as non-votable). Enrolments
	 * have no votable target (`target` = null).
	 */
	const FOLLOW_CAP = 250;

	public static function feed( $req ) {
		$uid    = Rest::uid();
		$limit  = max( 1, min( 50, Rest::pint( $req, 'limit', 20 ) ) );
		$cursor = Rest::pint( $req, 'cursor', 0 );

		// `following` lets the client tell "follow someone first" apart from "quiet week".
		$following = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_follows' ) . ' WHERE follower_id = %d', [ $uid ] );
		if ( ! $following ) { return [ 'items' => [], 'next' => null, 'following' => 0, 'followed' => [] ]; }
		$ids = array_map( 'intval', array_column( Data::all(
			'SELECT target_id FROM ' . Data::t( 'aq_follows' ) . ' WHERE follower_id = %d ORDER BY created DESC LIMIT %d',
			[ $uid, self::FOLLOW_CAP ]
		), 'target_id' ) );

		$in   = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
		$cut  = $cursor > 0 ? ' AND created < %d' : '';
		$tail = $cursor > 0 ? [ $cursor, $limit + 1 ] : [ $limit + 1 ]; // +1 row probes "is there more?"
		$ev   = [];

		foreach ( Data::all( 'SELECT id, author_id, title, topic, body, vote_score, created FROM ' . Data::t( 'aq_threads' )
			. " WHERE status = 'publish' AND author_id IN ($in)$cut ORDER BY created DESC LIMIT %d",
			array_merge( $ids, $tail ) ) as $t ) {
			$ev[] = [ 'type' => 'thread', 'actor_id' => (int) $t['author_id'], 'at' => (int) $t['created'],
				'title' => (string) $t['title'], 'context' => (string) $t['topic'], 'excerpt' => self::excerpt( $t['body'] ),
				'url' => '/discussions/?forum=' . ( $t['topic'] ?: 'general' ) . '&thread=' . (int) $t['id'],
				'_t' => [ 'kind' => 'thread', 'id' => (int) $t['id'], 'score' => (int) $t['vote_score'], 'author' => (int) $t['author_id'] ] ];
		}
		foreach ( Data::all( 'SELECT id, author_id, context_type, context_id, body, votes, created FROM ' . Data::t( 'aq_comments' )
			. " WHERE flagged = 0 AND author_id IN ($in)$cut ORDER BY created DESC LIMIT %d",
			array_merge( $ids, $tail ) ) as $c ) {
			$ev[] = [ 'type' => 'reply', 'actor_id' => (int) $c['author_id'], 'at' => (int) $c['created'],
				'excerpt' => self::excerpt( $c['body'] ), '_ctx' => (string) $c['context_type'], '_cid' => (int) $c['context_id'],
				'_t' => [ 'kind' => 'comment', 'id' => (int) $c['id'], 'board' => (string) $c['context_type'], 'score' => (int) $c['votes'], 'author' => (int) $c['author_id'] ] ];
		}
		foreach ( Data::all( 'SELECT user_id, target_type, target_id, created FROM ' . Data::t( 'aq_votes' )
			. " WHERE val = 1 AND user_id IN ($in)$cut ORDER BY created DESC LIMIT %d",
			array_merge( $ids, $tail ) ) as $v ) {
			$ev[] = [ 'type' => 'upvote', 'actor_id' => (int) $v['user_id'], 'at' => (int) $v['created'],
				'_vt' => (string) $v['target_type'], '_vid' => (int) $v['target_id'] ];
		}
		foreach ( Data::all( 'SELECT user_id, course_id, created FROM ' . Data::t( 'aq_enroll' )
			. " WHERE user_id IN ($in)$cut ORDER BY created DESC LIMIT %d",
			array_merge( $ids, $tail ) ) as $e ) {
			$ev[] = [ 'type' => 'enroll', 'actor_id' => (int) $e['user_id'], 'at' => (int) $e['created'],
				'_course' => (int) $e['course_id'] ];
		}

		// Merge newest-first and page. More exists iff the merged set overflows the page: any source
		// that returned its full limit+1 probe necessarily pushes the merge past $limit.
		usort( $ev, fn( $a, $b ) => $b['at'] <=> $a['at'] );
		$more = count( $ev ) > $limit;
		$ev   = array_slice( $ev, 0, $limit );
		$next = $more && $ev ? (int) end( $ev )['at'] : null;

		// ── Hydrate the visible page, one IN() batch per entity type ────────────
		// Upvoted comments first — they add thread/lesson contexts to resolve. flagged = 0 here too:
		// an upvote pointing at a fear-flagged reply is dropped with it.
		$cids = array_values( array_unique( array_column( array_filter( $ev, fn( $i ) => $i['type'] === 'upvote' && $i['_vt'] === 'comment' ), '_vid' ) ) );
		$cmap = [];
		if ( $cids ) {
			$p = implode( ',', array_fill( 0, count( $cids ), '%d' ) );
			foreach ( Data::all( 'SELECT id, context_type, context_id, body, votes, author_id FROM ' . Data::t( 'aq_comments' ) . " WHERE flagged = 0 AND id IN ($p)", $cids ) as $c ) {
				$cmap[ (int) $c['id'] ] = $c;
			}
		}
		foreach ( $ev as &$i ) { // resolve upvotes into the same _ctx/_cid shape replies use
			if ( $i['type'] !== 'upvote' ) { continue; }
			if ( $i['_vt'] === 'thread' ) { // a whole-discussion upvote reads differently to a reply upvote
				$i['type'] = 'upvote_thread'; $i['_ctx'] = 'vthread'; $i['_cid'] = $i['_vid']; continue;
			}
			$c = $cmap[ $i['_vid'] ] ?? null;
			if ( $c ) {
				$i['_ctx'] = (string) $c['context_type']; $i['_cid'] = (int) $c['context_id'];
				// Show WHAT was upvoted, and let the viewer pile on (or push back) right from the feed.
				$i['excerpt'] = self::excerpt( $c['body'] );
				$i['_t'] = [ 'kind' => 'comment', 'id' => (int) $c['id'], 'board' => (string) $c['context_type'], 'score' => (int) $c['votes'], 'author' => (int) $c['author_id'] ];
			}
		}
		unset( $i );

		$tids = $lids = $crs = [];
		foreach ( $ev as $i ) {
			$ctx = $i['_ctx'] ?? '';
			if ( $ctx === 'thread' || $ctx === 'vthread' ) { $tids[] = (int) $i['_cid']; }
			if ( $ctx === 'section' ) { $lids[] = (int) $i['_cid']; }
			if ( $i['type'] === 'enroll' ) { $crs[] = (int) $i['_course']; }
		}
		$tmap = $lmap = $crmap = [];
		if ( $tids ) {
			$p = implode( ',', array_fill( 0, count( array_unique( $tids ) ), '%d' ) );
			foreach ( Data::all( 'SELECT id, title, topic, vote_score, author_id FROM ' . Data::t( 'aq_threads' ) . " WHERE status = 'publish' AND id IN ($p)", array_values( array_unique( $tids ) ) ) as $t ) {
				$tmap[ (int) $t['id'] ] = $t;
			}
		}
		if ( $lids ) {
			$p = implode( ',', array_fill( 0, count( array_unique( $lids ) ), '%d' ) );
			foreach ( Data::all( 'SELECT id, course_id, title FROM ' . Data::t( 'aq_lessons' ) . " WHERE id IN ($p)", array_values( array_unique( $lids ) ) ) as $l ) {
				$lmap[ (int) $l['id'] ] = $l;
				$crs[] = (int) $l['course_id'];
			}
		}
		if ( $crs ) {
			$p = implode( ',', array_fill( 0, count( array_unique( $crs ) ), '%d' ) );
			foreach ( Data::all( 'SELECT id, slug, title FROM ' . Data::t( 'aq_courses' ) . " WHERE id IN ($p)", array_values( array_unique( $crs ) ) ) as $c ) {
				$crmap[ (int) $c['id'] ] = $c;
			}
		}

		// Finalize: resolve each event's target into title/context/url; drop events whose target
		// vanished (deleted thread/lesson/course or a flagged reply) — a slightly short page is fine.
		$items = [];
		$actors = [];
		foreach ( $ev as $i ) {
			$ctx = $i['_ctx'] ?? '';
			if ( $ctx === 'thread' || $ctx === 'vthread' ) {
				$t = $tmap[ (int) $i['_cid'] ] ?? null;
				if ( ! $t ) { continue; }
				$i['title']   = (string) $t['title'];
				$i['context'] = (string) $t['topic'];
				$i['url']     = '/discussions/?forum=' . ( $t['topic'] ?: 'general' ) . '&thread=' . (int) $t['id'];
				if ( $ctx === 'vthread' ) { // the votable target of a discussion-upvote is the thread itself
					$i['_t'] = [ 'kind' => 'thread', 'id' => (int) $t['id'], 'score' => (int) $t['vote_score'], 'author' => (int) $t['author_id'] ];
				}
			} elseif ( $ctx === 'section' ) {
				$l = $lmap[ (int) $i['_cid'] ] ?? null;
				$c = $l ? ( $crmap[ (int) $l['course_id'] ] ?? null ) : null;
				if ( ! $l || ! $c ) { continue; }
				$i['title']   = (string) $l['title'];
				$i['context'] = (string) $c['title'];
				$i['url']     = '/video/?video=' . (int) $l['id'];
			} elseif ( $i['type'] === 'enroll' ) {
				$c = $crmap[ (int) $i['_course'] ] ?? null;
				if ( ! $c ) { continue; }
				$i['title']   = (string) $c['title'];
				$i['context'] = '';
				$i['url']     = '/courses/' . $c['slug'];
			} elseif ( $i['type'] !== 'thread' ) {
				continue; // unresolved upvote/reply (target gone) — drop
			}
			$actors[ $i['actor_id'] ] = true;
			$items[] = $i;
		}

		// Actor cards (name/slug/avatar) — get_userdata is per-row like every card shaper here,
		// served from the user cache; the page holds ≤ $limit distinct actors.
		$umap = [];
		foreach ( array_keys( $actors ) as $aid ) {
			$u = get_userdata( $aid );
			$umap[ $aid ] = [
				'name'    => $u ? $u->display_name : 'Quester',
				'slug'    => $u ? $u->user_nicename : '',
				'avatar'  => Verify::avatar_url( $aid, 96 ),
			];
		}
		// The viewer's existing casts on the page's votable targets (one IN() per target type,
		// ≤ $limit ids each) — so the feed's thumbs render pre-lit, exactly like the boards do.
		$my = [ 'thread' => [], 'comment' => [] ];
		$want = [ 'thread' => [], 'comment' => [] ];
		foreach ( $items as $i ) {
			if ( isset( $i['_t'] ) ) { $want[ $i['_t']['kind'] ][] = (int) $i['_t']['id']; }
		}
		foreach ( $want as $kind => $kids ) {
			if ( ! $kids ) { continue; }
			$kids = array_values( array_unique( $kids ) );
			$p    = implode( ',', array_fill( 0, count( $kids ), '%d' ) );
			foreach ( Data::all( 'SELECT target_id, val FROM ' . Data::t( 'aq_votes' ) . " WHERE user_id = %d AND target_type = %s AND target_id IN ($p)", array_merge( [ $uid, $kind ], $kids ) ) as $v ) {
				$my[ $kind ][ (int) $v['target_id'] ] = (int) $v['val'];
			}
		}

		$items = array_map( fn( $i ) => [
			'type'    => $i['type'],
			'actor'   => $umap[ $i['actor_id'] ],
			'title'   => (string) $i['title'],
			'context' => (string) ( $i['context'] ?? '' ),
			'excerpt' => (string) ( $i['excerpt'] ?? '' ),
			'url'     => (string) $i['url'],
			'at'      => (int) $i['at'],
			'target'  => isset( $i['_t'] ) ? [
				'kind'    => (string) $i['_t']['kind'],
				'id'      => (int) $i['_t']['id'],
				'board'   => (string) ( $i['_t']['board'] ?? 'thread' ), // comments: which vote route; threads: always public
				'score'   => (int) $i['_t']['score'],
				'my_vote' => (int) ( $my[ $i['_t']['kind'] ][ (int) $i['_t']['id'] ] ?? 0 ),
				'mine'    => (int) $i['_t']['author'] === $uid,
			] : null,
		], $items );

		// `followed` = who the viewer already follows (the same capped id list the feed reads from) —
		// lets the home rail suggest only NEW people to follow without another round-trip.
		return [ 'items' => $items, 'next' => $next, 'following' => $following, 'followed' => $ids ];
	}

	/** GET /profile?slug= — the PUBLIC view of any member. ArtaQuest is radically transparent: the
	 *  whole DB is public (see Extra::db / /data/), so this mirrors it — identity, email, standing, and
	 *  the wallet (coin) balance are all public. Nothing here is hidden that the data explorer shows. */
	public static function profile( $req ) {
		$slug = sanitize_title( (string) Rest::p( $req, 'slug', '' ) );
		$u    = $slug ? get_user_by( 'slug', $slug ) : null;
		if ( ! $u ) { return Rest::err( 'not_found', 'Profile not found', 404 ); }
		$id     = (int) $u->ID;
		$points = Economy::points_balance( $id );
		$viewer = Rest::uid();

		// Public self-identification tags (stored exactly as the Typology page sends them).
		$tags = get_user_meta( $id, 'aq_typology_tags', true );
		if ( ! is_array( $tags ) ) { $tags = json_decode( (string) $tags, true ) ?: []; }

		// Real, public activity — everything here is an achievement the member chose to make public.
		$stats = [
			'threads'   => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_threads' ) . " WHERE author_id = %d AND status = 'publish'", [ $id ] ),
			'comments'  => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_comments' ) . " WHERE context_type = 'thread' AND author_id = %d", [ $id ] ),
			'reviews'   => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_reviews' ) . ' WHERE user_id = %d', [ $id ] ),
			'enrolled'  => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_enroll' ) . ' WHERE user_id = %d', [ $id ] ),
			'followers' => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_follows' ) . ' WHERE target_id = %d', [ $id ] ),
			'following' => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_follows' ) . ' WHERE follower_id = %d', [ $id ] ),
		];
		$recent = Data::all( 'SELECT id, title, body, topic, comment_count, vote_score, created FROM ' . Data::t( 'aq_threads' ) . " WHERE author_id = %d AND status = 'publish' ORDER BY id DESC LIMIT 5", [ $id ] );

		// Creator rank + the member's published courses — PUBLIC (operator rule 2026-06-12: a
		// creator's courses are visible on their profile; /u/arash owns the whole catalogue).
		$rank    = Extra::creator_rank( $id );
		$ccount  = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_courses' ) . " WHERE author_id = %d AND status = 'publish'", [ $id ] );
		$courses = $ccount ? Data::all(
			'SELECT id, slug, title, image, lesson_count, duration, rank_score FROM ' . Data::t( 'aq_courses' ) .
			" WHERE author_id = %d AND status = 'publish' ORDER BY rank_score DESC, id DESC LIMIT 12",
			[ $id ] ) : [];

		// Courses this member has COMPLETED — earned the certificate (every section engaged → pct
		// reaches PASS). Public, exactly like the `completed` count stat above and aq_enroll in the
		// data explorer: a join from the member's certified enrolments to the published course cards.
		$done = $stats['enrolled'] ? Data::all(
			'SELECT c.id, c.slug, c.title, c.image, c.lesson_count, c.duration, c.rank_score' .
			' FROM ' . Data::t( 'aq_courses' ) . ' c JOIN ' . Data::t( 'aq_enroll' ) . ' e ON e.course_id = c.id' .
			" WHERE e.user_id = %d AND e.pct >= %d AND c.status = 'publish' ORDER BY c.rank_score DESC, c.id DESC LIMIT 12",
			[ $id, Learn::PASS_PCT ] ) : [];

		// Typology TOPICS this member has AUTHORED (aq_topics.author_id) — first-class authored content
		// surfaced on the profile exactly like their courses (#127); distinct from the identity tags
		// above (topics the member SELECTED, #122). Public; newest first, capped at 12 with a total
		// tally — the default creator (/u/arash) authors the whole seeded registry, so this MUST cap
		// like "Courses created" rather than list hundreds of rows. author_id is indexed.
		$tcount = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_topics' ) . ' WHERE author_id = %d AND active = 1', [ $id ] );
		$topics = $tcount ? Data::all(
			'SELECT topic_key, name, category, status, image FROM ' . Data::t( 'aq_topics' ) .
			' WHERE author_id = %d AND active = 1 ORDER BY id DESC LIMIT 12',
			[ $id ] ) : [];

		// Journal of Seasonality articles this member has PUBLISHED (accepted submissions) — public, surfaced
		// on the profile like their courses/topics. Each links to /research/?submission=<id>.
		$rcount = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_submissions' ) . " WHERE author_id = %d AND status = 'accepted'", [ $id ] );
		$research = $rcount ? Data::all(
			'SELECT id, title, doi, colab_url, created FROM ' . Data::t( 'aq_submissions' ) .
			" WHERE author_id = %d AND status = 'accepted' ORDER BY id DESC LIMIT 12",
			[ $id ] ) : [];

		// Books this member has PUBLISHED via ArtaPublishing (their own original works) — public, on the
		// profile, capped + tallied like courses/topics. Each links to /read/<id>.
		$bcount = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_documents' ) . " WHERE author_id = %d AND status = 'published'", [ $id ] );
		$books  = $bcount ? Data::all(
			'SELECT id, slug, title, summary, thumb, pages, view_count, created FROM ' . Data::t( 'aq_documents' ) .
			" WHERE author_id = %d AND status = 'published' ORDER BY id DESC LIMIT 12",
			[ $id ] ) : [];

		// Tracks this member has PUBLISHED via ArtaSound (their own original music) — public. Each → /listen/<id>.
		$mcount = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_tracks' ) . " WHERE author_id = %d AND status = 'published'", [ $id ] );
		$tracks = $mcount ? Data::all(
			'SELECT id, slug, title, summary, cover, seconds, play_count, created FROM ' . Data::t( 'aq_tracks' ) .
			" WHERE author_id = %d AND status = 'published' ORDER BY id DESC LIMIT 12", [ $id ] ) : [];

		// Animations this member has PUBLISHED via ArtaMotion (their own original explainers) — public. Each → /watch/<id>.
		$acount = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_animations' ) . " WHERE author_id = %d AND status = 'published'", [ $id ] );
		$anims  = $acount ? Data::all(
			'SELECT id, slug, title, summary, poster, seconds, play_count, created FROM ' . Data::t( 'aq_animations' ) .
			" WHERE author_id = %d AND status = 'published' ORDER BY id DESC LIMIT 12", [ $id ] ) : [];

		// Films this member has PUBLISHED via ArtaFilm (their own AI text-to-video shorts) — public. Each → /film/<id>.
		$ftable = $GLOBALS['wpdb']->prefix . 'aq_films';
		$fcount = $GLOBALS['wpdb']->get_var( "SHOW TABLES LIKE '{$ftable}'" ) === $ftable
			? (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_films' ) . " WHERE author_id = %d AND status = 'published'", [ $id ] ) : 0;
		$films  = $fcount ? Data::all(
			'SELECT id, slug, title, summary, poster, seconds, play_count, created FROM ' . Data::t( 'aq_films' ) .
			" WHERE author_id = %d AND status = 'published' ORDER BY id DESC LIMIT 12", [ $id ] ) : [];

		// Illustrations this member has PUBLISHED via ArtaIllustration (their own AI-refined artwork,
		// book covers + plates) — public. Each → /illustration/<id>.
		$itable = $GLOBALS['wpdb']->prefix . 'aq_illustrations';
		$icount = $GLOBALS['wpdb']->get_var( "SHOW TABLES LIKE '{$itable}'" ) === $itable
			? (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_illustrations' ) . " WHERE author_id = %d AND status = 'published'", [ $id ] ) : 0;
		$illust = $icount ? Data::all(
			'SELECT id, slug, title, summary, image_url, kind, rounds, view_count, created FROM ' . Data::t( 'aq_illustrations' ) .
			" WHERE author_id = %d AND status = 'published' ORDER BY id DESC LIMIT 12", [ $id ] ) : [];

		// The "/day" badge = the LIVE average of each course's videos' rolling comment rates
		// (Courses::live_rates), NOT the stored rank_score: rank_score is frozen at 0 for 24h after any
		// video edit — and a routine catalogue re-sync freezes nearly every course at once — so reading it
		// dropped the badge from a member's profile cards mid-cooldown even while the videos drew steady
		// discussion (ticket #105). Batched over both lists in one query. (The lists still ORDER BY
		// rank_score — that frozen ranking is fine for ordering; only the displayed rate must be live.)
		$rates = Courses::live_rates( array_merge( array_column( $courses, 'id' ), array_column( $done, 'id' ) ) );
		// One public card shape shared by both course lists (id/slug/title/image/lessons/price/rate).
		$course_card = fn( $c ) => [
			'id' => (int) $c['id'], 'slug' => (string) $c['slug'], 'title' => (string) $c['title'],
			'image' => (string) $c['image'], 'lessons' => (int) $c['lesson_count'],
			'price' => Funds::cost_for_videos( (int) $c['lesson_count'] ), // 1 coin per video, min ₳1 (Funds::course_cost)
			'comments_per_day' => round( ( $rates[ (int) $c['id'] ] ?? 0 ) / 100, 1 ),
		];

		return [
			'id'         => $id,
			'name'       => $u->display_name,
			'slug'       => $u->user_nicename,
			// 320, not 160: the profile header renders this at 96 CSS px, which is 192 device px on a
			// 2x screen and 288 on a 3x — so a 160px source was being UPSCALED on essentially every
			// phone and modern laptop, i.e. the one large picture on the page was the blurriest.
			// Only the gravatar path varies with this number; season sigils are SVG and an uploaded
			// picture is served at its own size, so nothing else pays for it.
			'avatar'     => Verify::avatar_url( $id, 320 ),
			'palm'       => Verify::palm_url( $id ),         // opt-in palm "back photo" → the avatar flips to it (ticket #94)
			'email'      => $u->user_email,                 // public by design (radical transparency)
			'points'     => $points,
			'coins'      => Economy::coin_balance( $id ),   // wallet balance is public, same as /data/
			'tier'       => Economy::tier( $points ),
			'breakdown'  => Economy::points_by_track( $id ),
			'completed'  => Learn::completed_count( $id ),
			'bio'        => (string) get_user_meta( $id, 'description', true ),
			// (object) so an EMPTY set encodes as {} and not []: PHP's empty array is a JSON array, and
			// a consumer typed against a keyed object would be handed a list on exactly the members who
			// have set nothing — which is most of them.
			'links'      => (object) Auth::links( $id ),        // where else this member is, key => https URL
			'relationship' => Auth::relationship( $id ),       // '' = not saying; the profile then renders nothing
			'location'     => Auth::location( $id ),           // what the MEMBER typed; never inferred from an IP
			'birthplace'   => Verify::birthplace( $id ),       // mandatory identity info; self-declared, never inferred
			// RESOLVED here, not in the browser: the page must not depend on window.AQ_I18N being
			// present to name a language it was just handed (see I18n::language_meta).
			'languages'    => array_values( array_filter( array_map(
				static fn( $c ) => I18n::language_meta( $c ),
				Auth::languages( $id )
			) ) ),
			'last_seen'  => Auth::last_seen( $id ),            // UTC midnight of their last active day; 0 = never recorded
			'joined'     => Verify::joined_label( $u->user_registered ), // clamped to the platform launch (ticket #103)
			'verified'   => Verify::is_verified( $id ),         // the blue check
			'full_name'  => Verify::full_name( $id ),           // public (radical transparency)
			'birthday'   => Verify::birthday( $id ),            // public on every profile
			'season'     => Seasons::of_user( $id ),            // the ONE season this member follows (0 = none on record)
			'typologies' => array_values( $tags ),
			'endorsements' => Extra::endorsements_for( $id ),   // public peer-endorsement counts per tag
			'stats'      => $stats,
			// Creator-ladder rank (Creator/Expert/… — distinct from the points `tier` above) +
			// this member's published courses, shown publicly on the profile.
			'creator_tier' => $ccount || $rank['tier']['key'] !== 'quester' ? $rank['tier']['label'] : '',
			'courses_total' => $ccount,
			'courses'    => array_map( $course_card, $courses ),
			// The member's completed (certified) courses — list to match the `completed` count stat.
			'completed_courses' => array_map( $course_card, $done ),
			// Typology topics this member authored (aq_topics.author_id) — public, capped + tallied like
			// the courses above (#127). The card resolves its own profile picture client-side (image, else
			// the on-brand emblem), so we send the raw `image` (often '') exactly as the Topics page does.
			'topics_total'   => $tcount,
			'topics_created' => array_map( fn( $t ) => [
				'key'      => (string) $t['topic_key'],
				'name'     => (string) $t['name'],
				'category' => (string) $t['category'],
				'status'   => (string) $t['status'],
				'image'    => (string) $t['image'],
			], $topics ),
			// Published Journal of Seasonality articles (accepted submissions) — public.
			'research_total'   => $rcount,
			'research'         => array_map( fn( $r ) => [
				'id'        => (int) $r['id'],
				'title'     => (string) $r['title'],
				'doi'       => (string) ( $r['doi'] ?? '' ),
				'colab_url' => (string) ( $r['colab_url'] ?? '' ),
				'created'   => (int) $r['created'],
			], $research ),
			// Books published via ArtaPublishing (author-owned original works).
			'books_total' => $bcount,
			'books'       => array_map( fn( $b ) => [
				'id'      => (int) $b['id'],
				'slug'    => (string) $b['slug'],
				'title'   => (string) $b['title'],
				'summary' => mb_substr( (string) $b['summary'], 0, 160 ),
				'thumb'   => (string) $b['thumb'],
				'pages'   => (int) $b['pages'],
				'views'   => (int) $b['view_count'],
				'created' => (int) $b['created'],
			], $books ),
			// Tracks published via ArtaSound (author-owned original music).
			'tracks_total' => $mcount,
			'tracks'       => array_map( fn( $t ) => [
				'id'      => (int) $t['id'],
				'slug'    => (string) $t['slug'],
				'title'   => (string) $t['title'],
				'summary' => mb_substr( (string) $t['summary'], 0, 160 ),
				'cover'   => (string) $t['cover'],
				'seconds' => (int) $t['seconds'],
				'plays'   => (int) $t['play_count'],
				'created' => (int) $t['created'],
			], $tracks ),
			// Animations published via ArtaMotion (author-owned original explainers).
			'animations_total' => $acount,
			'animations'       => array_map( fn( $a ) => [
				'id'      => (int) $a['id'],
				'slug'    => (string) $a['slug'],
				'title'   => (string) $a['title'],
				'summary' => mb_substr( (string) $a['summary'], 0, 160 ),
				'poster'  => (string) $a['poster'],
				'seconds' => (int) $a['seconds'],
				'plays'   => (int) $a['play_count'],
				'created' => (int) $a['created'],
			], $anims ),
			'films_total' => $fcount,
			'films'       => array_map( fn( $f ) => [
				'id'      => (int) $f['id'],
				'slug'    => (string) $f['slug'],
				'title'   => (string) $f['title'],
				'summary' => mb_substr( (string) $f['summary'], 0, 160 ),
				'poster'  => (string) $f['poster'],
				'seconds' => (int) $f['seconds'],
				'plays'   => (int) $f['play_count'],
				'created' => (int) $f['created'],
			], $films ),
			// Illustrations published via ArtaIllustration (author-owned AI-refined artwork).
			'illustrations_total' => $icount,
			'illustrations'       => array_map( fn( $i ) => [
				'id'      => (int) $i['id'],
				'slug'    => (string) $i['slug'],
				'title'   => (string) $i['title'],
				'summary' => mb_substr( (string) $i['summary'], 0, 160 ),
				'image'   => (string) $i['image_url'],
				'kind'    => (string) $i['kind'],
				'rounds'  => (int) $i['rounds'],
				'views'   => (int) $i['view_count'],
				'created' => (int) $i['created'],
			], $illust ),
			'is_following' => ( $viewer && $viewer !== $id ) ? (bool) Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_follows' ) . ' WHERE follower_id = %d AND target_id = %d', [ $viewer, $id ] ) : false,
			'recent_threads' => array_map( fn( $t ) => [
				'id' => (int) $t['id'], 'title' => $t['title'], 'comments' => (int) $t['comment_count'],
				'score' => (int) $t['vote_score'], 'at' => (int) $t['created'],
				'topic' => (string) $t['topic'], 'excerpt' => self::excerpt( $t['body'] ),
			], $recent ),
		];
	}

	/** A short, plain-text preview of a thread body (HTML stripped, whitespace collapsed) for the
	 *  profile's discussion cards — gives each row a "reply preview" instead of a bare title. */
	private static function excerpt( $body, $n = 160 ) {
		$t = trim( preg_replace( '/\s+/', ' ', wp_strip_all_tags( (string) $body ) ) );
		return mb_strlen( $t ) <= $n ? $t : rtrim( mb_substr( $t, 0, $n ) ) . '…';
	}

	// ── edit / delete (author only — see owns()) ────────────────────────────
	/** POST /threads/{id}/update {title, body} — edit your own thread. */
	public static function thread_update( $req ) {
		$id = Rest::pint( $req, 'id' );
		$t  = Data::one( 'SELECT author_id FROM ' . Data::t( 'aq_threads' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $t ) { return Rest::err( 'not_found', 'Thread not found', 404 ); }
		if ( ! self::owns( (int) $t['author_id'] ) ) { return Rest::err( 'forbidden', 'Not your thread', 403 ); }
		$title = sanitize_text_field( (string) Rest::p( $req, 'title', '' ) );
		$body  = wp_kses_post( (string) Rest::p( $req, 'body', '' ) );
		if ( $title === '' ) { return Rest::err( 'bad_input', 'Title required' ); }
		Data::update( 'aq_threads', [ 'title' => $title, 'body' => $body, 'edited' => 1 ], [ 'id' => $id ] );
		return [ 'ok' => true, 'id' => (string) $id, 'title' => $title, 'body_html' => $body ];
	}

	/** POST /threads/{id}/delete — delete your own thread and its comments. */
	public static function thread_delete( $req ) {
		global $wpdb;
		$id = Rest::pint( $req, 'id' );
		$t  = Data::one( 'SELECT author_id FROM ' . Data::t( 'aq_threads' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $t ) { return Rest::err( 'not_found', 'Thread not found', 404 ); }
		if ( ! self::owns( (int) $t['author_id'] ) ) { return Rest::err( 'forbidden', 'Not your thread', 403 ); }
		// Take the vote rows with the content they pointed at (the comments first — the IN() needs them
		// still present), so /data/ never accumulates votes aimed at nothing.
		$wpdb->query( $wpdb->prepare(
			'DELETE FROM ' . Data::t( 'aq_votes' ) . " WHERE target_type = 'comment' AND target_id IN ( SELECT id FROM " . Data::t( 'aq_comments' ) . " WHERE context_type = 'thread' AND context_id = %d )",
			$id
		) );
		$wpdb->delete( Data::t( 'aq_votes' ), [ 'target_type' => 'thread', 'target_id' => $id ] );
		$wpdb->delete( Data::t( 'aq_comments' ), [ 'context_type' => 'thread', 'context_id' => $id ] );
		$wpdb->delete( Data::t( 'aq_threads' ), [ 'id' => $id ] );
		return [ 'ok' => true, 'id' => (string) $id, 'redirect' => '/discussions/' ];
	}

	/** POST /comments/{id}/update {body} — edit your own comment. */
	public static function comment_update( $req ) {
		$id = Rest::pint( $req, 'id' );
		$c  = Data::one( 'SELECT author_id FROM ' . Data::t( 'aq_comments' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $c ) { return Rest::err( 'not_found', 'Comment not found', 404 ); }
		if ( ! self::owns( (int) $c['author_id'] ) ) { return Rest::err( 'forbidden', 'Not your comment', 403 ); }
		$body = wp_kses_post( (string) Rest::p( $req, 'body', '' ) );
		if ( trim( $body ) === '' ) { return Rest::err( 'bad_input', 'Empty comment' ); }
		Data::update( 'aq_comments', [ 'body' => $body, 'edited' => 1 ], [ 'id' => $id ] );
		return [ 'ok' => true, 'id' => (string) $id, 'body_html' => $body ];
	}

	/** POST /comments/{id}/delete — delete your own comment. A comment that has replies is SOFT-deleted
	 *  (author zeroed, body blanked → renders as "[deleted]") so its subtree stays readable, Reddit-style;
	 *  a leaf is hard-deleted with its vote rows + counters. */
	public static function comment_delete( $req ) {
		global $wpdb;
		$id = Rest::pint( $req, 'id' );
		$c  = Data::one( 'SELECT author_id, context_type, context_id, course_id, parent_id, reply_count FROM ' . Data::t( 'aq_comments' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $c ) { return Rest::err( 'not_found', 'Comment not found', 404 ); }
		if ( ! self::owns( (int) $c['author_id'] ) ) { return Rest::err( 'forbidden', 'Not your comment', 403 ); }
		if ( (int) $c['reply_count'] > 0 ) {
			// Soft: the placeholder still occupies its slot in the tree (and in comment_count), its
			// replies keep rendering. Votes pointing at it are dropped with the content; for a section
			// comment the author's quester bucket is refreshed AFTER authorship is zeroed, so those
			// upvotes leave the competition standing too.
			Data::update( 'aq_comments', [ 'author_id' => 0, 'body' => '' ], [ 'id' => $id ] );
			$wpdb->delete( Data::t( 'aq_votes' ), [ 'target_type' => 'comment', 'target_id' => $id ] );
			Data::update( 'aq_comments', [ 'votes' => 0 ], [ 'id' => $id ] );
			if ( $c['context_type'] === 'section' ) { Economy::quester_touch( (int) $c['course_id'], (int) $c['author_id'] ); }
			return [ 'ok' => true, 'id' => (string) $id, 'soft' => true ];
		}
		$wpdb->delete( Data::t( 'aq_comments' ), [ 'id' => $id ] );
		$wpdb->delete( Data::t( 'aq_votes' ), [ 'target_type' => 'comment', 'target_id' => $id ] );
		if ( (int) $c['parent_id'] > 0 ) { Data::bump( 'aq_comments', [ 'id' => (int) $c['parent_id'] ], 'reply_count', -1 ); }
		// Decrement the RIGHT denormalized total for the comment's board, and for a section comment also
		// refresh the author's quester bucket (its votes leave the competition). Previously this always
		// decremented aq_threads even for section comments, whose context_id is a lesson — a latent bug.
		if ( $c['context_type'] === 'section' ) {
			Data::bump( 'aq_lessons', [ 'id' => (int) $c['context_id'] ], 'comment_count', -1 );
			YouTube::recompute_course_trend( (int) $c['course_id'] ); // comment-based trending follows the removed comment
			Economy::quester_touch( (int) $c['course_id'], (int) $c['author_id'] );
		} else {
			Data::bump( 'aq_threads', [ 'id' => (int) $c['context_id'] ], 'comment_count', -1 );
		}
		return [ 'ok' => true, 'id' => (string) $id, 'soft' => false ];
	}

	/**
	 * GET /typology/targets — communities members self-identify with, for the donation
	 * picker. Aggregated from the public `aq_typology_tags` user meta (each tag's stable
	 * `systemKey`/`key` + its human `system`/`label` wording, as Extra::typologies_save persisted it);
	 * returns the top types per system + coins raised toward each. Empty until members self-ID.
	 */
	public static function typology_targets( $req ) {
		global $wpdb;
		// The aggregation below walks every member's tag meta — O(members who self-ID'd) per compute.
		// A short server cache bounds how often that scan runs (the payload is slow-changing aggregate
		// stats; 10 min staleness is invisible). KNOWN SCALE LIMIT: at very large member counts even one
		// scan per TTL is too much — the durable fix is a per-(system,type) count projection bumped in
		// Extra::typologies_save (the single write choke point), kept like the fund counters.
		$cached = get_transient( 'aq_typology_targets' );
		if ( is_array( $cached ) ) { return $cached; }
		$rows = $wpdb->get_col( "SELECT meta_value FROM {$wpdb->usermeta} WHERE meta_key = 'aq_typology_tags'" );
		$sys  = [];
		foreach ( $rows as $raw ) {
			$tags = maybe_unserialize( $raw );
			if ( ! is_array( $tags ) ) { $tags = json_decode( (string) $raw, true ); }
			if ( ! is_array( $tags ) ) { continue; }
			foreach ( $tags as $tag ) {
				// Read the tag EXACTLY as the SPA persisted it (Extra::typologies_save stores the resolved
				// TypologyTag: { system:<readable name>, systemKey:<stable key>, category, key, label, short }).
				// The old code grouped by sanitize_key() of the readable `system` NAME — turning
				// "Myers-Briggs Type Indicator (MBTI)" into "myersbriggstypeindicatormbti" — and then showed
				// ucfirst() of that slug as the chip label (the raw-slug chips, #151). Group by the STABLE
				// systemKey and display the human `system` name. (`system_key`/`system` are legacy fallbacks.)
				$skey = sanitize_key( $tag['systemKey'] ?? ( $tag['system_key'] ?? ( $tag['system'] ?? '' ) ) );
				$tkey = sanitize_key( $tag['key'] ?? ( $tag['type'] ?? '' ) );
				if ( ! $skey || ! $tkey ) { continue; }
				$sys[ $skey ]['name'] = $tag['system'] ?? ( $tag['system_label'] ?? ( $tag['system_name'] ?? ucwords( str_replace( [ '-', '_' ], ' ', $skey ) ) ) );
				$sys[ $skey ]['cat']  = $tag['category'] ?? '';
				$sys[ $skey ]['types'][ $tkey ]['label'] = $tag['label'] ?? $tkey;
				$sys[ $skey ]['types'][ $tkey ]['short'] = $tag['short'] ?? ( $tag['label'] ?? $tkey );
				$sys[ $skey ]['types'][ $tkey ]['count'] = ( $sys[ $skey ]['types'][ $tkey ]['count'] ?? 0 ) + 1;
			}
		}
		$out = [];
		foreach ( $sys as $skey => $s ) {
			$types = [];
			foreach ( $s['types'] as $tkey => $t ) {
				// Counter projection (clamped exactly like Funds::fund_append clamps the bucket), never a
				// SUM over the donation ledger per cause.
				$raised = Economy::counter( 'fund_' . substr( 'typ_' . $skey . '_' . $tkey, 0, 24 ) );
				$types[] = [ 'key' => $tkey, 'label' => $t['label'], 'short' => $t['short'], 'count' => (int) $t['count'], 'raised' => (int) round( $raised / 100 ) ];
			}
			usort( $types, fn( $a, $b ) => $b['count'] - $a['count'] );
			$out[] = [ 'key' => $skey, 'name' => $s['name'], 'category' => $s['cat'], 'total' => array_sum( array_column( $types, 'count' ) ), 'types' => array_slice( $types, 0, 10 ) ];
		}
		$payload = [ 'systems' => $out, 'symbol' => '₳' ];
		set_transient( 'aq_typology_targets', $payload, 10 * MINUTE_IN_SECONDS );
		return $payload;
	}

	// ── shaping ─────────────────────────────────────────────────────────────
	/** May the CURRENT user edit/delete this row — TRUE AUTHORSHIP ONLY. No administrator escape:
	 *  ticket #65 — Edit/Delete (the controls AND the permission) belong to the author of a post or
	 *  reply alone. Operators moderate through ArtaMod's set-aside flags, never by rewriting or
	 *  removing a member's words. (Soft-deleted rows have author_id 0 and can never match — the
	 *  'user' route auth guarantees Rest::uid() > 0 here.) */
	private static function owns( $author_id ) {
		return $author_id === Rest::uid();
	}
	/** The thread list-card shape. Public so the unified Search::all returns identical rows. */
	public static function thread_card( $t ) {
		$u = get_userdata( (int) $t['author_id'] );
		return [
			'id'       => (int) $t['id'],
			'title'    => $t['title'],
			'topic'    => $t['topic'],
			'lang'     => $t['lang'],
			'author'   => $u ? $u->display_name : 'Quester',
			'slug'     => $u ? $u->user_nicename : '',
			'avatar'   => Verify::avatar_url( (int) $t['author_id'], 48 ),
			'mine'     => (int) $t['author_id'] === Rest::uid(), // strict authorship (drives the no-self-vote state)
			'edited'   => ! empty( $t['edited'] ),
			'comments' => (int) $t['comment_count'],
			'score'    => (int) $t['vote_score'],
			'at'       => (int) $t['created'],
		];
	}
	private static function comment_card( $c, $myvotes = [] ) {
		$deleted = (int) $c['author_id'] === 0; // soft-deleted (author zeroed, body blanked) — placeholder row
		$u = $deleted ? null : get_userdata( (int) $c['author_id'] );
		return [
			'id'      => (int) $c['id'],
			'parent'  => (int) ( $c['parent_id'] ?? 0 ),
			'body'    => $deleted ? '' : $c['body'],
			'lang'    => $c['lang'],
			'author'  => $deleted ? '[deleted]' : ( $u ? $u->display_name : 'Quester' ),
			'slug'    => $u ? $u->user_nicename : '',
			'avatar'  => $deleted ? '' : Verify::avatar_url( (int) $c['author_id'], 48 ),
			'mine'    => ! $deleted && (int) $c['author_id'] === Rest::uid(), // strict authorship
			'score'   => (int) $c['votes'],
			'replies' => (int) ( $c['reply_count'] ?? 0 ),
			'edited'  => ! empty( $c['edited'] ),
			'deleted' => $deleted,
			// ArtaMod's verdict. Without this the flag is stored and never seen: CommentThread.tsx
			// renders the "Set aside · ArtaMod" pill on exactly this field, so omitting it made the
			// whole check invisible on the discussion boards even once it started running.
			'flagged' => ! empty( $c['flagged'] ),
			'my_vote' => $myvotes[ (int) $c['id'] ] ?? 0,
			'at'      => (int) $c['created'],
		];
	}
	private static function lang( $req ) {
		$l = sanitize_text_field( (string) Rest::p( $req, 'lang', 'en' ) );
		return preg_match( '/^[a-z]{2,3}(-[a-z]{2,4})?$/i', $l ) ? strtolower( $l ) : 'en';
	}
}
