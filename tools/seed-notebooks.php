<?php
/**
 * Feed launch seeder (2026-07-13) — run on prod via:
 *   wp eval-file tools/seed-notebooks.php <dir-with-ipynbs> [iters]
 *
 * For every <kind>.ipynb in <dir> (file basename = the kind), creates a draft under the operator,
 * saves the authored source, and queues one ArtaDev run (default 5 iterations — the loop stops
 * early the moment the critic passes 95, refunding unused iterations). The notebook relay then
 * executes + iterates each; publish afterwards with tools/publish-notebooks.php.
 * Skips kinds that already have a non-removed notebook with the same title (idempotent re-runs).
 */
use AQ\Notebook, AQ\Data, AQ\Economy;

$dir   = isset( $args[0] ) ? rtrim( $args[0], '/' ) : '/tmp/nb-demos';
$iters = isset( $args[1] ) ? max( 1, min( 12, (int) $args[1] ) ) : 5;
$op    = get_user_by( 'login', 'artayab' );
if ( ! $op ) { echo "no operator user\n"; return; }
wp_set_current_user( $op->ID );
Notebook::ensure_tables();

// Fund the ArtaDev fees (append-only, one distinct ref per invocation second).
if ( Economy::coin_balance( $op->ID ) < 100 ) {
	Economy::credit_coins( $op->ID, 200, 'operator', 'nbseed:' . time() );
}

function nb_req( $params ) {
	$r = new WP_REST_Request( 'POST' );
	foreach ( $params as $k => $v ) { $r->set_param( $k, $v ); }
	return $r;
}

/** Title = the first "# " line of the first markdown cell; abstract = its first plain paragraph. */
function nb_meta_from( $ipynb ) {
	$j = json_decode( $ipynb, true );
	$src = '';
	foreach ( ( $j['cells'] ?? [] ) as $c ) {
		if ( ( $c['cell_type'] ?? '' ) === 'markdown' ) { $src = is_array( $c['source'] ) ? implode( '', $c['source'] ) : (string) $c['source']; break; }
	}
	$title = '';
	$abstract = '';
	foreach ( preg_split( '/\n+/', $src ) as $line ) {
		$line = trim( $line );
		if ( $line === '' ) { continue; }
		if ( $title === '' && strpos( $line, '# ' ) === 0 ) { $title = trim( substr( $line, 2 ) ); continue; }
		if ( $title !== '' && $line[0] !== '#' && strpos( $line, '**How to reproduce' ) !== 0 ) {
			$abstract = trim( preg_replace( '/[*_`]/', '', $line ) );
			if ( mb_strlen( $abstract ) > 40 ) { break; }
		}
	}
	return [ $title ?: 'Untitled', $abstract ];
}

foreach ( glob( $dir . '/*.ipynb' ) as $file ) {
	$kind = basename( $file, '.ipynb' );
	if ( ! isset( Notebook::KINDS[ $kind ] ) ) { echo "skip {$kind}: not a kind\n"; continue; }
	$ipynb = file_get_contents( $file );
	[ $title, $abstract ] = nb_meta_from( $ipynb );
	$dupe = Data::one( 'SELECT id FROM ' . Data::t( 'aq_notebooks' ) . " WHERE kind = %s AND title = %s AND status <> 'removed'", [ $kind, $title ] );
	if ( $dupe ) { echo "skip {$kind}: #{$dupe['id']} already exists\n"; continue; }
	$nb = Notebook::create( nb_req( [ 'kind' => $kind, 'title' => $title ] ) );
	if ( ! is_array( $nb ) ) { echo "FAIL create {$kind}\n"; continue; }
	$saved = Notebook::save( nb_req( [ 'id' => $nb['id'], 'ipynb' => $ipynb, 'abstract' => $abstract ] ) );
	if ( ! is_array( $saved ) ) { echo "FAIL save {$kind} #{$nb['id']}\n"; continue; }
	$q = Notebook::artadev( nb_req( [ 'id' => $nb['id'], 'iters' => $iters ] ) );
	echo is_array( $q )
		? "queued {$kind} #{$nb['id']} \"{$title}\" run {$q['run_id']} (₳{$q['cost']}, {$iters} iters)\n"
		: "FAIL queue {$kind} #{$nb['id']}\n";
}
echo 'balance now ₳' . Economy::coin_balance( $op->ID ) . "\n";
