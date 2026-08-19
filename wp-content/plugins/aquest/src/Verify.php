<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Identity verification — the "blue check".
 *
 * Two tiers of identity, all of it stored as PUBLIC user meta (radical transparency — the full name,
 * the date of birth and the nationality show on every profile and in /data/):
 *   1. IDENTITY (aq_full_name + aq_birthday, and aq_nationality): a member states their real name,
 *      an exact date of birth and their nationality (ISO 3166-1 alpha-2). No proof, no cost — the
 *      gate is that the fields are filled in. Name + date are what gate POSTING (has_identity);
 *      the nationality is asked at sign-up, defaulted from the visitor's country, shows as the
 *      country's FLAG on the public profile, and is required before the blue check.
 *   2. THE BLUE CHECK (optional): four photos — profile picture, government ID front and back, and a
 *      selfie — go to Claude, which decides whether the ID is genuine, whether the NAME (given name
 *      and surname), the DATE OF BIRTH and the NATIONALITY on it match what the member stated, and
 *      whether the same face appears across the ID, the selfie and the profile photo. Those THREE
 *      facts are the whole check.
 *
 * ANY government photo ID from ANY country is accepted — passport, national ID, driver licence,
 * residence permit — read in any language or script. EVERY nationality verifies identically: the
 * examiner checks only that the claim is accurate, never which country it names, and nothing
 * anywhere grants or denies anything by country.
 *
 * HISTORY, so nobody relitigates it from the diff: nationality was collected, published and checked
 * from the start; on 2026-08-11 the operator removed it (and place of birth) as a disclosure nothing
 * needed; on 2026-08-18 the operator brought nationality back — asked at sign-up, defaulted from
 * the visitor's IP country, shown as a flag on the profile, checked by the blue check, and the axis
 * an ArtaCredits donor may aim a gift at (it replaced gender there, which is now gone from the
 * platform entirely). Place of birth stayed removed.
 *
 * The ID and selfie images are NEVER persisted — decoded in memory, sent for the verdict, freed. What
 * survives is the verdict, the (already-public) name, date of birth and nationality, and the
 * profile photo.
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
	/** The stored nationality claim, upper-cased, UNVALIDATED ('' when none). Prefer claimed_country()
	 *  for anything shown or emitted — it refuses a value that is not an ISO 3166-1 alpha-2 code. */
	public static function nationality( $uid ) { return strtoupper( trim( (string) get_user_meta( (int) $uid, 'aq_nationality', true ) ) ); }

	// Full name + a valid date of birth. That is the POSTING gate (Rest::birthday_gate refuses every
	// mutation without the date). Nationality is deliberately NOT part of it: it is asked at sign-up
	// and required for the blue check, but a legacy account without one must not be locked out of
	// posting for a fact the operator has set by hand for every existing member.
	public static function has_identity( $uid ) { return self::full_name( $uid ) !== '' && self::valid_birthday( self::birthday( $uid ) ); }
	public static function is_verified( $uid ) { return (int) get_user_meta( (int) $uid, 'aq_verified', true ) > 0; }

	/** True for any officially assigned ISO 3166-1 alpha-2 code (case-insensitive input). */
	public static function valid_country( $c ) {
		$c = strtoupper( trim( (string) $c ) );
		return $c !== '' && in_array( $c, explode( ' ', self::COUNTRIES ), true );
	}

	/** The nationality the member STATED, as a validated ISO 3166-1 alpha-2 code, or '' — the value
	 *  every public surface shows: the flag on the profile picture, the "Nationality" fact on the
	 *  profile, window.AQ_USER, /verify/status. A claim, like the date of birth beside it; the blue
	 *  check beside the name is what says the ID agreed with it. */
	public static function claimed_country( $uid ) {
		$c = self::nationality( $uid );
		return self::valid_country( $c ) ? $c : '';
	}

	/** The nationality as CONFIRMED by the blue check — '' until the member is verified. Kept as its
	 *  own predicate so a caller that wants the ID-backed fact (a payout, an audit) can ask for it
	 *  and never mistake a claim for it. verify_identity() canonicalises aq_nationality to the ID's
	 *  country on success, so once verified the two agree by construction. */
	public static function badge_country( $uid ) {
		return self::is_verified( $uid ) ? self::claimed_country( $uid ) : '';
	}

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

	/** Gate for post creation: a real name + birthday are mandatory before anyone can post. */
	public static function require_identity( $uid ) {
		if ( self::has_identity( $uid ) ) { return null; }
		return Rest::err( 'identity_required', 'Add your full name and date of birth to your profile before posting.', 403 );
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
			'nationality'  => self::claimed_country( $uid ), // the stated claim (ISO 3166-1 alpha-2), '' until stated
			'has_identity' => self::has_identity( $uid ),
			'verified'     => $ts > 0,
			'verified_at'  => $ts,
			'last_note'    => (string) get_user_meta( $uid, 'aq_verify_note', true ),
			'configured'   => Relay::available(),
		];
	}

	// ── set identity (name + date of birth + nationality) — required to post, no cost, no proof ───
	/** POST /identity {full_name, birthday, nationality} — the real name + date of birth that gate
	 *  posting, and the nationality (ISO 3166-1 alpha-2) that shows as a flag on the profile and is
	 *  checked by the blue check.
	 *
	 *  NATIONALITY IS REQUIRED UNTIL THE ACCOUNT HAS ONE, then optional: an omitted or empty value
	 *  leaves the stored claim untouched. That is what lets a form that only edits the name keep
	 *  working, an older client keep working, and a first-time member never slip through without one.
	 *  There is no revocation sentinel: like the date of birth, this is a stated identity fact — a
	 *  member changes it, they do not blank it (operator 2026-08-18; between 08-11 and 08-18 this
	 *  handler DELETED aq_nationality on every call — see the class doc for the history).
	 *
	 *  Place of birth stays gone: its meta is still purged here so a value written before 08-11 is
	 *  not left published with no surface to take it back from. Gender went the same way on 08-18. */
	public static function set_identity( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$name = sanitize_text_field( (string) Rest::p( $req, 'full_name', '' ) );
		$bday = self::norm_date( (string) Rest::p( $req, 'birthday', '' ) );
		$nat  = strtoupper( trim( sanitize_text_field( (string) Rest::p( $req, 'nationality', '' ) ) ) );
		if ( mb_strlen( $name ) < 2 ) { return Rest::err( 'bad_name', 'Enter your full name.' ); }
		if ( ! self::valid_birthday( $bday ) ) { return Rest::err( 'bad_birthday', 'Enter a valid birthday (you must be at least ' . self::MIN_AGE . ').' ); }
		if ( $nat !== '' && ! self::valid_country( $nat ) ) { return Rest::err( 'bad_country', 'Pick your nationality from the list.' ); }
		if ( $nat === '' && self::claimed_country( $uid ) === '' ) { return Rest::err( 'bad_country', 'Choose your nationality — it shows as your country\'s flag on your profile.' ); }
		$prev        = self::claimed_country( $uid );
		$nat_changed = $nat !== '' && $nat !== $prev;
		// Editing identity after being verified invalidates the check (the verified facts changed).
		// The nationality counts only when a stated one is REPLACED: a check granted since 2026-08-18
		// canonicalised the claim to the ID, so changing it afterwards contradicts the ID and the check
		// must go — but a member verified before that date, when the check read only the name and the
		// date, has no claim on record, and their FIRST statement contradicts nothing. Revoking on it
		// would strip a valid check the moment they filled in a field the form now marks required.
		if ( self::is_verified( $uid ) && ( $name !== self::full_name( $uid ) || $bday !== self::birthday( $uid ) || ( $nat_changed && $prev !== '' ) ) ) {
			delete_user_meta( $uid, 'aq_verified' );
		}
		update_user_meta( $uid, 'aq_full_name', $name );
		if ( $bday !== self::birthday( $uid ) ) { self::stamp( $uid, 'aq_birthday' ); }
		update_user_meta( $uid, 'aq_birthday', $bday );
		if ( $nat !== '' ) {
			// Stamp only a CHANGE (a first statement included), never a re-save of the same value: the
			// stamp is what makes an ArtaCredits facet wait SETTLE_DAYS, and a member re-saving their
			// unchanged profile must not reset that clock.
			if ( $nat_changed ) { self::stamp( $uid, 'aq_nationality' ); }
			update_user_meta( $uid, 'aq_nationality', $nat );
		}
		// Retired facets are DELETED here, not merely ignored: dropping a field while leaving its meta
		// in place would keep publishing it, in a database served in full at /data/, with no surface
		// left to take it back from. Place of birth (removed 2026-08-11) and gender (removed 2026-08-18,
		// when nationality replaced it as the ArtaCredits axis).
		delete_user_meta( $uid, 'aq_birthplace' );
		delete_user_meta( $uid, 'aq_birthplace_geo' );
		delete_user_meta( $uid, 'aq_gender' );
		delete_user_meta( $uid, 'aq_gender_at' );
		return [ 'ok' => true, 'full_name' => $name, 'birthday' => $bday, 'nationality' => self::claimed_country( $uid ), 'verified' => self::is_verified( $uid ) ];
	}

	/** Record WHEN a self-claimed identity facet last changed. Nationality and birthday are freely
	 *  rewritable, so anything that acts on them — ArtaCredits matching — must be able to tell a
	 *  long-standing statement from one typed thirty seconds ago to reach a waiting gift. The stamp is
	 *  public user meta like the facts themselves; it reveals only that something changed, never what. */
	public static function stamp( $uid, $meta ) {
		update_user_meta( (int) $uid, $meta . '_at', Data::now() );
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
	 * Uses the member's already-set full name + date of birth + nationality as the claim, asks Claude
	 * to confirm the ID, grants the check on success, and ALWAYS discards the ID + selfie images.
	 * Free — no coin cost (ticket #109; the 1-coin-per-attempt fee was removed).
	 */
	public static function verify_identity( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		if ( Rest::throttle( 'verify_id', 8, 3600 ) ) { return Rest::err( 'rate_limited', 'Too many attempts. Try again later.', 429 ); }
		if ( ! Relay::available() ) { return Rest::err( 'offline', 'Verification is temporarily unavailable — please try again shortly.', 503 ); }
		if ( ! self::has_identity( $uid ) ) { return Rest::err( 'identity_required', 'Set your full name and date of birth first.', 400 ); }
		if ( self::claimed_country( $uid ) === '' ) { return Rest::err( 'nationality_required', 'Choose your nationality first — verification checks it against your ID.', 400 ); }

		// Decode the four images IN MEMORY. They are never written anywhere (the ID + selfie especially).
		$profile = self::parse_image( (string) Rest::p( $req, 'profile_pic', '' ) );
		$front   = self::parse_image( (string) Rest::p( $req, 'id_front', '' ) );
		$back    = self::parse_image( (string) Rest::p( $req, 'id_back', '' ) );
		$selfie  = self::parse_image( (string) Rest::p( $req, 'selfie', '' ) );
		foreach ( [ 'profile photo' => $profile, 'ID front' => $front, 'ID back' => $back, 'selfie' => $selfie ] as $label => $img ) {
			if ( $img === null ) { return Rest::err( 'bad_image', 'Please attach a clear JPG/PNG/WebP for the ' . $label . ' (under 5 MB).' ); }
		}

		$verdict = self::run_claude( self::full_name( $uid ), self::birthday( $uid ), self::claimed_country( $uid ), $profile, $front, $back, $selfie );
		// Free the image bytes the moment the check is done — defence-in-depth on top of never persisting.
		$profile_bytes = $profile['bytes']; $profile_mime = $profile['mime'];
		unset( $front, $back, $selfie, $profile );

		if ( $verdict === null ) {
			// Upstream failure (couldn't reach Claude / unparseable) — not the member's fault; just retry.
			return Rest::err( 'upstream', 'The verification service hit a snag — please try again.', 502 );
		}

		$ok = ! empty( $verdict['verified'] );
		if ( $ok ) {
			// Canonicalise the public name + date of birth + nationality to what is actually ON THE ID —
			// the document is the source of truth, so a member who typed a nickname, a wrong year or the
			// wrong country ends up with what they can prove. Nothing else is read off the ID and nothing
			// else is stored from it. The stamp is NOT touched: a canonicalisation is not the member
			// rewriting a facet, so it must not restart the ArtaCredits settle clock.
			$name = sanitize_text_field( (string) ( $verdict['name_on_id'] ?: self::full_name( $uid ) ) );
			$dob  = self::norm_date( (string) ( $verdict['dob_on_id'] ?: self::birthday( $uid ) ) );
			$ctry = strtoupper( trim( (string) ( $verdict['country_on_id'] ?? '' ) ) );
			if ( $name !== '' ) { update_user_meta( $uid, 'aq_full_name', $name ); }
			if ( self::valid_birthday( $dob ) ) { update_user_meta( $uid, 'aq_birthday', $dob ); }
			if ( self::valid_country( $ctry ) ) { update_user_meta( $uid, 'aq_nationality', $ctry ); }
			self::set_avatar( $uid, $profile_bytes, $profile_mime ); // the verified profile photo → public avatar
			update_user_meta( $uid, 'aq_verified', time() );
			update_user_meta( $uid, 'aq_verify_note', '' );
			Notify::push( $uid, 'security', 'You\'re verified', 'Your name, date of birth and nationality were confirmed against your ID — your profile now carries the blue check beside your country\'s flag, and cash-out is unlocked.', '/account/' );
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
	/** Ask Claude whether the ID + selfie + profile photo bear out the claimed name, date of birth and
	 *  nationality. THREE facts, checked against ANY government photo ID. Returns the verdict, or
	 *  null upstream. */
	private static function run_claude( $name, $birthday, $nationality, $profile, $front, $back, $selfie ) {
		// Test seam: the harness can force a verdict (or an upstream failure via the string 'fail')
		// to exercise the success/failure handling without fabricating a real government ID.
		$mock = apply_filters( 'aq_verify_verdict', null, $name, $birthday, $nationality );
		if ( $mock === 'fail' ) { return null; }
		if ( is_array( $mock ) ) {
			$mock['verified'] = self::decide( $mock );
			return $mock;
		}
		$system = implode( "\n", [
			'You are an identity-verification examiner for ArtaQuest. You will be shown four images and a CLAIMED full name, date of birth and nationality. Decide whether to grant a verified badge.',
			'The four images, in order, are labelled: PROFILE PHOTO, GOVERNMENT ID FRONT, GOVERNMENT ID BACK, SELFIE.',
			'ANY government-issued photo ID is acceptable, from any country: passport, national ID card, driver licence, residence permit, military or government employee card. Never reject one for its issuing country, its language or its script, and never require a particular document type. Read names and dates in any language, script or calendar, converting to the Gregorian calendar where needed.',
			'Assess, independently:',
			'1) genuine_id: do the FRONT and BACK together look like a real government-issued photo ID (not a screen photo of a photo, not obviously edited, has a portrait + machine/printed data)?',
			'2) name_match: does the name on the ID — given name(s) AND surname — match the CLAIMED full name? Allow ordering, capitalisation, accents, middle names/initials, and transliteration differences. Read name_on_id off the ID.',
			'3) dob_match: does the date of birth on the ID match the CLAIMED birthday (same calendar date)? Read dob_on_id off the ID in strict YYYY-MM-DD.',
			'4) nationality_match: does the ID ESTABLISH the CLAIMED nationality (an ISO 3166-1 alpha-2 code)? Read it from the document\'s own nationality/citizenship field when it has one (passports; many national ID cards and residence permits print it). A passport or a NATIONAL ID card is issued only to that country\'s own nationals, so its issuing country establishes nationality even without a printed field. A driver licence, a residence permit without a nationality field, or any document issued to residents regardless of citizenship CANNOT establish nationality — never infer it from where such a document was issued (a residence permit is by definition held by a foreign national). If the document cannot establish nationality, set nationality_match to false and say in "reason" that a passport or national ID is needed to confirm nationality; leave country_on_id empty. EVERY nationality is equally acceptable — this gate only checks that the claim is accurate, never which country it names. Report country_on_id as the ISO 3166-1 alpha-2 code the document establishes.',
			'5) selfie_matches_id: is the SELFIE the same person as the ID portrait?',
			'6) profile_matches: is the PROFILE PHOTO the same person as the SELFIE / ID portrait (a clear photo of that person\'s face)?',
			'Do NOT consider ethnicity or place of birth. They are not collected, not stored, and must not influence the verdict.',
			'Be careful but fair. Give a confidence 0-1 for the overall decision.',
			'Reply with ONLY a single minified JSON object, no prose, exactly these keys:',
			'{"genuine_id":bool,"name_match":bool,"dob_match":bool,"nationality_match":bool,"selfie_matches_id":bool,"profile_matches":bool,"name_on_id":string,"dob_on_id":"YYYY-MM-DD","country_on_id":"XX","confidence":number,"reason":string}',
			'"reason" is one short sentence a member can read (no PII beyond what they submitted). Set "verified" yourself is NOT needed — we compute it.',
		] );
		$content = [
			[ 'type' => 'text', 'text' => "CLAIMED full name: {$name}\nCLAIMED date of birth (YYYY-MM-DD): {$birthday}\nCLAIMED nationality (ISO 3166-1 alpha-2): {$nationality}\n\nImages follow in this order:" ],
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
		$v['verified'] = self::decide( $v );
		return $v;
	}

	/** The verdict is computed by US, never read off the model: six gates, each of which alone
	 *  refuses, plus confidence ≥ MIN_CONF. ONE definition, shared by the live path and the test
	 *  seam, so the harness exercises the exact expression production runs (the 2026-08-11 rewrite
	 *  had the same expression twice, and a gate added to one copy would silently be missing from the
	 *  other). nationality_match is a gate again since 2026-08-18. */
	public static function decide( array $v ) {
		return ! empty( $v['genuine_id'] ) && ! empty( $v['name_match'] ) && ! empty( $v['dob_match'] )
			&& ! empty( $v['nationality_match'] )
			&& ! empty( $v['selfie_matches_id'] ) && ! empty( $v['profile_matches'] )
			&& (float) ( $v['confidence'] ?? 0 ) >= self::MIN_CONF;
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

	// ── the profile BANNER (operator 2026-08-18: "make banner pic updatable") ──────────────────
	/** The member's profile banner URL — the picture behind the profile header — or '' when they
	 *  have not set one (the page then paints the gold→blue band). Public like the avatar. Every
	 *  profile emitter ships it (Social::profile, Auth::me). */
	public static function banner_url( $uid ) { return (string) get_user_meta( (int) $uid, 'aq_banner_url', true ); }

	/**
	 * POST /profile/banner {image} | {remove:true} — set or clear the banner. Exactly the palm's
	 * shape: any signed-in member, one request, free, no AI, no bearing on the blue check; the SPA
	 * downscales to ≤1600px on the long edge before upload and parse_image caps it at 5 MB. A wide
	 * picture (3:1, like every other social banner) fits best; anything else is centre-cropped by
	 * the page. Session-only, like the photo and the palm — an API token cannot change a face or a
	 * banner. Purged with the account (Account::sweep unlinks aq_banner_file).
	 */
	public static function set_banner_photo( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		if ( Rest::throttle( 'set_banner', 12, 3600 ) ) { return Rest::err( 'rate_limited', 'Too many changes. Try again later.', 429 ); }
		if ( Rest::p( $req, 'remove', '' ) ) {
			self::clear_banner( $uid );
			return [ 'ok' => true, 'banner' => '' ];
		}
		$img = self::parse_image( (string) Rest::p( $req, 'image', '' ) );
		if ( $img === null ) { return Rest::err( 'bad_image', 'Please choose a clear JPG, PNG or WebP under 5 MB.' ); }
		$ext  = $img['mime'] === 'image/png' ? 'png' : ( $img['mime'] === 'image/webp' ? 'webp' : 'jpg' );
		$prev = (string) get_user_meta( $uid, 'aq_banner_file', true );
		if ( $prev && @file_exists( $prev ) ) { @unlink( $prev ); }
		$res = wp_upload_bits( 'aq-banner-' . $uid . '-' . time() . '.' . $ext, null, $img['bytes'] );
		if ( ! empty( $res['error'] ) || empty( $res['url'] ) ) { return Rest::err( 'upload_failed', 'Could not save that image — please try another.', 500 ); }
		update_user_meta( $uid, 'aq_banner_url', esc_url_raw( $res['url'] ) );
		update_user_meta( $uid, 'aq_banner_file', $res['file'] );
		return [ 'ok' => true, 'banner' => (string) $res['url'] ];
	}

	/** Remove the banner entirely — delete the file and clear both meta keys. */
	private static function clear_banner( $uid ) {
		$prev = (string) get_user_meta( $uid, 'aq_banner_file', true );
		if ( $prev && @file_exists( $prev ) ) { @unlink( $prev ); }
		delete_user_meta( $uid, 'aq_banner_url' );
		delete_user_meta( $uid, 'aq_banner_file' );
	}

	/**
	 * The picture we hold for a member, in precedence order, or '' if we hold none:
	 * uploaded photo → single-select typology pick → their season sigil.
	 *
	 * ONE definition, because avatar_url() and filter_avatar() below must not drift. They did: the
	 * filter knew only about the uploaded photo, so every caller that did NOT go through
	 * avatar_url() — the schema.org Person emitter in aq-seo-schema.php, the comment templates, and
	 * anything added later — fell through to a raw Gravatar URL. A Gravatar URL is a hash of the
	 * member's email address, which turns an indexable page into an email-confirmation oracle:
	 * guess an address, hash it, compare. We mask those addresses everywhere else now.
	 */
	private static function own_picture( $uid ) {
		$uid = (int) $uid;
		if ( $uid <= 0 ) { return ''; }
		$up = (string) get_user_meta( $uid, 'aq_avatar_url', true );
		if ( $up !== '' ) { return $up; }
		$pick = (string) get_user_meta( $uid, 'aq_typology_pic', true );
		if ( $pick !== '' ) { return $pick; }
		return (string) Seasons::sigil_url( Seasons::of_user( $uid ) );
	}

	/** Swap our own picture in for the gravatar default, everywhere get_avatar(_url) is used —
	 *  including callers we do not know about, which is the point of doing it here and not at each
	 *  call site. Members for whom we hold nothing still get their genuine gravatar. */
	public static function filter_avatar( $args, $id_or_email ) {
		$uid = self::resolve_uid( $id_or_email );
		if ( $uid ) {
			$url = self::own_picture( $uid );
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
		// The member's own picture, if we hold one: uploaded photo (user-managed pictures are never
		// replaced) → single-select typology pick → their SEASON SIGIL, the dozenal-numeral emblem of
		// the one season they subscribe to (operator directive 2026-07-10). own_picture() is the one
		// definition of that order, shared with filter_avatar() so the two cannot disagree.
		$own = self::own_picture( $uid );
		if ( $own !== '' ) { return $own; }
		// Nothing on record — a genuine gravatar, or d=404 so the <img> onError draws the brand
		// initial disc rather than leaving an empty ring (ticket #113).
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
		$age = self::age_of( $s );
		return $age >= self::MIN_AGE && $age <= 120;
	}

	/** Years elapsed since a YYYY-MM-DD date, or 0 if it is not one. The ONE place this arithmetic
	 *  lives: valid_birthday() bounds it, and age() publishes it. */
	private static function age_of( $s ) {
		if ( ! preg_match( '/^(\d{4})-(\d{2})-(\d{2})$/', (string) $s, $m ) ) { return 0; }
		$age = (int) gmdate( 'Y', time() ) - (int) $m[1];
		if ( gmdate( 'md', time() ) < $m[2] . $m[3] ) { $age--; }
		return $age;
	}

	/**
	 * The member's AGE IN YEARS, or 0 when no valid date is on record.
	 *
	 * An API convenience ONLY. This is emitted beside `birthday`, never instead of it: the public
	 * profile publishes the exact DATE, by operator decision of 2026-07-27 ("the DATE only — no
	 * derived age … printing it turns a fact the member stated into a label the site puts on them"),
	 * reaffirmed 2026-08-15 after I had briefly replaced the date with this. **Do not render this on
	 * the profile page.**
	 *
	 * It stays because the Developer API is a real consumer surface and an age spares every client
	 * reimplementing the leap-year arithmetic — and because it is derived from a value we already
	 * publish, so it discloses nothing new.
	 */
	public static function age( $uid ) {
		$b = self::birthday( $uid );
		return self::valid_birthday( $b ) ? self::age_of( $b ) : 0;
	}
}
