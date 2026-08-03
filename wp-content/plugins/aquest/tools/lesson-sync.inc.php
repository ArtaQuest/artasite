<?php
/**
 * lesson-sync.inc.php — ID-PRESERVING lesson sync for a course, shared by
 * import-course.php, import-courses-bulk.php and the optimizer cycle.
 *
 * Why it exists: aq_progress.lesson_id, aq_comments.context_id and
 * aq_votes.context_id all key on the aq_lessons row id. The old wholesale
 * DELETE-then-reinsert re-import gave every lesson a NEW id on every run,
 * orphaning every member's watch progress, every section board and the
 * engagement state behind certificates. This sync instead DIFFS the desired
 * lesson list against the existing rows and updates matched rows IN PLACE
 * (same id), inserting only genuinely new sections and deleting only
 * genuinely retired ones.
 *
 * Matching (stable, two passes over the desired list in order):
 *   1. exact key  video + seg_start + seg_end   (segment twins of one long
 *      video pair up positionally, in idx order)
 *   2. video alone, over the leftovers           (a segment retrim keeps its
 *      row, so progress on that section survives)
 * Existing rows left unmatched are retired (row deleted; the section's
 * comments/votes/progress rows are kept — votes still count toward the
 * course podium, which scopes by course_id, and nothing is ever destroyed).
 * Desired lessons left unmatched are inserted.
 *
 * A matched lesson's transcript is only overwritten when the spec lesson
 * actually CARRIES a `transcript` key — a spec that omits it (e.g. a slim
 * optimizer plan) never wipes a stored transcript.
 *
 * Also recomputes the course's denormalized lesson_count + duration (NOTE:
 * lesson_count is the entry fee — Funds::course_cost — so adding/removing a
 * section changes what FUTURE enrollees pay; existing enrolments are never
 * re-charged).
 *
 * A video belongs to AT MOST ONE course: a desired video already owned by ANOTHER course (the course of
 * its earliest existing lesson) is DROPPED, never duplicated, and reported in the returned 'skipped' list.
 *
 * Returns ['kept','moved','added','removed','added_ids','removed_ids','skipped',
 *          'lesson_count','duration','reset'].  ('reset' = whether this sync reset the
 *          course's rate history — see the content-change rank reset near the end.)
 */

if ( ! defined( 'ABSPATH' ) ) { exit; }

if ( ! function_exists( 'aq_sync_lessons' ) ) {
	function aq_sync_lessons( $cid, array $lessons ) {
		global $wpdb;
		$cid = (int) $cid;

		// CROSS-COURSE UNIQUENESS (operator 2026-06-19): a video belongs to AT MOST ONE course. Resolve, for
		// every video in the incoming spec, which course already OWNS it = the course of its EARLIEST existing
		// lesson (MIN(id)). That key is STABLE (this very sync preserves lesson ids), so when two courses both
		// list a video, ownership resolves the same way from either side — it never ping-pongs. A video owned
		// by ANOTHER course is DROPPED below (and reported in `skipped`), so it can never be duplicated across
		// courses; segment twins WITHIN this course are unaffected (same course_id = self-owned). This sync is
		// the single choke point for lesson changes, so it is the right place to enforce this.
		$owner  = [];
		$wanted = [];
		foreach ( $lessons as $l ) {
			if ( ! empty( $l['video'] ) ) { $wanted[] = sanitize_text_field( (string) $l['video'] ); }
		}
		$wanted = array_values( array_unique( $wanted ) );
		if ( $wanted ) {
			$place = implode( ',', array_fill( 0, count( $wanted ), '%s' ) );
			$owned = \AQ\Data::all(
				'SELECT video, course_id FROM ' . \AQ\Data::t( 'aq_lessons' )
				. ' WHERE id IN ( SELECT MIN(id) FROM ' . \AQ\Data::t( 'aq_lessons' )
				. " WHERE video IN ($place) GROUP BY video )",
				$wanted
			);
			foreach ( $owned as $row ) { $owner[ (string) $row['video'] ] = (int) $row['course_id']; }
		}

		// Desired sections, in order, sanitized exactly like the importers always did — minus any video that
		// already belongs to a DIFFERENT course (dropped here, never inserted).
		$desired = []; $skipped = [];
		$idx = 0; $total = 0;
		foreach ( $lessons as $l ) {
			if ( empty( $l['video'] ) ) { continue; }
			$video = sanitize_text_field( (string) $l['video'] );
			if ( isset( $owner[ $video ] ) && $owner[ $video ] !== $cid ) {
				$skipped[] = [ 'video' => $video, 'in_course' => $owner[ $video ] ];
				continue; // already owned by another course — never duplicate it here
			}
			$idx++;
			$dur = (int) ( $l['duration'] ?? 0 );
			$total += $dur;
			$desired[] = [
				'idx'        => $idx,
				'title'      => sanitize_text_field( (string) ( $l['title'] ?? ( 'Section ' . $idx ) ) ),
				'video'      => $video,
				'duration'   => $dur,
				'seg_start'  => (int) ( $l['seg_start'] ?? 0 ),
				'seg_end'    => (int) ( $l['seg_end'] ?? 0 ),
				'has_tr'     => array_key_exists( 'transcript', $l ),
				'transcript' => isset( $l['transcript'] ) ? (string) $l['transcript'] : null,
			];
		}

		$existing = \AQ\Data::all(
			'SELECT id, idx, title, video, duration, seg_start, seg_end, transcript FROM '
			. \AQ\Data::t( 'aq_lessons' ) . ' WHERE course_id = %d ORDER BY idx ASC, id ASC',
			[ $cid ]
		);

		// Pass 1: exact (video, seg_start, seg_end) — queues keep segment twins positional.
		$by_key = []; $by_vid = [];
		foreach ( $existing as $i => $e ) {
			$by_key[ $e['video'] . '|' . (int) $e['seg_start'] . '|' . (int) $e['seg_end'] ][] = $i;
			$by_vid[ $e['video'] ][] = $i;
		}
		$claimed = []; $match = []; // desired index → existing index
		foreach ( $desired as $di => $d ) {
			$k = $d['video'] . '|' . $d['seg_start'] . '|' . $d['seg_end'];
			while ( ! empty( $by_key[ $k ] ) ) {
				$ei = array_shift( $by_key[ $k ] );
				if ( isset( $claimed[ $ei ] ) ) { continue; }
				$claimed[ $ei ] = true; $match[ $di ] = $ei; break;
			}
		}
		// Pass 2: same video, different segment bounds (a retrim keeps its row + progress).
		foreach ( $desired as $di => $d ) {
			if ( isset( $match[ $di ] ) ) { continue; }
			while ( ! empty( $by_vid[ $d['video'] ] ) ) {
				$ei = array_shift( $by_vid[ $d['video'] ] );
				if ( isset( $claimed[ $ei ] ) ) { continue; }
				$claimed[ $ei ] = true; $match[ $di ] = $ei; break;
			}
		}

		$kept = 0; $moved = 0; $revideo = 0; $added_ids = []; $removed_ids = [];

		foreach ( $desired as $di => $d ) {
			if ( isset( $match[ $di ] ) ) {
				$e = $existing[ $match[ $di ] ];
				$fields = [];
				foreach ( [ 'idx', 'duration', 'seg_start', 'seg_end' ] as $f ) {
					if ( (int) $e[ $f ] !== (int) $d[ $f ] ) { $fields[ $f ] = (int) $d[ $f ]; }
				}
				if ( (string) $e['title'] !== $d['title'] ) { $fields['title'] = $d['title']; }
				if ( (string) $e['video'] !== $d['video'] ) { $fields['video'] = $d['video']; } // unreachable by construction; belt-and-braces
				if ( $d['has_tr'] && (string) $e['transcript'] !== (string) $d['transcript'] ) { $fields['transcript'] = $d['transcript']; }
				if ( $fields ) {
					\AQ\Data::update( 'aq_lessons', $fields, [ 'id' => (int) $e['id'] ] );
					if ( isset( $fields['idx'] ) ) { $moved++; }
					// A KEPT section whose VIDEO CONTENT changed in place — a segment retrim
					// (seg_start/seg_end), or defensively the swapped-id branch above — changes what that
					// section presents, exactly like adding/removing one, so it must reset the course's
					// rate history too. Without this a retrim slipped through as "kept" and left the rank
					// untouched (ticket #81: a video change in the Studio should reset the rank). A title-
					// or duration-only edit is NOT a video change, so it deliberately doesn't count here.
					if ( isset( $fields['video'] ) || isset( $fields['seg_start'] ) || isset( $fields['seg_end'] ) ) { $revideo++; }
				}
				$kept++;
			} else {
				$added_ids[] = (int) \AQ\Data::insert( 'aq_lessons', [
					'course_id'  => $cid,
					'idx'        => $d['idx'],
					'title'      => $d['title'],
					'video_type' => 'youtube',
					'video'      => $d['video'],
					'duration'   => $d['duration'],
					'seg_start'  => $d['seg_start'],
					'seg_end'    => $d['seg_end'],
					'transcript' => $d['transcript'],
					'created'    => time(), // when this section was added — gates the comment-trend churn's "≥1h old" drop rule
				] );
			}
		}

		foreach ( $existing as $ei => $e ) {
			if ( ! isset( $claimed[ $ei ] ) ) { $removed_ids[] = (int) $e['id']; }
		}
		if ( $removed_ids ) {
			$place = implode( ',', array_fill( 0, count( $removed_ids ), '%d' ) );
			$wpdb->query( $wpdb->prepare(
				'DELETE FROM ' . \AQ\Data::t( 'aq_lessons' ) . " WHERE course_id = %d AND id IN ($place)",
				array_merge( [ $cid ], $removed_ids )
			) );
		}

		\AQ\Data::update( 'aq_courses', [ 'lesson_count' => $idx, 'duration' => $total ], [ 'id' => $cid ] );

		// CONTENT-CHANGE RANK RESET (operator rule, 2026-06-12; broadened for ticket #81): ANY video
		// change to an ALREADY-POPULATED course resets its rate history. A lesson added or removed does —
		// and a video SWAP is modelled as remove-old + add-new, so it already did; ticket #81 adds the
		// remaining case, an in-place change to a KEPT section's video content (a segment retrim — see
		// $revideo), which used to slip through as "kept". On a reset, trend/rank_score go to ZERO now (the
		// course drops to the bottom of the trending list), the stored rate-history buckets (aq_course_stats,
		// behind the course page's "View growth" chart) are DROPPED, and trend_reset stamps the moment, which
		// YouTube::recompute_course_trend honours for 24h so the refresh cron can't restore the old rates.
		// Net effect: an edited course re-earns its rank from fresh measurement, and nothing that picks
		// "top trending" (members, ArtaCycle's video feeder) re-touches it within 24h. Idempotent
		// re-imports and pure reorders/retitles (no video content touched) deliberately do NOT reset.
		//
		// FIRST POPULATION IS NOT A CHANGE (ticket #82): when a course had NO prior lessons ($existing is
		// empty — a brand-new import, or a freshly-created Studio course getting its sections), every lesson
		// is counted as "added", but there is no OLD rate history to invalidate and no rank to protect.
		// Resetting here held newly imported courses at 0/hr for a full 24h, so their cards fell back to a
		// raw "X views" count instead of the gold "/hr" rate badge — even once their videos already had
		// measured rates. The importers explicitly recompute rank_score so a fresh course is "ranked right
		// away" (Extra::import_courses / import-courses-bulk), so initial population must NOT suppress it.
		$reset = $existing && ( $added_ids || $removed_ids || $revideo )
			&& \AQ\Schema::column_exists( $wpdb->prefix . 'aq_courses', 'trend_reset' );
		if ( $reset ) {
			\AQ\Data::update( 'aq_courses', [ 'trend' => 0, 'rank_score' => 0, 'trend_reset' => time() ], [ 'id' => $cid ] );
			// ...and DROP THE STORED RATE HISTORY ITSELF (ticket #81). Zeroing trend/rank_score only clears
			// the CURRENT rate; the course page's "View growth" chart (CourseGrowth / GET courses/{id}/stats)
			// is the aq_course_stats series, which kept every pre-change hourly bucket — so a member who
			// changed a video saw the rate-history chart completely unchanged ("I added 2 videos and the
			// history didn't change"). Drop this course's buckets so the chart genuinely restarts from the
			// change: the next YouTube::recompute_course_trend re-seeds a fresh first bucket once the
			// (re)measured videos get a live check (its last_refresh=0 guard holds the series blank until
			// then — an honest restart that matches the 24h trend hold above). Scoped to THIS course only:
			// aq_video_stats is per-VIDEO and shared across courses, so it's deliberately left intact.
			$wpdb->query( $wpdb->prepare(
				'DELETE FROM ' . \AQ\Data::t( 'aq_course_stats' ) . ' WHERE course_id = %d', [ $cid ]
			) );
		}

		return [
			'kept'         => $kept,
			'moved'        => $moved,
			'added'        => count( $added_ids ),
			'removed'      => count( $removed_ids ),
			'added_ids'    => $added_ids,
			'removed_ids'  => $removed_ids,
			'skipped'      => $skipped, // [{video, in_course}] dropped because already owned by another course
			'lesson_count' => $idx,
			'duration'     => $total,
			'reset'        => (bool) $reset,
		];
	}
}
