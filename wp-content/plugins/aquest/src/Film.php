<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaFilm — an AI video studio. A member briefs a short film — a concept in their own words, to make a
 * video for their music, book, course, or anything — and the studio generates it with a STATE-OF-THE-ART
 * open text-to-video model on a FREE HuggingFace Space (LTX-Video, via the film relay). The relay expands
 * the brief into scene prompts, renders each scene as a clip CHUNK-BY-CHUNK (cron-driven, resumable — one
 * clip per run, which also conserves the free GPU quota), stitches them into one video + a poster, and it
 * lands in 'review' for the author to watch and publish. Published films play at /film/<id>, list in the
 * films hub + on the author's profile, earn points, and are SEO-indexed (VideoObject).
 *
 * One table (self-install — the Music/Motion pattern, isolated from Schema::VERSION):
 *   • aq_films — one row per FILM PROJECT (brief → generated video + its lifecycle).
 */
final class Film {

	const TABLE_VERSION = '1';
	const COIN_PER_5S   = 2;   // ArtaCoins per 5s of REQUESTED length, on publish (min ₳2 — video gen is heavy)
	const MAX_SECONDS   = 120;
	const DEFAULT_SECS  = 20;
	const SECS_PER_SCENE = 4;  // ~one LTX clip per scene

	public static function cost_for_seconds( $secs ) { return max( 1, (int) ceil( max( 1, (int) $secs ) / 5 ) ) * self::COIN_PER_5S; }

	public static function ensure_tables() {
		if ( get_option( 'aq_film_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		$t = $wpdb->prefix . 'aq_films';
		dbDelta( "CREATE TABLE {$t} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			slug VARCHAR(191) NOT NULL DEFAULT '',
			title VARCHAR(255) NOT NULL DEFAULT '',
			seconds INT UNSIGNED NOT NULL DEFAULT 0,
			brief LONGTEXT NULL,
			summary TEXT NULL,
			scenes LONGTEXT NULL,
			video_url VARCHAR(600) NOT NULL DEFAULT '',
			poster VARCHAR(600) NOT NULL DEFAULT '',
			rights_ok TINYINT(1) NOT NULL DEFAULT 0,
			status VARCHAR(20) NOT NULL DEFAULT 'draft',
			film_state VARCHAR(12) NOT NULL DEFAULT '',
			claimed_at INT UNSIGNED NOT NULL DEFAULT 0,
			play_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			updated INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY slug (slug),
			KEY author (author_id),
			KEY pub_feed (status, id),
			KEY film_queue (film_state, id)
		) {$charset};" );
		update_option( 'aq_film_table_version', self::TABLE_VERSION, true );
	}

	// ── member-facing ──────────────────────────────────────────────────────────

	/** POST films — start a film from a brief. ?generate=1 to begin now. */
	public static function create( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_film', 20, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid   = Rest::uid();
		$title = mb_substr( sanitize_text_field( (string) Rest::p( $req, 'title', '' ) ), 0, 255 );
		if ( $title === '' ) { return Rest::err( 'no_title', 'Give the film a title' ); }
		$brief = mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'brief', '' ) ), 0, 8000 );
		if ( $brief === '' ) { return Rest::err( 'no_brief', 'Describe the video you want — your brief is what the studio films' ); }
		$secs = max( self::SECS_PER_SCENE, min( self::MAX_SECONDS, (int) Rest::pint( $req, 'seconds', self::DEFAULT_SECS ) ) );
		if ( in_array( (string) Rest::p( $req, 'rights_ok', '' ), [ '', '0', 'false' ], true ) ) {
			return Rest::err( 'no_rights', 'Please confirm this will be your own original work' );
		}
		$now = Data::now();
		$id  = Data::insert( 'aq_films', [
			'author_id' => $uid, 'slug' => self::unique_slug( $title ), 'title' => $title,
			'seconds' => $secs, 'brief' => $brief,
			'summary' => mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'summary', '' ) ), 0, 2000 ),
			'rights_ok' => 1, 'status' => 'draft', 'film_state' => '', 'created' => $now, 'updated' => $now,
		] );
		if ( ! $id ) { return Rest::err( 'failed', 'Could not start the film', 500 ); }
		if ( ! in_array( (string) Rest::p( $req, 'generate', '' ), [ '', '0', 'false' ], true ) ) {
			Data::update( 'aq_films', [ 'film_state' => 'queued', 'updated' => Data::now() ], [ 'id' => $id ] );
		}
		return self::detail( self::row( $id ) );
	}

	/** POST films/{id}/generate — (re)queue rendering (owner only). */
	public static function generate( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Film not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your film', 403 ); }
		if ( trim( (string) $row['brief'] ) === '' ) { return Rest::err( 'no_brief', 'Add a brief before generating' ); }
		if ( in_array( $row['film_state'], [ 'queued', 'processing' ], true ) ) { return [ 'ok' => true, 'queued' => true ]; }
		$fields = [ 'film_state' => 'queued', 'claimed_at' => 0, 'scenes' => null, 'updated' => Data::now() ];
		if ( Rest::p( $req, 'seconds', null ) !== null ) {
			$fields['seconds'] = max( self::SECS_PER_SCENE, min( self::MAX_SECONDS, (int) Rest::pint( $req, 'seconds', self::DEFAULT_SECS ) ) );
		}
		Data::update( 'aq_films', $fields, [ 'id' => (int) $row['id'] ] );
		return [ 'ok' => true, 'queued' => true ];
	}

	/** POST films/{id}/publish — pay coins by length (once), publish (owner only). */
	public static function publish_film( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Film not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your film', 403 ); }
		if ( (string) $row['video_url'] === '' ) { return Rest::err( 'no_video', 'The film is not rendered yet — please wait', 409 ); }
		$id = (int) $row['id']; $uid = (int) $row['author_id'];
		// THE REVIEW GATE (unified publishing process): a film cannot leave 'draft' until its latest
		// public adversarial-review round PASSES (AQ\Reviews); live-film metadata edits are never blocked.
		if ( $row['status'] === 'draft' && ! Reviews::passing( 'film', $id ) ) {
			return Rest::err( 'unreviewed', 'This film has not passed adversarial review yet — every ArtaQuest publication carries its public review record.', 409 );
		}
		$cost = self::cost_for_seconds( (int) $row['seconds'] ); $ref = 'film:' . $id;
		if ( $row['status'] === 'draft' ) {
			if ( $err = Challenges::quota_gate( $uid ) ) { return $err; } // shelf quota: prune before publishing more
			// Friendly pre-check only — it keeps the exact figure in the refusal copy. The
			// AUTHORITATIVE check is inside Economy::spend below, which holds this member's
			// wallet lock across the check and the debit together.
			$bal = Economy::coin_balance( $uid );
			if ( $bal < $cost ) { return Rest::err( 'insufficient', 'Publishing a ' . self::mmss( (int) $row['seconds'] ) . ' film costs ₳' . $cost . ' — you have ₳' . $bal . '.', 402 ); }
			// Charge BEFORE claiming the row. Claim-then-charge publishes the work even when the
			// charge is refused, which mints the goods for free.
			$paid = Economy::spend( $uid, $cost, 'publish', $ref );
			if ( $paid !== '' ) { return Economy::spend_error( $paid, $cost, 'Publishing this film' ); }
			$claimed = (bool) Data::update( 'aq_films', [ 'status' => 'published', 'film_state' => 'live', 'updated' => Data::now() ], [ 'id' => $id, 'status' => 'draft' ] );
			if ( ! $claimed ) {
				// Another request published it first — give the money straight back, append-only.
				Economy::refund_spend( $uid, $cost, 'publish-void', $ref );
			}
			if ( $claimed ) {
				Economy::content_points( $uid, $cost, $ref );
				Challenges::enter( 'film', $id, $uid, $cost ); // fee → the season's Film Challenge pool
			}
		}
		Data::update( 'aq_films', [ 'summary' => mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'summary', (string) $row['summary'] ) ), 0, 2000 ), 'status' => 'published', 'film_state' => 'live', 'updated' => Data::now() ], [ 'id' => $id ] );
		return self::detail( self::row( $id ) );
	}

	/** GET films — public keyset list of published films. */
	public static function list( $req ) {
		self::ensure_tables();
		$cursor = Rest::pint( $req, 'cursor', 0 );
		$q      = (string) Rest::p( $req, 'q', '' );
		[ $rows, $next ] = Data::search_page( 'aq_films', [ 'title', 'summary' ], $q, "status = 'published'", [], $cursor, 24 );
		$names = self::author_names( $rows );
		return [ 'items' => array_map( static fn( $r ) => self::card( $r, $names ), $rows ), 'next' => $next ];
	}

	/** GET films/mine — the member's own film projects. */
	public static function mine( $req ) {
		self::ensure_tables();
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_films' ) . ' WHERE author_id = %d ORDER BY id DESC LIMIT 100', [ Rest::uid() ] );
		return [ 'items' => array_map( [ self::class, 'card' ], $rows ) ];
	}

	/** GET films/{id} — reader/player payload. */
	public static function get( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Film not found', 404 ); }
		if ( $row['status'] === 'published' ) { Data::bump( 'aq_films', [ 'id' => (int) $row['id'] ], 'play_count', 1 ); }
		return self::detail( $row );
	}

	/** POST films/{id}/delete — owner or operator. */
	public static function remove( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Film not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your film', 403 ); }
		self::unlink_file( (string) $row['video_url'] ); self::unlink_file( (string) $row['poster'] );
		global $wpdb; $wpdb->delete( Data::t( 'aq_films' ), [ 'id' => (int) $row['id'] ] );
		return [ 'ok' => true ];
	}

	// ── relay (worker) ──────────────────────────────────────────────────────────

	/** POST relay/film/poll — claim the oldest queued (or stale) film; returns brief + target scene count. */
	public static function film_poll( $req ) {
		self::ensure_tables();
		set_transient( 'aq_film_beat', time(), 300 ); // liveness for the unified studio pulse (the Music pattern)
		global $wpdb;
		$now = time(); $t = Data::t( 'aq_films' ); $stale = 1800;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$t} WHERE film_state = 'queued' OR ( film_state = 'processing' AND claimed_at < %d ) ORDER BY id ASC LIMIT 1", $now - $stale ), ARRAY_A );
		if ( ! $row ) { return [ 'job' => null ]; }
		$claimed = (int) $wpdb->query( $wpdb->prepare( "UPDATE {$t} SET film_state = 'processing', claimed_at = %d WHERE id = %d AND ( film_state = 'queued' OR ( film_state = 'processing' AND claimed_at < %d ) )", $now, (int) $row['id'], $now - $stale ) );
		if ( ! $claimed ) { return [ 'job' => null ]; }
		return [ 'job' => [
			'id' => (int) $row['id'], 'title' => (string) $row['title'], 'brief' => (string) $row['brief'],
			'seconds' => (int) $row['seconds'], 'scenes' => max( 1, (int) ceil( (int) $row['seconds'] / self::SECS_PER_SCENE ) ),
		] ];
	}

	/** POST relay/film/heartbeat {id} — keep a long chunk-by-chunk render claimed. */
	public static function film_heartbeat( $req ) {
		self::ensure_tables();
		global $wpdb;
		$wpdb->query( $wpdb->prepare( "UPDATE " . Data::t( 'aq_films' ) . " SET claimed_at = %d WHERE id = %d AND film_state = 'processing'", time(), Rest::pint( $req, 'id' ) ) );
		return [ 'ok' => true ];
	}

	/** POST relay/film/complete {id, video_b64, poster_b64, summary} — save the rendered video. */
	public static function film_complete( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Film not found', 404 ); }
		if ( $row['film_state'] !== 'processing' ) { return [ 'ok' => true, 'ignored' => true ]; }
		$url = self::save_video( (int) $row['id'], (string) Rest::p( $req, 'video_b64', '' ) );
		if ( $url === '' ) {
			Data::update( 'aq_films', [ 'film_state' => 'failed', 'updated' => Data::now() ], [ 'id' => (int) $row['id'], 'film_state' => 'processing' ] );
			return Rest::err( 'empty_film', 'No usable video received', 400 );
		}
		$poster = self::save_image( (int) $row['id'], (string) Rest::p( $req, 'poster_b64', '' ) );
		$wrote = (bool) Data::update( 'aq_films', [
			'video_url' => $url, 'poster' => $poster !== '' ? $poster : (string) $row['poster'],
			'summary' => mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'summary', (string) $row['summary'] ) ), 0, 2000 ),
			'film_state' => 'review', 'updated' => Data::now(),
		], [ 'id' => (int) $row['id'], 'film_state' => 'processing' ] );
		if ( ! $wrote ) { return [ 'ok' => true, 'ignored' => true ]; }
		Notify::push( (int) $row['author_id'], 'film', 'Your film is ready to review',
			'Your draft of “' . (string) $row['title'] . '” is ready — watch and publish.',
			'/film/' . (int) $row['id'] . '/', 'film-ready:' . (int) $row['id'] );
		return [ 'ok' => true ];
	}

	// ── shaping ─────────────────────────────────────────────────────────────────

	private static function card( $row, $names = null ) {
		$aid  = (int) $row['author_id'];
		$name = is_array( $names ) ? (string) ( $names[ $aid ]['name'] ?? '' ) : '';
		if ( $name === '' ) { $u = get_userdata( $aid ); $name = $u ? $u->display_name : ''; }
		$slug = ''; $u = get_userdata( $aid ); if ( $u ) { $slug = $u->user_nicename; }
		return [
			'id' => (int) $row['id'], 'slug' => (string) $row['slug'], 'title' => (string) $row['title'],
			'summary' => (string) ( $row['summary'] ?? '' ), 'poster' => (string) $row['poster'],
			'seconds' => (int) $row['seconds'], 'length' => self::mmss( (int) $row['seconds'] ),
			'plays' => (int) $row['play_count'], 'created' => (int) $row['created'],
			'status' => (string) $row['status'], 'film_state' => (string) $row['film_state'],
			'author' => [ 'id' => $aid, 'name' => $name, 'slug' => $slug ],
		];
	}

	private static function detail( $row ) {
		$mine = self::can_edit( $row );
		$out  = self::card( $row ) + [
			'video_url' => ( $row['status'] === 'published' || $mine ) ? (string) $row['video_url'] : '',
			'reviews'   => Reviews::rounds( 'film', (int) $row['id'] ), // the public adversarial-review record
			'is_owner'  => $mine,
		];
		if ( $mine ) {
			$out['brief'] = (string) $row['brief'];
			$out['cost']  = self::cost_for_seconds( (int) $row['seconds'] );
		}
		return $out;
	}

	private static function author_names( $rows ) {
		$ids = array_values( array_unique( array_filter( array_map( static fn( $r ) => (int) $r['author_id'], $rows ) ) ) );
		$out = [];
		foreach ( $ids as $id ) { $u = get_userdata( $id ); if ( $u ) { $out[ $id ] = [ 'name' => $u->display_name, 'slug' => $u->user_nicename ]; } }
		return $out;
	}

	private static function save_video( $id, $b64 ) {
		$bytes = (string) base64_decode( (string) $b64, true );
		if ( strlen( $bytes ) < 1024 || strlen( $bytes ) > 200 * 1024 * 1024 || substr( $bytes, 4, 4 ) !== 'ftyp' ) { return ''; }
		$up = wp_upload_dir(); if ( ! empty( $up['error'] ) ) { return ''; }
		$dir = $up['basedir'] . '/films'; if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		$dest = $dir . '/film-' . (int) $id . '.mp4';
		if ( file_put_contents( $dest, $bytes ) === false ) { return ''; }
		@chmod( $dest, 0644 );
		return $up['baseurl'] . '/films/film-' . (int) $id . '.mp4';
	}

	private static function save_image( $id, $b64 ) {
		$bytes = (string) base64_decode( (string) $b64, true );
		if ( strlen( $bytes ) < 256 || strlen( $bytes ) > 12 * 1024 * 1024 ) { return ''; }
		$sig = substr( $bytes, 0, 4 );
		$ext = ( "\xFF\xD8\xFF" === substr( $sig, 0, 3 ) ) ? 'jpg' : ( ( "\x89PNG" === $sig ) ? 'png' : ( 'RIFF' === $sig ? 'webp' : '' ) );
		if ( $ext === '' ) { return ''; }
		$up = wp_upload_dir(); if ( ! empty( $up['error'] ) ) { return ''; }
		$dir = $up['basedir'] . '/films'; if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		$dest = $dir . '/film-' . (int) $id . '-poster.' . $ext;
		if ( file_put_contents( $dest, $bytes ) === false ) { return ''; }
		@chmod( $dest, 0644 );
		return $up['baseurl'] . '/films/film-' . (int) $id . '-poster.' . $ext;
	}

	private static function row( $id ) { return Data::one( 'SELECT * FROM ' . Data::t( 'aq_films' ) . ' WHERE id = %d', [ (int) $id ] ); }
	private static function can_edit( $row ) { return (int) $row['author_id'] === Rest::uid() || current_user_can( 'manage_options' ); }

	private static function unique_slug( $title ) {
		$base = sanitize_title( $title ) ?: 'film';
		$slug = $base; $n = 2;
		while ( Data::col( 'SELECT id FROM ' . Data::t( 'aq_films' ) . ' WHERE slug = %s', [ $slug ] ) ) { $slug = $base . '-' . $n; $n++; }
		return $slug;
	}

	private static function unlink_file( $url ) {
		if ( $url === '' ) { return; }
		// AND THE CDN OBJECT. A file that was migrated to the CDN no longer matches the origin prefix
		// tested below, so this helper used to do NOTHING for it — the row went and the bytes stayed
		// downloadable. Media::destroy resolves a CDN URL to its key and deletes the object; it
		// refuses any other origin, so an external URL is never touched.
		if ( class_exists( '\\AQ\\Media' ) ) { Media::destroy( $url ); }
		$up = wp_upload_dir(); if ( ! empty( $up['error'] ) ) { return; }
		if ( strpos( $url, $up['baseurl'] . '/films/' ) !== 0 ) { return; }
		$p = $up['basedir'] . '/films/' . basename( $url );
		if ( is_file( $p ) ) { @unlink( $p ); }
	}

	private static function mmss( $s ) { $s = (int) $s; return sprintf( '%d:%02d', intdiv( $s, 60 ), $s % 60 ); }

	/** Publish the operator's already-rendered example films for FREE (platform seed content, like the
	 *  other studios' seed examples) — so a real film shows on the profile + earns points without a coin
	 *  charge. Idempotent: each film id is published at most once (tracked in an option). */
	public static function import_seed() {
		self::ensure_tables();
		$author = (int) get_option( 'aq_course_author_uid', 0 );
		if ( ! $author ) { return; }
		$done = array_filter( array_map( 'intval', explode( ',', (string) get_option( 'aq_films_seeded', '' ) ) ) );
		$rows = Data::all( 'SELECT id, seconds FROM ' . Data::t( 'aq_films' )
			. " WHERE author_id = %d AND status = 'draft' AND film_state = 'review' AND video_url <> '' ORDER BY id ASC LIMIT 5", [ $author ] );
		foreach ( $rows as $r ) {
			$id = (int) $r['id'];
			if ( in_array( $id, $done, true ) ) { continue; }
			Data::update( 'aq_films', [ 'status' => 'published', 'film_state' => 'live', 'updated' => Data::now() ], [ 'id' => $id ] );
			Economy::content_points( $author, self::cost_for_seconds( (int) $r['seconds'] ), 'film:' . $id ); // idempotent by ref; no coin charge (seed)
			$done[] = $id;
		}
		update_option( 'aq_films_seeded', implode( ',', $done ), true );
	}

	/** Films a member made, for their profile (published first). */
	public static function for_profile( $uid, $limit = 12 ) {
		self::ensure_tables();
		return array_map( [ self::class, 'card' ], Data::all(
			'SELECT * FROM ' . Data::t( 'aq_films' ) . ' WHERE author_id = %d AND status = %s ORDER BY id DESC LIMIT %d',
			[ (int) $uid, 'published', (int) $limit ] ) );
	}
}
