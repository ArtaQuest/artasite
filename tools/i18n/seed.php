<?php
/**
 * Seed hand-written translations into the content-addressed mesh (aq_translations).
 *
 * Reads seed.ndjson (one JSON object per line: {"en":…, "fa":…, "tr":…, "ar":…, "fr":…, "es":…})
 * and inserts one row per language, keyed by md5(en) — the exact scheme AQ\I18n uses — with
 * status='human' so hand translations are distinguishable from the 'auto' Google mesh. Write-once:
 * an existing (hash, lang) row is never overwritten, so re-running is idempotent and the seeder
 * can never clobber a translation that arrived first (set $aq_seed_wipe to clear the table first).
 *
 * Run locally (PHP-WASM):   studio wp eval '$aq_seed_wipe = true; require ABSPATH . "tools/i18n/seed.php";'
 * Run on prod (real PHP):   wp eval-file aq-seed.php --path=/srv/htdocs   (script + ndjson scp'd beside it)
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }

global $wpdb, $aq_seed_wipe, $aq_seed_file;

$table = $wpdb->prefix . 'aq_translations';
$file  = isset( $aq_seed_file ) ? $aq_seed_file : __DIR__ . '/seed.ndjson';
$langs = array( 'fa', 'tr', 'ar', 'fr', 'es' );

if ( ! file_exists( $file ) ) {
	echo "seed file missing: $file\n";
	return;
}

if ( ! empty( $aq_seed_wipe ) ) {
	$before = (int) $wpdb->get_var( "SELECT COUNT(*) FROM $table" ); // phpcs:ignore WordPress.DB.PreparedSQL
	$wpdb->query( "DELETE FROM $table" ); // phpcs:ignore WordPress.DB.PreparedSQL -- full reset, table name from prefix
	echo "wiped $before cached translations\n";
}

$ins = 0; $skip = 0; $lines = 0;
$fh = fopen( $file, 'r' );
while ( ( $line = fgets( $fh ) ) !== false ) {
	$line = trim( $line );
	if ( $line === '' ) { continue; }
	$row = json_decode( $line, true );
	if ( ! is_array( $row ) || ! isset( $row['en'] ) || trim( (string) $row['en'] ) === '' ) { continue; }
	$lines++;
	$hash = md5( (string) $row['en'] );
	foreach ( $langs as $lang ) {
		if ( ! isset( $row[ $lang ] ) || trim( (string) $row[ $lang ] ) === '' ) { continue; }
		$exists = $wpdb->get_var( $wpdb->prepare(
			"SELECT 1 FROM $table WHERE source_hash = %s AND lang = %s", $hash, $lang // phpcs:ignore WordPress.DB.PreparedSQL
		) );
		if ( $exists ) { $skip++; continue; }
		$wpdb->insert( $table, array(
			'source_hash'     => $hash,
			'lang'            => $lang,
			'source_text'     => (string) $row['en'],
			'translated_text' => (string) $row[ $lang ],
			'context'         => 'content',
			'status'          => 'human',
			'updated_at'      => current_time( 'mysql' ),
		) );
		$ins++;
	}
}
fclose( $fh );
echo "seeded: $lines strings, $ins rows inserted, $skip already present\n";
