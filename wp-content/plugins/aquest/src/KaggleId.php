<?php
/**
 * KaggleId — proving that a member controls the Kaggle account they are submitting from.
 *
 * WHY THIS EXISTS. Publishing a work here mints a PERMANENT DOI whose creator is the notebook's Kaggle
 * author. Until 2026-08-04 any member could submit any public notebook, so the platform could mint a
 * citation of record in the name of somebody who never asked for one and might never learn of it. A DOI
 * is deliberately not retractable — that is the whole point of a citation of record — so consent has to
 * be established BEFORE the mint, not apologised for after it.
 *
 * THE PROOF, and why it is shaped like this. We give the member a one-time string; they put it in a
 * PUBLIC notebook under the handle they claim; we read that kernel back and check three things — the
 * kernel is public, its owner is the claimed handle, and the string is in it. Only someone who can
 * write to that Kaggle account can do that.
 *
 * It is deliberately the same shape as every other claim on this platform: `proof_kernel` is kept, and
 * kernels/pull answers for a public kernel with no credential at all, so a STRANGER can re-run this
 * check for themselves, today or in a year. We are not asking anyone to trust that we once looked.
 *
 * WHAT IT DOES NOT CLAIM. It proves control of the ACCOUNT, not authorship of every cell. Someone who
 * owns a Kaggle account can post anything to it, including a fork. This closes the gap where a work is
 * credited to a stranger; it does not adjudicate plagiarism, and no copy anywhere should say it does.
 *
 * SECRETS. `nonce_hash` is a sha256 and never the string itself. Every row of this database is public
 * (the Data explorer serves all of it), so storing the plaintext would publish the proof and let any
 * reader claim the handle. It is cleared once verified, so a proven row carries no verifier at all.
 */

namespace AQ;

defined( 'ABSPATH' ) || exit;

final class KaggleId {

	const TABLE = 'aq_kaggle_ids';

	/** A pending claim is good for this long. Long enough to go and edit a notebook, short enough that
	 *  an abandoned claim does not hold a handle's slot open indefinitely. */
	const CLAIM_TTL = 7 * DAY_IN_SECONDS;

	/** The proof string a member pastes into their notebook. Prefixed so it is self-describing when a
	 *  reader stumbles on it in someone's public code, and so we can find it in a large source blob. */
	const PREFIX = 'artaquest-owns-';

	// ── Reads (the checklist's questions) ───────────────────────────────────

	/**
	 * Has THIS member proven THIS handle? The single question Kernel's `owner_proven` check asks.
	 * Handles are compared lowercased because Kaggle treats them case-insensitively.
	 */
	public static function verified_handle( $user_id, $handle ) {
		$uid = (int) $user_id;
		$h   = self::norm( $handle );
		if ( $uid <= 0 || '' === $h ) { return false; }
		return (bool) Data::col(
			'SELECT id FROM ' . Data::t( self::TABLE ) . ' WHERE user_id = %d AND handle = %s AND state = %s LIMIT 1',
			[ $uid, $h, 'verified' ] );
	}

	/** Every handle this member has claimed, proven or not — each row says which it is. */
	public static function handles( $user_id ) {
		$uid = (int) $user_id;
		if ( $uid <= 0 ) { return []; }
		return (array) Data::all(
			'SELECT handle, state, proof_kernel, created, verified_at FROM ' . Data::t( self::TABLE )
			. ' WHERE user_id = %d ORDER BY id DESC LIMIT 50', [ $uid ] );
	}

	/** GET kaggle-id — the caller's own claims. Never anyone else's: a member's Kaggle identity is
	 *  theirs to disclose, and the work page already names the handle where it is relevant. */
	public static function mine() {
		$uid = Rest::uid();
		if ( $uid <= 0 ) { return Rest::err( 'auth', 'Sign in first', 401 ); }
		$out = [];
		foreach ( self::handles( $uid ) as $r ) {
			$out[] = [
				'handle'       => (string) $r['handle'],
				'state'        => (string) $r['state'],
				'proof_kernel' => (string) $r['proof_kernel'],
				'verified_at'  => (int) $r['verified_at'],
				'expired'      => 'pending' === (string) $r['state'] && ( Data::now() - (int) $r['created'] ) > self::CLAIM_TTL,
			];
		}
		return [ 'items' => $out, 'prefix' => self::PREFIX ];
	}

	// ── Claim ───────────────────────────────────────────────────────────────

	/**
	 * POST kaggle-id/claim {handle} — mint a one-time proof string for a handle.
	 *
	 * The plaintext is returned HERE AND NOWHERE ELSE, and only its sha256 is written. Re-claiming
	 * mints a fresh string and invalidates the old one, which is also the recovery path for a member
	 * who loses it — there is deliberately no "show it to me again".
	 */
	public static function claim( $req ) {
		$uid = Rest::uid();
		if ( $uid <= 0 ) { return Rest::err( 'auth', 'Sign in first', 401 ); }
		// Rest::throttle() returns TRUE when the caller is OVER the limit — the sense every other
		// call site in the plugin uses. This test was inverted, which refused the first ten attempts
		// and then let the eleventh through: the endpoint answered "Too many attempts" to a member's
		// very FIRST claim and only worked once they had hammered it. Nobody could prove a handle by
		// the intended route, and a legitimate path that cannot be walked is what pushes people to
		// look for a way around the gate.
		if ( Rest::throttle( 'kgclaim' . $uid, 10, 600 ) ) {
			return Rest::err( 'slow_down', 'Too many attempts — wait a few minutes', 429 );
		}
		$h = self::norm( Rest::p( $req, 'handle', '' ) );
		if ( ! self::plausible( $h ) ) {
			return Rest::err( 'handle', 'That does not look like a Kaggle username' );
		}
		// Refuse early and by name if the handle is already SOMEONE ELSE'S proven account. Two members
		// may hold competing PENDING claims (only one can ever prove it, and refusing a claim would let
		// anyone reserve a handle they do not own) — but a proven one is settled.
		$owner = (int) Data::col(
			'SELECT user_id FROM ' . Data::t( self::TABLE ) . ' WHERE handle = %s AND state = %s LIMIT 1',
			[ $h, 'verified' ] );
		if ( $owner && $owner !== $uid ) {
			return Rest::err( 'taken', 'Another member has already proven they control kaggle.com/' . $h
				. '. If that account is yours, write to us and we will look at both proofs.', 409 );
		}
		if ( self::verified_handle( $uid, $h ) ) {
			return [ 'ok' => true, 'already' => true, 'handle' => $h,
				'message' => 'You have already proven this account' ];
		}

		$secret = self::PREFIX . bin2hex( random_bytes( 12 ) );
		$row    = [
			'user_id'      => $uid,
			'handle'       => $h,
			'nonce_hash'   => hash( 'sha256', $secret ),
			'proof_kernel' => '',
			'state'        => 'pending',
			'created'      => Data::now(),
			'verified_at'  => 0,
		];
		// UNIQUE (user_id, handle) makes this idempotent per member: a re-claim overwrites their own
		// pending row with a fresh secret rather than accumulating claims.
		Data::upsert( self::TABLE, [ 'user_id' => $uid, 'handle' => $h ], $row );

		return [
			'ok'     => true,
			'handle' => $h,
			'proof'  => $secret,   // shown ONCE — never stored, never returned again
			'how'    => 'Put this exact line anywhere in a public notebook on kaggle.com/' . $h
				. ' (a comment in a code cell is fine), save it, then paste that notebook\'s URL back here.',
		];
	}

	// ── Verify ──────────────────────────────────────────────────────────────

	/**
	 * POST kaggle-id/verify {handle, url} — read the member's notebook back and settle the claim.
	 *
	 * Everything this asserts is re-checkable by anyone: the kernel URL is kept, and a public kernel
	 * answers kernels/pull for a stranger too.
	 */
	public static function verify( $req ) {
		$uid = Rest::uid();
		if ( $uid <= 0 ) { return Rest::err( 'auth', 'Sign in first', 401 ); }
		// This makes an outbound HTTP call, so it is an amplifier if left open. Same inverted test
		// as claim() above: throttle() is TRUE when over the limit, so `!` refused every honest
		// first attempt and opened the amplifier only to a caller who had already hammered it —
		// exactly backwards on both counts.
		if ( Rest::throttle( 'kgverify' . $uid, 12, 600 ) ) {
			return Rest::err( 'slow_down', 'Too many attempts — wait a few minutes', 429 );
		}
		$h   = self::norm( Rest::p( $req, 'handle', '' ) );
		$url = trim( (string) Rest::p( $req, 'url', '' ) );
		if ( '' === $h || '' === $url ) { return Rest::err( 'input', 'Give the handle and the notebook URL' ); }

		$claim = Data::one(
			'SELECT * FROM ' . Data::t( self::TABLE ) . ' WHERE user_id = %d AND handle = %s LIMIT 1',
			[ $uid, $h ] );
		if ( ! $claim ) { return Rest::err( 'no_claim', 'Ask for a proof string for this account first' ); }
		if ( 'verified' === (string) $claim['state'] ) {
			return [ 'ok' => true, 'already' => true, 'handle' => $h, 'state' => 'verified' ];
		}
		if ( ( Data::now() - (int) $claim['created'] ) > self::CLAIM_TTL ) {
			return Rest::err( 'expired', 'That proof string has expired — ask for a new one', 410 );
		}

		$parsed = Kaggle::parse_url( $url );
		if ( ! $parsed || empty( $parsed['owner'] ) || empty( $parsed['slug'] ) ) {
			return Rest::err( 'url', 'That is not a Kaggle notebook URL' );
		}
		// THE OWNER CHECK IS AGAINST THE URL *AND* THE KERNEL'S OWN METADATA. A URL can say anything;
		// what settles it is what Kaggle answers.
		if ( self::norm( $parsed['owner'] ) !== $h ) {
			return Rest::err( 'owner', 'That notebook belongs to kaggle.com/' . self::norm( $parsed['owner'] )
				. ', not to ' . $h );
		}

		[ $code, $meta, $src ] = Kaggle::pull( (string) $parsed['owner'], (string) $parsed['slug'] );
		if ( 403 === (int) $code ) {
			// Documented trap: private OR DELETED both answer 403, never 404. Say both, because telling
			// a member "it is private" about a notebook they deleted sends them looking in the wrong place.
			return Rest::err( 'not_public', 'Kaggle will not show us that notebook — it is private, or it no longer exists. It has to be public for anyone to check this.' );
		}
		if ( (int) $code < 200 || (int) $code >= 300 ) {
			return Rest::err( 'kaggle', 'Kaggle did not answer for that notebook (HTTP ' . (int) $code . ') — try again shortly', 502 );
		}
		if ( ! empty( $meta['isPrivate'] ) ) {
			return Rest::err( 'not_public', 'That notebook is private. Make it public so the proof can be checked by anyone, not just by us.' );
		}
		$meta_owner = self::norm( $meta['ownerUser'] ?? ( $meta['ownerUserNullable'] ?? '' ) );
		if ( '' !== $meta_owner && $meta_owner !== $h ) {
			return Rest::err( 'owner', 'Kaggle says that notebook belongs to ' . $meta_owner . ', not to ' . $h );
		}

		// Compare by HASH, over every proof-shaped token in the source. Scanning for our prefix rather
		// than for the secret keeps the secret out of this process's comparisons entirely.
		$want  = (string) $claim['nonce_hash'];
		$found = false;
		if ( '' !== $want && preg_match_all( '/' . preg_quote( self::PREFIX, '/' ) . '[0-9a-f]{24}/i', (string) $src, $m ) ) {
			foreach ( $m[0] as $tok ) {
				if ( hash_equals( $want, hash( 'sha256', strtolower( $tok ) ) ) ) { $found = true; break; }
			}
		}
		if ( ! $found ) {
			return Rest::err( 'no_proof', 'That notebook does not contain your proof string. Paste it in, save the notebook so the change is public, then try again.' );
		}

		// Last-moment race: somebody else may have proven this handle since the claim was made.
		$owner = (int) Data::col(
			'SELECT user_id FROM ' . Data::t( self::TABLE ) . ' WHERE handle = %s AND state = %s LIMIT 1',
			[ $h, 'verified' ] );
		if ( $owner && $owner !== $uid ) {
			return Rest::err( 'taken', 'Another member proved that account first', 409 );
		}

		// Settle it, and CLEAR the verifier — a proven row keeps no secret material at all.
		Data::update( self::TABLE, [
			'state'        => 'verified',
			'nonce_hash'   => '',
			// Built here rather than via Kaggle::kernel_url(), which hardcodes OUR OWN account — this URL
			// has to name the member's. Rebuilt from the parsed parts, never echoed back from input, so
			// what we store is a URL we understand rather than whatever the member pasted.
			'proof_kernel' => mb_strcut( 'https://www.kaggle.com/code/' . $parsed['owner'] . '/' . $parsed['slug'], 0, 300 ),
			'verified_at'  => Data::now(),
		], [ 'id' => (int) $claim['id'] ] );

		return [ 'ok' => true, 'handle' => $h, 'state' => 'verified',
			'message' => 'kaggle.com/' . $h . ' is proven to be yours — you can submit its notebooks now' ];
	}

	// ── Helpers ─────────────────────────────────────────────────────────────

	/** Kaggle handles are case-insensitive; we store and compare one form. */
	private static function norm( $s ) {
		return strtolower( trim( (string) $s ) );
	}

	/** A cheap shape check so an obvious typo fails here rather than after a round trip to Kaggle.
	 *  Kaggle usernames are ASCII letters, digits and hyphens, and short — VARCHAR(120) is generous. */
	private static function plausible( $h ) {
		return '' !== $h && strlen( $h ) <= 120 && (bool) preg_match( '/^[a-z0-9][a-z0-9-]{1,79}$/', $h );
	}
}
