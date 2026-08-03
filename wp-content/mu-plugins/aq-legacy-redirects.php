<?php
/**
 * Plugin Name: ArtaQuest Legacy Redirects
 * Description: Keeps renamed routes reachable. Lives as a mu-plugin so it runs
 *   independently of the theme.
 *
 * iter-364 (user 2026-05-26): the Leaderboard(s) page was renamed to Rankings
 *   (slug /rankings/). A PHP 301 from the old /leaderboard(s)/ URLs is
 *   unreliable here: under PHP-WASM the 404 status + headers for the now-missing
 *   old slug are committed before template_redirect runs, so wp_redirect/
 *   wp_safe_redirect silently no-op. Instead we ALIAS the old paths onto the
 *   Rankings page at query-parse time (the `request` filter, which runs before
 *   the 404 is determined) so old links + bookmarks resolve with a 200, and add
 *   a rel=canonical to /rankings/ so search engines consolidate on the new URL.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Map /leaderboard, /leaderboards (and their /xx/ language-prefixed forms — the
 * i18n Router has already stripped the prefix by the time `request` fires) onto
 * the Rankings page.
 */
add_filter( 'request', function ( $query_vars ) {
	$path = trim( (string) wp_parse_url( $_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH ), '/' );
	$path = preg_replace( '#^[a-z]{2}/#', '', $path ); // belt-and-braces prefix strip
	if ( 'leaderboard' === $path || 'leaderboards' === $path ) {
		return array( 'pagename' => 'rankings' );
	}
	return $query_vars;
} );

/**
 * Point the canonical URL of an aliased request at the real /rankings/ page so
 * search engines consolidate there (filtering the source avoids emitting a
 * duplicate <link rel="canonical">).
 */
function aq_is_rankings_alias() {
	$path = trim( (string) wp_parse_url( $_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH ), '/' );
	$path = preg_replace( '#^[a-z]{2}/#', '', $path );
	return ( 'leaderboard' === $path || 'leaderboards' === $path );
}
add_filter( 'get_canonical_url', function ( $url ) {
	return aq_is_rankings_alias() ? home_url( '/rankings/' ) : $url;
}, 20 );
add_filter( 'aq_i18n_canonical', function ( $url ) {
	return aq_is_rankings_alias() ? home_url( '/rankings/' ) : $url;
}, 20 );
