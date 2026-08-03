<?php
/**
 * test-sync-lessons.php — edge-case harness for the ID-PRESERVING lesson sync
 * (lesson-sync.inc.php) that import-course.php / import-courses-bulk.php and
 * the course-optimizer cycle all run through.
 *
 * Proves, on a self-cleaning scratch course, that re-syncing a course:
 *   - is idempotent (same spec → zero changes, identical row ids)
 *   - reorders / retitles / retimes IN PLACE (ids stable → progress, section
 *     boards and engagement state survive)
 *   - pairs segment twins of one long video positionally, and keeps a
 *     retrimmed segment's row (progress preserved across a seg_end change)
 *   - retires exactly the dropped section (its comments/votes/progress rows
 *     are KEPT in their tables — podium scopes by course_id, nothing destroyed)
 *   - inserts only genuinely new sections + registers them with aq_videos
 *   - never wipes a transcript the spec omits, updates one it carries
 *   - keeps aq_courses.lesson_count / duration / Funds::course_cost exact
 *   - leaves Learn::progress_map consistent (watched/commented flags intact)
 *
 * Run: studio wp eval 'require WP_PLUGIN_DIR."/aquest/tools/test-sync-lessons.php";'
 * Prints one PASS/FAIL line per assertion and a final AQ_SYNC_TEST=GREEN|RED.
 */

namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

require_once __DIR__ . '/lesson-sync.inc.php';

( function () {
	global $wpdb;
	$fail = 0;
	$ok   = function ( $cond, $label, $detail = '' ) use ( &$fail ) {
		if ( $cond ) { echo "PASS  $label\n"; }
		else { $fail++; echo "FAIL  $label" . ( $detail !== '' ? " — $detail" : '' ) . "\n"; }
	};

	$SLUG = 'aq-test-sync-scratch'; $SLUG2 = 'aq-test-sync-scratch-2';
	$UID  = 987654321;            // fake member (no users row needed for these tables)
	$VA = 'AQTESTSYNCAA'; $VB = 'AQTESTSYNCBB'; $VC = 'AQTESTSYNCCC'; $VD = 'AQTESTSYNCDD'; $VE = 'AQTESTSYNCEE'; $VF = 'AQTESTSYNCFF'; $VG = 'AQTESTSYNCGG';

	$cleanup = function () use ( $wpdb, $SLUG, $UID, $VA, $VB, $VC, $VD, $VE ) {
		$cid = (int) Data::col( 'SELECT id FROM ' . Data::t( 'aq_courses' ) . ' WHERE slug = %s', [ $SLUG ] );
		if ( $cid ) {
			$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . Data::t( 'aq_lessons' ) . ' WHERE course_id = %d', [ $cid ] ) );
			$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . Data::t( 'aq_comments' ) . ' WHERE course_id = %d', [ $cid ] ) );
			$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . Data::t( 'aq_votes' ) . ' WHERE course_id = %d', [ $cid ] ) );
			$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . Data::t( 'aq_progress' ) . ' WHERE course_id = %d', [ $cid ] ) );
			$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . Data::t( 'aq_enroll' ) . ' WHERE course_id = %d', [ $cid ] ) );
			$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . Data::t( 'aq_course_stats' ) . ' WHERE course_id = %d', [ $cid ] ) );
			$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] ) );
		}
		foreach ( [ $VA, $VB, $VC, $VD, $VE ] as $v ) {
			$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . Data::t( 'aq_videos' ) . ' WHERE video = %s', [ $v ] ) );
			$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . Data::t( 'aq_video_stats' ) . ' WHERE video = %s', [ $v ] ) );
			delete_option( 'aq_yt_meta_' . $v );
		}
		// scrub the fake member's rows in case a failed earlier run left strays
		$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . Data::t( 'aq_progress' ) . ' WHERE user_id = %d', [ $UID ] ) );
	};
	$cleanup(); // fresh start even after a previously aborted run

	try {
		// ── seed: course of 4 sections, incl. segment TWINS of one long video (VB) ──
		$cid = (int) Data::insert( 'aq_courses', [
			'slug' => $SLUG, 'title' => 'AQ sync scratch', 'summary' => '', 'image' => '',
			'channel' => 'Test', 'author_id' => 1, 'status' => 'draft', 'created' => Data::now(),
		] );
		$spec0 = [
			[ 'title' => 'One',    'video' => $VA, 'duration' => 100, 'transcript' => 'alpha words' ],
			[ 'title' => 'Two',    'video' => $VB, 'duration' => 300, 'seg_start' => 0,   'seg_end' => 300, 'transcript' => 'twin one' ],
			[ 'title' => 'Three',  'video' => $VB, 'duration' => 300, 'seg_start' => 300, 'seg_end' => 600, 'transcript' => 'twin two' ],
			[ 'title' => 'Four',   'video' => $VC, 'duration' => 200, 'transcript' => 'gamma words' ],
		];
		$r0 = aq_sync_lessons( $cid, $spec0 );
		$rows = function () use ( $cid ) {
			return Data::all( 'SELECT id, idx, title, video, duration, seg_start, seg_end, transcript, comment_count, created FROM ' . Data::t( 'aq_lessons' ) . ' WHERE course_id = %d ORDER BY idx', [ $cid ] );
		};
		$L0 = $rows();
		$ok( $r0['added'] === 4 && $r0['removed'] === 0 && count( $L0 ) === 4, 'seed: 4 sections inserted', json_encode( $r0 ) );
		// FIRST population is NOT a content change (ticket #82): a brand-new course has no old rate history
		// to invalidate, so the seed must NOT trip the 24h rank reset — otherwise freshly imported courses
		// sit at 0/hr for a day and their cards fall back to a raw view count instead of the "/hr" badge.
		$ok( empty( $r0['reset'] )
			&& (int) Data::col( 'SELECT trend_reset FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] ) === 0,
			'seed: first population does not reset the rank (#82)', json_encode( $r0 ) );
		$ids0 = array_map( fn( $l ) => (int) $l['id'], $L0 ); // by idx: One, Two, Three, Four

		// member state: watched 1+2, commented on 1 (+denorm), upvote on that comment, enrolled at 50%
		foreach ( [ $ids0[0], $ids0[1] ] as $lid ) {
			Data::insert( 'aq_progress', [ 'user_id' => $UID, 'lesson_id' => $lid, 'course_id' => $cid, 'done' => 1, 'watched' => 100, 'started' => Data::now(), 'updated' => Data::now() ] );
		}
		$cmt = (int) Data::insert( 'aq_comments', [ 'context_type' => 'section', 'context_id' => $ids0[0], 'course_id' => $cid, 'author_id' => $UID, 'body' => 'q', 'created' => Data::now() ] );
		Data::bump( 'aq_lessons', [ 'id' => $ids0[0] ], 'comment_count', 1 );
		Data::insert( 'aq_votes', [ 'user_id' => $UID + 1, 'target_type' => 'comment', 'target_id' => $cmt, 'val' => 1, 'course_id' => $cid, 'context_id' => $ids0[0], 'created' => Data::now() ] );
		Data::insert( 'aq_enroll', [ 'user_id' => $UID, 'course_id' => $cid, 'pct' => 50, 'status' => 'active', 'created' => Data::now(), 'updated' => Data::now() ] );

		// ── 1. idempotent re-run: zero changes, identical ids ──
		$r1 = aq_sync_lessons( $cid, $spec0 );
		$L1 = $rows();
		$ok( $r1['kept'] === 4 && $r1['added'] === 0 && $r1['removed'] === 0 && $r1['moved'] === 0, 'idempotent: re-sync of same spec is a no-op', json_encode( $r1 ) );
		$ok( array_map( fn( $l ) => (int) $l['id'], $L1 ) === $ids0, 'idempotent: row ids unchanged' );
		$ok( (int) $L1[0]['comment_count'] === 1, 'idempotent: denormalized comment_count survives' );

		// ── 2. pure reorder (Four first): ids stable, idx moves, state intact ──
		$r2 = aq_sync_lessons( $cid, [ $spec0[3], $spec0[0], $spec0[1], $spec0[2] ] );
		$L2 = $rows();
		$ok( $r2['kept'] === 4 && $r2['added'] === 0 && $r2['removed'] === 0 && $r2['moved'] === 4, 'reorder: in-place idx updates only', json_encode( $r2 ) );
		$ok( (int) $L2[0]['id'] === $ids0[3] && (int) $L2[1]['id'] === $ids0[0], 'reorder: same rows, new positions' );
		$ok( (int) $L2[1]['comment_count'] === 1, 'reorder: comment_count rides with its row' );
		$map = Learn::progress_map( $UID, $cid );
		$ok( ! empty( $map[ $ids0[0] ]['done'] ) && ! empty( $map[ $ids0[0] ]['commented'] ) && ! empty( $map[ $ids0[1] ]['done'] ), 'reorder: watch + comment engagement still attached' );

		// ── 3. retitle + duration + transcript update in place ──
		$spec3 = [ $spec0[3], array_merge( $spec0[0], [ 'title' => 'One renamed', 'duration' => 150, 'transcript' => 'alpha v2' ] ), $spec0[1], $spec0[2] ];
		aq_sync_lessons( $cid, $spec3 );
		$L3 = $rows();
		$ok( (int) $L3[1]['id'] === $ids0[0] && $L3[1]['title'] === 'One renamed' && (int) $L3[1]['duration'] === 150 && $L3[1]['transcript'] === 'alpha v2', 'edit: title/duration/transcript update keeps the id' );
		$ok( (int) Data::col( 'SELECT duration FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] ) === 950, 'edit: course duration recomputed (950)' );

		// ── 4. segment retrim of one twin keeps its row ──
		$spec4 = $spec3; $spec4[3] = array_merge( $spec0[2], [ 'seg_end' => 650, 'duration' => 350 ] );
		$r4 = aq_sync_lessons( $cid, $spec4 );
		$L4 = $rows();
		$ok( $r4['added'] === 0 && $r4['removed'] === 0 && (int) $L4[3]['id'] === $ids0[2] && (int) $L4[3]['seg_end'] === 650, 'segments: retrimmed twin keeps its row id', json_encode( $r4 ) );
		$ok( (int) $L4[2]['id'] === $ids0[1] && (int) $L4[2]['seg_end'] === 300, 'segments: untouched twin unaffected' );

		// ── 5. retire one commented/watched section; everything else intact ──
		$spec5 = [ $spec4[1], $spec4[2], $spec4[3] ]; // drop Four (VC)
		$r5 = aq_sync_lessons( $cid, $spec5 );
		$L5 = $rows();
		$ok( $r5['removed'] === 1 && $r5['removed_ids'] === [ $ids0[3] ] && count( $L5 ) === 3, 'retire: exactly the dropped section deleted', json_encode( $r5 ) );
		$ok( (int) Data::col( 'SELECT lesson_count FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] ) === 3, 'retire: lesson_count = 3' );
		$ok( Funds::course_cost( $cid ) === (int) max( 1, (int) Data::col( 'SELECT lesson_count FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] ) ), 'retire: entry fee = lesson_count, min 1 (1 coin per video)' );
		$ok( (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_comments' ) . ' WHERE course_id = %d', [ $cid ] ) === 1
		  && (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_votes' ) . ' WHERE course_id = %d', [ $cid ] ) === 1
		  && (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_progress' ) . ' WHERE user_id = %d AND course_id = %d', [ $UID, $cid ] ) === 2,
			'retire: comments/votes/progress rows all preserved (podium + history intact)' );
		$pod = Economy::podium_ledger( $cid );
		$ok( $pod && (int) $pod[0]['user_id'] === $UID && (int) $pod[0]['votes'] === 1, 'retire: course podium still counts the earned upvote' );
		$ok( (int) Data::col( 'SELECT pct FROM ' . Data::t( 'aq_enroll' ) . ' WHERE user_id = %d AND course_id = %d', [ $UID, $cid ] ) === 50, 'retire: stored pct untouched (monotonic floor preserved)' );

		// ── 6. add a new section (a freshly-added section starts with comment_count 0) ──
		$spec6 = $spec5; $spec6[] = [ 'title' => 'Five', 'video' => $VD, 'duration' => 250, 'transcript' => 'delta words' ];
		$r6 = aq_sync_lessons( $cid, $spec6 );
		$L6 = $rows();
		$ok( $r6['added'] === 1 && count( $L6 ) === 4 && $L6[3]['video'] === $VD, 'add: one new section appended', json_encode( $r6 ) );
		$ok( in_array( $ids0[0], array_map( fn( $l ) => (int) $l['id'], $L6 ), true ), 'add: existing rows untouched' );
		$ok( (int) $L6[3]['comment_count'] === 0 && (int) $L6[3]['created'] > time() - 60, 'add: new section starts at 0 comments and stamps `created` (gates the ≥1h churn drop)' );
		$ok( Funds::course_cost( $cid ) === (int) max( 1, (int) Data::col( 'SELECT lesson_count FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] ) ), 'add: entry fee = lesson_count, min 1 (1 coin per video)' );

		// ── 7. swap (retire + add) in ONE sync ──
		$spec7 = $spec6;
		$spec7[0] = [ 'title' => 'One swapped', 'video' => $VE, 'duration' => 180, 'transcript' => 'epsilon' ]; // VA → VE
		$r7 = aq_sync_lessons( $cid, $spec7 );
		$L7 = $rows();
		$ok( $r7['added'] === 1 && $r7['removed'] === 1 && $r7['removed_ids'] === [ $ids0[0] ] && count( $L7 ) === 4, 'swap: retire+add in one pass, twins + new row untouched', json_encode( $r7 ) );
		$ok( (int) $L7[1]['id'] === $ids0[1] && (int) $L7[2]['id'] === $ids0[2], 'swap: kept rows keep ids' );

		// ── 8. degenerate spec: same video+segments listed twice → two stable rows, no crash ──
		$spec8 = $spec7; $spec8[] = [ 'title' => 'Dup', 'video' => $VD, 'duration' => 250 ];
		$r8a = aq_sync_lessons( $cid, $spec8 );
		$r8b = aq_sync_lessons( $cid, $spec8 );
		$ok( $r8a['added'] === 1 && $r8b['added'] === 0 && $r8b['removed'] === 0, 'duplicate video twice in spec: stable across re-runs', json_encode( [ $r8a, $r8b ] ) );

		// ── 9. spec lesson WITHOUT a transcript key never wipes the stored one ──
		$spec9 = $spec8;
		$spec9[3] = [ 'title' => 'Five', 'video' => $VD, 'duration' => 250 ]; // no transcript key
		aq_sync_lessons( $cid, $spec9 );
		$tr = (string) Data::col( 'SELECT transcript FROM ' . Data::t( 'aq_lessons' ) . ' WHERE course_id = %d AND idx = 4', [ $cid ] );
		$ok( $tr === 'delta words', 'transcript: omitted key leaves stored transcript intact', "got '$tr'" );

		// ── 10. content-change rank reset (comment-based, 2026-06-13): the syncs above changed
		//        composition, so the course's rank is reset — recompute must HOLD trend/rank_score at 0
		//        inside the 24h window so a fresh comment can't lift a just-edited course back up. ──
		YouTube::recompute_course_trend( $cid );
		$reset = (int) Data::col( 'SELECT trend_reset FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		$trend = (int) Data::col( 'SELECT trend FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		$rank  = (int) Data::col( 'SELECT rank_score FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		$ok( $reset > time() - 60, 'reset: composition change stamped trend_reset', "trend_reset=$reset" );
		$ok( $trend === 0 && $rank === 0, 'reset: trend + rank_score held at 0 inside the 24h window', "trend=$trend rank=$rank" );

		// ── 11. after the window: rank_score = AVERAGE per-video YouTube comment HOURLY RATE ×100, read
		//        from aq_videos.rate (one registry row per DISTINCT source video, filled by the hourly
		//        API refresh). `trend` = Σ the videos' cumulative comment counts (aq_videos.views, the
		//        column repurposed to hold commentCount). Give the course's distinct videos known rates
		//        (4 & 2/hr, rest 0) so the AVERAGE distinguishes from a SUM. ──
		$L11  = $rows();
		$vids = array_values( array_unique( array_filter( array_map( fn( $l ) => (string) $l['video'], $L11 ) ) ) );
		$nv   = count( $vids );
		$sumRate = 0; $sumCnt = 0;
		foreach ( $vids as $i => $v ) {
			$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . Data::t( 'aq_videos' ) . ' WHERE video = %s', [ $v ] ) ); // clean baseline (re-runs)
			$rate = ( $i === 0 ) ? 400 : ( ( $i === 1 ) ? 200 : 0 ); // aq_videos.rate is CENTI-comments/hr (×100)
			$cnt  = 10 * ( $i + 1 );
			$sumRate += $rate; $sumCnt += $cnt;
			Data::insert( 'aq_videos', [ 'video' => $v, 'views' => $cnt, 'rate' => $rate, 'missing' => 0, 'last_refresh' => time(), 'created' => time() ] );
		}
		$wpdb->query( $wpdb->prepare( 'UPDATE ' . Data::t( 'aq_courses' ) . ' SET trend_reset = %d WHERE id = %d', [ time() - DAY_IN_SECONDS - 60, $cid ] ) );
		YouTube::recompute_course_trend( $cid );
		$trend = (int) Data::col( 'SELECT trend FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		$rank  = (int) Data::col( 'SELECT rank_score FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		$expectRank = (int) round( $sumRate / max( 1, $nv ) ); // rank_score = AVG of the videos' centi-rates
		$ok( $rank === $expectRank, "rank_score: AVG per-video comment hourly rate ×100 (centi-rates sum $sumRate over $nv videos)", "rank=$rank expect=$expectRank" );
		$ok( $trend === $sumCnt, "trend: Σ the videos' cumulative comment counts ($sumCnt)", "trend=$trend" );

		// ── 12. a kept/moved-only re-sync (idempotent re-import) must NOT re-stamp the reset ──
		$r12 = aq_sync_lessons( $cid, $spec9 ); // identical spec → kept rows only
		$reset2 = (int) Data::col( 'SELECT trend_reset FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		$ok( $reset2 === time() - DAY_IN_SECONDS - 60 || $reset2 < time() - DAY_IN_SECONDS, 'reset: identical re-sync does not re-stamp', "trend_reset=$reset2" );
		$ok( empty( $r12['reset'] ), 'reset: idempotent re-sync reports reset=false', json_encode( $r12 ) );

		// ── 13. ticket #81: an in-place VIDEO CHANGE on a KEPT lesson (a segment retrim — same video,
		//        no add/remove) must ALSO reset the course's rate history, exactly like add/remove. The
		//        Studio's literal "swap a video id" already resets via the add/remove path (test #7);
		//        this closes the remaining gap so ANY change to what a section presents resets. ──
		$wpdb->query( $wpdb->prepare( 'UPDATE ' . Data::t( 'aq_courses' ) . ' SET trend_reset = %d WHERE id = %d', [ time() - DAY_IN_SECONDS - 60, $cid ] ) );
		$cur    = $rows();
		$spec13 = array_map( fn( $l ) => [ 'title' => (string) $l['title'], 'video' => (string) $l['video'],
			'duration' => (int) $l['duration'], 'seg_start' => (int) $l['seg_start'], 'seg_end' => (int) $l['seg_end'] ], $cur );
		$spec13[0]['seg_end'] = (int) $cur[0]['seg_end'] + 1000; // retrim the first section's end — same video, in place
		$r13 = aq_sync_lessons( $cid, $spec13 );
		$reset13 = (int) Data::col( 'SELECT trend_reset FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		$ok( $r13['added'] === 0 && $r13['removed'] === 0, 'retrim: a seg-only edit is a pure in-place change (no add/remove)', json_encode( $r13 ) );
		$ok( ! empty( $r13['reset'] ) && $reset13 > time() - 60, 'retrim: in-place video change resets the rank (#81)', "reset={$r13['reset']} trend_reset=$reset13" );

		// ── 14. rank_score is ALWAYS the live average rate (commit e78bb50 "remove the 24h cooldown that
		//        broke the sort"): a fresh video rate is reflected immediately — there is no longer a hold
		//        that suppresses a just-reset course to 0. (trend_reset is still STAMPED on a content change
		//        — tests #10/#13 — but it no longer suppresses recompute.) Give a video a rate, reset 10 min
		//        ago, recompute → rank reflects the live rate, not 0. ──
		$cur14 = $rows();
		$v14   = (string) $cur14[0]['video'];
		$wpdb->query( $wpdb->prepare( 'UPDATE ' . Data::t( 'aq_videos' ) . ' SET rate = 99, last_refresh = %d WHERE video = %s', [ time(), $v14 ] ) );
		$wpdb->query( $wpdb->prepare( 'UPDATE ' . Data::t( 'aq_courses' ) . ' SET trend_reset = %d WHERE id = %d', [ time() - 600, $cid ] ) ); // reset 10 min ago — the former 24h window
		YouTube::recompute_course_trend( $cid );
		$held = (int) Data::col( 'SELECT rank_score FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		$ok( $held > 0, 'live rate: a fresh video rate is reflected in rank immediately (no 24h hold since e78bb50)', "rank=$held" );

		// ── 15. CROSS-COURSE UNIQUENESS (operator 2026-06-19): a video belongs to AT MOST ONE course.
		//        A second course owns VF; syncing THIS course with VF must DROP it (reported in `skipped`),
		//        never duplicate it — while a brand-new video VG alongside it is added normally. ──
		$wipe2 = function () use ( $wpdb, $SLUG2 ) { // self-contained teardown for the 2nd scratch course
			$c = (int) Data::col( 'SELECT id FROM ' . Data::t( 'aq_courses' ) . ' WHERE slug = %s', [ $SLUG2 ] );
			if ( $c ) {
				$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . Data::t( 'aq_lessons' ) . ' WHERE course_id = %d', [ $c ] ) );
				$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $c ] ) );
			}
		};
		$wipe2(); // clear any leftover from an aborted prior run
		$cid2 = (int) Data::insert( 'aq_courses', [
			'slug' => $SLUG2, 'title' => 'AQ sync scratch 2', 'summary' => '', 'image' => '',
			'channel' => 'Test', 'author_id' => 1, 'status' => 'draft', 'created' => Data::now(),
		] );
		aq_sync_lessons( $cid2, [ [ 'title' => 'F', 'video' => $VF, 'duration' => 120 ] ] ); // course 2 now OWNS VF
		$cur15  = $rows();
		$spec15 = array_map( fn( $l ) => [ 'title' => (string) $l['title'], 'video' => (string) $l['video'],
			'duration' => (int) $l['duration'], 'seg_start' => (int) $l['seg_start'], 'seg_end' => (int) $l['seg_end'] ], $cur15 );
		$spec15[] = [ 'title' => 'Borrowed', 'video' => $VF, 'duration' => 120 ]; // owned by course 2 → must be DROPPED
		$spec15[] = [ 'title' => 'Fresh',    'video' => $VG, 'duration' => 90 ];  // brand new → must be ADDED
		$r15 = aq_sync_lessons( $cid, $spec15 );
		$after15 = $rows();
		$ok( ! array_filter( $after15, fn( $l ) => (string) $l['video'] === $VF ), 'cross-course: a video owned by another course is NOT added here', json_encode( $r15 ) );
		$ok( (bool) array_filter( $after15, fn( $l ) => (string) $l['video'] === $VG ), 'cross-course: a genuinely new video alongside it IS added' );
		$ok( ! empty( $r15['skipped'] ) && $r15['skipped'][0]['video'] === $VF && (int) $r15['skipped'][0]['in_course'] === $cid2,
			'cross-course: the dropped video is reported in `skipped` with its owning course', json_encode( $r15['skipped'] ?? null ) );
		$ok( (int) Data::col( 'SELECT COUNT(DISTINCT course_id) FROM ' . Data::t( 'aq_lessons' ) . ' WHERE video = %s', [ $VF ] ) === 1,
			'cross-course: VF lives in exactly ONE course' );
		$r15b = aq_sync_lessons( $cid2, [ [ 'title' => 'F', 'video' => $VF, 'duration' => 120 ] ] );
		$ok( empty( $r15b['skipped'] ) && (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_lessons' ) . ' WHERE course_id = %d AND video = %s', [ $cid2, $VF ] ) === 1,
			'cross-course: the OWNER course keeps its own video on re-sync (self-owned, never dropped)', json_encode( $r15b ) );
		$wipe2(); // teardown the 2nd course (VG rides in course 1, removed by the main cleanup)
	} finally {
		$cleanup();
	}

	echo $fail ? "AQ_SYNC_TEST=RED ($fail failures)\n" : "AQ_SYNC_TEST=GREEN\n";
} )();
