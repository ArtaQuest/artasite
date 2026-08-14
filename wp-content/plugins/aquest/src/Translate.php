<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaTranslate — the mesh's slow second pass. The i18n mesh (src/I18n.php) gives every string its
 * FIRST translation instantly via the Google edge; ArtaTranslate then rewrites those edge rows with a
 * state-of-the-art open translation model (TranslateGemma on Hugging Face) hardened by MULTIPLE ROUNDS
 * OF ADVERSARIAL REVIEW (the ArtaScience pattern: draft → attack → rewrite, until the critic can no
 * longer fault it). Upgraded rows flip `status` auto→arta in place, so /i18n/resolve, the SEO layer and
 * the offline langpacks all serve the better translation to the NEXT visitor with zero extra plumbing.
 *
 * The queue IS aq_translations, and it is DEMAND-AWARE (1.60.0): a `status='auto'` row is claimable
 * only when an audiobook narration is waiting on it (priority 2) or real visitors have RE-READ it
 * (`demand` ≥ MIN_DEMAND — I18n::resolve counts each cache-hit re-read, i.e. "this /fa page was
 * visited again"). Ordering is priority DESC, demand DESC — narrations first, then the most-read
 * strings; content nobody reads twice simply keeps its edge translation and costs nothing. The relay
 * daemon (tools/ticket-agent/translate-relay.mjs) claims one small single-language batch per tick, so
 * the upgrade runs as a slow steady drip, never a thundering herd.
 *
 * One extra self-installed table (the Music/Narrate pattern, isolated from Schema::VERSION):
 *   • aq_tr_rounds — the PUBLIC adversarial record: every round's candidate + critique + score,
 *     per (string × language). Radical transparency, like aq_paper_reviews for the journal.
 */
final class Translate {

	const TABLE_VERSION = '2';
	const BATCH         = 24;        // strings per relay job — small on purpose (slow drip)
	const STALE_S       = 7200;      // reclaim a claimed batch after 2h (crashed relay / failed items back off this long)
	const MAX_SRC_LEN   = 5000;      // matches the mesh cap (i18n.ts MAX_LEN)
	const EPOCH_MIN_S   = 21600;     // bump a language's client-cache epoch at most every 6h
	const READY_MAX_OPS = 800;       // max rows require_ready() inserts/updates per call (bounds Narrate::poll)
	// DEMAND GATE (1.60.0): a row is upgradeable only when a member is waiting on it (priority 2 —
	// narration) or real visitors have RE-READ it (demand ≥ this; the creating visit is #1, each later
	// cache-hit resolve bumps demand — so 1 = "visited multiple times"). Everything else just keeps its
	// edge translation: the adversarial budget goes exclusively to content people actually read.
	const MIN_DEMAND    = 1;
	// AUTO-IMPROVEMENT LANGUAGES (operator directive 2026-07-04): the demand-driven tier upgrades ONLY
	// these — the world's most-spoken languages (Chinese incl. Traditional, Hindi, Arabic, Spanish,
	// Javanese, Portuguese, Hausa, Punjabi, Bengali, Russian, Persian, Japanese, Vietnamese, German,
	// Turkish, French, Korean, Zulu, Italian; English is the source). Every other language still gets
	// its instant edge translation, and member-paid narrations (priority 2) are EXEMPT — a commissioned
	// audiobook is explicit demand in its own language, not an "auto" improvement. Demand keeps being
	// counted for all languages, so widening this list later needs no backfill.
	const AUTO_LANGS = [ 'zh', 'zh-tw', 'hi', 'ar', 'es', 'jv', 'pt', 'ha', 'pa', 'bn', 'ru', 'fa', 'ja', 'vi', 'de', 'tr', 'fr', 'ko', 'zu', 'it' ];
	// GARBAGE COLLECTION (the aq_tr_gc daily cron). The mesh is a CACHE, not a source of truth — any
	// non-curated row can be deleted safely (the next visitor re-translates on the edge). Editing an
	// English original doesn't overwrite its translations, it ORPHANS them (new text → new hashes), so
	// the GC diffs book fingerprints to purge them precisely, and sweeps cold rows as the catch-all.
	const GC_BOOKS_RUN  = 50;    // books fingerprint-checked per nightly run (catches up over days)
	const GC_EMPTY_DAYS = 30;    // empty narration placeholders older than this are dropped (require_ready re-inserts if still needed)
	const GC_UNUSED_DAYS = 180;  // rows not SERVED anywhere for this long are purged — any status incl. arta (self-healing cache)
	const GC_BATCH      = 20000; // max unused rows deleted per run (bounds the nightly write load)
	const READ_TOUCH_S  = 7 * 86400; // read_at stamp coarseness: at most one usage write per row per week (bounds hot-path writes)

	public static function ensure_tables() {
		if ( get_option( 'aq_tr_rounds_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		$t = $wpdb->prefix . 'aq_tr_rounds';
		dbDelta( "CREATE TABLE {$t} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			source_hash CHAR(32) NOT NULL DEFAULT '',
			lang VARCHAR(12) NOT NULL DEFAULT '',
			round TINYINT UNSIGNED NOT NULL DEFAULT 0,
			engine VARCHAR(40) NOT NULL DEFAULT '',
			candidate TEXT NULL,
			critique TEXT NULL,
			score TINYINT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY string_lang (source_hash, lang, round)
		) {$charset};" );
		// v2 (GC): one fingerprint per published work — the segment-hash set its translations were made
		// from. The nightly GC diffs it against the current text; hashes that disappeared belong to an
		// EDITED original, and their translations are purged everywhere (every language, incl. arta).
		$s = $wpdb->prefix . 'aq_tr_sources';
		dbDelta( "CREATE TABLE {$s} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			target_type VARCHAR(12) NOT NULL DEFAULT 'book',
			target_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			sig CHAR(32) NOT NULL DEFAULT '',
			hashes LONGTEXT NULL,
			updated INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY target (target_type, target_id)
		) {$charset};" );
		update_option( 'aq_tr_rounds_table_version', self::TABLE_VERSION, true );
	}

	// ── the client-cache epoch ───────────────────────────────────────────────
	// Upgraded rows must reach RETURNING visitors too, but the SPA seeds itself from a per-language
	// localStorage cache before ever asking /i18n/resolve. The epoch is a per-language integer in the
	// boot config; when it moves, the client drops its local cache and refills from the DB (cheap,
	// batched). Bumped on upgrade, rate-limited so a long backfill doesn't nuke caches every tick.

	public static function epoch( $lang ) {
		$e = get_option( 'aq_tr_epochs', [] );
		$l = $e[ $lang ] ?? null;
		if ( ! is_array( $l ) ) { return 0; }
		// Apply a DEFERRED bump lazily: a bump inside the rate-limit window sets `d` instead of being
		// dropped — otherwise a language whose last rows are upgraded just after a bump would never
		// invalidate returning visitors' caches again (the queue is empty, so no future complete()).
		if ( ! empty( $l['d'] ) && time() - (int) ( $l['at'] ?? 0 ) >= self::EPOCH_MIN_S ) {
			$e[ $lang ] = [ 'e' => (int) ( $l['e'] ?? 0 ) + 1, 'at' => time() ];
			update_option( 'aq_tr_epochs', $e, false );
			return (int) $e[ $lang ]['e'];
		}
		return (int) ( $l['e'] ?? 0 );
	}

	private static function bump_epoch( $lang ) {
		$e   = get_option( 'aq_tr_epochs', [] );
		$now = time();
		$l   = is_array( $e[ $lang ] ?? null ) ? $e[ $lang ] : [];
		$at  = (int) ( $l['at'] ?? 0 );
		if ( $now - $at < self::EPOCH_MIN_S ) {
			if ( empty( $l['d'] ) ) { $e[ $lang ] = $l + [ 'd' => 1 ]; update_option( 'aq_tr_epochs', $e, false ); }
			return; // deferred — epoch() applies it once the window passes
		}
		$e[ $lang ] = [ 'e' => (int) ( $l['e'] ?? 0 ) + 1, 'at' => $now ];
		update_option( 'aq_tr_epochs', $e, false );
	}

	// ── relay (worker) ───────────────────────────────────────────────────────

	/** The AUTO_LANGS list as a safe SQL IN-list (const literals only — codes are [a-z-]). */
	private static function auto_langs_sql() {
		return "'" . implode( "','", array_map( 'esc_sql', self::AUTO_LANGS ) ) . "'";
	}

	/**
	 * POST relay/translate/poll — claim one single-language batch of CLAIMABLE rows: narration
	 * sentences (priority 2, ANY language — member-paid) first, then IN-DEMAND strings (demand ≥
	 * MIN_DEMAND in an AUTO_LANGS language), most-read first. Rows nobody re-reads — and demand rows
	 * outside the focus languages — are never claimed: the edge translation stays, no quota is spent.
	 * The head decides the batch's language (the adversarial critic reviews one language at a time).
	 * Returns { job: { lang, lang_name, items: [ { hash, source, google } ] } } or { job: null }.
	 */
	public static function poll( $req ) {
		self::ensure_tables();
		global $wpdb;
		$t     = Data::t( 'aq_translations' );
		$now   = time();
		$stale = $now - self::STALE_S;
		// DEMAND-AWARE HEAD: the batch language comes from the most urgent claimable row. Two indexed
		// probes instead of one OR-query (each walks a small subset: priority=2 is the narration set,
		// demand ≥ MIN_DEMAND is exactly the in-demand set) — narrations first, then the most-read row.
		$head = Data::one(
			"SELECT lang FROM {$t} WHERE status = 'auto' AND claimed_at < %d AND lang <> 'en' AND priority = 2
			 AND source_text IS NOT NULL AND source_text <> '' ORDER BY demand DESC, id DESC LIMIT 1",
			[ $stale ]
		);
		if ( ! $head ) {
			$auto = self::auto_langs_sql();
			$head = Data::one(
				"SELECT lang FROM {$t} WHERE status = 'auto' AND claimed_at < %d AND lang IN ($auto) AND demand >= %d
				 AND source_text IS NOT NULL AND source_text <> '' ORDER BY priority DESC, demand DESC, id DESC LIMIT 1",
				[ $stale, self::MIN_DEMAND ]
			);
		}
		if ( ! $head ) { return [ 'job' => null ]; } // nothing in demand — the relay idles, no quota spent
		$lang = (string) $head['lang'];
		// The batch gate mirrors the heads: narration rows always; demand rows only in an AUTO language
		// (a narration batch in a non-listed language stays pure narration — its demand rows are excluded).
		$in_auto = in_array( $lang, self::AUTO_LANGS, true ) ? 1 : 0;
		$rows = Data::all(
			"SELECT id, source_hash, source_text, translated_text FROM {$t}
			 WHERE status = 'auto' AND claimed_at < %d AND lang = %s
			 AND ( priority = 2 OR ( %d = 1 AND demand >= %d ) )
			 AND source_text IS NOT NULL AND source_text <> ''
			 ORDER BY priority DESC, demand DESC, id DESC LIMIT %d",
			[ $stale, $lang, $in_auto, self::MIN_DEMAND, self::BATCH ]
		);
		if ( ! $rows ) { return [ 'job' => null ]; }
		$ids   = array_map( static fn( $r ) => (int) $r['id'], $rows );
		$place = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
		$got   = (int) $wpdb->query( $wpdb->prepare(
			"UPDATE {$t} SET claimed_at = %d WHERE id IN ($place) AND status = 'auto' AND claimed_at < %d",
			array_merge( [ $now ], $ids, [ $stale ] )
		) );
		if ( ! $got ) { return [ 'job' => null ]; } // another poller won the whole batch
		// Re-select ONLY the rows THIS claim stamped: with two overlapping pollers, $rows may include
		// rows the other worker owns — serving them here would duplicate a full HF+Claude pipeline run.
		$rows = Data::all(
			"SELECT id, source_hash, source_text, translated_text FROM {$t}
			 WHERE id IN ($place) AND status = 'auto' AND claimed_at = %d ORDER BY priority DESC, demand DESC, id DESC",
			array_merge( $ids, [ $now ] )
		);
		$items = [];
		foreach ( $rows as $r ) {
			$src = (string) $r['source_text'];
			if ( mb_strlen( $src ) > self::MAX_SRC_LEN ) {
				// Over the mesh cap (shouldn't normally exist) — retire it TERMINALLY, or it would be
				// re-claimed and re-dropped every STALE_S forever, wedging batch slots. It keeps serving
				// its edge translation; 'skip' just removes it from the upgrade queue (auditable in /data).
				$wpdb->query( $wpdb->prepare( "UPDATE {$t} SET status = 'skip', claimed_at = 0 WHERE id = %d AND status = 'auto'", (int) $r['id'] ) );
				continue;
			}
			$items[] = [ 'hash' => (string) $r['source_hash'], 'source' => $src, 'google' => (string) ( $r['translated_text'] ?? '' ) ];
		}
		if ( ! $items ) { return [ 'job' => null ]; }
		$reg = I18n::lang_name( $lang );
		return [ 'job' => [ 'lang' => $lang, 'lang_name' => $reg, 'items' => $items ] ];
	}

	/**
	 * POST relay/translate/complete {lang, engine, items:[{hash, text, quality, rounds:[{engine,candidate,critique,score}]} | {hash, skip:1}]}
	 * — persist the adversarially-improved translations. Upgrades flip auto→arta IN PLACE and are
	 * idempotent + monotonic (a row already 'arta' is never touched, so an out-of-order duplicate
	 * complete can never downgrade). Skipped items back off via their claim timestamp (STALE_S)
	 * before the queue retries them, so a poison string costs at most one batch slot per window.
	 */
	public static function complete( $req ) {
		self::ensure_tables();
		global $wpdb;
		$lang = strtolower( trim( (string) Rest::p( $req, 'lang', '' ) ) );
		$items = Rest::p( $req, 'items', [] );
		$items = is_array( $items ) ? array_slice( $items, 0, self::BATCH * 2 ) : [];
		if ( $lang === '' || $lang === 'en' || ! $items ) { return [ 'ok' => true, 'saved' => 0 ]; }
		$engine = trim( (string) Rest::p( $req, 'engine', '' ) );
		if ( $engine !== '' ) { update_option( 'aq_tr_engine', mb_substr( $engine, 0, 120 ), false ); }
		$t = Data::t( 'aq_translations' );
		$rt = Data::t( 'aq_tr_rounds' );
		$now = time();
		$saved = 0;
		foreach ( $items as $it ) {
			$hash = isset( $it['hash'] ) ? (string) $it['hash'] : '';
			if ( ! preg_match( '/^[a-f0-9]{32}$/', $hash ) ) { continue; }
			if ( ! empty( $it['skip'] ) ) {
				// Not verified this tick (critic unavailable/omitted it) — the fresh claim timestamp IS the
				// retry backoff (STALE_S). Priority is kept: a narration sentence must not sink to the backlog.
				$wpdb->query( $wpdb->prepare(
					"UPDATE {$t} SET claimed_at = %d WHERE source_hash = %s AND lang = %s AND status = 'auto'",
					$now, $hash, $lang
				) );
				continue;
			}
			$text = isset( $it['text'] ) ? trim( (string) $it['text'] ) : '';
			if ( $text === '' || mb_strlen( $text ) > 2 * self::MAX_SRC_LEN ) { continue; }
			$quality = max( 0, min( 100, (int) ( $it['quality'] ?? 0 ) ) );
			$did = (int) $wpdb->query( $wpdb->prepare(
				"UPDATE {$t} SET translated_text = %s, status = 'arta', quality = %d, claimed_at = 0, updated_at = %s
				 WHERE source_hash = %s AND lang = %s AND status = 'auto'",
				$text, $quality, current_time( 'mysql' ), $hash, $lang
			) );
			if ( ! $did ) { continue; } // already upgraded (duplicate complete) — keep the first record
			$saved++;
			// The public adversarial record — replace wholesale so a stale-reclaimed rerun never duplicates.
			$wpdb->query( $wpdb->prepare( "DELETE FROM {$rt} WHERE source_hash = %s AND lang = %s", $hash, $lang ) );
			$rounds = isset( $it['rounds'] ) && is_array( $it['rounds'] ) ? array_slice( $it['rounds'], 0, 12 ) : [];
			$n = 0;
			foreach ( $rounds as $r ) {
				Data::insert( 'aq_tr_rounds', [
					'source_hash' => $hash,
					'lang'        => $lang,
					'round'       => ++$n,
					'engine'      => mb_substr( (string) ( $r['engine'] ?? '' ), 0, 40 ),
					'candidate'   => mb_substr( (string) ( $r['candidate'] ?? '' ), 0, 2 * self::MAX_SRC_LEN ),
					'critique'    => mb_substr( (string) ( $r['critique'] ?? '' ), 0, 4000 ),
					'score'       => max( 0, min( 100, (int) ( $r['score'] ?? 0 ) ) ),
					'created'     => $now,
				] );
			}
		}
		if ( $saved ) { self::bump_epoch( $lang ); }
		return [ 'ok' => true, 'saved' => $saved ];
	}

	/**
	 * POST relay/translate/curate {lang, engine, items:[{hash, text, quality, rounds:[…]}]}
	 * — the CURATED override: write a hand-verified translation over whatever the row holds now,
	 * INCLUDING a row an earlier adversarial pass already flipped to 'arta'.
	 *
	 * complete() is deliberately monotonic — it touches `status='auto'` and nothing else — so a
	 * duplicate or out-of-order relay POST can never undo an upgrade. That guard is exactly what
	 * makes the automatic pipeline safe to run unattended, and relaxing it in place would put every
	 * upgraded row back at the mercy of a stale retry. So this is a SEPARATE route: the relay has no
	 * code path that reaches it, and an override is only ever a deliberate act by whoever holds the
	 * worker token. Curated writes are as public as automatic ones — the rounds record is replaced,
	 * not appended, so /translate/rounds shows why the text changed.
	 *
	 * UPDATE ONLY, never INSERT. A curated correction fixes a string the mesh already serves; a
	 * string with no row yet enters through the ordinary public path (i18n/save) first and can be
	 * curated on the next call. That keeps this route unable to invent mesh content of its own.
	 *
	 * Returns { saved, unchanged, missing } — an UPDATE that matches a row already holding the exact
	 * text reports 0 affected, so counting it as saved would overstate the work. The caller needs to
	 * tell "already correct" apart from "no such row" to know whether a seed step is still owed.
	 */
	public static function curate( $req ) {
		self::ensure_tables();
		global $wpdb;
		$lang  = strtolower( trim( (string) Rest::p( $req, 'lang', '' ) ) );
		$items = Rest::p( $req, 'items', [] );
		$items = is_array( $items ) ? array_slice( $items, 0, self::BATCH * 2 ) : [];
		if ( $lang === '' || $lang === 'en' || ! $items ) { return [ 'ok' => true, 'saved' => 0, 'unchanged' => 0, 'missing' => 0 ]; }
		$engine = trim( (string) Rest::p( $req, 'engine', '' ) );
		if ( $engine !== '' ) { update_option( 'aq_tr_engine', mb_substr( $engine, 0, 120 ), false ); }
		$t         = Data::t( 'aq_translations' );
		$rt        = Data::t( 'aq_tr_rounds' );
		$now       = time();
		$saved     = 0;
		$unchanged = 0;
		$missing   = 0;
		foreach ( $items as $it ) {
			$hash = isset( $it['hash'] ) ? (string) $it['hash'] : '';
			if ( ! preg_match( '/^[a-f0-9]{32}$/', $hash ) ) { continue; }
			$text = isset( $it['text'] ) ? trim( (string) $it['text'] ) : '';
			// An empty override would BLANK a served string (resolve() reads '' as missing), which is a
			// worse outcome than any translation it could replace. Refuse it here rather than trusting
			// the caller — this route exists precisely to write where the monotonic guard would not.
			if ( $text === '' || mb_strlen( $text ) > 2 * self::MAX_SRC_LEN ) { continue; }
			$cur = Data::one( "SELECT translated_text FROM {$t} WHERE source_hash = %s AND lang = %s", [ $hash, $lang ] );
			if ( ! $cur ) { $missing++; continue; }
			if ( (string) $cur['translated_text'] === $text ) { $unchanged++; continue; }
			$quality = max( 0, min( 100, (int) ( $it['quality'] ?? 0 ) ) );
			$wpdb->query( $wpdb->prepare(
				"UPDATE {$t} SET translated_text = %s, status = 'arta', quality = %d, claimed_at = 0, updated_at = %s
				 WHERE source_hash = %s AND lang = %s",
				$text, $quality, current_time( 'mysql' ), $hash, $lang
			) );
			$saved++;
			$wpdb->query( $wpdb->prepare( "DELETE FROM {$rt} WHERE source_hash = %s AND lang = %s", $hash, $lang ) );
			$rounds = isset( $it['rounds'] ) && is_array( $it['rounds'] ) ? array_slice( $it['rounds'], 0, 12 ) : [];
			$n = 0;
			foreach ( $rounds as $r ) {
				Data::insert( 'aq_tr_rounds', [
					'source_hash' => $hash,
					'lang'        => $lang,
					'round'       => ++$n,
					'engine'      => mb_substr( (string) ( $r['engine'] ?? '' ), 0, 40 ),
					'candidate'   => mb_substr( (string) ( $r['candidate'] ?? '' ), 0, 2 * self::MAX_SRC_LEN ),
					'critique'    => mb_substr( (string) ( $r['critique'] ?? '' ), 0, 4000 ),
					'score'       => max( 0, min( 100, (int) ( $r['score'] ?? 0 ) ) ),
					'created'     => $now,
				] );
			}
		}
		if ( $saved ) { self::bump_epoch( $lang ); }
		return [ 'ok' => true, 'saved' => $saved, 'unchanged' => $unchanged, 'missing' => $missing ];
	}

	// ── narration gate (ArtaVoice audiobook translation) ─────────────────────

	/**
	 * A foreign-voice narration must read ARTA-QUALITY sentences, not raw edge output. Given a book's
	 * ordered sentence segments and a mesh language, this queues every sentence at narration priority
	 * and reports readiness. Returns [ 'ready' => bool, 'texts' => aligned translated segments ].
	 * Caller (Narrate::poll) keeps the narration claimed while ready=false; the 15-min stale reclaim
	 * naturally re-checks until the queue has upgraded every sentence — the audiobook processes
	 * slowly over time by design. Work per call is bounded (READY_MAX_OPS inserts/bumps).
	 */
	public static function require_ready( array $texts, $lang ) {
		self::ensure_tables();
		global $wpdb;
		$t = Data::t( 'aq_translations' );
		$by_hash = [];
		foreach ( $texts as $s ) {
			$s = (string) $s;
			if ( trim( $s ) !== '' && mb_strlen( $s ) <= self::MAX_SRC_LEN ) { $by_hash[ md5( $s ) ] = $s; }
		}
		if ( ! $by_hash ) { return [ 'ready' => true, 'texts' => $texts ]; }
		$found = [];
		foreach ( array_chunk( array_keys( $by_hash ), 500 ) as $chunk ) {
			$place = implode( ',', array_fill( 0, count( $chunk ), '%s' ) );
			$rows  = Data::all(
				"SELECT source_hash, translated_text, status, priority FROM {$t} WHERE lang = %s AND source_hash IN ($place)",
				array_merge( [ $lang ], $chunk )
			);
			foreach ( $rows as $r ) { $found[ $r['source_hash'] ] = $r; }
		}
		$ready = true;
		$ops   = 0;
		$dict  = [];
		$bump  = [];
		foreach ( $by_hash as $h => $src ) {
			$row = $found[ $h ] ?? null;
			if ( $row && $row['status'] === 'arta' && (string) $row['translated_text'] !== '' ) {
				$dict[ $h ] = (string) $row['translated_text'];
				continue;
			}
			$ready = false;
			if ( $ops >= self::READY_MAX_OPS ) { continue; } // the next stale-reclaim pass continues from here
			if ( ! $row ) {
				// Enter the mesh with no edge baseline — the SOTA pass will draft it. resolve()/translate()
				// treat an empty translated_text as missing, so page visitors are unaffected meanwhile.
				// Suppressed: losing the UNIQUE(hash, lang) race against I18n::store is expected + benign.
				$prev = $wpdb->suppress_errors( true );
				Data::insert( 'aq_translations', [
					'source_hash' => $h, 'lang' => $lang, 'source_text' => $src, 'translated_text' => '',
					'context' => 'narration', 'status' => 'auto', 'priority' => 2,
					'updated_at' => current_time( 'mysql' ),
				] );
				$wpdb->suppress_errors( $prev );
				$ops++;
			} elseif ( (int) $row['priority'] < 2 ) {
				$bump[] = $h;
				$ops++;
			}
		}
		foreach ( array_chunk( $bump, 500 ) as $chunk ) {
			$place = implode( ',', array_fill( 0, count( $chunk ), '%s' ) );
			$wpdb->query( $wpdb->prepare(
				"UPDATE {$t} SET priority = 2 WHERE lang = %s AND status = 'auto' AND source_hash IN ($place)",
				array_merge( [ $lang ], $chunk )
			) );
		}
		$out = [];
		foreach ( $texts as $s ) {
			$s = (string) $s;
			$out[] = $dict[ md5( $s ) ] ?? $s;
		}
		return [ 'ready' => $ready, 'texts' => $out ];
	}

	/**
	 * Map an Edge-TTS voice language ('fr-FR', 'pt-BR', 'zh-CN'…) onto a mesh locale code, or ''.
	 * '' means "no mesh coverage" — the narration falls back to reading the English source (the
	 * pre-ArtaTranslate behaviour), which only happens for the few Edge languages outside the ~133.
	 */
	public static function mesh_lang( $voice_lang ) {
		$v = strtolower( trim( (string) $voice_lang ) );
		if ( $v === '' ) { return ''; }
		if ( strpos( $v, 'zh-tw' ) === 0 || strpos( $v, 'zh-hk' ) === 0 ) { return 'zh-tw'; }
		$base = explode( '-', $v )[0];
		$alias = [ 'fil' => 'tl', 'iw' => 'he', 'jw' => 'jv', 'nb' => 'nb', 'nn' => 'nb', 'prs' => 'fa' ];
		$base  = $alias[ $base ] ?? $base;
		if ( I18n::is_locale( $v ) ) { return $v; }
		return I18n::is_locale( $base ) ? $base : '';
	}

	// ── garbage collection (the aq_tr_gc daily cron) ─────────────────────────

	/**
	 * Purge every trace of the given source hashes from the mesh — all languages, edge and arta alike
	 * (an edited original's OLD translations must go everywhere), plus their public round records.
	 * Operator-curated 'human' rows are never auto-deleted. Returns rows removed.
	 */
	public static function purge_hashes( array $hashes ) {
		global $wpdb;
		$t  = Data::t( 'aq_translations' );
		$rt = Data::t( 'aq_tr_rounds' );
		$n  = 0;
		foreach ( array_chunk( array_values( array_unique( $hashes ) ), 500 ) as $chunk ) {
			$place = implode( ',', array_fill( 0, count( $chunk ), '%s' ) );
			$n += (int) $wpdb->query( $wpdb->prepare( "DELETE FROM {$t} WHERE source_hash IN ($place) AND status <> 'human'", $chunk ) );
			$wpdb->query( $wpdb->prepare( "DELETE FROM {$rt} WHERE source_hash IN ($place)", $chunk ) );
		}
		return $n;
	}

	/** A published work's translatable strings, as the hash set its fingerprint stores. */
	private static function doc_hashes( $row ) {
		$strings = Narrate::segments( (string) ( $row['body_html'] ?? '' ) );
		foreach ( [ 'title', 'summary' ] as $k ) {
			$v = trim( (string) ( $row[ $k ] ?? '' ) );
			if ( $v !== '' ) { $strings[] = $v; }
		}
		$hashes = [];
		foreach ( $strings as $s ) { $hashes[ md5( $s ) ] = 1; }
		return array_keys( $hashes );
	}

	/**
	 * Nightly GC (WP-cron `aq_tr_gc`, via Cron::guard). The mesh is a cache — a deleted row costs at
	 * most one edge re-translate on the next visit — so hygiene is cheap and safe. Four bounded passes:
	 *   1. EDITED ORIGINALS: fingerprint every recently-updated published book (segments + title +
	 *      summary); hashes that disappeared since the stored fingerprint are an edit's leftovers —
	 *      purge their translations EVERYWHERE (every language, edge + arta + rounds).
	 *   2. Abandoned empty narration placeholders (> GC_EMPTY_DAYS; require_ready re-inserts if needed).
	 *   3. UNUSED ANYWHERE: rows not served for GC_UNUSED_DAYS (read_at — stamped by resolve + the SEO
	 *      path), any status incl. arta — content updates never bloat the DB, debris always drains.
	 *   4. Orphaned round records (their translation row is gone).
	 *   5. Orphaned book fingerprints (their book was deleted/unpublished).
	 * Stats land in the `aq_tr_gc_stats` option (shown on /translate/status).
	 */
	public static function gc() {
		self::ensure_tables();
		global $wpdb;
		$t     = Data::t( 'aq_translations' );
		$rt    = Data::t( 'aq_tr_rounds' );
		$st    = Data::t( 'aq_tr_sources' );
		$now   = time();
		$stats = [ 'at' => $now, 'books' => 0, 'edited' => 0, 'purged' => 0, 'empty' => 0, 'cold' => 0, 'rounds' => 0, 'fps' => 0 ];

		// 1. Edited originals — fingerprint diff over published books, walked oldest-updated-first
		// behind an advancing watermark: a full batch advances it only to the last book processed (so
		// the initial catch-up completes over successive nights), an empty/partial batch parks it one
		// day behind now (so a book edited mid-run is still seen next night; unchanged sigs are no-ops).
		$water = (int) get_option( 'aq_tr_gc_water', 0 );
		$maxu  = $water;
		$docs  = Data::all(
			'SELECT id, title, summary, body_html, updated FROM ' . Data::t( 'aq_documents' )
			. " WHERE status = 'published' AND updated >= %d ORDER BY updated ASC LIMIT %d",
			[ $water, self::GC_BOOKS_RUN ]
		);
		foreach ( $docs as $doc ) {
			$maxu = max( $maxu, (int) $doc['updated'] );
			$stats['books']++;
			$sig = md5( (string) ( $doc['body_html'] ?? '' ) . '|' . (string) ( $doc['title'] ?? '' ) . '|' . (string) ( $doc['summary'] ?? '' ) );
			$fp  = Data::one( "SELECT id, sig, hashes FROM {$st} WHERE target_type = 'book' AND target_id = %d", [ (int) $doc['id'] ] );
			if ( $fp && $fp['sig'] === $sig ) { continue; } // unchanged since last fingerprint
			$hashes = self::doc_hashes( $doc );
			if ( $fp ) {
				$removed = array_diff( explode( ',', (string) $fp['hashes'] ), $hashes );
				$removed = array_filter( $removed, static fn( $h ) => preg_match( '/^[a-f0-9]{32}$/', $h ) );
				if ( $removed ) {
					$stats['edited']++;
					$stats['purged'] += self::purge_hashes( $removed );
				}
				Data::update( 'aq_tr_sources', [ 'sig' => $sig, 'hashes' => implode( ',', $hashes ), 'updated' => $now ], [ 'id' => (int) $fp['id'] ] );
			} else {
				Data::insert( 'aq_tr_sources', [
					'target_type' => 'book', 'target_id' => (int) $doc['id'],
					'sig' => $sig, 'hashes' => implode( ',', $hashes ), 'updated' => $now,
				] );
			}
		}
		update_option( 'aq_tr_gc_water', count( $docs ) >= self::GC_BOOKS_RUN ? $maxu : max( 0, $now - DAY_IN_SECONDS ), false );

		// 2. Abandoned empty narration placeholders (their narration failed/refunded long ago).
		$cut = gmdate( 'Y-m-d H:i:s', $now - self::GC_EMPTY_DAYS * DAY_IN_SECONDS );
		$ids = array_column( Data::all(
			"SELECT id FROM {$t} WHERE status = 'auto' AND translated_text = '' AND updated_at < %s LIMIT 5000", [ $cut ]
		), 'id' );
		$stats['empty'] = self::delete_ids( $t, $ids );

		// 3. UNUSED ANYWHERE — the anti-bloat sweep. A row not SERVED for GC_UNUSED_DAYS (read_at is
		// stamped by every resolve AND the SEO path, coarsely) whose last write is equally old is
		// debris: its source was edited away, its content deleted, or its UI copy changed. Purged
		// regardless of status (arta included) and past demand — demand is history, read_at is now.
		// Self-healing: if that string ever reappears, the edge re-translates it in milliseconds.
		// Never touches narration rows (priority 2 — they back a paid audiobook's text follower),
		// claimed rows, or operator-curated 'human' rows. read_at=0 legacy rows fall back to their
		// updated_at age, so nothing freshly written or freshly upgraded is ever swept.
		$cut_s  = $now - self::GC_UNUSED_DAYS * DAY_IN_SECONDS;
		$cut_dt = gmdate( 'Y-m-d H:i:s', $cut_s );
		$ids = array_column( Data::all(
			"SELECT id FROM {$t} WHERE status IN ('auto','skip','arta') AND priority < 2
			 AND claimed_at = 0 AND read_at < %d AND ( updated_at IS NULL OR updated_at < %s ) LIMIT %d",
			[ $cut_s, $cut_dt, self::GC_BATCH ]
		), 'id' );
		$stats['cold'] = self::delete_ids( $t, $ids );

		// 4. Orphaned round records (after purges/deletes above; cap matches the unused batch).
		$ids = array_column( Data::all(
			"SELECT r.id FROM {$rt} r LEFT JOIN {$t} x ON x.source_hash = r.source_hash AND x.lang = r.lang
			 WHERE x.id IS NULL LIMIT %d", [ self::GC_BATCH ]
		), 'id' );
		$stats['rounds'] = self::delete_ids( $rt, $ids );

		// 5. Orphaned fingerprints — books deleted/unpublished leave their aq_tr_sources row behind.
		$ids = array_column( Data::all(
			"SELECT s.id FROM {$st} s LEFT JOIN " . Data::t( 'aq_documents' ) . " d
			 ON d.id = s.target_id AND d.status = 'published'
			 WHERE s.target_type = 'book' AND d.id IS NULL LIMIT 1000"
		), 'id' );
		$stats['fps'] = self::delete_ids( $st, $ids );

		update_option( 'aq_tr_gc_stats', $stats, false );
		delete_transient( 'aq_tr_status' ); // the public status card reflects the sweep immediately
		return $stats;
	}

	/** Chunked DELETE by primary key (portable: SQLite's translated DELETE has no LIMIT). */
	private static function delete_ids( $table, array $ids ) {
		global $wpdb;
		$n = 0;
		foreach ( array_chunk( array_map( 'intval', $ids ), 500 ) as $chunk ) {
			$place = implode( ',', array_fill( 0, count( $chunk ), '%d' ) );
			$n += (int) $wpdb->query( $wpdb->prepare( "DELETE FROM {$table} WHERE id IN ($place)", $chunk ) );
		}
		return $n;
	}

	// ── public transparency ──────────────────────────────────────────────────

	/** GET translate/status — the live public picture of the upgrade queue + recent adversarial work.
	 *  Cached 60s in a transient: the counts walk large index prefixes on the 300k+ prod table, and the
	 *  route is public — without this, cache-busted query strings would be a cheap amplification vector. */
	public static function status( $req ) {
		$cached = get_transient( 'aq_tr_status' );
		if ( is_array( $cached ) ) { return $cached; }
		self::ensure_tables();
		$t  = Data::t( 'aq_translations' );
		$rt = Data::t( 'aq_tr_rounds' );
		$totals = [
			'auto' => (int) Data::col( "SELECT COUNT(*) FROM {$t} WHERE status = 'auto'" ),
			'arta' => (int) Data::col( "SELECT COUNT(*) FROM {$t} WHERE status = 'arta'" ),
		];
		// Seed the tiers so an absent bucket is 0, not a missing key (and the empty map still
		// serializes as a JSON object, never []).
		$queue = [ 'p2' => 0, 'p1' => 0, 'p0' => 0 ];
		foreach ( Data::all( "SELECT priority, COUNT(*) AS n FROM {$t} WHERE status = 'auto' GROUP BY priority" ) as $r ) {
			$queue[ 'p' . (int) $r['priority'] ] = (int) $r['n'];
		}
		// Demand-aware tiers (1.60.0): `demanded` = in-demand strings awaiting upgrade (claimable —
		// demand ≥ MIN in an auto-improvement language); `waiting` = cached on the edge, upgraded only
		// if visitors return to them (or outside the focus languages).
		$auto = self::auto_langs_sql();
		$queue['demanded'] = (int) Data::col(
			"SELECT COUNT(*) FROM {$t} WHERE status = 'auto' AND demand >= %d AND priority < 2 AND lang IN ($auto)", [ self::MIN_DEMAND ]
		);
		$queue['waiting'] = max( 0, $totals['auto'] - $queue['p2'] - $queue['demanded'] );
		// Recent upgrades, reconstructed from the tail of the public rounds record.
		$tail = Data::all( "SELECT source_hash, lang, round, engine, candidate, critique, score, created FROM {$rt} ORDER BY id DESC LIMIT 120" );
		$groups = [];
		foreach ( array_reverse( $tail ) as $r ) { $groups[ $r['source_hash'] . '|' . $r['lang'] ][] = $r; }
		$recent = [];
		foreach ( array_reverse( $groups, true ) as $key => $rounds ) {
			if ( count( $recent ) >= 10 ) { break; }
			[ $hash, $lang ] = explode( '|', $key, 2 );
			$row = Data::one( "SELECT source_text, translated_text, quality, status FROM {$t} WHERE source_hash = %s AND lang = %s", [ $hash, $lang ] );
			if ( ! $row || $row['status'] !== 'arta' ) { continue; }
			$recent[] = [
				'hash'    => $hash,
				'lang'    => $lang,
				'source'  => mb_substr( (string) $row['source_text'], 0, 280 ),
				'final'   => mb_substr( (string) $row['translated_text'], 0, 280 ),
				'quality' => (int) $row['quality'],
				'rounds'  => array_map( static fn( $r ) => [
					'round'    => (int) $r['round'],
					'engine'   => (string) $r['engine'],
					'candidate'=> mb_substr( (string) $r['candidate'], 0, 280 ),
					'critique' => mb_substr( (string) $r['critique'], 0, 500 ),
					'score'    => (int) $r['score'],
				], $rounds ),
				'at'      => (int) end( $rounds )['created'],
			];
		}
		$out = [
			'engine' => (string) get_option( 'aq_tr_engine', '' ),
			'totals' => $totals,
			'queue'  => $queue,
			'langs'  => array_map( static fn( $c ) => [ 'code' => $c, 'name' => I18n::lang_name( $c ) ], self::AUTO_LANGS ), // the auto-improvement focus languages
			'gc'     => (object) (array) get_option( 'aq_tr_gc_stats', [] ), // last nightly sweep (edited-original purges + cold-cache hygiene)
			'recent' => $recent,
		];
		set_transient( 'aq_tr_status', $out, 60 );
		return $out;
	}

	/** GET translate/rounds?hash=&lang= — the full adversarial record behind one upgraded string. */
	public static function rounds_for( $req ) {
		self::ensure_tables();
		$hash = strtolower( trim( (string) Rest::p( $req, 'hash', '' ) ) );
		$lang = strtolower( trim( (string) Rest::p( $req, 'lang', '' ) ) );
		if ( ! preg_match( '/^[a-f0-9]{32}$/', $hash ) || $lang === '' ) { return Rest::err( 'bad_request', 'hash + lang required' ); }
		$row = Data::one(
			'SELECT source_text, translated_text, status, quality, updated_at FROM ' . Data::t( 'aq_translations' )
			. ' WHERE source_hash = %s AND lang = %s', [ $hash, $lang ]
		);
		if ( ! $row ) { return Rest::err( 'not_found', 'No such translation', 404 ); }
		$rounds = Data::all(
			'SELECT round, engine, candidate, critique, score, created FROM ' . Data::t( 'aq_tr_rounds' )
			. ' WHERE source_hash = %s AND lang = %s ORDER BY round ASC', [ $hash, $lang ]
		);
		return [
			'source'  => (string) $row['source_text'],
			'final'   => (string) $row['translated_text'],
			'status'  => (string) $row['status'],
			'quality' => (int) $row['quality'],
			'rounds'  => array_map( static fn( $r ) => [
				'round'    => (int) $r['round'],
				'engine'   => (string) $r['engine'],
				'candidate'=> (string) $r['candidate'],
				'critique' => (string) $r['critique'],
				'score'    => (int) $r['score'],
				'at'       => (int) $r['created'],
			], $rounds ),
		];
	}
}
