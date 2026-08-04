<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * The developer API layer (operator 2026-07-23): personal access tokens that let members —
 * and the AI agents they delegate — drive the platform programmatically. Docs: /developers
 * (SPA), GET /api/docs (machine-readable), GET /api/openapi (OpenAPI 3.1).
 *
 * DESIGN (the whole DB is public — see Extra::db):
 *   · A token is `aq_` + 40 hex chars from random_bytes(20), shown ONCE at creation. The DB
 *     stores only sha256(raw) — non-invertible, and masked in the public explorer anyway
 *     (Extra::redact_row). Auth is `Authorization: Bearer <token>` (or `X-AQ-Token`, for
 *     clients whose proxy strips Authorization) on /wp-json/ requests only.
 *   · A valid token signs the request in as its owner (determine_current_user, the standard
 *     seam), so public GETs personalise (your own drafts resolve) and handlers see Rest::uid().
 *   · But a token is NOT a session: it can only reach routes in the TOKEN_ROUTES allow-list,
 *     scoped `read` | `write` | `economy`. Everything else — account deletion, sign-in
 *     sessions, token management itself, passkey enrollment, cart checkout (course-checkout),
 *     chat keys, identity documents, operator surfaces, and every legacy studio-family publish
 *     route — is impossible with a token BY CONSTRUCTION (a route not on the list never accepts
 *     one). Token sessions also drop `manage_options`, so an operator's token can never act as
 *     an operator.
 *   · PUBLISHING IS THE ONE HARD LIMIT: the API can create, edit, check and REQUEST
 *     publication, but a work goes public (and its DOI mints) only when the CONTENT CREATOR
 *     opens the single-use confirm link emailed to their own registered address AND their
 *     device passkey signs the exact source (WebAuthn; the private key never exists on the
 *     server — see Notebook.php, REQUIRE_PASSKEY). No token, agent, or process with server or
 *     source access can substitute for either. AI generation and review: free. Publication:
 *     the author's emailed yes plus their device signature, and nothing else.
 */
final class Api {

	const TABLE_VERSION = '1';

	/** Requests per hour, per token (the fixed-window Rest::throttle). */
	const RATE_LIMIT = 1000;

	/** Active (unrevoked) tokens per member. */
	const MAX_TOKENS = 10;

	const SCOPES = [
		'read'    => 'read your own studio: drafts, checklists, wallet, notifications, feed',
		'write'   => 'attach a Kaggle notebook, run the checklist, choose its output files, request publication, post, comment, heart, follow',
		'economy' => 'move real value: found/enter challenges (fee debits), buy/sell coins, payout status + connect, bursary applications',
	];

	/**
	 * THE ALLOW-LIST — the only session-auth routes a token can reach, keyed by the exact
	 * declared path in Rest::ROUTES, value = [ method => required scope ]. A route absent
	 * here is session-only forever unless deliberately added; new routes are NEVER
	 * token-eligible by default. Public GET routes need no entry (no session required —
	 * a token merely personalises them).
	 */
	const TOKEN_ROUTES = [
		// identity + own studio (notebooks — the one substrate)
		'api/ping'                                   => [ 'GET' => 'read' ],
		'studio/notebooks'                           => [ 'GET' => 'read', 'POST' => 'write' ],
		'studio/notebooks/(?P<id>[0-9]+)/save'       => [ 'POST' => 'write' ],
		// The Kaggle submission (2026-07-28): a script or an agent can do EVERY step up to the
		// request — attach a kernel, run the checklist, choose the files — and none of it can
		// publish anything, because publishing is not a route.
		'studio/kernels'                             => [ 'POST' => 'write' ],
		'studio/notebooks/(?P<id>[0-9]+)/check'      => [ 'POST' => 'write' ],
		'studio/notebooks/(?P<id>[0-9]+)/outputs'    => [ 'GET'  => 'read'  ],
		'studio/notebooks/(?P<id>[0-9]+)/select'     => [ 'POST' => 'write' ],
		'library'                                    => [ 'GET'  => 'read'  ],
		'studio/notebooks/(?P<id>[0-9]+)/publish'    => [ 'POST' => 'write' ], // REQUEST only — the AUTHOR's emailed confirmation is the publication
		'studio/notebooks/(?P<id>[0-9]+)/delete'     => [ 'POST' => 'write' ],
		// the social feed
		'posts'                                      => [ 'POST' => 'write' ],
		'posts/(?P<id>[0-9]+)/heart'                 => [ 'POST' => 'write' ],
		'posts/(?P<id>[0-9]+)/edit'                  => [ 'POST' => 'write' ],
		'posts/(?P<id>[0-9]+)/delete'                => [ 'POST' => 'write' ],
		'notebooks/(?P<id>[0-9]+)/heart'             => [ 'POST' => 'write' ],
		'notebooks/(?P<id>[0-9]+)/comments'          => [ 'POST' => 'write' ],
		'notebooks/(?P<id>[0-9]+)/comments/(?P<cid>[0-9]+)/edit'   => [ 'POST' => 'write' ],
		'notebooks/(?P<id>[0-9]+)/comments/(?P<cid>[0-9]+)/delete' => [ 'POST' => 'write' ],
		'notebooks/(?P<id>[0-9]+)/poll'              => [ 'POST' => 'write' ],
		'notebooks/(?P<id>[0-9]+)/pick'              => [ 'POST' => 'write' ],
		// discussions
		'threads'                                    => [ 'POST' => 'write' ],
		'threads/(?P<id>[0-9]+)/update'              => [ 'POST' => 'write' ],
		'threads/(?P<id>[0-9]+)/delete'              => [ 'POST' => 'write' ],
		'threads/(?P<id>[0-9]+)/comments'            => [ 'POST' => 'write' ],
		'comments/(?P<id>[0-9]+)/update'             => [ 'POST' => 'write' ],
		'comments/(?P<id>[0-9]+)/delete'             => [ 'POST' => 'write' ],
		'vote'                                       => [ 'POST' => 'write' ],
		'follow'                                     => [ 'POST' => 'write' ],
		'work/heart'                                 => [ 'POST' => 'write' ],
		// learning (courses: watch → comment → upvote)
		'enroll'                                     => [ 'POST' => 'write' ],
		'progress'                                   => [ 'POST' => 'write' ],
		'section/comment'                            => [ 'POST' => 'write' ],
		'comment/vote'                               => [ 'POST' => 'write' ],
		'fearometer/appeal'                          => [ 'POST' => 'write' ],
		'dashboard'                                  => [ 'GET' => 'read' ],
		// course authoring (owner/creator checks live in the handlers)
		'courses'                                    => [ 'POST' => 'write' ],
		'courses/(?P<id>[0-9]+)/review'              => [ 'POST' => 'write' ],
		'courses/(?P<id>[0-9]+)/update'              => [ 'POST' => 'write' ],
		'courses/(?P<id>[0-9]+)/lessons'             => [ 'POST' => 'write' ],
		'courses/(?P<id>[0-9]+)/delete'              => [ 'POST' => 'write' ],
		'courses/(?P<id>[0-9]+)/discover'            => [ 'POST' => 'write' ],
		'courses/(?P<id>[0-9]+)/recompute'           => [ 'POST' => 'write' ],
		'courses/(?P<id>[0-9]+)/refresh'             => [ 'POST' => 'write' ],
		'courses/(?P<id>[0-9]+)/insights'            => [ 'GET' => 'read' ],
		'courses/(?P<id>[0-9]+)/import-playlist'     => [ 'POST' => 'write' ],
		'studio/courses'                             => [ 'GET' => 'read' ],
		'studio/courses/(?P<id>[0-9]+)'              => [ 'GET' => 'read' ],
		// competitions (Kaggle-style)
		'competition/create'                         => [ 'POST' => 'write' ],
		'competition/submit'                         => [ 'POST' => 'write' ],
		'competition/my-submissions'                 => [ 'GET' => 'read' ],
		'competition/verify'                         => [ 'POST' => 'write' ],
		// topics (typology studio; creator-gated in the handlers)
		'topics'                                     => [ 'POST' => 'write' ],
		'topics/(?P<key>[a-z0-9-]+)/update'          => [ 'POST' => 'write' ],
		'topics/(?P<key>[a-z0-9-]+)/delete'          => [ 'POST' => 'write' ],
		'studio/topics'                              => [ 'GET' => 'read' ],
		'studio/topics/(?P<key>[a-z0-9-]+)'          => [ 'GET' => 'read' ], // the raw editable topic (read→edit round-trip; author-gated in the handler)
		// the member's own typology self-assessment + endorsements (own profile data + a social act,
		// analogous to profile-update / follow / work-heart above)
		'typologies'                                 => [ 'GET' => 'read', 'POST' => 'write' ],
		'typology/endorsements'                      => [ 'GET' => 'read' ],
		'typology/endorse'                           => [ 'POST' => 'write' ],
		// profile basics (identity documents / photos stay session-only)
		'profile-update'                             => [ 'POST' => 'write' ],
		'verify/status'                              => [ 'GET' => 'read' ],
		// own reads
		'feed'                                       => [ 'GET' => 'read' ],
		'notifications'                              => [ 'GET' => 'read' ],
		'notifications/read'                         => [ 'POST' => 'write' ],
		'wallet'                                     => [ 'GET' => 'read' ],
		'shelf'                                      => [ 'GET' => 'read' ],
		'bursary'                                    => [ 'GET' => 'read' ],
		'bursary/status'                             => [ 'GET' => 'read' ],
		'coins/payout/status'                        => [ 'GET' => 'economy' ],
		// the coin economy (real value moves — its own opt-in scope)
		'challenges'                                 => [ 'POST' => 'economy' ],
		'challenges/(?P<id>[0-9]+)/enter'            => [ 'POST' => 'economy' ],
		'coins/buy'                                  => [ 'POST' => 'economy' ],
		'coins/sell'                                 => [ 'POST' => 'economy' ],
		'coins/payout/connect'                       => [ 'POST' => 'economy' ],
		'bursary/apply'                              => [ 'POST' => 'economy' ],
	];

	/** The token row authenticating THIS request, or null (cookie session / anonymous). */
	private static $token = null;

	// ── Schema (self-installed, the Notify::ensure_table pattern) ────────────

	public static function ensure_table() {
		if ( get_option( 'aq_api_table_version' ) === self::TABLE_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$p = $wpdb->prefix;
		dbDelta( "CREATE TABLE {$p}aq_api_tokens (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			label VARCHAR(80) NOT NULL DEFAULT '',
			prefix VARCHAR(16) NOT NULL DEFAULT '',
			token_hash CHAR(64) NOT NULL DEFAULT '',
			scopes VARCHAR(40) NOT NULL DEFAULT 'read,write',
			calls INT UNSIGNED NOT NULL DEFAULT 0,
			last_used INT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			revoked INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			UNIQUE KEY hash (token_hash),
			KEY user (user_id, id)
		) " . $wpdb->get_charset_collate() . ';' );
		update_option( 'aq_api_table_version', self::TABLE_VERSION );
	}

	// ── Authentication (determine_current_user seam) ─────────────────────────

	/** The raw bearer token on this request, or ''. Headers only — never a query param. */
	private static function bearer() {
		$h = (string) ( $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '' );
		if ( preg_match( '/^Bearer\s+(aq_[0-9a-f]{40})$/i', trim( $h ), $m ) ) { return strtolower( $m[1] ); }
		$x = trim( (string) ( $_SERVER['HTTP_X_AQ_TOKEN'] ?? '' ) );
		return preg_match( '/^aq_[0-9a-f]{40}$/i', $x ) ? strtolower( $x ) : '';
	}

	/**
	 * determine_current_user (priority 30 — after cookie auth, which always wins).
	 * A valid, unrevoked token signs the request in as its owner; anything else falls through
	 * unchanged (the route then 401s normally).
	 *
	 * SCOPED TO OUR OWN NAMESPACE, and that is the whole security boundary. TOKEN_ROUTES is
	 * enforced by Rest::can(), which only ever runs for routes WE registered — so signing a token
	 * in across the entire /wp-json/ tree would hand it every OTHER namespace with no allow-list at
	 * all. WordPress core's own `wp/v2` is the one that matters: a subscriber may edit themselves,
	 * so `POST /wp-json/wp/v2/users/me` would let a delegated token CHANGE THE ACCOUNT'S EMAIL
	 * ADDRESS — and the author's email address is the entire publish gate. The single-use
	 * confirmation secret is sent there; redirect it and an agent publishes in its owner's name.
	 * Matching `/wp-json/aq/v1/` instead of `/wp-json/` is what makes "a route absent from
	 * TOKEN_ROUTES is session-only BY CONSTRUCTION" true of every route on the site, not just ours.
	 */
	public static function determine_user( $user_id ) {
		if ( $user_id ) { return $user_id; }
		// Match the namespace at the START of the PATH (query string stripped) — an anywhere-substring
		// test would sign a token in on e.g. /wp-admin/admin-ajax.php?x=/wp-json/aq/v1/, where no
		// permission_callback of ours ever runs. Also accept the ?rest_route= form (plain permalinks),
		// whose URI carries no '/wp-json/' at all.
		$path = strtok( (string) ( $_SERVER['REQUEST_URI'] ?? '' ), '?' );
		$ours = '/' . trim( Rest::NS, '/' ) . '/';
		$pfx  = '/' . trim( rest_get_url_prefix(), '/' ) . $ours;
		$rr   = isset( $_GET['rest_route'] ) ? (string) $_GET['rest_route'] : '';
		$is_rest = ( is_string( $path ) && strncmp( $path, $pfx, strlen( $pfx ) ) === 0 )
			|| ( $rr !== '' && strncmp( $rr, $ours, strlen( $ours ) ) === 0 );
		if ( ! $is_rest ) { return $user_id; }
		$raw = self::bearer();
		if ( $raw === '' ) { return $user_id; }
		try {
			$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_api_tokens' ) . ' WHERE token_hash = %s AND revoked = 0',
				[ hash( 'sha256', $raw ) ] );
		} catch ( \Throwable $e ) { return $user_id; }
		if ( ! $row || ! get_userdata( (int) $row['user_id'] ) ) { return $user_id; }
		self::$token = $row;
		Data::update( 'aq_api_tokens',
			[ 'calls' => (int) $row['calls'] + 1, 'last_used' => Data::now() ], [ 'id' => (int) $row['id'] ] );
		return (int) $row['user_id'];
	}

	/** A token session is never an operator, whatever its owner's role: manage_options is
	 *  stripped so no handler's operator branch is reachable through a delegated credential. */
	public static function strip_admin_caps( $allcaps ) {
		if ( self::$token ) { unset( $allcaps['manage_options'] ); }
		return $allcaps;
	}

	public static function via_token() { return self::$token !== null; }

	/**
	 * The per-route gate Rest::can() consults for token-authenticated 'user' requests.
	 * true = allowed; WP_Error = refused (WordPress serves it with the right status).
	 */
	public static function token_gate( $path, $method ) {
		$row  = self::$token;
		$need = self::TOKEN_ROUTES[ $path ][ strtoupper( (string) $method ) ] ?? '';
		if ( $need === '' ) {
			return new \WP_Error( 'token_scope', 'This endpoint accepts signed-in sessions only, never an API token. See /developers for the token-eligible surface.', [ 'status' => 403 ] );
		}
		$have = array_map( 'trim', explode( ',', (string) $row['scopes'] ) );
		if ( ! in_array( $need, $have, true ) ) {
			return new \WP_Error( 'token_scope', 'This token lacks the "' . $need . '" scope.', [ 'status' => 403 ] );
		}
		if ( Rest::throttle( 'apitok' . (int) $row['id'], self::RATE_LIMIT, HOUR_IN_SECONDS ) ) {
			return new \WP_Error( 'rate_limited', 'Token rate limit reached (' . self::RATE_LIMIT . ' requests/hour). Pause and retry.', [ 'status' => 429 ] );
		}
		return true;
	}

	// ── Token management (SESSION-ONLY: a token can never mint or revoke tokens) ──

	private static function session_only() {
		return self::via_token()
			? Rest::err( 'session_only', 'Token management needs a signed-in session — a token cannot manage tokens.', 403 )
			: null;
	}

	private static function token_item( $r ) {
		return [
			'id'        => (int) $r['id'],
			'label'     => (string) $r['label'],
			'prefix'    => (string) $r['prefix'],
			'scopes'    => array_values( array_filter( array_map( 'trim', explode( ',', (string) $r['scopes'] ) ) ) ),
			'calls'     => (int) $r['calls'],
			'last_used' => (int) $r['last_used'],
			'created'   => (int) $r['created'],
			'revoked'   => (int) $r['revoked'] > 0,
		];
	}

	/** GET api/tokens — the caller's tokens (metadata only; hashes never leave the server raw-side). */
	public static function tokens_list( $req ) {
		self::ensure_table();
		if ( $err = self::session_only() ) { return $err; }
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_api_tokens' ) . ' WHERE user_id = %d ORDER BY id DESC LIMIT 50',
			[ Rest::uid() ] ) ?: [];
		return [ 'items' => array_map( [ self::class, 'token_item' ], $rows ) ];
	}

	/** POST api/tokens {label, scopes[]} — mint one. The raw token appears in THIS response only. */
	public static function token_create( $req ) {
		self::ensure_table();
		if ( $err = self::session_only() ) { return $err; }
		if ( Rest::throttle( 'api_token_create', 10, HOUR_IN_SECONDS ) ) {
			return Rest::err( 'rate_limited', 'Too many new tokens this hour.', 429 );
		}
		$uid   = Rest::uid();
		$label = sanitize_text_field( mb_substr( (string) Rest::p( $req, 'label', '' ), 0, 80 ) );
		if ( $label === '' ) { $label = 'API token'; }
		$want   = (array) Rest::p( $req, 'scopes', [ 'read', 'write' ] );
		$scopes = array_values( array_intersect( [ 'read', 'write', 'economy' ], array_map( 'sanitize_key', $want ) ) );
		if ( ! $scopes ) { $scopes = [ 'read' ]; }
		$active = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_api_tokens' ) . ' WHERE user_id = %d AND revoked = 0', [ $uid ] );
		if ( $active >= self::MAX_TOKENS ) {
			return Rest::err( 'too_many', 'You already have ' . self::MAX_TOKENS . ' active tokens — revoke one first.', 409 );
		}
		$raw = 'aq_' . bin2hex( random_bytes( 20 ) );
		$id  = Data::insert( 'aq_api_tokens', [
			'user_id'    => $uid,
			'label'      => $label,
			'prefix'     => substr( $raw, 0, 11 ) . '…',
			'token_hash' => hash( 'sha256', $raw ),
			'scopes'     => implode( ',', $scopes ),
			'created'    => Data::now(),
		] );
		return [
			'ok'    => true,
			'token' => $raw, // shown once — only its hash survives server-side
			'note'  => 'Store this token now: it is shown only once and cannot be recovered, only revoked.',
			'item'  => self::token_item( Data::one( 'SELECT * FROM ' . Data::t( 'aq_api_tokens' ) . ' WHERE id = %d', [ (int) $id ] ) ),
		];
	}

	/** POST api/tokens/{id}/revoke — kill one of the caller's tokens (idempotent, immediate). */
	public static function token_revoke( $req ) {
		self::ensure_table();
		if ( $err = self::session_only() ) { return $err; }
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_api_tokens' ) . ' WHERE id = %d AND user_id = %d',
			[ Rest::pint( $req, 'id' ), Rest::uid() ] );
		if ( ! $row ) { return Rest::err( 'not_found', 'No such token', 404 ); }
		if ( ! (int) $row['revoked'] ) {
			Data::update( 'aq_api_tokens', [ 'revoked' => Data::now() ], [ 'id' => (int) $row['id'] ] );
		}
		return [ 'ok' => true, 'item' => self::token_item( array_merge( $row, [ 'revoked' => Data::now() ] ) ) ];
	}

	/** GET api/ping — the credential sanity check every agent should start with. */
	public static function ping( $req ) {
		$u = get_userdata( Rest::uid() );
		return [
			'ok'     => true,
			'user'   => [ 'id' => Rest::uid(), 'name' => $u ? (string) $u->display_name : '', 'slug' => $u ? (string) $u->user_nicename : '' ],
			'via'    => self::via_token() ? 'token' : 'session',
			'scopes' => self::via_token()
				? array_values( array_filter( array_map( 'trim', explode( ',', (string) self::$token['scopes'] ) ) ) )
				: [ 'read', 'write', 'economy' ],
			'rate'   => [ 'limit' => self::RATE_LIMIT, 'window' => 'hour' ],
		];
	}

	// ── Documentation (GET api/docs + GET api/openapi; human docs at /developers) ──

	/** The path params a converted OpenAPI path exposes, e.g. courses/{id} → ['id']. */
	private static function path_params( $path ) {
		preg_match_all( '/\{([a-z_]+)\}/', $path, $m );
		return $m[1] ?? [];
	}

	/** '(?P<id>[0-9]+)' segments → '{id}' (OpenAPI style); returns '' if regex residue survives. */
	private static function openapi_path( $path ) {
		$p = preg_replace( '/\(\?P<([a-z_]+)>[^)]*\)/', '{$1}', (string) $path );
		return preg_match( '/[(\[\\\\]/', $p ) ? '' : $p;
	}

	/** GET api/docs — the whole developer contract, machine-readable (agents: start here). */
	public static function docs( $req ) {
		$base = home_url( '/wp-json/aq/v1' );
		$all  = [];
		foreach ( Rest::ROUTES as [ $m, $p, $h, $a ] ) {
			$op    = self::openapi_path( $p );
			$all[] = [
				'method' => $m,
				'path'   => '/' . ( $op !== '' ? $op : $p ),
				'auth'   => $a,
				'token_scope' => $a === 'user' ? ( self::TOKEN_ROUTES[ $p ][ $m ] ?? null ) : null,
			];
		}
		return [
			'name'    => 'ArtaQuest API',
			'version' => defined( 'AQ_VERSION' ) ? AQ_VERSION : '',
			'base'    => $base,
			'docs'    => home_url( '/developers/' ),
			'openapi' => $base . '/api/openapi',
			'auth'    => [
				'how'    => 'Create a personal access token at Account → API tokens (or /developers). Send it as `Authorization: Bearer aq_…` (or `X-AQ-Token: aq_…`). Tokens are shown once, stored only as a hash, and revocable any time.',
				'check'  => 'GET ' . $base . '/api/ping',
				'scopes' => self::SCOPES,
				'notes'  => 'GET routes marked public need no auth; a token simply personalises them (your own drafts resolve). Routes marked auth=user with token_scope=null are session-only — a token is refused there by construction (account deletion, sessions, token management, passkey enrollment, cart checkout, chat, identity, operator surfaces, legacy studio-family publishing). Coins buy/sell/payout ARE reachable, under the economy scope.',
			],
			'publishing' => [
				'principle' => 'Everything up to publication is free and fully programmatic. A submission is a PUBLIC KAGGLE NOTEBOOK THAT HAS BEEN RUN: you POST its URL, choose which of its output files to publish, and an exhaustive reproducibility checklist reads the facts back from the public Kaggle API — which answers with no credential at all, so anyone can re-run the same checks and contradict us. Nothing is scored, ranked, graded or judged, and no AI reviews anything. PUBLICATION IS THE AUTHOR\'S ALONE, and cryptographically so: requesting publish emails the CONTENT CREATOR\'s own registered address a single-use confirm link; opening it, the author\'s device signs the exact work with their passkey (WebAuthn) — a private key that never exists on the server — and only that signature publishes the work and mints the permanent DOI. The signature is recorded in the public ledger and re-verified forever, so no API token, AI agent, or even a process with full server/source access can forge a publication. Publishing requires an enrolled passkey (add one at Account -> Publication signing key). Anything unconfirmed stays a private draft.',
				'flow'      => [
					'POST /studio/kernels                — attach a Kaggle notebook by URL; runs the checklist immediately',
					'GET  /studio/notebooks/{id}/outputs — list that run\'s output files (?q= filter, ?serveable=1)',
					'POST /studio/notebooks/{id}/select  — choose which files to publish {files:[]}; re-runs the checklist',
					'POST /studio/notebooks/{id}/check   — re-read Kaggle and re-run every check (after fixing something there)',
					'POST /studio/notebooks/{id}/save    — title and abstract only; the code lives on Kaggle',
					'GET  /studio/notebooks              — poll status, the stored checklist, the gate reason',
					'POST /studio/notebooks/{id}/publish — REQUEST publication -> the author gets the confirm email',
					'(author opens the emailed link)     — reviews the checklist + working deliverable, then their device passkey signs the exact source -> published + permanent DOI + files in the Library; or withdraws. No passkey enrolled = cannot publish.',
				],
				'gate'      => 'Before any human is asked: every BLOCKING check must pass — the notebook is public on Kaggle, every input dataset/model/notebook is public, it needs no private credentials, the run finished and produced files, and every file you chose downloads and is a type we can serve. Warnings (internet was on, unseeded randomness, unpinned installs, a GPU is required) are reported loudly and never block. The whole checklist is public on the work. Any edit on Kaggle voids all confirmations (everything binds to the sha1 of the exact source we pulled).',
			],
			'conventions' => [
				'errors'     => 'Non-2xx responses are { "error": code, "message": text }.',
				'lists'      => 'List endpoints return { items, next } keyset cursors — pass next back as ?cursor=. Never offsets.',
				'rate_limit' => self::RATE_LIMIT . ' requests/hour/token, plus per-action limits (20 kernel imports/hour, 40 re-checks per 10 min). 429 = pause and retry.',
				'formats'    => 'A submission is a public Kaggle notebook URL; the notebook itself lives on Kaggle and we read it back from there. Published files are mirrored to the platform CDN and listed on the work as `files`.',
			],
			'endpoints' => $all,
		];
	}

	/** GET api/openapi — OpenAPI 3.1, generated from Rest::ROUTES (the single source of truth). */
	public static function openapi( $req ) {
		$paths = [];
		foreach ( Rest::ROUTES as [ $m, $p, $h, $a ] ) {
			if ( $a === 'worker' ) { continue; } // internal daemon surface — not a public contract
			$op = self::openapi_path( $p );
			if ( $op === '' ) { continue; }
			$scope  = $a === 'user' ? ( self::TOKEN_ROUTES[ $p ][ $m ] ?? null ) : null;
			$params = array_map( static function ( $n ) {
				return [ 'name' => $n, 'in' => 'path', 'required' => true, 'schema' => [ 'type' => 'string' ] ];
			}, self::path_params( $op ) );
			$entry = [
				'operationId' => str_replace( '::', '_', $h ) . '_' . strtolower( $m ),
				'summary'     => $h . ( $a === 'user' ? ( $scope ? ' (token scope: ' . $scope . ')' : ' (session-only)' ) : '' ),
				'responses'   => [ '200' => [ 'description' => 'OK' ], '400' => [ 'description' => '{ error, message }' ] ],
			];
			if ( $params ) { $entry['parameters'] = $params; }
			if ( $a === 'user' ) { $entry['security'] = $scope ? [ [ 'bearer' => [] ] ] : [ [ 'session' => [] ] ]; }
			$paths[ '/' . $op ][ strtolower( $m ) ] = $entry;
		}
		return [
			'openapi' => '3.1.0',
			'info'    => [
				'title'       => 'ArtaQuest API',
				'version'     => defined( 'AQ_VERSION' ) ? AQ_VERSION : '0',
				'description' => 'Programmatic access to the ArtaQuest platform. Full contract: GET /api/docs; human docs: /developers. Publication requires the author\'s own emailed confirmation — no API path publishes directly.',
			],
			'servers' => [ [ 'url' => home_url( '/wp-json/aq/v1' ) ] ],
			'components' => [ 'securitySchemes' => [
				'bearer'  => [ 'type' => 'http', 'scheme' => 'bearer', 'description' => 'Personal access token (aq_…) from Account → API tokens' ],
				'session' => [ 'type' => 'apiKey', 'in' => 'cookie', 'name' => 'wordpress_logged_in', 'description' => 'Browser session — not available to API tokens' ],
			] ],
			'paths' => $paths,
		];
	}
}
