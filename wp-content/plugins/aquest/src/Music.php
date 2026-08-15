<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaSound — an AI music studio. The audio sibling of ArtaPublishing (AQ\Library).
 *
 * A member makes a REQUEST for a piece of music — a brief (the concept, in their words) — and may attach
 * MULTIPLE source tracks as INSPIRATION (audio they have the right to use). ArtaSound generates a
 * COMPLETELY ORIGINAL track from the brief, using the sources only as inspiration — never copying them
 * (no plagiarism). The author reviews it and publishes it as their OWN work, under their OWN name, and it
 * plays in a player on ArtaQuest, is listed in /music + on the author's profile, earns points, and is
 * SEO-indexed (MusicRecording). The uploaded sources are PRIVATE inspiration — never shared or published.
 *
 * Two KINDS of project share the one lifecycle (`kind`):
 *   • music     — brief → Claude-composed song rendered by an open music model (ACE-Step on the free
 *                 HF ZeroGPU Space is the flagship; artascore/MusicGen/artacompose are fallbacks).
 *                 Before it reaches the author, the draft goes through MULTIPLE ROUNDS of ADVERSARIAL
 *                 IMPROVEMENT (the ArtaScience pattern): each round an AI critic measures the rendered
 *                 audio + inspects the composition against the brief, files a scored review
 *                 (aq_track_reviews), and — unless it approves — the studio recomposes and re-renders.
 *                 The best-scoring take wins. The rounds are public on the published track.
 *   • audiobook — the member's OWN manuscript (plain text) → a narrated audiobook (Edge-TTS, free,
 *                 ~322 voices), synthesised sentence-by-sentence in CHUNKS across relay ticks so long
 *                 books finish slowly over time without a long-running process. A final QC round
 *                 verifies every sentence made it before the draft lands.
 *
 * Mirrors AQ\Library (brief + private inspiration → original work; queued→processing→review→live;
 * publish charges ArtaCoins; worker relay generates the artifact). Generation runs in the music relay
 * (free/open models + the operator's Claude subscription — no third-party API key, no Vault secret).
 *
 * Three tables (self-install — the Library/Science/Relay pattern, isolated from Schema::VERSION):
 *   • aq_tracks         — one row per PROJECT (brief → generated audio + its lifecycle)
 *   • aq_track_sources  — the private inspiration audio attached to a project
 *   • aq_track_reviews  — one row per adversarial improvement round (verdict + score + report)
 */
final class Music {

	const TABLE_VERSION = '5';
	const MAX_SOURCES   = 8;   // inspiration tracks per project
	const COIN_PER_30S  = 1;   // ArtaCoins per 30s of REQUESTED length, on publish (min ₳1)
	const MAX_SECONDS   = 600; // 10 minutes
	const DEFAULT_SECS  = 150; // a full verse/chorus/bridge song (2:30) — not a 60s clip
	const MAX_ROUNDS    = 4;   // adversarial improvement rounds per music draft (compose → render → critique)
	const WORDS_PER_COIN = 2000;   // audiobook: ~₳1 per 2000 manuscript words (mirrors Narrate)
	const MAX_MANUSCRIPT = 100000; // audiobook manuscript cap (chars ≈ 15k words ≈ 100 min) — keeps the finished mp3 well inside the upload envelope
	const SOURCE_EXTS   = [ 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac' ];
	const OUT_EXT       = [ 'audio/mpeg' => 'mp3', 'audio/wav' => 'wav', 'audio/x-wav' => 'wav', 'audio/mp4' => 'm4a', 'audio/aac' => 'aac', 'audio/ogg' => 'ogg', 'audio/flac' => 'flac' ];

	/** What it costs (ArtaCoins) to publish a track of this requested length — at least ₳1. */
	public static function cost_for_seconds( $secs ) { return max( 1, (int) ceil( max( 1, (int) $secs ) / 30 ) ) * self::COIN_PER_30S; }

	/** What it costs (ArtaCoins) to publish an audiobook of this many manuscript words — at least ₳1. */
	public static function cost_for_words( $words ) { return max( 1, (int) ceil( (int) $words / self::WORDS_PER_COIN ) ); }

	/** Kind-aware publish cost for a project row. */
	public static function cost_for( $row ) {
		return ( (string) ( $row['kind'] ?? 'music' ) ) === 'audiobook'
			? self::cost_for_words( self::word_count( (string) ( $row['manuscript'] ?? '' ) ) )
			: self::cost_for_seconds( (int) $row['seconds'] );
	}

	/** UTF-8-safe pricing units: whitespace-delimited words, floored by characters÷6 so space-less
	 *  scripts (Chinese/Japanese/Thai — one giant \S+ run per paragraph) pay by length like everyone. */
	public static function word_count( $text ) {
		$text = (string) $text;
		return max( (int) preg_match_all( '/\S+/u', $text ), (int) ceil( mb_strlen( $text ) / 6 ) );
	}

	/** Self-installed storage — ArtaSound owns its tables. */
	public static function ensure_tables() {
		if ( get_option( 'aq_music_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		$tr      = $wpdb->prefix . 'aq_tracks';
		$srcs    = $wpdb->prefix . 'aq_track_sources';
		$revs    = $wpdb->prefix . 'aq_track_reviews';
		dbDelta( "CREATE TABLE {$tr} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			slug VARCHAR(191) NOT NULL DEFAULT '',
			title VARCHAR(255) NOT NULL DEFAULT '',
			kind VARCHAR(12) NOT NULL DEFAULT 'music',
			voice VARCHAR(48) NOT NULL DEFAULT '',
			seconds INT UNSIGNED NOT NULL DEFAULT 0,
			brief LONGTEXT NULL,
			manuscript LONGTEXT NULL,
			summary TEXT NULL,
			lyrics LONGTEXT NULL,
			segments LONGTEXT NULL,
			audio_url VARCHAR(600) NOT NULL DEFAULT '',
			audio_mime VARCHAR(40) NOT NULL DEFAULT '',
			cover VARCHAR(600) NOT NULL DEFAULT '',
			rights_ok TINYINT(1) NOT NULL DEFAULT 0,
			status VARCHAR(20) NOT NULL DEFAULT 'draft',
			track_state VARCHAR(12) NOT NULL DEFAULT '',
			round TINYINT UNSIGNED NOT NULL DEFAULT 0,
			progress VARCHAR(255) NOT NULL DEFAULT '',
			claimed_at INT UNSIGNED NOT NULL DEFAULT 0,
			play_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			updated INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY slug (slug),
			KEY author (author_id),
			KEY pub_feed (status, id),
			KEY track_queue (track_state, id)
		) {$charset};" );
		dbDelta( "CREATE TABLE {$srcs} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			track_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			title VARCHAR(255) NOT NULL DEFAULT '',
			file_url VARCHAR(600) NOT NULL DEFAULT '',
			file_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY track (track_id, id)
		) {$charset};" );
		dbDelta( "CREATE TABLE {$revs} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			track_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			round TINYINT UNSIGNED NOT NULL DEFAULT 1,
			verdict VARCHAR(10) NOT NULL DEFAULT '',
			score TINYINT UNSIGNED NOT NULL DEFAULT 0,
			scores TEXT NULL,
			report TEXT NULL,
			audio_url VARCHAR(600) NOT NULL DEFAULT '',
			metrics TEXT NULL,
			model VARCHAR(64) NOT NULL DEFAULT '',
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY track_round (track_id, round),
			UNIQUE KEY uniq_round (track_id, round)
		) {$charset};" );
		update_option( 'aq_music_table_version', self::TABLE_VERSION, true );
	}

	/**
	 * Seed (or refresh) the bundled EXAMPLE track(s) from data/music-seed.json — an ORIGINAL piece authored
	 * by the operator (option aq_course_author_uid, i.e. /u/arash), so the studio ships with a real, playable,
	 * SEO-indexed sample without the relay/model running. Filemtime-gated + idempotent by slug (same pattern as
	 * Library::import_seed). The bundled audio file (data/<file>) is copied into uploads/music/. No coin charge.
	 */
	public static function import_seed() {
		$file = AQ_DIR . '/data/music-seed.json';
		if ( ! is_file( $file ) ) { return; }
		$mt = (string) @filemtime( $file ) . '|v5';
		if ( get_option( 'aq_music_seed_mtime' ) === $mt ) { return; }
		self::ensure_tables();
		$author = (int) get_option( 'aq_course_author_uid', 0 );
		$data   = json_decode( (string) @file_get_contents( $file ), true );
		$up     = wp_upload_dir();
		$ok     = true; // don't mark done if a bundled media file hasn't synced yet (deploy race) — retry next boot
		if ( $author && is_array( $data ) && empty( $up['error'] ) ) {
			$dir = $up['basedir'] . '/music';
			if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
			foreach ( $data as $b ) {
				if ( ! is_array( $b ) || empty( $b['slug'] ) || empty( $b['title'] ) || empty( $b['file'] ) ) { continue; }
				$srcf = AQ_DIR . '/data/' . basename( (string) $b['file'] );
				if ( ! is_file( $srcf ) ) { $ok = false; continue; }
				$slug = sanitize_title( (string) $b['slug'] );
				$ext  = strtolower( pathinfo( $srcf, PATHINFO_EXTENSION ) ) ?: 'mp3';
				$name = 'track-seed-' . $slug . '.' . $ext;
				@copy( $srcf, $dir . '/' . $name );
				@chmod( $dir . '/' . $name, 0644 );
				$cover_url = '';
				if ( ! empty( $b['cover'] ) ) {
					$cf = AQ_DIR . '/data/' . basename( (string) $b['cover'] );
					if ( is_file( $cf ) ) {
						$cext  = strtolower( pathinfo( $cf, PATHINFO_EXTENSION ) ) ?: 'jpg';
						$cname = 'track-seed-' . $slug . '-cover.' . $cext;
						@copy( $cf, $dir . '/' . $cname );
						@chmod( $dir . '/' . $cname, 0644 );
						$cover_url = $up['baseurl'] . '/music/' . $cname;
					} else { $ok = false; }
				}
				$row = [
					'author_id'   => $author,
					'title'       => mb_substr( sanitize_text_field( (string) $b['title'] ), 0, 255 ),
					'seconds'     => max( 1, (int) ( $b['seconds'] ?? 30 ) ),
					'brief'       => mb_substr( sanitize_textarea_field( (string) ( $b['brief'] ?? '' ) ), 0, 8000 ),
					'summary'     => mb_substr( sanitize_textarea_field( (string) ( $b['summary'] ?? '' ) ), 0, 2000 ),
					'lyrics'      => mb_substr( sanitize_textarea_field( (string) ( $b['lyrics'] ?? '' ) ), 0, 8000 ),
					'audio_url'   => $up['baseurl'] . '/music/' . $name,
					'audio_mime'  => (string) ( $b['mime'] ?? 'audio/mpeg' ),
					'rights_ok'   => 1,
					'status'      => 'published',
					'track_state' => 'live',
					'updated'     => Data::now(),
				];
				if ( $cover_url !== '' ) { $row['cover'] = $cover_url; }
				$exists = (int) Data::col( 'SELECT id FROM ' . Data::t( 'aq_tracks' ) . ' WHERE slug = %s', [ $slug ] );
				if ( $exists ) {
					Data::update( 'aq_tracks', $row, [ 'id' => $exists ] );
				} else {
					$row['slug'] = $slug;
					$row['created'] = Data::now();
					Data::insert( 'aq_tracks', $row );
				}
			}
		} else {
			$ok = false;
		}
		if ( $ok ) { update_option( 'aq_music_seed_mtime', $mt, true ); }
	}

	// ── member-facing ──────────────────────────────────────────────────────────────

	/** POST music/tracks — start a project from a brief (the request). kind=music (default) or
	 *  kind=audiobook (your own manuscript + an Edge-TTS voice → a narrated audiobook). Optional first
	 *  inspiration track (multipart 'file', music only), and ?generate=1 to start generating now. */
	public static function create( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_track', 20, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();

		$title = mb_substr( sanitize_text_field( (string) Rest::p( $req, 'title', '' ) ), 0, 255 );
		if ( $title === '' ) { return Rest::err( 'no_title', 'Give the track a title' ); }
		$kind = (string) Rest::p( $req, 'kind', 'music' ) === 'audiobook' ? 'audiobook' : 'music';
		$brief = mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'brief', '' ) ), 0, 8000 );
		$manuscript = '';
		$voice = '';
		if ( $kind === 'audiobook' ) {
			$manuscript = mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'manuscript', '' ) ), 0, self::MAX_MANUSCRIPT );
			if ( mb_strlen( $manuscript ) < 100 ) { return Rest::err( 'no_manuscript', 'Paste the manuscript to narrate — at least a paragraph' ); }
			$voice = (string) Rest::p( $req, 'voice', '' );
			if ( ! self::valid_voice( $voice ) ) { return Rest::err( 'bad_voice', 'Pick a narration voice' ); }
			if ( $brief === '' ) { $brief = 'Narrate this manuscript as an audiobook.'; }
		} elseif ( $brief === '' ) {
			return Rest::err( 'no_brief', 'Describe the music you want — your brief is the request the studio works from' );
		}
		$secs = max( 1, min( self::MAX_SECONDS, (int) Rest::pint( $req, 'seconds', self::DEFAULT_SECS ) ) );
		$summary = mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'summary', '' ) ), 0, 2000 );
		if ( in_array( (string) Rest::p( $req, 'rights_ok', '' ), [ '', '0', 'false' ], true ) ) {
			return Rest::err( 'no_rights', 'You must confirm this will be your own original work and that you may use any uploaded audio as private inspiration' );
		}

		$now = Data::now();
		$id  = Data::insert( 'aq_tracks', [
			'author_id'   => $uid,
			'slug'        => self::unique_slug( $title ),
			'title'       => $title,
			'kind'        => $kind,
			'voice'       => $voice,
			'seconds'     => $kind === 'audiobook' ? 0 : $secs,
			'brief'       => $brief,
			'manuscript'  => $manuscript,
			'summary'     => $summary,
			'rights_ok'   => 1,
			'status'      => 'draft',
			'track_state' => '',
			'created'     => $now,
			'updated'     => $now,
		] );
		if ( ! $id ) { return Rest::err( 'failed', 'Could not start the track', 500 ); }

		if ( isset( $_FILES['file'] ) && is_uploaded_file( (string) ( $_FILES['file']['tmp_name'] ?? '' ) ) ) {
			$s = self::store_source( $id, $_FILES['file'] );
			if ( $s instanceof \WP_REST_Response ) {
				global $wpdb;
				$wpdb->delete( Data::t( 'aq_tracks' ), [ 'id' => $id ] );
				return $s;
			}
		}
		if ( ! in_array( (string) Rest::p( $req, 'generate', '' ), [ '', '0', 'false' ], true ) ) {
			Data::update( 'aq_tracks', [ 'track_state' => 'queued', 'updated' => Data::now() ], [ 'id' => $id ] );
		}
		return self::detail( self::row( $id ) );
	}

	/** POST music/tracks/{id}/sources (multipart 'file') — attach an inspiration audio track (owner only). */
	public static function add_source( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Track not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your track', 403 ); }
		if ( (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_track_sources' ) . ' WHERE track_id = %d', [ (int) $row['id'] ] ) >= self::MAX_SOURCES ) {
			return Rest::err( 'too_many', 'That is the maximum number of inspiration tracks for one piece' );
		}
		$f = isset( $_FILES['file'] ) ? $_FILES['file'] : null;
		if ( ! $f || ! is_uploaded_file( (string) ( $f['tmp_name'] ?? '' ) ) ) { return Rest::err( 'no_file', 'No file received' ); }
		return self::store_source( (int) $row['id'], $f );
	}

	/** POST music/tracks/{id}/sources/{sid}/delete — remove an inspiration source (owner only). */
	public static function remove_source( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Track not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your track', 403 ); }
		$sid = Rest::pint( $req, 'sid' );
		$src = Data::one( 'SELECT * FROM ' . Data::t( 'aq_track_sources' ) . ' WHERE id = %d AND track_id = %d', [ $sid, (int) $row['id'] ] );
		if ( ! $src ) { return Rest::err( 'not_found', 'Source not found', 404 ); }
		self::unlink_file( (string) $src['file_url'], 'music-sources' );
		global $wpdb;
		$wpdb->delete( Data::t( 'aq_track_sources' ), [ 'id' => $sid ] );
		return [ 'ok' => true ];
	}

	/** POST music/tracks/{id}/generate — (re)queue the AI generation (owner only). */
	public static function generate( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row || $row['status'] === 'removed' ) { return Rest::err( 'not_found', 'Track not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your track', 403 ); }
		if ( $row['status'] === 'published' ) { return Rest::err( 'published', 'This is already published — start a new project instead', 409 ); }
		if ( ( (string) ( $row['kind'] ?? 'music' ) ) === 'audiobook' ) {
			if ( trim( (string) ( $row['manuscript'] ?? '' ) ) === '' ) { return Rest::err( 'no_manuscript', 'Add a manuscript before generating' ); }
		} elseif ( trim( (string) $row['brief'] ) === '' ) { return Rest::err( 'no_brief', 'Add a brief before generating' ); }
		if ( in_array( $row['track_state'], [ 'queued', 'processing' ], true ) ) { return [ 'ok' => true, 'queued' => true ]; }
		// A re-generate starts the adversarial rounds OVER — drop the old attempt's critiques (and their
		// take recordings), or the new attempt's rounds collide with the (track_id, round) idempotency key.
		self::unlink_takes( (int) $row['id'] );
		global $wpdb;
		$wpdb->delete( Data::t( 'aq_track_reviews' ), [ 'track_id' => (int) $row['id'] ] );
		$fields = [ 'track_state' => 'queued', 'claimed_at' => 0, 'round' => 0, 'progress' => '', 'updated' => Data::now() ];
		if ( Rest::p( $req, 'seconds', null ) !== null ) {
			$fields['seconds'] = max( 1, min( self::MAX_SECONDS, (int) Rest::pint( $req, 'seconds', self::DEFAULT_SECS ) ) );
		}
		Data::update( 'aq_tracks', $fields, [ 'id' => (int) $row['id'] ] );
		return [ 'ok' => true, 'queued' => true ];
	}

	/** POST music/tracks/{id}/publish — publish the generated track (owner only). Charges ArtaCoins by the
	 *  requested length, EXACTLY ONCE, via an atomic draft→published claim (no double-charge race). */
	public static function publish_track( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row || $row['status'] === 'removed' ) { return Rest::err( 'not_found', 'Track not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your track', 403 ); }
		if ( (string) $row['audio_url'] === '' ) { return Rest::err( 'no_track', 'The track is not generated yet — please wait for it to finish', 409 ); }
		// A draft may only publish from 'review' — the state whose render matches the priced request
		// (re-queueing with a different length parks publishing until the new render lands).
		if ( $row['status'] === 'draft' && $row['track_state'] !== 'review' ) {
			return Rest::err( 'not_ready', 'The studio is still working on this draft — publish when it is ready to review', 409 );
		}
		$summary = mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'summary', (string) $row['summary'] ) ), 0, 2000 );
		$id   = (int) $row['id'];
		$uid  = (int) $row['author_id'];
		$cost = self::cost_for( $row );
		$ref  = 'track:' . $id;

		if ( $row['status'] === 'draft' ) {
			if ( $err = Challenges::quota_gate( $uid ) ) { return $err; } // shelf quota: prune before publishing more
			// Friendly pre-check only — it keeps the exact figure in the refusal copy. The
			// AUTHORITATIVE check is inside Economy::spend below, which holds this member's
			// wallet lock across the check and the debit together.
			$bal = Economy::coin_balance( $uid );
			if ( $bal < $cost ) {
				$what = ( (string) ( $row['kind'] ?? 'music' ) ) === 'audiobook' ? 'this audiobook' : 'a ' . self::mmss( (int) $row['seconds'] ) . ' track';
				return Rest::err( 'insufficient', 'Publishing ' . $what . ' costs ₳' . $cost . ' — you have ₳' . $bal . '.', 402 );
			}
			// Charge BEFORE claiming the row. Claim-then-charge publishes the work even when the
			// charge is refused, which mints the goods for free.
			$paid = Economy::spend( $uid, $cost, 'music', $ref );
			if ( $paid !== '' ) { return Economy::spend_error( $paid, $cost, 'Publishing this track' ); }
			$claimed = (bool) Data::update( 'aq_tracks', [ 'status' => 'published', 'track_state' => 'live', 'updated' => Data::now() ], [ 'id' => $id, 'status' => 'draft' ] );
			if ( ! $claimed ) {
				// Another request published it first — give the money straight back, append-only.
				Economy::refund_spend( $uid, $cost, 'music-void', $ref );
			}
			if ( $claimed ) {
				Economy::content_points( $uid, $cost, $ref );
				Challenges::enter( ( (string) ( $row['kind'] ?? 'music' ) ) === 'audiobook' ? 'audiobook' : 'music', $id, $uid, $cost ); // fee → the season's challenge pool
			}
		}
		Data::update( 'aq_tracks', [ 'summary' => $summary, 'status' => 'published', 'track_state' => 'live', 'updated' => Data::now() ], [ 'id' => $id ] );
		return self::detail( self::row( $id ) );
	}

	/** GET music/tracks — public keyset list of PUBLISHED tracks (the /music hub). ?kind=music|audiobook. */
	public static function list( $req ) {
		self::ensure_tables();
		$cursor = Rest::pint( $req, 'cursor', 0 );
		$q      = (string) Rest::p( $req, 'q', '' );
		$where  = "status = 'published'";
		$args   = [];
		$kind   = (string) Rest::p( $req, 'kind', '' );
		if ( in_array( $kind, [ 'music', 'audiobook' ], true ) ) { $where .= ' AND kind = %s'; $args[] = $kind; }
		[ $rows, $next ] = Data::search_page( 'aq_tracks', [ 'title', 'summary' ], $q, $where, $args, $cursor, 24 );
		$names = self::author_names( $rows );
		return [ 'items' => array_map( static fn( $r ) => self::card( $r, $names ), $rows ), 'next' => $next ];
	}

	/** GET music/mine — the signed-in member's own music projects (drafts + published). */
	public static function mine( $req ) {
		self::ensure_tables();
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_tracks' ) . " WHERE author_id = %d AND status != 'removed' ORDER BY id DESC LIMIT 100", [ Rest::uid() ] );
		$names = self::author_names( $rows );
		return [ 'items' => array_map( static fn( $r ) => self::card( $r, $names ) + [ 'status' => (string) $r['status'], 'track_state' => (string) $r['track_state'] ], $rows ) ];
	}

	/** GET music/tracks/{id} — player payload. Drafts are owner/operator-only; published tracks are public. */
	public static function get( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row || $row['status'] === 'removed' ) { return Rest::err( 'not_found', 'Track not found', 404 ); }
		if ( $row['status'] !== 'published' && ! self::can_edit( $row ) ) { return Rest::err( 'not_found', 'Track not found', 404 ); }
		if ( $row['status'] === 'published' ) { Data::bump( 'aq_tracks', [ 'id' => (int) $row['id'] ], 'play_count', 1 ); }
		return self::detail( $row );
	}

	/** POST music/tracks/{id}/delete — owner or operator takedown (removes the row + all source files + the track). */
	public static function remove( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Track not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your track', 403 ); }
		foreach ( Data::all( 'SELECT file_url FROM ' . Data::t( 'aq_track_sources' ) . ' WHERE track_id = %d', [ (int) $row['id'] ] ) as $s ) {
			self::unlink_file( (string) $s['file_url'], 'music-sources' );
		}
		self::unlink_file( (string) $row['audio_url'], 'music' );
		self::unlink_takes( (int) $row['id'] );
		global $wpdb;
		$wpdb->delete( Data::t( 'aq_track_sources' ), [ 'track_id' => (int) $row['id'] ] );
		$wpdb->delete( Data::t( 'aq_track_reviews' ), [ 'track_id' => (int) $row['id'] ] );
		// track_state '' also cuts off a relay mid-render (heartbeat/review/complete all gate on 'processing').
		Data::update( 'aq_tracks', [ 'status' => 'removed', 'track_state' => '', 'audio_url' => '', 'updated' => Data::now() ], [ 'id' => (int) $row['id'] ] );
		return [ 'ok' => true ];
	}

	// ── ArtaSound relay (auth: 'worker') — the brief→original-track generation ───────────────────────

	/** POST relay/track/poll — claim the oldest queued project (or resume a claimed one this relay is
	 *  mid-way through: `resume_id`). Returns the brief + inspiration (+ audiobook segments + prior
	 *  adversarial rounds, so the improving relay picks up where it left off across chunk ticks). */
	public static function track_poll( $req ) {
		self::ensure_tables();
		set_transient( 'aq_music_beat', time(), 300 );
		global $wpdb;
		if ( ! get_transient( 'aq_music_reclaim' ) ) {
			set_transient( 'aq_music_reclaim', 1, 60 );
			// A chunked relay heartbeats every tick; anything silent for 30 min is orphaned → re-queue.
			$wpdb->query( $wpdb->prepare(
				'UPDATE ' . Data::t( 'aq_tracks' ) . " SET track_state = 'queued' WHERE track_state = 'processing' AND updated < %d",
				Data::now() - 1800 ) );
		}
		// The chunked relay resumes ITS OWN in-flight job first (work dir persists across ticks).
		$resume = (int) Rest::pint( $req, 'resume_id', 0 );
		$row    = $resume ? Data::one( 'SELECT * FROM ' . Data::t( 'aq_tracks' ) . " WHERE id = %d AND track_state = 'processing' AND status != 'removed'", [ $resume ] ) : null;
		if ( ! $row ) {
			$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_tracks' ) . " WHERE track_state = 'queued' AND status != 'removed' ORDER BY id ASC LIMIT 1" );
			if ( ! $row ) { return [ 'job' => null ]; }
			$got = Data::update( 'aq_tracks', [ 'track_state' => 'processing', 'claimed_at' => Data::now(), 'updated' => Data::now() ], [ 'id' => (int) $row['id'], 'track_state' => 'queued' ] );
			if ( ! $got ) { return [ 'job' => null ]; }
		} else {
			Data::update( 'aq_tracks', [ 'updated' => Data::now() ], [ 'id' => (int) $row['id'] ] );
		}
		$sources = array_map( static fn( $s ) => [
			'title'    => (string) $s['title'],
			'file_url' => (string) $s['file_url'], // the daemon fetches the inspiration audio itself
		], Data::all( 'SELECT * FROM ' . Data::t( 'aq_track_sources' ) . ' WHERE track_id = %d ORDER BY id ASC', [ (int) $row['id'] ] ) );
		$kind = (string) ( $row['kind'] ?? 'music' ) === 'audiobook' ? 'audiobook' : 'music';
		$job  = [
			'id'         => (int) $row['id'],
			'kind'       => $kind,
			'title'      => (string) $row['title'],
			'brief'      => (string) $row['brief'],
			'seconds'    => (int) $row['seconds'],
			'round'      => (int) ( $row['round'] ?? 0 ),
			'max_rounds' => self::MAX_ROUNDS,
			'sources'    => $sources,
			// Prior adversarial rounds → the next round improves on them (the ArtaScience pattern).
			'reviews'    => array_map( static fn( $v ) => [
				'round'   => (int) $v['round'],
				'verdict' => (string) $v['verdict'],
				'score'   => (int) $v['score'],
				'report'  => mb_substr( (string) $v['report'], 0, 4000 ),
			], Data::all( 'SELECT round, verdict, score, report FROM ' . Data::t( 'aq_track_reviews' ) . ' WHERE track_id = %d ORDER BY round ASC', [ (int) $row['id'] ] ) ),
		];
		if ( $kind === 'audiobook' ) {
			$job['voice']    = (string) ( $row['voice'] ?? '' );
			$job['segments'] = self::manuscript_segments( (string) ( $row['manuscript'] ?? '' ) );
		}
		return [ 'job' => $job ];
	}

	/** POST relay/track/heartbeat — keep a claimed job alive between chunk ticks (+ a progress note the
	 *  author sees live on the Listen page, e.g. "Narrated 240 of 1,032 sentences" / "Round 2 of 3"). */
	public static function track_heartbeat( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row || $row['track_state'] !== 'processing' ) { return [ 'ok' => true, 'ignored' => true ]; }
		$fields = [ 'claimed_at' => Data::now(), 'updated' => Data::now() ];
		if ( Rest::p( $req, 'progress', null ) !== null ) {
			$fields['progress'] = mb_substr( sanitize_text_field( (string) Rest::p( $req, 'progress', '' ) ), 0, 255 );
		}
		Data::update( 'aq_tracks', $fields, [ 'id' => (int) $row['id'] ] );
		return [ 'ok' => true ];
	}

	/** POST relay/track/review — record ONE adversarial improvement round (the ArtaScience pattern):
	 *  the AI critic's verdict + 0-100 score + axis scores + full report + THAT ROUND'S RECORDING
	 *  (audio_b64 → a playable take) + its objective measurements. Idempotent per (track, round).
	 *  The rounds are public on the published track — every attempt is audible, not just described. */
	public static function track_review( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Track not found', 404 ); }
		if ( $row['track_state'] !== 'processing' ) { return [ 'ok' => true, 'ignored' => true ]; }
		$round = max( 1, min( self::MAX_ROUNDS, (int) Rest::pint( $req, 'round', (int) ( $row['round'] ?? 0 ) + 1 ) ) );
		if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_track_reviews' ) . ' WHERE track_id = %d AND round = %d LIMIT 1', [ (int) $row['id'], $round ] ) ) {
			return [ 'ok' => true, 'ignored' => true ];
		}
		$verdict = in_array( (string) Rest::p( $req, 'verdict', '' ), [ 'approve', 'revise' ], true ) ? (string) Rest::p( $req, 'verdict', '' ) : 'revise';
		$scores  = Data::dec( (string) Rest::p( $req, 'scores', '' ) );
		$metrics = Data::dec( (string) Rest::p( $req, 'metrics', '' ) );
		// This round's take, saved under a distinct name so every attempt stays playable alongside the final.
		$mime = mb_substr( sanitize_text_field( (string) Rest::p( $req, 'mime', 'audio/mpeg' ) ), 0, 40 );
		if ( ! isset( self::OUT_EXT[ strtolower( $mime ) ] ) ) { $mime = 'audio/mpeg'; }
		$take_url = self::save_audio( (int) $row['id'], (string) Rest::p( $req, 'audio_b64', '' ), $mime, 60, 'take-' . (int) $row['id'] . '-r' . $round );
		$ins = Data::insert( 'aq_track_reviews', [
			'track_id'  => (int) $row['id'],
			'round'     => $round,
			'verdict'   => $verdict,
			'score'     => max( 0, min( 100, (int) Rest::pint( $req, 'score', 0 ) ) ),
			'scores'    => is_array( $scores ) ? Data::enc( $scores ) : null,
			'report'    => mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'report', '' ) ), 0, 16000 ), // TEXT holds 64KB BYTES — 16k chars × 4-byte UTF-8 still fits
			'audio_url' => $take_url,
			'metrics'   => is_array( $metrics ) ? Data::enc( $metrics ) : null,
			'model'     => mb_substr( sanitize_text_field( (string) Rest::p( $req, 'model', '' ) ), 0, 64 ),
			'created'   => Data::now(),
		] );
		if ( ! $ins ) {
			// Lost a concurrent duplicate-round race (uniq_round) — this request's file must not orphan.
			if ( $take_url !== '' ) { self::unlink_file( $take_url, 'music' ); }
			return [ 'ok' => true, 'ignored' => true ];
		}
		// The track can be deleted between our state check and here — a removed track must not keep a
		// fresh take file + review row nothing will ever sweep (remove() has already run unlink_takes).
		if ( (string) Data::col( 'SELECT track_state FROM ' . Data::t( 'aq_tracks' ) . ' WHERE id = %d', [ (int) $row['id'] ] ) !== 'processing' ) {
			global $wpdb;
			$wpdb->delete( Data::t( 'aq_track_reviews' ), [ 'id' => (int) $ins ] );
			if ( $take_url !== '' ) { self::unlink_file( $take_url, 'music' ); }
			return [ 'ok' => true, 'ignored' => true ];
		}
		Data::update( 'aq_tracks', [ 'round' => $round, 'claimed_at' => Data::now(), 'updated' => Data::now() ], [ 'id' => (int) $row['id'] ] );
		return [ 'ok' => true, 'round' => $round ];
	}

	/** GET music/studio — the public transparency pulse for /artasound (the ArtaScience-status pattern):
	 *  is the studio online, how deep is the queue, and how hard is the critic working. */
	public static function studio_status( $req = null ) {
		self::ensure_tables();
		$counts = [ 'queued' => 0, 'processing' => 0, 'review' => 0 ];
		foreach ( Data::all( 'SELECT track_state, COUNT(*) n FROM ' . Data::t( 'aq_tracks' ) . " WHERE status != 'removed' AND track_state IN ('queued','processing','review') GROUP BY track_state" ) as $r ) {
			$counts[ (string) $r['track_state'] ] = (int) $r['n'];
		}
		return [
			'online'      => (bool) get_transient( 'aq_music_beat' ),
			'queued'      => $counts['queued'],
			'processing'  => $counts['processing'],
			'in_review'   => $counts['review'],
			'published'   => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_tracks' ) . " WHERE status = 'published'" ),
			'audiobooks'  => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_tracks' ) . " WHERE status = 'published' AND kind = 'audiobook'" ),
			'rounds_24h'  => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_track_reviews' ) . ' WHERE created > %d', [ Data::now() - 86400 ] ),
			'rounds_total' => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_track_reviews' ) ),
			'max_rounds'  => self::MAX_ROUNDS,
			'model'       => 'claude-opus-5',
		];
	}

	/** POST relay/track/complete — the daemon returns the generated audio (base64) + mime (+ optional cover
	 *  + audiobook per-sentence timings). Lands in 'review' for the author (we never auto-publish). */
	public static function track_complete( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Track not found', 404 ); }
		if ( $row['track_state'] !== 'processing' ) { return [ 'ok' => true, 'ignored' => true ]; }
		$kind   = (string) ( $row['kind'] ?? 'music' ) === 'audiobook' ? 'audiobook' : 'music';
		$mime   = mb_substr( sanitize_text_field( (string) Rest::p( $req, 'mime', 'audio/mpeg' ) ), 0, 40 ); // VARCHAR(40) — an over-long mime must not fail the guarded update
		if ( ! isset( self::OUT_EXT[ strtolower( $mime ) ] ) ) { $mime = 'audio/mpeg'; }
		$b64    = (string) Rest::p( $req, 'audio_b64', '' );
		$cover  = esc_url_raw( (string) Rest::p( $req, 'cover', '' ) );
		// AI cover art rendered by the relay (coverart.py → free HF image Space), sent as base64.
		$cover_b64 = (string) Rest::p( $req, 'cover_b64', '' );
		if ( $cover_b64 !== '' ) { $saved = self::save_image( (int) $row['id'], $cover_b64 ); if ( $saved !== '' ) { $cover = $saved; } }
		$lyrics = mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'lyrics', '' ) ), 0, 8000 ); // Claude-written lyric sheet
		$url    = self::save_audio( (int) $row['id'], $b64, $mime, $kind === 'audiobook' ? 120 : 60 );
		if ( $url !== '' && (string) $row['audio_url'] !== '' ) { self::unlink_file( (string) $row['audio_url'], 'music' ); } // recompose replaces the old file
		if ( $url === '' ) {
			Data::update( 'aq_tracks', [ 'track_state' => 'failed', 'progress' => '', 'updated' => Data::now() ], [ 'id' => (int) $row['id'], 'track_state' => 'processing' ] );
			return Rest::err( 'empty_track', 'No usable audio received', 400 );
		}
		$fields = [
			'audio_url'   => $url,
			'audio_mime'  => $mime,
			'cover'       => $cover !== '' ? mb_substr( $cover, 0, 600 ) : (string) $row['cover'],
			'lyrics'      => $lyrics !== '' ? $lyrics : (string) ( $row['lyrics'] ?? '' ),
			'track_state' => 'review',
			'progress'    => '',
			'updated'     => Data::now(),
		];
		// Audiobook: exact per-sentence timings (the read-along follower) + the REAL duration.
		$timings = Data::dec( (string) Rest::p( $req, 'timings', '' ) );
		if ( $kind === 'audiobook' && is_array( $timings ) && ! empty( $timings['segments'] ) ) {
			$fields['segments'] = Data::enc( $timings['segments'] );
			$fields['seconds']  = max( 1, (int) round( (float) ( $timings['total'] ?? 0 ) ) );
		}
		$wrote = (bool) Data::update( 'aq_tracks', $fields, [ 'id' => (int) $row['id'], 'track_state' => 'processing' ] );
		if ( ! $wrote ) { return [ 'ok' => true, 'ignored' => true ]; }
		Notify::push( (int) $row['author_id'], 'music',
			$kind === 'audiobook' ? 'Your audiobook is ready to review' : 'Your track is ready to review',
			'Your draft of “' . (string) $row['title'] . '” is ready — listen and publish.',
			'/listen/' . (int) $row['id'] . '/', 'track-ready:' . (int) $row['id'] );
		return [ 'ok' => true ];
	}

	// ── shaping ─────────────────────────────────────────────────────────────────────

	private static function card( $row, $names = null ) {
		$aid  = (int) $row['author_id'];
		$name = is_array( $names ) ? (string) ( $names[ $aid ]['name'] ?? '' ) : '';
		$slug = is_array( $names ) ? (string) ( $names[ $aid ]['slug'] ?? '' ) : '';
		return [
			'id'       => (int) $row['id'],
			'slug'     => (string) $row['slug'],
			'title'    => (string) $row['title'],
			'kind'     => (string) ( $row['kind'] ?? 'music' ) === 'audiobook' ? 'audiobook' : 'music',
			'summary'  => mb_substr( (string) $row['summary'], 0, 220 ),
			'cover'    => (string) $row['cover'],
			'seconds'  => (int) $row['seconds'],
			'length'   => self::mmss( (int) $row['seconds'] ),
			'plays'    => (int) $row['play_count'],
			'author'   => $aid ? [ 'id' => $aid, 'name' => $name, 'slug' => $slug ] : null,
			'created'  => (int) $row['created'],
		];
	}

	private static function detail( $row ) {
		$card = self::card( $row, self::author_names( [ $row ] ) );
		$mine = self::can_edit( $row );
		$pub  = $row['status'] === 'published';
		$out  = $card + [
			'status'      => (string) $row['status'],
			'track_state' => (string) $row['track_state'],
			'round'       => (int) ( $row['round'] ?? 0 ),
			'progress'    => (string) ( $row['progress'] ?? '' ),
			'audio_url'   => ( $pub || $mine ) ? (string) $row['audio_url'] : '',
			'audio_mime'  => (string) $row['audio_mime'],
			'lyrics'      => (string) ( $row['lyrics'] ?? '' ), // the Claude-written lyric sheet (public on a published track)
			'is_owner'    => $mine,
		];
		if ( $card['kind'] === 'audiobook' ) {
			$out['voice'] = (string) ( $row['voice'] ?? '' );
			// The narrated text is the author's own published work here — public once the audiobook is.
			if ( $pub || $mine ) { $out['manuscript'] = (string) ( $row['manuscript'] ?? '' ); }
		}
		// The adversarial improvement rounds — public on published work (ArtaScience-style transparency),
		// each with its own playable take recording + the critic's objective measurements.
		if ( $pub || $mine ) {
			$out['reviews'] = array_map( static fn( $v ) => [
				'round'     => (int) $v['round'],
				'verdict'   => (string) $v['verdict'],
				'score'     => (int) $v['score'],
				'scores'    => Data::dec( (string) ( $v['scores'] ?? '' ) ),
				'report'    => (string) $v['report'],
				'audio_url' => (string) ( $v['audio_url'] ?? '' ),
				'metrics'   => Data::dec( (string) ( $v['metrics'] ?? '' ) ),
				'model'     => (string) $v['model'],
				'created'   => (int) $v['created'],
			], Data::all( 'SELECT * FROM ' . Data::t( 'aq_track_reviews' ) . ' WHERE track_id = %d ORDER BY round ASC', [ (int) $row['id'] ] ) );
		}
		if ( $mine ) {
			$out['brief'] = (string) $row['brief'];
			$out['cost']  = self::cost_for( $row );
			$out['paid']  = $pub || (bool) Data::col(
				'SELECT 1 FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'music' AND ref = %s LIMIT 1", [ 'track:' . (int) $row['id'] ] );
			$out['sources'] = array_map( static fn( $s ) => [
				'id'    => (int) $s['id'],
				'title' => (string) $s['title'],
				'url'   => (string) $s['file_url'],
			], Data::all( 'SELECT id, title, file_url FROM ' . Data::t( 'aq_track_sources' ) . ' WHERE track_id = %d ORDER BY id ASC', [ (int) $row['id'] ] ) );
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

	/** Store one inspiration audio file → an aq_track_sources card, or a WP_REST_Response error. */
	private static function store_source( $track_id, $f ) {
		$size = (int) ( $f['size'] ?? 0 );
		if ( $size <= 0 ) { return Rest::err( 'empty', 'The file is empty' ); }
		if ( $size > 40 * 1024 * 1024 ) { return Rest::err( 'too_big', 'Audio exceeds 40 MB' ); }
		$name = sanitize_file_name( (string) ( $f['name'] ?? 'track.mp3' ) );
		$ext  = strtolower( pathinfo( $name, PATHINFO_EXTENSION ) );
		if ( ! in_array( $ext, self::SOURCE_EXTS, true ) ) { return Rest::err( 'bad_type', 'Inspiration must be an audio file (mp3, wav, m4a, aac, ogg, flac)' ); }
		if ( ! self::looks_like_audio( (string) $f['tmp_name'], $ext ) ) { return Rest::err( 'bad_type', 'That file is not valid audio' ); }
		$up = wp_upload_dir();
		if ( ! empty( $up['error'] ) ) { return Rest::err( 'failed', 'Upload directory unavailable', 500 ); }
		$dir = $up['basedir'] . '/music-sources';
		if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		$fname = wp_unique_filename( $dir, bin2hex( random_bytes( 16 ) ) . '.' . $ext ); // random, unguessable (source is private)
		$dest  = $dir . '/' . $fname;
		if ( ! @move_uploaded_file( (string) $f['tmp_name'], $dest ) ) { return Rest::err( 'failed', 'Could not store the file', 500 ); }
		@chmod( $dest, 0644 );
		$title = mb_substr( (string) preg_replace( '/\.[a-z0-9]+$/i', '', $name ), 0, 255 );
		$sid   = Data::insert( 'aq_track_sources', [
			'track_id'  => (int) $track_id,
			'title'     => $title,
			'file_url'  => $up['baseurl'] . '/music-sources/' . $fname,
			'file_size' => $size,
			'created'   => Data::now(),
		] );
		return [ 'id' => (int) $sid, 'title' => $title ];
	}

	/** Best-effort audio magic-byte sniff (the "is it real audio" gate). */
	private static function looks_like_audio( $path, $ext ) {
		$h = (string) @file_get_contents( $path, false, null, 0, 16 );
		if ( $h === '' ) { return false; }
		if ( strncmp( $h, 'ID3', 3 ) === 0 ) { return true; }                       // mp3 with ID3
		if ( ( ord( $h[0] ) === 0xFF ) && ( ( ord( $h[1] ) & 0xE0 ) === 0xE0 ) ) { return true; } // mp3/aac frame sync
		if ( strncmp( $h, 'RIFF', 4 ) === 0 ) { return true; }                      // wav
		if ( strncmp( $h, 'OggS', 4 ) === 0 ) { return true; }                      // ogg/oga
		if ( strncmp( $h, 'fLaC', 4 ) === 0 ) { return true; }                      // flac
		if ( substr( $h, 4, 4 ) === 'ftyp' ) { return true; }                       // m4a/aac/mp4
		return in_array( $ext, [ 'aac' ], true );                                    // raw AAC has no reliable magic
	}

	/** Save base64 audio from the daemon → uploads/music/track-<id>-<random>.<ext> → its URL. '' on any
	 *  problem. The random component keeps UNPUBLISHED drafts (a whole audiobook of an unpublished
	 *  manuscript) from being fetchable by guessing sequential ids — the URL is only revealed through
	 *  the owner-gated detail(). Audiobooks run long — they get the Narrate-sized cap. */
	private static function save_audio( $id, $b64, $mime, $max = 60, $prefix = '' ) {
		$b64 = (string) $b64;
		if ( $b64 === '' ) { return ''; }
		$bytes = (string) base64_decode( $b64, true );
		if ( strlen( $bytes ) < 256 || strlen( $bytes ) > $max * 1024 * 1024 ) { return ''; }
		$ext = self::OUT_EXT[ strtolower( (string) $mime ) ] ?? 'mp3';
		$up  = wp_upload_dir();
		if ( ! empty( $up['error'] ) ) { return ''; }
		$dir = $up['basedir'] . '/music';
		if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		$name = ( $prefix !== '' ? $prefix : 'track-' . (int) $id ) . '-' . bin2hex( random_bytes( 8 ) ) . '.' . $ext;
		if ( file_put_contents( $dir . '/' . $name, $bytes ) === false ) { return ''; }
		@chmod( $dir . '/' . $name, 0644 );
		return $up['baseurl'] . '/music/' . $name;
	}

	/** Unlink every stored round-take recording for a track (delete + re-generate both call this). */
	private static function unlink_takes( $track_id ) {
		foreach ( Data::all( 'SELECT audio_url FROM ' . Data::t( 'aq_track_reviews' ) . " WHERE track_id = %d AND audio_url != ''", [ (int) $track_id ] ) as $r ) {
			self::unlink_file( (string) $r['audio_url'], 'music' );
		}
	}

	/** Save an AI-generated cover image (base64, jpg/png/webp) → its public URL, or '' on failure. */
	private static function save_image( $id, $b64 ) {
		$bytes = (string) base64_decode( (string) $b64, true );
		if ( strlen( $bytes ) < 256 || strlen( $bytes ) > 12 * 1024 * 1024 ) { return ''; }
		$sig = substr( $bytes, 0, 4 );
		$ext = ( "\xFF\xD8\xFF" === substr( $sig, 0, 3 ) ) ? 'jpg' : ( ( "\x89PNG" === $sig ) ? 'png' : ( 'RIFF' === $sig ? 'webp' : '' ) );
		if ( $ext === '' ) { return ''; }
		$up = wp_upload_dir();
		if ( ! empty( $up['error'] ) ) { return ''; }
		$dir = $up['basedir'] . '/music';
		if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		$dest = $dir . '/track-' . (int) $id . '-cover.' . $ext;
		if ( file_put_contents( $dest, $bytes ) === false ) { return ''; }
		@chmod( $dest, 0644 );
		return $up['baseurl'] . '/music/track-' . (int) $id . '-cover.' . $ext;
	}

	private static function row( $id ) {
		return $id ? Data::one( 'SELECT * FROM ' . Data::t( 'aq_tracks' ) . ' WHERE id = %d', [ (int) $id ] ) : null;
	}

	private static function can_edit( $row ) {
		$uid = Rest::uid();
		return $uid && ( $uid === (int) $row['author_id'] || current_user_can( 'manage_options' ) );
	}

	/** An Edge-TTS voice id like `en-US-AndrewNeural` / `fr-FR-DeniseNeural` (same rule as Narrate). */
	private static function valid_voice( $v ) { return (bool) preg_match( '/^[a-z]{2,3}-[A-Za-z0-9]+(-[A-Za-z0-9]+)*Neural$/', (string) $v ); }

	/**
	 * Audiobook read-along segments — ONE PER SENTENCE of the plain-text manuscript, in order (the same
	 * sentence rule as Narrate::segments so the reader's follower aligns). Paragraphs split on newlines;
	 * each paragraph's collapsed text splits on sentence-ending punctuation + whitespace.
	 */
	public static function manuscript_segments( $text ) {
		$out = [];
		foreach ( preg_split( '/\n+/u', (string) $text ) ?: [] as $block ) {
			$tx = trim( (string) preg_replace( '/\s+/u', ' ', $block ) );
			if ( $tx === '' ) { continue; }
			$sents = preg_split( '/(?<=[.!?。！？…])\s+/u', $tx, -1, PREG_SPLIT_NO_EMPTY ) ?: [ $tx ];
			foreach ( $sents as $s ) { $s = trim( $s ); if ( $s !== '' ) { $out[] = $s; } }
		}
		return $out;
	}

	private static function unique_slug( $title ) {
		$base = substr( sanitize_title( $title ) ?: 'track', 0, 180 );
		$slug = $base;
		$n    = 2;
		while ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_tracks' ) . ' WHERE slug = %s LIMIT 1', [ $slug ] ) ) {
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

	/** Seconds → m:ss. */
	private static function mmss( $s ) {
		$s = max( 0, (int) $s );
		return intdiv( $s, 60 ) . ':' . str_pad( (string) ( $s % 60 ), 2, '0', STR_PAD_LEFT );
	}
}
