<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Contributions — the evolution of the old one-shot bug form into a conversational,
 * Claude-triaged ticket system.
 *
 * A member opens a ticket of one KIND (bug | feature | content | suggestion). Claude triages it
 * in a back-and-forth (Assistant::triage / Assistant::reply → aq_ticket_messages) and, when the
 * request is concrete enough, flips it to 'queued' for the autonomous worker (tools/ticket-agent/),
 * which ships a fix and reports progress here via the agent_* endpoints.
 *
 * Two invariants:
 *   1. Only the OWNER can resolve (resolve()). The worker may set 'shipped' but never 'resolved'.
 *   2. Resolving awards a flat 1 point on the kind's OWN track — each kind is its own contributor
 *      role, ranked separately on the leaderboard (bug→Sentinel, feature→Visionary,
 *      content→Curator, suggestion→Sage). The award is idempotent by ref 'ticket'.id, so
 *      reopen→resolve cycles can never farm points.
 */
final class Tickets {

	/** The single source of truth for kinds → points track → contributor role label.
	 *  Track === kind, so adding a kind is one row here + one tab on the frontend Rankings page. */
	const KINDS = [
		'bug'        => [ 'track' => 'bug',        'role' => 'Sentinel'  ],
		'feature'    => [ 'track' => 'feature',    'role' => 'Visionary' ],
		'content'    => [ 'track' => 'content',    'role' => 'Curator'   ],
		'suggestion' => [ 'track' => 'suggestion', 'role' => 'Sage'      ],
	];

	/** Statuses the autonomous worker is allowed to set (it can NEVER resolve — only the owner can).
	 *  'awaiting' = held pending the operator's OK for a major architectural change (see agent_approval). */
	const AGENT_STATUSES = [ 'in_progress', 'shipped', 'rejected', 'duplicate', 'queued', 'awaiting' ];

	/** A run is considered orphaned (its worker died) after this long 'in_progress' — agent_queue then
	 *  re-queues it so the autopilot retries and a ticket is never stuck. Must exceed the longest legit
	 *  run (agent timeout ~25m + build + deploy), so a live run is never re-queued out from under itself. */
	const STALE_SECS = 2700; // 45 min

	// ── helpers ───────────────────────────────────────────────────────────────
	private static function row( $id ) {
		return Data::one( 'SELECT * FROM ' . Data::t( 'aq_tickets' ) . ' WHERE id = %d', [ (int) $id ] );
	}

	/** The idempotency key for a member's contribution — what makes a re-submit collapse onto the one
	 *  ticket instead of opening a duplicate. It hashes the FULL content (kind + title + body, with
	 *  whitespace/case normalized), NOT the title alone: ArtaBot auto-generates short titles from a chat,
	 *  so a title-only key mistook two genuinely DIFFERENT reports for duplicates and silently dropped the
	 *  second (issue #36 — "new issues incorrectly flagged as duplicates"). Now only a true re-submit of
	 *  the same report collapses; a new issue that merely shares a title opens fresh. Per-user (uid baked
	 *  in); md5 → CHAR(32), matching the column. */
	/**
	 * A screenshot URL we will store, or '' — it must be a file on THIS site (the uploads dir or our
	 * own media route). Anything else is dropped rather than refused: a report is never worth losing
	 * over its attachment, and the body still describes the problem.
	 */
	private static function own_upload_url( $url ) {
		$url = esc_url_raw( trim( (string) $url ) );
		if ( $url === '' ) { return ''; }
		$host = strtolower( (string) wp_parse_url( $url, PHP_URL_HOST ) );
		$mine = strtolower( (string) wp_parse_url( home_url( '/' ), PHP_URL_HOST ) );
		if ( $host === '' || $host !== $mine ) { return ''; }
		$up   = wp_upload_dir();
		$base = isset( $up['baseurl'] ) ? (string) $up['baseurl'] : '';
		$ok   = ( $base !== '' && strpos( $url, $base ) === 0 )
			|| strpos( $url, home_url( '/wp-json/' . Rest::NS . '/' ) ) === 0;
		return $ok ? $url : '';
	}

	private static function dedup_hash( $uid, $kind, $title, $body ) {
		$norm = static function ( $s ) { return preg_replace( '/\s+/', ' ', trim( mb_strtolower( (string) $s ) ) ); };
		return md5( (int) $uid . '|' . $kind . '|' . $norm( $title ) . '|' . $norm( $body ) );
	}

	/** Append a message to a ticket and bump its denormalized counter. Returns the new message id. */
	private static function add_message( $ticket_id, $role, $body, $meta = null ) {
		$mid = Data::insert( 'aq_ticket_messages', [
			'ticket_id' => (int) $ticket_id,
			'role'      => $role,
			'body'      => (string) $body,
			'meta'      => $meta === null ? null : Data::enc( $meta ),
			'created'   => Data::now(),
		] );
		Data::bump( 'aq_tickets', [ 'id' => (int) $ticket_id ], 'msg_count', 1 );
		return $mid;
	}

	/** Public shape of a ticket row (the DB is public by design, so nothing is redacted). */
	private static function shape( $t ) {
		$kind = isset( self::KINDS[ $t['kind'] ] ) ? $t['kind'] : 'suggestion';
		$uid  = (int) $t['user_id'];
		$u    = $uid ? get_userdata( $uid ) : null;
		return [
			'id'         => (int) $t['id'],
			'user_id'    => $uid,
			// Contributions are a PUBLIC board (like the discussion boards), so every row carries its
			// author's display name for attribution — "Visitor" for an ownerless, ArtaBot-filed uid-0
			// ticket. 'mine' matches the server's reply/resolve permission EXACTLY (owner-only, no admin
			// override) so the UI never offers an action that would 403; public viewers always get
			// mine=false. The $uid > 0 guard keeps an ownerless ticket from reading as "mine" to every
			// signed-out viewer (0 === 0 — they could not reply/resolve anyway, those routes need auth).
			'author'     => $uid ? ( $u ? $u->display_name : 'Quester' ) : 'Visitor',
			'mine'       => $uid > 0 && $uid === Rest::uid(),
			'kind'       => $kind,
			'role'       => self::KINDS[ $kind ]['role'],
			'title'      => $t['title'],
			'body'       => $t['body'],
			'screenshot' => $t['screenshot'] ?? '',
			'where_url'  => $t['where_url'],
			'status'     => $t['status'],
			'msg_count'  => (int) $t['msg_count'],
			'branch'     => $t['branch'],
			'pr_url'     => $t['pr_url'],
			'deploy_sha' => $t['deploy_sha'],
			'arch_ok'    => (int) ( $t['arch_ok'] ?? 0 ),
			'attempts'   => (int) ( $t['attempts'] ?? 0 ),
			'points'     => (int) $t['points_awarded'],
			'created'    => (int) $t['created'],
			'resolved_at'=> (int) $t['resolved_at'],
		];
	}

	private static function shape_msg( $m ) {
		return [
			'id'   => (int) $m['id'],
			'role' => $m['role'],
			'body' => (string) $m['body'],
			'meta' => Data::dec( $m['meta'] ?? null ),
			'at'   => (int) $m['created'],
		];
	}

	/** The member's original chat words that triggered a chat-filed contribution (#121), recovered from
	 *  the opened-from-chat note's meta — '' for a form-filed ticket, or one filed without a distinct
	 *  prompt. The note is always the FIRST system message on the ticket, so this is one indexed read. */
	private static function chat_prompt( $ticket_id ) {
		$row  = Data::one(
			'SELECT meta FROM ' . Data::t( 'aq_ticket_messages' ) . " WHERE ticket_id = %d AND role = 'system' ORDER BY id ASC LIMIT 1",
			[ (int) $ticket_id ]
		);
		$meta = $row ? Data::dec( $row['meta'] ?? null ) : null;
		return is_array( $meta ) && ! empty( $meta['chat_prompt'] ) ? (string) $meta['chat_prompt'] : '';
	}

	// ── member endpoints ────────────────────────────────────────────────────────
	/** POST tickets {kind,title,body,where} — open a contribution. No points here (awarded on resolve). */
	public static function create( $req ) {
		if ( Rest::throttle( 'ticket', 20, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid   = Rest::uid();
		$kind  = sanitize_key( (string) Rest::p( $req, 'kind', 'suggestion' ) );
		if ( ! isset( self::KINDS[ $kind ] ) ) { $kind = 'suggestion'; }
		$title = sanitize_text_field( (string) Rest::p( $req, 'title', '' ) );
		$body  = sanitize_textarea_field( (string) Rest::p( $req, 'body', '' ) );
		$where = esc_url_raw( (string) Rest::p( $req, 'where', Rest::p( $req, 'page_url', '' ) ) );
		// A screenshot is OUR OWN uploaded file — the form posts it to the media endpoint first and
		// sends back the resulting URL (the same contract open_from_chat() documents). Accepting any
		// URL here meant an arbitrary third-party address got stored, then rendered in the operator's
		// triage view and handed to the ArtaDev agent, which fetches it: a member-chosen outbound
		// request from our infrastructure, and a tracking pixel pointed at whoever opens the ticket.
		// Keep the field, require it to be ours.
		$shot = self::own_upload_url( (string) Rest::p( $req, 'screenshot', '' ) );
		if ( mb_strlen( $title ) < 4 || mb_strlen( $body ) < 10 ) {
			return Rest::err( 'bad_input', 'Give it a clear title and a sentence or two of detail' );
		}
		// A screenshot helps a visual report enormously, but it is NEVER required: on phones taking or
		// attaching one is often impossible (e.g. Android blocks captures in incognito/work profiles),
		// and a hard gate here was literally blocking members from reporting bugs at all. The form
		// encourages one; ArtaBot asks for it in triage when it would genuinely help.
		$hash = self::dedup_hash( $uid, $kind, $title, $body );
		if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_tickets' ) . ' WHERE hash = %s', [ $hash ] ) ) {
			return Rest::err( 'dupe', 'You already opened this one' );
		}
		$id = Data::insert( 'aq_tickets', [
			'user_id'    => $uid,
			'kind'       => $kind,
			'title'      => $title,
			'body'       => $body,
			'screenshot' => $shot,
			'where_url'  => $where,
			'status'    => 'open',
			'hash'      => $hash,
			'created'   => Data::now(),
		] );
		// Seed the conversation with the member's opening message, then let Claude triage.
		self::add_message( $id, 'user', $title . "\n\n" . $body );
		Assistant::triage( $id );
		return [ 'ok' => true, 'id' => $id ];
	}

	/** Open a contribution on a member's — or, with $uid = 0, a signed-out visitor's — behalf, straight
	 *  from an ArtaBot chat — no REST wrapper, throttle, or screenshot gate (the chat itself is the
	 *  context, so a bug needn't carry a shot; the anon path adds its own per-IP cap in the caller).
	 *  Bypassing triage also saves a whole Claude round-trip: ArtaBot has already classified it, so we
	 *  open it pre-triaged and (when concrete) queue it straight to the autonomous worker. Idempotent by
	 *  the same (content,user) hash as create(): a true re-submit just returns the existing ticket, but a
	 *  genuinely new report that merely shares a title opens fresh (issue #36), never collapsed as a dupe.
	 *  All anonymous filings share the uid-0 hash bucket, so two visitors reporting the identical thing
	 *  converge on one ticket (with its link) — by design.
	 *  $screenshot (optional) is the URL of an image the member shared in the chat that produced this
	 *  contribution, already saved to our uploads dir — it lands in the screenshot column so the original
	 *  shows on the detail page, exactly like a form-filed shot (#120).
	 *  $chat_prompt (optional) is the member's ORIGINAL chat words that triggered this filing. ArtaBot
	 *  files a cleaned-up title/body, so the raw message is otherwise lost — we preserve it on the
	 *  opened-from-chat note's meta (no schema change) to show alongside the screenshot for the full
	 *  context behind the report on the detail page (#121).
	 *  Returns [ 'id', 'kind', 'status', 'new' ], or null if the request is too thin to act on. */
	public static function open_from_chat( $uid, $kind, $title, $body, $where = '', $queue = true, $screenshot = '', $chat_prompt = '' ) {
		$uid = max( 0, (int) $uid ); // 0 = a signed-out visitor: the ticket is ownerless (author "Visitor")
		$kind  = isset( self::KINDS[ $kind ] ) ? $kind : 'suggestion';
		$title = sanitize_text_field( (string) $title );
		$body  = sanitize_textarea_field( (string) $body );
		if ( mb_strlen( $title ) < 4 || mb_strlen( $body ) < 10 ) { return null; }
		$hash     = self::dedup_hash( $uid, $kind, $title, $body );
		$existing = Data::one( 'SELECT id, kind, status FROM ' . Data::t( 'aq_tickets' ) . ' WHERE hash = %s', [ $hash ] );
		if ( $existing ) {
			return [ 'id' => (int) $existing['id'], 'kind' => $existing['kind'], 'status' => $existing['status'], 'new' => false ];
		}
		$status = $queue ? 'queued' : 'open';
		$id = Data::insert( 'aq_tickets', [
			'user_id'    => $uid,
			'kind'       => $kind,
			'title'      => $title,
			'body'       => $body,
			'screenshot' => esc_url_raw( (string) $screenshot ),
			'where_url'  => esc_url_raw( (string) $where ),
			'status'     => $status,
			'hash'       => $hash,
			'created'    => Data::now(),
		] );
		self::add_message( $id, 'user', $title . "\n\n" . $body );
		// Preserve the member's original chat words on the opened-from-chat note's meta (#121), so the
		// detail page can show the raw message behind ArtaBot's cleaned-up title/body. Skipped when it is
		// just the image-only placeholder or merely repeats the body — there'd be no extra context to show.
		$prompt = sanitize_textarea_field( (string) $chat_prompt );
		if ( $prompt === '[shared a screenshot]' || trim( $prompt ) === trim( $body ) ) { $prompt = ''; }
		self::add_message( $id, 'system',
			'Opened by ' . Assistant::NAME . ' from a chat with ' . ( $uid ? 'the member' : 'a visitor' )
			. ( $queue ? ', and queued for the autonomous developer.' : '.' ),
			$prompt !== '' ? [ 'chat_prompt' => $prompt ] : null );
		return [ 'id' => (int) $id, 'kind' => $kind, 'status' => $status, 'new' => true ];
	}

	/** POST tickets/upload {image} — store a screenshot (base64 data URL) and return its URL.
	 *  Accepts PNG/JPEG/WebP/GIF up to 6 MB; saved to the uploads dir (public, like all media). */
	public static function upload( $req ) {
		if ( Rest::throttle( 'ticket_up', 40, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$url = self::save_data_url_image( (string) Rest::p( $req, 'image', '' ), Rest::uid() );
		if ( $url === '' ) { return Rest::err( 'bad_image', 'Attach a PNG, JPEG, WebP or GIF under 6 MB' ); }
		return [ 'ok' => true, 'url' => $url ];
	}

	/** Decode + store a base64 image data URL (PNG/JPEG/WebP/GIF, ≤6 MB) in the public uploads dir and
	 *  return its URL — or '' if it isn't a supported, in-bounds image (fail-open, never throws). Shared by
	 *  the upload endpoint and ArtaBot's chat-filing path (#120) so both store through ONE vetted route
	 *  (same format allow-list + size cap), and a stored URL always resolves back to a real uploads file. */
	public static function save_data_url_image( $data_url, $uid = 0 ) {
		if ( ! preg_match( '#^data:image/(png|jpe?g|webp|gif);base64,(.+)$#s', (string) $data_url, $m ) ) { return ''; }
		$ext   = strtolower( $m[1] );
		$ext   = ( $ext === 'jpeg' || $ext === 'jpg' ) ? 'jpg' : $ext;
		$bytes = base64_decode( $m[2], true );
		if ( $bytes === false || $bytes === '' || strlen( $bytes ) > 6 * 1024 * 1024 ) { return ''; }
		$name = 'ticket-' . (int) $uid . '-' . time() . '-' . wp_generate_password( 6, false ) . '.' . $ext;
		$up   = wp_upload_bits( $name, null, $bytes );
		return ( empty( $up['error'] ) && ! empty( $up['url'] ) ) ? (string) $up['url'] : '';
	}

	/** GET tickets?scope=mine|all&kind=&cursor= — keyset list. */
	public static function list( $req ) {
		$scope  = sanitize_key( (string) Rest::p( $req, 'scope', 'all' ) );
		$kind   = sanitize_key( (string) Rest::p( $req, 'kind', '' ) );
		$cursor = Rest::pint( $req, 'cursor', 0 );
		$where  = [];
		$args   = [];
		if ( $scope === 'mine' ) {
			$uid = Rest::uid();
			if ( ! $uid ) { return [ 'items' => [], 'next' => null ]; }
			$where[] = 'user_id = %d'; $args[] = $uid;
		}
		if ( isset( self::KINDS[ $kind ] ) ) { $where[] = 'kind = %s'; $args[] = $kind; }
		[ $rows, $next ] = Data::page( 'aq_tickets', implode( ' AND ', $where ), $args, $cursor, 30 );
		return [ 'items' => array_map( [ self::class, 'shape' ], $rows ), 'next' => $next ];
	}

	/** GET tickets/(id)?cursor= — a ticket plus its conversation (oldest-first, keyset). */
	public static function get( $req ) {
		$t = self::row( Rest::pint( $req, 'id', 0 ) );
		if ( ! $t ) { return Rest::err( 'not_found', 'No such ticket', 404 ); }
		$cursor = Rest::pint( $req, 'cursor', 0 );
		[ $rows, $next ] = Data::page( 'aq_ticket_messages', 'ticket_id = %d', [ (int) $t['id'] ], $cursor, 100, 'ASC' );
		$ticket = self::shape( $t );
		// The original chat prompt that triggered a chat-filed contribution (#121) — only on the detail
		// view, so the board list never pays for it.
		$ticket['chat_prompt'] = self::chat_prompt( (int) $t['id'] );
		return [
			'ticket'   => $ticket,
			'messages' => [ 'items' => array_map( [ self::class, 'shape_msg' ], $rows ), 'next' => $next ],
		];
	}

	/** POST tickets/(id)/message {body,image?} — owner adds a turn (text and/or a screenshot); Claude replies. */
	public static function post_message( $req ) {
		if ( Rest::throttle( 'ticket', 20, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$t = self::row( Rest::pint( $req, 'id', 0 ) );
		if ( ! $t ) { return Rest::err( 'not_found', 'No such ticket', 404 ); }
		if ( (int) $t['user_id'] !== Rest::uid() ) { return Rest::err( 'forbidden', 'Only the author can reply here', 403 ); }
		$body = sanitize_textarea_field( (string) Rest::p( $req, 'body', '' ) );
		// Optional screenshot pasted/attached in the reply box (#48): the client stores it via
		// tickets/upload first and sends the resulting URL here, kept on the message as meta.image.
		// Accept ONLY our own uploads dir — an arbitrary host must never render in the (public)
		// thread or be fetched for triage.
		$img = esc_url_raw( (string) Rest::p( $req, 'image', '' ) );
		if ( $img !== ''
			&& ( strpos( $img, trailingslashit( (string) wp_upload_dir()['baseurl'] ) ) !== 0
				|| strpos( $img, '..' ) !== false ) ) { // no path tricks — image_block maps this URL to a file
			return Rest::err( 'bad_image', 'Attach the screenshot through the reply box' );
		}
		if ( mb_strlen( $body ) < 1 ) {
			if ( $img === '' ) { return Rest::err( 'bad_input', 'Say something' ); }
			$body = '[shared a screenshot]'; // the same placeholder the ArtaBot chat stores for an image-only turn
		}
		self::add_message( (int) $t['id'], 'user', $body, $img === '' ? null : [ 'image' => $img ] );
		$reply = Assistant::reply( (int) $t['id'], $img );
		return [ 'ok' => true, 'reply' => $reply ];
	}

	/** POST tickets/(id)/resolve — OWNER ONLY. Closes the ticket and awards the single point. */
	public static function resolve( $req ) {
		$t = self::row( Rest::pint( $req, 'id', 0 ) );
		if ( ! $t ) { return Rest::err( 'not_found', 'No such ticket', 404 ); }
		$uid = Rest::uid();
		if ( (int) $t['user_id'] !== $uid ) { return Rest::err( 'forbidden', 'Only you can resolve your ticket', 403 ); }
		$kind  = isset( self::KINDS[ $t['kind'] ] ) ? $t['kind'] : 'suggestion';
		$track = self::KINDS[ $kind ]['track'];
		$role  = self::KINDS[ $kind ]['role'];
		if ( $t['status'] !== 'resolved' ) {
			Data::update( 'aq_tickets', [
				'status'         => 'resolved',
				'points_awarded' => 1,
				'resolved_by'    => $uid,
				'resolved_at'    => Data::now(),
			], [ 'id' => (int) $t['id'] ] );
			// Idempotent per (user, track, ref): reopen→resolve can never double-award.
			Economy::award_points( $uid, 1, $track, 'ticket' . $t['id'] );
			self::add_message( (int) $t['id'], 'system', 'Marked resolved — +1 ' . $role . ' point. Thank you' );
		}
		return [ 'ok' => true, 'points' => 1, 'track' => $track ];
	}

	/** POST tickets/(id)/reopen — OWNER ONLY. Points stay (append-only); re-resolve won't re-award. */
	public static function reopen( $req ) {
		$t = self::row( Rest::pint( $req, 'id', 0 ) );
		if ( ! $t ) { return Rest::err( 'not_found', 'No such ticket', 404 ); }
		if ( (int) $t['user_id'] !== Rest::uid() ) { return Rest::err( 'forbidden', 'Only you can reopen your ticket', 403 ); }
		// Reopen RE-QUEUES for the autonomous developer (a fresh pass) rather than parking in 'open', where
		// nothing polls it — so "please change more" is actually picked up (→ 'in_progress' when claimed).
		// Points already earned stay (append-only; re-resolve is idempotent and never re-awards).
		Data::update( 'aq_tickets', [ 'status' => 'queued', 'attempts' => 0, 'retry_after' => 0 ], [ 'id' => (int) $t['id'] ] );
		self::add_message( (int) $t['id'], 'system', 'Reopened — back in the queue for another pass' );
		return [ 'ok' => true, 'status' => 'queued' ];
	}

	// ── worker endpoints (auth 'worker' — the external autonomous agent) ─────────
	/** GET agent/queue — claim up to N queued tickets atomically (queued → in_progress).
	 *  ?peek=1 returns the queued tickets WITHOUT claiming (read-only — for dry-run / monitoring). */
	public static function agent_queue( $req ) {
		$limit = max( 1, min( 10, Rest::pint( $req, 'limit', 3 ) ) );
		$peek  = Rest::pint( $req, 'peek', 0 );
		$now   = Data::now();
		if ( ! $peek ) {
			// Crash recovery: a worker that died leaves its ticket 'in_progress' forever. Re-queue any run
			// orphaned past STALE_SECS so the autopilot retries it — a ticket is NEVER stuck. STALE_SECS
			// exceeds the longest legit run, so a live run is never re-queued out from under itself.
			$GLOBALS['wpdb']->query( $GLOBALS['wpdb']->prepare(
				'UPDATE ' . Data::t( 'aq_tickets' ) . " SET status = 'queued' WHERE status = 'in_progress' AND claimed_at > 0 AND claimed_at < %d",
				$now - self::STALE_SECS
			) );
		}
		// Only tickets whose backoff has elapsed are eligible (retry_after defaults to 0 = immediately).
		// PRIORITY order, not FIFO — the worker ships ONE ticket at a time, so the pick order IS the
		// roadmap. Sort keys, most significant first:
		//   1. arch_ok ASC  — a big APPROVED architectural change (economy/payments/schema/auth) goes
		//      LAST, so it never blocks the quick safe fixes and is shipped when the queue is clear and
		//      watched closely; everyday changes drain first.
		//   2. attempts ASC — a FRESH ticket before one that already failed, so a hard/poison ticket can
		//      never monopolise the single-flight worker; a transient failure simply rotates to the back
		//      and comes round again.
		//   3. kind        — bugs before features before content/suggestions (broken things first).
		//   4. created/id  — oldest first (fairness — nothing starves).
		$rows = Data::all(
			'SELECT * FROM ' . Data::t( 'aq_tickets' ) . " WHERE status = 'queued' AND retry_after <= %d"
			. " ORDER BY arch_ok ASC, attempts ASC,"
			. " CASE kind WHEN 'bug' THEN 0 WHEN 'feature' THEN 1 WHEN 'content' THEN 2 ELSE 3 END ASC,"
			. ' created ASC, id ASC LIMIT %d',
			[ $now, $limit ]
		);
		$out = [];
		foreach ( $rows as $t ) {
			$run = 'run' . $t['id'] . '-' . uniqid();
			// Atomic claim: the WHERE status='queued' guard means only one worker wins a given ticket.
			$claimed = $peek ? true : Data::update( 'aq_tickets',
				[ 'status' => 'in_progress', 'agent_run_id' => $run, 'claimed_at' => $now ],
				[ 'id' => (int) $t['id'], 'status' => 'queued' ]
			);
			if ( ! $claimed ) { continue; }
			$msgs = Data::all(
				'SELECT role, body, meta, created FROM ' . Data::t( 'aq_ticket_messages' ) . ' WHERE ticket_id = %d ORDER BY id ASC LIMIT 100',
				[ (int) $t['id'] ]
			);
			$shaped = self::shape( $t );
			$shaped['status']       = $peek ? 'queued' : 'in_progress';
			$shaped['agent_run_id'] = $peek ? '' : $run;
			// EVERY screenshot the member attached — the opening one (aq_tickets.screenshot) AND any
			// attached to a reply (meta.image, #48) — collected so the worker can DOWNLOAD + Read each as
			// real image evidence (not just see a URL in the transcript). The reply URLs are also still
			// inlined into the body for the text transcript.
			$shots = [];
			if ( ! empty( $t['screenshot'] ) && preg_match( '#^https?://#i', (string) $t['screenshot'] ) ) { $shots[] = (string) $t['screenshot']; }
			$shaped['messages']     = array_map( static function ( $m ) use ( &$shots ) {
				$meta = Data::dec( $m['meta'] ?? null );
				$body = (string) $m['body'];
				if ( is_array( $meta ) && ! empty( $meta['image'] ) && is_string( $meta['image'] ) ) {
					$body .= "\n\n[Attached screenshot: " . $meta['image'] . ']';
					if ( preg_match( '#^https?://#i', $meta['image'] ) ) { $shots[] = $meta['image']; }
				}
				return [ 'role' => $m['role'], 'body' => $body ];
			}, $msgs );
			$shaped['screenshots']  = array_values( array_unique( $shots ) ); // worker downloads + Reads each
			$out[] = $shaped;
		}
		return [ 'items' => $out ];
	}

	/** POST agent/tickets/(id)/message {body,meta} — the worker posts progress into the chat. */
	public static function agent_message( $req ) {
		$t = self::row( Rest::pint( $req, 'id', 0 ) );
		if ( ! $t ) { return Rest::err( 'not_found', 'No such ticket', 404 ); }
		$body = (string) Rest::p( $req, 'body', '' );
		if ( $body === '' ) { return Rest::err( 'bad_input', 'Empty message' ); }
		$meta = Rest::p( $req, 'meta', null );
		$mid  = self::add_message( (int) $t['id'], 'agent', wp_kses_post( $body ), is_array( $meta ) ? $meta : null );
		return [ 'ok' => true, 'id' => $mid ];
	}

	/** POST agent/tickets/(id)/status {status,branch,pr_url,deploy_sha} — worker updates run state.
	 *  Guard: never 'resolved' (owner-only), and never touch an already-resolved ticket. */
	public static function agent_status( $req ) {
		$t = self::row( Rest::pint( $req, 'id', 0 ) );
		if ( ! $t ) { return Rest::err( 'not_found', 'No such ticket', 404 ); }
		if ( $t['status'] === 'resolved' ) { return Rest::err( 'closed', 'Ticket already resolved', 409 ); }
		$status = sanitize_key( (string) Rest::p( $req, 'status', '' ) );
		$data   = [];
		if ( $status !== '' ) {
			if ( ! in_array( $status, self::AGENT_STATUSES, true ) ) {
				return Rest::err( 'bad_status', 'The worker may not set that status', 422 );
			}
			$data['status'] = $status;
		}
		foreach ( [ 'branch', 'deploy_sha' ] as $k ) {
			$v = Rest::p( $req, $k, null );
			if ( $v !== null ) { $data[ $k ] = sanitize_text_field( (string) $v ); }
		}
		$pr = Rest::p( $req, 'pr_url', null );
		if ( $pr !== null ) { $data['pr_url'] = esc_url_raw( (string) $pr ); }
		// Backoff bookkeeping when the worker re-queues a failed run: attempts (for escalation) + retry_after
		// (the unix time before which this ticket is not handed out again) — so retries pace themselves and
		// survive a daemon restart, while NEVER abandoning the ticket.
		$at = Rest::p( $req, 'attempts', null );
		if ( $at !== null ) { $data['attempts'] = max( 0, (int) $at ); }
		$ra = Rest::p( $req, 'retry_after', null );
		if ( $ra !== null ) { $data['retry_after'] = max( 0, (int) $ra ); }
		if ( $data ) { Data::update( 'aq_tickets', $data, [ 'id' => (int) $t['id'] ] ); }
		// Closing the loop: the moment the worker ships a fix live, ping the member who raised it (bell +
		// email) so they can review and resolve. Only on the transition INTO 'shipped' (idempotent by ref).
		if ( ( $data['status'] ?? '' ) === 'shipped' && $t['status'] !== 'shipped' ) {
			self::notify_shipped( $t );
		}
		// Persistence is not silence: when a ticket has resisted many automated attempts, tell the operator
		// it may need a human — the autopilot KEEPS retrying regardless. Fire once at each threshold.
		if ( isset( $data['attempts'] ) && in_array( (int) $data['attempts'], [ 5, 25 ], true ) ) {
			Mailer::send( 'ticket_stuck', Mailer::operator(), [
				'id'       => (int) $t['id'],
				'title'    => self::shorten( $t['title'], 80 ),
				'attempts' => (int) $data['attempts'],
				'url'      => home_url( '/issues/?ticket=' . (int) $t['id'] ),
			] );
		}
		return [ 'ok' => true ];
	}

	// ── the major-architectural-change approval gate ─────────────────────────────
	/** POST agent/tickets/(id)/approval {plan} — the worker judged this ticket would need a MAJOR
	 *  architectural change, so instead of shipping it holds the ticket ('awaiting') and emails the
	 *  operator a one-tap Approve/Decline. Re-posting while already awaiting just re-sends the mail. */
	public static function agent_approval( $req ) {
		$t = self::row( Rest::pint( $req, 'id', 0 ) );
		if ( ! $t ) { return Rest::err( 'not_found', 'No such ticket', 404 ); }
		if ( $t['status'] === 'resolved' ) { return Rest::err( 'closed', 'Ticket already resolved', 409 ); }
		$plan = sanitize_textarea_field( (string) Rest::p( $req, 'plan', '' ) );
		if ( mb_strlen( $plan ) < 8 ) { return Rest::err( 'bad_input', 'Describe the proposed change' ); }
		Data::update( 'aq_tickets', [ 'status' => 'awaiting', 'arch_ok' => 0 ], [ 'id' => (int) $t['id'] ] );
		self::add_message( (int) $t['id'], 'agent',
			"This looks like it needs a major architectural change, so I’ve paused and asked the maintainer to approve the approach before building it:\n\n" . $plan,
			[ 'needs_approval' => true, 'plan' => $plan ] );
		self::send_approval_email( $t, $plan );
		return [ 'ok' => true, 'status' => 'awaiting' ];
	}

	/** GET agent/approve?ticket=&d=approve|decline&sig= — the operator's one-tap decision from email.
	 *  Public route authorized purely by the HMAC sig (constant-time compare). It only acts while the
	 *  ticket is still 'awaiting', so a re-click (or a link surfacing later) is a harmless no-op. */
	public static function agent_approve( $req ) {
		$id  = Rest::pint( $req, 'ticket', 0 );
		$d   = sanitize_key( (string) Rest::p( $req, 'd', '' ) );
		$sig = (string) Rest::p( $req, 'sig', '' );
		$ok  = in_array( $d, [ 'approve', 'decline' ], true )
			&& $sig !== '' && hash_equals( self::approve_sig( $id, $d ), $sig );
		$t   = $ok ? self::row( $id ) : null;
		if ( ! $t ) { return self::approve_page( 'That link isn’t valid', 'The approval link is malformed or no longer applies.' ); }
		if ( $t['status'] !== 'awaiting' ) {
			return self::approve_page( 'Already handled', 'Ticket #' . $id . ' is no longer awaiting a decision (it’s now “' . $t['status'] . '”).' );
		}
		if ( $d === 'approve' ) {
			Data::update( 'aq_tickets', [ 'status' => 'queued', 'arch_ok' => 1 ], [ 'id' => $id ] );
			self::add_message( $id, 'system', 'Major change approved by the maintainer — the autonomous developer will build and ship it.' );
			return self::approve_page( 'Approved', 'Ticket #' . $id . ' is back in the queue. The autonomous developer will build and deploy it shortly.' );
		}
		Data::update( 'aq_tickets', [ 'status' => 'rejected', 'arch_ok' => 0 ], [ 'id' => $id ] );
		self::add_message( $id, 'system', 'The maintainer declined the proposed architectural change — this is left for a human to take on.' );
		if ( (int) $t['user_id'] ) {
			Notify::push( (int) $t['user_id'], 'ticket', 'Your contribution needs a human',
				'This one needs a bigger change than ArtaBot ships automatically — a maintainer will take it from here.',
				'/issues/?ticket=' . $id, 'tdec' . $id );
		}
		return self::approve_page( 'Declined', 'Ticket #' . $id . ' was left for a human maintainer.' );
	}

	/** HMAC over (ticket, decision) with the WP auth salt (never DB-exposed) — the Extra::cert_code
	 *  signing pattern. Self-authorizing link; effectively single-use because it only acts on 'awaiting'. */
	private static function approve_sig( $id, $decision ) {
		return hash_hmac( 'sha256', 'agentapprove|' . (int) $id . '|' . $decision, wp_salt( 'auth' ) );
	}

	private static function approve_url( $id, $decision ) {
		return add_query_arg(
			[ 'ticket' => (int) $id, 'd' => $decision, 'sig' => self::approve_sig( $id, $decision ) ],
			rest_url( 'aq/v1/agent/approve' )
		);
	}

	/** Email the operator the proposed architectural change with one-tap Approve / Decline links. */
	private static function send_approval_email( $t, $plan ) {
		$id = (int) $t['id'];
		Mailer::send( 'ticket_approval', Mailer::operator(), [
			'id'          => $id,
			'title'       => self::shorten( $t['title'], 80 ),
			'kind'        => isset( self::KINDS[ $t['kind'] ] ) ? $t['kind'] : 'suggestion',
			'plan'        => $plan,
			'approve_url' => self::approve_url( $id, 'approve' ),
			'decline_url' => self::approve_url( $id, 'decline' ),
			'url'         => home_url( '/issues/?ticket=' . $id ),
		] );
	}

	/** A tiny branded confirmation page for an approve/decline click, then exit (these links open in a
	 *  browser, so a JSON body would look broken). Brand: dark space bg, gold heading, blue link only. */
	private static function approve_page( $heading, $detail ) {
		$h = esc_html( $heading );
		$d = esc_html( $detail );
		$home = esc_url( home_url( '/issues/' ) );
		status_header( 200 );
		nocache_headers();
		header( 'Content-Type: text/html; charset=utf-8' );
		echo '<!doctype html><html lang="en"><head><meta charset="utf-8">'
			. '<meta name="viewport" content="width=device-width,initial-scale=1"><title>ArtaQuest</title></head>'
			. '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
			. 'background:#010C17;color:#fff;font:16px/1.6 -apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif">'
			. '<div style="max-width:30rem;padding:2rem;text-align:center">'
			. '<div style="font-size:1.6rem;font-weight:700;color:#E8B923;margin-bottom:.5rem">' . $h . '</div>'
			. '<p style="color:#cdd7e3">' . $d . '</p>'
			. '<p style="margin-top:1.5rem"><a href="' . $home . '" style="color:#2352E8;text-decoration:none">← Back to ArtaQuest</a></p>'
			. '</div></body></html>';
		exit;
	}

	/** Notify a ticket's owner that the autonomous worker shipped their fix live — in-app bell + email. */
	private static function notify_shipped( $t ) {
		$uid = (int) $t['user_id'];
		if ( ! $uid ) { return; }
		$title = self::shorten( $t['title'], 60 );
		$url   = '/issues/?ticket=' . (int) $t['id'];
		Notify::push( $uid, 'ticket_shipped', 'Your contribution is live',
			'ArtaBot shipped a fix for “' . $title . '”. Take a look and, if it’s good, mark it resolved.',
			$url, 'tship' . (int) $t['id'] );
		$u = get_userdata( $uid );
		if ( $u && is_email( $u->user_email ) ) {
			Mailer::send( 'ticket_shipped', $u->user_email, [ 'title' => $title, 'url' => home_url( $url ) ] );
		}
	}

	/** Trim a string to n characters on a word boundary, with an ellipsis. */
	private static function shorten( $s, $n ) {
		$s = trim( (string) $s );
		return mb_strlen( $s ) <= $n ? $s : rtrim( mb_substr( $s, 0, $n ) ) . '…';
	}
}
