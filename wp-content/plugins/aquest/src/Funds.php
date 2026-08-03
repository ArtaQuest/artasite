<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Donations + public financial transparency. Money is tracked in an append-only,
 * integer-cents ledger (aq_fund_ledger) split into buckets, so the public statement is
 * a simple grouped SUM and the books can never silently drift. Everything is public.
 */
final class Funds {

	const BUCKETS = [ 'bursary', 'outreach', 'scholarships', 'operations' ];

	/** Canonical bursary eligibility groups (the donation-groups source was retired with the
	 *  old theme; this is the single source of truth now). key => human label. */
	const GROUPS = [
		'refugees'       => 'Refugees & displaced people',
		'low_income'     => 'Low-income households',
		'students'       => 'Students',
		'women_stem'     => 'Women in STEM',
		'disabled'       => 'People with disabilities',
		'rural'          => 'Rural & remote communities',
		'unemployed'     => 'Unemployed & career-changers',
		'indigenous'     => 'Indigenous communities',
	];

	/** A readable label for an earmark bucket key: grp_<group> · cty_<iso> · typ_<system>_<type>. */
	private static function earmark_label( $kind, $key ) {
		if ( $kind === 'grp' ) { return self::GROUPS[ $key ] ?? ucwords( str_replace( [ '_', '-' ], ' ', $key ) ); }
		if ( $kind === 'cty' ) { return strtoupper( $key ); } // ISO code (FE maps to a country name)
		return ucwords( str_replace( [ '_', '-' ], ' ', $key ) );
	}

	// ── Fund-counter projection (read accelerator over the fund ledger) ─────
	// Every per-bucket TOTAL is mirrored into aq_counters as 'fund_<bucket>', bumped atomically in
	// lockstep with each ledger append (fund_append — the ONE write choke point). The ledger stays the
	// source of truth; finances(), bursary_fund_cents() and the causes "raised" figures read counters,
	// so the public statement is O(buckets) at any ledger size instead of a GROUP BY over every
	// donation ever. Same discipline as Economy's coins_issued/aq_standing projections: rebuildable
	// (rebuild_fund_counters) + provably equal to the ledger (verify_fund_counters).

	/** The ONE choke point that appends to the fund ledger: writes the row and bumps the bucket's
	 *  counter projection in lockstep. $bucket is clamped to the column width first, so the stored
	 *  row and the counter key can never diverge on an over-long earmark key. Returns the row id. */
	private static function fund_append( $bucket, $cents, $ref, $note ) {
		$bucket = substr( (string) $bucket, 0, 24 );
		$id = Data::insert( 'aq_fund_ledger', [
			'bucket'  => $bucket,
			'cents'   => (int) $cents,
			'ref'     => $ref,
			'note'    => $note,
			'created' => Data::now(),
		] );
		// Counter moves ONLY when the ledger row landed (same failed-INSERT desync as Economy::credit_coins).
		if ( ! $id ) {
			error_log( "AQ fund_append: ledger INSERT FAILED bucket={$bucket} {$cents}c ref={$ref} — nothing recorded" );
			return 0;
		}
		Economy::counter_add( 'fund_' . $bucket, (int) $cents );
		return $id;
	}

	/** All fund counters as bucket => cents (counter names are 'fund_<bucket>'; tiny table read). */
	private static function fund_counters() {
		global $wpdb;
		$rows = Data::all(
			'SELECT name, value FROM ' . Data::t( 'aq_counters' ) . ' WHERE name LIKE %s',
			[ $wpdb->esc_like( 'fund_' ) . '%' ]
		);
		$out = [];
		foreach ( $rows as $r ) { $out[ substr( (string) $r['name'], 5 ) ] = (int) $r['value']; }
		return $out;
	}

	/** Rebuild every fund counter from the ledger (drift repair / one-time seed at migration). */
	public static function rebuild_fund_counters() {
		global $wpdb;
		$c = Data::t( 'aq_counters' );
		$wpdb->query( $wpdb->prepare( "DELETE FROM $c WHERE name LIKE %s", $wpdb->esc_like( 'fund_' ) . '%' ) );
		$now = Data::now();
		foreach ( Data::all( 'SELECT bucket, COALESCE(SUM(cents),0) cents FROM ' . Data::t( 'aq_fund_ledger' ) . ' GROUP BY bucket' ) as $r ) {
			$wpdb->insert( $c, [ 'name' => 'fund_' . substr( (string) $r['bucket'], 0, 24 ), 'value' => (int) $r['cents'], 'updated' => $now ] );
		}
	}

	/** Prove every fund counter equals the ledger SUM it mirrors (rows of [check, projected, ledger, ok]). */
	public static function verify_fund_counters() {
		$ledger = [];
		foreach ( Data::all( 'SELECT bucket, COALESCE(SUM(cents),0) cents FROM ' . Data::t( 'aq_fund_ledger' ) . ' GROUP BY bucket' ) as $r ) {
			$ledger[ (string) $r['bucket'] ] = (int) $r['cents'];
		}
		$proj   = self::fund_counters();
		$checks = [];
		foreach ( array_unique( array_merge( array_keys( $proj ), array_keys( $ledger ) ) ) as $b ) {
			$checks[] = [ 'check' => "fund:$b", 'projected' => ( $proj[ $b ] ?? 0 ), 'ledger' => ( $ledger[ $b ] ?? 0 ),
				'ok' => ( $proj[ $b ] ?? 0 ) === ( $ledger[ $b ] ?? 0 ) ];
		}
		return $checks;
	}

	/** GET /foundation/finances — the public statement: total + per-bucket + per-earmark + recent flow.
	 *  Totals come from the fund-counter projection (O(buckets) at any ledger size); `recent` is a
	 *  bounded PK walk. The ledger itself is only aggregated by rebuild/verify, never per read. */
	public static function finances( $req ) {
		$by_bucket = [];
		foreach ( self::fund_counters() as $b => $cents ) { $by_bucket[] = [ 'bucket' => $b, 'cents' => $cents ]; }
		$buckets  = array_fill_keys( self::BUCKETS, 0 );
		$earmarks = [];
		$total    = 0; // sum EVERY bucket (core + earmark) so the public total is never undercounted
		foreach ( $by_bucket as $r ) {
			$b = (string) $r['bucket']; $c = (int) $r['cents'];
			$total += $c;
			if ( array_key_exists( $b, $buckets ) ) {
				$buckets[ $b ] = $c;
			} elseif ( preg_match( '/^(grp|cty|typ)_(.+)$/', $b, $m ) ) {
				$earmarks[] = [ 'bucket' => $b, 'kind' => $m[1], 'key' => $m[2], 'label' => self::earmark_label( $m[1], $m[2] ), 'cents' => $c ];
			}
		}
		usort( $earmarks, fn( $a, $b ) => $b['cents'] - $a['cents'] );
		$recent = Data::all(
			'SELECT bucket, cents, note, created FROM ' . Data::t( 'aq_fund_ledger' ) . ' ORDER BY id DESC LIMIT 25'
		);
		// Live coin-reserve figures for the Donate transparency cards — total Arta Coins in
		// circulation and the gold backing them, straight from the append-only ledger.
		$coin_supply = Economy::counter( 'coins_issued' ); // maintained circulating-supply total (was Σ over the whole coin ledger)
		$reserve_mg  = Economy::backing_mg(); // atomic gold-backing counter (was the lossy aq_coin_backing_mg option)
		return [
			'total_cents'   => $total,
			'buckets'       => $buckets,
			'earmarks'      => $earmarks,
			'coin_supply'   => $coin_supply,
			'reserve_mg'    => $reserve_mg,
			'backing_ratio' => $coin_supply > 0 ? round( $reserve_mg / $coin_supply, 4 ) : 1.0,
			'recent'        => array_map( fn( $r ) => [
				'bucket' => $r['bucket'], 'cents' => (int) $r['cents'], 'note' => $r['note'], 'at' => (int) $r['created'],
			], $recent ),
			'donors_public' => true,
		];
	}

	// Donations are recorded ONLY against a captured fiat payment, via the cart checkout
	// (Extra::course_checkout) → Stripe Checkout → Extra::fulfil_session → record_gift (idempotent per
	// 'stripe:<session>'). There is deliberately NO direct request handler that writes a positive
	// aq_fund_ledger row or awards donate points without captured money — a free /donate path would let
	// anyone inflate the public finances and farm donate-track standing. record_donation/record_gift below
	// must only ever be reached with a positive amount from the Stripe fulfilment layer.

	/**
	 * Record one donor's gift with FINER-GRAINED distribution: split it across a per-group (`grp_<key>`)
	 * and per-country (`cty_<iso>`) earmark bucket for each target the donor chose, so the public
	 * statement shows exactly where the money was directed. Split evenly; the last target absorbs the
	 * rounding remainder. No targets → the general bursary fund. `$ref` ties every row to one payment
	 * (idempotency). Awards donate points per part (summing to 1 per coin-equivalent of the whole gift).
	 */
	public static function record_gift( $uid, $cents, $groups = [], $countries = [], $ref = '', $topics = [] ) {
		$cents = max( 0, (int) $cents );
		if ( $cents < 1 ) { return; }
		// Each target is [kind, key]: a group/country just RECORDS an earmark (bursary money); a topic
		// (typ) is a SPONSORSHIP that flows into that topic's live course prize pool (sponsor_topic).
		$targets = [];
		foreach ( (array) $groups as $g )    { $g = sanitize_key( (string) $g ); if ( $g ) { $targets[] = [ 'grp', $g ]; } }
		foreach ( (array) $countries as $c ) { $c = sanitize_key( (string) $c ); if ( $c ) { $targets[] = [ 'cty', $c ]; } }
		foreach ( (array) $topics as $t )    { $t = sanitize_key( (string) $t ); if ( $t ) { $targets[] = [ 'typ', $t ]; } }
		if ( ! $targets ) { self::record_donation( $uid, $cents, 'bursary', 'General donation', $ref ); return; }
		$n    = count( $targets );
		$each = intdiv( $cents, $n );
		foreach ( $targets as $i => $tg ) {
			$part = ( $i === $n - 1 ) ? $cents - $each * ( $n - 1 ) : $each;
			if ( $part < 1 ) { continue; }
			if ( 'typ' === $tg[0] ) { self::sponsor_topic( $uid, $part, $tg[1], $ref ); }
			else { self::record_donation( $uid, $part, $tg[0] . '_' . $tg[1], 'Earmarked: ' . $tg[0] . '_' . $tg[1], $ref ); }
		}
	}

	/**
	 * Sponsor a TOPIC (the industry-partner funnel): a donation earmarked to a typology system flows into
	 * its LIVE course's prize pool. The money path MIRRORS a bursary — the donated CAD is recorded as a
	 * typ_<key> earmark (+ donate points, the gross shown on /foundation/finances), then SPENT: it grows
	 * the course's `revenue` (in coins), buys the matching gold (Economy::add_backing) so the prize/creator
	 * coins the pool mints stay fully backed, debits the earmark (the CAD left the fund → gold + pool), and
	 * settles — so the season distributes it 80% to questers + the tier-scaled creator/foundation split
	 * (Economy::settle_window). If the topic has NO live course yet, the gift is HELD in the typ_<key>
	 * earmark (transparent, never lost; a later course + sweep can flow it). Reached only via record_gift
	 * from the captured-payment fulfilment, so it never records money without a real gift.
	 */
	public static function sponsor_topic( $uid, $cents, $topic, $ref = '' ) {
		$cents = max( 0, (int) $cents );
		$topic = sanitize_key( (string) $topic );
		if ( $cents < 1 || '' === $topic ) { return; }
		// Record the gross sponsorship (earmark + donate points), always — the public statement shows it.
		self::record_donation( $uid, $cents, 'typ_' . $topic, 'Sponsored topic: ' . $topic, $ref );
		// Resolve the topic's LIVE published course (its `course` link → slug → a publish course).
		$link = (string) Data::col( 'SELECT course FROM ' . Data::t( 'aq_topics' ) . ' WHERE topic_key = %s AND active = 1', [ $topic ] );
		$slug = $link ? preg_replace( '#^/courses/#', '', $link ) : '';
		$cid  = $slug ? (int) Data::col( 'SELECT id FROM ' . Data::t( 'aq_courses' ) . " WHERE slug = %s AND status = 'publish'", [ $slug ] ) : 0;
		if ( $cid <= 0 ) { return; } // no live course → the earmark is HELD (not lost) until one exists
		// CAD → course-revenue coins at the sell price (same math as a bursary's coins↔cents). add_backing
		// keeps the mint fully backed; the debit moves the spent CAD out of the fund (sub-coin remainder
		// stays as a held earmark); settle distributes the new revenue this season.
		$price = (float) Economy::coin_price()['sell'];
		$coins = $price > 0 ? (int) floor( $cents / ( $price * 100 ) ) : 0;
		if ( $coins < 1 ) { return; } // too small to move a whole coin — stays a held earmark
		Data::bump( 'aq_courses', [ 'id' => $cid ], 'revenue', $coins );
		Economy::add_backing( $coins );
		self::fund_append( 'typ_' . $topic, -(int) round( $coins * $price * 100 ), 'sponsor:' . $topic . ':c' . $cid, 'Funded prize pool: ' . $slug );
		Economy::settle_course_rewards( $cid );
	}

	/**
	 * Move a topic's HELD sponsorship earmark from typ_<old> to typ_<new> when its key is renamed
	 * (ticket #141). The fund ledger is APPEND-ONLY — rows are never rewritten — so the held balance is
	 * carried across by a ZERO-SUM pair of appends (−held on the old bucket, +held on the new). That
	 * conserves the fund total (no coins minted/burned, backing untouched), keeps both buckets' audit
	 * history intact, and lets the renamed topic's future sponsorship sweeps find its money under its
	 * current key. A no-op when nothing is held (the common case — a sponsorship is spent on post). The
	 * bucket clamp matches fund_append's, so the offsetting append targets the SAME stored bucket string.
	 */
	public static function rename_topic_earmark( $old, $new ) {
		$old = sanitize_key( (string) $old );
		$new = sanitize_key( (string) $new );
		if ( $old === '' || $new === '' || $old === $new ) { return; }
		$old_bucket = substr( 'typ_' . $old, 0, 24 );
		$held = Economy::counter( 'fund_' . $old_bucket );
		if ( $held === 0 ) { return; } // nothing earmarked under the old key — pure rename, no money to move
		$ref  = substr( 'rename:' . $old . '>' . $new, 0, 64 );
		$note = substr( 'Topic key renamed: ' . $old . ' → ' . $new, 0, 191 );
		self::fund_append( $old_bucket, -$held, $ref, $note );
		self::fund_append( 'typ_' . $new, $held, $ref, $note );
	}

	/**
	 * Record one donation into a fund bucket (integer cents, single foundation currency) and award
	 * donate-track points (1 per coin-equivalent). The shared primitive behind the cart-checkout
	 * fulfilment (Extra::fulfil_session → record_gift, keyed by the captured-payment ref 'stripe:<session>'):
	 * it is reached ONLY with a positive amount once a payment is captured — there is no free /donate path.
	 * Returns the ledger row id (0 when the amount is below 1 cent).
	 */
	public static function record_donation( $uid, $cents, $bucket = 'bursary', $note = '', $ref = '' ) {
		$uid    = (int) $uid;
		$cents  = max( 0, (int) $cents );
		// Core buckets stay validated; an earmark bucket (grp_/cty_/typ_ prefix) is allowed through for
		// the finer-grained per-group/country distribution. Anything else falls back to the general fund.
		$bucket = ( in_array( $bucket, self::BUCKETS, true ) || preg_match( '/^(grp|cty|typ)_[a-z0-9_-]+$/i', (string) $bucket ) )
			? (string) $bucket : 'bursary';
		if ( $cents < 1 ) { return 0; }
		$id = self::fund_append(
			$bucket,
			$cents,
			$ref !== '' ? sanitize_text_field( (string) $ref ) : 'u' . $uid,
			sanitize_text_field( (string) $note )
		);
		Economy::award_points( $uid, max( 1, (int) floor( $cents / 100 ) ), 'donate', 'fund' . $id );
		return $id;
	}

	/** Bursary money available to cover a grant: the general `bursary` bucket plus, when a group is
	 *  given, that group's earmark (`grp_<group>`); with no group, every group earmark too. Integer
	 *  cents, read from the fund-counter projection — never a SUM over the donation ledger. */
	public static function bursary_fund_cents( $group = '' ) {
		global $wpdb;
		if ( $group !== '' && isset( self::GROUPS[ $group ] ) ) {
			return Economy::counter( 'fund_bursary' ) + Economy::counter( 'fund_grp_' . $group );
		}
		return Economy::counter( 'fund_bursary' ) + (int) Data::col(
			'SELECT COALESCE(SUM(value),0) FROM ' . Data::t( 'aq_counters' ) . ' WHERE name LIKE %s',
			[ $wpdb->esc_like( 'fund_grp_' ) . '%' ]
		);
	}

	/** Ready-to-share posts to grow the bursary fund — shown when the fund can't cover a grant. */
	private static function grow_share() {
		$url = home_url( '/donate/' );
		$msg = 'Education should never wait on money. On ArtaQuest, every gold-backed Arta Coin you donate covers a course for a learner who can\'t afford the fee. Help refill the bursary fund:';
		$both = rawurlencode( $msg . ' ' . $url );
		$u    = rawurlencode( $url );
		return [
			'message' => $msg,
			'url'     => $url,
			'links'   => [
				'x'        => 'https://twitter.com/intent/tweet?text=' . $both,
				'facebook' => 'https://www.facebook.com/sharer/sharer.php?u=' . $u,
				'linkedin' => 'https://www.linkedin.com/sharing/share-offsite/?url=' . $u,
				'whatsapp' => 'https://wa.me/?text=' . $both,
			],
		];
	}

	/** GET /bursary/status {group?} — is the bursary fund able to cover a grant right now? When it
	 *  can't, the UI swaps the application form for a "help grow the fund" call-to-action + share posts. */
	public static function bursary_status( $req ) {
		$group = sanitize_key( (string) Rest::p( $req, 'group', '' ) );
		$fund  = self::bursary_fund_cents( $group );
		return [
			'available'  => $fund > 0,
			'fund_cents' => $fund,
			'currency'   => 'CAD',
			'donate_url' => home_url( '/donate/' ),
			'share'      => self::grow_share(),
		];
	}

	/** GET /bursary — the bursary form data (courses + eligibility groups) + the learner's grants. */
	public static function bursary_list( $req ) {
		$uid     = Rest::uid();
		// Most-enrolled first: a reverse walk of the (status, enroll_count, id) index + LIMIT (both keys DESC
		// so it's an ordered walk, never a filesort over every published course at catalogue scale).
		$courses = Data::all( 'SELECT id, title, lesson_count FROM ' . Data::t( 'aq_courses' ) . " WHERE status = 'publish' ORDER BY enroll_count DESC, id DESC LIMIT 100" );
		$grants  = Data::all( 'SELECT b.course_id, c.title, b.group_key, b.amount, b.reason, b.created FROM ' . Data::t( 'aq_bursary' ) . ' b JOIN ' . Data::t( 'aq_courses' ) . ' c ON c.id = b.course_id WHERE b.user_id = %d ORDER BY b.id DESC', [ $uid ] );
		return [
			'currency' => 'CAD',
			'courses'  => array_map( fn( $c ) => [
				'id' => (int) $c['id'], 'title' => $c['title'],
				'price' => (int) self::course_cost( (int) $c['id'] ), 'free' => self::course_cost( (int) $c['id'] ) === 0,
			], $courses ),
			'groups'   => array_map( fn( $k ) => [ 'key' => $k, 'label' => self::GROUPS[ $k ] ], array_keys( self::GROUPS ) ),
			'grants'   => array_map( fn( $g ) => [
				'course_id' => (int) $g['course_id'], 'course' => $g['title'],
				'group' => $g['group_key'], 'group_label' => self::GROUPS[ $g['group_key'] ] ?? $g['group_key'],
				'amount' => (int) $g['amount'], 'reason' => $g['reason'], 'date' => (int) $g['created'],
			], $grants ),
		];
	}

	/**
	 * POST /bursary/apply {course_id, group, reason, country} — grant a member from an eligible
	 * group free access to a course, funded from the bursary bucket. Idempotent per user+course.
	 */
	public static function bursary_apply( $req ) {
		if ( Rest::throttle( 'bursary_apply', 10, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid   = Rest::uid();
		$cid   = Rest::pint( $req, 'course_id', 0 );
		$group = sanitize_key( (string) Rest::p( $req, 'group', '' ) );
		$reason = sanitize_text_field( (string) Rest::p( $req, 'reason', '' ) );
		$course = Data::one( 'SELECT id, title FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		if ( ! $course ) { return Rest::err( 'not_found', 'Course not found', 404 ); }
		if ( ! isset( self::GROUPS[ $group ] ) ) { return Rest::err( 'bad_group', 'Choose an eligibility group.' ); }

		// Serialise a member's grant: the fund check + debit is a read-then-write, so two concurrent (or
		// replayed) applies must not both pass the affordability check and both debit the fund. Mirrors
		// Economy::sell()'s per-user lock; the durable backstop is the aq_bursary UNIQUE (user, course) key.
		$lock = 'aq_bursary_lock_' . (int) $uid;
		if ( get_transient( $lock ) ) { return Rest::err( 'busy', 'An application is already in progress. Please wait a moment.', 429 ); }
		set_transient( $lock, 1, 30 );
		try {
			// Already granted a bursary, OR already enrolled (incl. a coin-paid enrolment)? Never spend donor
			// money on a seat the learner already holds, and never downgrade a paid 'active' enrolment to
			// 'bursary' or debit the fund for nothing.
			if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_bursary' ) . ' WHERE user_id = %d AND course_id = %d', [ $uid, $cid ] ) ) {
				return [ 'ok' => true, 'already' => true, 'course' => $course['title'], 'message' => 'You already have a bursary for this course.' ];
			}
			if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_enroll' ) . ' WHERE user_id = %d AND course_id = %d', [ $uid, $cid ] ) ) {
				return [ 'ok' => true, 'already' => true, 'course' => $course['title'], 'message' => 'You are already enrolled in this course.' ];
			}
			$cost  = self::course_cost( $cid );
			$cents = (int) round( $cost * Economy::coin_price()['sell'] * 100 );

			// A bursary is only real if the fund can actually pay for it — never promise a place the books
			// can't cover (and never let the fund ledger go negative). When it can't, decline gracefully and
			// hand back ready-to-share posts so the learner (or anyone) can help refill the fund.
			if ( $cents > 0 && self::bursary_fund_cents( $group ) < $cents ) {
				return [
					'ok'           => false,
					'fund_empty'   => true,
					'course'       => $course['title'],
					'group'        => self::GROUPS[ $group ],
					'fund_cents'   => self::bursary_fund_cents( $group ),
					'needed_cents' => $cents,
					'message'      => 'The bursary fund can\'t cover a place right now. Help us refill it — share ArtaQuest and a donor can open the door for you.',
					'share'        => self::grow_share(),
				];
			}

			// Open the place. A NEW bursary enrolment is a full entrant — the Outreach fund pays the fee on
			// the learner's behalf, so it counts toward the learner total AND credits the course revenue
			// (growing the prize pool), exactly like a paid enrolment (Learn::ensure_enrolled).
			$inserted = Data::upsert( 'aq_enroll', [ 'user_id' => $uid, 'course_id' => $cid ], [ 'status' => 'bursary', 'created' => Data::now(), 'updated' => Data::now() ] );
			if ( ! $inserted ) {
				// Lost the insert race (a concurrent enrol just opened the seat) — do NOT debit the fund or
				// record a grant for a place we didn't just create.
				return [ 'ok' => true, 'already' => true, 'course' => $course['title'], 'message' => 'You are already enrolled in this course.' ];
			}
			// Everything below runs EXACTLY ONCE per real grant (gated on the new-row insert), so the fund is
			// never double-debited and the course counters are never double-bumped.
			Data::bump( 'aq_courses', [ 'id' => $cid ], 'enroll_count', 1 );
			if ( $cost > 0 ) {
				Data::bump( 'aq_courses', [ 'id' => $cid ], 'revenue', $cost ); // Outreach-funded fee → the pool
				// The fee was paid from the CAD donation fund, not by burning backed coins, so the prize coins
				// this revenue lets the pool MINT would otherwise be unbacked. Convert the donated CAD into
				// matching gold backing (1 ₳ = 1 mg) — mirroring a paid enrol's reserve effect — so the
				// full-reserve invariant (backing ≥ coins_issued) holds through settlement.
				Economy::add_backing( $cost );
				self::fund_append( 'bursary', -$cents, 'bursary:c' . $cid . ':u' . $uid, 'Bursary: ' . $course['title'] . ' · ' . ( self::GROUPS[ $group ] ) );
			}
			Data::insert( 'aq_bursary', [ 'user_id' => $uid, 'course_id' => $cid, 'group_key' => $group, 'amount' => $cost, 'reason' => $reason, 'created' => Data::now() ] );
			Economy::settle_course_rewards( $cid ); // after backing is raised, so any mint stays fully backed
			return [
				'ok' => true, 'granted' => true, 'free' => $cost === 0,
				'course' => $course['title'], 'group' => self::GROUPS[ $group ], 'amount' => $cost, 'symbol' => '₳',
				'message' => 'Access granted — you can start the course now.',
				'share'   => [ 'message' => 'I just got a bursary to learn on ArtaQuest', 'url' => home_url( '/courses/' ), 'links' => [] ],
			];
		} finally {
			delete_transient( $lock );
		}
	}

	/** A course's entry fee in coins = its NUMBER OF VIDEOS — every course is a competition you join
	 *  for 1 coin per video, so a course of N videos costs ₳N to enrol. Enrolling charges this (see
	 *  Learn::enroll → Economy::charge_enrollment); it becomes the course's revenue and funds the
	 *  podium pool. Bursaries cover it for learners in a funded group. The single source of truth for
	 *  course pricing (per-video — ticket #118 reverted the 2026-06-12 per-hour experiment so the
	 *  charged fee matches the "1 coin per video" story told on every surface). Derived from the
	 *  denormalized `lesson_count` (video count, maintained by lesson-sync), never a stored price, so
	 *  the fee tracks the content and can never silently diverge from it. Minimum ₳1 — there are no
	 *  free courses (the fee IS the prize pool). */
	public static function course_cost( $cid ) {
		return self::cost_for_videos( (int) Data::col( 'SELECT lesson_count FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ (int) $cid ] ) );
	}

	/** The entry-fee formula in ONE place: 1 coin per video, minimum ₳1 (no free courses — the fee IS
	 *  the prize pool). course_cost() reads `lesson_count` for a single course; the denormalized list
	 *  cards (Courses::card, Studio, profile) already carry `lesson_count` on the fetched row and route
	 *  through here too — so the advertised price and the charged fee can never diverge. $videos = the
	 *  course's video count (aq_courses.lesson_count). */
	public static function cost_for_videos( $videos ) {
		return max( 1, (int) $videos );
	}
}
