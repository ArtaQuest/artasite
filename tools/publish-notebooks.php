<?php
/**
 * Publish every operator notebook that has passed the gate (2026-07-13 launch) — run on prod:
 *   wp eval-file tools/publish-notebooks.php
 * Idempotent: publish() refuses below the gate, re-mints nothing that already has a DOI/gist.
 */
use AQ\Notebook, AQ\Data;

$op = get_user_by( 'login', 'artayab' );
if ( ! $op ) { echo "no operator user\n"; return; }
wp_set_current_user( $op->ID );
Notebook::ensure_tables();

function nb_req2( $params ) {
	$r = new WP_REST_Request( 'POST' );
	foreach ( $params as $k => $v ) { $r->set_param( $k, $v ); }
	return $r;
}

$rows = Data::all( 'SELECT id, kind, title, status, score FROM ' . Data::t( 'aq_notebooks' ) . " WHERE author_id = %d AND status <> 'removed' ORDER BY id", [ $op->ID ] );
foreach ( $rows as $row ) {
	$r = Notebook::publish( nb_req2( [ 'id' => (int) $row['id'] ] ) );
	if ( is_array( $r ) ) {
		echo "published {$row['kind']} #{$row['id']} score {$r['binding_score']} doi=" . ( $r['doi_link'] ?: '(minting failed)' ) . ' colab=' . ( $r['colab_url'] ? 'yes' : 'no' ) . "\n";
	} else {
		$d = $r instanceof WP_REST_Response ? $r->get_data() : [];
		echo "held {$row['kind']} #{$row['id']} ({$row['status']}, score {$row['score']}): " . ( $d['error'] ?? 'error' ) . "\n";
	}
}
