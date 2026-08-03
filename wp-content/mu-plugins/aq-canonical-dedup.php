<?php
/**
 * Plugin Name: ArtaQuest canonical dedup
 *
 * Sam (the realbot persona) keeps confirming a duplicate-canonical bug
 * on every page: AQ_I18N_SEO emits a language-prefixed canonical at
 * wp_head priority 1, then WordPress core emits its own rel_canonical
 * at default priority 10.
 *
 * The fix lives in `class-seo.php` (a `remove_action('wp_head',
 * 'rel_canonical')` in boot()), but boot() depends on the artaquest-lms
 * plugin's init lifecycle — which isn't running reliably on prod
 * (see [[project-restart-plan]] / task #20).
 *
 * This mu-plugin runs unconditionally and removes core's rel_canonical
 * from wp_head as early as possible. mu-plugins load before regular
 * plugins, so this fires whether or not the LMS init lifecycle wakes.
 *
 * Removing only the CORE rel_canonical leaves our language-aware
 * canonical (emitted by AQ_I18N_SEO::meta_seo_tags) in place.
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }

// Earliest hook that fires for every front-end request.
add_action( 'wp_loaded', function () {
	remove_action( 'wp_head', 'rel_canonical' );
}, 1 );

// Belt-and-braces: also remove on the page that core injects it from.
add_action( 'wp_head', function () {
	remove_action( 'wp_head', 'rel_canonical' );
}, 0 );
