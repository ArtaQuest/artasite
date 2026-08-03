<?php
/**
 * ArtaQuest theme features (post-cutover; slimmed 2026-06-18).
 *
 * After the MasterStudy LMS + WooCommerce cutover this file is reduced to the few
 * site-specific behaviours that are still live:
 *   1. Loads three feature includes (creator ladder, public profiles, account deletion).
 *   2. Leaderboard DATA helpers — consumed by aq-seo-schema.php for the /rankings JSON-LD
 *      (the [ay_leaderboard] shortcode + its renderer are gone; /rankings is the React SPA).
 *   3. i18n: prefix bare root-relative hrefs in post_content with /<lang>/ on translated pages.
 *   4. Friendly 301s for common 404 guesses (/contact, /login, …).
 *
 * Everything MasterStudy/WooCommerce-era — assignment removal, attention-quiz grading, the LMS
 * email shell, the LMS gettext/JS "Lecture→Lesson" string patches, instructor-label overrides,
 * the $1/hour auto-pricing engine, the course-ZIP importer, the server-rendered instructor
 * surface, and the signup DOB capture — was removed on 2026-06-18. All of it hooked plugins,
 * post types (stm-courses / stm-lessons / stm-assignments), or text domains that no longer
 * exist, so it never executed. The React SPA + the `aquest` plugin own those surfaces now.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/* Creator ladder — 5-tier Kaggle-style instructor ladder, auto-promotes on coin credit. */
require_once __DIR__ . '/aq-creator-ladder.php';

/* Public profiles — /u/<slug>/ (bio, location, points + per-category breakdown). */
require_once __DIR__ . '/aq-public-profile.php';

/* Account deletion lives in the PLUGIN: AQ\Account::delete_request + ::delete_confirm, declared in
   Rest::ROUTES as POST me/delete/request + me/delete/confirm. The theme used to register a SECOND,
   weaker endpoint here (POST /wp-json/aq/v1/delete-account, aq-account-deletion.php, removed
   2026-08-01): session + nonce were the only proof, it called wp_delete_user() directly instead of
   AQ\Account::purge(), and its "Danger zone" UI hung on artaquest_after_account — a hook nothing
   has fired since the cutover. So the only live thing it did was offer an irreversible deletion
   with none of the plugin's guards: no emailed single-use re-auth code, no typed confirmation, no
   throttle, no purge cascade. Two doors to the same room, one of them unlocked. Do not re-add it. */

/* ════════════════════════════════════════════════════════════════════════
   LEADERBOARD DATA HELPERS
   The [ay_leaderboard] shortcode + its render stack were removed — /rankings is
   React (plugin /leaderboard BFF) and the crawler body builds its own list from
   aq_points_ledger (aq-app.php). These DATA helpers are KEPT: aq-seo-schema.php
   uses ay_leaderboard_rank / ay_public_profile_url for the rankings JSON-LD.
   Members are ranked by lifetime POINTS, not coins; "All" sums the three tracks.
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Canonical leaderboard categories — the three competition tracks plus the overall (2026-06-03).
 * Members are ranked by lifetime POINTS, not by their coin wallet. "All" sums the three tracks
 * (the same total the tier ladder reads); each track is its own board.
 */
function ay_leaderboard_categories() {
	return array(
		'all'          => __( 'All',          'artaquest' ),
		'learners'     => __( 'Learners',     'artaquest' ),
		'donors'       => __( 'Donors',       'artaquest' ),
		'volunteers'   => __( 'Volunteers',   'artaquest' ),
		'grantwinners' => __( 'Sponsors', 'artaquest' ),
	);
}

/** Map a leaderboard category slug → its points track ('all' = total across tracks). */
function ay_leaderboard_track( $slug ) {
	switch ( ay_leaderboard_normalise_slug( $slug ) ) {
		case 'learners':     return 'learn';
		case 'donors':       return 'donate';
		case 'volunteers':   return 'volunteer';
		case 'grantwinners': return 'outreach';
		default:             return 'all';
	}
}

/**
 * Map any legacy ?cat= value to the closest current slug. Returns the input
 * if it's already valid (in ay_leaderboard_categories()), else the best fit.
 */
function ay_leaderboard_normalise_slug( $slug ) {
	$cats = ay_leaderboard_categories();
	if ( isset( $cats[ $slug ] ) ) {
		return $slug;
	}
	// Legacy slugs → the closest current track.
	$legacy = array(
		'students'      => 'learners',
		'instructors'   => 'all',     // creators climb the ladder by total points now
		'developers'    => 'volunteers',
		'functional'    => 'volunteers',
		'accessibility' => 'volunteers',
		'copy'          => 'volunteers',
		'layout'        => 'volunteers',
		'performance'   => 'volunteers',
		'aesthetic'     => 'volunteers',
		'security'      => 'volunteers',
		'quizzes'       => 'learners',
		'certificates'  => 'learners',
		'donations'     => 'donors',
	);
	return $legacy[ $slug ] ?? 'all';
}

/**
 * Public profile URL helper — /u/<user_login>/.
 * Returns an empty string for invalid IDs so callers can guard.
 */
function ay_public_profile_url( $user_id ) {
	$user_id = (int) $user_id;
	if ( $user_id <= 0 ) {
		return '';
	}
	$u = get_user_by( 'id', $user_id );
	if ( ! $u ) {
		return '';
	}
	$slug = sanitize_title( $u->user_login );
	return home_url( '/u/' . $slug . '/' );
}

/**
 * Build the ranked row list for a competition track (2026-06-03). Members are ranked by lifetime
 * POINTS, not coins:
 *   'all'        → total points (learn + donate + volunteer) — the same total the ladder reads.
 *   'learners'   → learn points (quiz questions answered correctly).
 *   'donors'     → donate points (Arta Coins donated to the learner fund).
 *   'volunteers' → volunteer points (accepted issues, course shares, referrals).
 *
 * The whole community appears (members with 0 points included). Each row carries the per-track
 * breakdown + the tier (by total points) so the UI never has to recompute it.
 *
 * Returns rows shaped:
 *   [ 'id','name','points','learn','donate','volunteer','total','tier','category' ].
 */
function ay_leaderboard_rank( $category, $limit = 20 ) {
	$limit = max( 3, min( 100, (int) $limit ) );
	$track = function_exists( 'ay_leaderboard_track' ) ? ay_leaderboard_track( $category ) : 'all';

	$ranked = array();
	foreach ( get_users( array( 'fields' => array( 'ID', 'display_name', 'user_login', 'user_registered' ) ) ) as $u ) {
		$bd    = function_exists( 'aq_points_breakdown' ) ? aq_points_breakdown( $u->ID ) : array( 'learn' => 0, 'donate' => 0, 'volunteer' => 0, 'total' => 0 );
		$metric = ( 'all' === $track ) ? (int) $bd['total'] : (int) ( $bd[ $track ] ?? 0 );
		$ranked[] = array(
			'id'        => (int) $u->ID,
			'name'      => $u->display_name ?: $u->user_login,
			'points'    => $metric,                       // the metric this track ranks by
			'coins'     => $metric,                       // back-compat alias for the legacy panel renderer
			'tier'      => function_exists( 'aq_tier_label' ) ? aq_tier_label( (int) $bd['total'] ) : 'Quester',
			'category'  => $category,
			'_reg'      => (string) $u->user_registered,
		);
	}
	// Metric DESC, then earliest-joined first — deterministic, stable ordering.
	usort(
		$ranked,
		function ( $a, $b ) {
			if ( $a['points'] !== $b['points'] ) {
				return $b['points'] - $a['points'];
			}
			return strcmp( $a['_reg'], $b['_reg'] );
		}
	);
	$ranked = array_slice( $ranked, 0, $limit );
	foreach ( $ranked as $k => $r ) {
		unset( $ranked[ $k ]['_reg'] );
	}
	return array_values( $ranked );
}

/* ════════════════════════════════════════════════════════════════════════
   I18N — prefix bare relative hrefs with /<lang>/ on translated pages.
   Footer + block-content CTAs like "Explore all courses" use <a href="/courses/">
   directly; the i18n router doesn't auto-rewrite hrefs inside post_content, so on
   a non-default language the user would land on the English page. Rewrite root-
   relative paths to include the lang prefix when the current language is non-default.
   ════════════════════════════════════════════════════════════════════════ */
add_filter( 'the_content', function ( $content ) {
	if ( ! class_exists( 'AQ_I18N_Router' ) ) return $content;
	if ( ! method_exists( 'AQ_I18N_Router', 'current' ) || ! method_exists( 'AQ_I18N_Router', 'convert_url' ) ) {
		return $content;
	}
	$lang = AQ_I18N_Router::current();
	if ( ! $lang || in_array( $lang, [ '', 'en', 'en_US', 'default' ], true ) ) {
		return $content;
	}
	// Rewrite href="/path/" (root-relative, not protocol-relative, not
	// starting with /wp-content/wp-admin/wp-json/ etc.) into the
	// language-prefixed equivalent. Skip if already prefixed with /<lang>/.
	//
	// NB: use `~` as the regex delimiter so the in-pattern `#` is literal — a
	// prior `#`-delimited version truncated the pattern and wiped entire
	// non-English entry-content via a NULL preg_replace_callback return.
	$out = preg_replace_callback(
		'~href="(/(?!wp-|/|#)[^"]*)"~',
		function ( $m ) use ( $lang ) {
			$path = $m[1];
			// Already language-prefixed? (e.g. /ar/foo/)
			if ( preg_match( '~^/' . preg_quote( $lang, '~' ) . '(/|$)~', $path ) ) {
				return $m[0];
			}
			$full = AQ_I18N_Router::convert_url( home_url( $path ), $lang );
			if ( is_string( $full ) && $full !== '' ) {
				return 'href="' . esc_url( $full ) . '"';
			}
			return $m[0];
		},
		$content
	);
	/* Defensive: if preg_* ever fails (NULL return) keep the original
	   content — never wipe it. */
	return is_string( $out ) ? $out : $content;
}, 9999 );

/* ════════════════════════════════════════════════════════════════════════
   FRIENDLY REDIRECTS (2026-05-22).
   Visitors (and bots) keep hitting /contact/ — a 404, because the page is
   /faq-contact/. Redirect the common guesses to their real homes so nobody
   dead-ends on a 404.
   ════════════════════════════════════════════════════════════════════════ */
add_action( 'template_redirect', function () {
	if ( ! is_404() ) {
		return;
	}
	$path = trim( (string) wp_parse_url( $_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH ), '/' );
	// Strip any language prefix (es, ar, zh, …) for matching.
	$path = preg_replace( '#^[a-z]{2}/#', '', $path );
	$map  = array(
		'contact'      => '/faq-contact/',
		'contact-us'   => '/faq-contact/',
		'faq'          => '/faq-contact/',
		'login'        => '/user-account/',
		'sign-in'      => '/user-account/',
		'signin'       => '/user-account/',
		'register'     => '/user-account/',
		'sign-up'      => '/user-account/',
	);
	if ( isset( $map[ $path ] ) ) {
		wp_safe_redirect( home_url( $map[ $path ] ), 301 );
		exit;
	}
}, 1 );
