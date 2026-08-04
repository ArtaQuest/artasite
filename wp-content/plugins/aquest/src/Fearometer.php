<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaMod — ArtaQuest's one content line, enforced automatically and objectively.
 *
 * ArtaQuest welcomes the whole spectrum of honest thought: dissent, criticism, fringe ideas,
 * conspiracies, pseudoscience, unpopular and uncomfortable positions — all of it stays open. We
 * filter exactly ONE thing: content whose pull is HATE or FEAR — language meant to DEHUMANISE a
 * group of people, or to FRIGHTEN by trading in panic, threat and doom rather than understanding.
 *
 * It reads only for that, never for the topic, the side, or who is speaking. A heated argument, a
 * frightening subject discussed calmly, or a learner admitting their own fear are all FINE —
 * ArtaMod measures whether a piece of writing is built to dehumanise or to scare, not whether
 * it is about a dark or divisive thing.
 *
 * Every comment on every commentable surface (SURFACES) is QUEUED on post and scored here. A comment
 * that scores at/over LIMIT is flagged: its upvotes are excluded from the course competition
 * (Economy::podium) and, on the section board, ArtaBot leaves a consoling reply
 * (Assistant::console_fear). Nothing is deleted, no coin is charged — moderation is platform-borne
 * and best-effort.
 *
 * Calibrated by prompt engineering against a labelled corpus (tools/fearometer-calibrate.php). The
 * verdict is computed against a few-shot anchor set baked into the prompt so the score means the
 * same thing every time.
 *
 * Verdict via the Claude Max SUBSCRIPTION only: comments are QUEUED on post (aq_comments.modq=1) and
 * scored asynchronously through the relay (process_queue → Relay::ask), in batches. The paid Anthropic
 * API was removed (2026-06-13) — if the relay is offline, comments just stay queued (visible,
 * un-moderated; fail-open). A test seam (`aq_fearometer_verdict` filter) forces a score without a relay.
 *
 * "ArtaMod" is the member-facing name (renamed from "the Fearometer", ticket #20). The class,
 * the /fearometer REST + page paths, option keys, the test-seam filter, and the calibrated
 * scoring prompt + corpus keep the original identifier — those are API/calibration artefacts,
 * not copy, and renaming them would break callers, URLs, and the published calibration run.
 */
final class Fearometer {

	const MODEL    = 'claude-opus-5'; // the relay (subscription) model — flat-rate, so batch moderation is free
	const MAXTOK   = 320;
	const LIMIT    = 70;   // score 0-100; at/over this a comment is "over the line" → flagged
	const MAX_CHARS = 8000; // cap the text sent to the model (a comment is short; guards a pasted wall)
	const QUEUE_BATCH = 12;  // comments scored per relay job
	const QUEUE_RUNS  = 5;   // batches drained per cron tick (≤60 comments) before yielding the relay

	/** The comment surfaces ArtaMod screens, as a SQL literal list (constants only — never input).
	 *  'section' is the competition board, empty since the July course purge but kept so a restored
	 *  board is screened without a code change; 'thread' is the seven public discussion boards;
	 *  'notebook' is the feed. Binding the queue to 'section' alone is what left every live surface
	 *  unscreened while /fearometer published a screen — one list, read by the drainer and by the
	 *  public count, so the two can never describe different platforms again. */
	const SURFACES = "'section','thread','notebook'";

	/** When the queue actually began covering the surfaces above. Comments older than this were
	 *  posted before ArtaMod reached their board, so counting them as "screened" would publish a
	 *  check that never ran on them. There is no per-row screened marker, so this date is the seam;
	 *  it undercounts (the section board was queued from 1.32.0) and never overclaims. */
	const SCREEN_SINCE = 1785801600; // 2026-08-04 00:00 UTC

	/**
	 * Score a piece of text for hate/fear. Returns [ 'fear' => 0-100, 'flagged' => bool,
	 * 'reason' => string, 'categories' => string[] ], or NULL when there is no verdict (no test mock —
	 * real moderation runs asynchronously through process_queue → the relay, never inline). Empty text
	 * scores 0. This is now a TEST-SEAM helper + the per-comment normaliser; live scoring is the queue.
	 */
	public static function score( $text ) {
		$text = trim( wp_strip_all_tags( (string) $text ) );
		if ( $text === '' ) { return [ 'fear' => 0, 'flagged' => false, 'reason' => '', 'categories' => [] ]; }
		if ( mb_strlen( $text ) > self::MAX_CHARS ) { $text = mb_substr( $text, 0, self::MAX_CHARS ); }

		// Test seam: the harness can force a verdict. An int/numeric → that fear score; an array →
		// used as-is (we still derive `flagged`); the string 'fail' → simulate an upstream failure.
		$mock = apply_filters( 'aq_fearometer_verdict', null, $text );
		if ( $mock === 'fail' ) { return null; }
		if ( is_numeric( $mock ) ) { $mock = [ 'fear' => (int) $mock ]; }
		if ( is_array( $mock ) ) { return self::finish( $mock ); }

		return null; // no mock → the live verdict comes from the relay batch in process_queue (no API)
	}

	/** The live flag threshold: an operator override (ArtaAI dashboard → `aq_mod_threshold`) or the
	 *  calibrated default LIMIT. A comment scoring at/over this has its upvotes excluded. */
	public static function limit() {
		$v = (int) get_option( 'aq_mod_threshold', 0 );
		return $v >= 1 && $v <= 100 ? $v : self::LIMIT;
	}

	/** Normalise a raw verdict into the public shape + derive `flagged` from the score. */
	private static function finish( $v ) {
		$fear = (int) round( max( 0, min( 100, (float) ( $v['fear'] ?? 0 ) ) ) );
		$cats = array_values( array_filter( array_map( 'sanitize_key', (array) ( $v['categories'] ?? [] ) ) ) );
		return [
			'fear'       => $fear,
			'flagged'    => $fear >= self::limit(),
			'reason'     => sanitize_text_field( (string) ( $v['reason'] ?? '' ) ),
			'categories' => $cats,
		];
	}

	// ── Radical transparency: the public methodology + the actual test set ────────
	// The headline results of our last full calibration run (tools/fearometer-calibrate.php over
	// tools/fearometer-corpus.json). Update these whenever the corpus or prompt changes and the run
	// is repeated. They are RESULTS OF A RUN (not derivable on read), so they live here as honest,
	// dated facts rather than a fabricated live number.
	const CALIB = [
		'cases'     => 339,
		'languages' => 22,
		'categories'=> 27,
		'accuracy'  => 100,   // % correct on the test set after calibration
		'precision' => 100,   // % of flagged that were truly hate/fear
		'recall'    => 100,   // % of true hate/fear that were caught
		'cycles'    => 6,     // calibration dev-cycles run to date
		'updated'   => '2026-06-08',
	];

	/**
	 * Self-healing: make sure a published WP page exists at /fearometer/ so the SPA route returns a
	 * real 200 (indexable, proper SEO meta) like the other app pages (/about, /careers, /explore),
	 * instead of a soft-404. Idempotent + option-gated so it costs one autoloaded-option read per
	 * request and only ever inserts once. Runs on plugins_loaded, so a code deploy provisions it on
	 * production with no database push. The SPA renders the page; the WP page just owns the URL + meta.
	 */
	public static function ensure_page() {
		$page = get_option( 'aq_fearometer_page' );
		if ( $page !== false ) {
			// One-time retitle (ticket #20): installs provisioned before the member-facing rename
			// still carry the old "The Fearometer" page title (visible in <title> fallbacks and the
			// public data explorer). Option-gated like the insert below — one autoloaded read per
			// request, writes once ever, and never touches a page an operator already retitled.
			if ( ! get_option( 'aq_artamod_retitled' ) ) {
				$p = (int) $page ? get_post( (int) $page ) : null;
				if ( $p && 'The Fearometer' === $p->post_title ) {
					wp_update_post( [ 'ID' => (int) $page, 'post_title' => 'ArtaMod' ] );
				}
				update_option( 'aq_artamod_retitled', 1, true );
			}
			return;
		}
		$existing = get_page_by_path( 'fearometer' );
		if ( $existing ) { update_option( 'aq_fearometer_page', (int) $existing->ID, true ); return; }
		$id = wp_insert_post( [
			'post_type'    => 'page',
			'post_status'  => 'publish',
			'post_name'    => 'fearometer',
			'post_title'   => 'ArtaMod',
			'post_excerpt' => 'How ArtaQuest screens for hate and fear — the reasoning, the method, and the full study set, in plain language. We welcome every honest idea and filter only what dehumanises or frightens people.',
			'post_content' => '',
		] );
		if ( $id && ! is_wp_error( $id ) ) {
			// WP uniquifies a taken slug (fearometer-2, -3, …) instead of failing — meaning a page
			// already owns /fearometer/ and ours is a thin published duplicate that lands in the
			// sitemap + Google's index. That exact race minted /fearometer-2/…/fearometer-34/ on
			// prod (2026-06-08; cleaned up by the theme's aq_seo_index_cleanup, Search Console
			// ticket #59). Keep the canonical page, hard-delete our copy.
			$created = get_post( $id );
			if ( $created && 'fearometer' !== $created->post_name ) {
				wp_delete_post( $id, true );
				$canon = get_page_by_path( 'fearometer' );
				if ( $canon ) { update_option( 'aq_fearometer_page', (int) $canon->ID, true ); }
				return;
			}
			update_option( 'aq_fearometer_page', (int) $id, true );
		}
	}

	/** Load the labelled test corpus (the cases we calibrate against), or [] if unavailable. */
	private static function corpus() {
		$path = AQ_DIR . '/tools/fearometer-corpus.json';
		if ( ! is_readable( $path ) ) { return []; }
		$rows = json_decode( (string) file_get_contents( $path ), true );
		return is_array( $rows ) ? $rows : [];
	}

	/**
	 * GET /fearometer — the public methodology + LIVE stats of the actual deployed test set, so the
	 * ArtaMod page can prove (not just claim) what it screens for and how it was calibrated. No
	 * secrets, no per-user data — pure transparency. Counts are read from the corpus file shipped with
	 * the plugin, so they can never drift from what we actually test against.
	 */
	/**
	 * POST /fearometer/appeal {comment_id, reason} — ONE appeal per flagged comment, by its author.
	 * The comment is re-adjudicated with the author's appeal attached as context; a score that now
	 * lands under LIMIT unflags it (its upvotes return to the competition and the author's quester
	 * standing is refreshed). Nothing is deleted either way; the member is notified of the outcome.
	 */
	public static function appeal( $req ) {
		$uid = Rest::uid();
		$cid = Rest::pint( $req, 'comment_id', 0 );
		$why = sanitize_text_field( (string) Rest::p( $req, 'reason', '' ) );
		if ( mb_strlen( $why ) < 10 ) { return Rest::err( 'bad_input', 'Tell us in a sentence why the reply was misread.' ); }
		$c = Data::one( 'SELECT id, author_id, course_id, body, flagged, appealed FROM ' . Data::t( 'aq_comments' ) . " WHERE id = %d AND context_type = 'section'", [ $cid ] );
		if ( ! $c ) { return Rest::err( 'not_found', 'Reply not found', 404 ); }
		if ( (int) $c['author_id'] !== $uid ) { return Rest::err( 'forbidden', 'Only the author can appeal', 403 ); }
		if ( empty( $c['flagged'] ) ) { return Rest::err( 'bad_input', 'This reply isn’t flagged.' ); }
		if ( ! empty( $c['appealed'] ) ) { return Rest::err( 'bad_input', 'This reply has already been appealed — each reply gets one appeal.' ); }
		if ( Rest::throttle( 'fear_appeal', 5, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }

		// Re-adjudicate with the appeal attached — same calibrated screen, fresh judgement.
		$verdict = self::score( (string) $c['body'] . "\n\n[The author appeals this flag: " . $why . ']' );
		if ( $verdict === null ) { return Rest::err( 'unavailable', 'The reviewer is offline — please try again later.', 503 ); }

		$granted = ! $verdict['flagged'];
		Data::update( 'aq_comments', $granted
			? [ 'flagged' => 0, 'fear' => (int) $verdict['fear'], 'appealed' => 1 ]
			: [ 'appealed' => 1 ], [ 'id' => (int) $c['id'] ] );
		if ( $granted ) { Economy::quester_touch( (int) $c['course_id'], $uid ); } // its upvotes count again
		Notify::push( $uid, 'artamod', $granted ? 'Appeal granted — your reply is back in the competition' : 'Appeal reviewed — the flag stands',
			$granted ? 'A fresh review agreed with you: the flag is removed and your reply’s upvotes count again.'
					 : 'A fresh review upheld the flag. The reply stays visible and nothing is deleted — its upvotes simply don’t count toward the competition.',
			'', 'fear:appeal:' . (int) $c['id'] );
		return [ 'ok' => true, 'granted' => $granted, 'fear' => (int) $verdict['fear'] ];
	}

	public static function transparency( $req ) {
		$rows = self::corpus();
		$langs = []; $cats = [];
		foreach ( $rows as $r ) {
			$lang = (string) ( $r['lang'] ?? '?' );
			$cat  = (string) ( $r['category'] ?? '?' );
			$langs[ $lang ] = true;
			if ( ! isset( $cats[ $cat ] ) ) { $cats[ $cat ] = [ 'key' => $cat, 'n' => 0, 'flagged' => 0, 'welcome' => 0 ]; }
			$cats[ $cat ]['n']++;
			if ( ! empty( $r['flag'] ) ) { $cats[ $cat ]['flagged']++; } else { $cats[ $cat ]['welcome']++; }
		}
		ksort( $cats );
		return [
			'threshold'   => self::limit(),
			'scale'       => [ 'min' => 0, 'max' => 100 ],
			'model'       => self::MODEL,
			'criteria'    => [
				'We flag a comment ONLY when its purpose or effect is to dehumanise a group of people, or to frighten people — incitement, threats, or panic aimed at a group.',
				'Everything else stays — criticism, disagreement, unpopular or offensive opinions, fringe and conspiracy ideas, dark subjects discussed calmly, your own fear, dark humour, fiction, news, and quoting hate in order to condemn it.',
				'We judge intent and effect, never the topic, the words alone, or which side it takes.',
			],
			'corpus'      => [
				'total'      => count( $rows ),
				'languages'  => count( $langs ),
				'lang_codes' => array_keys( $langs ),
				'categories' => array_values( $cats ),
			],
			'calibration' => self::CALIB,
			// LIVE receipts (2026-06-12): what ArtaMod has actually done on the real platform —
			// totals, the flag rate, appeals, and the courses with the most flags. All from the same
			// public tables /data/ serves, summarised so the policy's footprint is one glance.
			//
			// SCREENED means "went through the queue", and it is counted that way rather than as
			// "every comment on a screened surface". Two filters do it: modq = 0 excludes what is
			// still waiting (a queued comment has not been read by anything), and SCREEN_SINCE
			// excludes what was posted before the queue reached these boards. Publishing a number
			// that counts either as screened would be exactly the overclaim this page exists to
			// prevent. `queued` is published beside it, so a stalled relay is visible rather than
			// silently deflating the total — read the pair, never the total alone.
			'live'        => ( function () {
				$T   = Data::t( 'aq_comments' );
				$ctx = 'context_type IN (' . self::SURFACES . ')';
				$done = "$ctx AND modq = 0 AND created >= " . (int) self::SCREEN_SINCE;
				$tot = (int) Data::col( "SELECT COUNT(*) FROM $T WHERE $done" );
				$fl  = (int) Data::col( "SELECT COUNT(*) FROM $T WHERE $done AND flagged = 1" );
				$q   = (int) Data::col( "SELECT COUNT(*) FROM $T WHERE $ctx AND modq = 1" );
				$ap  = (int) Data::col( "SELECT COUNT(*) FROM $T WHERE $ctx AND appealed = 1" );
				$apg = (int) Data::col( "SELECT COUNT(*) FROM $T WHERE $ctx AND appealed = 1 AND flagged = 0" );
				// Course-scoped by definition, so this one stays on the section board — a thread or
				// feed comment carries course_id 0 and would group into a course that isn't there.
				$top = Data::all( "SELECT c.course_id, COUNT(*) n FROM $T c WHERE c.context_type = 'section' AND c.course_id > 0 AND c.flagged = 1 GROUP BY c.course_id ORDER BY n DESC LIMIT 5" );
				$rows = [];
				foreach ( $top as $t ) {
					$co = Data::one( 'SELECT slug, title FROM ' . Data::t( 'aq_courses' ) . ' WHERE id = %d', [ (int) $t['course_id'] ] );
					if ( $co ) { $rows[] = [ 'slug' => $co['slug'], 'title' => $co['title'], 'flagged' => (int) $t['n'] ]; }
				}
				return [ 'replies_screened' => $tot, 'flagged' => $fl, 'flag_rate' => $tot ? round( $fl / $tot * 100, 2 ) : 0,
					'queued' => $q, 'appeals' => $ap, 'appeals_granted' => $apg, 'most_flagged_courses' => $rows ];
			} )(),
			// Accurate on EVERY screened surface: the flag and the "set aside" mark apply everywhere,
			// ArtaBot's consoling reply only where a competition board exists to reply on (see
			// apply_verdict) — so the sentence no longer promises a note the feed cannot leave.
			'consequence' => 'A flagged comment is never deleted and no coin is charged. It is marked "set aside" where it stands and its upvotes stop counting toward any competition (we demonetise, we do not remove); on a competition board ArtaBot also leaves a kind note. You can reword and post again.',
			'promise'     => 'We support free speech and never censor: your words are never deleted and you are never banned for crossing the line. We know we can be wrong, so the most we ever do is take a reply out of the prize competition when we sense it could cause harm. We are open to criticism and we encourage you to challenge any moderation flag — a real person reviews every challenge.',
		];
	}

	/** GET /fearometer/dataset — the WHOLE labelled test set, verbatim (radical transparency: inspect
	 *  exactly what we calibrate against). Public, cacheable, no secrets. */
	public static function dataset( $req ) {
		return [ 'updated' => self::CALIB['updated'], 'count' => count( self::corpus() ), 'cases' => self::corpus() ];
	}

	/** The calibrated system prompt: a strict rubric + few-shot anchors so the score is stable. */
	private static function system_prompt() {
		return implode( "\n", [
			'You are the Fearometer, the automated content screen for ArtaQuest, a learning platform.',
			'You read ONE short user comment and rate, 0-100, how far it TRADES IN HATE OR FEAR. Output nothing but JSON.',
			'',
			'ArtaQuest protects free, fearless thinking. The ENTIRE spectrum of honest thought stays open and must score LOW:',
			'- disagreement, sharp criticism, debate, strong or unpopular opinions',
			'- fringe, conspiratorial, pseudoscientific, religious, or political claims stated as ideas',
			'- dark, violent, or frightening SUBJECTS discussed to understand them (history, war, disease, death, crime)',
			'- a person expressing their OWN fear, sadness, anxiety, or doubt ("I\'m scared I\'ll fail", "this terrifies me")',
			'- bluntness, sarcasm, mild rudeness, or profanity that is not aimed at dehumanising a group',
			'You do NOT judge whether a claim is true, popular, tasteful, or which side it takes. Topic is never the test.',
			'',
			'Rate HIGH only when the writing\'s PURPOSE or EFFECT is to dehumanise or to frighten PEOPLE:',
			'- HATE: dehumanising a group by their identity (race, religion, nationality, gender, sexuality, disability, etc.) —',
			'  slurs used as attacks, calling people vermin/subhuman/a plague/animals, calling for/celebrating violence against',
			'  them, OR the great-replacement / demographic-invasion frame that reduces a group to a breeding threat ("they breed',
			'  like…", "outbreed us", "they swarm/flood in", "five kids per family on our taxes", "replace us", "dilute our',
			'  bloodline"). That frame is dehumanising HATE (70+), not mere policy talk.',
			'- FEAR aimed at PEOPLE: language built to frighten by scapegoating or menacing a GROUP, threatening someone, or',
			'  inciting panic/hatred/violence against people ("they are coming to exterminate us, rise up", "lock your doors, they',
			'  are grooming our children"). The fear must target people. IMPERSONAL doom with NO targeted group and no call to',
			'  harm — apocalypse, economic collapse, climate dread, prepper/"stockpile, the elites planned the crash", end-times —',
			'  is a fringe idea or personal anxiety, NOT over the line: score it LOW (≤40).',
			'',
			'Two rules that OVERRIDE surface form — judge intent and effect, not vocabulary:',
			'A) DISGUISE never lowers the score. Sarcasm, irony, jokes, a polite or pseudo-academic tone, euphemism, and coded',
			'   dog-whistles (e.g. "invaders replacing us", "genetically inferior", "vermin/rats" for a group, "sleep with one eye',
			'   open") are scored on what they actually do. Disguised dehumanisation or a veiled threat is STILL over the line.',
			'B) CONTEXT can clear the same words. Quoting hateful words to CONDEMN, report, teach, or analyse them, a person',
			'   RECLAIMING a slur about their own group, fiction, and news reporting are NOT hate — they score low. The exact',
			'   word "cockroach" is ~95 when used to attack a group and ~8 when used to say attacking a group like that is wrong.',
			'',
			'Score bands (calibrate to these):',
			'0-20  ordinary: on-topic, civil, OR personal fear/sadness, OR a calm take on a frightening subject.',
			'21-50 heated: angry, edgy, fringe, blunt, or provocative — engages ideas/arguments, does not attack people as people.',
			'51-69 borderline: leans on contempt or alarmist framing toward a group, but stops short of dehumanising or inciting.',
			'70-89 over the line: clearly dehumanises a group OR is built to frighten/incite panic.',
			'90-100 extreme: explicit slurs-as-attack, calls for violence, or severe fear-mongering/incitement.',
			'',
			'Calibration anchors:',
			'"I think the certificate rules are unfair and the instructor is wrong about openings." -> 8',
			'"Honestly I\'m terrified of public speaking, this section made me anxious." -> 6',
			'"The video glosses over how brutal the famine really was — millions starved." -> 12',
			'"Vaccines are a government mind-control scam and the moon landing was faked." -> 30',
			'"Stockpile food and water now — the elites have already planned the next collapse, society is doomed." -> 30 (impersonal doom/conspiracy, no targeted group)',
			'"People who disagree with me are complete idiots and this whole field is garbage." -> 38',
			'"Lovely enrichment for our area — five kids per family on our taxes, and in two generations they\'ll have replaced us." -> 80 (great-replacement: dehumanises a group as a breeding threat)',
			'"Calling refugees cockroaches is vile and dehumanising; shame on anyone who talks like that." -> 8 (condemns hate)',
			'"My professor is going to kill me when he sees I skipped the reading lol." -> 5 (hyperbolic idiom, no target)',
			'"Immigrants are ruining this country and we should be afraid of what they\'ll do next." -> 64',
			'"Oh sure, let the rats keep flooding in, can\'t wait for them to breed and ruin everything." -> 82 (sarcasm hiding dehumanisation)',
			'"With respect, those people are simply genetically inferior and shouldn\'t reproduce." -> 88 (polite eugenics)',
			'"[ethnic group] are cockroaches who breed like vermin and don\'t deserve to live here." -> 95',
			'"They are coming for your children. Panic now, arm yourselves, the purge is days away." -> 92',
			'',
			'Return ONLY this minified JSON, no prose, no code fence:',
			'{"fear":<0-100 integer>,"categories":[<any of "hate","fear","none">],"reason":"<one short neutral sentence>"}',
			'"reason" explains the score in one calm sentence with no slurs and no PII. Use "none" in categories for low scores.',
		] );
	}

	// ── Moderation queue (subscription-only, no API) ─────────────────────────────
	/**
	 * Drain the moderation queue: comments on every screened surface (SURFACES) are posted with
	 * aq_comments.modq = 1 and scored HERE, asynchronously, on the Claude Max SUBSCRIPTION via the
	 * relay (the paid API was removed, 2026-06-13). Runs on the aq_moderate cron. Each pass handles
	 * up to QUEUE_RUNS batches of QUEUE_BATCH comments; a batch is scored in ONE relay job (a JSON
	 * object of id→verdict). A verdict at/over LIMIT flags the comment (its upvotes leave the
	 * competition — Economy::podium filters flagged=0) and, on the section board, ArtaBot leaves a
	 * consoling reply. If the relay is unavailable the queue is simply left for the next tick —
	 * comments stay visible, just un-moderated (fail-open, no API).
	 * Returns the number of comments resolved (modq cleared) this pass.
	 */
	public static function process_queue() {
		// MUTEX: a relay batch takes seconds, during which its comments are still modq=1 — so without a
		// lock an overlapping run (a second cron tick, or a manual call) would re-pull and DOUBLE-process
		// them (duplicate console replies, double quester_touch). One drainer at a time; the short TTL
		// auto-releases if a run dies mid-flight, so the queue is never wedged. Bounded run time
		// (QUEUE_RUNS × the relay's ~50s budget) stays well under the TTL.
		// Operator pause (ArtaAI dashboard): hold the queue — comments stay modq=1 (visible, un-scored)
		// and drain once resumed. Fail-open, exactly like an unavailable relay.
		if ( class_exists( '\\AQ\\Artaai' ) && Artaai::paused( 'moderation' ) ) { return 0; }
		if ( get_transient( 'aq_moderate_lock' ) ) { return 0; }
		set_transient( 'aq_moderate_lock', 1, 280 );
		$done = 0;
		try {
			for ( $run = 0; $run < self::QUEUE_RUNS; $run++ ) {
				$rows = Data::all(
					'SELECT id, body, course_id, context_type AS ctx, context_id AS lid, parent_id, author_id FROM ' . Data::t( 'aq_comments' )
					. ' WHERE modq = 1 AND context_type IN (' . self::SURFACES . ') ORDER BY id ASC LIMIT %d',
					[ self::QUEUE_BATCH ] );
				if ( ! $rows ) { break; }

				// Test-seam / pre-scored pass: any comment the harness mocks is resolved inline (no relay).
				$batch = [];
				foreach ( $rows as $r ) {
					$v = self::score( (string) $r['body'] ); // finish(mock) when mocked, else null
					if ( $v !== null ) { self::apply_verdict( $r, $v ); $done++; }
					else { $batch[] = $r; }
				}
				if ( ! $batch ) { continue; }

				// The rest are scored together on the subscription. relay_score_batch returns null when the
				// relay is unavailable OR the answer was too incomplete to trust → leave them queued + stop.
				$verdicts = self::relay_score_batch( $batch );
				if ( $verdicts === null ) { break; }
				foreach ( $batch as $r ) {
					// The answer cleared this batch's sanity check, so an id the model still omitted is a
					// genuine one-off → default it to a clear verdict (fail-open; the comment stays visible,
					// just un-flagged) rather than wedging the queue on a single un-parseable comment.
					$v = $verdicts[ (int) $r['id'] ] ?? [ 'fear' => 0 ];
					self::apply_verdict( $r, self::finish( $v ) );
					$done++;
				}
			}
		} finally {
			delete_transient( 'aq_moderate_lock' );
		}
		return $done;
	}

	/** Write a comment's verdict, clear it from the queue, and — when flagged on the section board —
	 *  console + re-touch the author's per-season bucket so the projection reflects the now-excluded
	 *  comment. */
	private static function apply_verdict( $r, $v ) {
		Data::update( 'aq_comments',
			[ 'fear' => (int) $v['fear'], 'flagged' => ! empty( $v['flagged'] ) ? 1 : 0, 'modq' => 0 ],
			[ 'id' => (int) $r['id'] ] );
		if ( empty( $v['flagged'] ) ) { return; }
		// The queue now covers the feed and the discussion boards as well as the section board, and
		// NEITHER of those has a course: course_id is 0 and context_id is a thread / notebook id,
		// not a lesson. Assistant::console_fear writes its reply as a SECTION comment against that
		// id and bumps aq_lessons.comment_count — so on those surfaces it would file ArtaBot's note
		// where the member will never see it AND increment an unrelated lesson's counter. Console
		// only where the bot can actually reply. The FLAG itself is what sets the comment aside, and
		// that has already been written above for every surface. quester_touch is per-course too and
		// no-ops on course_id 0, but the guard says so out loud rather than relying on it.
		if ( 'section' === (string) ( $r['ctx'] ?? 'section' ) && (int) $r['course_id'] > 0 ) {
			Assistant::console_fear( (int) $r['id'], (int) $r['course_id'], (int) $r['lid'], (int) $r['parent_id'], (int) $r['author_id'] );
			Economy::quester_touch( (int) $r['course_id'], (int) $r['author_id'] );
		}
	}

	/** Score a batch of comments in ONE relay job (subscription). Returns [ id => rawVerdict ] on a
	 *  parsed answer, or null when the relay is unavailable/slow/failed (caller leaves them queued).
	 *  The job carries the same calibrated prompt; only the I/O shape changes to id-keyed JSON. */
	private static function relay_score_batch( $rows ) {
		$list = '';
		foreach ( $rows as $r ) {
			$t = trim( wp_strip_all_tags( (string) $r['body'] ) );
			if ( mb_strlen( $t ) > self::MAX_CHARS ) { $t = mb_substr( $t, 0, self::MAX_CHARS ); }
			$list .= "\n\n[#" . (int) $r['id'] . '] ' . $t;
		}
		$system = self::system_prompt()
			. "\n\nBATCH MODE: you are scoring MANY comments at once, each prefixed by its [#id]. Apply the"
			. " exact same rubric to each. Return ONLY one minified JSON object keyed by id — no prose, no"
			. ' code fence: {"<id>":{"fear":<0-100 integer>,"categories":[...],"reason":"<one short neutral'
			. ' sentence>"}, ...} with exactly one entry per [#id].';
		$messages = [ [ 'role' => 'user', 'content' => "COMMENTS TO RATE (each tagged with its [#id]):" . $list ] ];
		$via = Relay::ask( $messages, $system, self::MODEL, self::MAXTOK + 60 * count( $rows ), 'max' ); // ArtaMod scoring is accuracy-critical → max effort
		if ( $via === Relay::BUSY || ! is_array( $via ) ) { return null; }
		$text = (string) ( $via['text'] ?? '' );
		if ( ! preg_match( '/\{.*\}/s', $text, $m ) ) { return null; }
		$obj = json_decode( $m[0], true );
		if ( ! is_array( $obj ) ) { return null; }
		$out = [];
		foreach ( $obj as $k => $v ) { if ( is_array( $v ) ) { $out[ (int) $k ] = $v; } }
		// SANITY: a trustworthy answer scores most of the batch. If it returned verdicts for fewer than
		// half the comments, the response was garbled/truncated — treat the whole batch as a failure and
		// leave it queued for a retry, rather than silently clearing the un-scored majority as benign
		// (which would let real hate/fear slip through on a bad parse).
		if ( count( $out ) < (int) ceil( count( $rows ) / 2 ) ) { return null; }
		return $out;
	}
}
