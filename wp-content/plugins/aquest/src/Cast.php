<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaCast — "come on the show".
 *
 * The host talks with couples about how they stayed together. This class is the desk a couple
 * walks up to: one of them asks to appear, both of them enter the few facts the episode frame
 * airs (a name, one line in their own words, a date and place of birth, a photograph, the year
 * they married, a handful of milestones), the other half is invited by a single-use link, they
 * see the thumbnail and the episode frame drawn from those facts as they type, and they take a
 * recording slot out of the host's published hours. That slot IS an ArtaMeet — an ordinary,
 * end-to-end encrypted meeting with the host and both of them on the guest list.
 *
 * THREE THINGS RUN THROUGH EVERY LINE HERE.
 *
 *  1. NOTHING IS A SECOND SYSTEM. The host's hours are an ordinary booking rule (Booking.php,
 *     slug 'artacast'); the recording is an ordinary meeting created THROUGH Booking::take — the
 *     same lock, the same UNIQUE ctx_key, the same letters, the same room bound at T-15m — and
 *     the partner is seated into it the way any guest is. A second implementation of any of those
 *     would be wrong about one of them within a month.
 *
 *  2. THE PARTNER IS ASKED, NEVER ENROLLED. Somebody typing their spouse's email does not put that
 *     spouse in a meeting. A single-use secret goes to the address (hash stored, raw only in the
 *     letter and shown once to the requester, who chose the address); the partner's own click,
 *     signed in as themselves, is what seats them. The link is spent atomically and expires.
 *
 *  3. THE PREVIEW IS THE BROWSER'S. The server holds facts, never a rendered frame: the thumbnail
 *     and the episode frame are drawn client-side from this row, so they are live as the couple
 *     types and cost nothing here. What is stored is what the kit needs to cut the episode.
 */
final class Cast {

	/** The host's handle. An option so the show can change hands without a deploy; never a secret. */
	const HOST_OPTION = 'aq_artacast_host';
	const HOST_DEFAULT = 'arash';

	/** The booking rule the show runs on — one of the host's ordinary aq_meet_rules rows. */
	const RULE_SLUG = 'artacast';

	/** What host_open() writes when the host opens hours from the show page. Every value is one
	 *  Booking::set_rule will accept; the tz is the host's own browser zone, sent with the call. */
	/** NOT A TIMETABLE. The window is the whole waking day, every day; what actually decides a slot
	 *  is the host's calendar — every meeting they are in blocks it (Booking::busy). So a couple sees
	 *  "when the host is free", never "the show's hours". */
	const RULE_DEFAULTS = [
		'title'      => 'ArtaCast recording',
		'blurb'      => 'A recorded conversation with a couple about how they stayed together — an encrypted ArtaMeet call.',
		'minutes'    => 90,
		'days'       => '1111111',
		'from_min'   => 540,   // 09:00
		'to_min'     => 1260,  // 21:00
		'buffer_min' => 30,
		'notice_h'   => 24,
		'horizon_d'  => 60,
		'seats'      => 3,     // the host and both of them
	];

	/** A member who volunteered to host. The primary host (HOST_OPTION) is always one. */
	const VOLUNTEER_META = 'aq_cast_host';

	const NAME_MAX      = 60;
	const SUBTITLE_MAX  = 40;
	const PLACE_MAX     = 40;
	const STORY_MAX     = 800;
	const ROWS_MAX      = 6;
	const ROW_LABEL_MAX = 40;
	const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

	/** A partner's link works for a fortnight and once. */
	const INVITE_TTL_S = 14 * 86400;

	// ── Who ────────────────────────────────────────────────────────────────

	/** The host, or null when the configured handle resolves to nobody. */
	public static function host() {
		$slug = sanitize_title( (string) get_option( self::HOST_OPTION, self::HOST_DEFAULT ) );
		if ( '' === $slug ) { $slug = self::HOST_DEFAULT; }
		$u = get_user_by( 'slug', $slug );
		return $u ?: null;
	}

	/** Members an operator has barred from hosting — option `aq_artacast_host_block`, a list of ids
	 *  (`wp option update aq_artacast_host_block '[123]' --format=json`). Volunteering is open to every
	 *  member, and this is the one lever when that openness is abused: a barred member is not listed,
	 *  cannot volunteer, and their live requests fall back to the primary host (host_of). */
	private static function blocked( $uid ) {
		$list = get_option( 'aq_artacast_host_block', [] );
		return in_array( (int) $uid, array_map( 'intval', is_array( $list ) ? $list : [] ), true );
	}

	/** Every host, primary first: the configured one plus every volunteer. Small by construction. */
	public static function hosts() {
		$out = [];
		$h = self::host();
		if ( $h ) { $out[ (int) $h->ID ] = $h; }
		foreach ( get_users( [ 'meta_key' => self::VOLUNTEER_META, 'meta_value' => '1', 'number' => 50, 'orderby' => 'ID' ] ) as $u ) {
			if ( ! self::blocked( $u->ID ) ) { $out[ (int) $u->ID ] = $u; }
		}
		return array_values( $out );
	}

	/** A member whose own episode is booked (or was recorded this week) — their shelf carries a grant
	 *  for their isolated camera track. Read by Media::capacity. */
	public static function is_live_guest( $uid ) {
		$uid = (int) $uid;
		if ( $uid <= 0 ) { return false; }
		return (bool) Data::col(
			'SELECT 1 FROM ' . Data::t( 'aq_cast_requests' ) . " WHERE (requester_id = %d OR partner_id = %d) AND status = 'scheduled' AND meet_id > 0 AND (start_ts = 0 OR start_ts > %d) LIMIT 1",
			[ $uid, $uid, Data::now() - 7 * 86400 ]
		);
	}

	/** The first host who is not this member — the default host for a host's own request. */
	public static function other_host( $uid ) {
		foreach ( self::hosts() as $hu ) { if ( (int) $hu->ID !== (int) $uid ) { return $hu; } }
		return null;
	}

	/** Is this member a host — one whose shelf holds episodes and whose device records. */
	public static function is_host_uid( $uid ) {
		$uid = (int) $uid;
		if ( $uid <= 0 ) { return false; }
		$h = self::host();
		if ( $h && (int) $h->ID === $uid ) { return true; }
		return (bool) get_user_meta( $uid, self::VOLUNTEER_META, true ) && ! self::blocked( $uid );
	}

	/** The host of one request: the one the couple chose, if they are still hosting, else the primary. */
	private static function host_of( $r ) {
		$hid = (int) ( $r['host_id'] ?? 0 );
		if ( $hid > 0 && self::is_host_uid( $hid ) ) { $u = get_userdata( $hid ); if ( $u ) { return $u; } }
		return self::host();
	}

	/** Operators see the inbox too — the host is one person, and the show should survive a week of
	 *  their absence — but they never become the host: the meeting is always the host's. */
	private static function is_host( $uid ) {
		return $uid > 0 && ( self::is_host_uid( $uid ) || current_user_can( 'manage_options' ) );
	}

	/** The same four keys ArtaMeet's guest card and the booking page use. */
	private static function card( $uid ) {
		$uid = (int) $uid;
		if ( $uid <= 0 ) { return null; }
		$u = get_userdata( $uid );
		return [
			'id'     => $uid,
			'name'   => $u ? $u->display_name : 'Quester',
			'slug'   => $u ? $u->user_nicename : '',
			'avatar' => class_exists( '\\AQ\\Verify' ) ? Verify::avatar_url( $uid, 96 ) : '',
		];
	}

	/** The show's rule as the public booking page describes it — read through Booking::page so the
	 *  shape is the one the SPA already holds for a booking type, and so nothing here has to know
	 *  how a rule is stored. Null when the host has not opened hours (or has paused them). */
	private static function rule( $h = null ) {
		$h = $h ?: self::host();
		if ( ! $h ) { return null; }
		$req = new \WP_REST_Request();
		$req->set_param( 'user', (string) $h->ID );
		$page = Booking::page( $req );
		if ( ! is_array( $page ) ) { return null; }
		foreach ( (array) ( $page['types'] ?? [] ) as $t ) {
			if ( self::RULE_SLUG === (string) ( $t['slug'] ?? '' ) && ! empty( $t['active'] ) ) { return $t; }
		}
		return null;
	}

	// ── Rows ───────────────────────────────────────────────────────────────

	private static function row( $id ) {
		$id = (int) $id;
		return $id > 0 ? Data::one( 'SELECT * FROM ' . Data::t( 'aq_cast_requests' ) . ' WHERE id = %d', [ $id ] ) : null;
	}

	/** The member's LIVE request — the one they asked for, or the one they were invited into.
	 *  Cancelled rows are history and never returned here, which is what lets a couple start
	 *  again after withdrawing. Newest first, because a member holds at most one live row by
	 *  construction (save() refuses a second) and the ordering only matters if that ever breaks. */
	private static function mine( $uid ) {
		$uid = (int) $uid;
		if ( $uid <= 0 ) { return null; }
		return Data::one(
			'SELECT * FROM ' . Data::t( 'aq_cast_requests' )
			. " WHERE (requester_id = %d OR partner_id = %d) AND status <> 'cancelled' ORDER BY id DESC LIMIT 1",
			[ $uid, $uid ]
		);
	}

	private static function side( $r, $s ) {
		$rows = Data::dec( (string) ( $r[ $s . '_rows' ] ?? '' ) );
		return [
			'name'     => (string) ( $r[ $s . '_name' ] ?? '' ),
			'subtitle' => (string) ( $r[ $s . '_subtitle' ] ?? '' ),
			'born'     => (string) ( $r[ $s . '_born' ] ?? '' ),
			'place'    => (string) ( $r[ $s . '_place' ] ?? '' ),
			'photo'    => (string) ( $r[ $s . '_photo' ] ?? '' ),
			'rows'     => is_array( $rows ) ? array_values( $rows ) : [],
		];
	}

	/** A side is COMPLETE when the frame can be cut from it: a name, the one line under it, and a
	 *  photograph. Birth and milestones make the timelines richer and are never a gate. */
	private static function complete( $r, $s ) {
		return '' !== trim( (string) ( $r[ $s . '_name' ] ?? '' ) )
			&& '' !== trim( (string) ( $r[ $s . '_subtitle' ] ?? '' ) )
			&& '' !== (string) ( $r[ $s . '_photo' ] ?? '' );
	}

	private static function role_of( $r, $uid ) {
		$uid = (int) $uid;
		if ( $uid > 0 && (int) $r['requester_id'] === $uid ) { return 'a'; }
		if ( $uid > 0 && (int) $r['partner_id'] === $uid ) { return 'b'; }
		if ( self::is_host( $uid ) ) { return 'host'; }
		return '';
	}

	/** The guests' isolated tracks, with shelf URLs for the people party to the episode. */
	private static function iso_list( $r, $role ) {
		if ( '' === $role ) { return []; }
		$out = [];
		foreach ( (array) ( Data::dec( (string) ( $r['iso_files'] ?? '' ) ) ?: [] ) as $t ) {
			$m = Data::one( 'SELECT id, store_key, name, bytes, state FROM ' . Data::t( 'aq_media' ) . ' WHERE id = %d', [ (int) ( $t['media_id'] ?? 0 ) ] );
			if ( ! $m || 'ready' !== (string) $m['state'] ) { continue; }
			$out[] = [ 'uid' => (int) ( $t['uid'] ?? 0 ), 'name' => (string) $m['name'], 'bytes' => (int) $m['bytes'], 'url' => Media::url( (string) $m['store_key'] ) ];
		}
		return $out;
	}

	/**
	 * The API shape of one request, for one viewer. Column names where the SPA needs them, and
	 * nothing a viewer is not party to: the invite hash never leaves (it is a live credential's
	 * verifier), and the partner's typed address is shown to the two people it concerns and the
	 * host — never to a stranger, who cannot reach this row at all.
	 */
	private static function payload( $r, $uid ) {
		$now  = Data::now();
		$role = self::role_of( $r, $uid );
		$live = '' !== (string) $r['invite_token'] && (int) $r['invite_exp'] > $now && (int) $r['partner_id'] === 0;
		$meet = null;
		if ( (int) $r['meet_id'] > 0 ) {
			$m = Data::one( 'SELECT id, start_ts, end_ts, tz, status FROM ' . Data::t( 'aq_meets' ) . ' WHERE id = %d', [ (int) $r['meet_id'] ] );
			if ( $m ) {
				$meet = [
					'id'       => (int) $m['id'],
					'start_ts' => (int) $m['start_ts'],
					'end_ts'   => (int) $m['end_ts'],
					'tz'       => (string) $m['tz'],
					'status'   => (string) $m['status'],
					'url'      => '/meet/' . (int) $m['id'],
				];
			}
		}
		$a_ok = self::complete( $r, 'a' );
		$b_ok = self::complete( $r, 'b' );
		$hu = self::host_of( $r );
		return [
			'id'        => (int) $r['id'],
			'status'    => (string) $r['status'],
			'role'      => $role,
			'host'      => $hu ? self::card( $hu->ID ) : null,
			'requester' => self::card( (int) $r['requester_id'] ),
			'partner'   => (int) $r['partner_id'] > 0 ? self::card( (int) $r['partner_id'] ) : null,
			'a'         => self::side( $r, 'a' ),
			'b'         => self::side( $r, 'b' ),
			'b_email'   => (string) $r['b_email'],
			'married_y' => (int) $r['married_y'],
			'story'     => (string) ( $r['story'] ?? '' ),
			'invite'    => [
				'sent'     => (int) $r['invite_sent'],
				'accepted' => (int) $r['invite_accepted'],
				'pending'  => $live,
				'expires'  => $live ? (int) $r['invite_exp'] : 0,
			],
			'meet'      => $meet,
			'recorded'  => [ 'at' => (int) ( $r['recorded_at'] ?? 0 ), 'note' => (string) ( $r['recorded_note'] ?? '' ) ],
			// One word the couple can read without the host's detail: nothing · recorded · finishing · finished
			'stage'     => (int) ( $r['pipe_done'] ?? 0 ) > 0 && 'done' === (string) ( $r['pipe_state'] ?? '' ) ? 'finished'
				: ( in_array( (string) ( $r['pipe_state'] ?? '' ), [ 'queued', 'running', 'failed' ], true ) ? 'finishing'
				: ( (int) ( $r['recorded_at'] ?? 0 ) > 0 ? 'recorded' : '' ) ),
			'pipeline'  => [
				'state'   => (string) ( $r['pipe_state'] ?? '' ),
				'note'    => (string) ( $r['pipe_note'] ?? '' ),
				'started' => (int) ( $r['pipe_started'] ?? 0 ),
				'done'    => (int) ( $r['pipe_done'] ?? 0 ),
				'files'   => array_values( array_filter( (array) ( Data::dec( (string) ( $r['final_files'] ?? '' ) ) ?: [] ) ) ),
				'raw'     => (int) ( $r['raw_media_id'] ?? 0 ),
				'thumb'   => (string) ( $r['thumb_url'] ?? '' ),
				'kernel'  => '' !== (string) ( $r['pipe_kernel'] ?? '' ) ? Kaggle::kernel_url( (string) $r['pipe_kernel'] ) : '',
				'tries'   => (int) ( $r['pipe_tries'] ?? 0 ),
				'iso'     => self::iso_list( $r, $role ),
				'retrying' => 'failed' === (string) ( $r['pipe_state'] ?? '' ) && str_starts_with( (string) ( $r['pipe_note'] ?? '' ), 'Kaggle refused' ) && (int) ( $r['pipe_tries'] ?? 0 ) < self::PIPE_TRIES,
			],
			'complete'  => [ 'a' => $a_ok, 'b' => $b_ok ],
			'created'   => (int) $r['created'],
			'updated'   => (int) $r['updated'],
		];
	}

	// ── Reading ────────────────────────────────────────────────────────────

	/**
	 * GET artacast/page [?id=] — the show, the host, whether hours are open, and the caller's own
	 * request if they have one. Public: a stranger sees the show and the host; a member sees their
	 * row; the host (or an operator) may name any row by id.
	 */
	public static function page( $req ) {
		if ( Rest::throttle( 'aq_cast_page', 120, 300 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = Rest::uid();
		$r = null;
		$want = Rest::pint( $req, 'id', 0 );
		if ( $want > 0 && self::is_host( $uid ) ) { $r = self::row( $want ); }
		if ( ! $r && $uid ) { $r = self::mine( $uid ); }

		// The host that matters is the one on MY request; before there is one, the primary host —
		// or, for a host looking at the page, the first OTHER host, since nobody hosts themselves.
		$h    = $r ? self::host_of( $r ) : self::host();
		if ( ! $r && $h && $uid && (int) $h->ID === $uid ) { $h = self::other_host( $uid ) ?: $h; }
		$rule = self::rule( $h );
		$card = $h ? ( self::card( $h->ID ) + [ 'tz' => (string) ( $rule['tz'] ?? '' ) ] ) : null;
		$hosts = [];
		foreach ( self::hosts() as $hu ) { $hosts[] = self::card( $hu->ID ) + [ 'tz' => (string) ( self::rule( $hu )['tz'] ?? '' ), 'open' => (bool) self::rule( $hu ) ]; }

		return [
			'ok'      => true,
			'host'    => $card,
			'hosts'   => $hosts,
			'rule'    => $rule,
			'open'    => (bool) $rule,
			'me'      => $uid,
			// TWO DIFFERENT FACTS. `is_host` is "may see the requests" — hosts AND operators. `hosting`
			// is "has a calendar couples book" — hosts only. The page conflated them, so an operator who
			// is not a host was shown "Open recording hours" and then refused by host-open.
			'is_host' => self::is_host( $uid ),
			'hosting' => self::is_host_uid( $uid ),
			'operator' => $uid > 0 && current_user_can( 'manage_options' ),
			'request' => $r ? self::payload( $r, $uid ) : null,
			'now'     => Data::now(),
		];
	}

	// ── Writing the facts ──────────────────────────────────────────────────

	/** 'YYYY-MM-DD' that names a real day, or ''. A wrong date airs on the timeline's first row. */
	private static function clean_date( $v ) {
		$v = trim( (string) $v );
		if ( '' === $v ) { return ''; }
		if ( ! preg_match( '/^(\d{4})-(\d{2})-(\d{2})$/', $v, $m ) ) { return null; }
		if ( ! checkdate( (int) $m[2], (int) $m[3], (int) $m[1] ) || (int) $m[1] < 1900 || (int) $m[1] > (int) gmdate( 'Y' ) ) { return null; }
		return $v;
	}

	private static function clean_text( $v, $max ) {
		return mb_substr( trim( preg_replace( '/\s+/u', ' ', wp_strip_all_tags( (string) $v ) ) ), 0, (int) $max );
	}

	/** Up to ROWS_MAX milestones as [{y, l}], years plausible, labels one line. Anything else is
	 *  dropped rather than refused — a milestone is decoration on the frame, not a gate. */
	private static function clean_rows( $v ) {
		$out = [];
		foreach ( ( is_array( $v ) ? $v : [] ) as $row ) {
			if ( ! is_array( $row ) ) { continue; }
			$y = (int) ( $row['y'] ?? 0 );
			$l = self::clean_text( $row['l'] ?? '', self::ROW_LABEL_MAX );
			if ( $y < 1900 || $y > (int) gmdate( 'Y' ) + 1 || '' === $l ) { continue; }
			$out[] = [ 'y' => $y, 'l' => $l ];
			if ( count( $out ) >= self::ROWS_MAX ) { break; }
		}
		usort( $out, fn( $p, $q ) => $p['y'] <=> $q['y'] );
		return $out;
	}

	/** The columns one side's fields map to, applied only for the keys the request carried — so a
	 *  page that saves one control cannot blank the others. Returns an error string or ''. */
	private static function apply_side( &$data, $in, $s ) {
		if ( ! is_array( $in ) ) { return ''; }
		if ( array_key_exists( 'name', $in ) )     { $data[ $s . '_name' ]     = self::clean_text( $in['name'], self::NAME_MAX ); }
		if ( array_key_exists( 'subtitle', $in ) ) { $data[ $s . '_subtitle' ] = self::clean_text( $in['subtitle'], self::SUBTITLE_MAX ); }
		if ( array_key_exists( 'place', $in ) )    { $data[ $s . '_place' ]    = self::clean_text( $in['place'], self::PLACE_MAX ); }
		if ( array_key_exists( 'rows', $in ) )     { $data[ $s . '_rows' ]     = Data::enc( self::clean_rows( $in['rows'] ) ); }
		if ( array_key_exists( 'born', $in ) ) {
			$d = self::clean_date( $in['born'] );
			if ( null === $d ) { return 'That date of birth is not a real day.'; }
			$data[ $s . '_born' ] = $d;
		}
		return '';
	}

	/**
	 * POST artacast/save {a?, b?, married_y?, story?, b_email?} — create my request, or update it.
	 *
	 * The requester writes both sides (they are filling the form for the two of them); the partner,
	 * once they have accepted, writes their OWN side and nothing else — the year and the story are
	 * the requester's words, and one person's edit must not overwrite the other's mid-sentence.
	 * Edits are allowed after scheduling: a better photograph before the recording is the point.
	 */
	public static function save( $req ) {
		if ( Rest::throttle( 'aq_cast_save', 60, 300 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$h = self::host();
		if ( ! $h ) { return Rest::err( 'no_host', 'The show has no host configured yet.', 503 ); }

		$now = Data::now();
		$r   = self::mine( $uid );
		$role = $r ? self::role_of( $r, $uid ) : 'a';
		$data = [ 'updated' => $now ];

		if ( 'a' === $role ) {
			if ( null !== Rest::p( $req, 'host', null ) ) {
				$hid = Rest::pint( $req, 'host', 0 );
				if ( ! self::is_host_uid( $hid ) ) { return Rest::err( 'bad_host', 'That member is not hosting.', 400 ); }
				if ( $hid === $uid ) { return Rest::err( 'own_show', 'You cannot host your own episode.', 400 ); }
				if ( $r && (int) $r['meet_id'] > 0 ) { return Rest::err( 'booked', 'The recording is booked with your host already — withdraw to change hosts.', 409 ); }
				$data['host_id'] = $hid;
			}
			$e = self::apply_side( $data, Rest::p( $req, 'a', null ), 'a' );
			if ( '' === $e ) { $e = self::apply_side( $data, Rest::p( $req, 'b', null ), 'b' ); }
			if ( '' !== $e ) { return Rest::err( 'bad_date', $e, 400 ); }
			if ( null !== Rest::p( $req, 'married_y', null ) ) {
				$y = Rest::pint( $req, 'married_y', 0 );
				if ( 0 !== $y && ( $y < 1900 || $y > (int) gmdate( 'Y' ) ) ) { return Rest::err( 'bad_year', 'Give the year you married as four digits.', 400 ); }
				$data['married_y'] = $y;
			}
			if ( null !== Rest::p( $req, 'story', null ) ) {
				$data['story'] = mb_substr( trim( wp_strip_all_tags( (string) Rest::p( $req, 'story', '' ) ) ), 0, self::STORY_MAX );
			}
			if ( null !== Rest::p( $req, 'b_email', null ) ) {
				$em = strtolower( trim( (string) Rest::p( $req, 'b_email', '' ) ) );
				if ( '' !== $em && ! is_email( $em ) ) { return Rest::err( 'bad_email', 'That does not look like an email address.', 400 ); }
				$me = get_userdata( $uid );
				if ( $me && '' !== $em && strtolower( (string) $me->user_email ) === $em ) {
					return Rest::err( 'own_email', 'That is your own address — enter your partner’s.', 400 );
				}
				// A changed address voids a link already sent: the old letter must not seat whoever
				// the requester decided against.
				if ( $r && $em !== (string) $r['b_email'] ) { $data['invite_token'] = ''; $data['invite_exp'] = 0; }
				$data['b_email'] = $em;
			}
		} else {
			$e = self::apply_side( $data, Rest::p( $req, 'b', null ), 'b' );
			if ( '' !== $e ) { return Rest::err( 'bad_date', $e, 400 ); }
		}

		if ( ! $r ) {
			// Nobody hosts their own episode — but a host may certainly APPEAR on one. A new request
			// from a host defaults to the first other host; only with nobody else hosting is it refused.
			if ( (int) ( $data['host_id'] ?? $h->ID ) === $uid ) {
				$other = self::other_host( $uid );
				if ( ! $other ) { return Rest::err( 'own_show', 'You are the only host, so nobody can host you yet. Ask a member to volunteer to host first.', 400 ); }
				$data['host_id'] = (int) $other->ID;
			}
			// A fresh row starts with what we already know about the requester: their public name and
			// their stated birthday — both are theirs to correct on the form.
			$me = get_userdata( $uid );
			$full = function_exists( 'aq_profile_name' ) ? (string) aq_profile_name( $me ) : '';
			$data += [
				'requester_id' => $uid,
				'partner_id'   => 0,
				'host_id'      => (int) ( $data['host_id'] ?? $h->ID ),
				'status'       => 'draft',
				'a_name'       => self::clean_text( '' !== $full ? $full : ( $me ? $me->display_name : '' ), self::NAME_MAX ),
				'a_born'       => (string) ( self::clean_date( get_user_meta( $uid, 'aq_birthday', true ) ) ?? '' ),
				'a_rows'       => '[]',
				'b_rows'       => '[]',
				'created'      => $now,
			];
			$id = Data::insert( 'aq_cast_requests', $data );
			if ( ! $id ) { return Rest::err( 'server_error', 'Could not save that.', 500 ); }
			$r = self::row( $id );
		} else {
			Data::update( 'aq_cast_requests', $data, [ 'id' => (int) $r['id'] ] );
			$r = self::row( (int) $r['id'] );
		}
		return [ 'ok' => true, 'request' => self::payload( $r, $uid ) ];
	}

	/**
	 * POST artacast/photo {side, image} — one portrait, as a data URL, stored like an avatar.
	 * The requester may set either side; the partner their own. The previous file is unlinked so
	 * an abandoned draft does not leave a trail of faces in the uploads directory.
	 */
	public static function photo( $req ) {
		if ( Rest::throttle( 'aq_cast_photo', 30, 3600 ) ) { return Rest::err( 'rate_limited', 'Too many uploads. Try again later.', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$r = self::mine( $uid );
		if ( ! $r ) { return Rest::err( 'no_request', 'Start your request first.', 404 ); }
		$role = self::role_of( $r, $uid );
		$side = 'b' === (string) Rest::p( $req, 'side', 'a' ) ? 'b' : 'a';
		if ( 'b' === $role && 'a' === $side ) { return Rest::err( 'not_yours', 'That side of the frame is your partner’s.', 403 ); }

		$img = (string) Rest::p( $req, 'image', '' );
		if ( ! preg_match( '#^data:(image/(?:jpeg|jpg|png|webp));base64,#i', $img, $m ) ) {
			return Rest::err( 'bad_image', 'Please choose a clear JPG, PNG or WebP under 5 MB.', 400 );
		}
		$bytes = base64_decode( substr( $img, strlen( $m[0] ) ), true );
		if ( false === $bytes || strlen( $bytes ) < 64 || strlen( $bytes ) > self::PHOTO_MAX_BYTES ) {
			return Rest::err( 'bad_image', 'Please choose a clear JPG, PNG or WebP under 5 MB.', 400 );
		}
		$mime = strtolower( $m[1] );
		$ext  = 'image/png' === $mime ? 'png' : ( 'image/webp' === $mime ? 'webp' : 'jpg' );
		// The bytes must BE an image, not merely be labelled one: a text file with a data: prefix
		// would otherwise be served from the uploads directory under an image extension.
		$info = @getimagesizefromstring( $bytes );
		if ( ! $info || (int) $info[0] < 64 || (int) $info[1] < 64 ) {
			return Rest::err( 'bad_image', 'That file is not a usable picture.', 400 );
		}

		$prev = (string) $r[ $side . '_file' ];
		$res  = wp_upload_bits( 'aq-cast-' . (int) $r['id'] . '-' . $side . '-' . time() . '.' . $ext, null, $bytes );
		if ( ! empty( $res['error'] ) || empty( $res['url'] ) ) { return Rest::err( 'upload_failed', 'Could not save that picture — please try another.', 500 ); }
		if ( $prev && @file_exists( $prev ) ) { @unlink( $prev ); }

		Data::update( 'aq_cast_requests', [
			$side . '_photo' => esc_url_raw( (string) $res['url'] ),
			$side . '_file'  => (string) $res['file'],
			'updated'        => Data::now(),
		], [ 'id' => (int) $r['id'] ] );
		return [ 'ok' => true, 'url' => (string) $res['url'], 'request' => self::payload( self::row( (int) $r['id'] ), $uid ) ];
	}

	// ── The partner ────────────────────────────────────────────────────────

	/**
	 * POST artacast/invite — mint the partner's single-use link, email it, and hand it back once.
	 *
	 * The raw secret goes to the address the requester typed AND back to the requester, who may
	 * pass it on themselves — a spouse is reached by WhatsApp more often than by a letter from a
	 * site they have not heard of, and the requester chose the address, so nothing is shown to
	 * anyone who could not already have it. Only the hash is stored. Re-inviting mints a new
	 * secret and voids the old one.
	 */
	public static function invite( $req ) {
		if ( Rest::throttle( 'aq_cast_invite', 6, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down — a few invitations an hour is plenty.', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$r = self::mine( $uid );
		if ( ! $r || 'a' !== self::role_of( $r, $uid ) ) { return Rest::err( 'no_request', 'Start your request first.', 404 ); }
		if ( (int) $r['partner_id'] > 0 ) { return Rest::err( 'already', 'Your partner has already joined.', 409 ); }
		$em = (string) $r['b_email'];
		if ( ! is_email( $em ) ) { return Rest::err( 'no_email', 'Enter your partner’s email address first.', 400 ); }

		// A ceiling per ADDRESS as well as per requester: an account may not use this form to post
		// a stranger a letter a day for a fortnight.
		$ak = 'aq_cast_inv_' . md5( $em );
		$an = (int) get_transient( $ak );
		if ( $an >= 3 ) { return Rest::err( 'rate_limited', 'That address has been invited three times today — give them a moment.', 429 ); }
		set_transient( $ak, $an + 1, DAY_IN_SECONDS );

		$now = Data::now();
		$raw = bin2hex( random_bytes( 20 ) );
		Data::update( 'aq_cast_requests', [
			'invite_token' => hash( 'sha256', $raw ),
			'invite_sent'  => $now,
			'invite_exp'   => $now + self::INVITE_TTL_S,
			'updated'      => $now,
		], [ 'id' => (int) $r['id'] ] );

		$url  = home_url( '/artacast/?invite=' . $raw );
		$who  = Mailer::safe_var( self::card( $uid )['name'] );
		$sent = false;
		try {
			$sent = (bool) Mailer::send( 'cast_invite', $em, [
				'who'     => $who,
				'partner' => Mailer::safe_var( '' !== (string) $r['b_name'] ? (string) $r['b_name'] : 'there' ),
				'url'     => $url,
			] );
		} catch ( \Throwable $e ) { $sent = false; }

		// If the address is already a member, ring their bell too — the letter may land in a folder
		// they never open, and the bell is where a member actually looks.
		$pu = get_user_by( 'email', $em );
		if ( $pu && (int) $pu->ID !== $uid ) {
			Notify::push( (int) $pu->ID, 'artacast', $who . ' asked you both onto ArtaCast', '', '/artacast/?invite=' . $raw, 'castinv' . (int) $r['id'] . ':' . $now );
		}

		return [
			'ok'      => true,
			'sent'    => $sent,
			'url'     => $url,
			'request' => self::payload( self::row( (int) $r['id'] ), $uid ),
		];
	}

	/**
	 * POST artacast/accept {k} — the partner's click, signed in as themselves.
	 *
	 * The secret is compared by hash and SPENT in the same UPDATE that seats them (WHERE the token
	 * still equals the hash AND nobody has taken the seat), so two clicks on one letter cannot both
	 * win, and a link the requester has since replaced matches nothing. If a recording is already
	 * booked they are seated in it here, so a partner who joins late still has a chair.
	 */
	public static function accept( $req ) {
		if ( Rest::throttle( 'aq_cast_accept', 20, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$raw = strtolower( trim( (string) Rest::p( $req, 'k', '' ) ) );
		if ( ! preg_match( '/^[0-9a-f]{40}$/', $raw ) ) { return Rest::err( 'bad_invite', 'That invitation link is not valid.', 400 ); }
		$hash = hash( 'sha256', $raw );
		$r = Data::one( 'SELECT * FROM ' . Data::t( 'aq_cast_requests' ) . " WHERE invite_token = %s AND status <> 'cancelled'", [ $hash ] );
		if ( ! $r ) { return Rest::err( 'bad_invite', 'That invitation has been used already, or it was replaced by a newer one.', 410 ); }
		$now = Data::now();
		if ( (int) $r['invite_exp'] < $now ) { return Rest::err( 'expired', 'That invitation has expired — ask your partner to send a fresh one.', 410 ); }
		if ( (int) $r['requester_id'] === $uid ) { return Rest::err( 'own_invite', 'This is your own invitation — it is for your partner to open, signed in as themselves.', 400 ); }
		if ( (int) $r['partner_id'] === $uid ) { return [ 'ok' => true, 'already' => true, 'request' => self::payload( $r, $uid ) ]; }
		$h = self::host_of( $r );
		if ( $h && (int) $h->ID === $uid ) { return Rest::err( 'own_show', 'You are the host of this episode.', 400 ); }
		$other = self::mine( $uid );
		if ( $other && (int) $other['id'] !== (int) $r['id'] ) {
			return Rest::err( 'busy', 'You already have an ArtaCast request of your own. Withdraw it first if you would rather join this one.', 409 );
		}

		$won = Data::update( 'aq_cast_requests', [
			'partner_id'      => $uid,
			'invite_token'    => '',
			'invite_accepted' => $now,
			'updated'         => $now,
		], [ 'id' => (int) $r['id'], 'invite_token' => $hash, 'partner_id' => 0 ] );
		if ( ! $won ) { return Rest::err( 'bad_invite', 'That invitation was just used.', 410 ); }

		$r = self::row( (int) $r['id'] );
		if ( (int) $r['meet_id'] > 0 ) { self::seat_partner( $r ); }

		$pname = Mailer::safe_var( self::card( $uid )['name'] );
		Notify::push( (int) $r['requester_id'], 'artacast', $pname . ' joined your ArtaCast request', '', '/artacast/', 'castacc' . (int) $r['id'] );

		return [ 'ok' => true, 'request' => self::payload( $r, $uid ) ];
	}

	/**
	 * Put the partner on the recording's guest list. Mirrors what Meetings::add_guest does for an
	 * invitation — a guest row, a bell — without reaching into it: the meeting is the host's, and
	 * the host is not the one making this call. Idempotent (UNIQUE meet_user), and a meeting that
	 * has been called off seats nobody.
	 */
	private static function seat_partner( $r ) {
		$mid = (int) $r['meet_id'];
		$pid = (int) $r['partner_id'];
		if ( $mid <= 0 || $pid <= 0 ) { return false; }
		$m = Data::one( 'SELECT * FROM ' . Data::t( 'aq_meets' ) . ' WHERE id = %d', [ $mid ] );
		if ( ! $m || ! in_array( (string) $m['status'], [ 'scheduled', 'live' ], true ) ) { return false; }
		$now = Data::now();
		if ( ! Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_meet_guests' ) . ' WHERE meet_id = %d AND user_id = %d LIMIT 1', [ $mid, $pid ] ) ) {
			// Three chairs by construction (RULE_DEFAULTS seats); a rule the host edited down to two
			// is widened here rather than refusing the partner a seat in their own recording.
			if ( (int) $m['seats'] < 3 ) { Data::update( 'aq_meets', [ 'seats' => 3, 'updated' => $now ], [ 'id' => $mid ] ); }
			Data::insert( 'aq_meet_guests', [
				'meet_id' => $mid, 'user_id' => $pid, 'role' => 'guest',
				'rsvp' => 'yes', 'invited_by' => (int) $m['host_id'], 'invited' => $now, 'rsvp_ts' => $now,
			] );
		}
		$host  = self::card( (int) $m['host_id'] );
		$mtz   = in_array( (string) $m['tz'], timezone_identifiers_list(), true ) ? (string) $m['tz'] : 'UTC';
		$title = (string) $m['title'];
		Notify::push_mail(
			$pid, 'meeting', 'Your ArtaCast recording is booked: ' . $title, '', '/meet/' . $mid, 'castseat' . $mid . '-' . $pid,
			'meet_confirmed', [
				'title'      => Mailer::safe_var( $title, 90 ),
				'host'       => Mailer::safe_var( $host ? $host['name'] : 'the host' ),
				'when'       => Meetings::when_line( [ 'tz' => $mtz, 'start_ts' => (int) $m['start_ts'] ] ),
				'when_short' => (string) wp_date( 'D j M, H:i', (int) $m['start_ts'], new \DateTimeZone( $mtz ) ),
				'meet_url'   => '/meet/' . $mid,
			]
		);
		return true;
	}

	// ── The recording ──────────────────────────────────────────────────────

	/**
	 * POST artacast/schedule {start} — take one of the host's published recording slots.
	 *
	 * Goes THROUGH Booking::take, as the requester, against the host's 'artacast' rule: the same
	 * per-owner lock, the same UNIQUE claim, the same refusals ('taken', 'too_soon', 'off_grid'…)
	 * passed back verbatim, the same two letters. What this adds afterwards is the show's own
	 * wording on the meeting, the partner's chair, and the row's link to it.
	 */
	public static function schedule( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$r = self::mine( $uid );
		if ( ! $r || 'a' !== self::role_of( $r, $uid ) ) { return Rest::err( 'no_request', 'Start your request first.', 404 ); }
		if ( ! self::complete( $r, 'a' ) || ! self::complete( $r, 'b' ) ) {
			return Rest::err( 'incomplete', 'Both of you need a name, a line and a photograph before a time can be booked.', 409 );
		}
		$h = self::host_of( $r );
		if ( ! $h ) { return Rest::err( 'no_host', 'The show has no host configured yet.', 503 ); }
		if ( (int) $h->ID === $uid || (int) $h->ID === (int) $r['partner_id'] ) { return Rest::err( 'own_show', 'Your host cannot be one of you.', 400 ); }
		if ( ! self::rule( $h ) ) { return Rest::err( 'closed', 'Your host’s calendar is not open yet.', 409 ); }

		// A recording already booked stands: moving it is the host's act from the meeting page, or
		// the couple withdraws and asks again. Two live meetings for one couple is what a silent
		// re-book here would create.
		if ( (int) $r['meet_id'] > 0 ) {
			$live = Data::one( 'SELECT status FROM ' . Data::t( 'aq_meets' ) . ' WHERE id = %d', [ (int) $r['meet_id'] ] );
			if ( $live && 'cancelled' !== (string) $live['status'] ) {
				return Rest::err( 'already_booked', 'Your recording is already booked. To move it, ask the host from the meeting page, or withdraw and ask again.', 409 );
			}
		}

		$start = Rest::pint( $req, 'start', 0 );
		$sub   = new \WP_REST_Request();
		$sub->set_param( 'user',  (string) $h->ID );
		$sub->set_param( 'type',  self::RULE_SLUG );
		$sub->set_param( 'start', $start );
		$sub->set_param( 'note',  (string) ( $r['story'] ?? '' ) );
		$made = Booking::take( $sub );
		if ( $made instanceof \WP_REST_Response ) { return $made; }
		$mid = (int) ( $made['meet_id'] ?? $made['id'] ?? 0 );
		if ( ! $mid ) { return Rest::err( 'server_error', 'Could not book that time.', 500 ); }

		$now   = Data::now();
		$names = trim( (string) $r['a_name'] ) . ' & ' . trim( (string) $r['b_name'] );
		Data::update( 'aq_meets', [
			'title'   => mb_substr( 'ArtaCast · ' . $names, 0, Meetings::TITLE_MAX ),
			'agenda'  => mb_substr( 'ArtaCast recording with ' . $names . '. Request #' . (int) $r['id'] . '.' . ( '' !== trim( (string) $r['story'] ) ? "\n\n" . trim( (string) $r['story'] ) : '' ), 0, Meetings::AGENDA_MAX ),
			'seats'   => 3,
			'updated' => $now,
		], [ 'id' => $mid ] );
		Data::update( 'aq_cast_requests', [
			'meet_id'  => $mid,
			'start_ts' => (int) ( $made['start_ts'] ?? $start ),
			'status'   => 'scheduled',
			'updated'  => $now,
		], [ 'id' => (int) $r['id'] ] );

		$r = self::row( (int) $r['id'] );
		if ( (int) $r['partner_id'] > 0 ) { self::seat_partner( $r ); }

		return [ 'ok' => true, 'request' => self::payload( $r, $uid ), 'meet_url' => '/meet/' . $mid ];
	}

	/**
	 * POST artacast/withdraw — the requester takes the request back.
	 *
	 * The row is marked, never deleted (the photographs are unlinked — a face should not outlive
	 * the request it was given for). A booked recording is cancelled through ArtaMeet's own path
	 * where that path allows it (a two-guest booking may be ended by either party); once the
	 * partner is seated it is a three-person meeting and only the host may end it, so the host is
	 * rung to do so and the couple are told plainly.
	 */
	public static function withdraw( $req ) {
		if ( Rest::throttle( 'aq_cast_withdraw', 10, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$r = self::mine( $uid );
		if ( ! $r || 'a' !== self::role_of( $r, $uid ) ) { return Rest::err( 'no_request', 'You have no request to withdraw.', 404 ); }

		$now = Data::now();
		$note = '';
		if ( (int) $r['meet_id'] > 0 ) {
			$undo = new \WP_REST_Request();
			$undo->set_param( 'id', (int) $r['meet_id'] );
			$res = Meetings::cancel( $undo );
			if ( $res instanceof \WP_REST_Response ) {
				$h = self::host_of( $r );
				if ( $h ) {
					Notify::push( (int) $h->ID, 'artacast', Mailer::safe_var( self::card( $uid )['name'] ) . ' withdrew from ArtaCast — please cancel the recording', '', '/meet/' . (int) $r['meet_id'], 'castwd' . (int) $r['id'] );
				}
				$note = 'The recording is a three-person meeting now, so only the host can cancel it — they have been asked to.';
			}
		}
		foreach ( [ 'a_file', 'b_file' ] as $f ) {
			$p = (string) $r[ $f ];
			if ( $p && @file_exists( $p ) ) { @unlink( $p ); }
		}
		Data::update( 'aq_cast_requests', [
			'status' => 'cancelled', 'invite_token' => '', 'invite_exp' => 0,
			'a_photo' => '', 'a_file' => '', 'b_photo' => '', 'b_file' => '', 'updated' => $now,
		], [ 'id' => (int) $r['id'] ] );
		if ( (int) $r['partner_id'] > 0 ) {
			Notify::push( (int) $r['partner_id'], 'artacast', 'Your ArtaCast request was withdrawn', '', '/artacast/', 'castwdp' . (int) $r['id'] );
		}
		return [ 'ok' => true, 'note' => $note ];
	}

	// ── The recording ──────────────────────────────────────────────────────

	/** The live request behind a meeting, or null. */
	private static function by_meet( $mid ) {
		$mid = (int) $mid;
		return $mid > 0 ? Data::one(
			'SELECT * FROM ' . Data::t( 'aq_cast_requests' ) . " WHERE meet_id = %d AND status <> 'cancelled' ORDER BY id DESC LIMIT 1",
			[ $mid ]
		) : null;
	}

	/**
	 * GET artacast/episode?meet=<id> — the frame's facts for a recording: who sits in which window
	 * (by member id, never by arrival order), the names and lines, birth and milestones, the year.
	 * Guests of the meeting only, and a 404 for any meeting that is not an episode — the call page
	 * asks on every meeting titled "ArtaCast…" and treats 404 as "an ordinary meeting".
	 */
	public static function episode( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mid = Rest::pint( $req, 'meet', 0 );
		$r   = self::by_meet( $mid );
		if ( ! $r ) { return Rest::err( 'not_found', 'Not an ArtaCast recording.', 404 ); }
		if ( ! Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_meet_guests' ) . ' WHERE meet_id = %d AND user_id = %d LIMIT 1', [ $mid, $uid ] ) ) {
			return Rest::err( 'not_found', 'Not an ArtaCast recording.', 404 );
		}
		$m = Data::one( 'SELECT host_id, title FROM ' . Data::t( 'aq_meets' ) . ' WHERE id = %d', [ $mid ] );
		return [
			'ok'        => true,
			'meet_id'   => $mid,
			'host_id'   => (int) ( $m['host_id'] ?? 0 ),
			'a'         => self::side( $r, 'a' ) + [ 'uid' => (int) $r['requester_id'] ],
			'b'         => self::side( $r, 'b' ) + [ 'uid' => (int) $r['partner_id'] ],
			'married_y' => (int) $r['married_y'],
			'title'     => (string) ( $m['title'] ?? '' ),
		];
	}

	/**
	 * POST artacast/iso {meet, media_id} — a guest's own camera track is on their shelf; attach it to
	 * the episode. Guests of the meeting only, their own committed video item only. Idempotent per
	 * item. Listed to the host and the couple with fresh shelf URLs; copied into the finishing run's
	 * outputs when it is still to come, else downloadable from the shelf.
	 */
	public static function iso( $req ) {
		if ( Rest::throttle( 'aq_cast_iso', 20, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mid = Rest::pint( $req, 'meet', 0 );
		$r   = self::by_meet( $mid );
		if ( ! $r ) { return Rest::err( 'not_found', 'Not an ArtaCast recording.', 404 ); }
		if ( ! Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_meet_guests' ) . ' WHERE meet_id = %d AND user_id = %d LIMIT 1', [ $mid, $uid ] ) ) {
			return Rest::err( 'not_found', 'Not an ArtaCast recording.', 404 );
		}
		$item = self::raw_item( Rest::pint( $req, 'media_id', 0 ), $uid );
		if ( ! $item ) { return Rest::err( 'no_raw', 'That recording is not on your shelf yet.', 409 ); }
		$list = (array) ( Data::dec( (string) ( $r['iso_files'] ?? '' ) ) ?: [] );
		$have = false;
		foreach ( $list as $t ) { if ( (int) ( $t['media_id'] ?? 0 ) === (int) $item['id'] ) { $have = true; } }
		if ( ! $have ) {
			$list[] = [ 'uid' => $uid, 'media_id' => (int) $item['id'], 'at' => Data::now() ];
			Data::update( 'aq_cast_requests', [ 'iso_files' => Data::enc( array_slice( $list, -12 ) ), 'updated' => Data::now() ], [ 'id' => (int) $r['id'] ] );
		}
		$r = self::row( (int) $r['id'] );
		return [ 'ok' => true, 'iso' => self::iso_list( $r, self::role_of( $r, $uid ) ) ];
	}

	/**
	 * POST artacast/recorded {meet, seconds, bytes, format} — the host's device finished writing an
	 * episode. Nothing about the file reaches the server (it cannot: the room is sealed); the row
	 * remembers THAT it was recorded, and how long, so the inbox can say so. Host only.
	 */
	public static function recorded( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mid = Rest::pint( $req, 'meet', 0 );
		$r   = self::by_meet( $mid );
		if ( ! $r ) { return Rest::err( 'not_found', 'Not an ArtaCast recording.', 404 ); }
		$m = Data::one( 'SELECT host_id FROM ' . Data::t( 'aq_meets' ) . ' WHERE id = %d', [ $mid ] );
		if ( ! $m || (int) $m['host_id'] !== $uid ) { return Rest::err( 'forbidden', 'Only the host records.', 403 ); }
		$secs  = max( 0, min( 86400, Rest::pint( $req, 'seconds', 0 ) ) );
		$bytes = max( 0, (int) Rest::p( $req, 'bytes', 0 ) );
		$fmt   = self::clean_text( Rest::p( $req, 'format', '' ), 40 );
		$note  = trim( sprintf( '%d min · %.1f GB · %s', (int) round( $secs / 60 ), $bytes / 1e9, $fmt ), ' ·' );
		Data::update( 'aq_cast_requests', [ 'recorded_at' => Data::now(), 'recorded_note' => mb_substr( $note, 0, 100 ), 'updated' => Data::now() ], [ 'id' => (int) $r['id'] ] );
		return [ 'ok' => true, 'note' => $note ];
	}

	// ── Finishing — the episode is cleaned and normalised on Kaggle, unattended ─────────────
	//
	// The host's device wrote the raw episode; its browser then sends it to the host's ArtaCloud
	// shelf (Media.php — the host carries a standing grant for exactly this). `finish` takes that
	// shelf item, renders data/artacast-finish.py with the item's public URL, and pushes it to
	// Kaggle as a private script kernel on a T4 pair. The five-minute cron then asks Kaggle how the
	// kernel is doing, and when the report file appears the host is rung and emailed: the final
	// file, the thumbnail and the report are downloaded from Kaggle through links minted on demand
	// (they are signed and short-lived, so they are never stored). Nothing runs on this server but
	// two small HTTP calls; nothing about the couple's voices is ever processed here.

	const PIPE_TIMEOUT_S = 36000;   // ten hours: a Kaggle GPU session's own ceiling is twelve

	/** The host's own, committed, video shelf item — or null. Never trusts the id alone. */
	private static function raw_item( $media_id, $uid ) {
		$m = Data::one( 'SELECT * FROM ' . Data::t( 'aq_media' ) . ' WHERE id = %d', [ (int) $media_id ] );
		if ( ! $m || (int) $m['user_id'] !== (int) $uid || 'ready' !== (string) $m['state'] || 'video' !== (string) $m['kind'] ) { return null; }
		return $m;
	}

	/**
	 * POST artacast/finish {meet, media_id, thumb?} — the raw is on the shelf; finish it. Host only.
	 * Calling it again is the retry: a failed or stale run is simply pushed anew under the same
	 * kernel slug (Kaggle keeps versions).
	 */
	public static function finish( $req ) {
		if ( Rest::throttle( 'aq_cast_finish', 12, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$mid = Rest::pint( $req, 'meet', 0 );
		$r   = self::by_meet( $mid );
		if ( ! $r ) { return Rest::err( 'not_found', 'Not an ArtaCast recording.', 404 ); }
		$m = Data::one( 'SELECT host_id FROM ' . Data::t( 'aq_meets' ) . ' WHERE id = %d', [ $mid ] );
		if ( ! $m || (int) $m['host_id'] !== $uid ) { return Rest::err( 'forbidden', 'Only the host finishes an episode.', 403 ); }
		$media_id = Rest::pint( $req, 'media_id', (int) $r['raw_media_id'] );
		$item = self::raw_item( $media_id, $uid );
		if ( ! $item ) { return Rest::err( 'no_raw', 'That recording is not on your shelf yet.', 409 ); }
		if ( 'running' === (string) $r['pipe_state'] && (int) $r['pipe_started'] > Data::now() - 900 ) {
			return Rest::err( 'busy', 'That episode is already being finished — give it a few minutes.', 409 );
		}
		$thumb = esc_url_raw( (string) Rest::p( $req, 'thumb', (string) $r['thumb_url'] ) );
		Data::update( 'aq_cast_requests', [ 'raw_media_id' => (int) $item['id'], 'thumb_url' => $thumb, 'updated' => Data::now() ], [ 'id' => (int) $r['id'] ] );
		$r = self::row( (int) $r['id'] );
		self::pipeline_start( $r, $item );
		return [ 'ok' => true, 'request' => self::payload( self::row( (int) $r['id'] ), $uid ) ];
	}

	/** The kernel slug for a request. Its TITLE below must slugify to exactly this (a Kaggle trap). */
	private static function kernel_slug( $r ) { return 'artacast-episode-' . (int) $r['id']; }

	/** The file name the finished episode carries — the kit's, minus the extension. */
	private static function out_base( $r ) {
		$clean = fn( $s ) => trim( preg_replace( '/[^A-Za-z0-9]+/', '-', remove_accents( (string) $s ) ), '-' ) ?: 'guest';
		return 'ArtaCast-' . mb_substr( $clean( $r['a_name'] ), 0, 24 ) . '-' . mb_substr( $clean( $r['b_name'] ), 0, 24 ) . '-' . wp_date( 'Y-m-d', (int) ( $r['start_ts'] ?: Data::now() ) );
	}

	private static function pipeline_start( $r, $item ) {
		$now = Data::now();
		$tpl = @file_get_contents( AQ_DIR . '/data/artacast-finish.py' );
		if ( ! $tpl ) { self::pipeline_fail( $r, 'the finishing script is missing from this build' ); return; }
		$iso = [];
		foreach ( self::iso_list( $r, 'host' ) as $t ) { $iso[] = [ 'name' => (string) $t['name'], 'url' => (string) $t['url'] ]; }
		$src = strtr( $tpl, [
			'{{ISO_JSON}}'   => str_replace( [ '\\', '"' ], [ '\\\\', '\\"' ], (string) wp_json_encode( $iso ) ),
			'{{RAW_URL}}'    => Media::url( (string) $item['store_key'] ),
			'{{THUMB_URL}}'  => (string) $r['thumb_url'],
			'{{OUT_BASE}}'   => self::out_base( $r ),
			'{{REQUEST_ID}}' => (string) (int) $r['id'],
		] );
		$slug  = self::kernel_slug( $r );
		$title = 'artacast episode ' . (int) $r['id'];
		// Test seam: a local site has no Kaggle credential, and the state machine still has to be
		// exercised. Never consulted on production unless somebody adds the filter there on purpose.
		$seam = apply_filters( 'aq_cast_kaggle_push', null, $slug, $title, $src );
		// PRIVATE by default now that the Vault holds a key pair: our own private kernel's outputs read
		// back over Basic, and a couple's raw episode is not a public artefact before its release.
		[ $ok, $why ] = is_array( $seam ) ? $seam : Kaggle::push_script( $slug, $title, $src, (bool) get_option( 'aq_artacast_kernel_private', 1 ) );
		$tries = (int) ( $r['pipe_tries'] ?? 0 ) + 1;
		if ( ! $ok ) { self::pipeline_fail( $r, 'Kaggle refused the kernel: ' . $why, $tries >= self::PIPE_TRIES, $tries ); return; }
		Data::update( 'aq_cast_requests', [
			'pipe_state' => 'running', 'pipe_kernel' => $slug, 'pipe_started' => $now, 'pipe_done' => 0,
			'pipe_note' => '', 'final_files' => null, 'pipe_tries' => $tries, 'updated' => $now,
		], [ 'id' => (int) $r['id'] ] );
	}

	/** A push is retried by the cron this many times (Kaggle's two-GPU-session cap, a 5xx, a queue
	 *  full for an hour) before the host is told; every other failure is told at once. */
	const PIPE_TRIES = 4;
	const PIPE_RETRY_S = 600;

	private static function pipeline_fail( $r, $note, $final = true, $tries = null ) {
		$now = Data::now();
		$data = [ 'pipe_state' => 'failed', 'pipe_note' => mb_substr( (string) $note, 0, 250 ), 'pipe_done' => $now, 'updated' => $now ];
		if ( null !== $tries ) { $data['pipe_tries'] = (int) $tries; }
		Data::update( 'aq_cast_requests', $data, [ 'id' => (int) $r['id'] ] );
		if ( ! $final ) { return; }
		$h = self::host_of( $r );
		if ( $h ) {
			Notify::push( (int) $h->ID, 'artacast', 'Finishing an ArtaCast episode failed — open your show to retry', mb_substr( (string) $note, 0, 190 ), '/artacast/', 'castpf' . (int) $r['id'] . ':' . $now );
		}
	}

	private static function pipeline_done( $r, $files, $model ) {
		$now  = Data::now();
		$keep = [];
		foreach ( (array) $files as $f ) { $keep[] = [ 'name' => (string) $f['name'] ]; }
		Data::update( 'aq_cast_requests', [
			'pipe_state' => 'done', 'pipe_done' => $now, 'pipe_note' => mb_substr( 'Voices cleaned with ' . ( $model ?: 'the fallback' ), 0, 250 ),
			'final_files' => Data::enc( $keep ), 'updated' => $now,
		], [ 'id' => (int) $r['id'] ] );
		// THE RAW LEAVES THE SHELF. The host has the file on their own computer and Kaggle now holds the
		// finished one; five gigabytes an episode would fill even the host's grant in a season.
		global $wpdb;
		$raw = Data::one( 'SELECT id, store_key, user_id FROM ' . Data::t( 'aq_media' ) . ' WHERE id = %d', [ (int) $r['raw_media_id'] ] );
		if ( $raw && (int) $raw['user_id'] === (int) ( self::host_of( $r )->ID ?? 0 ) ) {
			if ( method_exists( Media::class, 'destroy' ) ) { Media::destroy( (string) $raw['store_key'] ); }
			$wpdb->delete( Data::t( 'aq_media' ), [ 'id' => (int) $raw['id'] ] );
		}
		// The isolated tracks that made it into the run's outputs leave the guests' shelves too.
		$copied = [];
		foreach ( (array) $files as $f ) { $copied[ (string) $f['name'] ] = true; }
		foreach ( (array) ( Data::dec( (string) ( $r['iso_files'] ?? '' ) ) ?: [] ) as $t ) {
			$m = Data::one( 'SELECT id, store_key, name FROM ' . Data::t( 'aq_media' ) . ' WHERE id = %d', [ (int) ( $t['media_id'] ?? 0 ) ] );
			if ( $m && isset( $copied[ 'ISO-' . (string) $m['name'] ] ) ) {
				if ( method_exists( Media::class, 'destroy' ) ) { Media::destroy( (string) $m['store_key'] ); }
				$wpdb->delete( Data::t( 'aq_media' ), [ 'id' => (int) $m['id'] ] );
			}
		}
		$h = self::host_of( $r );
		if ( ! $h ) { return; }
		$names = trim( (string) $r['a_name'] ) . ' & ' . trim( (string) $r['b_name'] );
		Notify::push_mail(
			(int) $h->ID, 'artacast', 'Your ArtaCast episode with ' . $names . ' is finished', '', '/artacast/', 'castdone' . (int) $r['id'],
			'cast_final', [ 'names' => Mailer::safe_var( $names, 90 ), 'model' => Mailer::safe_var( $model ?: 'the fallback chain', 60 ) ], ''
		);
	}

	/**
	 * The script's own last line, decoded. Kaggle hands a kernel's log back as JSON lines, so the
	 * script's JSON arrives with its quotes escaped (`ARTACAST_DONE {\"model\": …}\n"`); a plain log
	 * ends the line at a real newline. Both shapes are read; anything else is null.
	 */
	private static function done_json( $log ) {
		$log = (string) $log;
		$p = strpos( $log, 'ARTACAST_DONE ' );
		if ( false === $p ) { return null; }
		$rest = substr( $log, $p + 14 );
		$end  = strlen( $rest );
		foreach ( [ '\\n"', "\n" ] as $stop ) {
			$q = strpos( $rest, $stop );
			if ( false !== $q ) { $end = min( $end, $q ); }
		}
		$raw = substr( $rest, 0, $end );
		$j = json_decode( $raw, true );
		if ( ! is_array( $j ) ) { $j = json_decode( stripcslashes( $raw ), true ); }
		return is_array( $j ) ? $j : null;
	}

	/** The verdict from what the kernel left behind: its report file and its own last line. */
	private static function judge_output( $files, $log ) {
		$report = false;
		foreach ( (array) $files as $f ) { if ( str_ends_with( (string) $f['name'], '-report.json' ) ) { $report = true; } }
		$j = self::done_json( $log );
		$model = (string) ( $j['model'] ?? '' );
		if ( str_contains( (string) $log, 'ARTACAST_FAILED' ) ) { return [ 'failed', $model ]; }
		if ( $report ) { return [ 'done', $model ]; }
		return [ 'running', $model ];
	}

	/** Every five minutes (aq_meet_tick): the episodes being finished. Bounded; self-gated. */
	public static function pipeline_tick() {
		if ( get_transient( 'aq_cast_pipe' ) ) { return; }
		set_transient( 'aq_cast_pipe', 1, 240 );
		$now  = Data::now();
		// Pushes Kaggle refused (session cap, 5xx) come back on their own, spaced ten minutes apart,
		// while the raw is still on the shelf; only the last refusal reaches the host.
		$again = Data::all(
			'SELECT * FROM ' . Data::t( 'aq_cast_requests' ) . " WHERE pipe_state = 'failed' AND pipe_note LIKE 'Kaggle refused%' AND pipe_tries < %d AND pipe_done < %d AND raw_media_id > 0 ORDER BY pipe_done ASC LIMIT 5",
			[ self::PIPE_TRIES, $now - self::PIPE_RETRY_S ]
		);
		foreach ( $again as $r ) {
			$h = self::host_of( $r );
			$item = $h ? self::raw_item( (int) $r['raw_media_id'], (int) $h->ID ) : null;
			if ( $item ) { self::pipeline_start( $r, $item ); }
		}
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_cast_requests' ) . " WHERE pipe_state = 'running' ORDER BY pipe_started ASC LIMIT 10" );
		foreach ( $rows as $r ) {
			$slug = (string) $r['pipe_kernel'];
			if ( '' === $slug ) { self::pipeline_fail( $r, 'no kernel recorded' ); continue; }
			$seam = apply_filters( 'aq_cast_kaggle_read', null, $slug );
			[ $st, $why ] = is_array( $seam ) ? [ $seam[0], $seam[1] ] : Kaggle::status_of( $slug );
			if ( 'error' === $st ) { self::pipeline_fail( $r, 'Kaggle: ' . ( $why ?: 'the run errored' ) ); continue; }
			[ $code, $files, $log ] = is_array( $seam ) ? [ $seam[2], $seam[3], $seam[4] ] : Kaggle::output( Kaggle::owner(), $slug );
			if ( $code >= 200 && $code < 300 ) {
				[ $verdict, $model ] = self::judge_output( $files, $log );
				if ( 'done' === $verdict )   { self::pipeline_done( $r, $files, $model ); continue; }
				if ( 'failed' === $verdict ) { self::pipeline_fail( $r, 'the finishing script could not read the recording' ); continue; }
				if ( 'complete' === $st )    { self::pipeline_fail( $r, 'the run finished without its report — open the kernel log' ); continue; }
			} elseif ( 'complete' === $st ) {
				self::pipeline_fail( $r, 'the run finished but its outputs could not be listed (HTTP ' . $code . ')' );
				continue;
			}
			if ( (int) $r['pipe_started'] < $now - self::PIPE_TIMEOUT_S ) { self::pipeline_fail( $r, 'no result after ten hours' ); }
		}
	}

	/** GET artacast/final?id= — fresh, signed download links for a finished episode. Host only. */
	public static function final( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		if ( ! self::is_host( $uid ) ) { return Rest::err( 'forbidden', 'Only the host.', 403 ); }
		$r = self::row( Rest::pint( $req, 'id', 0 ) );
		if ( ! $r || 'done' !== (string) $r['pipe_state'] ) { return Rest::err( 'not_ready', 'That episode is not finished yet.', 409 ); }
		$seam = apply_filters( 'aq_cast_kaggle_read', null, (string) $r['pipe_kernel'] );
		[ $code, $files, $log ] = is_array( $seam ) ? [ $seam[2], $seam[3], $seam[4] ] : Kaggle::output( Kaggle::owner(), (string) $r['pipe_kernel'] );
		if ( $code < 200 || $code >= 300 ) { return Rest::err( 'kaggle', 'Kaggle did not answer (HTTP ' . $code . ') — try again in a moment.', 502 ); }
		$out = [];
		foreach ( $files as $f ) { $out[] = [ 'name' => (string) $f['name'], 'url' => (string) $f['url'] ]; }
		$j = self::done_json( $log );
		$tail = $j ? (string) wp_json_encode( $j ) : mb_substr( (string) $log, -600 );
		return [ 'ok' => true, 'files' => $out, 'summary' => $tail, 'kernel' => Kaggle::kernel_url( (string) $r['pipe_kernel'] ) ];
	}

	// ── The host's side ────────────────────────────────────────────────────

	/** GET artacast/inbox?cursor= — every live request, newest first. Host and operators. */
	public static function inbox( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		if ( ! self::is_host( $uid ) ) { return Rest::err( 'forbidden', 'Only the host sees the requests.', 403 ); }
		// The cron is the engine; a host opening their inbox is a second one. Self-gated inside.
		self::pipeline_tick();
		$h = self::host();
		$mine_only = ! current_user_can( 'manage_options' ) || Rest::pint( $req, 'mine', 0 );
		// host_id 0 is the primary host — rows written before hosts were chosen.
		$where = $mine_only
			? ( $h && (int) $h->ID === $uid ? "status <> 'cancelled' AND (host_id = %d OR host_id = 0)" : "status <> 'cancelled' AND host_id = %d" )
			: "status <> 'cancelled'";
		[ $rows, $next ] = Data::page(
			'aq_cast_requests', $where, $mine_only ? [ $uid ] : [],
			Rest::pint( $req, 'cursor', 0 ), max( 1, min( 50, Rest::pint( $req, 'limit', 30 ) ) )
		);
		$items = [];
		foreach ( $rows as $r ) { $items[] = self::payload( $r, $uid ); }
		$me = get_userdata( $uid );
		return [ 'ok' => true, 'items' => $items, 'next' => $next, 'rule' => self::is_host_uid( $uid ) ? self::rule( $me ) : null ];
	}

	/**
	 * POST artacast/host-open {tz} — the host opens recording hours from the show page: the
	 * 'artacast' rule is written through Booking::set_rule with the show's defaults (or switched
	 * back on if it was paused). Everything about it is then edited at /book like any other rule.
	 */
	public static function host_open( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		if ( ! self::is_host_uid( $uid ) ) { return Rest::err( 'forbidden', 'Only a host has recording hours.', 403 ); }
		$tz = trim( (string) Rest::p( $req, 'tz', '' ) );
		if ( ! in_array( $tz, timezone_identifiers_list(), true ) ) { $tz = 'UTC'; }
		return self::ensure_rule( $uid, $tz );
	}

	/** The host's 'artacast' rule, created with the show's defaults in their zone if absent, switched
	 *  back on if paused. Idempotent; called from the show page on every host visit. */
	private static function ensure_rule( $uid, $tz ) {

		$sub = new \WP_REST_Request();
		$sub->set_param( 'type', self::RULE_SLUG );
		$sub->set_param( 'active', 1 );
		$cur = Data::one(
			'SELECT id FROM ' . Data::t( 'aq_meet_rules' ) . ' WHERE user_id = %d AND slug = %s',
			[ $uid, self::RULE_SLUG ]
		);
		if ( ! $cur ) {
			foreach ( self::RULE_DEFAULTS as $k => $v ) { $sub->set_param( $k, $v ); }
			$sub->set_param( 'tz', $tz );
		}
		$res = Booking::set_rule( $sub );
		if ( $res instanceof \WP_REST_Response ) { return $res; }
		$me = get_userdata( $uid );
		return [ 'ok' => true, 'rule' => self::rule( $me ), 'edit_url' => home_url( '/book/' ) ];
	}

	/**
	 * POST artacast/volunteer {on, tz} — offer to host episodes, or stop. A volunteer's calendar opens
	 * the same way the primary host's does (ensure_rule); stopping pauses nothing already booked —
	 * those are meetings, and stay. The primary host cannot stop.
	 */
	public static function volunteer( $req ) {
		if ( Rest::throttle( 'aq_cast_vol', 10, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$h = self::host();
		if ( $h && (int) $h->ID === $uid ) { return Rest::err( 'primary', 'You are the show’s host already.', 400 ); }
		if ( self::blocked( $uid ) ) { return Rest::err( 'forbidden', 'Hosting is not open to this account.', 403 ); }
		if ( ! class_exists( '\\AQ\\Verify' ) || ! Verify::has_birthday( $uid ) ) { return Rest::err( 'identity', 'State your name and date of birth first.', 403 ); }
		if ( Rest::pint( $req, 'on', 1 ) ) {
			update_user_meta( $uid, self::VOLUNTEER_META, '1' );
			$tz = trim( (string) Rest::p( $req, 'tz', '' ) );
			if ( ! in_array( $tz, timezone_identifiers_list(), true ) ) { $tz = 'UTC'; }
			$res = self::ensure_rule( $uid, $tz );
			if ( $res instanceof \WP_REST_Response ) { delete_user_meta( $uid, self::VOLUNTEER_META ); return $res; }
			return [ 'ok' => true, 'hosting' => true, 'rule' => $res['rule'] ?? null ];
		}
		delete_user_meta( $uid, self::VOLUNTEER_META );
		return [ 'ok' => true, 'hosting' => false ];
	}
}
