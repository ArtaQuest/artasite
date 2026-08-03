<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * CREATIVE CHALLENGES (2026-07-10; member challenges + board UX 2026-07-11) — the unified
 * challenge frame. A challenge is a DISCUSSION-BOARD OBJECT: a prompt, a pot, an entries feed
 * ranked by hearts, and its own talk thread — all closing together at the new moon (Season).
 *
 * Two flavours, one table, one settlement:
 *   • SYSTEM (owner_uid 0, slug '<kind>-s<season>'): one per creative kind per season. Publishing
 *     a work of that kind IS the entry — the studio's publish fee (already burned) accumulates as
 *     `revenue`. Lazily created; deduplicated by the UNIQUE slug.
 *   • MEMBER (owner_uid > 0): anyone starts one for ₳1 (burned; it seeds the pot) with a title +
 *     prompt. Entering attaches a work you PUBLISHED THIS SEASON for ₳1 (burned → the pot). A
 *     work may sit in its kind's system challenge AND any member challenges it entered; hearts
 *     are cast once per work and count on every board that lists it.
 *
 * POOL = 100% of `revenue` + carried (every coin paid in goes back out — fees are burned into
 * reserve first, so the full payout is fully backed). PODIUM = top-3 by season hearts, 50/30/20, signed-delta
 * settlement (refs ch<id>:s<key>:u<uid>, reason 'chprize'), frozen into aq_challenge_results at
 * the reset. GATE = ≥ MIN_AUTHORS entrants and ≥ MIN_HEARTERS distinct hearters, else the pool
 * rolls forward into the next season's SYSTEM challenge of the kind (coins are already burned —
 * nothing is lost). Every entrant holds a derived participation certificate. SHADOW MODE: until
 * option `aq_challenge_payouts` is truthy, settlement freezes results but pays ₳0.
 */
final class Challenges {

	/** EVERY content kind holds challenges (generalized 2026-07-11): the six creative works, plus
	 *  papers (enter on journal acceptance), datasets (enter when hosted) and models (enter when
	 *  the solution is verified). One frame — leaderboard, discussion, results — for all of them. */
	const KINDS = [ 'book', 'music', 'audiobook', 'animation', 'film', 'illustration', 'paper', 'dataset', 'model' ];

	const POOL_SHARE    = 1.00;             // 100% back to participants (operator 2026-07-11) — every fee is burned first, so a full payout is fully backed
	const PODIUM        = [ 0.50, 0.30, 0.20 ];
	const MIN_AUTHORS   = 5;                // distinct entrants needed for a season to pay
	const MIN_HEARTERS  = 10;               // distinct members whose hearts count needed to pay
	const BOARD_LIMIT   = 100;              // top-N the live board returns
	const RING_MIN      = 3;                // mutual hearts each way ⇒ reciprocal ring, excluded
	const CREATE_FEE    = 1;                // ₳ to start a member challenge (burned; seeds the pot)
	const ENTER_FEE     = 1;                // ₳ to enter a work into a member challenge (burned → the pot)
	const MAX_OPEN_OWNED = 3;               // a member may have at most this many open challenges at once

	/**
	 * Per-kind SOURCE descriptor — how a challenge kind reads its works. One shape for all nine:
	 *   join   : SQL join binding the work table(s) as `w` (+ `c` for models) to e.work_id
	 *   cols   : SELECT extras — title, media, a status NORMALISED to 'published'/'draft', slug
	 *   url    : fn(work_id, slug) → the work's public page
	 *   author : the owner column (schemas differ: author_id / owner_uid / uid)
	 * Music/audiobook share aq_tracks (the kind column pins them); models join their dataset for
	 * the title/slug; papers count as published on journal ACCEPTANCE; datasets once hosted.
	 */
	private static function src( $kind ) {
		$creative = [
			'book'         => [ 'aq_documents',     'thumb',     '/read/',         '' ],
			'music'        => [ 'aq_tracks',        'cover',     '/listen/',       'music' ],
			'audiobook'    => [ 'aq_tracks',        'cover',     '/listen/',       'audiobook' ],
			'animation'    => [ 'aq_animations',    'poster',    '/watch/',        '' ],
			'film'         => [ 'aq_films',         'poster',    '/film/',         '' ],
			'illustration' => [ 'aq_illustrations', 'image_url', '/illustration/', '' ],
		];
		if ( isset( $creative[ $kind ] ) ) {
			[ $table, $media, $prefix, $disc ] = $creative[ $kind ];
			return [
				'join'   => 'JOIN ' . Data::t( $table ) . ' w ON w.id = e.work_id' . ( $disc !== '' ? " AND w.kind = '" . $disc . "'" : '' ),
				'cols'   => "w.title AS title, w.$media AS media, w.status AS status, '' AS slug",
				'url'    => static fn( $id, $slug ) => $prefix . (int) $id . '/',
				'author' => 'w.author_id',
			];
		}
		if ( 'paper' === $kind ) {
			return [
				'join'   => 'JOIN ' . Data::t( 'aq_submissions' ) . ' w ON w.id = e.work_id',
				'cols'   => "w.title AS title, '' AS media, CASE WHEN w.status = 'accepted' THEN 'published' ELSE 'draft' END AS status, '' AS slug",
				'url'    => static fn( $id, $slug ) => '/research/?submission=' . (int) $id,
				'author' => 'w.author_id',
			];
		}
		if ( 'dataset' === $kind ) {
			return [
				'join'   => 'JOIN ' . Data::t( 'aq_competitions' ) . ' w ON w.id = e.work_id',
				'cols'   => "w.title AS title, '' AS media, CASE WHEN w.status IN ('active','closed') THEN 'published' ELSE 'draft' END AS status, w.slug AS slug",
				'url'    => static fn( $id, $slug ) => '/competition/?slug=' . rawurlencode( (string) $slug ),
				'author' => 'w.owner_uid',
			];
		}
		if ( 'model' === $kind ) {
			return [
				'join'   => 'JOIN ' . Data::t( 'aq_comp_subs' ) . ' w ON w.id = e.work_id JOIN ' . Data::t( 'aq_competitions' ) . ' c ON c.id = w.comp_id',
				'cols'   => "CONCAT('Model — ', c.title) AS title, '' AS media, CASE WHEN w.verified = 1 THEN 'published' ELSE 'draft' END AS status, c.slug AS slug",
				'url'    => static fn( $id, $slug ) => '/competition/?slug=' . rawurlencode( (string) $slug ),
				'author' => 'w.uid',
			];
		}
		return null;
	}

	/** A work row (id, author_id, status['published'|'draft'], title, media, url) for ANY
	 *  challenge kind; null if absent. */
	public static function work( $kind, $id ) {
		$s = self::src( $kind );
		if ( ! $s || ! (int) $id ) { return null; }
		// One query for every kind: bind the id through a one-row derived table so the SAME join
		// + normalised columns serve both this lookup and the board read.
		$row = Data::one(
			'SELECT e.work_id AS id, ' . $s['author'] . ' AS author_id, ' . $s['cols'] . '
			   FROM ( SELECT %d AS work_id ) e ' . $s['join'] . ' LIMIT 1',
			[ (int) $id ]
		);
		if ( ! $row ) { return null; }
		$row['url'] = ( $s['url'] )( (int) $row['id'], (string) $row['slug'] );
		return $row;
	}

	// ── Challenge rows ──────────────────────────────────────────────────────────────────────

	/** Get-or-create the SYSTEM challenge for a kind in the current season (dedup by slug). */
	public static function ensure_open( $kind ) {
		if ( ! in_array( $kind, self::KINDS, true ) ) { return null; }
		self::ensure_archived(); // roll any ended season first, so `carried` lands before reads
		$key  = (int) Season::current()['key'];
		$slug = $kind . '-s' . $key;
		$row  = Data::one( 'SELECT * FROM ' . Data::t( 'aq_challenges' ) . ' WHERE slug = %s', [ $slug ] );
		if ( $row ) { return $row; }
		global $wpdb;
		$prev = $wpdb->suppress_errors( true ); // racy first-insert loses to the UNIQUE slug, harmless
		$id   = Data::insert( 'aq_challenges', [
			'kind' => $kind, 'season_key' => $key, 'slug' => $slug,
			'title' => ucfirst( $kind ) . ' Challenge', 'owner_uid' => 0,
			'status' => 'open', 'created' => Data::now(),
		] );
		$wpdb->suppress_errors( $prev );
		if ( ! $id ) {
			return Data::one( 'SELECT * FROM ' . Data::t( 'aq_challenges' ) . ' WHERE slug = %s', [ $slug ] );
		}
		self::attach_thread( (int) $id, ucfirst( $kind ) . ' Challenge — ' . Season::current()['label'],
			'This season\'s ' . esc_html( $kind ) . ' challenge. Publish a ' . esc_html( $kind ) . ' through the studio to enter — your publish fee joins the pot, the community\'s hearts pick the podium at the new moon.' );
		return Data::one( 'SELECT * FROM ' . Data::t( 'aq_challenges' ) . ' WHERE id = %d', [ (int) $id ] );
	}

	/** Create + link a challenge's talk thread (the discussion board it IS). */
	private static function attach_thread( $chid, $title, $body_html ) {
		$bot = (int) get_option( 'aq_artabot_uid', 0 );
		$tid = Data::insert( 'aq_threads', [
			'author_id' => $bot, 'title' => $title, 'body' => '<p>' . $body_html . '</p>',
			'lang' => 'en', 'topic' => 'challenges', 'created' => Data::now(),
		] );
		Data::update( 'aq_challenges', [ 'thread_id' => (int) $tid ], [ 'id' => (int) $chid ] );
		return (int) $tid;
	}

	/** Resolve a challenge by its public key: a numeric id, or a kind name (→ the current
	 *  season's system challenge, created on first read). */
	private static function row_by_key( $key ) {
		if ( ctype_digit( (string) $key ) ) {
			return Data::one( 'SELECT * FROM ' . Data::t( 'aq_challenges' ) . ' WHERE id = %d', [ (int) $key ] );
		}
		return self::ensure_open( sanitize_key( (string) $key ) );
	}

	/**
	 * POST /challenges/create {kind, title, brief} — start a MEMBER challenge. Costs ₳CREATE_FEE
	 * (burned; it seeds the pot, so every challenge opens with a real prize on the table). The
	 * challenge closes with everyone else's at the new moon.
	 */
	public static function create( $req ) {
		if ( Rest::throttle( 'chal_create', 5, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		if ( $err = Verify::require_identity( $uid ) ) { return $err; }
		$kind  = sanitize_key( (string) Rest::p( $req, 'kind', '' ) );
		$title = mb_substr( sanitize_text_field( (string) Rest::p( $req, 'title', '' ) ), 0, 120 );
		$brief = mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'brief', '' ) ), 0, 1000 );
		if ( ! in_array( $kind, self::KINDS, true ) ) { return Rest::err( 'bad_input', 'Pick what the challenge is for — a book, track, audiobook, animation, film or illustration.' ); }
		if ( mb_strlen( trim( $title ) ) < 4 ) { return Rest::err( 'bad_input', 'Give the challenge a title (a few words).' ); }
		$open = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_challenges' ) . " WHERE owner_uid = %d AND status = 'open'", [ $uid ] );
		if ( $open >= self::MAX_OPEN_OWNED ) { return Rest::err( 'too_many', 'You already have ' . $open . ' open challenges — let them close at the new moon first.', 409 ); }
		$bal = Economy::coin_balance( $uid );
		if ( $bal < self::CREATE_FEE ) { return Rest::err( 'insufficient', 'Starting a challenge costs ₳' . self::CREATE_FEE . ' (it seeds the pot) — you have ₳' . $bal . '.', 402 ); }

		$s  = Season::current();
		$id = Data::insert( 'aq_challenges', [
			'kind' => $kind, 'season_key' => (int) $s['key'], 'slug' => null,
			'title' => $title, 'brief' => $brief, 'owner_uid' => $uid,
			'revenue' => self::CREATE_FEE, 'status' => 'open', 'created' => Data::now(),
		] );
		if ( ! $id ) { return Rest::err( 'failed', 'Could not start the challenge', 500 ); }
		Economy::credit_coins( $uid, -self::CREATE_FEE, 'chcreate', 'chcreate:' . (int) $id ); // burned — it backs the pot
		$who = wp_get_current_user();
		self::attach_thread( (int) $id, $title,
			esc_html( $brief !== '' ? $brief : 'A member challenge by ' . ( $who ? $who->display_name : 'a member' ) . '. Enter your ' . $kind . ', collect hearts, split the pot at the new moon.' ) );
		return [ 'ok' => true, 'id' => (int) $id ];
	}

	// ── Entries ─────────────────────────────────────────────────────────────────────────────

	/**
	 * AUTO-ENTRY (called by each studio's publish handler inside its draft→published claim):
	 * the work joins its kind's SYSTEM challenge; the publish cost is the entry fee.
	 */
	public static function enter( $kind, $work_id, $uid, $fee ) {
		$ch = self::ensure_open( $kind );
		if ( ! $ch ) { return; }
		self::insert_entry( $ch, (int) $work_id, (int) $uid, max( 0, (int) $fee ) );
	}

	/**
	 * POST /challenges/enter {id, work_id} — enter one of YOUR works (published this season, i.e.
	 * it holds a system-challenge entry) into a MEMBER challenge of the same kind, for ₳ENTER_FEE
	 * (burned → the pot). One entry per work per challenge; hearts carry across boards.
	 */
	public static function enter_work( $req ) {
		if ( Rest::throttle( 'chal_enter', 20, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		$ch  = self::row_by_key( Rest::pint( $req, 'id' ) );
		if ( ! $ch || $ch['status'] !== 'open' ) { return Rest::err( 'not_found', 'Challenge not found or already closed', 404 ); }
		if ( (int) $ch['owner_uid'] === 0 ) { return Rest::err( 'automatic', 'Publishing enters the seasonal challenge automatically — this button is for member challenges.', 400 ); }
		if ( (int) $ch['season_key'] !== (int) Season::current()['key'] ) { return Rest::err( 'closed', 'This challenge\'s season has ended.', 409 ); }
		$kind = (string) $ch['kind'];
		$wid  = Rest::pint( $req, 'work_id' );
		$w    = self::work( $kind, $wid );
		if ( ! $w || $w['status'] !== 'published' ) { return Rest::err( 'not_found', 'Work not found', 404 ); }
		if ( (int) $w['author_id'] !== $uid ) { return Rest::err( 'forbidden', 'You can only enter your own work.', 403 ); }
		// Published THIS season = it holds an entry in the kind's current system challenge.
		$sys = self::ensure_open( $kind );
		if ( ! $sys || ! Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_challenge_entries' ) . ' WHERE challenge_id = %d AND work_id = %d', [ (int) $sys['id'], $wid ] ) ) {
			return Rest::err( 'not_this_season', 'Only works published this season can enter — publish something new through the studio first.', 409 );
		}
		if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_challenge_entries' ) . ' WHERE challenge_id = %d AND work_id = %d', [ (int) $ch['id'], $wid ] ) ) {
			return Rest::err( 'entered', 'This work is already in the challenge.', 409 );
		}
		$bal = Economy::coin_balance( $uid );
		if ( $bal < self::ENTER_FEE ) { return Rest::err( 'insufficient', 'Entering costs ₳' . self::ENTER_FEE . ' (it joins the pot) — you have ₳' . $bal . '.', 402 ); }
		$ref = 'chent:' . (int) $ch['id'] . ':w' . $wid;
		if ( ! Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'chent' AND ref = %s", [ $ref ] ) ) {
			Economy::credit_coins( $uid, -self::ENTER_FEE, 'chent', $ref ); // burned — it backs the pot
		}
		self::insert_entry( $ch, $wid, $uid, self::ENTER_FEE );
		self::entry_touch( $kind, $wid ); // pick up hearts the work already earned this season
		return [ 'ok' => true ];
	}

	/** Idempotent entry insert + counters (shared by auto-entry and member entry). */
	private static function insert_entry( $ch, $work_id, $uid, $fee ) {
		$cid = (int) $ch['id'];
		if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_challenge_entries' ) . ' WHERE challenge_id = %d AND work_id = %d', [ $cid, $work_id ] ) ) { return; }
		Data::insert( 'aq_challenge_entries', [
			'challenge_id' => $cid, 'work_id' => $work_id, 'kind' => (string) $ch['kind'],
			'author_id' => $uid, 'fee' => $fee, 'hearts' => 0, 'created' => Data::now(),
		] );
		Data::bump( 'aq_challenges', [ 'id' => $cid ], 'revenue', $fee );
		Data::bump( 'aq_challenges', [ 'id' => $cid ], 'entry_count', 1 );
	}

	/** LIVE published works a member holds across every creative kind (the shelf). */
	public static function shelf_used( $uid ) {
		$uid = (int) $uid;
		if ( ! $uid ) { return 0; }
		$n = 0;
		foreach ( [ 'aq_documents', 'aq_tracks', 'aq_animations', 'aq_films', 'aq_illustrations' ] as $t ) {
			$n += (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( $t ) . " WHERE author_id = %d AND status = 'published'", [ $uid ] );
		}
		return $n;
	}

	/** The publish-time SHELF QUOTA gate, shared by every studio (409 shelf_full when the tier's
	 *  quota of live published works is filled; null = may publish). First publish only. */
	public static function quota_gate( $uid ) {
		$quota = Economy::shelf_quota( $uid );
		if ( $quota <= 0 ) { return null; } // unlimited (Legend / operator)
		$used = self::shelf_used( $uid );
		if ( $used < $quota ) { return null; }
		return Rest::err(
			'shelf_full',
			'Your shelf is full — you hold ' . $used . ' of ' . $quota . ' published works for your tier. Retire a weaker work (or earn the next tier) to publish this one. Deleting frees the slot; fees and points are never refunded.',
			409
		);
	}

	// ── Hearts ──────────────────────────────────────────────────────────────────────────────

	/** POST /work/heart { kind, id, val: 1|0 } — heart (or un-heart) a published work. One heart
	 *  per member per work; never your own. Every challenge board holding the work updates. */
	public static function heart( $req ) {
		if ( Rest::throttle( 'heart', 120, 600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = Rest::uid();
		$kind = sanitize_key( (string) Rest::p( $req, 'kind', '' ) );
		$id   = Rest::pint( $req, 'id' );
		$val  = Rest::pint( $req, 'val', 1 ) > 0 ? 1 : 0;
		if ( ! in_array( $kind, self::KINDS, true ) ) { return Rest::err( 'bad_input', 'Unknown kind' ); }
		$w = self::work( $kind, $id );
		if ( ! $w || $w['status'] !== 'published' ) { return Rest::err( 'not_found', 'Work not found', 404 ); }
		if ( (int) $w['author_id'] === $uid ) { return Rest::err( 'self_vote', 'You can’t heart your own work.', 403 ); }

		$cur = Data::col( 'SELECT val FROM ' . Data::t( 'aq_votes' ) . ' WHERE user_id = %d AND target_type = %s AND target_id = %d', [ $uid, $kind, $id ] );
		$cur = $cur === null ? 0 : (int) $cur;
		if ( $val !== $cur ) {
			if ( $val === 0 ) {
				$GLOBALS['wpdb']->delete( Data::t( 'aq_votes' ), [ 'user_id' => $uid, 'target_type' => $kind, 'target_id' => $id ] );
			} else {
				Data::upsert( 'aq_votes', [ 'user_id' => $uid, 'target_type' => $kind, 'target_id' => $id ], [
					'val' => 1, 'created' => Data::now(),
				] );
				$ref = 'wh:' . $kind . $id . '_' . $uid; // (work, voter) — idempotent anchor for the point AND the notification
				Economy::award_points( (int) $w['author_id'], 1, 'content', $ref );
				$voter = wp_get_current_user();
				Notify::push( (int) $w['author_id'], 'heart', ( $voter && $voter->display_name ? $voter->display_name : 'A member' ) . ' loved your ' . $kind, '', $w['url'], $ref );
			}
			self::entry_touch( $kind, $id );
		}
		return [ 'ok' => true, 'my_vote' => $val, 'hearts' => self::hearts_of( $kind, $id ) ];
	}

	/** GET /work/hearts?kind=&id= — a work's heart count + the caller's own heart. */
	public static function work_hearts( $req ) {
		$kind = sanitize_key( (string) Rest::p( $req, 'kind', '' ) );
		$id   = Rest::pint( $req, 'id' );
		if ( ! in_array( $kind, self::KINDS, true ) || ! $id ) { return Rest::err( 'bad_input', 'Unknown kind' ); }
		$uid = Rest::uid();
		return [
			'hearts'  => self::hearts_of( $kind, $id ),
			'my_vote' => $uid ? (int) Data::col( 'SELECT val FROM ' . Data::t( 'aq_votes' ) . ' WHERE user_id = %d AND target_type = %s AND target_id = %d', [ $uid, $kind, $id ] ) : 0,
		];
	}

	/** Lifetime hearts on a work (one indexed count on (target_type, target_id)). */
	public static function hearts_of( $kind, $id ) {
		return (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_votes' ) . ' WHERE target_type = %s AND target_id = %d AND val > 0', [ $kind, (int) $id ] );
	}

	/** Recompute ONE work's season-hearts bucket in EVERY current-season challenge that lists it
	 *  (scoped to that work — mirrors Economy::quester_touch). */
	public static function entry_touch( $kind, $work_id ) {
		$s    = Season::current();
		$rows = Data::all(
			'SELECT e.challenge_id FROM ' . Data::t( 'aq_challenge_entries' ) . ' e
			   JOIN ' . Data::t( 'aq_challenges' ) . ' c ON c.id = e.challenge_id
			  WHERE e.kind = %s AND e.work_id = %d AND c.season_key = %d',
			[ $kind, (int) $work_id, (int) $s['key'] ]
		);
		if ( ! $rows ) { return; }
		$hearts = (int) Data::col(
			'SELECT COALESCE(SUM(val),0) FROM ' . Data::t( 'aq_votes' ) . ' WHERE target_type = %s AND target_id = %d AND created >= %d AND created < %d',
			[ $kind, (int) $work_id, (int) $s['start'], (int) $s['end'] ]
		);
		foreach ( $rows as $r ) {
			Data::update( 'aq_challenge_entries', [ 'hearts' => $hearts ], [ 'challenge_id' => (int) $r['challenge_id'], 'work_id' => (int) $work_id ] );
		}
	}

	// ── Boards ──────────────────────────────────────────────────────────────────────────────

	/** The live board for a challenge row: entries by season hearts, live works only,
	 *  reciprocal heart-rings excluded, with prize targets for the current pool. */
	public static function board( $ch, $with_prizes = true ) {
		$kind = (string) $ch['kind'];
		$sk   = self::src( $kind );
		$s    = Season::current();
		$live = (int) $ch['season_key'] === (int) $s['key'];
		$bot  = (int) get_option( 'aq_artabot_uid', 0 );
		$rows = Data::all(
			'SELECT e.work_id, e.author_id, e.hearts, e.created, ' . $sk['cols'] . '
			   FROM ' . Data::t( 'aq_challenge_entries' ) . ' e ' . $sk['join'] . '
			  WHERE e.challenge_id = %d AND e.author_id <> %d
			  ORDER BY e.hearts DESC, e.created ASC LIMIT %d',
			[ (int) $ch['id'], $bot, self::BOARD_LIMIT ]
		);
		$rows = array_values( array_filter( $rows, static fn( $r ) => $r['status'] === 'published' ) );
		if ( $live ) { $rows = self::ring_adjust( $kind, $rows, (int) $s['start'], (int) $s['end'] ); }
		$pool  = self::pool( $ch );
		$names = self::author_names( $rows );
		$out   = [];
		foreach ( $rows as $i => $r ) {
			$out[] = [
				'work_id'  => (int) $r['work_id'],
				'title'    => (string) $r['title'],
				'media'    => (string) $r['media'],
				'url'      => ( $sk['url'] )( (int) $r['work_id'], (string) $r['slug'] ),
				'author'   => $names[ (int) $r['author_id'] ] ?? [ 'id' => (int) $r['author_id'], 'name' => 'Member', 'slug' => '' ],
				'hearts'   => (int) $r['hearts'],
				'rank'     => $i + 1,
				'prize'    => ( $with_prizes && $i < count( self::PODIUM ) && $pool > 0 ) ? (int) floor( $pool * self::PODIUM[ $i ] ) : 0,
			];
		}
		return $out;
	}

	/** Reciprocal-ring exclusion, hearts edition (same discipline as Economy::ring_adjust). */
	private static function ring_adjust( $kind, $rows, $start, $end ) {
		if ( count( $rows ) < 2 ) { return $rows; }
		$ids = array_values( array_unique( array_map( 'intval', array_column( $rows, 'author_id' ) ) ) );
		if ( count( $ids ) < 2 ) { return $rows; }
		$ph    = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
		$args  = array_merge( [ $kind ], $ids, $ids, [ (int) $start, (int) $end ] );
		$pairs = Data::all(
			'SELECT DISTINCT v.user_id voter, e.author_id author, v.target_id
			   FROM ' . Data::t( 'aq_votes' ) . ' v
			   JOIN ' . Data::t( 'aq_challenge_entries' ) . " e ON e.kind = v.target_type AND e.work_id = v.target_id
			  WHERE v.target_type = %s AND v.user_id IN ($ph) AND e.author_id IN ($ph)
			    AND v.created >= %d AND v.created < %d",
			$args
		);
		$m = [];
		foreach ( $pairs as $p ) { $m[ (int) $p['voter'] ][ (int) $p['author'] ] = ( $m[ (int) $p['voter'] ][ (int) $p['author'] ] ?? 0 ) + 1; }
		$cut = []; // author_id => hearts to subtract
		foreach ( $ids as $a ) {
			foreach ( $ids as $b ) {
				if ( $a >= $b ) { continue; }
				$ab = $m[ $a ][ $b ] ?? 0; $ba = $m[ $b ][ $a ] ?? 0;
				if ( $ab >= self::RING_MIN && $ba >= self::RING_MIN ) {
					$cut[ $b ] = ( $cut[ $b ] ?? 0 ) + $ab;
					$cut[ $a ] = ( $cut[ $a ] ?? 0 ) + $ba;
				}
			}
		}
		if ( ! $cut ) { return $rows; }
		foreach ( $rows as &$r ) {
			$u = (int) $r['author_id'];
			if ( isset( $cut[ $u ] ) ) { $r['hearts'] = max( 0, (int) $r['hearts'] - $cut[ $u ] ); }
		}
		unset( $r );
		usort( $rows, static fn( $x, $y ) => [ (int) $y['hearts'], (int) $x['created'] ] <=> [ (int) $x['hearts'], (int) $y['created'] ] );
		return $rows;
	}

	/** Public member cards (one pass, no N+1). */
	private static function author_names( $rows ) {
		$ids = array_values( array_unique( array_map( 'intval', array_column( $rows, 'author_id' ) ) ) );
		$out = [];
		foreach ( $ids as $id ) {
			$u = get_userdata( $id );
			$out[ $id ] = [ 'id' => $id, 'name' => $u ? $u->display_name : 'Member', 'slug' => $u ? $u->user_nicename : '' ];
		}
		return $out;
	}

	// ── Pool + settlement ───────────────────────────────────────────────────────────────────

	/** A challenge's current prize pool: 100% of its burned fees + any carried pool. */
	public static function pool( $ch ) {
		return (int) floor( (int) $ch['revenue'] * self::POOL_SHARE ) + (int) $ch['carried'];
	}

	/** Distinct hearters whose season-window hearts touched this challenge's entries. */
	private static function hearter_count( $ch, $start, $end ) {
		return (int) Data::col(
			'SELECT COUNT(DISTINCT v.user_id) FROM ' . Data::t( 'aq_votes' ) . ' v
			   JOIN ' . Data::t( 'aq_challenge_entries' ) . ' e ON e.kind = v.target_type AND e.work_id = v.target_id
			  WHERE e.challenge_id = %d AND v.val > 0 AND v.created >= %d AND v.created < %d',
			[ (int) $ch['id'], (int) $start, (int) $end ]
		);
	}

	/** Coins a member already holds from this challenge (idempotency anchor). Refs are keyed by
	 *  the challenge ID (unique forever), season-stamped for the audit trail. */
	private static function prize_earned( $ch, $uid ) {
		return (int) Data::col(
			'SELECT COALESCE(SUM(delta),0) FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'chprize' AND ref = %s",
			[ self::prize_ref( $ch, $uid ) ]
		);
	}

	private static function prize_ref( $ch, $uid ) {
		return 'ch' . (int) $ch['id'] . ':s' . (int) $ch['season_key'] . ':u' . (int) $uid;
	}

	/** Members holding net prize coins for a challenge (for claw-back), uid => net. */
	private static function prize_holders( $ch ) {
		global $wpdb;
		$like = $wpdb->esc_like( 'ch' . (int) $ch['id'] . ':s' . (int) $ch['season_key'] . ':u' ) . '%';
		$rows = Data::all( 'SELECT ref, SUM(delta) net FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason='chprize' AND ref LIKE %s GROUP BY ref HAVING SUM(delta) <> 0", [ $like ] );
		$uids = [];
		foreach ( $rows as $r ) { if ( preg_match( '/:u(\d+)$/', (string) $r['ref'], $m ) ) { $uids[ (int) $m[1] ] = (int) $r['net']; } }
		return $uids;
	}

	/** Settle one challenge for its season window — signed-delta rebalance; pays nothing when
	 *  gated or in shadow mode. Returns the pool it distributed against (0 when unpaid). */
	public static function settle( $ch, $start, $end ) {
		$pool    = self::pool( $ch );
		$authors = (int) Data::col( 'SELECT COUNT(DISTINCT author_id) FROM ' . Data::t( 'aq_challenge_entries' ) . ' WHERE challenge_id = %d', [ (int) $ch['id'] ] );
		$gate_ok = $pool > 0 && $authors >= self::MIN_AUTHORS && self::hearter_count( $ch, $start, $end ) >= self::MIN_HEARTERS;
		$live    = (bool) get_option( 'aq_challenge_payouts', false );
		if ( ! $gate_ok || ! $live ) {
			foreach ( self::prize_holders( $ch ) as $uid => $net ) {
				if ( $net !== 0 ) { Economy::credit_coins( $uid, -$net, 'chprize', self::prize_ref( $ch, $uid ) ); }
			}
			return 0;
		}
		$seen = [];
		$top  = array_slice( self::board( $ch, true ), 0, count( self::PODIUM ) );
		foreach ( $top as $row ) {
			$uid          = (int) $row['author']['id'];
			$seen[ $uid ] = true;
			$delta        = (int) $row['prize'] - self::prize_earned( $ch, $uid );
			if ( $delta !== 0 ) { Economy::credit_coins( $uid, $delta, 'chprize', self::prize_ref( $ch, $uid ) ); }
		}
		foreach ( self::prize_holders( $ch ) as $uid => $net ) {
			if ( isset( $seen[ $uid ] ) || $net === 0 ) { continue; }
			Economy::credit_coins( $uid, -$net, 'chprize', self::prize_ref( $ch, $uid ) );
		}
		return $pool;
	}

	/** Close + freeze every challenge whose season ended (lazy on read + the aq_season_reset
	 *  cron). Final settle, snapshot the podium, roll an unpaid pool into the kind's next
	 *  SYSTEM challenge. */
	public static function ensure_archived( $now = null ) {
		$s   = Season::current( $now );
		$cur = (int) $s['key'];
		$due = Data::all( 'SELECT * FROM ' . Data::t( 'aq_challenges' ) . " WHERE status = 'open' AND season_key < %d", [ $cur ] );
		foreach ( $due as $ch ) {
			$key   = (int) $ch['season_key'];
			$start = Season::reset_before( $key );
			$paid  = self::settle( $ch, $start, $key );
			$board = self::board_window( $ch, $start, $key );
			foreach ( $board as $row ) {
				if ( $row['rank'] > 10 ) { break; }
				$prize = $paid > 0 && $row['rank'] <= count( self::PODIUM ) ? (int) floor( $paid * self::PODIUM[ $row['rank'] - 1 ] ) : 0;
				Data::insert( 'aq_challenge_results', [
					'challenge_id' => (int) $ch['id'],
					'season_key' => $key, 'kind' => (string) $ch['kind'], 'place' => (int) $row['rank'],
					'user_id' => (int) $row['author']['id'], 'work_id' => (int) $row['work_id'],
					'hearts' => (int) $row['hearts'], 'prize' => $prize, 'created' => time(),
				] );
			}
			if ( $paid <= 0 ) {
				$next = self::next_system_row( (string) $ch['kind'], $cur );
				if ( $next ) { Data::bump( 'aq_challenges', [ 'id' => (int) $next['id'] ], 'carried', self::pool( $ch ) ); }
			}
			Data::update( 'aq_challenges', [ 'status' => 'settled' ], [ 'id' => (int) $ch['id'] ] );
		}
	}

	/** The current-season SYSTEM challenge row for a kind, created if absent (rollover target;
	 *  no recursion into ensure_archived). */
	private static function next_system_row( $kind, $key ) {
		global $wpdb;
		$slug = $kind . '-s' . (int) $key;
		$row  = Data::one( 'SELECT * FROM ' . Data::t( 'aq_challenges' ) . ' WHERE slug = %s', [ $slug ] );
		if ( $row ) { return $row; }
		$prev = $wpdb->suppress_errors( true );
		$id   = Data::insert( 'aq_challenges', [
			'kind' => $kind, 'season_key' => (int) $key, 'slug' => $slug,
			'title' => ucfirst( $kind ) . ' Challenge', 'owner_uid' => 0, 'status' => 'open', 'created' => Data::now(),
		] );
		$wpdb->suppress_errors( $prev );
		return Data::one( 'SELECT * FROM ' . Data::t( 'aq_challenges' ) . ' WHERE slug = %s', [ $slug ] );
	}

	/** The board recomputed for an arbitrary closed window (archival path). */
	private static function board_window( $ch, $start, $end ) {
		foreach ( Data::all( 'SELECT work_id FROM ' . Data::t( 'aq_challenge_entries' ) . ' WHERE challenge_id = %d', [ (int) $ch['id'] ] ) as $e ) {
			$hearts = (int) Data::col(
				'SELECT COALESCE(SUM(val),0) FROM ' . Data::t( 'aq_votes' ) . ' WHERE target_type = %s AND target_id = %d AND created >= %d AND created < %d',
				[ (string) $ch['kind'], (int) $e['work_id'], (int) $start, (int) $end ]
			);
			Data::update( 'aq_challenge_entries', [ 'hearts' => $hearts ], [ 'challenge_id' => (int) $ch['id'], 'work_id' => (int) $e['work_id'] ] );
		}
		return self::board( $ch, false );
	}

	// ── Endpoints ───────────────────────────────────────────────────────────────────────────

	/** One challenge, shaped for the board index. */
	private static function card( $ch ) {
		$owner = null;
		if ( (int) $ch['owner_uid'] > 0 ) {
			$u = get_userdata( (int) $ch['owner_uid'] );
			$owner = [ 'id' => (int) $ch['owner_uid'], 'name' => $u ? $u->display_name : 'Member', 'slug' => $u ? $u->user_nicename : '' ];
		}
		return [
			'id'        => (int) $ch['id'],
			'kind'      => (string) $ch['kind'],
			'title'     => (string) $ch['title'],
			'system'    => (int) $ch['owner_uid'] === 0,
			'owner'     => $owner,
			'pool'      => self::pool( $ch ),
			'entries'   => (int) $ch['entry_count'],
			'thread_id' => (int) $ch['thread_id'],
		];
	}

	/**
	 * One-time per-season backfill: seed the SYSTEM boards with works already published INSIDE
	 * this season's window before their auto-entry hook shipped (fee ₳0 — presence on the
	 * leaderboard, nothing added to the pot; their fees predate the frame). Option-guarded per
	 * season key; each insert is idempotent, so a partial run just completes on manual re-run.
	 */
	public static function backfill_season() {
		$s   = Season::current();
		$opt = 'aq_chal_backfill_' . (int) $s['key'];
		if ( get_option( $opt ) ) { return; }
		update_option( $opt, 1, false );
		$st = (int) $s['start'];
		$creative = [
			'book' => [ 'aq_documents', '' ], 'music' => [ 'aq_tracks', 'music' ], 'audiobook' => [ 'aq_tracks', 'audiobook' ],
			'animation' => [ 'aq_animations', '' ], 'film' => [ 'aq_films', '' ], 'illustration' => [ 'aq_illustrations', '' ],
		];
		foreach ( $creative as $kind => [ $table, $disc ] ) {
			$rows = Data::all(
				'SELECT id, author_id FROM ' . Data::t( $table ) . " WHERE status = 'published' AND created >= %d" . ( $disc !== '' ? ' AND kind = %s' : '' ),
				$disc !== '' ? [ $st, $disc ] : [ $st ]
			);
			foreach ( $rows as $r ) { self::enter( $kind, (int) $r['id'], (int) $r['author_id'], 0 ); self::entry_touch( $kind, (int) $r['id'] ); }
		}
		foreach ( Data::all( 'SELECT id, author_id FROM ' . Data::t( 'aq_submissions' ) . " WHERE status = 'accepted' AND updated >= %d", [ $st ] ) as $r ) {
			self::enter( 'paper', (int) $r['id'], (int) $r['author_id'], 0 ); self::entry_touch( 'paper', (int) $r['id'] );
		}
		// Datasets/models stamp MySQL datetimes — filter in PHP (both sets are small).
		foreach ( Data::all( 'SELECT id, owner_uid, created FROM ' . Data::t( 'aq_competitions' ) . " WHERE status IN ('active','closed')" ) as $r ) {
			if ( $r['created'] && strtotime( $r['created'] . ' UTC' ) >= $st ) { self::enter( 'dataset', (int) $r['id'], (int) $r['owner_uid'], 0 ); self::entry_touch( 'dataset', (int) $r['id'] ); }
		}
		foreach ( Data::all( 'SELECT id, uid, updated FROM ' . Data::t( 'aq_comp_subs' ) . ' WHERE verified = 1' ) as $r ) {
			if ( $r['updated'] && strtotime( $r['updated'] . ' UTC' ) >= $st ) { self::enter( 'model', (int) $r['id'], (int) $r['uid'], 0 ); self::entry_touch( 'model', (int) $r['id'] ); }
		}
	}

	/** GET /challenges — THE BOARD INDEX: every open challenge this season (the 9 seasonal ones
	 *  pinned first, then member challenges by pot size). */
	public static function list_all( $req ) {
		self::ensure_archived();
		$s = Season::current();
		foreach ( self::KINDS as $kind ) { self::ensure_open( $kind ); } // the seasonal boards always exist
		self::backfill_season(); // one-time per season: seat already-published works (option-guarded)
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_challenges' ) . " WHERE season_key = %d AND status = 'open'", [ (int) $s['key'] ] );
		$sys = []; $member = [];
		foreach ( $rows as $ch ) {
			if ( (int) $ch['owner_uid'] === 0 ) { $sys[ (string) $ch['kind'] ] = self::card( $ch ); }
			else { $member[] = self::card( $ch ); }
		}
		usort( $member, static fn( $a, $b ) => [ $b['pool'], $b['entries'] ] <=> [ $a['pool'], $a['entries'] ] );
		$items = [];
		foreach ( self::KINDS as $kind ) { if ( isset( $sys[ $kind ] ) ) { $items[] = $sys[ $kind ]; } }
		$items = array_merge( $items, $member );
		return [
			'items'        => $items,
			'season'       => [ 'key' => (int) $s['key'], 'label' => $s['label'], 'ends' => (int) $s['end'], 'closes_in' => (int) $s['closes_in'], 'ends_label' => $s['ends_label'] ],
			'payouts_live' => (bool) get_option( 'aq_challenge_payouts', false ),
			'create_fee'   => self::CREATE_FEE,
			'enter_fee'    => self::ENTER_FEE,
			'pool_share'   => self::POOL_SHARE,
			'podium'       => self::PODIUM,
			'min_authors'  => self::MIN_AUTHORS,
			'min_hearters' => self::MIN_HEARTERS,
		];
	}

	/** GET /challenges/{key} — one challenge: header + prompt + hearts board + the caller's
	 *  enterable works (member challenges) + past seasons (system). `key` = numeric id or a
	 *  kind name (→ this season's system challenge). ?season= serves a frozen system season. */
	public static function detail( $req ) {
		self::ensure_archived();
		$key  = (string) Rest::p( $req, 'key', '' );
		$s    = Season::current();
		$want = Rest::pint( $req, 'season', 0 );
		if ( $want && $want !== (int) $s['key'] && ! ctype_digit( $key ) ) {
			// A frozen past season of a KIND's system challenge, straight from the snapshot.
			$kind = sanitize_key( $key );
			if ( ! in_array( $kind, self::KINDS, true ) ) { return Rest::err( 'not_found', 'No such challenge', 404 ); }
			return [
				'kind' => $kind, 'title' => ucfirst( $kind ) . ' Challenge', 'system' => true,
				'season' => $want, 'frozen' => true,
				'board' => self::frozen_board( $kind, $want ), 'seasons' => self::season_list( $kind ),
			];
		}
		$ch = self::row_by_key( $key );
		if ( ! $ch ) { return Rest::err( 'not_found', 'No such challenge', 404 ); }
		if ( $ch['status'] !== 'open' ) {
			// A settled challenge (member or old system row fetched by id): its frozen record.
			$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_challenge_results' ) . ' WHERE challenge_id = %d ORDER BY place ASC', [ (int) $ch['id'] ] );
			return array_merge( self::card( $ch ), [
				'brief' => (string) ( $ch['brief'] ?? '' ), 'season' => (int) $ch['season_key'], 'frozen' => true,
				'board' => self::results_board( (string) $ch['kind'], $rows ), 'seasons' => [],
			] );
		}
		$uid = Rest::uid();
		$out = array_merge( self::card( $ch ), [
			'brief'        => (string) ( $ch['brief'] ?? '' ),
			'season'       => [ 'key' => (int) $s['key'], 'label' => $s['label'], 'ends' => (int) $s['end'], 'closes_in' => (int) $s['closes_in'], 'ends_label' => $s['ends_label'] ],
			'carried'      => (int) $ch['carried'],
			'board'        => self::board( $ch ),
			'entered'      => (bool) ( $uid && Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_challenge_entries' ) . ' WHERE challenge_id = %d AND author_id = %d LIMIT 1', [ (int) $ch['id'], $uid ] ) ),
			'payouts_live' => (bool) get_option( 'aq_challenge_payouts', false ),
			'enter_fee'    => self::ENTER_FEE,
			'gate'         => [ 'min_authors' => self::MIN_AUTHORS, 'min_hearters' => self::MIN_HEARTERS ],
			'seasons'      => (int) $ch['owner_uid'] === 0 ? self::season_list( (string) $ch['kind'] ) : [],
		] );
		// MEMBER challenges: the caller's enterable works (published this season = in the kind's
		// system challenge; not yet in this one) — powers the one-tap enter picker.
		if ( $uid && (int) $ch['owner_uid'] > 0 ) {
			$sys = self::ensure_open( (string) $ch['kind'] );
			$sk  = self::src( (string) $ch['kind'] );
			$rows = ! $sys ? [] : Data::all(
				'SELECT e.work_id, ' . $sk['cols'] . ' FROM ' . Data::t( 'aq_challenge_entries' ) . ' e ' . $sk['join'] . '
				  WHERE e.challenge_id = %d AND e.author_id = %d
				    AND e.work_id NOT IN ( SELECT work_id FROM ' . Data::t( 'aq_challenge_entries' ) . ' WHERE challenge_id = %d )',
				[ (int) $sys['id'], $uid, (int) $ch['id'] ]
			);
			$out['my_works'] = array_values( array_map(
				static fn( $r ) => [ 'work_id' => (int) $r['work_id'], 'title' => (string) $r['title'] ],
				array_filter( $rows, static fn( $r ) => $r['status'] === 'published' )
			) );
		}
		return $out;
	}

	/** A frozen board straight from result rows. */
	private static function results_board( $kind, $rows ) {
		$out = [];
		foreach ( $rows as $r ) {
			$w = self::work( $kind, (int) $r['work_id'] );
			$u = get_userdata( (int) $r['user_id'] );
			$out[] = [
				'work_id' => (int) $r['work_id'], 'title' => $w ? (string) $w['title'] : '', 'media' => $w ? (string) $w['media'] : '',
				'url' => $w ? (string) $w['url'] : '', 'hearts' => (int) $r['hearts'], 'rank' => (int) $r['place'], 'prize' => (int) $r['prize'],
				'author' => [ 'id' => (int) $r['user_id'], 'name' => $u ? $u->display_name : 'Member', 'slug' => $u ? $u->user_nicename : '' ],
			];
		}
		return $out;
	}

	/** A kind's frozen system-season board (pre-1.62.3 rows have challenge_id 0 — match by kind). */
	private static function frozen_board( $kind, $season ) {
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_challenge_results' ) . ' WHERE season_key = %d AND kind = %s ORDER BY place ASC', [ (int) $season, $kind ] );
		return self::results_board( $kind, $rows );
	}

	/** Past seasons with a frozen result for a kind (newest first). */
	private static function season_list( $kind ) {
		$rows = Data::all( 'SELECT DISTINCT season_key FROM ' . Data::t( 'aq_challenge_results' ) . ' WHERE kind = %s ORDER BY season_key DESC LIMIT 24', [ $kind ] );
		return array_map( static fn( $r ) => [ 'key' => (int) $r['season_key'], 'label' => Season::label( Season::reset_before( (int) $r['season_key'] ), (int) $r['season_key'] ) ], $rows );
	}

	/** GET /challenge-certs?user= — derived participation certificates (+ podium medals). */
	public static function certificates( $req ) {
		$uid = Rest::pint( $req, 'user', 0 ) ?: Rest::uid();
		if ( ! $uid ) { return Rest::err( 'bad_input', 'Whose certificates?' ); }
		$rows = Data::all(
			'SELECT e.kind, c.season_key FROM ' . Data::t( 'aq_challenge_entries' ) . ' e
			   JOIN ' . Data::t( 'aq_challenges' ) . ' c ON c.id = e.challenge_id
			  WHERE e.author_id = %d GROUP BY c.season_key, e.kind ORDER BY c.season_key DESC LIMIT 200',
			[ (int) $uid ]
		);
		$names = [ 1 => 'gold', 2 => 'silver', 3 => 'bronze' ];
		$cur   = (int) Season::current()['key'];
		$out   = [];
		foreach ( $rows as $r ) {
			$key   = (int) $r['season_key'];
			$place = (int) Data::col(
				'SELECT MIN(place) FROM ' . Data::t( 'aq_challenge_results' ) . ' WHERE season_key = %d AND kind = %s AND user_id = %d',
				[ $key, (string) $r['kind'], (int) $uid ]
			);
			$out[] = [
				'kind'   => (string) $r['kind'],
				'season' => $key,
				'label'  => Season::label( Season::reset_before( $key ), $key ),
				'status' => $key === $cur ? 'in_progress' : 'certified',
				'place'  => $place ?: 0,
				'medal'  => $place >= 1 && $place <= 3 ? $names[ $place ] : '',
			];
		}
		return [ 'items' => $out ];
	}

	/** GET /shelf — the caller's shelf meter. */
	public static function shelf( $req ) {
		$uid    = Rest::uid();
		$points = Economy::points_balance( $uid );
		return [
			'used'  => self::shelf_used( $uid ),
			'quota' => Economy::shelf_quota( $uid ),
			'tier'  => Economy::tier( $points ),
			'quotas'=> Economy::TIER_QUOTA,
		];
	}
}
