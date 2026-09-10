<?php
/**
 * EVERY MEETING IS RECORDABLE, and what comes out is the same product ArtaCast ships (operator,
 * 2026-09-10: "every meeting must follow the same recording product to artacast").
 *
 * The shape is deliberately identical to Cast's, because the OUTPUT must be identical: the host's
 * browser composites the call into a 1920×1080 frame, writes it to disk as it records, hands the
 * file to their Downloads at Stop, sends it to their own ArtaCloud shelf, and this class pushes the
 * SAME finishing script (data/artacast-finish.py) to Kaggle — MossFormer2 under a loudness guard,
 * then loudnorm to −14 LUFS / −1 dBTP, muxed with the picture untouched. The five-minute cron
 * judges the run, the raw leaves the shelf, and the host is rung and emailed with fresh links.
 *
 * What is NOT shared is the row: an ArtaCast episode carries a couple, their frame and their
 * request; an ordinary meeting carries a title and whoever was in the room. So this owns
 * `aq_meet_records` — one row per meeting, written the first time that meeting is recorded — and
 * Cast keeps its own, proven, untouched. The two agree where it matters: the same script, the same
 * Kaggle account, the same judging, the same shelf grants, the same words to the host.
 *
 * Consent is not implicit: the host presses Record, and the sealed `rec` payload the room already
 * carries puts a red line in front of every other member for as long as it is on.
 */

namespace AQ;

defined( 'ABSPATH' ) || exit;

class Record {

	/** Retries for a push Kaggle refused, and the space between them — Cast's numbers, on purpose. */
	const PIPE_TRIES     = 4;
	const PIPE_RETRY_S   = 600;
	const PIPE_TIMEOUT_S = 36000;

	/** The row for a meeting, or null. */
	public static function by_meet( $mid ) {
		$mid = (int) $mid;
		if ( $mid <= 0 ) { return null; }
		return Data::one( 'SELECT * FROM ' . Data::t( 'aq_meet_records' ) . ' WHERE meet_id = %d', [ $mid ] );
	}

	private static function row( $id ) {
		return Data::one( 'SELECT * FROM ' . Data::t( 'aq_meet_records' ) . ' WHERE id = %d', [ (int) $id ] );
	}

	/** The meeting, or null. */
	private static function meet( $mid ) {
		return Data::one( 'SELECT id, host_id, title, start_ts, end_ts, tz, status FROM ' . Data::t( 'aq_meets' ) . ' WHERE id = %d', [ (int) $mid ] );
	}

	/** Is this member the host of that meeting? Only the host records, finishes or downloads. */
	private static function is_host( $mid, $uid ) {
		$m = self::meet( $mid );
		return $m && (int) $m['host_id'] === (int) $uid;
	}

	/** Is this member IN that meeting (host or guest)? A guest may send their own isolated track. */
	private static function in_meet( $mid, $uid ) {
		if ( self::is_host( $mid, $uid ) ) { return true; }
		return (bool) Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_meet_guests' ) . ' WHERE meet_id = %d AND user_id = %d LIMIT 1', [ (int) $mid, (int) $uid ] );
	}

	/** The row for this meeting, created on first use. */
	private static function ensure( $mid, $host_id ) {
		$r = self::by_meet( $mid );
		if ( $r ) { return $r; }
		$now = Data::now();
		$id = Data::insert( 'aq_meet_records', [
			'meet_id' => (int) $mid, 'host_id' => (int) $host_id, 'created' => $now, 'updated' => $now,
		] );
		return $id ? self::row( $id ) : null;
	}

	/**
	 * A member whose shelf must hold a recording right now: the host of a meeting that is running
	 * or ran this week, and anyone seated in one (their own camera track). Read by Media::capacity,
	 * exactly as Cast::is_live_guest is — the grant is for the recording, not for the person.
	 */
	public static function is_live_party( $uid ) {
		$uid = (int) $uid;
		if ( $uid <= 0 ) { return false; }
		$since = Data::now() - 7 * 86400;
		$m = Data::t( 'aq_meets' );
		$g = Data::t( 'aq_meet_guests' );
		return (bool) Data::col(
			"SELECT 1 FROM $m WHERE host_id = %d AND status <> 'cancelled' AND start_ts > %d LIMIT 1",
			[ $uid, $since ]
		) || (bool) Data::col(
			"SELECT 1 FROM $g g JOIN $m m ON m.id = g.meet_id WHERE g.user_id = %d AND m.status <> 'cancelled' AND m.start_ts > %d LIMIT 1",
			[ $uid, $since ]
		);
	}

	/** What the meeting page shows: whether a take exists and where its finishing has got to. */
	public static function payload( $r, $mid ) {
		$files = $r ? (array) ( Data::dec( (string) ( $r['final_files'] ?? '' ) ) ?: [] ) : [];
		return [
			'meet'     => (int) $mid,
			'recorded' => [ 'at' => (int) ( $r['recorded_at'] ?? 0 ), 'note' => (string) ( $r['recorded_note'] ?? '' ) ],
			'state'    => (string) ( $r['pipe_state'] ?? '' ),
			'note'     => (string) ( $r['pipe_note'] ?? '' ),
			'started'  => (int) ( $r['pipe_started'] ?? 0 ),
			'done'     => (int) ( $r['pipe_done'] ?? 0 ),
			'files'    => array_values( array_filter( $files ) ),
			'raw'      => (int) ( $r['raw_media_id'] ?? 0 ),
			'kernel'   => '' !== (string) ( $r['pipe_kernel'] ?? '' ) ? Kaggle::kernel_url( (string) $r['pipe_kernel'] ) : '',
			'tries'    => (int) ( $r['pipe_tries'] ?? 0 ),
			'iso'      => self::iso_list( $r ),
			'retrying' => 'failed' === (string) ( $r['pipe_state'] ?? '' )
				&& str_starts_with( (string) ( $r['pipe_note'] ?? '' ), 'Kaggle refused' )
				&& (int) ( $r['pipe_tries'] ?? 0 ) < self::PIPE_TRIES,
		];
	}

	/** The isolated tracks attached to this meeting, with the shelf URL each still has. */
	private static function iso_list( $r ) {
		$out = [];
		foreach ( (array) ( Data::dec( (string) ( $r['iso_files'] ?? '' ) ) ?: [] ) as $t ) {
			$m = Data::one( 'SELECT id, name, store_key, bytes FROM ' . Data::t( 'aq_media' ) . ' WHERE id = %d', [ (int) ( $t['media_id'] ?? 0 ) ] );
			if ( ! $m ) { continue; }
			$out[] = [
				'uid'   => (int) ( $t['uid'] ?? 0 ),
				'name'  => (string) $m['name'],
				'bytes' => (int) $m['bytes'],
				'url'   => Media::url( (string) $m['store_key'] ),
			];
		}
		return $out;
	}

	/** GET meet/recording?id= — the state of this meeting's take. Anyone in the meeting. */
	public static function state( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mid = Rest::pint( $req, 'id', 0 );
		if ( ! self::in_meet( $mid, $uid ) ) { return Rest::err( 'not_found', 'No such meeting.', 404 ); }
		// The cron is the engine; a host opening the meeting is a second one. Self-gated inside.
		self::pipeline_tick();
		return [ 'ok' => true, 'recording' => self::payload( self::by_meet( $mid ), $mid ) ];
	}

	/**
	 * POST meet/recorded {id, seconds, bytes, format} — the host's device finished writing. Nothing
	 * about the file reaches the server (it cannot: the room is sealed); the row remembers THAT it
	 * happened, and how long, so the meeting page can say so.
	 */
	public static function recorded( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mid = Rest::pint( $req, 'id', 0 );
		if ( ! self::is_host( $mid, $uid ) ) { return Rest::err( 'forbidden', 'Only the host records.', 403 ); }
		$r = self::ensure( $mid, $uid );
		if ( ! $r ) { return Rest::err( 'server_error', 'Could not note that.', 500 ); }
		$secs  = max( 0, min( 86400, Rest::pint( $req, 'seconds', 0 ) ) );
		$bytes = max( 0, (int) Rest::p( $req, 'bytes', 0 ) );
		$fmt   = mb_substr( trim( wp_strip_all_tags( (string) Rest::p( $req, 'format', '' ) ) ), 0, 40 );
		$note  = trim( sprintf( '%d min · %.1f GB · %s', (int) round( $secs / 60 ), $bytes / 1e9, $fmt ), ' ·' );
		Data::update( 'aq_meet_records', [ 'recorded_at' => Data::now(), 'recorded_note' => mb_substr( $note, 0, 100 ), 'updated' => Data::now() ], [ 'id' => (int) $r['id'] ] );
		return [ 'ok' => true, 'note' => $note ];
	}

	/** The host's own, committed, video shelf item — or null. Never trusts the id alone. */
	private static function raw_item( $media_id, $uid ) {
		$m = Data::one( 'SELECT * FROM ' . Data::t( 'aq_media' ) . ' WHERE id = %d', [ (int) $media_id ] );
		if ( ! $m || (int) $m['user_id'] !== (int) $uid || 'ready' !== (string) $m['state'] || 'video' !== (string) $m['kind'] ) { return null; }
		return $m;
	}

	/**
	 * POST meet/finish {id, media_id, thumb?} — the raw is on the host's shelf; finish it. Calling
	 * it again is the retry: a failed or stale run is pushed anew under the same kernel slug.
	 */
	public static function finish( $req ) {
		if ( Rest::throttle( 'aq_rec_finish', 12, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mid = Rest::pint( $req, 'id', 0 );
		if ( ! self::is_host( $mid, $uid ) ) { return Rest::err( 'forbidden', 'Only the host finishes a recording.', 403 ); }
		$r = self::ensure( $mid, $uid );
		if ( ! $r ) { return Rest::err( 'server_error', 'Could not start that.', 500 ); }
		$item = self::raw_item( Rest::pint( $req, 'media_id', (int) $r['raw_media_id'] ), $uid );
		if ( ! $item ) { return Rest::err( 'no_raw', 'That recording is not on your shelf yet.', 409 ); }
		if ( 'running' === (string) $r['pipe_state'] && (int) $r['pipe_started'] > Data::now() - 900 ) {
			return Rest::err( 'busy', 'That recording is already being finished — give it a few minutes.', 409 );
		}
		$thumb = esc_url_raw( (string) Rest::p( $req, 'thumb', (string) $r['thumb_url'] ) );
		Data::update( 'aq_meet_records', [ 'raw_media_id' => (int) $item['id'], 'thumb_url' => $thumb, 'updated' => Data::now() ], [ 'id' => (int) $r['id'] ] );
		self::pipeline_start( self::row( (int) $r['id'] ), $item );
		return [ 'ok' => true, 'recording' => self::payload( self::row( (int) $r['id'] ), $mid ) ];
	}

	/** POST meet/iso {id, media_id} — a guest's own camera track, attached to the meeting. */
	public static function iso( $req ) {
		if ( Rest::throttle( 'aq_rec_iso', 20, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mid = Rest::pint( $req, 'id', 0 );
		if ( ! self::in_meet( $mid, $uid ) ) { return Rest::err( 'not_found', 'No such meeting.', 404 ); }
		$m = self::meet( $mid );
		$r = self::ensure( $mid, (int) ( $m['host_id'] ?? 0 ) );
		if ( ! $r ) { return Rest::err( 'server_error', 'Could not attach that.', 500 ); }
		$item = self::raw_item( Rest::pint( $req, 'media_id', 0 ), $uid );
		if ( ! $item ) { return Rest::err( 'no_raw', 'That recording is not on your shelf yet.', 409 ); }
		$list = (array) ( Data::dec( (string) ( $r['iso_files'] ?? '' ) ) ?: [] );
		$have = false;
		foreach ( $list as $t ) { if ( (int) ( $t['media_id'] ?? 0 ) === (int) $item['id'] ) { $have = true; } }
		if ( ! $have ) {
			$list[] = [ 'uid' => $uid, 'media_id' => (int) $item['id'], 'at' => Data::now() ];
			Data::update( 'aq_meet_records', [ 'iso_files' => Data::enc( array_slice( $list, -12 ) ), 'updated' => Data::now() ], [ 'id' => (int) $r['id'] ] );
		}
		return [ 'ok' => true, 'iso' => self::iso_list( self::row( (int) $r['id'] ) ) ];
	}

	/** GET meet/final?id= — fresh, signed download links for a finished recording. Host only. */
	public static function final( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mid = Rest::pint( $req, 'id', 0 );
		if ( ! self::is_host( $mid, $uid ) ) { return Rest::err( 'forbidden', 'Only the host.', 403 ); }
		$r = self::by_meet( $mid );
		if ( ! $r || 'done' !== (string) $r['pipe_state'] ) { return Rest::err( 'not_ready', 'That recording is not finished yet.', 409 ); }
		$seam = apply_filters( 'aq_cast_kaggle_read', null, (string) $r['pipe_kernel'] );
		[ $code, $files, $log ] = is_array( $seam ) ? [ $seam[2], $seam[3], $seam[4] ] : Kaggle::output( Kaggle::owner(), (string) $r['pipe_kernel'] );
		if ( $code < 200 || $code >= 300 ) { return Rest::err( 'kaggle', 'Kaggle did not answer (HTTP ' . $code . ') — try again in a moment.', 502 ); }
		$out = [];
		foreach ( $files as $f ) { $out[] = [ 'name' => (string) $f['name'], 'url' => (string) $f['url'] ]; }
		$j = Cast::done_json( $log );
		return [
			'ok' => true, 'files' => $out,
			'summary' => $j ? (string) wp_json_encode( $j ) : mb_substr( (string) $log, -600 ),
			'kernel'  => Kaggle::kernel_url( (string) $r['pipe_kernel'] ),
		];
	}

	// ── Finishing, unattended ──────────────────────────────────────────────

	/** The file name the finished recording carries — the meeting's title and the day it happened. */
	private static function out_base( $r ) {
		$m = self::meet( (int) $r['meet_id'] );
		$clean = fn( $s ) => trim( preg_replace( '/[^A-Za-z0-9]+/', '-', remove_accents( (string) $s ) ), '-' );
		$title = mb_substr( $clean( $m['title'] ?? '' ) ?: 'Meeting', 0, 48 );
		$tz    = in_array( (string) ( $m['tz'] ?? '' ), timezone_identifiers_list(), true ) ? new \DateTimeZone( (string) $m['tz'] ) : null;
		$at    = (int) ( $r['recorded_at'] ?: ( $m['start_ts'] ?? Data::now() ) );
		return $title . '-' . wp_date( 'Y-m-d', $at, $tz );
	}

	private static function kernel_slug( $r ) { return 'meeting-recording-' . (int) $r['meet_id']; }

	private static function pipeline_start( $r, $item ) {
		$now = Data::now();
		$tpl = @file_get_contents( AQ_DIR . '/data/artacast-finish.py' );
		if ( ! $tpl ) { self::pipeline_fail( $r, 'the finishing script is missing from this build' ); return; }
		$iso = [];
		foreach ( self::iso_list( $r ) as $t ) { $iso[] = [ 'name' => (string) $t['name'], 'url' => (string) $t['url'] ]; }
		$src = strtr( $tpl, [
			'{{ISO_JSON}}'   => str_replace( [ '\\', '"' ], [ '\\\\', '\\"' ], (string) wp_json_encode( $iso ) ),
			'{{RAW_URL}}'    => Media::url( (string) $item['store_key'] ),
			'{{THUMB_URL}}'  => (string) $r['thumb_url'],
			'{{OUT_BASE}}'   => self::out_base( $r ),
			'{{REQUEST_ID}}' => 'meet-' . (int) $r['meet_id'],
		] );
		$slug = self::kernel_slug( $r );
		$seam = apply_filters( 'aq_cast_kaggle_push', null, $slug, 'meeting recording ' . (int) $r['meet_id'], $src );
		[ $ok, $why ] = is_array( $seam ) ? $seam : Kaggle::push_script( $slug, 'meeting recording ' . (int) $r['meet_id'], $src, (bool) get_option( 'aq_artacast_kernel_private', 1 ) );
		$tries = (int) ( $r['pipe_tries'] ?? 0 ) + 1;
		if ( ! $ok ) { self::pipeline_fail( $r, 'Kaggle refused the kernel: ' . $why, $tries >= self::PIPE_TRIES, $tries ); return; }
		Data::update( 'aq_meet_records', [
			'pipe_state' => 'running', 'pipe_kernel' => $slug, 'pipe_started' => $now, 'pipe_done' => 0,
			'pipe_note' => '', 'final_files' => null, 'pipe_tries' => $tries, 'updated' => $now,
		], [ 'id' => (int) $r['id'] ] );
	}

	private static function pipeline_fail( $r, $note, $final = true, $tries = null ) {
		$now  = Data::now();
		$data = [ 'pipe_state' => 'failed', 'pipe_note' => mb_substr( (string) $note, 0, 250 ), 'pipe_done' => $now, 'updated' => $now ];
		if ( null !== $tries ) { $data['pipe_tries'] = (int) $tries; }
		Data::update( 'aq_meet_records', $data, [ 'id' => (int) $r['id'] ] );
		if ( ! $final ) { return; }
		Notify::push(
			(int) $r['host_id'], 'meeting', 'Finishing a meeting recording failed — open the meeting to retry',
			mb_substr( (string) $note, 0, 190 ), '/meet/' . (int) $r['meet_id'], 'recpf' . (int) $r['id'] . ':' . $now
		);
	}

	private static function pipeline_done( $r, $files, $model ) {
		$now  = Data::now();
		$keep = [];
		foreach ( (array) $files as $f ) { $keep[] = [ 'name' => (string) $f['name'] ]; }
		Data::update( 'aq_meet_records', [
			'pipe_state' => 'done', 'pipe_done' => $now,
			'pipe_note' => mb_substr( 'Voices cleaned with ' . ( $model ?: 'the fallback' ), 0, 250 ),
			'final_files' => Data::enc( $keep ), 'updated' => $now,
		], [ 'id' => (int) $r['id'] ] );
		// THE RAW LEAVES THE SHELF: the host has it on their own computer and Kaggle holds the
		// finished one. Same rule as an episode — a shelf is not an archive of every take.
		global $wpdb;
		$raw = Data::one( 'SELECT id, store_key, user_id FROM ' . Data::t( 'aq_media' ) . ' WHERE id = %d', [ (int) $r['raw_media_id'] ] );
		if ( $raw && (int) $raw['user_id'] === (int) $r['host_id'] ) {
			if ( method_exists( Media::class, 'destroy' ) ) { Media::destroy( (string) $raw['store_key'] ); }
			$wpdb->delete( Data::t( 'aq_media' ), [ 'id' => (int) $raw['id'] ] );
		}
		$copied = [];
		foreach ( (array) $files as $f ) { $copied[ (string) $f['name'] ] = true; }
		foreach ( (array) ( Data::dec( (string) ( $r['iso_files'] ?? '' ) ) ?: [] ) as $t ) {
			$m = Data::one( 'SELECT id, store_key, name FROM ' . Data::t( 'aq_media' ) . ' WHERE id = %d', [ (int) ( $t['media_id'] ?? 0 ) ] );
			if ( $m && isset( $copied[ 'ISO-' . (string) $m['name'] ] ) ) {
				if ( method_exists( Media::class, 'destroy' ) ) { Media::destroy( (string) $m['store_key'] ); }
				$wpdb->delete( Data::t( 'aq_media' ), [ 'id' => (int) $m['id'] ] );
			}
		}
		$m = self::meet( (int) $r['meet_id'] );
		Notify::push_mail(
			(int) $r['host_id'], 'meeting', 'Your recording of “' . (string) ( $m['title'] ?? 'the meeting' ) . '” is finished', '',
			'/meet/' . (int) $r['meet_id'], 'recdone' . (int) $r['id'],
			'rec_final', [
				'title'    => Mailer::safe_var( (string) ( $m['title'] ?? 'the meeting' ), 90 ),
				'model'    => Mailer::safe_var( $model ?: 'the fallback chain', 60 ),
				'meet_url' => '/meet/' . (int) $r['meet_id'],
			], ''
		);
	}

	/** Every five minutes (aq_meet_tick): the recordings being finished. Bounded; self-gated. */
	public static function pipeline_tick() {
		if ( get_transient( 'aq_rec_pipe' ) ) { return; }
		set_transient( 'aq_rec_pipe', 1, 240 );
		$now = Data::now();
		$t   = Data::t( 'aq_meet_records' );
		foreach ( Data::all(
			"SELECT * FROM $t WHERE pipe_state = 'failed' AND pipe_note LIKE 'Kaggle refused%' AND pipe_tries < %d AND pipe_done < %d AND raw_media_id > 0 ORDER BY pipe_done ASC LIMIT 5",
			[ self::PIPE_TRIES, $now - self::PIPE_RETRY_S ]
		) as $r ) {
			$item = self::raw_item( (int) $r['raw_media_id'], (int) $r['host_id'] );
			if ( $item ) { self::pipeline_start( $r, $item ); }
		}
		foreach ( Data::all( "SELECT * FROM $t WHERE pipe_state = 'running' ORDER BY pipe_started ASC LIMIT 10" ) as $r ) {
			$slug = (string) $r['pipe_kernel'];
			if ( '' === $slug ) { self::pipeline_fail( $r, 'no kernel recorded' ); continue; }
			$seam = apply_filters( 'aq_cast_kaggle_read', null, $slug );
			[ $st, $why ] = is_array( $seam ) ? [ $seam[0], $seam[1] ] : Kaggle::status_of( $slug );
			if ( 'error' === $st ) { self::pipeline_fail( $r, 'Kaggle: ' . ( $why ?: 'the run errored' ) ); continue; }
			[ $code, $files, $log ] = is_array( $seam ) ? [ $seam[2], $seam[3], $seam[4] ] : Kaggle::output( Kaggle::owner(), $slug );
			if ( $code >= 200 && $code < 300 ) {
				[ $verdict, $model ] = Cast::judge_output( $files, $log );
				if ( 'done' === $verdict )   { self::pipeline_done( $r, $files, $model ); continue; }
				if ( 'failed' === $verdict ) { self::pipeline_fail( $r, 'the finishing script could not read the recording' ); continue; }
				if ( 'complete' === $st )    { self::pipeline_fail( $r, 'the run finished without its report — open the kernel log' ); continue; }
			} elseif ( 'complete' === $st ) {
				self::pipeline_fail( $r, 'the run finished but its outputs could not be listed (HTTP ' . $code . ')' );
				continue;
			}
			if ( (int) $r['pipe_started'] < $now - self::PIPE_TIMEOUT_S ) { self::pipeline_fail( $r, 'no result after ten hours' ); }
		}
	}
}
