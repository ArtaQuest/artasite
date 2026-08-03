<?php
/**
 * ════════════════════════════════════════════════════════════════════════
 * THE LADDER — one 5-tier ladder, climbed by lifetime POINTS (2026-06-03).
 *
 * Your tier (Quester → Creator → Expert → Pioneer → Legend) is decided by
 * your TOTAL lifetime points — NOT by how many Arta Coins are in your wallet.
 * Points are standing; coins are money (see aq-points.php / aq-coin-bank.php).
 * Spending coins to enrol never costs you a tier; points only ever go up.
 *
 * FOUR WAYS TO CLIMB — contributing through ANY of the four point tracks
 * advances your total and can unlock the next tier:
 *     learn      — answer quiz questions correctly,
 *     donate     — donate Arta Coins to the learner fund,
 *     volunteer  — report accepted issues, share courses, refer learners,
 *     outreach   — win grant funding for the foundation.
 *
 * Each tier is ten times the bar of the one below (1k → 10k → 100k → 1M), so
 * the climb is honestly geometric. Revenue share rises with the tier: a
 * creator keeps a larger slice of each enrolment's forfeited tuition as they
 * climb, up to 100% at Legend. Reaching Creator (1,000 points) is what earns
 * the right to publish a course at all. "Lecturer" is NOT a creator role; it
 * is the name of the person in a video (`_aq_lecturer` post-meta).
 *
 *   Quester    —   0% —        0 points (every member starts here; learns + earns).
 *   Creator    —  50% —    1,000 points (earns the right to create).
 *   Expert     —  70% —   10,000 points.
 *   Pioneer    —  90% —  100,000 points.
 *   Legend     — 100% — 1,000,000 points (Aquest takes nothing).
 *
 * Promotion is automatic — every `aq_points_awarded()` re-evaluates the five
 * thresholds and bumps the user to the highest tier they qualify for. Demotion
 * never happens. Each tier maps to a WP role (ay_creator_explorer …
 * ay_creator_legend) inheriting stm_lms_instructor caps so authoring is
 * unchanged. `total points` is the ONLY promotion criterion.
 *
 * @package ArtaQuest
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/* ────────────────────────────────────────────────────────────────────────
   TIER METADATA
   The canonical source of truth for tier labels, thresholds, revenue share,
   and the descriptive copy that appears on /careers/, role badges, and
   admin UI. Edit here, everything updates.
   ──────────────────────────────────────────────────────────────────── */

/**
 * Return the ordered list of tiers, lowest → highest. Each tier is a tuple
 * of (key, role, label, revenue_share, thresholds[], blurb).
 *
 * Threshold keys:
 *   points — int — min TOTAL lifetime points (learn + donate + volunteer).
 *                  The ONLY promotion criterion (2026-06-03). NOT wallet coins.
 *
 * Each tier is 10× the previous tier's point bar: 0 → 1k → 10k → 100k → 1M.
 * Honest geometric progression.
 *
 * @return array<int,array<string,mixed>>
 */
function aq_creator_tiers() {
	return array(
		array(
			'key'           => 'quester',
			'role'          => '', // base member — earns points by learning/donating/volunteering; not yet a creator
			'label'         => 'Quester',
			'revenue_share' => 0.0,
			'thresholds'    => array( 'points' => 0 ),
			'caps'          => array( 'can_create' => false ),
			'blurb'         => 'Every member starts here. Earn points by learning, donating, or volunteering.',
		),
		array(
			'key'           => 'explorer',
			'role'          => 'ay_creator_explorer',
			'label'         => 'Creator',
			'revenue_share' => 0.50,
			'thresholds'    => array( 'points' => 1000 ),
			'caps'          => array( 'can_create' => true, 'needs_playlist_approval' => true, 'can_edit_content' => false, 'needs_channel_approval' => true ),
			'blurb'         => 'Submit a playlist for the board to approve — your course is auto-generated from it. You keep 50% of each enrolment.',
		),
		array(
			'key'           => 'voyager',
			'role'          => 'ay_creator_voyager',
			'label'         => 'Expert',
			'revenue_share' => 0.70,
			'thresholds'    => array( 'points' => 10000 ),
			'caps'          => array( 'can_create' => true, 'needs_playlist_approval' => true, 'can_edit_content' => true, 'needs_channel_approval' => true ),
			'blurb'         => 'Everything a Creator can do, plus you can edit your auto-generated course content. You keep 70%.',
		),
		array(
			'key'           => 'pioneer',
			'role'          => 'ay_creator_pioneer',
			'label'         => 'Pioneer',
			'revenue_share' => 0.90,
			'thresholds'    => array( 'points' => 100000 ),
			'caps'          => array( 'can_create' => true, 'needs_playlist_approval' => false, 'can_edit_content' => true, 'needs_channel_approval' => true ),
			'blurb'         => 'Your playlists no longer need board approval — only your channel does. You keep 90%.',
		),
		array(
			'key'           => 'legend',
			'role'          => 'ay_creator_legend',
			'label'         => 'Legend',
			'revenue_share' => 1.00,
			'thresholds'    => array( 'points' => 1000000 ),
			'caps'          => array( 'can_create' => true, 'needs_playlist_approval' => false, 'can_edit_content' => true, 'needs_channel_approval' => false, 'can_upload_any' => true ),
			'blurb'         => 'Upload any public data with no approval. You keep 100% — Aquest takes nothing.',
		),
	);
}

/** Min total points required for a tier (single accessor — tolerates the legacy 'coins' key). */
function aq_tier_threshold( $tier ) {
	if ( isset( $tier['thresholds']['points'] ) ) {
		return (int) $tier['thresholds']['points'];
	}
	return isset( $tier['thresholds']['coins'] ) ? (int) $tier['thresholds']['coins'] : 0;
}

/** Capabilities of a user's current tier, by TOTAL lifetime points (defaults = base member's). */
function aq_creator_user_caps( $user_id ) {
	$points = function_exists( 'aq_points_total' ) ? aq_points_total( (int) $user_id ) : 0;
	$caps   = array( 'can_create' => false );
	foreach ( aq_creator_tiers() as $t ) {
		if ( $points >= aq_tier_threshold( $t ) && isset( $t['caps'] ) ) {
			$caps = array_merge( $caps, $t['caps'] );
		}
	}
	return $caps;
}

/** The ladder label (Quester … Legend) for a TOTAL-points figure — the single source of truth. */
function aq_tier_label( $points ) {
	$label = 'Quester';
	foreach ( aq_creator_tiers() as $t ) {
		if ( (int) $points >= aq_tier_threshold( $t ) ) {
			$label = $t['label'];
		}
	}
	return $label;
}

/** Back-compat alias — the ladder is keyed on total points now, not the coin wallet. */
function aq_coin_tier_label( $points ) {
	return aq_tier_label( $points );
}

/* ────────────────────────────────────────────────────────────────────────
   PLAYLIST → COURSE submissions (the creator pipeline).
   A creator submits a YouTube playlist. Whether it needs board approval and
   whether the channel needs vetting depends on their tier:
     Creator   (1k)  — playlist needs board approval; course auto-generated.
     Expert    (10k) — same, plus they may edit the generated content.
     Pioneer   (100k)— playlist auto-approved; only the channel is vetted.
     Legend    (1M)  — no approval at all; may upload any public data.
   On approval, `aq_playlist_approved` fires — the course-builder pipeline
   (course-builder/aq_yt_fetch.py → aq_course_data.py → aq_course_import.php)
   generates the course from the playlist.
   ──────────────────────────────────────────────────────────────────── */

function aq_creator_submit_playlist( $user_id, $url, $channel = '' ) {
	$user_id = (int) $user_id;
	$url     = esc_url_raw( trim( (string) $url ) );
	if ( ! $url ) {
		return new WP_Error( 'aq_bad_url', 'Please provide a valid YouTube playlist or channel URL.' );
	}
	$caps = aq_creator_user_caps( $user_id );
	if ( empty( $caps['can_create'] ) ) {
		return new WP_Error( 'aq_not_creator', 'Reach Creator (1,000 coins) to submit a playlist for a course.' );
	}
	$needs_playlist = ! empty( $caps['needs_playlist_approval'] );
	$needs_channel  = ! empty( $caps['needs_channel_approval'] );
	$status         = ( $needs_playlist || $needs_channel ) ? 'pending' : 'approved';
	$subs   = get_option( 'aq_playlist_submissions', array() );
	$id     = ( $subs ? max( array_column( $subs, 'id' ) ) : 0 ) + 1;
	$subs[] = array(
		'id'      => $id,
		'user'    => $user_id,
		'url'     => $url,
		'channel' => sanitize_text_field( $channel ),
		'status'  => $status,
		'needs_playlist_approval' => $needs_playlist,
		'needs_channel_approval'  => $needs_channel,
		'date'    => time(),
	);
	update_option( 'aq_playlist_submissions', $subs, false );
	if ( 'approved' === $status ) {
		do_action( 'aq_playlist_approved', $id, $user_id, $url );
	}
	return array( 'id' => $id, 'status' => $status, 'needs_playlist_approval' => $needs_playlist, 'needs_channel_approval' => $needs_channel );
}

/** Board (admin) approves a pending submission → triggers course generation. */
function aq_creator_approve_playlist( $sub_id ) {
	$subs    = get_option( 'aq_playlist_submissions', array() );
	$changed = false;
	foreach ( $subs as &$s ) {
		if ( (int) $s['id'] === (int) $sub_id && 'approved' !== $s['status'] ) {
			$s['status']   = 'approved';
			$s['approved'] = time();
			$changed       = true;
			do_action( 'aq_playlist_approved', (int) $s['id'], (int) $s['user'], $s['url'] );
		}
	}
	unset( $s );
	if ( $changed ) {
		update_option( 'aq_playlist_submissions', $subs, false );
	}
	return $changed;
}

/** A user's own playlist submissions. */
function aq_creator_user_playlists( $user_id ) {
	$subs = get_option( 'aq_playlist_submissions', array() );
	return array_values( array_filter( (array) $subs, function ( $s ) use ( $user_id ) {
		return (int) $s['user'] === (int) $user_id;
	} ) );
}

/**
 * On approval, create a DRAFT course shell owned by the creator and tagged with the playlist URL,
 * so the course-builder pipeline (course-builder/aq_yt_fetch.py → aq_course_data.py →
 * aq_course_import.php) or an editor has a real post to populate. Idempotent per submission —
 * without this listener, approved playlists went nowhere.
 */
add_action( 'aq_playlist_approved', function ( $sub_id, $user_id, $url ) {
	$subs    = get_option( 'aq_playlist_submissions', array() );
	$changed = false;
	foreach ( $subs as &$s ) {
		if ( (int) $s['id'] !== (int) $sub_id ) { continue; }
		if ( ! empty( $s['course_id'] ) && get_post( (int) $s['course_id'] ) ) { return; } // already created
		$cid = wp_insert_post( array(
			'post_type'   => 'stm-courses',
			'post_status' => 'draft',
			'post_author' => (int) $user_id,
			'post_title'  => 'New course from playlist — pending generation',
		) );
		if ( $cid && ! is_wp_error( $cid ) ) {
			update_post_meta( (int) $cid, 'aq_playlist_url', esc_url_raw( $url ) );
			// A draft has no quizzes yet → it is free until questions are generated, at which point
			// it is auto-priced at one coin per quiz (universal rule — no "keep free" exception).
			$s['course_id']  = (int) $cid;
			$s['generation'] = 'pending';
			$changed         = true;
		}
	}
	unset( $s );
	if ( $changed ) { update_option( 'aq_playlist_submissions', $subs, false ); }
}, 10, 3 );

/** Map role → tier record. */
function aq_creator_tier_by_role( $role ) {
	foreach ( aq_creator_tiers() as $t ) {
		if ( $t['role'] === $role ) {
			return $t;
		}
	}
	return null;
}

/** Map tier key → tier record. */
function aq_creator_tier_by_key( $key ) {
	foreach ( aq_creator_tiers() as $t ) {
		if ( $t['key'] === $key ) {
			return $t;
		}
	}
	return null;
}

/** Roles considered creator-ladder tiers (used by leaderboard chip + profile badge). */
function aq_creator_ladder_roles() {
	$roles = array();
	foreach ( aq_creator_tiers() as $t ) {
		if ( ! empty( $t['role'] ) ) {
			$roles[] = $t['role'];
		}
	}
	return $roles;
}

/* ────────────────────────────────────────────────────────────────────────
   ROLE REGISTRATION
   Capabilities inherited from stm_lms_instructor — every tier can publish
   courses; the editorial gate is the tier itself, not the cap.
   ──────────────────────────────────────────────────────────────────── */

add_action( 'init', 'aq_creator_register_roles', 5 );

function aq_creator_register_roles() {
	$instructor = get_role( 'stm_lms_instructor' );
	$caps       = $instructor
		? $instructor->capabilities
		: array(
			'read'                          => true,
			'edit_posts'                    => true,
			'edit_published_posts'          => true,
			'publish_posts'                 => true,
			'edit_stm_lms_posts'            => true,
			'edit_published_stm_lms_posts'  => true,
			'publish_stm_lms_posts'         => true,
		);

	foreach ( aq_creator_tiers() as $t ) {
		if ( empty( $t['role'] ) ) {
			continue; // base 'quester' learner tier has no creator role
		}
		if ( ! get_role( $t['role'] ) ) {
			add_role( $t['role'], $t['label'], $caps );
		}
	}
}

/* ────────────────────────────────────────────────────────────────────────
   USER → TIER LOOKUP
   ──────────────────────────────────────────────────────────────────── */

/**
 * Get the user's current tier record (or null if not on the ladder).
 *
 * @param int|WP_User $user
 * @return array|null
 */
function aq_creator_user_tier( $user ) {
	if ( is_numeric( $user ) ) {
		$user = get_user_by( 'id', (int) $user );
	}
	if ( ! $user instanceof WP_User ) {
		return null;
	}
	foreach ( array_reverse( aq_creator_tiers() ) as $t ) {
		if ( in_array( $t['role'], (array) $user->roles, true ) ) {
			return $t;
		}
	}
	return null;
}

/**
 * Revenue share (0.50–1.00) for this user. Returns 0.0 if not on the ladder.
 *
 * @param int $user_id
 * @return float
 */
function aq_creator_user_revenue_share( $user_id ) {
	$tier = aq_creator_user_tier( (int) $user_id );
	return $tier ? (float) $tier['revenue_share'] : 0.0;
}

/* ────────────────────────────────────────────────────────────────────────
   METRICS — count published courses, quiz passes, 4★+ reviews for a user.
   Kept lightweight; cached for 5 minutes per user via wp_cache to avoid
   hammering on every coin-credit.
   ──────────────────────────────────────────────────────────────────── */

/** Number of published stm-courses authored by $user_id. */
function aq_creator_published_courses( $user_id ) {
	$user_id = (int) $user_id;
	$cached  = wp_cache_get( "aq_creator_courses_{$user_id}", 'aq_creator' );
	if ( false !== $cached ) {
		return (int) $cached;
	}
	$q = new WP_Query( array(
		'post_type'      => 'stm-courses',
		'post_status'    => 'publish',
		'author'         => $user_id,
		'fields'         => 'ids',
		'posts_per_page' => -1,
		'no_found_rows'  => true,
	) );
	$n = (int) $q->post_count;
	wp_cache_set( "aq_creator_courses_{$user_id}", $n, 'aq_creator', 5 * MINUTE_IN_SECONDS );
	return $n;
}

/** Total student quiz passes across all courses authored by $user_id. */
function aq_creator_quiz_passes( $user_id ) {
	global $wpdb;
	$user_id = (int) $user_id;
	$cached  = wp_cache_get( "aq_creator_quizpasses_{$user_id}", 'aq_creator' );
	if ( false !== $cached ) {
		return (int) $cached;
	}
	$courses = get_posts( array(
		'post_type'      => 'stm-courses',
		'post_status'    => 'publish',
		'author'         => $user_id,
		'fields'         => 'ids',
		'posts_per_page' => -1,
		'no_found_rows'  => true,
	) );
	if ( empty( $courses ) ) {
		wp_cache_set( "aq_creator_quizpasses_{$user_id}", 0, 'aq_creator', 5 * MINUTE_IN_SECONDS );
		return 0;
	}
	$in    = implode( ',', array_map( 'intval', $courses ) );
	$table = $wpdb->prefix . 'stm_lms_user_quizzes';
	// `status='passed'` is the LMS canonical pass flag (see quiz.php).
	$count = (int) $wpdb->get_var(
		"SELECT COUNT(*) FROM {$table} WHERE course_id IN ({$in}) AND status='passed'"
	);
	wp_cache_set( "aq_creator_quizpasses_{$user_id}", $count, 'aq_creator', 5 * MINUTE_IN_SECONDS );
	return $count;
}

/** Number of reviews with rating ≥ 4 across all courses authored by $user_id. */
function aq_creator_reviews_4plus( $user_id ) {
	global $wpdb;
	$user_id = (int) $user_id;
	$cached  = wp_cache_get( "aq_creator_reviews_{$user_id}", 'aq_creator' );
	if ( false !== $cached ) {
		return (int) $cached;
	}
	$courses = get_posts( array(
		'post_type'      => 'stm-courses',
		'post_status'    => 'publish',
		'author'         => $user_id,
		'fields'         => 'ids',
		'posts_per_page' => -1,
		'no_found_rows'  => true,
	) );
	if ( empty( $courses ) ) {
		wp_cache_set( "aq_creator_reviews_{$user_id}", 0, 'aq_creator', 5 * MINUTE_IN_SECONDS );
		return 0;
	}
	$in = implode( ',', array_map( 'intval', $courses ) );
	$n  = (int) $wpdb->get_var(
		"SELECT COUNT(DISTINCT pm_course.post_id)
		   FROM {$wpdb->postmeta} pm_course
		   JOIN {$wpdb->postmeta} pm_mark
		     ON pm_mark.post_id = pm_course.post_id
		    AND pm_mark.meta_key = 'review_mark'
		  WHERE pm_course.meta_key = 'review_course'
		    AND pm_course.meta_value IN ({$in})
		    AND CAST(pm_mark.meta_value AS UNSIGNED) >= 4"
	);
	wp_cache_set( "aq_creator_reviews_{$user_id}", $n, 'aq_creator', 5 * MINUTE_IN_SECONDS );
	return $n;
}

/** Tenure in whole years since the user's `_aq_creator_tenure_started` stamp. */
function aq_creator_tenure_years( $user_id ) {
	$started = get_user_meta( (int) $user_id, '_aq_creator_tenure_started', true );
	if ( ! $started ) {
		return 0;
	}
	$ts = is_numeric( $started ) ? (int) $started : strtotime( $started );
	if ( $ts <= 0 ) {
		return 0;
	}
	$years = (int) floor( ( time() - $ts ) / YEAR_IN_SECONDS );
	return max( 0, $years );
}

/* ────────────────────────────────────────────────────────────────────────
   PROMOTION — runs on every coin credit. Idempotent.
   ──────────────────────────────────────────────────────────────────── */

/**
 * Find the highest tier this user qualifies for right now. Returns the tier
 * record or null if they don't qualify for even Novice.
 */
function aq_creator_qualifies_for( $user_id ) {
	$user_id = (int) $user_id;
	if ( $user_id <= 0 ) {
		return null;
	}
	$points = function_exists( 'aq_points_total' ) ? aq_points_total( $user_id ) : 0;

	$best = null;
	foreach ( aq_creator_tiers() as $t ) {
		if ( empty( $t['role'] ) ) {
			continue; // the base 'quester' tier is not a creator role
		}
		if ( $points < aq_tier_threshold( $t ) ) {
			continue;
		}
		$best = $t;
	}
	return $best;
}

/**
 * Auto-promote on every coin credit. Never demotes — once Grandmaster, always
 * Grandmaster (a separate manual admin action would be needed to revoke).
 * Real staff (administrator/editor/shop_manager) are left alone.
 */
function aq_creator_maybe_promote( $user_id, $delta = 0 ) {
	$user_id = (int) $user_id;
	if ( $user_id <= 0 ) {
		return;
	}
	$u = get_userdata( $user_id );
	if ( ! $u ) {
		return;
	}
	$roles = (array) $u->roles;

	// Never auto-mutate real staff.
	if ( array_intersect( $roles, array( 'administrator', 'editor', 'shop_manager' ) ) ) {
		return;
	}

	$target = aq_creator_qualifies_for( $user_id );
	if ( ! $target ) {
		return; // Not yet on the ladder.
	}

	$current = aq_creator_user_tier( $u );
	if ( $current && $current['key'] === $target['key'] ) {
		return; // Already at the right tier.
	}

	// Only promote upward — never demote (e.g. course gets unpublished).
	if ( $current ) {
		$ladder = array_column( aq_creator_tiers(), 'key' );
		$cur_i  = array_search( $current['key'], $ladder, true );
		$tgt_i  = array_search( $target['key'],  $ladder, true );
		if ( $tgt_i <= $cur_i ) {
			return;
		}
		$u->remove_role( $current['role'] );
	}

	$u->add_role( $target['role'] );
	update_user_meta( $user_id, '_aq_creator_tier', $target['key'] );
	update_user_meta( $user_id, '_aq_creator_revenue_share', $target['revenue_share'] );
	if ( ! get_user_meta( $user_id, '_aq_creator_tenure_started', true ) ) {
		update_user_meta( $user_id, '_aq_creator_tenure_started', time() );
	}

	do_action( 'aq_creator_promoted', $user_id, $target['key'], $current ? $current['key'] : null );
}
// Promotion is driven by lifetime POINTS now (not coin-wallet changes). Every point award
// re-evaluates the ladder. The old `aq_bb_coins_credited` binding is gone — wallet balance
// no longer affects tier (spending coins must never demote you).
add_action( 'aq_points_awarded', 'aq_creator_maybe_promote', 20, 1 );

/* ─────────────────────────────────────────────────────────────────────────────
   SHORTCODES — [ay_instructor_points] / [ay_creator_ladder] (RETIRED)
   The creator ladder now renders in React (Careers.tsx + the /aq/v1/creator-ladder
   BFF, backed by aq_creator_tiers() below). No served page uses these tags any
   more (verified 2026-06-04). We neutralise the legacy 3-tier handlers so a stray
   tag left in old content or a post revision renders nothing, not stale copy.
   ───────────────────────────────────────────────────────────────────────────── */
add_action( 'init', function () {
	foreach ( array( 'ay_instructor_points', 'ay_creator_ladder' ) as $tag ) {
		remove_shortcode( $tag );
		add_shortcode( $tag, '__return_empty_string' );
	}
}, 50 );

/* ────────────────────────────────────────────────────────────────────────
   COMPAT — neuter the legacy TA auto-promoter so the two listeners don't
   fight. The bursary file still adds the listener at hook priority 10;
   removing it on init prevents the old TA role from ever being granted.
   ──────────────────────────────────────────────────────────────────── */
add_action( 'init', function () {
	if ( function_exists( 'aq_bb_maybe_promote_to_ta' ) ) {
		remove_action( 'aq_bb_coins_credited', 'aq_bb_maybe_promote_to_ta', 10 );
	}
	// Remove the role entirely so nothing in the admin UI can re-grant it.
	if ( get_role( 'ay_teaching_assistant' ) ) {
		remove_role( 'ay_teaching_assistant' );
	}
}, 20 );

/* ────────────────────────────────────────────────────────────────────────
   AVATAR TIER RING — Kaggle-style decoration (2026-05-22, iter-54).
   Wraps every WP avatar in a tier-scoped <span> so CSS can paint a ring
   around the image. Users not on the ladder render unchanged. Composes
   cleanly with the DiceBear `pre_get_avatar_data` filter (this runs at
   the higher-level `get_avatar` HTML-output stage).
   ──────────────────────────────────────────────────────────────────── */
add_filter( 'get_avatar', 'aq_creator_decorate_avatar', 30, 6 );

function aq_creator_decorate_avatar( $avatar, $id_or_email, $size, $default, $alt, $args = array() ) {
	if ( ! is_string( $avatar ) || '' === $avatar ) {
		return $avatar;
	}
	$user_id = 0;
	if ( is_numeric( $id_or_email ) ) {
		$user_id = (int) $id_or_email;
	} elseif ( is_string( $id_or_email ) && is_email( $id_or_email ) ) {
		$u = get_user_by( 'email', $id_or_email );
		if ( $u ) { $user_id = (int) $u->ID; }
	} elseif ( $id_or_email instanceof WP_User ) {
		$user_id = (int) $id_or_email->ID;
	} elseif ( $id_or_email instanceof WP_Post ) {
		$user_id = (int) $id_or_email->post_author;
	} elseif ( $id_or_email instanceof WP_Comment ) {
		$user_id = (int) $id_or_email->user_id;
	}
	if ( $user_id <= 0 ) {
		return $avatar;
	}
	$tier_key = get_user_meta( $user_id, '_aq_creator_tier', true );
	if ( ! $tier_key ) {
		return $avatar;
	}
	$tier_label = '';
	foreach ( aq_creator_tiers() as $t ) {
		if ( $t['key'] === $tier_key ) { $tier_label = $t['label']; break; }
	}
	return '<span class="aq-tier-ring aq-tier-ring--' . esc_attr( $tier_key ) . '"'
		 . ' title="' . esc_attr( sprintf( /* translators: %s = tier label */ __( '%s tier', 'artaquest' ), $tier_label ) ) . '">'
		 . $avatar
		 . '<span class="aq-tier-ring__dot" aria-hidden="true"></span>'
		 . '</span>';
}
