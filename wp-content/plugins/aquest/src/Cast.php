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
	const RULE_DEFAULTS = [
		'title'      => 'ArtaCast recording',
		'blurb'      => 'A recorded conversation with a couple about how they stayed together — an encrypted ArtaMeet call.',
		'minutes'    => 90,
		'days'       => '1111100',
		'from_min'   => 840,   // 14:00
		'to_min'     => 1140,  // 19:00
		'buffer_min' => 30,
		'notice_h'   => 48,
		'horizon_d'  => 60,
		'seats'      => 3,     // the host and both of them
	];

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

	/** Operators see the inbox too — the host is one person, and the show should survive a week of
	 *  their absence — but they never become the host: the meeting is always the host's. */
	private static function is_host( $uid ) {
		$h = self::host();
		return $uid > 0 && ( ( $h && (int) $h->ID === (int) $uid ) || current_user_can( 'manage_options' ) );
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
	private static function rule() {
		$h = self::host();
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
		return [
			'id'        => (int) $r['id'],
			'status'    => (string) $r['status'],
			'role'      => $role,
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
		$h    = self::host();
		$rule = self::rule();
		$card = $h ? ( self::card( $h->ID ) + [ 'tz' => (string) ( $rule['tz'] ?? '' ) ] ) : null;

		$r = null;
		$want = Rest::pint( $req, 'id', 0 );
		if ( $want > 0 && self::is_host( $uid ) ) { $r = self::row( $want ); }
		if ( ! $r && $uid ) { $r = self::mine( $uid ); }

		return [
			'ok'      => true,
			'host'    => $card,
			'rule'    => $rule,
			'open'    => (bool) $rule,
			'me'      => $uid,
			'is_host' => self::is_host( $uid ),
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
		if ( (int) $h->ID === $uid ) { return Rest::err( 'own_show', 'You are the host — the guests fill this in.', 400 ); }

		$now = Data::now();
		$r   = self::mine( $uid );
		$role = $r ? self::role_of( $r, $uid ) : 'a';
		$data = [ 'updated' => $now ];

		if ( 'a' === $role ) {
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
			// A fresh row starts with what we already know about the requester: their public name and
			// their stated birthday — both are theirs to correct on the form.
			$me = get_userdata( $uid );
			$full = function_exists( 'aq_profile_name' ) ? (string) aq_profile_name( $me ) : '';
			$data += [
				'requester_id' => $uid,
				'partner_id'   => 0,
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
		$h = self::host();
		if ( $h && (int) $h->ID === $uid ) { return Rest::err( 'own_show', 'You are the host of this show.', 400 ); }
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
		$h = self::host();
		if ( ! $h ) { return Rest::err( 'no_host', 'The show has no host configured yet.', 503 ); }
		if ( ! self::rule() ) { return Rest::err( 'closed', 'The host has not opened recording hours yet.', 409 ); }

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
				$h = self::host();
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

	// ── The host's side ────────────────────────────────────────────────────

	/** GET artacast/inbox?cursor= — every live request, newest first. Host and operators. */
	public static function inbox( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		if ( ! self::is_host( $uid ) ) { return Rest::err( 'forbidden', 'Only the host sees the requests.', 403 ); }
		[ $rows, $next ] = Data::page(
			'aq_cast_requests', "status <> 'cancelled'", [],
			Rest::pint( $req, 'cursor', 0 ), max( 1, min( 50, Rest::pint( $req, 'limit', 30 ) ) )
		);
		$items = [];
		foreach ( $rows as $r ) { $items[] = self::payload( $r, $uid ); }
		return [ 'ok' => true, 'items' => $items, 'next' => $next, 'rule' => self::rule() ];
	}

	/**
	 * POST artacast/host-open {tz} — the host opens recording hours from the show page: the
	 * 'artacast' rule is written through Booking::set_rule with the show's defaults (or switched
	 * back on if it was paused). Everything about it is then edited at /book like any other rule.
	 */
	public static function host_open( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$h = self::host();
		if ( ! $h || (int) $h->ID !== $uid ) { return Rest::err( 'forbidden', 'Only the host can open recording hours.', 403 ); }
		$tz = trim( (string) Rest::p( $req, 'tz', '' ) );
		if ( ! in_array( $tz, timezone_identifiers_list(), true ) ) { $tz = 'UTC'; }

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
		return [ 'ok' => true, 'rule' => self::rule(), 'edit_url' => home_url( '/book/' ) ];
	}
}
