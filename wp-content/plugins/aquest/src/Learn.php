<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * The learning surface. The pedagogy here is discussion-first, not quiz-first:
 *
 *   - There are NO right/wrong answers. Each video SECTION (lesson) has its own DISCUSSION
 *     BOARD. To engage a section a learner WATCHES it, leaves a COMMENT, and UPVOTES at least
 *     one other learner's comment (relaxed only when they're the first/alone — nothing to vote).
 *   - A section is PLAYED FULLY to unlock the next one (aq_progress.done = watched the whole
 *     segment). Sequential gating — section N unlocks when section N-1 is watched.
 *   - The CERTIFICATE requires every section ENGAGED (watched + commented + upvoted). So
 *     `aq_enroll.pct` = (sections engaged) / (total sections).
 *   - The COMPETITION ranks questers by the total UPVOTES their comments earn that season
 *     across the course → the rankings + the 80%-of-revenue podium (Economy::settle_course_rewards).
 *
 * Every write is idempotent (keyed by user+object) so retries never duplicate.
 */
final class Learn {

	/** Certificate = 100% of sections engaged (watched + commented + upvoted-one-other). */
	const PASS_PCT = 100;
	/** A comment must be at least this many characters — blocks empty/blank, allows brief takeaways. */
	const MIN_COMMENT = 3;

	/** Watch-gate (anti-cheat): a section counts as WATCHED only when the learner has genuinely
	 *  progressed through it. The client reports its real playback position; the server credits
	 *  watched-seconds but NEVER faster than wall-clock × WATCH_MAX_SPEED (so seeking to the end or
	 *  scripting `done` can't skip the video), and the section is watched at WATCH_FRACTION of its
	 *  length. Net effect: you cannot complete a course faster than ~half its real running time. */
	const WATCH_FRACTION  = 0.9; // must reach 90% of the section's length
	const WATCH_MAX_SPEED = 2.0; // credited progress ≤ real elapsed × this (allows ≤2× playback; blocks skipping)
	const WATCH_SLACK     = 2;   // seconds of leeway (player boot / ping cadence)
	const WATCH_FLOOR     = 20;  // unknown-length fallback: min seconds of real watching before it counts

	/** Courses this user has earned the certificate for (every section engaged). */
	public static function completed_count( $uid ) {
		if ( ! (int) $uid ) { return 0; }
		return (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_enroll' ) . ' WHERE user_id = %d AND pct >= %d', [ (int) $uid, self::PASS_PCT ] );
	}

	/** POST /enroll {course_id} */
	public static function enroll( $req ) {
		if ( Rest::throttle( 'enroll', 30, 600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		$cid = Rest::pint( $req, 'course_id' );
		if ( ! self::course_exists( $cid ) ) { return Rest::err( 'not_found', 'Course not found', 404 ); }
		$err = self::require_enrolled( $uid, $cid );
		if ( $err ) { return $err; }
		return [ 'ok' => true, 'enrolled' => true ];
	}

	/**
	 * POST /progress {lesson_id, at} — heartbeat the learner's playback position (`at` = seconds into
	 * the section) while the video plays. The server tracks watched-seconds and decides `done` ITSELF
	 * — the client can no longer assert completion. A section is WATCHED (done=1) once credited
	 * watched-seconds reach WATCH_FRACTION of the section length.
	 *
	 * ANTI-CHEAT: credited progress can never exceed `(now − started) × WATCH_MAX_SPEED + slack`, so
	 * seeking to the end, or scripting the endpoint with a huge `at`, yields almost nothing — you must
	 * spend real time. Watched is monotonic (re-watching/seeking back never lowers it). Videos are NEVER
	 * locked: any section can be watched (and skipped to) in any order — the watch-time measurement only
	 * decides whether a section counts toward the certificate, it never blocks playback.
	 */
	public static function progress( $req ) {
		$uid = Rest::uid();
		$lid = Rest::pint( $req, 'lesson_id' );
		$l   = Data::one( 'SELECT id, course_id, seg_start, seg_end, duration FROM ' . Data::t( 'aq_lessons' ) . ' WHERE id = %d', [ $lid ] );
		if ( ! $l ) { return Rest::err( 'not_found', 'Video not found', 404 ); }
		$cid = (int) $l['course_id'];
		$err = self::require_enrolled( $uid, $cid ); // entry fee is charged on first enrol (or via a bursary)
		if ( $err ) { return $err; }

		$len = max( 0, (int) $l['seg_end'] - (int) $l['seg_start'] );
		if ( ! $len ) { $len = (int) $l['duration']; } // fall back to whole-video duration if no segment
		$now = Data::now();
		$at  = max( 0, Rest::pint( $req, 'at', 0 ) );      // reported playback position, seconds into the section
		if ( $len > 0 ) { $at = min( $at, $len ); }

		$row     = Data::one( 'SELECT watched, started, done FROM ' . Data::t( 'aq_progress' ) . ' WHERE user_id = %d AND lesson_id = %d', [ $uid, $lid ] );
		$watched = (int) ( $row['watched'] ?? 0 );
		$started = (int) ( $row['started'] ?? 0 ) ?: $now;  // first heartbeat anchors the clock
		$wasDone = (int) ( $row['done'] ?? 0 );

		// Credit forward progress, but never beyond what real elapsed time allows (caps seek/instant-skip).
		$cap     = (int) floor( ( $now - $started ) * self::WATCH_MAX_SPEED ) + self::WATCH_SLACK;
		$watched = max( $watched, min( $at, $cap ) );

		$need = $len > 0 ? (int) floor( $len * self::WATCH_FRACTION ) : 0;
		$done = $len > 0 ? ( $watched >= $need ? 1 : 0 ) : ( ( $now - $started ) >= self::WATCH_FLOOR ? 1 : 0 );
		$done = ( $done || $wasDone ) ? 1 : 0; // monotonic — once watched, stays watched

		Data::upsert( 'aq_progress', [ 'user_id' => $uid, 'lesson_id' => $lid ], [
			'course_id' => $cid,
			'watched'   => $watched,
			'started'   => $started,
			'done'      => $done,
			'updated'   => $now,
		] );
		$pct = self::recompute_pct( $uid, $cid );
		if ( $done && $pct >= self::PASS_PCT ) { Economy::settle_course_rewards( $cid ); }
		return [ 'ok' => true, 'done' => (bool) $done, 'watched' => $watched, 'need' => $need, 'len' => $len, 'pct' => $pct ];
	}

	/**
	 * POST /section/comment {lesson_id, body, parent_id?} — post a comment (or threaded reply) to a
	 * section's discussion board. The first comment a learner leaves in a section earns 1 learn point
	 * (engagement). Recomputes course % — engaging the final section can complete the certificate.
	 */
	public static function post_comment( $req ) {
		if ( Rest::throttle( 'sc_comment', 30, 600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = Rest::uid();
		if ( $err = Verify::require_identity( $uid ) ) { return $err; }
		$lid  = Rest::pint( $req, 'lesson_id' );
		$body = trim( (string) Rest::p( $req, 'body', '' ) );
		$l    = Data::one( 'SELECT id, course_id FROM ' . Data::t( 'aq_lessons' ) . ' WHERE id = %d', [ $lid ] );
		if ( ! $l ) { return Rest::err( 'not_found', 'Video not found', 404 ); }
		if ( mb_strlen( $body ) < self::MIN_COMMENT ) { return Rest::err( 'too_short', 'Write a comment first (a few words).' ); }
		$body = wp_kses_post( $body );
		$cid  = (int) $l['course_id'];
		$err = self::require_enrolled( $uid, $cid );
		if ( $err ) { return $err; }
		// Enrolment is the only write gate (universal discussions): an enrolled member may post to any
		// of the course's section boards. Watch-order still governs certificate progress (progress_map),
		// but no longer blocks the discussion itself.

		// A reply must point at a real top-level comment in the same section. Unified board:
		// aq_comments with context_type='section', context_id=lesson id.
		$parent = Rest::pint( $req, 'parent_id', 0 );
		if ( $parent ) {
			$p = Data::one( 'SELECT id, context_id, parent_id FROM ' . Data::t( 'aq_comments' ) . " WHERE id = %d AND context_type = 'section'", [ $parent ] );
			if ( ! $p || (int) $p['context_id'] !== $lid || (int) $p['parent_id'] !== 0 ) { return Rest::err( 'bad_parent', 'That comment can’t be replied to.' ); }
		}

		$first = ! Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_comments' ) . " WHERE context_type = 'section' AND author_id = %d AND context_id = %d", [ $uid, $lid ] );
		// Timestamp anchor (optional): the reply references a moment in the video — the board renders
		// it as a chapter chip. Clamped to a sane range; 0 = unanchored.
		$anchor = max( 0, min( 86400, Rest::pint( $req, 'anchor', 0 ) ) );
		// ARTAMOD — every competition comment is QUEUED for moderation (modq=1) rather than screened
		// inline. Moderation runs on the Claude Max SUBSCRIPTION only (the paid API was removed,
		// 2026-06-13): the aq_moderate cron hands the queue to the relay (Fearometer::process_queue),
		// which flags hate/fear comments + leaves ArtaBot's consoling reply. Fail-open by design — a
		// just-posted comment is visible immediately and simply un-moderated until the relay processes
		// it; if the relay is offline the comment just stays queued (never blocks a member, no API).
		$id = Data::insert( 'aq_comments', [
			'context_type' => 'section', 'context_id' => $lid, 'course_id' => $cid, 'author_id' => $uid, 'parent_id' => $parent,
			'body' => $body, 'lang' => 'en', 'votes' => 0, 'reply_count' => 0, 'anchor' => $anchor, 'modq' => 1, 'created' => Data::now(),
		] );
		if ( $parent ) { Data::bump( 'aq_comments', [ 'id' => $parent ], 'reply_count', 1 ); } // denorm for "N more replies"
		Data::bump( 'aq_lessons', [ 'id' => $lid ], 'comment_count', 1 ); // denorm section total (board header reads this, not COUNT(*))
		YouTube::recompute_course_trend( $cid ); // comment-based trending: this section's discussion just moved the course's avg
		if ( $first ) { Economy::award_points( $uid, 1, 'learn', 'sc' . $lid ); } // engagement point, once per section

		// Maintain the author's per-season quester bucket. Scoped to this one author — the competition
		// board then reads a top-N. (If moderation later flags this comment, process_queue re-touches.)
		Economy::quester_touch( $cid, $uid );

		$pct = self::recompute_pct( $uid, $cid );
		if ( $pct >= self::PASS_PCT ) { Economy::settle_course_rewards( $cid ); }
		// Ship the full shaped card so the client can append the REAL row in place (no board refetch).
		$row  = Data::one( 'SELECT * FROM ' . Data::t( 'aq_comments' ) . ' WHERE id = %d', [ $id ] );
		$card = $row ? self::shape_comment( $row, $uid ) : null;
		return [ 'ok' => true, 'id' => (int) $id, 'pct' => $pct, 'first' => $first, 'flagged' => $flagged, 'card' => $card ];
	}

	const PAGE_TOP    = 20; // top-level comments per page (keyset-paginated, Reddit-style)
	const PAGE_REPLY  = 10; // replies loaded inline per parent (the rest via ?parent=)

	/** ONE section-comment row shape — shared by the board read and post_comment's returned card. */
	/**
	 * Seed a section board with ONE ArtaBot starter — idempotent (skips a board that already has an
	 * ArtaBot root comment). When a top YouTube comment is supplied ($tc from YouTube::top_comment) the
	 * seed REFERENCES it: ArtaBot frames it as a conversation-starter EXAMPLE ("feel free to ignore it")
	 * and the original commenter is credited via the `ref` block (their profile name + picture + live
	 * thumbs-up), rendered as a "from YouTube" card on the board. No top comment (comments off / API
	 * unavailable / the channel's own) → a generic starter question. No points; competition untouched.
	 */
	public static function seed_board( $lid, $cid, $tc = null ) {
		$bot = Assistant::bot_user_id();
		if ( ! $bot ) { return false; }
		// idempotent: one ArtaBot starter per board (root-level). A member-only board (no bot root) re-seeds.
		if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_comments' ) . " WHERE context_type = 'section' AND context_id = %d AND author_id = %d AND parent_id = 0 LIMIT 1", [ $lid, $bot ] ) ) { return false; }
		$ref = null;
		if ( is_array( $tc ) && trim( (string) ( $tc['text'] ?? '' ) ) !== '' ) {
			$body = "Here’s the top comment on this video — just to get us started 💬 It’s only an example: feel free to ignore it and share what *you* took from the video.";
			$ref  = wp_json_encode( [
				'kind'   => 'yt',
				'author' => (string) ( $tc['author'] ?? '' ),
				'avatar' => (string) ( $tc['avatar'] ?? '' ),
				'likes'  => (int) ( $tc['likes'] ?? 0 ),
				'text'   => (string) ( $tc['text'] ?? '' ),
				'url'    => (string) ( $tc['url'] ?? '' ),
			] );
		} else {
			$title = (string) Data::col( 'SELECT title FROM ' . Data::t( 'aq_lessons' ) . ' WHERE id = %d', [ $lid ] );
			$pool  = [
				'What’s one idea in “%s” that surprised you — or that you’d push back on? There are no right answers here.',
				'If you had to explain “%s” to a friend in two sentences, what would you keep and what would you leave out?',
				'What did “%s” leave unanswered for you? The sharpest questions tend to win the season.',
				'Where does “%s” connect with something you already knew — or contradict it?',
				'What would you ask the maker of “%s” if they joined this discussion?',
			];
			$body = sprintf( $pool[ $lid % count( $pool ) ], $title );
		}
		Data::insert( 'aq_comments', [
			'context_type' => 'section', 'context_id' => $lid, 'course_id' => $cid, 'author_id' => $bot,
			'parent_id' => 0, 'body' => $body, 'ref' => $ref,
			'lang' => 'en', 'votes' => 0, 'reply_count' => 0, 'created' => Data::now(),
		] );
		Data::bump( 'aq_lessons', [ 'id' => $lid ], 'comment_count', 1 );
		return true;
	}

	/**
	 * Bulk discussion seeder (cron aq_seed_boards + the one-time backfill): seed up to $limit section
	 * boards that have a video but no ArtaBot starter yet, each with the video's top YouTube comment.
	 * top_comment is cached per DISTINCT video so a video reused across sections costs one API call.
	 * Returns the number of boards seeded this run (0 when the queue is drained).
	 */
	public static function seed_pending( $limit = 20 ) {
		$bot = Assistant::bot_user_id();
		if ( ! $bot || ! YouTube::enabled() ) { return 0; }
		$rows = Data::all(
			'SELECT l.id, l.course_id, l.video FROM ' . Data::t( 'aq_lessons' ) . " l
			  WHERE l.video <> ''
			    AND NOT EXISTS (SELECT 1 FROM " . Data::t( 'aq_comments' ) . " c
			         WHERE c.context_type = 'section' AND c.context_id = l.id AND c.author_id = %d AND c.parent_id = 0)
			  ORDER BY l.id ASC LIMIT %d",
			[ $bot, max( 1, (int) $limit ) ] );
		if ( ! $rows ) { return 0; }
		$cache = []; $done = 0;
		foreach ( $rows as $r ) {
			$vid = (string) $r['video'];
			if ( ! array_key_exists( $vid, $cache ) ) { $cache[ $vid ] = YouTube::top_comment( $vid ); }
			if ( self::seed_board( (int) $r['id'], (int) $r['course_id'], $cache[ $vid ] ) ) { $done++; }
		}
		return $done;
	}

	public static function shape_comment( $r, $uid, $myvotes = [] ) {
		$u = get_userdata( (int) $r['author_id'] );
		return [
			'id'      => (int) $r['id'],
			'parent'  => (int) $r['parent_id'],
			'body'    => (string) $r['body'],
			'votes'   => (int) $r['votes'],                       // net score (up − down)
			'my_vote' => $myvotes[ (int) $r['id'] ] ?? 0,         // 1 | 0 | -1
			'replies' => (int) $r['reply_count'],
			'flagged' => ! empty( $r['flagged'] ),                // ArtaMod: set aside from the competition
			'appealed' => ! empty( $r['appealed'] ),              // the one ArtaMod appeal was used
			'anchor'  => (int) ( $r['anchor'] ?? 0 ),             // seconds into the video (0 = unanchored)
			'bot'     => (int) $r['author_id'] === Assistant::bot_user_id(), // ArtaBot's own reply
			'mine'    => (int) $r['author_id'] === $uid,
			'author'  => $u ? $u->display_name : 'Quester',
			'slug'    => $u ? $u->user_nicename : '',
			'avatar'  => Verify::avatar_url( (int) $r['author_id'], 48 ),
			'at'      => (int) $r['created'],
			// A referenced YouTube top comment on an ArtaBot seed (author name + pic + live likes) →
			// the board renders a "from YouTube" card. null on every ordinary comment.
			'ref'     => ( ! empty( $r['ref'] ) && is_array( $j = json_decode( (string) $r['ref'], true ) ) ) ? $j : null,
		];
	}

	/**
	 * GET /sections/{lesson_id}/thread?sort=&cursor=&parent= — the section's discussion board.
	 * Scales like Reddit: TOP-LEVEL comments are keyset-paginated (sort = top|new), each carrying its
	 * first few replies + a reply_count; pass ?parent=<id> to page the rest of one comment's replies.
	 * Open board — visible to all. Each row carries the viewer's vote (my_vote: 1|0|-1) + engagement.
	 */
	public static function section_thread( $req ) {
		$uid    = Rest::uid();
		$lid    = Rest::pint( $req, 'lesson_id' );
		$sort   = Rest::p( $req, 'sort', 'top' ) === 'new' ? 'new' : 'top';
		$cursor = Rest::pint( $req, 'cursor', 0 );
		$parent = Rest::pint( $req, 'parent', 0 );
		$l      = Data::one( 'SELECT id, course_id FROM ' . Data::t( 'aq_lessons' ) . ' WHERE id = %d', [ $lid ] );
		if ( ! $l ) { return Rest::err( 'not_found', 'Video not found', 404 ); }
		// Boards are seeded PROACTIVELY in the background (the aq_seed_boards cron → Learn::seed_pending),
		// so the read path never makes a YouTube API call. A board references the video's top YouTube
		// comment as a conversation-starter example (clearly ArtaBot's — shape_comment marks bot:true;
		// the podium excludes the bot user, so a seed never interferes with the competition).

		// my_vote lookup for the comments we'll return (one indexed scan over this section's votes).
		$myvotes = [];
		if ( $uid ) {
			foreach ( Data::all( 'SELECT target_id, val FROM ' . Data::t( 'aq_votes' ) . " WHERE target_type = 'comment' AND user_id = %d AND context_id = %d", [ $uid, $lid ] ) as $v ) { $myvotes[ (int) $v['target_id'] ] = (int) $v['val']; }
		}
		$shape = fn( $r ) => self::shape_comment( $r, $uid, $myvotes );

		// ── Paging ONE comment's replies (?parent=) ──
		if ( $parent ) {
			[ $rows, $next ] = Data::page( 'aq_comments', "context_type = 'section' AND context_id = %d AND parent_id = %d", [ $lid, $parent ], $cursor, self::PAGE_REPLY, 'ASC' );
			return [ 'items' => array_map( $shape, $rows ), 'next' => $next ];
		}

		// ── Top-level comments, keyset-paginated by sort ── (unified board: context_type='section')
		$T   = Data::t( 'aq_comments' );
		$SEC = "context_type = 'section' AND context_id = %d AND parent_id = 0";
		if ( $sort === 'new' ) {
			[ $tops, $next ] = Data::page( 'aq_comments', $SEC, [ $lid ], $cursor, self::PAGE_TOP, 'DESC' );
		} else {
			// Sort by net score, newest-first among ties. The (context_type, context_id, parent_id, votes)
			// index ends in the PK (id), so ordering BOTH columns DESC is a single reverse index walk —
			// `votes DESC, id ASC` instead forces a filesort (temp b-tree) over a section that can hold
			// millions of comments (bench.sh: board_top HOTSPOT→SCALABLE). The tiebreak among equal-score
			// comments is cosmetic; newest-first reads better anyway. Keyset is OFFSET-free over (votes,id):
			// the next page is rows ordered after the cursor → votes < cv, OR same votes and a smaller id.
			$cv = $cursor ? (int) Data::col( "SELECT votes FROM $T WHERE id = %d", [ $cursor ] ) : null;
			if ( $cursor && $cv !== null ) {
				$tops = Data::all( "SELECT * FROM $T WHERE $SEC AND ( votes < %d OR ( votes = %d AND id < %d ) ) ORDER BY votes DESC, id DESC LIMIT %d", [ $lid, $cv, $cv, $cursor, self::PAGE_TOP + 1 ] );
			} else {
				$tops = Data::all( "SELECT * FROM $T WHERE $SEC ORDER BY votes DESC, id DESC LIMIT %d", [ $lid, self::PAGE_TOP + 1 ] );
			}
			$next = null;
			if ( count( $tops ) > self::PAGE_TOP ) { $tops = array_slice( $tops, 0, self::PAGE_TOP ); $next = (int) end( $tops )['id']; }
		}

		// First PAGE_REPLY replies for each shown top-level comment (newest-conversation order: ASC by id).
		$items = [];
		foreach ( $tops as $t ) {
			$row = $shape( $t );
			$row['children'] = [];
			if ( (int) $t['reply_count'] > 0 ) {
				$reps = Data::all( "SELECT * FROM $T WHERE parent_id = %d ORDER BY id ASC LIMIT %d", [ (int) $t['id'], self::PAGE_REPLY ] );
				$row['children']    = array_map( $shape, $reps );
				$row['more_replies'] = max( 0, (int) $t['reply_count'] - count( $reps ) );
			} else {
				$row['more_replies'] = 0;
			}
			$items[] = $row;
		}

		$st  = self::progress_map( $uid, (int) $l['course_id'] )[ $lid ] ?? null;
		// Write-gate context (universal discussions): the board READS for everyone; only enrolled members
		// may post/vote. Ship enrolment + price + the course URL so the client gates without a second call.
		$cid   = (int) $l['course_id'];
		$price = (int) Funds::course_cost( $cid );
		$slug  = (string) Data::col( 'SELECT slug FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		return [
			'items'          => $items,
			'next'           => $next,
			'sort'           => $sort,
			'total'          => (int) Data::col( 'SELECT comment_count FROM ' . Data::t( 'aq_lessons' ) . ' WHERE id = %d', [ $lid ] ), // denormalized (was COUNT(*) over the section)
			'mine_commented' => $st ? (bool) $st['commented'] : false,
			'mine_upvoted'   => $st ? (bool) $st['upvoted'] : false,
			'others_exist'   => $st ? (bool) $st['others'] : false,
			'engaged'        => $st ? (bool) $st['engaged'] : false,
			'enrolled'       => (bool) ( $uid && Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_enroll' ) . ' WHERE user_id = %d AND course_id = %d', [ $uid, $cid ] ) ),
			// Posting also requires a set identity (name + birthday). Ship it so the client can prompt
			// for it INLINE before the member writes — instead of letting them write then be rejected.
			'needs_identity' => (bool) ( $uid && ! Verify::has_identity( $uid ) ),
			'price'          => $price,
			'price_display'  => '₳' . $price,
			'course_url'     => $slug ? '/courses/' . $slug . '/' : '/courses/',
		];
	}

	/**
	 * POST /comment/vote {comment_id, dir} — HEART a peer's section comment (hearts-only since
	 * 2026-07-10, Creative Challenges: the platform takes no downvotes).
	 *   dir = 1 (heart) | 0 (clear). Clicking the heart again clears it (toggle). One heart per
	 *   member per comment. You can never heart your own. Legacy −1 rows persist and age out of
	 *   the season windows; SUM(val) scores stay correct throughout.
	 *
	 * The comment's denormalized `votes` is recomputed as the net score (Σ val). A net-new
	 * HEART (the FIRST time this voter hearts this comment, ever) earns the author 1 lifetime learn
	 * point — idempotent by ref, so un-heart/re-heart never farms points, and clearing never costs
	 * the author points (lifetime points only grow). Casting a heart can complete the VOTER's
	 * section engagement (comment + heart), so pct + rewards re-settle.
	 */
	public static function vote_comment( $req ) {
		if ( Rest::throttle( 'sc_vote', 120, 600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		$id  = Rest::pint( $req, 'comment_id' );
		$dir = Rest::pint( $req, 'dir', 1 ) > 0 ? 1 : 0; // hearts-only: clamp to {1, 0}
		$c   = Data::one( 'SELECT id, course_id, context_id AS lesson_id, author_id AS user_id FROM ' . Data::t( 'aq_comments' ) . " WHERE id = %d AND context_type = 'section'", [ $id ] );
		if ( ! $c ) { return Rest::err( 'not_found', 'Comment not found', 404 ); }
		if ( (int) $c['user_id'] === $uid ) { return Rest::err( 'self_vote', 'You can’t vote on your own comment.', 403 ); }
		$lid = (int) $c['lesson_id'];
		$cid = (int) $c['course_id'];
		$err = self::require_enrolled( $uid, $cid );
		if ( $err ) { return $err; }

		$cur = Data::col( 'SELECT val FROM ' . Data::t( 'aq_votes' ) . " WHERE user_id = %d AND target_type = 'comment' AND target_id = %d", [ $uid, $id ] );
		$cur = $cur === null ? 0 : (int) $cur;
		$new = ( $dir === 0 || $dir === $cur ) ? 0 : $dir; // re-clicking the same arrow clears; opposite flips
		if ( $new !== $cur ) {
			if ( $new === 0 ) {
				$GLOBALS['wpdb']->delete( Data::t( 'aq_votes' ), [ 'user_id' => $uid, 'target_type' => 'comment', 'target_id' => $id ] );
			} else {
				Data::upsert( 'aq_votes', [ 'user_id' => $uid, 'target_type' => 'comment', 'target_id' => $id ], [
					'val' => $new, 'course_id' => $cid, 'context_id' => $lid, 'created' => Data::now(),
				] );
				if ( $new === 1 ) {
					$ref = 'scv' . $id . '_' . $uid; // (author, voter, comment) — idempotent anchor for the point AND the notification
					Economy::award_points( (int) $c['user_id'], 1, 'learn', $ref ); // first-ever upvote only (idempotent by ref)
					// Tell the author someone upvoted their reply — upvotes are what the competition is about.
					$voter = wp_get_current_user();
					Notify::push( (int) $c['user_id'], 'upvote', ( $voter && $voter->display_name ? $voter->display_name : 'A peer' ) . ' upvoted your reply', '', '/video/?video=' . $lid, $ref );
				}
			}
		}
		// Net score (up − down): apply the EXACT signed delta of this vote with one atomic increment, then
		// read the single comment row back (PK lookup). The DB serializes the UPDATE, so it is race-free
		// and stays exactly equal to SUM(val) — without ever re-summing a comment's whole vote set, which
		// is O(votes-on-comment) and unbounded on a viral comment. (aq_votes stays the source of truth;
		// the competition recomputes from it via quester_touch — this column is only the display/sort score.)
		$delta = $new - $cur;
		if ( $delta !== 0 ) { Data::bump( 'aq_comments', [ 'id' => $id ], 'votes', $delta ); }
		$votes = (int) Data::col( 'SELECT votes FROM ' . Data::t( 'aq_comments' ) . ' WHERE id = %d', [ $id ] );
		// The voted comment's AUTHOR gained/lost a season upvote → refresh their quester bucket (scoped
		// to that author) so the competition board + settlement read the maintained standing.
		Economy::quester_touch( $cid, (int) $c['user_id'] );
		$pct = self::recompute_pct( $uid, $cid ); // casting an upvote can complete the voter's section
		Economy::settle_course_rewards( $cid );
		return [ 'ok' => true, 'my_vote' => $new, 'votes' => $votes, 'pct' => $pct ];
	}

	/** GET /dashboard — the learner's enrolled courses with progress + resume link. */
	public static function dashboard( $req ) {
		$uid  = Rest::uid();
		$rows = Data::all(
			'SELECT e.course_id, e.pct, e.status, c.title, c.image, c.slug, c.lesson_count
			   FROM ' . Data::t( 'aq_enroll' ) . ' e
			   JOIN ' . Data::t( 'aq_courses' ) . ' c ON c.id = e.course_id
			  WHERE e.user_id = %d ORDER BY e.updated DESC LIMIT 100',
			[ $uid ]
		);
		$courses = array_map( function ( $r ) use ( $uid ) {
			$cid = (int) $r['course_id'];
			// Resume target: the first section the learner hasn't watched yet (in order).
			$resume_lid = (int) Data::col(
				'SELECT id FROM ' . Data::t( 'aq_lessons' ) . ' WHERE course_id = %d
				   AND id NOT IN ( SELECT lesson_id FROM ' . Data::t( 'aq_progress' ) . ' WHERE user_id = %d AND course_id = %d AND done = 1 )
				 ORDER BY idx ASC LIMIT 1',
				[ $cid, $uid, $cid ]
			);
			if ( ! $resume_lid ) {
				$resume_lid = (int) Data::col( 'SELECT id FROM ' . Data::t( 'aq_lessons' ) . ' WHERE course_id = %d ORDER BY idx ASC LIMIT 1', [ $cid ] );
			}
			return [
				'id'      => $cid,
				'value'   => $r['title'],
				'title'   => $r['title'],
				'image'   => $r['image'],
				'url'     => '/courses/' . $r['slug'],
				'resume'  => $resume_lid ? '/video/?video=' . $resume_lid : '/courses/' . $r['slug'],
				'lessons' => (int) $r['lesson_count'],
				'pct'     => (int) $r['pct'],
				'cert'    => (int) $r['pct'] >= self::PASS_PCT,
			];
		}, $rows );
		return [ 'courses' => $courses, 'points' => Economy::points_balance( $uid ), 'coins' => Economy::coin_balance( $uid ) ];
	}

	// ── helpers ─────────────────────────────────────────────────────────────
	private static function course_exists( $cid ) {
		return (bool) Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
	}

	/**
	 * Ensure the learner is enrolled, charging the entry fee on the FIRST enrolment. Returns true once
	 * enrolled (already, or newly after a successful charge); returns FALSE when enrolment is refused
	 * because the learner can't afford the fee (top up, or get a bursary). Idempotent — an existing
	 * enrolment of any status (active/bursary) is never re-charged. The single canonical enrol primitive
	 * (also used by Extra::course_checkout) so there is never a free enrolment path around the paywall.
	 */
	public static function ensure_enrolled( $uid, $cid ) {
		$uid = (int) $uid; $cid = (int) $cid;
		if ( $uid <= 0 || $cid <= 0 ) { return false; }
		if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_enroll' ) . ' WHERE user_id = %d AND course_id = %d', [ $uid, $cid ] ) ) { return true; }
		$cost = Funds::course_cost( $cid );
		// Serialise this member's enrol charge across ALL courses AND every other debit path. coin_balance()
		// is a read and charge_enrollment() the write — without a lock two concurrent enrols of DIFFERENT
		// courses could both pass the affordability check below and both debit, overdrawing the wallet to a
		// NEGATIVE (unbacked) balance and inflating course revenue against money the learner never had.
		// Shares the ATOMIC per-user wallet lock with Economy::sell() and Shop::order() — the old transient
		// get→set here had a read/write race two simultaneous requests could both pass, and a sell racing
		// an enrol crossed two different lock names entirely. /enroll is also throttled.
		$lock = 'wallet_u' . $uid;
		if ( ! Economy::acquire_lock( $lock, 15 ) ) { return false; } // a concurrent debit holds the lock — the caller retries
		try {
			// Re-read inside the lock: a concurrent enrol of THIS course may have just completed.
			if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_enroll' ) . ' WHERE user_id = %d AND course_id = %d', [ $uid, $cid ] ) ) { return true; }
			if ( $cost > 0 && Economy::coin_balance( $uid ) < $cost ) { return false; } // can't afford the entry fee
			$inserted = Data::upsert( 'aq_enroll', [ 'user_id' => $uid, 'course_id' => $cid ], [
				'status'  => 'active',
				'created' => Data::now(),
				'updated' => Data::now(),
			] );
			if ( $inserted ) {
				Economy::charge_enrollment( $uid, $cid, $cost ); // debit the fee → course revenue (funds the pool)
				Data::bump( 'aq_courses', [ 'id' => $cid ], 'enroll_count', 1 );
				// A new enrollment can push the course past the 20-learner threshold that unlocks
				// the quester reward pool — settle so already-certified questers get paid.
				Economy::settle_course_rewards( $cid );
			}
			return true;
		} finally {
			Economy::release_lock( $lock );
		}
	}

	/** Enrol the learner, or return the 402 error to send when they can't afford the entry fee. */
	private static function require_enrolled( $uid, $cid ) {
		if ( self::ensure_enrolled( $uid, $cid ) ) { return null; }
		return Rest::err( 'payment_required', 'Enrolling costs ₳' . Funds::course_cost( $cid ) . '. Top up your coins, or apply for a bursary.', 402 );
	}

	/**
	 * Videos are never locked. Every section is freely playable and skippable, in any order, by anyone
	 * — no paywall, no sequential unlock. Kept as a stable seam for callers/UI state; always unlocked.
	 */
	public static function is_locked( $uid, $cid, $lid ) {
		return false;
	}

	/**
	 * Per-section engagement state for a learner across a course, in one pass:
	 * [lid => done, commented, upvoted, others, engaged, complete, locked].
	 *   - engaged  = commented AND (upvoted another OR no other comments exist yet) — the section's
	 *                discussion requirement, relaxed so a lone first commenter is never deadlocked.
	 *   - complete = watched (done) AND engaged — counts toward the certificate.
	 *   - locked   = always false — videos are never locked (any section plays in any order).
	 */
	public static function progress_map( $uid, $cid ) {
		// Carry each section's DENORMALIZED comment total (aq_lessons.comment_count) so "others commented
		// here" is derived as (total − mine) > 0 — never a course-wide DISTINCT scan over every comment
		// (which is O(course) and unbounded on a popular course). `mine` comes from one per-user GROUP BY.
		$lessons = Data::all( 'SELECT id, idx, comment_count FROM ' . Data::t( 'aq_lessons' ) . ' WHERE course_id = %d ORDER BY idx ASC', [ $cid ] );
		$watched = []; $mine = []; $upvoted = [];
		if ( (int) $uid ) {
			foreach ( Data::all( 'SELECT lesson_id FROM ' . Data::t( 'aq_progress' ) . ' WHERE user_id = %d AND course_id = %d AND done = 1', [ $uid, $cid ] ) as $r ) { $watched[ (int) $r['lesson_id'] ] = true; }
			// My comments per section (one indexed per-user scan): gives both "I commented" and the count
			// to subtract from the section total to know whether anyone ELSE has.
			foreach ( Data::all( 'SELECT context_id, COUNT(*) n FROM ' . Data::t( 'aq_comments' ) . " WHERE context_type = 'section' AND author_id = %d AND course_id = %d GROUP BY context_id", [ $uid, $cid ] ) as $r ) { $mine[ (int) $r['context_id'] ] = (int) $r['n']; }
			// Engagement needs a positive UPVOTE (val = 1) on a peer — a downvote doesn't count.
			foreach ( Data::all( 'SELECT DISTINCT context_id FROM ' . Data::t( 'aq_votes' ) . " WHERE target_type = 'comment' AND user_id = %d AND course_id = %d AND val = 1", [ $uid, $cid ] ) as $r ) { $upvoted[ (int) $r['context_id'] ] = true; }
		}
		$map = [];
		foreach ( $lessons as $l ) {
			$id  = (int) $l['id'];
			$myn = $mine[ $id ] ?? 0;
			$c   = $myn > 0;                                          // I commented here
			$uv  = isset( $upvoted[ $id ] );
			$oth = ( (int) $l['comment_count'] - $myn ) > 0;         // someone other than me commented here
			$eng = $c && ( $uv || ! $oth );
			$map[ $id ] = [
				'done'      => isset( $watched[ $id ] ),
				'commented' => $c,
				'upvoted'   => $uv,
				'others'    => $oth,
				'engaged'   => $eng,
				'complete'  => isset( $watched[ $id ] ) && $eng,
				'locked'    => false, // never locked — any section plays in any order
			];
		}
		return $map;
	}

	/** Per-section state for the curriculum sidebar (✓ complete / watched / locked) — one pass. */
	public static function section_state( $uid, $cid ) {
		$out = [];
		foreach ( self::progress_map( $uid, $cid ) as $id => $s ) {
			$out[ $id ] = [ 'done' => $s['done'], 'commented' => $s['commented'], 'complete' => $s['complete'], 'locked' => $s['locked'] ];
		}
		return $out;
	}

	/** Recompute course % = engaged sections / total sections, stored on the enroll row. MONOTONIC:
	 *  the stored pct never DROPS — a section legitimately completed while the learner was the lone
	 *  commenter (the "alone" relaxation) stays complete after peers arrive, so you can't lose a
	 *  certificate just because someone else commented later. Engagement only ever grows otherwise. */
	private static function recompute_pct( $uid, $cid ) {
		$total = (int) Data::col( 'SELECT lesson_count FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		if ( ! $total ) { return 0; }
		$complete = 0;
		foreach ( self::progress_map( $uid, $cid ) as $s ) { if ( $s['complete'] ) { $complete++; } }
		$stored = (int) Data::col( 'SELECT pct FROM ' . Data::t( 'aq_enroll' ) . ' WHERE user_id = %d AND course_id = %d', [ $uid, $cid ] );
		$pct    = max( $stored, (int) floor( $complete * 100 / $total ) );
		Data::update( 'aq_enroll', [ 'pct' => $pct, 'updated' => Data::now() ], [ 'user_id' => $uid, 'course_id' => $cid ] );
		return $pct;
	}

	/**
	 * GET /courses/{id}/rankings?season= — the course's Kaggle-style board for a competition SEASON.
	 * Seasons reset on the day closest to each new moon at 10:00 ET (Season). The CURRENT season is
	 * the live board (votes cast this window) with its deadline; pass a past season's key to view its
	 * archived, frozen leaderboard. The pool (80% of revenue) splits 50/30/20 across the top three.
	 * Each row carries the prize that rank WINS and the coins it actually COLLECTED.
	 */
	public static function course_rankings( $req ) {
		Season::ensure_archived(); // close + snapshot any season that has ended (cheap no-op otherwise)
		$cid = Rest::pint( $req, 'id' );
		$c   = Data::one( 'SELECT id, title, slug, enroll_count, revenue FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		if ( ! $c ) { return Rest::err( 'not_found', 'Course not found', 404 ); }

		$pool      = Economy::reward_pool( $c['revenue'] );
		$eligible  = (int) $c['enroll_count'] >= Economy::REWARD_MIN_ENROL;
		$cur       = Season::current();
		$past      = Season::archived_for_course( $cid );
		$want      = Rest::pint( $req, 'season', 0 ); // 0 / current key → live board; else an archived season
		$is_past   = $want > 0 && $want !== (int) $cur['key'];
		$medals    = [ 1 => 'gold', 2 => 'silver', 3 => 'bronze' ];

		$base = [
			'course'    => $c['title'],
			'slug'      => $c['slug'],
			'enrolled'  => (int) $c['enroll_count'],
			'min_enrol' => Economy::REWARD_MIN_ENROL,
			'eligible'  => $eligible,
			'revenue'   => (int) $c['revenue'],
			'pool'      => $pool,
			'share_pct' => (int) round( Economy::QUESTER_SHARE * 100 ),
			'split'     => array_map( fn( $s ) => (int) round( $s * 100 ), Economy::PODIUM ), // [50,30,20]
			'reset_at'  => (int) $cur['key'],                 // current season deadline (unix)
			'reset_label' => $cur['ends_label'],              // e.g. "Jun 5, 2026"
			'closes_in' => (int) $cur['closes_in'],           // seconds until reset
			'seasons'   => array_merge(
				[ [ 'key' => (int) $cur['key'], 'label' => 'Current · closes ' . $cur['ends_label'], 'current' => true ] ],
				array_map( fn( $s ) => [ 'key' => $s['key'], 'label' => $s['label'], 'current' => false ], $past )
			),
		];

		// ── A frozen, archived season ──
		if ( $is_past ) {
			$snap = Data::all(
				'SELECT place, user_id, votes, prize FROM ' . Data::t( 'aq_season_results' ) . ' WHERE season_key = %d AND course_id = %d ORDER BY place ASC',
				[ $want, $cid ]
			);
			$items = [];
			foreach ( $snap as $r ) {
				$u = get_userdata( (int) $r['user_id'] );
				if ( ! $u ) { continue; }
				$rank = (int) $r['place'];
				$items[] = [
					'rank' => $rank, 'medal' => $medals[ $rank ] ?? '',
					'name' => $u->display_name, 'slug' => $u->user_nicename, 'avatar' => Verify::avatar_url( $u->ID, 96 ),
					'votes' => (int) $r['votes'], 'questions' => 0,
					'certified' => true, 'prize' => (int) $r['prize'], 'reward' => (int) $r['prize'], // archived = final, prizes settled
				];
			}
			$srow = Data::one( 'SELECT label FROM ' . Data::t( 'aq_seasons' ) . ' WHERE season_key = %d', [ $want ] );
			return array_merge( $base, [
				'season_key' => $want, 'season_label' => $srow['label'] ?? '', 'archived' => true,
				'paid' => (int) Economy::rewards_distributed( $cid, $want ), 'items' => $items,
			] );
		}

		// ── The live current season ──
		$certified = [];
		foreach ( Data::all( 'SELECT user_id FROM ' . Data::t( 'aq_enroll' ) . ' WHERE course_id = %d AND pct >= %d', [ $cid, self::PASS_PCT ] ) as $r ) { $certified[ (int) $r['user_id'] ] = true; }
		$out = [];
		foreach ( Economy::podium( $cid, $pool, $cur['start'], $cur['end'] ) as $row ) {
			$u = get_userdata( $row['user_id'] );
			if ( ! $u ) { continue; }
			if ( $row['votes'] === 0 && $row['rank'] > 50 ) { break; } // bound the board
			$rank = $row['rank'];
			$out[] = [
				'rank'      => $rank,
				'medal'     => $medals[ $rank ] ?? '',
				'name'      => $u->display_name,
				'slug'      => $u->user_nicename,
				'avatar'    => Verify::avatar_url( $u->ID, 96 ),
				'votes'     => $row['votes'],
				'questions' => $row['questions'],
				'certified' => isset( $certified[ $row['user_id'] ] ),
				'prize'     => $row['prize'],
				'reward'    => (int) Economy::quester_reward_earned( $cid, $row['user_id'], $cur['key'] ),
			];
		}
		return array_merge( $base, [
			'season_key' => (int) $cur['key'], 'season_label' => $cur['label'], 'archived' => false,
			'paid' => (int) Economy::rewards_distributed( $cid, $cur['key'] ), 'items' => $out,
		] );
	}
}
