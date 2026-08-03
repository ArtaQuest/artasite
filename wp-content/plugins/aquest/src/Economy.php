<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Two append-only ledgers, never mutated in place:
 *   - COINS  (aq_coin_ledger)  = money. 1 ₳ = 1 mg gold, full-reserve. Balance = SUM(delta).
 *   - POINTS (aq_points_ledger) = standing. Lifetime, never spent; sets the rank ladder.
 *
 * Append-only means race-free (no read-modify-write), auditable, and the full-reserve
 * invariant SUM(coin.delta) == backing is checkable at any instant. Tiers are derived
 * from lifetime points, never stored, so they can never drift from the ledger.
 */
final class Economy {

	/** Rank ladder by lifetime points (Quester → Legend). */
	const TIERS = [ 'Quester' => 0, 'Creator' => 1000, 'Expert' => 10000, 'Pioneer' => 100000, 'Legend' => 1000000 ];

	/** A course CREATOR's share of the NON-pool remainder (the ≤20% left after the questers' 80% pool),
	 *  by the creator's tier — the canonical revenue-share ladder. The foundation keeps the rest, so a
	 *  Legend creator's foundation cut is 0 ("Aquest takes nothing"). Mirrors the theme's aq_creator_tiers()
	 *  revenue_share (the careers/Teach page's documented model); the two are kept identical by hand (same
	 *  discipline as TIERS mirroring the ladder thresholds). Quester can't create, so its share is 0. */
	const TIER_SHARE = [ 'Quester' => 0.0, 'Creator' => 0.50, 'Expert' => 0.70, 'Pioneer' => 0.90, 'Legend' => 1.00 ];

	/** SHELF QUOTA (Creative Challenges, 2026-07-10): how many LIVE published creative works a member
	 *  may hold at once, by tier — 0 = unlimited (Legend). Publishing past the quota 409s
	 *  (`shelf_full`); deleting a work frees its slot (no refund, ever — coins and points are sunk).
	 *  The cap is the curation engine: hearts concentrate on fewer, better works, so pruning weaker
	 *  work raises a member's own prize odds. Enforced at the draft→published transition only —
	 *  members already over quota keep everything; they just can't publish new work until they prune. */
	const TIER_QUOTA = [ 'Quester' => 3, 'Creator' => 10, 'Expert' => 25, 'Pioneer' => 60, 'Legend' => 0 ];

	/** A member's shelf quota (0 = unlimited). Operators are never capped. */
	public static function shelf_quota( $uid ) {
		$uid = (int) $uid;
		if ( $uid && user_can( $uid, 'manage_options' ) ) { return 0; }
		return (int) ( self::TIER_QUOTA[ self::tier( self::points_balance( $uid ) ) ] ?? 3 );
	}

	/** Quester reward economics — a simple, Kaggle-style podium prize.
	 *  A course's reward pool = QUESTER_SHARE (80%) of its revenue. The pool goes to the top three
	 *  questers (most votes), split 50/30/20 — gold/silver/bronze. Prizes pay only once the course
	 *  has ≥ REWARD_MIN_ENROL (20) learners and the winner holds the certificate. See
	 *  settle_course_rewards(). */
	const QUESTER_SHARE    = 0.80;
	const REWARD_MIN_ENROL = 20;
	const PODIUM           = [ 0.50, 0.30, 0.20 ]; // gold, silver, bronze share of the pool
	// The course entry fee is its NUMBER OF VIDEOS (1 coin per video) — see Funds::course_cost.
	// Enrolling charges that fee, which becomes the course's `revenue` and so funds the 80% podium
	// pool: the best questers win it back and more (a lottery-style competition). Bursaries (Funds)
	// cover the fee for those in a funded group, so no learner is priced out.

	/** Creation standing scales with the coins a work costs: publishing through any studio earns
	 *  POINTS_PER_COIN × its ArtaCoin price on the 'content' track (min one coin's worth), so a
	 *  200-page book counts for 100× a flat-priced illustration. One rule for the whole family. */
	const POINTS_PER_COIN = 10;

	// ── writers (used by Learn, Funds, Social) ──────────────────────────────
	/** Points for a published creation, proportional to the coins it cost (idempotent by ref —
	 *  the same ref every studio also uses for its coin charge, so points can never double-award). */
	public static function content_points( $uid, $coins, $ref ) {
		self::award_points( (int) $uid, max( 1, (int) $coins ) * self::POINTS_PER_COIN, 'content', $ref );
	}

	/** Award lifetime points. Idempotent per (user, track, ref) when a ref is given: every caller
	 *  uses a ref that is unique per real event (q<lesson>, qv<question>_<voter>, fund<id>, bug<id>),
	 *  so a retried/replayed action — e.g. un-voting then re-voting a question — never double-awards. */
	public static function award_points( $uid, $delta, $track = 'learn', $ref = '' ) {
		if ( ! $uid || ! $delta ) { return; }
		if ( $ref !== '' && Data::col(
			'SELECT 1 FROM ' . Data::t( 'aq_points_ledger' ) . ' WHERE user_id = %d AND track = %s AND ref = %s LIMIT 1',
			[ (int) $uid, $track, $ref ]
		) ) { return; }
		$before = self::points_balance( (int) $uid );   // grand total BEFORE this award (for the slot-unlock nudge)
		$id = Data::insert( 'aq_points_ledger', [
			'user_id' => $uid, 'delta' => (int) $delta, 'track' => $track, 'ref' => $ref, 'created' => Data::now(),
		] );
		// Projections move ONLY when the ledger row landed (same failed-INSERT desync as credit_coins).
		if ( ! $id ) {
			error_log( "AQ award_points: ledger INSERT FAILED u{$uid} {$delta} '{$track}' ref={$ref} — no points moved" );
			return;
		}
		// Keep the standing projection (per-track + the 'all' grand total) in lockstep with the ledger,
		// so the leaderboard + per-user standing read a top-N index instead of GROUP-BYing the ledger.
		self::standing_add( (int) $uid, $track, (int) $delta );
		self::standing_add( (int) $uid, 'all', (int) $delta );
		// Tagging rights scale 1-to-1 with standing (Extra::tag_allowance): earning points unlocks new
		// group-tag slots. Nudge the member to use one — but the 'welcome' grant is a starting allowance,
		// not effort, so it never nudges (and the backfill on deploy stays silent).
		if ( 'welcome' !== $track ) { Extra::nudge_tag_slot( (int) $uid, $before, $before + (int) $delta ); }
	}

	public static function credit_coins( $uid, $delta, $reason = '', $ref = '' ) {
		if ( ! $uid || ! $delta ) { return; }
		$id = Data::insert( 'aq_coin_ledger', [
			'user_id' => $uid, 'delta' => (int) $delta, 'reason' => $reason, 'ref' => $ref, 'created' => Data::now(),
		] );
		// The counter must move ONLY when the ledger row actually landed. A failed insert (deadlock,
		// disconnect) that still bumped the counter permanently desynced coins_issued from Σ ledger —
		// observed on prod 2026-07-10 as an off-by-one with a matching auto-increment gap. The ledger
		// row is the money; a write that failed simply didn't happen.
		if ( ! $id ) {
			error_log( "AQ credit_coins: ledger INSERT FAILED u{$uid} {$delta} '{$reason}' ref={$ref} — no coins moved" );
			return;
		}
		// Keep the circulating-supply counter in lockstep so reserve()/Funds read one row, not Σ ledger.
		self::counter_add( 'coins_issued', (int) $delta );
		// OVERDRAFT CANARY — a catch-all behind every spend path. Each debit site checks affordability
		// before writing, so a negative balance can only mean concurrent debits raced past their checks
		// (or a check was bypassed): coins were spent that the member never had. One indexed SUM per
		// DEBIT only; credits (the hot path: mints, prizes, refunds) skip it.
		if ( $delta < 0 && ( $bal = self::coin_balance( $uid ) ) < 0 ) {
			Watchdog::alert( 'overdraft_u' . (int) $uid, 'Wallet OVERDRAWN — a debit exceeded the balance',
				'User #' . (int) $uid . " balance went NEGATIVE ({$bal} ₳) after a '{$reason}' debit of "
				. (int) $delta . " (ref {$ref}).\nEvery spend path checks affordability first, so this means concurrent "
				. 'debits raced past their checks or a check was bypassed. The ledger is append-only — audit the refs and '
				. 'reconcile with a compensating entry; if it repeats, suspect deliberate race abuse.', true );
		}
	}

	/**
	 * ATOMIC named lock. The transient get→set pattern used before has a read-then-write race: two
	 * concurrent requests can BOTH read "no lock" before either writes, and both enter the critical
	 * section — for money paths (cash-out, enrol) that is a double-spend window. This claims by
	 * INSERTing an option row: option_name is UNIQUE, so the database lets exactly ONE claimant in.
	 * Self-healing: a holder that crashed leaves its row, so a claim older than $ttl seconds may be
	 * stolen — atomically, via a compare-and-swap UPDATE on the old timestamp. Release in `finally`.
	 */
	public static function acquire_lock( $name, $ttl = 30 ) {
		global $wpdb;
		$key  = 'aq_lock_' . $name;
		$prev = $wpdb->suppress_errors( true );
		$won  = (bool) $wpdb->query( $wpdb->prepare(
			"INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')",
			$key, (string) time() ) );
		$wpdb->suppress_errors( $prev );
		if ( $won ) { return true; }
		$at = (int) $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $key ) );
		if ( $at > 0 && time() - $at > (int) $ttl ) {
			// Stale claim (crashed holder). Steal it with a CAS: only the caller whose UPDATE matches the
			// old timestamp wins; concurrent stealers see 0 rows affected.
			return 1 === (int) $wpdb->query( $wpdb->prepare(
				"UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s AND option_value = %s",
				(string) time(), $key, (string) $at ) );
		}
		return false;
	}

	public static function release_lock( $name ) {
		global $wpdb;
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name = %s", 'aq_lock_' . $name ) );
	}

	// ── Materialized projections of the ledgers (read accelerators; see Schema aq_standing/aq_counters) ──

	/** Atomically add to a (track, user) standing row, creating it on first touch. The increment is a
	 *  SINGLE atomic UPDATE (no PHP read-modify-write), so concurrent appends never lose an update. */
	private static function standing_add( $uid, $track, $by ) {
		global $wpdb;
		$uid = (int) $uid;
		if ( ! $uid ) { return; }
		$t = Data::t( 'aq_standing' );
		if ( ! Data::col( "SELECT 1 FROM $t WHERE track = %s AND user_id = %d", [ $track, $uid ] ) ) {
			$prev = $wpdb->suppress_errors( true );
			$wpdb->insert( $t, [ 'track' => $track, 'user_id' => $uid, 'points' => 0, 'updated' => Data::now() ] ); // racy first-insert is harmless (both seed 0)
			$wpdb->suppress_errors( $prev );
		}
		$wpdb->query( $wpdb->prepare( "UPDATE $t SET points = points + %d, updated = %d WHERE track = %s AND user_id = %d", (int) $by, Data::now(), $track, $uid ) );
	}

	/** Atomically add to a global counter, creating it on first touch (same atomic-UPDATE discipline).
	 *  Public: Funds maintains its 'fund_<bucket>' projection counters through this same primitive. */
	public static function counter_add( $name, $by ) {
		global $wpdb;
		$t = Data::t( 'aq_counters' );
		if ( ! Data::col( "SELECT 1 FROM $t WHERE name = %s", [ $name ] ) ) {
			$prev = $wpdb->suppress_errors( true );
			$wpdb->insert( $t, [ 'name' => $name, 'value' => 0, 'updated' => Data::now() ] );
			$wpdb->suppress_errors( $prev );
		}
		$wpdb->query( $wpdb->prepare( "UPDATE $t SET value = value + %d, updated = %d WHERE name = %s", (int) $by, Data::now(), $name ) );
	}

	/** Read a global counter (0 if unset). */
	public static function counter( $name ) {
		return (int) Data::col( 'SELECT value FROM ' . Data::t( 'aq_counters' ) . ' WHERE name = %s', [ (string) $name ] );
	}

	/** Set a global counter to an exact value (used by rebuild/reconcile, not the hot path). */
	private static function set_counter( $name, $val ) {
		global $wpdb;
		$t = Data::t( 'aq_counters' );
		$wpdb->query( $wpdb->prepare( "DELETE FROM $t WHERE name = %s", $name ) );
		$wpdb->insert( $t, [ 'name' => $name, 'value' => (int) $val, 'updated' => Data::now() ] );
	}

	/**
	 * Recompute the materialized projections from the authoritative ledgers (full rebuild). Safe to run
	 * any time — after a bulk import, a reconcile cron, or a suspected drift. O(ledger) once, not per
	 * read. The ledgers are never touched; only the derived tables are replaced.
	 */
	public static function rebuild_projections() {
		global $wpdb;
		$s   = Data::t( 'aq_standing' );
		$pl  = Data::t( 'aq_points_ledger' );
		$cl  = Data::t( 'aq_coin_ledger' );
		$now = Data::now();
		$wpdb->query( "DELETE FROM $s" );
		$wpdb->query( "INSERT INTO $s (track, user_id, points, updated) SELECT track, user_id, SUM(delta), $now FROM $pl GROUP BY track, user_id" );
		$wpdb->query( "INSERT INTO $s (track, user_id, points, updated) SELECT 'all', user_id, SUM(delta), $now FROM $pl GROUP BY user_id" );
		self::set_counter( 'coins_issued', (int) Data::col( "SELECT COALESCE(SUM(delta),0) FROM $cl" ) );
		Funds::rebuild_fund_counters(); // the fund-bucket counters are the same class of projection
	}

	/**
	 * Prove each projection equals the ledger it summarizes. Returns rows of
	 * [ check, projected, ledger, ok ]; all ok ⇒ the accelerators are EXACTLY consistent with the
	 * source of truth. Used by tools/verify-projections.php in the dev cycle and available as a
	 * cheap self-audit (the per-track + grand totals, not per-user, so it stays O(tracks)+2 scans).
	 */
	public static function verify_projections() {
		$cl = Data::t( 'aq_coin_ledger' ); $pl = Data::t( 'aq_points_ledger' ); $s = Data::t( 'aq_standing' );
		$checks = [];
		$checks[] = [ 'check' => 'coins_issued', 'projected' => self::counter( 'coins_issued' ),
			'ledger' => (int) Data::col( "SELECT COALESCE(SUM(delta),0) FROM $cl" ) ];
		$checks[] = [ 'check' => 'points_total',
			'projected' => (int) Data::col( "SELECT COALESCE(SUM(points),0) FROM $s WHERE track = 'all'" ),
			'ledger'    => (int) Data::col( "SELECT COALESCE(SUM(delta),0) FROM $pl" ) ];
		$proj_tr = []; foreach ( Data::all( "SELECT track, SUM(points) p FROM $s WHERE track <> 'all' GROUP BY track" ) as $r ) { $proj_tr[ $r['track'] ] = (int) $r['p']; }
		$ledg_tr = []; foreach ( Data::all( "SELECT track, SUM(delta) p FROM $pl GROUP BY track" ) as $r ) { $ledg_tr[ $r['track'] ] = (int) $r['p']; }
		foreach ( array_unique( array_merge( array_keys( $proj_tr ), array_keys( $ledg_tr ) ) ) as $tr ) {
			$checks[] = [ 'check' => "track:$tr", 'projected' => ( $proj_tr[ $tr ] ?? 0 ), 'ledger' => ( $ledg_tr[ $tr ] ?? 0 ) ];
		}
		foreach ( $checks as &$c ) { $c['ok'] = ( (int) $c['projected'] === (int) $c['ledger'] ); }
		unset( $c );
		return array_merge( $checks, Funds::verify_fund_counters() ); // fund counters: same proof, same tool
	}

	/**
	 * Prove the FULL-RESERVE invariant: the gold backing (aq_coin_backing_mg) is at least the coins in
	 * circulation (SUM of every coin-ledger delta). Returns [ issued, backing, ratio, ok ]; ok=false means
	 * coins exist that no gold backs (a solvency break). Cheap self-audit — two scalar reads. Used by
	 * tools/verify-projections.php and surfaced by reserve() so any drift is visible, not masked.
	 */
	public static function verify_reserve() {
		$issued  = (int) Data::col( 'SELECT COALESCE(SUM(delta),0) FROM ' . Data::t( 'aq_coin_ledger' ) );
		$backing = self::backing_mg();
		return [ 'issued' => $issued, 'backing' => $backing, 'ratio' => $issued > 0 ? round( $backing / $issued, 4 ) : 1.0, 'ok' => $backing >= $issued ];
	}

	/** Gold backing in mg — the full-reserve numerator. Stored as an ATOMIC counter (aq_counters
	 *  'backing_mg') so concurrent buys / sells / bursary grants never lose an update the way the old
	 *  aq_coin_backing_mg OPTION's read-modify-write (get_option → +n → update_option) did. Seeded once at
	 *  migration (Schema) from the legacy option, or from the coins in circulation on a genesis install. */
	public static function backing_mg() {
		return self::counter( 'backing_mg' );
	}

	/**
	 * Grow the gold reserve by $mg (1 ₳ = 1 mg gold) for value that enters as gold-equivalent OUTSIDE a
	 * coin BUY — specifically a bursary fee paid from the CAD donation fund. A paid enrol leaves its whole
	 * fee's worth of gold sitting in reserve (the coins are burned), which covers the ≤80% the pool re-mints;
	 * a bursary credits the same revenue with no coin burn, so its donated CAD must buy the matching gold or
	 * the minted prize coins would be unbacked. Keeps backing ≥ coins_issued through settlement.
	 */
	public static function add_backing( $mg ) {
		$mg = (int) $mg;
		if ( $mg <= 0 ) { return; }
		self::counter_add( 'backing_mg', $mg );
	}

	/** Charge a learner's entry fee for a course and credit it to the course's `revenue` (which funds
	 *  the podium pool). Idempotent per learner+course via the ledger ref, so a replayed enrol never
	 *  double-charges. Returns true once the charge is on record. */
	public static function charge_enrollment( $uid, $cid, $cost ) {
		if ( ! $uid || ! $cid || $cost <= 0 ) { return true; }
		$ref = 'enroll:c' . (int) $cid . ':u' . (int) $uid;
		if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'enroll' AND ref = %s LIMIT 1", [ $ref ] ) ) { return true; }
		self::credit_coins( $uid, -$cost, 'enroll', $ref );
		Data::bump( 'aq_courses', [ 'id' => $cid ], 'revenue', $cost );
		return true;
	}

	// ── Quester rewards (80% of course revenue, podium prize, per competition SEASON) ─────
	// Prizes are scoped to a competition season (Season::current). The coin-ledger ref carries the
	// season KEY — `c<course>:s<seasonKey>:u<user>` — so each season settles independently and a
	// past season's payout is never clawed back when a new season opens with a fresh leaderboard.

	/** Coins already paid to a quester for a course in a given season (idempotency anchor). */
	public static function quester_reward_earned( $cid, $uid, $season = null ) {
		$season = $season ?? Season::current()['key'];
		return (int) Data::col(
			'SELECT COALESCE(SUM(delta),0) FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'qreward' AND ref = %s",
			[ 'c' . (int) $cid . ':s' . (int) $season . ':u' . (int) $uid ]
		);
	}

	/** Coins already paid to a course's CREATOR for a season (idempotency anchor for the revenue share —
	 *  one ref per course+season, so re-settling is a no-op signed-delta like the podium). */
	public static function creator_reward_earned( $cid, $season = null ) {
		$season = $season ?? Season::current()['key'];
		return (int) Data::col(
			'SELECT COALESCE(SUM(delta),0) FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'crev' AND ref = %s",
			[ 'c' . (int) $cid . ':s' . (int) $season . ':creator' ]
		);
	}

	/** Total quester reward coins distributed for a course in a season (never exceeds the pool). */
	public static function rewards_distributed( $cid, $season = null ) {
		global $wpdb;
		$season = $season ?? Season::current()['key'];
		$like   = $wpdb->esc_like( 'c' . (int) $cid . ':s' . (int) $season . ':' ) . '%';
		return (int) Data::col(
			'SELECT COALESCE(SUM(delta),0) FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'qreward' AND ref LIKE %s",
			[ $like ]
		);
	}

	/** The reward pool for a course: 80% of its revenue (0 until the course earns revenue). */
	public static function reward_pool( $revenue ) {
		return (int) floor( (int) $revenue * self::QUESTER_SHARE );
	}

	/**
	 * The course leaderboard with each quester's PODIUM PRIZE, counting votes in the season window
	 * [$start, $end) (pass 0/0 for all-time). Questers are ranked by votes (tie-break: more
	 * comments, then earlier), and the pool splits 50/30/20 across the top three. Returns rows of
	 * [ user_id, votes, questions, rank, prize ] (the `questions` value is the comment count — the
	 * key name is kept for API-shape stability). Pure read — shared by the rankings endpoint and
	 * settlement so the two can never disagree on who wins what.
	 *
	 * ARTAMOD: comments flagged as trading in hate or fear (aq_comments.flagged = 1, set on post
	 * by Fearometer::score) are EXCLUDED here — their upvotes never count toward the competition and
	 * the flagged comment isn't tallied. The leaderboard rewards thinking, never fear.
	 */
	const PODIUM_BOARD = 100; // top-N the live board returns (medals are top-3; this bounds the read)

	public static function podium( $cid, $pool, $start = 0, $end = 0 ) {
		$bot = (int) get_option( 'aq_artabot_uid', 0 );
		// Windowed (per-season) board → read the maintained per-season quester standing as a top-N walk
		// of the (season_key, course_id, votes) index. season_key == the window end (every caller passes
		// the season's end; see Season). The all-time path (end = 0; no live caller) falls back to the
		// canonical aggregate over the comment/vote tables.
		if ( $end > 0 ) {
			$rows = Data::all(
				'SELECT user_id, votes, comments AS questions FROM ' . Data::t( 'aq_quester' ) .
				' WHERE season_key = %d AND course_id = %d AND user_id <> %d AND ( votes <> 0 OR comments <> 0 )' .
				// All three sort keys DESC so the (season_key, course_id, votes, comments) index — with the
				// PK (…, user_id) InnoDB appends — is a single REVERSE walk + LIMIT (no filesort over a
				// viral course's whole quester set). A mixed direction (… user_id ASC) would force a temp
				// b-tree; the user_id direction is only a deterministic final tiebreak (bench.sh: podium).
				' ORDER BY votes DESC, comments DESC, user_id DESC LIMIT %d',
				[ (int) $end, (int) $cid, $bot, self::PODIUM_BOARD ]
			);
		} else {
			$rows = self::podium_ledger( $cid, $start, $end, $bot );
		}
		$rows = self::ring_adjust( $cid, $rows, $start, $end );
		$out = [];
		foreach ( $rows as $i => $r ) {
			$out[] = [
				'user_id'   => (int) $r['user_id'],
				'votes'     => (int) $r['votes'],
				'questions' => (int) $r['questions'], // comments authored THIS season (kept key name for the API shape)
				'rank'      => $i + 1,
				'prize'     => $i < count( self::PODIUM ) && $pool > 0 ? (int) floor( $pool * self::PODIUM[ $i ] ) : 0,
			];
		}
		return $out;
	}

	/** Mutual upvotes each way (within the window) at/over this between two board members = a vote
	 *  ring — both directions of the pair's votes are excluded from the ranking. Objective and
	 *  automatic, like ArtaMod: nothing is deleted, the ring simply doesn't count. */
	const RING_MIN = 3;

	/**
	 * VOTE-RING EXCLUSION (2026-06-12): collusion-proof the podium. Among the board's members, find
	 * reciprocal pairs — A upvoted B's section comments ≥ RING_MIN times AND B upvoted A's ≥ RING_MIN
	 * times inside the season window — and subtract those mutual votes from both totals, then
	 * re-rank. Bounded: only board candidates are cross-checked (a ring outside the board can't touch
	 * a prize). Honest mutual appreciation (1-2 votes each way) is untouched; sustained
	 * you-vote-me-I-vote-you farming is neutralised.
	 */
	private static function ring_adjust( $cid, $rows, $start = 0, $end = 0 ) {
		if ( count( $rows ) < 2 ) { return $rows; }
		$ids = array_map( 'intval', array_column( $rows, 'user_id' ) );
		$ph  = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
		$win = $end > 0 ? ' AND v.created >= %d AND v.created < %d' : '';
		$args = array_merge( [ (int) $cid ], $ids, $ids, $end > 0 ? [ (int) $start, (int) $end ] : [] );
		$pairs = Data::all(
			'SELECT v.user_id voter, c.author_id author, SUM(v.val) n
			   FROM ' . Data::t( 'aq_votes' ) . ' v
			   JOIN ' . Data::t( 'aq_comments' ) . " c ON c.id = v.target_id
			  WHERE v.target_type = 'comment' AND c.context_type = 'section' AND c.course_id = %d
			    AND c.flagged = 0 AND v.user_id IN ($ph) AND c.author_id IN ($ph)$win
			  GROUP BY v.user_id, c.author_id",
			$args );
		$m = [];
		foreach ( $pairs as $p ) { $m[ (int) $p['voter'] ][ (int) $p['author'] ] = (int) $p['n']; }
		$cut = []; // user_id => votes to subtract
		foreach ( $ids as $a ) {
			foreach ( $ids as $b ) {
				if ( $a >= $b ) { continue; }
				$ab = $m[ $a ][ $b ] ?? 0; $ba = $m[ $b ][ $a ] ?? 0;
				if ( $ab >= self::RING_MIN && $ba >= self::RING_MIN ) {
					$cut[ $b ] = ( $cut[ $b ] ?? 0 ) + $ab; // B loses the votes A gave them
					$cut[ $a ] = ( $cut[ $a ] ?? 0 ) + $ba; // A loses the votes B gave them
				}
			}
		}
		if ( ! $cut ) { return $rows; }
		foreach ( $rows as &$r ) {
			$u = (int) $r['user_id'];
			if ( isset( $cut[ $u ] ) ) { $r['votes'] = max( 0, (int) $r['votes'] - $cut[ $u ] ); }
		}
		unset( $r );
		usort( $rows, fn( $x, $y ) => [ (int) $y['votes'], (int) $y['questions'], (int) $y['user_id'] ] <=> [ (int) $x['votes'], (int) $x['questions'], (int) $x['user_id'] ] );
		return $rows;
	}

	/**
	 * The canonical leaderboard computation directly over the comment/vote tables — ranks questers by
	 * the net UPVOTES their non-flagged section comments earned from votes cast in [$start,$end) (0/0 =
	 * all-time), tie-broken by comments posted in that window then author id. This is the SOURCE OF
	 * TRUTH the aq_quester projection mirrors: used for the all-time fallback, the projection rebuild,
	 * and verify_quester (projection == this). It GROUP-BYs every section comment of the course, so it
	 * is O(course) — never call it on the hot path; podium() uses the projection for live reads.
	 */
	public static function podium_ledger( $cid, $start = 0, $end = 0, $bot = null ) {
		$bot  = $bot === null ? (int) get_option( 'aq_artabot_uid', 0 ) : (int) $bot;
		// `questions` is windowed to the season too (a comment counts for the season it was posted in),
		// so the projection — which buckets by season — mirrors this exactly. Placeholders are bound in
		// SQL TEXT order: the questions CASE (SELECT) comes BEFORE the vote-window (JOIN).
		$cwin = $end > 0 ? ' AND c.created >= %d AND c.created < %d' : '';
		$win  = $end > 0 ? ' AND v.created >= %d AND v.created < %d' : '';
		$args = [];
		if ( $end > 0 ) { $args[] = (int) $start; $args[] = (int) $end; } // questions CASE window (appears first)
		if ( $end > 0 ) { $args[] = (int) $start; $args[] = (int) $end; } // JOIN vote window (appears second)
		$args[] = (int) $cid; $args[] = $bot;
		$rows = Data::all(
			'SELECT c.author_id user_id, COALESCE(SUM(v.val),0) votes,
			        COUNT(DISTINCT CASE WHEN 1=1' . $cwin . ' THEN c.id END) questions
			   FROM ' . Data::t( 'aq_comments' ) . ' c
			   LEFT JOIN ' . Data::t( 'aq_votes' ) . " v ON v.target_type = 'comment' AND v.target_id = c.id$win
			  WHERE c.context_type = 'section' AND c.course_id = %d AND c.flagged = 0 AND c.author_id <> %d
			  GROUP BY c.author_id
			  ORDER BY votes DESC, questions DESC, c.author_id DESC", // matches podium()'s reverse-walk order so verify_quester compares like-for-like
			$args
		);
		// Drop questers with neither a vote nor a comment this season (mirrors the projection, which only
		// holds non-zero buckets). Filtered in PHP to avoid HAVING-on-alias quirks across engines.
		return array_values( array_filter( $rows, fn( $r ) => (int) $r['votes'] !== 0 || (int) $r['questions'] !== 0 ) );
	}

	/**
	 * Recompute ONE quester's CURRENT-season bucket for a course, from the comment/vote tables, scoped
	 * to that one author (bounded by their footprint, not the course). Called on each comment-post +
	 * vote affecting the author, so podium() can read a maintained top-N instead of aggregating. Exact
	 * by construction: it stores precisely what podium_ledger would compute for this author this season.
	 */
	public static function quester_touch( $cid, $uid ) {
		global $wpdb;
		$cid = (int) $cid; $uid = (int) $uid;
		if ( ! $cid || ! $uid || $uid === (int) get_option( 'aq_artabot_uid', 0 ) ) { return; }
		$s   = Season::current();
		$key = (int) $s['key']; $st = (int) $s['start']; $en = (int) $s['end'];
		$C   = Data::t( 'aq_comments' ); $V = Data::t( 'aq_votes' ); $Q = Data::t( 'aq_quester' );
		$votes = (int) Data::col(
			"SELECT COALESCE(SUM(v.val),0) FROM $C c JOIN $V v
			   ON v.target_type='comment' AND v.target_id=c.id AND v.created >= %d AND v.created < %d
			  WHERE c.context_type='section' AND c.course_id=%d AND c.author_id=%d AND c.flagged=0",
			[ $st, $en, $cid, $uid ]
		);
		$comments = (int) Data::col(
			"SELECT COUNT(*) FROM $C WHERE context_type='section' AND course_id=%d AND author_id=%d AND flagged=0 AND created >= %d AND created < %d",
			[ $cid, $uid, $st, $en ]
		);
		if ( $votes === 0 && $comments === 0 ) {
			$wpdb->query( $wpdb->prepare( "DELETE FROM $Q WHERE season_key=%d AND course_id=%d AND user_id=%d", $key, $cid, $uid ) );
			return;
		}
		Data::upsert( 'aq_quester', [ 'season_key' => $key, 'course_id' => $cid, 'user_id' => $uid ],
			[ 'votes' => $votes, 'comments' => $comments, 'updated' => Data::now() ] );
	}

	/** Rebuild the CURRENT-season quester buckets for every course from the comment/vote tables, by
	 *  re-running the SAME scoped recompute the runtime uses (quester_touch) for each (course, author)
	 *  with a non-flagged section comment — so the backfill is consistent with live maintenance by
	 *  construction. Past seasons are served from the frozen aq_season_results, so only the live season
	 *  needs buckets. Safe to run any time (backfill / reconcile). */
	public static function rebuild_quester() {
		global $wpdb;
		$key = (int) Season::current()['key'];
		$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . Data::t( 'aq_quester' ) . ' WHERE season_key = %d', $key ) );
		$pairs = Data::all( 'SELECT DISTINCT course_id, author_id FROM ' . Data::t( 'aq_comments' ) . " WHERE context_type='section' AND course_id > 0 AND flagged = 0" );
		foreach ( $pairs as $p ) { self::quester_touch( (int) $p['course_id'], (int) $p['author_id'] ); }
	}

	/**
	 * Prove the quester projection equals the canonical aggregate for the CURRENT season, per course,
	 * on the prize-relevant ranking (top PODIUM_BOARD by votes). Returns rows of
	 * [ course_id, ok, note ]; any not-ok means the buckets drifted from the comment/vote tables.
	 */
	public static function verify_quester() {
		$cur = Season::current();
		$cids = Data::all( 'SELECT DISTINCT course_id FROM ' . Data::t( 'aq_comments' ) . " WHERE context_type='section' AND course_id > 0" );
		$out = [];
		foreach ( $cids as $r ) {
			$cid  = (int) $r['course_id'];
			$proj = self::podium( $cid, 0, $cur['start'], $cur['end'] );
			$ref  = self::podium_ledger( $cid, $cur['start'], $cur['end'] );
			$ref  = array_slice( $ref, 0, self::PODIUM_BOARD );
			$ok = ( count( $proj ) === count( $ref ) );
			$note = '';
			if ( $ok ) {
				foreach ( $ref as $i => $rr ) {
					if ( (int) $proj[ $i ]['user_id'] !== (int) $rr['user_id'] || (int) $proj[ $i ]['votes'] !== (int) $rr['votes'] ) {
						$ok = false; $note = "row $i: proj u{$proj[$i]['user_id']}/{$proj[$i]['votes']}v vs ref u{$rr['user_id']}/{$rr['votes']}v"; break;
					}
				}
			} else {
				$note = 'count ' . count( $proj ) . ' vs ' . count( $ref );
			}
			$out[] = [ 'course_id' => $cid, 'ok' => $ok, 'note' => $note ];
		}
		return $out;
	}

	/** Users who hold a (signed-net non-zero) quester prize for a course in a season, uid => net coins.
	 *  Drawn from the append-only ledger by the per-season ref, so settlement can claw back a prize from
	 *  anyone who has fallen off the podium without scanning every author. */
	private static function season_reward_users( $cid, $key ) {
		global $wpdb;
		$like = $wpdb->esc_like( 'c' . (int) $cid . ':s' . (int) $key . ':u' ) . '%';
		$rows = Data::all( 'SELECT ref, SUM(delta) net FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason='qreward' AND ref LIKE %s GROUP BY ref HAVING SUM(delta) <> 0", [ $like ] );
		$uids = [];
		foreach ( $rows as $r ) { if ( preg_match( '/:u(\d+)$/', (string) $r['ref'], $m ) ) { $uids[ (int) $m[1] ] = (int) $r['net']; } }
		return $uids;
	}

	/**
	 * A single quester's podium standing in a course THIS SEASON — for the certificate + its public
	 * verification. medal is 'gold'|'silver'|'bronze' only for a top-three quester in an ELIGIBLE
	 * course (≥ REWARD_MIN_ENROL enrolled), '' otherwise. Rank 0 = no comments this season.
	 */
	public static function user_medal( $cid, $uid ) {
		$cid = (int) $cid;
		$uid = (int) $uid;
		$c        = Data::one( 'SELECT enroll_count, revenue FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		$eligible = $c && (int) $c['enroll_count'] >= self::REWARD_MIN_ENROL;
		$pool     = $c ? self::reward_pool( $c['revenue'] ) : 0;
		$season   = Season::current();
		$names    = [ 1 => 'gold', 2 => 'silver', 3 => 'bronze' ];
		foreach ( self::podium( $cid, $pool, $season['start'], $season['end'] ) as $row ) {
			if ( (int) $row['user_id'] !== $uid ) { continue; }
			$rank = (int) $row['rank'];
			return [
				'rank'      => $rank,
				'medal'     => ( $eligible && $rank <= 3 ) ? $names[ $rank ] : '',
				'votes'     => (int) $row['votes'],
				'questions' => (int) $row['questions'],
				'prize'     => $eligible ? (int) $row['prize'] : 0,
				'reward'    => self::quester_reward_earned( $cid, $uid, $season['key'] ),
				'eligible'  => $eligible,
			];
		}
		// Beyond the bounded board (rank > PODIUM_BOARD): still surface the quester's own tally from
		// their bucket — they hold no medal/prize (those are top-3 only), so an exact rank isn't needed.
		$b = Data::one( 'SELECT votes, comments FROM ' . Data::t( 'aq_quester' ) . ' WHERE season_key = %d AND course_id = %d AND user_id = %d', [ (int) $season['key'], $cid, $uid ] );
		return [ 'rank' => 0, 'medal' => '', 'votes' => (int) ( $b['votes'] ?? 0 ), 'questions' => (int) ( $b['comments'] ?? 0 ),
			'prize' => 0, 'reward' => self::quester_reward_earned( $cid, $uid, $season['key'] ), 'eligible' => $eligible ];
	}

	/** Settle the CURRENT season's prizes for a course (called on enrol/complete/vote). */
	public static function settle_course_rewards( $cid ) {
		$cid = (int) $cid;
		$c   = Data::one( 'SELECT enroll_count, revenue FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		if ( ! $c ) { return; }
		$s = Season::current();
		self::settle_window( $cid, $s['start'], $s['end'], $s['key'], (int) $c['enroll_count'], (int) $c['revenue'] );
	}

	/**
	 * Settle a course's podium prizes for ONE season window. Idempotent + safe to call repeatedly:
	 *
	 *   pool   = floor(course.revenue × 80%)
	 *   gate   = course has ≥ 20 learners enrolled
	 *   winner = a top-3 quester (by votes in this window) who ALSO holds the certificate; 50/30/20%
	 *
	 * A CONSISTENT REBALANCE, not a one-way drip: each pass recomputes the season's podium and
	 * credits the SIGNED difference vs what each quester already holds FOR THIS SEASON. A delta may
	 * be negative — a provisional prize re-settles downward when someone is overtaken or hasn't yet
	 * certified (an uncertified medalist's prize is held at 0 until they finish). The three shares
	 * sum to ≤ pool and each user's net is exactly their current prize, so the season total never
	 * exceeds the pool and no balance goes negative. Timing-independent within the season.
	 */
	public static function settle_window( $cid, $start, $end, $key, $enroll_count, $revenue ) {
		$cid = (int) $cid;
		if ( (int) $enroll_count < self::REWARD_MIN_ENROL ) { return; }
		$pool = self::reward_pool( $revenue );
		if ( $pool <= 0 ) { return; }

		// Only the top three can hold a prize, so settle exactly those (each: target = their prize if
		// certified, else 0 — uncertified medalists held at 0). Then claw back any quester who held a
		// prize earlier this season but is no longer top-3 (target → 0), found via the ledger so we never
		// scan every author. The credit is the SIGNED delta vs what they already hold this season, so the
		// season total stays ≤ pool, no balance goes negative, and re-running is a no-op (idempotent ref).
		// Certification is checked per podium user with a PK lookup — never by loading every certified
		// learner of the course (a viral course's certified set is unbounded; the podium is 3 rows).
		$seen = [];
		$top  = array_slice( self::podium( $cid, $pool, $start, $end ), 0, count( self::PODIUM ) );
		foreach ( $top as $row ) {
			$uid          = (int) $row['user_id'];
			$seen[ $uid ] = true;
			$pct          = (int) Data::col( 'SELECT pct FROM ' . Data::t( 'aq_enroll' ) . ' WHERE user_id = %d AND course_id = %d', [ $uid, $cid ] );
			$target       = $pct >= Learn::PASS_PCT ? (int) $row['prize'] : 0;
			$delta        = $target - (int) self::quester_reward_earned( $cid, $uid, $key );
			if ( $delta !== 0 ) {
				self::credit_coins( $uid, $delta, 'qreward', 'c' . $cid . ':s' . (int) $key . ':u' . $uid );
			}
		}
		foreach ( self::season_reward_users( $cid, $key ) as $uid => $net ) {
			if ( isset( $seen[ $uid ] ) || $net === 0 ) { continue; } // still on the podium, or nothing held
			self::credit_coins( $uid, -$net, 'qreward', 'c' . $cid . ':s' . (int) $key . ':u' . $uid ); // target 0 → claw back
		}

		// CREATOR + FOUNDATION share of the NON-POOL remainder (operator 2026-06-20). After the questers'
		// 80% pool, the rest of the season's revenue goes to the course CREATOR, tier-scaled: the creator
		// keeps creator_share() of it (Creator 50% → Legend 100%) and the foundation keeps the remainder
		// (Legend → 0 — "Aquest takes nothing"). The foundation's cut is simply LEFT UNMINTED — its gold
		// stays in reserve, surfaced as the backing_ratio > 1 on /foundation/finances. Same per-season
		// signed-delta idempotency as the podium (one 'crev' ref per course+season), so re-running is a
		// no-op and the season total never exceeds the revenue. Minting ≤ remainder is fully backed (a paid
		// enrol burned the whole fee, leaving its gold in reserve; a bursary/sponsor added it), so
		// verify_reserve (backing ≥ issued) holds through settlement. Gated by the same ≥20-enrol + pool>0
		// checks above, so a course distributes nothing until its competition is live.
		$remainder = max( 0, (int) $revenue - $pool ); // the ≤20% not in the quester pool (exact — no rounding gap)
		if ( $remainder > 0 ) {
			$creator = (int) Data::col( 'SELECT author_id FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
			if ( $creator > 0 ) {
				$target = (int) floor( $remainder * self::creator_share( $creator ) ); // creator's coins; foundation keeps the rest (unminted)
				$delta  = $target - self::creator_reward_earned( $cid, $key );
				if ( $delta !== 0 ) { self::credit_coins( $creator, $delta, 'crev', 'c' . $cid . ':s' . (int) $key . ':creator' ); }
			}
		}
	}

	// ── balances ────────────────────────────────────────────────────────────
	public static function coin_balance( $uid ) {
		return (int) Data::col( 'SELECT COALESCE(SUM(delta),0) FROM ' . Data::t( 'aq_coin_ledger' ) . ' WHERE user_id = %d', [ $uid ] );
	}
	/** Lifetime points = standing. Points are NEVER spent (ArtaBot is paid in COINS, not points), so
	 *  this is purely additive and the rank ladder never falls. Served from the standing projection
	 *  ('all' track = the user's grand total), kept in lockstep with the ledger by award_points. */
	public static function points_balance( $uid ) {
		return (int) Data::col( 'SELECT points FROM ' . Data::t( 'aq_standing' ) . " WHERE track = 'all' AND user_id = %d", [ (int) $uid ] );
	}
	/** Lifetime points EARNED — the standing figure the profile shows. Points are purely
	 *  additive (never spent), so earned == balance; both read the same projection row. */
	public static function points_earned( $uid ) {
		return self::points_balance( $uid );
	}

	// NOTE: ArtaBot is FREE + unlimited (2026-06-10) — the whole coin-metering apparatus that lived here
	// (per-token pricing consts, free-token allowance, coin↔token rate, charge_artabot) was removed with
	// its /artabot/rate route. History: git log -- src/Economy.php.
	const SIGNUP_POINTS = 10; // one-time welcome POINTS on signup → starting group-tag slots (Extra::tag_allowance)

	/** Grant the one-time welcome allowance on signup: a small bundle of standing points so a brand-new
	 *  member starts with some typology group-tag slots — see Extra::tag_allowance (tagging rights scale
	 *  1-to-1 with lifetime points). Idempotent per user via the ledger ref (award_points dedupes). */
	public static function grant_signup_allowance( $uid ) {
		$uid = (int) $uid;
		if ( ! $uid ) { return; }
		self::award_points( $uid, self::SIGNUP_POINTS, 'welcome', 'welcome' );
	}

	/** Lifetime points split by track — the profile breakdown. Keys match the leaderboard tracks.
	 *  The contribution kinds each have their OWN track (bug→Sentinel, feature→Visionary,
	 *  content→Curator, suggestion→Sage), ranked separately; 'volunteer' is kept for history. */
	public static function points_by_track( $uid ) {
		$out = [ 'learn' => 0, 'donate' => 0, 'volunteer' => 0, 'outreach' => 0,
			'bug' => 0, 'feature' => 0, 'content' => 0, 'suggestion' => 0 ];
		if ( ! (int) $uid ) { return $out; }
		$rows = Data::all( 'SELECT track, points FROM ' . Data::t( 'aq_standing' ) . " WHERE user_id = %d AND track <> 'all'", [ (int) $uid ] );
		foreach ( $rows as $r ) { if ( isset( $out[ $r['track'] ] ) ) { $out[ $r['track'] ] = (int) $r['points']; } }
		return $out;
	}

	public static function tier( $points ) {
		$name = 'Quester';
		foreach ( self::TIERS as $t => $min ) { if ( $points >= $min ) { $name = $t; } }
		return $name;
	}

	/** A creator's share (0.0–1.0) of a course's non-pool remainder, by their CURRENT tier (lifetime
	 *  points). Quester (below the Creator rung, can't create) = 0. settle_window splits the 20% remainder
	 *  between the creator (this share) and the foundation (the rest). */
	public static function creator_share( $uid ) {
		return self::TIER_SHARE[ self::tier( self::points_balance( (int) $uid ) ) ] ?? 0.0;
	}

	/** Current tier + progress toward the next rank, from lifetime points. Drives the Home/Account
	 *  ring (the bridge previously hardcoded next=null/pct=0, so the ring was stuck at 0%). */
	public static function tier_progress( $points ) {
		$points = (int) $points;
		$names  = array_keys( self::TIERS );
		$mins   = array_values( self::TIERS );
		$i = 0;
		foreach ( $mins as $k => $min ) { if ( $points >= $min ) { $i = $k; } }
		$next = $names[ $i + 1 ] ?? null;
		if ( $next === null ) { // top rank (Legend)
			return [ 'label' => $names[ $i ], 'next' => null, 'pct' => 100, 'remaining' => 0 ];
		}
		$base = $mins[ $i ];
		$span = max( 1, $mins[ $i + 1 ] - $base );
		return [
			'label'     => $names[ $i ],
			'next'      => $next,
			'pct'       => max( 0, min( 100, (int) floor( ( ( $points - $base ) / $span ) * 100 ) ) ),
			'remaining' => max( 0, $mins[ $i + 1 ] - $points ),
		];
	}

	// ── endpoints ───────────────────────────────────────────────────────────
	/** GET /wallet — the signed-in user's coins, points, tier, recent ledger. */
	public static function wallet( $req ) {
		$uid    = Rest::uid();
		$points = self::points_balance( $uid );
		$recent = Data::all(
			'SELECT delta, reason, ref, created FROM ' . Data::t( 'aq_coin_ledger' ) . ' WHERE user_id = %d ORDER BY id DESC LIMIT 20',
			[ $uid ]
		);
		return [
			'coins'  => self::coin_balance( $uid ),
			'points' => $points,
			'tier'   => self::tier( $points ),
			'ledger' => array_map( fn( $r ) => [
				'delta' => (int) $r['delta'], 'reason' => $r['reason'], 'ref' => $r['ref'], 'at' => (int) $r['created'],
			], $recent ),
		];
	}

	/**
	 * GET /leaderboard?track= — top users by lifetime points on a track (or all).
	 * Pre-aggregated with a single grouped query; cacheable.
	 */
	public static function leaderboard( $req ) {
		$track = sanitize_key( (string) Rest::p( $req, 'track', 'all' ) );
		$key   = ( $track && $track !== 'all' ) ? $track : 'all';
		// Top-N off the standing projection: a REVERSE walk of the (track, points) index — InnoDB appends
		// the PK (track, user_id), so points DESC, user_id DESC is served by one ordered walk + LIMIT, no
		// GROUP BY and no whole-table sort. (points DESC, user_id ASC — mixed directions — would instead
		// filesort every user on the track: bench.sh leaderboard. Pre-projection this GROUP-BY'd the entire
		// points ledger: 284ms→~0 at 1M. user_id direction is just a deterministic tiebreak among equal points.)
		$rows  = Data::all(
			'SELECT user_id, points pts FROM ' . Data::t( 'aq_standing' ) . ' WHERE track = %s ORDER BY points DESC, user_id DESC LIMIT 50',
			[ $key ]
		);
		$out = [];
		foreach ( $rows as $r ) {
			$u = get_userdata( (int) $r['user_id'] );
			if ( ! $u ) { continue; } // skip points from deleted users (orphaned append-only ledger rows) — no anonymous 'Quester' entries with broken /u/ profile links; rank stays contiguous via count($out)
			$out[] = [
				'rank'   => count( $out ) + 1,
				'id'     => (int) $u->ID, // lets the home feed's "questers to follow" rail call POST /follow inline (user ids are public by design — same rows as /data/)
				'name'   => $u->display_name,
				'slug'   => $u->user_nicename,
				'points' => (int) $r['pts'],
				'tier'   => self::tier( (int) $r['pts'] ),
				// Same identity fields the profile/me endpoints expose, so the leaderboard row can show
				// a real avatar + join date instead of the bridge's hardcoded blanks (the "Joined"
				// column existed but was always empty).
				'avatar' => Verify::avatar_url( $u->ID, 96 ),
				'country' => Verify::badge_country( $u->ID ), // verified nationality → avatar flag
				'joined' => Verify::joined_label( $u->user_registered ), // clamped to the platform launch (ticket #103)
			];
		}
		return [ 'items' => $out, 'track' => $track ];
	}

	/** GET /reserve — public full-reserve proof (coins issued vs gold backing) + the live coin price.
	 *  1 ₳ = 1 mg gold, so spot = (gold $/oz ÷ mg-per-troy-oz) × USD→CAD; buy/sell apply the spread.
	 *  Sourced from the surviving aq_gold_spot_oz_usd / aq_coin_spread / aq_fx_rates options (the
	 *  wallet's buy/sell/cash-out all depend on these — without them every figure renders as 0). */
	public static function reserve( $req ) {
		$issued  = self::counter( 'coins_issued' ); // Σ all coin deltas, maintained in lockstep (was Σ over the whole ledger)
		// mg gold held in reserve — an atomic counter, seeded at migration to the genuine holdings. Reads the
		// TRUE (possibly under-collateralized) ratio, never a falsely-perfect 1.0; buy/sell + add_backing
		// maintain it in lockstep via atomic increments (was a lossy option read-modify-write).
		$backing = self::backing_mg();
		$oz_usd  = (float) get_option( 'aq_gold_spot_oz_usd', 0 );
		$spread  = (float) get_option( 'aq_coin_spread', 0.05 );
		$fx      = get_option( 'aq_fx_rates', array() );
		$cad     = ( is_array( $fx ) && ! empty( $fx['CAD'] ) ) ? (float) $fx['CAD'] : 1.0;
		$spot    = $oz_usd > 0 ? ( $oz_usd / 31103.477 ) * $cad : 0.0; // CAD per coin (1 coin = 1 mg)
		// Price-over-time series for the Reserve page chart. aq_gold_rate_history.mg_base is already the
		// CAD-per-coin spot (1 ₳ = 1 mg); we apply the SAME spread as the live buy/sell above so the chart
		// and the ticker agree. Most-recent points, reversed to oldest→newest so the SVG polyline reads
		// left-to-right. Read-only over an already-public table — no economy state is touched, and a
		// missing/empty table just yields an empty series (the chart shows its placeholder, no error).
		$rows    = Data::all( 'SELECT ts, mg_base FROM ' . Data::t( 'aq_gold_rate_history' ) . ' WHERE mg_base > 0 ORDER BY id DESC LIMIT %d', [ 120 ] );
		$history = [];
		foreach ( array_reverse( $rows ) as $row ) {
			$s = (float) $row['mg_base'];
			$history[] = [
				'ts'   => (int) $row['ts'],
				'spot' => round( $s, 4 ),
				'buy'  => round( $s * ( 1 + $spread ), 4 ),
				'sell' => round( $s * ( 1 - $spread ), 4 ),
			];
		}
		return [
			'issued_coins' => $issued,
			'backing_mg'   => $backing,
			'ratio'        => $issued > 0 ? round( $backing / $issued, 4 ) : 1.0,
			'backed'       => $backing >= $issued, // full-reserve proof: every circulating coin has ≥ 1 mg gold behind it
			'unit'         => '1 ₳ = 1 mg gold',
			'fiat'         => 'CAD',
			'spot'         => round( $spot, 4 ),
			'buy'          => round( $spot * ( 1 + $spread ), 4 ),
			'sell'         => round( $spot * ( 1 - $spread ), 4 ),
			'spread'       => $spread,
			'payments'     => Stripe::enabled(),       // FE gates the BUY form on this (no inbound rail → no free mint)
			'cashout'      => self::cashout_enabled(), // FE gates the cash-out form on this
			'gold_oz_usd'  => $oz_usd,
			'updated'      => (int) get_option( 'aq_gold_spot_ts', 0 ),
			'history'      => $history,
		];
	}

	/**
	 * Live coin price in CAD: spot = 1 mg gold. Prefers the same option sources as reserve(),
	 * falling back to the latest aq_gold_rate_history row (mg_base is already CAD per mg) so the
	 * figure is never 0. Returns [fiat, spot, buy, sell, spread].
	 */
	public static function coin_price() {
		$spread = (float) get_option( 'aq_coin_spread', 0.05 );
		$oz_usd = (float) get_option( 'aq_gold_spot_oz_usd', 0 );
		$fx     = get_option( 'aq_fx_rates', [] );
		$cad    = ( is_array( $fx ) && ! empty( $fx['CAD'] ) ) ? (float) $fx['CAD'] : 1.0;
		$spot   = $oz_usd > 0 ? ( $oz_usd / 31103.477 ) * $cad : 0.0;
		if ( $spot <= 0 ) {
			$spot = (float) Data::col( 'SELECT mg_base FROM ' . Data::t( 'aq_gold_rate_history' ) . ' ORDER BY id DESC LIMIT 1' );
		}
		if ( $spot <= 0 ) { $spot = 0.20; } // last-resort floor so buy/sell never divide by 0
		return [
			'fiat'   => 'CAD',
			'spot'   => round( $spot, 4 ),
			'buy'    => round( $spot * ( 1 + $spread ), 4 ),
			'sell'   => round( $spot * ( 1 - $spread ), 4 ),
			'spread' => $spread,
		];
	}

	/** GET /coins/price — the live buy/sell price (public). */
	public static function price( $req ) {
		return self::coin_price();
	}

	/**
	 * POST /coins/buy {amount} — buy coins with fiat (amount in CAD). Credits the wallet and
	 * bumps the gold backing so the full-reserve invariant holds (issued grows with backing).
	 * NOTE: settlement is recorded immediately; wire a real payment webhook before production
	 * to gate the credit on captured funds.
	 */
	public static function buy( $req ) {
		if ( Rest::throttle( 'coin_buy', 20, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		$cad = (float) Rest::p( $req, 'amount', 0 );
		if ( $cad < 1 ) { return Rest::err( 'bad_input', 'Minimum purchase is $1.' ); }
		$p     = self::coin_price();
		$coins = (int) floor( $cad / $p['buy'] );
		if ( $coins < 1 ) { return Rest::err( 'too_small', 'That buys less than one coin.' ); }
		// Charge ONLY for the whole coins delivered (coins are integer-mg), never the rounded-down remainder
		// — so fiat captured == coin value credited == gold backing added, and the buyer is never short-changed.
		$charge = round( $coins * $p['buy'], 2 );

		// Coins are minted ONLY against a captured fiat payment. Without Stripe configured there is no way
		// to charge, so we must REFUSE — never credit coins for free (those coins would become real money
		// once cash-out is live). The only mint path is Stripe Checkout → fulfilment on return/webhook
		// (idempotent); the full-reserve backing is bumped at fulfilment, not now.
		if ( ! Stripe::enabled() ) {
			return Rest::err( 'payments_unavailable', 'Buying coins isn’t available right now. Please try again soon.', 503 );
		}
		$return = home_url( '/wallet/' );
		$sess   = Stripe::create_session(
			(int) round( $charge * 100 ),
			$coins . ' Arta Coins top-up',
			$return . '?stripe=success&session={CHECKOUT_SESSION_ID}',
			$return . '?stripe=cancel',
			[ 'aq_kind' => 'coins', 'aq_uid' => $uid, 'aq_coins' => $coins ]
		);
		if ( ! $sess ) { return Rest::err( 'stripe_error', 'Could not start the secure payment. Please try again.', 502 ); }
		return [ 'ok' => true, 'redirect' => true, 'url' => $sess['url'], 'coins' => $coins,
			'order' => '', 'total' => $charge, 'total_display' => '$' . number_format( $charge, 2 ) . ' CAD',
			'gateway' => sanitize_key( (string) Rest::p( $req, 'gateway', 'card' ) ), 'message' => 'Redirecting to secure payment…' ];
	}

	/** Mint purchased coins + bump the full-reserve gold backing. Idempotent per ledger ref (so the
	 *  Stripe return AND webhook can both call it safely). Returns the coins credited (0 if already done). */
	public static function fulfil_coin_purchase( $uid, $coins, $ref ) {
		$uid = (int) $uid; $coins = (int) $coins;
		if ( $uid < 1 || $coins < 1 || $ref === '' ) { return 0; }
		if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'buy' AND ref = %s LIMIT 1", [ $ref ] ) ) { return 0; }
		self::credit_coins( $uid, $coins, 'buy', $ref );
		self::counter_add( 'backing_mg', $coins ); // atomic — full-reserve backing rises in lockstep with the mint
		return $coins;
	}

	/** Cash-out sends real money out via Stripe Connect transfers (see sell() / payout_status()). The
	 *  rail exists once Stripe is configured; an operator can still freeze it in an emergency by setting
	 *  the AQ_CASHOUT_FROZEN env. While disabled, sell() refuses WITHOUT ever debiting coins, so coins
	 *  are never taken when no money can be sent — they stay fully gold-backed and redeemable the moment
	 *  this returns true. */
	public static function cashout_enabled() {
		return Stripe::enabled() && Secrets::get( 'AQ_CASHOUT_FROZEN' ) === '';
	}

	/** The member's stored Stripe Connect account id (set once they begin onboarding), or ''. */
	public static function payout_account( $uid ) {
		return (string) get_user_meta( (int) $uid, 'aq_stripe_account', true );
	}

	/** True when the member can actually receive a transfer: a connected account whose payouts are
	 *  enabled (KYC complete). A test seam (`aq_payout_ready` filter) lets the harness assert the
	 *  transfer path without a live Stripe account lookup; null (default) means check Stripe for real. */
	public static function payout_ready( $uid ) {
		$acct = self::payout_account( $uid );
		if ( $acct === '' ) { return false; }
		$override = apply_filters( 'aq_payout_ready', null, (int) $uid, $acct );
		if ( $override !== null ) { return (bool) $override; }
		// Cache the live status briefly so polling the wallet doesn't hit Stripe every load. The
		// account.updated webhook refreshes this the instant onboarding completes (see Extra::stripe_webhook).
		$ck = 'aq_payouts_' . md5( $acct );
		$c  = get_transient( $ck );
		if ( $c === '1' || $c === '0' ) { return $c === '1'; }
		$a     = Stripe::account( $acct );
		$ready = is_array( $a ) && ! empty( $a['payouts_enabled'] );
		set_transient( $ck, $ready ? '1' : '0', $ready ? 600 : 60 ); // confirmed-ready cached longer; not-yet shorter (still onboarding)
		return $ready;
	}

	/** Refresh the cached payouts-enabled flag for a connected account (called from the account.updated
	 *  webhook so a finished onboarding is reflected immediately, not after the cache expires). */
	public static function cache_payout_ready( $account_id, $ready ) {
		$account_id = (string) $account_id;
		if ( $account_id !== '' ) { set_transient( 'aq_payouts_' . md5( $account_id ), $ready ? '1' : '0', $ready ? 600 : 60 ); }
	}

	/**
	 * Append the cash-out debit and shrink the gold backing by exactly the coins redeemed — the ledger
	 * half of a payout, kept separate from the network transfer so it is pure + unit-testable. Idempotent
	 * per Stripe transfer id (ref `stripe_tr:<id>`): if the same transfer is ever recorded twice (a retry
	 * after the transfer succeeded but the debit didn't land), the second call no-ops. Returns the coins
	 * debited (0 if already recorded), so a caller can detect the replay.
	 */
	public static function record_payout( $uid, $coins, $transfer_id ) {
		$uid = (int) $uid; $coins = (int) $coins; $tid = (string) $transfer_id;
		if ( $uid < 1 || $coins < 1 || $tid === '' ) { return 0; }
		$ref = 'stripe_tr:' . $tid;
		if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'sell' AND ref = %s LIMIT 1", [ $ref ] ) ) { return 0; }
		self::credit_coins( $uid, -$coins, 'sell', $ref );
		self::counter_add( 'backing_mg', -$coins ); // atomic — backing shrinks in lockstep with the redeemed coins
		return $coins;
	}

	/**
	 * Daily cash-out reconcile (cron `aq_payout_reconcile`): record the coin debit for any Stripe
	 * cash-out transfer that went out but whose debit never landed — the rare timeout-after-success gap
	 * where sell() returned `payout_failed` (no debit) yet Stripe had already created the transfer under
	 * our idempotency key. record_payout is idempotent, so normal already-debited transfers are skipped.
	 * Returns the number of transfers it had to reconcile (0 in the healthy steady state).
	 */
	public static function reconcile_payouts() {
		if ( ! self::cashout_enabled() ) { return 0; }
		$since = time() - 3 * DAY_IN_SECONDS;
		$fixed = 0;
		foreach ( Stripe::list_transfers( $since, 100 ) as $t ) {
			$meta = is_array( $t['metadata'] ?? null ) ? $t['metadata'] : [];
			if ( ( $meta['aq_kind'] ?? '' ) !== 'cashout' ) { continue; }
			$uid   = (int) ( $meta['aq_uid'] ?? 0 );
			$coins = (int) ( $meta['aq_coins'] ?? 0 );
			$tid   = (string) ( $t['id'] ?? '' );
			if ( $uid && $coins && $tid && self::record_payout( $uid, $coins, $tid ) > 0 ) {
				$fixed++;
				error_log( "AQ reconcile: recorded missing cash-out debit u{$uid} {$coins} coins transfer={$tid}" );
			}
		}
		return $fixed;
	}

	/** GET /coins/payout/status — where the member stands on cash-out: whether the rail is live, whether
	 *  they have a connected account, and whether onboarding still needs finishing. No charge, no write. */
	public static function payout_status( $req ) {
		$uid  = Rest::uid();
		$acct = self::payout_account( $uid );
		return [
			'cashout_enabled' => self::cashout_enabled(),
			'connected'       => $acct !== '',
			'payouts_enabled' => self::cashout_enabled() && self::payout_ready( $uid ),
			'balance'         => self::coin_balance( $uid ),
			'sell_price'      => self::coin_price()['sell'],
			'currency'        => 'CAD',
		];
	}

	/** POST /coins/payout/connect — start (or resume) Stripe Express onboarding for cash-out. Creates a
	 *  connected account the first time, then returns a fresh Stripe-hosted onboarding link to redirect
	 *  to. Idempotent: an existing account id is reused, never duplicated. */
	public static function payout_connect( $req ) {
		if ( ! self::cashout_enabled() ) {
			return Rest::err( 'cashout_unavailable', 'Cash-out isn’t available yet. Your coins are fully gold-backed and safe.', 503 );
		}
		if ( Rest::throttle( 'payout_connect', 10, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = Rest::uid();
		if ( ! Verify::is_verified( $uid ) ) { return Rest::err( 'not_verified', 'Verify your identity (get the blue check) before setting up cash-out.', 403 ); }
		$user = get_userdata( $uid );
		if ( ! $user ) { return Rest::err( 'no_user', 'Please sign in again.', 401 ); }
		$acct = self::payout_account( $uid );
		if ( $acct === '' ) {
			$acct = Stripe::create_express_account( $user->user_email );
			if ( ! $acct ) { return Rest::err( 'stripe_error', 'Could not start payout setup. Please try again later.', 502 ); }
			update_user_meta( $uid, 'aq_stripe_account', $acct );
		}
		$wallet = home_url( '/wallet/' );
		$url = Stripe::account_link( $acct, $wallet . '?payout=refresh', $wallet . '?payout=done' );
		if ( ! $url ) { return Rest::err( 'stripe_error', 'Could not open payout setup. Please try again later.', 502 ); }
		return [ 'ok' => true, 'url' => $url ];
	}

	/**
	 * POST /coins/sell {coins} — cash out coins for fiat at the sell price. The mirror of buy(): money
	 * moves FIRST (a Stripe Connect transfer to the member's connected account), then the coins are
	 * debited — so a coin is never taken without a real payout behind it. Safeguards:
	 *   - refuses (no debit) when cash-out is disabled, the amount is bad, or the balance is short;
	 *   - requires a payouts-enabled connected account, else returns `needs_onboarding` so the UI can
	 *     send the member through Stripe onboarding;
	 *   - a per-user lock + idempotent record_payout() prevent a concurrent or replayed request from
	 *     double-spending the same balance.
	 */
	public static function sell( $req ) {
		if ( ! self::cashout_enabled() ) {
			return Rest::err( 'cashout_unavailable', 'Cash-out isn’t available yet. Your coins are fully gold-backed and safe — spend or hold them, and you’ll be able to redeem for cash once cash-out launches.', 503 );
		}
		if ( Rest::throttle( 'coin_sell', 10, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid   = Rest::uid();
		if ( ! Verify::is_verified( $uid ) ) { return Rest::err( 'not_verified', 'Verify your identity (get the blue check) before cashing out.', 403 ); }
		$coins = Rest::pint( $req, 'coins', 0 );
		if ( $coins < 1 ) { return Rest::err( 'bad_input', 'Enter how many coins to sell.' ); }
		if ( ! self::payout_ready( $uid ) ) {
			return Rest::err( 'needs_onboarding', 'Set up a payout account first to cash out your coins.', 409 );
		}

		// Guard against a concurrent second cash-out spending the same coins: a short per-user lock around
		// the read-transfer-debit sequence. Append-only ledgers are race-free for credits, but a payout
		// reads the balance THEN moves money, so two in-flight sells must be serialised. ATOMIC claim
		// (acquire_lock) — the old transient get→set had a read/write race two simultaneous sells with
		// DIFFERENT amounts could both slip through (same-amount replays were already caught by the
		// Stripe idempotency key below; different-amount pairs were not). ONE lock name — wallet_u<id> —
		// is shared by every user-initiated debit path (sell / shop order / enrol), so a cash-out can
		// never race a purchase past both balance checks either.
		$lock = 'wallet_u' . $uid;
		if ( ! self::acquire_lock( $lock, 30 ) ) { return Rest::err( 'busy', 'Another payment is in progress. Please wait a moment.', 429 ); }
		try {
			$bal = self::coin_balance( $uid );
			if ( $coins > $bal ) { return Rest::err( 'insufficient', 'You only have ' . $bal . ' ₳.' ); }
			$p           = self::coin_price();
			$payout      = round( $coins * $p['sell'], 2 );
			$payout_cents = (int) round( $payout * 100 );
			if ( $payout_cents < 1 ) { return Rest::err( 'too_small', 'That is below the minimum cash-out amount.' ); }

			// Idempotency key ties this attempt to a single Stripe transfer: a network retry returns the
			// SAME transfer rather than creating a second one.
			$idem     = 'aqsell:u' . $uid . ':' . $coins . ':' . $bal;
			$transfer = Stripe::create_transfer( $payout_cents, 'cad', self::payout_account( $uid ), $idem, [ 'aq_kind' => 'cashout', 'aq_uid' => $uid, 'aq_coins' => $coins ] );
			if ( ! $transfer || empty( $transfer['id'] ) ) {
				return Rest::err( 'payout_failed', 'The payout could not be sent. No coins were deducted — please try again.', 502 );
			}
			$debited = self::record_payout( $uid, $coins, (string) $transfer['id'] );
			return [
				'ok' => true, 'coins' => $coins, 'payout' => $payout, 'currency' => 'CAD',
				'balance' => self::coin_balance( $uid ),
				'message' => 'Cashed out ' . $coins . ' ₳ for $' . number_format( $payout, 2 ) . ' CAD — it’s on the way to your bank.',
			];
		} finally {
			self::release_lock( $lock );
		}
	}

	// ── Price oracle (gold spot + fx) — refresh + tamper/staleness guards ────────────────────────
	//
	// Every fiat↔coin conversion prices off two options: aq_gold_spot_oz_usd (+aq_gold_spot_ts) and
	// aq_fx_rates. Before 2026-07-10 NOTHING refreshed them — the oracle had been frozen for 35 days,
	// so coin buys, cash-outs and shop shipping all priced off stale gold. A stale or poisoned oracle
	// is a money-security hole: too-low a spot sells gold-backed coins cheap; too-high overpays
	// cash-outs. The daily cron below refreshes from two free keyless feeds, but a fetched value is
	// accepted only inside HARD sanity bounds AND within a ±20% band of the current value — a glitched
	// or manipulated feed can nudge the price, never crater or spike it. Rejections and staleness are
	// alarmed through the Watchdog so a broken feed is an operator page, not a silent mispricing.

	const ORACLE_MAX_AGE = 7 * DAY_IN_SECONDS;  // staleness alarm threshold (checked hourly by the Watchdog)
	const SPOT_HARD_MIN  = 1000.0;              // USD/oz — outside these the feed is broken, full stop
	const SPOT_HARD_MAX  = 20000.0;
	const ORACLE_BAND    = 0.20;                // max accepted move per refresh vs the current value

	/** Daily cron `aq_gold_rate`: refresh the gold spot + fx table, bounded and sanity-gated. */
	public static function gold_rate_tick() {
		// 1. Gold spot (USD/oz) — api.gold-api.com (free, keyless, bounded; JSON { price } in USD/ozt).
		$resp = wp_remote_get( 'https://api.gold-api.com/price/XAU', [ 'timeout' => 8 ] );
		if ( ! is_wp_error( $resp ) && 200 === (int) wp_remote_retrieve_response_code( $resp ) ) {
			$j     = json_decode( (string) wp_remote_retrieve_body( $resp ), true );
			$close = is_array( $j ) ? (float) ( $j['price'] ?? 0 ) : 0.0;
			$cur   = (float) get_option( 'aq_gold_spot_oz_usd', 0 );
			if ( $close >= self::SPOT_HARD_MIN && $close <= self::SPOT_HARD_MAX
				&& ( $cur <= 0 || abs( $close - $cur ) / $cur <= self::ORACLE_BAND ) ) {
				update_option( 'aq_gold_spot_oz_usd', $close, false );
				update_option( 'aq_gold_spot_ts', time(), false );
			} elseif ( $close > 0 ) {
				Watchdog::note( sprintf( 'Price oracle REJECTED a gold spot of %.2f USD/oz (current %.2f) — outside the sanity band', $close, $cur ) );
			}
		}
		// 2. FX table (USD-base) — open.er-api.com (free, keyless, bounded). Validated on the two rates
		//    the platform actually prices with: CAD (coin price) and TRY (shop shipping tariff).
		$resp = wp_remote_get( 'https://open.er-api.com/v6/latest/USD', [ 'timeout' => 8 ] );
		if ( ! is_wp_error( $resp ) && 200 === (int) wp_remote_retrieve_response_code( $resp ) ) {
			$j     = json_decode( (string) wp_remote_retrieve_body( $resp ), true );
			$rates = is_array( $j ) && ( $j['result'] ?? '' ) === 'success' && is_array( $j['rates'] ?? null ) ? $j['rates'] : [];
			$old   = get_option( 'aq_fx_rates', [] );
			$check = static function ( $k, $lo, $hi ) use ( $rates, $old ) {
				$v = (float) ( $rates[ $k ] ?? 0 );
				$o = is_array( $old ) ? (float) ( $old[ $k ] ?? 0 ) : 0.0;
				return $v >= $lo && $v <= $hi && ( $o <= 0 || abs( $v - $o ) / $o <= 0.30 );
			};
			if ( $rates && $check( 'CAD', 0.9, 2.5 ) && $check( 'TRY', 5, 500 ) ) {
				update_option( 'aq_fx_rates', $rates, false );
			} elseif ( $rates ) {
				Watchdog::note( 'Price oracle REJECTED an fx table (CAD/TRY outside the sanity band) — kept the previous rates' );
			}
		}
	}

	/** Hourly Watchdog check: alarm when the price oracle has gone stale (feed broken > policy age). */
	public static function check_oracle() {
		$ts = (int) get_option( 'aq_gold_spot_ts', 0 );
		if ( $ts <= 0 || time() - $ts <= self::ORACLE_MAX_AGE ) { return; }
		Watchdog::alert( 'oracle_stale', 'Coin price oracle is STALE — refresh feed broken for ' . (int) floor( ( time() - $ts ) / DAY_IN_SECONDS ) . ' days',
			'aq_gold_spot_oz_usd was last refreshed ' . gmdate( 'Y-m-d H:i', $ts ) . " UTC. Every coin buy, cash-out and shop\n"
			. 'shipping fee prices off it — a stale spot silently misprices real money in one direction or the other. '
			. 'Check the aq_gold_rate cron and the stooq/open.er-api feeds, or set the option by hand.' );
	}
}
