<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Passwordless authentication. No passwords anywhere:
 *   - email one-time code: enter email → 6-digit code → verify (account created on first use)
 *   - Google: verify the Google ID token server-side, find-or-create the account
 *
 * Codes are stored only as a salted hash in a short-lived transient, single-use, and
 * rate-limited. verify/google set the standard WP auth cookie, so the SPA reloads into a
 * live session. Sessions stay stateless (cookie/nonce) → API replicas need no shared store.
 */
final class Auth {

	const CODE_TTL  = 600; // 10 minutes
	const MAX_TRIES = 5;   // wrong codes allowed per issued code before it is burned (brute-force gate)

	// GLOBAL per-email gates (keyed by the email hash, NOT IP-salted) — close the distributed-IP
	// bypass: Rest::throttle scopes by uid-or-IP, so a botnet rotating IPs evades it. These don't.
	const MAX_SENDS   = 8;     // sign-in code EMAILS per address per window (anti-bomb + bounds # of codes)
	const SEND_WINDOW = 3600;
	const MAX_FAILS   = 10;    // failed verifies per address per window before a cooldown lock
	const FAIL_WINDOW = 3600;
	const BASE_LOCK   = 3600;  // first lock 1h; doubles per repeat offence; capped at MAX_LOCK
	const MAX_LOCK    = 86400; // 24h
	// SITEWIDE ceiling on sign-in emails per hour — the backstop against a caller rotating IPs past
	// the per-caller cap. Well above real traffic (a busy day is a few dozen sign-ins) and well below
	// the relay's daily quota, so tripping it costs a few members a short wait instead of costing
	// everyone the whole day's authentication.
	// 3000/h (2026-10-08, was 300): sized for 10k sign-ups a day with a 5× peak-hour factor — every new
	// member is by definition an UNKNOWN address, so this ceiling is exactly what onboarding spends.
	// Still far under the mail provider's quota (Mailer: Azure Communication Services or SMTP).
	const GLOBAL_SENDS = 3000;
	/** Per-caller (IP) sign-in code requests. Generous because one school, office, mobile carrier or
	 *  university NAT puts hundreds of honest people behind one address; the per-ADDRESS limits
	 *  (5 per 10 min, MAX_SENDS per hour) are what protect an inbox, and they are unchanged. */
	const CALLER_BURST       = 30;   // per minute — a classroom signing up together
	const CALLER_PER_HOUR    = 300;
	const VERIFY_IP_PER_10M  = 400;

	/** POST /auth/request-code {email} — always returns ok (never leaks account existence). */
	/**
	 * NOTE ON STATUS CODES IN THIS FILE — 429 IS UNUSABLE HERE.
	 *
	 * WP.com's edge REPLACES the body of any 429 we emit with its own generic HTML page
	 * ("You have been rate-limited…"). Our JSON never reaches the browser, so `r.json()` yields {}
	 * and the SPA cannot show the reason — every refusal looks like a dead site. That is exactly how
	 * an armed reCAPTCHA gate (since removed) spent a day looking like a WP.com rate limiter: the
	 * handler was returning a perfectly good JSON 429 and the edge was eating it.
	 *
	 * So these refusals are 400. They are all client-side problems the member must READ to act on —
	 * wrong code, too many tries, too many codes for this address — and a 400 they can read beats a 429
	 * whose body is destroyed. The machine-readable `error` slug is unchanged either way.
	 */
	public static function request_code( $req ) {
		$email = sanitize_email( (string) Rest::p( $req, 'email', '' ) );
		if ( ! is_email( $email ) ) { return Rest::err( 'bad_email', 'Enter a valid email' ); }
		// TWO buckets, because one of them cannot see the attack.
		//
		// The per-address bucket below has the VICTIM'S ADDRESS inside the key, so it counts
		// (caller × address): change the address and the counter starts again at zero. over_send_cap
		// is keyed on the address alone. Between them, NOTHING counted sends per CALLER — so one IP
		// posting a different third-party address every second sent 3,600 real "your sign-in code"
		// emails an hour to people who never asked, from our domain. That burns the SMTP relay's
		// DAILY quota in about half an hour, and when the relay is spent NOBODY CAN SIGN IN AT ALL,
		// because an emailed code IS the authentication system. It also torches domain reputation,
		// which outlives the attack.
		//
		// So: a bucket with no address in it, which therefore aggregates per caller. Bot-neutral —
		// a script signs in as one or two addresses and never comes near the cap. Sized (2026-10-08)
		// for shared networks: CALLER_BURST a minute and CALLER_PER_HOUR an hour per IP.
		if ( Rest::throttle( 'code_caller_burst', self::CALLER_BURST, 60 ) || Rest::throttle( 'code_caller', self::CALLER_PER_HOUR, 3600 ) ) {
			return Rest::err( 'rate_limited', 'Too many sign-in codes requested from here. Try again later.', 400 );
		}
		if ( Rest::throttle( 'code_' . $email, 5, 600 ) ) {
			return Rest::err( 'rate_limited', 'Too many requests. Try again shortly.', 400 );
		}
		// The backstop for a caller that rotates IPs past the per-caller cap: a SITEWIDE hourly
		// ceiling on sign-in mail. It is far above honest traffic and far below the relay's quota, so
		// it converts a silent quota drain — the failure that takes the whole platform's auth down —
		// into a refusal plus one alert.
		//
		// APPLIED TO UNKNOWN ADDRESSES ONLY (2026-08-01). Applied to everyone it became the very
		// outage it was written to prevent: the counter is one shared number, so a caller rotating
		// IPs — an IPv6 /64 hands out 2^64 of them for nothing — could spend all GLOBAL_SENDS on
		// random addresses that have no account, and every REAL member was then locked out of the
		// only sign-in method the platform has. A cheaper, more total denial of service than the
		// quota drain it guards against. The guard belongs on the traffic it is about: mail to
		// strangers. A registered member's own code is still bounded twice — code_caller (20 per
		// caller per hour) and over_send_cap (MAX_SENDS for that address per hour) — so this is not
		// an unbounded path, it is a path bounded per-member instead of globally.
		//
		// This does mean the refusal differs for a known and an unknown address once the ceiling is
		// tripped. That leaks nothing: every member's email address is already published in full by
		// the Data explorer. Enumeration is not a threat model on a platform with a public database.
		$known = (bool) get_user_by( 'email', $email );
		if ( ! $known && self::over_global_send_cap() ) {
			Watchdog::alert(
				'auth_mail_ceiling',
				'Sign-in mail ceiling hit',
				'The sitewide cap of ' . self::GLOBAL_SENDS . ' sign-in emails per hour was reached, so further codes are being refused. '
					. 'Honest traffic does not approach this: check for a caller rotating IPs to bomb third-party inboxes.',
				true
			);
			return Rest::err( 'rate_limited', 'Sign-in email is busy right now. Please try again shortly.', 400 );
		}
		// NO CAPTCHA HERE, BY DECISION (operator, 2026-07-31: "no need for recaptcha. we are bot
		// friendly. just ensure rate limiting is implemented"). This platform ships a Developer API so
		// scripts and AI agents can use it; a gate that asks every caller to prove it is human
		// contradicts that, and it was never what stopped inbox-bombing anyway. RATE LIMITS DO THAT,
		// and they are the two directly above and below this line: 5 requests per 10 minutes per
		// address (Rest::throttle) and MAX_SENDS per address per hour (over_send_cap). Both bound the
		// thing that actually costs a victim something — mail sent to their address — rather than
		// guessing at the caller's species.
		// GLOBAL anti-bomb cap (IP-independent): once this address has had its hourly quota of codes,
		// stop sending. This used to return the SUCCESS shape and send nothing, so a member whose
		// code went to spam tapped Resend, was told "a new code is on its way", and waited on an
		// email that was never sent — for up to an hour, with no way to tell. Silent success is the
		// one refusal a person cannot act on.
		//
		// Saying so leaks NOTHING about whether the address exists: reaching this cap requires
		// MAX_SENDS requests for that address, which is something the asker did themselves, and the
		// answer is identical for a registered and an unregistered address. Enumeration is still
		// closed. 400, not 429 — see the status-code note at the top of this file.
		//
		// NOTE we do NOT suppress on lock: a locked-out (under-attack) owner must still be able to
		// request a fresh code and sign in (a correct code bypasses the guess-lock in verify_code).
		if ( self::over_send_cap( $email ) ) {
			return Rest::err( 'send_cap', 'Too many codes requested for this address in the last hour. Please try again later.', 400 );
		}
		$code = (string) wp_rand( 100000, 999999 );
		set_transient( self::key( $email ), wp_hash( $code ), self::CODE_TTL );
		self::note_send( $email );
		// Count only mail to strangers against the sitewide ceiling, so the counter measures the thing
		// the ceiling refuses. Counting a member's own sign-in there would let ordinary traffic on a
		// busy hour push the ceiling closed against the next stranger — and, before the fix above,
		// against the next member too.
		if ( ! $known ) { self::note_global_send(); }
		Mailer::send( 'signin_code', $email, [ 'code' => $code ] );
		return [ 'ok' => true, 'message' => 'Check your email for a 6-digit code.', 'expires_in' => self::CODE_TTL ];
	}

	/**
	 * POST /auth/verify-code {email, code, redirect} — verify + sign in.
	 *
	 * Brute-force hardened in depth, because every email is PUBLIC and the code is only 1M wide:
	 *   - per-IP + per-email FIXED-window throttles (cheap, but IP-salted → a botnet can rotate past them);
	 *   - a per-CODE attempt cap (MAX_TRIES) that burns the code — GLOBAL per email, IP-independent;
	 *   - a GLOBAL per-email FAILURE counter that, past MAX_FAILS, imposes an escalating cooldown LOCK
	 *     (1h→2h→…→24h) which blocks both verify AND new-code issuance and pings the owner.
	 * Combined, a distributed attacker is capped at ~MAX_FAILS guesses per cooldown (≈10/hour, then
	 * locked out for ever-longer), making the 1M keyspace infeasible while never blocking a real user.
	 */
	public static function verify_code( $req ) {
		$email = sanitize_email( (string) Rest::p( $req, 'email', '' ) );
		$code  = preg_replace( '/\D/', '', (string) Rest::p( $req, 'code', '' ) );
		if ( ! is_email( $email ) || strlen( $code ) !== 6 ) { return Rest::err( 'bad_input', 'Invalid email or code' ); }
		if ( Rest::throttle( 'verify_' . $email, 20, 600 ) || Rest::throttle( 'verify_ip', self::VERIFY_IP_PER_10M, 600 ) ) {
			return Rest::err( 'rate_limited', 'Too many attempts. Try again shortly.', 400 );
		}
		$stored = get_transient( self::key( $email ) );
		if ( ! $stored ) { return Rest::err( 'bad_code', 'That code is wrong or expired.' ); }

		// CORRECT CODE ALWAYS WINS — checked BEFORE any lock. Only the real owner can read the code
		// from their inbox, so honouring it even during a guess-cooldown means an attacker who knows
		// the (public) email can NEVER lock the owner out: the lock throttles wrong guesses, not the
		// legitimate sign-in. A success fully clears the failure streak + lock.
		if ( hash_equals( $stored, wp_hash( $code ) ) ) {
			delete_transient( self::key( $email ) );        // single use
			delete_transient( self::tries_key( $email ) );
			delete_transient( self::fail_key( $email ) );
			delete_transient( self::lock_key( $email ) );
			delete_transient( self::locknum_key( $email ) );
			$why  = null;
			$user = self::find_or_create( $email, '', $why );
			return self::sign_in( $user, Rest::p( $req, 'redirect', '/' ), $why );
		}

		// WRONG code from here. A cooldown lock rejects further GUESSES (never the correct code above).
		$rem = self::lock_remaining( $email );
		if ( $rem > 0 ) {
			$mins = max( 1, (int) ceil( $rem / 60 ) );
			return Rest::err( 'locked', sprintf( 'Too many attempts. Try again in about %d minute%s.', $mins, $mins === 1 ? '' : 's' ), 400 );
		}
		$tries_key = self::tries_key( $email );
		if ( (int) get_transient( $tries_key ) >= self::MAX_TRIES ) {
			delete_transient( self::key( $email ) ); // burn the code so this window can't be re-hammered
			delete_transient( $tries_key );
			self::register_fail( $email );
			return Rest::err( 'too_many', 'Too many wrong codes. Request a new one.', 400 );
		}
		set_transient( $tries_key, (int) get_transient( $tries_key ) + 1, self::CODE_TTL );
		self::register_fail( $email ); // global counter → escalating lock + owner alert past MAX_FAILS
		return Rest::err( 'bad_code', 'That code is wrong or expired.' );
	}

	/** POST /auth/google {credential, redirect} — verify Google ID token, sign in. */
	public static function google( $req ) {
		if ( Rest::throttle( 'google_ip', self::VERIFY_IP_PER_10M, 600 ) ) { return Rest::err( 'rate_limited', 'Too many attempts. Try again shortly.', 400 ); }
		// ACCEPT EITHER CONFIGURED CLIENT ID, and this is not belt-and-braces — it is the only
		// correct shape. The Vault and the `aq_google_client_id` option hold DIFFERENT ids on prod
		// (same Google project, different OAuth clients), and the browser mints its token against
		// whichever one the page was served with. Server and page are deployed as separate
		// artefacts, so during any rollout — or any future rotation — the two legitimately disagree
		// for a while. Verifying against one alone means every sign-in in that window is refused;
		// verifying against the set means none are, while an `aud` from anywhere else is still
		// rejected. (Learned the hard way: pinning the server to the Vault while the page still
		// carried the option broke exactly this.)
		$ids   = array_values( array_unique( array_filter( [
			trim( (string) Secrets::get( 'GOOGLE_OAUTH_CLIENT_ID' ) ),
			(string) get_option( 'aq_google_client_id', '' ),
		] ) ) );
		$token = (string) Rest::p( $req, 'credential', '' );
		if ( ! $ids || ! $token ) { return Rest::err( 'google_off', 'Google sign-in is not configured.' ); }
		$resp = wp_remote_get( 'https://oauth2.googleapis.com/tokeninfo?id_token=' . rawurlencode( $token ), [ 'timeout' => 8 ] );
		if ( is_wp_error( $resp ) ) { return Rest::err( 'google_err', 'Could not reach Google.' ); }
		$info = json_decode( wp_remote_retrieve_body( $resp ), true ) ?: [];
		$aud_ok = false;
		foreach ( $ids as $cid ) {
			if ( self::google_claims_ok( $info, $cid ) ) { $aud_ok = true; break; }
		}
		if ( ! $aud_ok ) {
			return Rest::err( 'google_bad', 'Google verification failed.' );
		}
		$user = self::find_or_create( sanitize_email( $info['email'] ), $info['name'] ?? '' );
		return self::sign_in( $user, Rest::p( $req, 'redirect', '/' ) );
	}

	/**
	 * Validate the tokeninfo claims: aud must match OUR client id, the issuer must be Google, the token
	 * must not be expired (tokeninfo rejects expired tokens, but we re-check defensively), and the email
	 * must be Google-VERIFIED. tokeninfo returns `email_verified` as the STRING "true"/"false" — the old
	 * `empty()` check accepted the non-empty string "false", i.e. a token for an email its Google account
	 * had never proven ownership of (the classic unverified-email OAuth account-takeover: register a
	 * Google account claiming the victim's address, sign in here as them). Strict boolean parse closes it.
	 */
	public static function google_claims_ok( $info, $client_id ) {
		$iss      = (string) ( $info['iss'] ?? '' );
		$iss_ok   = in_array( $iss, [ 'accounts.google.com', 'https://accounts.google.com' ], true );
		$not_exp  = ! isset( $info['exp'] ) || (int) $info['exp'] > time();
		$verified = filter_var( $info['email_verified'] ?? false, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE ) === true;
		return ! empty( $info['aud'] ) && hash_equals( (string) $client_id, (string) $info['aud'] )
			&& ! empty( $info['email'] ) && $verified && $iss_ok && $not_exp;
	}

	/** GET /me — the current session's identity (null when logged out). */
	public static function me( $req ) {
		$uid = Rest::uid();
		if ( ! $uid ) { return [ 'user' => null ]; }
		$u   = wp_get_current_user();
		$pts = Economy::points_balance( $uid ); // standing (tier); compute once
		return [ 'user' => [
			'id'       => $uid,
			'name'     => $u->display_name,
			'slug'     => $u->user_nicename,
			'avatar'   => Verify::avatar_url( $uid, 96 ),
			'points'   => $pts,
			'coins'    => Economy::coin_balance( $uid ),
			'tier'      => Economy::tier( $pts ),
			'progress'  => Economy::tier_progress( $pts ), // {label,next,pct,remaining} for the rank ring
			'breakdown' => Economy::points_by_track( $uid ), // {learn,donate,volunteer,outreach} for the profile
			'completed' => Learn::completed_count( $uid ), // courses completed (cert threshold) for the profile stat
			'bio'       => (string) get_user_meta( $uid, 'description', true ), // so the saved bio loads back (was never read)
			'links'     => (object) self::links( $uid ),                          // (object): an empty set is {} not [] — see Social::profile
			'socials'   => self::socials( $uid ),                                 // every handle, in profile order — what the settings form edits
			'links_order' => self::links_order( $uid ),                           // the member's saved icon order ([] = the default ranking)
			// No relationship status since 2026-10-08 (operator: "remove relationship status") — the
			// stored value is kept, nothing reads it out any more.
			'location'     => self::location( $uid ),                             // self-declared only — never inferred, see Auth::location
			'category'     => self::category( $uid ),                             // the briefcase item: what they do, in their words
			'languages'    => self::languages( $uid ),                            // I18n registry codes, the member's own order
			'works'     => Notebook::published_count( $uid ),                     // published works — the dashboard's headline tile
			'joined'    => Verify::joined_label( $u->user_registered ), // clamped to the platform launch (ticket #103)
			'verified'     => Verify::is_verified( $uid ),   // the ID check passed (gates cash-out)
			'badge'        => Verify::has_badge( $uid ),     // the blue check on screen — earned OR granted
			'has_identity' => Verify::has_identity( $uid ),  // name + birthday set (gates posting)
			'full_name'    => Verify::full_name( $uid ),
			'birthday'     => Verify::birthday( $uid ),
			'palm'         => Verify::palm_url( $uid ),      // opt-in palm "back photo" → the avatar flips to it (ticket #94)
			'banner'       => Verify::banner_url( $uid ),    // the profile banner; '' when unset
		] ];
	}

	/** POST /profile-update {name, bio, username?} — edit the signed-in user's own display name, bio,
	 *  and (optionally) username. Empty name is ignored so a blank field can't wipe the display name.
	 *  The username is the public handle (`user_nicename`, the /u/<slug>/ profile URL) — changeable at
	 *  any time, subject to availability ([#28]). `user_login` is deliberately NEVER touched: auth is
	 *  passwordless (email code / Google), so the login is an inert internal identifier and rewriting
	 *  it would only risk the wp-admin operator path. */
	/**
	 * The places a member can say they also are — the profile's social handles.
	 *
	 *   key => [ label, host(s) a pasted URL must land on, bare-handle rule, URL path → handle ]
	 *
	 * ORDER IS THE PROFILE'S ORDER. The website first (the profile shows it in the meta row, not
	 * among the marks), then the 31 networks ranked by how many accounts each has — the biggest
	 * first, so the ones a visitor is most likely to use are the ones visible before "+N" (operator
	 * 2026-10-08) — then the two research identifiers that predate them.
	 *
	 * WHAT IS STORED IS THE HANDLE, NOT THE URL (since 2026-10-08). The member types "artafather" or
	 * pastes https://www.instagram.com/artafather/ and either way `artafather` is what lands in
	 * aq_links; the address is built from it on READ (social_url). That keeps one canonical value per
	 * network, lets the settings form show a handle rather than a wall of URLs, and lets an address
	 * pattern change (twitter.com → x.com, threads.net → threads.com) without rewriting anyone's row.
	 * Values written before that are absolute URLs and still resolve: a stored https:// value is used
	 * as-is (it was host-checked when it was saved).
	 *
	 * HOST-LOCKED ON PURPOSE. A free-text URL on a public profile is a spam surface: it costs nothing
	 * to create an account and drop a link, and this one would be rendered on an indexable page. A
	 * pasted URL is accepted only if it lands on that network's own host, so the field cannot be
	 * pointed anywhere else, and a bare handle must fit that network's own handle rule before it is
	 * put into an address. The exceptions are deliberate and few: a personal website (any https host)
	 * and Mastodon, which is federated — written `user@instance`, or as the profile URL on any
	 * instance. Every rendered link carries rel="nofollow ugc", so there is no ranking to farm.
	 *
	 * TWO HAVE NO PUBLIC PROFILE PAGE. WeChat and Discord IDs are not addressable on the web (Discord
	 * only by a numeric user id, which IS linked), so they are stored as the ID and the profile shows
	 * it as plain text — no copy button (operator 2026-10-08: "remove copy ID").
	 * Bilibili's space URL needs the numeric UID; a nickname resolves to Bilibili's own user search
	 * instead, which is useful to a visitor but is not a profile — so it is never claimed as one in
	 * the Person schema's sameAs (see links()).
	 *
	 * A member may type a bare handle, an @handle, or paste the full URL — refusing somebody's
	 * perfectly good profile address is a worse experience than reading the handle out of it.
	 */
	const LINKS = array(
		'website'     => array( 'Website',        '',                        '',                                                  '' ),
		// The 31 networks, LARGEST FIRST by published accounts/users (operator 2026-10-08: "rank them
		// based on registered accounts in each"; figures and sources in the PR and the deliverables).
		'facebook'    => array( 'Facebook',       'facebook.com|fb.com',     '/^[A-Za-z0-9.]{1,50}$/',                           '~^/([^/?#]+)/?$~' ),
		'instagram'   => array( 'Instagram',      'instagram.com',           '/^[A-Za-z0-9._]{1,30}$/',                          '~^/([^/?#]+)/?$~' ),
		'youtube'     => array( 'YouTube',        'youtube.com',             '/^(?:[A-Za-z0-9._-]{3,30}|UC[A-Za-z0-9_-]{22})$/', '~^/(?:@|channel/)([^/?#]+)/?$~' ),
		'tiktok'      => array( 'TikTok',         'tiktok.com',              '/^[A-Za-z0-9._]{2,24}$/',                          '~^/@([^/?#]+)/?$~' ),
		'wechat'      => array( 'WeChat',         '',                        '/^[A-Za-z0-9_-]{2,32}$/',                          '' ),
		'linkedin'    => array( 'LinkedIn',       'linkedin.com',            '/^[A-Za-z0-9_-]{2,100}$/',                         '~^/in/([^/?#]+)/?$~' ),
		'telegram'    => array( 'Telegram',       't.me|telegram.me',        '/^[A-Za-z0-9_]{5,32}$/',                           '~^/([^/?#]+)/?$~' ),
		'snapchat'    => array( 'Snapchat',       'snapchat.com',            '/^[A-Za-z][A-Za-z0-9._-]{2,14}$/',                 '~^/add/([^/?#]+)/?$~' ),
		'spotify'     => array( 'Spotify',        'spotify.com',             '/^[A-Za-z0-9._-]{1,64}$/',                         '~^/user/([^/?#]+)/?$~' ),
		'pinterest'   => array( 'Pinterest',      'pinterest.com',           '/^[A-Za-z0-9_]{3,30}$/',                           '~^/([^/?#]+)/?$~' ),
		'weibo'       => array( 'Weibo',          'weibo.com|weibo.cn',      '/^[\p{L}\p{N}_-]{1,30}$/u',                        '~^/(?:u/|n/)?([^/?#]+)/?$~' ),
		// twitter.com is accepted too: it is the same service under its old name, and people paste
		// the URL they have. Refusing it would be correct and useless.
		'x'           => array( 'X',              'x.com|twitter.com',       '/^[A-Za-z0-9_]{1,15}$/',                           '~^/([^/?#]+)/?$~' ),
		'reddit'      => array( 'Reddit',         'reddit.com',              '/^[A-Za-z0-9_-]{3,20}$/',                          '~^/(?:user|u)/([^/?#]+)/?$~' ),
		'threads'     => array( 'Threads',        'threads.com|threads.net', '/^[A-Za-z0-9._]{1,30}$/',                          '~^/@([^/?#]+)/?$~' ),
		'tumblr'      => array( 'Tumblr',         'tumblr.com',              '/^[A-Za-z0-9-]{1,32}$/',                           '~^/([^/?#]+)/?$~' ),
		'quora'       => array( 'Quora',          'quora.com',               '/^[A-Za-z0-9-]{1,100}$/',                          '~^/profile/([^/?#]+)/?$~' ),
		'bilibili'    => array( 'Bilibili',       'bilibili.com',            '/^[\p{L}\p{N}_-]{1,32}$/u',                        '~^/([0-9]{1,20})/?$~' ),
		'discord'     => array( 'Discord',        'discord.com',             '/^(?:[A-Za-z0-9_.]{2,32}(?:#[0-9]{4})?|[0-9]{17,20})$/', '~^/users/([0-9]{17,20})/?$~' ),
		'github'      => array( 'GitHub',         'github.com',              '/^[A-Za-z0-9-]{1,39}$/',                           '~^/([^/?#]+)/?$~' ),
		'strava'      => array( 'Strava',         'strava.com',              '/^[A-Za-z0-9_-]{1,64}$/',                          '~^/athletes/([^/?#]+)/?$~' ),
		'goodreads'   => array( 'Goodreads',      'goodreads.com',           '/^[A-Za-z0-9_-]{1,64}$/',                          '~^/(?:user/show/)?([^/?#]+)/?$~' ),
		'twitch'      => array( 'Twitch',         'twitch.tv',               '/^[A-Za-z0-9_]{3,25}$/',                           '~^/([^/?#]+)/?$~' ),
		'medium'      => array( 'Medium',         'medium.com',              '/^[A-Za-z0-9._]{1,30}$/',                          '~^/@([^/?#]+)/?$~' ),
		'vk'          => array( 'VK',             'vk.com|vk.ru',            '/^[A-Za-z0-9._]{1,32}$/',                          '~^/([^/?#]+)/?$~' ),
		'rumble'      => array( 'Rumble',         'rumble.com',              '/^[A-Za-z0-9_-]{1,64}$/',                          '~^/(?:user|c)/([^/?#]+)/?$~' ),
		'bluesky'     => array( 'Bluesky',        'bsky.app',                '/^[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))*$/', '~^/profile/([^/?#]+)/?$~' ),
		'soundcloud'  => array( 'SoundCloud',     'soundcloud.com',          '/^[A-Za-z0-9_-]{2,64}$/',                          '~^/([^/?#]+)/?$~' ),
		'kaggle'      => array( 'Kaggle',         'kaggle.com',              '/^[A-Za-z0-9_-]{1,64}$/',                          '~^/([^/?#]+)/?$~' ),
		'letterboxd'  => array( 'Letterboxd',     'letterboxd.com',          '/^[A-Za-z0-9_]{2,15}$/',                           '~^/([^/?#]+)/?$~' ),
		'huggingface' => array( 'Hugging Face',   'huggingface.co|hf.co',    '/^[A-Za-z0-9._-]{1,96}$/',                         '~^/([^/?#]+)/?$~' ),
		'mastodon'    => array( 'Mastodon',       '',                        '/^@?[A-Za-z0-9_]{1,30}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/', '~^/@([A-Za-z0-9_]{1,30})/?$~' ),
		// Research identifiers — not social networks, so after the ranked list.
		'scholar'     => array( 'Google Scholar', 'scholar.google.com',      '/^[A-Za-z0-9_-]{6,20}$/',                          '' ),
		'orcid'       => array( 'ORCID',          'orcid.org',               '/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/',                 '~^/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/?$~' ),
	);

	/** The longest bio a member may write, in CHARACTERS. Matches the counter in the settings form. */
	const BIO_MAX = 600;

	/**
	 * Note that somebody was here today. TO THE DAY, deliberately.
	 *
	 * This database is PUBLISHED — every row of it, by design — so whatever is stored here is not a
	 * private record of when a member was around, it is a public one. An exact timestamp on every
	 * request would be a per-member activity log accurate to the second: enough to read somebody's
	 * sleep, their working hours and their timezone off a page anybody can fetch. Nobody asked for
	 * that, and "last seen" does not need it — "active 3 days ago" is the whole of what it says.
	 *
	 * So it stores UTC midnight of the current day and nothing finer. The precision that is not
	 * collected cannot be published, which is a stronger guarantee than choosing not to show it.
	 *
	 * It is also why this is CHEAP: the value only changes once a day, so the common case is a read
	 * and a comparison, and there is exactly one write per member per day no matter how busy they
	 * are. Chat's live presence stays where it is — in transients, never in the database (Chat.php,
	 * "pure transients, nothing rests in the DB") — because "online right now" is a different claim
	 * with different consequences, and that decision was made deliberately.
	 */
	public static function mark_seen( $uid ) {
		$uid = (int) $uid;
		if ( $uid <= 0 ) { return; }
		$today = (int) ( floor( time() / DAY_IN_SECONDS ) * DAY_IN_SECONDS );
		if ( (int) get_user_meta( $uid, 'aq_last_seen', true ) === $today ) { return; }
		update_user_meta( $uid, 'aq_last_seen', $today );
	}

	/** UTC midnight of the day a member was last seen, or 0 if never recorded. */
	public static function last_seen( $uid ) {
		return (int) get_user_meta( (int) $uid, 'aq_last_seen', true );
	}

	/**
	 * A member's public links: key => absolute https URL. Always an object, never a list, so a caller
	 * can read `links.github` without searching. Unknown keys are dropped rather than trusted, so a
	 * value written before a key was retired cannot resurface.
	 */
	/**
	 * Relationship status — a CLOSED vocabulary, never free text.
	 *
	 * Free text would be three bad things at once on this platform: an unmoderated public string on
	 * a page about a real person, an untranslatable one (the i18n mesh renders ~133 languages from
	 * fixed strings), and a field nobody can filter or reason about later. A key set is none of them.
	 * The empty key is the default and means NOT SAYING — it renders nothing at all, because the
	 * absence of a stated status is not "Single".
	 *
	 * RETIRED 2026-10-08 (operator: "remove relationship status"): no longer asked, accepted or
	 * emitted. The vocabulary and relationship() stay so the stored answers remain readable to the
	 * operator; nothing on the site renders them.
	 */
	const RELATIONSHIPS = array(
		'single'       => 'Single',
		'relationship' => 'In a relationship',
		'engaged'      => 'Engaged',
		'married'      => 'Married',
		'partnership'  => 'In a civil partnership',
		'open'         => 'In an open relationship',
		'complicated'  => "It's complicated",
		'separated'    => 'Separated',
		'divorced'     => 'Divorced',
		'widowed'      => 'Widowed',
	);

	/**
	 * How many languages a member may claim. Eight is past what anyone credibly speaks and it keeps
	 * the profile's one-line meta row readable; the registry itself has 132, so an uncapped list
	 * would be a way to turn a profile into a wall.
	 */
	const LANGS_MAX = 8;

	/**
	 * The languages this member says they speak, as I18n registry codes.
	 *
	 * Validated on READ as well as on write, exactly like relationship(): a code that is no longer in
	 * the registry (or was written straight into this public database by hand) resolves to nothing
	 * rather than rendering as raw text on somebody's profile. Order is the MEMBER'S — we do not
	 * collect fluency, so re-sorting their list would be us inventing a ranking they never stated.
	 */
	public static function languages( $uid ) {
		$raw = get_user_meta( (int) $uid, 'aq_languages', true );
		$raw = is_array( $raw ) ? $raw : (array) json_decode( (string) $raw, true );
		$out = array();
		foreach ( $raw as $c ) {
			$code = I18n::language_code( (string) $c );
			if ( '' !== $code && ! in_array( $code, $out, true ) ) { $out[] = $code; }
		}
		return array_slice( $out, 0, self::LANGS_MAX );
	}

	/** The member's stated relationship status key, or '' when they have not said. */
	public static function relationship( $uid ) {
		$v = (string) get_user_meta( (int) $uid, 'aq_relationship', true );
		return isset( self::RELATIONSHIPS[ $v ] ) ? $v : '';
	}

	/**
	 * Where the member says they are, in their own words ("Istanbul", "Istanbul, Türkiye").
	 *
	 * SELF-DECLARED, ALWAYS. It is never inferred from an IP address, a timezone or a request
	 * header, and it never may be: this database is published in full, so a location we GUESSED
	 * would be us publishing somebody's whereabouts on their behalf. A member types it or there is
	 * nothing here. Capped at LOCATION_MAX characters — a city, not an address.
	 */
	const LOCATION_MAX = 60;

	public static function location( $uid ) {
		return (string) get_user_meta( (int) $uid, 'aq_location', true );
	}

	/**
	 * What the member does, in a word or two ("Education", "Software engineer") — the briefcase item
	 * of the profile's meta row, the way X shows a profile category (operator 2026-10-08). Free text,
	 * one line, CATEGORY_MAX characters, tags stripped; self-declared like the location.
	 */
	const CATEGORY_MAX = 40;

	public static function category( $uid ) {
		return (string) get_user_meta( (int) $uid, 'aq_category', true );
	}

	public static function links( $uid ) {
		// key => absolute https URL of a PROFILE — what the Person schema's sameAs and the no-JS
		// "elsewhere" list publish as "this is the same person". An ID with no page (WeChat, a
		// Discord username) and a nickname that only resolves to a site search (Bilibili) are left
		// out: a search results page is not an identity claim.
		$out = array();
		foreach ( self::socials( $uid ) as $s ) {
			if ( '' !== $s['url'] && $s['profile'] ) { $out[ $s['key'] ] = $s['url']; }
		}
		return $out;
	}

	/**
	 * THE MEMBER'S OWN ORDER (operator 2026-10-08: "the social links should be … rankable by the
	 * user"). `aq_links_order` is a JSON list of network keys, the member's chosen order, written by
	 * profile_update and SANITISED to the known networks (no website — that lives in the meta row,
	 * not the icon row; no duplicates; nothing unknown). socials() — and so the profile row, its
	 * "+N" list, the Account editor and links() — puts those first in that order; every network
	 * WITHOUT a saved position follows in the default network-size ranking (the LINKS order). No
	 * saved order (the default, and what an empty list resets to) is just the ranking.
	 */
	const LINKS_ORDER_META = 'aq_links_order';
	public static function links_order( $uid ) {
		return self::clean_order( get_user_meta( (int) $uid, self::LINKS_ORDER_META, true ) );
	}
	/** Anything → a clean list of network keys: an array, a JSON list, or "a,b,c". */
	public static function clean_order( $in ) {
		if ( is_string( $in ) ) {
			$t  = trim( $in );
			$in = ( '' !== $t && '[' === $t[0] ) ? json_decode( $t, true ) : explode( ',', $t );
		}
		$out = array();
		foreach ( is_array( $in ) ? $in : array() as $k ) {
			$k = is_string( $k ) ? strtolower( trim( $k ) ) : '';
			if ( '' === $k || 'website' === $k || ! isset( self::LINKS[ $k ] ) || in_array( $k, $out, true ) ) { continue; }
			$out[] = $k;
		}
		return $out;
	}
	/** A key => value map (already in LINKS order) re-sequenced: the website first as always, then
	 *  the saved order, then everything else in its existing (ranked) order. */
	private static function ordered( array $map, array $order ) {
		if ( ! $order ) { return $map; }
		$out = array();
		if ( isset( $map['website'] ) ) { $out['website'] = $map['website']; }
		foreach ( $order as $k ) { if ( isset( $map[ $k ] ) ) { $out[ $k ] = $map[ $k ]; } }
		foreach ( $map as $k => $v ) { if ( ! isset( $out[ $k ] ) ) { $out[ $k ] = $v; } }
		return $out;
	}

	/** The raw stored map, key => handle-or-URL, unknown keys dropped. */
	private static function stored_links( $uid ) {
		$raw = get_user_meta( (int) $uid, 'aq_links', true );
		$raw = is_array( $raw ) ? $raw : (array) json_decode( (string) $raw, true );
		$out = array();
		foreach ( self::LINKS as $k => $_ ) {
			$v = isset( $raw[ $k ] ) ? trim( (string) $raw[ $k ] ) : '';
			if ( '' !== $v ) { $out[ $k ] = $v; }
		}
		return $out;
	}

	/**
	 * Every handle a member has set, in profile order:
	 *   [ { key, label, handle, url, profile } ]
	 * `handle` is what the settings form shows and the profile prints (a URL only when one was saved
	 * that is not reducible to a handle); `url` is '' for an ID with no web address (WeChat, a
	 * Discord username) — the profile offers those to copy; `profile` is false for an address that
	 * is a search rather than a profile page.
	 */
	public static function socials( $uid ) {
		$out = array();
		foreach ( self::ordered( self::stored_links( $uid ), self::links_order( $uid ) ) as $k => $v ) {
			$url = self::social_url( $k, $v );
			$out[] = array(
				'key'     => $k,
				'label'   => self::LINKS[ $k ][0],
				'handle'  => 0 === strpos( $v, 'https://' ) ? ( self::handle_from_url( $k, $v ) ?: $v ) : $v,
				'url'     => $url,
				'profile' => '' !== $url && ! ( 'bilibili' === $k && ! ctype_digit( $v ) && 0 !== strpos( $v, 'https://' ) ),
			);
		}
		return $out;
	}

	/** A network's display label ('' for an unknown key) — for renderers outside the plugin. */
	public static function link_label( $key ) {
		return isset( self::LINKS[ $key ] ) ? self::LINKS[ $key ][0] : '';
	}

	/**
	 * A stored value → the address a visitor is sent to, or '' when the network has none.
	 * A stored absolute URL (saved before handles, or a pasted address that is not reducible to one)
	 * is returned as-is — it was host-checked when it was saved.
	 */
	public static function social_url( $key, $v ) {
		$v = trim( (string) $v );
		if ( '' === $v || ! isset( self::LINKS[ $key ] ) ) { return ''; }
		if ( 0 === strpos( $v, 'https://' ) ) { return esc_url_raw( $v ); }
		$e   = rawurlencode( $v );
		$num = ctype_digit( $v );
		switch ( $key ) {
			case 'linkedin':    $u = 'https://www.linkedin.com/in/' . $e . '/'; break;
			case 'instagram':   $u = 'https://www.instagram.com/' . $e . '/'; break;
			case 'facebook':    $u = $num ? 'https://www.facebook.com/profile.php?id=' . $e : 'https://www.facebook.com/' . $e; break;
			case 'threads':     $u = 'https://www.threads.com/@' . $e; break;
			case 'bluesky':     $u = 'https://bsky.app/profile/' . $e; break;
			case 'tiktok':      $u = 'https://www.tiktok.com/@' . $e; break;
			case 'pinterest':   $u = 'https://www.pinterest.com/' . $e . '/'; break;
			case 'reddit':      $u = 'https://www.reddit.com/user/' . $e . '/'; break;
			case 'snapchat':    $u = 'https://www.snapchat.com/add/' . $e; break;
			case 'quora':       $u = 'https://www.quora.com/profile/' . $e; break;
			case 'youtube':     $u = preg_match( '/^UC[A-Za-z0-9_-]{22}$/', $v ) ? 'https://www.youtube.com/channel/' . $e : 'https://www.youtube.com/@' . $e; break;
			case 'vk':          $u = $num ? 'https://vk.com/id' . $e : 'https://vk.com/' . $e; break;
			case 'x':           $u = 'https://x.com/' . $e; break;
			case 'telegram':    $u = 'https://t.me/' . $e; break;
			case 'wechat':      $u = ''; break; // no public profile address exists — the profile offers the ID to copy
			case 'discord':     $u = preg_match( '/^[0-9]{17,20}$/', $v ) ? 'https://discord.com/users/' . $e : ''; break;
			case 'twitch':      $u = 'https://www.twitch.tv/' . $e; break;
			case 'github':      $u = 'https://github.com/' . $e; break;
			case 'strava':      $u = 'https://www.strava.com/athletes/' . $e; break; // numeric id or the member's vanity name
			case 'letterboxd':  $u = 'https://letterboxd.com/' . $e . '/'; break;
			case 'goodreads':   $u = $num ? 'https://www.goodreads.com/user/show/' . $e : 'https://www.goodreads.com/' . $e; break;
			case 'soundcloud':  $u = 'https://soundcloud.com/' . $e; break;
			case 'spotify':     $u = 'https://open.spotify.com/user/' . $e; break;
			case 'kaggle':      $u = 'https://www.kaggle.com/' . $e; break;
			case 'huggingface': $u = 'https://huggingface.co/' . $e; break;
			case 'medium':      $u = 'https://medium.com/@' . $e; break;
			case 'tumblr':      $u = 'https://www.tumblr.com/' . $e; break;
			case 'rumble':      $u = 'https://rumble.com/user/' . $e; break;
			case 'mastodon':
				// user@instance → https://instance/@user — the address every Mastodon server answers.
				if ( ! preg_match( '/^@?([A-Za-z0-9_]{1,30})@([A-Za-z0-9.-]+)$/', $v, $m ) ) { return ''; }
				$u = 'https://' . strtolower( $m[2] ) . '/@' . $m[1];
				break;
			// The space page needs the numeric UID; a nickname goes to Bilibili's own user search.
			case 'bilibili':    $u = $num ? 'https://space.bilibili.com/' . $e : 'https://search.bilibili.com/upuser?keyword=' . $e; break;
			case 'weibo':       $u = $num ? 'https://weibo.com/u/' . $e : 'https://weibo.com/n/' . $e; break;
			case 'scholar':     $u = 'https://scholar.google.com/citations?user=' . $e; break;
			case 'orcid':       $u = 'https://orcid.org/' . $e; break;
			default:            $u = ''; // website: only ever stored as a URL, handled above
		}
		return '' === $u ? '' : esc_url_raw( $u );
	}

	/** The handle a profile URL on a network's own host names, or '' when it is not that shape. */
	private static function handle_from_url( $key, $url ) {
		if ( 'scholar' === $key ) { // the profile id rides in the query string: /citations?user=<id>
			parse_str( (string) wp_parse_url( $url, PHP_URL_QUERY ), $q );
			$h = isset( $q['user'] ) ? (string) $q['user'] : '';
			return self::valid_handle( $key, $h ) ? $h : '';
		}
		$rx = self::LINKS[ $key ][3] ?? '';
		if ( '' === $rx ) { return ''; }
		$path = (string) wp_parse_url( $url, PHP_URL_PATH );
		if ( ! preg_match( $rx, $path, $m ) ) { return ''; }
		$h = rawurldecode( $m[1] );
		if ( 'mastodon' === $key ) {
			$host = strtolower( (string) wp_parse_url( $url, PHP_URL_HOST ) );
			return $host ? $h . '@' . $host : '';
		}
		return self::valid_handle( $key, $h ) ? $h : '';
	}

	/** Does a bare handle fit this network's own rule? */
	private static function valid_handle( $key, $h ) {
		$rule = self::LINKS[ $key ][2] ?? '';
		return '' !== $rule && '' !== $h && (bool) preg_match( $rule, $h );
	}

	/**
	 * One submitted value → the canonical value to STORE (a handle, or an https URL when the network
	 * allows one that is not reducible to a handle), or '' if it cannot be one. Accepts a bare
	 * handle ("arash"), an @handle, `u/handle` for Reddit, `user@instance` for Mastodon, or a full
	 * URL on the network's own host.
	 */
	private static function normalise_social( $key, $val ) {
		$val = trim( (string) $val );
		if ( '' === $val || ! isset( self::LINKS[ $key ] ) ) { return ''; }
		if ( strlen( $val ) > 300 ) { return ''; }
		$host = self::LINKS[ $key ][1];

		if ( preg_match( '#^https?://#i', $val ) ) {
			$url = esc_url_raw( $val );
			if ( '' === $url ) { return ''; }
			// http → https rather than refusing: the member is right about where they are, and a
			// profile page must not link out over plaintext.
			$url = preg_replace( '#^http://#i', 'https://', $url );
			$h   = strtolower( (string) wp_parse_url( $url, PHP_URL_HOST ) );
			if ( '' === $h ) { return ''; }
			if ( '' !== $host ) {
				// Suffix match, so www. and country subdomains pass while "github.com.evil.tld"
				// does not — the check is on the END of the host, after a dot.
				$okhost = false;
				foreach ( explode( '|', $host ) as $cand ) {
					if ( $h === $cand || substr( $h, -( strlen( $cand ) + 1 ) ) === '.' . $cand ) { $okhost = true; break; }
				}
				if ( ! $okhost ) { return ''; }
				// Bilibili's profile pages live on space.bilibili.com only.
				if ( 'bilibili' === $key && 'space.bilibili.com' !== $h ) { return ''; }
			} elseif ( 'website' !== $key && 'mastodon' !== $key ) {
				return ''; // an ID-only network (WeChat) has no address to paste
			}
			// Reduce a profile URL to its handle whenever it is exactly that shape — one canonical
			// value per network, whichever way the member typed it.
			$handle = self::handle_from_url( $key, $url );
			if ( '' !== $handle ) { return 'bluesky' === $key || 'mastodon' === $key ? strtolower( $handle ) : $handle; }
			// Discord: only the /users/<id> address is a profile; anything else on the host is not.
			if ( 'discord' === $key ) { return ''; }
			return $url;
		}

		// A bare handle. Anything that is not plausibly one is refused rather than pasted into a URL.
		if ( 'website' === $key ) { return ''; } // a site needs a real URL — a handle says nothing
		$handle = $val;
		if ( 'reddit' === $key ) { $handle = preg_replace( '#^/?u/#i', '', $handle ); }
		if ( 'mastodon' === $key ) {
			$handle = ltrim( $handle, '@' );
			if ( ! self::valid_handle( $key, $handle ) ) { return ''; }
			list( $user, $inst ) = explode( '@', $handle, 2 );
			return $user . '@' . strtolower( $inst );
		}
		$handle = ltrim( $handle, '@' );
		if ( 'bluesky' === $key ) {
			$handle = strtolower( $handle );
			// A bare Bluesky name is on the default host — "artafather" means artafather.bsky.social.
			if ( false === strpos( $handle, '.' ) ) { $handle .= '.bsky.social'; }
		}
		return self::valid_handle( $key, $handle ) ? $handle : '';
	}

	/**
	 * Set some of a member's handles directly, validated exactly as the settings form validates them.
	 * Keys absent from $map are left alone; a value that does not validate is skipped, never stored.
	 * For one-shot operator seeds (Schema::migrate) — not a route. Returns the keys written.
	 */
	public static function seed_socials( $uid, array $map ) {
		$cur  = self::stored_links( $uid );
		$done = array();
		foreach ( $map as $k => $v ) {
			$n = self::normalise_social( (string) $k, (string) $v );
			if ( '' !== $n ) { $cur[ $k ] = $n; $done[] = (string) $k; }
		}
		if ( $done ) { update_user_meta( (int) $uid, 'aq_links', wp_json_encode( $cur ) ); }
		return $done;
	}

	/** Remove ONE stored link (server-side callers: a migration). True when something was removed. */
	public static function clear_social( $uid, $key ) {
		$cur = self::stored_links( $uid );
		if ( ! isset( $cur[ $key ] ) ) { return false; }
		unset( $cur[ $key ] );
		update_user_meta( (int) $uid, 'aq_links', wp_json_encode( $cur ) );
		return true;
	}

	/** One submitted value → the absolute https URL it will render as, or '' if it cannot be one.
	 *  Kept for tools/verify-links.php, which asserts every accepted value comes back https. */
	private static function normalise_link( $key, $val ) {
		return self::social_url( $key, self::normalise_social( $key, $val ) );
	}

	public static function profile_update( $req ) {
		$uid  = Rest::uid();
		if ( ! $uid ) { return Rest::err( 'auth', 'Please sign in.', 401 ); }
		$name = sanitize_text_field( (string) Rest::p( $req, 'name', '' ) );
		$bio  = sanitize_textarea_field( (string) Rest::p( $req, 'bio', '' ) );
		// Capped by CHARACTERS on the server too — the form's counter is a courtesy, not the rule, and
		// the bio renders in full on a public page and in the Person schema. sanitize_textarea_field
		// has already stripped every tag; the profile prints it as text, never as HTML.
		$bio  = trim( function_exists( 'mb_substr' ) ? mb_substr( $bio, 0, self::BIO_MAX ) : substr( $bio, 0, self::BIO_MAX ) );

		// Social handles (`socials`, since 2026-10-08) or the older `links` — same map, key => what the
		// member typed. Links, when the client sends them. ABSENT means "unchanged" and an EMPTY OBJECT means
		// "clear them" — a form that only edits the bio must not silently wipe somebody's links
		// because it did not know about the field.
		//
		// VALIDATED HERE, BEFORE ANYTHING IS WRITTEN. It used to be checked after the name and bio
		// had already been saved, so a request refused for a bad link had still applied half of
		// itself: the member got an error and their name changed anyway. Same reason the username is
		// settled first — a save either happens or it does not.
		$links_clean = null;
		$links_in    = Rest::p( $req, 'socials', null );
		if ( null === $links_in ) { $links_in = Rest::p( $req, 'links', null ); }
		if ( null !== $links_in ) {
			$links_in    = is_array( $links_in ) ? $links_in : (array) json_decode( (string) $links_in, true );
			$links_clean = array();
			$bad         = array();
			foreach ( self::LINKS as $k => $meta ) {
				$raw = isset( $links_in[ $k ] ) ? trim( (string) $links_in[ $k ] ) : '';
				if ( '' === $raw ) { continue; }
				$val = self::normalise_social( $k, $raw );
				// Name the one that failed. "Could not save" for a whole form because one field was
				// wrong is the kind of error people give up on.
				if ( '' === $val ) { $bad[] = $meta[0]; continue; }
				$links_clean[ $k ] = $val;
			}
			if ( $bad ) {
				return Rest::err( 'bad_link', count( $bad ) === 1
					? sprintf( 'That %s handle does not look right — type just your handle, or paste the address of your profile there.', $bad[0] )
					: sprintf( 'These do not look right: %s. Type just the handle, or paste the address of each profile.', implode( ', ', $bad ) ) );
			}
		}

		// Username (handle) change — validated + availability-checked, then applied FIRST so a
		// rejected handle aborts the whole save with a clear error (the form keeps the user's input).
		$uname        = strtolower( trim( (string) Rest::p( $req, 'username', '' ) ) );
		$before       = get_userdata( $uid );
		$slug_changed = false;
		if ( $uname !== '' && $before && $uname !== $before->user_nicename ) {
			$problem = self::username_problem( $uname, $uid );
			if ( $problem ) { return Rest::err( $problem['code'], $problem['msg'] ); }
			// Abuse guard only — handle-cycling (squat/release churn) — never a real "once per N days" cap.
			if ( Rest::throttle( 'username_change', 10, DAY_IN_SECONDS ) ) {
				return Rest::err( 'rate_limited', 'Too many username changes today — try again tomorrow.', 429 );
			}
			$res = wp_update_user( array( 'ID' => $uid, 'user_nicename' => $uname ) );
			if ( is_wp_error( $res ) ) { return Rest::err( 'username_failed', 'Could not change your username — try another.' ); }
			$slug_changed = true;
		}

		if ( $name !== '' ) { wp_update_user( array( 'ID' => $uid, 'display_name' => $name ) ); }
		update_user_meta( $uid, 'description', $bio );

		if ( null !== $links_clean ) { update_user_meta( $uid, 'aq_links', wp_json_encode( $links_clean ) ); }

		// The member's order for their icons (`links_order`, a list of network keys). Same contract:
		// ABSENT leaves it alone; a list replaces it, sanitised to known networks; an EMPTY list goes
		// back to the default ranking (the meta is deleted, not stored empty).
		$order_in = Rest::p( $req, 'links_order', null );
		if ( null !== $order_in ) {
			$order = self::clean_order( $order_in );
			if ( $order ) { update_user_meta( $uid, self::LINKS_ORDER_META, wp_json_encode( $order ) ); }
			else { delete_user_meta( $uid, self::LINKS_ORDER_META ); }
		}

		// Category + location. OMITTED means "leave it alone" (same contract as links above), so a
		// form that only edits the bio cannot silently blank either one. An empty STRING is a real
		// instruction: stop saying. RELATIONSHIP STATUS is no longer accepted (operator 2026-10-08,
		// "remove relationship status"): a `relationship` field is ignored, and what was stored stays
		// stored — retiring a question is not a reason to delete somebody's answer.
		$cat_in = Rest::p( $req, 'category', null );
		if ( null !== $cat_in ) {
			$cat = sanitize_text_field( (string) $cat_in );
			$cat = function_exists( 'mb_substr' ) ? mb_substr( $cat, 0, self::CATEGORY_MAX ) : substr( $cat, 0, self::CATEGORY_MAX );
			update_user_meta( $uid, 'aq_category', trim( $cat ) );
		}
		$langs_in = Rest::p( $req, 'languages', null );
		if ( null !== $langs_in ) {
			$langs_in = is_array( $langs_in ) ? $langs_in : (array) json_decode( (string) $langs_in, true );
			$clean = array();
			$bad   = array();
			foreach ( $langs_in as $c ) {
				$code = I18n::language_code( (string) $c );
				if ( '' === $code ) { $bad[] = sanitize_text_field( substr( (string) $c, 0, 12 ) ); continue; }
				if ( ! in_array( $code, $clean, true ) ) { $clean[] = $code; }
			}
			// REFUSE rather than silently drop: a member who picked something we cannot render must be
			// told, not left looking at a profile that quietly disagrees with what they submitted.
			if ( $bad ) {
				return Rest::err( 'bad_language', 'We do not have that language: ' . implode( ', ', array_slice( $bad, 0, 3 ) ) . '.' );
			}
			if ( count( $clean ) > self::LANGS_MAX ) {
				return Rest::err( 'too_many_languages', 'You can list up to ' . self::LANGS_MAX . ' languages.' );
			}
			update_user_meta( $uid, 'aq_languages', wp_json_encode( array_values( $clean ) ) );
		}
		$loc_in = Rest::p( $req, 'location', null );
		if ( null !== $loc_in ) {
			// One line, city-sized. sanitize_text_field already strips tags and newlines; the cap is
			// what stops the field becoming a paragraph on a page that budgets one line for it. Cut by
			// CHARACTERS, not bytes — "İstanbul" would split mid-character and render as a broken glyph.
			$loc = sanitize_text_field( (string) $loc_in );
			$loc = function_exists( 'mb_substr' ) ? mb_substr( $loc, 0, self::LOCATION_MAX ) : substr( $loc, 0, self::LOCATION_MAX );
			update_user_meta( $uid, 'aq_location', trim( $loc ) );
		}
		$u = get_userdata( $uid );
		// Notify the member their profile changed (a paper trail in the account drawer's bell).
		$note = $slug_changed && $u
			? 'Your username is now @' . $u->user_nicename . '. Your profile moved with it — links to the old address no longer work.'
			: 'Your name and bio were saved.';
		Notify::push( $uid, 'profile', 'Your profile was updated', $note, $u ? '/u/' . $u->user_nicename . '/' : '' );
		// `slug` is re-read from the DB, not echoed: in the (rare) race where two members claim the same
		// handle simultaneously, WP suffixes the loser (-2) — the client must learn what it actually got.
		// `links` comes back NORMALISED — a member who typed a bare handle sees the real URL that was
		// stored, so the form shows what the profile will show rather than what they typed.
		return array( 'ok' => true, 'name' => $u ? $u->display_name : $name, 'bio' => $bio, 'slug' => $u ? $u->user_nicename : '', 'links' => (object) self::links( $uid ), 'socials' => self::socials( $uid ), 'links_order' => self::links_order( $uid ), 'location' => self::location( $uid ), 'category' => self::category( $uid ), 'languages' => self::languages( $uid ) );
	}

	/** GET /username/check?u= — live availability for the settings form. Public: every username is
	 *  already public (radical transparency), so this leaks nothing the data explorer doesn't. */
	public static function username_check( $req ) {
		$u       = strtolower( trim( (string) Rest::p( $req, 'u', '' ) ) );
		$problem = self::username_problem( $u, Rest::uid() );
		if ( $problem ) {
			return array( 'username' => $u, 'available' => false, 'reason' => $problem['code'], 'message' => $problem['msg'] );
		}
		return array( 'username' => $u, 'available' => true );
	}

	// Handles that must never be claimable — operator/bot identities and impersonation magnets.
	// (Real users' handles are already protected by the taken-checks below; this covers names
	// that don't exist as accounts.)
	const RESERVED_USERNAMES = array(
		'admin', 'administrator', 'artaquest', 'arta', 'artabot', 'artadev', 'moderator', 'mod',
		'support', 'help', 'official', 'staff', 'team', 'security', 'root', 'system', 'anonymous', 'me',
	);

	/**
	 * Why $username can't become $uid's handle — ['code','msg'] — or null when it's free to claim.
	 * Format is strict (3–30 chars, a-z 0-9 hyphen, alphanumeric at both ends) so a handle is always
	 * URL-safe as-is and survives WP's sanitize_title untouched. Taken-checks cover BOTH columns:
	 * another member's nicename (their live handle) and another member's login — /u/<login> also
	 * resolves via the theme's legacy fallback, so a handle equal to someone's login would shadow them.
	 */
	private static function username_problem( $username, $uid ) {
		if ( ! preg_match( '/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/', $username ) ) {
			return array( 'code' => 'invalid', 'msg' => 'Usernames are 3–30 characters: lowercase letters, numbers, and hyphens (no hyphen at the ends).' );
		}
		if ( in_array( $username, self::RESERVED_USERNAMES, true ) || Arta::is_reserved( $username ) ) {
			return array( 'code' => 'reserved', 'msg' => 'That username is reserved.' );
		}
		$by_slug = get_user_by( 'slug', $username );
		if ( $by_slug && (int) $by_slug->ID !== (int) $uid ) {
			return array( 'code' => 'taken', 'msg' => 'That username is already taken.' );
		}
		$by_login = username_exists( $username ); // returns the owner's user ID (0/false when free)
		if ( $by_login && (int) $by_login !== (int) $uid ) {
			return array( 'code' => 'taken', 'msg' => 'That username is already taken.' );
		}
		return null;
	}

	/**
	 * Make stored password material INERT. The whole DB is public and auth is delegated to email
	 * one-time codes + Google, so a `user_pass` hash (or a WP application password) must never be a
	 * usable credential — otherwise reading the DB would mean account/site takeover. We therefore
	 * reject every password login (the passwordless flow sets the cookie directly, bypassing this)
	 * and disable application passwords entirely. Recovery escape hatch: define a truthy
	 * `AQ_ALLOW_PASSWORD_LOGIN` in wp-config.php (env/constant, never the DB).
	 */
	public static function harden() {
		add_filter( 'authenticate', [ self::class, 'block_password_login' ], 30, 3 );
		add_filter( 'wp_is_application_passwords_available', '__return_false' );
		add_filter( 'auth_cookie_expiration', [ self::class, 'admin_cookie_cap' ], 20, 3 );
	}

	/** Cap ADMINISTRATOR sessions at 72h (members keep WP's 14-day remember-me). A hijacked or
	 *  forgotten operator cookie is full site takeover; bounding its lifetime bounds that exposure,
	 *  and operators just re-enter an email code every few days. */
	public static function admin_cookie_cap( $ttl, $user_id, $remember ) {
		return user_can( (int) $user_id, 'manage_options' ) ? min( (int) $ttl, 3 * DAY_IN_SECONDS ) : $ttl;
	}

	public static function block_password_login( $user, $username, $password ) {
		if ( ! empty( $password ) && ! Secrets::has( 'AQ_ALLOW_PASSWORD_LOGIN' ) ) {
			return new \WP_Error( 'password_login_disabled', 'Sign in with your email code or Google — passwords are disabled.' );
		}
		return $user;
	}


	// ── helpers ─────────────────────────────────────────────────────────────
	private static function key( $email )      { return 'aq_code_'        . md5( strtolower( $email ) ); }
	private static function tries_key( $email ){ return 'aq_codetry_'     . md5( strtolower( $email ) ); }
	private static function sent_key( $email ) { return 'aq_codesent_'    . md5( strtolower( $email ) ); }
	private static function fail_key( $email ) { return 'aq_codefail_'    . md5( strtolower( $email ) ); }
	private static function lock_key( $email ) { return 'aq_codelock_'    . md5( strtolower( $email ) ); }
	private static function locknum_key($email){ return 'aq_codelocknum_' . md5( strtolower( $email ) ); }

	/** Seconds left on this address's sign-in cooldown lock (0 = not locked). */
	private static function lock_remaining( $email ) {
		$until = (int) get_transient( self::lock_key( $email ) );
		return $until > time() ? $until - time() : 0;
	}
	/** True once this address has been emailed its quota of codes this window (anti-bomb). */
	/** Sitewide sign-in-mail counter for the current hour — see GLOBAL_SENDS. */
	// A FIXED clock-hour window. This was one key re-set with a fresh one-hour TTL on every send —
	// a sliding window that never expires while sign-ups keep arriving, so under steady onboarding
	// the counter only ever climbed and the ceiling closed for good. Keyed on the UTC hour, it resets
	// on the hour whatever the traffic.
	private static function global_send_key() { return 'aq_mail_h_' . gmdate( 'YmdH' ); }
	private static function over_global_send_cap() {
		return (int) get_transient( self::global_send_key() ) >= self::GLOBAL_SENDS;
	}
	private static function note_global_send() {
		$k = self::global_send_key();
		set_transient( $k, (int) get_transient( $k ) + 1, 2 * HOUR_IN_SECONDS );
	}

	private static function over_send_cap( $email ) {
		return (int) get_transient( self::sent_key( $email ) ) >= self::MAX_SENDS;
	}
	private static function note_send( $email ) {
		$k = self::sent_key( $email );
		set_transient( $k, (int) get_transient( $k ) + 1, self::SEND_WINDOW );
	}

	/**
	 * Record a failed verify against this address (GLOBAL, IP-independent). Past MAX_FAILS in the
	 * window it trips an escalating cooldown lock and alerts the owner. This is the gate a botnet
	 * rotating IPs cannot evade — the per-IP throttles can be, this cannot.
	 */
	private static function register_fail( $email ) {
		$k = self::fail_key( $email );
		$n = (int) get_transient( $k ) + 1;
		set_transient( $k, $n, self::FAIL_WINDOW );
		if ( $n >= self::MAX_FAILS ) {
			self::lock( $email );
			delete_transient( $k );
		}
	}

	/**
	 * Impose an escalating sign-in cooldown on an address (1h, doubling per repeat offence, capped at
	 * 24h) and burn any live code so the lock can't be ridden out with a known code. Alerts the owner
	 * once per hour (idempotent ref) — only the real owner ever sees it, so it never leaks existence.
	 */
	private static function lock( $email ) {
		$cnt_k = self::locknum_key( $email );
		$cnt   = (int) get_transient( $cnt_k ) + 1;
		set_transient( $cnt_k, $cnt, self::MAX_LOCK );
		$ttl = (int) min( self::BASE_LOCK * ( 2 ** ( $cnt - 1 ) ), self::MAX_LOCK );
		set_transient( self::lock_key( $email ), time() + $ttl, $ttl );
		// Deliberately DON'T burn the live code here — the owner may already hold a valid code, and a
		// correct code must keep working during the lock (verify_code checks it first). The lock only
		// gates wrong guesses, so leaving the code live can't help an attacker who can't read it.
		$u = get_user_by( 'email', $email );
		if ( $u && user_can( $u, 'manage_options' ) ) {
			// An operator account under code-guessing attack is a Watchdog matter, not just the
			// member's own inbox: every email is public, so admins are the obvious targets. The
			// alert rides the tamper-evident channel (state-file throttle, operator email + bells).
			Watchdog::alert( 'auth_admin_lock', 'ADMIN account under sign-in brute force',
				"Repeated failed sign-in code guesses tripped the cooldown lock on administrator `{$u->user_login}` "
				. '(attempt #' . $cnt . ', lock ' . (int) round( $ttl / 60 ) . "min).\n"
				. 'The guess-lock never blocks the real owner (a correct emailed code always wins), and the code keyspace '
				. 'is infeasible under the lock cadence — but someone is actively working an operator account.', true );
		}
		if ( $u ) {
			$mins = (int) round( $ttl / 60 );
			Notify::push(
				$u->ID,
				'security',
				'Sign-in temporarily locked',
				"We saw repeated failed sign-in attempts for your account and paused sign-in for about {$mins} minutes to protect it. Your account and data are safe — just sign in as usual once the cooldown passes.",
				'/user-account/',
				'seclock:' . floor( time() / 3600 )
			);
			if ( $u->user_email ) {
				Mailer::send( 'signin_locked', $u->user_email, [ 'minutes' => $mins ] );
			}
		}
	}

	private static function find_or_create( $email, $name = '', &$why = null ) {
		$user = get_user_by( 'email', $email );
		if ( $user ) { return $user; }
		$login = self::unique_login( $email );
		$uid   = wp_insert_user( [
			'user_login'   => $login,
			'user_email'   => $email,
			'user_pass'    => wp_generate_password( 32, true, true ), // random; never used (passwordless)
			'display_name' => $name ?: ucwords( str_replace( [ '.', '_', '-' ], ' ', strstr( $email, '@', true ) ) ),
			'role'         => 'subscriber',
		] );
		// WHY IT REFUSED, kept. "Could not sign you in." told the member nothing and told us less:
		// a sign-up that fails here is a door that does not open, and every hour it stays unexplained
		// is a person who cannot join. The code (never a secret — WordPress's own error slug) rides
		// back in the answer and goes to the log.
		if ( is_wp_error( $uid ) ) {
			$why = (string) $uid->get_error_code();
			error_log( '[aq] sign-up refused for ' . $email . ' as @' . $login . ': ' . $why . ' — ' . $uid->get_error_message() );
			return null;
		}
		return get_user_by( 'id', $uid );
	}

	private static function unique_login( $email ) {
		$base = sanitize_user( strstr( $email, '@', true ), true ) ?: 'quester';
		// RESERVED_USERNAMES must hold at CREATION too, not only when an existing member renames
		// themselves. This asked username_exists() and nothing else, so whoever happened to own
		// support@…, admin@…, official@…, security@… was handed @support, @admin, @official,
		// @security on the way in — names that read as this platform speaking, on a site whose whole
		// database is public and where the handle IS the identity. The guard on the rename route
		// (username_problem) already refused exactly these; sign-up simply never consulted it.
		// A reserved base falls back rather than being decorated: @admin2 still reads as staff.
		if ( in_array( strtolower( $base ), self::RESERVED_USERNAMES, true ) || Arta::is_reserved( $base ) ) { $base = 'quester'; }
		// BOUNDED. This was `while (username_exists) $i++`, one query per taken suffix: harmless at a
		// few sign-ups a day, but the fallback base is shared ('quester') and common local parts
		// (info, hello, john) collide, so at 10k sign-ups a day the n-th one walked n rows. A few
		// sequential tries keep handles tidy; after that a random suffix ends it in one more query.
		$login = $base;
		for ( $i = 2; username_exists( $login ) || Arta::is_reserved( $login ); $i++ ) {
			$login = $i <= 4 ? $base . $i : substr( $base, 0, 50 ) . '-' . strtolower( wp_generate_password( 6, false ) );
			if ( $i > 12 ) { break; }
		}
		return $login;
	}

	/**
	 * Open-redirect guard: only a same-origin absolute URL or a single-leading-slash path is allowed;
	 * everything else collapses to '/'. Defence-in-depth — the React client validates too, but a
	 * non-React API consumer would otherwise follow an attacker-supplied `redirect`. Blocks `//host`
	 * and `/\host` (protocol-relative coercions) plus `javascript:`/`mailto:`/cross-origin targets.
	 */
	private static function safe_redirect( $raw ) {
		$raw = trim( (string) $raw );
		if ( $raw === '' ) { return '/'; }
		if ( preg_match( '#^https?://#i', $raw ) ) {
			$host = wp_parse_url( $raw, PHP_URL_HOST );
			if ( ! $host || $host !== wp_parse_url( home_url(), PHP_URL_HOST ) ) { return '/'; }
		} elseif ( $raw[0] !== '/' || ( isset( $raw[1] ) && ( $raw[1] === '/' || $raw[1] === '\\' ) ) ) {
			return '/';
		}
		return esc_url_raw( $raw ) ?: '/';
	}

	private static function sign_in( $user, $redirect, $why = null ) {
		if ( ! $user ) {
			// A DEAD END IS NOT AN ANSWER. The platform's own spam gate refuses a registration by
			// handing back nothing (`empty_data`, Atomic's Akismet signup check) — the member did
			// nothing wrong and, told only "could not sign you in", has nowhere to go. Name the
			// other door instead. Everything else keeps the plain sentence.
			$msg = 'empty_data' === (string) $why
				? 'We couldn’t create your account from this browser. Try “Continue with Google”, or try again from another browser.'
				: 'Could not sign you in.';
			return Rest::err( 'signin_failed', $msg, 400, $why ? [ 'reason' => (string) $why ] : [] );
		}
		wp_set_current_user( $user->ID );
		wp_set_auth_cookie( $user->ID, true );
		// Alert the member if this device is new (bell + email). Wrapped so a notification hiccup can
		// never block the sign-in itself.
		try { Sessions::on_sign_in( $user->ID ); } catch ( \Throwable $e ) { /* non-fatal */ }
		return [
			'ok'       => true,
			'redirect' => self::safe_redirect( $redirect ),
			'user'     => [
				'name'    => $user->display_name,
				'slug'    => $user->user_nicename,
				'avatar'  => Verify::avatar_url( $user->ID, 96 ),
			],
		];
	}
}
