<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Content-addressed translation mesh (see ARCHITECTURE.md §2). English is the source;
 * every other string is keyed by md5(source) and stored once per language in
 * aq_translations. The browser is the translation worker: it asks `resolve` for known
 * translations, fills the gaps via `translate` (Google, persisted), and pushes new ones
 * back via `save`. So each (string × language) is translated exactly once, ever, by its
 * first visitor — translation cost distributes across the audience → unlimited scale.
 */
final class I18n {

	/** Cache misses that may go out to the translation edge in ONE request — see translate(). */
	const MT_OUTBOUND_MAX = 8;
	/** Strings one resolve() call may look up. The SPA never sends more than a page's worth. */
	const RESOLVE_MAX = 500;

	/** Right-to-left languages (correct <html dir> on the first frame). */
	const RTL = [ 'ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ckb', 'dv', 'ug', 'yi' ];

	/**
	 * The server-side boot config injected as window.AQ_I18N by the SPA template, shaped
	 * exactly as the React engine expects ({current, source, dir, langs, digits, boot}).
	 * This replaces the language registry that lived in the retired MasterStudy plugin.
	 */
	public static function js_config() {
		$cur   = self::current();
		$langs = [];
		foreach ( self::registry() as $code => $pair ) {
			$langs[] = [ 'code' => $code, 'native' => $pair[1], 'name' => $pair[0], 'dir' => in_array( $code, self::RTL, true ) ? 'rtl' : 'ltr' ];
		}
		return [
			'current' => $cur,
			'source'  => 'en',
			'dir'     => in_array( $cur, self::RTL, true ) ? 'rtl' : 'ltr',
			'langs'   => $langs,
			'digits'  => null,
			'boot'    => (object) [], // loader copy falls back to English until cached
			'epoch'   => Translate::epoch( $cur ), // moves when ArtaTranslate upgrades this language → client drops its localStorage cache
		];
	}

	/** GET /i18n/config — full language registry + the visitor's current language. */
	public static function config( $req ) {
		$langs = [];
		foreach ( self::registry() as $code => $pair ) {
			$langs[] = [ 'code' => $code, 'name' => $pair[0], 'native' => $pair[1], 'rtl' => in_array( $code, self::RTL, true ) ];
		}
		return [
			'languages' => $langs,
			'source'    => 'en',
			'current'   => self::current(),
		];
	}

	/**
	 * POST /i18n/resolve {lang, strings:[…]} — batch lookup. Returns the cached translations as
	 * { hits: { sourceString → translatedText }, missing: [sourceStrings not cached] }.
	 * Keyed by SOURCE STRING (the client maps translations back onto the page by source text).
	 *
	 * DEMAND SIGNAL (ArtaTranslate): every cache hit here is a real browser re-reading that string in
	 * that language — the first visitor CREATED the row (via translate/save), so a hit means the page
	 * is being visited again. Pending ('auto') hits bump `demand`, and the upgrade queue is ordered by
	 * it — so the adversarial rewrite budget goes exclusively to content people actually read. One
	 * batched UPDATE per chunk, per-IP throttled, and never on the crawler/SEO path (cached_many).
	 */
	public static function resolve( $req ) {
		// A BLOCKING throttle, and a CAP on the batch. This route is 'public' — no cookie, no nonce,
		// no token — and it had neither. Its two siblings cap at 100 (translate) and 200 (save); this
		// one accepted whatever the caller sent, chunked it 500 at a time into an IN (…) over
		// aq_translations (~520k rows), and POSTs are never edge-cached so every one reaches origin.
		// Measured on prod, anonymous: 20k strings = 2.0s, 100k = 5.1s, 400k (an 11 MB body) = 13.5s
		// of origin time per request. The only Rest::throttle on the path gated the demand-counter
		// side-effect, not the lookup — its result was assigned to $count_demand and the work ran
		// regardless. Bot-neutral: a page's worth of strings is far under this cap.
		if ( Rest::throttle( 'i18n_resolve', 120, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$lang    = self::lang( (string) Rest::p( $req, 'lang', '' ) );
		$strings = array_slice( (array) Rest::p( $req, 'strings', [] ), 0, self::RESOLVE_MAX );
		if ( ! $lang || ! $strings ) { return [ 'hits' => (object) [], 'missing' => [] ]; }
		// hash → source string (so we can return hits keyed by the original string).
		$by_hash = [];
		foreach ( $strings as $s ) {
			$s = (string) $s;
			if ( trim( $s ) !== '' ) { $by_hash[ md5( $s ) ] = $s; }
		}
		$hits  = [];
		$found = [];
		// Demand accounting stays bounded on this hot path: at most 120 bumping resolves per IP per
		// minute (a bump is ONE indexed UPDATE per 500-hash chunk); beyond that, reads still serve.
		$count_demand = ! Rest::throttle( 'tr_demand', 120, 60 );
		global $wpdb;
		foreach ( array_chunk( array_keys( $by_hash ), 500 ) as $chunk ) {
			$place = implode( ',', array_fill( 0, count( $chunk ), '%s' ) );
			$rows  = Data::all(
				'SELECT source_hash, translated_text FROM ' . Data::t( 'aq_translations' ) . " WHERE lang = %s AND source_hash IN ($place)",
				array_merge( [ $lang ], $chunk )
			);
			$chunk_hits = [];
			foreach ( $rows as $r ) {
				$src = $by_hash[ $r['source_hash'] ] ?? null;
				// An empty translated_text is a QUEUED placeholder (an ArtaTranslate narration row that has
				// no edge baseline yet) — treat it as missing so the viewer still gets an instant translation.
				if ( $src !== null && (string) $r['translated_text'] !== '' ) {
					$hits[ $src ] = $r['translated_text'];
					$found[ $r['source_hash'] ] = true;
					$chunk_hits[] = (string) $r['source_hash'];
				}
			}
			if ( $count_demand && $chunk_hits && $lang !== 'en' ) {
				$hp = implode( ',', array_fill( 0, count( $chunk_hits ), '%s' ) );
				$wpdb->query( $wpdb->prepare(
					'UPDATE ' . Data::t( 'aq_translations' ) . " SET demand = demand + 1
					 WHERE lang = %s AND status = 'auto' AND source_hash IN ($hp)",
					array_merge( [ $lang ], $chunk_hits )
				) );
				// USAGE STAMP (GC): every served row — any status, arta included — records that it is
				// still in use somewhere, COARSELY (≤1 write per row per week), so the nightly GC can
				// purge rows whose source no longer exists anywhere (edited/deleted content, changed UI
				// copy) without touching anything still being read. Most reads match 0 rows → no write.
				$now = time();
				$wpdb->query( $wpdb->prepare(
					'UPDATE ' . Data::t( 'aq_translations' ) . " SET read_at = %d
					 WHERE lang = %s AND read_at < %d AND source_hash IN ($hp)",
					array_merge( [ $now, $lang, $now - Translate::READ_TOUCH_S ], $chunk_hits )
				) );
			}
		}
		$missing = [];
		foreach ( $by_hash as $h => $s ) { if ( empty( $found[ $h ] ) ) { $missing[] = $s; } }
		return [ 'hits' => $hits ?: (object) [], 'missing' => $missing ];
	}

	/**
	 * POST /i18n/translate {lang, strings:[…], source} — translate the misses via Google (server
	 * proxy: the no-CORS / bot path), PERSIST them, and return { hits: { sourceString → translated } }.
	 * Keyed by SOURCE STRING. source="auto" (the default the client sends) lets Google detect the
	 * source language, so user-generated content in any language is translated into the viewer's.
	 */
	public static function translate( $req ) {
		if ( Rest::throttle( 'mt', 60, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$lang    = self::lang( (string) Rest::p( $req, 'lang', '' ) );
		$strings = array_slice( (array) Rest::p( $req, 'strings', [] ), 0, 100 );
		$source  = (string) Rest::p( $req, 'source', 'auto' );
		if ( ! $lang || $lang === 'en' || ! $strings ) { return [ 'hits' => (object) [] ]; }
		$hits = [];
		// OUTBOUND BUDGET PER REQUEST. The throttle above bounds how many REQUESTS a caller may make;
		// it said nothing about how much work each one causes. Every cache miss here is a separate
		// sequential call to Google with an 8-second timeout, and the batch is 100 — so ONE
		// unauthenticated request could pin a PHP worker for up to ~800 seconds, and sixty of them a
		// minute were allowed. Cache HITS stay unlimited (they are one indexed read); only misses,
		// which are what cost us a worker and an outbound quota, are rationed. A caller who needs
		// more simply asks again — the rows it just created are hits next time, so an honest client
		// converges in a few passes and an abusive one gains nothing per request.
		$budget = self::MT_OUTBOUND_MAX;
		foreach ( $strings as $s ) {
			$s = (string) $s;
			if ( trim( $s ) === '' ) { continue; }
			$hash   = md5( $s );
			$cached = Data::col( 'SELECT translated_text FROM ' . Data::t( 'aq_translations' ) . ' WHERE source_hash = %s AND lang = %s', [ $hash, $lang ] );
			if ( $cached !== null && $cached !== '' ) { $hits[ $s ] = $cached; continue; }
			if ( $budget <= 0 ) { continue; }  // out of outbound budget — leave it missing, the client re-asks
			--$budget;
			$t = self::google( $s, $lang, $source );
			if ( $t !== null ) {
				if ( $cached === '' ) {
					// Backfill a queued ArtaTranslate placeholder with the edge baseline. Guarded on the
					// still-empty still-'auto' state: between our read and this write the relay may have
					// upgraded the row to 'arta' — edge text must never overwrite an upgraded translation.
					global $wpdb;
					$wpdb->query( $wpdb->prepare(
						'UPDATE ' . Data::t( 'aq_translations' ) . " SET translated_text = %s, updated_at = %s
						 WHERE source_hash = %s AND lang = %s AND status = 'auto' AND translated_text = ''",
						$t, current_time( 'mysql' ), $hash, $lang
					) );
				} else {
					self::store( $hash, $lang, $s, $t );
				}
				$hits[ $s ] = $t;
			}
		}
		return [ 'hits' => $hits ?: (object) [] ];
	}

	/**
	 * POST /i18n/save {lang, pairs:[{s,t}]} — persist translations the client produced
	 * (direct-from-browser Google). Each (source × lang) is written at most once.
	 */
	public static function save( $req ) {
		// This route is 'public' and it WRITES — into aq_translations, which the Data explorer serves
		// to the world. At 120 requests a minute x 200 pairs it accepted 24,000 arbitrary rows per
		// minute per caller. The mesh genuinely needs anonymous writes (it translates for signed-out
		// visitors), so the answer is not authentication but a throughput a real page cannot exceed
		// and an attacker cannot ride: a page's worth of strings, a few times a minute.
		if ( Rest::throttle( 'i18n_save', 30, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$lang  = self::lang( (string) Rest::p( $req, 'lang', '' ) );
		$pairs = array_slice( (array) Rest::p( $req, 'pairs', [] ), 0, 50 );
		if ( ! $lang || $lang === 'en' ) { return [ 'saved' => 0 ]; }
		$n = 0;
		foreach ( $pairs as $p ) {
			$src = isset( $p['s'] ) ? (string) $p['s'] : '';
			$tgt = isset( $p['t'] ) ? (string) $p['t'] : '';
			if ( trim( $src ) === '' ) { continue; }
			if ( self::store( md5( $src ), $lang, $src, $tgt ) ) { $n++; }
		}
		return [ 'saved' => $n ];
	}

	// ── internals ───────────────────────────────────────────────────────────
	/** Write-once into the content-addressed cache. Returns true if newly inserted. */
	private static function store( $hash, $lang, $source, $target ) {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare(
			'SELECT translated_text, status FROM ' . Data::t( 'aq_translations' ) . ' WHERE source_hash = %s AND lang = %s', $hash, $lang
		), ARRAY_A );
		if ( $row ) {
			// Backfill a queued ArtaTranslate placeholder (a narration row with no edge baseline yet) —
			// otherwise every visitor to that page re-translates it forever. Guarded on the still-empty
			// still-'auto' state so a concurrent relay upgrade is never overwritten.
			if ( (string) $row['translated_text'] === '' && $row['status'] === 'auto' && $target !== '' ) {
				$wpdb->query( $wpdb->prepare(
					'UPDATE ' . Data::t( 'aq_translations' ) . " SET translated_text = %s, updated_at = %s
					 WHERE source_hash = %s AND lang = %s AND status = 'auto' AND translated_text = ''",
					$target, current_time( 'mysql' ), $hash, $lang
				) );
			}
			return false;
		}
		// Over the mesh cap (the client caps at 5000 but this route is open): still cache it for
		// visitors, but keep it OUT of the ArtaTranslate queue ('skip') — an oversized row can't ride
		// a review batch and would otherwise recycle through claims forever.
		$over = mb_strlen( (string) $source ) > 5000;
		$wpdb->insert( Data::t( 'aq_translations' ), [
			'source_hash' => $hash, 'lang' => $lang, 'source_text' => $source,
			'translated_text' => $target, 'context' => 'content', 'status' => $over ? 'skip' : 'auto',
			// Demand-aware (1.60.0): a fresh edge row starts at priority 0 / demand 0 — this insert IS
			// visit #1. It becomes upgradeable only once later visits re-resolve it (resolve() bumps
			// `demand`), so the rewrite budget never goes to strings nobody reads twice.
			'priority' => 0,
			'updated_at' => current_time( 'mysql' ),
		] );
		return true;
	}

	/** Single-string Google translate (free endpoint). Returns null on failure. */
	private static function google( $text, $lang, $source = 'auto' ) {
		$sl   = preg_match( '/^[a-z]{2,3}(-[a-z]{2,4})?$/i', $source ) ? strtolower( $source ) : 'auto';
		$url  = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' . rawurlencode( $sl ) . '&tl='
			. rawurlencode( $lang ) . '&dt=t&q=' . rawurlencode( $text );
		$resp = wp_remote_get( $url, [ 'timeout' => 8, 'headers' => [ 'User-Agent' => 'Mozilla/5.0' ] ] );
		if ( is_wp_error( $resp ) || wp_remote_retrieve_response_code( $resp ) !== 200 ) { return null; }
		$data = json_decode( wp_remote_retrieve_body( $resp ), true );
		if ( empty( $data[0] ) || ! is_array( $data[0] ) ) { return null; }
		$out = '';
		foreach ( $data[0] as $seg ) { $out .= $seg[0] ?? ''; }
		return $out !== '' ? $out : null;
	}

	private static function lang( $code ) {
		$code = strtolower( trim( $code ) );
		return isset( self::registry()[ $code ] ) ? $code : '';
	}

	// ── Language-prefix URL router (/es/, /fa/, …) ───────────────────────────
	// Replaces the router that lived in the retired MasterStudy plugin. On plugins_loaded
	// (before WordPress parses the request) the /xx/ prefix is stripped from REQUEST_URI so
	// WP routes as if English; generated links get the prefix re-added; the canonical
	// redirect is suppressed so prefixed URLs aren't 301'd back to English.
	private static $current = null;

	public static function boot_router() {
		self::strip_prefix();
		add_filter( 'home_url', [ __CLASS__, 'filter_home_url' ], 10, 1 );
		add_filter( 'redirect_canonical', [ __CLASS__, 'filter_canonical' ], 10, 1 );
	}

	private static function strip_prefix() {
		$uri   = isset( $_SERVER['REQUEST_URI'] ) ? wp_unslash( $_SERVER['REQUEST_URI'] ) : '/';
		$parts = explode( '?', $uri, 2 );
		$path  = $parts[0];
		if ( preg_match( '#^/([a-z]{2,3}(?:-[a-z]{2,4})?)(/.*|)$#i', $path, $m ) ) {
			$code = strtolower( $m[1] );
			if ( $code !== 'en' && isset( self::registry()[ $code ] ) ) {
				self::$current = $code;
				$_SERVER['REQUEST_URI'] = ( $m[2] ?: '/' ) . ( isset( $parts[1] ) ? '?' . $parts[1] : '' );
			}
		}
	}

	public static function filter_home_url( $url ) {
		if ( self::$current && self::$current !== 'en' ) {
			return preg_replace( '#^(https?://[^/]+)(/|$)#', '$1/' . self::$current . '/', $url, 1 );
		}
		return $url;
	}

	public static function filter_canonical( $redirect ) {
		return ( self::$current && self::$current !== 'en' ) ? false : $redirect;
	}

	/** All locale codes (~133), English first. Used by the theme's hreflang emitter. */
	public static function codes() {
		return array_keys( self::registry() );
	}

	/**
	 * Cached translations for a batch of source strings — a pure cache READ (no Google call). Used by
	 * the server SEO layer to localise the title/description/crawl body on /xx/ pages from translations
	 * already produced by earlier visitors (the content-addressed mesh), so crawlers + non-JS clients
	 * see localised meta instead of English. Returns [ source => translated ] for the hits only;
	 * strings not yet translated for $lang are simply absent (caller falls back to English). One query.
	 */
	public static function cached_many( array $sources, $lang ) {
		$lang = self::lang( (string) $lang );
		if ( ! $lang || $lang === 'en' ) { return []; }
		$by_hash = [];
		foreach ( $sources as $s ) {
			$s = (string) $s;
			if ( trim( $s ) !== '' ) { $by_hash[ md5( $s ) ] = $s; }
		}
		if ( ! $by_hash ) { return []; }
		$hits = [];
		global $wpdb;
		foreach ( array_chunk( array_keys( $by_hash ), 500 ) as $chunk ) {
			$place = implode( ',', array_fill( 0, count( $chunk ), '%s' ) );
			$rows  = Data::all(
				'SELECT source_hash, translated_text FROM ' . Data::t( 'aq_translations' ) . " WHERE lang = %s AND source_hash IN ($place)",
				array_merge( [ $lang ], $chunk )
			);
			$served = [];
			foreach ( $rows as $r ) {
				$src = $by_hash[ $r['source_hash'] ] ?? null;
				if ( $src !== null && $r['translated_text'] !== '' ) { $hits[ $src ] = $r['translated_text']; $served[] = (string) $r['source_hash']; }
			}
			// USAGE STAMP (GC): SEO serves count as "used" too — without this, strings only crawlers
			// read would look unused and get purged, permanently degrading /xx/ meta (this path never
			// re-writes). Coarse (≤1 write per row per week); no demand bump — crawlers aren't demand.
			if ( $served ) {
				$now = time();
				$sp  = implode( ',', array_fill( 0, count( $served ), '%s' ) );
				$wpdb->query( $wpdb->prepare(
					'UPDATE ' . Data::t( 'aq_translations' ) . " SET read_at = %d WHERE lang = %s AND read_at < %d AND source_hash IN ($sp)",
					array_merge( [ $now, $lang, $now - Translate::READ_TOUCH_S ], $served )
				) );
			}
		}
		return $hits;
	}

	/** True when $code is a real registered locale. */
	public static function is_locale( $code ) {
		return isset( self::registry()[ strtolower( (string) $code ) ] );
	}

	/** English display name of a locale code ('fa' → 'Persian'), or the code itself. */
	public static function lang_name( $code ) {
		$r = self::registry();
		$code = strtolower( (string) $code );
		return isset( $r[ $code ] ) ? $r[ $code ][0] : $code;
	}

	/** Visitor's current language: the stripped URL prefix, else the ay_lang cookie. */
	public static function current() {
		if ( self::$current !== null ) { return self::$current; }
		$cookie = isset( $_COOKIE['ay_lang'] ) ? self::lang( $_COOKIE['ay_lang'] ) : '';
		return $cookie ?: 'en';
	}

	/** code => [English name, native name]. The full Google Translate set (~133). */
	private static function registry() {
		static $r = null;
		if ( $r !== null ) { return $r; }
		$r = [];
		foreach ( explode( "\n", trim( self::TABLE ) ) as $line ) {
			$p = explode( '|', $line );
			if ( count( $p ) === 3 ) { $r[ $p[0] ] = [ $p[1], $p[2] ]; }
		}
		return $r;
	}

	const TABLE = <<<'TBL'
en|English|English
af|Afrikaans|Afrikaans
sq|Albanian|Shqip
am|Amharic|አማርኛ
ar|Arabic|العربية
hy|Armenian|Հայերեն
as|Assamese|অসমীয়া
ay|Aymara|Aymar aru
az|Azerbaijani|Azərbaycan
bm|Bambara|Bamanankan
eu|Basque|Euskara
be|Belarusian|Беларуская
bn|Bengali|বাংলা
bho|Bhojpuri|भोजपुरी
bs|Bosnian|Bosanski
bg|Bulgarian|Български
ca|Catalan|Català
ceb|Cebuano|Cebuano
ny|Chichewa|Chichewa
zh|Chinese (Simplified)|简体中文
zh-tw|Chinese (Traditional)|繁體中文
co|Corsican|Corsu
hr|Croatian|Hrvatski
cs|Czech|Čeština
da|Danish|Dansk
dv|Dhivehi|ދިވެހި
doi|Dogri|डोगरी
nl|Dutch|Nederlands
eo|Esperanto|Esperanto
et|Estonian|Eesti
ee|Ewe|Eʋegbe
tl|Filipino|Filipino
fi|Finnish|Suomi
fr|French|Français
fy|Frisian|Frysk
gl|Galician|Galego
ka|Georgian|ქართული
de|German|Deutsch
el|Greek|Ελληνικά
gn|Guarani|Avañe'ẽ
gu|Gujarati|ગુજરાતી
ht|Haitian Creole|Kreyòl ayisyen
ha|Hausa|Hausa
haw|Hawaiian|ʻŌlelo Hawaiʻi
he|Hebrew|עברית
hi|Hindi|हिन्दी
hmn|Hmong|Hmoob
hu|Hungarian|Magyar
is|Icelandic|Íslenska
ig|Igbo|Igbo
ilo|Ilocano|Ilokano
id|Indonesian|Bahasa Indonesia
ga|Irish|Gaeilge
it|Italian|Italiano
ja|Japanese|日本語
jv|Javanese|Basa Jawa
kn|Kannada|ಕನ್ನಡ
kk|Kazakh|Қазақ
km|Khmer|ខ្មែរ
rw|Kinyarwanda|Kinyarwanda
gom|Konkani|कोंकणी
ko|Korean|한국어
kri|Krio|Krio
ku|Kurdish (Kurmanji)|Kurdî
ckb|Kurdish (Sorani)|کوردیی ناوەندی
ky|Kyrgyz|Кыргызча
lo|Lao|ລາວ
la|Latin|Latina
lv|Latvian|Latviešu
ln|Lingala|Lingála
lt|Lithuanian|Lietuvių
lg|Luganda|Luganda
lb|Luxembourgish|Lëtzebuergesch
mk|Macedonian|Македонски
mai|Maithili|मैथिली
mg|Malagasy|Malagasy
ms|Malay|Bahasa Melayu
ml|Malayalam|മലയാളം
mt|Maltese|Malti
mi|Maori|Māori
mr|Marathi|मराठी
mni-mtei|Meiteilon (Manipuri)|ꯃꯩꯇꯩꯂꯣꯟ
lus|Mizo|Mizo ṭawng
mn|Mongolian|Монгол
my|Myanmar (Burmese)|မြန်မာ
ne|Nepali|नेपाली
nb|Norwegian|Norsk
or|Odia (Oriya)|ଓଡ଼ିଆ
om|Oromo|Afaan Oromoo
ps|Pashto|پښتو
fa|Persian|فارسی
pl|Polish|Polski
pt|Portuguese|Português
pa|Punjabi|ਪੰਜਾਬੀ
qu|Quechua|Runa Simi
ro|Romanian|Română
ru|Russian|Русский
sm|Samoan|Gagana Samoa
sa|Sanskrit|संस्कृतम्
gd|Scots Gaelic|Gàidhlig
nso|Sepedi|Sepedi
sr|Serbian|Српски
st|Sesotho|Sesotho
sn|Shona|chiShona
sd|Sindhi|سنڌي
si|Sinhala|සිංහල
sk|Slovak|Slovenčina
sl|Slovenian|Slovenščina
so|Somali|Soomaali
es|Spanish|Español
su|Sundanese|Basa Sunda
sv|Swedish|Svenska
tg|Tajik|Тоҷикӣ
ta|Tamil|தமிழ்
tt|Tatar|Татар
te|Telugu|తెలుగు
th|Thai|ไทย
ti|Tigrinya|ትግርኛ
ts|Tsonga|Xitsonga
tr|Turkish|Türkçe
tk|Turkmen|Türkmen
ak|Twi|Twi
uk|Ukrainian|Українська
ur|Urdu|اردو
ug|Uyghur|ئۇيغۇرچە
uz|Uzbek|Oʻzbek
vi|Vietnamese|Tiếng Việt
cy|Welsh|Cymraeg
xh|Xhosa|isiXhosa
yi|Yiddish|ייִדיש
yo|Yoruba|Yorùbá
zu|Zulu|isiZulu
TBL;
}
