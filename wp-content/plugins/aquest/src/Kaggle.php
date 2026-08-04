<?php
namespace AQ;

/**
 * Kaggle API client — READ, mostly (operator order 2026-07-28).
 *
 * Kaggle used to be a place we pushed a copy of an already-published work to. It is now the place
 * the work LIVES and the place it RAN: a submission is the URL of a member's own public kernel, and
 * every claim the platform makes about that work is read back from here (see AQ\Kernel, which owns
 * the checklist itself).
 *
 * The read half is below the push half, and its docblock records the API's verified behaviour —
 * probed against the live service, not taken from the documentation, which is wrong or silent about
 * most of it. The single most important finding: **`kernels/pull` and `kernels/output` answer 200
 * with no credential at all.** That is what makes the platform's claims checkable by a stranger
 * rather than a matter of trusting us. We still send the Bearer token (it costs nothing and keeps
 * us on the friendly side of rate limits), but nothing in the gate depends on holding it.
 *
 * The PUSH half survives for one caller only: Science.php's journal-article reproduction notebooks,
 * which the platform authors itself. Member submissions are never pushed anywhere — pushing a
 * second copy under the platform's account would fork the work from the very artifact every
 * checklist item was read from.
 *
 * Auth: Bearer KAGGLE_TOKEN from the Vault (a write with no auth is 401; Bearer is accepted).
 * OWNER was determined empirically: it is the only ownerSlug that resolves for this token, every
 * other candidate answers "Invalid Owner Id".
 */
class Kaggle {

	/** The account this token owns. VERIFIED against the live API, 2026-07-27 — do not guess, and do
	 *  not "correct" it back to the handle that looks right:
	 *    GET /kernels/list?user=arash0ash  → the kernels this token has actually pushed
	 *    GET /kernels/list?user=arashashra → []
	 *  It was 'arashashra', so every push built a slug the token does not own and the kernel copy
	 *  could never land. Re-check with the call above if the account is ever changed. */
	const OWNER = 'arash0ash';

	const API = 'https://www.kaggle.com/api/v1';

	private static function token() { return (string) Secrets::get( 'KAGGLE_TOKEN' ); }

	public static function ready() { return '' !== self::token(); }

	/** Human-facing kernel page. */
	public static function kernel_url( $slug ) {
		return 'https://www.kaggle.com/code/' . self::OWNER . '/' . $slug;
	}

	/** One authenticated JSON call. Returns [http_code, decoded_body]. */
	private static function call( $path, $body = null, $method = 'POST' ) {
		$args = [
			'method'  => $method,
			'timeout' => 180,
			'headers' => [ 'Authorization' => 'Bearer ' . self::token(), 'Content-Type' => 'application/json' ],
		];
		if ( null !== $body ) { $args['body'] = wp_json_encode( $body ); }
		$r = wp_remote_request( self::API . $path, $args );
		if ( is_wp_error( $r ) ) { return [ 0, [ 'error' => $r->get_error_message() ] ]; }
		return [ (int) wp_remote_retrieve_response_code( $r ), json_decode( (string) wp_remote_retrieve_body( $r ), true ) ];
	}

	// ─────────────────────────────────────────────────────────────────────────────────────────
	//  READING a kernel — the submission gate (operator 2026-07-28)
	//
	//  Kaggle is no longer a mirror of a run we performed; it IS the run. A submission is a URL to
	//  a public kernel's output, so everything the checklist asserts has to be READ back from the
	//  API. The surface below was probed live against the Vault token, not taken from docs — the
	//  docs are wrong or silent about most of it. Verified 2026-07-28:
	//
	//    GET /kernels/pull    200 for ANY public kernel (including other people's) — returns the
	//                         privacy flag, the internet/accelerator flags, the sha256-pinned docker
	//                         image, all four dataSource ref lists, and blob.source (the notebook).
	//    GET /kernels/output  200 — files[{fileName,url}], nextPageToken, and the full run log.
	//    GET /datasets/view/{ref}   200 public · 403 private-or-gone
	//    GET /models/{ref}/get      200 with an explicit isPrivate
	//    GET /kernels/status  401.  GET /kernels/list  401.  GET /competitions/list  401.
	//                         These three are NOT available to this token in any auth mode — do not
	//                         "fix" them back in; infer run health from the output log instead.
	//
	//  Three traps, each of which silently produces a wrong answer:
	//    1. A private OR nonexistent kernel/dataset answers 403 ("Permission 'kernels.get' was
	//       denied"), never 404. Both mean "a reader cannot open this", which is the honest verdict.
	//    2. Output files carry NO size. HEAD on a kaggleusercontent signed URL is 404; only a ranged
	//       GET (Range: bytes=0-0 -> 206 + Content-Range: bytes 0-0/N) reveals the size.
	//    3. metadata.lastRunTime is not a run timestamp — it changes on every call for an untouched
	//       kernel. Never store or display it.
	// ─────────────────────────────────────────────────────────────────────────────────────────

	/** Listing caps: a submission may not drag the whole of Kaggle across. The per-file and
	 *  per-submission BYTE caps are policy, not transport, and live once in AQ\Kernel. */
	const MAX_OUTPUT_PAGES = 40;    // 40 x 200 = 8k files listed at most
	const OUTPUT_PAGE      = 200;

	/**
	 * Parse any Kaggle notebook URL a member might paste into [ owner, slug ].
	 *
	 * The canonical form the UI asks for is the OUTPUT tab, because that is the page an author is
	 * looking at when they decide to publish:
	 *     https://www.kaggle.com/code/arash0ash/nine-down-ace-step-xl-sft/output
	 * but every other shape of the same link resolves identically — a member should never lose a
	 * submission to a trailing tab segment. Returns null when it is not a kernel URL at all.
	 */
	public static function parse_url( $url ) {
		$url = trim( (string) $url );
		if ( '' === $url ) { return null; }
		if ( ! preg_match( '#^https?://#i', $url ) ) { $url = 'https://' . $url; }
		$p = wp_parse_url( $url );
		$host = strtolower( (string) ( $p['host'] ?? '' ) );
		if ( 'kaggle.com' !== $host && 'www.kaggle.com' !== $host ) { return null; }
		$path = trim( (string) ( $p['path'] ?? '' ), '/' );
		if ( '' === $path ) { return null; }
		$seg = explode( '/', $path );
		// /code/<owner>/<slug>[/output|/notebook|/comments|/log|/data|/edit...]  and the legacy
		// /kernels/<owner>/<slug>. Anything else (a dataset, a competition, a profile) is not a kernel.
		if ( in_array( $seg[0], [ 'code', 'kernels' ], true ) ) { array_shift( $seg ); }
		elseif ( count( $seg ) < 2 ) { return null; }
		if ( count( $seg ) < 2 ) { return null; }
		$owner = $seg[0];
		$slug  = $seg[1];
		// A Kaggle handle/slug is [A-Za-z0-9-]; reject the URL rather than build a bad API call.
		if ( ! preg_match( '/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/', $owner ) ) { return null; }
		if ( ! preg_match( '/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/', $slug ) ) { return null; }
		// Reserved first segments that can never be an owner.
		if ( in_array( strtolower( $owner ), [ 'datasets', 'competitions', 'models', 'discussions', 'learn', 'organizations', 'writeups', 'benchmarks' ], true ) ) { return null; }
		return [ 'owner' => $owner, 'slug' => $slug ];
	}

	/** Canonical human URL for an owner/slug pair (what we store and link back to). */
	public static function code_url( $owner, $slug ) {
		return 'https://www.kaggle.com/code/' . rawurlencode( $owner ) . '/' . rawurlencode( $slug );
	}

	/** One authenticated GET. Returns [ http_code, decoded_body ]. */
	private static function get( $path ) {
		$r = wp_remote_get( self::API . $path, [
			'timeout' => 60,
			'headers' => [ 'Authorization' => 'Bearer ' . self::token() ],
		] );
		if ( is_wp_error( $r ) ) { return [ 0, [ 'error' => $r->get_error_message() ] ]; }
		return [ (int) wp_remote_retrieve_response_code( $r ), json_decode( (string) wp_remote_retrieve_body( $r ), true ) ];
	}

	/**
	 * Pull a kernel's metadata + source. Returns [ code, metadata[], source_string ].
	 * code 403 is the private-or-deleted answer; treat it as "no reader can open this".
	 */
	public static function pull( $owner, $slug ) {
		if ( ! self::ready() ) { return [ 0, [], '' ]; }
		[ $code, $j ] = self::get( '/kernels/pull?userName=' . rawurlencode( $owner ) . '&kernelSlug=' . rawurlencode( $slug ) );
		if ( $code < 200 || $code >= 300 || ! is_array( $j ) ) { return [ $code, [], '' ]; }
		$meta = (array) ( $j['metadata'] ?? [] );
		$blob = (array) ( $j['blob'] ?? [] );
		$src  = (string) ( $blob['source'] ?? $blob['sourceNullable'] ?? '' );
		return [ $code, $meta, $src ];
	}

	/**
	 * List EVERY output file of a kernel, following the page token.
	 * Returns [ code, files[ ['name'=>..,'url'=>..] ], log_string, truncated_bool ].
	 *
	 * The signed URLs are minted per request and expire, so they are used immediately (to size and
	 * to mirror) and NEVER stored or handed to a browser.
	 */
	public static function output( $owner, $slug ) {
		if ( ! self::ready() ) { return [ 0, [], '', false ]; }
		$base  = '/kernels/output?userName=' . rawurlencode( $owner ) . '&kernelSlug=' . rawurlencode( $slug )
			. '&pageSize=' . self::OUTPUT_PAGE;
		$files = [];
		$log   = '';
		$token = '';
		$code  = 0;
		$trunc = false;
		for ( $page = 0; $page < self::MAX_OUTPUT_PAGES; $page++ ) {
			[ $code, $j ] = self::get( $base . ( '' !== $token ? '&pageToken=' . rawurlencode( $token ) : '' ) );
			if ( $code < 200 || $code >= 300 || ! is_array( $j ) ) { return [ $code, $files, $log, $trunc ]; }
			if ( 0 === $page ) { $log = (string) ( $j['log'] ?? $j['logNullable'] ?? '' ); }
			foreach ( (array) ( $j['files'] ?? [] ) as $f ) {
				$name = (string) ( $f['fileName'] ?? $f['fileNameNullable'] ?? '' );
				$url  = (string) ( $f['url'] ?? $f['urlNullable'] ?? '' );
				if ( '' !== $name && '' !== $url ) { $files[] = [ 'name' => $name, 'url' => $url ]; }
			}
			$token = (string) ( $j['nextPageToken'] ?? $j['nextPageTokenNullable'] ?? '' );
			if ( '' === $token ) { return [ $code, $files, $log, false ]; }
		}
		return [ $code, $files, $log, true ];
	}

	/**
	 * Size a signed output URL without downloading it.
	 *
	 * HEAD returns 404 on kaggleusercontent — the only working probe is a one-byte ranged GET, whose
	 * 206 carries `Content-Range: bytes 0-0/<total>`. Returns -1 when the size cannot be established.
	 */
	public static function size_of( $url ) {
		$r = wp_remote_get( $url, [ 'timeout' => 45, 'headers' => [ 'Range' => 'bytes=0-0' ] ] );
		if ( is_wp_error( $r ) ) { return -1; }
		$code = (int) wp_remote_retrieve_response_code( $r );
		$cr   = (string) wp_remote_retrieve_header( $r, 'content-range' );
		if ( 206 === $code && preg_match( '#/(\d+)\s*$#', $cr, $m ) ) { return (int) $m[1]; }
		if ( 200 === $code ) {
			$len = (int) wp_remote_retrieve_header( $r, 'content-length' );
			return $len > 0 ? $len : -1;
		}
		return -1;
	}

	/**
	 * Download a signed output URL to a TEMP FILE, refusing anything over $max.
	 * Returns the path — which the CALLER must unlink — or '' on failure.
	 *
	 * STREAMED, and that is the whole point. A published artifact may be up to
	 * Kernel::MAX_FILE_BYTES (512 MB), and the buffering version of this call read one of those into
	 * a PHP string before a single byte was stored: the request died on memory_limit or on the
	 * gateway's ~60 s clock long before it delivered the ceiling we advertise. `stream => true`
	 * hands the body straight to disk in fixed-size chunks, so the caller can size, hash and store
	 * from the file instead — see Kernel::mirror.
	 */
	public static function fetch_to_file( $url, $max = Kernel::MAX_FILE_BYTES ) {
		// wp_tempnam() lives in wp-admin/includes/file.php, which a REST request has NOT loaded —
		// calling it unguarded from a frontend route is a fatal, and this project has already been
		// bitten by exactly that (see the same guard in Media::put_public).
		if ( ! function_exists( 'wp_tempnam' ) ) { require_once ABSPATH . 'wp-admin/includes/file.php'; }
		$tmp = wp_tempnam( 'aq-kaggle' );
		if ( ! $tmp ) { return ''; }
		$r = wp_remote_get( $url, [
			'timeout'  => 300,   // half a gigabyte over a signed URL needs room; bounded, never infinite
			'stream'   => true,
			'filename' => $tmp,
			'headers'  => [ 'Range' => 'bytes=0-' . ( (int) $max ) ],
		] );
		if ( is_wp_error( $r ) ) { @unlink( $tmp ); return ''; }
		$code = (int) wp_remote_retrieve_response_code( $r );
		// A non-2xx STILL WRITES in stream mode — Kaggle's 403 body lands in the temp file just as
		// happily as the artifact would. Deleting it here is what stops an error page being hashed,
		// content-addressed and published under the author's name.
		if ( 200 !== $code && 206 !== $code ) { @unlink( $tmp ); return ''; }
		// wp_tempnam() creates the file EMPTY and stats it on the way (wp_unique_filename), so a
		// size-0 entry is already in PHP's stat cache by the time the transport fills it. This build
		// invalidates that entry on its own writes and production may not, and the caller's very
		// first act is filesize() — a stale 0 there would read as "could not download" on every
		// artifact we publish. One cheap line rather than a difference between two PHP builds.
		clearstatcache( true, $tmp );
		return $tmp;
	}

	/**
	 * Download a signed output URL INTO MEMORY, refusing anything over $max. '' on failure.
	 *
	 * The opt-in half of fetch_to_file(), and opt-in is the point: $max is not advisory here, because
	 * whatever comes back is held whole in this process. Use it ONLY where the bytes themselves are
	 * the deliverable rather than the file — today that is the SVG rebuild alone (Svg::clean, capped
	 * at 2 MB), which has to hand a string to the sanitiser and store the SANITISER'S output rather
	 * than what arrived. Everything else streams. There is deliberately no default for $max: a caller
	 * that cannot name the ceiling it is willing to hold in memory wants fetch_to_file().
	 */
	public static function fetch_bytes( $url, $max ) {
		$r = wp_remote_get( $url, [
			'timeout' => 60,     // small by construction — see the cap above; bounded, never infinite
			'headers' => [ 'Range' => 'bytes=0-' . ( (int) $max ) ],
		] );
		if ( is_wp_error( $r ) ) { return ''; }
		$code = (int) wp_remote_retrieve_response_code( $r );
		if ( 200 !== $code && 206 !== $code ) { return ''; }
		return (string) wp_remote_retrieve_body( $r );
	}

	/**
	 * Is an input source readable by the public? Returns [ ok, detail ].
	 *
	 * `$type` is one of dataset|model|kernel. Each has its own endpoint and its own privacy tell:
	 * datasets and kernels answer 403 when they are private OR deleted (indistinguishable, and
	 * equally fatal to a reader); a model answers 200 and states isPrivate outright.
	 */
	/**
	 * Why a source could not be read — and it must NOT read as a verdict when it is an outage.
	 * 403 is Kaggle's private-or-deleted answer; 0 is our OWN request failing (DNS, timeout, no
	 * network, no credential) and 5xx is Kaggle being down. Telling an author their dataset is
	 * private because Kaggle had a bad minute is exactly the false accusation this gate exists
	 * not to make.
	 */
	private static function why( $code ) {
		$code = (int) $code;
		if ( 403 === $code ) { return 'private or deleted'; }
		if ( 0 === $code )   { return 'could not be reached — check again in a moment'; }
		if ( $code >= 500 )  { return 'Kaggle is unavailable (HTTP ' . $code . ') — check again in a moment'; }
		return 'unreadable (HTTP ' . $code . ')';
	}

	public static function source_public( $type, $ref ) {
		$ref = trim( (string) $ref, '/ ' );
		if ( '' === $ref ) { return [ true, '' ]; }
		if ( 'dataset' === $type ) {
			[ $code, $j ] = self::get( '/datasets/view/' . $ref );
			if ( 200 === $code && is_array( $j ) ) { return [ true, (string) ( $j['title'] ?? $j['titleNullable'] ?? $ref ) ]; }
			return [ false, self::why( $code ) ];
		}
		if ( 'model' === $type ) {
			// A model ref may be owner/model or owner/model/framework/variation — /get wants the first two.
			$parts = explode( '/', $ref );
			$short = implode( '/', array_slice( $parts, 0, 2 ) );
			[ $code, $j ] = self::get( '/models/' . $short . '/get' );
			if ( 200 === $code && is_array( $j ) ) {
				$priv = ! empty( $j['isPrivate'] ) || ! empty( $j['isPrivateNullable'] );
				return $priv ? [ false, 'private' ] : [ true, (string) ( $j['title'] ?? $short ) ];
			}
			return [ false, self::why( $code ) ];
		}
		if ( 'kernel' === $type ) {
			$parts = explode( '/', $ref );
			if ( count( $parts ) < 2 ) { return [ false, 'malformed reference' ]; }
			[ $code, $meta ] = self::pull( $parts[0], $parts[1] );
			if ( 200 === $code ) {
				$priv = ! empty( $meta['isPrivate'] ) || ! empty( $meta['isPrivateNullable'] );
				return $priv ? [ false, 'private' ] : [ true, (string) ( $meta['title'] ?? $ref ) ];
			}
			return [ false, self::why( $code ) ];
		}
		return [ true, '' ];
	}

	/**
	 * Push (create or update) the kernel for a notebook row. Returns the kernel URL, or '' on failure.
	 *
	 * Idempotent by slug: Kaggle's push endpoint updates an existing kernel of the same
	 * owner/slug rather than duplicating it, so a republish after an edit lands as a new VERSION —
	 * which is what we want, since the DOI already pins the exact source that was reviewed.
	 *
	 * @param array $row  aq_notebooks row.
	 * @param array $data Optional Kaggle dataset refs ("owner/slug") the notebook reads from.
	 */
	public static function push( $row, $data = [], $internet = false ) {
		if ( ! self::ready() ) { return ''; }
		$json = (string) ( $row['ipynb_out'] ?? '' );
		if ( '' === $json ) { $json = (string) ( $row['ipynb'] ?? '' ); }
		if ( '' === $json ) { return ''; }

		$slug = self::slug( $row );
		$body = [
			'newTitle'          => mb_substr( (string) $row['title'], 0, 120 ),
			'id'                => null,
			'slug'              => self::OWNER . '/' . $slug,
			'text'              => $json,
			'language'          => 'python',
			'kernelType'        => 'notebook',
			'isPrivate'         => false,
			'enableGpu'         => false,
			// OFF by default, on purpose — see the class note. A platform submission has already proven
			// it rebuilds its deliverable with the network down, so Kaggle re-checks that claim rather
			// than mirroring our word for it. Only the journal-article reproduction notebooks opt in,
			// because those are written to `!git clone` the paper's open code and data.
			'enableInternet'    => (bool) $internet,
			'datasetDataSources'    => array_values( array_filter( (array) $data ) ),
			'competitionDataSources' => [],
			'kernelDataSources' => [],
			'categoryIds'       => [],
		];
		[ $code, $j ] = self::call( '/kernels/push', $body );
		$err = (string) ( $j['errorNullable'] ?? $j['error'] ?? '' );
		if ( $code < 200 || $code >= 300 || '' !== $err ) { return ''; }
		$url = (string) ( $j['urlNullable'] ?? $j['url'] ?? '' );
		return $url ?: self::kernel_url( $slug );
	}

	/**
	 * Push a journal article's reproduction notebook (Science.php). Same kernel contract as push(),
	 * but the row shape there is different, so the caller passes the pieces directly.
	 */
	public static function push_article( $title, $id, $notebook_json ) {
		if ( ! self::ready() || '' === (string) $notebook_json ) { return ''; }
		// internet: TRUE here and nowhere else. These notebooks are authored to fetch the article's
		// open code + data at run time (see artascience-prompt.ts), so a no-network kernel would fail
		// on its first cell. Platform submissions are the opposite case and stay offline.
		return self::push( [
			'id'        => (int) $id,
			'title'     => (string) $title,
			'ipynb_out' => (string) $notebook_json,
			'ipynb'     => (string) $notebook_json,
		], [], true );
	}

	/**
	 * Stable per-notebook slug. Kaggle slugs are lowercase, hyphenated and must be unique per owner,
	 * so the notebook id is appended — two members can legitimately title a work the same thing, and
	 * a title edit must not orphan the kernel that the published DOI points at.
	 */
	public static function slug( $row ) {
		$base = sanitize_title( (string) $row['title'] );
		$base = $base !== '' ? mb_substr( $base, 0, 40 ) : 'notebook';
		return trim( $base, '-' ) . '-aq' . (int) $row['id'];
	}
}
