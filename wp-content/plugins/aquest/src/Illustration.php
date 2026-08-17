<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaIllustration — an AI illustration studio. A member briefs an illustration — a picture in their own
 * words, for anything: an artwork, a book cover, a plate inside a book — and the studio paints it with
 * STATE-OF-THE-ART open image models on FREE HuggingFace ZeroGPU Spaces (FLUX.2-dev / Qwen-Image /
 * Z-Image-Turbo, via the illustration relay). Unlike the one-shot studios, every illustration is then
 * ADVERSARIALLY IMPROVED (the ArtaScience pattern): a Claude vision critic scores each render against the
 * brief and directs an instruction-edit round (Qwen-Image-Edit / FLUX.2 image-conditioned) or a
 * re-generation, until it passes or the rounds cap out. EVERY round — image, critique, score — is kept
 * and shown publicly on the illustration page, so the improvement loop is transparent.
 *
 * Book art is first-class (ArtaPublishing): an illustration may target one of the author's own books as
 * its COVER (2:3, no text in the image — models garble lettering; typography belongs to the card overlay)
 * or as a PLATE (shown in a gallery under the reader). Publishing a cover sets the book's thumbnail.
 *
 * Two tables (self-install — the Science/Library/Film pattern, isolated from Schema::VERSION):
 *   • aq_illustrations  — one row per ILLUSTRATION PROJECT (brief → refined image + its lifecycle)
 *   • aq_illust_rounds  — the adversarial improvement rounds (one row per round: image + critique + score)
 *
 * Pipeline (same poll/complete shape as Film — the laptop POLLS):
 *   1. POST illustrations (brief) → a 'draft' project; ?generate=1 → art_state 'queued'.
 *   2. The illustration relay long-polls relay/illust/poll (X-AQ-Worker), claims the oldest queued
 *      project, paints round 1 with a SOTA free model, then loops: Claude-vision critique → targeted
 *      edit/regenerate, POSTing every round to relay/illust/round; finally relay/illust/complete → 'review'.
 *   3. The author reviews and POSTs .../publish → status 'published', art_state 'live'; coins charged
 *      once, points awarded; a published cover also becomes its book's thumbnail.
 */
final class Illustration {

	const TABLE_VERSION = '2'; // v2: aq_illust_rounds.axes — the critic's per-axis rubric scores (JSON)
	const COIN_PER_ART  = 2;   // flat ArtaCoins per illustration, on publish (adversarial rounds are GPU-heavy)
	const MAX_ROUNDS    = 4;   // adversarial improvement rounds cap (a ceiling, not a target)
	const KINDS         = [ 'art', 'cover', 'plate' ];               // cover/plate target one of the author's books
	const ASPECTS       = [ '1:1', '3:2', '2:3', '16:9', '9:16' ];

	public static function cost() { return self::COIN_PER_ART; }

	/** Self-installed storage — ArtaIllustration owns its tables. */
	public static function ensure_tables() {
		if ( get_option( 'aq_illustration_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		$ill     = $wpdb->prefix . 'aq_illustrations';
		$rnd     = $wpdb->prefix . 'aq_illust_rounds';
		dbDelta( "CREATE TABLE {$ill} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			slug VARCHAR(191) NOT NULL DEFAULT '',
			title VARCHAR(255) NOT NULL DEFAULT '',
			brief LONGTEXT NULL,
			style VARCHAR(255) NOT NULL DEFAULT '',
			kind VARCHAR(10) NOT NULL DEFAULT 'art',
			book_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			aspect VARCHAR(8) NOT NULL DEFAULT '1:1',
			summary TEXT NULL,
			image_url VARCHAR(600) NOT NULL DEFAULT '',
			width INT UNSIGNED NOT NULL DEFAULT 0,
			height INT UNSIGNED NOT NULL DEFAULT 0,
			engine VARCHAR(60) NOT NULL DEFAULT '',
			rounds INT UNSIGNED NOT NULL DEFAULT 0,
			score INT NOT NULL DEFAULT 0,
			rights_ok TINYINT(1) NOT NULL DEFAULT 0,
			status VARCHAR(20) NOT NULL DEFAULT 'draft',
			art_state VARCHAR(12) NOT NULL DEFAULT '',
			claimed_at INT UNSIGNED NOT NULL DEFAULT 0,
			view_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			updated INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY slug (slug),
			KEY author (author_id),
			KEY pub_feed (status, id),
			KEY art_queue (art_state, id),
			KEY book (book_id, id)
		) {$charset};" );
		dbDelta( "CREATE TABLE {$rnd} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			illust_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			round INT UNSIGNED NOT NULL DEFAULT 0,
			action VARCHAR(12) NOT NULL DEFAULT '',
			prompt TEXT NULL,
			critique TEXT NULL,
			axes TEXT NULL,
			score INT NOT NULL DEFAULT 0,
			verdict VARCHAR(10) NOT NULL DEFAULT '',
			engine VARCHAR(60) NOT NULL DEFAULT '',
			image_url VARCHAR(600) NOT NULL DEFAULT '',
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY ill (illust_id, round)
		) {$charset};" );
		update_option( 'aq_illustration_table_version', self::TABLE_VERSION, true );
	}

	// ── member-facing ──────────────────────────────────────────────────────────

	/** POST illustrations — start an illustration from a brief. ?generate=1 to begin now.
	 *  kind 'cover'/'plate' + book_id target one of the AUTHOR'S OWN books (ArtaPublishing). */
	public static function create( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_illust', 30, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid   = Rest::uid();
		$title = mb_substr( sanitize_text_field( (string) Rest::p( $req, 'title', '' ) ), 0, 255 );
		if ( $title === '' ) { return Rest::err( 'no_title', 'Give the illustration a title' ); }
		$brief = mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'brief', '' ) ), 0, 8000 );
		if ( $brief === '' ) { return Rest::err( 'no_brief', 'Describe the picture you want — your brief is what the studio paints' ); }
		if ( in_array( (string) Rest::p( $req, 'rights_ok', '' ), [ '', '0', 'false' ], true ) ) {
			return Rest::err( 'no_rights', 'Please confirm this will be your own original work' );
		}
		$style = mb_substr( sanitize_text_field( (string) Rest::p( $req, 'style', '' ) ), 0, 255 );
		$kind  = (string) Rest::p( $req, 'kind', 'art' );
		if ( ! in_array( $kind, self::KINDS, true ) ) { $kind = 'art'; }
		$book_id = 0;
		if ( $kind !== 'art' ) { // cover/plate must point at one of the author's OWN books
			$book_id = Rest::pint( $req, 'book_id', 0 );
			$book    = self::book( $book_id );
			if ( ! $book || (int) $book['author_id'] !== $uid ) { return Rest::err( 'not_your_book', 'Cover and plate art must target one of your own books', 403 ); }
		}
		$aspect = (string) Rest::p( $req, 'aspect', $kind === 'cover' ? '2:3' : '1:1' );
		if ( ! in_array( $aspect, self::ASPECTS, true ) ) { $aspect = '1:1'; }
		if ( $kind === 'cover' ) { $aspect = '2:3'; } // a book cover is always portrait

		$now = Data::now();
		$id  = Data::insert( 'aq_illustrations', [
			'author_id' => $uid, 'slug' => self::unique_slug( $title ), 'title' => $title,
			'brief' => $brief, 'style' => $style, 'kind' => $kind, 'book_id' => $book_id, 'aspect' => $aspect,
			'summary' => mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'summary', '' ) ), 0, 2000 ),
			'rights_ok' => 1, 'status' => 'draft', 'art_state' => '', 'created' => $now, 'updated' => $now,
		] );
		if ( ! $id ) { return Rest::err( 'failed', 'Could not start the illustration', 500 ); }
		if ( ! in_array( (string) Rest::p( $req, 'generate', '' ), [ '', '0', 'false' ], true ) ) {
			Data::update( 'aq_illustrations', [ 'art_state' => 'queued', 'updated' => Data::now() ], [ 'id' => $id ] );
		}
		return self::detail( self::row( $id ) );
	}

	/** POST illustrations/{id}/generate — (re)queue painting (owner only). A re-run starts a fresh
	 *  improvement loop: the previous rounds are cleared so the public history matches the new image. */
	public static function generate( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Illustration not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your illustration', 403 ); }
		// A PUBLISHED piece is frozen: its public URL (possibly a live book cover) must never silently
		// serve repainted, never-re-reviewed bytes on the strength of one past ₳2 publish.
		if ( $row['status'] === 'published' ) { return Rest::err( 'published', 'This illustration is published — commission a new piece instead of repainting a live one', 409 ); }
		if ( trim( (string) $row['brief'] ) === '' ) { return Rest::err( 'no_brief', 'Add a brief before painting' ); }
		if ( in_array( $row['art_state'], [ 'queued', 'processing' ], true ) ) { return [ 'ok' => true, 'queued' => true ]; }
		self::purge_rounds( (int) $row['id'] );
		Data::update( 'aq_illustrations', [
			'art_state' => 'queued', 'claimed_at' => 0, 'rounds' => 0, 'score' => 0, 'updated' => Data::now(),
		], [ 'id' => (int) $row['id'] ] );
		return [ 'ok' => true, 'queued' => true ];
	}

	/** POST illustrations/{id}/publish — pay coins (once), publish (owner only). A published COVER also
	 *  becomes its book's thumbnail. */
	public static function publish_art( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Illustration not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your illustration', 403 ); }
		if ( (string) $row['image_url'] === '' ) { return Rest::err( 'no_image', 'The illustration is not painted yet — please wait', 409 ); }
		// Mid-repaint the stored image is about to be replaced — publishing now would freeze a piece the
		// relay is still working on (and orphan its in-flight rounds). Wait for the loop to finish.
		if ( in_array( $row['art_state'], [ 'queued', 'processing' ], true ) ) { return Rest::err( 'painting', 'The studio is still painting this illustration — wait for it to finish, then publish', 409 ); }
		$id = (int) $row['id']; $uid = (int) $row['author_id'];
		$cost = self::cost(); $ref = 'illust:' . $id;
		if ( $row['status'] === 'draft' ) {
			if ( $err = Challenges::quota_gate( $uid ) ) { return $err; } // shelf quota: prune before publishing more
			// Friendly pre-check only — it keeps the exact figure in the refusal copy. The
			// AUTHORITATIVE check is inside Economy::spend below, which holds this member's
			// wallet lock across the check and the debit together.
			$bal = Economy::coin_balance( $uid );
			if ( $bal < $cost ) { return Rest::err( 'insufficient', 'Publishing an illustration costs ₳' . $cost . ' — you have ₳' . $bal . '.', 402 ); }
			// Charge BEFORE claiming the row. Claim-then-charge publishes the work even when the
			// charge is refused, which mints the goods for free.
			$paid = Economy::spend( $uid, $cost, 'publish', $ref );
			if ( $paid !== '' ) { return Economy::spend_error( $paid, $cost, 'Publishing an illustration' ); }
			$claimed = (bool) Data::update( 'aq_illustrations', [ 'status' => 'published', 'art_state' => 'live', 'updated' => Data::now() ], [ 'id' => $id, 'status' => 'draft' ] );
			if ( ! $claimed ) {
				// Another request published it first — give the money straight back, append-only.
				Economy::refund_spend( $uid, $cost, 'publish-void', $ref );
			}
			if ( $claimed ) {
				Economy::content_points( $uid, $cost, $ref );
				Challenges::enter( 'illustration', $id, $uid, $cost ); // fee → the season's Illustration Challenge pool
			}
		}
		Data::update( 'aq_illustrations', [
			'summary' => mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'summary', (string) $row['summary'] ) ), 0, 2000 ),
			'status' => 'published', 'art_state' => 'live', 'updated' => Data::now(),
		], [ 'id' => $id ] );
		// A published cover becomes its book's thumbnail (the book must still be the author's own).
		if ( $row['kind'] === 'cover' && (int) $row['book_id'] > 0 ) {
			$book = self::book( (int) $row['book_id'] );
			if ( $book && (int) $book['author_id'] === $uid ) {
				Data::update( 'aq_documents', [ 'thumb' => mb_substr( (string) $row['image_url'], 0, 600 ), 'updated' => Data::now() ], [ 'id' => (int) $book['id'] ] );
			}
		}
		return self::detail( self::row( $id ) );
	}

	/** GET illustrations — public keyset list of published illustrations. ?book=<id> filters to one
	 *  book's published art (the reader's plates gallery); ?kind= filters by kind. ?scope=activity is
	 *  the transparency feed: the most recently WORKED pieces in ANY state (the studio's live attempts —
	 *  radical transparency, like the ArtaScience queue; the whole DB is public regardless). */
	public static function list( $req ) {
		self::ensure_tables();
		if ( (string) Rest::p( $req, 'scope', '' ) === 'activity' ) {
			$rows  = Data::all( 'SELECT * FROM ' . Data::t( 'aq_illustrations' ) . ' ORDER BY updated DESC LIMIT 24' );
			$names = self::author_names( $rows );
			$out   = [];
			foreach ( $rows as $r ) {
				$card = self::card( $r, $names );
				$last = Data::one( 'SELECT round, score, verdict, critique FROM ' . Data::t( 'aq_illust_rounds' ) . ' WHERE illust_id = %d ORDER BY round DESC LIMIT 1', [ (int) $r['id'] ] );
				if ( $last ) {
					$card['last_round'] = [
						'round'    => (int) $last['round'],
						'score'    => (int) $last['score'],
						'verdict'  => (string) $last['verdict'],
						'critique' => mb_substr( (string) ( $last['critique'] ?? '' ), 0, 240 ),
					];
				}
				$out[] = $card;
			}
			return [ 'items' => $out, 'next' => null ];
		}
		$cursor = Rest::pint( $req, 'cursor', 0 );
		$q      = (string) Rest::p( $req, 'q', '' );
		$where  = "status = 'published'";
		$args   = [];
		$book   = Rest::pint( $req, 'book', 0 );
		if ( $book > 0 ) { $where .= ' AND book_id = %d'; $args[] = $book; }
		$kind = (string) Rest::p( $req, 'kind', '' );
		if ( in_array( $kind, self::KINDS, true ) ) { $where .= ' AND kind = %s'; $args[] = $kind; }
		[ $rows, $next ] = Data::search_page( 'aq_illustrations', [ 'title', 'summary' ], $q, $where, $args, $cursor, 24 );
		$names = self::author_names( $rows );
		return [ 'items' => array_map( static fn( $r ) => self::card( $r, $names ), $rows ), 'next' => $next ];
	}

	/** GET illustrations/mine — the member's own illustration projects. */
	public static function mine( $req ) {
		self::ensure_tables();
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_illustrations' ) . ' WHERE author_id = %d ORDER BY id DESC LIMIT 100', [ Rest::uid() ] );
		return [ 'items' => array_map( [ self::class, 'card' ], $rows ) ];
	}

	/** GET illustrations/{id} — viewer payload, with the full public improvement-round history. */
	public static function get( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Illustration not found', 404 ); }
		if ( $row['status'] === 'published' ) { Data::bump( 'aq_illustrations', [ 'id' => (int) $row['id'] ], 'view_count', 1 ); }
		return self::detail( $row, true );
	}

	/** POST illustrations/{id}/delete — owner or operator (removes the row, rounds + image files). */
	public static function remove( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Illustration not found', 404 ); }
		if ( ! self::can_edit( $row ) ) { return Rest::err( 'forbidden', 'Not your illustration', 403 ); }
		self::purge_rounds( (int) $row['id'] );
		self::unlink_file( (string) $row['image_url'] );
		// A deleted COVER must not leave its book pointing at the now-missing file.
		if ( $row['kind'] === 'cover' && (int) $row['book_id'] > 0 && (string) $row['image_url'] !== '' ) {
			$book = self::book( (int) $row['book_id'] );
			if ( $book && (string) $book['thumb'] === (string) $row['image_url'] ) {
				Data::update( 'aq_documents', [ 'thumb' => '', 'updated' => Data::now() ], [ 'id' => (int) $book['id'] ] );
			}
		}
		global $wpdb; $wpdb->delete( Data::t( 'aq_illustrations' ), [ 'id' => (int) $row['id'] ] );
		return [ 'ok' => true ];
	}

	// ── relay (worker) — paint, then adversarially improve ─────────────────────

	/** POST relay/illust/poll — claim the oldest queued (or stale) illustration → the brief + context. */
	public static function illust_poll( $req ) {
		self::ensure_tables();
		set_transient( 'aq_illust_beat', time(), 120 );
		global $wpdb;
		$now = time(); $t = Data::t( 'aq_illustrations' ); $stale = 2400; // > the relay's 30-min render cap, so a slow render can't be reclaimed mid-paint
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$t} WHERE art_state = 'queued' OR ( art_state = 'processing' AND claimed_at < %d ) ORDER BY id ASC LIMIT 1", $now - $stale ), ARRAY_A );
		if ( ! $row ) { return [ 'job' => null ]; }
		$claimed = (int) $wpdb->query( $wpdb->prepare( "UPDATE {$t} SET art_state = 'processing', claimed_at = %d WHERE id = %d AND ( art_state = 'queued' OR ( art_state = 'processing' AND claimed_at < %d ) )", $now, (int) $row['id'], $now - $stale ) );
		if ( ! $claimed ) { return [ 'job' => null ]; }
		// Prior rounds ride along so the loop is RESUMABLE: a quota-released or reclaimed job continues
		// from its last recorded round (re-critiquing it if the critique was interrupted) instead of
		// re-burning GPU repainting from scratch. Only the AUTHOR's re-queue (generate) purges history.
		$rounds = array_map( static fn( $r ) => [
			'round'    => (int) $r['round'],
			'action'   => (string) $r['action'],
			'prompt'   => (string) ( $r['prompt'] ?? '' ),
			'critique' => (string) ( $r['critique'] ?? '' ),
			'score'    => (int) $r['score'],
			'verdict'  => (string) $r['verdict'],
			'engine'   => (string) $r['engine'],
			'image_url'=> (string) $r['image_url'],
		], Data::all( 'SELECT * FROM ' . Data::t( 'aq_illust_rounds' ) . ' WHERE illust_id = %d ORDER BY round ASC', [ (int) $row['id'] ] ) );
		$job = [
			'id' => (int) $row['id'], 'title' => (string) $row['title'], 'brief' => (string) $row['brief'],
			'style' => (string) $row['style'], 'kind' => (string) $row['kind'], 'aspect' => (string) $row['aspect'],
			'max_rounds' => self::MAX_ROUNDS,
			'rounds' => $rounds,
			// The CLAIM TOKEN — every subsequent worker write must echo it, so a frozen-then-woken relay
			// whose claim was reclaimed by another machine can't interleave stale rounds into the new run.
			'claim' => $now,
		];
		if ( (int) $row['book_id'] > 0 ) { // book context so cover/plate art actually fits the book
			$book = self::book( (int) $row['book_id'] );
			if ( $book ) { $job['book'] = [ 'title' => (string) $book['title'], 'summary' => mb_substr( (string) $book['summary'], 0, 1000 ) ]; }
		}
		return [ 'job' => $job ];
	}

	/** POST relay/illust/heartbeat {id, claim} — keep a long multi-round improvement claimed. The claim
	 *  token rotates on every beat (claimed_at doubles as token + freshness); the caller must adopt the
	 *  returned one. ok:false = the claim was lost to another relay — stop working on this job. */
	public static function illust_heartbeat( $req ) {
		self::ensure_tables();
		global $wpdb;
		$now = time();
		$got = (int) $wpdb->query( $wpdb->prepare(
			'UPDATE ' . Data::t( 'aq_illustrations' ) . " SET claimed_at = %d WHERE id = %d AND art_state = 'processing' AND claimed_at = %d",
			$now, Rest::pint( $req, 'id' ), Rest::pint( $req, 'claim' ) ) );
		return $got ? [ 'ok' => true, 'claim' => $now ] : [ 'ok' => false ];
	}

	/** The critic's rubric axes (weights sum to 100) — mirrored in the relay's critic prompt and shown
	 *  per round on the piece page + the /artaillustration transparency page. */
	const AXES = [ 'fidelity' => 30, 'composition' => 25, 'craft' => 25, 'colour' => 10, 'purpose' => 10 ];

	/** POST relay/illust/round — record ONE adversarial round (image snapshot + critique + rubric scores).
	 *  {id, claim, round, action, prompt, critique, axes, score, verdict, engine, image_b64}
	 *  An empty image_b64 records a CRITIQUE-ONLY update to an existing round (a resumed job re-scoring
	 *  a render whose critique was interrupted) — the stored image is kept. */
	public static function illust_round( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row || $row['art_state'] !== 'processing' || (int) $row['claimed_at'] !== Rest::pint( $req, 'claim' ) ) { return [ 'ok' => true, 'ignored' => true ]; }
		$round = max( 1, min( 99, Rest::pint( $req, 'round', 1 ) ) );
		$b64   = (string) Rest::p( $req, 'image_b64', '' );
		global $wpdb;
		$old = Data::one( 'SELECT image_url FROM ' . Data::t( 'aq_illust_rounds' ) . ' WHERE illust_id = %d AND round = %d', [ (int) $row['id'], $round ] );
		$url = '';
		if ( $b64 !== '' ) {
			// Versioned filename (uploads are edge-cached by URL — a same-name overwrite would serve stale
			// bytes forever); replacing a round also unlinks the file it replaces.
			$url = self::save_image( (int) $row['id'], $b64, 'r' . $round . '-' . Data::now() );
			if ( $old ) { self::unlink_file( (string) $old['image_url'] ); }
		} else {
			// Critique-only update (a resumed job scoring an interrupted round) — keep the stored image.
			// A critique for a round that was never stored (its render POST was lost) has nothing to
			// annotate: refusing it keeps image-less "ghost rounds" out of the public history.
			if ( ! $old ) { return [ 'ok' => true, 'ignored' => true ]; }
			$url = (string) $old['image_url'];
		}
		$action = (string) Rest::p( $req, 'action', '' );
		if ( ! in_array( $action, [ 'generate', 'edit', 'regenerate' ], true ) ) { $action = 'generate'; }
		$verdict = (string) Rest::p( $req, 'verdict', '' );
		if ( ! in_array( $verdict, [ 'improve', 'done', '' ], true ) ) { $verdict = ''; }
		// The rubric axes: only the known keys, each clamped 0-100, stored as compact JSON (or NULL).
		$axes_in = Data::dec( (string) Rest::p( $req, 'axes', '' ) );
		$axes    = [];
		if ( is_array( $axes_in ) ) {
			foreach ( self::AXES as $k => $w ) {
				if ( isset( $axes_in[ $k ] ) && is_numeric( $axes_in[ $k ] ) ) { $axes[ $k ] = max( 0, min( 100, (int) $axes_in[ $k ] ) ); }
			}
		}
		$wpdb->delete( Data::t( 'aq_illust_rounds' ), [ 'illust_id' => (int) $row['id'], 'round' => $round ] ); // idempotent per (id, round)
		Data::insert( 'aq_illust_rounds', [
			'illust_id' => (int) $row['id'], 'round' => $round, 'action' => $action,
			'prompt'   => mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'prompt', '' ) ), 0, 4000 ),
			'critique' => mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'critique', '' ) ), 0, 8000 ),
			'axes'     => $axes ? Data::enc( $axes ) : null,
			'score'    => max( 0, min( 100, Rest::pint( $req, 'score', 0 ) ) ),
			'verdict'  => $verdict,
			'engine'   => mb_substr( sanitize_text_field( (string) Rest::p( $req, 'engine', '' ) ), 0, 60 ),
			'image_url'=> $url,
			'created'  => Data::now(),
		] );
		Data::update( 'aq_illustrations', [ 'rounds' => max( $round, (int) $row['rounds'] ), 'updated' => Data::now() ], [ 'id' => (int) $row['id'] ] );
		return [ 'ok' => true, 'image_url' => $url ];
	}

	/** POST relay/illust/complete {id, claim, image_b64, summary, engine, rounds, score} —
	 *  save the final refined image → 'review' for the author. An empty image marks 'failed'. */
	public static function illust_complete( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Illustration not found', 404 ); }
		if ( $row['art_state'] !== 'processing' || (int) $row['claimed_at'] !== Rest::pint( $req, 'claim' ) ) { return [ 'ok' => true, 'ignored' => true ]; }
		$b64 = (string) Rest::p( $req, 'image_b64', '' );
		if ( (string) $row['image_url'] !== '' ) { self::unlink_file( (string) $row['image_url'] ); } // versioned names — drop the repainted-over file
		$url = self::save_image( (int) $row['id'], $b64, (string) Data::now() );
		if ( $url === '' ) {
			Data::update( 'aq_illustrations', [ 'art_state' => 'failed', 'updated' => Data::now() ], [ 'id' => (int) $row['id'], 'art_state' => 'processing' ] );
			return Rest::err( 'empty_art', 'No usable image received', 400 );
		}
		// Dimensions come from the actual bytes, never from the worker's claim.
		$dims = (array) ( @getimagesizefromstring( (string) base64_decode( $b64, true ) ) ?: [] );
		$wrote = (bool) Data::update( 'aq_illustrations', [
			'image_url' => $url,
			'summary'   => mb_substr( sanitize_textarea_field( (string) Rest::p( $req, 'summary', (string) $row['summary'] ) ), 0, 2000 ),
			'engine'    => mb_substr( sanitize_text_field( (string) Rest::p( $req, 'engine', '' ) ), 0, 60 ),
			'rounds'    => max( 0, min( 99, Rest::pint( $req, 'rounds', (int) $row['rounds'] ) ) ),
			'score'     => max( 0, min( 100, Rest::pint( $req, 'score', 0 ) ) ),
			'width'     => (int) ( $dims[0] ?? 0 ),
			'height'    => (int) ( $dims[1] ?? 0 ),
			'art_state' => 'review', 'updated' => Data::now(),
		], [ 'id' => (int) $row['id'], 'art_state' => 'processing' ] );
		if ( ! $wrote ) { return [ 'ok' => true, 'ignored' => true ]; }
		Notify::push( (int) $row['author_id'], 'illustration', 'Your illustration is ready to review',
			'Your draft of “' . (string) $row['title'] . '” is ready — review it and publish.',
			'/illustration/' . (int) $row['id'] . '/', 'illust-ready:' . (int) $row['id'] );
		return [ 'ok' => true ];
	}

	/** POST relay/illust/release {id, claim} — a shutting-down / quota-blocked daemon re-queues its claim. */
	public static function release( $req ) {
		self::ensure_tables();
		global $wpdb;
		$wpdb->query( $wpdb->prepare( 'UPDATE ' . Data::t( 'aq_illustrations' ) . " SET art_state = 'queued', claimed_at = 0 WHERE id = %d AND art_state = 'processing' AND claimed_at = %d", Rest::pint( $req, 'id' ), Rest::pint( $req, 'claim' ) ) );
		return [ 'ok' => true ];
	}

	// ── shaping ─────────────────────────────────────────────────────────────────

	private static function card( $row, $names = null ) {
		$aid  = (int) $row['author_id'];
		$name = is_array( $names ) ? (string) ( $names[ $aid ]['name'] ?? '' ) : '';
		$slug = is_array( $names ) ? (string) ( $names[ $aid ]['slug'] ?? '' ) : '';
		if ( $name === '' ) { $u = get_userdata( $aid ); if ( $u ) { $name = $u->display_name; $slug = $u->user_nicename; } }
		return [
			'id' => (int) $row['id'], 'slug' => (string) $row['slug'], 'title' => (string) $row['title'],
			'summary' => mb_substr( (string) ( $row['summary'] ?? '' ), 0, 300 ),
			'image' => (string) $row['image_url'], 'aspect' => (string) $row['aspect'],
			'kind' => (string) $row['kind'], 'book_id' => (int) $row['book_id'],
			'rounds' => (int) $row['rounds'], 'score' => (int) $row['score'],
			'views' => (int) $row['view_count'], 'created' => (int) $row['created'],
			'status' => (string) $row['status'], 'art_state' => (string) $row['art_state'],
			'author' => $aid ? [ 'id' => $aid, 'name' => $name, 'slug' => $slug ] : null,
		];
	}

	private static function detail( $row, $with_rounds = false ) {
		$mine = self::can_edit( $row );
		$out  = self::card( $row, self::author_names( [ $row ] ) ) + [
			'engine'   => (string) $row['engine'],
			'width'    => (int) $row['width'], 'height' => (int) $row['height'],
			'is_owner' => $mine,
		];
		if ( (int) $row['book_id'] > 0 ) {
			$book = self::book( (int) $row['book_id'] );
			if ( $book && ( $book['status'] === 'published' || $mine ) ) {
				$out['book'] = [ 'id' => (int) $book['id'], 'title' => (string) $book['title'] ];
			}
		}
		if ( $with_rounds ) { // the adversarial improvement history is PUBLIC — transparency like ArtaScience
			$out['improvements'] = array_map( static fn( $r ) => [
				'round'    => (int) $r['round'],
				'action'   => (string) $r['action'],
				'prompt'   => (string) ( $r['prompt'] ?? '' ),
				'critique' => (string) ( $r['critique'] ?? '' ),
				'axes'     => Data::dec( (string) ( $r['axes'] ?? '' ) ) ?: null, // per-axis rubric scores
				'score'    => (int) $r['score'],
				'verdict'  => (string) $r['verdict'],
				'engine'   => (string) $r['engine'],
				'image'    => (string) $r['image_url'],
			], Data::all( 'SELECT * FROM ' . Data::t( 'aq_illust_rounds' ) . ' WHERE illust_id = %d ORDER BY round ASC', [ (int) $row['id'] ] ) );
		}
		if ( $mine ) {
			$out['brief'] = (string) $row['brief'];
			$out['style'] = (string) $row['style'];
			$out['cost']  = self::cost();
		}
		return $out;
	}

	private static function author_names( $rows ) {
		$ids = array_values( array_unique( array_filter( array_map( static fn( $r ) => (int) $r['author_id'], $rows ) ) ) );
		$out = [];
		foreach ( $ids as $id ) { $u = get_userdata( $id ); if ( $u ) { $out[ $id ] = [ 'name' => $u->display_name, 'slug' => $u->user_nicename ]; } }
		return $out;
	}

	// ── helpers ───────────────────────────────────────────────────────────────

	private static function row( $id ) { return $id ? Data::one( 'SELECT * FROM ' . Data::t( 'aq_illustrations' ) . ' WHERE id = %d', [ (int) $id ] ) : null; }

	/** One book row (ArtaPublishing), or null. Guarded so ArtaIllustration works even without Library. */
	private static function book( $id ) {
		if ( $id <= 0 || ! class_exists( '\\AQ\\Library' ) ) { return null; }
		Library::ensure_tables();
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_documents' ) . ' WHERE id = %d', [ (int) $id ] );
		return ( $row && $row['status'] !== 'removed' ) ? $row : null;
	}

	private static function can_edit( $row ) { return Rest::uid() && ( (int) $row['author_id'] === Rest::uid() || current_user_can( 'manage_options' ) ); }

	private static function unique_slug( $title ) {
		$base = substr( sanitize_title( $title ) ?: 'illustration', 0, 180 );
		$slug = $base; $n = 2;
		while ( Data::col( 'SELECT id FROM ' . Data::t( 'aq_illustrations' ) . ' WHERE slug = %s', [ $slug ] ) ) { $slug = $base . '-' . $n; $n++; }
		return $slug;
	}

	/** Save an AI-painted image (base64, jpg/png/webp) → its public URL, or '' on failure.
	 *  $suffix '' = the final image; 'rN' = the round-N snapshot. */
	private static function save_image( $id, $b64, $suffix ) {
		$bytes = (string) base64_decode( (string) $b64, true );
		if ( strlen( $bytes ) < 256 || strlen( $bytes ) > 24 * 1024 * 1024 ) { return ''; }
		$sig = substr( $bytes, 0, 4 );
		$ext = ( "\xFF\xD8\xFF" === substr( $sig, 0, 3 ) ) ? 'jpg' : ( ( "\x89PNG" === $sig ) ? 'png' : ( ( 'RIFF' === $sig && 'WEBP' === substr( $bytes, 8, 4 ) ) ? 'webp' : '' ) );
		if ( $ext === '' ) { return ''; }
		if ( ! is_array( @getimagesizefromstring( $bytes ) ) ) { return ''; } // must decode as a real image, not just carry the magic
		$up = wp_upload_dir(); if ( ! empty( $up['error'] ) ) { return ''; }
		$dir = $up['basedir'] . '/illustrations'; if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		$name = 'ill-' . (int) $id . ( $suffix !== '' ? '-' . $suffix : '' ) . '.' . $ext;
		if ( file_put_contents( $dir . '/' . $name, $bytes ) === false ) { return ''; }
		@chmod( $dir . '/' . $name, 0644 );
		return $up['baseurl'] . '/illustrations/' . $name;
	}

	/** Drop all improvement rounds + their snapshot files for one illustration. */
	private static function purge_rounds( $id ) {
		global $wpdb;
		foreach ( Data::all( 'SELECT image_url FROM ' . Data::t( 'aq_illust_rounds' ) . ' WHERE illust_id = %d', [ (int) $id ] ) as $r ) {
			self::unlink_file( (string) $r['image_url'] );
		}
		$wpdb->delete( Data::t( 'aq_illust_rounds' ), [ 'illust_id' => (int) $id ] );
	}

	private static function unlink_file( $url ) {
		if ( $url === '' ) { return; }
		// AND THE CDN OBJECT. A file that was migrated to the CDN no longer matches the origin prefix
		// tested below, so this helper used to do NOTHING for it — the row went and the bytes stayed
		// downloadable. Media::destroy resolves a CDN URL to its key and deletes the object; it
		// refuses any other origin, so an external URL is never touched.
		if ( class_exists( '\\AQ\\Media' ) ) { Media::destroy( $url ); }
		$up = wp_upload_dir(); if ( ! empty( $up['error'] ) ) { return; }
		if ( strpos( $url, $up['baseurl'] . '/illustrations/' ) !== 0 ) { return; }
		$p = $up['basedir'] . '/illustrations/' . basename( $url );
		if ( is_file( $p ) ) { @unlink( $p ); }
	}

	/** Illustrations a member made, for their profile (published only). */
	public static function for_profile( $uid, $limit = 12 ) {
		self::ensure_tables();
		return array_map( [ self::class, 'card' ], Data::all(
			'SELECT * FROM ' . Data::t( 'aq_illustrations' ) . ' WHERE author_id = %d AND status = %s ORDER BY id DESC LIMIT %d',
			[ (int) $uid, 'published', (int) $limit ] ) );
	}
}
