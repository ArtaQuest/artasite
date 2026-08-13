<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Booking — "here is when I am free; take a slot."
 *
 * The missing half of ArtaMeet. ArtaMeet lets you promise somebody a time; ArtaCalendar shows you
 * everything dated. Neither lets a person who is NOT you start a meeting inside time you have
 * offered, which is the whole of what a booking page is for: a link you hand out, a week somebody
 * else can read, and one instant they can claim without a round of email.
 *
 * TWO INVARIANTS RUN THROUGH EVERY LINE HERE.
 *
 *  1. THE PUBLIC ANSWER IS FREE/BUSY, AND ONLY FREE/BUSY. book/page and book/slots need no session,
 *     because deciding whether to ask for somebody's time should not cost you an account. What they
 *     return is a list of START INSTANTS that are still open — never a meeting's title, never who it
 *     is with, never how many there are, never even the boundaries of the thing that blocked a slot.
 *     A caller can of course infer that a missing slot is taken; that is what free/busy MEANS, and it
 *     is the most a stranger may learn. (Meeting ROWS are separately public at /data/ under radical
 *     transparency. That is an argument about the database, and it is not a licence to hand the same
 *     facts out through a door whose entire purpose is to be given to strangers.)
 *
 *  2. A BOOKING IS A MEETING. Taking a slot does not create a booking record with a meeting stapled
 *     to it — it goes through Meetings::create, the same path a member's own "schedule a meeting"
 *     uses, and lands as an ordinary aq_meets row with context_type='book' and both people on the
 *     guest list. Everything downstream then works for free and cannot drift: ArtaCalendar shows it,
 *     both .ics feeds carry it, the room binds at T-15m, the reminders ring, cancelling it tells the
 *     other person. A parallel implementation would have to be taught each of those separately, and
 *     would be wrong about one of them within a month.
 *
 * A RULE, NOT A DIARY. aq_meet_rules stores what you OFFER — weekdays, an hour range in your own
 * zone, a slot length, how much notice you need, how far ahead you will go. It stores no free slots
 * and no busy ones: both are computed at read time against aq_meets, so a meeting scheduled by any
 * other route closes the slot it lands on with no synchronisation and nothing to keep in step.
 *
 * TIMEZONES ARE THE WHOLE PROBLEM. "Two until seven, Istanbul" is a statement about the owner's
 * afternoon, not about UTC, and the two stop agreeing twice a year for everybody with DST. Every
 * instant here is therefore built by real date arithmetic in the owner's own DateTimeZone — never a
 * stored offset, never seconds-since-midnight added to a day — and a slot whose wall-clock time does
 * not exist on a spring-forward day is dropped rather than silently moved to a time nobody offered.
 */
final class Booking {

	/** How many availability types one member may publish. A runaway guard, not a policy. */
	const MAX_RULES = 12;

	/** Slot length bounds. These are ArtaMeet's own duration bounds deliberately: a slot we offer
	 *  must be a meeting Meetings::create will accept, or the page advertises times that refuse. */
	const SLOT_MIN_M = 15;
	const SLOT_MAX_M = 480;

	const BUFFER_MAX_M   = 120;
	const NOTICE_MAX_H   = 720;   // 30 days of "please ask well in advance"
	const HORIZON_MAX_D  = 365;

	/** Meetings::create refuses a start inside five minutes — a meeting promised to somebody who
	 *  cannot get there is a broken promise. Nothing on the grid may be nearer than that. */
	const MIN_LEAD_S = 300;
	/** …and it refuses a start more than a year out. 364 days keeps every offered slot a full day
	 *  inside that ceiling, so a rule with a 365-day horizon still never advertises a refusal. */
	const AHEAD_MAX_S = 31449600;

	/** One request may span 62 days. Bounded like ArtaCalendar's window, and for the same reason: a
	 *  hand-crafted ?from=0&to=9999999999 must not ask us to walk a decade of somebody's week. */
	const SPAN_MAX_S = 5356800;
	/** Slots per answer. Past this the caller gets a `next` cursor — keyset in TIME, which is the
	 *  only cursor that means anything for rows that do not exist. */
	const MAX_SLOTS = 400;
	/** Meetings read per free/busy computation. Five months of a very busy diary. */
	const BUSY_MAX = 500;
	/** Calendar days walked per answer, as a runaway guard on the day loop itself. */
	const DAY_GUARD = 400;

	const BLURB_MAX = 500;

	// ── Rows and small shapes ───────────────────────────────────────────────

	/** The four keys ArtaMeet's guest card uses, spelled identically, so the SPA holds ONE member
	 *  card type across the meeting page and the booking page. */
	private static function card( $uid ) {
		$u = get_userdata( (int) $uid );
		return [
			'id'     => (int) $uid,
			'name'   => $u ? $u->display_name : 'Quester',
			'slug'   => $u ? $u->user_nicename : '',
			'avatar' => class_exists( '\\AQ\\Verify' ) ? Verify::avatar_url( (int) $uid, 96 ) : '',
		];
	}

	/** ?user=<slug|id> → a WP_User, or null. Same resolution chat/keys and meet invitations use. */
	private static function member( $who ) {
		$who = trim( (string) $who );
		if ( '' === $who ) { return null; }
		$u = ctype_digit( $who ) ? get_userdata( (int) $who ) : get_user_by( 'slug', sanitize_title( $who ) );
		return $u ?: null;
	}

	/**
	 * The caller's own rule, named EITHER by `id` or by its slug (`type`/`slug`) — the owner-side
	 * routes accept both, because a settings panel holds the row it is editing and a link holds the
	 * name.
	 *
	 * SCOPED TO THE CALLER, always. An id is a guessable integer, and this is the only thing between
	 * a curious member and rewriting somebody else's availability.
	 */
	private static function rule_ref( $uid, $req ) {
		$id = Rest::pint( $req, 'id', 0 );
		if ( $id > 0 ) {
			return Data::one(
				'SELECT * FROM ' . Data::t( 'aq_meet_rules' ) . ' WHERE id = %d AND user_id = %d',
				[ $id, (int) $uid ]
			);
		}
		$slug = sanitize_title( (string) Rest::p( $req, 'type', Rest::p( $req, 'slug', '' ) ) );
		return '' !== $slug ? self::rule_row( $uid, $slug ) : null;
	}

	private static function rule_row( $uid, $slug ) {
		return Data::one(
			'SELECT * FROM ' . Data::t( 'aq_meet_rules' ) . ' WHERE user_id = %d AND slug = %s',
			[ (int) $uid, (string) $slug ]
		);
	}

	/**
	 * One rule as the API shape. Column names, deliberately — the table, the payload and the SPA's
	 * type all spell the same field the same way.
	 *
	 * This is the OWNER'S PUBLISHED OFFER, so the public reader gets the same shape as the owner:
	 * the hours you are willing to be asked for are the message, and there is nothing in a rule that
	 * is not already the point of handing somebody the link. Invariant 1 is about the MEETINGS this
	 * is computed against, and none of them appear here.
	 */
	private static function rule_payload( $r ) {
		return [
			'id'         => (int) $r['id'],
			'slug'       => (string) $r['slug'],
			'title'      => (string) $r['title'],
			'blurb'      => (string) ( $r['blurb'] ?? '' ),
			'minutes'    => (int) $r['minutes'],
			'tz'         => (string) $r['tz'],
			'days'       => (string) $r['days'],
			'from_min'   => (int) $r['from_min'],
			'to_min'     => (int) $r['to_min'],
			'buffer_min' => (int) $r['buffer_min'],
			'notice_h'   => (int) $r['notice_h'],
			'horizon_d'  => (int) $r['horizon_d'],
			'seats'      => (int) $r['seats'],
			'active'     => (int) $r['active'] ? 1 : 0,
		];
	}

	// ── The grid: what the owner OFFERS, before anything is subtracted ──────

	/**
	 * Every start instant this rule offers between $from and $to, ascending.
	 *
	 * ALL OF THE TIMEZONE CARE IS HERE, and every other method calls this one rather than doing
	 * date arithmetic of its own — so the grid book/slots publishes and the grid book/take validates
	 * against are the same grid by construction, not by two implementations agreeing.
	 *
	 *  · The day loop walks CALENDAR days in the owner's zone (DateTimeImmutable::modify('+1 day')),
	 *    never +86400 seconds. A DST day is 23 or 25 hours long, and a seconds-based loop drifts onto
	 *    the wrong date within one shift — the classic way "every Tuesday" becomes "every Monday
	 *    night" for half the year.
	 *  · The weekday index is ISO-8601 'N' (1 = Monday), which is what makes `days` readable as
	 *    "Monday first" rather than as PHP's Sunday-first 'w'.
	 *  · A slot start is built from the WALL CLOCK (hour, minute), not from midnight + N seconds,
	 *    because "from two" is a claim about the clock on the owner's wall on that date.
	 *  · A wall-clock time that DOES NOT EXIST — 02:30 on a spring-forward morning — is dropped. PHP
	 *    silently rolls such a time forward to 03:30, which would advertise a start the owner never
	 *    offered and (worse) one that take() would then have to accept or contradict. The round-trip
	 *    check below is how we notice. An AMBIGUOUS time (the repeated hour in autumn) is left as
	 *    PHP resolves it — the first, still-DST occurrence — which is deterministic and identical in
	 *    both callers, so the two never disagree about which of the two 02:30s was meant.
	 *
	 * $cap bounds the answer; the caller decides what to do with the remainder.
	 */
	private static function grid( $r, $from, $to, $cap ) {
		$out = [];
		$from = (int) $from;
		$to   = (int) $to;
		if ( $to < $from ) { return $out; }

		$mins  = (int) $r['minutes'];
		$days  = (string) $r['days'];
		$open  = (int) $r['from_min'];
		$close = (int) $r['to_min'];
		if ( $mins < 1 || $close - $open < $mins || ! preg_match( '/^[01]{7}$/', $days ) ) { return $out; }

		try {
			$tz  = new \DateTimeZone( (string) $r['tz'] );
			$day = ( new \DateTimeImmutable( '@' . $from ) )->setTimezone( $tz )->setTime( 0, 0, 0 );
		} catch ( \Exception $e ) {
			// A rule whose zone no longer resolves offers nothing rather than offering UTC. Silently
			// re-homing somebody's afternoon to another continent is the worse failure.
			return $out;
		}

		for ( $guard = 0; $guard < self::DAY_GUARD; $guard++ ) {
			if ( $day->getTimestamp() > $to ) { break; } // every slot of this day is past the window
			if ( '1' === substr( $days, ( (int) $day->format( 'N' ) ) - 1, 1 ) ) {
				for ( $m = $open; $m + $mins <= $close; $m += $mins ) {
					$h = intdiv( $m, 60 );
					$i = $m % 60;
					$at = $day->setTime( $h, $i, 0 );
					// The round trip that catches a non-existent wall clock (see the note above).
					if ( (int) $at->format( 'G' ) !== $h || (int) $at->format( 'i' ) !== $i ) { continue; }
					$ts = $at->getTimestamp();
					if ( $ts < $from || $ts > $to ) { continue; }
					$out[] = $ts;
					if ( count( $out ) >= $cap ) { return $out; }
				}
			}
			// setTime(0,0,0) again after the step, because a day whose midnight does not exist (some
			// zones shift AT midnight) leaves modify() on an hour past it.
			$day = $day->modify( '+1 day' )->setTime( 0, 0, 0 );
		}
		return $out;
	}

	/**
	 * The owner's busy intervals, ALREADY WIDENED BY THE BUFFER, for a window.
	 *
	 * Read from the real meetings the owner is a GUEST of — aq_meets joined to aq_meet_guests —
	 * which is the same definition of "yours" ArtaCalendar uses, and the reason a meeting somebody
	 * else booked, or a grant working session, closes this diary too. A cancelled meeting is not
	 * busy: cancelling is exactly how an owner gives a slot back.
	 *
	 * The buffer is applied ONCE, around the meeting, rather than around both the meeting and the
	 * slot: widening both sides would demand two buffers' worth of gap, which is not what "ten
	 * minutes between calls" means to the person who typed it.
	 *
	 * Only two integers per meeting ever leave this method, and they never leave the class — the
	 * public answer is computed FROM them and consists of instants the caller may still have. That
	 * is what makes the free/busy endpoint genuinely free/busy rather than a redacted diary.
	 */
	private static function busy( $owner, $from, $to, $buffer_s ) {
		$rows = Data::all(
			'SELECT m.start_ts, m.end_ts FROM ' . Data::t( 'aq_meets' ) . ' m JOIN ' . Data::t( 'aq_meet_guests' ) . ' g'
			. ' ON g.meet_id = m.id AND g.user_id = %d'
			. " WHERE m.status <> 'cancelled' AND m.end_ts + %d > %d AND m.start_ts - %d < %d"
			. ' ORDER BY m.start_ts ASC LIMIT %d',
			[ (int) $owner, (int) $buffer_s, (int) $from, (int) $buffer_s, (int) $to, self::BUSY_MAX ]
		);
		$out = [];
		foreach ( $rows as $m ) {
			$s = (int) $m['start_ts'] - (int) $buffer_s;
			$e = (int) $m['end_ts'] + (int) $buffer_s;
			// A row with no length would block nothing; treat it as the slot length so a malformed
			// meeting errs towards protecting the owner rather than towards double-booking them.
			if ( $e <= $s ) { $e = $s + 1; }
			$out[] = [ $s, $e ];
		}
		return $out;
	}

	/** True when [$start, $start+$dur) touches none of the (ascending, by start) busy intervals. */
	private static function is_free( $start, $dur, $busy ) {
		$end = $start + $dur;
		foreach ( $busy as $b ) {
			if ( $b[0] >= $end ) { break; }      // sorted by start — nothing later can reach back
			if ( $b[1] > $start ) { return false; } // overlap: b starts before we end and ends after we start
		}
		return true;
	}

	/** The earliest instant this rule may be booked at, and the latest. Both are the rule's own
	 *  words (notice, horizon) floored/capped by what ArtaMeet will actually accept. */
	private static function bounds( $r, $now ) {
		$earliest = $now + max( (int) $r['notice_h'] * 3600, self::MIN_LEAD_S );
		$latest   = $now + min( (int) $r['horizon_d'] * 86400, self::AHEAD_MAX_S );
		return [ $earliest, $latest ];
	}

	// ── Public: the page and its free/busy answer ───────────────────────────

	/**
	 * GET book/page?user=<slug|id> — whose page this is, and what they are offering.
	 *
	 * No session, and no slots: the page needs the types before it can ask for a week of one of
	 * them, and asking for both in one request would compute a grid the visitor may never look at.
	 * A member with nothing on offer is a 200 with an empty list, never a 404 — "they are not taking
	 * bookings" is an answer, and a 404 would make this a membership oracle for anyone with a
	 * username list.
	 */
	public static function page( $req ) {
		if ( Rest::throttle( 'aq_book_page', 120, 300 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$u = self::member( Rest::p( $req, 'user', '' ) );
		if ( ! $u ) { return Rest::err( 'not_found', 'No such member.', 404 ); }

		$rows = Data::all(
			'SELECT * FROM ' . Data::t( 'aq_meet_rules' ) . ' WHERE user_id = %d AND active = 1 ORDER BY id ASC LIMIT %d',
			[ (int) $u->ID, self::MAX_RULES ]
		);
		$types = [];
		foreach ( $rows as $r ) { $types[] = self::rule_payload( $r ); }

		// The zone the owner keeps their day in, taken from the first thing they offer rather than
		// invented: a visitor is agreeing to "two o'clock HIS time", and the page has to be able to
		// say whose afternoon it is beside their own clock. Empty when they offer nothing, because
		// there is then no diary to have a zone.
		$card = self::card( $u->ID ) + [ 'tz' => (string) ( $types[0]['tz'] ?? '' ) ];

		return [
			'ok'    => true,
			// The same card under both names — `user` matches ArtaMeet's guest card, `owner` is what
			// this page calls the person whose diary it is. One value, so the two cannot disagree.
			'user'  => $card,
			'owner' => $card,
			'types' => $types,
			'now'   => Data::now(),
			// So the page can say "this is you" without a second call, and offer the owner their own
			// settings instead of a booking form.
			'me'    => Rest::uid(),
		];
	}

	/**
	 * GET book/slots?user=&type=&from=&to= — the FREE STARTS, and nothing else.
	 *
	 * The answer is a list of unix instants. It carries no meeting, no title, no participant, no
	 * count, and no busy interval — a reader learns which moments they may still have, which is
	 * precisely the question they came with. Everything that was subtracted stays inside busy().
	 *
	 * `next` is a keyset cursor IN TIME (pass it back as ?from=) rather than an offset, because
	 * these rows do not exist: there is nothing to count past. An empty list with a `next` is a
	 * perfectly ordinary answer — a fortnight of a fully-booked diary — and the client should follow
	 * the cursor rather than conclude the page is empty.
	 *
	 * Anonymous GETs are edge-cached for 30s by Rest::dispatch. A slot taken in that window can
	 * survive a few seconds too long in somebody's browser; take() then refuses it honestly, which
	 * is the right failure — the alternative is a private, uncacheable answer on a link designed to
	 * be handed to a crowd.
	 */
	public static function slots( $req ) {
		if ( Rest::throttle( 'aq_book_slots', 120, 300 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$u = self::member( Rest::p( $req, 'user', '' ) );
		if ( ! $u ) { return Rest::err( 'not_found', 'No such member.', 404 ); }
		$r = self::rule_row( $u->ID, sanitize_title( (string) Rest::p( $req, 'type', '' ) ) );
		if ( ! $r || ! (int) $r['active'] ) { return Rest::err( 'not_offered', 'That is not on offer.', 404 ); }

		$now = Data::now();
		[ $earliest, $latest ] = self::bounds( $r, $now );

		$from = max( Rest::pint( $req, 'from', $now ), $earliest );
		$to   = Rest::pint( $req, 'to', $from + 1209600 ); // a fortnight is what a booking page shows
		if ( $to <= $from ) { $to = $from + 1209600; }
		$to = min( $to, $from + self::SPAN_MAX_S, $latest );

		$slots = [];
		$next  = null;
		if ( $to >= $from ) {
			$dur     = (int) $r['minutes'] * 60;
			$buffer  = (int) $r['buffer_min'] * 60;
			$offered = self::grid( $r, $from, $to, self::MAX_SLOTS );
			// One busy read for the whole window, widened by the slot length so a meeting that starts
			// before the window's end and runs past it still closes the slot it lands on.
			$busy = self::busy( (int) $u->ID, $from - $buffer, $to + $dur + $buffer, $buffer );
			foreach ( $offered as $ts ) {
				if ( self::is_free( $ts, $dur, $busy ) ) { $slots[] = $ts; }
			}
			// The grid stopped at the cap, so there is more week to ask for. Resume one second past
			// the last instant we CONSIDERED (not the last free one), or a fully-booked page would
			// hand back a cursor that walks the same days again.
			if ( count( $offered ) >= self::MAX_SLOTS && $offered ) {
				$next = end( $offered ) + 1;
				if ( $next > $latest ) { $next = null; }
			}
		}

		return [
			'user'    => self::card( $u->ID ),
			'type'    => self::rule_payload( $r ),
			'from'    => $from,
			'to'      => $to,
			'now'     => $now,
			'minutes' => (int) $r['minutes'],
			'tz'      => (string) $r['tz'],
			'slots'   => $slots,
			'next'    => $next,
		];
	}

	// ── Taking a slot ───────────────────────────────────────────────────────

	/**
	 * POST book/take {user, type, start, note?} — claim one instant, and get an ArtaMeet.
	 *
	 * WHY THIS IS SAFE AGAINST TWO PEOPLE TAKING THE LAST SLOT IN THE SAME SECOND. Reading the
	 * diary, deciding the slot is free and then inserting is NOT sufficient, however tight the
	 * window: both requests can read before either writes, and both then insert a meeting the owner
	 * never agreed to be in twice. Two mechanisms cover it, and each answers a different failure:
	 *
	 *  · A PER-OWNER MUTEX (Economy::acquire_lock) wraps the decide-and-create section. It is claimed
	 *    by INSERTing a row whose option_name is UNIQUE, so the database — not a read — picks exactly
	 *    one winner; it is self-healing (a crashed holder's claim is stolen by a compare-and-swap
	 *    after its TTL) and released in `finally`. Because the winner's meeting row is committed
	 *    before it releases, the loser's collision check RUNS AFTER that write and sees it. The lock
	 *    is what makes this a serialised check rather than a hopeful one, and it is scoped per OWNER
	 *    because that is the resource being double-booked — it must also catch the harder race, where
	 *    two people take DIFFERENT, overlapping starts (a 14:00 hour and a 14:30 half-hour, or two
	 *    slots a buffer apart), which no equality-based key can see.
	 *  · A UNIQUE KEY as the structural backstop for the identical-start case: the created meeting is
	 *    stamped ctx_key = 'book:<owner>:<start>', and aq_meets.ctx_key is UNIQUE. If the lock were
	 *    ever lost — stolen as stale by a slow request, or wiped with the options row — the second
	 *    claim's write is still REFUSED BY THE INDEX rather than granted. The database is the last
	 *    word on that, and it is the only participant that cannot be raced.
	 *
	 * THE OWNER BECOMES THE HOST, not the person who booked. Meetings::create makes its caller the
	 * host (correctly — usually you are scheduling your own meeting), so the row is created and then
	 * the host is moved in ONE update. It matters because host is who may cancel or retime: this is
	 * the owner's diary, they published the offer, and a Calendly-shaped tool where the visitor can
	 * rearrange your day and you cannot decline is not a diary you would hand out. The person who
	 * booked keeps everything a guest has — the room, the reminders, the RSVP, the .ics.
	 */
	public static function take( $req ) {
		if ( Rest::throttle( 'aq_book_take', 8, 300 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in to book a time.', 401 ); }

		$u = self::member( Rest::p( $req, 'user', '' ) );
		if ( ! $u ) { return Rest::err( 'not_found', 'No such member.', 404 ); }
		$owner = (int) $u->ID;
		// Your own diary is not something to take a slot out of — the meeting would have one person
		// in it, and Meetings would invite you to a meeting you are already hosting.
		if ( $owner === $uid ) { return Rest::err( 'own_page', 'This is your own booking page.', 400 ); }

		$r = self::rule_row( $owner, sanitize_title( (string) Rest::p( $req, 'type', '' ) ) );
		if ( ! $r ) { return Rest::err( 'not_offered', 'That is not on offer.', 404 ); }
		if ( ! (int) $r['active'] ) { return Rest::err( 'not_offered', 'This member is no longer offering that.', 409 ); }

		$now   = Data::now();
		$start = Rest::pint( $req, 'start', 0 );
		$dur   = (int) $r['minutes'] * 60;
		[ $earliest, $latest ] = self::bounds( $r, $now );

		// Each refusal names the thing that is actually wrong, because "unavailable" on a booking
		// page is indistinguishable from a broken page.
		if ( $start <= 0 )        { return Rest::err( 'bad_start', 'Pick a time.', 400 ); }
		if ( $start < $earliest ) { return Rest::err( 'too_soon', 'That is inside the notice this member asks for — pick a later time.', 409 ); }
		if ( $start > $latest )   { return Rest::err( 'too_far', 'That is beyond how far ahead this member is booking.', 409 ); }
		// ON THE GRID, checked with grid() itself rather than by re-deriving the arithmetic: a second
		// implementation of the timezone walk is a second chance to disagree with the page, and the
		// disagreement would show up as a slot that is offered and then refused.
		if ( ! in_array( $start, self::grid( $r, $start, $start, 1 ), true ) ) {
			return Rest::err( 'off_grid', 'That is not one of the times on offer.', 409 );
		}

		$claim = 'book:' . $owner . ':' . $start;
		$lock  = 'bookslot_u' . $owner;
		if ( ! Economy::acquire_lock( $lock, 20 ) ) {
			return Rest::err( 'busy', 'Somebody else is taking a slot in this diary right now. Try again in a moment.', 409 );
		}

		try {
			// A CANCELLED booking must not hold its slot hostage: cancelling is how an owner gives a
			// time back. ctx_key is an internal handle — the calendar UID is derived from the row id
			// (Meetings::vevent), so re-keying a dead row to its own natural key changes nothing any
			// subscriber can see, and frees the claim for the next person.
			$held = Data::one( 'SELECT id, status FROM ' . Data::t( 'aq_meets' ) . ' WHERE ctx_key = %s', [ $claim ] );
			if ( $held && 'cancelled' !== (string) $held['status'] ) {
				return Rest::err( 'taken', 'Somebody just took that time. Pick another.', 409 );
			}
			if ( $held ) {
				Data::update( 'aq_meets', [ 'ctx_key' => 'm:' . (int) $held['id'] ], [ 'id' => (int) $held['id'] ] );
			}

			$buffer = (int) $r['buffer_min'] * 60;
			$busy   = self::busy( $owner, $start - $buffer - $dur, $start + $dur + $buffer, $buffer );
			if ( ! self::is_free( $start, $dur, $busy ) ) {
				return Rest::err( 'taken', 'Somebody just took that time. Pick another.', 409 );
			}

			// Both names are already public (display_name is the member's handle, not their real
			// name), and both people need to recognise this in a list of meetings — "Coffee chat"
			// four times over tells the owner nothing about which one is which.
			$title = mb_substr(
				wp_strip_all_tags( (string) $r['title'] ) . ' — ' . self::card( $uid )['name'],
				0, Meetings::TITLE_MAX
			);
			$note  = mb_substr( wp_strip_all_tags( trim( (string) Rest::p( $req, 'note', '' ) ) ), 0, self::BLURB_MAX );
			$agenda = mb_substr(
				'Booked from ' . self::card( $owner )['name'] . '’s availability.' . ( '' !== $note ? "\n\n" . $note : '' ),
				0, Meetings::AGENDA_MAX
			);

			// ArtaMeet's own creation path, driven through a synthesised request — the same call the
			// meeting form makes. Nothing about a booked meeting is special enough to justify a
			// second way of writing one, and a second way is how one of them stops binding a room.
			$sub = new \WP_REST_Request();
			$sub->set_param( 'title',   $title );
			$sub->set_param( 'agenda',  $agenda );
			$sub->set_param( 'start',   $start );
			$sub->set_param( 'minutes', (int) $r['minutes'] );
			$sub->set_param( 'tz',      (string) $r['tz'] ); // the OWNER's zone: their day is the frame
			$sub->set_param( 'seats',   max( 2, min( Meetings::SEATS_MAX, (int) $r['seats'] ) ) );
			$sub->set_param( 'guests',  [ (string) $owner ] );

			$made = Meetings::create( $sub );
			// A refusal comes back verbatim: it already carries the right code and the right sentence,
			// and rewording it here would make two vocabularies for one operation.
			if ( $made instanceof \WP_REST_Response ) { return $made; }
			$mid = (int) ( $made['meet']['id'] ?? 0 );
			if ( ! $mid ) { return Rest::err( 'server_error', 'Could not book that time.', 500 ); }

			// The host must be ON the guest list — meet/update and meet/cancel both require a guest
			// row before they even look at host_id, so a meeting whose host is not a guest is one
			// NOBODY can cancel. create() reports a guest it could not add as a warning rather than a
			// failure (right for a meeting the host is standing in front of, wrong here), so this is
			// checked rather than assumed, and an unwound booking beats an immovable one.
			if ( ! Data::col(
				'SELECT 1 FROM ' . Data::t( 'aq_meet_guests' ) . ' WHERE meet_id = %d AND user_id = %d LIMIT 1',
				[ $mid, $owner ]
			) ) {
				$undo = new \WP_REST_Request();
				$undo->set_param( 'id', $mid );
				Meetings::cancel( $undo );
				return Rest::err( 'server_error', 'Could not book that time.', 500 );
			}

			// ONE update, so the UNIQUE ctx_key either grants the whole claim or grants none of it —
			// host, context and key move together or not at all.
			$stamped = Data::update( 'aq_meets', [
				'host_id'      => $owner,
				'context_type' => 'book',
				'context_id'   => (int) $r['id'],
				'ctx_key'      => $claim,
				'updated'      => $now,
			], [ 'id' => $mid ] );

			if ( false === $stamped ) {
				// Unreachable while the lock holds — inside it nobody else can be claiming this owner's
				// diary — so arriving here means the lock was lost and the index caught what it was
				// meant to catch. Unwind through ArtaMeet's own cancel path (the caller is still the
				// host at this instant, which is exactly who it lets cancel) so the invitation the
				// owner has already been rung about is properly withdrawn rather than deleted from
				// under them.
				$undo = new \WP_REST_Request();
				$undo->set_param( 'id', $mid );
				Meetings::cancel( $undo );
				return Rest::err( 'taken', 'Somebody just took that time. Pick another.', 409 );
			}

			// The guest list follows the host. The owner published these hours and the slot was free,
			// so their acceptance is what the offer MEANT — a booking that arrives as "maybe" for the
			// person who advertised it would be a strange thing to have built. The booker is a guest
			// who has plainly said yes by booking.
			Data::update( 'aq_meet_guests', [ 'role' => 'host', 'rsvp' => 'yes', 'rsvp_ts' => $now ], [ 'meet_id' => $mid, 'user_id' => $owner ] );
			Data::update( 'aq_meet_guests', [ 'role' => 'guest', 'rsvp' => 'yes', 'rsvp_ts' => $now ], [ 'meet_id' => $mid, 'user_id' => $uid ] );

			// DELIBERATELY NO SECOND BELL. add_guest has already rung the owner — "<member> invited
			// you to <title>", pointing at /meet/<id> — which is exactly what happened and exactly
			// where they need to go. A "somebody booked you" notification beside it would be two
			// bells for one event, and an inbox that rings twice teaches people to ignore it.

			// TWO LETTERS, THOUGH — one each way, and this is the whole point of a booking page.
			// The bell above lives INSIDE ArtaQuest, and the person whose week just lost an hour has
			// no reason to be looking at it: until now somebody could take your Thursday afternoon
			// and you would find out by chance. The booker needs the other half — a confirmation is
			// what makes a booking feel taken rather than sent.
			//
			// Mail only, no bell: `Notify::mail` deliberately does not push, so the owner is told
			// twice by two CHANNELS rather than twice on one. Best effort throughout — the meeting
			// is already made and committed, and an unreachable mail host must never undo it.
			// Composed from what this call already holds — the instant and the rule's zone — rather
			// than re-read from the row it just wrote. `when_line` is ArtaMeet's own wording, so the
			// letter and the meeting page cannot come to describe the same moment differently.
			$mtz      = in_array( (string) $r['tz'], timezone_identifiers_list(), true ) ? (string) $r['tz'] : 'UTC';
			$when     = Meetings::when_line( [ 'tz' => $mtz, 'start_ts' => $start ] );
			$when_s   = (string) wp_date( 'D j M, H:i', (int) $start, new \DateTimeZone( $mtz ) );
			$meet_url = '/meet/' . $mid;
			// The note itself is NOT carried into either letter. A visitor writes it to the person
			// they are meeting, not to that person's mail provider, and the meeting page is where it
			// belongs — one copy, in one place. See the meet_* templates for the rest of that reasoning.
			Notify::mail( $owner, 'meet_booked', [
				'who'        => self::card( $uid )['name'],
				'title'      => $title,
				'when'       => $when,
				'when_short' => $when_s,
				'note_line'  => '' !== $note
					? "They left a note about what they would like to talk about. It is on the meeting page.\n\n"
					: '',
				'meet_url'   => $meet_url,
			] );
			Notify::mail( $uid, 'meet_confirmed', [
				'title'      => $title,
				'host'       => self::card( $owner )['name'],
				'when'       => $when,
				'when_short' => $when_s,
				'meet_url'   => $meet_url,
			] );

			// The meeting as ArtaMeet itself describes it — read back through meet/get rather than
			// composed here, so the booker lands on a payload identical to the one /meet/<id> will
			// serve them a moment later. Composing a second version of it here is how the two come
			// to disagree about a field, and the caller is a guest, which is exactly what get()
			// authorises on.
			$show = new \WP_REST_Request();
			$show->set_param( 'id', $mid );
			$full = Meetings::get( $show );
			$full = is_array( $full ) ? $full : [];

			return [
				'ok'       => true,
				// `id` and `meet_id` are one value under two names: the meeting's id is what every
				// caller wants next, and it should not matter which of the two they reach for.
				'id'       => $mid,
				'meet_id'  => $mid,
				'meet'     => $full['meet'] ?? null,
				'guests'   => $full['guests'] ?? [],
				'url'      => '/meet/' . $mid,
				'start_ts' => $start,
				'end_ts'   => $start + $dur,
				'minutes'  => (int) $r['minutes'],
				'tz'       => (string) $r['tz'],
				'title'    => $title,
				'with'     => self::card( $owner ),
				'warnings' => (array) ( $made['warnings'] ?? [] ),
			];
		} finally {
			Economy::release_lock( $lock );
		}
	}

	// ── The owner's own side ────────────────────────────────────────────────

	/** GET book/rules?cursor=&limit= — my own availability, active and paused alike. Keyset on id
	 *  like every other list here, even though nobody publishes twelve of these. */
	public static function my_rules( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }

		[ $rows, $next ] = Data::page(
			'aq_meet_rules', 'user_id = %d', [ $uid ],
			Rest::pint( $req, 'cursor', 0 ),
			max( 1, min( 50, Rest::pint( $req, 'limit', 50 ) ) ),
			'ASC'
		);
		$items = [];
		foreach ( $rows as $r ) { $items[] = self::rule_payload( $r ); }

		$me = get_userdata( $uid );
		return [
			'ok'     => true,
			'items'  => $items,
			'next'   => $next,
			// The link to hand out, composed here so the page never has to guess the shape of it —
			// and the handle it is built on, for a panel that would rather compose its own.
			'handle' => $me ? $me->user_nicename : '',
			'url'    => $me ? home_url( '/book/' . $me->user_nicename ) : '',
			'now'    => Data::now(),
			'max'    => self::MAX_RULES,
		];
	}

	/**
	 * POST book/rules {type?, title, blurb?, minutes?, tz?, days?, from_min?, to_min?, buffer_min?,
	 * notice_h?, horizon_d?, seats?, active?} — create one, or update the one with that slug.
	 *
	 * EVERY FIELD IS VALIDATED, and the reason is the same in each case: a rule is read by a
	 * stranger's browser and turned into instants somebody will show up for. A nonsense value here
	 * does not fail — it publishes a wrong week. So the window must be a window (from < to, inside a
	 * day, long enough to hold one slot), the mask must be exactly seven of [01], the duration must
	 * be one ArtaMeet will accept, and the zone must be a REAL zone.
	 *
	 * Absent fields keep what the rule already said (or the column default on a first write), so a
	 * page that edits one control cannot blank the rest.
	 */
	public static function set_rule( $req ) {
		if ( Rest::throttle( 'aq_book_rule', 30, 300 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }

		$title_in = mb_substr( wp_strip_all_tags( trim( (string) Rest::p( $req, 'title', '' ) ) ), 0, Meetings::TITLE_MAX );

		// An edit names the row it is editing; a new offer names itself, and falls back to its title.
		// A rule found BY ID keeps its own slug even if the request carries another: the slug is in
		// the link the owner has already handed out, and quietly renaming it would break that link
		// while looking like a successful save.
		$cur  = self::rule_ref( $uid, $req );
		$slug = $cur ? (string) $cur['slug'] : sanitize_title( (string) Rest::p( $req, 'type', Rest::p( $req, 'slug', '' ) ) );
		if ( '' === $slug ) { $slug = sanitize_title( $title_in ); }
		$slug = substr( $slug, 0, 48 );
		if ( '' === $slug ) { return Rest::err( 'bad_slug', 'Give this a name.', 400 ); }

		if ( ! $cur ) {
			// A NEW OFFER MUST NOT SWALLOW AN OLD ONE. Two kinds of meeting named "A chat" slugify to
			// the same thing, and the upsert below would have quietly replaced the first — changing
			// the length, the hours and the link of something the owner had already handed out,
			// while reporting a successful save of a new one. Refuse and say which name is taken.
			$clash = Data::one(
				'SELECT id, title FROM ' . Data::t( 'aq_meet_rules' ) . ' WHERE user_id = %d AND slug = %s',
				[ $uid, $slug ]
			);
			if ( $clash ) {
				return Rest::err( 'slug_taken', 'You already offer something called “' . $clash['title'] . '” — edit that one, or give this a different name.', 409 );
			}
			$n = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_meet_rules' ) . ' WHERE user_id = %d', [ $uid ] );
			if ( $n >= self::MAX_RULES ) {
				return Rest::err( 'too_many', 'You already offer ' . self::MAX_RULES . ' kinds of meeting — edit one of those.', 400 );
			}
		}
		// The column defaults, spelled out, so a first write needs no round trip to read them back.
		$was = $cur ?: [
			'title' => '', 'blurb' => '', 'minutes' => 30, 'tz' => 'UTC', 'days' => '1111100',
			'from_min' => 540, 'to_min' => 1020, 'buffer_min' => 10, 'notice_h' => 4,
			'horizon_d' => 21, 'seats' => 2, 'active' => 1,
		];

		$title = '' !== $title_in ? $title_in : (string) $was['title'];
		if ( '' === $title ) { return Rest::err( 'bad_title', 'Give this a title — it is what people see on your page.', 400 ); }

		$blurb = null === Rest::p( $req, 'blurb', null )
			? (string) ( $was['blurb'] ?? '' )
			: mb_substr( wp_strip_all_tags( trim( (string) Rest::p( $req, 'blurb', '' ) ) ), 0, self::BLURB_MAX );

		$minutes  = null === Rest::p( $req, 'minutes', null )    ? (int) $was['minutes']    : Rest::pint( $req, 'minutes', 30 );
		$days     = null === Rest::p( $req, 'days', null )       ? (string) $was['days']    : trim( (string) Rest::p( $req, 'days', '' ) );
		$from_min = null === Rest::p( $req, 'from_min', null )   ? (int) $was['from_min']   : Rest::pint( $req, 'from_min', 540 );
		$to_min   = null === Rest::p( $req, 'to_min', null )     ? (int) $was['to_min']     : Rest::pint( $req, 'to_min', 1020 );
		$buffer   = null === Rest::p( $req, 'buffer_min', null ) ? (int) $was['buffer_min'] : Rest::pint( $req, 'buffer_min', 10 );
		$notice   = null === Rest::p( $req, 'notice_h', null )   ? (int) $was['notice_h']   : Rest::pint( $req, 'notice_h', 4 );
		$horizon  = null === Rest::p( $req, 'horizon_d', null )  ? (int) $was['horizon_d']  : Rest::pint( $req, 'horizon_d', 21 );
		$seats    = null === Rest::p( $req, 'seats', null )      ? (int) $was['seats']      : Rest::pint( $req, 'seats', 2 );
		$active   = null === Rest::p( $req, 'active', null )     ? (int) $was['active']     : ( Rest::pint( $req, 'active', 1 ) ? 1 : 0 );
		$tz       = null === Rest::p( $req, 'tz', null )         ? (string) $was['tz']      : trim( (string) Rest::p( $req, 'tz', '' ) );

		// A REAL zone, tested against the IANA list rather than against DateTimeZone's constructor.
		// The constructor also accepts '+03:00' and 'EST', and both are traps: they are fixed offsets
		// with no DST rules, so the first member in Berlin who saved one would quietly stop matching
		// their own clock in March and never find out from us.
		if ( ! in_array( $tz, timezone_identifiers_list(), true ) ) {
			return Rest::err( 'bad_tz', 'Pick a real timezone, like Europe/Istanbul.', 400 );
		}
		if ( ! preg_match( '/^[01]{7}$/', $days ) || false === strpos( $days, '1' ) ) {
			return Rest::err( 'bad_days', 'Choose at least one day of the week.', 400 );
		}
		if ( $minutes < self::SLOT_MIN_M || $minutes > self::SLOT_MAX_M ) {
			return Rest::err( 'bad_duration', 'A meeting runs between ' . self::SLOT_MIN_M . ' minutes and ' . ( self::SLOT_MAX_M / 60 ) . ' hours.', 400 );
		}
		if ( $from_min < 0 || $to_min > 1440 || $from_min >= $to_min ) {
			return Rest::err( 'bad_window', 'The start of your window has to come before the end of it, inside one day.', 400 );
		}
		if ( $to_min - $from_min < $minutes ) {
			return Rest::err( 'window_too_short', 'That window is shorter than one meeting, so it would never offer a time.', 400 );
		}
		if ( $buffer < 0 || $buffer > self::BUFFER_MAX_M ) {
			return Rest::err( 'bad_buffer', 'Keep the gap between meetings under ' . self::BUFFER_MAX_M . ' minutes.', 400 );
		}
		if ( $notice < 0 || $notice > self::NOTICE_MAX_H ) {
			return Rest::err( 'bad_notice', 'Ask for between 0 and ' . self::NOTICE_MAX_H . ' hours of notice.', 400 );
		}
		if ( $horizon < 1 || $horizon > self::HORIZON_MAX_D ) {
			return Rest::err( 'bad_horizon', 'Book between 1 and ' . self::HORIZON_MAX_D . ' days ahead.', 400 );
		}
		// A rule that needs more warning than it will ever look ahead offers an empty week forever,
		// and the owner would have no way to see why. Refuse it while they are still looking at it.
		if ( $notice * 3600 >= $horizon * 86400 ) {
			return Rest::err( 'notice_past_horizon', 'You are asking for more notice than the window you book within — nobody could ever take a time.', 400 );
		}
		$seats = max( 2, min( Meetings::SEATS_MAX, $seats ) );

		$now  = Data::now();
		$data = [
			'title'      => $title,
			'blurb'      => $blurb,
			'minutes'    => $minutes,
			'tz'         => $tz,
			'days'       => $days,
			'from_min'   => $from_min,
			'to_min'     => $to_min,
			'buffer_min' => $buffer,
			'notice_h'   => $notice,
			'horizon_d'  => $horizon,
			'seats'      => $seats,
			'active'     => $active,
			'updated'    => $now,
		];
		if ( ! $cur ) { $data['created'] = $now; }
		// Keyed on (user_id, slug), which is UNIQUE in the schema — so a double-tapped Save creates
		// one rule and then edits it, rather than two rules with the same name.
		Data::upsert( 'aq_meet_rules', [ 'user_id' => $uid, 'slug' => $slug ], $data );

		$row = self::rule_row( $uid, $slug );
		if ( ! $row ) { return Rest::err( 'server_error', 'Could not save that.', 500 ); }
		$me = get_userdata( $uid );
		return [
			'ok'   => true,
			'rule' => self::rule_payload( $row ),
			'url'  => $me ? home_url( '/book/' . $me->user_nicename ) : '',
		];
	}

	/**
	 * POST book/rule-off {type} — stop offering this.
	 *
	 * PAUSED, NEVER DELETED, and MEETINGS ALREADY BOOKED STAND. Withdrawing an offer says nothing
	 * about the promises made under it while it was open — those are meetings now, and they are
	 * cancelled one at a time from the meeting page, by the host, so the other person is told. The
	 * row survives so the same link works again when it is switched back on.
	 */
	public static function drop_rule( $req ) {
		if ( Rest::throttle( 'aq_book_rule', 30, 300 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }

		$row = self::rule_ref( $uid, $req );
		if ( ! $row ) { return Rest::err( 'not_found', 'You are not offering that.', 404 ); }
		if ( (int) $row['active'] ) {
			Data::update( 'aq_meet_rules', [ 'active' => 0, 'updated' => Data::now() ], [ 'id' => (int) $row['id'] ] );
			$row = self::rule_row( $uid, (string) $row['slug'] );
		}
		return [ 'ok' => true, 'rule' => self::rule_payload( $row ) ];
	}
}
