<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Kaggle-style engagement AWARDS (badges). A member earns badges by doing the things the
 * platform values — finishing courses, asking questions, earning upvotes, placing on a
 * course podium, growing a following, giving back. Badges are a public, free-to-earn
 * incentive layer; they are PURELY DERIVED from the existing tables (enrol, section
 * comments/votes, points/coin ledgers, season results, follows, findings), never stored.
 *
 * Why computed, not granted+stored:
 *   - No new table, no migration, no background granting cron, no idempotency bookkeeping.
 *   - A badge can never drift from reality — it IS reality, recomputed on read.
 *   - Adding a badge = one row in CATALOG (+ maybe one metric). That's the whole change,
 *     which is exactly what the "keep adding badges" dev cycle needs.
 *
 * Each catalog row is [ key, group, tier, icon, label, desc, metric, need ]: the member
 * earns it when metrics()[metric] >= need. Rank-based badges become plain counts (wins,
 * podiums, top10, top100) so every badge is uniformly a "have >= need" check with honest
 * progress toward the next one.
 */
final class Awards {

	/** Visual tiers — expressed only in the brand's gold+blue (never a third accent). */
	const TIER_BRONZE = 'bronze';
	const TIER_SILVER = 'silver';
	const TIER_GOLD   = 'gold';

	/** Members who joined on or before this date are "early adopters" — ArtaQuest's first season. */
	const EARLY_CUTOFF = '2026-07-06';

	/**
	 * The badge catalog. Append a row to add a badge — nothing else to wire on the backend.
	 * [ key, group, tier, icon, label, desc, metric, need ]
	 */
	public static function catalog() {
		return [
			// ── Learning ──────────────────────────────────────────────────────
			[ 'first_steps', 'learning', self::TIER_BRONZE, 'compass', 'First Steps', 'Took the first step and enrolled in a course', 'enrolled', 1 ],
			[ 'lifelong_learner', 'learning', self::TIER_SILVER, 'books', 'Lifelong Learner', 'Enrolled in five courses — a habit of learning', 'enrolled', 5 ],
			[ 'veteran',          'learning', self::TIER_GOLD,   'books', 'Veteran',          'Enrolled in ten courses', 'enrolled', 10 ],
			[ 'graduate',    'learning', self::TIER_SILVER, 'cap',     'Graduate',    'Engaged every section to earn your first certificate', 'certificates', 1 ],
			[ 'scholar',     'learning', self::TIER_SILVER,   'cap',     'Scholar',     'Earned certificates in three courses', 'certificates', 3 ],
			[ 'polymath',    'learning', self::TIER_GOLD,   'cap',     'Polymath',    'Earned certificates in ten courses', 'certificates', 10 ],
			[ 'reviewer',    'learning', self::TIER_SILVER, 'pen',     'Reviewer',    'Shared five course reviews to guide other learners', 'reviews', 5 ],
			[ 'critic',      'learning', self::TIER_GOLD,   'pen',     'Critic',      'Wrote twenty course reviews', 'reviews', 20 ],
			[ 'eclectic',    'learning', self::TIER_SILVER,   'mosaic',     'Eclectic',    'Certified across courses from three different creators', 'channels_certified', 3 ],
			[ 'top_of_class', 'learning', self::TIER_GOLD,   'cap',     'Top of Class', 'Earned a certificate in a course with twenty or more learners', 'big_course_certs', 1 ],
			[ 'completionist','learning', self::TIER_GOLD,   'flag',    'Completionist','Completed every section of a course ten parts or longer', 'long_course_certs', 1 ],

			// ── Discussion (each section's board — replies + upvotes; only upvotes earned matter) ──
			[ 'first_question', 'discussion', self::TIER_BRONZE, 'question', 'First Reply',    'Joined a section board with your first reply', 'comments', 1 ],
			[ 'curious',        'discussion', self::TIER_SILVER, 'question', 'Curious Mind',   'Posted ten section replies', 'comments', 10 ],
			[ 'inquisitor',     'discussion', self::TIER_GOLD,   'question', 'Inquisitor',     'Posted fifty section replies', 'comments', 50 ],
			[ 'prolific',       'discussion', self::TIER_GOLD,   'question', 'Prolific',       'Posted two hundred section replies', 'comments', 200 ],
			[ 'first_fan',      'discussion', self::TIER_BRONZE, 'star',     'First Fan',      'Earned your first upvote from a peer', 'upvotes_received', 1 ],
			[ 'well_received',  'discussion', self::TIER_SILVER, 'star',     'Well Received',  'Earned ten upvotes on your replies', 'upvotes_received', 10 ],
			[ 'crowd_favourite','discussion', self::TIER_GOLD,   'star',     'Crowd Favourite','Earned a hundred upvotes on your replies', 'upvotes_received', 100 ],
			[ 'standout',       'discussion', self::TIER_SILVER,   'trophy',     'Standout',       'One reply struck a chord — ten upvotes on a single post', 'best_comment_votes', 10 ],
			[ 'iconic',         'discussion', self::TIER_GOLD,   'star',     'Iconic',         'Earned a thousand upvotes on your replies', 'upvotes_received', 1000 ],
			[ 'generous_voter', 'discussion', self::TIER_SILVER, 'heart',    'Generous Voter', 'Cast twenty-five upvotes to lift peers up', 'upvotes_cast', 25 ],
			[ 'top_voter',      'discussion', self::TIER_GOLD,   'heart',    'Top Voter',      'Cast a hundred upvotes to lift peers up', 'upvotes_cast', 100 ],
			[ 'conversationalist','discussion', self::TIER_SILVER, 'chat',   'Conversationalist','Replied in ten threads to keep conversations going', 'replies', 10 ],
			[ 'debater',        'discussion', self::TIER_GOLD,   'chat',   'Debater',         'Posted fifty threaded replies', 'replies', 50 ],
			[ 'broad_mind',     'discussion', self::TIER_SILVER,   'map',    'Broad Mind',      'Joined the discussion in three different courses', 'courses_engaged', 3 ],
			[ 'connoisseur',    'discussion', self::TIER_SILVER,   'heart',  'Connoisseur',     'Upvoted peers in three different courses', 'courses_voted', 3 ],
			[ 'mentor',         'discussion', self::TIER_SILVER,   'sparkle','Mentor',          'Your threaded replies earned twenty-five upvotes', 'reply_upvotes', 25 ],
			[ 'sage',           'discussion', self::TIER_GOLD,   'sparkle','Sage',            'Your threaded replies earned a hundred upvotes', 'reply_upvotes', 100 ],

			// ── Competition (course podium, per season) ─────────────────────────
			[ 'contender',      'competition', self::TIER_BRONZE, 'medal',    'Contender',      'Finished in the top 100 of a course season', 'top100', 1 ],
			[ 'challenger',     'competition', self::TIER_SILVER, 'medal',    'Challenger',     'Finished in the top 10 of a course season', 'top10', 1 ],
			[ 'finalist',       'competition', self::TIER_SILVER, 'podium',    'Finalist',       'Finished on a course podium — top three for the season', 'podiums', 1 ],
			[ 'champion',       'competition', self::TIER_GOLD,   'trophy',    'Champion',       'Won a course season — first on the leaderboard', 'wins', 1 ],
			[ 'podium_regular', 'competition', self::TIER_GOLD,   'podium',    'Podium Regular', 'Reached a course podium three times', 'podiums', 3 ],
			[ 'season_veteran', 'competition', self::TIER_SILVER, 'calendar', 'Season Veteran', 'Placed in three different seasons', 'seasons_placed', 3 ],
			[ 'grand_slam',     'competition', self::TIER_GOLD,   'crown',    'Grand Slam',     'Reached the podium in three different courses', 'grand_slam_courses', 3 ],

			// ── Community ───────────────────────────────────────────────────────
			[ 'community_voice', 'community', self::TIER_BRONZE, 'chat', 'Community Voice', 'Opened your first discussion thread', 'threads', 1 ],
			[ 'first_follower',  'community', self::TIER_BRONZE, 'people', 'First Follower',  'Gained your first follower', 'followers', 1 ],
			[ 'connector',       'community', self::TIER_SILVER, 'people', 'Connector',       'Reached ten followers', 'followers', 10 ],
			[ 'influencer',      'community', self::TIER_GOLD,   'people', 'Influencer',      'Reached a hundred followers', 'followers', 100 ],
			[ 'luminary',        'community', self::TIER_GOLD,   'people', 'Luminary',        'Reached a thousand followers', 'followers', 1000 ],
			[ 'polyglot',        'community', self::TIER_SILVER, 'globe',  'Polyglot',        'Started discussions in two or more languages', 'langs', 2 ],
			[ 'orator',          'community', self::TIER_SILVER, 'mic',    'Orator',          'Opened ten discussion threads', 'threads', 10 ],
			[ 'town_crier',      'community', self::TIER_GOLD,   'mic',    'Town Crier',      'Opened fifty discussion threads', 'threads', 50 ],
			[ 'generalist',      'community', self::TIER_SILVER,   'tag',    'Generalist',      'Opened discussions across three different topics', 'topics_active', 3 ],
			[ 'trendsetter',     'community', self::TIER_SILVER,   'flame',  'Trendsetter',     'Opened a discussion that rose to ten net upvotes', 'top_thread_score', 10 ],

			// ── Generosity / economy ────────────────────────────────────────────
			[ 'coin_holder',    'economy', self::TIER_BRONZE, 'coin',  'Coin Holder',    'Hold at least one gold-backed coin', 'coins', 1 ],
			[ 'coin_collector', 'economy', self::TIER_SILVER, 'coin',  'Coin Collector', 'Hold a hundred gold-backed coins', 'coins', 100 ],
			[ 'benefactor',    'economy', self::TIER_BRONZE, 'gift', 'Benefactor',    'Gave back with your first donation', 'donate_points', 1 ],
			[ 'patron',        'economy', self::TIER_SILVER, 'gift', 'Patron',        'Donated enough to earn twenty-five giving points', 'donate_points', 25 ],
			[ 'philanthropist','economy', self::TIER_GOLD,   'gift', 'Philanthropist','Donated enough to earn a hundred giving points', 'donate_points', 100 ],

			// ── Service / stewardship ───────────────────────────────────────────
			[ 'bug_hunter', 'service', self::TIER_BRONZE, 'bug',    'Bug Hunter', 'Reported your first issue to improve ArtaQuest', 'findings', 1 ],
			[ 'sentinel',   'service', self::TIER_SILVER, 'bug',    'Sentinel',   'Reported three issues', 'findings', 3 ],
			[ 'guardian',   'service', self::TIER_GOLD,   'shield', 'Guardian',   'Reported ten issues — a true guardian', 'findings', 10 ],
			[ 'contributor','service', self::TIER_SILVER, 'bulb',   'Contributor','Sent five contributions of any kind — bugs, ideas, content or suggestions', 'contributions', 5 ],

			// ── Standing (lifetime points → tier ladder) ────────────────────────
			[ 'explorer', 'standing', self::TIER_SILVER, 'flame', 'Creator', 'Reached the Creator tier (1k points)', 'points', 1000 ],
			[ 'voyager',  'standing', self::TIER_GOLD,   'flame',  'Expert',  'Reached the Expert tier (10k points)', 'points', 10000 ],
			[ 'well_rounded', 'standing', self::TIER_SILVER, 'rings', 'Well-Rounded', 'Earned points across three tracks — learning, giving and volunteering', 'tracks_active', 3 ],
			[ 'pioneer',  'standing', self::TIER_GOLD,   'flame',  'Pioneer',  'Reached the Pioneer tier (100k points)', 'points', 100000 ],
			[ 'legend',   'standing', self::TIER_GOLD,   'flame',  'Legend',   'Reached the Legend tier (1M points)', 'points', 1000000 ],
			[ 'early_adopter', 'standing', self::TIER_SILVER, 'rocket', 'Early Adopter', 'Joined in ArtaQuest\'s first season', 'early_member', 1 ],
			[ 'loyal',         'standing', self::TIER_SILVER,   'calendar', 'Loyal', 'A member for a full year', 'member_year', 1 ],
			[ 'dedicated',     'standing', self::TIER_SILVER,   'calendar', 'Dedicated', 'Showed up and took part on ten different days', 'active_days', 10 ],
			[ 'devoted',       'standing', self::TIER_GOLD,     'calendar', 'Devoted', 'Showed up on fifty different days — a steady habit', 'active_days', 50 ],
			[ 'on_a_roll',     'standing', self::TIER_SILVER,   'flame',    'On a Roll', 'Took part seven days in a row', 'streak', 7 ],
			[ 'triple_crown',  'standing', self::TIER_GOLD,   'crown',    'Triple Crown', 'Learned, competed and contributed — a certificate, a podium and a discussion', 'triple_crown', 1 ],
		];
	}

	/**
	 * Every "have" value a badge can test, computed for one member in a handful of indexed
	 * queries. Keys match the `metric` column of the catalog. Add a metric here when a new
	 * badge needs one the others don't already provide.
	 */
	public static function metrics( $uid ) {
		$uid = (int) $uid;
		$zero = array_fill_keys( [
			'enrolled', 'certificates', 'big_course_certs', 'comments', 'replies', 'reply_upvotes', 'reviews',
			'upvotes_received', 'upvotes_cast', 'threads', 'followers', 'langs', 'coins', 'points', 'donate_points', 'tracks_active',
			'findings', 'contributions', 'wins', 'podiums', 'top10', 'top100', 'seasons_placed', 'grand_slam_courses', 'early_member', 'member_year', 'active_days', 'streak', 'long_course_certs', 'courses_engaged', 'courses_voted', 'topics_active', 'channels_certified', 'top_thread_score', 'best_comment_votes', 'triple_crown',
		], 0 );
		if ( ! $uid ) { return $zero; }

		$points = Economy::points_balance( $uid );
		$tracks = Economy::points_by_track( $uid );
		// All section-comment aggregates in two reads (one over every comment, one over threaded
		// replies) instead of six single-column round-trips — same numbers, fewer queries.
		$T   = Data::t( 'aq_comments' );
		$sc  = Data::one( "SELECT COUNT(*) c, COUNT(DISTINCT course_id) ce, COALESCE(MAX(votes),0) mx, COALESCE(SUM(votes),0) sm FROM $T WHERE context_type = 'section' AND author_id = %d", [ $uid ] ) ?: [];
		$scr = Data::one( "SELECT COUNT(*) c, COALESCE(SUM(votes),0) sm FROM $T WHERE context_type = 'section' AND author_id = %d AND parent_id > 0", [ $uid ] ) ?: [];
		// All published-thread aggregates in one read instead of four (count, top score, distinct
		// languages, distinct non-empty topics) — same numbers, fewer round-trips.
		$Th = Data::t( 'aq_threads' );
		$th = Data::one( "SELECT COUNT(*) n, COALESCE(MAX(vote_score),0) mx, COUNT(DISTINCT lang) nl, COUNT(DISTINCT CASE WHEN topic <> '' THEN topic END) nt FROM $Th WHERE author_id = %d AND status = 'publish'", [ $uid ] ) ?: [];
		// Tickets in one read — total (any kind) + just the bugs — plus the legacy bug-findings count
		// once, shared by both the bug ladder (findings) and the all-kinds badge (contributions).
		$tk = Data::one( "SELECT COUNT(*) c, COALESCE(SUM(CASE WHEN kind = 'bug' THEN 1 ELSE 0 END),0) b FROM " . Data::t( 'aq_tickets' ) . ' WHERE user_id = %d', [ $uid ] ) ?: [];
		$bf = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_bug_findings' ) . ' WHERE user_id = %d', [ $uid ] );
		// Active day-buckets (FLOOR(created/86400)) read once — both active_days (their count) and the
		// streak (longest consecutive run) derive from this, so the points ledger is scanned just once.
		$days = array_map( fn( $r ) => (int) $r['d'], Data::all( 'SELECT DISTINCT FLOOR(created / 86400) d FROM ' . Data::t( 'aq_points_ledger' ) . ' WHERE user_id = %d ORDER BY d', [ $uid ] ) );
		$m = [
			'enrolled'         => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_enroll' ) . ' WHERE user_id = %d', [ $uid ] ),
			'certificates'     => Learn::completed_count( $uid ),
			'comments'         => (int) ( $sc['c'] ?? 0 ),
			'courses_engaged'  => (int) ( $sc['ce'] ?? 0 ),
			'best_comment_votes' => (int) ( $sc['mx'] ?? 0 ),
			// Distinct creators/channels the member has certified from — breadth across teachers.
			'channels_certified' => (int) Data::col(
				'SELECT COUNT(DISTINCT c.channel) FROM ' . Data::t( 'aq_enroll' ) . ' e JOIN ' . Data::t( 'aq_courses' ) . " c ON c.id = e.course_id
				 WHERE e.user_id = %d AND e.pct >= %d AND c.channel <> ''",
				[ $uid, Learn::PASS_PCT ]
			),
			'courses_voted'    => (int) Data::col( 'SELECT COUNT(DISTINCT course_id) FROM ' . Data::t( 'aq_votes' ) . " WHERE target_type = 'comment' AND user_id = %d AND course_id > 0", [ $uid ] ),
			'topics_active'    => (int) ( $th['nt'] ?? 0 ),
			'replies'          => (int) ( $scr['c'] ?? 0 ),
			'reply_upvotes'    => (int) ( $scr['sm'] ?? 0 ),
			'reviews'          => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_reviews' ) . ' WHERE user_id = %d', [ $uid ] ),
			// Certificates earned in a course that's already crossed the reward-eligibility threshold (≥20 enrolled).
			'big_course_certs' => (int) Data::col(
				'SELECT COUNT(*) FROM ' . Data::t( 'aq_enroll' ) . ' e JOIN ' . Data::t( 'aq_courses' ) . ' c ON c.id = e.course_id
				 WHERE e.user_id = %d AND e.pct >= %d AND c.enroll_count >= %d',
				[ $uid, Learn::PASS_PCT, Economy::REWARD_MIN_ENROL ]
			),
			// Certificates earned in a LONG course (≥ 10 sections) — finishing the distance, not the crowd.
			'long_course_certs' => (int) Data::col(
				'SELECT COUNT(*) FROM ' . Data::t( 'aq_enroll' ) . ' e JOIN ' . Data::t( 'aq_courses' ) . ' c ON c.id = e.course_id
				 WHERE e.user_id = %d AND e.pct >= %d AND c.lesson_count >= 10',
				[ $uid, Learn::PASS_PCT ]
			),
			'upvotes_received' => (int) ( $sc['sm'] ?? 0 ),
			'upvotes_cast'     => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_votes' ) . " WHERE target_type = 'comment' AND user_id = %d AND course_id > 0", [ $uid ] ),
			'threads'          => (int) ( $th['n'] ?? 0 ),
			'top_thread_score' => (int) ( $th['mx'] ?? 0 ),
			'followers'        => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_follows' ) . ' WHERE target_id = %d', [ $uid ] ),
			'langs'            => (int) ( $th['nl'] ?? 0 ),
			'seasons_placed'   => (int) Data::col( 'SELECT COUNT(DISTINCT season_key) FROM ' . Data::t( 'aq_season_results' ) . ' WHERE user_id = %d AND place > 0', [ $uid ] ),
			'coins'            => Economy::coin_balance( $uid ),
			'points'           => $points,
			'donate_points'    => (int) ( $tracks['donate'] ?? 0 ),
			// How many standing tracks the member has scored on. Only learn/donate/volunteer are
			// credited today (Learn, Funds, Social); the outreach track exists as a bucket but nothing
			// awards it yet — so Well-Rounded needs 3, not 4, to stay earnable. (Still counts outreach
			// so the badge auto-upgrades in difficulty if outreach crediting is ever wired.)
			'tracks_active'    => count( array_filter( [ $tracks['learn'] ?? 0, $tracks['donate'] ?? 0, $tracks['volunteer'] ?? 0, $tracks['outreach'] ?? 0 ], fn( $v ) => (int) $v > 0 ) ),
			'findings'         => (int) ( $tk['b'] ?? 0 ) + $bf,
			// Contributions of ANY kind (bug/feature/content/suggestion) — the bug ladder only credits
			// 'bug', so this recognises feature/content/suggestion reporters too.
			'contributions'    => (int) ( $tk['c'] ?? 0 ) + $bf,
			// Consistency: count of distinct calendar days the member earned points on (any track).
			'active_days'      => count( $days ),
		];

		// Streak: longest run of CONSECUTIVE active days (day buckets one apart) — distinct from
		// active_days (total distinct days). Derived from the $days list above (already sorted), so
		// no extra query; a gaps-and-islands run isn't cheap in portable SQL anyway.
		$best = 0; $run = 0; $prev = null;
		foreach ( $days as $d ) {
			$run = ( $prev !== null && $d === $prev + 1 ) ? $run + 1 : 1;
			if ( $run > $best ) { $best = $run; }
			$prev = $d;
		}
		$m['streak'] = $best;

		// Loyalty: joined on or before the early-adopter cutoff (read straight off the WP user row).
		$u = get_userdata( $uid );
		$reg = ( $u && $u->user_registered ) ? strtotime( $u->user_registered ) : 0;
		$m['early_member'] = ( $reg && $reg <= strtotime( self::EARLY_CUTOFF . ' 23:59:59' ) ) ? 1 : 0;
		$m['member_year']  = ( $reg && $reg <= Data::now() - 31536000 ) ? 1 : 0; // a full year on ArtaQuest

		// Rank-based badges become plain counts: how many course-seasons the member placed in,
		// across archived snapshots + the live current season for any course they've engaged.
		$rows   = self::placements( $uid );
		$places = array_column( $rows, 'place' );
		$m['wins']    = count( array_filter( $places, fn( $p ) => $p === 1 ) );
		$m['podiums'] = count( array_filter( $places, fn( $p ) => $p <= 3 ) );
		$m['top10']   = count( array_filter( $places, fn( $p ) => $p <= 10 ) );
		$m['top100']  = count( array_filter( $places, fn( $p ) => $p <= 100 ) );
		// Grand slam = podium (top 3) in DIFFERENT courses, not just different seasons of one.
		$slam = [];
		foreach ( $rows as $r ) { if ( $r['place'] <= 3 ) { $slam[ $r['course'] ] = true; } }
		$m['grand_slam_courses'] = count( $slam );

		// Cross-pillar capstone: a "complete" member who has learned (a certificate), competed (a
		// podium) and contributed (started a discussion).
		$m['triple_crown'] = ( $m['certificates'] >= 1 && $m['podiums'] >= 1 && $m['threads'] >= 1 ) ? 1 : 0;

		return $m;
	}

	/** Every finishing rank this member has held — [place, course] rows — across archived
	 *  seasons + the live season (so course-spanning badges like the grand slam can be counted). */
	private static function placements( $uid ) {
		$uid    = (int) $uid;
		$places = [];
		foreach ( Data::all( 'SELECT place, course_id FROM ' . Data::t( 'aq_season_results' ) . ' WHERE user_id = %d AND place > 0', [ $uid ] ) as $r ) {
			$places[] = [ 'place' => (int) $r['place'], 'course' => (int) $r['course_id'] ];
		}
		$cur = Season::current();
		foreach ( Data::all( 'SELECT DISTINCT course_id FROM ' . Data::t( 'aq_comments' ) . " WHERE context_type = 'section' AND author_id = %d", [ $uid ] ) as $c ) {
			$cid = (int) $c['course_id'];
			foreach ( Economy::podium( $cid, 0, $cur['start'], $cur['end'] ) as $row ) {
				if ( (int) $row['user_id'] !== $uid ) { continue; }
				if ( (int) $row['votes'] > 0 ) { $places[] = [ 'place' => (int) $row['rank'], 'course' => $cid ]; } // a rank with 0 votes isn't a real placement
				break;
			}
		}
		return $places;
	}

	/** Evaluate the whole catalog for a member: each badge with earned-state + progress. */
	public static function evaluate( $uid ) {
		$m   = self::metrics( $uid );
		$out = [];
		foreach ( self::catalog() as [ $key, $group, $tier, $icon, $label, $desc, $metric, $need ] ) {
			$have = (int) ( $m[ $metric ] ?? 0 );
			$out[] = [
				'key'    => $key,
				'group'  => $group,
				'tier'   => $tier,
				'icon'   => $icon,
				'label'  => $label,
				'desc'   => $desc,
				'earned' => $have >= (int) $need,
				'have'   => $have,
				'need'   => (int) $need,
			];
		}
		return $out;
	}

	/**
	 * GET /awards?slug= — a member's badge wall (public). Without a slug, the signed-in
	 * member's own. Returns every catalog badge with earned-state + progress, plus a count,
	 * so the profile can showcase what's earned and tease what's next.
	 */
	public static function list( $req ) {
		$slug = sanitize_title( (string) Rest::p( $req, 'slug', '' ) );
		$u    = $slug ? get_user_by( 'slug', $slug ) : ( Rest::uid() ? get_userdata( Rest::uid() ) : null );
		if ( ! $u ) { return Rest::err( 'not_found', 'Member not found', 404 ); }
		$awards  = self::evaluate( (int) $u->ID );
		$earned  = array_values( array_filter( $awards, fn( $a ) => $a['earned'] ) );
		return [
			'slug'    => $u->user_nicename,
			'name'    => $u->display_name,
			'earned'  => count( $earned ),
			'total'   => count( $awards ),
			'awards'  => $awards,
		];
	}
}
