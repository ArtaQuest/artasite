<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Stripe — live fiat payments (coin top-ups + donations), dependency-free (just wp_remote_*).
 *
 * Keys come from the ENVIRONMENT only (Secrets), never the public DB:
 *   STRIPE_SECRET_KEY (sk_…, server-only) · STRIPE_PUBLISHABLE_KEY (pk_…, safe for the browser)
 *   STRIPE_WEBHOOK_SECRET (whsec_…, optional — verifies webhook events).
 *
 * Flow: the server creates a Checkout Session (create_session) carrying the order in metadata; the
 * browser is redirected to session.url; Stripe returns to ?stripe=success&session=<id>; the server
 * RETRIEVES the session (retrieve_session) and, only when payment_status === 'paid', fulfils the
 * order (records the donation / credits coins) — idempotently. No card data ever touches us.
 *
 * Graceful degrade: enabled() is false when the secret key is unset, and callers fall back to the
 * old record-immediately behaviour, so nothing breaks before Stripe is configured.
 */
final class Stripe {

	const API = 'https://api.stripe.com/v1';

	public static function enabled() { return Secrets::has( 'STRIPE_SECRET_KEY' ); }
	public static function publishable_key() { return Secrets::get( 'STRIPE_PUBLISHABLE_KEY' ); }

	/** Form-encode a (possibly nested) params array the way Stripe expects: a[b][0][c]=v. */
	private static function encode( $data, $prefix = '' ) {
		$pairs = [];
		foreach ( $data as $k => $v ) {
			$key = $prefix === '' ? (string) $k : $prefix . '[' . $k . ']';
			if ( is_array( $v ) ) {
				$nested = self::encode( $v, $key );
				if ( $nested !== '' ) { $pairs[] = $nested; }
			} else {
				$pairs[] = rawurlencode( $key ) . '=' . rawurlencode( (string) $v );
			}
		}
		return implode( '&', $pairs );
	}

	/** A Stripe API request (Bearer = secret key). Returns the decoded body, or null on failure.
	 *  $idempotency_key (when given) is sent as the Idempotency-Key header so a retried POST — e.g. a
	 *  payout transfer replayed after a timeout — is de-duplicated by Stripe and never charged twice. */
	private static function req( $method, $path, $params = null, $idempotency_key = '' ) {
		if ( ! self::enabled() ) { return null; }
		$args = [
			'method'  => $method,
			'timeout' => 20,
			'headers' => [ 'Authorization' => 'Bearer ' . Secrets::get( 'STRIPE_SECRET_KEY' ) ],
		];
		if ( $idempotency_key !== '' ) { $args['headers']['Idempotency-Key'] = (string) $idempotency_key; }
		if ( $params !== null ) {
			$args['headers']['Content-Type'] = 'application/x-www-form-urlencoded';
			$args['body'] = self::encode( $params );
		}
		$resp = wp_remote_request( self::API . $path, $args );
		if ( is_wp_error( $resp ) ) { error_log( 'AQ Stripe: ' . $resp->get_error_message() ); return null; }
		$code = (int) wp_remote_retrieve_response_code( $resp );
		$body = json_decode( (string) wp_remote_retrieve_body( $resp ), true );
		if ( $code >= 300 || ! is_array( $body ) ) {
			error_log( "AQ Stripe $method $path → $code " . wp_remote_retrieve_body( $resp ) );
			return null;
		}
		return $body;
	}

	/**
	 * Create a one-off (mode=payment) Checkout Session for a single CAD amount. `metadata` (string
	 * values) is echoed back on the session so fulfilment can reconstruct the order. Returns
	 * [ id, url ] (redirect the browser to url) or null.
	 */
	public static function create_session( $amount_cents, $description, $success_url, $cancel_url, $metadata = [], $extra = [] ) {
		$amount_cents = (int) $amount_cents;
		if ( $amount_cents < 1 ) { return null; }
		$params = [
			'mode'                 => 'payment',
			'success_url'          => $success_url,
			'cancel_url'           => $cancel_url,
			'line_items'           => [ [
				'quantity'   => 1,
				'price_data' => [
					'currency'     => 'cad',
					'unit_amount'  => $amount_cents,
					'product_data' => [ 'name' => mb_substr( (string) $description, 0, 250 ) ],
				],
			] ],
		];
		// `payment_method_types` stays UNSET on purpose: Stripe then offers whatever is enabled on the
		// account, which is how Apple Pay, Google Pay and Link appear without a code change. Naming
		// types here would silently switch those off.
		//
		// $extra carries the per-flow trimmings — customer_email (one field the donor does not retype),
		// submit_type (Stripe's button reads "Donate" instead of "Pay"), payment_intent_data. Only
		// known keys are copied, so a caller cannot overwrite the amount or the return URLs.
		foreach ( [ 'customer_email', 'submit_type', 'payment_intent_data', 'allow_promotion_codes', 'locale' ] as $k ) {
			if ( isset( $extra[ $k ] ) && ( is_array( $extra[ $k ] ) || (string) $extra[ $k ] !== '' ) ) {
				$params[ $k ] = $extra[ $k ];
			}
		}
		foreach ( $metadata as $mk => $mv ) { $params['metadata'][ (string) $mk ] = mb_substr( (string) $mv, 0, 500 ); }
		$s = self::req( 'POST', '/checkout/sessions', $params );
		return ( $s && ! empty( $s['id'] ) ) ? [ 'id' => (string) $s['id'], 'url' => (string) ( $s['url'] ?? '' ) ] : null;
	}

	/** Retrieve a Checkout Session by id (to confirm payment_status). Returns the session or null. */
	public static function retrieve_session( $id ) {
		$id = (string) $id;
		if ( $id === '' ) { return null; }
		return self::req( 'GET', '/checkout/sessions/' . rawurlencode( $id ) );
	}

	/** True when a retrieved session is fully paid. */
	public static function is_paid( $session ) {
		return is_array( $session ) && ( $session['payment_status'] ?? '' ) === 'paid';
	}

	/**
	 * Verify a webhook's `Stripe-Signature` header against STRIPE_WEBHOOK_SECRET and return the decoded
	 * event (array) when the signature is valid and fresh, else null. Implements Stripe's scheme:
	 * HMAC-SHA256 of "<t>.<payload>" with the signing secret, constant-time compared to the v1 sig,
	 * rejecting timestamps older than the tolerance (replay protection). Pure — no side effects.
	 */
	public static function verify_webhook( $payload, $sig_header, $tolerance = 300 ) {
		$secret = Secrets::get( 'STRIPE_WEBHOOK_SECRET' );
		if ( $secret === '' || (string) $payload === '' || (string) $sig_header === '' ) { return null; }
		$t = ''; $v1 = '';
		foreach ( explode( ',', (string) $sig_header ) as $part ) {
			$kv = explode( '=', trim( $part ), 2 );
			if ( count( $kv ) !== 2 ) { continue; }
			if ( $kv[0] === 't' && $t === '' ) { $t = $kv[1]; }
			elseif ( $kv[0] === 'v1' && $v1 === '' ) { $v1 = $kv[1]; } // first v1 (Stripe may send several)
		}
		if ( $t === '' || $v1 === '' || ! ctype_digit( $t ) ) { return null; }
		if ( abs( time() - (int) $t ) > (int) $tolerance ) { return null; }
		$expected = hash_hmac( 'sha256', $t . '.' . $payload, $secret );
		if ( ! hash_equals( $expected, $v1 ) ) { return null; }
		$event = json_decode( (string) $payload, true );
		return is_array( $event ) ? $event : null;
	}

	// ── Connect (outbound payouts: cash-out coins → a member's bank) ───────────────────────────
	// To SEND money to a member we use Stripe Connect: each member who cashes out gets an Express
	// connected account (Stripe-hosted KYC/onboarding); we then Transfer from the platform balance
	// to that account, and Stripe pays it out to their bank automatically. No bank details ever
	// touch us. All four helpers degrade to null when Connect isn't enabled on the platform account,
	// so cash-out simply stays unavailable rather than erroring.

	/** Create an Express connected account for a member (transfers capability). Returns the acct id or null. */
	public static function create_express_account( $email, $country = 'CA' ) {
		$a = self::req( 'POST', '/accounts', [
			'type'         => 'express',
			'email'        => (string) $email,
			'country'      => (string) $country,
			'capabilities' => [ 'transfers' => [ 'requested' => 'true' ] ],
			'metadata'     => [ 'aq' => '1' ],
		] );
		return ( $a && ! empty( $a['id'] ) ) ? (string) $a['id'] : null;
	}

	/** A Stripe-hosted onboarding link for a connected account. Redirect the member here to finish KYC. */
	public static function account_link( $account_id, $refresh_url, $return_url ) {
		$l = self::req( 'POST', '/account_links', [
			'account'     => (string) $account_id,
			'refresh_url' => (string) $refresh_url,
			'return_url'  => (string) $return_url,
			'type'        => 'account_onboarding',
		] );
		return ( $l && ! empty( $l['url'] ) ) ? (string) $l['url'] : null;
	}

	/** Retrieve a connected account (to read payouts_enabled / details_submitted / requirements). */
	public static function account( $account_id ) {
		$id = (string) $account_id;
		if ( $id === '' ) { return null; }
		return self::req( 'GET', '/accounts/' . rawurlencode( $id ) );
	}

	/**
	 * Transfer platform funds to a connected account (the money-moving step of cash-out). Carries an
	 * Idempotency-Key so a network retry never sends twice. Returns the transfer (with its id) or null
	 * on failure. A test seam (`aq_stripe_create_transfer` filter) lets the harness exercise the
	 * transfer-then-debit logic without a live network call: a filter returning an array stands in for
	 * a successful transfer, `false` simulates a failed one, and null (default) means hit the real API.
	 */
	public static function create_transfer( $amount_cents, $currency, $destination, $idempotency_key = '', $metadata = [] ) {
		$amount_cents = (int) $amount_cents;
		if ( $amount_cents < 1 || (string) $destination === '' ) { return null; }
		$params = [
			'amount'      => $amount_cents,
			'currency'    => strtolower( (string) $currency ),
			'destination' => (string) $destination,
		];
		foreach ( $metadata as $mk => $mv ) { $params['metadata'][ (string) $mk ] = mb_substr( (string) $mv, 0, 500 ); }
		$override = apply_filters( 'aq_stripe_create_transfer', null, $params, $idempotency_key );
		if ( $override !== null ) { return $override === false ? null : $override; }
		$t = self::req( 'POST', '/transfers', $params, $idempotency_key );
		return ( $t && ! empty( $t['id'] ) ) ? $t : null;
	}

	/** List recent transfers (for the cash-out reconcile cron). Returns the `data` array, or []. The
	 *  `aq_stripe_list_transfers` filter is a test seam (return an array to stand in for the API). */
	public static function list_transfers( $created_gte = 0, $limit = 100 ) {
		$override = apply_filters( 'aq_stripe_list_transfers', null, (int) $created_gte, (int) $limit );
		if ( $override !== null ) { return is_array( $override ) ? $override : []; }
		$q = '/transfers?limit=' . (int) $limit;
		if ( $created_gte > 0 ) { $q .= '&created[gte]=' . (int) $created_gte; }
		$r = self::req( 'GET', $q );
		return ( is_array( $r ) && isset( $r['data'] ) && is_array( $r['data'] ) ) ? $r['data'] : [];
	}

	/**
	 * Recent COMPLETED Checkout Sessions (newest first), for the inbound reconcile — the mirror of
	 * list_transfers, which has covered the OUTBOUND cash-out leg since Economy::reconcile_payouts.
	 * Inbound had no equivalent, so a payment captured but never recorded had nothing looking for it.
	 *
	 * `status=complete` is Stripe's own filter for a finished session; `payment_status` is not a list
	 * parameter, so paid-ness is decided per row by is_paid(). Same test seam as list_transfers.
	 */
	public static function list_sessions( $created_gte = 0, $limit = 100 ) {
		$override = apply_filters( 'aq_stripe_list_sessions', null, (int) $created_gte, (int) $limit );
		if ( $override !== null ) { return is_array( $override ) ? $override : []; }
		$q = '/checkout/sessions?status=complete&limit=' . max( 1, min( 100, (int) $limit ) );
		if ( $created_gte > 0 ) { $q .= '&created[gte]=' . (int) $created_gte; }
		$r = self::req( 'GET', $q );
		return ( is_array( $r ) && isset( $r['data'] ) && is_array( $r['data'] ) ) ? $r['data'] : [];
	}
}
