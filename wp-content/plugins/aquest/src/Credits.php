<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ARTACREDITS (2026-08-03) — a donor pays a stranger's challenge entry fee.
 *
 * A donor gives to a SLICE of the membership (nationality · age band). The gift lands in
 * the public fund as a `crd_<cty>_<band>` earmark. When a member of that slice tries to enter a
 * challenge and is short the fee, we OFFER them the credit — naming the donor and the slice — and
 * they accept, or don't. Accepting pays their fee from the fund and puts the donor's name on their
 * Certificate of Participation.
 *
 * ── THE MONEY (why no coin is ever minted) ──────────────────────────────────────────────────────
 * A redeemed credit NEVER touches the member's wallet. It does exactly what Funds::bursary_apply
 * already does for a course seat (Funds.php:385-393), which is the proven pattern here:
 *     pool  += fee          (the challenge's pot grows, as if the member had paid)
 *     backing += fee        (gold bought, so the coins that pot will MINT at the moon stay backed)
 *     fund  -= cents        (the donated CAD leaves the fund — it has been spent)
 * There is no `+fee` mint and no compensating `-fee` burn, so `coins_issued` never moves, the
 * full-reserve invariant (backing >= coins_issued) is never even transiently broken, and there is
 * no window in which a failed second write leaves the member holding coin they were never given.
 * The entrant pays nothing and receives nothing spendable: the credit buys ONE entry, nothing else.
 *
 * ── WHAT SERIALISES IT ──────────────────────────────────────────────────────────────────────────
 * The contended resource is the EARMARK, not the member and not the gift: two members racing for the
 * last of one slice's money hold different `wallet_u<uid>` locks and would both pass an unlocked
 * balance check, and a per-gift lock is no better because many gifts share one `crd_<slice>` bucket
 * (see redeem()). Every read-then-write below runs under `crdbucket_<bucket>` (Economy::acquire_lock
 * — the same atomic option-INSERT primitive `wallet_u*` and `nbsettle` use). The grant row is written ONCE, by
 * self::claim() — a bare INSERT under a UNIQUE key, so the DATABASE picks the winner, the loser
 * writes nothing at all, and a row that records money is never inserted-then-deleted or rewritten.
 * The release (widen) claims the same way: a compare-and-swap on `widened` decides who releases a
 * gift, before a cent moves.
 *
 * ── WHAT STOPS A MEMBER FARMING IT ──────────────────────────────────────────────────────────────
 * A challenge's fee is chosen by its founder and a sole entrant takes the whole pool at the moon,
 * so an unguarded credit is a direct "stranger's donation -> my wallet" pipe. Four gates close it:
 *   1. A credit never pays the entry of the member who FOUNDED the challenge.
 *   2. A credit never SEEDS a field — the challenge must already hold another member's entry.
 *   3. A credit is never offered to an API TOKEN. Publication-grade consent is a human act, and a
 *      token cannot see the donor's name it would be accepting (Api::via_token).
 *   4. Nationality / birthday are freely-rewritable self-claims (Verify::set_identity), so a facet
 *      only matches once it has been SETTLED for SETTLE_DAYS. Rewriting your nationality to reach a
 *      waiting gift buys you a month's wait, not a gift.
 * Plus MOON_CAP credit-funded entries per member per synodic month, and FEE_CAP on any one entry.
 *
 * ── WHAT IS PUBLIC (the database is public — say it plainly) ────────────────────────────────────
 * Accepting a credit writes `aq_credit_grants(gift_id, ch_id, user_id)` — public, like everything.
 * A reader who follows gift_id learns the slice the gift was given for, which is a fact about the
 * member. That is disclosed in the offer, before they accept, in words. The `bucket` is deliberately
 * NOT duplicated onto the grant row: it stays one hop away on the gift, so no single public row
 * states a member's nationality and age together beside their user id.
 * Nothing anywhere records that a member WANTS to be sponsored — there is no standing flag to read.
 *
 * ── THE AXES, AND WHEN THEY CHANGED ────────────────────────────────────────────────────────────
 * Launched 2026-08-03 with three axes (nationality · gender · age band). On 2026-08-11 the operator
 * removed nationality from the platform, leaving gender · age. On 2026-08-18 the operator reversed
 * that and went further: nationality is back (asked at sign-up, defaulted from the visitor's
 * country, shown as a flag, checked by the blue check) and GENDER IS GONE from the platform — no
 * field, no route, no meta. The bucket key was re-shaped to two segments at the same time; it could
 * be, because aq_credit_gifts, aq_credit_grants and every crd_ earmark were EMPTY on production when
 * this shipped (checked 2026-08-18 through the public /db and /foundation/finances). bucket_words()
 * still reads the old three-segment key, in case a development database holds one.
 *
 * NATIONALITY MATCHES ON THE STATED CLAIM, ONCE SETTLED — not on the blue check. The 08-03 design
 * required a VERIFIED nationality, which today would make every country slice reach nobody (very
 * few members hold the check) and turn the reach meter into a wall of zeros. The claim is what the
 * flag on the profile shows, it is stated at sign-up by every member, and SETTLE_DAYS is the same
 * defence the age band relies on. What a credit buys — ONE entry of at most FEE_CAP coins, MOON_CAP
 * times a moon, never the founder's own, never into a field of fewer than MIN_FIELD — bounds what a
 * false claim could ever be worth.
 */
final class Credits {

	/** Age bands, low edge => label. '13' is the under-18 band: derived for matching, NEVER offered
	 *  to a donor (see SLICE_BANDS) — no adult stranger targets a child by age or nationality. */
	const BANDS = [ '13' => 'Under 18', '18' => '18–24', '25' => '25–34', '35' => '35–49', '50' => '50–64', '65' => '65 and over' ];

	/** The bands a donor may choose. */
	const SLICE_BANDS = [ '18', '25', '35', '50', '65' ];

	const ANY        = 'x';   // the "no preference" value on every axis
	const FEE_CAP    = 5;     // ₳ — the largest single entry fee one credit will cover
	const MIN_FIELD  = 2;     // entrants who are neither the member nor the founder, before a credit joins
	const MOON_CAP   = 2;     // credit-funded entries one member may accept per synodic month
	const REACH_MIN  = 5;     // never publish a member count below this — report "fewer than 5"
	const SETTLE_DAYS = 30;   // an identity facet must be unchanged this long before it matches
	const SYNODIC_S  = 2551443;

	// ── the slice ───────────────────────────────────────────────────────────

	/** A slice's fund bucket: crd_<cty>_<band>, each axis 'x' when unrestricted. `cty` is a
	 *  lower-cased ISO 3166-1 alpha-2 nationality; anything that is not one of Verify::COUNTRIES
	 *  collapses to ANY here, at the ONE place a bucket key is ever built, so the minting side
	 *  (Extra::course_checkout), the matching side (buckets_for_user) and the reach meter agree by
	 *  construction — a client cannot mint a gift into a slice no member can ever be matched to.
	 *  Max 9 chars — comfortably inside aq_fund_ledger.bucket VARCHAR(24) and the aq_counters.name
	 *  VARCHAR(40) that carries it as 'fund_<bucket>'. */
	public static function bucket( $cty, $band ) {
		$cty  = strtolower( preg_replace( '/[^A-Za-z]/', '', (string) $cty ) );
		$band = (string) $band;
		if ( ! Verify::valid_country( $cty ) ) { $cty = self::ANY; }
		if ( ! in_array( $band, self::SLICE_BANDS, true ) ) { $band = self::ANY; }
		return 'crd_' . $cty . '_' . $band;
	}

	/** A slice in words, for the offer, the certificate and the donate page — never a raw bucket key.
	 *  "members in Iran aged 25–34" · "members in Iran" · "members aged 25–34" · "any member of ArtaQuest". */
	public static function slice_words( $cty, $band ) {
		$out = 'members';
		if ( Verify::valid_country( (string) $cty ) ) {
			$out .= ' in ' . self::country_name( $cty );
		}
		if ( in_array( (string) $band, self::SLICE_BANDS, true ) ) {
			$out .= ' aged ' . strtolower( self::BANDS[ $band ] );
		}
		if ( $out === 'members' ) { return 'any member of ArtaQuest'; }
		return $out;
	}

	/** Words for a stored bucket key. Reads the current crd_<cty>_<band> shape and, so a development
	 *  database written before 2026-08-18 still renders, the old crd_<cty>_<gender>_<band> shape —
	 *  whose gender segment is simply not said (the axis no longer exists). */
	public static function bucket_words( $bucket ) {
		$p = explode( '_', (string) $bucket );
		if ( count( $p ) === 3 ) { return self::slice_words( $p[1], $p[2] ); }
		if ( count( $p ) === 4 ) { return self::slice_words( $p[1], $p[3] ); }
		return 'any member of ArtaQuest';
	}

	/** ISO-2 => English country name, from the same table the rest of the platform uses. */
	public static function country_name( $iso ) {
		static $map = null;
		if ( $map === null ) {
			$map  = [];
			$file = ( defined( 'AQ_DIR' ) ? AQ_DIR : __DIR__ . '/..' ) . '/data/countries.tsv';
			foreach ( @file( $file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES ) ?: [] as $line ) {
				$c = explode( "\t", $line );
				if ( count( $c ) >= 2 ) { $map[ strtolower( trim( $c[0] ) ) ] = trim( $c[1] ); }
			}
		}
		return $map[ strtolower( (string) $iso ) ] ?? strtoupper( (string) $iso );
	}

	/** The selectable countries (ISO-2 + English name), for API consumers of credits/options — every
	 *  code in Verify::COUNTRIES, i.e. exactly what bucket() will honour; the SPA renders the same
	 *  codes localized from lib/flags.ts. No member counts — publishing "Iran · 2 members" beside a
	 *  money bucket is a targeting oracle AND a disclosure. */
	public static function countries() {
		static $out = null;
		if ( $out !== null ) { return $out; }
		$out = [];
		foreach ( explode( ' ', Verify::COUNTRIES ) as $iso ) {
			$out[] = [ 'iso' => $iso, 'name' => self::country_name( $iso ) ];
		}
		return $out;
	}

	// ── a member's own facets ───────────────────────────────────────────────

	/** The age band a birthday falls in ('' when unset/unreadable). Derived, never stored. */
	public static function age_band( $uid ) {
		$b = Verify::birthday( (int) $uid );
		if ( ! preg_match( '/^(\d{4})-(\d{2})-(\d{2})$/', (string) $b, $m ) ) { return ''; }
		$age = (int) gmdate( 'Y' ) - (int) $m[1];
		if ( (int) gmdate( 'md' ) < (int) ( $m[2] . $m[3] ) ) { $age--; }
		if ( $age < 0 || $age > 130 ) { return ''; }
		if ( $age < 18 ) { return '13'; }
		if ( $age < 25 ) { return '18'; }
		if ( $age < 35 ) { return '25'; }
		if ( $age < 50 ) { return '35'; }
		if ( $age < 65 ) { return '50'; }
		return '65';
	}

	/** Has this facet been SETTLED long enough to match? Identity fields are freely rewritable, so a
	 *  facet changed inside SETTLE_DAYS is treated as undisclosed for matching. A member who has
	 *  always said who they are is unaffected; one who just rewrote it to reach a waiting gift is not
	 *  matched. A missing stamp means the value predates stamping — settled by definition. */
	private static function settled( $uid, $meta ) {
		$at = (int) get_user_meta( (int) $uid, $meta . '_at', true );
		return $at <= 0 || ( Data::now() - $at ) >= self::SETTLE_DAYS * DAY_IN_SECONDS;
	}

	/** Every bucket a member is eligible for, MOST SPECIFIC FIRST — so a gift aimed precisely at them
	 *  is spent before a general one, which is what the donor meant. A member under 18 matches ONLY
	 *  the unrestricted bucket: no gift that names a nationality or an age band can ever reach a child.
	 *
	 *  The nationality is the member's STATED claim (Verify::claimed_country — the same value the flag
	 *  on their profile shows), counted only once it has stood for SETTLE_DAYS; see the class doc for
	 *  why the claim and not the blue check. A member who has stated none is matched by every gift
	 *  that names no country. */
	public static function buckets_for_user( $uid ) {
		$uid  = (int) $uid;
		$band = self::age_band( $uid );
		if ( $band === '13' ) { return [ self::bucket( self::ANY, self::ANY ) ]; }

		$cty = self::settled( $uid, 'aq_nationality' ) ? strtolower( Verify::claimed_country( $uid ) ) : '';
		if ( ! self::settled( $uid, 'aq_birthday' ) ) { $band = ''; }

		$ctys = $cty !== '' ? [ $cty, self::ANY ] : [ self::ANY ];
		$bnds = $band !== '' ? [ $band, self::ANY ] : [ self::ANY ];

		$out = [];
		foreach ( $ctys as $c ) {
			foreach ( $bnds as $b ) { $out[] = self::bucket( $c, $b ); }
		}
		// $ctys/$bnds are each [specific, any], so the natural nesting above already runs
		// most-specific -> least; usort on the count of 'x' axes makes that explicit and stable.
		usort( $out, static function ( $a, $b ) {
			$ax = substr_count( $a, '_x' ); $bx = substr_count( $b, '_x' );
			return $ax === $bx ? strcmp( $a, $b ) : $ax - $bx;
		} );
		return array_values( array_unique( $out ) );
	}

	// ── matching + redemption ───────────────────────────────────────────────

	/**
	 * The gift that would pay THIS member's entry to THIS challenge, or null. Pure read: it decides
	 * nothing and writes nothing, so the SPA can show the offer before the member commits.
	 * $ch is the aq_nb_challenges row.
	 */
	public static function match( $uid, $ch, $fee ) {
		$uid = (int) $uid;
		$fee = (int) $fee;
		if ( $fee < 1 || $fee > self::FEE_CAP ) { return null; }
		if ( Api::via_token() ) { return null; }                                   // gate 3 — consent is a human act
		if ( (int) $ch['creator_id'] === $uid ) { return null; }                   // gate 1 — never the founder's own entry
		// Gate 2 — a credit joins a REAL field, never seeds one. The founder's own entry does not
		// count: "at least one other entrant" was satisfied by the founder alone, so two colluding
		// accounts (one founds at a high fee, the other enters on a stranger's credit) were a pipe
		// from a donor's gift into a cashable pool the pair controlled. It needs MIN_FIELD entrants
		// who are neither this member nor the founder.
		$others = (int) Data::col(
			'SELECT COUNT(*) FROM ' . Data::t( 'aq_nb_entries' ) . ' WHERE ch_id = %d AND user_id <> %d AND user_id <> %d',
			[ (int) $ch['id'], $uid, (int) $ch['creator_id'] ] );
		if ( $others < self::MIN_FIELD ) { return null; }
		if ( self::used_this_moon( $uid ) >= self::MOON_CAP ) { return null; }

		// An entry that prices at NOTHING must never be offered. The earmark test at the foot of this
		// function is `held >= cost`, which EVERY empty bucket passes when the cost is 0 — so a zero
		// price would hand out entries no donor ever paid for, and redeem's debit would be a silent
		// no-op (Funds::spend_credit refuses a non-negative amount). Economy::coin_price floors the
		// spot price, so this can only fire on a misconfigured spread; it is money, so it is checked.
		$cents = self::cents_for( $fee );
		if ( $cents < 1 ) { return null; }

		$buckets = self::buckets_for_user( $uid );
		if ( ! $buckets ) { return null; }
		$in = implode( ',', array_fill( 0, count( $buckets ), '%s' ) );
		// Exhaustion is tested IN the query, so LIMIT only ever counts LIVE gifts — a growing tail of
		// spent gifts can never crowd a live one out of the window and silently kill the feature.
		$G = Data::t( 'aq_credit_gifts' );
		$R = Data::t( 'aq_credit_grants' );
		$rows = Data::all(
			"SELECT g.* FROM $G g
			 LEFT JOIN ( SELECT gift_id, COUNT(*) AS used FROM $R GROUP BY gift_id ) u ON u.gift_id = g.id
			 WHERE g.bucket IN ($in) AND g.fee_cap >= %d AND g.widened = 0 AND COALESCE(u.used,0) < g.entries
			 ORDER BY g.id ASC LIMIT 60",
			array_merge( $buckets, [ $fee ] ) );
		if ( ! $rows ) { return null; }

		// Prefer the most specific bucket the member matches (donor intent), then the oldest gift.
		$rank = array_flip( $buckets );
		usort( $rows, static function ( $a, $b ) use ( $rank ) {
			$ra = $rank[ $a['bucket'] ] ?? 99; $rb = $rank[ $b['bucket'] ] ?? 99;
			return $ra === $rb ? ( (int) $a['id'] - (int) $b['id'] ) : $ra - $rb;
		} );
		foreach ( $rows as $g ) {
			// The earmark must still hold the money this entry costs (a gift's promised `entries` is
			// quoted at the gold rate on the day it was captured; the coin price moves).
			if ( Economy::counter( 'fund_' . $g['bucket'] ) >= $cents ) { return $g; }
		}
		return null;
	}

	/** Credit-funded entries this member has accepted inside the last synodic month. */
	public static function used_this_moon( $uid ) {
		return (int) Data::col(
			'SELECT COUNT(*) FROM ' . Data::t( 'aq_credit_grants' ) . ' WHERE user_id = %d AND created >= %d',
			[ (int) $uid, Data::now() - self::SYNODIC_S ] );
	}

	/** What ₳fee costs the fund today, in cents, at the live sell price. */
	public static function cents_for( $fee ) {
		return (int) round( (int) $fee * (float) Economy::coin_price()['sell'] * 100 );
	}

	/**
	 * Claim a row that may exist at most ONCE — insert-only, and never a rewrite of one already there.
	 * Both tables it is used on carry the UNIQUE key that decides the winner, so a losing racer (or a
	 * retry) touches nothing and gets false back.
	 *
	 * Data::upsert returns the same false, but it UPDATES the row it found first — which on a money
	 * record is the wrong answer twice over: on aq_credit_grants it re-points a grant that has ALREADY
	 * been paid at whichever gift matched this time, un-counting the spend from the gift that actually
	 * funded it (so widen() would then release money that is long gone), and on aq_nb_entries it swaps
	 * the notebook a member entered with. A table we call append-only has to be append-only in the
	 * code that writes it, not merely in the one caller that happens to check first.
	 */
	private static function claim( $key, $row ) {
		global $wpdb;
		$prev = $wpdb->suppress_errors( true ); // the collision is expected, not an error to log
		$ok   = $wpdb->insert( Data::t( $key ), $row );
		$wpdb->suppress_errors( $prev );
		return (bool) $ok;
	}

	/**
	 * SPEND one entry of $gift on $uid's entry of notebook $nb_id into $ch. Returns the grant row id,
	 * or 0 if the challenge closed, the gift was exhausted, the earmark drained, the member reached
	 * MOON_CAP, or they turned out to already hold an entry — every one of which is a losing race in
	 * which NOTHING has been charged, so the caller simply falls back to the ordinary "you need ₳fee"
	 * refusal. It also returns 0 rather than trusting a fee or a founder its own gates would refuse.
	 *
	 * Runs entirely under `crdbucket_<bucket>`: the challenge's state, exhaustion, earmark balance,
	 * BOTH claims and the money are one critical section on THE CONTENDED RESOURCE, which is the
	 * EARMARK — not the member and
	 * not the gift. A per-member wallet lock cannot serialise two different members racing for the
	 * same money, and a per-GIFT lock cannot either: many gifts share one `crd_<slice>` bucket (every
	 * donor who picks that slice funds it), so two members redeeming two DIFFERENT gifts would hold
	 * two different gift locks, both read the same balance, and both debit it — driving the public
	 * fund negative. The bucket lock also covers the same-gift case, since one gift has one bucket.
	 *
	 * ORDER MATTERS. The challenge ENTRY is claimed here, inside the same section, and before any
	 * money moves — not by the caller afterwards. With the entry claimed last, a failed insert
	 * (a lock that expired mid-request, a DB error) left a donor's money spent on nothing: the fund
	 * debited, the pool bumped and no entry to show for it. Claiming first means every failure path
	 * below returns before a single cent moves, and the only surviving worst case — the grant claim
	 * failing after the entry claim succeeded — is an unpaid entry, which is exactly what the
	 * pre-existing coin path already tolerates, and is unreachable anyway (a prior grant implies a
	 * prior entry, which the entry claim would have caught).
	 */
	public static function redeem( $uid, $ch, $fee, $gift, $nb_id ) {
		$uid   = (int) $uid;
		$fee   = (int) $fee;
		$gid   = (int) $gift['id'];
		$chid  = (int) $ch['id'];
		$cents = self::cents_for( $fee );
		if ( $cents < 1 ) { return 0; } // an entry priced at nothing buys nothing — see match()
		// A method that debits the public fund must not trust its arguments. match() applied every gate
		// before handing this gift over, but it is a separate call: these two cost nothing to re-assert
		// and are the two whose absence would be worth money to a caller that skipped it — a fee above
		// the gift's own ceiling (or the platform's), and the founder cashing a stranger's gift out of
		// a pool they take at the moon. MIN_FIELD is not re-read: entries are never deleted, so a field
		// that was large enough when the offer was drawn cannot since have shrunk.
		if ( $fee < 1 || $fee > self::FEE_CAP || $fee > (int) $gift['fee_cap'] ) { return 0; }
		if ( (int) $ch['creator_id'] === $uid ) { return 0; }
		$lock  = 'crdbucket_' . (string) $gift['bucket'];
		if ( ! Economy::acquire_lock( $lock, 15 ) ) { return 0; }
		try {
			// The challenge has to be OPEN as the money moves, not merely when the offer was drawn.
			// settle_due() runs under a DIFFERENT lock (nbsettle) and pays out the pool it read, so a
			// fee bumped in just after the moon is donor money added to a pot that will never pay out
			// again — spent, and on nothing. ch_enter checked this before the member was shown the
			// offer and before they accepted it, which is two round trips ago; re-read it.
			$live = Data::one( 'SELECT state, deadline FROM ' . Data::t( 'aq_nb_challenges' ) . ' WHERE id = %d', [ $chid ] );
			if ( ! $live || (string) $live['state'] !== 'open' || (int) $live['deadline'] <= Data::now() ) { return 0; }

			$used = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_credit_grants' ) . ' WHERE gift_id = %d', [ $gid ] );
			if ( $used >= (int) $gift['entries'] ) { return 0; }
			// MOON_CAP, re-read inside the section. match() counted this member's grants before the offer
			// was drawn, and today only the caller's own `wallet_u<uid>` lock stops the same member racing
			// two entries past that count — a lock this method neither takes nor requires, and one that
			// would not serialise them anyway if they ever redeemed against two different slice earmarks.
			// The cap is what bounds how much of the donated fund one member can direct at themselves, so
			// it is re-asserted where the money actually moves.
			if ( self::used_this_moon( $uid ) >= self::MOON_CAP ) { return 0; }
			if ( Economy::counter( 'fund_' . $gift['bucket'] ) < $cents ) { return 0; }

			// Claim 1 — the entry. UNIQUE (ch_id, user_id) makes this the one row that can exist for
			// this member on this challenge, and self::claim reports true ONLY when this call created
			// it: the loser of the race writes nothing whatsoever.
			if ( ! self::claim( 'aq_nb_entries', [ 'ch_id' => $chid, 'user_id' => $uid, 'nb_id' => (int) $nb_id, 'created' => Data::now() ] ) ) {
				return 0; // already in — no money moves
			}
			// Claim 2 — the credit, on the same key.
			if ( ! self::claim( 'aq_credit_grants', [ 'ch_id' => $chid, 'user_id' => $uid, 'gift_id' => $gid, 'fee' => $fee, 'cents' => $cents, 'created' => Data::now() ] ) ) {
				return 0; // already credited on this challenge — never pay twice
			}

			// THE MONEY. The donated CAD leaves the fund FIRST, and the pot and the gold behind it move
			// only once that debit is on record — the ref makes it one effect per (challenge, member).
			// Funds::bursary_apply buys backing before it debits because it MINTS in the same breath;
			// nothing is minted here (this pool becomes coin days later, at the moon, in settle_due), so
			// the safer order is the one whose failure leaves the donor's money still in the fund rather
			// than a prize pot and a gold counter grown by money nobody ever spent. A failed debit is
			// also said out loud: the grant row cannot be un-appended, and verify_credits' grants=spends
			// check is the standing alarm for exactly this shape of break.
			if ( ! Funds::spend_credit( $gift['bucket'], -$cents, 'credit:' . $chid . ':' . $uid, 'ArtaCredit: challenge ' . $chid ) ) {
				error_log( 'AQ Credits::redeem: fund debit FAILED bucket=' . (string) $gift['bucket'] . ' ' . $cents . 'c ch=' . $chid . ' u=' . $uid . ' — grant claimed, NOTHING charged' );
				return 0;
			}
			Data::bump( 'aq_nb_challenges', [ 'id' => $chid ], 'pool', $fee );
			Economy::add_backing( $fee );
			return (int) Data::col( 'SELECT id FROM ' . Data::t( 'aq_credit_grants' ) . ' WHERE ch_id = %d AND user_id = %d', [ $chid, $uid ] );
		} finally {
			Economy::release_lock( $lock );
		}
	}

	/** The donor's name for a gift, as it prints — '' when they gave anonymously. */
	public static function donor_name( $gift ) {
		$n = trim( (string) ( $gift['donor_name'] ?? '' ) );
		return $n !== '' ? $n : '';
	}

	/**
	 * The donor's chosen name, reduced to something safe to PRINT ON A STRANGER'S permanent, publicly
	 * verifiable certificate. Returns '' (give anonymously) rather than refusing, so a payment is
	 * never blocked by this — fail-open, as everywhere else.
	 *
	 * SAY WHAT THIS IS. In production a donor name is screened by ONE thing: a CHARACTER-CLASS STRIP.
	 * No model reads it. A donor name is a NAME, so we keep only letters (any script), marks, spaces
	 * and the punctuation names actually contain, collapse runs and cut to 80 BYTES (the width of the
	 * column that has to hold it — see the cut itself for why bytes and not characters). That
	 * deterministically removes URLs, @handles, markup and slogans — prose is what a slur needs to be
	 * a slur — and it is synchronous, which is the whole reason it carries the load at checkout. It is
	 * a shape test and nothing more: a two-word insult made only of letters and a space walks straight
	 * through it, and no wording anywhere (the donate page, the schema notes) may promise otherwise.
	 *
	 * ArtaMod is CONSULTED, and is normally silent. Fearometer::score returns an ARRAY or NULL, never
	 * an int, and the live verdict is produced ASYNCHRONOUSLY by the relay batch over comments — so at
	 * checkout it is null and this pass does nothing. It is kept because it costs nothing and honours a
	 * verdict the day one exists for this field. (Comparing its return to a number, as this once did,
	 * was worse than useless: array>=int is always true in PHP and null>=int always false, so it
	 * blanked every name under the test seam and screened nothing at all in production.)
	 */
	public static function clean_donor_name( $raw ) {
		$n = trim( preg_replace( '/\s+/u', ' ', (string) $raw ) );
		if ( $n === '' ) { return ''; }
		$n = preg_replace( '/[^\p{L}\p{M}\p{Zs} .\'\x{2019}-]/u', '', $n );
		// A full stop is kept because initials use one ("J. R. R. Tolkien") — but a stop BETWEEN two
		// letters is domain shape, not name shape, and would let "spam.example" survive the strip as
		// advertising on someone else's certificate. Initials are always followed by a space or the end.
		$n = preg_replace( '/(?<=\p{L})\.(?=\p{L})/u', '', $n );
		$n = trim( preg_replace( '/\s+/u', ' ', (string) $n ) );
		// 80 BYTES, not 80 characters. `aq_credit_gifts.donor_name` is VARCHAR(80) and this value is
		// written LONG AFTER the money: fulfilment appends the donor's cents to the slice earmark first
		// and inserts the gift row second (Extra::fulfil_session), so a row the database refuses for an
		// over-long name leaves those cents in a slice with no gift to spend them and none to release
		// them — money stranded in the open books by a Persian or CJK name, which mb_substr's character
		// count would have let straight through at up to four bytes each. mb_strcut cuts on a character
		// boundary, so such a name is shortened, never mangled.
		$n = trim( mb_strcut( $n, 0, 80, 'UTF-8' ) );
		if ( $n === '' || ! preg_match( '/\p{L}/u', $n ) ) { return ''; }
		$v = class_exists( '\\AQ\\Fearometer' ) ? Fearometer::score( $n ) : null;
		if ( is_array( $v ) && (int) ( $v['fear'] ?? 0 ) >= Fearometer::limit() ) { return ''; }
		return $n;
	}

	/**
	 * Tell the donor their gift was just spent. Names the entrant and the challenge — both already
	 * public, and the whole point of the gift — but never anything about WHY this member matched:
	 * the donor chose a slice, and which facts a particular person holds is theirs to publish, not
	 * ours to report back. Idempotent per (challenge, entrant) via the ref, like every other push.
	 */
	public static function notify_donor( $gift, $entrant_id, $ch, $fee ) {
		$donor = (int) ( $gift['donor_id'] ?? 0 );
		if ( $donor < 1 || $donor === (int) $entrant_id ) { return; }
		$u    = get_userdata( (int) $entrant_id );
		$who  = $u ? $u->display_name : 'A member';
		Notify::push(
			$donor, 'donate',
			'Your ArtaCredit opened a door — ' . $who . ' entered "' . (string) $ch['title'] . '" with the ₳' . (int) $fee . ' you gave',
			'', '/donate/', 'crdspent:' . (int) $ch['id'] . ':' . (int) $entrant_id
		);
	}

	// ── routes ──────────────────────────────────────────────────────────────

	/** GET credits/options — the donor's picker vocabulary. Deliberately carries NO member counts:
	 *  a public, CDN-cached map of who is where (and which slice is holding money) is both a
	 *  targeting oracle and a disclosure. The donor sees reach for their OWN pick via credits/reach. */
	public static function options( $req = null ) {
		return [
			// Every nationality bucket() will honour (operator 2026-08-18 — the axis is back, and it
			// replaced gender, which is no longer offered anywhere). An older cached client that still
			// reads a `genders` key gets none, and renders an empty gender picker rather than crashing.
			'countries' => self::countries(),
			'bands'     => array_map( fn( $k ) => [ 'key' => $k, 'label' => self::BANDS[ $k ] ], self::SLICE_BANDS ),
			'fee_cap'   => self::FEE_CAP,
			'moon_cap'  => self::MOON_CAP,
			'reach_min' => self::REACH_MIN,
			'symbol'    => '₳',
		];
	}

	/** The birthday range (inclusive, YYYY-MM-DD) whose members fall in $band today. */
	private static function band_range( $band ) {
		$edges = [ '18' => [ 18, 24 ], '25' => [ 25, 34 ], '35' => [ 35, 49 ], '50' => [ 50, 64 ], '65' => [ 65, 130 ] ];
		if ( ! isset( $edges[ (string) $band ] ) ) { return null; }
		[ $lo, $hi ] = $edges[ (string) $band ];
		// Born on-or-before (today − lo years) ⇒ at least lo. Born on-or-after (today − (hi+1) years + 1 day) ⇒ at most hi.
		return [ gmdate( 'Y-m-d', strtotime( '-' . ( $hi + 1 ) . ' years +1 day' ) ), gmdate( 'Y-m-d', strtotime( '-' . $lo . ' years' ) ) ];
	}

	/**
	 * GET credits/reach {country,band} — how many members this slice reaches, floored to REACH_MIN
	 * so a precise pick can never count a handful of identifiable people. Honest about zero, because
	 * a donor is entitled to know their gift would sit unspent.
	 *
	 * ONE indexed query, not a walk. This used to pull up to 5,000 user ids and then call
	 * buckets_for_user() on each — a per-user meta lookup, ~5,000 round trips, on a PUBLIC unthrottled
	 * GET with thousands of distinct cacheable parameter combinations. It is now a set of joins over
	 * (meta_key, meta_value), and it encodes the SAME three rules buckets_for_user does: a facet only
	 * counts once SETTLED, the nationality is the member's stated claim, and a member under 18 is
	 * reachable ONLY by a gift that names nothing.
	 */
	public static function reach( $req ) {
		global $wpdb;
		if ( Rest::throttle( 'credits_reach', 120, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$cty  = strtolower( sanitize_key( (string) Rest::p( $req, 'country', '' ) ) );
		$band = sanitize_key( (string) Rest::p( $req, 'band', '' ) );
		$want = self::bucket( $cty, $band );
		[ , $wcty, $wband ] = explode( '_', $want );

		$um     = $wpdb->usermeta;
		$settle = Data::now() - self::SETTLE_DAYS * DAY_IN_SECONDS;
		$joins  = " FROM $um bd";
		$where  = " WHERE bd.meta_key = 'aq_birthday' AND bd.meta_value <> ''";
		// TWO arg lists, concatenated only at the end. Placeholders bind in the order they appear in
		// the finished SQL — every JOIN's, then every WHERE's — so a single list appended to in call
		// order silently binds a WHERE value into a JOIN slot as soon as one clause contributes to both.
		$jargs = [];
		$wargs = [];

		// A facet only counts when it has stood for SETTLE_DAYS (a missing stamp predates stamping).
		$settled = function ( $alias, $meta ) use ( &$joins, &$where, &$jargs, &$wargs, $um, $settle ) {
			$joins  .= " LEFT JOIN $um $alias ON $alias.user_id = bd.user_id AND $alias.meta_key = %s";
			$jargs[] = $meta . '_at';
			$where  .= " AND ( $alias.meta_value IS NULL OR CAST($alias.meta_value AS DECIMAL(20,0)) <= %d )";
			$wargs[] = $settle;
		};
		$settled( 'bs', 'aq_birthday' );

		if ( $wcty !== self::ANY ) {
			// The STATED nationality, upper-cased in storage (Verify::set_identity) and compared
			// case-insensitively anyway; settled like every other facet.
			$joins  .= " JOIN $um nt ON nt.user_id = bd.user_id AND nt.meta_key = 'aq_nationality' AND UPPER(nt.meta_value) = %s";
			$jargs[] = strtoupper( $wcty );
			$settled( 'ns', 'aq_nationality' );
		}
		if ( $wband !== self::ANY ) {
			$r       = self::band_range( $wband );
			$where  .= ' AND bd.meta_value BETWEEN %s AND %s';
			$wargs[] = $r[0]; $wargs[] = $r[1];
		} elseif ( $wcty !== self::ANY ) {
			// Any gift that NAMES something is closed to under-18s (buckets_for_user's minor rule).
			$where  .= ' AND bd.meta_value <= %s';
			$wargs[] = gmdate( 'Y-m-d', strtotime( '-18 years' ) );
		}

		$n = (int) Data::col( 'SELECT COUNT(DISTINCT bd.user_id)' . $joins . $where, array_merge( $jargs, $wargs ) );
		return [
			'bucket'  => $want,
			'words'   => self::slice_words( $wcty, $wband ),
			'exact'   => $n === 0 || $n >= self::REACH_MIN,
			'members' => $n === 0 ? 0 : ( $n >= self::REACH_MIN ? $n : self::REACH_MIN ),
			'floor'   => self::REACH_MIN,
		];
	}

	/**
	 * POST credits/widen {id} — the DONOR releases their own unspent gift to the general slice, where
	 * every member is eligible. This is the only way money aimed at a slice nobody matches can ever
	 * move: the reach meter warns before payment, but a slice can also empty afterwards, and without
	 * this the gift would sit in the open books for ever with no recourse and no refund path.
	 *
	 * Only the donor may do it, only to their own gift, only while it still holds unspent money, and
	 * only toward the general bucket — never toward another slice, because re-aiming someone else's
	 * money at a different group of people is not a release, it is a new gift.
	 *
	 * MONEY LEFT, not entries left, is the test. A gift's promised `entries` is a guarantee priced at
	 * the FEE CAP, so a gift whose entries were all spent on cheaper challenges still holds real cents
	 * — and refusing those with "used in full" left them earmarked to a slice, unreachable by match()
	 * (which only offers a gift with entries to spare) and unreleasable here. That is stranded money.
	 * The successor's promise is therefore re-derived from the cents actually released, by the same
	 * formula the donor was quoted at checkout (Extra::stripe_session: cents ÷ unit ÷ fee_cap), so it
	 * can never promise more entries than the money that moved with it can pay for — and when the
	 * residue is under a single entry it promises none, because there is no successor at all: that
	 * money joins the general earmark and is spent by the general gifts already standing in it.
	 *
	 * WHO RELEASES IT is decided by the DATABASE, not by a read: the `widened` stamp is a
	 * compare-and-swap (UPDATE … WHERE id = %d AND widened = 0) whose affected-row count is the gate,
	 * taken inside the lock and BEFORE a single cent moves. Read-then-write, with the read outside the
	 * lock, is how one gift gets released twice — and a duplicate release is a −m/+m pair that sums to
	 * zero as innocently as the first, so nothing downstream would ever have noticed (verify_credits
	 * now counts the rows per ref as well, so it would).
	 *
	 * The money moves as a ZERO-SUM PAIR of fund appends (Funds::move_credit_earmark), never a
	 * rewrite; the released amount is this gift's own unspent share, clamped to what the source
	 * earmark actually still holds — the bucket is shared with every other donor who chose the same
	 * slice, so a gift's book value and the bucket's balance are not the same number.
	 */
	public static function widen( $req ) {
		if ( Rest::throttle( 'credits_widen', 10, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		$id  = Rest::pint( $req, 'id', 0 );
		$g   = Data::one( 'SELECT * FROM ' . Data::t( 'aq_credit_gifts' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $g || (int) $g['donor_id'] !== $uid ) { return Rest::err( 'not_yours', 'That is not one of your gifts', 403 ); }
		$general = self::bucket( self::ANY, self::ANY );
		if ( (string) $g['bucket'] === $general ) { return Rest::err( 'already_general', 'This gift is already open to any member', 409 ); }
		// A courtesy answer for the ordinary repeat click; the claim below is what actually decides.
		if ( (int) $g['widened'] > 0 ) { return Rest::err( 'already', 'You have already released this gift', 409 ); }

		$lock = 'crdbucket_' . (string) $g['bucket'];
		if ( ! Economy::acquire_lock( $lock, 15 ) ) { return Rest::err( 'busy', 'Try again in a moment', 429 ); }
		try {
			$spent = (int) Data::col( 'SELECT COALESCE(SUM(cents),0) FROM ' . Data::t( 'aq_credit_grants' ) . ' WHERE gift_id = %d', [ $id ] );
			$move  = min( max( 0, (int) $g['cents'] - $spent ), max( 0, Economy::counter( 'fund_' . $g['bucket'] ) ) );
			if ( $move < 1 ) { return Rest::err( 'empty', 'There is nothing left in this gift to release', 409 ); }
			// What the released money GUARANTEES, at the unit price and fee cap frozen when the donor
			// paid — never the untouched share of the original count, which was quoted against cents
			// that may since have been clamped away by a bucket the rest of its slice has drained.
			// intdiv, with NO floor of one. A residue smaller than a single maximum-fee entry cannot
			// buy an entry, and a successor that claimed one anyway would be offered against the general
			// earmark and spend a DIFFERENT donor's money to keep a promise this money cannot keep —
			// which is precisely the overstatement the re-derivation exists to stop. Rounding down loses
			// no money: every cent of the remainder still moves, in $move.
			$left = intdiv( $move, max( 1, (int) $g['unit_cents'] ) * max( 1, (int) $g['fee_cap'] ) );

			// THE CLAIM. One row affected means this call is the release; anything else means another
			// request (or another click) already is, and it must not move the same money a second time.
			$stamp = Data::now();
			if ( 1 !== Data::update( 'aq_credit_gifts', [ 'widened' => $stamp ], [ 'id' => $id, 'widened' => 0 ] ) ) {
				return Rest::err( 'already', 'You have already released this gift', 409 );
			}
			$ref  = 'widen:' . $id;
			$note = 'Released to any member: ' . self::bucket_words( $g['bucket'] );
			if ( ! Funds::move_credit_earmark( $g['bucket'], $general, $move, $ref, $note ) ) {
				// Rejected before either append (move_credit_earmark validates first), so no money has
				// moved and this gift was never released — hand the claim back, or the stamp alone would
				// strand the gift for good: stamped gifts stop matching, and a stamped gift cannot be
				// released again. `widened` is a state flag on the gift, not a ledger row, so putting it
				// back is not a rewrite of money; the CAS on our own stamp keeps that precise.
				Data::update( 'aq_credit_gifts', [ 'widened' => 0 ], [ 'id' => $id, 'widened' => $stamp ] );
				return Rest::err( 'server_error', 'Could not release the gift', 500 );
			}
			// The successor carries the remaining promise. It is written AFTER the money, deliberately:
			// a successor with no money behind it would be offered against the general bucket and spend
			// another donor's gift, whereas money that arrives with no successor is simply money in the
			// general earmark — still ArtaCredits, still doing the job the donor released it for. A
			// residue under one entry takes that second road on purpose (see $left): no gift row is
			// written, the cents join the general earmark, and any live general gift can spend them.
			$new = 0;
			if ( $left > 0 ) {
				$new = (int) Data::insert( 'aq_credit_gifts', [
					'donor_id' => $uid, 'bucket' => $general, 'cents' => $move, 'entries' => $left,
					'unit_cents' => (int) $g['unit_cents'], 'fee_cap' => (int) $g['fee_cap'],
					'donor_name' => (string) $g['donor_name'], 'ref' => $ref, 'widened' => 0, 'created' => Data::now(),
				] );
			}
			return [ 'ok' => true, 'moved_cents' => $move, 'entries' => $left, 'gift' => (int) $new,
				'message' => 'Released — your gift is now open to any member of ArtaQuest.' ];
		} finally {
			Economy::release_lock( $lock );
		}
	}

	/** GET credits/mine — the signed-in donor's own gifts, and what became of each. */
	public static function mine( $req ) {
		$uid  = Rest::uid();
		$G    = Data::t( 'aq_credit_gifts' );
		$R    = Data::t( 'aq_credit_grants' );
		$rows = Data::all(
			"SELECT g.*, ( SELECT COUNT(*) FROM $R r WHERE r.gift_id = g.id ) AS used,
			        ( SELECT COALESCE(SUM(r.cents),0) FROM $R r WHERE r.gift_id = g.id ) AS spent
			 FROM $G g WHERE g.donor_id = %d ORDER BY g.id DESC LIMIT 50", [ $uid ] );
		$general = self::bucket( self::ANY, self::ANY );
		return [ 'items' => array_map( static function ( $g ) use ( $general ) {
			$held = Economy::counter( 'fund_' . $g['bucket'] );
			// What widen() would actually be able to move: this gift's own unspent cents, clamped to
			// what the shared slice earmark still holds.
			$loose = min( max( 0, (int) $g['cents'] - (int) $g['spent'] ), max( 0, $held ) );
			return [
				'id'       => (int) $g['id'],
				'words'    => self::bucket_words( $g['bucket'] ),
				'cents'    => (int) $g['cents'],
				'entries'  => (int) $g['entries'],
				'used'     => (int) $g['used'],
				'held'     => $held,
				'name'     => self::donor_name( $g ),
				'date'     => (int) $g['created'],
				'widened'  => (int) $g['widened'] > 0,
				// Can the donor release what is left to the general slice? Money left decides it, not
				// entries left — a gift whose entries all went on cheap challenges still holds cents,
				// and those are exactly the cents that would otherwise be stranded. The UI shows the
				// control on precisely the gifts widen() would accept, so it never offers a dead button.
				'can_widen' => (int) $g['widened'] === 0 && $loose > 0 && (string) $g['bucket'] !== $general,
			];
		}, $rows ) ];
	}

	// ── the Certificate of Participation ────────────────────────────────────

	/** An entry's verification code — unforgeable because it mixes in the server auth salt, which is
	 *  never in the (public) database. Domain-separated from Extra::cert_code so a course code can
	 *  never be replayed as a participation code. */
	public static function part_code( $uid, $chid ) {
		return strtoupper( substr( hash_hmac( 'sha256', 'part|' . (int) $uid . '|' . (int) $chid, wp_salt( 'auth' ) ), 0, 10 ) );
	}

	/** The certificate payload for ONE entry — shared by the holder's view and public verification.
	 *  Placement is read ONLY from the FROZEN results a settled challenge stores, never from the live
	 *  hearts count: a printed rank must not drift after the moon. Returns null when there is no entry. */
	public static function cert_payload( $uid, $chid ) {
		$uid = (int) $uid; $chid = (int) $chid;
		$e = Data::one(
			'SELECT e.nb_id, e.created, n.title, n.slug FROM ' . Data::t( 'aq_nb_entries' ) . ' e'
			. ' JOIN ' . Data::t( 'aq_notebooks' ) . ' n ON n.id = e.nb_id'
			. ' WHERE e.ch_id = %d AND e.user_id = %d', [ $chid, $uid ] );
		if ( ! $e ) { return null; }
		$c = Data::one( 'SELECT * FROM ' . Data::t( 'aq_nb_challenges' ) . ' WHERE id = %d', [ $chid ] );
		if ( ! $c ) { return null; }
		$u = get_userdata( $uid );

		// The donor's plate — only when this entry was actually credited.
		$grant = Data::one( 'SELECT gift_id FROM ' . Data::t( 'aq_credit_grants' ) . ' WHERE ch_id = %d AND user_id = %d', [ $chid, $uid ] );
		$donor = '';
		$slice = '';
		if ( $grant ) {
			$g = Data::one( 'SELECT donor_name, bucket FROM ' . Data::t( 'aq_credit_gifts' ) . ' WHERE id = %d', [ (int) $grant['gift_id'] ] );
			if ( $g ) { $donor = self::donor_name( $g ); $slice = self::bucket_words( $g['bucket'] ); }
		}

		// Placement, from the frozen board only.
		$res   = Data::dec( $c['results'] ?? '' );
		$place = 0; $prize = 0; $field = 0;
		if ( is_array( $res ) && ! empty( $res['board'] ) ) {
			$field = count( $res['board'] );
			foreach ( $res['board'] as $i => $b ) {
				if ( (int) ( $b['nb_id'] ?? 0 ) === (int) $e['nb_id'] ) {
					// The board's OWN place, never its array index — tied co-winners are all place 1.
					$place = (int) ( $b['place'] ?? ( $i + 1 ) );
					$prize = (int) ( $b['prize'] ?? 0 );
					break;
				}
			}
		}
		$code = self::part_code( $uid, $chid );
		return [
			'valid'      => true,
			'member'     => $u ? $u->display_name : '',
			'challenge'  => (string) $c['title'],
			'topic'      => (string) $c['topic'],
			'kind'       => (string) $c['kind'],
			'work'       => (string) $e['title'],
			'work_url'   => '/nb/' . (int) $e['nb_id'] . '/' . (string) $e['slug'],
			'entered_ts' => (int) $e['created'],
			'moon_ts'    => (int) $c['deadline'],
			'settled'    => (string) $c['state'] === 'settled',
			'place'      => $place,
			'field'      => $field,
			'prize'      => $prize,
			'donor'      => $donor,
			'slice'      => $slice,
			'sponsored'  => (bool) $grant,
			'code'       => $code,
			'verify_url' => '/verify/?p=' . $chid . '&u=' . $uid . '&k=' . $code,
		];
	}

	/** GET participation?challenge= — the signed-in member's own certificate for one challenge. */
	public static function certificate( $req ) {
		$out = self::cert_payload( Rest::uid(), Rest::pint( $req, 'challenge', 0 ) );
		return $out ?: Rest::err( 'not_found', 'No entry of yours in that challenge', 404 );
	}

	/** GET participation/verify?p=&u=&k= — anyone holding a printed certificate can confirm it.
	 *  Public + CDN-cacheable; a forged code cannot pass because it can't be computed off-server. */
	public static function cert_verify( $req ) {
		$chid = Rest::pint( $req, 'p', 0 );
		$uid  = Rest::pint( $req, 'u', 0 );
		$k    = strtoupper( preg_replace( '/[^A-Za-z0-9]/', '', (string) Rest::p( $req, 'k', '' ) ) );
		if ( ! $chid || ! $uid || ! $k || ! hash_equals( self::part_code( $uid, $chid ), $k ) ) { return [ 'valid' => false ]; }
		if ( ! get_userdata( $uid ) ) { return [ 'valid' => false ]; }
		return self::cert_payload( $uid, $chid ) ?: [ 'valid' => false ];
	}

	/** GET participation/mine — every certificate the signed-in member holds. */
	public static function mine_certs( $req ) {
		$uid  = Rest::uid();
		$rows = Data::all(
			'SELECT e.ch_id, c.title, c.kind, c.topic, c.deadline, c.state FROM ' . Data::t( 'aq_nb_entries' ) . ' e'
			. ' JOIN ' . Data::t( 'aq_nb_challenges' ) . ' c ON c.id = e.ch_id'
			. ' WHERE e.user_id = %d ORDER BY e.id DESC LIMIT 100', [ $uid ] );
		return [ 'items' => array_map( static fn( $r ) => [
			'challenge_id' => (int) $r['ch_id'], 'challenge' => (string) $r['title'],
			'kind' => (string) $r['kind'], 'topic' => (string) $r['topic'],
			'moon_ts' => (int) $r['deadline'], 'settled' => (string) $r['state'] === 'settled',
			'url' => '/certificate/?challenge=' . (int) $r['ch_id'],
		], $rows ) ];
	}

	// ── proof ───────────────────────────────────────────────────────────────

	/**
	 * Prove the credit books, as rows of [check, projected, ledger, ok] — the same shape (and the same
	 * discipline) as Funds::verify_fund_counters, so tools/verify-projections.php picks it up.
	 *   1. Every crd_ bucket's counter equals its ledger SUM.
	 *   2. No crd_ bucket is NEGATIVE. Equality alone can NEVER catch an over-spend: a racing debit
	 *      moves the counter and the ledger together, so both go negative in lockstep and check 1
	 *      still passes. This is the check that would have caught it.
	 *   3. Every grant's spend appears exactly once in the fund ledger. Counted over `credit:` refs
	 *      ONLY: a donor's release (Credits::widen) also writes a negative crd_ row, and counting
	 *      that as a spend would make this check fail permanently the first time anyone released a
	 *      gift — a proof that cries wolf is worse than no proof.
	 *   4. Every release is zero-sum AND is exactly one pair. Its −from/+to appends share one
	 *      `widen:<gift>` ref, so they must sum to exactly 0 — a non-zero sum means money was created
	 *      or destroyed by a move. The sum ALONE proves too little: a gift released twice writes a
	 *      second −m/+m pair that nets to zero just as innocently, so the count of rows under the ref
	 *      is what makes a double release visible at all. Exactly 2, or something moved money twice.
	 *      (A manual reversal must therefore carry its own ref, not reuse the release's.)
	 */
	public static function verify_credits() {
		global $wpdb;
		$L = Data::t( 'aq_fund_ledger' );
		$checks = [];
		$ledger = [];
		foreach ( Data::all( "SELECT bucket, COALESCE(SUM(cents),0) cents FROM $L WHERE bucket LIKE %s GROUP BY bucket", [ $wpdb->esc_like( 'crd_' ) . '%' ] ) as $r ) {
			$ledger[ (string) $r['bucket'] ] = (int) $r['cents'];
		}
		foreach ( $ledger as $b => $sum ) {
			$proj = Economy::counter( 'fund_' . $b );
			$checks[] = [ 'check' => "credit:$b", 'projected' => $proj, 'ledger' => $sum, 'ok' => $proj === $sum ];
			$checks[] = [ 'check' => "credit:$b>=0", 'projected' => $proj, 'ledger' => 0, 'ok' => $proj >= 0 ];
		}
		$grants = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_credit_grants' ) );
		$spends = (int) Data::col( "SELECT COUNT(*) FROM $L WHERE bucket LIKE %s AND cents < 0 AND ref LIKE %s",
			[ $wpdb->esc_like( 'crd_' ) . '%', $wpdb->esc_like( 'credit:' ) . '%' ] );
		$checks[] = [ 'check' => 'credit:grants=spends', 'projected' => $grants, 'ledger' => $spends, 'ok' => $grants === $spends ];

		// Every release must be exactly zero-sum across its own ref — and exactly ONE pair of appends.
		foreach ( Data::all( "SELECT ref, COUNT(*) cnt, COALESCE(SUM(cents),0) net FROM $L WHERE ref LIKE %s GROUP BY ref",
			[ $wpdb->esc_like( 'widen:' ) . '%' ] ) as $r ) {
			$checks[] = [ 'check' => 'credit:' . (string) $r['ref'] . ':zero-sum', 'projected' => 0,
				'ledger' => (int) $r['net'], 'ok' => (int) $r['net'] === 0 ];
			$checks[] = [ 'check' => 'credit:' . (string) $r['ref'] . ':one-pair', 'projected' => 2,
				'ledger' => (int) $r['cnt'], 'ok' => 2 === (int) $r['cnt'] ];
		}
		return $checks;
	}
}
