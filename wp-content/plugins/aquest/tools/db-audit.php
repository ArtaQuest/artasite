<?php
/**
 * DB lean-audit — the engine of the cleanup/refactor dev cycle (see /CLEANUP.md).
 *
 * For every schema column it greps the whole codebase (plugin + theme + SPA) for that
 * column name and reports how many times it is referenced OUTSIDE the schema definition.
 * Zero references = a dead column that stores bytes no code ever reads or writes → a
 * removal candidate. It also lists live DB tables with their row counts and whether the
 * code mentions them at all, so orphaned tables surface too.
 *
 * Read-only: it changes nothing. It only tells you what to delete. Run:
 *   studio wp eval "require WP_PLUGIN_DIR.'/aquest/tools/db-audit.php';"
 *
 * Workflow: run it → for each ⚠ candidate, confirm by hand (grep + check the column's
 * data) → drop it in Schema::tables() + add the ALTER/DROP to Schema::migrate() → bump
 * Schema::VERSION → re-run this audit until the candidate list is empty.
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }
global $wpdb;

// ── Roots scanned for column/table references. ─────────────────────────────
$roots = [
	WP_PLUGIN_DIR . '/aquest/src',
	WP_PLUGIN_DIR . '/aquest/tools',
	get_theme_root() . '/artaquest-theme/includes',
	dirname( ABSPATH ) . '/artaquest-web/src',          // SPA (sibling of WP root in this checkout)
	ABSPATH . '../artaquest-web/src',                   // fallback relative layout
];
$exts   = [ 'php', 'ts', 'tsx', 'js', 'jsx' ];
$files  = [];
foreach ( $roots as $root ) {
	if ( ! is_dir( $root ) ) { continue; }
	$it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $root, FilesystemIterator::SKIP_DOTS ) );
	foreach ( $it as $f ) {
		if ( in_array( strtolower( $f->getExtension() ), $exts, true ) && strpos( $f->getPathname(), '/node_modules/' ) === false ) {
			$files[ $f->getPathname() ] = file_get_contents( $f->getPathname() );
		}
	}
}
// Schema.php defines columns; references there don't count as "used".
$schema_path = WP_PLUGIN_DIR . '/artaquest/src/Schema.php';
$code = '';
foreach ( $files as $path => $src ) { if ( $path !== $schema_path ) { $code .= "\n" . $src; } }

/** Count word-boundary references to a bare identifier across all non-schema code. */
$refs = function ( $name ) use ( $code ) {
	return preg_match_all( '/\b' . preg_quote( $name, '/' ) . '\b/', $code );
};

// ── Parse Schema::tables() → table => [columns]. ───────────────────────────
$defs   = AQ\Schema::tables();
$schema = [];
foreach ( $defs as $table => $body ) {
	$cols = [];
	foreach ( explode( "\n", $body ) as $line ) {
		$line = trim( $line );
		if ( $line === '' || preg_match( '/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT)\b/i', $line ) ) { continue; }
		if ( preg_match( '/^`?([a-z_][a-z0-9_]*)`?\s+[A-Za-z]/', $line, $m ) ) { $cols[] = $m[1]; }
	}
	$schema[ $table ] = $cols;
}

// ── Report 1: dead-column candidates. ──────────────────────────────────────
echo "=== COLUMN USAGE (refs outside Schema.php; ⚠ = 0 = removal candidate) ===\n";
$candidates = 0;
foreach ( $schema as $table => $cols ) {
	$dead = [];
	foreach ( $cols as $c ) {
		if ( in_array( $c, [ 'id' ], true ) ) { continue; } // generic PK, always referenced indirectly
		if ( $refs( $c ) === 0 ) { $dead[] = $c; }
	}
	if ( $dead ) {
		$candidates += count( $dead );
		printf( "  ⚠ %-22s  dead: %s\n", $table, implode( ', ', $dead ) );
	}
}
if ( ! $candidates ) { echo "  ✓ no zero-reference columns — every schema column is used somewhere.\n"; }

// ── Report 2: live tables vs schema + row counts. ──────────────────────────
echo "\n=== LIVE TABLES (row counts; flag = empty and/or unreferenced in code) ===\n";
$live = $wpdb->get_col( "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" );
if ( ! $live ) { $live = $wpdb->get_col( 'SHOW TABLES' ); }
$p = $wpdb->prefix;
foreach ( $live as $t ) {
	if ( $t === '' || $t[0] === '_' || stripos( $t, 'sqlite' ) !== false ) { continue; } // engine internals
	if ( strpos( $t, $p . 'aq_' ) !== 0 && strpos( $t, $p . 'ay_' ) !== 0 ) { continue; }  // only our tables
	$rows  = (int) $wpdb->get_var( "SELECT COUNT(*) FROM `$t`" );
	$key   = preg_replace( '/^' . preg_quote( $p, '/' ) . '/', '', $t );
	$in_schema = isset( $schema[ $key ] );
	$in_code   = $refs( $key ) > 0;
	$flags = [];
	if ( ! $in_schema && ! $in_code ) { $flags[] = 'ORPHAN (no schema, no code)'; }
	elseif ( ! $in_schema )           { $flags[] = 'not in Schema (theme-created)'; }
	if ( $rows === 0 )                { $flags[] = 'EMPTY'; }
	printf( "  %-30s %8d  %s\n", $key, $rows, $flags ? '⚠ ' . implode( ' · ', $flags ) : '' );
}

echo "\nDone. Candidates are starting points — confirm each by hand before dropping.\n";
