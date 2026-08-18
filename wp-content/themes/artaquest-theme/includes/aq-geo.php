<?php
/**
 * ArtaQuest geo / country layer  (arashashra directive 2026-05-31).
 *
 * Sits on top of the locale-driven currency layer (aq-currency.php). A
 * visitor's COUNTRY drives three things:
 *   1. UI language   — country → one of the 8 supported locales → /xx/ URL.
 *   2. Display price  — country → local currency (FX from aq-currency rates).
 *   3. Equity (PPP)   — country → GDP-per-capita-PPP factor relative to Canada.
 *   4. Payment rails  — Canada → Interac, Türkiye → FAST, everyone → PayPal/Stripe.
 *
 * Equity model: the canonical course price is a base in CAD pegged to a
 * Canadian essential-goods basket (aq_base_price_cad). Canada pays the base
 * (factor 1.0); every other country pays  base × (their GDPpc / Canada GDPpc),
 * clamped to [0.15, 2.0], converted to their local currency for display. The
 * charge stays in CAD (the store currency) — the local figure is shown so the
 * buyer understands the cost, mirroring the existing aq_price_with_note pattern.
 *
 * Multilingual countries get one entry per official UI language (Canada EN/FR,
 * Switzerland DE/FR, Belgium FR), so the selector can place a learner in the
 * right language for where they are.
 *
 * @package ArtaQuest
 */

defined( 'ABSPATH' ) || exit;

/**
 * The selectable countries. Keyed by a unique selector id (multilingual
 * countries carry a -lang suffix). Each row:
 *   iso2     two-letter country code (cookie + gateway gating + CF geo header)
 *   name     display label (includes the language when a country has several)
 *   flag     emoji flag
 *   lang     supported UI locale (en/de/es/fr/zh/ja/hi/ar)
 *   currency ISO 4217 display currency
 *   iso3     three-letter code (World Bank GDPpc lookups)
 *   gdppc    GDP per capita at PPP, current international $ (seed; ~2023)
 *
 * Russia + Iran are intentionally absent — sanctioned locales pay nothing and
 * never see prices (aq_locale_is_sanctioned).
 *
 * @return array<string,array<string,mixed>>
 */
function aq_geo_countries() {
	static $c = null;
	if ( null !== $c ) {
		return $c;
	}
	// gdppc in thousands → ×1000 below, kept compact here for readability.
	$rows = array(
		// id            iso2  name                         flag  lang  cur    iso3   gdppc(k)
		// Canada first — the foundation's home + the CAD price anchor; then UK, then US
		// (arashashra 2026-05-31).
		'CA'      => array( 'CA', 'Canada (English)',         '🇨🇦', 'en', 'CAD', 'CAN', 60 ),
		'CA-fr'   => array( 'CA', 'Canada (Français)',        '🇨🇦', 'fr', 'CAD', 'CAN', 60 ),
		'GB'      => array( 'GB', 'United Kingdom',           '🇬🇧', 'en', 'GBP', 'GBR', 56 ),
		'US'      => array( 'US', 'United States',            '🇺🇸', 'en', 'USD', 'USA', 80 ),
		'IE'      => array( 'IE', 'Ireland',                  '🇮🇪', 'en', 'EUR', 'IRL', 127 ),
		'AU'      => array( 'AU', 'Australia',                '🇦🇺', 'en', 'AUD', 'AUS', 65 ),
		'NZ'      => array( 'NZ', 'New Zealand',              '🇳🇿', 'en', 'NZD', 'NZL', 51 ),
		'SG'      => array( 'SG', 'Singapore',                '🇸🇬', 'en', 'SGD', 'SGP', 141 ),
		'DE'      => array( 'DE', 'Germany',                  '🇩🇪', 'de', 'EUR', 'DEU', 70 ),
		'AT'      => array( 'AT', 'Austria',                  '🇦🇹', 'de', 'EUR', 'AUT', 69 ),
		'CH-de'   => array( 'CH', 'Switzerland (Deutsch)',    '🇨🇭', 'de', 'CHF', 'CHE', 90 ),
		'CH-fr'   => array( 'CH', 'Suisse (Français)',        '🇨🇭', 'fr', 'CHF', 'CHE', 90 ),
		'FR'      => array( 'FR', 'France',                   '🇫🇷', 'fr', 'EUR', 'FRA', 60 ),
		'BE'      => array( 'BE', 'Belgique (Français)',      '🇧🇪', 'fr', 'EUR', 'BEL', 68 ),
		'ES'      => array( 'ES', 'España',                   '🇪🇸', 'es', 'EUR', 'ESP', 50 ),
		'MX'      => array( 'MX', 'México',                   '🇲🇽', 'es', 'MXN', 'MEX', 23 ),
		'AR'      => array( 'AR', 'Argentina',               '🇦🇷', 'es', 'USD', 'ARG', 27 ),
		'CO'      => array( 'CO', 'Colombia',                '🇨🇴', 'es', 'USD', 'COL', 19 ),
		'CL'      => array( 'CL', 'Chile',                   '🇨🇱', 'es', 'USD', 'CHL', 30 ),
		'PE'      => array( 'PE', 'Perú',                    '🇵🇪', 'es', 'USD', 'PER', 15 ),
		'CN'      => array( 'CN', '中国',                     '🇨🇳', 'zh', 'CNY', 'CHN', 24 ),
		'HK'      => array( 'HK', 'Hong Kong',               '🇭🇰', 'zh', 'HKD', 'HKG', 70 ),
		'TW'      => array( 'TW', '台灣',                     '🇹🇼', 'zh', 'TWD', 'TWN', 73 ),
		'JP'      => array( 'JP', '日本',                     '🇯🇵', 'ja', 'JPY', 'JPN', 47 ),
		'IN'      => array( 'IN', 'India (English)',          '🇮🇳', 'en', 'INR', 'IND', 10 ),
		'IN-hi'   => array( 'IN', 'भारत (हिन्दी)',            '🇮🇳', 'hi', 'INR', 'IND', 10 ),
		'SA'      => array( 'SA', 'السعودية',                '🇸🇦', 'ar', 'SAR', 'SAU', 59 ),
		'AE'      => array( 'AE', 'الإمارات',                '🇦🇪', 'ar', 'AED', 'ARE', 88 ),
		'QA'      => array( 'QA', 'قطر',                     '🇶🇦', 'ar', 'QAR', 'QAT', 114 ),
		'EG'      => array( 'EG', 'مصر',                     '🇪🇬', 'ar', 'EGP', 'EGY', 17 ),
		'MA'      => array( 'MA', 'المغرب',                  '🇲🇦', 'ar', 'MAD', 'MAR', 10 ),
		'NG'      => array( 'NG', 'Nigeria',                 '🇳🇬', 'en', 'NGN', 'NGA', 6 ),
		'KE'      => array( 'KE', 'Kenya',                   '🇰🇪', 'en', 'KES', 'KEN', 6 ),
		'GH'      => array( 'GH', 'Ghana',                   '🇬🇭', 'en', 'GHS', 'GHA', 7 ),
		'ZA'      => array( 'ZA', 'South Africa',            '🇿🇦', 'en', 'ZAR', 'ZAF', 16 ),
		'BR'      => array( 'BR', 'Brasil',                  '🇧🇷', 'en', 'BRL', 'BRA', 20 ),
		'ID'      => array( 'ID', 'Indonesia',              '🇮🇩', 'en', 'IDR', 'IDN', 15 ),
		'PH'      => array( 'PH', 'Philippines',            '🇵🇭', 'en', 'PHP', 'PHL', 11 ),
		'PK'      => array( 'PK', 'Pakistan',               '🇵🇰', 'en', 'PKR', 'PAK', 7 ),
		'BD'      => array( 'BD', 'Bangladesh',             '🇧🇩', 'en', 'BDT', 'BGD', 9 ),
		'TR'      => array( 'TR', 'Türkiye',                '🇹🇷', 'en', 'TRY', 'TUR', 41 ),
		'NL'      => array( 'NL', 'Nederland',              '🇳🇱', 'en', 'EUR', 'NLD', 75 ),
		'SE'      => array( 'SE', 'Sweden',                 '🇸🇪', 'en', 'SEK', 'SWE', 66 ),
		'PL'      => array( 'PL', 'Polska',                 '🇵🇱', 'en', 'PLN', 'POL', 45 ),
		'IT'      => array( 'IT', 'Italia',                 '🇮🇹', 'en', 'EUR', 'ITA', 54 ),
		// ── Top-50-by-population coverage + explicitly requested countries (2026-05-31) ──
		// Sanctioned UI locales (fa, ru) resolve to Free automatically; Afghanistan
		// (Dari = fa) likewise. Everyone else is priced by the equitable PPP model;
		// the bursary program waives the fee for anyone who still can't pay.
		'RU'      => array( 'RU', 'Россия',                 '🇷🇺', 'ru', 'RUB', 'RUS', 38 ), // sanctioned → free
		'IR'      => array( 'IR', 'ایران',                  '🇮🇷', 'fa', 'IRR', 'IRN', 17 ), // sanctioned → free
		'AF'      => array( 'AF', 'افغانستان',              '🇦🇫', 'fa', 'AFN', 'AFG', 2 ),  // Dari (fa) → free
		'UA'      => array( 'UA', 'Україна',                '🇺🇦', 'en', 'UAH', 'UKR', 13 ),
		'PS'      => array( 'PS', 'فلسطين',                 '🇵🇸', 'ar', 'ILS', 'PSE', 6 ),
		'IL'      => array( 'IL', 'Israel',                 '🇮🇱', 'en', 'ILS', 'ISR', 49 ),
		'LB'      => array( 'LB', 'لبنان',                  '🇱🇧', 'ar', 'USD', 'LBN', 13 ), // LBP collapsed → USD in practice
		'ET'      => array( 'ET', 'Ethiopia',              '🇪🇹', 'en', 'ETB', 'ETH', 3 ),
		'CD'      => array( 'CD', 'RD Congo',              '🇨🇩', 'fr', 'CDF', 'COD', 2 ),
		'VN'      => array( 'VN', 'Việt Nam',              '🇻🇳', 'en', 'VND', 'VNM', 14 ),
		'TH'      => array( 'TH', 'ประเทศไทย',              '🇹🇭', 'en', 'THB', 'THA', 22 ),
		'TZ'      => array( 'TZ', 'Tanzania',              '🇹🇿', 'en', 'TZS', 'TZA', 3 ),
		'MM'      => array( 'MM', 'Myanmar',               '🇲🇲', 'en', 'MMK', 'MMR', 5 ),
		'KR'      => array( 'KR', '대한민국',                '🇰🇷', 'en', 'KRW', 'KOR', 50 ),
		'UG'      => array( 'UG', 'Uganda',                '🇺🇬', 'en', 'UGX', 'UGA', 3 ),
		'SD'      => array( 'SD', 'السودان',               '🇸🇩', 'ar', 'SDG', 'SDN', 4 ),
		'DZ'      => array( 'DZ', 'الجزائر',               '🇩🇿', 'ar', 'DZD', 'DZA', 13 ),
		'IQ'      => array( 'IQ', 'العراق',                '🇮🇶', 'ar', 'IQD', 'IRQ', 11 ),
		'YE'      => array( 'YE', 'اليمن',                 '🇾🇪', 'ar', 'YER', 'YEM', 4 ),
		'AO'      => array( 'AO', 'Angola',                '🇦🇴', 'en', 'AOA', 'AGO', 7 ),
		'UZ'      => array( 'UZ', 'Oʻzbekiston',           '🇺🇿', 'en', 'UZS', 'UZB', 9 ),
		'MY'      => array( 'MY', 'Malaysia',              '🇲🇾', 'en', 'MYR', 'MYS', 35 ),
		'MZ'      => array( 'MZ', 'Moçambique',            '🇲🇿', 'en', 'MZN', 'MOZ', 2 ),
		'NP'      => array( 'NP', 'नेपाल',                  '🇳🇵', 'en', 'NPR', 'NPL', 5 ),
		'MG'      => array( 'MG', 'Madagascar',            '🇲🇬', 'fr', 'MGA', 'MDG', 2 ),
		// Catch-all for any country not tabulated above → lowest PPP band, priced in
		// CAD (our base currency), English.
		'ROW'     => array( 'ZZ', 'Other / Rest of world', '🌍', 'en', 'CAD', '', 0 ),
	);
	$c = array();
	foreach ( $rows as $id => $r ) {
		$c[ $id ] = array(
			'id'       => $id,
			'iso2'     => $r[0],
			'name'     => $r[1],
			'flag'     => $r[2],
			'lang'     => $r[3],
			'currency' => $r[4],
			'iso3'     => $r[5],
			'gdppc'    => (int) $r[6] * 1000,
			'free'     => isset( $r[7] ) ? (bool) $r[7] : false, // explicit humanitarian-free override (sanctioned locales are free regardless)
		);
	}
	return $c;
}

/** Look up one country row by selector id; falls back to Canada (English). */
function aq_geo_country( $id = null ) {
	$all = aq_geo_countries();
	if ( $id && isset( $all[ $id ] ) ) {
		return $all[ $id ];
	}
	return $all['CA'];
}

/**
 * Resolve the visitor's selector id, in priority order:
 *   1. explicit ?country= / cookie 'aq_country_id'  (their saved choice)
 *   2. CDN geo header (CF-IPCountry / WP.com) → first country row with that iso2
 *   3. current UI locale → first country row in that language
 *   4. Canada (English) default
 *
 * @param string|null $override Explicit selector id (e.g. from a REST param).
 * @return string Selector id present in aq_geo_countries().
 */
function aq_geo_current_id( $override = null ) {
	$all = aq_geo_countries();
	// 0. request-scoped override set by a REST handler (so the gateway filter, which
	//    calls this with no argument, sees the country the caller passed).
	if ( ! $override && ! empty( $GLOBALS['aq_geo_request_country'] ) ) {
		$override = (string) $GLOBALS['aq_geo_request_country'];
	}
	// 1. explicit choice
	$cand = $override ? $override : ( isset( $_COOKIE['aq_country_id'] ) ? sanitize_text_field( wp_unslash( $_COOKIE['aq_country_id'] ) ) : '' );
	if ( $cand && isset( $all[ $cand ] ) ) {
		return $cand;
	}
	// 2. edge geo header → iso2
	$iso2 = '';
	foreach ( array( 'HTTP_CF_IPCOUNTRY', 'HTTP_CF_IP_COUNTRY', 'GEOIP_COUNTRY_CODE', 'HTTP_X_COUNTRY_CODE' ) as $h ) {
		if ( ! empty( $_SERVER[ $h ] ) ) {
			$iso2 = strtoupper( substr( sanitize_text_field( wp_unslash( $_SERVER[ $h ] ) ), 0, 2 ) );
			break;
		}
	}
	if ( $iso2 ) {
		// Prefer a row whose language matches the current locale (Canada EN vs FR).
		$loc = function_exists( 'aq_current_locale' ) ? aq_current_locale() : 'en';
		foreach ( $all as $row ) {
			if ( $row['iso2'] === $iso2 && $row['lang'] === $loc ) {
				return $row['id'];
			}
		}
		foreach ( $all as $row ) {
			if ( $row['iso2'] === $iso2 ) {
				return $row['id'];
			}
		}
		// Geo says a country we don't tabulate → the lowest-PPP catch-all.
		return 'ROW';
	}
	// 3. current locale → first country in that language
	if ( function_exists( 'aq_current_locale' ) ) {
		$loc = aq_current_locale();
		foreach ( $all as $row ) {
			if ( $row['lang'] === $loc ) {
				return $row['id'];
			}
		}
	}
	// 4. default
	return 'CA';
}

/**
 * Full FX rate table (USD = 1.0), cached 24h. Superset of aq_currency_rates so
 * every country currency converts. Pulled in one call from open.er-api.com;
 * falls back to a seed table covering the country currencies.
 *
 * @return array<string,float>
 */
function aq_geo_rates() {
	$cached = get_transient( 'aq_geo_rates' );
	if ( is_array( $cached ) && ! empty( $cached ) ) {
		return $cached;
	}
	$fallback = array(
		'USD' => 1.0,   'CAD' => 1.37,  'EUR' => 0.92,  'GBP' => 0.79,  'AUD' => 1.52,
		'NZD' => 1.66,  'SGD' => 1.35,  'CHF' => 0.90,  'CNY' => 7.25,  'HKD' => 7.81,
		'TWD' => 32.3,  'JPY' => 156.0, 'INR' => 83.5,  'SAR' => 3.75,  'AED' => 3.67,
		'QAR' => 3.64,  'EGP' => 48.0,  'MAD' => 9.9,   'NGN' => 1550.0,'KES' => 129.0,
		'GHS' => 15.5,  'ZAR' => 18.3,  'BRL' => 5.7,   'IDR' => 16200.0,'PHP' => 58.0,
		'PKR' => 278.0, 'BDT' => 119.0, 'TRY' => 34.0,  'SEK' => 10.6,  'PLN' => 3.95,
		'MXN' => 18.5,
		// Top-50 expansion (offline backstop; the live merge below normally supersedes these).
		'ILS' => 3.7,   'UAH' => 41.0,  'RUB' => 92.0,  'KRW' => 1360.0,'THB' => 36.0,
		'VND' => 25400.0,'IRR' => 42000.0,'AFN' => 71.0, 'NPR' => 133.0, 'MYR' => 4.7,
		'IQD' => 1310.0,'DZD' => 135.0, 'ETB' => 57.0,  'UGX' => 3700.0,'TZS' => 2600.0,
		'AOA' => 910.0, 'UZS' => 12600.0,'MZN' => 64.0, 'MGA' => 4500.0,'SDG' => 600.0,
		'YER' => 250.0, 'CDF' => 2800.0, 'DKK' => 6.9,  'NOK' => 10.7,  'CZK' => 23.0,
		'RON' => 4.6,   'HUF' => 360.0,
	);
	$r = wp_safe_remote_get( 'https://open.er-api.com/v6/latest/USD', array( 'timeout' => 6 ) );
	if ( ! is_wp_error( $r ) && 200 === (int) wp_remote_retrieve_response_code( $r ) ) {
		$body = json_decode( wp_remote_retrieve_body( $r ), true );
		if ( is_array( $body ) && isset( $body['rates'] ) && is_array( $body['rates'] ) ) {
			// Merge the FULL live rate set over the seed so EVERY country currency
			// converts (the table covers ~160 currencies); seed values just backstop
			// any the feed happens to omit.
			$rates = $fallback;
			foreach ( $body['rates'] as $code => $val ) {
				if ( is_numeric( $val ) && $val > 0 ) {
					$rates[ (string) $code ] = (float) $val;
				}
			}
			set_transient( 'aq_geo_rates', $rates, DAY_IN_SECONDS );
			return $rates;
		}
	}
	set_transient( 'aq_geo_rates', $fallback, HOUR_IN_SECONDS );
	return $fallback;
}

/** One currency's USD rate (USD = 1.0); 1.0 if unknown. */
function aq_geo_rate( $code ) {
	$rates = aq_geo_rates();
	return isset( $rates[ $code ] ) ? (float) $rates[ $code ] : 1.0;
}

/** Currencies with no minor unit. */
function aq_geo_zero_decimal( $code ) {
	return in_array( $code, array( 'JPY', 'IDR', 'KRW', 'CLP', 'VND', 'HUF' ), true );
}

/** Symbol for a country currency (extends aq_currency_symbol with the wider set). */
function aq_geo_symbol( $code ) {
	$s = array(
		'USD' => '$', 'CAD' => 'CA$', 'AUD' => 'A$', 'NZD' => 'NZ$', 'SGD' => 'S$',
		'HKD' => 'HK$', 'TWD' => 'NT$', 'EUR' => '€', 'GBP' => '£', 'CHF' => 'CHF ',
		'CNY' => '¥', 'JPY' => '¥', 'INR' => '₹', 'SAR' => '﷼', 'AED' => 'د.إ',
		'QAR' => '﷼', 'EGP' => 'E£', 'MAD' => 'DH', 'NGN' => '₦', 'KES' => 'KSh',
		'GHS' => 'GH₵', 'ZAR' => 'R', 'BRL' => 'R$', 'IDR' => 'Rp', 'PHP' => '₱',
		'PKR' => '₨', 'BDT' => '৳', 'TRY' => '₺', 'SEK' => 'kr ', 'PLN' => 'zł ', 'MXN' => 'MX$',
		// Top-50 expansion currencies
		'RUB' => '₽', 'UAH' => '₴', 'ILS' => '₪', 'KRW' => '₩', 'THB' => '฿', 'VND' => '₫',
		'IRR' => '﷼', 'AFN' => '؋', 'NPR' => '₨', 'MYR' => 'RM', 'DZD' => 'DA ', 'IQD' => 'ID ',
		'EGP' => 'E£', 'ETB' => 'Br ', 'KES' => 'KSh', 'UGX' => 'USh', 'TZS' => 'TSh',
	);
	return isset( $s[ $code ] ) ? $s[ $code ] : ( $code . ' ' );
}

/** Round a converted amount to a human-friendly figure. */
function aq_geo_round( $amount, $code ) {
	$amount = (float) $amount;
	if ( $amount >= 2000 ) {
		return round( $amount / 100 ) * 100;
	}
	if ( $amount >= 200 ) {
		return round( $amount / 10 ) * 10;
	}
	if ( $amount >= 20 ) {
		return round( $amount );
	}
	return aq_geo_zero_decimal( $code ) ? round( $amount ) : round( $amount, 2 );
}

/**
 * Client config for the React country selector + price rendering.
 * Exposed as window.AQ_GEO.
 *
 * @return array
 */
function aq_geo_js_config() {
	$id   = aq_geo_current_id();
	$c    = aq_geo_country( $id );
	// The RAW edge geo header, separately from the selector: `iso2` below falls back to a saved
	// cookie, the UI locale and finally Canada, so it cannot say whether the visitor's country is
	// actually known. The sign-up nationality picker defaults from THIS (operator 2026-08-18,
	// "defaulted using IP") and shows an empty choice when no header reached us — a wrong prefilled
	// nationality is worse than none. Same header list, same order, as aq_geo_current_id().
	$ip_iso2 = '';
	foreach ( array( 'HTTP_CF_IPCOUNTRY', 'HTTP_CF_IP_COUNTRY', 'GEOIP_COUNTRY_CODE', 'HTTP_X_COUNTRY_CODE' ) as $h ) {
		if ( ! empty( $_SERVER[ $h ] ) ) {
			$v = strtoupper( substr( sanitize_text_field( wp_unslash( $_SERVER[ $h ] ) ), 0, 2 ) );
			// Cloudflare sends XX (unknown) and T1 (Tor); neither is a country.
			if ( preg_match( '/^[A-Z]{2}$/', $v ) && 'XX' !== $v ) { $ip_iso2 = $v; }
			break;
		}
	}
	$list = array();
	foreach ( aq_geo_countries() as $row ) {
		$list[] = array(
			'id'       => $row['id'],
			'iso2'     => $row['iso2'],
			'name'     => $row['name'],
			'flag'     => $row['flag'],
			'lang'     => $row['lang'],
			'currency' => $row['currency'],
		);
	}
	return array(
		'country'   => $c['id'],
		'iso2'      => $c['iso2'],
		'lang'      => $c['lang'],
		'currency'  => $c['currency'],
		'symbol'    => aq_geo_symbol( $c['currency'] ),
		'countries' => $list,
		'ip_iso2'   => $ip_iso2,
	);
}

/**
 * ISO 3166-1 numeric code for a two-letter code (matches the world-atlas topojson
 * feature ids used by the React maps). 0 when unknown.
 */
function aq_geo_iso_numeric( $iso2 ) {
	static $m = array(
		'CA' => 124, 'US' => 840, 'GB' => 826, 'IE' => 372, 'AU' => 36,  'NZ' => 554, 'SG' => 702,
		'DE' => 276, 'AT' => 40,  'CH' => 756, 'FR' => 250, 'BE' => 56,  'ES' => 724, 'MX' => 484,
		'AR' => 32,  'CO' => 170, 'CL' => 152, 'PE' => 604, 'CN' => 156, 'HK' => 344, 'TW' => 158,
		'JP' => 392, 'IN' => 356, 'SA' => 682, 'AE' => 784, 'QA' => 634, 'EG' => 818, 'MA' => 504,
		'NG' => 566, 'KE' => 404, 'GH' => 288, 'ZA' => 710, 'BR' => 76,  'ID' => 360, 'PH' => 608,
		'PK' => 586, 'BD' => 50,  'TR' => 792, 'NL' => 528, 'SE' => 752, 'PL' => 616, 'IT' => 380,
		'RU' => 643, 'IR' => 364, 'AF' => 4,   'UA' => 804, 'PS' => 275, 'IL' => 376, 'LB' => 422,
		'ET' => 231, 'CD' => 180, 'VN' => 704, 'TH' => 764, 'TZ' => 834, 'MM' => 104, 'KR' => 410,
		'UG' => 800, 'SD' => 729, 'DZ' => 12,  'IQ' => 368, 'YE' => 887, 'AO' => 24,  'UZ' => 860,
		'MY' => 458, 'MZ' => 508, 'NP' => 524, 'MG' => 450,
	);
	$iso2 = strtoupper( (string) $iso2 );
	return isset( $m[ $iso2 ] ) ? $m[ $iso2 ] : 0;
}

add_action(
	'wp_head',
	static function () {
		echo "<script>window.AQ_GEO = " . wp_json_encode( aq_geo_js_config() ) . ";</script>\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	},
	2
);
