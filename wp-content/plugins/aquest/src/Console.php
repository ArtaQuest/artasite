<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Studio CONSOLE — the operator's control + monitor surface (operator-only: manage_options). It surfaces
 * the otherwise-headless Data-API discovery pipeline (discover → settle → prune; see YouTube.php) plus the
 * catalogue / cron / reserve health, so the operator can WATCH and DRIVE the platform from the Studio
 * instead of SSH + WP-cron. One read endpoint (dashboard) and three action endpoints:
 *
 *   GET  studio/console            → the full snapshot (north-star metric, discovery state, candidates, crons, reserve)
 *   POST studio/console/run        → run one pipeline job now (discover/settle/prune/trend_sweep/refresh/seed/purge)
 *   POST studio/console/config     → set the discovery levers (daily cap, per-run, rotation cursor)
 *   POST studio/console/candidate  → act on one incubating candidate (discard, or force-settle now)
 */
final class Console {

	/** Pipeline jobs the operator can trigger on demand → the same callbacks the WP-cron fires. */
	const JOBS = [
		'discover'    => [ 'YouTube', 'discover' ],               // search.list rotation → track candidates
		'settle'      => [ 'YouTube', 'settle_candidates' ],      // prove-then-add ripe candidates
		'prune'       => [ 'YouTube', 'prune_underperformers' ],  // drop persistent lows
		'trend_sweep' => [ 'YouTube', 'recompute_all_trends' ],   // re-score every course
		'refresh'     => [ 'YouTube', 'refresh_due' ],            // refresh due videos' comment counts
		'seed'        => [ 'Learn', 'seed_pending' ],             // seed any unseeded boards
		'purge'       => [ 'YouTube', 'purge_zero_rate' ],        // remove comment-less videos / empty courses
	];

	/** Operator gate — the whole console is manage_options only (it drives global crons + the quota). */
	private static function gate() { return user_can( Rest::uid(), 'manage_options' ); }

	/** GET studio/console — the full operator snapshot. */
	public static function dashboard( $req ) {
		if ( ! self::gate() ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		global $wpdb; $p = $wpdb->prefix; $now = time();

		// NORTH-STAR metric: total discussion = Σ each DISTINCT in-course video's rate (centi-comments/day).
		$pub = (int) Data::col( "SELECT COUNT(*) FROM {$p}aq_courses WHERE status='publish'" );
		$dv  = Data::one( "SELECT COUNT(*) n, COALESCE(SUM(rate),0) s FROM ( SELECT DISTINCT l.video v, vv.rate rate FROM {$p}aq_lessons l JOIN {$p}aq_videos vv ON vv.video=l.video WHERE l.video<>'' ) x" );
		$nvid = (int) ( $dv['n'] ?? 0 );
		$sum  = (int) ( $dv['s'] ?? 0 );
		$over5 = (int) Data::col( "SELECT COUNT(*) FROM ( SELECT course_id FROM {$p}aq_lessons WHERE video<>'' GROUP BY course_id HAVING COUNT(DISTINCT video) > %d ) x", [ YouTube::PRUNE_GATE ] );

		// Discovery state + the live candidate experiments.
		$cursor = (int) get_option( 'aq_discover_cursor', 0 );
		$next_title = (string) Data::col( "SELECT title FROM {$p}aq_courses WHERE status='publish' AND id > %d AND EXISTS (SELECT 1 FROM {$p}aq_lessons l WHERE l.course_id={$p}aq_courses.id AND l.video<>'') ORDER BY id ASC LIMIT 1", [ $cursor ] );
		if ( $next_title === '' ) { $next_title = (string) Data::col( "SELECT title FROM {$p}aq_courses WHERE status='publish' ORDER BY id ASC LIMIT 1" ); } // cursor about to wrap
		$cands = Data::all(
			"SELECT v.video, v.cand_course, v.cand_baseline, v.cand_until, v.rate, c.title
			   FROM {$p}aq_videos v JOIN {$p}aq_courses c ON c.id = v.cand_course
			  WHERE v.cand_course > 0 ORDER BY v.cand_until ASC LIMIT 100" );
		$candidates = array_map( function ( $r ) use ( $now ) {
			return [
				'video' => (string) $r['video'], 'course_id' => (int) $r['cand_course'], 'course' => (string) $r['title'],
				'baseline' => round( (int) $r['cand_baseline'] / 100, 2 ), 'rate' => round( (int) $r['rate'] / 100, 2 ),
				'ripe_in' => (int) $r['cand_until'] - $now, // ≤0 = ready for the next settle
			];
		}, $cands );

		// Crons: next-run + last-run HEALTH (from AQ\Cron::guard's per-job stats). next_in seconds (null =
		// not scheduled); last = seconds since the last run; ms = its duration; err = its last error (''
		// = clean); skip = times an overlap was skipped (a persistently rising skip count = the job runs
		// longer than its interval).
		$stats = Cron::stats();
		$crons = [];
		foreach ( [
			'aq_discover', 'aq_settle_candidates', 'aq_prune', 'aq_video_refresh', 'aq_trend_sweep', 'aq_video_sync',
			'aq_seed_boards', 'aq_purge_zero_rate', 'aq_moderate', 'aq_retriage', 'aq_dataset', 'aq_watchdog',
			'aq_season_reset', 'aq_payout_reconcile',
		] as $h ) {
			$n = wp_next_scheduled( $h );
			$s = isset( $stats[ $h ] ) && is_array( $stats[ $h ] ) ? $stats[ $h ] : [];
			$crons[] = [
				'hook' => $h,
				'next_in'  => $n ? (int) $n - $now : null,
				'schedule' => (string) wp_get_schedule( $h ),
				'last'     => isset( $s['at'] ) ? $now - (int) $s['at'] : null, // seconds since last run
				'ms'       => isset( $s['ms'] ) ? (int) $s['ms'] : null,
				'err'      => (string) ( $s['err'] ?? '' ),
				'skips'    => (int) ( $s['skip'] ?? 0 ),
			];
		}

		// Economy: the full-reserve invariant (gold backing ≥ coins issued).
		$issued  = (int) Economy::counter( 'coins_issued' );
		$backing = (int) Economy::backing_mg();

		return [
			'catalogue' => [
				'published_courses' => $pub, 'videos' => $nvid,
				'total_rate' => round( $sum / 100, 1 ),                 // total discussion velocity (comments/day) — the goal
				'avg_rate' => $nvid ? round( $sum / $nvid / 100, 2 ) : 0,
				'prune_eligible_courses' => $over5,
			],
			'discovery' => [
				'enabled' => YouTube::enabled(),
				'searches_today' => YouTube::discover_searches_today(),
				'cap' => YouTube::discover_cap(), 'per_run' => YouTube::discover_per_run(),
				'cursor' => $cursor, 'next_course' => $next_title,
				'candidate_count' => count( $candidates ), 'candidates' => $candidates,
				'last_discover' => get_option( 'aq_discover_last', null ),
				'last_settle' => get_option( 'aq_settle_last', null ),
				'last_prune' => get_option( 'aq_prune_last', null ),
			],
			'crons' => $crons,
			'research' => class_exists( '\\AQ\\Science' ) ? Science::console_panel() : null,
			'economy' => [ 'coins_issued' => $issued, 'backing_mg' => $backing, 'reserve_ok' => $backing >= $issued ],
			'system' => [ 'schema' => Schema::VERSION, 'aq_version' => defined( 'AQ_VERSION' ) ? AQ_VERSION : '' ],
			'jobs' => array_keys( self::JOBS ),
			'now' => $now,
		];
	}

	/** POST studio/console/run {job} — run one pipeline job now; returns its result. */
	public static function run( $req ) {
		if ( ! self::gate() ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		$job = sanitize_key( (string) Rest::p( $req, 'job', '' ) );
		if ( ! isset( self::JOBS[ $job ] ) ) { return Rest::err( 'bad_input', 'Unknown job' ); }
		list( $cls, $m ) = self::JOBS[ $job ];
		$r = call_user_func( [ 'AQ\\' . $cls, $m ] );
		return [ 'ok' => true, 'job' => $job, 'result' => is_array( $r ) ? $r : [ 'value' => $r ] ];
	}

	/** POST studio/console/config {cap?, per_run?, cursor?} — set the discovery levers (clamped). */
	public static function config( $req ) {
		if ( ! self::gate() ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		$set = [];
		if ( Rest::p( $req, 'cap', null ) !== null )     { $v = max( 0, min( 90, (int) Rest::p( $req, 'cap', 0 ) ) );     update_option( 'aq_discover_cap', $v, false );     $set['cap'] = $v; }
		if ( Rest::p( $req, 'per_run', null ) !== null ) { $v = max( 1, min( 10, (int) Rest::p( $req, 'per_run', 0 ) ) ); update_option( 'aq_discover_per_run', $v, false ); $set['per_run'] = $v; }
		if ( Rest::p( $req, 'cursor', null ) !== null )  { $v = max( 0, (int) Rest::p( $req, 'cursor', 0 ) );             update_option( 'aq_discover_cursor', $v, false );  $set['cursor'] = $v; }
		return [ 'ok' => true, 'set' => $set ];
	}

	/** POST studio/console/candidate {video, action: discard|settle} — operator control of one candidate. */
	public static function candidate( $req ) {
		if ( ! self::gate() ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		$video  = sanitize_text_field( (string) Rest::p( $req, 'video', '' ) );
		$action = sanitize_key( (string) Rest::p( $req, 'action', '' ) );
		if ( $video === '' ) { return Rest::err( 'bad_input', 'video required' ); }
		if ( $action === 'discard' ) { return [ 'ok' => YouTube::discard_candidate( $video ), 'action' => 'discard' ]; }
		if ( $action === 'settle' ) {
			if ( ! YouTube::ripen_candidate( $video ) ) { return [ 'ok' => false, 'action' => 'settle' ]; }
			return [ 'ok' => true, 'action' => 'settle', 'result' => YouTube::settle_candidates() ];
		}
		return Rest::err( 'bad_input', 'action must be discard or settle' );
	}

	/** GET studio/videos — every tracked video + its full state/metadata (operator). Searchable by id. */
	public static function videos( $req ) {
		if ( ! self::gate() ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		global $wpdb; $p = $wpdb->prefix; $now = time();
		$q = sanitize_text_field( (string) Rest::p( $req, 'q', '' ) );
		$where = ''; $args = [];
		if ( $q !== '' ) { $where = ' WHERE v.video LIKE %s'; $args[] = '%' . $wpdb->esc_like( $q ) . '%'; }
		$sql = "SELECT v.video, v.thumb, v.rate, v.views, v.view_count, v.like_count, v.missing, v.last_refresh, v.created, v.cand_course, v.cand_until, v.cand_baseline,
			(SELECT c.title FROM {$p}aq_lessons l JOIN {$p}aq_courses c ON c.id=l.course_id WHERE l.video=v.video LIMIT 1) AS course_title,
			(SELECT c.slug  FROM {$p}aq_lessons l JOIN {$p}aq_courses c ON c.id=l.course_id WHERE l.video=v.video LIMIT 1) AS course_slug,
			(SELECT title FROM {$p}aq_courses WHERE id=v.cand_course) AS cand_title
			FROM {$p}aq_videos v" . $where . ' ORDER BY v.rate DESC, v.last_refresh DESC LIMIT 400';
		$rows = $args ? $wpdb->get_results( $wpdb->prepare( $sql, $args ), ARRAY_A ) : $wpdb->get_results( $sql, ARRAY_A );
		$items = array_map( function ( $r ) use ( $now ) {
			$in_course = ! empty( $r['course_slug'] );
			$is_cand   = (int) $r['cand_course'] > 0;
			$state = $r['missing'] ? 'missing' : ( $is_cand ? 'candidate' : ( $in_course ? 'in-course' : 'standalone' ) );
			return [
				'video' => (string) $r['video'], 'thumb' => (string) $r['thumb'], 'state' => $state, 'missing' => (bool) $r['missing'],
				'rate' => round( (int) $r['rate'] / 100, 2 ), 'comments' => (int) $r['views'], 'views' => (int) $r['view_count'], 'likes' => (int) $r['like_count'],
				'course' => $in_course ? [ 'title' => (string) $r['course_title'], 'slug' => (string) $r['course_slug'] ] : null,
				'candidate' => $is_cand ? [ 'course' => (string) $r['cand_title'], 'course_id' => (int) $r['cand_course'], 'baseline' => round( (int) $r['cand_baseline'] / 100, 2 ), 'ripe_in' => (int) $r['cand_until'] - $now ] : null,
				'last_refresh' => (int) $r['last_refresh'], 'created' => (int) $r['created'],
			];
		}, (array) $rows );
		$counts = [
			'total'      => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$p}aq_videos" ),
			'candidates' => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$p}aq_videos WHERE cand_course > 0" ),
			'missing'    => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$p}aq_videos WHERE missing = 1" ),
		];
		return [ 'items' => $items, 'counts' => $counts, 'now' => $now ];
	}

	/** GET studio/members?q= — operator member directory: each member's points/tier, courses authored, join
	 *  date, and whether they can create courses (+ whether that's an operator grant vs point-earned). Search
	 *  by name/email/handle; newest first, capped. Operator only. */
	public static function members( $req ) {
		if ( ! self::gate() ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		global $wpdb;
		$q = trim( (string) Rest::p( $req, 'q', '' ) );
		$args = []; $where = '';
		if ( $q !== '' ) {
			$like  = '%' . $wpdb->esc_like( $q ) . '%';
			$where = 'WHERE ( u.display_name LIKE %s OR u.user_email LIKE %s OR u.user_nicename LIKE %s )';
			$args  = [ $like, $like, $like ];
		}
		$sql   = "SELECT u.ID, u.display_name, u.user_nicename, u.user_email, u.user_registered FROM {$wpdb->users} u $where ORDER BY u.user_registered DESC LIMIT 60";
		$users = $args ? $wpdb->get_results( $wpdb->prepare( $sql, $args ) ) : $wpdb->get_results( $sql );
		$ids   = array_map( fn( $u ) => (int) $u->ID, (array) $users );
		$pts = []; $crs = [];
		if ( $ids ) {
			$ph = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
			foreach ( $wpdb->get_results( $wpdb->prepare( 'SELECT user_id, COALESCE(SUM(delta),0) p FROM ' . Data::t( 'aq_points_ledger' ) . " WHERE user_id IN ($ph) GROUP BY user_id", $ids ) ) as $r ) { $pts[ (int) $r->user_id ] = (int) $r->p; }
			foreach ( $wpdb->get_results( $wpdb->prepare( 'SELECT author_id, COUNT(*) c FROM ' . Data::t( 'aq_courses' ) . " WHERE author_id IN ($ph) AND status='publish' GROUP BY author_id", $ids ) ) as $r ) { $crs[ (int) $r->author_id ] = (int) $r->c; }
		}
		$items = [];
		foreach ( (array) $users as $u ) {
			$uid = (int) $u->ID; $p = $pts[ $uid ] ?? 0;
			$tier = Extra::tier_for_points( $p );
			$op   = user_can( $uid, 'manage_options' );
			$granted = (bool) get_user_meta( $uid, 'aq_grant_create', true );
			$items[] = [
				'id' => $uid, 'name' => (string) $u->display_name, 'slug' => (string) $u->user_nicename, 'email' => (string) $u->user_email,
				'points' => $p, 'tier' => (string) $tier['label'], 'courses' => $crs[ $uid ] ?? 0, 'joined' => (int) strtotime( (string) $u->user_registered ),
				'can_create' => $op || $granted || ! empty( $tier['caps']['can_create'] ), 'granted' => $granted, 'operator' => $op,
			];
		}
		return [ 'items' => $items, 'total' => count( $items ) ];
	}

	/** POST studio/members/grant {user, grant} — operator unlocks/locks course-creation for a member (sets the
	 *  aq_grant_create override that Extra::creator_rank honours). Operators are left untouched. */
	public static function member_set( $req ) {
		if ( ! self::gate() ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		$uid = (int) Rest::p( $req, 'user', 0 );
		if ( ! $uid || ! get_userdata( $uid ) ) { return Rest::err( 'bad_input', 'Unknown member' ); }
		if ( user_can( $uid, 'manage_options' ) ) { return Rest::err( 'bad_input', 'That member is already an operator' ); }
		$grant = filter_var( Rest::p( $req, 'grant', false ), FILTER_VALIDATE_BOOLEAN );
		if ( $grant ) { update_user_meta( $uid, 'aq_grant_create', '1' ); } else { delete_user_meta( $uid, 'aq_grant_create' ); }
		return [ 'ok' => true, 'user' => $uid, 'granted' => $grant ];
	}
}
