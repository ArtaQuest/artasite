<?php
/**
 * sync-wp-profiles.php — one-time backfill of AQ\ProfileSync over every member. DRY RUN by default.
 *
 *   wp eval-file wp-content/plugins/aquest/tools/sync-wp-profiles.php            # show what would change
 *   wp eval-file wp-content/plugins/aquest/tools/sync-wp-profiles.php --apply    # write it
 *
 * Prints user id, public handle and field old → new. Never prints user_login or user_email.
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }

$apply = in_array( '--apply', (array) ( $args ?? [] ), true ) || in_array( 'apply', (array) ( $args ?? [] ), true );
echo ( $apply ? 'APPLY' : 'DRY RUN (pass --apply to write)' ) . "\n";
$n = 0; $changed = 0; $skipped = 0;
foreach ( get_users( [ 'fields' => 'ID', 'number' => -1, 'orderby' => 'ID' ] ) as $uid ) {
	$n++;
	$u = get_userdata( $uid );
	if ( AQ\ProfileSync::is_bot( $u ) ) { $skipped++; echo "#{$uid} @{$u->user_nicename}: skipped (bot)\n"; continue; }
	$diff = $apply ? AQ\ProfileSync::sync( $uid ) : AQ\ProfileSync::plan( $uid );
	if ( ! $diff ) { continue; }
	$changed++;
	foreach ( $diff as $f => $p ) {
		printf( "#%d @%s %s: %s -> %s\n", $uid, $u->user_nicename, $f, wp_json_encode( $p[0] ), wp_json_encode( $p[1] ) );
	}
}
printf( "%d users, %d %s, %d bots skipped\n", $n, $changed, $apply ? 'updated' : 'would change', $skipped );
