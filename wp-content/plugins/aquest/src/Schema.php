<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Versioned schema. All high-volume entities live in purpose-built tables with real
 * columns and indexes — never wp_posts/wp_postmeta (see ARCHITECTURE.md §2-3).
 *
 * Bump VERSION to trigger a migration; dbDelta only adds/widens, never drops, so it is
 * safe to run on every load. Counters (lesson_count, enroll_count, comment_count,
 * vote_score) are denormalized so list/read endpoints never aggregate.
 */
final class Schema {

	const VERSION = '1.71.0';

	/** Map of unprefixed table key → CREATE TABLE body (without prefix/charset). */
	public static function tables() {
		return [

			// ── LMS ────────────────────────────────────────────────────────────
			// ── ArtaCloud: a member's OPTIONAL public media shelf (Media.php) ──
			// PUBLIC BY DESIGN: uploading here is publishing. Privacy is the browser-only option in
			// My Library, which never touches the server — so these rows carry no secrets and are
			// NOT candidates for Extra::PRIVATE_TABLES.
			'aq_media' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				kind VARCHAR(12) NOT NULL DEFAULT '',
				name VARCHAR(255) NOT NULL DEFAULT '',
				title VARCHAR(255) NOT NULL DEFAULT '',
				artist VARCHAR(191) NOT NULL DEFAULT '',
				album VARCHAR(191) NOT NULL DEFAULT '',
				store_key VARCHAR(64) NOT NULL DEFAULT '',
				bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
				received BIGINT UNSIGNED NOT NULL DEFAULT 0,
				duration INT UNSIGNED NOT NULL DEFAULT 0,
				sha256 CHAR(64) NOT NULL DEFAULT '',
				state VARCHAR(12) NOT NULL DEFAULT 'uploading',
				on_cdn TINYINT(1) NOT NULL DEFAULT 0,
				created BIGINT UNSIGNED NOT NULL DEFAULT 0,
				updated BIGINT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				KEY user_state (user_id, state),
				KEY store_key (store_key)
			",

			// Append-only capacity grants: each row is one purchase, priced in ArtaCoin. Capacity is
			// SUM(bytes) + the free grant — never a mutable stored number.
			'aq_media_grants' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
				coins INT NOT NULL DEFAULT 0,
				ref VARCHAR(191) NOT NULL DEFAULT '',
				created BIGINT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				KEY user_id (user_id),
				UNIQUE KEY ref (ref)
			",

			'aq_courses' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				slug VARCHAR(191) NOT NULL DEFAULT '',
				title VARCHAR(255) NOT NULL DEFAULT '',
				summary TEXT NULL,
				image VARCHAR(255) NOT NULL DEFAULT '',
				author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				channel VARCHAR(191) NOT NULL DEFAULT '',
				topic VARCHAR(40) NOT NULL DEFAULT '',
				subtopic VARCHAR(40) NOT NULL DEFAULT '',
				disciplines VARCHAR(255) NOT NULL DEFAULT '',
				houses VARCHAR(255) NOT NULL DEFAULT '',
				search_terms VARCHAR(255) NOT NULL DEFAULT '',
				status VARCHAR(20) NOT NULL DEFAULT 'publish',
				lesson_count INT UNSIGNED NOT NULL DEFAULT 0,
				enroll_count INT UNSIGNED NOT NULL DEFAULT 0,
				duration INT UNSIGNED NOT NULL DEFAULT 0,
				rating_sum INT UNSIGNED NOT NULL DEFAULT 0,
				rating_n INT UNSIGNED NOT NULL DEFAULT 0,
				revenue BIGINT UNSIGNED NOT NULL DEFAULT 0,
				price INT UNSIGNED NOT NULL DEFAULT 0,
				views BIGINT UNSIGNED NOT NULL DEFAULT 0,
				trend BIGINT UNSIGNED NOT NULL DEFAULT 0,
				rank_score BIGINT UNSIGNED NOT NULL DEFAULT 0,
				trend_at INT UNSIGNED NOT NULL DEFAULT 0,
				trend_reset INT UNSIGNED NOT NULL DEFAULT 0,
				lang VARCHAR(8) NOT NULL DEFAULT 'en',
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY slug (slug),
				KEY status_id (status, id),
				KEY status_rank (status, rank_score, id),
				KEY status_enroll (status, enroll_count, id),
				KEY status_topic_rank (status, topic, rank_score, id),
				KEY status_topic_id (status, topic, id),
				KEY status_topic_sub_rank (status, topic, subtopic, rank_score, id),
				KEY status_topic_sub_id (status, topic, subtopic, id),
				KEY author (author_id)",

			'aq_lessons' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				course_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				idx INT UNSIGNED NOT NULL DEFAULT 0,
				title VARCHAR(255) NOT NULL DEFAULT '',
				video_type VARCHAR(20) NOT NULL DEFAULT 'youtube',
				video VARCHAR(255) NOT NULL DEFAULT '',
				duration INT UNSIGNED NOT NULL DEFAULT 0,
				seg_start INT UNSIGNED NOT NULL DEFAULT 0,
				seg_end INT UNSIGNED NOT NULL DEFAULT 0,
				comment_count INT UNSIGNED NOT NULL DEFAULT 0,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				transcript MEDIUMTEXT NULL,
				PRIMARY KEY  (id),
				KEY course_idx (course_id, idx)",

			// ── Video view-count monitor (1.11.0; HOURLY since 2026-06-12) ─────
			// One row per DISTINCT YouTube video referenced by any section. The hourly refresh cron
			// (YouTube::refresh_due) pulls the live cumulative view count from the Data API and stores
			// it here, computing `rate` = views gained PER HOUR (delta ÷ actual elapsed time) — the
			// per-video trending signal. Refreshes are SPREAD across the hour via a jittered
			// `next_refresh` (each run only touches videos that are due), so the schedule scales to
			// millions of videos without ever bursting the API quota. `missing` flags a video the API
			// no longer returns (deleted / private). The latest `views` here supersedes the import-time
			// snapshot in the aq_yt_meta_<vid> option for display.
			'aq_videos' => "
				video VARCHAR(255) NOT NULL,
				views BIGINT UNSIGNED NOT NULL DEFAULT 0,
				view_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
				like_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
				rate BIGINT NOT NULL DEFAULT 0,
				thumb VARCHAR(255) NOT NULL DEFAULT '',
				next_refresh INT UNSIGNED NOT NULL DEFAULT 0,
				last_refresh INT UNSIGNED NOT NULL DEFAULT 0,
				missing TINYINT UNSIGNED NOT NULL DEFAULT 0,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				cand_course BIGINT UNSIGNED NOT NULL DEFAULT 0,
				cand_until INT UNSIGNED NOT NULL DEFAULT 0,
				cand_baseline BIGINT NOT NULL DEFAULT 0,
				PRIMARY KEY  (video),
				KEY due (next_refresh),
				KEY cand (cand_course,cand_until)",

			// Cumulative-views time series per video — behind the historical view-count monitor
			// (sparkline + chart). One row per (video, bucket); `day` is the bucket-start unix
			// timestamp: HOUR-aligned for the recent window (ticket #74: the charts gain a point each
			// hour), folded to one per UTC day beyond YouTube::KEEP_HOURLY_DAYS by the daily
			// compaction. Append-on-refresh, idempotent per bucket via the unique key.
			'aq_video_stats' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				video VARCHAR(255) NOT NULL DEFAULT '',
				day INT UNSIGNED NOT NULL DEFAULT 0,
				views BIGINT UNSIGNED NOT NULL DEFAULT 0,
				view_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
				like_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY video_day (video, day),
				KEY video_id (video, id)",

			// Per-COURSE cumulative-views time series — behind the course page's "view growth over
			// time" chart. Written by YouTube::recompute_course_trend whenever one of the course's
			// videos refreshes (idempotent per bucket, last-write-wins → the bucket's most complete
			// total); buckets are HOURLY for the recent window, daily archives beyond (see
			// YouTube::compact_stats). Kept as its own series rather than summing aq_video_stats on
			// read, because videos refresh at different times, so a per-bucket SUM would dip whenever
			// a video lacked a snapshot.
			'aq_course_stats' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				course_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				day INT UNSIGNED NOT NULL DEFAULT 0,
				views BIGINT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY course_day (course_id, day),
				KEY course_id (course_id, id)",

			// ── Section discussion → UNIFIED into aq_comments / aq_votes (1.10.0) ──
			// The per-section discussion boards (the competition surface) and the public discussion
			// boards now share ONE polymorphic comments + votes model: aq_comments (context_type
			// 'section'|'thread') + aq_votes. The old aq_section_comments / aq_section_votes tables are
			// migrated in + dropped by migrate(). See the aq_comments / aq_votes defs in the Social block.

			// ── Learner state (partitioned by user) ────────────────────────────
			'aq_enroll' => "
				user_id BIGINT UNSIGNED NOT NULL,
				course_id BIGINT UNSIGNED NOT NULL,
				pct TINYINT UNSIGNED NOT NULL DEFAULT 0,
				status VARCHAR(20) NOT NULL DEFAULT 'active',
				created INT UNSIGNED NOT NULL DEFAULT 0,
				updated INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (user_id, course_id),
				KEY course (course_id)",

			'aq_progress' => "
				user_id BIGINT UNSIGNED NOT NULL,
				lesson_id BIGINT UNSIGNED NOT NULL,
				course_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				done TINYINT UNSIGNED NOT NULL DEFAULT 0,
				watched INT UNSIGNED NOT NULL DEFAULT 0,
				started INT UNSIGNED NOT NULL DEFAULT 0,
				updated INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (user_id, lesson_id),
				KEY user_course (user_id, course_id)",

			// ── Materialized projections of the append-only ledgers (read accelerators, 1.17.0) ──
			// The ledgers (aq_coin_ledger / aq_points_ledger) stay the SOURCE OF TRUTH — immutable,
			// auditable, full-reserve provable. These two tiny tables are a PROJECTION of them, kept in
			// lockstep on every ledger append (Economy::credit_coins / award_points). They turn the reads
			// that would otherwise SUM/GROUP-BY the WHOLE ledger — the points leaderboard and the public
			// circulating-supply total — into an O(log n) top-N (covering index) and an O(1) counter read.
			// That is the line between scalable and not at trillions of ledger rows (tools/bench.sh proves
			// it: leaderboard 284ms→~0, reserve 36ms→~0 at 1M rows). Fully rebuildable from the ledgers at
			// any instant (Economy::rebuild_projections) and verified exactly equal to them
			// (Economy::verify_projections) — a derived cache, never a second source of truth.

			// Lifetime points standing per (track, user). The 'all' track row is the user's grand total
			// across every track. (track, points) covers the per-track + overall leaderboards as a top-N
			// ordered index walk (no GROUP BY, no sort); (user_id) serves one user's by-track breakdown.
			'aq_standing' => "
				track VARCHAR(20) NOT NULL,
				user_id BIGINT UNSIGNED NOT NULL,
				points BIGINT NOT NULL DEFAULT 0,
				updated INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (track, user_id),
				KEY track_points (track, points),
				KEY user_id (user_id)",

			// Global scalar counters (name → value), bumped with a single atomic UPDATE (no read-modify-
			// write race). 'coins_issued' = Σ of every coin-ledger delta = total Arta Coins in circulation,
			// so the public reserve/backing figures read ONE row instead of summing the entire coin ledger.
			'aq_counters' => "
				name VARCHAR(40) NOT NULL,
				value BIGINT NOT NULL DEFAULT 0,
				updated INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (name)",

			// Per-season quester standing — the competition's read accelerator (1.17.0). One row per
			// (season, course, quester): `votes` = net upvotes their non-flagged section comments earned
			// FROM votes cast in that season; `comments` = how many such comments they posted that season.
			// Maintained by a SCOPED per-author recompute (Economy::quester_touch) on each comment-post +
			// vote — bounded by one author's footprint, never the whole course — so the leaderboard read
			// (Economy::podium) is a top-N walk of the (season, course, votes) index instead of a GROUP-BY
			// over every section comment + vote of the course (bench.sh: podium 498ms→~0 at 1M). Only the
			// CURRENT season is read live (past seasons are served from the frozen aq_season_results), so
			// maintenance only ever touches the live bucket. Rebuildable + verified equal to the comment/
			// vote tables (Economy::rebuild_quester / verify_quester).
			'aq_quester' => "
				season_key BIGINT UNSIGNED NOT NULL,
				course_id BIGINT UNSIGNED NOT NULL,
				user_id BIGINT UNSIGNED NOT NULL,
				votes INT NOT NULL DEFAULT 0,
				comments INT UNSIGNED NOT NULL DEFAULT 0,
				updated INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (season_key, course_id, user_id),
				KEY board (season_key, course_id, votes, comments)",
				// NB (1.20.0): the board index ends in (votes, comments); with the PK (…, user_id) InnoDB
				// appends, it covers the podium read's full ORDER BY votes DESC, comments DESC, user_id DESC
				// as one reverse index walk + LIMIT — never a filesort over a viral course's quester set.

			// ── Economy (append-only ledgers, full-reserve) ────────────────────
			'aq_coin_ledger' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				delta BIGINT NOT NULL DEFAULT 0,
				reason VARCHAR(40) NOT NULL DEFAULT '',
				ref VARCHAR(191) NOT NULL DEFAULT '',
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				KEY user_id_id (user_id, id),
				KEY reason_ref (reason, ref)",
			// (reason, ref) serves every idempotency probe (enroll/buy/sell: reason + exact ref) AND the
			// per-season qreward SUM/claw-back scans (reason + ref-prefix LIKE) as an index range — never a
			// walk of a whole reason partition (billions of 'enroll' rows at scale). Replaced KEY reason
			// (a left prefix of this one); migrate() drops the old key on upgraded installs.

			'aq_points_ledger' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				delta INT NOT NULL DEFAULT 0,
				track VARCHAR(20) NOT NULL DEFAULT 'learn',
				ref VARCHAR(191) NOT NULL DEFAULT '',
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				KEY user_id_id (user_id, id),
				KEY track_id (track, id),
				KEY user_track_ref (user_id, track, ref)",
			// (user_id, track, ref) makes award_points' per-award idempotency probe one index seek instead
			// of a scan of the member's whole lifetime ledger — that probe runs on EVERY point-earning event.

			// ── Social ─────────────────────────────────────────────────────────
			'aq_threads' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				title VARCHAR(255) NOT NULL DEFAULT '',
				body MEDIUMTEXT NULL,
				lang VARCHAR(12) NOT NULL DEFAULT 'en',
				topic VARCHAR(64) NOT NULL DEFAULT '',
				status VARCHAR(20) NOT NULL DEFAULT 'publish',
				comment_count INT UNSIGNED NOT NULL DEFAULT 0,
				vote_score INT NOT NULL DEFAULT 0,
				edited TINYINT(1) NOT NULL DEFAULT 0,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				KEY status_id (status, id),
				KEY author (author_id),
				KEY topic_id (topic, id),
				KEY title (title(191))",

			// UNIFIED comments (1.10.0): one polymorphic board for BOTH the public discussions
			// (context_type='thread', context_id=thread id) AND the per-section competition boards
			// (context_type='section', context_id=lesson id, course_id set for ranking). One-level
			// threaded replies via parent_id. `votes` = SIGNED net score (up − down). `reply_count` =
			// denormalized direct-reply tally. (Legacy thread_id/vote_score columns linger on upgraded
			// DBs — harmless, unused; migrate() backfills context_id/votes from them.)
			'aq_comments' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				context_type VARCHAR(10) NOT NULL DEFAULT 'thread',
				context_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				course_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				parent_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				body MEDIUMTEXT NULL,
				lang VARCHAR(12) NOT NULL DEFAULT 'en',
				votes INT NOT NULL DEFAULT 0,
				reply_count INT UNSIGNED NOT NULL DEFAULT 0,
				fear TINYINT UNSIGNED NOT NULL DEFAULT 0,
				flagged TINYINT(1) NOT NULL DEFAULT 0,
				appealed TINYINT(1) NOT NULL DEFAULT 0,
				modq TINYINT(1) NOT NULL DEFAULT 0,
				ref TEXT NULL,
				anchor INT UNSIGNED NOT NULL DEFAULT 0,
				edited TINYINT(1) NOT NULL DEFAULT 0,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				KEY ctx_parent_votes (context_type, context_id, parent_id, votes),
				KEY ctx_parent_id (context_type, context_id, parent_id, id),
				KEY course_author (course_id, author_id),
				KEY parent (parent_id),
				KEY author (author_id),
				KEY modq (modq, id)",

			// UNIFIED votes (1.10.0): one vote per (user, target_type, target_id). Since 1.62.0 the
			// platform is HEARTS-ONLY — new votes are `val` = +1 (or the row is deleted on un-heart);
			// legacy −1 rows persist in old seasons' windows and age out (SUM(val) stays correct).
			// target_type: 'thread' | 'comment' | a creative work kind ('book','music','audiobook',
			// 'animation','film','illustration' — hearts on Library works, the Creative Challenges
			// ranking signal; widened to VARCHAR(16) for 'illustration'). course_id + context_id are
			// denormalized from the voted comment so the competition's per-course / per-season-window /
			// per-section scans stay one indexed read (0 for public-discussion + work hearts).
			'aq_votes' => "
				user_id BIGINT UNSIGNED NOT NULL,
				target_type VARCHAR(16) NOT NULL,
				target_id BIGINT UNSIGNED NOT NULL,
				val TINYINT NOT NULL DEFAULT 0,
				course_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				context_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (user_id, target_type, target_id),
				KEY target (target_type, target_id),
				KEY course_user (course_id, user_id),
				KEY created (created),
				KEY user_context (user_id, context_id)",
			// (user_id, context_id) bounds the section board's "my votes on this board" read to the votes
			// the viewer cast on THAT lesson — not a scan of every comment vote they ever cast (a power
			// voter's PK prefix (user_id, target_type) footprint is unbounded).

			// The place-of-birth gazetteer (GeoNames cities15000, CC BY 4.0 — see AQ\Cities).
			// Deliberately plain column types and one plain index per column: dbDelta silently emits
			// NO TABLE AT ALL under Studio's SQLite for several perfectly valid MySQL constructs, and
			// a gazetteer that fails to exist makes the sign-up field unfillable.
			'aq_cities' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				name VARCHAR(120) NOT NULL DEFAULT '',
				search VARCHAR(200) NOT NULL DEFAULT '',
				country CHAR(2) NOT NULL DEFAULT '',
				admin1 VARCHAR(20) NOT NULL DEFAULT '',
				lat DECIMAL(8,4) NOT NULL DEFAULT 0,
				lon DECIMAL(9,4) NOT NULL DEFAULT 0,
				population INT UNSIGNED NOT NULL DEFAULT 0,
				tz VARCHAR(64) NOT NULL DEFAULT '',
				PRIMARY KEY  (id),
				KEY search (search),
				KEY population (population)",

			'aq_follows' => "
				follower_id BIGINT UNSIGNED NOT NULL,
				target_id BIGINT UNSIGNED NOT NULL,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (follower_id, target_id),
				KEY target (target_id)",

			// ── i18n (content-addressed cache, kept from prior build: 300k+ rows) ─
			// Renamed from the legacy ArtaYAB name `ay_translations` → `aq_translations` (1.37.0) for
			// prefix consistency; migrate() does an in-place RENAME so the existing cache is preserved.
			// 1.59.0 (ArtaTranslate): the table doubles as the UPGRADE QUEUE — every `status='auto'`
			// (Google edge) row is pending an ArtaTranslate rewrite (SOTA HF model + adversarial Claude
			// rounds, src/Translate.php); the relay claims batches via `claimed_at`, upgraded rows become
			// `status='arta'` with a critic `quality` score. `priority`: 2 = narration segments (an
			// audiobook is waiting), 1 = legacy fresh-edge captures, 0 = everything else.
			// 1.60.0 (demand-aware): `demand` counts CACHE-HIT resolves per row — how many times real
			// visitors re-read that string in that language after its first visit (I18n::resolve bumps
			// it, batched + throttled). ONLY rows a member is waiting on (priority 2) or with demand ≥
			// Translate::MIN_DEMAND are claimable, ordered priority DESC, demand DESC — so the upgrade
			// budget goes exclusively to content people actually read; the never-visited backlog stays.
			'aq_translations' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				lang VARCHAR(12) NOT NULL DEFAULT '',
				source_hash CHAR(32) NOT NULL DEFAULT '',
				source_text TEXT NULL,
				translated_text TEXT NULL,
				context VARCHAR(40) NOT NULL DEFAULT 'content',
				status VARCHAR(20) NOT NULL DEFAULT 'auto',
				quality TINYINT UNSIGNED NOT NULL DEFAULT 0,
				priority TINYINT UNSIGNED NOT NULL DEFAULT 0,
				demand INT UNSIGNED NOT NULL DEFAULT 0,
				read_at INT UNSIGNED NOT NULL DEFAULT 0,
				claimed_at INT UNSIGNED NOT NULL DEFAULT 0,
				updated_at DATETIME NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY hash_lang (source_hash, lang),
				KEY upgrade_queue (status, priority, id),
				KEY lang_queue (status, lang, priority, id),
				KEY demand_queue (status, demand, id),
				KEY read_sweep (read_at, id)",

			// ── Course reviews (one per user per course) ───────────────────────
			'aq_reviews' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				course_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				rating TINYINT UNSIGNED NOT NULL DEFAULT 5,
				body TEXT NULL,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY user_course (user_id, course_id),
				KEY course_id (course_id)",

			// ── Topic (typology-system) REGISTRY — the /topics hub entities, migrated from the build-time
			//    typologies.data.json into the DB so each is authored (default /u/arash), editable in
			//    Studio, and SPONSORABLE (a company funds the topic → its courses' prize pools). Distinct
			//    from \AQ\Topics (the course-subject houses). options/dimensions/citations are read-whole
			//    JSON blobs (never queried into). Served by GET /topics (\AQ\Typology::all). ──
			'aq_topics' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				topic_key VARCHAR(191) NOT NULL DEFAULT '',
				name VARCHAR(255) NOT NULL DEFAULT '',
				category VARCHAR(64) NOT NULL DEFAULT '',
				disciplines VARCHAR(512) NOT NULL DEFAULT '',
				sign VARCHAR(24) NOT NULL DEFAULT '',
				planet VARCHAR(24) NOT NULL DEFAULT '',
				status VARCHAR(24) NOT NULL DEFAULT '',
				status_note TEXT NULL,
				blurb TEXT NULL,
				format VARCHAR(16) NOT NULL DEFAULT '',
				self_describe TINYINT UNSIGNED NOT NULL DEFAULT 0,
				source VARCHAR(512) NOT NULL DEFAULT '',
				video VARCHAR(32) NOT NULL DEFAULT '',
				instructor VARCHAR(191) NOT NULL DEFAULT '',
				course VARCHAR(191) NOT NULL DEFAULT '',
				image VARCHAR(512) NOT NULL DEFAULT '',
				options MEDIUMTEXT NULL,
				dimensions MEDIUMTEXT NULL,
				citations MEDIUMTEXT NULL,
				author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				sponsor_name VARCHAR(191) NOT NULL DEFAULT '',
				sponsor_url VARCHAR(512) NOT NULL DEFAULT '',
				sponsor_logo VARCHAR(512) NOT NULL DEFAULT '',
				active TINYINT UNSIGNED NOT NULL DEFAULT 1,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				updated_ts INT UNSIGNED NOT NULL DEFAULT 0,
				trend_score SMALLINT NOT NULL DEFAULT -1,
				PRIMARY KEY  (id),
				UNIQUE KEY topic_key (topic_key),
				KEY category (category),
				KEY author_id (author_id),
				KEY active_cat (active, category)",

			// ── Google-Trends cache: per-topic + per-cycle worldwide web-search interest (2004→now).
			//    One row per ref ("topic:<key>" | "cycle:<slug>"); series = raw monthly JSON ints so the
			//    score can be recomputed without re-fetching. Populated by the local trends-fetch tool
			//    (cookie+token, rate-limited) via the operator import; read by Studio + the /why pages. ──
			'aq_trends' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				ref VARCHAR(191) NOT NULL DEFAULT '',
				kind VARCHAR(16) NOT NULL DEFAULT '',
				query VARCHAR(255) NOT NULL DEFAULT '',
				series MEDIUMTEXT NULL,
				score SMALLINT NOT NULL DEFAULT -1,
				recent SMALLINT NOT NULL DEFAULT 0,
				peak SMALLINT NOT NULL DEFAULT 0,
				trough SMALLINT NOT NULL DEFAULT 0,
				band SMALLINT NOT NULL DEFAULT 0,
				momentum SMALLINT NOT NULL DEFAULT 0,
				updated INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY ref (ref),
				KEY kind (kind)",

			// ── Bursary grants (Outreach fund covers a learner's course entry fee) ──
			'aq_bursary' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				course_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				group_key VARCHAR(64) NOT NULL DEFAULT '',
				amount INT UNSIGNED NOT NULL DEFAULT 0,
				reason VARCHAR(255) NOT NULL DEFAULT '',
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY user_course (user_id, course_id),
				KEY course_id (course_id)",

			'aq_fund_ledger' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				bucket VARCHAR(24) NOT NULL DEFAULT 'bursary',
				cents BIGINT NOT NULL DEFAULT 0,
				ref VARCHAR(191) NOT NULL DEFAULT '',
				note VARCHAR(191) NOT NULL DEFAULT '',
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				KEY bucket_id (bucket, id),
				KEY ref (ref)",
			// (ref) closes the Stripe fulfilment idempotency probe (Extra::fulfil_session checks
			// "WHERE ref = %s" before honouring a payment) — without it every payment scans the whole
			// donation ledger. Per-bucket TOTALS are projected into aq_counters ('fund_<bucket>',
			// maintained by Funds::fund_append) so finances()/bursary_fund_cents never SUM the ledger.

			// Single-fulfilment claim: one row per paid Stripe Checkout session. fulfil_session() inserts it
			// atomically (session_id is the PK), so of the two callers that race to honour a payment — the
			// returning browser's stripe_verify and Stripe's webhook — exactly ONE proceeds to credit coins /
			// record the gift; the loser's duplicate insert fails and it skips. Closes the verify/webhook
			// double-mint that the per-ledger 'stripe:<id>' refs (sequential-only) could not. 191 chars fits a
			// Stripe session id with index-length headroom.
			'aq_fulfilment' => "
				session_id VARCHAR(191) NOT NULL,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (session_id)",

			// ── ArtaCredits (2026-08-03, Credits.php) ─────────────────────────
			// One row per DONOR GIFT earmarked to a slice of the membership. Write-once with ONE
			// exception, stated plainly because the whole point of a public database is that its claims
			// are true: `widened` is stamped if the donor later releases an unspent gift to the general
			// slice (Credits::widen), which is the only way money aimed at a slice nobody matches can
			// ever move. The money itself is never rewritten — the release is a zero-sum PAIR of fund
			// appends plus a successor gift row, exactly as Funds::rename_topic_earmark does it.
			// `bucket` is the crd_<cty>_<gender>_<band> fund earmark the money sits
			// in; `entries` and `unit_cents` FREEZE what the donor was actually promised, at the gold
			// rate quoted on the page they paid from — the coin price moves, and a promise re-derived
			// at redemption would silently become a different promise. Remaining entries on a gift =
			// entries - COUNT(aq_credit_grants WHERE gift_id = id): a COUNT over an append-only table,
			// so there is no mutable "spent" counter to drift or to lose a compare-and-swap race.
			// `donor_name` is what prints on a sponsored entrant's certificate ('' = gave anonymously).
			// It is stripped to a conservative character class at capture (Credits.php) — NOT screened by
			// ArtaMod, which this comment used to claim. ArtaMod is a queued model pass over comments; it
			// has never run on this field, and saying it did would be a promise about a stranger's name
			// that nothing keeps.
			//
			// UNIQUE is on (ref, bucket), never on `ref` alone: ONE donation legitimately produces one
			// row per bucket the donor split it across, all carrying the payment's ref, so a unique `ref`
			// would refuse every community after the first and silently drop that money. (ref, bucket) is
			// exactly the tuple Extra.php's webhook already SELECTs to decide whether a redelivery is a
			// duplicate — making it an index moves that decision out of a check-then-insert race and into
			// a guarantee the database keeps.
			'aq_credit_gifts' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				donor_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				bucket VARCHAR(24) NOT NULL DEFAULT '',
				cents BIGINT NOT NULL DEFAULT 0,
				entries INT NOT NULL DEFAULT 0,
				unit_cents INT NOT NULL DEFAULT 0,
				fee_cap INT NOT NULL DEFAULT 5,
				donor_name VARCHAR(80) NOT NULL DEFAULT '',
				ref VARCHAR(191) NOT NULL DEFAULT '',
				widened INT UNSIGNED NOT NULL DEFAULT 0,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				KEY bucket_id (bucket, id),
				KEY donor (donor_id, id),
				UNIQUE KEY ref_bucket (ref, bucket)",

			// One row per REDEEMED entry — the member accepted a named donor's credit and it paid this
			// challenge's fee. APPEND-ONLY; UNIQUE (ch_id, user_id) is what makes Data::upsert's "true =
			// this call created the row" a correct single-claim primitive under a race, so a losing
			// racer is refused rather than inserted-then-deleted. `bucket` is deliberately NOT copied
			// here: it stays one hop away on the gift, so no single public row states a member's
			// nationality, gender and age band beside their user id.
			'aq_credit_grants' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				gift_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				ch_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				fee INT NOT NULL DEFAULT 0,
				cents INT NOT NULL DEFAULT 0,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY ch_user (ch_id, user_id),
				KEY gift (gift_id, id),
				KEY member (user_id, created)",

			// ── Proven Kaggle account ownership (2026-08-04, KaggleId.php) ────
			// The platform mints a PERMANENT DOI crediting a notebook's Kaggle author. Until today any
			// member could submit any public notebook, so it could mint a citation in the name of someone
			// who never consented and might never learn of it. This table is the link that closes that:
			// a member proves they control a Kaggle account before they may submit its work.
			//
			// The proof uses only Kaggle's credential-free read API, so a stranger can re-run it: we mint
			// a one-time string, the member puts it in a PUBLIC notebook under that handle, and we pull
			// that kernel and check the owner and the string. `proof_kernel` keeps the URL so the check
			// stays re-runnable by anyone, forever — the claim is not "we checked once, trust us".
			//
			// `nonce_hash` is a sha256 and NEVER the string itself. Every row of this database is public;
			// storing the plaintext would publish the proof and let anyone claim the handle. It is
			// cleared on success, so a verified row carries no verifier at all.
			//
			// UNIQUE is (user_id, handle) deliberately, NOT (handle): two members may hold competing
			// PENDING claims on the same handle — only one can prove it — and refusing the second claim
			// at insert would let anyone block a handle they do not own. That exactly one member may hold
			// a handle as `verified` is enforced in KaggleId, where it can answer with a reason.
			'aq_kaggle_ids' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				handle VARCHAR(120) NOT NULL DEFAULT '',
				nonce_hash CHAR(64) NOT NULL DEFAULT '',
				proof_kernel VARCHAR(300) NOT NULL DEFAULT '',
				state VARCHAR(16) NOT NULL DEFAULT 'pending',
				created INT UNSIGNED NOT NULL DEFAULT 0,
				verified_at INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY user_handle (user_id, handle),
				KEY handle_state (handle, state)",

			// ── Issues / bug-bounty ───────────────────────────────────────────
			// Issue reports (the /issues/ page → Extra::bug_finding). Ownership moved here from the
			// theme's aq-bug-bounty.php (aq_bb_install_table) so the plugin owns the table it writes.
			'aq_bug_findings' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				persona_name VARCHAR(64) NOT NULL DEFAULT '',
				severity VARCHAR(16) NOT NULL DEFAULT 'minor',
				category VARCHAR(16) NOT NULL DEFAULT 'functional',
				title VARCHAR(255) NOT NULL DEFAULT '',
				body LONGTEXT NULL,
				reason LONGTEXT NULL,
				screenshot_path VARCHAR(512) NOT NULL DEFAULT '',
				status VARCHAR(16) NOT NULL DEFAULT 'pending',
				points_awarded INT NOT NULL DEFAULT 0,
				hash CHAR(40) NOT NULL DEFAULT '',
				created_at DATETIME NULL DEFAULT NULL,
				awarded_at DATETIME NULL DEFAULT NULL,
				PRIMARY KEY  (id),
				KEY persona_name (persona_name),
				KEY user_id (user_id),
				KEY status (status),
				KEY category (category),
				KEY hash (hash),
				KEY created_at (created_at)",

			// ── Contributions (Claude-triaged tickets) ─────────────────────────
			// The /issues page evolved from a one-shot bug form into ArtaQuest's contribution system:
			// a member opens a ticket (bug | feature | content | suggestion), Claude triages it in a
			// back-and-forth (aq_ticket_messages), an autonomous agent may ship a fix, and only the
			// OWNER closes it (status='resolved') — which awards a flat 1 point on the kind's own track
			// (bug→Sentinel, feature→Visionary, content→Curator, suggestion→Sage), ranked separately.
			// Point is awarded once via Economy::award_points(uid,1,track,'ticket'.id) — idempotent ref.
			'aq_tickets' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				kind VARCHAR(16) NOT NULL DEFAULT 'suggestion',
				title VARCHAR(255) NOT NULL DEFAULT '',
				body LONGTEXT NULL,
				screenshot VARCHAR(512) NOT NULL DEFAULT '',
				where_url VARCHAR(512) NOT NULL DEFAULT '',
				status VARCHAR(16) NOT NULL DEFAULT 'open',
				msg_count INT UNSIGNED NOT NULL DEFAULT 0,
				branch VARCHAR(191) NOT NULL DEFAULT '',
				pr_url VARCHAR(512) NOT NULL DEFAULT '',
				deploy_sha VARCHAR(64) NOT NULL DEFAULT '',
				agent_run_id VARCHAR(64) NOT NULL DEFAULT '',
				arch_ok TINYINT UNSIGNED NOT NULL DEFAULT 0,
				attempts INT UNSIGNED NOT NULL DEFAULT 0,
				retry_after INT UNSIGNED NOT NULL DEFAULT 0,
				claimed_at INT UNSIGNED NOT NULL DEFAULT 0,
				hash CHAR(32) NOT NULL DEFAULT '',
				points_awarded INT NOT NULL DEFAULT 0,
				resolved_by BIGINT UNSIGNED NOT NULL DEFAULT 0,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				resolved_at INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				KEY user_id_id (user_id, id),
				KEY status_id (status, id),
				KEY kind_id (kind, id),
				KEY hash (hash)",

			// The conversation on a ticket. role: user | assistant (Claude triage) | agent (autonomous
			// worker progress) | system (status notes). meta = JSON (Data::enc): classification, run sha…
			'aq_ticket_messages' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				ticket_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				role VARCHAR(12) NOT NULL DEFAULT 'user',
				body LONGTEXT NULL,
				meta LONGTEXT NULL,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				KEY ticket_id_id (ticket_id, id)",

			// ArtaBot — the platform AI assistant, available everywhere. Each user has ONE persistent
			// conversation (memory across sessions, like a normal chatbot). Using ArtaBot costs points
			// (≈1 per 1k tokens), drawn from the SPENDABLE balance; standing/tier never falls. tokens =
			// the turn's input+output (for the cost shown to the user). role: user | assistant.
			'aq_artabot_messages' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				session_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				role VARCHAR(12) NOT NULL DEFAULT 'user',
				body LONGTEXT NULL,
				tokens INT UNSIGNED NOT NULL DEFAULT 0,
				cost INT UNSIGNED NOT NULL DEFAULT 0,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				KEY user_id_id (user_id, id),
				KEY session_id_id (session_id, id)",

			// A member may hold SEVERAL ArtaBot conversations at once and run them in parallel — each
			// with its own transcript, its own tier (so its own CPU and RAM), its own live stream and
			// its own bill. Before this there was exactly one conversation per member, and one live
			// buffer keyed on the member, so two turns at the same time would have overwritten each
			// other's stream mid-sentence. `tier` lives on the SESSION rather than the turn: it is the
			// size of machine this conversation runs on, which is a property of the work, not the message.
			'aq_artabot_sessions' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				title VARCHAR(120) NOT NULL DEFAULT '',
				tier VARCHAR(10) NOT NULL DEFAULT 'low',
				created INT UNSIGNED NOT NULL DEFAULT 0,
				last INT UNSIGNED NOT NULL DEFAULT 0,
				closed INT UNSIGNED NOT NULL DEFAULT 0,
				turns INT UNSIGNED NOT NULL DEFAULT 0,
				coins DECIMAL(12,4) NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				KEY user_last (user_id, last)",

			// ── Competition seasons (new-moon resets) ──────────────────────────
			// Each closed season is recorded here once it's been settled + archived. The current
			// season is computed (Season::current), not stored. season_key = the season's end
			// (reset) timestamp.
			'aq_seasons' => "
				season_key BIGINT UNSIGNED NOT NULL,
				start_ts INT UNSIGNED NOT NULL DEFAULT 0,
				label VARCHAR(64) NOT NULL DEFAULT '',
				closed TINYINT UNSIGNED NOT NULL DEFAULT 0,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (season_key)",

			// A frozen leaderboard snapshot for a closed season+course (top entries + prize winners).
			// `place` (not `rank` — reserved word in MySQL 8) is the finishing position.
			'aq_season_results' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				season_key BIGINT UNSIGNED NOT NULL DEFAULT 0,
				course_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				place SMALLINT UNSIGNED NOT NULL DEFAULT 0,
				user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				votes INT UNSIGNED NOT NULL DEFAULT 0,
				prize BIGINT UNSIGNED NOT NULL DEFAULT 0,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				KEY season_course (season_key, course_id, place),
				KEY course (course_id),
				KEY user_id (user_id)",

			// ── Creative Challenges (1.62.0) — the unified challenge frame ─────
			// One row per (creative kind, lunar season): publishing a work of that kind DURING the
			// season IS the entry — its publish cost (already burned by the studio's coin charge) is
			// the entry fee, accumulated here as `revenue`. The pool = 100% of `revenue` + `carried`
			// (a prior season's pool rolled forward when its participation gate wasn't met), paid
			// 50/30/20 to the top-3 works by hearts at the new-moon reset (Challenges::settle — same
			// signed-delta, season-scoped-ref discipline as the course podium). `thread_id` = the
			// challenge's own discussion board (share your creation, discuss the entries).
			// 1.62.3 — MEMBER CHALLENGES: anyone can start a challenge (₳1, seeds the pot), so
			// (kind, season) is no longer unique. The kind's SYSTEM challenge (owner_uid 0 — where
			// every publish auto-enters) is deduplicated by the UNIQUE `slug` ('<kind>-s<seasonKey>');
			// member rows carry NULL slug + the owner + a title/brief (the prompt).
			'aq_challenges' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				kind VARCHAR(16) NOT NULL DEFAULT '',
				season_key BIGINT UNSIGNED NOT NULL DEFAULT 0,
				slug VARCHAR(64) NULL,
				title VARCHAR(255) NOT NULL DEFAULT '',
				brief TEXT NULL,
				owner_uid BIGINT UNSIGNED NOT NULL DEFAULT 0,
				revenue BIGINT UNSIGNED NOT NULL DEFAULT 0,
				carried BIGINT UNSIGNED NOT NULL DEFAULT 0,
				entry_count INT UNSIGNED NOT NULL DEFAULT 0,
				thread_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				status VARCHAR(12) NOT NULL DEFAULT 'open',
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY slug (slug),
				KEY kind_season (kind, season_key),
				KEY season (season_key)",

			// One row per entered work — the challenge board's read accelerator (mirrors aq_quester):
			// `hearts` = the net hearts the work earned from votes cast INSIDE the season window,
			// maintained by a scoped recompute on each heart (Challenges::entry_touch), so the board
			// is a top-N walk of (challenge_id, hearts) — never a GROUP BY over aq_votes. The row
			// PERSISTS even if the work is later deleted (the fee was sunk, the participation was
			// real — it anchors the participation certificate); deleted works are excluded from the
			// live board by joining the work's status at read time.
			'aq_challenge_entries' => "
				challenge_id BIGINT UNSIGNED NOT NULL,
				work_id BIGINT UNSIGNED NOT NULL,
				kind VARCHAR(16) NOT NULL DEFAULT '',
				author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				fee BIGINT UNSIGNED NOT NULL DEFAULT 0,
				hearts INT NOT NULL DEFAULT 0,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (challenge_id, work_id),
				KEY board (challenge_id, hearts),
				KEY author (author_id, challenge_id)",

			// Frozen podium snapshot for a settled challenge season (mirrors aq_season_results).
			// challenge_id (1.62.3) scopes the snapshot to ONE challenge — member challenges share a
			// (kind, season) with the system row and each other.
			'aq_challenge_results' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				challenge_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				season_key BIGINT UNSIGNED NOT NULL DEFAULT 0,
				kind VARCHAR(16) NOT NULL DEFAULT '',
				place SMALLINT UNSIGNED NOT NULL DEFAULT 0,
				user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				work_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				hearts INT UNSIGNED NOT NULL DEFAULT 0,
				prize BIGINT UNSIGNED NOT NULL DEFAULT 0,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				KEY challenge (challenge_id, place),
				KEY season_kind (season_key, kind, place),
				KEY user_id (user_id)",

			// ── Outreach: community-sourced grant applications ─────────────────
			// Ownership moved here from the retired theme's aq-outreach.php so the plugin owns the
			// tables Extra::outreach* writes. The catalogue is refreshed from data/outreach-grants.json
			// on deploy (Extra::import_grants, filemtime-gated). `deadline` is a 'YYYY-MM-DD' string
			// (empty for rolling/invitation), `estimated` flags a roll-forward guess (shown as ≈).
			'aq_grants' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				slug VARCHAR(191) NOT NULL DEFAULT '',
				title VARCHAR(255) NOT NULL DEFAULT '',
				funder VARCHAR(255) NOT NULL DEFAULT '',
				url VARCHAR(512) NOT NULL DEFAULT '',
				country VARCHAR(128) NOT NULL DEFAULT '',
				category VARCHAR(64) NOT NULL DEFAULT '',
				currency VARCHAR(8) NOT NULL DEFAULT '',
				amount_cad BIGINT UNSIGNED NOT NULL DEFAULT 0,
				amount_display VARCHAR(128) NOT NULL DEFAULT '',
				deadline VARCHAR(10) NOT NULL DEFAULT '',
				deadline_type VARCHAR(32) NOT NULL DEFAULT '',
				estimated TINYINT UNSIGNED NOT NULL DEFAULT 0,
				eligibility_ca VARCHAR(32) NOT NULL DEFAULT '',
				eligibility_intl VARCHAR(32) NOT NULL DEFAULT '',
				allows_regranting VARCHAR(16) NOT NULL DEFAULT '',
				fit TINYINT UNSIGNED NOT NULL DEFAULT 0,
				confidence VARCHAR(16) NOT NULL DEFAULT '',
				capacity INT UNSIGNED NOT NULL DEFAULT 1,
				points BIGINT UNSIGNED NOT NULL DEFAULT 0,
				summary TEXT NULL,
				red_flags TEXT NULL,
				active TINYINT UNSIGNED NOT NULL DEFAULT 1,
				author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				updated_ts INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY slug (slug),
				KEY active_fit (active, fit, points),
				KEY author_id (author_id),
				KEY title (title(191)),
				KEY funder (funder(191)),
				KEY summary (summary(191))",

			// Each row = one member committing to help draft a grant application (first-come, capped
			// by aq_grants.capacity). status: claimed → submitted → verified. Points are credited only
			// once the foundation verifies the submission (Extra::outreach_*).
			'aq_grant_claims' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				grant_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				status VARCHAR(16) NOT NULL DEFAULT 'claimed',
				points BIGINT UNSIGNED NOT NULL DEFAULT 0,
				note TEXT NULL,
				ref VARCHAR(512) NOT NULL DEFAULT '',
				claimed_ts INT UNSIGNED NOT NULL DEFAULT 0,
				submitted_ts INT UNSIGNED NOT NULL DEFAULT 0,
				verified_ts INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY grant_user (grant_id, user_id),
				KEY grant_status (grant_id, status),
				KEY user_id (user_id)",

			// Scheduled group meetings for a grant's registrants (1-hour Google Meet working sessions
			// at deadline-reminder milestones). reminder_key = e.g. 't-14' / 't-1'. meet_url + the
			// Calendar event id come from the Calendar API (Meet); empty when Meet is not configured.
			// ── ArtaMeet booking — "here is when I am free, take a slot" ───────
			// A RULE, not a diary. It says which weekdays and which hours of the owner's own day are
			// offered, how long a slot is, and how much notice is needed; the free/busy answer is
			// computed against aq_meets at read time. Nothing here duplicates a meeting, because a
			// booking IS a meeting (context_type='book') the moment somebody takes a slot — the same
			// reason ArtaCalendar owns no data.
			// `days` is a 7-character mask, Monday first: "1111100" is weekdays.
			// `from_min`/`to_min` are minutes from midnight IN `tz`, the owner's own zone, because
			// "I am free from nine" is a statement about their morning, not about UTC.
			'aq_meet_rules' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				slug VARCHAR(48) NOT NULL DEFAULT '',
				title VARCHAR(255) NOT NULL DEFAULT '',
				blurb TEXT NULL,
				minutes SMALLINT UNSIGNED NOT NULL DEFAULT 30,
				tz VARCHAR(64) NOT NULL DEFAULT 'UTC',
				days VARCHAR(7) NOT NULL DEFAULT '1111100',
				from_min SMALLINT UNSIGNED NOT NULL DEFAULT 540,
				to_min SMALLINT UNSIGNED NOT NULL DEFAULT 1020,
				buffer_min SMALLINT UNSIGNED NOT NULL DEFAULT 10,
				notice_h SMALLINT UNSIGNED NOT NULL DEFAULT 4,
				horizon_d SMALLINT UNSIGNED NOT NULL DEFAULT 21,
				seats TINYINT UNSIGNED NOT NULL DEFAULT 2,
				active TINYINT UNSIGNED NOT NULL DEFAULT 1,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				updated INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY user_slug (user_id, slug),
				KEY user_active (user_id, active)",

			// ── ArtaMeet — scheduled meetings ─────────────────────────────────
			// A meeting is a PROMISE about a future time; the end-to-end encrypted room that
			// carries it is bound at T-15m and thrown away after, so a week-old invitation never
			// depends on a week-old key epoch. room_id is 0 for almost all of a meeting's life.
			// sort_key = start_ts * 10000000 + id: Db::page emits a bare "col > %d" cursor, so
			// paging on start_ts alone SILENTLY DROPS ties — and grant sittings tie by
			// construction (all computed at 16:00 ET). title is VARCHAR(255) for a 60-CHARACTER
			// cap because VARCHAR counts BYTES and MySQL rejects the whole row on overflow.
			'aq_meets' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				host_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				title VARCHAR(255) NOT NULL DEFAULT '',
				agenda TEXT NULL,
				start_ts INT UNSIGNED NOT NULL DEFAULT 0,
				end_ts INT UNSIGNED NOT NULL DEFAULT 0,
				tz VARCHAR(64) NOT NULL DEFAULT 'UTC',
				seats TINYINT UNSIGNED NOT NULL DEFAULT 5,
				status VARCHAR(12) NOT NULL DEFAULT 'scheduled',
				room_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				opened_ts INT UNSIGNED NOT NULL DEFAULT 0,
				seq INT UNSIGNED NOT NULL DEFAULT 0,
				sort_key BIGINT UNSIGNED NOT NULL DEFAULT 0,
				context_type VARCHAR(16) NOT NULL DEFAULT '',
				context_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				ctx_key VARCHAR(64) NOT NULL DEFAULT '',
				retime_ts INT UNSIGNED NOT NULL DEFAULT 0,
				retime_by BIGINT UNSIGNED NOT NULL DEFAULT 0,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				updated INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY ctx_key (ctx_key),
				KEY start_status (start_ts, status),
				KEY host_id (host_id),
				KEY ctx (context_type, context_id),
				KEY sort_key (sort_key)",

			// One row per invited member. `seated` is what makes membership RETRYABLE: Rooms::invite
			// refuses anyone with no device key, so a guest who has never opened ArtaChat cannot be
			// added to a room — here they are simply recorded, and seated the moment they show up.
			'aq_meet_guests' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				meet_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				role VARCHAR(12) NOT NULL DEFAULT 'guest',
				rsvp VARCHAR(8) NOT NULL DEFAULT 'none',
				invited_by BIGINT UNSIGNED NOT NULL DEFAULT 0,
				invited INT UNSIGNED NOT NULL DEFAULT 0,
				rsvp_ts INT UNSIGNED NOT NULL DEFAULT 0,
				seated INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY meet_user (meet_id, user_id),
				KEY user_meet (user_id, meet_id)",

			'aq_grant_meetings' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				grant_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				reminder_key VARCHAR(16) NOT NULL DEFAULT '',
				start_ts INT UNSIGNED NOT NULL DEFAULT 0,
				end_ts INT UNSIGNED NOT NULL DEFAULT 0,
				meet_url VARCHAR(255) NOT NULL DEFAULT '',
				gcal_event_id VARCHAR(255) NOT NULL DEFAULT '',
				ics_uid VARCHAR(128) NOT NULL DEFAULT '',
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY grant_reminder (grant_id, reminder_key),
				KEY grant_start (grant_id, start_ts)",

			// ── Competitions (Kaggle-style predictive-modelling contests) ──────
			// One row per competition. Public train/test data live as FILES under
			// uploads/competitions/<slug>/ (train.csv, test.csv, sample_submission.csv); the hidden
			// holdout targets (solution.json) are NEVER in the DB — the whole DB is public — they sit
			// server-only in that same uploads dir. `metric` names the scorer ('r2'); `holdout`
			// describes the split; n_* are dataset stats shown on the overview. See \AQ\Competitions.
			'aq_competitions' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				slug VARCHAR(191) NOT NULL DEFAULT '',
				title VARCHAR(255) NOT NULL DEFAULT '',
				owner_uid BIGINT UNSIGNED NOT NULL DEFAULT 0,
				blurb TEXT NULL,
				metric VARCHAR(24) NOT NULL DEFAULT 'r2',
				holdout VARCHAR(191) NOT NULL DEFAULT '',
				status VARCHAR(16) NOT NULL DEFAULT 'active',
				n_train INT UNSIGNED NOT NULL DEFAULT 0,
				n_test INT UNSIGNED NOT NULL DEFAULT 0,
				n_features INT UNSIGNED NOT NULL DEFAULT 0,
				n_targets INT UNSIGNED NOT NULL DEFAULT 0,
				prize INT UNSIGNED NOT NULL DEFAULT 0,
				entry_fee INT UNSIGNED NOT NULL DEFAULT 0,
				revenue BIGINT UNSIGNED NOT NULL DEFAULT 0,
				thread_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				created DATETIME NULL,
				deadline DATETIME NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY slug (slug),
				KEY owner_uid (owner_uid),
				KEY status_id (status, id)",
			// entry_fee/revenue (1.62.1, the dataset/model C-to-C split): competitions created from
			// 2026-07-10 charge ₳entry_fee per submission (burned → `revenue`), and settlement pays
			// prize + floor(80% × revenue) — the same creators-fund-creators frame as courses and the
			// Creative Challenges. Legacy/live competitions keep entry_fee 0 (free entries, fixed
			// prize) and run out under the rules they opened with.

			// Every submission ever made to a competition (append-only — the leaderboard takes the MAX
			// score per uid, so an improving submission simply outranks the member's earlier ones; a
			// worse one never demotes their standing). `score` is the R² the scorer computed against the
			// server-only holdout; `place` is the entrant's leaderboard position at submission time (a
			// convenience snapshot — the live board is recomputed on read, never trusted from here).
			// `place` (not `rank`) because rank is a reserved word in MySQL 8 — same reason aq_season_results
			// uses `place`.
			'aq_comp_subs' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				comp_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				uid BIGINT UNSIGNED NOT NULL DEFAULT 0,
				note VARCHAR(255) NOT NULL DEFAULT '',
				score DOUBLE NOT NULL DEFAULT 0,
				preds MEDIUMTEXT NULL,
				phase MEDIUMTEXT NULL,
				code_url VARCHAR(300) NOT NULL DEFAULT '',
				method MEDIUMTEXT NULL,
				review VARCHAR(24) NOT NULL DEFAULT 'none',
				review_round INT UNSIGNED NOT NULL DEFAULT 0,
				verified TINYINT(1) NOT NULL DEFAULT 0,
				place INT NOT NULL DEFAULT 0,
				created DATETIME NULL,
				updated DATETIME NULL,
				PRIMARY KEY  (id),
				KEY comp_id (comp_id),
				KEY uid (uid),
				KEY comp_uid_score (comp_id, uid, score),
				KEY comp_score (comp_id, score),
				KEY review (review)",

			// Adversarial review of a competition SOLUTION — the ArtaScience mirror. A member attaches
			// their method + open code to a submission and requests verification; the ArtaCompete relay
			// clones + RUNS the code against the public data, checks the leaderboard score reproduces and
			// probes for holdout leakage / hardcoding, and returns a verdict per round. Only a VERIFIED
			// submission is eligible for the coin prize at settlement (the public leaderboard stays open
			// to all — this gates the money, exactly like a Kaggle solution review).
			'aq_comp_reviews' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				sub_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				round INT UNSIGNED NOT NULL DEFAULT 0,
				verdict VARCHAR(16) NOT NULL DEFAULT '',
				verified TINYINT(1) NOT NULL DEFAULT 0,
				score INT NOT NULL DEFAULT 0,
				report MEDIUMTEXT NULL,
				model VARCHAR(60) NOT NULL DEFAULT '',
				effort VARCHAR(20) NOT NULL DEFAULT '',
				runtime_s INT UNSIGNED NOT NULL DEFAULT 0,
				created DATETIME NULL,
				PRIMARY KEY  (id),
				KEY sub_round (sub_id, round)",

			// ── ArtaNews: automated objective-data journalism (operator 2026-07-25) ──────
			// A DETECTION is an objective threshold crossing in a public real-time feed (satellite
			// thermal anomaly, seismic magnitude, a price move past N sigma). One row per real-world
			// EVENT, keyed so the same fire/quake updates instead of publishing twice.
			'aq_news_events' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				detector VARCHAR(32) NOT NULL DEFAULT '',
				ekey VARCHAR(191) NOT NULL DEFAULT '',
				first_ts BIGINT UNSIGNED NOT NULL DEFAULT 0,
				last_ts BIGINT UNSIGNED NOT NULL DEFAULT 0,
				lat DECIMAL(9,5) NOT NULL DEFAULT 0,
				lon DECIMAL(9,5) NOT NULL DEFAULT 0,
				place VARCHAR(191) NOT NULL DEFAULT '',
				country VARCHAR(80) NOT NULL DEFAULT '',
				place_km DECIMAL(7,1) NOT NULL DEFAULT 0,
				headline VARCHAR(255) NOT NULL DEFAULT '',
				severity DOUBLE NOT NULL DEFAULT 0,
				rank_score DOUBLE NOT NULL DEFAULT 0,
				energy_mj DOUBLE NOT NULL DEFAULT 0,
				pixels LONGTEXT,
				energy_span_s BIGINT UNSIGNED NOT NULL DEFAULT 0,
				posted TINYINT(1) NOT NULL DEFAULT 0,
				confidence VARCHAR(16) NOT NULL DEFAULT '',
				measures MEDIUMTEXT NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'new',
				revisions INT UNSIGNED NOT NULL DEFAULT 0,
				created BIGINT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY ekey (ekey),
				KEY det_ts (detector, last_ts),
				KEY status_sev (status, severity),
				KEY status_rank (status, rank_score)",

			// The flare/industrial-heat CENSUS. A wp_options blob raced between concurrent cron ticks
			// (read-modify-write) and grew unboundedly; this is per-cell so two ticks can never clobber
			// each other, and it is fed by EVERY thermal pixel — not just the hot ones — because a flare
			// that idles at 4 MW and spikes once is exactly the false positive we must not publish.
			'aq_news_cells' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				cell VARCHAR(24) NOT NULL DEFAULT '',
				days INT UNSIGNED NOT NULL DEFAULT 0,
				last_day VARCHAR(10) NOT NULL DEFAULT '',
				first_seen BIGINT UNSIGNED NOT NULL DEFAULT 0,
				peak_frp DOUBLE NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY cell (cell),
				KEY days (days)",

			// The PUBLISHED report for an event — the citable, SEO-indexed page. Body is generated
			// from the event's own measurements; `sources` records exactly what was queried and when
			// so a reader can reproduce the claim.
			// status: 'pending' until the AUTHOR confirms by email — nothing here publishes itself.
			// author_token: sha256(raw_secret|slug). The RAW secret exists only in the author's inbox;
			// this DB is PUBLIC, so storing anything invertible would hand the gate key to every reader.
			// NB: keep SQL comments OUT of the string below — dbDelta parses it with a strict
			// line-oriented regex, does not understand `--`, and SILENTLY drops the columns after one.
			'aq_news_articles' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				event_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				slug VARCHAR(191) NOT NULL DEFAULT '',
				title VARCHAR(255) NOT NULL DEFAULT '',
				summary VARCHAR(500) NOT NULL DEFAULT '',
				body MEDIUMTEXT NULL,
				sources MEDIUMTEXT NULL,
				revision INT UNSIGNED NOT NULL DEFAULT 1,
				status VARCHAR(20) NOT NULL DEFAULT 'pending',
				author_token VARCHAR(64) NOT NULL DEFAULT '',
				published BIGINT UNSIGNED NOT NULL DEFAULT 0,
				updated BIGINT UNSIGNED NOT NULL DEFAULT 0,
				created BIGINT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY slug (slug),
				KEY event (event_id),
				KEY pub (status, published)",
		];
	}

	/**
	 * Plain-language DATA DICTIONARY for the public database — what each table is and what its
	 * non-obvious columns mean. ArtaQuest publishes its ENTIRE database (see Extra::db / /data), so this
	 * is what makes that openness usable: a researcher, journalist, or auditor can read the data without
	 * reverse-engineering it. Co-located with tables() so the two stay in sync on every schema change.
	 *
	 * Shape: [ table_key => [ 'desc' => one-line table purpose, 'cols' => [ column => meaning, … ] ] ].
	 * Only the non-obvious columns are documented; id/created/updated and self-named columns are skipped.
	 * Consumed by Extra::db (the explorer shows the table blurb + per-column tooltips) and the public
	 * GET /aq/v1/schema endpoint, so the dictionary travels WITH the data, machine-readable.
	 */
	public static function dictionary() {
		return [
			'aq_courses'        => [ 'desc' => 'One row per course. Counters (lesson_count, enroll_count, rating_*, views) are denormalized so list/read pages never aggregate.', 'cols' => [
				'author_id' => 'WordPress user id of the course creator', 'channel' => 'source YouTube channel name', 'status' => 'publish | draft',
					'topic' => 'primary subject slug (the catalogue facet/filter — see Topics.php)',
				'lesson_count' => 'number of sections (videos) — also the coin entry fee', 'enroll_count' => 'learners enrolled (denormalized)',
				'rating_sum' => 'Σ of review ratings', 'rating_n' => 'number of reviews', 'revenue' => 'total coins paid in entry fees (funds the prize pool)',
				'views' => 'Σ lifetime views across the course videos (retained, no longer maintained)', 'trend' => 'Σ cumulative YouTube comments across the course\'s videos — the trending tiebreak + the card\'s comment total', 'rank_score' => 'avg per-video rolling-24h comment count ×100 — the catalogue sort key (the card\'s "X/day")',
				'trend_reset' => 'set when the course\'s video composition changes — trend/rank_score stay 0 until every video is re-measured since (capped at 24h), so an updated course re-earns its rank from fresh measurement' ] ],
			'aq_lessons'        => [ 'desc' => 'One row per section (a video segment) of a course; user-facing name is "video".', 'cols' => [
				'course_id' => 'parent course', 'idx' => 'order within the course (0-based)', 'video' => 'YouTube video id', 'seg_start' => 'clip start (seconds)', 'seg_end' => 'clip end (seconds)',
				'comment_count' => 'denormalized board total (so a section never COUNT(*)s its comments)', 'transcript' => 'JSON caption track' ] ],
			'aq_videos'         => [ 'desc' => 'One row per DISTINCT YouTube video; the daily view-count monitor refreshes it.', 'cols' => [
				'views' => 'latest cumulative comment count from the YouTube API', 'rate' => 'trailing 28-day comment rate ×100 (centi-comments/day) — the trending signal', 'thumb' => 'thumbnail URL (maxresdefault); each course displays its HIGHEST-RATED video\'s thumbnail', 'next_refresh' => 'when this video is next due (jittered to spread load)', 'missing' => '1 if the API no longer returns it (deleted/private)' ] ],
			'aq_video_stats'    => [ 'desc' => 'Cumulative-views time series per video — behind the sparkline. Hourly buckets for the last week, one per day beyond.', 'cols' => [ 'day' => 'bucket-start unix timestamp (hour-aligned recently, UTC-midnight/day-end for compacted archives)' ] ],
			'aq_course_stats'   => [ 'desc' => 'Cumulative-views time series per course — the course growth chart. Hourly buckets for the last week, one per day beyond.', 'cols' => [ 'day' => 'bucket-start unix timestamp (hour-aligned recently, UTC-midnight/day-end for compacted archives)' ] ],
			'aq_enroll'         => [ 'desc' => 'Enrolment + course progress, one row per (learner, course).', 'cols' => [
				'pct' => 'engaged sections ÷ total, monotonic; 100 = certificate', 'status' => 'active | bursary' ] ],
			'aq_progress'       => [ 'desc' => 'Per-section completion, one row per (learner, section).', 'cols' => [ 'done' => '1 once the video is watched in full (unlocks the next)', 'watched' => 'seconds watched' ] ],
			'aq_standing'       => [ 'desc' => 'PROJECTION (derived cache) of lifetime points per (track, user); the "all" track is the grand total. Rebuildable from aq_points_ledger.', 'cols' => [ 'track' => "points track: learn | donate | bug | feature | content | suggestion | 'all'", 'points' => 'Σ of the track\'s ledger deltas' ] ],
			'aq_counters'       => [ 'desc' => 'PROJECTION: global scalar counters. coins_issued = Σ of every coin-ledger delta = coins in circulation; backing_mg = gold reserve; fund_<bucket> = Σ of that fund bucket\'s cents (mirrors aq_fund_ledger).', 'cols' => [ 'name' => 'counter name', 'value' => 'current total' ] ],
			'aq_quester'        => [ 'desc' => 'PROJECTION: per-season competition standing per (season, course, quester). Rebuildable from aq_comments + aq_votes.', 'cols' => [ 'season_key' => 'season end timestamp (new-moon reset)', 'votes' => 'net upvotes their non-flagged section comments earned this season', 'comments' => 'section comments they posted this season' ] ],
			'aq_coin_ledger'    => [ 'desc' => 'APPEND-ONLY money ledger (1 ₳ = 1 mg gold, full-reserve). A balance is SUM(delta); rows are never mutated.', 'cols' => [ 'delta' => 'signed coin change (+credit / −debit)', 'reason' => 'why (enrol | qreward | buy | payout | …)', 'ref' => 'idempotency key (one effect per ref)' ] ],
			'aq_points_ledger'  => [ 'desc' => 'APPEND-ONLY standing/points ledger (lifetime, never spent). Standing = SUM(delta) per track.', 'cols' => [ 'delta' => 'points earned', 'track' => 'learn | donate | bug | feature | content | suggestion', 'ref' => 'idempotency key' ] ],
			'aq_threads'        => [ 'desc' => 'Global public discussion threads.', 'cols' => [ 'lang' => 'authoring language (boards are language-partitioned)', 'topic' => 'optional topic tag', 'comment_count' => 'denormalized reply tally', 'vote_score' => 'denormalized net score' ] ],
			'aq_comments'       => [ 'desc' => 'UNIFIED comments for BOTH public threads and per-section competition boards (one polymorphic model).', 'cols' => [
				'context_type' => "thread (public board) | section (competition board)", 'context_id' => 'the thread id, or the lesson id for a section', 'course_id' => 'set for section comments (for ranking)', 'parent_id' => 'parent comment for a reply, else 0',
				'votes' => 'denormalized net score (= SUM of this comment\'s aq_votes.val)', 'reply_count' => 'denormalized direct replies', 'fear' => 'ArtaMod score 0-100 (hate/fear)', 'flagged' => '1 if fear ≥ 70 → upvotes excluded from the competition' ] ],
			'aq_votes'          => [ 'desc' => 'One vote per (user, target). Reddit-style up/down. Source of truth for every score.', 'cols' => [ 'target_type' => 'thread | comment', 'target_id' => 'voted row id', 'val' => '+1 up | −1 down', 'course_id' => 'denormalized from the comment (0 for public votes)', 'context_id' => 'the section/lesson id (0 for public votes)' ] ],
			'aq_cities'         => [ 'desc' => 'The place-of-birth gazetteer: every city over 15,000 people, with coordinates and timezone. GeoNames cities15000, CC BY 4.0.', 'cols' => [ 'name' => 'city name as GeoNames spells it', 'search' => 'accent-folded lowercase name(s), what the type-ahead matches', 'country' => 'ISO 3166-1 alpha-2', 'admin1' => 'GeoNames admin1 code (state/province)', 'lat' => 'latitude, 4dp (~11 m)', 'lon' => 'longitude, 4dp', 'population' => 'used to rank identically-named places', 'tz' => 'IANA timezone' ] ],
			'aq_follows'        => [ 'desc' => 'Social follow graph, one row per (follower → target).', 'cols' => [] ],
			'aq_translations'   => [ 'desc' => 'Content-addressed i18n cache: each (string-hash × language) translated once ever, then served to everyone. Also the ArtaTranslate upgrade queue: status auto (Google edge, pending) → arta (rewritten by the SOTA model + adversarial review rounds). Demand-aware: only rows people actually re-read (demand ≥ 1) or that an audiobook waits on (priority 2) are upgraded, most-read first.', 'cols' => [ 'source_hash' => 'md5 of the source string', 'lang' => 'target language', 'translated_text' => 'the cached translation', 'status' => 'auto (edge) | arta (upgraded)', 'quality' => 'ArtaTranslate critic score 0-100', 'priority' => '2 narration · 1 legacy fresh edge · 0 rest', 'demand' => 'cache-hit resolves — how many times visitors re-read this string in this language', 'read_at' => 'last time this row was SERVED anywhere (coarse, ≤1 write/week) — rows unused for months are purged by the nightly GC' ] ],
			'aq_tr_rounds'      => [ 'desc' => 'ArtaTranslate public record: every adversarial improvement round (draft → critique → rewrite) behind each upgraded translation.', 'cols' => [ 'source_hash' => 'md5 of the source string', 'lang' => 'target language', 'round' => 'round number', 'engine' => 'who produced the candidate (google | HF model | claude critic)', 'candidate' => 'the round\'s translation', 'critique' => 'the adversarial critique', 'score' => 'critic score 0-100' ] ],
			'aq_reviews'        => [ 'desc' => 'Course reviews, one per (user, course).', 'cols' => [ 'rating' => '1–5 stars' ] ],
			'aq_bursary'        => [ 'desc' => 'Outreach grant covering a learner\'s entry fee (donation-funded).', 'cols' => [ 'group_key' => 'eligibility group the donation was earmarked to', 'amount' => 'coins covered' ] ],
			'aq_fund_ledger'    => [ 'desc' => 'APPEND-ONLY foundation money ledger (cents), the basis of public financial transparency.', 'cols' => [ 'bucket' => 'fund (bursary | typ_… | crd_…)', 'cents' => 'signed amount' ] ],
			'aq_credit_gifts'   => [ 'desc' => 'ArtaCredits: one row per donor gift earmarked to a slice of the membership (nationality · gender · age band). Immutable. Entries still available on a gift = entries − the number of aq_credit_grants rows pointing at it.', 'cols' => [ 'bucket' => 'the crd_<country>_<gender>_<age> fund earmark holding this money', 'entries' => 'entry fees this gift promised to cover', 'unit_cents' => 'what one entry cost at the gold rate quoted when the gift was captured', 'fee_cap' => 'largest single entry fee (₳) this gift will cover', 'donor_name' => 'the name printed on a sponsored entrant\'s certificate; empty when the donor gave anonymously' ] ],
			'aq_credit_grants'  => [ 'desc' => 'ArtaCredits: one row per entry a donor\'s credit paid for — written only when the member was offered the credit, saw who gave it and for whom, and accepted. Append-only; one per (challenge, member). The slice the gift was given for is on aq_credit_gifts, not here.', 'cols' => [ 'gift_id' => 'the gift this entry was paid from', 'fee' => 'the challenge entry fee covered (₳)', 'cents' => 'what that cost the fund on the day' ] ],
			'aq_bug_findings'   => [ 'desc' => 'Issue/bug-bounty reports.', 'cols' => [ 'severity' => 'critical | major | minor', 'category' => 'functional | content | …', 'status' => 'pending | accepted | resolved', 'points_awarded' => 'volunteer points granted' ] ],
			'aq_tickets'        => [ 'desc' => 'Contribution tickets (bug | feature | content | suggestion), Claude-triaged then shipped by the autonomous worker.', 'cols' => [ 'kind' => 'bug→Sentinel | feature→Visionary | content→Curator | suggestion→Sage', 'status' => 'open → triaging → queued → in_progress → (awaiting operator OK) → shipped → resolved', 'arch_ok' => '1 once the operator approved a major architectural change for this ticket', 'resolved_by' => 'user who closed it (the owner)' ] ],
			'aq_ticket_messages'=> [ 'desc' => 'The conversation on a ticket.', 'cols' => [ 'role' => 'user | assistant (Claude) | agent (worker) | system', 'meta' => 'JSON (classification, run sha, …)' ] ],
			'aq_artabot_messages'=> [ 'desc' => 'Each user\'s persistent conversation with ArtaBot, the platform AI assistant.', 'cols' => [ 'role' => 'user | assistant', 'tokens' => 'turn input+output tokens', 'cost' => 'points charged' ] ],
			'aq_artabot_sessions'=> [ 'desc' => 'A member\'s ArtaBot conversations. Several may run at once, each with its own tier (CPU/RAM), its own live stream and its own bill.', 'cols' => [ 'tier' => 'the size of machine this conversation runs on', 'turns' => 'messages answered', 'coins' => 'metered cost accrued by this session' ] ],
			'aq_seasons'        => [ 'desc' => 'Each closed competition season (new-moon resets). The current season is computed, not stored.', 'cols' => [ 'season_key' => 'reset timestamp', 'closed' => '1 once settled + frozen' ] ],
			'aq_season_results' => [ 'desc' => 'Frozen leaderboard snapshot for a closed (season, course): podium + prizes.', 'cols' => [ 'place' => 'finishing position (1=🥇)', 'votes' => 'final season upvotes', 'prize' => 'coins awarded' ] ],
			'aq_grants'         => [ 'desc' => 'Community-sourced grant catalogue (Outreach program).', 'cols' => [ 'fit' => 'relevance score', 'deadline' => 'YYYY-MM-DD (empty = rolling)', 'allows_regranting' => 'whether the funder permits bursary re-granting' ] ],
			'aq_grant_claims'   => [ 'desc' => 'A member committing to draft a grant application.', 'cols' => [ 'status' => 'claimed → submitted → verified' ] ],
			'aq_meet_rules' => [ 'desc' => 'When a member is open to being booked. A rule, not a diary — the free/busy answer is computed against aq_meets at read time, and a booking becomes an ordinary meeting.', 'cols' => [ 'days' => '7-char mask, Monday first', 'from_min' => 'minutes from midnight in the owner\'s own tz', 'notice_h' => 'how little warning is acceptable' ] ],
			'aq_meets' => [ 'desc' => 'ArtaMeet — a scheduled meeting. The E2EE room that carries it is bound at T-15m and released after, so room_id is 0 for almost all of a meeting\'s life.', 'cols' => [ 'room_id' => 'the ArtaRooms room, only while live', 'seq' => 'iCalendar SEQUENCE — clients ignore an updated event without it', 'sort_key' => 'start_ts*1e7+id, a unique keyset cursor (start_ts alone ties)', 'ctx_key' => 'idempotency handle, e.g. grant:12:t-14' ] ],
			'aq_meet_guests' => [ 'desc' => 'Who is invited to an ArtaMeet, and whether they have been seated in its room yet.', 'cols' => [ 'rsvp' => 'none|yes|no|maybe', 'seated' => 'when they were added to the live room (0 = not yet)' ] ],
			'aq_grant_meetings' => [ 'desc' => 'Scheduled group working sessions for a grant\'s registrants.', 'cols' => [ 'reminder_key' => 'milestone (e.g. t-14, t-1)', 'meet_url' => 'RETIRED — the Google Meet link these sessions used before ArtaMeet; kept for the record, read by nothing' ] ],
			'aq_competitions'   => [ 'desc' => 'Kaggle-style predictive-modelling contests. Public train/test data are files under uploads/competitions/<slug>/; the hidden holdout targets are server-only (never in this public DB).', 'cols' => [ 'owner_uid' => 'the member who opened the competition', 'metric' => 'scorer (r2)', 'holdout' => 'how the hidden test split is defined', 'status' => 'active | closed', 'n_train' => 'training rows', 'n_test' => 'holdout rows', 'n_features' => 'features per row', 'n_targets' => 'number of prediction targets', 'prize' => 'coin prize pool paid 50/30/20 to the top-3 at the deadline (0 = no prize)', 'thread_id' => 'the competition\'s official discussion thread (aq_threads.id)' ] ],
			'aq_comp_subs'      => [ 'desc' => 'APPEND-ONLY competition submissions. The leaderboard takes the MAX score per member, so a better submission outranks earlier ones and a worse one never demotes them.', 'cols' => [ 'comp_id' => 'the competition', 'uid' => 'submitter', 'score' => 'R² against the hidden holdout', 'place' => 'leaderboard position snapshot at submission time', 'note' => 'optional submitter note', 'score' => 'R\xc2\xb2 on the PUBLIC holdout half (the live leaderboard); the private half decides the prize at the deadline', 'preds' => 'the submitted predictions (JSON, holdout rows only; oversized blobs stored as "gz:"+base64(deflate)) — kept so the private-half prize can be re-scored at settlement; public like every row here (they are the submitter\'s own guesses, not the hidden answers)', 'phase' => 'phase-metric telemetry (JSON): the full shift→R² distribution, the best shift, its zodiac sign, the per-30°-sector zodiac distribution and rep — which sky rotation the model locked onto, and how decisively', 'code_url' => 'open code the member submitted for adversarial review', 'method' => 'the member\'s method write-up', 'review' => 'review state: none | submitted | reviewing | verified | flagged | revisions-requested', 'verified' => 'the ArtaCompete reviewer ran the code + confirmed the score reproduces with no holdout leakage — required to win the prize' ] ],
			'aq_comp_reviews'   => [ 'desc' => 'Adversarial review rounds for a competition SOLUTION (the ArtaScience mirror). The ArtaCompete relay clones + RUNS the member\'s open code against the public data, checks the leaderboard score reproduces and probes for holdout leakage/hardcoding, and returns a verdict per round; only a verified solution wins the prize.', 'cols' => [ 'sub_id' => 'the reviewed submission', 'round' => 'review round', 'verdict' => 'verify | revise | reject', 'verified' => 'the code reproduced the score with no leakage', 'score' => 'reviewer confidence 0-100', 'report' => 'the reviewer report', 'model' => 'reviewer model', 'effort' => 'reviewer reasoning effort', 'runtime_s' => 'review runtime (s)' ] ],
		];
	}

	public static function install() {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		foreach ( self::tables() as $name => $body ) {
			$sql = "CREATE TABLE {$wpdb->prefix}{$name} (\n{$body}\n) {$charset};";
			dbDelta( $sql );
		}
		self::migrate();
		update_option( 'aq_schema_version', self::VERSION, true );
	}

	/**
	 * Destructive cleanup that dbDelta can't do (it only ever adds/widens columns, never drops).
	 * Idempotent — every statement is guarded with IF EXISTS or a prior column check, so it is safe
	 * to run on every version bump and a no-op once applied. This is where retired columns/tables go
	 * to actually free their storage, instead of lingering forever after they leave tables().
	 */
	private static function migrate() {
		global $wpdb;
		$p = $wpdb->prefix;
		$prev = $wpdb->suppress_errors( true );

		// 1.3.0 — drop the unused aq_courses.meta column (never written or read by any code path).
		// Existence probe is a suppressed SELECT, which works identically on SQLite (dev) and MySQL
		// (prod) — unlike PRAGMA/information_schema, which diverge between the two engines.
		if ( self::column_exists( $p . 'aq_courses', 'meta' ) ) {
			$wpdb->query( "ALTER TABLE {$p}aq_courses DROP COLUMN meta" );
		}

		// 1.3.0 — drop the unused aq_i18n_seo table (created but never written or read).
		$wpdb->query( "DROP TABLE IF EXISTS {$p}aq_i18n_seo" );

		// 1.4.0 — the pedagogy pivot: in-video "attention quizzes" (right/wrong markers) are
		// retired in favour of learner-submitted questions + peer voting (see aq_questions /
		// aq_question_votes). Drop the three quiz-era tables so their storage is reclaimed.
		$wpdb->query( "DROP TABLE IF EXISTS {$p}aq_markers" );
		$wpdb->query( "DROP TABLE IF EXISTS {$p}aq_answers" );
		$wpdb->query( "DROP TABLE IF EXISTS {$p}aq_stances" );

		// 1.6.0 — the engagement redesign: a single "submit one question per section" becomes a full
		// per-section DISCUSSION BOARD (comment + upvote, ranked by upvotes). The question tables are
		// superseded by aq_section_comments / aq_section_votes.
		$wpdb->query( "DROP TABLE IF EXISTS {$p}aq_questions" );
		$wpdb->query( "DROP TABLE IF EXISTS {$p}aq_question_votes" );

		// 1.10.0 — UNIFY discussions: merge the per-section competition boards (aq_section_comments /
		// aq_section_votes) and the public boards (aq_comments / aq_votes) into ONE polymorphic model.
		// dbDelta has just added context_type/context_id/course_id/votes/reply_count to aq_comments and
		// course_id/context_id to aq_votes; here we backfill + move + drop. Idempotent (re-runnable).
		if ( self::column_exists( "{$p}aq_comments", 'context_type' ) ) {
			// (a) Backfill existing PUBLIC (thread) comments into the polymorphic shape. Guarded by the
			//     legacy thread_id column (absent on fresh installs → nothing to backfill).
			if ( self::column_exists( "{$p}aq_comments", 'thread_id' ) ) {
				$wpdb->query( "UPDATE {$p}aq_comments SET context_type='thread', context_id=thread_id, votes=vote_score WHERE thread_id > 0 AND context_id = 0" );
			}
			// (b) Migrate SECTION comments → aq_comments. Section ids ≠ comment ids, so REMAP: insert in
			//     id order recording old→new, then fix parent_id; then move their votes into aq_votes.
			if ( self::table_exists( "{$p}aq_section_comments" ) ) {
				$map  = array();
				$rows = $wpdb->get_results( "SELECT * FROM {$p}aq_section_comments ORDER BY id ASC", ARRAY_A );
				foreach ( $rows as $r ) {
					$wpdb->insert( "{$p}aq_comments", array(
						'context_type' => 'section', 'context_id' => (int) $r['lesson_id'], 'course_id' => (int) $r['course_id'],
						'parent_id' => 0, 'author_id' => (int) $r['user_id'], 'body' => $r['body'], 'lang' => 'en',
						'votes' => (int) $r['votes'], 'reply_count' => (int) $r['reply_count'], 'created' => (int) $r['created'],
					) );
					$map[ (int) $r['id'] ] = (int) $wpdb->insert_id;
				}
				foreach ( $rows as $r ) {
					$pid = (int) $r['parent_id'];
					if ( $pid && isset( $map[ $pid ], $map[ (int) $r['id'] ] ) ) {
						$wpdb->update( "{$p}aq_comments", array( 'parent_id' => $map[ $pid ] ), array( 'id' => $map[ (int) $r['id'] ] ) );
					}
				}
				if ( self::table_exists( "{$p}aq_section_votes" ) ) {
					foreach ( $wpdb->get_results( "SELECT * FROM {$p}aq_section_votes", ARRAY_A ) as $v ) {
						$nid = isset( $map[ (int) $v['comment_id'] ] ) ? $map[ (int) $v['comment_id'] ] : 0;
						if ( ! $nid ) { continue; }
						$wpdb->replace( "{$p}aq_votes", array(
							'user_id' => (int) $v['voter_id'], 'target_type' => 'comment', 'target_id' => $nid,
							'val' => (int) $v['val'], 'course_id' => (int) $v['course_id'], 'context_id' => (int) $v['lesson_id'], 'created' => (int) $v['created'],
						) );
					}
					$wpdb->query( "DROP TABLE IF EXISTS {$p}aq_section_votes" );
				}
				$wpdb->query( "DROP TABLE IF EXISTS {$p}aq_section_comments" );
			}
		}

		// 1.11.0 — seed the video-view monitor registry from existing sections so the refresh cron
		// has a worklist immediately (and the trending sort isn't empty pre-first-cron). For every
		// DISTINCT video referenced by a section, create an aq_videos row if absent, carrying over the
		// import-time view count from the aq_yt_meta_<vid> option as the starting snapshot, and a
		// next_refresh jittered across the next HOUR (the monitor's cadence since 2026-06-12) so the
		// first cron cycle doesn't clump yet tracking starts within the hour. Idempotent:
		// guarded by INSERT IGNORE-style existence checks; never overwrites a live-refreshed row.
		if ( self::table_exists( "{$p}aq_videos" ) && self::table_exists( "{$p}aq_lessons" ) ) {
			$now  = time();
			$vids = $wpdb->get_col( "SELECT DISTINCT video FROM {$p}aq_lessons WHERE video <> '' AND video_type = 'youtube'" );
			foreach ( (array) $vids as $vid ) {
				$exists = $wpdb->get_var( $wpdb->prepare( "SELECT 1 FROM {$p}aq_videos WHERE video = %s", $vid ) );
				if ( $exists ) { continue; }
				$m     = get_option( 'aq_yt_meta_' . $vid );
				$views = ( is_array( $m ) && isset( $m['views'] ) ) ? (int) $m['views'] : 0;
				$wpdb->insert( "{$p}aq_videos", array(
					'video'        => $vid,
					'views'        => $views,
					'rate'         => 0,
					'next_refresh' => $now + wp_rand( 0, 3600 ),
					'last_refresh' => 0,
					'missing'      => 0,
					'created'      => $now,
				) );
			}
		}

		// 1.12.0 — make the aq_courses view-metric columns deterministic. dbDelta SHOULD add them, but
		// the SQLite dev integration has been observed to bump the schema version while silently skipping
		// an ADD COLUMN (leaving it missing forever, since later loads see the version matched). Add each
		// explicitly when absent — a no-op on MySQL where dbDelta already added it. Must precede the
		// backfill below, which writes the views column.
		foreach ( [
			'views'       => 'views BIGINT UNSIGNED NOT NULL DEFAULT 0',
			'trend'       => 'trend BIGINT UNSIGNED NOT NULL DEFAULT 0',
			'rank_score'  => 'rank_score BIGINT UNSIGNED NOT NULL DEFAULT 0', // catalogue sort key — avg per-video rolling-24h comment count ×100 (ticket #95; was view velocity)
			'trend_at'    => 'trend_at INT UNSIGNED NOT NULL DEFAULT 0',
			'trend_reset' => 'trend_reset INT UNSIGNED NOT NULL DEFAULT 0', // 1.29.0 — content-change rank reset (see YouTube::recompute_course_trend)
			'lang'        => "lang VARCHAR(8) NOT NULL DEFAULT 'en'",        // 1.30.0 — catalogue language facet (?lang= filter)
		] as $col => $def ) {
			if ( ! self::column_exists( "{$p}aq_courses", $col ) ) {
				$wpdb->query( "ALTER TABLE {$p}aq_courses ADD COLUMN $def" );
			}
		}
		// 1.70.0 — a proposed new time for a meeting, and who proposed it. One pending proposal per
		// meeting is deliberate: two people trading times is a conversation, and they have one.
		foreach ( [
			'retime_ts' => 'retime_ts INT UNSIGNED NOT NULL DEFAULT 0',
			'retime_by' => 'retime_by BIGINT UNSIGNED NOT NULL DEFAULT 0',
		] as $col => $def ) {
			if ( ! self::column_exists( "{$p}aq_meets", $col ) ) {
				$wpdb->query( "ALTER TABLE {$p}aq_meets ADD COLUMN $def" );
			}
		}
		// 1.30.0 — same SQLite-safe explicit adds for the comment columns (anchored replies + appeals).
		foreach ( [
			'appealed' => 'appealed TINYINT(1) NOT NULL DEFAULT 0', // ArtaMod appeal used (one per comment)
			'anchor'   => 'anchor INT UNSIGNED NOT NULL DEFAULT 0', // seconds into the section video (0 = unanchored)
		] as $col => $def ) {
			if ( ! self::column_exists( "{$p}aq_comments", $col ) ) {
				$wpdb->query( "ALTER TABLE {$p}aq_comments ADD COLUMN $def" );
			}
		}
		// 1.62.1 — same SQLite-safe explicit adds for the competition C-to-C columns (dataset/model split).
		if ( self::table_exists( "{$p}aq_competitions" ) ) {
			foreach ( [
				'entry_fee' => 'entry_fee INT UNSIGNED NOT NULL DEFAULT 0', // ₳ per submission (0 = pre-split, free)
				'revenue'   => 'revenue BIGINT UNSIGNED NOT NULL DEFAULT 0', // Σ burned fees — settlement pays prize + 100% of this (all of it returns to participants)
			] as $col => $def ) {
				if ( ! self::column_exists( "{$p}aq_competitions", $col ) ) {
					$wpdb->query( "ALTER TABLE {$p}aq_competitions ADD COLUMN $def" );
				}
			}
		}

		// 1.62.3 — MEMBER CHALLENGES. (a) SQLite-safe explicit column adds; (b) the system rows'
		// dedup moves from UNIQUE(kind, season_key) to UNIQUE(slug) — drop the old unique key and
		// re-add it as a plain KEY (dbDelta never rebuilds an existing index); (c) backfill slugs on
		// the pre-1.62.3 rows (all system-owned) so the new unique key holds them.
		if ( self::table_exists( "{$p}aq_challenges" ) ) {
			foreach ( [
				'slug'      => 'slug VARCHAR(64) NULL',
				'title'     => "title VARCHAR(255) NOT NULL DEFAULT ''",
				'brief'     => 'brief TEXT NULL',
				'owner_uid' => 'owner_uid BIGINT UNSIGNED NOT NULL DEFAULT 0',
			] as $col => $def ) {
				if ( ! self::column_exists( "{$p}aq_challenges", $col ) ) {
					$wpdb->query( "ALTER TABLE {$p}aq_challenges ADD COLUMN $def" );
				}
			}
			$prev = $wpdb->suppress_errors( true ); // index churn is engine-dependent — each step is a no-op where it already holds
			$wpdb->query( "UPDATE {$p}aq_challenges SET slug = CONCAT(kind, '-s', season_key) WHERE (slug IS NULL OR slug = '') AND owner_uid = 0" );
			$wpdb->query( "ALTER TABLE {$p}aq_challenges DROP INDEX kind_season" );
			$wpdb->query( "ALTER TABLE {$p}aq_challenges ADD KEY kind_season (kind, season_key)" );
			$wpdb->query( "ALTER TABLE {$p}aq_challenges ADD UNIQUE KEY slug (slug)" );
			$wpdb->suppress_errors( $prev );
		}
		if ( self::table_exists( "{$p}aq_challenge_results" ) && ! self::column_exists( "{$p}aq_challenge_results", 'challenge_id' ) ) {
			$wpdb->query( "ALTER TABLE {$p}aq_challenge_results ADD COLUMN challenge_id BIGINT UNSIGNED NOT NULL DEFAULT 0" );
		}

		// 1.12.0 — denormalize each course's total view count (SUM of its DISTINCT videos' views) into
		// the new aq_courses.views column, so the cards can show a useful figure immediately (before the
		// daily refresh has produced 24h rates). One-time backfill, gated by an option flag; thereafter
		// the column is maintained by YouTube::recompute_course_trend on each refresh.
		if ( get_option( 'aq_views_backfilled' ) !== '1'
			&& self::column_exists( "{$p}aq_courses", 'views' )
			&& self::table_exists( "{$p}aq_videos" )
			&& class_exists( '\\AQ\\YouTube' ) ) {
			$cids = $wpdb->get_col( "SELECT id FROM {$p}aq_courses" );
			foreach ( (array) $cids as $cid ) { \AQ\YouTube::recompute_course_trend( (int) $cid ); }
			update_option( 'aq_views_backfilled', '1', true );
		}

		// 1.13.0 — seed a per-course view snapshot so the course-page growth chart has a starting
		// point immediately (the series then grows one point per HOUR via the cron, since 2026-06-12).
		// recompute_course_trend writes the snapshot as a side effect; one-time, gated by its own flag
		// (the 1.12.0 backfill above won't re-run on an already-backfilled install).
		if ( get_option( 'aq_course_stats_seeded' ) !== '1'
			&& self::table_exists( "{$p}aq_course_stats" )
			&& self::table_exists( "{$p}aq_videos" )
			&& class_exists( '\\AQ\\YouTube' ) ) {
			$cids = $wpdb->get_col( "SELECT id FROM {$p}aq_courses" );
			foreach ( (array) $cids as $cid ) { \AQ\YouTube::recompute_course_trend( (int) $cid ); }
			update_option( 'aq_course_stats_seeded', '1', true );
		}

		// 1.26.0 — the catalogue sort key is now the daily view velocity, not all-time average views
		// (ticket #19: rank by daily rate so newer/fast-rising courses rank fairly). Backfill rank_score
		// from the already-maintained `trend` column (Σ 24h view rate) with one portable UPDATE — no
		// FLOOR()/CAST portability worries and no YouTube class, so it's immune to the stale-opcode race a
		// per-course recompute can hit during the version-bump load. recompute_course_trend keeps it fresh
		// thereafter (per video refresh). Version-stamped so this (and any later bump) re-runs it.
		if ( get_option( 'aq_rank_backfilled' ) !== self::VERSION
			&& self::column_exists( "{$p}aq_courses", 'rank_score' )
			&& self::column_exists( "{$p}aq_courses", 'trend' ) ) {
			$wpdb->query( "UPDATE {$p}aq_courses SET rank_score = trend" );
			update_option( 'aq_rank_backfilled', self::VERSION, true );
		}

		// 1.15.0 — indexes for the unified /search LIKE scans (Search::all over courses/threads/grants).
		// dbDelta adds these on a FRESH MySQL CREATE, but never on an existing table, and the SQLite dev
		// integration silently skips ALL secondary indexes — so add each explicitly when absent (a no-op
		// once present, and harmlessly ignored on SQLite where ADD INDEX is a non-op). A contains-LIKE
		// (%q%) can't range-scan a B-tree, but these still serve prefix search + ORDER and are cheap.
		foreach ( [
			"{$p}aq_threads" => [ 'title' => 'ADD INDEX title (title(191))' ],
			"{$p}aq_grants"  => [
				'title'   => 'ADD INDEX title (title(191))',
				'funder'  => 'ADD INDEX funder (funder(191))',
				'summary' => 'ADD INDEX summary (summary(191))',
			],
		] as $tbl => $idxs ) {
			foreach ( $idxs as $name => $ddl ) {
				if ( ! self::index_exists( $tbl, $name ) ) {
					$wpdb->query( "ALTER TABLE {$tbl} $ddl" );
				}
			}
		}

		// 1.16.0 — ArtaMod (then named "the Fearometer"): every section-board comment is scored 0-100 for hate/fear on post.
		// `fear` stores that score; `flagged` (fear ≥ Fearometer::LIMIT) excludes the comment's upvotes
		// from the competition (Economy::podium). dbDelta SHOULD add both, but the SQLite dev integration
		// has been observed to bump the schema version while silently skipping an ADD COLUMN — so add each
		// explicitly when absent (a no-op on MySQL where dbDelta already added it). The podium query
		// references aq_comments.flagged, so this MUST land before that query runs post-deploy.
		// 1.32.0 adds `modq` (moderation-queued): section comments post with modq=1 and are scored
		// asynchronously on the subscription relay (Fearometer::process_queue) — the paid API was removed.
		// 1.34.0 adds `ref` — a JSON reference attached to a seed comment (the video's top YouTube
		// comment: author, avatar, likes, text, url), rendered as a "from YouTube" card on the board.
		foreach ( [
			'fear'    => 'fear TINYINT UNSIGNED NOT NULL DEFAULT 0',
			'flagged' => 'flagged TINYINT(1) NOT NULL DEFAULT 0',
			'modq'    => 'modq TINYINT(1) NOT NULL DEFAULT 0',
			'ref'     => 'ref TEXT NULL',
		] as $col => $def ) {
			if ( ! self::column_exists( "{$p}aq_comments", $col ) ) {
				$wpdb->query( "ALTER TABLE {$p}aq_comments ADD COLUMN $def" );
			}
		}

		// 1.17.0 — the SQLite dev integration has been observed to stamp the schema version while
		// silently skipping a brand-new dbDelta CREATE TABLE (the same class of race as the skipped
		// ADD COLUMNs above), which left aq_standing/aq_counters missing while the version read 1.17.0.
		// Guarantee both projection tables exist before the backfill + read paths touch them, by
		// re-running dbDelta for any that are absent — a no-op on MySQL where dbDelta already made them.
		$missing = array_filter( [ 'aq_standing', 'aq_counters', 'aq_quester' ], fn( $tk ) => ! self::table_exists( "{$p}{$tk}" ) );
		if ( $missing ) {
			require_once ABSPATH . 'wp-admin/includes/upgrade.php';
			$charset = $wpdb->get_charset_collate();
			$defs    = self::tables();
			foreach ( $missing as $tk ) { dbDelta( "CREATE TABLE {$p}{$tk} (\n{$defs[ $tk ]}\n) {$charset};" ); }
		}

		// 1.17.0 — build the materialized ledger projections (aq_standing / aq_counters) that the
		// leaderboard, per-user points standing, and the public reserve/supply total now read from. Pure
		// SQL (no class call) so it is immune to the stale-opcode race a version-bump load can hit, and
		// version-stamped so a later bump re-runs it. The runtime reads fall back safely to 0 if a row is
		// absent, but we populate fully here so the first post-deploy read is already correct + flat.
		if ( get_option( 'aq_proj_backfilled' ) !== self::VERSION
			&& self::table_exists( "{$p}aq_standing" ) && self::table_exists( "{$p}aq_counters" ) ) {
			$now = time();
			$wpdb->query( "DELETE FROM {$p}aq_standing" );
			// per-(track,user) totals, then the 'all' grand total per user (no real track is named 'all')
			$wpdb->query( "INSERT INTO {$p}aq_standing (track, user_id, points, updated)
				SELECT track, user_id, SUM(delta), $now FROM {$p}aq_points_ledger GROUP BY track, user_id" );
			$wpdb->query( "INSERT INTO {$p}aq_standing (track, user_id, points, updated)
				SELECT 'all', user_id, SUM(delta), $now FROM {$p}aq_points_ledger GROUP BY user_id" );
			$issued = (int) $wpdb->get_var( "SELECT COALESCE(SUM(delta),0) FROM {$p}aq_coin_ledger" );
			$wpdb->query( "DELETE FROM {$p}aq_counters WHERE name = 'coins_issued'" );
			$wpdb->query( $wpdb->prepare( "INSERT INTO {$p}aq_counters (name, value, updated) VALUES ('coins_issued', %d, %d)", $issued, $now ) );
			// Build the current-season quester buckets (the competition read accelerator). Done via the
			// canonical rebuilder so the backfill and the runtime maintenance share one definition of the
			// bucket — class is loaded here (other migrate blocks already call \AQ\YouTube safely).
			if ( self::table_exists( "{$p}aq_quester" ) && class_exists( '\\AQ\\Economy' ) ) {
				\AQ\Economy::rebuild_quester();
			}
			update_option( 'aq_proj_backfilled', self::VERSION, true );
		}

		// 1.19.0 — denormalize each section's comment tally onto aq_lessons.comment_count, so the board
		// header reads one column instead of COUNT(*)-ing a section that can hold millions of comments on
		// a popular course. dbDelta SHOULD add the column, but the SQLite dev integration may skip it
		// (same race as above) — add it explicitly when absent, then backfill once (version-stamped).
		if ( ! self::column_exists( "{$p}aq_lessons", 'comment_count' ) ) {
			$wpdb->query( "ALTER TABLE {$p}aq_lessons ADD COLUMN comment_count INT UNSIGNED NOT NULL DEFAULT 0" );
		}
		if ( get_option( 'aq_lesson_cc_backfilled' ) !== self::VERSION && self::column_exists( "{$p}aq_lessons", 'comment_count' ) ) {
			$wpdb->query( "UPDATE {$p}aq_lessons SET comment_count = ( SELECT COUNT(*) FROM {$p}aq_comments c WHERE c.context_type = 'section' AND c.context_id = {$p}aq_lessons.id )" );
			update_option( 'aq_lesson_cc_backfilled', self::VERSION, true );
		}

		// 1.31.0 — aq_lessons.created: when a section was added, so the comment-based trending churn
		// (ArtaCycle drops the least-discussed videos that have had ≥1h to attract comments) never
		// drops a brand-new section before it's had a fair chance. Explicit SQLite-safe add + a one-time
		// backfill: existing sections get their parent course's created time (a sane "old enough" floor).
		if ( ! self::column_exists( "{$p}aq_lessons", 'created' ) ) {
			$wpdb->query( "ALTER TABLE {$p}aq_lessons ADD COLUMN created INT UNSIGNED NOT NULL DEFAULT 0" );
		}
		if ( get_option( 'aq_lesson_created_backfilled' ) !== '1' && self::column_exists( "{$p}aq_lessons", 'created' ) ) {
			$wpdb->query( "UPDATE {$p}aq_lessons SET created = COALESCE( ( SELECT c.created FROM {$p}aq_courses c WHERE c.id = {$p}aq_lessons.course_id ), 0 ) WHERE created = 0" );
			$wpdb->query( "UPDATE {$p}aq_lessons SET created = " . time() . " WHERE created = 0" );
			update_option( 'aq_lesson_created_backfilled', '1', true );
		}

		// 1.20.0 — widen aq_quester's board index to (season_key, course_id, votes, comments) so the podium
		// read's full ORDER BY (votes DESC, comments DESC, user_id DESC) is a single reverse index walk, not
		// a filesort over a viral course's quester set (bench.sh: podium HOTSPOT→SCALABLE only with comments
		// in the index). dbDelta won't rebuild an existing index's columns, so drop+re-add explicitly. The
		// new shape is detected by adding `comments`; since the index name is unchanged, gate on a version
		// flag rather than index_exists (which only matches by name). No-op/harmless on SQLite dev.
		// 1.20.0 — index aq_courses for "most-enrolled courses" listings (Funds::bursary_list and any
		// popular-courses sort): WHERE status='publish' ORDER BY enroll_count DESC, id DESC → a reverse walk
		// of (status, enroll_count, id) + LIMIT instead of a filesort over every published course. dbDelta
		// won't add an index to an existing table reliably, so add it explicitly (no-op on SQLite dev).
		if ( get_option( 'aq_courses_enroll_idx' ) !== self::VERSION
			&& self::table_exists( "{$p}aq_courses" ) && ! self::index_exists( "{$p}aq_courses", 'status_enroll' ) ) {
			$wpdb->query( "ALTER TABLE {$p}aq_courses ADD INDEX status_enroll (status, enroll_count, id)" );
			update_option( 'aq_courses_enroll_idx', self::VERSION, true );
		}

		// 1.54.0 — index the (house × sign) "2-gram" cell the home recommender drills into (House → its
		// 12 sign-cells → the topics + courses in each). A cell's courses are WHERE status='publish' AND
		// topic=%s AND sign=%s ORDER BY rank_score DESC, id DESC — a reverse walk of the composite index +
		// LIMIT, instead of filtering (status, topic, rank_score, id) and re-sorting by sign; a cell's
		// topics read WHERE active=1 AND category=%s AND sign=%s off (active, category, sign). Both scale
		// the drill-down to 10000s of courses / 1000s of topics. dbDelta won't add an index to an existing
		// table reliably, so add explicitly + gate on a version flag (no-op on SQLite dev, idempotent).
		if ( get_option( 'aq_cell_idx' ) !== self::VERSION ) {
			if ( self::table_exists( "{$p}aq_courses" ) && self::column_exists( "{$p}aq_courses", 'sign' )
				&& ! self::index_exists( "{$p}aq_courses", 'status_topic_sign_rank' ) ) {
				$wpdb->query( "ALTER TABLE {$p}aq_courses ADD INDEX status_topic_sign_rank (status, topic, sign, rank_score, id)" );
			}
			if ( self::table_exists( "{$p}aq_topics" ) && ! self::index_exists( "{$p}aq_topics", 'active_cat_sign' ) ) {
				$wpdb->query( "ALTER TABLE {$p}aq_topics ADD INDEX active_cat_sign (active, category, sign)" );
			}
			update_option( 'aq_cell_idx', self::VERSION, true );
		}

		if ( get_option( 'aq_quester_idx' ) !== self::VERSION && self::table_exists( "{$p}aq_quester" ) ) {
			if ( self::index_exists( "{$p}aq_quester", 'board' ) ) {
				$wpdb->query( "ALTER TABLE {$p}aq_quester DROP INDEX board" );
			}
			$wpdb->query( "ALTER TABLE {$p}aq_quester ADD INDEX board (season_key, course_id, votes, comments)" );
			update_option( 'aq_quester_idx', self::VERSION, true );
		}

		// 1.21.0 — the autopilot dev loop: when the worker (tools/ticket-agent/) judges a queued ticket
		// would need a MAJOR architectural change, it holds the ticket (status='awaiting') and emails the
		// operator for a one-tap go-ahead instead of shipping. `arch_ok` records that go-ahead, so the
		// re-queued ticket is built without re-gating. dbDelta SHOULD add the column, but the SQLite dev
		// integration has been observed to skip an ADD COLUMN while stamping the version — so add it
		// explicitly when absent (a no-op on MySQL where dbDelta already added it).
		if ( ! self::column_exists( "{$p}aq_tickets", 'arch_ok' ) ) {
			$wpdb->query( "ALTER TABLE {$p}aq_tickets ADD COLUMN arch_ok TINYINT UNSIGNED NOT NULL DEFAULT 0" );
		}

		// 1.23.0 — PERSISTENT autopilot retries: the worker never abandons a ticket. `attempts` + `retry_after`
		// pace retries (exponential backoff that never stops) and survive a daemon restart; `claimed_at` lets
		// agent_queue re-queue a run orphaned by a dead worker (crash recovery) so a ticket is never stuck
		// 'in_progress'. dbDelta SHOULD add them; add explicitly when absent (no-op on MySQL).
		foreach ( [
			'attempts'    => 'attempts INT UNSIGNED NOT NULL DEFAULT 0',
			'retry_after' => 'retry_after INT UNSIGNED NOT NULL DEFAULT 0',
			'claimed_at'  => 'claimed_at INT UNSIGNED NOT NULL DEFAULT 0',
		] as $col => $def ) {
			if ( ! self::column_exists( "{$p}aq_tickets", $col ) ) {
				$wpdb->query( "ALTER TABLE {$p}aq_tickets ADD COLUMN $def" );
			}
		}

		// 1.58.0/.1 — competition prizes + public/private split. `prize`/`thread_id` on aq_competitions
		// (the coin pool + its official discussion thread) and `preds` on aq_comp_subs (the stored
		// predictions, so the private-half prize can be re-scored at the deadline). dbDelta SHOULD add
		// them; the SQLite dev integration has been observed to skip an ADD COLUMN while stamping the
		// version — so add each explicitly when absent (a no-op on MySQL where dbDelta already did).
		if ( self::table_exists( "{$p}aq_competitions" ) ) {
			foreach ( [
				'prize'     => 'prize INT UNSIGNED NOT NULL DEFAULT 0',
				'thread_id' => 'thread_id BIGINT UNSIGNED NOT NULL DEFAULT 0',
			] as $col => $def ) {
				if ( ! self::column_exists( "{$p}aq_competitions", $col ) ) {
					$wpdb->query( "ALTER TABLE {$p}aq_competitions ADD COLUMN $def" );
				}
			}
		}
		if ( self::table_exists( "{$p}aq_comp_subs" ) ) {
			foreach ( [
				'preds'        => 'preds MEDIUMTEXT NULL',
				'phase'        => 'phase MEDIUMTEXT NULL', // 1.61.0 — per-submission phase telemetry (topic-500 'phase-r2')
				'code_url'     => "code_url VARCHAR(300) NOT NULL DEFAULT ''",
				'method'       => 'method MEDIUMTEXT NULL',
				'review'       => "review VARCHAR(24) NOT NULL DEFAULT 'none'",
				'review_round' => 'review_round INT UNSIGNED NOT NULL DEFAULT 0',
				'verified'     => 'verified TINYINT(1) NOT NULL DEFAULT 0',
				'updated'      => 'updated DATETIME NULL',
			] as $col => $def ) {
				if ( ! self::column_exists( "{$p}aq_comp_subs", $col ) ) {
					$wpdb->query( "ALTER TABLE {$p}aq_comp_subs ADD COLUMN $def" );
				}
			}
		}

		// 1.22.0 — economy airtightness.
		// (a) UNIQUE (user, course) on aq_bursary — the durable backstop against a concurrent or replayed
		//     /bursary/apply double-granting a member (and so double-debiting the donation fund). dbDelta
		//     won't add a unique key to an existing table, so add it explicitly when absent (no-op on the
		//     SQLite dev integration, which doesn't enforce it but also never produces the dup at our scale).
		if ( get_option( 'aq_bursary_uniq' ) !== self::VERSION && self::table_exists( "{$p}aq_bursary" ) ) {
			if ( ! self::index_exists( "{$p}aq_bursary", 'user_course' ) ) {
				$wpdb->query( "ALTER TABLE {$p}aq_bursary ADD UNIQUE KEY user_course (user_id, course_id)" );
			}
			update_option( 'aq_bursary_uniq', self::VERSION, true );
		}
		// (b) Gold backing moves to an ATOMIC counter (aq_counters 'backing_mg') so concurrent buys / sells /
		//     bursary grants can't lose an update like the old aq_coin_backing_mg option's read-modify-write
		//     did. Seed the counter ONCE from the legacy option (preserving the live figure), or — if the
		//     option was never set — from the coins in circulation (genesis: existing circulation treated as
		//     fully backed). reserve() now reports the TRUE ratio, so the deliberate genesis seed avoids a
		//     spurious <1.0 for legitimately-backed coins.
		// GUARD ON PRESENCE, NOT ON VERSION. This block DELETES the backing counter and re-seeds it, so
		// keying it to self::VERSION made it re-run on EVERY schema bump — silently destroying the real
		// gold reserve and resetting it to "coins issued" on each deploy. It cost the operator's 1 g
		// once already (backing 1000 mg → 161). It is a genesis seed: it must run at most ONCE, ever.
		if ( ! get_option( 'aq_backing_counter' )
			&& self::table_exists( "{$p}aq_counters" ) && self::table_exists( "{$p}aq_coin_ledger" ) ) {
			$legacy = get_option( 'aq_coin_backing_mg', false );
			$issued = (int) $wpdb->get_var( "SELECT COALESCE(SUM(delta),0) FROM {$p}aq_coin_ledger" );
			$seed   = ( $legacy === false ) ? max( 0, $issued ) : (int) $legacy;
			$wpdb->query( "DELETE FROM {$p}aq_counters WHERE name = 'backing_mg'" );
			$wpdb->query( $wpdb->prepare( "INSERT INTO {$p}aq_counters (name, value, updated) VALUES ('backing_mg', %d, %d)", $seed, time() ) );
			update_option( 'aq_backing_counter', self::VERSION, true );
		}

		// 1.24.0 — effort-modulated tagging: a member may publicly stand with as many groups (typology
		// tags) as they have lifetime points (1-to-1; see Extra::tag_allowance). New members get
		// Economy::SIGNUP_POINTS welcome points on signup, so they start with that many slots. Backfill
		// the same welcome grant to every EXISTING member so the new cap doesn't strand anyone at zero
		// slots. award_points is idempotent per (user, 'welcome', 'welcome'), and the 'welcome' track is
		// excluded from the slot-unlock nudge — so this is replay-safe and sends no notifications.
		if ( get_option( 'aq_welcome_points_backfilled' ) !== self::VERSION
			&& self::table_exists( "{$p}aq_points_ledger" ) && class_exists( '\\AQ\\Economy' ) ) {
			foreach ( (array) $wpdb->get_col( "SELECT ID FROM {$wpdb->users}" ) as $uid ) {
				\AQ\Economy::award_points( (int) $uid, \AQ\Economy::SIGNUP_POINTS, 'welcome', 'welcome' );
			}
			update_option( 'aq_welcome_points_backfilled', self::VERSION, true );
		}

		// 1.25.0 — course subject taxonomy: every course gets ONE primary subject in aq_courses.topic
		// (denormalized slug), so the catalogue can FACET/filter as a single indexed keyset scan rather
		// than a join (see Topics.php). dbDelta SHOULD add the column + the two filter indexes, but the
		// SQLite dev integration has been observed to stamp the version while silently skipping an ADD
		// COLUMN / ADD INDEX — so add each explicitly when absent (a no-op on MySQL where dbDelta already
		// did). The backfill below writes the column, so the column add must precede it.
		if ( ! self::column_exists( "{$p}aq_courses", 'topic' ) ) {
			$wpdb->query( "ALTER TABLE {$p}aq_courses ADD COLUMN topic VARCHAR(40) NOT NULL DEFAULT ''" );
		}
		if ( get_option( 'aq_courses_topic_idx' ) !== self::VERSION && self::table_exists( "{$p}aq_courses" ) ) {
			foreach ( [
				'status_topic_rank' => 'ADD INDEX status_topic_rank (status, topic, rank_score, id)',
				'status_topic_id'   => 'ADD INDEX status_topic_id (status, topic, id)',
			] as $name => $ddl ) {
				if ( ! self::index_exists( "{$p}aq_courses", $name ) ) {
					$wpdb->query( "ALTER TABLE {$p}aq_courses $ddl" );
				}
			}
			update_option( 'aq_courses_topic_idx', self::VERSION, true );
		}
		// One-time classification pass: assign a subject to every still-unclassified course. The keyword
		// classifier is deterministic + dependency-free (no API call), so it is immune to the stale-opcode
		// race a version-bump load can hit; idempotent (only touches topic='' rows) and version-stamped so
		// a later bump re-runs it for courses imported since.
		if ( get_option( 'aq_topics_backfilled' ) !== self::VERSION
			&& self::column_exists( "{$p}aq_courses", 'topic' )
			&& class_exists( '\\AQ\\Topics' ) ) {
			\AQ\Topics::backfill();
			update_option( 'aq_topics_backfilled', self::VERSION, true );
		}

		// 1.35.0 — TOPIC (typology-system) REGISTRY: migrate the build-time typologies.data.json into the
		// aq_topics table so topics become authored (default /u/arash), editable in Studio, and sponsorable.
		// ONE-TIME seed from data/topics.json, gated on the table being empty (so a re-bump never clobbers
		// Studio edits / sponsorships / ArtaCycle DB writes — those upserts preserve author + sponsor). The
		// DB is the source of truth from here; the JSON is only the seed artifact.
		if ( ! get_option( 'aq_topics_seeded' )
			&& self::column_exists( "{$p}aq_topics", 'topic_key' )
			&& class_exists( '\\AQ\\Typology' )
			&& \AQ\Typology::count() === 0 ) {
			$r = \AQ\Typology::seed_from_file();
			if ( empty( $r['error'] ) ) { update_option( 'aq_topics_seeded', self::VERSION, true ); }
		}

		// 1.68.0 — seed the place-of-birth gazetteer. Guarded THREE ways because it is 34k rows: the
		// table must exist (dbDelta can silently skip it), the class must be loaded, and it must be
		// empty. Cities::seed() is itself idempotent, so a re-run costs one COUNT(*). The option
		// records the version that seeded it, which is also how a later dataset refresh is spotted.
		if ( get_option( 'aq_cities_seeded' ) !== self::VERSION
			&& self::table_exists( "{$p}aq_cities" )
			&& class_exists( '\\AQ\\Cities' ) ) {
			$loaded = \AQ\Cities::seed();
			if ( \AQ\Cities::count() > 0 ) { update_option( 'aq_cities_seeded', self::VERSION, true ); }
			if ( $loaded ) { error_log( '[aq] cities gazetteer seeded: ' . $loaded . ' rows' ); }
		}

		// 2026-08-15 — the founder's note on /about in Persian and Arabic, hand-written rather than
		// machine-translated (AboutI18n explains why, and how the rows survive the mesh). Presence-
		// gated on its own option, and the seeder is idempotent, so this costs one get_option() once
		// the seed has run. Guarded on the table existing because dbDelta can silently skip one.
		if ( ! get_option( \AQ\AboutI18n::SEEDED )
			&& self::table_exists( "{$p}aq_translations" )
			&& class_exists( '\\AQ\\AboutI18n' ) ) {
			$seeded = \AQ\AboutI18n::seed();
			error_log( '[aq] about note fa/ar: ' . $seeded );
		}

		// 1.36.0 — GRANTS are now authored + editable in Studio: assign every author-less grant (existing
		// rows + any future import insert) to the default creator (/u/arash). Only touches author_id=0, so a
		// hand-set author in Studio is never clobbered. Re-runs on bump to catch grants added since.
		if ( get_option( 'aq_grants_authored' ) !== self::VERSION && self::column_exists( "{$p}aq_grants", 'author_id' ) ) {
			$def = (int) get_option( 'aq_course_author_uid' );
			if ( ! $def ) { $admins = get_users( [ 'role' => 'administrator', 'number' => 1, 'fields' => 'ID' ] ); $def = $admins ? (int) $admins[0] : 1; }
			$wpdb->query( $wpdb->prepare( "UPDATE {$p}aq_grants SET author_id = %d WHERE author_id = 0", $def ) );
			update_option( 'aq_grants_authored', self::VERSION, true );
		}

		// 1.33.0 — SECOND-LEVEL catalogue facet (ticket #89): aq_courses.subtopic, the denormalized
		// sub-subject slug UNDER the course's house, so the catalogue + course-discussion surfaces can
		// drill DOWN from a house to its concrete subjects (Music, Physics…) as ONE indexed keyset scan
		// (status, topic, subtopic, rank_score|id) — never a join, mirroring the house facet above. Same
		// SQLite-skips-an-ADD safety as the topic column: add the column + the two filter indexes
		// explicitly when absent (a no-op on MySQL where dbDelta already did), THEN a one-time
		// deterministic backfill (the column must exist first). Each step is independently gated.
		if ( ! self::column_exists( "{$p}aq_courses", 'subtopic' ) ) {
			$wpdb->query( "ALTER TABLE {$p}aq_courses ADD COLUMN subtopic VARCHAR(40) NOT NULL DEFAULT ''" );
		}
		if ( get_option( 'aq_courses_subtopic_idx' ) !== self::VERSION && self::table_exists( "{$p}aq_courses" ) ) {
			foreach ( [
				'status_topic_sub_rank' => 'ADD INDEX status_topic_sub_rank (status, topic, subtopic, rank_score, id)',
				'status_topic_sub_id'   => 'ADD INDEX status_topic_sub_id (status, topic, subtopic, id)',
			] as $name => $ddl ) {
				if ( ! self::index_exists( "{$p}aq_courses", $name ) ) {
					$wpdb->query( "ALTER TABLE {$p}aq_courses $ddl" );
				}
			}
			update_option( 'aq_courses_subtopic_idx', self::VERSION, true );
		}
		// One-time sub-classification of every still-unclassified (subtopic='') course, scoped to its
		// stored house. Deterministic + offline (no API), so the stale-opcode race a version-bump load
		// can hit doesn't apply; gated by its own flag so unmatched rows aren't rescanned on later bumps.
		if ( get_option( 'aq_subtopics_backfilled' ) !== self::VERSION
			&& self::column_exists( "{$p}aq_courses", 'subtopic' )
			&& class_exists( '\\AQ\\Topics' ) ) {
			\AQ\Topics::backfill_sub();
			update_option( 'aq_subtopics_backfilled', self::VERSION, true );
		}

		// 1.43.0 — multi-discipline academic taxonomy: each course/topic links to MANY disciplines.
		// CSV columns are comma-wrapped (",a,b,") so SQLite-safe LIKE membership tests work.
		foreach ( [
			'disciplines' => "disciplines VARCHAR(255) NOT NULL DEFAULT ''",
			'houses'      => "houses VARCHAR(255) NOT NULL DEFAULT ''",
		] as $col => $def ) {
			if ( ! self::column_exists( "{$p}aq_courses", $col ) ) {
				$wpdb->query( "ALTER TABLE {$p}aq_courses ADD COLUMN $def" );
			}
		}
		if ( ! self::column_exists( "{$p}aq_topics", 'disciplines' ) ) {
			$wpdb->query( "ALTER TABLE {$p}aq_topics ADD COLUMN disciplines VARCHAR(512) NOT NULL DEFAULT ''" );
		}
		// 1.53.0 — per-topic Google-Trends demand score (-1 = not yet scored). The full series + score
		// components live in aq_trends; this denormalised column is for list display + sort.
		if ( ! self::column_exists( "{$p}aq_topics", 'trend_score' ) ) {
			$wpdb->query( "ALTER TABLE {$p}aq_topics ADD COLUMN trend_score SMALLINT NOT NULL DEFAULT -1" );
		}
		// 1.43.0 — one-time backfill of the academic-discipline classification from the shipped map
		// (topics by key, courses by SLUG so it is environment-stable). Idempotent + option-gated.
		if ( get_option( 'aq_disciplines_migrated' ) !== self::VERSION
			&& self::column_exists( "{$p}aq_courses", 'disciplines' )
			&& self::column_exists( "{$p}aq_topics", 'disciplines' ) ) {
			$mapfile = WP_PLUGIN_DIR . '/aquest/data/discipline-map.json';
			$map = is_readable( $mapfile ) ? json_decode( (string) file_get_contents( $mapfile ), true ) : null;
			if ( is_array( $map ) ) {
				foreach ( (array) ( $map['topics'] ?? [] ) as $key => $ds ) {
					$ds = \AQ\Topics::parse_discs( implode( ',', (array) $ds ) );
					if ( ! $ds ) { continue; }
					$wpdb->query( $wpdb->prepare( "UPDATE {$p}aq_topics SET disciplines = %s, category = %s WHERE topic_key = %s", ',' . implode( ',', $ds ) . ',', $ds[0], $key ) );
				}
				foreach ( (array) ( $map['courses'] ?? [] ) as $slug => $ds ) {
					$ds = \AQ\Topics::parse_discs( implode( ',', (array) $ds ) );
					if ( ! $ds ) { continue; }
					$hs = \AQ\Topics::houses_of( $ds );
					$wpdb->query( $wpdb->prepare( "UPDATE {$p}aq_courses SET disciplines = %s, houses = %s, topic = %s, subtopic = %s WHERE slug = %s", ',' . implode( ',', $ds ) . ',', ',' . implode( ',', $hs ) . ',', \AQ\Topics::disc_house( $ds[0] ), $ds[0], $slug ) );
				}
				update_option( 'aq_disciplines_migrated', self::VERSION, true );
			}
		}
		// 1.43.1 — rename the house 'law' → 'politics' (operator 2026-06-22). Houses are code-defined; this
		// migrates the DATA: the editable discipline registry option + course house refs (topic + houses CSV).
		if ( get_option( 'aq_law_to_politics' ) !== self::VERSION && self::column_exists( "{$p}aq_courses", 'houses' ) ) {
			$opt = (string) get_option( 'aq_disciplines', '' );
			if ( $opt !== '' ) {
				$list = json_decode( $opt, true );
				if ( is_array( $list ) ) {
					foreach ( $list as &$d ) { if ( ( $d['house'] ?? '' ) === 'law' ) { $d['house'] = 'politics'; } }
					unset( $d );
					update_option( 'aq_disciplines', wp_json_encode( $list ), false );
				}
			}
			$wpdb->query( "UPDATE {$p}aq_courses SET topic = 'politics' WHERE topic = 'law'" );
			$wpdb->query( "UPDATE {$p}aq_courses SET houses = REPLACE(houses, ',law,', ',politics,') WHERE houses LIKE '%,law,%'" );
			update_option( 'aq_law_to_politics', self::VERSION, true );
		}
		// 1.59.3 — repair the denormalized DISCOVERY columns (#155). The catalogue facet list + the
		// ?topic=/?subtopic= filters match on the `houses`/`disciplines` CSVs, but the create / import /
		// topic-backfill write paths only ever set the primary `topic`/`subtopic`, so a classified course
		// could carry an EMPTY `houses` and drop out of every topic filter. Fill any empty-`houses` row
		// from its stored topic + subtopic. Runs AFTER the topic backfill above (so topic is already set)
		// and the disciplines/law migrations (so a set membership is never overwritten). Deterministic +
		// offline, idempotent (only touches houses='' rows), version-gated so a later bump re-runs it for
		// courses imported since.
		if ( get_option( 'aq_course_membership_backfilled' ) !== self::VERSION
			&& self::column_exists( "{$p}aq_courses", 'houses' )
			&& class_exists( '\\AQ\\Topics' ) ) {
			\AQ\Topics::backfill_membership();
			update_option( 'aq_course_membership_backfilled', self::VERSION, true );
		}
		// 1.44.0 — astrological signature: every topic carries a SIGN (HOW) alongside its house (WHAT). [WHY/planet
		// is no longer a content tag — operator 2026-06-24; the column stays vestigial.] Add the columns, then assign
		// each existing topic its primary discipline's sign (defaults to the house's natural sign). Empty = "inherit".
		foreach ( [ 'sign', 'planet' ] as $col ) {
			if ( ! self::column_exists( "{$p}aq_topics", $col ) ) {
				$wpdb->query( "ALTER TABLE {$p}aq_topics ADD COLUMN $col VARCHAR(24) NOT NULL DEFAULT ''" );
			}
		}
		if ( get_option( 'aq_topics_astro' ) !== self::VERSION
			&& self::column_exists( "{$p}aq_topics", 'sign' )
			&& class_exists( '\\AQ\\Topics' ) ) {
			foreach ( (array) $wpdb->get_results( "SELECT id, category, sign FROM {$p}aq_topics", ARRAY_A ) as $r ) {
				$cat   = (string) $r['category'];
				$house = \AQ\Topics::disc_house( $cat ); if ( $house === '' ) { $house = \AQ\Topics::DEFAULT_HOUSE; }
				$sign  = \AQ\Topics::is_sign( (string) $r['sign'] ) ? (string) $r['sign'] : ( \AQ\Topics::disc_sign( $cat ) ?: \AQ\Topics::house_sign( $house ) );
				if ( $sign !== (string) $r['sign'] ) {
					$wpdb->update( "{$p}aq_topics", [ 'sign' => $sign ], [ 'id' => (int) $r['id'] ] );
				}
			}
			update_option( 'aq_topics_astro', self::VERSION, true );
		}
		// 1.47.0 — apply the What·How classification (operator 2026-06-22; WHY dropped as a content tag 2026-06-24).
		// Each discipline gets a FIELD (house) + a STYLE (`sign` = HOW) from data/astro-map.json (a few disciplines
		// are re-housed to their true field); each topic inherits its discipline's; each video gets its own from
		// data/video-class.json. Idempotent SET operations (safe to re-run); gated aq_class_v4 so it applies once per env.
		if ( get_option( 'aq_class_v4' ) !== self::VERSION
			&& self::column_exists( "{$p}aq_topics", 'sign' ) && self::column_exists( "{$p}aq_videos", 'house' )
			&& class_exists( '\\AQ\\Topics' ) ) {
			$mapfile = WP_PLUGIN_DIR . '/aquest/data/astro-map.json';
			$map = is_readable( $mapfile ) ? json_decode( (string) file_get_contents( $mapfile ), true ) : null;
			if ( is_array( $map ) && ! empty( $map['disciplines'] ) ) {
				$opt  = (string) get_option( 'aq_disciplines', '' );
				$list = $opt !== '' ? json_decode( $opt, true ) : null;
				if ( ! is_array( $list ) || ! $list ) { $list = \AQ\Topics::disciplines(); }
				$dmap = [];
				foreach ( $list as &$d ) {
					$k = (string) ( $d['key'] ?? '' );
					if ( isset( $map['disciplines'][ $k ] ) ) {
						$mh = (string) ( $map['disciplines'][ $k ]['house'] ?? '' );
						$ms = (string) ( $map['disciplines'][ $k ]['sign'] ?? '' );
						if ( \AQ\Topics::is_valid( $mh ) ) { $d['house'] = $mh; }   // re-house to its classified field
						if ( \AQ\Topics::is_sign( $ms ) )  { $d['sign'] = $ms; }
					}
					$d['sign'] = \AQ\Topics::is_sign( (string) ( $d['sign'] ?? '' ) ) ? $d['sign'] : \AQ\Topics::house_sign( (string) ( $d['house'] ?? '' ) );
					$dmap[ $k ] = [ 'sign' => (string) $d['sign'] ];
				}
				unset( $d );
				update_option( 'aq_disciplines', wp_json_encode( array_values( $list ) ), false );
				foreach ( (array) $wpdb->get_results( "SELECT id, category FROM {$p}aq_topics", ARRAY_A ) as $r ) {
					$c = (string) $r['category'];
					if ( isset( $dmap[ $c ] ) ) {
						$wpdb->update( "{$p}aq_topics", [ 'sign' => $dmap[ $c ]['sign'] ], [ 'id' => (int) $r['id'] ] );
					}
				}
				// each video its own one-hot tag (house + sign(HOW)); WHY is no longer a content tag.
				$vfile = WP_PLUGIN_DIR . '/aquest/data/video-class.json';
				$vmap  = is_readable( $vfile ) ? json_decode( (string) file_get_contents( $vfile ), true ) : null;
				if ( is_array( $vmap ) && ! empty( $vmap['videos'] ) ) {
					foreach ( $vmap['videos'] as $vid => $c ) {
						$h = (string) ( $c['house'] ?? '' ); $s = (string) ( $c['sign'] ?? '' );
						if ( \AQ\Topics::is_valid( $h ) && \AQ\Topics::is_sign( $s ) ) {
							$wpdb->update( "{$p}aq_videos", [ 'house' => $h, 'sign' => $s ], [ 'video' => (string) $vid ] );
						}
					}
				}
				delete_transient( 'aq_topic_facets_v3' );
				update_option( 'aq_class_v4', self::VERSION, true );
			}
		}

		// 1.47.0 — every published COURSE carries its What+How tags (topic/sign) so the balance wheels total
		// identically (operator 2026-06-22). The splitter sets them from each course's videos; this fills any
		// course still missing one from its field defaults. Idempotent (writes only when missing/invalid); gated.
		if ( get_option( 'aq_course_fill_v1' ) !== self::VERSION
			&& self::column_exists( "{$p}aq_courses", 'sign' ) && class_exists( '\\AQ\\Topics' ) ) {
			foreach ( (array) $wpdb->get_results( "SELECT id, topic, sign FROM {$p}aq_courses WHERE status = 'publish'", ARRAY_A ) as $r ) {
				$h  = \AQ\Topics::is_valid( (string) $r['topic'] ) ? (string) $r['topic'] : \AQ\Topics::DEFAULT_HOUSE;
				$s  = \AQ\Topics::is_sign( (string) $r['sign'] )   ? (string) $r['sign']   : \AQ\Topics::house_sign( $h );
				if ( $h !== (string) $r['topic'] || $s !== (string) $r['sign'] ) {
					$wpdb->update( "{$p}aq_courses", [ 'topic' => $h, 'sign' => $s ], [ 'id' => (int) $r['id'] ] );
				}
			}
			update_option( 'aq_course_fill_v1', self::VERSION, true );
		}

		// 1.49.0 — SOFTEN astrology/Vedic jargon in the user-facing astrology topic blurbs (operator: keep the
		// astrology courses but trim sidereal/Jyotish/etc. from their catalogue descriptions where not essential).
		// Plain synonyms only; subject names (nakshatra, Rahu/Ketu, BaZi, zodiac) are kept. Exact-string swaps in
		// order — idempotent (re-running once clean is a no-op); mirrors the same edits in typologies.data.json.
		// Scoped to the three astrology categories so real-astronomy terms (a "sidereal day") are never touched.
		if ( get_option( 'aq_astro_soften_v1' ) !== self::VERSION && self::column_exists( "{$p}aq_topics", 'blurb' ) ) {
			$repl = [
				[ 'the sidereal (Vedic / Jyotish) zodiac', 'the Vedic zodiac' ], [ 'sidereal (Vedic / Jyotish)', 'Vedic' ],
				[ 'tropical (Western)', 'Western' ], [ 'constellation-aligned', 'star-based' ],
				[ 'In Vedic astrology (Jyotisha),', 'In Vedic astrology,' ],
				[ ' (Jyotisha)', '' ], [ ' (Jyotish)', '' ], [ '(Jyotisha)', '' ], [ '(Jyotish)', '' ],
				[ 'Jyotisha', 'Indian' ], [ 'Jyotish', 'Indian' ],
				[ ' · Sidereal', ' · Vedic' ], [ ' · Tropical', ' · Western' ],
				[ 'sidereal', 'star-based' ], [ 'Sidereal', 'Star-based' ], [ 'tropical', 'Western' ], [ 'Tropical', 'Western' ],
				[ 'Hellenistic astrologers', 'ancient Greek astrologers' ], [ 'Hellenistic', 'ancient Greek' ],
				[ 'the ecliptic', 'the sky' ], [ 'ecliptic', 'sky' ],
			];
			$soften = function ( $s, $collapse ) use ( $repl ) {
				if ( ! is_string( $s ) || $s === '' ) { return $s; }
				foreach ( $repl as $r ) { $s = str_replace( $r[0], $r[1], $s ); }
				return $collapse ? preg_replace( '/  +/', ' ', $s ) : $s; // collapse only prose (not the options JSON)
			};
			$rows = (array) $wpdb->get_results( "SELECT id, name, blurb, status_note, self_describe, source, options FROM {$p}aq_topics WHERE category IN ( 'western-astrology', 'vedic-astrology', 'chinese-astrology' )", ARRAY_A );
			foreach ( $rows as $r ) {
				$upd = [];
				foreach ( [ 'name', 'blurb', 'status_note', 'self_describe', 'source' ] as $f ) {
					$n = $soften( (string) $r[ $f ], true );
					if ( $n !== (string) $r[ $f ] ) { $upd[ $f ] = $n; }
				}
				$o = $soften( (string) $r['options'], false ); // JSON column — swaps only, no space-collapse
				if ( $o !== (string) $r['options'] ) { $upd['options'] = $o; }
				if ( $upd ) { $wpdb->update( "{$p}aq_topics", $upd, [ 'id' => (int) $r['id'] ] ); }
			}
			delete_transient( 'aq_topic_facets_v3' );
			update_option( 'aq_astro_soften_v1', self::VERSION, true );
		}

		// 1.62.2 — SEASONS REFRAME (operator directive 2026-07-10): astrology leaves the platform
		// entirely — the only calendar is the twelve seasons (Seasons.php). DELETE the three
		// birth-sign typology categories' systems (also removed from the SPA registry + the
		// topics.json seed), scrub every member's saved tags/selections/endorsements that
		// referenced them, and drop the categories from the stored map. Idempotent + gated.
		if ( get_option( 'aq_astro_purge_v1' ) !== self::VERSION && self::column_exists( "{$p}aq_topics", 'category' ) ) {
			$cats = [ 'western-astrology', 'vedic-astrology', 'chinese-astrology' ];
			$in   = "'" . implode( "','", $cats ) . "'";
			$keys = (array) $wpdb->get_col( "SELECT topic_key FROM {$p}aq_topics WHERE category IN ($in)" );
			$wpdb->query( "DELETE FROM {$p}aq_topics WHERE category IN ($in)" );
			if ( $keys ) {
				foreach ( $keys as $k ) { // endorsements store tag = '<systemKey>:<optionKey>'
					$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_endorsements WHERE tag LIKE %s", $wpdb->esc_like( (string) $k ) . ':%' ) );
				}
				$set = array_flip( array_map( 'strval', $keys ) );
				$uids = (array) $wpdb->get_col( "SELECT DISTINCT user_id FROM {$wpdb->usermeta} WHERE meta_key IN ('aq_typology_tags','aq_typology_selections')" );
				foreach ( $uids as $uid ) {
					$uid  = (int) $uid;
					$tags = get_user_meta( $uid, 'aq_typology_tags', true );
					if ( ! is_array( $tags ) ) { $tags = json_decode( (string) $tags, true ); }
					if ( is_array( $tags ) ) {
						$kept = array_values( array_filter( $tags, function ( $t ) use ( $set ) { return ! isset( $set[ (string) ( $t['systemKey'] ?? '' ) ] ); } ) );
						if ( count( $kept ) !== count( $tags ) ) { update_user_meta( $uid, 'aq_typology_tags', $kept ); }
					}
					$sel = get_user_meta( $uid, 'aq_typology_selections', true );
					if ( ! is_array( $sel ) ) { $sel = json_decode( (string) $sel, true ); }
					if ( is_array( $sel ) ) {
						$kept_s = array_diff_key( $sel, $set );
						if ( count( $kept_s ) !== count( $sel ) ) { update_user_meta( $uid, 'aq_typology_selections', $kept_s ); }
					}
				}
			}
			$map = json_decode( (string) get_option( 'aq_topic_categories', '' ), true );
			if ( is_array( $map ) ) {
				$map = array_values( array_filter( $map, function ( $c ) use ( $cats ) { return ! in_array( (string) ( $c['key'] ?? '' ), $cats, true ); } ) );
				update_option( 'aq_topic_categories', wp_json_encode( $map ), false );
			}
			delete_transient( 'aq_topic_facets_v3' );
			update_option( 'aq_astro_purge_v1', self::VERSION, true );
		}
		// 1.41.0 — RETIRE the 'esoteric' house (ticket #139, completing #128): it was removed from
		// Topics::ALL and the Studio pick-a-house dropdown, with its keywords + subs (astrology, tarot,
		// numerology, divination, mysticism) folded into 'self'. Reassign every course still denormalized
		// as topic='esoteric' to 'self' so its content moves WITH the house — the ported subs keep each
		// course's subtopic valid, so no second-level reclassification is needed. Without this they would
		// fold into OTHER (Topics::facets treats an unknown slug as OTHER), not Self. Idempotent (no rows
		// match once applied) and version-stamped; the facet cache is busted so Esoteric vanishes at once
		// rather than lingering till the 5-min transient TTL.
		if ( get_option( 'aq_esoteric_folded' ) !== self::VERSION && self::column_exists( "{$p}aq_courses", 'topic' ) ) {
			$wpdb->query( "UPDATE {$p}aq_courses SET topic = 'self' WHERE topic = 'esoteric'" );
			delete_transient( 'aq_topic_facets_v2' );
			update_option( 'aq_esoteric_folded', self::VERSION, true );
		}

		// 1.47.0 — the one-hot What·How·Why classification columns (operator 2026-06-22). Each VIDEO carries
		// exactly one field (`house`), one style (`sign` = HOW) and one motivation (`planet` = WHY); each
		// COURSE carries its signature (`sign` + `planet`; its house is the existing `topic` column). These
		// drive the balance wheels, the recommendation engine, and per-course consistency (a course's videos
		// must share the same 3 classes). dbDelta won't ALTER an existing table, so add each column when
		// absent — idempotent (a no-op once present), so no version gate is needed.
		foreach ( [
			"{$p}aq_videos"  => [ 'house', 'sign', 'planet' ],
			"{$p}aq_courses" => [ 'sign', 'planet' ],
		] as $tbl => $cols ) {
			if ( ! self::table_exists( $tbl ) ) { continue; }
			foreach ( $cols as $col ) {
				if ( ! self::column_exists( $tbl, $col ) ) {
					$wpdb->query( "ALTER TABLE $tbl ADD COLUMN $col VARCHAR(40) NOT NULL DEFAULT ''" );
				}
			}
		}

		// 1.27.0 — trillion-row read-path indexes (the extreme-scale audit). dbDelta never adds an index
		// to an EXISTING table and the SQLite dev integration silently skips secondary indexes, so each is
		// added explicitly when absent (no-op once present). What each one closes:
		//   coin_ledger reason_ref   — enrol/buy/sell idempotency probes + per-season qreward SUM/claw-back
		//                              (exact ref + ref-prefix LIKE) were walking a whole reason partition.
		//   points_ledger user_track_ref — award_points' idempotency probe runs on EVERY point event and
		//                              scanned the member's whole lifetime ledger via (user_id, id).
		//   votes user_context       — the section board's "my votes here" read scanned every comment vote
		//                              the viewer ever cast (PK prefix), not just this lesson's.
		//   season_results user_id   — per-member "podium finishes" reads had NO user index and
		//                              full-scanned a table that grows with seasons × courses. (Added
		//                              for the since-removed engagement-badges feature, #68; kept —
		//                              harmless, and dropping an index would be a migration.)
		//   fund_ledger ref          — Stripe fulfilment's "already honoured?" probe full-scanned the
		//                              donation ledger on every payment.
		foreach ( [
			"{$p}aq_coin_ledger"    => [ 'reason_ref'     => 'ADD INDEX reason_ref (reason, ref)' ],
			"{$p}aq_points_ledger"  => [ 'user_track_ref' => 'ADD INDEX user_track_ref (user_id, track, ref)' ],
			"{$p}aq_votes"          => [ 'user_context'   => 'ADD INDEX user_context (user_id, context_id)' ],
			"{$p}aq_season_results" => [ 'user_id'        => 'ADD INDEX user_id (user_id)' ],
			"{$p}aq_fund_ledger"    => [ 'ref'            => 'ADD INDEX ref (ref)' ],
		] as $tbl => $idxs ) {
			foreach ( $idxs as $name => $ddl ) {
				if ( self::table_exists( $tbl ) && ! self::index_exists( $tbl, $name ) ) {
					$wpdb->query( "ALTER TABLE {$tbl} $ddl" );
				}
			}
		}
		// The old single-column KEY reason is a left prefix of reason_ref — pure write amplification on
		// the hottest append table once the new key exists. Drop it (errors suppressed; no-op when absent).
		if ( self::index_exists( "{$p}aq_coin_ledger", 'reason_ref' ) && self::index_exists( "{$p}aq_coin_ledger", 'reason' ) ) {
			$wpdb->query( "ALTER TABLE {$p}aq_coin_ledger DROP INDEX reason" );
		}

		// 1.27.0 — seed the fund-bucket counter projection ('fund_<bucket>' rows in aq_counters) from the
		// fund ledger, ONCE (flag, not version-stamped: a full-ledger GROUP BY per version bump would
		// itself not scale; live writes maintain the counters via Funds::fund_append, and drift repair is
		// Funds::rebuild_fund_counters via tools/verify-projections.php). finances(), bursary_fund_cents()
		// and the causes "raised" figures read these counters instead of SUMming the ledger.
		if ( get_option( 'aq_fund_counters_seeded' ) !== '1'
			&& self::table_exists( "{$p}aq_counters" ) && self::table_exists( "{$p}aq_fund_ledger" )
			&& class_exists( '\\AQ\\Funds' ) ) {
			\AQ\Funds::rebuild_fund_counters();
			update_option( 'aq_fund_counters_seeded', '1', true );
		}

		// 1.28.0 — the discussions rebuild (Reddit-style thread read model).
		// (a) `edited` flags on threads + comments so "· edited" survives a reload (it was client-state
		//     only). dbDelta SHOULD add them; the SQLite dev integration may skip an ADD COLUMN while
		//     stamping the version — add each explicitly when absent (no-op on MySQL).
		if ( ! self::column_exists( "{$p}aq_comments", 'edited' ) ) {
			$wpdb->query( "ALTER TABLE {$p}aq_comments ADD COLUMN edited TINYINT(1) NOT NULL DEFAULT 0" );
		}
		if ( ! self::column_exists( "{$p}aq_threads", 'edited' ) ) {
			$wpdb->query( "ALTER TABLE {$p}aq_threads ADD COLUMN edited TINYINT(1) NOT NULL DEFAULT 0" );
		}
		// (b) Backfill reply_count for PUBLIC thread comments. Social::comment historically never bumped
		//     it (only the section board did), but the rebuilt Social::thread pages replies through it —
		//     a stale 0 would hide every existing reply, and comment_delete's -1 underflowed the UNSIGNED
		//     column. Grouped read + per-parent UPDATE (engine-portable: MySQL forbids a self-referencing
		//     correlated UPDATE); bounded by distinct parents that have replies. Version-stamped.
		if ( get_option( 'aq_thread_rc_backfilled' ) !== self::VERSION && self::table_exists( "{$p}aq_comments" ) ) {
			$wpdb->query( "UPDATE {$p}aq_comments SET reply_count = 0 WHERE context_type = 'thread'" );
			$rows = $wpdb->get_results( "SELECT parent_id pid, COUNT(*) n FROM {$p}aq_comments WHERE context_type = 'thread' AND parent_id > 0 GROUP BY parent_id", ARRAY_A );
			foreach ( (array) $rows as $r ) {
				$wpdb->update( "{$p}aq_comments", array( 'reply_count' => (int) $r['n'] ), array( 'id' => (int) $r['pid'] ) );
			}
			update_option( 'aq_thread_rc_backfilled', self::VERSION, true );
		}

		// 1.37.0 — rename the legacy ArtaYAB-named i18n cache `ay_translations` → `aq_translations` so
		// every ArtaQuest table shares the aq_ prefix. SQL RENAME is NOT portable here — the SQLite dev
		// integration silently no-ops `ALTER … RENAME TO` and errors on `RENAME TABLE` — so do an
		// engine-portable COPY: ensure the destination exists, move the rows across (preserving id),
		// then drop the legacy table once every row has landed. Idempotent + resumable: the id-not-in
		// guard re-copies only what's missing, and the legacy table is dropped only when dst ≥ src, so a
		// half-finished run on a later load just completes. Once ay_translations is gone this is a no-op.
		if ( self::table_exists( "{$p}ay_translations" ) ) {
			// (a) Ensure aq_translations exists (dbDelta may have skipped the CREATE on the SQLite
			//     dev integration — the same skip the projection tables guard against above).
			if ( ! self::table_exists( "{$p}aq_translations" ) ) {
				require_once ABSPATH . 'wp-admin/includes/upgrade.php';
				$charset = $wpdb->get_charset_collate();
				$defs    = self::tables();
				dbDelta( "CREATE TABLE {$p}aq_translations (\n{$defs['aq_translations']}\n) {$charset};" );
			}
			// (b) Move rows the destination doesn't already hold (preserve id; resumable).
			if ( self::table_exists( "{$p}aq_translations" ) ) {
				$wpdb->query( "INSERT INTO {$p}aq_translations (id, lang, source_hash, source_text, translated_text, context, status, updated_at)
					SELECT id, lang, source_hash, source_text, translated_text, context, status, updated_at
					FROM {$p}ay_translations
					WHERE id NOT IN ( SELECT id FROM {$p}aq_translations )" );
				// (c) Drop the legacy table only once every row is across (never lose the cache).
				$src = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$p}ay_translations" );
				$dst = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$p}aq_translations" );
				if ( $dst >= $src && $src >= 0 ) {
					$wpdb->query( "DROP TABLE {$p}ay_translations" );
				}
			}
		}

		// 1.37.0 — drop the retired MasterStudy-LMS-fork tables (wp_artaquest_*: curriculum, markers,
		// subscriptions, user_courses/lessons/quizzes/assignments/cart/points, …). The LMS was retired
		// in the cutover; the platform uses the aq_* tables exclusively. These were empty/near-empty
		// shells that lingered post-cutover. DROP IF EXISTS → no-op on fresh installs (never had them)
		// and idempotent on re-run.
		foreach ( array(
			'artaquest_coupons', 'artaquest_curriculum_materials', 'artaquest_curriculum_sections',
			'artaquest_lesson_marker_questions', 'artaquest_lesson_marker_user_answers', 'artaquest_marker_stances',
			'artaquest_order_items', 'artaquest_subscriptions', 'artaquest_subscription_meta',
			'artaquest_subscription_plans', 'artaquest_subscription_plan_items', 'artaquest_user_answers',
			'artaquest_user_assignments', 'artaquest_user_assignments_times', 'artaquest_user_bookmarks',
			'artaquest_user_cart', 'artaquest_user_chat', 'artaquest_user_conversation', 'artaquest_user_courses',
			'artaquest_user_course_scorm', 'artaquest_user_lessons', 'artaquest_user_points',
			'artaquest_user_quizzes', 'artaquest_user_quizzes_times', 'artaquest_user_searches',
			'artaquest_user_searches_stats',
		) as $lms_t ) {
			$wpdb->query( "DROP TABLE IF EXISTS {$p}{$lms_t}" );
		}

		// 1.38.0 — store each video's thumbnail URL (aq_videos.thumb) and make a course's thumbnail its
		// HIGHEST-RATED video's thumbnail (universal rule, maintained by YouTube::recompute_course_trend).
		// dbDelta SHOULD add the column; add it explicitly when absent (the SQLite-skip safety used above).
		if ( ! self::column_exists( "{$p}aq_videos", 'thumb' ) ) {
			$wpdb->query( "ALTER TABLE {$p}aq_videos ADD COLUMN thumb VARCHAR(255) NOT NULL DEFAULT ''" );
		}
		// Backfill every video's thumb (derived from its id — offline, no API), then recompute every course
		// so aq_courses.image follows its top video. Deterministic, so it's immune to the version-bump opcode
		// race; version-stamped so a later bump re-runs it for videos added since.
		if ( get_option( 'aq_video_thumbs_backfilled' ) !== self::VERSION
			&& self::column_exists( "{$p}aq_videos", 'thumb' ) && class_exists( '\\AQ\\YouTube' ) ) {
			foreach ( (array) $wpdb->get_col( "SELECT video FROM {$p}aq_videos WHERE thumb = ''" ) as $vid ) {
				$t = \AQ\YouTube::thumb_url( (string) $vid );
				if ( $t !== '' ) { $wpdb->update( "{$p}aq_videos", array( 'thumb' => $t ), array( 'video' => $vid ) ); }
			}
			\AQ\YouTube::recompute_all_trends(); // sets each course's image = its highest-rated video's thumb
			update_option( 'aq_video_thumbs_backfilled', self::VERSION, true );
		}

		// 1.39.0 — Data-API DISCOVERY pipeline (operator 2026-06-21): the search.list rotation crawler tracks
		// promising NEW videos as standalone aq_videos rows MARKED as candidates for a course (cand_course), to
		// be PROVEN over a 24h incubation (cand_until) against the course's baseline rate at track time
		// (cand_baseline) before YouTube::settle_candidates either ADDS or DISCARDS them. dbDelta should add the
		// columns; add them explicitly when the SQLite dev integration skips the ALTER (as above).
		foreach ( array(
			'cand_course'   => 'BIGINT UNSIGNED NOT NULL DEFAULT 0',
			'cand_until'    => 'INT UNSIGNED NOT NULL DEFAULT 0',
			'cand_baseline' => 'BIGINT NOT NULL DEFAULT 0',
		) as $col => $type ) {
			if ( ! self::column_exists( "{$p}aq_videos", $col ) ) {
				$wpdb->query( "ALTER TABLE {$p}aq_videos ADD COLUMN {$col} {$type}" );
			}
		}

		// 1.40.0 — per-course DISCOVERY KEYWORDS (operator 2026-06-21): aq_courses.search_terms is the
		// editable search query the aq_discover crawler uses for this course (Studio-editable; falls back to
		// the course title when empty). Tuning it per course is how discovery reaches the most popular videos
		// for each subject rather than relying on a verbose course title.
		if ( ! self::column_exists( "{$p}aq_courses", 'search_terms' ) ) {
			$wpdb->query( "ALTER TABLE {$p}aq_courses ADD COLUMN search_terms VARCHAR(255) NOT NULL DEFAULT ''" );
		}

		// 1.42.0 — RAW YouTube stats (operator 2026-06-21): capture viewCount + likeCount alongside the
		// commentCount the monitor already stores (all three ride the SAME free part=statistics call). Comments
		// stay in `views` (legacy) so nothing downstream breaks; views/likes are raw columns that accrue going
		// forward (surfaced in the operator Console). (The per-course derivative sort keys added here were
		// retired in 1.55.0 with the views/likes analytics purge; existing columns are left in place, unused.)
		foreach ( array( 'view_count', 'like_count' ) as $col ) {
			if ( ! self::column_exists( "{$p}aq_videos", $col ) ) { $wpdb->query( "ALTER TABLE {$p}aq_videos ADD COLUMN {$col} BIGINT UNSIGNED NOT NULL DEFAULT 0" ); }
			if ( ! self::column_exists( "{$p}aq_video_stats", $col ) ) { $wpdb->query( "ALTER TABLE {$p}aq_video_stats ADD COLUMN {$col} BIGINT UNSIGNED NOT NULL DEFAULT 0" ); }
		}

		// 1.57.0 — self-seed the flagship "sky-vs-search" competition from the dataset bundled in the
		// plugin (data/competitions/sky-vs-search/*.gz), so a host that can't be reached over ssh still
		// gets the dataset inflated into uploads/ + the aq_competitions row inserted. Idempotent (no-op
		// once the row exists); runs only after the aq_competitions table is present.
		if ( class_exists( '\\AQ\\Competitions' ) && self::table_exists( "{$p}aq_competitions" ) ) {
			\AQ\Competitions::seed();
		}

		$wpdb->suppress_errors( $prev );
	}

	/** Portable "does this table exist" probe (suppresses the error a missing table would log). */
	private static function table_exists( $table ) {
		global $wpdb;
		$prev = $wpdb->suppress_errors( true );
		$wpdb->query( "SELECT 1 FROM `$table` LIMIT 1" );
		$ok = ( $wpdb->last_error === '' );
		$wpdb->suppress_errors( $prev );
		return $ok;
	}

	/** Portable "does this column exist" probe: SELECT it; a clean run means it exists.
	 *  Public: lesson-sync.inc.php guards its trend_reset stamp with it (the sync can run on a host
	 *  whose plugins push hasn't delivered the 1.29.0 column yet — deploy-ordering safety). */
	public static function column_exists( $table, $column ) {
		global $wpdb;
		$wpdb->query( "SELECT `$column` FROM `$table` LIMIT 1" );
		return $wpdb->last_error === '';
	}

	/**
	 * Portable "does this index exist" probe. SHOW INDEX on MySQL; falls back to sqlite_master on the
	 * dev SQLite integration (which doesn't report secondary indexes through SHOW INDEX). Wrapped in
	 * suppress_errors so a miss never logs — the caller treats "false" as "ALTER … ADD INDEX" (no-op
	 * if the engine already has it or silently skips it).
	 */
	private static function index_exists( $table, $index ) {
		global $wpdb;
		$prev  = $wpdb->suppress_errors( true );
		$found = false;
		$rows  = $wpdb->get_results( "SHOW INDEX FROM `$table`", ARRAY_A );
		if ( is_array( $rows ) ) {
			foreach ( $rows as $r ) {
				if ( isset( $r['Key_name'] ) && $r['Key_name'] === $index ) { $found = true; break; }
			}
		}
		if ( ! $found ) {
			$n = $wpdb->get_var( $wpdb->prepare(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = %s AND name = %s",
				$table, $index
			) );
			$found = ! empty( $n );
		}
		$wpdb->suppress_errors( $prev );
		return $found;
	}
}
