<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Courses and their sections (lessons). Reads come straight off the aq_courses/aq_lessons
 * tables (one indexed row / one ranged scan) and use denormalized counters, so a course page
 * never aggregates. The learning surface itself (comments + voting) lives in Learn; enrolment
 * and its entry fee live there too (Learn::enroll → Funds::course_cost). Reads are all public.
 */
final class Courses {

	/** GET /courses?cursor=&limit=&q=&sort= — keyset list. sort=trending ranks by the course score
	 *  (aq_courses.rank_score = avg per-video rolling-24h comment count ×100) instead of newest-first;
	 *  default is newest-first. The `trending` param name is kept stable for the client. */
	public static function list( $req ) {
		$limit  = Rest::pint( $req, 'limit', 24 );
		$q      = trim( (string) Rest::p( $req, 'q', '' ) );
		// Read topic early so the keyword expansion below can skip it when a filter is already active.
		$topic  = sanitize_key( (string) Rest::p( $req, 'topic', '' ) );
		$where  = "status = 'publish'";
		$args   = [];
		if ( $q !== '' ) {
			// Match the course title OR the channel/instructor name so searching a creator's name
			// surfaces their courses. When the query matches a topic keyword (e.g. "zoroastrianism"
			// → "humanities") and no explicit topic filter is active, also include courses from that
			// topic so keyword-based browsing works across the whole catalogue.
			$like    = '%' . $GLOBALS['wpdb']->esc_like( $q ) . '%';
			$kw_slug = Topics::is_valid( $topic ) ? Topics::OTHER : Topics::keyword_to_slug( $q );
			if ( $kw_slug !== Topics::OTHER ) {
				$where .= ' AND (title LIKE %s OR channel LIKE %s OR houses LIKE %s)';
				$args[] = $like; $args[] = $like; $args[] = '%,' . $GLOBALS['wpdb']->esc_like( $kw_slug ) . ',%';
			} else {
				$where .= ' AND (title LIKE %s OR channel LIKE %s)';
				$args[] = $like; $args[] = $like;
			}
		}
		// House facet (multi-discipline taxonomy, 2026-06): a course belongs to a HOUSE when ANY of its
		// disciplines sits in that house, so a course is genuinely cross-field and appears under each. The
		// membership is denormalized into the comma-wrapped `houses` CSV (",a,b,") so a SQLite-safe LIKE
		// selects it; the default unfiltered list still keysets on (status, rank_score, id).
		if ( Topics::is_valid( $topic ) ) {
			$where .= ' AND houses LIKE %s';
			$args[] = '%,' . $GLOBALS['wpdb']->esc_like( $topic ) . ',%';
		}
		// Second level: one specific DISCIPLINE within the house (the drill-down chip). Matches any course
		// LINKED to that discipline (multi), via the `disciplines` CSV. The shared drill-down passes it as
		// ?subtopic=; ?discipline= is also accepted. A discipline key is globally unique, so it validates
		// on its own (its house need not be re-sent).
		$disc = sanitize_key( (string) Rest::p( $req, 'subtopic', '' ) );
		if ( $disc === '' ) { $disc = sanitize_key( (string) Rest::p( $req, 'discipline', '' ) ); }
		if ( Topics::is_valid_disc( $disc ) ) {
			$where .= ' AND disciplines LIKE %s';
			$args[] = '%,' . $GLOBALS['wpdb']->esc_like( $disc ) . ',%';
		}
		// (house × sign) "2-gram" cell facets (2026-06-25) — the home recommender's STRICT drill-down.
		// ?house= matches the single PRIMARY house column (`topic = %s`), so each course sits in exactly
		// ONE cell — distinct from the catalogue's cross-listed ?topic= above (houses LIKE, a course shows
		// under every field it touches). ?sign= is the style half. Together with sort=trending they keyset
		// the (status, topic, sign, rank_score, id) index. Both additive — absent/invalid = list unchanged.
		$house = sanitize_key( (string) Rest::p( $req, 'house', '' ) );
		if ( Topics::is_valid( $house ) && $house !== Topics::OTHER ) {
			$where .= ' AND topic = %s';
			$args[] = $house;
		}
		$sign = sanitize_key( (string) Rest::p( $req, 'sign', '' ) );
		if ( Topics::is_sign( $sign ) ) {
			$where .= ' AND sign = %s';
			$args[] = $sign;
		}
		// Optional language facet (1.30.0): filter to courses in one language (?lang=fa). The
		// catalogue is overwhelmingly English today, so no param = everything (not lang='en').
		$lang = sanitize_key( (string) Rest::p( $req, 'lang', '' ) );
		if ( $lang !== '' && strlen( $lang ) <= 8 ) {
			$where .= ' AND lang = %s';
			$args[] = $lang;
		}
		$sort = (string) Rest::p( $req, 'sort', '' );
		if ( $sort === 'trending' ) {
			return self::list_trending( $req, $where, $args, $limit );
		}
		$cursor = Rest::pint( $req, 'cursor', 0 );
		[ $rows, $next ] = Data::page( 'aq_courses', $where, $args, $cursor, $limit );
		return [ 'items' => self::cards( $rows ), 'next' => $next, 'season_ends' => Season::current()['end'] ];
	}

	/**
	 * Ranked list: order by (rank_score DESC, trend DESC, id DESC) with a compound keyset cursor
	 * "score:trend:id" — proper keyset pagination (no OFFSET). `rank_score` is the course's rolling-24h
	 * comment rate (avg per-video YouTube comments/day ×100); `trend` is its cumulative YouTube comment
	 * TOTAL. A quiet course can still share rank_score 0 — the `trend` tiebreak then orders them by how
	 * discussed their videos are, so EVERY course ranks meaningfully (a high-momentum course leads; the
	 * rest sort by comment volume), never a flat tie. `id` is the final stable tiebreak. `next` is the
	 * opaque "score:trend:id" string to pass back as ?cursor.
	 */
	private static function list_trending( $req, $where, $args, $limit ) {
		global $wpdb;
		$limit = max( 1, min( 100, (int) $limit ) );
		$cur   = (string) Rest::p( $req, 'cursor', '' );
		$parts = $cur !== '' ? array_map( 'intval', explode( ':', $cur ) ) : [];
		if ( count( $parts ) === 3 ) {
			[ $cs, $ct, $cid ] = $parts;
			// keyset over (rank_score DESC, trend DESC, id DESC): strictly after the cursor tuple.
			$where .= ' AND (rank_score < %d OR (rank_score = %d AND (trend < %d OR (trend = %d AND id < %d))))';
			array_push( $args, $cs, $cs, $ct, $ct, $cid );
		}
		$args[] = $limit + 1;
		$rows = $wpdb->get_results(
			$wpdb->prepare( 'SELECT * FROM ' . Data::t( 'aq_courses' ) . " WHERE $where ORDER BY rank_score DESC, trend DESC, id DESC LIMIT %d", $args ),
			ARRAY_A
		) ?: [];
		$next = null;
		if ( count( $rows ) > $limit ) {
			$last = $rows[ $limit - 1 ];
			$next = (int) $last['rank_score'] . ':' . (int) $last['trend'] . ':' . (int) $last['id'];
			$rows = array_slice( $rows, 0, $limit );
		}
		return [ 'items' => self::cards( $rows ), 'next' => $next, 'season_ends' => Season::current()['end'] ];
	}

	/** GET /courses/topics — the subject facet list for the catalogue filter bar: every subject with
	 *  ≥1 published course + its count, in canonical order (one bounded GROUP BY; see Topics::facets).
	 *  Public + CDN-cacheable; the client prepends its own "All" chip. */
	public static function topics( $req ) {
		$items = Topics::facets();
		$total = 0;
		foreach ( $items as $i ) { $total += (int) $i['count']; }
		return [ 'items' => $items, 'total' => $total ];
	}

	/** GET /courses/{id} — full detail incl. lesson list (titles only, no transcripts). */
	public static function get( $req ) {
		$id = Rest::pint( $req, 'id' );
		$c  = Data::one( 'SELECT * FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $c ) { return Rest::err( 'not_found', 'Course not found', 404 ); }
		// `comment_count` is the section's denormalized board total (maintained on every section-comment
		// write) — carried here so each curriculum row badges its board WITHOUT a per-pageview GROUP BY
		// over a course's whole comment set (O(comments), unbounded on a popular course → O(lessons) read).
		$lessons = Data::all(
			'SELECT l.id, l.idx, l.title, l.duration, l.video_type, l.video, l.comment_count, v.rate AS vrate
			   FROM ' . Data::t( 'aq_lessons' ) . ' l
			   LEFT JOIN ' . Data::t( 'aq_videos' ) . ' v ON v.video = l.video
			  WHERE l.course_id = %d ORDER BY l.idx ASC',
			[ $id ]
		);
		$uid  = Rest::uid();
		// Per-section state for the curriculum sidebar: watched, fully engaged (✓ = watched +
		// commented + upvoted), and whether the section is still locked (an earlier one unwatched).
		// Per-user, but this GET is no-store when authed (Rest::dispatch).
		$state = Learn::section_state( $uid, $id );
		$out = self::card( $c );
		$out['summary']  = (string) $c['summary'];
		// Channel identity for the course header (logo / link / verified badge) — resolved from the
		// sections' cached yt meta. A course's sections can mix channels (guest videos), so only a
		// meta whose channel name matches the course's stored channel is trusted: never pair the
		// course's name with another channel's logo. The lesson endpoint exposes the same fields
		// per-video (yt_meta); these are the course-level ones the detail page header renders.
		$chan = self::channel_meta( (string) $c['channel'], array_column( $lessons, 'video' ) );
		$out['channel_url']      = $chan['url'];
		$out['channel_avatar']   = $chan['avatar'];
		$out['channel_verified'] = $chan['verified'];
		// Course OWNER (the member it was created under — /u/<slug>): every pipeline course belongs
		// to the operator's account (`aq_course_author_uid`, 2026-06-12). The detail-page byline
		// renders THIS (name + avatar, linked to the member profile) — the source CHANNEL above
		// stays available as the content credit.
		$au = get_userdata( (int) $c['author_id'] );
		// avatar '' when none genuinely exists, so the byline shows the SPA's initial-disc fallback
		// rather than an empty circle — Verify::avatar_url() handles the d=blank gravatar pitfall
		// uniformly with every other surface (ticket #113).
		$out['author'] = $au ? [ 'name' => $au->display_name, 'slug' => $au->user_nicename,
			'avatar' => Verify::avatar_url( (int) $c['author_id'], 64 ) ] : null;
		$out['lessons']  = array_map( function ( $l ) use ( $state ) {
			$s = $state[ (int) $l['id'] ] ?? [ 'done' => false, 'complete' => false, 'locked' => false ];
			return [ 'id' => (int) $l['id'], 'idx' => (int) $l['idx'], 'title' => $l['title'], 'duration' => (int) $l['duration'],
				'comments' => (int) $l['comment_count'],
				'video' => (string) $l['video'],                              // the YouTube id — keys the section's own rate sparkline
				'comments_per_day' => round( (int) $l['vrate'] / 100, 1 ),    // this video's current trailing-24h comment rate ("X/day")
				'done' => ! empty( $s['done'] ), 'complete' => ! empty( $s['complete'] ), 'locked' => ! empty( $s['locked'] ) ];
		}, $lessons );
		$out['enrolled'] = self::is_enrolled( $uid, $id );
		// Resume target: once a learner has completed ≥1 lesson, point "Start course" at the first
		// lesson they haven't finished (so it becomes "Resume"); null otherwise (new learner / done).
		$out['resume'] = null;
		if ( $out['enrolled'] && $uid ) {
			$done = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_progress' ) . ' WHERE user_id = %d AND course_id = %d AND done = 1', [ $uid, $id ] );
			if ( $done > 0 ) {
				$rl = (int) Data::col(
					'SELECT id FROM ' . Data::t( 'aq_lessons' ) . ' WHERE course_id = %d
					   AND id NOT IN ( SELECT lesson_id FROM ' . Data::t( 'aq_progress' ) . ' WHERE user_id = %d AND course_id = %d AND done = 1 )
					 ORDER BY idx ASC LIMIT 1',
					[ $id, $uid, $id ]
				);
				if ( $rl ) { $out['resume'] = '/video/?video=' . $rl; }
			}
		}
		return $out;
	}

	/** GET /courses/slug/{slug} — same as get() but keyed by slug (SPA routes use slugs). */
	public static function by_slug( $req ) {
		$slug = sanitize_title( (string) Rest::p( $req, 'slug', '' ) );
		$id   = (int) Data::col( 'SELECT id FROM ' . Data::t( 'aq_courses' ) . ' WHERE slug = %s', [ $slug ] );
		if ( ! $id ) { return Rest::err( 'not_found', 'Course not found', 404 ); }
		$req->set_param( 'id', $id );
		return self::get( $req );
	}

	/** GET /lessons/{id} — one section: the video segment + this learner's engagement state
	 *  (locked / watched / commented / upvoted / engaged). The discussion board itself is its
	 *  own endpoint (Learn::section_thread). */
	public static function lesson( $req ) {
		$id = Rest::pint( $req, 'id' );
		$l  = Data::one( 'SELECT * FROM ' . Data::t( 'aq_lessons' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $l ) { return Rest::err( 'not_found', 'Video not found', 404 ); }
		$uid = Rest::uid();
		$cid = (int) $l['course_id'];
		$st  = $uid ? ( Learn::progress_map( $uid, $cid )[ $id ] ?? null ) : null;
		return [
			'id'           => (int) $l['id'],
			'course_id'    => $cid,
			'idx'          => (int) $l['idx'],
			'title'        => $l['title'],
			'video_type'   => $l['video_type'],
			'video'        => $l['video'],
			'duration'     => (int) $l['duration'],
			'seg_start'    => (int) $l['seg_start'],
			'seg_end'      => (int) $l['seg_end'],
			'yt'           => self::yt_meta( $l['video'] ),
			'locked'       => Learn::is_locked( $uid, $cid, $id ),
			'watched'      => $st ? (bool) $st['done'] : false,
			'commented'    => $st ? (bool) $st['commented'] : false,
			'upvoted'      => $st ? (bool) $st['upvoted'] : false,
			'engaged'      => $st ? (bool) $st['engaged'] : false,
		];
	}

	/** GET /courses/{id}/reviews — list reviews + the viewer's own (if any) + the average. */
	public static function reviews( $req ) {
		$cid  = Rest::pint( $req, 'id' );
		$rows = Data::all(
			'SELECT r.user_id, r.rating, r.body, r.created FROM ' . Data::t( 'aq_reviews' ) . ' r WHERE r.course_id = %d ORDER BY r.id DESC LIMIT 100',
			[ $cid ]
		);
		$c = Data::one( 'SELECT rating_sum, rating_n FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		$n = $c ? (int) $c['rating_n'] : 0;
		$uid = Rest::uid();
		return [
			'average' => $n ? round( $c['rating_sum'] / $n, 1 ) : 0,
			'count'   => $n,
			'can_review' => $uid ? self::is_enrolled( $uid, $cid ) : false,
			'mine'    => $uid ? ( function () use ( $uid, $cid ) {
				$m = Data::one( 'SELECT rating, body FROM ' . Data::t( 'aq_reviews' ) . ' WHERE user_id = %d AND course_id = %d', [ $uid, $cid ] );
				return $m ? [ 'rating' => (int) $m['rating'], 'body' => (string) $m['body'] ] : null;
			} )() : null,
			'items'   => array_map( function ( $r ) {
				$u = get_userdata( (int) $r['user_id'] );
				return [ 'author' => $u ? $u->display_name : 'Quester', 'slug' => $u ? $u->user_nicename : '',
					'avatar' => Verify::avatar_url( (int) $r['user_id'], 64 ),
					'rating' => (int) $r['rating'], 'body' => (string) $r['body'], 'at' => (int) $r['created'] ];
			}, $rows ),
		];
	}

	/** POST /courses/{id}/review {rating, body} — upsert your review; recompute the course average. */
	public static function add_review( $req ) {
		$uid = Rest::uid();
		$cid = Rest::pint( $req, 'id' );
		if ( $err = Verify::require_identity( $uid ) ) { return $err; }
		if ( ! self::is_enrolled( $uid, $cid ) ) { return Rest::err( 'not_enrolled', 'Enrol first to review this course.', 403 ); }
		$rating = max( 1, min( 5, Rest::pint( $req, 'rating', 5 ) ) );
		$body   = wp_kses_post( (string) Rest::p( $req, 'body', '' ) );
		Data::upsert( 'aq_reviews', [ 'user_id' => $uid, 'course_id' => $cid ], [ 'rating' => $rating, 'body' => $body, 'created' => Data::now() ] );
		// Recompute the denormalized rating aggregate from the source rows.
		$agg = Data::one( 'SELECT COUNT(*) n, COALESCE(SUM(rating),0) s FROM ' . Data::t( 'aq_reviews' ) . ' WHERE course_id = %d', [ $cid ] );
		Data::update( 'aq_courses', [ 'rating_n' => (int) $agg['n'], 'rating_sum' => (int) $agg['s'] ], [ 'id' => $cid ] );
		return [ 'ok' => true, 'average' => (int) $agg['n'] ? round( $agg['s'] / $agg['n'], 1 ) : 0, 'count' => (int) $agg['n'] ];
	}

	/** POST /courses — minimal authoring (title, summary, image). Author = current user. */
	public static function create( $req ) {
		if ( Rest::throttle( 'course_create', 10, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$title = sanitize_text_field( (string) Rest::p( $req, 'title', '' ) );
		if ( $title === '' ) { return Rest::err( 'bad_input', 'Title required' ); }
		$uid     = Rest::uid();
		$summary = wp_kses_post( (string) Rest::p( $req, 'summary', '' ) );
		// Classify the new course into a subject (and, under it, a sub-subject) up front, so it filters
		// at BOTH levels in the catalogue immediately (the migration backfill only sweeps older rows).
		$topic    = Topics::classify( $title, '', $summary );
		$subtopic = Topics::classify_sub( $topic, $title, '', $summary );
		// Denormalize the discovery membership (the houses/disciplines CSVs the facet list + ?topic= filter
		// match on — NOT `topic`), else a just-classified course is invisible to every topic filter (#155).
		$mem = Topics::membership( $topic, $subtopic );
		$id  = Data::insert( 'aq_courses', [
			'slug'        => self::slug( $title ),
			'title'       => $title,
			'summary'     => $summary,
			'image'       => esc_url_raw( (string) Rest::p( $req, 'image', '' ) ),
			'author_id'   => $uid,
			'topic'       => $topic,
			'subtopic'    => $subtopic,
			'houses'      => $mem['houses'],
			'disciplines' => $mem['disciplines'],
			'status'      => 'publish',
			'created'     => Data::now(),
		] );
		return [ 'id' => $id ];
	}

	/** POST /courses/{id}/update {title?, summary?, image?, topic?, subtopic?, search_terms?, channel?,
	 *  lang?, status?} — edit course meta. Permitted for the course's OWNER holding any creator rung, or an
	 *  operator ("creator tiers have all edit access to their courses" — operator rule 2026-06-12; gate =
	 *  Extra::can_edit_course). Every authoring field is editable here; only DERIVED/ledger columns
	 *  (lesson_count, enroll_count, duration, revenue, price, views, trend, rank_score, …) stay
	 *  system-maintained — hand-editing them would break the invariants they denormalize. */
	public static function update( $req ) {
		$uid = Rest::uid();
		$cid = (int) Rest::p( $req, 'id', 0 );
		if ( ! Data::col( 'SELECT id FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] ) ) { return Rest::err( 'not_found', 'Course not found', 404 ); }
		if ( ! Extra::can_edit_course( $uid, $cid ) ) { return Rest::err( 'forbidden', 'Only the course creator can edit it', 403 ); }
		$fields = [];
		$title = sanitize_text_field( (string) Rest::p( $req, 'title', '' ) );
		if ( $title !== '' ) { $fields['title'] = $title; } // slug deliberately stays — it's the public URL
		if ( Rest::p( $req, 'summary', null ) !== null ) { $fields['summary'] = wp_kses_post( (string) Rest::p( $req, 'summary', '' ) ); }
		if ( Rest::p( $req, 'image', null ) !== null )   { $fields['image'] = esc_url_raw( (string) Rest::p( $req, 'image', '' ) ); }
		// Source byline (the channel shown as the instructor) — editable; pipeline-set by default.
		if ( Rest::p( $req, 'channel', null ) !== null ) { $fields['channel'] = sanitize_text_field( (string) Rest::p( $req, 'channel', '' ) ); }
		// Per-course DISCOVERY KEYWORDS the aq_discover crawler searches by (empty = fall back to the title).
		if ( Rest::p( $req, 'search_terms', null ) !== null ) { $fields['search_terms'] = mb_substr( sanitize_text_field( (string) Rest::p( $req, 'search_terms', '' ) ), 0, 255 ); }
		// Course language (i18n routing) — a short BCP-47-ish code; validated to letters/hyphen, ≤8 chars.
		$lang = strtolower( preg_replace( '/[^a-zA-Z-]/', '', (string) Rest::p( $req, 'lang', '' ) ) );
		if ( $lang !== '' && strlen( $lang ) <= 8 ) { $fields['lang'] = $lang; }
		// Publish ↔ draft: a creator can unpublish (hide from every public list) and re-publish their course.
		$status = sanitize_key( (string) Rest::p( $req, 'status', '' ) );
		if ( in_array( $status, [ 'publish', 'draft' ], true ) ) { $fields['status'] = $status; }
		$topic = sanitize_title( (string) Rest::p( $req, 'topic', '' ) );
		if ( $topic !== '' && Topics::is_valid( $topic ) ) { $fields['topic'] = $topic; }
		// Sub-subject (ticket #89): validated against the EFFECTIVE house — the one being set this call,
		// else the stored one. If the house is changing and no valid new sub was supplied, clear the old
		// sub so a now-cross-house value can't linger (it would never match the new house's filter).
		$subtopic = sanitize_title( (string) Rest::p( $req, 'subtopic', '' ) );
		$house    = $fields['topic'] ?? (string) Data::col( 'SELECT topic FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		if ( $subtopic !== '' && Topics::is_valid_sub( $house, $subtopic ) ) {
			$fields['subtopic'] = $subtopic;
		} elseif ( isset( $fields['topic'] ) ) {
			$fields['subtopic'] = '';
		}
		// Keep the denormalized discovery membership (the `houses`/`disciplines` CSVs the catalogue facet +
		// ?topic=/?subtopic= filters match on) in lockstep whenever the house or discipline changes, so an
		// edited course never drops out of — or lingers in the wrong — topic filter (ticket #155). $house is
		// the effective (new-or-stored) house; the effective sub is the just-set value, else the stored one.
		if ( isset( $fields['topic'] ) || array_key_exists( 'subtopic', $fields ) ) {
			$eff_sub = array_key_exists( 'subtopic', $fields )
				? (string) $fields['subtopic']
				: (string) Data::col( 'SELECT subtopic FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
			$mem = Topics::membership( $house, $eff_sub );
			$fields['houses']      = $mem['houses'];
			$fields['disciplines'] = $mem['disciplines'];
		}
		if ( ! $fields ) { return Rest::err( 'bad_input', 'Nothing to update' ); }
		Data::update( 'aq_courses', $fields, [ 'id' => $cid ] );
		return [ 'ok' => true, 'updated' => array_keys( $fields ) ];
	}

	/** POST /courses/{id}/lessons {lessons: [{title, video, duration, seg_start?, seg_end?,
	 *  transcript?}, …]} — full content edit (add / remove / reorder / retitle) for the course's
	 *  OWNER (any creator rung) or an operator. Runs through the ID-PRESERVING sync, so existing
	 *  lessons keep their ids (progress/boards/votes survive) and any video change — add / remove /
	 *  swap / retrim — triggers the standard trend_reset (the course re-earns its rank — same rule as
	 *  the pipeline; `reset` in the response says whether it fired). */
	public static function update_lessons( $req ) {
		$uid = Rest::uid();
		$cid = (int) Rest::p( $req, 'id', 0 );
		if ( ! Data::col( 'SELECT id FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] ) ) { return Rest::err( 'not_found', 'Course not found', 404 ); }
		if ( ! Extra::can_edit_course( $uid, $cid ) ) { return Rest::err( 'forbidden', 'Only the course creator can edit it', 403 ); }
		$spec = Rest::p( $req, 'lessons', null );
		if ( ! is_array( $spec ) || ! $spec || count( $spec ) > 100 ) { return Rest::err( 'bad_input', 'Send 1-100 lessons' ); }
		foreach ( $spec as $l ) {
			if ( ! is_array( $l ) || empty( $l['video'] ) || ! preg_match( '/^[A-Za-z0-9_-]{6,20}$/', (string) $l['video'] ) ) {
				return Rest::err( 'bad_input', 'Each lesson needs a valid YouTube video id' );
			}
		}
		require_once WP_PLUGIN_DIR . '/aquest/tools/lesson-sync.inc.php';
		$r = aq_sync_lessons( $cid, $spec ); // sanitizes fields itself; stamps trend_reset on any video change (add/remove/swap/retrim); drops any video already in another course
		YouTube::sync_registry();            // register any new videos with the hourly monitor
		YouTube::recompute_course_trend( $cid );
		// `skipped` = videos the editor listed that already belong to ANOTHER course (a video lives in at most
		// one course) — returned so the UI can tell the owner why those did not appear.
		return [ 'ok' => true, 'kept' => $r['kept'], 'added' => $r['added'], 'removed' => $r['removed'], 'skipped' => $r['skipped'], 'reset' => $r['reset'], 'lesson_count' => $r['lesson_count'] ];
	}

	/** POST /courses/{id}/delete — permanently delete a course, for its OWNER (any creator rung) or
	 *  an operator. REFUSED once any OTHER member is enrolled: their entry fee funds the prize pool
	 *  and their progress/certificate must survive — and since nothing ever un-enrols, that refusal
	 *  is permanent. While only the creator (or nobody) is enrolled, every board comment and vote is
	 *  necessarily their own (posting + voting require enrolment), so deletion destroys nothing of
	 *  anyone else's. Hard delete — same precedent as Social::thread_delete — so /data/ never
	 *  accumulates rows aimed at nothing. NEVER touched: the append-only ledgers (charges that
	 *  happened stay history; no refunds here), frozen aq_season_results (settled seasons are
	 *  immutable), and the video monitor (aq_videos / aq_video_stats are per-VIDEO, not per-course — a
	 *  row can outlive any one course as a measurement candidate, and lesson removal never prunes it). The slug is
	 *  tombstoned (Extra::tombstone_course) so the deploy-time bundle reseed never resurrects it (#83). */
	public static function delete( $req ) {
		global $wpdb;
		$uid = Rest::uid();
		$cid = Rest::pint( $req, 'id' );
		$c   = Data::one( 'SELECT id, author_id, slug FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		if ( ! $c ) { return Rest::err( 'not_found', 'Course not found', 404 ); }
		if ( ! Extra::can_edit_course( $uid, $cid ) ) { return Rest::err( 'forbidden', 'Only the course creator can delete it', 403 ); }
		$others = (int) Data::col(
			'SELECT COUNT(*) FROM ' . Data::t( 'aq_enroll' ) . ' WHERE course_id = %d AND user_id <> %d',
			[ $cid, (int) $c['author_id'] ]
		);
		if ( $others > 0 ) {
			return Rest::err( 'has_learners', 'Other members have enrolled in this course — their entry fees fund its prize pool and their progress must survive, so it can no longer be deleted.', 409 );
		}
		// Take the vote rows with the content they pointed at (votes first — the IN() needs the
		// comments still present; comments before lessons for the same reason).
		$wpdb->query( $wpdb->prepare(
			'DELETE FROM ' . Data::t( 'aq_votes' ) . " WHERE target_type = 'comment' AND target_id IN ( SELECT id FROM " . Data::t( 'aq_comments' ) . " WHERE context_type = 'section' AND context_id IN ( SELECT id FROM " . Data::t( 'aq_lessons' ) . ' WHERE course_id = %d ) )',
			$cid
		) );
		$wpdb->query( $wpdb->prepare(
			'DELETE FROM ' . Data::t( 'aq_comments' ) . " WHERE context_type = 'section' AND context_id IN ( SELECT id FROM " . Data::t( 'aq_lessons' ) . ' WHERE course_id = %d )',
			$cid
		) );
		$wpdb->delete( Data::t( 'aq_progress' ), [ 'course_id' => $cid ] );
		$wpdb->delete( Data::t( 'aq_enroll' ), [ 'course_id' => $cid ] );   // owner's own row at most (guard above)
		$wpdb->delete( Data::t( 'aq_reviews' ), [ 'course_id' => $cid ] );
		$wpdb->delete( Data::t( 'aq_quester' ), [ 'course_id' => $cid ] );  // projection — rebuildable, would orphan
		$wpdb->delete( Data::t( 'aq_course_stats' ), [ 'course_id' => $cid ] ); // the course's own growth series
		$wpdb->delete( Data::t( 'aq_lessons' ), [ 'course_id' => $cid ] );
		$wpdb->delete( Data::t( 'aq_courses' ), [ 'id' => $cid ] );
		// Persist the deletion against the deploy-time bundle reseed: tombstone the slug so
		// Extra::import_courses never re-creates this course on a later push (ticket #83).
		Extra::tombstone_course( (string) $c['slug'] );
		return [ 'ok' => true, 'id' => $cid ];
	}

	/** GET /studio/courses — the signed-in creator's own courses (operators see the whole catalogue
	 *  — they own it). Powers the Studio page's course list. */
	public static function studio_list( $req ) {
		$uid = Rest::uid();
		$r   = Extra::creator_rank( $uid );
		if ( empty( $r['caps']['can_create'] ) ) { return Rest::err( 'forbidden', 'Reach the Creator tier (1,000 points) to use the Studio', 403 ); }
		// Operators manage the WHOLE catalogue from the Studio; a creator sees only their own courses.
		$op   = user_can( $uid, 'manage_options' );
		$rows = $op
			? Data::all( 'SELECT id, slug, title, image, lesson_count, duration FROM ' . Data::t( 'aq_courses' ) . " WHERE status = 'publish' ORDER BY title ASC LIMIT 1000" )
			: Data::all( 'SELECT id, slug, title, image, lesson_count, duration FROM ' . Data::t( 'aq_courses' ) . " WHERE author_id = %d AND status = 'publish' ORDER BY title ASC LIMIT 500", [ $uid ] );
		// The "/day" badge = the LIVE average of each course's videos' rolling comment rates (live_rates),
		// NOT the stored rank_score: rank_score is frozen at 0 for 24h after any video edit, and a routine
		// catalogue re-sync freezes nearly every course at once, so reading it dropped the badge from the
		// creator's own cards mid-cooldown even while their videos drew steady discussion (ticket #105 — the
		// same conflation the catalogue cards already fixed). Batched in one query over the whole page.
		$rates = self::live_rates( array_map( fn( $c ) => (int) $c['id'], $rows ) );
		return [ 'items' => array_map( fn( $c ) => [
			'id' => (int) $c['id'], 'slug' => (string) $c['slug'], 'title' => (string) $c['title'],
			'image' => (string) $c['image'], 'lessons' => (int) $c['lesson_count'],
			'price' => Funds::cost_for_videos( (int) $c['lesson_count'] ), // 1 coin per video, min ₳1 (Funds::course_cost)
			'comments_per_day' => round( ( $rates[ (int) $c['id'] ] ?? 0 ) / 100, 1 ),
		], $rows ), 'total' => count( $rows ), 'scope' => $op ? 'all' : 'own' ];
	}

	/** GET /studio/courses/{id} — the FULL edit payload for one of the creator's courses: meta plus
	 *  lessons WITH their video ids (the public lesson list omits them). Gated like the edits. */
	public static function studio_get( $req ) {
		$uid = Rest::uid();
		$cid = (int) Rest::p( $req, 'id', 0 );
		$c   = Data::one( 'SELECT id, slug, title, summary, image, topic, subtopic, search_terms, channel, lang, status FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		if ( ! $c ) { return Rest::err( 'not_found', 'Course not found', 404 ); }
		if ( ! Extra::can_edit_course( $uid, $cid ) ) { return Rest::err( 'forbidden', 'Only the course creator can edit it', 403 ); }
		// Lessons carry their video's live comment rate (centi/day ÷100) so the editor doubles as a per-video monitor.
		$lessons = Data::all( 'SELECT l.id, l.idx, l.title, l.video, l.duration, l.seg_start, l.seg_end, COALESCE(v.rate,0) AS rate FROM ' . Data::t( 'aq_lessons' ) . ' l LEFT JOIN ' . Data::t( 'aq_videos' ) . ' v ON v.video = l.video WHERE l.course_id = %d ORDER BY l.idx ASC', [ $cid ] );
		// Any candidate currently incubating for this course (the prove-then-add experiment), for the health panel.
		$cands = Data::all( 'SELECT video, rate, cand_baseline, cand_until FROM ' . Data::t( 'aq_videos' ) . ' WHERE cand_course = %d ORDER BY cand_until ASC', [ $cid ] );
		return [
			'id' => (int) $c['id'], 'slug' => (string) $c['slug'], 'title' => (string) $c['title'],
			'summary' => (string) $c['summary'], 'image' => (string) $c['image'], 'topic' => (string) $c['topic'],
			'subtopic' => (string) ( $c['subtopic'] ?? '' ),
			'search_terms' => (string) ( $c['search_terms'] ?? '' ), 'channel' => (string) ( $c['channel'] ?? '' ),
			'lang' => (string) ( $c['lang'] ?? 'en' ), 'status' => (string) ( $c['status'] ?? 'publish' ),
			'lessons' => array_map( fn( $l ) => [
				'id' => (int) $l['id'], 'title' => (string) $l['title'], 'video' => (string) $l['video'],
				'duration' => (int) $l['duration'], 'seg_start' => (int) $l['seg_start'], 'seg_end' => (int) $l['seg_end'],
				'rate' => round( (int) $l['rate'] / 100, 2 ), // comments/day
			], $lessons ),
			'candidates' => array_map( fn( $x ) => [
				'video' => (string) $x['video'], 'rate' => round( (int) $x['rate'] / 100, 2 ),
				'baseline' => round( (int) $x['cand_baseline'] / 100, 2 ), 'ripe_in' => (int) $x['cand_until'] - time(),
			], $cands ),
		];
	}

	/** POST /courses/{id}/discover — "find a video now" for this course (owner/operator): search its tuned
	 *  keywords and TRACK the best fresh candidate, to be proven over the 24h hold by settle. Bounded by the
	 *  daily quota; no-ops if a candidate is already incubating for the course. */
	public static function course_discover( $req ) {
		$uid = Rest::uid(); $cid = (int) Rest::p( $req, 'id', 0 );
		if ( ! Extra::can_edit_course( $uid, $cid ) ) { return Rest::err( 'forbidden', 'Only the course creator can do this', 403 ); }
		return array_merge( [ 'ok' => true ], YouTube::discover_course( $cid ) );
	}

	/** POST /courses/{id}/recompute — re-derive this course's rank + thumbnail from its videos' current rates. */
	public static function course_recompute( $req ) {
		$uid = Rest::uid(); $cid = (int) Rest::p( $req, 'id', 0 );
		if ( ! Extra::can_edit_course( $uid, $cid ) ) { return Rest::err( 'forbidden', 'Only the course creator can do this', 403 ); }
		YouTube::recompute_course_trend( $cid );
		return [ 'ok' => true ];
	}

	/** POST /courses/{id}/refresh — refresh this course's videos' YouTube comment counts + rates right now
	 *  (one cheap videos.list call), so the editor's per-video rates reflect the latest measurement. */
	public static function course_refresh( $req ) {
		$uid = Rest::uid(); $cid = (int) Rest::p( $req, 'id', 0 );
		if ( ! Extra::can_edit_course( $uid, $cid ) ) { return Rest::err( 'forbidden', 'Only the course creator can do this', 403 ); }
		$vids = Data::all( 'SELECT DISTINCT video FROM ' . Data::t( 'aq_lessons' ) . " WHERE course_id = %d AND video <> ''", [ $cid ] );
		$n = YouTube::refresh_ids( array_map( fn( $v ) => (string) $v['video'], $vids ) );
		return [ 'ok' => true, 'refreshed' => (int) $n ];
	}

	/** GET courses/{id}/insights — the course's performance analytics for its creator (or an operator):
	 *  reach (enrolments + certificates), discussion volume (section comments + the upvotes they drew),
	 *  the economy (entry-fee revenue + the 80% prize pool), the rating, and the top questers with their
	 *  podium prizes. Gated like the edits. */
	public static function insights( $req ) {
		$uid = Rest::uid(); $cid = (int) Rest::p( $req, 'id', 0 );
		if ( ! Extra::can_edit_course( $uid, $cid ) ) { return Rest::err( 'forbidden', 'Only the course creator can view this', 403 ); }
		$c = Data::one( 'SELECT revenue, rating_n, rating_sum FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		if ( ! $c ) { return Rest::err( 'not_found', 'Course not found', 404 ); }
		// Count enrolments + certificates straight from aq_enroll (the source of truth) so they're always
		// consistent (certificates ≤ enrolments) — the denormalized aq_courses.enroll_count can drift.
		$enrolled = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_enroll' ) . ' WHERE course_id = %d', [ $cid ] );
		$certs    = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_enroll' ) . ' WHERE course_id = %d AND pct >= %d', [ $cid, Learn::PASS_PCT ] );
		$comments = (int) Data::col( "SELECT COUNT(*) FROM " . Data::t( 'aq_comments' ) . " WHERE context_type='section' AND context_id IN ( SELECT id FROM " . Data::t( 'aq_lessons' ) . " WHERE course_id = %d )", [ $cid ] );
		$votes    = (int) Data::col( "SELECT COUNT(*) FROM " . Data::t( 'aq_votes' ) . " WHERE target_type='comment' AND target_id IN ( SELECT id FROM " . Data::t( 'aq_comments' ) . " WHERE context_type='section' AND context_id IN ( SELECT id FROM " . Data::t( 'aq_lessons' ) . " WHERE course_id = %d ) )", [ $cid ] );
		$pool  = Economy::reward_pool( (int) $c['revenue'] );
		$board = array_slice( (array) Economy::podium( $cid, $pool ), 0, 5 );
		$names = [];
		$ids   = array_values( array_filter( array_map( fn( $r ) => (int) $r['user_id'], $board ) ) );
		if ( $ids ) {
			global $wpdb; $ph = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
			foreach ( $wpdb->get_results( $wpdb->prepare( "SELECT ID, display_name, user_nicename FROM {$wpdb->users} WHERE ID IN ($ph)", $ids ) ) as $u ) {
				$names[ (int) $u->ID ] = [ 'name' => (string) $u->display_name, 'slug' => (string) $u->user_nicename ];
			}
		}
		return [
			'enrollments' => $enrolled, 'certificates' => $certs,
			'comments' => $comments, 'votes' => $votes,
			'revenue' => (int) $c['revenue'], 'prize_pool' => $pool,
			'rating' => (int) $c['rating_n'] ? round( (int) $c['rating_sum'] / (int) $c['rating_n'], 1 ) : 0, 'rating_n' => (int) $c['rating_n'],
			'leaders' => array_map( fn( $r ) => [
				'name'  => $names[ (int) $r['user_id'] ]['name'] ?? ( 'Member #' . (int) $r['user_id'] ),
				'slug'  => $names[ (int) $r['user_id'] ]['slug'] ?? '',
				'votes' => (int) $r['votes'], 'prize' => (int) $r['prize'],
			], $board ),
		];
	}

	/** POST courses/{id}/import-playlist {url} — add a whole YouTube playlist's videos to this course in one
	 *  go (owner/operator), so a creator builds a course from a playlist instead of pasting ids one by one.
	 *  Each video is validated (≥2 min, embeddable, public) and run through the ID-preserving, cross-course-
	 *  unique sync; already-present videos are kept. Returns counts. */
	public static function import_playlist( $req ) {
		$uid = Rest::uid(); $cid = (int) Rest::p( $req, 'id', 0 );
		if ( ! Extra::can_edit_course( $uid, $cid ) ) { return Rest::err( 'forbidden', 'Only the course creator can edit it', 403 ); }
		if ( Rest::throttle( 'playlist_import', 20, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$url = (string) Rest::p( $req, 'url', '' );
		$pl  = preg_match( '/[?&]list=([A-Za-z0-9_-]+)/', $url, $m ) ? $m[1] : preg_replace( '/[^A-Za-z0-9_-]/', '', $url );
		if ( $pl === '' ) { return Rest::err( 'bad_input', 'Paste a YouTube playlist URL' ); }
		$items = YouTube::playlist_video_ids( $pl, 50 );
		if ( $items === null ) { return Rest::err( 'youtube', 'Could not read that playlist (the YouTube API must be configured and the playlist public).' ); }
		if ( ! $items ) { return Rest::err( 'empty', 'That playlist has no videos.' ); }
		$titles = []; foreach ( $items as $it ) { $titles[ $it['id'] ] = (string) $it['title']; }
		$ids = array_keys( $titles );
		$details = YouTube::video_details( $ids ); // seconds / embeddable / public, ≤50 in one unit
		if ( $details === null ) { return Rest::err( 'youtube', 'Could not verify the playlist videos — please try again.' ); }
		require_once WP_PLUGIN_DIR . '/aquest/tools/lesson-sync.inc.php';
		$existing = Data::all( 'SELECT title, video, duration, seg_start, seg_end FROM ' . Data::t( 'aq_lessons' ) . " WHERE course_id = %d AND video <> '' ORDER BY idx ASC, id ASC", [ $cid ] );
		$spec = []; $have = [];
		foreach ( $existing as $e ) {
			$have[ (string) $e['video'] ] = true;
			$spec[] = [ 'title' => (string) $e['title'], 'video' => (string) $e['video'], 'duration' => (int) $e['duration'], 'seg_start' => (int) $e['seg_start'], 'seg_end' => (int) $e['seg_end'] ];
		}
		$skipped = 0;
		foreach ( $ids as $v ) {
			if ( isset( $have[ $v ] ) ) { continue; }
			$d = $details[ $v ] ?? null;
			if ( ! $d || (int) $d['seconds'] < YouTube::CAND_MIN_SECONDS || ! $d['embeddable'] || ! $d['public'] ) { $skipped++; continue; }
			$spec[] = [ 'title' => mb_substr( $titles[ $v ] !== '' ? $titles[ $v ] : 'New video', 0, 200 ), 'video' => $v, 'duration' => (int) $d['seconds'] ];
			$have[ $v ] = true;
		}
		$r = aq_sync_lessons( $cid, $spec );
		YouTube::sync_registry();
		YouTube::recompute_course_trend( $cid );
		return [ 'ok' => true, 'added' => (int) $r['added'], 'removed' => (int) $r['removed'],
			'skipped_unplayable' => $skipped, 'skipped_other_course' => count( (array) $r['skipped'] ), 'lesson_count' => (int) $r['lesson_count'] ];
	}

	// ── shaping + helpers ───────────────────────────────────────────────────

	/**
	 * A course's LIVE discussion rate for DISPLAY: the average of its videos' rolling comment rates
	 * (aq_videos.rate, centi-comments/day ×100), computed STRAIGHT FROM THE VIDEOS — never from
	 * aq_courses.rank_score. rank_score is deliberately held at 0 for 24h after ANY video edit
	 * (recompute_course_trend's churn cooldown), and routine catalogue re-syncs leave almost every
	 * course inside that window at once, so a card that read rank_score showed 0 and dropped its gold
	 * "/day" badge for a raw comment total even while the videos had healthy live rates (ticket #105).
	 * This is the SAME conflation #102 fixed for the course header (YouTube::course_comment_history):
	 * the cooled rank_score is right for the trending SORT, the live rate is right for DISPLAY. Averaged
	 * over DISTINCT videos (a video shared across sections counts once — mirrors recompute_course_trend
	 * and the header), so padding one video across many sections can't skew it. Returns cid => ×100 rate.
	 *
	 * COLD-START FALLBACK (ticket #105): a video's measured rate is a rolling comment VELOCITY, so it
	 * reads 0 whenever there is nothing recent to measure — a freshly-imported video still on its first
	 * history snapshot (the warm-up), or one whose trailing window happens to be flat/declining. The
	 * newest courses sit at the top of the catalogue, so their cards kept dropping the gold "/day" badge
	 * for a raw comment total even though their videos carry years of discussion. For a video with NO
	 * measurable recent rate we therefore substitute its LIFETIME average — total comments ÷ age since
	 * upload (lifetime_centi_rate) — so a card with real discussion always shows an honest "/day". This
	 * is DISPLAY ONLY: it never feeds aq_videos.rate / rank_score, so a long-quiet course can't ride its
	 * lifetime volume into the trending top (the sort still ranks on measured velocity).
	 */
	public static function live_rates( array $ids ) {
		$ids = array_values( array_unique( array_filter( array_map( 'intval', $ids ) ) ) );
		if ( ! $ids ) { return []; }
		$place = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
		$rows  = Data::all(
			'SELECT DISTINCT l.course_id AS cid, l.video AS video, v.rate AS rate, v.views AS total, v.missing AS missing
			   FROM ' . Data::t( 'aq_lessons' ) . ' l
			   JOIN ' . Data::t( 'aq_videos' ) . " v ON v.video = l.video
			  WHERE l.course_id IN ($place) AND l.video <> ''",
			$ids
		);
		$sum = []; $cnt = [];
		foreach ( (array) $rows as $r ) {
			$cid  = (int) $r['cid'];
			$rate = (int) $r['rate'];
			// No measured recent velocity on a video that is still present (not deleted/comments-off) →
			// estimate from its lifetime discussion so the card shows a rate, not a bare total.
			if ( $rate <= 0 && ! (int) $r['missing'] ) {
				$rate = self::lifetime_centi_rate( (string) $r['video'], (int) $r['total'] );
			}
			$sum[ $cid ] = ( $sum[ $cid ] ?? 0 ) + $rate;
			$cnt[ $cid ] = ( $cnt[ $cid ] ?? 0 ) + 1;
		}
		$out = [];
		foreach ( $sum as $cid => $s ) { $out[ $cid ] = $cnt[ $cid ] > 0 ? $s / $cnt[ $cid ] : 0.0; }
		return $out;
	}

	/**
	 * A video's LIFETIME average comment rate in centi-comments/day (×100, the same unit as aq_videos.rate)
	 * — its cumulative YouTube comment count ÷ its age since upload, read from the cached aq_yt_meta
	 * `upload_ts`. The age divisor is floored at the rolling window (RATE_DAYS) so a very recent upload
	 * with a burst of comments can't spike the estimate, and the whole thing fails safe to 0 when the
	 * upload time is unknown (the card then keeps its raw-total fallback). Used only to DISPLAY a rate for
	 * a video with no measurable recent velocity (see live_rates); never written back to rank_score.
	 */
	private static function lifetime_centi_rate( $vid, $total ) {
		if ( $total <= 0 || $vid === '' ) { return 0; }
		$m  = get_option( 'aq_yt_meta_' . $vid );
		$up = ( is_array( $m ) && ! empty( $m['upload_ts'] ) ) ? (int) $m['upload_ts'] : 0;
		if ( $up <= 0 ) { return 0; }
		$age = time() - $up;
		if ( $age <= 0 ) { return 0; } // a future/clock-skewed upload time → no honest rate to show
		$age_days = max( (float) YouTube::RATE_DAYS, $age / DAY_IN_SECONDS );
		return (int) round( $total * 100 / $age_days );
	}

	/** Shape a page of course rows into cards, pre-computing every course's live discussion rate in ONE
	 *  batched query (see live_rates) so the card shows the honest current rate, not the cooled
	 *  rank_score — without an N+1 over the page. Used by every catalogue list path. */
	public static function cards( array $rows ) {
		$rate = self::live_rates( array_map( fn( $r ) => (int) $r['id'], $rows ) );
		return array_map( function ( $r ) use ( $rate ) {
			$r['live_rate'] = $rate[ (int) $r['id'] ] ?? 0.0;
			return self::card( $r );
		}, $rows );
	}

	/** The list-card shape. Public so the unified Search::all returns identical course rows. */
	public static function card( $c ) {
		$n       = (int) $c['rating_n'];
		$lessons = (int) $c['lesson_count'];
		// COMMENT-BASED trending (2026-06-13): the course ranks by the AVERAGE per-video ROLLING comment
		// rate — how many YouTube comments the average video draws a day — shown as a steady "X/day"
		// (ticket #95). The DISPLAYED rate is the LIVE average of the videos' rates (live_rates(), ÷100),
		// NOT aq_courses.rank_score: rank_score is held at 0 for 24h after any video edit (the catalogue
		// churn cooldown in recompute_course_trend), which is right for the trending SORT but left a
		// freshly re-synced course's card reading 0 and falling back to a raw comment total for the whole
		// window even though its videos had live rates (ticket #105 — the same conflation #102 fixed for
		// the course header). The list shaper cards() pre-batches `live_rate`; a lone card (detail/search)
		// computes it on the spot. `trend` = total comments, the fallback shown only when no rate exists.
		$live = isset( $c['live_rate'] )
			? (float) $c['live_rate']
			: ( self::live_rates( [ (int) $c['id'] ] )[ (int) $c['id'] ] ?? 0.0 );
		$comments_per_day = round( $live / 100, 1 );
		$comments_total   = isset( $c['trend'] ) ? (int) $c['trend'] : 0;
		// Subject facet, resolved once: the house slug ('other' for an unclassified row) and, under it,
		// the validated sub-subject slug ('' when none) — so a card can badge both without re-deriving
		// the taxonomy, and the validation drops any sub left stranded under a since-changed house.
		$topic = ( isset( $c['topic'] ) && Topics::is_valid( $c['topic'] ) ) ? $c['topic'] : Topics::DEFAULT_HOUSE;
		$sub   = ( isset( $c['subtopic'] ) && Topics::is_valid_disc( (string) $c['subtopic'] ) ) ? (string) $c['subtopic'] : '';
		// Every discipline this course links to (multi), resolved to {key,label,house,house_label} so a card
		// or detail can badge each house + discipline without re-deriving the taxonomy client-side.
		$disc_out = array_map( function ( $d ) {
			$h = Topics::disc_house( $d );
			return [ 'key' => $d, 'label' => Topics::disc_label( $d ), 'house' => $h, 'house_label' => Topics::label( $h ) ];
		}, Topics::parse_discs( (string) ( $c['disciplines'] ?? '' ) ) );
		return [
			'id'       => (int) $c['id'],
			'slug'     => $c['slug'],
			'title'    => $c['title'],
			'image'    => $c['image'],
			'channel'  => $c['channel'],
			'lessons'  => $lessons,
			'enrolled' => (int) $c['enroll_count'],
			'duration' => (int) $c['duration'],
			'rating'   => $n ? round( $c['rating_sum'] / $n, 1 ) : 0,
			// Subject facet: the PRIMARY house slug + label (the headline chip), the primary discipline, and
			// the full multi-discipline list (`disciplines`) — a course now belongs to several houses.
			'topic'          => $topic,
			'topic_label'    => Topics::label( $topic ),
			'subtopic'       => $sub,
			'subtopic_label' => $sub !== '' ? Topics::disc_label( $sub ) : '',
			'disciplines'    => $disc_out,
			// Entry fee in coins = 1 coin per video (min ₳1) — the SAME formula as Funds::course_cost,
			// via the shared helper so the card price can never diverge from the charged fee. There are
			// no free courses; this fee funds the course's prize pool.
			'price'    => Funds::cost_for_videos( $lessons ),
			// Live prize pool (QUESTER_SHARE of revenue, in coins) — the card shows "₳N pool" with the
			// season countdown (list responses carry season_ends once). 0 until anyone has enrolled.
			'pool'     => (int) floor( ( (int) ( $c['revenue'] ?? 0 ) ) * Economy::QUESTER_SHARE ),
			'lang'     => (string) ( $c['lang'] ?? 'en' ),
			// Discussion metrics (the headline trending signal): the rolling-24h comment rate ("X/day")
			// and the course-wide total. The catalogue sorts trending by the rate (aq_courses.rank_score).
			'comments_per_day' => $comments_per_day, // YouTube comments per day, trailing 24h (the trending strength, "/day")
			'comments_total'   => $comments_total,   // total YouTube comments across the course's videos (fallback)
		];
	}

	/**
	 * YouTube channel + view/upload metadata for a video id, from the option
	 * aq_yt_meta_<vid> (populated by the channel-meta fetcher). Returns null when absent.
	 */
	public static function yt_meta( $video_id ) {
		if ( ! $video_id ) { return null; }
		$m = get_option( 'aq_yt_meta_' . $video_id );
		// Prefer the live, hourly-refreshed view count from the monitor (aq_videos) over the
		// COMMENT-BASED (2026-06-13): the YouTube view monitor is retired, so the player block no
		// longer shows a view count or an hourly view-rate chip — discussion (the board below) is the
		// engagement signal now. We keep only the channel ATTRIBUTION (logo / link / subs / verified).
		if ( ! is_array( $m ) ) { return null; }
		// Imported meta usually lacks the channel logo — resolve the ACTUAL one from the channel
		// link itself (cached per channel, bounded; YouTube::channel_avatar) so the player block
		// shows the real logo instead of the initials fallback (ticket #50).
		$avatar = (string) ( $m['avatar'] ?? '' );
		if ( $avatar === '' ) { $avatar = YouTube::channel_avatar( (string) ( $m['channel_url'] ?? '' ) ); }
		return [
			'upload_ts'   => isset( $m['upload_ts'] ) ? (int) $m['upload_ts'] : null,
			'channel'     => (string) ( $m['channel'] ?? '' ),
			'channel_url' => (string) ( $m['channel_url'] ?? '' ),
			'subs'        => isset( $m['subs'] ) ? (int) $m['subs'] : 0,
			'verified'    => ! empty( $m['verified'] ),
			'avatar'      => $avatar,
		];
	}

	/**
	 * The channel identity (url / avatar / verified) behind a course, from its sections' cached
	 * aq_yt_meta_<vid> options. Trusts only a meta whose channel NAME equals the course's stored
	 * channel (sections can come from several channels), and the scan is bounded — distinct video
	 * ids, max 20 option reads — so a long course never fans out unbounded reads. Empty-safe:
	 * missing meta (or no match) returns blank fields and the client falls back gracefully.
	 */
	private static function channel_meta( $channel, $videos ) {
		$none = [ 'url' => '', 'avatar' => '', 'verified' => false ];
		if ( $channel === '' ) { return $none; }
		$seen = [];
		foreach ( (array) $videos as $vid ) {
			$vid = (string) $vid;
			if ( $vid === '' || isset( $seen[ $vid ] ) ) { continue; }
			$seen[ $vid ] = true;
			if ( count( $seen ) > 20 ) { break; }
			$m = get_option( 'aq_yt_meta_' . $vid );
			if ( is_array( $m ) && (string) ( $m['channel'] ?? '' ) === $channel ) {
				$url    = (string) ( $m['channel_url'] ?? '' );
				$avatar = (string) ( $m['avatar'] ?? '' );
				// Imported meta usually lacks the logo — resolve the ACTUAL one from the channel
				// link (cached per channel, bounded; YouTube::channel_avatar), ticket #50.
				if ( $avatar === '' ) { $avatar = YouTube::channel_avatar( $url ); }
				return [
					'url'      => $url,
					'avatar'   => $avatar,
					'verified' => ! empty( $m['verified'] ),
				];
			}
		}
		return $none;
	}

	public static function is_enrolled( $uid, $course_id ) {
		if ( ! $uid ) { return false; }
		return (bool) Data::col(
			'SELECT 1 FROM ' . Data::t( 'aq_enroll' ) . ' WHERE user_id = %d AND course_id = %d',
			[ $uid, $course_id ]
		);
	}

	private static function slug( $title ) {
		$base = sanitize_title( $title ) ?: 'course';
		$slug = $base; $i = 1;
		while ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_courses' ) . ' WHERE slug = %s', [ $slug ] ) ) {
			$slug = $base . '-' . ( ++$i );
		}
		return $slug;
	}
}
