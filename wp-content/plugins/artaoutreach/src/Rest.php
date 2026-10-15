<?php
namespace ArtaOutreach;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * REST surface, namespace artaoutreach/v1. Authenticate with an application password
 * (Basic auth, HTTPS) for an administrator; every route requires manage_options. One row
 * per route, same shape as AQ\Rest::ROUTES.
 */
class Rest {
	const NS = 'artaoutreach/v1';

	const ROUTES = [
		[ 'POST', '/accounts',               'ingest' ],   // Mac discovery: upsert by platform+handle
		[ 'GET',  '/queue',                  'queue' ],    // phone: included, not yet sent
		[ 'PATCH', '/accounts/(?P<id>\d+)',       'update' ], // notes only
		[ 'POST', '/accounts/(?P<id>\d+)/sent',     'sent' ],
		[ 'POST', '/accounts/(?P<id>\d+)/accepted', 'accepted' ],
	];

	public static function register() {
		foreach ( self::ROUTES as [ $method, $path, $fn ] ) {
			register_rest_route( self::NS, $path, [
				'methods'             => $method,
				'callback'            => [ self::class, $fn ],
				'permission_callback' => [ self::class, 'can' ],
			] );
		}
	}

	public static function can() {
		return current_user_can( 'manage_options' );
	}

	private static function ts( $v ) {
		if ( ! $v ) { return null; }
		$t = strtotime( (string) $v );
		return $t ? gmdate( 'Y-m-d H:i:s', $t ) : null;
	}

	/** Body: one account object, or {"accounts":[...]} (max 500). */
	public static function ingest( \WP_REST_Request $req ) {
		$body = $req->get_json_params();
		if ( ! is_array( $body ) ) { return new \WP_Error( 'aor_body', 'JSON body required', [ 'status' => 400 ] ); }
		$list = isset( $body['accounts'] ) && is_array( $body['accounts'] ) ? $body['accounts'] : [ $body ];
		if ( count( $list ) > 500 ) { return new \WP_Error( 'aor_size', 'max 500 accounts per request', [ 'status' => 413 ] ); }
		$out = [ 'inserted' => 0, 'updated' => 0, 'errors' => [] ];
		foreach ( $list as $i => $r ) {
			$row = is_array( $r ) ? Store::clean( $r ) : new \WP_Error( 'aor_item', 'not an object' );
			if ( is_wp_error( $row ) ) { $out['errors'][] = [ 'index' => $i, 'error' => $row->get_error_message() ]; continue; }
			$out[ Store::upsert( $row, self::ts( $r['discovered_at'] ?? null ), array_keys( $r ) ) ]++;
		}
		return rest_ensure_response( $out );
	}

	public static function queue( \WP_REST_Request $req ) {
		return rest_ensure_response( Store::queue( (string) $req->get_param( 'platform' ), (int) ( $req->get_param( 'limit' ) ?: 20 ) ) );
	}

	private static function mark( \WP_REST_Request $req, $what ) {
		$id = (int) $req['id'];
		if ( ! Store::get( $id ) ) { return new \WP_Error( 'aor_404', 'no such account', [ 'status' => 404 ] ); }
		$r = Store::mark( $id, $what, self::ts( $req->get_param( 'at' ) ) );
		if ( is_wp_error( $r ) ) { return $r; }
		$r['time_to_accept_s'] = Store::time_to_accept( $r );
		return rest_ensure_response( $r );
	}

	/** PATCH {"notes":"..."} — the only field editable here; decisions stay in wp-admin. */
	public static function update( \WP_REST_Request $req ) {
		$id = (int) $req['id'];
		if ( ! Store::get( $id ) ) { return new \WP_Error( 'aor_404', 'no such account', [ 'status' => 404 ] ); }
		$notes = $req->get_param( 'notes' );
		if ( ! is_string( $notes ) ) { return new \WP_Error( 'aor_notes', 'notes (string) required', [ 'status' => 400 ] ); }
		Store::set_notes( $id, $notes );
		return rest_ensure_response( Store::get( $id ) );
	}

	public static function sent( \WP_REST_Request $req ) { return self::mark( $req, 'sent' ); }
	public static function accepted( \WP_REST_Request $req ) { return self::mark( $req, 'accepted' ); }
}
