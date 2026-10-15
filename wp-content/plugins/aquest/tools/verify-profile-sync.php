<?php
/**
 * verify-profile-sync.php — exercises AQ\ProfileSync against real users. LOCAL/STUDIO ONLY: creates
 * throwaway users (aqps-test-*@example.invalid) and deletes them again.
 *
 *   studio wp eval "require WP_PLUGIN_DIR.'/aquest/tools/verify-profile-sync.php';"   # exit 0 = green
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }
require_once ABSPATH . 'wp-admin/includes/user.php';
$pass = 0; $fail = 0; $made = [];
$ok = function ( $c, $why ) use ( &$pass, &$fail ) { if ( $c ) { $pass++; echo "PASS $why\n"; } else { $fail++; echo "FAIL $why\n"; } };
$mk = function ( $login, $email, $dn, $role = 'subscriber' ) use ( &$made ) {
	$id = wp_insert_user( [ 'user_login' => $login, 'user_email' => $email, 'user_pass' => wp_generate_password( 32 ), 'display_name' => $dn, 'role' => $role ] );
	$made[] = $id; return $id;
};
try {
	// 1. email-default display name gets replaced; first/last/nick/url filled.
	$a = $mk( 'aqps-test-a', 'jane.doe-aqps@example.invalid', AQ\ProfileSync::email_default( 'jane.doe-aqps@example.invalid' ) );
	update_user_meta( $a, 'aq_full_name', 'Jane Q Doe' );
	$u = get_userdata( $a );
	$ok( $u->display_name === 'Jane Q Doe', 'default display_name replaced by full name' );
	$ok( $u->first_name === 'Jane Q' && $u->last_name === 'Doe', 'first/last split at last space' );
	$ok( $u->nickname === 'Jane Q Doe', 'nickname = full name' );
	$ok( $u->user_url === home_url( '/u/' . $u->user_nicename . '/' ), 'user_url = public profile' );
	$ok( $u->user_email === 'jane.doe-aqps@example.invalid' && $u->user_login === 'aqps-test-a', 'login/email untouched' );
	$ok( in_array( 'subscriber', $u->roles, true ) && count( $u->roles ) === 1, 'roles untouched' );

	// 2. self-chosen display name is kept.
	$b = $mk( 'aqps-test-b', 'bob-aqps@example.invalid', 'Bobby Tables' );
	update_user_meta( $b, 'aq_full_name', 'Robert Smith' );
	$u = get_userdata( $b );
	$ok( $u->display_name === 'Bobby Tables', 'self-chosen display_name kept' );
	$ok( $u->first_name === 'Robert' && $u->last_name === 'Smith', 'names still filled' );

	// 3. single word; empty display name.
	$c = $mk( 'aqps-test-c', 'c-aqps@example.invalid', 'temp' );
	global $wpdb; $wpdb->update( $wpdb->users, [ 'display_name' => '' ], [ 'ID' => $c ] ); clean_user_cache( $c );
	update_user_meta( $c, 'aq_full_name', 'Cher' );
	$u = get_userdata( $c );
	$ok( $u->display_name === 'Cher' && $u->first_name === 'Cher' && $u->last_name === '', 'single word, empty display_name filled' );

	// 4. handle change moves user_url.
	wp_update_user( [ 'ID' => $c, 'user_nicename' => 'aqps-cher-new' ] );
	$ok( get_userdata( $c )->user_url === home_url( '/u/aqps-cher-new/' ), 'user_url follows handle change' );

	// 5. idempotent.
	$ok( AQ\ProfileSync::plan( $a ) === [] && AQ\ProfileSync::sync( $a ) === [], 'second run is a no-op' );

	// 6. bots skipped; admin role preserved.
	$d = $mk( 'aqps-test-d', 'd-aqps@example.invalid', 'D Aqps' );
	update_user_meta( $d, '_aq_is_bot', 1 );
	update_user_meta( $d, 'aq_full_name', 'Robo Bot' );
	$ok( get_userdata( $d )->first_name === '' && AQ\ProfileSync::plan( $d ) === [], 'bot skipped' );
	$e = $mk( 'aqps-test-e', 'e-aqps@example.invalid', 'E Aqps', 'administrator' );
	update_user_meta( $e, 'aq_full_name', 'Admin Person' );
	$u = get_userdata( $e );
	$ok( $u->roles === [ 'administrator' ] && user_can( $e, 'manage_options' ), 'admin keeps role and manage_options' );
	$ok( $u->display_name === 'Admin Person', 'email-default admin display_name replaced' );
} finally {
	foreach ( $made as $id ) { if ( $id && ! is_wp_error( $id ) ) { wp_delete_user( $id ); } }
}
echo "$pass passed, $fail failed\n";
if ( $fail ) { exit( 1 ); }
