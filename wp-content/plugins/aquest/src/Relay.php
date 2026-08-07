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

	// ── the LIVE channel (streaming deltas, see stream_chunk) ─────────────────────────────────────
	const LIVE_TTL       = 600;    // s a live buffer survives — comfortably longer than any single turn
	const LIVE_MAX_CHARS = 65536;  // ceiling on one buffered answer; the transcript still carries the whole reply

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

	/**
	 * Read a transient BYPASSING this request's memoized copy — the only safe way to watch one from
	 * inside a long-poll.
	 *
	 * WHY THIS EXISTS, measured on production 2026-08-07. Every hold in this file (and in
	 * Assistant::live) re-reads a transient in a loop while ANOTHER process writes it. With a
	 * persistent object cache — which Atomic has — get_transient() goes through wp_cache_get(), and
	 * wp_cache_get MEMOISES per request: the first read is fresh, and every read after it returns that
	 * same value for as long as the request lives. So the hold was structurally blind. A live buffer
	 * whose seq climbed 1 → 13 while a tool turn ran was read as "still 1" for the whole 20 s hold,
	 * which then answered `idle`; the member only ever saw a slice when a NEW request began. It looked
	 * like a working long-poll — it held, it returned 200 — and it could not see the thing it was
	 * holding for.
	 *
	 * wp_cache_get's third argument is $force: go back to the cache server and ignore the local copy.
	 * With no external cache, transients are options and the options group is memoised the same way,
	 * but that cache is purely in-request, so dropping the two keys is free and forces a real read.
	 */
	public static function fresh_transient( $key ) {
		if ( wp_using_ext_object_cache() ) {
			return wp_cache_get( $key, 'transient', true );
		}
		wp_cache_delete( '_transient_' . $key, 'options' );
		wp_cache_delete( '_transient_timeout_' . $key, 'options' );
		return get_transient( $key );
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
	public static function ask( $messages, $system, $model, $max_tokens, $effort = 'low', $deliver = null, $stream_key = '', $tools = false ) {
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

		// TOOLS. An image turn NEVER gets them: the screenshots are decrypted to a path on the worker's
		// disk, and the tool sandbox has no host paths bound in — so the two capabilities are mutually
		// exclusive by construction, and the image (which the member is asking about) wins.
		$tools = $tools && ! $images;
		$sys = $system . ( $tools
			? "\n\nYou are running in a PRIVATE LINUX SANDBOX on ArtaQuest's own server, with full tool access: a shell, a writable home directory, Python, Node, git, ffmpeg, ImageMagick, and the open internet. Use them whenever they would make the answer better rather than answering from memory — search the web and read the actual pages before you state anything factual, current or checkable. `browse <url>` renders a page in a real browser (JavaScript included) and prints what a person would see; `browse <url> --shot /home/agent/x.png` also saves a screenshot you can then Read. You can install things for the turn (`pip install --user`, `npm install`), write and run programs, and inspect what they produce. LIMITS, and state them plainly rather than guessing: the sandbox is destroyed when this turn ends, so nothing you write persists into the next message; you have NO access to ArtaQuest's database, production, member data, credentials, or anything else on the machine outside your own scratch directory, and private networks are blocked; and you are working on the member's behalf in public, so never do anything you would not want published. Finish by REPLYING to the member in plain Markdown — the tools are how you find out, the reply is the deliverable."
			: "\n\nYou are running headless with NO tools — reply with plain Markdown text only."
			  . ( $images ? " EXCEPTION: this turn has " . count( $images ) . " attached screenshot(s) saved as local image file(s); Read each one to see it, then reply. Use ONLY the Read tool, nothing else." : '' ) );
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
				'stream'     => $stream_key ?: null, // opaque: where to post live deltas (see stream_chunk())
				// The worker still gets the LAST word: prod cannot see whether the host it is talking to has a
				// tool sandbox installed, and a "yes" the worker cannot honour must degrade to a text turn
				// rather than become an unsandboxed shell. See artabot-relay.mjs toolsFor().
				'tools'      => $tools ?: null,
			], static function ( $v ) { return $v !== null; } ) ),
			'created' => Data::now(),
		] );
		if ( ! $id ) { return null; }

		// STREAMED TURNS DO NOT BLOCK. The member is already watching deltas arrive, so holding a PHP
		// worker here would buy nothing and cost the request budget — and it is what made a >50s turn
		// return a shape the SPA could not render. Hand back PENDING at once; complete() delivers.
		if ( $stream_key && $deliver ) { return self::PENDING; }

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
			// fresh_transient, not get_transient: this runs inside a hold, and a memoised heartbeat
			// would make "the relay is alive" whatever it was when this request started.
			$alive = (bool) self::fresh_transient( 'aq_relay_beat' ) && ! self::fresh_transient( 'aq_relay_bye' );
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
			if ( self::fresh_transient( 'aq_relay_bye' ) ) { return [ 'job' => null ]; } // daemon said bye mid-hold
			// ↑ fresh_transient is load-bearing here, not a tidy-up. This flag's whole job is to stop a
			// poll that is STILL RUNNING when its client died from claiming a job it can never deliver —
			// and a memoised read returns whatever was true when this hold began, i.e. before the bye.
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

	/**
	 * POST /relay/stream {key, text, think_tokens, phase} — the daemon's LIVE channel.
	 *
	 * The member watches the answer being written instead of staring at a spinner. Deltas land in a
	 * TRANSIENT, never a row: on Atomic that is the object cache, so a streaming turn costs zero MySQL
	 * writes and the buffer expires by itself. The authoritative answer still arrives via complete() →
	 * Assistant::deliver, so this channel is pure decoration — if every chunk failed, the turn would
	 * still land in the transcript intact. That is deliberate: never let a cosmetic path cost a reply.
	 *
	 * The key is minted by Assistant::live_key from the SESSION (uid / anon key), never by the client,
	 * so one member's buffer cannot be addressed by another. Shape is still validated here because a
	 * key interpolated into a transient name is a name-injection seam.
	 */
	public static function stream_chunk( $req ) {
		$key = (string) Rest::p( $req, 'key', '' );
		if ( ! preg_match( '/^aqlive_[a-f0-9]{16,64}$/', $key ) ) { return [ 'ok' => false ]; }
		$buf = get_transient( $key );
		if ( ! is_array( $buf ) ) { $buf = [ 'seq' => 0, 'text' => '', 'think' => 0, 'phase' => 'thinking', 'step' => '', 'done' => 0 ]; }

		$add = (string) Rest::p( $req, 'text', '' );
		if ( $add !== '' ) {
			// Cap the live buffer. A runaway answer must not grow an unbounded transient; the member
			// still gets the WHOLE reply from the transcript when the turn completes.
			$buf['text'] = substr( $buf['text'] . $add, 0, self::LIVE_MAX_CHARS );
		}
		$think = (int) Rest::p( $req, 'think_tokens', 0 );
		if ( $think > (int) $buf['think'] ) { $buf['think'] = $think; }
		$phase = (string) Rest::p( $req, 'phase', '' );
		if ( in_array( $phase, [ 'thinking', 'writing' ], true ) ) { $buf['phase'] = $phase; }
		// The current TOOL STEP on a sandboxed turn ("Bash: pip install pillow"). It is the only window
		// a member gets onto a turn that can run for minutes with no text at all, so it is carried here
		// rather than left to the thinking meter's token count. Sanitised and short-capped because it is
		// worker-supplied text that will be RENDERED: strip control characters, cap the length.
		$step = trim( preg_replace( '/[\x00-\x1F\x7F]+/u', ' ', (string) Rest::p( $req, 'step', '' ) ) );
		if ( $step !== '' ) { $buf['step'] = mb_substr( $step, 0, 160 ); }
		$buf['seq'] = (int) $buf['seq'] + 1;

		set_transient( $key, $buf, self::LIVE_TTL );
		return [ 'ok' => true, 'seq' => $buf['seq'] ];
	}

	/** Mark a live buffer finished so a reader stops holding and falls back to the transcript. Called
	 *  from Assistant::deliver — the transcript row is the source of truth from that moment on. */
	public static function stream_close( $key ) {
		if ( ! is_string( $key ) || ! preg_match( '/^aqlive_[a-f0-9]{16,64}$/', $key ) ) { return; }
		$buf = get_transient( $key );
		if ( ! is_array( $buf ) ) { return; }
		$buf['done'] = 1;
		$buf['seq']  = (int) $buf['seq'] + 1;   // wake any held reader immediately
		set_transient( $key, $buf, 60 );        // brief grace for the last poll, then gone
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
