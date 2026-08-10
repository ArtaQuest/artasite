<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaBot — ArtaQuest's AI assistant.
 *
 * Two surfaces, one brain (the Claude Max SUBSCRIPTION via the laptop relay, src/Relay.php — the
 * paid Anthropic API was removed entirely, 2026-06-13; the relay is the only path, and when it is
 * offline ArtaBot shows a default "offline" message):
 *   1. Contribution triage — on every ticket, ArtaBot acknowledges, classifies the kind, asks
 *      clarifying questions, and queues concrete work for the autonomous agent (triage/reply).
 *   2. A global assistant available everywhere — a persistent per-user conversation it remembers
 *      across sessions (aq_artabot_messages), like a normal chatbot (ask/history/clear). When anyone —
 *      member or signed-out visitor — describes something actionable it opens the contribution FOR
 *      them (Tickets::open_from_chat), pre-triaged, instead of pointing them at a form.
 *
 * ArtaBot is metered: every member pays what their turn measurably cost (src/Usage.php); the hourly rate
 * limits are the only guard. Cost is kept down by the cheap fast model (MODEL), a tight output ceiling
 * (MAXTOK), prompt-caching the conversation prefix (see chat()), very-concise-reply prompting, and
 * filing tickets directly from chat — which skips a second triage round-trip.
 *
 * CONTAINMENT: ArtaBot has NO tools and NO shell/deploy authority — it can only write chat messages
 * and open/queue a ticket for the visitor (the same thing a member could do by hand). The real trust
 * boundary is the worker's sandbox + build gate.
 */
final class Assistant {

	const NAME     = 'ArtaBot';
	// Opus 5 — the operator's directive (2026-06-11): "every session is using claude 4.8". This is an
	// UPGRADE: a 2026-06-10 Haiku experiment made ArtaBot confused (bundled two issues into one ticket, lost
	// track of which issue a member meant); Sonnet fixed that, Opus 5 is stronger still, so multi-issue
	// triage only improves. Cost stays ~nil because every turn runs on the Max SUBSCRIPTION via the laptop
	// relay (Relay::ask → headless claude -p; flat-rate, so model choice is free there) — the direct API is
	// only a fallback when the laptop is offline. prompt-caching + the very-concise prompt keep that cheap too.
	const MODEL    = 'claude-opus-5'; // the relay (subscription) model for member CHAT; flat-rate, so the choice is free
	// Ticket TRIAGE runs on the latest Opus at LOW effort (operator 2026-07-17: ALL models on latest
	// Opus, and ArtaBot — chat AND triage — at low effort, matching the ArtaAI fleet registry). Triage
	// is a classify-and-summarise turn, well within low effort; the win is latency — max-effort turns
	// regularly outran Relay::ASK_WAIT into BUSY + the aq_retriage cron, so members waited longer.
	const TRIAGE_MODEL  = 'claude-opus-5'; // operator 2026-07-17: ALL models on latest Opus
	// Triage output ceiling: the aqmeta block is LAST — a truncated reply would eat the classifier, so
	// triage keeps real headroom regardless of effort (the PROMPT keeps prose short).
	const TRIAGE_MAXTOK = 2400;
	// chat() returns this when the relay is alive but slower than its wait budget (Relay::BUSY) — the
	// subscription is handling the turn, so callers degrade gracefully (ask the member to resend).
	// Distinct from null (relay genuinely unavailable → ArtaBot's default "offline" message; no API).
	const BUSY     = '__AQ_ARTABOT_BUSY__';
	const MAXTOK   = 800; // headroom so a reply + its aqmeta block can never truncate; the PROMPT keeps prose short

	/** THE TIER TABLE LIVES IN Usage::TIERS. There were briefly two of them here — one describing
	 *  thinking depth and a coin price, one describing compute ceilings — and a second table is a
	 *  second answer waiting to disagree with the first. It already had: the new `max` tier existed in
	 *  one and not the other, so asking for it read a key that was not there.
	 *
	 *  What a tier means now: a CEILING (effort, vCPU, RAM, wall clock, reply length), never a price.
	 *  The price is what the turn measurably cost, charged once it has replied. */
	const FREE_TIER = 'low';   // the DEFAULT tier — no longer "the free one"; nothing is free

	/** THE SANDBOXED EXECUTOR (operator directive: "ArtaBot should be able to do anything a user could
	 *  do in the server"). A chat turn runs inside a throwaway Linux sandbox with a shell, a browser and
	 *  the internet — see tools/ticket-agent/artabot-tools.mjs for what it is, and what it cannot reach.
	 *  Set false to turn the capability off platform-wide; the worker has its own independent kill
	 *  switch (AQ_ARTABOT_TOOLS=0) for turning it off without a deploy. */
	const TOOLS = true;

	/** Which turns get it. Chat is members-only, so this is attributable compute, never anonymous.
	 *  Image turns are excluded: the screenshots are decrypted to the worker's own disk and the sandbox
	 *  has no host paths bound in, so the two are mutually exclusive by construction and the screenshot
	 *  the member asked about wins. Triage, ArtaMod and @mentions never pass true. */
	private static function tools_for( $uid, $has_image ) {
		return self::TOOLS && $uid > 0 && ! $has_image;
	}

	/** Normalise a requested tier — delegated, so there is one definition of what tiers exist. */
	public static function tier( $want ) { return Usage::tier( $want ); }

	/** How many conversations one member may have open at once. Each is a live machine when it is
	 *  working, so this is a real resource bound and not a tidiness rule — and it is also what stops a
	 *  single member opening fifty sessions and metering fifty machines at once. */
	const MAX_SESSIONS = 8;

	/**
	 * The member's open conversations. Several may run AT THE SAME TIME, each with its own transcript,
	 * its own tier (so its own CPU and RAM), its own live stream and its own bill.
	 */
	public static function sessions( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'signin_required', 'Sign in to use ' . self::NAME, 401 ); }
		// ADOPT THE OLD CONVERSATION. Members had one un-sessioned transcript before this existed, and
		// once the UI shows tabs there is no tab for session 0 — so their entire history would simply
		// stop being reachable. It becomes their first session instead, keeping the messages where the
		// member expects them. Runs once: after this they have a session, so the condition is false.
		$legacy = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_artabot_messages' ) . ' WHERE user_id = %d AND session_id = 0', [ $uid ] );
		$has    = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_artabot_sessions' ) . ' WHERE user_id = %d', [ $uid ] );
		if ( $legacy > 0 && $has === 0 ) {
			$nid = Data::insert( 'aq_artabot_sessions', [
				'user_id' => $uid, 'title' => 'Earlier chat', 'tier' => self::FREE_TIER,
				'created' => Data::now(), 'last' => Data::now(), 'turns' => (int) floor( $legacy / 2 ),
			] );
			if ( $nid ) {
				global $wpdb;
				$wpdb->query( $wpdb->prepare( 'UPDATE ' . Data::t( 'aq_artabot_messages' ) . ' SET session_id = %d WHERE user_id = %d AND session_id = 0', (int) $nid, $uid ) );
			}
		}

		$rows = Data::all(
			'SELECT id, title, tier, created, last, turns, coins FROM ' . Data::t( 'aq_artabot_sessions' )
			. ' WHERE user_id = %d AND closed = 0 ORDER BY last DESC, id DESC LIMIT %d', [ $uid, self::MAX_SESSIONS ] );
		// PRE-WARM, as a side effect of opening the chat. Scaling to zero has a price and it is paid on
		// the first message after a quiet spell: a cold wake measured 24s against 0.2s warm. The member
		// asks for their session list the moment they open the dock — seconds before they finish typing
		// — so warming the machines their own sessions run on hides the whole cold start behind the
		// typing. Non-blocking and best-effort: it is an optimisation, and it must never delay the list.
		$warmed = [];
		foreach ( $rows as $r ) {
			$t = Usage::tier( $r['tier'] );
			if ( isset( $warmed[ $t ] ) ) { continue; }
			$warmed[ $t ] = 1;
			$url = Relay::endpoint( $t );
			if ( $url !== '' ) { wp_remote_get( preg_replace( '#/turn$#', '/health', $url ), [ 'blocking' => false, 'timeout' => 1 ] ); }
		}
		return [ 'items' => $rows, 'max' => self::MAX_SESSIONS, 'tiers' => Usage::TIERS ];
	}

	/** POST /artabot/session {tier,title} — open a new conversation. */
	public static function open_session( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'signin_required', 'Sign in to use ' . self::NAME, 401 ); }
		if ( ! Usage::may_start( $uid ) ) { return Rest::err( 'insufficient_coins', 'Your balance is below the floor — top up to open a new session', 402 ); }
		$open = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_artabot_sessions' ) . ' WHERE user_id = %d AND closed = 0', [ $uid ] );
		if ( $open >= self::MAX_SESSIONS ) { return Rest::err( 'too_many', 'You already have ' . self::MAX_SESSIONS . ' conversations open — close one first' ); }
		$id = Data::insert( 'aq_artabot_sessions', [
			'user_id' => $uid,
			'title'   => substr( sanitize_text_field( (string) Rest::p( $req, 'title', '' ) ), 0, 120 ),
			'tier'    => Usage::tier( Rest::p( $req, 'tier', self::FREE_TIER ) ),
			'created' => Data::now(), 'last' => Data::now(),
		] );
		return [ 'id' => (int) $id, 'tier' => Usage::tier( Rest::p( $req, 'tier', self::FREE_TIER ) ) ];
	}

	/** POST /artabot/session/close {session} — end one conversation. Its transcript stays readable and
	 *  its charges stay on the invoice; closing only stops it being worked in. */
	public static function close_session( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'signin_required', 'Sign in first', 401 ); }
		$sid = (int) Rest::p( $req, 'session', 0 );
		// user_id in the WHERE, or any member could close anyone's conversation.
		Data::update( 'aq_artabot_sessions', [ 'closed' => Data::now() ], [ 'id' => $sid, 'user_id' => $uid ] );
		return [ 'ok' => true ];
	}

	/** The session a request is for, verified to belong to the caller. 0 when the member has none yet
	 *  (their first turn opens one), '' -1 when they asked for one that is not theirs. */
	private static function session_for( $uid, $sid ) {
		$sid = (int) $sid;
		if ( $sid <= 0 ) { return 0; }
		$row = Data::one( 'SELECT id, tier FROM ' . Data::t( 'aq_artabot_sessions' ) . ' WHERE id = %d AND user_id = %d AND closed = 0', [ $sid, $uid ] );
		return $row ? (int) $row['id'] : -1;
	}

	/** Marker text a not-yet-answered assistant row carries. The history endpoint surfaces it as
	 *  `pending` so the UI can show a thinking state; it is never shown to the member as prose. */
	const PENDING_BODY = '__AQ_PENDING__';

	/** Seconds a live() reader keeps gathering once it has something new, before answering. Trades a
	 *  little latency for far fewer requests — the client animates the slice while the next poll flies. */
	const LIVE_GATHER = 1.2;

	/**
	 * Deliver an asynchronously-completed turn (Relay::complete → here). NO TIME LIMITS: the worker may
	 * have spent minutes on a multi-agent workflow; whenever it finishes, the answer replaces the pending
	 * placeholder in the member's transcript. Filing (aqmeta) runs here exactly as it does inline, so an
	 * async turn can still open a contribution. A failed turn REFUNDS the tier and leaves an honest note
	 * rather than a silent empty bubble.
	 */
	public static function deliver( $dlv, $text, $usage = [], $metered = [], $media = [] ) {
		$amid = (int) ( $dlv['amid'] ?? 0 );
		$uid  = (int) ( $dlv['uid'] ?? 0 );
		$tier = Usage::tier( $dlv['tier'] ?? self::FREE_TIER );
		$tref = (string) ( $dlv['ref'] ?? '' );
		if ( ! $amid ) { return; }
		$row = Data::one( 'SELECT body FROM ' . Data::t( 'aq_artabot_messages' ) . ' WHERE id = %d', [ $amid ] );
		if ( ! $row || (string) $row['body'] !== self::PENDING_BODY ) { return; }  // already delivered/cleared — never answer twice

		if ( $text === '' ) {
			// Nothing to bill: true pay-per-use means an attempt that produced no reply is not a
			// charge. The compute was still spent, and absorbing it is the honest side to err on.
			// Nothing to refund: under pay-per-use nothing was taken up front, and a turn that produced
			// no reply is not charged at all — Usage::record is only reached on the success path below.
			Data::update( 'aq_artabot_messages', [ 'body' => self::NAME . " couldn't finish that one — please try again, you were not charged" ], [ 'id' => $amid ] );
			return;
		}
		[ $reply, $meta ] = self::split_meta( $text );
		if ( $reply === '' ) { $reply = 'Sorry, I have nothing to add there'; }
		$src = (string) ( $dlv['prompt'] ?? '' );
		[ $filed ] = self::file_from_meta( $uid, $meta, $src, false, '' );
		if ( $filed ) { $reply .= "\n\n" . implode( "\n", $filed ); }
		// WHAT THE TURN MADE. A chart, an animation, a rendered page — saved and appended as Markdown so
		// it renders in the bubble. Appended from the FILES the worker actually returned, not from
		// anything the model wrote: a filename it invented cannot conjure an image, and a chart it
		// forgot to mention still reaches the member.
		$shown = self::attach_media( $uid, $media );
		if ( $shown ) { $reply .= "\n\n" . implode( "\n", $shown ); }
		Data::update( 'aq_artabot_messages', [ 'body' => $reply ], [ 'id' => $amid ] );
		// THE CHARGE. Here and nowhere else: the turn has replied, so what it cost is now a fact rather
		// than an estimate, and Usage::record turns the measurements into money at the live gold peg.
		// Idempotent on the ref, so a redelivered completion bills once.
		$sid = (int) ( $dlv['sid'] ?? 0 );
		$u = Usage::record( $uid, 'chat', $tier, [
			'ref'     => 'turn:' . $amid,
			'session' => $sid,
			'secs'    => (float) ( $metered['secs'] ?? 0 ),
			'ai_usd'  => (float) ( $metered['ai_usd'] ?? 0 ),
			'tokens'  => (int) ( $usage['input_tokens'] ?? 0 ) + (int) ( $usage['output_tokens'] ?? 0 ),
			'note'    => mb_substr( (string) ( $dlv['prompt'] ?? '' ), 0, 90 ),
		] );
		// The session carries its own running total, so a member can see what each conversation is
		// costing them separately rather than one number for everything they have open.
		if ( $sid > 0 ) {
			global $wpdb;
			$t = Data::t( 'aq_artabot_sessions' );
			$wpdb->query( $wpdb->prepare( "UPDATE {$t} SET turns = turns + 1, coins = coins + %f, last = %d WHERE id = %d",
				(float) ( $u['coins'] ?? 0 ), Data::now(), $sid ) );
		}
		// The transcript is now the source of truth — release any reader still holding on the live
		// buffer so it switches over immediately instead of waiting out its hold.
		Relay::stream_close( (string) ( $dlv['stream'] ?? '' ) );
	}

	/**
	 * Save the files a tool turn produced and return the Markdown that shows them.
	 *
	 * Everything here is worker-supplied and therefore untrusted: the media type decides the extension
	 * (never the model's filename, which would be a path-traversal seam), the bytes are size-capped, and
	 * anything that is not a media type we can render is skipped rather than saved and linked.
	 */
	private static function attach_media( $uid, $media ) {
		if ( ! is_array( $media ) || ! $media ) { return []; }
		$ext = [ 'image/png' => 'png', 'image/jpeg' => 'jpg', 'image/gif' => 'gif', 'image/webp' => 'webp',
		         'image/svg+xml' => 'svg', 'video/mp4' => 'mp4', 'video/webm' => 'webm',
		         'audio/mpeg' => 'mp3', 'audio/wav' => 'wav', 'audio/ogg' => 'ogg', 'audio/mp4' => 'm4a',
		         'text/html' => 'html' ];
		$up  = wp_upload_dir();
		$out = [];
		foreach ( array_slice( $media, 0, 4 ) as $m ) {
			$type = (string) ( $m['media_type'] ?? '' );
			$name = sanitize_file_name( (string) ( $m['name'] ?? 'output' ) );
			if ( ! isset( $ext[ $type ] ) ) { continue; }
			if ( ! empty( $m['too_big'] ) ) {
				$out[] = '*(' . $name . ' was too large to attach — it is in your machine\'s `out` folder)*';
				continue;
			}
			$bytes = base64_decode( (string) ( $m['b64'] ?? '' ), true );
			if ( $bytes === false || $bytes === '' || strlen( $bytes ) > 6 * 1024 * 1024 ) { continue; }
			$file = 'artabot-' . $uid . '-' . wp_generate_password( 10, false ) . '.' . $ext[ $type ];
			$path = trailingslashit( $up['path'] ) . $file;
			if ( ! @file_put_contents( $path, $bytes ) ) { continue; }
			$url  = trailingslashit( $up['url'] ) . $file;
			// The markdown says WHAT it is; renderRich decides how to show it. A picture is `![]()`,
			// everything with a player or a frame is `[]()` — the client keys off the extension, so the
			// reply stays readable as plain text wherever markdown is not rendered.
			$out[] = strpos( $type, 'image/' ) === 0
				? '![' . $name . '](' . $url . ')'
				: '[' . $name . '](' . $url . ')';
		}
		return $out;
	}

	// ── the LIVE channel (see Relay::stream_chunk) ────────────────────────────────────────────────
	//
	// WHAT THE MEMBER ACTUALLY SEES, and why it is not more. Claude Code streams `thinking_delta`
	// events whose `thinking` field is an EMPTY STRING — the assembled block carries 0 characters of
	// reasoning beside a ~1KB cryptographic signature. The words are signed and withheld, and no flag
	// exposes them. So the thinking phase is reported as PROGRESS (estimated tokens, elapsed) and the
	// answer is streamed verbatim. Nothing here may ever synthesise a plausible "chain of thought":
	// that would be a transcript of something the member cannot check, presented as if they could.

	/** The live buffer key for THIS caller, derived from the session — never from client input, so one
	 *  member's stream cannot be addressed by another. Stable for the caller, opaque to the worker. */
	public static function live_key( $req = null, $session = 0 ) {
		$uid = Rest::uid();
		// PER SESSION, not per member. A member may run several conversations at once, and a buffer
		// keyed on the member alone means the second turn writes over the first one's words as it is
		// still reading them — one stream, two authors. The session id is part of the key so parallel
		// turns are parallel all the way down. It is still derived from the SESSION, never from client
		// input, so one member cannot address another's stream by asking for it.
		$sid = max( 0, (int) $session );
		if ( $uid > 0 ) { return 'aqlive_' . hash( 'sha256', 'u' . $uid . ':s' . $sid . '|' . wp_salt( 'nonce' ) ); }
		$anon = $req ? self::anon_key( $req ) : '';
		if ( ! $anon ) { return ''; }
		return 'aqlive_' . hash( 'sha256', 'a' . $anon . ':s' . $sid . '|' . wp_salt( 'nonce' ) );
	}

	/**
	 * GET /artabot/live?seen=N — the member's in-flight answer as it is written.
	 *
	 * LONG-POLL, not short-poll, and that is the whole point of the design: it reuses Relay::poll's
	 * usleep hold, so one held request covers ~20s of streaming instead of ~57 full WordPress
	 * bootstraps. It returns the moment there is something new. Idle chats poll nothing at all.
	 */
	public static function live( $req ) {
		$key = self::live_key( $req, (int) Rest::p( $req, 'session', 0 ) );
		if ( ! $key ) { return [ 'seq' => 0, 'text' => '', 'think' => 0, 'phase' => '', 'step' => '', 'steps' => [], 'done' => 1 ]; }
		$seen     = max( 0, (int) Rest::p( $req, 'seen', 0 ) );
		$deadline = microtime( true ) + Relay::POLL_WAIT;
		$gather   = 0.0;
		$buf      = null;
		do {
			// Relay::fresh_transient, NOT get_transient — see the note there. Inside this hold a
			// memoised read never moves, so the loop below would spin out its full 20s and answer
			// `idle` while the answer was being written beside it.
			$buf   = Relay::fresh_transient( $key );
			$fresh = is_array( $buf ) && (int) $buf['seq'] > $seen;
			// A reader that has seen NOTHING and finds a FINISHED buffer is looking at a turn that ended
			// before it started watching — the previous one, whose buffer lingers for a minute so its own
			// last poll can collect the tail. Handing it over stops the new reader dead on its first
			// request: it adopts the old answer, sees done, and closes, so the turn the member is
			// actually waiting for streams nothing at all. The transcript already holds that old answer.
			// (This is a race the client cannot avoid: it must start reading BEFORE it asks, or the first
			// seconds of thinking are lost.)
			if ( $fresh && $seen === 0 && (int) ( $buf['done'] ?? 0 ) ) { $fresh = false; $buf = null; }
			if ( $fresh ) {
				// GATHER before returning. The daemon flushes every ~400ms, so returning on the first
				// new byte would make this a 2.5-req/s short-poll — exactly what long-polling is here to
				// avoid. Instead keep holding briefly and hand back a bigger slice; the client types it
				// out over that same window, so the member sees continuous writing from ~1 request/s.
				// A finished turn never waits: `done` returns at once.
				if ( (int) ( $buf['done'] ?? 0 ) ) { break; }
				if ( $gather === 0.0 ) { $gather = microtime( true ) + self::LIVE_GATHER; }
				if ( microtime( true ) >= $gather ) { break; }
			}
			usleep( Relay::STEP_US );
		} while ( microtime( true ) < $deadline );

		if ( is_array( $buf ) && (int) $buf['seq'] > $seen ) {
			// `text` is the WHOLE answer so far, not a delta: a dropped or duplicated response can then
			// never corrupt what the member is reading — the client simply adopts the latest prefix.
			return [
				'seq'   => (int) $buf['seq'],
				'text'  => (string) $buf['text'],
				'think' => (int) $buf['think'],
				'phase' => (string) $buf['phase'],
				// The tool the sandbox is running right now ("Bash: pip install pillow"), or ''. On a
				// TOOL turn this is the only thing moving for minutes at a time — the thinking meter's
				// token count stops climbing the moment Claude starts using tools instead of thinking.
				'step'  => (string) ( $buf['step'] ?? '' ),
				// …and the whole sequence behind it: every tool this turn has run, what it was given
				// and what came back. The single step above is the CURRENT one; this is the record.
				'steps' => is_array( $buf['steps'] ?? null ) ? array_values( $buf['steps'] ) : [],
				'done'  => (int) ( $buf['done'] ?? 0 ),
			];
		}
		// Nothing new within the hold — the client re-polls. `seq` echoes what it already has so a
		// timeout is indistinguishable from "no change", and never rewinds the rendered text.
		return [ 'seq' => $seen, 'text' => '', 'think' => 0, 'phase' => '', 'step' => '', 'steps' => [], 'done' => 0, 'idle' => 1 ];
	}

	/** The public tier menu. It no longer advertises a free tier, because there is not one: every
	 *  member pays what their work measurably cost, the operator included. Compute is quoted per
	 *  minute; the AI part is not quoted at all, because it is not knowable before the turn runs and
	 *  a number invented for a price list is the thing this design exists to avoid. */
	public static function tiers( $req ) { return Usage::mine( $req ); }

	const QUEUE_CONFIDENCE = 0.6;             // min classification confidence to auto-queue for the worker
	const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024; // a screenshot shared in chat caps at ~5 MB (Anthropic's image limit)

	/** Can ArtaBot answer at all? Only when the laptop relay is live (Max subscription). The paid API
	 *  was removed (2026-06-13), so when the relay is offline ArtaBot shows its default "offline"
	 *  message rather than billing an API. */
	private static function online() {
		return Relay::available();
	}

	// ── contribution triage (Tickets) ───────────────────────────────────────────
	private static function triage_prompt() {
		$kinds = implode( ' | ', array_keys( Tickets::KINDS ) );
		return implode( "\n", [
			'You are ' . self::NAME . ", ArtaQuest's contribution triager — a warm, sharp first responder on a ticket a member just opened.",
			'ArtaQuest is a social feed of citable, reproducible works: every published submission is a PUBLIC KAGGLE NOTEBOOK THAT HAS BEEN RUN. A member pastes the link to their notebook on Kaggle in the Studio (/studio), picks which of its output files to publish, and an exhaustive reproducibility checklist reads the facts back from Kaggle: is the notebook public, is every input public, did the run finish, did it produce these files. Clearing the checklist only REQUESTS publication — the author confirms from their own inbox, and that is what publishes it and mints a permanent DOI. Published files land in the Library, where any member can attach them to their own posts. Members found challenges (kind + topic + full-moon deadline + entry fee; the most-hearted entry takes the pool), hearts are the only vote, and the platform also has global discussion boards, donations and a public database (/data/). Brand voice: plain accessible English, BRITISH spelling, no trailing full stops on headings, warm but VERY CONCISE — the whole human-facing reply is one or two short sentences, no preamble or filler.',
			'',
			'Your job on each turn:',
			'A screenshot of the issue is attached on the first turn — examine it closely; it is the primary evidence.',
			'1. In ONE short sentence, acknowledge what they are raising.',
			"2. Decide which single KIND it is: {$kinds} (bug = something broken; feature = a new capability; content = improve copy, a page, a published work's presentation, or a translation; suggestion = any other idea).",
			'3. Only if something important is genuinely unclear, ask ONE specific clarifying question. Do not ask anything you can reasonably infer.',
			'4. When — and ONLY when — the request is concrete enough that a developer could act on it without further questions, mark it ready to action.',
			'',
			'ALWAYS end your reply with a fenced code block tagged aqmeta containing minified JSON, e.g.:',
			'```aqmeta',
			'{"kind":"bug","action":"queue","summary":"one-line task for the engineer","confidence":0.82}',
			'```',
			'Rules for aqmeta: "kind" is one of the four; "action" is "queue" only when the task is concrete and self-contained, otherwise "none" (e.g. while you are still asking questions); "summary" is an imperative one-liner; "confidence" is 0-1 for your classification. The aqmeta block is stripped before the member sees the message, so keep all human-facing content above it.',
		] );
	}

	/** First turn on a freshly opened ticket. */
	public static function triage( $ticket_id ) { return self::respond( (int) $ticket_id, true ); }
	/** Continuation turn after the member replies. $image_url: an optional screenshot attached to
	 *  that reply (already stored in our uploads dir — see Tickets::post_message, #48). */
	public static function reply( $ticket_id, $image_url = '' ) { return self::respond( (int) $ticket_id, false, (string) $image_url ); }

	/** Re-triage tickets whose triage never completed — e.g. it hit a SUSTAINED API rate-limit at create
	 *  time and fell open with a "maintainer will follow up" note. A successful triage ALWAYS leaves an
	 *  'assistant' message, so its ABSENCE (on an open/triaging ticket past a short grace) means triage
	 *  never landed → run it again now the API may have recovered. Bounded per tick; no-op when the key is
	 *  absent or nothing is stale. Driven by the aq_retriage cron — so ArtaBot safely continues after a
	 *  rate-limit, never silently dropping a member's report. */
	public static function retriage_stale() {
		if ( ! self::online() ) { return; }
		$tt = Data::t( 'aq_tickets' );
		$mm = Data::t( 'aq_ticket_messages' );
		$rows = Data::all(
			"SELECT t.id FROM $tt t
			   WHERE t.status IN ( 'open', 'triaging' )
			     AND t.created < %d AND t.created > %d
			     AND NOT EXISTS ( SELECT 1 FROM $mm m WHERE m.ticket_id = t.id AND m.role = 'assistant' )
			   ORDER BY t.id ASC LIMIT 5",
			[ time() - 300, time() - 86400 ]
		);
		foreach ( (array) $rows as $r ) { self::triage( (int) $r['id'] ); }
	}

	private static function respond( $ticket_id, $is_first, $image_url = '' ) {
		$t = Data::one( 'SELECT * FROM ' . Data::t( 'aq_tickets' ) . ' WHERE id = %d', [ $ticket_id ] );
		if ( ! $t ) { return null; }
		$owner = (int) $t['user_id'];

		if ( ! self::online() ) {
			return self::store_ticket_msg( $ticket_id, 'system',
				"Thanks — your contribution is logged. ArtaBot triage is offline right now, but a maintainer will pick this up. You alone close the ticket when you're happy" );
		}
		if ( Rest::throttle( 'assistant', 40, 3600 ) ) {
			return self::store_ticket_msg( $ticket_id, 'system', 'ArtaBot is busy — please add your message again in a moment' );
		}

		// Every contribution is centred on a screenshot — show it to ArtaBot on the first turn so it
		// triages from the actual evidence (Claude is multimodal).
		$turns = self::ticket_history( $ticket_id );
		if ( $is_first ) {
			$img = self::image_block( $t['screenshot'] ?? '' );
			if ( $img ) {
				foreach ( $turns as $i => $turn ) {
					if ( $turn['role'] === 'user' ) {
						$turns[ $i ]['content'] = [ $img, [ 'type' => 'text', 'text' => (string) $turn['content'] ] ];
						break;
					}
				}
			}
		}
		// A screenshot attached to the member's LATEST reply (#48) rides along the same way —
		// prepended to the turn Claude is answering, so follow-up triage sees the new evidence.
		// image_block fails closed (uploads-dir files only), so a bad URL just degrades to text.
		if ( ! $is_first && $image_url !== '' ) {
			$img = self::image_block( $image_url );
			if ( $img ) { self::attach_image( $turns, $img ); }
		}
		$out = self::chat( $turns, self::triage_prompt(), self::TRIAGE_MODEL, self::TRIAGE_MAXTOK, 'low' );
		// BUSY = the relay (subscription) is still answering, just slower than the budget — never bill
		// the API. Leave the ticket reply-less and silent; the aq_retriage cron re-triages any open
		// ticket without an assistant reply (≤15 min), on the subscription. No alarming "snag" note.
		if ( $out === self::BUSY ) { return null; }
		if ( $out === null ) {
			return self::store_ticket_msg( $ticket_id, 'system', 'ArtaBot hit a snag reaching Claude — a maintainer will follow up. Your ticket is safe' );
		}

		[ $visible, $meta ] = self::split_meta( $out['text'] );
		if ( $visible === '' ) { $visible = $is_first ? 'Thanks for raising this — looking into it' : 'Noted, thank you'; }

		// Re-classify onto the right kind/track when ArtaBot is confident.
		if ( $meta && isset( $meta['kind'], Tickets::KINDS[ $meta['kind'] ] )
			&& (float) ( $meta['confidence'] ?? 0 ) >= self::QUEUE_CONFIDENCE
			&& $meta['kind'] !== $t['kind'] ) {
			Data::update( 'aq_tickets', [ 'kind' => $meta['kind'] ], [ 'id' => $ticket_id ] );
		}

		// Queue concrete, confident work for the autonomous worker. This ALSO handles FOLLOW-UPS: when the
		// member replies asking for more on an already-SHIPPED (or rejected) ticket and ArtaBot triages it
		// as concrete work, it goes back to 'queued' (→ 'in_progress' when the worker claims it) with a
		// fresh attempt budget — the daemon re-develops with the full thread (what it already shipped +
		// the new request). A "thanks!" triages as action:none, so it never wastes a re-development.
		if ( $meta && ( $meta['action'] ?? '' ) === 'queue'
			&& (float) ( $meta['confidence'] ?? 0 ) >= self::QUEUE_CONFIDENCE
			&& in_array( $t['status'], [ 'open', 'triaging', 'shipped', 'rejected' ], true ) ) {
			Data::update( 'aq_tickets', [ 'status' => 'queued', 'attempts' => 0, 'retry_after' => 0 ], [ 'id' => $ticket_id ] );
			$meta['queued'] = true;
		} elseif ( $is_first && $t['status'] === 'open' ) {
			Data::update( 'aq_tickets', [ 'status' => 'triaging' ], [ 'id' => $ticket_id ] );
		}

		$mid = self::store_ticket_msg( $ticket_id, 'assistant', $visible, $meta ?: null )['id'];
		return [ 'id' => $mid, 'role' => 'assistant', 'body' => $visible, 'at' => Data::now() ];
	}

	/** Alternating user/assistant transcript from a ticket's messages. */
	private static function ticket_history( $ticket_id ) {
		$rows = Data::all(
			'SELECT role, body FROM ' . Data::t( 'aq_ticket_messages' ) . ' WHERE ticket_id = %d ORDER BY id ASC LIMIT 60',
			[ $ticket_id ]
		);
		$turns = [];
		foreach ( $rows as $r ) {
			$role = $r['role'] === 'assistant' ? 'assistant' : 'user';
			$text = (string) $r['body'];
			if ( $r['role'] === 'agent' )  { $text = "[agent] {$text}"; }
			if ( $r['role'] === 'system' ) { $text = "[system] {$text}"; }
			self::push_turn( $turns, $role, $text );
		}
		if ( ! $turns || $turns[0]['role'] !== 'user' ) {
			array_unshift( $turns, [ 'role' => 'user', 'content' => 'A member opened a contribution ticket.' ] );
		}
		return $turns;
	}

	// ── global ArtaBot chat (persistent per-user memory) ─────────────────────────
	private static function artabot_prompt( $uid, $tools = false, $shell = '' ) {
		$who = '';
		if ( $uid ) {
			$u = get_userdata( $uid );
			if ( $u ) {
				$tier = Economy::tier( Economy::points_balance( $uid ) );
				$who  = "\n\nYou are speaking with {$u->display_name} ({$tier} tier). Be personable and remember earlier turns in this conversation.";
			}
		}
		$lines = [
			'You are ' . self::NAME . ", ArtaQuest's friendly AI guide — available everywhere on the platform.",
			'ArtaQuest is a social feed of citable, reproducible works. Every published submission is a PUBLIC KAGGLE NOTEBOOK THAT HAS BEEN RUN — members write and run their notebooks on Kaggle, then paste the link in the free Studio (/studio) and choose which output files to publish. An exhaustive reproducibility checklist then reads the facts back from the public Kaggle API, which answers without a login, so anyone can re-run those checks: the notebook must be public, every input dataset/model/notebook must be public, it must need no private credentials, and the run must have finished and produced the files being published. Warnings (internet was on, randomness unseeded, a GPU is needed) are shown but never block. Nothing is scored, graded or ranked, and no AI reviews anything. Clearing the checklist only REQUESTS publication: the author confirms from their own registered inbox and signs with their device passkey, and only that publishes the work and mints a permanent DOI. Published files enter the Library, where any member can attach them to their own posts. Submitting, checking and publishing all cost nothing; members earn only by winning member-founded challenges (a kind + a sitewide topic + a full-moon deadline + an entry fee — every entrant pays into the pool and the most-hearted entry takes it all; an exact tie splits evenly). Hearts are the only vote — there are no downvotes anywhere. Discussion replies are screened automatically by ArtaMod — ArtaQuest welcomes the whole spectrum of honest thought (debate, dissent, fringe ideas) and filters only content that trades in hate or fear. The Foundation itself runs on donations with public financial transparency. Talking to you costs the member what their turn actually used — measured compute and AI, itemised on a daily invoice, the same price for everyone including the founder; nobody has a free account.',
			'Also on the platform: one shared recent feed of every published work (/works, also the home page); each work\'s page at its /nb/ link with a permanent citable short link; global discussion boards; a ~133-language translation mesh; and the entire database is public at /data/ — radical transparency by design.',
			'Help people author and publish works, find and cite what others made, understand challenges and the economy, and make the most of ArtaQuest.',
			// ArtaBot kept answering "I have no visibility into where I'm hosted" — true of the model, but
			// the FACTS are ours to state and they are already public (the whole database is). Withholding
			// them read as evasive about our own infrastructure on a platform whose premise is that a
			// stranger can check everything. Say what is true; do not speculate beyond it.
			'How you run, if anyone asks — this is public, so answer plainly rather than saying you cannot see it: you are Claude Opus 5, reached through headless Claude Code running on the operator\'s Claude Max SUBSCRIPTION (never a metered API key), by a small Node relay running in Microsoft Azure Container Apps in the Sweden Central region — on-demand containers that start when a turn arrives and shut down to nothing when nobody is talking to you, so idle time costs the Foundation nothing. ArtaQuest pushes each turn to that container and holds the connection open while you answer, streaming your words back as you write them, which is why members watch them appear. '
				. ( $tools
					// The honest version of the boundary, because a member WILL ask what you can reach —
					// and the answer being checkable is the whole premise of the platform.
					? 'This turn runs in a Linux container with real tools: a shell, Python, Node and the open internet, plus `browse <url>` for a real browser.'
						. ( $shell
							// Worth stating precisely, because it changes what a member should ask for: the work
							// PERSISTS, and they can walk into it from their own terminal.
							? ' You are working in THEIR OWN home directory, kept on a file share so it survives between messages and outlives any one container. ' . ( Shell::ssh_ready()
										? 'They can reach the very same files themselves with `ssh ' . $shell . '@' . Shell::reach() . '`.'
										: 'They can open the same files in a terminal from their ArtaQuest settings page; connecting with their own ssh client is being rebuilt for the new hosting. Never offer a hostname or an address for either — point them at Settings.' )
									. ' So building something for them is worth doing properly: it will still be there.'
							: ' The sandbox is destroyed when the turn ends.' ) . ' It holds NO ArtaQuest credentials and cannot reach the database, production or the private network — every member-facing action still goes through the platform, and publication still needs the author\'s own emailed confirmation and passkey, which nothing you can run will ever substitute for.'
					: 'This turn runs with NO tools — no shell, no file access, no web browsing — so you can only write chat messages and open a contribution on someone\'s behalf.' )
				. ' You do not know anything about the machine beyond this paragraph, and you must not guess at hostnames, addresses, credentials or internals; say you were not told.',
			'Brand voice: plain accessible English, BRITISH spelling, no trailing full stops on headings, warm. Be VERY CONCISE — give the SHORTEST genuinely-helpful answer, ideally one sentence, at most two or three; never restate the question, never pad with pleasantries, preambles or sign-offs, never list things the member did not ask for. Expand only when they truly need the detail. Never invent features that do not exist.' . $who,
		];
		// EVERYONE — member or signed-out visitor — can have ArtaBot file contributions, instead of
		// being pointed at a form (the form itself stays members-only; this chat is the signed-out
		// path, ticket #46).
		$kinds = implode( ' | ', array_keys( Tickets::KINDS ) );
		$lines[] = '';
		$lines[] = "FILING CONTRIBUTIONS — when the member reports something actionable (a bug, a concrete feature, a content/copy/translation fix, or a clear suggestion), open it for them YOURSELF; do not tell them to visit a form. Ask at most one clarifying question if you genuinely need it; otherwise, the moment it is concrete enough to act on, confirm in ONE short sentence, then append — last in your reply — a single fenced code block tagged aqmeta with minified JSON. ONE issue:";
		$lines[] = '```aqmeta';
		$lines[] = '{"file":true,"kind":"bug","title":"short imperative title","body":"a sentence or two a developer can act on, including where it happens","queue":true}';
		$lines[] = '```';
		$lines[] = 'If one message raises SEVERAL distinct issues, file EACH as its own contribution in one block — never bundle them into one ticket:';
		$lines[] = '```aqmeta';
		$lines[] = '{"issues":[{"kind":"bug","title":"…","body":"…","queue":true},{"kind":"feature","title":"…","body":"…","queue":true}]}';
		$lines[] = '```';
		$lines[] = "Rules: \"kind\" is one of {$kinds}; \"title\" is ≥4 characters; \"body\" is ≥10 characters; \"queue\" is true when it is concrete enough to build right away, false if it still needs the member to confirm a detail. Emit the aqmeta block ONLY on the single turn you actually file — never twice for the same issue, and never for plain questions or chit-chat. The block is stripped before the member sees the message, so keep everything human-facing above it. The system appends the filed-ticket link(s) for you — do NOT write your own \"filed as #N\" text.";

		if ( ! $uid ) {
			// A signed-out visitor CAN file (their ticket is ownerless and queues straight to the
			// worker), but they can never reply on the ticket page itself — so the chat is the only
			// place to clarify, and a half-baked filing would strand with no owner to answer triage.
			$lines[] = '';
			$lines[] = 'This visitor is NOT signed in. They can still file — but they cannot reply on the ticket page afterwards, so this chat is your only chance to clarify: file ONLY once the report is concrete (ask your one question first if you need it), and always set "queue":true. When you file, add a gentle note that signing in next time would let them track the ticket and hear when it ships.';
		} else {
			// GROUND TRUTH against guessing: the member's recent contributions, straight from the DB.
			// Without this the model answered "is it filed?" from conversational memory and got it wrong
			// (re-filed the wrong issue, asked "which one?" about a ticket the member had just named).
			$recent = Data::all(
				'SELECT id, kind, status, title FROM ' . Data::t( 'aq_tickets' ) . ' WHERE user_id = %d ORDER BY id DESC LIMIT 8',
				[ $uid ]
			);
			if ( $recent ) {
				$lines[] = '';
				$lines[] = "THE MEMBER'S RECENT CONTRIBUTIONS (live from the database — TRUST THIS LIST over the conversation when answering \"did you file it?\" / \"what's the status?\"; never re-file anything already here):";
				foreach ( $recent as $r ) {
					$lines[] = "- #{$r['id']} [{$r['kind']}, {$r['status']}] {$r['title']}";
				}
				$lines[] = 'When you mention a contribution, link it as [#N](/issues/?ticket=N).';
			}
		}
		return implode( "\n", $lines );
	}

	// Anonymous visitors get their OWN 1,000-token free allowance so anyone — even
	// logged-out — can ask ArtaBot a question or report a problem. Conversation tracked per client
	// `anon` id (the FE keeps one in localStorage) in a transient; no account needed.
	private static function anon_key( $req ) {
		$id = preg_replace( '/[^a-z0-9]/i', '', (string) Rest::p( $req, 'anon', '' ) );
		return strlen( $id ) >= 6 ? 'aq_bot_anon_' . substr( $id, 0, 40 ) : '';
	}
	private static function anon_state( $key ) {
		$s = get_transient( $key );
		return is_array( $s ) ? $s : [ 'msgs' => [] ];
	}

	/** GET /artabot — the visitor's recent ArtaBot conversation. */
	public static function history( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) {
			$key = self::anon_key( $req );
			$s   = $key ? self::anon_state( $key ) : [ 'msgs' => [] ];
			return [ 'items' => array_values( $s['msgs'] ), 'anon' => true ];
		}
		// Scoped to ONE conversation. Without the scope, several parallel sessions would render as one
		// interleaved transcript — every member's chats stirred together in arrival order.
		$sid  = (int) Rest::p( $req, 'session', 0 );
		$rows = $sid > 0
			? Data::all( 'SELECT id, role, body, tokens, created FROM ' . Data::t( 'aq_artabot_messages' ) . ' WHERE user_id = %d AND session_id = %d ORDER BY id DESC LIMIT 50', [ $uid, $sid ] )
			: Data::all( 'SELECT id, role, body, tokens, created FROM ' . Data::t( 'aq_artabot_messages' ) . ' WHERE user_id = %d AND session_id = 0 ORDER BY id DESC LIMIT 50', [ $uid ] );
		$rows = array_reverse( $rows );
		// A turn still being worked on carries PENDING_BODY: report it as `pending` with an EMPTY body so
		// the client shows a thinking state instead of the raw marker. This is what makes "no time limits"
		// visible — the member sees the turn in progress and the answer fills in whenever it lands.
		$items = array_map( function ( $m ) {
			$pending = (string) $m['body'] === self::PENDING_BODY;
			return [
				'id' => (int) $m['id'], 'role' => $m['role'], 'body' => $pending ? '' : (string) $m['body'],
				'tokens' => (int) $m['tokens'], 'at' => (int) $m['created'], 'pending' => $pending,
			];
		}, $rows );
		return [ 'items' => $items, 'working' => (bool) array_filter( $items, fn( $i ) => $i['pending'] ) ];
	}

	/** POST /artabot {message} — one turn of the global chat. Free + unlimited; persists both sides. */
	public static function ask( $req ) {
		$uid = Rest::uid();
		// MEMBERS ONLY (operator 2026-07-25): ArtaBot is a reason to sign up, not a public service.
		// The route is 'user'-auth already; this is the independent second gate.
		if ( ! $uid ) { return Rest::err( 'signin_required', 'Sign in (free) to chat with ' . self::NAME, 401 ); }
		if ( Rest::throttle( 'artabot', 60, 3600 ) ) { return Rest::err( 'rate_limited', 'Give ' . self::NAME . ' a moment', 429 ); }
		$text    = sanitize_textarea_field( (string) Rest::p( $req, 'message', '' ) );
		$raw_img = (string) Rest::p( $req, 'image', '' );
		$img     = self::image_block_from_data_url( $raw_img );
		if ( mb_strlen( $text ) < 1 && ! $img ) { return Rest::err( 'bad_input', 'Type a message' ); }
		if ( ! self::online() ) { return Rest::err( 'offline', self::NAME . ' is offline right now', 503 ); }

		// Persist only the member's TEXT in the chat transcript — a shared screenshot is shown to Claude for
		// THIS turn but kept out of the (fully public) chat history; a bare image still reads sensibly via a
		// short marker. Exception: if this turn FILES a contribution, that screenshot IS saved onto the
		// ticket so developers see the context the member shared (file_from_meta, #120) — the same public
		// footing as a form-filed shot; a screenshot shared in ordinary chat is still never stored.
		// WHICH CONVERSATION. A member may have several open and running at once; each is its own
		// transcript, its own machine size and its own bill, so the session has to be established
		// before anything is written or charged.
		$sid = self::session_for( $uid, Rest::p( $req, 'session', 0 ) );
		if ( $sid < 0 ) { return Rest::err( 'no_session', 'That conversation is not open', 404 ); }
		$sess = $sid > 0 ? Data::one( 'SELECT id, tier FROM ' . Data::t( 'aq_artabot_sessions' ) . ' WHERE id = %d', [ $sid ] ) : null;

		$stored = $text !== '' ? $text : '[shared a screenshot]';
		$umid   = Data::insert( 'aq_artabot_messages', [ 'user_id' => $uid, 'session_id' => $sid, 'role' => 'user', 'body' => $stored, 'created' => Data::now() ] );

		// ── EFFORT TIER ────────────────────────────────────────────────────────────────────────────
		// Nothing is charged here. A turn is priced when it replies (Usage::record), keyed to this id, so
		// a resend after a BUSY reply re-asks under a NEW ref (a fresh turn, fairly charged) while a
		// retried identical request can never double-bill.
		// The tier belongs to the CONVERSATION, not the message: it is the size of machine this work runs
		// on, and changing it mid-thread would silently change what the member is paying per turn.
		$tier = Usage::tier( $sess ? $sess['tier'] : Rest::p( $req, 'effort', self::FREE_TIER ) );
		$tref = 'u' . (int) $uid . ':m' . (int) $umid;
		// TRUE PAY-PER-USE (operator 2026-08-08): nothing is reserved. What a turn costs is not known
		// until it has replied, so there is no honest number to hold up front — the gate is what the
		// member already owes. Usage::DEBT_FLOOR is the slack that lets a turn finish and settle even
		// if it lands over the balance it started with; the NEXT one is what gets refused.
		if ( ! Usage::may_start( $uid ) ) {
			return Rest::err( 'insufficient_coins', 'Your balance is below the floor — top up to keep using ' . self::NAME . ', or see your usage for what has been charged', 402 );
		}

		// Context from THIS conversation only — feeding one session's history into another is both a
		// wrong answer and a privacy surprise, since the member deliberately kept them apart.
		$rows = Data::all(
			'SELECT role, body FROM ' . Data::t( 'aq_artabot_messages' ) . ' WHERE user_id = %d AND session_id = %d ORDER BY id DESC LIMIT 40',
			[ $uid, $sid ]
		);
		$rows = array_reverse( $rows );
		$turns = [];
		// Skip any STILL-PENDING assistant row (an earlier turn the worker hasn't finished): its body is
		// an internal marker, and feeding that to the model would put "__AQ_PENDING__" in the transcript.
		foreach ( $rows as $r ) {
			if ( (string) $r['body'] === self::PENDING_BODY ) { continue; }
			self::push_turn( $turns, $r['role'] === 'assistant' ? 'assistant' : 'user', (string) $r['body'] );
		}
		if ( ! $turns || $turns[0]['role'] !== 'user' ) { array_unshift( $turns, [ 'role' => 'user', 'content' => $stored ] ); }
		if ( $img ) { self::attach_image( $turns, $img ); } // multimodal: send the screenshot with this turn

		// NO TIME LIMITS (operator 2026-07-25). Every turn carries a delivery marker, so if it outruns the
		// HTTP budget the worker keeps going and the answer lands in the transcript later — the member is
		// never told to "resend". A pending assistant row is created UP FRONT so the transcript shows the
		// turn is in progress, and deliver() fills it in whenever the answer (or workflow) completes.
		$amid = Data::insert( 'aq_artabot_messages', [ 'user_id' => $uid, 'session_id' => $sid, 'role' => 'assistant', 'body' => self::PENDING_BODY, 'created' => Data::now() ] );
		$skey = self::live_key( $req, $sid );
		// Start the buffer BEFORE the worker can write to it, so the SPA's first poll finds a thinking
		// state rather than an empty 404-ish gap and can show that ArtaBot has begun.
		if ( $skey ) { set_transient( $skey, [ 'seq' => 1, 'text' => '', 'think' => 0, 'phase' => 'thinking', 'done' => 0 ], Relay::LIVE_TTL ); }
		$dlv  = [ 'kind' => 'artabot', 'uid' => $uid, 'amid' => (int) $amid, 'sid' => $sid, 'tier' => $tier, 'ref' => $tref, 'prompt' => $stored, 'stream' => $skey ];
		$tools = self::tools_for( $uid, (bool) $img );
		// The member's own machine account (Shell::unix_name of their handle) — a tool turn runs THERE,
		// in the home they can ssh into, so chat and terminal are one workspace rather than two.
		$u     = get_userdata( $uid );
		$shell = $tools ? Shell::unix_name( $u ? $u->user_nicename : '' ) : '';
		$out   = self::chat( $turns, self::artabot_prompt( $uid, $tools, $shell ), null, Usage::TIERS[ $tier ]['maxtok'], $tier, $dlv, $skey, $tools, $shell );
		if ( $out === Relay::PENDING ) {
			return [ 'pending' => true, 'id' => (int) $amid, 'session' => $sid, 'tier' => $tier, 'live' => (bool) $skey,
			         'message' => self::NAME . ' is working on this one — the answer will appear here when it lands' ];
		}
		// BUSY = the relay (subscription) is answering but slower than the budget; we never bill the
		// API for it. The member's message is kept, so resending re-asks with full context.
		// A PAID tier that produced no answer is refunded — a member pays for a reply, not an attempt.
		// Neither path charges anything: a turn is priced when it replies, and neither of these replied.
		if ( $out === self::BUSY ) { return Rest::err( 'busy', self::NAME . ' is taking a little longer than usual on this one — please resend in a moment, you were not charged', 503 ); }
		if ( $out === null ) { return Rest::err( 'upstream', self::NAME . ' hit a snag — please try again, you were not charged', 502 ); }

		$in    = (int) ( $out['usage']['input_tokens'] ?? 0 );
		$outk  = (int) ( $out['usage']['output_tokens'] ?? 0 );

		// ArtaBot may file contribution(s) for the member on this turn — the aqmeta block is stripped
		// from what the member sees; each filing is confirmed with a LINK (see file_from_meta).
		[ $reply, $meta ] = self::split_meta( $out['text'] );
		if ( $reply === '' ) { $reply = 'Sorry, I have nothing to add there'; }
		[ $filed, $ticket ] = self::file_from_meta( $uid, $meta, $stored, false, $raw_img );
		if ( $filed ) { $reply .= "\n\n" . implode( "\n", $filed ); }

		// FILL the placeholder created before the call — never insert a second assistant row, or a fast
		// answer would post twice (once here, once as the still-pending bubble).
		$mid = (int) $amid;
		Data::update( 'aq_artabot_messages', [ 'body' => $reply, 'tokens' => $in + $outk ], [ 'id' => $mid ] );
		$reply_msg = [ 'id' => $mid, 'role' => 'assistant', 'body' => $reply, 'tokens' => $in + $outk, 'at' => Data::now() ];
		if ( $ticket ) { $reply_msg['ticket'] = $ticket; }
		return [ 'reply' => $reply_msg ];
	}

	/** A logged-out visitor's turn — the same chat, free + unlimited (no account needed; the hourly rate
	 *  limit above is the only guard). Conversation lives in a per-anon transient so ArtaBot remembers
	 *  within the session. ArtaBot files issues for signed-out visitors too (ticket #46) — ownerless,
	 *  uid 0; signing in adds cross-device memory, ticket ownership (reply/resolve) and ship alerts. */
	private static function ask_anon( $req ) {
		$key = self::anon_key( $req );
		if ( ! $key ) { return Rest::err( 'bad_input', 'Reload the page to start a free chat.' ); }
		if ( Rest::throttle( 'artabot_anon', 40, 3600 ) ) { return Rest::err( 'rate_limited', 'Give ' . self::NAME . ' a moment', 429 ); }
		$text    = sanitize_textarea_field( (string) Rest::p( $req, 'message', '' ) );
		$raw_img = (string) Rest::p( $req, 'image', '' );
		$img     = self::image_block_from_data_url( $raw_img );
		if ( mb_strlen( $text ) < 1 && ! $img ) { return Rest::err( 'bad_input', 'Type a message' ); }
		if ( ! self::online() ) { return Rest::err( 'offline', self::NAME . ' is offline right now', 503 ); }
		$s = self::anon_state( $key );
		$stored = $text !== '' ? $text : '[shared a screenshot]';
		$turns = [];
		foreach ( $s['msgs'] as $m ) { self::push_turn( $turns, ( $m['role'] ?? '' ) === 'assistant' ? 'assistant' : 'user', (string) ( $m['body'] ?? '' ) ); }
		self::push_turn( $turns, 'user', $stored );
		if ( ! $turns || $turns[0]['role'] !== 'user' ) { array_unshift( $turns, [ 'role' => 'user', 'content' => $stored ] ); }
		if ( $img ) { self::attach_image( $turns, $img ); } // multimodal: send the screenshot with this turn

		$out = self::chat( $turns, self::artabot_prompt( 0 ) );
		if ( $out === self::BUSY ) { return Rest::err( 'busy', self::NAME . ' is taking a little longer than usual on this one — please resend in a moment', 503 ); }
		if ( $out === null ) { return Rest::err( 'upstream', self::NAME . ' hit a snag — please try again', 502 ); }
		// Signed-out visitors file too (ticket #46): the same aqmeta contract, with uid 0 — the ticket
		// is ownerless and ALWAYS queued (see file_from_meta for why), and the confirmation link(s) are
		// appended exactly as for a member, so the filing survives in the saved transcript.
		[ $reply, $meta ] = self::split_meta( $out['text'] );
		if ( $reply === '' ) { $reply = 'Sorry, I have nothing to add there'; }
		[ $filed, $ticket ] = self::file_from_meta( 0, $meta, $stored, true, $raw_img );
		if ( $filed ) { $reply .= "\n\n" . implode( "\n", $filed ); }
		$used  = (int) ( $out['usage']['input_tokens'] ?? 0 ) + (int) ( $out['usage']['output_tokens'] ?? 0 );
		$now   = Data::now();
		$s['msgs'][] = [ 'id' => $now, 'role' => 'user', 'body' => $stored, 'tokens' => 0, 'at' => $now ];
		$s['msgs'][] = [ 'id' => $now + 1, 'role' => 'assistant', 'body' => $reply, 'tokens' => $used, 'at' => $now ];
		$s['msgs'] = array_slice( $s['msgs'], -40 );
		set_transient( $key, $s, 7 * DAY_IN_SECONDS );
		$reply_msg = [ 'id' => $now + 1, 'role' => 'assistant', 'body' => $reply, 'tokens' => $used, 'at' => $now ];
		if ( $ticket ) { $reply_msg['ticket'] = $ticket; } // FE chip — same shape the member path returns
		return [ 'reply' => $reply_msg ];
	}

	/** File the contribution(s) an aqmeta block describes — either ONE issue ({"file":true,kind,…}) or
	 *  SEVERAL ({"issues":[{kind,…},…]}) — so a message that reports two distinct problems becomes two
	 *  tickets instead of one bundled mess (a real failure we saw). $uid may be 0: a signed-out
	 *  visitor's report files ownerless (author shows as "Visitor") under its own per-IP cap, and
	 *  $force_queue sends it straight to the worker — an ownerless ticket parked 'open' would strand,
	 *  because triage's clarifying questions land on a ticket page only the (absent) owner may reply to.
	 *  $screenshot_data_url, when set, is the screenshot the member attached to THIS chat turn: it is saved
	 *  to the uploads dir ONCE and stored on the ticket(s) filed here (#120), so the original image shows on
	 *  the contribution detail page — the same public footing as a form-filed shot.
	 *  $fallback_body (the member's original message this turn) is also passed through as the ticket's
	 *  originating chat prompt, so the detail page shows the raw words behind ArtaBot's title/body (#121).
	 *  Returns [ confirmation-lines[], FE-chip-for-the-last-filing|null ]. */
	private static function file_from_meta( $uid, $meta, $fallback_body, $force_queue = false, $screenshot_data_url = '' ) {
		$to_file = [];
		if ( $meta && ! empty( $meta['issues'] ) && is_array( $meta['issues'] ) ) { $to_file = $meta['issues']; }
		elseif ( $meta && ! empty( $meta['file'] ) ) { $to_file = [ $meta ]; }
		$filed  = [];
		$ticket = null;
		$shot   = null; // the turn's screenshot, saved to uploads ONCE on the first filing then shared across a multi-issue turn (#120)
		foreach ( array_slice( $to_file, 0, 5 ) as $one ) { // bound a runaway block at 5 filings/turn
			if ( ! is_array( $one ) ) { continue; }
			// Anonymous filings get their own per-IP hourly cap, tighter than the chat throttle — a
			// queued ticket is autonomous-developer time, the scarcer resource. Honest use (a visitor
			// reporting a handful of issues) never sees it.
			if ( ! $uid && Rest::throttle( 'ticket_anon', 10, 3600 ) ) {
				if ( ! $filed ) { $filed[] = 'I can’t file any more reports from this connection just now — please try again in a little while, or sign in to file straight away.'; }
				break;
			}
			// Persist the shared screenshot only now that we're actually filing (an image shared in ordinary
			// chat is never stored). Saved once and reused for every issue in a multi-issue turn; fail-open —
			// a bad/oversized image just yields '' and the ticket files without one.
			if ( $shot === null && $screenshot_data_url !== '' ) {
				$shot = Tickets::save_data_url_image( $screenshot_data_url, $uid );
			}
			$res = Tickets::open_from_chat(
				$uid, (string) ( $one['kind'] ?? 'suggestion' ),
				(string) ( $one['title'] ?? '' ), (string) ( $one['body'] ?? $fallback_body ),
				'', $force_queue || ! empty( $one['queue'] ), (string) $shot,
				// The member's ORIGINAL message this turn — preserved on the ticket so the detail page
				// shows the raw words behind ArtaBot's cleaned-up title/body (#121).
				(string) $fallback_body
			);
			if ( ! $res ) { continue; }
			$ticket  = [ 'id' => $res['id'], 'kind' => $res['kind'], 'status' => $res['status'] ]; // FE chip → the last filing
			$filed[] = $res['new']
				? "Filed as [#{$res['id']}](/issues/?ticket={$res['id']}) ({$res['kind']})."
				// A true content match — this exact report is already on file. Say so honestly (with the
				// link) rather than imply a fresh filing, and offer the escape hatch so a rare genuine
				// collision never silently swallows a new contribution.
				: "Already on file as [#{$res['id']}](/issues/?ticket={$res['id']}) — if you meant something different, add a detail or two and I’ll open a fresh one.";
		}
		return [ $filed, $ticket ];
	}

	/** POST /artabot/clear — forget this visitor's conversation. */
	public static function clear( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { $key = self::anon_key( $req ); if ( $key ) delete_transient( $key ); return [ 'ok' => true ]; }
		if ( $uid ) {
			$GLOBALS['wpdb']->delete( Data::t( 'aq_artabot_messages' ), [ 'user_id' => $uid ] );
		}
		return [ 'ok' => true ];
	}

	// ── shared HTTP + parsing ────────────────────────────────────────────────────
	/** Append a turn, merging into the previous one when the mapped role repeats (API needs alternation). */
	private static function push_turn( &$turns, $role, $text ) {
		if ( $turns && $turns[ count( $turns ) - 1 ]['role'] === $role ) {
			$turns[ count( $turns ) - 1 ]['content'] .= "\n\n" . $text;
		} else {
			$turns[] = [ 'role' => $role, 'content' => $text ];
		}
	}

	/** Prepend an image block to the LAST user turn (string content → [ image, text ]) so Claude sees the
	 *  attached screenshot alongside what the member just sent — the same multimodal shape the triager uses. */
	private static function attach_image( &$turns, $img ) {
		for ( $i = count( $turns ) - 1; $i >= 0; $i-- ) {
			if ( $turns[ $i ]['role'] === 'user' ) {
				$text = (string) $turns[ $i ]['content'];
				$turns[ $i ]['content'] = $text === '' ? [ $img ] : [ $img, [ 'type' => 'text', 'text' => $text ] ];
				return;
			}
		}
	}

	/** Answer one turn on the SUBSCRIPTION relay only (the paid API was removed 2026-06-13). Returns
	 *  [ 'text'=>…, 'usage'=>… ], self::BUSY (relay alive but slow → caller asks to resend), or null
	 *  (relay offline → caller shows ArtaBot's default "offline" message). Defaults are the CHAT
	 *  profile (latest Opus, low effort, tight ceiling — fast); triage keeps the model and effort and
	 *  overrides only the output ceiling (TRIAGE_MAXTOK protects the trailing aqmeta block). */
	private static function chat( $messages, $system, $model = null, $max_tokens = null, $effort = 'low', $deliver = null, $stream_key = '', $tools = false, $shell_user = '' ) {
		// SUBSCRIPTION-ONLY (operator rule 2026-06-13): every turn runs on the Claude Max subscription
		// via the laptop relay (headless `claude -p`, src/Relay.php) — the paid Anthropic API has been
		// removed from the platform entirely. Relay::ask returns the answer; self::BUSY (relay alive but
		// slower than its wait budget) → the caller degrades gracefully (asks the member to resend); or
		// null → the relay is genuinely unavailable (laptop away/asleep/usage-limited), and the caller
		// shows ArtaBot's default "offline" message. There is no API fallback.
		$via = Relay::ask( $messages, $system, $model ?: self::MODEL, $max_tokens ?: self::MAXTOK, $effort, $deliver, $stream_key, $tools, $shell_user );
		if ( $via === Relay::PENDING ) { return Relay::PENDING; } // async: the worker keeps going, deliver() lands it
		if ( $via === Relay::BUSY ) { return self::BUSY; }
		return $via; // a [text,usage] array, or null when the subscription relay is unavailable
	}

	/** An Anthropic image content block for a screenshot URL (read from the uploads dir, base64).
	 *  Returns null if the file isn't a readable local image. */
	private static function image_block( $url ) {
		if ( ! $url ) { return null; }
		$up   = wp_upload_dir();
		$path = str_replace( $up['baseurl'], $up['basedir'], (string) $url );
		if ( $path === $url || ! is_string( $path ) || ! @file_exists( $path ) ) { return null; }
		$bytes = @file_get_contents( $path );
		if ( $bytes === false ) { return null; }
		$mime = function_exists( 'mime_content_type' ) ? mime_content_type( $path ) : 'image/png';
		if ( strpos( (string) $mime, 'image/' ) !== 0 ) { return null; }
		return [ 'type' => 'image', 'source' => [ 'type' => 'base64', 'media_type' => $mime, 'data' => base64_encode( $bytes ) ] ];
	}

	/** An Anthropic image block from a `data:image/…;base64,…` URL — how the chat composer sends a screenshot
	 *  a member attaches. Returns null for anything that isn't a supported, in-bounds image, so a bad or
	 *  oversized attachment is simply dropped and the turn proceeds as text (fail-open, never blocks a reply). */
	private static function image_block_from_data_url( $data_url ) {
		$data_url = (string) $data_url;
		if ( $data_url === '' || ! preg_match( '#^data:(image/(?:png|jpe?g|gif|webp));base64,#i', $data_url, $m ) ) {
			return null;
		}
		$mime  = strtolower( $m[1] ) === 'image/jpg' ? 'image/jpeg' : strtolower( $m[1] );
		$bytes = base64_decode( preg_replace( '/\s+/', '', substr( $data_url, strpos( $data_url, ',' ) + 1 ) ), true );
		if ( $bytes === false || $bytes === '' || strlen( $bytes ) > self::MAX_CHAT_IMAGE_BYTES ) { return null; }
		return [ 'type' => 'image', 'source' => [ 'type' => 'base64', 'media_type' => $mime, 'data' => base64_encode( $bytes ) ] ];
	}

	/** Pull the trailing aqmeta classifier out of a reply → [ visible_text, meta|null ].
	 *  The block is always LAST, so we find where "aqmeta" begins (fenced or not, any formatting)
	 *  and cut everything from there to the end — robust to a missing/odd closing fence so the JSON
	 *  never leaks into what the member sees. */
	private static function split_meta( $text ) {
		$meta = null;
		if ( preg_match( '/`{0,3}\s*aqmeta\b/is', $text, $m, PREG_OFFSET_CAPTURE ) ) {
			$cut   = $m[0][1];
			$block = substr( $text, $cut );
			if ( preg_match( '/\{.*\}/s', $block, $jm ) ) { $meta = json_decode( $jm[0], true ); }
			$text  = substr( $text, 0, $cut );
		}
		$visible = trim( rtrim( trim( $text ), "`\n " ) );
		return [ $visible, is_array( $meta ) ? $meta : null ];
	}

	// ── ArtaMod: a consoling reply on a flagged competition comment ───────────────
	/** The display name shown on ArtaBot's own discussion-board replies. */
	const BOT_SLUG = 'artabot';

	/** The WP user id ArtaBot posts under (lazily created once). ArtaBot has no password (passwordless
	 *  platform) and the subscriber role, so it can never sign in or act — it exists only to author the
	 *  consoling replies below. Cached in an option so the lookup is one read after first creation. */
	public static function bot_user_id() {
		$uid = (int) get_option( 'aq_artabot_uid', 0 );
		if ( $uid && get_userdata( $uid ) ) { return $uid; }
		$existing = get_user_by( 'login', self::BOT_SLUG );
		if ( $existing ) { $uid = (int) $existing->ID; }
		else {
			$uid = wp_insert_user( [
				'user_login'    => self::BOT_SLUG,
				'user_nicename' => self::BOT_SLUG,
				'display_name'  => self::NAME,
				'nickname'      => self::NAME,
				'user_email'    => self::BOT_SLUG . '@' . ( wp_parse_url( home_url(), PHP_URL_HOST ) ?: 'example.org' ),
				'user_pass'     => wp_generate_password( 40, true, true ),
				'role'          => 'subscriber',
			] );
			if ( is_wp_error( $uid ) ) { error_log( 'AQ ArtaBot user: ' . $uid->get_error_message() ); return 0; }
			update_user_meta( $uid, 'aq_full_name', self::NAME );          // satisfies the identity gate, harmless
			update_user_meta( $uid, 'description', 'ArtaQuest’s friendly AI guide.' );
		}
		update_option( 'aq_artabot_uid', $uid, true );
		return (int) $uid;
	}

	/**
	 * Leave a warm, consoling reply on a section comment ArtaMod flagged for hate/fear, and
	 * notify its author. The flagged comment isn't deleted and no coin is charged — only its upvotes
	 * are kept out of the competition (Economy::podium). The reply is authored by the ArtaBot user and
	 * attached to the flagged comment's TOP-LEVEL ancestor (the board is one-level), so it always lands
	 * as a valid reply. ArtaBot's own reply is never itself ArtaMod-scored.
	 *
	 * @param int $comment_id  the flagged comment
	 * @param int $cid         course id
	 * @param int $lid         lesson (section) id — the board context
	 * @param int $parent_id   the flagged comment's parent (0 if it is top-level)
	 * @param int $author_uid  the flagged comment's author (notified)
	 */
	public static function console_fear( $comment_id, $cid, $lid, $parent_id, $author_uid ) {
		$bot = self::bot_user_id();
		if ( ! $bot ) { return; }
		// One-level threading: reply under the top-level ancestor (the flagged comment itself if it is
		// top-level, else its parent), so the tree stays valid.
		$reply_parent = (int) $parent_id > 0 ? (int) $parent_id : (int) $comment_id;

		$messages = [
			"Hey, ArtaBot here 💙 I’ve gently set this reply aside from the competition — it read as leaning on fear or contempt rather than curiosity. Nothing’s deleted and no coins were touched. The world can feel frightening, but please don’t let it harden you: most people are quietly trying their best, and there’s far more good out there than the loudest voices suggest. Reword it from a calmer place and it’ll count again. We’re really glad you’re here.",
			"ArtaBot here, with no judgement at all 💙 This reply tipped past our one line — ArtaMod reads only for hate or fear — so its upvotes won’t count toward the competition for now. Nothing was removed and you weren’t charged. Try not to be afraid; have a little more faith in people. We’re all just learners here, and curiosity beats dread every time. Edit it whenever you’re ready and it’s back in the running.",
			"A small note from ArtaBot 💙 I’ve kept this one out of the competition — it leaned into fear or hostility, and ArtaQuest is built to protect calm, fearless thinking. You’ve done nothing wrong and nothing’s been deleted. Fear narrows us; faith in one another opens us back up. Give the world, and the people in it, a little more credit — then rephrase from there, and your reply rejoins the board.",
		];
		$body = $messages[ (int) $comment_id % count( $messages ) ];

		$id = Data::insert( 'aq_comments', [
			'context_type' => 'section', 'context_id' => (int) $lid, 'course_id' => (int) $cid,
			'author_id' => $bot, 'parent_id' => $reply_parent, 'body' => $body, 'lang' => 'en',
			'votes' => 0, 'reply_count' => 0, 'fear' => 0, 'flagged' => 0, 'created' => Data::now(),
		] );
		Data::bump( 'aq_comments', [ 'id' => $reply_parent ], 'reply_count', 1 );
		Data::bump( 'aq_lessons', [ 'id' => (int) $lid ], 'comment_count', 1 ); // the bot reply is a section comment too
		if ( (int) $author_uid ) {
			Notify::push( (int) $author_uid, 'fearometer', 'ArtaBot replied to your comment',
				'ArtaMod set your comment aside from the competition — ArtaBot left you a note.',
				'/video/?video=' . (int) $lid, 'fear' . (int) $comment_id );
		}
		return $id;
	}

	/** Append a message to a ticket conversation and bump its counter. Returns its shape. */
	private static function store_ticket_msg( $ticket_id, $role, $body, $meta = null ) {
		$mid = Data::insert( 'aq_ticket_messages', [
			'ticket_id' => $ticket_id, 'role' => $role, 'body' => $body,
			'meta' => $meta === null ? null : Data::enc( $meta ), 'created' => Data::now(),
		] );
		Data::bump( 'aq_tickets', [ 'id' => $ticket_id ], 'msg_count', 1 );
		return [ 'id' => $mid, 'role' => $role, 'body' => $body, 'at' => Data::now() ];
	}
	// ── @artabot mentions (operator 2026-07-30) ───────────────────────────────────────────────
	/**
	 * ArtaBot answers when it is TAGGED, anywhere on the platform — the Grok pattern: someone writes
	 * "what do you think about this @artabot?" under a post and it replies in that thread.
	 *
	 * A CRON, not a hook on the comment POST. Three reasons, all learned the hard way here: the relay
	 * is asynchronous and may be cold, so a synchronous reply would make a member wait or fail their
	 * comment; a hook that throws would take the comment down with it; and a queue can be drained,
	 * retried and rate-limited, which a hook cannot.
	 *
	 * IDEMPOTENT BY CONSTRUCTION: it only considers comments that have no ArtaBot child, so a reply
	 * is written once and a re-run is a no-op. That is the same discipline as the ledgers — never
	 * "have I done this?" in memory, always "does the artefact exist?" in the table.
	 */
	const MENTION_RE    = '/(^|[^a-z0-9_])@artabot\b/i';
	const MENTION_BATCH = 3;    // replies per tick — it is a participant, not a flood
	const MENTION_MAX_AGE = 172800; // 48 h — an old thread is not worth waking up

	public static function mention_tick() {
		$bot = (int) get_option( 'aq_artabot_uid', 0 );
		if ( ! $bot ) { return; }
		$since = time() - self::MENTION_MAX_AGE;
		// Candidates: recent comments that MENTION the bot, are not BY the bot, and have no bot reply.
		$rows = Data::all(
			'SELECT c.id, c.context_type, c.context_id, c.course_id, c.author_id, c.body, c.lang'
			. ' FROM ' . Data::t( 'aq_comments' ) . ' c'
			. ' WHERE c.author_id <> %d AND c.flagged = 0 AND c.created >= %d'
			. " AND c.body LIKE %s"
			. ' AND NOT EXISTS ( SELECT 1 FROM ' . Data::t( 'aq_comments' ) . ' r'
				. ' WHERE r.parent_id = c.id AND r.author_id = %d )'
			. ' ORDER BY c.id DESC LIMIT %d',
			[ $bot, $since, '%@artabot%', $bot, self::MENTION_BATCH ] );
		foreach ( (array) $rows as $c ) {
			try {
				// LIKE is only a prefilter — it would also match an email or a word ending in @artabot.
				if ( ! preg_match( self::MENTION_RE, (string) $c['body'] ) ) { continue; }
				$reply = self::mention_reply( $c );
				if ( '' === $reply ) { continue; }   // relay cold: leave it queued for the next tick
				Data::insert( 'aq_comments', [
					'context_type' => (string) $c['context_type'], 'context_id' => (int) $c['context_id'],
					'course_id' => (int) $c['course_id'], 'parent_id' => (int) $c['id'],
					'author_id' => $bot, 'body' => $reply, 'lang' => (string) ( $c['lang'] ?: 'en' ),
					'created' => Data::now(), 'updated' => Data::now(),
				] );
				Data::bump( 'aq_comments', [ 'id' => (int) $c['id'] ], 'reply_count', 1 );
			} catch ( \Throwable $e ) { /* one bad thread never stalls the queue */ }
		}
	}

	/** One reply, in ArtaBot's own voice, grounded in the thread it was tagged in. */
	private static function mention_reply( $c ) {
		$ctx = 'A member tagged you in a discussion on ArtaQuest and asked for your view.' . "\n\n"
			. 'THEIR COMMENT: ' . mb_substr( wp_strip_all_tags( (string) $c['body'] ), 0, 1200 );
		$sys = 'You are ArtaBot, ArtaQuest\'s independent agent. You were TAGGED, so answer directly and '
			. 'in your own voice. Be genuinely useful and specific; say plainly when you do not know or when '
			. 'the question cannot be settled from what is in front of you. Never invent a figure, a source or '
			. 'an event. Never assert a cause for something an instrument merely measured. Plain accessible '
			. 'English, British spelling, no hype, no emoji, no markdown headings. Two short paragraphs at most.';
		$res = Relay::ask( [ [ 'role' => 'user', 'content' => $ctx ] ], $sys, self::MODEL, 700, 'low' );
		if ( ! is_array( $res ) || empty( $res['text'] ) ) { return ''; }
		return mb_substr( trim( wp_strip_all_tags( (string) $res['text'] ) ), 0, 2000 );
	}

}
