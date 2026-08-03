<?php
/**
 * Plugin Name: ArtaQuest brand-cleanup passes (mu-plugin)
 *
 * Consolidates every brand-rename cleanup pass into a single mu-plugin
 * so they run UNCONDITIONALLY, bypassing the broken artaquest-lms init
 * lifecycle on prod (see task #20).
 *
 * Each pass is guarded by its own done-flag option so it runs exactly
 * once per environment. The passes are idempotent — re-running on
 * already-clean content is a no-op.
 *
 * Passes (in execution order on wp_loaded priority 5):
 *   1) aq_mu_block_rewrite       : wp:masterstudy/ → wp:artaquest/, wp-block-masterstudy → wp-block-artaquest in posts.post_content
 *   2) aq_mu_brand_text_sweep    : ArtaYAB / ArtaYab / Artayab → ArtaQuest in posts.post_content + post_excerpt + post_title
 *   3) aq_mu_donate_repair       : "your your Arta coin" → "your ArtaQuest coin" on /donate/
 *   4) aq_mu_blog_options        : blogname / blogdescription / admin_email if they contain artayab
 *   5) aq_mu_i18n_cache_purge    : purge translated-page transients so they regenerate against new source
 *
 * NEVER touches wp_options.option_value or postmeta.meta_value with
 * naive str_replace — those columns store serialized PHP. See
 * [[feedback-serialized-options]].
 */

if ( ! defined( 'ABSPATH' ) ) { exit; }

add_action( 'wp_loaded', 'aq_mu_run_all_passes', 5 );

function aq_mu_run_all_passes() {
	// Bail in admin / ajax / cron / rest contexts to avoid running during
	// background operations or installer paths.
	if ( wp_doing_ajax() || wp_doing_cron() ) return;
	if ( defined( 'REST_REQUEST' ) && REST_REQUEST ) return;
	if ( defined( 'WP_INSTALLING' ) && WP_INSTALLING ) return;

	aq_mu_pass_block_rewrite();
	aq_mu_pass_brand_text_sweep();
	aq_mu_pass_donate_repair();
	aq_mu_pass_blog_options();
	aq_mu_pass_i18n_cache_purge();
}

/**
 * 1) wp:masterstudy/* → wp:artaquest/* in posts.post_content
 *    + wp-block-masterstudy → wp-block-artaquest
 *    + MasterStudy → ArtaQuest (capitalised)
 */
function aq_mu_pass_block_rewrite() {
	if ( get_option( 'aq_mu_block_rewrite_done' ) ) return;
	global $wpdb;

	$rows = $wpdb->get_results( "SELECT ID, post_content FROM $wpdb->posts WHERE post_content LIKE '%masterstudy%' OR post_content LIKE '%MasterStudy%'" );
	$n = 0;
	foreach ( $rows as $r ) {
		$new = $r->post_content;
		$new = preg_replace( '#wp:masterstudy/#', 'wp:artaquest/', $new );
		$new = str_replace( 'wp-block-masterstudy',   'wp-block-artaquest',   $new );
		$new = str_replace( '--wp-block-masterstudy', '--wp-block-artaquest', $new );
		$new = str_replace( 'masterstudy_authorization_form',      'artaquest_authorization_form',      $new );
		$new = str_replace( 'masterstudy_instructor_registration', 'artaquest_instructor_registration', $new );
		$new = str_replace( 'masterstudy_membership_pricing',      'artaquest_membership_pricing',      $new );
		$new = str_ireplace( 'masterstudy', 'artaquest', $new );
		$new = str_replace( 'MasterStudy',  'ArtaQuest',  $new );
		if ( $new !== $r->post_content ) {
			$wpdb->update( $wpdb->posts, array( 'post_content' => $new ), array( 'ID' => $r->ID ) );
			$n++;
		}
	}
	update_option( 'aq_mu_block_rewrite_done', array( 'ts' => time(), 'rows' => $n ), false );
	if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) error_log( "aq_mu_block_rewrite: $n rows" );
}

/**
 * 2) Brand text sweep across post_content, post_excerpt, post_title.
 */
function aq_mu_pass_brand_text_sweep() {
	if ( get_option( 'aq_mu_brand_text_sweep_done' ) ) return;
	global $wpdb;

	$from = array( 'ArtaYAB', 'ArtaYab', 'Artayab', 'artayab', 'ARTAYAB' );
	$to   = array( 'ArtaQuest', 'ArtaQuest', 'Artaquest', 'artaquest', 'ARTAQUEST' );
	$report = array();

	foreach ( array( 'post_content', 'post_excerpt', 'post_title' ) as $col ) {
		$rows = $wpdb->get_results(
			"SELECT ID, $col FROM $wpdb->posts
			 WHERE $col LIKE '%rtaYAB%' OR $col LIKE '%rtaYab%' OR $col LIKE '%rtayab%' OR $col LIKE '%RTAYAB%'"
		);
		$n = 0;
		foreach ( $rows as $r ) {
			$old = $r->$col;
			// Don't strip artayab.org — the live domain. Use a sentinel.
			$old_safe = str_replace( 'artayab.org', "\0AYDOMAIN\0", $old );
			$new      = str_replace( $from, $to, $old_safe );
			$new      = str_replace( "\0AYDOMAIN\0", 'artayab.org', $new );
			if ( $new !== $old ) {
				$wpdb->update( $wpdb->posts, array( $col => $new ), array( 'ID' => $r->ID ) );
				$n++;
			}
		}
		$report[ $col ] = $n;
	}

	update_option( 'aq_mu_brand_text_sweep_done', array( 'ts' => time(), 'report' => $report ), false );
	if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) error_log( 'aq_mu_brand_text_sweep: ' . wp_json_encode( $report ) );
}

/**
 * 3) Targeted donate-copy repair. The "your your Arta coin" typo + bare
 *    "Arta coin" → "ArtaQuest coin".
 */
function aq_mu_pass_donate_repair() {
	if ( get_option( 'aq_mu_donate_repair_done' ) ) return;
	global $wpdb;

	$donate = get_page_by_path( 'donate' );
	$fixed  = 0;
	if ( $donate ) {
		$c = $donate->post_content;
		$o = $c;
		$c = preg_replace( '/\byour your\b/i',           'your',             $c );
		$c = preg_replace( '/(?<!ArtaQuest )\bArta coin/u', 'ArtaQuest coin', $c );
		$c = preg_replace( '/(?<!ArtaQuest )\bArta Coin/u', 'ArtaQuest Coin', $c );
		if ( $c !== $o ) {
			$wpdb->update( $wpdb->posts, array( 'post_content' => $c ), array( 'ID' => $donate->ID ) );
			$fixed = 1;
		}
	}
	update_option( 'aq_mu_donate_repair_done', array( 'ts' => time(), 'fixed' => $fixed ), false );
	if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) error_log( "aq_mu_donate_repair: fixed=$fixed" );
}

/**
 * 4) Safe options only (blogname, blogdescription, admin_email).
 *    NEVER str_replace on any option_value that might be serialized.
 */
function aq_mu_pass_blog_options() {
	if ( get_option( 'aq_mu_blog_options_done' ) ) return;

	$from = array( 'ArtaYAB', 'ArtaYab', 'Artayab', 'artayab', 'ARTAYAB' );
	$to   = array( 'ArtaQuest', 'ArtaQuest', 'Artaquest', 'artaquest', 'ARTAQUEST' );
	$report = array();

	foreach ( array( 'blogname', 'blogdescription' ) as $opt ) {
		$v = get_option( $opt );
		if ( is_string( $v ) && stripos( $v, 'artayab' ) !== false ) {
			$new = str_replace( $from, $to, $v );
			update_option( $opt, $new );
			$report[ $opt ] = $new;
		}
	}
	update_option( 'aq_mu_blog_options_done', array( 'ts' => time(), 'report' => $report ), false );
	if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) error_log( 'aq_mu_blog_options: ' . wp_json_encode( $report ) );
}

/**
 * 5) Purge i18n page cache so translated pages regenerate against
 *    the now-clean source HTML. Runs every time any of the above
 *    actually touched data (not gated by its own flag) — but cheap.
 */
function aq_mu_pass_i18n_cache_purge() {
	// Only purge once. Run conditional on any of the above having
	// reported changes.
	if ( get_option( 'aq_mu_i18n_cache_purged' ) ) return;
	$any = false;
	foreach ( array( 'aq_mu_block_rewrite_done', 'aq_mu_brand_text_sweep_done', 'aq_mu_donate_repair_done' ) as $opt ) {
		$v = get_option( $opt );
		if ( ! is_array( $v ) ) continue;
		if ( ( isset( $v['rows']) && $v['rows'] > 0 )
			|| ( isset( $v['fixed']) && $v['fixed'] > 0 )
			|| ( isset( $v['report']) && array_sum( array_filter( $v['report'], 'is_int' ) ) > 0 ) ) {
			$any = true; break;
		}
	}
	if ( ! $any ) return;

	global $wpdb;
	$n = $wpdb->query( "DELETE FROM $wpdb->options WHERE option_name LIKE '_transient_ay_i18n_pg_%' OR option_name LIKE '_transient_timeout_ay_i18n_pg_%'" );
	update_option( 'aq_mu_i18n_cache_purged', array( 'ts' => time(), 'rows' => $n ), false );
	if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) error_log( "aq_mu_i18n_cache_purged: $n rows" );
}
