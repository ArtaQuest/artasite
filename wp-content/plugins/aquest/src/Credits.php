<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ARTACREDITS (2026-08-03) — a donor pays a stranger's challenge entry fee.
 *
 * A donor gives to a SLICE of the membership (nationality · gender · age band). The gift lands in
 * the public fund as a `crd_<cty>_<g>_<band>` earmark. When a member of that slice tries to enter a
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
 * The contended resource is the GIFT, not the member: two different members racing for the last
 * entry of one gift hold different `wallet_u<uid>` locks and would both pass an unlocked balance
 * check. Every read-then-write below runs under `crdgift_<gift>` (Economy::acquire_lock — the same
 * atomic option-INSERT primitive `wallet_u*` and `nbsettle` use). The grant row is written ONCE, at
 * the end, via Data::upsert, whose `true` return means "this call created the row" even under a
 * race — so nothing is ever inserted-then-deleted and both tables stay honestly append-only.
 *
 * ── WHAT STOPS A MEMBER FARMING IT ──────────────────────────────────────────────────────────────
 * A challenge's fee is chosen by its founder and a sole entrant takes the whole pool at the moon,
 * so an unguarded credit is a direct "stranger's donation -> my wallet" pipe. Four gates close it:
 *   1. A credit never pays the entry of the member who FOUNDED the challenge.
 *   2. A credit never SEEDS a field — the challenge must already hold another member's entry.
 *   3. A credit is never offered to an API TOKEN. Publication-grade consent is a human act, and a
 *      token cannot see the donor's name it would be accepting (Api::via_token).
 *   4. Nationality / gender / birthday are freely-rewritable self-claims (Verify::set_identity), so
 *      a facet only matches once it has been SETTLED for SETTLE_DAYS. Rewriting your nationality to
 *      reach a waiting gift buys you a month's wait, not a gift.
 * Plus MOON_CAP credit-funded entries per member per synodic month, and FEE_CAP on any one entry.
 *
 * ── WHAT IS PUBLIC (the database is public — say it plainly) ────────────────────────────────────
 * Accepting a credit writes `aq_credit_grants(gift_id, ch_id, user_id)` — public, like everything.
 * A reader who follows gift_id learns the slice the gift was given for, which is a fact about the
 * member. That is disclosed in the offer, before they accept, in words. The `bucket` is deliberately
 * NOT duplicated onto the grant row: it stays one hop away on the gift, so no single public row
 * states a member's nationality, gender and age together beside their user id.
 * Nothing anywhere records that a member WANTS to be sponsored — there is no standing flag to read.
 */
final class Credits {

	/** Age bands, low edge => label. '13' is the under-18 band: derived for matching, NEVER offered
	 *  to a donor (see SLICE_BANDS) — no adult stranger targets a child by age or gender. */
	const BANDS = [ '13' => 'Under 18', '18' => '18–24', '25' => '25–34', '35' => '35–49', '50' => '50–64', '65' => '65 and over' ];

	/** The bands a donor may choose. */
	const SLICE_BANDS = [ '18', '25', '35', '50', '65' ];

	/** Gender, as a member may state it about themselves. Opt-in, revocable, never inferred. */
	const GENDERS = [ 'w' => 'Women', 'm' => 'Men', 'n' => 'Non-binary people' ];

	const ANY        = 'x';   // the "no preference" value on every axis
	const FEE_CAP    = 5;     // ₳ — the largest single entry fee one credit will cover
	const MIN_FIELD  = 2;     // entrants who are neither the member nor the founder, before a credit joins
	const MOON_CAP   = 2;     // credit-funded entries one member may accept per synodic month
	const REACH_MIN  = 5;     // never publish a member count below this — report "fewer than 5"
	const SETTLE_DAYS = 30;   // an identity facet must be unchanged this long before it matches
	const SYNODIC_S  = 2551443;

	// ── the slice ───────────────────────────────────────────────────────────

	/** A slice's fund bucket: crd_<cty>_<gender>_<band>, each axis 'x' when unrestricted.
	 *  Max 11 chars — comfortably inside aq_fund_ledger.bucket VARCHAR(24) and the
	 *  aq_counters.name VARCHAR(40) that carries it as 'fund_<bucket>'. */
	public static function bucket( $cty, $gender, $band ) {
		$cty    = strtolower( preg_replace( '/[^A-Za-z]/', '', (string) $cty ) );
		$gender = (string) $gender;
		$band   = (string) $band;
		if ( strlen( $cty ) !== 2 ) { $cty = self::ANY; }
		if ( ! isset( self::GENDERS[ $gender ] ) ) { $gender = self::ANY; }
		if ( ! in_array( $band, self::SLICE_BANDS, true ) ) { $band = self::ANY; }
		return 'crd_' . $cty . '_' . $gender . '_' . $band;
	}

	/** A slice in words, for the offer, the certificate and the donate page — never a raw bucket key.
	 *  "women in Iran aged 25–34" · "members in Iran" · "any member of ArtaQuest". */
	public static function slice_words( $cty, $gender, $band ) {
		$who = isset( self::GENDERS[ $gender ] ) ? strtolower( self::GENDERS[ $gender ] ) : 'members';
		$out = $who;
		if ( strlen( (string) $cty ) === 2 && $cty !== self::ANY ) {
			$out .= ' in ' . self::country_name( $cty );
		}
		if ( in_array( (string) $band, self::SLICE_BANDS, true ) ) {
			$out .= ' aged ' . strtolower( self::BANDS[ $band ] );
		}
		if ( $out === 'members' ) { return 'any member of ArtaQuest'; }
		return $out;
	}

	/** Words for a stored bucket key. */
	public static function bucket_words( $bucket ) {
		$p = explode( '_', (string) $bucket );
		return count( $p ) === 4 ? self::slice_words( $p[1], $p[2], $p[3] ) : 'any member of ArtaQuest';
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

	/** The selectable countries (ISO-2 + name), for the donor's picker. No member counts — publishing
	 *  "Iran · 2 members" beside a money bucket is a targeting oracle AND a disclosure. */
	public static function countries() {
		static $out = null;
		if ( $out !== null ) { return $out; }
		$out  = [];
		$file = ( defined( 'AQ_DIR' ) ? AQ_DIR : __DIR__ . '/..' ) . '/data/countries.tsv';
		foreach ( @file( $file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES ) ?: [] as $line ) {
			$c = explode( "\t", $line );
			if ( count( $c ) >= 2 ) { $out[] = [ 'iso' => strtolower( trim( $c[0] ) ), 'name' => trim( $c[1] ) ]; }
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

	/** A member's stated gender ('' when they have not said — the default, and never inferred).
	 *  Verify owns the field (it sits beside the other self-claimed identity facts); this is the
	 *  reader, so the two can never drift apart on what counts as a valid answer. */
	public static function gender( $uid ) {
		return Verify::gender( (int) $uid );
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
	 *  the unrestricted bucket: no gift that names a gender or an age band can ever reach a child. */
	public static function buckets_for_user( $uid ) {
		$uid  = (int) $uid;
		$band = self::age_band( $uid );
		if ( $band === '13' ) { return [ self::bucket( self::ANY, self::ANY, self::ANY ) ]; }

		$cty = self::settled( $uid, 'aq_nationality' ) ? strtolower( Verify::badge_country( $uid ) ) : '';
		$gen = self::settled( $uid, 'aq_gender' ) ? self::gender( $uid ) : '';
		if ( ! self::settled( $uid, 'aq_birthday' ) ) { $band = ''; }

		$ctys = $cty !== '' ? [ $cty, self::ANY ] : [ self::ANY ];
		$gens = $gen !== '' ? [ $gen, self::ANY ] : [ self::ANY ];
		$bnds = $band !== '' ? [ $band, self::ANY ] : [ self::ANY ];

		$out = [];
		foreach ( $ctys as $c ) {
			foreach ( $gens as $g ) {
				foreach ( $bnds as $b ) { $out[] = self::bucket( $c, $g, $b ); }
			}
		}
		// $ctys/$gens/$bnds are each [specific, any], so the natural nesting above already runs
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
			 WHERE g.bucket IN ($in) AND g.fee_cap >= %d AND COALESCE(u.used,0) < g.entries
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
			if ( Economy::counter( 'fund_' . $g['bucket'] ) >= self::cents_for( $fee ) ) { return $g; }
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
	 * SPEND one entry of $gift on $uid's entry of notebook $nb_id into $ch. Returns the grant row id,
	 * or 0 if the gift was exhausted, the earmark drained, or the member turned out to already hold an
	 * entry — every one of which is a losing race in which NOTHING has been charged, so the caller
	 * simply falls back to the ordinary "you need ₳fee" refusal.
	 *
	 * Runs entirely under `crdbucket_<bucket>`: exhaustion, earmark balance, BOTH claims and the money
	 * are one critical section on THE CONTENDED RESOURCE, which is the EARMARK — not the member and
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
		$lock  = 'crdbucket_' . (string) $gift['bucket'];
		if ( ! Economy::acquire_lock( $lock, 15 ) ) { return 0; }
		try {
			$used = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_credit_grants' ) . ' WHERE gift_id = %d', [ $gid ] );
			if ( $used >= (int) $gift['entries'] ) { return 0; }
			if ( Economy::counter( 'fund_' . $gift['bucket'] ) < $cents ) { return 0; }

			// Claim 1 — the entry. UNIQUE (ch_id, user_id) makes this the one row that can exist for
			// this member on this challenge, and Data::upsert reports true ONLY when this call created
			// it (it suppresses and reports the expected collision rather than throwing).
			if ( ! Data::upsert( 'aq_nb_entries', [ 'ch_id' => $chid, 'user_id' => $uid ], [ 'nb_id' => (int) $nb_id, 'created' => Data::now() ] ) ) {
				return 0; // already in — no money moves
			}
			// Claim 2 — the credit, on the same key.
			if ( ! Data::upsert( 'aq_credit_grants', [ 'ch_id' => $chid, 'user_id' => $uid ], [ 'gift_id' => $gid, 'fee' => $fee, 'cents' => $cents, 'created' => Data::now() ] ) ) {
				return 0; // already credited on this challenge — never pay twice
			}

			// The money, in the order Funds::bursary_apply established: the pot grows, the gold that will
			// back the coins that pot mints is bought FIRST, then the spent CAD leaves the fund.
			Data::bump( 'aq_nb_challenges', [ 'id' => $chid ], 'pool', $fee );
			Economy::add_backing( $fee );
			Funds::spend_credit( $gift['bucket'], -$cents, 'credit:' . $chid . ':' . $uid, 'ArtaCredit: challenge ' . $chid );
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
	 * TWO passes, because neither alone is enough:
	 *  1. SHAPE. A donor name is a NAME. Keep only letters (any script), marks, spaces and the
	 *     punctuation names actually contain; collapse runs. That deterministically removes URLs,
	 *     @handles, markup and slogans — prose is what a slur needs to be a slur — and it works
	 *     synchronously, which matters because…
	 *  2. ARTAMOD, when a verdict exists. Fearometer::score returns an ARRAY or NULL — never an int.
	 *     The live verdict is produced ASYNCHRONOUSLY by the relay batch, so at checkout it is
	 *     normally null and this pass is a no-op; comparing its return to a number (`score() >= LIMIT`)
	 *     was worse than useless — array>=int is always true in PHP and null>=int always false, so it
	 *     blanked every name under the test seam and screened nothing in production.
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
		if ( $n === '' || ! preg_match( '/\p{L}/u', $n ) ) { return ''; }
		$n = mb_substr( $n, 0, 80 );
		$v = class_exists( '\\AQ\\Fearometer' ) ? Fearometer::score( $n ) : null;
		if ( is_array( $v ) && (int) ( $v['fear'] ?? 0 ) >= Fearometer::limit() ) { return ''; }
		return $n;
	}

	// ── routes ──────────────────────────────────────────────────────────────

	/** GET credits/options — the donor's picker vocabulary. Deliberately carries NO member counts:
	 *  a public, CDN-cached map of who is where (and which slice is holding money) is both a
	 *  targeting oracle and a disclosure. The donor sees reach for their OWN pick via credits/reach. */
	public static function options( $req = null ) {
		return [
			'countries' => self::countries(),
			'genders'   => array_map( fn( $k ) => [ 'key' => $k, 'label' => self::GENDERS[ $k ] ], array_keys( self::GENDERS ) ),
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
	 * GET credits/reach {country,gender,band} — how many members this slice reaches, floored to
	 * REACH_MIN so a precise pick can never count a handful of identifiable people. Honest about
	 * zero, because a donor is entitled to know their gift would sit unspent.
	 *
	 * ONE indexed query, not a walk. This used to pull up to 5,000 user ids and then call
	 * buckets_for_user() on each — a per-user meta lookup, ~5,000 round trips, on a PUBLIC unthrottled
	 * GET with thousands of distinct cacheable parameter combinations. It is now a set of joins over
	 * (meta_key, meta_value), and it encodes the SAME three rules buckets_for_user does: a facet only
	 * counts once SETTLED, `aq_nationality` only counts once verified (badge_country), and a member
	 * under 18 is reachable ONLY by a gift that names nothing.
	 */
	public static function reach( $req ) {
		global $wpdb;
		if ( Rest::throttle( 'credits_reach', 120, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$cty  = strtolower( sanitize_key( (string) Rest::p( $req, 'country', '' ) ) );
		$gen  = sanitize_key( (string) Rest::p( $req, 'gender', '' ) );
		$band = sanitize_key( (string) Rest::p( $req, 'band', '' ) );
		$want = self::bucket( $cty, $gen, $band );
		[ , $wcty, $wgen, $wband ] = explode( '_', $want );

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
			// badge_country() only reports a VERIFIED nationality, so the join must require both.
			$joins  .= " JOIN $um nt ON nt.user_id = bd.user_id AND nt.meta_key = 'aq_nationality' AND UPPER(nt.meta_value) = %s"
				. " JOIN $um vf ON vf.user_id = bd.user_id AND vf.meta_key = 'aq_verified' AND vf.meta_value <> ''";
			$jargs[] = strtoupper( $wcty );
			$settled( 'ns', 'aq_nationality' );
		}
		if ( $wgen !== self::ANY ) {
			$joins  .= " JOIN $um gn ON gn.user_id = bd.user_id AND gn.meta_key = 'aq_gender' AND gn.meta_value = %s";
			$jargs[] = $wgen;
			$settled( 'gs', 'aq_gender' );
		}
		if ( $wband !== self::ANY ) {
			$r       = self::band_range( $wband );
			$where  .= ' AND bd.meta_value BETWEEN %s AND %s';
			$wargs[] = $r[0]; $wargs[] = $r[1];
		} elseif ( $wcty !== self::ANY || $wgen !== self::ANY ) {
			// Any gift that NAMES something is closed to under-18s (buckets_for_user's minor rule).
			$where  .= ' AND bd.meta_value <= %s';
			$wargs[] = gmdate( 'Y-m-d', strtotime( '-18 years' ) );
		}

		$n = (int) Data::col( 'SELECT COUNT(DISTINCT bd.user_id)' . $joins . $where, array_merge( $jargs, $wargs ) );
		return [
			'bucket'  => $want,
			'words'   => self::slice_words( $cty, $gen, $band ),
			'exact'   => $n === 0 || $n >= self::REACH_MIN,
			'members' => $n === 0 ? 0 : ( $n >= self::REACH_MIN ? $n : self::REACH_MIN ),
			'floor'   => self::REACH_MIN,
		];
	}

	/** GET credits/mine — the signed-in donor's own gifts, and what became of each. */
	public static function mine( $req ) {
		$uid  = Rest::uid();
		$G    = Data::t( 'aq_credit_gifts' );
		$R    = Data::t( 'aq_credit_grants' );
		$rows = Data::all(
			"SELECT g.*, ( SELECT COUNT(*) FROM $R r WHERE r.gift_id = g.id ) AS used
			 FROM $G g WHERE g.donor_id = %d ORDER BY g.id DESC LIMIT 50", [ $uid ] );
		return [ 'items' => array_map( static function ( $g ) {
			return [
				'id'      => (int) $g['id'],
				'words'   => self::bucket_words( $g['bucket'] ),
				'cents'   => (int) $g['cents'],
				'entries' => (int) $g['entries'],
				'used'    => (int) $g['used'],
				'held'    => Economy::counter( 'fund_' . $g['bucket'] ),
				'name'    => self::donor_name( $g ),
				'date'    => (int) $g['created'],
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
	 *   3. Every grant's spend appears exactly once in the fund ledger.
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
		$spends = (int) Data::col( "SELECT COUNT(*) FROM $L WHERE bucket LIKE %s AND cents < 0", [ $wpdb->esc_like( 'crd_' ) . '%' ] );
		$checks[] = [ 'check' => 'credit:grants=spends', 'projected' => $grants, 'ledger' => $spends, 'ok' => $grants === $spends ];
		return $checks;
	}
}
