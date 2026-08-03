<?php
/**
 * Plugin Name: ArtaQuest rebrand migrator
 *
 * Re-points the `active_plugins`, `stylesheet`, `template`, and
 * `current_theme` options at the renamed slugs once. Required because the
 * site is being deep-renamed from "artayab-*" → "artaquest-*" — the new
 * files exist at the new path, but the DB still has the old slug, so
 * WordPress would silently deactivate the plugin and theme.
 *
 * mu-plugins are loaded by core before the regular plugins list is
 * resolved, so we can rewrite the options in-place and core then loads
 * the right paths on the same request.
 *
 * Guarded by option `aq_rebrand_slug_migrated` — runs exactly once per
 * install.
 */

if ( ! defined( 'ABSPATH' ) ) { exit; }

add_action( 'plugins_loaded', function () {
	if ( get_option( 'aq_rebrand_slug_migrated' ) ) { return; }

	global $wpdb;
	$dir = WP_PLUGIN_DIR;

	// active_plugins — replace 'artayab-lms/...' with 'artaquest-lms/...'
	$active = get_option( 'active_plugins', array() );
	if ( is_array( $active ) ) {
		$new = array();
		foreach ( $active as $slug ) {
			// Common patterns: artayab-lms/artayab-lms.php, artayab-lms/artaquest-lms.php
			$slug = str_replace( 'artayab-lms/artayab-lms.php', 'artaquest-lms/artaquest-lms.php', $slug );
			$slug = str_replace( 'artayab-lms/',                'artaquest-lms/',                $slug );
			$slug = str_replace( 'artayab-theme',               'artaquest-theme',               $slug );
			$new[] = $slug;
		}
		// Dedup + verify each plugin file actually exists
		$verified = array();
		foreach ( $new as $s ) {
			if ( file_exists( $dir . '/' . $s ) ) { $verified[] = $s; }
		}
		if ( $verified !== $active ) {
			update_option( 'active_plugins', array_values( array_unique( $verified ) ) );
		}
	}

	// Theme stylesheet + template
	if ( 'artayab-theme' === get_option( 'stylesheet' ) ) {
		update_option( 'stylesheet', 'artaquest-theme' );
	}
	if ( 'artayab-theme' === get_option( 'template' ) ) {
		update_option( 'template', 'artaquest-theme' );
	}
	if ( 'ArtaYAB' === get_option( 'current_theme' ) || 'ArtaYAB Theme' === get_option( 'current_theme' ) ) {
		update_option( 'current_theme', 'ArtaQuest' );
	}
	// Site name
	$bn = get_option( 'blogname' );
	if ( 'ArtaYAB' === $bn ) {
		update_option( 'blogname', 'ArtaQuest' );
	}

	update_option( 'aq_rebrand_slug_migrated', array( 'ts' => time() ), false );
}, 0 );
