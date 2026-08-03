<?php
namespace AQ;

/**
 * ArtaDemo — peer review for ANIMATIONS, run like ArtaScience (operator order 2026-07-13).
 *
 * A demo submission is the animation's SOURCE (a code bundle URL), not a video. Each round it is
 * reviewed and scored by SEVERAL INDEPENDENT agents (the artademo relay runs them blind, in fresh
 * contexts): every reviewer must be able to fully understand the animation FROM THE CODE — every
 * scene enumerated, every concept introduced before it is used, every on-screen number computed
 * from the bundled data (self-sufficient, no outside context needed) — and must render it
 * end-to-end to verify it runs and to inspect frames for visual quality. Verdicts are aggregated
 * by majority; scores by median. Rounds loop (blind — no prior reports are fed back) until a
 * terminal decision, exactly like the journal.
 *
 * ONLY AFTER THE CODE IS ACCEPTED does ArtaMotion go ahead: the relay claims a render job, renders
 * the accepted source at full quality, uploads the video, and the publish endpoint mints the
 * permanent Zenodo DOI and creates/updates the aq_animations row. Nothing is published from
 * unreviewed source.
 *
 * Flow:  POST demo/submit → relay/demo/poll (worker) claims → N independent reviews →
 *        relay/demo/complete {reviews:[…]} → accepted? → relay/demo/poll returns a render job →
 *        relay renders + uploads → relay/demo/publish {video_url, poster, seconds} → DOI + animation.
 */
class Demo {

	const TABLE_VERSION = '1';
	const MAX_ROUNDS    = 6;
	const REVIEWERS     = 3;      // independent agents per round

	/** Self-installed storage — ArtaDemo owns its tables. */
	public static function ensure_tables() {
		if ( get_option( 'aq_demo_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		$subs = $wpdb->prefix . 'aq_demo_subs';
		$revs = $wpdb->prefix . 'aq_demo_reviews';
		dbDelta( "CREATE TABLE {$subs} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			title VARCHAR(300) NOT NULL DEFAULT '',
			brief TEXT NULL,
			code_url VARCHAR(600) NOT NULL DEFAULT '',
			status VARCHAR(24) NOT NULL DEFAULT 'submitted',
			round INT UNSIGNED NOT NULL DEFAULT 1,
			score INT NOT NULL DEFAULT 0,
			report MEDIUMTEXT NULL,
			doi VARCHAR(120) NOT NULL DEFAULT '',
			record_url VARCHAR(300) NOT NULL DEFAULT '',
			animation_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			video_url VARCHAR(600) NOT NULL DEFAULT '',
			poster VARCHAR(600) NOT NULL DEFAULT '',
			seconds INT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			updated INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY status (status)
		) {$charset};" );
		dbDelta( "CREATE TABLE {$revs} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			submission_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			round INT UNSIGNED NOT NULL DEFAULT 1,
			reviewer INT UNSIGNED NOT NULL DEFAULT 1,
			verdict VARCHAR(12) NOT NULL DEFAULT 'revise',
			score INT NOT NULL DEFAULT 0,
			report MEDIUMTEXT NULL,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY sub (submission_id)
		) {$charset};" );
		update_option( 'aq_demo_table_version', self::TABLE_VERSION, false );
	}

	private static function is_url( $u ) {
		$p = wp_parse_url( (string) $u );
		return ! empty( $p['scheme'] ) && $p['scheme'] === 'https' && ! empty( $p['host'] );
	}

	/** POST demo/submit { title, brief, code_url } — queue an animation SOURCE for review. */
	public static function submit( $req ) {
		self::ensure_tables();
		$title = sanitize_text_field( (string) Rest::p( $req, 'title', '' ) );
		$brief = sanitize_textarea_field( (string) Rest::p( $req, 'brief', '' ) );
		$code  = trim( (string) Rest::p( $req, 'code_url', '' ) );
		if ( $title === '' || $brief === '' ) { return Rest::err( 'bad_input', 'A title and a brief are required' ); }
		if ( ! self::is_url( $code ) ) { return Rest::err( 'bad_input', 'A https code-bundle URL is required' ); }
		$id = Data::insert( 'aq_demo_subs', [
			'author_id' => get_current_user_id(),
			'title'     => mb_substr( $title, 0, 300 ),
			'brief'     => mb_substr( $brief, 0, 20000 ),
			'code_url'  => mb_substr( $code, 0, 600 ),
			'status'    => 'submitted',
			'round'     => 1,
			'created'   => Data::now(),
			'updated'   => Data::now(),
		] );
		return [ 'id' => (int) $id, 'status' => 'submitted', 'round' => 1 ];
	}

	/** POST demo/submissions/{id}/revise { code_url, brief? } — resubmit after revisions-requested. */
	public static function revise( $req ) {
		self::ensure_tables();
		$id  = Rest::pint( $req, 'id' );
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_demo_subs' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $row ) { return Rest::err( 'not_found', 'Submission not found', 404 ); }
		if ( (int) $row['author_id'] !== get_current_user_id() ) { return Rest::err( 'forbidden', 'Only the author can revise', 403 ); }
		if ( ! in_array( $row['status'], [ 'revisions-requested', 'rejected' ], true ) ) {
			return Rest::err( 'bad_state', 'This submission is not awaiting a revision', 409 );
		}
		if ( (int) $row['round'] >= self::MAX_ROUNDS ) { return Rest::err( 'max_rounds', 'Maximum review rounds reached', 409 ); }
		$code = trim( (string) Rest::p( $req, 'code_url', $row['code_url'] ) );
		if ( ! self::is_url( $code ) ) { return Rest::err( 'bad_input', 'A https code-bundle URL is required' ); }
		Data::update( 'aq_demo_subs', [
			'code_url' => mb_substr( $code, 0, 600 ),
			'brief'    => mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'brief', $row['brief'] ) ), 0, 20000 ),
			'title'    => mb_substr( sanitize_text_field( (string) Rest::p( $req, 'title', $row['title'] ) ), 0, 300 ),
			'status'   => 'submitted',
			'round'    => (int) $row['round'] + 1,
			'updated'  => Data::now(),
		], [ 'id' => $id ] );
		return [ 'id' => $id, 'status' => 'submitted', 'round' => (int) $row['round'] + 1 ];
	}

	/** GET demo/submissions — public transparency list. */
	public static function list_all( $req ) {
		self::ensure_tables();
		global $wpdb;
		$rows = $wpdb->get_results( 'SELECT id, author_id, title, status, round, score, doi, animation_id, created, updated FROM '
			. Data::t( 'aq_demo_subs' ) . ' ORDER BY id DESC LIMIT 100', ARRAY_A );
		return [ 'items' => array_map( static function ( $r ) {
			$au = get_userdata( (int) $r['author_id'] );
			$r['author'] = $au ? $au->display_name : '';
			return $r;
		}, (array) $rows ) ];
	}

	/** GET demo/submissions/{id} — one submission + every round's independent reviews. */
	public static function get( $req ) {
		self::ensure_tables();
		global $wpdb;
		$id  = Rest::pint( $req, 'id' );
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_demo_subs' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $row ) { return Rest::err( 'not_found', 'Submission not found', 404 ); }
		$revs = $wpdb->get_results( $wpdb->prepare(
			'SELECT round, reviewer, verdict, score, report, created FROM ' . Data::t( 'aq_demo_reviews' )
			. ' WHERE submission_id = %d ORDER BY round ASC, reviewer ASC', $id ), ARRAY_A );
		$au = get_userdata( (int) $row['author_id'] );
		$row['author'] = $au ? $au->display_name : '';
		$row['reviews'] = (array) $revs;
		return $row;
	}

	/** GET demo/status — liveness + queue depth for transparency. */
	public static function status( $req = null ) {
		self::ensure_tables();
		global $wpdb;
		$t = Data::t( 'aq_demo_subs' );
		return [
			'online'    => (bool) get_transient( 'aq_demo_beat' ),
			'queued'    => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$t} WHERE status IN ('submitted','reviewing')" ),
			'accepted'  => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$t} WHERE status IN ('accepted','rendering')" ),
			'published' => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$t} WHERE status = 'published'" ),
			'reviewers' => self::REVIEWERS,
		];
	}

	/**
	 * POST relay/demo/poll — claim work. Review jobs first (oldest submitted); when none, a RENDER
	 * job (oldest accepted): rendering + publication happen ONLY after the code is accepted.
	 */
	public static function poll( $req ) {
		self::ensure_tables();
		set_transient( 'aq_demo_beat', time(), 120 );
		global $wpdb;
		if ( ! get_transient( 'aq_demo_reclaim' ) ) {
			set_transient( 'aq_demo_reclaim', 1, 60 );
			$wpdb->query( $wpdb->prepare( 'UPDATE ' . Data::t( 'aq_demo_subs' )
				. " SET status = 'submitted' WHERE status = 'reviewing' AND updated < %d", Data::now() - 7200 ) );
			$wpdb->query( $wpdb->prepare( 'UPDATE ' . Data::t( 'aq_demo_subs' )
				. " SET status = 'accepted' WHERE status = 'rendering' AND updated < %d", Data::now() - 7200 ) );
		}
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_demo_subs' ) . " WHERE status = 'submitted' ORDER BY id ASC LIMIT 1" );
		if ( $row && Data::update( 'aq_demo_subs', [ 'status' => 'reviewing', 'updated' => Data::now() ],
				[ 'id' => (int) $row['id'], 'status' => 'submitted' ] ) ) {
			$au = get_userdata( (int) $row['author_id'] );
			// BLIND: the brief carries no prior rounds' reports — each round judges the source fresh.
			return [ 'job' => [
				'kind'      => 'review',
				'id'        => (int) $row['id'],
				'round'     => (int) $row['round'],
				'max_rounds' => self::MAX_ROUNDS,
				'reviewers' => self::REVIEWERS,
				'author'    => $au ? $au->display_name : '',
				'title'     => (string) $row['title'],
				'brief'     => (string) $row['brief'],
				'code_url'  => (string) $row['code_url'],
			] ];
		}
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_demo_subs' ) . " WHERE status = 'accepted' ORDER BY id ASC LIMIT 1" );
		if ( $row && Data::update( 'aq_demo_subs', [ 'status' => 'rendering', 'updated' => Data::now() ],
				[ 'id' => (int) $row['id'], 'status' => 'accepted' ] ) ) {
			return [ 'job' => [
				'kind'         => 'render',
				'id'           => (int) $row['id'],
				'title'        => (string) $row['title'],
				'brief'        => (string) $row['brief'],
				'code_url'     => (string) $row['code_url'],
				'animation_id' => (int) $row['animation_id'],
			] ];
		}
		return [ 'job' => null ];
	}

	/**
	 * POST relay/demo/complete { id, reviews: [{verdict, score, report}, …] } — record the round's
	 * INDEPENDENT verdicts and advance. Majority decides (accept needs a strict majority of accepts;
	 * a strict majority of rejects rejects; anything else is revise); score = median. A revise at
	 * the final round is coerced to reject. Idempotent per (id, round).
	 */
	public static function complete( $req ) {
		self::ensure_tables();
		global $wpdb;
		$id  = (int) Rest::p( $req, 'id', 0 );
		$row = $id ? Data::one( 'SELECT * FROM ' . Data::t( 'aq_demo_subs' ) . ' WHERE id = %d', [ $id ] ) : null;
		if ( ! $row ) { return Rest::err( 'not_found', 'Submission not found', 404 ); }
		if ( $row['status'] !== 'reviewing' ) { return [ 'ok' => true, 'note' => 'not in review' ]; }
		$round = (int) $row['round'];
		$dup = Data::one( 'SELECT id FROM ' . Data::t( 'aq_demo_reviews' ) . ' WHERE submission_id = %d AND round = %d', [ $id, $round ] );
		if ( $dup ) { return [ 'ok' => true, 'note' => 'round already recorded' ]; }

		$reviews = Rest::p( $req, 'reviews', [] );
		if ( ! is_array( $reviews ) || count( $reviews ) < 1 ) { return Rest::err( 'bad_input', 'reviews[] required' ); }
		$reviews = array_slice( array_values( $reviews ), 0, self::REVIEWERS );
		$votes = [ 'accept' => 0, 'revise' => 0, 'reject' => 0 ];
		$scores = [];
		$merged = [];
		foreach ( $reviews as $i => $rv ) {
			$v = in_array( $rv['verdict'] ?? '', [ 'accept', 'revise', 'reject' ], true ) ? (string) $rv['verdict'] : 'revise';
			$s = max( 0, min( 100, (int) ( $rv['score'] ?? 0 ) ) );
			$votes[ $v ]++; $scores[] = $s;
			$rep = (string) ( $rv['report'] ?? '' );
			Data::insert( 'aq_demo_reviews', [
				'submission_id' => $id, 'round' => $round, 'reviewer' => $i + 1,
				'verdict' => $v, 'score' => $s, 'report' => $rep, 'created' => Data::now(),
			] );
			$merged[] = "## Independent reviewer " . ( $i + 1 ) . " — {$v}, {$s}/100\n\n" . $rep;
		}
		sort( $scores );
		$median = $scores[ (int) floor( ( count( $scores ) - 1 ) / 2 ) ];
		$need = (int) floor( count( $reviews ) / 2 ) + 1;
		$verdict = 'revise';
		if ( $votes['accept'] >= $need ) { $verdict = 'accept'; }
		elseif ( $votes['reject'] >= $need ) { $verdict = 'reject'; }
		if ( $verdict === 'revise' && $round >= self::MAX_ROUNDS ) { $verdict = 'reject'; }
		$status = [ 'accept' => 'accepted', 'revise' => 'revisions-requested', 'reject' => 'rejected' ][ $verdict ];
		Data::update( 'aq_demo_subs', [
			'status'  => $status,
			'score'   => (int) $median,
			'report'  => implode( "\n\n---\n\n", $merged ),
			'updated' => Data::now(),
		], [ 'id' => $id ] );
		return [ 'ok' => true, 'verdict' => $verdict, 'status' => $status, 'score' => (int) $median, 'votes' => $votes ];
	}

	/** POST relay/demo/release { id } — hand a claimed job back (daemon shutdown). */
	public static function release( $req ) {
		self::ensure_tables();
		$id  = (int) Rest::p( $req, 'id', 0 );
		$row = $id ? Data::one( 'SELECT * FROM ' . Data::t( 'aq_demo_subs' ) . ' WHERE id = %d', [ $id ] ) : null;
		if ( ! $row ) { return [ 'ok' => true ]; }
		if ( $row['status'] === 'reviewing' ) { Data::update( 'aq_demo_subs', [ 'status' => 'submitted', 'updated' => Data::now() ], [ 'id' => $id ] ); }
		if ( $row['status'] === 'rendering' ) { Data::update( 'aq_demo_subs', [ 'status' => 'accepted', 'updated' => Data::now() ], [ 'id' => $id ] ); }
		return [ 'ok' => true ];
	}

	/**
	 * POST relay/demo/publish { id, video_url, poster, seconds, summary? } — the accept-gated
	 * ArtaMotion step: only an accepted (rendering) submission can publish. Mints the permanent
	 * Zenodo DOI for the RENDERED VIDEO + source bundle, then creates (or updates, when the
	 * submission carries animation_id) the aq_animations row. Idempotent: an existing DOI is
	 * never re-minted.
	 */
	public static function publish( $req ) {
		self::ensure_tables();
		$id  = (int) Rest::p( $req, 'id', 0 );
		$row = $id ? Data::one( 'SELECT * FROM ' . Data::t( 'aq_demo_subs' ) . ' WHERE id = %d', [ $id ] ) : null;
		if ( ! $row ) { return Rest::err( 'not_found', 'Submission not found', 404 ); }
		if ( ! in_array( $row['status'], [ 'rendering', 'accepted', 'published' ], true ) ) {
			return Rest::err( 'bad_state', 'Only an ACCEPTED submission can publish — the review gate is the point', 409 );
		}
		$video  = trim( (string) Rest::p( $req, 'video_url', $row['video_url'] ) );
		$poster = trim( (string) Rest::p( $req, 'poster', $row['poster'] ) );
		$secs   = max( 0, (int) Rest::p( $req, 'seconds', $row['seconds'] ) );
		$sum    = sanitize_textarea_field( (string) Rest::p( $req, 'summary', '' ) );
		if ( ! self::is_url( $video ) || ! self::is_url( $poster ) ) { return Rest::err( 'bad_input', 'video_url and poster (https) are required' ); }

		// Mint once (crash-safe): an existing DOI is permanent.
		$doi = (string) $row['doi']; $rec = (string) $row['record_url'];
		if ( $doi === '' ) {
			$mint = self::mint_doi( $row, $video );
			$doi  = (string) ( $mint['doi'] ?? '' );
			$rec  = (string) ( $mint['record_url'] ?? '' );
		}

		// The animation row — update in place when the submission targets an existing one.
		// Member-facing text carries ONLY the short link (operator 2026-07-13: the archive
		// provider — and the raw identifier that names it — never appears in the frontend).
		$anim_id = (int) $row['animation_id'];
		$brief   = (string) $row['brief'] . ( $doi !== '' ? "\n\nReviewed and accepted by ArtaDemo (" . self::REVIEWERS . " independent AI reviewers, score {$row['score']}/100). Permanent record: " . Doi::demo_link( $id ) : '' );
		if ( $anim_id ) {
			Data::update( 'aq_animations', [
				'title' => (string) $row['title'], 'brief' => $brief,
				'summary' => $sum !== '' ? $sum : null,
				'video_url' => $video, 'poster' => $poster, 'seconds' => $secs,
				'updated' => Data::now(),
			], [ 'id' => $anim_id ] );
		} else {
			$anim_id = (int) Data::insert( 'aq_animations', [
				'author_id' => (int) $row['author_id'],
				'slug'      => sanitize_title( mb_substr( (string) $row['title'], 0, 120 ) ) . '-' . $id,
				'title'     => (string) $row['title'],
				'seconds'   => $secs,
				'brief'     => $brief,
				'summary'   => $sum,
				'video_url' => $video,
				'poster'    => $poster,
				'rights_ok' => 1,
				'status'    => 'published',
				'created'   => Data::now(),
				'updated'   => Data::now(),
			] );
		}
		Data::update( 'aq_demo_subs', [
			'status' => 'published', 'doi' => mb_substr( $doi, 0, 120 ), 'record_url' => mb_substr( $rec, 0, 300 ),
			'animation_id' => $anim_id, 'video_url' => mb_substr( $video, 0, 600 ),
			'poster' => mb_substr( $poster, 0, 600 ), 'seconds' => $secs, 'updated' => Data::now(),
		], [ 'id' => $id ] );
		return [ 'ok' => true, 'id' => $id, 'animation_id' => $anim_id, 'doi' => $doi, 'record_url' => $rec ];
	}

	/** Zenodo deposition for the rendered video (+ source link). Vault token only; best-effort. */
	private static function mint_doi( $row, $video_url ) {
		$token = class_exists( '\\AQ\\Vault' ) ? (string) Vault::get( 'ZENODO_TOKEN' ) : '';
		if ( $token === '' ) { return []; }
		$base = 'https://zenodo.org/api';
		$auth = [ 'Authorization' => 'Bearer ' . $token ];
		$dep_r = wp_remote_post( $base . '/deposit/depositions', [ 'timeout' => 40, 'headers' => $auth + [ 'Content-Type' => 'application/json' ], 'body' => '{}' ] );
		if ( is_wp_error( $dep_r ) || (int) wp_remote_retrieve_response_code( $dep_r ) >= 400 ) { return []; }
		$dep    = json_decode( wp_remote_retrieve_body( $dep_r ), true );
		$dep_id = (int) ( $dep['id'] ?? 0 );
		$bucket = (string) ( $dep['links']['bucket'] ?? '' );
		if ( ! $dep_id || ! $bucket ) { return []; }
		try {
			// SSRF: https-host validated; no redirects.
			$vr = wp_remote_get( $video_url, [ 'timeout' => 120, 'redirection' => 0 ] );
			if ( is_wp_error( $vr ) || (int) wp_remote_retrieve_response_code( $vr ) >= 400 ) { throw new \Exception( 'video fetch failed' ); }
			$bytes = (string) wp_remote_retrieve_body( $vr );
			if ( $bytes === '' ) { throw new \Exception( 'empty video' ); }
			$up = wp_remote_request( $bucket . '/' . rawurlencode( $row['id'] . '.mp4' ), [ 'method' => 'PUT', 'timeout' => 120, 'headers' => $auth + [ 'Content-Type' => 'application/octet-stream' ], 'body' => $bytes ] );
			if ( is_wp_error( $up ) || (int) wp_remote_retrieve_response_code( $up ) >= 400 ) { throw new \Exception( 'file upload failed' ); }
			$au  = get_userdata( (int) $row['author_id'] );
			$nm  = $au ? trim( (string) $au->display_name ) : 'ArtaQuest Foundation';
			$fam = ( strpos( $nm, ' ' ) !== false ) ? ( substr( strrchr( $nm, ' ' ), 1 ) . ', ' . trim( substr( $nm, 0, strrpos( $nm, ' ' ) ) ) ) : $nm;
			$meta = [ 'metadata' => [
				'title'            => (string) $row['title'],
				'upload_type'      => 'video',
				'description'      => (string) $row['brief'] . '<br><br>Reviewed and accepted by ArtaDemo (' . self::REVIEWERS . ' independent AI reviewers). Source: ' . (string) $row['code_url'],
				'creators'         => [ [ 'name' => $fam, 'affiliation' => 'ArtaDemo (ArtaQuest Foundation)' ] ],
				'access_right'     => 'open',
				'license'          => 'cc-by-4.0',
				'publication_date' => gmdate( 'Y-m-d' ),
				'related_identifiers' => [ [ 'identifier' => (string) $row['code_url'], 'relation' => 'isSupplementedBy', 'scheme' => 'url' ] ],
			] ];
			$mr = wp_remote_request( $base . '/deposit/depositions/' . $dep_id, [ 'method' => 'PUT', 'timeout' => 40, 'headers' => $auth + [ 'Content-Type' => 'application/json' ], 'body' => wp_json_encode( $meta ) ] );
			if ( is_wp_error( $mr ) || (int) wp_remote_retrieve_response_code( $mr ) >= 400 ) { throw new \Exception( 'metadata failed' ); }
			$pb = wp_remote_post( $base . '/deposit/depositions/' . $dep_id . '/actions/publish', [ 'timeout' => 60, 'headers' => $auth ] );
			if ( is_wp_error( $pb ) || (int) wp_remote_retrieve_response_code( $pb ) >= 400 ) { throw new \Exception( 'publish failed' ); }
			$pub = json_decode( wp_remote_retrieve_body( $pb ), true );
			return [ 'doi' => (string) ( $pub['doi'] ?? $pub['metadata']['doi'] ?? '' ), 'record_url' => (string) ( $pub['links']['record_html'] ?? '' ) ];
		} catch ( \Throwable $e ) {
			wp_remote_request( $base . '/deposit/depositions/' . $dep_id, [ 'method' => 'DELETE', 'timeout' => 20, 'headers' => $auth ] );
			return [];
		}
	}
}
