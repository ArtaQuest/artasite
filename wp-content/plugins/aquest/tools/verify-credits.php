<?php
/**
 * verify-credits.php — the six places an ArtaCredit or a challenge pool can LOSE money, each one
 * exercised against the real code and asserted on real values. Prints one PASS/FAIL line per claim
 * and exits NON-ZERO on any failure, so it can gate a merge:
 *
 *   studio wp eval "require WP_PLUGIN_DIR.'/aquest/tools/verify-credits.php';"   # exit 0 = green
 *
 * Last run 2026-08-04: 92 assertions, all green, exit 0 — twice back to back, with zero residue in
 * every table it writes and every global counter identical to where it started. That run was NOT
 * against the shared dev site but against a COPY of it, which is the safer way to gate a merge and
 * takes one command more: boot WordPress with core from the Studio checkout, WP_CONTENT_DIR pointed
 * at a scratch directory whose plugins/ symlinks the branch under test, and DB_DIR pointed at a `cp`
 * of wp-content/database/.ht.sqlite. Nothing the harness does can then reach anyone else's data.
 *
 * The last line is also machine-readable — `CREDITS_MONEY=GREEN` or `CREDITS_MONEY=RED (n failures)`,
 * plus `[n skipped]` — so a gate that cannot see the exit code can still read the verdict. A SKIP is
 * never a pass: it names an environment that cannot exercise the case (see below).
 *
 * What it proves, in order:
 *   1. A credit grant is idempotent — redeem() twice grants once: one grant row, one fund debit,
 *      one pool bump, one backing bump, and not a single coin minted.
 *   2. A redemption cannot be double-spent. The bucket lock is held by a stand-in "other request"
 *      and redeem() must refuse and move nothing; released, the SAME call succeeds (so the refusal
 *      was the lock, not luck). Then the gift is exhausted and a third member is refused. The CAS
 *      underneath is checked structurally too: a raw duplicate INSERT on (ch_id, user_id) must be
 *      REJECTED by the unique key, in both aq_nb_entries and aq_credit_grants.
 *   3. widen() moves a stranded gift exactly once — one zero-sum ledger pair, one successor gift —
 *      and the second call is refused (409) rather than paying a second time. TWO donors' gifts sit
 *      in the scratch slice, so the release is also held to moving only its OWN unspent money: a
 *      slice earmark is shared, and a release that carried the bucket balance would carry away the
 *      other donor's gift with it.
 *   4. Settlement of a challenge with an EMPTY BOARD refunds every entry fee that was actually paid,
 *      never pays a member who never paid, and never stamps the pool settled-and-unpaid. A replayed
 *      settlement pass (the state re-opened, as a crashed pass would leave it) refunds NOTHING more.
 *   5. Settlement of a TIE distributes the whole pool to the coin — pool 15 over 4 tied entries pays
 *      4/4/4/3, the remainder one each to the earliest entries, exactly as /challenges publishes the
 *      rule — and a replayed pass pays nobody twice.
 *   6. Every ref used above nets to zero after a refund, no ledger row was UPDATEd or DELETEd (the
 *      rows this run wrote are re-read byte for byte, and so is the pre-existing ledger tail), and
 *      Credits::verify_credits() reports no check that was passing before this run and is not now.
 *
 * ── IT NEEDS A LIVE DATABASE, and says so ───────────────────────────────────────────────────────
 * Every case here is a money path across four tables and two projection counters; there is no test
 * harness in this project and a mock would prove nothing about the SQL that actually moves the
 * money. So this runs against a real WordPress (Studio locally). It is written for the DEV database:
 * it creates scratch rows, asserts, and removes every one of them (cleanup runs FIRST as well, so an
 * aborted run leaves nothing behind). Two things it therefore cannot show you:
 *   - TRUE concurrency. Only one process runs, so "two concurrent attempts" is modelled two ways:
 *     by HOLDING the real lock while a redemption tries to pass it (case 2), and by exercising the
 *     claim primitives a race would collide on — the UNIQUE keys under redeem()'s two inserts, and
 *     the compare-and-swap UPDATE under widen(). A genuine two-process race is never staged, and
 *     case 3 in particular cannot distinguish the CAS from the courtesy read in front of it (see
 *     the mutation list below, where deleting the CAS leaves this file green).
 *   - The MySQL publish-guard path. Case 5 needs published works on the board, and on MySQL the
 *     publish-guard trigger rightly refuses an INSERT of a published row without the author's
 *     sig-bound confirmation. The harness will NOT forge one: it detects the refusal and prints
 *     SKIP with the reason. Case 5 therefore runs on the SQLite dev database and is skipped on a
 *     trigger-backed host. A skip is loud and is not counted as a pass.
 *
 * ── WHY THESE ASSERTIONS CAN FAIL (a test that cannot fail is worse than no test) ────────────────
 * Each claim is a number read back from the tables, not "no exception was thrown". Every mutation
 * below was INJECTED into a throwaway copy of the plugin and RUN against a copy of the dev database,
 * and what is recorded is what happened — not what ought to have happened:
 *   - make Credits::claim() return true whatever the UNIQUE key said  → RED, 10 assertions, case 1
 *     (a second grant, a second fund debit, a doubled pool, and grants ≠ spends at the end).
 *   - read the refund amount from `$c['fee']` instead of the ledger in ch_refund_all  → RED, case 4
 *     (the entrant who never paid is handed coins; staked 9, refunded 12).
 *   - settle an empty board without calling ch_refund_all at all  → RED, case 4 (staked 9, refunded
 *     0 — settled-and-unpaid, the irreversible burn this case exists for).
 *   - hand the whole remainder to the first winner  → RED, case 5 (6/3/3/3, not 4/4/4/3).
 *   - refund by UPDATEing the fee row instead of appending a compensating credit  → RED, case 6
 *     (this run's own coin-ledger fingerprint moves).
 * And one that does NOT go red, which is worth more than the five that do:
 *   - delete the compare-and-swap from Credits::widen  → still GREEN. TWO gates stand in front of a
 *     double release: widen()'s courtesy read of `widened`, and the CAS inside the lock. A repeat
 *     CLICK is caught by the read, so one process can never tell the two apart; the CAS is there for
 *     two requests that both read `widened = 0` before either writes, and no single-process harness
 *     can stage that. Case 3 therefore probes the CAS as a PRIMITIVE (does the claiming UPDATE
 *     affect exactly one row, then none?) and says so at the assertion. Do not read case 3's green
 *     as "the compare-and-swap works" — read it as "the courtesy gate and the primitive both do".
 *
 * ── WHAT IT WRITES, AND HOW IT GIVES IT BACK ────────────────────────────────────────────────────
 * Scratch users 770000-770099 (it aborts if a real account holds an id in that range), a scratch
 * slice earmark `crd_hm_x` (HM, Heard Island and McDonald Islands — a real ISO 3166-1 code, so
 * bucket() keeps it, and uninhabited, so no member can ever state it and be matched into it — the
 * earlier `zz` was unassigned and since 2026-08-18 collapses to the general slice), four gifts,
 * four challenges and five notebooks. Cleanup deletes exactly those rows and
 * walks the two projection counters (coins_issued, backing_mg) and every fund bucket back by exactly
 * what it removed. Deleting ledger rows is forbidden in the platform and stays forbidden — this is a
 * harness removing its OWN scratch rows, the same discipline verify-creator-split.php uses, and it
 * is the assertions above that hold the production code to append-only.
 *
 * TWO effects it does NOT undo, both on someone else's rows, both named here rather than hidden:
 *   - Settlement is triggered the way production triggers it, by READING /challenges, and settle_due()
 *     takes every challenge whose moon has passed — not only the scratch ones. So a real challenge
 *     already past its deadline settles (or refunds) a few seconds earlier than the next page view
 *     would have settled it. Same code, same lock, same result; only the clock differs. Run it on
 *     dev, as intended, and it is nobody's money.
 *   - The general slice earmark `crd_x_x_x` is a REAL bucket shared with real donors. The harness
 *     seeds one control gift into it and moves the released gift into it, then subtracts exactly
 *     those refs back out. It never resets the bucket, and never touches a row it did not write.
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }

global $wpdb;

$fail = 0;
$skip = 0;
$ok = function ( $cond, $label, $detail = '' ) use ( &$fail ) {
	echo ( $cond ? 'PASS  ' : 'FAIL  ' ) . $label . ( $cond ? '' : '  -- ' . $detail ) . "\n";
	if ( ! $cond ) { $fail++; }
	return (bool) $cond;
};
$skipped = function ( $label, $why ) use ( &$skip ) {
	echo 'SKIP  ' . $label . '  -- ' . $why . "\n";
	$skip++;
};
$red = function ( $why ) {
	echo 'FAIL  precondition  -- ' . $why . "\n\nCREDITS_MONEY=RED (precondition)\n";
	exit( 1 );
};

// ── preconditions ───────────────────────────────────────────────────────────────────────────────

\AQ\Notebook::ensure_tables();
foreach ( [ 'aq_credit_gifts', 'aq_credit_grants', 'aq_nb_challenges', 'aq_nb_entries', 'aq_notebooks',
	'aq_fund_ledger', 'aq_coin_ledger', 'aq_counters', 'aq_notifications' ] as $tbl ) {
	// get_var returns null on a failed query and '0' on an empty table — the two must not be confused.
	$prev  = $wpdb->suppress_errors( true );
	$probe = $wpdb->get_var( 'SELECT COUNT(*) FROM ' . \AQ\Data::t( $tbl ) );
	$wpdb->suppress_errors( $prev );
	if ( $probe === null ) { $red( 'table ' . $tbl . ' is missing — install/migrate the schema first' ); }
}

$LO = 770000;
$HI = 770099;
if ( (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->users} WHERE ID BETWEEN %d AND %d", $LO, $HI ) ) ) {
	$red( 'a real account holds an id in the scratch range ' . $LO . '-' . $HI . ' — cleanup deletes by that range, so refusing to run' );
}

$DONOR = 770001;              // owns every scratch gift
$M1    = 770002;              // redeems entry 1 of the scratch gift
$M2    = 770003;              // redeems entry 2, after losing the lock race
$M3    = 770004;              // arrives once the gift is exhausted
$M4    = 770005;              // the match() control member (never redeems)
$FEE   = 2;                   // <= Credits::FEE_CAP
$CAP   = (int) \AQ\Credits::FEE_CAP;
$CENTS = (int) \AQ\Credits::cents_for( $FEE );
if ( $CENTS < 1 ) { $red( 'cents_for(' . $FEE . ') is 0 — the coin price oracle is unset AND the floor is gone; every fund debit would silently be a no-op' ); }

// The price of ONE COIN in cents, frozen exactly as Extra::stripe_session freezes it onto a gift.
// Every scratch gift below is minted at this rate, because a gift's stored promise is
// entries = cents ÷ (unit_cents × fee_cap) — a guarantee priced at the CAP, not at the fee actually
// charged — and widen() re-derives the successor's promise with that same formula. A harness that
// invented `unit_cents = cents ÷ entries` (the intuitive reading, and the wrong one) would be
// testing a row shape the platform never writes, and would read widen()'s correct answer as a bug.
$UNIT       = max( 1, (int) round( (float) \AQ\Economy::coin_price()['sell'] * 100 ) );
$GIFT_CENTS = 2 * $UNIT * $CAP;   // what a 2-entry gift costs its donor
$SEED_SLICE = 2 * $GIFT_CENTS;    // TWO donors' gifts share one slice earmark (that is the point)
$SEED_GEN   = $UNIT * $CAP;       // the 1-entry control gift, in the general slice

// Built through production code so the key can never drift. The scratch slice is Heard Island and
// McDonald Islands (HM) — a real ISO 3166-1 code, so bucket() keeps it (anything not in
// Verify::COUNTRIES collapses to the general slice, which would make every slice-vs-general
// assertion below compare one bucket with itself), and an uninhabited territory, so no member can
// ever state it and be matched into the harness's earmark. Two axes since 2026-08-18: nationality
// and age band; the old middle (gender) segment is gone.
$B_SLICE = \AQ\Credits::bucket( 'hm', 'x' );
$B_GEN   = \AQ\Credits::bucket( 'x', 'x' );

// ── cleanup (runs first, and again at the end) ───────────────────────────────────────────────────

$cleanup = function () use ( $wpdb, $LO, $HI, $B_SLICE ) {
	$G = \AQ\Data::t( 'aq_credit_gifts' );
	$R = \AQ\Data::t( 'aq_credit_grants' );
	$L = \AQ\Data::t( 'aq_fund_ledger' );
	$C = \AQ\Data::t( 'aq_coin_ledger' );

	// The fund refs this harness can ever have written: its own seed, one `credit:<ch>:<uid>` spend
	// per scratch grant, one `widen:<gift>` pair per scratch gift. Summed per bucket BEFORE the rows
	// go, so the projection counter is walked back by exactly what is being removed — the general
	// bucket is shared with real donors, so a blanket reset would destroy their money.
	$refs = [ 'crdtest:seed' ];
	foreach ( $wpdb->get_results( $wpdb->prepare( "SELECT ch_id, user_id FROM $R WHERE user_id BETWEEN %d AND %d", $LO, $HI ), ARRAY_A ) ?: [] as $g ) {
		$refs[] = 'credit:' . (int) $g['ch_id'] . ':' . (int) $g['user_id'];
	}
	foreach ( $wpdb->get_col( $wpdb->prepare( "SELECT id FROM $G WHERE donor_id BETWEEN %d AND %d", $LO, $HI ) ) ?: [] as $gid ) {
		$refs[] = 'widen:' . (int) $gid;
	}
	$ph = implode( ',', array_fill( 0, count( $refs ), '%s' ) );
	foreach ( $wpdb->get_results( $wpdb->prepare( "SELECT bucket, COALESCE(SUM(cents),0) c FROM $L WHERE ref IN ($ph) GROUP BY bucket", $refs ), ARRAY_A ) ?: [] as $r ) {
		\AQ\Economy::counter_add( 'fund_' . (string) $r['bucket'], -(int) $r['c'] );
	}
	$wpdb->query( $wpdb->prepare( "DELETE FROM $L WHERE ref IN ($ph)", $refs ) );

	// Coins. coins_issued moves by the scratch users' NET (fees, refunds, prizes and the harness's own
	// mints all count); backing_mg by what actually bought gold — the harness's mints plus the one
	// add_backing(fee) redeem() does per grant.
	$net    = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COALESCE(SUM(delta),0) FROM $C WHERE user_id BETWEEN %d AND %d", $LO, $HI ) );
	$minted = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COALESCE(SUM(delta),0) FROM $C WHERE user_id BETWEEN %d AND %d AND reason = %s", $LO, $HI, 'crdtest' ) );
	$bought = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COALESCE(SUM(fee),0) FROM $R WHERE user_id BETWEEN %d AND %d", $LO, $HI ) );
	if ( $net ) { \AQ\Economy::counter_add( 'coins_issued', -$net ); }
	if ( $minted + $bought ) { \AQ\Economy::counter_add( 'backing_mg', -( $minted + $bought ) ); }
	$wpdb->query( $wpdb->prepare( "DELETE FROM $C WHERE user_id BETWEEN %d AND %d", $LO, $HI ) );

	$wpdb->query( $wpdb->prepare( "DELETE FROM $R WHERE user_id BETWEEN %d AND %d", $LO, $HI ) );
	$wpdb->query( $wpdb->prepare( "DELETE FROM $G WHERE donor_id BETWEEN %d AND %d", $LO, $HI ) );
	$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . \AQ\Data::t( 'aq_nb_entries' ) . ' WHERE user_id BETWEEN %d AND %d', $LO, $HI ) );
	$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . \AQ\Data::t( 'aq_nb_challenges' ) . ' WHERE creator_id BETWEEN %d AND %d', $LO, $HI ) );
	$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . \AQ\Data::t( 'aq_notebooks' ) . ' WHERE slug LIKE %s', $wpdb->esc_like( 'aq-test-credits-' ) . '%' ) );
	$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . \AQ\Data::t( 'aq_notifications' ) . ' WHERE user_id BETWEEN %d AND %d', $LO, $HI ) );

	// The scratch slice's projection row, once it is back at zero: a stray `fund_crd_hm_x` would
	// stand in the public books as a slice nobody ever gave to.
	$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . \AQ\Data::t( 'aq_counters' ) . ' WHERE name = %s AND value = 0', 'fund_' . $B_SLICE ) );

	// Rate-limit windows, so the harness is re-runnable back to back (widen allows 10/hour).
	for ( $u = $LO; $u <= $LO + 40; $u++ ) {
		delete_transient( 'aq_rl_' . md5( 'credits_widen|' . $u ) );
	}
	\AQ\Economy::release_lock( 'crdbucket_' . $B_SLICE );
};
$cleanup();

// ── fingerprints (case 6's append-only proof) ────────────────────────────────────────────────────

$fp = function ( $table, $ids ) use ( $wpdb ) {
	if ( ! $ids ) { return '0:'; }
	$ph   = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
	$rows = $wpdb->get_results( $wpdb->prepare( "SELECT * FROM $table WHERE id IN ($ph) ORDER BY id", $ids ), ARRAY_A ) ?: [];
	return count( $rows ) . ':' . md5( (string) wp_json_encode( $rows ) );
};
$tail = function ( $table ) use ( $wpdb ) {
	return array_map( 'intval', $wpdb->get_col( "SELECT id FROM $table ORDER BY id DESC LIMIT 200" ) ?: [] );
};
$CL         = \AQ\Data::t( 'aq_coin_ledger' );
$FL         = \AQ\Data::t( 'aq_fund_ledger' );
$tail_coin  = $tail( $CL );
$tail_fund  = $tail( $FL );
$tail_coin0 = $fp( $CL, $tail_coin );
$tail_fund0 = $fp( $FL, $tail_fund );

$reserve0 = \AQ\Economy::verify_reserve();
$base_bad = [];
foreach ( \AQ\Credits::verify_credits() as $c ) { if ( empty( $c['ok'] ) ) { $base_bad[] = (string) $c['check']; } }
if ( $base_bad ) {
	echo "NOTE  the credit books were ALREADY inconsistent before this run: " . implode( ', ', $base_bad ) . "\n";
	echo "      case 6 only fails on checks this run broke — repair these separately\n";
}

echo 'publish-guard: ' . (string) get_option( 'aq_publish_guard', 'unknown' )
	. '   scratch ids: ' . $LO . '-' . $HI . '   fee: ' . $FEE . ' = ' . $CENTS . "c\n\n";

// ── scaffolding helpers ─────────────────────────────────────────────────────────────────────────

$now      = \AQ\Data::now();
$moon     = $now + 30 * DAY_IN_SECONDS;   // far future: nothing settles until the harness says so
$mk_ch    = function ( $creator, $fee ) use ( $moon, $now ) {
	return (int) \AQ\Data::insert( 'aq_nb_challenges', [
		'creator_id' => $creator, 'kind' => 'dataset', 'topic' => 'Statistics',
		'title' => 'ArtaCredits harness challenge', 'fee' => $fee, 'deadline' => $moon,
		'pool' => 0, 'state' => 'open', 'created' => $now,
	] );
};
$mk_entry = function ( $ch, $uid, $nb ) use ( $now ) {
	return (bool) \AQ\Data::upsert( 'aq_nb_entries', [ 'ch_id' => $ch, 'user_id' => $uid ], [ 'nb_id' => $nb, 'created' => $now ] );
};
/** A gift in the shape production actually writes (Extra::stripe_session → fulfil_session): the
 *  money is entries × unit × fee_cap, `unit_cents` is the price of one COIN, and the promise is a
 *  guarantee at the cap. Anything else is a row the platform never mints.
 *
 *  Each gift gets its OWN ref. aq_credit_gifts is UNIQUE on (ref, bucket) — one payment may fund
 *  several slices, but never two gifts to the SAME slice — so two scratch gifts sharing one ref in
 *  one slice is a row the database rightly refuses, and the harness would have been silently testing
 *  a slice with one gift in it. (Found by running this; the schema note at Schema.php:539 says so.) */
$gift_n   = 0;
$mk_gift  = function ( $donor, $bucket, $entries, $cap ) use ( $now, $UNIT, &$gift_n ) {
	$gift_n++;
	return (int) \AQ\Data::insert( 'aq_credit_gifts', [
		'donor_id' => $donor, 'bucket' => $bucket, 'cents' => $entries * $UNIT * $cap, 'entries' => $entries,
		'unit_cents' => $UNIT, 'fee_cap' => $cap,
		'donor_name' => 'Harness Donor', 'ref' => 'crdtest:gift' . $gift_n, 'widened' => 0, 'created' => $now,
	] );
};
/** Mint coins the way a purchase does — with the gold that backs them — so a fee debit below never
 *  overdraws a wallet and trips the overdraft canary for a reason the harness invented. */
$mint = function ( $uid, $coins ) {
	\AQ\Economy::credit_coins( $uid, $coins, 'crdtest', 'crdtest:mint:' . $uid . ':' . \AQ\Data::now() );
	\AQ\Economy::add_backing( $coins );
};
/** Pay an entry fee exactly as Notebook::ch_enter does: the ledger ref, then the pool bump. */
$pay_fee = function ( $ch, $uid, $fee ) {
	\AQ\Economy::credit_coins( $uid, -$fee, 'chfee', 'chfee:' . $ch . ':' . $uid );
	\AQ\Data::bump( 'aq_nb_challenges', [ 'id' => $ch ], 'pool', $fee );
};
$ch_row   = function ( $id ) { return \AQ\Data::one( 'SELECT * FROM ' . \AQ\Data::t( 'aq_nb_challenges' ) . ' WHERE id = %d', [ $id ] ); };
$fund_of  = function ( $bucket ) { return (int) \AQ\Economy::counter( 'fund_' . $bucket ); };
$ref_sum  = function ( $reason, $ref ) {
	return (int) \AQ\Data::col( 'SELECT COALESCE(SUM(delta),0) FROM ' . \AQ\Data::t( 'aq_coin_ledger' ) . ' WHERE reason = %s AND ref = %s', [ $reason, $ref ] );
};
$ref_rows = function ( $ref ) {
	return (int) \AQ\Data::col( 'SELECT COUNT(*) FROM ' . \AQ\Data::t( 'aq_fund_ledger' ) . ' WHERE ref = %s', [ $ref ] );
};

// The donor's own session, for widen() — Rest::uid() reads the current user, and a scratch id has no
// account behind it. Assigning the id onto a WP_User is enough for get_current_user_id(); nothing in
// the paths under test reads anything else off the user object. Restored at the end.
$prev_user = $GLOBALS['current_user'] ?? null;
$as_user   = function ( $uid ) { $u = new \WP_User(); $u->ID = (int) $uid; $GLOBALS['current_user'] = $u; };

// Seed the two earmarks through the real donation append, so the counter projection is maintained by
// production code rather than by the harness. uid 0 earns no donate points (award_points bails).
\AQ\Funds::record_donation( 0, $SEED_SLICE, $B_SLICE, 'ArtaCredits harness seed', 'crdtest:seed' );
\AQ\Funds::record_donation( 0, $SEED_GEN, $B_GEN, 'ArtaCredits harness seed', 'crdtest:seed' );

$CH_A = $mk_ch( 770010, $FEE );
$mk_entry( $CH_A, 770011, 0 );
$mk_entry( $CH_A, 770012, 0 );   // MIN_FIELD: two entrants who are neither the member nor the founder
$GIFT_G = $mk_gift( $DONOR, $B_SLICE, 2, $CAP );   // spent in cases 1-2
$GIFT_W = $mk_gift( $DONOR, $B_SLICE, 2, $CAP );   // never spent; released in case 3
$GIFT_P = $mk_gift( $DONOR, $B_GEN, 1, $CAP );     // the match() control; never redeemed
if ( ! $CH_A || ! $GIFT_G || ! $GIFT_W || ! $GIFT_P ) { $red( 'could not create the scratch challenge/gifts' ); }
// The seed must be in the SCRATCH slice: record_donation quietly falls back to the general bursary
// bucket if it does not recognise the key, and every figure below would then be measuring the wrong
// earmark. Assert it landed rather than assume the regex still admits crd_ keys.
$ok( $SEED_SLICE === (int) \AQ\Economy::counter( 'fund_' . $B_SLICE ), 'setup: the scratch earmark holds both gifts\' money, and only that',
	\AQ\Economy::counter( 'fund_' . $B_SLICE ) . ' vs ' . $SEED_SLICE );
$gift_g = \AQ\Data::one( 'SELECT * FROM ' . \AQ\Data::t( 'aq_credit_gifts' ) . ' WHERE id = %d', [ $GIFT_G ] );
$ch_a   = $ch_row( $CH_A );

// ── 1. a credit grant is idempotent ─────────────────────────────────────────────────────────────

echo "1. a credit grant is idempotent by ref\n";
$fund_before   = $fund_of( $B_SLICE );
$issued_before = (int) \AQ\Economy::counter( 'coins_issued' );
$back_before   = (int) \AQ\Economy::counter( 'backing_mg' );

$g1 = (int) \AQ\Credits::redeem( $M1, $ch_a, $FEE, $gift_g, 0 );
$g2 = (int) \AQ\Credits::redeem( $M1, $ch_a, $FEE, $gift_g, 0 );

$grant = \AQ\Data::one( 'SELECT * FROM ' . \AQ\Data::t( 'aq_credit_grants' ) . ' WHERE ch_id = %d AND user_id = %d', [ $CH_A, $M1 ] );
$spent = (int) ( $grant['cents'] ?? 0 );
$ok( $g1 > 0, 'redeem: the first call grants', 'returned ' . $g1 );
$ok( 0 === $g2, 'redeem: the second call is refused', 'returned ' . $g2 . ' (a second grant)' );
$ok( 1 === (int) \AQ\Data::col( 'SELECT COUNT(*) FROM ' . \AQ\Data::t( 'aq_credit_grants' ) . ' WHERE ch_id = %d AND user_id = %d', [ $CH_A, $M1 ] ),
	'redeem: exactly ONE grant row' );
$ok( 1 === (int) \AQ\Data::col( 'SELECT COUNT(*) FROM ' . \AQ\Data::t( 'aq_nb_entries' ) . ' WHERE ch_id = %d AND user_id = %d', [ $CH_A, $M1 ] ),
	'redeem: exactly ONE entry row' );
$ok( 1 === $ref_rows( 'credit:' . $CH_A . ':' . $M1 ), 'redeem: exactly ONE fund debit for the ref' );
$ok( $fund_of( $B_SLICE ) === $fund_before - $spent, 'redeem: the earmark fell by the grant\'s own cents, once',
	$fund_of( $B_SLICE ) . ' vs ' . ( $fund_before - $spent ) );
$ok( (int) $ch_row( $CH_A )['pool'] === $FEE, 'redeem: the pool grew by the fee, once', (string) $ch_row( $CH_A )['pool'] );
$ok( (int) \AQ\Economy::counter( 'backing_mg' ) === $back_before + $FEE, 'redeem: gold bought once for the coins that pool will mint' );
$ok( (int) \AQ\Economy::counter( 'coins_issued' ) === $issued_before, 'redeem: NOT ONE COIN minted to the member' );
$ok( 0 === \AQ\Economy::coin_balance( $M1 ), 'redeem: the member\'s wallet is untouched', (string) \AQ\Economy::coin_balance( $M1 ) );

// ── 2. no double-spend under contention ─────────────────────────────────────────────────────────

echo "\n2. a redemption cannot be double-spent\n";
$lock = 'crdbucket_' . $B_SLICE;
$held = \AQ\Economy::acquire_lock( $lock, 15 );
$ok( $held, 'the harness can stand in for a concurrent request (took the bucket lock)' );
$fund_locked = $fund_of( $B_SLICE );
$blocked     = (int) \AQ\Credits::redeem( $M2, $ch_a, $FEE, $gift_g, 0 );
$ok( 0 === $blocked, 'redeem refuses while another request holds the earmark lock', 'granted ' . $blocked );
$ok( $fund_of( $B_SLICE ) === $fund_locked, 'nothing left the earmark on the refused call' );
$ok( 0 === (int) \AQ\Data::col( 'SELECT COUNT(*) FROM ' . \AQ\Data::t( 'aq_nb_entries' ) . ' WHERE ch_id = %d AND user_id = %d', [ $CH_A, $M2 ] ),
	'no entry was claimed on the refused call' );
\AQ\Economy::release_lock( $lock );

// The control: the SAME call, lock free, must succeed — so the refusal above was the lock and not
// some other gate quietly swallowing the request.
$won = (int) \AQ\Credits::redeem( $M2, $ch_a, $FEE, $gift_g, 0 );
$ok( $won > 0, 'the same call succeeds once the lock is free (the refusal WAS the lock)', 'returned ' . $won );

// The gift promised two entries and has now paid two. A third member gets nothing.
$fund_spent = $fund_of( $B_SLICE );
$third      = (int) \AQ\Credits::redeem( $M3, $ch_a, $FEE, $gift_g, 0 );
$ok( 0 === $third, 'an exhausted gift pays nobody', 'granted ' . $third );
$ok( $fund_of( $B_SLICE ) === $fund_spent, 'nothing left the earmark for the exhausted gift' );
$ok( 2 === (int) \AQ\Data::col( 'SELECT COUNT(*) FROM ' . \AQ\Data::t( 'aq_credit_grants' ) . ' WHERE gift_id = %d', [ $GIFT_G ] ),
	'the gift paid exactly the 2 entries it promised' );
// Read the spend back from the GRANT ROWS rather than assuming 2 × the first grant: the coin price
// is an option and a redemption is priced at the moment it happens, so the two entries need not
// cost the same cent figure. What must hold is that the earmark fell by exactly what the grants say.
$spent_g = (int) \AQ\Data::col( 'SELECT COALESCE(SUM(cents),0) FROM ' . \AQ\Data::t( 'aq_credit_grants' ) . ' WHERE gift_id = %d', [ $GIFT_G ] );
$ok( $fund_of( $B_SLICE ) === $fund_before - $spent_g, 'the earmark fell by exactly what the two grants record — no more, no less',
	$fund_of( $B_SLICE ) . ' vs ' . ( $fund_before - $spent_g ) );

// The CAS itself: Data::upsert reports "I created this row" only because a UNIQUE key refuses the
// second insert. dbDelta can silently drop an index, and then a real two-process race would insert
// twice and pay twice — so prove the key is THERE by trying a duplicate insert directly.
foreach ( [ 'aq_nb_entries' => [ 'ch_id' => $CH_A, 'user_id' => $M1, 'nb_id' => 0, 'created' => $now ],
	'aq_credit_grants' => [ 'ch_id' => $CH_A, 'user_id' => $M1, 'gift_id' => $GIFT_G, 'fee' => $FEE, 'cents' => $spent, 'created' => $now ] ] as $tbl => $row ) {
	$prev = $wpdb->suppress_errors( true );
	$dupe = $wpdb->insert( \AQ\Data::t( $tbl ), $row );
	$wpdb->suppress_errors( $prev );
	if ( $dupe ) { $wpdb->delete( \AQ\Data::t( $tbl ), [ 'id' => (int) $wpdb->insert_id ] ); }
	$ok( false === $dupe, 'UNIQUE (ch_id, user_id) refuses a duplicate on ' . $tbl,
		'the index is MISSING — the compare-and-swap has no teeth and two racing requests would both claim' );
}

// ── 3. a stranded gift moves exactly once ───────────────────────────────────────────────────────

echo "\n3. widen() releases a stranded gift once, and only once\n";
$as_user( $DONOR );
$gen_before   = $fund_of( $B_GEN );
$slice_before = $fund_of( $B_SLICE );      // still holds BOTH donors' gifts, less the two entries spent
$req = new WP_REST_Request( 'POST', '/aq/v1/credits/widen' );
$req->set_param( 'id', $GIFT_W );
$out = \AQ\Credits::widen( $req );

$ok( is_array( $out ) && ! empty( $out['ok'] ), 'widen: the donor\'s release is accepted',
	is_object( $out ) ? wp_json_encode( $out->get_data() ) : wp_json_encode( $out ) );
$moved = is_array( $out ) ? (int) ( $out['moved_cents'] ?? 0 ) : 0;
// A slice earmark is SHARED by every donor who chose that slice, so "what this gift holds" and "what
// the bucket holds" are different numbers — releasing the bucket balance would carry away the other
// donor's gift. The released amount must be this gift's own unspent book value, and the slice must
// still hold the first gift's untouched share afterwards.
$ok( $moved === $GIFT_CENTS, 'widen: it moved this gift\'s OWN unspent money', $moved . ' vs ' . $GIFT_CENTS );
$ok( $slice_before > $moved, 'widen: (control) the shared earmark held MORE than this one gift, so the clamp is under test',
	$slice_before . ' vs ' . $moved );
$slice_after = $fund_of( $B_SLICE );
$ok( $slice_after === $slice_before - $moved, 'widen: the slice kept the OTHER donor\'s gift — a release is not a raid on the shared earmark',
	$slice_after . ' vs ' . ( $slice_before - $moved ) );
$ok( $slice_after === $GIFT_CENTS - $spent_g, 'widen: what stays is exactly the first gift\'s unspent share',
	$slice_after . ' vs ' . ( $GIFT_CENTS - $spent_g ) );
$ok( $fund_of( $B_GEN ) === $gen_before + $moved, 'widen: the general slice holds it now',
	$fund_of( $B_GEN ) . ' vs ' . ( $gen_before + $moved ) );
$ok( 2 === $ref_rows( 'widen:' . $GIFT_W ), 'widen: one zero-sum PAIR of appends, not a rewrite', (string) $ref_rows( 'widen:' . $GIFT_W ) );
$ok( 0 === (int) \AQ\Data::col( 'SELECT COALESCE(SUM(cents),0) FROM ' . \AQ\Data::t( 'aq_fund_ledger' ) . ' WHERE ref = %s', [ 'widen:' . $GIFT_W ] ),
	'widen: the pair sums to exactly 0 — no money created or destroyed' );
$succ = \AQ\Data::all( 'SELECT * FROM ' . \AQ\Data::t( 'aq_credit_gifts' ) . ' WHERE ref = %s AND id <> %d', [ 'widen:' . $GIFT_W, $GIFT_W ] );
$ok( 1 === count( $succ ), 'widen: exactly ONE successor gift', (string) count( $succ ) );
// The promise is re-derived from the money that actually moved, at the rate the donor was quoted:
// nothing was spent from this gift, so the successor must still guarantee both entries — and it can
// never promise more than the cents behind it can pay for.
$want_entries = max( 1, intdiv( $moved, $UNIT * $CAP ) );
$ok( $succ && (string) $succ[0]['bucket'] === $B_GEN && (int) $succ[0]['entries'] === $want_entries && (int) $succ[0]['cents'] === $moved,
	'widen: the successor carries the whole remaining promise (' . $want_entries . ' entries) into the general slice', $succ ? wp_json_encode( $succ[0] ) : '-' );
$ok( 2 === $want_entries, 'widen: an untouched 2-entry gift is still worth 2 entries after the release', (string) $want_entries );
$ok( (int) \AQ\Data::col( 'SELECT widened FROM ' . \AQ\Data::t( 'aq_credit_gifts' ) . ' WHERE id = %d', [ $GIFT_W ] ) > 0,
	'widen: the original is stamped, so it stops matching' );

$again = \AQ\Credits::widen( $req );
$code  = is_object( $again ) && method_exists( $again, 'get_status' ) ? (int) $again->get_status() : 0;
$ok( 409 === $code, 'widen: the second release is REFUSED (409)', 'status ' . $code );
$ok( 2 === $ref_rows( 'widen:' . $GIFT_W ), 'widen: the refusal appended nothing', (string) $ref_rows( 'widen:' . $GIFT_W ) );
$ok( $fund_of( $B_SLICE ) === $slice_after && $fund_of( $B_GEN ) === $gen_before + $moved, 'widen: no second payment',
	$fund_of( $B_SLICE ) . '/' . $fund_of( $B_GEN ) . ' vs ' . $slice_after . '/' . ( $gen_before + $moved ) );
$ok( 1 === count( \AQ\Data::all( 'SELECT id FROM ' . \AQ\Data::t( 'aq_credit_gifts' ) . ' WHERE ref = %s AND id <> %d', [ 'widen:' . $GIFT_W, $GIFT_W ] ) ),
	'widen: no second successor gift' );

// THE CAS ITSELF, probed directly — because the refusal above does NOT prove it. Two gates stand in
// front of a double release: widen()'s COURTESY read (`if ( $g['widened'] > 0 )`) and, inside the
// lock, the compare-and-swap. A repeat CLICK is caught by the read, which is why deleting the CAS
// and re-running this file still prints green (verified, by doing exactly that). The CAS is for the
// case a single process cannot stage: two requests that BOTH read widened = 0 before either writes.
// So prove the primitive the winner-picking rests on, the same way the UNIQUE-key probe above does.
// wpdb::update returns rows AFFECTED; a driver returning rows MATCHED would hand both racers a 1
// and release one gift's money twice.
$cas_gift = $mk_gift( $DONOR, $B_SLICE, 1, $CAP );   // no money seeded behind it: this probe is structural
$cas_one  = \AQ\Data::update( 'aq_credit_gifts', [ 'widened' => $now ], [ 'id' => $cas_gift, 'widened' => 0 ] );
$cas_two  = \AQ\Data::update( 'aq_credit_gifts', [ 'widened' => $now + 1 ], [ 'id' => $cas_gift, 'widened' => 0 ] );
$ok( 1 === (int) $cas_one, 'widen CAS: the claim on an unstamped gift affects exactly ONE row (the racer that wins)', var_export( $cas_one, true ) );
$ok( 0 === (int) $cas_two, 'widen CAS: the second claim affects NO rows — the racer that loses releases nothing', var_export( $cas_two, true ) );
$ok( $now === (int) \AQ\Data::col( 'SELECT widened FROM ' . \AQ\Data::t( 'aq_credit_gifts' ) . ' WHERE id = %d', [ $cas_gift ] ),
	'widen CAS: the winner\'s stamp stands — the loser did not overwrite it' );

// match() is a pure read, so its gates can be checked against a live control without spending
// anything. The control must MATCH, or the three refusals below prove nothing.
$as_user( $M4 );
$control = \AQ\Credits::match( $M4, $ch_a, $FEE );
if ( $ok( null !== $control, 'match: the control member is offered a gift (the positive control)',
	'no live gift in ' . $B_GEN . ' — the gates below cannot be distinguished from "nothing to give"' ) ) {
	$ok( null === \AQ\Credits::match( $M4, $ch_a, \AQ\Credits::FEE_CAP + 1 ), 'match: refuses a fee over FEE_CAP' );
	$ok( null === \AQ\Credits::match( (int) $ch_a['creator_id'], $ch_a, $FEE ), 'match: never pays the founder\'s own entry' );
	$empty = $mk_ch( 770013, $FEE );
	$ok( null === \AQ\Credits::match( $M4, $ch_row( $empty ), $FEE ), 'match: never SEEDS a field (MIN_FIELD entrants required)' );
}

// Every fund row this run has written — the two seeds, the two credit debits and the release pair.
// Cases 4-6 write no fund rows at all, so this fingerprint must survive to the end unchanged: it is
// what would catch a release that REWROTE the gift's original append instead of appending beside it.
// (The pre-existing tail is fingerprinted separately, at the top; these are the rows born this run.)
$fund_refs = [ 'crdtest:seed', 'credit:' . $CH_A . ':' . $M1, 'credit:' . $CH_A . ':' . $M2, 'widen:' . $GIFT_W ];
$fund_ids  = array_map( 'intval', $wpdb->get_col( $wpdb->prepare(
	"SELECT id FROM $FL WHERE ref IN (%s,%s,%s,%s) ORDER BY id", $fund_refs ) ) ?: [] );
$fund_fp   = $fp( $FL, $fund_ids );
$ok( 6 === count( $fund_ids ), 'the money so far is SIX fund appends: 2 seeds, 2 credit debits, 1 release pair',
	count( $fund_ids ) . ' rows — a money move wrote more (or fewer) rows than it should' );

// ── 4. an empty board refunds every fee ─────────────────────────────────────────────────────────

echo "\n4. settlement with an empty board refunds every fee\n";
$B_FEE = 3;
$CH_B  = $mk_ch( 770020, $B_FEE );
$paid  = [ 770021, 770022, 770023 ];
foreach ( $paid as $u ) {
	$mint( $u, $B_FEE );
	$mk_entry( $CH_B, $u, 0 );      // nb_id 0 => nothing published => an empty board at the moon
	$pay_fee( $CH_B, $u, $B_FEE );
}
$FREE = 770024;                      // an entry whose fee debit never landed: it must NOT be refunded
$mk_entry( $CH_B, $FREE, 0 );

// ── 5. a tie splits the pool to the coin ────────────────────────────────────────────────────────
// The integrity sweep rides feed reads and would (correctly) demote the scratch "published" rows
// below, which carry no author confirmation — mid-run that would turn the tie into an empty board.
// Hold it off for the few seconds this takes, using the production code's OWN throttle transient —
// but only if it is not already held, and give it back at the end, so the harness never lengthens
// the window in which a real illegitimate publish would go unswept.
$sweep_held = (bool) get_transient( 'aq_nb_integrity_ran' );
if ( ! $sweep_held ) { set_transient( 'aq_nb_integrity_ran', 1, 2 * MINUTE_IN_SECONDS ); }

$C_FEE  = 3;
$CH_C   = $mk_ch( 770030, $C_FEE );
$tied   = [ 770031, 770032, 770033, 770034 ];
$unpub  = 770035;
$tie_ok = true;
foreach ( array_merge( $tied, [ $unpub ] ) as $u ) {
	$status = $u === $unpub ? 'draft' : 'published';
	$slug   = 'aq-test-credits-' . $u;
	// Suppressed: on a trigger-backed host the publish-guard REFUSES this insert, which is the right
	// answer and is read back below — it must not spray a DB error through the report.
	$prev = $wpdb->suppress_errors( true );
	\AQ\Data::insert( 'aq_notebooks', [
		'author_id' => $u, 'kind' => 'dataset', 'slug' => $slug,
		'title' => 'ArtaCredits harness work ' . $u, 'status' => $status, 'hearts' => 7,
		'created' => $now, 'updated' => $now, 'published_at' => $now,
	] );
	$wpdb->suppress_errors( $prev );
	// Read the row back BY ITS SLUG (unique), never by Data::insert's return. That return is
	// $wpdb->insert_id, and wpdb leaves insert_id at its PREVIOUS value when a query errors — so a
	// publish-guard refusal here hands back the id of the last thing this run inserted, in whatever
	// table. Trusting it would bind a STRANGER'S published notebook onto the scratch board, and
	// settlement would pay that author real coins out of a pool the cleanup below never reaches.
	$row = \AQ\Data::one( 'SELECT id, status FROM ' . \AQ\Data::t( 'aq_notebooks' ) . ' WHERE slug = %s', [ $slug ] );
	$nb  = (int) ( $row['id'] ?? 0 );
	if ( ! $nb || (string) $row['status'] !== $status ) {
		$tie_ok = false;
		$nb     = 0;   // entered with nothing rather than with somebody else's work
	}
	$mint( $u, $C_FEE );
	$mk_entry( $CH_C, $u, $nb );
	$pay_fee( $CH_C, $u, $C_FEE );
}
// 5 fees of 3 = a pool of 15; only the 4 published works stand on the board.
$POOL_C = 5 * $C_FEE;
// Read the pool back before anything settles. Case 5's expected split (4/4/4/3) is arithmetic ON this
// number, so if a fee never landed the split assertions would fail with a misleading story about the
// remainder rule. Assert the premise where it can still be seen.
$ok( $POOL_C === (int) $ch_row( $CH_C )['pool'], 'setup: the tie pool holds all five staked fees',
	$ch_row( $CH_C )['pool'] . ' vs ' . $POOL_C );

// Every coin row this run has written so far, fingerprinted: settlement must APPEND beside them and
// never touch one of them (case 6).
$mine_ids = array_map( 'intval', $wpdb->get_col( $wpdb->prepare( "SELECT id FROM $CL WHERE user_id BETWEEN %d AND %d ORDER BY id", $LO, $HI ) ) ?: [] );
$mine_fp  = $fp( $CL, $mine_ids );

// Now, and only now, put both deadlines in the past — so no concurrent read can settle either
// challenge while its fees are still being staked.
\AQ\Data::update( 'aq_nb_challenges', [ 'deadline' => $now - 3600 ], [ 'id' => $CH_B ] );
\AQ\Data::update( 'aq_nb_challenges', [ 'deadline' => $now - 3600 ], [ 'id' => $CH_C ] );

$settle = function () {
	// The production trigger: settlement rides every /challenges read, inside the nbsettle lock, and
	// takes 12 due challenges a pass — so drain rather than assume one pass reaches ours.
	for ( $i = 0; $i < 6; $i++ ) { \AQ\Notebook::challenges(); }
};
$lock_held = (int) $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", 'aq_lock_nbsettle' ) );
if ( $lock_held > 0 && time() - $lock_held < 120 ) {
	$skipped( 'cases 4 and 5', 'another process holds the nbsettle lock — settlement cannot run here' );
} else {
	$settle();
	$cb = $ch_row( $CH_B );
	$r  = \AQ\Data::dec( $cb['results'] ?? '' ) ?: [];
	$ok( 'settled' === (string) $cb['state'], 'empty board: the challenge is settled', (string) $cb['state'] );
	$ok( 0 === (int) $cb['pool'], 'empty board: the pool holds nothing now', (string) $cb['pool'] );
	$ok( (int) ( $r['staked'] ?? -1 ) === 3 * $B_FEE, 'empty board: the record states what was staked', wp_json_encode( $r ) );
	$ok( (int) ( $r['refunded'] ?? -1 ) === 3 * $B_FEE, 'empty board: every staked coin was refunded', wp_json_encode( $r ) );
	$ok( (int) ( $r['paid'] ?? -1 ) === 0, 'empty board: nothing was paid as a prize' );
	$ok( (int) ( $r['refunded'] ?? -1 ) === (int) ( $r['staked'] ?? -2 ),
		'empty board: NEVER settled-and-unpaid — refunded == staked', wp_json_encode( $r ) );
	foreach ( $paid as $u ) {
		$fee_ref = 'chfee:' . $CH_B . ':' . $u;
		$ref_ref = 'chrefund:' . $CH_B . ':' . $u;
		$ok( $ref_sum( 'refund', $ref_ref ) === $B_FEE, 'empty board: u' . $u . ' got exactly their fee back', (string) $ref_sum( 'refund', $ref_ref ) );
		$ok( 0 === $ref_sum( 'chfee', $fee_ref ) + $ref_sum( 'refund', $ref_ref ), 'empty board: u' . $u . '\'s refs net to zero' );
		$ok( $B_FEE === \AQ\Economy::coin_balance( $u ), 'empty board: u' . $u . '\'s wallet is whole again', (string) \AQ\Economy::coin_balance( $u ) );
	}
	$ok( 0 === $ref_sum( 'refund', 'chrefund:' . $CH_B . ':' . $FREE ), 'empty board: the entrant who never PAID is not paid out',
		'refund read from the challenge fee instead of the ledger' );
	$ok( 0 === \AQ\Economy::coin_balance( $FREE ), 'empty board: that entrant\'s balance is still 0' );

	// A crashed pass leaves the challenge open with the refunds already written. Replay it.
	$before_rows = (int) \AQ\Data::col( 'SELECT COUNT(*) FROM ' . $CL . ' WHERE reason = %s AND ref LIKE %s', [ 'refund', $wpdb->esc_like( 'chrefund:' . $CH_B . ':' ) . '%' ] );
	\AQ\Data::update( 'aq_nb_challenges', [ 'state' => 'open' ], [ 'id' => $CH_B ] );
	$settle();
	$r2 = \AQ\Data::dec( $ch_row( $CH_B )['results'] ?? '' ) ?: [];
	$ok( (int) ( $r2['refunded'] ?? -1 ) === 0, 'empty board REPLAY: the second pass refunds nothing more', wp_json_encode( $r2 ) );
	$ok( $before_rows === (int) \AQ\Data::col( 'SELECT COUNT(*) FROM ' . $CL . ' WHERE reason = %s AND ref LIKE %s', [ 'refund', $wpdb->esc_like( 'chrefund:' . $CH_B . ':' ) . '%' ] ),
		'empty board REPLAY: not one extra refund row' );
	foreach ( $paid as $u ) {
		$ok( $B_FEE === \AQ\Economy::coin_balance( $u ), 'empty board REPLAY: u' . $u . ' was not paid twice', (string) \AQ\Economy::coin_balance( $u ) );
	}

	echo "\n5. a tie splits the whole pool, to the coin\n";
	if ( ! $tie_ok ) {
		$skipped( 'case 5', 'this host refuses an INSERT of a published row (publish-guard triggers) and the harness will not forge an author confirmation — run it on the SQLite dev database' );
	} else {
		$cc    = $ch_row( $CH_C );
		$r     = \AQ\Data::dec( $cc['results'] ?? '' ) ?: [];
		$board = $r['board'] ?? [];
		$ok( 'settled' === (string) $cc['state'], 'tie: the challenge is settled', (string) $cc['state'] );
		$ok( 4 === count( $board ), 'tie: the board froze the 4 PUBLISHED entries (the draft is not on it)', (string) count( $board ) );
		// The published rule: an even split, and coins that will not divide go one each to the
		// earliest entries. 15 over 4 is 4/4/4/3 — never 6/3/3/3, and never 3/3/3/3 with 3 lost.
		$want  = [ 4, 4, 4, 3 ];
		$total = 0;
		foreach ( $tied as $i => $u ) {
			$got = $ref_sum( 'chprize', 'chprize:' . $CH_C . ':' . $u );
			$total += $got;
			$ok( $got === $want[ $i ], 'tie: entry ' . ( $i + 1 ) . ' (u' . $u . ') was paid ' . $want[ $i ], (string) $got );
		}
		$ok( $total === $POOL_C, 'tie: the WHOLE pool was distributed — not a coin lost', $total . ' of ' . $POOL_C );
		$ok( (int) ( $r['paid'] ?? -1 ) === $POOL_C, 'tie: the record agrees with the ledger', wp_json_encode( $r['paid'] ?? null ) );
		$ok( 0 === $ref_sum( 'chprize', 'chprize:' . $CH_C . ':' . $unpub ), 'tie: the unpublished entry won nothing' );
		$places = array_map( static function ( $b ) { return (int) $b['place']; }, $board );
		$ok( [ 1, 1, 1, 1 ] === $places, 'tie: every co-winner is place 1 on the frozen board (what their certificate prints)', wp_json_encode( $places ) );
		$prizes = array_map( static function ( $b ) { return (int) $b['prize']; }, $board );
		$ok( $want === $prizes, 'tie: the frozen board carries each share', wp_json_encode( $prizes ) );
		// Only meaningful if the reserve was whole to begin with — a pre-existing hole is somebody
		// else's bug and this run must not report it as its own.
		$ok( ! $reserve0['ok'] || \AQ\Economy::verify_reserve()['ok'], 'tie: the full-reserve invariant survives the minting',
			wp_json_encode( \AQ\Economy::verify_reserve() ) );

		$bal = [];
		foreach ( $tied as $u ) { $bal[ $u ] = \AQ\Economy::coin_balance( $u ); }
		\AQ\Data::update( 'aq_nb_challenges', [ 'state' => 'open' ], [ 'id' => $CH_C ] );
		$settle();
		$same = true;
		foreach ( $tied as $u ) { if ( $bal[ $u ] !== \AQ\Economy::coin_balance( $u ) ) { $same = false; } }
		$ok( $same, 'tie REPLAY: a retried settlement pays nobody twice', wp_json_encode( $bal ) );
		$ok( 4 === (int) \AQ\Data::col( 'SELECT COUNT(*) FROM ' . $CL . ' WHERE reason = %s AND ref LIKE %s', [ 'chprize', $wpdb->esc_like( 'chprize:' . $CH_C . ':' ) . '%' ] ),
			'tie REPLAY: still exactly 4 prize rows' );
	}
}

// ── 6. append-only, and the books still balance ─────────────────────────────────────────────────

echo "\n6. the ledgers are append-only and the refs net to zero\n";
$ok( $mine_fp === $fp( $CL, $mine_ids ), 'no coin-ledger row written by this run was UPDATEd or DELETEd — refunds and prizes were APPENDED',
	'a fee or mint row changed under settlement' );
$ok( $fund_fp === $fp( $FL, $fund_ids ), 'no fund-ledger row written by this run was UPDATEd or DELETEd — the release APPENDED a pair beside them',
	'a seed or debit row changed after it was written' );
$ok( $tail_coin0 === $fp( $CL, $tail_coin ), 'the pre-existing coin ledger is byte-identical' );
$ok( $tail_fund0 === $fp( $FL, $tail_fund ), 'the pre-existing fund ledger is byte-identical' );
$ok( count( $mine_ids ) === (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM $CL WHERE id IN (" . implode( ',', array_fill( 0, max( 1, count( $mine_ids ) ), '%d' ) ) . ')', $mine_ids ?: [ 0 ] ) ),
	'every coin row this run wrote is still there' );

$now_bad = [];
foreach ( \AQ\Credits::verify_credits() as $c ) {
	if ( empty( $c['ok'] ) && ! in_array( (string) $c['check'], $base_bad, true ) ) { $now_bad[] = (string) $c['check'] . ' (projected ' . $c['projected'] . ' vs ledger ' . $c['ledger'] . ')'; }
}
$ok( ! $now_bad, 'Credits::verify_credits(): every counter, floor and zero-sum check the run touched holds', implode( '; ', $now_bad ) );

// ── give it all back ────────────────────────────────────────────────────────────────────────────

$cleanup();
if ( ! $sweep_held ) { delete_transient( 'aq_nb_integrity_ran' ); }   // hand the sweep's own throttle back
if ( $prev_user === null ) { unset( $GLOBALS['current_user'] ); } else { $GLOBALS['current_user'] = $prev_user; }

$reserve1 = \AQ\Economy::verify_reserve();
$ok( $reserve1['issued'] === $reserve0['issued'] && $reserve1['backing'] === $reserve0['backing'],
	'cleanup: coins issued and gold backing are back to where they started', wp_json_encode( [ $reserve0, $reserve1 ] ) );
$ok( 0 === $fund_of( $B_SLICE ) && 0 === (int) \AQ\Data::col( 'SELECT COUNT(*) FROM ' . $FL . ' WHERE bucket = %s', [ $B_SLICE ] ),
	'cleanup: the scratch earmark is gone from the books' );
$ok( 0 === (int) \AQ\Data::col( 'SELECT COUNT(*) FROM ' . \AQ\Data::t( 'aq_credit_grants' ) . ' WHERE user_id BETWEEN %d AND %d', [ $LO, $HI ] ),
	'cleanup: no scratch grant survives' );

echo "\n" . ( 0 === $fail ? 'CREDITS_MONEY=GREEN' : 'CREDITS_MONEY=RED (' . $fail . ' failures)' )
	. ( $skip ? ' [' . $skip . ' skipped]' : '' ) . "\n";
exit( $fail > 0 ? 1 : 0 );
