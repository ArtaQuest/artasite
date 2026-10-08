<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Contribution triage — the first responder on every ticket opened at /issues.
 *
 * WHAT IS LEFT OF THE OLD ASSISTANT (2026-10-08). The paid, private, metered chat assistant is gone:
 * no chat window, no sessions, no transcripts, no per-turn billing, no daily invoice. Arta now speaks
 * ONLY in public — tag @arta in a post or a comment and it answers in that thread (src/Arta.php,
 * answered by the Arta brain, arta-brain/). What remains here is the platform-borne work that was never
 * part of the paid product and never charged anyone:
 *   1. Ticket triage — on every contribution, Arta acknowledges, classifies the kind, asks one
 *      clarifying question when it must, and queues concrete work for the autonomous developer.
 *   2. ArtaMod's consoling note on a comment set aside from a competition (console_fear).
 *
 * Both run on the platform's model relay (src/Relay.php); when the relay is offline the ticket gets a
 * plain "logged, a maintainer will follow up" note. Nothing here bills a member.
 *
 * CONTAINMENT: no tools, no shell, no deploy authority — it writes ticket messages and can queue a
 * ticket for the autonomous developer, the same thing a member could do by hand.
 */
final class Assistant {

	/** The public name every surface shows for the assistant. One account, one name: @arta. */
	const NAME = 'Arta';
	/** Model selection belongs to the relay. An empty id lets the relay use its configured default, so
	 *  no vendor or model name is hard-coded on the platform. */
	const MODEL        = '';
	const TRIAGE_MODEL = '';
	// Triage output ceiling: the aqmeta block is LAST — a truncated reply would eat the classifier, so
	// triage keeps real headroom regardless of effort (the PROMPT keeps prose short).
	const TRIAGE_MAXTOK = 2400;
	// chat() returns this when the relay is alive but slower than its wait budget (Relay::BUSY).
	const BUSY   = '__AQ_ARTA_BUSY__';
	const MAXTOK = 800;

	const QUEUE_CONFIDENCE = 0.6;             // min classification confidence to auto-queue for the worker

	/** Can Arta triage at all? Only when the model relay is live; when it is offline the ticket gets
	 *  a plain "logged" note instead. */
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
	 *  absent or nothing is stale. Driven by the aq_retriage cron — so Arta safely continues after a
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
				"Thanks — your contribution is logged. Arta triage is offline right now, but a maintainer will pick this up. You alone close the ticket when you're happy" );
		}
		if ( Rest::throttle( 'assistant', 40, 3600 ) ) {
			return self::store_ticket_msg( $ticket_id, 'system', 'Arta is busy — please add your message again in a moment' );
		}

		// Every contribution is centred on a screenshot — show it to Arta on the first turn so it
		// triages from the actual evidence (the model is multimodal).
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
		// prepended to the turn being answered, so follow-up triage sees the new evidence.
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
			return self::store_ticket_msg( $ticket_id, 'system', 'Arta hit a snag — a maintainer will follow up. Your ticket is safe' );
		}

		[ $visible, $meta ] = self::split_meta( $out['text'] );
		if ( $visible === '' ) { $visible = $is_first ? 'Thanks for raising this — looking into it' : 'Noted, thank you'; }

		// Re-classify onto the right kind/track when Arta is confident.
		if ( $meta && isset( $meta['kind'], Tickets::KINDS[ $meta['kind'] ] )
			&& (float) ( $meta['confidence'] ?? 0 ) >= self::QUEUE_CONFIDENCE
			&& $meta['kind'] !== $t['kind'] ) {
			Data::update( 'aq_tickets', [ 'kind' => $meta['kind'] ], [ 'id' => $ticket_id ] );
		}

		// Queue concrete, confident work for the autonomous worker. This ALSO handles FOLLOW-UPS: when the
		// member replies asking for more on an already-SHIPPED (or rejected) ticket and Arta triages it
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

	// ── shared HTTP + parsing ────────────────────────────────────────────────────
	/** Append a turn, merging into the previous one when the mapped role repeats (API needs alternation). */
	private static function push_turn( &$turns, $role, $text ) {
		if ( $turns && $turns[ count( $turns ) - 1 ]['role'] === $role ) {
			$turns[ count( $turns ) - 1 ]['content'] .= "\n\n" . $text;
		} else {
			$turns[] = [ 'role' => $role, 'content' => $text ];
		}
	}

	/** Prepend an image block to the LAST user turn (string content → [ image, text ]) so the model sees the
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

	/** Legacy hook kept for jobs queued before the paid chat was retired: Relay::complete used to hand a
	 *  finished chat turn here. There is no chat any more, so a late answer is simply dropped. */
	public static function deliver( $dlv, $text, $usage = [], $metered = [], $media = [] ) { return null; }

	/** Answer one turn on the relay. Returns [ 'text'=>…, 'usage'=>… ], self::BUSY, or null (offline). */
	private static function chat( $messages, $system, $model = null, $max_tokens = null, $effort = 'low' ) {
		$via = Relay::ask( $messages, $system, $model ?: self::MODEL, $max_tokens ?: self::MAXTOK, $effort );
		if ( $via === Relay::BUSY || $via === Relay::PENDING ) { return self::BUSY; }
		return $via;
	}

	/** An image content block for a screenshot URL (read from the uploads dir, base64).
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

	/** The handle the assistant's account answers to (formerly `artabot`, which still resolves). */
	const BOT_SLUG = Arta::HANDLE;

	/** The WP user id Arta posts under — see Arta::uid(). Kept for the callers that predate Arta. */
	public static function bot_user_id() { return Arta::uid(); }

	/**
	 * Leave a warm, consoling reply on a section comment ArtaMod flagged for hate/fear, and
	 * notify its author. The flagged comment isn't deleted and no coin is charged — only its upvotes
	 * are kept out of the competition (Economy::podium). The reply is authored by the Arta user and
	 * attached to the flagged comment's TOP-LEVEL ancestor (the board is one-level), so it always lands
	 * as a valid reply. Arta's own reply is never itself ArtaMod-scored.
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
			"Hey, Arta here 💙 I’ve gently set this reply aside from the competition — it read as leaning on fear or contempt rather than curiosity. Nothing’s deleted and no coins were touched. The world can feel frightening, but please don’t let it harden you: most people are quietly trying their best, and there’s far more good out there than the loudest voices suggest. Reword it from a calmer place and it’ll count again. We’re really glad you’re here.",
			"Arta here, with no judgement at all 💙 This reply tipped past our one line — ArtaMod reads only for hate or fear — so its upvotes won’t count toward the competition for now. Nothing was removed and you weren’t charged. Try not to be afraid; have a little more faith in people. We’re all just learners here, and curiosity beats dread every time. Edit it whenever you’re ready and it’s back in the running.",
			"A small note from Arta 💙 I’ve kept this one out of the competition — it leaned into fear or hostility, and ArtaQuest is built to protect calm, fearless thinking. You’ve done nothing wrong and nothing’s been deleted. Fear narrows us; faith in one another opens us back up. Give the world, and the people in it, a little more credit — then rephrase from there, and your reply rejoins the board.",
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
			Notify::push( (int) $author_uid, 'fearometer', 'Arta replied to your comment',
				'ArtaMod set your comment aside from the competition — Arta left you a note.',
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
}
