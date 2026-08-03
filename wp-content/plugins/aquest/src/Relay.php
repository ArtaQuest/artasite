<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Subscription relay — routes ArtaBot's Claude calls through the operator's laptop when it is
 * awake, so chat turns run on the Claude Max SUBSCRIPTION (headless `claude -p`) instead of
 * billing API credits. When the laptop is asleep/offline/usage-limited, Assistant::chat falls
 * back to the direct Anthropic API exactly as before — the relay is a cost optimisation, never
 * a dependency (fail-open, like everything around ArtaBot).
 *
 * Shape (the laptop cannot accept inbound connections, so it POLLS):
 *   1. The laptop daemon (tools/ticket-agent/artabot-relay.mjs) long-polls POST /relay/poll
 *      (auth: the existing X-AQ-Worker shared secret). Every poll refreshes a heartbeat
 *      transient — its FRESHNESS is what "the laptop is working" means.
 *   2. Assistant::chat calls Relay::ask(): if the heartbeat is fresh (and the worker isn't
 *      usage-limited), it enqueues a job row and waits briefly for the result; otherwise it
 *      returns null immediately and the caller uses the API.
 *   3. The daemon claims the job (atomic UPDATE … WHERE status='pending'), runs headless
 *      `claude -p` on the subscription, and POSTs /relay/complete with the text + usage.
 *      A reported usage limit parks the relay (a transient until the window resets) so prod
 *      stops waiting on a closed door.
 *
 * The job table is tiny and self-cleaning: a row is DELETED the moment its result is read, and
 * stale rows are pruned on poll. Payloads are plain chat text (system prompt + transcript) —
 * already public in aq_artabot_messages, so nothing new is exposed by the (fully public) DB.
 * Turns carrying an IMAGE never relay: chat screenshots are promised to stay out of the public
 * database, and a base64 block in a job row would break that promise. Those turns go direct.
 */
final class Relay {

	const TABLE_VERSION = '1';

	const BEAT_TTL   = 90;    // s — a poll younger than this means the laptop is alive
	// The member-facing wait budget. The paid API is a TRUE LAST RESORT (operator rule 2026-06-13:
	// never use the API while the subscription/relay is available) — so a chat turn waits for the
	// relay for the WHOLE budget while the relay is alive and working, only falling to the API when
	// the relay is genuinely gone (no heartbeat), reports failed, or dies mid-answer. 50s sits safely
	// under the front-proxy gateway (~60s) and covers virtually every real relay answer (typically
	// 6–16s); a rarer-than-rare answer still running at 50s returns a graceful "resend", never the API.
	const ASK_WAIT   = 50;
	const CLAIM_WAIT = 6;     // s — UNCLAIMED this long WITH a stale heartbeat = the laptop left between
	                          // beats → API. A live-but-busy relay (fresh heartbeat) is waited for, not
	                          // abandoned to the paid API just for being momentarily busy.
	const POLL_WAIT  = 20;    // s — max long-poll hold (the daemon asks for less)
	const STEP_US    = 250000; // 250ms between queue/result checks while waiting
	const STALE_S    = 3600;  // jobs older than this are pruned — nobody is coming back for them

	/** Sentinel Relay::ask() returns when the relay is ALIVE and still working but slower than the
	 *  member-wait budget — distinct from null (genuinely unavailable → API). The caller degrades
	 *  gracefully (asks the member to resend) and NEVER spends an API credit. */
	const BUSY = '__AQ_RELAY_BUSY__';
	/** Returned when a turn carrying a `deliver` marker outlives the HTTP budget: the worker is still
	 *  on it and the answer will be delivered asynchronously. NOT a failure — nothing is billed or lost. */
	const PENDING = '__AQ_RELAY_PENDING__';

	/** Self-installed table (Notify pattern) — the relay owns its storage. */
	public static function ensure_table() {
		if ( get_option( 'aq_relay_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$table   = $wpdb->prefix . 'aq_relay_jobs';
		$charset = $wpdb->get_charset_collate();
		dbDelta( "CREATE TABLE {$table} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			status VARCHAR(10) NOT NULL DEFAULT 'pending',
			payload LONGTEXT NULL,
			result LONGTEXT NULL,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			claimed INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY status_id (status, id)
		) {$charset};" );
		update_option( 'aq_relay_table_version', self::TABLE_VERSION, true );
	}

	/** Is the laptop relay able to take a job right now? Fresh heartbeat AND not usage-limited. */
	public static function available() {
		return get_transient( 'aq_relay_beat' ) && ! get_transient( 'aq_relay_limited' );
	}

	// ── the Assistant-facing side ────────────────────────────────────────────────

	/**
	 * Try to answer one chat turn via the laptop. Returns [ 'text' => …, 'usage' => … ] on success,
	 * self::BUSY when the relay is ALIVE but slower than the wait budget (caller degrades gracefully,
	 * no API), or null which means "use the API instead". The API is a TRUE LAST RESORT (operator
	 * rule 2026-06-13): null is returned ONLY when the relay is genuinely unavailable — no heartbeat
	 * at the start, an image turn (never lands in the public DB), the relay reports failed, or its
	 * heartbeat lapses mid-wait (the laptop slept/crashed). A live, working relay is ALWAYS waited
	 * for — even a slow claimed answer is the subscription doing its job, never the paid API. Never throws.
	 */
	public static function ask( $messages, $system, $model, $max_tokens, $effort = 'low', $deliver = null ) {
		if ( ! self::available() ) { return null; } // no fresh heartbeat or usage-limited → API is the backup

		// Pull any attached screenshots out of the transcript so the turn (incl. ticket-triage with a
		// screenshot) runs ENTIRELY on the subscription instead of falling to the paid API. The image
		// bytes are ENCRYPTED with the worker token (a secret, never in the DB) before they go in the
		// job payload, so a private screenshot is never READABLE in the public database — and the row
		// is deleted the moment its result is read. If encryption is unavailable, degrade to the API
		// (only then does an image turn leave the subscription).
		$images = [];
		$flat   = [];
		foreach ( $messages as $m ) {
			if ( is_string( $m['content'] ) ) { $flat[] = $m; continue; }
			$text = '';
			foreach ( (array) $m['content'] as $block ) {
				if ( ( $block['type'] ?? '' ) === 'text' ) {
					$text .= ( $text === '' ? '' : "\n" ) . (string) ( $block['text'] ?? '' );
				} elseif ( ( $block['type'] ?? '' ) === 'image' && ( $block['source']['type'] ?? '' ) === 'base64' ) {
					$enc = self::enc_image( (string) ( $block['source']['data'] ?? '' ) );
					if ( $enc === null ) { return null; } // can't secure it → API backup
					$images[] = [ 'media_type' => (string) ( $block['source']['media_type'] ?? 'image/png' ), 'enc' => $enc ];
					$text    .= ( $text === '' ? '' : "\n" ) . '[the member attached a screenshot — provided to you as a local image file]';
				}
			}
			$flat[] = [ 'role' => $m['role'], 'content' => $text ];
		}

		$sys = $system . "\n\nYou are running headless with NO tools — reply with plain Markdown text only."
			. ( $images ? " EXCEPTION: this turn has " . count( $images ) . " attached screenshot(s) saved as local image file(s); Read each one to see it, then reply. Use ONLY the Read tool, nothing else." : '' );
		$id = Data::insert( 'aq_relay_jobs', [
			'status'  => 'pending',
			'payload' => Data::enc( array_filter( [
				'system'     => $sys,
				'prompt'     => self::render_prompt( $flat ),
				'model'      => $model,
				'max_tokens' => (int) $max_tokens,
				'effort'     => in_array( $effort, [ 'low', 'medium', 'high', 'xhigh', 'max' ], true ) ? $effort : 'low', // ArtaBot chat = low (fast); ArtaMod/ArtaVerify pass 'max'
				'images'     => $images ?: null, // encrypted; the daemon decrypts → temp files → Read
				'deliver'    => $deliver, // opaque: who to hand the finished answer to (see complete())
			], static function ( $v ) { return $v !== null; } ) ),
			'created' => Data::now(),
		] );
		if ( ! $id ) { return null; }

		$deadline = microtime( true ) + self::ASK_WAIT;
		while ( microtime( true ) < $deadline ) {
			usleep( self::STEP_US );
			$row = Data::one( 'SELECT status, result FROM ' . Data::t( 'aq_relay_jobs' ) . ' WHERE id = %d', [ $id ] );
			if ( ! $row ) { return null; } // pruned from under us — fall back

			if ( $row['status'] === 'done' ) {
				global $wpdb;
				$wpdb->delete( Data::t( 'aq_relay_jobs' ), [ 'id' => $id ] ); // read once, then gone — the table stays tiny
				$res  = Data::dec( $row['result'] );
				$text = trim( (string) ( $res['text'] ?? '' ) );
				if ( $text === '' ) { return null; }
				return [ 'text' => $text, 'usage' => is_array( $res['usage'] ?? null ) ? $res['usage'] : [] ];
			}
			if ( $row['status'] === 'failed' ) { // the relay TRIED and couldn't → the API is the right backup
				global $wpdb;
				$wpdb->delete( Data::t( 'aq_relay_jobs' ), [ 'id' => $id ] );
				return null;
			}

			// Still pending or claimed. The paid API is the LAST resort, so we only abandon the relay
			// when the laptop is GENUINELY GONE — its heartbeat (refreshed on every poll, even while
			// it's mid-answer) has lapsed. A live relay, whether queuing or actively answering, is
			// waited for to the full budget; being slow or momentarily busy is NEVER a reason to bill.
			$alive = (bool) get_transient( 'aq_relay_beat' ) && ! get_transient( 'aq_relay_bye' );
			if ( ! $alive ) {
				// Heartbeat lapsed (sleep/crash) — the answer is never coming. Mark a still-pending job
				// failed (a zombie late poll must not answer twice), then fall back to the API.
				Data::update( 'aq_relay_jobs', [ 'status' => 'failed' ], [ 'id' => $id, 'status' => 'pending' ] );
				return null;
			}
			// A fresh heartbeat with a still-unclaimed job just means the relay is busy at capacity
			// (rare for chat): keep waiting — being momentarily busy is never a reason to bill the API.
		}
		// Budget spent while the relay is still alive and working.
		//
		// NO TIME LIMITS (operator 2026-07-25). When the caller supplied a `deliver` marker, a slow answer
		// is NOT abandoned: the job is left exactly as it is, the worker keeps working for as long as the
		// turn needs (minutes, for a multi-agent xhigh workflow), and complete() hands the finished text
		// to the marker's domain — so it lands in the member's transcript instead of being thrown away
		// with a "please resend". The HTTP request returns now; only the browser stops waiting.
		if ( $deliver ) { return self::PENDING; }
		// No marker (legacy synchronous callers, e.g. ticket triage): unchanged behaviour — leave a
		// claimed job to finish (result goes unread) and only fail a still-pending one so it can't answer
		// twice; signal BUSY so the caller degrades gracefully, costing zero API credit.
		Data::update( 'aq_relay_jobs', [ 'status' => 'failed' ], [ 'id' => $id, 'status' => 'pending' ] );
		return self::BUSY;
	}

	/**
	 * Encrypt one screenshot for transit through the (public) job table. AES-256-GCM with a key
	 * derived from the shared worker token (Secrets::get('AQ_WORKER_TOKEN') — a secret, never in the
	 * DB), so the ciphertext in the payload is unreadable to anyone reading /data, while the laptop
	 * relay (which holds the same token) can decrypt it. Input is the block's base64 data; output is
	 * base64( iv(12) · tag(16) · ciphertext ) — the exact layout the Node daemon expects. Returns
	 * null when no token / no GCM cipher (caller then degrades to the API).
	 */
	private static function enc_image( $b64 ) {
		$token = (string) Secrets::get( 'AQ_WORKER_TOKEN' );
		if ( $token === '' || ! function_exists( 'openssl_encrypt' ) || ! in_array( 'aes-256-gcm', openssl_get_cipher_methods(), true ) ) { return null; }
		$bytes = base64_decode( $b64, true );
		if ( $bytes === false || $bytes === '' ) { return null; }
		$key = hash( 'sha256', $token, true );        // 32 raw bytes
		$iv  = random_bytes( 12 );
		$tag = '';
		$ct  = openssl_encrypt( $bytes, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag );
		if ( $ct === false ) { return null; }
		return base64_encode( $iv . $tag . $ct );
	}

	/** Flatten the alternating transcript into one prompt for headless `claude -p`. */
	private static function render_prompt( $messages ) {
		$lines = [ 'This is the conversation so far between a member and you (ArtaBot):', '' ];
		foreach ( $messages as $m ) {
			$lines[] = ( $m['role'] === 'assistant' ? 'ArtaBot: ' : 'Member: ' ) . $m['content'];
			$lines[] = '';
		}
		$lines[] = "Reply to the member's LAST message now, as ArtaBot, following every rule in your system prompt. Output ONLY the reply itself.";
		return implode( "\n", $lines );
	}

	// ── the laptop-facing side (auth: 'worker' — X-AQ-Worker shared secret) ─────

	/**
	 * POST /relay/poll {wait} — long-poll for the next job. Every call refreshes the heartbeat,
	 * so polling IS the liveness signal. Returns { job: {id,payload}|null, limited: bool }.
	 */
	public static function poll( $req ) {
		self::ensure_table();
		if ( ! empty( Rest::p( $req, 'bye', false ) ) ) {
			// Graceful shutdown. Drop the heartbeat NOW, and flag any poll this daemon still has HELD
			// server-side to stop claiming: PHP keeps running a long-poll after its client dies, so
			// without the flag that orphan claims the next job and returns it to nobody — costing the
			// member the full ASK_WAIT before the API fallback (observed: 27s). The flag outlives the
			// longest possible held poll, then expires harmlessly.
			delete_transient( 'aq_relay_beat' );
			set_transient( 'aq_relay_bye', 1, self::POLL_WAIT + 25 );
			return [ 'job' => null ];
		}
		delete_transient( 'aq_relay_bye' ); // a live poller (re)started — claims may flow again
		set_transient( 'aq_relay_beat', time(), self::BEAT_TTL );
		self::prune();
		$wait     = max( 0, min( (int) Rest::p( $req, 'wait', 10 ), self::POLL_WAIT ) );
		$deadline = microtime( true ) + $wait;
		do {
			if ( get_transient( 'aq_relay_bye' ) ) { return [ 'job' => null ]; } // daemon said bye mid-hold
			$job = self::claim_one();
			if ( $job ) { return [ 'job' => $job ]; }
			usleep( self::STEP_US );
		} while ( microtime( true ) < $deadline );
		return [ 'job' => null ];
	}

	/** Atomically claim the oldest pending job → {id, payload}|null. */
	private static function claim_one() {
		$row = Data::one( 'SELECT id, payload FROM ' . Data::t( 'aq_relay_jobs' ) . " WHERE status = 'pending' ORDER BY id ASC LIMIT 1" );
		if ( ! $row ) { return null; }
		// The conditional UPDATE is the lock: only one poller can move pending → claimed.
		$got = Data::update( 'aq_relay_jobs', [ 'status' => 'claimed', 'claimed' => Data::now() ], [ 'id' => (int) $row['id'], 'status' => 'pending' ] );
		if ( ! $got ) { return null; }
		return [ 'id' => (int) $row['id'], 'payload' => Data::dec( $row['payload'] ) ];
	}

	/**
	 * POST /relay/complete {id, ok, text, usage} | {id, ok:false, error, limited, reset_at} —
	 * the daemon hands back a finished job. A reported Max-usage limit parks the relay until the
	 * window resets (clamped 1m–6h) so available() goes false and prod stops queueing.
	 */
	public static function complete( $req ) {
		$id = (int) Rest::p( $req, 'id', 0 );
		$ok = ! empty( Rest::p( $req, 'ok', false ) );
		if ( ! empty( Rest::p( $req, 'limited', false ) ) ) {
			$reset = (int) Rest::p( $req, 'reset_at', 0 );
			$ttl   = max( 60, min( $reset > time() ? $reset - time() : 1800, 6 * HOUR_IN_SECONDS ) );
			set_transient( 'aq_relay_limited', time() + $ttl, $ttl );
			error_log( 'AQ Relay: worker reported a usage limit — parked for ' . $ttl . 's' );
		}
		if ( ! $id ) { return [ 'ok' => true ]; }
		$text  = (string) Rest::p( $req, 'text', '' );
		$usage = Rest::p( $req, 'usage', [] );
		Data::update( 'aq_relay_jobs', [
			'status' => $ok ? 'done' : 'failed',
			'result' => Data::enc( $ok
				? [ 'text' => $text, 'usage' => $usage ]
				: [ 'error' => substr( (string) Rest::p( $req, 'error', '' ), 0, 500 ) ] ),
		], [ 'id' => $id ] );

		// ── ASYNC DELIVERY (no time limits, operator 2026-07-25) ──────────────────────────────────
		// A job enqueued with a `deliver` marker has no one still holding an HTTP request open for it —
		// the member's browser stopped waiting long ago. Hand the finished answer to the domain that
		// asked for it so a turn that took minutes still lands in the transcript. The job row is then
		// deleted (same read-once convention as the synchronous path) so the table stays tiny.
		$row  = Data::one( 'SELECT payload FROM ' . Data::t( 'aq_relay_jobs' ) . ' WHERE id = %d', [ $id ] );
		$pay  = $row ? Data::dec( $row['payload'] ) : null;
		$dlv  = is_array( $pay ) ? ( $pay['deliver'] ?? null ) : null;
		if ( is_array( $dlv ) && ( $dlv['kind'] ?? '' ) === 'artabot' ) {
			Assistant::deliver( $dlv, $ok ? trim( $text ) : '', is_array( $usage ) ? $usage : [] );
			global $wpdb;
			$wpdb->delete( Data::t( 'aq_relay_jobs' ), [ 'id' => $id ] );
		}
		return [ 'ok' => true ];
	}

	/** Drop rows nobody will read again. Cheap (status_id key + tiny table); throttled to ~1/min. */
	private static function prune() {
		if ( get_transient( 'aq_relay_pruned' ) ) { return; }
		set_transient( 'aq_relay_pruned', 1, 60 );
		global $wpdb;
		$t = Data::t( 'aq_relay_jobs' );
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$t} WHERE created < %d", time() - self::STALE_S ) );
	}
}
