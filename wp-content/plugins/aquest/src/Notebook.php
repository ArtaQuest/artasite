<?php
namespace AQ;

/**
 * The Notebook Feed — ONE authoring principle for the whole platform (operator order 2026-07-13).
 *
 * Every submission on ArtaQuest, in every category, is a single reproducible Jupyter notebook
 * (`.ipynb`) authored in the universal Studio editor. The relay executes it in an OFFLINE sandbox
 * (no network — a run must reproduce from the file alone) and scores it FREE (operator orders
 * 2026-07-22, the v2 tightening).
 *
 * Publication is a THREE-KEY gate, strictly in order:
 *   1. THE MEASUREMENT — every rubric category is one CONTINUOUS TRADE-OFF AXIS scored by a
 *      deterministic formula (nb-metrics v3; formulas + literature in SUBMISSIONS.md). A score
 *      is a POSITION: 50.0 = the calibrated ideal, [SAFE_LO, SAFE_HI] = the middle-20 safe
 *      zone, and BOTH directions fail (terse ↔ wordy; ink too dark ↔ too light — WCAG walls
 *      with the ArtaContrast Density-Law midpoint as centre; static ↔ frantic). EVERY category
 *      must sit inside the zone and BALANCE = 100 − 2·mean|score−50| must reach PASS_SCORE, or
 *      the pipeline STOPS — the AI panel is never convened. Numbers, not opinions, are the
 *      score of record (seat-0 review, continuous to one decimal).
 *   2. THE VETO PANEL — PANEL_SIZE independent reviewers, each double-blind (never told the
 *      author, never shown a previous review or score) and memoryless (a fresh agent per review,
 *      nothing carried over), verify what formulas cannot: prose that lies about the code,
 *      metric gaming, semantic fraud. All must verdict "pass" — unanimity or nothing; their
 *      numbers never move the score. Both keys bind to sha1 of the exact source scored, plus a
 *      fresh clean offline execution (out_sig) and the dark+light teaser pair.
 *   3. THE AUTHOR'S INBOX (operator 2026-07-23) — publishing is requested, never taken, and
 *      the CONTENT CREATOR alone decides it. The request emails the author's own registered
 *      address a confirm link carrying a SINGLE-USE RANDOM SECRET minted at send time; only
 *      their explicit POST with that secret PUBLISHES the work and mints the permanent DOI
 *      (ledger model 'author'). An API token or AI agent can REQUEST publication but can
 *      never stand in for this email. Only the sha256(raw|sig) hash is stored (the DB is
 *      public; the raw secret exists nowhere but the author's inbox), so NOTHING running on
 *      the server — no agent, no wp-cli, no reflection — can construct a valid confirmation.
 *      GET shows a review page; only the explicit POST acts; the secret is spent atomically
 *      with the publish flip. integrity_sweep() demotes + alerts on any published row missing
 *      the matching author ledger row, so even a direct SQL status flip is reverted, not
 *      trusted. NO operator/admin email exists anywhere in this flow.
 * Anything below the gate stays a DRAFT — visible only in its author's Studio, never listed.
 *
 * Kinds are lenses over the same substrate, not separate systems: each kind names the deliverable
 * the notebook must produce into out/ (see KINDS). Watching/reading is free for everyone; the
 * scoring is free for everyone (ArtaDev, the old paid loop, is retired — dev_cost remains only
 * for legacy ledger rows).
 *
 * Tables self-install (aq_notebook_table_version), separate from Schema::VERSION, per the studio
 * pattern. Money is append-only ledger rows only (never mutated), refs `nbdev:<nb>:<run>`.
 */
final class Notebook {

	const TABLE_VERSION = '22'; // 22 = the Kaggle checklist reset: kg_* columns + aq_library

	/** Publishing REQUIRES the author's device passkey signature (operator 2026-07-24: "only the
	 *  user can publish, not even server/source access"). Email-only confirmation is forgeable by
	 *  a server-root actor (it can compute the token hash); ONLY an off-server device signature
	 *  makes a publish unforgeable. With this true, an author must enrol a passkey before they can
	 *  publish — and every published row then carries a signature the sweep re-verifies from public
	 *  data. Flip to false only to accept the weaker email-only guarantee. */
	const REQUIRE_PASSKEY = true;

	/** Publication gate v3 — THE TRADE-OFF GATE (operator orders 2026-07-22): every rubric
	 *  category is a CONTINUOUS trade-off axis scored by deterministic formula (nb-metrics v3).
	 *  A score is a POSITION: 50.0 = the calibrated ideal (exactly attainable — floats, one
	 *  decimal), [SAFE_LO, SAFE_HI] = the middle-20 safe zone, and BOTH directions away from
	 *  the middle fail (code too terse ↔ too wordy; ink too dark ↔ too light; motion too
	 *  static ↔ too frantic). The gate demands EVERY category inside the zone and the headline
	 *  BALANCE = 100 − 2·mean(|score − 50|) at PASS_SCORE or better; below that the pipeline
	 *  stops before any AI reviews. Only zone-passing work convenes the PANEL_SIZE-seat
	 *  double-blind, memoryless veto panel, which must be unanimous. Passing both only
	 *  REQUESTS publication — the admin approves by email before anything mints. */
	const PASS_SCORE = 80;   // minimum BALANCE (100 = every axis exactly at its ideal)
	const SAFE_LO    = 40.0; // the safe zone: the middle 20 around the ideal 50.0
	const SAFE_HI    = 60.0;
	const PANEL_SIZE = 3;    // independent blind veto reviews required per source version

	/** The only inbox that can approve a publication (operator order 2026-07-22, → support 07-22). */
	/** Security-ALERT address only (integrity_sweep watchdog). Publication approval never goes
	 *  here — the author's own registered email is the sole approval inbox (operator 2026-07-23). */
	const ADMIN_EMAIL = 'support@artaquest.org';

	/** Legacy size unit (the retired ArtaDev fee); kept for old ledger maths only. */
	const FEE_BYTES = 102400;

	/** ArtaCritic rubrics — a DIFFERENT rubric per content type (operator 2026-07-16; v2 core
	 *  2026-07-22). EVERY category is OBJECTIVE: scored 0-100 by a deterministic formula in the
	 *  relay's measurement engine (tools/ticket-agent/nb-metrics.py — the nb-calm precedent
	 *  generalised; formulas + literature in SUBMISSIONS.md), never by model opinion. The
	 *  measured scorecard is posted as the run's seat-0 review; the blind reviewer panel holds
	 *  only a unanimous VETO (verdict pass|fix) over what formulas cannot see — untrue prose,
	 *  metric gaming, semantic fraud — and can neither add nor subtract points.
	 *  The universal six:
	 *    runnability     — clean top-to-bottom offline execution (exec result + timing budget)
	 *    reproducibility — the notebook is executed TWICE; deliverable bytes must match; seeded,
	 *                      derived-bytes only (ACM artifact-badging criterion)
	 *    deliverable     — the kind's contract artifact exists AND validates mechanically
	 *    readability     — code words/symbols ratio, comment density, cell/line discipline
	 *    education       — stated objectives, heading hierarchy, prose/figure interleaving,
	 *                      takeaways, Flesch-Kincaid band (Mayer multimedia principles)
	 *    accessibility   — WCAG-derived: theme-safe transparent figures, ink contrast measured
	 *                      against BOTH theme backgrounds, wall-of-text limit, flash safety */
	const RUBRIC_CORE = [ 'runnability', 'reproducibility', 'deliverable', 'readability', 'education', 'accessibility' ];
	const RUBRICS = [
		'survey'         => [ 'schema', 'balance', 'items', 'analysis' ],
		'dataset'        => [ 'schema', 'completeness', 'uniqueness', 'documentation' ],
		'model'          => [ 'artifact', 'evaluation', 'baseline', 'transparency' ],
		'article'        => [ 'structure', 'evidence', 'statistics', 'self_contained' ],
		'illustration2d' => [ 'focus', 'resolution', 'palette', 'provenance' ],
		'illustration3d' => [ 'focus', 'resolution', 'geometry', 'provenance' ],
		'animation2d'    => [ 'motion', 'smoothness', 'duration', 'calmness' ],
		'animation3d'    => [ 'motion', 'smoothness', 'geometry', 'calmness' ],
		'game2d'         => [ 'self_contained', 'interactivity', 'animation', 'determinism' ],
		'game3d'         => [ 'self_contained', 'interactivity', 'depth', 'determinism' ],
		// FIVE axes, alone on the roster (operator 2026-07-26): a track is independently measurable
		// in more dimensions than a still frame — structure, dynamics, tone and level are separate
		// masters, standards-derived (ITU-R BS.1770-4 loudness, EBU Tech 3342 range) — and the fifth
		// axis IS the model requirement: no named, sha256-bound weights, no music kind.
		'music'          => [ 'arrangement', 'dynamics', 'spectrum', 'loudness', 'weights' ],
	];

	/** The measured seat: the deterministic scorecard is stored as the run's iter-0 review with
	 *  this model tag; panel() gates the floors and the mean on IT, and on it alone. */
	const METRICS_MODEL = 'nb-metrics';

	/** Pre-2026-07-22 kind values → their new home on the 11-kind roster (SPA mirrors this as
	 *  LEGACY_NB_KIND). Prod content was purged with the v2 pivot, so this exists for stale
	 *  CDN-cached cards, local dev databases and the one-shot migrate_kinds() below.
	 *  'music' deliberately has NO row: it is a first-class kind again (operator 2026-07-26), and a
	 *  mapping here would rewrite live music into articles the next time migrate_kinds() runs. */
	const LEGACY_KINDS = [
		'paper' => 'article', 'book' => 'article', 'playlist' => 'article',
		'presentation' => 'article',
		'illustration' => 'illustration2d', 'animation' => 'animation2d', 'game' => 'game2d',
	];

	/** One-shot wp-cli helper: rewrite legacy kind values in place (idempotent; sig untouched —
	 *  kind is not part of the source hash). Run via `wp eval 'echo AQ\Notebook::migrate_kinds();'`. */
	public static function migrate_kinds() {
		self::ensure_tables();
		global $wpdb;
		$n = 0;
		foreach ( self::LEGACY_KINDS as $old => $new ) {
			$n += (int) $wpdb->query( $wpdb->prepare(
				'UPDATE ' . Data::t( 'aq_notebooks' ) . ' SET kind = %s WHERE kind = %s', $new, $old ) );
		}
		return "migrated {$n} rows";
	}

	/** The full rubric a review of this kind must score: 6 universal + the kind's own 4-5. */
	public static function rubric( $kind ) {
		return array_merge( self::RUBRIC_CORE, self::RUBRICS[ $kind ] ?? [ 'correctness', 'originality', 'craft', 'impact' ] );
	}

	/** Challenge podium: % of the pool by hearts rank when the month closes (remainder → 1st). */
	const POOL_SPLIT = [ 50, 30, 20 ];

	const MAX_ITERS       = 12;
	const MAX_IPYNB_BYTES = 2097152;  // 2 MB source cap
	/** requirements.txt: an environment, never a distribution. The cap that MEANS anything is the
	 *  PIN count — blank lines and comments install nothing, so they are free (a 40-pin file, the
	 *  advertised maximum, must actually be saveable; counting every line made it unreachable and
	 *  charged an author for the newline their textarea ends with). These three numbers are the
	 *  published contract (SUBMISSIONS.md, the Studio editor's own hint) — change all three together. */
	const MAX_REQ_PINS    = 40;       // pinned requirements (comments/blank lines don't count)
	const MAX_REQ_LINES   = 100;      // …total lines, so a documented file has room to explain itself
	const MAX_REQ_BYTES   = 4000;     // …and it drives an install, so it stays small enough to read
	const MAX_MODELS      = 4;        // declared external models per submission (metadata.aq.models)
	const MAX_MODEL_FILES = 8;        // weight files provisioned per RUN, across every declared model
	                                  //   — the relay's own shelf cap (notebook-relay.mjs); a
	                                  //   declaration it could never provision is refused at save time
	const PAGE            = 24;

	/** kind => the offline deliverable the executed notebook must produce (measured + veto-enforced).
	 *  THE ROSTER (operator orders 2026-07-22, Music restored 2026-07-26): eleven kinds — Survey,
	 *  Dataset, Model, Article, 2D/3D Illustration, 2D/3D Animation, 2D/3D Game, Music. 3D kinds
	 *  must additionally write the geometry itself (out/scene.obj, plain Wavefront OBJ derived in
	 *  the cells) so the third dimension is a measurable artifact, never a style claim; Music must
	 *  additionally NAME the exact weights that RENDER its audio and bind them to it by sha256
	 *  (out/render.json) — trained in its own cells, or declared at an immutable revision — so a
	 *  listener can render the piece again for themselves.
	 *  Every contract here is now read THROUGH the submission's own requirements file (operator
	 *  2026-07-26): the environment is authored, not fixed, so no kind is limited to what the base
	 *  venv happens to ship. What a deliverable must BE never changes; how you may build it does. */
	const KINDS = [
		'survey'         => 'out/instrument.json — a survey instrument the platform can administer like a typology: items[] each with id, text, scale (its subscale) and reverse flag, plus scales[] and 5-point response labels, so the feed can render it answerable and score a per-subscale profile on-device; plus an analysis pipeline demonstrated end-to-end on SEEDED SIMULATED responses (never a pasted corpus — every byte derived in the cells)',
		'dataset'        => 'out/data.csv — a dataset built deterministically by the code, with an inline datasheet (schema, provenance, license, units)',
		'model'          => 'out/model.json — serialised weights of a model trained offline in the notebook, with held-out metrics, a stated baseline and an evaluation figure',
		'article'        => 'the notebook IS the article: a readable, educational piece with its figures computed inline; out/article.html compiled by the code, self-contained with its own colours',
		'illustration2d' => 'out/artwork.png — a procedural 2D artwork drawn entirely by the code (also displayed inline)',
		'illustration3d' => 'out/artwork.png — a rendered view of a 3D scene the code built — PLUS out/scene.obj, the scene\'s geometry as plain Wavefront OBJ derived in the cells (the third dimension must be a measurable artifact)',
		'animation2d'    => 'out/animation.gif or out/animation.mp4 — a rendered 2D animation produced by the code. SAFE CHANGE-RATE RULE: the animation is machine-measured (flicker, motion, cuts, chroma); more than 3 luminance flashes per second FAILS the run outright, and the slower the change the better the calmness score',
		'animation3d'    => 'out/animation.gif or out/animation.mp4 — a rendered animation of a 3D scene (camera or geometry genuinely moving in depth) — PLUS out/scene.obj, the underlying geometry as plain Wavefront OBJ derived in the cells. The same SAFE CHANGE-RATE RULE as 2D animation applies',
		'game2d'         => 'out/game.html — a FULLY SELF-CONTAINED playable 2D game living entirely inside the feed (no external service, no server): its whole source is WRITTEN BY THE NOTEBOOK\'S OWN CODE (never a pasted blob), deterministic (seeded PRNG, never bare Math.random), with in-notebook assertions that the page\'s embedded constants equal the notebook\'s proven model. It MUST offer both a bot mode and a two-player same-device mode selectable on a start screen, and every move and outcome must be ANIMATED with visuals GENERATED BY THE NOTEBOOK\'S OWN CODE (parametric SVG/canvas art) — never static text buttons',
		'game3d'         => 'out/game.html — the same fully self-contained, deterministic, bot + two-player contract as the 2D game, but genuinely THREE-DIMENSIONAL: real-time perspective (raw WebGL, or the notebook\'s own projection mathematics onto canvas) with depth the player moves through — not a flat game wearing a 3D skin',
		'music'          => 'out/track.wav — an ORIGINAL piece of music RENDERED FROM A GENERATIVE MODEL (44.1 kHz 16-bit PCM, mono or stereo, 45–480 s, seeded and byte-stable), the model being EITHER (i) one THE NOTEBOOK TRAINS OFFLINE IN ITS OWN CELLS and ships beside the audio as out/weights.safetensors, OR (ii) one it DECLARES and renders from — metadata.aq.models = [ { "repo": "owner/name", "revision": "<40-hex commit>", "files": [ { "file": "model.safetensors", "sha256": "<64 hex>" } ] } ]: an immutable commit says WHICH bytes (a branch or a tag is not a revision) and the per-file sha256 lets the runner PROVE it fetched them — unverifiable weights are never placed in the sandbox — or an already-published ArtaQuest music model cited by its notebook id — installed through this submission\'s own requirements file and provisioned before the offline run. EITHER WAY the notebook writes out/render.json = {"track_sha256": "<sha256 of out/track.wav>", "model": {"source": "own"|"hf"|"artaquest", "ref": "<hf repo@revision/file, or nb id, or empty for own>", "weights_sha256": "<sha256 of the weights file>", "params": <int>, "sample_rate": 44100, "seed": <int>}}, so the audio stays CRYPTOGRAPHICALLY BOUND to the exact weights that rendered it — that binding IS the kind — and it must reload those weights from disk, re-render, assert the result matches out/track.wav byte for byte, and show an inline waveform + spectrogram figure. Own-trained weights publish to the platform CDN, so anyone can fetch them from the work\'s permanent /weights address and render the piece again. No samples, no pasted audio, no unpinned download — every byte either derived in the cells or fetched from a pinned revision.',
	];

	// ── Schema (self-installed) ──────────────────────────────────────────────
	//
	// NOTHING may be commented INSIDE the CREATE TABLE body below. Under Studio's SQLite emulation an
	// inline `--` comment makes dbDelta emit NO TABLE AT ALL, silently — so notes about a column go
	// here, above the call, and never beside the column.
	//
	// `hf_url` is INERT as of the HuggingFace purge (operator 2026-08-02): nothing writes it and card()
	// no longer serves it. The column stays because dbDelta only adds and widens, and because every row
	// of this table is public record — dropping it would rewrite history rather than end a practice.

	public static function ensure_tables() {
		if ( get_option( 'aq_notebook_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		$p       = $wpdb->prefix;
		dbDelta( "CREATE TABLE {$p}aq_notebooks (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			kind VARCHAR(16) NOT NULL DEFAULT '',
			slug VARCHAR(190) NOT NULL DEFAULT '',
			title VARCHAR(200) NOT NULL DEFAULT '',
			abstract TEXT,
			ipynb LONGTEXT,
			requirements LONGTEXT,
			ipynb_out LONGTEXT,
			out_sig CHAR(40) NOT NULL DEFAULT '',
			assets LONGTEXT,
			thumb VARCHAR(600) NOT NULL DEFAULT '',
			teaser VARCHAR(600) NOT NULL DEFAULT '',
			teaser_light VARCHAR(600) NOT NULL DEFAULT '',
			calm SMALLINT NOT NULL DEFAULT 100,
			calm_measured TINYINT NOT NULL DEFAULT 0,
			size_bytes INT UNSIGNED NOT NULL DEFAULT 0,
			status VARCHAR(12) NOT NULL DEFAULT 'draft',
			score SMALLINT NOT NULL DEFAULT -1,
			hearts INT NOT NULL DEFAULT 0,
			comments INT NOT NULL DEFAULT 0,
			doi VARCHAR(80) NOT NULL DEFAULT '',
			record_url VARCHAR(300) NOT NULL DEFAULT '',
			colab_url VARCHAR(300) NOT NULL DEFAULT '',
			kaggle_url VARCHAR(300) NOT NULL DEFAULT '',
			hf_url VARCHAR(300) NOT NULL DEFAULT '',
			view_count INT UNSIGNED NOT NULL DEFAULT 0,
			season CHAR(7) NOT NULL DEFAULT '',
			created INT UNSIGNED NOT NULL DEFAULT 0,
			updated INT UNSIGNED NOT NULL DEFAULT 0,
			published_at INT UNSIGNED NOT NULL DEFAULT 0,
			approved_at INT UNSIGNED NOT NULL DEFAULT 0,
			approve_sig CHAR(40) NOT NULL DEFAULT '',
			req_sig CHAR(40) NOT NULL DEFAULT '',
			author_token CHAR(64) NOT NULL DEFAULT '',
			author_nonce CHAR(48) NOT NULL DEFAULT '',
			decision_note VARCHAR(600) NOT NULL DEFAULT '',
			kg_owner VARCHAR(80) NOT NULL DEFAULT '',
			kg_slug VARCHAR(140) NOT NULL DEFAULT '',
			kg_url VARCHAR(300) NOT NULL DEFAULT '',
			kg_facts LONGTEXT,
			checks LONGTEXT,
			selection LONGTEXT,
			checked_at INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY slug (slug),
			KEY kernel (kg_owner, kg_slug),
			KEY author (author_id, id),
			KEY feed (status, kind, id),
			KEY pub (status, id),
			KEY comp (kind, season, hearts),
			KEY top (status, hearts, id)
		) {$charset};" );
		dbDelta( "CREATE TABLE {$p}aq_nb_pools (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			kind VARCHAR(16) NOT NULL DEFAULT '',
			season CHAR(7) NOT NULL DEFAULT '',
			pool INT NOT NULL DEFAULT 0,
			state VARCHAR(8) NOT NULL DEFAULT 'open',
			results LONGTEXT,
			settled_at INT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY kind_season (kind, season),
			KEY state (state, season)
		) {$charset};" );
		dbDelta( "CREATE TABLE {$p}aq_nb_runs (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			nb_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			type VARCHAR(4) NOT NULL DEFAULT 'run',
			iters SMALLINT NOT NULL DEFAULT 0,
			iters_done SMALLINT NOT NULL DEFAULT 0,
			state VARCHAR(10) NOT NULL DEFAULT 'queued',
			claim VARCHAR(24) NOT NULL DEFAULT '',
			sig CHAR(40) NOT NULL DEFAULT '',
			req_sig CHAR(40) NOT NULL DEFAULT '',
			cost INT NOT NULL DEFAULT 0,
			score SMALLINT NOT NULL DEFAULT -1,
			error TEXT,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			updated INT UNSIGNED NOT NULL DEFAULT 0,
			claimed_at INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY state_id (state, id),
			KEY nb (nb_id, id)
		) {$charset};" );
		dbDelta( "CREATE TABLE {$p}aq_nb_reviews (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			nb_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			run_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			iter SMALLINT NOT NULL DEFAULT 0,
			score SMALLINT NOT NULL DEFAULT 0,
			verdict VARCHAR(8) NOT NULL DEFAULT '',
			scores LONGTEXT,
			report LONGTEXT,
			model VARCHAR(40) NOT NULL DEFAULT '',
			sig CHAR(40) NOT NULL DEFAULT '',
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY nb (nb_id, id)
		) {$charset};" );
		dbDelta( "CREATE TABLE {$p}aq_nb_poll (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			nb_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			item VARCHAR(40) NOT NULL DEFAULT '',
			user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			val TINYINT NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY answer (nb_id, item, user_id),
			KEY dist (nb_id, item, val)
		) {$charset};" );
		dbDelta( "CREATE TABLE {$p}aq_posts (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			body VARCHAR(300) NOT NULL DEFAULT '',
			nb_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			repost_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			hearts INT NOT NULL DEFAULT 0,
			reposts INT NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY feed (id), KEY author (author_id, id), KEY nb (nb_id), KEY top (hearts, id)
		) {$charset};" );
		// One-shot backfill: every already-published notebook gets its wrapping post.
		global $wpdb;
		$wpdb->query( "INSERT INTO {$p}aq_posts (author_id, body, nb_id, created)
			SELECT n.author_id, LEFT(COALESCE(n.abstract,''), 280), n.id, n.published_at FROM {$p}aq_notebooks n
			LEFT JOIN {$p}aq_posts x ON x.nb_id = n.id WHERE n.status = 'published' AND x.id IS NULL" );
		dbDelta( "CREATE TABLE {$p}aq_nb_challenges (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			creator_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			kind VARCHAR(16) NOT NULL DEFAULT '',
			topic VARCHAR(64) NOT NULL DEFAULT '',
			title VARCHAR(160) NOT NULL DEFAULT '',
			fee INT NOT NULL DEFAULT 1,
			deadline INT UNSIGNED NOT NULL DEFAULT 0,
			pool INT NOT NULL DEFAULT 0,
			state VARCHAR(8) NOT NULL DEFAULT 'open',
			results LONGTEXT,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY state_dl (state, deadline),
			KEY kind (kind, id)
		) {$charset};" );
		// THE LIBRARY (operator 2026-07-28): one row per PUBLISHED output file. This is the whole
		// point of the reset — a reproducible artifact stops being locked inside the work that made
		// it and becomes a citable object any member can attach to a post.
		//
		// Rows are created ONLY by the publish path, never by an upload: everything here came out of
		// a Kaggle run that passed the checklist, and `nb_id` is the provenance that proves it. The
		// bytes are mirrored to our own CDN at publish time because a Kaggle kernel is
		// owner-editable and owner-deletable — a citation that resolves only while its author leaves
		// it alone is not a citation.
		//
		// TWO PORTABILITY TRAPS, both of which make dbDelta emit NO TABLE AT ALL under Studio's
		// SQLite — silently, with an empty $wpdb->last_error, so the failure only shows up later as
		// a missing table. Neither reproduces on prod MySQL, which is what makes them dangerous:
		//   1. The column may not be called `stored`. STORED is reserved by the SQLite integration's
		//      MySQL parser (generated columns: GENERATED ALWAYS AS (…) STORED). Hence `cdn_key`.
		//   2. No prefix indexes. The MySQL-only `name(180)` form is rejected outright, so the
		//      indexable identity of a file is `name_key` = sha1(name) — exact, not a prefix, and
		//      immune to a Kaggle output path being longer than an index may cover.
		// Keep these CREATE TABLE strings free of /* */ comments for the same class of reason:
		// dbDelta parses them line-by-line with regexes.
		dbDelta( "CREATE TABLE {$p}aq_library (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			nb_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			name VARCHAR(400) NOT NULL DEFAULT '',
			name_key CHAR(40) NOT NULL DEFAULT '',
			label VARCHAR(200) NOT NULL DEFAULT '',
			class VARCHAR(12) NOT NULL DEFAULT '',
			mime VARCHAR(80) NOT NULL DEFAULT '',
			bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
			sha256 CHAR(64) NOT NULL DEFAULT '',
			cdn_key VARCHAR(300) NOT NULL DEFAULT '',
			uses INT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY nb_file (nb_id, name_key),
			KEY browse (class, id),
			KEY author (author_id, id),
			KEY nb (nb_id, id)
		) {$charset};" );
		// The attachment join: which Library items ride on which post. A member may attach ANY
		// published Library item, not only their own — that is the sharing the reset exists for —
		// so ownership is deliberately NOT checked here; provenance travels with the item.
		dbDelta( "CREATE TABLE {$p}aq_post_media (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			post_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			lib_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			pos TINYINT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY one (post_id, lib_id),
			KEY post (post_id, pos),
			KEY lib (lib_id)
		) {$charset};" );
		dbDelta( "CREATE TABLE {$p}aq_nb_entries (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			ch_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			nb_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY one_entry (ch_id, user_id),
			KEY ch (ch_id, id)
		) {$charset};" );
		self::install_publish_guard();
		update_option( 'aq_notebook_table_version', self::TABLE_VERSION, true );
	}

	/**
	 * THE PUBLISH-GUARD TRIGGERS (operator 2026-07-24: prevention, not detection): the database
	 * itself refuses ANY transition of an aq_notebooks row into status 'published' — INSERT or
	 * UPDATE, from any client: the plugin, wp-cli, `wp eval`, raw SQL, an AI agent on the box —
	 * unless the author's sig-bound confirmation ledger row ALREADY exists in aq_nb_reviews.
	 * This turns the integrity watchdog's after-the-fact demote into a before-the-fact refusal
	 * at the lowest layer the server exposes. (The legitimate path writes the ledger row first —
	 * author_confirm step 2 — so it passes; everything else dies as a SQL error and no alarm
	 * fires because nothing happened.) MySQL/MariaDB only: SQLite (local dev) has no SHA1() and
	 * local is the sandbox where the PHP-level gate + sweep still hold. Dropping the triggers
	 * requires an explicit DROP TRIGGER — an act the audit log + this code's re-install on every
	 * TABLE_VERSION bump make loud and temporary.
	 */
	private static function install_publish_guard() {
		global $wpdb;
		if ( stripos( (string) ( $wpdb->db_server_info() ?: '' ), 'sqlite' ) !== false ) {
			update_option( 'aq_publish_guard', 'sqlite-dev', true );
			return;
		}
		$nbs = $wpdb->prefix . 'aq_notebooks';
		$rev = $wpdb->prefix . 'aq_nb_reviews';
		// ARTABOT CARVE-OUT (operator 2026-07-30: 'make it fully automated, no confirmation or doi
		// minting'). ArtaNews is an unattended publisher: it detects an instrument reading, builds a
		// reproducible Kaggle notebook and posts it with no human in the loop, so there is no author
		// inbox to confirm from and a confirmation row would be a forged one.
		//
		// The exemption is deliberately ONE account id, resolved at trigger-build time, and NOT a
		// blanket removal: every human author still cannot reach 'published' without their own
		// sig-bound ledger row. That is the control that stopped an AI agent minting its own publish
		// link (nb 45), and it stays exactly as it was for member content.
		$bot = (int) get_option( 'aq_artabot_uid', 0 );
		$chk = "IF NEW.status = 'published' AND NEW.author_id <> {$bot} AND NOT EXISTS (
				SELECT 1 FROM {$rev} v WHERE v.nb_id = NEW.id AND v.model = 'author'
					AND v.verdict = 'pass' AND v.sig = SHA1(NEW.ipynb) )
			THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'aq publish-guard: publication requires the author''s sig-bound confirmation ledger row'; END IF;";
		$wpdb->query( "DROP TRIGGER IF EXISTS aq_nb_pub_guard_upd" );
		$wpdb->query( "CREATE TRIGGER aq_nb_pub_guard_upd BEFORE UPDATE ON {$nbs} FOR EACH ROW
			BEGIN IF NEW.status = 'published' AND OLD.status <> 'published' THEN {$chk} END IF; END" );
		$wpdb->query( "DROP TRIGGER IF EXISTS aq_nb_pub_guard_ins" );
		$wpdb->query( "CREATE TRIGGER aq_nb_pub_guard_ins BEFORE INSERT ON {$nbs} FOR EACH ROW
			BEGIN {$chk} END" );
		// VERIFY, never assume: managed MySQL (WP.com Atomic) refuses trigger DDL without SUPER
		// (error 1419) — a silently-absent guard must be KNOWN-absent, not imagined-present. The
		// recorded state is public (options are in the explorer): 'triggers' means the DB layer
		// is active; 'unavailable' means the passkey signatures + the integrity sweep carry the
		// guarantee alone (they do — the cryptographic layer never depended on this one).
		$n = (int) $wpdb->get_var( $wpdb->prepare(
			'SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = %s', $nbs ) );
		update_option( 'aq_publish_guard', $n >= 2 ? 'triggers' : 'unavailable', true );
		if ( $n < 2 ) { error_log( 'AQ publish-guard: DB triggers unavailable on this host (managed MySQL, no SUPER) — passkey + sweep layers carry the guarantee.' ); }
	}

	// ── Helpers ──────────────────────────────────────────────────────────────

	/** RETIRED (ArtaCritic pivot 2026-07-16): the old ArtaDev fee — kept only so legacy ledger
	 *  rows/refund maths stay explicable. Nothing charges it any more. */
	public static function dev_cost( $size_bytes, $iters ) {
		$per = max( 1, (int) ceil( (int) $size_bytes / self::FEE_BYTES ) );
		return $per * max( 1, (int) $iters );
	}

	/** Publish fee in ₳ — goes 100% into the kind's open challenge pool, never to the Foundation. */
	public static function pub_fee( $size_bytes ) {
		return max( 1, (int) ceil( (int) $size_bytes / self::FEE_BYTES ) );
	}

	/** Challenges run per KIND per UTC calendar month; publishing enters the post automatically. */
	private static function season_key( $ts = 0 ) {
		return gmdate( 'Y-m', $ts ?: time() );
	}

	private static function season_close_ts( $key ) {
		[ $y, $m ] = array_map( 'intval', explode( '-', $key ) );
		return gmmktime( 0, 0, 0, $m + 1, 1, $y );
	}

	/** Validate + normalise an ipynb source string. Returns the clean JSON string or ''. */
	public static function clean_ipynb( $raw ) {
		$raw = (string) $raw;
		if ( $raw === '' || strlen( $raw ) > self::MAX_IPYNB_BYTES ) { return ''; }
		$j = json_decode( $raw, true );
		if ( ! is_array( $j ) || ! isset( $j['cells'] ) || ! is_array( $j['cells'] ) ) { return ''; }
		if ( (int) ( $j['nbformat'] ?? 0 ) !== 4 ) { return ''; }
		foreach ( $j['cells'] as $c ) {
			if ( ! is_array( $c ) || ! in_array( $c['cell_type'] ?? '', [ 'markdown', 'code', 'raw' ], true ) ) { return ''; }
		}
		// Canonical form so sha1 binding is stable regardless of client whitespace. Re-encode from the
		// OBJECT decode — an assoc decode turns empty {} metadata into [] and nbformat rejects lists there.
		return (string) wp_json_encode( json_decode( $raw ) );
	}

	/** HARD PLATFORM CONSTRAINT (operator 2026-07-14): every submission must be FULLY reproducible
	 *  — data may only be computed, synthesised or derived in the cells. Opaque payload smuggling
	 *  (base64/hex blobs, DATA_B64-style constants, pasted corpora) is rejected MECHANICALLY here,
	 *  before the critic ever sees it. Returns '' when clean, else a human explanation. */
	public static function blob_guard( $ipynb ) {
		$j = json_decode( (string) $ipynb, true );
		foreach ( (array) ( $j['cells'] ?? [] ) as $i => $c ) {
			if ( ( $c['cell_type'] ?? '' ) !== 'code' ) { continue; }
			$src = is_array( $c['source'] ?? '' ) ? implode( '', $c['source'] ) : (string) ( $c['source'] ?? '' );
			if ( preg_match( '#[A-Za-z0-9+/=_-]{1536,}#', $src ) ) {
				return 'Cell ' . ( $i + 1 ) . ' embeds an opaque encoded blob. Reproducibility is a hard platform rule: derive or synthesise every byte of data in code — never paste encoded payloads.';
			}
			if ( preg_match( '#(?:\\\\x[0-9a-fA-F]{2}){400,}#', $src ) || preg_match( '#(?:0x[0-9a-fA-F]{2},\s*){400,}#', $src ) ) {
				return 'Cell ' . ( $i + 1 ) . ' embeds a raw byte dump. Compute your data — do not inject it.';
			}
			if ( strlen( $src ) > 262144 ) {
				return 'Cell ' . ( $i + 1 ) . ' is over 256 KB of source — that is data wearing a code costume. Derive it instead.';
			}
		}
		return '';
	}

	/**
	 * THE REQUIREMENTS FILE (operator order 2026-07-26: submissions must be flexible and
	 * generalisable, and EACH one carries a requirements file). Until now every submission executed
	 * in ONE fixed offline venv (numpy/pandas/matplotlib/pillow), which quietly decided what a work
	 * could BE: a music kind could only do pure-numpy DSP, a modeller could not reach torch, an
	 * analyst could not reach scipy. From now on every submission authors its OWN environment as the
	 * literal text of a requirements.txt, and reproduction INSTALLS it before the offline execution.
	 * An EMPTY file is valid and means "the base environment only" — the effortless default stays
	 * effortless, so nothing regresses for the ten kinds that never needed more.
	 *
	 * Because this text DRIVES AN INSTALL it is validated here, strictly, server-side. One rule
	 * carries the rest: EVERY requirement is FULLY PINNED as name==version. An unpinned name
	 * resolves to whatever the index happens to serve that hour, so the DOUBLE execution could not
	 * be expected to match — irreproducible by construction, which is the one thing the gate exists
	 * to refuse. Everything that could make an install fetch something other than a named, exactly
	 * versioned package is refused with it: URLs, VCS refs, local paths, -e/-r/-f, alternate
	 * indexes, environment markers, wildcards, bare names, shell metacharacters.
	 *
	 * Returns [ $clean, $error ] — $error is '' when the file is acceptable (blob_guard's convention:
	 * empty string means OK, a message means refused) and otherwise QUOTES THE OFFENDING LINE so an
	 * author fixes it in one pass. Two values rather than blob_guard's one because '' is a VALID
	 * file here, so it cannot double as the OK signal. $clean is canonical — LF endings, per-line
	 * trim, no leading/trailing blank lines — for the same reason clean_ipynb canonicalises: what
	 * gets stored must not wobble with a client's whitespace. (What the GATE compares is narrower
	 * still: requirements_pins(), the pins alone.)
	 */
	public static function clean_requirements( $raw ) {
		// A JSON body can hand us a list or an object here; say so rather than stringifying it.
		if ( is_array( $raw ) || is_object( $raw ) ) {
			return [ '', 'The requirements field is the plain TEXT of a requirements.txt — one pinned name==version per line, not a structure.' ];
		}
		$raw = str_replace( [ "\r\n", "\r" ], "\n", (string) $raw );
		if ( strlen( $raw ) > self::MAX_REQ_BYTES ) {
			return [ '', 'That requirements file is ' . strlen( $raw ) . ' bytes — the cap is ' . self::MAX_REQ_BYTES
				. '. Pin the packages your cells actually import, not a whole distribution.' ];
		}
		$lines = explode( "\n", $raw );
		if ( count( $lines ) > self::MAX_REQ_LINES ) {
			return [ '', 'That requirements file has ' . count( $lines ) . ' lines — the cap is ' . self::MAX_REQ_LINES
				. ' (of which at most ' . self::MAX_REQ_PINS . ' may be pins). An environment this large is a research platform, not a submission.' ];
		}
		$out  = [];
		$seen = [];
		foreach ( $lines as $i => $line ) {
			$line = trim( $line );
			$n    = $i + 1;
			// ASCII FIRST, and this is the ONE message that does not echo the line: everything below
			// quotes it back to the author, and a line carrying invalid UTF-8 would break the JSON
			// encoding of the very error meant to explain it.
			if ( preg_match( '#[^\x20-\x7E]#', $line ) ) {
				return [ '', 'Requirements line ' . $n . ' contains characters outside plain printable ASCII. A package name and a version are ASCII; anything else is not a requirement.' ];
			}
			if ( $line === '' )     { $out[] = ''; continue; }    // blank lines are kept
			if ( $line[0] === '#' ) { $out[] = $line; continue; } // and so are whole-line comments
			$q = 'Requirements line ' . $n . ' ("' . $line . '") ';
			if ( $line[0] === '-' ) {
				return [ '', $q . 'is a pip option. This file names packages and nothing else — no -e/--editable, no -r/--requirement, no -f/--find-links, no --index-url/--extra-index-url/--trusted-host: an option can redirect the install anywhere, and then the file no longer describes the environment.' ];
			}
			if ( strpos( $line, '://' ) !== false || strpos( $line, '@' ) !== false
				|| preg_match( '#^(?:git|hg|svn|bzr)\+#i', $line ) || stripos( $line, 'file:' ) === 0 ) {
				return [ '', $q . 'points at a URL or a version-control checkout. An address can serve different bytes tomorrow; a pinned version cannot — install by name and exact version.' ];
			}
			if ( $line[0] === '.' || $line[0] === '/' || $line[0] === '~'
				|| strpos( $line, '\\' ) !== false || preg_match( '#^[A-Za-z]:#', $line ) ) {
				return [ '', $q . 'is a filesystem path. Nothing outside the notebook exists on the runner: name a package, and derive everything else in the cells.' ];
			}
			if ( strpos( $line, ';' ) !== false ) {
				return [ '', $q . 'carries an environment marker (;). One submission means one environment — state the requirement this work needs, unconditionally.' ];
			}
			if ( strpos( $line, '*' ) !== false ) {
				return [ '', $q . 'uses a wildcard. A wildcard is not a pin — name the exact version.' ];
			}
			if ( preg_match( '#===|>=|<=|~=|!=|>|<#', $line ) ) {
				return [ '', $q . 'is a range, not a pin. Reproducibility means one exact version: write name==1.2.3 — == only, never >=, ~=, != or ===.' ];
			}
			if ( strpos( $line, '==' ) === false ) {
				return [ '', $q . 'is a bare package name. A bare name installs whatever the index serves that day, so the double execution could never be expected to match — pin it as name==version.' ];
			}
			// The conservative whitelist: a PyPI name (optionally with extras) == a PEP 440 version,
			// and not one character more. Everything a shell could act on is outside this charset.
			if ( ! preg_match( '#^([A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?)(?:\[[A-Za-z0-9,._-]{1,60}\])?==[0-9][A-Za-z0-9.+!_-]{0,31}$#', $line, $m ) ) {
				return [ '', $q . 'is not a plain pinned requirement. One per line, as name==version (or name[extra]==version): letters, digits, dots, dashes and underscores only — no spaces, no shell characters, and no trailing comment (put comments on their own line).' ];
			}
			// PEP 503 normalisation for the duplicate check only — the author's own spelling is what
			// gets stored. Two pins of one package is an unresolvable install, caught here (at edit
			// time, with a line number) rather than in the runner five minutes into a run.
			$key = strtolower( preg_replace( '#[-_.]+#', '-', $m[1] ) );
			if ( isset( $seen[ $key ] ) ) {
				return [ '', $q . 'pins ' . $m[1] . ' a second time (already on line ' . $seen[ $key ] . '). One pin per package.' ];
			}
			// The cap counts PINS, because a pin is the only line that changes what gets installed.
			if ( count( $seen ) >= self::MAX_REQ_PINS ) {
				return [ '', $q . 'is pin number ' . ( count( $seen ) + 1 ) . ' — the cap is ' . self::MAX_REQ_PINS
					. ' pinned requirements (comments and blank lines are free). An environment this large is a research platform, not a submission.' ];
			}
			$seen[ $key ] = $n;
			$out[]        = $line;
		}
		return [ trim( implode( "\n", $out ), "\n" ), '' ];
	}

	/** The INSTALL-EFFECTIVE part of a clean requirements file: the pins alone, without the blank
	 *  lines and comments that cannot change a single installed byte. THIS is what the gate compares,
	 *  so re-wording a comment costs an author nothing while adding a package costs them a re-run. */
	private static function requirements_pins( $clean ) {
		$pins = array_filter( explode( "\n", (string) $clean ),
			static function ( $l ) { return $l !== '' && $l[0] !== '#'; } );
		return implode( "\n", $pins );
	}

	/**
	 * THE ENVIRONMENT'S OWN SIGNATURE (2026-07-26) — sig()'s sibling, and it exists because sig()
	 * cannot grow: the database publish-guard trigger compares SHA1(NEW.ipynb), and every review row
	 * ever written carries that same hash in `sig`, so folding the requirements into sig() would
	 * break the trigger and orphan the whole ledger. The environment therefore gets its own hash,
	 * carried in its own `req_sig` columns — on the RUN (the environment the runner was handed, so
	 * the gate can ask what a measurement was produced under) and on the WORK (the environment the
	 * author's emailed confirmation certified, so integrity_sweep can see it move).
	 *
	 * Over requirements_pins(), not the file: re-wording a comment must cost an author nothing,
	 * while adding a package must cost them a re-run. An EMPTY pin set hashes too — sha1('') is a
	 * perfectly good, stable signature — so the ten kinds that declare nothing are bound exactly
	 * like the ones that do, with no special case anywhere downstream.
	 */
	private static function req_sig( $requirements ) {
		return sha1( self::requirements_pins( (string) $requirements ) );
	}

	/**
	 * DECLARED EXTERNAL MODELS — metadata.aq.models, the other half of the same flexibility order.
	 * Once a submission can install a real ML stack it can also RENDER FROM a model it did not train
	 * itself; the platform's answer is that such a model must be named as precisely as a pinned
	 * package — and named in the ONE schema the runner provisions from:
	 *
	 *   { "repo": "owner/name", "revision": "<40-hex commit>",
	 *     "files": [ { "file": "model.safetensors", "sha256": "<64 hex>" } ] }
	 *
	 * TWO pins per file, and both are load-bearing. The 40-hex COMMIT says WHICH bytes (a branch or
	 * a tag is a moving pointer, and a work whose inputs can be moved after it was measured is not
	 * reproducible — which is the whole gate); the per-file SHA256 lets the runner PROVE it got them,
	 * and it will not place weights it cannot verify into the sandbox (notebook-relay.mjs refuses the
	 * row and provisions nothing). A declaration missing the hash was therefore silently
	 * unprovisionable — so it is refused HERE, at save time, with the exact line to add. Filenames
	 * are ENUMERATED (never "the whole repo") so a submission's inputs stay countable, and dot-dot
	 * and absolute paths are refused outright because these files land in the workdir before the
	 * offline execution and a traversal would escape it.
	 *
	 * Returns [ $models, $error ] — the same two-value shape as clean_requirements, so the call
	 * sites read alike. The SERVER owns the normalised shape, so no runner ever re-implemented these
	 * rules and none can drift from them now. ("repo" is
	 * canonical; "hf" is still read, the spelling the field shipped with.)
	 */
	public static function declared_models( $ipynb ) {
		$j   = json_decode( (string) $ipynb, true );
		$raw = $j['metadata']['aq']['models'] ?? null;
		if ( $raw === null || $raw === [] ) { return [ [], '' ]; }
		$form = ' each { "repo": "owner/name", "revision": "<40-hex commit>", "files": [ { "file": "model.safetensors", "sha256": "<64 hex>" } ] }.';
		if ( ! is_array( $raw ) || ! isset( $raw[0] ) ) {
			return [ [], 'metadata.aq.models must be a LIST of model declarations,' . $form ];
		}
		if ( count( $raw ) > self::MAX_MODELS ) {
			return [ [], 'metadata.aq.models declares ' . count( $raw ) . ' models — the cap is ' . self::MAX_MODELS . '. A submission that needs more is several submissions.' ];
		}
		$out   = [];
		$total = 0; // files across ALL declared models: the relay's shelf cap is per RUN, not per repo
		foreach ( $raw as $i => $m ) {
			$n    = $i + 1;
			$m    = is_array( $m ) ? $m : [];
			$repo = is_scalar( $m['repo'] ?? $m['hf'] ?? null ) ? trim( (string) ( $m['repo'] ?? $m['hf'] ) ) : '';
			// Validated BEFORE it is echoed in any message (see clean_requirements' ASCII rule).
			if ( ! preg_match( '#^[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$#', $repo ) || strpos( $repo, '..' ) !== false ) {
				return [ [], 'Model ' . $n . ' in metadata.aq.models needs a "repo" id spelled exactly owner/name —' . $form ];
			}
			$rev = is_scalar( $m['revision'] ?? null ) ? strtolower( trim( (string) $m['revision'] ) ) : '';
			if ( ! preg_match( '#^[0-9a-f]{40}$#', $rev ) ) {
				return [ [], 'Model ' . $n . ' (' . $repo . ') must pin an immutable 40-hex commit revision. A branch or a tag (main, v1.0, a short sha) can be moved after your work is measured, so it cannot reproduce — copy the full commit the Hub shows for the exact files you used.' ];
			}
			$files = is_array( $m['files'] ?? null ) ? array_values( $m['files'] ) : [];
			if ( ! $files ) {
				return [ [], 'Model ' . $n . ' (' . $repo . ') must list the "files" it fetches, each with its expected sha256 —' . $form
					. ' An enumerated set, never a whole repository: a submission\'s inputs have to be countable.' ];
			}
			$total += count( $files );
			if ( $total > self::MAX_MODEL_FILES ) {
				return [ [], 'Model ' . $n . ' (' . $repo . ') brings this submission to ' . $total . ' declared weight files — the runner provisions at most '
					. self::MAX_MODEL_FILES . ' per run (a shelf, not a mirror of the Hub). Fetch the shards you actually load.' ];
			}
			$keep = [];
			foreach ( $files as $f ) {
				$fa   = is_array( $f ) ? $f : [];
				$name = is_scalar( $f ) ? trim( (string) $f ) : ( is_scalar( $fa['file'] ?? null ) ? trim( (string) $fa['file'] ) : '' );
				if ( ! preg_match( '#^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$#', $name ) || strpos( $name, '..' ) !== false ) {
					return [ [], 'Model ' . $n . ' (' . $repo . ') lists a filename that is not a plain relative path inside the repo (no leading slash, no "..", no backslashes, no spaces).' ];
				}
				$sha = is_scalar( $fa['sha256'] ?? null ) ? strtolower( trim( (string) $fa['sha256'] ) ) : '';
				if ( ! preg_match( '#^[0-9a-f]{64}$#', $sha ) ) {
					return [ [], 'Model ' . $n . ' (' . $repo . ') declares "' . $name . '" with no expected sha256, so the runner has no way to prove it fetched the bytes you used — and it refuses to place weights it cannot verify. Write that file as { "file": "'
						. $name . '", "sha256": "<64 hex>" }: the Hub prints the sha256 on the file\'s own page, or run `shasum -a 256` on the copy you tested with.' ];
				}
				$keep[] = [ 'file' => $name, 'sha256' => $sha ];
			}
			$out[] = [ 'repo' => $repo, 'revision' => $rev, 'files' => $keep ];
		}
		return [ $out, '' ];
	}

	private static function sig( $ipynb ) { return sha1( (string) $ipynb ); }

	private static function row( $id ) {
		return Data::one( 'SELECT * FROM ' . Data::t( 'aq_notebooks' ) . ' WHERE id = %d', [ (int) $id ] );
	}

	private static function can_edit( $row, $uid ) {
		return $row && ( (int) $row['author_id'] === (int) $uid || current_user_can( 'manage_options' ) );
	}

	/** The environment the CURRENT source's binding measurement was produced under, or null when
	 *  nothing has measured this source yet (panel() refuses that case on its own, with its own
	 *  message). Read off the RUN that posted the measured seat — the executor stamped every run with
	 *  the exact pins it was handed, so this is the durable answer to "what was this measured
	 *  under?". A run claimed before req_sig existed recorded nothing: read that as the BASE
	 *  environment, so the ten kinds that declare nothing keep their pass and only a work that
	 *  actually declared pins pays for one free re-run.
	 *  TWO QUERIES, DELIBERATELY — not one JOIN: the SQLite integration (local dev) matches the
	 *  joined rows but hands back NULL for a qualified column of the joined table, which would turn
	 *  this whole check into a silent no-op on exactly the box where authors try things. Same reason
	 *  integrity_sweep() compares hashes in PHP instead of SQL. */
	private static function measured_req_sig( $nb_id, $sig ) {
		$run = Data::col(
			'SELECT run_id FROM ' . Data::t( 'aq_nb_reviews' )
			. ' WHERE nb_id = %d AND sig = %s AND iter = 0 AND model LIKE %s ORDER BY id DESC LIMIT 1',
			[ (int) $nb_id, (string) $sig, self::METRICS_MODEL . '%' ] );
		if ( $run === null ) { return null; }
		// A measurement whose run row is gone (a pruned queue) can no longer say what it ran in;
		// nothing to compare, so the gate's other keys decide. The published state is still bound —
		// req_sig on the work is what integrity_sweep() holds it to, and that needs no run row.
		$row = Data::one( 'SELECT req_sig FROM ' . Data::t( 'aq_nb_runs' ) . ' WHERE id = %d', [ (int) $run ] );
		if ( ! $row ) { return null; }
		return (string) $row['req_sig'] !== '' ? (string) $row['req_sig'] : sha1( '' );
	}

	/** Latest review bound to this exact source (kept for score display; the GATE is panel()). */
	private static function binding_review( $nb_id, $sig ) {
		return Data::one(
			'SELECT * FROM ' . Data::t( 'aq_nb_reviews' ) . ' WHERE nb_id = %d AND sig = %s ORDER BY id DESC LIMIT 1',
			[ (int) $nb_id, (string) $sig ]
		);
	}

	/** THE GATE VERDICT (v2, operator 2026-07-22) — server-authoritative, recomputed from the
	 *  review ledger on every check, never trusted from a client. Scoped to the LATEST run that
	 *  reviewed this exact source, so a re-run always re-measures and convenes a fresh panel
	 *  (memoryless by construction). Two layers, in order:
	 *    1. THE MEASUREMENT (seat 0, model METRICS_MODEL): the deterministic trade-off
	 *       scorecard from nb-metrics v3. EVERY category must sit inside the safe zone
	 *       [SAFE_LO, SAFE_HI] (both directions away from the ideal 50.0 fail) and the
	 *       BALANCE headline must reach PASS_SCORE. Also the relay's PREFILTER — outside the
	 *       zone, the blind panel is never convened; the author gets positions, not opinions.
	 *    2. THE VETO PANEL (seats 1..PANEL_SIZE): independent double-blind reviewers who verify
	 *       what formulas cannot (untrue prose, metric gaming, semantic fraud). All PANEL_SIZE
	 *       must verdict "pass" — unanimity or nothing. Their numbers never move the score. */
	public static function panel( $nb_id, $sig, $kind ) {
		$out = [ 'n' => 0, 'measured' => false, 'mean' => 0, 'mins' => (object) [], 'low' => [],
			'unanimous' => false, 'pass' => false, 'pass_score' => self::PASS_SCORE,
			'safe' => [ self::SAFE_LO, self::SAFE_HI ], 'size' => self::PANEL_SIZE ];
		// Newest rows first, so the window always contains the LATEST reviewing run even after
		// many re-runs of one source (oldest-first + LIMIT once gated on a stale run).
		$rows = Data::all(
			'SELECT run_id, iter, score, verdict, scores, model FROM ' . Data::t( 'aq_nb_reviews' )
			. ' WHERE nb_id = %d AND sig = %s ORDER BY id DESC LIMIT 40', [ (int) $nb_id, (string) $sig ] );
		if ( ! $rows ) { return $out; }
		$run  = max( array_map( static function ( $r ) { return (int) $r['run_id']; }, $rows ) );
		$rows = array_values( array_filter( $rows, static function ( $r ) use ( $run ) { return (int) $r['run_id'] === $run; } ) );
		// Layer 1 — the measured seat (deterministic; the ONLY source of numbers).
		$measured = null;
		foreach ( $rows as $r ) {
			if ( (int) $r['iter'] === 0 && strpos( (string) $r['model'], self::METRICS_MODEL ) === 0 ) { $measured = $r; }
		}
		if ( ! $measured ) { $out['n'] = count( $rows ); return $out; }
		$cats = Data::dec( $measured['scores'] ?? '' );
		$mins = [];
		foreach ( self::rubric( (string) $kind ) as $c ) {
			if ( ! is_array( $cats ) || ! isset( $cats[ $c ] ) || ! is_numeric( $cats[ $c ] ) ) { $out['n'] = count( $rows ); return $out; }
			$mins[ $c ] = round( (float) $cats[ $c ], 1 ); // POSITIONS, continuous to one decimal
		}
		$mean = (int) $measured['score'];
		$low  = [];
		foreach ( $mins as $c => $v ) {
			if ( $v < self::SAFE_LO || $v > self::SAFE_HI ) {
				$low[] = $c . ' ' . $v . ( $v < self::SAFE_LO ? ' (deficient side)' : ' (excess side)' );
			}
		}
		// Layer 2 — the unanimous veto panel.
		$seats = array_values( array_filter( $rows, static function ( $r ) { return (int) $r['iter'] >= 1; } ) );
		$unani = count( $seats ) >= self::PANEL_SIZE;
		foreach ( $seats as $s ) { $unani = $unani && (string) $s['verdict'] === 'pass'; }
		return [
			'n' => count( $seats ), 'measured' => true, 'mean' => $mean, 'mins' => $mins,
			'low' => array_values( $low ), 'unanimous' => $unani,
			'pass' => ! $low && $mean >= self::PASS_SCORE && $unani,
			'pass_score' => self::PASS_SCORE, 'safe' => [ self::SAFE_LO, self::SAFE_HI ], 'size' => self::PANEL_SIZE,
		];
	}

	/**
	 * Which of THESE posts the signed-in viewer has already hearted.
	 *
	 * Without it the client had no way to know, so `mine` initialised to false on every load: your
	 * own heart vanished the moment the page refreshed, and hearting again toggled it OFF. One
	 * query for the whole page, mirroring how the comments endpoint already reports it.
	 */
	private static function my_hearts( $rows ) {
		$uid = Rest::uid();
		if ( ! $uid || ! $rows ) { return []; }
		// TWO VOTE SPACES, and the important one is the notebook. A feed post that carries a work
		// hearts the NOTEBOOK (Feed.tsx: `nb ? heartNotebook(nb.id) : heartPost(post.id)`), so a
		// post-only lookup returned nothing for exactly the content this platform is made of — the
		// heart came back empty on reload and the next tap DELETED the member's real vote.
		$post_ids = array_map( 'intval', array_column( $rows, 'id' ) );
		$nb_of    = [];
		foreach ( $rows as $r ) { if ( (int) ( $r['nb_id'] ?? 0 ) ) { $nb_of[ (int) $r['nb_id'] ] = (int) $r['id']; } }
		$out = [];

		$in  = implode( ',', array_fill( 0, count( $post_ids ), '%d' ) );
		$hit = Data::all(
			'SELECT target_id FROM ' . Data::t( 'aq_votes' )
			. " WHERE user_id = %d AND target_type = 'post' AND val = 1 AND target_id IN ({$in})",
			array_merge( [ $uid ], $post_ids ) );
		foreach ( $hit as $h ) { $out[] = (int) $h['target_id']; }

		if ( $nb_of ) {
			$nb_ids = array_keys( $nb_of );
			$in2    = implode( ',', array_fill( 0, count( $nb_ids ), '%d' ) );
			$hit2   = Data::all(
				'SELECT target_id FROM ' . Data::t( 'aq_votes' )
				. " WHERE user_id = %d AND target_type = 'notebook' AND val = 1 AND target_id IN ({$in2})",
				array_merge( [ $uid ], $nb_ids ) );
			// Reported as POST ids, because that is what the timeline keys on.
			foreach ( $hit2 as $h ) { $out[] = $nb_of[ (int) $h['target_id'] ] ?? 0; }
		}
		return array_values( array_unique( array_filter( $out ) ) );
	}

	/** The one published file a card should render, best-first by Kernel::HERO_ORDER. */
	private static function hero_file( $nb_id ) {
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_library' ) . ' WHERE nb_id = %d', [ (int) $nb_id ] );
		if ( ! $rows ) { return null; }
		usort( $rows, function ( $a, $b ) {
			$ra = array_search( (string) $a['class'], Kernel::HERO_ORDER, true );
			$rb = array_search( (string) $b['class'], Kernel::HERO_ORDER, true );
			$ra = false === $ra ? 99 : $ra;
			$rb = false === $rb ? 99 : $rb;
			return $ra === $rb ? ( (int) $a['id'] - (int) $b['id'] ) : ( $ra - $rb );
		} );
		return Kernel::lib_card( $rows[0] );
	}

	/** Public so the Library (AQ\Kernel) renders an author identically to a work card. */
	/** How many works this member has published — the one number this platform is actually about.
	 *  Credited by author_id, the member who brought the work here and confirmed it from their inbox. */
	public static function published_count( $uid ) {
		$uid = (int) $uid;
		if ( $uid <= 0 ) { return 0; }
		return (int) Data::col(
			'SELECT COUNT(*) FROM ' . Data::t( 'aq_notebooks' ) . " WHERE author_id = %d AND status = 'published'",
			[ $uid ] );
	}

	public static function author_card( $uid ) {
		$u = get_userdata( (int) $uid );
		return [
			'id'     => (int) $uid,
			'name'   => $u ? (string) $u->display_name : 'Member',
			'slug'   => $u ? (string) $u->user_nicename : '',
			'avatar' => class_exists( '\\AQ\\Verify' ) ? (string) Verify::avatar_url( (int) $uid ) : '',
		];
	}

	private static function card( $r ) {
		return [
			'id'           => (int) $r['id'],
			'kind'         => (string) $r['kind'],
			'slug'         => (string) $r['slug'],
			'title'        => (string) $r['title'],
			'abstract'     => mb_substr( (string) ( $r['abstract'] ?? '' ), 0, 280 ),
			'thumb'        => (string) $r['thumb'],
			// THE standard attachment pair (2026-07-15, themed 2026-07-16): teaser-dark/-light
			// webm — VP9 with alpha, transparent background, 640×360 24fps 6s loop, each variant
			// optimised for its global theme — every kind, so the feed reads as one system.
			// `teaser` is the dark variant (and the only one on pre-pair publishes).
			'teaser'       => (string) ( $r['teaser'] ?? '' ),
			'teaser_light' => (string) ( $r['teaser_light'] ?? '' ),
			// The SAFE CHANGE-RATE score (operator 2026-07-17): 0–100, higher = calmer. Measured
			// mechanically (nb-calm axes: flicker/motion/cuts/chroma + WCAG flash) on every video
			// deliverable; a work with no video is perfectly calm (100). Published with the work
			// (details in the out/calm.json asset) and filterable via ?calm_min.
			'calm'         => (int) ( $r['calm'] ?? 100 ),
			'calm_measured' => (int) ( $r['calm_measured'] ?? 0 ) === 1,
			'assets'       => Data::dec( $r['assets'] ?? '' ) ?: [],
			'hearts'       => (int) $r['hearts'],
			'comments'     => (int) ( $r['comments'] ?? 0 ),
			'views'        => (int) ( $r['view_count'] ?? 0 ),
			'score'        => (int) $r['score'],
			'status'       => (string) $r['status'],
			'doi_link'     => $r['doi'] !== '' ? Doi::nb_link( $r['id'] ) : '',
			'colab_url'    => (string) $r['colab_url'],   // legacy rows only — no longer written
			'kaggle_url'   => (string) ( $r['kaggle_url'] ?? '' ),
			'size_bytes'   => (int) $r['size_bytes'],
			'author'       => self::author_card( $r['author_id'] ),
			// THE HERO — the published file a card should SHOW. `teaser`/`thumb` were produced by the
			// retired execution relay and nothing writes them any more, so without this every card
			// falls back to a grey placeholder bearing the kind's name: a member's first publication
			// lands in the feed looking broken, while the artifact sits mirrored on the CDN.
			'hero'         => self::hero_file( (int) $r['id'] ),
			// WHO WROTE THE NOTEBOOK, as Kaggle reports it. Any member may submit any PUBLIC kernel
			// (operator 2026-07-28), so the ArtaQuest member above is the SUBMITTER and this is the
			// creator. On a work someone submitted for themselves the two simply agree.
			'kaggle'       => [
				'owner'  => (string) ( $r['kg_owner'] ?? '' ),
				'author' => (string) ( ( Data::dec( $r['kg_facts'] ?? '' ) ?: [] )['author'] ?? '' ),
				'url'    => (string) ( $r['kg_url'] ?? '' ),
			],
			'published_at' => (int) $r['published_at'],
			'created'      => (int) $r['created'],
			'updated'      => (int) $r['updated'],
		];
	}

	private static function full( $r, $owner ) {
		$out            = self::card( $r );
		$out['ipynb']   = (string) ( $r['ipynb'] ?? '' );
		// The submission's OWN environment (2026-07-26), public like everything else about a work:
		// a reader can see the exact pinned stack a result was produced under, and reproduce it.
		// Empty means the base offline venv alone.
		$out['requirements'] = (string) ( $r['requirements'] ?? '' );
		$out['assets']  = Data::dec( $r['assets'] ?? '' ) ?: [];
		$out['fresh']   = $r['out_sig'] !== '' && $r['out_sig'] === self::sig( $r['ipynb'] );
		// The executed notebook (with outputs) is the public rendering payload.
		$out['ipynb_out'] = (string) ( $r['ipynb_out'] ?? '' );
		// THE GATE, as the client sees it: the stored reproducibility checklist, plus the one-line
		// reason publication is currently refused. Public on every work — the checklist IS the
		// scorecard now, and a reader is entitled to the same list the author saw.
		$out['kernel']       = [
			'owner' => (string) ( $r['kg_owner'] ?? '' ),
			'slug'  => (string) ( $r['kg_slug'] ?? '' ),
			'url'   => (string) ( $r['kg_url'] ?? '' ),
			'facts' => Data::dec( $r['kg_facts'] ?? '' ) ?: null,
		];
		$out['checks']       = Data::dec( $r['checks'] ?? '' ) ?: null;
		$out['checked_at']   = (int) ( $r['checked_at'] ?? 0 );
		$out['selection']    = Data::dec( $r['selection'] ?? '' ) ?: [];
		$out['gate_reason']  = self::gate_reason( $r );
		$out['publishable']  = '' === $out['gate_reason'];
		$out['files']        = array_map( [ Kernel::class, 'lib_card' ],
			Data::all( 'SELECT * FROM ' . Data::t( 'aq_library' ) . ' WHERE nb_id = %d ORDER BY id', [ (int) $r['id'] ] ) );
		$out['pending']      = (string) $r['status'] === 'pending'; // in the dual email gate
		// Which leg of the dual gate a pending work waits on: false = the author's own emailed
		// confirmation, true = the operator's decision (Studio + API show "check your email").
		$out['author_confirmed'] = $out['pending'] ? self::author_confirmed( $r ) : null;
		$out['decision_note'] = (string) ( $r['decision_note'] ?? '' );
		$out['pub_fee']       = self::pub_fee( $r['size_bytes'] ); // the pool contribution publishing costs
		$uid = Rest::uid();
		$out['following'] = $uid && $uid !== (int) $r['author_id']
			? (bool) Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_follows' ) . ' WHERE follower_id = %d AND target_id = %d', [ $uid, (int) $r['author_id'] ] )
			: false;
		if ( $owner ) {
			$open = Data::one(
				'SELECT id, type, state, iters, iters_done, score, error, created FROM ' . Data::t( 'aq_nb_runs' )
				. " WHERE nb_id = %d AND state IN ('queued','claimed') ORDER BY id DESC LIMIT 1", [ (int) $r['id'] ] );
			$out['open_run'] = $open ?: null;
			// The latest SETTLED run (done|error) — Studio reads its `error` so a failed run is
			// explained on the overview and the edit track, never silently absent.
			$last = Data::one(
				'SELECT id, type, state, iters, iters_done, score, error, created FROM ' . Data::t( 'aq_nb_runs' )
				. " WHERE nb_id = %d AND state IN ('done','error') ORDER BY id DESC LIMIT 1", [ (int) $r['id'] ] );
			$out['last_run'] = $last ?: null;
		}
		return $out;
	}

	// ── Public feed ───────────────────────────────────────────────────

	/** GET notebooks — the published feed. ?kind= ?q= ?sort=new|top ?cursor= */
	public static function list( $req ) {
		self::ensure_tables();
		// The integrity watchdog rides the feed (max once per 10 min): an illegitimately
		// "published" row is demoted before it is ever listed. No cron registration needed.
		// The stranded-request sweep rides the same tick — it is the mirror image of the same
		// invariant (a request that never finished must not sit as though it had), it only ever
		// moves a row BACKWARDS to draft, and it is one indexed read when it finds nothing.
		if ( ! get_transient( 'aq_nb_integrity_ran' ) ) {
			set_transient( 'aq_nb_integrity_ran', 1, 10 * MINUTE_IN_SECONDS );
			self::integrity_sweep();
			self::sweep_stranded_pending();
		}
		$kind   = sanitize_key( (string) Rest::p( $req, 'kind', '' ) );
		$q      = trim( (string) Rest::p( $req, 'q', '' ) );
		$sort   = Rest::p( $req, 'sort', 'new' ) === 'top' ? 'top' : 'new';
		$cursor = Rest::pint( $req, 'cursor', 0 );
		$where  = "status = 'published'";
		$args   = [];
		if ( $kind !== '' && isset( self::KINDS[ $kind ] ) ) { $where .= ' AND kind = %s'; $args[] = $kind; }
		// ?calm_min= — the ArtaContrast calm filter: hide works whose measured change rate is
		// faster than the member's comfort (static works are calm 100, so they always show).
		$calm_min = Rest::pint( $req, 'calm_min', 0 );
		if ( $calm_min > 0 ) { $where .= ' AND calm >= %d'; $args[] = min( 100, $calm_min ); }
		// ?author=<id|slug> — a member's public timeline (profiles).
		$author = (string) Rest::p( $req, 'author', '' );
		if ( $author !== '' ) {
			$au = ctype_digit( $author ) ? get_userdata( (int) $author ) : get_user_by( 'slug', sanitize_title( $author ) );
			$where .= ' AND author_id = %d';
			$args[] = $au ? (int) $au->ID : 0;
		}
		// ?following=1 — only people the signed-in viewer follows (the Following tab).
		if ( Rest::pint( $req, 'following', 0 ) && Rest::uid() ) {
			$where .= ' AND author_id IN (SELECT target_id FROM ' . Data::t( 'aq_follows' ) . ' WHERE follower_id = %d)';
			$args[] = Rest::uid();
		}
		if ( $sort === 'top' ) {
			global $wpdb;
			$sql  = 'SELECT * FROM ' . Data::t( 'aq_notebooks' ) . " WHERE {$where} ORDER BY hearts DESC, id DESC LIMIT 100";
			$rows = $args ? Data::all( $sql, $args ) : $wpdb->get_results( $sql, ARRAY_A );
			return [ 'items' => array_map( [ self::class, 'card' ], $rows ?: [] ), 'next' => null ];
		}
		if ( $q !== '' ) {
			[ $rows, $next ] = Data::search_page( 'aq_notebooks', [ 'title', 'abstract' ], $q, $where, $args, $cursor, self::PAGE );
		} else {
			[ $rows, $next ] = Data::page( 'aq_notebooks', $where, $args, $cursor, self::PAGE );
		}
		return [ 'items' => array_map( [ self::class, 'card' ], $rows ), 'next' => $next ];
	}

	/** GET notebooks/{id} — full payload. Drafts are the author's alone. */
	public static function get( $req ) {
		self::ensure_tables();
		$r = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $r || $r['status'] === 'removed' ) { return Rest::err( 'not_found', 'No such notebook', 404 ); }
		$owner = self::can_edit( $r, Rest::uid() );
		if ( $r['status'] !== 'published' && ! $owner ) { return Rest::err( 'not_found', 'No such notebook', 404 ); }
		if ( $r['status'] === 'published' && ! $owner ) { Data::bump( 'aq_notebooks', [ 'id' => (int) $r['id'] ], 'view_count' ); }
		return self::full( $r, $owner );
	}

	/** GET notebooks/{id}/ipynb — the raw executed notebook as a real .ipynb download, the exact
	 *  file the in-browser runner (JupyterLite) and Colab both open. Published posts only. */
	public static function raw_ipynb( $req ) {
		self::ensure_tables();
		$r = self::row( Rest::pint( $req, 'id' ) );
		// Drafts serve too: the entire database is public by design (the /data explorer shows every
		// draft's source anyway), so gating the raw file added zero secrecy and broke browser runs —
		// feed invisibility, not file secrecy, is what "draft" means here (operator 2026-07-15).
		if ( ! $r || $r['status'] === 'removed' ) { return Rest::err( 'not_found', 'No such post', 404 ); }
		$body = (string) ( $r['ipynb_out'] ?? '' );
		if ( '' === $body ) { $body = (string) ( $r['ipynb'] ?? '' ); }
		$resp = new \WP_REST_Response( json_decode( $body ) );
		$resp->header( 'Content-Disposition', 'inline; filename="' . sanitize_title( $r['slug'] ) . '.ipynb"' );
		$resp->header( 'Cache-Control', $r['status'] === 'published' ? 'public, max-age=300' : 'private, no-store' );
		return $resp;
	}

	/** GET notebooks/{id}/weights — THE MODEL'S PERMANENT ADDRESS (operator 2026-07-26, the music
	 *  kind). A Music work ships out/weights.safetensors beside its audio, bound to it by the
	 *  track_sha256 in the container's own __metadata__; this route is where a listener fetches
	 *  those weights and re-renders the piece for themselves — a citable sibling of the DOI that
	 *  does not depend on knowing the uploads path. A 302 to the CDN copy, so the bytes are served
	 *  by the file host and never streamed through PHP.
	 *  PUBLISHED ONLY — unlike raw_ipynb (whose file is public anyway via the /data explorer), a
	 *  permanent address is something publication MINTS: a draft has no citable identity, and a
	 *  removed work must leave nothing fetchable behind. Refused exactly as its neighbours refuse. */
	public static function weights( $req ) {
		self::ensure_tables();
		$r = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $r || $r['status'] !== 'published' ) { return Rest::err( 'not_found', 'No such post', 404 ); }
		$url = '';
		foreach ( Data::dec( $r['assets'] ?? '' ) ?: [] as $a ) {
			if ( (string) ( $a['name'] ?? '' ) === 'weights.safetensors' ) { $url = (string) ( $a['url'] ?? '' ); break; }
		}
		if ( $url === '' ) { return Rest::err( 'no_weights', 'This work ships no model weights', 404 ); }
		$resp = new \WP_REST_Response( null, 302 );
		$resp->header( 'Location', $url );
		// Only the REDIRECT is cached, and briefly: the target is the work's stable uploads path
		// (uploads/notebooks/<id>/weights.safetensors), so a re-run replaces the bytes at the same
		// address — cache the hop, never let it outlive a re-upload. dispatch() adds no header of
		// its own to a handler-built response, so this is the whole cache policy.
		$resp->header( 'Cache-Control', 'public, max-age=300' );
		return $resp;
	}

	/** GET notebooks/{id}/reviews — the critic's public track record for a published work. */
	public static function heart( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_nb_heart', 60, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		$r   = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $r || $r['status'] !== 'published' ) { return Rest::err( 'not_found', 'No such notebook', 404 ); }
		// NO SELF-HEARTS. The retired Challenges::heart refused these outright; this path only ever
		// skipped the notification, so the vote itself counted — and a challenge pool is awarded to
		// whoever leads on exactly this number. In a young challenge where entries sit at 0-1
		// hearts, one self-heart takes every other entrant's burned fee. It also silently inflated
		// the feed's `sort=top` and the who-to-follow rail.
		if ( (int) $r['author_id'] === $uid ) {
			return Rest::err( 'self_heart', 'You cannot heart your own work', 403 );
		}
		$val = Rest::pint( $req, 'val', 1 ) ? 1 : 0;
		Data::upsert( 'aq_votes', [ 'user_id' => $uid, 'target_type' => 'notebook', 'target_id' => (int) $r['id'] ], [
			'val' => $val, 'created' => Data::now(),
		] );
		$hearts = (int) Data::col(
			'SELECT COUNT(*) FROM ' . Data::t( 'aq_votes' ) . " WHERE target_type = 'notebook' AND target_id = %d AND val = 1",
			[ (int) $r['id'] ] );
		Data::update( 'aq_notebooks', [ 'hearts' => $hearts ], [ 'id' => (int) $r['id'] ] );
		if ( $val && (int) $r['author_id'] !== $uid ) {
			$me = get_userdata( $uid );
			Notify::push( (int) $r['author_id'], 'heart', ( $me ? $me->display_name : 'Someone' ) . ' loved "' . $r['title'] . '"', '',
				'/nb/' . $r['id'] . '/' . $r['slug'] . '/', 'nbheart' . $r['id'] . ':' . $uid );
		}
		return [ 'ok' => true, 'hearts' => $hearts, 'mine' => $val ];
	}

	/** GET notebooks/{id}/comments — the post's thread: root comments (keyset) with their replies.
	 *  Same polymorphic aq_comments store as everything social (context_type 'notebook'). */
	public static function comments( $req ) {
		self::ensure_tables();
		$r = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $r || $r['status'] !== 'published' ) { return Rest::err( 'not_found', 'No such post', 404 ); }
		$cursor = Rest::pint( $req, 'cursor', 0 );
		[ $roots, $next ] = Data::page( 'aq_comments', "context_type = 'notebook' AND context_id = %d AND parent_id = 0", [ (int) $r['id'] ], $cursor, 20 );
		$T   = Data::t( 'aq_comments' );
		$uid = Rest::uid();
		$fmt = static function ( $c ) {
			return [
				'id' => (int) $c['id'], 'parent_id' => (int) $c['parent_id'], 'body' => (string) $c['body'],
				'votes' => (int) $c['votes'], 'flagged' => (int) ( $c['flagged'] ?? 0 ), 'created' => (int) $c['created'],
				'author' => self::author_card( $c['author_id'] ),
			];
		};
		$items = [];
		foreach ( $roots as $c ) {
			$row            = $fmt( $c );
			$row['replies'] = array_map( $fmt, Data::all(
				"SELECT * FROM {$T} WHERE context_type = 'notebook' AND context_id = %d AND parent_id = %d ORDER BY id ASC LIMIT 12",
				[ (int) $r['id'], (int) $c['id'] ] ) );
			$items[] = $row;
		}
		$mine = [];
		if ( $uid && $items ) {
			$ids = [];
			foreach ( $items as $row ) { $ids[] = $row['id']; foreach ( $row['replies'] as $rep ) { $ids[] = $rep['id']; } }
			$place = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
			foreach ( Data::all( 'SELECT target_id FROM ' . Data::t( 'aq_votes' ) . " WHERE user_id = %d AND target_type = 'comment' AND val = 1 AND target_id IN ($place)", array_merge( [ $uid ], $ids ) ) as $v ) {
				$mine[] = (int) $v['target_id'];
			}
		}
		return [ 'items' => $items, 'next' => $next, 'mine' => $mine ];
	}

	/** POST notebooks/{id}/comments {body, parent_id?} — reply to a post. Queued for ArtaMod
	 *  (fail-open), notifies the post author and the parent commenter. */
	public static function comment( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_nb_comment', 20, 300 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		$r   = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $r || $r['status'] !== 'published' ) { return Rest::err( 'not_found', 'No such post', 404 ); }
		$body = trim( wp_kses( (string) Rest::p( $req, 'body', '' ), [] ) );
		if ( mb_strlen( $body ) < 2 ) { return Rest::err( 'empty', 'Say something' ); }
		$body   = mb_substr( $body, 0, 4000 );
		$parent = Rest::pint( $req, 'parent_id', 0 );
		$pc     = null;
		if ( $parent ) {
			$pc = Data::one( 'SELECT id, author_id FROM ' . Data::t( 'aq_comments' ) . " WHERE id = %d AND context_type = 'notebook' AND context_id = %d", [ $parent, (int) $r['id'] ] );
			if ( ! $pc ) { return Rest::err( 'bad_parent', 'No such comment' ); }
		}
		$flagged = 0;
		$modq    = 1;
		try {
			if ( class_exists( '\\AQ\\Fearometer' ) && method_exists( '\\AQ\\Fearometer', 'score' ) ) {
				// score() returns an ARRAY — [ fear, flagged, reason, categories ] — or NULL, and
				// NULL is the normal answer: there is no server-side scorer (the paid API was removed
				// 2026-06-13) and the subscription relay scores in batches, so only the test seam
				// resolves inline. Treating null as a clean verdict is why every comment on the feed
				// was stored flagged=0 no matter what it said, while /about promised members their
				// comments ARE checked.
				//
				// So: an array verdict is a real screen (read its own `flagged`, computed against the
				// operator-settable limit()); NULL means NOT SCREENED YET → queue it (modq = 1) for
				// Fearometer::process_queue to score on the relay.
				$verdict = Fearometer::score( $body );
				if ( is_array( $verdict ) ) { $flagged = empty( $verdict['flagged'] ) ? 0 : 1; $modq = 0; }
			}
		} catch ( \Throwable $e ) { $flagged = 0; $modq = 1; } // ArtaMod never blocks posting; the queue retries
		$cid = Data::insert( 'aq_comments', [
			'context_type' => 'notebook', 'context_id' => (int) $r['id'], 'parent_id' => $parent,
			'author_id' => $uid, 'body' => $body, 'flagged' => $flagged, 'modq' => $modq, 'created' => Data::now(),
		] );
		if ( ! $cid ) { return Rest::err( 'server_error', 'Could not post', 500 ); }
		Data::bump( 'aq_notebooks', [ 'id' => (int) $r['id'] ], 'comments' );
		Economy::award_points( $uid, 1, 'learn', 'nbc:' . $cid );
		$me  = get_userdata( $uid );
		$who = $me ? $me->display_name : 'Someone';
		$url = '/nb/' . $r['id'] . '/' . $r['slug'] . '/';
		if ( (int) $r['author_id'] !== $uid ) {
			Notify::push( (int) $r['author_id'], 'comment', $who . ' commented on "' . $r['title'] . '"', mb_substr( $body, 0, 120 ), $url, 'nbc' . $cid );
		}
		if ( $pc && (int) $pc['author_id'] !== $uid && (int) $pc['author_id'] !== (int) $r['author_id'] ) {
			Notify::push( (int) $pc['author_id'], 'reply', $who . ' replied to your comment', mb_substr( $body, 0, 120 ), $url, 'nbcr' . $cid );
		}
		return [ 'ok' => true, 'id' => (int) $cid, 'flagged' => $flagged ];
	}

	/** GET notebooks/{id}/poll — per-item answer distributions (1-5 counts) + the caller's answers. */
	public static function poll_get( $req ) {
		self::ensure_tables();
		$r = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $r || $r['status'] !== 'published' ) { return Rest::err( 'not_found', 'No such post', 404 ); }
		$dist = [];
		foreach ( Data::all( 'SELECT item, val, COUNT(*) c FROM ' . Data::t( 'aq_nb_poll' ) . ' WHERE nb_id = %d GROUP BY item, val', [ (int) $r['id'] ] ) as $row ) {
			$dist[ $row['item'] ] = $dist[ $row['item'] ] ?? [ 0, 0, 0, 0, 0 ];
			$v = (int) $row['val'];
			if ( $v >= 1 && $v <= 5 ) { $dist[ $row['item'] ][ $v - 1 ] = (int) $row['c']; }
		}
		$mine = [];
		$uid  = Rest::uid();
		if ( $uid ) {
			foreach ( Data::all( 'SELECT item, val FROM ' . Data::t( 'aq_nb_poll' ) . ' WHERE nb_id = %d AND user_id = %d', [ (int) $r['id'], $uid ] ) as $row ) {
				$mine[ $row['item'] ] = (int) $row['val'];
			}
		}
		return [ 'dist' => $dist ?: (object) [], 'mine' => $mine ?: (object) [] ];
	}

	/** Read a published notebook's single-select typology instrument (out/instrument.json) from
	 *  the platform's OWN uploads — the file the relay wrote from the admin-approved notebook, so
	 *  the option→image map is trusted (never client input). Returns the decoded doc or null. */
	private static function typology_doc( $r ) {
		if ( (string) $r['kind'] !== 'survey' ) { return null; }
		$assets = Data::dec( $r['assets'] ?? '' ) ?: [];
		$path   = '';
		foreach ( $assets as $a ) {
			if ( (string) ( $a['name'] ?? '' ) === 'instrument.json' ) {
				$url  = (string) ( $a['url'] ?? '' );
				$rel  = parse_url( $url, PHP_URL_PATH );
				$up   = wp_get_upload_dir();
				$base = parse_url( $up['baseurl'], PHP_URL_PATH );
				if ( $rel && $base && strpos( $rel, $base ) === 0 ) {
					$path = $up['basedir'] . substr( $rel, strlen( $base ) );
				}
				break;
			}
		}
		if ( $path === '' || ! is_readable( $path ) ) { return null; }
		$doc = json_decode( (string) file_get_contents( $path ), true );
		if ( ! is_array( $doc ) || strtolower( (string) ( $doc['type'] ?? '' ) ) !== 'single' ) { return null; }
		return $doc;
	}

	/** The community tally for a single-select typology: counts per option id + the caller's pick. */
	public static function pick_get( $req ) {
		self::ensure_tables();
		$r = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $r || $r['status'] !== 'published' ) { return Rest::err( 'not_found', 'No such post', 404 ); }
		$doc = self::typology_doc( $r );
		if ( ! $doc ) { return Rest::err( 'not_typology', 'Not a single-select typology', 409 ); }
		$counts = [];
		foreach ( Data::all( 'SELECT item, COUNT(*) c FROM ' . Data::t( 'aq_nb_poll' ) . " WHERE nb_id = %d AND val = 0 GROUP BY item", [ (int) $r['id'] ] ) as $row ) {
			$counts[ (string) $row['item'] ] = (int) $row['c'];
		}
		$uid  = Rest::uid();
		$mine = $uid ? (string) Data::col( 'SELECT item FROM ' . Data::t( 'aq_nb_poll' ) . ' WHERE nb_id = %d AND user_id = %d AND val = 0 LIMIT 1', [ (int) $r['id'], $uid ] ) : '';
		return [ 'counts' => $counts ?: (object) [], 'mine' => $mine ];
	}

	/** POST notebooks/{id}/pick {option} — choose one character. Records the pick AND sets that
	 *  option's image as the member's public avatar (the season-sigil slot; an uploaded photo still
	 *  wins). One pick per member, changeable. Returns the fresh tally + the avatar it set. */
	public static function pick_answer( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_nb_pick', 30, 300 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		$r   = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $r || $r['status'] !== 'published' ) { return Rest::err( 'not_found', 'No such post', 404 ); }
		$doc = self::typology_doc( $r );
		if ( ! $doc ) { return Rest::err( 'not_typology', 'Not a single-select typology', 409 ); }
		$oid = sanitize_text_field( mb_substr( (string) Rest::p( $req, 'option', '' ), 0, 40 ) );
		$opt = null;
		foreach ( (array) ( $doc['options'] ?? [] ) as $o ) {
			if ( is_array( $o ) && (string) ( $o['id'] ?? '' ) === $oid ) { $opt = $o; break; }
		}
		if ( ! $opt ) { return Rest::err( 'bad_option', 'Pick one of the listed options' ); }
		// val = 0 marks a single-select pick (Likert answers use 1-5); item = the option id.
		Data::upsert( 'aq_nb_poll', [ 'nb_id' => (int) $r['id'], 'item' => $oid, 'user_id' => $uid ], [ 'val' => 0, 'created' => Data::now() ] );
		// Remove any earlier pick on THIS typology for a different option (one pick per member).
		global $wpdb;
		$wpdb->query( $wpdb->prepare(
			'DELETE FROM ' . Data::t( 'aq_nb_poll' ) . ' WHERE nb_id = %d AND user_id = %d AND val = 0 AND item <> %s',
			(int) $r['id'], $uid, $oid ) );
		// Set the avatar — but never overwrite a photo the member uploaded themselves.
		$img = esc_url_raw( (string) ( $opt['image'] ?? '' ) );
		$set = false;
		if ( $img !== '' && preg_match( '#^https?://#', $img )
			&& (string) get_user_meta( $uid, 'aq_avatar_url', true ) === '' ) {
			update_user_meta( $uid, 'aq_typology_pic', $img );
			update_user_meta( $uid, 'aq_typology_label', sanitize_text_field( (string) ( $opt['label'] ?? '' ) ) );
			update_user_meta( $uid, 'aq_typology_nb', (int) $r['id'] );
			$set = true;
		}
		$counts = [];
		foreach ( Data::all( 'SELECT item, COUNT(*) c FROM ' . Data::t( 'aq_nb_poll' ) . " WHERE nb_id = %d AND val = 0 GROUP BY item", [ (int) $r['id'] ] ) as $row ) {
			$counts[ (string) $row['item'] ] = (int) $row['c'];
		}
		return [ 'ok' => true, 'mine' => $oid, 'counts' => $counts ?: (object) [], 'avatar' => $set ? $img : '', 'avatar_set' => $set ];
	}

	/** POST notebooks/{id}/poll {item, val 1-5} — answer one survey item; returns that item's fresh distribution. */
	public static function poll_answer( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_nb_poll', 60, 300 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		$r   = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $r || $r['status'] !== 'published' ) { return Rest::err( 'not_found', 'No such post', 404 ); }
		$item = sanitize_text_field( mb_substr( (string) Rest::p( $req, 'item', '' ), 0, 40 ) );
		$val  = Rest::pint( $req, 'val', 0 );
		if ( $item === '' || $val < 1 || $val > 5 ) { return Rest::err( 'bad_input', 'Pick an option' ); }
		Data::upsert( 'aq_nb_poll', [ 'nb_id' => (int) $r['id'], 'item' => $item, 'user_id' => $uid ], [ 'val' => $val, 'created' => Data::now() ] );
		$dist = [ 0, 0, 0, 0, 0 ];
		foreach ( Data::all( 'SELECT val, COUNT(*) c FROM ' . Data::t( 'aq_nb_poll' ) . ' WHERE nb_id = %d AND item = %s GROUP BY val', [ (int) $r['id'], $item ] ) as $row ) {
			if ( (int) $row['val'] >= 1 && (int) $row['val'] <= 5 ) { $dist[ (int) $row['val'] - 1 ] = (int) $row['c']; }
		}
		return [ 'ok' => true, 'item' => $item, 'dist' => $dist ];
	}

	/** The feed IS posts (2026-07-14): text-only ≤280 chars, or text + ONE of the author's own
	 *  notebooks. v2 (2026-07-22): attachable = PUBLISHED, nothing less — a published status is the
	 *  only state that proves the full gate (blind panel + admin approval) was passed. */

	public static function posts( $req ) {
		self::ensure_tables();
		$cursor = Rest::pint( $req, 'cursor', 0 );
		$kind   = sanitize_key( (string) Rest::p( $req, 'kind', '' ) );
		$where  = '1=1';
		$args   = [];
		if ( $kind !== '' && isset( self::KINDS[ $kind ] ) ) {
			$where .= ' AND nb_id IN (SELECT id FROM ' . Data::t( 'aq_notebooks' ) . ' WHERE kind = %s)';
			$args[] = $kind;
		}
		// The ArtaContrast calm filter (text-only posts pass: nb_id 0 has no change rate).
		$calm_min = Rest::pint( $req, 'calm_min', 0 );
		if ( $calm_min > 0 ) {
			$where .= ' AND (nb_id = 0 OR nb_id IN (SELECT id FROM ' . Data::t( 'aq_notebooks' ) . ' WHERE calm >= %d))';
			$args[] = min( 100, $calm_min );
		}
		if ( Rest::pint( $req, 'following', 0 ) && Rest::uid() ) {
			$where .= ' AND author_id IN (SELECT target_id FROM ' . Data::t( 'aq_follows' ) . ' WHERE follower_id = %d)';
			$args[] = Rest::uid();
		}
		if ( Rest::p( $req, 'sort', 'new' ) === 'top' ) {
			global $wpdb;
			$sql  = 'SELECT * FROM ' . Data::t( 'aq_posts' ) . " WHERE {$where} ORDER BY hearts DESC, id DESC LIMIT 100";
			$rows = $args ? Data::all( $sql, $args ) : $wpdb->get_results( $sql, ARRAY_A );
			$rows = $rows ?: [];
			return [ 'items' => array_map( [ self::class, 'post_out' ], $rows ), 'next' => null, 'mine' => self::my_hearts( $rows ) ];
		}
		[ $rows, $next ] = Data::page( 'aq_posts', $where, $args, $cursor, self::PAGE );
		return [ 'items' => array_map( [ self::class, 'post_out' ], $rows ), 'next' => $next, 'mine' => self::my_hearts( $rows ) ];
	}

	private static function post_out( $p, $depth = 0 ) {
		$nb = $p['nb_id'] ? self::row( $p['nb_id'] ) : null;
		$re = null;
		if ( $depth === 0 && ! empty( $p['repost_id'] ) ) {
			$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_posts' ) . ' WHERE id = %d', [ (int) $p['repost_id'] ] );
			$re  = $row ? self::post_out( $row, 1 ) : null;
		}
		// Library attachments ride with the post, each carrying the work it came out of — so a
		// re-used artifact always shows whose run produced it, wherever it turns up.
		$media = Data::all(
			'SELECT l.*, n.id AS w_id, n.title AS w_title, n.slug AS w_slug, n.doi AS w_doi, n.kg_url AS w_kernel, n.author_id AS w_author'
			. ' FROM ' . Data::t( 'aq_post_media' ) . ' m'
			. ' JOIN ' . Data::t( 'aq_library' ) . ' l ON l.id = m.lib_id'
			. ' JOIN ' . Data::t( 'aq_notebooks' ) . " n ON n.id = l.nb_id AND n.status = 'published'"
			. ' WHERE m.post_id = %d ORDER BY m.pos, m.id', [ (int) $p['id'] ] );
		$media = array_map( function ( $row ) {
			$c         = Kernel::lib_card( $row );
			$c['work'] = [
				'id' => (int) $row['w_id'], 'title' => (string) $row['w_title'], 'slug' => (string) $row['w_slug'],
				'doi' => (string) $row['w_doi'], 'kernel' => (string) $row['w_kernel'],
				'author' => self::author_card( (int) $row['w_author'] ),
			];
			return $c;
		}, $media );
		return [
			'id' => (int) $p['id'], 'body' => (string) $p['body'], 'hearts' => (int) $p['hearts'],
			'reposts' => (int) ( $p['reposts'] ?? 0 ), 'created' => (int) $p['created'],
			'author' => self::author_card( $p['author_id'] ),
			'nb' => $nb && $nb['status'] !== 'removed' ? self::card( $nb ) : null,
			'media' => $media,
			'repost' => $re,
		];
	}

	public static function post_create( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_post', 15, 300 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = Rest::uid();
		$body = trim( wp_kses( (string) Rest::p( $req, 'body', '' ), [] ) );
		$nbid = Rest::pint( $req, 'nb_id', 0 );
		$reid = Rest::pint( $req, 'repost_id', 0 );
		if ( mb_strlen( $body ) > 280 ) { return Rest::err( 'too_long', 'Keep it to 280 characters' ); }
		// The "is this post empty" test lives BELOW, after the attachments are resolved — a post
		// that is nothing but a Library item is a perfectly good post.
		$orig = null;
		if ( $reid ) {
			$orig = Data::one( 'SELECT * FROM ' . Data::t( 'aq_posts' ) . ' WHERE id = %d', [ $reid ] );
			if ( ! $orig ) { return Rest::err( 'not_found', 'No such post', 404 ); }
			if ( ! empty( $orig['repost_id'] ) && $body === '' ) { $reid = (int) $orig['repost_id']; } // reposting a plain repost boosts the original
		}
		if ( $nbid ) {
			$nb = self::row( $nbid );
			if ( ! $nb || (int) $nb['author_id'] !== $uid ) { return Rest::err( 'not_yours', 'You can only attach your own Studio works', 403 ); }
			if ( (string) $nb['status'] !== 'published' ) {
				return Rest::err( 'not_published', 'Only published works can be attached — clear the reproducibility checklist and confirm from your inbox first', 409 );
			}
		}
		// LIBRARY ATTACHMENTS (operator 2026-07-28) — the point of the reset. Any member may attach
		// ANY published Library item, not only their own: a reproducible artifact stops being locked
		// inside the work that produced it. Ownership is deliberately NOT required here; provenance
		// travels with the item (every card carries its work, its author and its kernel link), so
		// re-use is credited rather than prevented.
		$media = Rest::p( $req, 'media', [] );
		$media = is_array( $media ) ? array_slice( array_values( array_unique( array_map( 'intval', $media ) ) ), 0, 4 ) : [];
		$media = array_values( array_filter( $media ) );
		if ( $media ) {
			$in   = implode( ',', array_fill( 0, count( $media ), '%d' ) );
			$live = Data::all(
				'SELECT l.id FROM ' . Data::t( 'aq_library' ) . ' l'
				. ' JOIN ' . Data::t( 'aq_notebooks' ) . " n ON n.id = l.nb_id AND n.status = 'published'"
				. ' WHERE l.id IN (' . $in . ')', $media );
			if ( count( $live ) !== count( $media ) ) {
				return Rest::err( 'bad_media', 'One of those files is no longer published', 409 );
			}
		}
		if ( $body === '' && ! $nbid && ! $reid && ! $media ) { return Rest::err( 'empty', 'Say something' ); }
		$id = Data::insert( 'aq_posts', [ 'author_id' => $uid, 'body' => mb_substr( $body, 0, 280 ), 'nb_id' => $nbid, 'repost_id' => $reid, 'created' => Data::now() ] );
		if ( $id && $media ) {
			foreach ( $media as $pos => $lib_id ) {
				Data::insert( 'aq_post_media', [ 'post_id' => (int) $id, 'lib_id' => (int) $lib_id, 'pos' => (int) $pos, 'created' => Data::now() ] );
				Data::bump( 'aq_library', [ 'id' => (int) $lib_id ], 'uses' );
			}
		}
		if ( $id && $orig ) {
			Data::bump( 'aq_posts', [ 'id' => (int) $orig['id'] ], 'reposts' );
			if ( (int) $orig['author_id'] !== $uid ) {
				$me = get_userdata( $uid );
				Notify::push( (int) $orig['author_id'], 'repost', ( $me ? $me->display_name : 'Someone' ) . ( $body !== '' ? ' quoted your post' : ' reposted your post' ), mb_substr( $body, 0, 120 ), '/works/', 'repost' . $id );
			}
		}
		return $id ? self::post_out( Data::one( 'SELECT * FROM ' . Data::t( 'aq_posts' ) . ' WHERE id = %d', [ $id ] ) )
			: Rest::err( 'server_error', 'Could not post', 500 );
	}

	public static function post_heart( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_post_heart', 60, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		$p   = Data::one( 'SELECT * FROM ' . Data::t( 'aq_posts' ) . ' WHERE id = %d', [ Rest::pint( $req, 'id' ) ] );
		if ( ! $p ) { return Rest::err( 'not_found', 'No such post', 404 ); }
		$val = Rest::pint( $req, 'val', 1 ) ? 1 : 0;
		Data::upsert( 'aq_votes', [ 'user_id' => $uid, 'target_type' => 'post', 'target_id' => (int) $p['id'] ], [ 'val' => $val, 'created' => Data::now() ] );
		$hearts = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_votes' ) . " WHERE target_type = 'post' AND target_id = %d AND val = 1", [ (int) $p['id'] ] );
		Data::update( 'aq_posts', [ 'hearts' => $hearts ], [ 'id' => (int) $p['id'] ] );
		return [ 'ok' => true, 'hearts' => $hearts, 'mine' => $val ];
	}

	/** POST posts/{id}/edit {body} — the author revises their post's text (attachment unchanged). */
	public static function post_edit( $req ) {
		self::ensure_tables();
		$uid = Rest::uid();
		$p   = Data::one( 'SELECT * FROM ' . Data::t( 'aq_posts' ) . ' WHERE id = %d', [ Rest::pint( $req, 'id' ) ] );
		if ( ! $p || ( (int) $p['author_id'] !== $uid && ! current_user_can( 'manage_options' ) ) ) { return Rest::err( 'not_found', 'No such post', 404 ); }
		$body = trim( wp_kses( (string) Rest::p( $req, 'body', '' ), [] ) );
		if ( mb_strlen( $body ) > 280 ) { return Rest::err( 'too_long', 'Keep it to 280 characters' ); }
		if ( $body === '' && ! (int) $p['nb_id'] && ! (int) $p['repost_id'] ) { return Rest::err( 'empty', 'Say something' ); }
		Data::update( 'aq_posts', [ 'body' => mb_substr( $body, 0, 280 ) ], [ 'id' => (int) $p['id'] ] );
		return self::post_out( Data::one( 'SELECT * FROM ' . Data::t( 'aq_posts' ) . ' WHERE id = %d', [ (int) $p['id'] ] ) );
	}

	/** POST posts/{id}/delete — the author removes their post (reposts of it degrade gracefully). */
	public static function post_delete( $req ) {
		self::ensure_tables();
		$uid = Rest::uid();
		$p   = Data::one( 'SELECT * FROM ' . Data::t( 'aq_posts' ) . ' WHERE id = %d', [ Rest::pint( $req, 'id' ) ] );
		if ( ! $p || ( (int) $p['author_id'] !== $uid && ! current_user_can( 'manage_options' ) ) ) { return Rest::err( 'not_found', 'No such post', 404 ); }
		global $wpdb;
		if ( (int) $p['repost_id'] ) {
			$wpdb->query( $wpdb->prepare( 'UPDATE ' . Data::t( 'aq_posts' ) . ' SET reposts = GREATEST(reposts - 1, 0) WHERE id = %d', (int) $p['repost_id'] ) );
		}
		$wpdb->delete( Data::t( 'aq_posts' ), [ 'id' => (int) $p['id'] ] );
		return [ 'ok' => true ];
	}

	/** POST notebooks/{id}/comments/{cid}/edit {body} — the commenter revises their reply. */
	public static function comment_edit( $req ) {
		self::ensure_tables();
		$uid = Rest::uid();
		$c   = Data::one( 'SELECT * FROM ' . Data::t( 'aq_comments' ) . " WHERE id = %d AND context_type = 'notebook' AND context_id = %d", [ Rest::pint( $req, 'cid' ), Rest::pint( $req, 'id' ) ] );
		if ( ! $c || ( (int) $c['author_id'] !== $uid && ! current_user_can( 'manage_options' ) ) ) { return Rest::err( 'not_found', 'No such comment', 404 ); }
		$body = trim( wp_kses( (string) Rest::p( $req, 'body', '' ), [] ) );
		if ( mb_strlen( $body ) < 2 ) { return Rest::err( 'empty', 'Say something' ); }
		Data::update( 'aq_comments', [ 'body' => mb_substr( $body, 0, 4000 ) ], [ 'id' => (int) $c['id'] ] );
		return [ 'ok' => true, 'body' => mb_substr( $body, 0, 4000 ) ];
	}

	/** POST notebooks/{id}/comments/{cid}/delete — the commenter removes their reply (and its children). */
	public static function comment_delete( $req ) {
		self::ensure_tables();
		$uid = Rest::uid();
		$nid = Rest::pint( $req, 'id' );
		$c   = Data::one( 'SELECT * FROM ' . Data::t( 'aq_comments' ) . " WHERE id = %d AND context_type = 'notebook' AND context_id = %d", [ Rest::pint( $req, 'cid' ), $nid ] );
		if ( ! $c || ( (int) $c['author_id'] !== $uid && ! current_user_can( 'manage_options' ) ) ) { return Rest::err( 'not_found', 'No such comment', 404 ); }
		global $wpdb;
		$kids = (int) $wpdb->query( $wpdb->prepare( 'DELETE FROM ' . Data::t( 'aq_comments' ) . " WHERE context_type = 'notebook' AND context_id = %d AND parent_id = %d", $nid, (int) $c['id'] ) );
		$wpdb->delete( Data::t( 'aq_comments' ), [ 'id' => (int) $c['id'] ] );
		Data::bump( 'aq_notebooks', [ 'id' => $nid ], 'comments', -( 1 + $kids ) );
		return [ 'ok' => true ];
	}

	// ── Studio (author) ──────────────────────────────────────────────────────

	/** GET studio/notebooks — everything I've made, drafts first. */
	public static function mine( $req ) {
		self::ensure_tables();
		$cursor = Rest::pint( $req, 'cursor', 0 );
		[ $rows, $next ] = Data::page( 'aq_notebooks', "author_id = %d AND status <> 'removed'", [ Rest::uid() ], $cursor, self::PAGE );
		return [ 'items' => array_map( [ self::class, 'card' ], $rows ), 'next' => $next ];
	}

	/** RETIRED: works are not authored here any more — POST studio/kernels with a Kaggle URL. */
	public static function create( $req ) {
		return Rest::err( 'gone',
			'Works are no longer authored here. Write and run your notebook on Kaggle, then POST its URL to studio/kernels.', 410 );
	}

	/** POST studio/notebooks/{id}/save {title?,abstract?} — the only fields a member owns here. */
	public static function save( $req ) {
		self::ensure_tables();
		$uid = Rest::uid();
		$r   = self::row( Rest::pint( $req, 'id' ) );
		if ( ! self::can_edit( $r, $uid ) ) { return Rest::err( 'not_found', 'No such notebook', 404 ); }
		if ( $r['status'] === 'removed' ) { return Rest::err( 'gone', 'Removed', 410 ); }
		// TITLE AND ABSTRACT ONLY (operator 2026-07-28). The source of record is the author's Kaggle
		// kernel: `ipynb` holds what we pulled from it, and sig() over that value is what the confirm
		// link, the review ledger and the database publish-guard are all keyed on. Letting a client
		// write `ipynb` here would desync that signature from the notebook every check was read from —
		// a green checklist certifying source nobody checked. Edit the notebook on Kaggle and re-check.
		$upd   = [ 'updated' => Data::now() ];
		$title = sanitize_text_field( (string) Rest::p( $req, 'title', '' ) );
		if ( $title !== '' && mb_strlen( $title ) >= 3 ) { $upd['title'] = $title; }
		$abstract = trim( (string) Rest::p( $req, 'abstract', '' ) );
		if ( $abstract !== '' ) { $upd['abstract'] = sanitize_textarea_field( mb_substr( $abstract, 0, 2000 ) ); }
		// ANY change while pending withdraws the request — the author must only ever confirm exactly
		// what they were shown (title and abstract included, not just the notebook).
		//
		// AND THE EMAILED LINK MUST DIE WITH IT. Dropping the status to 'draft' alone left
		// author_token standing, and the token is bound to sig(ipynb) — the SOURCE — which an edit to
		// the title or abstract does not change. So the already-sent link stayed cryptographically
		// valid across the edit, and the next publication request put the row back to 'pending', at
		// which point that OLD link confirmed the NEW title: the author's signature covering text they
		// were never shown. This is the same defect as the file-selection one — a consent signature
		// must bind what gets published, not just the source — reappearing in a different field.
		// Clearing the token here is exactly what the explicit withdraw path already does, so the two
		// ways of taking a request back now leave the row in the same state.
		if ( (string) $r['status'] === 'pending' && ! isset( $upd['status'] )
			&& ( ( isset( $upd['title'] ) && $upd['title'] !== (string) $r['title'] )
				|| ( isset( $upd['abstract'] ) && $upd['abstract'] !== (string) $r['abstract'] ) ) ) {
			$upd['status']        = 'draft';
			$upd['author_token']  = '';
			$upd['author_nonce']  = '';
			$upd['decision_note'] = 'withdrawn — the work was edited after publication was requested';
		}
		Data::update( 'aq_notebooks', $upd, [ 'id' => (int) $r['id'] ] );
		return self::full( self::row( $r['id'] ), true );
	}

	/** POST studio/notebooks/{id}/run — free offline execution (throttled). */
	public static function run( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_nb_run', 12, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		return self::enqueue( $req, 'run', 0 );
	}

	// ArtaDev (the paid critic+dev loop) was RETIRED by the ArtaCritic pivot (2026-07-16), and the
	// whole local-execution pipeline with it (2026-07-28). Neither route is registered any more, so
	// nothing below can be reached; the relay endpoints that used to settle a queued run are gone
	// too. Any 'dev' row still sitting in aq_nb_runs will never complete — reconcile those by hand
	// (append a compensating ledger row), never by re-registering an executor.

	private static function enqueue( $req, $type, $iters ) {
		$uid = Rest::uid();
		$r   = self::row( Rest::pint( $req, 'id' ) );
		if ( ! self::can_edit( $r, $uid ) ) { return Rest::err( 'not_found', 'No such notebook', 404 ); }
		if ( $r['status'] === 'removed' ) { return Rest::err( 'gone', 'Removed', 410 ); }
		if ( (string) $r['ipynb'] === '' ) { return Rest::err( 'empty', 'Nothing to run yet' ); }
		// A usage-policy refusal is PERMANENT for this exact source (nb 31 was retried 5× in a
		// loop by an authoring agent) — refuse to re-queue until the draft actually changes.
		// Sig-bound like every gate: any edit clears it.
		$last = Data::one(
			'SELECT sig, error FROM ' . Data::t( 'aq_nb_runs' )
			. " WHERE nb_id = %d AND state = 'error' ORDER BY id DESC LIMIT 1", [ (int) $r['id'] ] );
		if ( $last && stripos( (string) $last['error'], 'usage policy' ) !== false
			&& hash_equals( (string) $last['sig'], self::sig( $r['ipynb'] ) ) ) {
			return Rest::err( 'unreviewable', 'The reviewer declined this exact version under its usage policy — edit the draft before running it again', 409 );
		}
		$open = Data::col(
			'SELECT id FROM ' . Data::t( 'aq_nb_runs' ) . " WHERE nb_id = %d AND state IN ('queued','claimed') LIMIT 1",
			[ (int) $r['id'] ] );
		if ( $open ) { return Rest::err( 'busy', 'A run is already queued for this notebook', 409 ); }
		$cost = 0;
		if ( $type === 'dev' ) {
			$cost = self::dev_cost( $r['size_bytes'], $iters );
			if ( Economy::coin_balance( $uid ) < $cost ) { return Rest::err( 'poor', 'Not enough ArtaCoins (needs ₳' . $cost . ')', 402 ); }
		}
		$now = Data::now();
		// author_id on the RUN is the payer (the caller) — refunds must return to whoever paid.
		$rid = Data::insert( 'aq_nb_runs', [
			'nb_id' => (int) $r['id'], 'author_id' => $uid, 'type' => $type,
			'iters' => $iters, 'state' => 'queued', 'sig' => self::sig( $r['ipynb'] ),
			'cost' => $cost, 'created' => $now, 'updated' => $now,
		] );
		if ( ! $rid ) { return Rest::err( 'server_error', 'Could not queue', 500 ); }
		if ( $cost > 0 ) {
			// Charged to the OWNER (an admin poking a member draft pays the member nothing).
			Economy::credit_coins( $uid, -$cost, 'nbdev', 'nbdev:' . $r['id'] . ':' . $rid );
		}
		return [ 'ok' => true, 'run_id' => (int) $rid, 'cost' => $cost, 'queued' => true ];
	}

	/** Shared server-side re-verification of every publication precondition for the CURRENT source.
	 *  Returns '' when everything holds, else the human reason. Used by publish() (the request) AND
	 *  author_confirm() (the publication) — the author never publishes anything that stopped being true. */
	/**
	 * THE GATE (operator order 2026-07-28): the reproducibility checklist, and nothing else.
	 *
	 * Retired with this rewrite: local offline execution, the double-run byte comparison, the
	 * calibrated trade-off axes, the balance threshold and the three-seat blind AI veto panel. What
	 * replaces them is a list of facts read back from Kaggle's public API — every blocking item must
	 * pass. Warnings never block; they are published beside the work so a reader can weigh them.
	 *
	 * The checklist must have been run against the CURRENT Kaggle source. `store()` writes the
	 * kernel's source into `ipynb`, so sig() still binds the whole confirm/ledger/trigger machinery
	 * to exactly what was checked — an author who edits their notebook on Kaggle and re-checks gets
	 * a new sig, which voids any outstanding confirm link. That is the same invariant as before,
	 * reached without touching the digest.
	 */
	private static function gate_reason( $r ) {
		if ( '' === (string) ( $r['kg_slug'] ?? '' ) ) {
			return 'Attach a Kaggle notebook first — paste the link to its output page.';
		}
		$report = Data::dec( $r['checks'] ?? '' );
		if ( ! is_array( $report ) || empty( $report['items'] ) ) {
			return 'Run the reproducibility checklist first.';
		}
		$why = Kernel::blocking_reason( $report );
		if ( '' !== $why ) { return $why; }
		// The checklist is only evidence about the source it was run against.
		$checked = (string) ( $report['facts']['source_sig'] ?? '' );
		if ( '' !== $checked && ! hash_equals( $checked, self::sig( $r['ipynb'] ) ) ) {
			return 'The notebook changed on Kaggle since it was last checked — run the checklist again.';
		}
		return '';
	}

	/** POST studio/notebooks/{id}/publish — the AUTHOR-ONLY gate (operator 2026-07-23): passing
	 *  the blind panel only REQUESTS publication. The draft moves to 'pending' and the AUTHOR
	 *  gets a single-use confirm link at their registered account email; their emailed yes is
	 *  the ONLY thing that publishes and mints the DOI. Callable by session or API token —
	 *  either way the human behind the author's inbox remains the sole publication authority. */
	public static function publish( $req ) {
		self::ensure_tables();
		$uid = Rest::uid();
		$r   = self::row( Rest::pint( $req, 'id' ) );
		if ( ! self::can_edit( $r, $uid ) ) { return Rest::err( 'not_found', 'No such notebook', 404 ); }
		if ( ! in_array( $r['status'], [ 'draft', 'pending', 'published' ], true ) ) { return Rest::err( 'gone', 'Removed', 410 ); }
		$why = self::gate_reason( $r );
		if ( $why !== '' ) { return Rest::err( 'gate', $why, 409 ); }
		// Did THIS request create the pending state? The rollback below is scoped to that, and
		// nothing else — see the note there.
		$made_pending = false;
		if ( $r['status'] === 'draft' ) {
			$won = Data::update( 'aq_notebooks', [ 'status' => 'pending', 'decision_note' => '', 'updated' => Data::now() ],
				[ 'id' => (int) $r['id'], 'status' => 'draft' ] );
			if ( ! $won ) { return Rest::err( 'busy', 'Already submitted', 409 ); }
			$made_pending = true;
		}
		// MIRROR ON REQUEST, not on confirm. The confirm page's whole purpose is that the author
		// reviews the WORKING deliverable — plays the audio, opens the image — before an
		// irreversible act, and it cannot do that from a Kaggle URL that expires in minutes. So the
		// files are fetched here, while nothing is committed yet and a failure costs the author
		// nothing but a retry. They are content-addressed on the CDN and listed nowhere until the
		// work publishes: `Kernel::library` joins on status = 'published'.
		$r = self::row( $r['id'] );
		[ $stored, $mirr ] = Kernel::mirror( $r );
		if ( '' !== $mirr ) {
			// UNDO ONLY WHAT THIS REQUEST DID. A re-request of an ALREADY-pending work must not be
			// demoted on a mirror failure: the author may be holding a live, unspent confirm link for
			// this exact source, and dropping to 'draft' would leave that link dead in their inbox
			// with no explanation, for a Kaggle hiccup that cost nothing. The `author_token = ''`
			// condition says the same thing a second way, against a CONCURRENT request: if another
			// call has already mirrored successfully and emailed a secret while this one was still
			// downloading, the row now holds that secret and this failure must not spend it. Both
			// guards are cheap; the state they protect is a one-way email the author cannot re-open.
			if ( $made_pending ) {
				Data::update( 'aq_notebooks', [ 'status' => 'draft', 'decision_note' => mb_substr( $mirr, 0, 600 ), 'updated' => Data::now() ],
					[ 'id' => (int) $r['id'], 'status' => 'pending', 'author_token' => '' ] );
			}
			return Rest::err( 'mirror', 'Could not fetch your files from Kaggle — ' . $mirr, 409 );
		}
		// A pending work re-sends the author's confirm email (throttled to one per hour per work) —
		// the author's emailed confirmation IS the publication decision; there is no other leg.
		$r    = self::row( $r['id'] );
		$sent = ( (string) $r['status'] === 'pending' ) ? self::author_confirm_email( $r ) : false;
		$out  = self::full( self::row( $r['id'] ), true );
		$out['emailed'] = (bool) $sent;
		return $out;
	}

	// ── The AUTHOR's approval (v4 AIRTIGHT gate, operator 2026-07-23) ────────
	// Publication is requested, never taken — and the sole authority to publish lives in the
	// CONTENT CREATOR's own inbox (their registered account email). No operator email, no
	// support@ leg: the author's emailed confirmation IS the publication decision, and it
	// publishes + mints the permanent DOI directly. History: the first design signed decide
	// links with an HMAC of wp_salt('auth'); that salt is readable by any process on the
	// server, so an AI agent could (and one DID, nb 45) mint its own link and publish. The
	// pattern that replaced it:
	//
	//   · author_confirm_email() mints a SINGLE-USE RANDOM SECRET (random_bytes) at send time.
	//     The raw secret goes into the emailed link and NOWHERE else — not the DB (public!),
	//     not the logs, not a return value. The DB stores only sha256(raw|sig), which cannot
	//     be inverted, so nothing on the server can reconstruct a valid link after the send.
	//   · author_confirm() REQUIRES the raw secret. No secret, no publication — there is no
	//     CLI fallback, no session/API-token substitute, no second path. The hash also binds
	//     the secret to the exact reviewed source (sig), so any edit voids the link. An AI
	//     agent legitimately holding the member's own API token can REQUEST publication;
	//     only the member's inbox can CONFIRM it.
	//   · The secret is single-use: spent atomically with the publish flip (races lose).
	//   · Every confirmation appends an author row to the aq_nb_reviews ledger;
	//     integrity_sweep() DEMOTES any published work that lacks one and alerts the
	//     operator — so even a direct SQL flip of `status` is detected and reverted.
	//
	// GET on the link shows a review page (a mail scanner prefetching it cannot publish);
	// only the explicit POST publishes, and it re-verifies the ENTIRE gate first.
	// (The prod content purge of 2026-07-22 means no published work predates this law —
	// the sweep demands the author's ledger proof for EVERY published row, no exceptions.)

	/** True iff $raw is the secret emailed to the AUTHOR for this row's CURRENT source. */
	private static function confirm_token_ok( $r, $raw ) {
		$stored = (string) ( $r['author_token'] ?? '' );
		if ( $stored === '' || ! is_string( $raw ) || ! preg_match( '/^[0-9a-f]{40}$/', $raw ) ) { return false; }
		return hash_equals( $stored, hash( 'sha256', $raw . '|' . self::sig( $r['ipynb'] ) ) );
	}

	/** The proof the author confirmed THIS exact source by email: the ledger row
	 *  integrity_sweep() audits (model 'author', verdict 'pass', sig-bound). */
	private static function author_confirmed( $r ) {
		return (bool) Data::col(
			'SELECT id FROM ' . Data::t( 'aq_nb_reviews' )
			. " WHERE nb_id = %d AND model = 'author' AND verdict = 'pass' AND sig = %s LIMIT 1",
			[ (int) $r['id'], self::sig( $r['ipynb'] ) ] );
	}

	/** Email the AUTHOR their confirm link — only when the checklist is actually clear, and
	 *  throttled to one email per hour per work. This is THE publication decision's front door. */
	private static function author_confirm_email( $r ) {
		$sig = self::sig( $r['ipynb'] );
		if ( '' !== self::gate_reason( $r ) ) { return false; }
		$report = Data::dec( $r['checks'] ?? '' ) ?: [];
		$au = get_userdata( (int) $r['author_id'] );
		if ( ! $au || ! is_email( (string) $au->user_email ) ) { return false; }
		$key = 'aq_nb_aucnf_' . (int) $r['id'];
		// Throttled to one per hour per work. The CALLER needs to know this happened, so the UI can
		// stop telling a member to check an inbox nothing was sent to.
		if ( get_transient( $key ) ) { return false; }
		set_transient( $key, 1, HOUR_IN_SECONDS );
		// The single-use secret is minted INLINE and the raw goes into the email and NOWHERE
		// else — deliberately not a returning helper, so no reflection call can ever obtain a
		// raw secret. Invoking this whole function only ever emails the registered author,
		// which IS the legitimate request path.
		$raw = bin2hex( random_bytes( 20 ) );
		// A fresh SINGLE-USE nonce per request: the device signs source-sig + this nonce, so a
		// captured assertion cannot be replayed to drive a second publish (the nonce is spent on
		// use). Public (it's the challenge) — its value is unpredictability + one-time use.
		$nonce = bin2hex( random_bytes( 16 ) );
		Data::update( 'aq_notebooks',
			[ 'author_token' => hash( 'sha256', $raw . '|' . $sig ), 'author_nonce' => $nonce ],
			[ 'id' => (int) $r['id'] ] );
		Mailer::send( 'nb_confirm', (string) $au->user_email, [
			'id'           => (int) $r['id'],
			'title'        => mb_substr( (string) $r['title'], 0, 120 ),
			'kind'         => (string) $r['kind'],
			'checks_html'  => self::checks_html( $report ),
			'kernel'       => (string) ( $r['kg_url'] ?? '' ),
			'url'          => add_query_arg( [ 'action' => 'aq_nb_confirm', 'nb' => (int) $r['id'], 'k' => $raw ], admin_url( 'admin-post.php' ) ),
			'draft'        => home_url( '/nb/' . (int) $r['id'] . '/' . (string) $r['slug'] . '/' ),
		] );
		// In-app visibility: the author always sees that a publication email went out — if they
		// never asked for one, something on their account is requesting in their name.
		Notify::push( (int) $r['author_id'], 'artadev',
			'A publication confirm link for "' . $r['title'] . '" was just emailed to your registered address. If you did not request this, do nothing (or open the link and withdraw).',
			'', '/studio/nb/' . (int) $r['id'] . '/', 'nbcnf' . (int) $r['id'] . ':' . (int) ( time() / HOUR_IN_SECONDS ) );
		return true;
	}

	/** The ONE author-confirmation path. $raw is the single-use secret from the AUTHOR's emailed
	 *  link — without it this method refuses, unconditionally. No session, token, CLI or admin
	 *  substitute exists: a confirmation that did not pass through the author's inbox cannot happen. */
	public static function author_confirm( $nb_id, $act, $raw = '', $assertion = [] ) {
		self::ensure_tables();
		$r = self::row( (int) $nb_id );
		if ( ! $r ) { return 'no such notebook'; }
		if ( (string) $r['status'] !== 'pending' ) { return 'not pending (status: ' . $r['status'] . ')'; }
		if ( ! self::confirm_token_ok( $r, $raw ) ) {
			return 'refused: the confirmation secret is missing, spent, or does not match the emailed link for this exact version';
		}
		if ( $act === 'withdraw' ) {
			$won = Data::update( 'aq_notebooks',
				[ 'status' => 'draft', 'author_token' => '', 'author_nonce' => '', 'decision_note' => 'withdrawn by the author before publication', 'updated' => Data::now() ],
				[ 'id' => (int) $r['id'], 'status' => 'pending', 'author_token' => (string) $r['author_token'] ] );
			return $won ? 'withdrawn — the work stays a private draft' : 'lost the race — already handled';
		}
		// THE CRYPTOGRAPHIC KEY (operator 2026-07-24): the author's device must SIGN the exact
		// source being published — the private key never exists on the server, so no one with
		// server or source access can forge it, and the signature goes into the PUBLIC ledger to
		// be re-verified forever. The challenge is source-sig + a SINGLE-USE nonce (anti-replay:
		// a captured assertion cannot drive a second publish). With REQUIRE_PASSKEY, no key = no
		// publish (email-only consent is server-forgeable; only the device signature is not).
		$pk_record = '';
		$enrolled  = Passkey::enrolled( (int) $r['author_id'] );
		if ( self::REQUIRE_PASSKEY && ! $enrolled ) {
			return 'refused: publishing requires a passkey. Add one in Settings → Publication signing key, then open this link again — it is what makes your publication impossible for anyone else (even us) to forge.';
		}
		if ( $enrolled ) {
			$nonce = (string) $r['author_nonce'];
			if ( $nonce === '' ) {
				return 'refused: no active signing challenge for this request — request publication again for a fresh signed link.';
			}
			$pk_record = Passkey::verify_assertion(
				(int) $r['author_id'],
				self::sig( $r['ipynb'] ) . ':' . $nonce, // challenge = source sig + single-use nonce
				(string) ( $assertion['cred'] ?? '' ),
				(string) ( $assertion['cdj'] ?? '' ),
				(string) ( $assertion['auth'] ?? '' ),
				(string) ( $assertion['sig'] ?? '' )
			);
			if ( $pk_record === '' ) {
				return 'refused: your passkey signature is required and did not verify — publish from the emailed link on a device that holds your passkey';
			}
		}
		if ( $act !== 'confirm' ) { return 'unknown action'; }
		// Confirmation re-verifies the whole gate — the author never vouches for a stale pass.
		$why = self::gate_reason( $r );
		if ( $why !== '' ) { return 'gate no longer holds: ' . $why; }
		$sig = self::sig( $r['ipynb'] );
		$now = Data::now();
		// Step 0 — TAKE OUR OWN COPY of every chosen file, before anything is spent or flipped.
		// A Kaggle kernel is owner-editable and owner-deletable and its output URLs are signed and
		// short-lived, so a published work that merely points at Kaggle would rot the moment its
		// author touched it. Mirroring first also means a mirror failure costs the author nothing:
		// the single-use secret is still unspent and the link still works. The mirror is
		// content-addressed and idempotent, so a retry is free.
		[ $stored, $mirr ] = Kernel::mirror( $r );
		if ( '' !== $mirr ) { return 'could not publish — ' . $mirr . '. Nothing was spent; the link still works, so fix it on Kaggle and try again'; }
		if ( $stored < 1 ) { return 'could not publish — no files were stored'; }
		// Step 1 — win the race by SPENDING the secret AND the nonce (status untouched): a
		// concurrent second click loses cleanly here, and the single-use nonce cannot sign twice.
		$won = Data::update( 'aq_notebooks', [ 'author_token' => '', 'author_nonce' => '', 'updated' => $now ],
			[ 'id' => (int) $r['id'], 'status' => 'pending', 'author_token' => (string) $r['author_token'] ] );
		if ( ! $won ) { return 'lost the race — already confirmed'; }
		// Step 2 — the ledger proof FIRST (the author confirmed THIS exact source): the database
		// publish-guard trigger refuses any transition to 'published' that is not preceded by
		// this row, so the proof must exist before the flip — for everyone, including us.
		Data::insert( 'aq_nb_reviews', [
			'nb_id'   => (int) $r['id'],
			'run_id'  => 0,
			'iter'    => 98, // the author's seat
			'score'   => 0,
			'verdict' => 'pass',
			'scores'  => '',
			'report'  => 'AUTHOR CONFIRMATION via the emailed single-use link (token hash ' . (string) $r['author_token'] . ')'
				. ( $pk_record !== '' ? ' + DEVICE SIGNATURE over the exact source [' . $pk_record . ']' : '' ) . ' — published',
			'model'   => 'author',
			'sig'     => $sig,
			'created' => $now,
		] );
		// Step 3 — the flip (the DB trigger independently re-checks the ledger proof). approve_sig
		// records the SOURCE the author signed off; req_sig records the ENVIRONMENT it was signed off
		// in, because the confirm page showed them a deliverable produced by these exact pins. From
		// here the pair is what integrity_sweep() holds the published row to, forever.
		$flip = Data::update( 'aq_notebooks', [
			'status' => 'published', 'published_at' => $now, 'approved_at' => $now, 'approve_sig' => $sig,
			'req_sig' => self::req_sig( $r['requirements'] ?? '' ),
			'season' => self::season_key(), 'decision_note' => '', 'updated' => $now,
		], [ 'id' => (int) $r['id'], 'status' => 'pending' ] );
		if ( ! $flip ) { return 'could not publish — the database publish-guard refused the transition; run the work again and retry'; }
		Economy::content_points( (int) $r['author_id'], self::pub_fee( $r['size_bytes'] ), 'nb:' . $r['id'] );
		if ( ! Data::col( 'SELECT id FROM ' . Data::t( 'aq_posts' ) . ' WHERE nb_id = %d LIMIT 1', [ (int) $r['id'] ] ) ) {
			Data::insert( 'aq_posts', [ 'author_id' => (int) $r['author_id'], 'body' => mb_substr( (string) $r['abstract'], 0, 280 ), 'nb_id' => (int) $r['id'], 'created' => $now ] );
		}
		// The DOI — permanent, minted ONLY here, after the author's emailed yes (idempotent: a
		// retained DOI from an earlier version is reused, never re-minted). The kernel is the
		// provenance; the DOI is the citation of record, precisely because the kernel is mutable
		// and the DOI is not.
		$r = self::row( $r['id'] );
		if ( $r['doi'] === '' ) {
			$minted = self::mint_doi( $r );
			if ( $minted ) {
				Data::update( 'aq_notebooks', [ 'doi' => $minted['doi'], 'record_url' => $minted['record_url'] ], [ 'id' => (int) $r['id'] ] );
			}
		}
		// The author's own kernel IS the runnable copy now. Pushing a second copy to the platform's
		// Kaggle account (as the retired pipeline did) would fork the work from the thing every
		// checklist item was actually read from, so `kaggle_url` simply records the source.
		if ( (string) ( $r['kaggle_url'] ?? '' ) !== (string) ( $r['kg_url'] ?? '' ) ) {
			Data::update( 'aq_notebooks', [ 'kaggle_url' => (string) ( $r['kg_url'] ?? '' ) ], [ 'id' => (int) $r['id'] ] );
		}
		$r = self::row( $r['id'] );
		Notify::push( (int) $r['author_id'], 'artadev',
			'"' . $r['title'] . '" is published' . ( $r['doi'] !== '' ? ' — DOI ' . Doi::nb_link( $r['id'] ) : '' ),
			'', '/nb/' . (int) $r['id'] . '/' . (string) $r['slug'] . '/', 'nbpub' . (int) $r['id'] );
		return 'published' . ( $r['doi'] !== '' ? ' — the permanent DOI is minted' : ' — the DOI mint is retrying (it completes automatically)' );
	}

	/** Re-verify a ledgered device signature from PUBLIC data (the sweep's cryptographic leg —
	 *  the same check any outside auditor can run against the public DB). Key rows are looked up
	 *  by id regardless of later revocation: revoking a key forward-stops it, it does not
	 *  invalidate the history it validly signed. */
	private static function passkey_record_ok( $key_id, $author_id, $challenge, $auth_b64u, $cdj_b64u, $sig_b64u ) {
		// Key MUST belong to the notebook's AUTHOR (credential-substitution guard): a signature
		// from anyone else's enrolled key — even a valid one — is not the author's consent.
		$key = Data::one( 'SELECT * FROM ' . Data::t( 'aq_passkeys' ) . ' WHERE id = %d AND user_id = %d',
			[ (int) $key_id, (int) $author_id ] );
		if ( ! $key ) { return false; }
		$cdj = Passkey::b64u_dec( $cdj_b64u );
		$cd  = json_decode( $cdj, true );
		if ( ! is_array( $cd ) || ( $cd['type'] ?? '' ) !== 'webauthn.get' || ( $cd['challenge'] ?? '' ) !== Passkey::b64u_enc( $challenge ) ) { return false; }
		$auth = Passkey::b64u_dec( $auth_b64u );
		// rpIdHash must be this site (same check verify_assertion enforces at sign time).
		if ( strlen( $auth ) < 37 || ! hash_equals( hash( 'sha256', (string) wp_parse_url( home_url(), PHP_URL_HOST ), true ), substr( $auth, 0, 32 ) ) ) { return false; }
		return 1 === openssl_verify( $auth . hash( 'sha256', $cdj, true ), Passkey::b64u_dec( $sig_b64u ), (string) $key['pubkey_pem'], OPENSSL_ALGO_SHA256 );
	}

	/** admin-post.php endpoint (action aq_nb_confirm, nopriv — the emailed single-use secret IS
	 *  the authority; it only ever reaches the author's inbox). GET = review page (changes
	 *  nothing — mail scanners prefetch GETs), POST = confirm or withdraw. */
	public static function confirm_http() {
		self::ensure_tables();
		$nb  = isset( $_REQUEST['nb'] ) ? (int) $_REQUEST['nb'] : 0;
		$raw = isset( $_REQUEST['k'] ) ? (string) $_REQUEST['k'] : '';
		$r   = $nb ? self::row( $nb ) : null;
		if ( ! $r ) { self::decide_page( 'Not found', 'No such notebook.' ); }
		if ( ! self::confirm_token_ok( $r, $raw ) ) {
			self::decide_page( 'Link expired', 'This confirm link has been spent, superseded by a newer request, or the work was edited since it was sent. Requesting publication again sends a fresh link.' );
		}
		if ( (string) $r['status'] !== 'pending' ) {
			self::decide_page( 'Nothing to confirm', 'Status is "' . $r['status'] . '" — no publication request awaits your confirmation.' );
		}
		if ( 'POST' === strtoupper( (string) ( $_SERVER['REQUEST_METHOD'] ?? 'GET' ) ) ) {
			$act    = ( $_POST['act'] ?? '' ) === 'confirm' ? 'confirm' : 'withdraw';
			$result = self::author_confirm( $nb, $act, $raw, [
				'cred' => sanitize_text_field( (string) ( $_POST['pk_cred'] ?? '' ) ),
				'cdj'  => sanitize_text_field( (string) ( $_POST['pk_cdj'] ?? '' ) ),
				'auth' => sanitize_text_field( (string) ( $_POST['pk_auth'] ?? '' ) ),
				'sig'  => sanitize_text_field( (string) ( $_POST['pk_sig'] ?? '' ) ),
			] );
			self::decide_page( $act === 'confirm' ? 'Confirmed' : 'Withdrawn', esc_html( $result ) );
		}
		// GET — show the author exactly what confirming means, then let the POST decide.
		$sig     = self::sig( $r['ipynb'] );
		$sliders = self::checks_html( Data::dec( $r['checks'] ?? '' ) ?: [], true );
		$post    = esc_url( add_query_arg( [ 'action' => 'aq_nb_confirm', 'nb' => (int) $nb, 'k' => $raw ], admin_url( 'admin-post.php' ) ) );
		$draft   = esc_url( home_url( '/nb/' . (int) $nb . '/' . (string) $r['slug'] . '/' ) );
		$book    = esc_url( home_url( '/nb/' . (int) $nb . '/' . (string) $r['slug'] . '/book' ) );
		// THE AUTHOR REVIEWS THE ACTUAL FILES, not a description of them. They were mirrored to our
		// CDN when publication was requested (Notebook::publish), precisely so this page can play the
		// audio and show the image — a Kaggle output URL expires in minutes and could not.
		$preview = '';
		foreach ( Data::all( 'SELECT * FROM ' . Data::t( 'aq_library' ) . ' WHERE nb_id = %d ORDER BY id', [ (int) $nb ] ) as $f ) {
			$url = Media::url( (string) $f['cdn_key'] );
			$cls = (string) $f['class'];
			if ( 'scene' === $cls || 'image' === $cls ) {
				// A scene is drawn here too, and through the SAME <img> as any other picture — which
				// is the whole security argument, not a shortcut: an <img>-embedded SVG has scripting
				// disabled by the spec, so even in an email client's browser the drawing cannot run
				// anything. It has to be shown: this page exists so the author reviews the ACTUAL
				// bytes being published, and for a vector work the scene IS those bytes. Falling
				// through to a text link would have shown them the raster twin instead — a different
				// file from the one their signature covers.
				$preview .= '<img src="' . esc_url( $url ) . '" alt="' . esc_attr( (string) $f['label'] ) . '" style="max-width:100%;border-radius:.6rem;margin:.4rem 0">';
			} elseif ( 'audio' === $cls ) {
				// The author must HEAR the master before publishing it — a link they might not click is
				// not review. Plays in place; nothing downloads until they press play.
				$preview .= '<audio controls preload="metadata" src="' . esc_url( $url ) . '" style="width:100%;margin:.4rem 0"></audio>';
			} elseif ( 'video' === $cls ) {
				$preview .= '<video controls preload="metadata" playsinline src="' . esc_url( $url ) . '" style="max-width:100%;border-radius:.6rem;margin:.4rem 0"></video>';
			} elseif ( 'doc' === $cls && 'html' === Kernel::ext( (string) $f['name'] ) ) {
				$preview .= '<iframe src="' . esc_url( $url ) . '" title="' . esc_attr( (string) $f['label'] ) . '" '
					. 'style="width:100%;height:24rem;border:1px solid #24425f;border-radius:.6rem;background:#06121E;margin:.4rem 0" '
					. 'sandbox="allow-scripts allow-pointer-lock"></iframe>';
			}
			$preview .= '<div style="margin:.2rem 0 .6rem;font-size:.85rem"><a href="' . esc_url( $url ) . '" target="_blank" rel="noopener" style="color:#1746DC;text-decoration:none">'
				. esc_html( (string) $f['label'] ) . '</a> <span style="color:#8fa3b8">' . esc_html( size_format( (int) $f['bytes'] ) ) . '</span></div>';
		}
		if ( '' !== (string) ( $r['kg_url'] ?? '' ) ) {
			$preview .= '<div style="margin:.3rem 0 .8rem;font-size:.85rem"><a href="' . esc_url( (string) $r['kg_url'] ) . '" target="_blank" rel="noopener" style="color:#1746DC;text-decoration:none">Open the notebook on Kaggle &#8599;</a></div>';
		}
		// Enrolled authors co-sign with their DEVICE: the Publish button runs the WebAuthn
		// ceremony with the work's source sig as the challenge, so the passkey literally signs
		// the exact bytes being published. No non-ASCII glyphs in this inline JS (feedback rule).
		$enrolled = Passkey::enrolled( (int) $r['author_id'] );
		$creds    = $enrolled ? Passkey::cred_ids( (int) $r['author_id'] ) : [];
		$need_key = self::REQUIRE_PASSKEY && ! $enrolled;
		$pk_js    = '';
		if ( $enrolled ) {
			$pk_js = '<script>(function(){'
				. 'var CREDS=' . wp_json_encode( array_values( $creds ) ) . ',CH=' . wp_json_encode( $sig . ':' . (string) $r['author_nonce'] ) . ';'
				. 'function b2u(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";var b=atob(s),a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a.buffer;}'
				. 'function u2b(b){var a=new Uint8Array(b),s="";for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}'
				. 'var f=document.getElementById("aq-confirm-form");'
				. 'f.addEventListener("submit",function(ev){'
				. 'if(f.dataset.signed==="1"||(ev.submitter&&ev.submitter.value==="withdraw"))return;'
				. 'ev.preventDefault();var st=document.getElementById("aq-pk-status");st.textContent="Waiting for your passkey...";'
				. 'navigator.credentials.get({publicKey:{challenge:new TextEncoder().encode(CH),timeout:120000,userVerification:"required",allowCredentials:CREDS.map(function(c){return{type:"public-key",id:b2u(c)};})}})'
				. '.then(function(c){var r=c.response;'
				. 'document.getElementById("pk_cred").value=u2b(c.rawId);'
				. 'document.getElementById("pk_cdj").value=u2b(r.clientDataJSON);'
				. 'document.getElementById("pk_auth").value=u2b(r.authenticatorData);'
				. 'document.getElementById("pk_sig").value=u2b(r.signature);'
				. 'f.dataset.signed="1";var b=document.getElementById("aq-pub-btn");b.value="confirm";'
				. 'var h=document.createElement("input");h.type="hidden";h.name="act";h.value="confirm";f.appendChild(h);f.submit();})'
				. '.catch(function(e){st.textContent="Passkey signing failed or was cancelled - publishing needs your device signature. ("+e+")";});'
				. '});})();</script>';
		}
		self::decide_page(
			'Publish this work?',
			'<span style="color:#E8B923">' . esc_html( $r['title'] ) . '</span><br>'
			. 'Your work cleared every reproducibility check. Confirming publishes it NOW: it is listed publicly, its files enter the Library for any member to post with, and its <b>permanent DOI</b> mints — a DOI is forever, so look it over first (the checklist below, the working deliverable, the full draft). If you did not request this, withdraw: nothing publishes without you.'
			. ( $enrolled ? '<br><span style="font-size:.85rem;color:#8fa3b8">Publishing will ask your passkey to sign this exact version — approve with your fingerprint or face. On a computer you can use your phone: the browser shows a QR to scan (or just open this email link on the phone that holds your passkey). The signature becomes part of the public record.</span>' : '' )
			. ( $need_key ? '<div style="margin:.8rem 0;padding:.7rem .9rem;border:1px solid #54471d;border-radius:.5rem;background:#1a1710;color:#e8d9a8;font-size:.9rem">To publish, first add a <b>passkey</b> in Settings → Publication signing key. That device signature is what makes your publication impossible for anyone else — even us — to forge. Add one, then open this link again.</div>' : '' )
			. $sliders
			. $preview
			. '<div style="margin:.2rem 0 .6rem;font-size:.9rem"><a href="' . $draft . '" target="_blank" rel="noopener" style="color:#1746DC;text-decoration:none">Read the full draft ↗</a></div>'
			. '<div style="margin:.2rem 0 .6rem;font-size:.9rem"><a href="' . $book . '" target="_blank" rel="noopener" style="color:#1746DC;text-decoration:none">Read it as a book &#8599;</a></div>'
			. '<form method="post" action="' . $post . '" style="margin-top:1rem" id="aq-confirm-form">'
			. '<input type="hidden" name="pk_cred" id="pk_cred"><input type="hidden" name="pk_cdj" id="pk_cdj">'
			. '<input type="hidden" name="pk_auth" id="pk_auth"><input type="hidden" name="pk_sig" id="pk_sig">'
			. ( $need_key
				? '<a href="' . esc_url( home_url( '/user-account/' ) ) . '" style="display:inline-block;padding:.6rem 1.4rem;border-radius:.5rem;background:#E8B923;color:#010C17;font-weight:700;text-decoration:none">Add a passkey to publish</a> '
				: '<button name="act" value="confirm" id="aq-pub-btn" style="padding:.6rem 1.4rem;border-radius:.5rem;border:0;background:#E8B923;color:#010C17;font-weight:700;cursor:pointer">Publish — mint the permanent DOI</button> ' )
			. '<button name="act" value="withdraw" style="padding:.6rem 1.4rem;border-radius:.5rem;border:1px solid #24425f;background:transparent;color:#cdd7e3;cursor:pointer">Withdraw</button>'
			. '<div id="aq-pk-status" style="margin-top:.5rem;font-size:.85rem;color:#8fa3b8"></div>'
			. '</form>'
			. $pk_js,
			true
		);
	}

	/**
	 * The checklist receipt as email-safe HTML (also used by the confirm page).
	 *
	 * The author is about to make an irreversible decision, so the mail restates exactly what was
	 * checked and what was merely warned about — passes collapsed to a count, every warning spelled
	 * out. Table-free, inline-styled, because this has to survive an email client.
	 */
	private static function checks_html( $report, $dark = false ) {
		$items = (array) ( $report['items'] ?? [] );
		if ( ! $items ) { return ''; }
		$muted = $dark ? '#8fa3b8' : '#6b7a8c';
		$ink   = $dark ? '#e6eef7' : '#0c1e32';
		$pass  = 0;
		$warn  = [];
		foreach ( $items as $i ) {
			if ( 'pass' === ( $i['state'] ?? '' ) ) { $pass++; continue; }
			$warn[] = $i;
		}
		$out = '<div style="max-width:460px;margin:6px auto 8px;text-align:left;font-size:13px;color:' . $ink . '">'
			. '<div style="font-weight:600;margin-bottom:6px">' . (int) $pass . ' reproducibility checks passed</div>';
		foreach ( $warn as $i ) {
			$out .= '<div style="margin:4px 0;padding:6px 8px;border-left:3px solid #E8B923">'
				. '<strong>' . esc_html( (string) ( $i['title'] ?? '' ) ) . '</strong><br>'
				. '<span style="color:' . $muted . '">' . esc_html( (string) ( $i['detail'] ?? '' ) ) . '</span></div>';
		}
		$out .= '<div style="font-size:11px;color:' . $muted . ';margin-top:6px">'
			. 'Every check is read back from the public Kaggle API and published with the work.</div></div>';
		return $out;
	}

	/** How long a publication REQUEST may sit half-finished before sweep_stranded_pending() rescues
	 *  it. Comfortably longer than any request can live (a gateway kills one long before this) and
	 *  short enough that an author who hit a 504 is not shut out of their own work for the day. */
	const PENDING_STRANDED = 1800; // 30 minutes

	/**
	 * Put back a publication request that never finished.
	 *
	 * publish() flips draft → pending BEFORE it mirrors the chosen files, and the mirror is the slow,
	 * network-bound half. Its rollback runs only if PHP is still alive to run it: a gateway 504 or an
	 * out-of-memory inside Kernel::mirror takes the process with it, and the row is left saying
	 * 'pending' with no confirm email ever sent. The same shape exists at the other end —
	 * author_confirm() spends the single-use secret a few statements before it flips to 'published',
	 * so a process that dies between those two writes leaves a pending row whose emailed link is
	 * already dead.
	 *
	 * NOT A DEAD END, AND WORTH SAYING SO PLAINLY: the Studio's pending card offers "Send the link
	 * again", which re-runs publish() and recovers the row the moment the mirror succeeds. What that
	 * button cannot do is make the state honest in the meantime — the card tells the author a link is
	 * in their inbox when nothing was sent, the public DB shows a request outstanding when there is
	 * none, and an author who does not come back to that page is never told anything at all. This
	 * sweep is the backstop for those three, not a substitute for the button.
	 *
	 * THE SIGNAL IS AN EMPTY author_token ON A PENDING ROW. The token is minted with the confirm
	 * email and is the ONLY thing that can publish, so a pending row without one has nothing
	 * outstanding in anybody's inbox: returning it to draft throws away no live secret and no
	 * decision. The age test covers the one honest moment where both are briefly true — author_confirm()
	 * spends the secret a few statements before it flips to 'published', and that write refreshes
	 * `updated`, leaving an in-flight confirmation half an hour clear of this cut-off.
	 *
	 * THIS ONLY EVER MOVES A ROW BACKWARDS, to draft. It cannot publish anything and it touches no
	 * part of the gate; the author still requests publication and still confirms it from their inbox.
	 * Rides the feed on the same lazy trigger as integrity_sweep(), so it needs no cron registration.
	 */
	public static function sweep_stranded_pending() {
		$rows = Data::all(
			'SELECT id, author_id, title, slug FROM ' . Data::t( 'aq_notebooks' )
			. " WHERE status = 'pending' AND author_token = '' AND updated < %d ORDER BY id LIMIT 50",
			[ Data::now() - self::PENDING_STRANDED ] );
		$out = [];
		foreach ( (array) $rows as $b ) {
			// Conditional on the same two facts we selected on, so a confirmation that lands in the
			// gap between the read and this write wins and is left alone. One winner per rescue, which
			// is also why the notice below needs no dedupe ref.
			$won = Data::update( 'aq_notebooks', [
				'status'        => 'draft',
				'decision_note' => 'the publication request did not finish, so this is a draft again — nothing was emailed and nothing was published',
				'updated'       => Data::now(),
			], [ 'id' => (int) $b['id'], 'status' => 'pending', 'author_token' => '' ] );
			if ( ! $won ) { continue; }
			// Release the once-an-hour confirm-email throttle for the reason Kernel::void_pending
			// releases it: it exists to stop a flood of emails, not to punish a request the platform
			// itself dropped — without this the author's retry is refused its email for the rest of
			// the hour, which is the same lock-out in a different costume.
			delete_transient( 'aq_nb_aucnf_' . (int) $b['id'] );
			// A silent rescue is half a rescue: the author is looking at "check your inbox" for an
			// email that was never sent, and only they can start the request again.
			Notify::push( (int) $b['author_id'], 'artadev',
				'Your publication request for "' . mb_substr( (string) $b['title'], 0, 80 ) . '" did not finish',
				'Nothing was published and nothing was emailed. It is a draft again — open it and request publication when you are ready.',
				'/nb/' . (int) $b['id'] . '/' . (string) $b['slug'] . '/' );
			$out[] = (int) $b['id'];
			error_log( 'AQ sweep_stranded_pending: returned nb ' . (int) $b['id'] . ' to draft (request never finished)' );
		}
		return $out;
	}

	/** The watchdog: every published work must carry the author's sig-bound confirmation in the
	 *  ledger (and, for an enrolled author, their device signature). Anything else — a direct SQL
	 *  flip, a forged status, a confirmation for a different version — is demoted on sight. */
	public static function integrity_sweep() {
		global $wpdb;
		Passkey::ensure_table(); // the enrolled-at-publish check below reads aq_passkeys — guarantee it exists
		$nbs = Data::t( 'aq_notebooks' );
		$rev = Data::t( 'aq_nb_reviews' );
		// Sig comparison happens in PHP (sha1), never SQL — SQLite (local dev) has no SHA1()
		// and a silently erroring query would turn the watchdog into a no-op, which is exactly
		// the failure mode this function exists to prevent. Published rows are few; this is cheap.
		$pub = $wpdb->get_results( "SELECT id, title, ipynb, requirements, req_sig, author_id, published_at FROM {$nbs} WHERE status = 'published'", ARRAY_A ) ?: [];
		$bad  = [];   // [ row, the reason it is being reverted ]
		$nokey = 'published without the author\'s verified email confirmation';
		foreach ( $pub as $b ) {
			$sig = self::sig( $b['ipynb'] );
			// THE ENVIRONMENT, first: a source edit moves sig() and is caught by the ledger lookup
			// below, but the requirements file is in no such hash — an author who saves new pins on a
			// DOI'd work would otherwise serve a measured, panel-passed, signed record of an
			// environment that no longer exists. req_sig is what the author's confirmation certified;
			// if the file no longer hashes to it, nobody ever approved what is being served.
			// A blank stored value means the row was published before the environment was signed:
			// read it as the base environment (sha1 of no pins), which is what every such work
			// declares — so nothing already live is demoted for a column that did not exist yet.
			$was = (string) ( $b['req_sig'] ?? '' ) !== '' ? (string) $b['req_sig'] : sha1( '' );
			if ( ! hash_equals( $was, self::req_sig( $b['requirements'] ?? '' ) ) ) {
				$bad[] = [ $b, 'the requirements file changed after publication — the approved environment is not the one being served' ];
				continue;
			}
			$row = $wpdb->get_row( $wpdb->prepare(
				"SELECT id, report FROM {$rev} WHERE nb_id = %d AND model = 'author' AND verdict = 'pass' AND sig = %s ORDER BY id DESC LIMIT 1",
				(int) $b['id'], $sig ), ARRAY_A );
			if ( ! $row ) { $bad[] = [ $b, $nokey ]; continue; }
			// The cryptographic check: if the ledger record carries a device signature, RE-VERIFY
			// it (public data, public key — anyone can run this same check); if it carries none
			// but the author held an active passkey at publish time, the record is incomplete —
			// a signature was required and is missing. Either failure demotes.
			$rep = (string) $row['report'];
			if ( preg_match( '/passkey:(\d+) cred:(\S+) challenge:(\S+) authData:(\S+) clientDataJSON:(\S+) sig:(\S+)/', $rep, $m ) ) {
				// The ledgered challenge must be THIS source's sig plus a nonce (prefix, not
				// equality), the key must be the AUTHOR's, and the signature must re-verify.
				$chal = $m[3];
				if ( strpos( $chal, $sig . ':' ) !== 0 || ! self::passkey_record_ok( (int) $m[1], (int) $b['author_id'], $chal, $m[4], $m[5], $m[6] ) ) { $bad[] = [ $b, $nokey ]; continue; }
				// Anti-replay: the single-use nonce must not appear in ANY other author-pass row
				// (a captured assertion re-inserted for a second publish reuses its nonce).
				$reuse = (int) $wpdb->get_var( $wpdb->prepare(
					"SELECT COUNT(*) FROM {$rev} WHERE model = 'author' AND verdict = 'pass' AND id <> %d AND report LIKE %s",
					(int) $row['id'], '%challenge:' . $wpdb->esc_like( $chal ) . ' %' ) );
				if ( $reuse > 0 ) { $bad[] = [ $b, $nokey ]; continue; }
			} else {
				// Signature-less published row. With REQUIRE_PASSKEY every legit publish carries a
				// signature, so this is a forge; even otherwise, if the author has EVER enrolled a
				// key (created on/before publish, regardless of a LATER revoke — a silent revoke
				// must not open a bypass) a signature was required and is missing → demote.
				$must_sign = self::REQUIRE_PASSKEY || (int) $wpdb->get_var( $wpdb->prepare(
					'SELECT COUNT(*) FROM ' . Data::t( 'aq_passkeys' ) . ' WHERE user_id = %d AND created <= %d',
					(int) $b['author_id'], (int) $b['published_at'] ) );
				if ( $must_sign ) { $bad[] = [ $b, $nokey ]; continue; }
			}
		}
		$out = [];
		foreach ( $bad as [ $b, $why ] ) {
			Data::update( 'aq_notebooks',
				[ 'status' => 'draft', 'decision_note' => 'integrity: ' . $why . ' — reverted', 'updated' => Data::now() ],
				[ 'id' => (int) $b['id'], 'status' => 'published' ] );
			$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . Data::t( 'aq_posts' ) . ' WHERE nb_id = %d', (int) $b['id'] ) );
			$out[] = (int) $b['id'];
			error_log( 'AQ integrity_sweep: demoted nb ' . (int) $b['id'] . ' (' . $why . ')' );
		}
		if ( $out && ! get_transient( 'aq_nb_integrity_alert' ) ) {
			set_transient( 'aq_nb_integrity_alert', 1, HOUR_IN_SECONDS );
			Mailer::send( 'nb_integrity', self::ADMIN_EMAIL, [
				'ids' => implode( ', ', $out ),
			] );
		}
		return $out;
	}


	/** Tiny branded page for the decide flow (the Tickets::approve_page pattern), then exit. */
	private static function decide_page( $heading, $detail_html, $raw = false ) {
		status_header( 200 );
		nocache_headers();
		header( 'Content-Type: text/html; charset=utf-8' );
		$h = esc_html( $heading );
		$d = $raw ? $detail_html : esc_html( $detail_html );
		echo '<!doctype html><html lang="en"><head><meta charset="utf-8">'
			. '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>ArtaQuest</title></head>'
			. '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
			. 'background:#010C17;color:#fff;font:16px/1.6 -apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif">'
			. '<div style="max-width:34rem;padding:2rem;text-align:center">'
			. '<div style="font-size:1.5rem;font-weight:700;color:#E8B923;margin-bottom:.6rem">' . $h . '</div>'
			. '<div style="color:#cdd7e3">' . $d . '</div>'
			. '</div></body></html>';
		exit;
	}

	/** wp-cli helper: retry a failed DOI/gist mint on an already-approved published work. */
	public static function admin_retry_mint( $nb_id ) {
		$r = self::row( (int) $nb_id );
		if ( ! $r || $r['status'] !== 'published' ) { return 'not published'; }
		// A mint retry is only valid for a work the AUTHOR verifiably published — otherwise a
		// forged status flip could reach the minting path in the demote window before the sweep.
		if ( ! self::author_confirmed( $r ) ) { return 'refused: no verified author confirmation for this exact source'; }
		if ( $r['doi'] === '' ) {
			$minted = self::mint_doi( $r );
			if ( $minted ) { Data::update( 'aq_notebooks', [ 'doi' => $minted['doi'], 'record_url' => $minted['record_url'] ], [ 'id' => (int) $r['id'] ] ); }
		}
		if ( (string) ( $r['kaggle_url'] ?? '' ) === '' ) {
			$kag = Kaggle::push( $r, self::kaggle_data_sources( $r ) );
			if ( $kag !== '' ) { Data::update( 'aq_notebooks', [ 'kaggle_url' => $kag ], [ 'id' => (int) $r['id'] ] ); }
		}
		$r = self::row( $r['id'] );
		return 'doi=' . ( $r['doi'] ?: 'none' ) . ' kaggle=' . ( $r['kaggle_url'] ?: 'none' );
	}

	/** POST studio/notebooks/{id}/delete — drafts vanish for good; published works are only unlisted (their DOI lives on). */
	public static function remove( $req ) {
		self::ensure_tables();
		$uid = Rest::uid();
		$r   = self::row( Rest::pint( $req, 'id' ) );
		if ( ! self::can_edit( $r, $uid ) ) { return Rest::err( 'not_found', 'No such notebook', 404 ); }
		Data::update( 'aq_notebooks', [ 'status' => 'removed', 'updated' => Data::now() ], [ 'id' => (int) $r['id'] ] );
		// Take its Library listings down with it. Mirroring happens at publish REQUEST, so a work
		// that is removed before (or after) approval had already put rows on the shared shelf; the
		// listing endpoint hides them by joining on a PUBLISHED work, but the rows accumulate
		// forever — prod carried eight belonging to four removed works. Rows already attached to
		// someone's post are kept by prune, deliberately.
		Kernel::unlist( $r );
		return [ 'ok' => true ];
	}

	// ── Relay (worker auth) — REMOVED with the local-execution pipeline (2026-07-28) ──────
	// relay/nb/{poll,beat,review,update,complete,release} and their claim/fence helpers ran the
	// offline executor and the blind AI review panel. The Kaggle reset replaced all of it: the run
	// happens on Kaggle, and Kernel.php reads the result back. Nothing enqueues an aq_nb_runs row
	// any more, no client in this tree ever called these paths — and relay/nb/update wrote `ipynb`
	// on ANY row with no published-status guard, the one write the publish gate cannot survive:
	// sig(ipynb) is what the author's confirmation ledger row, the DB publish-guard and
	// integrity_sweep() are all keyed on, so a single call would have silently voided a published
	// work's proof of authorship. A retired route that can do that is not left registered.

	/** The 5-stop Motion-calm thresholds, DERIVED from the platform's own measured distribution
	 *  (operator 2026-07-17): stop k flags the fraction [90%, 70%, 50%, 25%, 0%] of measured
	 *  video works with the lowest calm — so "Standard" (stop 3) always flags HALF of the
	 *  existing video content, however the catalogue evolves. A flagged video never autoplays.
	 *  Returns 5 calm cutoffs (flag when calm < cutoff); all zeros while nothing is measured. */
	public static function calm_thresholds() {
		$cached = get_transient( 'aq_calm_thresholds' );
		if ( is_array( $cached ) && count( $cached ) === 5 ) { return $cached; }
		global $wpdb;
		$vals = array_map( 'intval', $wpdb->get_col(
			'SELECT calm FROM ' . Data::t( 'aq_notebooks' ) . " WHERE status = 'published' AND calm_measured = 1 ORDER BY calm ASC" ) );
		$out = [];
		foreach ( [ 0.90, 0.70, 0.50, 0.25, 0.0 ] as $frac ) {
			if ( ! $vals || $frac <= 0 ) { $out[] = 0; continue; }
			$idx   = (int) ceil( $frac * count( $vals ) ) - 1;
			$out[] = $vals[ max( 0, min( count( $vals ) - 1, $idx ) ) ] + 1; // flag calm < cutoff ⇒ ≈frac flagged
		}
		set_transient( 'aq_calm_thresholds', $out, 300 );
		return $out;
	}

	/** GET notebooks/pulse — feed liveness for the SPA strip. */
	public static function pulse() {
		self::ensure_tables();
		global $wpdb;
		$runs = Data::t( 'aq_nb_runs' );
		$nbs  = Data::t( 'aq_notebooks' );
		$by   = [];
		foreach ( $wpdb->get_results( "SELECT kind, COUNT(*) c FROM {$nbs} WHERE status = 'published' GROUP BY kind", ARRAY_A ) ?: [] as $r ) {
			$by[ $r['kind'] ] = (int) $r['c'];
		}
		return [
			'online'    => (bool) get_transient( 'aq_nb_beat' ),
			'queued'    => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$runs} WHERE state IN ('queued','claimed')" ),
			'published' => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$nbs} WHERE status = 'published'" ),
			'kinds'     => $by,
			'model'     => 'claude-opus-5', // ArtaCritic — latest Opus, fleet-wide (operator 2026-07-20); mirrors the relay's CRITIC_MODEL
			'pass'      => self::PASS_SCORE, // minimum BALANCE (100 = perfectly centred)
			'safe'      => [ self::SAFE_LO, self::SAFE_HI ], // the middle-20 safe zone (v3 trade-off gate)
			'panel'     => self::PANEL_SIZE, // independent double-blind reviewers per run (v2, 2026-07-22)
			// `approval => 'admin'` used to be published here. There is no operator leg and there has
			// not been one since 2026-07-23: publication is REQUESTED, and the single-use secret
			// emailed to the author's own address, plus their device passkey signature, is the only
			// thing that publishes a work or mints its DOI. A public endpoint saying an admin
			// approves publications describes a gate that does not exist, so it is gone rather than
			// re-worded. Same for the fee line, which advertised the retired blind review panel.
			'fee'       => 'free — every submission runs the reproducibility checklist against Kaggle',
			'calm_thresholds' => self::calm_thresholds(), // stop k flags calm < value; Standard flags half
		];
	}

	// ── Challenges (MEMBER-CREATED, 2026-07-14 pivot) ───────────────────────
	// A challenge is a member's challenge: they pick the category + a sitewide topic + a FULL-MOON
	// deadline, set the entry fee, and open it with their OWN notebook (paying the fee like everyone
	// else). Every entrant pays the fee into the pool; at the deadline the most-hearted entry takes
	// the WHOLE pool (an exact tie splits it). The Foundation never touches a pool.

	/** The sitewide topic selector — one curated list used platform-wide. */
	const TOPICS = [
		'Mathematics', 'Physics', 'Astronomy', 'Chemistry', 'Biology', 'Medicine', 'Neuroscience',
		'Computing', 'Artificial intelligence', 'Data science', 'Engineering', 'Energy', 'Climate',
		'Earth science', 'Economics', 'Finance', 'History', 'Philosophy', 'Psychology', 'Sociology',
		'Linguistics', 'Literature', 'Music theory', 'Visual arts', 'Design', 'Architecture',
		'Games and play', 'Sport science', 'Food science', 'Education', 'Law', 'Political science',
		'Geography', 'Anthropology', 'Statistics', 'Probability', 'Logic', 'Cryptography',
		'Networks', 'Robotics', 'Ecology', 'Genetics', 'Optics', 'Acoustics', 'Materials',
		'Transportation', 'Space flight', 'Mythology',
	];

	/** A known full-moon instant + the mean synodic month give every future deadline choice.
	 *  Mean-only is honest to ±half a day — fine for deadlines, and stated in the UI. */
	const FULL_MOON_EPOCH = 1785340800; // 2026-07-29 00:00 UTC (the known full moon)
	const SYNODIC_S = 2551443;          // 29.530588 d

	public static function moons( $n = 8 ) {
		$now = time();
		$k = (int) ceil( ( $now + 86400 - self::FULL_MOON_EPOCH ) / self::SYNODIC_S );
		if ( $k < 0 ) { $k = 0; }
		$out = [];
		for ( $i = 0; $i < $n; $i++ ) {
			$out[] = (int) round( self::FULL_MOON_EPOCH + ( $k + $i ) * self::SYNODIC_S );
		}
		return $out;
	}

	/** GET challenges/options — the create-form vocabulary: topics + the next full moons. */
	public static function ch_options() {
		return [ 'topics' => self::TOPICS, 'moons' => self::moons(), 'kinds' => array_keys( self::KINDS ) ];
	}

	private static function ch_out( $c, $with_entries = false ) {
		$out = [
			'id' => (int) $c['id'], 'kind' => (string) $c['kind'], 'topic' => (string) $c['topic'],
			'title' => (string) $c['title'], 'fee' => (int) $c['fee'], 'pool' => (int) $c['pool'],
			'deadline' => (int) $c['deadline'], 'state' => (string) $c['state'],
			'creator' => self::author_card( $c['creator_id'] ),
			'entries' => (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_nb_entries' ) . ' WHERE ch_id = %d', [ (int) $c['id'] ] ),
			'results' => Data::dec( $c['results'] ?? '' ) ?: null,
		];
		if ( $with_entries ) {
			$rows = Data::all(
				// PUBLISHED ONLY. Removal is a soft delete (status='removed'), and integrity_sweep
				// demotes the same way — so without this filter an entrant could collect hearts and
				// then delete the work: it vanishes from the feed, its page 404s so nobody can even
				// look at what won, and it still ranked first and took the whole pool. Their fee
				// stays in the pool, which is the existing forfeit rule.
				'SELECT e.user_id, e.nb_id, n.title, n.slug, n.hearts FROM ' . Data::t( 'aq_nb_entries' ) . ' e'
				. ' JOIN ' . Data::t( 'aq_notebooks' ) . " n ON n.id = e.nb_id AND n.status = 'published'"
				. ' WHERE e.ch_id = %d ORDER BY n.hearts DESC, e.id ASC LIMIT 100',
				[ (int) $c['id'] ] );
			$out['board'] = array_map( static function ( $r, $i ) {
				return [ 'rank' => $i + 1, 'nb_id' => (int) $r['nb_id'], 'title' => (string) $r['title'], 'slug' => (string) $r['slug'],
					'hearts' => (int) $r['hearts'], 'author' => self::author_card( $r['user_id'] ) ];
			}, $rows, array_keys( $rows ) );
		}
		return $out;
	}

	/** GET challenges — open challenges (soonest deadline first) + recently settled. ?id= for one. */
	public static function challenges( $req = null ) {
		self::ensure_tables();
		self::settle_due();
		$one = $req ? Rest::pint( $req, 'id', 0 ) : 0;
		if ( $one ) {
			$c = Data::one( 'SELECT * FROM ' . Data::t( 'aq_nb_challenges' ) . ' WHERE id = %d', [ $one ] );
			return $c ? self::ch_out( $c, true ) : Rest::err( 'not_found', 'No such challenge', 404 );
		}
		$open = Data::all( 'SELECT * FROM ' . Data::t( 'aq_nb_challenges' ) . " WHERE state = 'open' ORDER BY deadline ASC LIMIT 50" );
		$past = Data::all( 'SELECT * FROM ' . Data::t( 'aq_nb_challenges' ) . " WHERE state = 'settled' ORDER BY deadline DESC LIMIT 12" );
		return [
			'current' => array_map( [ self::class, 'ch_out' ], $open ),
			'past'    => array_map( [ self::class, 'ch_out' ], $past ),
			// The rule says exactly what settle_due() does, to the coin — including the remainder a
			// pool that will not divide leaves behind. A published rule a member can check against
			// the ledger is the whole point of the pool being member-funded.
			'rule'    => 'Winner takes the whole pool; an exact tie splits it evenly, and any coins that will not divide go one each to the earliest entries.',
		];
	}

	/** POST challenges {kind, topic, title, deadline, fee, nb_id} — found a challenge with your own
	 *  notebook. The founder pays the fee like everyone else; pool starts at fee. */
	public static function ch_create( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_ch_create', 5, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid   = Rest::uid();
		$kind  = sanitize_key( (string) Rest::p( $req, 'kind', '' ) );
		$topic = sanitize_text_field( (string) Rest::p( $req, 'topic', '' ) );
		$title = sanitize_text_field( mb_substr( (string) Rest::p( $req, 'title', '' ), 0, 160 ) );
		$dl    = Rest::pint( $req, 'deadline', 0 );
		$fee   = max( 1, min( 1000, Rest::pint( $req, 'fee', 1 ) ) );
		$nbid  = Rest::pint( $req, 'nb_id', 0 );
		if ( ! isset( self::KINDS[ $kind ] ) ) { return Rest::err( 'bad_kind', 'Pick a category' ); }
		if ( ! in_array( $topic, self::TOPICS, true ) ) { return Rest::err( 'bad_topic', 'Pick a topic from the selector' ); }
		if ( mb_strlen( $title ) < 4 ) { return Rest::err( 'bad_title', 'Give it a title' ); }
		if ( ! in_array( $dl, self::moons(), true ) ) { return Rest::err( 'bad_deadline', 'Pick one of the listed full moons' ); }
		$id = Data::insert( 'aq_nb_challenges', [
			'creator_id' => $uid, 'kind' => $kind, 'topic' => $topic, 'title' => $title,
			'fee' => $fee, 'deadline' => $dl, 'pool' => 0, 'state' => 'open', 'created' => Data::now(),
		] );
		if ( ! $id ) { return Rest::err( 'server_error', 'Could not create', 500 ); }
		$req->set_param( 'id', $id );
		$req->set_param( 'nb_id', $nbid );
		$join = self::ch_enter( $req );
		if ( $join instanceof \WP_REST_Response ) {
			global $wpdb;
			$wpdb->delete( Data::t( 'aq_nb_challenges' ), [ 'id' => (int) $id ] ); // founding requires a valid entry
			return $join;
		}
		return self::ch_out( Data::one( 'SELECT * FROM ' . Data::t( 'aq_nb_challenges' ) . ' WHERE id = %d', [ (int) $id ] ), true );
	}

	/** POST challenges/{id}/enter {nb_id} — pay the fee, enter your own PUBLISHED notebook of the kind. */
	public static function ch_enter( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_ch_enter', 20, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		$c   = Data::one( 'SELECT * FROM ' . Data::t( 'aq_nb_challenges' ) . ' WHERE id = %d', [ Rest::pint( $req, 'id' ) ] );
		if ( ! $c || $c['state'] !== 'open' ) { return Rest::err( 'not_found', 'No such open challenge', 404 ); }
		if ( (int) $c['deadline'] <= time() ) { return Rest::err( 'closed', 'This challenge has reached its full moon', 409 ); }
		$nb = self::row( Rest::pint( $req, 'nb_id', 0 ) );
		if ( ! $nb || (int) $nb['author_id'] !== $uid ) { return Rest::err( 'not_yours', 'Enter with your own notebook', 403 ); }
		if ( (string) $nb['kind'] !== (string) $c['kind'] ) { return Rest::err( 'wrong_kind', 'This challenge is for ' . $c['kind'] . ' notebooks', 409 ); }
		if ( (string) $nb['status'] !== 'published' ) {
			return Rest::err( 'not_published', 'Only published works can enter — clear the reproducibility checklist and confirm publication from your own inbox first', 409 );
		}
		$fee = (int) $c['fee'];
		// Serialise this member's wallet debits on the SAME atomic per-user lock every other spend path
		// uses (Economy::sell, Learn::ensure_enrolled, Shop::order). The ref makes the debit idempotent
		// per CHALLENGE, which stops a double-charge for one entry — it does nothing about two DIFFERENT
		// challenges entered at once, where both affordability checks read the same balance before either
		// debit lands and the wallet goes negative. That is unbacked coin minted into a prize pool: the
		// pool pays out real value the entrant never held, and the Foundation's full-reserve invariant is
		// the thing that absorbs it. This was the one spend path left outside the lock.
		$wlock = 'wallet_u' . $uid;
		if ( ! Economy::acquire_lock( $wlock, 15 ) ) {
			return Rest::err( 'busy', 'Another payment is in progress. Please try again in a moment.', 429 );
		}
		$credited = null;
		try {
			// One entry per member: settle this BEFORE any money moves, so a repeat call can never spend
			// a donor's credit on a seat this member already holds. Only this member can insert this key
			// and we hold their wallet lock, so the read and the insert below cannot be interleaved.
			if ( Data::col( 'SELECT id FROM ' . Data::t( 'aq_nb_entries' ) . ' WHERE ch_id = %d AND user_id = %d', [ (int) $c['id'], $uid ] ) ) {
				return Rest::err( 'entered', 'You are already in — one entry per member', 409 );
			}

			// ── ARTACREDITS ────────────────────────────────────────────────────────────────────────
			// Short of the fee? A donor may have already paid it for someone like this member. We never
			// spend a stranger's gift silently: the FIRST call is refused with the donor's name and the
			// slice the gift was given for, and only a SECOND call carrying accept_credit=1 redeems it.
			// So consent is informed and in the moment, and nothing anywhere records that a member would
			// LIKE to be sponsored — there is no standing "please help me" flag for the public DB to hold.
			if ( Economy::coin_balance( $uid ) < $fee ) {
				$gift = Credits::match( $uid, $c, $fee );
				if ( ! $gift ) { return Rest::err( 'poor', 'The entry fee is ₳' . $fee, 402 ); }
				if ( ! Rest::pint( $req, 'accept_credit', 0 ) ) {
					$donor = Credits::donor_name( $gift );
					return Rest::err( 'credit_offered', 'Your entry fee has already been paid — accept it to enter.', 402, [
						'credit' => [
							'donor'  => $donor !== '' ? $donor : 'A friend of ArtaQuest',
							'named'  => $donor !== '',
							'slice'  => Credits::bucket_words( $gift['bucket'] ),
							'fee'    => $fee,
							'notice' => 'Accepting records publicly, in the open database, that this entry was paid for you.',
						],
					] );
				}
				// redeem() claims the ENTRY and the credit and moves the money as one critical section,
				// so a 0 means a losing race in which nothing was charged and no entry was made.
				if ( ! Credits::redeem( $uid, $c, $fee, $gift, (int) $nb['id'] ) ) {
					return Rest::err( 'poor', 'The entry fee is ₳' . $fee, 402 );
				}
				$credited = $gift;
			}

			// A credited entry's fee was paid from the fund and its row was written inside redeem(), so
			// the member is charged nothing here — and no coin was minted to them on the way, which is
			// what keeps coins_issued and the full-reserve invariant untouched.
			if ( ! $credited ) {
				$new = Data::upsert( 'aq_nb_entries', [ 'ch_id' => (int) $c['id'], 'user_id' => $uid ], [ 'nb_id' => (int) $nb['id'], 'created' => Data::now() ] );
				if ( ! $new ) { return Rest::err( 'entered', 'You are already in — one entry per member', 409 ); }
				$ref = 'chfee:' . $c['id'] . ':' . $uid;
				if ( ! Data::col( 'SELECT id FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'chfee' AND ref = %s LIMIT 1", [ $ref ] ) ) {
					Economy::credit_coins( $uid, -$fee, 'chfee', $ref );
					Data::bump( 'aq_nb_challenges', [ 'id' => (int) $c['id'] ], 'pool', $fee );
				}
			}
		} finally {
			Economy::release_lock( $wlock ); // released before the notification tail, as everywhere else
		}
		if ( (int) $c['creator_id'] !== $uid ) {
			$me = get_userdata( $uid );
			Notify::push( (int) $c['creator_id'], 'challenge', ( $me ? $me->display_name : 'Someone' ) . ' entered "' . $c['title'] . '" — the pool grew to ₳' . ( (int) $c['pool'] + $fee ), '', '/challenges/', 'chent' . $c['id'] . ':' . $uid );
		}
		$out = [ 'ok' => true, 'pool' => (int) $c['pool'] + $fee, 'certificate' => '/certificate/?challenge=' . (int) $c['id'] ];
		if ( $credited ) {
			$donor = Credits::donor_name( $credited );
			$out['credited'] = [ 'donor' => $donor !== '' ? $donor : 'A friend of ArtaQuest', 'named' => $donor !== '', 'fee' => $fee ];
			// Tell the DONOR their gift just did something. Without this the whole flow is one-way: a
			// donor gives and then never learns whether anyone was actually helped, which is both the
			// least motivating possible design and, on a platform whose books are public, a strange
			// silence. The ref makes it idempotent per (challenge, entrant) exactly like the founder's.
			Credits::notify_donor( $credited, $uid, $c, $fee );
		}
		return $out;
	}

	/** Winner takes all at the full moon; an exact tie splits evenly, odd coins one each to the
	 *  earliest entries. A deadline nobody can win refunds instead. Lock + refs = idempotent. */
	private static function settle_due() {
		if ( ! Data::col( 'SELECT id FROM ' . Data::t( 'aq_nb_challenges' ) . " WHERE state = 'open' AND deadline <= %d LIMIT 1", [ time() ] ) ) { return; }
		if ( ! Economy::acquire_lock( 'nbsettle', 120 ) ) { return; }
		try {
			$due = Data::all( 'SELECT * FROM ' . Data::t( 'aq_nb_challenges' ) . " WHERE state = 'open' AND deadline <= %d LIMIT 12", [ time() ] );
			foreach ( $due as $c ) {
				$full  = self::ch_out( $c, true );
				$board = $full['board'];
				$pool  = (int) $c['pool'];
				// NOBODY CAN WIN. ch_out's board is PUBLISHED-only, so every entry can be gone by the
				// deadline — an integrity_sweep demotion, a soft delete, or simply every entrant
				// removing their work. The fees are already burned and the ledger is append-only, so
				// stamping 'settled' here closed the challenge with the whole pool unpaid and NO WAY
				// BACK: real coins destroyed, nobody to claim them. Refund instead — one compensating
				// credit per entrant who actually paid, keyed on its own ref so a retried settlement
				// (this runs on every /challenges read) can never pay twice. Leaving it open was the
				// other option and it is worse: the deadline has passed, so ch_enter refuses every
				// new entry, and the challenge becomes a zombie re-settled on every read forever with
				// the pool frozen inside it. A refund ends it honestly.
				// This also covers the degenerate deadlines: zero entries (nothing was staked, so
				// nothing is refunded) and every entry flagged/demoted (all of it comes back).
				if ( ! $board ) {
					$back = self::ch_refund_all( $c );
					Data::update( 'aq_nb_challenges', [
						'state'   => 'settled',
						'pool'    => 0, // the challenge holds nothing now; `staked` keeps the record
						'results' => Data::enc( [
							'podium' => [], 'paid' => 0, 'staked' => $pool, 'refunded' => $back,
							'note'   => $back > 0
								? 'No published entry stood at the full moon, so nobody could win — every entry fee was refunded in full.'
								: 'The full moon passed with nothing entered.',
						] ),
					], [ 'id' => (int) $c['id'] ] );
					continue;
				}
				$top = $board[0]['hearts'];
				$winners = array_values( array_filter( $board, static function ( $b ) use ( $top ) { return $b['hearts'] === $top; } ) );
				$paid = 0;
				$results = [];
				// EVENLY, exactly as the published rule says. A coin is indivisible, so a pool that
				// does not divide by the number of tied winners leaves a remainder of at most n−1
				// coins: give those ONE EACH to the earliest entries. The board is already ordered
				// hearts DESC, entry id ASC, so "earliest" is deterministic and needs no tiebreak of
				// its own. The old line handed the entire remainder to the first winner — a pool of
				// 15 split four ways paid 6/3/3/3, which is not the even split members were promised.
				$n    = count( $winners );
				$each = intdiv( $pool, $n );
				$odd  = $pool - $each * $n;
				foreach ( $winners as $i => $w ) {
					$share = $each + ( $i < $odd ? 1 : 0 );
					$ref = 'chprize:' . $c['id'] . ':' . $w['author']['id'];
					if ( $share > 0 && ! Data::col( 'SELECT id FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'chprize' AND ref = %s LIMIT 1", [ $ref ] ) ) {
						Economy::credit_coins( (int) $w['author']['id'], $share, 'chprize', $ref );
						Notify::push( (int) $w['author']['id'], 'prize', 'You won ₳' . $share . ' — "' . $c['title'] . '"' . ( count( $winners ) > 1 ? ' (tie, split)' : ' (winner takes all)' ), '', '/challenges/', $ref );
					}
					$paid += $share;
					$results[] = [ 'place' => 1, 'prize' => $share ] + $w;
				}
				// FREEZE the whole board, not just the podium. `hearts` keeps moving after the moon, so a
				// board recomputed later would keep re-ranking a settled challenge — and every entrant's
				// Certificate of Participation prints its placement. The certificate reads THIS and only
				// this, so what a member prints today still says the same thing in a year.
				// Carry the settlement's OWN place, not the board's array index. An exact tie makes every
				// tied entry place 1 and splits the pool, so an index would have printed "2nd of 5" on
				// a co-winner's certificate beside the prize they actually shared for first.
				$place_by = []; $prize_by = [];
				foreach ( $results as $r ) {
					$place_by[ (int) $r['nb_id'] ] = (int) $r['place'];
					$prize_by[ (int) $r['nb_id'] ] = (int) $r['prize'];
				}
				$frozen = array_map( static function ( $b, $i ) use ( $place_by, $prize_by ) {
					$id = (int) $b['nb_id'];
					return [
						'nb_id'  => $id,
						'title'  => (string) $b['title'],
						'hearts' => (int) $b['hearts'],
						'author' => (int) $b['author']['id'],
						'place'  => $place_by[ $id ] ?? ( $i + 1 ),
						'prize'  => $prize_by[ $id ] ?? 0,
					];
				}, $board, array_keys( $board ) );
				Data::update( 'aq_nb_challenges', [ 'state' => 'settled', 'results' => Data::enc( [ 'podium' => $results, 'paid' => $paid, 'board' => $frozen ] ) ], [ 'id' => (int) $c['id'] ] );
			}
		} finally {
			Economy::release_lock( 'nbsettle' );
		}
	}

	/**
	 * Give every entry fee back on a challenge nobody can win. APPEND-ONLY: the 'chfee' debit is
	 * never touched — a compensating credit is written beside it, under its own `chrefund:<ch>:<uid>`
	 * ref, and that ref is probed first so a second settlement pass pays nobody twice.
	 *
	 * The amount is read back from the LEDGER, not from the challenge's `fee`: the ledger is what
	 * actually left the member's wallet, so an entrant whose debit never landed (credit_coins bails
	 * on a failed INSERT) is skipped rather than paid coins they never spent. Returns the coins
	 * returned by THIS pass. Called only from settle_due(), inside the nbsettle lock.
	 */
	private static function ch_refund_all( $c ) {
		$back = 0;
		// NO LIMIT, deliberately: a bound here would silently leave the entrants past it out of
		// pocket while settle_due() stamped the challenge closed. One id per entrant is cheap, and
		// if a pass dies half way the per-entrant refs mean the next one resumes exactly where it
		// stopped (the state flip only happens after this returns).
		$rows = Data::all( 'SELECT user_id FROM ' . Data::t( 'aq_nb_entries' ) . ' WHERE ch_id = %d ORDER BY id ASC', [ (int) $c['id'] ] );
		foreach ( $rows as $e ) {
			$uid  = (int) $e['user_id'];
			$paid = (int) Data::col( 'SELECT COALESCE(SUM(delta),0) FROM ' . Data::t( 'aq_coin_ledger' )
				. " WHERE user_id = %d AND reason = 'chfee' AND ref = %s", [ $uid, 'chfee:' . (int) $c['id'] . ':' . $uid ] );
			$amount = -$paid; // the entry fee is a NEGATIVE delta; give back exactly its magnitude
			if ( $amount <= 0 ) { continue; }
			$ref = 'chrefund:' . (int) $c['id'] . ':' . $uid;
			if ( Data::col( 'SELECT id FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'refund' AND ref = %s LIMIT 1", [ $ref ] ) ) { continue; }
			Economy::credit_coins( $uid, $amount, 'refund', $ref );
			Notify::push( $uid, 'challenge', 'Refunded ₳' . $amount . ' — "' . $c['title'] . '"',
				'No published entry stood at the full moon, so nobody could win the pool. Your entry fee has been returned in full.',
				'/challenges/', $ref );
			$back += $amount;
		}
		return $back;
	}

	// ── The permanent DOI (Zenodo; Vault tokens only) ──

	private static function vault( $name ) {
		return class_exists( '\\AQ\\Vault' ) ? (string) Vault::get( $name ) : '';
	}

	/** Mint the permanent Zenodo DOI for a published notebook: the deposited files are the executed
	 *  .ipynb and, when the work declares any pins, the requirements.txt it ran under. */
	/** The Zenodo deposit metadata for a published notebook (built here so the on-box mint and the
	 *  off-box co-signer deposit are byte-identical). */
	private static function doi_metadata( $row ) {
		$au  = get_userdata( (int) $row['author_id'] );
		$kernel = (string) ( $row['kg_url'] ?? '' );
		$facts  = Data::dec( $row['kg_facts'] ?? '' ) ?: [];
		// ATTRIBUTION (operator decision 2026-07-28: any public kernel may be submitted, CREDITED TO
		// ITS ORIGINAL KAGGLE AUTHOR). The submitting member is not necessarily the person who wrote
		// the notebook, and a DOI is permanent — so the creator recorded here is the Kaggle author
		// Kaggle itself reports, with the submitting member named as the person who brought it here.
		$kg_author = trim( (string) ( $facts['author'] ?? '' ) );
		$kg_owner  = trim( (string) ( $row['kg_owner'] ?? '' ) );
		$nm  = $au ? trim( (string) $au->display_name ) : 'ArtaQuest Foundation';
		$fam = ( strpos( $nm, ' ' ) !== false ) ? ( substr( strrchr( $nm, ' ' ), 1 ) . ', ' . trim( substr( $nm, 0, strrpos( $nm, ' ' ) ) ) ) : $nm;
		return [ 'metadata' => [
			'title'            => (string) $row['title'],
			'upload_type'      => 'software',
			'description'      => nl2br( esc_html( (string) $row['abstract'] ) )
				. '<br><br>A reproducible ' . esc_html( (string) $row['kind'] ) . ' published on the ArtaQuest feed. It is a public Kaggle notebook that has been run'
				. ( $kernel !== '' ? ' (' . esc_html( $kernel ) . ')' : '' )
				. '. Before publication a reproducibility checklist read the following back from the public Kaggle API, which answers without a credential so any reader can re-run the same checks: the notebook is public; every dataset, model and notebook it takes as input is public; '
				// A DOI is permanent and cannot be amended, so it must assert ONLY what was actually
				// established. `run_done` is tri-state: Kaggle's completion marker present, a crash,
				// or no marker either way — and the third case is a real outcome that the record has
				// to state as such rather than round up into "the run completed".
				. ( true === ( $facts['run_done'] ?? null )
					? 'the run completed and produced the published files'
					: 'the run produced the published files, though Kaggle recorded no completion marker for it' )
				. '; and it ran '
				. ( empty( $facts['internet'] ) ? 'with the internet switched off, on Kaggle&rsquo;s own record' : 'with internet access enabled' )
				. '. Nothing about this work was scored, ranked or graded.'
				. ( '' !== $kg_author ? ' The notebook is credited to its Kaggle author, ' . esc_html( $kg_author ) . '.' : '' )
				. ' Publication was confirmed from the submitting ArtaQuest member&rsquo;s own registered email and signed by their device passkey.',
			'creators'         => [ '' !== $kg_author
				? [ 'name' => $kg_author, 'affiliation' => 'Kaggle' . ( '' !== $kg_owner ? ' (' . $kg_owner . ')' : '' ) ]
				: [ 'name' => $fam, 'affiliation' => 'ArtaQuest' ] ],
			'contributors'     => '' !== $kg_author ? [ [ 'name' => $fam, 'type' => 'Other', 'affiliation' => 'ArtaQuest' ] ] : [],
			'access_right'     => 'open',
			'license'          => 'cc-by-4.0',
			'publication_date' => gmdate( 'Y-m-d' ),
			'keywords'         => [ 'ArtaQuest', 'reproducible notebook', (string) $row['kind'] ],
		] ];
	}

	private static function doi_filename( $row ) {
		$f = sanitize_title( (string) $row['title'] );
		return ( $f !== '' ? mb_substr( $f, 0, 48 ) : 'notebook' ) . '.ipynb';
	}

	private static function mint_doi( $row ) {
		// NULL-SAFE, and it must be. `ipynb_out` is LONGTEXT with no default and NOTHING in the
		// Kaggle flow writes it — only the retired execution relay ever did. So the column is SQL
		// NULL, and `null !== ''` is TRUE, which selected the NULL branch and produced ''. Written
		// the obvious-looking way, this silently disabled the DOI — the platform's citation of
		// record — on every work published since the reset.
		$file = (string) ( $row['ipynb_out'] ?? '' );
		if ( '' === $file ) { $file = (string) ( $row['ipynb'] ?? '' ); }
		if ( $file === '' ) { return []; }
		$meta = self::doi_metadata( $row );
		$token = self::vault( 'ZENODO_TOKEN' );
		if ( $token === '' ) { return []; }
		$base = 'https://zenodo.org/api';
		$auth = [ 'Authorization' => 'Bearer ' . $token ];
		$dep_r = wp_remote_post( $base . '/deposit/depositions', [ 'timeout' => 40, 'headers' => $auth + [ 'Content-Type' => 'application/json' ], 'body' => '{}' ] );
		if ( is_wp_error( $dep_r ) || (int) wp_remote_retrieve_response_code( $dep_r ) >= 400 ) { return []; }
		$dep    = json_decode( wp_remote_retrieve_body( $dep_r ), true );
		$dep_id = (int) ( $dep['id'] ?? 0 );
		$bucket = (string) ( $dep['links']['bucket'] ?? '' );
		if ( ! $dep_id || ! $bucket ) { return []; }
		$result = [];
		try {
			$up = wp_remote_request( $bucket . '/' . rawurlencode( self::doi_filename( $row ) ), [ 'method' => 'PUT', 'timeout' => 60, 'headers' => $auth + [ 'Content-Type' => 'application/octet-stream' ], 'body' => $file ] );
			if ( is_wp_error( $up ) || (int) wp_remote_retrieve_response_code( $up ) >= 400 ) { throw new \Exception( 'file upload failed' ); }
			// SECOND FILE — the environment, deposited with the work (2026-07-26): a notebook alone is
			// not a reproducible record if the stack it ran in lives only on this site. Skipped when
			// the pin set is empty, because "the base environment" is a claim about nothing and an
			// empty attachment would only mislead a reader. NOT fenced by the throw above: a hiccup on
			// this file must never cost the work its DOI (the pins are public on the work's page and
			// bound by req_sig either way), so it fails soft and loudly in the log.
			$reqs = (string) ( $row['requirements'] ?? '' );
			if ( self::requirements_pins( $reqs ) !== '' ) {
				$rq = wp_remote_request( $bucket . '/requirements.txt', [ 'method' => 'PUT', 'timeout' => 40, 'headers' => $auth + [ 'Content-Type' => 'application/octet-stream' ], 'body' => rtrim( $reqs, "\n" ) . "\n" ] );
				if ( is_wp_error( $rq ) || (int) wp_remote_retrieve_response_code( $rq ) >= 400 ) {
					error_log( 'AQ mint_doi: nb ' . (int) $row['id'] . ' deposited without requirements.txt (' . ( is_wp_error( $rq ) ? $rq->get_error_message() : wp_remote_retrieve_response_code( $rq ) ) . ')' );
				}
			}
			$mr = wp_remote_request( $base . '/deposit/depositions/' . $dep_id, [ 'method' => 'PUT', 'timeout' => 40, 'headers' => $auth + [ 'Content-Type' => 'application/json' ], 'body' => wp_json_encode( $meta ) ] );
			if ( is_wp_error( $mr ) || (int) wp_remote_retrieve_response_code( $mr ) >= 400 ) { throw new \Exception( 'metadata failed' ); }
			$pb = wp_remote_post( $base . '/deposit/depositions/' . $dep_id . '/actions/publish', [ 'timeout' => 60, 'headers' => $auth ] );
			if ( is_wp_error( $pb ) || (int) wp_remote_retrieve_response_code( $pb ) >= 400 ) { throw new \Exception( 'publish failed' ); }
			$pub    = json_decode( wp_remote_retrieve_body( $pb ), true );
			$result = [ 'doi' => (string) ( $pub['doi'] ?? $pub['metadata']['doi'] ?? '' ), 'record_url' => (string) ( $pub['links']['record_html'] ?? '' ) ];
		} catch ( \Throwable $e ) {
			wp_remote_request( $base . '/deposit/depositions/' . $dep_id, [ 'method' => 'DELETE', 'timeout' => 20, 'headers' => $auth ] );
			$result = [];
		}
		return $result;
	}


	/**
	 * Kaggle dataset refs this notebook should mount so it reproduces THERE, not just here.
	 *
	 * Still empty, but for a better reason than before. The old note said the deliverables lived on
	 * HuggingFace and a Kaggle kernel cannot mount an HF repo — which was the whole problem, and is
	 * why HF is gone (operator 2026-08-02). Now that the platform's heavy data sits in public Kaggle
	 * datasets under `artafather`, mounting IS possible; returning [] simply means we do not yet
	 * declare per-work data sources. A self-contained kernel is still the correct default: a notebook
	 * that must reach the network to reproduce fails our own offline check anyway.
	 */
	private static function kaggle_data_sources( $row ) {
		return [];
	}

	/**
	 * Empty every legacy aq_* table (rows, not structure), remove all non-administrator members,
	 * clear WP content posts, rebuild economy projections and re-baseline the Watchdog. Guarded by
	 * an exact confirm phrase; run deliberately via wp-cli — NEVER wired to a route or migration.
	 * Pre-purge snapshot: ~/.artaquest-dev/backups/prod-full-pre-purge-2026-07-13.sql.gz (operator laptop).
	 */
	public static function purge_legacy( $confirm = '' ) {
		if ( $confirm !== 'PURGE-ALL-LEGACY-DATA' ) { return 'refused: wrong confirm phrase'; }
		global $wpdb;
		self::ensure_tables();
		$keep = [ $wpdb->prefix . 'aq_notebooks', $wpdb->prefix . 'aq_nb_runs', $wpdb->prefix . 'aq_nb_reviews' ];
		$emptied = [];
		$tables  = $wpdb->get_col( 'SHOW TABLES' );
		foreach ( $tables as $t ) {
			if ( strpos( $t, $wpdb->prefix . 'aq_' ) !== 0 || in_array( $t, $keep, true ) ) { continue; }
			$wpdb->query( "DELETE FROM {$t}" ); // phpcs:ignore
			$emptied[] = $t;
		}
		// Members: everyone except administrators goes (auth is email-code/Google; nothing to keep).
		$admins = $wpdb->get_col( $wpdb->prepare(
			"SELECT user_id FROM {$wpdb->usermeta} WHERE meta_key = %s AND meta_value LIKE %s",
			$wpdb->prefix . 'capabilities', '%administrator%' ) );
		$admins = array_map( 'intval', $admins ) ?: [ 1 ];
		$in     = implode( ',', $admins );
		$gone   = (int) $wpdb->query( "DELETE FROM {$wpdb->users} WHERE ID NOT IN ({$in})" ); // phpcs:ignore
		$wpdb->query( "DELETE FROM {$wpdb->usermeta} WHERE user_id NOT IN ({$in})" ); // phpcs:ignore
		// WP-native content (the SPA serves everything; keep static pages for wp-admin sanity).
		$wpdb->query( "DELETE FROM {$wpdb->posts} WHERE post_type NOT IN ('page')" ); // phpcs:ignore
		$wpdb->query( "DELETE pm FROM {$wpdb->postmeta} pm LEFT JOIN {$wpdb->posts} p ON p.ID = pm.post_id WHERE p.ID IS NULL" ); // phpcs:ignore
		$wpdb->query( "DELETE FROM {$wpdb->comments}" ); // phpcs:ignore
		$wpdb->query( "DELETE FROM {$wpdb->commentmeta}" ); // phpcs:ignore
		// Projections + tamper baselines must agree with the (now empty) ledgers.
		if ( class_exists( '\\AQ\\Economy' ) && method_exists( '\\AQ\\Economy', 'rebuild_projections' ) ) { Economy::rebuild_projections(); }
		if ( class_exists( '\\AQ\\Watchdog' ) && method_exists( '\\AQ\\Watchdog', 'rebaseline' ) ) { Watchdog::rebaseline(); }
		return 'purged ' . count( $emptied ) . ' aq_ tables, removed ' . $gone . ' member accounts (kept admins: ' . $in . ')';
	}
}
