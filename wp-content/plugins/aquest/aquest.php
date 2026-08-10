<?php
/**
 * Plugin Name: ArtaQuest
 * Description: The entire ArtaQuest platform — LMS, economy, social, i18n, funds — in one
 *              lean, dependency-free plugin. Replaces MasterStudy LMS + WooCommerce.
 * Version:     1.20.651
 * Author:      ArtaQuest Foundation
 * License:     GNU AGPLv3
 * License URI: https://www.gnu.org/licenses/agpl-3.0.html
 *
 * Architecture: see /ARCHITECTURE.md. One plugin, ~18 src classes, normalized shardable
 * tables, append-only ledgers, cursor pagination, content-addressed i18n. The whole
 * REST surface is one table in src/Rest.php — start there.
 */

if ( ! defined( 'ABSPATH' ) ) { exit; }

// Keep this EQUAL to the plugin header above. Two fields both called "the version" that
// disagree will send the next person chasing a production divergence that is not there: the
// header is what get_plugin_data() reads, AQ_VERSION is what /version reports and what the
// integrity sweep keys on. Bump them together, always.
define( 'AQ_VERSION', '1.20.651' );
define( 'AQ_DIR', __DIR__ );
define( 'AQ_URL', plugins_url( '', __FILE__ ) );

/** PSR-4-ish autoloader for the AQ\ namespace → src/*.php (require_once: never redeclare). */
spl_autoload_register( function ( $class ) {
	if ( strpos( $class, 'AQ\\' ) !== 0 ) { return; }
	$file = AQ_DIR . '/src/' . str_replace( 'AQ\\', '', $class ) . '.php';
	if ( is_readable( $file ) ) { require_once $file; }
} );

/**
 * Eagerly load every domain class at plugin load instead of relying solely on lazy
 * autoloading. On multi-container hosts (WordPress.com Atomic), lazy class loading after a
 * file sync proved flaky — a request would reference AQ\Db before its file was visible to
 * that worker, yielding "Class AQ\Db not found". Loading all classes up-front (each guarded
 * by class_exists) makes the backend deterministic regardless of autoload/opcache timing.
 */
foreach ( [ 'Data', 'Schema', 'Cron', 'Secrets', 'Vault', 'Watchdog', 'Integrity', 'Health', 'Rest', 'Auth', 'Sessions', 'Account', 'Verify', 'Courses', 'Topics', 'Typology', 'Learn', 'Economy', 'Season', 'Social', 'Search', 'I18n', 'Funds', 'Extra', 'Offline', 'Notify', 'Meet', 'Assistant', 'Relay', 'Science', 'Library', 'Music', 'Motion', 'Narrate', 'Film', 'Illustration', 'Fearometer', 'Tickets', 'Stripe', 'YouTube', 'Console', 'Trends', 'Houses', 'Competitions', 'Translate', 'Artaai', 'Games', 'Challenges', 'Demo', 'Doi', 'Notebook', 'Chat', 'Rooms', 'Shell', 'Api', 'Passkey', 'News', 'Kaggle', 'Kernel', 'Gist', 'Credits', 'KaggleId' ] as $aq_cls ) {
	$aq_file = AQ_DIR . '/src/' . $aq_cls . '.php';
	if ( ! class_exists( 'AQ\\' . $aq_cls, false ) && is_readable( $aq_file ) ) { require_once $aq_file; }
}

/** Grant the one-time ArtaBot welcome allowance (1k free tokens) on every signup. */
add_action( 'user_register', [ 'AQ\\Economy', 'grant_signup_allowance' ] );

/** The "you have a message" email, sent OFF the chat/send request (see AQ\Chat::email_dm): an
 *  authenticated SMTP socket must never sit between a member and their message being delivered.
 *  Scheduled EMAIL_QUIET_S out and re-checked against the read watermark when it fires, so a
 *  message the member has since read is never emailed about. Five args (older queued events carry
 *  two — the extra ones default). */
add_action( 'aq_dm_email', [ 'AQ\\Chat', 'send_dm_email' ], 10, 5 );

/** Daily sweep of sealed chat attachments no message references — every abandoned composer (a failed
 *  send, a closed tab, a change of mind) leaves one on disk, and nothing else would ever unlink them
 *  (AQ\Chat::gc_blobs). Registered the way every other recurring job here is: scheduled on
 *  `plugins_loaded`, and the handler behind Cron::guard so two overlapping runs cannot both sweep. */
add_action( 'plugins_loaded', function () {
	if ( ! wp_next_scheduled( 'aq_chat_blob_gc' ) ) { wp_schedule_event( time() + 3600, 'daily', 'aq_chat_blob_gc' ); }
} );
aq_cron_on( 'aq_chat_blob_gc', 'aq_chat_blob_gc', [ 'AQ\\Chat', 'gc_blobs' ], 3600 );

/**
 * ONE way to join ArtaQuest: the passwordless flow in AQ\Auth (email one-time code or Google),
 * which is the only path that runs the onboarding every account must complete — a real full name
 * and an EXACT date of birth, both public (operator 2026-07-25).
 *
 * WordPress's own wp-login.php?action=register was still live and minted accounts that never
 * touched AQ\Auth at all. Rest::birthday_gate means such an account can't actually DO anything,
 * but a second front door with a password field has no place on a platform whose auth is
 * deliberately passwordless — so it is closed here.
 *
 * Closed with a FILTER, not the option: `users_can_register` is flippable from wp-admin (which is
 * exactly why AQ\Watchdog already treats it as tamper-sensitive), while this holds regardless of
 * what the row says. registration_errors is the belt to that braces — anything that reaches the
 * actual create step, by any route, is refused there too.
 */
add_filter( 'option_users_can_register', '__return_zero' );
add_filter( 'registration_errors', function ( $errors ) {
	$e = is_wp_error( $errors ) ? $errors : new WP_Error();
	$e->add( 'aq_registration_closed', __( 'Create your ArtaQuest account from the sign-in page — no password needed.', 'artaquest' ) );
	return $e;
}, 99 );
/**
 * Bring the STORED row into step with the filter, exactly once.
 *
 * AQ\Watchdog fingerprints every critical option (users_can_register among them) with get_option(),
 * i.e. THROUGH filters, and compares that against its stored baseline. Filtering the value while
 * leaving the row at '1' makes the two permanently disagree, and because no updated_option hook ever
 * fired, the hourly sweep takes its "the option hooks did not report this" branch and emails the
 * operator that a critical option "was edited with DIRECT database access" — our own deploy,
 * reported as a takeover. Writing the row once makes the change hook-visible (one honest alert) and
 * the fingerprint stable thereafter. The filter above remains the real guarantee; this is only about
 * not crying wolf.
 */
add_action( 'plugins_loaded', function () {
	if ( get_option( 'aq_registration_row_synced' ) === '1' ) { return; }
	// The filter must stay OFF across the write as well as the read: update_option() compares the
	// new value against get_option(), so with the filter on it sees 0 === 0 and skips the write
	// entirely — the row stays '1' and the alarm this exists to prevent still fires.
	remove_filter( 'option_users_can_register', '__return_zero' );
	if ( (string) get_option( 'users_can_register' ) !== '0' ) {
		update_option( 'users_can_register', 0 );
	}
	add_filter( 'option_users_can_register', '__return_zero' );
	update_option( 'aq_registration_row_synced', '1', true );
}, 20 );

/** Send anyone who lands on the WordPress register screen to the real one instead of a dead end. */
add_action( 'login_init', function () {
	$action = isset( $_GET['action'] ) ? sanitize_key( wp_unslash( $_GET['action'] ) ) : '';
	if ( $action === 'register' ) {
		wp_safe_redirect( home_url( '/login/' ) );
		exit;
	}
} );
// DOI short links (/d/p24, /d/a1) — the archive provider never appears member-facing (operator 2026-07-13).
add_action( 'parse_request', [ 'AQ\\Doi', 'maybe_redirect' ], 1 );
// Notebook publication (operator 2026-07-23, author-ONLY gate): the single-use confirm link
// emailed to the AUTHOR's registered address lands here — their explicit POST is the one and
// only thing that publishes + mints the DOI. nopriv is deliberate: the emailed secret (stored
// only as a hash) is the authority. The operator decide leg (aq_nb_decide) was removed the
// same day — no operator email exists anywhere in the publication flow.
add_action( 'admin_post_aq_nb_confirm', [ 'AQ\\Notebook', 'confirm_http' ] );
// ArtaNews publication gate — the emailed single-use secret IS the authentication, so nopriv is
// required: the author confirms from their inbox, not from a logged-in session.
add_action( 'admin_post_aq_news_confirm', [ 'AQ\\News', 'confirm_http' ] );
add_action( 'admin_post_nopriv_aq_news_confirm', [ 'AQ\\News', 'confirm_http' ] );
add_action( 'admin_post_nopriv_aq_nb_confirm', [ 'AQ\\Notebook', 'confirm_http' ] );

/** Developer API tokens (src/Api.php): a valid `Authorization: Bearer aq_…` signs a /wp-json/
 *  request in as the token's owner (after cookie auth, which always wins); token sessions are
 *  scope-gated to Api::TOKEN_ROUTES and never carry manage_options. */
add_filter( 'determine_current_user', [ 'AQ\\Api', 'determine_user' ], 30 );
add_filter( 'user_has_cap', [ 'AQ\\Api', 'strip_admin_caps' ] );

/** Register a WP-cron handler that runs through AQ\Cron::guard (overlap lock + error isolation +
 *  last-run/error stats). `$key` is the stat key (distinct per handler so two handlers on one hook don't
 *  collide); `$ttl` ≈ the job's longest expected runtime. Every aq_* cron is registered through this. */
function aq_cron_on( $hook, $key, $cb, $ttl = 1800 ) {
	add_action( $hook, function () use ( $key, $cb, $ttl ) { AQ\Cron::guard( $key, $cb, $ttl ); } );
}

/** Install/migrate schema on activation, and on every load if the version moved. */
register_activation_hook( __FILE__, [ 'AQ\\Schema', 'install' ] );
add_action( 'plugins_loaded', function () {
	if ( get_option( 'aq_schema_version' ) !== AQ\Schema::VERSION ) {
		AQ\Schema::install();
	}
	AQ\Notify::ensure_table(); // self-installs aq_notifications (no-op once current)
	AQ\Notebook::ensure_tables(); // self-installs aq_notebooks + aq_nb_runs + aq_nb_reviews — THE feed substrate (2026-07-13)
	AQ\Api::ensure_table(); // self-installs aq_api_tokens — the developer API layer (2026-07-23)
	AQ\Passkey::ensure_table(); // self-installs aq_passkeys — publication co-signing keys (2026-07-24)
	// ── 2026-07-13 NOTEBOOK-FEED RESET: every legacy seed/import call was removed here.
	//    They re-populated retired content (courses, tracks, films, competitions, typologies …) whenever
	//    a table was empty or a bundled file's mtime moved — after the full data purge that would silently
	//    resurrect the old platform. The legacy tables stay (empty) until their code is retired; handlers
	//    still self-ensure their tables on first touch. Do NOT re-add a seeder without an operator order.
	//
	//    ONE exception, restored 2026-08-04 by operator order, and it is not a legacy seeder: the GRANTS
	//    catalogue. Grants are live and member-facing — the bursaries that let someone enter a challenge
	//    they cannot otherwise afford are paid from this table — so it was collateral damage of that
	//    sweep rather than a target of it. The consequence ran for weeks in silence: import_grants() had
	//    no caller anywhere, /outreach answered {"grants":0}, and Schema.php's own comment went on saying
	//    the catalogue was "refreshed from data/outreach-grants.json on deploy". Nothing was refreshing
	//    anything. Restoring the call is what makes that sentence true again.
	//
	//    It is safe to run on every load and cheap: import_grants() is filemtime-gated, so after the
	//    first request following a deploy it is one stat and one autoloaded get_option. It upserts by
	//    slug and deactivates slugs absent from the file — it never resurrects a retired platform,
	//    because the file it reads is synced from ArtaQuest/artagrants and contains grants only.
	AQ\Extra::import_grants();
} );

/** Language-prefix URL router (/es/, /fa/, …) — must run before WordPress parses the
 *  request, so it strips the prefix from REQUEST_URI on plugins_loaded. */
add_action( 'plugins_loaded', [ 'AQ\\I18n', 'boot_router' ], 1 );

/** Competition seasons reset on the day closest to each new moon (10:00 ET). A daily cron closes
 *  + archives any season that has ended; the rankings endpoint also does this lazily on read, so
 *  the reset is robust even where WP-cron is unreliable (e.g. local PHP-WASM). */
add_action( 'plugins_loaded', function () {
	if ( ! wp_next_scheduled( 'aq_season_reset' ) ) { wp_schedule_event( time() + 300, 'daily', 'aq_season_reset' ); }
} );
aq_cron_on( 'aq_season_reset', 'aq_season_reset', [ 'AQ\\Season', 'ensure_archived' ], 3600 );
aq_cron_on( 'aq_season_reset', 'aq_season_reset:challenges', [ 'AQ\\Challenges', 'ensure_archived' ], 3600 ); // settle + freeze the creative challenges on the same new-moon reset (also lazy on read)

/** ArtaTranslate GC: a nightly sweep that keeps the translation mesh clean — when a work's English
 *  original is EDITED its old strings' translations are purged everywhere (fingerprint diff, every
 *  language incl. arta), abandoned narration placeholders and never-read cold cache rows are dropped
 *  (the mesh self-heals: a deleted row just re-translates on the next visit), and orphaned round
 *  records are pruned. Bounded batches; stats on /translate/status. See Translate::gc(). */
add_action( 'plugins_loaded', function () {
	if ( ! wp_next_scheduled( 'aq_tr_gc' ) ) { wp_schedule_event( time() + 900, 'daily', 'aq_tr_gc' ); }
} );
aq_cron_on( 'aq_tr_gc', 'aq_tr_gc', [ 'AQ\\Translate', 'gc' ], 1800 );

/** ArtaCloud housekeeping: reap uploads abandoned mid-flight (closed laptop, lost connection) so their
 *  reserved bytes stop counting against the member's shelf. See Media::sweep_now(). */
add_action( 'plugins_loaded', function () {
	if ( ! wp_next_scheduled( 'aq_media_sweep' ) ) { wp_schedule_event( time() + 1200, 'hourly', 'aq_media_sweep' ); }
} );
aq_cron_on( 'aq_media_sweep', 'aq_media_sweep', [ 'AQ\\Media', 'sweep_now' ], 3600 );
/** Warn the operator at 90% of the R2 free tier (storage + the operations we can see) — daily, so a
 *  quota creeping up is caught with room to act rather than discovered on an invoice. */
if ( ! wp_next_scheduled( 'aq_media_quota' ) ) { wp_schedule_event( time() + 1800, 'daily', 'aq_media_quota' ); }
aq_cron_on( 'aq_media_quota', 'aq_media_quota', [ 'AQ\\Media', 'quota_check' ], 600 );

/** Tournament settlement heartbeat: settlement is lazy on every /challenges read, but an hourly
 *  cron guarantees full-moon payouts even through a traffic lull (2026-07-15). */
add_action( 'plugins_loaded', function () {
	if ( ! wp_next_scheduled( 'aq_nb_settle' ) ) { wp_schedule_event( time() + 240, 'hourly', 'aq_nb_settle' ); }
} );
aq_cron_on( 'aq_nb_settle', 'aq_nb_settle', [ 'AQ\\Notebook', 'challenges' ], 900 );

/** Cash-out safety net: a daily reconcile that records a coin debit for any Stripe Connect cash-out
 *  transfer that succeeded but whose debit never landed (e.g. a network timeout AFTER Stripe processed
 *  the transfer, when the member never retried). record_payout is idempotent, so already-debited
 *  transfers are skipped — this only closes the rare money-out-without-a-debit gap. */
add_action( 'plugins_loaded', function () {
	if ( ! wp_next_scheduled( 'aq_payout_reconcile' ) ) { wp_schedule_event( time() + 600, 'daily', 'aq_payout_reconcile' ); }
} );
aq_cron_on( 'aq_payout_reconcile', 'aq_payout_reconcile', [ 'AQ\\Economy', 'reconcile_payouts' ], 3600 );

/** Competition deadlines: a daily settle closes every competition whose deadline has passed and
 *  pays its coin podium (owner-funded 50/30/20; idempotent by ledger ref — see Competitions::settle_due). */
add_action( 'plugins_loaded', function () {
	if ( ! wp_next_scheduled( 'aq_comp_settle' ) ) { wp_schedule_event( time() + 700, 'daily', 'aq_comp_settle' ); }
} );
aq_cron_on( 'aq_comp_settle', 'aq_comp_settle', [ 'AQ\\Competitions', 'settle_due' ], 3600 );

/** COMMENT-BASED TRENDING (operator 2026-06-14, supersedes the brief internal-comment experiment): a
 *  course/video trends by the DISCUSSION its source video sparks — its YouTube commentCount, fetched
 *  via the cheap, quota-safe videos.list?part=statistics call (NOT viewCount, never commentThreads).
 *  aq_video_refresh polls the due videos' commentCount hourly → a 28-day rolling comments/day rate;
 *  aq_trend_sweep re-scores every course hourly (pure SQL, no quota); aq_video_sync re-syncs the
 *  registry + compacts history daily. Every cron below runs through AQ\Cron::guard (overlap lock +
 *  error isolation + last-run/error stats in the operator Console). Two custom intervals: */
add_filter( 'cron_schedules', function ( $s ) {
	if ( ! isset( $s['aq_15min'] ) ) { $s['aq_15min'] = [ 'interval' => 900, 'display' => 'Every 15 minutes (ArtaQuest)' ]; }
	if ( ! isset( $s['aq_5min'] ) )  { $s['aq_5min']  = [ 'interval' => 300, 'display' => 'Every 5 minutes (ArtaQuest)' ]; }
	if ( ! isset( $s['aq_6h'] ) )    { $s['aq_6h']    = [ 'interval' => 21600, 'display' => 'Every 6 hours (ArtaQuest)' ]; }
	return $s;
} );
add_action( 'plugins_loaded', function () {
	// YouTube COMMENT-count monitor (operator 2026-06-14): every hour, refresh each section video's
	// YouTube commentCount (videos.list?part=statistics — the cheap, quota-safe call), derive its
	// comments-per-HOUR rate, and re-score every course (avg per-video rate). The refresh engine fires
	// every 15 min over the due set (each video comes due ~hourly via INTERVAL jitter); a daily sync
	// re-syncs the registry from the lessons + compacts the hourly history; an hourly sweep re-scores
	// all courses as a safety net so the catalogue + the per-course graph stay current.
	// Update cadence is HOURLY (operator 2026-06-16; re-applied after an autopilot version-bump reverted
	// it). A DAILY poll was too slow — newly-added videos sat UNMEASURED for a day+ (their courses read
	// 0/day) and the rank recompute fell behind edits, leaving ~every course stuck at a stale
	// rank_score=0. The 28-day rolling AVERAGE keeps the displayed rate smooth regardless of poll rate,
	// and the quota cost is trivial (~236 videos hourly ≈ 120 units/day vs the 10k/day cap). aq_trend_sweep
	// is pure SQL (no quota) so it MUST run often to keep ranks fresh + restore courses as their post-edit
	// cooldown expires. Reschedule any pre-existing daily jobs back up to hourly.
	if ( wp_next_scheduled( 'aq_video_refresh' ) && wp_get_schedule( 'aq_video_refresh' ) !== 'hourly' ) { wp_clear_scheduled_hook( 'aq_video_refresh' ); }
	if ( ! wp_next_scheduled( 'aq_video_refresh' ) ) { wp_schedule_event( time() + 120, 'hourly', 'aq_video_refresh' ); }
	if ( ! wp_next_scheduled( 'aq_video_sync' ) )    { wp_schedule_event( time() + 180, 'daily', 'aq_video_sync' ); }
	if ( wp_next_scheduled( 'aq_trend_sweep' ) && wp_get_schedule( 'aq_trend_sweep' ) !== 'hourly' ) { wp_clear_scheduled_hook( 'aq_trend_sweep' ); }
	if ( ! wp_next_scheduled( 'aq_trend_sweep' ) )   { wp_schedule_event( time() + 300, 'hourly', 'aq_trend_sweep' ); }
	if ( ! wp_next_scheduled( 'aq_retriage' ) )      { wp_schedule_event( time() + 240, 'aq_15min', 'aq_retriage' ); }
	// ArtaMod moderation queue (subscription-only): drain queued section comments through the relay.
	if ( ! wp_next_scheduled( 'aq_moderate' ) )      { wp_schedule_event( time() + 120, 'aq_5min', 'aq_moderate' ); }
	// Discussion seeder: give each video's board a starter referencing its top YouTube comment.
	if ( ! wp_next_scheduled( 'aq_seed_boards' ) )   { wp_schedule_event( time() + 360, 'aq_15min', 'aq_seed_boards' ); }
	if ( ! wp_next_scheduled( 'aq_purge_zero_rate' ) ) { wp_schedule_event( time() + 420, 'daily', 'aq_purge_zero_rate' ); }
		// DATA-API DISCOVERY + CHURN (operator 2026-06-21 — "search all topics each cycle, add promising
		// candidates, drop the persistent lows; maximise #videos × avg discussion rate"). A self-budgeting
		// search.list crawler rotates across every published course (hard cap YouTube::DISCOVER_DAILY_CAP/day so
		// it can never exhaust the 10k quota the rate monitor depends on); a prove-then-add settle adds only a
		// candidate whose measured 24h rate ≥ the course's baseline; a daily prune drops a >5-video course's
		// persistent lows (rate below mean−2σ, floored). These OWN the video lifecycle now (the engine's LLM
		// grow/settle were retired in favour of this deterministic, comprehensive, quota-aware pipeline).
		if ( ! wp_next_scheduled( 'aq_discover' ) )          { wp_schedule_event( time() + 480, 'hourly', 'aq_discover' ); }
		if ( ! wp_next_scheduled( 'aq_settle_candidates' ) ) { wp_schedule_event( time() + 540, 'hourly', 'aq_settle_candidates' ); }
		if ( ! wp_next_scheduled( 'aq_prune' ) )             { wp_schedule_event( time() + 660, 'daily', 'aq_prune' ); }
} );
aq_cron_on( 'aq_video_refresh', 'aq_video_refresh', [ 'AQ\\YouTube', 'refresh_due' ], 1800 );       // fetch due videos' YouTube comment counts
aq_cron_on( 'aq_video_sync', 'aq_video_sync', [ 'AQ\\YouTube', 'sync_registry' ], 1800 );          // keep aq_videos in lockstep with the lessons
aq_cron_on( 'aq_video_sync', 'aq_video_sync:compact', [ 'AQ\\YouTube', 'compact_stats' ], 1800 );  // fold old hourly history buckets to daily
aq_cron_on( 'aq_trend_sweep', 'aq_trend_sweep', [ 'AQ\\YouTube', 'recompute_all_trends' ], 1800 ); // hourly safety re-score of every course
aq_cron_on( 'aq_retriage', 'aq_retriage', [ 'AQ\\Assistant', 'retriage_stale' ], 900 );
aq_cron_on( 'aq_moderate', 'aq_moderate', [ 'AQ\\Fearometer', 'process_queue' ], 600 );            // every 5 min — skip overlap if a relay batch runs long
aq_cron_on( 'aq_seed_boards', 'aq_seed_boards', [ 'AQ\\Learn', 'seed_pending' ], 900 );            // seed video boards with their top YouTube comment
aq_cron_on( 'aq_purge_zero_rate', 'aq_purge_zero_rate', [ 'AQ\\YouTube', 'purge_zero_rate' ], 3600 ); // daily: delete videos measured at 0 comments/day (+ now-empty courses)
aq_cron_on( 'aq_discover', 'aq_discover', [ 'AQ\\YouTube', 'discover' ], 1800 );                    // hourly: rotate search.list, track promising new candidates
aq_cron_on( 'aq_settle_candidates', 'aq_settle_candidates', [ 'AQ\\YouTube', 'settle_candidates' ], 1800 ); // hourly: prove-then-add ripe candidates (rate ≥ baseline)
aq_cron_on( 'aq_prune', 'aq_prune', [ 'AQ\\YouTube', 'prune_underperformers' ], 1800 );            // daily: drop a >5-video course's persistent lows (mean−2σ)

/** Open datasets (2026-06-12): nightly NDJSON.gz snapshot of every aq_* table (the same rows the
 *  public explorer serves) → uploads/datasets/ + GET /datasets. Research-ready + de-facto backup.
 *  The monthly reserve audit rides the hourly watchdog tick (first tick of each month appends). */
add_action( 'plugins_loaded', function () {
	if ( ! wp_next_scheduled( 'aq_dataset' ) ) { wp_schedule_event( time() + 300, 'daily', 'aq_dataset' ); }
} );
aq_cron_on( 'aq_dataset', 'aq_dataset', [ 'AQ\\Extra', 'dataset_build' ], 3600 ); // big NDJSON build — long TTL
aq_cron_on( 'aq_watchdog', 'aq_watchdog', [ 'AQ\\Extra', 'reserve_audit_tick' ], 1800 );

/** TRENDING RAIL (feed, 2026-07-22/23): everything OFF the request path — GET /scholar/trending
 *  only assembles stored pools. Two crons: the 6-hourly scholar refresh (OpenAlex windows,
 *  dedupe, HEAD-check, citation sampling → MONTHLY rates) and the HOURLY marketplace sampling
 *  pass (every kind's counters → OUR measured rates per hour/day — operator: selection by our
 *  own rate calculation, never the marketplace's board order). */
add_action( 'plugins_loaded', function () {
	if ( ! wp_next_scheduled( 'aq_scholar_refresh' ) ) { wp_schedule_event( time() + 500, 'aq_6h', 'aq_scholar_refresh' ); }
	if ( ! wp_next_scheduled( 'aq_mkt_sample' ) )      { wp_schedule_event( time() + 700, 'hourly', 'aq_mkt_sample' ); }
	if ( ! wp_next_scheduled( 'aq_social_crawl' ) )    { wp_schedule_event( time() + 900, 'hourly', 'aq_social_crawl' ); }
	if ( ! wp_next_scheduled( 'aq_commodities' ) )     { wp_schedule_event( time() + 600, 'daily', 'aq_commodities' ); }
	// ArtaNews: DETECT polls the instrument feeds and thresholds them. Detection keeps running — it
	// is measurement, and it is what a report is made of.
	if ( ! wp_next_scheduled( 'aq_news_detect' ) )      { wp_schedule_event( time() + 300, 'aq_6h', 'aq_news_detect' ); }
	// …and SOCIAL collects Tier-2 context for detections that already exist. Separate hook, separate
	// schedule, and deliberately OFFSET from detection rather than chained to it: it must be obvious
	// in the scheduler that nothing social feeds detection. It cannot create or rank an event — see
	// News::social_tick. Hourly because Reddit throttles hard and there is nothing to gain by asking
	// more often than the feeds turn over.
	if ( ! wp_next_scheduled( 'aq_news_social' ) )      { wp_schedule_event( time() + 1500, 'hourly', 'aq_news_social' ); }
	// THE LEGACY REPORT LOOP IS DISARMED (operator 2026-07-28). It wrote an aq_news_articles row and
	// published it on an emailed secret alone — a SECOND publication path with no Kaggle notebook,
	// no reproducibility checklist, no passkey co-signature, no DOI, no Library entry and no
	// integrity sweep, to a /news/<slug>/ URL the theme does not even serve. Everything on this
	// platform publishes through the one gate or it does not publish. ArtaNews briefly rejoined the
	// feed as an ordinary ArtaBot notebook; that posting loop is now removed too (see below), so
	// ArtaNews publishes NOTHING and lives entirely in the rail card.
	wp_clear_scheduled_hook( 'aq_news_report' );
	// ARTANEWS NO LONGER POSTS (operator 2026-07-31: disaster signals belong "in the bottom card like
	// any other news and not posted — so not posted under ArtaBot's account"). The posting loop is
	// deleted from News.php, so this hook is cleared rather than merely left unscheduled: an install
	// that armed it on a previous deploy would otherwise keep firing at a method that no longer
	// exists. Detection is untouched — the card reads aq_news_events directly now.
	wp_clear_scheduled_hook( 'aq_artanews' );
	if ( ! wp_next_scheduled( 'aq_artabot_mentions' ) ) { wp_schedule_event( time() + 240, 'aq_5min', 'aq_artabot_mentions' ); }
} );
aq_cron_on( 'aq_scholar_refresh', 'aq_scholar_refresh', [ 'AQ\\Extra', 'scholar_refresh_tick' ], 900 );
aq_cron_on( 'aq_mkt_sample', 'aq_mkt_sample', [ 'AQ\\Extra', 'mkt_sample_tick' ], 600 );
// Daily commodity prices in ArtaCoin (operator 2026-07-24): oil/gas/coal/wheat/maize, 56-day ₳ series. See Extra::commodities_tick.
aq_cron_on( 'aq_commodities', 'aq_commodities', [ 'AQ\\Extra', 'commodities_tick' ], 600 );
aq_cron_on( 'aq_news_detect', 'aq_news_detect', [ 'AQ\\News', 'detect_tick' ], 900 );  // ~9MB satellite pull + clustering
aq_cron_on( 'aq_news_social', 'aq_news_social', [ 'AQ\\News', 'social_tick' ], 300 );  // TIER 2 ONLY — attributed context, never a detection
// @artabot mentions (operator 2026-07-30): ArtaBot is a participant, not just a publisher — tag it
// anywhere and it replies in that thread. A CRON, not a comment hook: the relay is async and may be
// cold, and a hook that throws would take the member's comment down with it.
aq_cron_on( 'aq_artabot_mentions', 'aq_artabot_mentions', [ 'AQ\\Assistant', 'mention_tick' ], 300 );
// Educational social crawl (operator 2026-07-23): its OWN hourly cron so a Reddit token stall or a
// YouTube quota trip can't wobble the marketplace tick. Reddit/YouTube/Instagram, each dormant
// until its Vault secret exists. See Extra::social_crawl_tick.
aq_cron_on( 'aq_social_crawl', 'aq_social_crawl', [ 'AQ\\Extra', 'social_crawl_tick' ], 600 );

/** PRICE ORACLE (gold spot + fx): a daily sanity-gated refresh (see Economy::gold_rate_tick — hard
 *  bounds + a ±20% band so a glitched/poisoned feed can never crater or spike the coin price) and an
 *  hourly staleness alarm on the watchdog sweep (a frozen oracle silently misprices every coin buy,
 *  cash-out and shop fee — it sat 35 days stale before this cron existed, 2026-07-10). */
add_action( 'plugins_loaded', function () {
	if ( ! wp_next_scheduled( 'aq_gold_rate' ) ) { wp_schedule_event( time() + 400, 'daily', 'aq_gold_rate' ); }
	// The daily statement (src/Usage.php). Just after the gold refresh, so a day's invoice is priced
	// against a spot that was updated first rather than one that is a day stale.
	if ( ! wp_next_scheduled( 'aq_daily_invoice' ) ) { wp_schedule_event( time() + 700, 'daily', 'aq_daily_invoice' ); }
} );
aq_cron_on( 'aq_gold_rate', 'aq_gold_rate', [ 'AQ\\Economy', 'gold_rate_tick' ], 3600 );
aq_cron_on( 'aq_daily_invoice', 'aq_daily_invoice', [ 'AQ\\Usage', 'daily_invoice_tick' ], 3600 );
aq_cron_on( 'aq_watchdog', 'aq_watchdog:oracle', [ 'AQ\\Economy', 'check_oracle' ], 1800 );

/** Security watchdog (see Watchdog.php): hourly tamper sweep (honeytraps in the public DB,
 *  admin-roster + critical-option baselines, append-only ledger proofs, secret-leak scan,
 *  rotation alarms) plus instant tripwires on REST trap use, admin promotions, and password
 *  probes. The secrets VAULT (Vault.php) is managed at wp-admin → AQ Security. */
add_action( 'plugins_loaded', function () {
	AQ\Watchdog::boot();
	if ( ! wp_next_scheduled( 'aq_watchdog' ) ) { wp_schedule_event( time() + 90, 'hourly', 'aq_watchdog' ); }
} );
add_action( 'admin_menu', [ 'AQ\\Vault', 'admin_menu' ] );
add_action( 'admin_init', [ 'AQ\\Vault', 'handle_actions' ] );

/** ArtaAI — the operator's platform-wide AI monitor + control surface (wp-admin read-out; the full
 *  interactive controls live in the SPA at Studio › ArtaAI). See src/Artaai.php. */
add_action( 'admin_menu', [ 'AQ\\Artaai', 'admin_menu' ] );

/** Filesystem + economic-invariant integrity monitor (see Integrity.php) — runs on the same hourly
 *  sweep as the Watchdog: webshell scan of uploads, drop-in / mu-plugin / code-manifest baselines,
 *  cron-persistence detection, and the full-reserve solvency invariant. Alarms ride the Watchdog channel. */
aq_cron_on( 'aq_watchdog', 'aq_watchdog:integrity', [ 'AQ\\Integrity', 'run' ], 1800 );

/** Close the wp-admin code-injection path: with a public DB and delegated auth, the built-in
 *  Plugin/Theme File Editor must never be a way to run arbitrary PHP. Define here (portable across
 *  every environment) unless wp-config already set it. Recovery: define it false in wp-config. */
if ( ! defined( 'DISALLOW_FILE_EDIT' ) ) { define( 'DISALLOW_FILE_EDIT', true ); }

register_deactivation_hook( __FILE__, function () {
	wp_clear_scheduled_hook( 'aq_season_reset' );
	wp_clear_scheduled_hook( 'aq_payout_reconcile' );
	wp_clear_scheduled_hook( 'aq_tr_gc' );
	wp_clear_scheduled_hook( 'aq_video_refresh' ); // retired (comment-based trending)
	wp_clear_scheduled_hook( 'aq_video_sync' );     // retired
	wp_clear_scheduled_hook( 'aq_trend_sweep' );
	wp_clear_scheduled_hook( 'aq_retriage' );
	wp_clear_scheduled_hook( 'aq_moderate' );
	wp_clear_scheduled_hook( 'aq_purge_zero_rate' );
	wp_clear_scheduled_hook( 'aq_seed_boards' );
	wp_clear_scheduled_hook( 'aq_discover' );
	wp_clear_scheduled_hook( 'aq_settle_candidates' );
	wp_clear_scheduled_hook( 'aq_prune' );
	wp_clear_scheduled_hook( 'aq_dataset' );
	wp_clear_scheduled_hook( 'aq_watchdog' );
} );

/** Subscribable .ics of every dated grant deadline at /?aq_grants_ics=1 (text/calendar). Runs
 *  before the SPA shell would otherwise swallow the request. */
add_action( 'template_redirect', function () {
	if ( isset( $_GET['aq_grants_ics'] ) ) { AQ\Extra::serve_ics(); }
}, 5 );

/** Course detail URLs (/courses/<slug>/) have no WordPress post behind them anymore
 *  (the stm-courses CPT was retired with MasterStudy), so WP 404s them even though the
 *  SPA renders the course. Restore a 200 status for slugs that exist in aq_courses so
 *  these core pages are indexable. The theme already serves the SPA on is_404(). */
add_action( 'template_redirect', function () {
	if ( ! is_404() ) { return; }
	$path = trim( (string) wp_parse_url( $_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH ), '/' );
	if ( preg_match( '#^courses/([a-z0-9-]+)$#', $path, $m )
		&& AQ\Data::col( 'SELECT 1 FROM ' . AQ\Data::t( 'aq_courses' ) . ' WHERE slug = %s', [ $m[1] ] ) ) {
		status_header( 200 );
	}
}, 99 );

/** An uploads file that has been moved to the CDN and deleted from origin disk redirects there
 *  instead of 404ing (priority 1 — before the SPA shell claims the 404). Only reachable when the
 *  web server already failed to serve the file, so a present file never touches this. */
add_action( 'template_redirect', [ 'AQ\\Media', 'uploads_fallback' ], 1 );

/** Public DB ⇒ stored password material must be inert: disable password + application-password
 *  logins (auth is delegated to email codes + Google). Recovery: AQ_ALLOW_PASSWORD_LOGIN in wp-config. */
add_action( 'init', [ 'AQ\\Auth', 'harden' ] );

/** Serve the PWA service worker (/sw.js) + manifest (/manifest.webmanifest) at the site ROOT so the
 *  offline service worker controls the whole SPA (priority 0 — before WP would 404 these paths). */
add_action( 'init', [ 'AQ\\Offline', 'serve_pwa_assets' ], 0 );

/** A verified member's uploaded profile photo replaces the gravatar default everywhere get_avatar() runs. */
add_filter( 'get_avatar_data', [ 'AQ\\Verify', 'filter_avatar' ], 10, 2 );

/** Register the REST API. This is the only entry point into the backend.
 *  Priority 99 → registered AFTER the theme's legacy aq/v1 routes, so the new plugin
 *  authoritatively owns every /aq/v1/* path during and after the cutover (WordPress
 *  last-registration-wins). Lets the SPA run on the new backend without theme surgery. */
add_action( 'rest_api_init', [ 'AQ\\Rest', 'register' ], 99 );
