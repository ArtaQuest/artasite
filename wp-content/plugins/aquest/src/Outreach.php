<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * OUTREACH — Arash's review queue for accounts LinkedIn / Facebook / Instagram / X / GitHub / Strava suggested to
 * him, plus the ArtaTask dashboard (acceptance rates, time-to-accept, the send plan + daily caps).
 *
 * ADMIN ONLY, server-side: every route in Rest::ROUTES is 'admin' (a cookie session with
 * manage_options; an API token is refused even for an operator). The table describes third parties
 * who never joined ArtaQuest, so it is in Extra::PRIVATE_TABLES — never in /data, /schema, /offline.
 *
 * Nothing here discovers or contacts anyone. Rows arrive by ingest or CSV; a human includes or
 * excludes each one; the phone app later sends only to `included` rows and reports back.
 */
final class Outreach {

	const TABLE     = 'aq_artaoutreach';
	const PLATFORMS = [ 'linkedin', 'facebook', 'instagram', 'x', 'github', 'strava' ];
	const STATUSES  = [ 'pending', 'included', 'excluded' ];
	const PER_PAGE  = 50;
	const CSV_MAX   = 2097152; // 2 MB
	const CSV_ROWS  = 5000;
	const CSV_IN    = [ 'platform', 'handle', 'profile_url', 'full_name', 'tagline', 'bio', 'photo', 'followers', 'following', 'connections', 'mutuals', 'notes' ];
	const CSV_OUT   = [ 'id', 'platform', 'handle', 'profile_url', 'full_name', 'tagline', 'bio', 'photo', 'followers', 'following', 'connections', 'mutuals', 'source', 'status', 'discovered_at', 'decided_at', 'request_sent_at', 'accepted_at', 'notes' ];
	const CAPS_OPT  = 'aq_outreach_caps';
	const CAPS_DEF  = [ 'linkedin' => 3, 'facebook' => 0, 'instagram' => 0, 'x' => 0, 'github' => 0, 'strava' => 0 ];
	/** Profile address built from a handle when the record carries none. GitHub and Strava are
	 *  follow-based: "accepted" there means the person followed back. A Strava handle is the athlete
	 *  id (or vanity name) from strava.com/athletes/<handle>. */
	const URL_FMT   = [
		'linkedin'  => 'https://www.linkedin.com/in/%s/',
		'facebook'  => 'https://www.facebook.com/%s',
		'instagram' => 'https://www.instagram.com/%s/',
		'x'         => 'https://x.com/%s',
		'github'    => 'https://github.com/%s',
		'strava'    => 'https://www.strava.com/athletes/%s',
	];

	/** Accounts that may use Outreach (and its ArtaSearch tab) WITHOUT manage_options — the founder's
	 *  own account (operator 2026-10-16: "reach the ArtaSearch tab signed in as artafather"). Matched on
	 *  the user's slug (user_nicename, unique). Grants Outreach only — no other admin surface. */
	const EXTRA_SLUGS = [ 'artafather' ];

	public static function allowed( $uid ) {
		$uid = (int) $uid;
		if ( $uid <= 0 ) { return false; }
		if ( user_can( $uid, 'manage_options' ) ) { return true; }
		$u = get_userdata( $uid );
		return $u && in_array( (string) $u->user_nicename, self::EXTRA_SLUGS, true );
	}

	public static function profile_url( $platform, $handle ) {
		return isset( self::URL_FMT[ $platform ] ) && $handle !== '' ? sprintf( self::URL_FMT[ $platform ], rawurlencode( $handle ) ) : '';
	}

	private static function t() { global $wpdb; return $wpdb->prefix . self::TABLE; }
	private static function now() { return gmdate( 'Y-m-d H:i:s' ); }

	private static function ts( $v ) {
		if ( ! $v ) { return null; }
		$t = strtotime( (string) $v );
		return $t ? gmdate( 'Y-m-d H:i:s', $t ) : null;
	}

	private static function count_or_null( $v ) {
		if ( $v === null || $v === '' ) { return null; }
		return is_numeric( $v ) && $v >= 0 ? (int) $v : null;
	}

	/** Shape one row for the client: ints as ints, plus time_to_accept_s. */
	private static function out( $r ) {
		if ( ! $r ) { return null; }
		foreach ( [ 'id', 'followers', 'following', 'connections', 'mutuals' ] as $k ) {
			$r[ $k ] = $r[ $k ] === null ? null : (int) $r[ $k ];
		}
		$r['time_to_accept_s'] = self::tta( $r );
		$r['photo_private']    = (bool) preg_match( self::PHOTO_RE, (string) ( $r['photo'] ?? '' ) );
		return $r;
	}

	public static function tta( $r ) {
		if ( empty( $r['request_sent_at'] ) || empty( $r['accepted_at'] ) ) { return null; }
		return strtotime( $r['accepted_at'] . ' UTC' ) - strtotime( $r['request_sent_at'] . ' UTC' );
	}

	/** Normalize one record → row array, or WP_Error. */
	public static function clean( array $r ) {
		$platform = strtolower( trim( (string) ( $r['platform'] ?? '' ) ) );
		if ( $platform === 'twitter' ) { $platform = 'x'; }
		if ( $platform === 'gh' ) { $platform = 'github'; }
		if ( ! in_array( $platform, self::PLATFORMS, true ) ) {
			return new \WP_Error( 'platform', 'platform must be one of ' . implode( ', ', self::PLATFORMS ) );
		}
		$handle = ltrim( trim( (string) ( $r['handle'] ?? '' ) ), '@' );
		if ( $handle === '' || strlen( $handle ) > 191 ) { return new \WP_Error( 'handle', 'handle is required (max 191 chars)' ); }
		return [
			'platform'    => $platform,
			'handle'      => $handle,
			'profile_url' => esc_url_raw( (string) ( $r['profile_url'] ?? '' ) ) ?: self::profile_url( $platform, $handle ),
			'full_name'   => mb_substr( sanitize_text_field( (string) ( $r['full_name'] ?? '' ) ), 0, 255 ),
			'tagline'     => mb_substr( sanitize_text_field( (string) ( $r['tagline'] ?? '' ) ), 0, 500 ),
			'bio'         => sanitize_textarea_field( (string) ( $r['bio'] ?? '' ) ),
			'photo'       => self::clean_photo( (string) ( $r['photo'] ?? '' ) ),
			'followers'   => self::count_or_null( $r['followers'] ?? null ),
			'following'   => self::count_or_null( $r['following'] ?? null ),
			'connections' => self::count_or_null( $r['connections'] ?? null ),
			'mutuals'     => self::count_or_null( $r['mutuals'] ?? null ),
			'source'      => sanitize_key( (string) ( $r['source'] ?? 'suggested' ) ) ?: 'suggested',
		];
	}

	// ── Private photos (zip import) ─────────────────────────────────────────────────────────────
	// A photo imported from a zip is re-encoded to JPEG (EXIF and every other metadata block dropped)
	// and stored as uploads/aq-outreach-<dir secret>/<128-bit random>.jpg. The row keeps only the
	// token "aqo:<name>.jpg" — never a URL — and the SPA shows it through the admin-only route
	// outreach/photo/<id>. The directory secret lives in an option whose name ends in `_secret`, so
	// the public DB explorer masks it (Extra::REDACT_NAME_RE). Nothing here is in a sitemap or /data.

	const PHOTO_OPT      = 'aq_outreach_photo_secret';
	const PHOTO_RE       = '/^aqo:[0-9a-f]{32}\.jpg$/';
	const ZIP_MAX        = 52428800;  // 50 MB upload
	const ZIP_UNPACK_MAX = 209715200; // 200 MB total uncompressed (zip-bomb guard)
	const IMG_MAX        = 10485760;  // 10 MB per image, uncompressed
	const IMG_PIXELS     = 40000000;  // 40 MP decode guard
	const IMG_EDGE       = 512;       // stored longest edge

	/** A photo cell: a private token we issued, an http(s) URL, or nothing. */
	public static function clean_photo( $v ) {
		$v = trim( $v );
		if ( $v === '' ) { return ''; }
		if ( preg_match( self::PHOTO_RE, $v ) ) { return $v; }
		if ( ! preg_match( '#^https?://#i', $v ) ) { return ''; } // a bare name means nothing outside a zip
		$u = esc_url_raw( $v, [ 'http', 'https' ] );
		return $u ? mb_substr( $u, 0, 500 ) : '';
	}

	private static function photo_dir() {
		$sec = (string) get_option( self::PHOTO_OPT, '' );
		if ( ! preg_match( '/^[0-9a-f]{32}$/', $sec ) ) {
			$sec = bin2hex( random_bytes( 16 ) );
			update_option( self::PHOTO_OPT, $sec, false );
		}
		$dir = trailingslashit( wp_upload_dir( null, false )['basedir'] ) . 'aq-outreach-' . $sec;
		if ( ! is_dir( $dir ) ) {
			wp_mkdir_p( $dir );
			@file_put_contents( $dir . '/index.php', "<?php // Silence.\n" );
			@file_put_contents( $dir . '/.htaccess', "Require all denied\nDeny from all\n" ); // Apache only; names are the real guard
		}
		return $dir;
	}

	public static function photo_path( $token ) {
		return preg_match( self::PHOTO_RE, (string) $token ) ? self::photo_dir() . '/' . substr( $token, 4 ) : '';
	}

	/** Verify an image by CONTENT (magic + decoder), re-encode to a metadata-free JPEG, store it.
	 *  Returns the "aqo:" token or WP_Error. */
	public static function store_photo( $bytes ) {
		if ( strlen( $bytes ) === 0 || strlen( $bytes ) > self::IMG_MAX ) { return new \WP_Error( 'photo_size', 'image empty or larger than 10 MB' ); }
		// REST/ingest requests (ArtaSearch photos, 1.25.10) do not load wp-admin's file helpers; wp_tempnam lives there.
		if ( ! function_exists( 'wp_tempnam' ) ) { require_once ABSPATH . 'wp-admin/includes/file.php'; }
		$mime = class_exists( '\finfo' ) ? ( new \finfo( FILEINFO_MIME_TYPE ) )->buffer( $bytes ) : ( ( $gi = @getimagesizefromstring( $bytes ) ) ? $gi['mime'] : '' );
		if ( ! in_array( $mime, [ 'image/jpeg', 'image/png', 'image/webp' ], true ) ) { return new \WP_Error( 'photo_type', 'only JPEG, PNG or WebP images (found ' . $mime . ')' ); }
		$info = @getimagesizefromstring( $bytes );
		if ( ! $info || ! in_array( $info[2], [ IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_WEBP ], true ) || $info[0] < 1 || $info[1] < 1 ) {
			return new \WP_Error( 'photo_decode', 'not a readable image' );
		}
		if ( $info[0] * $info[1] > self::IMG_PIXELS ) { return new \WP_Error( 'photo_pixels', 'image dimensions too large' ); }
		$tmp = wp_tempnam( 'aqo' );
		file_put_contents( $tmp, $bytes );
		$out = null;
		try {
			if ( function_exists( 'imagecreatefromstring' ) ) {
				// GD re-encode: decoding to raw pixels and writing a new JPEG carries no EXIF/XMP/ICC.
				$im = @imagecreatefromstring( $bytes );
				if ( ! $im ) { return new \WP_Error( 'photo_decode', 'not a readable image' ); }
				$w = imagesx( $im ); $h = imagesy( $im );
				$k = min( 1, self::IMG_EDGE / max( $w, $h ) );
				$nw = max( 1, (int) round( $w * $k ) ); $nh = max( 1, (int) round( $h * $k ) );
				$dst = imagecreatetruecolor( $nw, $nh );
				imagefill( $dst, 0, 0, imagecolorallocate( $dst, 255, 255, 255 ) ); // flatten PNG/WebP alpha
				imagecopyresampled( $dst, $im, 0, 0, 0, 0, $nw, $nh, $w, $h );
				$name = bin2hex( random_bytes( 16 ) ) . '.jpg';
				$out  = self::photo_dir() . '/' . $name;
				$ok   = imagejpeg( $dst, $out, 85 );
				imagedestroy( $im ); imagedestroy( $dst );
				if ( ! $ok ) { return new \WP_Error( 'photo_write', 'could not store the image' ); }
			} else {
				$ed = wp_get_image_editor( $tmp );
				if ( is_wp_error( $ed ) ) { return new \WP_Error( 'photo_decode', 'not a readable image' ); }
				$ed->resize( self::IMG_EDGE, self::IMG_EDGE, false );
				$ed->set_quality( 85 );
				$name  = bin2hex( random_bytes( 16 ) ) . '.jpg';
				$out   = self::photo_dir() . '/' . $name;
				$saved = $ed->save( $out, 'image/jpeg' ); // WP strips metadata on save (image_strip_meta)
				if ( is_wp_error( $saved ) ) { return new \WP_Error( 'photo_write', 'could not store the image' ); }
			}
			@chmod( $out, 0644 );
			return 'aqo:' . $name;
		} finally {
			@unlink( $tmp );
		}
	}

	private static function drop_photo( $token ) {
		$p = self::photo_path( $token );
		if ( $p && is_file( $p ) ) { @unlink( $p ); }
	}

	/** GET outreach/photo/<id> — the row's private photo, to admins only (the route is 'admin').
	 *  An <img> cannot send X-WP-Nonce, so the SPA passes ?_wpnonce= (core's cookie-auth check). */
	public static function photo( $req ) {
		$r = self::row( (int) $req['id'] );
		$p = $r ? self::photo_path( $r['photo'] ) : '';
		if ( ! $p || ! is_file( $p ) ) { return new \WP_Error( 'not_found', 'no photo', 404 ); }
		nocache_headers();
		header( 'Content-Type: image/jpeg' );
		header( 'Content-Length: ' . filesize( $p ) );
		header( 'Cache-Control: private, no-store, max-age=0' );
		header( 'X-Content-Type-Options: nosniff' );
		header( 'X-Robots-Tag: noindex, nofollow, noarchive' );
		header( "Content-Security-Policy: default-src 'none'" );
		readfile( $p );
		exit;
	}

	/** POST outreach/import-zip (multipart `file`) — a .zip with ONE .csv and the images its `photo`
	 *  column names (by file name, any folder). ≤50 MB, ≤200 MB unpacked, ≤10 MB per image. */
	public static function import_zip( $req ) {
		if ( ! class_exists( '\ZipArchive' ) ) { return new \WP_Error( 'zip_unavailable', 'zip support is not installed on this server', 500 ); }
		$f = $req->get_file_params()['file'] ?? null;
		if ( ! $f || ! empty( $f['error'] ) || empty( $f['tmp_name'] ) || ! is_file( $f['tmp_name'] ) ) {
			return new \WP_Error( 'file', 'upload a .zip file', 400 );
		}
		if ( (int) $f['size'] > self::ZIP_MAX ) { return new \WP_Error( 'too_large', 'zip larger than 50 MB', 413 ); }
		$zip = new \ZipArchive();
		if ( true !== $zip->open( $f['tmp_name'], \ZipArchive::RDONLY ) ) { return new \WP_Error( 'zip', 'not a valid zip', 400 ); }
		$csv_i = null; $imgs = []; $total = 0;
		for ( $i = 0; $i < $zip->numFiles; $i++ ) {
			$st = $zip->statIndex( $i );
			$n  = (string) $st['name'];
			if ( substr( $n, -1 ) === '/' || strpos( $n, '__MACOSX/' ) === 0 || basename( $n )[0] === '.' ) { continue; }
			$total += (int) $st['size'];
			if ( $total > self::ZIP_UNPACK_MAX ) { $zip->close(); return new \WP_Error( 'too_large', 'zip unpacks to more than 200 MB', 413 ); }
			$ext = strtolower( pathinfo( $n, PATHINFO_EXTENSION ) );
			if ( $ext === 'csv' ) {
				if ( $csv_i !== null ) { $zip->close(); return new \WP_Error( 'zip_csv', 'the zip must contain exactly one .csv', 400 ); }
				$csv_i = $i;
			} else {
				$imgs[ strtolower( basename( $n ) ) ] = [ $i, (int) $st['size'] ];
			}
		}
		if ( $csv_i === null ) { $zip->close(); return new \WP_Error( 'zip_csv', 'the zip must contain exactly one .csv', 400 ); }
		if ( $zip->statIndex( $csv_i )['size'] > self::CSV_MAX ) { $zip->close(); return new \WP_Error( 'too_large', 'CSV larger than 2 MB', 413 ); }
		$csv    = (string) $zip->getFromIndex( $csv_i );
		$photos = 0;
		$cb = function ( $cell ) use ( $zip, $imgs, &$photos ) {
			$key = strtolower( basename( str_replace( '\\', '/', $cell ) ) );
			if ( ! isset( $imgs[ $key ] ) ) { return new \WP_Error( 'photo_missing', 'photo "' . $key . '" is not in the zip' ); }
			[ $i, $size ] = $imgs[ $key ];
			if ( $size > self::IMG_MAX ) { return new \WP_Error( 'photo_size', 'photo "' . $key . '" is larger than 10 MB' ); }
			$t = self::store_photo( (string) $zip->getFromIndex( $i ) );
			if ( ! is_wp_error( $t ) ) { $photos++; }
			return $t;
		};
		$res = self::import_string( $csv, $cb );
		$zip->close();
		$res['photos'] = $photos;
		return $res;
	}

	public static function id_for( $platform, $handle ) {
		global $wpdb;
		return (int) $wpdb->get_var( $wpdb->prepare( 'SELECT id FROM ' . self::t() . ' WHERE platform = %s AND handle = %s', $platform, $handle ) );
	}

	private static function row( $id ) {
		global $wpdb;
		return $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM ' . self::t() . ' WHERE id = %d', $id ), ARRAY_A );
	}

	/**
	 * Upsert by (platform, handle). Only the fields the caller SENT are refreshed on an existing row
	 * ($present), so a partial record never blanks the rest; status, decisions, sent/accepted and
	 * source are never touched by ingest, so re-discovery cannot undo a decision.
	 */
	public static function upsert( array $row, $discovered_at = null, $present = null ) {
		global $wpdb;
		$id = self::id_for( $row['platform'], $row['handle'] );
		if ( $id ) {
			$upd = $row;
			unset( $upd['platform'], $upd['handle'], $upd['source'] );
			if ( is_array( $present ) ) { $upd = array_intersect_key( $upd, array_flip( $present ) ); }
			$upd['updated_at'] = self::now();
			$wpdb->update( self::t(), $upd, [ 'id' => $id ] );
			return 'updated';
		}
		$row['status']        = 'pending';
		$row['discovered_at'] = $discovered_at ?: self::now();
		$row['updated_at']    = self::now();
		$wpdb->insert( self::t(), $row );
		return 'inserted';
	}

	private static function set_notes( $id, $notes ) {
		global $wpdb;
		$wpdb->update( self::t(), [ 'notes' => sanitize_textarea_field( (string) $notes ), 'updated_at' => self::now() ], [ 'id' => (int) $id ] );
	}

	/** Keyset page, newest first. */
	private static function page( $platform, $status, $before, $limit ) {
		global $wpdb;
		$where = [ '1=1' ];
		$args  = [];
		if ( in_array( $platform, self::PLATFORMS, true ) ) { $where[] = 'platform = %s'; $args[] = $platform; }
		if ( in_array( $status, self::STATUSES, true ) ) { $where[] = 'status = %s'; $args[] = $status; }
		if ( $before > 0 ) { $where[] = 'id < %d'; $args[] = (int) $before; }
		$args[] = max( 1, min( 200, (int) $limit ) );
		$sql    = 'SELECT * FROM ' . self::t() . ' WHERE ' . implode( ' AND ', $where ) . ' ORDER BY id DESC LIMIT %d';
		return (array) $wpdb->get_results( $wpdb->prepare( $sql, $args ), ARRAY_A );
	}

	// ── Routes (all 'admin' in Rest::ROUTES) ───────────────────────────────────────────────────

	/** GET outreach/accounts ?platform=&status=&cursor= */
	public static function list( $req ) {
		global $wpdb;
		$rows   = self::page( sanitize_key( Rest::p( $req, 'platform' ) ), sanitize_key( Rest::p( $req, 'status' ) ), Rest::pint( $req, 'cursor' ), self::PER_PAGE );
		$counts = array_fill_keys( self::STATUSES, 0 );
		foreach ( (array) $wpdb->get_results( 'SELECT status, COUNT(*) AS n FROM ' . self::t() . ' GROUP BY status', ARRAY_A ) as $c ) { $counts[ $c['status'] ] = (int) $c['n']; }
		$next = count( $rows ) === self::PER_PAGE ? (int) end( $rows )['id'] : 0;
		return [ 'items' => array_map( [ self::class, 'out' ], $rows ), 'next' => $next, 'counts' => $counts ];
	}

	/** POST outreach/accounts — one record, or {accounts:[…]} (≤500). The Mac discovery ingest. */
	public static function ingest( $req ) {
		$body = (array) $req->get_json_params();
		$list = isset( $body['accounts'] ) && is_array( $body['accounts'] ) ? $body['accounts'] : [ $body ];
		if ( count( $list ) > 500 ) { return new \WP_Error( 'too_many', 'max 500 accounts per request', 413 ); }
		$out = [ 'inserted' => 0, 'updated' => 0, 'errors' => [] ];
		foreach ( array_values( $list ) as $i => $r ) {
			$row = is_array( $r ) ? self::clean( $r ) : new \WP_Error( 'item', 'not an object' );
			if ( is_wp_error( $row ) ) { $out['errors'][] = [ 'row' => $i, 'error' => $row->get_error_message() ]; continue; }
			$out[ self::upsert( $row, self::ts( $r['discovered_at'] ?? null ), array_keys( $r ) ) ]++;
		}
		return $out;
	}

	/** POST outreach/decide {ids:[], status} — include / exclude / back to pending. A sent row is final. */
	public static function decide( $req ) {
		global $wpdb;
		$status = sanitize_key( Rest::p( $req, 'status' ) );
		if ( ! in_array( $status, self::STATUSES, true ) ) { return new \WP_Error( 'status', 'status must be pending, included or excluded', 400 ); }
		$ids = array_values( array_filter( array_map( 'intval', (array) Rest::p( $req, 'ids', [] ) ) ) );
		if ( ! $ids || count( $ids ) > 500 ) { return new \WP_Error( 'ids', '1–500 ids required', 400 ); }
		$ph  = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
		$now = self::now();
		$n   = $wpdb->query( $wpdb->prepare( 'UPDATE ' . self::t() . " SET status = %s, decided_at = %s, updated_at = %s WHERE request_sent_at IS NULL AND id IN ({$ph})", array_merge( [ $status, $now, $now ], $ids ) ) );
		return [ 'ok' => true, 'updated' => (int) $n ];
	}

	/** POST outreach/accounts/{id}/notes {notes} */
	public static function notes( $req ) {
		$id = Rest::pint( $req, 'id' );
		if ( ! self::row( $id ) ) { return new \WP_Error( 'not_found', 'no such account', 404 ); }
		$notes = Rest::p( $req, 'notes', null );
		if ( ! is_string( $notes ) ) { return new \WP_Error( 'notes', 'notes (string) required', 400 ); }
		self::set_notes( $id, $notes );
		return self::out( self::row( $id ) );
	}

	/** GET outreach/queue ?platform=&limit= — included, not yet sent, oldest decision first (the phone). */
	public static function queue( $req ) {
		global $wpdb;
		$pf   = sanitize_key( Rest::p( $req, 'platform' ) );
		$args = [];
		$and  = '';
		if ( in_array( $pf, self::PLATFORMS, true ) ) { $and = ' AND platform = %s'; $args[] = $pf; }
		$args[] = max( 1, min( 100, Rest::pint( $req, 'limit', 20 ) ) );
		$rows   = $wpdb->get_results( $wpdb->prepare( 'SELECT id, platform, handle, profile_url, full_name, tagline, mutuals, decided_at FROM ' . self::t() . " WHERE status = 'included' AND request_sent_at IS NULL{$and} ORDER BY decided_at ASC, id ASC LIMIT %d", $args ), ARRAY_A );
		return [ 'items' => (array) $rows ];
	}

	private static function mark( $req, $what ) {
		global $wpdb;
		$id = Rest::pint( $req, 'id' );
		if ( ! self::row( $id ) ) { return new \WP_Error( 'not_found', 'no such account', 404 ); }
		$at  = self::ts( Rest::p( $req, 'at' ) ) ?: self::now();
		$sql = $what === 'sent'
			? 'UPDATE ' . self::t() . " SET request_sent_at = %s, updated_at = %s WHERE id = %d AND status = 'included' AND request_sent_at IS NULL"
			: 'UPDATE ' . self::t() . ' SET accepted_at = %s, updated_at = %s WHERE id = %d AND request_sent_at IS NOT NULL AND accepted_at IS NULL';
		$wpdb->query( $wpdb->prepare( $sql, $at, self::now(), $id ) );
		return self::out( self::row( $id ) );
	}
	/** POST outreach/accounts/{id}/sent {at?} — only for included rows; idempotent. */
	public static function sent( $req ) { return self::mark( $req, 'sent' ); }
	/** POST outreach/accounts/{id}/accepted {at?} — needs a prior send; idempotent. */
	public static function accepted( $req ) { return self::mark( $req, 'accepted' ); }

	/** GET outreach/stats — per platform: counts, acceptance rate, time-to-accept (median/mean). */
	public static function stats( $req ) {
		global $wpdb;
		$out = [];
		foreach ( self::PLATFORMS as $p ) {
			$c = $wpdb->get_row( $wpdb->prepare( "SELECT COUNT(*) AS total,
				SUM(status='pending') AS pending, SUM(status='included') AS included, SUM(status='excluded') AS excluded,
				SUM(request_sent_at IS NOT NULL) AS sent, SUM(accepted_at IS NOT NULL) AS accepted
				FROM " . self::t() . ' WHERE platform = %s', $p ), ARRAY_A );
			$pairs = (array) $wpdb->get_results( $wpdb->prepare( 'SELECT request_sent_at, accepted_at FROM ' . self::t() . ' WHERE platform = %s AND accepted_at IS NOT NULL ORDER BY id DESC LIMIT 5000', $p ), ARRAY_A );
			$d     = array_values( array_filter( array_map( [ self::class, 'tta' ], $pairs ), fn( $v ) => $v !== null ) );
			sort( $d );
			$k      = count( $d );
			$median = $k ? ( $k % 2 ? $d[ intdiv( $k, 2 ) ] : intdiv( $d[ $k / 2 - 1 ] + $d[ $k / 2 ], 2 ) ) : null;
			$c      = array_map( 'intval', (array) $c );
			$out[]  = $c + [
				'platform'          => $p,
				'acceptance_rate'   => $c['sent'] ? round( $c['accepted'] / $c['sent'], 4 ) : null,
				'tta_median_s'      => $median,
				'tta_mean_s'        => $k ? (int) round( array_sum( $d ) / $k ) : null,
			];
		}
		return [ 'platforms' => $out ];
	}

	private static function caps() {
		$c = json_decode( (string) get_option( self::CAPS_OPT, '' ), true );
		return array_merge( self::CAPS_DEF, is_array( $c ) ? array_intersect_key( $c, self::CAPS_DEF ) : [] );
	}

	/** GET outreach/plan — daily caps, sent today (UTC), remaining, and the next queue per platform. */
	public static function plan( $req ) {
		global $wpdb;
		$caps  = self::caps();
		$today = gmdate( 'Y-m-d 00:00:00' );
		$out   = [];
		foreach ( self::PLATFORMS as $p ) {
			$sent  = (int) $wpdb->get_var( $wpdb->prepare( 'SELECT COUNT(*) FROM ' . self::t() . ' WHERE platform = %s AND request_sent_at >= %s', $p, $today ) );
			$queue = (int) $wpdb->get_var( $wpdb->prepare( 'SELECT COUNT(*) FROM ' . self::t() . " WHERE platform = %s AND status = 'included' AND request_sent_at IS NULL", $p ) );
			$cap   = (int) $caps[ $p ];
			$out[] = [ 'platform' => $p, 'daily_cap' => $cap, 'sent_today' => $sent, 'remaining_today' => max( 0, $cap - $sent ), 'queued' => $queue, 'days_to_clear' => $cap > 0 ? (int) ceil( $queue / $cap ) : null ];
		}
		return [ 'platforms' => $out, 'day_starts' => $today . ' UTC' ];
	}

	/** POST outreach/caps {linkedin?, facebook?, instagram?, x?, github?, strava?} — 0…100 per day. */
	public static function set_caps( $req ) {
		$caps = self::caps();
		foreach ( self::PLATFORMS as $p ) {
			$v = Rest::p( $req, $p, null );
			if ( $v !== null && is_numeric( $v ) ) { $caps[ $p ] = max( 0, min( 100, (int) $v ) ); }
		}
		update_option( self::CAPS_OPT, wp_json_encode( $caps ), false );
		return [ 'ok' => true, 'caps' => $caps ];
	}

	// ── CSV ────────────────────────────────────────────────────────────────────────────────────

	/** Spreadsheet formula injection: a cell starting = + - @ (or tab/CR) gets a leading '. */
	public static function safe_cell( $v ) {
		$v = (string) $v;
		return ( $v !== '' && strpos( "=+-@\t\r", $v[0] ) !== false ) ? "'" . $v : $v;
	}

	private static function csv( array $header, array $rows ) {
		$fh = fopen( 'php://temp', 'r+' );
		fputcsv( $fh, $header, ',', '"', '' );
		foreach ( $rows as $r ) { fputcsv( $fh, array_map( [ self::class, 'safe_cell' ], $r ), ',', '"', '' ); }
		rewind( $fh );
		$s = stream_get_contents( $fh );
		fclose( $fh );
		return $s;
	}

	/** GET outreach/export ?platform=&status= — the filtered view as CSV text (UTC dates). */
	public static function export( $req ) {
		$pf = sanitize_key( Rest::p( $req, 'platform' ) );
		$st = sanitize_key( Rest::p( $req, 'status' ) );
		$rows = [];
		$before = 0;
		do {
			$page = self::page( $pf, $st, $before, 200 );
			foreach ( $page as $r ) { $rows[] = array_map( fn( $k ) => $r[ $k ] ?? '', self::CSV_OUT ); $before = (int) $r['id']; }
		} while ( count( $page ) === 200 && count( $rows ) < 100000 );
		return [ 'filename' => 'outreach-' . ( $pf ?: 'all' ) . '-' . ( $st ?: 'all' ) . '-' . gmdate( 'Ymd-His' ) . '.csv', 'rows' => count( $rows ), 'csv' => self::csv( self::CSV_OUT, $rows ) ];
	}

	/** GET outreach/template */
	public static function template( $req ) {
		return [ 'filename' => 'outreach-template.csv', 'csv' => self::csv( self::CSV_IN, [
			[ 'linkedin', 'example-person-1', 'https://www.linkedin.com/in/example-person-1', 'Example Person 1', 'Example tagline', 'Example bio', 'https://example.com/photo1.jpg', '', '', '250', '4', 'optional note' ],
			[ 'github', 'example-dev-2', '', 'Example Dev 2', 'Example tagline', 'Example bio', '', '120', '80', '', '3', 'profile_url is built from the handle when empty' ],
			[ 'strava', '12345678', '', 'Example Runner 3', '', '', '', '45', '60', '', '2', 'handle = athlete id' ],
		] ) ];
	}

	/** Parse CSV text → {inserted, updated, errors[{row, error}]}. New rows get source=manual. */
	public static function import_string( $csv, $photo_cb = null ) {
		$res = [ 'inserted' => 0, 'updated' => 0, 'errors' => [] ];
		$fh  = fopen( 'php://temp', 'r+' );
		fwrite( $fh, preg_replace( '/^\xEF\xBB\xBF/', '', (string) $csv ) );
		rewind( $fh );
		$head = fgetcsv( $fh, 0, ',', '"', '' );
		if ( ! $head || $head === [ null ] ) { $res['errors'][] = [ 'row' => 1, 'error' => 'empty file' ]; return $res; }
		$head    = array_map( fn( $h ) => strtolower( trim( (string) $h ) ), $head );
		$unknown = array_diff( $head, self::CSV_IN );
		if ( $unknown || ! in_array( 'platform', $head, true ) || ! in_array( 'handle', $head, true ) ) {
			$res['errors'][] = [ 'row' => 1, 'error' => 'header must use only: ' . implode( ',', self::CSV_IN ) . ' (platform and handle required)' . ( $unknown ? '; unknown: ' . implode( ',', $unknown ) : '' ) ];
			return $res;
		}
		$line = 1;
		while ( ( $cells = fgetcsv( $fh, 0, ',', '"', '' ) ) !== false ) {
			$line++;
			if ( $cells === [ null ] ) { continue; }
			if ( $line - 1 > self::CSV_ROWS ) { $res['errors'][] = [ 'row' => $line, 'error' => 'row limit ' . self::CSV_ROWS . ' reached; rest ignored' ]; break; }
			if ( count( $cells ) !== count( $head ) ) { $res['errors'][] = [ 'row' => $line, 'error' => 'expected ' . count( $head ) . ' columns, got ' . count( $cells ) ]; continue; }
			$rec = array_combine( $head, $cells );
			$rec = array_map( fn( $v ) => ( strlen( $v ) > 1 && $v[0] === "'" && strpos( "=+-@\t\r", $v[1] ) !== false ) ? substr( $v, 1 ) : $v, $rec );
			$rec['source'] = 'manual';
			// Zip import: a photo cell that is a file name (not a URL or a token we issued) is looked up
			// in the zip, verified and stored privately. A bad photo is reported; the row still imports
			// and keeps whatever photo it had.
			$photo_err = null;
			if ( $photo_cb && isset( $rec['photo'] ) && $rec['photo'] !== '' && ! preg_match( '#^https?://#i', $rec['photo'] ) && ! preg_match( self::PHOTO_RE, $rec['photo'] ) ) {
				$tok = $photo_cb( $rec['photo'] );
				if ( is_wp_error( $tok ) ) { $photo_err = $tok->get_error_message(); $rec['photo'] = ''; } else { $rec['photo'] = $tok; }
			}
			$row = self::clean( $rec );
			if ( is_wp_error( $row ) ) { $res['errors'][] = [ 'row' => $line, 'error' => $row->get_error_message() ]; continue; }
			$old = self::id_for( $row['platform'], $row['handle'] );
			$old_photo = $old ? (string) self::row( $old )['photo'] : '';
			$res[ self::upsert( $row, null, array_keys( array_filter( $rec, fn( $v ) => $v !== '' ) ) ) ]++;
			if ( $old_photo !== '' && $row['photo'] !== '' && $old_photo !== $row['photo'] ) { self::drop_photo( $old_photo ); } // replaced
			if ( $photo_err !== null ) { $res['errors'][] = [ 'row' => $line, 'error' => $photo_err . ' (row imported without a new photo)' ]; }
			if ( isset( $rec['notes'] ) && trim( $rec['notes'] ) !== '' ) { self::set_notes( self::id_for( $row['platform'], $row['handle'] ), $rec['notes'] ); }
		}
		fclose( $fh );
		return $res;
	}

	/** POST outreach/import {csv} — CSV text (the SPA reads the file), ≤2 MB. */
	public static function import( $req ) {
		$csv = Rest::p( $req, 'csv', '' );
		if ( ! is_string( $csv ) || $csv === '' ) { return new \WP_Error( 'csv', 'csv text required', 400 ); }
		if ( strlen( $csv ) > self::CSV_MAX ) { return new \WP_Error( 'too_large', 'CSV larger than 2 MB', 413 ); }
		return self::import_string( $csv );
	}
}
