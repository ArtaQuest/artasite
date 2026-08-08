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

	const TABLE_VERSION = '1';

	// ── the measured rates (see the header for provenance) ───────────────────────
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
		'low'    => [ 'n' => 1, 'label' => 'Quick',      'effort' => 'low',    'cpu' => 0.5, 'ram' => 1, 'secs' =>  240, 'maxtok' =>   800, 'workflow' => false ],
		'medium' => [ 'n' => 2, 'label' => 'Thoughtful', 'effort' => 'medium', 'cpu' => 1.0, 'ram' => 2, 'secs' =>  600, 'maxtok' =>  2000, 'workflow' => false ],
		'high'   => [ 'n' => 3, 'label' => 'Deep',       'effort' => 'high',   'cpu' => 2.0, 'ram' => 4, 'secs' => 1200, 'maxtok' =>  4000, 'workflow' => false ],
		'xhigh'  => [ 'n' => 4, 'label' => 'Research',   'effort' => 'xhigh',  'cpu' => 3.0, 'ram' => 6, 'secs' => 2400, 'maxtok' =>  8000, 'workflow' => true  ],
		'max'    => [ 'n' => 5, 'label' => 'Max',        'effort' => 'max',    'cpu' => 4.0, 'ram' => 8, 'secs' => 3600, 'maxtok' => 16000, 'workflow' => true  ],
	];
	const DEFAULT_TIER = 'low';

	/**
	 * Handles that are never billed (operator directive: "only free for the /arash user").
	 *
	 * Both spellings on purpose: the operator's handle is `artafather` today and `arash` is the name
	 * they used when they asked for this, so whichever they settle on, the account stays free rather
	 * than starting to bill them the day they rename themselves.
	 */
	const FREE_HANDLES = [ 'arash', 'artafather' ];

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
		// One row per metered thing: a chat turn that replied, or a shell session that ended. The
		// components are stored SEPARATELY, not just the total, because an invoice a member cannot take
		// apart is a number to be trusted rather than checked — and this platform's whole premise is
		// that a stranger can check.
		dbDelta( "CREATE TABLE {$wpdb->prefix}aq_usage (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			kind VARCHAR(12) NOT NULL DEFAULT 'chat',
			tier VARCHAR(10) NOT NULL DEFAULT 'low',
			started INT UNSIGNED NOT NULL DEFAULT 0,
			ended INT UNSIGNED NOT NULL DEFAULT 0,
			secs INT UNSIGNED NOT NULL DEFAULT 0,
			tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
			ai_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
			cpu_sec DECIMAL(12,3) NOT NULL DEFAULT 0,
			gib_sec DECIMAL(12,3) NOT NULL DEFAULT 0,
			azure_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
			total_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
			coins DECIMAL(12,4) NOT NULL DEFAULT 0,
			spot DECIMAL(12,2) NOT NULL DEFAULT 0,
			free TINYINT(1) NOT NULL DEFAULT 0,
			note VARCHAR(190) NOT NULL DEFAULT '',
			ref VARCHAR(80) NOT NULL DEFAULT '',
			PRIMARY KEY  (id),
			KEY user_ended (user_id, ended),
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

	/** Is this member billed at all? */
	public static function is_free( $uid ) {
		$u = get_userdata( (int) $uid );
		return $u ? in_array( strtolower( $u->user_nicename ), self::FREE_HANDLES, true ) : false;
	}

	/** May this member START something? True pay-per-use means we cannot know the cost in advance, so
	 *  the gate is on what they already owe, not on what this will cost. */
	public static function may_start( $uid ) {
		if ( self::is_free( $uid ) ) { return true; }
		return (float) Economy::coin_balance( (int) $uid ) > self::DEBT_FLOOR;
	}

	/**
	 * THE ONLY PLACE A CHARGE IS MADE. Called when a turn has REPLIED or a session has ENDED — never
	 * before, because until then the cost is not a fact.
	 *
	 * `$m` carries what was measured: ai_usd (what the run itself reported), secs, and the tier's
	 * cpu/ram. Idempotent on `ref`, so a delivery that runs twice bills once.
	 */
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
		$ai      = max( 0.0, (float) ( $m['ai_usd'] ?? 0 ) );
		$azure   = self::azure_usd( $t['cpu'], $t['ram'], $secs );
		$total   = $ai + $azure;
		$spot    = (float) Economy::gold_oz_usd();
		$coins   = self::usd_to_coins( $total, $spot );
		$free    = self::is_free( $uid );

		$id = Data::insert( 'aq_usage', [
			'user_id' => $uid, 'kind' => substr( (string) $kind, 0, 12 ), 'tier' => $tier,
			'started' => (int) ( $m['started'] ?? ( Data::now() - (int) $secs ) ),
			'ended'   => Data::now(),
			'secs'    => (int) round( $secs ),
			'tokens'  => (int) ( $m['tokens'] ?? 0 ),
			'ai_usd'  => $ai, 'cpu_sec' => $cpu_sec, 'gib_sec' => $gib_sec,
			'azure_usd' => $azure, 'total_usd' => $total, 'coins' => $coins, 'spot' => $spot,
			'free'    => $free ? 1 : 0,
			'note'    => substr( sanitize_text_field( (string) ( $m['note'] ?? '' ) ), 0, 190 ),
			'ref'     => substr( $ref, 0, 80 ),
		] );
		// The money moves only for a member who is billed. The usage row is written either way, so a
		// free account still gets an honest meter and an honest invoice showing zero.
		if ( ! $free && $coins > 0 ) {
			Economy::credit_coins( $uid, -$coins, 'usage', $ref ?: ( 'u' . $uid . ':' . $id ) );
		}
		return [ 'id' => (int) $id, 'coins' => $coins, 'usd' => $total, 'free' => $free ];
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
				'compute_usd_per_min' => round( $per_min, 6 ),
				'compute_coins_per_min' => self::usd_to_coins( $per_min, $spot ),
			];
		}
		$rows = Data::all(
			'SELECT id, kind, tier, started, ended, secs, tokens, ai_usd, azure_usd, total_usd, coins, free, note FROM '
			. Data::t( 'aq_usage' ) . ' WHERE user_id = %d ORDER BY id DESC LIMIT 50', [ $uid ] );
		return [
			'free'    => self::is_free( $uid ),
			'balance' => (float) Economy::coin_balance( $uid ),
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
				'SELECT id, kind, tier, started, ended, secs, tokens, ai_usd, azure_usd, total_usd, coins, note FROM '
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
			if ( ! $existing || ! (int) $existing['sent'] ) { self::mail_invoice( $uid, $day ); }
		}
		return count( $rows );
	}

	/** Email one day's statement. Fail-open: a mail problem must never hold up the ledger. */
	private static function mail_invoice( $uid, $day ) {
		$u = get_userdata( (int) $uid );
		if ( ! $u || ! $u->user_email ) { return; }
		$inv = Data::one( 'SELECT * FROM ' . Data::t( 'aq_invoices' ) . ' WHERE user_id = %d AND day = %s', [ $uid, $day ] );
		if ( ! $inv ) { return; }
		$free  = self::is_free( $uid );
		$lines = Data::all(
			'SELECT kind, tier, secs, tokens, total_usd, coins, note FROM ' . Data::t( 'aq_usage' )
			. ' WHERE user_id = %d AND ended >= %d AND ended < %d ORDER BY id ASC LIMIT 200',
			[ $uid, strtotime( $day . ' 00:00:00 UTC' ), strtotime( $day . ' 00:00:00 UTC' ) + DAY_IN_SECONDS ] );
		$body = [];
		foreach ( $lines as $l ) {
			$body[] = sprintf( '%-7s %-11s %5ds  %8s ₳  %s',
				$l['kind'], $l['tier'], (int) $l['secs'], number_format( (float) $l['coins'], 4 ), $l['note'] );
		}
		$sent = Mailer::send( 'usage_invoice', $u->user_email, [
			'name'   => $u->display_name,
			'day'    => $day,
			'items'  => (int) $inv['items'],
			'total'  => number_format( (float) $inv['total_coins'], 4 ),
			'usd'    => number_format( (float) $inv['total_usd'], 4 ),
			'free'   => $free ? 'yes' : 'no',
			'lines'  => implode( "\n", $body ),
			'balance' => number_format( (float) Economy::coin_balance( $uid ), 4 ),
		] );
		if ( $sent ) { Data::update( 'aq_invoices', [ 'sent' => Data::now() ], [ 'id' => (int) $inv['id'] ] ); }
	}
}
