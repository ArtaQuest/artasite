<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Kaggle-style predictive-modelling competitions.
 *
 * A competition ships an OPEN dataset (train.csv + test.csv + sample_submission.csv, all served
 * from uploads/competitions/<slug>/) and hides the answers. Members download the data, fit a model,
 * and POST predictions for the test rows; the server scores them with R² against a holdout that is
 * NEVER public. Because ArtaQuest publishes its whole database (/data), the holdout true targets are
 * deliberately kept OUT of every aq_* table — they live as a server-only file
 * (uploads/competitions/<slug>/solution.json) that the scorer reads and nothing else exposes.
 *
 * The leaderboard is best-per-member: every submission is stored (append-only aq_comp_subs) and the
 * board takes the MAX score per uid, so an improving submission simply outranks the member's earlier
 * ones and a worse one never demotes them.
 */
final class Competitions {

	/** Absolute path to a competition's data directory (public files + the server-only solution). */
	private static function dir( $slug ) {
		$up = wp_upload_dir();
		return rtrim( (string) $up['basedir'], '/' ) . '/competitions/' . sanitize_file_name( (string) $slug );
	}

	/** Public base URL for a competition's downloadable data files. */
	private static function base_url( $slug ) {
		$up = wp_upload_dir();
		return rtrim( (string) $up['baseurl'], '/' ) . '/competitions/' . sanitize_file_name( (string) $slug );
	}

	/** Human display name for a user id (falls back to a generic handle). */
	private static function name_of( $uid ) {
		$u = $uid ? get_userdata( (int) $uid ) : null;
		return $u ? $u->display_name : 'Member #' . (int) $uid;
	}

	/** Public profile slug (/u/<slug>) for a user id, or ''. */
	private static function slug_of( $uid ) {
		$u = $uid ? get_userdata( (int) $uid ) : null;
		return $u ? $u->user_nicename : '';
	}

	// ── Reads ─────────────────────────────────────────────────────────────────

	/** GET competitions — every competition with its team count + best score (single grouped scan). */
	public static function list_all( $req ) {
		global $wpdb;
		$c = Data::t( 'aq_competitions' );
		$s = Data::t( 'aq_comp_subs' );
		// One row per competition; the aggregates come from a LEFT JOIN + GROUP BY over the (comp_id,…)
		// index (distinct entrants + best score), so the list never N+1s a query per competition.
		$rows = Data::all(
			"SELECT c.*, COUNT(DISTINCT s.uid) AS n_teams, MAX(s.score) AS best_score
			   FROM $c c LEFT JOIN $s s ON s.comp_id = c.id
			  GROUP BY c.id
			  ORDER BY c.status ASC, c.id DESC"
		);
		$items = array_map( function ( $r ) {
			return [
				'slug'       => $r['slug'],
				'title'      => $r['title'],
				'owner'      => self::name_of( (int) $r['owner_uid'] ),
				'owner_slug' => self::slug_of( (int) $r['owner_uid'] ),
				'metric'     => $r['metric'],
				'deadline'   => $r['deadline'],
				'status'     => $r['status'],
				'prize'      => self::pool_of( $r ), // the LIVE pool: fixed prize + the full entry-fee revenue
				'entry_fee'  => (int) ( $r['entry_fee'] ?? 0 ),
				'n_teams'    => (int) $r['n_teams'],
				'best_score' => $r['best_score'] === null ? null : round( (float) $r['best_score'], 6 ),
				'n_targets'  => (int) $r['n_targets'],
				'created'    => $r['created'] ? (int) strtotime( $r['created'] . ' UTC' ) : 0, // unix secs (relAgo)
			];
		}, $rows );
		return [ 'items' => $items ];
	}

	/** GET competition?slug= — the overview: the row + data-download URLs + evaluation text. */
	public static function detail( $req ) {
		$slug = sanitize_file_name( (string) Rest::p( $req, 'slug', '' ) );
		$row  = $slug ? Data::one( 'SELECT * FROM ' . Data::t( 'aq_competitions' ) . ' WHERE slug = %s', [ $slug ] ) : null;
		if ( ! $row ) { return Rest::err( 'not_found', 'Competition not found', 404 ); }
		$base = self::base_url( $slug );
		$dir  = self::dir( $slug );
		$file = function ( $name ) use ( $base, $dir ) {
			return is_file( $dir . '/' . $name ) ? $base . '/' . $name : null;
		};
		// Per-file byte sizes so the Data tab can show real download weights (Kaggle-style detail).
		$fsize = function ( $name ) use ( $dir ) {
			return is_file( $dir . '/' . $name ) ? (int) filesize( $dir . '/' . $name ) : 0;
		};
		// The submission row key, from test.csv's header: trend + the 11 body phases (no id/phase) → the
		// sky shape "trend|sky" (topic-500 — folded to the Sun-relative sky fingerprint server-side);
		// phase+trend+id → "phase|trend|id" (legacy phase-tuning; `shift` alias); trend+id →
		// "trend|id" (per-topic shuffled rows); a bare id column → opaque row ids; else the classic "trend|date".
		$hdr     = self::csv_header( $dir . '/test.csv' );
		$has     = fn( $c ) => $hdr && in_array( $c, $hdr, true );
		$phcol   = $has( 'phase' ) ? 'phase' : ( $has( 'shift' ) ? 'shift' : '' );
		$is_sky  = $has( 'trend' ) && $has( 'sun' ) && $has( 'node' ) && ! $has( 'id' ) && $phcol === '';
		$key_col = $is_sky ? 'trend|sky'
			: ( ( $phcol && $has( 'trend' ) && $has( 'id' ) ) ? ( $phcol . '|trend|id' )
			: ( ( $has( 'trend' ) && $has( 'id' ) ) ? 'trend|id' : ( $has( 'id' ) ? 'id' : 'trend|date' ) ) );
		// A column dictionary for the Data tab — every test.csv column, documented. The 11 bodies get
		// their astronomical meaning + orbital period; the key columns get their role.
		$periods = [ 'sun' => 1.0, 'mercury' => 0.241, 'venus' => 0.615, 'mars' => 1.881, 'jupiter' => 11.86,
			'saturn' => 29.46, 'uranus' => 84.0, 'neptune' => 164.8, 'pluto' => 248.0, 'chiron' => 50.0, 'node' => 18.6 ];
		$columns = [];
		foreach ( (array) $hdr as $col ) {
			if ( $col === 'phase' || $col === 'shift' ) { $columns[] = [ 'name' => $col, 'type' => 'int 0-355', 'desc' => "This row's phase rotation k — its 11 body phases carry (phase \xe2\x88\x92 k) mod 360. Every holdout month appears once per 5\xc2\xb0 phase (72 copies, same hidden target); predict them all, and each topic's best-phase R\xc2\xb2 (its season) sets its score." ]; }
			elseif ( $col === 'trend' )   { $columns[] = [ 'name' => $col, 'type' => 'string', 'desc' => 'The anonymised topic this row belongs to (e.g. topic-001) — one of the prediction targets.' ]; }
			elseif ( $col === 'id' )  { $columns[] = [ 'name' => $col, 'type' => 'int', 'desc' => 'The holdout month this row is a phase-copy of (constant across a month\xe2\x80\x99s 72 phases). Pair it with the topic and phase in your submission.' ]; }
			elseif ( $col === 'date' ) { $columns[] = [ 'name' => $col, 'type' => 'date', 'desc' => 'The observation month.' ]; }
			elseif ( isset( $periods[ $col ] ) ) {
				$columns[] = [ 'name' => $col, 'type' => 'int 0-360',
					'desc' => ucfirst( $col ) . "\xe2\x80\x99s sidereal ecliptic longitude (degrees) at the row\xe2\x80\x99s hidden moment"
						. ' — orbital period ' . $periods[ $col ] . ' yr.' ];
			} else { $columns[] = [ 'name' => $col, 'type' => 'number', 'desc' => 'Feature column.' ]; }
		}
		if ( $hdr ) { $columns[] = [ 'name' => 'target', 'type' => 'int 0-100', 'desc' => 'Worldwide Google-Trends search interest of the topic at that moment — train.csv only; predict it for every test row.' ]; }
		return [
			'id'          => (int) $row['id'], // numeric id — the dataset's key in the challenge frame (hearts)
			'slug'        => $row['slug'],
			'title'       => $row['title'],
			'owner'       => self::name_of( (int) $row['owner_uid'] ),
			'owner_slug'  => self::slug_of( (int) $row['owner_uid'] ),
			'blurb'       => $row['blurb'],
			'metric'      => $row['metric'],
			'holdout'     => $row['holdout'],
			'status'      => $row['status'],
			'created'     => $row['created'],
			'deadline'    => $row['deadline'],
			'prize'       => self::pool_of( $row ), // the LIVE pool: fixed prize + the full entry-fee revenue
			'entry_fee'   => (int) ( $row['entry_fee'] ?? 0 ),
			'thread_id'   => (int) ( $row['thread_id'] ?? 0 ),
			'key_col'     => $key_col,
			'n_train'     => (int) $row['n_train'],
			'n_test'      => (int) $row['n_test'],
			'n_features'  => (int) $row['n_features'],
			'n_targets'   => (int) $row['n_targets'],
			'data'        => [
				'train'             => $file( 'train.csv' ) ?: $file( 'train.zip' ), // zip = per-topic CSVs
				'test'              => $file( 'test.csv' ),
				'sample_submission' => $file( 'sample_submission.csv' ),
				'notebook'          => $file( 'starter.ipynb' ),
			],
			'sizes'       => [ // bytes per public file (0 = absent) — the Data tab shows real weights
				'train'             => $fsize( 'train.csv' ) ?: $fsize( 'train.zip' ),
				'test'              => $fsize( 'test.csv' ),
				'sample_submission' => $fsize( 'sample_submission.csv' ),
				'notebook'          => $fsize( 'starter.ipynb' ),
			],
			'columns'     => $columns, // the documented schema of every data column
			'evaluation'  => self::evaluation_text( $row, $key_col ),
			'my_review'   => self::my_review( (int) $row['id'] ), // the caller's own solution-review state (null if none/not signed in)
		];
	}

	/**
	 * GET competition/my-submissions?slug= — the signed-in member's own submission history for a
	 * competition, newest first (score, note, review state per row). Powers the Submit tab's
	 * "your submissions" table. Empty list when signed out.
	 */
	public static function my_submissions( $req ) {
		$uid  = Rest::uid();
		$slug = sanitize_file_name( (string) Rest::p( $req, 'slug', '' ) );
		$comp = $slug ? Data::one( 'SELECT id FROM ' . Data::t( 'aq_competitions' ) . ' WHERE slug = %s', [ $slug ] ) : null;
		if ( ! $comp || ! $uid ) { return [ 'items' => [] ]; }
		$rows = Data::all(
			'SELECT id, score, note, review, verified, code_url, created FROM ' . Data::t( 'aq_comp_subs' )
			. ' WHERE comp_id = %d AND uid = %d ORDER BY id DESC LIMIT 100',
			[ (int) $comp['id'], $uid ]
		);
		$best = null;
		foreach ( $rows as $r ) { $best = max( $best ?? -INF, (float) $r['score'] ); }
		return [ 'items' => array_map( static fn( $r ) => [
			'id'       => (int) $r['id'],
			'score'    => round( (float) $r['score'], 6 ),
			'best'     => $best !== null && abs( (float) $r['score'] - $best ) < 1e-12,
			'note'     => (string) $r['note'],
			'review'   => (string) ( $r['review'] ?? 'none' ),
			'verified' => (bool) ( $r['verified'] ?? 0 ),
			'code_url' => (string) ( $r['code_url'] ?? '' ),
			'created'  => $r['created'] ? (int) strtotime( $r['created'] . ' UTC' ) : 0,
		], $rows ) ];
	}

	/**
	 * GET competition/solutions?slug= — PUBLIC transparency over the adversarial solution reviews:
	 * every submission that entered review, with its author, claimed public score, review state,
	 * open code link and the reviewer's full report per round. Radical-transparency counterpart of
	 * the journal's public review reports (and Kaggle's winners' solution write-ups).
	 */
	public static function solutions( $req ) {
		$slug = sanitize_file_name( (string) Rest::p( $req, 'slug', '' ) );
		$comp = $slug ? Data::one( 'SELECT id, metric FROM ' . Data::t( 'aq_competitions' ) . ' WHERE slug = %s', [ $slug ] ) : null;
		if ( ! $comp ) { return Rest::err( 'not_found', 'Competition not found', 404 ); }
		// Chant boards are ranked by TIME (lower = better): measured entries first, fastest first,
		// then the still-measuring queue. Holdout boards keep the classic best-score-first order.
		$is_chant = in_array( (string) $comp['metric'], [ 'chant', 'artaverify' ], true );
		$order = $is_chant
			? 'ORDER BY verified DESC, CASE WHEN score > 0 THEN 0 ELSE 1 END ASC, score ASC'
			: 'ORDER BY verified DESC, score DESC';
		$rows = Data::all(
			'SELECT id, uid, score, code_url, method, review, review_round, verified, updated FROM ' . Data::t( 'aq_comp_subs' )
			. " WHERE comp_id = %d AND review != 'none' $order LIMIT 50",
			[ (int) $comp['id'] ]
		);
		$out = [];
		foreach ( $rows as $r ) {
			$reviews = Data::all(
				'SELECT round, verdict, verified, score, report, model, effort, runtime_s, created FROM '
				. Data::t( 'aq_comp_reviews' ) . ' WHERE sub_id = %d ORDER BY round ASC', [ (int) $r['id'] ]
			);
			$out[] = [
				'submission_id' => (int) $r['id'],
				'uid'           => (int) $r['uid'],
				'name'          => self::name_of( (int) $r['uid'] ),
				'slug'          => self::slug_of( (int) $r['uid'] ),
				'score'         => round( (float) $r['score'], 6 ),
				'code_url'      => (string) $r['code_url'],
				'method'        => mb_substr( (string) $r['method'], 0, 4000 ),
				'review'        => (string) $r['review'],
				'verified'      => (bool) $r['verified'],
				// Chant entries: the published per-language recordings (playable after measurement).
				'audio'         => $is_chant ? (object) self::chant_audio_map( (int) $r['id'] ) : (object) [],
				'rounds'        => array_map( static fn( $v ) => [
					'round'     => (int) $v['round'],
					'verdict'   => (string) $v['verdict'],
					'verified'  => (bool) $v['verified'],
					'score'     => round( (float) $v['score'], 2 ), // chant rounds carry seconds (decimals matter)
					'report'    => (string) $v['report'],
					'model'     => (string) $v['model'],
					'effort'    => (string) $v['effort'],
					'runtime_s' => (int) $v['runtime_s'],
					'created'   => $v['created'] ? (int) strtotime( $v['created'] . ' UTC' ) : 0,
				], $reviews ),
			];
		}
		return [ 'slug' => $slug, 'items' => $out ];
	}

	/** The signed-in caller's best submission's review state for a competition, or null. Drives the
	 *  "request verification" panel: which submission, its current review, and the last report. */
	private static function my_review( $cid ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return null; }
		$sub = Data::one(
			'SELECT id, score, review, review_round, verified FROM ' . Data::t( 'aq_comp_subs' )
			. ' WHERE comp_id = %d AND uid = %d ORDER BY score DESC, created ASC LIMIT 1',
			[ $cid, $uid ]
		);
		if ( ! $sub ) { return null; }
		$rev = Data::one(
			'SELECT verdict, score, report, model FROM ' . Data::t( 'aq_comp_reviews' )
			. ' WHERE sub_id = %d ORDER BY round DESC LIMIT 1', [ (int) $sub['id'] ]
		);
		return [
			'submission_id' => (int) $sub['id'],
			'score'         => round( (float) $sub['score'], 6 ),
			'review'        => (string) $sub['review'],       // none|submitted|reviewing|verified|flagged|revisions-requested
			'round'         => (int) $sub['review_round'],
			'max_rounds'    => self::REVIEW_MAX_ROUNDS,
			'verified'      => (bool) $sub['verified'],
			'last_report'   => $rev ? mb_substr( (string) $rev['report'], 0, 8000 ) : '',
			'last_verdict'  => $rev ? (string) $rev['verdict'] : '',
		];
	}

	/** The scoring explainer shown on the overview + returned so a client can echo it. */
	private static function evaluation_text( $row, $key_col = 'trend|date' ) {
		$m = strtolower( (string) $row['metric'] );
		if ( $m === 'phase-r2' ) {
			return "Predict each target series from the sky \xe2\x80\x94 a topic's worldwide search interest, or an "
				. 'anonymised world-event measure. Every series\' monthly rows are given JUST SHUFFLED: the 11 '
				. 'sidereal body phases (Sun, Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune, Pluto, '
				. 'Chiron and the lunar node, ecliptic longitude 0-360) and the target; no id, no phase column, '
				. 'no permutation. Train on the first 80% of the clean months; predict the LAST 20% '
				. "\xe2\x80\x94 a future holdout. Submit trend + the 11 body phases + target (a CSV matching "
				. 'sample_submission.csv, or a JSON list). The score is a 0-100 board of PLAIN '
				. "R\xc2\xb2: the scorer folds each row\xe2\x80\x99s 11 phases to their sky fingerprint (every phase "
				. "minus the Sun\xe2\x80\x99s), looks up the true target, and takes per-series R\xc2\xb2 clamped to "
				. "[0,1], averaged over the series \xc3\x97100 (100 = every series fit perfectly, 0 = no better than "
				. "predicting each series\xe2\x80\x99 mean). The reference baseline is ONE fixed model \xe2\x80\x94 "
				. "y = \xce\xa3 w_i\xc2\xb7sinc(f_i\xc2\xb7(x_i \xe2\x88\x92 p)) + b, a single CIRCULAR global phase p "
				. "(its 30\xc2\xb0 sector is the series\xe2\x80\x99 season of the year's cycle), NON-NEGATIVE per-body frequencies "
				. 'f_i and weights w_i, and a bias b, fit by gradient descent with 12 starts, one at each '
				. 'season centre, keeping the best. The MODEL CLASS is fixed, so the competition is to IMPROVE THE '
				. 'LEARNING ALGORITHM (a better fit of this same model). Every submission carries a public, '
				. "reproducible code link (a Colab notebook, gist or repo) \xe2\x80\x94 the competition is fully "
				. 'transparent. The live score is the PUBLIC half; the prize settles on the hidden PRIVATE half at '
				. 'the deadline; the leaderboard keeps your best submission. The atlas reports each '
				. "series\xe2\x80\x99 fitted phase p (\xe2\x86\x92 its season) and its per-body frequencies f_i.";
		}
		if ( $m === 'acc' ) {
			return 'Submissions are scored by AVERAGE MONTHLY ACCURACY on the holdout: for each held-out '
				. 'month, the share of topics whose high/low class you called correctly (the SIGN of your value — '
				. 'any positive number means "high", any other "low", so soft scores are welcome); your score is '
				. 'the plain average over the months. The holdout is the FUTURE, so your model must run '
				. 'autoregressively — it never sees an answer, and an unpredicted row counts as wrong. 1.0 is '
				. 'perfect, 0.5 is a coin flip. Scoring is fully public — the leaderboard score IS the final '
				. 'standing (where a competition declares no hidden split, the public board decides the prize). '
				. 'Submit predictions for every test row as JSON ({"' . $key_col
				. '": value, …}) or as a CSV body matching sample_submission.csv. The leaderboard keeps your '
				. 'best submission.';
		}
		if ( $m === 'r2' ) {
			return 'Submissions are scored by the coefficient of determination R² = 1 − SS_res/SS_tot on the '
				. 'hidden holdout, averaged across every target (targets with zero variance are skipped). Higher is '
				. 'better; 1.0 is a perfect fit, 0 matches predicting the mean, and a negative score is worse than '
				. 'the mean. Submit predictions for every test row as JSON ({"' . $key_col . '": value, …}) '
				. 'or as a CSV body matching sample_submission.csv. The leaderboard keeps your best submission.';
		}
		if ( in_array( $m, [ 'chant', 'artaverify' ], true ) ) {
			return 'Fully automated, no judge: your twelve law sentences are rendered into the 20 mesh languages by '
				. 'ArtaTranslate, spoken aloud by ArtaVoice, and your score is the TOTAL SPOKEN TIME in seconds across '
				. 'all 240 lines. Lowest time wins. Every translation and clip timing is public in Solutions; the '
				. 'leaderboard keeps your fastest measured entry.';
		}
		return 'Submissions are scored by ' . $row['metric'] . '. The leaderboard keeps your best submission.';
	}

	/** GET competition/leaderboard?slug= — best submission per member. Holdout metrics rank by score
	 *  DESC (higher R² wins); chant metrics rank by MEASURED seconds ASC (the shortest chant wins —
	 *  unmeasured entries, score 0, stay off the board until the relay times them). */
	public static function leaderboard( $req ) {
		$slug = sanitize_file_name( (string) Rest::p( $req, 'slug', '' ) );
		$comp = $slug ? Data::one( 'SELECT id, metric FROM ' . Data::t( 'aq_competitions' ) . ' WHERE slug = %s', [ $slug ] ) : null;
		if ( ! $comp ) { return Rest::err( 'not_found', 'Competition not found', 404 ); }
		$cid = (int) $comp['id'];
		$s   = Data::t( 'aq_comp_subs' );
		// Best-per-member: group the append-only submissions by uid. (comp_id, uid, score) covers it.
		$rows = in_array( (string) $comp['metric'], [ 'chant', 'artaverify' ], true )
			? Data::all(
				"SELECT uid, MIN(CASE WHEN score > 0 THEN score END) AS score, COUNT(*) AS n_subs, MAX(created) AS last, MAX(verified) AS verified,
				        (SELECT s2.code_url FROM $s s2 WHERE s2.comp_id = s.comp_id AND s2.uid = s.uid ORDER BY CASE WHEN s2.score>0 THEN 0 ELSE 1 END, s2.score ASC, s2.created ASC LIMIT 1) AS code_url
				   FROM $s s WHERE s.comp_id = %d GROUP BY uid HAVING score IS NOT NULL ORDER BY score ASC, last ASC",
				[ $cid ]
			)
			: Data::all(
				"SELECT uid, MAX(score) AS score, COUNT(*) AS n_subs, MAX(created) AS last, MAX(verified) AS verified,
				        (SELECT s2.code_url FROM $s s2 WHERE s2.comp_id = s.comp_id AND s2.uid = s.uid ORDER BY s2.score DESC, s2.created ASC LIMIT 1) AS code_url
				   FROM $s s WHERE s.comp_id = %d GROUP BY uid ORDER BY score DESC, last ASC",
				[ $cid ]
			);
		$bot  = (int) get_option( 'aq_artabot_uid', 0 );
		$out  = [];
		$rank = 0;
		foreach ( $rows as $r ) {
			$rank++;
			$uid    = (int) $r['uid'];
			$is_bot = ( $uid === $bot ) || (bool) get_user_meta( $uid, '_aq_is_bot', true );
			$out[]  = [
				'rank'     => $rank,
				'uid'      => $uid,
				'name'     => self::name_of( $uid ),
				'slug'     => self::slug_of( $uid ),
				'score'    => round( (float) $r['score'], 6 ),
				'n_subs'   => (int) $r['n_subs'],
				'bot'      => $is_bot, // bots stay on the board but are walled off from the coin prize (slot passes down)
				'verified' => (bool) ( $r['verified'] ?? 0 ), // a solution of theirs passed the adversarial review → prize-eligible
				'last'     => $r['last'] ? (int) strtotime( $r['last'] . ' UTC' ) : 0, // unix secs (relAgo)
				'code_url' => (string) ( $r['code_url'] ?? '' ), // the member's best submission's public reproducible-code link
			];
		}
		return [ 'slug' => $slug, 'items' => $out ];
	}

	/**
	 * GET competition/results?slug=&trend= — the LEADER's predictions plotted against the raw series
	 * for ONE topic: the clean months (raw + the sinc-GD baseline's fit) and the 12 future test months
	 * (raw vs the leader's predictions), plus this topic's fitted phase/sign + per-body frequencies.
	 * Powers the competition page's predicted-vs-raw charts (the FitChart pattern). Needs series.php.
	 *
	 * Openness note: while the competition is ACTIVE the test-month actuals returned are the PUBLIC
	 * holdout half only (the private half — the prize-deciding data — stays hidden until settlement).
	 * The public half is probeable through the live scorer anyway, and the prize is protected by the
	 * private-half settle + the ArtaCompete verified-solution gate.
	 */
	public static function results( $req ) {
		$slug = sanitize_file_name( (string) Rest::p( $req, 'slug', '' ) );
		$comp = $slug ? Data::one( 'SELECT * FROM ' . Data::t( 'aq_competitions' ) . ' WHERE slug = %s', [ $slug ] ) : null;
		if ( ! $comp ) { return Rest::err( 'not_found', 'Competition not found', 404 ); }
		$bundle = self::load_series_bundle( $slug );
		if ( ! $bundle ) { return Rest::err( 'no_results', 'This competition has no results bundle.', 404 ); }
		$topics = array_keys( (array) $bundle['topics'] );
		$trend  = sanitize_file_name( (string) Rest::p( $req, 'trend', '' ) );
		if ( $trend === '' || ! isset( $bundle['topics'][ $trend ] ) ) { $trend = (string) $topics[0]; }

		// The leader: the best public-score submission across all members (their preds carry the plot).
		$cid = (int) $comp['id'];
		$win = Data::one(
			'SELECT id, uid, score, preds, phase FROM ' . Data::t( 'aq_comp_subs' )
			. ' WHERE comp_id = %d ORDER BY score DESC, created ASC LIMIT 1',
			[ $cid ]
		);
		$closed = ( $comp['status'] !== 'active' )
			|| ( $comp['deadline'] && strtotime( $comp['deadline'] . ' UTC' ) < time() );

		// Serve from a short cache — decoding a 432k-key preds blob per request is the heavy part.
		// The payload is public-by-design (train actuals are in train.zip; test actuals only the
		// public half while active), so a public transient is fine here.
		$ck = 'aq_comp_results_' . md5( $slug . '|' . $trend . '|' . ( $win ? $win['id'] : 0 ) . '|' . ( $closed ? 1 : 0 ) );
		$hit = get_transient( $ck );
		if ( is_array( $hit ) ) { return $hit; }

		$t         = $bundle['topics'][ $trend ];
		$months    = explode( ',', (string) $bundle['months'] );
		$test_from = (int) $bundle['test_from'];
		$y         = array_map( 'floatval', explode( ',', (string) $t['y'] ) );
		$fit       = array_map( 'floatval', explode( ',', (string) $t['fit'] ) );
		// The 12 test months' sky FINGERPRINTS (month order) — the submission row key (each phase minus the
		// Sun's, a unique month key). "keys" is the new field; "ids" is the legacy alias.
		$fpkeys    = isset( $t['keys'] ) ? explode( ';', (string) $t['keys'] )
			: array_map( 'strval', explode( ',', (string) ( $t['ids'] ?? '' ) ) );

		// Test-month actuals: the public half only while the competition is live; everything after.
		$split  = self::load_split( $slug );
		$pubset = ( $split && ! empty( $split['public'] ) ) ? array_flip( array_map( 'strval', $split['public'] ) ) : null;
		$actual = [];
		foreach ( $y as $i => $v ) {
			if ( $i < $test_from ) { $actual[] = $v; continue; }
			$key      = $trend . '|' . ( $fpkeys[ $i - $test_from ] ?? '' );
			$actual[] = ( $closed || $pubset === null || isset( $pubset[ $key ] ) ) ? $v : null;
		}

		// The leader's per-month predictions for this topic (keyed "topic|fingerprint") — plotted against
		// the raw series over the holdout.
		$pred = array_fill( 0, count( $y ), null );
		if ( $win && $win['preds'] ) {
			$preds = self::decode_preds( $win['preds'] );
			if ( is_array( $preds ) ) {
				foreach ( $fpkeys as $j => $fp ) {
					$v = $preds[ $trend . '|' . $fp ] ?? null;
					if ( $v !== null ) { $pred[ $test_from + $j ] = round( (float) $v, 2 ); }
				}
			}
		}
		// THIS topic's fitted read-out: the baseline's global phase p (-> its 30-deg zodiac sign), its
		// per-body FREQUENCIES f_i (body order sun..node), and the baseline's holdout R^2. From the guarded
		// series bundle -- the fitted phase VARIES per topic, so the signs spread the zodiac.
		$freqs = isset( $t['freqs'] ) ? array_map( 'floatval', array_filter( explode( ',', (string) $t['freqs'] ), 'strlen' ) ) : [];
		$phase = [
			'sign'  => (string) ( $t['sign'] ?? '' ),
			'peak'  => (int) ( $t['peak'] ?? 0 ),           // the fitted global phase p (deg)
			'freqs' => array_values( $freqs ),              // per-body frequency f_i (sun..node order)
			'r2'    => round( (float) ( $t['r2'] ?? 0 ), 3 ), // the baseline's holdout R^2 for this topic
		];
		$dist_signs = [];
		foreach ( (array) $bundle['topics'] as $tp ) {
			$sg = (string) ( $tp['sign'] ?? '' );
			if ( $sg !== '' ) { $dist_signs[ $sg ] = ( $dist_signs[ $sg ] ?? 0 ) + 1; }
		}
		$out = [
			'slug'      => $slug,
			'trend'     => $trend,
			'topics'    => $topics,
			'months'    => $months,
			'test_from' => $test_from,
			'actual'    => $actual, // raw series — test actuals are the public half only while active
			'fit'       => array_map( static fn( $v ) => round( $v, 1 ), $fit ), // the sinc-GD baseline's fit over the clean months
			'pred'      => $pred,   // the leader's TEST predictions for the 12 future months
			'closed'    => (bool) $closed,
			'winner'    => $win ? [
				'uid'   => (int) $win['uid'],
				'name'  => self::name_of( (int) $win['uid'] ),
				'slug'  => self::slug_of( (int) $win['uid'] ),
				'score' => round( (float) $win['score'], 6 ),
			] : null,
			'phase'     => $phase,       // THIS topic's fitted phase p (-> zodiac sign) + per-body frequencies + R^2
			'sign_dist' => $dist_signs,  // the atlas: sign -> count across the 500 topics (a real distribution)
		];
		set_transient( $ck, $out, 900 );
		return $out;
	}

	// ── Writes ─────────────────────────────────────────────────────────────────

	/**
	 * POST competition/create {title, blurb, slug?, metric?, holdout?, dataset_dir?}.
	 *
	 * Opens a competition owned by the caller. The dataset is provisioned out-of-band (the generator
	 * writes uploads/competitions/<slug>/); `dataset_dir` may name a server-side directory ALREADY
	 * under uploads/competitions/ whose files (train/test/sample_submission + solution.json) back this
	 * competition — the row's n_* stats are then read from that directory. No file upload here.
	 */
	public static function create( $req ) {
		if ( Rest::throttle( 'comp_create', 10, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid   = Rest::uid();
		$title = sanitize_text_field( (string) Rest::p( $req, 'title', '' ) );
		$blurb = wp_kses_post( (string) Rest::p( $req, 'blurb', '' ) );
		if ( $title === '' ) { return Rest::err( 'no_title', 'A competition needs a title.' ); }
		$slug = sanitize_title( (string) Rest::p( $req, 'slug', '' ) );
		if ( $slug === '' ) { $slug = sanitize_title( $title ); }
		if ( $slug === '' ) { return Rest::err( 'bad_slug', 'Could not derive a slug from the title.' ); }
		if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_competitions' ) . ' WHERE slug = %s', [ $slug ] ) ) {
			return Rest::err( 'slug_taken', 'A competition with that slug already exists.' );
		}
		$metric  = sanitize_key( (string) Rest::p( $req, 'metric', 'r2' ) ) ?: 'r2';
		$holdout = sanitize_text_field( (string) Rest::p( $req, 'holdout', '' ) );

		// The dataset directory is a server-side path already under uploads/competitions/. Accept a bare
		// slug/name only (sanitize_file_name blocks traversal), and default it to the competition slug.
		$ds = sanitize_file_name( (string) Rest::p( $req, 'dataset_dir', '' ) );
		if ( $ds === '' ) { $ds = $slug; }
		$stats = self::dataset_stats( $ds );

		// THE DATASET IS A WORK (2026-07-10, dataset/model split): hosting a dataset costs ₳2 —
		// the same publish-fee discipline as every studio work — and that fee SEEDS the dataset's
		// own model-challenge pool (`revenue` starts at the fee). New competitions charge
		// ₳ENTRY_FEE per model submission (burned → revenue); settlement pays
		// prize + the full entry-fee revenue. Operators host platform datasets free (seeds/flagships).
		$create_fee = user_can( $uid, 'manage_options' ) ? 0 : self::DATASET_FEE;
		if ( $create_fee > 0 ) {
			$bal = Economy::coin_balance( $uid );
			if ( $bal < $create_fee ) {
				return Rest::err( 'insufficient', 'Hosting a dataset costs ₳' . $create_fee . ' — you have ₳' . $bal . '.', 402 );
			}
		}

		$now = current_time( 'mysql', true );
		$deadline = gmdate( 'Y-m-d H:i:s', time() + 30 * DAY_IN_SECONDS );
		$id = Data::insert( 'aq_competitions', [
			'slug'       => $slug,
			'title'      => $title,
			'owner_uid'  => $uid,
			'blurb'      => $blurb,
			'metric'     => $metric,
			'holdout'    => $holdout,
			'status'     => 'active',
			'n_train'    => (int) $stats['n_train'],
			'n_test'     => (int) $stats['n_test'],
			'n_features' => (int) $stats['n_features'],
			'n_targets'  => (int) $stats['n_targets'],
			'entry_fee'  => self::ENTRY_FEE,
			'revenue'    => $create_fee,
			'created'    => $now,
			'deadline'   => $deadline,
		] );
		if ( ! $id ) { return Rest::err( 'failed', 'Could not create the competition', 500 ); }
		if ( $create_fee > 0 ) {
			$ref = 'comp:' . (int) $id;
			// The fee is burned and FULLY BACKS the pool this competition re-mints at settlement, so a
			// fee that never landed leaves the payout unbacked. The balance check above is a plain
			// read; Economy::spend holds the wallet lock across the check and the debit.
			$paid = Economy::spend( $uid, $create_fee, 'publish', $ref );
			if ( $paid !== '' ) {
				global $wpdb;
				$wpdb->delete( Data::t( 'aq_competitions' ), [ 'id' => (int) $id ] ); // unpaid → never hosted
				return Economy::spend_error( $paid, $create_fee, 'Hosting a dataset' );
			}
			Economy::content_points( $uid, $create_fee, $ref );           // a dataset is a creation like any other
		}
		// A hosted dataset enters the season's DATASET Challenge (the unified challenge frame —
		// hearts pick the best dataset while its own metric arena runs). The hosting fee joins
		// that challenge's pot; idempotent inside enter(). Fail-open.
		if ( class_exists( '\\AQ\\Challenges' ) ) {
			try { Challenges::enter( 'dataset', (int) $id, $uid, (int) $create_fee ); } catch ( \Throwable $e ) {}
		}
		return [ 'ok' => true, 'id' => $id, 'slug' => $slug ];
	}

	/** Derive n_train/n_test/n_features/n_targets for a dataset. Prefers the authoritative stats.json
	 *  the generator ships (cheap + exact — no scanning a multi-file train.zip); falls back to counting
	 *  the public files when a count is missing. */
	private static function dataset_stats( $ds ) {
		$dir  = self::dir( $ds );
		$out  = [ 'n_train' => 0, 'n_test' => 0, 'n_features' => 0, 'n_targets' => 0 ];
		// 1) Trust the generator's stats.json when present (authoritative; avoids scanning train.zip).
		if ( is_file( $dir . '/stats.json' ) ) {
			$s = json_decode( (string) file_get_contents( $dir . '/stats.json' ), true );
			if ( is_array( $s ) ) {
				foreach ( [ 'n_train', 'n_test', 'n_features', 'n_targets' ] as $k ) {
					if ( isset( $s[ $k ] ) && is_numeric( $s[ $k ] ) ) { $out[ $k ] = (int) $s[ $k ]; }
				}
			}
		}
		$rows = function ( $f ) {
			if ( ! is_file( $f ) ) { return 0; }
			$n = 0;
			$h = fopen( $f, 'r' );
			if ( ! $h ) { return 0; }
			while ( fgets( $h ) !== false ) { $n++; }
			fclose( $h );
			return max( 0, $n - 1 ); // minus the header row
		};
		// 2) Fall back to counting the flat public files only where stats.json didn't supply a value.
		if ( ! $out['n_train'] ) { $out['n_train'] = $rows( $dir . '/train.csv' ); }
		if ( ! $out['n_test'] )  { $out['n_test']  = $rows( $dir . '/test.csv' ); }
		if ( ! $out['n_targets'] ) {
			$j = self::load_solution( $ds );                    // the guarded holdout map (never a public file)
			if ( is_array( $j ) ) {
				// solution is { "trend|id": true_target }; distinct trends = n_targets. Keys without a
				// "|" are opaque row ids — they all share ONE target (mirrors r2_over_holdout's grouping).
				$trends = [];
				foreach ( array_keys( $j ) as $k ) {
					$k = (string) $k;
					$trends[ strpos( $k, '|' ) !== false ? explode( '|', $k )[0] : '' ] = 1;
				}
				$out['n_targets'] = count( $trends );
			}
		}
		if ( ! $out['n_features'] ) {
			// n_features = the feature columns of test.csv (all but the key columns id/trend/date).
			$hdr = self::csv_header( $dir . '/test.csv' );
			if ( $hdr ) {
				$out['n_features'] = count( array_values( array_diff( $hdr, [ 'id', 'trend', 'phase', 'shift', 'date', 'target' ] ) ) );
			}
		}
		return $out;
	}

	/** Read a CSV file's header row as an array of column names, or null. */
	private static function csv_header( $f ) {
		if ( ! is_file( $f ) ) { return null; }
		$h = fopen( $f, 'r' );
		if ( ! $h ) { return null; }
		$row = fgetcsv( $h );
		fclose( $h );
		return is_array( $row ) ? array_map( 'trim', $row ) : null;
	}

	/**
	 * POST competition/submit?slug= — score a set of predictions against the hidden holdout.
	 *
	 * The holdout true targets are read from the server-only solution.json (never the DB). Predictions
	 * arrive as JSON in one of two shapes, or as a raw CSV body:
	 *   1. { "trend|date": predicted_value, … }             — the natural, self-keyed form.
	 *   2. { "trend": [values in test-row order], … }        — per-target arrays (aligned to test.csv).
	 *   3. CSV body: header row incl. trend,date,target       — like sample_submission.csv.
	 * Scored by R² per target then averaged across targets (targets with zero variance skipped). Every
	 * submission is stored; {score, rank, best} is returned.
	 */
	public static function submit( $req ) {
		// Two windows: a burst limit AND a generous daily cap. The daily cap is defence-in-depth
		// against leaderboard-probing (with the public/private split below, probing the public score
		// can't reveal the prized private half anyway — but a hard cap keeps the oracle bounded).
		if ( Rest::throttle( 'comp_submit', 30, 600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		if ( Rest::throttle( 'comp_submit_day', 60, 86400 ) ) { return Rest::err( 'rate_limited', "You\xe2\x80\x99ve hit today's submission limit — try again tomorrow.", 429 ); }
		$uid  = Rest::uid();
		$slug = sanitize_file_name( (string) Rest::p( $req, 'slug', '' ) );
		$comp = $slug ? Data::one( 'SELECT * FROM ' . Data::t( 'aq_competitions' ) . ' WHERE slug = %s', [ $slug ] ) : null;
		if ( ! $comp ) { return Rest::err( 'not_found', 'Competition not found', 404 ); }
		if ( $comp['status'] !== 'active' ) { return Rest::err( 'closed', 'This competition is closed.' ); }
		if ( $comp['deadline'] && strtotime( $comp['deadline'] . ' UTC' ) < time() ) {
			return Rest::err( 'closed', 'The deadline has passed.' );
		}
		// C-to-C entry fee (2026-07-10): competitions opened from today charge ₳entry_fee per
		// submission — burned into reserve and accumulated as the pool's `revenue` (settlement pays
		// prize + all of it back to the podium). Legacy/live competitions have entry_fee 0 and stay
		// free. Refuse BEFORE any scoring work; the charge lands after the row inserts (ref-tied to
		// the submission id, so a crash between insert and charge costs the member nothing).
		$entry_fee = (int) ( $comp['entry_fee'] ?? 0 );
		if ( $entry_fee > 0 ) {
			$bal = Economy::coin_balance( $uid );
			if ( $bal < $entry_fee ) {
				return Rest::err( 'insufficient', 'A submission on this board costs ₳' . $entry_fee . ' (it joins the prize pool) — you have ₳' . $bal . '.', 402 );
			}
		}

		// CHANT competitions (metric 'chant'; 'artaverify' kept as a legacy alias): the entry is TWELVE
		// LAW SENTENCES — the chants — nothing else. No judge is involved. The measurement is fully
		// automated and objective: the chant relay renders all twelve chants into the mesh's 20
		// languages (ArtaTranslate), speaks all 240 lines aloud (ArtaVoice / Edge neural TTS), and the
		// TOTAL SPOKEN TIME in seconds becomes the submission's score — LOWEST time wins the board.
		// Every translation and every clip timing is published in the round report (Solutions).
		if ( in_array( (string) $comp['metric'], [ 'chant', 'artaverify' ], true ) ) {
			// Chants arrive as a JSON array of 12 strings (the form's 12 boxes), as 12 lines in a
			// 'laws' field, or as 12 non-empty lines in the entry/file/raw body (CLI ease).
			$laws_in = Rest::p( $req, 'laws', [] );
			if ( is_string( $laws_in ) ) { $laws_in = preg_split( '/[\n\r]+/', $laws_in ); }
			$laws = [];
			foreach ( ( is_array( $laws_in ) ? $laws_in : [] ) as $l ) {
				$l = trim( sanitize_text_field( (string) $l ) );
				if ( $l !== '' ) { $laws[] = mb_substr( $l, 0, 90 ); }
			}
			if ( ! $laws ) {
				$entry = (string) Rest::p( $req, 'entry', '' );
				if ( $entry === '' && isset( $_FILES['file'] ) && is_uploaded_file( (string) ( $_FILES['file']['tmp_name'] ?? '' ) ) ) {
					$entry = (string) file_get_contents( (string) $_FILES['file']['tmp_name'] );
				}
				if ( $entry === '' ) { $entry = (string) $req->get_body(); }
				$entry = trim( (string) wp_check_invalid_utf8( $entry, true ) );
				foreach ( preg_split( '/[\n\r]+/', $entry ) as $l ) {
					$l = trim( sanitize_text_field( $l ) );
					if ( $l !== '' ) { $laws[] = mb_substr( preg_replace( '/^\s*\d+[.)]\s*/', '', $l ), 0, 90 ); }
				}
			}
			if ( count( $laws ) !== 12 ) {
				return Rest::err( 'bad_entry', 'Write exactly TWELVE law sentences — got ' . count( $laws ) . '.' );
			}
			foreach ( $laws as $i => $l ) {
				if ( str_word_count( preg_replace( '/[^A-Za-z\' ]/u', ' ', $l ) ) < 2 && mb_strlen( $l ) < 8 ) {
					return Rest::err( 'bad_entry', 'Law ' . ( $i + 1 ) . ' is not a sentence — each law needs at least two words.' );
				}
			}
			$method = "THE TWELVE CHANTS:\n";
			foreach ( $laws as $i => $l ) { $method .= ( $i + 1 ) . '. ' . $l . "\n"; }
			$sid = Data::insert( 'aq_comp_subs', [
				'comp_id' => (int) $comp['id'],
				'uid'     => $uid,
				'note'    => sanitize_text_field( (string) Rest::p( $req, 'note', '' ) ),
				'score'   => 0,
				'preds'   => wp_json_encode( $laws ), // the chant relay reads the laws from here
				'method'  => trim( $method ),
				'review'  => 'submitted',
				'place'   => 0,
				'created' => current_time( 'mysql', true ),
				'updated' => current_time( 'mysql', true ),
			] );
			if ( ! $sid ) { return Rest::err( 'failed', 'Could not store the entry', 500 ); }
			self::charge_submission( $comp, $uid, (int) $sid );
			return [ 'ok' => true, 'submission_id' => (int) $sid, 'review' => 'submitted', 'laws' => $laws,
				'message' => 'Entry received — the machines take over now. ArtaTranslate renders your twelve chants in all 20 languages, ArtaVoice speaks all 240 lines, and your total spoken time lands on the board. Lowest time wins; every translation and timing will be public in Solutions.' ];
		}

		// Every predictive submission must ship a PUBLIC, reproducible code link (Colab/notebook/repo) — the
		// competition is fully transparent (operator 2026-07-07), like ArtaScience. Rejected without it.
		$code_url = esc_url_raw( trim( (string) Rest::p( $req, 'code_url', '' ) ) );
		if ( ! preg_match( '#^https?://#i', $code_url ) ) {
			return Rest::err( 'no_code', 'A public link to your reproducible code (a Colab notebook, gist or repo) is required on every submission.' );
		}
		$code_url = mb_substr( $code_url, 0, 300 );

		$solution = self::load_solution( $slug );
		if ( ! $solution ) { return Rest::err( 'no_solution', 'This competition has no scoring data.', 500 ); }

		// Sky competitions (metric 'phase-r2', e.g. topic-500) parse + fold the 11 phases themselves
		// (no id/phase key), scoring plain R² by the Sun-relative sky fingerprint.
		if ( (string) $comp['metric'] === 'phase-r2' ) {
			return self::submit_detimed( $comp, $uid, $solution, $req, sanitize_text_field( (string) Rest::p( $req, 'note', '' ) ), $code_url );
		}

		$preds = self::parse_predictions( $req );
		if ( $preds === null ) { return Rest::err( 'bad_payload', 'Could not parse the predictions. Send JSON {"id": value} / {"trend|date": value} or a CSV body.' ); }
		if ( ! $preds ) { return Rest::err( 'empty', 'No predictions received.' ); }

		// PUBLIC leaderboard = R² over the PUBLIC holdout half (the private half is never scored here,
		// so the returned score can't reconstruct the prize-deciding answers). No split → whole holdout.
		$split  = self::load_split( $slug );
		$public = ( $split && ! empty( $split['public'] ) ) ? array_intersect_key( $solution, array_flip( array_map( 'strval', $split['public'] ) ) ) : $solution;
		$score  = ( (string) $comp['metric'] === 'acc' )
			? self::acc_over_holdout( $public, $preds )
			: self::r2_over_holdout( $public, $preds );
		if ( $score === null ) { return Rest::err( 'no_overlap', 'None of your predictions matched a holdout row. Predict every row in test.csv.' ); }

		$note = sanitize_text_field( (string) Rest::p( $req, 'note', '' ) );
		// Keep only the holdout-row predictions (bounds the stored blob). These are the member's OWN
		// guesses (not the answers), so they are public like every row — and let settle() re-score the
		// private half at the deadline without a live private-oracle. Capped so a giant body can't bloat.
		$keep = array_intersect_key( $preds, $solution );
		$blob = wp_json_encode( array_map( fn( $v ) => round( (float) $v, 4 ), $keep ) );
		if ( strlen( (string) $blob ) > 4000000 ) { $blob = null; } // pathological — skip the store, still scored
		$sid = Data::insert( 'aq_comp_subs', [
			'comp_id' => (int) $comp['id'],
			'uid'     => $uid,
			'note'     => $note,
			'code_url' => $code_url,
			'score'    => (float) $score,
			'preds'    => $blob,
			'place'   => 0,
			'created' => current_time( 'mysql', true ),
		] );
		self::charge_submission( $comp, $uid, (int) $sid );

		// Recompute this member's best + their live rank on the best-per-member board. Compare scores
		// entirely in SQL (against a subquery of the member's own MAX) — never round-trip the float
		// through %f, which truncates to 6 dp and would count the member ahead of themselves.
		$subs = Data::t( 'aq_comp_subs' );
		$best = (float) Data::col( "SELECT MAX(score) FROM $subs WHERE comp_id = %d AND uid = %d", [ (int) $comp['id'], $uid ] );
		$ahead = (int) Data::col(
			"SELECT COUNT(*) FROM ( SELECT uid, MAX(score) m FROM $subs WHERE comp_id = %d GROUP BY uid ) t"
			. " WHERE t.m > ( SELECT MAX(score) FROM $subs WHERE comp_id = %d AND uid = %d )",
			[ (int) $comp['id'], (int) $comp['id'], $uid ]
		);
		$rank = $ahead + 1;
		return [
			'ok'    => true,
			'score' => round( (float) $score, 6 ),
			'best'  => round( $best, 6 ),
			'rank'  => $rank,
		];
	}

	// ── Adversarial solution review (the ArtaScience mirror) ────────────────────
	//
	// The public leaderboard is open + instant to everyone. To WIN THE PRIZE a member must submit their
	// SOLUTION (open code + a method write-up) for adversarial review: the ArtaCompete relay clones + RUNS
	// the code against the public data, confirms the leaderboard score reproduces, and probes for holdout
	// leakage / hardcoded answers. Only a VERIFIED solution is eligible for the coin podium at settlement.

	const REVIEW_MAX_ROUNDS = 4;

	/**
	 * POST competition/verify?slug= { submission_id?, code_url, method }. Attach open code + a method
	 * write-up to a submission (defaults to the member's best-scoring one) and put it in the review
	 * queue. Re-submittable after a revise verdict. Rate-limited.
	 */
	public static function request_review( $req ) {
		if ( Rest::throttle( 'comp_verify', 10, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = Rest::uid();
		$slug = sanitize_file_name( (string) Rest::p( $req, 'slug', '' ) );
		$comp = $slug ? Data::one( 'SELECT * FROM ' . Data::t( 'aq_competitions' ) . ' WHERE slug = %s', [ $slug ] ) : null;
		if ( ! $comp ) { return Rest::err( 'not_found', 'Competition not found', 404 ); }
		$code = esc_url_raw( trim( (string) Rest::p( $req, 'code_url', '' ) ) );
		$method = sanitize_textarea_field( (string) Rest::p( $req, 'method', '' ) );
		if ( ! preg_match( '#^https?://#i', $code ) ) { return Rest::err( 'no_code', 'A public URL to your open code is required — the reviewer runs it.' ); }
		if ( mb_strlen( $method ) < 40 ) { return Rest::err( 'no_method', 'Describe your method (at least 40 characters) so the reviewer can check the code matches it.' ); }

		$sid = (int) Rest::p( $req, 'submission_id', 0 );
		if ( $sid ) {
			$sub = Data::one( 'SELECT * FROM ' . Data::t( 'aq_comp_subs' ) . ' WHERE id = %d AND comp_id = %d AND uid = %d', [ $sid, (int) $comp['id'], $uid ] );
		} else {
			// Default to the member's best-scoring submission (the one that defines their board position).
			$sub = Data::one(
				'SELECT * FROM ' . Data::t( 'aq_comp_subs' ) . ' WHERE comp_id = %d AND uid = %d ORDER BY score DESC, created ASC LIMIT 1',
				[ (int) $comp['id'], $uid ]
			);
		}
		if ( ! $sub ) { return Rest::err( 'no_sub', 'Make a scored submission first, then submit your solution for review.' ); }
		if ( in_array( $sub['review'], [ 'submitted', 'reviewing' ], true ) ) { return Rest::err( 'in_review', 'This solution is already in the review queue.' ); }
		if ( $sub['review'] === 'verified' ) { return Rest::err( 'done', 'This solution is already verified.' ); }
		if ( (int) $sub['review_round'] >= self::REVIEW_MAX_ROUNDS ) { return Rest::err( 'max_rounds', 'This solution has used all its review rounds.' ); }

		Data::update( 'aq_comp_subs', [
			'code_url'     => mb_substr( $code, 0, 300 ),
			'method'       => mb_substr( $method, 0, 20000 ),
			'review'       => 'submitted',
			'review_round' => (int) $sub['review_round'] + 1,
			'updated'      => current_time( 'mysql', true ),
		], [ 'id' => (int) $sub['id'] ] );
		return [ 'ok' => true, 'submission_id' => (int) $sub['id'], 'review' => 'submitted', 'round' => (int) $sub['review_round'] + 1 ];
	}

	/** POST relay/compete/poll — the ArtaCompete daemon claims the oldest queued review (atomic UPDATE
	 *  lock, orphan reclaim after 2h), and gets everything it needs to run the review offline. */
	public static function review_poll( $req ) {
		set_transient( 'aq_compete_beat', time(), 120 );
		global $wpdb;
		$subs = Data::t( 'aq_comp_subs' );
		if ( ! get_transient( 'aq_compete_reclaim' ) ) {
			set_transient( 'aq_compete_reclaim', 1, 60 );
			// Orphan reclaim for CODE reviews only — chant rows belong to the chant relay's sweep
			// (this poller runs concurrently with a chant measurement and must never reset one).
			$wpdb->query( $wpdb->prepare(
				"UPDATE $subs SET review = 'submitted' WHERE review = 'reviewing' AND updated < %s
				    AND comp_id IN ( SELECT id FROM " . Data::t( 'aq_competitions' ) . " WHERE metric NOT IN ('chant','artaverify') )",
				gmdate( 'Y-m-d H:i:s', time() - 7200 )
			) );
		}
		// Chant entries are measured by the chant relay (chant_poll below), never code-reviewed here.
		$row = Data::one(
			"SELECT s.* FROM $subs s JOIN " . Data::t( 'aq_competitions' ) . " c ON c.id = s.comp_id
			  WHERE s.review = 'submitted' AND c.metric NOT IN ('chant','artaverify') ORDER BY s.id ASC LIMIT 1"
		);
		if ( ! $row ) { return [ 'job' => null ]; }
		$got = Data::update( 'aq_comp_subs', [ 'review' => 'reviewing', 'updated' => current_time( 'mysql', true ) ], [ 'id' => (int) $row['id'], 'review' => 'submitted' ] );
		if ( ! $got ) { return [ 'job' => null ]; } // lost the race
		$comp = Data::one( 'SELECT * FROM ' . Data::t( 'aq_competitions' ) . ' WHERE id = %d', [ (int) $row['comp_id'] ] );
		if ( ! $comp ) { return [ 'job' => null ]; }
		$base = self::base_url( $comp['slug'] );
		$dir  = self::dir( $comp['slug'] );
		$file = fn( $n ) => is_file( $dir . '/' . $n ) ? $base . '/' . $n : null;
		$hdr  = self::csv_header( $dir . '/test.csv' );
		$has  = fn( $c ) => $hdr && in_array( $c, $hdr, true );
		$phcol = $has( 'phase' ) ? 'phase' : ( $has( 'shift' ) ? 'shift' : '' );
		$is_sky = $has( 'trend' ) && $has( 'sun' ) && $has( 'node' ) && ! $has( 'id' ) && $phcol === '';
		$key_col = $is_sky ? 'trend|sky'
			: ( ( $phcol && $has( 'trend' ) && $has( 'id' ) ) ? ( $phcol . '|trend|id' )
			: ( ( $has( 'trend' ) && $has( 'id' ) ) ? 'trend|id' : ( $has( 'id' ) ? 'id' : 'trend|date' ) ) );
		$prior = Data::all( 'SELECT round, verdict, verified, score, report FROM ' . Data::t( 'aq_comp_reviews' ) . ' WHERE sub_id = %d ORDER BY round ASC', [ (int) $row['id'] ] );
		$au = get_userdata( (int) $row['uid'] );
		return [ 'job' => [
			'sub_id'        => (int) $row['id'],
			'round'         => (int) $row['review_round'],
			'max_rounds'    => self::REVIEW_MAX_ROUNDS,
			'competition'   => $comp['slug'],
			'title'         => (string) $comp['title'],
			'blurb'         => (string) $comp['blurb'],
			'metric'        => (string) $comp['metric'],
			'key_col'       => $key_col,
			'author'        => $au ? $au->display_name : '',
			'claimed_score' => round( (float) $row['score'], 6 ),      // the PUBLIC-half R² they are on the board with
			'code_url'      => (string) $row['code_url'],
			'method'        => (string) $row['method'],
			'data'          => [
				'train'             => $file( 'train.csv' ) ?: $file( 'train.zip' ),
				'test'              => $file( 'test.csv' ),
				'sample_submission' => $file( 'sample_submission.csv' ),
			],
			'prior'         => array_map( fn( $r ) => [ 'round' => (int) $r['round'], 'verdict' => (string) $r['verdict'],
				'verified' => (bool) $r['verified'], 'score' => (int) $r['score'], 'report' => mb_substr( (string) $r['report'], 0, 6000 ) ], $prior ),
		] ];
	}

	/**
	 * POST relay/compete/complete { sub_id, verdict, verified, score, report, model, effort, runtime_s }.
	 * verdict ∈ verify|revise|reject. `verify` requires verified=true (the code reproduced the score with
	 * no leakage). Idempotent per (sub_id, round). Sets the submission's review state; a verified solution
	 * is prize-eligible at settlement.
	 */
	public static function review_complete( $req ) {
		$sid = (int) Rest::p( $req, 'sub_id', 0 );
		$row = $sid ? Data::one( 'SELECT * FROM ' . Data::t( 'aq_comp_subs' ) . ' WHERE id = %d', [ $sid ] ) : null;
		if ( ! $row ) { return Rest::err( 'not_found', 'Submission not found', 404 ); }
		if ( $row['review'] !== 'reviewing' ) { return [ 'ok' => true, 'note' => 'not in review' ]; }
		$round = (int) $row['review_round'];
		if ( Data::one( 'SELECT id FROM ' . Data::t( 'aq_comp_reviews' ) . ' WHERE sub_id = %d AND round = %d', [ $sid, $round ] ) ) {
			return [ 'ok' => true, 'note' => 'round already recorded' ];
		}
		$verdict = in_array( Rest::p( $req, 'verdict', 'revise' ), [ 'verify', 'revise', 'reject' ], true ) ? (string) Rest::p( $req, 'verdict', 'revise' ) : 'revise';
		$verified = ! empty( Rest::p( $req, 'verified', false ) ) ? 1 : 0;
		if ( $verdict === 'verify' && ! $verified ) { $verdict = 'revise'; }      // never verify what didn't reproduce
		if ( $verdict === 'revise' && $round >= self::REVIEW_MAX_ROUNDS ) { $verdict = 'reject'; }
		$score = max( 0, min( 100, (int) Rest::p( $req, 'score', 0 ) ) );
		Data::insert( 'aq_comp_reviews', [
			'sub_id'    => $sid,
			'round'     => $round,
			'verdict'   => $verdict,
			'verified'  => $verdict === 'verify' ? 1 : 0,
			'score'     => $score,
			'report'    => (string) Rest::p( $req, 'report', '' ),
			'model'     => mb_substr( sanitize_text_field( (string) Rest::p( $req, 'model', '' ) ), 0, 60 ),
			'effort'    => mb_substr( sanitize_text_field( (string) Rest::p( $req, 'effort', '' ) ), 0, 20 ),
			'runtime_s' => max( 0, (int) Rest::p( $req, 'runtime_s', 0 ) ),
			'created'   => current_time( 'mysql', true ),
		] );
		$state = $verdict === 'verify' ? 'verified' : ( $verdict === 'reject' ? 'flagged' : 'revisions-requested' );
		Data::update( 'aq_comp_subs', [ 'review' => $state, 'verified' => $verdict === 'verify' ? 1 : 0, 'updated' => current_time( 'mysql', true ) ], [ 'id' => $sid ] );
		// A verified model enters the season's MODEL Challenge (the unified challenge frame — a
		// hearts leaderboard beside its dataset's metric board). No extra fee (the submission fee
		// already funded its dataset's pool); idempotent inside enter(). Fail-open.
		if ( $verdict === 'verify' && class_exists( '\\AQ\\Challenges' ) ) {
			try { Challenges::enter( 'model', (int) $sid, (int) $row['uid'], 0 ); } catch ( \Throwable $e ) {}
		}
		if ( class_exists( '\\AQ\\Notify' ) && method_exists( '\\AQ\\Notify', 'push' ) ) {
			$msg = $verdict === 'verify' ? 'Your competition solution was verified — you are prize-eligible'
				: ( $verdict === 'reject' ? 'Your competition solution was flagged in review'
				: 'Your competition solution needs revisions' );
			@Notify::push( (int) $row['uid'], 'comp_review', $msg, '', '/competition/', 'compreview:' . $sid . ':' . $round );
		}
		return [ 'ok' => true, 'verdict' => $verdict, 'review' => $state ];
	}

	/** POST relay/compete/release { sub_id } — the daemon hands a claimed review back on shutdown. */
	public static function review_release( $req ) {
		$sid = (int) Rest::p( $req, 'sub_id', 0 );
		if ( $sid ) { Data::update( 'aq_comp_subs', [ 'review' => 'submitted', 'updated' => current_time( 'mysql', true ) ], [ 'id' => $sid, 'review' => 'reviewing' ] ); }
		return [ 'ok' => true ];
	}

	// ── Chant measurement (the automated ArtaTranslate → ArtaVoice pipeline) ──────

	/** POST relay/chant/poll — the chant relay claims the oldest unmeasured chant entry (atomic claim,
	 *  orphan reclaim after 2h) and gets the twelve law sentences to translate + speak + time. */
	public static function chant_poll( $req ) {
		set_transient( 'aq_chant_beat', time(), 300 );
		global $wpdb;
		$subs  = Data::t( 'aq_comp_subs' );
		$comps = Data::t( 'aq_competitions' );
		if ( ! get_transient( 'aq_chant_reclaim' ) ) {
			set_transient( 'aq_chant_reclaim', 1, 60 );
			$wpdb->query( $wpdb->prepare(
				"UPDATE $subs SET review = 'submitted' WHERE review = 'reviewing' AND updated < %s
				    AND comp_id IN ( SELECT id FROM $comps WHERE metric IN ('chant','artaverify') )",
				gmdate( 'Y-m-d H:i:s', time() - 7200 )
			) );
		}
		$row = Data::one(
			"SELECT s.*, c.slug AS comp_slug, c.title AS comp_title FROM $subs s JOIN $comps c ON c.id = s.comp_id
			  WHERE s.review = 'submitted' AND c.metric IN ('chant','artaverify') ORDER BY s.id ASC LIMIT 1"
		);
		if ( ! $row ) { return [ 'job' => null ]; }
		$got = Data::update( 'aq_comp_subs', [ 'review' => 'reviewing', 'updated' => current_time( 'mysql', true ) ], [ 'id' => (int) $row['id'], 'review' => 'submitted' ] );
		if ( ! $got ) { return [ 'job' => null ]; } // lost the race
		$laws = json_decode( (string) $row['preds'], true );
		if ( ! is_array( $laws ) || count( $laws ) !== 12 ) {
			// Legacy rows (pre-chant formats) keep their laws only in the method text — salvage the
			// 12 sentences from numbered lines or ·-separated ring lines; else park the row as flagged.
			$laws = [];
			foreach ( preg_split( '/[\n\r]+/', (string) $row['method'] ) as $line ) {
				$line = trim( $line );
				if ( $line === '' || stripos( $line, 'TOOLS' ) === 0 || stripos( $line, 'THE TWELVE' ) === 0 ) { continue; }
				$line = preg_replace( '/^Ring[^:]*:\s*/i', '', $line );
				foreach ( preg_split( '/\s*·\s*/u', $line ) as $seg ) {
					$seg = trim( preg_replace( '/^\s*\d+[.)]\s*/', '', $seg ) );
					if ( $seg !== '' ) { $laws[] = $seg; }
				}
			}
			if ( count( $laws ) !== 12 ) {
				Data::update( 'aq_comp_subs', [ 'review' => 'flagged', 'updated' => current_time( 'mysql', true ) ], [ 'id' => (int) $row['id'] ] );
				return [ 'job' => null ];
			}
		}
		return [ 'job' => [
			'sub_id'      => (int) $row['id'],
			'competition' => (string) $row['comp_slug'],
			'title'       => (string) $row['comp_title'],
			'author'      => self::name_of( (int) $row['uid'] ),
			'laws'        => array_values( array_map( 'strval', $laws ) ),
		] ];
	}

	/**
	 * POST relay/chant/complete { sub_id, seconds, report, model, runtime_s }.
	 * The relay measured the entry: `seconds` = total spoken duration of all 12 chants × 20 languages
	 * (ArtaVoice clips), `report` = the full public per-language table (every translation + timing).
	 * Sets the board score (LOWER is better on chant boards) and marks the entry measured/verified.
	 */
	public static function chant_complete( $req ) {
		$sid = (int) Rest::p( $req, 'sub_id', 0 );
		$row = $sid ? Data::one( 'SELECT * FROM ' . Data::t( 'aq_comp_subs' ) . ' WHERE id = %d', [ $sid ] ) : null;
		if ( ! $row ) { return Rest::err( 'not_found', 'Submission not found', 404 ); }
		// A measurement is valid even if a sweep re-queued the row mid-pipeline ('submitted'); only an
		// already-measured entry is refused (idempotence — the relay may retry a lost response).
		if ( ! in_array( $row['review'], [ 'reviewing', 'submitted' ], true ) ) { return [ 'ok' => true, 'note' => 'already measured' ]; }
		$sec = round( (float) Rest::p( $req, 'seconds', 0 ), 2 );
		if ( $sec <= 0 || $sec > 36000 ) { return Rest::err( 'bad_seconds', 'Measured seconds out of range' ); }
		$round = (int) $row['review_round'] + 1;
		Data::insert( 'aq_comp_reviews', [
			'sub_id'    => $sid,
			'round'     => $round,
			'verdict'   => 'measured',
			'verified'  => 1,
			'score'     => (int) round( $sec ), // the rounds column is int(11); exact decimals live on the sub + in the report
			'report'    => (string) Rest::p( $req, 'report', '' ),
			'model'     => mb_substr( sanitize_text_field( (string) Rest::p( $req, 'model', 'artatranslate+artavoice' ) ), 0, 60 ),
			'effort'    => '',
			'runtime_s' => max( 0, (int) Rest::p( $req, 'runtime_s', 0 ) ),
			'created'   => current_time( 'mysql', true ),
		] );
		Data::update( 'aq_comp_subs', [
			'score'        => $sec,
			'review'       => 'verified',
			'verified'     => 1,
			'review_round' => $round,
			'updated'      => current_time( 'mysql', true ),
		], [ 'id' => $sid ] );
		if ( class_exists( '\\AQ\\Notify' ) && method_exists( '\\AQ\\Notify', 'push' ) ) {
			@Notify::push( (int) $row['uid'], 'comp_review', sprintf( 'Your chant entry was measured: %.1fs across all 20 languages', $sec ), '', '/competition/', 'chant:' . $sid );
		}
		return [ 'ok' => true, 'seconds' => $sec, 'round' => $round ];
	}

	/** POST relay/chant/release { sub_id } — the chant relay hands a claimed entry back on shutdown. */
	public static function chant_release( $req ) {
		$sid = (int) Rest::p( $req, 'sub_id', 0 );
		if ( $sid ) { Data::update( 'aq_comp_subs', [ 'review' => 'submitted', 'updated' => current_time( 'mysql', true ) ], [ 'id' => $sid, 'review' => 'reviewing' ] ); }
		return [ 'ok' => true ];
	}

	/** The 20 mesh languages a chant entry is measured (and playable) in — board order. */
	const CHANT_LANGS = [ 'zh', 'hi', 'en', 'ar', 'es', 'jv', 'pt', 'ha', 'pa', 'bn', 'ru', 'fa', 'ja', 'vi', 'de', 'tr', 'fr', 'ko', 'zu', 'it' ];

	/**
	 * POST relay/chant/audio { sub_id, lang, audio(b64 mp3) } — the relay publishes one language's
	 * full chant recording (the 12 laws concatenated, the exact clips the clock timed). Deterministic
	 * name (re-measures overwrite): uploads/chant/sub-<id>-<lang>.mp3. Entries are public from the
	 * moment they're submitted, so the URL needs no secrecy — this is how "playable in 20 languages
	 * after verification" ships: the files exist only once the measurement pipeline has run.
	 */
	public static function chant_audio( $req ) {
		$sid  = (int) Rest::p( $req, 'sub_id', 0 );
		$lang = strtolower( sanitize_key( (string) Rest::p( $req, 'lang', '' ) ) );
		if ( ! in_array( $lang, self::CHANT_LANGS, true ) ) { return Rest::err( 'bad_lang', 'Unknown chant language' ); }
		$row = $sid ? Data::one( 'SELECT s.id FROM ' . Data::t( 'aq_comp_subs' ) . ' s JOIN ' . Data::t( 'aq_competitions' ) . " c ON c.id = s.comp_id WHERE s.id = %d AND c.metric IN ('chant','artaverify')", [ $sid ] ) : null;
		if ( ! $row ) { return Rest::err( 'not_found', 'Chant submission not found', 404 ); }
		$bytes = (string) base64_decode( (string) Rest::p( $req, 'audio', '' ), true );
		if ( strlen( $bytes ) < 1024 || strlen( $bytes ) > 8 * 1024 * 1024 ) { return Rest::err( 'bad_audio', 'Audio missing or out of size bounds' ); }
		$up = wp_upload_dir();
		if ( ! empty( $up['error'] ) ) { return Rest::err( 'no_uploads', 'Uploads unavailable', 500 ); }
		$dir = $up['basedir'] . '/chant';
		if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		$name = 'sub-' . $sid . '-' . $lang . '.mp3';
		if ( file_put_contents( $dir . '/' . $name, $bytes ) === false ) { return Rest::err( 'write_failed', 'Could not store the recording', 500 ); }
		@chmod( $dir . '/' . $name, 0644 );
		return [ 'ok' => true, 'url' => $up['baseurl'] . '/chant/' . $name ];
	}

	/** The published per-language recordings of a chant submission: { lang → URL } (only files that exist). */
	private static function chant_audio_map( $sid ) {
		$up = wp_upload_dir();
		if ( ! empty( $up['error'] ) ) { return []; }
		$out = [];
		foreach ( self::CHANT_LANGS as $lang ) {
			$name = 'sub-' . (int) $sid . '-' . $lang . '.mp3';
			if ( is_file( $up['basedir'] . '/chant/' . $name ) ) { $out[ $lang ] = $up['baseurl'] . '/chant/' . $name; }
		}
		return $out;
	}

	/**
	 * Load the hidden holdout answers { "trend|date" => true_target }. Never touches the DB (the whole DB
	 * is public) AND never the web-served uploads dir (a competitor could just download the answers). The
	 * solution ships as a GUARDED PHP file in the plugin — data/competitions/<slug>/solution.php — that
	 * returns the map only when AQ_COMP_SOLUTION is defined; a direct web hit executes it and 404s, so the
	 * answers are unreadable over HTTP. Falls back to a legacy uploads/solution.json if a host still has one.
	 */
	private static function load_solution( $slug ) {
		$php = rtrim( AQ_DIR, '/' ) . '/data/competitions/' . sanitize_file_name( (string) $slug ) . '/solution.php';
		if ( is_file( $php ) ) {
			if ( ! defined( 'AQ_COMP_SOLUTION' ) ) { define( 'AQ_COMP_SOLUTION', 1 ); }
			$j = include $php;
			if ( is_array( $j ) && $j ) { return $j; }
		}
		return self::load_legacy_solution( $slug );
	}

	private static function load_legacy_solution( $slug ) {
		$legacy = self::dir( $slug ) . '/solution.json';   // pre-guard hosts (cleaned up by seed())
		if ( is_file( $legacy ) ) {
			$j = json_decode( (string) file_get_contents( $legacy ), true );
			if ( is_array( $j ) && $j ) { return $j; }
		}
		return null;
	}

	/**
	 * The PUBLIC/PRIVATE holdout split for a competition, or null when it has none (score the whole
	 * holdout — the sky-vs-search behaviour). Ships as a GUARDED plugin file split.php returning
	 * [ 'public' => [ id, … ], 'private' => [ id, … ] ]. Kaggle-style: submit() scores the public
	 * half (the live leaderboard) and settle() pays on the private half — which is never scored by
	 * the live endpoint, so probing the public score can't reconstruct the prize-deciding answers.
	 */
	private static function load_split( $slug ) {
		$php = rtrim( AQ_DIR, '/' ) . '/data/competitions/' . sanitize_file_name( (string) $slug ) . '/split.php';
		if ( ! is_file( $php ) ) { return null; }
		if ( ! defined( 'AQ_COMP_SOLUTION' ) ) { define( 'AQ_COMP_SOLUTION', 1 ); }
		$s = include $php;
		return ( is_array( $s ) && ! empty( $s['public'] ) && ! empty( $s['private'] ) ) ? $s : null;
	}

	/** The guarded per-topic PLOT bundle (series.php: full monthly actuals + the reference model's
	 *  train fit + the test-row ids in month order), or null. Feeds the results endpoint's
	 *  train/test predicted-vs-raw charts. Guarded like solution.php — the test-month actuals ARE
	 *  the hidden holdout (the endpoint reveals only the public half while the competition is live). */
	private static function load_series_bundle( $slug ) {
		$php = rtrim( AQ_DIR, '/' ) . '/data/competitions/' . sanitize_file_name( (string) $slug ) . '/series.php';
		if ( ! is_file( $php ) ) { return null; }
		if ( ! defined( 'AQ_COMP_SOLUTION' ) ) { define( 'AQ_COMP_SOLUTION', 1 ); }
		$s = include $php;
		return ( is_array( $s ) && ! empty( $s['topics'] ) ) ? $s : null;
	}

	// ── The sky metric ('phase-r2' — topic-500) ──────────────────────────────────
	//
	// Predict each topic's search interest from the sky. Each topic's monthly rows are served JUST SHUFFLED
	// (the 11 body phases + target, no id, no phase column, no permutation). The board is PLAIN R²: fold each
	// submission row's 11 phases to their SKY FINGERPRINT (every phase minus the Sun's, mod 360 — a unique
	// month key), key by topic → the true target, per-topic R² clamped [0,1] averaged ×100 (phase_board). The
	// reference baseline is ONE fixed model — y = Σ w_i·sinc(f_i·(x_i − p)) + b, one global phase p → the
	// topic's sign — fit by gradient descent; the model class is fixed, so the competition improves the
	// LEARNING ALGORITHM. The fitted phase/sign + per-body frequencies the Results tab shows come from the
	// guarded series.php bundle (reanalyze_topic500_winner.py fits the same model on the full clean series).

	/** The 11 sidereal bodies, in the dataset's column order (index 0 = the Sun, the fingerprint anchor). */
	const SKY_BODIES = [ 'sun', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto', 'chiron', 'node' ];

	/** Fold a row's 11 body phases to the SKY FINGERPRINT "d0,d1,…,d10" — every phase minus the Sun's,
	 *  mod 360 (d0 is always 0), a unique key for the month. IDENTICAL to the Python builder's
	 *  fingerprint(), so it is the scorer's month key. $vals maps body → degrees. */
	private static function sky_fingerprint( $vals ) {
		$sun   = (int) round( (float) ( $vals['sun'] ?? 0 ) );
		$parts = [];
		foreach ( self::SKY_BODIES as $b ) {
			$parts[] = ( ( (int) round( (float) ( $vals[ $b ] ?? 0 ) ) - $sun ) % 360 + 360 ) % 360;
		}
		return implode( ',', $parts );
	}

	/**
	 * Parse a sky submission (topic-500) into { "topic|fingerprint" => pred }. The submission is trend +
	 * the 11 body phases + target — a CSV (matching sample_submission.csv) or a JSON list of
	 * { trend, sun, …, node, target } objects. Each row is folded to its sky fingerprint (every phase minus
	 * the Sun's — a unique month key). Returns [] on empty, null on unparseable.
	 */
	private static function parse_detimed( $req ) {
		// The predictions may arrive as the 'predictions' param (string CSV / JSON, from the SPA) or the raw body.
		$p = $req->get_param( 'predictions' );
		if ( is_array( $p ) ) { return self::detimed_from_list( $p ); }
		$text = is_string( $p ) && $p !== '' ? $p : (string) $req->get_body();
		$text = trim( $text );
		if ( $text === '' ) { return []; }
		if ( $text[0] === '[' || $text[0] === '{' ) {
			$j = json_decode( $text, true );
			if ( is_array( $j ) ) {
				if ( isset( $j['predictions'] ) && is_array( $j['predictions'] ) ) { $j = $j['predictions']; }
				return self::detimed_from_list( $j );
			}
			return null;
		}
		return self::detimed_from_csv( $text );
	}

	/** A JSON list of { trend, sun,…,node, target } objects → { "topic|fingerprint" => pred }. */
	private static function detimed_from_list( $arr ) {
		$out = [];
		foreach ( (array) $arr as $r ) {
			if ( ! is_array( $r ) ) { continue; }
			$t = isset( $r['trend'] ) ? (string) $r['trend'] : '';
			$v = $r['target'] ?? ( $r['prediction'] ?? ( $r['value'] ?? null ) );
			if ( $t === '' || $v === null || ! isset( $r['sun'] ) ) { continue; }
			$out[ $t . '|' . self::sky_fingerprint( $r ) ] = (float) $v;
		}
		return $out;
	}

	/** A CSV body (header: trend, the 11 bodies, target) → { "topic|fingerprint" => pred }. */
	private static function detimed_from_csv( $body ) {
		$lines = preg_split( '/\r\n|\r|\n/', trim( (string) $body ) );
		if ( count( $lines ) < 2 ) { return null; }
		$hdr = array_map( 'trim', str_getcsv( array_shift( $lines ) ) );
		$it  = array_search( 'trend', $hdr, true );
		$iv  = array_search( 'target', $hdr, true );
		if ( $iv === false ) { $iv = array_search( 'prediction', $hdr, true ); }
		$ib  = [];
		foreach ( self::SKY_BODIES as $b ) {
			$j = array_search( $b, $hdr, true );
			if ( $j === false ) { return null; }   // a body column is missing — not a sky submission
			$ib[ $b ] = $j;
		}
		if ( $it === false || $iv === false ) { return null; }
		$out = [];
		foreach ( $lines as $line ) {
			if ( trim( $line ) === '' ) { continue; }
			$c = str_getcsv( $line );
			if ( ! isset( $c[ $it ], $c[ $iv ] ) ) { continue; }
			$vals = [];
			$ok = true;
			foreach ( $ib as $b => $j ) { if ( ! isset( $c[ $j ] ) ) { $ok = false; break; } $vals[ $b ] = $c[ $j ]; }
			if ( ! $ok ) { continue; }
			$out[ trim( $c[ $it ] ) . '|' . self::sky_fingerprint( $vals ) ] = (float) $c[ $iv ];
		}
		return $out;
	}

	/** Encode a predictions blob for storage; a 432,000-key phase submission is several MB of JSON,
	 *  so oversized blobs are stored compressed ("gz:"+base64(gzdeflate)) to fit MEDIUMTEXT — settle()
	 *  and the results endpoint decode via decode_preds. Returns null only when pathological. */
	private static function encode_preds( $keep ) {
		$blob = wp_json_encode( array_map( static fn( $v ) => round( (float) $v, 4 ), $keep ) );
		if ( strlen( (string) $blob ) > 2000000 ) {
			$blob = 'gz:' . base64_encode( (string) gzdeflate( (string) $blob, 6 ) );
		}
		return strlen( (string) $blob ) > 12000000 ? null : $blob;
	}

	/** Decode a stored predictions blob (plain JSON or the "gz:" compressed form) → array|null. */
	private static function decode_preds( $blob ) {
		$blob = (string) $blob;
		if ( $blob === '' ) { return null; }
		if ( strpos( $blob, 'gz:' ) === 0 ) {
			$blob = (string) @gzinflate( (string) base64_decode( substr( $blob, 3 ) ) );
		}
		$j = json_decode( $blob, true );
		return is_array( $j ) ? $j : null;
	}

	/**
	 * Score a sky submission (topic-500). The board is PLAIN R² on the PUBLIC topic-half: fold each row's
	 * 11 phases to its sky fingerprint (every phase minus the Sun's — a unique month key), key by topic →
	 * the true target, per-topic R² clamped [0,1] averaged ×100 (phase_board). settle re-scores the
	 * PRIVATE half the same way from the stored (folded) predictions.
	 */
	private static function submit_detimed( $comp, $uid, $solution, $req, $note = '', $code_url = '' ) {
		$preds = self::parse_detimed( $req );
		if ( $preds === null ) { return Rest::err( 'bad_payload', 'Could not parse the predictions. Submit trend + the 11 body phases + target (a CSV matching sample_submission.csv, or a JSON list).' ); }
		if ( ! $preds ) { return Rest::err( 'empty', 'No predictions received.' ); }
		$split  = self::load_split( $comp['slug'] );
		$public = ( $split && ! empty( $split['public'] ) ) ? array_intersect_key( $solution, array_flip( array_map( 'strval', $split['public'] ) ) ) : $solution;
		$score  = self::phase_board( $public, $preds );
		if ( $score === null ) { return Rest::err( 'no_overlap', 'None of your predictions matched a holdout row. Submit trend + the 11 body phases + target for every row in test.csv.' ); }

		// Keep the folded holdout-row predictions so settle() can re-score the private half without a live
		// private oracle (each month already folds to one sky-fingerprint key). Bounded + gz.
		$keep = array_intersect_key( $preds, $solution );
		$sid = Data::insert( 'aq_comp_subs', [
			'comp_id' => (int) $comp['id'],
			'uid'     => $uid,
			'note'     => $note,
			'code_url' => $code_url,
			'score'    => $score,
			'preds'    => self::encode_preds( $keep ),
			'place'   => 0,
			'created' => current_time( 'mysql', true ),
		] );
		self::charge_submission( $comp, $uid, (int) $sid );

		$subs  = Data::t( 'aq_comp_subs' );
		$best  = (float) Data::col( "SELECT MAX(score) FROM $subs WHERE comp_id = %d AND uid = %d", [ (int) $comp['id'], $uid ] );
		$ahead = (int) Data::col(
			"SELECT COUNT(*) FROM ( SELECT uid, MAX(score) m FROM $subs WHERE comp_id = %d GROUP BY uid ) t"
			. " WHERE t.m > ( SELECT MAX(score) FROM $subs WHERE comp_id = %d AND uid = %d )",
			[ (int) $comp['id'], (int) $comp['id'], $uid ]
		);
		return [
			'ok'    => true,
			'score' => round( $score, 6 ),
			'best'  => round( $best, 6 ),
			'rank'  => $ahead + 1,
		];
	}

	/**
	 * Parse the request body into a flat map { "trend|date" => predicted_value }.
	 * Accepts JSON (self-keyed map OR per-target arrays aligned to the solution keys) or a CSV body.
	 * Returns [] on empty, null on unparseable.
	 */
	private static function parse_predictions( $req ) {
		// 1) A JSON param 'predictions' or the raw JSON body.
		$p = $req->get_param( 'predictions' );
		if ( is_array( $p ) ) { return self::normalize_pred_array( $p ); }
		if ( is_string( $p ) && $p !== '' ) {
			$j = json_decode( $p, true );
			if ( is_array( $j ) ) { return self::normalize_pred_array( $j ); }
		}
		$body = (string) $req->get_body();
		if ( $body !== '' ) {
			$j = json_decode( $body, true );
			if ( is_array( $j ) ) {
				// Some clients wrap as {"predictions": {...}}.
				if ( isset( $j['predictions'] ) && is_array( $j['predictions'] ) ) { return self::normalize_pred_array( $j['predictions'] ); }
				return self::normalize_pred_array( $j );
			}
			// Otherwise treat the body as CSV (header incl. trend,date,target).
			$csv = self::parse_pred_csv( $body );
			if ( $csv !== null ) { return $csv; }
		}
		return null;
	}

	/** Normalize a decoded JSON predictions structure into { "trend|date" => value }. */
	private static function normalize_pred_array( $arr ) {
		$out = [];
		$is_list = array_keys( $arr ) === range( 0, count( $arr ) - 1 );
		if ( $is_list ) {
			// A list of {trend,phase,id,target}, {trend,date,target} or {id,target} objects.
			foreach ( $arr as $r ) {
				if ( ! is_array( $r ) ) { continue; }
				$v = $r['target'] ?? ( $r['prediction'] ?? ( $r['value'] ?? null ) );
				if ( $v === null ) { continue; }
				$t = isset( $r['trend'] ) ? (string) $r['trend'] : '';
				$ph = $r['phase'] ?? ( $r['shift'] ?? null );        // topic-500 phase rotation (legacy alias: shift)
				if ( $ph !== null && isset( $r['id'] ) && $t !== '' && (string) $r['id'] !== '' ) {
					// phase+trend+id → "phase|trend|id" (phase-tuning datasets, topic-500).
					$out[ (string) (int) $ph . '|' . $t . '|' . (string) $r['id'] ] = (float) $v;
					continue;
				}
				if ( isset( $r['id'] ) && (string) $r['id'] !== '' ) {
					// trend+id → "trend|id" (per-topic rows); bare id → the id alone.
					$out[ ( $t !== '' ? $t . '|' : '' ) . (string) $r['id'] ] = (float) $v;
					continue;
				}
				$d = isset( $r['date'] ) ? (string) $r['date'] : '';
				if ( $t !== '' && $d !== '' ) { $out[ $t . '|' . $d ] = (float) $v; }
			}
			return $out;
		}
		foreach ( $arr as $k => $v ) {
			if ( is_array( $v ) ) {
				// Per-target arrays: { "trend": [values…] } — can't align without dates, skipped here.
				// (The self-keyed "trend|date" form or CSV is required for array submissions.)
				continue;
			}
			$out[ (string) $k ] = (float) $v;
		}
		return $out;
	}

	/** Parse a CSV predictions body. Header must include a value column (target|prediction) plus the
	 *  row key: a `shift`+`trend`+`id` triple (phase datasets — key = "shift|trend|id"), an `id`
	 *  column (opaque shuffled-row datasets — key = the id, or "trend|id" with a trend column), or
	 *  the `trend`+`date` pair (time-series datasets — key = "trend|date"). */
	private static function parse_pred_csv( $body ) {
		$lines = preg_split( '/\r\n|\r|\n/', trim( (string) $body ) );
		if ( count( $lines ) < 2 ) { return null; }
		$hdr = array_map( 'trim', str_getcsv( array_shift( $lines ) ) );
		$is  = array_search( 'phase', $hdr, true );          // topic-500 phase rotation (legacy alias: shift)
		if ( $is === false ) { $is = array_search( 'shift', $hdr, true ); }
		$ik  = array_search( 'id', $hdr, true );
		$it  = array_search( 'trend', $hdr, true );
		$id  = array_search( 'date', $hdr, true );
		$iv  = array_search( 'target', $hdr, true );
		if ( $iv === false ) { $iv = array_search( 'prediction', $hdr, true ); }
		if ( $iv === false ) { $iv = array_search( 'pred', $hdr, true ); } // the balanced bundle's sample_submission header
		if ( $iv === false || ( $ik === false && ( $it === false || $id === false ) ) ) { return null; }
		$out = [];
		foreach ( $lines as $line ) {
			if ( trim( $line ) === '' ) { continue; }
			$c = str_getcsv( $line );
			if ( ! isset( $c[ $iv ] ) ) { continue; }
			if ( $is !== false && $it !== false && $ik !== false ) {
				// Phase-tuning datasets (topic-500): key = "phase|trend|id".
				if ( ! isset( $c[ $is ], $c[ $it ], $c[ $ik ] ) || trim( $c[ $ik ] ) === '' ) { continue; }
				$out[ trim( $c[ $is ] ) . '|' . trim( $c[ $it ] ) . '|' . trim( $c[ $ik ] ) ] = (float) $c[ $iv ];
			} elseif ( $it !== false && $ik !== false ) {
				// Per-topic shuffled-row datasets (skills-500 lineage): key = "trend|id".
				if ( ! isset( $c[ $it ], $c[ $ik ] ) || trim( $c[ $ik ] ) === '' ) { continue; }
				$out[ trim( $c[ $it ] ) . '|' . trim( $c[ $ik ] ) ] = (float) $c[ $iv ];
			} elseif ( $ik !== false ) {
				if ( ! isset( $c[ $ik ] ) || trim( $c[ $ik ] ) === '' ) { continue; }
				$out[ trim( $c[ $ik ] ) ] = (float) $c[ $iv ];
			} else {
				if ( ! isset( $c[ $it ], $c[ $id ] ) ) { continue; }
				$out[ trim( $c[ $it ] ) . '|' . trim( $c[ $id ] ) ] = (float) $c[ $iv ];
			}
		}
		return $out;
	}

	/**
	 * R² over the holdout, averaged across targets. `$solution` is { "trend|date" => true }, `$preds`
	 * is the same-keyed prediction map. For each target (the part before "|") we compute
	 * R² = 1 − SS_res/SS_tot over that target's holdout rows using the mean of the TRUE values as the
	 * baseline; targets with zero variance are skipped. A holdout row the member didn't predict is
	 * treated as a prediction of that target's true mean (R²-neutral — no free credit, no crash).
	 * Keys WITHOUT a "|" are opaque row ids (the shuffled-row datasets, e.g. skills-500): they all
	 * belong to ONE shared target, so the score is a single R² over every holdout row.
	 * Returns the mean over scored targets, or null if nothing overlapped.
	 */
	private static function r2_over_holdout( $solution, $preds ) {
		[ $scores, $matched ] = self::per_target_r2s( $solution, $preds );
		if ( $matched === 0 || ! $scores ) { return null; }
		return array_sum( $scores ) / count( $scores );
	}

	/**
	 * Metric 'acc' (operator 2026-07-17): AVERAGE MONTHLY ACCURACY over the holdout. Keys are
	 * "topic|YYYY-MM" and the truth is a ±1 class; a prediction counts correct when its SIGN
	 * matches (any positive number = +1, any non-positive = −1, so soft scores are welcome).
	 * Rows are grouped by their MONTH (the part after "|"); each month's accuracy is
	 * correct ÷ rows, and the score is the plain mean over the months — "the average 12-month
	 * autoregressed future prediction accuracy". An unpredicted holdout row counts WRONG (no
	 * free credit). Returns null if nothing overlapped.
	 */
	private static function acc_over_holdout( $solution, $preds ) {
		$by_month = [];
		$matched  = 0;
		foreach ( $solution as $k => $truth ) {
			$k     = (string) $k;
			$month = strpos( $k, '|' ) !== false ? explode( '|', $k, 2 )[1] : '';
			$hit   = 0;
			if ( array_key_exists( $k, $preds ) ) {
				$matched++;
				$hit = ( ( (float) $preds[ $k ] > 0 ? 1 : -1 ) === ( (float) $truth > 0 ? 1 : -1 ) ) ? 1 : 0;
			}
			$by_month[ $month ]['n'] = ( $by_month[ $month ]['n'] ?? 0 ) + 1;
			$by_month[ $month ]['c'] = ( $by_month[ $month ]['c'] ?? 0 ) + $hit;
		}
		if ( $matched === 0 || ! $by_month ) { return null; }
		$accs = [];
		foreach ( $by_month as $m ) { $accs[] = $m['c'] / max( 1, $m['n'] ); }
		return array_sum( $accs ) / count( $accs );
	}

	/** The per-target R² list — the shared building block of both the plain-R² metric and the phase
	 *  board. Returns [ list<float> r2, int matched ]. Grouping + the mean-as-baseline rule are
	 *  identical to r2_over_holdout (id-keyed rows share one group; unpredicted row → the mean;
	 *  zero-variance targets skipped). */
	private static function per_target_r2s( $solution, $preds ) {
		$by_target = [];
		foreach ( $solution as $k => $truth ) {
			$k      = (string) $k;
			$target = strpos( $k, '|' ) !== false ? explode( '|', $k )[0] : '';
			$by_target[ $target ][ $k ] = (float) $truth;
		}
		$scores  = [];
		$matched = 0;
		foreach ( $by_target as $target => $truths ) {
			$ys = array_values( $truths );
			$n  = count( $ys );
			if ( $n === 0 ) { continue; }
			$mean = array_sum( $ys ) / $n;
			$ss_tot = 0.0;
			foreach ( $ys as $y ) { $ss_tot += ( $y - $mean ) * ( $y - $mean ); }
			if ( $ss_tot <= 1e-12 ) { continue; } // zero-variance target — skipped (per spec)
			$ss_res = 0.0;
			foreach ( $truths as $k => $y ) {
				if ( array_key_exists( $k, $preds ) ) { $matched++; $p = (float) $preds[ $k ]; }
				else { $p = $mean; } // unpredicted row → the mean (R²-neutral, never rewarded)
				$ss_res += ( $y - $p ) * ( $y - $p );
			}
			$scores[] = 1.0 - $ss_res / $ss_tot;
		}
		return [ $scores, $matched ];
	}

	/**
	 * The 0-100 PHASE BOARD score for one shift's predictions: each target's R² CLAMPED to [0,1]
	 * (a perfectly-fit target = 1, predicting its mean or doing worse = 0), averaged over targets and
	 * ×100. So 100 = every topic fit perfectly and 0 = no better than predicting each topic's mean —
	 * a bounded, outlier-robust score that reads sensibly on a leaderboard (a few unpredictable topics
	 * can no longer drag the whole board negative). Returns null if nothing overlapped.
	 */
	private static function phase_board( $solution, $preds ) {
		[ $scores, $matched ] = self::per_target_r2s( $solution, $preds );
		if ( $matched === 0 || ! $scores ) { return null; }
		$sum = 0.0;
		foreach ( $scores as $r ) { $sum += min( 1.0, max( 0.0, (float) $r ) ); }
		return $sum / count( $scores ) * 100.0;
	}

	// ── Seeding ──────────────────────────────────────────────────────────────

	/** Prize split for a competition's coin pool — Kaggle-style podium (gold/silver/bronze). */
	const PODIUM = [ 0.50, 0.30, 0.20 ];

	/**
	 * The flagship competitions. Because prod's ssh (the tar-over-ssh dataset copy) is not always
	 * reachable, each PUBLIC dataset ships INSIDE the plugin — gzipped under data/competitions/<slug>/
	 * — and this seeds itself on any host: it inflates the public files (train/test/sample/stats/
	 * starter notebook) into uploads/competitions/<slug>/ and inserts the aq_competitions row once.
	 * The HIDDEN holdout answers never touch uploads — they stay in the guarded plugin solution.php
	 * (see load_solution). Idempotent: a no-op once the row exists (bar the leaked-file scrub + the
	 * discussion-thread backfill). Runs on every plugins_loaded (self-healing, like Library::import_seed).
	 */
	public static function seed() {
		global $wpdb;
		$tbl = Data::t( 'aq_competitions' );
		// Bail quietly if the table isn't installed yet (a first load before Schema::install created it).
		$prev = $wpdb->suppress_errors( true );
		$wpdb->get_var( "SELECT 1 FROM `$tbl` LIMIT 1" );
		$has_table = ( $wpdb->last_error === '' );
		$wpdb->suppress_errors( $prev );
		if ( ! $has_table ) { return; }

		// (skills-500 was PURGED in full 2026-07-05 — operator directive: its papers, dataset,
		// competition row/submissions/thread, uploads and the /professions atlas are all gone.
		// Its successor is topic-500: predict interest from the sky (a FUTURE holdout, plain-R2 board).)
		self::seed_one( 'topic-500', [
			'title'     => 'Topic 500: Predict Search Interest from the Sky',
			'metric'    => 'phase-r2',
			'entry_fee' => self::ENTRY_FEE, // restarted 2026-07-10 under the dataset/model C-to-C frame
			'blurb'    => "Predict the worldwide search interest of the 500 most-searched learning topics on Earth "
				. "from the sky. Each topic's monthly Google-Trends interest (0-100) is given JUST SHUFFLED: the 11 "
				. "sidereal body phases (Sun, Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune, Pluto, Chiron "
				. "and the lunar node, ecliptic longitude 0-360\xc2\xb0) and the target \xe2\x80\x94 no id, no phase "
				. "column, no permutation. Train on the first 80% of each topic's clean months; the holdout is the "
				. "FUTURE, the LAST 20% of the clean months (the recency-biased final year is dropped first). Submit trend + the 11 "
				. "body phases + target for every test row. The score is a 0-100 board of PLAIN R\xc2\xb2: fold each "
				. "row's 11 phases to their sky fingerprint (every phase minus the Sun's), look up the true target, "
				. "per-topic R\xc2\xb2 clamped [0,1] averaged \xc3\x97100 (100 = perfect, 0 = predict-the-mean). The "
				. "reference baseline is ONE fixed model \xe2\x80\x94 y = \xce\xa3 w_i\xc2\xb7sinc(f_i\xc2\xb7(x_i "
				. "\xe2\x88\x92 p)) + b, a single CIRCULAR global phase p (\xe2\x86\x92 the topic's season of the year's cycle), "
				. "NON-NEGATIVE per-body frequencies f_i and weights w_i, and a bias b \xe2\x80\x94 fit with PYTORCH "
				. "in one batched, GPU-ready gradient-descent pass (12 starts, one at each 30\xc2\xb0 season centre; a "
				. "recency-weighted loss and a time-blocked validation slice pick the winner \xe2\x80\x94 the free "
				. "starter notebook reproduces it on a Colab GPU in about two minutes). The MODEL CLASS is fixed, so "
				. "the competition is to IMPROVE THE LEARNING ALGORITHM: a better optimiser, initialisation or "
				. "regularisation of this same model. "
				. "The topics page reports each topic's fitted phase p (its season \xe2\x80\x94 christmas "
				. "\xe2\x86\x92 Ember, halloween \xe2\x86\x92 Forge, super-bowl \xe2\x86\x92 Stone, swimming "
				. "\xe2\x86\x92 Bridge) and its per-body frequencies. Every submission ships a public, reproducible "
				. "code link (fully transparent), and costs \xe2\x82\xb3" . self::ENTRY_FEE . " \xe2\x80\x94 the fee "
				. "joins this dataset's own prize pool (80% of the entry revenue is paid back to the podium on top "
				. "of the \xe2\x82\xb3100 prize). 50/30/20 to the top "
				. "three at the deadline \xe2\x80\x94 the next full moon \xe2\x80\x94 settled on the hidden private half.",
			'holdout'  => "the FUTURE - the LAST 20% of each topic's clean months (train = the first 80%; the "
				. "recency year dropped), served JUST SHUFFLED (11 body phases + target, no id/phase)",
			'deadline' => gmdate( 'Y-m-d H:i:s', Season::next_full_moon() ),
			'prize'    => 100,
			'thread'   => "Official discussion for Topic 500 \xe2\x80\x94 predict a learning topic's worldwide search "
				. "interest from the sky, with ONE fixed model class (a global-phase sinc with non-negative weights "
				. "and frequencies and a circular phase, fit by gradient descent). Ask questions, share approaches, "
				. "EDA notebooks and scores. The dataset: 500 per-topic train CSVs (the first 80% of each topic's "
				. "clean months \xe2\x80\x94 the 11 integer sky phases in, one 0-100 search-interest target out, "
				. "shuffled: no id, no phase) and a test set of the FUTURE, the LAST 20% of each topic's clean months. "
				. "The board is plain R\xc2\xb2 by the sky fingerprint; the \xe2\x82\xb3100 podium (50/30/20, plus 80% "
				. "of the \xe2\x82\xb3" . self::ENTRY_FEE . "-per-submission entry revenue) settles on the private "
				. "topic-half at the next full moon. The model class is fixed \xe2\x80\x94 the game is to improve the "
				. "fit; the PyTorch baseline is reproducible on a free Colab GPU via the starter notebook. Every "
				. "submission ships a public, reproducible code link (fully transparent).",
		] );

		// THE TWO STANDING COMPETITIONS (operator directive 2026-07-11): topic-500 (above) and the
		// Wheel-of-Arta hero naming below — both seeded under the founder. ArtaAstro was retired
		// 2026-07-11 (its honest null concluded and published; its /astro page was already purged
		// 2026-07-07) — do NOT re-add its seed.
		//
		// The Wheel of Arta — Hero Naming: write the TWELVE LAWS of the Wheel (the ArtaRPS heroes).
		// No judge, no dataset — the chant relay renders every entry in all 20 languages, ArtaVoice
		// speaks all 240 lines, and TOTAL SPOKEN TIME is the score (lowest wins). `nodata` — a chant
		// competition ships no files; the entry IS the twelve sentences.
		self::seed_one( 'wheel-of-arta-naming', [
			'nodata'   => true,
			'title'    => 'The Wheel of Arta — Hero Naming',
			'metric'   => 'chant',
			'blurb'    => '<p><b>Write the twelve laws of the Wheel.</b> Twelve sentences — that’s the whole entry. '
				. 'The founder’s Classic Twelve is the baseline; beat it and your laws ship into the live ArtaRPS game.</p>'
				. '<p><b>No judge — the machines keep the clock.</b> The moment you enter, ArtaTranslate renders your '
				. 'twelve chants in all 20 languages and ArtaVoice speaks all 240 lines aloud (one fixed voice per '
				. 'language). Your score is the TOTAL SPOKEN TIME in seconds — the lowest time wins the board. Short, '
				. 'clear, speakable law-writing is the whole game; every translation and every clip timing is public '
				. 'in Solutions.</p>',
			'holdout'  => '',
			'deadline' => gmdate( 'Y-m-d H:i:s', Season::next_full_moon() ),
			'prize'    => 0,
			'thread'   => 'Official discussion for The Wheel of Arta — Hero Naming: write the twelve laws of the '
				. 'Wheel in twelve speakable sentences. No judge — ArtaTranslate renders every entry in 20 languages, '
				. 'ArtaVoice speaks all 240 lines, and the total spoken time is the score (lowest wins). Share your '
				. 'law-writing approaches and timings.',
		] );
	}

	/** Seed one bundled competition: inflate its public files, insert its row, ensure its
	 *  discussion thread. Never clobbers a live competition or its files. */
	private static function seed_one( $slug, $def ) {
		// One-time SECURITY scrub — runs even once the row exists: delete any holdout answers a pre-guard
		// build leaked into web-served uploads (the answers now live only in the guarded plugin solution.php).
		$leaked = self::dir( $slug ) . '/solution.json';
		if ( is_file( $leaked ) ) { @unlink( $leaked ); }

		$row = Data::one( 'SELECT id, thread_id FROM ' . Data::t( 'aq_competitions' ) . ' WHERE slug = %s', [ $slug ] );
		if ( $row ) {
			// Backfill the discussion thread for a competition seeded before threads existed.
			if ( ! (int) $row['thread_id'] && ! empty( $def['thread'] ) ) {
				$tid = self::ensure_thread( $slug, $def );
				if ( $tid ) { Data::update( 'aq_competitions', [ 'thread_id' => $tid ], [ 'id' => (int) $row['id'] ] ); }
			}
			return;
		}
		$bundle = rtrim( AQ_DIR, '/' ) . '/data/competitions/' . $slug;
		if ( empty( $def['nodata'] ) && ! is_dir( $bundle ) ) { return; }

		// Inflate the PUBLIC bundled files into uploads/competitions/<slug>/ (each gzip'd; stats.json plain).
		// The holdout answers are NEVER written here — they stay in the guarded plugin solution.php, read
		// only via load_solution — because uploads is web-served (a public solution file = downloadable
		// answers). A file already present is left untouched.
		// `nodata` competitions (chant) ship no files and need no holdout — the entry IS the text;
		// everything below is dataset plumbing.
		if ( empty( $def['nodata'] ) ) {
			$dir = self::dir( $slug );
			if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
			foreach ( [ 'train.csv', 'train.zip', 'test.csv', 'sample_submission.csv', 'stats.json', 'starter.ipynb', 'reference_solution.py' ] as $f ) {
				$dest = $dir . '/' . $f;
				if ( is_file( $dest ) ) { continue; }
				if ( is_file( $bundle . '/' . $f . '.gz' ) ) {
					$raw = @gzdecode( (string) file_get_contents( $bundle . '/' . $f . '.gz' ) );
					if ( $raw !== false && $raw !== null ) { file_put_contents( $dest, $raw ); }
				} elseif ( is_file( $bundle . '/' . $f ) ) {
					copy( $bundle . '/' . $f, $dest );
				}
			}
			// Without the (guarded) holdout — or with an incomplete public dataset (a corrupt gz-inflate
			// leaves a file missing) — there is no scoreable competition: bail rather than open a broken one
			// with n_train=0. All three public files + the solution must be present before we insert.
			if ( ! self::load_solution( $slug ) ) { return; }
			if ( ! is_file( $dir . '/train.csv' ) && ! is_file( $dir . '/train.zip' ) ) { return; }
			foreach ( [ 'test.csv', 'sample_submission.csv' ] as $need ) {
				if ( ! is_file( $dir . '/' . $need ) ) { return; }
			}
		}

		$stats = self::dataset_stats( $slug );
		// Insert the row FIRST — the UNIQUE slug index is the race arbiter, so under concurrent
		// plugins_loaded only ONE request creates the competition (and later does the side effects).
		// A losing request's insert fails (false) and it bails; the prize is minted at SETTLEMENT
		// (to the winners), so there is no pre-funded pool to double-mint here.
		global $wpdb;
		$prev = $wpdb->suppress_errors( true );
		$ok   = $wpdb->insert( Data::t( 'aq_competitions' ), [
			'slug'       => $slug,
			'title'      => (string) $def['title'],
			'owner_uid'  => self::founder_uid(),
			'blurb'      => (string) $def['blurb'],
			'metric'     => sanitize_key( (string) ( $def['metric'] ?? 'r2' ) ) ?: 'r2',
			'holdout'    => (string) $def['holdout'],
			'status'     => 'active',
			'n_train'    => (int) $stats['n_train'],
			'n_test'     => (int) $stats['n_test'],
			'n_features' => (int) $stats['n_features'],
			'n_targets'  => (int) $stats['n_targets'],
			'prize'      => (int) ( $def['prize'] ?? 0 ),
			'entry_fee'  => (int) ( $def['entry_fee'] ?? 0 ), // C-to-C frame: ₳/submission → revenue → pool_of
			'thread_id'  => 0,
			'created'    => current_time( 'mysql', true ),
			'deadline'   => (string) $def['deadline'],
		] );
		$wpdb->suppress_errors( $prev );
		if ( ! $ok ) { return; } // lost the UNIQUE-slug race — the winner seeds the thread
		$id  = (int) $wpdb->insert_id;
		$tid = ! empty( $def['thread'] ) ? self::ensure_thread( $slug, $def ) : 0;
		if ( $tid ) { Data::update( 'aq_competitions', [ 'thread_id' => $tid ], [ 'id' => $id ] ); }
	}

	/** The founder (/u/arash), falling back to the first administrator on a host without it. */
	private static function founder_uid() {
		$owner = get_user_by( 'slug', 'arash' );
		if ( $owner ) { return (int) $owner->ID; }
		$admins = get_users( [ 'role' => 'administrator', 'number' => 1, 'fields' => 'ID' ] );
		return $admins ? (int) $admins[0] : 0;
	}

	/** Find-or-create the official discussion thread for a competition (author = ArtaBot, so the
	 *  competition host stays a competitor, not the moderator). Returns the thread id, or 0. */
	private static function ensure_thread( $slug, $def ) {
		$title = (string) $def['title'] . ' — official discussion';
		$tid   = (int) Data::col( 'SELECT id FROM ' . Data::t( 'aq_threads' ) . ' WHERE title = %s', [ $title ] );
		if ( $tid ) { return $tid; }
		$author = (int) get_option( 'aq_artabot_uid', 0 ) ?: self::founder_uid();
		if ( ! $author ) { return 0; }
		return (int) Data::insert( 'aq_threads', [
			'author_id' => $author,
			'title'     => $title,
			'body'      => wp_kses_post( (string) $def['thread'] ),
			'lang'      => 'en',
			'topic'     => 'competitions',
			'created'   => Data::now(),
		] );
	}

	// ── Settlement (prizes at the deadline) ──────────────────────────────────

	/**
	 * Close every active competition whose deadline has passed and pay its coin podium. Runs from the
	 * daily aq_comp_settle cron (through Cron::guard) and is safe to call any time: every payment is
	 * idempotent by ledger ref and the status flips to 'closed' only AFTER a clean payout, so a crash
	 * mid-settle is retried and a re-run never double-pays.
	 *
	 * Prize model: the pool is the operator's ₳ allocation — gold-backed coins MINTED to the winners at
	 * settlement (a platform award, like a course prize pool; there is no losing party to debit, so no
	 * wallet can go negative). Shares (50/30/20) are integers summing exactly to the pool. The podium is
	 * the PRIVATE-half leaderboard (each member's public-best submission re-scored on the hidden private
	 * holdout half — never exposed to the live scorer, so the prize can't be probed out), requiring a
	 * private score above 0 (you must beat "predict the mean" to take a medal). Bot accounts stay on the
	 * public leaderboard but are walled off from the economy (platform rule) — a bot's slot passes down.
	 */
	// The dataset/model C-to-C economics (2026-07-10): hosting a dataset costs ₳DATASET_FEE (it
	// seeds the pool); each model submission on a post-split competition costs ₳ENTRY_FEE (burned
	// → `revenue`); settlement pays prize + the full revenue. Live pre-split competitions have
	// entry_fee 0 and revenue 0, so their settlement is byte-identical to the old fixed-prize path.
	const DATASET_FEE = 2;
	const ENTRY_FEE   = 1;

	/** Charge a C-to-C submission fee (entry_fee > 0 competitions only): burned into reserve,
	 *  accumulated as the pool's `revenue`. Ref-tied to the submission id — never double-charges. */
	private static function charge_submission( $comp, $uid, $sid ) {
		$fee = (int) ( $comp['entry_fee'] ?? 0 );
		if ( $fee <= 0 || ! $sid || ! $uid ) { return; }
		$ref = 'compsub:' . (int) $sid;
		if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'compent' AND ref = %s", [ $ref ] ) ) { return; }
		// The ref probe dedupes a replay of THIS submission; it never serialised submissions to
		// different boards, which all read one balance. `revenue` grows only when the fee actually
		// landed — a pool that counts fees it never received pays out coins nothing backs.
		if ( '' !== Economy::spend( $uid, $fee, 'compent', $ref ) ) { return; }
		Data::bump( 'aq_competitions', [ 'id' => (int) $comp['id'] ], 'revenue', $fee );
	}

	/** The full prize pool a competition settles against: the fixed operator prize (minted, legacy)
	 *  + 100% of the entry-fee revenue (operator 2026-07-11 — every fee paid in goes back out;
	 *  fees are burned at submit, so the full payout is fully backed). */
	public static function pool_of( $c ) {
		return (int) ( $c['prize'] ?? 0 ) + (int) ( $c['revenue'] ?? 0 );
	}

	/** GET /models — the Library's MODEL shelf (dataset/model split, 2026-07-10): every VERIFIED
	 *  solution across every competition, newest first. A model is a first-class work: member-owned,
	 *  reproducible (public code link), adversarially reviewed (verified=1). Keyset on sub id. */
	public static function models_list( $req ) {
		$cursor = Rest::pint( $req, 'cursor', 0 );
		$S = Data::t( 'aq_comp_subs' );
		$C = Data::t( 'aq_competitions' );
		$where = $cursor > 0 ? ' AND s.id < %d' : '';
		$args  = $cursor > 0 ? [ $cursor ] : [];
		$rows  = Data::all(
			"SELECT s.id, s.uid, s.score, s.method, s.code_url, s.created, c.slug comp_slug, c.title comp_title, c.metric
			   FROM $S s JOIN $C c ON c.id = s.comp_id
			  WHERE s.verified = 1$where ORDER BY s.id DESC LIMIT 25",
			$args
		);
		$next = null;
		if ( count( $rows ) === 25 ) { $next = (int) $rows[24]['id']; $rows = array_slice( $rows, 0, 24 ); }
		$items = array_map( function ( $r ) {
			return [
				'id'         => (int) $r['id'],
				'author'     => self::name_of( (int) $r['uid'] ),
				'author_slug'=> self::slug_of( (int) $r['uid'] ),
				'score'      => $r['score'] === null ? null : round( (float) $r['score'], 6 ),
				'metric'     => (string) $r['metric'],
				'method'     => mb_substr( (string) $r['method'], 0, 400 ),
				'code_url'   => (string) $r['code_url'],
				'comp_slug'  => (string) $r['comp_slug'],
				'comp_title' => (string) $r['comp_title'],
				'created'    => $r['created'] ? (int) strtotime( $r['created'] . ' UTC' ) : 0,
			];
		}, $rows );
		return [ 'items' => $items, 'next' => $next ];
	}

	public static function settle_due() {
		$due = Data::all(
			'SELECT * FROM ' . Data::t( 'aq_competitions' )
			. " WHERE status = 'active' AND deadline IS NOT NULL AND deadline < %s",
			[ gmdate( 'Y-m-d H:i:s' ) ]
		);
		foreach ( $due as $c ) { self::settle( $c ); }
	}

	private static function settle( $c ) {
		$cid = (int) $c['id'];

		// The pool = the fixed prize (minted, legacy/operator allocation) + the FULL entry-fee
		// revenue (fully backed — every fee was burned into reserve at submit; minting it all back out
		// restores exact parity — the reserve never dips below issued).
		$prize = self::pool_of( $c );
		if ( $prize <= 0 ) {
			Data::update( 'aq_competitions', [ 'status' => 'closed' ], [ 'id' => $cid ] ); // nothing to pay
			return;
		}

		$standings = [];
		if ( in_array( (string) ( $c['metric'] ?? '' ), [ 'chant', 'artaverify' ], true ) ) {
			// CHANT: the public board IS the final board — the measured total spoken time is objective
			// and fully machine-produced, so there is no private half. Standing = the member's fastest
			// measured entry; negated so "higher standing wins" flows through the shared podium code.
			foreach ( Data::all(
				'SELECT uid, MIN(score) AS sec FROM ' . Data::t( 'aq_comp_subs' )
				. ' WHERE comp_id = %d AND score > 0 GROUP BY uid',
				[ $cid ]
			) as $r ) {
				$standings[] = [ 'uid' => (int) $r['uid'], 'priv' => -(float) $r['sec'] ];
			}
			usort( $standings, fn( $a, $b ) => $b['priv'] <=> $a['priv'] );
		} else {
			// The PRIVATE leaderboard decides the prize. Each member's final standing = the PRIVATE-half
			// R² of the submission that tops their PUBLIC board (their displayed best) — re-scored now
			// from the stored predictions, so the prize half was never exposed to a live oracle and a
			// public-score lottery can't buy the prize. No split → the whole holdout (sky-vs-search).
			// Sky metric ('phase-r2', topic-500): the private half is re-scored PLAIN R² from the
			// stored folded predictions (phase_board) — the same 0-100 mechanic, private data.
			$solution = self::load_solution( $c['slug'] );
			$split    = self::load_split( $c['slug'] );
			$private  = ( $split && ! empty( $split['private'] ) )
				? array_intersect_key( (array) $solution, array_flip( array_map( 'strval', $split['private'] ) ) )
				: (array) $solution;
			$is_phase = ( (string) ( $c['metric'] ?? '' ) === 'phase-r2' );

			// One row per member: their public-best submission (max public score, earliest on a tie) + its preds.
			$subs  = Data::all(
				'SELECT uid, score, preds, created FROM ' . Data::t( 'aq_comp_subs' )
				. ' WHERE comp_id = %d ORDER BY score DESC, created ASC',
				[ $cid ]
			);
			$best_of = [];
			foreach ( $subs as $s ) {
				$u = (int) $s['uid'];
				if ( ! isset( $best_of[ $u ] ) ) { $best_of[ $u ] = $s; } // first seen = highest public score
			}
			foreach ( $best_of as $u => $s ) {
				$preds = self::decode_preds( $s['preds'] );
				if ( $is_phase ) {
					// topic-500: the private-half R² board (0-100), same metric as the live public score.
					$priv = is_array( $preds ) ? self::phase_board( $private, $preds ) : null;
				} elseif ( (string) ( $c['metric'] ?? '' ) === 'acc' ) {
					$priv = is_array( $preds ) ? self::acc_over_holdout( $private, $preds ) : null;
				} else {
					$priv = is_array( $preds ) ? self::r2_over_holdout( $private, $preds ) : null;
				}
				$standings[] = [ 'uid' => $u, 'priv' => $priv === null ? -INF : (float) $priv ];
			}
			usort( $standings, fn( $a, $b ) => $b['priv'] <=> $a['priv'] );
		}

		// Prize eligibility requires a VERIFIED solution — the ArtaCompete reviewer ran the member's code
		// and confirmed the score reproduces with no holdout leakage. The public board stays open to all;
		// this gates only the money. A member with no verified solution keeps their board rank but their
		// medal slot passes down. (If NO ONE verified — e.g. review off — this set is empty and no coin is
		// minted; the pool simply isn't awarded, never mis-paid.)
		$verified_uids = [];
		foreach ( Data::all( 'SELECT DISTINCT uid FROM ' . Data::t( 'aq_comp_subs' ) . ' WHERE comp_id = %d AND verified = 1', [ $cid ] ) as $vr ) {
			$verified_uids[ (int) $vr['uid'] ] = 1;
		}

		$bot     = (int) get_option( 'aq_artabot_uid', 0 );
		$owner   = (int) $c['owner_uid'];
		$podium  = [];
		foreach ( $standings as $st ) {
			if ( $st['priv'] <= 0 ) { continue; }                                        // must beat the mean on the private half
			$uid = (int) $st['uid'];
			if ( $uid === $bot || get_user_meta( $uid, '_aq_is_bot', true ) ) { continue; } // bot slot passes down
			if ( ! isset( $verified_uids[ $uid ] ) ) { continue; }                          // unverified solution → slot passes down
			$podium[] = $uid;
			if ( count( $podium ) >= count( self::PODIUM ) ) { break; }
		}
		// Integer coin shares that sum EXACTLY to the pool (floor the lower medals, remainder → 1st),
		// so a non-round pool never over- or under-distributes.
		$shares = [];
		$acc = 0;
		for ( $i = 1; $i < count( self::PODIUM ); $i++ ) { $shares[ $i ] = (int) floor( $prize * self::PODIUM[ $i ] ); $acc += $shares[ $i ]; }
		$shares[0] = $prize - $acc;

		// The prize is the operator's ₳ allocation: gold-backed coins MINTED to the winners at
		// settlement (a platform award, like a course prize pool — there is no losing party to debit).
		// Idempotent by ledger ref, so a re-run after a partial crash mints only the missing medals.
		$names = [];
		foreach ( $podium as $i => $uid ) {
			$coins = (int) ( $shares[ $i ] ?? 0 );
			if ( $coins <= 0 ) { continue; }
			$ref  = 'comp' . $cid . ':u' . $uid;
			// Guard by ref (credit_coins itself is not idempotent) — a re-run never double-mints a medal.
			if ( ! Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'comp' AND ref = %s", [ $ref ] ) ) {
				Economy::credit_coins( $uid, $coins, 'comp', $ref );
			}
			$names[] = self::name_of( $uid ) . ' (+' . $coins . "\xe2\x82\xb3)";  // named even when already paid
		}
		// Announce the podium on the official discussion thread (ArtaBot), once.
		$tid = (int) ( $c['thread_id'] ?? 0 );
		$bot_uid = $bot ?: $owner;
		if ( $tid && $bot_uid && $names ) {
			$body = 'Final results — ' . esc_html( (string) $c['title'] ) . ': '
				. implode( ' · ', array_map( 'esc_html', $names ) )
				. '. Congratulations, and thank you to every entrant. The leaderboard is now frozen.';
			$dup  = Data::col(
				'SELECT 1 FROM ' . Data::t( 'aq_comments' )
				. " WHERE context_type = 'thread' AND context_id = %d AND author_id = %d AND body LIKE %s",
				[ $tid, $bot_uid, 'Final results —%' ]
			);
			if ( ! $dup ) {
				Data::insert( 'aq_comments', [
					'context_type' => 'thread', 'context_id' => $tid, 'parent_id' => 0,
					'author_id' => $bot_uid, 'body' => $body, 'lang' => 'en', 'created' => Data::now(),
				] );
				Data::bump( 'aq_threads', [ 'id' => $tid ], 'comment_count', 1 );
			}
		}
		// Flip to closed only AFTER the podium is paid + announced. If anything above throws, the row
		// stays 'active' and the next daily settle_due retries — every payment is ref-idempotent, so the
		// retry mints only the missing medals. (submit() already rejects post-deadline entries, so an
		// still-active-past-deadline competition accepts no new submissions in the meantime.)
		Data::update( 'aq_competitions', [ 'status' => 'closed' ], [ 'id' => $cid ] );
	}
}
