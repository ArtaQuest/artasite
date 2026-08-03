<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaCloud — a member's OPTIONAL cloud shelf for their own media (operator, 2026-07-25).
 *
 * THE MODEL, and why it is this simple:
 *   • PRIVATE = the browser. My Library keeps files in IndexedDB on the device; nothing is uploaded,
 *     nothing is reachable by anyone else, and it works offline. That is the DEFAULT and it needs no
 *     server at all (artaquest-web/src/lib/media-store.ts).
 *   • CLOUD = PUBLIC. Uploading is publishing. Every writable path on this host lives inside the
 *     public web root (verified: /srv is read-only, only wp-content/uploads is writable) and is served
 *     straight off the CDN, so a stored file IS world-fetchable by URL. We do not pretend otherwise:
 *     the member is told plainly, and the row is a normal public aq_* row like everything else here.
 *     Anyone wanting privacy keeps the file in the browser — that option is always there.
 *
 * Because cloud means public, there is no encryption-at-rest, no authenticated byte route, no private
 * table and no masking: the honest design collapses into ordinary static hosting plus a quota. The
 * ONLY thing metered is disk, which is why it is priced.
 *
 * NOT THE FEED. These are the member's own files, not reproducible notebooks. They can never enter
 * /works: the feed is built exclusively from aq_notebooks rows through the objective gate + veto panel
 * + dual email approval, and nothing here shares that id space or touches Notebook at all. Cloud media
 * surfaces only on the member's own Library page.
 *
 * QUOTA. 100 MB free for every member. More is bought with ArtaCoin through the append-only coin
 * ledger (Economy::credit_coins with a negative delta), so a purchase is auditable like every other
 * movement of money on this platform. Capacity is PERMANENT once bought — this Foundation does not
 * rent shelf space and then delete a member's files when they stop paying.
 */
final class Media {

	/** Free grant for every member, in bytes. */
	const FREE_BYTES = 104857600;            // 100 MB

	/** Bytes of capacity granted per ArtaCoin (operator, 2026-07-25). 1 ₳ = 1 mg gold ≈ CAD 0.18 at
	 *  today's spot; 100 MB on R2 costs ≈ CAD 0.002/month, so one coin funds that shelf for ~92 months.
	 *  Permanent capacity, not rent — which only works because the runway per coin is measured in
	 *  YEARS. (1 GiB/coin, the first guess, funded only ~9 months and would have gone underwater.) */
	const BYTES_PER_COIN = 104857600;        // 100 MB

	/** Largest single file. Chunked upload keeps each request under the host's 100M post cap. */
	const FILE_MAX = 2147483648;             // 2 GB
	const CHUNK_MAX = 8388608;               // 8 MB per part

	/** Kinds we accept, and the extensions each allows. Anything else is refused outright — this is a
	 *  media shelf, not general file hosting. */
	const KINDS = [
		'music' => [ 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'wav', 'opus' ],
		'video' => [ 'mp4', 'm4v', 'webm', 'mov' ],
		'doc'   => [ 'pdf' ],
	];

	// ── CDN ──────────────────────────────────────────────────────────────────
	//
	// Media is served from a CDN, not from this origin. The pick is Cloudflare R2, and the reason is
	// specifically that it charges NOTHING for egress at any volume — bandwidth, not disk, is what
	// bankrupts a media platform, and the operator wants this to grow into video. Its free tier
	// (10 GB stored, 1M writes, 10M reads) covers ~100 members' free grants at zero cost, and beyond
	// that storage is $0.015/GB-month, which is what makes 100 MB per coin fund ~92 months.
	//
	// DORMANT UNTIL CONFIGURED — the same discipline the crawlers use. With no credentials in the
	// Vault, files are stored on this origin and served from uploads/, exactly as before; the moment
	// AQ_R2_* is set, new uploads go to R2 and are served from AQ_MEDIA_CDN. Nothing half-configured
	// ever runs: r2_ready() requires the whole set.

	/**
	 * Count one R2 operation against this month's free-tier budget ('a' = write/list, 'b' = read).
	 *
	 * A LOWER BOUND, deliberately: it counts only operations this code issues. Public reads through
	 * the r2.dev domain never touch PHP and cannot be counted here — those need Cloudflare's
	 * analytics API, which the current AQ_CF_API_TOKEN is not authorised for ("not authorized for
	 * that account" on r2OperationsAdaptiveGroups). usage() says so rather than implying the number
	 * is complete.
	 */
	private static function bump_ops( $class, $n = 1 ) {
		if ( ! class_exists( '\AQ\Economy' ) ) { return; }
		Economy::counter_add( 'r2' . $class . ':' . gmdate( 'Ym' ), (int) $n );
	}

	/**
	 * A BUCKET-level signed request (ListObjectsV2 and friends), which needs a signed query string —
	 * r2() signs an empty one because every other call it makes is object-level. Returns [code, body].
	 */
	private static function r2_query( $method, $key, $query ) {
		$account = Secrets::get( 'AQ_R2_ACCOUNT' );
		$bucket  = Secrets::get( 'AQ_R2_BUCKET' );
		$ak      = Secrets::get( 'AQ_R2_KEY' );
		$sk      = Secrets::get( 'AQ_R2_SECRET' );
		$host    = $account . '.r2.cloudflarestorage.com';
		$path    = '/' . rawurlencode( $bucket ) . ( '' !== $key ? '/' . str_replace( '%2F', '/', rawurlencode( $key ) ) : '' );
		$now     = gmdate( 'Ymd\THis\Z' );
		$day     = substr( $now, 0, 8 );
		$payload = 'UNSIGNED-PAYLOAD';

		$sign = [ 'host' => $host, 'x-amz-content-sha256' => $payload, 'x-amz-date' => $now ];
		ksort( $sign );
		$canonHeaders = '';
		foreach ( $sign as $hk => $hv ) { $canonHeaders .= $hk . ':' . $hv . "\n"; }
		$signed = implode( ';', array_keys( $sign ) );
		$canon  = "{$method}\n{$path}\n{$query}\n{$canonHeaders}\n{$signed}\n{$payload}";
		$scope  = "{$day}/auto/s3/aws4_request";
		$toSign = "AWS4-HMAC-SHA256\n{$now}\n{$scope}\n" . hash( 'sha256', $canon );
		$k = hash_hmac( 'sha256', $day, 'AWS4' . $sk, true );
		$k = hash_hmac( 'sha256', 'auto', $k, true );
		$k = hash_hmac( 'sha256', 's3', $k, true );
		$k = hash_hmac( 'sha256', 'aws4_request', $k, true );
		$sig = hash_hmac( 'sha256', $toSign, $k );

		$res = wp_remote_request( 'https://' . $host . $path . ( $query ? '?' . $query : '' ), [
			'method'  => $method,
			'timeout' => 60,
			'headers' => [
				'Authorization'        => 'AWS4-HMAC-SHA256 Credential=' . $ak . '/' . $scope . ', SignedHeaders=' . $signed . ', Signature=' . $sig,
				'x-amz-content-sha256' => $payload,
				'x-amz-date'           => $now,
			],
		] );
		self::bump_ops( 'a' );   // a LIST is a Class A operation
		if ( is_wp_error( $res ) ) { return [ 0, '' ]; }
		return [ (int) wp_remote_retrieve_response_code( $res ), (string) wp_remote_retrieve_body( $res ) ];
	}

	/** A counted read of a public CDN URL (Class B), so migration/reclaim probes stay on the books. */
	private static function cdn_head( $url, $timeout = 20 ) {
		self::bump_ops( 'b' );
		return wp_remote_head( $url, [ 'timeout' => $timeout ] );
	}

	public static function r2_ready() {
		foreach ( [ 'AQ_R2_ACCOUNT', 'AQ_R2_BUCKET', 'AQ_R2_KEY', 'AQ_R2_SECRET' ] as $k ) {
			if ( ! Secrets::get( $k ) ) { return false; }
		}
		return true;
	}

	/** Public base for media URLs: the CDN when set, else this origin's uploads directory. */
	public static function cdn_base() {
		$cdn = trim( (string) Secrets::get( 'AQ_MEDIA_CDN' ) );
		if ( $cdn ) { return untrailingslashit( $cdn ); }
		[ , $base ] = self::dir();
		return untrailingslashit( $base );
	}

	/**
	 * Sign and send one S3-compatible request to R2 with AWS SigV4. Written by hand because this
	 * plugin carries no dependencies — it is ~40 lines and avoids pulling the AWS SDK in for two verbs.
	 * $body may be a string or a path to stream (PUT of a large file must not be read into memory).
	 */
	private static function r2( $method, $key, $bodyFile = '', $mime = 'application/octet-stream', $amz = [] ) {
		$account = Secrets::get( 'AQ_R2_ACCOUNT' );
		$bucket  = Secrets::get( 'AQ_R2_BUCKET' );
		$ak      = Secrets::get( 'AQ_R2_KEY' );
		$sk      = Secrets::get( 'AQ_R2_SECRET' );
		$host    = $account . '.r2.cloudflarestorage.com';
		$path    = '/' . rawurlencode( $bucket ) . '/' . str_replace( '%2F', '/', rawurlencode( $key ) );
		$now     = gmdate( 'Ymd\THis\Z' );
		$day     = substr( $now, 0, 8 );
		$region  = 'auto';
		$service = 's3';

		// R2 accepts UNSIGNED-PAYLOAD, which lets us stream a 2 GB file without hashing it twice.
		$payload = 'UNSIGNED-PAYLOAD';
		// $amz adds headers that must be SIGNED (lowercase keys) — CopyObject's x-amz-copy-source and
		// x-amz-metadata-directive have to be, and signing cache-control/content-type alongside them is
		// legal and keeps one code path. SigV4 requires canonical headers sorted by lowercase name, so
		// build the list and ksort it rather than hand-writing an order that a new header would break.
		$sign = array_merge( [
			'host'                 => $host,
			'x-amz-content-sha256' => $payload,
			'x-amz-date'           => $now,
		], array_change_key_case( (array) $amz, CASE_LOWER ) );
		ksort( $sign );
		$canonHeaders = '';
		foreach ( $sign as $hk => $hv ) { $canonHeaders .= $hk . ':' . trim( (string) $hv ) . "\n"; }
		$signed = implode( ';', array_keys( $sign ) );
		$canon  = "{$method}\n{$path}\n\n{$canonHeaders}\n{$signed}\n{$payload}";
		$scope  = "{$day}/{$region}/{$service}/aws4_request";
		$toSign = "AWS4-HMAC-SHA256\n{$now}\n{$scope}\n" . hash( 'sha256', $canon );
		$k = hash_hmac( 'sha256', $day, 'AWS4' . $sk, true );
		$k = hash_hmac( 'sha256', $region, $k, true );
		$k = hash_hmac( 'sha256', $service, $k, true );
		$k = hash_hmac( 'sha256', 'aws4_request', $k, true );
		$sig = hash_hmac( 'sha256', $toSign, $k );

		$headers = [
			'Authorization: AWS4-HMAC-SHA256 Credential=' . $ak . '/' . $scope . ', SignedHeaders=' . $signed . ', Signature=' . $sig,
			'x-amz-content-sha256: ' . $payload,
			'x-amz-date: ' . $now,
			'Host: ' . $host,
		];
		// Every signed extra must go out with the SAME value it was signed with, or R2 rejects it.
		foreach ( array_change_key_case( (array) $amz, CASE_LOWER ) as $hk => $hv ) { $headers[] = $hk . ': ' . $hv; }
		$ch = curl_init( 'https://' . $host . $path );
		curl_setopt_array( $ch, [
			CURLOPT_CUSTOMREQUEST  => $method,
			CURLOPT_RETURNTRANSFER => true,
			CURLOPT_TIMEOUT        => 600,     // a 2 GB upload needs room; bounded, never infinite
			CURLOPT_CONNECTTIMEOUT => 15,
		] );
		if ( 'PUT' === $method && $bodyFile && file_exists( $bodyFile ) ) {
			$fh = fopen( $bodyFile, 'rb' );
			$headers[] = 'Content-Type: ' . $mime;
			$headers[] = 'Cache-Control: ' . self::CACHE_CONTROL;   // see CACHE_CONTROL: protects the read allowance
			curl_setopt_array( $ch, [ CURLOPT_UPLOAD => true, CURLOPT_INFILE => $fh, CURLOPT_INFILESIZE => filesize( $bodyFile ) ] );
		}
		curl_setopt( $ch, CURLOPT_HTTPHEADER, $headers );
		$out  = curl_exec( $ch );
		$code = (int) curl_getinfo( $ch, CURLINFO_HTTP_CODE );
		curl_close( $ch );
		self::bump_ops( in_array( $method, [ 'PUT', 'POST', 'DELETE' ], true ) ? 'a' : 'b' );
		if ( isset( $fh ) && is_resource( $fh ) ) { fclose( $fh ); }
		return [ $code, (string) $out ];
	}

	/**
	 * Store a string of bytes at an exact public key, and answer whether it is live.
	 *
	 * The Library's mirror step needs this (AQ\Kernel::mirror): bytes arrive from Kaggle in memory
	 * under a content-addressed key we choose, with no member upload, no quota and no aq_media row
	 * — a published artifact belongs to the work that produced it, not to anyone's shelf.
	 *
	 * Content-addressed keys are never rewritten, so the CDN's year-long cache is safe by
	 * construction: different bytes always mean a different key. When R2 is not configured the file
	 * lands in this origin's uploads directory and is served from there, exactly as uploads are.
	 */
	public static function put_public( $key, $bytes, $mime = 'application/octet-stream' ) {
		$key = ltrim( (string) $key, '/' );
		if ( '' === $key || '' === (string) $bytes ) { return false; }
		// wp_tempnam() lives in wp-admin/includes/file.php, which a REST request has NOT loaded —
		// calling it unguarded from a frontend route is a fatal, and this project has already been
		// bitten by exactly that. Load it on demand.
		if ( ! function_exists( 'wp_tempnam' ) ) { require_once ABSPATH . 'wp-admin/includes/file.php'; }
		$tmp = wp_tempnam( basename( $key ) );
		// A short write must never read as success: file_put_contents returns the BYTE COUNT, and a
		// full disk returns a number smaller than the payload rather than false.
		if ( ! $tmp ) { return false; }
		$wrote = file_put_contents( $tmp, $bytes );
		if ( false === $wrote || $wrote !== strlen( $bytes ) ) { @unlink( $tmp ); return false; }
		$ok = false;
		if ( self::r2_ready() ) { $ok = self::to_cdn( $key, $tmp, $mime ); }
		// An inert file ALSO gets a copy on this origin, and that copy is the address url() hands
		// out. The CDN's public name is a pub-*.r2.dev development hostname: Cloudflare rate-limits
		// it, does not intend it for production, and — because it is a favourite of malware hosts —
		// security filters and some ISPs blackhole the whole *.r2.dev name. Measured 2026-07-30: on
		// a normal home connection every *.r2.dev TLS handshake is dropped while the SAME Cloudflare
		// IP answers another hostname instantly, so a file that lives only there is invisible to a
		// real share of visitors. R2 stays the durable, off-origin copy; this one is what is served.
		//
		// THE MIRROR IS NOT FOR SCRIPT-CAPABLE FILES — see ORIGIN_SERVABLE. The CDN being a
		// DIFFERENT ORIGIN is what makes a published .html or .svg harmless: whatever it runs, it
		// runs over there. Reachability is worth a copy; same-origin script execution is not.
		// ONE allow-list, ONE code path. The old rescue branch — "R2 failed, and the type is at
		// least not risky_inline, so drop it on the origin" — is deliberately gone: it was a
		// DENY-list deciding what may sit in the web root, and one failed R2 PUT was enough to
		// land an attacker-named .pdf (or any type nobody had thought about) on artaquest.com at
		// a URL its author could compute in advance. Worse, HEAD's url() then advertised the CDN
		// copy that had just failed to write, so those rescued bytes were unreachable anyway.
		// A non-servable type whose R2 PUT fails now returns false honestly.
		//
		// The one surviving exception is "there is no CDN AT ALL" — a developer machine with no
		// AQ_R2_* secrets, where the origin is the only store in existence and refusing every
		// upload would make the plugin unusable locally. That is a configuration state, not a
		// runtime failure, and it cannot arise on production.
		// A sanitised SVG is script-capable BY EXTENSION and inert BY CONTENT, so risky_inline() alone
		// would refuse it here on a machine with no CDN — leaving the only store in existence with no
		// copy of the file. origin_servable() has the bytes and is the authority; risky_inline() is
		// only the shortcut for the types nobody validates.
		if ( ! self::r2_ready() && ( ! self::risky_inline( $key ) || self::origin_servable( $key, $bytes ) ) ) {
			[ $dir ] = self::dir();
			$dest = trailingslashit( $dir ) . $key;
			wp_mkdir_p( dirname( $dest ) );
			$ok = (bool) @copy( $tmp, $dest );
			@unlink( $tmp );
			return $ok;
		}
		if ( self::origin_servable( $key, $bytes ) ) {
			[ $dir ] = self::dir();
			$dest = trailingslashit( $dir ) . $key;
			wp_mkdir_p( dirname( $dest ) );
			// R2 is meant to be the durable copy, so a mirror-only success must not look identical
			// to a full success: url() prefers the origin, which would make a silently
			// single-copy file render perfectly while its durable write was failing every time.
			if ( @copy( $tmp, $dest ) ) {
				if ( ! $ok && self::r2_ready() ) {
					error_log( 'AQ Media: R2 PUT failed for ' . $key . ' — serving the origin mirror only (NOT durable).' );
				}
				$ok = true;
			}
		}
		@unlink( $tmp );
		return $ok;
	}

	/** Extensions a browser will execute in the serving origin's context. */
	private static function risky_inline( $key ) {
		$ext = strtolower( (string) pathinfo( (string) $key, PATHINFO_EXTENSION ) );
		return in_array( $ext, [ 'html', 'htm', 'svg', 'xhtml', 'xml', 'js', 'mjs' ], true );
	}

	/**
	 * Extensions we are willing to serve from THIS origin.
	 *
	 * An ALLOW-list, and deliberately not the inverse of risky_inline(). The names here come off
	 * Kaggle output files, chosen by whoever wrote the notebook, and any member may submit any
	 * public kernel — so the extension is attacker-influenced. A deny-list has to anticipate every
	 * form a browser will execute in-origin (.xht, .shtml, .xsl, .htc, uppercase, and the .php*
	 * family the server itself might run) and is wrong the day it misses one. An allow-list only
	 * has to name the inert ones, and an unfamiliar extension FAILS CLOSED: it keeps the
	 * cross-origin CDN address it has today, which is exactly the safe status quo.
	 *
	 * THIS LIST IS DELIBERATELY SMALLER THAN "everything inert". Measured on prod 2026-07-30:
	 * uploads responses carry NO `X-Content-Type-Options: nosniff`, there is no .htaccess and no
	 * hook that can add one to a static nginx path, and the page CSP is `script-src 'self'` —
	 * which a static uploads response never sees anyway. A classic `<script src>` ignores
	 * Content-Type for a SAME-ORIGIN url, and the bytes here are attacker-influenced (any member
	 * may submit any public kernel, and its author chose the file's contents). So the extension is
	 * the ONLY control we can actually enforce, and no extension makes bytes un-craftable into
	 * valid JavaScript — the `GIF89a=1;` polyglot is the standing counter-example.
	 *
	 * The list is therefore scoped to what has to RENDER IN AN ELEMENT to fix the outage —
	 * video, audio, raster images and 3D meshes — and not widened to the download-only types
	 * (csv/json/parquet/safetensors/zip/…), which gain far less from being same-origin. THE MIRROR
	 * IS TACTICAL. The real fix is a custom hostname on the bucket, which restores every type at
	 * once with no same-origin exposure at all; see the note on cdn_base().
	 *
	 * Never `html`, and never `pdf`: PDF carries JavaScript and nginx would serve it inline, with no
	 * way for us to force a Content-Disposition on a static path. Both keep the CDN address and stay
	 * unreachable wherever r2.dev is filtered — a known, accepted gap, and widening this list is the
	 * wrong way to close it. `svg` is the ONE exception, and it is not on this list: it is on
	 * ORIGIN_SERVABLE_SANITISED below, which is gated on the BYTES rather than the extension.
	 */
	const ORIGIN_SERVABLE = [
		'mp4', 'webm', 'mov', 'm4v',                                // video
		'mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'flac',          // audio
		'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico',  // raster images — never svg
		'obj', 'glb', 'gltf', 'stl', 'ply',                         // 3D meshes (Kernel model3d)
	];

	/**
	 * Extensions servable from THIS origin ONLY as bytes that are byte-identical to Svg::clean()'s
	 * own output. The extension alone grants nothing here — see origin_servable().
	 *
	 * WHY SVG IS ADMITTED AT ALL. Measured 2026-07-30: a procedural animation shipped as a
	 * pre-rendered video is destroyed by DISPLAY SCALING, not by its codec. A 1080px-wide video in a
	 * ~430px feed card thins a 9px hairline to 3.6px and loses 58% of the direction signal the effect
	 * depends on, and no encode setting fixes it, because the card is 430px on one device and 1290px
	 * on another. An animated SVG in an <img> holds that hairline CONSTANT at every card size and
	 * every devicePixelRatio (vector-effect="non-scaling-stroke", verified in Chrome at 430@1x,
	 * 430@2x, 430@3x, 600 and 1080), for 14.9 KB against 599 KB. Leaving it on the CDN alone is not a
	 * neutral choice: pub-*.r2.dev is blackholed on a real share of networks, so the work itself
	 * would be invisible to those readers while its poster.png rendered fine.
	 *
	 * WHY IT IS SAFE ONCE SANITISED — the top-level-navigation problem, stated and answered.
	 * <img> does not execute scripts; a TOP-LEVEL NAVIGATION to the same URL does, with this origin's
	 * authority, and nothing about serving from uploads/ prevents someone opening the file directly.
	 * So <img> safety is NOT the argument. The argument is that after Svg::clean() there is nothing
	 * left for a document context to run:
	 *
	 *   1. NO SCRIPT AT ALL. <script>, <foreignObject>, <iframe>, <handler>, every on* attribute and
	 *      every javascript:/vbscript: value are refused — not stripped, refused, so a file that
	 *      contains one is never published in any form. It is an ALLOW-LIST, so the constructs nobody
	 *      has thought of are refused too, which is the only property that survives contact with an
	 *      attacker-influenced input.
	 *   2. NO PARSER DIFFERENTIAL. The served bytes are OUR OWN serialisation of a document we
	 *      rebuilt node by node — not the author's file with parts removed. Sanitisers get broken by
	 *      making our parser and the browser's disagree about the same bytes; there are no such bytes
	 *      here. hash_equals() below enforces exactly that: bytes that merely PASS the check are
	 *      still refused unless they ARE the check's output.
	 *   3. NO NETWORK. Every href is a bare same-document #fragment and every url() names a #id in
	 *      the same file, so the document makes no request, to us or to anyone. This is a hard
	 *      requirement quite apart from execution: img-src allows https:, so one remote reference
	 *      would be a third-party beacon fired on every feed impression.
	 *   4. NOTHING TO PHISH WITH. <a> is not on the allow-list, so a document opened at its own URL
	 *      renders a picture on artaquest.com with no clickable navigation and no form.
	 *   5. NOSNIFF IS NOT NEEDED FOR THIS. The missing X-Content-Type-Options on uploads is real and
	 *      unfixable on Atomic, and it is why this list stays tiny — but its danger is a same-origin
	 *      <script src> ignoring Content-Type, and that vector needs the bytes to parse as
	 *      JavaScript. Our output always begins with `<?xml` or `<svg`, which is a JS syntax error on
	 *      the first token, and it is our output rather than the author's precisely so that this is a
	 *      statement about bytes we control rather than bytes they chose.
	 *
	 * WHAT IS DELIBERATELY NOT CLAIMED: that SVG is inert (it is not), that <img> makes it safe (it
	 * does not), or that this reasoning transfers to any other type. It is one extension, admitted on
	 * one narrowly-argued basis, gated on bytes. The R2 copy is written for durability exactly as
	 * before, and if the sanitiser ever refuses, the origin copy simply does not appear.
	 */
	const ORIGIN_SERVABLE_SANITISED = [ 'svg' ];

	/**
	 * True when this key is inert enough to serve from artaquest.com itself.
	 *
	 * $bytes is the CONTENT that will be written. It is required — and re-validated — for anything on
	 * ORIGIN_SERVABLE_SANITISED, and ignored for the plain inert list. Omitting it therefore fails
	 * closed for an SVG, which is what makes every caller that has no bytes to offer safe by default.
	 */
	private static function origin_servable( $key, $bytes = null ) {
		$key = (string) $key;
		// A key is content-addressed and machine-built (Kernel::mirror: aq-library/<sha[0:2]>/<sha>.<ext>),
		// so anything that is not a plain relative path is a caller bug or an attack — and this
		// function gates a WRITE INTO THE WEB ROOT. Refuse before the extension is even considered.
		if ( '' === $key || ! preg_match( '#^[A-Za-z0-9][A-Za-z0-9._/-]*$#', $key )
			|| false !== strpos( $key, '..' ) || false !== strpos( $key, '//' ) ) {
			return false;
		}
		$ext = strtolower( (string) pathinfo( $key, PATHINFO_EXTENSION ) );
		if ( in_array( $ext, self::ORIGIN_SERVABLE, true ) ) {
			// The risky_inline() re-check is belt and braces: it cannot fire given the list above, and
			// it is here so that carelessly adding 'svg' to ORIGIN_SERVABLE still cannot serve one —
			// the sanitised path below is the ONLY way an SVG reaches the web root.
			return ! self::risky_inline( $key );
		}
		if ( in_array( $ext, self::ORIGIN_SERVABLE_SANITISED, true ) ) {
			if ( null === $bytes || '' === (string) $bytes ) { return false; }
			// hash_equals, not merely ok: bytes that PASS the sanitiser are still refused unless they
			// ARE the sanitiser's output. See point 2 of the note on ORIGIN_SERVABLE_SANITISED.
			return Svg::is_clean( (string) $bytes );
		}
		return false;
	}

	/**
	 * Could a key of this shape ever have an origin copy? Extension and path shape only — it decides
	 * whether it is worth LOOKING for a local file, never whether one may be written.
	 *
	 * url() needs this because it is handed a key and nothing else. That is safe: a local copy exists
	 * only because origin_servable() approved the bytes at write time, so is_file() is the proof and
	 * this is just the lookup. Writing is gated on content; reading is gated on the write having
	 * happened.
	 */
	private static function origin_hosted_ext( $key ) {
		$key = (string) $key;
		if ( '' === $key || ! preg_match( '#^[A-Za-z0-9][A-Za-z0-9._/-]*$#', $key )
			|| false !== strpos( $key, '..' ) || false !== strpos( $key, '//' ) ) {
			return false;
		}
		$ext = strtolower( (string) pathinfo( $key, PATHINFO_EXTENSION ) );
		return in_array( $ext, self::ORIGIN_SERVABLE, true ) || in_array( $ext, self::ORIGIN_SERVABLE_SANITISED, true );
	}

	/**
	 * Put an origin copy beside every Library object that should have one, and report what it did.
	 *
	 * The mirror lives under wp-content/uploads, which — unlike the R2 bucket — is a sync and
	 * restore target: a `studio pull`, a WP.com backup restore, or a push that forgets
	 * `--options plugins` can take it away. url() then falls back to the CDN address SILENTLY and
	 * the site is quietly back in the outage. So the mirror must be re-creatable on demand rather
	 * than being something a person once did by hand, and this is that routine. Idempotent: an
	 * object that is already present with the right sha256 is left alone.
	 *
	 *   studio wp eval 'print_r( AQ\Media::backfill_origin() );'
	 *
	 * @param bool $dry true = report what WOULD be written, touch nothing.
	 */
	public static function backfill_origin( $dry = false ) {
		$out  = [ 'have' => 0, 'wrote' => 0, 'skipped_type' => 0, 'failed' => [] ];
		$rows = Data::all( 'SELECT id, name, cdn_key, sha256, bytes FROM ' . Data::t( 'aq_library' ) );
		[ $dir ] = self::dir();
		foreach ( (array) $rows as $r ) {
			$key = (string) ( $r['cdn_key'] ?? '' );
			if ( '' === $key ) { continue; }
			// Extension first (cheap, no bytes yet); the CONTENT gate for a sanitised type runs below,
			// once the object has been pulled back and its digest checked. A file that no longer
			// satisfies the sanitiser is counted as skipped and simply keeps the CDN address.
			if ( ! self::origin_hosted_ext( $key ) ) { $out['skipped_type']++; continue; }
			$dest = trailingslashit( $dir ) . $key;
			if ( is_file( $dest ) && (int) filesize( $dest ) === (int) $r['bytes'] ) { $out['have']++; continue; }
			if ( $dry ) { $out['wrote']++; continue; }
			// Read through the SIGNED S3 endpoint, not the public hostname: this code runs wherever
			// the operator runs it, and the public r2.dev name is exactly the thing that may be
			// unreachable from there.
			[ $code, $body ] = self::r2( 'GET', $key );
			if ( $code < 200 || $code >= 300 || '' === $body ) {
				$out['failed'][ $key ] = 'r2 GET ' . $code;
				continue;
			}
			// The stored digest is the whole point of a content-addressed store — never write bytes
			// that do not match it, or the mirror silently becomes a different file from the one
			// the author's confirmation signature covers.
			if ( (string) $r['sha256'] !== hash( 'sha256', $body ) ) {
				$out['failed'][ $key ] = 'sha256 mismatch';
				continue;
			}
			// The content gate, with the bytes in hand. Inert types pass on their extension; an SVG
			// must still BE the sanitiser's own output — which it is, because Kernel::mirror stored
			// that and the digest above proves these are the same bytes. Re-asserting it here means
			// the web root is never written from a path that merely trusted the database.
			if ( ! self::origin_servable( $key, $body ) ) { $out['skipped_type']++; continue; }
			wp_mkdir_p( dirname( $dest ) );
			if ( false === file_put_contents( $dest, $body ) ) { $out['failed'][ $key ] = 'write failed'; continue; }
			$out['wrote']++;
		}
		return $out;
	}

	/** Move a committed local file to the CDN. Returns true when the object is live there. */
	private static function to_cdn( $key, $path, $mime ) {
		if ( ! self::r2_ready() ) { return false; }
		[ $code ] = self::r2( 'PUT', $key, $path, $mime );
		return $code >= 200 && $code < 300;
	}

	/** uploads/aq-media — created on first use. Public by design (see the class note). */
	private static function dir() {
		$up  = wp_upload_dir();
		$dir = trailingslashit( $up['basedir'] ) . 'aq-media';
		if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		return [ $dir, trailingslashit( $up['baseurl'] ) . 'aq-media' ];
	}

	/**
	 * Public URL for a stored file — this origin when we hold an inert copy, else the CDN.
	 *
	 * Prefers the origin because the CDN's pub-*.r2.dev hostname is unreachable on a real share of
	 * networks (see put_public). The is_file() test is what makes the preference safe rather than
	 * hopeful: a key with no local copy — every file written before the mirror existed, and every
	 * script-capable file, which is never mirrored — keeps the CDN address it already had. This
	 * cannot turn a working URL into a 404; it can only upgrade one we can actually serve.
	 */
	public static function url( $stored ) {
		$stored = ltrim( (string) $stored, '/' );
		// origin_hosted_ext(), not origin_servable(): there are no bytes here to re-validate, and the
		// is_file() test below is the real gate — an SVG has a local copy ONLY because the sanitiser
		// approved its exact bytes when it was written.
		if ( '' !== $stored && false === strpos( $stored, '..' ) && self::origin_hosted_ext( $stored ) ) {
			$up = wp_upload_dir();
			if ( is_file( trailingslashit( $up['basedir'] ) . 'aq-media/' . $stored ) ) {
				return trailingslashit( $up['baseurl'] ) . 'aq-media/' . $stored;
			}
		}
		return trailingslashit( self::cdn_base() ) . $stored;
	}

	// ── quota ────────────────────────────────────────────────────────────────

	/** Bytes of capacity this member has: the free grant plus everything they have bought. Derived
	 *  from the append-only ledger, never a mutable stored number. */
	public static function capacity( $uid ) {
		$bought = (int) Data::col(
			'SELECT COALESCE(SUM(bytes),0) FROM ' . Data::t( 'aq_media_grants' ) . ' WHERE user_id = %d',
			[ (int) $uid ]
		);
		return self::FREE_BYTES + $bought;
	}

	/** Bytes this member currently stores (committed files only). */
	public static function used( $uid ) {
		return (int) Data::col(
			'SELECT COALESCE(SUM(bytes),0) FROM ' . Data::t( 'aq_media' ) . ' WHERE user_id = %d AND state = %s',
			[ (int) $uid, 'ready' ]
		);
	}

	/** GET media/quota — what the member has, what they are using, and what a coin buys. */
	public static function quota( $req ) {
		$uid = get_current_user_id();
		if ( ! $uid ) { return Rest::err( 'auth', 'Sign in first', 401 ); }
		$cap = self::capacity( $uid );
		$use = self::used( $uid );
		return [
			'used'            => $use,
			'capacity'        => $cap,
			'free'            => max( 0, $cap - $use ),
			'free_grant'      => self::FREE_BYTES,
			'bytes_per_coin'  => self::BYTES_PER_COIN,
			'balance'         => Economy::coin_balance( $uid ),
			'file_max'        => self::FILE_MAX,
			'cdn'             => self::r2_ready(),
		];
	}

	/** POST media/buy { coins } — spend ArtaCoin for permanent capacity. */
	public static function buy( $req ) {
		$uid = get_current_user_id();
		if ( ! $uid ) { return Rest::err( 'auth', 'Sign in first', 401 ); }
		if ( Rest::throttle( 'aq_media_buy', 6, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$coins = (int) $req->get_param( 'coins' );
		if ( $coins < 1 || $coins > 1000 ) { return Rest::err( 'bad_amount', 'Choose between 1 and 1000 coins', 400 ); }
		if ( Economy::coin_balance( $uid ) < $coins ) { return Rest::err( 'insufficient', 'Not enough ArtaCoin', 400 ); }

		$bytes = $coins * self::BYTES_PER_COIN;
		// The grant row is written FIRST with a unique ref; the charge carries the same ref, so a
		// replayed request cannot double-charge (Economy::credit_coins is idempotent per ref).
		$ref = 'media-cap:' . $uid . ':' . Data::now() . ':' . wp_generate_password( 6, false, false );
		$id  = Data::insert( 'aq_media_grants', [
			'user_id' => $uid, 'bytes' => $bytes, 'coins' => $coins, 'ref' => $ref, 'created' => Data::now(),
		] );
		if ( ! $id ) { return Rest::err( 'write_failed', 'Could not record the purchase', 500 ); }
		Economy::credit_coins( $uid, -$coins, 'media-capacity', $ref );
		return [ 'ok' => true, 'bytes' => $bytes, 'capacity' => self::capacity( $uid ), 'balance' => Economy::coin_balance( $uid ) ];
	}

	// ── upload (chunked: begin → part → commit) ──────────────────────────────

	private static function kind_for( $name ) {
		$ext = strtolower( (string) pathinfo( $name, PATHINFO_EXTENSION ) );
		foreach ( self::KINDS as $kind => $exts ) { if ( in_array( $ext, $exts, true ) ) { return [ $kind, $ext ]; } }
		return [ '', '' ];
	}

	/** POST media/begin { name, bytes } — reserve a row and return the id to send parts against. */
	public static function begin( $req ) {
		$uid = get_current_user_id();
		if ( ! $uid ) { return Rest::err( 'auth', 'Sign in first', 401 ); }
		if ( Rest::throttle( 'aq_media_begin', 30, 300 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$name  = sanitize_file_name( (string) $req->get_param( 'name' ) );
		$bytes = (int) $req->get_param( 'bytes' );
		[ $kind, $ext ] = self::kind_for( $name );
		if ( ! $kind ) { return Rest::err( 'bad_kind', 'Bring music, video or a PDF', 400 ); }
		if ( $bytes < 1 || $bytes > self::FILE_MAX ) { return Rest::err( 'too_big', 'That file is larger than 2 GB', 400 ); }
		// Refuse BEFORE a byte is written, with the real numbers.
		$freeBytes = self::capacity( $uid ) - self::used( $uid ) - self::pending( $uid );
		if ( $bytes > $freeBytes ) {
			return Rest::err( 'quota', 'That needs ' . size_format( $bytes ) . ' but only ' . size_format( max( 0, $freeBytes ) ) . ' of your shelf is free', 409 );
		}
		$stored = wp_generate_password( 24, false, false ) . '.' . $ext;
		$id = Data::insert( 'aq_media', [
			'user_id' => $uid, 'name' => $name, 'title' => pathinfo( $name, PATHINFO_FILENAME ),
			'kind' => $kind, 'store_key' => $stored, 'bytes' => $bytes, 'received' => 0,
			'state' => 'uploading', 'created' => Data::now(), 'updated' => Data::now(),
		] );
		if ( ! $id ) { return Rest::err( 'write_failed', 'Could not start the upload', 500 ); }
		return [ 'id' => (int) $id, 'chunk_max' => self::CHUNK_MAX ];
	}

	/** Bytes already claimed by uploads still in flight, so two concurrent uploads can't both fit. */
	private static function pending( $uid ) {
		return (int) Data::col(
			'SELECT COALESCE(SUM(bytes),0) FROM ' . Data::t( 'aq_media' ) . ' WHERE user_id = %d AND state = %s',
			[ (int) $uid, 'uploading' ]
		);
	}

	private static function own( $id, $uid ) {
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_media' ) . ' WHERE id = %d', [ (int) $id ] );
		if ( ! $row || (int) $row['user_id'] !== (int) $uid ) { return null; } // never trust an id
		return $row;
	}

	/** POST media/(id)/part?offset=N — raw body appended at `offset`, which must equal what we hold.
	 *  Sequential by design: the committed byte count IS the resume cursor, so there is no second
	 *  bookkeeping to fall out of step, and no path that rewrites a byte already written. */
	public static function part( $req ) {
		$uid = get_current_user_id();
		if ( ! $uid ) { return Rest::err( 'auth', 'Sign in first', 401 ); }
		$row = self::own( $req['id'], $uid );
		if ( ! $row ) { return Rest::err( 'not_found', 'No such upload', 404 ); }
		if ( 'uploading' !== $row['state'] ) { return Rest::err( 'closed', 'That upload is already finished', 409 ); }

		$offset = (int) $req->get_param( 'offset' );
		$have   = (int) $row['received'];
		if ( $offset !== $have ) { return Rest::err( 'offset', 'Resume from byte ' . $have, 409 ); }

		$body = $req->get_body();
		$len  = strlen( (string) $body );
		if ( $len < 1 || $len > self::CHUNK_MAX ) { return Rest::err( 'bad_chunk', 'Bad chunk size', 400 ); }
		if ( $have + $len > (int) $row['bytes'] ) { return Rest::err( 'overflow', 'That is more than you declared', 400 ); }

		[ $dir ] = self::dir();
		$path = $dir . '/' . $row['store_key'];
		$fh = fopen( $path, $have === 0 ? 'wb' : 'ab' );
		if ( ! $fh ) { return Rest::err( 'write_failed', 'Could not write to the shelf', 500 ); }
		$ok = fwrite( $fh, $body );
		fclose( $fh );
		if ( false === $ok ) { return Rest::err( 'write_failed', 'Could not write to the shelf', 500 ); }

		$now = $have + $len;
		Data::update( 'aq_media', [ 'received' => $now, 'updated' => Data::now() ], [ 'id' => (int) $row['id'] ] );
		return [ 'received' => $now, 'bytes' => (int) $row['bytes'] ];
	}

	/** POST media/(id)/commit — verify the size, publish the row. */
	public static function commit( $req ) {
		$uid = get_current_user_id();
		if ( ! $uid ) { return Rest::err( 'auth', 'Sign in first', 401 ); }
		$row = self::own( $req['id'], $uid );
		if ( ! $row ) { return Rest::err( 'not_found', 'No such upload', 404 ); }
		[ $dir ] = self::dir();
		$path = $dir . '/' . $row['store_key'];
		$real = file_exists( $path ) ? (int) filesize( $path ) : 0;
		if ( $real !== (int) $row['bytes'] ) {
			return Rest::err( 'incomplete', 'Only ' . $real . ' of ' . (int) $row['bytes'] . ' bytes arrived — resume from byte ' . $real, 409 );
		}
		$fields = [ 'state' => 'ready', 'updated' => Data::now(), 'sha256' => hash_file( 'sha256', $path ) ];
		// Hand the bytes to the CDN, then drop the local copy so this origin never becomes the library.
		// If the CDN is not configured (or the PUT fails) the file simply stays here and is served from
		// uploads/ — the member's upload is never lost to an infrastructure problem.
		$mime = 'music' === $row['kind'] ? 'audio/mpeg' : ( 'video' === $row['kind'] ? 'video/mp4' : 'application/pdf' );
		if ( self::to_cdn( $row['store_key'], $path, $mime ) ) { @unlink( $path ); $fields['on_cdn'] = 1; }
		foreach ( [ 'title', 'artist', 'album' ] as $f ) {
			$v = $req->get_param( $f );
			if ( null !== $v ) { $fields[ $f ] = sanitize_text_field( (string) $v ); }
		}
		$d = (float) $req->get_param( 'duration' );
		if ( $d > 0 ) { $fields['duration'] = (int) round( $d ); }
		Data::update( 'aq_media', $fields, [ 'id' => (int) $row['id'] ] );
		return self::shape( Data::one( 'SELECT * FROM ' . Data::t( 'aq_media' ) . ' WHERE id = %d', [ (int) $row['id'] ] ) );
	}

	// ── read / delete ────────────────────────────────────────────────────────

	private static function shape( $r ) {
		if ( ! $r ) { return null; }
		return [
			'id' => (int) $r['id'], 'kind' => $r['kind'], 'title' => $r['title'], 'name' => $r['name'],
			'artist' => $r['artist'], 'album' => $r['album'], 'bytes' => (int) $r['bytes'],
			'duration' => (int) $r['duration'], 'created' => (int) $r['created'],
			'url' => self::url( $r['store_key'] ), 'sha256' => $r['sha256'],
		];
	}

	/** GET media — the signed-in member's own shelf. */
	public static function mine( $req ) {
		$uid = get_current_user_id();
		if ( ! $uid ) { return Rest::err( 'auth', 'Sign in first', 401 ); }
		$rows = Data::all(
			'SELECT * FROM ' . Data::t( 'aq_media' ) . ' WHERE user_id = %d AND state = %s ORDER BY id DESC LIMIT 500',
			[ $uid, 'ready' ]
		);
		return [ 'items' => array_values( array_filter( array_map( [ __CLASS__, 'shape' ], (array) $rows ) ) ),
		         'quota' => self::quota( $req ) ];
	}

	/** GET media/of/(slug) — someone else's PUBLIC shelf, shown on their Library page. Cloud is public
	 *  by definition here, so this needs no permission; it is simply what they chose to publish. */
	public static function of_member( $req ) {
		$user = get_user_by( 'slug', (string) $req['slug'] );
		if ( ! $user ) { return [ 'items' => [] ]; }
		$rows = Data::all(
			'SELECT * FROM ' . Data::t( 'aq_media' ) . ' WHERE user_id = %d AND state = %s ORDER BY id DESC LIMIT 200',
			[ (int) $user->ID, 'ready' ]
		);
		return [ 'items' => array_values( array_filter( array_map( [ __CLASS__, 'shape' ], (array) $rows ) ) ) ];
	}

	/** DELETE media/(id) — remove the file and the row. Capacity returns; coins do not. */
	public static function remove( $req ) {
		$uid = get_current_user_id();
		if ( ! $uid ) { return Rest::err( 'auth', 'Sign in first', 401 ); }
		$row = self::own( $req['id'], $uid );
		if ( ! $row ) { return Rest::err( 'not_found', 'No such item', 404 ); }
		[ $dir ] = self::dir();
		$path = $dir . '/' . $row['store_key'];
		if ( file_exists( $path ) ) { @unlink( $path ); }
		if ( (int) $row['on_cdn'] && self::r2_ready() ) { self::r2( 'DELETE', $row['store_key'] ); }
		global $wpdb;
		$wpdb->delete( Data::t( 'aq_media' ), [ 'id' => (int) $row['id'] ] );
		return [ 'ok' => true, 'quota' => self::quota( $req ) ];
	}

	/** Cron: reap uploads abandoned mid-flight (a closed laptop, a lost connection) so their bytes
	 *  stop counting against the member's shelf, and drop files whose row vanished. */
	// ── migrating existing content to the CDN ────────────────────────────────
	//
	// Everything a member has ever produced lives in wp-content/uploads on the ORIGIN: notebook
	// teasers and thumbs, animation renders and posters, research artifacts, competition submissions.
	// Serving those from WordPress.com burns origin bandwidth on every play, which is exactly the cost
	// R2 makes free. This walks the upload directories, copies each file to the CDN under the SAME
	// relative path, verifies it is fetchable, and only then rewrites the stored URL.
	//
	// SAFE BY CONSTRUCTION: the origin file is NEVER deleted here. A row is repointed only after the
	// CDN copy answers 200 with the right byte count, so a failed migration leaves the site exactly as
	// it was. Re-running is idempotent — already-migrated rows no longer match the origin prefix.

	/** Columns that store an uploads URL, discovered by audit. table => [ columns ]. */
	const URL_COLUMNS = [
		'aq_animations'        => [ 'video_url', 'poster' ],
		'aq_notebooks'         => [ 'teaser', 'teaser_light', 'thumb' ],
		'aq_research_artifacts'=> [ 'url' ],
		'aq_submissions'       => [ 'data_url', 'code_url', 'paper_url', 'notebook', 'pdf_url', 'thumb_url' ],
		'aq_demo_subs'         => [ 'code_url' ],
		'aq_comp_subs'         => [ 'code_url' ],
		'aq_paper_reviews'     => [ 'report' ],
		'aq_tickets'           => [ 'screenshot' ],
	];

	/** Upload directories worth moving. Deliberately EXCLUDES aq-chat (E2EE blobs whose privacy comes
	 *  from staying opaque on our own origin) and aq-media (already on the CDN). */
	// Member content first, then the two directories that actually dominate the disk: the ML weights
	// every browser downloads (aq-models, ~677 MB) and the nightly public dataset snapshots
	// (datasets, ~225 MB). Those two ARE the origin's bandwidth bill, and R2 egress is free.
	/**
	 * Current CDN usage against the free tier. Cached for an hour — the check runs on a cron and the
	 * numbers move slowly, so there is no reason to re-ask Cloudflare on every call.
	 *
	 * `bytes`/`objects` come from Cloudflare and are AUTHORITATIVE. `class_a`/`class_b` are local
	 * counters and are a LOWER BOUND: public reads through r2.dev never reach PHP, so they cannot be
	 * counted here. `ops_complete` is false to say exactly that — reading true operation counts needs
	 * a token with Account Analytics:Read, which AQ_CF_API_TOKEN does not currently carry.
	 */
	public static function usage( $fresh = false ) {
		$cached = get_transient( 'aq_cdn_usage' );
		if ( ! $fresh && is_array( $cached ) ) { return $cached; }
		if ( ! self::r2_ready() ) { return [ 'ok' => false, 'why' => 'cdn_not_configured' ]; }

		$token   = Secrets::get( 'AQ_CF_API_TOKEN' );
		$account = Secrets::get( 'AQ_R2_ACCOUNT' );
		$bucket  = Secrets::get( 'AQ_R2_BUCKET' );
		$bytes = null; $objects = null;
		if ( $token && $account && $bucket ) {
			$res = wp_remote_get( "https://api.cloudflare.com/client/v4/accounts/{$account}/r2/buckets/{$bucket}/usage",
				[ 'timeout' => 45, 'headers' => [ 'Authorization' => 'Bearer ' . $token ] ] );
			if ( ! is_wp_error( $res ) ) {
				$j = json_decode( (string) wp_remote_retrieve_body( $res ), true );
				if ( ! empty( $j['success'] ) && isset( $j['result'] ) ) {
					// Metadata counts toward billed storage too, so include it.
					$bytes   = (int) ( $j['result']['payloadSize'] ?? 0 ) + (int) ( $j['result']['metadataSize'] ?? 0 );
					$objects = (int) ( $j['result']['objectCount'] ?? 0 );
				}
			}
		}
		$mo = gmdate( 'Ym' );
		$a  = class_exists( '\AQ\Economy' ) ? Economy::counter( 'r2a:' . $mo ) : 0;
		$b  = class_exists( '\AQ\Economy' ) ? Economy::counter( 'r2b:' . $mo ) : 0;

		$pct = static function ( $used, $limit ) { return ( null === $used || $limit <= 0 ) ? null : round( $used / $limit, 4 ); };
		$out = [
			'ok'            => null !== $bytes,
			'bytes'         => $bytes,
			'objects'       => $objects,
			'class_a'       => $a,
			'class_b'       => $b,
			'ops_complete'  => false,   // public r2.dev reads are not visible to us — see the note above
			'pct'           => [
				'bytes'   => $pct( $bytes, self::FREE_TIER['bytes'] ),
				'class_a' => $pct( $a, self::FREE_TIER['class_a'] ),
				'class_b' => $pct( $b, self::FREE_TIER['class_b'] ),
			],
			'checked'       => time(),
		];
		set_transient( 'aq_cdn_usage', $out, HOUR_IN_SECONDS );
		return $out;
	}

	/**
	 * Warn the operator BEFORE the free tier is reached (cron: aq_media_quota, daily).
	 *
	 * Emails at >= QUOTA_WARN (90%) of any measurable ceiling, at most once per metric per calendar
	 * month — a quota that sits at 91% for three weeks must not send 21 identical emails, and the
	 * month key means the alert can legitimately fire again after the allowance resets.
	 *
	 * Storage is the metric that can actually be trusted here (see usage()); an operation count that
	 * crosses 90% on LOCAL counters alone is already past 90% in reality, so it is worth saying.
	 */
	public static function quota_check() {
		$u = self::usage( true );
		if ( empty( $u['ok'] ) ) { return; }
		$mo    = gmdate( 'Ym' );
		$sent  = get_option( 'aq_cdn_quota_alerted', [] );
		if ( ! is_array( $sent ) ) { $sent = []; }
		$labels = [ 'bytes' => 'Storage', 'class_a' => 'Class A operations (writes)', 'class_b' => 'Class B operations (reads)' ];

		foreach ( $u['pct'] as $metric => $frac ) {
			if ( null === $frac || $frac < self::QUOTA_WARN ) { continue; }
			if ( ( $sent[ $metric ] ?? '' ) === $mo ) { continue; }   // already warned this month
			$used  = 'bytes' === $metric ? size_format( (int) $u['bytes'] ) : number_format_i18n( (int) $u[ $metric ] );
			$limit = 'bytes' === $metric ? size_format( self::FREE_TIER[ $metric ] ) : number_format_i18n( self::FREE_TIER[ $metric ] );
			$body  = sprintf(
				"%s on the media CDN has reached %s%% of the free tier.\n\nUsed: %s of %s\nObjects in bucket: %s\n\n%s",
				$labels[ $metric ], number_format_i18n( $frac * 100, 1 ), $used, $limit,
				number_format_i18n( (int) $u['objects'] ),
				'bytes' === $metric
					? "Storage is billed as a monthly average, so acting now avoids a charge. Options: run AQ\\Media::reclaim_origin() housekeeping, prune superseded dataset snapshots, or accept the overage (R2 charges per GB beyond the tier; egress stays free)."
					: "NOTE: this counts only operations ArtaQuest itself issues — public reads through the r2.dev domain are not visible to us, so the real figure is HIGHER. Putting the bucket behind a Cloudflare custom domain would let the edge cache absorb repeat reads, which do not count as R2 operations at all."
			);
			Mailer::send( 'cdn_quota', Mailer::operator(), [
				'metric'  => $labels[ $metric ],
				'percent' => number_format_i18n( $frac * 100, 1 ),
				'body'    => $body,
			] );
			foreach ( get_users( [ 'role' => 'administrator', 'fields' => 'ID' ] ) as $uid ) {
				Notify::push( (int) $uid, 'system', $labels[ $metric ] . ' at ' . number_format_i18n( $frac * 100, 1 ) . '% of the CDN free tier',
					$body, '/wp-admin/admin.php?page=aq-security', 'cdnq:' . $metric . ':' . $mo );
			}
			$sent[ $metric ] = $mo;
		}
		update_option( 'aq_cdn_quota_alerted', $sent, false );
	}

	/**
	 * List every object key in the bucket (ListObjectsV2, paginated). Class A operation per page.
	 *
	 * recache() used to walk the aq_cdn_migrated manifest instead — which was wrong in the way that
	 * matters: on prod that option was EMPTY, so the backfill iterated nothing and silently reported
	 * success. The bucket is the only authority on what the bucket contains; our bookkeeping is not.
	 */
	private static function list_keys( $limit = 5000 ) {
		$keys = []; $token = '';
		do {
			$q = 'list-type=2&max-keys=1000' . ( $token ? '&continuation-token=' . rawurlencode( $token ) : '' );
			[ $code, $xml ] = self::r2_query( 'GET', '', $q );
			if ( 200 !== $code ) { break; }
			if ( preg_match_all( '#<Key>([^<]+)</Key>#', $xml, $m ) ) {
				foreach ( $m[1] as $k ) { $keys[] = html_entity_decode( $k, ENT_QUOTES ); }
			}
			$token = preg_match( '#<NextContinuationToken>([^<]+)</NextContinuationToken>#', $xml, $t ) ? $t[1] : '';
		} while ( $token && count( $keys ) < $limit );
		return $keys;
	}

	/**
	 * Backfill CACHE_CONTROL onto objects stored BEFORE that header existed.
	 *
	 * A CopyObject onto itself with `x-amz-metadata-directive: REPLACE` rewrites metadata SERVER-SIDE:
	 * one Class A operation per object, not one byte transferred. That matters because objects whose
	 * origin copies are long gone cannot be re-uploaded without downloading them back first.
	 *
	 * Content-Type must be restated — REPLACE drops any metadata absent from the copy request.
	 *
	 * @param bool $dry true = report what WOULD be rewritten.
	 * @param int  $max stop after this many objects (bounded batches; re-run to continue).
	 */
	public static function recache( $dry = true, $max = 1000 ) {
		if ( ! self::r2_ready() ) { echo "CDN not configured.\n"; return; }
		$keys = self::list_keys();
		if ( ! $keys ) { echo "Bucket listing empty or unavailable.\n"; return; }
		echo count( $keys ) . " objects in bucket\n";

		$done = 0; $failed = 0;
		$deadline = microtime( true ) + 200;
		foreach ( $keys as $key ) {
			if ( $done >= $max || microtime( true ) > $deadline ) { echo "-- batch limit; re-run to continue --\n"; break; }
			if ( $dry ) { echo "would recache {$key}\n"; $done++; continue; }
			$mime = wp_check_filetype( $key )['type'] ?: 'application/octet-stream';
			[ $code ] = self::r2( 'PUT', $key, '', $mime, [
				'x-amz-copy-source'        => '/' . Secrets::get( 'AQ_R2_BUCKET' ) . '/' . str_replace( '%2F', '/', rawurlencode( $key ) ),
				'x-amz-metadata-directive' => 'REPLACE',
				'cache-control'            => self::CACHE_CONTROL,
				'content-type'             => $mime,
			] );
			if ( $code >= 200 && $code < 300 ) { $done++; } else { $failed++; }
		}
		echo ( $dry ? 'DRY RUN: ' : 'RECACHED: ' ) . "{$done} objects, {$failed} failed\n";
	}

	/**
	 * Put the bucket's CORS policy in place (idempotent — safe to re-run).
	 *
	 * Serving assets from the CDN makes every SPA fetch() of them CROSS-ORIGIN, and a public
	 * pub-*.r2.dev bucket sends no Access-Control-Allow-Origin at all by default. curl still gets a
	 * clean 200/206 — only the browser blocks it — so this fails ONLY on a real device and passes
	 * every server-side check. It would have broken texify2 (equation OCR) and florence2 (captioning),
	 * which fetch their weights through Media::cdn_base().
	 *
	 * `range` is load-bearing: those models stream with ranged reads, so it must be an allowed request
	 * header AND Content-Range/Content-Length/ETag/Accept-Ranges must be exposed, or ranged fetches
	 * still fail after ACAO appears. Origins are listed explicitly — never a "*" wildcard.
	 *
	 * This lives here, rather than as a one-off dashboard/API call, because the policy is stored on
	 * Cloudflare and NOT in git: recreating the bucket silently drops it and ArtaRead breaks on device
	 * with nothing in any log. Re-run this after any bucket change.
	 */
	public static function ensure_cors() {
		$token   = Secrets::get( 'AQ_CF_API_TOKEN' );
		$account = Secrets::get( 'AQ_R2_ACCOUNT' );
		$bucket  = Secrets::get( 'AQ_R2_BUCKET' );
		if ( ! $token || ! $account || ! $bucket ) { echo "CORS: missing AQ_CF_API_TOKEN/account/bucket\n"; return false; }

		$body = wp_json_encode( [ 'rules' => [ [
			'allowed' => [
				// BOTH domains, apex + www. artaquest.org stays mapped and 301s to .com after the
				// 2026-07-27 move, but a 301 does NOT rescue a CORS preflight: the browser checks
				// the ORIGIN header it sends, and a device still holding an .org page (a cached
				// ArtaRead shell, an open tab) sends Origin: https://artaquest.org. Drop it and
				// those readers fail silently on-device with nothing in any log.
				'origins' => [ home_url(), 'https://artaquest.com', 'https://www.artaquest.com', 'https://artaquest.org', 'https://www.artaquest.org' ],
				'methods' => [ 'GET', 'HEAD' ],
				'headers' => [ 'range', 'content-type', 'if-none-match', 'if-range' ],
			],
			'exposeHeaders' => [ 'Content-Length', 'Content-Range', 'ETag', 'Accept-Ranges', 'Content-Type' ],
			'maxAgeSeconds' => 86400,
		] ] ] );

		$res = wp_remote_request( "https://api.cloudflare.com/client/v4/accounts/{$account}/r2/buckets/{$bucket}/cors", [
			'method'  => 'PUT',
			'timeout' => 60,
			'headers' => [ 'Authorization' => 'Bearer ' . $token, 'Content-Type' => 'application/json' ],
			'body'    => $body,
		] );
		if ( is_wp_error( $res ) ) { echo 'CORS: ' . $res->get_error_message() . "\n"; return false; }
		$ok = ! empty( json_decode( (string) wp_remote_retrieve_body( $res ), true )['success'] );
		echo 'CORS: ' . ( $ok ? 'applied' : 'FAILED — ' . substr( wp_remote_retrieve_body( $res ), 0, 300 ) ) . "\n";
		return $ok;
	}

	/**
	 * Directories whose ORIGIN copies may be deleted once the CDN provably has them.
	 *
	 * Deliberately NOT MIGRATE_DIRS. Mirroring a file to the CDN makes it fetchable over HTTP from a
	 * second place; it does NOT satisfy PHP that reads the same file off local disk, and
	 * uploads_fallback() cannot help a file_get_contents(). Every directory below was checked for
	 * server-side disk reads before being listed. Excluded, with the reader that forbids each:
	 *   aq-data         Extra::climate_daily/citations_quarterly/citations_yearly stream the CSV from
	 *                   disk (is_readable → 404 "not_provisioned" the moment it is gone)
	 *   datasets        Extra::datasets() ENUMERATES the directory to list snapshots (it links to the
	 *                   CDN but counts local files), and dataset_build() uses file_exists for its
	 *                   per-day idempotency
	 *   notebooks       Notebook::typology_doc() maps a survey's asset URL back to a local path and
	 *                   reads out/instrument.json from disk
	 *   animations      Motion.php builds $up['basedir'].'/animations' paths
	 *   research-uploads Science.php reads paper-<id>.pdf and scans the directory
	 *   competitions    Competitions::dir() reads a competition's data files
	 * That leaves aq-models: ~677 MB of ML weights fetched ONLY by the browser through
	 * modelMirrorBase(), with no PHP reader at all — and the largest single item on the origin.
	 * Re-audit with a grep for basedir before adding anything here.
	 */
	// Nothing left to reclaim from the origin: aq-models' local copies were deleted once the CDN was
	// proven serving them, and the directory has since moved to HuggingFace entirely. Kept (empty) so
	// the audited-before-listing contract above stays in force for whatever gets added next.
	const RECLAIM_DIRS = [];

	/**
	 * Cloudflare R2 free-tier ceilings (2026-07): 10 GB-month of storage, 1M Class A operations
	 * (writes/lists) and 10M Class B operations (reads) per month. EGRESS is free and unmetered —
	 * the whole reason the heavy files live here rather than on the origin.
	 */
	const FREE_TIER = [ 'bytes' => 10737418240, 'class_a' => 1000000, 'class_b' => 10000000 ];

	/** Warn the operator once a metric crosses this fraction of its ceiling. */
	const QUOTA_WARN = 0.90;

	/**
	 * Sent on EVERY upload so a fetched object is cached for a year and never re-requested.
	 *
	 * This is the main defence of the Class B (read) allowance. Measured 2026-07-26: R2 returned no
	 * caching directive at all, so every view re-downloaded the object and every re-download was a
	 * billable read — a single 240 MB model could burn thousands of reads a week on its own.
	 *
	 * `immutable` is safe because nothing here is ever rewritten under the same key: teasers are
	 * content-addressed (teaser-<sha8>.webm), dataset snapshots carry their date, model weights are
	 * versioned by path. A changed file gets a NEW key by construction, so a stale cache cannot
	 * serve wrong bytes.
	 */
	const CACHE_CONTROL = 'public, max-age=31536000, immutable';


	const MIGRATED_OPT = 'aq_cdn_migrated';
	// R2 now carries IMAGE / MUSIC / VIDEO only (operator 2026-07-26). `aq-models` and `datasets`
	// were removed from this list when they moved to HuggingFace — HF serves them publicly with CORS
	// and ranges (verified), so mirroring them here would be paying twice to store the same bytes.
	const MIGRATE_DIRS = [ 'notebooks', 'animations', 'research-uploads', 'competitions', 'aq-data', '2026' ];

	/**
	 * Copy origin-hosted content to the CDN and repoint the database at it.
	 * @param bool $dry  true = report what WOULD move, touch nothing.
	 * @param int  $max  stop after this many files (bounded batches; re-run to continue).
	 */
	public static function migrate_to_cdn( $dry = true, $max = 250 ) {
		if ( ! self::r2_ready() ) { echo "CDN not configured — nothing to do.\n"; return; }
		global $wpdb;
		$up      = wp_upload_dir();
		$baseDir = untrailingslashit( $up['basedir'] );
		$baseUrl = untrailingslashit( $up['baseurl'] );
		$cdn     = untrailingslashit( self::cdn_base() );
		$moved = 0; $bytes = 0; $failed = 0; $repointed = 0; $already = 0;
		$deadline = microtime( true ) + 200;   // wall clock, so a run always ends even when skipping thousands

		// Manifest of files already proven on the CDN: rel => size. Without it every run re-asks the
		// CDN about every previously-migrated file, and those HEADs consume the whole time budget —
		// measured: 462 known files left room for exactly ONE new upload per run. The manifest turns
		// that scan into a local array lookup. Size is part of the key check, so a file edited after
		// migration is re-uploaded rather than silently skipped. Never autoloaded.
		$manifest = get_option( self::MIGRATED_OPT, [] );
		if ( ! is_array( $manifest ) ) { $manifest = []; }
		$mdirty = false;

		foreach ( self::MIGRATE_DIRS as $sub ) {
			$root = $baseDir . '/' . $sub;
			if ( ! is_dir( $root ) ) { continue; }
			$it = new \RecursiveIteratorIterator( new \RecursiveDirectoryIterator( $root, \FilesystemIterator::SKIP_DOTS ) );
			foreach ( $it as $f ) {
				if ( $moved >= $max || microtime( true ) > $deadline ) { break 2; }
				if ( ! $f->isFile() ) { continue; }
				// Skip filesystem junk: macOS AppleDouble sidecars (._x), .DS_Store, and dotfiles —
				// they are not member content and must never appear on a public CDN.
				$bn = $f->getFilename();
				if ( '.' === $bn[0] ) { continue; }
				$abs = $f->getPathname();
				$rel = ltrim( str_replace( $baseDir, '', $abs ), '/' );   // e.g. notebooks/12/out/teaser.webm
				$size = (int) $f->getSize();
				if ( $size < 1 ) { continue; }
				if ( $dry ) { echo "would move  {$rel}  (" . size_format( $size ) . ")\n"; $moved++; $bytes += $size; continue; }

				// ALREADY THERE? Ask the CDN, not the database. Most files (a notebook's data.csv, a
				// scene.obj) have NO row pointing at them, so "did we repoint a reference" cannot mean
				// "is it migrated" — without this check the walk re-uploads those same files on every
				// run, forever. Verified: batches 9-14 each re-sent an identical 60 files / 38 MB.
				// Cheap path first: the local manifest answers without touching the network.
				if ( isset( $manifest[ $rel ] ) && (int) $manifest[ $rel ] === $size ) { $already++; continue; }
				$head = self::cdn_head( $cdn . '/' . $rel, 15 );
				if ( ! is_wp_error( $head ) && 200 === (int) wp_remote_retrieve_response_code( $head )
					&& (int) wp_remote_retrieve_header( $head, 'content-length' ) === $size ) {
					$manifest[ $rel ] = $size; $mdirty = true;
					$already++; continue;
				}

				$mime = wp_check_filetype( $abs )['type'] ?: 'application/octet-stream';
				if ( ! self::to_cdn( $rel, $abs, $mime ) ) { echo "FAILED put {$rel}\n"; $failed++; continue; }
				// Verify the CDN really serves it, at the right length, BEFORE repointing anything.
				$head = self::cdn_head( $cdn . '/' . $rel, 30 );
				$code = is_wp_error( $head ) ? 0 : (int) wp_remote_retrieve_response_code( $head );
				$len  = is_wp_error( $head ) ? -1 : (int) wp_remote_retrieve_header( $head, 'content-length' );
				if ( 200 !== $code || ( $len > 0 && $len !== $size ) ) {
					echo "FAILED verify {$rel} (http {$code}, len {$len} vs {$size})\n"; $failed++; continue;
				}
				$manifest[ $rel ] = $size; $mdirty = true;
				$moved++; $bytes += $size;

				// Repoint every stored reference to this exact file.
				$from = $baseUrl . '/' . $rel;
				$to   = $cdn . '/' . $rel;
				foreach ( self::URL_COLUMNS as $tbl => $cols ) {
					$full = $wpdb->prefix . $tbl;
					if ( ! $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $full ) ) ) { continue; }
					foreach ( $cols as $col ) {
						$n = $wpdb->query( $wpdb->prepare( "UPDATE `{$full}` SET `{$col}` = REPLACE(`{$col}`, %s, %s) WHERE `{$col}` LIKE %s", $from, $to, '%' . $wpdb->esc_like( $from ) . '%' ) );
						if ( $n > 0 ) { $repointed += $n; }
					}
				}
			}
		}
		if ( $mdirty ) { update_option( self::MIGRATED_OPT, $manifest, false ); }   // autoload=false: it gets big
		echo ( $dry ? "DRY RUN: " : "MIGRATED: " ) . "{$moved} files, " . size_format( $bytes )
		   . ( $dry ? "" : ", {$repointed} refs repointed, {$already} already on CDN, {$failed} failed" ) . "\n";
		if ( ! $dry ) { echo "Origin copies were kept — delete them only after the site is verified.\n"; }
	}

	/**
	 * SAFETY NET for reclaim_origin(): a request for an uploads file that is no longer on disk is
	 * redirected to the CDN copy instead of 404ing.
	 *
	 * This is what makes deleting origin copies safe at all. Repointing the database only fixes
	 * references we can SEE — the URL columns in URL_COLUMNS. A large share of migrated files are
	 * referenced from places no UPDATE can reach: a fetch('data.csv') inside a notebook's own
	 * executed HTML, an <img> in a rendered figure, an .obj loaded by a viewer script, a DOI landing
	 * page already archived at Zenodo, someone's bookmark. Deleting the origin copy of those without
	 * this hook turns each into a hard 404.
	 *
	 * Hooked on template_redirect, so it only ever runs when the web server already failed to serve
	 * the file from disk — a present file is served by nginx and never reaches PHP. Zero cost in the
	 * normal case, and it cannot shadow a real file.
	 */
	public static function uploads_fallback() {
		if ( ! self::r2_ready() ) { return; }
		$uri = (string) ( $_SERVER['REQUEST_URI'] ?? '' );
		$path = parse_url( $uri, PHP_URL_PATH );
		if ( ! $path ) { return; }
		$up   = wp_upload_dir();
		$base = parse_url( untrailingslashit( $up['baseurl'] ), PHP_URL_PATH );   // /wp-content/uploads
		if ( ! $base || 0 !== strpos( $path, $base . '/' ) ) { return; }
		$rel = ltrim( substr( $path, strlen( $base ) ), '/' );
		// Traversal guard: the tail must stay inside uploads, and must be one of the dirs we migrate.
		if ( '' === $rel || false !== strpos( $rel, '..' ) ) { return; }
		$top = strtok( $rel, '/' );
		if ( ! in_array( $top, self::MIGRATE_DIRS, true ) ) { return; }
		if ( file_exists( untrailingslashit( $up['basedir'] ) . '/' . $rel ) ) { return; }   // still on disk
		// 302, NOT 301. This was a 301 on the reasoning that the CDN copy is the permanent home, and
		// that is exactly what makes it dangerous now: the CDN's pub-*.r2.dev hostname is filtered
		// on a real share of networks, and a browser caches a 301 indefinitely. One miss would burn
		// an un-clearable redirect into the visitor's browser pointing at a host it cannot reach —
		// strictly worse than the 404 it replaced, because only purging browser state undoes it.
		// A temporary redirect keeps the safety net and stays revocable.
		wp_redirect( self::cdn_base() . '/' . $rel, 302 );
		exit;
	}

	/**
	 * Delete origin copies of files PROVEN to be on the CDN, reclaiming origin disk.
	 *
	 * Proof is per file and is asked of the CDN, never of our own bookkeeping: HTTP 200 AND a
	 * content-length equal to the local size. A file that is absent, truncated, or answered by an
	 * error page is kept. Requires uploads_fallback() to be live so that any reference we could not
	 * repoint still resolves.
	 *
	 * @param bool $dry true = report what WOULD be deleted, touch nothing.
	 * @param int  $max stop after this many deletions (bounded batches; re-run to continue).
	 */
	public static function reclaim_origin( $dry = true, $max = 500 ) {
		if ( ! self::r2_ready() ) { echo "CDN not configured — refusing to delete anything.\n"; return; }
		$up      = wp_upload_dir();
		$baseDir = untrailingslashit( $up['basedir'] );
		$cdn     = untrailingslashit( self::cdn_base() );
		$gone = 0; $bytes = 0; $kept = 0;
		$deadline = microtime( true ) + 200;

		foreach ( self::RECLAIM_DIRS as $sub ) {
			$root = $baseDir . '/' . $sub;
			if ( ! is_dir( $root ) ) { continue; }
			$it = new \RecursiveIteratorIterator( new \RecursiveDirectoryIterator( $root, \FilesystemIterator::SKIP_DOTS ) );
			foreach ( $it as $f ) {
				if ( $gone >= $max || microtime( true ) > $deadline ) { break 2; }
				if ( ! $f->isFile() ) { continue; }
				$bn = $f->getFilename();
				if ( '.' === $bn[0] ) { continue; }
				$abs  = $f->getPathname();
				$rel  = ltrim( str_replace( $baseDir, '', $abs ), '/' );
				$size = (int) $f->getSize();
				if ( $size < 1 ) { continue; }

				$head = self::cdn_head( $cdn . '/' . $rel, 20 );
				$code = is_wp_error( $head ) ? 0 : (int) wp_remote_retrieve_response_code( $head );
				$len  = is_wp_error( $head ) ? -1 : (int) wp_remote_retrieve_header( $head, 'content-length' );
				if ( 200 !== $code || $len !== $size ) { $kept++; continue; }   // not proven — keep it

				if ( $dry ) { echo "would delete {$rel} (" . size_format( $size ) . ")\n"; $gone++; $bytes += $size; continue; }
				if ( @unlink( $abs ) ) { $gone++; $bytes += $size; } else { $kept++; }
			}
		}
		echo ( $dry ? "DRY RUN: " : "RECLAIMED: " ) . "{$gone} files, " . size_format( $bytes )
		   . ", {$kept} kept (not proven on CDN)\n";
	}

	/** Invoked by the aq_media_sweep cron (registered in aquest.php, which already applies
	 *  Cron::guard — so this does the work directly and never double-guards). */
	public static function sweep_now() {
		global $wpdb;
		$cut  = Data::now() - 86400;
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_media' ) . ' WHERE state = %s AND updated < %d LIMIT 200', [ 'uploading', $cut ] );
		[ $dir ] = self::dir();
		foreach ( (array) $rows as $r ) {
			$p = $dir . '/' . $r['store_key'];
			if ( file_exists( $p ) ) { @unlink( $p ); }
			$wpdb->delete( Data::t( 'aq_media' ), [ 'id' => (int) $r['id'] ] );
		}
	}
}
