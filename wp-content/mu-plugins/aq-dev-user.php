<?php
/**
 * LOCAL-ONLY dev auth shim. The Vite dev server (artaquest-web/vite.config.ts) proxies /wp-json
 * to Studio and sets `X-AQ-Dev-User: <login>` so the SPA runs as that member in dev — including
 * REST writes, which the shim authenticates in place of the cookie+nonce pair the theme shell
 * provides in production.
 *
 * Safety: this file lives in mu-plugins, which WordPress.com excludes from every sync/deploy —
 * it can never reach production. Belt-and-braces, it also refuses unless the request comes from
 * loopback or the environment is 'local' (Studio).
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }

function aq_dev_user_allowed() {
	if ( empty( $_SERVER['HTTP_X_AQ_DEV_USER'] ) ) { return false; }
	$addr = $_SERVER['REMOTE_ADDR'] ?? '';
	return wp_get_environment_type() === 'local' || in_array( $addr, [ '127.0.0.1', '::1' ], true );
}

add_filter( 'determine_current_user', function ( $uid ) {
	if ( $uid || ! aq_dev_user_allowed() ) { return $uid; }
	$u = get_user_by( 'login', sanitize_user( wp_unslash( $_SERVER['HTTP_X_AQ_DEV_USER'] ) ) );
	return $u ? (int) $u->ID : $uid;
}, 20 );

// REST writes normally demand the cookie nonce; here the header IS the (local-only) authentication.
add_filter( 'rest_authentication_errors', function ( $result ) {
	return ( aq_dev_user_allowed() && get_current_user_id() ) ? true : $result;
} );
