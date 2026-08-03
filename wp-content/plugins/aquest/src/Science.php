<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaScience — the fully automated, AI-run review pipeline for Journal of Seasonality.
 *
 * Journal of Seasonality replaces human peer review with an end-to-end AI process. Every submission
 * MUST ship open DATA and open CODE; nothing is reviewed on description alone. A submission enters
 * a queue that the ArtaScience relay (the operator's laptop running headless `claude -p` at
 * `--effort max`, tools enabled, in a throwaway sandbox) drains: it clones the code, fetches the
 * data, ACTUALLY RUNS it, and checks whether the results reproduce the manuscript's claims. It then
 * returns a structured verdict — reproduced (yes/no), a score, and a detailed report — and either
 * accepts, rejects, or requests revisions. Revisions loop (the author resubmits; a new round is
 * reviewed) for as many rounds as it takes, up to MAX_ROUNDS. Like everything on ArtaQuest the whole
 * record is PUBLIC: every submission and every round of AI feedback is readable by anyone.
 *
 * Shape (mirrors Relay.php; the laptop POLLS because it can't accept inbound connections):
 *   1. POST research/submit (a signed-in member) → a row in aq_submissions (status 'submitted')
 *      with the open data + code URLs. Open data + code are REQUIRED — a submission without both is
 *      rejected at the door.
 *   2. The ArtaScience daemon long-polls POST relay/review/poll (X-AQ-Worker secret); it claims the
 *      oldest 'submitted' row (atomic UPDATE → 'reviewing') and runs the reproducibility review.
 *   3. It POSTs relay/review/complete with { reproduced, verdict, score, report }. We append an
 *      aq_paper_reviews row for the round and advance the submission: accept → 'accepted', reject →
 *      'rejected', revise → 'revisions-requested'.
 *   4. The author addresses the report and POSTs research/submissions/{id}/revise → round++ and
 *      status back to 'submitted', re-entering the queue. Repeat until accepted/rejected.
 *
 * The tables self-install (Notify/Relay pattern) so the feature is isolated from Schema::VERSION.
 */
final class Science {

	const TABLE_VERSION = '15'; // v15: thumb_url (generated article thumbnail). v14: aq_research_artifacts + dataset_id/model_id
	const MAX_ROUNDS    = 6;   // after this many rounds the reviewer must accept or reject (no endless revise)
	const STATUSES      = [ 'submitted', 'reviewing', 'revisions-requested', 'accepted', 'rejected', 'withdrawn' ];

	// The journals published on ArtaQuest. Every submission belongs to exactly one; ArtaScience reviews
	// each against its own scope. Adding a journal = adding a row here (slug → name/tagline/scope). The
	// `scope` line is injected verbatim into the reviewer's aims, so write it as the journal's remit.
	const DEFAULT_JOURNAL = 'seasonality';
	const JOURNALS = [
		'seasonality' => [
			'name'    => 'Journal of Seasonality',
			'tagline' => 'The rhythms hidden in open data',
			'scope'   => 'short, reproducible studies of seasonality and cyclical patterns — empirical discoveries in open data of any kind (search trends, markets, climate, biology, anything you can measure), and equally theoretical and simulation-only studies of cyclical structure. Theory and simulation papers are in scope on their own terms: they are judged on the reproducibility of their computations, machine-checkable claims and honest framing of what is constructed versus what is measured, not on the presence of measured data',
		],
		'educational-accessibility' => [
			'name'    => 'Educational Accessibility',
			'tagline' => 'Making learning reach everyone',
			'scope'   => 'short, reproducible studies that measure and improve the accessibility of education — readability and legibility, inclusive and universal design, disability and assistive-technology access, language and translation, affordability, and removing the barriers between people and learning — at any level, anywhere',
		],
	];

	/** Resolve a journal slug to its registry entry (with its slug), defaulting safely. */
	public static function journal( $slug ) {
		$slug = sanitize_key( (string) $slug );
		$j = self::JOURNALS[ $slug ] ?? self::JOURNALS[ self::DEFAULT_JOURNAL ];
		return [ 'slug' => isset( self::JOURNALS[ $slug ] ) ? $slug : self::DEFAULT_JOURNAL ] + $j;
	}
	/** The display name of a submission row's journal. */
	private static function jname( $row ) {
		return (string) self::journal( $row['journal'] ?? self::DEFAULT_JOURNAL )['name'];
	}

	/** GET research/journals — the journal registry + per-journal counts (the multi-journal hub). */
	public static function journals( $req ) {
		self::ensure_tables();
		global $wpdb;
		$t    = Data::t( 'aq_submissions' );
		$rows = $wpdb->get_results( "SELECT journal, status, COUNT(*) AS c FROM {$t} GROUP BY journal, status", ARRAY_A );
		$by   = [];
		foreach ( (array) $rows as $r ) { $by[ (string) $r['journal'] ][ (string) $r['status'] ] = (int) $r['c']; }
		$out = [];
		foreach ( self::JOURNALS as $slug => $j ) {
			$s = $by[ $slug ] ?? [];
			$out[] = [
				'slug'      => $slug,
				'name'      => $j['name'],
				'tagline'   => $j['tagline'],
				'scope'     => $j['scope'],
				'published' => (int) ( $s['accepted'] ?? 0 ),
				'in_review' => (int) ( ( $s['submitted'] ?? 0 ) + ( $s['reviewing'] ?? 0 ) + ( $s['revisions-requested'] ?? 0 ) ),
				'total'     => array_sum( array_map( 'intval', $s ) ),
			];
		}
		return [ 'journals' => $out ];
	}

	/** Self-installed storage — ArtaScience owns its tables. */
	public static function ensure_tables() {
		if ( get_option( 'aq_science_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		$subs    = $wpdb->prefix . 'aq_submissions';
		$revs    = $wpdb->prefix . 'aq_paper_reviews';
		dbDelta( "CREATE TABLE {$subs} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			journal VARCHAR(40) NOT NULL DEFAULT 'seasonality',
			title VARCHAR(300) NOT NULL DEFAULT '',
			abstract TEXT NULL,
			data_url VARCHAR(600) NOT NULL DEFAULT '',
			code_url VARCHAR(600) NOT NULL DEFAULT '',
			paper_url VARCHAR(600) NOT NULL DEFAULT '',
			dataset_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			model_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			status VARCHAR(24) NOT NULL DEFAULT 'submitted',
			round INT UNSIGNED NOT NULL DEFAULT 1,
			score INT NOT NULL DEFAULT 0,
			reproduced TINYINT(1) NOT NULL DEFAULT 0,
			doi VARCHAR(120) NOT NULL DEFAULT '',
			record_url VARCHAR(300) NOT NULL DEFAULT '',
			colab_url VARCHAR(300) NOT NULL DEFAULT '',
			kaggle_url VARCHAR(300) NOT NULL DEFAULT '',
			pdf_url VARCHAR(600) NOT NULL DEFAULT '',
			thumb_url VARCHAR(600) NOT NULL DEFAULT '',
			thread_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			notebook LONGTEXT NULL,
			body_html LONGTEXT NULL,
			charts LONGTEXT NULL,
			template_ok TINYINT(1) NOT NULL DEFAULT 1,
			consent TINYINT(1) NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			updated INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY status_id (status, id),
			KEY journal_status (journal, status, id)
		) {$charset};" );
		dbDelta( "CREATE TABLE {$revs} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			submission_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			round INT UNSIGNED NOT NULL DEFAULT 1,
			reproduced TINYINT(1) NOT NULL DEFAULT 0,
			verdict VARCHAR(12) NOT NULL DEFAULT 'revise',
			score INT NOT NULL DEFAULT 0,
			scores LONGTEXT NULL,
			report LONGTEXT NULL,
			model VARCHAR(60) NOT NULL DEFAULT '',
			effort VARCHAR(20) NOT NULL DEFAULT '',
			runtime_s INT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY sub_round (submission_id, round)
		) {$charset};" );
		// v14 — dbDelta SHOULD add the two prerequisite columns, but the SQLite dev integration has been
		// observed to silently skip an ADD COLUMN (Schema.php's long-standing gotcha). Add them explicitly
		// when absent — a no-op on MySQL where dbDelta already added them.
		foreach ( [
			'dataset_id' => 'dataset_id BIGINT UNSIGNED NOT NULL DEFAULT 0',
			'model_id'   => 'model_id BIGINT UNSIGNED NOT NULL DEFAULT 0',
			'thumb_url'  => "thumb_url VARCHAR(600) NOT NULL DEFAULT ''",
		] as $col => $def ) {
			if ( class_exists( '\\AQ\\Schema' ) && ! Schema::column_exists( $subs, $col ) ) {
				$wpdb->query( "ALTER TABLE {$subs} ADD COLUMN $def" );
			}
		}
		$arts = $wpdb->prefix . 'aq_research_artifacts';
		dbDelta( "CREATE TABLE {$arts} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			kind VARCHAR(12) NOT NULL DEFAULT 'dataset',
			title VARCHAR(200) NOT NULL DEFAULT '',
			description TEXT NULL,
			url VARCHAR(600) NOT NULL DEFAULT '',
			meta LONGTEXT NULL,
			status VARCHAR(12) NOT NULL DEFAULT 'ready',
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY kind_id (kind, id),
			KEY author_kind (author_id, kind, id)
		) {$charset};" );
		update_option( 'aq_science_table_version', self::TABLE_VERSION, true );
	}

	/**
	 * ONE-TIME relaunch purge (2026-07-02). The journals relaunched with Claude Fable 5 as the reviewer;
	 * every submission from before the relaunch — with its review rounds, discussion thread, and archived
	 * PDF — is removed so the public record starts clean. External artefacts already minted for old
	 * accepted papers (Zenodo DOIs, gists) are permanent by design and stay where they are. Bounded by a
	 * fixed cutoff baked in at write time, so a submission created AFTER this code existed is never
	 * touched, and option-gated so it runs exactly once per site. Points ledgers are append-only and are
	 * deliberately left untouched.
	 */
	const RESET_KEY    = 'aq_science_reset_20260702';
	const RESET_CUTOFF = 1782941405; // 2026-07-02 — anything created before this is pre-relaunch

	public static function reset_legacy() {
		if ( get_option( self::RESET_KEY ) ) { return; }
		self::ensure_tables();
		global $wpdb;
		$subs = Data::t( 'aq_submissions' );
		$revs = Data::t( 'aq_paper_reviews' );
		$up   = wp_upload_dir();
		foreach ( Data::all( "SELECT id, thread_id FROM {$subs} WHERE created < %d", [ self::RESET_CUTOFF ] ) as $r ) {
			$id  = (int) $r['id'];
			$tid = (int) $r['thread_id'];
			$wpdb->delete( $revs, [ 'submission_id' => $id ] );
			if ( $tid ) { // the article's discussion thread + its comments
				$wpdb->delete( Data::t( 'aq_threads' ), [ 'id' => $tid ] );
				$wpdb->delete( Data::t( 'aq_comments' ), [ 'context_type' => 'thread', 'context_id' => $tid ] );
			}
			if ( empty( $up['error'] ) ) { // the archived compiled PDF
				$f = $up['basedir'] . '/research-uploads/paper-' . $id . '.pdf';
				if ( is_file( $f ) ) { @unlink( $f ); }
			}
			$wpdb->delete( $subs, [ 'id' => $id ] );
		}
		update_option( self::RESET_KEY, (string) Data::now(), true );
	}

	/** A public http(s) URL we'll let the reviewer fetch/clone. Rejects localhost + private/reserved IPs
	 *  (defence-in-depth against SSRF — the daemon will curl/clone whatever this returns). */
	private static function is_url( $u ) {
		$u = trim( (string) $u );
		if ( $u === '' || strlen( $u ) > 600 || ! preg_match( '#^https?://[^\s]{4,}$#i', $u ) ) { return false; }
		// wp_parse_url returns an IPv6 host WITH its brackets ("[::1]"), and every test below expects a
		// bare address: "[::1]" matched no deny-list entry, failed FILTER_VALIDATE_IP so it was treated
		// as a HOSTNAME, then resolved to nothing — and "resolution yielded nothing" is the branch that
		// lets a URL through. So every IPv6 literal passed, including ::1 and the IPv4-mapped form of
		// the cloud-metadata address (http://[::ffff:169.254.169.254]/). Strip the brackets first and
		// the literal-IP branch does the job it was written to do.
		$host = strtolower( (string) wp_parse_url( $u, PHP_URL_HOST ) );
		if ( strlen( $host ) > 1 && $host[0] === '[' && substr( $host, -1 ) === ']' ) { $host = substr( $host, 1, -1 ); }
		if ( $host === '' || in_array( $host, [ 'localhost', '0.0.0.0', '::1', '::', '[::1]' ], true ) ) { return false; }
		$is_private = static fn( $ip ) => $ip && ! filter_var( $ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE );
		// A literal IP: reject directly if private/reserved.
		if ( filter_var( $host, FILTER_VALIDATE_IP ) ) { return ! $is_private( $host ); }
		// A hostname: resolve A + AAAA and reject if ANY address is private/reserved — closes the gap where a
		// public name points at an internal/cloud-metadata IP (the original check only ran on literal IPs).
		// Best-effort: if resolution yields nothing we don't block (the daemon sandboxes the fetch as backstop).
		$ips = is_array( $a = @gethostbynamel( $host ) ) ? $a : [];
		if ( function_exists( 'dns_get_record' ) ) {
			foreach ( (array) @dns_get_record( $host, DNS_AAAA ) as $r ) { if ( ! empty( $r['ipv6'] ) ) { $ips[] = $r['ipv6']; } }
		}
		foreach ( $ips as $ip ) { if ( $is_private( $ip ) ) { return false; } }
		return true;
	}

	/** POST research/upload (multipart, field 'file') — store an artefact (manuscript / code / data) in the
	 *  public uploads dir and return its URL, so an author can upload a file instead of hosting a URL. */
	public static function upload( $req ) {
		if ( Rest::throttle( 'aq_upload', 40, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$f = isset( $_FILES['file'] ) ? $_FILES['file'] : null;
		if ( ! $f || ! is_uploaded_file( (string) ( $f['tmp_name'] ?? '' ) ) ) { return Rest::err( 'no_file', 'No file received' ); }
		$size = (int) ( $f['size'] ?? 0 );
		if ( $size <= 0 ) { return Rest::err( 'empty', 'The file is empty' ); }
		if ( $size > 60 * 1024 * 1024 ) { return Rest::err( 'too_big', 'File exceeds 60 MB — host it and submit the URL instead' ); }
		$name = sanitize_file_name( (string) ( $f['name'] ?? 'file' ) );
		$ext  = strtolower( pathinfo( $name, PATHINFO_EXTENSION ) );
		$allowed = [ 'zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'txt',
			'md', 'pdf', 'ipynb', 'tex', 'bib', 'parquet', 'xlsx', 'xls', 'h5', 'hdf5', 'npz', 'nc', 'feather' ];
		if ( ! in_array( $ext, $allowed, true ) ) { return Rest::err( 'bad_type', 'Unsupported file type (.' . $ext . '). Allowed: a zipped project, or a data file (csv/json/parquet/…)' ); }
		$up = wp_upload_dir();
		if ( ! empty( $up['error'] ) ) { return Rest::err( 'failed', 'Upload directory unavailable', 500 ); }
		$dir = $up['basedir'] . '/research-uploads';
		if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		$fname = wp_unique_filename( $dir, $name );
		$dest  = $dir . '/' . $fname;
		if ( ! @move_uploaded_file( (string) $f['tmp_name'], $dest ) ) { return Rest::err( 'failed', 'Could not store the file', 500 ); }
		@chmod( $dest, 0644 );
		return [ 'url' => $up['baseurl'] . '/research-uploads/' . $fname, 'name' => $name, 'size' => $size ];
	}

	// ── Research artifacts — the dataset + model PREREQUISITES of every submission ────────────────
	// A manuscript can only be submitted once its open DATASET and its MODEL are registered, VALIDATED
	// platform artifacts: the dataset is fetched and format-sniffed; the model zip must carry the
	// journal's STANDARD REPRODUCTION CONTRACT — an entrypoint (reproduce.py or run.sh, invoked with the
	// dataset path as its one argument, writing results.json + the figures), requirements.txt, and the
	// author's declared key numbers in expected.json. The contract is what makes review reproduction
	// smooth and automated: the reviewer relay pre-runs it deterministically before each review round.

	/** POST research/dataset — register + validate an open dataset (prerequisite #1). */
	public static function dataset_create( $req ) { return self::artifact_create( $req, 'dataset' ); }
	/** POST research/model — register + validate a model bundle (prerequisite #2; must carry the contract). */
	public static function model_create( $req ) { return self::artifact_create( $req, 'model' ); }

	private static function artifact_create( $req, $kind ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_artifact', 20, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid   = get_current_user_id();
		$title = sanitize_text_field( (string) Rest::p( $req, 'title', '' ) );
		$desc  = sanitize_textarea_field( (string) Rest::p( $req, 'description', '' ) );
		$url   = trim( (string) Rest::p( $req, 'url', '' ) );
		if ( mb_strlen( $title ) < 4 ) { return Rest::err( 'bad_input', 'A name is required (≥4 characters)' ); }
		if ( ! self::is_url( $url ) )  { return Rest::err( 'bad_input', 'A public https URL is required (or upload the file first)' ); }
		$meta = $kind === 'dataset' ? self::validate_dataset( $url ) : self::validate_model( $url );
		if ( $meta instanceof \WP_REST_Response || is_wp_error( $meta ) ) { return $meta; } // validation error (Rest::err)
		$id = Data::insert( 'aq_research_artifacts', [
			'author_id'   => $uid,
			'kind'        => $kind,
			'title'       => mb_substr( $title, 0, 200 ),
			'description' => mb_substr( $desc, 0, 4000 ),
			'url'         => $url,
			'meta'        => wp_json_encode( $meta ),
			'status'      => 'ready',
			'created'     => Data::now(),
		] );
		if ( ! $id ) { return Rest::err( 'failed', 'Could not register the artifact', 500 ); }
		return self::artifact_card( Data::one( 'SELECT * FROM ' . Data::t( 'aq_research_artifacts' ) . ' WHERE id = %d', [ $id ] ) );
	}

	/** GET research/artifacts — public keyset list of registered datasets/models (transparency + the
	 *  submit form's pickers; filter by kind and/or author). */
	public static function artifacts( $req ) {
		self::ensure_tables();
		$cursor  = (int) Rest::p( $req, 'cursor', 0 );
		$kind    = sanitize_key( (string) Rest::p( $req, 'kind', '' ) );
		$aid     = (int) Rest::p( $req, 'author_id', 0 );
		$clauses = [];
		$args    = [];
		if ( in_array( $kind, [ 'dataset', 'model' ], true ) ) { $clauses[] = 'kind = %s'; $args[] = $kind; }
		if ( $aid ) { $clauses[] = 'author_id = %d'; $args[] = $aid; }
		[ $rows, $next ] = Data::page( 'aq_research_artifacts', implode( ' AND ', $clauses ), $args, $cursor, 30 );
		$names = self::author_names( $rows );
		return [ 'items' => array_map( static fn( $r ) => self::artifact_card( $r, $names ), $rows ), 'next' => $next ];
	}

	private static function artifact_card( $row, $names = null ) {
		$aid = (int) $row['author_id'];
		if ( is_array( $names ) ) {
			$name = is_array( $names[ $aid ] ?? null ) ? (string) $names[ $aid ]['name'] : '';
			$slug = is_array( $names[ $aid ] ?? null ) ? (string) $names[ $aid ]['slug'] : '';
		} else {
			$u = $aid ? get_userdata( $aid ) : null;
			$name = $u ? (string) $u->display_name : '';
			$slug = $u ? (string) $u->user_nicename : '';
		}
		$meta = json_decode( (string) ( $row['meta'] ?? '' ), true );
		return [
			'id'          => (int) $row['id'],
			'kind'        => (string) $row['kind'],
			'title'       => (string) $row['title'],
			'description' => (string) ( $row['description'] ?? '' ),
			'url'         => (string) $row['url'],
			'meta'        => is_array( $meta ) ? $meta : [],
			'author'      => $aid ? [ 'id' => $aid, 'name' => $name, 'slug' => $slug ] : null,
			'created'     => (int) $row['created'],
		];
	}

	/** Resolve + authorise a submission's two prerequisites: the ids must be the CALLER'S own registered
	 *  'ready' dataset + model artifacts. Returns [ 'dataset' => row, 'model' => row ] or WP_Error. */
	private static function own_artifacts( $uid, $dataset_id, $model_id ) {
		$t = Data::t( 'aq_research_artifacts' );
		$ds = $dataset_id ? Data::one( "SELECT * FROM {$t} WHERE id = %d", [ $dataset_id ] ) : null;
		$md = $model_id ? Data::one( "SELECT * FROM {$t} WHERE id = %d", [ $model_id ] ) : null;
		if ( ! $ds || $ds['kind'] !== 'dataset' || (int) $ds['author_id'] !== (int) $uid || $ds['status'] !== 'ready' ) {
			return Rest::err( 'no_dataset', 'Register your open DATASET first — every manuscript is built on a registered dataset (create it in the submit form, or POST research/dataset)', 400 );
		}
		if ( ! $md || $md['kind'] !== 'model' || (int) $md['author_id'] !== (int) $uid || $md['status'] !== 'ready' ) {
			return Rest::err( 'no_model', 'Register your MODEL bundle first — a zip carrying the standard reproduction contract (reproduce.py or run.sh + requirements.txt + expected.json)', 400 );
		}
		return [ 'dataset' => $ds, 'model' => $md ];
	}

	/** Fetch + sniff an open dataset: must be directly reachable and parse as data. Meta array or WP_Error. */
	private static function validate_dataset( $url ) {
		$cap  = 2 * 1024 * 1024;
		$path = strtolower( (string) wp_parse_url( $url, PHP_URL_PATH ) );
		$ext  = pathinfo( $path, PATHINFO_EXTENSION );
		// SSRF: is_url already resolved + rejected private hosts; no redirects (a hop could re-point internally).
		$r = wp_remote_get( $url, [ 'timeout' => 30, 'redirection' => 0, 'limit_response_size' => $cap ] );
		if ( is_wp_error( $r ) || (int) wp_remote_retrieve_response_code( $r ) >= 400 ) {
			return Rest::err( 'unreachable', 'Could not fetch the dataset — a DIRECT public link is required (no redirects). Uploading the file to the journal works best.', 400 );
		}
		$body = (string) wp_remote_retrieve_body( $r );
		$len  = (int) wp_remote_retrieve_header( $r, 'content-length' );
		$meta = [ 'format' => $ext !== '' ? $ext : 'data', 'bytes' => $len ?: strlen( $body ) ];
		if ( in_array( $ext, [ 'csv', 'tsv' ], true ) ) {
			$lines = preg_split( '/\r\n|\n|\r/', $body );
			$cols  = str_getcsv( (string) ( $lines[0] ?? '' ), $ext === 'tsv' ? "\t" : ',' );
			if ( count( $cols ) < 2 || count( $lines ) < 2 || trim( (string) ( $lines[1] ?? '' ) ) === '' ) {
				return Rest::err( 'bad_data', 'The CSV/TSV must have a header row and at least one data row', 400 );
			}
			$meta['columns'] = array_map( static fn( $c ) => mb_substr( sanitize_text_field( (string) $c ), 0, 60 ), array_slice( $cols, 0, 60 ) );
		} elseif ( in_array( $ext, [ 'json', 'jsonl', 'ndjson' ], true ) ) {
			$probe = $ext === 'json' ? $body : (string) strtok( $body, "\n" );
			// Only reject a parse failure we can trust: a 'json' file truncated at the size cap won't parse.
			if ( json_decode( $probe, true ) === null && strlen( $body ) < $cap ) {
				return Rest::err( 'bad_data', 'The JSON did not parse', 400 );
			}
		}
		return $meta;
	}

	/** Download the model zip and verify the STANDARD REPRODUCTION CONTRACT inside it: an entrypoint
	 *  (reproduce.py or run.sh), requirements.txt (for python), and a numeric expected.json — the
	 *  author's own declared key numbers, machine-compared by the relay's pre-flight run. */
	private static function validate_model( $url ) {
		if ( ! class_exists( '\\ZipArchive' ) ) { return Rest::err( 'unsupported', 'Bundle validation unavailable on this host', 500 ); }
		require_once ABSPATH . 'wp-admin/includes/file.php';
		$tmp = wp_tempnam( 'aq-model' );
		$r = wp_remote_get( $url, [ 'timeout' => 120, 'redirection' => 0, 'stream' => true, 'filename' => $tmp, 'limit_response_size' => 120 * 1024 * 1024 ] );
		if ( is_wp_error( $r ) || (int) wp_remote_retrieve_response_code( $r ) >= 400 ) {
			@unlink( $tmp );
			return Rest::err( 'unreachable', 'Could not fetch the model bundle — a DIRECT public zip link is required (no redirects). Uploading the zip to the journal works best.', 400 );
		}
		$zip = new \ZipArchive();
		if ( $zip->open( $tmp ) !== true ) {
			@unlink( $tmp );
			return Rest::err( 'bad_zip', 'The model bundle must be a ZIP archive containing your code (GitHub: use “Download ZIP”, or upload a zip)', 400 );
		}
		$entry = '';
		$root  = '';
		$files = [];
		for ( $i = 0; $i < min( $zip->numFiles, 4000 ); $i++ ) {
			$n = (string) $zip->getNameIndex( $i );
			if ( count( $files ) < 40 && substr( $n, -1 ) !== '/' ) { $files[] = mb_substr( $n, 0, 200 ); }
			$b = basename( $n );
			if ( $entry === '' && ( $b === 'reproduce.py' || $b === 'run.sh' ) && substr_count( $n, '/' ) <= 3 ) {
				$entry = $b;
				$root  = substr( $n, 0, strlen( $n ) - strlen( $b ) );
			}
		}
		$expected_raw = $entry !== '' ? $zip->getFromName( $root . 'expected.json', 512 * 1024 ) : false;
		$has_req      = $entry !== '' && $zip->locateName( $root . 'requirements.txt' ) !== false;
		$zip->close();
		@unlink( $tmp );
		if ( $entry === '' ) {
			return Rest::err( 'no_entrypoint', 'The bundle must carry the standard reproduction contract: a reproduce.py (or run.sh) that takes the dataset path as its one argument and writes results.json + the figures', 400 );
		}
		if ( $entry === 'reproduce.py' && ! $has_req ) {
			return Rest::err( 'no_requirements', 'Include requirements.txt next to reproduce.py (empty is fine if you only use the standard library)', 400 );
		}
		$expected = json_decode( (string) $expected_raw, true );
		$nums = [];
		if ( is_array( $expected ) ) {
			foreach ( array_slice( $expected, 0, 100, true ) as $k => $v ) {
				if ( is_numeric( $v ) ) { $nums[ mb_substr( sanitize_text_field( (string) $k ), 0, 80 ) ] = 0 + $v; }
			}
		}
		if ( ! $nums ) {
			return Rest::err( 'no_expected', 'Include expected.json next to the entrypoint — a flat JSON object of the key numbers your paper claims (e.g. {"median_rho": 0.51}); the pre-flight compares the run against it', 400 );
		}
		return [ 'entrypoint' => $entry, 'root' => mb_substr( $root, 0, 200 ), 'files' => $files, 'expected' => $nums, 'requirements' => $has_req ];
	}

	// ── member-facing ────────────────────────────────────────────────────────────

	/** POST research/submit — create a submission. A registered DATASET + MODEL are both REQUIRED. */
	public static function submit( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_submit', 5, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid      = get_current_user_id();
		$title    = sanitize_text_field( (string) Rest::p( $req, 'title', '' ) );
		$abstract = sanitize_textarea_field( (string) Rest::p( $req, 'abstract', '' ) );
		$paper_url = trim( (string) Rest::p( $req, 'paper_url', '' ) );
		$consent = ! empty( Rest::p( $req, 'consent', false ) );
		$journal = self::journal( Rest::p( $req, 'journal', self::DEFAULT_JOURNAL ) )['slug'];
		if ( mb_strlen( $title ) < 8 )        { return Rest::err( 'bad_input', 'A descriptive title is required (≥8 characters)' ); }
		if ( mb_strlen( $abstract ) < 40 )    { return Rest::err( 'bad_input', 'An abstract is required (≥40 characters)' ); }
		if ( mb_strlen( $abstract ) > 20000 ) { return Rest::err( 'too_long', 'The abstract is too long (max 20,000 characters)' ); }
		if ( ! self::is_url( $paper_url ) )    { return Rest::err( 'no_paper', 'A manuscript is required — a zipped LaTeX project (provide a public URL or upload the file)' ); }
		if ( ! $consent )                      { return Rest::err( 'no_consent', 'Please accept the publication agreement to submit' ); }
		// PREREQUISITES: the manuscript must be built on the author's own REGISTERED dataset + model
		// artifacts (created + validated via research/dataset + research/model before submitting).
		$art = self::own_artifacts( $uid, (int) Rest::p( $req, 'dataset_id', 0 ), (int) Rest::p( $req, 'model_id', 0 ) );
		if ( $art instanceof \WP_REST_Response || is_wp_error( $art ) ) { return $art; }
		$now = Data::now();
		$id  = Data::insert( 'aq_submissions', [
			'author_id' => $uid,
			'journal'   => $journal,
			'title'     => mb_substr( $title, 0, 300 ),
			'abstract'  => $abstract,
			'data_url'  => (string) $art['dataset']['url'],
			'code_url'  => (string) $art['model']['url'],
			'paper_url' => $paper_url,
			'dataset_id' => (int) $art['dataset']['id'],
			'model_id'   => (int) $art['model']['id'],
			'consent'   => 1,
			'status'    => 'submitted',
			'round'     => 1,
			'created'   => $now,
			'updated'   => $now,
		] );
		if ( ! $id ) { return Rest::err( 'failed', 'Could not create the submission', 500 ); }
		return [ 'id' => $id, 'status' => 'submitted', 'round' => 1 ];
	}

	/** POST research/submissions/{id}/revise — author resubmits after a revise verdict → new round. */
	public static function revise( $req ) {
		self::ensure_tables();
		$id  = Rest::pint( $req, 'id' );
		$uid = get_current_user_id();
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_submissions' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $row ) { return Rest::err( 'not_found', 'Submission not found', 404 ); }
		if ( (int) $row['author_id'] !== $uid ) { return Rest::err( 'forbidden', 'Only the author can revise', 403 ); }
		if ( ! in_array( $row['status'], [ 'revisions-requested', 'rejected' ], true ) ) {
			return Rest::err( 'bad_state', 'This submission is not awaiting a revision', 409 );
		}
		if ( (int) $row['round'] >= self::MAX_ROUNDS ) {
			return Rest::err( 'max_rounds', 'This submission has reached the maximum number of review rounds', 409 );
		}
		// Allow updating the artefacts + abstract with the revision. The dataset/model prerequisites may be
		// swapped for other REGISTERED artifacts the author owns (defaulting to the submission's own).
		$paper_url = trim( (string) Rest::p( $req, 'paper_url', $row['paper_url'] ) );
		$abstract  = sanitize_textarea_field( (string) Rest::p( $req, 'abstract', $row['abstract'] ) );
		if ( mb_strlen( $abstract ) > 20000 ) { return Rest::err( 'too_long', 'The abstract is too long (max 20,000 characters)' ); }
		if ( ! self::is_url( $paper_url ) ) { return Rest::err( 'bad_input', 'A LaTeX manuscript URL is required' ); }
		$art = self::own_artifacts( $uid,
			(int) Rest::p( $req, 'dataset_id', (int) ( $row['dataset_id'] ?? 0 ) ),
			(int) Rest::p( $req, 'model_id', (int) ( $row['model_id'] ?? 0 ) ) );
		if ( $art instanceof \WP_REST_Response || is_wp_error( $art ) ) { return $art; }
		Data::update( 'aq_submissions', [
			'abstract'  => $abstract,
			'data_url'  => (string) $art['dataset']['url'],
			'code_url'  => (string) $art['model']['url'],
			'paper_url' => $paper_url,
			'dataset_id' => (int) $art['dataset']['id'],
			'model_id'   => (int) $art['model']['id'],
			'status'    => 'submitted',
			'round'    => (int) $row['round'] + 1,
			'updated'  => Data::now(),
		], [ 'id' => $id ] );
		return [ 'id' => $id, 'status' => 'submitted', 'round' => (int) $row['round'] + 1 ];
	}

	/** POST research/submissions/{id}/withdraw — the author pulls a submission (not once accepted). */
	public static function withdraw( $req ) {
		self::ensure_tables();
		$id  = Rest::pint( $req, 'id' );
		$uid = get_current_user_id();
		$row = Data::one( 'SELECT author_id, status FROM ' . Data::t( 'aq_submissions' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $row ) { return Rest::err( 'not_found', 'Submission not found', 404 ); }
		if ( (int) $row['author_id'] !== $uid ) { return Rest::err( 'forbidden', 'Only the author can withdraw', 403 ); }
		if ( in_array( $row['status'], [ 'reviewing', 'accepted', 'withdrawn' ], true ) ) {
			return Rest::err( 'bad_state', 'This submission cannot be withdrawn while it is under review or once accepted — wait for the verdict', 409 );
		}
		Data::update( 'aq_submissions', [ 'status' => 'withdrawn', 'updated' => Data::now() ], [ 'id' => $id ] );
		return [ 'id' => $id, 'status' => 'withdrawn' ];
	}

	/** GET research/submissions — public keyset list (radical transparency). */
	public static function list( $req ) {
		self::ensure_tables();
		$cursor = (int) Rest::p( $req, 'cursor', 0 );
		$status = sanitize_key( (string) Rest::p( $req, 'status', '' ) );
		$journal = sanitize_key( (string) Rest::p( $req, 'journal', '' ) );
		$clauses = [];
		$args    = [];
		if ( $status && in_array( $status, self::STATUSES, true ) ) { $clauses[] = 'status = %s'; $args[] = $status; }
		if ( $journal && isset( self::JOURNALS[ $journal ] ) )      { $clauses[] = 'journal = %s'; $args[] = $journal; }
		$where = implode( ' AND ', $clauses );
		[ $rows, $next ] = Data::page( 'aq_submissions', $where, $args, $cursor, 30 );
		$names = self::author_names( $rows );
		return [ 'items' => array_map( static fn( $r ) => self::card( $r, $names ), $rows ), 'next' => $next ];
	}

	/** id → [ name, slug ] for a set of rows, in ONE query (avoids an N+1 over get_userdata). */
	private static function author_names( $rows ) {
		$ids = array_values( array_unique( array_filter( array_map( static fn( $r ) => (int) $r['author_id'], $rows ) ) ) );
		if ( ! $ids ) { return []; }
		$names = [];
		foreach ( get_users( [ 'include' => $ids, 'fields' => [ 'ID', 'display_name', 'user_nicename' ] ] ) as $u ) {
			$names[ (int) $u->ID ] = [ 'name' => $u->display_name, 'slug' => $u->user_nicename ];
		}
		return $names;
	}

	/** GET research/submissions/{id} — public detail + every round of AI review. */
	public static function get( $req ) {
		self::ensure_tables();
		$id  = Rest::pint( $req, 'id' );
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_submissions' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $row ) { return Rest::err( 'not_found', 'Submission not found', 404 ); }
		$reviews = Data::all( 'SELECT * FROM ' . Data::t( 'aq_paper_reviews' ) . ' WHERE submission_id = %d ORDER BY round ASC, id ASC', [ $id ] );
		$out = self::card( $row );
		$out['abstract']  = (string) $row['abstract'];
		$out['data_url']  = (string) $row['data_url'];
		$out['code_url']  = (string) $row['code_url'];
		$out['paper_url'] = (string) $row['paper_url'];
		$out['notebook']  = (string) ( $row['notebook'] ?? '' ); // the reproduction notebook JSON (inline preview)
		$out['body_html'] = (string) ( $row['body_html'] ?? '' ); // the sanitised full-text article HTML (reader)
		$out['charts']    = (string) ( $row['charts'] ?? '' );    // interactive chart specs (JSON array) for the reader
		$out['reviews']  = array_map( static function ( $r ) {
			return [
				'round'      => (int) $r['round'],
				'reproduced' => (bool) $r['reproduced'],
				'verdict'    => (string) $r['verdict'],
				'score'      => (int) $r['score'],
				'scores'     => ( $sc = json_decode( (string) ( $r['scores'] ?? '' ), true ) ) && is_array( $sc ) ? $sc : null,
				'report'     => (string) $r['report'],
				'model'      => (string) ( $r['model'] ?? '' ),
				'effort'     => (string) ( $r['effort'] ?? '' ),
				'runtime_s'  => (int) ( $r['runtime_s'] ?? 0 ),
				'created'    => (int) $r['created'],
			];
		}, $reviews );
		return $out;
	}

	private static function card( $row, $names = null ) {
		$aid  = (int) $row['author_id'];
		if ( is_array( $names ) ) {
			$name = is_array( $names[ $aid ] ?? null ) ? (string) $names[ $aid ]['name'] : '';
			$slug = is_array( $names[ $aid ] ?? null ) ? (string) $names[ $aid ]['slug'] : '';
		} else {
			$u = $aid ? get_userdata( $aid ) : null;
			$name = $u ? (string) $u->display_name : '';
			$slug = $u ? (string) $u->user_nicename : '';
		}
		$jrnl = self::journal( $row['journal'] ?? self::DEFAULT_JOURNAL );
		return [
			'id'         => (int) $row['id'],
			'journal'      => $jrnl['slug'],
			'journal_name' => $jrnl['name'],
			'title'      => (string) $row['title'],
			'status'     => (string) $row['status'],
			'round'      => (int) $row['round'],
			'score'      => (int) $row['score'],
			'reproduced' => (bool) $row['reproduced'],
			'doi'        => (string) ( $row['doi'] ?? '' ),
			'record_url' => (string) ( $row['record_url'] ?? '' ),
			'colab_url'  => (string) ( $row['colab_url'] ?? '' ),   // legacy rows only
			'kaggle_url' => (string) ( $row['kaggle_url'] ?? '' ),
			'pdf_url'    => (string) ( $row['pdf_url'] ?? '' ),
			'thumb_url'  => (string) ( $row['thumb_url'] ?? '' ),
			'thread_id'  => (int) ( $row['thread_id'] ?? 0 ),
			'dataset_id' => (int) ( $row['dataset_id'] ?? 0 ),
			'model_id'   => (int) ( $row['model_id'] ?? 0 ),
			'template_ok' => (bool) ( $row['template_ok'] ?? 1 ),
			'author'     => $aid ? [ 'id' => $aid, 'name' => $name, 'slug' => $slug ] : null,
			'created'    => (int) $row['created'],
			'updated'    => (int) $row['updated'],
		];
	}

	// ── ArtaScience daemon-facing (auth: 'worker') ─────────────────────────────────

	/** POST relay/review/poll — claim the oldest submission awaiting review → the review brief. */
	public static function review_poll( $req ) {
		self::ensure_tables();
		set_transient( 'aq_science_beat', time(), 120 ); // liveness, like the chat relay's heartbeat
		// Re-queue reviews orphaned by a crashed/killed daemon (claimed but never completed) so a round
		// is never silently lost. 2h is far longer than any real review (the daemon caps itself at ~30m).
		// Throttled to ~once/min so it isn't a write on every (20s) poll.
		global $wpdb;
		if ( ! get_transient( 'aq_science_reclaim' ) ) {
			set_transient( 'aq_science_reclaim', 1, 60 );
			$wpdb->query( $wpdb->prepare(
				'UPDATE ' . Data::t( 'aq_submissions' ) . " SET status = 'submitted' WHERE status = 'reviewing' AND updated < %d",
				Data::now() - 7200 ) );
		}
		// Atomically claim the oldest 'submitted' row (the conditional UPDATE is the lock).
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_submissions' ) . " WHERE status = 'submitted' ORDER BY id ASC LIMIT 1" );
		if ( ! $row ) { return [ 'job' => null ]; }
		$got = Data::update( 'aq_submissions', [ 'status' => 'reviewing', 'updated' => Data::now() ], [ 'id' => (int) $row['id'], 'status' => 'submitted' ] );
		if ( ! $got ) { return [ 'job' => null ]; } // lost the race
		// EVERY ROUND IS BLIND (operator rule 2026-07-10): the brief deliberately carries NO prior rounds'
		// reports — the reviewer judges each revision independently, from ONLY the manuscript + code + data
		// (earlier rounds stay public on the article page; they are simply never fed back into a review).
		$au = get_userdata( (int) $row['author_id'] );
		$jrnl = self::journal( $row['journal'] ?? self::DEFAULT_JOURNAL );
		return [ 'job' => [
			'id'        => (int) $row['id'],
			'round'     => (int) $row['round'],
			'max_rounds'=> self::MAX_ROUNDS,
			'journal'      => $jrnl['slug'],
			'journal_name' => $jrnl['name'],
			'journal_scope'=> $jrnl['scope'],
			'author'    => $au ? $au->display_name : '',
			'title'     => (string) $row['title'],
			'abstract'  => (string) $row['abstract'],
			'paper_url' => (string) $row['paper_url'],
			'data_url'  => (string) $row['data_url'],
			'code_url'  => (string) $row['code_url'],
			// The model artifact's STANDARD REPRODUCTION CONTRACT (entrypoint + the author's declared
			// numbers) — the relay pre-runs it deterministically before the reviewer starts.
			'contract'  => self::contract_for( (int) ( $row['model_id'] ?? 0 ) ),
		] ];
	}

	/** The reproduction contract stored on a model artifact ({ entrypoint, expected }), or null. */
	private static function contract_for( $model_id ) {
		if ( ! $model_id ) { return null; }
		$md = Data::one( 'SELECT meta FROM ' . Data::t( 'aq_research_artifacts' ) . ' WHERE id = %d', [ $model_id ] );
		$m  = $md ? json_decode( (string) $md['meta'], true ) : null;
		if ( ! is_array( $m ) || empty( $m['entrypoint'] ) ) { return null; }
		return [ 'entrypoint' => (string) $m['entrypoint'], 'expected' => (array) ( $m['expected'] ?? [] ) ];
	}

	/**
	 * POST relay/review/complete { id, round, reproduced, verdict, score, report } — record the
	 * round's verdict and advance the submission. verdict ∈ accept|revise|reject. A 'revise' at the
	 * final round is coerced to 'reject' (no endless loop). Idempotent on (id, round): a duplicate
	 * post for a round already recorded is ignored.
	 */
	public static function review_complete( $req ) {
		self::ensure_tables();
		$id      = (int) Rest::p( $req, 'id', 0 );
		$round   = (int) Rest::p( $req, 'round', 0 );
		$row     = $id ? Data::one( 'SELECT * FROM ' . Data::t( 'aq_submissions' ) . ' WHERE id = %d', [ $id ] ) : null;
		if ( ! $row ) { return Rest::err( 'not_found', 'Submission not found', 404 ); }
		if ( $row['status'] !== 'reviewing' ) { return [ 'ok' => true, 'note' => 'not in review' ]; }
		// The round under review is the row's own round (only `revise` bumps it). Trust the server's value,
		// not the worker's request, so a buggy/replayed POST can't insert a second row for a bogus round.
		$round = (int) $row['round'];
		$dup = Data::one( 'SELECT id FROM ' . Data::t( 'aq_paper_reviews' ) . ' WHERE submission_id = %d AND round = %d', [ $id, $round ] );
		if ( $dup ) { return [ 'ok' => true, 'note' => 'round already recorded' ]; }

		$verdict    = in_array( Rest::p( $req, 'verdict', 'revise' ), [ 'accept', 'revise', 'reject' ], true ) ? (string) Rest::p( $req, 'verdict', 'revise' ) : 'revise';
		$reproduced = ! empty( Rest::p( $req, 'reproduced', false ) ) ? 1 : 0;
		$score      = max( 0, min( 100, (int) Rest::p( $req, 'score', 0 ) ) );
		$report     = (string) Rest::p( $req, 'report', '' );
		if ( $verdict === 'accept' && ! $reproduced ) { $verdict = 'revise'; } // never accept what didn't reproduce
		if ( $verdict === 'revise' && $round >= self::MAX_ROUNDS ) { $verdict = 'reject'; }
		// CRASH-SAFE TERMINAL STATE. If the row already carries a permanent DOI, review_publish has already
		// minted + self-persisted it — an irreversible publication. So if a 'complete' was ever lost and the
		// row was reclaimed + re-reviewed 2h later, a fresh (non-deterministic) verdict must NOT downgrade an
		// already-published paper: force the recorded verdict to accept so status, points and the discussion
		// thread converge on the published reality. Idempotent — a normal accept is unaffected.
		if ( (string) ( $row['doi'] ?? '' ) !== '' ) { $verdict = 'accept'; $reproduced = 1; }

		// Reviewer transparency: which model, at what effort, and how long it ran (the journal's whole pitch
		// is AI review, so we record + publish exactly what produced each verdict).
		$model  = sanitize_text_field( (string) Rest::p( $req, 'model', '' ) );
		$effort = sanitize_text_field( (string) Rest::p( $req, 'effort', '' ) );
		$runtime = max( 0, (int) Rest::p( $req, 'runtime_s', 0 ) );
		// Transparent per-axis rubric breakdown (the reviewer scores 7 weighted axes 0-100). Accept either a
		// decoded object or a JSON string; keep only the known axes, bounded — store as JSON ('' if omitted).
		$axes  = [ 'reproducibility', 'honesty', 'communication', 'visualisation', 'accessibility', 'references', 'significance' ];
		$rawsc = Rest::p( $req, 'scores', [] );
		if ( is_string( $rawsc ) ) { $rawsc = json_decode( $rawsc, true ); }
		$sc = [];
		if ( is_array( $rawsc ) ) { foreach ( $axes as $k ) { if ( isset( $rawsc[ $k ] ) && is_numeric( $rawsc[ $k ] ) ) { $sc[ $k ] = max( 0, min( 100, (int) round( $rawsc[ $k ] ) ) ); } } }
		Data::insert( 'aq_paper_reviews', [
			'submission_id' => $id,
			'round'         => $round,
			'reproduced'    => $reproduced,
			'verdict'       => $verdict,
			'score'         => $score,
			'scores'        => $sc ? wp_json_encode( $sc ) : '',
			'report'        => $report,
			'model'         => mb_substr( $model, 0, 60 ),
			'effort'        => mb_substr( $effort, 0, 20 ),
			'runtime_s'     => $runtime,
			'created'       => Data::now(),
		] );
		$status = $verdict === 'accept' ? 'accepted' : ( $verdict === 'reject' ? 'rejected' : 'revisions-requested' );
		// On accept the reviewer may also have minted a permanent DOI for the manuscript (Zenodo/DataCite)
		// and published a one-click reproduction notebook (gist → Colab), whose JSON we store for the
		// inline preview on the article page.
		$doi = $verdict === 'accept' ? sanitize_text_field( (string) Rest::p( $req, 'doi', '' ) ) : '';
		$rec = $verdict === 'accept' ? esc_url_raw( (string) Rest::p( $req, 'record_url', '' ) ) : '';
		$colab = $verdict === 'accept' ? esc_url_raw( (string) Rest::p( $req, 'colab_url', '' ) ) : '';
		$nb  = $verdict === 'accept' ? (string) Rest::p( $req, 'notebook', '' ) : '';
		// Did the manuscript use the journal LaTeX template? (the reviewer reports it; we warn the author if not)
		$update = [ 'status' => $status, 'score' => $score, 'reproduced' => $reproduced,
			'template_ok' => empty( Rest::p( $req, 'template_ok', 1 ) ) ? 0 : 1, 'updated' => Data::now() ];
		if ( $doi !== '' ) { $update['doi'] = mb_substr( $doi, 0, 120 ); $update['record_url'] = mb_substr( $rec, 0, 300 ); }
		if ( $colab !== '' ) { $update['colab_url'] = mb_substr( $colab, 0, 300 ); }
		// Store the notebook only if it validates as a bounded notebook (rendered on the public article page).
		$nb = self::clean_notebook( $nb );
		if ( $nb !== '' ) { $update['notebook'] = $nb; }
		// The reviewer-rendered full-text article HTML (sanitised) — the Nature-style reader + crawlable text.
		$body = $verdict === 'accept' ? self::clean_body_html( (string) Rest::p( $req, 'body_html', '' ) ) : '';
		if ( $body !== '' ) { $update['body_html'] = $body; }
		$charts = $verdict === 'accept' ? self::clean_charts( (string) Rest::p( $req, 'charts', '' ) ) : '';
		if ( $charts !== '' ) { $update['charts'] = $charts; }
		// On publication, open a real discussion thread for the article (the journal's per-article comments
		// reuse the aq_threads model) and remember its numeric id. Idempotent — only when not already opened.
		if ( $status === 'accepted' && ! (int) ( $row['thread_id'] ?? 0 ) ) {
			$tid = (int) Data::insert( 'aq_threads', [
				'author_id' => (int) $row['author_id'],
				'title'     => (string) $row['title'],
				'body'      => 'Discussion of “' . (string) $row['title'] . '”, published in ' . self::jname( $row ) . '. Questions, replications, and critiques welcome — every comment is public.',
				'lang'      => 'en',
				'topic'     => 'research',
				'created'   => Data::now(),
			] );
			if ( $tid ) { $update['thread_id'] = $tid; }
		}
		Data::update( 'aq_submissions', $update, [ 'id' => $id ] );
		// On publication, award the author 100 lifetime points — idempotent by ref so a retried complete
		// (or a re-review after a lost response) never double-awards. Counts toward the global standing/tier.
		if ( $status === 'accepted' && class_exists( '\\AQ\\Economy' ) && method_exists( '\\AQ\\Economy', 'award_points' ) ) {
			try { Economy::award_points( (int) $row['author_id'], 100, 'learn', 'research_pub:' . $id ); } catch ( \Throwable $e ) {}
		}
		// An accepted paper enters the season's PAPER Challenge (the unified challenge frame —
		// hearts leaderboard, pot, certificate). No coin fee (the journal charges none), so the
		// entry adds presence, not pot; idempotent inside enter(). Fail-open — never blocks a review.
		if ( $status === 'accepted' && class_exists( '\\AQ\\Challenges' ) ) {
			try { Challenges::enter( 'paper', (int) $id, (int) $row['author_id'], 0 ); } catch ( \Throwable $e ) {}
		}
		// Tell the author the round is in (best-effort; Notify is fail-open).
		if ( class_exists( '\\AQ\\Notify' ) && method_exists( '\\AQ\\Notify', 'push' ) ) {
			$jn  = self::jname( $row );
			$msg = $status === 'accepted' ? 'Your ' . $jn . ' submission was accepted'
				: ( $status === 'rejected' ? 'Your ' . $jn . ' submission was not accepted'
				: 'ArtaScience requested revisions on your submission' );
			try { Notify::push( (int) $row['author_id'], 'research', $msg, '', '/research/?submission=' . $id ); } catch ( \Throwable $e ) {}
		}
		return [ 'ok' => true, 'status' => $status, 'verdict' => $verdict ];
	}

	/** POST relay/review/release {id} — the daemon hands a claimed review back on graceful shutdown, so it
	 *  re-queues instantly instead of waiting for the 2h reclaim. Only flips 'reviewing' → 'submitted'.
	 *  With {heartbeat:1} it instead just bumps `updated` on an in-flight review — the daemon sends this
	 *  between long QC stages so a legitimately long review (auditors + per-figure referees) is never
	 *  reclaimed mid-flight by the 2h watchdog. A no-op unless the row is 'reviewing'. */
	public static function release( $req ) {
		self::ensure_tables();
		$id = (int) Rest::p( $req, 'id', 0 );
		if ( $id ) {
			if ( ! empty( Rest::p( $req, 'heartbeat', false ) ) ) {
				Data::update( 'aq_submissions', [ 'updated' => Data::now() ], [ 'id' => $id, 'status' => 'reviewing' ] );
				return [ 'ok' => true, 'heartbeat' => true ];
			}
			Data::update( 'aq_submissions', [ 'status' => 'submitted', 'updated' => Data::now() ], [ 'id' => $id, 'status' => 'reviewing' ] );
		}
		return [ 'ok' => true ];
	}

	/**
	 * POST relay/review/publish { id, notebook?, pdf_b64? } — the SERVER performs the third-party publishing
	 * for an accepted manuscript: it publishes the one-click reproduction notebook as a public gist (→ Colab)
	 * and mints the permanent Zenodo/DataCite DOI. Both use ONLY Vault secrets (KAGGLE_TOKEN, ZENODO_TOKEN)
	 * — no API key ever lives on the reviewer machine; rotating a Vault secret needs no code or local change.
	 * The daemon calls this just before relay/review/complete and passes the returned values along. Best-effort:
	 * any failure returns empty strings, and the article is still accepted (just without that artefact).
	 */
	public static function review_publish( $req ) {
		self::ensure_tables();
		$id  = (int) Rest::p( $req, 'id', 0 );
		$row = $id ? Data::one( 'SELECT * FROM ' . Data::t( 'aq_submissions' ) . ' WHERE id = %d', [ $id ] ) : null;
		if ( ! $row ) { return Rest::err( 'not_found', 'Submission not found', 404 ); }
		$stored = [ 'colab_url' => (string) ( $row['colab_url'] ?? '' ), 'doi' => (string) ( $row['doi'] ?? '' ), 'record_url' => (string) ( $row['record_url'] ?? '' ) ];
		// IDEMPOTENT + crash-safe. Publishing mints a PERMANENT Zenodo DOI + a public gist — irreversible
		// side-effects we must never repeat. After a successful mint we SELF-PERSIST the artefacts onto the
		// row right away — so even if the daemon's later relay/review/complete is lost and the row is
		// reclaimed + re-reviewed 2h later, the existing-DOI guard below never mints a duplicate.
		if ( $row['status'] !== 'reviewing' ) { return $stored; }
		// Persist the RE-SENDABLE artefacts FIRST — body/charts/PDF/thumb are idempotent overwrites, so a
		// retry after a lost `complete` (when the DOI already exists) can still repair a transiently-failed
		// save. Only the IRREVERSIBLE steps (DOI mint, gist) sit behind the existing-DOI guard.
		$up = [];
		$notebook = self::clean_notebook( (string) Rest::p( $req, 'notebook', '' ) );
		$pdf_b64  = (string) Rest::p( $req, 'pdf_b64', '' );
		if ( $notebook !== '' ) { $up['notebook'] = $notebook; }
		$body = self::clean_body_html( (string) Rest::p( $req, 'body_html', '' ) );
		if ( $body !== '' ) { $up['body_html'] = $body; }
		$charts = self::clean_charts( (string) Rest::p( $req, 'charts', '' ) );
		if ( $charts !== '' ) { $up['charts'] = $charts; }
		// Save the COMPILED manuscript PDF (base64 from the daemon) to our uploads so the article page can
		// embed it directly + Scholar's citation_pdf_url points at a real PDF (not the LaTeX zip).
		$pdf = self::save_pdf( $id, $pdf_b64 );
		if ( $pdf !== '' ) { $up['pdf_url'] = $pdf; }
		$thumb = self::save_thumb( $id, (string) Rest::p( $req, 'thumb_b64', '' ) );
		if ( $thumb !== '' ) { $up['thumb_url'] = $thumb; }
		if ( $up ) { $up['updated'] = Data::now(); Data::update( 'aq_submissions', $up, [ 'id' => $id ] ); }
		if ( $stored['doi'] !== '' || $stored['colab_url'] !== '' ) { return $stored; }
		if ( get_transient( 'aq_pub_lock_' . $id ) ) { return $stored; }
		set_transient( 'aq_pub_lock_' . $id, 1, 600 );
		// Kaggle kernel replaces the GitHub gist + Colab link (operator 2026-07-26).
		$colab = $notebook !== '' ? Kaggle::push_article( (string) $row['title'], $id, self::clean_notebook( $notebook ) ) : '';
		$mint  = self::mint_doi( $row, $pdf_b64 );
		$up2 = [];
		if ( ! empty( $mint['doi'] ) ) { $up2['doi'] = mb_substr( (string) $mint['doi'], 0, 120 ); $up2['record_url'] = mb_substr( (string) ( $mint['record_url'] ?? '' ), 0, 300 ); }
		if ( $colab !== '' ) { $up2['colab_url'] = mb_substr( $colab, 0, 300 ); }
		if ( $up2 ) { $up2['updated'] = Data::now(); Data::update( 'aq_submissions', $up2, [ 'id' => $id ] ); }
		delete_transient( 'aq_pub_lock_' . $id );
		return [ 'colab_url' => $colab, 'doi' => (string) ( $mint['doi'] ?? '' ), 'record_url' => (string) ( $mint['record_url'] ?? '' ) ];
	}

	/**
	 * POST relay/review/reconstruct { id, body_html?, charts? } — refresh the WEB EDITION of an article that
	 * is ALREADY accepted: the reviewer machine re-renders article.html/charts.json (with independent-agent
	 * QC) and stores them here. Deliberately narrow: accepted rows only, and ONLY body_html/charts — the
	 * verdict, score, reviews, DOI, notebook, and PDF are never touched, so a reconstruction can never
	 * republish or downgrade a paper. Same sanitisers as the accept path.
	 */
	public static function review_reconstruct( $req ) {
		self::ensure_tables();
		$id  = (int) Rest::p( $req, 'id', 0 );
		$row = $id ? Data::one( 'SELECT id, status FROM ' . Data::t( 'aq_submissions' ) . ' WHERE id = %d', [ $id ] ) : null;
		if ( ! $row ) { return Rest::err( 'not_found', 'Submission not found', 404 ); }
		if ( $row['status'] !== 'accepted' ) { return Rest::err( 'bad_state', 'Only an accepted article can be reconstructed', 409 ); }
		$up     = [];
		$body   = self::clean_body_html( (string) Rest::p( $req, 'body_html', '' ) );
		$charts = self::clean_charts( (string) Rest::p( $req, 'charts', '' ) );
		$thumb  = self::save_thumb( $id, (string) Rest::p( $req, 'thumb_b64', '' ) );
		if ( $body !== '' )   { $up['body_html'] = $body; }
		if ( $charts !== '' ) { $up['charts'] = $charts; }
		if ( $thumb !== '' )  { $up['thumb_url'] = $thumb; }
		if ( ! $up ) { return Rest::err( 'bad_input', 'Nothing to store — body_html/charts empty or invalid' ); }
		$up['updated'] = Data::now();
		Data::update( 'aq_submissions', $up, [ 'id' => $id ] );
		return [ 'ok' => true, 'body_bytes' => strlen( $body ), 'charts_bytes' => strlen( $charts ), 'thumb_url' => $thumb ];
	}

	/** Validate + bound a notebook JSON string before we store/render/publish it: must parse and look like a
	 *  notebook (has a `cells` array), and be ≤2 MB (a reproduction notebook ships without bulky outputs).
	 *  Returns the JSON unchanged if OK, else '' . */
	private static function clean_notebook( $json ) {
		$json = (string) $json;
		// 4 MB: an EXECUTED reproduction notebook carries inline figure PNGs (base64) in its outputs.
		if ( $json === '' || strlen( $json ) > 4 * 1024 * 1024 ) { return ''; }
		$d = json_decode( $json, true );
		if ( ! is_array( $d ) || ! isset( $d['cells'] ) || ! is_array( $d['cells'] ) ) { return ''; }
		return $json;
	}

	/** Sanitise the reviewer-rendered full-text article HTML to a strict, reader-safe allowlist (the journal's
	 *  HTML rendition of the manuscript — headings/anchors, paragraphs, lists, figures with inline images,
	 *  tables, blockquotes, sup/sub, and links incl. internal #ref-N cross-links). Bounded to 4 MB. The result
	 *  is stored + server-rendered + shown in the reader, so it MUST be safe. '' if empty/oversized. */
	private static function clean_body_html( $html ) {
		$html = (string) $html;
		if ( $html === '' || strlen( $html ) > 4 * 1024 * 1024 ) { return ''; }
		$allowed = [
			'h2' => [ 'id' => true ], 'h3' => [ 'id' => true ], 'h4' => [ 'id' => true ],
			'p' => [ 'class' => true ], 'br' => [], 'hr' => [],
			'em' => [], 'strong' => [], 'b' => [], 'i' => [], 'sup' => [ 'id' => true ], 'sub' => [], 'small' => [],
			'code' => [], 'pre' => [], 'kbd' => [], 'abbr' => [ 'title' => true ],
			// class on ul: the reader styles `<ul class="key-findings">` (the spec's headline-results list) —
			// without it wp_kses silently strips the class and the list renders as plain bullets.
			'ul' => [ 'class' => true ], 'ol' => [ 'start' => true ], 'li' => [ 'id' => true ], 'dl' => [], 'dt' => [], 'dd' => [],
			'blockquote' => [ 'cite' => true ], 'section' => [ 'id' => true, 'class' => true ],
			'a' => [ 'href' => true, 'title' => true, 'id' => true ], 'span' => [ 'class' => true, 'id' => true ],
			'figure' => [ 'id' => true, 'class' => true ], 'figcaption' => [],
			'table' => [], 'thead' => [], 'tbody' => [], 'tfoot' => [], 'tr' => [],
			'th' => [ 'colspan' => true, 'rowspan' => true, 'scope' => true ], 'td' => [ 'colspan' => true, 'rowspan' => true ], 'caption' => [],
		];
		// NOTE: <img> is deliberately NOT allowed. Figures in a published article are the journal's own
		// interactive charts (generated from the reproduced data, rendered in the brand style) — never raw
		// uploaded/matplotlib images. wp_kses drops <img>; we also strip any stray one defensively.
		$html = wp_kses( $html, $allowed, [ 'https', 'http', 'mailto' ] );
		$html = (string) preg_replace( '/<img\b[^>]*>/i', '', $html );
		return (string) $html;
	}

	/** Validate + bound the reviewer's interactive-chart specs (data only — NO code/JS, so it is rendered
	 *  safely by the SPA's chart component). Accepts a JSON array of {type,title,x_label,y_label,x,series}.
	 *  Coerces types, clamps counts/lengths, drops anything malformed. Returns canonical JSON or ''. */
	private static function clean_charts( $json ) {
		$json = (string) $json;
		// 4 MB (was 512 KB): the spec authorises up to 20 panels × 20 series × 2000 points — a compliant
		// data-rich paper can legitimately exceed the old cap, and a rejected charts.json silently
		// published the article with NO figures. Post-sanitise output is re-bounded by the same cap.
		if ( $json === '' || strlen( $json ) > 4 * 1024 * 1024 ) { return ''; }
		$d = json_decode( $json, true );
		if ( ! is_array( $d ) || ! $d ) { return ''; }
		$lbl = static fn( $v ) => mb_substr( sanitize_text_field( (string) $v ), 0, 120 );
		$out = [];
		// 20 specs: a multi-panel manuscript figure ships one spec PER PANEL (`figure` groups them), so a
		// 7-figure paper with doubles needs more than the old 12.
		foreach ( array_slice( array_values( $d ), 0, 20 ) as $c ) {
			if ( ! is_array( $c ) ) { continue; }
			$series = [];
			foreach ( array_slice( (array) ( $c['series'] ?? [] ), 0, 20 ) as $s ) {
				if ( ! is_array( $s ) ) { continue; }
				$vals = [];
				foreach ( array_slice( (array) ( $s['values'] ?? [] ), 0, 2000 ) as $v ) { if ( is_numeric( $v ) ) { $vals[] = 0 + $v; } }
				if ( ! $vals ) { continue; }
				$one = [ 'name' => $lbl( $s['name'] ?? '' ), 'values' => $vals ];
				foreach ( [ 'lo', 'hi' ] as $bk ) {                            // optional band bounds (e.g. IQR ribbon around a median)
					if ( isset( $s[ $bk ] ) && is_array( $s[ $bk ] ) ) {
						$bb = [];
						foreach ( array_slice( $s[ $bk ], 0, 2000 ) as $v ) { if ( is_numeric( $v ) ) { $bb[] = 0 + $v; } }
						if ( $bb ) { $one[ $bk ] = $bb; }
					}
				}
				if ( ! empty( $s['dash'] ) )     { $one['dash'] = true; }      // dashed line (e.g. non-signature series)
				if ( ! empty( $s['emphasis'] ) ) { $one['emphasis'] = true; }  // bold/highlighted (e.g. median, named exemplar)
				if ( isset( $s['labels'] ) && is_array( $s['labels'] ) ) {     // per-point labels (dot/scatter plots)
					$labs = [];
					foreach ( array_slice( $s['labels'], 0, 2000 ) as $t ) { $labs[] = $lbl( $t ); }
					if ( $labs ) { $one['labels'] = $labs; }
				}
				$series[] = $one;
			}
			if ( ! $series ) { continue; }
			$x = [];
			foreach ( array_slice( (array) ( $c['x'] ?? [] ), 0, 2000 ) as $v ) { $x[] = is_numeric( $v ) ? 0 + $v : $lbl( $v ); }
			$chart = [
				'type'    => in_array( $c['type'] ?? '', [ 'line', 'bar', 'scatter', 'area', 'dots' ], true ) ? (string) $c['type'] : 'line',
				'title'   => $lbl( $c['title'] ?? '' ),
				'x_label' => $lbl( $c['x_label'] ?? '' ),
				'y_label' => $lbl( $c['y_label'] ?? '' ),
				'x'       => $x,
				'series'  => $series,
			];
			if ( ! empty( $c['caption'] ) ) { $chart['caption'] = mb_substr( sanitize_text_field( (string) $c['caption'] ), 0, 400 ); }
			if ( ! empty( $c['x_unit'] ) )  { $chart['x_unit'] = $lbl( $c['x_unit'] ); }
			if ( ! empty( $c['y_unit'] ) )  { $chart['y_unit'] = $lbl( $c['y_unit'] ); }
			// Manuscript figure/panel mapping: specs sharing `figure` are that figure's panels (reader
			// groups them under one #fig-N anchor and letters the captions a, b, …).
			if ( isset( $c['figure'] ) && is_numeric( $c['figure'] ) && (int) $c['figure'] > 0 && (int) $c['figure'] <= 40 ) { $chart['figure'] = (int) $c['figure']; }
			if ( ! empty( $c['panel'] ) && preg_match( '/^[a-h]$/', strtolower( (string) $c['panel'] ) ) ) { $chart['panel'] = strtolower( (string) $c['panel'] ); }
			if ( isset( $c['rules'] ) && is_array( $c['rules'] ) ) {           // annotation/reference lines
				$rules = [];
				foreach ( array_slice( $c['rules'], 0, 6 ) as $r ) {
					if ( ! is_array( $r ) || ! isset( $r['value'] ) || ! is_numeric( $r['value'] ) ) { continue; }
					$rules[] = [
						'axis'  => ( ( $r['axis'] ?? 'y' ) === 'x' ) ? 'x' : 'y',
						'value' => 0 + $r['value'],
						'label' => $lbl( $r['label'] ?? '' ),
					];
				}
				if ( $rules ) { $chart['rules'] = $rules; }
			}
			$out[] = $chart;
		}
		return $out ? (string) wp_json_encode( $out ) : '';
	}

	/** Save the generated article THUMBNAIL (base64 PNG from the daemon — the typeset paper's first
	 *  page) to the public uploads dir → its URL. Shown on article cards and used as og:image. */
	private static function save_thumb( $id, $png_b64 ) {
		$png_b64 = (string) $png_b64;
		if ( $png_b64 === '' ) { return ''; }
		$bytes = (string) base64_decode( $png_b64, true );
		if ( strncmp( $bytes, "\x89PNG", 4 ) !== 0 || strlen( $bytes ) > 4 * 1024 * 1024 ) { return ''; }
		$up = wp_upload_dir();
		if ( ! empty( $up['error'] ) ) { return ''; }
		$dir = $up['basedir'] . '/research-uploads';
		if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		$dest = $dir . '/thumb-' . (int) $id . '.png';
		if ( file_put_contents( $dest, $bytes ) === false ) { return ''; }
		@chmod( $dest, 0644 );
		return $up['baseurl'] . '/research-uploads/thumb-' . (int) $id . '.png';
	}

	/** Save the compiled manuscript PDF (base64 from the daemon) to the public uploads dir → its URL.
	 *  Validated as a real PDF; same-origin so the article page can embed it. '' on any problem. */
	private static function save_pdf( $id, $pdf_b64 ) {
		$pdf_b64 = (string) $pdf_b64;
		if ( $pdf_b64 === '' ) { return ''; }
		$bytes = (string) base64_decode( $pdf_b64, true );
		if ( strncmp( $bytes, '%PDF', 4 ) !== 0 || strlen( $bytes ) > 30 * 1024 * 1024 ) { return ''; }
		$up = wp_upload_dir();
		if ( ! empty( $up['error'] ) ) { return ''; }
		$dir = $up['basedir'] . '/research-uploads';
		if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		$dest = $dir . '/paper-' . (int) $id . '.pdf';
		if ( file_put_contents( $dest, $bytes ) === false ) { return ''; }
		@chmod( $dest, 0644 );
		return $up['baseurl'] . '/research-uploads/paper-' . (int) $id . '.pdf';
	}

	/** GET research/artefact?id=&which=data|code — same-origin TEXT proxy so the article page's data/code
	 *  viewers work regardless of the artefact host's CORS. Fetches ONLY the submission's own declared URL
	 *  (not an open proxy), server-side, re-validated (SSRF), no redirects, size-capped. Returns text only;
	 *  binary (zip/parquet/a repo page) → an error the FE falls back from to a plain download link. */
	public static function artefact( $req ) {
		// FIRST STATEMENT, deliberately. An unauthenticated caller makes US do the work: a DB
		// lookup, then `is_url()` — which is not a syntactic check but two blocking, uncached DNS
		// queries — and then an outbound fetch that can hold a PHP worker for up to 20 seconds.
		// Workers are scarcer than either CPU or bandwidth: park enough of them on slow remote
		// reads and the site stops answering anything at all. A throttle placed after any of that
		// bounds only the last step and lets the rest run free, so it sits above all of it.
		// Counting a bad id against the caller is intended, not a regression — probing for valid
		// ids is exactly the traffic worth metering.
		if ( Rest::throttle( 'research_artefact', 40, 600 ) ) {
			return Rest::err( 'rate_limited', 'Slow down', 429 );
		}
		self::ensure_tables();
		$id    = (int) Rest::p( $req, 'id', 0 );
		$which = sanitize_key( (string) Rest::p( $req, 'which', '' ) );
		$row   = $id ? Data::one( 'SELECT data_url, code_url FROM ' . Data::t( 'aq_submissions' ) . ' WHERE id = %d', [ $id ] ) : null;
		if ( ! $row ) { return Rest::err( 'not_found', 'Submission not found', 404 ); }
		$url = $which === 'data' ? (string) $row['data_url'] : ( $which === 'code' ? (string) $row['code_url'] : '' );
		if ( $url === '' || ! self::is_url( $url ) ) { return Rest::err( 'bad_request', 'No such artefact', 400 ); }
		$cap = 3 * 1024 * 1024;
		$r = wp_remote_get( $url, [ 'timeout' => 20, 'redirection' => 0, 'limit_response_size' => $cap ] );
		if ( is_wp_error( $r ) || (int) wp_remote_retrieve_response_code( $r ) >= 400 ) { return Rest::err( 'fetch_failed', 'Could not fetch the artefact', 502 ); }
		$body = (string) wp_remote_retrieve_body( $r );
		if ( $body !== '' && ! mb_check_encoding( $body, 'UTF-8' ) ) { return Rest::err( 'not_text', 'This artefact is binary — open it directly', 415 ); }
		return [
			'content_type' => (string) wp_remote_retrieve_header( $r, 'content-type' ),
			'text'         => $body,
			'bytes'        => strlen( $body ),
			'truncated'    => strlen( $body ) >= $cap,
		];
	}

	/** A Vault secret (third-party API key) — read at call time so a rotation in the Vault takes effect with no
	 *  deploy and no local change. Never falls back to the DB/options/env constants for these keys. */
	private static function vault( $name ) {
		return class_exists( '\\AQ\\Vault' ) ? (string) Vault::get( $name ) : '';
	}


	/** Mint a permanent Zenodo/DataCite DOI for an accepted manuscript. Uploads the compiled PDF (from the
	 *  daemon, base64) or — falling back — the manuscript source fetched from paper_url. Server-side, Vault
	 *  token only; a partial deposit is cleaned up. Returns [ 'doi' => , 'record_url' => ] or [] on failure. */
	private static function mint_doi( $row, $pdf_b64 ) {
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
			// The file: prefer the compiled PDF bytes; else fetch the manuscript source from paper_url.
			$bytes = $pdf_b64 !== '' ? (string) base64_decode( $pdf_b64, true ) : '';
			$fname = $row['id'] . '.pdf';
			if ( $bytes === '' ) {
				// SSRF: re-validate the host at fetch time (DNS can re-point after submit) and do NOT follow
				// redirects (a public host could 302 to an internal/metadata IP that is_url never sees).
				if ( self::is_url( (string) $row['paper_url'] ) ) {
					$pr = wp_remote_get( (string) $row['paper_url'], [ 'timeout' => 60, 'redirection' => 0 ] );
					if ( ! is_wp_error( $pr ) && (int) wp_remote_retrieve_response_code( $pr ) < 400 ) { $bytes = (string) wp_remote_retrieve_body( $pr ); $fname = $row['id'] . '.zip'; }
				}
			}
			if ( $bytes === '' ) { throw new \Exception( 'no file to deposit' ); }
			$up = wp_remote_request( $bucket . '/' . rawurlencode( $fname ), [ 'method' => 'PUT', 'timeout' => 60, 'headers' => $auth + [ 'Content-Type' => 'application/octet-stream' ], 'body' => $bytes ] );
			if ( is_wp_error( $up ) || (int) wp_remote_retrieve_response_code( $up ) >= 400 ) { throw new \Exception( 'file upload failed' ); }
			$au  = get_userdata( (int) $row['author_id'] );
			$nm  = $au ? trim( (string) $au->display_name ) : 'ArtaQuest Foundation';
			$fam = ( strpos( $nm, ' ' ) !== false ) ? ( substr( strrchr( $nm, ' ' ), 1 ) . ', ' . trim( substr( $nm, 0, strrpos( $nm, ' ' ) ) ) ) : $nm;
			$meta = [ 'metadata' => [
				'title'            => (string) $row['title'],
				'upload_type'      => 'publication',
				'publication_type' => 'article',
				'description'      => (string) $row['abstract'] . '<br><br>Reviewed and accepted by ArtaScience (automated AI review). Code: ' . (string) $row['code_url'] . '<br>Data: ' . (string) $row['data_url'],
				'creators'         => [ [ 'name' => $fam, 'affiliation' => self::jname( $row ) ] ],
				'access_right'     => 'open',
				'license'          => 'cc-by-4.0',
				'publication_date' => gmdate( 'Y-m-d' ),
				'journal_title'    => self::jname( $row ),
				'related_identifiers' => array_values( array_filter( array_map( static function ( $u ) {
					return $u ? [ 'identifier' => $u, 'relation' => 'isSupplementedBy', 'scheme' => 'url' ] : null;
				}, [ (string) $row['code_url'], (string) $row['data_url'] ] ) ) ),
			] ];
			$mr = wp_remote_request( $base . '/deposit/depositions/' . $dep_id, [ 'method' => 'PUT', 'timeout' => 40, 'headers' => $auth + [ 'Content-Type' => 'application/json' ], 'body' => wp_json_encode( $meta ) ] );
			if ( is_wp_error( $mr ) || (int) wp_remote_retrieve_response_code( $mr ) >= 400 ) { throw new \Exception( 'metadata failed' ); }
			$pb = wp_remote_post( $base . '/deposit/depositions/' . $dep_id . '/actions/publish', [ 'timeout' => 60, 'headers' => $auth ] );
			if ( is_wp_error( $pb ) || (int) wp_remote_retrieve_response_code( $pb ) >= 400 ) { throw new \Exception( 'publish failed' ); }
			$pub = json_decode( wp_remote_retrieve_body( $pb ), true );
			$result = [ 'doi' => (string) ( $pub['doi'] ?? $pub['metadata']['doi'] ?? '' ), 'record_url' => (string) ( $pub['links']['record_html'] ?? '' ) ];
		} catch ( \Throwable $e ) {
			// Delete the orphaned draft so we don't litter Zenodo (drafts are deletable; published records aren't).
			wp_remote_request( $base . '/deposit/depositions/' . $dep_id, [ 'method' => 'DELETE', 'timeout' => 20, 'headers' => $auth ] );
			$result = [];
		}
		return $result;
	}

	/** Lightweight liveness for the SPA banner: is the ArtaScience reviewer online + queue depth? */
	public static function status( $req = null ) {
		self::ensure_tables();
		global $wpdb;
		$t = Data::t( 'aq_submissions' );
		$journal = $req ? sanitize_key( (string) Rest::p( $req, 'journal', '' ) ) : '';
		$cond = ( $journal && isset( self::JOURNALS[ $journal ] ) ) ? $wpdb->prepare( ' AND journal = %s', $journal ) : '';
		return [
			'online'    => (bool) get_transient( 'aq_science_beat' ),
			'queued'    => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$t} WHERE status IN ('submitted','reviewing'){$cond}" ),
			'published' => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$t} WHERE status = 'accepted'{$cond}" ),
		];
	}

	/** Richer snapshot for the operator Console — counts by status + the most recently updated few. */
	public static function console_panel() {
		self::ensure_tables();
		$t = Data::t( 'aq_submissions' );
		$by = [];
		foreach ( Data::all( "SELECT status, COUNT(*) c FROM {$t} GROUP BY status" ) as $r ) { $by[ $r['status'] ] = (int) $r['c']; }
		$recent = Data::all( "SELECT id, title, status, round, score, reproduced, updated FROM {$t} ORDER BY updated DESC LIMIT 8" );
		return [
			'online'   => (bool) get_transient( 'aq_science_beat' ),
			'counts'   => [
				'submitted'  => $by['submitted'] ?? 0,
				'reviewing'  => $by['reviewing'] ?? 0,
				'revisions'  => $by['revisions-requested'] ?? 0,
				'accepted'   => $by['accepted'] ?? 0,
				'rejected'   => $by['rejected'] ?? 0,
				'withdrawn'  => $by['withdrawn'] ?? 0,
			],
			'queued'   => ( $by['submitted'] ?? 0 ) + ( $by['reviewing'] ?? 0 ),
			'recent'   => array_map( static function ( $r ) {
				return [ 'id' => (int) $r['id'], 'title' => (string) $r['title'], 'status' => (string) $r['status'],
					'round' => (int) $r['round'], 'score' => (int) $r['score'], 'reproduced' => (bool) $r['reproduced'],
					'updated' => (int) $r['updated'] ];
			}, $recent ),
		];
	}
}
