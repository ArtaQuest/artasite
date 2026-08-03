<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * YouTube view-count monitor — an HOURLY, quota-safe refresh of every section video's cumulative
 * view count, the per-video views-per-HOUR growth rate, and the per-course "trending" score
 * derived from it (operator rule 2026-06-12: all rates are hourly — measurement and averaging).
 * Three moving parts:
 *
 *   1. Registry (aq_videos) — one row per DISTINCT video any section references. Each row carries
 *      the latest view count, its hourly `rate` (delta ÷ actual elapsed time, per hour), and a
 *      jittered `next_refresh` schedule.
 *   2. Refresh cron (refresh_due) — runs every 15 min and only touches videos whose next_refresh
 *      is due, in chunks of 50 ids per API call (the Data API hard cap). Because each refreshed
 *      video is rescheduled ~1h out with jitter, the load self-spreads across the hour
 *      (~22 batched calls/hour for ~1.1k videos ≈ 530 quota units/day, far under the 10k cap).
 *   3. Trend (aq_courses.trend) — after a batch refresh, every affected course's trend is
 *      recomputed as the SUM of its DISTINCT videos' hourly rates (a video shared by several
 *      sections — segments of one video — is counted once). The trending list ORDER BYs this.
 *
 * The history series for the monitor (sparkline + chart) accrues an HOURLY cumulative bucket per
 * (video, hour) in aq_video_stats and per (course, hour) in aq_course_stats — every refresh writes
 * the current hour's bucket, so a brand-new course charts within ~2 hours instead of days
 * (ticket #74: everything updates hourly by the cron, the growth charts included). Storage stays
 * bounded: a daily compaction (compact_stats, riding the aq_video_sync cron) folds buckets older
 * than KEEP_HOURLY_DAYS back to one per UTC day — the original daily-archive shape — and the
 * read-side rate math normalises by actual elapsed hours, so mixed granularity reads cleanly.
 * Credentials come from a service account (YOUTUBE_SA_JSON, OAuth) or a plain
 * Data-API key (YOUTUBE_API_KEY); all of this no-ops gracefully when neither is configured.
 */
final class YouTube {

	/** videos.list accepts up to 50 ids per call (API hard cap). */
	const CHUNK = 50;

	/** Max API calls per cron run → CHUNK × this many videos refreshed per run. With the 15-min
	 *  cadence (96 runs/day) this covers ~96k videos/day at 1 quota unit per call, far under the
	 *  default 10k-units/day quota. The jittered schedule means a run rarely hits this ceiling;
	 *  raise it (and request more quota) only when the catalogue genuinely outgrows a day's cycle. */
	const CALLS_PER_RUN = 20;

	/** Target refresh interval per video (HOURLY — operator rule 2026-06-12: the monitor measures
	 *  per-hour rates directly, not daily deltas), jittered ±2 min so refreshes don't re-clump.
	 *  Quota: ~1.1k videos hourly ≈ 22 batched calls/hour ≈ 530 units/day — far under the 10k cap. */
	const INTERVAL = 3600;

	/** Per-request, per-SCOPE memoized OAuth access tokens (NEVER persisted — the DB is public).
	 *  videos.list/channels.list read with youtube.readonly; commentThreads.list needs force-ssl. */
	private static $tokens = [];

	/** A plain Data-API key (AIza…), if one is configured. */
	public static function api_key() { return Secrets::get( 'YOUTUBE_API_KEY' ); }

	/** Parsed service-account credentials (YOUTUBE_SA_JSON), or null. The DB is public, so this is
	 *  read only from an env var / wp-config constant via Secrets — never stored or echoed. */
	public static function sa() {
		$raw = Secrets::get( 'YOUTUBE_SA_JSON' );
		if ( $raw === '' ) { return null; }
		$j = json_decode( $raw, true );
		return ( is_array( $j ) && ! empty( $j['client_email'] ) && ! empty( $j['private_key'] ) ) ? $j : null;
	}

	/** Whether the monitor can talk to YouTube at all (a key OR a service account is configured). */
	public static function enabled() { return self::api_key() !== '' || self::sa() !== null; }

	private static function b64url( $s ) { return rtrim( strtr( base64_encode( $s ), '+/', '-_' ), '=' ); }

	/**
	 * Mint an OAuth2 access token from the service account (signed JWT → token endpoint), memoized
	 * for the current request only. Returns '' on any failure. Not cached in the DB by design.
	 */
	private static function access_token( $scope = 'https://www.googleapis.com/auth/youtube.readonly' ) {
		if ( isset( self::$tokens[ $scope ] ) ) { return self::$tokens[ $scope ]; }
		self::$tokens[ $scope ] = '';
		$sa = self::sa();
		if ( ! $sa ) { return ''; }
		$aud   = $sa['token_uri'] ?? 'https://oauth2.googleapis.com/token';
		$now   = time();
		$input = self::b64url( wp_json_encode( [ 'alg' => 'RS256', 'typ' => 'JWT' ] ) ) . '.' .
			self::b64url( wp_json_encode( [
				'iss'   => $sa['client_email'],
				'scope' => $scope,
				'aud'   => $aud, 'iat' => $now, 'exp' => $now + 3600,
			] ) );
		$sig = '';
		if ( ! openssl_sign( $input, $sig, $sa['private_key'], OPENSSL_ALGO_SHA256 ) ) {
			error_log( '[ArtaQuest] YouTube SA: JWT signing failed (bad private_key?)' );
			return '';
		}
		$res = wp_remote_post( $aud, [ 'timeout' => 15, 'body' => [
			'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			'assertion'  => $input . '.' . self::b64url( $sig ),
		] ] );
		if ( is_wp_error( $res ) ) { error_log( '[ArtaQuest] YouTube SA token transport: ' . $res->get_error_message() ); return ''; }
		$body = json_decode( (string) wp_remote_retrieve_body( $res ), true );
		$tok  = is_array( $body ) ? (string) ( $body['access_token'] ?? '' ) : '';
		if ( $tok === '' ) { error_log( '[ArtaQuest] YouTube SA token HTTP ' . wp_remote_retrieve_response_code( $res ) . ': ' . substr( (string) wp_remote_retrieve_body( $res ), 0, 200 ) ); }
		self::$tokens[ $scope ] = $tok;
		return $tok;
	}

	// ── Cron entry points ────────────────────────────────────────────────────

	/** Cron (every 15 min): refresh the batch of videos that are due, oldest-due first. */
	public static function refresh_due() {
		if ( ! self::enabled() ) { return 0; }
		$now = time();
		$cap = self::CHUNK * self::CALLS_PER_RUN;
		// Scan by schedule alone — `missing` videos are simply spaced 7d out (set in refresh_ids), not
		// excluded, so a video that returns to public recovers on its own without an operator.
		$due = Data::all(
			'SELECT video FROM ' . Data::t( 'aq_videos' ) . ' WHERE next_refresh <= %d ORDER BY next_refresh ASC LIMIT %d',
			[ $now, $cap ]
		);
		if ( ! $due ) { return 0; }
		return self::refresh_ids( array_column( $due, 'video' ) );
	}

	/**
	 * Refresh a specific set of video ids now (used by the cron and by the admin trigger). Updates
	 * each video's view count + hourly rate + hourly history bucket, then IMMEDIATELY recomputes the
	 * trend of every course that uses one of them. Returns the number of videos successfully refreshed.
	 */
	public static function refresh_ids( $ids ) {
		$ids = array_values( array_unique( array_filter( array_map( 'strval', (array) $ids ) ) ) );
		if ( ! $ids || ! self::enabled() ) { return 0; }
		$now    = time();
		$bucket = $now - ( $now % 3600 ); // hour-aligned history bucket (folded to daily by compact_stats)
		$done = 0;
		foreach ( array_chunk( $ids, self::CHUNK ) as $chunk ) {
			$stats = self::fetch_stats( $chunk ); // [ vid => views ] on success; NULL when the call failed
			if ( $stats === null ) { continue; }  // transient failure → leave this batch due, retry next run
			foreach ( $chunk as $vid ) {
				$row = Data::one( 'SELECT video FROM ' . Data::t( 'aq_videos' ) . ' WHERE video = %s', [ $vid ] );
				if ( ! array_key_exists( $vid, $stats ) ) {
					// The call SUCCEEDED but this id wasn't returned → genuinely gone (deleted / private /
					// region-blocked). Mark missing, zero its rate so it stops inflating a course's trend,
					// and retry weekly (a video can return to public). Still scanned, just spaced far out.
					if ( $row ) {
						Data::update( 'aq_videos', [ 'missing' => 1, 'rate' => 0, 'last_refresh' => $now, 'next_refresh' => $now + 7 * DAY_IN_SECONDS ], [ 'video' => $vid ] );
					}
					continue;
				}
				// fetch_stats returns the three raw counts. `views` stays the COMMENT count (the comment-trending
				// baseline + video_day_rate input, unchanged); view_count/like_count are captured as raw stats
				// (surfaced in the operator Console).
				$s      = is_array( $stats[ $vid ] ) ? $stats[ $vid ] : [ 'c' => (int) $stats[ $vid ] ];
				$views  = (int) ( $s['c'] ?? 0 ); // commentCount → legacy `views`
				$vcount = (int) ( $s['v'] ?? 0 ); // real viewCount
				$lcount = (int) ( $s['l'] ?? 0 ); // real likeCount
				// rate = a ROLLING comment rate (centi-comments/day, ×100), read from the hourly history written
				// just below; the first refresh yields 0 (measurement warm-up).
				$fields = [
					'views'        => $views,
					'view_count'   => $vcount,
					'like_count'   => $lcount,
					'rate'         => self::video_day_rate( $vid, $views, $now ),
					'missing'      => 0,
					'last_refresh' => $now,
					'next_refresh' => $now + self::INTERVAL + wp_rand( -120, 120 ),
				];
				if ( $row ) {
					Data::update( 'aq_videos', $fields, [ 'video' => $vid ] );
				} else {
					Data::insert( 'aq_videos', array_merge( [ 'video' => $vid, 'created' => $now, 'thumb' => self::thumb_url( $vid ) ], $fields ) );
				}
				// Hourly cumulative snapshot for the history monitor — all three raw metrics (idempotent per
				// hour bucket; compact_stats folds buckets beyond KEEP_HOURLY_DAYS down to one per day).
				Data::upsert( 'aq_video_stats', [ 'video' => $vid, 'day' => $bucket ], [ 'views' => $views, 'view_count' => $vcount, 'like_count' => $lcount ] );
				$done++;
			}
		}
		self::recompute_trends_for_videos( $ids );
		return $done;
	}

	/** Hourly history buckets are kept this many days before being folded to one per UTC day. */
	const KEEP_HOURLY_DAYS = 7;

	/**
	 * Cron (daily, rides aq_video_sync): compact hourly history buckets older than KEEP_HOURLY_DAYS
	 * down to each UTC day's LAST bucket — the end-of-day cumulative, exactly the pre-hourly storage
	 * shape. Recent charts keep hourly resolution (ticket #74) without the series growing 24×
	 * forever; the read-side rate math (delta ÷ actual elapsed hours) is granularity-agnostic, so a
	 * mixed hourly/daily series reads cleanly. Idempotent: an already-compacted day keeps its one row.
	 */
	public static function compact_stats() {
		global $wpdb;
		$cut  = time() - self::KEEP_HOURLY_DAYS * DAY_IN_SECONDS;
		$cut -= $cut % 86400; // whole-day boundary — never split a day into kept + compacted halves
		foreach ( [ 'aq_video_stats' => 'video', 'aq_course_stats' => 'course_id' ] as $table => $key ) {
			$t = Data::t( $table );
			// Keep each (entity, UTC day)'s newest bucket (buckets append in id order), drop the rest.
			// The derived-table wrap lets MySQL delete from the table it selects from (error 1093),
			// and the same statement runs unchanged on the SQLite dev integration.
			$wpdb->query( $wpdb->prepare(
				"DELETE FROM {$t} WHERE day < %d AND id NOT IN (
					SELECT keep_id FROM (
						SELECT MAX(id) AS keep_id FROM {$t} WHERE day < %d GROUP BY {$key}, day - ( day %% 86400 )
					) k )",
				$cut, $cut
			) );
		}
	}

	// ── YouTube Data API ──────────────────────────────────────────────────────

	/**
	 * One videos.list call for up to CHUNK ids → [ videoId => viewCount ] on a successful (HTTP 200)
	 * response (ids the API omits — deleted/private — are simply absent from the map, even {} for a
	 * whole-batch of dead ids). Returns NULL on any transport / quota / auth FAILURE, so the caller
	 * can tell "the call failed, leave these videos alone and retry" apart from "the call succeeded,
	 * these specific ids are gone" — the difference between a transient blip and a real deletion.
	 */
	public static function fetch_stats( $ids ) {
		$ids = array_slice( array_values( array_filter( array_map( 'strval', (array) $ids ) ) ), 0, self::CHUNK );
		if ( ! $ids ) { return []; }
		$url = 'https://www.googleapis.com/youtube/v3/videos?part=statistics&maxResults=50'
			. '&id=' . rawurlencode( implode( ',', $ids ) );
		$args = [ 'timeout' => 15 ];
		$key  = self::api_key();
		if ( $key !== '' ) {
			$url .= '&key=' . rawurlencode( $key ); // simple Data-API key
		} else {
			$tok = self::access_token();             // service-account OAuth
			if ( $tok === '' ) { return null; }      // token mint failed → whole-call failure
			$args['headers'] = [ 'Authorization' => 'Bearer ' . $tok ];
		}
		$res = wp_remote_get( $url, $args );
		if ( is_wp_error( $res ) ) {
			error_log( '[ArtaQuest] YouTube API transport error: ' . $res->get_error_message() );
			return null;
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		if ( $code !== 200 ) {
			// 403 = quota exceeded / key disabled; 400 = bad request. Back off this run (don't touch the batch).
			error_log( '[ArtaQuest] YouTube API HTTP ' . $code . ': ' . substr( (string) wp_remote_retrieve_body( $res ), 0, 300 ) );
			return null;
		}
		$body = json_decode( (string) wp_remote_retrieve_body( $res ), true );
		if ( ! is_array( $body ) || ! isset( $body['items'] ) ) { return null; } // unparseable 200 → treat as failure
		$out = [];
		foreach ( $body['items'] as $it ) {
			$vid = (string) ( $it['id'] ?? '' );
			if ( $vid === '' ) { continue; }
			// RAW analytics (operator 2026-06-21): capture commentCount + viewCount + likeCount together — all
			// three ride the SAME cheap `part=statistics` videos.list call (1 quota unit per 50 ids), so it's
			// free of extra quota (never the expensive per-video commentThreads.list). `c` (comments) remains
			// the comment-trending signal; `v`/`l` are the new raw view/like series. A disabled field → 0.
			$st = isset( $it['statistics'] ) && is_array( $it['statistics'] ) ? $it['statistics'] : [];
			$out[ $vid ] = [
				'c' => isset( $st['commentCount'] ) ? (int) $st['commentCount'] : 0,
				'v' => isset( $st['viewCount'] ) ? (int) $st['viewCount'] : 0,
				'l' => isset( $st['likeCount'] ) ? (int) $st['likeCount'] : 0,
			];
		}
		return $out;
	}

	// ── Top comment (discussion seeder) ───────────────────────────────────────

	/** Authed GET against the YouTube Data API (Data-API key or service-account bearer). Returns the
	 *  decoded body array on a 200, else null. Used by the comment-seeder reads. */
	private static function api_get( $url, $scope = 'https://www.googleapis.com/auth/youtube.readonly' ) {
		$args = [ 'timeout' => 15 ];
		$key  = self::api_key();
		if ( $key !== '' ) {
			$url .= ( strpos( $url, '?' ) !== false ? '&' : '?' ) . 'key=' . rawurlencode( $key );
		} else {
			$tok = self::access_token( $scope );
			if ( $tok === '' ) { return null; }
			$args['headers'] = [ 'Authorization' => 'Bearer ' . $tok ];
		}
		$res = wp_remote_get( $url, $args );
		if ( is_wp_error( $res ) ) { return null; }
		if ( (int) wp_remote_retrieve_response_code( $res ) !== 200 ) { return null; } // 403 = comments off / quota
		$b = json_decode( (string) wp_remote_retrieve_body( $res ), true );
		return is_array( $b ) ? $b : null;
	}

	/** The video's own channel id (the uploader), so the seeder can EXCLUDE the channel's own comment. */
	public static function video_channel_id( $vid ) {
		$b = self::api_get( 'https://www.googleapis.com/youtube/v3/videos?part=snippet&id=' . rawurlencode( (string) $vid ) );
		return (string) ( $b['items'][0]['snippet']['channelId'] ?? '' );
	}

	/**
	 * The HIGHEST-LIKED top-level comment on a video that is NOT from the uploader's channel — the
	 * "first comment" a viewer sees. Returns [ text, author, avatar, likes, url ] or null (comments
	 * disabled, none found, or the API isn't configured). Quota: 1 unit (videos.list snippet for the
	 * channel id) + 1 unit (commentThreads.list, ≤100 by relevance) per video — cheap, run sparingly.
	 */
	public static function top_comment( $vid ) {
		$vid = (string) $vid;
		if ( $vid === '' || ! self::enabled() ) { return null; }
		$ch  = self::video_channel_id( $vid ); // to drop the uploader's own comment (readonly scope)
		// commentThreads.list rejects youtube.readonly (403 insufficient scopes) — it needs force-ssl.
		$b   = self::api_get(
			'https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&order=relevance&maxResults=100&textFormat=plainText&videoId=' . rawurlencode( $vid ),
			'https://www.googleapis.com/auth/youtube.force-ssl'
		);
		if ( ! $b || empty( $b['items'] ) ) { return null; }
		$best = null;
		foreach ( $b['items'] as $it ) {
			$s = $it['snippet']['topLevelComment']['snippet'] ?? null;
			if ( ! is_array( $s ) ) { continue; }
			$auth_ch = (string) ( $s['authorChannelId']['value'] ?? '' );
			if ( $ch !== '' && $auth_ch === $ch ) { continue; } // the uploader/channel — never the seed
			$text = trim( (string) ( $s['textOriginal'] ?? $s['textDisplay'] ?? '' ) );
			if ( $text === '' ) { continue; }
			$likes = (int) ( $s['likeCount'] ?? 0 );
			if ( $best === null || $likes > $best['likes'] ) {
				$best = [
					'text'   => mb_substr( $text, 0, 1200 ),
					'author' => sanitize_text_field( (string) ( $s['authorDisplayName'] ?? '' ) ),
					'avatar' => esc_url_raw( (string) ( $s['authorProfileImageUrl'] ?? '' ) ),
					'likes'  => $likes,
					'url'    => 'https://www.youtube.com/watch?v=' . $vid . ( isset( $it['id'] ) ? '&lc=' . rawurlencode( (string) $it['id'] ) : '' ),
				];
			}
		}
		return $best;
	}

	// ── Channel identity (logo) ───────────────────────────────────────────────

	/** Channel-logo cache option prefix — one option per DISTINCT channel URL (autoload=false). */
	const CHAN_OPT = 'aq_yt_chan_';

	/** Re-resolve a found logo monthly (they rarely change); retry a failed lookup daily. */
	const CHAN_TTL_HIT  = 2592000;
	const CHAN_TTL_MISS = 86400;

	/**
	 * The ACTUAL channel logo behind a channel URL — resolved lazily on read (ticket #50: imported
	 * yt meta carries channel_url but usually no avatar, leaving course/lesson headers logo-less).
	 * Two strategies, both bounded: the Data API (channels.list, 1 quota unit) when the URL form is
	 * addressable and credentials are configured; else — or when that yields nothing — the channel
	 * page's public og:image, which IS the logo. The result is cached per CHANNEL in an
	 * aq_yt_chan_<hash> option (a hit re-resolves monthly, a miss retries daily), so the external
	 * call amortises to once per channel, never per pageview. Fail-open: any failure returns the
	 * last known logo or '' (the client falls back to its initials disc) and never blocks the page
	 * beyond the bounded timeouts. Test seam: the `aq_yt_channel_avatar` filter (no network in CI).
	 */
	public static function channel_avatar( $url ) {
		$url = trim( (string) $url );
		if ( $url === '' || ! preg_match( '~^https?://(www\.|m\.)?youtube\.com/~i', $url ) ) { return ''; }
		$mock = apply_filters( 'aq_yt_channel_avatar', null, $url );
		if ( $mock !== null ) { return (string) $mock; }
		$key = self::CHAN_OPT . md5( strtolower( $url ) );
		$c   = get_option( $key );
		if ( is_array( $c ) && isset( $c['avatar'], $c['fetched'] ) ) {
			$ttl = $c['avatar'] !== '' ? self::CHAN_TTL_HIT : self::CHAN_TTL_MISS;
			if ( time() - (int) $c['fetched'] < $ttl ) { return (string) $c['avatar']; }
		}
		$avatar = self::fetch_channel_avatar( $url );
		if ( $avatar === '' && is_array( $c ) && ! empty( $c['avatar'] ) ) {
			$avatar = (string) $c['avatar']; // transient failure — keep the last known logo
		}
		update_option( $key, [ 'avatar' => $avatar, 'fetched' => time() ], false );
		return $avatar;
	}

	/**
	 * One resolution attempt (≤2 bounded HTTP calls): Data API by /channel/UC… id, @handle or
	 * legacy /user/ name where possible, then the channel page's og:image. '' when neither works.
	 */
	private static function fetch_channel_avatar( $url ) {
		$path  = (string) parse_url( $url, PHP_URL_PATH );
		$param = '';
		if ( preg_match( '~^/channel/(UC[0-9A-Za-z_-]{10,})~', $path, $m ) ) {
			$param = 'id=' . rawurlencode( $m[1] );
		} elseif ( preg_match( '~^/(@[A-Za-z0-9._-]+)~', $path, $m ) ) {
			$param = 'forHandle=' . rawurlencode( $m[1] );
		} elseif ( preg_match( '~^/user/([A-Za-z0-9._-]+)~', $path, $m ) ) {
			$param = 'forUsername=' . rawurlencode( $m[1] );
		}
		if ( $param !== '' && self::enabled() ) {
			$api  = 'https://www.googleapis.com/youtube/v3/channels?part=snippet&' . $param;
			$args = [ 'timeout' => 8 ];
			$k    = self::api_key();
			if ( $k !== '' ) {
				$api .= '&key=' . rawurlencode( $k );
			} else {
				$tok = self::access_token();
				if ( $tok === '' ) { $api = ''; } else { $args['headers'] = [ 'Authorization' => 'Bearer ' . $tok ]; }
			}
			if ( $api !== '' ) {
				$res = wp_remote_get( $api, $args );
				if ( ! is_wp_error( $res ) && 200 === (int) wp_remote_retrieve_response_code( $res ) ) {
					$b = json_decode( (string) wp_remote_retrieve_body( $res ), true );
					$t = $b['items'][0]['snippet']['thumbnails'] ?? null;
					$a = (string) ( $t['medium']['url'] ?? $t['default']['url'] ?? '' );
					if ( $a !== '' ) { return esc_url_raw( $a ); }
				} else {
					error_log( '[ArtaQuest] YouTube channels.list failed for ' . $url . ': '
						. ( is_wp_error( $res ) ? $res->get_error_message() : 'HTTP ' . wp_remote_retrieve_response_code( $res ) ) );
				}
			}
		}
		// No credentials / unaddressable URL form (/c/<name>) / API yielded nothing → the channel
		// page's public og:image is the same logo. Bounded: YouTube inlines big script blobs before
		// the meta tags (~640 KB deep in the wild), so cap the read at 2 MB rather than head-size.
		$res = wp_remote_get( $url, [
			'timeout'             => 8,
			'redirection'         => 3,
			'limit_response_size' => 2097152,
			'user-agent'          => 'Mozilla/5.0 (compatible; ArtaQuestBot/1.0; +https://artaquest.com)',
		] );
		if ( ! is_wp_error( $res ) && 200 === (int) wp_remote_retrieve_response_code( $res ) ) {
			$html = (string) wp_remote_retrieve_body( $res );
			if ( preg_match( '~<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']~i', $html, $m )
				|| preg_match( '~<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']~i', $html, $m ) ) {
				return esc_url_raw( html_entity_decode( $m[1], ENT_QUOTES ) );
			}
		}
		return '';
	}

	// ── Registry sync + trend recompute ───────────────────────────────────────

	/**
	 * Ensure every DISTINCT video referenced by a section has an aq_videos row. Called on import and
	 * on schedule; new videos get a next_refresh jittered across the next hour (so a bulk import
	 * doesn't clump on one cron run) and carry the import-time view count as their starting snapshot.
	 */
	public static function sync_registry() {
		$now  = time();
		$rows = Data::all(
			'SELECT DISTINCT l.video AS video FROM ' . Data::t( 'aq_lessons' ) . ' l
			 LEFT JOIN ' . Data::t( 'aq_videos' ) . ' v ON v.video = l.video
			 WHERE l.video <> "" AND l.video_type = "youtube" AND v.video IS NULL'
		);
		foreach ( $rows as $r ) {
			$vid   = (string) $r['video'];
			$m     = get_option( 'aq_yt_meta_' . $vid );
			$views = ( is_array( $m ) && isset( $m['views'] ) ) ? (int) $m['views'] : 0;
			Data::insert( 'aq_videos', [
				'video' => $vid, 'views' => $views, 'rate' => 0, 'thumb' => self::thumb_url( $vid ),
				'next_refresh' => $now + wp_rand( 0, self::INTERVAL ), 'last_refresh' => 0, 'missing' => 0, 'created' => $now,
			] );
		}
		return count( $rows );
	}

	/** Recompute the trend of every course that references any of the given videos. */
	public static function recompute_trends_for_videos( $ids ) {
		$ids = array_values( array_filter( array_map( 'strval', (array) $ids ) ) );
		if ( ! $ids ) { return; }
		global $wpdb;
		$place = implode( ',', array_fill( 0, count( $ids ), '%s' ) );
		$cids  = $wpdb->get_col( $wpdb->prepare(
			'SELECT DISTINCT course_id FROM ' . Data::t( 'aq_lessons' ) . " WHERE video IN ($place)", $ids ) );
		foreach ( (array) $cids as $cid ) { self::recompute_course_trend( (int) $cid ); }
	}

	/**
	 * Recompute a course's denormalized view metrics over its DISTINCT videos: `trend` = SUM of the
	 * 24h `rate` (the course's daily view velocity), `views` = SUM of the cumulative view counts, and
	 * `rank_score` = that same daily velocity — the catalogue ranking key (ticket #19: rank by daily
	 * rate, not all-time views, so newer/fast-rising courses rank fairly). Counting DISTINCT videos
	 * keeps a course honest when several sections are segments of ONE long video (chess course style):
	 * that shared video's rate is counted once, not once per section, so padding one long video across
	 * many sections can't inflate the velocity — no per-video division is needed.
	 */
	/** Trailing window (28 days) over which a video's comment rate is AVERAGED — the comments it gained
	 *  in the last 28 days ÷ 28 = a smooth per-day rate (operator 2026-06-15: a 4-week roll, far steadier
	 *  than the old single-day count; a quiet day no longer drops a video to zero). RATE_MIN_AGE is kept
	 *  for reference: a video earns no rate on its very first refresh (no history to difference yet). */
	const RATE_DAYS   = 28;                               // average over the last 28 days
	const RATE_WINDOW = self::RATE_DAYS * DAY_IN_SECONDS; // 28-day rolling window — "/day" = its count ÷ 28
	const RATE_MIN_AGE = HOUR_IN_SECONDS;                 // a video earns no rate until its second refresh

	/**
	 * One video's ROLLING 28-DAY comment rate, ×100 (centi-comments per day) — the comments it gained
	 * over the trailing RATE_WINDOW (28 days) ÷ RATE_DAYS, read from its aq_video_stats history: the
	 * live count ($views, the minuend) minus the newest snapshot at or before now−28d. When the video
	 * is younger than the window (no such snapshot) the EARLIEST snapshot is subtracted instead — its
	 * whole tracked life so far IS the window (÷28 still, so it ramps in as history fills). With no
	 * history at all (the very first refresh, still on the seed/import baseline) the rate is 0: the
	 * measurement warm-up, so a freshly-tracked video can't spike. ×100 keeps a course's per-video
	 * AVERAGE orderable in the INT rank_score column. A 28-day average (not a single day) because comment
	 * arrival is bursty — a quiet day no longer reads as "dead"; only 28 quiet days do. Called from
	 * refresh_ids BEFORE the current bucket is written, so the current count never shadows its baseline.
	 */
	private static function video_day_rate( $vid, $views, $now ) {
		$row = Data::one(
			'SELECT day, views FROM ' . Data::t( 'aq_video_stats' ) . ' WHERE video = %s AND day <= %d ORDER BY day DESC LIMIT 1',
			[ $vid, $now - self::RATE_WINDOW ] );
		if ( ! $row ) {
			// Younger than the window — measure over the WHOLE tracked life (earliest snapshot). Measuring
			// from the earliest bucket is the UNBIASED estimator: E[Δcomments / elapsed] = the true rate,
			// for any window length. (Measuring from the first non-zero bucket instead would divide by a
			// shorter span and bias the rate HIGH.)
			$row = Data::one(
				'SELECT day, views FROM ' . Data::t( 'aq_video_stats' ) . ' WHERE video = %s ORDER BY day ASC LIMIT 1',
				[ $vid ] );
		}
		$rate = 0;
		if ( $row ) {
			$delta = max( 0, (int) $views - (int) $row['views'] );
			// Divide by the ACTUAL elapsed time — NOT a 1-day floor. That floor WAS the bias: while a video had
			// under a day of history it divided a partial count by a whole day, systematically understating the
			// rate, so every fresh series ramped up out of zero. The true-window quotient is an UNBIASED estimate
			// at every point — a short window is merely HIGH-VARIANCE (few samples), not biased. The only floor
			// is 1 hour, purely to avoid a divide-by-zero on a same-hour bucket.
			$days  = max( HOUR_IN_SECONDS / DAY_IN_SECONDS, ( $now - (int) $row['day'] ) / DAY_IN_SECONDS );
			$rate  = (int) round( $delta * 100 / $days );
		}
		// NEVER read 0/day next to real discussion (operator directive 2026-06-18). When the trailing-window
		// rate is 0 — the comments predate our tracking (a just-imported video) or all arrived before the
		// window — fall back to the LIFETIME average: total comments ÷ days since the video was UPLOADED (an
		// honest "this content has averaged X comments/day over its life"). Then floor any video that HAS
		// comments at 0.05/day so it can never render "0/day" beside a non-zero comment total. A genuinely
		// comment-less video ($views 0) stays 0 — the only kind the zero-rate purge now removes.
		$views = (int) $views;
		if ( $rate <= 0 && $views > 0 ) {
			$up = self::video_upload_ts( $vid );
			if ( $up > 0 && $up < $now ) {
				$rate = (int) round( $views * 100 / max( 1.0, ( $now - $up ) / DAY_IN_SECONDS ) );
			}
		}
		if ( $views > 0 ) { $rate = max( $rate, 5 ); } // ≥0.05/day → renders ≥0.1/day; never 0 for a commented video
		return $rate;
	}

	/** A video's YouTube upload time (unix), from its cached yt_meta option; 0 if unknown. */
	private static function video_upload_ts( $vid ) {
		$m = get_option( 'aq_yt_meta_' . $vid );
		return ( is_array( $m ) && ! empty( $m['upload_ts'] ) ) ? (int) $m['upload_ts'] : 0;
	}

	/**
	 * COMMENT-BASED TRENDING (operator rule 2026-06-13: moved off passive YouTube view counts onto
	 * actual discussion — the platform is discussion-first, so a course/video "trends" by how much
	 * conversation it sparks). The metric is a ROLLING 24-HOUR COMMENT RATE (ticket #95) — the comments
	 * a video draws over the trailing day — so the card reads a steady "X/day" instead of the noisy
	 * near-zero "0.x/hr" the old per-hour rate produced (most videos gain well under a comment an hour).
	 *
	 * A course's rank_score = the AVERAGE over its videos of each video's 28-day-rolling comment rate
	 * ×100 (×100 keeps fractional averages orderable in the INT column). This rewards engagement DENSITY —
	 * a course of 5 well-discussed videos beats one of 20 where only a few draw comments — and pairs with
	 * the churn cycle that holds each course near 5 videos. A single video's rate (aq_videos.rate, set by
	 * refresh_ids via video_day_rate) = the YouTube comments it gained over the trailing RATE_WINDOW
	 * (28 days) ÷ the days measured, read from its daily history. A video earns NO rate on its first refresh — the measurement warm-up,
	 * so a freshly-tracked video with a possibly-stale seed count can't spike. `trend` holds the course's
	 * TOTAL YouTube comments across its videos (display fallback + tiebreak); `views` is retained as a
	 * column but no longer maintained (the YouTube view monitor is retired).
	 *
	 * trend_reset: a composition change (add/remove/swap/retrim a video) stamps aq_courses.trend_reset,
	 * which restarts the course's CHART history (lesson-sync drops aq_course_stats). It no longer zeroes
	 * rank_score — the old 24h ranking cooldown was removed (2026-06-18): with the lifetime-floored rate a
	 * freshly-added video has a meaningful rate at once, so zeroing only buried actively-grown courses and
	 * made the catalogue sort disagree with the rate each card shows. rank_score is always the avg per-video
	 * rate ×100, so sort == display. Idempotent; safe on every section-comment write/delete + the full sweep.
	 */
	public static function recompute_course_trend( $cid ) {
		if ( ! $cid ) { return; }
		$now = time();
		// AVERAGE per-video rolling-24h comment count. Each DISTINCT source video carries its own
		// trailing-day comment count (aq_videos.rate, from the hourly API refresh) + its cumulative
		// comment count (aq_videos.views, repurposed to hold commentCount). A video shared across several
		// sections — segments of one upload — is counted ONCE (DISTINCT video), so padding one video
		// across many sections can't inflate the score. `missing` videos (deleted/comments-off) carry rate 0.
		$rows = Data::all(
			'SELECT DISTINCT l.video AS video, v.rate AS rate, v.views AS cnt, v.thumb AS thumb
			   FROM ' . Data::t( 'aq_lessons' ) . ' l
			   JOIN ' . Data::t( 'aq_videos' ) . " v ON v.video = l.video
			  WHERE l.course_id = %d AND l.video <> ''",
			[ $cid ] );
		$sum = 0.0; $n = 0; $total = 0;
		$top_rate = -1; $top_cnt = -1; $top_video = ''; $top_thumb = ''; // the course's highest-rated video → its thumbnail
		foreach ( (array) $rows as $r ) {
			$vrate = (int) $r['rate'];   // this video's trailing-24h comment count ×100 (centi-comments/day)
			$vcnt  = (int) $r['cnt'];    // its cumulative YouTube comment count
			$sum   += $vrate;
			$total += $vcnt;
			$n++;
			// UNIVERSAL RULE: a course's thumbnail is its HIGHEST-RATED video's thumbnail. Track the top
			// video by rate, tiebroken by cumulative comments then first-seen, so the pick is deterministic.
			if ( $vrate > $top_rate || ( $vrate === $top_rate && $vcnt > $top_cnt ) ) {
				$top_rate = $vrate; $top_cnt = $vcnt;
				$top_video = (string) $r['video']; $top_thumb = (string) $r['thumb'];
			}
		}
		$rate = $n > 0 ? $sum / $n : 0.0; // AVERAGE centi-comments/day across the course's distinct videos
		// rank_score = the course's avg per-video rate ×100, ALWAYS — NO 24h zeroing. The old cooldown held
		// this at 0 for a day after any video change (a freshly-added video had no measured rate yet), but
		// that is obsolete now video_day_rate gives a new video a meaningful rate immediately (its lifetime
		// average, floored). Zeroing only BURIED the courses ArtaCycle is actively growing and made the
		// catalogue SORT (rank_score) disagree with the rate each card SHOWS (live avg) — the listing looked
		// unsorted. trend_reset still restarts the chart history (lesson-sync drops aq_course_stats); it no
		// longer touches the ranking. So sort == display: the trending list orders by the visible "/day".
		$rank = (int) round( $rate ); // already ×100 (centi/day) — the card shows rank_score/100 "/day"
		$fields = [
			'trend'      => $total, // total YouTube comments across the course's videos (the card's count + tiebreak)
			'rank_score' => $rank,  // catalogue sort key = avg per-video trailing-comment rate ×100 (== the shown "/day")
			'trend_at'   => $now,
		];
		// The course thumbnail follows its highest-rated video (maintained here on every recompute, so it
		// tracks the most-discussed video over time). Fall back to deriving the URL when the stored thumb is
		// empty (pre-1.38.0 rows / non-refreshed); never blank a course that momentarily has no joined video.
		if ( $top_video !== '' ) {
			$img = $top_thumb !== '' ? $top_thumb : self::thumb_url( $top_video );
			if ( $img !== '' ) { $fields['image'] = $img; }
		}
		Data::update( 'aq_courses', $fields, [ 'id' => $cid ] );
		// Per-course history bucket (hour-aligned, idempotent; compact_stats folds old buckets to daily)
		// — the cumulative comment total over time feeds the course-header discussion-rate graph.
		Data::upsert( 'aq_course_stats', [ 'course_id' => $cid, 'day' => $now - ( $now % 3600 ) ], [ 'views' => $total ] );
	}

	/** Canonical thumbnail URL for a YouTube video id — maxresdefault, the catalogue's stored convention;
	 *  the FE (artaquest-web lib/img.ts) downsizes it to hqdefault for display, so a video missing a maxres
	 *  thumbnail never renders broken. Empty string for a non-11-char / non-YouTube id. */
	public static function thumb_url( $video_id ) {
		$id = (string) $video_id;
		return preg_match( '/^[A-Za-z0-9_-]{11}$/', $id ) ? "https://i.ytimg.com/vi/{$id}/maxresdefault.jpg" : '';
	}

	/** Recompute the comment-based rank for EVERY published course — a cheap periodic safety sweep
	 *  (the write-time recompute keeps it live; this catches any drift, e.g. a missed bump). */
	public static function recompute_all_trends() {
		foreach ( (array) Data::all( 'SELECT id FROM ' . Data::t( 'aq_courses' ) . " WHERE status = 'publish'" ) as $r ) {
			self::recompute_course_trend( (int) $r['id'] );
		}
	}

	/**
	 * Recompute EVERY video's rate from its stored snapshots + comment count (video_day_rate) WITHOUT a
	 * YouTube API call, then refresh all course trends. Used to apply a rate-formula change immediately —
	 * e.g. the never-0/day lifetime floor (2026-06-18) — to the whole catalogue instead of waiting for the
	 * daily refresh to revisit each video. Returns the number of videos recomputed.
	 */
	public static function recompute_all_rates() {
		global $wpdb; $p = $wpdb->prefix; $now = time();
		$n = 0;
		foreach ( (array) $wpdb->get_results( "SELECT video, views FROM {$p}aq_videos" ) as $r ) {
			Data::update( 'aq_videos', [ 'rate' => self::video_day_rate( (string) $r->video, (int) $r->views, $now ) ], [ 'video' => (string) $r->video ] );
			$n++;
		}
		self::recompute_all_trends();
		return $n;
	}

	/**
	 * AUTO-PURGE (cron `aq_purge_zero_rate`, daily; operator policy 2026-06-15): permanently remove
	 * every video that has drawn NO comments in the last 28 days — rate=0 AND tracked ≥28 days, so a
	 * video is only purged once it has had a full four-week window to draw discussion (a freshly-added
	 * video, whose rate is 0 only until enough history accrues, is never purged prematurely). Each such
	 * video's lessons + their boards/votes/progress go; any course then left with no videos is deleted
	 * AND tombstoned (so a deploy can't resurrect it); surviving courses get recomputed. Then the video
	 * rows/stats/cached-meta are purged. Bounded per run ($limit), so a large backlog drains over several
	 * days instead of timing out a single cron request. Returns a count summary.
	 *
	 * NOTE: with a 28-day window, rate=0 means genuinely zero comments in four weeks — only truly dead
	 * videos qualify, so this converges the catalogue on videos that still draw discussion without
	 * culling ones that merely had a quiet day.
	 */
	public static function purge_zero_rate( $limit = 500 ) {
		global $wpdb; $p = $wpdb->prefix; $now = time();
		// Only purge TRULY comment-less videos (views = 0): a video that has any comments now reports a
		// floored lifetime rate (video_day_rate), so rate=0 alone no longer means "dead" — require views=0
		// too, so the never-0/day floor can't be undone by a purge of a quiet-but-discussed video.
		$zvids = $wpdb->get_col( $wpdb->prepare(
			"SELECT video FROM {$p}aq_videos WHERE rate = 0 AND views = 0 AND created > 0 AND created < %d ORDER BY created ASC LIMIT %d",
			$now - self::RATE_WINDOW, (int) $limit ) );
		$purgedV = 0; $delLessons = 0; $delCourses = 0; $touched = [];
		if ( $zvids ) {
			$lids = [];
			foreach ( array_chunk( $zvids, 100 ) as $vchunk ) {
				$ph = implode( ',', array_fill( 0, count( $vchunk ), '%s' ) );
				foreach ( $wpdb->get_results( $wpdb->prepare( "SELECT id, course_id FROM {$p}aq_lessons WHERE video IN ($ph)", $vchunk ) ) as $l ) {
					$lids[] = (int) $l->id; $touched[ (int) $l->course_id ] = true;
				}
			}
			foreach ( array_chunk( $lids, 200 ) as $chunk ) {
				$in = implode( ',', array_map( 'intval', $chunk ) );
				$wpdb->query( "DELETE FROM {$p}aq_votes WHERE target_type='comment' AND target_id IN (SELECT id FROM {$p}aq_comments WHERE context_type='section' AND context_id IN ($in))" );
				$wpdb->query( "DELETE FROM {$p}aq_comments WHERE context_type='section' AND context_id IN ($in)" );
				$wpdb->query( "DELETE FROM {$p}aq_progress WHERE lesson_id IN ($in)" );
				$wpdb->query( "DELETE FROM {$p}aq_lessons WHERE id IN ($in)" );
				$delLessons += count( $chunk );
			}
			foreach ( array_chunk( $zvids, 100 ) as $vchunk ) {
				$ph = implode( ',', array_fill( 0, count( $vchunk ), '%s' ) );
				$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_video_stats WHERE video IN ($ph)", $vchunk ) );
				$purgedV += (int) $wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_videos WHERE video IN ($ph)", $vchunk ) );
				foreach ( $vchunk as $v ) { delete_option( "aq_yt_meta_$v" ); }
			}
		}
		foreach ( array_keys( $touched ) as $cid ) {
			$left = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$p}aq_lessons WHERE course_id=%d AND video<>''", $cid ) );
			if ( $left === 0 ) {
				$slug = $wpdb->get_var( $wpdb->prepare( "SELECT slug FROM {$p}aq_courses WHERE id=%d", $cid ) );
				$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_votes WHERE target_type='comment' AND target_id IN (SELECT id FROM {$p}aq_comments WHERE context_type='section' AND context_id IN (SELECT id FROM {$p}aq_lessons WHERE course_id=%d))", $cid ) );
				$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_comments WHERE context_type='section' AND context_id IN (SELECT id FROM {$p}aq_lessons WHERE course_id=%d)", $cid ) );
				foreach ( [ 'aq_progress', 'aq_enroll', 'aq_reviews', 'aq_quester', 'aq_course_stats', 'aq_lessons' ] as $t ) { $wpdb->delete( "{$p}$t", [ 'course_id' => $cid ] ); }
				$wpdb->delete( "{$p}aq_courses", [ 'id' => $cid ] );
				if ( $slug ) { Extra::tombstone_course( (string) $slug ); }
				$delCourses++;
			} else {
				$i = 0;
				foreach ( $wpdb->get_col( $wpdb->prepare( "SELECT id FROM {$p}aq_lessons WHERE course_id=%d ORDER BY idx ASC, id ASC", $cid ) ) as $lid ) { $i++; $wpdb->update( "{$p}aq_lessons", [ 'idx' => $i ], [ 'id' => (int) $lid ] ); }
				$dur = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COALESCE(SUM(duration),0) FROM {$p}aq_lessons WHERE course_id=%d", $cid ) );
				$wpdb->update( "{$p}aq_courses", [ 'lesson_count' => $i, 'duration' => $dur ], [ 'id' => $cid ] );
				self::recompute_course_trend( $cid );
			}
		}
		if ( $purgedV || $delCourses ) { error_log( "[aq_purge_zero_rate] videos=$purgedV lessons=$delLessons courses=$delCourses" ); }
		return [ 'videos' => $purgedV, 'lessons' => $delLessons, 'courses' => $delCourses ];
	}

	// ════════════════════════════════════════════════════════════════════════════════════════════════
	// DATA-API DISCOVERY + CHURN (operator 2026-06-21) — "search all topics each cycle, add promising
	// candidates, drop the persistent lows; maximise total discussion = (#videos) × (avg discussion rate)."
	//
	// A deterministic, quota-budgeted prod pipeline of three crons that OWNS the video lifecycle (it
	// supersedes the engine's LLM-driven grow/settle, which were narrow + flaky):
	//
	//   1. discover (aq_discover, hourly) — ROTATE search.list across every published course, ≤DISCOVER_PER_RUN
	//      per run and ≤DISCOVER_DAILY_CAP/day (a hard fail-safe so a runaway cron can never exhaust the 10k/day
	//      Google quota). For each course it searches its subject, filters to a genuinely NEW, embeddable, public,
	//      ≥2-min, comment-bearing video the catalogue has never seen, and TRACKS the most-discussed on-topic one
	//      as a CANDIDATE — a standalone aq_videos row (cand_course = the target course, cand_until = now+24h,
	//      cand_baseline = the course's avg rate at track time). The ordinary hourly monitor measures it like any
	//      other video, so after 24h its `rate` is a real comment velocity.
	//   2. settle (aq_settle_candidates, hourly) — PROVE-THEN-ADD. A ripe candidate whose measured rate ≥ its
	//      baseline (and > 0) is ADDED to the course (adding a ≥-average video provably raises/holds the average);
	//      anything weaker is DISCARDED. The course is never changed on an unproven video.
	//   3. prune (aq_prune, daily) — DROP the persistent lows: for a course with MORE than PRUNE_GATE videos,
	//      remove any whose rate sits below (mean − PRUNE_SIGMA·σ) of the course's own video-rate distribution,
	//      never below a PRUNE_MIN_VIDEOS floor.
	//
	// All adds/removes go through the ONE choke point aq_sync_lessons (id-preserving, cross-course-unique).
	// ════════════════════════════════════════════════════════════════════════════════════════════════

	/** search.list costs 100 quota units — the only expensive call here, so the budget is counted in SEARCHES. */
	const SEARCH_UNITS = 100;
	/** HARD daily ceiling on search.list calls. Conservative: 60 × 100 = 6000 units/day, which with the
	 *  monitor (~530/day) + seeder leaves comfortable headroom under the 10k/day Google quota. At 60/day the
	 *  rotation covers ~139 published courses every ~2.3 days — "don't miss a trending video" without ever
	 *  risking the quota the rate monitor itself depends on. Raise (and request more quota) as the catalogue grows. */
	const DISCOVER_DAILY_CAP = 60;
	/** Courses searched per hourly run. 3 × 24h = 72 attempts/day, but DISCOVER_DAILY_CAP is the real limit. */
	const DISCOVER_PER_RUN = 3;
	/** A candidate incubates this long (measured by the ordinary monitor) before settle judges its rate. */
	const CAND_INCUBATE = DAY_IN_SECONDS;
	/** Reject Shorts / clips — a real teaching video runs at least this long. */
	const CAND_MIN_SECONDS = 120;
	/** How many results to ask search.list for (1 unit either way; a wider net = more candidates to pick the
	 *  most-discussed, most-popular one from, and better odds of a FRESH on-topic pick the catalogue lacks). */
	const CAND_SEARCH_MAX = 25;
	/** prune only considers a course with MORE than this many distinct videos (per the operator's drop rule). */
	const PRUNE_GATE = 5;
	/** prune never shrinks a course below this many videos, whatever the distribution says. */
	const PRUNE_MIN_VIDEOS = 2;
	/** A video is a "persistent low" when its rate is more than this many σ below its course's mean. */
	const PRUNE_SIGMA = 2.0;
	/** GROW phase: a course with FEWER than this many videos is built out aggressively — settle adds any
	 *  genuinely-active candidate (rate ≥ GROW_MIN_RATE), even below the course average, because total
	 *  discussion (Σ video rates, the platform goal) rises with every active video added. At/over this it
	 *  switches to MAINTAIN (add only ≥ the course average). 135 of 139 courses sit under it — the catalogue
	 *  is mostly thin (82 single-video courses), so this is the dominant lever on total discussion. */
	const GROW_TARGET = 5;
	/** GROW-phase activity bar: centi-comments/day (100 = 1 comment/day). Below this a video is near-dead and
	 *  adds nothing worth a board, so it is never added even to a thin course. */
	const GROW_MIN_RATE = 100;

	// ── Quota budget (search.list calls/day) ─────────────────────────────────────

	/** Number of search.list calls already made TODAY (UTC). Resets automatically at the date rollover. */
	public static function discover_searches_today() {
		$o = get_option( 'aq_yt_discover_count' );
		$today = (int) gmdate( 'Ymd' );
		return ( is_array( $o ) && (int) ( $o['day'] ?? 0 ) === $today ) ? (int) ( $o['n'] ?? 0 ) : 0;
	}

	/** RESERVE one search.list call against today's budget (count BEFORE the call so the cap can never be
	 *  exceeded even if a call later fails). Returns the new running count. */
	private static function note_discover_search() {
		$today = (int) gmdate( 'Ymd' );
		$n = self::discover_searches_today() + 1;
		update_option( 'aq_yt_discover_count', [ 'day' => $today, 'n' => $n ], false );
		return $n;
	}

	/** OPERATOR-SETTABLE daily search.list ceiling (Studio Console → option aq_discover_cap; default the
	 *  const). CLAMPED to [0,90]: 90×100 = 9000 units still leaves the rate monitor's budget under the
	 *  10k/day quota, and 0 cleanly PAUSES discovery (the master off-switch) without unscheduling the cron. */
	public static function discover_cap() {
		return max( 0, min( 90, (int) get_option( 'aq_discover_cap', self::DISCOVER_DAILY_CAP ) ) );
	}

	/** OPERATOR-SETTABLE courses searched per discover run (option aq_discover_per_run; default the const),
	 *  clamped to [1,10] so a typo can't make one run blow the daily cap in a single tick. */
	public static function discover_per_run() {
		return max( 1, min( 10, (int) get_option( 'aq_discover_per_run', self::DISCOVER_PER_RUN ) ) );
	}

	// ── Data-API reads (search.list, video_details) ──────────────────────────────

	/**
	 * One search.list call (100 quota units) for fresh, embeddable, family-safe videos matching $query.
	 * RESERVES a unit of the daily budget FIRST (so the hard cap holds even on a failed call), then returns
	 * a list of [ 'id', 'title', 'published' ] (newest snippet fields), or NULL when disabled / over budget /
	 * the call failed (so the caller treats "no data" as skip, never as "nothing exists").
	 */
	public static function search_topic( $query, $max = self::CAND_SEARCH_MAX ) {
		$query = trim( (string) $query );
		if ( $query === '' || ! self::enabled() ) { return null; }
		if ( self::discover_searches_today() >= self::discover_cap() ) { return null; } // budget exhausted — fail-safe
		self::note_discover_search();
		$url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video'
			. '&maxResults=' . max( 1, min( 50, (int) $max ) )
			. '&videoEmbeddable=true&safeSearch=strict&relevanceLanguage=en&order=relevance'
			. '&q=' . rawurlencode( $query );
		$b = self::api_get( $url );
		if ( ! is_array( $b ) || ! isset( $b['items'] ) ) { return null; }
		$out = [];
		foreach ( $b['items'] as $it ) {
			$vid = (string) ( $it['id']['videoId'] ?? '' );
			if ( $vid === '' ) { continue; }
			$out[] = [
				'id'        => $vid,
				'title'     => (string) ( $it['snippet']['title'] ?? '' ),
				'published' => isset( $it['snippet']['publishedAt'] ) ? (int) strtotime( (string) $it['snippet']['publishedAt'] ) : 0,
			];
		}
		return $out;
	}

	/**
	 * videos.list?part=contentDetails,statistics,status for up to CHUNK ids (1 unit) → [ id => [seconds,
	 * comments, embeddable, public] ]. Lets discover apply the exact duration / comments / embeddable /
	 * public filters search.list can't express. NULL on failure.
	 */
	public static function video_details( $ids ) {
		$ids = array_slice( array_values( array_filter( array_map( 'strval', (array) $ids ) ) ), 0, self::CHUNK );
		if ( ! $ids ) { return []; }
		$b = self::api_get( 'https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics,status&maxResults=50'
			. '&id=' . rawurlencode( implode( ',', $ids ) ) );
		if ( ! is_array( $b ) || ! isset( $b['items'] ) ) { return null; }
		$out = [];
		foreach ( $b['items'] as $it ) {
			$vid = (string) ( $it['id'] ?? '' );
			if ( $vid === '' ) { continue; }
			$out[ $vid ] = [
				'seconds'    => self::iso8601_seconds( (string) ( $it['contentDetails']['duration'] ?? '' ) ),
				'comments'   => isset( $it['statistics']['commentCount'] ) ? (int) $it['statistics']['commentCount'] : 0,
				'embeddable' => ! isset( $it['status']['embeddable'] ) || (bool) $it['status']['embeddable'],
				'public'     => ( $it['status']['privacyStatus'] ?? 'public' ) === 'public',
			];
		}
		return $out;
	}

	/**
	 * A playlist's video ids + titles (playlistItems.list?part=snippet, paginated, 1 unit/page, capped at
	 * $max). For the Studio "import a playlist" feature. Returns [ ['id','title'], … ] (deduped, in playlist
	 * order) or NULL on a failed/disabled call.
	 */
	public static function playlist_video_ids( $playlist_id, $max = 50 ) {
		$playlist_id = preg_replace( '/[^A-Za-z0-9_-]/', '', (string) $playlist_id );
		if ( $playlist_id === '' || ! self::enabled() ) { return null; }
		$out = []; $seen = []; $page = ''; $guard = 0;
		do {
			$url = 'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId='
				. rawurlencode( $playlist_id ) . ( $page !== '' ? '&pageToken=' . rawurlencode( $page ) : '' );
			$b = self::api_get( $url );
			if ( ! is_array( $b ) || ! isset( $b['items'] ) ) { return $out ? $out : null; } // first-page failure → null
			foreach ( $b['items'] as $it ) {
				$vid = (string) ( $it['snippet']['resourceId']['videoId'] ?? '' );
				if ( $vid !== '' && empty( $seen[ $vid ] ) ) { $seen[ $vid ] = true; $out[] = [ 'id' => $vid, 'title' => (string) ( $it['snippet']['title'] ?? '' ) ]; }
			}
			$page = (string) ( $b['nextPageToken'] ?? '' );
		} while ( $page !== '' && count( $out ) < $max && ++$guard < 10 );
		return array_slice( $out, 0, $max );
	}

	/** Parse an ISO-8601 duration (PT#H#M#S) to whole seconds. Pure — unit-tested. */
	public static function iso8601_seconds( $d ) {
		if ( ! preg_match( '/^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/', (string) $d, $m ) ) { return 0; }
		return (int) ( $m[1] ?? 0 ) * 3600 + (int) ( $m[2] ?? 0 ) * 60 + (int) ( $m[3] ?? 0 );
	}

	/**
	 * Choose the single best NEW candidate for a course from search results enriched with details. PURE
	 * (no I/O) so it is unit-tested. Filters to embeddable + public + ≥CAND_MIN_SECONDS + has comments,
	 * prefers titles sharing a significant (≥4-char) word with the course title (an on-topic nudge over
	 * the already-topical search), and among those picks the MOST-discussed (highest commentCount).
	 * $cands: [ ['id','title','seconds','comments','embeddable','public'], ... ]. Returns the id or ''.
	 */
	public static function pick_candidate( $course_title, array $cands, $now = 0 ) {
		$ok = [];
		foreach ( $cands as $c ) {
			if ( empty( $c['id'] ) ) { continue; }
			if ( (int) ( $c['seconds'] ?? 0 ) < self::CAND_MIN_SECONDS ) { continue; }
			if ( (int) ( $c['comments'] ?? 0 ) <= 0 ) { continue; }
			if ( ! ( $c['embeddable'] ?? true ) || ! ( $c['public'] ?? true ) ) { continue; }
			$ok[] = $c;
		}
		if ( ! $ok ) { return ''; }
		// Significant words of the course title (≥4 chars) → an on-topic relevance nudge.
		$words = [];
		foreach ( preg_split( '/[^a-z0-9]+/', strtolower( (string) $course_title ) ) as $w ) {
			if ( strlen( $w ) >= 4 ) { $words[ $w ] = true; }
		}
		$on_topic = [];
		foreach ( $ok as $c ) {
			$t = strtolower( (string) ( $c['title'] ?? '' ) );
			foreach ( $words as $w => $_ ) { if ( strpos( $t, $w ) !== false ) { $on_topic[] = $c; break; } }
		}
		$pool = $on_topic ?: $ok; // prefer on-topic; fall back to all valid (the search was already topical)
		usort( $pool, function ( $a, $b ) use ( $now ) { return self::cand_score( $b, $now ) <=> self::cand_score( $a, $now ); } );
		return (string) $pool[0]['id'];
	}

	/**
	 * A candidate's PRIORITY = estimated comment VELOCITY (cumulative comments ÷ age in days, age floored at
	 * 2 weeks so a brand-new clip can't score absurdly high), falling back to raw cumulative comments when the
	 * upload date is unknown. Picking by velocity instead of raw totals deprioritises OLD SATURATED videos
	 * (huge lifetime comment counts but ~0 recent discussion — the monitor showed discover was tracking 5-9
	 * year-old videos) in favour of ones still actively discussed, which is the signal the prove-then-add
	 * stage then measures for real. PURE — unit-tested. */
	private static function cand_score( $c, $now ) {
		$comments = (int) ( $c['comments'] ?? 0 );
		$pub = (int) ( $c['published'] ?? 0 );
		if ( $now > 0 && $pub > 0 && $pub < $now ) {
			return $comments / max( 14.0, ( $now - $pub ) / DAY_IN_SECONDS );
		}
		return (float) $comments;
	}

	// ── 1. discover (cron aq_discover) ───────────────────────────────────────────

	/**
	 * Rotate search.list across published courses and track the best NEW candidate video for each, up to
	 * the per-run + daily budgets. A persistent cursor (aq_discover_cursor = last course id touched) walks
	 * the catalogue in id order and wraps at the end, so over a few days every course is searched. No-ops
	 * cleanly when the API is unconfigured or the daily budget is spent. Records its last outcome (ts +
	 * counts) in aq_discover_last for the Studio Console monitor. Returns a small stats array.
	 */
	public static function discover( $per_run = null ) {
		$r = self::discover_run( $per_run );
		update_option( 'aq_discover_last', array_merge( [ 'ts' => time() ], $r ), false );
		return $r;
	}

	private static function discover_run( $per_run ) {
		if ( $per_run === null ) { $per_run = self::discover_per_run(); }
		if ( ! self::enabled() ) { return [ 'tracked' => 0, 'searched' => 0, 'reason' => 'disabled' ]; }
		if ( self::discover_searches_today() >= self::discover_cap() ) { return [ 'tracked' => 0, 'searched' => 0, 'reason' => 'budget' ]; }
		$cursor = (int) get_option( 'aq_discover_cursor', 0 );
		$courses = Data::all(
			'SELECT id, title, rank_score, search_terms FROM ' . Data::t( 'aq_courses' )
			. " WHERE status = 'publish' AND id > %d AND EXISTS ( SELECT 1 FROM " . Data::t( 'aq_lessons' )
			. ' l WHERE l.course_id = ' . Data::t( 'aq_courses' ) . ".id AND l.video <> '' )"
			// Skip a course that already has a candidate incubating — one experiment per course at a time, so
			// the rotation never piles a second candidate on it or wastes a search on it.
			. ' AND NOT EXISTS ( SELECT 1 FROM ' . Data::t( 'aq_videos' ) . ' cv WHERE cv.cand_course = ' . Data::t( 'aq_courses' ) . '.id )'
			. ' ORDER BY id ASC LIMIT %d',
			[ $cursor, max( 1, (int) $per_run ) ] );
		if ( ! $courses ) {
			update_option( 'aq_discover_cursor', 0, false ); // end of catalogue → wrap on the next run
			return [ 'tracked' => 0, 'searched' => 0, 'reason' => 'wrap' ];
		}
		$tracked = 0; $searched = 0; $last = $cursor;
		foreach ( $courses as $c ) {
			$last = (int) $c['id'];
			if ( self::discover_searches_today() >= self::discover_cap() ) { break; } // budget hit mid-run
			$one = self::discover_for_course( $c );
			$searched += (int) $one['searched'];
			if ( $one['tracked'] !== '' ) { $tracked++; }
			if ( $one['reason'] === 'no_budget' ) { break; } // search_topic refused (cap) → stop, keep the cursor
		}
		update_option( 'aq_discover_cursor', $last, false );
		return [ 'tracked' => $tracked, 'searched' => $searched, 'cursor' => $last ];
	}

	/**
	 * Search one course's TUNED keywords (Studio-editable aq_courses.search_terms, the lever for reaching the
	 * most popular videos on the subject; falls back to the title) and TRACK the best fresh candidate. Shared
	 * by the rotation (discover) and the per-course "find a video now" action (discover_course). Returns
	 * [ 'searched' => 0|1, 'tracked' => '<videoId>'|'', 'reason' => ... ]. $c: row {id,title,rank_score,search_terms}.
	 */
	private static function discover_for_course( $c ) {
		global $wpdb;
		$cid   = (int) $c['id'];
		$query = trim( (string) ( $c['search_terms'] ?? '' ) );
		if ( $query === '' ) { $query = (string) $c['title']; }
		$hits = self::search_topic( $query );
		if ( $hits === null ) { return [ 'searched' => 0, 'tracked' => '', 'reason' => 'no_budget' ]; }
		// Exclude every video the catalogue already knows (lesson videos, live candidates, handled orphans
		// — all carry an aq_videos row). One query, scoped to just this batch's hits.
		$ids = array_values( array_filter( array_unique( array_map( function ( $h ) { return (string) $h['id']; }, $hits ) ), 'strlen' ) );
		if ( ! $ids ) { return [ 'searched' => 1, 'tracked' => '', 'reason' => 'no_results' ]; }
		$ph    = implode( ',', array_fill( 0, count( $ids ), '%s' ) );
		$known = array_fill_keys( (array) $wpdb->get_col( $wpdb->prepare(
			'SELECT video FROM ' . Data::t( 'aq_videos' ) . " WHERE video IN ($ph)", array_values( $ids ) ) ), true );
		$fresh = array_values( array_filter( $hits, function ( $h ) use ( $known ) { return empty( $known[ (string) $h['id'] ] ); } ) );
		if ( ! $fresh ) { return [ 'searched' => 1, 'tracked' => '', 'reason' => 'all_known' ]; }
		$details = self::video_details( array_map( function ( $h ) { return $h['id']; }, $fresh ) );
		if ( ! is_array( $details ) ) { return [ 'searched' => 1, 'tracked' => '', 'reason' => 'no_details' ]; }
		$enriched = []; $pub = [];
		foreach ( $fresh as $h ) {
			$d = $details[ $h['id'] ] ?? null;
			if ( ! $d ) { continue; }
			$enriched[] = array_merge( $h, $d );
			$pub[ $h['id'] ] = (int) $h['published'];
		}
		$pick = self::pick_candidate( (string) $c['title'], $enriched, time() );
		if ( $pick === '' ) { return [ 'searched' => 1, 'tracked' => '', 'reason' => 'no_pick' ]; }
		$row = null;
		foreach ( $enriched as $e ) { if ( $e['id'] === $pick ) { $row = $e; break; } }
		if ( ! $row ) { return [ 'searched' => 1, 'tracked' => '', 'reason' => 'no_pick' ]; }
		self::track_candidate( $pick, $cid, (int) $c['rank_score'], (int) $row['seconds'],
			(string) $row['title'], (int) $row['comments'], (int) ( $pub[ $pick ] ?? 0 ) );
		return [ 'searched' => 1, 'tracked' => $pick, 'reason' => 'tracked' ];
	}

	/**
	 * "Find a video now" for ONE course (Studio per-course action): search its keywords and track the best
	 * fresh candidate immediately, to be proven over the 24h hold by settle like any other. Skips when a
	 * candidate is already incubating for the course (one experiment at a time) or the daily budget is spent.
	 * Respects the same hard quota fail-safe as the rotation. Returns a small result.
	 */
	public static function discover_course( $cid ) {
		$cid = (int) $cid;
		if ( ! self::enabled() ) { return [ 'tracked' => 0, 'reason' => 'disabled' ]; }
		$c = Data::one( 'SELECT id, title, rank_score, search_terms FROM ' . Data::t( 'aq_courses' ) . " WHERE id = %d AND status = 'publish'", [ $cid ] );
		if ( ! $c ) { return [ 'tracked' => 0, 'reason' => 'no_course' ]; }
		if ( Data::one( 'SELECT video FROM ' . Data::t( 'aq_videos' ) . ' WHERE cand_course = %d LIMIT 1', [ $cid ] ) ) { return [ 'tracked' => 0, 'reason' => 'incubating' ]; }
		if ( self::discover_searches_today() >= self::discover_cap() ) { return [ 'tracked' => 0, 'reason' => 'budget' ]; }
		$r = self::discover_for_course( $c );
		return [ 'tracked' => $r['tracked'] !== '' ? 1 : 0, 'video' => $r['tracked'], 'reason' => $r['reason'] ];
	}

	/**
	 * Track a discovered video as a CANDIDATE for $cid: a standalone aq_videos row carrying cand_course /
	 * cand_until / cand_baseline + an immediate first stats snapshot (so the 24h measurement window starts
	 * now), plus a meta option holding the title/duration/upload-time settle will need to build the lesson.
	 * The ordinary monitor then refreshes it like any video. Idempotent-ish: skips a video already tracked.
	 */
	private static function track_candidate( $vid, $cid, $baseline, $seconds, $title, $comments, $published = 0 ) {
		$vid = (string) $vid;
		if ( $vid === '' || Data::one( 'SELECT video FROM ' . Data::t( 'aq_videos' ) . ' WHERE video = %s', [ $vid ] ) ) { return; }
		$now = time();
		Data::insert( 'aq_videos', [
			'video'         => $vid,
			'views'         => (int) $comments, // commentCount baseline (the rate signal), as the monitor stores it
			'rate'          => 0,               // unmeasured until the monitor builds 24h of history
			'thumb'         => self::thumb_url( $vid ),
			'next_refresh'  => $now,            // measure on the very next monitor run
			'last_refresh'  => 0,
			'missing'       => 0,
			'created'       => $now,
			'cand_course'   => (int) $cid,
			'cand_until'    => $now + self::CAND_INCUBATE,
			'cand_baseline' => max( 0, (int) $baseline ),
		] );
		// Seed the history with the comment count NOW so the 24h delta is measured from track time.
		Data::upsert( 'aq_video_stats', [ 'video' => $vid, 'day' => $now - ( $now % 3600 ) ], [ 'views' => (int) $comments ] );
		update_option( 'aq_yt_meta_' . $vid, [
			'upload_ts' => (int) $published,
			'title'     => mb_substr( (string) $title, 0, 200 ),
			'duration'  => max( 0, (int) $seconds ),
		], false );
	}

	/** Delete a discarded candidate's registry row + history + meta — but never a video now backing a lesson. */
	private static function untrack_candidate( $vid ) {
		$vid = (string) $vid;
		if ( $vid === '' ) { return; }
		if ( Data::one( 'SELECT id FROM ' . Data::t( 'aq_lessons' ) . ' WHERE video = %s LIMIT 1', [ $vid ] ) ) {
			// Somehow now a lesson video — just clear the candidate marks, keep the row.
			Data::update( 'aq_videos', [ 'cand_course' => 0, 'cand_until' => 0, 'cand_baseline' => 0 ], [ 'video' => $vid ] );
			return;
		}
		global $wpdb;
		$wpdb->delete( Data::t( 'aq_video_stats' ), [ 'video' => $vid ] );
		$wpdb->delete( Data::t( 'aq_videos' ), [ 'video' => $vid ] );
		delete_option( 'aq_yt_meta_' . $vid );
	}

	/** Operator control (Studio Console): drop an incubating candidate before it ripens. Returns true if a
	 *  candidate was found + discarded. */
	public static function discard_candidate( $video ) {
		$video = (string) $video;
		if ( $video === '' || ! Data::one( 'SELECT video FROM ' . Data::t( 'aq_videos' ) . ' WHERE video = %s AND cand_course > 0', [ $video ] ) ) { return false; }
		self::untrack_candidate( $video );
		return true;
	}

	/** Operator control (Studio Console): force a candidate ripe NOW so the next settle judges it on its
	 *  measured-so-far rate (skip the rest of the 24h hold). Returns true if it was an incubating candidate. */
	public static function ripen_candidate( $video ) {
		$video = (string) $video;
		if ( $video === '' || ! Data::one( 'SELECT video FROM ' . Data::t( 'aq_videos' ) . ' WHERE video = %s AND cand_course > 0', [ $video ] ) ) { return false; }
		Data::update( 'aq_videos', [ 'cand_until' => time() - 1 ], [ 'video' => $video ] );
		return true;
	}

	// ── 2. settle (cron aq_settle_candidates) — PROVE-THEN-ADD ───────────────────

	/**
	 * Has a candidate proved itself, given its course's current size?
	 *   • GROW phase (course UNDER GROW_TARGET videos): add any genuinely-active video (rate ≥ GROW_MIN_RATE),
	 *     even one below the course average — building a thin course out toward the sweet spot GROWS total
	 *     discussion (Σ video rates, the platform goal), since the total rises by the added video's rate
	 *     regardless of the average. 135/139 courses are thin, so this is where growth happens.
	 *   • MAINTAIN phase (course AT/OVER the target): hold quality — add only a video at least as discussed as
	 *     the course's average (rate ≥ baseline), so a full course never dilutes itself.
	 * A dead video (rate ≤ 0) is never added. PURE — unit-tested. Default video_count keeps the strict
	 * (maintain) behaviour when a size isn't supplied. */
	public static function settle_decision( $rate, $baseline, $video_count = PHP_INT_MAX ) {
		$rate = (int) $rate;
		if ( $rate <= 0 ) { return false; }
		if ( (int) $video_count < self::GROW_TARGET ) { return $rate >= self::GROW_MIN_RATE; }
		return $rate >= (int) $baseline;
	}

	/**
	 * Judge every ripe candidate (cand_until elapsed): ADD the proved ones to their course via aq_sync_lessons
	 * (id-preserving, cross-course-unique) + seed the new board + recompute; DISCARD the rest. The course is
	 * never touched by an unproven video. Returns counts.
	 */
	public static function settle_candidates( $limit = 50 ) {
		$now = time();
		$rows = Data::all(
			'SELECT video, rate, cand_course, cand_baseline FROM ' . Data::t( 'aq_videos' )
			. ' WHERE cand_course > 0 AND cand_until > 0 AND cand_until <= %d ORDER BY cand_until ASC LIMIT %d',
			[ $now, max( 1, (int) $limit ) ] );
		$added = 0; $discarded = 0;
		require_once __DIR__ . '/../tools/lesson-sync.inc.php';
		foreach ( (array) $rows as $r ) {
			$vid  = (string) $r['video'];
			$cid  = (int) $r['cand_course'];
			$rate = (int) $r['rate'];
			$base = (int) $r['cand_baseline'];
			// Clear the candidate marks FIRST so a video is judged exactly once even if the add throws.
			Data::update( 'aq_videos', [ 'cand_course' => 0, 'cand_until' => 0, 'cand_baseline' => 0 ], [ 'video' => $vid ] );
			$course = Data::one( 'SELECT id FROM ' . Data::t( 'aq_courses' ) . " WHERE id = %d AND status = 'publish'", [ $cid ] );
			// Judge against the course's CURRENT size: grow thin courses, maintain full ones (settle_decision).
			$vc = (int) Data::col( 'SELECT COUNT(DISTINCT video) FROM ' . Data::t( 'aq_lessons' ) . " WHERE course_id = %d AND video <> ''", [ $cid ] );
			if ( ! $course || ! self::settle_decision( $rate, $base, $vc ) ) { self::untrack_candidate( $vid ); $discarded++; continue; }
			// Build the desired list = the course's CURRENT sections (kept verbatim by id) + the candidate.
			$meta = get_option( 'aq_yt_meta_' . $vid );
			$existing = Data::all(
				'SELECT title, video, duration, seg_start, seg_end FROM ' . Data::t( 'aq_lessons' )
				. " WHERE course_id = %d AND video <> '' ORDER BY idx ASC, id ASC", [ $cid ] );
			$spec = [];
			foreach ( $existing as $e ) {
				$spec[] = [ 'title' => (string) $e['title'], 'video' => (string) $e['video'],
					'duration' => (int) $e['duration'], 'seg_start' => (int) $e['seg_start'], 'seg_end' => (int) $e['seg_end'] ];
			}
			$spec[] = [
				'title'    => ( is_array( $meta ) && ! empty( $meta['title'] ) ) ? (string) $meta['title'] : 'New video',
				'video'    => $vid,
				'duration' => ( is_array( $meta ) ? (int) ( $meta['duration'] ?? 0 ) : 0 ),
			];
			$res = aq_sync_lessons( $cid, $spec );
			if ( ! empty( $res['added_ids'] ) ) {
				foreach ( $res['added_ids'] as $lid ) { try { Learn::seed_board( (int) $lid, $cid ); } catch ( \Throwable $e ) { /* the aq_seed_boards cron will catch it */ } }
				self::recompute_course_trend( $cid );
				$added++;
			} else {
				// Rejected by the choke point (e.g. now owned by another course) → discard the orphan candidate.
				self::untrack_candidate( $vid );
				$discarded++;
			}
		}
		if ( $added || $discarded ) { error_log( "[aq_settle_candidates] added=$added discarded=$discarded" ); }
		$out = [ 'added' => $added, 'discarded' => $discarded ];
		update_option( 'aq_settle_last', array_merge( [ 'ts' => time() ], $out ), false );
		return $out;
	}

	// ── 3. prune (cron aq_prune) — DROP THE PERSISTENT LOWS ──────────────────────

	/**
	 * Given a course's distinct video rates [ video => rate ], return the videos to DROP: only when the
	 * course has MORE than PRUNE_GATE videos, drop those whose rate is below (mean − PRUNE_SIGMA·σ) of the
	 * course's own distribution, lowest first, never shrinking the course below PRUNE_MIN_VIDEOS. PURE —
	 * unit-tested. (σ is the population standard deviation of the course's video rates.)
	 */
	public static function prune_targets( array $rates, $gate = self::PRUNE_GATE, $min = self::PRUNE_MIN_VIDEOS, $sigma = self::PRUNE_SIGMA ) {
		$n = count( $rates );
		if ( $n <= (int) $gate || $n <= (int) $min ) { return []; }
		$vals = array_map( 'floatval', array_values( $rates ) );
		$mean = array_sum( $vals ) / $n;
		$var  = 0.0;
		foreach ( $vals as $v ) { $var += ( $v - $mean ) ** 2; }
		$sd = sqrt( $var / $n );
		if ( $sd <= 0 ) { return []; } // all equal — no outliers
		$threshold = $mean - (float) $sigma * $sd;
		$below = [];
		foreach ( $rates as $video => $rate ) { if ( (float) $rate < $threshold ) { $below[ (string) $video ] = (float) $rate; }	}
		asort( $below ); // lowest rate first
		$max_drop = $n - (int) $min; // keep at least $min videos
		return array_slice( array_keys( $below ), 0, max( 0, $max_drop ) );
	}

	/**
	 * Daily churn: for every course with more than PRUNE_GATE distinct videos, drop the persistent lows
	 * (prune_targets) via aq_sync_lessons + recompute. Bounded per run. Returns counts.
	 */
	public static function prune_underperformers( $max_courses = 200 ) {
		global $wpdb;
		require_once __DIR__ . '/../tools/lesson-sync.inc.php';
		// Courses with strictly more than PRUNE_GATE distinct videos are the only ones eligible.
		$cids = (array) $wpdb->get_col( $wpdb->prepare(
			'SELECT course_id FROM ' . Data::t( 'aq_lessons' ) . " WHERE video <> '' GROUP BY course_id HAVING COUNT(DISTINCT video) > %d LIMIT %d",
			self::PRUNE_GATE, max( 1, (int) $max_courses ) ) );
		$courses_pruned = 0; $videos_dropped = 0;
		foreach ( $cids as $cid ) {
			$cid = (int) $cid;
			$vrows = Data::all(
				'SELECT DISTINCT l.video AS video, v.rate AS rate FROM ' . Data::t( 'aq_lessons' ) . ' l '
				. 'JOIN ' . Data::t( 'aq_videos' ) . " v ON v.video = l.video WHERE l.course_id = %d AND l.video <> ''", [ $cid ] );
			$rates = [];
			foreach ( $vrows as $vr ) { $rates[ (string) $vr['video'] ] = (int) $vr['rate']; }
			$drop = self::prune_targets( $rates );
			if ( ! $drop ) { continue; }
			$dropset = array_fill_keys( $drop, true );
			// Desired list = current sections MINUS the dropped videos (kept rows preserved by id).
			$existing = Data::all(
				'SELECT title, video, duration, seg_start, seg_end FROM ' . Data::t( 'aq_lessons' )
				. " WHERE course_id = %d AND video <> '' ORDER BY idx ASC, id ASC", [ $cid ] );
			$spec = [];
			foreach ( $existing as $e ) {
				if ( isset( $dropset[ (string) $e['video'] ] ) ) { continue; }
				$spec[] = [ 'title' => (string) $e['title'], 'video' => (string) $e['video'],
					'duration' => (int) $e['duration'], 'seg_start' => (int) $e['seg_start'], 'seg_end' => (int) $e['seg_end'] ];
			}
			if ( ! $spec ) { continue; } // never empty a course here (purge_zero_rate owns dead-course removal)
			$res = aq_sync_lessons( $cid, $spec );
			if ( ! empty( $res['removed_ids'] ) ) {
				self::recompute_course_trend( $cid );
				$videos_dropped += count( $res['removed_ids'] );
				$courses_pruned++;
			}
		}
		if ( $courses_pruned ) { error_log( "[aq_prune] courses=$courses_pruned videos_dropped=$videos_dropped" ); }
		$out = [ 'courses' => $courses_pruned, 'videos' => $videos_dropped ];
		update_option( 'aq_prune_last', array_merge( [ 'ts' => time() ], $out ), false );
		return $out;
	}


	// ── Reads (history monitor) ───────────────────────────────────────────────

	/**
	 * The view-count history for one video: the cumulative series (hourly buckets for the recent
	 * window, daily archives beyond — see compact_stats; last $days days) plus the latest count and
	 * hourly rate. Powers the lesson-page sparkline. Public + cacheable.
	 */
	public static function history( $vid, $days = 90 ) {
		$vid  = (string) $vid;
		$days = max( 1, min( 365, (int) $days ) );
		if ( $vid === '' ) { return [ 'video' => '', 'views' => null, 'rate' => 0, 'points' => [] ]; }
		$cutoff = time() - $days * 86400;
		$rows = Data::all(
			'SELECT day, views FROM ' . Data::t( 'aq_video_stats' ) . ' WHERE video = %s AND day >= %d ORDER BY day ASC',
			[ $vid, $cutoff ] );
		$v = Data::one( 'SELECT views, rate FROM ' . Data::t( 'aq_videos' ) . ' WHERE video = %s', [ $vid ] );
		$latest = $v ? (int) $v['views'] : ( $rows ? (int) $rows[ count( $rows ) - 1 ]['views'] : null );
		return [
			'video'  => $vid,
			'views'  => $latest,
			'rate'   => $v ? (int) $v['rate'] : 0,
			'points' => array_map( function ( $r ) { return [ 'day' => (int) $r['day'], 'views' => (int) $r['views'] ]; }, $rows ),
		];
	}

	/**
	 * A course's view-growth history: the cumulative-views series (hourly buckets for the recent
	 * window, daily archives beyond — see compact_stats) plus each point's PER-HOUR rate: the delta
	 * since the previous recorded point ÷ the actual hours between them, so mixed hourly/daily
	 * granularity normalises to one unit (operator rule 2026-06-12: all rates are hourly). The first
	 * point's rate is 0 (no prior). Also returns the latest total + current hourly rate from aq_courses.
	 */
	public static function course_history( $cid, $days = 365 ) {
		$cid  = (int) $cid;
		$days = max( 1, min( 1825, (int) $days ) );
		if ( ! $cid ) { return [ 'course_id' => 0, 'views' => 0, 'rate' => 0, 'points' => [] ]; }
		$cutoff = time() - $days * 86400;
		$rows = Data::all(
			'SELECT day, views FROM ' . Data::t( 'aq_course_stats' ) . ' WHERE course_id = %d AND day >= %d ORDER BY day ASC',
			[ $cid, $cutoff ] );
		$points = [];
		$prev_views = null; $prev_day = null;
		foreach ( $rows as $r ) {
			$d = (int) $r['day']; $v = (int) $r['views'];
			$rate = 0;
			if ( $prev_views !== null ) {
				$hours = max( 1.0, ( $d - $prev_day ) / 3600 );              // hours between recorded points (daily archives → 24)
				$rate  = (int) round( max( 0, $v - $prev_views ) / $hours ); // per-HOUR average across the gap
			}
			$points[] = [ 'day' => $d, 'views' => $v, 'rate' => $rate ];
			$prev_views = $v; $prev_day = $d;
		}
		$c = Data::one( 'SELECT views, trend FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		return [
			'course_id' => $cid,
			'views'     => $c ? (int) $c['views'] : ( $points ? $points[ count( $points ) - 1 ]['views'] : 0 ),
			'rate'      => $c ? (int) $c['trend'] : 0,
			'points'    => $points,
		];
	}

	/**
	 * ROLLING 28-DAY RATE at each history bucket, ×100 (centi-comments/day), from a cumulative comment
	 * series. For each point t: base = the latest bucket ≥28 days behind t (or, while the video is still
	 * younger than 28 days, the EARLIEST snapshot held); rate = (count(t) − count(base)) ÷ the ACTUAL
	 * days spanned × 100 — dividing by the real span, not a flat 28, so an early partial window isn't
	 * biased low. This mirrors the live headline metric (video_day_rate) point-by-point, so the chart
	 * line and the "X/day" readout are the same measure. The very first snapshot is dropped (no prior to
	 * difference). $cum must be sorted by day ASC; returns [ ['day'=>int,'rate'=>int], … ] (centi/day).
	 */
	/** Fraction of the largest available window below which a point is considered the "initial
	 *  high-variance" part and trimmed off the chart — once there's enough span to spare it. */
	const PLOT_TRIM_FRACTION = 0.25;

	private static function rate_points( array $cum ) {
		$n = count( $cum ); if ( $n < 2 ) { return []; }
		// Each point = comments since the base ÷ the ACTUAL elapsed window (base = the trailing-28d bucket
		// once one exists, else the earliest = whole tracked life). NO 1-day floor: that floor was the bias
		// that made every series ramp up out of zero (a partial count ÷ a whole day reads low). Dividing by
		// the true window is UNBIASED at every point — early points are just high-variance (few samples),
		// scattered around the true rate, not systematically low. 1-hour floor only guards divide-by-zero.
		// We also DON'T PLOT THE LEADING FLAT RUN — the opening points before the count first rises above
		// its starting value, where the rate is exactly 0 only because no comment has yet been observed.
		$minDays = HOUR_IN_SECONDS / DAY_IN_SECONDS; $base0 = (int) $cum[0]['views']; $started = false;
		$cand = []; $b = 0; $maxW = 0.0;
		for ( $i = 1; $i < $n; $i++ ) {
			$t = (int) $cum[ $i ]['day'];
			while ( $b < $i - 1 && (int) $cum[ $b + 1 ]['day'] <= $t - self::RATE_WINDOW ) { $b++; }
			if ( ! $started ) {
				if ( $b === 0 && (int) $cum[ $i ]['views'] <= $base0 ) { continue; } // still in the leading flat run
				$started = true;
			}
			$delta = max( 0, (int) $cum[ $i ]['views'] - (int) $cum[ $b ]['views'] );
			$w     = max( $minDays, ( $t - (int) $cum[ $b ]['day'] ) / DAY_IN_SECONDS );
			$cand[] = [ 'day' => $t, 'rate' => (int) round( $delta * 100 / $w ), 'w' => $w ];
			if ( $w > $maxW ) { $maxW = $w; }
		}
		if ( ! $cand ) { return []; }
		// TRIM THE INITIAL HIGH-VARIANCE PART once enough data exists. A point's window grows as history
		// accrues, so the smallest-window points are the noisiest (fewest samples) AND the earliest. Once
		// the span is ≥1 day, drop points whose window is under a quarter of the largest available — but
		// only if ≥3 points survive, so a still-young video keeps everything rather than charting nothing.
		if ( $maxW >= 1.0 ) {
			$thr  = $maxW * self::PLOT_TRIM_FRACTION;
			$keep = array_values( array_filter( $cand, function ( $c ) use ( $thr ) { return $c['w'] >= $thr; } ) );
			if ( count( $keep ) >= 3 ) { $cand = $keep; }
		}
		// TRIM THE LEADING TRANSIENT (one shared helper, applied identically to the course average — so the
		// per-section lines and the course line trim by the SAME rule).
		$cand = self::trim_leading_transient( $cand );
		return array_map( function ( $c ) { return [ 'day' => $c['day'], 'rate' => $c['rate'] ]; }, $cand );
	}

	/**
	 * Drop the LEADING TRANSIENT of a rate series: points at the FRONT that sit far above the series
	 * MEDIAN (the settled level), stopping at the first in-range point — so a line opens on its settled
	 * rate instead of declining out of an early burst. With a cumulative-from-earliest window an early
	 * comment burst (or a slightly-stale opening snapshot) dominates the short opening windows and starts
	 * the per-video line HIGH; for the COURSE average a just-added low-rate video does the same. Only with
	 * ≥6 points (so the median is stable) and never below 4 survivors — a still-young series keeps
	 * everything. A genuinely RISING series has LOW leading points → nothing is cut; only a high leading
	 * transient is. ONE helper shared by rate_points (per video) and course_comment_history (the average)
	 * so the trim is consistent everywhere. Operates on [ ['day'=>,'rate'=>,…], … ]; preserves extra keys.
	 */
	private static function trim_leading_transient( array $pts ) {
		if ( count( $pts ) < 6 ) { return array_values( $pts ); }
		$rs = array_map( function ( $c ) { return (int) $c['rate']; }, $pts );
		sort( $rs );
		$median = $rs[ intdiv( count( $rs ), 2 ) ];
		while ( count( $pts ) > 4 && $median > 0 && (int) $pts[0]['rate'] > 1.3 * $median ) { array_shift( $pts ); }
		return array_values( $pts );
	}

	/**
	 * One VIDEO's discussion-rate history: its own trailing-24h YouTube-comment rate over time (the
	 * series each section's sparkline draws), plus the current rate ("X/day") and cumulative total.
	 * Sourced from the video's hourly aq_video_stats snapshots → rate_points (warm-up dropped). The
	 * current per_day is the live aq_videos.rate (÷100, centi-comments/day → comments/day). Public +
	 * cacheable. The cutoff reaches one day before the window so the first in-window point still has a
	 * 24h base to measure against.
	 */
	public static function video_comment_history( $vid, $days = 90 ) {
		$vid  = (string) $vid;
		$days = max( 1, min( 365, (int) $days ) );
		if ( $vid === '' ) { return [ 'video' => '', 'per_day' => 0, 'total' => 0, 'points' => [] ]; }
		$cutoff = time() - $days * 86400;
		$cum = array_map(
			function ( $r ) { return [ 'day' => (int) $r['day'], 'views' => (int) $r['views'] ]; },
			Data::all( 'SELECT day, views FROM ' . Data::t( 'aq_video_stats' ) . ' WHERE video = %s AND day >= %d ORDER BY day ASC',
				[ $vid, $cutoff - self::RATE_WINDOW ] ) );
		$points = [];
		foreach ( self::rate_points( $cum ) as $p ) { if ( $p['day'] >= $cutoff ) { $points[] = $p; } }
		$v = Data::one( 'SELECT views, rate FROM ' . Data::t( 'aq_videos' ) . ' WHERE video = %s', [ $vid ] );
		return [
			'video'   => $vid,
			'per_day' => $v ? round( (int) $v['rate'] / 100, 1 ) : 0,
			'total'   => $v ? (int) $v['views'] : ( $cum ? (int) end( $cum )['views'] : 0 ),
			'points'  => $points,
		];
	}

	/**
	 * A course's DISCUSSION-RATE history: the AVERAGE of its videos' own trailing-24h comment rates
	 * over time (operator rule 2026-06-14 — the course line is "merely the average" of the per-section
	 * lines, the same way rank_score is the average per-video rate). Built by computing each distinct
	 * video's rate_points (from aq_video_stats) and averaging them onto a shared hourly grid with
	 * forward-fill (a video keeps its last measured rate between its own refreshes). WARM-UP IS DROPPED
	 * and the line STARTS FROM THE LAST UPDATE: it begins at max(each video's first real rate point),
	 * so a freshly-added video's missing early data never drags the average down toward zero — the
	 * course curve only starts once every video has a genuine measurement. Headline `per_day` is the
	 * live AVERAGE of the videos' own rates — the same per-section "/day" numbers shown below it, and
	 * where the line ends — computed straight from the videos, NOT from aq_courses.rank_score: rank_score
	 * is deliberately held at 0 for 24h after any video edit (the catalogue churn cooldown), which made
	 * this descriptive header read "0/day" on a course with clearly active discussion (#102). `total` is
	 * the cumulative comment total. Public + cacheable.
	 */
	public static function course_comment_history( $cid, $days = 90 ) {
		$cid  = (int) $cid;
		$days = max( 1, min( 365, (int) $days ) );
		if ( ! $cid ) { return [ 'course_id' => 0, 'total' => 0, 'per_day' => 0, 'points' => [] ]; }
		$cutoff = time() - $days * 86400;
		$total  = (int) Data::col( 'SELECT trend FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		// Headline `per_day` = the live AVERAGE of this course's DISTINCT videos' trailing-window comment
		// rates (aq_videos.rate ÷100) — exactly the per-section "/day" numbers shown below it, and where
		// the gold line ends. Computed straight from the videos, NOT from aq_courses.rank_score: rank_score
		// is deliberately HELD AT 0 for 24h after any video edit (recompute_course_trend's catalogue
		// cooldown) — right for the trending SORT, but it left this descriptive header reading "0/day" next
		// to clearly active per-video rates and a rising chart line (#102). DISTINCT video → counted once
		// (mirrors recompute_course_trend), so padding one video across sections can't skew the average.
		$vrows = Data::all(
			'SELECT DISTINCT l.video AS video, v.rate AS rate
			   FROM ' . Data::t( 'aq_lessons' ) . ' l
			   JOIN ' . Data::t( 'aq_videos' ) . " v ON v.video = l.video
			  WHERE l.course_id = %d AND l.video <> ''", [ $cid ] );
		$rsum = 0; $rn = 0;
		foreach ( (array) $vrows as $vr ) { $rsum += (int) $vr['rate']; $rn++; }
		$out    = [ 'course_id' => $cid, 'total' => $total, 'per_day' => $rn > 0 ? round( ( $rsum / $rn ) / 100, 1 ) : 0, 'points' => [] ];

		$vids = Data::all( 'SELECT DISTINCT video FROM ' . Data::t( 'aq_lessons' ) . " WHERE course_id = %d AND video <> ''", [ $cid ] );
		$rate_of = [];
		foreach ( (array) $vrows as $vr ) { $rate_of[ (string) $vr['video'] ] = (int) $vr['rate']; }
		// Batch every video's stats into ONE query (was an N+1 — one SELECT per video — on this public hot path).
		$cum_by_vid = [];
		$vlist = array_map( function ( $vr ) { return (string) $vr['video']; }, (array) $vids );
		if ( $vlist ) {
			$ph   = implode( ',', array_fill( 0, count( $vlist ), '%s' ) );
			$rows = Data::all( 'SELECT video, day, views FROM ' . Data::t( 'aq_video_stats' ) . " WHERE video IN ($ph) AND day >= %d ORDER BY day ASC",
				array_merge( $vlist, [ $cutoff - self::RATE_WINDOW ] ) );
			foreach ( (array) $rows as $r ) { $cum_by_vid[ (string) $r['video'] ][] = [ 'day' => (int) $r['day'], 'views' => (int) $r['views'] ]; }
		}
		$series = []; $first = []; $last = []; $allvids = []; // vid → day=>rate map (day-ascending) + its data range
		foreach ( (array) $vids as $vr ) {
			$vid = (string) $vr['video'];
			$allvids[] = $vid;
			$cum = $cum_by_vid[ $vid ] ?? [];
			$map = [];
			foreach ( self::rate_points( $cum ) as $p ) { if ( $p['day'] >= $cutoff ) { $map[ $p['day'] ] = (int) $p['rate']; } }
			if ( ! $map ) { // flat / no-growth video → a constant line at its current rate across the days it WAS tracked
				$cr = $rate_of[ $vid ] ?? 0;
				foreach ( $cum as $c ) { if ( $c['day'] >= $cutoff ) { $map[ (int) $c['day'] ] = $cr; } }
			}
			if ( $map ) { ksort( $map ); $series[ $vid ] = $map; $first[ $vid ] = (int) array_key_first( $map ); $last[ $vid ] = (int) array_key_last( $map ); }
		}
		if ( ! $series ) { return $out; } // no video has any tracked data yet — header shows the live per_day, no chart

		// X-AXIS = the INTERSECTION of the videos' available data, FROM THE LAST UPDATE POINT (operator
		// 2026-06-18). START = max(each video's FIRST data point) — when the most-recently-added video came
		// online (the course's last composition update) and the earliest moment EVERY video has data. END =
		// min(each video's LAST data point), so no line runs past another's data. The course AVERAGE and
		// EVERY per-section line are drawn on this ONE grid → identical start & end (1-to-1). A video with no
		// comment growth is a flat line at its current rate; the average is over ALL videos (so it ends at
		// the headline /day). NO extra trimming — the intersection from the last update IS the range.
		$start = max( $first );
		$end   = min( $last );
		if ( $start > $end ) { $start = min( $first ); $end = max( $last ); } // no overlap (rare) → widen so a chart still draws
		$grid = [];
		foreach ( $series as $map ) { foreach ( $map as $h => $_r ) { if ( $h >= $start && $h <= $end ) { $grid[ $h ] = true; } } }
		ksort( $grid );
		$grid = array_keys( $grid );
		if ( ! $grid ) { return $out; }
		$ff = function ( array $map, $h ) { $r = null; foreach ( $map as $d => $rate ) { if ( $d <= $h ) { $r = $rate; } else { break; } } return $r; }; // forward-fill
		// A video's rate at grid hour $h: forward-filled from its series, falling back to its constant
		// current rate (a video with no snapshots at all), so every video has a value at every grid hour.
		$rate_at = function ( $vid, $h ) use ( $series, $rate_of, $ff ) {
			if ( isset( $series[ $vid ] ) ) { $r = $ff( $series[ $vid ], $h ); if ( $r !== null ) { return (int) $r; } }
			return isset( $rate_of[ $vid ] ) ? (int) $rate_of[ $vid ] : 0;
		};

		$avg = [];
		foreach ( $grid as $h ) {
			$sum = 0; foreach ( $allvids as $vid ) { $sum += $rate_at( $vid, $h ); }
			$avg[] = [ 'day' => (int) $h, 'rate' => (int) round( $sum / count( $allvids ) ) ];
		}
		$out['points'] = $avg; // the course average over the shared intersection grid (ends at the headline /day)
		// EVERY video's line on the SAME grid — identical day axis ⇒ pixel-aligned start & end with the
		// course line and with each other. per_day is the video's live rate (the "/day" shown beside it).
		$vids_out = [];
		foreach ( $allvids as $vid ) {
			$vpts = [];
			foreach ( $grid as $h ) { $vpts[] = [ 'day' => (int) $h, 'rate' => $rate_at( $vid, $h ) ]; }
			$vids_out[] = [ 'video' => (string) $vid, 'per_day' => isset( $rate_of[ $vid ] ) ? round( $rate_of[ $vid ] / 100, 1 ) : 0, 'points' => $vpts ];
		}
		$out['videos'] = $vids_out;
		return $out;
	}

	// ── REST handlers ─────────────────────────────────────────────────────────

	/** GET /videos/{vid}/stats — the history series for the monitor. */
	public static function stats( $req ) {
		$vid = sanitize_text_field( (string) Rest::p( $req, 'vid', '' ) );
		return self::history( $vid, Rest::pint( $req, 'days', 90 ) );
	}

	/** GET /courses/{id}/stats — the course's view-growth history (cumulative + per-day rate). */
	public static function course_stats( $req ) {
		return self::course_history( Rest::pint( $req, 'id' ), Rest::pint( $req, 'days', 365 ) );
	}

	/** GET /courses/{id}/comment-stats — the course's discussion-rate history (avg per-video rate over time + totals). */
	public static function course_comment_stats( $req ) {
		return self::course_comment_history( Rest::pint( $req, 'id' ), Rest::pint( $req, 'days', 90 ) );
	}

	/** GET /videos/{vid}/comment-stats — one video's own discussion-rate history (the per-section sparkline). */
	public static function video_comment_stats( $req ) {
		$vid = sanitize_text_field( (string) Rest::p( $req, 'vid', '' ) );
		return self::video_comment_history( $vid, Rest::pint( $req, 'days', 90 ) );
	}

	/**
	 * POST /admin/refresh-videos — operator trigger to refresh now (testing / forcing). Without a
	 * body it refreshes the due batch; with `all=1` it forces ALL non-missing videos due immediately
	 * first (bounded by CALLS_PER_RUN per invocation). Admin-only.
	 */
	public static function admin_refresh( $req ) {
		if ( ! self::enabled() ) { return Rest::err( 'no_key', 'No YouTube credentials (YOUTUBE_SA_JSON or YOUTUBE_API_KEY) are set on this environment.', 503 ); }
		self::sync_registry();
		if ( Rest::pint( $req, 'all', 0 ) ) {
			global $wpdb;
			$wpdb->query( 'UPDATE ' . Data::t( 'aq_videos' ) . ' SET next_refresh = 0' );
		}
		$before = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_videos' ) . ' WHERE next_refresh <= %d', [ time() ] );
		$done   = self::refresh_due();
		return [ 'ok' => true, 'due' => $before, 'refreshed' => (int) $done ];
	}
}
