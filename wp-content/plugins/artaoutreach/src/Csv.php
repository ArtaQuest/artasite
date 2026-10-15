<?php
namespace ArtaOutreach;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/** CSV import / export / template for the admin page (manage_options + nonce on every action). */
class Csv {
	const NONCE     = 'aor_csv';
	const MAX_BYTES = 2097152; // 2 MB
	const MAX_ROWS  = 5000;
	const FIELDS    = [ 'platform', 'handle', 'profile_url', 'full_name', 'tagline', 'bio', 'photo', 'followers', 'following', 'connections', 'mutuals', 'notes' ];
	const EXPORT    = [ 'id', 'platform', 'handle', 'profile_url', 'full_name', 'tagline', 'bio', 'photo', 'followers', 'following', 'connections', 'mutuals', 'source', 'status', 'discovered_at', 'decided_at', 'request_sent_at', 'accepted_at', 'notes' ];
	const RESULT    = 'aor_csv_result_';

	public static function boot() {
		add_action( 'admin_post_aor_csv_import', [ self::class, 'import' ] );
		add_action( 'admin_post_aor_csv_export', [ self::class, 'export' ] );
		add_action( 'admin_post_aor_csv_template', [ self::class, 'template' ] );
	}

	private static function guard() {
		if ( ! current_user_can( 'manage_options' ) ) { wp_die( 'Forbidden', 403 ); }
		check_admin_referer( self::NONCE );
	}

	/** Neutralise spreadsheet formula injection: a cell starting = + - @ (or tab/CR) gets a leading '. */
	public static function safe_cell( $v ) {
		$v = (string) $v;
		return ( $v !== '' && strpos( "=+-@\t\r", $v[0] ) !== false ) ? "'" . $v : $v;
	}

	private static function send( $name, array $header, $rows ) {
		nocache_headers();
		header( 'Content-Type: text/csv; charset=utf-8' );
		header( 'Content-Disposition: attachment; filename="' . $name . '"' );
		header( 'X-Content-Type-Options: nosniff' );
		$out = fopen( 'php://output', 'w' );
		fputcsv( $out, $header, ',', '"', '' );
		foreach ( $rows as $r ) {
			fputcsv( $out, array_map( [ self::class, 'safe_cell' ], $r ), ',', '"', '' );
		}
		fclose( $out );
		exit;
	}

	public static function template() {
		self::guard();
		self::send( 'artaoutreach-template.csv', self::FIELDS, [
			[ 'linkedin', 'example-person-1', 'https://www.linkedin.com/in/example-person-1', 'Example Person 1', 'Example tagline', 'Example bio', 'https://example.com/photo1.jpg', '', '', '250', '4', 'optional note' ],
		] );
	}

	public static function export() {
		self::guard();
		$platform = sanitize_key( $_GET['platform'] ?? '' );
		$status   = sanitize_key( $_GET['status'] ?? '' );
		$rows     = [];
		$before   = 0;
		do { // keyset walk of the filtered view, never OFFSET
			$page = Store::page( $platform, $status, $before, 200 );
			foreach ( $page as $r ) {
				$rows[] = array_map( fn( $k ) => $r[ $k ] ?? '', self::EXPORT );
				$before = (int) $r['id'];
			}
		} while ( count( $page ) === 200 );
		$name = 'artaoutreach-' . ( $platform ?: 'all' ) . '-' . ( $status ?: 'all' ) . '-' . gmdate( 'Ymd-His' ) . '.csv';
		self::send( $name, self::EXPORT, $rows );
	}

	/** Parse an uploaded CSV body into [inserted, updated, errors[]]. Public for tests. */
	public static function import_string( $csv ) {
		$res = [ 'inserted' => 0, 'updated' => 0, 'errors' => [] ];
		$csv = preg_replace( '/^\xEF\xBB\xBF/', '', (string) $csv );
		$fh  = fopen( 'php://temp', 'r+' );
		fwrite( $fh, $csv );
		rewind( $fh );
		$head = fgetcsv( $fh, 0, ',', '"', '' );
		if ( ! $head ) { $res['errors'][] = [ 'row' => 1, 'error' => 'empty file' ]; return $res; }
		$head    = array_map( fn( $h ) => strtolower( trim( (string) $h ) ), $head );
		$unknown = array_diff( $head, self::FIELDS );
		if ( $unknown || ! in_array( 'platform', $head, true ) || ! in_array( 'handle', $head, true ) ) {
			$res['errors'][] = [ 'row' => 1, 'error' => 'header must use only: ' . implode( ',', self::FIELDS ) . ' (platform and handle required)' . ( $unknown ? '; unknown: ' . implode( ',', $unknown ) : '' ) ];
			return $res;
		}
		$line = 1;
		while ( ( $cells = fgetcsv( $fh, 0, ',', '"', '' ) ) !== false ) {
			$line++;
			if ( $cells === [ null ] ) { continue; } // blank line
			if ( $line - 1 > self::MAX_ROWS ) { $res['errors'][] = [ 'row' => $line, 'error' => 'row limit ' . self::MAX_ROWS . ' reached; rest ignored' ]; break; }
			if ( count( $cells ) !== count( $head ) ) { $res['errors'][] = [ 'row' => $line, 'error' => 'expected ' . count( $head ) . ' columns, got ' . count( $cells ) ]; continue; }
			$rec = array_combine( $head, $cells );
			// Undo the export's formula guard so a round-trip does not accumulate quotes.
			$rec = array_map( fn( $v ) => ( strlen( $v ) > 1 && $v[0] === "'" && strpos( "=+-@\t\r", $v[1] ) !== false ) ? substr( $v, 1 ) : $v, $rec );
			$rec['source'] = 'manual';
			$row = Store::clean( $rec );
			if ( is_wp_error( $row ) ) { $res['errors'][] = [ 'row' => $line, 'error' => $row->get_error_message() ]; continue; }
			$what = Store::upsert( $row, null, array_diff( array_keys( array_filter( $rec, fn( $v ) => $v !== '' ) ), [ 'source' ] ) );
			$res[ $what ]++;
			if ( isset( $rec['notes'] ) && trim( $rec['notes'] ) !== '' ) {
				$id = Store::id_for( $row['platform'], $row['handle'] );
				if ( $id ) { Store::set_notes( $id, $rec['notes'] ); }
			}
		}
		fclose( $fh );
		return $res;
	}

	public static function import() {
		self::guard();
		$f   = $_FILES['csv'] ?? null;
		$res = [ 'inserted' => 0, 'updated' => 0, 'errors' => [] ];
		if ( ! $f || ! empty( $f['error'] ) || ! is_uploaded_file( $f['tmp_name'] ) ) {
			$res['errors'][] = [ 'row' => 0, 'error' => 'no file uploaded' ];
		} elseif ( $f['size'] > self::MAX_BYTES ) {
			$res['errors'][] = [ 'row' => 0, 'error' => 'file larger than 2 MB' ];
		} else {
			$res = self::import_string( file_get_contents( $f['tmp_name'] ) );
		}
		set_transient( self::RESULT . get_current_user_id(), $res, 600 );
		wp_safe_redirect( admin_url( 'admin.php?page=' . Admin::SLUG . '&aor_import=1' ) );
		exit;
	}

	/** Render the import/export panel + last import's result. */
	public static function panel( $platform, $status ) {
		$res = isset( $_GET['aor_import'] ) ? get_transient( self::RESULT . get_current_user_id() ) : false;
		if ( $res ) {
			delete_transient( self::RESULT . get_current_user_id() );
			$cls = $res['errors'] ? 'notice-warning' : 'notice-success';
			echo '<div class="notice ' . esc_attr( $cls ) . '"><p>Import: ' . (int) $res['inserted'] . ' inserted, ' . (int) $res['updated'] . ' updated, ' . count( $res['errors'] ) . ' errors.</p>';
			if ( $res['errors'] ) {
				echo '<ul style="margin-left:1em;list-style:disc">';
				foreach ( array_slice( $res['errors'], 0, 50 ) as $e ) { echo '<li>Row ' . (int) $e['row'] . ': ' . esc_html( $e['error'] ) . '</li>'; }
				echo '</ul>';
			}
			echo '</div>';
		}
		$post = esc_url( admin_url( 'admin-post.php' ) );
		$exp  = wp_nonce_url( add_query_arg( [ 'action' => 'aor_csv_export', 'platform' => $platform, 'status' => $status === 'all' ? '' : $status ], admin_url( 'admin-post.php' ) ), self::NONCE );
		$tpl  = wp_nonce_url( add_query_arg( [ 'action' => 'aor_csv_template' ], admin_url( 'admin-post.php' ) ), self::NONCE );
		?>
		<details style="margin:8px 0"><summary><strong>CSV import / export</strong></summary>
			<form method="post" enctype="multipart/form-data" action="<?php echo $post; // already escaped ?>" style="margin:8px 0">
				<input type="hidden" name="action" value="aor_csv_import"><?php wp_nonce_field( self::NONCE ); ?>
				<input type="file" name="csv" accept=".csv,text/csv" required>
				<?php submit_button( 'Import CSV', 'secondary', '', false ); ?>
				<small>Columns: <?php echo esc_html( implode( ', ', self::FIELDS ) ); ?>. Max 2 MB / <?php echo (int) self::MAX_ROWS; ?> rows. Upserts by platform + handle; never changes status.</small>
			</form>
			<a class="button" href="<?php echo esc_url( $exp ); ?>">Export this view</a>
			<a class="button" href="<?php echo esc_url( $tpl ); ?>">Download template</a>
		</details>
		<?php
	}
}
