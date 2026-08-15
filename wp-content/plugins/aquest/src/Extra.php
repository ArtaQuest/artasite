<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Long-tail feature endpoints kept in one file to stay lean: member self-identification
 * (typology), community grant outreach, bug-bounty reports, the creator ladder, the public
 * database explorer, the Arta Coin world price map, certificates, and course checkout.
 * Core LMS/economy/social live in their own domain classes; this is everything else.
 */
final class Extra {

	// ── Typology / self-identification ──────────────────────────────────────
	// Tagging rights are modulated by effort: a member may publicly stand with as many groups
	// (typology tags) as they have lifetime standing points — exactly 1 group per point. New members
	// start with Economy::SIGNUP_POINTS welcome points, so they begin with that many group slots; every
	// further point earned unlocks one more (and nudges them — see nudge_tag_slot / Economy::award_points).
	const TAG_PER_POINT = 1; // group-tag slots granted per lifetime point (1-to-1)

	/** How many groups this member may publicly tag, given their lifetime standing. */
	public static function tag_allowance( $uid, $points = null ) {
		if ( null === $points ) { $points = Economy::points_balance( (int) $uid ); }
		return max( 0, (int) $points ) * self::TAG_PER_POINT;
	}

	/** GET /typologies — the signed-in member's saved selections (map of system→[type ids]) + their
	 *  current standing and the group-tag allowance it buys (so the UI can show used / remaining slots). */
	public static function typologies_get( $req ) {
		$uid = Rest::uid();
		$sel = get_user_meta( $uid, 'aq_typology_selections', true );
		$pts = Economy::points_balance( $uid );
		return [
			'selections' => is_array( $sel ) ? $sel : ( json_decode( (string) $sel, true ) ?: (object) [] ),
			'points'     => $pts,
			'allowance'  => self::tag_allowance( $uid, $pts ),
		];
	}

	/** POST /typologies {selections, tags} — persist selections + resolved public tags, capped at the
	 *  member's effort-based allowance (1 group per lifetime point). Over-allowance saves are refused so
	 *  the cap can't be bypassed client-side; the UI gates additions before reaching here. */
	public static function typologies_save( $req ) {
		$uid   = Rest::uid();
		$sel   = (array) Rest::p( $req, 'selections', [] );
		$tags  = (array) Rest::p( $req, 'tags', [] );
		$pts   = Economy::points_balance( $uid );
		$allow = self::tag_allowance( $uid, $pts );
		if ( count( $tags ) > $allow ) {
			return Rest::err( 'over_allowance', sprintf(
				'You can stand with %d group%s at your current standing — earn 1 more point to unlock another, or remove a group. (You chose %d.)',
				$allow, 1 === $allow ? '' : 's', count( $tags )
			), 409 );
		}
		update_user_meta( $uid, 'aq_typology_selections', $sel );
		update_user_meta( $uid, 'aq_typology_tags', array_slice( $tags, 0, 200 ) );
		return [ 'ok' => true, 'count' => count( $tags ), 'allowance' => $allow, 'points' => $pts ];
	}

	/** When earning points unlocks one or more new group-tag slots, nudge the member to use one — but
	 *  only if they had already filled every slot they held (so someone with room to spare is never
	 *  pestered). Idempotent per unlocked-allowance level via the notification ref. */
	public static function nudge_tag_slot( $uid, $before, $after ) {
		if ( $after <= $before ) { return; }
		$old = self::tag_allowance( $uid, $before );
		$new = self::tag_allowance( $uid, $after );
		if ( $new <= $old ) { return; }                                   // no fresh slot unlocked
		$used = count( (array) get_user_meta( $uid, 'aq_typology_tags', true ) );
		if ( $used < $old ) { return; }                                   // still had unused slots — don't nudge
		Notify::push(
			$uid, 'topics',
			'You\'ve unlocked another group',
			'Your effort earned room to stand with another group. Add one on Topics.',
			'/topics/',
			'tagslot:' . $new
		);
	}

	// ── Typology endorsements (LinkedIn-style) ──────────────────────────────
	// Peers endorse the identity tags a member publicly stands with, so a profile shows not just
	// how a member sees themselves but how the community perceives them. One row per
	// (endorser, member, tag); counts are public like everything else.

	/** Schema version for the endorsements table — bump to re-run dbDelta after a column change. */
	const ENDORSE_TABLE_VERSION = '1';

	/**
	 * Create/upgrade the aq_endorsements table. Self-contained (not in Schema::tables()) so the
	 * feature owns its storage without entangling the shared schema migration — same pattern as
	 * Notify::ensure_table. Idempotent + cheap; hooked on plugins_loaded.
	 */
	public static function ensure_endorse_table() {
		if ( get_option( 'aq_endorse_table_version' ) === self::ENDORSE_TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$table   = $wpdb->prefix . 'aq_endorsements';
		$charset = $wpdb->get_charset_collate();
		dbDelta( "CREATE TABLE {$table} (
			user_id BIGINT UNSIGNED NOT NULL,
			target_id BIGINT UNSIGNED NOT NULL,
			tag VARCHAR(120) NOT NULL DEFAULT '',
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (user_id, target_id, tag),
			KEY target (target_id, tag)
		) {$charset};" );
		update_option( 'aq_endorse_table_version', self::ENDORSE_TABLE_VERSION, true );
	}

	/** A tag's canonical endorsement key: `systemKey:key`, as the SPA renders it. */
	private static function endorse_key( $tag ) {
		$s = sanitize_text_field( (string) ( $tag['systemKey'] ?? '' ) );
		$k = sanitize_text_field( (string) ( $tag['key'] ?? '' ) );
		return ( $s !== '' && $k !== '' ) ? substr( $s . ':' . $k, 0, 120 ) : '';
	}

	/** Public endorsement counts for a member, keyed by tag (`systemKey:key`) — one indexed read,
	 *  same shape as the profile's other public aggregates. Used by Social::profile. */
	public static function endorsements_for( $uid ) {
		$out = [];
		foreach ( Data::all(
			'SELECT tag, COUNT(*) AS c FROM ' . Data::t( 'aq_endorsements' ) . ' WHERE target_id = %d GROUP BY tag',
			[ (int) $uid ]
		) as $r ) { $out[ (string) $r['tag'] ] = (int) $r['c']; }
		return (object) $out;
	}

	/** GET /typology/endorsements?target_id= — the tags of that member the SIGNED-IN viewer has
	 *  endorsed (so the profile can show their own endorsements lit). Viewer-specific, hence a
	 *  separate authed read instead of a field on the CDN-cached public /profile. */
	public static function endorsements_mine( $req ) {
		$uid = Rest::uid();
		$tid = Rest::pint( $req, 'target_id' );
		if ( ! $tid ) { return [ 'tags' => [] ]; }
		$tags = Data::all(
			'SELECT tag FROM ' . Data::t( 'aq_endorsements' ) . ' WHERE user_id = %d AND target_id = %d',
			[ $uid, $tid ]
		);
		return [ 'tags' => array_values( array_map( fn( $r ) => (string) $r['tag'], $tags ) ) ];
	}

	/** POST /typology/endorse {target_id, tag, on:0|1} — endorse / withdraw an endorsement of one of
	 *  a member's public identity tags. Idempotent per (endorser, member, tag); self-endorsement is
	 *  refused; the tag must be one the member actually stands with (no rows on unclaimed tags). */
	public static function endorse( $req ) {
		$uid = Rest::uid();
		$tid = Rest::pint( $req, 'target_id' );
		$tag = substr( sanitize_text_field( (string) Rest::p( $req, 'tag', '' ) ), 0, 120 );
		$on  = Rest::pint( $req, 'on', 1 ) ? 1 : 0;
		if ( ! $tid || $tag === '' ) { return Rest::err( 'bad_input', 'Invalid target or tag' ); }
		if ( $tid === $uid ) { return Rest::err( 'self_endorse', 'You cannot endorse your own identity — peers do that.', 400 ); }
		if ( ! get_userdata( $tid ) ) { return Rest::err( 'not_found', 'Member not found', 404 ); }

		// The member must actually wear this tag (tags are public usermeta, exactly as Topics saved them).
		$worn = get_user_meta( $tid, 'aq_typology_tags', true );
		if ( ! is_array( $worn ) ) { $worn = json_decode( (string) $worn, true ) ?: []; }
		$keys  = array_map( [ self::class, 'endorse_key' ], $worn );
		$found = null;
		foreach ( $worn as $i => $t ) { if ( $keys[ $i ] === $tag ) { $found = $t; break; } }
		if ( null === $found ) { return Rest::err( 'not_found', 'That member does not stand with this group.', 404 ); }

		if ( $on ) {
			$new = Data::upsert( 'aq_endorsements', [ 'user_id' => $uid, 'target_id' => $tid, 'tag' => $tag ], [ 'created' => Data::now() ] );
			if ( $new ) { // notify once per (endorser, tag) — toggling off/on never re-pings
				$me = get_userdata( $uid );
				Notify::push(
					$tid, 'endorse',
					( $me ? $me->display_name : 'Someone' ) . ' endorsed your "' . (string) ( $found['short'] ?? $tag ) . '" identity',
					'', $me ? '/u/' . $me->user_nicename . '/' : '',
					'endo' . $uid . ':' . md5( $tag )
				);
			}
		} else {
			$GLOBALS['wpdb']->delete( Data::t( 'aq_endorsements' ), [ 'user_id' => $uid, 'target_id' => $tid, 'tag' => $tag ] );
		}
		$count = (int) Data::col(
			'SELECT COUNT(*) FROM ' . Data::t( 'aq_endorsements' ) . ' WHERE target_id = %d AND tag = %s',
			[ $tid, $tag ]
		);
		return [ 'ok' => true, 'endorsed' => (bool) $on, 'count' => $count ];
	}

	// ── Outreach: community-sourced grant applications ──────────────────────
	// Statuses that occupy a slot / count as "registered".
	const CLAIM_ACTIVE = "('claimed','submitted','verified')";

	/** GET /outreach — open grants, their registrants, scheduled ArtaMeet sessions + the viewer's status. */
	public static function outreach( $req ) {
		$uid    = Rest::uid();
		$grants = Data::all( 'SELECT * FROM ' . Data::t( 'aq_grants' ) . ' WHERE active = 1 ORDER BY fit DESC, points DESC LIMIT 200' );

		// One pass over all claims (registrants are PUBLIC — radical-transparency directive) joined to
		// users, grouped by grant — avoids an N+1 storm across 200 grants.
		$members = [];   // grant_id → [ {slug,name,avatar,status,at} ]
		$mine    = [];   // grant_id → my status
		foreach ( Data::all(
			'SELECT c.grant_id, c.user_id, c.status, c.claimed_ts, u.display_name, u.user_nicename'
			. ' FROM ' . Data::t( 'aq_grant_claims' ) . ' c JOIN ' . $GLOBALS['wpdb']->users . ' u ON u.ID = c.user_id'
			. " WHERE c.status IN " . self::CLAIM_ACTIVE . ' ORDER BY c.id ASC'
		) as $c ) {
			$g = (int) $c['grant_id'];
			$members[ $g ][] = [
				'slug'   => $c['user_nicename'],
				'name'   => $c['display_name'] ?: 'Quester',
				'avatar' => Verify::avatar_url( (int) $c['user_id'], 64 ),
				'status' => $c['status'],
				'at'     => (int) $c['claimed_ts'],
			];
			if ( $uid && (int) $c['user_id'] === $uid ) { $mine[ $g ] = $c['status']; }
		}

		// All scheduled working sessions, grouped by grant. These live in aq_meets now (ArtaMeet);
		// aq_grant_meetings is retired — its rows are kept as the historical record of the Google
		// Calendar era, but nothing reads meet_url any more and no new row is ever written there.
		//
		// The join link is emitted ONLY to a member who holds a guest row on that sitting. This route
		// is public and edge-cached for anonymous callers, so a link in the anonymous body would be a
		// link the whole internet reads — which is exactly what the Google Meet URL was. /meet/<id>
		// authorises on the guest row plus a session, so nothing depends on the URL staying secret;
		// withholding it is simply not advertising a door you cannot open.
		$meets = [];
		$gids  = array_map( static function ( $g ) { return (int) $g['id']; }, $grants );
		if ( $gids ) {
			$ph = implode( ',', array_fill( 0, count( $gids ), '%d' ) );
			foreach ( Data::all(
				'SELECT m.id, m.context_id, m.ctx_key, m.start_ts, m.end_ts, g.user_id AS guest_uid'
				. ' FROM ' . Data::t( 'aq_meets' ) . ' m'
				. ' LEFT JOIN ' . Data::t( 'aq_meet_guests' ) . ' g ON g.meet_id = m.id AND g.user_id = %d'
				. " WHERE m.context_type = 'grant' AND m.context_id IN ($ph) AND m.status <> 'cancelled'"
				. ' ORDER BY m.start_ts ASC',
				array_merge( [ $uid ], $gids )
			) as $m ) {
				$id  = (int) $m['id'];
				$key = (string) $m['ctx_key'];
				$meets[ (int) $m['context_id'] ][] = [
					// ctx_key is 'grant:<gid>:t-14' (plus 'b', 'c'… when the registrants outgrow one
					// mesh) — the milestone is its last segment, and stays the field the page keys on.
					'reminder_key' => ( strrpos( $key, ':' ) === false ? $key : substr( $key, strrpos( $key, ':' ) + 1 ) ),
					'start' => (int) $m['start_ts'], 'end' => (int) $m['end_ts'],
					'id' => $id, 'meet_url' => $m['guest_uid'] ? '/meet/' . $id : '',
				];
			}
		}

		$total_registered = 0;
		$out = array_map( function ( $g ) use ( $members, $mine, $meets, &$total_registered ) {
			$gid   = (int) $g['id'];
			$cap   = max( 1, (int) $g['capacity'] );
			$regs  = $members[ $gid ] ?? [];
			$taken = count( $regs );
			$total_registered += $taken;
			return [
				'id' => $gid, 'slug' => $g['slug'], 'title' => $g['title'], 'funder' => $g['funder'], 'url' => $g['url'],
				'country' => $g['country'], 'category' => $g['category'], 'amount_display' => $g['amount_display'], 'amount_cad' => (float) $g['amount_cad'],
				'deadline' => $g['deadline'], 'deadline_type' => $g['deadline_type'], 'estimated' => ! empty( $g['estimated'] ),
				'eligibility_ca' => $g['eligibility_ca'], 'eligibility_intl' => $g['eligibility_intl'], 'allows_regranting' => $g['allows_regranting'],
				'fit' => (int) $g['fit'], 'confidence' => $g['confidence'], 'capacity' => $cap, 'taken' => $taken, 'slots_left' => max( 0, $cap - $taken ),
				'points' => (int) $g['points'], 'summary' => $g['summary'], 'red_flags' => $g['red_flags'],
				'gcal_url' => self::gcal_link( $g ),
				'is_sponsor' => ( $g['category'] ?? '' ) === 'industry-sponsor', // an industry partner (the sponsor funnel), not a charity
				'author' => self::grant_author_card( (int) ( $g['author_id'] ?? 0 ) ),
				'members' => $regs, 'meetings' => $meets[ $gid ] ?? [],
				'my_status' => $mine[ $gid ] ?? null,
			];
		}, $grants );

		return [
			'grants' => $out, 'count' => count( $out ), 'total_registered' => $total_registered,
			'logged_in' => (bool) $uid,
			'ics_url' => home_url( '/?aq_grants_ics=1' ),
		];
	}

	/** A "+ Google Calendar" one-click add link for a dated grant deadline (all-day event). */
	private static function gcal_link( $g ) {
		$d = preg_replace( '/[^0-9]/', '', (string) $g['deadline'] ); // YYYYMMDD
		if ( strlen( $d ) !== 8 ) { return ''; } // rolling / invitation grants have no fixed date
		$end   = gmdate( 'Ymd', strtotime( $g['deadline'] . ' +1 day' ) );
		$title = 'Grant deadline: ' . $g['title'] . ' (' . $g['funder'] . ')';
		return 'https://calendar.google.com/calendar/render?' . http_build_query( [
			'action'  => 'TEMPLATE',
			'text'    => $title,
			'dates'   => $d . '/' . $end,
			'details' => trim( (string) $g['summary'] ) . ( $g['url'] ? "\n\n" . $g['url'] : '' ),
			'location' => (string) $g['url'],
		] );
	}

	public static function outreach_claim( $req ) {
		$uid = Rest::uid(); $gid = Rest::pint( $req, 'grant', 0 );
		$g = Data::one( 'SELECT id, points, capacity, title, deadline FROM ' . Data::t( 'aq_grants' ) . ' WHERE id = %d AND active = 1', [ $gid ] );
		if ( ! $g ) { return Rest::err( 'not_found', 'Grant not found', 404 ); }
		if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_grant_claims' ) . ' WHERE grant_id = %d AND user_id = %d', [ $gid, $uid ] ) ) {
			return [ 'ok' => true, 'already' => true ];
		}
		$taken = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_grant_claims' ) . ' WHERE grant_id = %d AND status IN ' . self::CLAIM_ACTIVE, [ $gid ] );
		if ( $taken >= max( 1, (int) $g['capacity'] ) ) { return Rest::err( 'full', 'No slots left', 409 ); }
		Data::insert( 'aq_grant_claims', [ 'grant_id' => $gid, 'user_id' => $uid, 'status' => 'claimed', 'points' => (int) $g['points'], 'claimed_ts' => Data::now() ] );
		// Schedule/refresh the ArtaMeet working sessions and seat this member on one of them.
		Meetings::ensure_for_grant( $gid );
		return [ 'ok' => true ];
	}

	public static function outreach_submit( $req ) {
		$uid = Rest::uid(); $gid = Rest::pint( $req, 'grant', 0 );
		$row = Data::one( 'SELECT id FROM ' . Data::t( 'aq_grant_claims' ) . ' WHERE grant_id = %d AND user_id = %d', [ $gid, $uid ] );
		if ( ! $row ) { return Rest::err( 'not_claimed', 'Claim it first', 400 ); }
		Data::update( 'aq_grant_claims', [
			'status' => 'submitted', 'note' => sanitize_textarea_field( (string) Rest::p( $req, 'note', '' ) ),
			'ref' => esc_url_raw( (string) Rest::p( $req, 'ref', '' ) ), 'submitted_ts' => Data::now(),
		], [ 'id' => (int) $row['id'] ] );
		return [ 'ok' => true ];
	}

	public static function outreach_release( $req ) {
		$uid = Rest::uid(); $gid = Rest::pint( $req, 'grant', 0 );
		// Only a 'claimed' row is released: a member who has already submitted or been verified is
		// still working on this application, so they keep their slot AND their seat — the re-sync
		// below deliberately re-invites them. That was always the behaviour; it was never written down.
		$GLOBALS['wpdb']->delete( Data::t( 'aq_grant_claims' ), [ 'grant_id' => $gid, 'user_id' => $uid, 'status' => 'claimed' ] );
		Meetings::ensure_for_grant( $gid ); // withdraw the member's invitation to the sessions
		return [ 'ok' => true ];
	}

	/**
	 * Refresh the grant catalogue from data/outreach-grants.json (written by the research toolchain's
	 * `grants.py export`). Filemtime-gated so it runs once per deploy: a plugin push alone provisions
	 * prod — no DB push. Upserts by slug; slugs absent from the file are deactivated (active=0) so the
	 * public list never serves a withdrawn grant, but their claims/history persist.
	 */
	public static function import_grants() {
		$file = AQ_DIR . '/data/outreach-grants.json';
		if ( ! is_readable( $file ) ) { return; }
		$mtime = (string) filemtime( $file );
		if ( get_option( 'aq_grants_import_mtime' ) === $mtime ) { return; }

		$rows = json_decode( (string) file_get_contents( $file ), true );
		if ( ! is_array( $rows ) ) { return; }
		$rows = $rows['grants'] ?? $rows; // tolerate either a bare array or { grants: [...] }
		$seen = [];
		foreach ( $rows as $r ) {
			$slug = sanitize_title( (string) ( $r['slug'] ?? $r['title'] ?? '' ) );
			if ( $slug === '' ) { continue; }
			$seen[] = $slug;
			$amount_cad = (int) round( (float) ( $r['amount_cad'] ?? 0 ) );
			$cap = isset( $r['capacity'] ) ? max( 1, (int) $r['capacity'] ) : max( 1, (int) round( $amount_cad / 10000 ) );
			$pts = isset( $r['points'] ) ? (int) $r['points'] : $amount_cad;
			Data::upsert( 'aq_grants', [ 'slug' => $slug ], [
				'title' => substr( (string) ( $r['title'] ?? '' ), 0, 255 ),
				'funder' => substr( (string) ( $r['funder'] ?? '' ), 0, 255 ),
				'url' => esc_url_raw( (string) ( $r['url'] ?? '' ) ),
				'country' => substr( (string) ( $r['country'] ?? '' ), 0, 128 ),
				'category' => substr( (string) ( $r['category'] ?? '' ), 0, 64 ),
				'currency' => substr( (string) ( $r['currency'] ?? '' ), 0, 8 ),
				'amount_cad' => $amount_cad,
				'amount_display' => substr( (string) ( $r['amount_display'] ?? '' ), 0, 128 ),
				'deadline' => substr( (string) ( $r['deadline'] ?? '' ), 0, 10 ),
				'deadline_type' => substr( (string) ( $r['deadline_type'] ?? '' ), 0, 32 ),
				'estimated' => empty( $r['estimated'] ) ? 0 : 1,
				'eligibility_ca' => substr( (string) ( $r['eligibility_ca'] ?? '' ), 0, 32 ),
				'eligibility_intl' => substr( (string) ( $r['eligibility_intl'] ?? '' ), 0, 32 ),
				'allows_regranting' => substr( (string) ( $r['allows_regranting'] ?? '' ), 0, 16 ),
				'fit' => max( 0, min( 5, (int) ( $r['fit'] ?? 0 ) ) ),
				'confidence' => substr( (string) ( $r['confidence'] ?? '' ), 0, 16 ),
				'capacity' => $cap,
				'points' => $pts,
				'summary' => (string) ( $r['summary'] ?? '' ),
				'red_flags' => (string) ( $r['red_flags'] ?? '' ),
				'active' => 1,
				'updated_ts' => Data::now(),
			] );
		}
		// Deactivate grants no longer in the catalogue (keep the row + its claims for history).
		global $wpdb;
		if ( $seen ) {
			$ph = implode( ',', array_fill( 0, count( $seen ), '%s' ) );
			$wpdb->query( $wpdb->prepare( 'UPDATE ' . Data::t( 'aq_grants' ) . " SET active = 0 WHERE slug NOT IN ($ph)", $seen ) );
		}
		// Author any newly-imported grants under the default creator (/u/arash). Only touches author_id=0,
		// so a hand-set author from Studio is never clobbered (the upsert above also leaves author_id alone
		// on an existing row, since it's not in the $data set). Mirrors the migrate backfill.
		if ( Schema::column_exists( $wpdb->prefix . 'aq_grants', 'author_id' ) ) {
			$def = (int) get_option( 'aq_course_author_uid' );
			if ( ! $def ) { $admins = get_users( [ 'role' => 'administrator', 'number' => 1, 'fields' => 'ID' ] ); $def = $admins ? (int) $admins[0] : 1; }
			$wpdb->query( $wpdb->prepare( 'UPDATE ' . Data::t( 'aq_grants' ) . ' SET author_id = %d WHERE author_id = 0', $def ) );
		}
		update_option( 'aq_grants_import_mtime', $mtime, true );
	}

	// ── Grants as authored, Studio-editable content (operator directive 2026-06-18) ─────────────────────
	// Grants live in aq_grants (imported from data/outreach-grants.json + grown by ArtaCycle's grant phase),
	// now each AUTHORED (default /u/arash) and editable in Studio like courses/topics. The operator or the
	// author at Creator tier can change any field; create makes a new grant; delete soft-deletes (active=0).
	const GRANT_DEADLINE_TYPES = [ 'fixed_date', 'annual_recurring', 'rolling' ];

	/** Edit gate: operators always; otherwise the author at the Creator tier (mirrors Typology::can_edit). */
	public static function grant_can_edit( $uid, $author_id ) {
		if ( user_can( $uid, 'manage_options' ) ) { return true; }
		$r = self::creator_rank( $uid );
		return (int) $uid > 0 && (int) $uid === (int) $author_id && ! empty( $r['caps']['can_create'] );
	}
	public static function grant_can_create( $uid ) {
		if ( user_can( $uid, 'manage_options' ) ) { return true; }
		$r = self::creator_rank( $uid );
		return ! empty( $r['caps']['can_create'] );
	}
	/** The default grant author (the platform creator, /u/arash) — shared with courses/topics. */
	private static function grant_default_author() {
		$uid = (int) get_option( 'aq_course_author_uid' );
		if ( $uid > 0 ) { return $uid; }
		$admins = get_users( [ 'role' => 'administrator', 'number' => 1, 'fields' => 'ID' ] );
		return $admins ? (int) $admins[0] : 138324856;
	}
	private static function grant_author_card( $uid ) {
		$u = (int) $uid ? get_userdata( (int) $uid ) : null;
		return $u ? [ 'id' => (int) $uid, 'name' => $u->display_name ?: $u->user_nicename, 'slug' => $u->user_nicename ] : [ 'id' => 0, 'name' => '', 'slug' => '' ];
	}

	/** Writable column map from the request — only the fields actually present (partial update). */
	private static function grant_fields_from( $req ) {
		$has = function ( $k ) use ( $req ) { return null !== Rest::p( $req, $k, null ); };
		$txt = function ( $k, $max ) use ( $req ) { return substr( sanitize_text_field( (string) Rest::p( $req, $k, '' ) ), 0, $max ); };
		$f = [];
		if ( $has( 'title' ) )           { $f['title'] = $txt( 'title', 255 ); }
		if ( $has( 'funder' ) )          { $f['funder'] = $txt( 'funder', 255 ); }
		if ( $has( 'url' ) )             { $f['url'] = esc_url_raw( (string) Rest::p( $req, 'url', '' ) ); }
		if ( $has( 'country' ) )         { $f['country'] = $txt( 'country', 128 ); }
		if ( $has( 'category' ) )        { $f['category'] = $txt( 'category', 64 ); }
		if ( $has( 'currency' ) )        { $f['currency'] = $txt( 'currency', 8 ); }
		if ( $has( 'amount_cad' ) )      { $f['amount_cad'] = max( 0, (int) Rest::p( $req, 'amount_cad', 0 ) ); }
		if ( $has( 'amount_display' ) )  { $f['amount_display'] = $txt( 'amount_display', 128 ); }
		if ( $has( 'deadline' ) )        { $f['deadline'] = substr( preg_replace( '/[^0-9-]/', '', (string) Rest::p( $req, 'deadline', '' ) ), 0, 10 ); }
		if ( $has( 'deadline_type' ) )   { $dt = $txt( 'deadline_type', 32 ); $f['deadline_type'] = in_array( $dt, self::GRANT_DEADLINE_TYPES, true ) ? $dt : 'fixed_date'; }
		if ( $has( 'estimated' ) )       { $f['estimated'] = Rest::p( $req, 'estimated', 0 ) ? 1 : 0; }
		if ( $has( 'eligibility_ca' ) )  { $f['eligibility_ca'] = $txt( 'eligibility_ca', 32 ); }
		if ( $has( 'eligibility_intl' ) ){ $f['eligibility_intl'] = $txt( 'eligibility_intl', 32 ); }
		if ( $has( 'allows_regranting' ) ){ $f['allows_regranting'] = $txt( 'allows_regranting', 16 ); }
		if ( $has( 'fit' ) )             { $f['fit'] = max( 0, min( 5, (int) Rest::p( $req, 'fit', 0 ) ) ); }
		if ( $has( 'confidence' ) )      { $f['confidence'] = $txt( 'confidence', 16 ); }
		if ( $has( 'capacity' ) )        { $f['capacity'] = max( 1, (int) Rest::p( $req, 'capacity', 1 ) ); }
		if ( $has( 'points' ) )          { $f['points'] = max( 0, (int) Rest::p( $req, 'points', 0 ) ); }
		if ( $has( 'summary' ) )         { $f['summary'] = sanitize_textarea_field( (string) Rest::p( $req, 'summary', '' ) ); }
		if ( $has( 'red_flags' ) )       { $f['red_flags'] = sanitize_textarea_field( (string) Rest::p( $req, 'red_flags', '' ) ); }
		if ( $has( 'active' ) )          { $f['active'] = Rest::p( $req, 'active', 1 ) ? 1 : 0; }
		$f['updated_ts'] = Data::now();
		return $f;
	}

	/** POST /grants — create a new grant/sponsor (operator or Creator). author_id = the creator. */
	public static function grant_create( $req ) {
		$uid = Rest::uid();
		if ( ! self::grant_can_create( $uid ) ) { return Rest::err( 'forbidden', 'Reach the Creator tier (1,000 points) to author grants', 403 ); }
		$title = sanitize_text_field( (string) Rest::p( $req, 'title', '' ) );
		if ( mb_strlen( $title ) < 4 ) { return Rest::err( 'bad_request', 'Give the grant a clear title', 400 ); }
		$slug = sanitize_title( (string) ( Rest::p( $req, 'slug', '' ) ?: $title ) );
		if ( $slug === '' ) { $slug = 'grant-' . substr( md5( $title ), 0, 8 ); }
		if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_grants' ) . ' WHERE slug = %s', [ $slug ] ) ) { $slug .= '-' . substr( md5( (string) Data::now() . $title ), 0, 5 ); }
		$row = self::grant_fields_from( $req ) + [ 'slug' => $slug, 'author_id' => $uid, 'active' => 1 ];
		if ( empty( $row['capacity'] ) ) { $row['capacity'] = max( 1, (int) round( ( $row['amount_cad'] ?? 0 ) / 10000 ) ); }
		if ( ! isset( $row['points'] ) ) { $row['points'] = (int) ( $row['amount_cad'] ?? 0 ); }
		$id = Data::insert( 'aq_grants', $row );
		return [ 'ok' => true, 'id' => (int) $id, 'slug' => $slug ];
	}

	/** POST /grants/{id}/update — edit any field (author or operator). author_id is never reassigned here. */
	public static function grant_update( $req ) {
		$uid = Rest::uid();
		$id  = Rest::pint( $req, 'id' );
		$g = Data::one( 'SELECT id, author_id FROM ' . Data::t( 'aq_grants' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $g ) { return Rest::err( 'not_found', 'Unknown grant', 404 ); }
		if ( ! self::grant_can_edit( $uid, $g['author_id'] ) ) { return Rest::err( 'forbidden', 'Only the grant author can edit it', 403 ); }
		$f = self::grant_fields_from( $req );
		unset( $f['author_id'] );
		Data::update( 'aq_grants', $f, [ 'id' => $id ] );
		return [ 'ok' => true, 'updated' => array_keys( $f ) ];
	}

	/** POST /grants/{id}/delete — soft-delete (active=0), keeping the row + its claims/history. */
	public static function grant_delete( $req ) {
		$uid = Rest::uid();
		$id  = Rest::pint( $req, 'id' );
		$g = Data::one( 'SELECT id, author_id FROM ' . Data::t( 'aq_grants' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $g ) { return Rest::err( 'not_found', 'Unknown grant', 404 ); }
		if ( ! self::grant_can_edit( $uid, $g['author_id'] ) ) { return Rest::err( 'forbidden', 'Only the grant author can delete it', 403 ); }
		Data::update( 'aq_grants', [ 'active' => 0, 'updated_ts' => Data::now() ], [ 'id' => $id ] );
		return [ 'ok' => true ];
	}

	/** GET /studio/grants — the editable list (operator: all; author: own). Lightweight cards. */
	public static function grant_studio_list( $req ) {
		$uid = Rest::uid();
		if ( ! self::grant_can_create( $uid ) ) { return Rest::err( 'forbidden', 'Reach the Creator tier (1,000 points) to use the Studio', 403 ); }
		$op = user_can( $uid, 'manage_options' );
		$rows = $op
			? Data::all( 'SELECT id, title, funder, category, deadline, fit, active, author_id FROM ' . Data::t( 'aq_grants' ) . ' ORDER BY active DESC, fit DESC, id DESC LIMIT 500', [] )
			: Data::all( 'SELECT id, title, funder, category, deadline, fit, active, author_id FROM ' . Data::t( 'aq_grants' ) . ' WHERE author_id = %d ORDER BY active DESC, fit DESC, id DESC LIMIT 500', [ $uid ] );
		$items = array_map( function ( $r ) {
			return [ 'id' => (int) $r['id'], 'title' => $r['title'], 'funder' => $r['funder'], 'category' => $r['category'], 'deadline' => $r['deadline'], 'fit' => (int) $r['fit'], 'active' => (int) $r['active'] ];
		}, (array) $rows );
		return [ 'items' => $items, 'total' => count( $items ), 'can_create' => true ];
	}

	/** GET /studio/grants/{id} — the FULL raw grant for editing. */
	public static function grant_studio_get( $req ) {
		$uid = Rest::uid();
		$id  = Rest::pint( $req, 'id' );
		$r = Data::one( 'SELECT * FROM ' . Data::t( 'aq_grants' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $r ) { return Rest::err( 'not_found', 'Unknown grant', 404 ); }
		if ( ! self::grant_can_edit( $uid, $r['author_id'] ) ) { return Rest::err( 'forbidden', 'Only the grant author can edit it', 403 ); }
		return [
			'id' => (int) $r['id'], 'slug' => $r['slug'], 'title' => $r['title'], 'funder' => $r['funder'], 'url' => $r['url'],
			'country' => $r['country'], 'category' => $r['category'], 'currency' => $r['currency'], 'amount_cad' => (int) $r['amount_cad'],
			'amount_display' => $r['amount_display'], 'deadline' => $r['deadline'], 'deadline_type' => $r['deadline_type'],
			'estimated' => (bool) $r['estimated'], 'eligibility_ca' => $r['eligibility_ca'], 'eligibility_intl' => $r['eligibility_intl'],
			'allows_regranting' => $r['allows_regranting'], 'fit' => (int) $r['fit'], 'confidence' => $r['confidence'],
			'capacity' => (int) $r['capacity'], 'points' => (int) $r['points'], 'summary' => (string) $r['summary'],
			'red_flags' => (string) $r['red_flags'], 'active' => (int) $r['active'], 'author' => self::grant_author_card( $r['author_id'] ),
		];
	}

	/**
	 * Tombstones for deleted courses — slugs a creator/operator removed via Courses::delete, kept so the
	 * deploy-time reseed (import_courses) never resurrects them. Ticket #83: a deleted course reappeared
	 * after the next push because the seed re-INSERTs any bundled slug it finds missing from aq_courses;
	 * persisting the deletion here makes it stick across deploys. Low-volume autoloaded option (deletions
	 * are rare), the same import-machinery class as aq_courses_import_mtime — slugs are public catalogue
	 * data, never secret.
	 */
	const DELETED_COURSES_OPTION = 'aq_courses_deleted';

	/** Record a deleted course slug so a future deploy seed won't re-create it (idempotent). */
	public static function tombstone_course( $slug ) {
		$slug = sanitize_title( (string) $slug );
		if ( $slug === '' ) { return; }
		$list = (array) get_option( self::DELETED_COURSES_OPTION, [] );
		if ( ! in_array( $slug, $list, true ) ) {
			$list[] = $slug;
			update_option( self::DELETED_COURSES_OPTION, array_values( $list ), true );
		}
	}

	/** Whether a course slug was deleted in prod (so the bundle seed must skip it). */
	public static function course_tombstoned( $slug ) {
		return in_array( sanitize_title( (string) $slug ), (array) get_option( self::DELETED_COURSES_OPTION, [] ), true );
	}

	/**
	 * Slugs the deploy-time seed has already PROVISIONED at least once. Prod is the source of truth (#83):
	 * once a slug is recorded here, import_courses never writes that course again — so operator/creator edits
	 * made on prod survive every later deploy, and a course that is later deleted is not re-created on the
	 * next push. Public catalogue slugs, never secret; same low-volume autoloaded option class as
	 * aq_courses_deleted / aq_courses_import_mtime.
	 */
	const SEEDED_COURSES_OPTION = 'aq_courses_seeded';

	/**
	 * Provision the bundled course catalogue from data/course-imports.json (the export-courses.php
	 * `{ specs, yt_meta }` shape) on deploy — so a plugin push ALONE lands a "create a course" content
	 * ticket on prod, with no SSH and no DB push (the prod DB is unreachable from the ticket workspace).
	 * Filemtime-gated like import_grants. PROVISION-ONCE, never destructive (#83): the seed only ever
	 * INSERTs a brand-new course (a slug that is neither already on prod, nor in SEEDED_COURSES_OPTION, nor
	 * tombstoned), records that slug as seeded, and from then on leaves the course entirely to prod. It does
	 * NOT update or re-create a course it has already provisioned — so operator/creator edits made on prod
	 * (the Studio editor) survive every later deploy, and a deleted course is never resurrected by the next
	 * push. Course CONTENT is changed on prod, never by re-importing over the live row. Slugs absent from
	 * the file are never touched; an unreadable/malformed file leaves the gate unstamped so a corrected
	 * bundle re-attempts. The competition (seasons, rankings, podium) attaches automatically — it is
	 * data-driven off the sections + activity.
	 */
	public static function import_courses() {
		$file = AQ_DIR . '/data/course-imports.json';
		if ( ! is_readable( $file ) ) { return; }
		$mtime = (string) filemtime( $file );
		if ( get_option( 'aq_courses_import_mtime' ) === $mtime ) { return; }

		$data  = json_decode( (string) file_get_contents( $file ), true );
		$specs = ( is_array( $data ) && isset( $data['specs'] ) && is_array( $data['specs'] ) ) ? $data['specs'] : [];
		$yt    = ( is_array( $data ) && isset( $data['yt_meta'] ) && is_array( $data['yt_meta'] ) ) ? $data['yt_meta'] : [];
		if ( ! $specs ) { return; } // malformed/empty → leave the gate unstamped so a corrected file re-runs

		// ID-preserving lesson sync (aq_progress / section boards / votes key on the lesson id, so a
		// re-import must keep matched rows IN PLACE — see lesson-sync.inc.php).
		$inc = AQ_DIR . '/tools/lesson-sync.inc.php';
		if ( ! is_readable( $inc ) ) { return; }
		require_once $inc;

		// Pipeline-imported courses belong to the operator's member account (/u/arash —
		// `aq_course_author_uid`, operator directive 2026-06-12); first admin only as a fresh-install fallback.
		$default_author = (int) get_option( 'aq_course_author_uid', 0 );
		if ( ! $default_author ) {
			$admins = get_users( [ 'role' => 'administrator', 'number' => 1, 'fields' => 'ID' ] );
			$default_author = $admins ? (int) $admins[0] : 1;
		}

		$now    = Data::now();
		$seeded = array_flip( array_map( 'sanitize_title', (array) get_option( self::SEEDED_COURSES_OPTION, [] ) ) );
		$dirty  = false; // whether $seeded gained an entry this run (persist it once at the end)
		$cids   = [];
		foreach ( $specs as $spec ) {
			if ( ! is_array( $spec ) ) { continue; }
			$slug = sanitize_title( (string) ( $spec['slug'] ?? $spec['title'] ?? '' ) );
			if ( $slug === '' || empty( $spec['lessons'] ) ) { continue; }
			if ( self::course_tombstoned( $slug ) ) { continue; } // deleted in prod — never resurrect (#83)
			if ( isset( $seeded[ $slug ] ) ) { continue; }        // already provisioned once — prod owns it now
			// If the course already exists on prod (a past deploy, or hand-created in the Studio editor), DO
			// NOT touch it: just record it as seeded, so prod edits stick and a later deletion can't be undone
			// by re-insertion on the next push. Only a genuinely new slug is provisioned (inserted) below (#83).
			if ( Data::one( 'SELECT id FROM ' . Data::t( 'aq_courses' ) . ' WHERE slug = %s', [ $slug ] ) ) {
				$seeded[ $slug ] = 1; $dirty = true;
				continue;
			}
			$author    = (int) ( $spec['author_id'] ?? 0 ) ?: $default_author;
			$c_title   = sanitize_text_field( (string) ( $spec['title'] ?? '' ) );
			$c_summary = wp_kses_post( (string) ( $spec['summary'] ?? '' ) );
			$c_channel = sanitize_text_field( (string) ( $spec['channel'] ?? '' ) );
			// Catalogue subject facets — honour an explicit, validated spec `topic`/`subtopic`, else
			// classify the text. The sub is scoped to the resolved house (ticket #89), so it must be
			// computed AFTER the house is known.
			$c_topic = Topics::is_valid( (string) ( $spec['topic'] ?? '' ) ) ? (string) $spec['topic'] : Topics::classify( $c_title, $c_channel, $c_summary );
			$c_sub   = Topics::is_valid_sub( $c_topic, (string) ( $spec['subtopic'] ?? '' ) ) ? (string) $spec['subtopic'] : Topics::classify_sub( $c_topic, $c_title, $c_channel, $c_summary );
			// Denormalize the discovery membership (houses/disciplines CSVs) so an imported course is reachable
			// through the catalogue's topic + discipline filters immediately, not only after a migration (#155).
			$c_mem = Topics::membership( $c_topic, $c_sub );
			$cid = Data::insert( 'aq_courses', [
				'slug'        => $slug,
				'title'       => $c_title,
				'summary'     => $c_summary,
				'image'       => esc_url_raw( (string) ( $spec['image'] ?? '' ) ),
				'channel'     => $c_channel,
				'author_id'   => $author,
				'topic'       => $c_topic,
				'subtopic'    => $c_sub,
				'houses'      => $c_mem['houses'],
				'disciplines' => $c_mem['disciplines'],
				'status'      => 'publish',
				// Entry fee in coins. 0 (the default) → derived from content length (Funds::course_cost).
				'price'       => max( 0, (int) ( $spec['price'] ?? 0 ) ),
				'created'     => $now,
			] );
			aq_sync_lessons( $cid, (array) $spec['lessons'] );
			$seeded[ $slug ] = 1; $dirty = true;
			$cids[] = $cid;
		}
		if ( $dirty ) { update_option( self::SEEDED_COURSES_OPTION, array_keys( $seeded ), true ); }

		// Nothing newly provisioned → leave prod entirely untouched: a no-op deploy must NOT rewrite the
		// per-video metadata or re-seed the monitor (the hourly monitor owns the live view snapshots) (#83).
		if ( ! $cids ) { update_option( 'aq_courses_import_mtime', $mtime, true ); return; }

		// Cache per-video YouTube metadata (views/channel/subs) for the lesson player. MUST run BEFORE
		// sync_registry below, which seeds each new monitor row's starting view snapshot from this option.
		foreach ( $yt as $vid => $m ) {
			$vid = sanitize_text_field( (string) $vid );
			if ( $vid === '' || ! is_array( $m ) ) { continue; }
			update_option( 'aq_yt_meta_' . $vid, [
				'views'       => (int) ( $m['views'] ?? 0 ),
				'upload_ts'   => (int) ( $m['upload_ts'] ?? 0 ),
				'channel'     => (string) ( $m['channel'] ?? '' ),
				'channel_url' => (string) ( $m['channel_url'] ?? '' ),
				'subs'        => (int) ( $m['subs'] ?? 0 ),
				'verified'    => ! empty( $m['verified'] ),
				'avatar'      => (string) ( $m['avatar'] ?? '' ),
			], false );
		}

		// Register the imported videos with the hourly view-count monitor (carrying the import-time view
		// snapshot above as their seed), then recompute each course's view metrics + rank_score so the
		// catalogue ranks it straight away, not only after the next refresh.
		if ( class_exists( '\\AQ\\YouTube' ) ) {
			YouTube::sync_registry();
			foreach ( array_unique( $cids ) as $cid ) { YouTube::recompute_course_trend( (int) $cid ); }
		}

		update_option( 'aq_courses_import_mtime', $mtime, true );
	}

	/**
	 * Serve every dated grant as a subscribable .ics (text/calendar) at /?aq_grants_ics=1 — one
	 * all-day VEVENT per deadline with staged DISPLAY alarms (−60/−30/−14/−7/−1 days) and a stable
	 * UID so re-subscribing updates events in place. Hooked from aquest.php on template_redirect.
	 */
	public static function serve_ics() {
		$rows  = Data::all( 'SELECT slug, title, funder, url, deadline, summary FROM ' . Data::t( 'aq_grants' ) . " WHERE active = 1 AND deadline <> '' ORDER BY deadline ASC" );
		$now   = gmdate( 'Ymd\THis\Z' );
		$lines = [ 'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ArtaQuest//Outreach Grants//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:ArtaQuest grant deadlines', 'X-WR-TIMEZONE:UTC' ];
		foreach ( $rows as $g ) {
			$d = preg_replace( '/[^0-9]/', '', (string) $g['deadline'] );
			if ( strlen( $d ) !== 8 ) { continue; }
			$dtend = gmdate( 'Ymd', strtotime( $g['deadline'] . ' +1 day' ) );
			$lines[] = 'BEGIN:VEVENT';
			// FOLDED like every other line. It was not, and a funder with a long slug emitted a
			// 94-octet UID — over RFC 5545 §3.1's 75-octet limit, which strict parsers may reject.
			// Found while building ArtaMeet's feed next door; the two now fold identically.
			$lines[] = self::ics_fold( 'UID:grant-' . preg_replace( '/[^a-z0-9-]/', '', (string) $g['slug'] ) . '@artaquest.org' );
			$lines[] = 'DTSTAMP:' . $now;
			$lines[] = 'DTSTART;VALUE=DATE:' . $d;
			$lines[] = 'DTEND;VALUE=DATE:' . $dtend;
			$lines[] = self::ics_fold( 'SUMMARY:' . self::ics_esc( $g['funder'] . ': ' . $g['title'] ) );
			$lines[] = self::ics_fold( 'DESCRIPTION:' . self::ics_esc( trim( (string) $g['summary'] ) . ( $g['url'] ? "\n" . $g['url'] : '' ) . "\nhttps://artaquest.com/sponsors/" ) );
			if ( $g['url'] ) { $lines[] = self::ics_fold( 'URL:' . self::ics_esc( $g['url'] ) ); }
			foreach ( [ 60, 30, 14, 7, 1 ] as $days ) {
				$lines[] = 'BEGIN:VALARM';
				$lines[] = 'TRIGGER:-P' . $days . 'D';
				$lines[] = 'ACTION:DISPLAY';
				$lines[] = self::ics_fold( 'DESCRIPTION:' . self::ics_esc( $days . ' days to ' . $g['funder'] . ' deadline' ) );
				$lines[] = 'END:VALARM';
			}
			$lines[] = 'END:VEVENT';
		}
		$lines[] = 'END:VCALENDAR';

		nocache_headers();
		header( 'Content-Type: text/calendar; charset=utf-8' );
		header( 'Content-Disposition: inline; filename="artaquest-grants.ics"' );
		echo implode( "\r\n", $lines ) . "\r\n";
		exit;
	}

	/** Escape a value for an iCalendar text field (RFC 5545 §3.3.11). Public: Meetings emits a feed too. */
	public static function ics_esc( $s ) {
		return str_replace( [ "\\", "\n", ',', ';' ], [ "\\\\", "\\n", "\\,", "\\;" ], (string) $s );
	}

	/** Fold a content line to ≤75 octets, continuation lines prefixed with a single space. */
	public static function ics_fold( $line ) {
		if ( strlen( $line ) <= 75 ) { return $line; }
		$out = '';
		$first = true;
		while ( strlen( $line ) > 0 ) {
			$take = $first ? 75 : 74;
			$chunk = substr( $line, 0, $take );
			$line  = substr( $line, $take );
			$out  .= ( $first ? '' : "\r\n " ) . $chunk;
			$first = false;
		}
		return $out;
	}

	// ── Bug bounty / issue reports (legacy alias) ───────────────────────────
	// Superseded by the conversational contribution system (Tickets). This route forwards into
	// Tickets::create as a 'bug' so older clients keep working during cutover; new clients call
	// POST /tickets directly. Points are now flat (1 on resolve), not severity-weighted.
	public static function bug_finding( $req ) {
		$req->set_param( 'kind', 'bug' );
		return Tickets::create( $req );
	}

	// ── Creator ladder ──────────────────────────────────────────────────────
	// What the rungs GATE today, which is what the blurbs must say: `can_create` opens the Studio —
	// authoring grants (grant_can_create) and sitewide topics (Typology::can_create) — and every rung
	// carries a bigger SHELF QUOTA, the number of published works a member may keep live at once
	// (Economy::TIER_QUOTA, enforced at publish by Challenges::shelf_gate). The blurbs restate those
	// quotas, so they are kept identical to TIER_QUOTA by hand — the same discipline as Economy's
	// TIER_SHARE mirroring this ladder. The old blurbs described the courses economy (playlists,
	// enrolment revenue share) that was purged 2026-07-13; the `share` field they quoted still feeds
	// the careers page and is left alone here.
	const TIERS = [
		[ 'key' => 'quester',  'label' => 'Quester',  'share' => 0,   'points' => 0,       'caps' => [ 'can_create' => false ], 'blurb' => 'Every member starts here: submit work, join challenges, earn points — and keep up to 3 published works live.' ],
		[ 'key' => 'explorer', 'label' => 'Creator', 'share' => 50,  'points' => 1000,    'caps' => [ 'can_create' => true, 'needs_playlist_approval' => true ], 'blurb' => 'Opens the Studio: author grants and sitewide topics, and keep up to 10 published works live.' ],
		[ 'key' => 'voyager',  'label' => 'Expert',   'share' => 70,  'points' => 10000,   'caps' => [ 'can_create' => true, 'can_edit_content' => true ], 'blurb' => 'Everything a Creator can do, with room for 25 published works on your shelf.' ],
		[ 'key' => 'pioneer',  'label' => 'Pioneer',  'share' => 90,  'points' => 100000,  'caps' => [ 'can_create' => true, 'can_edit_content' => true, 'can_upload_any' => true ], 'blurb' => 'Room for 60 published works — keep far more of your catalogue live at once.' ],
		[ 'key' => 'legend',   'label' => 'Legend',   'share' => 100, 'points' => 1000000, 'caps' => [ 'can_create' => true, 'can_edit_content' => true, 'can_upload_any' => true ], 'blurb' => 'No shelf limit at all: every work you publish can stay live for good.' ],
	];

	public static function creator_ladder( $req ) {
		return [ 'tiers' => self::TIERS, 'symbol' => '₳' ];
	}

	/**
	 * PURE-ish — a member's creator-ladder rank + capabilities: points-derived rung, with the
	 * PLATFORM-OPERATOR override (operator directive 2026-06-12): the catalogue is authored under
	 * the operator's member account (/u/arash — `aq_course_author_uid`, which every importer
	 * defaults to). Administrators therefore hold EVERY creator capability regardless of points and
	 * rank no lower than Creator. Caps are granted directly — never by minting points: the ledger
	 * stays honest. Used by creator_status, the public profile, and the course-edit gates.
	 */
	/** The tier whose point threshold a balance has reached (walks the ladder). Pure — lets a list compute
	 *  many members' tiers from one batched points query instead of a points read per member. */
	public static function tier_for_points( $points ) {
		$tier = self::TIERS[0];
		foreach ( self::TIERS as $t ) { if ( (int) $points >= $t['points'] ) { $tier = $t; } }
		return $tier;
	}

	public static function creator_rank( $uid ) {
		$uid    = (int) $uid;
		$points = Economy::points_balance( $uid );
		$tier   = self::tier_for_points( $points );
		$caps   = $tier['caps'];
		// Operator GRANT (Studio Members): an operator can unlock course-creation for a trusted member who is
		// still below the Creator point threshold (user meta aq_grant_create) — they then show + behave as a
		// Creator. Revoking clears the meta; their point-earned tier is untouched.
		if ( $uid && empty( $caps['can_create'] ) && get_user_meta( $uid, 'aq_grant_create', true ) ) {
			$caps = array_merge( $caps, [ 'can_create' => true ] );
			if ( $tier['points'] < self::TIERS[1]['points'] ) { $tier = self::TIERS[1]; }
		}
		if ( $uid && user_can( $uid, 'manage_options' ) ) {
			$caps = [ 'can_create' => true, 'can_edit_content' => true, 'can_upload_any' => true ];
			if ( $tier['points'] < self::TIERS[1]['points'] ) { $tier = self::TIERS[1]; } // floor at Creator
		}
		return [ 'tier' => $tier, 'caps' => $caps, 'points' => $points ];
	}

	/** True when $uid may edit course $cid: its owner holding any creator rung (Creator+), or an
	 *  operator. "Creator tiers have all edit access to their courses" — operator rule 2026-06-12. */
	public static function can_edit_course( $uid, $cid ) {
		$uid = (int) $uid;
		if ( ! $uid ) { return false; }
		if ( user_can( $uid, 'manage_options' ) ) { return true; }
		$author = (int) Data::col( 'SELECT author_id FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ (int) $cid ] );
		if ( $author !== $uid ) { return false; }
		$r = self::creator_rank( $uid );
		return ! empty( $r['caps']['can_create'] );
	}

	public static function creator_status( $req ) {
		$uid    = Rest::uid();
		$rank   = self::creator_rank( $uid );
		$tier   = $rank['tier'];
		$caps   = $rank['caps'];
		$points = $rank['points'];
		$next = null; $next_at = 0;
		foreach ( self::TIERS as $i => $t ) {
			if ( $t['key'] === $tier['key'] && isset( self::TIERS[ $i + 1 ] ) ) { $next = self::TIERS[ $i + 1 ]['label']; $next_at = self::TIERS[ $i + 1 ]['points']; }
		}
		$subs = Data::all( 'SELECT grant_id id, status, submitted_ts FROM ' . Data::t( 'aq_grant_claims' ) . ' WHERE user_id = %d ORDER BY id DESC LIMIT 20', [ $uid ] );
		return [
			'points' => $points, 'breakdown' => Economy::points_by_track( $uid ), 'coins' => Economy::coin_balance( $uid ), 'symbol' => '₳',
			'tier' => $tier['label'], 'tier_key' => $tier['key'], 'share' => $tier['share'], 'caps' => $caps,
			'operator' => $uid > 0 && user_can( $uid, 'manage_options' ), // unlocks the Studio operator Console
			'next_tier' => $next, 'next_at' => $next_at,
			'submissions' => array_map( fn( $s ) => [ 'id' => (int) $s['id'], 'status' => $s['status'], 'date' => (int) $s['submitted_ts'] ], $subs ),
		];
	}

	/**
	 * POST /creator/submit-playlist — RETIRED, and now it says so instead of pretending.
	 *
	 * Courses from YouTube playlists went with the rest of the legacy platform (purged 2026-07-13);
	 * a submission is a public Kaggle notebook now. The handler nevertheless kept answering
	 * "Submitted for review." while filing the playlist into aq_bug_findings — a table nothing reads
	 * as a submission, and whose one live reader COUNTS its rows toward a bug-hunter award
	 * (Awards.php). So every hopeful playlist was dropped on the floor AND miscounted as a bug report.
	 * A dead endpoint that reports success is worse than one that reports the truth: 410, and no write.
	 * The route stays so an old client gets a real answer rather than a 404 it can't explain.
	 */
	public static function submit_playlist( $req ) {
		return Rest::err(
			'retired',
			'Playlist submissions are retired — courses from YouTube ended in 2026. A submission is now a public Kaggle notebook that has been run: paste its URL in the Studio.',
			410
		);
	}

	// ── Public database explorer — FULL TRANSPARENCY ───────────────────────
	// Every table, every row, every column is served exactly as stored — except for cells that carry
	// a CREDENTIAL, whose value (only the value) is masked; see redact_row. Everything else is open:
	// safe because the DB holds nothing else that enables takeover — our own app secrets live only in
	// the environment (see Secrets.php) and password material is INERT — password + application-password
	// logins are disabled platform-wide (Auth::harden), so a read hash is useless. Assume the whole
	// world reads this; that is the design.
	//
	// Masking is DEFAULT-DENY, and it is default-deny because the allow-list version FAILED. Until
	// 2026-08-04 redact_row was a short list of cells we had thought of ourselves, so it covered our
	// code and nothing else: Jetpack — a platform plugin we do not control and never reviewed — kept
	// its `blog_token` and `user_tokens` in the wp_options row `jetpack_private_options`, and
	// GET /offline/db/wp_options published them, unauthenticated, to anyone who asked. A credential
	// nobody remembered to name must now be masked ANYWAY, by the shape of its key, so the next plugin
	// to store one is covered before anyone notices it exists.

	/** Per-table, per-column masks: the cells we know by name (prefix-relative table => column => why). */
	const REDACT_COLUMNS = [
		// WHAT A MEETING IS CALLED IS THE MEMBER'S WORDS. The row itself is ordinary platform
		// activity and belongs in the public record — when it is, who is in it, how many seats — but
		// the title and agenda are things a person typed about their own business, and the product
		// tells them the room is sealed. Publishing "Divorce settlement, 3pm, with these two people"
		// beside that promise is the promise being false. Masking is only a mask: the real fix is to
		// seal these into the room payload so the server never holds them at all, and it is named as
		// the next step rather than implied by this line.
		'aq_meets'      => [ 'title' => 'meeting title', 'agenda' => 'meeting agenda' ],
		// A notification NAMES the other person: "Arash sent you an encrypted message", "Eceergun10
		// started following you", "Arash is calling you" — four times over. Joined to `user_id` and
		// `created` that is a member-to-member behavioural graph with timestamps: who contacted whom,
		// when, and how insistently. Masking the two prose columns leaves `type`, `user_id`, `read`
		// and `created` fully public, so the SHAPE stays auditable — how many security alarms fired
		// and on which days, how much traffic each kind carries — while the row stops naming a person.
		// The narrower fix than withholding the table, which would also have hidden the Watchdog
		// security alarms that exist to be read.
		'aq_notifications' => [ 'title' => 'names another member', 'body' => 'names another member' ],
		// A public reset key is inert while password login is disabled, but it would become a takeover
		// vector the moment the AQ_ALLOW_PASSWORD_LOGIN escape hatch were set — so it stays masked.
		//
		// user_email: THE ACCOUNT IDENTIFIER, not a research artefact. Sign-in is an emailed one-time
		// code, so the address is half of every member's credential — and `?table=wp_users` handed the
		// complete set to any anonymous caller in ONE request, which is the difference between a
		// transparent record and a mailing list. Nothing the explorer exists to prove — a
		// reproducibility claim, a ledger entry, a moderation decision — is checked against a member's
		// inbox. This is the same line PRIVATE_TABLES already draws for aq_order_ship ("where a member
		// physically lives is promised private"): the database is public; a private person's contact
		// details are not what it is a record OF. Masking cannot un-publish what has already been
		// scraped and an address cannot be rotated — this stops the next harvest, not the last one.
		//
		// user_login: MASKING user_email ALONE SHIPS DEFEATED. Auth::unique_login builds the login as
		// `strstr( $email, '@', true )` — the address's local part, by construction, not coincidence.
		// Live on production: every human member's user_login IS their local part, and every one of
		// those addresses is @gmail.com, so appending the domain reconstructs the address exactly from
		// the column sitting beside the masked one. Nothing public consumes it: the handle is
		// `user_nicename` (the /u/<slug> key), password login is off, and every remaining reference is
		// an internal Watchdog/Sessions/Vault audit line.
		// This narrows the leak rather than sealing it — `user_nicename` is derived the same way and
		// stays deliberately public, so a determined guesser can still try `<nicename>@gmail.com`
		// (lossy: nicename turns `.` into `-`). Sealing that would mean renaming existing handles,
		// which changes every profile URL — flagged to the operator, not decided here.
		'users'         => [
			'user_activation_key' => 'password-reset key',
			'user_email'          => 'member email address — the sign-in identifier',
			'user_login'          => 'derived from the email local part — see user_email',
		],
		// The verifier for a LIVE publication secret. The raw secret is 20 random bytes and
		// unrecoverable from sha256, so publication was never forgeable from this cell; masking keeps a
		// standing credential's verifier out of the public record on principle, and stops the row
		// advertising that a member has an unconfirmed publication sitting in their inbox right now.
		// `author_nonce` stays visible: it IS the passkey challenge, and its value is unpredictability
		// plus one-time use, not secrecy.
		'aq_notebooks'  => [ 'author_token' => 'publication confirm verifier' ],
		// Same doctrine: the hash of a live personal API token (the row + label + usage stay visible).
		'aq_api_tokens' => [ 'token_hash' => 'API token hash' ],
	];

	/** The key/value stores a credential actually lands in — table => [ key column, value column ].
	 *  These are the only columns the default-deny name sweep below reads, because they are the only
	 *  places where a name we have never seen chooses what a value means. */
	const REDACT_KEYED = [
		'options'     => [ 'option_name', 'option_value' ],
		'sitemeta'    => [ 'meta_key', 'meta_value' ], // multisite network options
		'usermeta'    => [ 'meta_key', 'meta_value' ],
		'postmeta'    => [ 'meta_key', 'meta_value' ],
		'termmeta'    => [ 'meta_key', 'meta_value' ],
		'commentmeta' => [ 'meta_key', 'meta_value' ],
	];

	/** DEFAULT-DENY key shape: a name segment that says "this value is a credential". Segment-anchored
	 *  (`_word_`), never a bare substring, so `aq_passkey_table_version` and `aq_grants_authored` stay
	 *  fully public while `jetpack_private_options`, `session_tokens`, `recovery_keys`, `auth_key` and
	 *  `nonce_salt` do not. */
	const REDACT_NAME_RE = '/(^|_)(tokens?|secrets?|keys?|salt|passwords?|private|credentials?|auth)(_|$)/i';

	/** Meta keys holding a private person's PRECISE IDENTITY — masked by name, in every key/value
	 *  store, because no credential-shaped rule can see them: `aq_birthday` looks exactly like the
	 *  ordinary public profile facts sitting beside it.
	 *
	 *  Only the EXACT DATE is withheld, and the fact is not hidden — the public profile publishes the
	 *  member's AGE (Verify::age), so a reader still learns how old somebody is. What a stranger loses
	 *  is the precision that makes a birth date an identity-VERIFICATION datum rather than a fact
	 *  about a person: full legal name + city + exact date of birth is what a bank or a telco asks
	 *  for, all three are published together on a profile the operator has designated a dating
	 *  surface, and the date is now mandatory at sign-up rather than volunteered.
	 *
	 *  Deliberately NOT here, and each for a reason: `aq_full_name` (the operator wants a profile to
	 *  rank for a member's real name), `aq_location`, `aq_relationship`, `aq_languages` (self-declared,
	 *  freely blankable, and the entire point of the dating surface), `aq_last_seen` (already coarsened
	 *  to UTC midnight of the last active day). Add to this list only for data a member cannot decline
	 *  to give AND cannot blank.
	 *
	 *  The rest of this list is not about precision but about COPIES AND PROMISES — each was found by
	 *  a live sweep of all 164 usermeta rows, and each is a datum with no public consumer at all:
	 *
	 *  • `wpcom_user_data` — a WordPress.com platform blob holding `s:5:"email";s:27:"…"` in a
	 *    serialised value. A per-COLUMN mask on wp_users structurally cannot see an address embedded
	 *    in a VALUE in a key/value store, and REDACT_NAME_RE cannot match `wpcom_user_data` (no
	 *    credential segment). This is the Jetpack shape exactly: a platform plugin we do not control
	 *    writing member data under a name nobody classified. An email mask is only as strong as its
	 *    least-guarded copy.
	 *  • `community-events-location` — WordPress core caches the member's IP here for the dashboard
	 *    events widget. An IP address locates a person, and this project's standing rule is to publish
	 *    the NAME or nothing, never the thing that locates someone.
	 *  • `aq_google_sub` — the Google account subject id. Stable, permanent, and the same value
	 *    identifies this person to every other service using Google sign-in: a cross-service identity
	 *    linkage, published for a member who only ever chose "sign in with Google".
	 *  • `aq_birth_min` — birth time to the MINUTE. An astrology input (Verify::set_birthtime), and
	 *    beside a date of birth it is the most precise identifier a person has.
	 *  • `aq_gender` — Verify::set_gender documents this as "opt-in … ArtaCredits matching only", and
	 *    no public route emits it. The DB export published it anyway, which makes it a broken promise
	 *    rather than a transparency decision. */
	const REDACT_IDENTITY = [
		'aq_birthday'               => 'exact date of birth — the age is public on the profile',
		'wpcom_user_data'           => 'platform account blob — carries the sign-in email address',
		'community-events-location' => 'cached IP address',
		'aq_google_sub'             => 'Google account identifier',
		'aq_birth_min'              => 'exact birth time',
		'aq_gender'                 => 'opt-in, for ArtaCredits matching only',
	];

	/** Credential-SHAPED names that hold nothing secret, so default-deny must not withhold them.
	 *  `disallowed_keys` and `moderation_keys` are WordPress's comment word-lists — publishing what is
	 *  auto-moderated is exactly the kind of thing this explorer exists to show. A reCAPTCHA *site* key
	 *  is public by definition: it is rendered into the page HTML for every visitor (the secret half is
	 *  `secret_key`, which is not here and would stay masked). Each entry earned its place by being
	 *  checked; do not add one on the strength of its name alone. */
	const REDACT_PUBLIC = [ 'disallowed_keys', 'moderation_keys', 'aq_recaptcha_site_key' ];

	/** Second net: a VALUE that is unmistakably a credential is withheld whatever its key is called —
	 *  the same shapes Watchdog's hourly secret-leak scan alarms on, so a plugin that writes a token
	 *  under a boring name is masked here and paged for there. Deliberately narrow (vendor prefix +
	 *  a long random tail, or a PRIVATE KEY PEM block): a bare substring false-positives on ordinary
	 *  cached data. The honeytrap values are `aqk_<hex>` and match none of these — see below. */
	const REDACT_VALUE_RE = '/\b(sk_live_|rk_live_|whsec_)[0-9a-zA-Z]{10,}|sk-ant-[0-9a-zA-Z_\-]{10,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bGOCSPX-[0-9A-Za-z_\-]{10,}|\bya29\.[0-9A-Za-z_\-]{20,}|\bhf_[0-9A-Za-z]{20,}|\bghp_[0-9A-Za-z]{30,}|\bgithub_pat_[0-9A-Za-z_]{30,}/';

	/**
	 * Mask the credential-bearing cells of one row. ONLY values are replaced — the row's existence,
	 * its key and every other column stay fully visible, so the transparency promise ("every row is
	 * public") holds exactly; what is withheld is a credential's value and nothing else.
	 */
	public static function redact_row( $table, $row ) {
		global $wpdb;
		$msg  = '••• protected — not exposed for account security';
		$name = strpos( (string) $table, $wpdb->prefix ) === 0 ? substr( (string) $table, strlen( $wpdb->prefix ) ) : (string) $table;

		foreach ( self::REDACT_COLUMNS[ $name ] ?? [] as $col => $why ) {
			if ( ! empty( $row[ $col ] ) ) { $row[ $col ] = $msg . ' (' . $why . ')'; }
		}

		if ( isset( self::REDACT_KEYED[ $name ] ) ) {
			[ $kc, $vc ] = self::REDACT_KEYED[ $name ];
			if ( isset( $row[ $kc ] ) && array_key_exists( $vc, $row ) ) {
				$why = self::redact_reason( (string) $row[ $kc ], (string) $row[ $vc ] );
				if ( $why !== '' ) { $row[ $vc ] = $msg . ' (' . $why . ')'; }
			}
		}
		return $row;
	}

	/** Why this option/meta value must not be published — '' when it may be. */
	private static function redact_reason( $key, $value ) {
		// The honeytraps are DECOYS, planted in the public options table on purpose (Watchdog::TRAPS):
		// their whole job is to be scraped and then to alarm the instant anyone presents one back to
		// us. Masking them would disarm the trap silently, so they are exempted BY NAME, ahead of every
		// rule below — including any future one. They are worthless strings; nothing they protect exists.
		if ( in_array( $key, Watchdog::TRAPS, true ) ) { return ''; }
		// Names that LOOK credential-shaped and provably are not. Default-deny is the right posture, but
		// this database being readable is the product, not a concession — so where a value has been
		// positively established as public, withholding it costs transparency and buys nothing. Checked
		// against every option on production: these are the only false positives among 1,728 rows.
		// This is an allow-list of KNOWN-PUBLIC names, which is the opposite of the allow-list of
		// known-secrets that failed against Jetpack: anything not named here is still masked by default,
		// so a new credential can never be published by omission. Add to it only with evidence.
		if ( in_array( $key, self::REDACT_PUBLIC, true ) ) { return ''; }
		// Private identity — masked by name, since nothing about its SHAPE says "withhold me".
		if ( isset( self::REDACT_IDENTITY[ $key ] ) ) { return self::REDACT_IDENTITY[ $key ]; }
		if ( preg_match( '/^_(site_)?transient(_timeout)?_aq_code(try)?_/', $key ) ) { return 'sign-in code'; }
		if ( 'session_tokens' === $key ) { return 'active sign-in sessions'; }
		if ( preg_match( self::REDACT_NAME_RE, $key ) ) { return 'credential-shaped key — masked by default'; }
		if ( preg_match( self::REDACT_VALUE_RE, $value ) ) { return 'credential-shaped value — masked by default'; }
		return '';
	}

	/** Every table in the database (SQLite dev + MySQL prod), with row counts.
	 *  Hides the SQLite-integration's bookkeeping tables — `sqlite_*` internals and the
	 *  `_wp_sqlite_mysql_information_schema_*` / `_wp_sqlite_global_variables` MySQL-emulation
	 *  tables (and any other leading-underscore engine table). These are a local-dev artifact of
	 *  the PHP-WASM SQLite layer, don't exist on production MySQL, and carry no app data — so they
	 *  are pure noise in the public explorer. */
	/** Tables withheld from the public explorer + export. The DB is otherwise fully public, but a member's
	 *  PRIVATE book inspiration (aq_doc_sources: the uploaded file URLs + the full extracted source text) is
	 *  promised owner-only — and may contain third-party text the uploader has the right to use only as
	 *  private inspiration, not to redistribute. So this one table is masked, like credentials-in-flight. */
	/** aq_order_ship: a shop order's delivery address — the order itself (aq_orders) stays public,
	 *  but where a member physically lives is promised private, like the inspiration files.
	 *
	 *  aq_chats + aq_chat_msgs: THE MESSAGE METADATA GRAPH. The bodies are end-to-end encrypted, and
	 *  publishing the ciphertext is fine — but everything AROUND it was public too, and on a surface
	 *  the operator designated for dating that is the more revealing half. `aq_chats` carried
	 *  `a_uid`/`b_uid` (who talks to whom), `a_read`/`b_read` (read receipts), who started it, and
	 *  `a_block`/`b_block`/`a_mute` — so the public database announced that one member had BLOCKED
	 *  another, to that member and to everyone else. `aq_chat_msgs` carried sender and the exact
	 *  second of every message, which is a daily-routine trace and a conversation-volume graph.
	 *
	 *  This is not a retreat from transparency; it is the feature keeping the promise it makes. We
	 *  built end-to-end encryption for chat, which IS the decision that a conversation is private —
	 *  and metadata that names both parties, the timing and the block state gives away most of what
	 *  the encryption was for. Same reasoning as aq_order_ship above: the database is public; who a
	 *  member talks to is not what it is a record OF. */
	const PRIVATE_TABLES = [ 'aq_doc_sources', 'aq_order_ship', 'aq_chats', 'aq_chat_msgs' ];

	public static function all_table_names() {
		global $wpdb;
		$names = $wpdb->get_col( "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" );
		if ( ! $names ) { $names = $wpdb->get_col( 'SHOW TABLES' ); }
		$private = array_map( fn( $t ) => $wpdb->prefix . $t, self::PRIVATE_TABLES );
		return array_values( array_filter( (array) $names, fn( $n ) =>
			$n && $n[0] !== '_' && stripos( $n, 'sqlite' ) === false && ! in_array( $n, $private, true ) ) );
	}

	public static function humanize( $name ) {
		global $wpdb;
		$n = preg_replace( '/^' . preg_quote( $wpdb->prefix, '/' ) . '/', '', $name );
		return ucfirst( str_replace( '_', ' ', $n ) );
	}

	const DB_PER       = 25;      // rows per explorer page
	const DB_MAX_SKIP  = 100000;  // hard cap on OFFSET depth (legacy ?page=) so a deep page never scans
	                              // billions of rows; past it, use ?cursor= keyset or the /offline export.

	public static function db( $req ) {
		global $wpdb;
		$raw = (string) Rest::p( $req, 'table', '' );
		$all = self::all_table_names();

		if ( $raw === '' ) {
			// Row counts come from the engine's own table statistics (one cheap read), NOT a COUNT(*)
			// per table — at trillions of rows scanning every table just to draw the list is the single
			// worst thing the explorer could do. `~approximate` on huge tables, exact on small ones.
			$approx = self::approx_rows_map();
			$dict   = Schema::dictionary();
			$tables = [];
			foreach ( $all as $name ) {
				// A 0/missing estimate (genuinely empty, stats-cold, or the SQLite emulation which always
				// reports 0) → fall back to an exact COUNT, cheap precisely because the table is small/empty.
				$rows = empty( $approx[ $name ] ) ? (int) $wpdb->get_var( "SELECT COUNT(*) FROM `$name`" ) : (int) $approx[ $name ];
				$key  = preg_replace( '/^' . preg_quote( $wpdb->prefix, '/' ) . '/', '', $name ); // unprefixed dictionary key
				$tables[] = [ 'name' => $name, 'label' => self::humanize( $name ), 'desc' => $dict[ $key ]['desc'] ?? '', 'rows' => $rows ];
			}
			// The note is the promise, so it has to describe redact_row as it actually behaves: since
			// 2026-08-04 masking is default-deny by the SHAPE of a key or value, not a list of cells we
			// remembered. Naming a count ("five values are masked") would understate it and imply we
			// know every credential any plugin stores — which is the assumption that failed.
			return [ 'tables' => $tables, 'note' => 'Fully public. Every table and every row is listed, and every value is shown exactly as stored — except a credential\'s value, which is withheld. Secrets never touch the database (they live in the environment), and to keep that true whoever writes them, masking is default-deny: a key or a value shaped like a credential is withheld automatically, from any plugin, not only the cases we thought to name. The known ones: active sign-in session tokens, sign-in code transients, password-reset keys, the verifier for a live publication confirm link, and API token hashes. Only the value goes — the row, its key and every other column stay visible. Two tables are withheld whole: a member\'s private book source files and a shop order\'s delivery address. Row counts are engine estimates for very large tables.' ];
		}

		// Validate the requested table against the real list (prevents arbitrary identifiers).
		$table = null;
		foreach ( $all as $name ) { if ( $name === $raw || $name === $wpdb->prefix . $raw ) { $table = $name; break; } }
		if ( ! $table ) { return Rest::err( 'bad_table', 'Unknown table', 404 ); }

		$per   = self::DB_PER;
		$total = self::approx_rows( $table );
		// Keyset (preferred, O(page) at any depth): ?cursor=<last id>. Falls back to legacy ?page= OFFSET
		// for tables without an `id` column, and the OFFSET depth is capped so it can never become a
		// trillion-row scan. A row's `id` (when present) is the keyset cursor for the next page.
		$prev   = $wpdb->suppress_errors( true );
		$has_id = (bool) $wpdb->get_var( $wpdb->prepare( "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND COLUMN_NAME = 'id' LIMIT 1", $table ) );
		$wpdb->suppress_errors( $prev );
		if ( ! $has_id ) { // SQLite dev (information_schema absent/partial) — detect by sampling a row
			$sample = $wpdb->get_row( "SELECT * FROM `$table` LIMIT 1", ARRAY_A );
			$has_id = is_array( $sample ) && array_key_exists( 'id', $sample );
		}
		$cursor   = Rest::pint( $req, 'cursor', 0 );
		$page_in  = Rest::pint( $req, 'page', 0 );
		$use_keyset = $has_id && ( $cursor > 0 || $page_in <= 0 );

		if ( $use_keyset ) {
			$where = $cursor > 0 ? $wpdb->prepare( 'WHERE id < %d', $cursor ) : ''; // newest-first, like the legacy view
			$rows  = $wpdb->get_results( $wpdb->prepare( "SELECT * FROM `$table` $where ORDER BY id DESC LIMIT %d", $per ), ARRAY_A ) ?: [];
			$next  = count( $rows ) >= $per ? (int) end( $rows )['id'] : null;
			$page  = 0; // keyset has no absolute page number
		} else {
			$page   = max( 1, $page_in ?: 1 );
			$offset = min( self::DB_MAX_SKIP, ( $page - 1 ) * $per );
			$rows   = $wpdb->get_results( $wpdb->prepare( "SELECT * FROM `$table` ORDER BY 1 DESC LIMIT %d OFFSET %d", $per, $offset ), ARRAY_A ) ?: [];
			$next   = ( $has_id && $rows ) ? (int) end( $rows )['id'] : null;
		}
		$cols = $rows ? array_keys( $rows[0] ) : [];
		// Mask credential-bearing cells: the named ones (session tokens, sign-in codes, password-reset
		// keys, publication confirm verifier, API token hash) plus anything whose key or value is
		// credential-SHAPED, whoever wrote it — default-deny, see redact_row.
		$rows = array_map( fn( $r ) => self::redact_row( $table, $r ), $rows );
		// Data-dictionary annotations so the explorer is self-describing for research: a one-line table
		// blurb + the plain-language meaning of each documented column (see Schema::dictionary).
		$key  = preg_replace( '/^' . preg_quote( $wpdb->prefix, '/' ) . '/', '', $table );
		$d    = Schema::dictionary()[ $key ] ?? [ 'desc' => '', 'cols' => [] ];
		return [ 'table' => $table, 'label' => self::humanize( $table ), 'columns' => $cols, 'rows' => $rows,
			'desc' => $d['desc'] ?? '', 'col_desc' => $d['cols'] ?? [],
			'total' => $total, 'page' => $page, 'pages' => (int) ceil( $total / max( 1, $per ) ), 'per' => $per,
			'cursor' => $cursor, 'next' => $next, 'keyset' => $use_keyset ];
	}

	/**
	 * GET /schema — the machine-readable DATA DICTIONARY for the entire public database. Pairs every
	 * live table with its plain-language purpose, its documented columns' meanings, and an approximate
	 * row count, so a researcher can understand /data without reading the source. Public + cacheable.
	 */
	public static function schema( $req ) {
		$dict   = Schema::dictionary();
		$approx = self::approx_rows_map();
		$out    = [];
		foreach ( self::all_table_names() as $name ) {
			$key = preg_replace( '/^' . preg_quote( $GLOBALS['wpdb']->prefix, '/' ) . '/', '', $name );
			$d   = $dict[ $key ] ?? [ 'desc' => '', 'cols' => [] ];
			$out[] = [
				'table'   => $name,
				'label'   => self::humanize( $name ),
				'desc'    => $d['desc'] ?? '',
				'columns' => $d['cols'] ?? [],
				'rows'    => isset( $approx[ $name ] ) && $approx[ $name ] ? (int) $approx[ $name ] : self::approx_rows( $name ),
			];
		}
		return [
			'tables' => $out,
			'note'   => 'ArtaQuest publishes its entire database. This dictionary documents every table and its key columns. Money and points are append-only ledgers (a balance is SUM(delta)); tables marked PROJECTION are derived caches kept in lockstep and rebuildable from the source tables. See /data to browse the rows, and /aq/v1/db?table=NAME for any single table.',
		];
	}

	/** Fast approximate row count for one table from the engine's own statistics (no table scan):
	 *  information_schema.TABLES.TABLE_ROWS on MySQL; an exact COUNT on the SQLite dev integration
	 *  (where there is no such view, and the tables are tiny anyway). */
	public static function approx_rows( $table ) {
		global $wpdb;
		$prev = $wpdb->suppress_errors( true );
		$n = $wpdb->get_var( $wpdb->prepare( "SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s", $table ) );
		$wpdb->suppress_errors( $prev );
		// A non-zero estimate means a populated table → trust it (no scan). A 0 (truly empty, stats-cold,
		// or the SQLite emulation which always reports 0) → an exact COUNT, cheap because it's small/empty.
		if ( $n !== null && (int) $n > 0 ) { return (int) $n; }
		return (int) $wpdb->get_var( "SELECT COUNT(*) FROM `$table`" );
	}

	/** All tables' approximate row counts in ONE information_schema read (MySQL); null OR an all-zero
	 *  map on the SQLite dev integration (it emulates information_schema but never fills TABLE_ROWS),
	 *  so either way the caller falls back to per-table COUNT — dev tables are small.
	 *  PUBLIC because /offline/manifest needs the identical list: it previously ran its own COUNT(*)
	 *  per table, which is the one thing this method exists to avoid. */
	public static function approx_rows_map() {
		global $wpdb;
		$prev = $wpdb->suppress_errors( true );
		$rows = $wpdb->get_results( "SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()", ARRAY_A );
		$ok   = ( $wpdb->last_error === '' && is_array( $rows ) && $rows );
		$wpdb->suppress_errors( $prev );
		if ( ! $ok ) { return null; }
		$map = [];
		foreach ( $rows as $r ) { $map[ (string) $r['TABLE_NAME'] ] = (int) $r['TABLE_ROWS']; }
		return $map;
	}

	// ── Arta Coin world price map ───────────────────────────────────────────
	const FX = [ // currency per 1 CAD (approx); used to localise the coin price
		[ 'code' => 'us', 'iso3' => 'USA', 'name' => 'United States', 'cur' => 'USD', 'rate' => 0.73 ],
		[ 'code' => 'gb', 'iso3' => 'GBR', 'name' => 'United Kingdom', 'cur' => 'GBP', 'rate' => 0.58 ],
		[ 'code' => 'eu', 'iso3' => 'EUR', 'name' => 'Eurozone', 'cur' => 'EUR', 'rate' => 0.68 ],
		[ 'code' => 'in', 'iso3' => 'IND', 'name' => 'India', 'cur' => 'INR', 'rate' => 61.0 ],
		[ 'code' => 'ng', 'iso3' => 'NGA', 'name' => 'Nigeria', 'cur' => 'NGN', 'rate' => 1100.0 ],
		[ 'code' => 'br', 'iso3' => 'BRA', 'name' => 'Brazil', 'cur' => 'BRL', 'rate' => 4.0 ],
		[ 'code' => 'ca', 'iso3' => 'CAN', 'name' => 'Canada', 'cur' => 'CAD', 'rate' => 1.0 ],
	];

	public static function coin_world( $req ) {
		$p    = Economy::coin_price();   // CAD per coin (buy/sell/spot)
		$oz   = Economy::gold_oz_usd(); // the SAME spot coin_price() just derived from — /pricing read
		                                // aq_gold_rate_history here (no writer, always empty), so it
		                                // rendered "Gold spot (USD/oz) $0" while /reserve showed 4,056.9
		$countries = array_map( fn( $c ) => [
			'code' => $c['code'], 'iso3' => $c['iso3'], 'name' => $c['name'], 'currency' => $c['cur'],
			'buy' => round( $p['buy'] * $c['rate'], 4 ), 'sell' => round( $p['sell'] * $c['rate'], 4 ),
		], self::FX );
		return [
			'symbol' => '₳', 'peg' => '1 ₳ = 1 mg gold', 'gold_oz_usd' => $oz, 'spot_usd' => round( $p['spot'] * 0.73, 4 ),
			'base_fiat' => 'CAD', 'buy_base' => $p['buy'], 'sell_base' => $p['sell'], 'spread' => $p['spread'], 'countries' => $countries,
		];
	}

	// ── Price-of-energy rail (operator 2026-07-16, replaces the Science News rail) ──────────
	// THE FIVE FUELS: the five energy sources the world consumes MOST that also trade on a
	// global market with a long reliable record — machine fuels and human fuels on one ladder,
	// RANKED by worldwide consumption (≈EJ/yr, EI Statistical Review + FAO/USDA, mid-2020s).
	// ONE source for every series INCLUDING the gold denominator: the World Bank's Commodity
	// Markets "Pink Sheet" (CMO-Historical-Data-Monthly.xlsx) — MONTHLY nominal USD (operator
	// 2026-07-16: monthly dataset), records reaching 1960 but every served series CLIPPED to
	// the LATEST first-month across the six (Japan LNG, 1977-01) so all charts align and share
	// one starting point (operator order). Spot-verified against history: gold 1980 spike
	// $607.83, Brent 1974 $10.97, coal 1970 $7.80/t. The client prices every row in ₳ per kWh
	// (1 ₳ = 1 mg gold; 1 kWh = 3,600 kJ exactly) and the row % is the CURRENT month-over-month
	// move. Uranium would rank #4 (~28 EJ of reactor heat) but has no open price feed
	// (UxC/Numerco paywalled) — stated in the rail footnote instead of faked. Non-tradables
	// (hydro, wind, solar, fuelwood) are out of scope by the operator's tradability rule.
	// Retired: the Yahoo-futures fetchers, the FX table, fuels 6-10 and the yearly averaging —
	// history at 4178c3b25 / d3aaf22ac if any of it is ever needed again.
	//   oil     "Crude oil, Brent"             $/bbl    · 1 boe = 6.1178632 GJ
	//   coal    "Coal, Australian" (Newcastle) $/mt     · 6,000 kcal/kg NAR = 25.12 GJ/t
	//   gas     "Liquefied natural gas, Japan" $/mmbtu  · 1 MMBtu = 1.05505585 GJ
	//   maize   "Maize"                        $/mt     · ÷1000 → USD/kg · ~15.3 MJ/kg
	//   wheat   "Wheat, US HRW"                $/mt     · ÷1000 → USD/kg · ~14.2 MJ/kg
	//   gold    "Gold"                         $/ozt    · the ₳ denominator (1 ₳ = 1 mg)

	const MARKET_TTL      = 21600;   // 6h payload cache — the source is monthly, this is generous
	const MARKET_SRC_TTL  = 172800;  // 2 days — refetch the workbook at most this often
	const MARKET_SRC_MAX  = 5184000; // 60 days — last-good older than this is dropped, never served
	const MARKET_GOLD_COL = 'Gold';
	const MARKET_ITEMS = [
		[ 'key' => 'oil',   'label' => 'Oil',   'col' => 'Crude oil, Brent',             'div' => 1,    'unit' => 'bbl',   'kj' => 6117863.2,  'ej' => 195 ],
		[ 'key' => 'coal',  'label' => 'Coal',  'col' => 'Coal, Australian',             'div' => 1,    'unit' => 't',     'kj' => 25120800.0, 'ej' => 165 ],
		[ 'key' => 'gas',   'label' => 'Gas',   'col' => 'Liquefied natural gas, Japan', 'div' => 1,    'unit' => 'MMBtu', 'kj' => 1055055.85, 'ej' => 145 ],
		[ 'key' => 'maize', 'label' => 'Maize', 'col' => 'Maize',                        'div' => 1000, 'unit' => 'kg',    'kj' => 15300.0,    'ej' => 18 ],
		[ 'key' => 'wheat', 'label' => 'Wheat', 'col' => 'Wheat, US HRW',                'div' => 1000, 'unit' => 'kg',    'kj' => 14200.0,    'ej' => 11 ],
	];

	/** GET /market/prices — { updated, items: [{key,label,unit,kj,ej,series:[[YYYY-MM,usd]…]}], gold }. */
	public static function market_prices() {
		$cached = get_transient( 'aq_market_v4' ); // v4: MONTHLY series, all clipped to one shared start
		if ( is_array( $cached ) ) { return $cached; }

		$src = get_option( 'aq_market_src', [] );
		if ( ! is_array( $src ) ) { $src = []; }

		// One workbook fetch refreshes EVERY series including gold — at most every
		// MARKET_SRC_TTL, under a stampede lock (the transient + CDN absorb read traffic).
		$oldest = PHP_INT_MAX;
		foreach ( array_merge( array_column( self::MARKET_ITEMS, 'key' ), [ 'gold' ] ) as $k ) {
			$oldest = min( $oldest, (int) ( $src[ $k ]['ts'] ?? 0 ) );
		}
		if ( time() - $oldest > self::MARKET_SRC_TTL && ! get_transient( 'aq_market_lock' ) ) {
			set_transient( 'aq_market_lock', 1, 90 );
			$cols = array_column( self::MARKET_ITEMS, 'col', 'key' );
			$cols['gold'] = self::MARKET_GOLD_COL;
			foreach ( self::market_fetch_cmo( $cols ) as $k => $series ) {
				$src[ $k ] = [ 'ts' => time(), 'series' => $series ];
			}
			update_option( 'aq_market_src', $src, false );
			delete_transient( 'aq_market_lock' );
		}

		// The shared starting point (operator 2026-07-16: all charts aligned, same start):
		// the LATEST first-month across every FRESH series including gold — Japan LNG's
		// 1977-01 in practice. Every served series clips to it, so the five lines cover the
		// exact same months and the sparklines align bar-for-bar.
		$fresh = static function ( $row ) {
			return is_array( $row['series'] ?? null ) && $row['series'] && ( time() - (int) ( $row['ts'] ?? 0 ) ) <= self::MARKET_SRC_MAX;
		};
		$start = '';
		foreach ( array_merge( array_column( self::MARKET_ITEMS, 'key' ), [ 'gold' ] ) as $k ) {
			$row = $src[ $k ] ?? null;
			if ( $fresh( $row ) && (string) $row['series'][0][0] > $start ) { $start = (string) $row['series'][0][0]; }
		}
		$clip = static function ( $series ) use ( $start ) {
			return array_values( array_filter( $series, static function ( $p ) use ( $start ) { return (string) $p[0] >= $start; } ) );
		};

		$items = [];
		foreach ( self::MARKET_ITEMS as $item ) {
			$row = $src[ $item['key'] ] ?? null;
			if ( ! $fresh( $row ) ) { continue; }
			$series = [];
			foreach ( $clip( $row['series'] ) as $pt ) {
				$series[] = [ $pt[0], round( $pt[1] / $item['div'], 6 ) ];
			}
			$items[] = [ 'key' => $item['key'], 'label' => $item['label'], 'unit' => $item['unit'], 'kj' => $item['kj'], 'ej' => $item['ej'], 'series' => $series ];
		}
		$gold    = $src['gold'] ?? null;
		$gold_ok = $fresh( $gold );
		$out = [
			'updated' => time(),
			'items'   => $items,
			'gold'    => $gold_ok ? $clip( $gold['series'] ) : [], // USD/ozt monthly, same grid — the ₳ denominator
		];
		set_transient( 'aq_market_v4', $out, ( $items && $gold_ok ) ? self::MARKET_TTL : 300 );
		return $out;
	}

	// ── DAILY commodity prices in ArtaCoin (operator 2026-07-24: "the daily prices of the top5
	// energy (oil, gas, coal, wheat, maize) in artacoin in the last 56 days"). Distinct from the
	// MONTHLY /market/prices above (World Bank, relay-facing). Source: Yahoo Finance's keyless daily
	// chart API (verified reachable from prod egress). Each day's price is converted to ArtaCoin —
	// 1 ₳ = 1 mg of gold — using THAT DAY's gold, so the series shows real-terms movement against
	// the coin's gold peg: ₳ = USD × 31103.477 ÷ gold_USD_per_oz. Grains (wheat, maize) quote in US
	// cents (USX) and Yahoo tags meta.currency='USX' → ÷100 to USD, handled in yahoo_series. Coal
	// has NO free daily COMMODITY price anywhere (only stock proxies), so it is Peabody Energy (BTU),
	// HONESTLY labelled a coal-sector proxy. A daily cron (aq_commodities) builds + stores; GET
	// /commodities serves the stored payload (last-good ≤ 7 days).
	// STANDARDIZED UNITS (operator 2026-07-25: "units have to be standardized and per kJ", then
	// "make our standard unit of energy kWh"): every fuel is expressed on ONE axis, ₳ per kWh of
	// energy content (1 kWh = 3,600 kJ exactly), using the ENERGY DATASET's own factors (MARKET_ITEMS above:
	// oil 6,117,863.2 kJ/bbl · gas 1,055,055.85 kJ/MMBtu · coal 25,120,800 kJ/t · wheat 14,200
	// kJ/kg · maize 15,300 kJ/kg; bushels: wheat 60 lb = 27.21554 kg, maize 56 lb = 25.40117 kg).
	// The Peabody stock proxy is GONE — a share has no energy content, so per-kJ coal uses the
	// energy dataset's real World Bank "Coal, Australian" price (monthly — no daily coal commodity
	// market exists anywhere); its USD holds within the month while the ₳ line still moves DAILY
	// through each day's gold.
	const COMMODITY_DAYS  = 56;
	const COMMODITY_MG_OZ = 31103.477; // mg per troy ounce — the coin peg (1 ₳ = 1 mg of gold)
	const KJ_PER_KWH      = 3600.0;    // THE PLATFORM'S STANDARD ENERGY UNIT is the kWh (operator
	                                   // 2026-07-25) — exact by definition, and the unit every
	                                   // reader already meets on an electricity bill.
	// GLOBALLY TRADED BENCHMARKS ONLY (operator 2026-07-25: "each must be a tradable globally price,
	// for example for gas in the LNG form … the average price if its traded from a global market to
	// any country"). This is why every row now prices off the World Bank Pink Sheet rather than a
	// futures screen: WTI and Henry Hub are US DOMESTIC prices — landlocked pipeline gas cannot be
	// shipped to another country, so its price says nothing about what the world pays for energy.
	// The internationally traded forms are Brent (seaborne crude), LNG (the only globally shippable
	// gas), and Newcastle coal (the seaborne benchmark). All five are CIF/FOB benchmarks actually
	// used to settle cross-border cargoes, so ₳/kWh is comparable between them and answers the
	// operator's question: what does a kilowatt-hour of this cost, bought on the world market.
	// Trade-off accepted deliberately: the Pink Sheet is MONTHLY, so the daily movement in each line
	// is the gold denominator repricing the coin — the fuel's own USD level steps once a month.
	const COMMODITIES = [
		[ 'key' => 'oil',   'label' => 'Crude oil',   'sym' => '', 'kj' => 6117863.2,  'unit' => 'per kWh · Brent, seaborne' ],
		[ 'key' => 'gas',   'label' => 'LNG',         'sym' => '', 'kj' => 1055055.85, 'unit' => 'per kWh · LNG, delivered Japan' ],
		[ 'key' => 'coal',  'label' => 'Coal',        'sym' => '', 'kj' => 25120800.0, 'unit' => 'per kWh · Newcastle, seaborne' ],
		[ 'key' => 'wheat', 'label' => 'Wheat',       'sym' => '', 'kj' => 14200.0,    'unit' => 'per kWh · US HRW, export' ],
		[ 'key' => 'maize', 'label' => 'Corn',        'sym' => '', 'kj' => 15300.0,    'unit' => 'per kWh · export benchmark' ],
	];

	/** GET /commodities — { updated, days, items:[{key,label,unit,acoin,pct,series:[₳/day],dates}] }. */
	public static function commodities( $req = null ) {
		$cached = get_transient( 'aq_commodities_v1' );
		if ( is_array( $cached ) ) { return $cached; }

		$src   = get_option( 'aq_commodities_src', [] );
		if ( ! is_array( $src ) ) { $src = []; }
		$fresh = is_array( $src['items'] ?? null ) && $src['items'] && ( time() - (int) ( $src['ts'] ?? 0 ) ) <= WEEK_IN_SECONDS;

		// The daily cron owns the build — it does 6 sequential Yahoo fetches (~up to 90s), which is
		// fine under a CLI cron limit but would blow the ~60s web request cap. So a cold cache does
		// NOT build inline: it kicks a one-off cron run (off the request path, under Cron::guard) and
		// serves last-good (empty until the cron fills it), throttled so a burst schedules once.
		if ( ! $fresh && ! get_transient( 'aq_commodities_lock' ) ) {
			set_transient( 'aq_commodities_lock', 1, 300 );
			wp_schedule_single_event( time() + 1, 'aq_commodities' );
		}

		// `days` is the CALENDAR window; `points` is how many TRADING days actually fell inside it
		// (markets close weekends/holidays) — the card says "N trading days" so the count it shows
		// is the count it has, never an implied 56 daily observations.
		$items  = $fresh ? array_values( $src['items'] ) : [];
		$points = 0;
		foreach ( $items as $i ) { $points = max( $points, count( (array) ( $i['series'] ?? [] ) ) ); }
		$out = [ 'updated' => (int) ( $src['ts'] ?? time() ), 'days' => self::COMMODITY_DAYS, 'points' => $points, 'items' => $items ];
		set_transient( 'aq_commodities_v1', $out, $fresh ? 6 * HOUR_IN_SECONDS : 600 );
		return $out;
	}

	/** Daily cron body (aq_commodities, via Cron::guard): build + store the ₳ price series. */
	public static function commodities_tick() {
		$items = self::commodities_build();
		self::src_health( 'commodities', (bool) $items, 0, count( (array) $items ) );
		if ( $items ) { update_option( 'aq_commodities_src', [ 'ts' => time(), 'items' => $items ], false ); delete_transient( 'aq_commodities_v1' ); }
	}

	/** Fetch gold + each commodity's daily USD series, normalise every price to USD per 1,000 kJ
	 *  of energy content (the STANDARDIZED unit — factors from the energy dataset), then convert
	 *  each day to ArtaCoin via that day's gold. [] if gold is unavailable (the whole card needs
	 *  the denominator); a single commodity's failure just drops that row. */
	private static function commodities_build() {
		$gold = self::yahoo_series( 'GC=F' ); // 'YYYY-MM-DD' => USD/oz
		if ( count( $gold ) < 2 ) { return []; }
		$cut   = gmdate( 'Y-m-d', time() - self::COMMODITY_DAYS * DAY_IN_SECONDS );
		$today = gmdate( 'Y-m-d' ); // skip the partial in-session bar: a cron mid-session would
		                            // otherwise publish a live intraday quote as a daily close
		$out   = [];
		foreach ( self::COMMODITIES as $c ) {
			$monthly = false;
			$note    = '';
			if ( '' !== $c['sym'] ) {
				// ROLL-FREE PRICING: Yahoo's "X=F" is a SPLICED front-month — at each expiry the next
				// contract's price is grafted on with no adjustment, injecting a phantom step (audit
				// measured oil at +6.6% spliced vs +13.8% on one contract, and a +5% maize step queued).
				// So resolve the front contract's own dated ticker and price the WHOLE window from it.
				$dated = self::yahoo_front_contract( $c['sym'] );
				$ser   = $dated ? self::yahoo_series( $dated ) : [];
				if ( count( $ser ) < 2 ) { $ser = self::yahoo_series( $c['sym'] ); $dated = ''; } // fail-soft
				$note  = $dated ? $dated : 'front-month (spliced)';
			} else {
				// Coal: the energy dataset's WB MONTHLY series mapped month-by-month onto gold's daily
				// grid — so the line carries real coal moves where the window spans >1 month, instead
				// of a single latest value (which made the whole curve the inverse of gold).
				$months  = self::market_month_map( $c['key'] );
				$ser     = [];
				foreach ( $gold as $date => $g ) {
					$m = self::nearest_prior( $months, substr( $date, 0, 7 ) );
					if ( $m ) { $ser[ $date ] = $m; }
				}
				$monthly = true;
				$note    = 'World Bank monthly';
			}
			if ( count( $ser ) < 2 ) { continue; }
			$series  = [];
			$dates   = [];
			$usd_leg = [];
			$raw     = []; // unrounded, so the % change isn't computed from display-rounded values
			foreach ( $ser as $date => $usd ) {
				if ( $date < $cut || $date >= $today ) { continue; }
				$g = $gold[ $date ] ?? self::nearest_prior( $gold, $date ); // carry nearest prior gold over a holiday gap
				if ( ! $g ) { continue; }
				$per_block = $usd / $c['kj'] * self::KJ_PER_KWH;        // USD per kWh — ONE axis for every fuel
				$acoin     = $per_block * self::COMMODITY_MG_OZ / $g;   // → ₳ per kWh (that day's gold)
				$raw[]     = $acoin;
				$series[]  = round( $acoin, 4 );
				$usd_leg[] = round( $per_block, 6 ); // the commodity's OWN move, gold removed — what a
				                                     // price-jump detector must test (see News::detect_price)
				$dates[]   = $date;
			}
			if ( count( $series ) < 2 ) { continue; }
			$first = $raw[0];
			$last  = $raw[ count( $raw ) - 1 ];
			// A held-flat monthly row whose window spans ONE month has a pct that is purely the
			// gold denominator moving — never publish that as if it were a commodity price move.
			$one_month = $monthly && count( array_unique( array_map( static fn( $v ) => round( $v, 10 ), $ser ) ) ) < 2;
			$out[] = [
				'key'     => $c['key'],
				'label'   => $c['label'],
				'unit'    => $c['unit'],
				'acoin'   => round( $last, 4 ),
				'pct'     => ( ! $one_month && $first > 0 ) ? round( ( $last - $first ) / $first * 100, 1 ) : null,
				'monthly' => $monthly,
				'note'    => $note, // the exact contract/source priced — shown on the card
				'series'  => $series,
				'usd'     => $usd_leg, // USD per kWh — the gold-free leg
				'dates'   => $dates,
			];
		}
		return $out;
	}

	/** "CL=F" → "CLU26.NYM": the front contract's OWN dated ticker, read from Yahoo's meta
	 *  (shortName carries the delivery month, e.g. "Crude Oil Sep 26"). '' when unresolvable. */
	private static function yahoo_front_contract( $sym ) {
		$root = strtok( $sym, '=' );
		$exch = [ 'CL' => '.NYM', 'NG' => '.NYM', 'ZW' => '.CBT', 'ZC' => '.CBT' ];
		if ( ! isset( $exch[ $root ] ) ) { return ''; }
		$body = self::mkt_get_json( 'https://query1.finance.yahoo.com/v8/finance/chart/' . rawurlencode( $sym ) . '?range=1d&interval=1d', 12 );
		$name = (string) ( $body['chart']['result'][0]['meta']['shortName'] ?? '' );
		if ( ! preg_match( '/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i', $name, $m ) ) { return ''; }
		$months = [ 'jan' => 1, 'feb' => 2, 'mar' => 3, 'apr' => 4, 'may' => 5, 'jun' => 6,
			'jul' => 7, 'aug' => 8, 'sep' => 9, 'oct' => 10, 'nov' => 11, 'dec' => 12 ];
		$codes  = [ 1 => 'F', 2 => 'G', 3 => 'H', 4 => 'J', 5 => 'K', 6 => 'M',
			7 => 'N', 8 => 'Q', 9 => 'U', 10 => 'V', 11 => 'X', 12 => 'Z' ];
		$mon = $months[ strtolower( $m[1] ) ] ?? 0;
		if ( ! $mon ) { return ''; }
		// Yahoo TRUNCATES shortName at 30 chars, so the year is often cut ("…Futures,Sep-2").
		// Never parse a partial year — the front contract is always the NEXT occurrence of that
		// delivery month, so derive the year from today instead (correct across a year boundary).
		$now_y = (int) gmdate( 'Y' );
		$now_m = (int) gmdate( 'n' );
		$year  = ( $mon >= $now_m ) ? $now_y : $now_y + 1;
		return $root . $codes[ $mon ] . substr( (string) $year, -2 ) . $exch[ $root ];
	}

	/** The energy dataset's monthly USD series for one MARKET_ITEMS key as [ 'YYYY-MM' => usd ]
	 *  (div applied) from the stored aq_market_src workbook — [] when absent/stale. */
	/**
	 * The RAW monthly benchmark series for one commodity — the source's TRUE sampling cadence.
	 * The card maps these onto a daily grid for display, which means ~37 of every 38 daily returns
	 * are carried-forward zeros. Anything computing STATISTICS (volatility, z-scores) must read this
	 * instead, or it measures the shape of the display grid rather than the market.
	 */
	public static function commodity_monthly( $key ) { return self::market_month_map( $key ); }

	private static function market_month_map( $key ) {
		$src = get_option( 'aq_market_src', [] );
		$row = is_array( $src[ $key ] ?? null ) ? $src[ $key ] : null;
		if ( ! is_array( $row['series'] ?? null ) || ! $row['series'] ) { return []; }
		if ( time() - (int) ( $row['ts'] ?? 0 ) > self::MARKET_SRC_MAX ) { return []; }
		$div = 1.0;
		foreach ( self::MARKET_ITEMS as $it ) { if ( $it['key'] === $key ) { $div = (float) $it['div']; break; } }
		$out = [];
		foreach ( $row['series'] as $pt ) {
			if ( is_array( $pt ) && isset( $pt[0], $pt[1] ) ) { $out[ (string) $pt[0] ] = (float) $pt[1] / max( 1.0, $div ); }
		}
		return $out;
	}

	/** Yahoo daily chart → [ 'YYYY-MM-DD' => close_in_USD ]; null closes skipped; USX (US cents) ÷100. */
	private static function yahoo_series( $sym ) {
		$body = self::mkt_get_json( 'https://query1.finance.yahoo.com/v8/finance/chart/' . rawurlencode( $sym ) . '?range=3mo&interval=1d', 15 );
		$r    = $body['chart']['result'][0] ?? null;
		if ( ! is_array( $r ) ) { return []; }
		$ts  = (array) ( $r['timestamp'] ?? [] );
		$cl  = (array) ( $r['indicators']['quote'][0]['close'] ?? [] );
		$div = ( 'USX' === (string) ( $r['meta']['currency'] ?? '' ) ) ? 100.0 : 1.0; // US cents → USD
		$out = [];
		foreach ( $ts as $i => $t ) {
			$v = $cl[ $i ] ?? null;
			if ( null === $v ) { continue; }
			$out[ gmdate( 'Y-m-d', (int) $t ) ] = (float) $v / $div;
		}
		return $out;
	}

	/** The value at or before $date in a 'YYYY-MM-DD'=>value map (holiday-gap carry). */
	private static function nearest_prior( $map, $date ) {
		$best = null;
		$bd   = '';
		foreach ( $map as $d => $v ) {
			if ( $d <= $date && $d > $bd ) { $bd = $d; $best = $v; }
		}
		return $best;
	}

	/**
	 * ONE bounded World Bank CMO "Pink Sheet" fetch → every requested column's monthly series.
	 * Resolves the current workbook URL from the CMO landing page (the doc hash rotates per
	 * release), pulls the ~600 KB xlsx and reads the Monthly Prices sheet with ZipArchive +
	 * regex — no spreadsheet library. $cols = [ key => header prefix ]; returns
	 * [ key => [[YYYY-MM, usd]…] ] oldest-first, empty cells skipped, so each series simply
	 * starts where its record starts (Brent/maize/wheat/gold 1960-01, coal 1970-01, LNG
	 * 1977-01). Missing keys on failure — those rows then serve last-good.
	 */
	private static function market_fetch_cmo( $cols ) {
		if ( ! class_exists( '\\ZipArchive' ) ) { return []; }
		$page = wp_remote_get( 'https://www.worldbank.org/en/research/commodity-markets', [ 'timeout' => 8, 'redirection' => 3, 'user-agent' => 'Mozilla/5.0 (X11; Linux x86_64) ArtaQuest/1.0' ] );
		if ( is_wp_error( $page ) || ! preg_match( '#https://thedocs\.worldbank\.org/[^"\'\s]*CMO-Historical-Data-Monthly\.xlsx#', (string) wp_remote_retrieve_body( $page ), $m ) ) { return []; }
		$res = wp_remote_get( $m[0], [ 'timeout' => 20, 'redirection' => 3 ] );
		if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) { return []; }
		// tempnam, NOT wp_tempnam — the latter lives in wp-admin/includes/file.php and is undefined
		// on frontend REST requests (it 500'd this whole GET once — never reintroduce it here).
		$tmp = tempnam( get_temp_dir(), 'aq-cmo' );
		if ( ! $tmp || false === file_put_contents( $tmp, wp_remote_retrieve_body( $res ) ) ) { return []; }
		$out = [];
		$zip = new \ZipArchive();
		if ( true === $zip->open( $tmp ) ) {
			$strings = [];
			if ( preg_match_all( '#<t[^>]*>([^<]*)</t>#', (string) $zip->getFromName( 'xl/sharedStrings.xml' ), $sm ) ) { $strings = $sm[1]; }
			$cells = static function ( $row_xml ) use ( $strings ) {
				$c = [];
				if ( preg_match_all( '#<c r="([A-Z]+)\d+"(?:[^>]*t="(\w+)")?[^>]*>(?:<v>([^<]*)</v>)?#', $row_xml, $cm, PREG_SET_ORDER ) ) {
					foreach ( $cm as $x ) {
						if ( ! isset( $x[3] ) || '' === $x[3] ) { continue; }
						$c[ $x[1] ] = ( 's' === ( $x[2] ?? '' ) ) ? (string) ( $strings[ (int) $x[3] ] ?? '' ) : $x[3];
					}
				}
				return $c;
			};
			for ( $i = 1; $i <= 6 && ! $out; $i++ ) { // the Monthly Prices sheet moved once already — scan, don't assume
				$xml = (string) $zip->getFromName( "xl/worksheets/sheet{$i}.xml" );
				if ( '' === $xml || ! preg_match_all( '#<row[^>]*>(.*?)</row>#s', $xml, $rm ) ) { continue; }
				$letters = []; // series key → column letter, resolved from the sheet's header rows
				foreach ( array_slice( $rm[1], 0, 8 ) as $row_xml ) {
					foreach ( $cells( $row_xml ) as $letter => $val ) {
						foreach ( $cols as $k => $prefix ) {
							if ( ! isset( $letters[ $k ] ) && 0 === strpos( (string) $val, (string) $prefix ) ) { $letters[ $k ] = $letter; }
						}
					}
					if ( count( $letters ) === count( $cols ) ) { break; }
				}
				if ( ! $letters ) { continue; }
				foreach ( $rm[1] as $row_xml ) {
					$c = $cells( $row_xml );
					if ( ! preg_match( '/^(\d{4})M(\d{2})$/', (string) ( $c['A'] ?? '' ), $dm ) ) { continue; }
					foreach ( $letters as $k => $letter ) {
						if ( is_numeric( $c[ $letter ] ?? '' ) && (float) $c[ $letter ] > 0 ) {
							$out[ $k ][] = [ $dm[1] . '-' . $dm[2], (float) $c[ $letter ] ];
						}
					}
				}
			}
			$zip->close();
		}
		@unlink( $tmp );
		foreach ( $out as $k => $series ) {
			if ( count( $series ) < 24 ) { unset( $out[ $k ] ); } // a stub is a failed parse, not data
		}
		return $out;
	}

	// ISO 3166 country → ISO 4217 currency (compact; the euro area collapsed). Countries whose
	// everyday retail runs on USD map to USD. Missing/unknown ⇒ USD client-side.
	const CC_CUR = [
		'US' => 'USD', 'CA' => 'CAD', 'GB' => 'GBP', 'AU' => 'AUD', 'NZ' => 'NZD', 'JP' => 'JPY', 'CN' => 'CNY',
		'IN' => 'INR', 'PK' => 'PKR', 'BD' => 'BDT', 'LK' => 'LKR', 'NP' => 'NPR', 'BT' => 'BTN', 'MV' => 'MVR',
		'IR' => 'IRR', 'IQ' => 'IQD', 'TR' => 'TRY', 'SA' => 'SAR', 'AE' => 'AED', 'QA' => 'QAR', 'KW' => 'KWD',
		'BH' => 'BHD', 'OM' => 'OMR', 'YE' => 'YER', 'JO' => 'JOD', 'LB' => 'LBP', 'SY' => 'SYP', 'IL' => 'ILS',
		'PS' => 'ILS', 'EG' => 'EGP', 'LY' => 'LYD', 'TN' => 'TND', 'DZ' => 'DZD', 'MA' => 'MAD', 'SD' => 'SDG',
		'RU' => 'RUB', 'UA' => 'UAH', 'BY' => 'BYN', 'KZ' => 'KZT', 'UZ' => 'UZS', 'TM' => 'TMT', 'KG' => 'KGS',
		'TJ' => 'TJS', 'AF' => 'AFN', 'AM' => 'AMD', 'AZ' => 'AZN', 'GE' => 'GEL', 'MD' => 'MDL', 'RS' => 'RSD',
		'BA' => 'BAM', 'MK' => 'MKD', 'AL' => 'ALL', 'BG' => 'BGN', 'RO' => 'RON', 'HU' => 'HUF', 'CZ' => 'CZK',
		'PL' => 'PLN', 'SE' => 'SEK', 'NO' => 'NOK', 'DK' => 'DKK', 'IS' => 'ISK', 'CH' => 'CHF', 'LI' => 'CHF',
		'MX' => 'MXN', 'BR' => 'BRL', 'AR' => 'ARS', 'CL' => 'CLP', 'CO' => 'COP', 'PE' => 'PEN', 'VE' => 'VES',
		'BO' => 'BOB', 'PY' => 'PYG', 'UY' => 'UYU', 'GT' => 'GTQ', 'HN' => 'HNL', 'NI' => 'NIO', 'CR' => 'CRC',
		'DO' => 'DOP', 'HT' => 'HTG', 'JM' => 'JMD', 'TT' => 'TTD', 'CU' => 'CUP', 'BS' => 'BSD', 'BB' => 'BBD',
		'GY' => 'GYD', 'SR' => 'SRD', 'BZ' => 'BZD', 'NG' => 'NGN', 'GH' => 'GHS', 'KE' => 'KES', 'TZ' => 'TZS',
		'UG' => 'UGX', 'ET' => 'ETB', 'ZA' => 'ZAR', 'NA' => 'NAD', 'BW' => 'BWP', 'ZM' => 'ZMW', 'MW' => 'MWK',
		'MZ' => 'MZN', 'ZW' => 'USD', 'AO' => 'AOA', 'CD' => 'CDF', 'CG' => 'XAF', 'CM' => 'XAF', 'GA' => 'XAF',
		'TD' => 'XAF', 'CF' => 'XAF', 'GQ' => 'XAF', 'SN' => 'XOF', 'CI' => 'XOF', 'ML' => 'XOF', 'BF' => 'XOF',
		'NE' => 'XOF', 'TG' => 'XOF', 'BJ' => 'XOF', 'GW' => 'XOF', 'GN' => 'GNF', 'SL' => 'SLE', 'LR' => 'LRD',
		'GM' => 'GMD', 'MR' => 'MRU', 'RW' => 'RWF', 'BI' => 'BIF', 'SO' => 'SOS', 'DJ' => 'DJF', 'ER' => 'ERN',
		'SS' => 'SSP', 'MG' => 'MGA', 'MU' => 'MUR', 'SC' => 'SCR', 'KM' => 'KMF', 'LS' => 'LSL', 'SZ' => 'SZL',
		'CV' => 'CVE', 'ST' => 'STN', 'TH' => 'THB', 'VN' => 'VND', 'KH' => 'KHR', 'LA' => 'LAK', 'MM' => 'MMK',
		'MY' => 'MYR', 'SG' => 'SGD', 'ID' => 'IDR', 'PH' => 'PHP', 'BN' => 'BND', 'TL' => 'USD', 'KR' => 'KRW',
		'KP' => 'KPW', 'TW' => 'TWD', 'HK' => 'HKD', 'MO' => 'MOP', 'MN' => 'MNT', 'FJ' => 'FJD', 'PG' => 'PGK',
		'SB' => 'SBD', 'VU' => 'VUV', 'WS' => 'WST', 'TO' => 'TOP', 'FM' => 'USD', 'MH' => 'USD', 'PW' => 'USD',
		'EC' => 'USD', 'SV' => 'USD', 'PA' => 'USD', 'PR' => 'USD',
		// euro area (incl. micro-states + aligned territories)
		'AT' => 'EUR', 'BE' => 'EUR', 'CY' => 'EUR', 'DE' => 'EUR', 'EE' => 'EUR', 'ES' => 'EUR', 'FI' => 'EUR',
		'FR' => 'EUR', 'GR' => 'EUR', 'HR' => 'EUR', 'IE' => 'EUR', 'IT' => 'EUR', 'LT' => 'EUR', 'LU' => 'EUR',
		'LV' => 'EUR', 'MT' => 'EUR', 'NL' => 'EUR', 'PT' => 'EUR', 'SI' => 'EUR', 'SK' => 'EUR', 'AD' => 'EUR',
		'MC' => 'EUR', 'SM' => 'EUR', 'VA' => 'EUR', 'ME' => 'EUR', 'XK' => 'EUR',
	];

	/** GET /market/geo — the viewer's { cc, country, currency } from their IP (client cache-busts). */
	public static function market_geo() {
		$g  = Sessions::geo( (string) ( $_SERVER['REMOTE_ADDR'] ?? '' ) );
		$cc = (string) ( $g['cc'] ?? '' );
		return [
			'cc'       => $cc,
			'country'  => (string) ( $g['country'] ?? '' ),
			'currency' => self::CC_CUR[ $cc ] ?? 'USD',
		];
	}

	// ── Trending research rail (operator 2026-07-22 — REPLACES the price-of-energy card) ────
	// WHAT THE WORLD IS CITING RIGHT NOW, across EVERY field — not one archive and not one
	// discipline (operator: "all the topics, not only arXiv"). Source: OpenAlex (openalex.org),
	// the open scholarly graph — ~250M works from every publisher, repository and preprint
	// server, and the only all-field citation index with a free, unauthenticated, terms-clean
	// API. Google Scholar (the operator's ask) publishes NO API and its terms forbid scraping,
	// so OpenAlex is the substitute that actually covers the same ground, legally.
	//
	// THE RANKING (v2): CITATION VELOCITY, not raw counts. Sorting a date window by lifetime
	// cites hands the card to whatever was published on day 1 of the window (30 days of
	// accumulation vs 3) and to slow-burn review articles. Trending = cites ÷ days since
	// publication, with a SCHOLAR_RATE_FLOOR-day floor so a day-old fluke can't divide by ~0.
	// The rate is computed at ASSEMBLY time from (cites, date) — a cached pool keeps aging
	// honestly, and pools stored by the previous version rank fine without migration.
	//
	// THE POOL (v2): two bounded queries, merged — the most-cited of the last SCHOLAR_DAYS (90)
	// AND of the last SCHOLAR_DAYS_HOT (21), deduped by OpenAlex id + normalised title (the
	// preprint/publisher double). The short window catches young risers whose totals can't yet
	// crack the quarter's top 200; the long window keeps sustained hits in play.
	//
	// OPEN ACCESS, PDF REQUIRED + LIVENESS (operator: "only open source papers, pdf available"):
	// a row survives only if best_oa_location.pdf_url is a real URL, and the cron refresh then
	// HEAD-checks the top SCHOLAR_VERIFY rows in parallel, dropping hard-dead links (404/410,
	// unresolvable host). 403/405/timeouts pass — publisher CDNs bot-block HEADs that open fine
	// in a browser, and a false drop costs more than a rare slow host.
	//
	// THE JUNK GATE: is_paratext:false + type:article + has_doi:true + has_fulltext:true removes
	// the whole-JOURNAL records ("Materials Science Forum", 2,267 cites) that otherwise top any
	// citation sort; is_retracted:false keeps highly-cited retractions off the card; a
	// cited_by_count floor keeps thin-week noise out of the pool.
	//
	// OFF THE REQUEST PATH (v2): a 6-hour cron (aq_scholar_refresh → scholar_refresh_tick, under
	// Cron::guard) owns the fetch; GET only assembles from the stored pool. The inline fetch
	// survives solely as the empty-site bootstrap, under the stampede lock, without the HEAD
	// pass (the next tick verifies).
	//
	// TRENDING TOPICS are derived from the SAME pool, never a second fetch: velocity summed per
	// OpenAlex topic (~4.5k concepts, each carrying its parent field) with at least
	// SCHOLAR_MIN_PAPERS papers behind it — so a single anomalous record cannot mint a trend.
	const SCHOLAR_TTL        = 21600;  // 6h payload cache — the index moves daily at most
	const SCHOLAR_SRC_MAX    = 604800; // 7 days — last-good older than this is dropped, never served
	const SCHOLAR_DAYS       = 90;     // the long window: the quarter's sustained hits
	const SCHOLAR_DAYS_HOT   = 21;     // the medium window: young risers the long top-200 misses
	const SCHOLAR_PAPERS     = 8;      // rows in the papers card
	const SCHOLAR_TOPICS     = 8;      // rows in the topics card
	const SCHOLAR_MIN_PAPERS = 2;      // a topic needs this many papers before it counts as a trend
	const SCHOLAR_MIN_CITES  = 5;      // pool floor (API-side cited_by_count:>4)
	const SCHOLAR_RATE_FLOOR = 3;      // days — velocity smoothing so day-0 papers can't spike
	const SCHOLAR_VERIFY     = 48;     // PDF liveness HEADs per cron refresh (covers all rendered rows)

	/** GET /scholar/trending — { updated, days, papers:[…], topics:[…] } for the feed's right rail. */
	public static function scholar_trending() {
		$cached = get_transient( 'aq_scholar_v4' );
		if ( is_array( $cached ) ) { return $cached; }

		$src = get_option( 'aq_scholar_src', [] );
		if ( ! is_array( $src ) ) { $src = []; }
		// Last-good is served through an upstream outage, but never once it is stale enough to
		// misreport the window — past SCHOLAR_SRC_MAX the rail hides instead of lying.
		$fresh = is_array( $src['works'] ?? null ) && ( time() - (int) ( $src['ts'] ?? 0 ) ) <= self::SCHOLAR_SRC_MAX;

		// The cron owns refreshes; this inline fetch is the empty-site bootstrap only — once,
		// under the stampede lock, skipping the HEAD pass to keep the unlucky request bounded.
		if ( ! $fresh && ! get_transient( 'aq_scholar_lock' ) ) {
			set_transient( 'aq_scholar_lock', 1, 120 );
			$works = self::scholar_fetch_openalex( false );
			if ( $works ) {
				foreach ( $works as &$w ) { unset( $w['desc'] ); } // raw abstracts never persist (public pool) — only the cron summarises
				unset( $w );
				$src = [ 'ts' => time(), 'works' => $works ];
				update_option( 'aq_scholar_src', $src, false );
				$fresh = true;
			}
			delete_transient( 'aq_scholar_lock' );
		}

		$out = self::scholar_assemble( $fresh ? $src['works'] : [], (int) ( $src['ts'] ?? time() ) );
		set_transient( 'aq_scholar_v4', $out, $fresh ? self::SCHOLAR_TTL : 600 );
		return $out;
	}

	/** The 6-hourly cron body (aq_scholar_refresh, via Cron::guard): refresh the scholarly pool,
	 *  fold each paper's citation count into its sampling history (the measured QUARTERLY rate —
	 *  see scholar_rate), AI-summarise the top papers, store. The marketplace pass runs on its own
	 *  hourly cron. */
	public static function scholar_refresh_tick() {
		$t0    = microtime( true );
		$works = self::scholar_fetch_openalex( true );
		self::src_health( 'openalex', (bool) $works, ( microtime( true ) - $t0 ) * 1000, count( (array) $works ) );
		if ( $works ) {
			// Sample the pool's citation counters: Δcites between refreshes IS the trend.
			$hist = get_option( 'aq_scholar_hist', [] );
			if ( ! is_array( $hist ) ) { $hist = []; }
			$now  = time();
			$seen = [];
			foreach ( $works as $w ) {
				$key = md5( (string) ( ( $w['doi'] ?? '' ) ?: $w['title'] ) );
				$seen[ $key ] = true;
				$hist[ $key ] = self::rate_sample( $hist[ $key ] ?? null, (int) $w['cites'], $now, 100 * DAY_IN_SECONDS );
			}
			foreach ( $hist as $k => $h ) { // prune papers that left the pool >14 d ago
				if ( ! isset( $seen[ $k ] ) && ( $now - (int) ( $h['t'] ?? 0 ) ) > 14 * DAY_IN_SECONDS ) { unset( $hist[ $k ] ); }
			}
			update_option( 'aq_scholar_hist', $hist, false );

			// AI-summarise the papers that will actually render (top by quarterly rate) — no PDF
			// link, no thumbnail, just a one-sentence gloss. Attach the summary onto the work rows.
			$ranked = $works;
			foreach ( $ranked as &$w ) {
				$key       = md5( (string) ( ( $w['doi'] ?? '' ) ?: $w['title'] ) );
				$w['rate'] = self::scholar_rate( (int) ( $w['cites'] ?? 0 ), (string) ( $w['date'] ?? '' ), $hist[ $key ] ?? null );
			}
			unset( $w );
			usort( $ranked, static fn( $a, $b ) => $b['rate'] <=> $a['rate'] ?: $b['cites'] <=> $a['cites'] );
			$top = array_slice( $ranked, 0, 16 );
			self::ai_summarize( $top, 'research paper' ); // reads each work's abstract (desc), then strips it
			$sum = [];
			foreach ( $top as $t ) { if ( ! empty( $t['summary'] ) ) { $sum[ md5( (string) ( ( $t['doi'] ?? '' ) ?: $t['title'] ) ) ] = $t['summary']; } }
			foreach ( $works as &$w ) {
				$w['summary'] = (string) ( $sum[ md5( (string) ( ( $w['doi'] ?? '' ) ?: $w['title'] ) ) ] ?? '' );
				unset( $w['desc'] ); // (A4) the raw abstract must NEVER persist in the public pool — only the AI summary
			}
			unset( $w );

			update_option( 'aq_scholar_src', [ 'ts' => time(), 'works' => $works ], false );
		}
		// (A1) The marketplace pass runs on its OWN hourly cron (aq_mkt_sample, under Cron::guard).
		// It used to be tail-called here too, which bypassed that guard (racing the hourly job's
		// read-modify-write of aq_mkt_src) and burned the whole ai_summarize call budget on papers.
	}

	/** One counter observation folded into an item's rolling history { m0,t0 baseline · pm,pt
	 *  previous · m,t latest }. The baseline SLIDES to the previous sample once it is older than
	 *  $maxBase, so the rate always measures the recent window, never the all-time average. */
	private static function rate_sample( $h, $m, $now, $maxBase ) {
		if ( ! is_array( $h ) ) { return [ 'm0' => $m, 't0' => $now, 'pm' => $m, 'pt' => $now, 'm' => $m, 't' => $now ]; }
		if ( ( $now - (int) $h['t0'] ) > $maxBase && (int) ( $h['pt'] ?? 0 ) > (int) $h['t0'] ) {
			$h['m0'] = (int) $h['pm'];
			$h['t0'] = (int) $h['pt'];
		}
		$h['pm'] = (int) $h['m'];
		$h['pt'] = (int) $h['t'];
		$h['m']  = $m;
		$h['t']  = $now;
		return $h;
	}

	// ── AI summaries for the trending rail (operator 2026-07-23: "no external pics or hyperlinks
	// allowed. only AI summary of the contents"). The rail never republishes an external thumbnail
	// or drives a click off-platform — instead every trending item is shown as ONE neutral,
	// AI-written sentence describing what it is about. Summaries are generated in the crawl tick
	// (off the request path) through the flat-rate subscription relay (Relay::ask → the operator's
	// headless claude; model choice is free there), cached by content hash in aq_summary_cache so a
	// persistent item is summarised exactly once, and bounded to AI_SUM_BATCH new items per tick.
	// Fail-soft: relay down/busy or malformed reply ⇒ items keep whatever summary they had (the UI
	// falls back to the plain title, which is not a pic or a link). This helper ALSO strips `img`
	// off every row so no external picture can ever leave the backend.
	const AI_SUM_BATCH = 20;
	const AI_SUM_MAX_CALLS = 3; // relay turns per PHP REQUEST — the static counter is shared across every
	                            // tick that runs in one wp-cron request (mkt + social can batch together),
	                            // so total relay wait is ≤3×ASK_WAIT (150s) no matter how many ticks fire;
	                            // uncached items warm up over later ticks. Bounds tick(s) under the guard.

	/** Attach a `summary` to each row (cached, batched, fail-soft) and drop `img`. `$kind_label` is
	 *  the human noun ("paper", "model", "video"…) so the model frames the sentence correctly. */
	private static function ai_summarize( &$items, $kind_label ) {
		static $calls = 0;
		if ( ! is_array( $items ) || ! $items ) { return; }
		$cache = get_option( 'aq_summary_cache', [] );
		if ( ! is_array( $cache ) ) { $cache = []; }
		$keyer = static fn( $it ) => md5( (string) ( ( $it['url'] ?? '' ) ?: ( $it['title'] ?? '' ) ) );

		$need = [];
		foreach ( $items as $it ) {
			$k = $keyer( $it );
			if ( isset( $cache[ $k ] ) ) { continue; }
			$ctx = trim( (string) ( $it['title'] ?? '' ) );
			if ( ! empty( $it['desc'] ) ) { $ctx .= ' — ' . (string) $it['desc']; }
			$meta = trim( implode( ', ', array_filter( [ (string) ( $it['by'] ?? '' ), (string) ( $it['venue'] ?? '' ), (string) ( $it['field'] ?? '' ) ] ) ) );
			if ( '' !== $meta ) { $ctx .= ' (' . $meta . ')'; }
			if ( '' !== $ctx ) { $need[ $k ] = mb_substr( str_replace( [ "\n", "\r", "\t" ], ' ', $ctx ), 0, 600 ); }
		}

		if ( $need && $calls < self::AI_SUM_MAX_CALLS && Relay::available() ) {
			$calls++;
			$need  = array_slice( $need, 0, self::AI_SUM_BATCH, true );
			$lines = '';
			foreach ( $need as $k => $t ) { $lines .= $k . "\t" . $t . "\n"; }
			$sys = 'You explain trending ' . $kind_label . ' items to a curious general audience of ALL backgrounds. '
				. 'INPUT: one item per line as "<key>\t<title and context>". '
				. 'OUTPUT: a strict JSON object mapping each input key to ONE very short, plain-English sentence (MAX 18 words) that anyone can instantly understand — say plainly what it is and why it matters, in everyday words. '
				. 'NO jargon, NO acronyms or field terms unless you unpack them in plain words, NO hype, NO emojis, NO markdown, NO links, NO quotes around the sentence. Use every key exactly as given.';
			$res = Relay::ask( [ [ 'role' => 'user', 'content' => $lines ] ], $sys, Assistant::MODEL, 1800, 'low' );
			if ( is_array( $res ) && ! empty( $res['text'] ) ) {
				$txt = trim( (string) $res['text'] );
				if ( preg_match( '/\{.*\}/s', $txt, $mm ) ) { $txt = $mm[0]; } // tolerate ```json fences / prose
				$j = json_decode( $txt, true );
				if ( is_array( $j ) ) {
					foreach ( $j as $k => $s ) {
						$s = trim( wp_strip_all_tags( (string) $s ) );
						if ( '' !== $s && isset( $need[ $k ] ) ) { $cache[ $k ] = mb_substr( $s, 0, 240 ); }
					}
					if ( count( $cache ) > 3000 ) { $cache = array_slice( $cache, -2000, null, true ); } // bounded option
					update_option( 'aq_summary_cache', $cache, false );
				}
			}
		}

		foreach ( $items as &$it ) {
			$it['summary'] = (string) ( $cache[ $keyer( $it ) ] ?? '' );
			unset( $it['img'], $it['desc'] ); // enforce: no external picture (or raw desc) leaves the backend
		}
		unset( $it );
	}

	/** The paper's QUARTERLY citation rate (operator 2026-07-23: citations received per quarter /
	 *  season — the longest window). MEASURED once the DOI has ≥2 days of sampling history — Δcites
	 *  between our own refreshes, scaled to /quarter (91 days); before that, lifetime cites ÷ age
	 *  scaled to /quarter (the honest prior). */
	private static function scholar_rate( $cites, $date, $hist = null ) {
		if ( is_array( $hist ) && ( (int) $hist['t'] - (int) $hist['t0'] ) >= 2 * DAY_IN_SECONDS ) {
			$dt = (int) $hist['t'] - (int) $hist['t0'];
			return round( ( (int) $hist['m'] - (int) $hist['m0'] ) * 91 * DAY_IN_SECONDS / $dt, 1 );
		}
		$t = $date ? strtotime( $date . 'T00:00:00Z' ) : false;
		if ( false === $t ) { return 0.0; }
		$age = max( self::SCHOLAR_RATE_FLOOR, (int) floor( ( time() - $t ) / DAY_IN_SECONDS ) );
		return round( $cites * 91 / $age, 1 );
	}

	/** Stored pool → the payload: quarterly rates computed NOW (measured where history exists),
	 *  rate-ranked, topics grouped. Defence-in-depth: any `desc`/`img` that ever reached a stored
	 *  pool is dropped here too — the payload carries only the AI summary. */
	private static function scholar_assemble( $works, $ts ) {
		$works = is_array( $works ) ? $works : [];
		$hist  = get_option( 'aq_scholar_hist', [] );
		if ( ! is_array( $hist ) ) { $hist = []; }
		foreach ( $works as &$w ) {
			unset( $w['desc'], $w['img'] );
			$key = md5( (string) ( ( $w['doi'] ?? '' ) ?: ( $w['title'] ?? '' ) ) );
			$w['rate'] = self::scholar_rate( (int) ( $w['cites'] ?? 0 ), (string) ( $w['date'] ?? '' ), $hist[ $key ] ?? null );
		}
		unset( $w );
		usort( $works, static fn( $a, $b ) => $b['rate'] <=> $a['rate'] ?: $b['cites'] <=> $a['cites'] );
		return [
			'updated' => $ts,
			'days'    => self::SCHOLAR_DAYS,
			'papers'  => array_slice( $works, 0, self::SCHOLAR_PAPERS ),
			'topics'  => self::scholar_topics( $works ),
			'kinds'   => self::mkt_assemble(),
		];
	}

	// ── Trending marketplaces (operator 2026-07-22: "find the best marketplace for each and fetch
	// their trending contents"; source table revised same day: "X for news … X for illustrations
	// and short animation … just search X for media, kaggle for dataset, huggingface for model,
	// google scholar for paper") — one best-of-breed trending source per platform content kind.
	//
	// ORDERED SOURCES WITH HONEST FALLBACKS: X (news, media) and Kaggle (datasets) are the
	// operator's picks but their APIs are credential-gated (X: paid bearer token; Kaggle: account
	// key). Each such kind therefore tries its ordered marketplace when the Vault holds its
	// credential (X_BEARER_TOKEN · KAGGLE_TOKEN) and otherwise serves the best
	// keyless stand-in (2D illustration → Civitai); model + dataset are Kaggle-only since the
	// X leg at all — it is science + education newsrooms only (see MKT_NEWS_FEEDS);
	// the REAL source is stored with the pool and attributed member-facing, so the card never
	// claims X while serving a stand-in. Drop the credentials in wp-admin → AQ Vault and the
	// sources flip on the next 6-hour tick — no deploy. Paper stays OpenAlex: Google Scholar (the
	// operator's ask) publishes NO API and its terms forbid automated access — same story as the
	// papers card header above.
	//
	// Every fetcher is bounded and fail-soft: a source outage keeps that kind's last-good
	// (≤ SCHOLAR_SRC_MAX) instead of blanking the row.
	const MKT_ITEMS = 6;  // items STORED per kind after our rate ranks them (the card shows these)
	const MKT_FETCH = 30; // (A6) candidates FETCHED per source — a real slate for the Δrate ranking to
	                      // select over; without it we only ever saw the board's own top-MKT_ITEMS and
	                      // our ranking was a no-op re-sort. Only the top-MKT_ITEMS are stored/summarised.
	// News feeds — SCIENCE AND EDUCATION ONLY (operator 2026-07-30). The card previously carried
	// Al Jazeera + Google News top stories + Hacker News, which is general current affairs: arrests
	// at a London rally, air strikes, a gang sentencing. None of that is what this platform is for,
	// and a reproducibility feed that opens with world politics tells the reader they are somewhere
	// else. So the general aggregators and the Hacker News front page (a general tech board) are
	// gone, replaced by dedicated newsrooms on the two subjects — three science, three education,
	// so neither half can crowd the other out of the round-robin below.
	//
	// All keyless RSS, all verified live 2026-07-30 (200 + real <item>s); each item concisely
	// summarised. Nature's feed was rejected on inspection: it is largely paper listings, which the
	// papers card already covers. Ordered by source-diverse recency, not the long-term rate — news
	// is current-events, and an editorial feed carries no engagement counter to rank by.
	const MKT_NEWS_FEEDS = [
		[ 'https://www.sciencedaily.com/rss/all.xml', 'ScienceDaily' ],
		[ 'https://phys.org/rss-feed/', 'Phys.org' ],
		[ 'https://api.quantamagazine.org/feed/', 'Quanta Magazine' ],
		[ 'https://www.insidehighered.com/rss/feed/ihe', 'Inside Higher Ed' ],
		[ 'https://www.edsurge.com/articles_rss', 'EdSurge' ],
		[ 'https://hechingerreport.org/feed/', 'The Hechinger Report' ],
	];

	/** The kind registry, in display order. `source` is the default attribution — the tick stores
	 *  the source that ACTUALLY answered (X vs fallback) alongside each pool. */
	private static function mkt_kinds() {
		return [
			[ 'kind' => 'news',    'label' => 'News',            'source' => 'Science + education newsrooms' ],
			[ 'kind' => 'model',   'label' => 'Model',           'source' => 'Kaggle' ],
			[ 'kind' => 'dataset', 'label' => 'Dataset',         'source' => 'Kaggle' ],
			[ 'kind' => 'game2d',  'label' => '2D Game',         'source' => 'itch.io' ],
			[ 'kind' => 'game3d',  'label' => '3D Game',         'source' => 'itch.io' ],
			[ 'kind' => 'illo3d',  'label' => '3D Illustration', 'source' => 'Sketchfab' ],
			[ 'kind' => 'anim3d',  'label' => '3D Animation',    'source' => 'Sketchfab' ],
			[ 'kind' => 'illo2d',  'label' => '2D Illustration', 'source' => 'Civitai' ],
			[ 'kind' => 'anim2d',  'label' => '2D Animation',    'source' => 'X' ],
		];
	}

	/** Stored per-kind pools → the payload's `kinds` list (fresh-enough kinds only, in registry
	 *  order, each attributed to the source that actually filled it, carrying its rate window).
	 *  Defence-in-depth: `img`/`desc` are re-stripped here so even a pool stored by an older
	 *  version can never leak an external picture or raw text into the payload. */
	private static function mkt_assemble() {
		$src = get_option( 'aq_mkt_src', [] );
		if ( ! is_array( $src ) ) { $src = []; }
		$out = [];
		foreach ( self::mkt_kinds() as $k ) {
			$row = $src[ $k['kind'] ] ?? null;
			if ( ! is_array( $row['items'] ?? null ) || ! $row['items'] ) { continue; }
			if ( ( time() - (int) ( $row['ts'] ?? 0 ) ) > self::SCHOLAR_SRC_MAX ) { continue; } // too stale to call "trending"
			$items = array_values( $row['items'] );
			foreach ( $items as &$it ) { unset( $it['img'], $it['desc'] ); }
			unset( $it );
			$out[] = [ 'kind' => $k['kind'], 'label' => $k['label'], 'window' => self::mkt_window( $k['kind'] ),
				'source' => (string) ( $row['source'] ?? $k['source'] ), 'items' => $items ];
		}
		return $out;
	}

	// ── OUR OWN TREND MATH (operator 2026-07-23 "selection must be based on your own rate
	// calculation … show the highest rates"; 2026-07-24 "all trending material must be based on
	// LONG-TERM trend") — the marketplace's board only NOMINATES candidates; selection and order
	// come from OUR measured rate: each hourly sampling pass (aq_mkt_sample cron) records every
	// candidate's counter into a rolling history whose baseline slides but is held up to
	// MKT_RATE_BASE (28 DAYS), so rate = Δcounter ÷ Δtime is a SUSTAINED long-term trend, not a
	// day-or-two spike, expressed in the kind's window (news per HOUR, everything else per DAY;
	// papers per QUARTER on the 6 h scholar refresh — see scholar_rate). A first-seen item has no
	// Δ yet, so its prior is counter ÷ its own age where the marketplace dates it (a lifetime
	// average — itself long-term), else 0 until it earns two hours of history. itch exposes NO
	// counters in its feeds, so its "counter" is the negated board position (positions climbed).
	const MKT_RATE_MIN_DT = 7200;            // 2 h of history before a measured Δ-rate replaces the prior
	const MKT_RATE_BASE   = 28 * DAY_IN_SECONDS; // LONG-TERM (operator 2026-07-24): the sliding baseline
	                                         // holds up to 28 days, so the rate measures a SUSTAINED month-
	                                         // long trend, not a 2-day spike. Content that only lives a few
	                                         // days is naturally measured over its own lifetime; persistent
	                                         // content (models, datasets) earns a true long-term rate.

	/** The unit each kind's rate is expressed in — the operator's per-type windows. */
	private static function mkt_window( $kind ) {
		return 'news' === $kind ? 'hour' : 'day';
	}

	/** The counter OUR rate differentiates per kind ('' = positional velocity — no counters). */
	private static function mkt_counter( $kind ) {
		switch ( $kind ) {
			case 'news':    return 'points';
			case 'model':
			case 'dataset': return 'downloads';
			case 'illo2d':  return 'reactions';
			case 'game2d':
			case 'game3d':  return '';
		}
		return 'likes'; // sketchfab kinds + X media
	}

	/** The hourly sampling pass (aq_mkt_sample cron): fetch every kind's candidate slate, fold
	 *  counters into the sample history, rank by OUR rate, summarise + store the top slice. A3: the
	 *  sample-history option is read/written ONCE. A7: each kind runs in its own try/catch so one
	 *  poison candidate can't starve the other eight (and last-good survives). */
	public static function mkt_sample_tick() {
		$mkt = get_option( 'aq_mkt_src', [] );
		if ( ! is_array( $mkt ) ) { $mkt = []; }
		$all = get_option( 'aq_mkt_samples', [] ); // A3: read once
		if ( ! is_array( $all ) ) { $all = []; }
		foreach ( self::mkt_kinds() as $k ) {
			try {
				$t0 = microtime( true );
				[ $items, $source ] = self::mkt_fetch( $k['kind'] );
				self::src_health( 'mkt:' . $k['kind'], (bool) $items, (microtime( true ) - $t0) * 1000, count( (array) $items ) );
				if ( ! $items ) { continue; } // source outage → keep last-good (and its history)
				$items = self::mkt_rate_items( $all, $k['kind'], $items );
				$items = array_slice( $items, 0, self::MKT_ITEMS );
				self::ai_summarize( $items, strtolower( (string) $k['label'] ) ); // AI summary + strip img/desc
				$mkt[ $k['kind'] ] = [ 'ts' => time(), 'source' => $source, 'items' => $items ];
			} catch ( \Throwable $e ) {
				self::src_health( 'mkt:' . $k['kind'], false, 0, 0, $e->getMessage() ); // keep last-good, next kind
			}
		}
		update_option( 'aq_mkt_src', $mkt, false );
		update_option( 'aq_mkt_samples', $all, false ); // A3: write once
		delete_transient( 'aq_scholar_v4' ); // serve the fresh rates now, not in ≤6h
	}

	/** (A8) Per-source crawl health, surfaced beside Cron::stats in the operator Console. Stores
	 *  ONLY counts/latency/error text — never a token, url, or title. Self-swallowing: observability
	 *  must never break a tick. Bounded to the finite source key set. */
	public static function src_health( $key, $ok, $ms, $n, $err = '' ) {
		try {
			$h = get_option( 'aq_crawl_health', [] );
			if ( ! is_array( $h ) ) { $h = []; }
			$h[ (string) $key ] = [ 'at' => time(), 'ms' => (int) round( $ms ), 'ok' => (bool) $ok, 'n' => (int) $n, 'err' => mb_substr( (string) $err, 0, 200 ) ];
			update_option( 'aq_crawl_health', $h, false );
		} catch ( \Throwable $e ) { /* health must never break a tick */ }
	}

	/** The per-source crawl health map for the operator Console. */
	public static function crawl_health() {
		$h = get_option( 'aq_crawl_health', [] );
		return is_array( $h ) ? $h : [];
	}

	/** Fold one fetch's counters into the kind's sample history (mutating the shared $all sample
	 *  map by reference — A3: read/write the whole option ONCE per tick, not once per kind) and
	 *  attach OUR rate to each item. */
	private static function mkt_rate_items( array &$all, $kind, $items ) {
		$hist = is_array( $all[ $kind ] ?? null ) ? $all[ $kind ] : [];
		$ck   = self::mkt_counter( $kind );
		$unit = 'hour' === self::mkt_window( $kind ) ? HOUR_IN_SECONDS : DAY_IN_SECONDS;
		$now  = time();
		$seen = [];
		foreach ( $items as &$it ) {
			$key = md5( (string) $it['url'] );
			$seen[ $key ] = true;
			$m = '' === $ck ? -(int) ( $it['rank'] ?? 99 ) : (int) ( $it[ $ck ] ?? 0 );
			$h = self::rate_sample( $hist[ $key ] ?? null, $m, $now, self::MKT_RATE_BASE );
			$hist[ $key ] = $h;
			$dt = (int) $h['t'] - (int) $h['t0'];
			if ( $dt >= self::MKT_RATE_MIN_DT ) {
				$it['rate'] = round( ( (int) $h['m'] - (int) $h['m0'] ) * $unit / $dt, 1 );
			} elseif ( '' !== $ck && ! empty( $it['ts'] ) ) {
				$it['rate'] = round( $m * $unit / max( $unit, $now - (int) $it['ts'] ), 1 ); // prior: counter ÷ age
			} else {
				$it['rate'] = 0.0; // undated first sighting — earns its rate after two hours
			}
		}
		unset( $it );
		foreach ( $hist as $k => $h ) { // prune items unseen for 7 days (bounded option)
			if ( ! isset( $seen[ $k ] ) && ( $now - (int) ( $h['t'] ?? 0 ) ) > 7 * DAY_IN_SECONDS ) { unset( $hist[ $k ] ); }
		}
		$all[ $kind ] = $hist;
		// News keeps its source-diverse recency order (mkt_news interleave); every other kind is
		// ranked by OUR measured long-term rate.
		if ( 'news' !== $kind ) { usort( $items, static fn( $a, $b ) => $b['rate'] <=> $a['rate'] ); }
		return $items;
	}

	/** One kind → [ items, source-that-answered ]. Ordered marketplace first (when its credential
	 *  exists), keyless stand-in second. [ [], '' ] on total failure — the tick then keeps last-good. */
	private static function mkt_fetch( $kind ) {
		try {
			switch ( $kind ) {
				case 'news':    return [ self::mkt_news(), 'ScienceDaily · Phys.org · Quanta · Inside Higher Ed · EdSurge · Hechinger' ];
				// Models and datasets both read from Kaggle now (operator 2026-08-02, the HF purge).
				// The dataset rail no longer has a HuggingFace fallback to drop to: an unset
				// KAGGLE_TOKEN yields [], and mkt_assemble hides a kind with no items rather than
				// erroring, so the rail simply does not appear — which is the honest outcome. Do not
				// re-add a fallback to a source we no longer credit.
				case 'model':   return [ self::mkt_kaggle_models(), 'Kaggle' ];
				case 'dataset': return [ self::mkt_kaggle(), 'Kaggle' ];
				case 'game2d':  return [ self::mkt_itch( '2d' ), 'itch.io' ];
				case 'game3d':  return [ self::mkt_itch( '3d' ), 'itch.io' ];
				case 'illo3d':  return [ self::mkt_sketchfab( false ), 'Sketchfab' ];
				case 'anim3d':  return [ self::mkt_sketchfab( true ), 'Sketchfab' ];
				case 'illo2d':
					$x = self::mkt_x_media( 'images' );
					return $x ? [ $x, 'X' ] : [ self::mkt_civitai(), 'Civitai' ];
				case 'anim2d':  return [ self::mkt_x_media( 'videos' ), 'X' ]; // hidden until the X token exists
			}
		} catch ( \Throwable $e ) { /* a marketplace must never break the tick */ }
		return [ [], '' ];
	}

	/** Bounded GET → decoded JSON array, or null. All marketplace fetchers go through this. */
	private static function mkt_get_json( $url, $timeout = 12 ) {
		$res = wp_remote_get( $url, [ 'timeout' => $timeout, 'redirection' => 2, 'user-agent' => 'Mozilla/5.0 (compatible; ArtaQuest/1.0; +https://artaquest.com)' ] );
		if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) { return null; }
		$body = json_decode( (string) wp_remote_retrieve_body( $res ), true );
		return is_array( $body ) ? $body : null;
	}

	/** Bounded GET → parsed RSS SimpleXMLElement, or null. */
	private static function mkt_get_xml( $url, $timeout = 12 ) {
		$res = wp_remote_get( $url, [ 'timeout' => $timeout, 'redirection' => 2, 'user-agent' => 'Mozilla/5.0 (compatible; ArtaQuest/1.0; +https://artaquest.com)' ] );
		if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) { return null; }
		$prev = libxml_use_internal_errors( true );
		$xml  = simplexml_load_string( (string) wp_remote_retrieve_body( $res ), 'SimpleXMLElement', LIBXML_NOCDATA );
		libxml_use_internal_errors( $prev );
		return $xml ?: null;
	}

	/** One RSS feed → up to $cap recency-ordered news rows. `by` = the item's own outlet (RSS
	 *  <source>, e.g. Google News's originating publisher) when present, else the feed label.
	 *  desc feeds the AI summary and is stripped before storage; points=0 (editorial, no engagement). */
	private static function mkt_rss( $url, $label, $cap = 10 ) {
		$xml = self::mkt_get_xml( $url );
		if ( ! $xml || ! isset( $xml->channel->item ) ) { return []; }
		$out = [];
		$i   = 0;
		foreach ( $xml->channel->item as $it ) {
			if ( ++$i > $cap ) { break; }
			$title = trim( wp_strip_all_tags( html_entity_decode( (string) $it->title, ENT_QUOTES, 'UTF-8' ) ) );
			$link  = trim( (string) $it->link );
			if ( '' === $title || ! wp_http_validate_url( $link ) ) { continue; }
			$src = trim( wp_strip_all_tags( (string) ( $it->source ?? '' ) ) ); // Google News tags the real outlet here
			if ( '' !== $src ) { $title = (string) preg_replace( '/\s+[-–]\s+' . preg_quote( $src, '/' ) . '$/u', '', $title ); } // drop the " - Outlet" suffix
			$ts = strtotime( (string) $it->pubDate );
			$out[] = [
				'title'  => $title,
				'by'     => '' !== $src ? $src : $label,
				'url'    => $link,
				'ts'     => false === $ts ? time() : $ts,
				'desc'   => mb_substr( trim( wp_strip_all_tags( html_entity_decode( (string) $it->description, ENT_QUOTES, 'UTF-8' ) ) ), 0, 400 ),
				'points' => 0,
			];
		}
		return $out;
	}

	/** News — the science + education newsrooms in MKT_NEWS_FEEDS. Each source's freshest items are
	 *  ROUND-ROBIN interleaved so every source is represented (and so three science feeds cannot
	 *  bury the three education ones), deduped by url; the order is source-diverse recency — news is
	 *  current-events, so it is NOT re-ranked by the long-term rate (mkt_rate_items leaves it be). */
	private static function mkt_news() {
		$groups = [];
		foreach ( self::MKT_NEWS_FEEDS as $f ) { $groups[] = self::mkt_rss( $f[0], $f[1], 10 ); }
		$out  = [];
		$seen = [];
		while ( true ) {
			$any = false;
			foreach ( array_keys( $groups ) as $gi ) {
				if ( empty( $groups[ $gi ] ) ) { continue; }
				$it  = array_shift( $groups[ $gi ] );
				$any = true;
				$u   = (string) ( $it['url'] ?? '' );
				if ( '' !== $u && ! isset( $seen[ $u ] ) ) { $seen[ $u ] = true; $out[] = $it; }
			}
			if ( ! $any ) { break; }
		}
		return $out;
	}


	/** Model — Kaggle's "hottest" models board. [] without the credential.
	 *  Replaces the HuggingFace trendingScore fetch this used to be (operator 2026-08-02, the HF purge):
	 *  Kaggle is now the only place the platform reads a model or dataset board from, on the same
	 *  KAGGLE_TOKEN Bearer that mkt_kaggle() and Kaggle.php already use — one credential, one home.
	 *  The model slug is the headline and the author is the byline, because "owner/name" as a title
	 *  reads like a path rather than a name. */
	private static function mkt_kaggle_models() {
		$token = (string) Secrets::get( 'KAGGLE_TOKEN' );
		if ( '' === $token ) { return []; }
		$body = self::mkt_get_json_auth( 'https://www.kaggle.com/api/v1/models/list?sortBy=hotness&pageSize=' . self::MKT_FETCH,
			'Bearer ' . $token, 20 );
		$rows = ( is_array( $body ) && isset( $body['models'] ) && is_array( $body['models'] ) ) ? $body['models'] : (array) $body;
		$out  = [];
		foreach ( $rows as $m ) {
			$ref   = trim( (string) ( $m['ref'] ?? '' ) );
			$title = trim( (string) ( $m['title'] ?? '' ) );
			if ( '' === $ref || '' === $title ) { continue; }
			$ts = strtotime( (string) ( $m['updateTime'] ?? '' ) );
			// The subtitle is plain prose; `description` is HTML and would poison the AI summary and the
			// public options row it is cached in. Take the subtitle, and the tag names when it is empty.
			$desc = trim( (string) ( $m['subtitle'] ?? '' ) );
			if ( '' === $desc ) {
				$names = [];
				foreach ( array_slice( (array) ( $m['tags'] ?? [] ), 0, 6 ) as $t ) {
					$n = trim( (string) ( $t['nameNullable'] ?? $t['name'] ?? '' ) );
					if ( '' !== $n ) { $names[] = $n; }
				}
				$desc = implode( ' ', $names );
			}
			$out[] = [
				'title' => $title,
				'by'    => (string) ( $m['author'] ?? strtok( $ref, '/' ) ),
				'desc'  => $desc,
				'url'   => 'https://www.kaggle.com/models/' . $ref,
				'ts'    => false === $ts ? 0 : $ts,
				'likes' => (int) ( $m['voteCount'] ?? 0 ) ];
		}
		return $out;
	}

	/** 2D / 3D Game — itch.io's public "top games" RSS per tag (the feed order IS the ranking). */
	private static function mkt_itch( $tag ) {
		// The tag feeds render ~16 s on bad days; 429s from over-polling are a probe-time artefact
		// only — the 6-hourly cron is far under itch's limits.
		$res = wp_remote_get( 'https://itch.io/games/tag-' . $tag . '.xml', [ 'timeout' => 20, 'redirection' => 3, 'user-agent' => 'Mozilla/5.0 (compatible; ArtaQuest/1.0; +https://artaquest.com)' ] );
		if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) { return []; }
		$prev = libxml_use_internal_errors( true );
		$xml  = simplexml_load_string( (string) wp_remote_retrieve_body( $res ), 'SimpleXMLElement', LIBXML_NOCDATA );
		libxml_use_internal_errors( $prev );
		if ( ! $xml || ! isset( $xml->channel->item ) ) { return []; }
		$out = [];
		$i   = 0;
		foreach ( $xml->channel->item as $it ) {
			if ( ++$i > self::MKT_FETCH ) { break; }
			$title = trim( (string) ( $it->plainTitle ?: $it->title ) );
			$link  = (string) $it->link;
			if ( '' === $title || ! wp_http_validate_url( $link ) ) { continue; }
			$host = (string) wp_parse_url( $link, PHP_URL_HOST ); // author lives in the subdomain
			$out[] = [ 'title' => $title, 'by' => str_replace( '.itch.io', '', $host ), 'url' => $link,
				'desc' => mb_substr( trim( wp_strip_all_tags( (string) $it->description ) ), 0, 400 ), // (A5)
				'img' => wp_http_validate_url( (string) $it->imageurl ) ? (string) $it->imageurl : '', 'rank' => $i ];
		}
		return $out;
	}

	/** 3D Illustration / 3D Animation — Sketchfab search, last-7-days window (date=7), most liked.
	 *  Safety: restricted content excluded at the API AND re-checked per row (isAgeRestricted). */
	private static function mkt_sketchfab( $animated ) {
		// animated=false vs true cleanly splits 3D Illustration (static renders) from 3D Animation —
		// without the false filter an animated model tops BOTH boards (it's a subset of all models).
		$url  = 'https://api.sketchfab.com/v3/search?type=models&sort_by=-likeCount&date=7&restricted=false&animated=' . ( $animated ? 'true' : 'false' ) . '&count=' . self::MKT_FETCH;
		$body = self::mkt_get_json( $url );
		$out  = [];
		foreach ( (array) ( $body['results'] ?? [] ) as $r ) {
			if ( ! empty( $r['isAgeRestricted'] ) ) { continue; } // belt + braces
			$title = trim( (string) ( $r['name'] ?? '' ) );
			$view  = (string) ( $r['viewerUrl'] ?? '' );
			if ( '' === $title || ! wp_http_validate_url( $view ) ) { continue; }
			$img  = '';
			$best = PHP_INT_MAX;
			foreach ( (array) ( $r['thumbnails']['images'] ?? [] ) as $t ) { // smallest thumb ≥ ~128px
				$w = (int) ( $t['width'] ?? 0 );
				$u = (string) ( $t['url'] ?? '' );
				if ( $w >= 100 && abs( $w - 144 ) < $best && wp_http_validate_url( $u ) ) { $best = abs( $w - 144 ); $img = $u; }
			}
			$ts = strtotime( (string) ( $r['publishedAt'] ?? '' ) );
			$out[] = [ 'title' => $title, 'by' => (string) ( $r['user']['displayName'] ?? '' ), 'url' => $view,
				'desc' => mb_substr( trim( wp_strip_all_tags( (string) ( $r['description'] ?? '' ) ) ), 0, 400 ), // (A5)
				'ts' => false === $ts ? 0 : $ts,
				'img' => $img, 'likes' => (int) ( $r['likeCount'] ?? 0 ), 'views' => (int) ( $r['viewCount'] ?? 0 ) ];
		}
		return $out;
	}

	/** 2D Illustration — Civitai's week board by reactions, SAFE ONLY (nsfw=None asked AND re-checked
	 *  per row), ONE image per creator (a prolific poster must not own the whole row). Slow host:
	 *  generous timeout, and the tick's fail-soft covers the bad days. */
	private static function mkt_civitai() {
		$body = self::mkt_get_json( 'https://civitai.com/api/v1/images?sort=' . rawurlencode( 'Most Reactions' ) . '&period=Week&nsfw=None&limit=' . self::MKT_FETCH, 20 );
		$out  = [];
		$seen = [];
		foreach ( (array) ( $body['items'] ?? [] ) as $it ) {
			if ( ! empty( $it['nsfw'] ) || 'None' !== (string) ( $it['nsfwLevel'] ?? '' ) ) { continue; } // belt + braces
			$user = trim( (string) ( $it['username'] ?? '' ) );
			if ( isset( $seen[ $user ] ) ) { continue; } // board arrives reaction-ranked — first seen = creator's best
			$seen[ $user ] = true;
			$id   = (int) ( $it['id'] ?? 0 );
			$img  = (string) ( $it['url'] ?? '' );
			if ( '' === $user || ! $id || ! wp_http_validate_url( $img ) ) { continue; }
			$s  = is_array( $it['stats'] ?? null ) ? $it['stats'] : [];
			$ts = strtotime( (string) ( $it['createdAt'] ?? '' ) );
			$out[] = [ 'title' => $user, 'by' => '', 'url' => 'https://civitai.com/images/' . $id,
				'ts' => false === $ts ? 0 : $ts,
				'img' => str_replace( 'original=true', 'width=192', $img ),
				'reactions' => (int) ( $s['likeCount'] ?? 0 ) + (int) ( $s['heartCount'] ?? 0 ) + (int) ( $s['laughCount'] ?? 0 ) + (int) ( $s['cryCount'] ?? 0 ) ];
		}
		return $out;
	}

	/** The X bearer token (X's API is paid). Absent → every X-first kind serves its honest fallback. */
	private static function mkt_x_token() {
		return (string) Secrets::get( 'X_BEARER_TOKEN' );
	}

	/** Bounded authorised GET → decoded JSON, or null. */
	private static function mkt_get_json_auth( $url, $auth, $timeout = 12 ) {
		$res = wp_remote_get( $url, [ 'timeout' => $timeout, 'redirection' => 2,
			'headers' => [ 'Authorization' => $auth ],
			'user-agent' => 'ArtaQuest/1.0 (+https://artaquest.com; support@artaquest.org)' ] );
		if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) { return null; }
		$body = json_decode( (string) wp_remote_retrieve_body( $res ), true );
		return is_array( $body ) ? $body : null;
	}

	/** News — X worldwide trends (woeid 1), each linking to its live X search. [] without a token. */
	private static function mkt_x_trends() {
		$tok = self::mkt_x_token();
		if ( '' === $tok ) { return []; }
		$body = self::mkt_get_json_auth( 'https://api.x.com/2/trends/by/woeid/1?max_trends=' . self::MKT_FETCH, 'Bearer ' . $tok );
		$out  = [];
		$i    = 0;
		foreach ( (array) ( $body['data'] ?? [] ) as $t ) {
			$name  = trim( wp_strip_all_tags( (string) ( $t['trend_name'] ?? '' ) ) );
			if ( '' === $name ) { continue; }
			$posts = (int) ( $t['tweet_count'] ?? 0 );
			// 'points' is the counter mkt_counter('news') differentiates for the rate — it MUST be
			// present or news would rate 0 forever once X is credentialed. 'posts' stays for the
			// card's own volume wording.
			$out[] = [ 'title' => $name, 'by' => '', 'url' => 'https://x.com/search?q=' . rawurlencode( $name ),
				'posts' => $posts, 'points' => $posts, 'rank' => ++$i ];
		}
		return $out;
	}

	/** Media — X recent search ranked by relevancy: images fill 2D Illustration, videos fill
	 *   2D (short) Animation. Engagement rides along (likes + impressions). [] without a token. */
	private static function mkt_x_media( $what ) {
		$tok = self::mkt_x_token();
		if ( '' === $tok ) { return []; }
		$query = 'videos' === $what
			? '(animation OR animated short) has:videos -is:retweet -is:reply lang:en'
			: '(illustration OR artwork) has:images -is:retweet -is:reply lang:en';
		$url = add_query_arg( [
			'query'        => $query,
			'max_results'  => self::MKT_FETCH, // X recent-search accepts 10–100; 30 = the slate
			'sort_order'   => 'relevancy',
			'tweet.fields' => 'public_metrics,created_at',
			'expansions'   => 'author_id,attachments.media_keys',
			'user.fields'  => 'username',
			'media.fields' => 'preview_image_url,url,type',
		], 'https://api.x.com/2/tweets/search/recent' );
		$body = self::mkt_get_json_auth( $url, 'Bearer ' . $tok );
		if ( ! $body ) { return []; }
		$users = [];
		foreach ( (array) ( $body['includes']['users'] ?? [] ) as $u ) { $users[ (string) $u['id'] ] = (string) ( $u['username'] ?? '' ); }
		$media = [];
		foreach ( (array) ( $body['includes']['media'] ?? [] ) as $m ) {
			$media[ (string) ( $m['media_key'] ?? '' ) ] = (string) ( ( $m['url'] ?? '' ) ?: ( $m['preview_image_url'] ?? '' ) );
		}
		$out = [];
		foreach ( (array) ( $body['data'] ?? [] ) as $tw ) {
			$text = trim( preg_replace( '/\s+/', ' ', preg_replace( '/https?:\/\/\S+/', '', (string) ( $tw['text'] ?? '' ) ) ) );
			$user = $users[ (string) ( $tw['author_id'] ?? '' ) ] ?? '';
			if ( '' === $text || '' === $user ) { continue; }
			$img = '';
			foreach ( (array) ( $tw['attachments']['media_keys'] ?? [] ) as $mk ) {
				if ( ! empty( $media[ $mk ] ) ) { $img = $media[ $mk ]; break; }
			}
			$pm = is_array( $tw['public_metrics'] ?? null ) ? $tw['public_metrics'] : [];
			$ts = strtotime( (string) ( $tw['created_at'] ?? '' ) );
			$likes = (int) ( $pm['like_count'] ?? 0 );
			$out[] = [ 'title' => wp_html_excerpt( $text, 90, '…' ), 'by' => '@' . $user,
				'url' => 'https://x.com/' . rawurlencode( $user ) . '/status/' . rawurlencode( (string) ( $tw['id'] ?? '' ) ),
				'ts' => false === $ts ? 0 : $ts,
				'img' => wp_http_validate_url( $img ) ? $img : '',
				// illo2d's counter is 'reactions', anim2d's is 'likes' (default) — emit BOTH so whichever
				// kind X media fills, mkt_rate_items finds its counter and the rate isn't stuck at 0.
				'likes' => $likes, 'reactions' => $likes, 'views' => (int) ( $pm['impression_count'] ?? 0 ) ];
		}
		return $out;
	}

	/** Dataset — Kaggle's "hottest" board (the operator's pick). [] without the credential.
	 *  ONE Kaggle credential, ONE name (operator 2026-07-27): the Vault's KAGGLE_TOKEN as a Bearer
	 *  header, the same secret Kaggle.php pushes kernels with — verified 200 on datasets/list. The
	 *  legacy KAGGLE_USERNAME + KAGGLE_KEY Basic pair this used to read is retired. */
	private static function mkt_kaggle() {
		$token = (string) Secrets::get( 'KAGGLE_TOKEN' );
		if ( '' === $token ) { return []; }
		$body = self::mkt_get_json_auth( 'https://www.kaggle.com/api/v1/datasets/list?sortBy=hottest&pageSize=' . self::MKT_FETCH,
			'Bearer ' . $token, 15 );
		$out  = [];
		foreach ( (array) $body as $d ) {
			$ref   = trim( (string) ( $d['ref'] ?? '' ) );
			$title = trim( (string) ( $d['title'] ?? '' ) );
			if ( '' === $ref || '' === $title ) { continue; }
			$out[] = [ 'title' => $title, 'by' => (string) strtok( $ref, '/' ),
				'url' => 'https://www.kaggle.com/datasets/' . $ref,
				'downloads' => (int) ( $d['downloadCount'] ?? $d['totalDownloads'] ?? 0 ),
				'likes'     => (int) ( $d['voteCount'] ?? $d['totalVotes'] ?? 0 ) ];
		}
		return $out;
	}

	// ── Educational social crawl (operator 2026-07-23: "add cron jobs for data crawl for the top
	// social media platforms … reddit, youtube … LinkedIn … only platforms with rich educational
	// contents"). Mirrors the mkt_* trending engine EXACTLY — a fetch-per-kind returning
	// [ items, source ], the shared rate_sample() sliding-baseline history, our own Δcounter÷Δt
	// ranking, fail-soft last-good, one public GET route — but on its OWN hourly cron
	// (aq_social_crawl) so a Reddit token stall or YouTube quota trip can't wobble the marketplace
	// tick. Storage: option aq_social_src (snapshots) + aq_social_samples (rate history).
	//
	// EVERY source here is CREDENTIAL-GATED and honest about it (verified live 2026-07-23):
	//   • Reddit — the keyless .json path is DEAD server-side (403 HTML block from every datacenter
	//     egress + every UA; robots.txt Disallow: /). The only ToS-compliant path is OAuth: mint an
	//     app-only bearer from REDDIT_CLIENT_ID/SECRET, then read oauth.reddit.com. Educational
	//     filter = a curated SFW multi-subreddit whitelist baked into the path (no r/all), plus a
	//     per-post over_18/spoiler backstop.
	//   • YouTube — Data API videos.list?chart=mostPopular scoped to educational category IDs
	//     (27 Education, 28 Science & Technology). Gated on the platform's own YOUTUBE_API_KEY.
	//   • Instagram — no keyless path; the Graph API Hashtag Search → top_media reads the top posts
	//     for a curated set of EDUCATIONAL hashtags (like_count as the counter). Gated on a business
	//     token IG_ACCESS_TOKEN + IG_USER_ID.
	//   • LinkedIn — NO public/trending content API exists (every /rest/* and /v2/* is 401; no
	//     discovery scope; robots.txt bans automation) AND no public engagement counter even with a
	//     token. Shipped as a DORMANT stub kept OUT of the kind registry until a partner
	//     LINKEDIN_ACCESS_TOKEN lands — never scraped.
	// Each lights up the moment its secret is added to the Vault — no deploy — exactly the X/Kaggle
	// pattern. Absent secrets ⇒ the fetcher returns [] ⇒ the kind is silently omitted.
	const SOC_ITEMS = 6;
	const SOC_REDDIT_SUBS = 'science+askscience+explainlikeimfive+todayilearned+YouShouldKnow'
		. '+educationalgifs+learnprogramming+math+physics+history+AskHistorians+space'
		. '+Astronomy+chemistry+biology+engineering+coolguides+Documentaries+dataisbeautiful'
		. '+geology+neuroscience+philosophy+compsci+statistics+economics+datascience'  // broader educational coverage
		. '+psychology+linguistics+cogsci+environment+askengineers+AskComputerScience';
	const SOC_YT_CATEGORIES = [ 27, 28 ];                                          // Education, Science & Technology
	const SOC_EDU_TAGS      = [ 'education', 'science', 'learning', 'physics', 'history', 'math',
		'chemistry', 'biology', 'astronomy', 'technology', 'engineering', 'medicine' ]; // Instagram hashtags (≤30/7d cap)

	/** The social kinds in display order. LinkedIn is deliberately absent until it has a token
	 *  (it exposes no engagement counter, so it can't be rate-ranked); the rest are dormant-until-
	 *  credentialed but rate-rankable, so they sit in the registry and appear when their key lands. */
	private static function soc_kinds() {
		return [
			[ 'kind' => 'reddit_edu',    'label' => 'Reddit',    'source' => 'Reddit'    ],
			[ 'kind' => 'youtube_edu',   'label' => 'YouTube',   'source' => 'YouTube'   ],
			[ 'kind' => 'instagram_edu', 'label' => 'Instagram', 'source' => 'Instagram' ],
		];
	}

	private static function soc_window( $kind )  { return 'day'; }               // ups/views/likes are daily accumulators
	private static function soc_counter( $kind ) { return 'reddit_edu' === $kind ? 'ups' : ( 'instagram_edu' === $kind ? 'likes' : 'views' ); }
	private static function soc_noun( $kind )    { return 'reddit_edu' === $kind ? 'educational discussion' : ( 'youtube_edu' === $kind ? 'educational video' : 'educational post' ); }

	/** GET social/trending — { kinds:[…], ts } for the educational-social rail; assembles the stored
	 *  pools only (never fetches on the request path — identical discipline to scholar_trending). */
	public static function social_trending( $req = null ) {
		$cached = get_transient( 'aq_social_v1' );
		if ( is_array( $cached ) ) { return $cached; }
		$out = [ 'kinds' => self::soc_assemble(), 'ts' => time() ];
		set_transient( 'aq_social_v1', $out, HOUR_IN_SECONDS );
		return $out;
	}

	/** Stored per-kind pools → the payload (fresh-enough kinds only, source-attributed, with the
	 *  rate window). Defence-in-depth: `img`/`desc` re-stripped, as in mkt_assemble. */
	private static function soc_assemble() {
		$src = get_option( 'aq_social_src', [] );
		if ( ! is_array( $src ) ) { $src = []; }
		$out = [];
		foreach ( self::soc_kinds() as $k ) {
			$row = $src[ $k['kind'] ] ?? null;
			if ( ! is_array( $row['items'] ?? null ) || ! $row['items'] ) { continue; }
			if ( ( time() - (int) ( $row['ts'] ?? 0 ) ) > self::SCHOLAR_SRC_MAX ) { continue; } // ≤7d or hide
			$items = array_values( $row['items'] );
			foreach ( $items as &$it ) { unset( $it['img'], $it['desc'] ); }
			unset( $it );
			$out[] = [ 'kind' => $k['kind'], 'label' => $k['label'], 'window' => self::soc_window( $k['kind'] ),
				'source' => (string) ( $row['source'] ?? $k['source'] ), 'items' => $items ];
		}
		return $out;
	}

	/** The hourly cron body (aq_social_crawl, via Cron::guard): crawl each educational platform,
	 *  fold counters into the sample history, rank by OUR rate, store. Fail-soft per kind. */
	public static function social_crawl_tick() {
		$soc = get_option( 'aq_social_src', [] );
		if ( ! is_array( $soc ) ) { $soc = []; }
		$all = get_option( 'aq_social_samples', [] ); // A3: read once
		if ( ! is_array( $all ) ) { $all = []; }
		foreach ( self::soc_kinds() as $k ) {
			try {
				$t0 = microtime( true );
				[ $items, $source ] = self::soc_fetch( $k['kind'] );
				self::src_health( 'soc:' . $k['kind'], (bool) $items, (microtime( true ) - $t0) * 1000, count( (array) $items ) );
				if ( ! $items ) { continue; } // outage / dormant secret → keep last-good + its history
				$items = self::soc_rate_items( $all, $k['kind'], $items );
				$items = array_slice( $items, 0, self::SOC_ITEMS );
				self::ai_summarize( $items, self::soc_noun( $k['kind'] ) ); // AI summary + strip img/desc
				$soc[ $k['kind'] ] = [ 'ts' => time(), 'source' => $source, 'items' => $items ];
			} catch ( \Throwable $e ) {
				self::src_health( 'soc:' . $k['kind'], false, 0, 0, $e->getMessage() );
			}
		}
		update_option( 'aq_social_src', $soc, false );
		update_option( 'aq_social_samples', $all, false ); // A3: write once
		delete_transient( 'aq_social_v1' );
	}

	/** One kind → [ items, source ]. try/catch so one platform never breaks the tick. */
	private static function soc_fetch( $kind ) {
		try {
			switch ( $kind ) {
				case 'reddit_edu':    return [ self::soc_reddit(),    'Reddit'    ];
				case 'youtube_edu':   return [ self::soc_youtube(),   'YouTube'   ];
				case 'instagram_edu': return [ self::soc_instagram(), 'Instagram' ];
				case 'linkedin_edu':  return [ self::soc_linkedin(),  'LinkedIn Learning' ]; // dormant unless registered
			}
		} catch ( \Throwable $e ) { /* a platform must never break the tick */ }
		return [ [], '' ];
	}

	/** Fold this fetch's counters into the kind's sample history (mutating the shared $all map by
	 *  reference — A3) and attach OUR measured rate to each item — a peer of mkt_rate_items. */
	private static function soc_rate_items( array &$all, $kind, $items ) {
		$hist = is_array( $all[ $kind ] ?? null ) ? $all[ $kind ] : [];
		$ck   = self::soc_counter( $kind );
		$unit = 'hour' === self::soc_window( $kind ) ? HOUR_IN_SECONDS : DAY_IN_SECONDS;
		$now  = time();
		$seen = [];
		foreach ( $items as &$it ) {
			$key = md5( (string) $it['url'] );
			$seen[ $key ] = true;
			$m = (int) ( $it[ $ck ] ?? 0 );
			$h = self::rate_sample( $hist[ $key ] ?? null, $m, $now, self::MKT_RATE_BASE );
			$hist[ $key ] = $h;
			$dt = (int) $h['t'] - (int) $h['t0'];
			if ( $dt >= self::MKT_RATE_MIN_DT ) {
				$it['rate'] = round( ( (int) $h['m'] - (int) $h['m0'] ) * $unit / $dt, 1 );
			} elseif ( ! empty( $it['ts'] ) ) {
				$it['rate'] = round( $m * $unit / max( $unit, $now - (int) $it['ts'] ), 1 ); // prior: counter ÷ age
			} else {
				$it['rate'] = 0.0;
			}
		}
		unset( $it );
		foreach ( $hist as $k => $h ) {
			if ( ! isset( $seen[ $k ] ) && ( $now - (int) ( $h['t'] ?? 0 ) ) > 7 * DAY_IN_SECONDS ) { unset( $hist[ $k ] ); }
		}
		$all[ $kind ] = $hist;
		usort( $items, static fn( $a, $b ) => $b['rate'] <=> $a['rate'] );
		return $items;
	}

	/** Reddit app-only OAuth bearer, held in a PER-REQUEST static — NEVER a transient/option. The
	 *  whole DB is public via the Data explorer, so a persisted bearer would be a world-readable
	 *  live secret. A cron tick is one PHP request, so this mints at most once per hourly tick
	 *  (well within Reddit's limits). '' while dormant.
	 *
	 *  PUBLIC because ArtaNews needs the same bearer for its Tier-2 context lookups, and a second
	 *  copy of this would mean two mints per tick, two user-agents to keep compliant, and two places
	 *  to get the "never persist it" rule wrong. The per-request static is what makes sharing free:
	 *  the first caller mints, the second gets the same string. */
	public static function reddit_token() { return self::soc_reddit_token(); }

	private static function soc_reddit_token() {
		static $tok = null;
		if ( is_string( $tok ) ) { return $tok; } // already resolved (minted or dormant) this request
		$tok = '';
		$id  = (string) Secrets::get( 'REDDIT_CLIENT_ID' );
		$sec = (string) Secrets::get( 'REDDIT_CLIENT_SECRET' );
		if ( '' === $id || '' === $sec ) { return $tok; } // dormant until creds exist
		$res = wp_remote_post( 'https://www.reddit.com/api/v1/access_token', [
			'timeout' => 12, 'redirection' => 0,
			'headers' => [ 'Authorization' => 'Basic ' . base64_encode( $id . ':' . $sec ) ],
			'body'    => [ 'grant_type' => 'client_credentials' ],
			'user-agent' => 'web:org.artaquest.crawler:v1.0 (by /u/artaquest)',
		] );
		if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) { return $tok; }
		$b   = json_decode( (string) wp_remote_retrieve_body( $res ), true );
		$tok = (string) ( $b['access_token'] ?? '' );
		return $tok;
	}

	/** Reddit — the curated SFW educational multi-subreddit's top-of-day, via the authenticated
	 *  Data API. [] while dormant / on any error → the tick keeps last-good. */
	private static function soc_reddit() {
		$tok = self::soc_reddit_token();
		if ( '' === $tok ) { return []; }
		$url = 'https://oauth.reddit.com/r/' . self::SOC_REDDIT_SUBS . '/top?t=day&limit=100&raw_json=1';
		$res = wp_remote_get( $url, [ 'timeout' => 15, 'redirection' => 0,
			'headers' => [ 'Authorization' => 'Bearer ' . $tok ],
			'user-agent' => 'web:org.artaquest.crawler:v1.0 (by /u/artaquest)' ] );
		if ( is_wp_error( $res ) ) { return []; }
		$code = (int) wp_remote_retrieve_response_code( $res );
		if ( 200 !== $code ) { return []; } // 401/429/5xx → fail-soft; the next tick (new request) re-mints
		$body = json_decode( (string) wp_remote_retrieve_body( $res ), true );
		$out  = [];
		foreach ( (array) ( $body['data']['children'] ?? [] ) as $c ) {
			$d = is_array( $c['data'] ?? null ) ? $c['data'] : [];
			if ( ! empty( $d['over_18'] ) || ! empty( $d['spoiler'] ) ) { continue; } // per-post safety backstop
			$title = trim( wp_strip_all_tags( (string) ( $d['title'] ?? '' ) ) );
			$perma = (string) ( $d['permalink'] ?? '' );
			if ( '' === $title || '' === $perma ) { continue; }
			$thumb = (string) ( $d['thumbnail'] ?? '' );
			$out[] = [
				'title'    => $title,
				'desc'     => mb_substr( trim( wp_strip_all_tags( (string) ( $d['selftext'] ?? '' ) ) ), 0, 400 ), // for the AI summary
				'by'       => 'r/' . (string) ( $d['subreddit'] ?? '' ),
				'url'      => 'https://www.reddit.com' . $perma,
				'img'      => wp_http_validate_url( $thumb ) ? $thumb : '',
				'ts'       => (int) ( $d['created_utc'] ?? 0 ),
				'ups'      => (int) ( $d['ups'] ?? 0 ),
				'comments' => (int) ( $d['num_comments'] ?? 0 ),
			];
		}
		return $out;
	}

	/** YouTube — the mostPopular chart scoped to the educational categories, via the Data API.
	 *  [] without YOUTUBE_API_KEY; a bad/over-quota category is skipped (mkt_get_json → null). */
	private static function soc_youtube() {
		$key = (string) Secrets::get( 'YOUTUBE_API_KEY' );
		if ( '' === $key ) { return []; } // dormant without the key
		$out = [];
		foreach ( self::SOC_YT_CATEGORIES as $cat ) {
			$url = add_query_arg( [
				'part'            => 'snippet,statistics',
				'chart'           => 'mostPopular',
				'regionCode'      => 'US',
				'videoCategoryId' => $cat,
				'maxResults'      => 20,
				'key'             => $key,
			], 'https://www.googleapis.com/youtube/v3/videos' );
			$body = self::mkt_get_json( $url, 15 ); // 1 quota unit/call; null on non-200 → skip category
			foreach ( (array) ( $body['items'] ?? [] ) as $v ) {
				$id = trim( (string) ( $v['id'] ?? '' ) );
				$sn = is_array( $v['snippet'] ?? null ) ? $v['snippet'] : [];
				$st = is_array( $v['statistics'] ?? null ) ? $v['statistics'] : [];
				$title = trim( wp_strip_all_tags( (string) ( $sn['title'] ?? '' ) ) );
				if ( '' === $id || '' === $title ) { continue; }
				$out[] = [
					'title'    => $title,
					'desc'     => mb_substr( trim( wp_strip_all_tags( (string) ( $sn['description'] ?? '' ) ) ), 0, 400 ), // for the AI summary
					'by'       => (string) ( $sn['channelTitle'] ?? '' ),
					'url'      => 'https://www.youtube.com/watch?v=' . rawurlencode( $id ),
					'img'      => (string) ( $sn['thumbnails']['medium']['url'] ?? '' ),
					'ts'       => (int) ( strtotime( (string) ( $sn['publishedAt'] ?? '' ) ) ?: 0 ),
					'views'    => (int) ( $st['viewCount'] ?? 0 ),   // API returns a STRING numeric
					'comments' => isset( $st['commentCount'] ) ? (int) $st['commentCount'] : 0,
				];
			}
		}
		return $out;
	}

	/** Instagram — the Graph API Hashtag Search → top_media for a curated set of educational
	 *  hashtags (like_count is the counter). Gated on a business account: IG_ACCESS_TOKEN +
	 *  IG_USER_ID. [] while dormant. Hashtag→id lookups are cached (stable ids; the API caps unique
	 *  hashtags at 30 per 7 days, so the fixed SOC_EDU_TAGS set stays far under). */
	private static function soc_instagram() {
		$tok = (string) Secrets::get( 'IG_ACCESS_TOKEN' );
		$uid = (string) Secrets::get( 'IG_USER_ID' );
		if ( '' === $tok || '' === $uid ) { return []; } // dormant without a business token
		$api  = 'https://graph.facebook.com/v21.0/';
		$out  = [];
		$seen = [];
		foreach ( self::SOC_EDU_TAGS as $tag ) {
			$hid = get_transient( 'aq_ig_tag_' . $tag );
			if ( ! $hid ) {
				$s = self::mkt_get_json( $api . 'ig_hashtag_search?' . http_build_query( [ 'user_id' => $uid, 'q' => $tag, 'access_token' => $tok ] ) );
				$hid = (string) ( $s['data'][0]['id'] ?? '' );
				if ( '' === $hid ) { continue; }
				set_transient( 'aq_ig_tag_' . $tag, $hid, WEEK_IN_SECONDS );
			}
			$m = self::mkt_get_json( $api . $hid . '/top_media?' . http_build_query( [
				'user_id' => $uid, 'access_token' => $tok, 'limit' => 5,
				'fields'  => 'id,caption,permalink,like_count,comments_count,timestamp,media_type,media_url,thumbnail_url',
			] ), 15 );
			foreach ( (array) ( $m['data'] ?? [] ) as $p ) {
				$link = (string) ( $p['permalink'] ?? '' );
				if ( '' === $link || ! wp_http_validate_url( $link ) || isset( $seen[ $link ] ) ) { continue; }
				$seen[ $link ] = true;
				$cap = trim( wp_strip_all_tags( (string) ( $p['caption'] ?? '' ) ) );
				$img = (string) ( ( 'VIDEO' === ( $p['media_type'] ?? '' ) ? ( $p['thumbnail_url'] ?? '' ) : ( $p['media_url'] ?? '' ) ) );
				$out[] = [
					'title'    => '' !== $cap ? wp_html_excerpt( $cap, 90, '…' ) : ( '#' . $tag ),
					'by'       => '#' . $tag,
					'url'      => $link,
					'img'      => wp_http_validate_url( $img ) ? $img : '',
					'ts'       => (int) ( strtotime( (string) ( $p['timestamp'] ?? '' ) ) ?: 0 ),
					'likes'    => (int) ( $p['like_count'] ?? 0 ),
					'comments' => (int) ( $p['comments_count'] ?? 0 ),
				];
			}
		}
		return $out;
	}

	/** LinkedIn — DORMANT. No public/trending endpoint exists; every /rest/* is 401 and robots.txt
	 *  bans automation, so this NEVER scrapes and stays out of soc_kinds() until a partner
	 *  LINKEDIN_ACCESS_TOKEN is added. If ever activated it can read only the Learning catalogue
	 *  (no public engagement counter exists, so it would rank by recency, not a Δ-rate). */
	private static function soc_linkedin() {
		$tok = (string) Secrets::get( 'LINKEDIN_ACCESS_TOKEN' );
		if ( '' === $tok ) { return []; } // dormant by design
		$res = wp_remote_get( 'https://api.linkedin.com/rest/learningAssets?assetType=(COURSE,LEARNING_PATH)', [
			'timeout' => 15, 'redirection' => 0,
			'headers' => [ 'Authorization' => 'Bearer ' . $tok, 'LinkedIn-Version' => gmdate( 'Ym' ) ],
			'user-agent' => 'ArtaQuest/1.0 (+https://artaquest.com)',
		] );
		if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) { return []; }
		$body = json_decode( (string) wp_remote_retrieve_body( $res ), true );
		$out  = [];
		foreach ( (array) ( $body['elements'] ?? [] ) as $a ) {
			$title = trim( (string) ( $a['title']['value'] ?? ( is_string( $a['title'] ?? null ) ? $a['title'] : '' ) ) );
			$url   = (string) ( $a['webLaunchUrl'] ?? $a['launchUrl'] ?? '' );
			if ( '' === $title || ! wp_http_validate_url( $url ) ) { continue; }
			$out[] = [ 'title' => $title, 'by' => 'LinkedIn Learning', 'url' => $url, 'img' => '', 'ts' => 0, 'views' => 0 ];
		}
		return $out;
	}

	/**
	 * The pool: open-access, PDF-backed, non-retracted articles from the two windows, one
	 * 200-row citation-ranked page each (2 requests, hard-bounded), deduped, then (cron only)
	 * PDF-liveness-checked. Returns [] on total failure — the caller serves last-good.
	 */
	private static function scholar_fetch_openalex( $verify ) {
		$select = 'id,doi,display_name,cited_by_count,publication_date,primary_topic,best_oa_location,authorships,abstract_inverted_index';
		$works  = [];
		$seen   = [];
		foreach ( [ self::SCHOLAR_DAYS, self::SCHOLAR_DAYS_HOT ] as $days ) {
			$filter = implode( ',', [
				'type:article',       // not datasets/paratext/editorials
				'is_paratext:false',  // kills the whole-journal records (see the junk gate above)
				'is_retracted:false', // a highly-cited retraction must never headline the rail
				'has_doi:true',
				'is_oa:true',
				'has_fulltext:true',  // OpenAlex has actually ingested the text — a strong real-paper signal
				'cited_by_count:>' . ( self::SCHOLAR_MIN_CITES - 1 ),
				'from_publication_date:' . gmdate( 'Y-m-d', time() - $days * DAY_IN_SECONDS ),
			] );
			$url = add_query_arg( [
				'filter'   => $filter,
				'sort'     => 'cited_by_count:desc',
				'per-page' => 200,
				'select'   => $select,
				'mailto'   => 'support@artaquest.org', // OpenAlex's polite pool — identifies us, no key needed
			], 'https://api.openalex.org/works' );
			$res = wp_remote_get( $url, [ 'timeout' => 12, 'redirection' => 2, 'user-agent' => 'ArtaQuest/1.0 (+https://artaquest.com; support@artaquest.org)' ] );
			if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) { continue; }
			$body = json_decode( (string) wp_remote_retrieve_body( $res ), true );
			if ( ! is_array( $body['results'] ?? null ) ) { continue; }
			foreach ( $body['results'] as $w ) {
				$row = self::scholar_row( $w );
				if ( ! $row ) { continue; }
				// Dedupe across the two windows AND across preprint/publisher doubles that
				// carry distinct ids — the normalised title catches what the id can't.
				$keys = [ (string) ( $w['id'] ?? '' ), preg_replace( '/[^a-z0-9]/', '', strtolower( $row['title'] ) ) ];
				if ( isset( $seen[ $keys[0] ] ) || isset( $seen[ $keys[1] ] ) ) { continue; }
				$seen[ $keys[0] ] = $seen[ $keys[1] ] = true;
				$works[] = $row;
			}
		}
		return ( $works && $verify ) ? self::scholar_verify_pdfs( $works ) : $works;
	}

	/**
	 * Parallel HEAD over the top-SCHOLAR_VERIFY rows by provisional rate (the rows that will
	 * actually render), dropping only the hard-dead: 404/410, or a host that doesn't resolve/
	 * connect. Bot-blocks (403/405) and slow hosts pass — see the header note. Best-effort:
	 * any failure of the CHECK keeps the row.
	 */
	private static function scholar_verify_pdfs( $works ) {
		if ( ! class_exists( '\WpOrg\Requests\Requests' ) ) { return $works; }
		$rate = [];
		foreach ( $works as $w ) { $rate[] = self::scholar_rate( (int) $w['cites'], (string) $w['date'] ); }
		array_multisort( $rate, SORT_DESC, SORT_NUMERIC, $works );
		$reqs = [];
		foreach ( array_slice( $works, 0, self::SCHOLAR_VERIFY, true ) as $i => $w ) {
			$reqs[ $i ] = [ 'url' => $w['pdf'], 'type' => 'HEAD' ];
		}
		$dead = [];
		foreach ( array_chunk( $reqs, 24, true ) as $chunk ) {
			try {
				$res = \WpOrg\Requests\Requests::request_multiple( $chunk, [
					'timeout'         => 6,
					'connect_timeout' => 4,
					'follow_redirects'=> true,
					'redirects'       => 3,
					'useragent'       => 'ArtaQuest/1.0 (+https://artaquest.com; support@artaquest.org)',
				] );
			} catch ( \Throwable $e ) { continue; } // the check must never cost us the pool
			foreach ( $res as $i => $r ) {
				if ( $r instanceof \WpOrg\Requests\Response ) {
					if ( in_array( (int) $r->status_code, [ 404, 410 ], true ) ) { $dead[ $i ] = true; }
				} elseif ( $r instanceof \Throwable && preg_match( '/resolve|connect/i', $r->getMessage() ) ) {
					$dead[ $i ] = true; // no such host ≠ a slow host — only the former is a dead link
				}
			}
		}
		return array_values( array_diff_key( $works, $dead ) );
	}

	/** One OpenAlex work → the rail's row, or null if it has no reachable PDF (the operator's gate). */
	private static function scholar_row( $w ) {
		$loc = is_array( $w['best_oa_location'] ?? null ) ? $w['best_oa_location'] : [];
		$pdf = (string) ( $loc['pdf_url'] ?? '' );
		$title = trim( (string) ( $w['display_name'] ?? '' ) );
		if ( '' === $pdf || '' === $title || ! wp_http_validate_url( $pdf ) ) { return null; }
		$topic  = is_array( $w['primary_topic'] ?? null ) ? $w['primary_topic'] : [];
		$people = is_array( $w['authorships'] ?? null ) ? $w['authorships'] : [];
		$first  = (string) ( $people[0]['author']['display_name'] ?? '' );
		return [
			'title'  => $title,
			'desc'   => self::openalex_abstract( $w['abstract_inverted_index'] ?? null ), // (A4) fed to the AI summary, STRIPPED before the pool is stored
			'author' => $first,
			'others' => max( 0, count( $people ) - 1 ), // "+7" — the card never lists 40 names
			'cites'  => (int) ( $w['cited_by_count'] ?? 0 ),
			'date'   => (string) ( $w['publication_date'] ?? '' ),
			'topic'  => (string) ( $topic['display_name'] ?? '' ),
			'field'  => (string) ( $topic['field']['display_name'] ?? '' ),
			'venue'  => (string) ( $loc['source']['display_name'] ?? '' ),
			'pdf'    => $pdf,
			'doi'    => (string) ( $w['doi'] ?? '' ),
		];
	}

	/** Reconstruct a paper's abstract from OpenAlex's inverted index (word → [positions]). Bounded
	 *  to 600 chars — it exists only to give the AI summariser real content, never to be stored. */
	private static function openalex_abstract( $inv ) {
		if ( ! is_array( $inv ) || ! $inv ) { return ''; }
		$pos = [];
		foreach ( $inv as $word => $ixs ) {
			foreach ( (array) $ixs as $p ) { $pos[ (int) $p ] = (string) $word; }
		}
		ksort( $pos );
		return mb_substr( trim( implode( ' ', $pos ) ), 0, 600 );
	}

	/** The pool grouped into trends: VELOCITY summed per topic, thinly-evidenced topics dropped.
	 *  Expects the rate-ranked rows from scholar_assemble (each carrying its computed 'rate'). */
	private static function scholar_topics( $works ) {
		$by = [];
		foreach ( $works as $w ) {
			$name = (string) $w['topic'];
			if ( '' === $name ) { continue; }
			if ( ! isset( $by[ $name ] ) ) { $by[ $name ] = [ 'name' => $name, 'field' => $w['field'], 'rate' => 0.0, 'cites' => 0, 'papers' => 0, 'top' => [] ]; }
			$by[ $name ]['rate']   += (float) ( $w['rate'] ?? 0 );
			$by[ $name ]['cites']  += $w['cites'];
			$by[ $name ]['papers'] += 1;
			// The pool arrives rate-ranked, so the first three kept ARE the topic's top three.
			// No pdf link — the AI summary (or the title) is what shows.
			if ( count( $by[ $name ]['top'] ) < 3 ) {
				$by[ $name ]['top'][] = [ 'title' => $w['title'], 'cites' => $w['cites'], 'summary' => (string) ( $w['summary'] ?? '' ) ];
			}
		}
		$by = array_values( array_filter( $by, static fn( $t ) => $t['papers'] >= self::SCHOLAR_MIN_PAPERS ) );
		usort( $by, static fn( $a, $b ) => $b['rate'] <=> $a['rate'] ?: $b['cites'] <=> $a['cites'] );
		$by = array_slice( $by, 0, self::SCHOLAR_TOPICS );
		foreach ( $by as &$t ) { $t['rate'] = round( $t['rate'], 1 ); }
		unset( $t );
		return $by;
	}

	/** GET /climate/daily — data-shelf rail: the NCEP/NCAR Reanalysis-1 daily-mean 2 m air
	 *  temperature record, 1948→, reduced to the cosine-latitude-weighted global mean plus five
	 *  latitude bands (°C, 6 decimals, leap days included). Raw CSV, CC BY 4.0 (source NOAA PSL;
	 *  the reduction code is published in the platform's climate dataset notebook, which also
	 *  proves the file regenerates byte-for-byte from the 78 public NOAA yearly files). The file
	 *  is operator-provisioned at uploads/aq-data/climate-daily.csv — it is a fixed historical
	 *  record, extended at most yearly, not a live feed. The relay serves it to every notebook
	 *  as data/climate-daily.csv. */
	public static function climate_daily() {
		$path = wp_get_upload_dir()['basedir'] . '/aq-data/climate-daily.csv';
		if ( ! is_readable( $path ) ) { return Rest::err( 'not_provisioned', 'The climate rail file is missing', 404 ); }
		header( 'Content-Type: text/csv; charset=utf-8' );
		header( 'Cache-Control: public, max-age=86400, s-maxage=86400' );
		readfile( $path );
		exit;
	}

	/** GET /citations/quarterly — data-shelf rail: citations per research subfield per QUARTER
	 *  over the entire scholarly record (usable 1500s→, dense from the early 1800s; snapshot
	 *  2026-06-26). Derived from the full OpenAlex works snapshot (510.4M records, CC0): per
	 *  (subfield, year, quarter) the works published, the lifetime citations they earned
	 *  (cited_by_sum), and the citations RECEIVED that quarter — every one of 3.005B reference
	 *  edges dated by the CITING work's publication quarter. quarter 0 = year-only date
	 *  precision (OpenAlex stores year-only dates as Jan 1; ~half the corpus at every era) —
	 *  never a calendar Q1. Regeneration: analysis/citations/{harvest_openalex,build_quarterly}.py.
	 *  Operator-provisioned at uploads/aq-data/citations-quarterly.csv — a fixed snapshot
	 *  extended at most quarterly, not a live feed. The relay serves it to every notebook as
	 *  data/citations-quarterly.csv. */
	public static function citations_quarterly() {
		$path = wp_get_upload_dir()['basedir'] . '/aq-data/citations-quarterly.csv';
		if ( ! is_readable( $path ) ) { return Rest::err( 'not_provisioned', 'The citations rail file is missing', 404 ); }
		header( 'Content-Type: text/csv; charset=utf-8' );
		header( 'Cache-Control: public, max-age=86400, s-maxage=86400' );
		readfile( $path );
		exit;
	}

	/** GET /citations/yearly — data-shelf rail: the quarterly citations rail summed to YEARS, so
	 *  the year-only date-precision bucket (quarter 0) folds naturally into each year and the whole
	 *  record 1000→2026 becomes usable at one grain. Per (subfield, year): works published, lifetime
	 *  cited_by_sum, and citations RECEIVED that year (3.005B edges dated by the citing work).
	 *  A compact ~5 MB companion to citations/quarterly — small enough for the offline relay to
	 *  provision reliably. Operator-provisioned at uploads/aq-data/citations-yearly.csv (fixed
	 *  snapshot 2026-06-26, CC0). Served to every notebook as data/citations-yearly.csv. */
	public static function citations_yearly() {
		$path = wp_get_upload_dir()['basedir'] . '/aq-data/citations-yearly.csv';
		if ( ! is_readable( $path ) ) { return Rest::err( 'not_provisioned', 'The citations rail file is missing', 404 ); }
		header( 'Content-Type: text/csv; charset=utf-8' );
		header( 'Cache-Control: public, max-age=86400, s-maxage=86400' );
		readfile( $path );
		exit;
	}

	// ── Certificates ────────────────────────────────────────────────────────
	/**
	 * A certificate's verification code: short, deterministic, and UNFORGEABLE. The whole DB is public
	 * (radical transparency), so a code over just the public (user, course) ids could be recomputed by
	 * anyone — we mix in the server-side auth salt (never in the DB) so only ArtaQuest can mint a valid
	 * code, while the public verify endpoint can still recompute + confirm it. HMAC in spirit.
	 */
	public static function cert_code( $uid, $cid ) {
		return strtoupper( substr( hash_hmac( 'sha256', (int) $uid . '|' . (int) $cid, wp_salt( 'auth' ) ), 0, 10 ) );
	}

	/** The earned-certificate payload, shared by the owner view and the public verification view. */
	private static function cert_payload( $uid, $cid, $title ) {
		$u    = get_userdata( $uid );
		$code = self::cert_code( $uid, $cid );
		$m    = Economy::user_medal( $cid, $uid );
		return [
			'earned'     => true,
			'valid'      => true,
			'course'     => $title,
			'course_id'  => (int) $cid,
			'learner'    => $u ? $u->display_name : '',
			'date_ts'    => (int) get_user_meta( $uid, 'aq_cert_' . $cid, true ) ?: Data::now(),
			'code'       => $code,
			'verify_url' => '/verify/?c=' . (int) $cid . '&u=' . (int) $uid . '&k=' . $code,
			// Shareable link (2026-06-12): carries the signed params, so the theme unfurls it with a
			// per-cert OG card (cert-og below) — LinkedIn-able proof of the achievement.
			'share_url'  => '/certificate/?course=' . (int) $cid . '&c=' . (int) $cid . '&u=' . (int) $uid . '&k=' . $code,
			'medal'      => $m['medal'],
			'rank'       => $m['rank'],
			'votes'      => $m['votes'],
			'prize'      => $m['prize'],
			'reward'     => $m['reward'],
		];
	}

	public static function certificate( $req ) {
		$uid = Rest::uid();
		$cid = Rest::pint( $req, 'course', 0 );
		$c   = Data::one( 'SELECT id, title, slug FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		if ( ! $c ) { return Rest::err( 'not_found', 'Course not found', 404 ); }
		$threshold = (int) Learn::PASS_PCT;
		$pct = (int) Data::col( 'SELECT pct FROM ' . Data::t( 'aq_enroll' ) . ' WHERE user_id = %d AND course_id = %d', [ $uid, $cid ] );
		if ( $pct >= $threshold ) {
			return self::cert_payload( $uid, (int) $c['id'], $c['title'] );
		}
		return [ 'earned' => false, 'course' => $c['title'], 'progress' => $pct, 'threshold' => $threshold, 'course_url' => '/courses/' . $c['slug'] ];
	}

	/**
	 * Public certificate verification — /aq/v1/cert-verify?c=&u=&k=. Anyone holding a printed/shared
	 * certificate can confirm it is genuine: we recompute the code from the server salt (so a forged
	 * code can't pass) and confirm the named holder is actually certified (pct ≥ 100). Returns the full
	 * cert payload (valid=true) on success, or { valid:false } otherwise. GET → public + CDN-cacheable.
	 */
	public static function cert_verify( $req ) {
		$cid = Rest::pint( $req, 'c', 0 );
		$uid = Rest::pint( $req, 'u', 0 );
		$k   = strtoupper( preg_replace( '/[^A-Za-z0-9]/', '', (string) Rest::p( $req, 'k', '' ) ) );
		$bad = [ 'valid' => false ];
		if ( ! $cid || ! $uid || ! $k || ! hash_equals( self::cert_code( $uid, $cid ), $k ) ) { return $bad; }
		$c = Data::one( 'SELECT id, title FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		if ( ! $c ) { return $bad; }
		$pct = (int) Data::col( 'SELECT pct FROM ' . Data::t( 'aq_enroll' ) . ' WHERE user_id = %d AND course_id = %d', [ $uid, $cid ] );
		if ( $pct < (int) Learn::PASS_PCT || ! get_userdata( $uid ) ) { return $bad; }
		return self::cert_payload( $uid, (int) $c['id'], $c['title'] );
	}

	/**
	 * GET /emblem?seed=&label= — a deterministic, self-hosted SVG profile emblem for a /topics
	 * typology or one of its groups. Brand-pure (gold/blue/space only — never a third hue), distinct
	 * per seed, never 404s and needs NO third party — so every topic and group can carry a clean
	 * profile picture even when no canonical photo exists (an abstract or empirical group, a concept).
	 * Recognizable real-world entities (characters, public figures, branded works) should still use a
	 * real canonical image; this emblem is the universal fallback ArtaDev/ArtaCycle point `image` at,
	 * and the Topics/Profile UIs fall back to it for any group without an explicit image. Public +
	 * long-cacheable: the emblem for a given (seed,label) is immutable.
	 */
	public static function emblem( $req ) {
		$seed  = (string) Rest::p( $req, 'seed', '' );
		$label = trim( wp_strip_all_tags( (string) Rest::p( $req, 'label', $seed ) ) );
		if ( $label === '' ) { $label = '?'; }

		// Initials: first letter of the first + last word (letters/digits only), max 2 chars.
		preg_match_all( '/[\p{L}\p{N}]+/u', $label, $mm );
		$words    = ! empty( $mm[0] ) ? $mm[0] : [ $label ];
		$initials = mb_strtoupper( mb_substr( $words[0], 0, 1 ) );
		if ( count( $words ) > 1 ) { $initials .= mb_strtoupper( mb_substr( end( $words ), 0, 1 ) ); }
		$initials = mb_substr( $initials, 0, 2 );

		$h     = crc32( $seed !== '' ? $seed : $label );
		$fsize = mb_strlen( $initials ) > 1 ? 64 : 78;
		// Background-less, theme-adaptive emblem (ticket #97). The old baked dark/blue gradient DISC
		// looked wrong on a light surface ("invisible or look wrong on light backgrounds"); there is
		// now no opaque background at all — just a thin brand ring + the initials, so it reads cleanly
		// on the dark cosmos AND a light canvas (matching the background-less topic-art icons). An
		// <img>-loaded SVG honours an embedded @media, so — exactly like the favicon — we deepen the
		// brand accent to a contrast-safe value on a light background (gold #E8B923 is only ~1.8:1 on
		// white). One brand identity per seed: gold (the Why) or blue (the How) — never a third hue.
		// Presentation attrs are the dark-scheme fallback if <style> is dropped; every colour is a
		// static literal (no user input), so nothing below needs escaping.
		$gold  = ( $h & 1 ) === 1;
		$dark  = $gold ? '#E8B923' : '#3F6BFF';   // reads on the dark cosmos
		$light = $gold ? '#9A6E00' : '#2352E8';   // contrast-safe on a light canvas
		$svg   = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160" role="img" aria-label="' . esc_attr( $label ) . '">'
			. '<defs><style>.em-ring{stroke:' . $dark . '}.em-ink{fill:' . $dark . '}'
			. '@media (prefers-color-scheme:light){.em-ring{stroke:' . $light . '}.em-ink{fill:' . $light . '}}</style></defs>'
			. '<circle class="em-ring" cx="80" cy="80" r="72" fill="none" stroke="' . $dark . '" stroke-width="6" stroke-opacity="0.9"/>'
			. '<text class="em-ink" x="80" y="80" dy=".34em" text-anchor="middle" font-family="Inter,system-ui,Segoe UI,Roboto,sans-serif" '
			. 'font-weight="700" font-size="' . $fsize . '" fill="' . $dark . '">' . esc_html( $initials ) . '</text></svg>';

		header( 'Content-Type: image/svg+xml; charset=utf-8' );
		// 30 days; the emblem markup is stable per (seed,label). A redesign (like this one) is delivered
		// to returning visitors via the ICON_REV query the client appends (see emblemUrl/resolveImage),
		// since this immutable response can't otherwise be refreshed at a stable URL.
		header( 'Cache-Control: public, max-age=2592000, s-maxage=2592000, immutable' );
		echo $svg; // fully escaped above
		exit;
	}

	/**
	 * GET /cert-og?c=&u=&k= — a 1200×630 PNG share card for ONE verified certificate (the signed k
	 * is checked exactly like cert_verify, so nobody can render someone else's achievement). Drawn
	 * with GD on the brand ground (gold + blue only); uses a system TTF when one exists, else GD's
	 * built-in font. Binary response: emits headers + the image and exits (REST returns JSON
	 * otherwise). Public + long-cacheable — the cert is immutable once earned.
	 */
	public static function cert_og( $req ) {
		$cid = Rest::pint( $req, 'c', 0 );
		$uid = Rest::pint( $req, 'u', 0 );
		$k   = strtoupper( preg_replace( '/[^A-Za-z0-9]/', '', (string) Rest::p( $req, 'k', '' ) ) );
		$fail = function () { wp_safe_redirect( get_theme_file_uri( 'assets/images/og-image.png' ) ?: home_url( '/' ), 302 ); exit; };
		if ( ! function_exists( 'imagecreatetruecolor' ) ) { $fail(); }
		if ( ! $cid || ! $uid || ! $k || ! hash_equals( self::cert_code( $uid, $cid ), $k ) ) { $fail(); }
		$c = Data::one( 'SELECT title FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ $cid ] );
		$u = get_userdata( $uid );
		$pct = (int) Data::col( 'SELECT pct FROM ' . Data::t( 'aq_enroll' ) . ' WHERE user_id = %d AND course_id = %d', [ $uid, $cid ] );
		if ( ! $c || ! $u || $pct < (int) Learn::PASS_PCT ) { $fail(); }

		$W = 1200; $H = 630;
		$im   = imagecreatetruecolor( $W, $H );
		$bg   = imagecolorallocate( $im, 6, 18, 30 );     // space #06121E
		$gold = imagecolorallocate( $im, 232, 185, 35 );  // yang #E8B923
		$blue = imagecolorallocate( $im, 35, 82, 232 );   // yin  #2352E8
		$ink  = imagecolorallocate( $im, 240, 244, 250 );
		$dim  = imagecolorallocate( $im, 150, 160, 175 );
		imagefilledrectangle( $im, 0, 0, $W, $H, $bg );
		imagefilledrectangle( $im, 0, $H - 14, $W, $H, $gold );    // gold base band
		imagefilledrectangle( $im, 0, $H - 20, $W, $H - 14, $blue ); // blue rule
		// TTF when the host has one (Atomic usually ships DejaVu); GD's bitmap font as the fallback.
		$ttf = null;
		foreach ( [ '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf' ] as $f ) {
			if ( file_exists( $f ) ) { $ttf = $f; break; }
		}
		$name   = mb_strimwidth( $u->display_name, 0, 40, '…' );
		$course = mb_strimwidth( (string) $c['title'], 0, 70, '…' );
		if ( $ttf ) {
			imagettftext( $im, 22, 0, 80, 120, $gold, $ttf, 'ARTAQUEST · CERTIFICATE OF COMPLETION' );
			imagettftext( $im, 56, 0, 80, 270, $ink, $ttf, $name );
			imagettftext( $im, 30, 0, 80, 380, $gold, $ttf, $course );
			imagettftext( $im, 18, 0, 80, 470, $dim, $ttf, 'Watched every video, joined every discussion — verified at artaquest.com' );
		} else {
			imagestring( $im, 5, 80, 90, 'ARTAQUEST  |  CERTIFICATE OF COMPLETION', $gold );
			// the bitmap font is small — scale the name up by drawing on a small canvas and resampling
			$tmp = imagecreatetruecolor( 400, 24 ); imagefilledrectangle( $tmp, 0, 0, 400, 24, $bg );
			imagestring( $tmp, 5, 0, 4, substr( $u->display_name, 0, 38 ), $ink );
			imagecopyresampled( $im, $tmp, 80, 180, 0, 0, 1000, 60, 400, 24 );
			imagedestroy( $tmp );
			imagestring( $im, 5, 80, 300, substr( (string) $c['title'], 0, 90 ), $gold );
			imagestring( $im, 4, 80, 360, 'Watched every video, joined every discussion - verified at artaquest.com', $dim );
		}
		header( 'Content-Type: image/png' );
		header( 'Cache-Control: public, max-age=604800, s-maxage=604800' ); // immutable once earned
		imagepng( $im, null, 9 );
		imagedestroy( $im );
		exit;
	}

	// ── Open datasets (2026-06-12): the public DB, packaged ─────────────────────────────────
	// The explorer already serves every row; these are the same tables as downloadable NDJSON.gz
	// snapshots — research-ready, citeable, and a de-facto off-site backup once mirrored. Built
	// nightly by the aq_dataset cron; 30 daily files kept, first-of-month kept for a year.

	/** Cron (daily): write uploads/datasets/artaquest-YYYY-MM-DD.ndjson.gz — one JSON line per row,
	 *  every aq_* table, streamed in 500-row pages so a million-row table never loads into memory. */
	public static function dataset_build() {
		global $wpdb;
		$dir = trailingslashit( wp_upload_dir()['basedir'] ) . 'datasets';
		if ( ! is_dir( $dir ) && ! wp_mkdir_p( $dir ) ) { return; }
		$file = $dir . '/artaquest-' . gmdate( 'Y-m-d' ) . '.ndjson.gz';
		if ( file_exists( $file ) ) { return; } // idempotent per day
		$gz = gzopen( $file . '.tmp', 'wb6' );
		if ( ! $gz ) { return; }
		$tables = $wpdb->get_col( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $wpdb->prefix . 'aq_' ) . '%' ) );
		// THE SNAPSHOT IS THE EXPLORER, PACKAGED — so it must withhold exactly what the explorer
		// withholds. It did not: it globbed every aq_* table and wrote every row verbatim, which put
		// members' shipping addresses (aq_order_ship) and their private book-inspiration uploads
		// (aq_doc_sources) into a publicly downloadable nightly file, and skipped redact_row so
		// live credential verifiers went with them. A promise kept on one surface and broken on
		// another is not a promise.
		$private = array_map( fn( $x ) => $wpdb->prefix . $x, self::PRIVATE_TABLES );
		foreach ( (array) $tables as $t ) {
			if ( in_array( (string) $t, $private, true ) ) { continue; }
			$name = preg_replace( '/^' . preg_quote( $wpdb->prefix, '/' ) . '/', '', (string) $t );
			$last = 0;
			// Keyset over the first column (every aq_* table leads with an integer PK or a composite
			// whose first column is indexed) — falls back to a bounded single page if that fails.
			$pk = $wpdb->get_col( "SHOW COLUMNS FROM `$t`" )[0] ?? 'id';
			for ( $i = 0; $i < 10000; $i++ ) {
				$rows = $wpdb->get_results( $wpdb->prepare( "SELECT * FROM `$t` WHERE `$pk` > %d ORDER BY `$pk` ASC LIMIT 500", $last ), ARRAY_A );
				if ( ! $rows ) { break; }
				foreach ( $rows as $r ) {
					$last = max( $last, (int) ( $r[ $pk ] ?? 0 ) );
					gzwrite( $gz, wp_json_encode( [ 'table' => $name ] + self::redact_row( (string) $t, $r ) ) . "\n" );
				}
				if ( count( $rows ) < 500 ) { break; }
			}
		}
		gzclose( $gz );
		rename( $file . '.tmp', $file ); // atomic publish
		// Retention: 30 daily snapshots; first-of-month survive 1 year.
		foreach ( glob( $dir . '/artaquest-*.ndjson.gz' ) ?: [] as $f ) {
			if ( ! preg_match( '/artaquest-(\d{4})-(\d{2})-(\d{2})\.ndjson\.gz$/', $f, $m ) ) { continue; }
			$age = time() - gmmktime( 0, 0, 0, (int) $m[2], (int) $m[3], (int) $m[1] );
			if ( ( $m[3] !== '01' && $age > 30 * DAY_IN_SECONDS ) || $age > 366 * DAY_IN_SECONDS ) { @unlink( $f ); }
		}
	}

	/** GET /datasets — the published snapshot files (name, bytes, date, url). Public. */
	public static function datasets( $req ) {
		$up  = wp_upload_dir();
		$dir = trailingslashit( $up['basedir'] ) . 'datasets';
		// Served from THIS ORIGIN. These files are globbed off our own disk two lines below, so the
		// origin URL is the one address guaranteed to match what we just listed. The HuggingFace branch
		// that used to sit here (2026-07-26 → 2026-08-02) named a repo whose contents this function had
		// no way to check: it listed local files and handed out remote links, so a snapshot that failed
		// to reach HF was advertised as a 404. HuggingFace is purged entirely now (operator 2026-08-02),
		// and heavy data lives in public Kaggle datasets under `artafather` — but a Kaggle link would
		// reintroduce exactly the same list-here/serve-there split, so the snapshots stay on the origin
		// until something actually mirrors them and can report that it did.
		$url = trailingslashit( $up['baseurl'] ) . 'datasets';
		$out = [];
		foreach ( glob( $dir . '/artaquest-*.ndjson.gz' ) ?: [] as $f ) {
			$out[] = [ 'name' => basename( $f ), 'bytes' => (int) filesize( $f ), 'date' => substr( basename( $f ), 10, 10 ), 'url' => $url . '/' . basename( $f ) ];
		}
		usort( $out, fn( $a, $b ) => strcmp( $b['date'], $a['date'] ) );
		return [ 'items' => $out, 'license' => 'Public by design (radical transparency) — cite artaquest.com', 'format' => 'NDJSON (one row per line, `table` field names the source table), gzip' ];
	}

	// ── Monthly reserve audit (2026-06-12): publish the full-reserve receipts ───────────────

	/** Hourly (rides aq_watchdog): the first tick of each new month appends a snapshot of the gold
	 *  reserve — issued coins, backing mg, ratio, spot — to the public audit trail. Append-only. */
	public static function reserve_audit_tick() {
		$audits = get_option( 'aq_reserve_audits', [] );
		if ( ! is_array( $audits ) ) { $audits = []; }
		$month = gmdate( 'Y-m' );
		foreach ( $audits as $a ) { if ( ( $a['month'] ?? '' ) === $month ) { return; } }
		$issued  = Economy::counter( 'coins_issued' );
		$backing = Economy::backing_mg();
		$audits[] = [
			'month'      => $month,
			'ts'         => time(),
			'issued_coins' => (int) $issued,
			'backing_mg' => (int) $backing,
			'ratio'      => $issued > 0 ? round( $backing / $issued, 4 ) : 1.0,
			'spot_oz_usd' => (float) get_option( 'aq_gold_spot_oz_usd', 0 ),
		];
		update_option( 'aq_reserve_audits', array_slice( $audits, -60 ), false ); // 5 years of months
	}

	/** GET /reserve/audits — the append-only monthly audit trail (also visible raw in /data/). */
	public static function reserve_audits( $req ) {
		$a = get_option( 'aq_reserve_audits', [] );
		return [ 'items' => is_array( $a ) ? array_reverse( $a ) : [], 'note' => 'Snapshotted on the first tick of each month — issued coins vs milligrams of gold held. The live figures are on /reserve/.' ];
	}

	// ── Course checkout — charges the entry fee via the canonical enrol primitive ───────────
	public static function course_checkout( $req ) {
		$uid  = Rest::uid();
		$slug = sanitize_title( (string) Rest::p( $req, 'slug', '' ) );

		// ── Cart checkout: a basket of DONATIONS (the cart only ever holds donations — courses enrol
		//    off-cart with coins). With Stripe LIVE we create a hosted Checkout Session and redirect
		//    (fulfilment happens on return in stripe_verify); without Stripe we record immediately
		//    (pre-prod). Fiat is the foundation's single currency, so cents map 1:1 to the ledger. ──
		if ( $slug === '' ) {
			$donations = (array) Rest::p( $req, 'donations', [] );
			if ( ! $donations ) { return Rest::err( 'empty_cart', 'Your cart is empty.', 400 ); }
			// Normalise to [ { c: cents, g: [groups], y: [countries], t: [topics] } ] and the total.
			// `t` = topic keys to SPONSOR — the gift flows into each topic's live course prize pool.
			$norm = []; $total_cents = 0;
			foreach ( $donations as $d ) {
				$cents = (int) round( ( is_array( $d ) ? (float) ( $d['amount'] ?? 0 ) : 0 ) * 100 );
				if ( $cents < 1 ) { continue; }
				$row = [
					'c' => $cents,
					'g' => array_values( array_filter( array_map( 'sanitize_key', (array) ( $d['groups'] ?? [] ) ) ) ),
					'y' => array_values( array_filter( array_map( 'sanitize_key', (array) ( $d['countries'] ?? [] ) ) ) ),
					't' => array_values( array_filter( array_map( 'sanitize_key', (array) ( $d['topics'] ?? [] ) ) ) ),
				];
				// An ARTACREDITS gift also carries the slice it is for and — frozen HERE, at the price the
				// donor was actually quoted on the page — how many entries it promises. Re-deriving the
				// count at fulfilment (or again at redemption) would silently turn one promise into three
				// different ones, because the coin sell price moves between all three moments.
				$k = is_array( $d['credit'] ?? null ) ? $d['credit'] : null;
				if ( $k ) {
					$bucket = Credits::bucket(
						(string) ( $k['country'] ?? '' ), (string) ( $k['gender'] ?? '' ), (string) ( $k['band'] ?? '' ) );
					// SELL, because that is what a redemption is priced at (Credits::cents_for) and what
					// the page quotes — freezing one side of the spread and charging the other made the
					// stored promise something the donor was never actually shown.
					$unit = max( 1, (int) round( (float) Economy::coin_price()['sell'] * 100 ) );
					$cap  = max( 1, min( Credits::FEE_CAP, (int) ( $k['fee_cap'] ?? Credits::FEE_CAP ) ) );
					$row['k'] = [
						'b' => $bucket,
						// A GUARANTEE, not an estimate: entries this gift covers even if every one of
						// them costs the maximum ₳{cap}. `$unit` is the price of ONE COIN and an entry
						// costs `fee` coins (1..FEE_CAP), so dividing by $unit alone counted coins and
						// called them entries — overstating what the gift buys by up to FEE_CAP times.
						'n' => max( 1, intdiv( $cents, $unit * $cap ) ),
						'u' => $unit,
						'f' => $cap,
						'm' => Credits::clean_donor_name( (string) ( $k['name'] ?? '' ) ),
					];
				}
				// COALESCE credit gifts to the same slice within one checkout. Fulfilment records ONE
				// aq_credit_gifts row per (ref, bucket) — the dedupe that makes a replayed webhook safe —
				// so two separate rows for one slice appended both amounts to the earmark but recorded
				// only the first gift's entitlement, stranding the second donor's promise. Merging here
				// keeps the money and the promise describing the same gift.
				$merged = false;
				if ( isset( $row['k'] ) ) {
					foreach ( $norm as &$prev ) {
						if ( isset( $prev['k'] ) && $prev['k']['b'] === $row['k']['b'] && $prev['k']['f'] === $row['k']['f'] ) {
							$prev['c']     += $cents;
							$prev['k']['n'] = max( 1, intdiv( $prev['c'], $prev['k']['u'] * $prev['k']['f'] ) );
							if ( $prev['k']['m'] === '' ) { $prev['k']['m'] = $row['k']['m']; }
							$merged = true;
							break;
						}
					}
					unset( $prev );
				}
				if ( ! $merged ) { $norm[] = $row; }
				$total_cents += $cents;
			}
			if ( ! $norm ) { return Rest::err( 'bad_input', 'No valid donation amount.', 400 ); }
			$cur = sanitize_text_field( (string) Rest::p( $req, 'currency', 'CAD' ) ) ?: 'CAD';

			// Stripe metadata caps each value at 500 chars; a truncated breakdown would be invalid JSON
			// and fulfilment would credit NOTHING for a real charge. If the breakdown is too big to carry
			// safely, collapse it to one general gift for the total — the charge is always honoured; only
			// the per-earmark split is lost (rare: ~14+ donations in one cart).
			$donations_json = wp_json_encode( $norm );
			if ( strlen( $donations_json ) > 450 ) {
				// Too big to carry safely. Keep the ARTACREDIT gifts (a credit is a promise to a named
				// slice of members — collapsing it would silently turn a targeted gift into a general one
				// AND drop the donor's name from certificates), and fold everything else into one general
				// gift for the remainder. The charge is always honoured; only the untargeted split is lost.
				$credits = array_values( array_filter( $norm, static fn( $d ) => isset( $d['k'] ) ) );
				$rest    = $total_cents - array_sum( array_column( $credits, 'c' ) );
				if ( $rest > 0 ) { $credits[] = [ 'c' => $rest, 'g' => [], 'y' => [] ]; }
				$donations_json = wp_json_encode( $credits );
				// Still too big (many credit gifts in one cart) — keep the largest CREDIT and record the
				// whole remainder as one general gift, so the recorded total always equals what was
				// charged. Money is never dropped; only the finer targeting is. Sorting $credits (which
				// by now also holds the general remainder row) could have put that general row first
				// and dropped every credit — the exact outcome this branch exists to prevent — so the
				// pick is made from the credit-carrying rows alone.
				if ( strlen( $donations_json ) > 450 ) {
					$only = array_values( array_filter( $credits, static fn( $d ) => isset( $d['k'] ) ) );
					usort( $only, static fn( $a, $b ) => (int) $b['c'] - (int) $a['c'] );
					$keep = $only[0] ?? null;
					$left = $total_cents - (int) ( $keep['c'] ?? 0 );
					$rows = $keep ? [ $keep ] : [];
					if ( $left > 0 || ! $keep ) { $rows[] = [ 'c' => max( 0, $left ) ?: $total_cents, 'g' => [], 'y' => [] ]; }
					$donations_json = wp_json_encode( $rows );
				}
			}

			if ( Stripe::enabled() ) {
				// Return the DONOR to /donate/, not the retired /enroll/ — that is where the thank-you
				// belongs, and where an ArtaCredit gift can tell them what it now covers. The wallet's
				// "your coins are in your wallet" is not what happened to a gift.
				//
				// The reason this was broken at all is worth keeping: /enroll/ is not merely retired, it is
				// 301'd to /wallet/ by the theme at parse_request priority 1, and wp_safe_redirect carries
				// NO query string — so ?stripe=success&session=… was dropped in the hop and no donor has
				// ever been told their payment arrived. Whatever this returns to must be a route that
				// answers 200 directly. /donate/ does (checked against production, query intact); anything
				// in the theme's redirect map does not. A redirect between Stripe and the confirmation is
				// a broken confirmation.
				$return = home_url( '/donate/' );
				$sess = Stripe::create_session(
					$total_cents,
					'Donation to the ArtaQuest Foundation',
					$return . '?stripe=success&session={CHECKOUT_SESSION_ID}',
					$return . '?stripe=cancel',
					[ 'aq_kind' => 'donations', 'aq_uid' => $uid, 'aq_donations' => $donations_json ]
				);
				if ( ! $sess ) { return Rest::err( 'stripe_error', 'Could not start the secure payment. Please try again.', 502 ); }
				return [ 'ok' => true, 'redirect' => true, 'url' => $sess['url'], 'course' => 'Your gift', 'total' => $total_cents / 100 ];
			}

			// A donation must be backed by a captured payment. Without Stripe there is no way to charge, so
			// REFUSE rather than record a phantom gift (which would inflate the public finances + award
			// donate points with no money behind them). The only path is Stripe Checkout above.
			return Rest::err( 'payments_unavailable', 'Donations aren’t available right now. Please try again soon.', 503 );
		}

		$c = Data::one( 'SELECT id, title FROM ' . Data::t( 'aq_courses' ) . ' WHERE slug = %s', [ $slug ] );
		if ( ! $c ) { return Rest::err( 'not_found', 'Course not found', 404 ); }
		$cid     = (int) $c['id'];
		$already = (bool) Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_enroll' ) . ' WHERE user_id = %d AND course_id = %d', [ $uid, $cid ] );
		$fee     = Funds::course_cost( $cid );
		// Enrol through the same paywalled primitive as Learn::enroll — never a free backdoor.
		if ( ! Learn::ensure_enrolled( $uid, $cid ) ) {
			return Rest::err( 'payment_required', 'Enrolling costs ₳' . $fee . '. Top up your coins, or apply for a bursary.', 402 );
		}
		return [ 'ok' => true, 'already' => $already, 'course' => $c['title'], 'total' => $fee, 'total_display' => '₳' . $fee, 'url' => '/courses/' . $slug ];
	}

	/**
	 * Fulfil a PAID Stripe Checkout Session exactly once — the single source of truth shared by the
	 * return-verify (stripe_verify) and the webhook (stripe_webhook), so a payment is honoured whichever
	 * arrives first and never twice. Idempotent: keyed by the ledger ref 'stripe:<session id>' (the
	 * donation/coin writers each no-op if that ref is already present). Returns [ kind, amount_total_cents ].
	 */
	public static function fulfil_session( $session ) {
		if ( ! is_array( $session ) ) { return [ '', 0 ]; }
		$sid   = (string) ( $session['id'] ?? '' );
		$meta  = is_array( $session['metadata'] ?? null ) ? $session['metadata'] : [];
		$total = (int) ( $session['amount_total'] ?? 0 );
		$kind  = (string) ( $meta['aq_kind'] ?? '' );
		if ( $sid === '' ) { return [ $kind, $total ]; }
		$ref = 'stripe:' . $sid;
		self::remember_payment( $session ); // so a refund months from now can find these rows again

		// Atomic single-fulfilment claim. The returning browser (stripe_verify) and Stripe's webhook can both
		// call this for the same paid session at the same instant; without a gate, both pass the per-ledger
		// 'stripe:<id>' ref check (which only dedupes SEQUENTIAL replays) and DOUBLE-mint coins / double-record
		// the gift. The aq_fulfilment PRIMARY KEY makes exactly one caller win the insert; the loser skips. If
		// a winner crashed mid-fulfilment (claimed but recorded nothing) and >2 min have passed, a later retry
		// reclaims and finishes — the ref guards below keep that idempotent so it can never double-credit.
		global $wpdb;
		$F    = Data::t( 'aq_fulfilment' );
		$prev = $wpdb->suppress_errors( true );
		$claimed = (bool) $wpdb->insert( $F, [ 'session_id' => $sid, 'created' => time() ] );
		$wpdb->suppress_errors( $prev );
		if ( ! $claimed ) {
			$age  = (int) Data::col( "SELECT created FROM $F WHERE session_id = %s", [ $sid ] );
			$done = ( $kind === 'coins' )
				? Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'buy' AND ref = %s LIMIT 1", [ $ref ] )
				: Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_fund_ledger' ) . ' WHERE ref = %s LIMIT 1', [ $ref ] );
			if ( $done || ( $age && time() - $age < 120 ) ) { return [ $kind, $total ]; } // already fulfilled, or in flight
			$wpdb->update( $F, [ 'created' => time() ], [ 'session_id' => $sid ] ); // stale claim from a crash → reclaim + finish
		}

		if ( $kind === 'donations' ) {
			if ( ! Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_fund_ledger' ) . ' WHERE ref = %s LIMIT 1', [ $ref ] ) ) {
				$uid  = (int) ( $meta['aq_uid'] ?? 0 );
				$dons = json_decode( (string) ( $meta['aq_donations'] ?? '[]' ), true );
				foreach ( is_array( $dons ) ? $dons : [] as $d ) {
					$cents = (int) ( $d['c'] ?? 0 );
					$k     = is_array( $d['k'] ?? null ) ? $d['k'] : null;
					if ( $k ) {
						// An ARTACREDITS gift: the money lands in its slice earmark exactly like any other
						// earmarked donation (+ donate points), and the gift row records what the donor was
						// PROMISED — the entry count and unit price quoted on the page they paid from, not a
						// figure re-derived here at a coin price that has since moved.
						// The ledger ref stays EXACTLY $ref — the replay guard above probes
						// aq_fund_ledger WHERE ref = $ref, so a suffixed ref would make a
						// credits-only session invisible to it and a replayed webhook would record
						// the gift twice. The gift row is deduped on (ref, bucket) instead.
						$dupe = Data::col( 'SELECT id FROM ' . Data::t( 'aq_credit_gifts' ) . ' WHERE ref = %s AND bucket = %s LIMIT 1', [ $ref, (string) $k['b'] ] );
						$gid  = Funds::record_credit( $uid, $cents, (string) $k['b'], $ref );
						if ( $gid && ! $dupe ) {
							Data::insert( 'aq_credit_gifts', [
								'donor_id'   => $uid,
								'bucket'     => (string) $k['b'],
								'cents'      => $cents,
								'entries'    => max( 1, (int) ( $k['n'] ?? 1 ) ),
								'unit_cents' => max( 1, (int) ( $k['u'] ?? 1 ) ),
								'fee_cap'    => max( 1, (int) ( $k['f'] ?? Credits::FEE_CAP ) ),
								'donor_name' => (string) ( $k['m'] ?? '' ),
								'ref'        => $ref,
								'created'    => Data::now(),
							] );
						}
						continue;
					}
					Funds::record_gift( $uid, $cents, (array) ( $d['g'] ?? [] ), (array) ( $d['y'] ?? [] ), $ref, (array) ( $d['t'] ?? [] ) );
				}
			}
		} elseif ( $kind === 'coins' ) {
			Economy::fulfil_coin_purchase( (int) ( $meta['aq_uid'] ?? 0 ), (int) ( $meta['aq_coins'] ?? 0 ), $ref ); // idempotent
		}
		return [ $kind, $total ];
	}

	/**
	 * Remember which Checkout Session a PaymentIntent paid for, so a refund weeks later can find the
	 * exact ledger rows to reverse. Stripe's charge + dispute events carry the payment_intent and
	 * NEVER the session id, and a session's metadata is not copied onto its charge — so without this
	 * map a refund cannot be tied back to the gift it undoes. Both values are Stripe object ids and
	 * the session id is already public in the ledgers' `ref` column, so the open database exposes
	 * nothing new. autoload=false: read on the rare refund, never on a page load.
	 */
	private static function remember_payment( $session ) {
		$sid = (string) ( $session['id'] ?? '' );
		$pi  = $session['payment_intent'] ?? '';
		$pi  = is_array( $pi ) ? (string) ( $pi['id'] ?? '' ) : (string) $pi; // string id, or expanded object
		if ( $sid === '' || $pi === '' ) { return; }
		update_option( 'aq_stripe_pi_' . $pi, $sid, false );
	}

	/**
	 * A payment came BACK — a refund (charge.refunded) or a chargeback (charge.dispute.*). The live
	 * Refund Policy promises "the Arta Coins credited for that donation are reversed at the same
	 * time"; until now nothing could keep that promise, because the webhook subscribed to exactly two
	 * events and neither was this one, so a refunded donor kept both the money and the coins.
	 *
	 * APPEND-ONLY, like every money path here: not one original row is edited or deleted. We append
	 * the mirrored negatives — coins via Economy::reverse_coin_purchase, the fund ledger row for row,
	 * the donate points that the gift bought — all under ONE deterministic ref, 'srev:<charge id>'.
	 * Stripe retries a webhook for days, so idempotency is not optional: each writer checks for its
	 * own ref first, and a redelivery finds the work done and no-ops.
	 *
	 * A dispute is RECORDED, not reversed, until it is closed as lost: while it is open the money is
	 * held, not gone, and reversing on `created` would double up against the close (or claw back coins
	 * from a member who then wins). Both a lost dispute and a refund resolve to the same 'srev:' ref,
	 * so a charge can never be reversed twice by two different events.
	 */
	private static function reverse_charge( $type, $event ) {
		$obj     = is_array( $event['data']['object'] ?? null ) ? $event['data']['object'] : [];
		$dispute = strpos( (string) $type, 'charge.dispute' ) === 0;
		// charge.refunded's object IS the charge; a dispute's object POINTS at it.
		$charge  = (string) ( $dispute ? ( $obj['charge'] ?? '' ) : ( $obj['id'] ?? '' ) );
		$status  = (string) ( $obj['status'] ?? '' );
		if ( $charge === '' ) { return; }

		if ( $dispute && $status !== 'lost' ) {
			Watchdog::alert( 'stripe_dispute_' . $charge, 'Stripe DISPUTE ' . ( $status ?: 'opened' ) . ' on charge ' . $charge,
				'A cardholder disputed a payment (' . $type . ', status ' . ( $status ?: 'unknown' ) . ', amount '
				. number_format( (int) ( $obj['amount'] ?? 0 ) / 100, 2 ) . " CAD).\nNothing has been reversed. Coins and fund entries "
				. 'are reversed ONLY when a dispute closes as LOST — if we win it, the money stays and nothing changes. '
				. 'Respond with evidence in the Stripe dashboard while the window is open.' );
			return;
		}

		// How much of the payment came back. A refund states both figures; a lost dispute states only
		// the disputed amount, and a dispute is for the whole charge in practice — so treat it as full
		// and say so in the alert rather than guess a fraction we cannot compute.
		$paid = (int) ( $obj['amount'] ?? 0 );
		$back = $dispute ? $paid : (int) ( $obj['amount_refunded'] ?? 0 );
		$frac = ( $dispute || $paid < 1 ) ? 1.0 : min( 1.0, $back / $paid );
		if ( $back < 1 ) { return; } // a $0 refund event (Stripe emits these on some updates) undoes nothing

		$pi  = (string) ( $obj['payment_intent'] ?? '' );
		$sid = $pi === '' ? '' : (string) get_option( 'aq_stripe_pi_' . $pi, '' );
		if ( $sid === '' ) {
			// Payments captured before this map existed (and any we somehow never recorded) cannot be
			// traced back to their ledger rows automatically. Refuse to guess with real money — page an
			// operator with everything they need to reverse it by hand.
			Watchdog::alert( 'stripe_refund_unmapped_' . $charge, 'Stripe refund could NOT be matched to a ledger entry',
				'Charge ' . $charge . ' (payment_intent ' . ( $pi ?: 'unknown' ) . ') was refunded '
				. number_format( $back / 100, 2 ) . " CAD, but no Checkout Session is recorded for it, so nothing was reversed.\n"
				. 'Find the session in the Stripe dashboard, then reverse its coin/fund entries by hand with a compensating '
				. 'ledger row (append-only — never edit the original).', true );
			return;
		}
		$ref = 'stripe:' . $sid;
		$rev = 'srev:' . $charge; // deterministic: one reversal per charge, whichever event delivers it

		$coins = Economy::reverse_coin_purchase( $ref, $rev, $frac );
		[ $cents, $buckets ] = self::reverse_fund_gift( $ref, $rev, $frac, $charge );

		Watchdog::note( sprintf( 'Stripe %s reversed: charge %s, %.2f CAD, %d coins, %d fund cents', $type, $charge, $back / 100, $coins, $cents ) );
		// Two cases a human must actually look at: a sponsorship whose money has already been spent
		// into a live prize pool (it cannot come back out — the pool is nobody's to claw), and a
		// partial refund, where the split between what stays and what returns is a judgement call.
		$sponsored = (bool) array_filter( $buckets, static fn( $b ) => strpos( (string) $b, 'typ_' ) === 0 );
		if ( $sponsored || $frac < 1.0 ) {
			Watchdog::alert( 'stripe_refund_' . $charge, 'Refund reversed — please check it by hand',
				'Charge ' . $charge . ' returned ' . number_format( $back / 100, 2 ) . ' CAD ('
				. ( $frac < 1.0 ? 'PARTIAL, ' . round( $frac * 100 ) . '% of the payment' : 'in full' ) . ").\n"
				. 'Reversed: ' . $coins . ' coins and ' . $cents . " fund cents, appended as ref {$rev}.\n"
				. ( $sponsored ? "This gift included a TOPIC SPONSORSHIP whose coins may already have been minted into a live prize\npool — that money cannot be recalled, so the earmark bucket may now read negative until it is settled.\n" : '' )
				. 'The originals are untouched; every reversal is a new row.' );
		}
	}

	/**
	 * Mirror a gift's fund-ledger rows as negatives, and take back the donate points it bought.
	 * Returns [ cents reversed, buckets touched ].
	 *
	 * The fund ledger's append is private to Funds (its one write choke point, which moves the bucket
	 * counter in lockstep), and Funds.php is not ours to edit in this pass — so this mirrors that
	 * invariant exactly: the row lands FIRST and the counter moves only if it did, because a counter
	 * that moves without a row desyncs the public finances permanently. Fold it into a
	 * Funds::reverse_gift the next time that file is open.
	 */
	private static function reverse_fund_gift( $ref, $rev, $frac, $charge ) {
		if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_fund_ledger' ) . ' WHERE ref = %s LIMIT 1', [ $rev ] ) ) { return [ 0, [] ]; }
		// Only the POSITIVE rows: a sponsorship also writes a negative row of its own (the CAD it spent
		// on a prize pool), and mirroring that would hand the fund money back that it never had.
		$rows = Data::all( 'SELECT id, bucket, cents FROM ' . Data::t( 'aq_fund_ledger' ) . ' WHERE ref = %s AND cents > 0 ORDER BY id ASC', [ (string) $ref ] );
		$cents = 0; $awarded = 0; $uid = 0; $buckets = [];
		foreach ( $rows as $r ) {
			$part = (int) round( (int) $r['cents'] * (float) $frac );
			if ( $part < 1 ) { continue; }
			$id = Data::insert( 'aq_fund_ledger', [
				'bucket'  => (string) $r['bucket'],
				'cents'   => -$part,
				'ref'     => (string) $rev,
				'note'    => 'Refunded: ' . $charge,
				'created' => Data::now(),
			] );
			if ( ! $id ) {
				error_log( 'AQ reverse_fund_gift: ledger INSERT FAILED bucket=' . $r['bucket'] . " {$part}c ref={$rev} — nothing reversed" );
				continue;
			}
			Economy::counter_add( 'fund_' . (string) $r['bucket'], -$part );
			$cents    += $part;
			$buckets[] = (string) $r['bucket'];
			// The donor + the points this part bought: the fund ledger records no user_id, but
			// record_donation awarded the points against ref 'fund<row id>', which does.
			$p = Data::one( 'SELECT user_id, delta FROM ' . Data::t( 'aq_points_ledger' ) . " WHERE track = 'donate' AND ref = %s LIMIT 1", [ 'fund' . (int) $r['id'] ] );
			if ( $p ) { $uid = (int) $p['user_id']; $awarded += (int) $p['delta']; }
		}
		// Standing bought by money that went back is standing nobody earned — and it buys real things
		// here (group-tag slots, the creator rung). Take back only what the refund covers, never more
		// than was awarded, and never below zero. award_points is itself idempotent per (user, track, ref).
		$giveback = min( $awarded, (int) floor( $cents / 100 ) );
		if ( $uid > 0 && $giveback > 0 ) { Economy::award_points( $uid, -$giveback, 'donate', (string) $rev ); }
		return [ $cents, $buckets ];
	}

	/**
	 * GET /stripe-verify?session= — confirm a returned Stripe Checkout Session and fulfil it (once).
	 * Reads the order from Stripe (the session id is the unguessable bearer), not from the client. The
	 * webhook is the reliable backstop; this gives the returning user instant confirmation.
	 */
	public static function stripe_verify( $req ) {
		// Per-IP throttle: each call retrieves the session from Stripe's API, so an unthrottled public
		// GET lets anyone hammer us with junk session ids and burn outbound API calls (cost/DoS, and it
		// counts against our Stripe rate limit). A real buyer returns from checkout exactly once — the
		// webhook remains the reliable fulfilment path if a legitimate retry ever gets clipped.
		if ( Rest::throttle( 'stripe_verify', 30, 600 ) ) { return Rest::err( 'rate_limited', 'Slow down a moment.', 429 ); }
		$sid = sanitize_text_field( (string) Rest::p( $req, 'session', '' ) );
		if ( $sid === '' || ! Stripe::enabled() ) { return [ 'ok' => true, 'paid' => false, 'order' => '', 'course' => '', 'total' => 0 ]; }
		$s = Stripe::retrieve_session( $sid );
		if ( ! Stripe::is_paid( $s ) ) { return [ 'ok' => true, 'paid' => false, 'order' => $sid, 'course' => '', 'total' => 0 ]; }
		[ $kind, $total ] = self::fulfil_session( $s );
		$course = $kind === 'donations' ? 'Your gift' : ( $kind === 'coins' ? 'Arta Coins' : '' );
		return [ 'ok' => true, 'paid' => true, 'order' => $sid, 'course' => $course, 'total' => $total / 100 ];
	}

	/**
	 * POST /stripe/webhook — Stripe's server-to-server confirmation, the RELIABLE fulfilment path (fires
	 * even if the buyer closes the tab). Verifies the Stripe-Signature against STRIPE_WEBHOOK_SECRET on
	 * the RAW body, then fulfils a completed+paid checkout via the shared idempotent path. Always 200s a
	 * verified event (so Stripe stops retrying); 400 on a bad signature; no-op 200 when unconfigured.
	 */
	public static function stripe_webhook( $req ) {
		if ( ! Secrets::has( 'STRIPE_WEBHOOK_SECRET' ) ) { return new \WP_REST_Response( [ 'ok' => true, 'skipped' => true ], 200 ); }
		$payload = $req->get_body();
		if ( (string) $payload === '' ) { $payload = (string) file_get_contents( 'php://input' ); }
		$sig   = (string) $req->get_header( 'stripe-signature' );
		$event = Stripe::verify_webhook( (string) $payload, $sig );
		if ( ! $event ) { return new \WP_REST_Response( [ 'error' => 'bad_signature' ], 400 ); }
		$type = (string) ( $event['type'] ?? '' );
		if ( $type === 'checkout.session.completed' ) {
			$session = $event['data']['object'] ?? null;
			if ( is_array( $session ) && ( $session['payment_status'] ?? '' ) === 'paid' ) { self::fulfil_session( $session ); }
		} elseif ( $type === 'charge.refunded' || $type === 'charge.dispute.created' || $type === 'charge.dispute.closed' ) {
			// Money going BACK is as much a fulfilment as money coming in — see reverse_charge.
			self::reverse_charge( $type, $event );
		} elseif ( $type === 'account.updated' ) {
			// A connected account finished (or changed) onboarding — refresh the cached cash-out readiness
			// so the member can withdraw the moment Stripe enables their payouts, without a stale wait.
			$acct = $event['data']['object'] ?? null;
			if ( is_array( $acct ) && ! empty( $acct['id'] ) ) {
				Economy::cache_payout_ready( (string) $acct['id'], ! empty( $acct['payouts_enabled'] ) );
			}
		}
		return new \WP_REST_Response( [ 'ok' => true ], 200 );
	}

	/**
	 * GET /version — the plugin/theme versions actually EXECUTING on this server, ArtaDev's
	 * deploy-confirmation primitive (operator directive 2026-07-16 + COORDINATION.md rule 7: verify
	 * the outcome, not the action). Prod runs opcache with validate_timestamps=0, so files on disk
	 * and code in the PHP tier can diverge after a push — AQ_VERSION here is read from the RUNNING
	 * process, which is exactly the fact a deploy needs confirmed before anyone is told "shipped".
	 * Public by design: both values are already public (style.css ships raw; the DB explorer is open).
	 */
	public static function version( $req ) {
		$theme = wp_get_theme( 'artaquest-theme' );
		return [
			'plugin' => defined( 'AQ_VERSION' ) ? (string) AQ_VERSION : '',
			'theme'  => $theme && $theme->exists() ? (string) $theme->get( 'Version' ) : '',
		];
	}

	/**
	 * GET /stripe/status — a masked health check so payment activation can be confirmed WITHOUT a
	 * charge. Returns booleans only: whether each secret is CONFIGURED (via Secrets::has — never the
	 * value). The publishable key is public-by-design (it ships to the browser), so its prefix and
	 * the derived live/test mode are shown; the secret key and webhook secret are NEVER exposed,
	 * not even a prefix. Safe to serve publicly (GET) even though the whole DB is already public.
	 */
	public static function stripe_status( $req ) {
		$pk   = Secrets::get( 'STRIPE_PUBLISHABLE_KEY' );
		$mode = strpos( $pk, 'pk_live_' ) === 0 ? 'live' : ( strpos( $pk, 'pk_test_' ) === 0 ? 'test' : 'unset' );
		return [
			'enabled'            => Stripe::enabled(),
			'secret_key'         => Secrets::has( 'STRIPE_SECRET_KEY' ),
			'publishable_key'    => Secrets::has( 'STRIPE_PUBLISHABLE_KEY' ),
			'webhook_secret'     => Secrets::has( 'STRIPE_WEBHOOK_SECRET' ),
			'mode'               => $mode,
			'publishable_prefix' => $pk === '' ? '' : substr( $pk, 0, 8 ), // public-by-design; prefix only
			// Cash-out (outbound payouts via Connect transfers): live when Stripe is on and not frozen.
			'cashout_enabled'    => Economy::cashout_enabled(),
			'cashout_frozen'     => Secrets::has( 'AQ_CASHOUT_FROZEN' ),
			// Webhook events to subscribe to at the Stripe endpoint, so ops can confirm coverage. This
			// list is the handler's own switch, verbatim: an endpoint missing charge.refunded silently
			// breaks the Refund Policy's promise, and the health check is where that has to be visible.
			'webhook_events'     => [ 'checkout.session.completed', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.closed', 'account.updated' ],
		];
	}

	/**
	 * GET /studio/pulse — ONE analytics shape for the whole studio family, so the Library hub can
	 * render the SAME live strip on every tab (the /artasound "transparency pulse" pattern, made
	 * uniform): per kind — daemon liveness, queue depth, works in progress, drafts ready to review,
	 * published total, and adversarial-review activity. Public + CDN-cacheable like every GET.
	 */
	public static function studio_pulse( $req = null ) {
		Library::ensure_tables(); Music::ensure_tables(); Motion::ensure_tables();
		Film::ensure_tables(); Illustration::ensure_tables(); Science::ensure_tables(); Reviews::ensure_tables();
		$day = Data::now() - 86400;
		// Draft-pipeline counts for one project table (every studio shares the same state alphabet).
		$states = static function ( $table, $col, $and = '' ) {
			$out = [ 'queued' => 0, 'processing' => 0, 'in_review' => 0 ];
			foreach ( Data::all( "SELECT {$col} s, COUNT(*) n FROM " . Data::t( $table )
				. " WHERE status != 'removed'{$and} AND {$col} IN ('queued','processing','review') GROUP BY {$col}" ) as $r ) {
				$out[ $r['s'] === 'review' ? 'in_review' : (string) $r['s'] ] = (int) $r['n'];
			}
			return $out;
		};
		$published = static fn( $table, $and = '' ) => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( $table ) . " WHERE status = 'published'{$and}" );
		// Review-round activity from a rounds table (total + last 24h) — the "how hard the critic works" pair.
		$rounds = static function ( $table, $where, $args ) use ( $day ) {
			return [
				'rounds_total' => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( $table ) . ( $where ? " WHERE {$where}" : '' ), $args ),
				'rounds_24h'   => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( $table )
					. ' WHERE ' . ( $where ? "{$where} AND " : '' ) . 'created > %d', array_merge( $args, [ $day ] ) ),
			];
		};
		$beat  = static fn( $key ) => (bool) get_transient( $key );
		$kinds = [
			'book'         => $states( 'aq_documents', 'book_state' )
				+ [ 'online' => $beat( 'aq_library_beat' ), 'published' => $published( 'aq_documents' ) ]
				+ $rounds( 'aq_work_reviews', 'target_type = %s', [ 'book' ] ),
			'music'        => $states( 'aq_tracks', 'track_state', " AND kind = 'music'" )
				+ [ 'online' => $beat( 'aq_music_beat' ), 'published' => $published( 'aq_tracks', " AND kind = 'music'" ) ]
				+ $rounds( 'aq_track_reviews', '', [] ),
			'audiobook'    => $states( 'aq_tracks', 'track_state', " AND kind = 'audiobook'" )
				+ [ 'online' => $beat( 'aq_music_beat' ), 'published' => $published( 'aq_tracks', " AND kind = 'audiobook'" ) ]
				+ [ 'rounds_total' => 0, 'rounds_24h' => 0 ], // audiobooks narrate the member's own text — no critic rounds
			'animation'    => $states( 'aq_animations', 'anim_state' )
				+ [ 'online' => $beat( 'aq_motion_beat' ), 'published' => $published( 'aq_animations' ) ]
				+ [ 'rounds_total' => 0, 'rounds_24h' => 0 ],
			'film'         => $states( 'aq_films', 'film_state' )
				+ [ 'online' => $beat( 'aq_film_beat' ), 'published' => $published( 'aq_films' ) ]
				+ $rounds( 'aq_work_reviews', 'target_type = %s', [ 'film' ] ),
			'illustration' => $states( 'aq_illustrations', 'art_state' )
				+ [ 'online' => $beat( 'aq_illust_beat' ), 'published' => $published( 'aq_illustrations' ) ]
				+ $rounds( 'aq_illust_rounds', '', [] ),
			// Papers speak the journal's dialect: queued = submitted, processing = the reviewer has it,
			// in_review = revisions requested (the author's turn — same "your move" semantics as 'review').
			'paper'        => [
				'queued'     => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_submissions' ) . " WHERE status = 'submitted'" ),
				'processing' => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_submissions' ) . " WHERE status = 'reviewing'" ),
				'in_review'  => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_submissions' ) . " WHERE status = 'revisions-requested'" ),
				'online'     => $beat( 'aq_science_beat' ),
				'published'  => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_submissions' ) . " WHERE status = 'accepted'" ),
			] + $rounds( 'aq_paper_reviews', '', [] ),
		];
		return [ 'model' => 'claude-opus-5', 'points_per_coin' => Economy::POINTS_PER_COIN, 'kinds' => $kinds ];
	}
}
