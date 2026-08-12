<?php
/**
 * Every aq_*() function and AQ class method that our PHP CALLS must be DEFINED in the code we ship.
 *
 * php -l cannot see this. An undefined function or method is a RUNTIME fatal, so a file that parses
 * perfectly takes a page down the moment somebody loads it — which is exactly how the public profile
 * broke twice on 2026-08-11: once on Verify::birthplace() after the method was deleted and a caller
 * survived a comment-filtered grep, and once on aq_kind_label(), where the edit that defined it was
 * discarded by a script that aborted before writing while still printing "added".
 *
 * Precise on purpose. A call is NOT reported when:
 *   - the same line guards it with function_exists() / method_exists()
 *   - it is inside a comment
 *   - it lives in the retired MasterStudy templates/ tree, which is dead and references a plugin
 *     that was removed (STM_LMS_*, AQ_I18N_Router). Those are a separate cleanup, not this gate's job.
 *
 *   php tools/undefined-calls.php   → exit 1 and a file:line list, or "OK"
 */
$roots = [ 'wp-content/themes/artaquest-theme', 'wp-content/plugins/aquest' ];
$skip  = [ '/app/', '/vendor/', '/node_modules/', '/templates/' ];

$files = [];
foreach ( $roots as $root ) {
	if ( ! is_dir( $root ) ) { continue; }
	foreach ( new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $root ) ) as $f ) {
		$p = $f->getPathname();
		if ( substr( $p, -4 ) !== '.php' ) { continue; }
		foreach ( $skip as $s ) { if ( strpos( $p, $s ) !== false ) { continue 2; } }
		$files[] = $p;
	}
}

$fnDefs  = [];
$mDefs   = [];
$ourClass = [];
foreach ( $files as $p ) {
	foreach ( preg_split( '/\R/', file_get_contents( $p ) ) as $ln ) {
		if ( preg_match( '/^\s*function\s+(aq_[a-z0-9_]+)\s*\(/i', $ln, $m ) ) { $fnDefs[ strtolower( $m[1] ) ] = true; }
		if ( preg_match( '/function\s+([a-z0-9_]+)\s*\(/i', $ln, $m ) ) { $mDefs[ strtolower( $m[1] ) ] = true; }
		if ( preg_match( '/^\s*(?:final\s+|abstract\s+)?class\s+([A-Za-z0-9_]+)/', $ln, $m ) ) { $ourClass[ $m[1] ] = true; }
	}
}

$bad = [];
foreach ( $files as $p ) {
	$lines   = preg_split( '/\R/', file_get_contents( $p ) );
	$inBlock = false;
	foreach ( $lines as $i => $raw ) {
		// Track /* … */ properly: a block comment's middle lines do not have to start with '*', and a
		// prose mention of aq_points_ledger() inside one is not a call. This was the last false
		// positive, and a gate nobody trusts is a gate nobody keeps.
		$opens = substr_count( $raw, '/*' );
		$closes = substr_count( $raw, '*/' );
		$wasInBlock = $inBlock;
		if ( $opens > $closes ) { $inBlock = true; } elseif ( $closes > $opens ) { $inBlock = false; }
		if ( $wasInBlock || ( $opens && $closes === 0 ) ) { continue; }
		if ( preg_match( '~^\s*(\*|//|#|/\*)~', $raw ) ) { continue; }
		// `new AQ_Thing()` is a constructor, not a function call.
		if ( preg_match( '~\bnew\s+[A-Za-z_]~', $raw ) ) { continue; }
		$code = preg_replace( '~//.*$~', '', $raw );
		// SQL, not PHP. `CREATE TABLE {$p}aq_chat_keys (` is a table name followed by a paren, and a
		// FROM/JOIN clause reads the same way — none of them is a function call.
		if ( preg_match( '~\b(CREATE\s+TABLE|INSERT\s+INTO|ALTER\s+TABLE|DROP\s+TABLE|UPDATE\s+|DELETE\s+FROM|\bFROM\b|\bJOIN\b|dbDelta)~i', $code ) ) { continue; }
		// A guarded call is a deliberate optional dependency, not a bug.
		$guarded = ( stripos( $code, 'function_exists' ) !== false || stripos( $code, 'method_exists' ) !== false );

		if ( preg_match_all( '/(?<![$\\w>])(aq_[a-z0-9_]+)\s*\(/', $code, $ms, PREG_SET_ORDER ) ) {
			foreach ( $ms as $m ) {
				$fn = strtolower( $m[1] );
				if ( $guarded ) { continue; }
				// `{$p}aq_thing (` / `{$wpdb->prefix}aq_thing (` is a table, not a call.
				if ( preg_match( '~\}' . preg_quote( $m[1], '~' ) . '\s*\(~', $code ) ) { continue; }
				if ( preg_match( '/function\s+' . preg_quote( $m[1], '/' ) . '\s*\(/i', $code ) ) { continue; }
				if ( ! isset( $fnDefs[ $fn ] ) ) { $bad[] = sprintf( '%s:%d  %s()', $p, $i + 1, $m[1] ); }
			}
		}
		if ( preg_match_all( '/(?:\\\\?AQ\\\\)?\b([A-Z][A-Za-z0-9_]*)::([a-z_][A-Za-z0-9_]*)\s*\(/', $code, $ms, PREG_SET_ORDER ) ) {
			foreach ( $ms as $m ) {
				if ( $guarded ) { continue; }
				// Only classes WE define. Closure::bind(), WP_Session_Tokens::get_instance() and
				// Requests::request_multiple() are PHP's and WordPress's, and this gate has no business
				// asserting anything about them.
				if ( ! isset( $ourClass[ $m[1] ] ) ) { continue; }
				$meth = strtolower( $m[2] );
				if ( in_array( $meth, [ 'class', '__construct', '__callstatic' ], true ) ) { continue; }
				if ( ! isset( $mDefs[ $meth ] ) ) { $bad[] = sprintf( '%s:%d  %s::%s()', $p, $i + 1, $m[1], $m[2] ); }
			}
		}
	}
}

$bad = array_values( array_unique( $bad ) );
printf( "scanned %d files · %d aq_* definitions · %d method definitions\n", count( $files ), count( $fnDefs ), count( $mDefs ) );
if ( $bad ) {
	echo "UNDEFINED CALLS (" . count( $bad ) . ") — these are runtime fatals waiting for a page load:\n";
	foreach ( $bad as $b ) { echo "  $b\n"; }
	exit( 1 );
}
echo "OK — every aq_*() and AQ method call resolves to a definition we ship\n";
