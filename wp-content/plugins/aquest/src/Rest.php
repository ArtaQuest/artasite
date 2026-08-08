<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * The entire backend API in one table. Each row is [ method, path, handler, auth ]:
 *   - method : 'GET' (public, cacheable) or 'POST' (mutation, session required)
 *   - path   : under /wp-json/aq/v1/ ; `(?P<name>…)` segments arrive as request params
 *   - handler: 'Domain::method' — a static method($req) returning array|WP_Error
 *   - auth   : 'public' | 'user' | 'admin' | 'worker'
 *
 * 'user' means a signed-in browser session (cookie + X-WP-Nonce) — OR a personal access
 * token (Authorization: Bearer aq_…), but tokens reach only the Api::TOKEN_ROUTES
 * allow-list (src/Api.php): a route absent there is session-only by construction.
 *
 * To understand or extend the API, read ONLY this list — every endpoint is here.
 */
final class Rest {

	const NS = 'aq/v1';

	const ROUTES = [
		// ── ArtaCloud: the member's own public media shelf (Media.php) ────────
		[ 'GET',    'media',                          'Media::mine',      'user' ],
		[ 'GET',    'media/quota',                    'Media::quota',     'user' ],
		[ 'POST',   'media/buy',                      'Media::buy',       'user' ],
		[ 'POST',   'media/begin',                    'Media::begin',     'user' ],
		[ 'POST',   'media/(?P<id>[0-9]+)/part',      'Media::part',      'user' ],
		[ 'POST',   'media/(?P<id>[0-9]+)/commit',    'Media::commit',    'user' ],
		[ 'DELETE', 'media/(?P<id>[0-9]+)',           'Media::remove',    'user' ],
		[ 'GET',    'media/of/(?P<slug>[a-zA-Z0-9-]+)', 'Media::of_member', 'public' ],

		// ── Courses / LMS ─────────────────────────────────────────────────────
		[ 'GET',  'courses',                       'Courses::list',     'public' ],
		[ 'GET',  'courses/topics',                'Courses::topics',   'public' ],
			[ 'GET',  'courses/(?P<id>[0-9]+)',        'Courses::get',      'public' ],
		[ 'GET',  'courses/slug/(?P<slug>[a-z0-9-]+)', 'Courses::by_slug', 'public' ],
		[ 'GET',  'lessons/(?P<id>[0-9]+)',        'Courses::lesson',   'public' ],
		[ 'GET',  'courses/(?P<id>[0-9]+)/reviews', 'Courses::reviews', 'public' ],
		[ 'POST', 'courses/(?P<id>[0-9]+)/review',  'Courses::add_review', 'user' ],
		[ 'GET',  'courses/(?P<id>[0-9]+)/rankings', 'Learn::course_rankings', 'public' ],
		[ 'POST', 'courses',                       'Courses::create',   'user'   ],
		[ 'POST', 'courses/(?P<id>[0-9]+)/update',  'Courses::update',         'user' ], // owner (creator rung) or operator edits course meta
		[ 'POST', 'courses/(?P<id>[0-9]+)/lessons', 'Courses::update_lessons', 'user' ], // full content edit, ID-preserving sync
		[ 'POST', 'courses/(?P<id>[0-9]+)/delete',  'Courses::delete',         'user' ], // owner/operator; refused once another member has enrolled
		[ 'GET',  'studio/courses',                 'Courses::studio_list',    'user' ], // the creator Studio: own courses
		[ 'GET',  'studio/courses/(?P<id>[0-9]+)',  'Courses::studio_get',     'user' ], // …one course's full edit payload (incl. video ids + per-video rates + candidates)
		[ 'POST', 'courses/(?P<id>[0-9]+)/discover',  'Courses::course_discover',  'user' ], // owner/operator: find+track a candidate video now
		[ 'POST', 'courses/(?P<id>[0-9]+)/recompute', 'Courses::course_recompute', 'user' ], // owner/operator: re-derive rank from video rates
		[ 'POST', 'courses/(?P<id>[0-9]+)/refresh',   'Courses::course_refresh',   'user' ], // owner/operator: refresh this course's video rates now
		[ 'GET',  'courses/(?P<id>[0-9]+)/insights',  'Courses::insights',         'user' ], // owner/operator: course analytics (reach, discussion, economy, top questers)
		[ 'POST', 'courses/(?P<id>[0-9]+)/import-playlist', 'Courses::import_playlist', 'user' ], // owner/operator: add a whole YouTube playlist's videos at once
		// Studio operator CONSOLE (control + monitor of the discovery pipeline; each handler gates manage_options).
		[ 'GET',  'studio/console',                 'Console::dashboard', 'user' ], // operator snapshot: north-star, discovery, candidates, crons, reserve
		[ 'POST', 'studio/console/run',             'Console::run',       'user' ], // operator: run a pipeline job now
		[ 'POST', 'studio/console/config',          'Console::config',    'user' ], // operator: set the discovery levers (cap/per_run/cursor)
		[ 'POST', 'studio/console/candidate',       'Console::candidate', 'user' ], // operator: discard / force-settle one candidate
		[ 'GET',  'studio/artaai',                  'Artaai::dashboard',  'user' ], // operator: the platform-wide AI monitor (every relay/studio surface, liveness, queues, usage park)
		[ 'POST', 'studio/artaai/config',           'Artaai::config',     'user' ], // operator: pause/resume a surface, set the ArtaMod threshold, unpark, drain moderation now
		[ 'GET',  'studio/videos',                  'Console::videos',    'user' ], // operator: every tracked video + its state/metadata
		[ 'GET',  'studio/members',                 'Console::members',    'user' ], // operator: member directory (points/tier/courses/can-create)
		[ 'POST', 'studio/members/grant',           'Console::member_set', 'user' ], // operator: grant/revoke a member course-creation access
		[ 'GET',  'studio/houses',                  'Houses::list_rest',    'user' ], // operator: the 12 houses + their analysed fields + the pending add/remove queue
		[ 'POST', 'studio/houses/field',            'Houses::field_rest',   'user' ], // operator: queue a field to ADD (analyse) or REMOVE (purge)
		[ 'POST', 'studio/houses/unqueue',          'Houses::unqueue_rest', 'user' ], // operator: drop a still-pending queue item
		// Video view-count monitor: public history series (sparkline/chart) + an admin refresh trigger.
		[ 'GET',  'videos/(?P<vid>[A-Za-z0-9_-]+)/stats', 'YouTube::stats', 'public' ],
		[ 'GET',  'courses/(?P<id>[0-9]+)/stats',  'YouTube::course_stats', 'public' ],
		// Discussion-rate history: section replies posted per day (the historical view of the "X/hr"
		// comment-based trending metric) — powers the course-header graph.
		[ 'GET',  'courses/(?P<id>[0-9]+)/comment-stats', 'YouTube::course_comment_stats', 'public' ],
		[ 'GET',  'videos/(?P<vid>[A-Za-z0-9_-]+)/comment-stats', 'YouTube::video_comment_stats', 'public' ],
		[ 'POST', 'admin/refresh-videos',         'YouTube::admin_refresh', 'admin' ],

		// ── Learning state (discussion-first: watch → comment → upvote) ───────
		[ 'POST', 'enroll',                        'Learn::enroll',     'user'   ],
		[ 'POST', 'progress',                      'Learn::progress',   'user'   ],
		[ 'POST', 'section/comment',               'Learn::post_comment', 'user' ],
		[ 'GET',  'sections/(?P<lesson_id>[0-9]+)/thread', 'Learn::section_thread', 'public' ], // read = everyone; write gated in the handler
		[ 'POST', 'comment/vote',                  'Learn::vote_comment', 'user' ],
		[ 'GET',  'fearometer',                    'Fearometer::transparency', 'public' ], // the public methodology + live test-set stats
		[ 'GET',  'fearometer/dataset',            'Fearometer::dataset', 'public' ],       // the whole labelled test set, verbatim
		[ 'POST', 'fearometer/appeal',             'Fearometer::appeal',  'user' ],          // one re-adjudication per flagged reply, by its author
		[ 'GET',  'dashboard',                     'Learn::dashboard',  'user'   ],

		// ── Economy ───────────────────────────────────────────────────────────
		[ 'GET',  'wallet',                        'Economy::wallet',   'user'   ],
		[ 'GET',  'leaderboard',                   'Economy::leaderboard', 'public' ],
		[ 'GET',  'reserve',                       'Economy::reserve',  'public' ],
		[ 'GET',  'coins/price',                   'Economy::price',    'public' ],
		[ 'POST', 'coins/buy',                     'Economy::buy',      'user'   ],
		[ 'POST', 'coins/sell',                    'Economy::sell',     'user'   ],
		[ 'GET',  'coins/payout/status',           'Economy::payout_status',  'user' ],
		[ 'POST', 'coins/payout/connect',          'Economy::payout_connect', 'user' ],

		// ── Social ────────────────────────────────────────────────────────────
		[ 'GET',  'threads',                       'Social::threads',   'public' ],
		[ 'GET',  'threads/(?P<id>[0-9]+)',        'Social::thread',    'public' ],
		[ 'POST', 'threads',                       'Social::post_thread',  'user' ],
		[ 'POST', 'threads/(?P<id>[0-9]+)/update', 'Social::thread_update', 'user' ],
		[ 'POST', 'threads/(?P<id>[0-9]+)/delete', 'Social::thread_delete', 'user' ],
		[ 'POST', 'threads/(?P<id>[0-9]+)/comments', 'Social::comment', 'user'   ],
		[ 'POST', 'comments/(?P<id>[0-9]+)/update', 'Social::comment_update', 'user' ],
		[ 'POST', 'comments/(?P<id>[0-9]+)/delete', 'Social::comment_delete', 'user' ],
		[ 'POST', 'vote',                          'Social::vote',      'user'   ],
		[ 'GET',  'votes/(?P<type>[a-z]+)/(?P<id>[0-9]+)', 'Social::voters', 'public' ], // transparency: who up/down-voted a thread/comment, earliest first
		[ 'POST', 'follow',                        'Social::follow',    'user'   ],
		[ 'GET',  'suggest/follow',                'Social::suggest_follow', 'public' ], // "Who to follow" rail: top notebook authors by hearts (unpersonalised, CDN-safe)
		[ 'GET',  'feed',                          'Social::feed',      'user'   ], // home-page activity of the people you follow
		[ 'GET',  'profile',                       'Social::profile',   'public' ],
		[ 'GET',  'profile/follows',               'Social::follows',   'public' ], // the lists behind a profile's follower/following counts
		[ 'GET',  'notifications',                 'Notify::list',      'user'   ],
		[ 'POST', 'notifications/read',            'Notify::mark_read', 'user'   ],
		[ 'GET',  'typology/targets',              'Social::typology_targets', 'public' ],

		// ── Competitions (Kaggle-style predictive-modelling contests) ─────────
		[ 'GET',  'competitions',                  'Competitions::list_all',    'public' ], // every competition + n_teams + best_score
		[ 'GET',  'competition',                   'Competitions::detail',      'public' ], // ?slug= : overview + data-download URLs + evaluation
		[ 'GET',  'competition/leaderboard',       'Competitions::leaderboard', 'public' ], // ?slug= : best submission per member, ranked (+ phase telemetry on phase-r2 boards)
		[ 'GET',  'competition/results',           'Competitions::results',     'public' ], // ?slug=&trend= : the leader's predicted-vs-raw train/test series for one topic (phase datasets)
		[ 'POST', 'competition/create',            'Competitions::create',      'user'   ], // open a competition (owned by the caller)
		[ 'POST', 'competition/submit',            'Competitions::submit',      'user'   ], // ?slug= : score predictions vs the hidden holdout
		[ 'GET',  'competition/my-submissions',    'Competitions::my_submissions', 'user' ], // ?slug= : the caller's own submission history (Submit tab table)
		[ 'GET',  'competition/solutions',         'Competitions::solutions',      'public' ], // ?slug= : PUBLIC solution reviews (code + method + reviewer reports)
		[ 'POST', 'competition/verify',            'Competitions::request_review', 'user' ], // ?slug= : submit a SOLUTION (code + method) for adversarial review — required to win the prize
		[ 'POST', 'relay/compete/poll',            'Competitions::review_poll',     'worker' ], // ArtaCompete daemon claims a queued solution review
		[ 'POST', 'relay/compete/complete',        'Competitions::review_complete', 'worker' ], // …returns the verdict (verify|revise|reject) after running the code
		[ 'POST', 'relay/compete/release',         'Competitions::review_release',  'worker' ], // …hands a claimed review back on shutdown
		[ 'POST', 'relay/chant/poll',              'Competitions::chant_poll',      'worker' ], // chant relay claims an unmeasured chant entry (12 law sentences)
		[ 'POST', 'relay/chant/complete',          'Competitions::chant_complete',  'worker' ], // …returns total spoken seconds + the public per-language table
		[ 'POST', 'relay/chant/audio',             'Competitions::chant_audio',     'worker' ], // …publishes one language's full chant recording (playable in Solutions)
		[ 'POST', 'relay/chant/release',           'Competitions::chant_release',   'worker' ], // …hands a claimed entry back on shutdown

		[ 'GET',  'models',                        'Competitions::models_list', 'public' ], // the Library's Model shelf: every verified solution, newest first

		// ── Creative Challenges (the unified challenge frame; member challenges 2026-07-11) ───
		// Challenges (social-feed pivot 2026-07-13): one pool per kind per month; PUBLISHING a post
		// pays the size fee into the pool and is the entry; hearts podium 50/30/20 at month close.
		// Members earn ONLY here; the Foundation earns ONLY from ArtaDev iterations.
		[ 'GET',  'challenges',                    'Notebook::challenges',     'public' ], // member-founded challenges (?id= for one board)
		[ 'GET',  'challenges/options',            'Notebook::ch_options',     'public' ], // topics + the next full moons + kinds
		[ 'POST', 'challenges',                    'Notebook::ch_create',      'user'   ], // found one with your own notebook (pays the fee)
		[ 'POST', 'challenges/(?P<id>[0-9]+)/enter', 'Notebook::ch_enter',     'user'   ], // pay the fee, enter your own published work
		[ 'POST', 'work/heart',                    'Challenges::heart',        'user'   ], // heart/un-heart a published Library work (val 1|0; never your own)
		[ 'GET',  'work/hearts',                   'Challenges::work_hearts',  'public' ], // ?kind=&id= : a work's heart count + the caller's own heart
		[ 'GET',  'challenge-certs',               'Challenges::certificates', 'public' ], // ?user= : derived participation certificates (+ podium medals)
		[ 'GET',  'shelf',                         'Challenges::shelf',        'user'   ], // the caller's shelf meter (published works vs tier quota)

		// ── Unified search (the Explore hub: notebooks + discussions + grants) ──
		[ 'GET',  'search',                        'Search::all',       'public' ],

		// ── Bursary (Outreach-funded: covers the course entry fee for eligible groups) ──
		[ 'GET',  'bursary',                       'Funds::bursary_list',  'user' ],
		[ 'GET',  'bursary/status',                'Funds::bursary_status', 'user' ], // is the fund able to cover a grant?
		[ 'POST', 'bursary/apply',                 'Funds::bursary_apply', 'user' ],

		// ── Developer API (src/Api.php; docs at /developers). Personal access tokens sign REST
		//    requests in as their owner but reach ONLY the Api::TOKEN_ROUTES allow-list; token
		//    management itself is session-only, so a token can never mint tokens. Publication
		//    stays behind the dual email gate — no token path can publish or mint a DOI. ──
		[ 'GET',  'api/docs',                      'Api::docs',          'public' ], // the whole developer contract, machine-readable
		[ 'GET',  'api/openapi',                   'Api::openapi',       'public' ], // OpenAPI 3.1, generated from this very table
		[ 'GET',  'api/ping',                      'Api::ping',          'user'   ], // credential sanity check (token or session)
		[ 'GET',  'api/tokens',                    'Api::tokens_list',   'user'   ], // own tokens, metadata only
		[ 'POST', 'api/tokens',                    'Api::token_create',  'user'   ], // mint (raw shown once; hash stored)
		[ 'POST', 'api/tokens/(?P<id>[0-9]+)/revoke', 'Api::token_revoke', 'user' ], // immediate, idempotent
		// Passkeys (WebAuthn) — the cryptographic publication co-signature (session-only, all of it:
		// a delegated credential must never be able to plant or remove a signing key).
		[ 'POST', 'passkey/register/options',      'Passkey::register_options', 'user' ],
		[ 'POST', 'passkey/register',              'Passkey::register',         'user' ],
		[ 'GET',  'passkey',                       'Passkey::list_keys',        'user' ],
		[ 'POST', 'passkey/(?P<id>[0-9]+)/revoke', 'Passkey::revoke',           'user' ],

		// ── Auth (passwordless) ───────────────────────────────────────────────
		[ 'POST', 'auth/request-code',             'Auth::request_code', 'public' ],
		[ 'POST', 'auth/verify-code',              'Auth::verify_code',  'public' ],
		[ 'POST', 'auth/google',                   'Auth::google',       'public' ],
		[ 'GET',  'me',                            'Auth::me',           'public' ],
		[ 'POST', 'profile-update',                'Auth::profile_update', 'user' ],
		[ 'GET',  'username/check',                'Auth::username_check', 'public' ], // live availability for the settings form

		// ── Account security (active sign-in sessions) ────────────────────────
		[ 'GET',  'me/sessions',                   'Sessions::list',          'user' ],
		[ 'POST', 'me/sessions/revoke',            'Sessions::revoke',        'user' ],
		[ 'POST', 'me/sessions/revoke-others',     'Sessions::revoke_others', 'user' ],
		[ 'POST', 'auth/logout',                   'Sessions::logout',        'user' ],
		// Delete account — irreversible profile purge, gated by an emailed re-auth code + a typed
		// confirmation (Account.php). request = email the code; confirm = verify code + phrase, then purge.
		[ 'POST', 'me/delete/request',             'Account::delete_request', 'user' ],
		[ 'POST', 'me/delete/confirm',             'Account::delete_confirm', 'user' ],

		// ── Identity + verification (blue check) ──────────────────────────────
		[ 'GET',  'verify/status',                 'Verify::status',          'user' ],
		[ 'POST', 'identity',                      'Verify::set_identity',    'user' ], // name + birthday (required to post)
		[ 'POST', 'identity/birthtime',            'Verify::set_birthtime',   'user' ], // fine-tune birth time (places the long-term goal)
		[ 'POST', 'profile/photo',                 'Verify::set_photo',       'user' ], // change avatar only — no ID-verify, free
		[ 'POST', 'profile/palm',                  'Verify::set_palm_photo',  'user' ], // palm "back photo" — opt-in self-verify, free
		[ 'POST', 'verify/identity',               'Verify::verify_identity', 'user' ], // ID + selfie → Claude (free)

		// ── Offline / "take it with you" (selective full-platform download) ───
		[ 'GET',  'offline/manifest',              'Offline::manifest',     'public' ], // Download Center catalogue
		[ 'GET',  'offline/course/(?P<id>[0-9]+)', 'Offline::course',       'public' ], // self-contained course bundle
		[ 'GET',  'offline/langpack/(?P<lang>[a-zA-Z-]+)', 'Offline::langpack', 'public' ], // a language's translation pack
		[ 'GET',  'offline/db/(?P<table>[A-Za-z0-9_]+)',   'Offline::db_table', 'public' ], // bulk public-DB table export
		[ 'GET',  'offline/media/(?P<lesson_id>[0-9]+)',   'Offline::media',    'public' ], // downloadable qualities + caption tracks
		[ 'GET',  'offline/media/(?P<lesson_id>[0-9]+)/stream', 'Offline::media_stream', 'public' ], // Range-aware byte proxy
		[ 'GET',  'offline/captions/(?P<lesson_id>[0-9]+)',     'Offline::captions',     'public' ], // one caption track as WebVTT
		[ 'GET',  'offline/downloader',                        'Offline::downloader',   'public' ], // self-installing video-downloader script (per OS)
		[ 'GET',  'offline/ytdlp',                            'Offline::ytdlp',        'public' ], // mirror the yt-dlp binary (works where GitHub is blocked)

		// ── i18n (content-addressed translation mesh) ─────────────────────────
		[ 'GET',  'i18n/config',                   'I18n::config',      'public' ],
		[ 'POST', 'i18n/resolve',                  'I18n::resolve',     'public' ],
		[ 'POST', 'i18n/translate',                'I18n::translate',   'public' ],
		[ 'POST', 'i18n/save',                     'I18n::save',        'public' ],
		// ArtaTranslate — the mesh's slow second pass (src/Translate.php): every Google edge row is
		// re-translated by a SOTA open model + adversarial Claude review rounds via the translate relay
		// (tools/ticket-agent/translate-relay.mjs), then served in place of the edge translation.
		[ 'GET',  'translate/status',              'Translate::status',     'public' ], // live queue + recent adversarial upgrades (transparency)
		[ 'GET',  'translate/rounds',              'Translate::rounds_for', 'public' ], // ?hash=&lang= → the full round-by-round record for one string
		[ 'POST', 'relay/translate/poll',          'Translate::poll',       'worker' ], // relay claims one single-language batch of pending rows
		[ 'POST', 'relay/translate/complete',      'Translate::complete',   'worker' ], // …returns the adversarially-improved translations + rounds

		// ── Funds / transparency ──────────────────────────────────────────────
		[ 'GET',  'foundation/finances',           'Funds::finances',   'public' ],
		// Donations are charged through the cart checkout (course-checkout → Stripe → fulfil_session); there
		// is no direct /donate route, so no fund row or donate points can be written without captured fiat.

		// ── ArtaCredits: a donor pays a stranger's challenge entry fee (Credits) ──
		// Every write here is reached from the captured-payment fulfilment or from ch_enter — there is
		// deliberately NO route that creates a gift or spends one directly.
		[ 'GET',  'credits/options',              'Credits::options',      'public' ], // picker vocabulary — carries NO member counts
		[ 'GET',  'credits/reach',                'Credits::reach',        'public' ], // how many members one slice reaches, floored to REACH_MIN
		[ 'GET',  'credits/mine',                 'Credits::mine',         'user'   ], // the donor's own gifts and what became of each
		[ 'POST', 'credits/widen',               'Credits::widen',        'user'   ], // release an unspent gift to the general slice (donor-only)
		[ 'POST', 'identity/gender',              'Verify::set_gender',    'user'   ], // opt-in, revocable ('clear'), never inferred

		// ── Certificate of Participation (every challenge entrant holds one) ──
		[ 'GET',  'participation',                'Credits::certificate',  'user'   ], // ?challenge= : the holder's own
		[ 'GET',  'participation/mine',           'Credits::mine_certs',   'user'   ], // every certificate this member holds
		[ 'GET',  'participation/verify',         'Credits::cert_verify',  'public' ], // ?p=&u=&k= : anyone can confirm a printed one

		// ── Topic (typology-system) registry — DB-backed, authored + editable + sponsorable (Typology) ──
		[ 'GET',  'topics',                        'Typology::all',          'public' ], // whole registry, SPA shape
		[ 'GET',  'sponsor/topics',               'Typology::sponsorable',  'public' ], // topics with a live course → sponsorable (Donate picker)
		[ 'GET',  'topics/(?P<key>[a-z0-9-]+)',    'Typology::get_one',      'public' ], // one system by key
		[ 'POST', 'topics',                        'Typology::create',       'user'   ], // author a new topic (creator-gated)
		[ 'POST', 'topics/(?P<key>[a-z0-9-]+)/update', 'Typology::update',    'user'   ], // edit ANY field
		[ 'POST', 'topics/(?P<key>[a-z0-9-]+)/delete', 'Typology::delete',    'user'   ], // soft-delete
		[ 'GET',  'studio/topics',                 'Typology::studio_list',  'user'   ], // editable list
		[ 'GET',  'studio/topics/(?P<key>[a-z0-9-]+)', 'Typology::studio_get', 'user'  ], // full raw topic for editing
		// The editable DISCIPLINE registry (Studio "Disciplines" mode) — the 12 houses are fixed, disciplines CRUD.
		[ 'GET',  'disciplines',                   'Topics::list_disciplines', 'public' ], // houses + disciplines registry
		[ 'GET',  'cycles',                        'Topics::cycles_rest',      'public' ], // celestial-cycle explanatory ranking (analysis)
		[ 'GET',  'house-reps',                   'Topics::house_reps_rest',  'public' ], // each house's representative discipline (max score) — light, for Home
		[ 'GET',  'labels',                        'Topics::list_labels',      'public' ], // effective field + style display labels
		[ 'POST', 'studio/labels',                 'Topics::save_labels_rest', 'user'   ], // operator: edit the 12 field + 12 style labels
		[ 'POST', 'studio/disciplines',            'Topics::save_disc_rest',   'user'   ], // create/update (operator-gated inside)
		[ 'POST', 'studio/disciplines/(?P<key>[a-z0-9-]+)/delete', 'Topics::delete_disc_rest', 'user' ], // remove a discipline
		// Google-Trends demand scores (per-topic score in Studio; per-cycle series on /why).
		[ 'GET',  'trends',                        'Trends::get_rest',         'public' ], // ?ref=topic:<key>|cycle:<slug> → series + score
		[ 'POST', 'studio/trends/import',          'Trends::import_rest',      'user'   ], // operator: bulk-import fetched scores

		// ── The Twelve Seasons — the platform calendar (Seasons.php; the LUNAR competition calendar is Season.php) ──
		[ 'GET',  'seasons',                       'Seasons::wheel_rest',      'public' ], // the whole wheel + the current season (+ the caller's, when signed in)
		[ 'POST', 'me/season',                     'Seasons::subscribe_rest',  'user'   ], // subscribe to exactly ONE season (the member's topic family)

		// ── Long-tail features (Extra) ────────────────────────────────────────
		[ 'GET',  'typologies',                    'Extra::typologies_get',  'user' ],
		[ 'POST', 'typologies',                    'Extra::typologies_save', 'user' ],
		[ 'GET',  'typology/endorsements',         'Extra::endorsements_mine', 'user' ], // viewer's endorsements of one member
		[ 'POST', 'typology/endorse',              'Extra::endorse',         'user' ],
		[ 'GET',  'outreach',                      'Extra::outreach',        'public' ],
		[ 'POST', 'outreach/claim',                'Extra::outreach_claim',  'user' ],
		[ 'POST', 'outreach/submit',               'Extra::outreach_submit', 'user' ],
		[ 'POST', 'outreach/release',              'Extra::outreach_release','user' ],
		// Grants as authored, Studio-editable content (operator/author-gated, like courses/topics)
		[ 'POST', 'grants',                        'Extra::grant_create',    'user' ],
		[ 'POST', 'grants/(?P<id>[0-9]+)/update',  'Extra::grant_update',    'user' ],
		[ 'POST', 'grants/(?P<id>[0-9]+)/delete',  'Extra::grant_delete',    'user' ],
		[ 'GET',  'studio/grants',                 'Extra::grant_studio_list','user' ],
		[ 'GET',  'studio/grants/(?P<id>[0-9]+)',  'Extra::grant_studio_get','user' ],
		[ 'POST', 'bug-finding',                   'Extra::bug_finding',     'user' ],

		// ── Contributions (Claude-triaged tickets) ────────────────────────────
		[ 'POST', 'tickets',                       'Tickets::create',        'user'   ],
		[ 'POST', 'tickets/upload',                'Tickets::upload',        'user'   ],
		[ 'GET',  'tickets',                       'Tickets::list',          'public' ],
		[ 'GET',  'tickets/(?P<id>[0-9]+)',        'Tickets::get',           'public' ],
		[ 'POST', 'tickets/(?P<id>[0-9]+)/message', 'Tickets::post_message', 'user'   ],
		[ 'POST', 'tickets/(?P<id>[0-9]+)/resolve', 'Tickets::resolve',      'user'   ],
		[ 'POST', 'tickets/(?P<id>[0-9]+)/reopen',  'Tickets::reopen',       'user'   ],
		// ArtaBot — the global AI assistant. METERED: a turn is priced when it replies, from what it
		// measurably used, and the price is the same for every member including the founder (src/Usage.php).
		[ 'GET',  'artabot',                       'Assistant::history',     'user'   ],
		// Effort tiers are CEILINGS, not prices: same model (Claude Opus 5) throughout; what changes is
		// thinking depth, reply length, and how much CPU and RAM the sandbox gets. Public so the SPA can
		// show what compute costs per minute — the AI part is only knowable once the turn has run.
		[ 'GET',  'artabot/tiers',                 'Assistant::tiers',       'user'   ], // the tier menu + this member's balance and recent metered lines
		[ 'POST', 'artabot',                       'Assistant::ask',         'user'   ],
		// The in-flight answer as it is written (long-poll, ~20s hold — see Assistant::live). Public
		// because signed-out visitors chat too; the buffer key is derived from the SESSION, never from
		// input, so a caller can only ever read their own stream.
		[ 'GET',  'artabot/live',                  'Assistant::live',        'public' ],
		// PARALLEL CONVERSATIONS. A member may hold several at once and run them at the same time; each
		// has its own transcript, its own tier (so its own CPU and RAM), its own live stream and its
		// own bill (src/Assistant.php, src/Usage.php).
		[ 'GET',  'artabot/sessions',              'Assistant::sessions',      'user'   ],
		[ 'POST', 'artabot/session',               'Assistant::open_session',  'user'   ],
		[ 'POST', 'artabot/session/close',         'Assistant::close_session', 'user'   ],
		[ 'POST', 'artabot/clear',                 'Assistant::clear',       'user'   ],
		// Subscription relay — the laptop daemon (tools/ticket-agent/artabot-relay.mjs) answers
		// ArtaBot turns on the operator's Claude Max subscription when the laptop is awake; prod
		// falls back to the API otherwise (src/Relay.php). Same shared secret as the worker.
		[ 'POST', 'relay/poll',                    'Relay::poll',            'worker' ],
		[ 'POST', 'relay/complete',                'Relay::complete',        'worker' ],
		// The completion path for the fully-powered tools container, which deliberately holds NO shared
		// secret — a member has a root shell in there and could read one. It authenticates with a
		// signature over ONE job id instead (Relay::verify_token). Public auth because the signature IS
		// the authentication; the handler refuses anything that does not carry a valid one.
		[ 'POST', 'relay/job/complete',            'Relay::job_complete',    'public' ],
		[ 'POST', 'relay/stream',                  'Relay::stream_chunk',    'worker' ],
		// METERED USAGE — what compute actually cost, billed only once a turn has replied or a session
		// has ended (src/Usage.php). The tier menu is public so the cost of a mode can be read before
		// it is used; the lines and invoices are the member's own.
		[ 'GET',  'usage',                         'Usage::mine',            'user'   ],
		[ 'GET',  'invoices',                      'Usage::invoices',        'user'   ], // …and streams the answer as it writes it (live deltas → a transient, no row writes)
		// MEMBER SHELLS — every member has their own unix account on the relay VM, reachable as
		// `ssh <handle>@shell.artaquest.com`, landing in the SAME sandbox ArtaBot's tool turns run in
		// (src/Shell.php + tools/ticket-agent/artabot-shell.mjs). Only PUBLIC keys are stored, which is
		// forced by the design of this platform rather than merely chosen: the whole database is
		// published at /data/, so a private key could never live in it.
		[ 'GET',  'shell',                         'Shell::mine',            'user'   ],
		[ 'POST', 'shell/keys',                    'Shell::add_key',         'user'   ],
		[ 'POST', 'shell/keys/remove',             'Shell::remove_key',      'user'   ],
		[ 'POST', 'relay/shell/roster',            'Shell::roster',          'worker' ], // the VM pulls accounts + keys every few minutes
		// ArtaScience — the fully automated AI review pipeline (src/Science.php). Submissions MUST ship
		// open data + code; the ArtaScience daemon (tools/ticket-agent/artascience-relay.mjs) runs the
		// code, checks reproducibility at --effort max, and returns a multi-round verdict. Public record.
		[ 'POST', 'research/submit',               'Science::submit',        'user' ],
		[ 'POST', 'research/upload',               'Science::upload',        'user' ],
		[ 'POST', 'research/dataset',              'Science::dataset_create', 'user' ],  // submission prerequisite #1: register + validate the open dataset
		[ 'POST', 'research/model',                'Science::model_create',   'user' ],  // submission prerequisite #2: register + validate the model bundle (standard reproduction contract)
		[ 'GET',  'research/artifacts',            'Science::artifacts',      'public' ],// registered datasets/models (transparency + the submit form pickers)
		[ 'GET',  'research/journals',             'Science::journals',      'public' ], // the multi-journal hub registry + counts
		[ 'GET',  'research/submissions',          'Science::list',          'public' ],
		[ 'GET',  'research/submissions/(?P<id>[0-9]+)', 'Science::get',     'public' ],
		[ 'POST', 'research/submissions/(?P<id>[0-9]+)/revise', 'Science::revise', 'user' ],
		[ 'POST', 'research/submissions/(?P<id>[0-9]+)/withdraw', 'Science::withdraw', 'user' ],
		[ 'GET',  'research/review-status',        'Science::status',        'public' ],
		[ 'GET',  'research/artefact',             'Science::artefact',      'public' ], // same-origin text proxy for the data/code viewers
		[ 'GET',  'scholar/trending',             'Extra::scholar_trending', 'public' ], // the feed's research rail: most-cited OA papers (PDF required) of the last 30 days + the topics they cluster into, all fields, via OpenAlex (6h cache)
		[ 'GET',  'social/trending',              'Extra::social_trending', 'public' ], // educational-social crawl: trending EDUCATIONAL content from Reddit(OAuth)/YouTube(Data API)/Instagram(Graph), our own Δ-rate ranking; hourly cron aq_social_crawl, last-good ≤7d, each source dormant until its Vault secret exists
		[ 'GET',  'market/prices',                 'Extra::market_prices',   'public' ], // NOT a feed card any more (the research rail replaced it 2026-07-22) — kept because the notebook relay serves this payload to every notebook as data/market-prices.json
		[ 'GET',  'commodities',                   'Extra::commodities',     'public' ], // DAILY oil/gas/coal/wheat/corn price in ArtaCoin per kWh over the last 56 days (Yahoo Finance → ₳ via that day's gold); daily cron aq_commodities, last-good ≤7d
		// ArtaNews (operator 2026-07-25): automated objective-data journalism. Every story is a
		// threshold crossing in a public instrument feed (satellite thermal anomaly · seismic
		// magnitude · a price move past 4σ), reported with measurement and inference kept separate
		// and full provenance so the claim is reproducible. See src/News.php.
		[ 'GET',  'news',                          'News::feed',             'public' ],
		[ 'GET',  'news/(?P<slug>[a-z0-9-]+)',     'News::article',          'public' ],
		[ 'GET',  'market/geo',                    'Extra::market_geo',      'public' ], // the viewer's country + currency from their IP (client cache-busts; ip-api via Sessions::geo)
		[ 'GET',  'climate/daily',                 'Extra::climate_daily',   'public' ], // data-shelf rail: NCEP/NCAR R1 daily mean 2m air temperature 1948→, global + 5 latitude bands, raw CSV (CC BY 4.0)
		[ 'GET',  'citations/quarterly',           'Extra::citations_quarterly', 'public' ], // data-shelf rail: citations per subfield per quarter, 1500s→2026 (OpenAlex snapshot 2026-06-26, CC0), raw CSV
		[ 'GET',  'citations/yearly',              'Extra::citations_yearly',    'public' ], // data-shelf rail: the quarterly rail summed to YEARS, 1000→2026 (~5MB companion), raw CSV
		[ 'POST', 'relay/review/poll',             'Science::review_poll',     'worker' ],
		[ 'POST', 'relay/review/publish',          'Science::review_publish',  'worker' ],
		[ 'POST', 'relay/review/complete',         'Science::review_complete', 'worker' ],
		[ 'POST', 'relay/review/reconstruct',      'Science::review_reconstruct', 'worker' ], // refresh an ACCEPTED article's web edition (body_html/charts only)
		[ 'POST', 'relay/review/release',          'Science::release',         'worker' ],

		// ── ArtaRPS — the competitive ring game from the Aspects paper (src/Games.php): three
		//    modality rings of four tools, chess.com-style live matches, lobby, Elo board, chat. ──
		[ 'GET',  'games/rps',                              'Games::board',  'public' ],
		[ 'GET',  'games/rps/match/(?P<id>[0-9]+)',         'Games::state',  'public' ],
		[ 'POST', 'games/rps/match',                        'Games::create', 'user' ],
		[ 'POST', 'games/rps/match/(?P<id>[0-9]+)/join',    'Games::join',   'user' ],
		[ 'POST', 'games/rps/match/(?P<id>[0-9]+)/move',    'Games::move',   'user' ],
		[ 'POST', 'games/rps/match/(?P<id>[0-9]+)/chat',    'Games::chat',   'user' ],
		[ 'POST', 'games/rps/match/(?P<id>[0-9]+)/claim',   'Games::claim',  'user' ],
		[ 'POST', 'games/rps/match/(?P<id>[0-9]+)/resign',  'Games::resign', 'user' ],

		// ── ArtaDemo — peer review for ANIMATIONS, run like ArtaScience (operator 2026-07-13): each
		//    submission is the animation SOURCE, reviewed + scored by SEVERAL INDEPENDENT agents per
		//    round (blind); ONLY after the code is accepted does ArtaMotion render + publish with DOI. ──
		[ 'GET',  'demo/submissions',              'Demo::list_all', 'public' ],
		[ 'GET',  'demo/submissions/(?P<id>[0-9]+)', 'Demo::get',    'public' ],
		[ 'GET',  'demo/status',                   'Demo::status',   'public' ],
		[ 'POST', 'demo/submit',                   'Demo::submit',   'user' ],
		[ 'POST', 'demo/submissions/(?P<id>[0-9]+)/revise', 'Demo::revise', 'user' ],
		[ 'POST', 'relay/demo/poll',               'Demo::poll',     'worker' ], // relay claims a review job (or, once accepted, the render job)
		[ 'POST', 'relay/demo/complete',           'Demo::complete', 'worker' ], // …returns the N independent verdicts; majority decides, median scores
		[ 'POST', 'relay/demo/publish',            'Demo::publish',  'worker' ], // accept-gated: mint the DOI + create/update the ArtaMotion row
		[ 'POST', 'relay/demo/release',            'Demo::release',  'worker' ],

		// ── ArtaReview — the UNIFIED public adversarial-review ledger (books, films, narrations;
		//    Science/Sound/Illustration keep their native round tables). Publish gates read it. ──
		[ 'GET',  'reviews',                       'Reviews::list_for',  'public' ], // ?target_type=&target_id= → every public round
		[ 'POST', 'relay/reviews',                 'Reviews::record',    'worker' ], // review pipelines append immutable rounds
		[ 'POST', 'relay/bookreview/poll',         'Reviews::book_poll',     'worker' ], // ArtaReview relay claims a queued book + its chapters
		[ 'POST', 'relay/bookreview/complete',     'Reviews::book_complete', 'worker' ], // …reports the round outcome (reviewed | revise)

		// ── The studio family, unified ── one public pulse for EVERY studio kind (the Library hub
		//    renders the same analytics strip on every tab; per-kind detail stays on the studio pages).
		[ 'GET',  'studio/pulse',                  'Extra::studio_pulse',    'public' ],

		// ── ArtaPublishing — AI-edited, author-owned books (brief + private inspiration → original book) ──
		[ 'POST', 'library/documents',                       'Library::create',        'user'   ], // start a book project (brief; optional first source; ?generate=1)
		[ 'GET',  'library/documents',                       'Library::list',          'public' ], // the /library hub: published books
		[ 'GET',  'library/mine',                            'Library::mine',          'user'   ], // the author's own shelf (drafts + published)
		[ 'GET',  'library/documents/(?P<id>[0-9]+)',        'Library::get',           'public' ], // reader (drafts owner-only)
		[ 'POST', 'library/documents/(?P<id>[0-9]+)/sources','Library::add_source',    'user'   ], // attach an inspiration PDF (born-digital only)
		[ 'POST', 'library/documents/(?P<id>[0-9]+)/sources/(?P<sid>[0-9]+)/delete', 'Library::remove_source', 'user' ],
		[ 'POST', 'library/documents/(?P<id>[0-9]+)/generate','Library::generate',     'user'   ], // (re)queue the AI write
		[ 'POST', 'library/documents/(?P<id>[0-9]+)/review', 'Library::request_review','user'   ], // submit to the ArtaReview relay (chapter-by-chapter)
		[ 'POST', 'library/documents/(?P<id>[0-9]+)/publish','Library::publish_book',  'user'   ], // publish (charges ArtaCoins by page count)
		[ 'POST', 'library/documents/(?P<id>[0-9]+)/delete', 'Library::remove',        'user'   ], // owner/operator takedown
		[ 'POST', 'relay/doc/poll',                          'Library::doc_poll',      'worker' ], // ArtaPublishing daemon claims a queued book
		[ 'POST', 'relay/doc/beat',                          'Library::doc_beat',      'worker' ], // …heartbeats between parts of a long write (keeps the 1h reclaim off)
		[ 'POST', 'relay/doc/complete',                      'Library::doc_complete',  'worker' ], // …returns the written book HTML
		// ArtaVoice — narration studio: members record read-along audiobooks (any language) of published works.
		[ 'POST', 'narrations',                              'Narrate::create',   'user'   ], // commission + publish a narration (costs coins by length)
		[ 'GET',  'narrations',                              'Narrate::list_for', 'public' ], // ?target_type=&target_id= → voices made for a work (reader picker)
		[ 'GET',  'narrations/mine',                         'Narrate::mine',     'user'   ], // the studio: my narrations
		[ 'GET',  'narrations/(?P<id>[0-9]+)',               'Narrate::get',      'public' ],
		[ 'POST', 'narrations/(?P<id>[0-9]+)/delete',        'Narrate::remove',   'user'   ],
		[ 'POST', 'relay/narrate/poll',                      'Narrate::poll',      'worker' ], // ArtaVoice daemon claims a queued narration
		[ 'POST', 'relay/narrate/heartbeat',                 'Narrate::heartbeat', 'worker' ], // …keeps a long job claimed while it renders
		[ 'POST', 'relay/narrate/complete',                  'Narrate::complete',  'worker' ], // …returns the recorded mp3 + per-block timings

		// ── ArtaShop — worldwide hard-copy shop (printed books, games, prints, merch; PTT tariff shipping, coin-paid) ──
		[ 'GET',  'shop/products',                           'Shop::list',          'public' ], // the /shop catalogue (?kind=book|game|print|merch)
		[ 'GET',  'shop/products/(?P<id>[0-9]+)',            'Shop::get',           'public' ], // one product (+ representative shipping figure)
		[ 'GET',  'shop/quote',                              'Shop::quote_rest',    'public' ], // live PTT shipping fee for a basket (?country=&items=id:qty,&insured=)
		[ 'POST', 'shop/order',                              'Shop::order',         'user'   ], // place an order (debits coins; address kept in the private ship table)
		[ 'GET',  'shop/orders',                             'Shop::my_orders',     'user'   ], // the member's own orders + tracking
		[ 'GET',  'studio/shop',                             'Shop::studio_list',   'user'   ], // operator: full catalogue + recent orders (gated inside)
		[ 'POST', 'studio/shop/product',                     'Shop::save_product',  'user'   ], // operator: create/update/remove a product
		[ 'POST', 'studio/shop/order',                       'Shop::update_order',  'user'   ], // operator: mark shipped/delivered (+tracking) or cancel+refund

		// ── ArtaFilm — AI text-to-video studio (brief → LTX-Video scene clips stitched to a film) ──
		[ 'POST', 'films',                                   'Film::create',        'user'   ],
		[ 'GET',  'films',                                   'Film::list',          'public' ],
		[ 'GET',  'films/mine',                              'Film::mine',          'user'   ],
		[ 'GET',  'films/(?P<id>[0-9]+)',                    'Film::get',           'public' ],
		[ 'POST', 'films/(?P<id>[0-9]+)/generate',           'Film::generate',      'user'   ],
		[ 'POST', 'films/(?P<id>[0-9]+)/publish',            'Film::publish_film',  'user'   ],
		[ 'POST', 'films/(?P<id>[0-9]+)/delete',             'Film::remove',        'user'   ],
		[ 'POST', 'relay/film/poll',                         'Film::film_poll',      'worker' ], // ArtaFilm daemon claims a queued film
		[ 'POST', 'relay/film/heartbeat',                    'Film::film_heartbeat', 'worker' ], // …keeps a long render claimed
		[ 'POST', 'relay/film/complete',                     'Film::film_complete',  'worker' ], // …returns the stitched mp4 + poster

		// ── ArtaIllustration — AI illustration studio (brief → SOTA image → adversarial improvement rounds) ──
		[ 'POST', 'illustrations',                           'Illustration::create',      'user'   ],
		[ 'GET',  'illustrations',                           'Illustration::list',        'public' ], // ?book=<id> → a book's published plates/cover
		[ 'GET',  'illustrations/mine',                      'Illustration::mine',        'user'   ],
		[ 'GET',  'illustrations/(?P<id>[0-9]+)',            'Illustration::get',         'public' ], // includes the public improvement-round history
		[ 'POST', 'illustrations/(?P<id>[0-9]+)/generate',   'Illustration::generate',    'user'   ],
		[ 'POST', 'illustrations/(?P<id>[0-9]+)/publish',    'Illustration::publish_art', 'user'   ], // a cover also becomes its book's thumbnail
		[ 'POST', 'illustrations/(?P<id>[0-9]+)/delete',     'Illustration::remove',      'user'   ],
		[ 'POST', 'relay/illust/poll',                       'Illustration::illust_poll',      'worker' ], // ArtaIllustration daemon claims a queued piece
		[ 'POST', 'relay/illust/heartbeat',                  'Illustration::illust_heartbeat', 'worker' ], // …keeps a multi-round improvement claimed
		[ 'POST', 'relay/illust/round',                      'Illustration::illust_round',     'worker' ], // …records ONE adversarial round (image + critique)
		[ 'POST', 'relay/illust/complete',                   'Illustration::illust_complete',  'worker' ], // …returns the final refined image
		[ 'POST', 'relay/illust/release',                    'Illustration::release',          'worker' ], // …re-queues a claim on shutdown/quota

		// ── ArtaSound — AI music studio (brief + private inspiration audio → original track,
		//    improved over adversarial rounds; kind=audiobook narrates the member's own manuscript) ──
		[ 'POST', 'music/tracks',                            'Music::create',          'user'   ],
		[ 'GET',  'music/tracks',                            'Music::list',            'public' ],
		[ 'GET',  'music/studio',                            'Music::studio_status',   'public' ], // /artasound transparency pulse: online, queue, rounds
		[ 'GET',  'music/mine',                              'Music::mine',            'user'   ],
		[ 'GET',  'music/tracks/(?P<id>[0-9]+)',             'Music::get',             'public' ],
		[ 'POST', 'music/tracks/(?P<id>[0-9]+)/sources',     'Music::add_source',      'user'   ],
		[ 'POST', 'music/tracks/(?P<id>[0-9]+)/sources/(?P<sid>[0-9]+)/delete', 'Music::remove_source', 'user' ],
		[ 'POST', 'music/tracks/(?P<id>[0-9]+)/generate',    'Music::generate',        'user'   ],
		[ 'POST', 'music/tracks/(?P<id>[0-9]+)/publish',     'Music::publish_track',   'user'   ], // charges ArtaCoins by length
		[ 'POST', 'music/tracks/(?P<id>[0-9]+)/delete',      'Music::remove',          'user'   ],
		[ 'POST', 'relay/track/poll',                        'Music::track_poll',      'worker' ], // chunked relay claims/resumes a queued project
		[ 'POST', 'relay/track/heartbeat',                   'Music::track_heartbeat', 'worker' ], // …keeps it claimed between ticks (+ live progress note)
		[ 'POST', 'relay/track/review',                      'Music::track_review',    'worker' ], // …records one adversarial improvement round
		[ 'POST', 'relay/track/complete',                    'Music::track_complete',  'worker' ],

		// ── ArtaMotion — AI animation studio (brief → Manim script → rendered video, 3b1b style) ──
		[ 'POST', 'animations',                              'Motion::create',         'user'   ],
		[ 'GET',  'animations',                              'Motion::list',           'public' ],
		[ 'GET',  'animations/mine',                         'Motion::mine',           'user'   ],
		[ 'GET',  'animations/(?P<id>[0-9]+)',               'Motion::get',            'public' ],
		[ 'POST', 'animations/(?P<id>[0-9]+)/sources',       'Motion::add_source',     'user'   ],
		[ 'POST', 'animations/(?P<id>[0-9]+)/sources/(?P<sid>[0-9]+)/delete', 'Motion::remove_source', 'user' ],
		[ 'POST', 'animations/(?P<id>[0-9]+)/generate',      'Motion::generate',       'user'   ],
		[ 'POST', 'animations/(?P<id>[0-9]+)/publish',       'Motion::publish_anim',   'user'   ], // charges ArtaCoins by length
		[ 'POST', 'animations/(?P<id>[0-9]+)/delete',        'Motion::remove',         'user'   ],
		[ 'POST', 'relay/anim/poll',                         'Motion::anim_poll',      'worker' ],
		[ 'POST', 'relay/anim/complete',                     'Motion::anim_complete',  'worker' ],

		// ── ArtaChat — end-to-end encrypted DMs (src/Chat.php). The server stores ONLY public keys
		//    and AES-256-GCM ciphertext (the whole DB is public; content is sealed by construction —
		//    private keys are non-extractable, device-bound, and never leave the member's browser). ──
		[ 'GET',  'chat/keys',                     'Chat::get_key',    'public' ], // ?user=<slug|id> → their active public key (same bytes as the open DB)
		[ 'POST', 'chat/keys',                     'Chat::set_key',    'user'   ], // register/rotate the caller's device public key
		[ 'GET',  'chat/list',                     'Chat::list_chats', 'user'   ], // ?box=chats|requests|archived|blocked → conversations + unread counts
		[ 'GET',  'chat/members',                  'Chat::members',    'user'   ], // the member directory + live presence (online first)
		[ 'GET',  'chat/unread',                   'Chat::unread',     'user'   ], // badge only (+waiting requests, +inbound call) — deliberately does NOT mark presence (see Chat::mark_presence)
		[ 'POST', 'chat/relation',                 'Chat::relation',   'user'   ], // accept|decline|block|unblock|mute|unmute|pin|unpin|archive|unarchive one conversation
		[ 'POST', 'chat/call',                     'Chat::call',       'user'   ], // ring/stop ringing a peer; the ROOM never reaches the server (it rides inside the sealed message)
		[ 'POST', 'chat/fetch',                    'Chat::fetch_url',  'user'   ],

		// ── ArtaRooms — group conversations and group calls (src/Rooms.php). Same bargain as a DM:
		//    the server holds ciphertext and membership, never a room key. A room with one member is
		//    a member's own space; the same routes serve one person or five. ──────────────────────
		[ 'POST', 'rooms/create',                  'Rooms::create',       'user' ], // open a room (personal=1 → "your room", one per member)
		[ 'GET',  'rooms/list',                    'Rooms::list_rooms',   'user' ], // every room the caller is in
		[ 'GET',  'rooms/get',                     'Rooms::get',          'user' ], // ?id= → one room + its members
		[ 'POST', 'rooms/invite',                  'Rooms::invite',       'user' ], // add a member (they still need the key sealed to them)
		[ 'POST', 'rooms/leave',                   'Rooms::leave',        'user' ], // leave, or {user} to remove (owner only)
		[ 'POST', 'rooms/key',                     'Rooms::put_key',      'user' ], // store the room key SEALED to one member
		[ 'GET',  'rooms/key',                     'Rooms::get_key',      'user' ], // …and fetch my own sealed copy
		[ 'GET',  'rooms/pending',                 'Rooms::pending_keys', 'user' ], // members still missing the current key, with their device pubs
		[ 'GET',  'rooms/messages',                'Rooms::messages',     'user' ], // ?id=&after=|&cursor=
		[ 'POST', 'rooms/send',                    'Rooms::send',         'user' ], // append one sealed row
		[ 'POST', 'rooms/call',                    'Rooms::call',         'user' ], // join/leave the call roster (the handshake rides the room's own messages)
		[ 'POST', 'rooms/mute',                    'Rooms::mute',         'user' ], // pull a remote GIF/image server-side so the browser can seal it — SSRF-fenced
		[ 'GET',  'chat/email-prefs',             'Chat::email_prefs', 'user'  ], // is this member emailed about messages that arrive while away?
		[ 'POST', 'chat/email-prefs',             'Chat::email_prefs', 'user'  ], // …and turn it off/on
		[ 'GET',  'chat/messages',                 'Chat::messages',   'user'   ], // ?with=&cursor=|&after= → ciphertext rows + the key material to open them
		[ 'POST', 'chat/send',                     'Chat::send',       'user'   ], // append one sealed message (envelope validated; content opaque to the server)
		[ 'POST', 'chat/blob',                     'Chat::blob',       'user'   ], // store one already-sealed attachment (image/voice); key travels only inside the message
		[ 'POST', 'chat/typing',                   'Chat::typing',     'user'   ], // 6s "typing…" beacon (transient only, nothing stored)
		[ 'POST', 'chat/ttl',                      'Chat::set_ttl',    'user'   ], // disappearing-message timer; expiry hard-deletes rows + blobs
		[ 'POST', 'chat/unsend',                   'Chat::unsend',     'user'   ], // sender hard-deletes one of their rows (+ its attachment) from the public record

		// The autonomous worker (tools/ticket-agent/) — authenticated by AQ_WORKER_TOKEN.
		[ 'GET',  'agent/queue',                   'Tickets::agent_queue',   'worker' ],
		[ 'POST', 'agent/tickets/(?P<id>[0-9]+)/message', 'Tickets::agent_message', 'worker' ],
		[ 'POST', 'agent/tickets/(?P<id>[0-9]+)/status',  'Tickets::agent_status',  'worker' ],
		[ 'POST', 'agent/tickets/(?P<id>[0-9]+)/approval', 'Tickets::agent_approval', 'worker' ], // hold for a major change
		[ 'GET',  'agent/approve',                  'Tickets::agent_approve', 'public' ], // operator's one-tap email link (HMAC-signed)
		[ 'GET',  'creator/ladder',                'Extra::creator_ladder',  'public' ],
		[ 'GET',  'creator/status',                'Extra::creator_status',  'user' ],
		[ 'POST', 'creator/submit-playlist',       'Extra::submit_playlist', 'user' ],
		[ 'GET',  'db',                            'Extra::db',              'public' ],
		[ 'GET',  'schema',                        'Extra::schema',          'public' ],
		[ 'GET',  'coin-world',                    'Extra::coin_world',      'public' ],
		[ 'GET',  'certificate',                   'Extra::certificate',     'user' ],
		[ 'GET',  'cert-verify',                   'Extra::cert_verify',     'public' ],
		[ 'GET',  'cert-og',                       'Extra::cert_og',         'public' ], // per-cert 1200×630 share card (signed params; binary PNG)
		[ 'GET',  'emblem',                        'Extra::emblem',          'public' ], // deterministic SVG profile emblem for a /topics topic or group
		[ 'GET',  'datasets',                      'Extra::datasets',        'public' ], // nightly NDJSON.gz snapshots of the public DB
		[ 'GET',  'reserve/audits',                'Extra::reserve_audits',  'public' ], // append-only monthly full-reserve audit trail
		[ 'POST', 'course-checkout',               'Extra::course_checkout', 'user' ],
		[ 'GET',  'stripe-verify',                 'Extra::stripe_verify',   'public' ],
		[ 'GET',  'stripe/status',                 'Extra::stripe_status',   'public' ], // masked health check (booleans only, never a secret value)
		[ 'GET',  'version',                       'Extra::version',         'public' ],
		// The health check (AQ\Health): is the app the browser gets the app we built? Full evidence is
		// operator-only; the public pulse is counts alone, for uptime pinging.
		[ 'GET',  'health',                        'Health::report',         'admin'  ],
		[ 'GET',  'health/pulse',                  'Health::pulse',          'public' ], // the code versions EXECUTING on this server — ArtaDev's deploy-confirmation primitive
		[ 'POST', 'stripe/webhook',                'Extra::stripe_webhook',  'public' ], // signature-verified raw-body POST from Stripe

		// ── The feed — ONE principle (operator 2026-07-28): every submission is a PUBLIC KAGGLE
		//    NOTEBOOK THAT HAS BEEN RUN. The member pastes its output-page URL, picks which output
		//    files to publish, and an exhaustive reproducibility checklist (AQ\Kernel) reads the
		//    facts back from Kaggle's public API. Clearing it only REQUESTS publication; the
		//    author's own emailed single-use secret is the mint. Drafts live only in the author's
		//    Studio. Published files land in the Library, attachable by any member. ──
		[ 'GET',  'posts',                                   'Notebook::posts',          'public' ], // THE feed: text posts ± a published work ± Library attachments
		[ 'POST', 'posts',                                   'Notebook::post_create',    'user'   ],
		[ 'POST', 'posts/(?P<id>[0-9]+)/heart',              'Notebook::post_heart',     'user'   ],
		[ 'POST', 'posts/(?P<id>[0-9]+)/edit',               'Notebook::post_edit',      'user'   ],
		[ 'POST', 'posts/(?P<id>[0-9]+)/delete',             'Notebook::post_delete',    'user'   ],
		[ 'POST', 'notebooks/(?P<id>[0-9]+)/comments/(?P<cid>[0-9]+)/edit',   'Notebook::comment_edit',   'user' ],
		[ 'POST', 'notebooks/(?P<id>[0-9]+)/comments/(?P<cid>[0-9]+)/delete', 'Notebook::comment_delete', 'user' ],
		[ 'GET',  'notebooks',                               'Notebook::list',           'public' ],
		[ 'GET',  'notebooks/pulse',                         'Notebook::pulse',          'public' ],
		[ 'GET',  'notebooks/(?P<id>[0-9]+)',                'Notebook::get',            'public' ],
		[ 'GET',  'notebooks/(?P<id>[0-9]+)/ipynb',          'Notebook::raw_ipynb',      'public' ], // the notebook source, as pulled from Kaggle
		[ 'GET',  'notebooks/(?P<id>[0-9]+)/file/(?P<name>[a-z0-9-]{1,80}\.ipynb)', 'Notebook::raw_ipynb', 'public' ], // same file with a REAL filename — JupyterLite names imports from the URL
		[ 'GET',  'notebooks/(?P<id>[0-9]+)/weights',        'Notebook::weights',        'public' ], // music: the trained model's permanent address → 302 to the CDN copy
		[ 'POST', 'notebooks/(?P<id>[0-9]+)/heart',          'Notebook::heart',          'user'   ],
		[ 'GET',  'notebooks/(?P<id>[0-9]+)/comments',       'Notebook::comments',       'public' ],
		[ 'POST', 'notebooks/(?P<id>[0-9]+)/comments',       'Notebook::comment',        'user'   ],
		[ 'GET',  'notebooks/(?P<id>[0-9]+)/poll',           'Notebook::poll_get',       'public' ], // survey answer distributions
		[ 'POST', 'notebooks/(?P<id>[0-9]+)/poll',           'Notebook::poll_answer',    'user'   ],
		[ 'GET',  'notebooks/(?P<id>[0-9]+)/pick',           'Notebook::pick_get',       'public' ], // single-select typology tally
		[ 'POST', 'notebooks/(?P<id>[0-9]+)/pick',           'Notebook::pick_answer',    'user'   ], // pick a character → sets your avatar
		// Proving a member controls the Kaggle account they submit from (KaggleId.php). A one-time string
		// goes in a public notebook under that handle and we read it back — so the proof is re-runnable
		// by a stranger, not a claim we ask anyone to take on trust. The checklist's `owner_proven` BLOCK
		// asks this register the one question, and a work cannot publish until it answers yes.
		[ 'GET',  'kaggle-id',                               'KaggleId::mine',           'user'   ], // my claims + their state
		[ 'POST', 'kaggle-id/claim',                         'KaggleId::claim',          'user'   ], // mint the one-time proof — returned ONCE, stored only as a hash
		[ 'POST', 'kaggle-id/verify',                        'KaggleId::verify',         'user'   ], // read the notebook back and settle the claim

		[ 'GET',  'studio/notebooks',                        'Notebook::mine',           'user'   ],
		[ 'POST', 'studio/notebooks',                        'Notebook::create',         'user'   ],
		[ 'POST', 'studio/notebooks/(?P<id>[0-9]+)/save',    'Notebook::save',           'user'   ], // title/abstract only — the code lives on Kaggle
		[ 'POST', 'studio/notebooks/(?P<id>[0-9]+)/publish', 'Notebook::publish',        'user'   ], // clear checklist → REQUEST; the author's emailed secret mints
		[ 'POST', 'studio/notebooks/(?P<id>[0-9]+)/delete',  'Notebook::remove',         'user'   ],
		// ── The Kaggle submission (operator 2026-07-28) ──────────────────────────────────
		// Paste a URL → pick the files → the checklist → request publication. Nothing here can
		// publish anything; the author's emailed single-use secret remains the only mint.
		[ 'POST', 'studio/kernels',                          'Kernel::import',           'user'   ], // {url} → a draft + its first checklist
		[ 'POST', 'studio/notebooks/(?P<id>[0-9]+)/check',   'Kernel::recheck',          'user'   ], // re-read Kaggle, re-run every check
		[ 'GET',  'studio/notebooks/(?P<id>[0-9]+)/outputs', 'Kernel::outputs',          'user'   ], // the run's output files, for the picker
		[ 'POST', 'studio/notebooks/(?P<id>[0-9]+)/select',  'Kernel::select',           'user'   ], // {files[]} → choose, derive the kind, re-check
		[ 'GET',  'library',                                 'Kernel::library',          'public' ], // every published file, attachable by anyone
		// The six relay/nb/* worker routes (poll · beat · review · update · complete · release) drove
		// the local offline executor + AI review panel, retired 2026-07-28. Nothing enqueues a run any
		// more (the studio run route went with it), no client in the tree calls them, and relay/nb/update
		// wrote `ipynb` with NO published-status guard — the one write CLAUDE.md forbids outright,
		// because sig(ipynb) is what the author's confirmation ledger row, the DB publish-guard and
		// integrity_sweep() are all keyed on. Removed with their handlers.
	];

	public static function register() {
		// Group endpoints by path so a path with several methods (e.g. GET+POST /courses)
		// registers as ONE route — otherwise override=true would have each method replace
		// the previous. override=true then authoritatively replaces any legacy route there.
		$by_path = [];
		foreach ( self::ROUTES as [ $method, $path, $handler, $auth ] ) {
			$by_path[ $path ][] = [
				'methods'             => $method,
				'callback'            => function ( $req ) use ( $handler, $method ) {
					return self::dispatch( $handler, $method, $req );
				},
				'permission_callback' => function () use ( $auth, $path, $method ) {
					return self::can( $auth, $path, $method );
				},
			];
		}
		foreach ( $by_path as $path => $endpoints ) {
			register_rest_route( self::NS, '/' . $path, $endpoints, true );
		}
	}

	private static function can( $auth, $path = '', $method = '' ) {
		if ( $auth === 'public' ) { return true; }
		if ( $auth === 'admin' )  { return ! Api::via_token() && current_user_can( 'manage_options' ); }
		if ( $auth === 'worker' ) { return self::worker_ok(); }
		if ( ! is_user_logged_in() ) { return false; } // 'user'
		// A personal access token signs the request in (Api::determine_user) but reaches ONLY
		// the Api::TOKEN_ROUTES allow-list, scope- and rate-checked. Cookie sessions pass as ever.
		return Api::via_token() ? Api::token_gate( $path, $method ) : true;
	}

	/**
	 * The autonomous ticket worker authenticates with a shared secret in the X-AQ-Worker header
	 * (constant-time compared). Closed by default — an unset AQ_WORKER_TOKEN means no worker access.
	 */
	private static function worker_ok() {
		$want = Secrets::get( 'AQ_WORKER_TOKEN' );
		if ( $want === '' ) { return false; }
		$got = isset( $_SERVER['HTTP_X_AQ_WORKER'] ) ? (string) $_SERVER['HTTP_X_AQ_WORKER'] : '';
		return $got !== '' && hash_equals( $want, $got );
	}

	/**
	 * Handlers that stay reachable while a member still owes their date of birth — everything the
	 * onboarding step itself needs, plus the ways OUT of the account. Anything not on this list is
	 * refused by birthday_gate() below, so the requirement cannot be walked around by calling the
	 * API directly, by an access token, or by an older SPA build that never learned to ask.
	 */
	const BIRTHDAY_EXEMPT = [
		'Verify::set_identity',   // ← the step that satisfies the gate
		'Verify::status',
		'Verify::set_birthtime',
		'Auth::me',
		'Auth::profile_update',   // display name / handle / bio — never blocks stating a birthday
		'Auth::request_code', 'Auth::verify_code', 'Auth::google', // sign in / switch account
		'Extra::stripe_webhook',  // signature-verified, sessionless — never a member action
		'Sessions::logout',
		// TAKING ACCESS AWAY is never gated. If an account is compromised, the owner must be able to
		// cut the intruder off this second — being asked for a birthday first would be absurd, and
		// on a platform whose whole DB is public, actively harmful. Note the asymmetry: revoking is
		// exempt, GRANTING (token_create, passkey/register) is not — a DOB-less account cannot mint
		// new capability, only withdraw it.
		'Sessions::revoke',
		'Sessions::revoke_others',
		'Api::token_revoke',
		'Passkey::revoke',
		'Account::delete_request',
		'Account::delete_confirm',
		'I18n::resolve', 'I18n::translate', 'I18n::save', // the translation mesh gates first paint
		'Notify::mark_read',
		// Turning OFF a notification must never be gated. An account that predates the birthday
		// rule can still be messaged (it already has a device key), so it can still be emailed —
		// and blocking the opt-out would mean receiving mail you are not allowed to stop.
		'Chat::email_prefs',
		// Same asymmetry, and the sharper case: DECLINING or BLOCKING is withdrawal, not capability.
		// A DOB-less account can still be MESSAGED — Chat::send is the sender's action, gated on the
		// sender — so gating this route meant a member who had not finished onboarding could receive
		// message requests from strangers and had no way whatsoever to stop them. That is the exact
		// harm the opt-out exemption above was written for. Mute/pin/archive ride along because they
		// are the same kind of act: arranging your own inbox, creating nothing.
		'Chat::relation',
	];

	/**
	 * EVERY account states an exact date of birth (operator 2026-07-25). The SPA asks for it the
	 * moment a new member lands, but a client-side step is a suggestion, not a rule — so the rule
	 * lives HERE, at the one funnel every route passes through: a signed-in member with no valid
	 * exact birthday cannot mutate anything until they state one. Reads are untouched (a member
	 * can look around while deciding), and the typed `birthday_required` code lets the SPA open the
	 * step instead of showing a dead error. Null = allowed.
	 */
	private static function birthday_gate( $handler, $method ) {
		if ( $method === 'GET' ) { return null; }
		if ( in_array( $handler, self::BIRTHDAY_EXEMPT, true ) ) { return null; }
		$uid = self::uid();
		if ( ! $uid ) { return null; } // public route, or already refused by can()
		if ( ! class_exists( '\\AQ\\Verify' ) || Verify::has_birthday( $uid ) ) { return null; }
		// Service accounts (ArtaBot, the balance bot) are not people and have no date of birth to
		// state. Identified the way the rest of the codebase identifies them — the aq_artabot_uid
		// option and the _aq_is_bot flag — never by role, which a real member can also hold.
		if ( $uid === (int) get_option( 'aq_artabot_uid', 0 ) ) { return null; }
		if ( get_user_meta( $uid, '_aq_is_bot', true ) ) { return null; }
		return self::err(
			'birthday_required',
			'Add your date of birth to your account before continuing — every ArtaQuest member states one.',
			403
		);
	}

	private static function dispatch( $handler, $method, $req ) {
		// ArtaAI operator pause: if this is a relay POLL for a paused studio surface, hand the daemon the
		// normal "no work" answer so it sleeps — no job leaves the queue. Additive + fail-open: default is
		// never-paused, and this must never break a live relay, so it's fully guarded.
		if ( class_exists( '\\AQ\\Artaai' ) && Artaai::should_block_poll( $handler ) ) {
			return new \WP_REST_Response( [ 'job' => null, 'paused' => true ], 200 );
		}
		$owed = self::birthday_gate( $handler, $method );
		if ( $owed ) { return $owed; }
		// "Last seen", recorded here because this is the one place every member action passes
		// through, whatever route it took. Day-granular and self-throttling — see Auth::mark_seen —
		// so this is a cached meta read on all but the first request a member makes each day.
		//
		// NOT keyed to 'user' routes only: reading the feed is being here just as much as posting to
		// it, and a member who only ever reads would otherwise look like they had left. A token or
		// worker call is not a person, so it is skipped.
		if ( is_user_logged_in() && ! Api::via_token() && ! self::worker_ok() ) {
			Auth::mark_seen( get_current_user_id() );
		}
		[ $class, $fn ] = explode( '::', $handler );
		$class = 'AQ\\' . $class;
		try {
			$out = $class::$fn( $req );
		} catch ( \Throwable $e ) {
			return self::err( 'server_error', $e->getMessage(), 500 );
		}
		if ( $out instanceof \WP_Error ) {
			$data = $out->get_error_data();
			return self::err( $out->get_error_code(), $out->get_error_message(), is_int( $data ) ? $data : 400 );
		}
		if ( $out instanceof \WP_REST_Response ) {
			return $out; // handler already built a full response (e.g. Rest::err with its own 4xx status) — don't re-wrap it as 200
		}
		$res = new \WP_REST_Response( $out, 200 );
		if ( $method === 'GET' ) {
			// Anonymous GETs are pure public reads → CDN/edge-cacheable. But a LOGGED-IN response may
			// carry per-user data (/me, /dashboard, /wallet are GETs that read the session), so it must
			// NEVER hit a SHARED cache — otherwise one user's data could be served to another. Vary by
			// auth state: private/no-store when logged in, public otherwise.
			$res->header( 'Cache-Control', get_current_user_id()
				? 'private, no-store'
				: 'public, max-age=30, s-maxage=300, stale-while-revalidate=600' );
		}
		return $res;
	}

	// ── Helpers used by every domain ────────────────────────────────────────
	public static function uid() { return (int) get_current_user_id(); }

	/** $extra merges extra fields into the error body — for a refusal the client must ACT on rather
	 *  than merely display (e.g. `credit_offered` carries the donor and slice the member is being
	 *  asked to accept). `error` and `message` always win, so no caller can overwrite them. */
	public static function err( $code, $msg, $status = 400, $extra = [] ) {
		return new \WP_REST_Response(
			array_merge( (array) $extra, [ 'error' => $code, 'message' => $msg ] ),
			$status
		);
	}

	/** Read a raw request param, or $default when absent. Handlers sanitize at the point of use. */
	public static function p( $req, $key, $default = '' ) {
		$v = $req->get_param( $key );
		return $v === null ? $default : $v;
	}
	public static function pint( $req, $key, $default = 0 ) {
		$v = $req->get_param( $key );
		return $v === null ? $default : (int) $v;
	}

	/**
	 * Simple per-user/per-IP fixed-window rate limit on a key. Returns true if the
	 * caller is over the limit (the handler should bail). Backed by transients.
	 */
	public static function throttle( $bucket, $limit = 30, $window = 60 ) {
		$id = self::uid() ?: ( $_SERVER['REMOTE_ADDR'] ?? '0' );
		$k  = 'aq_rl_' . md5( $bucket . '|' . $id );
		$n  = (int) get_transient( $k );
		if ( $n >= $limit ) { return true; }
		set_transient( $k, $n + 1, $window );
		return false;
	}
}
