<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Identity verification — the "blue check".
 *
 * Two tiers of identity, both stored as PUBLIC user meta (radical transparency — full name + birthday
 * show on every profile and in /data/):
 *   1. IDENTITY (aq_full_name + aq_birthday, optionally aq_nationality): a member must set their real
 *      full name + birthday before they can create any post. Set freely (no cost, no proof). The
 *      nationality claim (ISO 3166-1 alpha-2) is additionally required before the blue check — never
 *      for posting.
 *   2. VERIFIED (aq_verified): the blue check. The member uploads a government ID (front + back), a
 *      selfie, and a profile photo; Claude (vision) confirms the ID is genuine, the name + birthday +
 *      nationality on it match what they entered, and the same face appears across the ID, the selfie,
 *      and the profile photo. On success the profile photo becomes their public avatar and the check is
 *      granted. Required to receive payouts; verifying is FREE — anyone can attempt it regardless of
 *      coin balance (ticket #109, maintainer-approved: the 1-coin-per-attempt fee was removed 2026-06).
 *
 * NATIONALITY FLAG (ticket #30, maintainer-approved): once verified, the member's country flag overlays
 * their avatar everywhere (badge_country — '' until verified, so an unverified claim never shows). The
 * verified nationality is PUBLIC user meta like the name + birthday. This stays true to the no-gating
 * principle below: EVERY nationality verifies identically and the flag is a display of a verified fact —
 * nothing anywhere grants or denies anything by country.
 *
 * PRIVACY / SAFETY — the hard line: the ID images and the selfie are BIOMETRIC / government-ID data and
 * are NEVER persisted. They exist only in memory for the single request, are sent to Claude for the
 * check, and are discarded when the request ends. Nothing is written to disk or the (public) DB except
 * the verdict, the (already-public) full name + birthday + nationality, and the profile photo (a public
 * avatar by nature). Because we verify with Claude directly — not a KYC vendor — this works for EVERY
 * country, including sanctioned ones (no vendor allow-list, no country gating anywhere in this flow).
 */
final class Verify {

	const MODEL      = 'claude-opus-5'; // the relay (subscription) vision model; the paid API was removed
	const MAXTOK     = 1024;
	const MIN_CONF   = 0.7;                 // overall confidence required to grant the check
	const MAX_BYTES  = 5 * 1024 * 1024;     // per-image cap (decoded)
	const MIN_AGE    = 13;
	const LAUNCH     = '2026-05-15 12:00:00'; // ArtaQuest's public launch (genesis, May 2026); the displayed join date is clamped to it — see joined_label(). Mid-month noon so the "F Y" label is timezone-stable, and below the earliest real registration so only pre-launch logins are corrected.

	// Every officially assigned ISO 3166-1 alpha-2 code — ALL of them, no allow-list (validation only,
	// never gating). The SPA renders the same list (src/lib/flags.ts) with localized names.
	const COUNTRIES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW';

	// ── public helpers (used by the gates elsewhere) ──────────────────────────
	public static function full_name( $uid ) { return trim( (string) get_user_meta( (int) $uid, 'aq_full_name', true ) ); }
	public static function birthday( $uid )  { return (string) get_user_meta( (int) $uid, 'aq_birthday', true ); }
	public static function nationality( $uid ) { return strtoupper( trim( (string) get_user_meta( (int) $uid, 'aq_nationality', true ) ) ); }
	public static function has_identity( $uid ) { return self::full_name( $uid ) !== '' && self::valid_birthday( self::birthday( $uid ) ); }
	public static function is_verified( $uid ) { return (int) get_user_meta( (int) $uid, 'aq_verified', true ) > 0; }

	/** True once this member has stated an EXACT, valid date of birth (operator 2026-07-25: every
	 *  account must carry one — see Rest::birthday_gate, which refuses every mutation until it does).
	 *  Deliberately narrower than has_identity(): that also demands the full name and gates POSTING,
	 *  so a failure there and a failure here stay distinguishable to the caller. */
	public static function has_birthday( $uid ) { return self::valid_birthday( self::birthday( $uid ) ); }

	/** valid_birthday() as a PUBLIC predicate — the exact-date rule (YYYY-MM-DD, a real calendar day,
	 *  not in the future, MIN_AGE…120) that every gate and emitter must agree on. */
	public static function is_exact_birthday( $s ) { return self::valid_birthday( $s ); }

	/** The member's PALM "back photo" URL, or '' if none (ticket #94). An OPT-IN self-verification
	 *  image shown on the BACK of their avatar (tap to flip) — public like the avatar, set freely via
	 *  /profile/palm, and entirely independent of the blue check. Every profile emitter ships it so the
	 *  SPA can flip the picture to it. */
	public static function palm_url( $uid ) { return (string) get_user_meta( (int) $uid, 'aq_palm_url', true ); }

	/**
	 * The member's ArtaQuest join label ("Month Year") for the profile header + rankings, CLAMPED to
	 * the platform launch (LAUNCH). It is otherwise formatted straight from WordPress's `user_registered`
	 * column — which is the age of the underlying WordPress.com LOGIN, not when the member joined
	 * ArtaQuest. A few accounts predate the platform: the founder's WordPress.com account is registered
	 * 2018-04-27, years before ArtaQuest launched in 2026, which made the profile read "Joined April 2018"
	 * (ticket #103). ArtaQuest didn't exist before it launched, so nobody could have joined it earlier —
	 * clamp the date to the launch month. Every real member registered after LAUNCH, so their month is
	 * untouched; only pre-launch legacy logins are corrected. Empty registration → '' (unknown).
	 */
	public static function joined_label( $user_registered ) {
		$user_registered = (string) $user_registered;
		if ( $user_registered === '' ) { return ''; }
		$ts = max( (int) strtotime( $user_registered ), (int) strtotime( self::LAUNCH ) );
		return date_i18n( 'F Y', $ts );
	}

	/** The PUBLIC avatar flag: the VERIFIED nationality (ISO 3166-1 alpha-2), or '' until the member is
	 *  verified. Every user-card emitter ships this so the SPA can overlay the flag on the avatar. */
	public static function badge_country( $uid ) {
		if ( ! self::is_verified( $uid ) ) { return ''; }
		$c = self::nationality( $uid );
		return self::valid_country( $c ) ? $c : '';
	}

	/** The nationality CLAIM as a validated ISO 3166-1 alpha-2 code, or '' — a self-entered identity
	 *  detail (set via /identity, no proof, already public in /data/), shown on the profile like the
	 *  birthday regardless of verification. Distinct from badge_country(): that gates the authoritative
	 *  AVATAR flag on the blue check (ticket #30); this only feeds a plain, labelled profile detail. */
	public static function claimed_country( $uid ) {
		$c = self::nationality( $uid );
		return self::valid_country( $c ) ? $c : '';
	}

	/** True for any officially assigned ISO 3166-1 alpha-2 code (case-insensitive input). */
	public static function valid_country( $c ) {
		$c = strtoupper( trim( (string) $c ) );
		return $c !== '' && in_array( $c, explode( ' ', self::COUNTRIES ), true );
	}

	/** Gate for post creation: a real name + birthday are mandatory before anyone can post. */
	public static function require_identity( $uid ) {
		if ( self::has_identity( $uid ) ) { return null; }
		return Rest::err( 'identity_required', 'Add your full name and birthday to your profile before posting.', 403 );
	}

	// ── status ────────────────────────────────────────────────────────────────
	/** GET /verify/status — the signed-in member's identity + verification state. */
	public static function status( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$ts = (int) get_user_meta( $uid, 'aq_verified', true );
		return [
			'full_name'    => self::full_name( $uid ),
			'birthday'     => self::birthday( $uid ),
			'nationality'  => self::nationality( $uid ),   // the CLAIM (flag only shows once verified)
			'gender'       => self::gender( $uid ),        // '' unless the member chose to say (ArtaCredits matching only)
			'has_identity' => self::has_identity( $uid ),
			'verified'     => $ts > 0,
			'verified_at'  => $ts,
			'last_note'    => (string) get_user_meta( $uid, 'aq_verify_note', true ),
			'configured'   => Relay::available(),
		];
	}

	// ── set identity (name + birthday + nationality) — required to post, no cost, no proof ───
	/** POST /identity {full_name, birthday, nationality?} — set/update the real name + birthday that
	 *  gate posting. `nationality` (ISO 3166-1 alpha-2) is optional here — posting never needs it —
	 *  but the blue check does; an omitted/empty value leaves the stored claim untouched. */
	public static function set_identity( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$name = sanitize_text_field( (string) Rest::p( $req, 'full_name', '' ) );
		$bday = self::norm_date( (string) Rest::p( $req, 'birthday', '' ) );
		$nat  = strtoupper( trim( sanitize_text_field( (string) Rest::p( $req, 'nationality', '' ) ) ) );
		if ( mb_strlen( $name ) < 2 ) { return Rest::err( 'bad_name', 'Enter your full name.' ); }
		if ( ! self::valid_birthday( $bday ) ) { return Rest::err( 'bad_birthday', 'Enter a valid birthday (you must be at least ' . self::MIN_AGE . ').' ); }
		// 'CLEAR' is the revocation sentinel — it must pass the validator, which rejects anything that
		// is not an ISO-3166 code. Without this exemption the revocation branch below is unreachable
		// dead code and the claim stays write-only, which is exactly what it was before.
		if ( $nat !== '' && $nat !== 'CLEAR' && ! self::valid_country( $nat ) ) { return Rest::err( 'bad_country', 'Pick your nationality from the list.' ); }
		// Editing identity after being verified invalidates the check (the verified facts changed).
		$nat_changed = $nat !== '' && $nat !== self::nationality( $uid );
		if ( self::is_verified( $uid ) && ( $name !== self::full_name( $uid ) || $bday !== self::birthday( $uid ) || $nat_changed ) ) {
			delete_user_meta( $uid, 'aq_verified' );
		}
		update_user_meta( $uid, 'aq_full_name', $name );
		if ( $bday !== self::birthday( $uid ) ) { self::stamp( $uid, 'aq_birthday' ); }
		update_user_meta( $uid, 'aq_birthday', $bday );
		// 'clear' REVOKES the nationality claim. Without it the claim was write-only: nothing anywhere
		// deleted it, so a member could state a nationality and never take it back — which makes the
		// "tell us only what you want to share" promise false, and matters more now that ArtaCredits
		// matches on it (Credits::buckets_for_user).
		if ( $nat === 'CLEAR' ) {
			// Revocation leaves NO trace. Writing a stamp here would publish, in a world-readable
			// usermeta row, that this member once claimed a nationality and when they took it back —
			// a worse disclosure than the claim. The settle gate stays correct because every SET
			// writes a fresh stamp, so a re-stated claim still has to stand for SETTLE_DAYS.
			delete_user_meta( $uid, 'aq_nationality' );
			delete_user_meta( $uid, 'aq_nationality_at' );
		} elseif ( $nat !== '' ) {
			if ( $nat_changed ) { self::stamp( $uid, 'aq_nationality' ); }
			update_user_meta( $uid, 'aq_nationality', $nat );
		}
		return [ 'ok' => true, 'full_name' => $name, 'birthday' => $bday, 'nationality' => self::nationality( $uid ), 'verified' => self::is_verified( $uid ) ];
	}

	/** Record WHEN a self-claimed identity facet last changed. Nationality, gender and birthday are all
	 *  freely rewritable, so anything that acts on them — ArtaCredits matching — must be able to tell a
	 *  long-standing statement from one typed thirty seconds ago to reach a waiting gift. The stamp is
	 *  public user meta like the facts themselves; it reveals only that something changed, never what. */
	public static function stamp( $uid, $meta ) {
		update_user_meta( (int) $uid, $meta . '_at', Data::now() );
	}

	/** A member's stated gender, or '' — the default. Opt-in, revocable, and NEVER inferred from a
	 *  name, a pronoun or anything else. Only the member writes it (set_gender below). */
	public static function gender( $uid ) {
		$g = (string) get_user_meta( (int) $uid, 'aq_gender', true );
		return isset( Credits::GENDERS[ $g ] ) ? $g : '';
	}

	/** POST /identity/gender {gender} — state it, change it, or send 'clear' to take it back. It is
	 *  used for exactly one thing: letting a donor's ArtaCredit find members it was given for. Saying
	 *  nothing is a complete answer — a member who never answers is matched on the axes they have
	 *  actually stated, and by every gift that names no gender at all. */
	public static function set_gender( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$g = sanitize_key( (string) Rest::p( $req, 'gender', '' ) );
		if ( $g === 'clear' || $g === '' ) {
			// Revocation leaves NO trace — see the nationality clear above. Deleting the stamp too
			// means the public database does not record that this member once answered and withdrew it.
			delete_user_meta( $uid, 'aq_gender' );
			delete_user_meta( $uid, 'aq_gender_at' );
			return [ 'ok' => true, 'gender' => '' ];
		}
		if ( ! isset( Credits::GENDERS[ $g ] ) ) { return Rest::err( 'bad_gender', 'Choose one of the listed answers, or clear it.' ); }
		if ( $g !== self::gender( $uid ) ) { self::stamp( $uid, 'aq_gender' ); }
		update_user_meta( $uid, 'aq_gender', $g );
		return [ 'ok' => true, 'gender' => $g ];
	}

	/** The member's saved "fine-tune" birth time (minutes past local midnight, 0–1439), or '' if unset. */
	public static function birth_min( $uid ) {
		$v = get_user_meta( (int) $uid, 'aq_birth_min', true );
		return ( '' === $v || false === $v ) ? '' : (string) (int) $v;
	}

	/** POST /identity/birthtime {min} — save the member's chosen "fine-tune" birth time (minutes past local
	 *  midnight). It's a personal tuning that positions their long-term goal (Pluto) in the chosen field of
	 *  life; stored like the other identity facts so it follows them across devices. */
	public static function set_birthtime( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$min = (int) Rest::p( $req, 'min', 600 );
		if ( $min < 0 ) { $min = 0; }
		if ( $min > 1439 ) { $min = 1439; }
		update_user_meta( $uid, 'aq_birth_min', $min );
		return [ 'ok' => true, 'min' => $min ];
	}

	// ── verify (blue check) ─────────────────────────────────────────────────────
	/**
	 * POST /verify/identity {profile_pic, id_front, id_back, selfie} (all base64 data URLs).
	 * Uses the member's already-set full name + birthday + nationality as the claim, asks Claude to
	 * confirm the ID, grants the check on success, and ALWAYS discards the ID + selfie images.
	 * Free — no coin cost (ticket #109; the 1-coin-per-attempt fee was removed).
	 */
	public static function verify_identity( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		if ( Rest::throttle( 'verify_id', 8, 3600 ) ) { return Rest::err( 'rate_limited', 'Too many attempts. Try again later.', 429 ); }
		if ( ! Relay::available() ) { return Rest::err( 'offline', 'Verification is temporarily unavailable — please try again shortly.', 503 ); }
		if ( ! self::has_identity( $uid ) ) { return Rest::err( 'identity_required', 'Set your full name and birthday first.', 400 ); }
		if ( ! self::valid_country( self::nationality( $uid ) ) ) { return Rest::err( 'nationality_required', 'Pick your nationality first — verification checks it against your ID.', 400 ); }

		// Decode the four images IN MEMORY. They are never written anywhere (the ID + selfie especially).
		$profile = self::parse_image( (string) Rest::p( $req, 'profile_pic', '' ) );
		$front   = self::parse_image( (string) Rest::p( $req, 'id_front', '' ) );
		$back    = self::parse_image( (string) Rest::p( $req, 'id_back', '' ) );
		$selfie  = self::parse_image( (string) Rest::p( $req, 'selfie', '' ) );
		foreach ( [ 'profile photo' => $profile, 'ID front' => $front, 'ID back' => $back, 'selfie' => $selfie ] as $label => $img ) {
			if ( $img === null ) { return Rest::err( 'bad_image', 'Please attach a clear JPG/PNG/WebP for the ' . $label . ' (under 5 MB).' ); }
		}

		$verdict = self::run_claude( self::full_name( $uid ), self::birthday( $uid ), self::nationality( $uid ), $profile, $front, $back, $selfie );
		// Free the image bytes the moment the check is done — defence-in-depth on top of never persisting.
		$profile_bytes = $profile['bytes']; $profile_mime = $profile['mime'];
		unset( $front, $back, $selfie, $profile );

		if ( $verdict === null ) {
			// Upstream failure (couldn't reach Claude / unparseable) — not the member's fault; just retry.
			return Rest::err( 'upstream', 'The verification service hit a snag — please try again.', 502 );
		}

		$ok = ! empty( $verdict['verified'] );
		if ( $ok ) {
			// Canonicalise the public name + birthday + nationality to what's actually on the ID (the
			// source of truth).
			$name = sanitize_text_field( (string) ( $verdict['name_on_id'] ?: self::full_name( $uid ) ) );
			$dob  = self::norm_date( (string) ( $verdict['dob_on_id'] ?: self::birthday( $uid ) ) );
			$ctry = strtoupper( trim( (string) ( $verdict['country_on_id'] ?? '' ) ) );
			if ( $name !== '' ) { update_user_meta( $uid, 'aq_full_name', $name ); }
			if ( self::valid_birthday( $dob ) ) { update_user_meta( $uid, 'aq_birthday', $dob ); }
			if ( self::valid_country( $ctry ) ) { update_user_meta( $uid, 'aq_nationality', $ctry ); }
			self::set_avatar( $uid, $profile_bytes, $profile_mime ); // the verified profile photo → public avatar
			update_user_meta( $uid, 'aq_verified', time() );
			update_user_meta( $uid, 'aq_verify_note', '' );
			Notify::push( $uid, 'security', 'You\'re verified', 'Your identity was confirmed — your profile now carries the blue check with your country\'s flag on your picture, and cash-out is unlocked.', '/account/' );
		} else {
			delete_user_meta( $uid, 'aq_verified' );
			$reason = sanitize_text_field( (string) ( $verdict['reason'] ?: 'We couldn\'t confirm a match.' ) );
			update_user_meta( $uid, 'aq_verify_note', $reason );
		}
		unset( $profile_bytes ); // discard the profile bytes too once stored/decided

		return [
			'ok'       => true,
			'verified' => $ok,
			'reason'   => $ok ? 'Verified — welcome to the blue check.' : (string) get_user_meta( $uid, 'aq_verify_note', true ),
		];
	}

	// ── Claude vision verdict ───────────────────────────────────────────────────
	/** Ask Claude to verify the ID + selfie + profile photo against the claimed name + birthday +
	 *  nationality. Returns the parsed verdict array, or null on an upstream/parse failure. */
	private static function run_claude( $name, $birthday, $nationality, $profile, $front, $back, $selfie ) {
		// Test seam: the harness can force a verdict (or an upstream failure via the string 'fail')
		// to exercise the success/failure handling without fabricating a real government ID.
		$mock = apply_filters( 'aq_verify_verdict', null, $name, $birthday, $nationality );
		if ( $mock === 'fail' ) { return null; }
		if ( is_array( $mock ) ) {
			$mock['verified'] = ! empty( $mock['genuine_id'] ) && ! empty( $mock['name_match'] ) && ! empty( $mock['dob_match'] )
				&& ! empty( $mock['nationality_match'] )
				&& ! empty( $mock['selfie_matches_id'] ) && ! empty( $mock['profile_matches'] )
				&& (float) ( $mock['confidence'] ?? 0 ) >= self::MIN_CONF;
			return $mock;
		}
		$system = implode( "\n", [
			'You are an identity-verification examiner for ArtaQuest. You will be shown four images and a CLAIMED full name, birthday, and nationality. Decide whether to grant a verified badge.',
			'The four images, in order, are labelled: PROFILE PHOTO, GOVERNMENT ID FRONT, GOVERNMENT ID BACK, SELFIE.',
			'Government IDs from ANY country are acceptable (passport, national ID, driver licence, residence card, etc.) — never reject based on the issuing country, language, or script. Read names/dates in any language or script.',
			'Assess, independently:',
			'1) genuine_id: do the FRONT and BACK together look like a real government-issued photo ID (not a screen photo of a photo, not obviously edited, has a portrait + machine/printed data)?',
			'2) name_match: does the name on the ID match the CLAIMED full name? Allow ordering, capitalisation, accents, middle names/initials, and transliteration differences. Read name_on_id off the ID.',
			'3) dob_match: does the date of birth on the ID match the CLAIMED birthday (same calendar date)? Read dob_on_id off the ID in strict YYYY-MM-DD.',
			'4) nationality_match: does the nationality on the ID match the CLAIMED nationality (an ISO 3166-1 alpha-2 code)? Use the ID\'s nationality/citizenship field when it has one (passports, national IDs); when it doesn\'t (most driver licences), use the issuing country. EVERY nationality is equally acceptable — this gate only checks the claim is accurate, never which country it is. Report country_on_id as the ISO 3166-1 alpha-2 code you read.',
			'5) selfie_matches_id: is the SELFIE the same person as the ID portrait?',
			'6) profile_matches: is the PROFILE PHOTO the same person as the SELFIE / ID portrait (a clear photo of that person\'s face)?',
			'Be careful but fair. Give a confidence 0-1 for the overall decision.',
			'Reply with ONLY a single minified JSON object, no prose, exactly these keys:',
			'{"genuine_id":bool,"name_match":bool,"dob_match":bool,"nationality_match":bool,"selfie_matches_id":bool,"profile_matches":bool,"name_on_id":string,"dob_on_id":"YYYY-MM-DD","country_on_id":"XX","confidence":number,"reason":string}',
			'"reason" is one short sentence a member can read (no PII beyond what they submitted). Set "verified" yourself is NOT needed — we compute it.',
		] );
		$content = [
			[ 'type' => 'text', 'text' => "CLAIMED full name: {$name}\nCLAIMED birthday (YYYY-MM-DD): {$birthday}\nCLAIMED nationality (ISO 3166-1 alpha-2): {$nationality}\n\nImages follow in this order:" ],
			[ 'type' => 'text', 'text' => 'PROFILE PHOTO:' ],          self::block( $profile ),
			[ 'type' => 'text', 'text' => 'GOVERNMENT ID FRONT:' ],    self::block( $front ),
			[ 'type' => 'text', 'text' => 'GOVERNMENT ID BACK:' ],     self::block( $back ),
			[ 'type' => 'text', 'text' => 'SELFIE:' ],                 self::block( $selfie ),
		];
		// SUBSCRIPTION-ONLY (operator rule 2026-06-13): the verdict runs on the Claude Max subscription
		// via the relay (the paid API was removed). The relay pulls the four ID images out of the
		// transcript, AES-encrypts them with the worker token (never readable in the public DB), and the
		// laptop daemon decrypts them to a private temp dir, Reads each, and replies — the ID + selfie
		// still never persist anywhere. Relay unavailable/slow → null → the endpoint says "try again".
		$via = Relay::ask( [ [ 'role' => 'user', 'content' => $content ] ], $system, self::MODEL, self::MAXTOK, 'max' ); // ArtaVerify ID vision is accuracy-critical → max effort
		if ( $via === Relay::BUSY || ! is_array( $via ) ) { return null; }
		$text = (string) ( $via['text'] ?? '' );
		if ( ! preg_match( '/\{.*\}/s', $text, $m ) ) { return null; }
		$v = json_decode( $m[0], true );
		if ( ! is_array( $v ) ) { return null; }
		// Compute the overall decision ourselves — every gate must pass + confidence ≥ threshold.
		$v['verified'] = ! empty( $v['genuine_id'] ) && ! empty( $v['name_match'] ) && ! empty( $v['dob_match'] )
			&& ! empty( $v['nationality_match'] )
			&& ! empty( $v['selfie_matches_id'] ) && ! empty( $v['profile_matches'] )
			&& (float) ( $v['confidence'] ?? 0 ) >= self::MIN_CONF;
		return $v;
	}

	private static function block( $img ) {
		return [ 'type' => 'image', 'source' => [ 'type' => 'base64', 'media_type' => $img['mime'], 'data' => base64_encode( $img['bytes'] ) ] ];
	}

	// ── images ──────────────────────────────────────────────────────────────────
	/** Parse a base64 data URL → [ 'mime'=>…, 'bytes'=>… ]; null if not a valid small image. */
	private static function parse_image( $dataurl ) {
		if ( ! preg_match( '#^data:(image/(?:jpeg|jpg|png|webp));base64,#i', $dataurl, $m ) ) { return null; }
		$bytes = base64_decode( substr( $dataurl, strlen( $m[0] ) ), true );
		if ( $bytes === false || strlen( $bytes ) < 64 || strlen( $bytes ) > self::MAX_BYTES ) { return null; }
		$mime = strtolower( $m[1] ) === 'image/jpg' ? 'image/jpeg' : strtolower( $m[1] );
		return [ 'mime' => $mime, 'bytes' => $bytes ];
	}

	/** Persist a profile photo as the member's public avatar (replaces any prior one). Returns the URL ('' on failure). */
	private static function set_avatar( $uid, $bytes, $mime ) {
		$ext  = $mime === 'image/png' ? 'png' : ( $mime === 'image/webp' ? 'webp' : 'jpg' );
		$prev = (string) get_user_meta( $uid, 'aq_avatar_file', true );
		if ( $prev && @file_exists( $prev ) ) { @unlink( $prev ); }
		$res = wp_upload_bits( 'aq-avatar-' . $uid . '-' . time() . '.' . $ext, null, $bytes );
		if ( ! empty( $res['error'] ) || empty( $res['url'] ) ) { return ''; }
		update_user_meta( $uid, 'aq_avatar_url', esc_url_raw( $res['url'] ) );
		update_user_meta( $uid, 'aq_avatar_file', $res['file'] );
		return (string) $res['url'];
	}

	/**
	 * POST /profile/photo {image} — set JUST the public avatar, no identity check.
	 * Changing your picture is a trivial goal; it must NOT require the full ID-verify
	 * flow (4 photos + 1 coin + AI). The blue check verifies name + birthday + that
	 * you're a real person and is INDEPENDENT of the avatar, so a photo swap leaves
	 * `aq_verified` untouched. Any signed-in member, one request, free.
	 */
	public static function set_photo( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		if ( Rest::throttle( 'set_photo', 12, 3600 ) ) { return Rest::err( 'rate_limited', 'Too many changes. Try again later.', 429 ); }
		$img = self::parse_image( (string) Rest::p( $req, 'image', '' ) );
		if ( $img === null ) { return Rest::err( 'bad_image', 'Please choose a clear JPG, PNG or WebP under 5 MB.' ); }
		$url = self::set_avatar( $uid, $img['bytes'], $img['mime'] );
		if ( $url === '' ) { return Rest::err( 'upload_failed', 'Could not save that image — please try another.', 500 ); }
		return [ 'ok' => true, 'avatar' => $url ];
	}

	/**
	 * POST /profile/palm {image} | {remove:true} — set or clear the member's PALM "back photo"
	 * (ticket #94): an OPT-IN image of their open palm, shown on the back of their profile picture
	 * (tap the avatar to flip). It is a human, self-chosen "I'm a real person" signal and is
	 * deliberately SEPARATE from the blue check — it never touches `aq_verified`, costs nothing, and
	 * runs no AI. Public like the face avatar (a photo the member chose to upload). Any signed-in member.
	 */
	public static function set_palm_photo( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		if ( Rest::throttle( 'set_palm', 12, 3600 ) ) { return Rest::err( 'rate_limited', 'Too many changes. Try again later.', 429 ); }
		if ( Rest::p( $req, 'remove', '' ) ) {           // take it down — clear the meta + delete the file
			self::clear_palm( $uid );
			return [ 'ok' => true, 'palm' => '' ];
		}
		$img = self::parse_image( (string) Rest::p( $req, 'image', '' ) );
		if ( $img === null ) { return Rest::err( 'bad_image', 'Please choose a clear JPG, PNG or WebP under 5 MB.' ); }
		$url = self::set_palm( $uid, $img['bytes'], $img['mime'] );
		if ( $url === '' ) { return Rest::err( 'upload_failed', 'Could not save that image — please try another.', 500 ); }
		return [ 'ok' => true, 'palm' => $url ];
	}

	/** Persist a palm "back photo" as public user meta (replaces any prior one). URL ('' on failure). */
	private static function set_palm( $uid, $bytes, $mime ) {
		$ext  = $mime === 'image/png' ? 'png' : ( $mime === 'image/webp' ? 'webp' : 'jpg' );
		$prev = (string) get_user_meta( $uid, 'aq_palm_file', true );
		if ( $prev && @file_exists( $prev ) ) { @unlink( $prev ); }
		$res = wp_upload_bits( 'aq-palm-' . $uid . '-' . time() . '.' . $ext, null, $bytes );
		if ( ! empty( $res['error'] ) || empty( $res['url'] ) ) { return ''; }
		update_user_meta( $uid, 'aq_palm_url', esc_url_raw( $res['url'] ) );
		update_user_meta( $uid, 'aq_palm_file', $res['file'] );
		return (string) $res['url'];
	}

	/** Remove the palm "back photo" entirely — delete the file and clear both meta keys. */
	private static function clear_palm( $uid ) {
		$prev = (string) get_user_meta( $uid, 'aq_palm_file', true );
		if ( $prev && @file_exists( $prev ) ) { @unlink( $prev ); }
		delete_user_meta( $uid, 'aq_palm_url' );
		delete_user_meta( $uid, 'aq_palm_file' );
	}

	/** Swap our stored avatar in for the gravatar default, everywhere get_avatar(_url) is used. */
	public static function filter_avatar( $args, $id_or_email ) {
		$uid = self::resolve_uid( $id_or_email );
		if ( $uid ) {
			$url = (string) get_user_meta( $uid, 'aq_avatar_url', true );
			if ( $url !== '' ) { $args['url'] = $url; }
		}
		return $args;
	}

	/**
	 * Avatar URL for the JSON API — a member's uploaded photo, a genuine gravatar, or '' so the SPA
	 * draws its initial-disc fallback instead of an empty ring (ticket #113). The site's
	 * avatar_default is 'blank', so a bare get_avatar_url() hands back a transparent d=blank gravatar
	 * PNG for the (many) members who never set a picture: it loads with no error, leaving an empty
	 * circle. Asking for d=404 makes gravatar 404 when there is genuinely no image, which trips the
	 * <img> onError → the brand initial disc. Members who DO have a gravatar — or an uploaded
	 * aq_avatar_url, which filter_avatar() swaps in whatever the default — are unaffected. Use this
	 * for every avatar an endpoint emits so the fallback is uniform everywhere avatars appear.
	 */
	public static function avatar_url( $uid, $size = 96 ) {
		$uid = (int) $uid;
		if ( $uid <= 0 ) { return ''; }
		// No uploaded picture → the member's SEASON SIGIL (the dozenal-numeral emblem of their one
		// subscribed season — operator directive 2026-07-10) becomes their profile picture on every
		// surface. An uploaded aq_avatar_url still wins (user-managed pictures are never replaced);
		// members with no season on record (no birthday, no subscription) keep the legacy
		// gravatar-or-initial fallback.
		if ( '' === (string) get_user_meta( $uid, 'aq_avatar_url', true ) ) {
			// A single-select typology pick (e.g. "which Rick and Morty character do you like
			// most?") becomes the profile picture, the same slot the season sigil fills — the
			// member chose it, an uploaded photo still wins, and it's changeable any time.
			$pick = (string) get_user_meta( $uid, 'aq_typology_pic', true );
			if ( $pick !== '' ) { return $pick; }
			$sigil = Seasons::sigil_url( Seasons::of_user( $uid ) );
			if ( $sigil ) { return $sigil; }
		}
		return (string) get_avatar_url( $uid, [ 'size' => $size, 'default' => '404' ] );
	}
	private static function resolve_uid( $id_or_email ) {
		if ( is_numeric( $id_or_email ) ) { return (int) $id_or_email; }
		if ( $id_or_email instanceof \WP_User ) { return (int) $id_or_email->ID; }
		if ( $id_or_email instanceof \WP_Comment ) {
			if ( $id_or_email->user_id ) { return (int) $id_or_email->user_id; }
			$u = $id_or_email->comment_author_email ? get_user_by( 'email', $id_or_email->comment_author_email ) : null;
			return $u ? (int) $u->ID : 0;
		}
		if ( is_string( $id_or_email ) && is_email( $id_or_email ) ) {
			$u = get_user_by( 'email', $id_or_email ); return $u ? (int) $u->ID : 0;
		}
		return 0;
	}

	// ── date helpers ──────────────────────────────────────────────────────────────
	/**
	 * A date of birth must be EXACT — one specific calendar day the member actually names.
	 *
	 * This used to fall back to strtotime(), which does not fail on a partial or relative input: it
	 * INVENTS the missing parts from today. "1994" became 1994-07-25, "February 1994" became
	 * 1994-02-01, "-13 years" became exactly the youngest permitted birthday — and every one of those
	 * fabrications then sailed through valid_birthday() and was stored, published on the member's
	 * profile, and read as fact by Seasons::for_birthday and the natal chart. A wrong day that
	 * looks exact is worse than no day at all, so there is no fallback any more: anything that is
	 * not a complete YYYY-MM-DD is rejected outright, and set_identity answers `bad_birthday`.
	 *
	 * Both callers already speak this form — the SPA sends an <input type="date"> value, and the
	 * blue-check prompt demands "strict YYYY-MM-DD" of the vision model.
	 */
	private static function norm_date( $s ) {
		$s = trim( (string) $s );
		return preg_match( '/^(\d{4})-(\d{2})-(\d{2})$/', $s, $m ) ? "{$m[1]}-{$m[2]}-{$m[3]}" : '';
	}
	private static function valid_birthday( $s ) {
		if ( ! preg_match( '/^(\d{4})-(\d{2})-(\d{2})$/', (string) $s, $m ) ) { return false; }
		if ( ! checkdate( (int) $m[2], (int) $m[3], (int) $m[1] ) ) { return false; }
		$ts = strtotime( $s );
		if ( $ts === false || $ts > time() ) { return false; }
		$age = (int) gmdate( 'Y', time() ) - (int) $m[1];
		if ( gmdate( 'md', time() ) < $m[2] . $m[3] ) { $age--; }
		return $age >= self::MIN_AGE && $age <= 120;
	}
}
