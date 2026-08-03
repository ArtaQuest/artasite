<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaReview — ONE public adversarial-review ledger for every published work (operator mandate
 * 2026-07-03: "every submission must show its review process and feedback, like ArtaScience").
 *
 * ArtaScience (aq_paper_reviews), ArtaSound (aq_track_reviews) and ArtaIllustration
 * (aq_illust_rounds) already keep native public round tables; this class gives the SAME public
 * record to the studios that had none — books, films, narrations, translated editions — through a
 * single polymorphic, append-only table, and UNIFIES the publish gate: a book or film cannot leave
 * 'draft' without a PASSING review round on record. (Re-publishing an already-live work — content
 * updates — is never blocked; the gate guards the first transition only, like the coin charge.)
 *
 *   • aq_work_reviews — one row (NB: plain aq_reviews is the legacy COURSE-review table) per adversarial round: (target_type, target_id, round, reviewer,
 *     score 0-100, verdict pass|fix, findings JSON [{quote|file, problem, fix, applied}…],
 *     report text, model). Rounds are IMMUTABLE history: fixes are recorded by the NEXT round.
 *
 * The gate is SERVER-AUTHORITATIVE and CONTENT-BOUND (tightened 2026-07-06): every row is stamped
 * with a server-computed fingerprint (sig) of the exact text it reviewed; a chapter is accepted only
 * while its LATEST round passes AND still matches the text; the book-level aggregate is recomputed
 * from the chapter rounds, never taken on the relay's word; and the publish gate re-verifies against
 * the text actually being published. The reviewing relay adds its own rigour on top: a pass must be
 * CONFIRMED by a second independent critic, and a whole-book coherence round guards what per-chapter
 * review cannot see (see tools/ticket-agent/artareview-relay.mjs).
 *
 * Routes (see Rest::ROUTES): GET reviews (public, any work's full history) ·
 * POST relay/reviews (worker — the review pipelines append rounds).
 */
final class Reviews {

	const TABLE_VERSION = '4'; // v4: sig — each row is content-bound to the exact text it reviewed. v3: per-CHAPTER records
	const TYPES         = [ 'book', 'film', 'narration' ]; // translated editions ARE books
	const PASS_SCORE    = 85; // a 'pass' verdict below this is recorded but does NOT open the gate

	public static function ensure_tables() {
		if ( get_option( 'aq_work_reviews_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		$t       = $wpdb->prefix . 'aq_work_reviews';
		dbDelta( "CREATE TABLE {$t} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			target_type VARCHAR(16) NOT NULL DEFAULT '',
			target_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			chapter VARCHAR(80) NOT NULL DEFAULT '',
			round INT UNSIGNED NOT NULL DEFAULT 1,
			reviewer VARCHAR(64) NOT NULL DEFAULT '',
			score INT NOT NULL DEFAULT 0,
			scores LONGTEXT NULL,
			verdict VARCHAR(12) NOT NULL DEFAULT '',
			findings LONGTEXT NULL,
			report TEXT NULL,
			model VARCHAR(48) NOT NULL DEFAULT '',
			sig VARCHAR(40) NOT NULL DEFAULT '',
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY target (target_type, target_id, chapter, round)
		) {$charset};" );
		update_option( 'aq_work_reviews_table_version', self::TABLE_VERSION, true );
	}

	/** Fingerprint binding a review row to the exact text it reviewed. Rows recorded before v4
	 *  carry sig '' and keep their word (legacy); every new row is stamped SERVER-side. */
	private static function unit_sig( $html ) { return sha1( trim( (string) $html ) ); }

	/** GET reviews?target_type=&target_id= — a work's full public review history, oldest first. */
	public static function list_for( $req ) {
		self::ensure_tables();
		$type = sanitize_key( (string) Rest::p( $req, 'target_type', '' ) );
		$id   = Rest::pint( $req, 'target_id' );
		if ( ! in_array( $type, self::TYPES, true ) || ! $id ) { return [ 'items' => [] ]; }
		return [ 'items' => self::rounds( $type, $id ), 'pass_score' => self::PASS_SCORE ];
	}

	/** POST relay/reviews (worker) — append one immutable review round. */
	public static function record( $req ) {
		self::ensure_tables();
		$type = sanitize_key( (string) Rest::p( $req, 'target_type', '' ) );
		$id   = Rest::pint( $req, 'target_id' );
		if ( ! in_array( $type, self::TYPES, true ) || ! $id ) { return Rest::err( 'bad_target', 'target_type/target_id required' ); }
		$score   = max( 0, min( 100, Rest::pint( $req, 'score', 0 ) ) );
		$verdict = (string) Rest::p( $req, 'verdict', '' ) === 'pass' ? 'pass' : 'fix';
		$find    = Rest::p( $req, 'findings', null );
		$find    = is_array( $find ) ? $find : ( json_decode( (string) $find, true ) ?: [] );
		$sc      = Rest::p( $req, 'scores', null );
		$sc      = is_array( $sc ) ? $sc : ( json_decode( (string) $sc, true ) ?: null );
		$chapter = mb_substr( sanitize_text_field( (string) Rest::p( $req, 'chapter', '' ) ), 0, 80 );
		// Content-binding: stamp the row with a fingerprint of the exact text it reviewed, computed
		// SERVER-side from the book as stored right now — the relay never asserts it. A later edit
		// changes the fingerprint, so a stale pass can never vouch for new text.
		$sig = '';
		if ( $type === 'book' ) {
			$doc = Data::one( 'SELECT id, title, body_html, book_state FROM ' . Data::t( 'aq_documents' ) . ' WHERE id = %d', [ $id ] );
			if ( $doc ) {
				if ( $chapter === '' ) {
					$sig = self::unit_sig( (string) $doc['body_html'] );
				} else {
					$sig = 'gone'; // a chapter key absent from the current text can never vouch for anything
					foreach ( self::split_chapters( (string) $doc['body_html'], (string) $doc['title'] ) as $u ) {
						if ( $u['key'] === $chapter ) { $sig = self::unit_sig( $u['html'] ); break; }
					}
				}
				if ( $doc['book_state'] === 'reviewing' ) { // a long round stays claimed: every posted row is proof of life
					Data::update( 'aq_documents', [ 'review_claimed' => time() ], [ 'id' => $id, 'book_state' => 'reviewing' ] );
				}
			}
		}
		$rid = Data::insert( 'aq_work_reviews', [
			'target_type' => $type,
			'target_id'   => $id,
			'chapter'     => $chapter,
			'round'       => max( 1, Rest::pint( $req, 'round', 1 ) ),
			'reviewer'    => mb_substr( sanitize_text_field( (string) Rest::p( $req, 'reviewer', 'adversarial' ) ), 0, 64 ),
			'score'       => $score,
			'scores'      => $sc ? wp_json_encode( $sc ) : null,
			'verdict'     => $verdict,
			'findings'    => wp_json_encode( array_slice( $find, 0, 64 ) ),
			'report'      => mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'report', '' ) ), 0, 8000 ),
			'model'       => mb_substr( sanitize_text_field( (string) Rest::p( $req, 'model', '' ) ), 0, 48 ),
			'sig'         => $sig,
			'created'     => Data::now(),
		] );
		return $rid ? [ 'ok' => true, 'id' => (int) $rid ] : Rest::err( 'failed', 'Could not record the round', 500 );
	}

	/** Every public round for a work, oldest first — embedded by the studios' detail payloads. */
	public static function rounds( $type, $id ) {
		self::ensure_tables();
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_work_reviews' )
			. ' WHERE target_type = %s AND target_id = %d ORDER BY round ASC, id ASC', [ (string) $type, (int) $id ] );
		return array_map( [ self::class, 'round_out' ], $rows );
	}

	/** THE unified publish gate: does this work's LATEST BOOK-LEVEL round pass (verdict + threshold)?
	 *  For books the gate is CONTENT-BOUND and recomputed, never taken on the aggregate's word: the
	 *  latest book-level round must bind to the exact text being published ($body — pass the text a
	 *  publish request carries, else the stored text is used), and EVERY chapter of that text must
	 *  hold an accepting round of its own. So neither a spoofed aggregate, a missed chapter, nor a
	 *  post-review edit can slip through. Rows recorded before content-binding (sig '') keep their
	 *  word — the strict regime starts with the rounds recorded under it. */
	public static function passing( $type, $id, $body = null ) {
		self::ensure_tables();
		$r = Data::one( 'SELECT score, verdict, sig FROM ' . Data::t( 'aq_work_reviews' )
			. " WHERE target_type = %s AND target_id = %d AND chapter = '' ORDER BY round DESC, id DESC LIMIT 1", [ (string) $type, (int) $id ] );
		if ( ! $r || $r['verdict'] !== 'pass' || (int) $r['score'] < self::PASS_SCORE ) { return false; }
		if ( $type !== 'book' || (string) ( $r['sig'] ?? '' ) === '' ) { return true; } // non-book / legacy record
		if ( $body === null ) {
			$doc  = Data::one( 'SELECT body_html FROM ' . Data::t( 'aq_documents' ) . ' WHERE id = %d', [ (int) $id ] );
			$body = (string) ( $doc['body_html'] ?? '' );
		}
		if ( (string) $r['sig'] !== self::unit_sig( $body ) ) { return false; } // edited since the pass
		$latest = self::latest_by_chapter( (int) $id );
		foreach ( self::split_chapters( $body ) as $u ) {
			if ( ! self::row_accepts( $latest[ $u['key'] ] ?? null, self::unit_sig( $u['html'] ) ) ) { return false; }
		}
		return true;
	}

	/** Latest recorded row per chapter key — the row that currently speaks for the chapter. A pass
	 *  is only the chapter's word while it stays the LATEST round (a later 'fix' re-opens it). */
	private static function latest_by_chapter( $id ) {
		$rows = Data::all( 'SELECT chapter, round, score, verdict, sig FROM ' . Data::t( 'aq_work_reviews' )
			. " WHERE target_type = 'book' AND target_id = %d AND chapter <> '' ORDER BY round ASC, id ASC", [ (int) $id ] );
		$latest = [];
		foreach ( $rows as $r ) { $latest[ (string) $r['chapter'] ] = $r; }
		return $latest;
	}

	/** Does this row accept the unit as it reads NOW? verdict + threshold + content-binding. */
	private static function row_accepts( $row, $sig ) {
		if ( ! $row || $row['verdict'] !== 'pass' || (int) $row['score'] < self::PASS_SCORE ) { return false; }
		$rsig = (string) ( $row['sig'] ?? '' );
		return $rsig === '' || $rsig === $sig; // '' = recorded before content-binding (legacy)
	}

	/** [all units, still-open units] of a book's CURRENT text — open = no accepting latest round.
	 *  Because acceptance is content-bound, editing a passed chapter automatically re-opens it. */
	private static function open_units( $doc ) {
		$units  = self::split_chapters( (string) $doc['body_html'], (string) $doc['title'] );
		$latest = self::latest_by_chapter( (int) $doc['id'] );
		$open   = [];
		foreach ( $units as $u ) {
			if ( ! self::row_accepts( $latest[ $u['key'] ] ?? null, self::unit_sig( $u['html'] ) ) ) { $open[] = $u; }
		}
		return [ $units, $open ];
	}

	/** POST relay/bookreview/poll (worker) — the ArtaReview relay claims the oldest book queued for
	 *  review (book_state 'reviewing'), and gets its chapters split out of the published/review HTML so
	 *  it can review EACH CHAPTER SEPARATELY. Reclaims a stale claim after 30 min. */
	public static function book_poll( $req ) {
		self::ensure_tables();
		global $wpdb;
		$docs = Data::t( 'aq_documents' );
		if ( ! get_transient( 'aq_bookreview_reclaim' ) ) {
			set_transient( 'aq_bookreview_reclaim', 1, 60 );
			// record() refreshes the claim on every posted round, so 2h of silence means a dead
			// relay — not a long round (a single chapter's critic + confirmation stays well under it).
			$wpdb->query( $wpdb->prepare( "UPDATE {$docs} SET review_claimed = 0 WHERE book_state = 'reviewing' AND review_claimed > 0 AND review_claimed < %d", time() - 7200 ) );
		}
		$row = Data::one( "SELECT * FROM {$docs} WHERE book_state = 'reviewing' AND review_claimed = 0 AND status != 'removed' ORDER BY id ASC LIMIT 1" );
		if ( ! $row ) { return [ 'job' => null ]; }
		$got = Data::update( 'aq_documents', [ 'review_claimed' => time() ], [ 'id' => (int) $row['id'], 'review_claimed' => 0 ] );
		if ( ! $got ) { return [ 'job' => null ]; }
		$id   = (int) $row['id'];
		$done = Data::col( "SELECT COALESCE(MAX(round),0) FROM " . Data::t( 'aq_work_reviews' ) . " WHERE target_type='book' AND target_id=%d AND chapter=''", [ $id ] );
		// FREEZE what has already passed: once a chapter clears its own adversarial process it is
		// accepted, so later rounds review ONLY the still-open chapters. Without this a
		// non-deterministic hostile critic re-flags already-passed chapters forever and the book
		// never converges. Acceptance is the chapter's LATEST round AND content-bound: an edit to a
		// passed chapter (or a later 'fix' round on it) re-opens exactly that chapter.
		[ $units, $todo ] = self::open_units( $row );
		return [ 'job' => [
			'id'          => $id,
			'title'       => (string) $row['title'],
			'round'       => (int) $done + 1,
			'total'       => count( $units ),
			'carried'     => count( $units ) - count( $todo ), // chapters already accepted in earlier rounds
			'chapters'    => $todo,                            // only the chapters that still need review
			// condensed whole-book view (every unit's opening/closing, in order) for the relay's
			// cross-chapter COHERENCE critic — the judgement per-chapter review cannot make. It runs
			// once every chapter has passed, before the book-level pass is recorded.
			'book_view'   => self::book_view( (string) $row['title'], $units ),
		] ];
	}

	/** Split reader HTML into review units at each <h1>. Front matter before the first <h1> is a unit
	 *  of its own (it is part of the book too); an <h1> without an id still opens a unit (keyed by its
	 *  text); duplicate keys each get their own unit; and a book with NO <h1> structure is ONE unit —
	 *  the whole text — so nothing ever slips past review as "zero chapters". */
	private static function split_chapters( $html, $fallback_title = 'The whole book' ) {
		$html  = (string) $html;
		$parts = preg_split( '/(?=<h1\b)/i', $html );
		$out   = [];
		$used  = [];
		if ( isset( $parts[0] ) && ! preg_match( '/^\s*<h1\b/i', $parts[0] )
			&& mb_strlen( trim( wp_strip_all_tags( $parts[0] ) ) ) >= 200 ) {
			$out[] = [ 'key' => 'front-matter', 'title' => 'Front matter', 'html' => $parts[0] ];
			$used['front-matter'] = 1;
		}
		$i = 0;
		foreach ( $parts as $p ) {
			if ( ! preg_match( '/<h1([^>]*)>(.*?)<\/h1>/is', $p, $m ) ) { continue; }
			$i++;
			$id    = preg_match( '/\bid="([^"]*)"/i', $m[1], $mi ) ? $mi[1] : '';
			$title = trim( wp_strip_all_tags( $m[2] ) );
			$key   = sanitize_title( $id !== '' ? $id : $title );
			if ( $key === '' ) { $key = 'chapter-' . $i; }
			$base = $key;
			$n    = 2;
			while ( isset( $used[ $key ] ) ) { $key = $base . '-' . $n; $n++; }
			$used[ $key ] = 1;
			$out[] = [
				'key'   => $key,
				'title' => $title !== '' ? $title : 'Chapter ' . $i,
				'html'  => $p, // the chapter body, for the critic to read
			];
		}
		if ( ! $out && trim( wp_strip_all_tags( $html ) ) !== '' ) {
			$out[] = [ 'key' => 'book', 'title' => $fallback_title, 'html' => $html ];
		}
		return $out;
	}

	/** The condensed whole-book view the coherence critic reads: every unit's opening and closing,
	 *  in order — enough to judge continuity, arc, and cross-chapter repetition without the full text. */
	private static function book_view( $title, $units ) {
		$view = 'BOOK: ' . $title . "\nUNITS: " . count( $units ) . "\n";
		foreach ( $units as $i => $u ) {
			$plain = trim( (string) preg_replace( '/\s+/', ' ', wp_strip_all_tags( $u['html'] ) ) );
			$head  = mb_substr( $plain, 0, 1200 );
			$tail  = mb_strlen( $plain ) > 2400 ? mb_substr( $plain, -1200 ) : mb_substr( $plain, mb_strlen( $head ) );
			$view .= "\n## [" . ( $i + 1 ) . '] ' . $u['title'] . ' (' . mb_strlen( $plain ) . " chars)\nOPENING: " . $head
				. ( $tail !== '' ? "\n…CLOSING: " . $tail : '' ) . "\n";
		}
		return $view;
	}

	/** POST relay/bookreview/complete (worker) — the relay reports the round outcome after posting every
	 *  chapter's round (via relay/reviews). release=1 -> an infrastructure failure, NOT a review outcome:
	 *  the claim is freed and the book stays 'reviewing' for the next poll to retry. all_passed=1 is
	 *  NEVER taken on the relay's word — the server recomputes from the recorded rounds against the text
	 *  as it stands: every unit must hold an accepting round and the latest book-level round must bind to
	 *  the current whole text. Verified -> 'reviewed' (author may publish); relay-reported failure ->
	 *  'revise' (author fixes and resubmits); drift (an edit mid-review, a missed unit, a stale aggregate)
	 *  -> stays 'reviewing' so the next poll hands the open units straight back. */
	public static function book_complete( $req ) {
		self::ensure_tables();
		$id  = Rest::pint( $req, 'id' );
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_documents' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $row || $row['book_state'] !== 'reviewing' ) { return [ 'ok' => true, 'ignored' => true ]; }
		if ( ! in_array( (string) Rest::p( $req, 'release', '' ), [ '', '0', 'false' ], true ) ) {
			Data::update( 'aq_documents', [ 'review_claimed' => 0 ], [ 'id' => $id ] );
			return [ 'ok' => true, 'state' => 'reviewing', 'released' => true ];
		}
		$passed = ! in_array( (string) Rest::p( $req, 'all_passed', '' ), [ '', '0', 'false' ], true );
		if ( $passed ) {
			[ $units, $open ] = self::open_units( $row );
			$panel = Data::one( 'SELECT score, verdict, sig FROM ' . Data::t( 'aq_work_reviews' )
				. " WHERE target_type = 'book' AND target_id = %d AND chapter = '' ORDER BY round DESC, id DESC LIMIT 1", [ $id ] );
			if ( ! $units || $open || ! self::row_accepts( $panel, self::unit_sig( (string) $row['body_html'] ) ) ) {
				Data::update( 'aq_documents', [ 'review_claimed' => 0, 'updated' => Data::now() ], [ 'id' => $id ] );
				return [ 'ok' => true, 'state' => 'reviewing',
					'open' => array_map( static function ( $u ) { return $u['key']; }, $open ) ];
			}
		}
		Data::update( 'aq_documents', [ 'book_state' => $passed ? 'reviewed' : 'revise', 'review_claimed' => 0, 'updated' => Data::now() ], [ 'id' => $id ] );
		if ( class_exists( '\\AQ\\Notify' ) ) {
			$passed
				? Notify::push( (int) $row['author_id'], 'book', 'Your book passed review',
					'“' . (string) $row['title'] . '” has passed its public adversarial review — you can publish it now.',
					'/read/' . $id . '/', 'book-reviewed:' . $id )
				: Notify::push( (int) $row['author_id'], 'book', 'Your book needs another pass',
					'The reviewers left findings on “' . (string) $row['title'] . '” — read the public review record, revise, and resubmit.',
					'/read/' . $id . '/', 'book-revise:' . $id );
		}
		return [ 'ok' => true, 'state' => $passed ? 'reviewed' : 'revise' ];
	}

	private static function round_out( $r ) {
		return [
			'chapter'  => (string) ( $r['chapter'] ?? '' ),
			'round'    => (int) $r['round'],
			'reviewer' => (string) $r['reviewer'],
			'score'    => (int) $r['score'],
			'verdict'  => (string) $r['verdict'],
			'scores'   => ( $sc = json_decode( (string) ( $r['scores'] ?? '' ), true ) ) && is_array( $sc ) ? $sc : null,
			'findings' => ( $f = json_decode( (string) ( $r['findings'] ?? '' ), true ) ) && is_array( $f ) ? $f : [],
			'report'   => (string) ( $r['report'] ?? '' ),
			'model'    => (string) ( $r['model'] ?? '' ),
			'created'  => (int) $r['created'],
		];
	}
}
