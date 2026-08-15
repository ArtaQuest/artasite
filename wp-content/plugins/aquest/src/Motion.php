<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaMotion — an AI animation studio. The video sibling of ArtaPublishing (AQ\Library) and ArtaSound
 * (AQ\Music). It scripts 3Blue1Brown-style explanatory animations of a topic, in the ArtaQuest brand
 * style (gold #E8B923 + blue #1746DC on a dark space ground).
 *
 * A member makes a REQUEST — a brief (the topic + what to explain) — and may attach reference images as
 * INSPIRATION. ArtaMotion writes an ORIGINAL animation SCRIPT (Manim) from the brief, renders it to a
 * video, and — after the author reviews it — publishes it as their OWN work, under their OWN name. It
 * plays in a video player on ArtaQuest, is listed in /animations + on the author's profile, earns points,
 * and is SEO-indexed (VideoObject). The rendered Manim script is kept with the animation (transparency).
 *
 * Mirrors AQ\Library / AQ\Music exactly (brief + optional inspiration → original work; queued→processing→
 * review→live; publish charges ArtaCoins by the requested length; worker relay generates the artifact).
 * Generation runs LOCALLY in the motion relay daemon — Claude writes the Manim script (it is just code),
 * `manim` renders it to mp4 on the operator's machine — so no third-party API key is needed.
 *
 * Two tables (self-install — the Library/Music pattern, isolated from Schema::VERSION):
 *   • aq_animations     — one row per ANIMATION PROJECT (brief → script + rendered video + its lifecycle)
 *   • aq_anim_sources   — the private reference images attached to a project
 */
final class Motion {

	const TABLE_VERSION = '1';
	const MAX_SOURCES   = 8;   // reference images per project
	const COIN_PER_30S  = 2;   // ArtaCoins per 30s of REQUESTED length, on publish (min ₳2 — rendering is heavy)
	const MAX_SECONDS   = 600; // 10 minutes
	const DEFAULT_SECS  = 60;
	const SOURCE_EXTS   = [ 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg' ];

	/** What it costs (ArtaCoins) to publish an animation of this requested length — at least ₳2. */
	public static function cost_for_seconds( $secs ) { return max( 1, (int) ceil( max( 1, (int) $secs ) / 30 ) ) * self::COIN_PER_30S; }

	/** Self-installed storage — ArtaMotion owns its tables. */
	public static function ensure_tables() {
		if ( get_option( 'aq_motion_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		$an      = $wpdb->prefix . 'aq_animations';
		$srcs    = $wpdb->prefix . 'aq_anim_sources';
		dbDelta( "CREATE TABLE {$an} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			slug VARCHAR(191) NOT NULL DEFAULT '',
			title VARCHAR(255) NOT NULL DEFAULT '',
			seconds INT UNSIGNED NOT NULL DEFAULT 0,
			brief LONGTEXT NULL,
			summary TEXT NULL,
			video_url VARCHAR(600) NOT NULL DEFAULT '',
			poster VARCHAR(600) NOT NULL DEFAULT '',
			script LONGTEXT NULL,
			rights_ok TINYINT(1) NOT NULL DEFAULT 0,
			status VARCHAR(20) NOT NULL DEFAULT 'draft',
			anim_state VARCHAR(12) NOT NULL DEFAULT '',
			claimed_at INT UNSIGNED NOT NULL DEFAULT 0,
			play_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			updated INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY slug (slug),
			KEY author (author_id),
			KEY pub_feed (status, id),
			KEY anim_queue (anim_state, id)
		) {$charset};" );
		dbDelta( "CREATE TABLE {$srcs} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			anim_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			title VARCHAR(255) NOT NULL DEFAULT '',
			file_url VARCHAR(600) NOT NULL DEFAULT '',
			file_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY anim (anim_id, id)
		) {$charset};" );
		update_option( 'aq_motion_table_version', self::TABLE_VERSION, true );
	}

	/**
	 * Seed (or refresh) the bundled EXAMPLE animation(s) from data/motion-seed.json — an ORIGINAL explainer
	 * authored by the operator (option aq_course_author_uid, i.e. /u/arash), so the studio ships with a real,
	 * playable, SEO-indexed sample without the relay/model running. Filemtime-gated + idempotent by slug (same
	 * pattern as Library::import_seed). The bundled mp4 (+ optional poster) in data/ is copied into
	 * uploads/animations/. No coin charge.
	 */
	public static function import_seed() {
		$file = AQ_DIR . '/data/motion-seed.json';
		if ( ! is_file( $file ) ) { return; }
		$mt = (string) @filemtime( $file ) . '|v2';
		if ( get_option( 'aq_motion_seed_mtime' ) === $mt ) { return; }
		self::ensure_tables();
		$author = (int) get_option( 'aq_course_author_uid', 0 );
		$data   = json_decode( (string) @file_get_contents( $file ), true );
		$up     = wp_upload_dir();
		$ok     = true; // don't mark done if a bundled media file hasn't synced yet (deploy race) — retry next boot
		if ( $author && is_array( $data ) && empty( $up['error'] ) ) {
			$dir = $up['basedir'] . '/animations';
			if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
			foreach ( $data as $b ) {
				if ( ! is_array( $b ) || empty( $b['slug'] ) || empty( $b['title'] ) || empty( $b['video'] ) ) { continue; }
				$srcv = AQ_DIR . '/data/' . basename( (string) $b['video'] );
				if ( ! is_file( $srcv ) ) { $ok = false; continue; }
				$slug = sanitize_title( (string) $b['slug'] );
				// Re-seeds must land on a NEW url — the uploads CDN caches by url for a year, so an in-place
				// overwrite keeps serving the stale file. Hash the content into the filename, and sweep this
				// slug's prior seed files (old flat name + any earlier hash) so they don't accumulate.
				foreach ( array_merge( (array) glob( $dir . '/anim-seed-' . $slug . '.*' ),
				                       (array) glob( $dir . '/anim-seed-' . $slug . '-*' ) ) as $old_f ) { @unlink( $old_f ); }
				$ver   = substr( (string) @md5_file( $srcv ), 0, 10 );
				$vname = 'anim-seed-' . $slug . '-' . $ver . '.mp4';
				@copy( $srcv, $dir . '/' . $vname );
				@chmod( $dir . '/' . $vname, 0644 );
				$poster = '';
				if ( ! empty( $b['poster'] ) ) {
					$srcp = AQ_DIR . '/data/' . basename( (string) $b['poster'] );
					if ( is_file( $srcp ) ) {
						$pext  = strtolower( pathinfo( $srcp, PATHINFO_EXTENSION ) ) ?: 'png';
						$pver  = substr( (string) @md5_file( $srcp ), 0, 10 );
						$pname = 'anim-seed-' . $slug . '-' . $pver . '.' . $pext;
						@copy( $srcp, $dir . '/' . $pname );
						@chmod( $dir . '/' . $pname, 0644 );
						$poster = $up['baseurl'] . '/animations/' . $pname;
					}
				}
				$row = [
					'author_id'  => $author,
					'title'      => mb_substr( sanitize_text_field( (string) $b['title'] ), 0, 255 ),
					'seconds'    => max( 1, (int) ( $b['seconds'] ?? 12 ) ),
					'brief'      => mb_substr( sanitize_textarea_field( (string) ( $b['brief'] ?? '' ) ), 0, 8000 ),
					'summary'    => mb_substr( sanitize_textarea_field( (string) ( $b['summary'] ?? '' ) ), 0, 2000 ),
					'video_url'  => $up['baseurl'] . '/animations/' . $vname,
					'poster'     => $poster,
					'script'     => mb_substr( (string) ( $b['script'] ?? '' ), 0, 200000 ),
					'rights_ok'  => 1,
					'status'     => 'published',
					'anim_state' => 'live',
					'updated'    => Data::now(),
				];
				$exists = (int) Data::col( 'SELECT id FROM ' . Data::t( 'aq_animations' ) . ' WHERE slug = %s', [ $slug ] );
				if ( $exists ) {
					Data::update( 'aq_animations', $row, [ 'id' => $exists ] );
				} else {
					$row['slug'] = $slug;
					$row['created'] = Data::now();
					Data::insert( 'aq_animations', $row );
				}
			}
		} else {
			$ok = false;
		}
		if ( $ok ) { update_option( 'aq_motion_seed_mtime', $mt, true ); }
	}

	// ── member-facing ──────────────────────────────────────────────────────────────

	/** POST animations — start an animation project from a brief (the topic). Optional first reference
	 *  image (multipart 'file'), and ?generate=1 to start now. */
	public static function create( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_anim', 20, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();

		$title = mb_substr( sanitize_text_field( (string) Rest::p( $req, 'title', '' ) ), 0, 255 );
		if ( $title === '' ) { return Rest::err( 'no_title', 'Give the animation a title' ); }
		$brief = mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'brief', '' ) ), 0, 8000 );
		if ( $brief === '' ) { return Rest::err( 'no_brief', 'Describe the topic to animate — your brief is the request the studio works from' ); }
		$secs = max( 1, min( self::MAX_SECONDS, (int) Rest::pint( $req, 'seconds', self::DEFAULT_SECS ) ) );
		$summary = mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'summary', '' ) ), 0, 2000 );
		if ( in_array( (string) Rest::p( $req, 'rights_ok', '' ), [ '', '0', 'false' ], true ) ) {
			return Rest::err( 'no_rights', 'You must confirm this will be your own original work and that you may use any uploaded image as private reference' );
		}

		$now = Data::now();
		$id  = Data::insert( 'aq_animations', [
			'author_id'  => $uid,
			'slug'       => self::unique_slug( $title ),
			'title'      => $title,
			'seconds'    => $secs,
			'brief'      => $brief,
			'summary'    => $summary,
			'rights_ok'  => 1,
			'status'     => 'draft',
			'anim_state' => '',
			'created'    => $now,
			'updated'    => $now,
		] );
		if ( ! $id ) { return Rest::err( 'failed', 'Could not start the animation', 500 ); }

		if ( isset( $_FILES['file'] ) && is_uploaded_file( (string) ( $_FILES['file']['tmp_name'] ?? '' ) ) ) {
			$s = self::store_source( $id, $_FILES['file'] );
			if ( $s instanceof \WP_REST_Response ) {
				global $wpdb;
				$wpdb->delete( Data::t( 'aq_animations' ), [ 'id' => $id ] );
				return $s;
			}
		}
		if ( ! in_array( (string) Rest::p( $req, 'generate', '' ), [ '', '0', 'false' ], true ) ) {
			Data::update( 'aq_animations', [ 'anim_state' => 'queued', 'updated' => Data::now() ], [ 'id' => $id ] );
		}
		return self::detail( self::row( $id ) );
	}

	/** POST animations/{id}/sources (multipart 'file') — attach a reference image (owner only). */
	public static function add_source( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Animation not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your animation', 403 ); }
		if ( (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_anim_sources' ) . ' WHERE anim_id = %d', [ (int) $row['id'] ] ) >= self::MAX_SOURCES ) {
			return Rest::err( 'too_many', 'That is the maximum number of reference images for one animation' );
		}
		$f = isset( $_FILES['file'] ) ? $_FILES['file'] : null;
		if ( ! $f || ! is_uploaded_file( (string) ( $f['tmp_name'] ?? '' ) ) ) { return Rest::err( 'no_file', 'No file received' ); }
		return self::store_source( (int) $row['id'], $f );
	}

	/** POST animations/{id}/sources/{sid}/delete — remove a reference image (owner only). */
	public static function remove_source( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Animation not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your animation', 403 ); }
		$sid = Rest::pint( $req, 'sid' );
		$src = Data::one( 'SELECT * FROM ' . Data::t( 'aq_anim_sources' ) . ' WHERE id = %d AND anim_id = %d', [ $sid, (int) $row['id'] ] );
		if ( ! $src ) { return Rest::err( 'not_found', 'Source not found', 404 ); }
		self::unlink_file( (string) $src['file_url'], 'anim-sources' );
		global $wpdb;
		$wpdb->delete( Data::t( 'aq_anim_sources' ), [ 'id' => $sid ] );
		return [ 'ok' => true ];
	}

	/** POST animations/{id}/generate — (re)queue the AI generation (owner only). */
	public static function generate( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Animation not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your animation', 403 ); }
		if ( trim( (string) $row['brief'] ) === '' ) { return Rest::err( 'no_brief', 'Add a brief before generating' ); }
		if ( in_array( $row['anim_state'], [ 'queued', 'processing' ], true ) ) { return [ 'ok' => true, 'queued' => true ]; }
		$fields = [ 'anim_state' => 'queued', 'claimed_at' => 0, 'updated' => Data::now() ];
		if ( Rest::p( $req, 'seconds', null ) !== null ) {
			$fields['seconds'] = max( 1, min( self::MAX_SECONDS, (int) Rest::pint( $req, 'seconds', self::DEFAULT_SECS ) ) );
		}
		Data::update( 'aq_animations', $fields, [ 'id' => (int) $row['id'] ] );
		return [ 'ok' => true, 'queued' => true ];
	}

	/** POST animations/{id}/publish — publish the rendered animation (owner only). Charges ArtaCoins by the
	 *  requested length, EXACTLY ONCE, via an atomic draft→published claim (no double-charge race). */
	public static function publish_anim( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Animation not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your animation', 403 ); }
		if ( (string) $row['video_url'] === '' ) { return Rest::err( 'no_anim', 'The animation is not rendered yet — please wait for it to finish', 409 ); }
		$summary = mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'summary', (string) $row['summary'] ) ), 0, 2000 );
		$id   = (int) $row['id'];
		$uid  = (int) $row['author_id'];
		$cost = self::cost_for_seconds( (int) $row['seconds'] );
		$ref  = 'anim:' . $id;

		if ( $row['status'] === 'draft' ) {
			if ( $err = Challenges::quota_gate( $uid ) ) { return $err; } // shelf quota: prune before publishing more
			// Friendly pre-check only — it keeps the exact figure in the refusal copy. The
			// AUTHORITATIVE check is inside Economy::spend below, which holds this member's
			// wallet lock across the check and the debit together.
			$bal = Economy::coin_balance( $uid );
			if ( $bal < $cost ) {
				return Rest::err( 'insufficient', 'Publishing a ' . self::mmss( (int) $row['seconds'] ) . ' animation costs ₳' . $cost . ' — you have ₳' . $bal . '.', 402 );
			}
			// Charge BEFORE claiming the row. Claim-then-charge publishes the work even when the
			// charge is refused, which mints the goods for free.
			$paid = Economy::spend( $uid, $cost, 'motion', $ref );
			if ( $paid !== '' ) { return Economy::spend_error( $paid, $cost, 'Publishing this animation' ); }
			$claimed = (bool) Data::update( 'aq_animations', [ 'status' => 'published', 'anim_state' => 'live', 'updated' => Data::now() ], [ 'id' => $id, 'status' => 'draft' ] );
			if ( ! $claimed ) {
				// Another request published it first — give the money straight back, append-only.
				Economy::refund_spend( $uid, $cost, 'motion-void', $ref );
			}
			if ( $claimed ) {
				Economy::content_points( $uid, $cost, $ref );
				Challenges::enter( 'animation', $id, $uid, $cost ); // fee → the season's Animation Challenge pool
			}
		}
		Data::update( 'aq_animations', [ 'summary' => $summary, 'status' => 'published', 'anim_state' => 'live', 'updated' => Data::now() ], [ 'id' => $id ] );
		return self::detail( self::row( $id ) );
	}

	/** GET animations — public keyset list of PUBLISHED animations (the /animations hub). */
	public static function list( $req ) {
		self::ensure_tables();
		$cursor = Rest::pint( $req, 'cursor', 0 );
		$q      = (string) Rest::p( $req, 'q', '' );
		[ $rows, $next ] = Data::search_page( 'aq_animations', [ 'title', 'summary' ], $q, "status = 'published'", [], $cursor, 24 );
		$names = self::author_names( $rows );
		return [ 'items' => array_map( static fn( $r ) => self::card( $r, $names ), $rows ), 'next' => $next ];
	}

	/** GET animations/mine — the signed-in member's own animation projects (drafts + published). */
	public static function mine( $req ) {
		self::ensure_tables();
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_animations' ) . " WHERE author_id = %d AND status != 'removed' ORDER BY id DESC LIMIT 100", [ Rest::uid() ] );
		$names = self::author_names( $rows );
		return [ 'items' => array_map( static fn( $r ) => self::card( $r, $names ) + [ 'status' => (string) $r['status'], 'anim_state' => (string) $r['anim_state'] ], $rows ) ];
	}

	/** GET animations/{id} — player payload. Drafts are owner/operator-only; published are public. */
	public static function get( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row || $row['status'] === 'removed' ) { return Rest::err( 'not_found', 'Animation not found', 404 ); }
		if ( $row['status'] !== 'published' && ! self::can_edit( $row ) ) { return Rest::err( 'not_found', 'Animation not found', 404 ); }
		if ( $row['status'] === 'published' ) { Data::bump( 'aq_animations', [ 'id' => (int) $row['id'] ], 'play_count', 1 ); }
		return self::detail( $row );
	}

	/** POST animations/{id}/delete — owner or operator takedown (removes the row + sources + the video). */
	public static function remove( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Animation not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your animation', 403 ); }
		foreach ( Data::all( 'SELECT file_url FROM ' . Data::t( 'aq_anim_sources' ) . ' WHERE anim_id = %d', [ (int) $row['id'] ] ) as $s ) {
			self::unlink_file( (string) $s['file_url'], 'anim-sources' );
		}
		self::unlink_file( (string) $row['video_url'], 'animations' );
		global $wpdb;
		$wpdb->delete( Data::t( 'aq_anim_sources' ), [ 'anim_id' => (int) $row['id'] ] );
		Data::update( 'aq_animations', [ 'status' => 'removed', 'updated' => Data::now() ], [ 'id' => (int) $row['id'] ] );
		return [ 'ok' => true ];
	}

	// ── ArtaMotion relay (auth: 'worker') — the brief→Manim-script→video generation ───────────────────

	/** POST relay/anim/poll — claim the oldest animation queued to be generated → the brief + references. */
	public static function anim_poll( $req ) {
		self::ensure_tables();
		set_transient( 'aq_motion_beat', time(), 120 );
		global $wpdb;
		if ( ! get_transient( 'aq_motion_reclaim' ) ) {
			set_transient( 'aq_motion_reclaim', 1, 60 );
			$wpdb->query( $wpdb->prepare(
				'UPDATE ' . Data::t( 'aq_animations' ) . " SET anim_state = 'queued' WHERE anim_state = 'processing' AND updated < %d",
				Data::now() - 7200 ) ); // renders are slow; 2h reclaim
		}
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_animations' ) . " WHERE anim_state = 'queued' AND status != 'removed' ORDER BY id ASC LIMIT 1" );
		if ( ! $row ) { return [ 'job' => null ]; }
		$got = Data::update( 'aq_animations', [ 'anim_state' => 'processing', 'claimed_at' => Data::now(), 'updated' => Data::now() ], [ 'id' => (int) $row['id'], 'anim_state' => 'queued' ] );
		if ( ! $got ) { return [ 'job' => null ]; }
		$sources = array_map( static fn( $s ) => [
			'title'    => (string) $s['title'],
			'file_url' => (string) $s['file_url'],
		], Data::all( 'SELECT * FROM ' . Data::t( 'aq_anim_sources' ) . ' WHERE anim_id = %d ORDER BY id ASC', [ (int) $row['id'] ] ) );
		return [ 'job' => [
			'id'      => (int) $row['id'],
			'title'   => (string) $row['title'],
			'brief'   => (string) $row['brief'],
			'seconds' => (int) $row['seconds'],
			'sources' => $sources,
		] ];
	}

	/** POST relay/anim/complete — the daemon returns the rendered video (base64 mp4) + the Manim script
	 *  (+ optional poster). Lands in 'review' for the author to watch and publish (we never auto-publish). */
	public static function anim_complete( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Animation not found', 404 ); }
		if ( $row['anim_state'] !== 'processing' ) { return [ 'ok' => true, 'ignored' => true ]; }
		$b64    = (string) Rest::p( $req, 'video_b64', '' );
		$poster = esc_url_raw( (string) Rest::p( $req, 'poster', '' ) );
		// A representative poster FRAME grabbed from the rendered video by the relay (ffmpeg), sent as base64.
		$poster_b64 = (string) Rest::p( $req, 'poster_b64', '' );
		if ( $poster_b64 !== '' ) { $saved = self::save_image( (int) $row['id'], $poster_b64 ); if ( $saved !== '' ) { $poster = $saved; } }
		$script = mb_substr( (string) Rest::p( $req, 'script', '' ), 0, 200000 ); // the Manim source, kept for transparency
		$url    = self::save_video( (int) $row['id'], $b64 );
		if ( $url === '' ) {
			Data::update( 'aq_animations', [ 'anim_state' => 'failed', 'updated' => Data::now() ], [ 'id' => (int) $row['id'], 'anim_state' => 'processing' ] );
			return Rest::err( 'empty_anim', 'No usable video received', 400 );
		}
		$wrote = (bool) Data::update( 'aq_animations', [
			'video_url'  => $url,
			'poster'     => $poster !== '' ? mb_substr( $poster, 0, 600 ) : (string) $row['poster'],
			'script'     => $script,
			'anim_state' => 'review',
			'updated'    => Data::now(),
		], [ 'id' => (int) $row['id'], 'anim_state' => 'processing' ] );
		if ( ! $wrote ) { return [ 'ok' => true, 'ignored' => true ]; }
		Notify::push( (int) $row['author_id'], 'motion', 'Your animation is ready to review',
			'Your draft of “' . (string) $row['title'] . '” is ready — watch and publish.',
			'/watch/' . (int) $row['id'] . '/', 'anim-ready:' . (int) $row['id'] );
		return [ 'ok' => true ];
	}

	// ── shaping ─────────────────────────────────────────────────────────────────────

	private static function card( $row, $names = null ) {
		$aid  = (int) $row['author_id'];
		$name = is_array( $names ) ? (string) ( $names[ $aid ]['name'] ?? '' ) : '';
		$slug = is_array( $names ) ? (string) ( $names[ $aid ]['slug'] ?? '' ) : '';
		return [
			'id'      => (int) $row['id'],
			'slug'    => (string) $row['slug'],
			'title'   => (string) $row['title'],
			'summary' => mb_substr( (string) $row['summary'], 0, 220 ),
			'poster'  => (string) $row['poster'],
			'seconds' => (int) $row['seconds'],
			'length'  => self::mmss( (int) $row['seconds'] ),
			'plays'   => (int) $row['play_count'],
			'author'  => $aid ? [ 'id' => $aid, 'name' => $name, 'slug' => $slug ] : null,
			'created' => (int) $row['created'],
		];
	}

	private static function detail( $row ) {
		$card = self::card( $row, self::author_names( [ $row ] ) );
		$mine = self::can_edit( $row );
		$out  = $card + [
			'status'     => (string) $row['status'],
			'anim_state' => (string) $row['anim_state'],
			'video_url'  => ( $row['status'] === 'published' || $mine ) ? (string) $row['video_url'] : '',
			'is_owner'   => $mine,
		];
		// The Manim script is public on a published animation (transparency, like the Journal's open code).
		if ( $row['status'] === 'published' || $mine ) { $out['script'] = (string) ( $row['script'] ?? '' ); }
		if ( $mine ) {
			$out['brief'] = (string) $row['brief'];
			$out['cost']  = self::cost_for_seconds( (int) $row['seconds'] );
			$out['paid']  = $row['status'] === 'published' || (bool) Data::col(
				'SELECT 1 FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'motion' AND ref = %s LIMIT 1", [ 'anim:' . (int) $row['id'] ] );
			$out['sources'] = array_map( static fn( $s ) => [
				'id'    => (int) $s['id'],
				'title' => (string) $s['title'],
				'url'   => (string) $s['file_url'],
			], Data::all( 'SELECT id, title, file_url FROM ' . Data::t( 'aq_anim_sources' ) . ' WHERE anim_id = %d ORDER BY id ASC', [ (int) $row['id'] ] ) );
		}
		return $out;
	}

	private static function author_names( $rows ) {
		$ids = array_values( array_unique( array_filter( array_map( static fn( $r ) => (int) $r['author_id'], $rows ) ) ) );
		if ( ! $ids ) { return []; }
		$names = [];
		foreach ( get_users( [ 'include' => $ids, 'fields' => [ 'ID', 'display_name', 'user_nicename' ] ] ) as $u ) {
			$names[ (int) $u->ID ] = [ 'name' => $u->display_name, 'slug' => $u->user_nicename ];
		}
		return $names;
	}

	// ── helpers ───────────────────────────────────────────────────────────────────

	/** Store one reference image → an aq_anim_sources card, or a WP_REST_Response error. */
	private static function store_source( $anim_id, $f ) {
		$size = (int) ( $f['size'] ?? 0 );
		if ( $size <= 0 ) { return Rest::err( 'empty', 'The file is empty' ); }
		if ( $size > 20 * 1024 * 1024 ) { return Rest::err( 'too_big', 'Image exceeds 20 MB' ); }
		$name = sanitize_file_name( (string) ( $f['name'] ?? 'reference.png' ) );
		$ext  = strtolower( pathinfo( $name, PATHINFO_EXTENSION ) );
		if ( ! in_array( $ext, self::SOURCE_EXTS, true ) ) { return Rest::err( 'bad_type', 'Reference must be an image (png, jpg, webp, gif, svg)' ); }
		$up = wp_upload_dir();
		if ( ! empty( $up['error'] ) ) { return Rest::err( 'failed', 'Upload directory unavailable', 500 ); }
		$dir = $up['basedir'] . '/anim-sources';
		if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		// An SVG is a DOCUMENT, not a picture: it can carry <script> and event attributes, and this
		// file lands under uploads/ on OUR origin, where opening its URL executes that script as
		// artaquest.com. The random filename is not a defence — file_url is written to
		// aq_anim_sources, and every row of every table is served to the public by the Data explorer,
		// so the URL is published by design. Rebuild it through the allow-list sanitiser the platform
		// already owns (AQ\Svg::clean, the same gate a published scene passes) and store OUR
		// serialisation, never the author's bytes. A drawing that will not survive the rebuild is
		// refused with the reason, in the author's own words.
		$dest = $dir . '/' . wp_unique_filename( $dir, bin2hex( random_bytes( 16 ) ) . '.' . $ext );
		if ( $ext === 'svg' ) {
			$raw = (string) @file_get_contents( (string) $f['tmp_name'] ); // phpcs:ignore WordPress.WP.AlternativeFunctions
			$c   = Svg::clean( $raw );
			if ( empty( $c['ok'] ) ) { return Rest::err( 'bad_svg', 'That drawing could not be accepted — ' . $c['why'] ); }
			if ( @file_put_contents( $dest, $c['svg'] ) === false ) { return Rest::err( 'failed', 'Could not store the file', 500 ); } // phpcs:ignore WordPress.WP.AlternativeFunctions
			$size = strlen( $c['svg'] );
		} elseif ( ! @move_uploaded_file( (string) $f['tmp_name'], $dest ) ) {
			return Rest::err( 'failed', 'Could not store the file', 500 );
		}
		$fname = basename( $dest );
		@chmod( $dest, 0644 );
		$title = mb_substr( (string) preg_replace( '/\.[a-z0-9]+$/i', '', $name ), 0, 255 );
		$sid   = Data::insert( 'aq_anim_sources', [
			'anim_id'   => (int) $anim_id,
			'title'     => $title,
			'file_url'  => $up['baseurl'] . '/anim-sources/' . $fname,
			'file_size' => $size,
			'created'   => Data::now(),
		] );
		return [ 'id' => (int) $sid, 'title' => $title ];
	}

	/** Save base64 mp4 from the daemon → uploads/animations/anim-<id>.mp4 → its URL. '' on any problem. */
	private static function save_video( $id, $b64 ) {
		$b64 = (string) $b64;
		if ( $b64 === '' ) { return ''; }
		$bytes = (string) base64_decode( $b64, true );
		// mp4/MOV start with a 'ftyp' box at offset 4; require it + a sane size.
		if ( strlen( $bytes ) < 1024 || strlen( $bytes ) > 120 * 1024 * 1024 || substr( $bytes, 4, 4 ) !== 'ftyp' ) { return ''; }
		$up = wp_upload_dir();
		if ( ! empty( $up['error'] ) ) { return ''; }
		$dir = $up['basedir'] . '/animations';
		if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		$dest = $dir . '/anim-' . (int) $id . '.mp4';
		if ( file_put_contents( $dest, $bytes ) === false ) { return ''; }
		@chmod( $dest, 0644 );
		return $up['baseurl'] . '/animations/anim-' . (int) $id . '.mp4';
	}

	/** Save a poster frame (base64, jpg/png/webp) grabbed from the video → its public URL, or '' on failure. */
	private static function save_image( $id, $b64 ) {
		$bytes = (string) base64_decode( (string) $b64, true );
		if ( strlen( $bytes ) < 256 || strlen( $bytes ) > 12 * 1024 * 1024 ) { return ''; }
		$sig = substr( $bytes, 0, 4 );
		$ext = ( "\xFF\xD8\xFF" === substr( $sig, 0, 3 ) ) ? 'jpg' : ( ( "\x89PNG" === $sig ) ? 'png' : ( 'RIFF' === $sig ? 'webp' : '' ) );
		if ( $ext === '' ) { return ''; }
		$up = wp_upload_dir();
		if ( ! empty( $up['error'] ) ) { return ''; }
		$dir = $up['basedir'] . '/animations';
		if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		$dest = $dir . '/anim-' . (int) $id . '-poster.' . $ext;
		if ( file_put_contents( $dest, $bytes ) === false ) { return ''; }
		@chmod( $dest, 0644 );
		return $up['baseurl'] . '/animations/anim-' . (int) $id . '-poster.' . $ext;
	}

	private static function row( $id ) {
		return $id ? Data::one( 'SELECT * FROM ' . Data::t( 'aq_animations' ) . ' WHERE id = %d', [ (int) $id ] ) : null;
	}

	private static function can_edit( $row ) {
		$uid = Rest::uid();
		return $uid && ( $uid === (int) $row['author_id'] || current_user_can( 'manage_options' ) );
	}

	private static function unique_slug( $title ) {
		$base = substr( sanitize_title( $title ) ?: 'animation', 0, 180 );
		$slug = $base;
		$n    = 2;
		while ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_animations' ) . ' WHERE slug = %s LIMIT 1', [ $slug ] ) ) {
			$slug = $base . '-' . $n;
			$n++;
		}
		return $slug;
	}

	private static function unlink_file( $url, $sub ) {
		$up = wp_upload_dir();
		if ( ! empty( $up['error'] ) || $url === '' ) { return; }
		if ( strpos( $url, $up['baseurl'] . '/' . $sub . '/' ) !== 0 ) { return; }
		$path = $up['basedir'] . '/' . $sub . '/' . basename( $url );
		if ( is_file( $path ) ) { @unlink( $path ); }
	}

	private static function mmss( $s ) {
		$s = max( 0, (int) $s );
		return intdiv( $s, 60 ) . ':' . str_pad( (string) ( $s % 60 ), 2, '0', STR_PAD_LEFT );
	}
}
