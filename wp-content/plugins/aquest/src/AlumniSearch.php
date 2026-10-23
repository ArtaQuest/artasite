<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ARTASEARCH — the alumni directory inside Outreach (operator 2026-10-16). ADMIN ONLY.
 *
 * One row per alumnus (name + graduation year) with the public profile links the ArtaSearch scan
 * confirmed as the same person: LinkedIn, Instagram, Facebook, ResearchGate, YouTube, GitHub, X.
 * These are third parties who never joined, so the table is in Extra::PRIVATE_TABLES (never in
 * /data, /schema or the nightly export) and every read route is 'outreach' (cookie + manage_options, or Outreach::EXTRA_SLUGS).
 *
 * The one write path from outside is POST outreach/alumni/ingest, used by the scan box. It is
 * 'public' in Rest::ROUTES only so the handler runs and can audit, exactly like Vault::rest_titan;
 * the handler then enforces a DEDICATED secret AQ_ALUMNI_INGEST_TOKEN (≥32 chars, header
 * X-AQ-Alumni-Token, constant-time compare), HTTPS, a 60/hour/IP rate limit, a 2 MB body and 500
 * rows per request, and answers 404 while the secret is unset. Nothing here discovers or contacts
 * anyone; "send to queue" only copies a profile into aq_artaoutreach as pending for human review.
 */
final class AlumniSearch {

	const TABLE     = 'aq_alumni';
	const TOKEN     = 'AQ_ALUMNI_INGEST_TOKEN';
	const PLATFORMS = [ 'linkedin', 'instagram', 'facebook', 'researchgate', 'youtube', 'github', 'x' ];
	const HOSTS     = [
		'linkedin'     => 'linkedin.com',
		'instagram'    => 'instagram.com',
		'facebook'     => 'facebook.com',
		'researchgate' => 'researchgate.net',
		'youtube'      => 'youtube.com',
		'github'       => 'github.com',
		'x'            => 'x.com',
	];
	const BODY_MAX  = 2097152; // 2 MB
	const ROWS_MAX  = 500;
	const PER_PAGE  = 60;
	const FACET_MAX = 1000;

	private static function t() { global $wpdb; return $wpdb->prefix . self::TABLE; }
	private static function now() { return gmdate( 'Y-m-d H:i:s' ); }

	/** The upsert key: lower-cased, single-spaced full name + '|' + department (namesakes in one class
	 *  are common — 11 pairs in 2019 alone — and differ by department). With grad_year it is unique. */
	public static function name_key( $name, $department = '' ) {
		$n = function ( $v ) { return mb_strtolower( preg_replace( '/\s+/u', ' ', trim( (string) $v ) ) ); };
		return mb_substr( $n( $name ) . '|' . $n( $department ), 0, 191 );
	}

	/** A profile URL is kept only when it is https and on that platform's own host. */
	public static function clean_url( $platform, $url ) {
		$url = esc_url_raw( trim( (string) $url ), [ 'https' ] );
		if ( $url === '' || strlen( $url ) > 500 ) { return ''; }
		$host = strtolower( (string) wp_parse_url( $url, PHP_URL_HOST ) );
		$want = self::HOSTS[ $platform ] ?? '';
		if ( $platform === 'x' && ( $host === 'twitter.com' || substr( $host, -12 ) === '.twitter.com' ) ) { return $url; }
		return ( $host === $want || substr( $host, -( strlen( $want ) + 1 ) ) === '.' . $want ) ? $url : '';
	}

	/** One ingest record → a row, or WP_Error. */
	public static function clean( array $r ) {
		$name = mb_substr( sanitize_text_field( (string) ( $r['full_name'] ?? '' ) ), 0, 255 );
		$year = (int) ( $r['grad_year'] ?? 0 );
		if ( $name === '' ) { return new \WP_Error( 'name', 'full_name is required' ); }
		if ( $year < 1986 || $year > 2100 ) { return new \WP_Error( 'year', 'grad_year must be a year' ); }
		$profiles = [];
		foreach ( (array) ( $r['profiles'] ?? [] ) as $pf => $p ) {
			$pf = sanitize_key( (string) $pf );
			if ( ! in_array( $pf, self::PLATFORMS, true ) || ! is_array( $p ) ) { continue; }
			$url = self::clean_url( $pf, $p['url'] ?? '' );
			if ( $url === '' ) { continue; }
			if ( stripos( (string) ( $p['evidence'] ?? '' ), 'recheck' ) === 0 || ( $p['status'] ?? '' ) === 'recheck' ) { continue; } // 1.25.7: confirmed matches only
			$profiles[ $pf ] = [
				'url'      => $url,
				'title'    => mb_substr( sanitize_text_field( (string) ( $p['title'] ?? '' ) ), 0, 300 ),
				'evidence' => mb_substr( sanitize_text_field( (string) ( $p['evidence'] ?? '' ) ), 0, 120 ),
			];
		}
		$email = sanitize_email( (string) ( $r['public_email'] ?? '' ) );
		$src   = $email !== '' ? esc_url_raw( (string) ( $r['public_email_source'] ?? '' ), [ 'https' ] ) : '';
		$txt   = function ( $k, $n ) use ( $r ) { return mb_substr( sanitize_text_field( (string) ( $r[ $k ] ?? '' ) ), 0, $n ); };
		return [
			'emails'       => wp_json_encode( self::clean_emails( $r['emails'] ?? [] ) ),
			'name_key'     => self::name_key( $name, $txt( 'department', 120 ) ), // key from the stored (sanitised, 120-char) department, exactly what the prune keep-list builds
			'full_name'    => $name,
			'grad_year'    => $year,
			'department'   => $txt( 'department', 120 ),
			'employer'     => $txt( 'employer', 255 ),
			'headline'     => $txt( 'headline', 300 ),
			'city'         => $txt( 'city', 120 ),
			'country'      => $txt( 'country', 120 ),
			'public_email' => $src !== '' ? $email : '', // an email is kept only with the page it was published on
			'email_source' => $src !== '' ? mb_substr( $src, 0, 500 ) : '',
			'profiles'     => wp_json_encode( (object) $profiles ),
			'n_profiles'   => count( $profiles ),
			'platforms'    => $profiles ? ',' . implode( ',', array_keys( $profiles ) ) . ',' : '',
		];
	}

	/**
	 * 1.25.7 (operator 2026-10-23: "emails and as much data found confidently only"). At most 5 entries
	 * {email, source, confidence}: the roster's own address (source 'roster', confidence 'roster') or an
	 * address the scan rated HIGH (it carries the person's name and was published on the matched person's
	 * own page) with that https page as the source. Anything else — medium/low guesses — is dropped here too.
	 */
	public static function clean_emails( $list ) {
		$out = [];
		foreach ( is_array( $list ) ? array_slice( array_values( $list ), 0, 5 ) : [] as $e ) {
			if ( ! is_array( $e ) ) { continue; }
			$email = sanitize_email( (string) ( $e['email'] ?? '' ) );
			$conf  = sanitize_key( (string) ( $e['confidence'] ?? '' ) );
			$src   = (string) ( $e['source'] ?? '' );
			if ( $email === '' || ! is_email( $email ) || isset( $out[ strtolower( $email ) ] ) ) { continue; }
			if ( $conf === 'roster' && $src === 'roster' ) { $src = 'roster'; }
			elseif ( $conf === 'high' ) { $src = esc_url_raw( $src, [ 'https' ] ); if ( $src === '' || strlen( $src ) > 500 ) { continue; } }
			else { continue; }
			$out[ strtolower( $email ) ] = [ 'email' => $email, 'source' => $src, 'confidence' => $conf ];
		}
		return array_values( $out );
	}

	/** Insert or update on (name_key, grad_year). Returns 'inserted' | 'updated'. */
	public static function upsert( array $row ) {
		global $wpdb;
		$id = (int) $wpdb->get_var( $wpdb->prepare( 'SELECT id FROM ' . self::t() . ' WHERE name_key = %s AND grad_year = %d', $row['name_key'], $row['grad_year'] ) );
		$row['updated_at'] = self::now();
		if ( $id ) { $wpdb->update( self::t(), $row, [ 'id' => $id ] ); return 'updated'; }
		$row['created_at'] = $row['updated_at'];
		$wpdb->insert( self::t(), $row );
		return 'inserted';
	}

	private static function out( $r ) {
		$p = json_decode( (string) $r['profiles'], true );
		return [
			'id' => (int) $r['id'], 'full_name' => $r['full_name'], 'grad_year' => (int) $r['grad_year'],
			'department' => $r['department'], 'employer' => $r['employer'], 'headline' => $r['headline'],
			'city' => $r['city'], 'country' => $r['country'], 'public_email' => $r['public_email'],
			'email_source' => $r['email_source'], 'photo' => preg_match( Outreach::PHOTO_RE, (string) $r['photo'] ) ? 'private' : '', 'n_profiles' => (int) $r['n_profiles'],
			'photo_private' => (bool) preg_match( Outreach::PHOTO_RE, (string) $r['photo'] ),
			'photo_meta' => is_array( $pm = json_decode( (string) ( $r['photo_meta'] ?? '' ), true ) ) ? array_intersect_key( $pm, array_flip( [ 'platform', 'profile_url', 'fetched_at' ] ) ) : null,
			'emails' => is_array( $em = json_decode( (string) ( $r['emails'] ?? '' ), true ) ) ? $em : [],
			'profiles' => is_array( $p ) ? $p : [], 'updated_at' => $r['updated_at'],
			'followed_at' => self::follows()[ (int) $r['id'] ] ?? null,
		];
	}

	// 1.25.12 Follow (Arash 2026-10-23): per admin user, in user meta (survives reloads and devices): {alumni id: followed_at UTC}.
	const FOLLOW_META = 'aq_alumni_follows';

	/** The current user's followed rows: [id => 'Y-m-d H:i:s' UTC]. */
	private static function follows() {
		$m = get_user_meta( get_current_user_id(), self::FOLLOW_META, true );
		return is_array( $m ) ? $m : [];
	}

	/** POST outreach/alumni/follow {id, follow: bool} -> {id, followed_at|null}. Unfollow only flips the state. */
	public static function follow( $req ) {
		global $wpdb;
		$id = Rest::pint( $req, 'id' );
		if ( ! $id || ! $wpdb->get_var( $wpdb->prepare( 'SELECT id FROM ' . self::t() . ' WHERE id = %d', $id ) ) ) { return new \WP_Error( 'not_found', 'no such person', 404 ); }
		$m = self::follows();
		if ( rest_sanitize_boolean( Rest::p( $req, 'follow', true ) ) ) { $m[ $id ] = $m[ $id ] ?? gmdate( 'Y-m-d H:i:s' ); }
		else { unset( $m[ $id ] ); }
		update_user_meta( get_current_user_id(), self::FOLLOW_META, $m );
		return [ 'id' => $id, 'followed_at' => $m[ $id ] ?? null ];
	}

	/** WHERE clause + args from ?year=&department=&platform=&platforms=a,b,email&country=&q= */
	private static function where( $req ) {
		global $wpdb;
		$w = [ '1=1' ]; $a = [];
		if ( $y = Rest::pint( $req, 'year' ) ) { $w[] = 'grad_year = %d'; $a[] = $y; }
		if ( ( $d = sanitize_text_field( (string) Rest::p( $req, 'department' ) ) ) !== '' ) { $w[] = 'department = %s'; $a[] = $d; }
		if ( ( $c = sanitize_text_field( (string) Rest::p( $req, 'country' ) ) ) !== '' ) { $w[] = 'country = %s'; $a[] = $c; }
		$pf = sanitize_key( (string) Rest::p( $req, 'platform' ) );
		if ( $pf === 'any' ) { $w[] = 'n_profiles > 0'; }
		elseif ( in_array( $pf, self::PLATFORMS, true ) ) { $w[] = 'platforms LIKE %s'; $a[] = '%,' . $pf . ',%'; }
		// 1.25.13 multi-select (Arash 2026-10-23): ?platforms=linkedin,instagram,email -> rows with ALL of them (AND).
		// Absent/empty = no filter (everyone). (1.25.11 was ANY/OR.)
		$sel = array_values( array_unique( array_filter( array_map( 'sanitize_key', explode( ',', (string) Rest::p( $req, 'platforms' ) ) ) ) ) );
		$sel = array_values( array_intersect( $sel, array_merge( self::PLATFORMS, [ 'email' ] ) ) );
		foreach ( $sel as $k ) {
			if ( $k === 'email' ) { $w[] = self::HAS_EMAIL; }
			else { $w[] = 'platforms LIKE %s'; $a[] = '%,' . $k . ',%'; }
		}
		// ?followed=1 / 0: only people the current admin follows / does not follow (1.25.12)
		$fo = (string) Rest::p( $req, 'followed' );
		if ( $fo === '1' || $fo === '0' ) {
			$ids = array_map( 'intval', array_keys( self::follows() ) );
			if ( $fo === '1' ) { $w[] = $ids ? 'id IN (' . implode( ',', $ids ) . ')' : '1=0'; }
			elseif ( $ids ) { $w[] = 'id NOT IN (' . implode( ',', $ids ) . ')'; }
		}
		if ( ( $q = trim( sanitize_text_field( (string) Rest::p( $req, 'q' ) ) ) ) !== '' ) {
			$like = '%' . $wpdb->esc_like( mb_substr( $q, 0, 100 ) ) . '%';
			$w[] = '(full_name LIKE %s OR employer LIKE %s OR headline LIKE %s)'; array_push( $a, $like, $like, $like );
		}
		return [ implode( ' AND ', $w ), $a ];
	}

	/** A row with at least one confident email (1.87.0 emails JSON, or the older single public_email). */
	const HAS_EMAIL = "((emails IS NOT NULL AND emails NOT IN ('', '[]')) OR public_email <> '')";

	/** The scan's final-roster order (2026-10-23): youngest class first, then department, then name. */
	const ORDER = 'grad_year DESC, department ASC, full_name ASC, id ASC';

	/** GET outreach/alumni — youngest first (self::ORDER); ?cursor= is an opaque offset (0 = first page) + the filtered total. */
	public static function list( $req ) {
		global $wpdb;
		[ $w, $a ] = self::where( $req );
		$total  = (int) $wpdb->get_var( $a ? $wpdb->prepare( 'SELECT COUNT(*) FROM ' . self::t() . " WHERE {$w}", $a ) : 'SELECT COUNT(*) FROM ' . self::t() . " WHERE {$w}" );
		$cursor = max( 0, Rest::pint( $req, 'cursor' ) );
		$sql    = 'SELECT * FROM ' . self::t() . " WHERE {$w} ORDER BY " . self::ORDER . ' LIMIT %d OFFSET %d';
		$rows   = (array) $wpdb->get_results( $wpdb->prepare( $sql, array_merge( $a, [ self::PER_PAGE, $cursor ] ) ), ARRAY_A );
		$next   = count( $rows ) === self::PER_PAGE ? $cursor + self::PER_PAGE : 0;
		return [ 'items' => array_map( [ self::class, 'out' ], $rows ), 'next' => $next, 'total' => $total ];
	}

	/** GET outreach/alumni/facets — the unique values of each filterable column (≤1000 each) + platform counts. */
	public static function facets() {
		global $wpdb;
		$t = self::t(); $out = [];
		foreach ( [ 'grad_year' => 'years', 'department' => 'departments', 'country' => 'countries' ] as $col => $key ) {
			$out[ $key ] = array_map( function ( $r ) use ( $col ) { return [ 'value' => $col === 'grad_year' ? (int) $r['v'] : $r['v'], 'n' => (int) $r['n'] ]; },
				(array) $wpdb->get_results( "SELECT {$col} AS v, COUNT(*) AS n FROM {$t} WHERE {$col} <> '' AND {$col} IS NOT NULL GROUP BY {$col} ORDER BY {$col}" . ( $col === 'grad_year' ? ' DESC' : '' ) . " LIMIT " . self::FACET_MAX, ARRAY_A ) );
		}
		$out['platforms'] = [];
		foreach ( self::PLATFORMS as $pf ) {
			$out['platforms'][ $pf ] = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$t} WHERE platforms LIKE %s", '%,' . $pf . ',%' ) );
		}
		$out['with_email'] = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$t} WHERE " . self::HAS_EMAIL );
		$out['total']     = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$t}" );
		$out['with_any']  = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$t} WHERE n_profiles > 0" );
		$out['synced_at'] = (string) $wpdb->get_var( "SELECT MAX(updated_at) FROM {$t}" );
		return $out;
	}

	/** GET outreach/alumni/export — the filtered set as CSV, formula-guarded. */
	public static function export( $req ) {
		global $wpdb;
		[ $w, $a ] = self::where( $req );
		$sql  = 'SELECT * FROM ' . self::t() . " WHERE {$w} ORDER BY " . self::ORDER . ' LIMIT 100000';
		$rows = (array) $wpdb->get_results( $a ? $wpdb->prepare( $sql, $a ) : $sql, ARRAY_A );
		$cols = array_merge( [ 'full_name', 'grad_year', 'department', 'employer', 'headline', 'city', 'country', 'public_email', 'email_source', 'emails' ], array_map( function ( $p ) { return $p . '_url'; }, self::PLATFORMS ) );
		$cell = function ( $v ) {
			$v = (string) $v;
			if ( $v !== '' && strpbrk( $v[0], "=+-@\t\r" ) !== false ) { $v = "'" . $v; }
			return '"' . str_replace( '"', '""', $v ) . '"';
		};
		$lines = [ implode( ',', $cols ) ];
		foreach ( $rows as $r ) {
			$p = json_decode( (string) $r['profiles'], true ) ?: [];
			$vals = [];
			$em = json_decode( (string) ( $r['emails'] ?? '' ), true ) ?: [];
			$r['emails'] = implode( '; ', array_map( function ( $e ) { return ( $e['email'] ?? '' ) . ' (' . ( $e['source'] ?? '' ) . ')'; }, is_array( $em ) ? $em : [] ) );
			foreach ( $cols as $c ) { $vals[] = $cell( substr( $c, -4 ) === '_url' ? ( $p[ substr( $c, 0, -4 ) ]['url'] ?? '' ) : ( $r[ $c ] ?? '' ) ); }
			$lines[] = implode( ',', $vals );
		}
		return [ 'filename' => 'artasearch-' . gmdate( 'Ymd' ) . '.csv', 'rows' => count( $rows ), 'csv' => "\xEF\xBB\xBF" . implode( "\r\n", $lines ) . "\r\n" ];
	}

	/**
	 * POST outreach/alumni/to-queue {id, platforms[]} — copy chosen profiles into the Outreach review
	 * queue as pending (Outreach::upsert never changes an existing row's status). Only platforms the
	 * queue knows are copied; ResearchGate and YouTube are not request-based and are skipped.
	 */
	public static function to_queue( $req ) {
		global $wpdb;
		$id  = Rest::pint( $req, 'id' );
		$row = $id ? $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM ' . self::t() . ' WHERE id = %d', $id ), ARRAY_A ) : null;
		if ( ! $row ) { return new \WP_Error( 'not_found', 'no such alumnus', 404 ); }
		$want = array_map( 'sanitize_key', (array) Rest::p( $req, 'platforms', [] ) );
		$p    = json_decode( (string) $row['profiles'], true ) ?: [];
		$out  = [ 'inserted' => 0, 'updated' => 0, 'skipped' => [] ];
		foreach ( $p as $pf => $info ) {
			if ( $want && ! in_array( $pf, $want, true ) ) { continue; }
			$handle = self::handle_from( $pf, (string) ( $info['url'] ?? '' ) );
			if ( ! in_array( $pf, Outreach::PLATFORMS, true ) || $handle === '' ) { $out['skipped'][] = $pf; continue; }
			$clean = Outreach::clean( [
				'platform' => $pf, 'handle' => $handle, 'profile_url' => $info['url'], 'full_name' => $row['full_name'],
				'tagline' => trim( $row['department'] . ' · Bilkent ' . $row['grad_year'] ), 'photo' => '',
				'source' => 'artasearch',
			] );
			if ( is_wp_error( $clean ) ) { $out['skipped'][] = $pf; continue; }
			$out[ Outreach::upsert( $clean, null, [] ) ]++;
		}
		return $out;
	}

	// ── Photos (1.25.9, operator 2026-10-23) ─────────────────────────────────────────────────────
	// The scan box downloads the picture of a HIGH-confidence matched account (Instagram > LinkedIn >
	// Facebook > GitHub) at collection time and sends it base64 with {sha1, platform, profile_url,
	// fetched_at}. It is stored like an Outreach zip photo (Outreach::store_photo: content-checked,
	// re-encoded, metadata-free JPEG in the secret uploads dir; the row keeps only an "aqo:" token) and
	// served to admins only by outreach/alumni/photo/<id>. CDN URLs are never stored or hotlinked.
	const PHOTO_PLATFORMS = [ 'instagram', 'linkedin', 'facebook', 'github' ];
	const PHOTO_B64_MAX   = 1048576; // 1 MB of base64 per photo

	/** Apply one ingest record's photo to row $id. 'kept' | 'stored' | 'cleared' | 'need' | WP_Error. */
	private static function photo_apply( $id, array $r, array $profiles ) {
		global $wpdb;
		$cur  = $wpdb->get_row( $wpdb->prepare( 'SELECT photo, photo_meta FROM ' . self::t() . ' WHERE id = %d', $id ), ARRAY_A ) ?: [ 'photo' => '', 'photo_meta' => '' ];
		$meta = json_decode( (string) $cur['photo_meta'], true ) ?: [];
		$p    = $r['photo'] ?? null;
		$drop = function () use ( $cur ) { if ( preg_match( Outreach::PHOTO_RE, (string) $cur['photo'] ) ) { $f = Outreach::photo_path( $cur['photo'] ); if ( $f && is_file( $f ) ) { @unlink( $f ); } } };
		if ( ! is_array( $p ) ) { // no photo in the record: the scan box has none (or the account was removed) -> clear
			if ( $cur['photo'] === '' && ! $meta ) { return 'kept'; }
			$drop(); $wpdb->update( self::t(), [ 'photo' => '', 'photo_meta' => null ], [ 'id' => $id ] ); return 'cleared';
		}
		$pf  = sanitize_key( (string) ( $p['platform'] ?? '' ) );
		$sha = strtolower( (string) ( $p['sha1'] ?? '' ) );
		$url = in_array( $pf, self::PHOTO_PLATFORMS, true ) ? self::clean_url( $pf, $p['profile_url'] ?? '' ) : '';
		if ( $url === '' || ! preg_match( '/^[0-9a-f]{40}$/', $sha ) ) { return new \WP_Error( 'photo', 'photo needs platform, profile_url and sha1' ); }
		$norm = function ( $u ) { return rtrim( strtolower( rawurldecode( (string) $u ) ), '/' ); };
		if ( ! isset( $profiles[ $pf ] ) || $norm( $profiles[ $pf ]['url'] ) !== $norm( $url ) ) { return new \WP_Error( 'photo', 'photo must come from the row\'s matched ' . $pf . ' account' ); }
		$have = preg_match( Outreach::PHOTO_RE, (string) $cur['photo'] ) && is_file( Outreach::photo_path( $cur['photo'] ) );
		if ( $have && ( $meta['sha1'] ?? '' ) === $sha && $norm( $meta['profile_url'] ?? '' ) === $norm( $url ) ) { return 'kept'; }
		$b64 = (string) ( $p['b64'] ?? '' );
		if ( $b64 === '' ) { return 'need'; }
		if ( strlen( $b64 ) > self::PHOTO_B64_MAX ) { return new \WP_Error( 'photo', 'photo over 1 MB' ); }
		$bytes = base64_decode( $b64, true );
		if ( $bytes === false || sha1( $bytes ) !== $sha ) { return new \WP_Error( 'photo', 'photo bytes do not match sha1' ); }
		$tok = Outreach::store_photo( $bytes );
		if ( is_wp_error( $tok ) ) { return $tok; }
		$drop();
		$fa = preg_match( '/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/', (string) ( $p['fetched_at'] ?? '' ) ) ? (string) $p['fetched_at'] : gmdate( 'Y-m-d' );
		$wpdb->update( self::t(), [ 'photo' => $tok, 'photo_meta' => wp_json_encode( [ 'sha1' => $sha, 'platform' => $pf, 'profile_url' => $url, 'fetched_at' => $fa ] ) ], [ 'id' => $id ] );
		return 'stored';
	}

	/** GET outreach/alumni/photo/<id> — the stored picture, admins only (route 'outreach'); <img> passes ?_wpnonce=. */
	public static function photo( $req ) {
		global $wpdb;
		$tok = (string) $wpdb->get_var( $wpdb->prepare( 'SELECT photo FROM ' . self::t() . ' WHERE id = %d', (int) $req['id'] ) );
		$f   = Outreach::photo_path( $tok );
		if ( ! $f || ! is_file( $f ) ) { return new \WP_Error( 'not_found', 'no photo', 404 ); }
		nocache_headers();
		header( 'Content-Type: image/jpeg' );
		header( 'Content-Length: ' . filesize( $f ) );
		header( 'Cache-Control: private, no-store, max-age=0' );
		header( 'X-Content-Type-Options: nosniff' );
		header( 'X-Robots-Tag: noindex, nofollow, noarchive' );
		header( "Content-Security-Policy: default-src 'none'" );
		readfile( $f );
		exit;
	}

	/** Delete rows by id, with their stored photos. */
	private static function delete_ids( array $ids ) {
		global $wpdb;
		$n = 0;
		foreach ( array_chunk( array_values( array_unique( array_filter( array_map( 'intval', $ids ) ) ) ), 200 ) as $ch ) {
			$in = implode( ',', $ch );
			foreach ( (array) $wpdb->get_col( 'SELECT photo FROM ' . self::t() . " WHERE id IN ({$in})" ) as $tok ) {
				$f = Outreach::photo_path( $tok ); if ( $f && is_file( $f ) ) { @unlink( $f ); }
			}
			$n += (int) $wpdb->query( 'DELETE FROM ' . self::t() . " WHERE id IN ({$in})" );
		}
		return $n;
	}

	/** The account handle from a profile URL's first meaningful path segment ('' when unknown). */
	public static function handle_from( $platform, $url ) {
		$path  = trim( (string) wp_parse_url( $url, PHP_URL_PATH ), '/' );
		$parts = $path === '' ? [] : explode( '/', $path );
		if ( $platform === 'linkedin' ) { return ( $parts[0] ?? '' ) === 'in' ? rawurldecode( $parts[1] ?? '' ) : ''; }
		if ( $platform === 'facebook' && ( $parts[0] ?? '' ) === 'profile.php' ) {
			parse_str( (string) wp_parse_url( $url, PHP_URL_QUERY ), $q );
			return isset( $q['id'] ) ? preg_replace( '/\D/', '', (string) $q['id'] ) : '';
		}
		$h = rawurldecode( $parts[0] ?? '' );
		return preg_match( '/^[A-Za-z0-9._-]{1,100}$/', $h ) ? $h : '';
	}

	/** POST outreach/alumni/ingest — the scan box. See the class comment for every guard. */
	public static function ingest( $req ) {
		$ip    = isset( $_SERVER['REMOTE_ADDR'] ) ? (string) $_SERVER['REMOTE_ADDR'] : '0';
		$audit = function ( $result ) use ( $ip ) {
			if ( class_exists( '\\AQ\\Watchdog' ) ) { Watchdog::note( "alumni/ingest {$result} ip={$ip}" ); }
		};
		$reply = function ( $body, $status ) {
			$res = new \WP_REST_Response( $body, $status );
			$res->header( 'Cache-Control', 'no-store' );
			return $res;
		};
		$want = (string) Secrets::get( self::TOKEN );
		if ( strlen( $want ) < 32 ) { return $reply( [ 'error' => 'not_found' ], 404 ); } // closed until configured
		$https = is_ssl() || ( isset( $_SERVER['HTTP_X_FORWARDED_PROTO'] ) && strtolower( (string) $_SERVER['HTTP_X_FORWARDED_PROTO'] ) === 'https' );
		if ( ! $https && ! ( defined( 'WP_DEBUG' ) && WP_DEBUG ) ) { $audit( 'fail:insecure' ); return $reply( [ 'error' => 'https_required' ], 403 ); }
		if ( Rest::throttle( 'alumni_ingest', 60, HOUR_IN_SECONDS ) ) { $audit( 'fail:rate' ); return $reply( [ 'error' => 'rate_limited' ], 429 ); }
		$got = (string) $req->get_header( 'x_aq_alumni_token' );
		if ( $got === '' ) { $audit( 'fail:no-token' ); return $reply( [ 'error' => 'unauthorized' ], 401 ); }
		if ( ! hash_equals( $want, $got ) ) { $audit( 'fail:bad-token' ); return $reply( [ 'error' => 'forbidden' ], 403 ); }
		if ( strlen( (string) $req->get_body() ) > self::BODY_MAX ) { return $reply( [ 'error' => 'too_large', 'message' => 'body over 2 MB' ], 413 ); }
		$body = (array) $req->get_json_params();
		$list = isset( $body['alumni'] ) && is_array( $body['alumni'] ) ? array_values( $body['alumni'] ) : null;
		if ( $list === null && ( isset( $body['prune'] ) || isset( $body['verify'] ) || isset( $body['dump'] ) || isset( $body['delete'] ) ) ) { $list = []; }
		if ( $list === null ) { return $reply( [ 'error' => 'alumni', 'message' => '{alumni:[…]} required' ], 400 ); }
		if ( count( $list ) > self::ROWS_MAX ) { return $reply( [ 'error' => 'too_many', 'message' => 'max 500 rows per request' ], 413 ); }
		// One shot (1.25.2): rows written under the 1.25.0 name-only key carry no '|' — drop them so the
		// name|department key does not leave stale duplicates. The scan box re-sends the full set.
		$out = [ 'inserted' => 0, 'updated' => 0, 'errors' => [] ];
		if ( get_option( 'aq_alumni_key_v2' ) !== '1' ) {
			global $wpdb;
			$out['purged_v1'] = (int) $wpdb->query( 'DELETE FROM ' . self::t() . " WHERE name_key NOT LIKE '%|%'" );
			update_option( 'aq_alumni_key_v2', '1', false );
		}
		foreach ( $list as $i => $r ) {
			$row = is_array( $r ) ? self::clean( $r ) : new \WP_Error( 'item', 'not an object' );
			if ( is_wp_error( $row ) ) { $out['errors'][] = [ 'row' => $i, 'error' => $row->get_error_message() ]; continue; }
			$out[ self::upsert( $row ) ]++;
			global $wpdb;
			$rid = (int) $wpdb->get_var( $wpdb->prepare( 'SELECT id FROM ' . self::t() . ' WHERE name_key = %s AND grad_year = %d', $row['name_key'], $row['grad_year'] ) );
			$ph  = $rid ? self::photo_apply( $rid, $r, json_decode( $row['profiles'], true ) ?: [] ) : 'kept';
			if ( is_wp_error( $ph ) ) { $out['errors'][] = [ 'row' => $i, 'error' => $ph->get_error_message() ]; }
			else { $out[ 'photo_' . $ph ] = ( $out[ 'photo_' . $ph ] ?? 0 ) + 1; if ( $ph === 'need' ) { $out['need_photo'][] = $i; } }
		}
		// Read-back (1.25.8): {verify:[{full_name,department,grad_year},…]} (max 500) answers what the site now stores for those
		// keys — platforms + profile URLs and email count only — so the scan box can confirm a sync landed. Same token as ingest.
		if ( isset( $body['verify'] ) && is_array( $body['verify'] ) ) {
			global $wpdb;
			$out['verify'] = [];
			foreach ( array_slice( $body['verify'], 0, self::ROWS_MAX ) as $k ) {
				if ( ! is_array( $k ) || ( $k['full_name'] ?? '' ) === '' ) { continue; }
				$nk  = self::name_key( mb_substr( sanitize_text_field( (string) $k['full_name'] ), 0, 255 ), mb_substr( sanitize_text_field( (string) ( $k['department'] ?? '' ) ), 0, 120 ) );
				$got = $wpdb->get_row( $wpdb->prepare( 'SELECT profiles, emails, photo, photo_meta, updated_at FROM ' . self::t() . ' WHERE name_key = %s AND grad_year = %d', $nk, (int) ( $k['grad_year'] ?? 0 ) ), ARRAY_A );
				$pm  = $got ? ( json_decode( (string) $got['photo_meta'], true ) ?: null ) : null;
				$pf  = $got ? ( json_decode( (string) $got['profiles'], true ) ?: [] ) : [];
				$em  = $got ? ( json_decode( (string) ( $got['emails'] ?? '' ), true ) ?: [] ) : [];
				$out['verify'][] = [
					'key'        => $nk,
					'found'      => (bool) $got,
					'profiles'   => array_map( function ( $p ) { return (string) ( $p['url'] ?? '' ); }, is_array( $pf ) ? $pf : [] ),
					'n_emails'   => is_array( $em ) ? count( $em ) : 0,
					'photo'      => $pm && is_file( Outreach::photo_path( (string) $got['photo'] ) ) ? [ 'sha1' => $pm['sha1'] ?? '', 'platform' => $pm['platform'] ?? '' ] : null,
					'updated_at' => $got ? $got['updated_at'] : null,
				];
			}
		}
		// Backup read (1.25.9): {dump:{offset,limit<=500}} -> every column except the photo token, plus row counts per year.
		if ( isset( $body['dump'] ) && is_array( $body['dump'] ) ) {
			global $wpdb;
			$off = max( 0, (int) ( $body['dump']['offset'] ?? 0 ) ); $lim = min( self::ROWS_MAX, max( 1, (int) ( $body['dump']['limit'] ?? self::ROWS_MAX ) ) );
			$rows = (array) $wpdb->get_results( $wpdb->prepare( 'SELECT * FROM ' . self::t() . ' ORDER BY id ASC LIMIT %d OFFSET %d', $lim, $off ), ARRAY_A );
			foreach ( $rows as &$dr ) { $dr['photo'] = preg_match( Outreach::PHOTO_RE, (string) $dr['photo'] ) ? 'private' : (string) $dr['photo']; }
			unset( $dr );
			$out['dump']  = $rows;
			$out['total'] = (int) $wpdb->get_var( 'SELECT COUNT(*) FROM ' . self::t() );
			$out['years'] = array_map( function ( $y ) { return [ 'year' => (int) $y['grad_year'], 'n' => (int) $y['n'] ]; }, (array) $wpdb->get_results( 'SELECT grad_year, COUNT(*) AS n FROM ' . self::t() . ' GROUP BY grad_year ORDER BY grad_year DESC', ARRAY_A ) );
		}
		// Explicit removal (1.25.9, operator 2026-10-23 "I don't want to see the old data"): {delete:{ids:[…<=500], confirm:'delete-rows'}}.
		if ( isset( $body['delete'] ) && is_array( $body['delete'] ) ) {
			$ids = isset( $body['delete']['ids'] ) && is_array( $body['delete']['ids'] ) ? $body['delete']['ids'] : [];
			if ( ( $body['delete']['confirm'] ?? '' ) !== 'delete-rows' || count( $ids ) < 1 || count( $ids ) > self::ROWS_MAX ) {
				$out['errors'][] = [ 'row' => 'delete', 'error' => 'delete needs confirm:"delete-rows" and 1-500 ids' ];
			} else { $out['deleted'] = self::delete_ids( $ids ); }
		}
		// Full replace per year (1.25.3): {prune:{year:Y, keep:[{full_name,department},…]}} deletes that year's
		// rows whose key is not in keep. Sent once, after every batch of the year has been upserted.
		if ( isset( $body['prune'] ) && is_array( $body['prune'] ) ) {
			$py   = (int) ( $body['prune']['year'] ?? 0 );
			$keep = isset( $body['prune']['keep'] ) && is_array( $body['prune']['keep'] ) ? $body['prune']['keep'] : [];
			if ( $py < 1986 || $py > 2100 || count( $keep ) < 1 || count( $keep ) > 5000 ) {
				$out['errors'][] = [ 'row' => 'prune', 'error' => 'prune needs a year and 1-5000 keep entries' ];
			} else {
				global $wpdb;
				$keys = [];
				foreach ( $keep as $k ) {
					if ( is_array( $k ) && ( $k['full_name'] ?? '' ) !== '' ) {
						$keys[ self::name_key( mb_substr( sanitize_text_field( (string) $k['full_name'] ), 0, 255 ), mb_substr( sanitize_text_field( (string) ( $k['department'] ?? '' ) ), 0, 120 ) ) ] = 1; // same normalisation as clean()
					}
				}
				$have = $wpdb->get_results( $wpdb->prepare( 'SELECT id, name_key FROM ' . self::t() . ' WHERE grad_year = %d', $py ), ARRAY_A );
				$drop = [];
				foreach ( (array) $have as $h ) { if ( ! isset( $keys[ $h['name_key'] ] ) ) { $drop[] = (int) $h['id']; } }
				if ( $keys && count( $drop ) <= max( 10, (int) ( 0.1 * count( (array) $have ) ) ) ) { // guard: a bad keep list may remove at most 10% of a year (min 10)
					self::delete_ids( $drop ); // 1.25.9: drops stored photos too
					$out['pruned'] = count( $drop );
				} else {
					$out['errors'][] = [ 'row' => 'prune', 'error' => 'refused: would delete ' . count( $drop ) . ' of ' . count( (array) $have ) ];
				}
			}
		}
		$audit( "ok:{$out['inserted']}+{$out['updated']}" . ( isset( $out['pruned'] ) ? "-{$out['pruned']}" : '' ) );
		return $reply( $out, 200 );
	}
}
