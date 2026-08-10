<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * METERED USAGE — what a member's compute actually cost, measured, and billed after the fact.
 *
 * Operator directive (2026-08-08): "it should be pay as you use … I want TRUE pay-per-use, the charge
 * should only be determined when session replies and session ends … each session they start should
 * have a cost meter attached to it … the user should get daily invoices … ensure the pricing is
 * accurate … take into account the $200 monthly Pro Max x20 and the Azure costs."
 *
 * ── WHY THERE IS NO PRICE LIST ────────────────────────────────────────────────────────────────────
 * A fixed price per tier would be a guess dressed up as a number. Two turns at the same tier can
 * differ by 20× — one asks a question, the other browses forty pages and compiles something — and
 * whichever way the guess is wrong, somebody is being quietly overcharged or the platform is quietly
 * subsidising. So a tier is a CEILING (how hard it may think, how much CPU and RAM it may have, how
 * long it may run) and the charge is the MEASURED cost of what actually happened. Nothing is reserved
 * up front: the charge is computed when the turn replies, or when the session ends, and not before.
 *
 * ── WHERE EVERY NUMBER COMES FROM ─────────────────────────────────────────────────────────────────
 * Measured on 2026-08-08, all of it checkable and none of it invented:
 *   • AI — the run reports its own consumption. The relay's ledger measured 73 real turns at
 *     3,586,894 tokens for $6.365 of API-equivalent value, i.e. ~$0.0872 a turn. The subscription is
 *     a flat $200/month (Claude Max 20×), so that plan breaks even at ~2,290 turns/month (~76/day)
 *     against current demand of ~69/day: metering at API-equivalent recovers close to exactly what
 *     the plan costs, which is why it is the honest meter to bill on rather than a markup.
 *   • Compute — Azure Container Apps consumption, from the live retail price API for swedencentral:
 *     $0.000024 per vCPU-second and $0.000003 per GiB-second.
 *   • Storage — Azure Files, $0.06 per GB-month, billed pro-rata per day of what is actually stored.
 *   • ArtaCoin — 1 ₳ is 1 mg of gold, full-reserve (see Economy). Every cost above is converted at the
 *     LIVE spot, so a price quoted in coins tracks the metal rather than drifting against it.
 *
 * These are constants because they are inputs to a public bill and must not move silently. When Azure
 * changes its rates or the plan changes, edit them HERE, in one place, with the date.
 */
final class Usage {

	const TABLE_VERSION = '5';

	// ── the measured rates (see the header for provenance) ───────────────────────
	/**
	 * WHAT THE AI ACTUALLY COSTS THE FOUNDATION — not what the tokens would cost somebody else.
	 *
	 * The run reports `total_cost_usd`: the API-equivalent value of the tokens it used. Billing that
	 * figure was defensible while it happened to match what the plan cost us — the first 73 turns
	 * averaged $0.087 and a $200 plan breaks even around 76 turns a day. It no longer matches: measured
	 * over 38 real turns on 2026-08-09, the average is $0.24, because every turn is now a TOOL turn and
	 * those think far harder. At ~69 turns a day that is ~$497 a month of API-equivalent value against
	 * a plan that costs $200 — so billing the list price would charge members two and a half times what
	 * their work costs the Foundation.
	 *
	 * So the plan is AMORTISED over what it actually served: each turn is charged its share of the
	 * subscription, `list × (plan ÷ list value of everything the plan served in the last 30 days)`. The
	 * factor is capped at 1 — we never charge MORE than the tokens are worth, even in a quiet month —
	 * and both numbers are stored on every row, so a member can see the list price, the factor and what
	 * they were actually charged, and check the arithmetic themselves.
	 *
	 * Rolling 30 days rather than calendar-month-to-date deliberately: a factor that resets on the 1st
	 * would charge the first member of the month the full list price and the last one almost nothing,
	 * for identical work.
	 */
	const PLAN_USD_MONTH = 200.0;

	/** USD per vCPU-second, Azure Container Apps consumption, swedencentral, 2026-08-08. */
	const USD_PER_VCPU_SEC = 0.000024;
	/** USD per GiB-second, same. */
	const USD_PER_GIB_SEC  = 0.000003;
	/** USD per GB-month of Azure Files (standard LRS), same. */
	const USD_PER_GB_MONTH = 0.06;
	/** mg in a troy ounce — the constant that turns a gold spot into a coin price. */
	const MG_PER_OZT       = 31103.4768;

	/**
	 * THE FIVE TIERS. Each is a CEILING, never a price.
	 *
	 * `cpu`/`ram` are what the sandbox is given, and they are the Container Apps consumption ladder:
	 * that platform fixes the ratio at 1 vCPU to 2 GiB, so "2 cores and 8 GiB" is not a shape that
	 * exists there — the top tier is 4 vCPU / 8 GiB, which is more than was asked for on both axes and
	 * costs nothing extra while idle because it is billed by the second it runs.
	 *
	 * `secs` is the wall-clock ceiling: the point at which a runaway is killed, not a target.
	 * `maxtok` is the reply ceiling. `effort` is how hard it may think.
	 */
	const TIERS = [
		'low'      => [ 'n' => 1, 'label' => 'Quick',      'effort' => 'low',    'cpu' => 1.0, 'ram' => 2, 'secs' =>  180, 'maxtok' =>   800, 'workflow' => false, 'blurb' => 'A question and an answer' ],
		'medium'   => [ 'n' => 2, 'label' => 'Thoughtful', 'effort' => 'medium', 'cpu' => 1.0, 'ram' => 2, 'secs' =>  300, 'maxtok' =>  2000, 'workflow' => false, 'blurb' => 'Thinks before it answers' ],
		'high'     => [ 'n' => 3, 'label' => 'Deep',       'effort' => 'high',   'cpu' => 2.0, 'ram' => 4, 'secs' =>  600, 'maxtok' =>  4000, 'workflow' => false, 'blurb' => 'Builds things, runs them, shows you' ],
		'xhigh'    => [ 'n' => 4, 'label' => 'Research',   'effort' => 'xhigh',  'cpu' => 2.0, 'ram' => 4, 'secs' => 1200, 'maxtok' =>  8000, 'workflow' => false, 'blurb' => 'Reads around, checks, comes back' ],
		'max'      => [ 'n' => 5, 'label' => 'Max',        'effort' => 'max',    'cpu' => 4.0, 'ram' => 8, 'secs' => 1800, 'maxtok' => 16000, 'workflow' => false, 'blurb' => 'Everything it has, on one problem' ],
		'workflow' => [ 'n' => 6, 'label' => 'Workflow',   'effort' => 'max',    'cpu' => 4.0, 'ram' => 8, 'secs' => 2700, 'maxtok' => 16000, 'workflow' => true,  'blurb' => 'Many agents at once, then one answer' ],
	];
	const DEFAULT_TIER = 'low';

	/**
	 * NOBODY IS EXEMPT (operator, 2026-08-08: "not free for /artafather. it should be equal access and
	 * price for all").
	 *
	 * There was briefly an allow-list here holding the operator's own handles. It is deleted rather
	 * than emptied, and that is the point: an empty exemption list is an invitation to add one back,
	 * and a platform whose premise is that a stranger can check everything cannot have a price that
	 * depends on who you are. The operator pays the same metered cost as every other member, from the
	 * same measurements, on the same invoice.
	 */

	/** A member may start work while owing up to this much (coins). Not a credit line — it is the slack
	 *  that makes "charge only at the end" safe: a turn can finish and settle even if it costs more
	 *  than the balance it started with, and the NEXT one is refused until they top up. Without slack,
	 *  billing after the fact would mean either refusing mid-turn or allowing unbounded debt. */
	const DEBT_FLOOR = -25;

	public static function ensure_tables() {
		if ( get_option( 'aq_usage_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		// NO `--` COMMENTS INSIDE THE DDL BELOW. dbDelta parses the statement itself, line by line, and a
		// SQL comment makes it skip the columns around it — it ran, wrote the new version number, and
		// added nothing, so the code stored measurements into columns that did not exist and every read
		// came back empty. Explain the schema HERE, in PHP, where the parser never looks.
		//
		// `used_cpu` / `peak_mb` are what a turn ACTUALLY used, as against what its tier reserved:
		// cpu_sec is the billed figure (tier vCPU × wall clock), these two are what the container
		// measured of itself. Keeping both is the point — the gap between them IS the waste, and it is
		// only visible if both are stored.
		// One row per metered thing: a chat turn that replied, or a shell session that ended. The
		// components are stored SEPARATELY, not just the total, because an invoice a member cannot take
		// apart is a number to be trusted rather than checked — and this platform's whole premise is
		// that a stranger can check.
		dbDelta( "CREATE TABLE {$wpdb->prefix}aq_usage (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			session_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			kind VARCHAR(12) NOT NULL DEFAULT 'chat',
			tier VARCHAR(10) NOT NULL DEFAULT 'low',
			started INT UNSIGNED NOT NULL DEFAULT 0,
			ended INT UNSIGNED NOT NULL DEFAULT 0,
			secs INT UNSIGNED NOT NULL DEFAULT 0,
			tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
			ai_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
			cpu_sec DECIMAL(12,3) NOT NULL DEFAULT 0,
			gib_sec DECIMAL(12,3) NOT NULL DEFAULT 0,
			ai_list DECIMAL(12,6) NOT NULL DEFAULT 0,
			ai_factor DECIMAL(6,4) NOT NULL DEFAULT 1,
			used_cpu DECIMAL(12,3) NOT NULL DEFAULT 0,
			peak_mb INT UNSIGNED NOT NULL DEFAULT 0,
			azure_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
			total_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
			coins DECIMAL(12,4) NOT NULL DEFAULT 0,
			spot DECIMAL(12,2) NOT NULL DEFAULT 0,
			free TINYINT(1) NOT NULL DEFAULT 0,
			note VARCHAR(190) NOT NULL DEFAULT '',
			ref VARCHAR(80) NOT NULL DEFAULT '',
			PRIMARY KEY  (id),
			KEY user_ended (user_id, ended),
			KEY session (session_id),
			KEY ref (ref)
		) {$charset};" );
		dbDelta( "CREATE TABLE {$wpdb->prefix}aq_invoices (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			day VARCHAR(10) NOT NULL DEFAULT '',
			items INT UNSIGNED NOT NULL DEFAULT 0,
			total_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
			total_coins DECIMAL(12,4) NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			sent INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY user_day (user_id, day)
		) {$charset};" );
		update_option( 'aq_usage_table_version', self::TABLE_VERSION, true );
	}

	// ── pricing (pure; every one of these is unit-testable) ──────────────────────

	/** Normalise a requested tier to one we offer. */
	public static function tier( $want ) {
		$k = strtolower( trim( (string) $want ) );
		return isset( self::TIERS[ $k ] ) ? $k : self::DEFAULT_TIER;
	}

	/** PURE — the Azure cost of holding `cpu` vCPU and `ram` GiB for `secs` seconds. */
	public static function azure_usd( $cpu, $ram, $secs ) {
		$secs = max( 0.0, (float) $secs );
		return ( (float) $cpu * $secs * self::USD_PER_VCPU_SEC )
		     + ( (float) $ram * $secs * self::USD_PER_GIB_SEC );
	}

	/** PURE — USD → coins at a given gold spot. 1 ₳ = 1 mg, so one coin is spot ÷ mg-per-ounce. */
	public static function usd_to_coins( $usd, $spot_oz_usd ) {
		$spot = (float) $spot_oz_usd;
		if ( $spot <= 0 ) { return 0.0; }
		return round( ( (float) $usd ) * self::MG_PER_OZT / $spot, 4 );
	}

	/** May this member START something? True pay-per-use means we cannot know the cost in advance, so
	 *  the gate is on what they already owe, not on what this will cost. */
	public static function may_start( $uid ) {
		return (float) Economy::coin_balance( (int) $uid ) > self::DEBT_FLOOR;
	}

	/**
	 * THE ONLY PLACE A CHARGE IS MADE. Called when a turn has REPLIED or a session has ENDED — never
	 * before, because until then the cost is not a fact.
	 *
	 * `$m` carries what was measured: ai_usd (what the run itself reported), secs, and the tier's
	 * cpu/ram. Idempotent on `ref`, so a delivery that runs twice bills once.
	 */
	/** The share of the subscription one dollar of list-price AI is charged at right now. Cached for
	 *  six hours: it is a slow-moving average over thirty days, and recomputing it per turn would put a
	 *  full-table aggregate in front of every reply. */
	public static function ai_factor() {
		$f = get_transient( 'aq_ai_factor' );
		if ( $f !== false ) { return (float) $f; }
		// GREATEST(ai_list, ai_usd): rows written before this change stored the list price in ai_usd and
		// have no ai_list, and dropping them would make the plan look emptier than it was.
		$list = (float) Data::col(
			'SELECT COALESCE(SUM(GREATEST(ai_list, ai_usd)),0) FROM ' . Data::t( 'aq_usage' ) . ' WHERE ended >= %d',
			[ time() - 30 * DAY_IN_SECONDS ] );
		$f = $list > self::PLAN_USD_MONTH ? self::PLAN_USD_MONTH / $list : 1.0;
		set_transient( 'aq_ai_factor', $f, 6 * HOUR_IN_SECONDS );
		return $f;
	}

	public static function record( $uid, $kind, $tier, $m ) {
		self::ensure_tables();
		$uid  = (int) $uid;
		$tier = self::tier( $tier );
		$ref  = (string) ( $m['ref'] ?? '' );
		if ( $ref !== '' && Data::col( 'SELECT id FROM ' . Data::t( 'aq_usage' ) . ' WHERE ref = %s LIMIT 1', [ $ref ] ) ) {
			return null;                                   // already billed — never twice
		}
		$t       = self::TIERS[ $tier ];
		$secs    = max( 0.0, (float) ( $m['secs'] ?? 0 ) );
		$cpu_sec = $t['cpu'] * $secs;
		$gib_sec = $t['ram'] * $secs;
		$list    = max( 0.0, (float) ( $m['ai_usd'] ?? 0 ) );   // what the tokens are worth at API rates
		$factor  = self::ai_factor();
		$ai      = $list * $factor;                              // …and what that costs the Foundation
		$azure   = self::azure_usd( $t['cpu'], $t['ram'], $secs );
		$total   = $ai + $azure;
		$spot    = (float) Economy::gold_oz_usd();
		$coins   = self::usd_to_coins( $total, $spot );

		$id = Data::insert( 'aq_usage', [
			'user_id' => $uid, 'session_id' => (int) ( $m['session'] ?? 0 ),
			'kind' => substr( (string) $kind, 0, 12 ), 'tier' => $tier,
			'started' => (int) ( $m['started'] ?? ( Data::now() - (int) $secs ) ),
			'ended'   => Data::now(),
			'secs'    => (int) round( $secs ),
			'tokens'  => (int) ( $m['tokens'] ?? 0 ),
			'ai_usd'  => $ai, 'ai_list' => $list, 'ai_factor' => $factor,
			'cpu_sec' => $cpu_sec, 'gib_sec' => $gib_sec,
			'used_cpu' => max( 0.0, (float) ( $m['cpu_secs'] ?? 0 ) ),
			'peak_mb'  => max( 0, (int) ( $m['peak_mb'] ?? 0 ) ),
			'azure_usd' => $azure, 'total_usd' => $total, 'coins' => $coins, 'spot' => $spot,
			'free'    => 0,   // kept so rows written before the exemption was removed stay readable
			'note'    => substr( sanitize_text_field( (string) ( $m['note'] ?? '' ) ), 0, 190 ),
			'ref'     => substr( $ref, 0, 80 ),
		] );
		// NOTE WHAT IS *NOT* HERE: no ledger write. See settle() — the coin ledger is integer-denominated
		// (1 ₳ = 1 mg of gold, full-reserve), and a typical turn costs about 0.65 ₳. Debiting per turn
		// wrote `delta = 0` every single time, so the platform metered everything and charged nobody.
		// Usage accrues here at full precision; whole coins move once a day.
		return [ 'id' => (int) $id, 'coins' => $coins, 'usd' => $total ];
	}

	/** What a session is costing RIGHT NOW — the live meter, from the tier's rates and the seconds so
	 *  far. Pure, so the same function drives the chat meter, the terminal meter and the invoice. */
	public static function meter( $tier, $secs, $ai_usd = 0.0 ) {
		$tier = self::tier( $tier );
		$t    = self::TIERS[ $tier ];
		$usd  = (float) $ai_usd + self::azure_usd( $t['cpu'], $t['ram'], $secs );
		$spot = (float) Economy::gold_oz_usd();
		return [
			'secs'  => (int) $secs,
			'usd'   => round( $usd, 6 ),
			'coins' => self::usd_to_coins( $usd, $spot ),
			'tier'  => $tier,
			'cpu'   => $t['cpu'],
			'ram'   => $t['ram'],
		];
	}

	// ── member-facing ────────────────────────────────────────────────────────────

	/** GET /usage — the tier menu with what each ceiling would cost per minute, this member's balance,
	 *  and their recent metered lines. Everything a member needs to predict a bill before running one. */
	public static function mine( $req ) {
		self::ensure_tables();
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'signin_required', 'Sign in to see your usage', 401 ); }
		$spot  = (float) Economy::gold_oz_usd();
		$tiers = [];
		foreach ( self::TIERS as $k => $t ) {
			// Per MINUTE of compute, so a member can reason about a long job. The AI part is not
			// included here because it is not knowable in advance — and saying so is the point.
			$per_min = self::azure_usd( $t['cpu'], $t['ram'], 60 );
			$tiers[] = [
				'key' => $k, 'n' => $t['n'], 'label' => $t['label'], 'effort' => $t['effort'],
				'cpu' => $t['cpu'], 'ram' => $t['ram'], 'max_secs' => $t['secs'], 'max_tokens' => $t['maxtok'],
				'blurb' => $t['blurb'], 'workflow' => (bool) $t['workflow'],
				'compute_usd_per_min' => round( $per_min, 6 ),
				'compute_coins_per_min' => self::usd_to_coins( $per_min, $spot ),
			];
		}
		$rows = Data::all(
			'SELECT id, session_id, kind, tier, started, ended, secs, tokens, ai_usd, azure_usd, total_usd, coins, note FROM '
			. Data::t( 'aq_usage' ) . ' WHERE user_id = %d ORDER BY id DESC LIMIT 50', [ $uid ] );
		return [
			'balance' => (float) Economy::coin_balance( $uid ),
			'carry'   => self::carry( $uid ),
			'floor'   => self::DEBT_FLOOR,
			'spot'    => $spot,
			'coin_usd' => $spot > 0 ? round( $spot / self::MG_PER_OZT, 6 ) : 0,
			'tiers'   => $tiers,
			'recent'  => $rows,
		];
	}

	/** GET /invoices — this member's daily statements. */
	public static function invoices( $req ) {
		self::ensure_tables();
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'signin_required', 'Sign in to see your invoices', 401 ); }
		$day = sanitize_text_field( (string) Rest::p( $req, 'day', '' ) );
		if ( $day !== '' ) {
			// One day, itemised — every line the total was made of.
			$inv = Data::one( 'SELECT * FROM ' . Data::t( 'aq_invoices' ) . ' WHERE user_id = %d AND day = %s', [ $uid, $day ] );
			$lines = Data::all(
				'SELECT id, session_id, kind, tier, started, ended, secs, tokens, ai_usd, azure_usd, total_usd, coins, note FROM '
				. Data::t( 'aq_usage' ) . ' WHERE user_id = %d AND ended >= %d AND ended < %d ORDER BY id ASC',
				[ $uid, strtotime( $day . ' 00:00:00 UTC' ), strtotime( $day . ' 00:00:00 UTC' ) + DAY_IN_SECONDS ] );
			return [ 'day' => $day, 'invoice' => $inv, 'lines' => $lines ];
		}
		return [ 'items' => Data::all(
			'SELECT day, items, total_usd, total_coins, created, sent FROM ' . Data::t( 'aq_invoices' )
			. ' WHERE user_id = %d ORDER BY day DESC LIMIT 60', [ $uid ] ) ];
	}

	// ── the daily invoice ────────────────────────────────────────────────────────

	/**
	 * Daily cron `aq_daily_invoice`: roll YESTERDAY into one statement per member who used anything,
	 * and email it. Idempotent on (user, day) — the unique key means a re-run updates rather than
	 * duplicates, so a cron that fires twice does not bill or mail twice.
	 *
	 * The invoice does not MOVE money: every line was already charged the moment it happened (that is
	 * what pay-per-use means). It is a statement of what was charged and why, which is the only thing
	 * that makes an after-the-fact charge fair — you can check it line by line.
	 */
	public static function daily_invoice_tick() {
		self::ensure_tables();
		global $wpdb;
		$day   = gmdate( 'Y-m-d', time() - DAY_IN_SECONDS );
		$from  = strtotime( $day . ' 00:00:00 UTC' );
		$to    = $from + DAY_IN_SECONDS;
		$t     = Data::t( 'aq_usage' );
		$rows  = $wpdb->get_results( $wpdb->prepare(
			"SELECT user_id, COUNT(*) items, SUM(total_usd) usd, SUM(coins) coins
			 FROM {$t} WHERE ended >= %d AND ended < %d GROUP BY user_id", $from, $to ), ARRAY_A );
		foreach ( $rows as $r ) {
			$uid = (int) $r['user_id'];
			$existing = Data::one( 'SELECT id, sent FROM ' . Data::t( 'aq_invoices' ) . ' WHERE user_id = %d AND day = %s', [ $uid, $day ] );
			if ( $existing ) {
				Data::update( 'aq_invoices', [
					'items' => (int) $r['items'], 'total_usd' => (float) $r['usd'], 'total_coins' => (float) $r['coins'],
				], [ 'id' => (int) $existing['id'] ] );
			} else {
				Data::insert( 'aq_invoices', [
					'user_id' => $uid, 'day' => $day, 'items' => (int) $r['items'],
					'total_usd' => (float) $r['usd'], 'total_coins' => (float) $r['coins'],
					'created' => Data::now(), 'sent' => 0,
				] );
			}
			// Settle BEFORE mailing, so the statement can say what was actually taken.
			$st = self::settle( $uid );
			if ( ! $existing || ! (int) $existing['sent'] ) { self::mail_invoice( $uid, $day, $st ); }
		}
		return count( $rows );
	}

	/** The running total a member has actually been charged, in whole coins. */
	const SETTLED_META = 'aq_usage_settled';

	/** Coins accrued but not yet charged — always derived, never stored, so it cannot drift from the
	 *  two numbers it sits between. */
	public static function carry( $uid ) {
		return max( 0.0, round( self::accrued( $uid ) - self::settled( $uid ), 4 ) );
	}

	/** Everything this member's work has cost, all time, at full precision. */
	public static function accrued( $uid ) {
		return (float) Data::col( 'SELECT COALESCE(SUM(coins),0) FROM ' . Data::t( 'aq_usage' ) . ' WHERE user_id = %d', [ (int) $uid ] );
	}

	/** Everything they have actually been charged. Seeded from the LEDGER the first time, so a member
	 *  who was already billed under the old per-day scheme is not billed for it twice. */
	public static function settled( $uid ) {
		$m = get_user_meta( (int) $uid, self::SETTLED_META, true );
		if ( $m !== '' ) { return (float) $m; }
		$prior = (float) Data::col( 'SELECT COALESCE(-SUM(delta),0) FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE user_id = %d AND reason = 'usage'", [ (int) $uid ] );
		update_user_meta( (int) $uid, self::SETTLED_META, $prior );
		return $prior;
	}

	/**
	 * Charge whatever has accrued and not yet been charged, in whole coins.
	 *
	 * ON A RUNNING TOTAL, NOT PER DAY — and that distinction is a money bug I shipped and had to
	 * find. The first version keyed settlement on the calendar day and made it idempotent by day. Any
	 * settlement of a day that was not yet OVER therefore locked the rest of it: usage that landed
	 * afterwards fell inside an already-settled ref and could never be charged. Measured on production:
	 * 10.6515 coins of real work with 1.0000 charged and 9.3248 stranded, silently, with every
	 * individual number correct.
	 *
	 * A running total cannot do that. Owed is always accrued-minus-settled, so late arrivals, retries,
	 * clock skew and a cron that fires twice all converge on the same answer. The ledger ref is the new
	 * settled total, which is monotonic — so it is idempotent without needing a window to be closed.
	 */
	public static function settle( $uid ) {
		$uid     = (int) $uid;
		$accrued = self::accrued( $uid );
		$settled = self::settled( $uid );
		$owed    = round( $accrued - $settled, 4 );
		if ( $owed < 1 ) { return [ 'charged' => 0, 'carry' => max( 0.0, $owed ) ]; }
		$whole = (int) floor( $owed );
		$next  = $settled + $whole;
		$ref   = 'settle:' . number_format( $next, 4, '.', '' );
		if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'usage' AND ref = %s LIMIT 1", [ $ref ] ) ) {
			return [ 'charged' => 0, 'carry' => round( $accrued - $next, 4 ) ];
		}
		Economy::credit_coins( $uid, -$whole, 'usage', $ref );
		update_user_meta( $uid, self::SETTLED_META, $next );
		return [ 'charged' => $whole, 'carry' => round( $accrued - $next, 4 ) ];
	}

	/**
	 * THE STATEMENT, as something a person reads (operator, 2026-08-10, of the first version: "this is
	 * extremely ugly and useless").
	 *
	 * It was a monospace dump of internal columns — session id, kind, tier key, seconds, a raw coin
	 * figure and the member's own prompt cut mid-word. Every field was there and none of it answered
	 * the question a statement exists to answer: what did I do, and what did it cost me. So: the three
	 * numbers that matter first, then one row per piece of work in the words the member used.
	 */
	private static function invoice_summary( $inv, $st, $uid ) {
		$cell = static function ( $big, $small, $tone = '#1f2a37' ) {
			return '<td width="33%" style="padding:0 6px 0 0;vertical-align:top">'
				. '<div style="background:#f6f8fb;border-radius:10px;padding:12px 14px">'
				. '<div style="font-size:20px;font-weight:700;color:' . $tone . ';white-space:nowrap">' . $big . '</div>'
				. '<div style="font-size:12px;color:#8a97a6;margin-top:2px">' . $small . '</div></div></td>';
		};
		return '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:2px 0 18px"><tr>'
			. $cell( esc_html( number_format( (float) $inv['total_coins'], 4 ) ) . ' &#8371;', 'used today', '#1746DC' )
			. $cell( esc_html( (string) (int) ( $st['charged'] ?? 0 ) ) . ' &#8371;', 'charged, in whole coins' )
			. $cell( esc_html( number_format( (float) Economy::coin_balance( $uid ), 2 ) ) . ' &#8371;', 'balance now' )
			. '</tr></table>';
	}

	/** One row per piece of work: when, what the member asked for, which mode, how long, what it cost.
	 *  No session ids and no tier keys — those are ours, not theirs. */
	private static function invoice_table( $lines ) {
		if ( ! $lines ) { return ''; }
		$th = 'style="padding:0 8px 6px 0;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#8a97a6;text-align:left"';
		$out = '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 18px;border-collapse:collapse">'
			. '<tr><th ' . $th . '>What you asked</th><th ' . $th . '>Mode</th>'
			. '<th ' . str_replace( 'text-align:left', 'text-align:right', $th ) . '>Time</th>'
			. '<th ' . str_replace( 'text-align:left', 'text-align:right', $th ) . '>Cost</th></tr>';
		foreach ( $lines as $l ) {
			$tier = self::TIERS[ self::tier( $l['tier'] ) ]['label'] ?? $l['tier'];
			$what = trim( (string) $l['note'] );
			if ( $what === '' ) { $what = $l['kind'] === 'shell' ? 'Terminal session' : 'A message to ArtaBot'; }
			// Cut on a WORD, and only when there is something to cut — a statement that ends every line
			// mid-syllable reads as broken software, which is exactly how the first version read.
			if ( mb_strlen( $what ) > 64 ) { $what = rtrim( mb_substr( $what, 0, 61 ), " ,.;:" ) . '…'; }
			$secs = (int) $l['secs'];
			$td   = 'style="padding:9px 8px 9px 0;border-top:1px solid #eef2f7;font-size:13px;color:#1f2a37;vertical-align:top"';
			$out .= '<tr><td ' . $td . '>' . esc_html( $what ) . '</td>'
				. '<td ' . $td . '><span style="color:#8a97a6">' . esc_html( $tier ) . '</span></td>'
				. '<td ' . str_replace( 'vertical-align:top', 'vertical-align:top;text-align:right;white-space:nowrap;color:#8a97a6', $td ) . '>'
				. esc_html( $secs >= 60 ? intdiv( $secs, 60 ) . 'm ' . ( $secs % 60 ) . 's' : $secs . 's' ) . '</td>'
				. '<td ' . str_replace( 'vertical-align:top', 'vertical-align:top;text-align:right;white-space:nowrap;font-weight:600', $td ) . '>'
				. esc_html( number_format( (float) $l['coins'], 4 ) ) . ' &#8371;</td></tr>';
		}
		return $out . '</table>';
	}

	/** Email one day's statement. Fail-open: a mail problem must never hold up the ledger. */
	private static function mail_invoice( $uid, $day, $st = [ 'charged' => 0, 'carry' => 0 ] ) {
		$u = get_userdata( (int) $uid );
		if ( ! $u || ! $u->user_email ) { return; }
		$inv = Data::one( 'SELECT * FROM ' . Data::t( 'aq_invoices' ) . ' WHERE user_id = %d AND day = %s', [ $uid, $day ] );
		if ( ! $inv ) { return; }
		$lines = Data::all(
			'SELECT session_id, kind, tier, secs, tokens, total_usd, coins, note FROM ' . Data::t( 'aq_usage' )
			. ' WHERE user_id = %d AND ended >= %d AND ended < %d ORDER BY id ASC LIMIT 200',
			[ $uid, strtotime( $day . ' 00:00:00 UTC' ), strtotime( $day . ' 00:00:00 UTC' ) + DAY_IN_SECONDS ] );
		$sent = Mailer::send( 'usage_invoice', $u->user_email, [
			// The real-name helper lives in the theme, and the plugin may not assume the theme is loaded
			// (wp-cli, cron). Ask for it when it is there and fall back to what the account has.
			'name'    => function_exists( 'aq_profile_name' ) ? aq_profile_name( $u ) : $u->display_name,
			'day'     => date_i18n( 'l j F', strtotime( $day . ' 12:00:00' ) ),
			'items'   => (int) $inv['items'],
			'total'   => number_format( (float) $inv['total_coins'], 4 ),
			'charged' => (string) (int) ( $st['charged'] ?? 0 ),
			'carry'   => number_format( (float) ( $st['carry'] ?? 0 ), 4 ),
			'usd'     => number_format( (float) $inv['total_usd'], 2 ),
			'summary' => self::invoice_summary( $inv, $st, $uid ),
			'table'   => self::invoice_table( $lines ),
		] );
		if ( $sent ) { Data::update( 'aq_invoices', [ 'sent' => Data::now() ], [ 'id' => (int) $inv['id'] ] ); }
	}
}
