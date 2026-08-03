<?php
/**
 * ArtaQuest currency display layer.
 *
 * - Canonical store currency: USD (every charge is in USD).
 * - Display currency: derived from the active locale via a static map.
 * - Rates: open.er-api.com (free, no auth), cached 24h in a WP transient.
 * - Fallback: hardcoded approximate rates if the API call fails.
 *
 * The charge is ALWAYS in USD. The locale-aware formatting is
 * informational so visitors see numbers they recognise without us
 * pretending we charge their currency.
 */

defined( 'ABSPATH' ) || exit;

/**
 * Returns the current locale slug (en/de/es/fr/zh/ja/hi/ar/fa/ru).
 * Single source of truth across the currency + PPP helpers.
 */
function aq_current_locale() {
	if ( class_exists( 'AQ_I18N_Router' ) && method_exists( 'AQ_I18N_Router', 'current' ) ) {
		$lang = (string) AQ_I18N_Router::current();
		if ( '' !== $lang ) {
			return $lang;
		}
	}
	return 'en';
}

/**
 * Per-locale "anchor country" — the richest country with that language as
 * an official language. PPP pricing is derived from this country's
 * GDP-per-capita-at-PPP relative to the median across all supported
 * locales (arashashra directive 2026-05-23).
 *
 * @return array { iso3, country_name, lang_currency }
 */
function aq_locale_anchor( $lang = null ) {
	$lang  = $lang ?: aq_current_locale();
	$anchors = array(
		'en' => array( 'iso3' => 'SGP', 'name' => 'Singapore',   'currency' => 'USD' ),
		'de' => array( 'iso3' => 'CHE', 'name' => 'Switzerland', 'currency' => 'EUR' ),
		'es' => array( 'iso3' => 'ESP', 'name' => 'Spain',       'currency' => 'EUR' ),
		'fr' => array( 'iso3' => 'LUX', 'name' => 'Luxembourg',  'currency' => 'EUR' ),
		'zh' => array( 'iso3' => 'SGP', 'name' => 'Singapore',   'currency' => 'CNY' ),
		'ja' => array( 'iso3' => 'JPN', 'name' => 'Japan',       'currency' => 'JPY' ),
		'hi' => array( 'iso3' => 'IND', 'name' => 'India',       'currency' => 'INR' ),
		'ar' => array( 'iso3' => 'QAT', 'name' => 'Qatar',       'currency' => 'SAR' ),
		// Sanctioned — anchor recorded but never used; PPP factor is 0.
		'fa' => array( 'iso3' => 'IRN', 'name' => 'Iran',        'currency' => 'IRR' ),
		'ru' => array( 'iso3' => 'RUS', 'name' => 'Russia',      'currency' => 'RUB' ),
	);
	return isset( $anchors[ $lang ] ) ? $anchors[ $lang ] : $anchors['en'];
}

/**
 * Sanctioned locales pay nothing and never see prices.
 * Single source of truth — used by aq_format_price, the donate template,
 * checkout enqueue, and the price-display CSS guard.
 *
 * @param string|null $lang Override locale; defaults to current.
 * @return bool
 */
function aq_locale_is_sanctioned( $lang = null ) {
	$lang = $lang ?: aq_current_locale();
	return in_array( $lang, array( 'fa', 'ru' ), true );
}

/**
 * Active locale → display currency code.
 *
 * @return string Three-letter ISO currency code.
 */
function aq_locale_currency_code() {
	$lang = aq_current_locale();
	$map = array(
		'en' => 'USD',
		'de' => 'EUR',
		'es' => 'EUR',
		'fr' => 'EUR',
		'zh' => 'CNY',
		'ja' => 'JPY',
		'hi' => 'INR',
		'ar' => 'SAR',
		'fa' => 'IRR',
		'ru' => 'RUB',
	);
	return isset( $map[ $lang ] ) ? $map[ $lang ] : 'USD';
}

/**
 * Symbol per currency code (front-position).
 *
 * @param string $code ISO currency code.
 * @return string Display symbol (or "<CODE> " when unknown).
 */
function aq_currency_symbol( $code ) {
	$s = array(
		'USD' => '$',
		'EUR' => '€',
		'CNY' => '¥',
		'JPY' => '¥',
		'INR' => '₹',
		'SAR' => '﷼',
		'IRR' => '﷼',
		'RUB' => '₽',
		'CAD' => '$',
	);
	return isset( $s[ $code ] ) ? $s[ $code ] : ( $code . ' ' );
}

/**
 * Number of decimal places per currency.
 *
 * @param string $code ISO currency code.
 * @return int
 */
function aq_currency_decimals( $code ) {
	return ( 'JPY' === $code ) ? 0 : 2;
}

/**
 * Returns the rate table keyed by ISO code, with USD = 1.0. Cached 24h.
 *
 * @return array<string,float>
 */
function aq_currency_rates() {
	$cached = get_transient( 'aq_currency_rates' );
	if ( is_array( $cached ) && ! empty( $cached ) ) {
		return $cached;
	}
	$fallback = array(
		'USD' => 1.00,
		'EUR' => 0.92,
		'CNY' => 7.25,
		'JPY' => 156.0,
		'INR' => 83.5,
		'SAR' => 3.75,
		'CAD' => 1.37,
	);
	$r = wp_safe_remote_get(
		'https://open.er-api.com/v6/latest/USD',
		array( 'timeout' => 6 )
	);
	if ( ! is_wp_error( $r ) && 200 === (int) wp_remote_retrieve_response_code( $r ) ) {
		$body = json_decode( wp_remote_retrieve_body( $r ), true );
		if ( is_array( $body ) && isset( $body['rates'] ) && is_array( $body['rates'] ) ) {
			$rates = $fallback;
			foreach ( array( 'USD', 'EUR', 'CNY', 'JPY', 'INR', 'SAR', 'CAD' ) as $code ) {
				if ( isset( $body['rates'][ $code ] ) && is_numeric( $body['rates'][ $code ] ) ) {
					$rates[ $code ] = (float) $body['rates'][ $code ];
				}
			}
			set_transient( 'aq_currency_rates', $rates, DAY_IN_SECONDS );
			return $rates;
		}
	}
	// API failed → cache fallback briefly so we retry within the hour.
	set_transient( 'aq_currency_rates', $fallback, HOUR_IN_SECONDS );
	return $fallback;
}

/* ─── PPP-based equitable pricing (arashashra directive 2026-05-23) ─────────
   Each locale has an "anchor country" — the richest country with that
   language as an official language. The PPP factor scales the canonical
   USD price so that all locales pay the same fraction of their
   anchor-country's purchasing power.

     price_for_locale(usd) = usd × (anchor_GDPpc_PPP / median_GDPpc_PPP)

   Sanctioned locales (fa, ru) return 0 (everything free).

   The factor table is refreshed every Friday by aq_currency_refresh_ppp()
   from the World Bank GDP-per-capita-PPP indicator. Fallback table below
   is the seed (current-international-$ values rounded to nearest $1k) so
   the helpers always have something even if the API has never run.
*/

/**
 * Locale → anchor-country GDP per capita at PPP (current international $).
 * Seed values; cron updates from World Bank NY.GDP.PCAP.PP.CD.
 */
function aq_ppp_gdppc_table() {
	$opt = get_option( 'aq_ppp_gdppc', null );
	if ( is_array( $opt ) && ! empty( $opt ) ) {
		return $opt;
	}
	return array(
		'en' => 145000, // Singapore
		'de' => 95000,  // Switzerland
		'es' => 55000,  // Spain
		'fr' => 145000, // Luxembourg
		'zh' => 145000, // Singapore
		'ja' => 53000,  // Japan
		'hi' => 11000,  // India
		'ar' => 119000, // Qatar
		// fa / ru intentionally not in the multiplier path — sanctioned.
	);
}

/**
 * Median of the active (non-sanctioned) locale GDPpc PPP values.
 * Used as the "$3 base" anchor — locales above the median pay more,
 * locales below pay less.
 */
function aq_ppp_median() {
	$tbl = aq_ppp_gdppc_table();
	$vals = array_values( $tbl );
	sort( $vals );
	$n = count( $vals );
	if ( 0 === $n ) {
		return 1.0;
	}
	if ( $n % 2 === 1 ) {
		return (float) $vals[ (int) ( ( $n - 1 ) / 2 ) ];
	}
	return ( (float) $vals[ ( $n / 2 ) - 1 ] + (float) $vals[ $n / 2 ] ) / 2.0;
}

/**
 * Multiplier applied to a canonical USD price for the active locale.
 * Returns 0.0 for sanctioned locales (everything free).
 * Median locale = 1.0 (pays the canonical $X amount).
 */
function aq_ppp_factor( $lang = null ) {
	$lang = $lang ?: aq_current_locale();
	if ( aq_locale_is_sanctioned( $lang ) ) {
		return 0.0;
	}
	$tbl = aq_ppp_gdppc_table();
	if ( ! isset( $tbl[ $lang ] ) ) {
		return 1.0;
	}
	$median = aq_ppp_median();
	if ( $median <= 0 ) {
		return 1.0;
	}
	return ( (float) $tbl[ $lang ] ) / $median;
}

/**
 * Apply PPP scaling to a canonical USD price. Returns the SCALED USD
 * amount (still in USD — the locale currency conversion happens in
 * aq_format_price). For sanctioned locales returns 0.
 */
function aq_ppp_scaled_usd( $usd ) {
	$factor = aq_ppp_factor();
	return ( (float) $usd ) * $factor;
}

/**
 * Format a USD amount for display in the active locale's currency,
 * scaled by the locale's PPP factor. Sanctioned locales return the
 * localised "Free" string.
 *
 * @param float|int $usd Canonical USD amount (the global $3 reference price).
 * @return string Formatted display price, or "Free" for sanctioned locales.
 */
function aq_format_price( $usd ) {
	if ( aq_locale_is_sanctioned() ) {
		return esc_html__( 'Free', 'artaquest' );
	}
	$scaled = aq_ppp_scaled_usd( $usd );
	$code   = aq_locale_currency_code();
	$rates  = aq_currency_rates();
	$rate   = isset( $rates[ $code ] ) ? (float) $rates[ $code ] : 1.0;
	$val    = $scaled * $rate;
	$dec    = aq_currency_decimals( $code );
	return aq_currency_symbol( $code ) . number_format_i18n( $val, $dec );
}

/**
 * iter-158 #511 (meilin): the "(charged %s USD)" note was running through
 * gettext (`esc_html__('charged %s', 'artaquest')`) but the theme ships
 * NO .mo files, so gettext always returns the English source. The DOM
 * walker can't translate it after the fact either — the rendered string
 * includes a dynamic dollar amount that varies per course, so the
 * walker's hash never matches a seed. Use a per-locale lookup table.
 *
 * @return string sprintf-friendly template with one %s placeholder.
 */
function aq_charged_template() {
	$lang = aq_current_locale();
	$map  = array(
		'en' => 'charged %s',
		'de' => 'belastet mit %s',
		'es' => 'cobrado %s',
		'fr' => 'facturé %s',
		'zh' => '收取 %s',
		'ja' => '%s が課金されます',
		'ko' => '%s 청구',
		'hi' => '%s शुल्क लिया गया',
		'ar' => 'تم تحصيل %s',
		'ru' => 'списано %s',
		'fa' => 'مبلغ %s دریافت می‌شود',
	);
	return isset( $map[ $lang ] ) ? $map[ $lang ] : $map['en'];
}

/**
 * Render the locale price with the canonical-USD note attached.
 * Sanctioned locales return "Free" with no note.
 */
function aq_price_with_note( $usd ) {
	if ( aq_locale_is_sanctioned() ) {
		return '<span class="aq-price__free">' . esc_html__( 'Free', 'artaquest' ) . '</span>';
	}
	$scaled_usd = aq_ppp_scaled_usd( $usd );
	$code       = aq_locale_currency_code();
	if ( 'USD' === $code ) {
		return '$' . number_format_i18n( $scaled_usd, 2 );
	}
	$local   = aq_format_price( $usd );
	// iter-130 #463 (aanya): the USD-charge note uses `number_format_i18n`
	// which substitutes locale-script digits (Devanagari on /hi/, Arabic-
	// Indic on /ar/). The suffix "USD" stays ASCII, producing a script
	// mismatch like `$०.३१ USD`. Use raw `number_format` for the USD
	// reference so the canonical-charge digits stay ASCII matching the
	// "USD" suffix; the LOCAL price keeps its locale-script digits because
	// that's what visitors expect in their reading system.
	$usd_str = '$' . number_format( (float) $scaled_usd, 2, '.', ',' ) . ' USD';
	$note    = sprintf( aq_charged_template(), $usd_str );
	return $local . ' <span class="aq-price__note">(' . esc_html( $note ) . ')</span>';
}

/**
 * Expose currency state to client JS so React-hydrated price renders can
 * re-format prices that came in as bare "$X" (the legacy LMS block emits
 * symbol+price with no locale conversion + no USD note). The iter-118 fix
 * patched the SSR path but a follow-up bot (zhenya #446) caught that the
 * preset's Preact runtime still overwrites the SSR markup with bare USD
 * on hydration. The observer in render.php now uses this object to
 * post-process hydrated cards.
 *
 * Keep the payload tiny — only what's needed for in-browser conversion.
 */
function aq_currency_js_config() {
	$code  = aq_locale_currency_code();
	$rates = aq_currency_rates();
	$rate  = isset( $rates[ $code ] ) ? (float) $rates[ $code ] : 1.0;
	$dec   = aq_currency_decimals( $code );
	$sym   = aq_currency_symbol( $code );
	$tmpl = sprintf( aq_charged_template(), '__USD__' );
	return array(
		'code'        => $code,
		'symbol'      => $sym,
		'rate'        => $rate,
		'decimal'     => $dec,
		'isUsd'       => 'USD' === $code,
		'tmpl'        => $tmpl,
		// iter-122: PPP-aware pricing. Sanctioned locales => factor 0 →
		// JS observer must render "Free" and never show a price.
		'pppFactor'   => (float) aq_ppp_factor(),
		'sanctioned'  => (bool) aq_locale_is_sanctioned(),
		'freeLabel'   => esc_html__( 'Free', 'artaquest' ),
	);
}

add_action(
	'wp_head',
	static function () {
		$cfg = aq_currency_js_config();
		echo "<script>window.aqCurrency = " . wp_json_encode( $cfg ) . ";</script>\n";
	},
	2
);

/* ─── Phase 2: Friday cron — refresh PPP table from World Bank ────────────
   World Bank API: https://api.worldbank.org/v2/country/<ISO3>/indicator/
   NY.GDP.PCAP.PP.CD?format=json&per_page=1&date=2020:2025
   The endpoint returns an array; element [1] holds data records sorted
   newest first. We take the first non-null value as the latest GDPpc-PPP.
*/

function aq_currency_refresh_ppp() {
	$anchors = array(
		'en' => 'SGP',
		'de' => 'CHE',
		'es' => 'ESP',
		'fr' => 'LUX',
		'zh' => 'SGP',
		'ja' => 'JPN',
		'hi' => 'IND',
		'ar' => 'QAT',
	);
	// Cache per-ISO3 first, then map back to locales — two locales (en, zh)
	// share an anchor (SGP), and the API's per_page=10 window can return
	// different "newest non-null" values across two separate hits.
	$iso_values = array();
	foreach ( array_unique( $anchors ) as $iso3 ) {
		$url = sprintf(
			'https://api.worldbank.org/v2/country/%s/indicator/NY.GDP.PCAP.PP.CD?format=json&per_page=10&date=2020:2025',
			rawurlencode( $iso3 )
		);
		$r = wp_safe_remote_get( $url, array( 'timeout' => 10 ) );
		if ( is_wp_error( $r ) || 200 !== (int) wp_remote_retrieve_response_code( $r ) ) {
			continue;
		}
		$body = json_decode( wp_remote_retrieve_body( $r ), true );
		if ( ! is_array( $body ) || ! isset( $body[1] ) || ! is_array( $body[1] ) ) {
			continue;
		}
		foreach ( $body[1] as $row ) {
			if ( isset( $row['value'] ) && is_numeric( $row['value'] ) && $row['value'] > 0 ) {
				$iso_values[ $iso3 ] = (int) round( (float) $row['value'] );
				break; // newest non-null
			}
		}
	}
	$current = aq_ppp_gdppc_table();
	$updated = $current;
	foreach ( $anchors as $lang => $iso3 ) {
		if ( isset( $iso_values[ $iso3 ] ) ) {
			$updated[ $lang ] = $iso_values[ $iso3 ];
		}
	}
	// Base-price peg: latest Canadian CPI (essential-goods basket proxy — World Bank FP.CPI.TOTL / CAN).
	// The CAD base price tracks this so it follows real Canadian cost of living, not a fixed figure.
	$cpi_r = wp_safe_remote_get( 'https://api.worldbank.org/v2/country/CAN/indicator/FP.CPI.TOTL?format=json&per_page=10&date=2018:2026', array( 'timeout' => 10 ) );
	if ( ! is_wp_error( $cpi_r ) && 200 === (int) wp_remote_retrieve_response_code( $cpi_r ) ) {
		$cpi_body = json_decode( wp_remote_retrieve_body( $cpi_r ), true );
		if ( isset( $cpi_body[1] ) && is_array( $cpi_body[1] ) ) {
			foreach ( $cpi_body[1] as $crow ) {
				if ( isset( $crow['value'] ) && is_numeric( $crow['value'] ) && $crow['value'] > 0 ) {
					update_option( 'aq_base_cpi_ca', (float) $crow['value'], false );
					break; // newest non-null
				}
			}
		}
	}
	update_option( 'aq_ppp_gdppc', $updated, false );
	update_option( 'aq_ppp_gdppc_refreshed_at', (int) current_time( 'U' ), false );
	return $updated;
}

/**
 * Canonical base price in CAD, pegged to a Canadian essential-goods basket (CPI).
 * Tracks Canadian cost of living rather than a fixed dollar figure. `aq_base_cpi_ca` is the
 * latest World Bank CPI (FP.CPI.TOTL / CAN), refreshed every 28 days; AQ_BASE_CPI_BASELINE is
 * the CPI when the reference price was set, so the ratio just follows inflation.
 */
function aq_base_price_cad( $reference_cad ) {
	$baseline = defined( 'AQ_BASE_CPI_BASELINE' ) ? (float) AQ_BASE_CPI_BASELINE : 138.1; // CAN CPI when reference set (World Bank FP.CPI.TOTL, 2010=100) → ratio 1.0 now, tracks inflation forward
	$now      = (float) get_option( 'aq_base_cpi_ca', $baseline );
	if ( $now <= 0 || $baseline <= 0 ) {
		return (float) $reference_cad;
	}
	return round( (float) $reference_cad * ( $now / $baseline ), 2 );
}

// Custom 28-day (4-weekly) interval — anchored on a Friday it always lands on a Friday.
add_filter(
	'cron_schedules',
	static function ( $schedules ) {
		$schedules['aq_four_weeks'] = array( 'interval' => 28 * DAY_IN_SECONDS, 'display' => 'Every 28 days' );
		return $schedules;
	}
);
// Refresh the World Bank PPP table every 28 days, on a Friday 03:00 UTC (user directive
// 2026-05-31). Re-registered each load; migrates any older 'weekly' schedule to 28-day.
add_action(
	'init',
	static function () {
		if ( 'aq_four_weeks' !== wp_get_schedule( 'aq_currency_ppp_friday' ) ) {
			wp_clear_scheduled_hook( 'aq_currency_ppp_friday' );
			$next = strtotime( 'next friday 03:00 UTC' );
			if ( false === $next || $next < time() ) {
				$next = strtotime( '+1 week', (int) $next );
			}
			wp_schedule_event( $next, 'aq_four_weeks', 'aq_currency_ppp_friday' );
		}
	}
);
add_action( 'aq_currency_ppp_friday', 'aq_currency_refresh_ppp' );
