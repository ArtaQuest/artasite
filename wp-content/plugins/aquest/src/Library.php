<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaPublishing — an AI book editor. Authors own their books; the AI is the editor.
 *
 * An author makes a REQUEST for a book — a brief (the concept, in their words) — and may attach
 * MULTIPLE source materials as INSPIRATION (born-digital PDFs with a real text layer). ArtaPublishing
 * synthesises a COMPLETELY ORIGINAL book from the brief, using the sources only as inspiration — never
 * copying their wording (no plagiarism, a full rewrite). The author reviews/edits and publishes it as
 * their OWN work, under their OWN name. The book is then read in the same reader the Journal uses
 * ("ArtaRead"), listed in the library + on the author's profile, earns points, and is SEO-indexed.
 *
 * The uploaded sources are PRIVATE inspiration — never shared, never published, only ever visible to the
 * author. We reject scanned/photocopied PDFs (no selectable text for the editor to read). Authorship is
 * always the author's: there is no "original author" credit and no derivative licensing, because the
 * published book is an original work — not a copy of any source.
 *
 * Two tables (both self-install — the Science/Relay/Notify pattern, isolated from Schema::VERSION):
 *   • aq_documents      — one row per BOOK PROJECT (brief → rewritten book + its lifecycle)
 *   • aq_doc_sources    — the private inspiration files attached to a project
 *
 * Pipeline (same poll/complete shape as Science/Relay — the laptop POLLS):
 *   1. POST library/documents (brief) → a 'draft' project. Optionally POST .../sources to attach
 *      inspiration PDFs. POST .../generate → book_state 'queued'.
 *   2. The ArtaPublishing relay long-polls relay/doc/poll (X-AQ-Worker), claims the oldest queued
 *      project, reads the brief + sources, writes an ORIGINAL book, POSTs relay/doc/complete → 'review'.
 *   3. The author reviews/edits and POSTs .../publish → status 'published', book_state 'live'; points
 *      awarded. The book is now public + SEO-indexed, authored by the member.
 */
final class Library {

	const TABLE_VERSION = '3'; // v3: aq_documents.review_claimed (ArtaReview relay claim). v2: lang — the language a book is WRITTEN in (drives Narrate's translate gate)
	const MAX_SOURCES   = 12;  // inspiration files per book project
	const COIN_PER_PAGE = 1;   // ArtaCoins charged per REQUESTED page, on publish (min ₳1)
	// Up to 1000 pages. Long books are written in PARTS by the relay (an outline-anchored sequence of
	// passes that continue seamlessly), so the full length is genuinely delivered — the relay heartbeats
	// relay/doc/beat between parts so a multi-hour write is never reclaimed mid-book.
	const MAX_PAGES     = 1000;
	const DEFAULT_PAGES = 30;

	/** What it costs (ArtaCoins) to publish a book of this requested length — at least ₳1. */
	public static function cost_for_pages( $pages ) { return max( 1, (int) $pages ) * self::COIN_PER_PAGE; }

	/** Self-installed storage — ArtaPublishing owns its tables. */
	public static function ensure_tables() {
		if ( get_option( 'aq_library_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		$docs    = $wpdb->prefix . 'aq_documents';
		$srcs    = $wpdb->prefix . 'aq_doc_sources';
		dbDelta( "CREATE TABLE {$docs} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			slug VARCHAR(191) NOT NULL DEFAULT '',
			title VARCHAR(255) NOT NULL DEFAULT '',
			pages INT UNSIGNED NOT NULL DEFAULT 0,
			lang VARCHAR(8) NOT NULL DEFAULT 'en',
			review_claimed INT UNSIGNED NOT NULL DEFAULT 0,
			brief LONGTEXT NULL,
			summary TEXT NULL,
			body_html LONGTEXT NULL,
			body_text LONGTEXT NULL,
			thumb VARCHAR(600) NOT NULL DEFAULT '',
			rights_ok TINYINT(1) NOT NULL DEFAULT 0,
			status VARCHAR(20) NOT NULL DEFAULT 'draft',
			book_state VARCHAR(12) NOT NULL DEFAULT '',
			claimed_at INT UNSIGNED NOT NULL DEFAULT 0,
			view_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			updated INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY slug (slug),
			KEY author (author_id),
			KEY pub_feed (status, id),
			KEY book_queue (book_state, id)
		) {$charset};" );
		dbDelta( "CREATE TABLE {$srcs} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			doc_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			title VARCHAR(255) NOT NULL DEFAULT '',
			file_url VARCHAR(600) NOT NULL DEFAULT '',
			file_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
			pages INT UNSIGNED NOT NULL DEFAULT 0,
			text_chars BIGINT UNSIGNED NOT NULL DEFAULT 0,
			source_text LONGTEXT NULL,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY doc (doc_id, id)
		) {$charset};" );
		update_option( 'aq_library_table_version', self::TABLE_VERSION, true );
	}

	/**
	 * ONE-TIME relaunch purge (2026-07-02). ArtaPublishing relaunched with Claude Fable 5 as the editor;
	 * every book project from the earlier pipeline — including the bundled seed example (now retired,
	 * data/library-seed.json deleted) — is removed so the library restarts clean. Bounded by a fixed
	 * cutoff baked in at write time, so a book created AFTER this code existed is never touched, and
	 * option-gated so it runs exactly once per site. Removes the project rows, their private inspiration
	 * files, generated covers, and any ArtaVoice narrations of the purged books. The coin/points ledgers
	 * are append-only and are deliberately left untouched.
	 */
	const RESET_KEY    = 'aq_library_reset_20260702';
	const RESET_CUTOFF = 1782941405; // 2026-07-02 — anything created before this is pre-relaunch

	public static function reset_legacy() {
		if ( get_option( self::RESET_KEY ) ) { return; }
		self::ensure_tables();
		global $wpdb;
		$docs = Data::t( 'aq_documents' );
		$srcs = Data::t( 'aq_doc_sources' );
		$up   = wp_upload_dir();
		foreach ( Data::all( "SELECT id FROM {$docs} WHERE created < %d", [ self::RESET_CUTOFF ] ) as $r ) {
			$id = (int) $r['id'];
			foreach ( Data::all( "SELECT file_url FROM {$srcs} WHERE doc_id = %d", [ $id ] ) as $s ) {
				self::unlink_file( (string) $s['file_url'] );
			}
			$wpdb->delete( $srcs, [ 'doc_id' => $id ] );
			if ( empty( $up['error'] ) ) { // the generated cover art, if any
				foreach ( glob( $up['basedir'] . '/library/book-' . $id . '-cover.*' ) ?: [] as $f ) { @unlink( $f ); }
			}
			if ( class_exists( '\\AQ\\Narrate' ) ) { // narrations of a purged book would 404 in the player
				Narrate::ensure_tables();
				$wpdb->delete( Data::t( 'aq_narrations' ), [ 'target_type' => 'book', 'target_id' => $id ] );
			}
			$wpdb->delete( $docs, [ 'id' => $id ] );
		}
		delete_option( 'aq_library_seed_mtime' ); // the seed-import mechanism is retired with this purge
		update_option( self::RESET_KEY, (string) Data::now(), true );
	}

	// ── member-facing ──────────────────────────────────────────────────────────────

	/** POST library/documents — start a book project from a brief (the author's request).
	 *  Accepts an optional first inspiration PDF (multipart 'file'), and ?generate=1 to start writing now. */
	public static function create( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_book', 20, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();

		$title = mb_substr( sanitize_text_field( (string) Rest::p( $req, 'title', '' ) ), 0, 255 );
		if ( $title === '' ) { return Rest::err( 'no_title', 'Give the book a title' ); }
		$brief = mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'brief', '' ) ), 0, 20000 );
		if ( $brief === '' ) { return Rest::err( 'no_brief', 'Describe the book you want — your brief is the request the editor works from' ); }
		$pages = (int) Rest::pint( $req, 'pages', self::DEFAULT_PAGES );
		$pages = max( 1, min( self::MAX_PAGES, $pages ) ); // requested length → drives the write + the publish price
		// The language the book is WRITTEN in (BCP-47 primary subtag, default 'en') — Narrate's
		// translate gate only routes a narration through the ArtaTranslate mesh when the voice's
		// language differs from THIS, so a book already written in Farsi narrated by a Farsi voice
		// is read verbatim instead of being "translated" from imaginary English.
		$lang = strtolower( sanitize_key( (string) Rest::p( $req, 'lang', 'en' ) ) );
		if ( ! preg_match( '/^[a-z]{2,3}$/', $lang ) ) { $lang = 'en'; }
		$summary = mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'summary', '' ) ), 0, 2000 );
		if ( in_array( (string) Rest::p( $req, 'rights_ok', '' ), [ '', '0', 'false' ], true ) ) {
			return Rest::err( 'no_rights', 'You must confirm this will be your own original work and that you may use any uploaded material as private inspiration' );
		}

		$now = Data::now();
		$id  = Data::insert( 'aq_documents', [
			'author_id' => $uid,
			'slug'      => self::unique_slug( $title ),
			'title'     => $title,
			'pages'     => $pages,
			'lang'      => $lang,
			'brief'     => $brief,
			'summary'   => $summary,
			'rights_ok' => 1,
			'status'    => 'draft',
			'book_state'=> '',
			'created'   => $now,
			'updated'   => $now,
		] );
		if ( ! $id ) { return Rest::err( 'failed', 'Could not start the book', 500 ); }

		// Optional first inspiration file in the same request.
		if ( isset( $_FILES['file'] ) && is_uploaded_file( (string) ( $_FILES['file']['tmp_name'] ?? '' ) ) ) {
			$s = self::store_source( $id, $_FILES['file'] );
			if ( $s instanceof \WP_REST_Response ) { // scanned/too-big — roll back the just-created empty draft
				global $wpdb;
				$wpdb->delete( Data::t( 'aq_documents' ), [ 'id' => $id ] );
				return $s;
			}
		}
		if ( ! in_array( (string) Rest::p( $req, 'generate', '' ), [ '', '0', 'false' ], true ) ) {
			Data::update( 'aq_documents', [ 'book_state' => 'queued', 'updated' => Data::now() ], [ 'id' => $id ] );
		}
		return self::detail( self::row( $id ) );
	}

	/** POST library/documents/{id}/sources (multipart 'file') — attach an inspiration PDF (owner only). */
	public static function add_source( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Book not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your book', 403 ); }
		if ( (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_doc_sources' ) . ' WHERE doc_id = %d', [ (int) $row['id'] ] ) >= self::MAX_SOURCES ) {
			return Rest::err( 'too_many', 'That is the maximum number of inspiration sources for one book' );
		}
		$f = isset( $_FILES['file'] ) ? $_FILES['file'] : null;
		if ( ! $f || ! is_uploaded_file( (string) ( $f['tmp_name'] ?? '' ) ) ) { return Rest::err( 'no_file', 'No file received' ); }
		$s = self::store_source( (int) $row['id'], $f );
		if ( $s instanceof \WP_REST_Response ) { return $s; }
		return $s; // the source card
	}

	/** POST library/documents/{id}/sources/{sid}/delete — remove an inspiration source (owner only). */
	public static function remove_source( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Book not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your book', 403 ); }
		$sid = Rest::pint( $req, 'sid' );
		$src = Data::one( 'SELECT * FROM ' . Data::t( 'aq_doc_sources' ) . ' WHERE id = %d AND doc_id = %d', [ $sid, (int) $row['id'] ] );
		if ( ! $src ) { return Rest::err( 'not_found', 'Source not found', 404 ); }
		self::unlink_file( (string) $src['file_url'] );
		global $wpdb;
		$wpdb->delete( Data::t( 'aq_doc_sources' ), [ 'id' => $sid ] );
		return [ 'ok' => true ];
	}

	/** POST library/documents/{id}/generate — (re)queue the AI write (owner only). */
	public static function generate( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Book not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your book', 403 ); }
		if ( trim( (string) $row['brief'] ) === '' ) { return Rest::err( 'no_brief', 'Add a brief before writing the book' ); }
		if ( in_array( $row['book_state'], [ 'queued', 'processing' ], true ) ) { return [ 'ok' => true, 'queued' => true ]; }
		$fields = [ 'book_state' => 'queued', 'claimed_at' => 0, 'updated' => Data::now() ];
		if ( Rest::p( $req, 'pages', null ) !== null ) { // the author can adjust the requested length before writing
			$fields['pages'] = max( 1, min( self::MAX_PAGES, (int) Rest::pint( $req, 'pages', self::DEFAULT_PAGES ) ) );
		}
		Data::update( 'aq_documents', $fields, [ 'id' => (int) $row['id' ] ] );
		return [ 'ok' => true, 'queued' => true ];
	}

	/** POST library/documents/{id}/review — the author submits the book to the ArtaReview relay: it is
	 *  reviewed CHAPTER BY CHAPTER (each its own adversarial process) before it can be published. */
	public static function request_review( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Book not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your book', 403 ); }
		if ( trim( (string) ( $row['body_html'] ?? '' ) ) === '' ) { return Rest::err( 'empty', 'Write the book before requesting review', 409 ); }
		if ( $row['book_state'] === 'reviewing' ) { return [ 'ok' => true, 'book_state' => 'reviewing' ]; } // already queued — never reset an in-flight claim
		Data::update( 'aq_documents', [ 'book_state' => 'reviewing', 'review_claimed' => 0, 'updated' => Data::now() ], [ 'id' => (int) $row['id'] ] );
		return [ 'ok' => true, 'book_state' => 'reviewing' ];
	}

	/** POST library/documents/{id}/publish — publish (and optionally edit) the written book (owner only). */
	public static function publish_book( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Book not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your book', 403 ); }
		// A taken-down book is final: it cannot be resurrected straight to 'published' — that path
		// would skip the draft review+charge gate (status != 'draft'). Only draft (first publish) and
		// published (editing a live book) are publishable states.
		if ( ! in_array( (string) $row['status'], [ 'draft', 'published' ], true ) ) { return Rest::err( 'not_found', 'Book not found', 404 ); }
		$edited = (string) Rest::p( $req, 'body_html', '' );
		$html   = $edited !== '' ? self::clean_html( $edited ) : (string) ( $row['body_html'] ?? '' );
		if ( $html === '' ) { return Rest::err( 'no_book', 'The book is not written yet — please wait for it to finish', 409 ); }
		$summary = mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'summary', (string) $row['summary'] ) ), 0, 2000 );
		$id   = (int) $row['id'];
		$uid  = (int) $row['author_id'];
		$cost = self::cost_for_pages( (int) $row['pages'] );
		$ref  = 'book:' . $id;

		// THE REVIEW GATE (unified publishing process, operator mandate 2026-07-03): a book cannot
		// leave 'draft' until its latest public adversarial-review round PASSES (see AQ\Reviews).
		// The gate is checked against $html — the text THIS request would make public — so a body
		// edited after (or supplied instead of) the reviewed text can never ride a stale pass.
		// Content updates to an already-live book are never blocked — the gate guards first publish.
		if ( $row['status'] === 'draft' && ! Reviews::passing( 'book', $id, $html ) ) {
			return Rest::err( 'unreviewed', 'This book has not passed adversarial review of this exact text — every ArtaQuest publication carries its public review record. If you edited after the review, request review again.', 409 );
		}

		// Publishing costs ArtaCoins scaled by the REQUESTED page count (min ₳1), charged EXACTLY ONCE — the
		// first transition out of 'draft'. Re-publishing (editing a live book) never re-charges. We claim that
		// first transition with an ATOMIC conditional UPDATE (WHERE status='draft'), so two concurrent publishes
		// can't both charge: only the one that flips draft→published wins the claim and debits the wallet.
		if ( $row['status'] === 'draft' ) {
			if ( $err = Challenges::quota_gate( $uid ) ) { return $err; } // shelf quota: prune before publishing more
			$bal = Economy::coin_balance( $uid );
			if ( $bal < $cost ) {
				return Rest::err( 'insufficient', 'Publishing a ' . (int) $row['pages'] . '-page book costs ₳' . $cost . ' — you have ₳' . $bal . '.', 402 );
			}
			$claimed = (bool) Data::update( 'aq_documents', [ 'status' => 'published', 'book_state' => 'live', 'updated' => Data::now() ], [ 'id' => $id, 'status' => 'draft' ] );
			if ( $claimed ) {
				Economy::credit_coins( $uid, -$cost, 'publish', $ref ); // debit the author's wallet (only the winner)
				Economy::content_points( $uid, $cost, $ref ); // +points ∝ the coins invested (idempotent by ref)
				Challenges::enter( 'book', $id, $uid, $cost ); // the fee enters the season's Book Challenge pool
			}
		}

		// Persist the (possibly edited) text + summary; status/book_state are already 'published'/'live'.
		Data::update( 'aq_documents', [
			'body_html'  => $html,
			'body_text'  => self::html_to_text( $html ),
			'summary'    => $summary,
			'status'     => 'published',
			'book_state' => 'live',
			'updated'    => Data::now(),
		], [ 'id' => $id ] );
		return self::detail( self::row( $id ) );
	}

	/** GET library/documents — public keyset list of PUBLISHED books (the /library hub). */
	public static function list( $req ) {
		self::ensure_tables();
		$cursor = Rest::pint( $req, 'cursor', 0 );
		$q      = (string) Rest::p( $req, 'q', '' );
		[ $rows, $next ] = Data::search_page( 'aq_documents', [ 'title', 'summary' ], $q, "status = 'published'", [], $cursor, 24 );
		$names = self::author_names( $rows );
		return [ 'items' => array_map( static fn( $r ) => self::card( $r, $names ), $rows ), 'next' => $next ];
	}

	/** GET library/mine — the signed-in member's own book projects (drafts + published). */
	public static function mine( $req ) {
		self::ensure_tables();
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_documents' ) . " WHERE author_id = %d AND status != 'removed' ORDER BY id DESC LIMIT 100", [ Rest::uid() ] );
		$names = self::author_names( $rows );
		return [ 'items' => array_map( static fn( $r ) => self::card( $r, $names ) + [ 'status' => (string) $r['status'], 'book_state' => (string) $r['book_state'] ], $rows ) ];
	}

	/** GET library/documents/{id} — reader payload. Drafts are owner/operator-only; published books are public. */
	public static function get( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row || $row['status'] === 'removed' ) { return Rest::err( 'not_found', 'Book not found', 404 ); }
		if ( $row['status'] !== 'published' && ! self::can_edit( $row ) ) { return Rest::err( 'not_found', 'Book not found', 404 ); }
		if ( $row['status'] === 'published' ) { Data::bump( 'aq_documents', [ 'id' => (int) $row['id'] ], 'view_count', 1 ); }
		return self::detail( $row );
	}

	/** POST library/documents/{id}/delete — owner or operator takedown (removes the row + all source files). */
	public static function remove( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Book not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your book', 403 ); }
		foreach ( Data::all( 'SELECT file_url FROM ' . Data::t( 'aq_doc_sources' ) . ' WHERE doc_id = %d', [ (int) $row['id'] ] ) as $s ) {
			self::unlink_file( (string) $s['file_url'] );
		}
		global $wpdb;
		$wpdb->delete( Data::t( 'aq_doc_sources' ), [ 'doc_id' => (int) $row['id'] ] );
		Data::update( 'aq_documents', [ 'status' => 'removed', 'updated' => Data::now() ], [ 'id' => (int) $row['id'] ] );
		return [ 'ok' => true ];
	}

	// ── ArtaPublishing relay (auth: 'worker') — the brief→original-book write ───────────────────────

	/** POST relay/doc/poll — claim the oldest book queued to be written → the brief + its inspiration. */
	public static function doc_poll( $req ) {
		self::ensure_tables();
		set_transient( 'aq_library_beat', time(), 120 );
		global $wpdb;
		if ( ! get_transient( 'aq_library_reclaim' ) ) { // re-queue writes orphaned by a crashed daemon (throttled)
			set_transient( 'aq_library_reclaim', 1, 60 );
			$wpdb->query( $wpdb->prepare(
				'UPDATE ' . Data::t( 'aq_documents' ) . " SET book_state = 'queued' WHERE book_state = 'processing' AND updated < %d",
				Data::now() - 3600 ) );
		}
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_documents' ) . " WHERE book_state = 'queued' AND status != 'removed' ORDER BY id ASC LIMIT 1" );
		if ( ! $row ) { return [ 'job' => null ]; }
		$got = Data::update( 'aq_documents', [ 'book_state' => 'processing', 'claimed_at' => Data::now(), 'updated' => Data::now() ], [ 'id' => (int) $row['id'], 'book_state' => 'queued' ] );
		if ( ! $got ) { return [ 'job' => null ]; }
		$sources = array_map( static fn( $s ) => [
			'title'    => (string) $s['title'],
			'file_url' => (string) $s['file_url'], // the daemon fetches + extracts the full source itself
			'pages'    => (int) $s['pages'],
			'preview'  => mb_substr( (string) $s['source_text'], 0, 4000 ),
		], Data::all( 'SELECT * FROM ' . Data::t( 'aq_doc_sources' ) . ' WHERE doc_id = %d ORDER BY id ASC', [ (int) $row['id'] ] ) );
		return [ 'job' => [
			'id'      => (int) $row['id'],
			'title'   => (string) $row['title'],
			'brief'   => (string) $row['brief'],
			'pages'   => max( 1, (int) $row['pages'] ), // the REQUESTED length — drives the write (and part count)
			'sources' => $sources,
		] ];
	}

	/** POST relay/doc/beat {id} — liveness for a LONG write: a multi-part book takes hours, and the
	 *  reclaim in doc_poll re-queues any 'processing' row whose `updated` is >1h old. The relay beats
	 *  between parts so an in-flight long write is never reclaimed and double-claimed mid-book. */
	public static function doc_beat( $req ) {
		self::ensure_tables();
		$id = Rest::pint( $req, 'id' );
		if ( $id ) { Data::update( 'aq_documents', [ 'updated' => Data::now() ], [ 'id' => $id, 'book_state' => 'processing' ] ); }
		return [ 'ok' => true ];
	}

	/** POST relay/doc/complete — the daemon returns the written book HTML (+ optional cover thumbnail).
	 *  Lands in 'review' for the author to read and publish (we never auto-publish). */
	public static function doc_complete( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Book not found', 404 ); }
		$html  = self::clean_html( (string) Rest::p( $req, 'body_html', '' ) );
		$thumb = esc_url_raw( (string) Rest::p( $req, 'thumb', '' ) );
		// AI cover art rendered by the relay (coverart.py → free HF image Space), sent as base64.
		$thumb_b64 = (string) Rest::p( $req, 'thumb_b64', '' );
		if ( $thumb_b64 !== '' ) { $saved = self::save_image( (int) $row['id'], $thumb_b64 ); if ( $saved !== '' ) { $thumb = $saved; } }
		$blurb = mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'summary', '' ) ), 0, 2000 );
		// Only a book we actually handed out for writing ('processing') may be completed. This stops a stale
		// or duplicate worker completion from overwriting a published/live book and knocking it back to review.
		if ( $row['book_state'] !== 'processing' ) { return [ 'ok' => true, 'ignored' => true ]; }
		if ( $html === '' ) {
			Data::update( 'aq_documents', [ 'book_state' => 'failed', 'updated' => Data::now() ], [ 'id' => (int) $row['id'], 'book_state' => 'processing' ] );
			return Rest::err( 'empty_write', 'No book HTML received', 400 );
		}
		$wrote = (bool) Data::update( 'aq_documents', [
			'body_html'  => $html,
			'summary'    => $blurb !== '' ? $blurb : (string) $row['summary'],
			'thumb'      => $thumb !== '' ? mb_substr( $thumb, 0, 600 ) : (string) $row['thumb'],
			'book_state' => 'review',
			'updated'    => Data::now(),
		], [ 'id' => (int) $row['id'], 'book_state' => 'processing' ] ); // atomic: only completes a processing row
		if ( ! $wrote ) { return [ 'ok' => true, 'ignored' => true ]; } // lost the race / already moved on
		Notify::push( (int) $row['author_id'], 'book', 'Your book is ready to review',
			'Your draft of “' . (string) $row['title'] . '” is ready — review it and publish.',
			'/read/' . (int) $row['id'] . '/', 'book-ready:' . (int) $row['id'] );
		return [ 'ok' => true ];
	}

	// ── shaping ─────────────────────────────────────────────────────────────────────

	private static function card( $row, $names = null ) {
		$aid  = (int) $row['author_id'];
		$name = is_array( $names ) ? (string) ( $names[ $aid ]['name'] ?? '' ) : '';
		$slug = is_array( $names ) ? (string) ( $names[ $aid ]['slug'] ?? '' ) : '';
		return [
			'id'      => (int) $row['id'],
			'slug'    => (string) $row['slug'],
			'title'   => (string) $row['title'],
			'summary' => mb_substr( (string) $row['summary'], 0, 220 ),
			'thumb'   => (string) $row['thumb'],
			'pages'   => (int) $row['pages'],
			'views'   => (int) $row['view_count'],
			'author'  => $aid ? [ 'id' => $aid, 'name' => $name, 'slug' => $slug ] : null, // the book's author (the member)
			'created' => (int) $row['created'],
		];
	}

	private static function detail( $row ) {
		$card = self::card( $row, self::author_names( [ $row ] ) );
		$mine = self::can_edit( $row );
		$out  = $card + [
			'reviews'    => Reviews::rounds( 'book', (int) $row['id'] ), // the public adversarial-review record
			'status'     => (string) $row['status'],     // draft | published | removed
			'book_state' => (string) $row['book_state'], // '' | queued | processing | review | failed | live
			'body_html'  => ( $row['status'] === 'published' || $mine ) ? (string) ( $row['body_html'] ?? '' ) : '',
			'body_text'  => (string) ( $row['body_text'] ?? '' ),
			'is_owner'   => $mine,
		];
		if ( $mine ) { // the author sees their brief + their private inspiration list (never anyone else)
			$out['brief'] = (string) $row['brief'];
			$out['cost']  = self::cost_for_pages( (int) $row['pages'] ); // ArtaCoins to publish (already paid once live)
			$out['paid']  = $row['status'] === 'published' || (bool) Data::col(
				'SELECT 1 FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'publish' AND ref = %s LIMIT 1", [ 'book:' . (int) $row['id'] ] );
			$out['sources'] = array_map( static fn( $s ) => [
				'id'    => (int) $s['id'],
				'title' => (string) $s['title'],
				'pages' => (int) $s['pages'],
				'url'   => (string) $s['file_url'],
			], Data::all( 'SELECT id, title, pages, file_url FROM ' . Data::t( 'aq_doc_sources' ) . ' WHERE doc_id = %d ORDER BY id ASC', [ (int) $row['id'] ] ) );
		}
		return $out;
	}

	private static function author_names( $rows ) {
		$ids = array_values( array_unique( array_filter( array_map( static fn( $r ) => (int) $r['author_id'], $rows ) ) ) );
		if ( ! $ids ) { return []; }
		$names = [];
		foreach ( get_users( [ 'include' => $ids, 'fields' => [ 'ID', 'display_name', 'user_nicename' ] ] ) as $u ) {
			$names[ (int) $u->ID ] = [ 'name' => $u->display_name, 'slug' => $u->user_nicename ];
		}
		return $names;
	}

	// ── helpers ───────────────────────────────────────────────────────────────────

	/** Validate, gate (born-digital), and store one inspiration PDF → an aq_doc_sources card, or a
	 *  WP_REST_Response error (scanned / bad type / too big) the caller should return verbatim. */
	private static function store_source( $doc_id, $f ) {
		$size = (int) ( $f['size'] ?? 0 );
		if ( $size <= 0 ) { return Rest::err( 'empty', 'The file is empty' ); }
		if ( $size > 60 * 1024 * 1024 ) { return Rest::err( 'too_big', 'PDF exceeds 60 MB' ); }
		$name = sanitize_file_name( (string) ( $f['name'] ?? 'source.pdf' ) );
		if ( strtolower( pathinfo( $name, PATHINFO_EXTENSION ) ) !== 'pdf' ) { return Rest::err( 'bad_type', 'Inspiration sources must be PDFs' ); }
		$tmp = (string) $f['tmp_name'];
		if ( strncmp( (string) @file_get_contents( $tmp, false, null, 0, 5 ), '%PDF', 4 ) !== 0 ) { return Rest::err( 'bad_type', 'That file is not a valid PDF' ); }
		$an = self::analyze( $tmp ); // the "not photocopied" gate — the editor needs selectable text to read
		if ( ! $an['has_text_layer'] ) {
			return Rest::err( 'scanned', 'This looks like a scanned or photocopied PDF — it has no selectable text. Please use a digital PDF with real text.', 422 );
		}
		$up = wp_upload_dir();
		if ( ! empty( $up['error'] ) ) { return Rest::err( 'failed', 'Upload directory unavailable', 500 ); }
		$dir = $up['basedir'] . '/library-sources';
		if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		// Random, UNGUESSABLE filename — the source is private (owner-only in the API, masked in the data
		// explorer); a name derived from the upload would make the public URL guessable. 32 hex chars.
		$fname = wp_unique_filename( $dir, bin2hex( random_bytes( 16 ) ) . '.pdf' );
		$dest  = $dir . '/' . $fname;
		if ( ! @move_uploaded_file( $tmp, $dest ) ) { return Rest::err( 'failed', 'Could not store the file', 500 ); }
		@chmod( $dest, 0644 );
		$sid = Data::insert( 'aq_doc_sources', [
			'doc_id'      => (int) $doc_id,
			'title'       => mb_substr( preg_replace( '/\.pdf$/i', '', $name ), 0, 255 ),
			'file_url'    => $up['baseurl'] . '/library-sources/' . $fname,
			'file_size'   => $size,
			'pages'       => (int) $an['pages'],
			'text_chars'  => (int) $an['chars'],
			'source_text' => (string) $an['text'],
			'created'     => Data::now(),
		] );
		return [ 'id' => (int) $sid, 'title' => mb_substr( preg_replace( '/\.pdf$/i', '', $name ), 0, 255 ), 'pages' => (int) $an['pages'] ];
	}

	private static function row( $id ) {
		return $id ? Data::one( 'SELECT * FROM ' . Data::t( 'aq_documents' ) . ' WHERE id = %d', [ (int) $id ] ) : null;
	}

	private static function can_edit( $row ) {
		$uid = Rest::uid();
		return $uid && ( $uid === (int) $row['author_id'] || current_user_can( 'manage_options' ) );
	}

	private static function unique_slug( $title ) {
		$base = substr( sanitize_title( $title ) ?: 'book', 0, 180 );
		$slug = $base;
		$n    = 2;
		while ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_documents' ) . ' WHERE slug = %s LIMIT 1', [ $slug ] ) ) {
			$slug = $base . '-' . $n;
			$n++;
		}
		return $slug;
	}

	/** Save an AI-generated book cover (base64, jpg/png/webp) → its public URL, or '' on failure. */
	private static function save_image( $id, $b64 ) {
		$bytes = (string) base64_decode( (string) $b64, true );
		if ( strlen( $bytes ) < 256 || strlen( $bytes ) > 12 * 1024 * 1024 ) { return ''; }
		$sig = substr( $bytes, 0, 4 );
		$ext = ( "\xFF\xD8\xFF" === substr( $sig, 0, 3 ) ) ? 'jpg' : ( ( "\x89PNG" === $sig ) ? 'png' : ( 'RIFF' === $sig ? 'webp' : '' ) );
		if ( $ext === '' ) { return ''; }
		$up = wp_upload_dir();
		if ( ! empty( $up['error'] ) ) { return ''; }
		$dir = $up['basedir'] . '/library';
		if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		$dest = $dir . '/book-' . (int) $id . '-cover.' . $ext;
		if ( file_put_contents( $dest, $bytes ) === false ) { return ''; }
		@chmod( $dest, 0644 );
		return $up['baseurl'] . '/library/book-' . (int) $id . '-cover.' . $ext;
	}

	private static function unlink_file( $url ) {
		$up = wp_upload_dir();
		if ( ! empty( $up['error'] ) || $url === '' ) { return; }
		if ( strpos( $url, $up['baseurl'] . '/library-sources/' ) !== 0 ) { return; }
		$path = $up['basedir'] . '/library-sources/' . basename( $url );
		if ( is_file( $path ) ) { @unlink( $path ); }
	}

	/**
	 * Pure-PHP born-digital detector + rough text extraction (no external binaries — WordPress.com
	 * Atomic-safe). Inflate every FlateDecode stream and look for text-showing operators: a born-digital
	 * PDF has many (BT…ET, Tj/TJ); a scan has a big image per page and ~none. Returns
	 * [ pages, text, chars, has_text_layer ]. The GATE (operator count) is robust; the stored text is a
	 * best-effort preview — the relay re-extracts the full source from the file for the write.
	 */
	public static function analyze( $path ) {
		$raw = (string) @file_get_contents( $path );
		if ( $raw === '' ) { return [ 'pages' => 0, 'text' => '', 'chars' => 0, 'has_text_layer' => false ]; }
		$decoded = $raw;
		if ( preg_match_all( '/stream\r?\n(.*?)\r?\nendstream/s', $raw, $m ) ) {
			foreach ( $m[1] as $s ) {
				$d = @gzuncompress( $s );
				if ( $d === false ) { $d = @gzinflate( $s ); }
				if ( $d === false && strlen( $s ) > 2 ) { $d = @gzinflate( substr( $s, 2 ) ); }
				if ( is_string( $d ) && $d !== '' ) { $decoded .= "\n" . $d; }
			}
		}
		$pages = max( 1, (int) preg_match_all( '#/Type\s*/Page(?![s])#', $decoded ) );
		$show  = (int) preg_match_all( '/\bBT\b/', $decoded ) + (int) preg_match_all( '/\bT[jJ]\b/', $decoded );
		$text  = self::extract_text( $decoded );
		$chars = strlen( (string) preg_replace( '/\s+/', '', $text ) );
		return [ 'pages' => $pages, 'text' => $text, 'chars' => $chars, 'has_text_layer' => $show >= max( 20, $pages * 5 ) ];
	}

	private static function extract_text( $decoded ) {
		$out = [];
		if ( preg_match_all( '/BT(.*?)ET/s', $decoded, $blocks ) ) {
			foreach ( $blocks[1] as $b ) {
				if ( preg_match_all( '/\((?:\\\\.|[^\\\\()])*\)/s', $b, $lits ) ) {
					foreach ( $lits[0] as $lit ) { $out[] = self::pdf_unescape( substr( $lit, 1, -1 ) ); }
				}
			}
		}
		$text = (string) preg_replace( '/[ \t]+/', ' ', implode( ' ', $out ) );
		$text = (string) preg_replace( '/ ?\n ?/', "\n", $text );
		return trim( mb_substr( wp_check_invalid_utf8( $text, true ), 0, 200000 ) );
	}

	private static function pdf_unescape( $s ) {
		$s = strtr( $s, [ '\\n' => "\n", '\\r' => "\r", '\\t' => "\t", '\\(' => '(', '\\)' => ')', '\\\\' => '\\' ] );
		return (string) preg_replace_callback( '/\\\\([0-7]{1,3})/', static fn( $mm ) => chr( octdec( $mm[1] ) ), $s );
	}

	/** Sanitise the written book HTML to a strict, reader-safe allowlist (mirrors Science::clean_body_html;
	 *  the reader reuses the same .aq-article-body styles). Bounded to 8 MB — a full 1000-page book is
	 *  ~3 MB of HTML, so the bound is headroom, not a working limit. '' if empty/oversized. */
	private static function clean_html( $html ) {
		$html = (string) $html;
		if ( $html === '' || strlen( $html ) > 8 * 1024 * 1024 ) { return ''; }
		$allowed = [
			'h1' => [ 'id' => true ], 'h2' => [ 'id' => true ], 'h3' => [ 'id' => true ], 'h4' => [ 'id' => true ],
			'p' => [ 'class' => true ], 'br' => [], 'hr' => [],
			'em' => [], 'strong' => [], 'b' => [], 'i' => [], 'sup' => [ 'id' => true ], 'sub' => [], 'small' => [],
			'code' => [], 'pre' => [], 'kbd' => [], 'abbr' => [ 'title' => true ],
			'ul' => [], 'ol' => [ 'start' => true ], 'li' => [ 'id' => true ], 'dl' => [], 'dt' => [], 'dd' => [],
			'blockquote' => [ 'cite' => true ], 'section' => [ 'id' => true, 'class' => true ],
			'a' => [ 'href' => true, 'title' => true, 'id' => true ], 'span' => [ 'class' => true, 'id' => true ],
			'figure' => [ 'id' => true, 'class' => true ], 'figcaption' => [],
			'table' => [], 'thead' => [], 'tbody' => [], 'tfoot' => [], 'tr' => [],
			'th' => [ 'colspan' => true, 'rowspan' => true, 'scope' => true ], 'td' => [ 'colspan' => true, 'rowspan' => true ], 'caption' => [],
		];
		$html = wp_kses( $html, $allowed, [ 'https', 'http', 'mailto' ] );
		return (string) preg_replace( '/<img\b[^>]*>/i', '', $html );
	}

	private static function html_to_text( $html ) {
		return trim( mb_substr( wp_check_invalid_utf8( wp_strip_all_tags( (string) $html, true ), true ), 0, 200000 ) );
	}
}
