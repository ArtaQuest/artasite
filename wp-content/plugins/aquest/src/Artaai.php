<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaAI — the operator's single monitor + control surface for EVERY AI system on the platform
 * (Studio › ArtaAI in the SPA, plus a wp-admin read-out). ArtaQuest runs a dozen AI pipelines, all
 * on the operator's Claude Max SUBSCRIPTION via laptop relays (the paid API was retired 2026-06-13)
 * plus free HuggingFace ZeroGPU model backends. Each is otherwise headless: a heartbeat transient,
 * a self-installed queue table, and a LaunchAgent daemon. This class rolls them ALL up into one
 * snapshot and gives the operator the levers that matter:
 *
 *   - LIVENESS   — is each relay's laptop daemon beating? (the beat transient's own TTL is the
 *                  liveness contract: every daemon refreshes it on poll with the TTL that matches
 *                  its cadence, so "transient exists" = alive — never a second, competing clock)
 *   - LOAD       — queue depth, in-flight, failed, oldest wait, 24h throughput, and the actual
 *                  head of each queue (what is being generated right now, and what's next)
 *   - ROUNDS     — the adversarial-improvement activity (review/critique rounds in the last 24h)
 *   - THE PARK   — the subscription usage-limit park (aq_relay_limited): see it, clear it early,
 *                  or park manually to keep the subscription free for interactive work
 *   - PAUSE      — stop handing NEW jobs to any studio surface (the queue simply backs up and
 *                  drains when resumed). Enforced centrally in Rest::dispatch on the relay *poll*
 *                  handlers, so pausing is graceful (the daemon just sees "no work") and additive —
 *                  DEFAULT is never-paused, so behaviour is unchanged until an operator flips it.
 *                  Chat is deliberately NOT pausable: blocking relay/poll would kill the heartbeat
 *                  and push ArtaBot toward the API fallback — the opposite of the no-API rule.
 *   - RECOVERY   — requeue a surface's stale in-flight rows (a crashed daemon's orphans) on demand
 *                  instead of waiting for that surface's own lazy reclaim
 *   - ARTAMOD    — the hate/fear moderation threshold (Fearometer::limit) is operator-tunable, the
 *                  queue can be drained on demand, and moderation pauses like any other surface
 *
 * Storage is two options: `aq_ai_paused` (non-autoloaded array of paused surface keys, '*' = all)
 * and `aq_mod_threshold` (the ArtaMod override). Nothing here writes a secret or anything private
 * to the (fully public) database.
 */
final class Artaai {

	/**
	 * Every AI surface, with the metadata needed to monitor + control it. All SQL fragments below
	 * are static strings from THIS constant (never user input), so they interpolate safely.
	 *   beat       — heartbeat transient ('' = queue-driven, no daemon beat)
	 *   poll       — the relay poll handler Rest::dispatch blocks while paused ('' = not poll-fed)
	 *   table      — the queue table; pending/busy/done/failed_where — state predicates over it
	 *   ts_col     — the row-touch time column ('' = none; disables done_24h/oldest)
	 *   title_col  — human label column for the queue-head listing ('' = no head)
	 *   requeue    — [ SET-fragment, WHERE-fragment with {stale} placeholder ] to rescue orphans
	 *   rounds     — [ table, created-kind ] of the adversarial-rounds record ('int' | 'datetime')
	 */
	const SURFACES = [
		'chat' => [
			'label' => 'ArtaBot chat', 'group' => 'chat',
			'blurb' => 'The global assistant + contribution triage; ID verification (Claude vision) rides the same relay.',
			'beat' => 'aq_relay_beat', 'launch' => 'org.artaquest.artabot-relay',
			'model' => Assistant::MODEL, 'effort' => 'low', 'engine' => '', 'pausable' => false, 'poll' => '',
			'table' => 'aq_relay_jobs', 'ts_col' => 'created', 'title_col' => '',
			'pending_where' => "status = 'pending'", 'busy_where' => "status = 'claimed'",
			'done_where' => '', 'failed_where' => '', 'requeue' => null, 'rounds' => null,
		],
		'moderation' => [
			'label' => 'ArtaMod moderation', 'group' => 'chat',
			'blurb' => 'Scores every comment on the feed and the discussion boards 0-100 for hate/fear; at/over the threshold its upvotes leave the competition.',
			'beat' => 'aq_relay_beat', 'launch' => 'org.artaquest.artabot-relay',
			'model' => Fearometer::MODEL, 'effort' => 'max', 'engine' => '', 'pausable' => true, 'poll' => '',
			'table' => 'aq_comments', 'ts_col' => 'created', 'title_col' => 'body',
			// Scoped by Fearometer::SURFACES, not 'section' alone: the drainer and this dashboard
			// must read the same platform, or the operator sees an empty queue while it fills.
			'pending_where' => 'modq = 1 AND context_type IN (' . Fearometer::SURFACES . ')', 'busy_where' => '',
			'done_where' => 'flagged = 1 AND context_type IN (' . Fearometer::SURFACES . ')', 'done_label' => 'flagged',
			'failed_where' => '', 'requeue' => null, 'rounds' => null,
		],
		'science' => [
			'label' => 'ArtaScience review', 'group' => 'studio',
			'blurb' => 'Reproducibility peer review — clones the repo, RUNS the code in a sandbox, and adjudicates.',
			'beat' => 'aq_science_beat', 'launch' => 'org.artaquest.artascience-relay',
			'model' => 'claude-opus-5', 'effort' => 'max', 'engine' => '', 'pausable' => true, 'poll' => 'Science::review_poll',
			'table' => 'aq_submissions', 'ts_col' => 'updated', 'title_col' => 'title',
			'pending_where' => "status = 'submitted'", 'busy_where' => "status = 'reviewing'",
			'done_where' => "status = 'accepted'", 'done_label' => 'accepted',
			'failed_where' => "status = 'rejected'",
			'requeue' => [ "status = 'submitted'", "status = 'reviewing' AND updated < {stale}" ],
			'rounds' => [ 'aq_paper_reviews', 'int' ],
		],
		'library' => [
			'label' => 'ArtaPublishing books', 'group' => 'studio',
			'blurb' => 'The AI book editor — brief + private inspiration → an original book (long books written in parts).',
			'beat' => 'aq_library_beat', 'launch' => 'org.artaquest.library-relay',
			'model' => 'claude-opus-5', 'effort' => 'max', 'engine' => '', 'pausable' => true, 'poll' => 'Library::doc_poll',
			'table' => 'aq_documents', 'ts_col' => 'updated', 'title_col' => 'title',
			'pending_where' => "book_state = 'queued'", 'busy_where' => "book_state = 'processing'",
			'done_where' => "book_state IN ('review','live')", 'failed_where' => "book_state = 'failed'",
			'requeue' => [ "book_state = 'queued', claimed_at = 0", "book_state = 'processing' AND updated < {stale}" ],
			'rounds' => null,
		],
		'music' => [
			'label' => 'ArtaSound studio', 'group' => 'studio',
			'blurb' => 'Music composition + audiobooks — adversarial improvement rounds over ACE-Step / Edge-TTS.',
			'beat' => 'aq_music_beat', 'launch' => 'org.artaquest.music-relay',
			'model' => 'claude-opus-5', 'effort' => 'max', 'engine' => 'ACE-Step 1.5 · Edge-TTS (HF ZeroGPU)', 'pausable' => true, 'poll' => 'Music::track_poll',
			'table' => 'aq_tracks', 'ts_col' => 'updated', 'title_col' => 'title',
			'pending_where' => "track_state = 'queued'", 'busy_where' => "track_state = 'processing'",
			'done_where' => "track_state IN ('review','live')", 'failed_where' => "track_state = 'failed'",
			'requeue' => [ "track_state = 'queued', claimed_at = 0", "track_state = 'processing' AND updated < {stale}" ],
			'rounds' => [ 'aq_track_reviews', 'int' ],
		],
		'motion' => [
			'label' => 'ArtaMotion studio', 'group' => 'studio',
			'blurb' => '3Blue1Brown-style explainer animations from a brief.',
			'beat' => 'aq_motion_beat', 'launch' => 'org.artaquest.motion-relay',
			'model' => 'claude-opus-5', 'effort' => 'max', 'engine' => '', 'pausable' => true, 'poll' => 'Motion::anim_poll',
			'table' => 'aq_animations', 'ts_col' => 'updated', 'title_col' => 'title',
			'pending_where' => "anim_state = 'queued'", 'busy_where' => "anim_state = 'processing'",
			'done_where' => "anim_state IN ('review','live')", 'failed_where' => "anim_state = 'failed'",
			'requeue' => [ "anim_state = 'queued', claimed_at = 0", "anim_state = 'processing' AND updated < {stale}" ],
			'rounds' => null,
		],
		'film' => [
			'label' => 'ArtaFilm studio', 'group' => 'studio',
			'blurb' => 'Text-to-video short films — one LTX-Video clip per tick, then stitched.',
			'beat' => '', 'launch' => 'org.artaquest.film-relay',
			'model' => 'claude-opus-5', 'effort' => 'max', 'engine' => 'LTX-2.3 (HF ZeroGPU)', 'pausable' => true, 'poll' => 'Film::film_poll',
			'table' => 'aq_films', 'ts_col' => 'updated', 'title_col' => 'title',
			'pending_where' => "film_state = 'queued'", 'busy_where' => "film_state = 'processing'",
			'done_where' => "film_state IN ('review','live')", 'failed_where' => "film_state = 'failed'",
			'requeue' => [ "film_state = 'queued', claimed_at = 0", "film_state = 'processing' AND updated < {stale}" ],
			'rounds' => null,
		],
		'illustration' => [
			'label' => 'ArtaIllustration studio', 'group' => 'studio',
			'blurb' => 'AI artwork, book covers + plates — Claude-vision critique over FLUX.2 / Qwen-Image.',
			'beat' => 'aq_illust_beat', 'launch' => 'org.artaquest.illustration-relay',
			'model' => 'claude-opus-5', 'effort' => 'max', 'engine' => 'FLUX.2 · Qwen-Image · klein (HF ZeroGPU)', 'pausable' => true, 'poll' => 'Illustration::illust_poll',
			'table' => 'aq_illustrations', 'ts_col' => 'updated', 'title_col' => 'title',
			'pending_where' => "art_state = 'queued'", 'busy_where' => "art_state = 'processing'",
			'done_where' => "art_state IN ('review','live')", 'failed_where' => "art_state = 'failed'",
			'requeue' => [ "art_state = 'queued', claimed_at = 0", "art_state = 'processing' AND updated < {stale}" ],
			'rounds' => [ 'aq_illust_rounds', 'int' ],
		],
		'narrate' => [
			'label' => 'ArtaVoice narration', 'group' => 'studio',
			'blurb' => 'Read-along audiobooks, sentence-by-sentence — Edge-TTS in ~322 voices (no LLM).',
			'beat' => '', 'launch' => 'org.artaquest.narration-relay',
			'model' => '', 'effort' => '', 'engine' => 'Edge-TTS (322 voices)', 'pausable' => true, 'poll' => 'Narrate::poll',
			'table' => 'aq_narrations', 'ts_col' => 'updated', 'title_col' => 'title',
			'pending_where' => "state = 'queued'", 'busy_where' => "state = 'processing'",
			'done_where' => "state = 'done'", 'failed_where' => "state = 'failed'",
			'requeue' => [ "state = 'queued', claimed_at = 0", "state = 'processing' AND claimed_at < {stale}" ],
			'rounds' => null,
		],
		'translate' => [
			'label' => 'ArtaTranslate mesh', 'group' => 'studio',
			'blurb' => 'Second-pass translation upgrade — dedicated-MT/LLM drafts + Claude adversarial rounds.',
			'beat' => '', 'launch' => 'org.artaquest.translate-relay',
			'model' => 'claude-opus-5', 'effort' => 'max', 'engine' => 'Hy-MT2 · Gemma-3 (HF inference)', 'pausable' => true, 'poll' => 'Translate::poll',
			'table' => 'aq_translations', 'ts_col' => '', 'title_col' => '',
			// Demand-aware (1.60.0): pending = CLAIMABLE rows only — narration sentences (any language) or
			// strings real visitors re-read (demand ≥ 1, mirror Translate::MIN_DEMAND) in an auto-improvement
			// language (mirror Translate::AUTO_LANGS). The never-re-read backlog and non-focus languages are
			// deliberately NOT pending: they keep their edge translation and cost nothing.
			'pending_where' => "status = 'auto' AND claimed_at = 0 AND lang <> 'en' AND ( priority = 2 OR ( demand >= 1 AND lang IN ('zh','zh-tw','hi','ar','es','jv','pt','ha','pa','bn','ru','fa','ja','vi','de','tr','fr','ko','zu','it') ) )",
			'busy_where' => "status = 'auto' AND claimed_at > 0 AND lang <> 'en'",
			'done_where' => "status = 'arta'", 'done_label' => 'upgraded', 'failed_where' => '',
			'requeue' => [ 'claimed_at = 0', "status = 'auto' AND claimed_at > 0 AND claimed_at < {stale}" ],
			'rounds' => [ 'aq_tr_rounds', 'int' ],
		],
		'compete' => [
			'label' => 'ArtaCompete review', 'group' => 'studio',
			'blurb' => 'Adversarial code review for competition solutions — reproduces the claimed score with no leakage.',
			'beat' => 'aq_compete_beat', 'launch' => 'org.artaquest.artacompete-relay',
			'model' => 'claude-opus-5', 'effort' => 'max', 'engine' => '', 'pausable' => true, 'poll' => 'Competitions::review_poll',
			'table' => 'aq_comp_subs', 'ts_col' => 'updated', 'title_col' => '',
			'pending_where' => "review = 'submitted'", 'busy_where' => "review = 'reviewing'",
			'done_where' => "review = 'verified'", 'done_label' => 'verified',
			'failed_where' => "review = 'flagged'",
			'requeue' => [ "review = 'submitted'", "review = 'reviewing' AND updated < {stale}" ],
			'rounds' => [ 'aq_comp_reviews', 'datetime' ],
		],
	];

	const OPT_PAUSED    = 'aq_ai_paused';     // array: surface-key => 1 (plus '*' => 1 for a global pause)
	const OPT_MOD_LIMIT = 'aq_mod_threshold'; // int 1-100 override of Fearometer::LIMIT (read via Fearometer::limit)
	const STALE_S       = 3600;               // requeue rescues in-flight rows untouched this long (matches the
	                                          // surfaces' own lazy reclaims, so a live long job is never yanked)
	const HEAD_N        = 4;                  // queue-head rows returned per surface

	private static function gate() { return user_can( Rest::uid(), 'manage_options' ); }

	// ── the central pause enforcement (called from Rest::dispatch) ─────────────

	/** Is this surface paused (globally or individually)? */
	public static function paused( $surface ) {
		$p = get_option( self::OPT_PAUSED, [] );
		if ( ! is_array( $p ) ) { return false; }
		return ! empty( $p['*'] ) || ! empty( $p[ $surface ] );
	}

	/** Map a relay poll handler ('Class::method') → its surface key, or '' if it isn't a pausable poll. */
	public static function poll_surface( $handler ) {
		foreach ( self::SURFACES as $key => $s ) {
			if ( $s['pausable'] && $s['poll'] !== '' && $s['poll'] === $handler ) { return $key; }
		}
		return '';
	}

	/** True when Rest::dispatch should SHORT-CIRCUIT a relay poll (its surface is paused). The daemon
	 *  then just sees the normal "no work" answer and sleeps — no job leaves the queue. The option is
	 *  only read once a poll handler matches, so ordinary requests never pay for it. */
	public static function should_block_poll( $handler ) {
		$surface = self::poll_surface( $handler );
		return $surface !== '' && self::paused( $surface );
	}

	// ── the operator snapshot (GET studio/artaai) ──────────────────────────────

	public static function dashboard( $req ) {
		if ( ! self::gate() ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		$now = time();

		$surfaces  = [];
		$tot_pending = $tot_busy = $tot_failed = $relays_alive = $relays_total = $rounds_24h_all = 0;
		$seen_beats  = [];
		foreach ( self::SURFACES as $key => $s ) {
			$pending = self::count( $s['table'], $s['pending_where'] );
			$busy    = self::count( $s['table'], $s['busy_where'] );
			$done    = self::count( $s['table'], $s['done_where'] );
			$failed  = self::count( $s['table'], $s['failed_where'] );
			$done24  = ( $s['ts_col'] !== '' && $s['done_where'] !== '' )
				? self::count( $s['table'], $s['done_where'] . ' AND ' . $s['ts_col'] . ' > ' . ( $now - DAY_IN_SECONDS ) )
				: null;

			// Oldest wait: how long the head of the queue has been sitting (0 pending → null).
			$oldest = null;
			if ( $pending > 0 && $s['ts_col'] !== '' ) {
				$min = self::minv( $s['table'], $s['ts_col'], $s['pending_where'] );
				if ( $min > 0 ) { $oldest = max( 0, $now - $min ); }
			}

			// Adversarial-rounds activity (the improvement loops are the actual AI work rate).
			$rounds24 = null;
			if ( is_array( $s['rounds'] ) ) {
				[ $rt, $kind ] = $s['rounds'];
				$rounds24 = $kind === 'datetime'
					? self::count( $rt, "created > '" . gmdate( 'Y-m-d H:i:s', $now - DAY_IN_SECONDS ) . "'" )
					: self::count( $rt, 'created > ' . ( $now - DAY_IN_SECONDS ) );
				$rounds_24h_all += $rounds24;
			}

			// Liveness: the beat transient's own TTL is the contract (every daemon sets it with a TTL
			// matched to its cadence — 90s chat, 120s reviewers, 300s chunked music), so existence = alive.
			$online = null; $beat_age = null;
			if ( $s['beat'] !== '' ) {
				$b        = (int) get_transient( $s['beat'] );
				$online   = $b > 0;
				$beat_age = $b > 0 ? max( 0, $now - $b ) : null;
			}

			$tot_pending += $pending;
			$tot_busy    += $busy;
			$tot_failed  += $failed;
			// Count each distinct heartbeat once toward the "relays alive" tally (chat + moderation share one).
			if ( $s['beat'] !== '' && ! isset( $seen_beats[ $s['beat'] ] ) ) {
				$seen_beats[ $s['beat'] ] = true;
				$relays_total++;
				if ( $online ) { $relays_alive++; }
			}

			$surfaces[] = [
				'key' => $key, 'label' => $s['label'], 'group' => $s['group'], 'blurb' => $s['blurb'],
				'model' => $s['model'], 'effort' => $s['effort'], 'engine' => $s['engine'],
				'launch' => $s['launch'], 'pausable' => (bool) $s['pausable'],
				'paused' => self::paused( $key ),
				'online' => $online, 'beat_age' => $beat_age, 'has_beat' => $s['beat'] !== '',
				'pending' => $pending, 'busy' => $busy, 'done' => $done, 'failed' => $failed,
				'done_24h' => $done24, 'done_label' => $s['done_label'] ?? 'done',
				'oldest_s' => $oldest, 'rounds_24h' => $rounds24,
				'can_requeue' => is_array( $s['requeue'] ),
				'head' => self::head( $key, $s ),
			];
		}

		// The subscription usage-limit PARK (aq_relay_limited holds the unix reset when set).
		$limited_until = (int) get_transient( 'aq_relay_limited' );
		$park = $limited_until > $now ? [ 'active' => true, 'reset_in' => $limited_until - $now, 'reset_at' => $limited_until ] : [ 'active' => false ];

		$p = get_option( self::OPT_PAUSED, [] );

		return [
			'now' => $now,
			'laptop_online' => (bool) get_transient( 'aq_relay_beat' ),
			'global_pause'  => is_array( $p ) && ! empty( $p['*'] ),
			'relays_alive'  => $relays_alive, 'relays_total' => $relays_total,
			'total_pending' => $tot_pending, 'total_busy' => $tot_busy, 'total_failed' => $tot_failed,
			'rounds_24h'    => $rounds_24h_all,
			'park' => $park,
			'usage' => self::usage( $now ),
			'moderation' => [
				'threshold' => Fearometer::limit(),
				'default'   => Fearometer::LIMIT,
				// Every screened surface (Fearometer::SURFACES) — the feed and the discussion boards,
				// not just the retired course board — so these counters track the queue the relay drains.
				'queue'     => self::count( 'aq_comments', 'modq = 1 AND context_type IN (' . Fearometer::SURFACES . ')' ),
				'flagged'   => self::count( 'aq_comments', 'flagged = 1 AND context_type IN (' . Fearometer::SURFACES . ')' ),
				'flagged_24h' => self::count( 'aq_comments', 'flagged = 1 AND context_type IN (' . Fearometer::SURFACES . ') AND created > ' . ( $now - DAY_IN_SECONDS ) ),
				'processed' => self::count( 'aq_comments', 'context_type IN (' . Fearometer::SURFACES . ') AND modq = 0' ),
			],
			'surfaces' => $surfaces,
			'system'   => [ 'schema' => Schema::VERSION, 'aq_version' => defined( 'AQ_VERSION' ) ? AQ_VERSION : '' ],
		];
	}

	/** ArtaBot relay spend — subscription tokens, so a load gauge rather than a bill. */
	private static function usage( $now ) {
		global $wpdb;
		$t = Data::t( 'aq_artabot_messages' );
		$r = $wpdb->get_row( $wpdb->prepare(
			"SELECT COALESCE(SUM(CASE WHEN created > %d THEN tokens ELSE 0 END),0) AS t24,
			        COALESCE(SUM(CASE WHEN created > %d THEN tokens ELSE 0 END),0) AS t7d,
			        SUM(CASE WHEN created > %d AND role = 'assistant' THEN 1 ELSE 0 END) AS turns24
			   FROM {$t}", $now - DAY_IN_SECONDS, $now - 7 * DAY_IN_SECONDS, $now - DAY_IN_SECONDS ), ARRAY_A );
		return [
			'tokens_24h' => (int) ( $r['t24'] ?? 0 ),
			'tokens_7d'  => (int) ( $r['t7d'] ?? 0 ),
			'turns_24h'  => (int) ( $r['turns24'] ?? 0 ),
		];
	}

	/** The head of a surface's queue — the rows being generated now + next in line (oldest first).
	 *  Translate has no per-row titles; its head is the pending per-language tally instead. */
	private static function head( $key, $s ) {
		global $wpdb;
		$now = time();
		if ( $key === 'translate' ) {
			$t    = Data::t( 'aq_translations' );
			$rows = $wpdb->get_results(
				"SELECT lang AS title, COUNT(*) AS n FROM {$t} WHERE {$s['pending_where']} GROUP BY lang ORDER BY n DESC LIMIT " . self::HEAD_N, ARRAY_A );
			return array_map( static fn( $r ) => [ 'id' => 0, 'title' => $r['title'] . ' · ' . (int) $r['n'] . ' strings', 'state' => 'queued', 'age' => null ], (array) $rows );
		}
		if ( $s['title_col'] === '' || $s['busy_where'] === '' ) { return []; }
		$t    = $wpdb->prefix . $s['table'];
		$ts   = $s['ts_col'] !== '' ? $s['ts_col'] : 'id';
		$rows = $wpdb->get_results(
			"SELECT id, {$s['title_col']} AS title, ( {$s['busy_where']} ) AS busy, {$ts} AS ts FROM {$t}
			  WHERE ( {$s['pending_where']} ) OR ( {$s['busy_where']} ) ORDER BY busy DESC, id ASC LIMIT " . self::HEAD_N, ARRAY_A );
		return array_map( static function ( $r ) use ( $now, $s ) {
			return [
				'id'    => (int) $r['id'],
				'title' => mb_substr( trim( wp_strip_all_tags( (string) $r['title'] ) ), 0, 80 ),
				'state' => $r['busy'] ? 'processing' : 'queued',
				'age'   => $s['ts_col'] !== '' ? max( 0, $now - (int) $r['ts'] ) : null,
			];
		}, (array) $rows );
	}

	/** COUNT(*) with a static WHERE (from SURFACES — never user input). Empty where → 0. */
	private static function count( $table, $where ) {
		if ( $where === '' ) { return 0; }
		global $wpdb;
		return (int) $wpdb->get_var( 'SELECT COUNT(*) FROM ' . $wpdb->prefix . $table . ' WHERE ' . $where );
	}

	/** MIN(col) with a static WHERE — the oldest waiting row's timestamp (0 = none). */
	private static function minv( $table, $col, $where ) {
		global $wpdb;
		return (int) $wpdb->get_var( 'SELECT MIN(' . $col . ') FROM ' . $wpdb->prefix . $table . ' WHERE ' . $where );
	}

	// ── operator controls (POST studio/artaai/config) ──────────────────────────

	/**
	 * POST studio/artaai/config { action, ... }:
	 *   pause      { surface, on }  — pause/resume one studio surface (queue backs up while paused)
	 *   pause_all  { on }           — pause/resume EVERY pausable surface at once
	 *   threshold  { value }        — set the ArtaMod hate/fear flag threshold (1-100)
	 *   park       { minutes }      — hold ALL relay work for N minutes (frees the subscription)
	 *   unpark                      — clear the usage-limit park now
	 *   requeue    { surface }      — rescue the surface's stale in-flight rows back to queued
	 *   moderate                    — drain the ArtaMod queue once, right now
	 */
	public static function config( $req ) {
		if ( ! self::gate() ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		$action = sanitize_key( (string) Rest::p( $req, 'action', '' ) );

		switch ( $action ) {
			case 'pause': {
				$surface = sanitize_key( (string) Rest::p( $req, 'surface', '' ) );
				if ( ! isset( self::SURFACES[ $surface ] ) || ! self::SURFACES[ $surface ]['pausable'] ) {
					return Rest::err( 'bad_input', 'Unknown or non-pausable surface' );
				}
				$on = filter_var( Rest::p( $req, 'on', false ), FILTER_VALIDATE_BOOLEAN );
				$p  = get_option( self::OPT_PAUSED, [] ); if ( ! is_array( $p ) ) { $p = []; }
				if ( $on ) { $p[ $surface ] = 1; } else { unset( $p[ $surface ] ); }
				update_option( self::OPT_PAUSED, $p, false );
				return [ 'ok' => true, 'surface' => $surface, 'paused' => $on ];
			}
			case 'pause_all': {
				$on = filter_var( Rest::p( $req, 'on', false ), FILTER_VALIDATE_BOOLEAN );
				$p  = get_option( self::OPT_PAUSED, [] ); if ( ! is_array( $p ) ) { $p = []; }
				if ( $on ) { $p['*'] = 1; } else { unset( $p['*'] ); }
				update_option( self::OPT_PAUSED, $p, false );
				return [ 'ok' => true, 'global_pause' => $on ];
			}
			case 'threshold': {
				$v = max( 1, min( 100, (int) Rest::p( $req, 'value', Fearometer::LIMIT ) ) );
				update_option( self::OPT_MOD_LIMIT, $v, true );
				return [ 'ok' => true, 'threshold' => $v ];
			}
			case 'park': {
				// Manual park: identical mechanism to a worker-reported usage limit (Relay::complete),
				// so Relay::available() goes false and EVERY relay consumer backs off gracefully.
				$mins  = max( 5, min( 24 * 60, (int) Rest::p( $req, 'minutes', 30 ) ) );
				$until = time() + $mins * 60;
				set_transient( 'aq_relay_limited', $until, $mins * 60 );
				Watchdog::note( 'ArtaAI: relay parked manually for ' . $mins . 'm by ' . wp_get_current_user()->user_login );
				return [ 'ok' => true, 'parked_until' => $until ];
			}
			case 'unpark': {
				delete_transient( 'aq_relay_limited' );
				return [ 'ok' => true, 'unparked' => true ];
			}
			case 'requeue': {
				$surface = sanitize_key( (string) Rest::p( $req, 'surface', '' ) );
				$s = self::SURFACES[ $surface ] ?? null;
				if ( ! $s || ! is_array( $s['requeue'] ) ) { return Rest::err( 'bad_input', 'Unknown or non-requeueable surface' ); }
				global $wpdb;
				[ $set, $where ] = $s['requeue'];
				$where = str_replace( '{stale}', (string) ( time() - self::STALE_S ), $where );
				$n = (int) $wpdb->query( 'UPDATE ' . $wpdb->prefix . $s['table'] . " SET {$set} WHERE {$where}" );
				return [ 'ok' => true, 'surface' => $surface, 'requeued' => $n ];
			}
			case 'moderate': {
				$done = Fearometer::process_queue();
				return [ 'ok' => true, 'resolved' => (int) $done ];
			}
		}
		return Rest::err( 'bad_input', 'Unknown action' );
	}

	// ── wp-admin page (operators only) ─────────────────────────────────────────

	public static function admin_menu() {
		add_menu_page(
			'ArtaAI', 'ArtaAI', 'manage_options', 'aq-artaai',
			[ self::class, 'render_page' ], 'dashicons-superhero-alt', 58
		);
	}

	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) { return; }
		$snap = self::dashboard( new \WP_REST_Request() );
		if ( ! is_array( $snap ) ) { echo '<div class="wrap"><p>Unavailable.</p></div>'; return; }
		$now = $snap['now'];
		echo '<div class="wrap" style="max-width:1180px">';
		echo '<h1 style="display:flex;align-items:center;gap:10px">ArtaAI '
			. '<span style="font:600 12px/1 -apple-system;color:#fff;background:' . ( $snap['laptop_online'] ? '#2352E8' : '#b32d2e' ) . ';padding:5px 10px;border-radius:999px">'
			. ( $snap['laptop_online'] ? 'laptop online' : 'laptop offline' ) . '</span></h1>';
		echo '<p style="color:#50575e;max-width:760px">Every AI system on the platform, monitored from one place. '
			. 'The full controls (pause, park, requeue, moderation threshold) live in the SPA at <a href="' . esc_url( home_url( '/studio/' ) ) . '">Studio › ArtaAI</a>; this page is a quick operator read-out.</p>';
		if ( ! empty( $snap['park']['active'] ) ) {
			echo '<div class="notice notice-warning"><p><strong>Relay park is active</strong> — new relay work is held for ~'
				. esc_html( human_time_diff( $now, $snap['park']['reset_at'] ) ) . ' (until ' . esc_html( wp_date( 'H:i', $snap['park']['reset_at'] ) ) . ').</p></div>';
		}
		if ( $snap['global_pause'] ) {
			echo '<div class="notice notice-error"><p><strong>Global AI pause is ON</strong> — no studio surface is being handed new jobs.</p></div>';
		}
		echo '<div style="display:flex;gap:12px;flex-wrap:wrap;margin:14px 0">';
		foreach ( [
			[ 'Relays alive', $snap['relays_alive'] . ' / ' . $snap['relays_total'] ],
			[ 'Queued', (string) $snap['total_pending'] ],
			[ 'In flight', (string) $snap['total_busy'] ],
			[ 'AI rounds 24h', (string) $snap['rounds_24h'] ],
			[ 'ArtaBot tokens 24h', number_format_i18n( $snap['usage']['tokens_24h'] ) ],
			[ 'ArtaMod queue', (string) $snap['moderation']['queue'] ],
		] as $c ) {
			echo '<div style="background:#fff;border:1px solid #dcdfe4;border-left:4px solid #2352E8;border-radius:8px;padding:12px 16px;min-width:130px">'
				. '<div style="font:600 11px/1.4 -apple-system;text-transform:uppercase;letter-spacing:.5px;color:#6a7280">' . esc_html( $c[0] ) . '</div>'
				. '<div style="font:700 24px/1.2 -apple-system;color:#0C1E32">' . esc_html( $c[1] ) . '</div></div>';
		}
		echo '</div>';
		echo '<table class="widefat striped"><thead><tr><th>Surface</th><th>Status</th><th>Model / engine</th><th>Queued</th><th>In flight</th><th>Failed</th><th>Done (24h)</th></tr></thead><tbody>';
		foreach ( $snap['surfaces'] as $s ) {
			$status = $s['paused'] ? '<span style="color:#b32d2e;font-weight:600">paused</span>'
				: ( $s['online'] === null ? '<span style="color:#6a7280">queue-driven</span>'
				: ( $s['online'] ? '<span style="color:#2352E8;font-weight:600">online</span>' : '<span style="color:#b32d2e">offline</span>' ) );
			$eng = $s['model'] ? esc_html( $s['model'] ) : '';
			if ( $s['engine'] ) { $eng .= ( $eng ? ' · ' : '' ) . '<span style="color:#6a7280">' . esc_html( $s['engine'] ) . '</span>'; }
			echo '<tr><td><strong>' . esc_html( $s['label'] ) . '</strong><br><span style="color:#6a7280;font-size:12px">' . esc_html( $s['blurb'] ) . '</span></td>'
				. '<td>' . $status . '</td><td>' . ( $eng ?: '—' ) . '</td>'
				. '<td>' . (int) $s['pending'] . '</td><td>' . (int) $s['busy'] . '</td>'
				. '<td>' . ( $s['failed'] ? '<span style="color:#b32d2e;font-weight:600">' . (int) $s['failed'] . '</span>' : '0' ) . '</td>'
				. '<td>' . ( $s['done_24h'] === null ? '—' : (int) $s['done_24h'] ) . '</td></tr>';
		}
		echo '</tbody></table>';
		echo '<p style="color:#6a7280;margin-top:12px">schema ' . esc_html( $snap['system']['schema'] ) . ' · ' . esc_html( $snap['system']['aq_version'] ) . '</p>';
		echo '</div>';
	}
}
