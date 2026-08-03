<?php
/**
 * ArtaQuest public profile pages — /u/<user_login>/
 *
 * 2026-05-22 user directive: "all profiles should be public and accessible
 * through the leaderboards … data (except passwords) is public, including
 * birthdays … emails should be private."
 *
 * Surfaces per profile:
 *   • Display name + pronouns + DiceBear avatar (aq_avatar_url meta)
 *   • Bio (description meta)
 *   • Location (_aq_location)
 *   • Age (_aq_age) + birthday (_aq_birthday)
 *   • Total ArtaQuest coins (stm_lms_user_points)
 *   • Per-category bug-bounty totals (functional, accessibility, …)
 *   • List of accepted bug findings (title, date, points)
 *   • Open-society notice
 *
 * Email and password are NEVER rendered.
 *
 * Route: /u/<slug>/  — rewritten to index.php?aq_profile=<slug>.
 * Flush rewrites once on theme activation (after_switch_theme) and once on
 * include load if the option flag is missing.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/* ────────────────────────────────────────────────────────────────────────
   Rewrite rules
   ──────────────────────────────────────────────────────────────────── */

add_action( 'init', function () {
	add_rewrite_rule(
		'^u/([^/]+)/?$',
		'index.php?aq_profile=$matches[1]',
		'top'
	);
} );

add_filter( 'query_vars', function ( $vars ) {
	$vars[] = 'aq_profile';
	return $vars;
} );

/**
 * One-shot rewrite flush after this module ships. The option flag means we
 * only flush once per deploy, not on every request.
 */
add_action( 'init', function () {
	if ( get_option( 'aq_public_profile_rewrites_v1' ) !== 'flushed' ) {
		flush_rewrite_rules( false );
		update_option( 'aq_public_profile_rewrites_v1', 'flushed', false );
	}
}, 99 );

/* ────────────────────────────────────────────────────────────────────────
   [REMOVED 2026-06-05] The old SERVER-rendered profile (aq_public_profile_render, ~270 lines, +
   its template_redirect and the birthday-format helper) lived here. It was dead: aq-app.php
   pre-empts /u/<slug>/ at template_redirect priority 1 (serves the React app + exit), so this
   priority-10 handler never ran. The profile is React (App.tsx /u/:slug); its crawler SEO body
   comes from aq_app_seo_html; its <title> from the pre_get_document_title filter below. Removing
   it also decoupled the profile from the wp_aq_bug_findings table (the React profile shows no
   findings). The /u/ rewrite + aq_profile query-var registration above are KEPT (aq-app.php needs them).
   ──────────────────────────────────────────────────────────────────── */
/* ────────────────────────────────────────────────────────────────────────
   Yoast / OG SEO — give the profile a sensible title + description so the
   page doesn't render with the WP default "Page not found" title.
   ──────────────────────────────────────────────────────────────────── */

add_filter( 'pre_get_document_title', function ( $title ) {
	$slug = get_query_var( 'aq_profile' );
	if ( ! $slug ) {
		return $title;
	}
	$user = get_user_by( 'login', sanitize_title( $slug ) );
	if ( ! $user ) {
		return $title;
	}
	$display = $user->display_name ?: $user->user_login;
	// Use the site name (the brand source of truth — currently "Aquest"), not a hardcoded "ArtaQuest"
	// that the rebrand sweep missed: every other page's title uses the site name, so the profile was
	// the lone inconsistency. Deferring to get_bloginfo() also tracks any future brand-name change.
	return sprintf( '%s — %s', $display, get_bloginfo( 'name' ) );
}, 5 );

/**
 * Strip email from any leaderboard REST response that might leak it.
 * The existing aq_bb_rest_leaderboard already doesn't include emails,
 * but we add a hard guarantee in case downstream code is added.
 */
add_filter( 'rest_post_dispatch', function ( $response, $server, $request ) {
	$route = $request->get_route();
	if ( strpos( $route, '/aq/v1/leaderboard' ) === false ) {
		return $response;
	}
	$data = $response->get_data();
	if ( is_array( $data ) && ! empty( $data['rows'] ) ) {
		foreach ( $data['rows'] as &$r ) {
			unset( $r['user_email'], $r['email'] );
		}
		$response->set_data( $data );
	}
	return $response;
}, 10, 3 );
