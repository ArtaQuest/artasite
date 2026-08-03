<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaShop — the worldwide shop for HARD COPIES: printed books, games, illustration
 * prints and merch, shipped from Türkiye to (almost) anywhere on Earth.
 *
 * Shipping fees are computed from the PTT (Turkish Post) "International Item Charges and
 * Additional Service Tariffs" table — the printed-matter "M" bag weight grades plus the
 * additional services that apply to a goods shipment:
 *   • base grade (≤ 3 kg):        360 TL unregistered / 460 TL registered
 *   • each further kg (or part):  140 TL
 *   • weight cap 30 kg  (20 kg to England, Kazakhstan, Uzbekistan)
 *   • registered (tracked) mail is NOT accepted to the USA or Canada → auto-falls back
 *   • customs clearance fee 46.60 TL (applies to goods parcels and M bags)
 *   • optional insurance: 40 TL + 0.8% of the declared value (value capped at 653 SDR)
 * Tariff amounts are TL; the shopper pays ArtaCoins. 1 ₳ = 1 mg gold, so the TL→₳ rate is
 * derived live from the gold spot (aq_gold_spot_oz_usd) + the USD→TRY rate (aq_fx_rates)
 * — the same option sources the wallet's buy/sell already depend on.
 *
 * Three self-installed tables (the Library/Illustration pattern, isolated from Schema::VERSION):
 *   • aq_products    — the catalogue (kind: book|game|print|merch; may reference a published
 *                      aq_documents / aq_illustrations row as its source work)
 *   • aq_orders      — one row per paid order (PUBLIC — transparency; no address here)
 *   • aq_order_items — the order's product lines (title/price snapshots)
 *   • aq_order_ship  — the shipping address, in Extra::PRIVATE_TABLES (a delivery address is
 *                      promised private; everything else about the order stays public)
 *
 * Money: coins only, through the append-only ledger — an order debits the buyer once
 * (reason 'shop', ref 'shop:o<order>:u<uid>', idempotent); an operator cancel refunds with
 * reason 'shopr' (same idempotency). No new payment rail: wallets top up via the existing
 * Stripe coin BUY.
 */
final class Shop {

	const TABLE_VERSION = '1';

	const KINDS = [ 'book', 'game', 'print', 'merch' ];

	// ── PTT international tariff (TL unless noted) ─────────────────────────────
	const BASE_TL_UNREG   = 360.0;   // M bag, first weight grade (≤ BASE_G)
	const BASE_TL_REG     = 460.0;   // …registered (tracked)
	const PER_KG_TL       = 140.0;   // each additional 1000 g or fraction thereof
	const BASE_G          = 3000;    // the base grade covers up to 3 kg
	const STEP_G          = 1000;
	const MAX_G           = 30000;   // M-bag final weight
	const MAX_G_LOW       = 20000;   // …reduced cap for:
	const LOW_CAP         = [ 'GB', 'KZ', 'UZ' ];
	const NO_REGISTERED   = [ 'US', 'CA' ]; // registered M bags not accepted → unregistered only
	const CUSTOMS_TL      = 46.60;   // customs clearance fee (goods parcels + M bags)
	const INSURE_FIXED_TL = 40.0;    // insured items: fixed rate per item…
	const INSURE_PCT      = 0.008;   // …+ 0.8% of the declared value
	const INSURE_CAP_SDR  = 653;     // declared-value ceiling (SDR)
	const SDR_TRY_FALLBACK = 55.0;   // TRY per SDR when no override option is set

	// ── storage ────────────────────────────────────────────────────────────────
	public static function ensure_tables() {
		if ( get_option( 'aq_shop_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		dbDelta( "CREATE TABLE {$wpdb->prefix}aq_products (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			kind VARCHAR(10) NOT NULL DEFAULT 'merch',
			slug VARCHAR(191) NOT NULL DEFAULT '',
			title VARCHAR(255) NOT NULL DEFAULT '',
			summary TEXT NULL,
			image VARCHAR(600) NOT NULL DEFAULT '',
			source_type VARCHAR(12) NOT NULL DEFAULT '',
			source_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			price_coins INT UNSIGNED NOT NULL DEFAULT 1,
			weight_g INT UNSIGNED NOT NULL DEFAULT 500,
			stock INT NOT NULL DEFAULT -1,
			sold BIGINT UNSIGNED NOT NULL DEFAULT 0,
			status VARCHAR(12) NOT NULL DEFAULT 'draft',
			view_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			updated INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY slug (slug),
			KEY pub_feed (status, id),
			KEY kind_feed (kind, status, id)
		) {$charset};" );
		dbDelta( "CREATE TABLE {$wpdb->prefix}aq_orders (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			status VARCHAR(12) NOT NULL DEFAULT 'paid',
			country CHAR(2) NOT NULL DEFAULT '',
			service VARCHAR(12) NOT NULL DEFAULT 'registered',
			insured TINYINT(1) NOT NULL DEFAULT 0,
			weight_g INT UNSIGNED NOT NULL DEFAULT 0,
			coins_goods INT UNSIGNED NOT NULL DEFAULT 0,
			coins_ship INT UNSIGNED NOT NULL DEFAULT 0,
			coins_total INT UNSIGNED NOT NULL DEFAULT 0,
			fee_json TEXT NULL,
			tracking VARCHAR(80) NOT NULL DEFAULT '',
			created INT UNSIGNED NOT NULL DEFAULT 0,
			updated INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY buyer (user_id, id),
			KEY status_feed (status, id)
		) {$charset};" );
		dbDelta( "CREATE TABLE {$wpdb->prefix}aq_order_items (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			order_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			product_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			qty INT UNSIGNED NOT NULL DEFAULT 1,
			title VARCHAR(255) NOT NULL DEFAULT '',
			coins_each INT UNSIGNED NOT NULL DEFAULT 0,
			weight_g INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY order_lines (order_id, id),
			KEY product (product_id)
		) {$charset};" );
		dbDelta( "CREATE TABLE {$wpdb->prefix}aq_order_ship (
			order_id BIGINT UNSIGNED NOT NULL,
			name VARCHAR(190) NOT NULL DEFAULT '',
			address TEXT NULL,
			city VARCHAR(120) NOT NULL DEFAULT '',
			postcode VARCHAR(24) NOT NULL DEFAULT '',
			country CHAR(2) NOT NULL DEFAULT '',
			PRIMARY KEY  (order_id)
		) {$charset};" );
		update_option( 'aq_shop_table_version', self::TABLE_VERSION, true );
	}

	/** Did an internal step return an error? Rest::err builds a ready WP_REST_Response (its own 4xx
	 *  status), NOT a WP_Error — so error propagation between Shop helpers must test for that. */
	private static function is_err( $x ) {
		return $x instanceof \WP_REST_Response;
	}

	// ── currency: PTT charges TL, the shopper pays ₳ (1 ₳ = 1 mg gold) ─────────
	/** Live TL per coin from gold spot × USD→TRY. Falls back through the same chain
	 *  coin_price() uses so the figure is never 0 (a 0 would make shipping free). */
	public static function try_per_coin() {
		$oz_usd = (float) get_option( 'aq_gold_spot_oz_usd', 0 );
		$fx     = get_option( 'aq_fx_rates', [] );
		$try    = ( is_array( $fx ) && ! empty( $fx['TRY'] ) ) ? (float) $fx['TRY'] : 42.0;
		$usd_mg = $oz_usd > 0 ? $oz_usd / 31103.477 : 0.0;
		if ( $usd_mg <= 0 ) { // same last-resort chain as Economy::coin_price (CAD → USD)
			$cad    = ( is_array( $fx ) && ! empty( $fx['CAD'] ) ) ? (float) $fx['CAD'] : 1.37;
			$spot   = (float) Data::col( 'SELECT mg_base FROM ' . Data::t( 'aq_gold_rate_history' ) . ' ORDER BY id DESC LIMIT 1' );
			$usd_mg = ( $spot > 0 ? $spot : 0.20 ) / $cad;
		}
		return $usd_mg * $try;
	}

	/** TL → whole coins, rounded up (the shopper never underpays a fee PTT charges us). */
	private static function tl_to_coins( $tl ) {
		return (int) ceil( max( 0.0, (float) $tl ) / self::try_per_coin() );
	}

	// ── the tariff engine ──────────────────────────────────────────────────────
	/**
	 * Price a shipment of $weight_g grams of value $goods_coins to $country.
	 * Returns the full fee breakdown (TL + coins) or a WP_Error when unshippable.
	 */
	public static function shipping_quote( $country, $weight_g, $goods_coins, $insured = false ) {
		$country  = strtoupper( substr( preg_replace( '/[^A-Za-z]/', '', (string) $country ), 0, 2 ) );
		$weight_g = max( 1, (int) $weight_g );
		if ( strlen( $country ) !== 2 ) { return Rest::err( 'bad_country', 'Pick a destination country.' ); }
		$cap = in_array( $country, self::LOW_CAP, true ) ? self::MAX_G_LOW : self::MAX_G;
		if ( $weight_g > $cap ) {
			return Rest::err( 'too_heavy', sprintf( 'One shipment can carry at most %d kg to this country — please split the order.', (int) ( $cap / 1000 ) ) );
		}
		$registered = ! in_array( $country, self::NO_REGISTERED, true ); // tracked wherever PTT accepts it
		$base       = $registered ? self::BASE_TL_REG : self::BASE_TL_UNREG;
		$extra_kg   = (int) ceil( max( 0, $weight_g - self::BASE_G ) / self::STEP_G );
		$postage_tl = $base + $extra_kg * self::PER_KG_TL;
		$customs_tl = self::CUSTOMS_TL;

		$insure_tl = 0.0;
		if ( $insured ) {
			$sdr_try  = (float) get_option( 'aq_shop_sdr_try', self::SDR_TRY_FALLBACK );
			$value_tl = min( (float) $goods_coins * self::try_per_coin(), self::INSURE_CAP_SDR * $sdr_try );
			$insure_tl = self::INSURE_FIXED_TL + self::INSURE_PCT * $value_tl;
		}

		$total_tl = $postage_tl + $customs_tl + $insure_tl;
		return [
			'country'    => $country,
			'service'    => $registered ? 'registered' : 'unregistered',
			'tracked'    => $registered, // unregistered mail carries no tracking / compensation
			'weight_g'   => $weight_g,
			'postage_tl' => round( $postage_tl, 2 ),
			'customs_tl' => round( $customs_tl, 2 ),
			'insure_tl'  => round( $insure_tl, 2 ),
			'total_tl'   => round( $total_tl, 2 ),
			'coins'      => self::tl_to_coins( $total_tl ),
			'tl_per_coin' => round( self::try_per_coin(), 4 ),
		];
	}

	// ── public catalogue ───────────────────────────────────────────────────────
	private static function card( $r ) {
		return [
			'id'          => (int) $r['id'],
			'kind'        => (string) $r['kind'],
			'slug'        => (string) $r['slug'],
			'title'       => (string) $r['title'],
			'summary'     => (string) $r['summary'],
			'image'       => (string) $r['image'],
			'source_type' => (string) $r['source_type'],
			'source_id'   => (int) $r['source_id'],
			'price_coins' => (int) $r['price_coins'],
			'weight_g'    => (int) $r['weight_g'],
			'stock'       => (int) $r['stock'], // -1 = made to order (never sells out)
			'sold'        => (int) $r['sold'],
			'available'   => (int) $r['stock'] !== 0,
		];
	}

	/** GET shop/products — public keyset list of the published catalogue (?kind= filter). */
	public static function list( $req ) {
		self::ensure_tables();
		$kind   = sanitize_key( (string) Rest::p( $req, 'kind', '' ) );
		$where  = "status = 'published'";
		$args   = [];
		if ( in_array( $kind, self::KINDS, true ) ) { $where .= ' AND kind = %s'; $args[] = $kind; }
		[ $rows, $next ] = Data::page( 'aq_products', $where, $args, Rest::pint( $req, 'cursor', 0 ), 24 );
		return [ 'items' => array_map( [ __CLASS__, 'card' ], $rows ), 'next' => $next ];
	}

	/** GET shop/products/{id} — one product (published only). */
	public static function get( $req ) {
		self::ensure_tables();
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_products' ) . ' WHERE id = %d', [ Rest::pint( $req, 'id' ) ] );
		if ( ! $row || $row['status'] !== 'published' ) { return Rest::err( 'not_found', 'Product not found', 404 ); }
		Data::bump( 'aq_products', [ 'id' => (int) $row['id'] ], 'view_count', 1 );
		$out = self::card( $row );
		// One representative quote so the page can show "ships worldwide from ₳N"
		$q = self::shipping_quote( 'DE', (int) $row['weight_g'], (int) $row['price_coins'] );
		$out['ship_from_coins'] = self::is_err( $q ) ? null : $q['coins'];
		return $out;
	}

	/** Parse an "id:qty,id:qty" basket against the live catalogue → [lines, goods_coins, weight_g] | WP_Error. */
	private static function basket( $spec ) {
		$want = [];
		foreach ( explode( ',', (string) $spec ) as $pair ) {
			[ $id, $qty ] = array_pad( explode( ':', $pair, 2 ), 2, 1 );
			$id = (int) $id; $qty = max( 1, min( 99, (int) $qty ) );
			if ( $id > 0 ) { $want[ $id ] = ( $want[ $id ] ?? 0 ) + $qty; }
		}
		if ( ! $want || count( $want ) > 40 ) { return Rest::err( 'bad_input', 'Your basket is empty.' ); }
		$ph   = implode( ',', array_fill( 0, count( $want ), '%d' ) );
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_products' ) . " WHERE id IN ($ph) AND status = 'published'", array_keys( $want ) );
		if ( count( $rows ) !== count( $want ) ) { return Rest::err( 'not_found', 'An item in your basket is no longer available.', 404 ); }
		$lines = []; $coins = 0; $weight = 0;
		foreach ( $rows as $r ) {
			$qty = $want[ (int) $r['id'] ];
			if ( (int) $r['stock'] >= 0 && $qty > (int) $r['stock'] ) {
				return Rest::err( 'out_of_stock', sprintf( 'Only %d of "%s" left in stock.', (int) $r['stock'], (string) $r['title'] ) );
			}
			$lines[] = [ 'row' => $r, 'qty' => $qty ];
			$coins  += $qty * (int) $r['price_coins'];
			$weight += $qty * (int) $r['weight_g'];
		}
		return [ $lines, $coins, $weight ];
	}

	/** GET shop/quote?country=DE&items=1:2,3:1&insured=1 — the live shipping fee for a basket. */
	public static function quote_rest( $req ) {
		self::ensure_tables();
		$basket = self::basket( Rest::p( $req, 'items', '' ) );
		if ( self::is_err( $basket ) ) { return $basket; }
		[ , $coins, $weight ] = $basket;
		$q = self::shipping_quote( Rest::p( $req, 'country', '' ), $weight, $coins, (bool) Rest::pint( $req, 'insured', 0 ) );
		if ( self::is_err( $q ) ) { return $q; }
		return $q + [ 'goods_coins' => $coins, 'total_coins' => $coins + $q['coins'] ];
	}

	// ── ordering (coins only, append-only ledger) ─────────────────────────────

	/** PTT's public door-to-door tracking page for a barcode ('' when the shipment is untracked). */
	public static function track_url( $tracking ) {
		$t = trim( (string) $tracking );
		return $t === '' ? '' : 'https://gonderitakip.ptt.gov.tr/Track/Verify?q=' . rawurlencode( $t );
	}

	/** "2× ArtaQuest mug — ₳170" lines for the confirmation/shipped/refund emails. */
	private static function items_text( $items ) {
		return implode( "\n", array_map(
			static fn( $i ) => $i['qty'] . '× ' . $i['title'] . ' — ₳' . ( $i['qty'] * $i['coins_each'] ),
			$items
		) );
	}

	/** Claim counted stock ATOMICALLY (never oversell two racing orders): one conditional UPDATE per
	 *  line; on any failure the earlier claims are released and the failing title returned. */
	private static function claim_stock( $lines ) {
		global $wpdb;
		$t = Data::t( 'aq_products' );
		$claimed = [];
		foreach ( $lines as $l ) {
			if ( (int) $l['row']['stock'] < 0 ) { continue; } // made to order — nothing to claim
			$got = $wpdb->query( $wpdb->prepare(
				"UPDATE {$t} SET stock = stock - %d WHERE id = %d AND stock >= %d",
				(int) $l['qty'], (int) $l['row']['id'], (int) $l['qty']
			) );
			if ( ! $got ) {
				foreach ( $claimed as $c ) { Data::bump( 'aq_products', [ 'id' => $c[0] ], 'stock', $c[1] ); }
				return (string) $l['row']['title'];
			}
			$claimed[] = [ (int) $l['row']['id'], (int) $l['qty'] ];
		}
		return null;
	}
	/** POST shop/order {items, country, name, address, city, postcode, insured} */
	public static function order( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'shop_order', 10, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid    = Rest::uid();
		$basket = self::basket( Rest::p( $req, 'items', '' ) );
		if ( self::is_err( $basket ) ) { return $basket; }
		[ $lines, $goods, $weight ] = $basket;

		$insured = (bool) Rest::pint( $req, 'insured', 0 );
		$quote   = self::shipping_quote( Rest::p( $req, 'country', '' ), $weight, $goods, $insured );
		if ( self::is_err( $quote ) ) { return $quote; }

		$name     = sanitize_text_field( (string) Rest::p( $req, 'name', '' ) );
		$address  = sanitize_textarea_field( (string) Rest::p( $req, 'address', '' ) );
		$city     = sanitize_text_field( (string) Rest::p( $req, 'city', '' ) );
		$postcode = sanitize_text_field( (string) Rest::p( $req, 'postcode', '' ) );
		if ( mb_strlen( $name ) < 2 || mb_strlen( $address ) < 8 || $city === '' ) {
			return Rest::err( 'bad_address', 'Please give the full name and street address the parcel should be delivered to.' );
		}

		$total = $goods + $quote['coins'];

		// Serialise this member's wallet debits: the balance check and the debit below are two separate
		// statements, so without a lock two simultaneous orders — or an order racing an enrol/cash-out —
		// could all pass their affordability checks and overdraw the wallet. Same ATOMIC per-user lock
		// (wallet_u<id>) as Economy::sell() and Learn::ensure_enrolled; held only across the fast
		// check→claim→insert→debit span, released before the mail/notification tail.
		$wlock = 'wallet_u' . $uid;
		if ( ! Economy::acquire_lock( $wlock, 30 ) ) {
			return Rest::err( 'busy', 'Another payment is in progress. Please try again in a moment.', 429 );
		}
		try {
			if ( Economy::coin_balance( $uid ) < $total ) {
				return Rest::err( 'insufficient_coins', sprintf( 'This order costs ₳%d and your wallet holds fewer coins. Top up on the wallet page first.', $total ), 402 );
			}

			// Claim counted stock BEFORE the order exists — atomic per line, so two racing orders can
			// never both take the last copy (the basket() read above is only a fast pre-check).
			$sold_out = self::claim_stock( $lines );
			if ( $sold_out !== null ) {
				return Rest::err( 'out_of_stock', sprintf( '"%s" just sold out — remove it from the basket to order the rest.', $sold_out ) );
			}

			Data::insert( 'aq_orders', [
				'user_id'     => $uid,
				'status'      => 'paid',
				'country'     => $quote['country'],
				'service'     => $quote['service'],
				'insured'     => $insured ? 1 : 0,
				'weight_g'    => $weight,
				'coins_goods' => $goods,
				'coins_ship'  => $quote['coins'],
				'coins_total' => $total,
				'fee_json'    => wp_json_encode( $quote ),
				'created'     => Data::now(),
				'updated'     => Data::now(),
			] );
			global $wpdb;
			$oid = (int) $wpdb->insert_id;
			foreach ( $lines as $l ) {
				Data::insert( 'aq_order_items', [
					'order_id'   => $oid,
					'product_id' => (int) $l['row']['id'],
					'qty'        => (int) $l['qty'],
					'title'      => (string) $l['row']['title'],
					'coins_each' => (int) $l['row']['price_coins'],
					'weight_g'   => (int) $l['row']['weight_g'],
				] );
				// stock was already claimed atomically above; only the sold counter moves here
				Data::bump( 'aq_products', [ 'id' => (int) $l['row']['id'] ], 'sold', (int) $l['qty'] );
			}
			Data::insert( 'aq_order_ship', [
				'order_id' => $oid, 'name' => $name, 'address' => $address,
				'city' => $city, 'postcode' => $postcode, 'country' => $quote['country'],
			] );
			// The one debit — idempotent per order (the order id exists exactly once).
			$ref = 'shop:o' . $oid . ':u' . $uid;
			if ( ! Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'shop' AND ref = %s LIMIT 1", [ $ref ] ) ) {
				Economy::credit_coins( $uid, -$total, 'shop', $ref );
			}
		} finally {
			Economy::release_lock( $wlock );
		}
		Watchdog::note( sprintf( 'ArtaShop: new order #%d — ₳%d (%d item lines, %dg → %s, %s)', $oid, $total, count( $lines ), $weight, $quote['country'], $quote['service'] ) );

		// Confirmation + invoice — email and bell, both fail-open (a mail hiccup never voids a paid order).
		$out = self::order_out( $oid, $uid );
		Notify::push( $uid, 'shop', sprintf( 'Order #%d confirmed — ₳%d paid', $oid, $total ),
			'We’re preparing your hard copies. Your invoice is in your inbox.', '/shop/', 'shoporder:' . $oid );
		$u = get_userdata( $uid );
		if ( $u && $u->user_email ) {
			$registered = $quote['service'] === 'registered';
			$fee_detail = sprintf(
				'Shipping is the exact fee our postal carrier charges us for postage and customs clearance%s — passed through at cost, nothing added.',
				$quote['insure_tl'] > 0 ? ' plus insurance' : ''
			);
			Mailer::send( 'shop_order', $u->user_email, [
				'id'           => $oid,
				'date'         => date_i18n( 'M j, Y', Data::now() ),
				'items'        => self::items_text( $out['items'] ),
				'goods'        => $goods,
				'shipping'     => $quote['coins'],
				'service'      => $registered ? 'registered & tracked' : 'unregistered',
				'fee_detail'   => $fee_detail,
				'total'        => $total,
				'address'      => $name . "\n" . $address . "\n" . $postcode . ' ' . $city . ', ' . $quote['country'],
				'service_note' => $registered
					? 'Your parcel travels registered and gets a tracking number.'
					: 'Only unregistered mail is available to your country, so this parcel has no tracking number.',
			] );
		}
		return [ 'ok' => true, 'order' => $out ];
	}

	/** One order, shaped for its owner (includes the private address + lines). */
	private static function order_out( $oid, $uid ) {
		$o = Data::one( 'SELECT * FROM ' . Data::t( 'aq_orders' ) . ' WHERE id = %d AND user_id = %d', [ (int) $oid, (int) $uid ] );
		if ( ! $o ) { return null; }
		$ship = Data::one( 'SELECT * FROM ' . Data::t( 'aq_order_ship' ) . ' WHERE order_id = %d', [ (int) $oid ] );
		return [
			'id'          => (int) $o['id'],
			'status'      => (string) $o['status'],
			'country'     => (string) $o['country'],
			'service'     => (string) $o['service'],
			'insured'     => (bool) $o['insured'],
			'weight_g'    => (int) $o['weight_g'],
			'coins_goods' => (int) $o['coins_goods'],
			'coins_ship'  => (int) $o['coins_ship'],
			'coins_total' => (int) $o['coins_total'],
			'tracking'    => (string) $o['tracking'],
			'track_url'   => self::track_url( $o['tracking'] ),
			'created'     => (int) $o['created'],
			'items'       => array_map( static fn( $i ) => [
				'product_id' => (int) $i['product_id'], 'qty' => (int) $i['qty'],
				'title' => (string) $i['title'], 'coins_each' => (int) $i['coins_each'],
			], Data::all( 'SELECT * FROM ' . Data::t( 'aq_order_items' ) . ' WHERE order_id = %d ORDER BY id ASC', [ (int) $oid ] ) ),
			'ship_to'     => $ship ? [
				'name' => (string) $ship['name'], 'address' => (string) $ship['address'],
				'city' => (string) $ship['city'], 'postcode' => (string) $ship['postcode'], 'country' => (string) $ship['country'],
			] : null,
		];
	}

	/** GET shop/orders — the signed-in member's own orders, newest first. */
	public static function my_orders( $req ) {
		self::ensure_tables();
		$uid  = Rest::uid();
		$rows = Data::all( 'SELECT id FROM ' . Data::t( 'aq_orders' ) . ' WHERE user_id = %d ORDER BY id DESC LIMIT 50', [ $uid ] );
		return [ 'items' => array_values( array_filter( array_map( static fn( $r ) => self::order_out( (int) $r['id'], $uid ), $rows ) ) ) ];
	}

	// ── operator surface (Studio › Shop) ───────────────────────────────────────
	private static function gate() { return user_can( Rest::uid(), 'manage_options' ); }

	/** GET studio/shop — every product (all statuses) + open orders, for the operator tab. */
	public static function studio_list( $req ) {
		self::ensure_tables();
		if ( ! self::gate() ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		$products = array_map( static fn( $r ) => self::card( $r ) + [ 'status' => (string) $r['status'] ],
			Data::all( 'SELECT * FROM ' . Data::t( 'aq_products' ) . ' ORDER BY id DESC LIMIT 200' ) );
		$orders = [];
		foreach ( Data::all( 'SELECT id, user_id FROM ' . Data::t( 'aq_orders' ) . ' ORDER BY id DESC LIMIT 100' ) as $r ) {
			$o = self::order_out( (int) $r['id'], (int) $r['user_id'] );
			if ( $o ) { $o['user_id'] = (int) $r['user_id']; $orders[] = $o; }
		}
		return [ 'products' => $products, 'orders' => $orders, 'tl_per_coin' => round( self::try_per_coin(), 4 ) ];
	}

	/** POST studio/shop/product — operator create/update. {id?, kind, title, summary, image,
	 *  price_coins, weight_g, stock, status, source_type?, source_id?, delete?} */
	public static function save_product( $req ) {
		self::ensure_tables();
		if ( ! self::gate() ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		$id = Rest::pint( $req, 'id', 0 );
		if ( Rest::pint( $req, 'delete', 0 ) && $id ) {
			Data::update( 'aq_products', [ 'status' => 'removed', 'updated' => Data::now() ], [ 'id' => $id ] );
			return [ 'ok' => true ];
		}
		$kind = sanitize_key( (string) Rest::p( $req, 'kind', 'merch' ) );
		$data = [
			'kind'        => in_array( $kind, self::KINDS, true ) ? $kind : 'merch',
			'title'       => sanitize_text_field( (string) Rest::p( $req, 'title', '' ) ),
			'summary'     => sanitize_textarea_field( (string) Rest::p( $req, 'summary', '' ) ),
			'image'       => esc_url_raw( (string) Rest::p( $req, 'image', '' ) ),
			'source_type' => sanitize_key( (string) Rest::p( $req, 'source_type', '' ) ),
			'source_id'   => Rest::pint( $req, 'source_id', 0 ),
			'price_coins' => max( 1, Rest::pint( $req, 'price_coins', 1 ) ),
			'weight_g'    => max( 1, min( self::MAX_G, Rest::pint( $req, 'weight_g', 500 ) ) ),
			'stock'       => max( -1, Rest::pint( $req, 'stock', -1 ) ),
			'status'      => Rest::p( $req, 'status', 'draft' ) === 'published' ? 'published' : 'draft',
			'updated'     => Data::now(),
		];
		if ( $data['title'] === '' ) { return Rest::err( 'bad_input', 'A product needs a title.' ); }
		if ( $id ) {
			Data::update( 'aq_products', $data, [ 'id' => $id ] );
		} else {
			$slug = sanitize_title( $data['title'] );
			if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_products' ) . ' WHERE slug = %s', [ $slug ] ) ) { $slug .= '-' . wp_rand( 100, 999 ); }
			Data::insert( 'aq_products', $data + [ 'slug' => $slug, 'created' => Data::now() ] );
			global $wpdb;
			$id = (int) $wpdb->insert_id;
		}
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_products' ) . ' WHERE id = %d', [ $id ] );
		return [ 'ok' => true, 'product' => self::card( $row ) + [ 'status' => (string) $row['status'] ] ];
	}

	/** POST studio/shop/order {id, action: shipped|delivered|cancel, tracking?} — fulfilment.
	 *  Cancel refunds the full total (idempotent, reason 'shopr') and restores counted stock. */
	public static function update_order( $req ) {
		self::ensure_tables();
		if ( ! self::gate() ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		$id = Rest::pint( $req, 'id', 0 );
		$o  = Data::one( 'SELECT * FROM ' . Data::t( 'aq_orders' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $o ) { return Rest::err( 'not_found', 'Order not found', 404 ); }
		$action = sanitize_key( (string) Rest::p( $req, 'action', '' ) );
		$buyer  = (int) $o['user_id'];
		$bu     = get_userdata( $buyer );
		if ( $action === 'shipped' || $action === 'delivered' ) {
			$data = [ 'status' => $action, 'updated' => Data::now() ];
			$tracking = sanitize_text_field( (string) Rest::p( $req, 'tracking', '' ) );
			if ( $tracking !== '' ) { $data['tracking'] = $tracking; }
			Data::update( 'aq_orders', $data, [ 'id' => $id ] );
			if ( $action === 'shipped' && $o['status'] !== 'shipped' ) { // notify once, on the first flip
				$track = $tracking !== '' ? $tracking : (string) $o['tracking'];
				$turl  = self::track_url( $track );
				$items = self::items_text( self::order_out( $id, $buyer )['items'] ?? [] );
				Notify::push( $buyer, 'shop', sprintf( 'Order #%d shipped', $id ),
					$track !== '' ? 'Tracking ' . $track : 'On its way by unregistered post.', '/shop/', 'shopship:' . $id );
				if ( $bu && $bu->user_email ) {
					Mailer::send( 'shop_shipped', $bu->user_email, [
						'id'         => $id,
						'items'      => $items,
						'tracking'   => $track,
						'track_line' => $track !== ''
							? 'Your tracking number (follow it door-to-door at the button below — it also works on your national post’s tracker once the parcel enters your country):'
							: 'Only unregistered mail is available to your country, so this parcel travels without a tracking number.',
						'track_url'  => $turl !== '' ? $turl : '/shop/',
					] );
				}
			}
		} elseif ( $action === 'cancel' ) {
			if ( $o['status'] !== 'paid' ) { return Rest::err( 'bad_state', 'Only a not-yet-shipped order can be cancelled.' ); }
			$ref = 'shopr:o' . $id;
			if ( ! Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_coin_ledger' ) . " WHERE reason = 'shopr' AND ref = %s LIMIT 1", [ $ref ] ) ) {
				Economy::credit_coins( $buyer, (int) $o['coins_total'], 'shopr', $ref );
				foreach ( Data::all( 'SELECT * FROM ' . Data::t( 'aq_order_items' ) . ' WHERE order_id = %d', [ $id ] ) as $i ) {
					$p = Data::one( 'SELECT stock FROM ' . Data::t( 'aq_products' ) . ' WHERE id = %d', [ (int) $i['product_id'] ] );
					if ( $p && (int) $p['stock'] >= 0 ) { Data::bump( 'aq_products', [ 'id' => (int) $i['product_id'] ], 'stock', (int) $i['qty'] ); }
					Data::bump( 'aq_products', [ 'id' => (int) $i['product_id'] ], 'sold', -(int) $i['qty'] );
				}
				Notify::push( $buyer, 'shop', sprintf( 'Order #%d cancelled — ₳%d refunded', $id, (int) $o['coins_total'] ),
					'The full amount is back in your wallet.', '/wallet/', 'shoprefund:' . $id );
				if ( $bu && $bu->user_email ) {
					Mailer::send( 'shop_refund', $bu->user_email, [
						'id'    => $id,
						'total' => (int) $o['coins_total'],
						'items' => self::items_text( self::order_out( $id, $buyer )['items'] ?? [] ),
					] );
				}
			}
			Data::update( 'aq_orders', [ 'status' => 'cancelled', 'updated' => Data::now() ], [ 'id' => $id ] );
		} else {
			return Rest::err( 'bad_input', 'Unknown action' );
		}
		return [ 'ok' => true, 'order' => self::order_out( $id, (int) $o['user_id'] ) ];
	}
}
