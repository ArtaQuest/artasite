<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Offline / "take it with you" export layer.
 *
 * Everything ArtaQuest serves online is also packageable for fully-offline use — built for
 * learners on weak, censored, or absent connectivity (Iran, rural networks, …). The whole
 * platform is selectively downloadable: pick the courses you want, the website language + the
 * caption language, and the video quality; the bundle then renders + plays identically offline.
 * The only things that need the network are the social acts: posting comments, voting, and
 * competing — everything else (watching, reading, transcripts, the public database) works offline.
 *
 * Design: the bundles are pure reads built by reusing the SAME handlers the live routes use, so
 * the offline JSON is byte-for-byte the shape the SPA already consumes. The frontend stores each
 * `path → json` and transparently serves it from IndexedDB when offline. No schema change — this
 * is a read-only projection over existing tables. Media (video bytes) + captions are best-effort
 * over YouTube; when a video can't be resolved the course still downloads as text + transcript.
 */
final class Offline {

	/** How long the mirrored yt-dlp binary is reused before re-fetching (it is immutable per version). */
	const YTDLP_CACHE_S = 43200; // 12h

	/** YouTube progressive (muxed audio+video) itags → human quality label. These are the formats
	 *  that come as a single downloadable file the browser can store and a <video> can play. */
	const ITAG_LABELS = [
		17  => '144p', 36 => '240p', 18 => '360p', 22 => '720p', 59 => '480p', 78 => '480p',
	];

	/** Upper bound on the size of a progressive video we will OFFER for in-browser download. The browser
	 *  fetches it from {@see media_stream} in modest ranged chunks (see lib/offline/store downloadMediaBlob),
	 *  so a large total no longer ties up the worker in one long request — this ceiling now only keeps us
	 *  from offering a file too big for a phone to store. Hour-long lectures at 360p/720p sit under it; the
	 *  old 350 MB cap silently stripped every quality above 144p from exactly those videos (ticket #25). */
	const MAX_MEDIA_BYTES = 1536 * 1024 * 1024; // 1.5 GB

	// ───────────────────────────────────────────────────────────────────────────
	// GET offline/manifest — the Download Center catalogue: courses, languages, DB tables.
	// ───────────────────────────────────────────────────────────────────────────
	public static function manifest( $req ) {
		// NOTE: the course catalogue is intentionally NOT returned here — it scales to millions, so the
		// Download Center discovers courses through the keyset-paginated, searchable /courses endpoint
		// (topic chips set the search), never a bulk list. The manifest carries only the small, finite
		// facets: languages and the public-DB table list. `course_count` is just a headline number.
		$course_count = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_courses' ) . " WHERE status = 'publish'" );

		// Languages: the full registry + how many strings are already cached per language (≈ pack size).
		// Cached rather than throttled: the cost is a COMPUTATION, and a throttle would answer a
		// legitimate visitor with an error to protect us from an illegitimate one. Note what this
		// does and does not buy — there is no single-flight guard, so a burst arriving while the
		// entry is cold will each run the GROUP BY; it bounds the STEADY rate, not a thundering
		// herd. That is acceptable here (one grouped scan of an indexed column, versus the
		// per-table sweep removed below) and would not have been for that one.
		// An empty result is never cached: `[]` is a plausible failure and caching it would serve
		// "no languages" to everyone for the full window.
		$counts = get_transient( 'aq_offline_langcounts' );
		if ( ! is_array( $counts ) || ! $counts ) {
			$counts = [];
			foreach ( Data::all( 'SELECT lang, COUNT(*) n FROM ' . Data::t( 'aq_translations' ) . ' GROUP BY lang' ) as $r ) {
				$counts[ (string) $r['lang'] ] = (int) $r['n'];
			}
			if ( $counts ) { set_transient( 'aq_offline_langcounts', $counts, 5 * MINUTE_IN_SECONDS ); }
		}
		$langs = [];
		foreach ( I18n::config( $req )['languages'] as $l ) {
			$langs[] = [
				'code'    => $l['code'],
				'name'    => $l['name'],
				'native'  => $l['native'],
				'rtl'     => $l['rtl'],
				'strings' => $l['code'] === 'en' ? 0 : ( $counts[ $l['code'] ] ?? 0 ),
			];
		}

		// Public database tables (the radical-transparency explorer), with row counts.
		// This used to run one COUNT(*) per table across the whole public schema (~103 tables) on
		// every unauthenticated request. A cache would only have moved that cost to whichever
		// requests happened to arrive cold — and with no single-flight guard, a burst arriving at
		// expiry would each start their own full sweep. So the scan is REMOVED rather than
		// amortised, using the same two lines the public explorer already uses for this identical
		// list (Extra::db): one information_schema read for the whole schema, then an exact COUNT
		// only where the engine's estimate is 0 — empty, stats-cold, or the dev integration, all
		// of which are cheap to count precisely because there is nothing there.
		//
		// What this buys, stated honestly: the work stops scaling with the SIZE of the database and
		// starts scaling with the NUMBER of tables. It does not become a single query. The number
		// is a catalogue headline ("how big is this table"), so an engine estimate is the right
		// precision — the UI marks it approximate, and the exporter counts real rows as it pages.
		global $wpdb;
		$approx = Extra::approx_rows_map();
		$tables = [];
		foreach ( Extra::all_table_names() as $name ) {
			$tables[] = [
				'name'  => $name,
				'label' => Extra::humanize( $name ),
				'rows'  => empty( $approx[ $name ] ) ? (int) $wpdb->get_var( "SELECT COUNT(*) FROM `$name`" ) : (int) $approx[ $name ],
			];
		}

		return [
			'v'            => 1,
			'site'         => get_bloginfo( 'name' ),
			'course_count' => $course_count,
			'languages'    => $langs,
			'tables'       => $tables,
			'note'         => 'Pick what you need: courses (search or by topic), a website language + a caption language, and a video quality. Everything works offline except posting, voting, and competing.',
		];
	}

	// ───────────────────────────────────────────────────────────────────────────
	// GET offline/course/{id} — a complete, self-contained course bundle.
	// A map of `path → json` mirroring every live endpoint the SPA hits to render the course
	// and all its lessons + boards (read-only), plus a per-video catalogue (transcript + the
	// media/caption resolve hints). Stored client-side; served from IndexedDB when offline.
	// ───────────────────────────────────────────────────────────────────────────
	public static function course( $req ) {
		$id = Rest::pint( $req, 'id' );
		$c  = Data::one( 'SELECT * FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $c ) { return Rest::err( 'not_found', 'Course not found', 404 ); }
		$slug = (string) $c['slug'];

		$paths = [];
		// Course detail (by id AND by slug — the SPA fetches both shapes on different routes).
		$detail = self::call( 'Courses::get', [ 'id' => $id ] );
		self::unlock_course( $detail );
		$paths[ "courses/$id" ]          = $detail;
		$paths[ "courses/slug/$slug" ]   = $detail;
		$paths[ "courses/$id/reviews" ]  = self::call( 'Courses::reviews', [ 'id' => $id ] );
		$paths[ "courses/$id/rankings" ] = self::call( 'Learn::course_rankings', [ 'id' => $id ] );
		$paths[ "courses/$id/stats" ]    = self::call( 'YouTube::course_stats', [ 'id' => $id, 'days' => 365 ] );

		// The course's Discussion tab — global threads tagged with this course's topic — plus every
		// thread's own page (with its comments), so the members' conversation travels with the course.
		// Keyed WITH the query string (lib/offline/fetch matches an exact path?query first, then the
		// bare path), because the bare "threads" path is the global discussions list, not this course's.
		$topic  = 'course-' . $id;
		$tlist  = self::call( 'Social::threads', [ 'topic' => $topic, 'limit' => 50 ] );
		$paths[ "threads?topic=$topic" ] = $tlist;
		foreach ( ( is_array( $tlist ) ? ( $tlist['items'] ?? [] ) : [] ) as $t ) {
			$tid = (int) ( $t['id'] ?? 0 );
			if ( $tid ) { $paths[ "threads/$tid" ] = self::call( 'Social::thread', [ 'id' => $tid ] ); }
		}

		$lessons = Data::all(
			'SELECT id, idx, title, duration, video_type, video, seg_start, seg_end, transcript
			   FROM ' . Data::t( 'aq_lessons' ) . ' WHERE course_id = %d ORDER BY idx ASC',
			[ $id ]
		);
		$videos = [];
		$seen_vid = [];
		foreach ( $lessons as $l ) {
			$lid = (int) $l['id'];
			$vid = (string) $l['video'];
			// Per-lesson endpoint (the player payload) — unlocked for offline (no server to gate).
			$lp = self::call( 'Courses::lesson', [ 'id' => $lid ] );
			if ( is_array( $lp ) ) { $lp['locked'] = false; }
			$paths[ "lessons/$lid" ] = $lp;
			// The section discussion board snapshot (read-only offline; posting needs the network).
			$paths[ "sections/$lid/thread" ] = self::call( 'Learn::section_thread', [ 'lesson_id' => $lid, 'sort' => 'top' ] );
			// Per-video view-history (sparkline) keyed by the SPA's own path.
			if ( $vid !== '' && empty( $seen_vid[ $vid ] ) ) {
				$seen_vid[ $vid ]               = true;
				$paths[ "videos/$vid/stats" ]   = self::call( 'YouTube::stats', [ 'vid' => $vid, 'days' => 90 ] );
			}
			$videos[] = [
				'lesson_id'  => $lid,
				'idx'        => (int) $l['idx'],
				'title'      => (string) $l['title'],
				'vid'        => $vid,
				'provider'   => (string) $l['video_type'],
				'seg_start'  => (int) $l['seg_start'],
				'seg_end'    => (int) $l['seg_end'],
				'transcript' => (string) ( $l['transcript'] ?? '' ),
			];
		}

		return [
			'v'        => 1,
			'id'       => $id,
			'slug'     => $slug,
			'title'    => (string) $c['title'],
			'image'    => (string) $c['image'],
			'lessons'  => count( $lessons ),
			'paths'    => $paths ?: (object) [],
			'videos'   => $videos,
			'built_at' => time(),
		];
	}

	// ───────────────────────────────────────────────────────────────────────────
	// GET offline/langpack/{lang}?cursor= — bulk export of a language's cached translations.
	// Keyset by row id so the client can stream a whole pack in chunks. { items:{src:tgt}, next }.
	// ───────────────────────────────────────────────────────────────────────────
	public static function langpack( $req ) {
		$lang = strtolower( trim( (string) Rest::p( $req, 'lang', '' ) ) );
		if ( $lang === '' || $lang === 'en' || ! I18n::is_locale( $lang ) ) {
			return [ 'lang' => $lang, 'items' => (object) [], 'next' => null ];
		}
		$cursor = Rest::pint( $req, 'cursor', 0 );
		$limit  = min( 4000, max( 100, Rest::pint( $req, 'limit', 2000 ) ) );
		$rows = Data::all(
			'SELECT id, source_text, translated_text FROM ' . Data::t( 'aq_translations' ) . '
			  WHERE lang = %s AND id > %d ORDER BY id ASC LIMIT %d',
			[ $lang, $cursor, $limit ]
		);
		$items = [];
		$last  = $cursor;
		foreach ( $rows as $r ) {
			$src = (string) $r['source_text'];
			$tgt = (string) $r['translated_text'];
			if ( $src !== '' && $tgt !== '' ) { $items[ $src ] = $tgt; }
			$last = (int) $r['id'];
		}
		return [
			'lang'  => $lang,
			'epoch' => Translate::epoch( $lang ), // stamped client-side so the epoch check never wipes a fresh pack
			'items' => $items ?: (object) [],
			'next'  => count( $rows ) >= $limit ? $last : null,
		];
	}

	// ───────────────────────────────────────────────────────────────────────────
	// GET offline/db/{table}?cursor= — bulk export of one public table (radical transparency),
	// keyset-paginated in large chunks (the explorer's 25-row pages are too small for a snapshot).
	//
	// THE SAME redaction as the live explorer, by CALLING it (Extra::redact_row) rather than
	// re-implementing it. This route is public and returns thousands of rows at a time, so it is the
	// widest pipe out of the database we have: any credential the explorer masks and this one does
	// not is simply downloadable. One decision point, or the two drift and the gap is a leak.
	// ───────────────────────────────────────────────────────────────────────────
	public static function db_table( $req ) {
		global $wpdb;
		$raw = (string) Rest::p( $req, 'table', '' );
		$table = null;
		foreach ( Extra::all_table_names() as $name ) {
			if ( $name === $raw || $name === $wpdb->prefix . $raw ) { $table = $name; break; }
		}
		if ( ! $table ) { return Rest::err( 'bad_table', 'Unknown table', 404 ); }

		// Keyset by the table's own rowid where available (SQLite + MySQL both expose an id/ROWID-ish
		// path); fall back to OFFSET only if no usable key. We try the common `id` PK first.
		$cursor = Rest::pint( $req, 'cursor', 0 );
		$limit  = min( 3000, max( 100, Rest::pint( $req, 'limit', 1500 ) ) );
		// Detect an `id` column cross-DB (SQLite + MySQL) by sampling a row — keyset on it when present,
		// else OFFSET. (pragma_table_info is SQLite-only and would fatal on production MySQL.)
		$sample = $wpdb->get_row( "SELECT * FROM `$table` LIMIT 1", ARRAY_A );
		$has_id = is_array( $sample ) && array_key_exists( 'id', $sample );
		if ( $has_id ) {
			$rows = $wpdb->get_results( $wpdb->prepare(
				"SELECT * FROM `$table` WHERE id > %d ORDER BY id ASC LIMIT %d", $cursor, $limit
			), ARRAY_A ) ?: [];
			$next = count( $rows ) >= $limit ? (int) end( $rows )['id'] : null;
		} else {
			$rows = $wpdb->get_results( $wpdb->prepare(
				"SELECT * FROM `$table` LIMIT %d OFFSET %d", $limit, $cursor
			), ARRAY_A ) ?: [];
			$next = count( $rows ) >= $limit ? $cursor + $limit : null;
		}
		$rows = array_map( fn( $r ) => Extra::redact_row( $table, $r ), $rows );
		// Columns come from the REDACTED row, never the raw one: a redaction rule that drops a cell
		// instead of masking it would otherwise leave `columns` advertising a field the rows no
		// longer carry, and a consumer zipping the two together would mis-align every value.
		$cols = $rows ? array_keys( reset( $rows ) ) : [];
		return [ 'table' => $table, 'columns' => $cols, 'rows' => $rows, 'next' => $next ];
	}

	// ───────────────────────────────────────────────────────────────────────────
	// GET offline/media/{lesson_id} — resolve the downloadable video qualities + caption tracks.
	// Best-effort over YouTube; returns whatever is genuinely downloadable. Empty qualities ⇒
	// the video is stream-only (online) and the course is offline as transcript + captions.
	// ───────────────────────────────────────────────────────────────────────────
	public static function media( $req ) {
		$lid = Rest::pint( $req, 'lesson_id' );
		$l   = Data::one( 'SELECT video, video_type, seg_start, seg_end FROM ' . Data::t( 'aq_lessons' ) . ' WHERE id = %d', [ $lid ] );
		if ( ! $l ) { return Rest::err( 'not_found', 'Video not found', 404 ); }
		$vid = (string) $l['video'];
		if ( $vid === '' || $l['video_type'] !== 'youtube' ) {
			return [ 'lesson_id' => $lid, 'vid' => $vid, 'qualities' => [], 'captions' => [], 'reason' => 'unsupported' ];
		}
		$player = self::yt_player( $vid );
		$qualities = [];
		if ( $player ) {
			$formats = $player['streamingData']['formats'] ?? []; // muxed (progressive) only
			foreach ( $formats as $f ) {
				$itag = (int) ( $f['itag'] ?? 0 );
				$url  = (string) ( $f['url'] ?? '' );
				if ( $url === '' ) { continue; } // ciphered (no direct url) → not downloadable here
				$bytes = (int) ( $f['contentLength'] ?? 0 );
				if ( $bytes > self::MAX_MEDIA_BYTES ) { continue; }
				$label = self::ITAG_LABELS[ $itag ] ?? ( isset( $f['height'] ) ? (int) $f['height'] . 'p' : ( 'itag ' . $itag ) );
				$qualities[] = [
					'itag'   => $itag,
					'label'  => $label,
					'height' => (int) ( $f['height'] ?? 0 ),
					'mime'   => (string) ( $f['mimeType'] ?? 'video/mp4' ),
					'bytes'  => $bytes,
				];
			}
			// Best (highest) first.
			usort( $qualities, fn( $a, $b ) => $b['height'] <=> $a['height'] );
		}
		// Caption tracks (timedtext) available for this video.
		$captions = [];
		$tracks   = $player['captions']['playerCaptionsTracklistRenderer']['captionTracks'] ?? [];
		foreach ( $tracks as $t ) {
			$code = (string) ( $t['languageCode'] ?? '' );
			if ( $code === '' ) { continue; }
			$captions[] = [
				'lang' => $code,
				'name' => (string) ( $t['name']['simpleText'] ?? ( $t['name']['runs'][0]['text'] ?? $code ) ),
			];
		}
		return [
			'lesson_id'   => $lid,
			'vid'         => $vid,
			'seg_start'   => (int) $l['seg_start'],
			'seg_end'     => (int) $l['seg_end'],
			'qualities'   => $qualities,
			'captions'    => $captions,
			'translatable'=> ! empty( $tracks ),
		];
	}

	// ───────────────────────────────────────────────────────────────────────────
	// GET offline/media/{lesson_id}/stream?itag= — same-origin Range-aware proxy of one
	// progressive format, so the browser can fetch + cache the bytes (googlevideo blocks
	// cross-origin reads). Streams straight through; never buffers the whole file in memory.
	// ───────────────────────────────────────────────────────────────────────────
	/** Wall-clock ceiling for one proxied stream. Generous for a real download of a lesson video on a
	 *  slow line; finite, which is the point — the old @set_time_limit(0) had none. */
	const STREAM_MAX_SECONDS = 900;

	public static function media_stream( $req ) {
		// This route is 'public' and it holds a PHP worker for as long as the CLIENT chooses to read.
		// Without a ceiling, opening a handful of connections and then reading at one byte a second —
		// or never reading at all — occupies the whole worker pool and the site stops answering for
		// everyone. The cost is real whether or not the caller is signed in, so the limit is too.
		if ( Rest::throttle( 'offline_stream', 120, 600 ) ) {
			return Rest::err( 'rate_limited', 'Too many video streams at once. Pause and try again shortly.', 429 );
		}
		$lid  = Rest::pint( $req, 'lesson_id' );
		$itag = Rest::pint( $req, 'itag' );
		$l    = Data::one( 'SELECT video, video_type FROM ' . Data::t( 'aq_lessons' ) . ' WHERE id = %d', [ $lid ] );
		if ( ! $l || $l['video_type'] !== 'youtube' || $l['video'] === '' ) {
			return Rest::err( 'not_found', 'No downloadable media', 404 );
		}
		$player = self::yt_player( (string) $l['video'] );
		$url = '';
		$mime = 'video/mp4';
		foreach ( $player['streamingData']['formats'] ?? [] as $f ) {
			if ( (int) ( $f['itag'] ?? 0 ) === $itag && ! empty( $f['url'] ) ) {
				$url  = (string) $f['url'];
				$mime = (string) ( $f['mimeType'] ?? 'video/mp4' );
				break;
			}
		}
		if ( $url === '' ) { return Rest::err( 'unavailable', 'This quality is not downloadable for this video', 503 ); }

		// Stream the upstream file through to the client. Pass a Range header through when present so a
		// resumed/partial fetch works; otherwise stream the whole file.
		$range = isset( $_SERVER['HTTP_RANGE'] ) ? (string) $_SERVER['HTTP_RANGE'] : '';
		@set_time_limit( self::STREAM_MAX_SECONDS + 30 ); // finite, unlike the 0 this used to pass
		$deadline = time() + self::STREAM_MAX_SECONDS;
		while ( ob_get_level() > 0 ) { @ob_end_clean(); }
		$headers = [ 'User-Agent' => 'Mozilla/5.0', 'Accept' => '*/*' ];
		if ( $range !== '' ) { $headers['Range'] = $range; }
		$ctx = stream_context_create( [ 'http' => [ 'method' => 'GET', 'header' => self::header_lines( $headers ), 'timeout' => 30, 'ignore_errors' => true ] ] );
		$fh  = @fopen( $url, 'rb', false, $ctx );
		if ( ! $fh ) { return Rest::err( 'upstream', 'Could not open the video stream', 502 ); }

		// Mirror the upstream status + key headers (so a 206 partial is reported as 206).
		$status = 200; $clen = ''; $crange = '';
		foreach ( ( $http_response_header ?? [] ) as $h ) {
			if ( preg_match( '#^HTTP/\S+\s+(\d{3})#', $h, $m ) ) { $status = (int) $m[1]; }
			elseif ( stripos( $h, 'Content-Length:' ) === 0 ) { $clen = trim( substr( $h, 15 ) ); }
			elseif ( stripos( $h, 'Content-Range:' ) === 0 ) { $crange = trim( substr( $h, 14 ) ); }
		}
		status_header( $status === 206 ? 206 : 200 );
		header( 'Content-Type: ' . $mime );
		header( 'Accept-Ranges: bytes' );
		header( 'Cache-Control: private, max-age=0' );
		header( 'Access-Control-Allow-Origin: ' . ( $_SERVER['HTTP_ORIGIN'] ?? '*' ) );
		if ( $clen !== '' )   { header( 'Content-Length: ' . $clen ); }
		if ( $crange !== '' ) { header( 'Content-Range: ' . $crange ); }
		// Stop copying the moment the client goes away or the budget is spent. Without either test the
		// loop is driven entirely by how fast the CLIENT chooses to read, which is what let a handful of
		// deliberately-slow connections hold the worker pool open indefinitely.
		ignore_user_abort( false );
		while ( ! feof( $fh ) ) {
			$chunk = fread( $fh, 256 * 1024 );
			if ( $chunk === false ) { break; }
			echo $chunk;
			@ob_flush(); @flush();
			if ( connection_aborted() || time() > $deadline ) { break; }
		}
		fclose( $fh );
		exit;
	}

	// ───────────────────────────────────────────────────────────────────────────
	// GET offline/captions/{lesson_id}?lang=&tlang= — one caption track as WebVTT, same-origin,
	// so an offline <video> can show <track> captions. tlang requests an auto-translation.
	// ───────────────────────────────────────────────────────────────────────────
	public static function captions( $req ) {
		$lid   = Rest::pint( $req, 'lesson_id' );
		$lang  = preg_replace( '/[^a-zA-Z-]/', '', (string) Rest::p( $req, 'lang', '' ) );
		$tlang = preg_replace( '/[^a-zA-Z-]/', '', (string) Rest::p( $req, 'tlang', '' ) );
		$l = Data::one( 'SELECT video, video_type FROM ' . Data::t( 'aq_lessons' ) . ' WHERE id = %d', [ $lid ] );
		if ( ! $l || $l['video_type'] !== 'youtube' || $l['video'] === '' ) {
			return Rest::err( 'not_found', 'No captions', 404 );
		}
		$vid    = (string) $l['video'];
		$player = self::yt_player( $vid );
		$tracks = $player['captions']['playerCaptionsTracklistRenderer']['captionTracks'] ?? [];
		$base   = '';
		foreach ( $tracks as $t ) {
			if ( ( $t['languageCode'] ?? '' ) === $lang && ! empty( $t['baseUrl'] ) ) { $base = (string) $t['baseUrl']; break; }
		}
		if ( $base === '' && $tracks ) { $base = (string) ( $tracks[0]['baseUrl'] ?? '' ); } // fall back to first track
		if ( $base === '' ) { return Rest::err( 'unavailable', 'No caption track', 404 ); }
		$url = $base . ( $tlang ? '&tlang=' . rawurlencode( $tlang ) : '' ) . '&fmt=vtt';
		$resp = wp_remote_get( $url, [ 'timeout' => 12, 'headers' => [ 'User-Agent' => 'Mozilla/5.0' ] ] );
		if ( is_wp_error( $resp ) || wp_remote_retrieve_response_code( $resp ) !== 200 ) {
			return Rest::err( 'upstream', 'Could not fetch captions', 502 );
		}
		$body = (string) wp_remote_retrieve_body( $resp );
		if ( strpos( $body, 'WEBVTT' ) === false ) { $body = "WEBVTT\n\n" . $body; }
		while ( ob_get_level() > 0 ) { @ob_end_clean(); }
		status_header( 200 );
		header( 'Content-Type: text/vtt; charset=utf-8' );
		header( 'Cache-Control: public, max-age=86400' );
		echo $body;
		exit;
	}

	// ───────────────────────────────────────────────────────────────────────────
	// GET offline/downloader?courses=1,2&os=mac&q=360&sub=en — a self-installing video downloader
	// SCRIPT for the chosen OS. The browser can't download YouTube, but this script (run on the
	// learner's own machine) downloads the standalone yt-dlp binary itself, then the videos.
	//
	// Served from a URL so Mac/Linux users can paste ONE Homebrew-style line —
	//   /bin/bash -c "$(curl -fsSL '<this url>')"
	// — which bypasses macOS Gatekeeper entirely (a script piped through bash is never quarantined,
	// unlike a downloaded .command file, which modern macOS hard-blocks). Windows downloads it as a
	// .cmd file (double-click → Run). Our server only ships this tiny text script — never video bytes.
	// ───────────────────────────────────────────────────────────────────────────
	public static function downloader( $req ) {
		$ids = array_slice( array_values( array_filter( array_map( 'intval', explode( ',', (string) Rest::p( $req, 'courses', '' ) ) ) ) ), 0, 200 );
		$q   = strtolower( preg_replace( '/[^a-zA-Z0-9]/', '', (string) Rest::p( $req, 'q', '360' ) ) );
		$sub = preg_replace( '/[^a-zA-Z-]/', '', (string) Rest::p( $req, 'sub', 'en' ) );
		if ( $sub === '' ) { $sub = 'en'; }
		$os  = (string) Rest::p( $req, 'os', 'mac' );

		$courses = [];
		foreach ( $ids as $cid ) {
			$c = Data::one( 'SELECT title FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
			if ( ! $c ) { continue; }
			$urls = [];
			foreach ( Data::all( 'SELECT video FROM ' . Data::t( 'aq_lessons' ) . " WHERE course_id = %d AND video_type = 'youtube' AND video <> '' ORDER BY idx ASC", [ $cid ] ) as $r ) {
				$urls[] = 'https://www.youtube.com/watch?v=' . $r['video'];
			}
			if ( $urls ) { $courses[] = [ 'title' => (string) $c['title'], 'urls' => $urls ]; }
		}

		$script = ( $os === 'windows' )
			? self::win_script( $courses, $q, $sub )
			: self::nix_script( $courses, $q, $sub, $os === 'linux' ? 'linux' : 'mac' );

		while ( ob_get_level() > 0 ) { @ob_end_clean(); }
		status_header( 200 );
		header( 'Content-Type: text/plain; charset=utf-8' );
		header( 'Cache-Control: no-store' );
		header( 'Access-Control-Allow-Origin: *' );
		echo $script;
		exit;
	}

	/** yt-dlp flags: best SINGLE file (no ffmpeg merge) preferring the chosen height + subtitles.
	 *  Avoids the `<` char so the same string is safe inside a Windows .cmd. */
	private static function ydl_flags( $q, $sub ) {
		$res  = [ '144p' => 144, '360p' => 360, '480p' => 480, '720p' => 720, '144' => 144, '360' => 360, '480' => 480, '720' => 720 ];
		$sort = isset( $res[ $q ] ) ? 'res:' . $res[ $q ] . ',ext:mp4:m4a' : 'ext:mp4:m4a';
		return '-f best -S "' . $sort . '" --write-subs --write-auto-subs --sub-langs "' . $sub . '"';
	}

	/**
	 * A course title reduced to a folder name that is safe BOTH as a filename and as a token in the
	 * shell/cmd scripts below. The old rule stripped only filename-illegal bytes, which left every
	 * shell metacharacter intact — and a title is member-supplied (Courses::create takes any
	 * sanitize_text_field string). `$(…)`, backticks and `%…%` all survive that filter and all
	 * EXECUTE once the title is interpolated into a script we hand a member to run on their own
	 * machine. Keep letters, numbers, spaces and the three punctuation marks a title actually needs.
	 */
	private static function safe_dir( $t ) {
		$t = preg_replace( '/[^\p{L}\p{N} ._-]/u', '_', (string) $t );
		$t = trim( preg_replace( '/\s+/', ' ', (string) $t ) );
		return $t === '' ? 'Course' : mb_substr( $t, 0, 80 );
	}

	/** macOS/Linux bash script — run via `/bin/bash -c "$(curl -fsSL '<url>')"` (Gatekeeper-safe).
	 *  The video tool is fetched robustly: GitHub first, then the ArtaQuest mirror (works where GitHub
	 *  is blocked/slow — our server fetches it), with `-f` + a size check so a 504 error page is never
	 *  saved and run as the binary. */
	private static function nix_script( $courses, $q, $sub, $plat ) {
		$bin    = $plat === 'mac' ? 'yt-dlp_macos' : 'yt-dlp_linux';
		$flags  = self::ydl_flags( $q, $sub );
		$ql     = function ( $s ) { return "'" . str_replace( "'", "'\\''", $s ) . "'"; };
		$gh     = self::YDL . '/' . $bin;
		$mirror = home_url( '/wp-json/aq/v1/offline/ytdlp?os=' . $plat );
		$L   = [];
		$L[] = '#!/bin/bash';
		$L[] = 'set -e';
		$L[] = 'echo ""';
		$L[] = 'echo "  ArtaQuest — saving your course videos for offline."';
		$L[] = 'echo "  Setting everything up for you. No installing, no accounts, free."';
		$L[] = 'echo ""';
		$L[] = 'DIR="$HOME/ArtaQuest Videos"';
		$L[] = 'mkdir -p "$DIR" && cd "$DIR"';
		// Download the tool only if we don't already have a valid (large) copy.
		$L[] = 'if [ ! -s yt-dlp ] || [ "$(wc -c < yt-dlp)" -lt 1000000 ]; then';
		$L[] = '  echo "  Getting the video tool (one time)..."';
		$L[] = '  ok=0';
		// ArtaQuest mirror FIRST (reachable where GitHub is blocked/slow — the whole point), GitHub second.
		$L[] = '  for U in ' . $ql( $mirror ) . ' ' . $ql( $gh ) . '; do';
		$L[] = '    if curl -fL --retry 3 --retry-delay 2 --connect-timeout 30 -o yt-dlp "$U" && [ -s yt-dlp ] && [ "$(wc -c < yt-dlp)" -gt 1000000 ]; then ok=1; break; fi';
		$L[] = '    echo "  ...one source was unreachable, trying another"';
		$L[] = '  done';
		$L[] = '  if [ "$ok" != 1 ]; then echo ""; echo "  Could not download the video tool. Please check your internet and run this again."; exit 1; fi';
		$L[] = '  chmod +x yt-dlp';
		if ( $plat === 'mac' ) { $L[] = '  xattr -d com.apple.quarantine yt-dlp 2>/dev/null || true'; }
		$L[] = 'fi';
		foreach ( $courses as $c ) {
			$dir = self::safe_dir( $c['title'] );
			$out = $dir . '/%(autonumber)02d - %(title)s.%(ext)s';
			$L[] = 'echo ""';
			// SINGLE-quoted, like every other interpolation in this script. Inside bash double quotes
			// `$(…)` and backticks still run, so a title was a command-execution primitive on the
			// member's own machine — the one place this script is meant to be trusted. safe_dir() now
			// strips those bytes too; quoting correctly is the guarantee that does not depend on it.
			$L[] = 'echo ' . $ql( '  Downloading: ' . $dir );
			$L[] = 'mkdir -p ' . $ql( $dir );
			$L[] = './yt-dlp ' . $flags . ' -o ' . $ql( $out ) . ' ' . implode( ' ', array_map( $ql, $c['urls'] ) ) . ' || true';
		}
		$L[] = 'echo ""';
		$L[] = 'echo "  All done! Your videos are in:  $DIR"';
		$L[] = 'open "$DIR" 2>/dev/null || true';
		return implode( "\n", $L ) . "\n";
	}

	/** Windows .cmd — downloaded + double-clicked. No `<` (cmd redirection); `%%` escapes templates. */
	private static function win_script( $courses, $q, $sub ) {
		$flags  = self::ydl_flags( $q, $sub );
		$gh     = self::YDL . '/yt-dlp.exe';
		$mirror = home_url( '/wp-json/aq/v1/offline/ytdlp?os=windows' );
		$L   = [];
		$L[] = '@echo off';
		$L[] = 'title ArtaQuest video downloader';
		$L[] = 'cd /d "%~dp0"';
		$L[] = 'echo.';
		$L[] = 'echo   ArtaQuest - saving your course videos for offline.';
		$L[] = 'echo   Setting everything up for you. No installing, no accounts, free.';
		$L[] = 'echo.';
		$L[] = 'if not exist yt-dlp.exe (';
		$L[] = '  echo   Getting the video tool ^(one time^)...';
		$L[] = '  curl -fL --retry 3 --connect-timeout 30 -o yt-dlp.exe "' . $mirror . '"';
		$L[] = '  if not exist yt-dlp.exe curl -fL --retry 3 -o yt-dlp.exe "' . $gh . '"';
		$L[] = ')';
		foreach ( $courses as $c ) {
			$dir = self::safe_dir( $c['title'] );
			$out = $dir . '\\%%(autonumber)02d - %%(title)s.%%(ext)s';
			$urls = implode( ' ', array_map( function ( $u ) { return '"' . $u . '"'; }, $c['urls'] ) );
			$L[] = 'echo.';
			$L[] = 'echo   Downloading: ' . $dir;
			$L[] = 'if not exist "' . $dir . '" mkdir "' . $dir . '"';
			$L[] = 'yt-dlp.exe ' . $flags . ' -o "' . $out . '" ' . $urls;
		}
		$L[] = 'echo.';
		$L[] = 'echo   All done! Your videos are in folders next to this file.';
		$L[] = 'pause';
		return implode( "\r\n", $L ) . "\r\n";
	}

	const YDL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

	// GET offline/ytdlp?os=mac|linux|windows — mirror the standalone yt-dlp binary through our server,
	// so the downloader works even where GitHub is blocked or timing out (our datacenter can reach it).
	public static function ytdlp( $req ) {
		$os   = (string) Rest::p( $req, 'os', 'mac' );
		$map  = [ 'mac' => 'yt-dlp_macos', 'linux' => 'yt-dlp_linux', 'windows' => 'yt-dlp.exe' ];
		$name = $map[ $os ] ?? 'yt-dlp_macos';
		@set_time_limit( 0 );
		$url = self::resolve_ytdlp_url( $name );
		if ( $url === '' ) { status_header( 502 ); header( 'Content-Type: text/plain' ); echo 'mirror unavailable — please try again'; exit; }
		// CACHE THE BINARY, DON'T RE-FETCH IT PER REQUEST. This used to pull ~35 MB from GitHub on
		// EVERY call, with a 180-second timeout and no throttle at all — so each anonymous request
		// pinned a PHP worker for as long as GitHub cared to take, moved 35 MB in and 35 MB out, and
		// counted against our GitHub rate limit. A handful of concurrent callers was enough to hold
		// the worker pool. The asset is immutable per version, so one copy serves everyone: keep it
		// on disk for CACHE_S and re-fetch only when it is missing, stale or truncated.
		$cached = rtrim( get_temp_dir(), '/\\' ) . '/aq-ytdlp-' . preg_replace( '/[^A-Za-z0-9._-]/', '', $name );
		$fresh  = file_exists( $cached ) && filesize( $cached ) > 1000000
			&& ( time() - (int) filemtime( $cached ) ) < self::YTDLP_CACHE_S;
		if ( ! $fresh ) {
			// Only a fetch is rationed — a cache HIT costs a readfile and is left alone, so the
			// common path stays free for every caller, script or human.
			if ( Rest::throttle( 'ytdlp_fetch', 4, 3600 ) ) {
				status_header( 429 ); header( 'Content-Type: text/plain' );
				echo 'the mirror is refreshing its copy — try again in a minute'; exit;
			}
			$tmp = tempnam( sys_get_temp_dir(), 'aqytdlp' );
			if ( ! $tmp ) { status_header( 502 ); header( 'Content-Type: text/plain' ); echo 'mirror temp error — please try again'; exit; }
			$resp = wp_remote_get( $url, [ 'timeout' => 120, 'redirection' => 5, 'user-agent' => 'ArtaQuest', 'stream' => true, 'filename' => $tmp ] );
			$got  = file_exists( $tmp ) ? (int) filesize( $tmp ) : 0;
			if ( is_wp_error( $resp ) || wp_remote_retrieve_response_code( $resp ) !== 200 || $got < 1000000 ) {
				@unlink( $tmp );
				// A stale copy beats no copy: serve what we have rather than failing the download.
				if ( ! file_exists( $cached ) || filesize( $cached ) < 1000000 ) {
					status_header( 502 ); header( 'Content-Type: text/plain' ); echo 'mirror could not fetch the tool — please try again'; exit;
				}
			} else {
				@rename( $tmp, $cached ) || @copy( $tmp, $cached );
				@unlink( $tmp );
			}
		}
		$tmp  = $cached;
		$size = file_exists( $tmp ) ? (int) filesize( $tmp ) : 0;
		if ( $size < 1000000 ) { status_header( 502 ); header( 'Content-Type: text/plain' ); echo 'mirror could not fetch the tool — please try again'; exit; }
		while ( ob_get_level() > 0 ) { @ob_end_clean(); }
		status_header( 200 );
		header( 'Content-Type: application/octet-stream' );
		header( 'Content-Disposition: attachment; filename="' . $name . '"' );
		header( 'Content-Length: ' . $size );
		header( 'Cache-Control: public, max-age=86400' );
		readfile( $tmp );
		exit;   // NOTE: $tmp is the CACHE now — never unlink it here
	}

	/** The versioned download URL for a yt-dlp asset, via the GitHub API (cached 12h). We DON'T use the
	 *  `/releases/latest/download/` alias — that redirect 504s through some egress proxies; the resolved
	 *  `/releases/download/<tag>/` URL downloads fine. */
	private static function resolve_ytdlp_url( $name ) {
		$key    = 'aq_ytdlp_url_' . $name;
		$cached = get_transient( $key );
		if ( is_string( $cached ) && $cached !== '' ) { return $cached; }
		$a = wp_remote_get( 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', [ 'timeout' => 30, 'user-agent' => 'ArtaQuest', 'headers' => [ 'Accept' => 'application/vnd.github+json' ] ] );
		if ( is_wp_error( $a ) || wp_remote_retrieve_response_code( $a ) !== 200 ) { return ''; }
		$j = json_decode( wp_remote_retrieve_body( $a ), true );
		foreach ( (array) ( $j['assets'] ?? [] ) as $as ) {
			if ( ( $as['name'] ?? '' ) === $name && ! empty( $as['browser_download_url'] ) ) {
				set_transient( $key, $as['browser_download_url'], 12 * HOUR_IN_SECONDS );
				return (string) $as['browser_download_url'];
			}
		}
		return '';
	}

	// ── internals ───────────────────────────────────────────────────────────────

	/** Call a live handler with synthesized params and return its array (the SPA-shaped JSON).
	 *  Unwraps WP_REST_Response / WP_Error to a plain array so it nests cleanly in a bundle. */
	private static function call( $handler, array $params ) {
		[ $class, $fn ] = explode( '::', $handler );
		$class = 'AQ\\' . $class;
		$req = new \WP_REST_Request();
		foreach ( $params as $k => $v ) { $req->set_param( $k, $v ); }
		try {
			$out = $class::$fn( $req );
		} catch ( \Throwable $e ) {
			return [ 'error' => 'server_error', 'message' => $e->getMessage() ];
		}
		if ( $out instanceof \WP_REST_Response ) { return $out->get_data(); }
		if ( $out instanceof \WP_Error ) { return [ 'error' => $out->get_error_code(), 'message' => $out->get_error_message() ]; }
		return $out;
	}

	/** Force a course-detail payload to the all-unlocked, watch-anything view for offline use. */
	private static function unlock_course( &$detail ) {
		if ( ! is_array( $detail ) ) { return; }
		if ( isset( $detail['lessons'] ) && is_array( $detail['lessons'] ) ) {
			foreach ( $detail['lessons'] as &$l ) { if ( is_array( $l ) ) { $l['locked'] = false; } }
			unset( $l );
		}
	}

	/** Innertube clients we try, in order, to resolve a video. YouTube rejects stale app versions
	 *  outright (a too-old clientVersion now 400s — the single reason an "ANDROID 19.x"-only resolver
	 *  silently returned zero downloadable formats), and which client yields a muxed progressive URL
	 *  varies per video, so we try several current ones and keep the first that actually delivers a
	 *  downloadable file. Versions need an occasional bump; the multi-client list makes that non-fatal.
	 *  ANDROID is first because it's the most reliable source of muxed (single-file) progressive itags. */
	const YT_CLIENTS = [
		[ 'name' => 'ANDROID', 'ver' => '20.10.38', 'extra' => [ 'androidSdkVersion' => 34 ],
		  'ua' => 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip' ],
		[ 'name' => 'ANDROID', 'ver' => '19.44.38', 'extra' => [ 'androidSdkVersion' => 33 ],
		  'ua' => 'com.google.android.youtube/19.44.38 (Linux; U; Android 13) gzip' ],
		[ 'name' => 'IOS', 'ver' => '20.10.4', 'extra' => [ 'deviceModel' => 'iPhone16,2' ],
		  'ua' => 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_1 like Mac OS X)' ],
	];

	/** YouTube Innertube player response, resolved via the first {@see YT_CLIENTS} client that returns a
	 *  usable result. "Usable" = a muxed progressive format carrying a direct (unciphered) URL; if no
	 *  client yields one we keep the best OK response anyway so captions still work and the course saves
	 *  as transcript + captions. Cached briefly per video. Returns [] on total failure (caller degrades). */
	private static function yt_player( $vid ) {
		static $memo = [];
		if ( isset( $memo[ $vid ] ) ) { return $memo[ $vid ]; }
		$cache_key = 'aq_yt_player_' . md5( $vid );
		$cached = get_transient( $cache_key );
		if ( is_array( $cached ) ) { return $memo[ $vid ] = $cached; }

		$fallback = null; // first OK response (captions, even if no downloadable format)
		foreach ( self::YT_CLIENTS as $c ) {
			$data = self::yt_player_request( $vid, $c );
			if ( ! is_array( $data ) ) { continue; }
			if ( ( $data['playabilityStatus']['status'] ?? '' ) !== 'OK' ) { continue; }
			$has_url = false;
			foreach ( $data['streamingData']['formats'] ?? [] as $f ) {
				if ( ! empty( $f['url'] ) ) { $has_url = true; break; }
			}
			if ( $has_url ) {
				set_transient( $cache_key, $data, 2 * HOUR_IN_SECONDS ); // googlevideo URLs are short-lived (~6h); cache < that
				return $memo[ $vid ] = $data;
			}
			if ( $fallback === null ) { $fallback = $data; }
		}
		// No client gave a downloadable file. Cache a captions-only fallback briefly so the course can
		// still save its captions; but if NOTHING came back (likely a transient datacenter-IP throttle
		// from YouTube, not a permanently un-downloadable video) cache for only a short window so a
		// retry can succeed soon instead of being stuck "no video" for ages. Per-request memo still
		// avoids re-hitting YouTube within one bundle build. Kept SHORT (5 min, was 30) because the
		// downloader retries: one throttled resolution must not pin "no video" for half an hour.
		if ( is_array( $fallback ) ) {
			set_transient( $cache_key, $fallback, 5 * MINUTE_IN_SECONDS );
			return $memo[ $vid ] = $fallback;
		}
		set_transient( $cache_key, [], 90 ); // 90s negative cache — recover fast once the throttle lifts
		return $memo[ $vid ] = [];
	}

	/** One Innertube /player POST for a single client config. Returns the decoded array or null. */
	private static function yt_player_request( $vid, $client ) {
		$payload = wp_json_encode( [
			'videoId' => $vid,
			'context' => [ 'client' => array_merge( [
				'clientName'    => $client['name'],
				'clientVersion' => $client['ver'],
				'hl' => 'en', 'gl' => 'US',
			], $client['extra'] ?? [] ) ],
			'contentCheckOk' => true,
			'racyCheckOk'    => true,
		] );
		// The `key` here is YouTube's PUBLIC InnerTube key for the Android client — the constant
		// compiled into com.google.android.youtube and identical for every installation on earth. It
		// is not ours, it authenticates nothing of ours, and rotating it is not a thing we could do.
		// The InnerTube protocol requires the key that MATCHES the impersonated client, so it cannot
		// be swapped for one of our own credentials; our actual YouTube credentials are
		// YOUTUBE_SA_JSON / YOUTUBE_API_KEY in the Vault, read through Secrets::get and never inline.
		//
		// It is spelled out because it is indistinguishable from a leaked Google key at a glance, and
		// the CI secret gate is deliberately allowed to skip exactly this one literal (see main.yml).
		$resp = wp_remote_post( 'https://www.youtube.com/youtubei/v1/player?key=AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w', [
			'timeout' => 12,
			'headers' => [ 'Content-Type' => 'application/json', 'User-Agent' => $client['ua'] ],
			'body'    => $payload,
		] );
		if ( is_wp_error( $resp ) || wp_remote_retrieve_response_code( $resp ) !== 200 ) { return null; }
		$data = json_decode( wp_remote_retrieve_body( $resp ), true );
		return is_array( $data ) ? $data : null;
	}

	/** Flatten a header map to the "K: V\r\n" lines stream_context wants. */
	private static function header_lines( array $h ) {
		$out = '';
		foreach ( $h as $k => $v ) { $out .= $k . ': ' . $v . "\r\n"; }
		return $out;
	}

	// ───────────────────────────────────────────────────────────────────────────
	// Root-scope PWA assets: serve /sw.js + /manifest.webmanifest so the service worker
	// controls the WHOLE site (a worker served from the theme's app/ dir would only scope
	// to that sub-path). Hooked on `init`, before WordPress would 404 these paths.
	// ───────────────────────────────────────────────────────────────────────────
	public static function serve_pwa_assets() {
		$path = (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ?? '' ), PHP_URL_PATH );
		// The service worker is served from the ROOT-PATH query URL /?aq_sw=1 (not /sw.js): the host's
		// static layer 404s a non-existent root .js BEFORE it reaches WordPress, whereas a home-URL query
		// always routes to WP (same trick as the .ics feed). The script's path is "/", so its default
		// control scope is the whole site — no Service-Worker-Allowed gymnastics needed.
		// phpcs:disable WordPress.Security.NonceVerification.Recommended
		if ( isset( $_GET['aq_sw'] ) ) {
			$file = self::app_file( 'sw.js' );
			if ( $file ) {
				while ( ob_get_level() > 0 ) { @ob_end_clean(); }
				header( 'Content-Type: application/javascript; charset=utf-8' );
				header( 'Service-Worker-Allowed: /' );
				header( 'Cache-Control: no-cache' );
				readfile( $file );
				exit;
			}
		} elseif ( isset( $_GET['aq_manifest'] ) || $path === '/manifest.webmanifest' ) {
			$file = self::app_file( 'manifest.webmanifest' );
			if ( $file ) {
				while ( ob_get_level() > 0 ) { @ob_end_clean(); }
				header( 'Content-Type: application/manifest+json; charset=utf-8' );
				header( 'Cache-Control: public, max-age=86400' );
				readfile( $file );
				exit;
			}
		}
		// phpcs:enable WordPress.Security.NonceVerification.Recommended
	}

	/** Absolute path to a file the SPA build copied into the theme's app/ dir, or '' if absent. */
	private static function app_file( $name ) {
		$dir = get_theme_root() . '/artaquest-theme/app/' . $name;
		return is_readable( $dir ) ? $dir : '';
	}
}
