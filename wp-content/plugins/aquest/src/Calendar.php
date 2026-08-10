<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaCalendar — everything dated that is THIS MEMBER'S BUSINESS, in one ordered list.
 *
 * IT OWNS NO DATA, and that is the whole design. Every date it serves is already a row somewhere
 * that something else is responsible for: ArtaMeet owns meetings, the outreach programme owns grant
 * deadlines, Challenges owns the season a challenge settles in. A calendar that stored its own copy
 * of any of them would be a second place for a rescheduled meeting or a moved deadline to be wrong,
 * and the second place is always the one nobody remembers to update. So there is NO aq_calendar
 * table, no Schema::VERSION bump, and nothing to migrate: this class is a VIEW, and a stale view is
 * an impossibility rather than a bug we have to prevent.
 *
 * Three sources, and the reason each one is the member's business:
 *
 *  · MEETINGS — they are on the guest list (aq_meet_guests). Somebody expects them in a call at a
 *    stated time, which is the strongest form of "yours" this platform has.
 *  · GRANT DEADLINES — they hold an ACTIVE claim on the grant (aq_grant_claims, Extra::CLAIM_ACTIVE),
 *    i.e. they took a slot on a capped application and other members were turned away because of it.
 *    A claim released is a deadline that stops being theirs, which falls out of here for free.
 *  · CHALLENGE DEADLINES — they entered a work (aq_challenge_entries.author_id). Their entry fee is
 *    in that pool and the hearts are counted at the deadline, so the date decides something of
 *    theirs. `season_key` IS that instant: Challenges::ensure_archived settles every open challenge
 *    whose `season_key` is below the current season's key, and Season::current()['key'] is a unix
 *    timestamp (the reset boundary, 10:00 America/New_York). No moon arithmetic is done here —
 *    re-deriving the deadline from Season::next_full_moon would invent a date the settler does not
 *    use, and a deadline that disagrees with the code that acts on it is worse than no deadline.
 *
 * ONE SECRET, NOT TWO. The subscription URL is signed with Meetings::cal_key — the same derived
 * signature /meet.ics uses — so a member has one calendar secret, POST meet/cal rotates both feeds
 * at once, and there is no second derivation to drift. See Meetings::cal_key for why a derived
 * signature is acceptable on a read-only feed and nowhere else.
 */
final class Calendar {

	/** Agenda window defaults, in seconds: yesterday (so this morning's items are still there) to
	 *  three months out. */
	const BACK_S    = 86400;
	const FORWARD_S = 7776000;   // 90 days
	/** A hard ceiling on what one request may span, so a hand-crafted ?from=0&to=9999999999 cannot
	 *  ask the database to walk every meeting we have ever held. */
	const SPAN_MAX_S = 34560000; // 400 days
	/** Per source, and it is a runaway guard rather than a policy: a bounded window is the real
	 *  limit, and nobody is on 400 grant claims. */
	const PER_SOURCE = 200;

	// ── The agenda ──────────────────────────────────────────────────────────

	/**
	 * GET calendar/agenda?from=&to= — the member's dated things, oldest first, in ONE shape.
	 *
	 * A uniform item is the point: the page renders one list rather than three, and a fourth source
	 * added later needs no new rendering. `all_day` is what tells a reader whether the time on an
	 * item means anything — a grant deadline is a DATE and a meeting is a MOMENT, and pretending
	 * otherwise puts "00:00" next to a deadline that was never set at midnight.
	 */
	public static function agenda( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }

		// The same lazy sweep meet/list runs, for the same reason: a quiet site still has to retire
		// meetings whose time has passed, or this page shows a finished meeting as though it were
		// still coming. Transient-gated to once every five minutes inside Meetings.
		Meetings::tick();

		$now  = Data::now();
		$from = Rest::pint( $req, 'from', $now - self::BACK_S );
		$to   = Rest::pint( $req, 'to', $now + self::FORWARD_S );
		if ( $to <= $from ) { $to = $from + self::FORWARD_S; }
		$to   = min( $to, $from + self::SPAN_MAX_S );

		$items  = self::collect( $uid, $from, $to );
		$counts = [ 'meeting' => 0, 'grant' => 0, 'challenge' => 0 ];
		foreach ( $items as $i ) { $counts[ $i['kind'] ]++; }

		return [
			'items'  => $items,
			'from'   => $from,
			'to'     => $to,
			'now'    => $now,
			'me'     => $uid,
			'counts' => $counts,
			'cal'    => self::cal_urls( $uid ),
		];
	}

	/** Every source, merged and ordered. The page and the feed read the SAME list — a date that shows
	 *  up in one and not the other would be the exact bug this class exists to make impossible.
	 *
	 *  Ties are real, not exotic: grant sittings are staggered onto the same minute by construction
	 *  and two challenges of one season share a `season_key` exactly, so the sort key is
	 *  (start, kind, id). Ordering on the start alone reorders itself between reads. */
	private static function collect( $uid, $from, $to ) {
		$items = array_merge(
			self::meeting_items( $uid, $from, $to ),
			self::grant_items( $uid, $from, $to ),
			self::challenge_items( $uid, $from, $to )
		);
		usort( $items, static function ( $a, $b ) {
			return [ $a['start_ts'], $a['kind'], $a['id'] ] <=> [ $b['start_ts'], $b['kind'], $b['id'] ];
		} );
		return $items;
	}

	/** The uniform item. Everything downstream — the list, the .ics, the Google link — reads this
	 *  and nothing else, so there is exactly one place a source's quirks are normalised away. */
	private static function item( $kind, $id, $title, $start, $end, $all_day, $url, $detail, $status = 'confirmed', $seq = 0, $stamp = 0, $uid_tag = '' ) {
		$item = [
			// A composite key, because ids only tell two sources apart if you already know which is which.
			'key'      => $kind . ':' . (int) $id,
			'kind'     => $kind,
			'id'       => (int) $id,
			'title'    => (string) $title,
			'start_ts' => (int) $start,
			// All-day ends are EXCLUSIVE (the midnight after the last day), as RFC 5545 and Google both
			// expect. A one-day deadline therefore ends 86400 later, not at 23:59:59.
			'end_ts'   => (int) $end,
			'all_day'  => (bool) $all_day,
			'url'      => (string) $url,
			'detail'   => (string) $detail,
			'status'   => (string) $status,
			// Feed-only fields. `seq` is what makes a subscribed client accept a change, `stamp` keeps
			// an unchanged event byte-identical between polls, `uid_tag` is its stable identity.
			'seq'      => (int) $seq,
			'stamp_ts' => (int) ( $stamp ?: $start ),
			'uid_tag'  => (string) $uid_tag,
		];
		$item['gcal_url'] = self::gcal_url( $item );
		return $item;
	}

	/** Meetings the member is a guest of. Overlap, not containment: a call that started before the
	 *  window and is still running is very much today's business. */
	private static function meeting_items( $uid, $from, $to ) {
		$rows = Data::all(
			'SELECT m.* FROM ' . Data::t( 'aq_meets' ) . ' m JOIN ' . Data::t( 'aq_meet_guests' ) . ' g'
			. ' ON g.meet_id = m.id AND g.user_id = %d WHERE m.end_ts >= %d AND m.start_ts <= %d'
			. ' ORDER BY m.start_ts ASC LIMIT %d',
			[ (int) $uid, (int) $from, (int) $to, self::PER_SOURCE ]
		);
		$out = [];
		foreach ( $rows as $m ) {
			$cancelled = 'cancelled' === (string) $m['status'];
			$detail    = trim( (string) ( $m['agenda'] ?? '' ) );
			$out[] = self::item(
				'meeting', (int) $m['id'], (string) $m['title'],
				(int) $m['start_ts'], (int) $m['end_ts'], false,
				'/meet/' . (int) $m['id'],
				$detail,
				$cancelled ? 'cancelled' : 'confirmed',
				(int) $m['seq'],
				(int) ( $m['updated'] ?: $m['created'] ?: $m['start_ts'] ),
				// The SAME UID ArtaMeet's own feed emits, deliberately: a member subscribed to both
				// feeds is looking at one meeting, not two.
				'artameet-' . (int) $m['id']
			);
		}
		return $out;
	}

	/**
	 * Deadlines of grants the member holds an active claim on. Date-only in the database, so all-day
	 * here — see day_start() for the timezone convention.
	 *
	 * The window is applied IN SQL, on the string, which works because `deadline` is a zero-padded
	 * 'YYYY-MM-DD' and that sorts identically as text and as a date. Filtering it in PHP instead would
	 * spend the whole LIMIT on the member's oldest claims and then discard them, so a long-serving
	 * member's NEXT deadline is the one that falls off the end — the one item they actually needed.
	 * The day boundaries are the right ones for an all-day item: a deadline landing on the same day as
	 * `$from` ends at the following midnight and so is still ahead of it, and one landing on `$to`'s
	 * day starts at that day's midnight and so is still inside the window.
	 */
	private static function grant_items( $uid, $from, $to ) {
		$rows = Data::all(
			'SELECT g.id, g.slug, g.title, g.funder, g.url, g.deadline, g.summary, g.updated_ts'
			. ' FROM ' . Data::t( 'aq_grants' ) . ' g JOIN ' . Data::t( 'aq_grant_claims' ) . ' c'
			. ' ON c.grant_id = g.id AND c.user_id = %d AND c.status IN ' . Extra::CLAIM_ACTIVE
			. ' WHERE g.active = 1 AND g.deadline >= %s AND g.deadline <= %s'
			. ' ORDER BY g.deadline ASC LIMIT %d',
			[ (int) $uid, gmdate( 'Y-m-d', (int) $from ), gmdate( 'Y-m-d', (int) $to ), self::PER_SOURCE ]
		);
		$out = [];
		foreach ( $rows as $g ) {
			$start = self::day_start( (string) $g['deadline'] );
			// Rolling and invitation-only grants carry a deadline we cannot parse. They are real
			// commitments with no date, and a calendar has nothing true to say about them.
			if ( ! $start ) { continue; }
			$end = $start + 86400;
			if ( $end <= $from || $start > $to ) { continue; }
			$detail = trim( (string) $g['summary'] );
			if ( $g['url'] ) { $detail .= ( '' !== $detail ? "\n" : '' ) . (string) $g['url']; }
			$out[] = self::item(
				'grant', (int) $g['id'],
				'Grant deadline: ' . $g['title'] . ' (' . $g['funder'] . ')',
				$start, $end, true,
				'/sponsors',
				$detail,
				'confirmed', 0,
				(int) ( $g['updated_ts'] ?: $start ),
				// Matches the public grants feed's UID (Extra::serve_ics), for the same reason the
				// meeting UID matches ArtaMeet's: it is the same deadline.
				'grant-' . preg_replace( '/[^a-z0-9-]/', '', (string) $g['slug'] )
			);
		}
		return $out;
	}

	/**
	 * Deadlines of challenges the member entered.
	 *
	 * `season_key` is taken as the deadline verbatim, because it is the value Challenges settles on.
	 * A challenge already settled keeps its date here: the deadline still happened, and a member
	 * looking backwards is owed the day their entry was judged.
	 *
	 * A deadline is an INSTANT. The quarter-hour block is a nominal length so a calendar has
	 * something to draw and RFC 5545 has a DTEND later than its DTSTART — the moment that matters is
	 * always the start.
	 */
	private static function challenge_items( $uid, $from, $to ) {
		$rows = Data::all(
			'SELECT DISTINCT c.id, c.kind, c.title, c.season_key, c.status, c.created, c.owner_uid'
			. ' FROM ' . Data::t( 'aq_challenges' ) . ' c JOIN ' . Data::t( 'aq_challenge_entries' ) . ' e'
			. ' ON e.challenge_id = c.id AND e.author_id = %d'
			. ' WHERE c.season_key >= %d AND c.season_key <= %d ORDER BY c.season_key ASC LIMIT %d',
			[ (int) $uid, (int) $from, (int) $to, self::PER_SOURCE ]
		);
		$out = [];
		foreach ( $rows as $c ) {
			$start = (int) $c['season_key'];
			if ( $start <= 0 ) { continue; }
			$settled = 'open' !== (string) $c['status'];
			$out[] = self::item(
				'challenge', (int) $c['id'],
				'Challenge closes: ' . $c['title'],
				$start, $start + 900, false,
				'/challenges',
				'The most-hearted entry takes the pool at this moment'
					. ( $settled ? '. This one has been settled.' : '.' ),
				'confirmed', 0,
				(int) ( $c['created'] ?: $start ),
				'artachallenge-' . (int) $c['id']
			);
		}
		return $out;
	}

	/** Midnight UTC on a 'YYYY-MM-DD' day, or 0 when the string is not a date. All-day events are
	 *  FLOATING in RFC 5545 — they have no zone at all — so UTC midnight is a sorting convention
	 *  here and never reaches the feed, which emits the bare Ymd. */
	private static function day_start( $ymd ) {
		if ( ! preg_match( '/^\d{4}-\d{2}-\d{2}$/', (string) $ymd ) ) { return 0; }
		$ts = strtotime( $ymd . ' 00:00:00 UTC' );
		return $ts ? (int) $ts : 0;
	}

	// ── Subscription ────────────────────────────────────────────────────────

	/** The signed pair for one member. Meetings::cal_key is the ONE calendar secret — this feed and
	 *  /meet.ics are signed identically, so POST meet/cal revokes both in a single rotation. */
	private static function cal_urls( $uid ) {
		$ics = home_url( '/calendar.ics?u=' . (int) $uid . '&k=' . Meetings::cal_key( (int) $uid ) );
		return [
			'ics'    => $ics,
			'webcal' => preg_replace( '#^https?://#i', 'webcal://', $ics ),
		];
	}

	/**
	 * GET calendar/cal — the caller's own subscription URLs.
	 *
	 * `rev` and the meetings-only URL come from Meetings::cal rather than being re-derived: the
	 * revision counter lives in ArtaMeet's user meta, and reading it from two places is how the day
	 * arrives when one of them is rotated and the other is not. There is deliberately no POST here —
	 * rotation stays at POST meet/cal, because there is only one secret to rotate.
	 */
	public static function cal( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$c    = self::cal_urls( $uid );
		$meet = Meetings::cal( $req );
		$meet = is_array( $meet ) ? $meet : [];
		return [
			'ok'     => true,
			// `url` and `ics` are one value under two names, matching meet/cal exactly, so a panel
			// written against either payload reads this one too.
			'url'    => $c['ics'],
			'ics'    => $c['ics'],
			'webcal' => $c['webcal'],
			'rev'    => (int) ( $meet['rev'] ?? 1 ),
			// The narrower feed, for a member who wants only their meetings in a shared work calendar.
			'meet'   => (string) ( $meet['ics'] ?? '' ),
		];
	}

	/**
	 * /calendar.ics?u=<uid>&k=<32 hex> — the agenda as one VCALENDAR.
	 *
	 * Served from template_redirect (aquest.php) because calendar clients sniff the .ics extension
	 * and /wp-json/… has none. Read-only, cookie-less, and it reaches the same distance backwards
	 * and forwards as ArtaMeet's feed (Meetings::ICS_PAST_S / ICS_FUTURE_S) so the two never
	 * disagree about what is still worth showing.
	 */
	public static function serve_ics() {
		$u = isset( $_GET['u'] ) ? (int) $_GET['u'] : 0;
		$k = isset( $_GET['k'] ) ? (string) wp_unslash( $_GET['k'] ) : '';
		if ( ! $u || ! preg_match( '/^[a-f0-9]{32}$/', $k ) ) { self::ics_deny(); }
		// SIGNATURE FIRST, THROTTLE SECOND — the bucket name contains the caller's own `u`, so the
		// other order lets an unauthenticated stranger mint unbounded transient rows (wp_options rows,
		// on a site with no persistent object cache) by varying a number in a URL. Nothing an unsigned
		// request says may reach storage. Constant-time, and the refusal never varies: a wrong key and
		// an unknown member must be indistinguishable, or this becomes a membership oracle.
		if ( ! hash_equals( Meetings::cal_key( $u ), $k ) ) { self::ics_deny(); }
		if ( Rest::throttle( 'aq_calics_' . $u, 120, 3600 ) ) { self::ics_deny(); }

		$now   = Data::now();
		$items = self::collect( $u, $now - Meetings::ICS_PAST_S, $now + Meetings::ICS_FUTURE_S );

		$lines = [
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'PRODID:-//ArtaQuest//ArtaCalendar//EN',
			'CALSCALE:GREGORIAN',
			'METHOD:PUBLISH',
			'X-WR-CALNAME:ArtaQuest — my calendar',
			'X-WR-TIMEZONE:UTC',
			'X-PUBLISHED-TTL:PT1H',
			'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
		];
		foreach ( $items as $i ) { $lines = array_merge( $lines, self::vevent( $i ) ); }
		$lines[] = 'END:VCALENDAR';

		// Written by hand from here down. WP core attaches no-cache headers on a 404 before
		// template_redirect runs, so a handler on an otherwise-404 path has to remove them explicitly —
		// and nocache_headers() is exactly what makes the grants feed an always-MISS at the edge.
		// `private` forbids the shared edge from storing one member's calendar.
		while ( ob_get_level() > 0 ) { @ob_end_clean(); }
		header_remove( 'Cache-Control' );
		header_remove( 'Pragma' );
		header_remove( 'Expires' );
		status_header( 200 );
		header( 'Content-Type: text/calendar; charset=utf-8' );
		header( 'Content-Disposition: inline; filename="artaquest-calendar.ics"' );
		header( 'Cache-Control: private, max-age=300' );
		echo implode( "\r\n", $lines ) . "\r\n";
		exit;
	}

	private static function ics_deny() {
		while ( ob_get_level() > 0 ) { @ob_end_clean(); }
		status_header( 403 );
		header( 'Content-Type: text/plain; charset=utf-8' );
		header( 'Cache-Control: private, no-store' );
		echo "Forbidden\r\n";
		exit;
	}

	/**
	 * One VEVENT, from one item — all-day or timed, whatever the source was.
	 *
	 * An all-day event carries DATE values and no zone (RFC 5545 §3.3.4); a timed one carries UTC
	 * instants. Getting that wrong is the classic calendar bug: a deadline emitted as a UTC midnight
	 * DATE-TIME lands on the previous evening for every member west of Greenwich.
	 *
	 * UID and DTSTAMP are DERIVED from the row, never stored: ids are never reused, so the UID
	 * survives a retime and a cancellation (which is what an in-place update requires), and a DTSTAMP
	 * that tracks the row's own last change keeps an unchanged event byte-identical on every poll.
	 */
	private static function vevent( $i ) {
		// ArtaMeet builds a richer meeting VEVENT (the host's zone spelled out, the seat count, the
		// end-to-end-encryption promise) but keeps it private. Defer to it the moment it is public —
		// two implementations of one event is how one of them goes stale.
		if ( 'meeting' === $i['kind'] && is_callable( [ Meetings::class, 'vevent' ] ) ) {
			$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_meets' ) . ' WHERE id = %d', [ (int) $i['id'] ] );
			if ( $row ) { return Meetings::vevent( $row ); }
		}

		$cancel = 'cancelled' === (string) $i['status'];
		$link   = home_url( $i['url'] );
		$desc   = trim( (string) $i['detail'] );
		$desc  .= ( '' !== $desc ? "\n\n" : '' ) . 'Open: ' . $link;

		$out = [
			'BEGIN:VEVENT',
			Extra::ics_fold( 'UID:' . $i['uid_tag'] . '@artaquest.org' ),
			'SEQUENCE:' . (int) $i['seq'],
			'DTSTAMP:' . gmdate( 'Ymd\THis\Z', (int) $i['stamp_ts'] ),
			'LAST-MODIFIED:' . gmdate( 'Ymd\THis\Z', (int) $i['stamp_ts'] ),
		];
		if ( $i['all_day'] ) {
			$out[] = 'DTSTART;VALUE=DATE:' . gmdate( 'Ymd', (int) $i['start_ts'] );
			$out[] = 'DTEND;VALUE=DATE:' . gmdate( 'Ymd', (int) $i['end_ts'] );
		} else {
			$out[] = 'DTSTART:' . gmdate( 'Ymd\THis\Z', (int) $i['start_ts'] );
			$out[] = 'DTEND:' . gmdate( 'Ymd\THis\Z', (int) $i['end_ts'] );
		}
		$out[] = 'STATUS:' . ( $cancel ? 'CANCELLED' : 'CONFIRMED' );
		$out[] = Extra::ics_fold( 'SUMMARY:' . Extra::ics_esc( ( $cancel ? 'Cancelled: ' : '' ) . (string) $i['title'] ) );
		$out[] = Extra::ics_fold( 'DESCRIPTION:' . Extra::ics_esc( $desc ) );
		$out[] = Extra::ics_fold( 'URL:' . Extra::ics_esc( $link ) );
		$out[] = 'ORGANIZER;CN=ArtaQuest:mailto:support@artaquest.org';

		// The alarms fire on the member's own device with no server involved, which is what carries
		// the reminder when our cron is late. A dated deadline warns a week and a day out; a timed
		// thing warns the day before and half an hour before, as ArtaMeet's own feed does.
		if ( ! $cancel ) {
			$alarms = $i['all_day']
				? [ '-P7D' => 'A week to ' . $i['title'], '-P1D' => 'Tomorrow: ' . $i['title'] ]
				: [ '-P1D' => 'Tomorrow: ' . $i['title'], '-PT30M' => 'In 30 minutes: ' . $i['title'] ];
			foreach ( $alarms as $trigger => $text ) {
				$out[] = 'BEGIN:VALARM';
				$out[] = 'TRIGGER:' . $trigger;
				$out[] = 'ACTION:DISPLAY';
				$out[] = Extra::ics_fold( 'DESCRIPTION:' . Extra::ics_esc( $text ) );
				$out[] = 'END:VALARM';
			}
		}
		$out[] = 'END:VEVENT';
		return $out;
	}

	// ── Google Calendar ─────────────────────────────────────────────────────

	/**
	 * A "+ Google Calendar" one-click TEMPLATE link for any item, all-day or timed.
	 *
	 * The `dates` grammar differs by kind and Google is unforgiving about it: an all-day pair is
	 * YYYYMMDD/YYYYMMDD with an EXCLUSIVE end (the same convention Extra::gcal_link has used for the
	 * grant deadlines all along), a timed pair is two UTC instants with the trailing Z. Send a timed
	 * value in the all-day slot and the event silently lands on the wrong day.
	 */
	public static function gcal_url( $item ) {
		$start = (int) ( $item['start_ts'] ?? 0 );
		$end   = (int) ( $item['end_ts'] ?? 0 );
		if ( $start <= 0 ) { return ''; }
		if ( $end <= $start ) { $end = $start + ( empty( $item['all_day'] ) ? 900 : 86400 ); }

		$dates = empty( $item['all_day'] )
			? gmdate( 'Ymd\THis\Z', $start ) . '/' . gmdate( 'Ymd\THis\Z', $end )
			: gmdate( 'Ymd', $start ) . '/' . gmdate( 'Ymd', $end );

		$link = isset( $item['url'] ) && '' !== $item['url'] ? home_url( (string) $item['url'] ) : '';
		return 'https://calendar.google.com/calendar/render?' . http_build_query( [
			'action'   => 'TEMPLATE',
			'text'     => (string) ( $item['title'] ?? '' ),
			'dates'    => $dates,
			'details'  => trim( (string) ( $item['detail'] ?? '' ) ) . ( $link ? "\n\n" . $link : '' ),
			'location' => $link,
		] );
	}
}
