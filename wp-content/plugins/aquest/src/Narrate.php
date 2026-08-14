<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaVoice — a narration studio. A member picks a published work they love (a book, a journal article)
 * and a voice in ANY language, and the studio records a read-along audiobook of it: ONE mp3 (Microsoft
 * Edge neural TTS — ~322 voices across ~142 languages — driven from the narration relay), with stored
 * per-block timings so the reader highlights the block being read (the "text follower"). Narrations are
 * SHARED: members publish their own, and viewers pick among all the voices/languages made for a work.
 * Publishing costs ArtaCoins scaled by the work's length; the narrator earns points + a profile credit.
 *
 * One table (self-install — the Music/Motion/Library pattern, isolated from Schema::VERSION):
 *   • aq_narrations — one row per (published work × voice): the recorded narration + its lifecycle.
 */
final class Narrate {

	const TABLE_VERSION = '1';
	const COIN_PER_KWORDS = 1;  // ArtaCoins per ~2000 words of the narrated work (min ₳1)
	const WORDS_PER_COIN  = 2000;
	const DEFAULT_VOICE = 'en-US-AndrewMultilingualNeural';

	/** Narratable targets: where to read the text + how to gate/publish-check it. */
	const TARGETS = [
		'book' => [ 'table' => 'aq_documents', 'html' => 'body_html', 'title' => 'title', 'lang' => 'lang', 'gate' => "status = 'published'" ],
	];

	const STALE_S = 900; // reclaim a 'processing' row whose relay paused after 15 min → resume
	const TRANSLATE_WAIT_MAX_S = 7 * 86400; // a foreign narration waiting on ArtaTranslate longer than this fails + refunds

	/** Block selector — the reader mirrors this exact set + LEAF rule so segment i ↔ the i-th DOM block. */
	const BLOCK = 'self::h1 or self::h2 or self::h3 or self::h4 or self::h5 or self::h6 or self::p or self::li or self::blockquote or self::figcaption';

	public static function ensure_tables() {
		if ( get_option( 'aq_narrations_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		$t = $wpdb->prefix . 'aq_narrations';
		dbDelta( "CREATE TABLE {$t} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			author_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			target_type VARCHAR(12) NOT NULL DEFAULT '',
			target_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			title VARCHAR(255) NOT NULL DEFAULT '',
			voice VARCHAR(48) NOT NULL DEFAULT '',
			lang VARCHAR(12) NOT NULL DEFAULT '',
			audio_url VARCHAR(600) NOT NULL DEFAULT '',
			total_secs INT UNSIGNED NOT NULL DEFAULT 0,
			segments LONGTEXT NULL,
			state VARCHAR(12) NOT NULL DEFAULT 'queued',
			claimed_at INT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			updated INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY target_voice (target_type, target_id, voice),
			KEY target (target_type, target_id, state),
			KEY author (author_id),
			KEY queue (state, id)
		) {$charset};" );
		update_option( 'aq_narrations_table_version', self::TABLE_VERSION, true );
	}

	// ── helpers ──────────────────────────────────────────────────────────────

	private static function target_row( $type, $id ) {
		if ( ! isset( self::TARGETS[ $type ] ) ) { return null; }
		$c    = self::TARGETS[ $type ];
		$lsel = isset( $c['lang'] ) ? ', ' . $c['lang'] . ' AS lang' : ", 'en' AS lang";
		return Data::one( 'SELECT ' . $c['title'] . ' AS title, ' . $c['html'] . ' AS html' . $lsel . ' FROM ' . Data::t( $c['table'] )
			. ' WHERE id = %d AND ' . $c['gate'], [ (int) $id ] );
	}

	/** An Edge-TTS voice id like `en-US-AndrewNeural` / `fr-FR-DeniseNeural`. */
	private static function valid_voice( $v ) { return (bool) preg_match( '/^[a-z]{2,3}-[A-Za-z0-9]+(-[A-Za-z0-9]+)*Neural$/', (string) $v ); }
	private static function lang_of( $v ) { return preg_match( '/^([a-z]{2,3}-[A-Za-z]+)/', (string) $v, $m ) ? $m[1] : ''; }

	/**
	 * Ordered read-along segments — ONE PER LEAF BLOCK (paragraph/heading/list item), in document order,
	 * so the reader can highlight the exact block being read (operator, 2026-07-21: paragraph units, not
	 * sentences — sentence chopping mis-split real prose; the block is the natural, always-correct
	 * boundary; it re-selects the same leaf blocks with the SAME rule, giving a positionally aligned
	 * list). Whitespace-collapsed, so it matches the client's text.
	 */
	public static function segments( $html ) {
		$html = (string) $html;
		if ( trim( $html ) === '' ) { return []; }
		$doc = new \DOMDocument();
		libxml_use_internal_errors( true );
		$doc->loadHTML( '<?xml encoding="utf-8"?><div id="aq-narr-root">' . $html . '</div>', LIBXML_NOWARNING | LIBXML_NOERROR );
		libxml_clear_errors();
		$xp    = new \DOMXPath( $doc );
		$sel   = self::BLOCK;
		$nodes = $xp->query( "//*[({$sel})][not(.//*[{$sel}])]" );
		$out   = [];
		if ( $nodes ) {
			foreach ( $nodes as $n ) {
				$tx = trim( preg_replace( '/\s+/u', ' ', (string) $n->textContent ) );
				if ( $tx !== '' ) { $out[] = $tx; }
			}
		}
		return $out;
	}

	/** ArtaCoins to narrate a work of this many words (min ₳1). */
	public static function cost_for_words( $words ) { return max( 1, (int) ceil( (int) $words / self::WORDS_PER_COIN ) ) * self::COIN_PER_KWORDS; }

	/** Unicode-aware word count — str_word_count() sees only ASCII letters, so Cyrillic/Arabic/Indic
	 *  books counted as ~0 words and were narrated for the ₳1 minimum. Count letter-runs; CJK scripts
	 *  don't space-separate words, so a run there is a whole clause — count those characters singly
	 *  (the standard 1-char≈1-word pricing convention for Chinese/Japanese). */
	public static function count_words( $text ) {
		return (int) preg_match_all( '/[\x{4E00}-\x{9FFF}\x{3400}-\x{4DBF}\x{3040}-\x{30FF}]|\p{L}[\p{L}\p{Mn}\p{Pd}\'’]*+/u', (string) $text );
	}

	private static function save_audio( $name, $b64 ) {
		$bytes = (string) base64_decode( (string) $b64, true );
		$ok = strlen( $bytes ) >= 512 && strlen( $bytes ) <= 120 * 1024 * 1024
			&& ( substr( $bytes, 0, 3 ) === 'ID3' || ( "\xFF" === $bytes[0] && ( ord( $bytes[1] ) & 0xE0 ) === 0xE0 ) );
		if ( ! $ok ) { return ''; }
		$up = wp_upload_dir();
		if ( ! empty( $up['error'] ) ) { return ''; }
		$dir = $up['basedir'] . '/narrations';
		if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		$dest = $dir . '/' . $name . '.mp3';
		if ( file_put_contents( $dest, $bytes ) === false ) { return ''; }
		@chmod( $dest, 0644 );
		return $up['baseurl'] . '/narrations/' . $name . '.mp3';
	}

	private static function card( $row, $names = null ) {
		$aid = (int) $row['author_id'];
		return [
			'id'          => (int) $row['id'],
			'target_type' => (string) $row['target_type'],
			'target_id'   => (int) $row['target_id'],
			'title'       => (string) $row['title'],
			'voice'       => (string) $row['voice'],
			'lang'        => (string) $row['lang'],
			'state'       => (string) $row['state'],
			'audio_url'   => (string) $row['audio_url'],
			'total_secs'  => (int) $row['total_secs'],
			'created'     => (int) $row['created'],
			'author'      => [ 'id' => $aid, 'name' => is_array( $names ) ? (string) ( $names[ $aid ] ?? '' ) : self::name_of( $aid ), 'slug' => self::slug_of( $aid ) ],
		];
	}

	private static function detail_row( $row ) {
		$out = self::card( $row );
		$out['segments'] = json_decode( (string) ( $row['segments'] ?? '' ), true ) ?: [];
		return $out;
	}

	/** Give back exactly what was charged for this narration, once (idempotent by ledger ref). */
	private static function refund( $row ) {
		$ref     = 'narration:' . (int) $row['id'];
		$charged = (int) Data::col(
			'SELECT COALESCE(SUM(delta),0) FROM ' . Data::t( 'aq_coin_ledger' ) . ' WHERE user_id = %d AND reason = %s AND ref = %s',
			[ (int) $row['author_id'], 'narrate', $ref ]
		);
		$back = -$charged; // the charge was negative
		if ( $back <= 0 ) { return; }
		$already = Data::col(
			'SELECT 1 FROM ' . Data::t( 'aq_coin_ledger' ) . ' WHERE user_id = %d AND reason = %s AND ref = %s',
			[ (int) $row['author_id'], 'narrate-refund', $ref ]
		);
		if ( $already ) { return; }
		Economy::credit_coins( (int) $row['author_id'], $back, 'narrate-refund', $ref );
		Notify::push( (int) $row['author_id'], 'narration', 'Narration refunded',
			'The narration of “' . (string) $row['title'] . '” could not be completed — your ₳' . $back . ' is back in your wallet.',
			'/read/' . (int) $row['target_id'] . '/', 'narr-refund:' . (int) $row['id'] );
	}

	private static function name_of( $uid ) { $u = get_userdata( $uid ); return $u ? $u->display_name : ''; }
	private static function slug_of( $uid ) { $u = get_userdata( $uid ); return $u ? $u->user_nicename : ''; }
	private static function row( $id ) { return Data::one( 'SELECT * FROM ' . Data::t( 'aq_narrations' ) . ' WHERE id = %d', [ (int) $id ] ); }

	// ── member-facing ──────────────────────────────────────────────────────────

	/** POST narrations {target_type, target_id, voice} — commission + publish a narration (costs coins). */
	public static function create( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_narrate', 30, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = Rest::uid();
		$type = sanitize_key( (string) Rest::p( $req, 'target_type', 'book' ) );
		$tid  = Rest::pint( $req, 'target_id' );
		$voice= trim( (string) Rest::p( $req, 'voice', self::DEFAULT_VOICE ) );
		if ( ! self::valid_voice( $voice ) ) { return Rest::err( 'bad_voice', 'Pick a narration voice' ); }
		$t = self::target_row( $type, $tid );
		if ( ! $t ) { return Rest::err( 'not_found', 'That publication was not found', 404 ); }
		// One narration per (work, voice) — shared. If it already exists, return it (no re-charge).
		$exists = Data::one( 'SELECT * FROM ' . Data::t( 'aq_narrations' ) . ' WHERE target_type = %s AND target_id = %d AND voice = %s', [ $type, $tid, $voice ] );
		if ( $exists ) { return self::detail_row( $exists ); }
		$segs  = self::segments( (string) $t['html'] );
		if ( ! $segs ) { return Rest::err( 'empty', 'There is nothing to narrate in this work' ); }
		$words = self::count_words( implode( ' ', $segs ) );
		$cost  = self::cost_for_words( $words );
		// Friendly pre-check keeps the exact figure; the authoritative one is inside Economy::spend.
		$bal   = Economy::coin_balance( $uid );
		if ( $bal < $cost ) { return Rest::err( 'insufficient', 'Narrating this ' . number_format( $words ) . '-word work costs ₳' . $cost . ' — you have ₳' . $bal . '.', 402 ); }
		// THE LEDGER REF MUST STAY 'narration:<row id>'. Narrate::refund() — the compensating credit on
		// a translation timeout or an empty-audio failure — looks the charge up by exactly that string,
		// so a ref computed from the natural key (target + voice) makes every refund a silent no-op:
		// the member keeps a failed narration, loses the coins and is never notified. The points award
		// in complete() reads the same ref and would likewise collapse to the minimum.
		//
		// So the row is inserted FIRST, purely to mint its id, and the charge follows under the wallet
		// lock. That is not the old grant-then-charge ordering it replaced: nothing has been delivered
		// at this point — the row is only a queue slot — and a charge that cannot be taken deletes it
		// before the relay can claim it.
		$now = Data::now();
		$id  = Data::insert( 'aq_narrations', [
			'author_id'   => $uid,
			'target_type' => $type,
			'target_id'   => $tid,
			'title'       => mb_substr( (string) $t['title'], 0, 255 ),
			'voice'       => $voice,
			'lang'        => self::lang_of( $voice ),
			'state'       => 'queued',
			'created'     => $now,
			'updated'     => $now,
		] );
		if ( ! $id ) { return Rest::err( 'failed', 'Could not start the narration', 500 ); }
		$paid = Economy::spend( $uid, $cost, 'narrate', 'narration:' . (int) $id );
		if ( $paid !== '' ) {
			global $wpdb;
			$wpdb->delete( Data::t( 'aq_narrations' ), [ 'id' => (int) $id ] ); // unpaid → never queued
			return Economy::spend_error( $paid, $cost, 'Narrating this work' );
		}
		return self::detail_row( self::row( $id ) );
	}

	/** GET narrations?target_type=&target_id= — narrations for a work (the reader's voice list). Public. */
	public static function list_for( $req ) {
		self::ensure_tables();
		$type = sanitize_key( (string) Rest::p( $req, 'target_type', 'book' ) );
		$tid  = Rest::pint( $req, 'target_id' );
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_narrations' ) . ' WHERE target_type = %s AND target_id = %d ORDER BY (state = %s) DESC, id ASC', [ $type, $tid, 'done' ] );
		return [ 'items' => array_map( [ self::class, 'detail_row' ], $rows ) ];
	}

	/** GET narrations/mine — the member's commissioned narrations (the studio list). */
	public static function mine( $req ) {
		self::ensure_tables();
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_narrations' ) . ' WHERE author_id = %d ORDER BY id DESC LIMIT 100', [ Rest::uid() ] );
		return [ 'items' => array_map( [ self::class, 'card' ], $rows ) ];
	}

	/** GET narrations/(id) — one narration (public). */
	public static function get( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Narration not found', 404 ); }
		return self::detail_row( $row );
	}

	/** POST narrations/(id)/delete — owner or operator. */
	public static function remove( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Narration not found', 404 ); }
		if ( (int) $row['author_id'] !== Rest::uid() && ! current_user_can( 'manage_options' ) ) { return Rest::err( 'forbidden', 'Not your narration', 403 ); }
		if ( $row['audio_url'] ) {
			$up = wp_upload_dir();
			$p  = $up['basedir'] . '/narrations/' . basename( (string) $row['audio_url'] );
			if ( is_file( $p ) ) { @unlink( $p ); }
		}
		global $wpdb;
		$wpdb->delete( Data::t( 'aq_narrations' ), [ 'id' => (int) $row['id'] ] );
		return [ 'ok' => true ];
	}

	// ── relay (worker) ──────────────────────────────────────────────────────────

	/** POST relay/narrate/poll — claim the oldest queued (or stale) narration + return its segments. */
	public static function poll( $req ) {
		self::ensure_tables();
		global $wpdb;
		$now = time();
		$t   = Data::t( 'aq_narrations' );
		$row = $wpdb->get_row( $wpdb->prepare(
			"SELECT * FROM {$t} WHERE state = 'queued' OR ( state = 'processing' AND claimed_at < %d ) ORDER BY id ASC LIMIT 1",
			$now - self::STALE_S
		), ARRAY_A );
		if ( ! $row ) { return [ 'job' => null ]; }
		$claimed = (int) $wpdb->query( $wpdb->prepare(
			"UPDATE {$t} SET state = 'processing', claimed_at = %d WHERE id = %d AND ( state = 'queued' OR ( state = 'processing' AND claimed_at < %d ) )",
			$now, (int) $row['id'], $now - self::STALE_S
		) );
		if ( ! $claimed ) { return [ 'job' => null ]; }
		$tr = self::target_row( (string) $row['target_type'], (int) $row['target_id'] );
		if ( ! $tr ) { $wpdb->query( $wpdb->prepare( "UPDATE {$t} SET state='failed' WHERE id=%d", (int) $row['id'] ) ); return [ 'job' => null ]; }
		$segs = self::segments( (string) $tr['html'] );
		if ( ! $segs ) { $wpdb->query( $wpdb->prepare( "UPDATE {$t} SET state='failed' WHERE id=%d", (int) $row['id'] ) ); return [ 'job' => null ]; }
		// TRANSLATED AUDIOBOOKS: a foreign voice reads the work in ITS language, not English. Every
		// sentence goes through the ArtaTranslate mesh at narration priority; until the adversarial
		// queue has upgraded them all, the narration stays claimed and the 15-min stale reclaim
		// re-checks — the audiobook processes slowly over time by design. The reader's per-sentence
		// text follower gets the SAME translations via the mesh cache, so highlight + audio agree.
		// The gate only fires when the voice's language differs from the language the WORK IS
		// WRITTEN IN (aq_documents.lang): a Farsi book narrated by a Farsi voice is read verbatim —
		// before this check, every non-English voice pushed the (already translated) text through
		// the en→X mesh, garbling it and parking the narration behind thousands of queue rows.
		$doc_lang = Translate::mesh_lang( (string) ( $tr['lang'] ?? 'en' ) ) ?: 'en';
		$mesh     = Translate::mesh_lang( (string) $row['lang'] );
		if ( $mesh && $mesh !== $doc_lang && $doc_lang === 'en' ) {
			$ready = Translate::require_ready( $segs, $mesh );
			if ( ! $ready['ready'] ) {
				// TERMINAL GUARD: if the translation queue hasn't delivered within the window (relay
				// down, or a poison sentence the critic keeps skipping), fail + REFUND rather than
				// holding the member's coins hostage in an eternal 'processing' state.
				if ( $now - (int) $row['created'] > self::TRANSLATE_WAIT_MAX_S ) {
					$wpdb->query( $wpdb->prepare( "UPDATE {$t} SET state='failed', updated=%d WHERE id=%d AND state='processing'", $now, (int) $row['id'] ) );
					self::refund( $row );
					return [ 'job' => null ];
				}
				return [ 'job' => null ]; // still claimed → re-checked after STALE_S
			}
			$segs = $ready['texts'];
		}
		return [ 'job' => [ 'id' => (int) $row['id'], 'voice' => (string) $row['voice'], 'title' => (string) $row['title'], 'segments' => $segs ] ];
	}

	/** POST relay/narrate/heartbeat {id} — keep a long chunk-by-chunk job claimed while it progresses. */
	public static function heartbeat( $req ) {
		self::ensure_tables();
		global $wpdb;
		$wpdb->query( $wpdb->prepare( "UPDATE " . Data::t( 'aq_narrations' ) . " SET claimed_at = %d WHERE id = %d AND state = 'processing'", time(), Rest::pint( $req, 'id' ) ) );
		return [ 'ok' => true ];
	}

	/** POST relay/narrate/complete {id, audio_b64, timings} — save the one recorded audio + timings. */
	public static function complete( $req ) {
		self::ensure_tables();
		$row = self::row( Rest::pint( $req, 'id' ) );
		if ( ! $row ) { return Rest::err( 'not_found', 'Narration not found', 404 ); }
		if ( $row['state'] !== 'processing' ) { return [ 'ok' => true, 'ignored' => true ]; }
		$url = self::save_audio( 'narr-' . (int) $row['id'], (string) Rest::p( $req, 'audio_b64', '' ) );
		if ( $url === '' ) {
			Data::update( 'aq_narrations', [ 'state' => 'failed', 'updated' => Data::now() ], [ 'id' => (int) $row['id'], 'state' => 'processing' ] );
			self::refund( $row ); // a failed narration never keeps the member's coins (idempotent by ref)
			return Rest::err( 'empty_narration', 'No usable narration received', 400 );
		}
		$timings = json_decode( (string) Rest::p( $req, 'timings', '' ), true );
		$wrote = (bool) Data::update( 'aq_narrations', [
			'audio_url'  => $url,
			'total_secs' => is_array( $timings ) ? (int) round( (float) ( $timings['total'] ?? 0 ) ) : 0,
			'segments'   => wp_json_encode( is_array( $timings ) ? ( $timings['segments'] ?? [] ) : [] ),
			'state'      => 'done',
			'updated'    => Data::now(),
		], [ 'id' => (int) $row['id'], 'state' => 'processing' ] );
		if ( ! $wrote ) { return [ 'ok' => true, 'ignored' => true ]; }
		// Points ∝ the coins the narration cost — read back what create() actually charged for this ref.
		$paid = (int) Data::col( 'SELECT COALESCE(SUM(-delta),0) FROM ' . Data::t( 'aq_coin_ledger' )
			. " WHERE reason = 'narrate' AND ref = %s", [ 'narration:' . (int) $row['id'] ] );
		Economy::content_points( (int) $row['author_id'], max( 1, $paid ), 'narration:' . (int) $row['id'] );
		Notify::push( (int) $row['author_id'], 'narration', 'Your narration is ready',
			'The read-along of “' . (string) $row['title'] . '” is ready to hear.',
			'/read/' . (int) $row['target_id'] . '/', 'narr-ready:' . (int) $row['id'] );
		return [ 'ok' => true ];
	}

	/** Seed one bundled example narration (the operator's first book, default voice) — platform content, no
	 *  charge, option-gated once. Gives every reader a ready read-along the moment ArtaVoice ships. */
	public static function import_seed() {
		self::ensure_tables();
		if ( get_option( 'aq_narrations_seeded' ) === '1' ) { return; }
		$author = (int) get_option( 'aq_course_author_uid', 0 );
		if ( ! $author ) { return; }
		$book = Data::one( 'SELECT id, title FROM ' . Data::t( 'aq_documents' ) . " WHERE status = 'published' ORDER BY id ASC LIMIT 1" );
		if ( $book ) {
			$voice  = self::DEFAULT_VOICE;
			$exists = (int) Data::col( 'SELECT id FROM ' . Data::t( 'aq_narrations' ) . ' WHERE target_type = %s AND target_id = %d AND voice = %s', [ 'book', (int) $book['id'], $voice ] );
			if ( ! $exists ) {
				$now = Data::now();
				Data::insert( 'aq_narrations', [
					'author_id'   => $author,
					'target_type' => 'book',
					'target_id'   => (int) $book['id'],
					'title'       => mb_substr( (string) $book['title'], 0, 255 ),
					'voice'       => $voice,
					'lang'        => self::lang_of( $voice ),
					'state'       => 'queued',
					'created'     => $now,
					'updated'     => $now,
				] );
			}
		}
		update_option( 'aq_narrations_seeded', '1', true );
	}

	/** Narrations a member commissioned, for their profile (done first). */
	public static function for_profile( $uid, $limit = 12 ) {
		self::ensure_tables();
		return array_map( [ self::class, 'card' ], Data::all(
			'SELECT * FROM ' . Data::t( 'aq_narrations' ) . ' WHERE author_id = %d ORDER BY (state = %s) DESC, id DESC LIMIT %d',
			[ (int) $uid, 'done', (int) $limit ] ) );
	}
}
